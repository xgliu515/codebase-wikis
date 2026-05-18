# 第 1 章：架构总览

> 代码版本：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [项目定位与设计哲学](#1-项目定位与设计哲学)
2. [文件布局](#2-文件布局)
3. [三大后端](#3-三大后端)
4. [分层架构](#4-分层架构)
5. [ds4.h：公共边界的设计意图](#5-ds4h公共边界的设计意图)
6. [整体数据流](#6-整体数据流)

---

## 1 项目定位与设计哲学

### 1.1 为什么要为单个模型写独立引擎

DwarfStar 4（`ds4`）是一个**专为 DeepSeek V4 Flash 打造的独立 C 语言推理引擎**，而不是通用 GGUF runner。`README.md:3-8` 的第一句话就明确了这一定位：

> DwarfStar 4 is a small native inference engine specific for **DeepSeek V4 Flash**. It is intentionally narrow: not a generic GGUF runner, not a wrapper around another runtime: it is completely self-contained.

这个选择不是因为不知道通用 runner 的价值，而是作者认为在本地推理领域，**一次一个模型、做到底**的策略更有工程意义（`README.md:36-41`）：

- 专用引擎可以对模型形状硬编码，消除运行时配置误差；
- 可以针对 DS4 Flash 独有特性（超连接、压缩 KV、哈希路由）做最优化；
- 可以保证用官方向量做回归测试，而不是笼统地"能运行"。

AGENT.md 的目标列表（`AGENT.md:8-16`）将这种哲学归纳为五条：

```text
- Keep the production path as whole-model Metal graph inference.
- Keep model loading mmap-backed; do not eagerly copy the full GGUF.
- Keep the CPU backend CPU-only and use it only as reference/debug code.
- Preserve correctness before speed.
- Make long local agent sessions practical through live KV reuse and disk KV checkpoints.
```

### 1.2 mmap 加载

`ds4.c:1-15` 文件头注释写明：

> Loading is mmap based.  The loader parses only the GGUF header, metadata table, and tensor directory.  Tensor data stays in the kernel page cache until inference touches it, or until Metal wraps slices of the mapping as no-copy MTLBuffers.

不提前 `read()` 整个 GGUF 有两层好处：启动延迟低（不等待 I/O 完成），Metal 可以直接从内存映射区域创建无拷贝的 `MTLBuffer`，节省一次内存带宽往返。

### 1.3 CPU 路径仅用于参考

`AGENT.md:12` 明确写道："Keep the CPU backend CPU-only and use it only as reference/debug code."

`README.md:42` 还额外说明，macOS 上不能运行大型 CPU 推理——当前 macOS VM 实现存在 bug，处理大型映射时会导致内核崩溃。CPU 路径的主要价值是提供一个可读的参考实现，以及在无 GPU 的 Linux 环境下做诊断。

### 1.4 正确性优先

`AGENT.md:14` 写明："Preserve correctness before speed. Do not keep a faster path with unexplained attention, KV cache, or logits drift."

这体现在两个具体机制上：
- 模型加载时做严格的元数据校验（`ds4.c:2562-2617`），任何形状不匹配直接 `exit(1)`；
- `tests/test-vectors/` 存放从官方 DeepSeek V4 Flash API 获取的连续向量，每次构建后可用 `make test` 比对。

### 1.5 磁盘 KV 是一等公民

`README.md:40` 宣告了这一设计原则：

> This implementation is based on the idea that compressed KV caches like the one of DeepSeek v4 and the fast SSD disks of modern MacBooks should change our idea that KV cache belongs to RAM. **The KV cache is actually a first-class disk citizen**.

DS4 Flash 的压缩 KV 格式使得单个 token 的 KV 占用远小于一般模型，结合 MacBook 的高速 NVMe，在会话切换或服务重启后恢复一个 100k token 的上下文变得可行。

---

## 2 文件布局

项目源码根目录（`/Users/xgliu/Documents/git/ds4/`）的每个文件和目录职责如下：

### 2.1 核心 C 文件

| 文件 | 行数 | 职责 |
|---|---:|---|
| `ds4.c` | ~18403 | **核心引擎**：GGUF 加载、分词器、CPU 参考内核、Metal/CUDA 图调度、会话管理、磁盘 KV 序列化 |
| `ds4.h` | ~200 | **公共边界**：CLI 与 server 唯一依赖的头文件，暴露不透明类型 `ds4_engine`/`ds4_session` 和操作函数 |
| `ds4_cli.c` | ~1379 | **命令行接口**：参数解析、linenoise REPL、交互式多轮对话管理 |
| `ds4_server.c` | ~15581 | **HTTP 服务器**：OpenAI/Anthropic 兼容 API、工作队列、SSE 流式输出、工具调用映射、磁盘 KV 缓存策略 |
| `ds4_metal.m` | ~14721 | **Metal 运行时**：Objective-C Metal API 调用封装、内核调度、GPU 张量管理 |
| `ds4_cuda.cu` | ~10723 | **CUDA 运行时**：对应 Metal 后端的 CUDA 实现，专门针对 DGX Spark / GB10 |
| `ds4_gpu.h` | — | **GPU 抽象接口**：Metal 和 CUDA 共用的函数声明，`ds4.c` 通过 `#include "ds4_gpu.h"` 连接到具体后端 |
| `ds4_bench.c` | ~419 | **基准测试**：在 context frontier 处测量 prefill 和 generation 吞吐，输出 CSV |
| `ds4_eval.c` | ~3339 | **能力评估**：内嵌 92 道 GPQA/SuperGPQA/AIME/COMPSEC 题目，交互式 TUI |

### 2.2 辅助文件

| 文件 | 职责 |
|---|---|
| `rax.c` / `rax.h` | Redis Radix Tree 实现，供 `ds4_server.c` 管理工具 ID 到 DSML 块的映射（bounded replay map） |
| `linenoise.c` / `linenoise.h` | 命令行编辑库，为 CLI REPL 提供历史记录与行编辑 |
| `rax_malloc.h` | `rax.c` 使用的内存分配抽象 |
| `ds4_iq2_tables_cuda.inc` | CUDA 构建中 IQ2_XXS 反量化所需的静态查表数据 |
| `download_model.sh` | 从 Hugging Face 下载 GGUF 权重文件的脚本 |

### 2.3 目录

| 目录 | 职责 |
|---|---|
| `metal/` | 19 个 Metal 计算核函数（`.metal` 文件），覆盖注意力、MoE、HC、量化、RoPE 等所有算子 |
| `gguf-tools/` | 离线 GGUF 生成工具：量化、imatrix 收集、质量测试 |
| `dir-steering/` | 方向激活引导数据与工具；用于调整模型行为（非训练，推理时注入激活向量） |
| `tests/` | 单元测试（`ds4_test.c`）、CUDA 长上下文烟雾测试、官方连续向量（`test-vectors/`） |
| `speed-bench/` | 基准测试 CSV 数据与图表生成脚本 |
| `misc/` | 实验性笔记和旧规划文档（不进入生产路径） |

---

## 3 三大后端

### 3.1 后端选择机制

后端不在运行时自动探测——它由**编译期宏和构建目标**决定，`Makefile` 的对象文件规则体现了这一点：

```makefile
# Makefile:115-161（macOS 上）
ds4.o: ds4.c ds4.h ds4_gpu.h
    $(CC) $(CFLAGS) -c -o $@ ds4.c          # Metal 路径

ds4_cpu.o: ds4.c ds4.h ds4_gpu.h
    $(CC) $(CFLAGS) -DDS4_NO_GPU -c -o $@ ds4.c   # CPU 路径
```

`-DDS4_NO_GPU` 这个宏是 CPU 路径的全局开关。`ds4.c:39-41` 的条件包含语义一致：

```c
#ifndef DS4_NO_GPU
#include "ds4_gpu.h"
#endif
```

`ds4_gpu.h` 声明的函数在 macOS 上由 `ds4_metal.m` 实现，在 Linux CUDA 构建上由 `ds4_cuda.cu` 实现——两者通过链接选择，`ds4.c` 本身无需感知。

运行时可以通过 `ds4_backend_uses_graph()` 判断当前是否处于图后端模式（`ds4.c:73-75`）：

```c
static bool ds4_backend_uses_graph(ds4_backend backend) {
    return backend == DS4_BACKEND_METAL || backend == DS4_BACKEND_CUDA;
}
```

### 3.2 Metal（主目标）

`README.md:13` 明确："Starting from MacBooks with 96GB of RAM."

Metal 后端的实现集中在 `ds4_metal.m`（约 14721 行 Objective-C）和 `metal/` 下的 19 个 `.metal` 文件。Metal 路径直接在 mmap 区域上创建无拷贝 `MTLBuffer`，把整个模型前向计算调度为 GPU 命令队列。

构建命令：

```sh
make          # macOS，默认 Metal
```

### 3.3 CUDA（DGX Spark）

Linux 上 `make cuda-spark` 构建 NVIDIA 路径；`CORE_OBJS` 切换为 `ds4.o ds4_cuda.o`（`Makefile:30`）。`cuda-spark` 特意省略 `-arch` 以获取 DGX Spark / GB10 最快路径（`Makefile:79-80`）：

```makefile
cuda-spark:
    $(MAKE) ds4 ds4-server ds4-bench ds4-eval CUDA_ARCH=
```

### 3.4 CPU（参考/诊断）

CPU 路径使用 `-DDS4_NO_GPU` 编译，在所有 `#ifndef DS4_NO_GPU` 块内均不包含 Metal/CUDA 代码。CPU 路径支持 ARMv8 NEON 内联（`ds4.c:42-44`）以提升矩阵乘法性能，但不作为推理生产路径。

---

## 4 分层架构

### 4.1 层次划分

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4 four-layer architecture: Entry, Engine/Session, Forward Pass, Backend">
  <defs>
    <marker id="ar-r1-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="10" width="720" height="80" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">入口层 (Entry)</text>
  <text x="380" y="52" text-anchor="middle" font-size="11" fill="#64748b">ds4_cli.c — CLI REPL / 单次推理</text>
  <text x="380" y="67" text-anchor="middle" font-size="11" fill="#64748b">ds4_server.c — OpenAI/Anthropic HTTP API</text>
  <text x="380" y="82" text-anchor="middle" font-size="11" fill="#64748b">ds4_bench.c — 基准测试　　ds4_eval.c — 能力评估</text>
  <line x1="380" y1="90" x2="380" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-1)"/>
  <text x="392" y="108" font-size="10" fill="#94a3b8">ds4.h (公共边界)</text>
  <rect x="20" y="118" width="720" height="90" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="140" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">引擎与会话层 (Engine/Session)</text>
  <text x="380" y="158" text-anchor="middle" font-size="11" fill="#64748b">ds4_engine — 已加载模型；不可变；mmap 权重 + 分词器</text>
  <text x="380" y="173" text-anchor="middle" font-size="11" fill="#64748b">ds4_session — 可变推理时间线；拥有 KV cache 和 logits</text>
  <text x="380" y="188" text-anchor="middle" font-size="11" fill="#64748b">sync() — 同步 token 前缀　　eval() — 单 token 前向　　sample() — 采样</text>
  <line x1="380" y1="208" x2="380" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-1)"/>
  <rect x="20" y="234" width="720" height="86" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="256" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">模型前向 (Forward Pass)</text>
  <text x="380" y="274" text-anchor="middle" font-size="11" fill="#64748b">ds4.c: prefill_layer_major_cpu / metal_graph_prefill_chunked</text>
  <text x="380" y="289" text-anchor="middle" font-size="11" fill="#64748b">嵌入层 + HC 初始化　→　43 层 transformer (注意力 + HC + MoE/FFN)</text>
  <text x="380" y="304" text-anchor="middle" font-size="11" fill="#64748b">输出 HC head + RMSNorm + vocab 投影　（可选 MTP 前向）</text>
  <line x1="380" y1="320" x2="380" y2="346" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-1)"/>
  <rect x="20" y="346" width="720" height="64" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="368" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">后端 (Backend)</text>
  <text x="380" y="385" text-anchor="middle" font-size="11" fill="#64748b">Metal: ds4_metal.m + metal/*.metal　　CUDA: ds4_cuda.cu　　CPU: 纯 C / NEON（参考路径）</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ ds4 四层架构：入口层通过 ds4.h 公共边界调用引擎会话层，再到模型前向层，最终由后端执行</span>

<details>
<summary>ASCII 原版</summary>

```
┌──────────────────────────────────────────────────────────────────┐
│                        入口层 (Entry)                             │
│  ds4_cli.c — CLI REPL / 单次推理                                  │
│  ds4_server.c — OpenAI/Anthropic HTTP API                        │
│  ds4_bench.c — 基准测试                                           │
│  ds4_eval.c  — 能力评估                                           │
└────────────────────────────┬─────────────────────────────────────┘
                             │  ds4.h (公共边界)
┌────────────────────────────▼─────────────────────────────────────┐
│                     引擎与会话层 (Engine/Session)                 │
│  ds4_engine — 已加载模型；不可变；mmap 权重 + 分词器              │
│  ds4_session — 可变推理时间线；拥有 KV cache 和 logits            │
│  ds4_session_sync()  — 将会话同步到完整 token 前缀                │
│  ds4_session_eval()  — 单 token 前向传播                          │
│  ds4_session_sample() — 采样下一 token                            │
└────────┬──────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────────────┐
│                       模型前向 (Forward Pass)                      │
│  ds4.c: prefill_layer_major_cpu / metal_graph_prefill_chunked     │
│  - 嵌入层 + HC 初始化                                              │
│  - 43 层 transformer (注意力 + HC + MoE/FFN)                       │
│  - 输出 HC head + RMSNorm + vocab 投影                             │
│  - （可选）MTP 前向                                                │
└────────┬──────────────────────────────────────────────────────────┘
         │
┌────────▼──────────────────────────────────────────────────────────┐
│                      后端 (Backend)                                │
│  Metal: ds4_metal.m + metal/*.metal                                │
│  CUDA:  ds4_cuda.cu + ds4_iq2_tables_cuda.inc                      │
│  CPU:   ds4.c 内的纯 C / NEON 内核（参考路径）                     │
└───────────────────────────────────────────────────────────────────┘
```

</details>

### 4.2 入口层

**CLI**（`ds4_cli.c`）：`main` 函数在 `ds4_cli.c:1338`，解析命令行后调用 `ds4_engine_open()`，再根据是否有 `-p` 选项进入单次生成（`run_generation`）或交互 REPL（`run_repl`）。

**Server**（`ds4_server.c`）：监听 HTTP 请求，解析 OpenAI / Anthropic 报文，将其转换为 `ds4_tokens` 序列，调用单例 `ds4_session` 完成推理，再将 token 流映射回对应 API 格式（SSE / JSON）。

两个入口都只依赖 `ds4.h` 暴露的不透明接口，不感知张量内部布局。

### 4.3 引擎与会话层

`ds4_engine`（`ds4.c:17164`）是不可变的已加载模型对象，包含：
- mmap 的 GGUF 文件描述符和内存区间；
- 词汇表（`ds4_vocab`）；
- 张量指针表（`ds4_weights`，`ds4.c:2095-2105`）。

`ds4_session`（`ds4.c:17308`）是单次推理的可变上下文，包含：
- KV cache（CPU 路径是 `ds4_kv_cache`；图路径是 `ds4_gpu_graph` 中的张量）；
- `checkpoint` token 序列（已计算到哪个位置）；
- `logits` 缓冲区（最后一步的词汇分布）。

`ds4_session_sync()`（`ds4.c:17415`）是会话层最重要的操作：给定完整 prompt token 序列，判断当前 checkpoint 是否是该序列的前缀——是则只计算增量；否则从头全量 prefill。这是服务器实现"无状态 API 透明续写"的核心。

### 4.4 模型前向层

前向计算有两条路径：

| 操作 | CPU 路径 | 图路径（Metal/CUDA） |
|---|---|---|
| 全量 prefill | `prefill_layer_major_cpu`（`ds4.c:7763`）| `metal_graph_prefill_chunked`（`ds4.c:13688`）|
| 单 token decode | `forward_token_raw_swa_cpu_decode_scratch` | `metal_graph_decode_one`（内部名）|
| 推测解码（MTP） | 无 | `ds4_session_eval_speculative_argmax` |

图路径把整个 43 层前向计算编码为 GPU 命令序列，利用 Metal Persistent Pipeline 或 CUDA kernel 执行；CPU 路径是逐层、逐 token 的逻辑循环，重度使用预分配 scratch buffer（`ds4_cpu_decode_scratch`）避免热路径中的堆分配。

---

## 5 ds4.h：公共边界的设计意图

`ds4.h:9-15` 的注释直接说明了设计动机：

```c
/* Public engine boundary.
 *
 * The CLI and server should treat ds4_engine as the loaded model and
 * ds4_session as one mutable inference timeline. ...
 * Keep this header narrow so HTTP/CLI code does not depend on tensor internals. */
```

`ds4.h` 导出的全部内容可归为六类：

1. **后端与思维模式枚举**：`ds4_backend`（Metal/CUDA/CPU）、`ds4_think_mode`（None/High/Max）、`ds4_log_type`；
2. **不透明类型**：`ds4_engine *`、`ds4_session *`——CLI/server 持有指针，不能访问内部字段；
3. **引擎生命周期**：`ds4_engine_open()`、`ds4_engine_close()`、`ds4_engine_summary()`；
4. **会话操作**：`ds4_session_create()`、`ds4_session_sync()`、`ds4_session_eval()`、`ds4_session_sample()`、`ds4_session_free()` 等；
5. **分词与 chat 渲染**：`ds4_tokenize_text()`、`ds4_chat_append_message()`、`ds4_encode_chat_prompt()` 等；
6. **磁盘 KV 序列化**：`ds4_session_save_payload()`、`ds4_session_load_payload()`、`ds4_session_save_snapshot()` 等。

这种设计将"推理运行时"的所有状态封装在两个不透明对象内，使 CLI 和 Server 可以在不重编译 `ds4.c` 的前提下独立演化其协议逻辑。

`ds4_context_memory_estimate()` 也在 `ds4.h` 中暴露，让 CLI/server 在创建会话前打印内存需求估算，而无需了解 KV cache 的内部分配细节。

---

## 6 整体数据流

以下是一条请求从命令行键入到 token 输出的完整路径。

### 6.1 CLI 单次生成路径

<svg viewBox="0 0 640 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="CLI single-generation call flow from user input to token output">
  <defs>
    <marker id="ar-r1-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="10" width="320" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">用户输入: ./ds4 -p "Hello"</text>
  <line x1="320" y1="46" x2="320" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-2)"/>
  <rect x="100" y="70" width="440" height="66" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ds4_cli.c: main()</text>
  <text x="320" y="108" text-anchor="middle" font-size="11" fill="#64748b">parse_options() — 解析 --ctx、--temp 等参数</text>
  <text x="320" y="124" text-anchor="middle" font-size="11" fill="#64748b">ds4_engine_open() — mmap GGUF、验证形状、初始化后端</text>
  <line x1="320" y1="136" x2="320" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-2)"/>
  <rect x="100" y="160" width="440" height="52" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="180" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">run_generation()</text>
  <text x="320" y="198" text-anchor="middle" font-size="11" fill="#64748b">ds4_encode_chat_prompt() — 渲染 DS4 chat token 序列</text>
  <line x1="320" y1="212" x2="320" y2="236" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-2)"/>
  <text x="335" y="229" font-size="10" fill="#94a3b8">图路径 ds4.c:16956</text>
  <rect x="80" y="236" width="480" height="82" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="258" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">generate_metal_graph_raw_swa()</text>
  <text x="320" y="276" text-anchor="middle" font-size="11" fill="#64748b">metal_graph_prefill_chunked() — 分块 prefill，每块最多 prefill_cap tokens</text>
  <text x="320" y="291" text-anchor="middle" font-size="11" fill="#64748b">KV 写入 GPU 张量</text>
  <line x1="320" y1="318" x2="320" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-2)"/>
  <rect x="80" y="342" width="480" height="96" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="364" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">decode loop</text>
  <text x="320" y="382" text-anchor="middle" font-size="11" fill="#64748b">metal_graph_decode_one() — 单 token 前向</text>
  <text x="320" y="397" text-anchor="middle" font-size="11" fill="#64748b">ds4_session_sample() — 采样 (min-p / top-k / top-p)</text>
  <text x="320" y="412" text-anchor="middle" font-size="11" fill="#64748b">emit_fn(token) — 回调打印 token 文本</text>
  <line x1="320" y1="438" x2="320" y2="462" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-2)"/>
  <rect x="160" y="462" width="320" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="484" text-anchor="middle" font-size="12" font-weight="600" fill="#16a34a">直到 EOS 或 n_predict 用尽</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ CLI 单次生成调用链：从用户输入经 prefill、decode loop 到 token 输出</span>

<details>
<summary>ASCII 原版</summary>

```
用户输入: ./ds4 -p "Hello"
         │
         ▼
ds4_cli.c:main()
  parse_options()         ← 解析 --ctx、--temp 等参数
  ds4_engine_open()       ← mmap GGUF、验证形状、初始化后端
         │
         ▼
run_generation()
  ds4_encode_chat_prompt()   ← 渲染 DS4 chat 格式 token 序列
  ds4_engine_generate_argmax()
         │
         ▼ (图路径: ds4.c:16956)
generate_metal_graph_raw_swa()
  metal_graph_prefill_chunked()   ← 分块 prefill，每块最多 prefill_cap tokens
         │                         KV 写入 GPU 张量
         ▼
  decode loop:
    metal_graph_decode_one()      ← 单 token 前向
    ds4_session_sample()          ← 采样 (min-p / top-k / top-p)
    emit_fn(token)                ← 回调打印 token 文本
  直到 EOS 或 n_predict 用尽
```

</details>

### 6.2 Server 请求路径

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Server request path from POST request through session sync to SSE token stream">
  <defs>
    <marker id="ar-r1-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="10" width="300" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">POST /v1/chat/completions</text>
  <line x1="380" y1="44" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-3)"/>
  <rect x="100" y="68" width="560" height="50" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="88" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ds4_server.c: parse_openai_chat_request()</text>
  <text x="380" y="106" text-anchor="middle" font-size="11" fill="#64748b">render DS4 prompt bytes</text>
  <line x1="380" y1="118" x2="380" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-3)"/>
  <rect x="60" y="142" width="640" height="176" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="164" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">ds4_session_sync(session, prompt_tokens)</text>
  <text x="380" y="182" text-anchor="middle" font-size="11" fill="#64748b">common_prefix_len = ds4_session_common_prefix(s, prompt)</text>
  <rect x="80" y="192" width="280" height="50" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="220" y="212" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">命中：live checkpoint 是前缀</text>
  <text x="220" y="228" text-anchor="middle" font-size="10" fill="#64748b">只评估新增 token</text>
  <rect x="400" y="192" width="280" height="82" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="540" y="212" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">未命中：查磁盘 KV cache</text>
  <text x="540" y="228" text-anchor="middle" font-size="10" fill="#64748b">查找 SHA1(rendered_bytes)</text>
  <text x="540" y="244" text-anchor="middle" font-size="10" fill="#64748b">命中 → load_payload → 评估 suffix</text>
  <text x="540" y="260" text-anchor="middle" font-size="10" fill="#64748b">未命中 → 全量 prefill</text>
  <line x1="380" y1="318" x2="380" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-3)"/>
  <rect x="100" y="342" width="560" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="364" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">decode loop + SSE token stream</text>
  <line x1="380" y1="386" x2="380" y2="410" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r1-3)"/>
  <rect x="100" y="410" width="560" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="430" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">（可选）保存到磁盘 KV cache</text>
  <text x="380" y="446" text-anchor="middle" font-size="11" fill="#64748b">cold / continued / evict / shutdown</text>
</svg>
<span class="figure-caption">图 R1.3 ｜ Server 请求路径：通过 session_sync 的三路分支决策（live checkpoint / 磁盘命中 / 全量 prefill）后进入 decode loop</span>

<details>
<summary>ASCII 原版</summary>

```
POST /v1/chat/completions
         │
         ▼
ds4_server.c: parse_openai_chat_request()
  render DS4 prompt bytes
         │
         ▼
ds4_session_sync(session, prompt_tokens)
  common_prefix_len = ds4_session_common_prefix(s, prompt)
  if live_checkpoint is prefix of prompt:
      只评估新增 token
  else:
      从磁盘 KV cache 查找 SHA1(rendered_bytes)
      若命中 → load_payload → 只评估剩余 suffix
      若未命中 → 全量 prefill
         │
         ▼
  decode loop + SSE token stream
         │
         ▼
  (可选) 保存到磁盘 KV cache (cold/continued/evict/shutdown)
```

</details>

与 [导览总览](tour-00-overview.md) 的请求追踪路径相互印证，可参阅该文件获取更细粒度的代码跳转视角。

### 6.3 关键设计决策

**为什么 Server 持有唯一一个 `ds4_session`**：当前架构是单 session 模型，并发请求排队等待同一个图 worker（`README.md:299-301`）。这简化了 KV cache 一致性，代价是不支持真正的并发批推理。

**为什么磁盘 KV key 是渲染文本的 SHA1 而非 token ID 序列**：不同客户端可能因为 BPE 边界不同而产生不同的 token 序列，但渲染出相同的文本——用文本 SHA1 可以跨 tokenization 边界复用 checkpoint（`README.md:599-605`）。

**为什么 prefill 分块**：单次处理大批 token 会超出 GPU 的 `prefill_cap`（受显存和命令缓冲区大小限制），分块后可以渐进地把 KV 写入压缩缓存，并定期回调 progress 函数以供上层显示进度。

---

**相关章节**：[第 2 章：DeepSeek V4 Flash 模型结构](02-model-architecture.md) | [导览总览](tour-00-overview.md)
