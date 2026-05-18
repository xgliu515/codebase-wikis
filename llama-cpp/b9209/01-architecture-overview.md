# 第 1 章 系统架构总览

llama.cpp 是一个以纯 C/C++ 编写、面向"能跑起来"而非"跑得复杂"的大语言模型推理引擎。它的核心目标是：在尽可能多的硬件上（从树莓派到多卡 GPU 集群）以最少的外部依赖完成 Transformer 推理。整个系统由四个层次构成——用户工具、libllama 公共接口、ggml 计算图与调度，以及多后端硬件抽象——每层职责清晰、向下单向依赖。本章从宏观视角梳理这四层架构，讲解核心句柄的语义与生命周期，跟踪一次最简推理从命令行参数到 token 输出的完整调用序列，并说明目录布局和关键设计哲学，最后给出本 wiki 14 章的阅读路线。

---

## 1. 四层架构与分层图

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama.cpp four-layer architecture stack">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="10" width="720" height="72" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">工具 / 示例层</text>
  <text x="380" y="49" text-anchor="middle" font-size="11" fill="#64748b">tools/cli/  tools/server/  examples/simple/  examples/embedding/  examples/batched/</text>
  <text x="380" y="67" text-anchor="middle" font-size="11" fill="#64748b">common/  (arg parsing, sampling helpers, chat templates)</text>
  <text x="380" y="97" text-anchor="middle" font-size="10" fill="#94a3b8">调用 include/llama.h 公共 C API</text>
  <line x1="380" y1="82" x2="380" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="110" width="720" height="72" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="131" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">libllama  (src/)</text>
  <text x="380" y="149" text-anchor="middle" font-size="11" fill="#64748b">llama.cpp  llama-model.cpp  llama-context.cpp  llama-graph.cpp</text>
  <text x="380" y="167" text-anchor="middle" font-size="11" fill="#64748b">llama-vocab.cpp  llama-model-loader.cpp  llama-kv-cache.cpp  llama-sampler.cpp ...</text>
  <text x="380" y="197" text-anchor="middle" font-size="10" fill="#94a3b8">只通过 ggml.h / ggml-backend.h / gguf.h</text>
  <line x1="380" y1="182" x2="380" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="210" width="720" height="72" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="231" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ggml 计算图 &amp; 调度  (ggml/src/)</text>
  <text x="380" y="249" text-anchor="middle" font-size="11" fill="#64748b">ggml.c  ggml-alloc.c  gguf.cpp  ggml-backend.cpp  ggml-backend-reg.cpp</text>
  <text x="380" y="267" text-anchor="middle" font-size="11" fill="#64748b">ggml-opt.cpp  (optimizer, forward/backward)</text>
  <text x="380" y="297" text-anchor="middle" font-size="10" fill="#94a3b8">后端接口 ggml_backend_i vtable</text>
  <line x1="380" y1="282" x2="380" y2="306" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="20" y="310" width="720" height="20" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="380" y="324" text-anchor="middle" font-size="11" fill="#64748b">后端层：ggml-cpu/  ggml-cuda/  ggml-metal/  ggml-vulkan/  ggml-sycl/  ggml-opencl/  ggml-rpc/ ...</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ llama.cpp 四层架构：工具层 → libllama → ggml 计算图 → 多后端硬件抽象</span>

<details>
<summary>ASCII 原版</summary>

