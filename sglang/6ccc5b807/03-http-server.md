# 第 03 章 HTTP 服务器与 OpenAI 兼容 API

## 本章导读

[第 02 章](02-frontend-language.md) 讲的 SGLang DSL 是「前端语言」的一种用法——程序化地编排 LLM 调用。但绝大多数生产部署面对的是另一种入口:**一个 HTTP 服务**,接收 OpenAI 格式的请求,返回 OpenAI 格式的响应,让任何已经接了 OpenAI SDK 的应用无缝切到 SGLang。

本章讲清这个 HTTP 层:它是什么、和离线 `Engine` 是什么关系、一个 `/v1/chat/completions` 请求从 socket 进来到响应出去经过了哪些代码。

一句话定位:**SGLang 的 HTTP 服务器 = 一个 FastAPI 应用 + 一个 `TokenizerManager`**。它本身不做推理,只做协议转换和请求转发——真正干活的是 [第 04 章](04-engine-and-processes.md) 讲的三进程引擎。

## 1. 为什么需要一个独立的 HTTP 层

离线 `Engine`(第 04 章)已经能跑推理了——`Engine(...).generate(...)` 就能出结果。那为什么还要 HTTP 层?

因为部署形态不同:

- 离线 `Engine` 是**库**——你写 Python 脚本,在脚本进程里直接调它。适合批量离线推理、评测。
- HTTP 服务器是**服务**——它常驻、监听端口,任意语言的客户端通过网络请求它。适合在线 serving。

而且,业界事实标准是 **OpenAI 的 API 格式**。无数应用、框架、SDK 都按 OpenAI 的 `/v1/chat/completions` 协议写好了。如果 SGLang 暴露一个**兼容 OpenAI 的 HTTP 接口**,这些应用改一个 `base_url` 就能切过来,迁移成本几乎为零。

所以 HTTP 层的核心职责有两个:

1. **常驻服务化**:把 `Engine` 包成一个监听端口的 web 服务;
2. **协议适配**:把 OpenAI 格式的请求翻译成 SGLang 内部的 `GenerateReqInput`,把内部输出翻译回 OpenAI 格式。

## 2. 整体结构:FastAPI + TokenizerManager

HTTP 服务器的代码主体在 `python/sglang/srt/entrypoints/http_server.py`(约 2361 行)。它基于 **FastAPI** 框架。

<svg viewBox="0 0 600 372" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="HTTP server structure: FastAPI app wrapping TokenizerManager">
<defs>
<marker id="r3aar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="160" y="14" width="280" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="300" y="35" text-anchor="middle" font-size="11" fill="currentColor">HTTP 客户端（OpenAI SDK / curl）</text>
<line x1="300" y1="48" x2="300" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3aar)"/>
<text x="312" y="65" font-size="10" fill="#94a3b8">POST /v1/chat/completions</text>
<rect x="80" y="74" width="440" height="158" rx="10" fill="none" stroke="#ea580c" stroke-width="1.5"/>
<text x="100" y="94" font-size="11" font-weight="700" fill="currentColor">FastAPI app（http_server.py，主进程）</text>
<rect x="100" y="104" width="400" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
<text x="120" y="125" font-size="11" fill="currentColor">路由层　@app.post / @app.get</text>
<rect x="100" y="144" width="400" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
<text x="120" y="165" font-size="11" fill="currentColor">OpenAI 适配层　OpenAIServingChat 等（协议转换）</text>
<rect x="100" y="184" width="400" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
<text x="120" y="205" font-size="11" fill="currentColor">TokenizerManager（转发给引擎）</text>
<line x1="300" y1="232" x2="300" y2="256" stroke="#94a3b8" stroke-width="1.2"/>
<text x="312" y="250" font-size="10" fill="#94a3b8">ZMQ IPC</text>
<line x1="180" y1="256" x2="420" y2="256" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="180" y1="256" x2="180" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3aar)"/>
<line x1="420" y1="256" x2="420" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r3aar)"/>
<rect x="90" y="298" width="180" height="42" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="180" y="324" text-anchor="middle" font-size="11" fill="currentColor">Scheduler 子进程</text>
<rect x="330" y="298" width="180" height="42" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.3"/>
<text x="420" y="324" text-anchor="middle" font-size="11" fill="currentColor">Detokenizer 子进程</text>
</svg>
<span class="figure-caption">图 R3.1 ｜ HTTP 服务器结构：FastAPI 应用 = 路由层 + OpenAI 适配层 + TokenizerManager，底下接三进程引擎</span>

