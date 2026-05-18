# 第 12 章 MCP 集成与插件系统

到目前为止，本 wiki 讲的都是 Hermes「自带」的能力——内置工具、内置 provider、内置平台。但一个 agent 框架的生命力在于可扩展性：用户想接一个第三方服务、想加一个自定义工具、想换一种记忆后端，不应该被迫去改 Hermes 核心代码。本章讲两套互补的扩展机制——**MCP 集成**（接入开放标准的工具生态）和**插件系统**（在四个层级注入工具、平台、provider、引擎）。

---

## 12.1 两套扩展机制，为什么都需要

Hermes 提供两条扩展路径，它们解决的问题不同：

- **MCP（Model Context Protocol）** 是 Anthropic 推动的开放协议。一个 MCP server 用标准协议暴露一组工具，任何 MCP 客户端都能连上来用。Hermes 接入 MCP，意味着它能立刻使用整个 MCP 生态里别人写好的 server——不用为每个服务单独写适配。
- **插件系统** 是 Hermes 自己的扩展点。它比 MCP 更深——插件不仅能加工具，还能加消息平台、模型 provider、记忆后端、上下文引擎，并挂接生命周期 hook。代价是插件必须按 Hermes 的约定来写。

一句话区分：**MCP 让 Hermes 复用别人的生态，插件让别人深度定制 Hermes**。

而且 Hermes 在 MCP 上是双向的——它既是 MCP **客户端**（连别人的 server），也是 MCP **服务端**（把自己暴露给 Claude Desktop、Cursor 这些外部客户端）。

### MCP 协议要点速览

为了读懂后面几节，先简要交代 MCP 协议本身的几个概念——它们决定了 Hermes 的实现形态：

- **JSON-RPC 基底**。MCP 是基于 JSON-RPC 2.0 的双向协议。客户端和 server 互发请求/响应/通知。
- **三类资源**。server 可以暴露 Tools（可调用的工具）、Resources（可读的资源，按 URI 寻址）、Prompts（预置的提示模板）。Hermes 把后两类也包装成「工具型」入口（`list_resources` 等）。
- **初始化握手**。连接建立后第一件事是 `initialize`，双方交换 `protocolVersion` 和 `capabilities`——server 借此声明它支持哪些能力（是否支持 list_changed 通知、是否需要 sampling 等）。
- **通知**。除请求-响应外，server 可主动发通知，如 `notifications/tools/list_changed`（工具列表变了）。
- **反向请求**。最特别的是 sampling——server 可以反过来向客户端发 `sampling/createMessage` 请求，借客户端的 LLM 做补全。

这五点对应了 Hermes 实现里的五块：transport 层、`_register_server_tools` 的三类资源注册、`session.initialize()`、`_make_message_handler` 的通知处理、`SamplingHandler`。后面逐一展开。

## 12.2 MCP 客户端：连接外部 MCP server

代码在 `tools/mcp_tool.py`（约 3500 行）。模块 docstring 一句话概括职责：「Connects to external MCP servers via stdio, HTTP/StreamableHTTP, or SSE transport, discovers their tools, and registers them into the hermes-agent」registry。

### 三种 transport

MCP server 可以用三种方式跑，Hermes 都支持（`mcp_tool.py:51`–`52`）：

```text
stdio transport      —— server 是一个子进程，command + args 启动，
                        靠 stdin/stdout 通信。适合本地工具。
StreamableHTTP       —— server 是一个 HTTP 服务，url 指向它。默认远程 transport。
SSE transport        —— server 用 Server-Sent Events 协议（transport: sse）。
```

用户在 config 里声明一个 MCP server，Hermes 据 transport 类型建立连接，握手后**发现** server 暴露的工具，把每个工具动态注册进 `ToolRegistry`（见[第 5 章](05-tool-system.md)）——于是 MCP 工具和内置工具在 agent 眼里没有区别，都是可调用的工具。

### 连接生命周期：从配置声明到工具可调用

一个 MCP server 从「config 里的一行」变成「agent 能调的工具」，要走完一条完整的状态链。`MCPServerTask`（`mcp_tool.py:1012`）是承载这条链的对象——每个 server 对应一个长生命周期的 asyncio Task，跑在专用后台 event loop 上。

<svg viewBox="0 0 780 410" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP server connection lifecycle from config to ready">
  <defs>
    <marker id="r12ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="14" width="380" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="222" y="34" font-size="11" font-weight="700" fill="currentColor">配置声明</text>
  <text x="222" y="50" font-size="10" fill="#64748b">config.yaml 的 mcp_servers.&lt;name&gt; 一项</text>
  <line x1="390" y1="58" x2="390" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="160" y="72" width="460" height="48" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="182" y="92" font-size="11" font-weight="700" fill="currentColor">建立连接 ── 按 transport 分派 _run_stdio / _run_http</text>
  <text x="182" y="110" font-size="10" fill="#64748b">stdio: 过滤 env → OSV 检查 → 起子进程   ｜   http: 校验 URL → OAuth → 打开流</text>
  <line x1="390" y1="120" x2="390" y2="134" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="200" y="134" width="380" height="44" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="222" y="154" font-size="11" font-weight="700" fill="currentColor">协议握手 ── session.initialize()</text>
  <text x="222" y="170" font-size="10" fill="#64748b">交换 protocolVersion / capabilities，存 initialize_result</text>
  <line x1="390" y1="178" x2="390" y2="192" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="200" y="192" width="380" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="222" y="212" font-size="11" font-weight="700" fill="currentColor">工具发现 ── _discover_tools()</text>
  <text x="222" y="228" font-size="10" fill="#64748b">session.list_tools() 填充 server._tools</text>
  <line x1="390" y1="236" x2="390" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="200" y="250" width="380" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="222" y="270" font-size="11" font-weight="700" fill="currentColor">动态注册 ── _register_server_tools()</text>
  <text x="222" y="286" font-size="10" fill="#64748b">逐个转 schema 并注册进 ToolRegistry，toolset = mcp-&lt;name&gt;</text>
  <line x1="390" y1="294" x2="390" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="200" y="308" width="380" height="38" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="390" y="332" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">就绪 ── _ready.set()，工具对 agent 可见可调用</text>
  <line x1="390" y1="346" x2="390" y2="360" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar1)"/>
  <rect x="200" y="360" width="380" height="38" rx="6" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="390" y="384" font-size="11" fill="currentColor" text-anchor="middle">生命周期等待 ── 阻塞直到关停或重连请求</text>
</svg>
<span class="figure-caption">图 R12.1 ｜ 一个 MCP server 从 config 声明到工具可调用的连接生命周期状态链。</span>

<details>
<summary>ASCII 原版</summary>

```text
配置声明      config.yaml 的 mcp_servers.<name> 一项
   |          { command/url, transport, env, headers, oauth, tools.include/exclude, ... }
   v
建立连接      按 transport 分派 _run_stdio / _run_http        mcp_tool.py:1255 / 1336
   |          stdio: 过滤环境变量 -> OSV 恶意包检查 -> 启动子进程
   |          http : 校验 URL -> 构造 OAuth provider -> 打开 StreamableHTTP/SSE 流
   v
协议握手      session.initialize() 交换 protocolVersion / capabilities
   |          结果存入 initialize_result
   v
工具发现      _discover_tools() 调 session.list_tools()        mcp_tool.py:1491
   |          填充 server._tools（MCP 原生 Tool 对象列表）
   v
动态注册      _register_server_tools() 逐个转 schema 并注册     mcp_tool.py:3026
   |          注册进 ToolRegistry，toolset = "mcp-<name>"
   v
就绪          _ready.set()，工具对 agent 可见、可调用
   |
   v
生命周期等待  _wait_for_lifecycle_event() 阻塞直到关停或重连请求
```

</details>

`_discover_and_register_server()`（`mcp_tool.py:3134`）是单个 server 的「连接 + 发现 + 注册」一站式封装；`register_mcp_servers()`（`mcp_tool.py:3163`）则用 `asyncio.gather` 并行处理所有 server，外层套 120 秒总超时，避免某个慢 server 拖垮整个启动。`discover_mcp_tools()`（`mcp_tool.py:3258`）是给 `model_tools` 调的入口，在 `discover_builtin_tools()` 之后执行——这个顺序保证内置工具先占位，MCP 工具遇到同名冲突时让位。

### 动态注册的两个细节

`_register_server_tools()` 注册时有两层把关，都值得单独说：

1. **include/exclude 过滤**（`mcp_tool.py:3046`–`3060`）。config 的 `tools.include` 是白名单（只注册列出的），`tools.exclude` 是黑名单（注册除列出之外的），`include` 优先于 `exclude`，两者都不设则注册全部。这让用户能从一个工具很多的 server 里只挑需要的几个，减少塞进系统提示的 schema 体积。
2. **内置工具冲突保护**（`mcp_tool.py:3071`–`3079`）。注册前查 `registry.get_toolset_for_tool()`，如果同名工具已属于某个非 `mcp-` 开头的 toolset（即内置工具），就跳过该 MCP 工具并告警——内置工具永远优先，第三方 server 不能靠重名劫持。

除了普通工具，`_register_server_tools()` 还会按 server 的 capability 注册四个「工具型」入口：`list_resources` / `read_resource` / `list_prompts` / `get_prompt`——把 MCP 的 Resources 与 Prompts 能力也包装成可调用工具。最后 `register_toolset_alias()` 让用户既能用 `mcp-<name>` 也能用裸 server 名引用这一组工具。

### list_changed 动态刷新

MCP 协议允许 server 主动通知「我的工具列表变了」（`notifications/tools/list_changed`）。`_make_message_handler()`（`mcp_tool.py:1088`）安装的消息处理器收到这类通知后，`_schedule_tools_refresh()`（`mcp_tool.py:1081`）会调度一次 `_refresh_tools()`（`mcp_tool.py:1131`），重新 `list_tools()` 并走一遍 `_register_server_tools()`——所以 MCP 工具集不是启动时定死的，运行期可增删。

### 自动重连

网络会抖、子进程会崩。`mcp_tool.py:53` 列出的特性之一是「Automatic reconnection with exponential backoff (up to 5 retries)」——连接断了自动重连，退避时间指数增长。`run()`（`mcp_tool.py:1503`）是这个重连状态机的核心，几个常量定义在 `mcp_tool.py:260` 起：