```
┌──────────────────────────────────────────────────────────────────┐
│  工具 / 示例层                                                    │
│  tools/cli/cli.cpp   tools/server/  examples/simple/             │
│  examples/embedding/ examples/batched/ ...                       │
│  common/  (arg parsing, sampling helpers, chat templates)        │
└─────────────────────────┬────────────────────────────────────────┘
                          │ 调用 include/llama.h 公共 C API
┌─────────────────────────▼────────────────────────────────────────┐
│  libllama  (src/)                                                │
│  llama.cpp  llama-model.cpp  llama-context.cpp                  │
│  llama-vocab.cpp  llama-model-loader.cpp  llama-graph.cpp        │
│  llama-kv-cache.cpp  llama-sampler.cpp  llama-batch.cpp ...      │
└─────────────────────────┬────────────────────────────────────────┘
                          │ 只通过 ggml.h / ggml-backend.h / gguf.h
┌─────────────────────────▼────────────────────────────────────────┐
│  ggml 计算图 & 调度  (ggml/src/)                                 │
│  ggml.c  ggml-alloc.c  gguf.cpp                                 │
│  ggml-backend.cpp  ggml-backend-reg.cpp                          │
│  ggml-opt.cpp  (optimizer, forward/backward)                     │
└─────────────────────────┬────────────────────────────────────────┘
                          │ 后端接口 ggml_backend_i vtable
┌─────────────────────────▼────────────────────────────────────────┐
│  后端层  (ggml/src/  + 动态库)                                   │
│  ggml-cpu/   ggml-cuda/   ggml-metal/   ggml-vulkan/            │
│  ggml-sycl/  ggml-opencl/ ggml-rpc/     ...                     │
└──────────────────────────────────────────────────────────────────┘
```

</details>

**设计原则**：上层只见接口，不见实现。`src/llama.cpp` 不直接 `#include` 任何 CUDA/Metal 头文件；它只调用 `ggml_backend_load_all()` 这一个入口，让后端通过动态库注册机制自己进来。这使得 libllama 的编译与后端实现完全解耦。

---

## 2. 公共 API 的核心句柄

公共接口声明在 `include/llama.h`。五个核心句柄各自代表一个领域的状态：

### 2.1 `llama_vocab`

```c
// include/llama.h:61-63
struct llama_vocab;
// 获取方式
const llama_vocab * vocab = llama_model_get_vocab(model);  // :553
```

`llama_vocab` 封装了词表（token id ↔ 字符串映射）、tokenizer 算法（SPM/BPE/WPM/UGM/RWKV/PLaMo2，见 `include/llama.h:72-80`）以及所有特殊 token（BOS/EOS/EOT/PAD）。它**不单独创建**，由 `llama_model` 拥有；调用方只持有 `const` 指针，生命周期与 `llama_model` 相同。

### 2.2 `llama_model`

```c
// include/llama.h:62
struct llama_model;
// 创建
llama_model * model = llama_model_load_from_file(path, params);  // :484
// 释放
llama_model_free(model);  // :507
```

`llama_model` 存储了模型的全部静态内容：GGUF 元数据、超参数（`llama_hparams`）、所有权重张量（分配在 `ggml_backend_buffer` 上），以及架构枚举（`llm_arch`）。它独立于推理上下文，可以被多个 `llama_context` 共享（只读）。从文件加载后权重就不再变动，因此可在多线程中安全地并行推理。

### 2.3 `llama_context`

```c
// include/llama.h:63
struct llama_context;
// 创建
llama_context * ctx = llama_init_from_model(model, ctx_params);  // :509
// 释放
llama_free(ctx);  // :519
```

`llama_context` 是推理运行时状态的容器。它包含：KV 缓存（`llama_memory_i` 接口，对 attention 模型为 `llama_kv_cache`，对 recurrent 模型为 `llama_memory_recurrent`）、计算图（`ggml_cgraph`）、后端调度器（`ggml_backend_sched`）、线程池，以及本次 decode 产出的 logits 缓冲。同一 model 可创建多个 ctx 用于并发推理，每个 ctx 都有独立的 KV 缓存。

`llama_context_params` 中最关键的字段（`include/llama.h:337-390`）：

| 字段 | 含义 |
|---|---|
| `n_ctx` | 上下文长度（token 数量上限） |
| `n_batch` | 单次 `llama_decode` 能接受的最大 logical tokens |
| `n_ubatch` | 物理 micro-batch 大小（`n_batch` 会被拆成 ubatch 分批处理） |
| `n_threads` | 生成阶段（单 token decode）的线程数 |
| `n_threads_batch` | prefill 阶段（批量 prompt 处理）的线程数 |
| `offload_kqv` | KV 缓存是否卸载到 GPU |