<details>
<summary>ASCII 原版</summary>

```text
   HTTP 客户端 (OpenAI SDK / curl / ...)
            │  POST /v1/chat/completions
            ▼
   ┌─────────────────────────────────────────┐
   │  FastAPI app  (http_server.py)           │
   │  ┌─────────────────────────────────────┐ │
   │  │ 路由层: @app.post/@app.get          │ │
   │  ├─────────────────────────────────────┤ │
   │  │ OpenAI 适配层: OpenAIServingChat 等 │ │  协议转换
   │  ├─────────────────────────────────────┤ │
   │  │ TokenizerManager                    │ │  转发给引擎
   │  └─────────────────────────────────────┘ │
   └───────────────────┬─────────────────────┘
                       │ ZMQ IPC
              ┌────────┴─────────┐
              ▼                  ▼
        Scheduler 子进程   Detokenizer 子进程
```

</details>

注意:FastAPI app、OpenAI 适配层、`TokenizerManager` **全在同一个主进程里**——和离线 `Engine` 把 `TokenizerManager` 留在主进程是完全一样的安排(见 [第 04 章](04-engine-and-processes.md))。真正的推理在 Scheduler / Detokenizer 子进程,靠 ZMQ 通信。

### 全局状态 `_GlobalState`

FastAPI 的请求处理函数需要访问 `TokenizerManager`、各种 serving 适配器。SGLang 用一个 `_GlobalState`(`http_server.py:190`)把它们装在一起,通过 `set_global_state` / `get_global_state`(`:199`、`:204`)存取。

### 应用生命周期 `lifespan`

FastAPI app 在 `http_server.py:403` 处构造,绑定了一个 `lifespan`(`:286`)异步上下文管理器。`lifespan` 在服务**启动时**做初始化(创建 `TokenizerManager`、拉起 Scheduler / Detokenizer 子进程、构造 OpenAI serving 适配器,如 `:319` 的 `OpenAIServingChat`),在服务**关闭时**做清理。这就是「服务常驻」的骨架——`lifespan` 之内,引擎一直活着。

## 3. 启动入口:从命令行到 ServerArgs

最常见的启动方式:

```bash
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --port 30000
```

它对应 `python/sglang/launch_server.py`(仅 71 行):

```python
# launch_server.py:66
server_args = prepare_server_args(sys.argv[1:])
...
run_server(server_args)
```

