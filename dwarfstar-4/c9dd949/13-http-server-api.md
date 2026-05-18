# 第 13 章：HTTP 服务器与 Agent API

> 代码版本：antirez/ds4@c9dd949（2026-05-18）  
> 相关章节：[第 14 章 磁盘 KV 缓存与会话持久化](14-disk-kv-cache.md) · [第 6 章 引擎会话](06-engine-session.md)

---

## 13.1 总体结构

`ds4_server.c`（约 15 600 行）是 ds4 与外部世界的唯一接口。它不是一个通用 HTTP 框架，而是一个针对"单模型、单会话"服务器场景深度裁剪的最小化实现。顶部注释（`ds4_server.c:4`）已经精准地描述了设计意图：

```c
/* OpenAI/Anthropic compatible local server.
 *
 * HTTP is intentionally simple: each client connection is handled by a small
 * blocking thread that parses one request, then queues a job to the single
 * Metal worker.  The worker owns the ds4_session and therefore owns all live KV
 * cache state.  That keeps session reuse, disk checkpointing, and future
 * batching decisions in one place instead of spreading graph mutations across
 * client threads. */
```

### 13.1.1 进程与线程模型

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4-server process and thread model: accept loop, client threads, and single Metal worker">
  <defs>
    <marker id="ar13-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="395" rx="8" fill="none" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ds4-server 进程</text>
  <rect x="280" y="45" width="200" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="64" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">accept loop</text>
  <text x="380" y="80" text-anchor="middle" font-size="11" fill="#64748b">主线程</text>
  <line x1="380" y1="91" x2="380" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar13-1)"/>
  <text x="390" y="108" font-size="10" fill="#94a3b8">每个连接</text>
  <rect x="180" y="116" width="400" height="110" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="136" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">client thread（每连接一个）</text>
  <text x="220" y="156" font-size="11" fill="#64748b">├── parse HTTP / JSON</text>
  <text x="220" y="173" font-size="11" fill="#64748b">├── 填充 job（栈上分配）</text>
  <text x="220" y="190" font-size="11" fill="#64748b">├── 入队 → server.queue</text>
  <text x="220" y="207" font-size="11" fill="#64748b">└── 等待 job.cv 信号</text>
  <line x1="580" y1="207" x2="640" y2="207" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="640" y1="207" x2="640" y2="340" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="580" y1="340" x2="640" y2="340" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar13-1)"/>
  <text x="648" y="278" font-size="10" fill="#94a3b8">job.cv</text>
  <rect x="180" y="248" width="400" height="138" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="268" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">Metal worker thread（单个）</text>
  <text x="220" y="288" font-size="11" fill="#64748b">├── 取出 job</text>
  <text x="220" y="305" font-size="11" fill="#64748b">├── generate_job()</text>
  <text x="248" y="320" font-size="11" fill="#64748b">│     ├── 前缀缓存决策</text>
  <text x="248" y="335" font-size="11" fill="#64748b">│     ├── ds4_session_sync</text>
  <text x="248" y="350" font-size="11" fill="#64748b">│     └── 生成 / 流式写</text>
  <text x="220" y="367" font-size="11" fill="#64748b">└── signal job.cv</text>
  <rect x="100" y="395" width="560" height="5" rx="0" fill="none"/>
  <text x="380" y="408" text-anchor="middle" font-size="11" fill="#64748b">worker 独占 ds4_session 与磁盘 KV 缓存</text>
</svg>
<span class="figure-caption">图 R13.1 ｜ ds4-server 进程线程模型：accept loop 派生 client 线程入队，单 Metal worker 顺序执行并通过 job.cv 回信</span>

<details>
<summary>ASCII 原版</summary>