### 2.4 `llama_batch`

```c
// include/llama.h:240-249
typedef struct llama_batch {
    int32_t n_tokens;
    llama_token  *  token;   // token ids（与 embd 二选一）
    float        *  embd;    // 直接输入 embedding
    llama_pos    *  pos;     // 每个 token 的位置
    int32_t      *  n_seq_id;
    llama_seq_id ** seq_id;  // 多序列支持
    int8_t       *  logits;  // 哪些位置输出 logits
} llama_batch;
```

`llama_batch` 是单次 `llama_decode` 的输入描述符，本身是 POD 结构体，**不拥有内存**。有两种用法：
- `llama_batch_get_one(tokens, n)` — 轻量包装器，指向调用方的数组，seq_id=0，位置自动追踪（`include/llama.h:911`）；
- `llama_batch_init(n_tokens, embd, n_seq_max)` — 在堆上分配，需用 `llama_batch_free` 释放。

### 2.5 `llama_sampler`

```c
// include/llama.h:63
struct llama_sampler;
// 创建链
llama_sampler * smpl = llama_sampler_chain_init(sparams);
// 添加策略（可叠加）
llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
llama_sampler_chain_add(smpl, llama_sampler_init_top_k(40));
// 采样
llama_token tok = llama_sampler_sample(smpl, ctx, -1);
// 释放
llama_sampler_free(smpl);
```

`llama_sampler` 实现了**责任链**模式（`src/llama-sampler.h`）。链中每个采样器接收 `llama_token_data_array`（logits 数组），对其进行变换（过滤、重排序、归一化），然后传给下一级。最终的 sample 节点从概率分布中抽取一个 token id。常见的采样器有：greedy、top-k、top-p、min-p、temperature、repetition-penalty、mirostat 等，通过 `llama_sampler_chain_add` 任意组合。

---

## 3. 一次最简推理的完整调用序列

以 `examples/simple/simple.cpp` 为线索，逐步分析。

### 3.1 加载动态后端

```cpp
// examples/simple/simple.cpp:82
ggml_backend_load_all();
```

这是唯一一次后端发现调用。`ggml_backend_load_all` 扫描可执行文件同目录及标准路径下的动态库（`libggml-cuda.so`、`libggml-metal.so` 等），调用每个库导出的 `ggml_backend_reg_init`，将后端注册到全局注册表中。CPU 后端始终内置，无需动态加载。注册完成后，`ggml_backend_dev_count()` 返回所有可用设备数量。

### 3.2 加载模型

```cpp
// examples/simple/simple.cpp:86-94
llama_model_params model_params = llama_model_default_params();
model_params.n_gpu_layers = ngl;
llama_model * model = llama_model_load_from_file(model_path.c_str(), model_params);
```

内部路径（第 2 章详述）：`llama_model_load_from_file` → 创建 `llama_model_loader` → 调用 `gguf_init_from_file` 解析 GGUF 元数据 → 按架构枚举实例化模型图 → 分配 `ggml_backend_buffer` → `load_all_data`（mmap 或 read）→ 将权重张量填入缓冲区。

`n_gpu_layers` 控制有多少层（从最顶层往下数）的权重被放到 GPU 显存（通过 `ggml_backend_buffer_type` 选择对应的 VRAM buffer type）；CPU 后端接收其余层。

### 3.3 分词

```cpp
// examples/simple/simple.cpp:99-107
const int n_prompt = -llama_tokenize(vocab, prompt.c_str(), prompt.size(),
                                     NULL, 0, true, true);
std::vector<llama_token> prompt_tokens(n_prompt);
llama_tokenize(vocab, prompt.c_str(), prompt.size(),
               prompt_tokens.data(), prompt_tokens.size(), true, true);
```