```text
_DEFAULT_TOOL_TIMEOUT          = 120   工具调用超时（秒）
_DEFAULT_CONNECT_TIMEOUT       = 60    单 server 首次连接超时（秒）
_MAX_RECONNECT_RETRIES         = 5     运行期断连后的最大重连次数
_MAX_INITIAL_CONNECT_RETRIES   = 3     首次连接的最大重试次数
_MAX_BACKOFF_SECONDS           = 60    退避上限（秒）
```

`run()` 的循环逻辑要分两类失败处理：

- **首次连接失败**：还没成功连过，按 `_MAX_INITIAL_CONNECT_RETRIES`（3 次）退避重试；退避从 1 秒起，每次 `min(backoff*2, 60)`。
- **运行期断连**：已经连上过又掉线，按 `_MAX_RECONNECT_RETRIES`（5 次）重连；达到上限后该 server 标记为失败，但不影响其他 server。

退出循环还有两种「非失败」原因：`_shutdown_event` 被设置（正常关停），或 `_reconnect_event` 被设置——后者是「主动重连」信号，用于 OAuth token 刷新、session 过期、手动 `/mcp refresh` 等场景。重连时 `_ready` 标志会**保持置位**（`mcp_tool.py:1568`），这样重连窗口期内已发出的工具调用不会因为「server 未就绪」而失败，而是排队等新 session 建好。

`mcp_tool.py:501` 的 `InvalidMcpUrlError` 还专门处理一类情况：URL 本身就非法时，`_validate_remote_mcp_url()`（`mcp_tool.py:510`）在启动时一次性校验、提前报错，避免在重连退避循环里白白烧 5 次。`_handle_session_expired_and_retry()`（`mcp_tool.py:1981`）则识别「Invalid or expired session」这类错误——它不需要重新 OAuth，只要一次 transport 重连，于是直接 `call_soon_threadsafe` 设置 `_reconnect_event` 并把当次工具调用重试一次。

### 并发工具调用与 RPC 串行化

默认情况下，同一个 MCP server 的工具调用是**串行**的——`MCPServerTask` 持有一个 `_rpc_lock`（`mcp_tool.py:1057`），每次 `call_tool()` 和工具列表刷新都要先拿锁。原因是 MCP 的 JSON-RPC session 不保证能正确处理交错的并发请求，串行化是安全默认。

但有些 server 明确支持并发。config 里给某个 server 设 `supports_parallel_tool_calls: true`（`mcp_tool.py:27`），它的工具就被登记为「可并行」，`is_mcp_tool_parallel_safe()`（`mcp_tool.py:3307`）据此告诉 `run_agent` 的并行执行逻辑（见[第 3 章](03-conversation-loop.md)）：这个 server 的多个工具调用可以同时发。这是个**逐 server opt-in** 开关——不确定就别开，开了出问题先关掉它定位。

### 三种 transport 的连接细节

三种 transport 不只是「连法不同」，配置形态和连接细节各有讲究。

**stdio transport**（`_run_stdio`，`mcp_tool.py:1255`）。config 给 `command` + `args` + 可选 `env`，server 是个本地子进程。连接前要走三步：`_build_safe_env()` 过滤环境变量、`_resolve_stdio_command()`（`mcp_tool.py:402`）把裸 `npx`/`npm`/`node` 解析成绝对路径（因为子进程跑在被过滤的 PATH 下，找不到这些命令）、`check_package_for_malware()` 拿命令去 OSV 恶意包数据库比对，命中则拒绝启动。子进程的 stderr 被重定向到 `~/.hermes/logs/mcp-stderr.log`（`_get_mcp_stderr_log`），避免 FastMCP 的 banner、slack-mcp 的启动 JSON 直接打到用户 TTY 上把 TUI 弄乱。子进程 PID 会被快照记录（`_stdio_pids`），用于关停时强杀逃逸的孤儿进程。

**StreamableHTTP transport**（`_run_http`，`mcp_tool.py:1336`，默认远程 transport）。config 给 `url` + 可选 `headers`、`connect_timeout`、`ssl_verify`。连接时若 header 里没有 `mcp-protocol-version`，会自动补一个 `LATEST_PROTOCOL_VERSION`——有些 server 的 initialize 请求强制要这个 header。若 `auth_type` 为 `oauth`，会从 `MCPOAuthManager` 取一个 provider 注入（见 12.6）。

**SSE transport**（同样在 `_run_http` 里，`mcp_tool.py:1380` 起）。config 加 `transport: sse`。它和 StreamableHTTP 的关键区别是 `sse_read_timeout` 设成 300 秒而非默认的 60 秒——SSE server 常常在两个事件之间空闲数分钟，60 秒读超时会在第一段慢区间就把连接掐断（PR #5981 里 Supermemory on Cloudflare Workers 的 ~60s 空闲断连就是这个坑）。OAuth provider 同样会透传给 `sse_client`。

### 安全：环境变量白名单过滤

stdio transport 会 fork 一个子进程。如果把 Hermes 进程的全部环境变量原样传给它，那这个第三方 server 子进程就能读到你所有的 API key——这是个真实的泄露面。

`mcp_tool.py:296` 的 `_build_safe_env()` 解决这个。它不是「传全部」，而是只透传一个白名单 `_SAFE_ENV_KEYS`（`mcp_tool.py:267`）和所有 `XDG_` 前缀变量，再叠加用户在 config 里显式声明的 `env`：

```python
_SAFE_ENV_KEYS = frozenset({
    "PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "SHELL", "TMPDIR",
})

def _build_safe_env(user_env):
    env = {}
    for key, value in os.environ.items():
        if key in _SAFE_ENV_KEYS or key.startswith("XDG_"):
            env[key] = value
    if user_env:
        env.update(user_env)
    return env
```

逻辑是「默认拒绝」——白名单里只有运行环境必需的基础变量（路径、locale、终端），任何 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GITHUB_TOKEN` 都不在内，不会泄给子进程。如果某个 MCP server 确实需要某个密钥，用户必须在 config 的 `env` 字段里显式写出来——把「哪些密钥给哪个 server」变成一个明确的、可审计的决定，而不是默认全给。

### 安全：提示注入扫描与凭证脱敏

`mcp_tool.py:367` 的 `_scan_mcp_description()` 扫描 MCP server 自报的工具描述——因为工具描述会进系统提示，一个恶意 server 可以在描述里塞提示注入。它用 `_MCP_INJECTION_PATTERNS`（`mcp_tool.py:344`）里约 10 条正则匹配可疑模式：`ignore previous instructions`、`you are now a...`、`your new task is`、`system:` 前缀、`<system>` 角色标签、`do not tell/reveal`、描述里的 `curl https://`、`base64.b64decode`、`exec(`/`eval(`、`import subprocess` 等。命中只**告警不拦截**（WARNING 级），因为误报会直接搞坏合法 server——它是一道可观测性防线，不是硬门。

`_sanitize_error()`（`mcp_tool.py:315`）则保证 MCP server 的错误信息回流给 LLM 前先脱敏。它用 `_CREDENTIAL_PATTERN`（`mcp_tool.py:271`）匹配 GitHub PAT（`ghp_...`）、OpenAI 风格 key（`sk-...`）、`Bearer` token、以及 `token=` / `key=` / `password=` / `secret=` 这类查询串片段，统一替换成 `[REDACTED]`——防止 server 把凭证回显在错误里、再经由对话历史泄露。

### 后台 event loop 线程模型

MCP SDK 是 async 的（基于 anyio），Hermes 主循环是同步的（见[第 3 章](03-conversation-loop.md)）。这两者之间的边界，靠一个专用后台 event loop 线程跨越。`mcp_tool.py:64` 的 Architecture 注释把这套模型说得很清楚：

<svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP background event loop thread model bridging sync main thread and async SDK">
  <defs>
    <marker id="r12ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="40" width="320" height="260" rx="10" fill="#fed7aa" fill-opacity="0.4" stroke="#ea580c"/>
  <text x="190" y="62" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">主线程（同步）</text>
  <rect x="450" y="40" width="320" height="260" rx="10" fill="#0ea5e9" fill-opacity="0.1" stroke="#0ea5e9"/>
  <text x="610" y="62" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">MCP 后台线程（daemon, _mcp_loop）</text>
  <rect x="50" y="80" width="280" height="46" rx="6" fill="#fff" fill-opacity="0.6" stroke="#ea580c" stroke-opacity="0.5"/>
  <text x="64" y="100" font-size="11" font-weight="600" fill="currentColor">register_mcp_servers()</text>
  <text x="64" y="116" font-size="10" fill="#64748b">run_coroutine_threadsafe</text>
  <rect x="470" y="80" width="280" height="46" rx="6" fill="#fff" fill-opacity="0.6" stroke="#0ea5e9" stroke-opacity="0.5"/>
  <text x="484" y="100" font-size="11" font-weight="600" fill="currentColor">每个 MCPServerTask 常驻</text>
  <text x="484" y="116" font-size="10" fill="#64748b">持 transport 的 async with 不退出</text>
  <line x1="330" y1="103" x2="468" y2="103" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar2)"/>
  <rect x="50" y="142" width="280" height="46" rx="6" fill="#fff" fill-opacity="0.6" stroke="#ea580c" stroke-opacity="0.5"/>
  <text x="64" y="162" font-size="11" font-weight="600" fill="currentColor">工具调用 _make_tool_handler</text>
  <text x="64" y="178" font-size="10" fill="#64748b">把 call 协程调度上 loop</text>
  <rect x="470" y="142" width="280" height="46" rx="6" fill="#fff" fill-opacity="0.6" stroke="#0ea5e9" stroke-opacity="0.5"/>
  <text x="484" y="162" font-size="11" font-weight="600" fill="currentColor">session.call_tool() 执行</text>
  <text x="484" y="178" font-size="10" fill="#64748b">结果回填 Future</text>
  <line x1="330" y1="158" x2="468" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar2)"/>
  <line x1="468" y1="174" x2="332" y2="174" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar2)"/>
  <text x="400" y="148" font-size="9" fill="#64748b" text-anchor="middle">调度协程</text>
  <text x="400" y="190" font-size="9" fill="#64748b" text-anchor="middle">阻塞等 Future</text>
  <rect x="50" y="204" width="280" height="46" rx="6" fill="#fff" fill-opacity="0.6" stroke="#ea580c" stroke-opacity="0.5"/>
  <text x="64" y="224" font-size="11" font-weight="600" fill="currentColor">shutdown_mcp_servers()</text>
  <text x="64" y="240" font-size="10" fill="#64748b">给每个 Task 设 _shutdown_event</text>
  <rect x="470" y="204" width="280" height="74" rx="6" fill="#fff" fill-opacity="0.6" stroke="#0ea5e9" stroke-opacity="0.5"/>
  <text x="484" y="224" font-size="11" font-weight="600" fill="currentColor">在打开连接的同一 Task 里</text>
  <text x="484" y="240" font-size="10" fill="#64748b">退出 async with 清理</text>
  <text x="484" y="262" font-size="9" fill="#dc2626">anyio cancel-scope 清理必须在原 Task</text>
  <line x1="330" y1="227" x2="468" y2="227" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar2)"/>