```
┌─────────────────────────────────────────────────────────────┐
│  ds4-server 进程                                             │
│                                                             │
│  accept loop (主线程)                                       │
│       │                                                     │
│       │ 每个连接                                            │
│       ▼                                                     │
│  client thread (每连接一个)                                  │
│    ├── parse HTTP / JSON                                    │
│    ├── 填充 job（栈上分配）                                  │
│    ├── 入队 → server.queue                                  │
│    └── 等待 job.cv 信号  ────┐                              │
│                              │                              │
│  Metal worker thread (单个)  │                              │
│    ├── 取出 job              │                              │
│    ├── generate_job()        │                              │
│    │     ├── 前缀缓存决策    │                              │
│    │     ├── ds4_session_sync│                              │
│    │     └── 生成 / 流式写   │                              │
│    └── signal job.cv ────────┘                              │
│                                                             │
│  worker 独占 ds4_session 与磁盘 KV 缓存                     │
└─────────────────────────────────────────────────────────────┘
```

</details>

这种设计的核心约束是：**KV 缓存状态的所有权永远属于 worker**。client 线程只持有自己栈上的 `job` 结构，通过互斥量和条件变量等待 worker 完成。

### 13.1.2 Job 结构与所有权

`ds4_server.c:7659` 的注释明确说明 job 由 client 线程的栈持有：

```c
/* Jobs are stack-owned by the client thread.  The worker signals completion
 * after the response has been written, so request data and the socket remain
 * valid without heap-allocating per-request job objects. */
struct job {
    int fd;
    request req;
    bool done;
    pthread_mutex_t mu;
    pthread_cond_t cv;
    job *next;
};
```

栈所有权消除了 per-request 堆分配，并且因为 client 线程在 `job.cv` 上等待，socket fd 和请求数据在整个生命周期内保持有效，不需要引用计数。

### 13.1.3 引擎与会话的关系

<svg viewBox="0 0 640 180" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine owns read-only model weights, ds4_session owns mutable KV state, accessed exclusively by Metal worker thread">
  <defs>
    <marker id="ar13-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="20" width="220" height="54" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="140" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ds4_engine</text>
  <text x="140" y="62" text-anchor="middle" font-size="11" fill="#64748b">只读模型权重（mmap 后端）</text>
  <line x1="140" y1="74" x2="140" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar13-2)"/>
  <rect x="30" y="105" width="220" height="54" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="140" y="129" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">ds4_session</text>
  <text x="140" y="147" text-anchor="middle" font-size="11" fill="#64748b">可变 KV 状态</text>
  <line x1="260" y1="132" x2="340" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar13-2)"/>
  <text x="295" y="124" text-anchor="middle" font-size="10" fill="#94a3b8">独占</text>
  <rect x="340" y="105" width="270" height="54" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="475" y="129" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">Metal worker 线程</text>
  <text x="475" y="147" text-anchor="middle" font-size="11" fill="#64748b">唯一可修改 session 的执行单元</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ 引擎与会话所有权关系：ds4_engine 持有只读权重，ds4_session 持有可变 KV 状态并由 Metal worker 独占访问</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_engine  ──  只读模型权重（mmap 后端）
    └── ds4_session  ──  可变 KV 状态
            └── 由 Metal worker 线程独占访问
```

</details>

`ds4.h` 中 `ds4_engine` 和 `ds4_session` 是两个不透明类型。`ds4_server.c` 中 `server` 结构持有各一个指针（`s->engine`，`s->session`），在整个进程生命周期内不重建。

### 13.1.4 --chdir / --working-directory 选项

`ds4_server.c:11790` 对应命令行选项 `--chdir DIR`。在 `main()` 的最开头（`ds4_server.c:11998`）执行 `chdir(cfg.chdir_path)`，确保 `metal/*.metal` 等运行时路径在模型加载之前就已正确解析。这是 git log 中 "Add ds4-server working-directory option"（ef0a490）引入的功能。README 中的典型用法：

```sh
./ds4-server --chdir /path/to/ds4 --ctx 100000 ...
```

---

## 13.2 三套 API 及其解析器

ds4-server 同时支持三套 HTTP API，共享同一个 worker 和同一个 ds4_session：

| API | 端点 | 主解析函数 |
|---|---|---|
| OpenAI chat completions | `POST /v1/chat/completions` | `parse_chat_request()` |
| Anthropic messages | `POST /v1/messages` | `parse_anthropic_request()` |
| Responses（Codex） | `POST /v1/responses` | `parse_responses_request()` |

### 13.2.1 选择性 JSON 解析器

三套解析器共享同一个设计哲学（`ds4_server.c:2603`）：

```c
/* The API parsers are intentionally selective JSON parsers: they keep only
 * fields that affect model semantics, rendering, streaming, or cache keys, and
 * skip extension fields.  The output is always a rendered DS4 chat/completion
 * prompt plus the small amount of protocol state needed to translate the reply. */