**两遍调用**是固定模式：第一次传 NULL buffer，返回值的负数即所需 token 数量；第二次传实际 buffer 完成 tokenize。`add_special=true` 使 tokenizer 在需要时自动添加 BOS token；`parse_special=true` 允许 `<|im_start|>` 等控制 token 被解析为单个 token 而不是多个字节 token。

### 3.4 创建推理上下文

```cpp
// examples/simple/simple.cpp:111-124
llama_context_params ctx_params = llama_context_default_params();
ctx_params.n_ctx = n_prompt + n_predict - 1;
ctx_params.n_batch = n_prompt;
ctx_params.no_perf = false;
llama_context * ctx = llama_init_from_model(model, ctx_params);
```

`llama_init_from_model` 完成：KV 缓存分配（按 `n_ctx * n_layers * n_heads_kv * head_dim * 2` 字节估算）、计算图的 ggml context 分配、后端调度器（`ggml_backend_sched`）初始化，以及 worst-case 图的预留（`sched_reserve`）。这一步可能比加载模型更耗时，因为它需要完整地构建一次计算图来确定中间激活的内存布局。

### 3.5 初始化采样器

```cpp
// examples/simple/simple.cpp:128-132
auto sparams = llama_sampler_chain_default_params();
sparams.no_perf = false;
llama_sampler * smpl = llama_sampler_chain_init(sparams);
llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
```

此处只添加了 greedy 采样器——每次选择 logit 最大的 token。生产代码通常会叠加更多：temperature、top-p、repetition penalty 等。

### 3.6 准备 batch 并 decode

```cpp
// examples/simple/simple.cpp:149
llama_batch batch = llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size());

// examples/simple/simple.cpp:171-203
for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict; ) {
    if (llama_decode(ctx, batch)) { /* error */ }
    n_pos += batch.n_tokens;

    new_token_id = llama_sampler_sample(smpl, ctx, -1);
    if (llama_vocab_is_eog(vocab, new_token_id)) break;

    // 打印并准备下一个 batch
    llama_token_to_piece(vocab, new_token_id, buf, sizeof(buf), 0, true);
    batch = llama_batch_get_one(&new_token_id, 1);
    n_decode += 1;
}
```

**关键观察**：
- 第一次迭代是 prefill（处理整个 prompt），batch.n_tokens 很大（= n_prompt）；
- 后续迭代是 decode，每次只处理 1 个 token（`batch = llama_batch_get_one(&new_token_id, 1)`）；
- `llama_sampler_sample(smpl, ctx, -1)` 的 `-1` 表示取最后一个 token 的 logits（也可以用正整数索引批次内的任意位置）；
- `llama_vocab_is_eog` 检测所有 end-of-generation token（EOS/EOT 等，因架构而异）；
- `llama_token_to_piece` 将 token id 反序列化为 UTF-8 字节片段（注意：一个 token 可能是不完整的多字节字符的片段，调用方需自行拼接）。

### 3.7 释放资源

```cpp
// examples/simple/simple.cpp:218-220
llama_sampler_free(smpl);
llama_free(ctx);
llama_model_free(model);
```

释放顺序：sampler → context → model。model 必须最后释放，因为 context 的权重张量指向 model 拥有的 buffer。

---

## 4. libllama 与 ggml 的边界

`src/llama.cpp` 的 include 列表揭示了边界：

```cpp
// src/llama.cpp:1-17
#include "llama.h"
#include "llama-impl.h"
#include "llama-chat.h"
#include "llama-context.h"
#include "llama-mmap.h"
// ... 其他 src/ 头文件 ...
#include "ggml.h"           // ggml 算子 API
#include "ggml-cpp.h"       // C++ RAII 包装
#include "ggml-backend.h"   // 后端/设备/缓冲区 API
#include "gguf.h"           // GGUF 文件格式解析
```

