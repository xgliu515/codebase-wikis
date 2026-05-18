# 第 01 章：架构总览与核心概念

> commit: sgl-project/sglang@6ccc5b807（2026-05-17）

## 目录

1. [SGLang 是什么，解决什么问题](#1-sglang-是什么解决什么问题)
2. [顶层目录结构](#2-顶层目录结构)
3. [四层架构](#3-四层架构)
4. [多进程模型与 ZMQ IPC](#4-多进程模型与-zmq-ipc)
5. [核心概念速览](#5-核心概念速览)
6. [一次请求的端到端路径鸟瞰](#6-一次请求的端到端路径鸟瞰)

---

## 1. SGLang 是什么，解决什么问题

SGLang（Structured Generation Language）是一个面向大语言模型（LLM）和多模态模型（VLM）的**高性能推理服务框架**。其核心定位是：在从单卡到大型分布式集群的各类部署场景下，同时实现低延迟与高吞吐量的 LLM 推理。

### 1.1 主要问题与现有方案的局限

传统 LLM 推理服务（如 vLLM 早期版本）将前端 API 层与后端推理引擎作为两个松耦合的系统：前端仅负责接收请求并将文本提交给引擎，引擎内部不感知应用语义。这带来两个核心瓶颈：

- **前缀复用效率低下**：大量 few-shot prompt、system prompt 每次都要重新计算 attention，GPU 算力浪费严重。
- **批处理粒度粗糙**：调度器在语义层面不了解请求共享了多少前缀，无法利用这一信息优化 KV Cache 分配。

SGLang 的破局点在于**协同设计（co-design）**：前端 DSL（`python/sglang/lang/`）与后端 SRT 运行时（`python/sglang/srt/`）共同演进，DSL 在编译/执行时能直接利用运行时的前缀缓存语义，而运行时的调度器也能感知多请求共享前缀的结构。

### 1.2 核心特性

根据 `README.md:62-66`，SGLang 的核心特性包括：

- **RadixAttention**：基数树结构的前缀 KV Cache，自动识别并复用相同前缀的计算结果。
- **零开销 CPU 调度器**：基于 Python 的调度循环在 decode 的 GPU 执行期间并发运行，不增加额外等待时间。
- **连续批处理（Continuous Batching）**：动态将 prefill 与 decode 请求合并进同一 forward pass。
- **Prefill-Decode 解耦（PD Disaggregation）**：prefill 与 decode 阶段可部署在不同机器，提升集群利用率。
- **投机解码（Speculative Decoding）**：草稿模型快速生成候选 token，目标模型并行验证。
- **结构化/约束输出**：基于有限状态机（FSM）和 JSON Schema 的约束解码，无需后处理。
- **多种并行策略**：张量并行（TP）、流水线并行（PP）、数据并行（DP）、专家并行（EP）。
- **广泛的模型与硬件支持**：Llama、Qwen、DeepSeek、NVIDIA/AMD/TPU/Ascend 等。

---

## 2. 顶层目录结构

```text
sglang/
├── python/sglang/          # Python 包：前端 DSL + SRT 运行时（核心）
│   ├── lang/               # 前端语言：DSL、IR、解释器、后端抽象
│   └── srt/                # SRT 运行时：调度、内存、推理、HTTP 服务
├── sgl-kernel/             # 自定义 CUDA/ROCm/Metal 算子（C++/Triton）
├── sgl-model-gateway/      # 模型路由网关（Rust，高性能路由控制平面）
├── rust/                   # Rust 实现的 gRPC 服务端
│   └── sglang-grpc/        # SRT gRPC server，支持本地 Rust tokenizer
├── proto/                  # Protocol Buffer 定义（gRPC 接口契约）
├── benchmark/              # 性能基准测试脚本
├── examples/               # 使用示例
└── docker/                 # Docker 镜像配置
```

### 2.1 `python/sglang/`

这是整个项目的核心，包含两个子系统：

- **`lang/`**（[第 02 章](02-frontend-language.md)）：前端领域特定语言（DSL），提供 `@sgl.function`、`sgl.gen()`、`sgl.select()` 等编程接口，将用户程序编译为 `SglExpr` IR 树，再交由解释器执行。
- **`srt/`**（[第 03 章起](03-http-server.md)）：SGLang Runtime，实现 HTTP/gRPC 服务入口、TokenizerManager、Scheduler、ModelRunner、RadixCache、KV 内存池等所有运行时组件。

关键文件一览：

| 文件/目录 | 职责 |
|---|---|
| `python/sglang/srt/entrypoints/engine.py` | `Engine` 类，离线推理 Python API 入口 |
| `python/sglang/srt/entrypoints/http_server.py` | FastAPI HTTP 服务器 |
| `python/sglang/srt/managers/tokenizer_manager.py` | 主进程 TokenizerManager |
| `python/sglang/srt/managers/scheduler.py` | 子进程 Scheduler |
| `python/sglang/srt/managers/detokenizer_manager.py` | 子进程 DetokenizerManager |
| `python/sglang/srt/mem_cache/radix_cache.py` | RadixCache 前缀缓存 |
| `python/sglang/srt/model_executor/model_runner.py` | ModelRunner，执行 GPU forward pass |
| `python/sglang/launch_server.py` | `sglang serve` / `python -m sglang.launch_server` 入口 |

### 2.2 `sgl-kernel/`

包含高性能 CUDA/Triton 算子，例如 FlashAttention 变体、RoPE、量化内核等，以独立 Python 包 `sgl_kernel` 发布。代码位于 `sgl-kernel/csrc/` 和 `sgl-kernel/python/`。主包通过 `import sgl_kernel` 使用这些算子，而不依赖 vLLM 的同名算子。

### 2.3 `sgl-model-gateway/`

Rust 实现的高性能模型路由控制平面（`sgl-model-gateway/`）。提供：多 worker 注册与健康检查、缓存感知负载均衡、gRPC pipeline（Rust 原生 tokenizer + 推理解析器）、电路断路器与速率限制。面向大规模集群部署，单独启动，不在同一进程内。

### 2.4 `rust/sglang-grpc/`

SRT gRPC 服务端的 Rust 实现，与 Python HTTP 服务器并存，支持更低延迟的 streaming token 输出。通过 proto/ 下的 `.proto` 文件定义接口。

### 2.5 `proto/`

存放 Protocol Buffer 定义（`.proto` 文件），定义 gRPC 接口的消息格式和服务契约，由 Rust gRPC server 和 Python gRPC client 共同依赖。

---

## 3. 四层架构

SGLang 运行时在逻辑上分为四层：

<svg viewBox="0 0 640 392" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="SGLang four-layer architecture from entry to execution">
<defs>
<marker id="r1aar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="30" y="16" width="580" height="68" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="320" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">入口层　Entry Layer</text>
<text x="320" y="57" text-anchor="middle" font-size="10" fill="#64748b">Python DSL (lang/)　·　HTTP Server (FastAPI)　·　Engine API</text>
<text x="320" y="73" text-anchor="middle" font-size="10" fill="#64748b">@sgl.function　·　/generate · /v1/chat　·　engine.generate()</text>
<line x1="320" y1="84" x2="320" y2="104" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r1aar)"/>
<text x="332" y="99" font-size="9" fill="#94a3b8">GenerateReqInput</text>
<rect x="30" y="106" width="580" height="68" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="320" y="127" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">调度层　Scheduler Layer</text>
<text x="320" y="147" text-anchor="middle" font-size="10" fill="#64748b">TokenizerManager（主进程）──ZMQ──► Scheduler（子进程）</text>
<text x="320" y="163" text-anchor="middle" font-size="10" fill="#64748b">连续批处理 · 前缀匹配 · prefill/decode 调度</text>
<line x1="320" y1="174" x2="320" y2="194" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r1aar)"/>
<text x="332" y="189" font-size="9" fill="#94a3b8">ScheduleBatch</text>
<rect x="30" y="196" width="580" height="68" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="320" y="217" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">内存层　Memory Layer</text>
<text x="320" y="237" text-anchor="middle" font-size="10" fill="#64748b">RadixCache（KV 前缀树）　·　TokenToKVPool（物理 KV 池）</text>
<text x="320" y="253" text-anchor="middle" font-size="10" fill="#64748b">基数树节点复用 · 分页 KV · LRU/LFU 淘汰</text>
<line x1="320" y1="264" x2="320" y2="284" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r1aar)"/>
<text x="332" y="279" font-size="9" fill="#94a3b8">GPU Tensor（KV 指针）</text>
<rect x="30" y="286" width="580" height="68" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="320" y="307" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">执行层　Execution Layer</text>
<text x="320" y="327" text-anchor="middle" font-size="10" fill="#64748b">ModelRunner → forward() → FlashAttention / RadixAttention</text>
<text x="320" y="343" text-anchor="middle" font-size="10" fill="#64748b">TP/PP 并行 · 采样 · 投机解码验证 · sgl-kernel 算子</text>
<text x="320" y="378" text-anchor="middle" font-size="10" fill="#94a3b8">请求自上而下穿过四层，每层之间用一个明确的数据结构交接</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ SGLang 四层架构：入口 → 调度 → 内存 → 执行，层间以确定的数据结构交接</span>

<details>
<summary>ASCII 原版</summary>

```text
┌─────────────────────────────────────────────────────────────────────┐
│                         入口层（Entry Layer）                        │
│  Python DSL (lang/)  │  HTTP Server (FastAPI)  │  Engine Python API  │
│  @sgl.function       │  /generate /v1/chat      │  engine.generate()  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ GenerateReqInput（序列化请求结构）
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        调度层（Scheduler Layer）                     │
│  TokenizerManager（主进程）  ──ZMQ──►  Scheduler（子进程）           │
│  · 文本 tokenize              · 连续批处理策略                       │
│  · 请求队列管理               · 前缀匹配 + RadixCache 查找           │
│  · 响应流式回传               · prefill/decode 分离                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ ScheduleBatch
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        内存层（Memory Layer）                        │
│  RadixCache（KV 前缀树）  │  TokenToKVPool（物理 KV 内存池）         │
│  · 基数树节点复用            · 分页 KV block 管理                   │
│  · LRU/LFU 驱逐策略         · ReqToTokenPool（请求→token 映射）      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ GPU Tensor（kv cache pointers）
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        执行层（Execution Layer）                     │
│  ModelRunner  →  forward()  →  FlashAttention / RadixAttention      │
│  · TP/PP 并行 forward            · 采样（Top-p/Top-k/Beam）          │
│  · 投机解码验证                  · sgl-kernel CUDA 算子              │
└─────────────────────────────────────────────────────────────────────┘
```

</details>

### 3.1 入口层

入口层有三个等价的入口，用户根据使用场景选择：

1. **DSL 前端**（`python/sglang/lang/`）：通过 `@sgl.function` 装饰器定义多轮对话程序，由解释器驱动执行，调用底层 Backend（RuntimeEndpoint 或 OpenAI）。
2. **HTTP 服务器**（`python/sglang/srt/entrypoints/http_server.py`）：生产部署入口，提供 OpenAI 兼容 API 及原生 `/generate` 接口。
3. **Python Engine API**（`python/sglang/srt/entrypoints/engine.py`）：离线批量推理场景，在 Python 进程内直接调用，无需启动 HTTP 服务器。

三种入口最终都会构建 `GenerateReqInput` 对象，交给 `TokenizerManager.generate_request()`。

### 3.2 调度层

调度层由两个组件组成：

- **TokenizerManager**（主进程）：接收入口层的原始请求（文本字符串），调用 tokenizer 将文本转换为 token IDs，通过 ZMQ 发送给 Scheduler，并等待 Scheduler 返回 token 输出后再 detokenize 回文本。
- **Scheduler**（子进程）：核心调度逻辑所在地，负责连续批处理、RadixCache 前缀匹配、内存分配决策，最终调用 `ModelRunner.forward()`。

### 3.3 内存层

内存层管理 GPU 上的 KV Cache 物理内存：

- **RadixCache**（`python/sglang/srt/mem_cache/radix_cache.py:269`）：基数树结构，将 token 序列前缀映射到已计算的 KV Cache 物理块，实现 O(prefix_len) 的前缀查找与复用。
- **TokenToKVPool / TokenToKVPoolAllocator**（`python/sglang/srt/mem_cache/allocator.py:121`）：管理物理 KV Cache 块的分配与回收，类似 vLLM 的 PagedAttention，但与 RadixCache 紧密集成。
- **ReqToTokenPool**：维护请求 ID 到其占用 token slots 的映射，用于快速查找和释放。

### 3.4 执行层

执行层在 GPU 上运行模型前向传播：

- **ModelRunner**（`python/sglang/srt/model_executor/model_runner.py:327`）：封装 PyTorch 模型，管理 TP/PP 分布式执行，调用 attention backend（FlashInfer / FlashAttention / Triton），执行采样。
- **sgl-kernel**：提供 fused attention、量化、RoPE 等高度优化的 CUDA 算子，通过 `import sgl_kernel` 引用。

---

## 4. 多进程模型与 ZMQ IPC

### 4.1 进程拓扑

SGLang 运行时采用多进程架构，职责清晰分离：

<svg viewBox="0 0 560 332" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Process layout: main process and subprocesses connected by ZMQ">
<defs>
<marker id="r1bar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="120" y="16" width="320" height="80" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="280" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">主进程 Main Process</text>
<text x="280" y="56" text-anchor="middle" font-size="10" fill="#64748b">HTTP Server（FastAPI + uvicorn）</text>
<text x="280" y="71" text-anchor="middle" font-size="10" fill="#64748b">Engine API</text>
<text x="280" y="86" text-anchor="middle" font-size="10" fill="#64748b">TokenizerManager</text>
<line x1="280" y1="96" x2="280" y2="126" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r1bar)"/>
<text x="292" y="116" font-size="9" fill="#94a3b8">ZMQ（tokenizer_ipc）</text>
<rect x="120" y="128" width="320" height="58" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
<text x="280" y="152" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">子进程组：Scheduler</text>
<text x="280" y="170" text-anchor="middle" font-size="10" fill="#64748b">× (pp_size × tp_size) 个</text>
<line x1="280" y1="186" x2="280" y2="216" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r1bar)"/>
<text x="292" y="206" font-size="9" fill="#94a3b8">ZMQ（detokenizer_ipc）</text>
<rect x="120" y="218" width="320" height="48" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
<text x="280" y="247" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">子进程：DetokenizerManager</text>
<path d="M120 242 C 40 242, 40 56, 116 56" fill="none" stroke="#94a3b8" stroke-width="1.3" stroke-dasharray="4,3" marker-end="url(#r1bar)"/>
<text x="48" y="150" font-size="9" fill="#94a3b8">ZMQ 回调</text>
<text x="48" y="164" font-size="9" fill="#94a3b8">tokenizer_ipc</text>
<text x="280" y="298" text-anchor="middle" font-size="10" fill="#94a3b8">结果回流到主进程 TokenizerManager 完成回调</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ 进程布局：主进程 + Scheduler/Detokenizer 子进程，请求与结果靠 ZMQ 单向管道环流</span>

<details>
<summary>ASCII 原版</summary>

```text
主进程（Main Process）
├── HTTP Server（FastAPI + uvicorn）
├── Engine Python API
└── TokenizerManager
    │ ZMQ PUSH/PULL（tokenizer_ipc_name）
    ▼
子进程组：Scheduler × (pp_size × tp_size)
    │ ZMQ PUSH（detokenizer_ipc_name）
    ▼
子进程：DetokenizerManager
    │ ZMQ PUSH（tokenizer_ipc_name，回调方向）
    └──► TokenizerManager（主进程，完成回调）
```

</details>

`Engine` 类的 docstring（`python/sglang/srt/entrypoints/engine.py:178-190`）明确说明：

> The engine consists of three components:
> 1. TokenizerManager: Tokenizes the requests and sends them to the scheduler.
> 2. Scheduler (subprocess): Receives requests from the TokenizerManager, schedules batches, forwards them, and sends the output tokens to the DetokenizerManager.
> 3. DetokenizerManager (subprocess): Detokenizes the output tokens and sends the result back to the TokenizerManager.

### 4.2 ZMQ 通信细节

所有进程间通信通过 ZMQ（ZeroMQ）IPC socket 完成，使用本地 Unix domain socket 文件（`ipc://` 前缀），避免网络栈开销。端口配置存储在 `PortArgs` dataclass（`python/sglang/srt/server_args.py`）中，包含：

- `tokenizer_ipc_name`：TokenizerManager ↔ Scheduler 双向通道
- `detokenizer_ipc_name`：Scheduler → DetokenizerManager → TokenizerManager 的回调通道
- `nccl_port`：TP worker 间 NCCL 通信端口
- `rpc_ipc_name`：控制 RPC 通道（权重更新等管理操作）

```python
# python/sglang/srt/entrypoints/engine.py:250-253
context = zmq.Context(2)
if self.server_args.node_rank == 0:
    self.send_to_rpc = get_zmq_socket(
        context, zmq.DEALER, self.port_args.rpc_ipc_name, True
    )
```

### 4.3 为什么要拆进程

将 Scheduler 和 DetokenizerManager 放在独立子进程，而非线程，有三个关键原因：

1. **GIL 隔离**：Python GIL 阻止多线程真正并发。Scheduler 的调度循环需要在 GPU 执行 decode batch 的同时，CPU 侧已经在准备下一个 batch（"零开销 CPU 调度器"的来源）。多进程绕过了 GIL 的限制。

2. **GPU 上下文隔离**：每个 Scheduler 子进程独占一个 GPU 上下文（对应一个 TP rank 或 PP rank），避免 CUDA context 切换开销，也避免显存管理的相互干扰。

3. **容错与重启**：子进程崩溃不会影响主进程的 HTTP 服务可用性，`SubprocessWatchdog` 可以检测并重启失败的子进程。

---

## 5. 核心概念速览

### 5.1 RadixAttention / 前缀缓存

RadixAttention 是 SGLang 最核心的创新之一。它的本质是将 KV Cache 组织为一棵**基数树（Radix Tree）**，树的每个节点代表一段共享的 token 前缀及其已计算好的 KV 值。当新请求到来时，Scheduler 将其 token 序列与树中已有节点做最长公共前缀（LCP）匹配——匹配的部分无需重新计算 attention，直接复用树中的 KV Cache 块。

这对 few-shot prompting、system prompt、工具调用等"共享前缀"场景有 5x 以上的加速效果。详见调度与缓存章节。

### 5.2 连续批处理（Continuous Batching）

不同于静态批处理（同一批请求必须一起开始、一起结束），连续批处理允许调度器在每个 decode step 结束时动态地将新请求插入当前 batch，或将已完成的请求移出。这消除了 GPU 因等待最慢请求而浪费算力的问题，大幅提升吞吐量。

### 5.3 Prefill 与 Decode

一次 LLM 请求包含两个阶段：

- **Prefill**：处理所有输入 token，并行计算每个位置的 attention，时间复杂度 O(n²)。
- **Decode**：每次生成一个新 token，只需对最新 token 做 attention（KV Cache 已存储历史），时间复杂度 O(n)。

Prefill 是计算密集型，Decode 是内存带宽密集型。SGLang 的 PD 解耦（Prefill-Decode Disaggregation）允许这两个阶段部署在不同 GPU 集群，各自针对性地优化。

### 5.4 零开销 CPU 调度器

SGLang v0.4 引入的关键优化。由于 Scheduler 运行在独立子进程，它可以在 GPU 执行当前 decode batch 的同时，CPU 侧并发地运行调度逻辑（前缀匹配、内存分配、批次构建），当 GPU 完成时，下一个 batch 已经准备好，无需等待。这将 CPU 调度的"空洞时间"降至接近零。

### 5.5 分页 KV Cache（PagedAttention 式）

受 vLLM PagedAttention 启发，SGLang 同样将 KV Cache 划分为固定大小的 page（块），由 `TokenToKVPool` 管理。与 vLLM 不同的是，SGLang 的 page 管理与 RadixCache 树节点深度绑定：树中的每个节点持有一组 KV page 的引用，节点被逐出时才归还 page。

### 5.6 投机解码（Speculative Decoding）

由小型草稿模型（draft model）快速生成 k 个候选 token，再由大型目标模型（target model）在一次 forward pass 中并行验证所有 k 个 token，接受与 token-level 分布一致的前缀。期望接受长度 > 1 时，可降低大模型的 forward pass 次数，提升吞吐量。相关代码位于 `python/sglang/srt/speculative/`。

---

## 6. 一次请求的端到端路径鸟瞰

以 HTTP POST `/generate` 为例，一次完整请求的路径如下：

```text
Client
  │ HTTP POST /generate { "text": "...", "sampling_params": {...} }
  ▼
http_server.py: generate_request()              [主进程，FastAPI 协程]
  │ 构造 GenerateReqInput 对象
  ▼
tokenizer_manager.py: generate_request()        [主进程，async 生成器]
  │ 1. tokenize: 文本 → input_ids
  │ 2. 生成 rid（请求 ID）
  │ 3. 通过 ZMQ PUSH 发送 TokenizedGenerateReqInput
  │ 4. 创建 ReqState，await asyncio.Event
  │
  │──── ZMQ IPC ────────────────────────────────────────────────────►
  │                                                  scheduler.py [子进程]
  │                                                  │ 1. recv TokenizedReq
  │                                                  │ 2. 创建 Req 对象
  │                                                  │ 3. 加入 waiting_queue
  │                                                  │ 4. event_loop 下一次调度：
  │                                                  │    - RadixCache.match_prefix()
  │                                                  │    - 分配 KV slots
  │                                                  │    - 组装 ScheduleBatch
  │                                                  │ 5. model_runner.forward(batch)
  │                                                  │    [GPU forward pass]
  │                                                  │ 6. 采样：生成 next_token_ids
  │                                                  │ 7. 更新 RadixCache
  │                                                  │ 8. ZMQ PUSH → detokenizer
  │                                                  ◄────────────────────────────
  │                                    detokenizer_manager.py [子进程]
  │                                    │ 1. recv token IDs
  │                                    │ 2. ids → text（detokenize）
  │                                    │ 3. ZMQ PUSH → tokenizer_ipc 回调
  │◄────── ZMQ IPC ─────────────────────────────────────────────────
  │
tokenizer_manager.py: handle_loop()             [主进程，后台协程]
  │ 1. 收到 BatchStrOutput
  │ 2. 查找 rid → ReqState
  │ 3. set asyncio.Event
  │ 4. generate_request() 生成器 yield 结果
  │
  ▼
http_server.py: generate_request()              [主进程]
  │ 非流式：直接返回 JSON
  │ 流式：yield SSE chunk（data: {...}\n\n）
  ▼
Client
```

**关键设计决策**：整个路径中，主进程的调度协程从不阻塞 GPU 计算。GPU forward pass 在 Scheduler 子进程中同步执行，主进程通过 `asyncio.Event` 异步等待，期间可继续处理其他请求的 tokenize/detokenize。

---

## 相关章节

- [第 02 章：前端语言 SGLang DSL](02-frontend-language.md)
- [第 03 章：HTTP 服务器与 OpenAI 兼容 API](03-http-server.md)