```

"跳过"的安全性来自有深度上限的递归跳过器（`ds4_server.c:287`）：

```c
/* The request parser only understands the API fields we use and skips the
 * rest.  Skipping is recursive because JSON values nest, so keep an explicit
 * ceiling: without it, a useless ignored field like {"x":[[[...]]]} can spend
 * the whole C stack before the request is rejected. */
#define JSON_MAX_NESTING 256
```

`json_skip_value_depth()` / `json_skip_array_depth()` / `json_skip_object_depth()` 三者构成了一个轻量级的递归 JSON 下降器，专门用于跳过未知字段，而不是构建任何树结构。

### 13.2.2 parsing 的输出

每套解析器的最终产物是一个 `request` 结构，包含：
- `request.prompt`：已分词的 DS4 chat 提示 token 序列
- `request.prompt_text`：已渲染的字节字符串（用于磁盘缓存键前缀匹配）
- `request.think_mode`：推理模式
- `request.stops`：停止序列列表
- 协议专有字段（如 `responses_live_call_ids`、`anthropic_live_call_ids`）

所有三套解析器最终都调用同一个 `generate_job()` 来执行。

---

## 13.3 工具调用：协议格式与 DSML

### 13.3.1 OpenAI 与 Anthropic 的工具格式差异

工具 schema 来自客户端，格式不同（`ds4_server.c:1532`）：

```c
/* OpenAI wraps tools as {"type":"function","function":{...}}. Anthropic sends
 * the function schema directly as {"name":...,"input_schema":...}. The DS4
 * prompt wants one raw function schema per line, so unwrap OpenAI tools and keep
 * already-direct schemas unchanged. Responses can additionally group tools in a
 * namespace item; those are flattened for DSML prompt rendering while preserving
 * their client-facing name and namespace for response output. */
```

`parse_tools_value()` 在 `ds4_server.c:1538` 实现了三路拆解：OpenAI `{"type":"function","function":{...}}` 被拆出内部函数体；Anthropic `{"name":...,"input_schema":...}` 直接保留；Responses 的 namespace 工具被展开为多个函数 schema，同时保留原始 namespace 信息以便在响应输出时还原。

### 13.3.2 Anthropic 的 block 结构解析

Anthropic 请求的消息体是 block 数组，而不是平坦字符串（`ds4_server.c:1671`）：

```c
/* Anthropic content is block-structured, while the engine consumes one compact
 * chat_msg per role.  Parsing collapses text/thinking into strings, converts
 * assistant tool_use blocks to tool_calls, and keeps tool_result blocks as
 * escaped text because DS4 sees tool results in its chat template. */
```

`parse_anthropic_content_block()` 在 `ds4_server.c:1675` 处理以下 block 类型：
- `"type":"text"` → 追加到 `msg.content`
- `"type":"thinking"` → 追加到 `msg.reasoning`
- `"type":"tool_use"` → 转为 `tool_call`（含 `id`、`name`、`input`）
- `"type":"tool_result"` → 保留为带 `<tool_result>` 标签的转义文本

### 13.3.3 DSML：模型生成的工具调用文本格式

模型不直接输出 JSON，而是输出一种 XML-ish 标记语言，称为 DSML（DeepSeek Markup Language）。服务器在 prompt 渲染时注入 DSML 说明（`ds4_server.c:1999`），要求模型产出如下格式：

```xml
<｜DSML｜tool_calls>
<invoke name="bash">
<parameter name="command" string="true">ls /tmp</parameter>
</invoke>
</｜DSML｜tool_calls>
```

DSML 的特殊字符需要转义（`ds4_server.c:4260`）：

```c
/* The prompt renderer escapes DSML text so a tool argument can safely contain
 * shell operators or closing tags.  The generated-DSML parser must undo exactly
 * those entities before it turns parameters back into JSON; otherwise
 * parse->render is not a stable cache key. */
