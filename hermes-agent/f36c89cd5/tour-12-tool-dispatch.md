# Trace 步骤 12 —— 一个工具调用，怎么调度到 handler？

## 1. 当前情境

上一步（[步骤 11](tour-11-parse-tool-call.md)）结束时，`tool_call` 已经解析完毕。`messages` 推进到了 `[system, user, assistant(tool_call)]`——末尾那条 assistant 消息带着一个 `tool_calls` 列表：

```text
tool_calls = [
    {
        "id": "call_abc123",
        "type": "function",
        "function": {"name": "read_file", "arguments": '{"path": "README.md"}'},
    }
]
```

对话循环在 `conversation_loop.py:3256` 调用了 `agent._execute_tool_calls(assistant_message, messages, ...)`。控制权离开对话循环、进入工具调度层。这一步要回答的是：从"有一个待执行的工具调用清单"到"某个具体的 handler 函数被选定、参数到位、准备真正执行"之间，发生了什么。

## 2. 问题

一个回合里模型可能发出**不止一个**工具调用。调度层要在真正执行之前做两个决定：

- **并行还是串行？** 模型可能一口气要求"读文件 A、读文件 B、搜目录 C"。这些彼此独立的只读操作如果串行跑，用户要等三倍时间。但如果模型要求的是"写文件 A、再读文件 A"，并行跑就是数据竞争——读到的可能是写之前的旧内容。
- **每个调用怎么落到具体函数？** `read_file` 这个名字，要变成 `tools/file_tools.py` 里那个真正读文件的 Python 函数被调用，中间还要插入参数类型强转、插件钩子、审批检查。

约束在于：调度层**不能知道** `read_file` 具体怎么读文件——那是工具自己的事。它只负责"按名字找到 handler、把控制权和参数交过去、把返回值收回来"。

## 3. 朴素思路

最直接的写法：拿到 `tool_calls` 列表，`for` 循环挨个执行；每个调用就 `if name == "read_file": ...elif name == "write_file": ...` 一长串分支,匹配到就调对应函数。

并行?不要了,串行最简单,反正"对一次"。

## 4. 为什么朴素思路会崩

纯串行 + `if/elif` 分发会撞两堵墙：

- **延迟堆叠**。agentic 模型最常见的动作就是"一次性读五个文件再综合"。五个独立 `read_file` 串行跑,每个哪怕只有 200ms,用户也要干等一秒——而这一秒里 CPU 全在 I/O 等待上空转。这种场景下并行几乎是免费的提速,放弃它是浪费。
- **盲目并行又会数据竞争**。如果不加判断一律并行,那"写文件 A"和"读文件 A"同时跑,读到的内容取决于线程调度,结果不可复现。`terminal`、`patch` 这类有副作用的工具更是绝不能并行。所以并行不能"无脑开",必须有一个**冲突判定**:批次里的工具是否互相安全、它们碰的文件路径是否重叠。
- **`if/elif` 分发无法扩展**。Hermes 有约 79 个工具,还有动态发现的 MCP 工具、插件工具——它们在进程启动时才注册进来(见 [步骤 05](tour-05-tool-discovery.md))。一条写死的 `if/elif` 链根本枚举不全,新增一个工具就得改调度代码。分发必须走**注册表查找**。

核心矛盾:调度层要在"尽量并行提速"和"绝不引入数据竞争"之间做一个**保守但智能**的判断,同时分发必须对运行时才出现的工具开放。

## 5. Hermes 的做法

`run_agent.py:3749` 的 `_execute_tool_calls` 是调度的总入口。它做的第一件事就是问一句"这批能并行吗":

```python
def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
    tool_calls = assistant_message.tool_calls
    # ...
    if not _should_parallelize_tool_batch(tool_calls):          # :3761
        return self._execute_tool_calls_sequential(             # :3762  串行
            assistant_message, messages, effective_task_id, api_call_count)
    return self._execute_tool_calls_concurrent(                 # :3766  并行
        assistant_message, messages, effective_task_id, api_call_count)
```

`_should_parallelize_tool_batch`（`agent/tool_dispatch_helpers.py:103`）就是那个保守判定器，规则一目了然:

