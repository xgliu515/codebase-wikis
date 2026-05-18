# 第 12 章 CLI 与 Server 架构

## 总览

llama.cpp 的工具程序全部位于 `tools/` 目录下。其中两个最核心的工具是:

- **llama-cli** (`tools/cli/cli.cpp`):交互式终端聊天客户端;
- **llama-server** (`tools/server/`):多请求并发推理 HTTP 服务器。

两者都复用 `common/` 胶水层,区别在于并发模型:llama-cli 是单用户单对话,llama-server 通过 slot 机制同时处理多路请求并执行连续批处理。

<svg viewBox="0 0 880 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="architecture comparison between llama-cli and llama-server">
  <defs>
    <marker id="ar12-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="880" height="300" fill="#f8fafc"/>
  <rect x="50" y="12" width="340" height="36" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="220" y="34" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama-cli</text>
  <rect x="490" y="12" width="340" height="36" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="660" y="34" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama-server</text>
  <line x1="220" y1="48" x2="220" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <line x1="660" y1="48" x2="660" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="70" y="74" width="300" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="220" y="92" text-anchor="middle" font-size="11" fill="#64748b">common_params_parse()</text>
  <rect x="510" y="74" width="300" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="660" y="92" text-anchor="middle" font-size="11" fill="#64748b">common_params_parse()</text>
  <line x1="220" y1="104" x2="220" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <line x1="660" y1="104" x2="660" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="200" y="128" width="460" height="36" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/>
  <text x="430" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">server_context  (两者共用同一推理引擎)</text>
  <text x="430" y="157" text-anchor="middle" font-size="10" fill="#64748b">load_model() + start_loop()</text>
  <line x1="300" y1="164" x2="220" y2="194" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <line x1="560" y1="164" x2="660" y2="194" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="60" y="194" width="320" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="220" y="211" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">CLI 交互循环</text>
  <text x="220" y="226" text-anchor="middle" font-size="10" fill="#64748b">readline → 任务 → 流式输出</text>
  <rect x="500" y="194" width="320" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="660" y="211" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">HTTP 路由层 (server-http.cpp)</text>
  <text x="660" y="226" text-anchor="middle" font-size="10" fill="#64748b">/v1/chat/completions 等</text>
</svg>
<span class="figure-caption">图 R12.1 ｜ llama-cli 与 llama-server 架构对比：共用 server_context 推理引擎，前端接入方式不同</span>

<details>
<summary>ASCII 原版</summary>

```
                     llama-cli                  llama-server
                        |                            |
              common_params_parse()       common_params_parse()
                        |                            |
              server_context::load_model()  (两者共用同一 server_context)
                        |                            |
            server_context::start_loop()   server_context::start_loop()
                        |                    HTTP 路由层 (server-http.cpp)
              CLI 交互循环                      /v1/chat/completions 等
```

</details>

---

## 12.1 llama-cli:main 流程

### 主函数结构

`tools/cli/cli.cpp` 的 `main()` 函数(约第 350 行起)流程如下:

```cpp
// tools/cli/cli.cpp:350
int main(int argc, char ** argv) {
    common_params params;
    common_init();                                     // 初始化日志
    common_params_parse(argc, argv, params,
                        LLAMA_EXAMPLE_CLI);            // 解析命令行

    cli_context ctx_cli(params);
    llama_backend_init();

    // 加载模型 (委托给 server_context)
    ctx_cli.ctx_server.load_model(params);

    // 推理在独立线程中运行
    std::thread inference_thread([&ctx_cli]() {
        ctx_cli.ctx_server.start_loop();
    });

    // 主线程: 交互循环
    while (true) { /* ... readline, process commands ... */ }
}
```

llama-cli 内嵌了一个完整的 `server_context`(`tools/cli/cli.cpp:57`),复用服务器的全部推理逻辑。这使得 CLI 天然具备投机解码、多模态、LoRA 热切换等所有服务端功能。

### cli_context

```cpp
// tools/cli/cli.cpp:56
struct cli_context {
    server_context ctx_server;   // 复用服务端推理引擎
    json messages;               // 对话历史 (OpenAI ChatML 格式 JSON)
    std::vector<raw_buffer> input_files;
    task_params defaults;
    bool verbose_prompt;
};
```

`defaults.stream = true` 确保 CLI 始终使用流式 token 回调,以便逐字打印输出。

### 交互循环

主线程的交互循环:

<svg viewBox="0 0 760 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama-cli interaction loop flow with command dispatch and generation">
  <defs>
    <marker id="ar12-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="440" fill="#f8fafc"/>
  <rect x="240" y="12" width="200" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="340" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">readline() 读取用户输入</text>
  <line x1="340" y1="46" x2="340" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="240" y="66" width="200" height="34" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="340" y="87" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">命令分发</text>
  <line x1="440" y1="83" x2="540" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="540" y="52" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="630" y="69" text-anchor="middle" font-size="10" fill="#64748b">/exit → break</text>
  <line x1="440" y1="83" x2="540" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="540" y="78" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="630" y="95" text-anchor="middle" font-size="10" fill="#64748b">/regen → 删除上一条重发</text>
  <line x1="440" y1="83" x2="540" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="540" y="104" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="630" y="121" text-anchor="middle" font-size="10" fill="#64748b">/clear → 重置 messages</text>
  <line x1="440" y1="83" x2="540" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="540" y="130" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="630" y="147" text-anchor="middle" font-size="10" fill="#64748b">/image → 插入 media marker</text>
  <line x1="440" y1="83" x2="540" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="540" y="156" width="180" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="630" y="173" text-anchor="middle" font-size="10" fill="#64748b">/read → 追加文件内容</text>
  <line x1="340" y1="100" x2="340" y2="126" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="170" y="126" width="340" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="144" text-anchor="middle" font-size="11" fill="#64748b">追加到 ctx_cli.messages</text>
  <line x1="340" y1="156" x2="340" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="100" y="180" width="480" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="300" y="198" text-anchor="middle" font-size="11" fill="#64748b">format_chat() → common_chat_templates_apply()</text>
  <text x="540" y="198" text-anchor="middle" font-size="11" fill="#0d9488">→ common_chat_params</text>
  <line x1="340" y1="210" x2="340" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="120" y="234" width="440" height="30" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="340" y="252" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">发送 SERVER_TASK_TYPE_COMPLETION 任务</text>
  <line x1="340" y1="264" x2="340" y2="288" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="120" y="288" width="440" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="306" text-anchor="middle" font-size="11" fill="#64748b">等待 server_response_reader::next() 返回 token</text>
  <line x1="340" y1="318" x2="340" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <rect x="200" y="342" width="280" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="340" y="361" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">逐 token 打印到终端</text>
  <path d="M 160 357 Q 60 357 60 83 Q 60 33 240 33" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar12-2)"/>
  <text x="42" y="200" text-anchor="middle" font-size="10" fill="#94a3b8" transform="rotate(-90 42 200)">下一轮</text>
</svg>
<span class="figure-caption">图 R12.2 ｜ llama-cli 交互循环：命令分发、模板渲染、任务提交与流式输出</span>

<details>
<summary>ASCII 原版</summary>

```
readline() 读取用户输入
    |
    +-- "/exit"   → break
    +-- "/regen"  → 删除上一条 assistant 消息,重新发请求
    +-- "/clear"  → 清空 ctx_cli.messages,重置 system prompt
    +-- "/image <path>" → 加载媒体文件,插入 media marker
    +-- "/read <file>"  → 读取文本文件内容追加到消息
    |
把用户输入追加到 ctx_cli.messages
format_chat() → common_chat_templates_apply() → common_chat_params
发送 SERVER_TASK_TYPE_COMPLETION 任务
等待 server_response_reader::next() 返回 token
逐 token 打印到终端
```

</details>

**Ctrl+C 处理**(`tools/cli/cli.cpp:44`):第一次 Ctrl+C 设置 `g_is_interrupted = true`,触发 `should_stop()` 返回 true,中断当前生成;第二次 Ctrl+C 立即退出进程。

### generate_completion 流程

`cli_context::generate_completion()`(`tools/cli/cli.cpp:80`)是 CLI 发起推理的核心函数:

```cpp
// tools/cli/cli.cpp:80
std::string generate_completion(result_timings & out_timings) {
    server_response_reader rd = ctx_server.get_response_reader();
    auto chat_params = format_chat();  // 渲染聊天模板

    server_task task = server_task(SERVER_TASK_TYPE_COMPLETION);
    task.params     = defaults;
    task.cli_prompt = chat_params.prompt;
    task.cli        = true;

    rd.post_task({std::move(task)});

    // 流式消费结果
    while ((result = rd.next(should_stop))) {
        auto * res_partial = dynamic_cast<server_task_result_cmpl_partial *>(...);
        // 处理 content_delta / reasoning_content_delta
    }
    return curr_content;
}
```

---

## 12.2 工具全景

`tools/` 目录下各子目录的用途:

| 目录 | 可执行文件 | 主要功能 |
|------|-----------|---------|
| `cli/` | `llama-cli` | 交互式终端对话 |
| `server/` | `llama-server` | HTTP 推理服务 |
| `quantize/` | `llama-quantize` | GGUF 模型量化 |
| `perplexity/` | `llama-perplexity` | 困惑度、HellaSwag、WinoGrande 评测 |
| `tokenize/` | `llama-tokenize` | 调试分词结果 |
| `llama-bench/` | `llama-bench` | 吞吐和延迟基准测试 |
| `imatrix/` | `llama-imatrix` | 收集重要性矩阵,用于量化校准 |
| `mtmd/` | `llama-mtmd-cli` | 多模态(视觉/语音)推理 |
| `batched-bench/` | `llama-batched-bench` | 批处理吞吐测试 |
| `completion/` | `llama-completion` | 单次文本补全(无对话循环) |
| `cvector-generator/` | `llama-cvector-generator` | 激活引导控制向量生成 |
| `export-lora/` | `llama-export-lora` | 将 LoRA 权重合并进基础模型 |
| `gguf-split/` | `llama-gguf-split` | GGUF 文件分片/合并 |
| `rpc/` | `llama-rpc-server` | RPC 后端服务 |
| `tts/` | `llama-tts` | 文本转语音 |

`tools/CMakeLists.txt` 统一管理上述工具的构建,每个工具都链接 `libcommon` 和 `libllama`。

---

## 12.3 llama-server 总体架构

### 启动流程

`tools/server/server.cpp` 的 `main()` 函数是 llama-server 的入口:

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama-server startup sequence with HTTP starting before model load">
  <defs>
    <marker id="ar12-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="300" fill="#f8fafc"/>
  <rect x="270" y="12" width="120" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="330" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">main()</text>
  <line x1="330" y1="44" x2="330" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="130" y="64" width="260" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="240" y="81" text-anchor="middle" font-size="11" fill="#64748b">common_params_parse()</text>
  <text x="420" y="81" text-anchor="start" font-size="10" fill="#94a3b8">解析参数</text>
  <line x1="330" y1="92" x2="330" y2="112" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="130" y="112" width="260" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="240" y="129" text-anchor="middle" font-size="11" fill="#64748b">server_http_context::init()</text>
  <text x="420" y="129" text-anchor="start" font-size="10" fill="#94a3b8">创建 HTTP 服务器</text>
  <line x1="330" y1="140" x2="330" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="130" y="160" width="260" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="240" y="177" text-anchor="middle" font-size="11" fill="#64748b">server_routes 注册所有路由</text>
  <text x="420" y="177" text-anchor="start" font-size="10" fill="#94a3b8">绑定 handler 函数</text>
  <line x1="330" y1="188" x2="330" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="130" y="208" width="260" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="240" y="225" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">ctx_http.start()</text>
  <text x="420" y="225" text-anchor="start" font-size="10" fill="#94a3b8">启动 HTTP 监听（独立线程）</text>
  <text x="680" y="212" text-anchor="middle" font-size="10" fill="#16a34a">/health 已可响应</text>
  <text x="680" y="226" text-anchor="middle" font-size="10" fill="#16a34a">status: loading</text>
  <line x1="330" y1="236" x2="330" y2="256" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="100" y="256" width="320" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="240" y="273" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ctx_server.load_model() → start_loop()</text>
  <text x="450" y="273" text-anchor="start" font-size="10" fill="#94a3b8">阻塞主线程</text>
</svg>
<span class="figure-caption">图 R12.3 ｜ llama-server 启动流程：HTTP 在模型加载前启动，确保健康检查端点可用</span>

<details>
<summary>ASCII 原版</summary>

```
main()
  |
  +-- common_params_parse()          解析参数
  +-- server_http_context::init()    创建 HTTP 服务器
  +-- server_routes 注册所有路由     绑定 handler 函数
  +-- ctx_http.start()               启动 HTTP 监听(独立线程)
  +-- ctx_server.load_model()        加载模型(主线程)
  +-- ctx_server.start_loop()        推理主循环(阻塞主线程)
```

</details>

HTTP 服务器在模型加载**之前**启动,这样 `/health` 端点可以及时返回 `loading` 状态,防止负载均衡器误判。

### 两种运行模式

**单模型模式** (`is_router_server = false`):加载单一模型,`server_context` 直接处理请求。

**路由器模式** (`is_router_server = true`,`params.model.path` 为空):