```

转义规则：`&` → `&amp;`，`<` → `&lt;`，`>` → `&gt;`，`"` → `&quot;`，`'` → `&apos;`。

### 13.3.4 DSML 参数到 JSON 的转换

模型产出的 DSML 通常是扁平的 `<parameter>` 列表（`ds4_server.c:4318`）：

```c
/* DSML produced by the model is usually a flat list of typed parameters:
 *
 *   <parameter name="path" string="true">/tmp/x</parameter>
 *   <parameter name="timeout" string="false">10</parameter>
 *
 * Long generations sometimes drift into a looser XML-ish shape, omitting the
 * outer string attribute and putting child parameters inside it.  The server
 * does not know client tool schemas, so it cannot make that semantically
 * perfect.  Still, returning a structured JSON value lets the client/tool layer
 * reject or repair the call, which is much better than aborting the assistant
 * turn and losing the whole sampled continuation. */
```

`dsml_parse_leaf_param_json()` 在 `ds4_server.c:4330` 中实现，每个 parameter 标签提取 `name` 和 `string` 属性，根据 `string="true"` 决定是否将值作为 JSON 字符串或原始 JSON 值输出。

### 13.3.5 工具调用内存（Tool Memory）

工具调用的核心持久化问题是：模型产出的 DSML 在下一轮请求被重新渲染为 JSON 时，客户端可能用不同的键顺序或空白格式，导致 token 不匹配，破坏 KV 缓存对齐。

解决方案是工具调用内存（`ds4_server.c:7671`）：

```text
生成时：为每个工具调用分配随机 ID，在 rax 树中存储 ID → 原始 DSML 块的映射
下轮请求时：客户端发回该 ID，服务器用 tool_memory 查找原始 DSML，
           逐字节重放到 prompt，保持 KV 缓存完全对齐
```

`tool_memory` 结构使用两棵 rax（基数树）：
- `by_id`：`tool_id → tool_memory_entry`
- `by_block`：`dsml_text → tool_memory_entry`（用于反向查找）

LRU 淘汰策略保持内存在 `DS4_TOOL_MEMORY_MAX_BYTES`（512 MiB）以内。

---

## 13.4 流式传输：翻译状态机

### 13.4.1 设计哲学

流式并不是把模型的原始输出直接发出——模型的输出包含 DSML 工具调用标签和 `<think>` 推理块，这些都需要在协议层面上翻译为对应的 SSE 事件格式（`ds4_server.c:4780`）：

```c
/* Streaming is a translation state machine over the raw DS4 text.  The model
 * may produce <think> and DSML tool blocks; clients should receive those as
 * protocol-native reasoning/tool deltas, never as visible assistant text. */
```

### 13.4.2 SSE 帧格式

基础的 SSE headers 在 `ds4_server.c:4783`，每帧以 `data: {...}\n\n` 格式发送，连接结束时发 `data: [DONE]\n\n`。

### 13.4.3 OpenAI 流式投影

`ds4_server.c:5038` 描述了 OpenAI 流式翻译的核心问题：

```c
/* OpenAI clients can consume function.arguments as a stream of JSON text
 * fragments.  DS4 generates XML-ish DSML instead, so this parser switches to a
 * hidden tool mode at <...tool_calls>, emits the tool header once the invoke tag
 * is complete, then translates each parameter body into argument deltas while
 * holding only tiny tails for partial closing tags, UTF-8, and DSML entities. */
```