</svg>
<span class="figure-caption">图 R12.2 ｜ MCP 后台 event loop 线程模型：同步主线程靠 run_coroutine_threadsafe 把协程投递给常驻 Task，跨越同步/异步边界。</span>

<details>
<summary>ASCII 原版</summary>

```text
主线程（同步）                  MCP 后台线程（daemon，跑 _mcp_loop）
   |                                   |
   | register_mcp_servers()            | 每个 MCPServerTask 是一个长生命周期
   |  _run_on_mcp_loop(...)  --------> | asyncio.Task，持有 transport 的
   |  run_coroutine_threadsafe         | "async with" 上下文不退出
   |                                   |
   | 工具调用（_make_tool_handler）     |
   |  把 call 协程调度上 loop --------> | session.call_tool() 执行
   |  阻塞等 Future 结果      <-------- | 结果回填 Future
   |                                   |
   | shutdown_mcp_servers()            | 给每个 Task 设 _shutdown_event，
   |                          --------> | 让它在「打开连接的同一个 Task」里
   |                                   | 退出 async with —— anyio cancel-scope
   |                                   | 的清理必须发生在原 Task，这是硬约束
```

</details>

为什么每个 server 要常驻一个 Task、而不是「用时连、用完断」?因为 transport 的 `async with` 上下文（stdio 子进程、HTTP 连接池、OAuth session）必须在打开它的同一个 Task 里维持和关闭——anyio 的 cancel scope 不允许跨 Task 清理。所以每个 `MCPServerTask` 在后台 loop 上是一个一直活着的协程，靠 `_wait_for_lifecycle_event()` 挂起，直到收到关停或重连信号。工具调用则用 `run_coroutine_threadsafe()` 把协程「投递」到这个 loop，主线程拿 Future 同步等结果。`_servers`、`_mcp_loop`、`_mcp_thread` 这些跨线程共享的状态都用 `_lock` 保护。

`_wait_for_lifecycle_event()`（`mcp_tool.py:1192`）还兼做 keepalive——对 HTTP server 定期发心跳探测连接活性，探测失败就设 `_reconnect_event` 主动触发重连。

### MCP sampling：server 反向请求 LLM

MCP 协议有个反向能力——server 可以请求**客户端**帮它做一次 LLM completion（`sampling/createMessage`）。这让 MCP server 不必自带模型凭证，借用客户端已有的 LLM 能力。Hermes 用 `SamplingHandler`（`mcp_tool.py:641`）实现这个回调，每个开启 sampling 的 `MCPServerTask` 配一个。

sampling 是把双刃剑——server 能借你的 LLM 额度跑任意 prompt，所以 `SamplingHandler` 有一整套约束，全部来自 config 的 `sampling` 段（`mcp_tool.py:40` 起的示例）：

```text
enabled          是否开启（默认 true）
model            覆盖用哪个模型
allowed_models   模型白名单（空 = 不限）
max_tokens_cap   单次请求 token 上限
max_rpm          每分钟请求数上限（_check_rate_limit）
max_tool_rounds  sampling 内部工具循环上限（0 = 禁用工具）
timeout          单次 LLM 调用超时
```

`__call__`（`mcp_tool.py:880`）是 SDK 回调入口：先 `_check_rate_limit()`（`mcp_tool.py:679`）查速率，再 `_resolve_model()`（`mcp_tool.py:691`）按白名单解析模型，`_convert_messages()`（`mcp_tool.py:711`）把 MCP 的消息格式转成 LLM provider 格式，调用辅助 LLM（见[第 7 章](07-model-providers.md)）后，`_build_text_result()` / `_build_tool_use_result()` 再把结果转回 MCP 格式。整个过程有审计日志（`log_level` 控制详细度）。

### 全景图：MCP 客户端连接 + 工具注册

把前面几节拼起来，一个 MCP server 从启动到工具可调用的完整路径如下：

<svg viewBox="0 0 800 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full MCP client connection and tool registration panorama">
  <defs>
    <marker id="r12ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="290" y="14" width="220" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="400" y="35" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">config.yaml · mcp_servers</text>
  <line x1="400" y1="46" x2="400" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="200" y="60" width="400" height="38" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="400" y="79" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">register_mcp_servers()</text>
  <text x="400" y="93" font-size="9" fill="#64748b" text-anchor="middle">asyncio.gather 并行处理所有 server</text>
  <line x1="400" y1="98" x2="400" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="200" y="112" width="400" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="131" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">每个 server: MCPServerTask.run()  ── 按 transport 分派</text>
  <line x1="300" y1="142" x2="150" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <line x1="400" y1="142" x2="400" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <line x1="500" y1="142" x2="650" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="40" y="160" width="210" height="78" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="145" y="180" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_run_stdio</text>
  <text x="145" y="198" font-size="9" fill="#64748b" text-anchor="middle">过滤 env</text>
  <text x="145" y="213" font-size="9" fill="#64748b" text-anchor="middle">OSV 恶意包检查</text>
  <text x="145" y="228" font-size="9" fill="#64748b" text-anchor="middle">spawn 子进程</text>
  <rect x="295" y="160" width="210" height="78" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="400" y="180" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_run_http (HTTP)</text>
  <text x="400" y="198" font-size="9" fill="#64748b" text-anchor="middle">补 protocol header</text>
  <text x="400" y="213" font-size="9" fill="#64748b" text-anchor="middle">OAuth provider 注入</text>
  <text x="400" y="228" font-size="9" fill="#64748b" text-anchor="middle">打开 StreamableHTTP</text>
  <rect x="550" y="160" width="210" height="78" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="655" y="180" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_run_http (SSE)</text>
  <text x="655" y="198" font-size="9" fill="#64748b" text-anchor="middle">sse_read_timeout=300</text>
  <text x="655" y="213" font-size="9" fill="#64748b" text-anchor="middle">OAuth provider 注入</text>
  <text x="655" y="228" font-size="9" fill="#64748b" text-anchor="middle">打开 SSE 流</text>
  <line x1="145" y1="238" x2="380" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <line x1="400" y1="238" x2="400" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <line x1="655" y1="238" x2="420" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="220" y="256" width="360" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="400" y="276" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">ClientSession.initialize()  ── 协议握手</text>
  <line x1="400" y1="288" x2="400" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="220" y="302" width="360" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="400" y="322" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">_discover_tools() ── session.list_tools()</text>
  <line x1="400" y1="334" x2="400" y2="348" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="150" y="348" width="500" height="92" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="170" y="368" font-size="11" font-weight="700" fill="currentColor">_register_server_tools()  — for each tool</text>
  <text x="170" y="388" font-size="10" fill="#64748b">include/exclude 过滤 · _scan_mcp_description() 提示注入扫描</text>
  <text x="170" y="405" font-size="10" fill="#64748b">内置工具同名冲突检查 · registry.register("mcp-&lt;server&gt;__&lt;tool&gt;")</text>
  <text x="170" y="422" font-size="10" fill="#64748b">+ 注册 Resources/Prompts 工具 + register_toolset_alias()</text>
  <line x1="400" y1="440" x2="400" y2="454" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="220" y="454" width="360" height="32" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="400" y="474" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_ready.set()  ── 工具进入 ToolRegistry，agent 可调用</text>
  <line x1="400" y1="486" x2="400" y2="500" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar3)"/>
  <rect x="180" y="500" width="440" height="36" rx="6" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="400" y="522" font-size="10" fill="currentColor" text-anchor="middle">_wait_for_lifecycle_event() ── 挂起，收 reconnect 回重连 / 收 shutdown 清理</text>
</svg>
<span class="figure-caption">图 R12.3 ｜ MCP 客户端连接与工具注册全景：并行启动 → 按 transport 连接 → 握手发现 → 注册进 ToolRegistry → 挂起等生命周期事件。</span>

<details>
<summary>ASCII 原版</summary>

```text
   config.yaml
       |
       |  mcp_servers:
       |    weather: { command: "npx", args: [...], env: {...} }
       |    docs:    { url: "https://...", transport: sse, auth_type: oauth }
       v
   register_mcp_servers()  ──── asyncio.gather 并行处理所有 server ────┐
       |                                          mcp_tool.py:3163    |
       v                                                              |
  ┌─ 每个 server: MCPServerTask.run()  (mcp_tool.py:1503) ─────────────┘
  |        |
  |        |  按 transport 分派
  |        +──────────────────┬──────────────────────┐
  |        v                  v                      v
  |   _run_stdio          _run_http (HTTP)       _run_http (SSE)
  |        |                  |                      |
  |   过滤 env               补 protocol header     sse_read_timeout=300
  |   OSV 恶意包检查          OAuth provider 注入    OAuth provider 注入
  |   spawn 子进程            打开 StreamableHTTP    打开 SSE 流
  |        |                  |                      |
  |        +──────────────────┴──────────────────────┘
  |        v
  |   ClientSession.initialize()  ── 协议握手，存 initialize_result
  |        |
  |        v
  |   _discover_tools() ── session.list_tools() ── 填充 server._tools
  |        |
  |        v
  |   _register_server_tools()  (mcp_tool.py:3026)
  |        |  for each tool:
  |        |    include/exclude 过滤
  |        |    _scan_mcp_description() 提示注入扫描
  |        |    内置工具同名冲突检查
  |        |    registry.register(name="mcp-<server>__<tool>", ...)
  |        |  + 注册 Resources/Prompts 工具
  |        |  + register_toolset_alias()
  |        v
  |   _ready.set()  ──  工具进入 ToolRegistry，agent 可调用
  |        |
  |        v
  |   _wait_for_lifecycle_event()  ── 挂起，直到 shutdown 或 reconnect
  |        |                          (keepalive 探测也在这里)
  |        +── 收到 reconnect ──> 回到 run() 重连循环
  └────────+── 收到 shutdown ──> 在原 Task 内退出 async with，清理
```

</details>

整张图跑在专用后台 event loop 线程上；agent 主线程通过 `run_coroutine_threadsafe()` 把工具调用投递进来。