`prepare_server_args`(来自 `python/sglang/srt/server_args.py`)用 `argparse` 解析命令行参数,产出一个 `ServerArgs` 对象——和离线 `Engine` 里 `ServerArgs(**kwargs)` 殊途同归。这印证了 [第 04 章](04-engine-and-processes.md#serverargs) 的要点:**`ServerArgs` 是全系统的单一配置真相**,不管你从命令行进还是从 Python kwargs 进,最后都收敛到它。

`run_server`(`launch_server.py:15`)拿着 `server_args` 启动 uvicorn,把 FastAPI app 跑起来。

## 4. 原生路由

HTTP 服务器除了 OpenAI 兼容接口,还有一组 SGLang **原生路由**,直接对应内部能力。主要的几个:

| 路由 | 方法 | 作用 | 代码位置 |
|------|------|------|----------|
| `/generate` | POST | SGLang 原生生成接口,请求体直接是 `GenerateReqInput` | `http_server.py:705` |
| `/health` `/health_generate` | GET | 健康检查 | `http_server.py:505-507` |
| `/get_model_info` `/model_info` | GET | 模型信息 | `http_server.py:580`、`:590` |
| `/get_server_info` | GET | 服务运行状态 | `http_server.py:620` |
| `/abort_request` | POST | 中止一个进行中的请求 | `http_server.py:1403` |
| `/update_weights_from_*` | POST | 热更新权重(RLHF 等场景) | `http_server.py:1039` 起 |

`/generate` 是最能说明问题的一个。它的请求体类型直接就是内部对象 `GenerateReqInput`——没有任何协议转换:

```python
# http_server.py:705
async def generate_request(obj: GenerateReqInput, request: Request):
    """Handle a generate request."""
    if obj.stream:
        async def stream_results() -> AsyncIterator[bytes]:
            async for out in _global_state.tokenizer_manager.generate_request(obj, request):
                yield b"data: " + dumps_json(out) + b"\n\n"
            yield b"data: [DONE]\n\n"
        return StreamingResponse(stream_results(), media_type="text/event-stream", ...)
```

可以看到原生路由的处理极薄:收到 `GenerateReqInput`,直接交给 `tokenizer_manager.generate_request`,把产出流式吐回去。**`/generate` 路由 = `Engine.generate` 的 HTTP 版本**——同一个 `TokenizerManager.generate_request`,只是一个被 HTTP handler 包着、一个被 `Engine` 方法包着。

## 5. OpenAI 兼容层

OpenAI 兼容接口比原生路由多一道**协议转换**。相关代码在 `python/sglang/srt/entrypoints/openai/` 目录:

| 文件 | 作用 |
|------|------|
| `protocol.py` | OpenAI 请求/响应的数据结构(`ChatCompletionRequest` 等) |
| `serving_base.py` | serving 适配器的基类 `OpenAIServingBase` |
| `serving_chat.py` | `/v1/chat/completions` 的适配器 `OpenAIServingChat` |
| `serving_completions.py` | `/v1/completions` 的适配器 |
| `serving_embedding.py` `serving_rerank.py` `serving_score.py` ... | 其他 OpenAI 风格端点 |

以 `/v1/chat/completions` 为例。路由在 `http_server.py:1491`:

```python
@app.post("/v1/chat/completions", dependencies=[Depends(validate_json_request)])
async def openai_v1_chat_completions(...):
    ...
```

它把请求交给 `OpenAIServingChat`(`serving_chat.py:183`)。转换的核心发生在它把 `ChatCompletionRequest` 变成内部 `GenerateReqInput` 的地方(`serving_chat.py:371` 起):

```python
# serving_chat.py:389, 420 (节选)
processed_messages = self._process_messages(request, is_multimodal)
...
adapted_request = GenerateReqInput(
    ...   # 从 OpenAI 请求字段映射过来
)
```

转换要做的活:

- **`messages` → prompt**:OpenAI 的 `messages` 是一个角色化的列表(`system` / `user` / `assistant`),要按模型的 chat template 拼成一段文本(`_process_messages`,`serving_chat.py:456`);
- **采样参数映射**:OpenAI 的 `temperature` / `top_p` / `max_tokens` / `stop` 等字段,映射成 `GenerateReqInput` 里的 `sampling_params`;
- **多模态内容**:`messages` 里可能带图片,要提取出来。

转换完拿到 `GenerateReqInput`,后面的路径就和 `/generate` 完全一样——交给 `TokenizerManager`。输出回来后,再由 `OpenAIServingChat` 做**反向转换**:把内部输出包装成 OpenAI 的 `ChatCompletion` 响应结构。

<svg viewBox="0 0 620 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenAI compatibility layer as a bidirectional translator of GenerateReqInput">
<defs>
<marker id="r3bar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="20" y="30" width="170" height="50" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
<text x="105" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ChatCompletionRequest</text>
<text x="105" y="69" text-anchor="middle" font-size="10" fill="#64748b">OpenAI 格式</text>
<line x1="190" y1="55" x2="290" y2="55" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r3bar)"/>
<text x="240" y="40" text-anchor="middle" font-size="9" fill="#7c3aed">_process_messages</text>
<text x="240" y="74" text-anchor="middle" font-size="9" fill="#7c3aed">采样参数映射</text>
<rect x="292" y="30" width="170" height="50" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="377" y="52" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GenerateReqInput</text>
<text x="377" y="69" text-anchor="middle" font-size="10" fill="#64748b">SGLang 内部格式</text>
<line x1="462" y1="55" x2="562" y2="55" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r3bar)"/>
<rect x="510" y="30" width="100" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="560" y="52" text-anchor="middle" font-size="10" fill="currentColor">Tokenizer</text>
<text x="560" y="68" text-anchor="middle" font-size="10" fill="currentColor">Manager</text>
<line x1="560" y1="80" x2="560" y2="120" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="4,3"/>
<line x1="560" y1="120" x2="105" y2="120" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="4,3"/>
<rect x="20" y="140" width="170" height="50" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
<text x="105" y="162" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ChatCompletion 响应</text>
<text x="105" y="179" text-anchor="middle" font-size="10" fill="#64748b">OpenAI 格式</text>
<line x1="292" y1="165" x2="190" y2="165" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r3bar)"/>
<text x="240" y="155" text-anchor="middle" font-size="9" fill="#7c3aed">包装成 OpenAI 结构</text>
<rect x="292" y="140" width="170" height="50" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="377" y="168" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">内部输出</text>
<line x1="560" y1="140" x2="462" y2="165" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r3bar)"/>
</svg>
<span class="figure-caption">图 R3.2 ｜ OpenAI 兼容层的本质是 GenerateReqInput 的双向翻译器：进来翻成内部格式，出去翻回 OpenAI 结构</span>