OpenAI 工具调用流式：
1. 识别 `<｜DSML｜tool_calls>` 后切换到 tool 模式
2. `</invoke>` 结束后发送 `sse_chat_tool_call_start_delta()` 含工具名和 ID（`ds4_server.c:5043`）
3. parameter 体内容转换为 JSON 并发 `sse_chat_tool_call_args_delta_n()`（`ds4_server.c:5062`）

### 13.4.4 DSML 位置追踪器

流式需要实时知道当前 token 属于"可见文本"还是"工具调用内部结构"，以便决定发哪种 SSE 帧（`ds4_server.c:5344`）：

```c
/* Track where generation is inside a DSML tool call.  This is intentionally a
 * forgiving recognizer, not a validator: malformed DSML still gets parsed later
 * by the normal tool-call parser.  Here we only need enough state to decide
 * whether the next token belongs to protocol syntax or arbitrary payload. */
```

`dsml_decode_tracker` 是一个有限状态机，状态包括：
- `DSML_TRACK_SEARCH`：在原始文本中搜索工具调用起始标记
- `DSML_TRACK_STRUCTURAL`：在工具调用标签结构内
- `DSML_TRACK_STRING_BODY`：在 string 参数值体内
- `DSML_TRACK_JSON_PARAM`：在 JSON 参数体内（同时追踪字符串转义状态）
- `DSML_TRACK_DONE`：工具调用结束

`dsml_decode` 字段描述当前 token 的语义类别（`DSML_DECODE_OUTSIDE`、`DSML_DECODE_STRUCTURAL`、`DSML_DECODE_STRING_BODY`、`DSML_DECODE_JSON_STRUCTURAL`），流式发送器以此决定是否将 token 文本作为 argument delta 还是内部结构 token。

### 13.4.5 Anthropic 流式投影

Anthropic SSE 事件遵循 block 开/关语义（`ds4_server.c:6849`）：

```c
/* Anthropic streaming uses the same sampled DSML bytes that will later be
 * parsed and remembered for exact continuation.  This state is only a wire
 * projection: it turns an in-progress DSML block into content_block/tool_use
 * SSE events, and never rewrites the model-visible transcript or cache key. */
```

关键区别：Anthropic 的 thinking block 需要在关闭时附加 `signature_delta`（`ds4_server.c:7034`）：

```c
buf_printf(&b,
           "{\"type\":\"content_block_delta\",\"index\":%d,"
           "\"delta\":{\"type\":\"signature_delta\",\"signature\":",
           st->next_index);
json_escape(&b, id);
```

Anthropic 工具调用 delta 输出的是 JSON fragment，格式为 `input_json_delta`（`ds4_server.c:7007`）：

```c
/* Anthropic's input_json_delta carries a fragment of a JSON object, encoded as
 * a JSON string.  We stream exactly the same object that the final DSML parser
 * will build: an opening "{", quoted keys, raw JSON values or escaped string
 * contents, and the closing "}". */
```

### 13.4.6 Responses（Codex） 流式投影

Responses API 的流式逻辑在 `ds4_server.c:6423`：

```c
/* Responses streaming consumes the same raw token text the OpenAI live stream
 * consumes: <think>...</think> is reasoning, anything before the tool-call
 * marker is output text. Tool-call argument deltas are not surfaced because
 * Codex' SSE parser only ingests function_call items via output_item.done. */
```

Responses 流式的特殊点：工具调用参数 delta **不**流式发送——Codex 的 SSE 解析器只接受 `output_item.done` 类型的完整工具调用事件，中间的参数 fragment 直接丢弃。

---

## 13.5 渲染：追加语义尾部到 live KV

### 13.5.1 只追加语义尾部

`ds4_server.c:2338` 的注释描述了工具调用续写时渲染器的核心策略：