### config 配置形态速查

三种 transport 在 `config.yaml` 的 `mcp_servers` 下的最小配置形态：

```text
mcp_servers:
  # stdio —— 本地子进程
  filesystem:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
    env: { ALLOWED_DIR: "/data" }          # 显式声明要透传的变量
    tools: { include: ["read_file", "list_directory"] }

  # StreamableHTTP —— 默认远程 transport
  remote-api:
    url: "https://mcp.example.com/sse"
    headers: { X-Tenant: "acme" }
    connect_timeout: 60

  # SSE —— 老式 SSE 协议的 server
  docs:
    url: "https://docs.example.com/mcp"
    transport: sse
    auth_type: oauth                       # 触发 12.4 的 OAuth 流程
```

### 工具命名与 schema 转换

MCP server 自报的工具有自己的名字（如 `read_file`），不能原样进 `ToolRegistry`——会和别的 server 或内置工具撞名，而且工具名里可能有连字符等 LLM provider 校验不接受的字符。`_convert_mcp_schema()`（`mcp_tool.py:2809`）做这层转换：

```python
def _convert_mcp_schema(server_name, mcp_tool):
    safe_tool_name = sanitize_mcp_name_component(mcp_tool.name)
    safe_server_name = sanitize_mcp_name_component(server_name)
    prefixed_name = f"mcp_{safe_server_name}_{safe_tool_name}"
    return {
        "name": prefixed_name,
        "description": mcp_tool.description or f"MCP tool {mcp_tool.name} ...",
        "parameters": _normalize_mcp_input_schema(getattr(mcp_tool, "inputSchema", None)),
    }
```

命名规则是 `mcp_<server>_<tool>`，`sanitize_mcp_name_component()`（`mcp_tool.py:2799`）把 `[A-Za-z0-9_]` 之外的字符全替成下划线——连字符、点都会被规整。`_normalize_mcp_input_schema()` 则把 MCP 的 `inputSchema` 转成 Hermes registry 期望的 `parameters` JSON Schema 形态。这套前缀化保证了「同名但不同 server 的工具」能共存，agent 在工具列表里看到的是带 server 前缀的名字。

### 工具调用执行路径与熔断器

`_make_tool_handler()`（`mcp_tool.py:2279`）为每个 MCP 工具生成一个同步 handler，符合 registry 的分发接口 `handler(args, **kwargs) -> str`。一次 MCP 工具调用要穿过这些环节：

<svg viewBox="0 0 780 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP tool call execution pipeline through six stages">
  <defs>
    <marker id="r12ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="14" width="660" height="50" rx="8" fill="#dc2626" fill-opacity="0.08" stroke="#dc2626"/>
  <text x="80" y="34" font-size="11" font-weight="700" fill="currentColor">1 · 熔断器检查</text>
  <text x="80" y="52" font-size="10" fill="#64748b">连续失败 ≥ 阈值 → 冷却期内直接返回错误，不真正发起调用</text>
  <line x1="390" y1="64" x2="390" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar4)"/>
  <rect x="60" y="76" width="660" height="44" rx="8" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="80" y="94" font-size="11" font-weight="700" fill="currentColor">2 · 连接检查</text>
  <text x="80" y="112" font-size="10" fill="#64748b">取 _servers[name]，session 不存在则报「未连接」</text>
  <line x1="390" y1="120" x2="390" y2="132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar4)"/>
  <rect x="60" y="132" width="660" height="44" rx="8" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="150" font-size="11" font-weight="700" fill="currentColor">3 · 投递协程</text>
  <text x="80" y="168" font-size="10" fill="#64748b">把 _call() 协程经后台 loop 调度，server._rpc_lock 串行化</text>
  <line x1="390" y1="176" x2="390" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar4)"/>
  <rect x="60" y="188" width="660" height="44" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="80" y="206" font-size="11" font-weight="700" fill="currentColor">4 · 执行</text>
  <text x="80" y="224" font-size="10" fill="#64748b">session.call_tool(tool_name, arguments=args)</text>
  <line x1="390" y1="232" x2="390" y2="244" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar4)"/>
  <rect x="60" y="244" width="660" height="58" rx="8" fill="#0d9488" fill-opacity="0.12" stroke="#0d9488"/>
  <text x="80" y="262" font-size="11" font-weight="700" fill="currentColor">5 · 结果处理</text>
  <text x="80" y="280" font-size="10" fill="#64748b">result.isError → _sanitize_error 后返回错误</text>
  <text x="80" y="296" font-size="10" fill="#64748b">正常 → 收集文本；ImageContent 走 gateway 图片缓存转 MEDIA: 标签</text>
  <line x1="390" y1="302" x2="390" y2="314" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar4)"/>
  <rect x="60" y="314" width="660" height="44" rx="8" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="80" y="332" font-size="11" font-weight="700" fill="currentColor">6 · 异常恢复</text>
  <text x="80" y="350" font-size="10" fill="#64748b">auth 错误 / session 过期 → 触发重连并重试一次</text>
</svg>
<span class="figure-caption">图 R12.4 ｜ 一次 MCP 工具调用的六阶段执行管线：熔断器 → 连接检查 → 投递协程 → 执行 → 结果处理 → 异常恢复。</span>

<details>
<summary>ASCII 原版</summary>

```text
1. 熔断器检查    server 连续失败 >= _CIRCUIT_BREAKER_THRESHOLD 次
                 -> 冷却期内直接返回错误，不真正发起调用
2. 连接检查      取 _servers[name]，session 不存在则报「未连接」
3. 投递协程      把 _call() 协程经后台 loop 调度，server._rpc_lock 串行化
4. 执行          session.call_tool(tool_name, arguments=args)
5. 结果处理      result.isError -> _sanitize_error 后返回错误
                 正常 -> 收集 content blocks 的文本；ImageContent 块
                         走 gateway 图片缓存转成 MEDIA: 标签
6. 异常恢复      auth 错误 / session 过期 -> 触发重连并重试一次
```

</details>

第 1 步的**熔断器**值得单独说（`mcp_tool.py:2297` 起，issue #10447）。如果一个 server 连续失败超过阈值，handler 不再真正发起调用，而是直接返回一段明确的错误：「server 不可达，约 N 秒后自动重试，请勿现在重试此工具，改用其他方式」。这是写给 LLM 看的——避免模型在一个挂掉的 server 上反复浪费工具调用轮次。冷却期过后熔断器转「半开」，放下一次调用作探针：成功则 `_reset_server_error()` 复位，失败则 `_bump_server_error()` 重新计数、重新计时。

第 6 步的异常恢复是一条专门的链路：`_is_auth_error()`（`mcp_tool.py:1806`，类型由 `_get_auth_error_types()` 懒加载）识别 401/认证类异常，`_handle_auth_error_and_retry()`（`mcp_tool.py:1825`）走 `MCPOAuthManager.handle_401()` 刷新 token、设 `_reconnect_event`、重连后重试一次；`_is_session_expired_error()` 识别 session 过期类异常，走更轻的「只重连 transport」路径。两条路径都只重试一次——避免在真故障上无限循环。

## 12.3 MCP 服务端：把 Hermes 暴露出去

反过来，`mcp_serve.py` 让 Hermes 自己成为一个 MCP server——Claude Desktop、Cursor 这类 MCP 客户端可以连上来，把 Hermes 当成一组工具用。

核心是 `create_mcp_server()`（`mcp_serve.py:450`），它用 `FastMCP` 框架（`mcp_serve.py:458`）建一个 server，并用 `@mcp.tool()` 装饰器注册一批工具：

```python
def create_mcp_server(event_bridge=None) -> "FastMCP":
    """Create and return the Hermes MCP server with all tools registered."""
    mcp = FastMCP(...)

    @mcp.tool()
    def ...   # mcp_serve.py:471, 528, 561, 618, 670, 699, 733, 769, 823, 839
```

从 `mcp_serve.py:471` 到 `:839` 一共注册了约 10 个工具，集中在三类：会话/消息读取、事件订阅、消息收发与审批。逐一来看：

| 工具 | 行号 | 用途 |
|------|------|------|
| `conversations_list` | `:472` | 列出会话，支持按 platform 过滤、limit、关键词 search |
| `conversation_get` | `:529` | 按 session key 取单个会话的详情元数据（平台、token 统计等） |
| `messages_read` | `:562` | 读取一个会话内的消息历史 |
| `attachments_fetch` | `:619` | 抽取某条消息里的图片/媒体等非文本附件 |
| `events_poll` | `:671` | 拉取 cursor 之后的会话事件（短轮询） |
| `events_wait` | `:700` | long-poll：阻塞等下一个事件，最多 5 分钟 |
| `messages_send` | `:734` | 跨平台发送一条消息 |
| `channels_list` | `:770` | 列出各平台可用的频道/发送目标 |
| `permissions_list_open` | `:824` | 列出本次 bridge 会话期间观察到的待审批请求 |
| `permissions_respond` | `:840` | 对一个待审批请求做出 allow-once/allow-always/deny 决定 |

这组工具对齐了 OpenClaw 的桥接接口——外部客户端（Claude Desktop 等）借此把 Hermes 当成「跨平台消息中枢 + 审批控制台」。`run_mcp_server()`（`mcp_serve.py:866`）是启动入口。

### EventBridge：把数据库变化变成事件流

`events_poll` / `events_wait` 这两个工具背后是 `EventBridge`（`mcp_serve.py:204`）。MCP server 这个进程本身不参与 agent 主循环，它要怎么知道「有新消息进来了」「有审批被触发了」?答案是轮询数据库。

`EventBridge` 的模块注释说得直白：「This is the Hermes equivalent of OpenClaw's WebSocket gateway bridge. Instead of WebSocket events, we poll the SQLite database for changes.」OpenClaw 用 WebSocket 推事件，Hermes 没有常驻 socket，于是退而用一个后台线程轮询 `SessionDB`：

- `start()` 拉起一个 daemon 轮询线程，`_poll_loop()` -> `_poll_once()` 周期性扫描 SessionDB。
- 检测到新消息/新审批就 `_enqueue()` 一个 `QueueEvent` 进内存队列，每个事件带递增 `cursor`。
- `poll_events()` 返回某 cursor 之后的事件（短轮询）；`wait_for_event()` 借 `threading.Event` 实现 long-poll，有新事件就立刻唤醒等待者。
- 为了省开销，它缓存 `sessions.json` 和 state DB 的 mtime，文件没变就跳过昂贵的重扫。