<details>
<summary>ASCII 原版</summary>

```text
 ChatCompletionRequest  ──_process_messages──►  prompt 文本
 (OpenAI 格式)          ──采样参数映射──────►  GenerateReqInput  ──► TokenizerManager
                                                                         │
 ChatCompletion 响应   ◄──包装成 OpenAI 结构──  内部输出  ◄──────────────┘
```

</details>

**所以 OpenAI 兼容层的本质,就是 `GenerateReqInput` 的双向翻译器。** 它不碰推理,只碰协议。

## 6. 流式响应(SSE)

OpenAI API 的流式模式靠 **Server-Sent Events(SSE)**:响应头是 `text/event-stream`,body 是一连串 `data: {...}\n\n` 行,最后以 `data: [DONE]\n\n` 收尾。

实现上(看 `http_server.py:705` 的 `/generate`,OpenAI 路由同理):`TokenizerManager.generate_request` 本身是一个**异步生成器**——它每拿到一段新输出就 `yield` 一次。HTTP handler 把每个 yield 出来的 chunk 格式化成一行 `data: ...`,用 FastAPI 的 `StreamingResponse` 持续往 socket 写。

对 OpenAI 流式,`OpenAIServingChat` 还要把每个 chunk 包成 OpenAI 规定的 `_StreamChunk` 结构(`serving_chat.py:82`),处理路径见 `_handle_streaming_request`(`:779`)和 `_generate_chat_stream`(`:807`)。

非流式(`stream=False`)则相反:`_handle_non_streaming_request`(`serving_chat.py:1087`)把生成器跑到底、收集完整输出,一次性返回完整 JSON。这和离线 `Engine` 的同步 `generate` 用 `run_until_complete` 把异步生成器「压平」成同步调用,是同一个套路。

## 7. HTTP 服务器与离线 Engine 的关系

把本章和 [第 04 章](04-engine-and-processes.md) 对照,关系就很清楚了:

<svg viewBox="0 0 620 256" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Offline Engine and HTTP server share the same core engine">
<text x="160" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">离线 Engine</text>
<text x="460" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">HTTP 服务器</text>
<rect x="40" y="34" width="240" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="160" y="59" text-anchor="middle" font-size="11" fill="currentColor">Engine 类 · generate() 方法</text>
<rect x="340" y="34" width="240" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
<text x="460" y="53" text-anchor="middle" font-size="11" fill="currentColor">FastAPI 路由</text>
<text x="460" y="68" text-anchor="middle" font-size="10" fill="#64748b">+ OpenAI 适配层</text>
<rect x="40" y="90" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="160" y="115" text-anchor="middle" font-size="11" fill="currentColor">TokenizerManager</text>
<rect x="340" y="90" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="460" y="115" text-anchor="middle" font-size="11" fill="currentColor">TokenizerManager</text>
<rect x="40" y="146" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="160" y="171" text-anchor="middle" font-size="11" fill="currentColor">Scheduler 子进程</text>
<rect x="340" y="146" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="460" y="171" text-anchor="middle" font-size="11" fill="currentColor">Scheduler 子进程</text>
<rect x="40" y="202" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="160" y="227" text-anchor="middle" font-size="11" fill="currentColor">Detokenizer 子进程</text>
<rect x="340" y="202" width="240" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="460" y="227" text-anchor="middle" font-size="11" fill="currentColor">Detokenizer 子进程</text>
<line x1="280" y1="110" x2="340" y2="110" stroke="#16a34a" stroke-width="1.4" stroke-dasharray="4,3"/>
<line x1="280" y1="166" x2="340" y2="166" stroke="#16a34a" stroke-width="1.4" stroke-dasharray="4,3"/>
<line x1="280" y1="222" x2="340" y2="222" stroke="#16a34a" stroke-width="1.4" stroke-dasharray="4,3"/>
<text x="310" y="103" text-anchor="middle" font-size="9" fill="#16a34a">同</text>
<text x="310" y="159" text-anchor="middle" font-size="9" fill="#16a34a">一</text>
<text x="310" y="215" text-anchor="middle" font-size="9" fill="#16a34a">套</text>
</svg>
<span class="figure-caption">图 R3.3 ｜ 离线 Engine 与 HTTP 服务器共用同一套三进程引擎，区别只在最外层入口形态</span>

<details>
<summary>ASCII 原版</summary>

```text
   离线 Engine                      HTTP 服务器
   ┌──────────────────┐             ┌──────────────────────────┐
   │ Engine.generate  │             │ FastAPI 路由             │
   │                  │             │  + OpenAI 适配层         │
   ├──────────────────┤             ├──────────────────────────┤
   │ TokenizerManager │  ◄── 同一个 ──►  │ TokenizerManager     │
   ├──────────────────┤             ├──────────────────────────┤
   │ Scheduler 子进程 │  ◄── 同样的 ──►  │ Scheduler 子进程     │
   │ Detokenizer 子进程│             │ Detokenizer 子进程       │
   └──────────────────┘             └──────────────────────────┘
```

</details>

两者**共用同一个 `TokenizerManager` + 三进程引擎**。区别只在最外层:

- 离线 `Engine`:外层是一个 Python 类,`generate` 是个方法;
- HTTP 服务器:外层是 FastAPI app,`generate` 被 HTTP 路由包着,而且多了一层 OpenAI 协议转换。

理解了这一点,你就抓住了 SGLang 入口层的设计:**核心引擎只有一个,入口可以有多种**(DSL、离线 Engine、HTTP)。每种入口只负责「把外部形态转成 `GenerateReqInput`」,转完就汇入同一条路。

## 8. 扩展点:如何加一个新端点

如果你要给 SGLang 加一个新的 HTTP 接口:

- **原生接口**:在 `http_server.py` 加一个 `@app.post(...)`,handler 里构造 `GenerateReqInput`、调 `tokenizer_manager`。参考 `/generate`(`:705`)。
- **OpenAI 风格接口**:在 `openai/` 下新建一个 `serving_xxx.py`,继承 `OpenAIServingBase`(`serving_base.py`),实现「OpenAI 请求 → `GenerateReqInput`」和「内部输出 → OpenAI 响应」两个转换;再在 `http_server.py` 加路由、在 `lifespan` 里构造适配器。参考 `OpenAIServingChat`。

## 相关章节

- [第 02 章 前端语言 SGLang DSL](02-frontend-language.md) —— 另一种入口形态
- [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md) —— HTTP 层底下的三进程引擎、`ServerArgs`、`TokenizerManager`
- [第 05 章 请求对象与核心数据结构](05-request-data-structures.md) —— `GenerateReqInput` 的完整字段
- [导览步骤 06](tour-06-generate-call.md)、[步骤 07](tour-07-tokenize.md) —— `GenerateReqInput` 构造与分词的实际 trace