<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama-server router mode managing multiple single-model child processes">
  <defs>
    <marker id="ar12-4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="640" height="200" fill="#f8fafc"/>
  <rect x="190" y="12" width="260" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama-server (路由器模式)</text>
  <text x="320" y="42" text-anchor="middle" font-size="10" fill="#64748b">无模型 / is_router_server = true</text>
  <line x1="320" y1="48" x2="320" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-4)"/>
  <rect x="190" y="72" width="260" height="30" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="320" y="91" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">server_models_routes</text>
  <line x1="220" y1="102" x2="120" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-4)"/>
  <line x1="320" y1="102" x2="320" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-4)"/>
  <line x1="420" y1="102" x2="520" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-4)"/>
  <rect x="40" y="138" width="160" height="42" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="120" y="157" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">子进程1</text>
  <text x="120" y="172" text-anchor="middle" font-size="10" fill="#64748b">单模型 llama-server</text>
  <rect x="240" y="138" width="160" height="42" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="320" y="157" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">子进程2</text>
  <text x="320" y="172" text-anchor="middle" font-size="10" fill="#64748b">单模型 llama-server</text>
  <rect x="440" y="138" width="160" height="42" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="520" y="157" text-anchor="middle" font-size="11" fill="#94a3b8">子进程 N</text>
  <text x="520" y="172" text-anchor="middle" font-size="10" fill="#94a3b8">LRU 自动卸载</text>
</svg>
<span class="figure-caption">图 R12.4 ｜ 路由器模式：父进程无模型，管理多个独立单模型子进程，支持 LRU 卸载</span>

<details>
<summary>ASCII 原版</summary>

```
llama-server (no model)
       |
  server_models_routes
       |        |
  子进程1    子进程2    ...  (每个子进程是独立的单模型 llama-server 实例)
```

</details>

路由器通过 `server_models`(`tools/server/server-models.h:89`)管理子进程池,支持按 LRU 自动卸载、按 `models_max` 限制并发实例数。路由策略通过 HTTP 代理实现(`proxy_get`/`proxy_post` handler)。

### 路由表

完整路由注册见 `tools/server/server.cpp:173-207`,主要端点:

```cpp
ctx_http.get ("/health",                   ...);
ctx_http.get ("/metrics",                  ...);
ctx_http.post("/completion",               ...); // legacy
ctx_http.post("/completions",              ...);
ctx_http.post("/v1/completions",           ...);
ctx_http.post("/chat/completions",         ...);
ctx_http.post("/v1/chat/completions",      ...);
ctx_http.post("/v1/responses",             ...); // OpenAI Responses API
ctx_http.post("/v1/audio/transcriptions",  ...);
ctx_http.post("/v1/messages",              ...); // Anthropic Messages API
ctx_http.post("/infill",                   ...);
ctx_http.post("/embeddings",               ...);
ctx_http.post("/v1/embeddings",            ...);
ctx_http.post("/rerank",                   ...);
ctx_http.post("/tokenize",                 ...);
ctx_http.get ("/slots",                    ...);
ctx_http.post("/slots/:id_slot",           ...);
```

所有 handler 都包裹在 `ex_wrapper()` 中(`tools/server/server.cpp:40`),捕获异常并转换为标准 JSON 错误响应,防止异常泄露到 HTTP 框架。

---

## 12.4 Slot 机制

### Slot 是什么

一个 **slot**(`server_slot`,定义于 `tools/server/server-context.cpp:54`)代表一个独立的推理序列。`n_parallel` 个 slot 共享同一个 `llama_context`,通过多序列 KV cache 相互隔离。

```cpp
// tools/server/server-context.cpp:54
struct server_slot {
    int id;                       // slot 索引,同时作为 llama_seq_id
    llama_context * ctx_tgt;
    llama_context * ctx_dft;      // 草稿模型上下文(投机解码)
    common_speculative * spec;

    std::unique_ptr<const server_task> task; // 当前绑定的任务
    int64_t t_last_used = -1;     // LRU 时间戳

    int32_t n_ctx;      // 本 slot 的上下文窗口大小
    int32_t n_decoded;  // 已生成 token 数
    int32_t n_remaining;

    std::string  generated_text;
    llama_tokens generated_tokens;

    slot_state state = SLOT_STATE_IDLE;
    server_prompt prompt;  // 当前 slot 持有的 KV 缓存 prompt
};
```

### Slot 状态机

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="server slot state machine from IDLE through GENERATING back to IDLE">
  <defs>
    <marker id="ar12-5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar12-5o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
    <marker id="ar12-5g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="400" fill="#f8fafc"/>
  <rect x="50" y="30" width="110" height="40" rx="20" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="105" y="55" text-anchor="middle" font-size="13" font-weight="700" fill="#16a34a">IDLE</text>
  <line x1="160" y1="50" x2="540" y2="50" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ar12-5o)"/>
  <text x="350" y="43" text-anchor="middle" font-size="10" fill="#ea580c">assign task</text>
  <rect x="540" y="30" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="600" y="55" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">STARTED</text>
  <line x1="600" y1="70" x2="600" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-5)"/>
  <text x="630" y="93" text-anchor="start" font-size="10" fill="#94a3b8">process_single_task()</text>
  <line x1="560" y1="110" x2="400" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-5)"/>
  <text x="450" y="126" text-anchor="middle" font-size="10" fill="#94a3b8">parent not ready</text>
  <rect x="280" y="140" width="150" height="36" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="355" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">WAIT_OTHER</text>
  <line x1="430" y1="158" x2="570" y2="140" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar12-5)"/>
  <text x="510" y="148" text-anchor="middle" font-size="10" fill="#94a3b8">parent done</text>
  <line x1="600" y1="110" x2="600" y2="190" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-5)"/>
  <rect x="490" y="190" width="220" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="600" y="212" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">PROCESSING_PROMPT</text>
  <line x1="600" y1="226" x2="600" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-5)"/>
  <rect x="490" y="270" width="220" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="600" y="292" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">DONE_PROMPT</text>
  <line x1="600" y1="306" x2="600" y2="348" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-5)"/>
  <rect x="490" y="348" width="220" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="600" y="370" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">GENERATING</text>
  <path d="M 490 366 Q 160 366 105 360 Q 70 356 70 90 Q 70 70 50 70" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#ar12-5g)"/>
  <text x="200" y="380" text-anchor="middle" font-size="10" fill="#0d9488">has_next_token = false → release()</text>