审批相关的 `_pending_approvals` 也由 `EventBridge` 从事件流里维护——这就是为什么 `permissions_list_open` 的文档强调「只能看到 bridge 启动之后的审批」：bridge 没连之前发生的事件不在它的队列里。`create_mcp_server()` 接受一个可选的 `event_bridge` 参数，不传则自建一个。

### 客户端与服务端：同一文件名，相反方向

容易混淆的一点：Hermes 的 MCP 客户端（`mcp_tool.py`）和服务端（`mcp_serve.py`）是两套独立代码，方向相反。对照一下：

| 维度 | MCP 客户端（`mcp_tool.py`） | MCP 服务端（`mcp_serve.py`） |
|------|--------------------------|---------------------------|
| 角色 | Hermes 连别人 | 别人连 Hermes |
| 框架 | MCP SDK 的 `ClientSession` | `FastMCP` |
| 提供方 | 外部 MCP server 提供工具 | Hermes 提供工具 |
| 工具来源 | `session.list_tools()` 发现 | `@mcp.tool()` 装饰器静态注册 |
| 典型对端 | filesystem-server、各类 SaaS server | Claude Desktop、Cursor |
| 事件机制 | 收 `list_changed` 等通知 | `EventBridge` 轮询 SessionDB |
| 入口 | `register_mcp_servers()` | `run_mcp_server()` |

两者唯一的交集是 MCP 协议本身——客户端发的请求，正是服务端要响应的；理解了协议（12.1 的速览），两边就都通了。实际部署里，一台机器上的 Hermes 完全可以同时扮演两个角色：作为客户端连若干工具 server，同时作为服务端把自己挂给桌面客户端。

## 12.4 MCP OAuth

很多远程 MCP server 要 OAuth 认证。OAuth 2.1 的授权码流程对一个 CLI 程序并不友好——它涉及浏览器跳转、回调接收、token 刷新。Hermes 把这套封装在两个文件里：`tools/mcp_oauth.py`（底层原语：token 存储、回调服务器）和 `tools/mcp_oauth_manager.py`（上层协调：provider 工厂、401 处理）。

### 完整授权流程

第一次连一个需要 OAuth 的 server，会走完整的授权码 + PKCE 流程：

<svg viewBox="0 0 780 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MCP OAuth authorization code with PKCE flow in eight steps">
  <defs>
    <marker id="r12ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="120" y="14" width="540" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="138" y="37" font-size="11" fill="currentColor"><tspan font-weight="700">1</tspan>  _prefetch_oauth_metadata() ── 提前发现 OAuth 元数据端点</text>
  <line x1="390" y1="50" x2="390" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="62" width="540" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="138" y="85" font-size="11" fill="currentColor"><tspan font-weight="700">2</tspan>  动态客户端注册 ── 无 client info 则向 server 注册拿 client_id</text>
  <line x1="390" y1="98" x2="390" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="110" width="540" height="36" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="138" y="133" font-size="11" fill="currentColor"><tspan font-weight="700">3</tspan>  _find_free_port() ── 本地选空闲端口做 redirect_uri</text>
  <line x1="390" y1="146" x2="390" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="158" width="540" height="36" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="138" y="181" font-size="11" fill="currentColor"><tspan font-weight="700">4</tspan>  _make_callback_handler() ── 起临时 HTTP handler 在该端口等回调</text>
  <line x1="390" y1="194" x2="390" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="206" width="540" height="36" rx="6" fill="#0ea5e9" fill-opacity="0.14" stroke="#0ea5e9"/>
  <text x="138" y="229" font-size="11" fill="currentColor"><tspan font-weight="700">5</tspan>  打开浏览器 ── 用户在浏览器里登录、授权</text>
  <line x1="390" y1="242" x2="390" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="254" width="540" height="36" rx="6" fill="#0ea5e9" fill-opacity="0.14" stroke="#0ea5e9"/>
  <text x="138" y="277" font-size="11" fill="currentColor"><tspan font-weight="700">6</tspan>  server 重定向回本地端口 ── handler 捕获 authorization code</text>
  <line x1="390" y1="290" x2="390" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="302" width="540" height="36" rx="6" fill="#0d9488" fill-opacity="0.14" stroke="#0d9488"/>
  <text x="138" y="325" font-size="11" fill="currentColor"><tspan font-weight="700">7</tspan>  code 换 token ── code + PKCE verifier 向 token 端点换 access/refresh token</text>
  <line x1="390" y1="338" x2="390" y2="350" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar5)"/>
  <rect x="120" y="350" width="540" height="42" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="138" y="368" font-size="11" fill="currentColor"><tspan font-weight="700">8</tspan>  set_tokens() ── token 落盘</text>
  <text x="155" y="384" font-size="10" fill="#64748b">下次启动直接复用，不必重新授权</text>
</svg>
<span class="figure-caption">图 R12.5 ｜ MCP OAuth 首次授权流程：发现元数据 → 动态注册 → 本地回调端口 → 浏览器授权 → code 换 token 并落盘复用。</span>

<details>
<summary>ASCII 原版</summary>

```text
1. _prefetch_oauth_metadata()   提前发现 server 的 OAuth 元数据端点
2. 动态客户端注册               没有 client info 则向 server 注册，拿 client_id
3. _find_free_port()            本地选一个空闲端口做 redirect_uri
4. _make_callback_handler()     起一个临时 HTTP handler 在该端口等回调
5. 打开浏览器                   用户在浏览器里登录、授权
6. server 重定向回本地端口      handler 捕获 authorization code
7. code 换 token                拿 code + PKCE verifier 向 token 端点换 access/refresh token
8. set_tokens()                 token 落盘，下次启动直接复用
```

</details>

### 凭证持久化

`tools/mcp_oauth.py:209` 的 `HermesTokenStorage` 把 token 和 client-info 落到磁盘，这样重启后不用重新授权：

```python
class HermesTokenStorage:
    async def get_tokens(self) -> "OAuthToken | None":   # mcp_oauth.py:233
    async def set_tokens(self, tokens) -> None:          # mcp_oauth.py:272
```

`get_tokens()` / `set_tokens()` 读写一个按 server 名命名的 token 文件，`get_client_info()` / `set_client_info()`（`mcp_oauth.py:294`/`304`）则持久化动态客户端注册的结果——这样 access token 过期了还有 refresh token 可用，client 注册也不必每次重做。文件存在专用的 token 目录（`_get_token_dir`），server 名经 `_safe_filename()` 处理后才作文件名，防路径注入。

### 非交互环境的 fail-fast

授权流程需要一个本地回调端口接收授权码——`mcp_oauth.py:120` 的 `_find_free_port()` 找空闲端口，`mcp_oauth.py:347` 的 `_make_callback_handler()` 起一个临时 HTTP handler 捕获回调。

但有一个关键场景必须处理：cron 任务、网关后台进程这类**没有 TTY、没有浏览器**的环境。如果在这种环境里触发 OAuth，程序会卡死——等一个永远不会有人在浏览器里完成的授权。`_is_interactive()` / `_can_open_browser()`（`mcp_oauth.py:127`/`135`）正是为此而设：它们探测当前环境能不能弹浏览器，不能就抛 `OAuthNonInteractiveError`（`mcp_oauth.py:83`）——快速失败、把这个 server 标记为「需要先在交互环境里授权一次」，而不是无声地挂起。这是「fail fast over hang」原则的一个具体落点。

### OAuth Provider 与 401 处理

`tools/mcp_oauth_manager.py:339` 的 `MCPOAuthManager` 是上层协调者：

- `get_or_build_provider()`（`mcp_oauth_manager.py:353`）—— 单例工厂。为每个 server 构造一个 `HermesMCPOAuthProvider`（`mcp_oauth_manager.py:95`，由 `_make_hermes_provider_class()` 懒加载 SDK 基类 `OAuthClientProvider` 后定义的子类）。「单例」很重要——同一个 provider 实例要在多次重连之间复用，这样 token 状态、disk-watch、CLI 配置期路径共享同一份状态，不会各算各的。
- `_prefetch_oauth_metadata()`（`mcp_oauth_manager.py:192`）—— provider `_initialize()` 时调用，预取 OAuth 元数据，提前完成 server 发现，减少首次实际请求的延迟。元数据变化时 `_persist_oauth_metadata_if_changed()` 会落盘。
- `handle_401()`（`mcp_oauth_manager.py:506`）—— 请求收到 401 时触发 token 刷新或 step-up 授权，成功后设 `_reconnect_event` 让 server 重连并重试。
- `invalidate_if_disk_changed()`（`mcp_oauth_manager.py:466`）—— `HermesMCPOAuthProvider` 注入了 disk-watch：如果另一个 Hermes 进程在磁盘上刷新了 token，本进程能感知并失效本地缓存，多进程共用同一组 token 时不会互相踩。

`HermesMCPOAuthProvider` 还重写了 `async_auth_flow()`（`mcp_oauth_manager.py:287`），把上面这套预取、disk-watch、持久化逻辑挂进 SDK 的认证流程钩子里。

### token 生命周期状态图

把首次授权、复用、刷新、失效几条路径合起来，OAuth token 的状态流转如下：

