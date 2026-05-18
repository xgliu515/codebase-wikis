# 第 5 章 工具系统：注册、工具集与分发

> 代码版本锁定：`NousResearch/hermes-agent@f36c89cd5`（2026-05-17）。本章所有 `file:line` 引用均基于此 commit。

## 5.1 本章要解决的问题

工具是 agent 与世界交互的唯一手段——读写文件、执行命令、搜索网页、生成图像。Hermes 内置了上百个工具，分散在 `tools/` 目录下几十个文件里。这就引出一系列工程问题：

- **谁来收集这些工具？** 上百个工具不可能手工维护一张大表，否则加一个工具要改好几处。
- **怎么决定一个工具「现在能不能用」？** Docker 后端要求 docker daemon 在跑，浏览器工具要求 playwright 装好，发消息工具要求 gateway 在跑——可用性是运行时动态的。
- **怎么决定「这次会话给模型暴露哪些工具」？** 一个 Telegram bot 和一个 VS Code 集成需要的工具集不同。
- **模型发来一个 tool call，怎么路由到正确的 handler？** 还要处理类型强转、插件钩子、并发安全。

Hermes 的答案是一套三层结构：

<svg viewBox="0 0 800 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Four-layer architecture of the Hermes tool system">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="130" y="22" width="540" height="50" rx="6" fill="#0ea5e9" fill-opacity="0.18" stroke="#0ea5e9" stroke-width="1.4"/>
  <text x="150" y="42" font-size="12" font-weight="700" fill="currentColor">agent/tool_executor.py</text>
  <text x="150" y="60" font-size="10.5" fill="#64748b">执行层 · 并发 / 串行执行一批 tool call</text>
  <line x1="400" y1="84" x2="400" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="130" y="102" width="540" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
  <text x="150" y="122" font-size="12" font-weight="700" fill="currentColor">model_tools.py</text>
  <text x="150" y="140" font-size="10.5" fill="#64748b">编排层 · 解析 toolset → 拿 schema → 分发 tool call</text>
  <line x1="400" y1="164" x2="400" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="130" y="182" width="540" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="150" y="202" font-size="12" font-weight="700" fill="currentColor">toolsets.py</text>
  <text x="150" y="220" font-size="10.5" fill="#64748b">工具集 · 把工具名分组，决定哪些工具暴露给 agent</text>
  <line x1="400" y1="244" x2="400" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="130" y="262" width="540" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="150" y="281" font-size="12" font-weight="700" fill="currentColor">tools/registry.py</text>
  <text x="396" y="281" font-size="10.5" fill="#64748b">注册表 · 收集所有工具元数据（schema / handler / 可用性检查）</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ 工具系统自底向上的四层结构：注册表、工具集、编排层、执行层</span>

<details>
<summary>ASCII 原版</summary>

```text
tools/registry.py     ── 注册表：收集所有工具的元数据（schema/handler/可用性检查）
        ▲
toolsets.py           ── 工具集：把工具名分组，决定"哪些工具暴露给 agent"
        ▲
model_tools.py        ── 编排层：解析 toolset → 拿 schema → 分发 tool call
        ▲
agent/tool_executor.py ── 执行层：并发/串行执行一批 tool call
```

</details>

本章自底向上拆这四层。

## 5.2 工具注册表 ToolRegistry

### 5.2.1 ToolEntry：单个工具的元数据容器

每个工具在注册表里对应一个 `ToolEntry`（`tools/registry.py:77-106`）。它用 `__slots__` 锁定字段，省内存也防拼写错：

```python
class ToolEntry:
    """Metadata for a single registered tool."""
    __slots__ = (
        "name", "toolset", "schema", "handler", "check_fn",
        "requires_env", "is_async", "description", "emoji",
        "max_result_size_chars", "dynamic_schema_overrides",
    )
```
（`tools/registry.py:77-84`）

各字段含义：

| 字段 | 含义 |
|---|---|
| `name` | 工具名，模型在 tool call 里用的名字 |
| `toolset` | 所属工具集名（如 `file`、`web`、`browser`） |
| `schema` | JSON Schema，描述参数结构，发给模型 |
| `handler` | 真正干活的可调用对象 |
| `check_fn` | 零参可调用，返回 bool，判断该工具当前是否可用 |
| `requires_env` | 该工具需要的环境变量名列表（用于 UI 提示） |
| `is_async` | handler 是否是协程 |
| `description` | 工具描述（默认取 schema 里的 `description`） |
| `emoji` | UI 显示用的 emoji |
| `max_result_size_chars` | 该工具结果的字符上限（超出会被截断/落盘） |
| `dynamic_schema_overrides` | 零参可调用，返回 schema 覆盖项，在 `get_definitions()` 时应用 |

`dynamic_schema_overrides` 值得特别说明（`tools/registry.py:99-106` 注释）。某些工具的 schema 依赖运行时配置——例如 `delegate_task` 的描述里要写明「最多并发几个子 agent」「最大派生深度」，这两个数字来自用户的 `config.yaml`。如果 schema 是静态的，配置一改它就过时了。`dynamic_schema_overrides` 是一个回调，在每次 `get_definitions()` 时被调用，把最新的配置值浅合并进 schema。

### 5.2.2 ToolRegistry：单例与 generation 计数器

`ToolRegistry`（`tools/registry.py:151`）是个进程级单例，模块底部 `registry = ToolRegistry()`（`tools/registry.py:544`）。它内部用 `RLock` 串行化所有变更，因为 MCP 工具的动态刷新会在别的线程读取元数据时改注册表（`tools/registry.py:159-161`）。

最关键的字段是 `_generation`：

```python
# Monotonically-increasing generation counter. Bumped on every
# mutation (register / deregister / register_toolset_alias / MCP
# refresh). External callers (e.g. get_tool_definitions) can memoize
# against it: a cache entry keyed on the generation is valid for as
# long as the generation hasn't changed.
self._generation: int = 0
```
（`tools/registry.py:162-167`）