```c
/* Render only the semantic tail that must be appended to the live KV for a
 * tool-result continuation.
 *
 * In the common agent tool path, the previous assistant tool-call turn is
 * already in the model session, including hidden thinking and exact sampled
 * DSML.  The next request provides only the tool results, either as OpenAI
 * Responses tool-output items or Anthropic user content blocks.  Re-rendering
 * the assistant call here would duplicate it and destroy cache alignment, so
 * this function starts at the first new item and emits only:
 *
 *   previous EOS, tool results, and the next assistant prefix.
 *
 * This is intentionally independent from req.prompt's already-tokenized suffix */
```

`render_live_tool_tail()` 的输出是：

```
<｜end▁of▁sentence｜>
<｜User｜><tool_result>…</tool_result>…
<｜Assistant｜><think>  (或 </think> 如果 thinking 关闭)
```

### 13.5.2 Anthropic live tool 快速路径

Anthropic 的快速路径在 `ds4_server.c:2571`：

```c
/* Prepare the Anthropic live-tool fast path.
 *
 * Anthropic's visible replay normally includes the assistant tool_use JSON and
 * the user tool_result.  That replay is still only a description of what the
 * model sampled.  If the incoming tool_result IDs match the live sampled
 * frontier, generate_job() can skip replay matching entirely and append just
 * EOS + tool_result + next assistant prefix to the real KV. */
```

`anthropic_prepare_live_continuation()` 从最后一批 `tool_result` blocks 中收集 `tool_use_id`，生成对应的 `r->anthropic_live_suffix_text`。如果 worker 执行时这些 ID 仍然与 live 会话前沿匹配，则直接用这个 suffix 追加，跳过任何可见 history 的重新分词和前缀匹配。

---

## 13.6 执行一个请求：generate_job()

`generate_job()` 在 `ds4_server.c:10493` 是整个服务器的核心调度函数。它的注释描述了五级缓存查找策略：

```c
/* Execute one request on the worker-owned session.
 *
 * Clients resend full prompts as text.  The worker first tries the old exact
 * token-prefix hit, then a rendered-text prefix hit for the live checkpoint,
 * then disk text-prefix restart snapshots, then a cold prefill.  On text-prefix
 * hits we build a fresh effective prompt from the checkpoint's exact token
 * history plus a newly tokenized string suffix; the canonical full-prompt
 * tokens are not sliced because BPE may merge across the byte boundary. */
```

### 13.6.1 缓存查找的优先级

```text
1. Responses visible-prefix 续写（live KV + 可见文本前缀匹配）
   → ds4_server.c:9685

2. Responses tool-output-only 续写（live KV + call_id 精确匹配）
   → ds4_server.c:9620

3. Anthropic live tool 续写（live KV + tool_use_id 匹配）
   → ds4_server.c:9646

4. 无工具 thinking live 续写（live KV + thinking visible 前缀匹配）
   → ds4_server.c:9714

5. 精确 token 前缀命中（live session token 序列）

6. 磁盘 KV 文本前缀命中（SHA1 文件名查找）

7. 冷启动：完整 prefill
```

### 13.6.2 四种续写场景

#### tool-output-only（Responses）
`ds4_server.c:9620` — 客户端只发新工具输出，不重放 history。`call_id` 是唯一的 continuation binding。只要 live 前沿 token 数与记录一致，构建 `live_tokens + suffix_tokens` 作为 effective_prompt。

#### tool-result（Anthropic）
`ds4_server.c:9646` — 与 Responses 等价但用 `tool_use_id`。匹配成功时 `effective_prompt = live_tokens + anthropic_live_suffix_text`。

#### visible-replay（Responses）
`ds4_server.c:9672` — Codex 每次都带完整可见 history。服务器记录上次 live frontier 的可见文本，如果新 prompt 的文本以此为前缀，则从 live KV 继续，只需分词后缀字节。这对隐藏 reasoning 的恢复至关重要——visible replay 中没有 `<think>...</think>` 内容，但 live KV 里有。

#### tool-less thinking（`ds4_server.c:9714`）
无工具的 thinking 答复后，下一轮请求不重放隐藏 reasoning。服务器记录 visible transcript 作为 key，下一轮请求如果以此前缀开始，就复用包含隐藏 reasoning 的 live KV。

