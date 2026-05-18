# Trace 步骤 05 —— 79 个工具是谁在什么时候塞进注册表的？

## 1. 当前情境

上一步结束时，`AIAgent` 实例已经构造完成，`SessionDB` 已连上 SQLite。但 `AIAgent.__init__` 里有一行很容易被忽略——它要把"这个 agent 能用哪些工具"的 schema 列表算出来交给后续的系统提示和 API 调用。

要算这份列表，前提是有一个**装满工具条目的注册表**。可此刻 `ToolRegistry` 这个单例还是空的吗？不是。事实上在 `AIAgent` 被实例化**之前**，注册表早已被填满——它是在 `import model_tools` 这一刻、作为模块级副作用完成的。这一步就回到那个时刻，看清楚 `tools/` 目录下散落的 ~79 个工具是怎么自己"跳"进注册表的。

## 2. 问题

Hermes 的工具不是一个大文件，而是 `tools/` 目录下几十个独立 `.py`：`file_tools.py`、`web_tools.py`、`browser_tools.py`、`kanban_tools.py`……每个文件定义自己的 schema 和 handler。系统启动时必须做到：

- 把所有"真的是工具模块"的文件都 `import` 进来，触发它们的注册。
- 工具元数据（名字、所属 toolset、schema、handler、可用性检查）要统一收进一个可查询的结构。
- 新增一个工具文件时，开发者**不应该**还要去某个中心清单里手写一笔——否则迟早漏。
- 不能误伤：`tools/` 里也有纯辅助模块（`budget_config.py`、`registry.py` 本身），它们不该被当成工具加载。

## 3. 朴素思路

最直接的写法：维护一份手写的 import 清单。在 `model_tools.py` 顶部老老实实列出来：

```python
import tools.file_tools
import tools.web_tools
import tools.browser_tools
# ... 再写 30 行
```

每个工具文件在被 import 时，模块级的 `registry.register(...)` 自然就执行了，注册表也就填满了。清单写在哪里一目了然，新增工具时"顺手"加一行即可。

## 4. 为什么朴素思路会崩

"顺手加一行"正是问题所在——它依赖人的纪律，而纪律会失效：

- **漏注册静默失败**。新写了 `tools/foo_tool.py`，忘了往清单加一行。它不会报错，只是这个工具**永远不存在**。没有异常、没有日志，调试时极难定位——"我明明写了 foo 工具，模型为什么说没有？"
- **import 清单与目录漂移**。删掉一个工具文件却忘了删清单里的行，启动时 `ImportError`；改名同理。清单是目录状态的一份**手抄副本**,副本总会和正本不一致。
- **辅助模块的边界靠记忆**。`tools/` 里哪些是工具、哪些是 helper，靠的是开发者记得"别把 `budget_config` 写进清单"。这条规则没有任何代码强制。
- **circular import 风险**。如果用"导入整个包"的偷懒办法（`import tools.*` 之类），辅助模块和工具模块的导入顺序就不可控，`registry.py` 被某个工具模块反向依赖时容易绕成环。

核心矛盾：注册表的内容必须**等于** `tools/` 目录的真实状态，而手写清单只是一份会过期的快照。

## 5. Hermes 的做法

Hermes 让目录**自己描述自己**——用 AST 扫描在启动时实时发现工具模块，而不是读一份手抄清单。这件事由 `tools/registry.py` 的 `discover_builtin_tools()` 完成。

判定"一个文件是不是工具模块"的标准很精确：它的**模块体顶层**必须有一句 `registry.register(...)` 调用。`_is_registry_register_call()`(`tools/registry.py:29-39`) 用 AST 节点匹配这个形状——必须是一个 `Expr` 包着 `Call`，`Call` 的 `func` 是 `Attribute`，属性名为 `register`，且其 `value` 是名为 `registry` 的 `Name`：

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

为什么是 AST 而不是字符串 `grep`？因为 `_module_registers_tools()`(`tools/registry.py:42-54`) 只遍历 `tree.body`——也就是**模块顶层语句**。一个 helper 模块如果在某个函数*内部*调了 `registry.register()`，它不会被 `import`。文本搜索做不到这种"只看顶层"的区分，AST 天然能。`ast.parse` 失败（语法错误、读不出文件）就当它不是工具模块，静默跳过。

`discover_builtin_tools()`(`tools/registry.py:57-74`) 把这套判定串起来：