```python
def _should_parallelize_tool_batch(tool_calls) -> bool:
    if len(tool_calls) <= 1:                                    # :105  只有一个 → 串行
        return False
    tool_names = [tc.function.name for tc in tool_calls]
    if any(name in _NEVER_PARALLEL_TOOLS for name in tool_names):  # :109  有危险工具 → 串行
        return False

    reserved_paths: list[Path] = []
    for tool_call in tool_calls:
        # ... 解析 arguments;解析失败 → 串行 ...
        if tool_name in _PATH_SCOPED_TOOLS:
            scoped_path = _extract_parallel_scope_path(tool_name, function_args)
            if scoped_path is None:
                return False
            if any(_paths_overlap(scoped_path, existing) for existing in reserved_paths):  # :136
                return False                                    # 路径重叠 → 串行
            reserved_paths.append(scoped_path)
            continue
        if tool_name not in _PARALLEL_SAFE_TOOLS:               # :141  不在白名单 → 串行
            if not _is_mcp_tool_parallel_safe(tool_name):
                return False
    return True
```

判定逻辑层层设防:**单调用直接串行**(`:105`)、**含 `_NEVER_PARALLEL_TOOLS` 直接串行**(`:109`)、**路径作用域工具要查路径冲突**——`_paths_overlap`（`tool_dispatch_helpers.py:166`)逐段比较两个路径的 `parts`,只要一个是另一个的前缀就算重叠:

```python
def _paths_overlap(left: Path, right: Path) -> bool:
    common_len = min(len(left.parts), len(right.parts))
    return left.parts[:common_len] == right.parts[:common_len]
```

只有"多个调用、全部在并行安全白名单里、路径互不重叠"才返回 `True`。**本例只有一个 `read_file` 调用**——`len(tool_calls) <= 1` 直接命中 `:105`,走 `_execute_tool_calls_sequential`(`tool_executor.py:474`)。

串行执行器是一个 `for` 循环(`tool_executor.py:476`),每轮:先查中断标志(`:480`,用户喊过 stop 就跳过剩余工具)、把 `tool_call.function.arguments` 这段 JSON 字符串 `json.loads` 成 dict(`:500`)、过插件 `pre_tool_call` 钩子和 guardrail 判定(`:508-525`)、然后才进真正的执行。

**单个工具调用的执行,落到 `model_tools.py:731` 的 `handle_function_call`。** 这是工具系统的统一调度器,它干三件事:

```python
def handle_function_call(function_name, function_args, task_id=None, ...):
    # ① 类型强转:把 "42" 变 42、把裸标量包成单元素 list
    function_args = coerce_tool_args(function_name, function_args)   # :758

    # ② pre_tool_call 插件钩子(可能返回 block 指令)
    if not skip_pre_tool_call_hook:
        block_message = get_pre_tool_call_block_message(function_name, ...)
        if block_message is not None:
            return json.dumps({"error": block_message})

    # ③ 注册表分发到真正的 handler
    result = registry.dispatch(function_name, function_args,         # :807 / :816
                               task_id=task_id, user_task=user_task)
    # ④ 测量耗时、跑 post_tool_call 钩子
```

`coerce_tool_args`（`model_tools.py:535`）针对开放权重模型的老毛病做修正——模型经常把数字写成字符串(`"42"`)、把数组写成裸标量(`{"urls": "..."}` 而非 `{"urls": ["..."]}`)。它拿工具注册的 JSON Schema 逐字段比对,该转 int 转 int、该包 list 包 list,转不动就原样保留。本例 `{"path": "README.md"}` 里 `path` 本来就是字符串、schema 也要字符串,coerce 原样放行。

`registry.dispatch`（`tools/registry.py:390`）是分发的真正落点——它**不是 `if/elif`**,而是注册表查找:

```python
def dispatch(self, name: str, args: dict, **kwargs) -> str:
    entry = self.get_entry(name)                  # 按名字查注册表
    if not entry:
        return json.dumps({"error": f"Unknown tool: {name}"})
    try:
        if entry.is_async:
            return _run_async(entry.handler(args, **kwargs))
        return entry.handler(args, **kwargs)       # ← 调用注册时登记的 handler
    except Exception as e:
        # 任何异常都被收敛成 {"error": "..."} 的 JSON
        return json.dumps({"error": sanitized})
```