<svg viewBox="0 0 800 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OAuth token lifecycle state machine">
  <defs>
    <marker id="r12ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="14" width="240" height="34" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="400" y="35" font-size="11" fill="currentColor" text-anchor="middle">无 token / 无 client info</text>
  <line x1="400" y1="48" x2="400" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <rect x="280" y="60" width="240" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="400" y="80" font-size="11" fill="currentColor" text-anchor="middle">首次连接 ── 交互环境 ?</text>
  <line x1="520" y1="76" x2="600" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <text x="555" y="68" font-size="9" fill="#dc2626">否</text>
  <rect x="602" y="58" width="190" height="36" rx="6" fill="#fef2f2" stroke="#dc2626"/>
  <text x="697" y="74" font-size="9.5" fill="currentColor" text-anchor="middle">OAuthNonInteractiveError</text>
  <text x="697" y="88" font-size="9" fill="#64748b" text-anchor="middle">标记 server 待授权</text>
  <line x1="400" y1="92" x2="400" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <text x="412" y="102" font-size="9" fill="#64748b">是</text>
  <rect x="240" y="104" width="320" height="32" rx="6" fill="#0ea5e9" fill-opacity="0.14" stroke="#0ea5e9"/>
  <text x="400" y="124" font-size="10" fill="currentColor" text-anchor="middle">动态注册 + 浏览器授权 + code 换 token</text>
  <line x1="400" y1="136" x2="400" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <rect x="290" y="148" width="220" height="32" rx="6" fill="#0d9488" fill-opacity="0.14" stroke="#0d9488"/>
  <text x="400" y="168" font-size="11" fill="currentColor" text-anchor="middle">set_tokens() 落盘</text>
  <line x1="400" y1="180" x2="400" y2="192" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <rect x="280" y="192" width="240" height="40" rx="8" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a" stroke-width="1.5"/>
  <text x="400" y="210" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">[有效 token]</text>
  <text x="400" y="225" font-size="9" fill="#64748b" text-anchor="middle">正常工具调用</text>
  <line x1="280" y1="220" x2="180" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <text x="200" y="240" font-size="9" fill="#dc2626">请求得到 401</text>
  <rect x="60" y="250" width="240" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="180" y="270" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">handle_401()</text>
  <line x1="180" y1="282" x2="180" y2="294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <rect x="60" y="294" width="240" height="30" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="180" y="313" font-size="10" fill="currentColor" text-anchor="middle">refresh token 还有效 ?</text>
  <line x1="120" y1="324" x2="100" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <text x="95" y="336" font-size="9" fill="#64748b">是</text>
  <line x1="240" y1="324" x2="260" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <text x="262" y="336" font-size="9" fill="#64748b">否</text>
  <rect x="30" y="340" width="130" height="40" rx="6" fill="#0d9488" fill-opacity="0.14" stroke="#0d9488"/>
  <text x="95" y="358" font-size="9.5" fill="currentColor" text-anchor="middle">刷新 access token</text>
  <text x="95" y="372" font-size="9" fill="#64748b" text-anchor="middle">set_tokens()</text>
  <rect x="200" y="340" width="130" height="40" rx="6" fill="#0ea5e9" fill-opacity="0.14" stroke="#0ea5e9"/>
  <text x="265" y="358" font-size="9.5" fill="currentColor" text-anchor="middle">重走授权流程</text>
  <text x="265" y="372" font-size="9" fill="#64748b" text-anchor="middle">set_tokens()</text>
  <line x1="95" y1="380" x2="95" y2="396" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <line x1="265" y1="380" x2="265" y2="396" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar6)"/>
  <rect x="30" y="398" width="300" height="30" rx="6" fill="#16a34a" fill-opacity="0.1" stroke="#16a34a"/>
  <text x="180" y="417" font-size="10" fill="currentColor" text-anchor="middle">设 _reconnect_event 重连重试</text>
  <line x1="520" y1="220" x2="620" y2="248" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r12ar6)"/>
  <text x="560" y="240" font-size="9" fill="#64748b">另一进程刷新磁盘 token</text>
  <rect x="540" y="250" width="240" height="58" rx="8" fill="#7c3aed" fill-opacity="0.1" stroke="#7c3aed"/>
  <text x="660" y="272" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">invalidate_if_disk_changed()</text>
  <text x="660" y="290" font-size="9" fill="#64748b" text-anchor="middle">失效本地缓存，下次读盘取新值</text>
</svg>
<span class="figure-caption">图 R12.6 ｜ OAuth token 生命周期状态机：授权落盘后正常使用，401 触发刷新或重授权，跨进程磁盘变化失效本地缓存。</span>

<details>
<summary>ASCII 原版</summary>

```text
        无 token / 无 client info
              |
              v
   首次连接 ── 交互环境? ──否──> OAuthNonInteractiveError（标记 server 待授权）
              | 是
              v
   动态注册 + 浏览器授权 + code 换 token
              |
              v
        set_tokens() 落盘  ─────────────────┐
              |                             |
              v                             |
        [有效 token]  ── 正常工具调用 ───────┘
              |
              |── 请求得到 401 ──> handle_401()
              |                       |
              |                  refresh token 还有效?
              |                    /            \
              |                  是              否
              |                   |               |
              |             刷新 access token   重新走授权流程
              |                   |               |
              |              set_tokens()      set_tokens()
              |                   |               |
              |             设 _reconnect_event 重连重试
              |
              |── 另一进程刷新了磁盘 token ──> invalidate_if_disk_changed()
                                                失效本地缓存，下次读盘取新值
```

</details>

整套机制的目标是：授权这件事尽量只做一次（token 落盘复用），刷新对调用方透明（401 自动恢复后重试），多进程共用 token 不打架（disk-watch）。

## 12.5 插件系统：四层发现

插件系统的代码在 `hermes_cli/plugins.py`。它的模块 docstring 列出了插件的四个来源——这是理解整个系统的钥匙。

### 四层来源与覆盖顺序

`PluginManager` 扫描插件的顺序（`hermes_cli/plugins.py:824` 起）：

```text
1. Bundled plugins   —— 仓库自带的 plugins/<name>/         （source="bundled"）
2. User plugins      —— ~/.hermes/plugins/<name>/           （source="user"）
3. Project plugins   —— ./.hermes/plugins/<name>/  （opt-in）（source="project"）
4. Entry-point       —— pip 安装的、声明了 entry-point group 的包（source="entrypoint"）
```

`get_bundled_plugins_dir()`（`hermes_cli/plugins.py:55`）定位第 1 层（可被 `HERMES_BUNDLED_PLUGINS` 环境变量覆盖，供 Nix 打包用）；用户层用 `get_hermes_home() / "plugins"`（`plugins.py:840`）；entry-point 层由 `_scan_entry_points()`（`plugins.py:1137`）扫描。

关键规则在 docstring 里：「Later sources override earlier ones on name collision」——同名插件，后扫描的覆盖先扫描的。所以用户可以在 `~/.hermes/plugins/` 放一个同名插件，覆盖掉仓库自带的版本，而不用改 Hermes 源码。

`discover_and_load()`（`plugins.py:790`）是统一入口，它按上面四层顺序逐层调 `_scan_directory()` 收集 manifest，再逐个加载。目录扫描由 `_scan_directory_level()`（`plugins.py:986`）递归实现——这就是为什么 `plugins/image_gen/openai/` 这类嵌套两层的「分类插件」也能被发现。

### 启用门控：enabled 与 disabled 两道闸

发现到了不等于会加载。加载阶段有两道 config 闸门，规则在 `plugins.py:863`–`945`：

- `plugins.disabled`（`_get_disabled_plugins`，`plugins.py:180`）—— 黑名单。列在里面的插件直接跳过，标记 `error = "disabled via config"`。
- `plugins.enabled`（`_get_enabled_plugins`，`plugins.py:196`）—— 白名单，且是 **opt-in 默认**。注释里强调：config 里**没有** `enabled` 这个 key 时，视为「白名单为空」而非「全部启用」——这是有意的安全默认，第三方插件代码不会因为放进目录就自动跑起来。

但「opt-in」对不同 `kind` 的插件不一样（见下面 manifest 的 `kind` 字段）：`bundled` 的 `backend` / `platform` 插件**自动加载**（保证开箱即用每个内置后端、每个内置平台都在），其余一律要显式 `hermes plugins enable <key>` 写进 `plugins.enabled` 才生效。

把发现与加载的完整决策树画出来，每个 manifest 都要走一遍：

<svg viewBox="0 0 800 510" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Plugin discovery and load decision tree">
  <defs>
    <marker id="r12ar7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="220" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="350" y="34" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">扫到一个 manifest</text>
  <line x1="350" y1="46" x2="350" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <rect x="230" y="58" width="240" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="350" y="77" font-size="10" fill="currentColor" text-anchor="middle">key 在 plugins.disabled ?</text>
  <line x1="470" y1="73" x2="560" y2="73" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="510" y="66" font-size="9" fill="#dc2626">是</text>
  <rect x="562" y="56" width="220" height="34" rx="6" fill="#fef2f2" stroke="#dc2626"/>
  <text x="672" y="77" font-size="9.5" fill="currentColor" text-anchor="middle">跳过 · error="disabled via config"</text>
  <line x1="350" y1="88" x2="350" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="362" y="98" font-size="9" fill="#64748b">否</text>
  <rect x="230" y="100" width="240" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="350" y="119" font-size="10" fill="currentColor" text-anchor="middle">kind == exclusive ?</text>
  <line x1="470" y1="115" x2="560" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="510" y="108" font-size="9" fill="#64748b">是</text>
  <rect x="562" y="98" width="220" height="34" rx="6" fill="#0d9488" fill-opacity="0.14" stroke="#0d9488"/>
  <text x="672" y="119" font-size="9.5" fill="currentColor" text-anchor="middle">只登记 · 分类发现系统加载</text>
  <line x1="350" y1="130" x2="350" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="362" y="140" font-size="9" fill="#64748b">否</text>
  <rect x="230" y="142" width="240" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="350" y="161" font-size="10" fill="currentColor" text-anchor="middle">kind == model-provider ?</text>
  <line x1="470" y1="157" x2="560" y2="157" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="510" y="150" font-size="9" fill="#64748b">是</text>
  <rect x="562" y="140" width="220" height="34" rx="6" fill="#0d9488" fill-opacity="0.14" stroke="#0d9488"/>
  <text x="672" y="161" font-size="9.5" fill="currentColor" text-anchor="middle">只登记 · providers/ 懒发现</text>
  <line x1="350" y1="172" x2="350" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="362" y="182" font-size="9" fill="#64748b">否</text>
  <rect x="210" y="184" width="280" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="350" y="204" font-size="9.5" fill="currentColor" text-anchor="middle">bundled 且 kind∈{backend,platform} ?</text>
  <line x1="490" y1="200" x2="560" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="525" y="193" font-size="9" fill="#16a34a">是</text>
  <rect x="562" y="183" width="220" height="34" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="672" y="204" font-size="9.5" fill="currentColor" text-anchor="middle">自动 _load_plugin()</text>
  <line x1="350" y1="216" x2="350" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="362" y="226" font-size="9" fill="#64748b">否</text>
  <rect x="230" y="228" width="240" height="30" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="350" y="247" font-size="10" fill="currentColor" text-anchor="middle">key/name 在 plugins.enabled ?</text>
  <line x1="470" y1="243" x2="560" y2="243" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="510" y="236" font-size="9" fill="#dc2626">否</text>
  <rect x="562" y="226" width="220" height="34" rx="6" fill="#fef2f2" stroke="#dc2626"/>
  <text x="672" y="247" font-size="9.5" fill="currentColor" text-anchor="middle">跳过 · error="not enabled…"</text>
  <line x1="350" y1="258" x2="350" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="362" y="268" font-size="9" fill="#64748b">是</text>
  <rect x="250" y="270" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="350" y="290" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_load_plugin()</text>
  <line x1="350" y1="302" x2="350" y2="314" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <rect x="230" y="314" width="240" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="350" y="334" font-size="10" fill="currentColor" text-anchor="middle">导入模块 hermes_plugins.&lt;slug&gt;</text>
  <line x1="350" y1="346" x2="350" y2="358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <rect x="210" y="358" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="350" y="378" font-size="10" fill="currentColor" text-anchor="middle">调 register(ctx) ── try/except 隔离</text>
  <line x1="490" y1="374" x2="560" y2="374" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <text x="525" y="367" font-size="9" fill="#dc2626">失败</text>
  <rect x="562" y="357" width="220" height="34" rx="6" fill="#fef2f2" stroke="#dc2626"/>
  <text x="672" y="378" font-size="9.5" fill="currentColor" text-anchor="middle">记 error，enabled 保持 False</text>
  <line x1="350" y1="390" x2="350" y2="402" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <rect x="210" y="402" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="350" y="422" font-size="10" fill="currentColor" text-anchor="middle">diff 注册表，回填 tools/hooks/commands</text>
  <line x1="350" y1="434" x2="350" y2="446" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar7)"/>
  <rect x="270" y="446" width="160" height="32" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="350" y="466" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">enabled = True</text>