libllama **只引用** ggml 公共头（`ggml/include/` 下），从不直接调用 CUDA/Metal 原生 API。所有硬件特定操作通过 `ggml_backend_i` vtable 间接触发。这意味着：
1. libllama 可以在没有 GPU 的环境编译，后端库可选；
2. 新后端的添加不需要修改 libllama 的任何代码；
3. 混合精度（如部分层在 GPU、部分在 CPU）由 `ggml_backend_sched` 的调度逻辑自动处理。

`src/llama.cpp` 本身只是一个"薄壳"：它把公共 API 函数转发给各子模块的实现。例如：

```cpp
// src/llama.cpp:65-67（简化）
bool llama_supports_mmap(void) {
    return llama_mmap::SUPPORTED;
}
```

真正的复杂逻辑在 `src/llama-model.cpp`（模型图构建）、`src/llama-context.cpp`（推理调度）、`src/llama-graph.cpp`（计算图）等文件中。

---

## 5. 目录地图

```text
llama.cpp/
├── include/
│   ├── llama.h          公共 C API（唯一对外接口）
│   └── llama-cpp.h      C++ 便利包装（非 ABI 稳定）
│
├── src/                 libllama 实现
│   ├── llama.cpp        API 转发薄壳
│   ├── llama-model.cpp  模型图定义（各架构的 build_graph）
│   ├── llama-context.cpp 推理状态管理、decode/encode
│   ├── llama-graph.cpp  通用计算图工具
│   ├── llama-model-loader.cpp  GGUF 加载、split 聚合
│   ├── llama-mmap.cpp   mmap/mlock 抽象
│   ├── llama-vocab.cpp  tokenizer 实现（SPM/BPE/WPM/UGM）
│   ├── llama-sampler.cpp 采样器链
│   ├── llama-kv-cache.cpp KV 缓存（attention 模型）
│   ├── llama-arch.cpp   架构枚举与 KV 键名映射
│   └── ...
│
├── ggml/                张量库（独立子项目）
│   ├── include/
│   │   ├── ggml.h       张量算子 C API
│   │   ├── ggml-backend.h 后端/设备/缓冲区抽象
│   │   ├── gguf.h       GGUF 格式 C API
│   │   └── ggml-cpu.h   CPU 后端接口
│   └── src/
│       ├── ggml.c       算子实现（通用路径）
│       ├── gguf.cpp     GGUF 解析/序列化
│       ├── ggml-backend.cpp 调度器实现
│       ├── ggml-cpu/    CPU 后端（SIMD 优化）
│       ├── ggml-cuda/   CUDA 后端
│       ├── ggml-metal/  Metal 后端（macOS/iOS）
│       ├── ggml-vulkan/ Vulkan 后端
│       └── ...
│
├── common/              工具层共享库
│   ├── common.h/.cpp    参数解析、日志、格式化
│   ├── sampling.h/.cpp  高级采样封装（top-p, mirostat 等）
│   ├── chat.h/.cpp      对话模板（Jinja2 子集）
│   └── arg.h/.cpp       命令行参数定义
│
├── tools/               独立可执行工具
│   ├── cli/             llama-cli（交互对话）
│   ├── server/          OpenAI 兼容 HTTP server
│   ├── quantize/        量化工具（llama-quantize）
│   ├── gguf-split/      分片/合并 GGUF
│   └── ...
│
├── examples/            简单示例
│   ├── simple/          最小推理示例（本章线索）
│   ├── embedding/       嵌入向量示例
│   └── ...
│
├── convert_hf_to_gguf.py   HuggingFace → GGUF 转换
├── convert_lora_to_gguf.py LoRA → GGUF 转换
├── gguf-py/             Python GGUF 读写库
└── models/              模型配置模板
```

**common/ 与 tools/ 的关系**：`common/` 提供可复用组件（参数解析、采样、聊天模板），`tools/` 中的可执行程序链接 common 和 libllama。`examples/` 的代码不链接 common，只用裸的 `llama.h` API，是学习入口。