`registry._tools` 这张表是进程启动时由 [步骤 05](tour-05-tool-discovery.md) 的自动发现填满的。`read_file` 这个名字早就通过 `registry.register(name="read_file", ..., handler=_handle_read_file, ...)`（`tools/file_tools.py:1169`)登记好了——`get_entry("read_file")` 拿到的 `ToolEntry` 里,`handler` 字段就指向 `tools/file_tools.py:1122` 的 `_handle_read_file`。新增工具只要 `register` 一次,调度层一行都不用改;MCP 工具运行时动态 `register`,同样自动可调度。

整条调度链:

<svg viewBox="0 0 840 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tool dispatch chain from execute_tool_calls through parallelize decision to selected handler">
  <defs>
    <marker id="ar12a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="260" y="20" width="320" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="420" y="44" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_execute_tool_calls(...)　conversation_loop.py:3256</text>
  <line x1="420" y1="60" x2="420" y2="82" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="240" y="86" width="360" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="106" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_should_parallelize_tool_batch(tool_calls)?</text>
  <text x="420" y="121" text-anchor="middle" font-size="10" fill="#64748b">run_agent.py:3761 — 保守判定</text>
  <line x1="420" y1="130" x2="420" y2="148" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="220" y1="148" x2="620" y2="148" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="220" y1="148" x2="220" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <line x1="620" y1="148" x2="620" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <text x="220" y="164" text-anchor="middle" font-size="9" fill="#64748b">len≤1 / 危险工具 / 路径重叠 → False</text>
  <text x="620" y="164" text-anchor="middle" font-size="9" fill="#64748b">多调用 + 全并行安全 + 路径不冲突 → True</text>
  <rect x="80" y="174" width="280" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="220" y="194" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_execute_tool_calls_sequential</text>
  <text x="220" y="210" text-anchor="middle" font-size="10" fill="#64748b">tool_executor.py:474 — 本例走这条</text>
  <rect x="480" y="174" width="280" height="48" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="620" y="194" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">_execute_tool_calls_concurrent</text>
  <text x="620" y="210" text-anchor="middle" font-size="10" fill="#64748b">tool_executor.py:64 — 线程池</text>
  <line x1="220" y1="222" x2="220" y2="244" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="60" y="248" width="320" height="40" rx="6" fill="#fffbeb" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="272" text-anchor="middle" font-size="10" fill="currentColor">每轮：json.loads(arguments) → pre_tool_call 钩子 → guardrail</text>
  <line x1="220" y1="288" x2="220" y2="310" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="220" y1="310" x2="420" y2="310" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="420" y1="310" x2="420" y2="328" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="220" y="332" width="400" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="420" y="352" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">handle_function_call(name, args, task_id)　model_tools.py:731</text>
  <text x="420" y="368" text-anchor="middle" font-size="10" fill="#64748b">① coerce_tool_args(:758)　② 插件 block 检查　③ dispatch</text>
  <line x1="420" y1="382" x2="420" y2="404" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="220" y="408" width="400" height="46" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="420" y="428" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">registry.dispatch("read_file", {...})　tools/registry.py:390</text>
  <text x="420" y="444" text-anchor="middle" font-size="10" fill="#64748b">get_entry("read_file") → ToolEntry.handler</text>
  <line x1="420" y1="454" x2="420" y2="476" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="240" y="480" width="360" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="420" y="500" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">handler = _handle_read_file　← 选定</text>
  <text x="420" y="515" text-anchor="middle" font-size="10" fill="#64748b">tools/file_tools.py:1122</text>
</svg>
<span class="figure-caption">图 T12.1 ｜ 工具调度链：并行判定分流到串行/并行执行器，单调用经 handle_function_call 与 registry.dispatch 锁定 handler。</span>

<details>
<summary>ASCII 原版</summary>