</svg>
<span class="figure-caption">图 R12.7 ｜ 插件发现与加载决策树：disabled 过滤 → 按 kind 分流（exclusive/model-provider 只登记）→ bundled backend/platform 自动加载 → 其余 opt-in。</span>

<details>
<summary>ASCII 原版</summary>

```text
                  扫到一个 manifest
                        |
            key 在 plugins.disabled?  ──是──> 跳过，error="disabled via config"
                        | 否
                        v
              kind == exclusive?  ──是──> 只登记，模块由分类发现系统加载
                        | 否
                        v
              kind == model-provider?  ──是──> 只登记，providers/ 懒发现
                        | 否
                        v
       source==bundled 且 kind∈{backend,platform}?  ──是──> 自动 _load_plugin()
                        | 否
                        v
            key/name 在 plugins.enabled?  ──否──> 跳过，error="not enabled..."
                        | 是
                        v
                  _load_plugin()
                        |
              导入模块（hermes_plugins.<slug>）
                        |
              调 register(ctx)  ── try/except 隔离 ──> 失败则记 error
                        |
              diff 注册表，回填 tools/hooks/commands_registered
                        |
                  enabled = True
```

</details>

这棵树解释了一个常见困惑：为什么有的插件「不 enable 也能用」（bundled backend/platform 走自动加载分支），有的「装了也不动」（standalone 卡在 `plugins.enabled` 那道闸）。

### 插件的形态

每个目录式插件需要两个文件：

- `plugin.yaml` —— manifest，被解析成 `PluginManifest`（`plugins.py:234`）。
- `__init__.py` —— 提供一个 `register(ctx)` 函数，`ctx` 是 `PluginContext`。

`PluginManifest` 的字段值得逐一看，因为它们直接决定插件的加载行为：

```text
name / version / description / author    基本元数据
requires_env       依赖的环境变量（缺失时插件不可用）
provides_tools     声明提供的工具名（用于展示与依赖检查）
provides_hooks     声明挂接的生命周期 hook
source             "bundled" / "user" / "project" / "entrypoint"，由扫描层填
key                注册键 —— 路径派生。扁平插件用目录名（disk-cleanup），
                   嵌套分类插件用相对路径（image_gen/openai）。
                   plugins.enabled/disabled 查的就是这个 key。
kind               插件种类，四选一，决定加载策略：
                     standalone  自带工具/hook，opt-in
                     backend     某核心工具的可插拔后端（如 image_gen）
                     exclusive   一个分类只允许一个 provider（memory），
                                 由分类自己的发现系统加载，通用扫描器跳过
                     platform    网关消息平台适配器
```

`_parse_manifest()`（`plugins.py:1042`）解析 yaml 时还会读 `__init__.py` 源码做启发式判断——比如源码里出现 `register_memory_provider` 就推断这是个 memory 插件——用于补全 `kind`。`LoadedPlugin`（`plugins.py:271`）则是加载后的运行态记录：持有 `module`、`enabled` 标志、`tools_registered` / `hooks_registered` / `commands_registered` 列表、以及失败时的 `error` 字符串。

### PluginContext：插件的完整 API 面

`hermes_cli/plugins.py:287` 的 `PluginContext` 是交给每个插件 `register()` 函数的对象，它就是插件能做的一切。这个 facade 的方法可以分成几组：

```text
注册类
  register_tool()              plugins.py:317   注册一个工具
  register_platform()          plugins.py:645   注册消息平台适配器
  register_context_engine()    plugins.py:499   注册上下文压缩引擎
  register_image_gen_provider()    plugins.py:531   图像生成 provider
  register_video_gen_provider()    plugins.py:558   视频生成 provider
  register_web_search_provider()   plugins.py:585   网页搜索 provider
  register_browser_provider()      plugins.py:613   浏览器 provider
  register_hook()              plugins.py:701   挂接一个生命周期 hook
  register_skill()             plugins.py:720   注册一个 skill
  register_cli_command()       plugins.py:387   新增 hermes <子命令>
  register_command()           plugins.py:412   注册会话内命令
能力类
  llm（property）              plugins.py:299   host 持有的 LLM facade（PluginLlm）
  inject_message()             plugins.py:359   往当前会话注入一条消息
  dispatch_tool()              plugins.py:468   插件内部调用另一个工具
```

`register_tool()` 的实现直接委托给 `tools.registry.register()`（见[第 5 章](05-tool-system.md)）——这意味着插件工具和内置工具走的是同一条注册路径，享受同样的自动发现、schema 收集、可用性检查；它额外把工具名记进 `LoadedPlugin.tools_registered`，便于卸载与排障。`register_platform()` 则把平台适配器注入网关的平台注册表（见[第 13 章](13-messaging-gateway.md)），插件平台优先于内置平台。

`ctx.llm` 是个有意思的设计：它返回一个 `PluginLlm` facade，让**受信任的**插件直接借用「用户当前的模型 + 当前的认证」跑 chat 或结构化补全，而不必自带 provider key。能否覆盖模型/agent id/认证 profile 是 fail-closed 默认的，要经 `plugins.entries.<plugin_id>.llm.*` config 显式开启。

### invoke_hook：生命周期 hook 机制

`PluginManager` 还提供 `invoke_hook()`（`plugins.py:1296`，模块级包装在 `plugins.py:1404`）。agent 核心在固定的生命周期点调 `invoke_hook(name, **kwargs)`，所有用 `register_hook()` 注册了该 hook 的插件依次响应。`VALID_HOOKS`（`plugins.py:128`）定义了全部合法 hook 名，按时机分几组：

```text
工具相关   pre_tool_call / post_tool_call / transform_tool_result
LLM 相关   pre_llm_call / post_llm_call / transform_llm_output
API 相关   pre_api_request / post_api_request
会话生命周期 on_session_start / on_session_end / on_session_finalize
            on_session_reset / subagent_stop
终端输出   transform_terminal_output
网关       pre_gateway_dispatch（消息分发前，可 skip / rewrite / allow）
审批       pre_approval_request / post_approval_response（只观察，不能否决）
```

`invoke_hook()` 的实现有两条重要保证（`plugins.py:1296`–`1331`）：每个回调单独包 try/except——一个坏插件抛异常不会拖垮 agent 主循环；返回值收集所有非 `None` 结果成列表返回。`pre_llm_call` 的返回值还有特殊语义——回调返回的字符串/`{"context": ...}` 会被注入到**当前轮的 user 消息**里，而**不是系统提示**。注释解释了原因：系统提示逐轮保持一致才能命中 prompt 缓存前缀，注入到 user 消息既能加上下文又不破坏缓存；且注入内容是临时的，绝不落 session DB。

`get_pre_tool_call_block_message()`（`plugins.py:1428`）是 hook「能影响流程」的一个具体例子：插件的 `pre_tool_call` 回调返回 `{"action": "block", "message": "..."}` 就能否决一次工具调用，第一个有效 block 指令胜出。它同时还检查线程级工具白名单（`_thread_tool_whitelist`），不在白名单的工具直接拒。

### 子系统插件逐类展开

`plugins/` 目录下不只是工具插件——好几个子系统本身就是用插件机制实现的。这是 Hermes 一以贯之的取舍：核心保持精简，子系统作为插件外挂。逐类来看：

**model-providers**（`plugins/model-providers/`，`kind: backend`）。几十个 provider 插件，`anthropic` / `bedrock` / `azure-foundry` / `copilot` / `alibaba` / `ai-gateway` / `custom` 等。每个插件在 `register()` 里调 `ctx` 的 provider 注册路径声明一个 `ProviderProfile`（见[第 7 章](07-model-providers.md)）。bundled 的全部自动加载——所以「换模型 provider」不需要改核心代码，甚至不需要 enable，开箱即用。

**memory**（`plugins/memory/`，`kind: exclusive`）。记忆 provider（honcho / mem0 / supermemory 等）。`exclusive` 意味着同一时刻只能有一个生效——选哪个由 `memory.provider` config 决定，由 memory 子系统自己的发现系统加载，通用扫描器跳过它们（见[第 10 章](10-memory-system.md)）。

**context_engine**（`plugins/context_engine/`）。上下文压缩引擎，默认 compressor。插件通过 `ctx.register_context_engine()` 注入，替换掉默认的压缩策略（见[第 8 章](08-context-compression.md)）。

**kanban**（`plugins/kanban/`）。多 agent 看板调度。

**observability**（`plugins/observability/`）。metrics / traces / logs 的导出。它大量挂 `pre_*` / `post_*` hook 来观测 agent 行为，是 hook 机制「观察者」用法的典型。

**image_gen / video_gen**（`plugins/image_gen/`、`plugins/video_gen/`，`kind: backend`）。图像/视频生成 provider，按 `image_gen/<provider>` 这样的嵌套目录组织，分别通过 `register_image_gen_provider()` / `register_video_gen_provider()` 注入对应的 registry。

此外 `plugins/platforms/`（`kind: platform`）放网关消息平台适配器，`plugins/web` / `plugins/browser` 放网页与浏览器 provider。一句话：「换 provider、换记忆后端、换压缩引擎、加平台」——在 Hermes 里都不是改核心代码，而是装/写一个插件。`discover_plugins()`（`plugins.py:1395`）是统一的发现入口（薄包装，转调 `discover_and_load()`）。