每次 `register()` / `deregister()` / `register_toolset_alias()` 都会 `self._generation += 1`（如 `tools/registry.py:305`、`330`、`218`）。这是一个**缓存失效游标**：上层（`model_tools.get_tool_definitions`）把昂贵的计算结果用 `_generation` 当 key 缓存，只要 generation 没变，缓存就有效；MCP 服务器一刷新工具，generation 一跳，所有缓存自动失效。这比「每个改注册表的地方都手动调 invalidate」可靠得多。

### 5.2.3 register()：注册与防影子

`register()`（`tools/registry.py:234`）由每个工具文件在 import 时调用。它的核心防御逻辑是**防止意外覆盖**：

```python
existing = self._tools.get(name)
if existing and existing.toolset != toolset:
    both_mcp = (existing.toolset.startswith("mcp-") and toolset.startswith("mcp-"))
    if both_mcp:
        ...  # 允许 MCP 之间互相覆盖（服务器刷新是合法的）
    elif override:
        ...  # 插件显式 opt-in，允许覆盖，INFO 级日志可审计
    else:
        logger.error("Tool registration REJECTED: '%s' ... would shadow "
                     "existing tool from toolset '%s'. ...")
        return
```
（`tools/registry.py:258-289`）

规则：如果一个工具名已经存在、且来自**不同的 toolset**，那么默认**拒绝注册**。除非：(a) 双方都是 MCP 工具（服务器刷新场景合法），或 (b) 调用方显式传了 `override=True`（插件想替换内置工具的明确意图）。

这条规则保护内置工具不被插件或 MCP 服务器意外顶掉。`register()` 末尾还有一个细节：如果工具带 `check_fn` 且该 toolset 还没登记过检查函数，就把这个 `check_fn` 也登记为「toolset 级别的可用性检查」（`tools/registry.py:303-304`）。

`get_entry(name)`（`tools/registry.py:192`）是最基础的查询，加锁返回 `ToolEntry` 或 `None`。

### 5.2.4 deregister()

`deregister()`（`tools/registry.py:307`）移除一个工具。如果这是该 toolset 里最后一个工具，连带清理 toolset 级的 check 和 alias（`tools/registry.py:320-329`）。它主要服务于 MCP 动态发现——当某个 MCP 服务器发来 `notifications/tools/list_changed` 时，Hermes 对该服务器的工具做「全拆全建」（nuke-and-repave）。

## 5.3 自动发现：AST 扫描

注册表怎么知道有哪些工具文件要 import？答案是 `discover_builtin_tools()`（`tools/registry.py:57`）。它在 `model_tools.py` import 时被无条件调用一次（`model_tools.py:179`）。

```python
def discover_builtin_tools(tools_dir=None) -> List[str]:
    """Import built-in self-registering tool modules and return their module names."""
    tools_path = Path(tools_dir) if tools_dir is not None else Path(__file__).resolve().parent
    module_names = [
        f"tools.{path.stem}"
        for path in sorted(tools_path.glob("*.py"))
        if path.name not in {"__init__.py", "registry.py", "mcp_tool.py"}
        and _module_registers_tools(path)
    ]
    imported = []
    for mod_name in module_names:
        try:
            importlib.import_module(mod_name)
            imported.append(mod_name)
        except Exception as e:
            logger.warning("Could not import tool module %s: %s", mod_name, e)
    return imported
```
（`tools/registry.py:57-74`）

它不是无脑 import 所有 `tools/*.py`，而是先**用 AST 静态扫描**判断「这个文件是不是一个自注册的工具模块」。`_module_registers_tools()`（`tools/registry.py:42`）解析文件的 AST，检查**模块顶层语句**里有没有 `registry.register(...)` 调用：

```python
def _is_registry_register_call(node: ast.AST) -> bool:
    """Return True when *node* is a ``registry.register(...)`` call expression."""
    if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):
        return False
    func = node.value.func
    return (
        isinstance(func, ast.Attribute)
        and func.attr == "register"
        and isinstance(func.value, ast.Name)
        and func.value.id == "registry"
    )
```
（`tools/registry.py:29-39`）

为什么是 AST 扫描而不是直接 import？两个原因：

1. **只挑顶层调用**。`_module_registers_tools` 的 docstring（`tools/registry.py:43-46`）说明：只看模块体语句，那些「在某个函数里碰巧调了 `registry.register()`」的辅助模块不会被误判为工具模块。
2. **import 是有副作用的**——很多工具模块 import 时会拉重型依赖。先用 AST 廉价地筛掉非工具文件，能省下不必要的 import 成本和潜在崩溃。

import 链路被刻意设计成无环（`tools/registry.py:7-15` 注释）：`registry.py` 不 import 任何工具文件或 `model_tools`；工具文件 import `registry`；`model_tools` import `registry` 和所有工具模块。

<svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tool auto-discovery flow via AST scan and import">
  <defs>
    <marker id="ar5b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="18" width="280" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">discover_builtin_tools()</text>
  <line x1="400" y1="56" x2="400" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5b)"/>
  <text x="416" y="71" font-size="10" fill="#94a3b8">glob tools/*.py</text>
  <rect x="280" y="78" width="240" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="99" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">对每个 .py 文件</text>
  <line x1="400" y1="112" x2="400" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5b)"/>
  <rect x="230" y="134" width="340" height="42" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="400" y="153" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">AST 解析 · 顶层有 registry.register() 调用吗？</text>
  <text x="400" y="169" text-anchor="middle" font-size="10" fill="#64748b">只看模块体顶层语句</text>
  <line x1="290" y1="176" x2="180" y2="208" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar5b)"/>
  <text x="200" y="196" font-size="10" fill="#dc2626">否</text>
  <rect x="60" y="210" width="220" height="34" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="170" y="231" text-anchor="middle" font-size="10.5" fill="currentColor">跳过（辅助模块）</text>
  <line x1="450" y1="176" x2="500" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5b)"/>
  <text x="486" y="196" font-size="10" fill="#16a34a">是</text>
  <rect x="360" y="210" width="380" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="550" y="231" text-anchor="middle" font-size="10.5" fill="currentColor">importlib.import_module(...) → 触发顶层代码执行</text>
  <line x1="550" y1="244" x2="550" y2="262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5b)"/>
  <rect x="320" y="264" width="460" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="550" y="285" text-anchor="middle" font-size="10.5" fill="currentColor">registry.register("read_file", "file", schema, handler, ...)</text>
  <line x1="320" y1="281" x2="240" y2="281" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="240" y1="281" x2="240" y2="312" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="20" y="296" width="380" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="210" y="317" text-anchor="middle" font-size="10.5" fill="currentColor">ToolRegistry._tools["read_file"] = ToolEntry(...)</text>
  <line x1="240" y1="312" x2="395" y2="312" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5b)"/>
</svg>
<span class="figure-caption">图 R5.2 ｜ 工具自动发现流程：AST 静态扫描筛出自注册模块，再 import 触发注册</span>

<details>
<summary>ASCII 原版</summary>

```text
discover_builtin_tools()
   │  glob tools/*.py
   ▼
对每个 .py 文件：
   │
   ├─ AST 解析 → 顶层有 registry.register() 调用吗？
   │     否 → 跳过（辅助模块）
   │     是 → importlib.import_module(...)
   │              │
   │              ▼  import 触发模块顶层代码执行
   │           registry.register("read_file", "file", schema, handler, ...)
   │              │
   │              ▼
   └────────►  ToolRegistry._tools["read_file"] = ToolEntry(...)
```

</details>

## 5.4 check_fn 与 30 秒 TTL 缓存

工具的「可用性」是运行时动态的。`check_terminal_requirements` 要探 Docker daemon、Modal SDK；浏览器工具要探 playwright 二进制；`send_message` 要看 gateway 是否在跑。这些探测有 IO 成本，对一个长生命周期的 CLI / gateway 进程，每次 `get_definitions()` 都重探就是纯浪费——外部状态是按「人类时间尺度」变化的。

于是注册表给 `check_fn` 加了一个 ~30 秒的 TTL 缓存（`tools/registry.py:109-148`）：

```python
_CHECK_FN_TTL_SECONDS = 30.0
_check_fn_cache: Dict[Callable, tuple[float, bool]] = {}

def _check_fn_cached(fn: Callable) -> bool:
    """Return bool(fn()), TTL-cached across calls. Swallows exceptions as False."""
    now = time.monotonic()
    with _check_fn_cache_lock:
        cached = _check_fn_cache.get(fn)
        if cached is not None:
            ts, value = cached
            if now - ts < _CHECK_FN_TTL_SECONDS:
                return value
    try:
        value = bool(fn())
    except Exception:
        value = False
    with _check_fn_cache_lock:
        _check_fn_cache[fn] = (now, value)
    return value
```
（`tools/registry.py:121-141`）

注意两点：异常一律当 `False`（探测失败 = 工具不可用，安全侧）；缓存以 `check_fn` 函数对象本身为 key——多个工具共享同一个 `check_fn` 时只探一次。

30 秒这个数字是个权衡（`tools/registry.py:115-118` 注释）：足够短，让用户 `hermes tools enable foo` 后一两轮内就生效；足够长，避免每次构建 tool 定义都重探。需要立即生效时，`invalidate_check_fn_cache()`（`tools/registry.py:144`）直接清空整个缓存——`hermes tools` 这类改可用性的命令会调它。

`get_definitions()`（`tools/registry.py:337`）使用这个缓存：对每个请求的工具，如果有 `check_fn`，过 `_check_fn_cached` 过滤，只有返回 `True` 的工具才进结果。它内部还有一个「单次调用内的二级缓存」`check_results`，处理一次 definitions pass 里对同一 `check_fn` 的重复探测（`tools/registry.py:351-360`）。

`get_definitions()` 返回的是 OpenAI 格式：`{"type": "function", "function": {...schema..., "name": entry.name}}`（`tools/registry.py:366`、`383`），并在此处应用 `dynamic_schema_overrides`（`tools/registry.py:372-382`）。

## 5.5 工具集 toolsets.py

注册表知道「有哪些工具」，但**不决定「给 agent 暴露哪些工具」**。这件事归 `toolsets.py`。

### 5.5.1 _HERMES_CORE_TOOLS：所有平台共享的核心工具

`_HERMES_CORE_TOOLS`（`toolsets.py:31-73`）是一个工具名列表，注释直白：「Shared tool list for CLI and all messaging platform toolsets. Edit this once to update all platforms simultaneously.」它涵盖 web 搜索、terminal、文件操作、vision、技能、浏览器、TTS、planning/memory、session 搜索、clarify、code execution、delegation、cronjob、跨平台消息、Home Assistant、kanban、computer use——agent 的「标配」。

为什么抽出这个共享列表？因为 Hermes 支持十几个消息平台（Telegram / Discord / Slack / Signal / Matrix / 飞书 / 微信 ...），它们的工具集 95% 相同。把核心工具抽成一个列表，改一处全平台同步，避免十几份重复定义漂移。

### 5.5.2 TOOLSETS 字典

`TOOLSETS`（`toolsets.py:78` 起）是工具集主字典，有 30 多个条目。每个条目结构：

```python
"web": {
    "description": "Web research and content extraction tools",
    "tools": ["web_search", "web_extract"],
    "includes": []   # 可组合其他工具集
},
```
（`toolsets.py:81-86`）

工具集分几类：

- **细粒度类别集**：`web`、`search`、`vision`、`terminal`、`file`、`browser`、`skills`、`memory`、`todo` 等——每个就是一个工具类别。
- **场景集**：`debugging`（terminal + process + 组合 web、file）、`safe`（无 terminal 的安全集）。
- **平台全集**：`hermes-cli`、`hermes-telegram`、`hermes-discord` 等几十个，`tools` 字段直接就是 `_HERMES_CORE_TOOLS`（或在其上加平台专属工具，如 `hermes-discord` 加了 `discord`、`discord_admin`，见 `toolsets.py:400-406`）。

`includes` 字段实现工具集组合。`resolve_toolset()`（`toolsets.py:590`）递归展开：

```python
def resolve_toolset(name, visited=None):
    if visited is None:
        visited = set()
    if name in {"all", "*"}:
        ...  # 特殊别名：所有工具集的并集
    if name in visited:
        return []   # 环检测 / 钻石依赖
    visited.add(name)
    toolset = get_toolset(name)
    ...
```
（`toolsets.py:590-625`）

它处理 `all`/`*` 特殊别名（所有工具集的并集），用 `visited` 集合做环检测和钻石依赖去重，对 `hermes-<name>` 形式的插件平台还能自动生成工具集（`toolsets.py:627-640`）。

### 5.5.3 「注册了但不在工具集里 = 不暴露」

这是工具系统**最关键的设计约束**。`get_tool_definitions()` 的 docstring 一句话点明：

> All tools must be part of a toolset to be accessible.
> （`model_tools.py:267`）

一个工具哪怕完整 `register()` 了——有 schema、有 handler、check_fn 也通过——只要它**不出现在任何被启用的工具集的 `tools` 列表里**，模型就**永远看不到它**。注册表是「全集」，工具集是「暴露策略」，两者解耦。

这带来三个好处：

1. **安全分级**。`safe` 工具集刻意不含 `terminal`。一个不信任的场景只给 `safe`，模型就拿不到 terminal——即使 terminal 工具好端端注册着。
2. **token 控制**。给模型一百个工具的 schema 是巨大的 token 负担，还会让模型「选择困难」。工具集把暴露面收窄到当前场景真正需要的几十个。
3. **平台定制**。`hermes-acp`（编辑器集成）不含 `clarify`、`send_message`、TTS（`toolsets.py:331-348`）——编辑器里没有交互式 UI，暴露这些工具只会误导模型。

记住这条：**注册 ≠ 暴露**。注册让工具「存在」，工具集让工具「被看见」。

### 5.5.4 toolset_distributions.py

`toolset_distributions.py` 是一个**独立的、用于数据生成的**模块。它定义 `DISTRIBUTIONS`（`toolset_distributions.py:29` 起）——把工具集映射到「被选中的概率（%）」。docstring 写明用途：「distributions of toolsets for data generation runs」（`toolset_distributions.py:5-7`）。

它和正常的 agent 运行无关——批量数据生成时，每个 prompt 按分布随机抽一组工具集，以产生多样化的训练/评估轨迹。日常 CLI / gateway 走的是 `toolsets.py` 的确定性解析，不碰这个文件。

## 5.6 工具编排 model_tools.py

`model_tools.py` 是注册表之上的「薄编排层」（`model_tools.py:5`）。它做三件事：触发发现、提供 `get_tool_definitions`、提供 `handle_function_call`。

### 5.6.1 get_tool_definitions：带 generation + config 指纹的记忆化

`get_tool_definitions()`（`model_tools.py:263`）是上层（`run_agent`、`cli`、RL 环境）获取工具 schema 的入口。它做了一层记忆化：

```python
if quiet_mode:
    try:
        from hermes_cli.config import get_config_path
        cfg_stat = get_config_path().stat()
        cfg_fp = (cfg_stat.st_mtime_ns, cfg_stat.st_size)
    except (FileNotFoundError, OSError, ImportError):
        cfg_fp = None
    cache_key = (
        frozenset(enabled_toolsets) if enabled_toolsets is not None else None,
        frozenset(disabled_toolsets) if disabled_toolsets else None,
        registry._generation,
        cfg_fp,
    )
    cached = _tool_defs_cache.get(cache_key)
    if cached is not None:
        ...
        return list(cached)
```
（`model_tools.py:287-307`）

cache key 由四部分组成：

- 启用/禁用的工具集集合——caller 级输入；
- `registry._generation`——捕获注册表变更（MCP 刷新、插件加载）；
- `cfg_fp`——`config.yaml` 的 `(mtime, size)` 指纹，捕获影响动态 schema 的配置编辑（execute_code 模式、discord 动作白名单等），无需在每个写配置的地方手动 invalidate。

`check_fn` 结果的 TTL 缓存在下一层（`registry.get_definitions`）里。三层缓存（generation 游标 / config 指纹 / check_fn TTL）各管一类失效源。

返回时给 caller 的是列表的**浅拷贝**（`return list(cached)`）——schema dict 本身被各 caller 当只读共享，但列表必须独立，否则 `run_agent` 往 `self.tools` 追加 memory/LCM schema 会污染缓存，导致 gateway 长进程里工具名重复，被 DeepSeek/Kimi 等强制唯一工具名的 provider 拒掉（`model_tools.py:312-320` 注释，issue #17335）。

### 5.6.2 _compute_tool_definitions：实际计算

`_compute_tool_definitions()`（`model_tools.py:327`）是未缓存的实现。流程：

<svg viewBox="0 0 800 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="_compute_tool_definitions pipeline">
  <defs>
    <marker id="ar5c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="16" width="400" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="39" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">_compute_tool_definitions(enabled, disabled)</text>
  <line x1="400" y1="52" x2="400" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5c)"/>
  <rect x="60" y="72" width="680" height="58" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="78" y="92" font-size="11" font-weight="600" fill="currentColor">步骤 1 · 收集 enabled_toolsets</text>
  <text x="78" y="110" font-size="10" fill="#64748b">给定 → 逐个 validate_toolset() → resolve_toolset() → 并入 tools_to_include</text>
  <text x="78" y="124" font-size="10" fill="#64748b">未给定 → get_all_toolsets() 全并入</text>
  <line x1="400" y1="130" x2="400" y2="146" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5c)"/>
  <rect x="60" y="148" width="680" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.3"/>
  <text x="78" y="168" font-size="11" font-weight="600" fill="currentColor">步骤 2 · disabled_toolsets 作为减法</text>
  <text x="78" y="186" font-size="10" fill="#64748b">从 tools_to_include 做 difference_update — 复合集 hermes-cli 启用也严格剔除（#17309）</text>
  <line x1="400" y1="196" x2="400" y2="212" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5c)"/>
  <rect x="60" y="214" width="680" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="78" y="234" font-size="11" font-weight="600" fill="currentColor">步骤 3 · registry.get_definitions(tools_to_include)</text>
  <text x="78" y="251" font-size="10" fill="#64748b">check_fn 过滤在此发生</text>
  <line x1="400" y1="258" x2="400" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5c)"/>
  <rect x="60" y="276" width="680" height="48" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.3"/>
  <text x="78" y="296" font-size="11" font-weight="600" fill="currentColor">步骤 4 · 动态 schema 重建：execute_code / discord / discord_admin</text>
  <text x="78" y="314" font-size="10" fill="#64748b">只列实际可用的沙箱工具 / 按 bot intent 裁剪动作</text>
</svg>
<span class="figure-caption">图 R5.3 ｜ _compute_tool_definitions 的四步流水线：收集启用集、减去禁用集、check_fn 过滤、动态重建 schema</span>

<details>
<summary>ASCII 原版</summary>

```text
_compute_tool_definitions(enabled_toolsets, disabled_toolsets)
   │
   ├─ enabled_toolsets 给定？
   │     是 → 对每个 toolset：validate_toolset() → resolve_toolset() → 并入 tools_to_include
   │     否 → 默认：get_all_toolsets() 的所有工具集全并入
   │
   ├─ disabled_toolsets：作为"减法"步骤，从 tools_to_include 里 difference_update
   │     （即使复合工具集 hermes-cli 被启用，被禁工具集的工具也严格剔除，见 #17309）
   │
   ├─ registry.get_definitions(tools_to_include)  ← check_fn 过滤在此发生
   │
   └─ 对 execute_code / discord / discord_admin 做动态 schema 重建
        （只列出实际可用的沙箱工具 / 按 bot intent 裁剪动作）
```

</details>

「禁用作为最后的减法」（`model_tools.py:355-358` 注释）是个重要细节：先把启用的工具集全并起来，最后再统一减掉禁用的。这保证即使 `hermes-cli` 这种复合集启用了，属于某个禁用工具集的工具也会被严格剥掉。

`_compute_tool_definitions` 末尾还会针对 `execute_code` 重建 schema——只把**实际可用**的沙箱工具列进去（`model_tools.py:386-395`）；对 `discord` / `discord_admin` 按 bot 的特权 intent 重建（`model_tools.py:397-420`），隐藏 bot intent 不支持的动作。这背后是一条原则（`model_tools.py:382-385` 注释）：**绝不让模型在某个工具的描述里看到一个并不真实存在的工具名**，否则模型会幻觉调用它。

### 5.6.3 coerce_tool_args：类型强转

模型返回的 tool call 参数经常类型不对——数字给成字符串 `"42"`、布尔给成 `"true"`。`coerce_tool_args()`（`model_tools.py:535`）拿工具的 JSON Schema 比对，把字符串安全强转成 schema 声明的类型：

```python
def coerce_tool_args(tool_name, args):
    """Coerce tool call arguments to match their JSON Schema types.
    LLMs frequently return numbers as strings ("42" instead of 42) ...
    Handles "type": "integer"/"number"/"boolean", and union types.
    Also wraps bare scalar values in a single-element list when the schema
    declares "type": "array"."""
```
（`model_tools.py:535-552`）

它还处理一个开源模型的常见毛病：schema 要 `["https://a.com"]` 数组，模型给了裸标量 `"https://a.com"`，`coerce_tool_args` 会把它包成单元素列表（`model_tools.py:548-552`）。强转失败时保留原值——宁可让工具自己报参数错，也不丢数据。

### 5.6.4 handle_function_call：主分发器

`handle_function_call()`（`model_tools.py:731`）是 tool call 的主路由。完整流程：

<svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="handle_function_call dispatch pipeline with seven steps">
  <defs>
    <marker id="ar5d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="14" width="400" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="36" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">handle_function_call(function_name, args, ...)</text>
  <line x1="400" y1="48" x2="400" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="64" width="560" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="138" y="83" font-size="10.5" fill="currentColor"><tspan font-weight="700">1.</tspan> coerce_tool_args() — 类型强转</text>
  <line x1="400" y1="94" x2="400" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="106" width="560" height="38" rx="5" fill="#fef2f2" stroke="#dc2626"/>
  <text x="138" y="124" font-size="10.5" fill="currentColor"><tspan font-weight="700">2.</tspan> 在 _AGENT_LOOP_TOOLS 里？是 → 直接返回 error</text>
  <text x="138" y="138" font-size="9.5" fill="#64748b">"必须由 agent loop 处理"（见 5.8 节）</text>
  <line x1="400" y1="144" x2="400" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="156" width="560" height="38" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="138" y="174" font-size="10.5" fill="currentColor"><tspan font-weight="700">3.</tspan> pre_tool_call 钩子 — 返回 block → {"error": block_message}</text>
  <text x="138" y="188" font-size="9.5" fill="#64748b">单次触发契约：skip_pre_tool_call_hook=True 时跳过</text>
  <line x1="400" y1="194" x2="400" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="206" width="560" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="138" y="225" font-size="10.5" fill="currentColor"><tspan font-weight="700">4.</tspan> 非 read/search 工具 → notify_other_tool_call() 重置连续读计数器</text>
  <line x1="400" y1="236" x2="400" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="248" width="560" height="38" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="138" y="266" font-size="10.5" fill="currentColor"><tspan font-weight="700">5.</tspan> registry.dispatch(function_name, args, task_id=..., ...)</text>
  <text x="138" y="280" font-size="9.5" fill="#64748b">_dispatch_start = time.monotonic() → duration_ms</text>
  <line x1="400" y1="286" x2="400" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="298" width="560" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="138" y="317" font-size="10.5" fill="currentColor"><tspan font-weight="700">6.</tspan> post_tool_call 钩子（观察性，带 duration_ms）</text>
  <line x1="400" y1="328" x2="400" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="120" y="340" width="560" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="138" y="359" font-size="10.5" fill="currentColor"><tspan font-weight="700">7.</tspan> transform_tool_result 钩子 — 插件可替换结果字符串</text>
  <line x1="400" y1="370" x2="400" y2="380" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5d)"/>
  <rect x="280" y="372" width="240" height="24" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="400" y="388" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">return result（JSON 字符串）</text>
</svg>
<span class="figure-caption">图 R5.4 ｜ handle_function_call 主分发器的七步流水线：强转、拦截、钩子、dispatch、再钩子</span>

<details>
<summary>ASCII 原版</summary>

```text
handle_function_call(function_name, function_args, ...)
   │
   1. coerce_tool_args()                          ← 类型强转（model_tools.py:758）
   │
   2. function_name 在 _AGENT_LOOP_TOOLS 里？
   │     是 → 直接返回 error（"必须由 agent loop 处理"）  ← 见 5.8 节
   │
   3. pre_tool_call 钩子                            ← model_tools.py:774-789
   │     插件可返回 block 指令；返回 block → 直接 {"error": block_message}
   │     单次触发契约：skip_pre_tool_call_hook=True 时跳过（caller 已触发）
   │
   4. 非 read/search 工具 → notify_other_tool_call() ← 重置连续读计数器
   │
   5. _dispatch_start = time.monotonic()           ← 计时
   │   registry.dispatch(function_name, function_args, task_id=..., ...)
   │   duration_ms = ...
   │
   6. post_tool_call 钩子（观察性，带 duration_ms）   ← model_tools.py:825+
   │
   7. transform_tool_result 钩子                    ← 插件可替换结果字符串
   │
   └─ return result（JSON 字符串）
```

</details>

第 2 步的 `_AGENT_LOOP_TOOLS` 拦截见 5.8 节。第 3 步的 pre_tool_call 钩子有个「单次触发契约」（`model_tools.py:778-786` 注释）：钩子在每次工具执行里恰好触发一次，`run_agent._invoke_tool` 已经触发过时会传 `skip_pre_tool_call_hook=True` 避免重复触发。

实际的执行落到 `registry.dispatch()`（`tools/registry.py:390`）：

```python
def dispatch(self, name, args, **kwargs) -> str:
    entry = self.get_entry(name)
    if not entry:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        if entry.is_async:
            from model_tools import _run_async
            return _run_async(entry.handler(args, **kwargs))
        return entry.handler(args, **kwargs)
    except Exception as e:
        ...  # 异常统一转成 {"error": ...} JSON
```
（`tools/registry.py:390-416`）

`dispatch` 的两个保证：异步 handler 自动通过 `_run_async()` 桥接到持久事件循环（`model_tools.py:83`、`_get_tool_loop`）；**所有异常都被吞掉、转成 `{"error": "..."}` JSON**，保证错误格式统一。`execute_code` 走特殊分支——把 `enabled_tools` 传进去，让沙箱知道哪些工具可用，且 caller 提供的列表优先于进程全局（`model_tools.py:809-815`，防止子 agent 覆盖父进程工具集）。

### 5.6.5 所有 handler 必须返回 JSON 字符串

这是贯穿工具系统的硬契约。`tools/registry.py:549-560` 的注释写明：「Every tool handler must return a JSON string」。注册表提供两个辅助函数消除样板：

```python
def tool_error(message, **extra) -> str:
    result = {"error": str(message)}
    if extra:
        result.update(extra)
    return json.dumps(result, ensure_ascii=False)

def tool_result(data=None, **kwargs) -> str:
    if data is not None:
        return json.dumps(data, ensure_ascii=False)
    return json.dumps(kwargs, ensure_ascii=False)
```
（`tools/registry.py:563-589`）

统一返回 JSON 字符串的意义：tool 结果要作为 `role: tool` 的消息塞回对话流，需要一个稳定可解析的格式；错误和成功用同一种结构（`{"error": ...}` vs 其他），上层不用为每个工具写特判。多模态结果是唯一例外——见 5.9 节。

## 5.7 工具执行 tool_executor.py

`model_tools.handle_function_call` 处理**单个** tool call。但模型一轮可能发**一批** tool call。把这一批跑完是 `agent/tool_executor.py` 的职责，它有两个入口：并发与串行。

### 5.7.1 并行判定 _should_parallelize_tool_batch

`_should_parallelize_tool_batch()`（`agent/tool_dispatch_helpers.py:103`）决定一批 tool call 能不能并发跑。规则引擎：

```python
def _should_parallelize_tool_batch(tool_calls) -> bool:
    if len(tool_calls) <= 1:
        return False
    tool_names = [tc.function.name for tc in tool_calls]
    if any(name in _NEVER_PARALLEL_TOOLS for name in tool_names):
        return False
    reserved_paths = []
    for tool_call in tool_calls:
        tool_name = tool_call.function.name
        function_args = json.loads(tool_call.function.arguments)  # 解析失败 → 串行
        if not isinstance(function_args, dict):
            return False
        if tool_name in _PATH_SCOPED_TOOLS:
            scoped_path = _extract_parallel_scope_path(tool_name, function_args)
            if scoped_path is None:
                return False
            if any(_paths_overlap(scoped_path, e) for e in reserved_paths):
                return False
            reserved_paths.append(scoped_path)
            continue
        if tool_name not in _PARALLEL_SAFE_TOOLS:
            if not _is_mcp_tool_parallel_safe(tool_name):
                return False
    return True
```
（`agent/tool_dispatch_helpers.py:103-145`）

判定逻辑：

- 单个 call 不并行；
- 含 `_NEVER_PARALLEL_TOOLS`（`clarify`，交互式工具）→ 串行；
- 工具必须在 `_PARALLEL_SAFE_TOOLS`（`agent/tool_dispatch_helpers.py:44-56`，纯只读、无共享可变会话状态：`read_file`、`search_files`、`web_search`、`vision_analyze` 等）里，否则串行；
- `_PATH_SCOPED_TOOLS`（`read_file`、`write_file`、`patch`）是特例：它们可以并发，**前提是目标路径互不重叠**；
- 参数解析失败、非 dict → 保守串行；
- MCP 工具看它所属服务器是否开了并行（`_is_mcp_tool_parallel_safe`）。

### 5.7.2 路径冲突检测 _paths_overlap

`write_file` / `patch` 是写操作，但只要写的是不同文件就能并发。`_extract_parallel_scope_path()`（`agent/tool_dispatch_helpers.py:148`）把每个 path-scoped 工具的目标路径归一化为绝对路径（不用 `resolve()`，因为文件可能还不存在）。`_paths_overlap()`（`agent/tool_dispatch_helpers.py:166`）判断两个路径是否可能指向同一子树：

```python
def _paths_overlap(left, right) -> bool:
    """Return True when two paths may refer to the same subtree."""
    left_parts = left.parts
    right_parts = right.parts
    common_len = min(len(left_parts), len(right_parts))
    return left_parts[:common_len] == right_parts[:common_len]
```
（`agent/tool_dispatch_helpers.py:166-175`）

它比较两个路径的公共前缀——只要短的那个是长的那个的前缀，就认为可能重叠（一个写 `a/b`、一个写 `a/b/c` 必须串行）。`_should_parallelize_tool_batch` 用 `reserved_paths` 累积已分配的路径，任何新路径与已有路径重叠就退回串行。这是「并发安全」的精确实现：并行只在「证明无冲突」时才发生。

### 5.7.3 execute_tool_calls_concurrent / sequential

`execute_tool_calls_concurrent()`（`agent/tool_executor.py:64`）用线程池跑一批 tool call。`_MAX_TOOL_WORKERS = 8`（`agent/tool_executor.py:55`）。结果按原始 tool-call 顺序收集再 append 回 messages，保证 API 看到的顺序符合预期（`agent/tool_executor.py:66-68`）。

`execute_tool_calls_sequential()`（`agent/tool_executor.py:474`）按顺序逐个跑，用于单个 call 或交互式工具。

两个执行器都在每个工具前做相同的前置工作（`agent/tool_executor.py:86-140` / `496-540`）：

- **中断检查**：用户中途发「stop」，剩余 tool call 全部跳过，填入 `[Tool execution cancelled ...]` 占位（`agent/tool_executor.py:73-83` / `479-493`）；
- **nudge 计数器重置**：`memory` 工具被调用 → `_turns_since_memory = 0`；`skill_manage` → `_iters_since_skill = 0`；
- **checkpoint**：`write_file` / `patch` 前对目标文件目录建检查点；`terminal` 前若命令是破坏性（`_is_destructive_command`，见下）则建检查点；
- **pre_tool_call 钩子 + guardrail 检查**：被任一阻止则该工具跳过，不进真正执行。

`_is_destructive_command()`（`agent/tool_dispatch_helpers.py:80`）用正则启发式判断一个 terminal 命令是否会改/删文件（`rm`、`mv`、`sed -i`、`git reset/clean/checkout`、覆盖式重定向 `>` 等，`_DESTRUCTIVE_PATTERNS` 见 `agent/tool_dispatch_helpers.py:64-77`）。

## 5.8 agent 级工具的拦截

`handle_function_call` 第 2 步有一个特殊拦截：

```python
_AGENT_LOOP_TOOLS = {"todo", "memory", "session_search", "delegate_task"}
...
if function_name in _AGENT_LOOP_TOOLS:
    return json.dumps({"error": f"{function_name} must be handled by the agent loop"})
```
（`model_tools.py:485`、`761-762`）

`todo`、`memory`、`session_search`、`delegate_task` 这四个工具虽然也在注册表里、也出现在工具集里、模型也能正常调用它们，但**它们不能走 `registry.dispatch` 这条普通分发路**。`run_agent.py` 在调到 `handle_function_call` **之前**就把它们拦下来，自己处理。

为什么这四个要特殊？因为它们需要 agent 循环的内部状态，而 `registry.dispatch` 的 handler 拿不到这些状态：

- `todo` / `memory` 需要读写 agent 实例上的状态（待办列表、记忆 store、nudge 计数器）；
- `session_search` 需要访问会话历史索引；
- `delegate_task` 需要派生子 agent——这必须由父 agent 循环来编排（控制并发数、派生深度、上下文隔离）。

`_AGENT_LOOP_TOOLS` 里的那行 `return ... "must be handled by the agent loop"` 是一道**防御性栏杆**：万一某条代码路径漏拦了这四个工具、直接调进了 `handle_function_call`，它会立刻返回明确错误，而不是用一个拿不到状态的 handler 跑出错误结果。这是「让错误明显」的设计——宁可清晰地失败，不要悄悄地错。

<svg viewBox="0 0 800 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Agent-level tool interception before handle_function_call">
  <defs>
    <marker id="ar5e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="290" y="16" width="220" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="37" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">模型发来 tool call</text>
  <line x1="400" y1="48" x2="400" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5e)"/>
  <rect x="290" y="66" width="220" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="87" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">run_agent 工具调度</text>
  <line x1="400" y1="98" x2="400" y2="114" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="200" y="116" width="400" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="400" y="141" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">∈ {todo, memory, session_search, delegate_task}?</text>
  <line x1="280" y1="156" x2="180" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5e)"/>
  <text x="200" y="176" font-size="10" fill="#7c3aed">是</text>
  <rect x="30" y="188" width="320" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="190" y="208" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">run_agent 自己处理</text>
  <text x="190" y="224" text-anchor="middle" font-size="9.5" fill="#64748b">访问 agent 实例状态 / 派生子 agent</text>
  <text x="190" y="238" text-anchor="middle" font-size="9.5" fill="#dc2626">不进 handle_function_call</text>
  <line x1="520" y1="156" x2="620" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5e)"/>
  <text x="588" y="176" font-size="10" fill="#64748b">否</text>
  <rect x="450" y="188" width="320" height="58" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="610" y="214" text-anchor="middle" font-size="10.5" font-weight="600" fill="currentColor">handle_function_call</text>
  <text x="610" y="232" text-anchor="middle" font-size="9.5" fill="#64748b">→ registry.dispatch → entry.handler</text>
</svg>
<span class="figure-caption">图 R5.5 ｜ 四个 agent 级工具在进入 handle_function_call 前被 run_agent 拦截，因其需要 agent 循环内部状态</span>

<details>
<summary>ASCII 原版</summary>

```text
模型发来 tool call
   │
   ▼
run_agent 工具调度
   │
   ├─ function_name ∈ {todo, memory, session_search, delegate_task}?
   │     是 → run_agent 自己处理（能访问 agent 实例状态 / 派生子 agent）
   │            └─ 不进 handle_function_call
   │
   └─ 否 → handle_function_call → registry.dispatch → entry.handler
```

</details>

## 5.9 多模态结果

普通工具返回 JSON 字符串，但少数工具（如 `computer_use` 返回截图）要返回图像。它们返回一个「多模态信封」dict：`{"_multimodal": True, "content": [...], "text_summary": ...}`（`agent/tool_dispatch_helpers.py:11-13` 注释）。`_is_multimodal_tool_result()`（`agent/tool_dispatch_helpers.py:177`）识别这种信封，`_multimodal_text_summary()` 等辅助函数把它拆成「给模型看的图像块」+「给轨迹记录用的文本摘要」。这是「所有 handler 返回 JSON 字符串」契约的唯一受控例外。

## 5.10 工具目录概览

注册表里上百个工具，按类别（toolset）分组。下表给每类的代表工具和一句话职责，便于读者在 `tools/` 目录里定位：

| 类别 / toolset | 代表工具 | 职责 |
|---|---|---|
| `file` | `read_file` / `write_file` / `patch` / `search_files` | 读、写、模糊匹配补丁、内容+文件名搜索 |
| `web` / `search` | `web_search` / `web_extract` | 网页搜索、抓取页面正文 |
| `browser` | `browser_navigate` / `browser_click` / `browser_snapshot` / `browser_vision` | 真实浏览器自动化：导航、点击、输入、截快照、视觉理解 |
| `terminal` | `terminal` / `process` | 执行 shell 命令、管理后台进程（详见第 6 章） |
| `code_execution` | `execute_code` | 在沙箱里跑 Python 脚本，可编程调用其他工具，省 LLM 往返 |
| `delegation` | `delegate_task` | 派生上下文隔离的子 agent 处理子任务（agent 级工具，5.8 节） |
| `vision` / `video` | `vision_analyze` / `video_analyze` | 图像/视频理解 |
| `image_gen` / `video_gen` | `image_generate` / `video_generate` | 图像/视频生成 |
| `memory` | `memory` | 跨 session 持久记忆（agent 级工具，5.8 节） |
| `todo` | `todo` | 多步任务规划与追踪（agent 级工具，5.8 节） |
| `session_search` | `session_search` | 检索过往对话并摘要（agent 级工具，5.8 节） |
| `clarify` | `clarify` | 向用户提澄清问题（交互式，永不并行） |
| `cronjob` | `cronjob` | 创建/列出/暂停/触发定时任务 |
| `skills` | `skills_list` / `skill_view` / `skill_manage` | 列出/查看/创建编辑技能文档 |
| `kanban` | `kanban_show` / `kanban_complete` / `kanban_create` | 多 agent 看板协调（仅 kanban worker 进程暴露） |
| `messaging` | `send_message` | 跨平台发消息（gateway 在跑时可用） |
| MCP（`mcp-*`） | 动态 | MCP 服务器暴露的工具，运行时发现/注销 |

`tts`、`homeassistant`、`computer_use`、`discord`、`spotify`、飞书/元宝等还有各自的工具集。完整清单见 `toolsets.py` 的 `TOOLSETS` 字典与各 `tools/*_tool.py` 文件。

## 5.11 小结

工具系统的四层各司其职：

- **注册表（`tools/registry.py`）**——全集。`ToolEntry` 装元数据，`ToolRegistry` 单例靠 `_generation` 计数器做缓存失效游标，`discover_builtin_tools` 用 AST 扫描自动发现工具模块，`check_fn` 带 30 秒 TTL 缓存解决「运行时可用性」。
- **工具集（`toolsets.py`）**——暴露策略。`_HERMES_CORE_TOOLS` 是全平台共享核心，`TOOLSETS` 把工具分组。铁律：**注册了但不在被启用的工具集里 = 模型永远看不到**。
- **编排（`model_tools.py`）**——`get_tool_definitions` 三层缓存出 schema，`handle_function_call` 是主分发器（强转 → 钩子 → `registry.dispatch` → 钩子），所有 handler 返回 JSON 字符串。
- **执行（`agent/tool_executor.py`）**——并发/串行跑一批 tool call，`_should_parallelize_tool_batch` + `_paths_overlap` 精确判定「证明无冲突才并行」。

外加一个横切设计：`todo` / `memory` / `session_search` / `delegate_task` 这四个 agent 级工具在进入 `handle_function_call` 之前就被 `run_agent.py` 拦截，因为它们需要 agent 循环的内部状态。

## 延伸阅读

- 工具集里的 `terminal` 工具如何选择七种后端之一来执行命令——见 [第 6 章 终端后端：七种执行环境](06-terminal-environments.md)。
- `valid_tool_names` 如何决定系统提示里注入哪些工具指引、技能清单——见 [第 4 章 系统提示与上下文构造](04-system-prompt.md)。
- tool call 在同步循环里如何被收集、执行、把结果塞回对话——见 [第 3 章 核心循环](03-core-loop.md)。
- 危险命令审批（`tools/approval.py`）的完整机制——见 [第 14 章 安全与审批](14-security-approval.md)。
- MCP 工具的动态注册与刷新——见 [第 12 章 MCP 集成](12-mcp-integration.md)。