</svg>
<span class="figure-caption">图 R12.5 ｜ server_slot 状态机：IDLE → STARTED → PROCESSING_PROMPT → GENERATING → IDLE</span>

<details>
<summary>ASCII 原版</summary>

```
                             assign task
   IDLE ──────────────────────────────────────────► STARTED
    ^                                                   |
    |  release()                              process_single_task()
    |                                                   |
    |              WAIT_OTHER ◄─── parent not ready ────┤
    |                  |                                |
    |                  └──── parent done ───────────────┘
    |                                                   |
    |                                         PROCESSING_PROMPT
    |                                                   |
    |                                          DONE_PROMPT
    |                                                   |
    |                                          GENERATING
    |                                                   |
    └───────────────── has_next_token = false ──────────┘
```

</details>

状态定义于 `tools/server/server-context.cpp:40`:

```cpp
enum slot_state {
    SLOT_STATE_IDLE,
    SLOT_STATE_WAIT_OTHER,        // 等待父 slot 完成 prompt 处理
    SLOT_STATE_STARTED,
    SLOT_STATE_PROCESSING_PROMPT,
    SLOT_STATE_DONE_PROMPT,
    SLOT_STATE_GENERATING,
};
```

### 任务分配到 Slot

`get_available_slot(task)` (`tools/server/server-context.cpp:1114`)按两步选择 slot:

**步骤 1 — LCP 相似度匹配**:如果新请求的 prompt token 序列与某个空闲 slot 的缓存 prompt 有足够长的最长公共前缀(LCP),优先选择该 slot。好处是跳过已缓存部分,只 prefill 新增 token。

```cpp
// tools/server/server-context.cpp:1137
const float sim_cur = float(tokens.get_common_prefix(task.tokens))
                      / task.tokens.size();
if (sim_cur > sim_best && sim_cur > slot_prompt_similarity) {
    ret = &slot;
}
```

**步骤 2 — LRU 兜底**:若无相似 slot,选最久未使用(t_last_used 最小)的空闲 slot。

若更换 slot 会导致丢失大量缓存(f_keep < 0.5),则先把原 slot 状态保存到 `prompt_cache`,再从缓存恢复最接近新请求的前缀。

### `server_queue` 任务队列

`server_queue`(`tools/server/server-queue.h:13`)维护两个双端队列:

- `queue_tasks`:就绪队列;
- `queue_tasks_deferred`:等待 slot 的延迟队列。

当一个 slot 完成任务(`slot.release()` → `callback_on_release()`)时,`pop_deferred_task(id_slot)` 从延迟队列取出一个任务移入就绪队列,优先选择期望使用该 slot 的任务。

---

## 12.5 连续批处理

连续批处理(Continuous Batching)是 llama-server 高吞吐的核心机制:每次 `update_slots()` 调用时,把**所有正在处理的 slot**的 token 合并到一个 `llama_batch`,一次性调用 `llama_decode()`,而不是逐请求串行处理。

### 批次构建