---

## 6. 关键设计哲学

### 6.1 最小依赖

整个 llama.cpp 的强制依赖只有标准 C/C++ 库。ggml 不需要 BLAS、不需要 Python、不需要任何框架。所有 GPU 后端通过条件编译引入，若不需要 GPU 则完全不编译相关代码。这使得在嵌入式、边缘设备等受限环境中部署成为可能。

### 6.2 GGUF 自描述

GGUF 文件包含模型运行所需的一切：架构类型、超参数、tokenizer 配置、所有权重。推理程序不需要"配置文件"——只需一个 `.gguf` 文件。对比早期格式：ggml 格式需要外置 tokenizer.model，GPTJ 格式需要 JSON 配置。自描述大幅降低了部署复杂度。

### 6.3 运行时动态后端发现

`ggml_backend_load_all()` 通过 `dlopen`（POSIX）或 `LoadLibrary`（Windows）扫描目录，无需在编译期确定后端集合。这让同一个 llama-cli 二进制文件可以在 CUDA 机器上自动使用 CUDA，在 Apple Silicon 上自动使用 Metal，而不需要用户手动传入编译选项或选择二进制变体。

### 6.4 CPU 优先、可移植

ggml CPU 后端通过 C++ 模板生成针对 AVX2/AVX-512/NEON/SVE 等 SIMD 指令集的向量化代码，并在运行时根据 CPUID 选择最优路径（`ggml/src/ggml-cpu/` 下的大量 `*.cpp` 专用化文件）。GPU 后端是加速路径，CPU 是正确性的基准与回退。

### 6.5 mmap 零拷贝

使用 `mmap` 加载模型时，权重数据直接映射到进程地址空间。操作系统按需（按 page fault）从磁盘载入物理页，未访问的权重不占 RSS。对于量化模型（如 Q4_0），GPU 推理时需要将量化权重从 mmap 区复制到 VRAM；但 CPU 推理时可以直接从 mmap 区计算，实现真正的零额外内存消耗。`llama_model_params.use_mmap` 控制开关，默认开启（`include/llama.h:320`）。

---

## 7. 后续章节学习路线

本 wiki 覆盖 14 个专题章节和 1 个 trace 导览：

| 章 | 主题 | 建议前置 |
|---|---|---|
| **1** | 系统架构总览（本章） | — |
| **2** | GGUF 文件格式与模型加载 | 1 |
| **3** | ggml 张量与算子系统 | 1 |
| **4** | ggml 后端抽象与动态发现 | 3 |
| **5** | ggml 计算图构建与内存分配 | 3, 4 |
| **6** | CPU 后端：SIMD 向量化与量化矩阵乘 | 3, 4 |
| **7** | GPU 后端：CUDA/Metal/Vulkan 后端概览 | 4, 5 |
| **8** | llama-model：架构注册与图构建 | 2, 5 |
| **9** | KV 缓存机制（attention 与 recurrent） | 8 |
| **10** | 词表与 tokenizer（SPM/BPE/WPM） | 2 |
| **11** | 采样器链与解码循环 | 1, 10 |
| **12** | 量化系统（K-quant, IQ, GGUF ftype） | 3, 6 |
| **13** | LoRA 适配器与推理集成 | 8 |
| **14** | llama-server：OpenAI 兼容 HTTP 接口 | 1, 11 |
| **trace** | 单次 token 生成全路径追踪 | 全部 |

**推荐路线**：
- **快速入门**：1 → 2 → 8 → 11，可以理解推理全流程；
- **后端深入**：3 → 4 → 5 → 6 → 7，理解 ggml 底层；
- **模型适配**：2 → 10 → 12 → 13，关注模型格式与量化；
- **服务端部署**：1 → 14，关注 server 接口。

trace 导览在阅读完所有章节后再看，可以帮助将零散知识串联成一次完整的推理执行流。