```python
def discover_builtin_tools(tools_dir: Optional[Path] = None) -> List[str]:
    """Import built-in self-registering tool modules and return their module names."""
    tools_path = Path(tools_dir) if tools_dir is not None else Path(__file__).resolve().parent
    module_names = [
        f"tools.{path.stem}"
        for path in sorted(tools_path.glob("*.py"))
        if path.name not in {"__init__.py", "registry.py", "mcp_tool.py"}
        and _module_registers_tools(path)
    ]

    imported: List[str] = []
    for mod_name in module_names:
        try:
            importlib.import_module(mod_name)
            imported.append(mod_name)
        except Exception as e:
            logger.warning("Could not import tool module %s: %s", mod_name, e)
    return imported
```

`glob("*.py")` + `sorted` 保证发现顺序确定；`__init__.py` / `registry.py` / `mcp_tool.py` 显式排除（`registry.py` 不能 import 自己，`mcp_tool.py` 是动态发现、不走静态注册）。`importlib.import_module` 这一行才是真正的开关——**import 的副作用就是注册**：

<svg viewBox="0 0 840 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tool discovery flow from import model_tools to ToolRegistry">
  <defs>
    <marker id="ar5a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="20" width="280" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="38" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">import model_tools</text>
  <text x="420" y="53" text-anchor="middle" font-size="10" fill="#64748b">model_tools.py:31 / :179</text>
  <line x1="420" y1="60" x2="420" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="270" y="90" width="300" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="420" y="110" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">discover_builtin_tools()</text>
  <text x="420" y="125" text-anchor="middle" font-size="10" fill="#64748b">glob tools/*.py，sorted</text>
  <line x1="420" y1="134" x2="420" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="158" x2="660" y2="158" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="180" y1="158" x2="180" y2="182" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <line x1="660" y1="158" x2="660" y2="182" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="40" y="186" width="290" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="185" y="206" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_module_registers_tools(file_tools.py)</text>
  <text x="185" y="221" text-anchor="middle" font-size="10" fill="#64748b">AST 看顶层 → 是</text>
  <rect x="510" y="186" width="290" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="655" y="206" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_module_registers_tools(budget_config.py)</text>
  <text x="655" y="221" text-anchor="middle" font-size="10" fill="#64748b">顶层无 register → 跳过</text>
  <line x1="185" y1="230" x2="185" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="40" y="260" width="290" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="185" y="280" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">importlib.import_module("tools.file_tools")</text>
  <text x="185" y="295" text-anchor="middle" font-size="10" fill="#64748b">模块体执行 registry.register("read_file", ...)</text>
  <line x1="185" y1="304" x2="185" y2="330" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="40" y="334" width="290" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="185" y="356" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">ToolRegistry.register()</text>
  <text x="185" y="372" text-anchor="middle" font-size="10" fill="#64748b">self._tools["read_file"] = ToolEntry(...)</text>
  <text x="655" y="282" text-anchor="middle" font-size="11" fill="#94a3b8">对每个工具文件重复此判定</text>
</svg>
<span class="figure-caption">图 T5.1 ｜ import model_tools 触发 discover_builtin_tools()：AST 顶层判定区分工具模块与 helper，import 副作用把 ToolEntry 塞进注册表。</span>

<details>
<summary>ASCII 原版</summary>

```text
   import model_tools                         (model_tools.py:31 / :179)
        │
        ▼
   discover_builtin_tools()
        │  glob tools/*.py，sorted
        │
        ├── _module_registers_tools(file_tools.py)?  AST 看顶层 → 是
        │       importlib.import_module("tools.file_tools")
        │            └─ 模块体执行到 registry.register("read_file", ...)
        │                      │
        │                      ▼
        │              ToolRegistry.register()  → self._tools["read_file"] = ToolEntry(...)
        │
        ├── _module_registers_tools(budget_config.py)? 顶层无 register → 跳过
        └── ... 对每个工具文件重复 ...
```

</details>

落点是 `ToolRegistry.register()`(`tools/registry.py:234-305`)。每次调用构造一个 `ToolEntry`（`tools/registry.py:77`，`__slots__` 存 name / toolset / schema / handler / check_fn / requires_env 等元数据），塞进单例字典 `self._tools[name]`。它还做防误伤——同名工具若来自**不同 toolset**，默认拒绝注册（`tools/registry.py:279-289`），除非显式传 `override=True`，避免插件悄悄覆盖内建工具。每次成功注册都给 `self._generation` 计数器 +1，这个计数器后面是 schema 缓存的失效信号。

整个发现过程作为模块级副作用执行：`model_tools.py:31` 先 `from tools.registry import discover_builtin_tools`，`model_tools.py:179` 一行光秃秃的 `discover_builtin_tools()` 就触发全部 import。注释（`model_tools.py:181-189`）特意说明：MCP 工具发现**不**在这里做——它会阻塞 120s，已移到各入口自己的启动流程。

**关键一点：注册了 ≠ 暴露给 agent。** `register()` 只是把工具放进注册表这个"全集"。一个工具要真正出现在某次 API 调用的 schema 里，还得满足两层过滤：

1. 它得属于某个被启用的 **toolset**。`toolsets.py:31` 的 `_HERMES_CORE_TOOLS` 列出了 CLI 与所有消息平台共享的核心工具名（`read_file`、`web_search`、`terminal`……）。不在任何启用 toolset 里的工具，注册了也查不到。
2. 它的 `check_fn()` 得返回 `True`（环境就绪）。

这两层过滤发生在 `get_tool_definitions()`(`model_tools.py:263`)——它按启用/禁用 toolset 求出工具名集合，再交给 `registry.get_definitions()` 逐个跑 `check_fn` 过滤，产出 OpenAI 格式的 schema 列表。结果按 `(toolsets, registry._generation, config 指纹)` 记忆化缓存：注册表一变，`_generation` 跳变，缓存自动失效。

到这一步结束，`ToolRegistry` 单例的 `_tools` 字典里躺着 ~79 个 `ToolEntry`，每个工具的 schema、handler、所属 toolset、可用性检查都已就位，可被 `get_definitions()` 随时查询。

## 6. 代码位置

按阅读顺序：

- 触发点：`model_tools.py:31` —— `from tools.registry import discover_builtin_tools, registry`。
- 实际调用：`model_tools.py:179` —— 模块级一行 `discover_builtin_tools()`。
- AST 形状判定：`tools/registry.py:29-39` —— `_is_registry_register_call()`。
- 只看模块顶层：`tools/registry.py:42-54` —— `_module_registers_tools()`，遍历 `tree.body`。
- 发现主函数：`tools/registry.py:57-74` —— `discover_builtin_tools()`，glob + 排除 + import。
- 元数据容器：`tools/registry.py:77-106` —— `ToolEntry`，`__slots__` 字段。
- 注册落点：`tools/registry.py:234-305` —— `ToolRegistry.register()`，含 override 防误伤与 `_generation` 自增。
- 核心工具清单：`toolsets.py:31-73` —— `_HERMES_CORE_TOOLS`。
- 两层过滤出口：`model_tools.py:263-324` —— `get_tool_definitions()`，toolset 过滤 + check_fn + 记忆化。

## 7. 分支与延伸

- 工具系统的全貌——`ToolEntry`、toolset 组合、check_fn 可用性门控、MCP 动态工具——见 [第 5 章 工具系统](05-tool-system.md)。
- 上一步 `AIAgent` 怎样实例化、为什么它依赖一个已填满的注册表 → [Trace 步骤 04](tour-04-init-agent.md)。
- 下一步把这份工具 schema 连同 SOUL.md、记忆一起拼进系统提示 → [Trace 步骤 06](tour-06-system-prompt.md)。
- MCP 外部工具不走 AST 静态发现，而是各入口启动时显式调用动态发现（`tools/mcp_tool.py:3261` 附近）；它会改写注册表并撞 `_generation` 计数器使缓存失效。
- `check_fn` 的结果有 ~30s TTL 缓存（`tools/registry.py:121-141`），所以 `hermes tools enable foo` 后工具可用性会在一两轮内自然生效，无需重启。

## 8. 走完这一步你脑子里应该多了什么

1. Hermes 的工具注册表是**目录自描述**的——`discover_builtin_tools()` 在启动时扫 `tools/*.py`，没有任何手写的 import 清单，新增工具文件零额外登记。
2. "是不是工具模块"用 **AST 看模块顶层**有没有 `registry.register()` 判定，比字符串搜索精确——能区分"顶层注册的工具"和"函数内部碰巧调了 register 的 helper"。
3. **import 的副作用就是注册**：`importlib.import_module` 执行工具模块体，模块级的 `registry.register()` 就把 `ToolEntry` 塞进单例字典。
4. **注册 ≠ 暴露**：进了注册表只是进了"全集"，工具还得出现在某个启用的 toolset（`_HERMES_CORE_TOOLS`）里、且 `check_fn` 通过，才会进入 `get_tool_definitions()` 产出的 schema。
5. 走完这一步，`ToolRegistry._tools` 装着 ~79 个条目，每个工具的 schema 可被查询；`_generation` 计数器为下游 schema 缓存提供失效信号。

---

下一步：[Trace 步骤 06 —— 拼装系统提示](tour-06-system-prompt.md)