`update_slots()`(`tools/server/server-context.cpp:2173`)是主循环的核心:

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="update_slots continuous batching core loop steps 1 through 8">
  <defs>
    <marker id="ar12-6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="520" fill="#f8fafc"/>
  <rect x="270" y="10" width="220" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="380" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">update_slots()</text>
  <line x1="380" y1="44" x2="380" y2="64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="100" y="64" width="460" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="82" text-anchor="middle" font-size="11" fill="#64748b">① 检查所有 slot 是否空闲</text>
  <text x="560" y="82" text-anchor="middle" font-size="10" fill="#94a3b8">→ 若是则返回</text>
  <line x1="380" y1="94" x2="380" y2="114" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="100" y="114" width="460" height="30" rx="5" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="370" y="132" text-anchor="middle" font-size="11" fill="#64748b">② context shift: GENERATING slot 执行滑动窗口</text>
  <line x1="380" y1="144" x2="380" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="100" y="164" width="460" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="290" y="182" text-anchor="middle" font-size="11" fill="#64748b">③ common_batch_clear(batch)</text>
  <text x="520" y="182" text-anchor="middle" font-size="10" fill="#94a3b8">清空批次</text>
  <line x1="380" y1="194" x2="380" y2="214" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="60" y="214" width="600" height="46" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="370" y="233" text-anchor="middle" font-size="11" fill="#64748b">④ 遍历 GENERATING slot → slot.update_batch(batch)</text>
  <text x="370" y="250" text-anchor="middle" font-size="10" fill="#94a3b8">common_batch_add(batch, sampled, pos, seq_id, logits=true)  +  [投机解码] 追加草稿 token</text>
  <line x1="380" y1="260" x2="380" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="60" y="280" width="600" height="46" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="370" y="299" text-anchor="middle" font-size="11" fill="#64748b">⑤ 遍历 PROCESSING_PROMPT slot → 追加 prompt token</text>
  <text x="370" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">logits=false，只有最后一个 token 为 true</text>
  <line x1="380" y1="326" x2="380" y2="346" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="100" y="346" width="460" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="2"/>
  <text x="310" y="365" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">⑥ llama_decode(ctx_tgt, batch_view)</text>
  <text x="550" y="365" text-anchor="middle" font-size="10" fill="#0d9488">提交整批 token</text>
  <line x1="380" y1="378" x2="380" y2="398" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="60" y="398" width="600" height="46" rx="5" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="370" y="417" text-anchor="middle" font-size="11" fill="#64748b">⑦ 逐 slot 采样: common_sampler_sample() → process_token()</text>
  <text x="370" y="434" text-anchor="middle" font-size="10" fill="#94a3b8">发送 partial response / final response</text>
  <line x1="380" y1="444" x2="380" y2="464" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-6)"/>
  <rect x="100" y="464" width="460" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="482" text-anchor="middle" font-size="11" fill="#64748b">⑧ [投机解码] common_speculative_accept()</text>
  <text x="555" y="482" text-anchor="middle" font-size="10" fill="#94a3b8">告知接受了多少草稿 token</text>
</svg>
<span class="figure-caption">图 R12.6 ｜ update_slots() 连续批处理核心循环：将多 slot token 合并成单批提交，线性提升吞吐</span>

<details>
<summary>ASCII 原版</summary>

```
update_slots()
  |
  1. 检查所有 slot 是否空闲 → 若是则返回
  |
  2. context shift: 对超出 n_ctx 的 GENERATING slot 执行滑动窗口
  |
  3. common_batch_clear(batch)    清空批次
  |
  4. 遍历处于 GENERATING 状态的 slot:
  |     slot.update_batch(batch)  → common_batch_add(batch, sampled, pos, seq_id, logits=true)
  |     [投机解码] 追加草稿 token
  |
  5. 遍历处于 PROCESSING_PROMPT 状态的 slot:
  |     追加 prompt token 到 batch (logits=false,只有最后一个 token 为 true)
  |
  6. llama_decode(ctx_tgt, batch_view)   提交整批 token
  |
  7. 逐 slot 采样: common_sampler_sample() → process_token()
  |     发送 partial response / final response
  |
  8. [投机解码] common_speculative_accept() 告知接受了多少草稿 token
```

</details>

**为什么能提升吞吐:**GPU/CPU 的矩阵乘法对批大小不敏感(batch size 1 和 batch size N 的算子执行时间接近),将多个序列打包进一个 batch 几乎不增加延迟,却使单位时间内吞吐量线性提升。

### KV Cache 多序列配合

每个 slot 使用独立的 `llama_seq_id`(等于 `slot.id`)。`common_batch_add()` 在添加 token 时指定所属 seq_id:

```cpp
// common/common.h:916
void common_batch_add(
    struct llama_batch & batch,
    llama_token          id,
    llama_pos            pos,
    const std::vector<llama_seq_id> & seq_ids,
    bool                 logits);
```

KV cache 通过 seq_id 隔离,不同 slot 的 KV 互不干扰。`kv_unified` 模式启用统一 KV cache(`--kv-unified`),减少碎片化,并支持 idle slot 缓存持久化(`--cache-idle-slots`)。

### 投机解码与批处理的配合

投机解码时,`server_slot::update_batch(batch)` 额外追加草稿 token(`tools/server/server-context.cpp:324`):