```text
        conversation_loop.py:3256  _execute_tool_calls(...)
              │
              ▼
        run_agent.py:3761  _should_parallelize_tool_batch(tool_calls)?
              │
        ┌─────┴───────────────────────────────┐
        │ len<=1 / 有危险工具 / 路径重叠 → False │ 多调用 + 全并行安全 + 路径不冲突 → True
        ▼                                      ▼
   _execute_tool_calls_sequential          _execute_tool_calls_concurrent
   (tool_executor.py:474)                  (tool_executor.py:64,线程池)
        │  ← 本例走这条(只有一个 read_file)
        ▼
   每轮: json.loads(arguments) → pre_tool_call 钩子 → guardrail
        │
        ▼
   model_tools.py:731  handle_function_call(name, args, task_id)
        │  ① coerce_tool_args(:758)  ② 插件 block 检查  ③ dispatch
        ▼
   tools/registry.py:390  registry.dispatch("read_file", {...})
        │  get_entry("read_file") → ToolEntry.handler
        ▼
   handler = tools/file_tools.py:1122  _handle_read_file   ← 选定!
```

</details>

走到这一步,本例的 `read_file` 已经走完判定(串行)、参数已 `coerce`、`task_id` 已就位、`registry.dispatch` 已锁定 `_handle_read_file` 这个 handler。下一步,这个 handler 真正去读 `README.md`。

## 6. 代码位置

按阅读顺序:

- 调度总入口:`run_agent.py:3749` —— `_execute_tool_calls`;并行判定调用点 `:3761`。
- 并行判定:`agent/tool_dispatch_helpers.py:103` —— `_should_parallelize_tool_batch`;路径冲突 `_paths_overlap` 在 `:166`,作用域路径提取 `_extract_parallel_scope_path` 在 `:149`。
- 串行执行器:`agent/tool_executor.py:474` —— `execute_tool_calls_sequential`(本例走这条)。
- 并行执行器:`agent/tool_executor.py:64` —— `execute_tool_calls_concurrent`(线程池)。
- 工具统一调度器:`model_tools.py:731` —— `handle_function_call`;类型强转 `:758`,`registry.dispatch` 调用在 `:807` / `:816`。
- 参数类型强转:`model_tools.py:535` —— `coerce_tool_args`。
- 注册表分发:`tools/registry.py:390` —— `ToolRegistry.dispatch`;`read_file` 的注册在 `tools/file_tools.py:1169`。

## 7. 分支与延伸

- 工具注册表、`ToolEntry` 结构、自动发现机制、并行/串行执行器的完整设计 → [第 5 章 工具系统](05-tool-system.md)。
- `registry._tools` 这张表是怎么在启动时被填满的 → [Trace 步骤 05](tour-05-tool-discovery.md)。
- 上一步:`tool_calls` 清单是怎么从 `response` 解析出来的 → [Trace 步骤 11](tour-11-parse-tool-call.md)。
- 下一步:选定的 `_handle_read_file` 真正执行,读 `README.md`、做路径与安全检查 → [Trace 步骤 13](tour-13-tool-execute.md)。
- 如果这一批是多个独立只读调用(`read_file` A + `read_file` B + `search_files` C),判定会返回 `True`,走线程池并行 → [第 5 章 §并行执行](05-tool-system.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 工具调度的第一道决定是 `_should_parallelize_tool_batch`(`tool_dispatch_helpers.py:103`)——**保守判定**:只有"多调用 + 全在并行安全白名单 + 路径互不重叠"才并行,否则一律串行。
2. 路径冲突由 `_paths_overlap`(`:166`)判定——逐段比较 `Path.parts`,一个是另一个前缀就算重叠;`terminal`/`patch` 这类副作用工具直接进 `_NEVER_PARALLEL_TOOLS`。
3. 单个工具调用统一走 `model_tools.py:731` 的 `handle_function_call`:先 `coerce_tool_args` 纠正参数类型(开放权重模型常把数字写成字符串)、再过 `pre_tool_call` 钩子、最后 `registry.dispatch`。
4. `registry.dispatch`(`tools/registry.py:390`)是**注册表查找**而非 `if/elif`——按工具名取 `ToolEntry.handler`;这让约 79 个内置工具 + 运行时动态注册的 MCP/插件工具都能被同一段调度代码处理。
5. 本例只有一个 `read_file` 调用 → 命中 `len<=1` 直接串行 → `handle_function_call` → `dispatch` 锁定 `tools/file_tools.py:1122` 的 `_handle_read_file`。

---

下一步:[Trace 步骤 13 —— read_file 真正读文件时发生了什么?](tour-13-tool-execute.md)
