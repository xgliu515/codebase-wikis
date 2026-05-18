# 第 02 章：前端语言 SGLang DSL

> commit: sgl-project/sglang@6ccc5b807（2026-05-17）

## 目录

1. [DSL 是什么：装饰器、原语与使用示例](#1-dsl-是什么装饰器原语与使用示例)
2. [中间表示（IR）：SglExpr 树](#2-中间表示irsglexpr-树)
3. [解释器：StreamExecutor 与 ProgramState](#3-解释器streamexecutor-与-programstate)
4. [后端抽象：Backend 接口与多种实现](#4-后端抽象backend-接口与多种实现)
5. [并行、分支与约束能力](#5-并行分支与约束能力)
6. [前端语言为何独立存在：协同设计的价值](#6-前端语言为何独立存在协同设计的价值)

---

## 1. DSL 是什么：装饰器、原语与使用示例

SGLang DSL 是一套嵌入 Python 的**领域特定语言（DSL）**，让用户以类似编写普通 Python 函数的方式描述多步 LLM 推理程序，同时自动获得前缀缓存、并行分支、结构化输出等运行时优化。

### 1.1 核心装饰器：`@sgl.function`

公共 API 全部集中在 `python/sglang/lang/api.py`。最核心的入口是 `function` 装饰器：

```python
# python/sglang/lang/api.py:23-32
def function(
    func: Optional[Callable] = None, num_api_spec_tokens: Optional[int] = None
):
    if func:
        return SglFunction(func, num_api_spec_tokens=num_api_spec_tokens)

    def decorator(func):
        return SglFunction(func, num_api_spec_tokens=num_api_spec_tokens)

    return decorator
```

`@sgl.function` 将一个 Python 函数包装为 `SglFunction` 对象（`python/sglang/lang/ir.py:141`）。`SglFunction` 不立即执行函数体，而是在 `.run()` 或 `.run_batch()` 被调用时才启动解释器。

函数的第一个参数**必须命名为 `s`**，代表程序状态对象（`ProgramState`），通过它访问对话角色和生成原语：

```python
import sglang as sgl

@sgl.function
def chain_of_thought(s, question):
    s.system("你是一个有帮助的助手。")
    s.user(question)
    with s.assistant():
        s += sgl.gen("reasoning", max_tokens=256, stop="\n---\n")
        s += "\n---\n最终答案："
        s += sgl.gen("answer", max_tokens=64)

# 运行：使用 RuntimeEndpoint 后端
backend = sgl.RuntimeEndpoint("http://localhost:30000")
state = chain_of_thought.run(
    question="SGLang 的核心创新是什么？",
    backend=backend
)
print(state["answer"])
```

### 1.2 生成原语

| 原语 | API 位置 | 说明 |
|---|---|---|
| `sgl.gen(name, ...)` | `api.py:75-100` | 调用模型生成，结果存储到 `name` 变量 |
| `sgl.select(name, choices, ...)` | `api.py` | 从候选列表中选择最高概率的选项 |
| `s.system(text)` | `interpreter.py:873` | 标记 system 角色消息 |
| `s.user(text)` | `interpreter.py:876` | 标记 user 角色消息 |
| `s.assistant(text)` | `interpreter.py:879` | 标记 assistant 角色消息 |
| `s += "text"` | `ir.py:336-342` | 追加常量文本到当前上下文 |
| `s.fork(n)` | `interpreter.py:888-896` | 并行分支执行 |

`sgl.gen()` 返回一个 `SglGen` 节点（IR 节点），不是字符串，不会立即触发 LLM 调用。真正的调用发生在 `StreamExecutor._execute_gen()` 中。

`sgl.select()` 底层使用 token 概率比较（`python/sglang/lang/choices.py`），在受约束的候选集上执行 forward pass，选择联合概率最高的序列。

### 1.3 角色标记

`s.system()`、`s.user()`、`s.assistant()` 既可以接受一个表达式参数（直接传入），也可以作为上下文管理器（`with s.user():`）使用：

```python
# 两种等价写法
s.system("你是助手。")

with s.user():
    s += "请解释 "
    s += sgl.image("/path/to/img.jpg")
    s += "这张图片。"
```

角色标记在解释器中会生成 `SglRoleBegin` / `SglRoleEnd` IR 节点，最终由 Backend 的 chat template 转化为对应的特殊 token 序列。

---

## 2. 中间表示（IR）：SglExpr 树

DSL 程序在执行前会被"解释执行"——每个原语调用都会构造一个 `SglExpr` 子类对象，并通过 `StreamExecutor.submit()` 提交到执行队列。`SglExpr` 是所有 IR 节点的基类：

```python
# python/sglang/lang/ir.py:327-359
class SglExpr:
    node_ct = 0

    def __init__(self):
        self.node_id = SglExpr.node_ct
        self.prev_node = None   # 链式前驱节点
        self.pid = None
        SglExpr.node_ct += 1

    def __add__(self, other):   # s += expr 语法糖
        ...
        return self.concatenate_ir(self, other)
```

### 2.1 主要 IR 节点类型

| 类名 | 文件:行号 | 含义 |
|---|---|---|
| `SglConstantText` | `ir.py:506` | 常量字符串，追加到上下文 |
| `SglGen` | `ir.py:451` | 模型生成节点，携带 `SglSamplingParams` |
| `SglSelect` | `ir.py:533` | 多选一节点，候选列表 + 选择方法 |
| `SglRoleBegin` | `ir.py:515` | 角色开始标记 |
| `SglRoleEnd` | `ir.py:524` | 角色结束标记 |
| `SglImage` | `ir.py:434` | 图片节点（多模态） |
| `SglVideo` | `ir.py:442` | 视频节点（多模态） |
| `SglExprList` | `ir.py:397` | 节点列表，用于 `__add__` 拼接 |
| `SglFork` | `ir.py` | 并行分支节点 |
| `SglCommitLazy` | `ir.py` | 强制同步延迟的上下文（fork 前） |
| `SglConcateAndAppend` | `ir.py` | 并行 KV Cache 拼接（批量前缀缓存） |

### 2.2 IR 树的构建

用户编写 `@sgl.function` 函数时，并不显式构建 IR 树——解释器**即时执行（eager execution）**，每当 Python 代码执行到一个 DSL 原语，就构造对应的 `SglExpr` 节点并提交给 `StreamExecutor`。

```text
用户代码执行顺序：
  s.system("…")          → 提交 SglRoleBegin("system")
                          → 提交 SglConstantText("…")
                          → 提交 SglRoleEnd("system")
  s.user(question)       → 提交 SglRoleBegin("user") + SglArgument + SglRoleEnd
  s += sgl.gen("ans")   → 提交 SglGen(name="ans", sampling_params=...)
```

这与 TensorFlow 1.x 的"先建图后执行"不同，SGLang DSL 采用 eager 模式，与 PyTorch 的使用习惯一致，对调试友好。

### 2.3 采样参数：`SglSamplingParams`

每个 `SglGen` 节点携带一个 `SglSamplingParams` 对象（`python/sglang/lang/ir.py:17-62`），包含 `max_new_tokens`、`temperature`、`top_p`、`regex`、`json_schema` 等所有采样控制参数。`SglSamplingParams` 提供了多个后端适配方法：

```python
# python/sglang/lang/ir.py:121-138
def to_srt_kwargs(self):
    return {
        "max_new_tokens": self.max_new_tokens,
        "regex": self.regex,
        "json_schema": self.json_schema,
        ...
    }

def to_openai_kwargs(self):
    # OpenAI 不支持 top_k 和 regex，会自动忽略
    ...
```

这意味着同一套 DSL 程序，切换到 OpenAI 后端时，`regex` 约束会静默忽略，不报错；切换到 SRT 后端时则完整支持。

---

## 3. 解释器：StreamExecutor 与 ProgramState

### 3.1 程序启动：`run_program()`

`SglFunction.run()` 调用 `python/sglang/lang/interpreter.py:57-90` 的 `run_program()`：

```python
# python/sglang/lang/interpreter.py:57-90
def run_program(program, backend, func_args, func_kwargs, default_sampling_para, stream, ...):
    if hasattr(backend, "endpoint"):
        backend = backend.endpoint
    stream_executor = StreamExecutor(
        backend, func_kwargs, default_sampling_para,
        chat_template=None, stream=stream, ...
    )
    state = ProgramState(stream_executor)

    if stream:
        t = threading.Thread(target=run_internal, args=(state, program, ...))
        t.start()
        return state          # 立即返回，调用方可迭代流式输出
    else:
        run_internal(state, program, func_args, func_kwargs, sync=False)
        return state
```

非流式模式下，`run_internal()` 在当前线程同步执行函数体；流式模式下，函数体在后台线程执行，主线程可通过 `state.text_iter()` 或 `state["var_name"]` 等待并获取结果。

### 3.2 StreamExecutor：执行引擎

`StreamExecutor`（`python/sglang/lang/interpreter.py:274`）是解释器的核心，职责：

- 维护当前对话上下文（`text_`、`messages_`）和已生成的变量（`variables`）
- 将收到的 `SglExpr` 节点路由到对应的 `_execute_*` 方法
- 通过 Worker 线程（`threading.Thread`）实现流式异步执行
- 对并行分支（`fork`）进行上下文复制

**Worker 线程模型**：

<svg viewBox="0 0 620 304" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DSL producer-consumer model: main thread submits, worker thread executes">
<defs>
<marker id="r2ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="20" y="16" width="260" height="28" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="150" y="35" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">主线程（用户代码）</text>
<rect x="340" y="16" width="260" height="28" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
<text x="470" y="35" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Worker 线程（StreamExecutor）</text>
<line x1="150" y1="44" x2="150" y2="290" stroke="#cbd5e1" stroke-width="1.2"/>
<line x1="470" y1="44" x2="470" y2="290" stroke="#cbd5e1" stroke-width="1.2"/>
<line x1="150" y1="68" x2="466" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar)"/>
<text x="300" y="62" text-anchor="middle" font-size="10" fill="#64748b">submit(SglConstantText) → queue.put</text>
<line x1="150" y1="96" x2="466" y2="96" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r2ar)"/>
<text x="300" y="90" text-anchor="middle" font-size="10" fill="#64748b">submit(SglGen) → queue.put（零成本）</text>
<rect x="360" y="116" width="220" height="78" rx="6" fill="#f0fdf4" stroke="#0d9488" stroke-width="1.2"/>
<text x="470" y="135" text-anchor="middle" font-size="10" fill="currentColor">_execute(ConstantText) → fill</text>
<text x="470" y="153" text-anchor="middle" font-size="10" fill="currentColor">_execute(SglGen) → gen</text>
<text x="470" y="171" text-anchor="middle" font-size="10" fill="#ea580c">backend.generate()【阻塞 IPC】</text>
<text x="470" y="187" text-anchor="middle" font-size="10" fill="#64748b">set variable_event["ans"]</text>
<line x1="150" y1="226" x2="466" y2="226" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r2ar)"/>
<text x="300" y="220" text-anchor="middle" font-size="10" fill="#64748b">读 state["ans"] → event.wait()</text>
<line x1="470" y1="258" x2="154" y2="258" stroke="#16a34a" stroke-width="1.3" marker-end="url(#r2ar)"/>
<text x="300" y="252" text-anchor="middle" font-size="10" fill="#16a34a">event 就绪 → 返回生成结果</text>
<text x="310" y="285" text-anchor="middle" font-size="10" fill="#94a3b8">文本追加零成本，只有 SglGen 才真正触发 IPC 调用</text>
</svg>
<span class="figure-caption">图 R2.1 ｜ DSL 的生产者-消费者模型：主线程提交表达式入队，Worker 线程异步执行，读变量时才阻塞等待</span>

<details>
<summary>ASCII 原版</summary>

```text
主线程（用户代码）          Worker 线程（StreamExecutor）
    │                              │
    │ submit(SglConstantText)  ──► queue.put(expr)
    │ submit(SglGen)           ──► queue.put(expr)
    │ ...                          │
    │                              │ _execute(SglConstantText) → _execute_fill()
    │                              │ _execute(SglGen)          → _execute_gen()
    │                              │   → backend.generate()    [阻塞网络/IPC调用]
    │                              │   → set variable_event["ans"]
    │                              │
    │ state["ans"]             ──► variable_event["ans"].wait()
    │ ◄── 返回生成结果               │
```

</details>

这种生产者-消费者模型使得 DSL 程序的文本追加（`s += "..."`）是零成本的——只有 `SglGen` 节点才会真正触发网络/IPC 调用。

### 3.3 `_execute()` 分发逻辑

`StreamExecutor._execute()`（`python/sglang/lang/interpreter.py:461-503`）是一个大型 `isinstance` 分发器：

```python
# python/sglang/lang/interpreter.py:461-503（节选）
def _execute(self, other):
    if isinstance(other, SglConstantText):
        self._execute_fill(other.value)
    elif isinstance(other, SglGen):
        self._execute_gen(other)
    elif isinstance(other, SglSelect):
        self._execute_select(other)
    elif isinstance(other, SglRoleBegin):
        self._execute_role_begin(other)
    elif isinstance(other, SglRoleEnd):
        self._execute_role_end(other)
    elif isinstance(other, SglImage):
        self._execute_image(other)
    elif isinstance(other, SglConcateAndAppend):
        if global_config.enable_parallel_encoding and self.backend.support_concate_and_append:
            self._execute_concatenate_and_append_kv_cache(other)
        else:
            self._execute_concatenate_and_append_text(other)
    ...
```

`SglConcateAndAppend` 的双路分发是一个重要的设计点：当 Backend 支持并行编码时（SRT 运行时支持），可以将多段前缀的 KV Cache 直接在 GPU 上拼接，无需将 token 序列传回 CPU 再重新 encode；对于 OpenAI 等外部 Backend，则退化为简单的文本拼接。

### 3.4 ProgramState：用户可见的状态对象

`ProgramState`（`python/sglang/lang/interpreter.py:852`）是 `@sgl.function` 函数体接收的 `s` 参数的类型：

```python
# python/sglang/lang/interpreter.py:852-880
class ProgramState:
    def __init__(self, stream_executor: StreamExecutor):
        self.stream_executor = stream_executor

    def system(self, expr=None):
        return self._role_common("system", expr)

    def user(self, expr=None):
        return self._role_common("user", expr)

    def assistant(self, expr=None):
        return self._role_common("assistant", expr)

    def fork(self, size=1, position_ids_offset=None):
        stream_executors = self.stream_executor.fork(size, ...)
        states = [ProgramState(x) for x in stream_executors]
        state_group = ProgramStateGroup(states, self)
        return state_group
```

`ProgramState` 是 `StreamExecutor` 的轻量包装，提供面向用户的、语义化的 API，而 `StreamExecutor` 处理底层执行细节。

### 3.5 变量访问与流式迭代

生成完成后，可以通过 `state["var_name"]` 访问命名变量，底层等待 `variable_event[name]` 被 set：

```python
# python/sglang/lang/interpreter.py:354-357
def get_var(self, name):
    if name in self.variable_event:
        self.variable_event[name].wait()   # 阻塞直到该变量生成完毕
    return self.variables[name]
```

流式访问通过 `state.text_iter(var_name)` 实现，利用 `stream_text_event` / `stream_var_event` 逐步产出已生成的文本片段。

---

## 4. 后端抽象：Backend 接口与多种实现

### 4.1 BaseBackend 接口

`python/sglang/lang/backend/base_backend.py` 定义了所有 Backend 必须实现的接口，核心方法：

| 方法 | 含义 |
|---|---|
| `generate(executor, sampling_params)` | 执行单次文本生成 |
| `select(executor, choices, temperature)` | 执行选择任务 |
| `get_chat_template()` | 返回对话模板 |
| `cache_prefix(prefix_str)` | 预热前缀 KV Cache |
| `end_program(executor)` | 清理会话 |

### 4.2 RuntimeEndpoint：连接 SRT 服务器

`python/sglang/lang/backend/runtime_endpoint.py:26`，通过 HTTP 请求与运行中的 SRT 服务器通信：

```python
# python/sglang/lang/backend/runtime_endpoint.py:26-54
class RuntimeEndpoint(BaseBackend):
    def __init__(self, base_url, api_key=None, ...):
        self.support_concate_and_append = True  # 支持并行 KV Cache 拼接
        self.base_url = base_url
        res = http_request(self.base_url + "/get_model_info", ...)
        self.model_info = res.json()
        self.chat_template = get_chat_template_by_model_path(
            self.model_info["model_path"]
        )
```

`support_concate_and_append = True` 意味着 `StreamExecutor` 在遇到 `SglConcateAndAppend` 节点时会调用 SRT 的高效 KV Cache 拼接路径，而非退化为文本拼接。

`RuntimeEndpoint.generate()` 调用 `/generate` 接口，而非 OpenAI 的 `/v1/completions`，可以传递 `regex`、`json_schema` 等 SRT 原生参数。

### 4.3 其他 Backend 实现

| Backend 文件 | 目标服务 | 支持约束生成 |
|---|---|---|
| `runtime_endpoint.py` | SRT 服务器（本地/远程） | 完整支持（regex、json_schema） |
| `openai.py` | OpenAI API | 部分支持（json_schema via response_format，无 regex） |
| `anthropic.py` | Anthropic Claude API | 不支持 regex |
| `vertexai.py` | Google Vertex AI | 不支持 regex |
| `litellm.py` | LiteLLM 代理 | 不支持 regex |
| `crusoe.py` | Crusoe Cloud | 不支持 regex |

后端切换只需在 `SglFunction.run()` 时传入不同的 `backend` 参数，或通过 `sgl.set_default_backend()` 全局设置：

```python
# api.py:49-51
def set_default_backend(backend: BaseBackend):
    global_config.default_backend = backend
```

### 4.4 Engine 后端：进程内直接调用

除了通过 HTTP 连接的 `RuntimeEndpoint`，还可以直接使用 `Engine` 对象作为后端：

```python
# python/sglang/lang/api.py:42-46
def Engine(*args, **kwargs):
    from sglang.srt.entrypoints.engine import Engine
    return Engine(*args, **kwargs)
```

`Engine` 对象同样实现了 `BaseBackend` 接口（或通过 `endpoint` 属性暴露），`run_program()` 中的 `if hasattr(backend, "endpoint"): backend = backend.endpoint` 逻辑就是为此设计的。这允许在同一 Python 进程内直接调用 SRT 推理引擎，绕过 HTTP 网络栈。

---

## 5. 并行、分支与约束能力

### 5.1 `fork()`：并行分支执行

`ProgramState.fork(n)` 创建 `n` 个独立的子执行器，每个子执行器继承当前状态（`text_`、`variables_`、`messages_`），但之后的生成相互独立：

```python
# python/sglang/lang/interpreter.py:370-402
def fork(self, size=1, position_ids_offset=None):
    if size > 1 and str(self.text_):
        self.submit(SglCommitLazy())   # 确保公共前缀已发送到 backend
    self.sync()
    size = int(size)

    exes = [StreamExecutor(self.backend, ...) for _ in range(size)]
    for i in range(size):
        exes[i].variables = dict(self.variables)
        exes[i].text_ = str(self.text_)
        exes[i].fork_start_text_pos = len(self.text_)  # 记录分支点
        ...
    return exes
```

`fork_start_text_pos` 记录了分支发生时的文本长度，Backend 可以利用这个信息，将公共前缀部分的 KV Cache 在所有分支间共享（RadixAttention 的核心应用场景）。

典型用法：对同一问题并行生成多个候选答案，再用 `select()` 或自定义逻辑选出最优：

```python
@sgl.function
def multi_candidate(s, question):
    s.user(question)
    with s.assistant():
        forks = s.fork(4)           # 并行生成 4 个候选
        for f in forks:
            f += sgl.gen("answer", temperature=0.9)
        forks.join()
        s += forks[0]["answer"]     # 选择第一个（示例）
```

### 5.2 `select()`：约束选择

`sgl.select(name, choices)` 让模型从有限候选列表中选择最高概率的选项。实现位于 `python/sglang/lang/choices.py`，默认使用 `token_length_normalized` 方法——对每个选项计算 token 联合对数概率，按长度归一化后取最大值：

```python
# 示例
@sgl.function
def classify_sentiment(s, review):
    s.user(f"评价：{review}\n情感：")
    label = s.assistant(sgl.select("sentiment", choices=["正面", "负面", "中性"]))
```

`sgl.select()` 在底层调用 Backend 的 `select()` 方法，SRT Backend 会针对每个候选并发发送 forward pass 请求，然后比较结果。

### 5.3 约束生成（Regex / JSON Schema）

`sgl.gen()` 支持 `regex=` 和 `json_schema=` 参数，将生成输出约束在指定格式内：

```python
@sgl.function
def structured_output(s, text):
    s.user(f"从以下文本中提取信息：{text}")
    s.assistant(sgl.gen(
        "result",
        json_schema='''{
          "type": "object",
          "properties": {
            "name": {"type": "string"},
            "age": {"type": "integer"}
          }
        }'''
    ))
```

当使用 SRT Backend 时，这些参数会透传到 Scheduler 的约束解码模块（`python/sglang/srt/constrained/`），由 xgrammar 库或有限状态机（FSM）在 decode 时对 logits 进行掩码，确保输出满足约束。

`SglSamplingParams.to_srt_kwargs()` 负责将这些参数传递给 SRT 后端：

```python
# python/sglang/lang/ir.py:121-138
def to_srt_kwargs(self):
    return {
        ...
        "regex": self.regex,
        "json_schema": self.json_schema,
    }
```

### 5.4 批量运行：`run_batch()`

`SglFunction.run_batch(batch_kwargs)` 使用 `ThreadPoolExecutor` 并发执行同一程序的多个输入，默认线程数为 `max(96, cpu_count * 16)`：

```python
# python/sglang/lang/interpreter.py:93-181
def run_program_batch(program, backend, batch_arguments, ...):
    if global_config.enable_precache_with_tracing and len(batch_arguments) > 1:
        cache_program(program, backend)   # 预热公共前缀 KV Cache
    ...
    with ThreadPoolExecutor(num_threads) as executor:
        futures = [executor.submit(run_program, ...) for args in batch_arguments]
```

`cache_program()` 会先通过 tracer（`python/sglang/lang/tracer.py`）静态分析程序，提取公共前缀字符串，然后调用 `backend.cache_prefix()` 预热 RadixCache，使批量中所有请求都能命中前缀缓存。

### 5.5 与 RadixAttention 的协同关系

DSL 前缀缓存复用的设计不是偶然的——它与 SRT 运行时的 RadixAttention 深度协同：

```text
DSL 层（用户程序）                   SRT 层（RadixCache）
  │
  │ @sgl.function 中的公共前缀
  │（system prompt、few-shot examples）
  │
  ├─ run_batch() 批量执行         ──► cache_program() 预热前缀
  │                                   │
  │                                   ▼
  │                                   backend.cache_prefix(prefix_str)
  │                                   → POST /generate {prefix, sampling: max_new_tokens=0}
  │                                   → Scheduler 执行空生成，将 prefix KV 插入 RadixCache
  │
  ├─ fork() 并行分支              ──► 所有分支的公共前缀部分 KV Cache 已在树中
  │   fork_start_text_pos             Scheduler 在 match_prefix() 时直接命中
  │                                   只需为各分支独立的部分分配新 KV slot
  │
  └─ SglConcateAndAppend          ──► backend.concatenate_and_append_kv_cache()
      （并行编码多个前缀段）            在 GPU 上直接拼接两段 KV Cache，无需重新 tokenize
```

---

## 6. 前端语言为何独立存在：协同设计的价值

一个自然的问题是：既然 SGLang 提供了 OpenAI 兼容 API，为什么还需要独立的前端语言？原因在于协同设计带来的三类独特能力：

### 6.1 语义感知的批处理与缓存

普通 HTTP 客户端发送 `/v1/chat/completions` 时，每个请求是独立的 HTTP 连接，服务器无从知晓多个请求之间的前缀关系。DSL 的 `run_batch()` 在客户端层面就能：

1. 静态分析（tracing）提取所有输入共享的前缀
2. 主动预热（`cache_prefix()`）
3. 并发发送所有请求，保证前缀命中

这相当于把调度语义从服务器侧"提前"到了客户端，减少了重复计算。

### 6.2 多步交互中的流式控制

DSL 程序内部的多步生成（先生成 reasoning，再生成 answer）需要上一步的输出作为下一步的输入。在 HTTP 层面，这必须发送两个独立的请求。DSL 层的 `StreamExecutor` 在同一会话（`session_id = sid`）内复用上下文，Backend 可以利用这个信息避免重复 tokenize 和 KV Cache 重新计算。

### 6.3 约束生成的完整语义

`regex=` 和 `json_schema=` 这类约束参数在 OpenAI API 中要么不支持，要么支持有限（仅 `response_format`）。DSL 将这些参数作为一等公民设计，通过 `SglSamplingParams.to_srt_kwargs()` 直接映射到 SRT 内部的约束解码引擎，支持任意正则表达式约束，无需后处理或重试。

### 6.4 Backend 可替换性

将推理程序（"做什么"）与执行环境（"在哪执行"）分离，使得同一套业务逻辑可以：

- 用 SRT 本地推理做高吞吐批处理
- 切换到 OpenAI API 做快速原型验证
- 切换到 Anthropic 做 Claude 支持
- 在不同阶段混用不同 Backend

这种关注点分离是传统 HTTP-only 方案做不到的。

---

## 相关章节

- [第 01 章：架构总览与核心概念](01-architecture-overview.md)
- [第 03 章：HTTP 服务器与 OpenAI 兼容 API](03-http-server.md)