### 13.6.3 thinking 模式下旧 assistant reasoning 不重放

`ds4_server.c:10292` 的注释解释了为什么多轮 thinking 对话中旧 reasoning 被丢弃：

```c
/* In thinking mode without tools, old assistant reasoning is intentionally not
 * rendered back into later prompts.  The sampled live graph still contains the
 * reasoning bytes, so the next request would miss the session cache even though
 * the visible conversation prefix is logically the same.
 *
 *   prompt-without-final-<think> + </think> + visible-content + eos
 *
 * is exactly the visible prefix that render_chat_prompt_text() will produce on
 * the next turn.  Do not rebuild the KV cache to erase hidden reasoning here */
```

关键结论：重建 KV 缓存来消除隐藏 reasoning 不但慢，还会丢弃有价值的采样状态。正确做法是用 visible transcript 作为 key，通过 thinking-visible 续写机制复用 live KV。

### 13.6.4 工具调用结束后 live checkpoint 对齐

`ds4_server.c:10341` 的 `canonicalize_tool_checkpoint()` 确保工具调用完成后 live 状态与下一轮请求将要渲染的 canonical token 序列对齐：

```c
/* After a successful tool-call finish, make the live checkpoint match what the
 * next request will render.  Usually that is just the exact DSML remembered by
 * tool id.  If a client sends a tool call without an id we know, the fallback
 * renderer still builds valid DSML from JSON, and this function either rewrites
 * the short suffix in place or reloads an older disk checkpoint before replay. */
```

注意：Responses API 的 live continuation **不**调用 `canonicalize_tool_checkpoint()`，因为其 visible-prefix 机制已经能够从 live KV 直接续写（见 `misc/RESPONSE_API.md`）。

---

## 13.7 服务器配置要点

### 13.7.1 主要命令行选项

```sh
./ds4-server \
  -m gguf/model.gguf \
  --ctx 100000 \
  --kv-disk-dir /tmp/ds4-kv \
  --kv-disk-space-mb 8192 \
  --chdir /path/to/ds4 \
  --trace /tmp/ds4-trace.txt \
  --port 8080 \
  --cors \
  --mtp mtp.gguf --mtp-draft 2 \
  --think \
  --nothink
```

### 13.7.2 CORS 策略

CORS 默认关闭（`ds4_server.c` 的测试 `test_cors_headers_are_opt_in()`），必须通过 `--cors` 显式启用。这确保在默认本地部署场景下不意外暴露跨域 API。

### 13.7.3 MTP 推测解码

生成循环在 `ds4_server.c:10899` 判断是否启用 MTP：

```c
if (temperature <= 0.0f &&
    ds4_engine_mtp_draft_tokens(s->engine) > 1 &&
    getenv("DS4_MTP_SPEC_DISABLE") == NULL)
{
    ntok = ds4_session_eval_speculative_argmax(...);
}
```

只在温度为 0（greedy）且 `DS4_MTP_SPEC_DISABLE` 未设置时启用。

---

## 13.8 Responses API 的协议模型

（详见 `misc/RESPONSE_API.md`）

```text
live continuation 路径：
  call_id ──► live KV 前沿 ──► 追加 suffix ──► 继续生成
  (不证明 token 前缀，不重建 KV)

stateless replay 路径：
  full history ──► 渲染 prompt ──► token/text/disk 前缀匹配 ──► prefill suffix
```

Responses API 有两类关键 ID：
- `previous_response_id` / `conversation`：DS4 不实现（返回 HTTP 400）
- `call_id`：工具调用绑定，DS4 用于 live continuation

### 13.8.1 验证规则

- 未知 `call_id` 且 history 中没有对应的先前 function call → HTTP 400
- reasoning 模式下的 stateless replay 缺少 reasoning 项 → HTTP 400
- live state 已被替换时的 tool-output-only 请求 → HTTP 409

磁盘 KV 策略细节见 [第 14 章](14-disk-kv-cache.md)。