### 加载机制：模块导入、隔离与按 kind 分流

`discover_and_load()` 在确定一个插件该加载后，并不是简单 `import`——`_load_plugin()`（`plugins.py:1167`）这一步有几个工程考量。

**按 kind 分流**。不是所有 `kind` 都走「导入模块 + 调 register()」这条路：

- `exclusive`（memory）—— 只登记 manifest 供 `hermes plugins list` 展示，**不导入模块**。模块由 memory 子系统按 `memory.provider` config 自己加载，避免重复导入。
- `model-provider` —— 同理，由 `providers/__init__.py` 在首次 `get_provider_profile()` 时懒发现。注释点出关键原因：若这里再导入一次，会创建两份 `ProviderProfile`，破坏 bundled 与 user 插件之间「last writer wins」的覆盖语义。
- `standalone` / `backend` / `platform` —— 才真正走 `_load_plugin()` 导入并调 `register(ctx)`。

**命名空间隔离**。`_load_directory_module()`（`plugins.py:1236`）把目录插件导入成 `hermes_plugins.<slug>`，slug 由 `manifest.key` 派生——所以 `image_gen/openai` 导入成 `hermes_plugins.image_gen__openai`，将来即便有个 `tts/openai` 也不会撞模块名。entry-point 插件则由 `_load_entrypoint_module()` 处理。

**失败隔离**。`_load_plugin()` 整个 `try/except` 包住——某个插件 `register()` 抛异常，只会让该插件的 `LoadedPlugin.error` 记下错误字符串、`enabled` 保持 `False`，**不会**让 `discover_and_load()` 崩、也不影响其他插件。这和 `invoke_hook()` 里「每个回调单独 try/except」是同一条原则：第三方代码的故障必须被隔离在它自己的边界内。`register()` 成功后，`_load_plugin()` 还会回填 `LoadedPlugin` 的 `tools_registered` / `hooks_registered` / `commands_registered`——通过 diff 注册表前后状态算出「这个插件具体注册了什么」，供 `hermes plugins list` 和卸载逻辑使用。

设置 `HERMES_PLUGINS_DEBUG=1` 会装上详细的发现日志（`_install_plugin_debug_handler`，`plugins.py:95`），把每个插件的来源、kind、路径、加载失败的完整 traceback 都打出来——排查「插件为什么没生效」时的第一手段。

### 依赖、环境变量与版本兼容

`PluginManifest` 的 `requires_env` 字段（`plugins.py:241`）声明插件运行需要的环境变量。它由 `_parse_manifest()` 从 `plugin.yaml` 读入；`PluginContext.register_tool()` 也接受一个 `requires_env` 参数转给 `registry.register()`——于是「缺了某个 API key 的工具」会在工具可用性检查（见[第 5 章](05-tool-system.md)）里被标记为不可用，而不是在调用时才神秘失败。这让插件的依赖在加载阶段就显式化。

`provides_tools` / `provides_hooks` 是「声明性」字段——manifest 里写明这个插件意图提供什么工具、挂什么 hook，主要用于展示和文档；真正生效的是 `register()` 里实际调的注册方法，两者由 `_load_plugin()` 的 diff 逻辑对账。

### entry-point 插件：pip 装的插件

前三层插件是文件系统目录，第四层 entry-point 插件（`source="entrypoint"`）是 pip 安装的 Python 包。一个第三方包在自己的打包元数据里声明属于 `hermes_agent.plugins` 这个 entry-point group（`ENTRY_POINTS_GROUP`，`plugins.py:170`），`_scan_entry_points()`（`plugins.py:1137`）就能在已安装的包里发现它。

这一层让插件可以走标准 Python 生态分发——`pip install some-hermes-plugin` 就装好，不必手动往 `~/.hermes/plugins/` 拷文件。但它仍然受 `plugins.enabled` 白名单门控（entry-point 插件是 `standalone` 同等待遇的「未受信代码」），装了不等于会跑，还要显式 enable。

### 一个最小可用插件长什么样

把前面的 API 拼起来，一个能跑的工具插件只需两个文件。`~/.hermes/plugins/word-count/plugin.yaml`：

```text
name: word-count
version: "1.0.0"
description: Count words in a string
author: you
kind: standalone
provides_tools: ["word_count"]
```

`~/.hermes/plugins/word-count/__init__.py`：

```python
def register(ctx):
    schema = {
        "name": "word_count",
        "description": "Count the words in a piece of text.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    }

    def handler(args, **kwargs):
        return str(len((args.get("text") or "").split()))

    ctx.register_tool(
        name="word_count", toolset="word-count",
        schema=schema, handler=handler,
    )
```

放好文件后还要 `hermes plugins enable word-count`（把 `word-count` 写进 `plugins.enabled`）——`standalone` 插件是 opt-in 的。下次启动 `discover_and_load()` 会扫到它、导入模块、调 `register(ctx)`，`word_count` 工具就出现在 registry 里，和内置工具一样可被 agent 调用。要挂个 hook 把 `ctx.register_tool` 换成 `ctx.register_hook("post_tool_call", cb)` 即可，逻辑同理。

### MCP 与插件：能力对照

两套机制的边界，落到具体能力上：

| 能力 | MCP | 插件 |
|------|-----|------|
| 加工具 | 是（连别人写的 server） | 是（`register_tool`） |
| 加消息平台 | 否 | 是（`register_platform`） |
| 加模型 provider | 否 | 是（model-providers 插件） |
| 换记忆/压缩后端 | 否 | 是（exclusive / context_engine） |
| 挂生命周期 hook | 否 | 是（`register_hook`） |
| 跨进程/跨语言 | 是（标准协议，server 可任意语言） | 否（必须是 Python，同进程） |
| 复用现成生态 | 是（整个 MCP 生态） | 否（要按 Hermes 约定写） |
| 零代码接入 | 是（配置即用） | 否（至少写 `register()`） |

一句话：MCP 横向广（复用生态、跨语言、零代码），插件纵向深（能动核心子系统、能挂 hook，代价是必须按约定写 Python）。

## 12.6 加扩展时该选哪条路

`AGENTS.md` 给了明确建议，本节复述其取舍：

- **要加一个自定义/本地工具** → 走插件路。在 `~/.hermes/plugins/<name>/` 放 `plugin.yaml` + `__init__.py`，用 `ctx.register_tool(...)` 注册。不碰 Hermes 核心，可独立启停。
- **要接一个已有的第三方服务** → 看它有没有 MCP server。有就配 MCP，零代码。
- **要贡献一个应当随 Hermes 发行的核心工具** → 才走内置路（改 `tools/` + `toolsets.py`，见[第 5 章](05-tool-system.md)）。

设计哲学很清楚：核心保持精简，扩展靠四层插件 + MCP 生态外挂。绝大多数定制不该、也不需要触碰 Hermes 源码。

## 12.7 排障：常见症状与定位

MCP 和插件都是「外挂代码」，出问题时症状往往是「东西没出现」，而不是明确报错。按症状定位：

**MCP server 连不上 / 工具没出现。** 先看 `~/.hermes/logs/mcp-stderr.log`——stdio server 的子进程 stderr 都在这里，FastMCP 的 banner、依赖缺失、启动崩溃都能看到。再分情况：

- 报 `InvalidMcpUrlError` —— config 里 `url` 不是合法的 http(s) URL，启动时就被 `_validate_remote_mcp_url()` 挡下。
- 子进程起不来 `command not found` —— stdio 子进程跑在被过滤的 PATH 下；裸 `npx`/`node` 由 `_resolve_stdio_command()` 兜底，其他命令需在 config 里给绝对路径。
- 工具调用返回「server 不可达，N 秒后自动重试」—— 熔断器已打开，server 连续失败过多。这是设计行为，等冷却期、或修好 server。
- OAuth server 在后台进程里失败 —— 大概率是 `OAuthNonInteractiveError`：非交互环境无法弹浏览器。先在一个有桌面的交互会话里连一次完成授权，token 落盘后后台进程才能复用。

**MCP 工具调用慢或超时。** 工具超时默认 120 秒（`_DEFAULT_TOOL_TIMEOUT`），可在 config 按 server 调。SSE server 注意 `sse_read_timeout` 是 300 秒——空闲久不算故障。

**插件没生效。** 几乎总是这几个原因之一，按顺序排查：

```text
1. 没 enable          standalone/user backend/entrypoint 插件要写进
                      plugins.enabled —— 用 `hermes plugins enable <key>`
2. 被 disable         检查 plugins.disabled 里有没有它
3. 注册键写错         enable 用的 key 是路径派生的（image_gen/openai），
                      不是 name；用 `hermes plugins list` 看准确 key
4. register() 抛了异常 失败被隔离了，不会让启动崩 —— 看 hermes plugins list
                      里该插件的 error 字段
5. 缺 register()      __init__.py 里没有 register(ctx) 函数
```

`hermes plugins list` 是第一手段——它对每个发现到的插件显示 `enabled` 状态和 `error` 字符串。要看加载细节（来源、kind、路径、完整 traceback），设 `HERMES_PLUGINS_DEBUG=1` 再启动。

**插件工具显示为不可用。** 多半是 manifest 的 `requires_env` 或 `register_tool` 的 `requires_env` 声明的环境变量缺失——工具可用性检查（见[第 5 章](05-tool-system.md)）据此把它标灰。补上对应环境变量即可。

**同名插件覆盖不符预期。** 记住覆盖顺序是 bundled < user < project < entrypoint，后者覆盖前者。想覆盖一个 bundled 插件，在 `~/.hermes/plugins/` 放同名（同 `key`）插件即可。

---

## 延伸阅读

- MCP 工具与内置工具如何走同一条注册路径 → [第 5 章 工具系统：注册、工具集与分发](05-tool-system.md)
- 插件 provider 如何声明 `ProviderProfile` → [第 7 章 模型 Provider 适配与凭证池](07-model-providers.md)
- 记忆 provider 插件如何被发现加载 → [第 10 章 记忆系统与学习闭环](10-memory-system.md)
- 上下文引擎作为插件 → [第 8 章 上下文压缩与轨迹压缩](08-context-compression.md)
- 插件平台适配器如何注入网关 → [第 13 章 消息网关与多平台](13-messaging-gateway.md)
- MCP 后台 event loop 与同步主循环的边界 → [第 3 章 核心对话循环](03-conversation-loop.md)