```cpp
// tools/server/server-context.cpp:324
void update_batch(llama_batch & batch) {
    if (spec_draft.empty()) {
        i_batch = batch.n_tokens;
        common_batch_add(batch, sampled, pos_next(), {this->id}, true);
    } else {
        // 追加 sampled + draft tokens,同属一个 seq_id
        common_batch_add(batch, sampled, pos0++, {this->id}, true);
        for (auto token : spec_draft) {
            common_batch_add(batch, token, pos0++, {this->id}, true);
        }
    }
}
```

目标模型一次性为 1 + n_draft 个位置计算 logits,再由 `common_sampler_sample_and_accept_n()` 批量验证草稿,接受的 token 数通过 `common_speculative_accept()` 反馈。

---

## 12.6 HTTP API

### /completions 和 /v1/chat/completions

`post_completions` 和 `post_chat_completions` 路由都调用 `handle_completions_impl()`。区别在于:

- `/completions`:原始文本补全,不经过聊天模板渲染;
- `/v1/chat/completions`:解析 `messages` 数组,经 `common_chat_templates_apply()` 渲染,结果包含 `choices[].message`。

### 流式 SSE 响应

当请求携带 `"stream": true` 时,服务器以 Server-Sent Events 格式推送:

```text
data: {"id":"...","choices":[{"delta":{"content":"Hello"}}],...}

data: {"id":"...","choices":[{"delta":{"content":" world"}}],...}

data: [DONE]
```

`send_partial_response()` 每生成一个 token 就向 `queue_results` 投递 `server_task_result_cmpl_partial`,HTTP 响应线程从中读取并立即 flush 到客户端。

### /v1/embeddings

```http
POST /v1/embeddings
{"input": "Hello world", "model": "...", "encoding_format": "float"}
```

路由 `post_embeddings_oai` 处理,最终调用 `send_embedding()`(`tools/server/server-context.cpp:1707`)从 `llama_get_embeddings_seq()` 读取池化后的 embedding 向量。

### /health

```http
GET /health
→ {"status": "ok"}           (模型已就绪)
→ {"status": "loading model"} (加载中)
→ {"status": "no slot available", ...} (所有 slot 繁忙)
```

是唯一不需要 API key 的端点,设计为负载均衡健康检查使用。

### /metrics

Prometheus 格式的 metrics 端点(需 `--metrics` 开启):

```
llama_prompt_tokens_total
llama_tokens_predicted_total
llama_n_decode_total
llama_requests_processing
...
```

---

## 12.7 OpenAI 兼容层

`tools/server/server-chat.cpp` 实现了三套兼容转换:

| 函数 | 说明 |
|------|------|
| `server_chat_convert_responses_to_chatcmpl()` | OpenAI Responses API → Chat Completions 格式 |
| `server_chat_convert_anthropic_to_oai()` | Anthropic Messages API → Chat Completions 格式 |
| `convert_transcriptions_to_chatcmpl()` | 语音转录 API → Chat Completions 格式 |
| `server_chat_msg_diff_to_json_oaicompat()` | 流式 delta → OpenAI streaming chunk |

这些转换函数在进入统一的 `handle_completions_impl()` 之前执行,使得不同 API 的前端路由共享同一套后端推理逻辑。

`task_response_type` 枚举(`tools/server/server-task.h:33`)决定最终响应的序列化格式:

```cpp
enum task_response_type {
    TASK_RESPONSE_TYPE_NONE,       // llama.cpp 原生格式
    TASK_RESPONSE_TYPE_OAI_CHAT,   // OpenAI Chat Completions
    TASK_RESPONSE_TYPE_OAI_CMPL,   // OpenAI Completions
    TASK_RESPONSE_TYPE_OAI_RESP,   // OpenAI Responses API
    TASK_RESPONSE_TYPE_OAI_ASR,    // 语音转录
    TASK_RESPONSE_TYPE_OAI_EMBD,   // Embeddings
    TASK_RESPONSE_TYPE_ANTHROPIC,  // Anthropic Messages
};
```

---

## 12.8 多模型管理

### server_models

`server_models`(`tools/server/server-models.h:89`)通过 `subprocess_s` 管理子进程池,支持:

- **按需加载**:请求到来时若模型未加载则自动启动子进程;
- **LRU 卸载**:`unload_lru()` 在超出 `models_max` 时卸载最久未用的实例;
- **Sleeping 状态**:子进程闲置超时后进入 sleep 状态(`--sleep-idle-seconds`),释放 GPU 内存但保持进程存活。子进程通过 `server_models::notify_router_sleeping_state()` 通知路由器更新状态。

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="server_models model lifecycle state machine: UNLOADED LOADING LOADED SLEEPING">
  <defs>
    <marker id="ar12-7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar12-7r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker>
    <marker id="ar12-7b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0ea5e9"/></marker>
  </defs>
  <rect x="0" y="0" width="760" height="220" fill="#f8fafc"/>
  <rect x="40" y="80" width="120" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="100" y="105" text-anchor="middle" font-size="12" font-weight="700" fill="#64748b">UNLOADED</text>
  <line x1="160" y1="100" x2="225" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12-7)"/>
  <rect x="225" y="80" width="120" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="285" y="105" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">LOADING</text>
  <line x1="345" y1="100" x2="415" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar12-7)"/>
  <path d="M 285 120 Q 285 155 100 155 Q 40 155 40 120" fill="none" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar12-7r)"/>
  <text x="190" y="170" text-anchor="middle" font-size="10" fill="#dc2626">failed</text>
  <rect x="415" y="80" width="120" height="40" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="475" y="105" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">LOADED</text>
  <line x1="535" y1="100" x2="595" y2="100" stroke="#0ea5e9" stroke-width="1.2" marker-end="url(#ar12-7b)"/>
  <text x="565" y="93" text-anchor="middle" font-size="10" fill="#0ea5e9">sleeping</text>
  <rect x="595" y="80" width="120" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="655" y="105" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">SLEEPING</text>
  <line x1="655" y1="80" x2="655" y2="50" stroke="#0ea5e9" stroke-width="1.2"/>
  <line x1="475" y1="80" x2="475" y2="50" stroke="#0ea5e9" stroke-width="1.2"/>
  <line x1="475" y1="50" x2="655" y2="50" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="565" y="43" text-anchor="middle" font-size="10" fill="#0ea5e9">wakeup (request arrives)</text>
  <path d="M 595 100 Q 475 140 100 140 Q 40 140 40 120" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar12-7)"/>
  <text x="350" y="155" text-anchor="middle" font-size="10" fill="#94a3b8">unloaded (LRU)</text>
</svg>
<span class="figure-caption">图 R12.7 ｜ 多模型管理状态机：UNLOADED → LOADING → LOADED ⇄ SLEEPING，LRU 触发卸载</span>

<details>
<summary>ASCII 原版</summary>

```
UNLOADED ──► LOADING ──► LOADED ◄──── SLEEPING
  ^             |           |               ^
  └──failed─────┘           └──sleeping─────┘
  ^                                         |
  └──────────────unloaded───────────────────┘
```

</details>

模型元数据通过 `server_model_meta` 持久化,包括预设参数(`common_preset`)、别名集合、标签、上次使用时间。

### 子进程通信

子进程初始化完成后通过 stdin 向父进程发送 JSON 状态报告,父进程监控线程解析并调用 `update_status()` / `update_loaded_info()` 更新状态(`tools/server/server-models.h:170`):

```cpp
static std::thread setup_child_server(
    const std::function<void(int)> & shutdown_handler,
    const json & model_info);
```

路由器的代理 handler(`proxy_get`/`proxy_post`)使用 `server_http_proxy`(`tools/server/server-models.h:214`)将 HTTP 请求转发到子进程监听端口,响应通过流式读取透传给原始客户端。

---

## 12.9 WebUI 与前端

llama-server 自带 WebUI 前端,位于 `tools/ui/`(独立的 Vite/Svelte 项目),编译产物通过 CMake 内嵌为 C++ 字节数组,在服务器启动时作为静态资源服务。

相关参数:

- `--ui` / `--no-ui`:启用/禁用内置 WebUI(默认启用);
- `--ui-mcp-proxy`:启用 MCP CORS 代理(实验性,用于 WebUI 调用外部 MCP 工具);
- `--ui-config-json`:以 JSON 字符串传入 WebUI 配置覆盖。

`server_context_meta::json_ui_settings`(`tools/server/server-context.h:24`)通过 `/props` 端点返回给前端,前端据此决定显示哪些功能模块。

---

## 12.10 server_response_reader:请求生命周期

`server_response_reader`(`tools/server/server-queue.h:164`)封装了从发起任务到接收所有结果的完整生命周期:

```cpp
// tools/server/server-queue.h:164
struct server_response_reader {
    std::unordered_set<int> id_tasks;
    server_queue    & queue_tasks;
    server_response & queue_results;

    void post_task(server_task && task, bool front = false);
    server_task_result_ptr next(const std::function<bool()> & should_stop);
    batch_response wait_for_all(...);
    void stop(); // 取消所有待处理任务
};
```

对象析构时自动调用 `stop()`,向服务器发送 `SERVER_TASK_TYPE_CANCEL` 任务,防止客户端断开后 slot 继续无效生成浪费资源。

HTTP handler 持有 `server_response_reader` 的生命周期与 HTTP 连接绑定:连接断开 → handler 作用域退出 → `reader` 析构 → 自动取消。CLI 的 `generate_completion()` 亦依赖此机制中断 Ctrl+C 后的生成。
