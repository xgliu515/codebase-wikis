# Trace 步骤 02 —— CUDA graph 为什么 capture，怎么 capture？

> 这是 "vllm 单请求 trace" 的第 02 步，紧接 [步骤 01：KV cache 池能塞多少？](tour-01-kv-cache-sizing.md)。

## 1. 当前情境

`LLM(model="Qwen/Qwen2.5-7B-Instruct")` 还没返回。上一步 `profile_run` 已经把"forward 峰值"实测出来了，`num_gpu_blocks` 也算好了。

但此刻 KV cache **池子还没被分配**——那是下一步（步骤 03 末尾）的事。

紧跟在 profile 之后，引擎会做一件外行看上去很奇怪、内行知道至关重要的事：把模型 forward 在几十种"假 batch size"上**预先录一遍 CUDA graph**。这一步在日志里会看到一行 `Capturing CUDA graphs ...`，配 tqdm 进度条，通常吃掉 5-20 秒。

本步就是讲这件事。

## 2. 问题

LLM 推理 forward 是**调用密集型**：一个 7B 模型有 28 层，每层至少 4-5 次 GEMM、1 次 attention、1 次 RMSNorm、若干 elementwise，再加 sampling，一次 forward 容易有几百到上千个 CUDA kernel launch。

每个 kernel launch 都要走 CPU → driver → GPU 的链路。在 H100/A100 上一次 launch 大约 5-10 μs（pinned 情况下），单步 forward 光 launch overhead 就能堆到几毫秒。

对 **decode 阶段**尤其致命：decode 一次只生成 1 个 token，整个 forward 算的东西很少，CPU launch 反而成了瓶颈——GPU 空转等着 CPU 喂下一个 kernel。

**问题**：怎么把"重复结构、固定输入形状"的 forward 的 launch overhead 降到接近零？

## 3. 朴素思路

"那就用 `torch.compile` 把整个 forward 编译成一个大 fused kernel 不就行了？"

或者更朴素：把每个 layer 的代码手写成一个 CUDA kernel，全在一个 stream 上一把 launch。

## 4. 为什么朴素思路会崩

**`torch.compile` 一把梭**这条路 vllm 其实在走（compilation mode = `VLLM_COMPILE`），但它**只解决 op fusion，不解决 launch overhead**。Inductor 把许多 elementwise op fuse 成一个 Triton kernel，能从 1000 个 launch 减到比如 200 个，仍然没到"零"。

更根本的问题是 **attention 不能被 fuse 成普通 op**：

- PagedAttention 内部要按 `block_table` 间接寻址、对每个 head 做不同 softmax，这是动态形状（kv_len 因序列而异、cu_seqlens 是 batch 级别动态量）
- FlashAttention / FlashInfer 这些 backend 有自己手写的 kernel，期望 `query`、`kv_cache`、`cu_seqlens_q`、`cu_seqlens_k` 这些 tensor 的**指针**保持稳定
- 它们内部还会用 atomics、persistent kernel 等 trick，Inductor 没办法把它们重新生成出来

所以无论怎么 compile，**attention 本身始终是一个 op 边界**，必须以 CUDA kernel 的形式被 launch。这就限制了"全图编译"能省下的 launch 数。

**手写一个 mega-kernel** 不现实：模型结构每个家族都不一样，控制流也不全是静态的（比如 LoRA 的 active adapter、量化的 scale fetch）。

真正能把"launch 序列本身"录下来再回放的，只有 **CUDA Graph** 这个 API。

## 5. vllm 的做法

CUDA Graph 的契约：在 capture 模式下跑一遍 forward，CUDA driver 把这次 forward **发出的所有 kernel + 它们的 stream 依赖**记录成一张静态图；之后 `graph.replay()` 只需要一次 host→device 提交就能让整张图全跑完，单次 launch overhead 降到接近 1 μs。

但 CUDA Graph 有两个硬约束：

1. **输入 tensor 的指针、形状、stride 都必须固定**——replay 的时候这些参数不能变
2. **不允许在 capture 期间做 host-device 同步**（比如 `tensor.item()`、`print`、CPU 上看 GPU 结果再决定走哪个 if 分支）

vllm 围绕这两个约束做了四件事：

### 5.1 bucket：每个 batch size 一张图

输入形状必须固定 → 那就**为常见的 batch size 各录一张图**，replay 时挑最近的一档。

vllm 把这套"被 capture 的 batch size 集合"叫 `cudagraph_capture_sizes`，默认值是从 1 开始、按 1/2/4/8/16/24/32/40/...这样递增到 `max_num_seqs`。运行时输入实际 token 数为 N，dispatcher 会找**第一个 >= N 的 bucket**，pad 到那个尺寸，replay 对应的图。

代码：`vllm/v1/cudagraph_dispatcher.py:76-113` 的 `_compute_bs_to_padded_graph_size` 预计算了一个 `bs → padded_bs` 的查表数组。

### 5.2 piecewise vs full：把动态形状的部分切出去

attention 是动态形状（kv_len 随序列变），不能进 CUDA Graph。vllm 提供两种模式：

<svg viewBox="0 0 880 432" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="PIECEWISE 与 FULL 两种 CUDA graph capture 模式对比">
  <defs>
    <marker id="t2ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">attention 是动态形状 → 两种处理方式</text>
  <g transform="translate(40, 50)">
    <text x="180" y="0" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">PIECEWISE</text>
    <text x="180" y="18" text-anchor="middle" font-size="10" fill="#94a3b8">attention 挖洞出去，其余每段单独 capture</text>
    <rect x="60" y="36" width="240" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="5"/>
    <text x="180" y="58" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">embed + pre_attn （Graph A）</text>
    <line x1="180" y1="70" x2="180" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="60" y="92" width="240" height="34" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" rx="5"/>
    <text x="180" y="108" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">ATTN op  （图外, 常规 launch）</text>
    <text x="180" y="121" text-anchor="middle" font-size="9" fill="#b91c1c">kv_len 动态，不能进图</text>
    <line x1="180" y1="126" x2="180" y2="146" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="60" y="148" width="240" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="5"/>
    <text x="180" y="170" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">post_attn + MLP （Graph B）</text>
    <line x1="180" y1="182" x2="180" y2="202" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="60" y="204" width="240" height="34" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5,3" rx="5"/>
    <text x="180" y="226" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">ATTN op  （图外）</text>
    <line x1="180" y1="238" x2="180" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="60" y="260" width="240" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="5"/>
    <text x="180" y="282" text-anchor="middle" font-size="12" font-weight="600" fill="#9a3412">post_attn + MLP （Graph C）</text>
    <text x="180" y="313" text-anchor="middle" font-size="11" fill="#64748b">launch 数 ≈ N 张 graph + N 次 attention</text>
    <text x="180" y="328" text-anchor="middle" font-size="10" fill="#94a3b8">兼容所有 attention backend</text>
  </g>
  <line x1="440" y1="44" x2="440" y2="360" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <g transform="translate(500, 50)">
    <text x="180" y="0" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">FULL</text>
    <text x="180" y="18" text-anchor="middle" font-size="10" fill="#94a3b8">attention 一起入图，整层 capture 成单张</text>
    <rect x="40" y="36" width="280" height="200" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="8"/>
    <text x="180" y="56" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">单张 Graph （Full Layer）</text>
    <line x1="60" y1="68" x2="300" y2="68" stroke="#0d9488" stroke-width="0.8" stroke-dasharray="2,2"/>
    <rect x="80" y="78" width="200" height="26" fill="white" stroke="#0d9488" stroke-width="1" rx="3"/>
    <text x="180" y="96" text-anchor="middle" font-size="11" fill="#115e59">embed + pre_attn</text>
    <line x1="180" y1="104" x2="180" y2="118" stroke="#0d9488" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="80" y="120" width="200" height="26" fill="white" stroke="#0d9488" stroke-width="1.5" rx="3"/>
    <text x="180" y="138" text-anchor="middle" font-size="11" font-weight="700" fill="#0f766e">ATTN op  （也在图内）</text>
    <line x1="180" y1="146" x2="180" y2="160" stroke="#0d9488" stroke-width="1.2" marker-end="url(#t2ar)"/>
    <rect x="80" y="162" width="200" height="26" fill="white" stroke="#0d9488" stroke-width="1" rx="3"/>
    <text x="180" y="180" text-anchor="middle" font-size="11" fill="#115e59">post_attn + MLP</text>
    <text x="180" y="218" text-anchor="middle" font-size="10" fill="#0f766e">backend 要支持 cudagraph capture</text>
    <text x="180" y="313" text-anchor="middle" font-size="11" fill="#64748b">launch 数 = 1 次 graph replay</text>
    <text x="180" y="328" text-anchor="middle" font-size="10" fill="#94a3b8">FlashAttention3 / FlashInfer 都已支持</text>
  </g>
  <g transform="translate(40, 408)">
    <text x="400" y="0" text-anchor="middle" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">v1 默认 FULL_AND_PIECEWISE：</tspan>decode batch 走 FULL（最省 launch），prefill 与 mixed batch 走 PIECEWISE（更灵活）</text>
  </g>
</svg>
<span class="figure-caption">图 T2.1 ｜ PIECEWISE 把 attention 挖出图外、其余分段 capture；FULL 把整层连 attention 一起 capture 成单张 graph。前者兼容性最广，后者 launch 数最少</span>

<details>
<summary>ASCII 原版</summary>

```
PIECEWISE：                                    FULL：

  [emb] ──> [pre_attn]                          [emb] ──> [pre_attn]
              │                                              │
              ▼                                              ▼
          ┌───────┐  ← 这里"挖个洞"出去             ┌───────┐
          │ATTN op│                                 │ATTN op│  ← 直接进图
          └───────┘                                 └───────┘
              │                                              │
              ▼                                              ▼
          [post_attn] ──> [next layer]              [post_attn] ──> [next layer]
              │ │
              ▼ ▼
        每个 piece 各是一张
        CUDA Graph，attention
        在图之间被普通 launch
```

</details>

- **PIECEWISE**：把模型 fx 图按 `splitting_ops`（默认是 attention 相关 op，见 `vllm/config/compilation.py:1099-1167` 的 `set_splitting_ops_for_v1`）切成 N+1 段，attention 留在图外用常规 launch，每个非 attention 段单独 capture 成 CUDA Graph。
- **FULL**：连 attention 一起 capture。前提是 attention backend 自己能支持"形状固定 + 通过 block_table 索引变长 KV"，比如 FlashAttention3 在 vllm 里就提供了 `build_for_cudagraph_capture` 路径（见 `vllm/v1/worker/gpu_model_runner.py:2323`）。

v1 默认是 **FULL_AND_PIECEWISE**（见 `vllm/config/compilation.py:613`）：decode batch 走 FULL（最省 launch、形状最规整），prefill 和 mixed 走 PIECEWISE（更灵活）。

### 5.3 走通 `torch.compile`，让 Inductor 给图做内部 fusion

CUDA Graph 只省 launch 不省算力。CUDA Graph + `torch.compile` 才能省两次：

1. `@support_torch_compile` 装饰器（`vllm/compilation/decorators.py:86-248`）把 `nn.Module.forward` 接进 vllm 的 Inductor backend
2. `PiecewiseBackend`（`vllm/compilation/piecewise_backend.py:86`）按 `splitting_ops` 切 fx 图，每段交给 Inductor 编译
3. 每段 Inductor 产物再被 `CUDAGraphWrapper`（`vllm/compilation/cuda_graph.py:145`）包一层，第一次按某个 bucket size 调用时执行 capture，后续 replay

`compile_sizes`、`cudagraph_capture_sizes` 是两套独立的尺寸列表：前者控制 Inductor 针对哪些 size 做专门编译，后者控制为哪些 size 录图。默认情况下，`cudagraph_capture_sizes` 是 `compile_sizes` 的超集。

### 5.4 capture 流程

实际入口在 `vllm/v1/worker/gpu_model_runner.py:6303` 的 `capture_model`，触发是 worker 的 `compile_or_warm_up_model`（`vllm/v1/worker/gpu_worker.py:574`）。流程：

```
1. set_cudagraph_capturing_enabled(True)
2. 进入 graph_capture 上下文（绑一个共享的 memory pool 给所有 cudagraph）
3. dispatcher.get_capture_descs() 返回所有要 capture 的 (mode, batch_descriptor) 对
   （按 num_tokens 倒序：大尺寸先 capture，后续小尺寸复用大尺寸已分配的 graph pool 内存）
4. 对每个 batch_descriptor：
   a. _warmup_and_capture：先跑 cudagraph_num_of_warmups 次普通 forward（默认 0；
      作用是让 CUDA 分配器、kernel autotuner 把缓存预热好）
   b. 再以 is_graph_capturing=True 跑一次 _dummy_run，
      触发 CUDAGraphWrapper.__call__ 的 capture 分支
5. set_cudagraph_capturing_enabled(False)  ← 此后任何 capture 都会触发 assert
6. 日志打印 "Graph capturing finished in X secs, took Y GiB"
```

为什么大尺寸先 capture？因为 capture 期间所有 graph 共用一个 `graph_pool`。先 capture 大的、为它分配出大块连续显存，小尺寸再 capture 时复用同一块，最终 `cuda_graph_size = start_free - end_free` 就是这一片共用 pool 的总占用。如果反着来，CUDA 分配器会为小图分小块，再为大图分大块，pool 总尺寸偏大。

至于"capture 失败怎么 fallback"——vllm 是**fail loud**：

- 如果 cudagraph_mode 配了 PIECEWISE 但 attention backend 不支持 piecewise compilation，`CudagraphDispatcher.__init__`（`vllm/v1/cudagraph_dispatcher.py:53`）会直接 assert
- 如果某个 op 在 capture 期间触发了 host sync，CUDA 自己会抛 `cudaErrorStreamCaptureUnsupported`
- 用户也可以一刀切 `enforce_eager=True`，`gpu_worker.py:611` 那一行 `if not self.model_config.enforce_eager:` 就会跳过整个 `capture_model`，每次都走普通 launch

显存代价：日志里那行 `took Y GiB` 通常是 0.5-3 GiB（7B 模型默认配置下大约 1-2 GiB）。这部分在步骤 01 的 `gpu_memory_utilization=0.9` 容差里被预留出来——它不进 KV cache pool，但确实从那"剩下的 10%"里啃掉一块。

## 6. 代码位置

- 入口（worker 层）：`vllm/v1/worker/gpu_worker.py::compile_or_warm_up_model:574-612`
- capture 主循环：`vllm/v1/worker/gpu_model_runner.py::GPUModelRunner.capture_model:6303-6391`
- 一个 bucket 的 capture 细节：`vllm/v1/worker/gpu_model_runner.py::_warmup_and_capture:6393` 和 `_capture_cudagraphs:6428`
- dispatcher（运行时挑图）：`vllm/v1/cudagraph_dispatcher.py:15-354`
- 单图 capture/replay 包装：`vllm/compilation/cuda_graph.py::CUDAGraphWrapper:145-330`
- 微批 capture：`vllm/v1/worker/gpu_ubatch_wrapper.py::UBatchWrapper._capture_ubatches:202-292`
- torch.compile 装饰器：`vllm/compilation/decorators.py::support_torch_compile:86-248`
- 切图后端：`vllm/compilation/piecewise_backend.py::PiecewiseBackend:86-358`
- `cudagraph_mode` 配置定义：`vllm/config/compilation.py:589-625`
- `splitting_ops` 选择：`vllm/config/compilation.py::set_splitting_ops_for_v1:1099`

**阅读顺序**：先看 `compile_or_warm_up_model` 知道 capture 在生命周期里的位置；再看 `capture_model` 看高层编排；然后下到 `CUDAGraphWrapper.__call__` 看 capture 一张图的物理细节；最后回到 `CudagraphDispatcher.dispatch` 看 runtime 怎么挑图。`piecewise_backend.py` 和 `decorators.py` 是 torch.compile 协作部分，第一遍可以跳。

## 7. 分支与延伸

- **`cudagraph_mode` 五种取值的具体差别**（NONE / PIECEWISE / FULL / FULL_DECODE_ONLY / FULL_AND_PIECEWISE）以及"为什么 v1 默认 FULL_AND_PIECEWISE 是性价比最高的" → [第 11 章 §4 CUDA graph](11-advanced-features.md#4-cuda-graph)
- **torch.compile 在 vllm 里的具体执行链路**（fx capture → Inductor pass → CUDA Graph wrap）+ `compile_sizes` vs `cudagraph_capture_sizes` 的关系 → [第 11 章 §3 torch.compile 集成](11-advanced-features.md#3-torchcompile-集成)
- **CudagraphDispatcher 的 dispatch 在每次 forward 哪里被调用、怎么 fallback 到 NONE** → [第 6 章 §10 cudagraph dispatcher](06-worker-and-model-runner.md#10-cudagraph-dispatcher)
- **`enforce_eager=True` 完全关 capture 会损失多少吞吐？** decode-heavy workload 通常 20-40%，prefill-heavy 不大；衡量方法 → [第 11 章 §4](11-advanced-features.md#4-cuda-graph)
- **CUDA Graph 的物理含义和约束**（为什么 capture 期间不能 `tensor.item()`、为什么 input 指针必须固定）→ [第 2 章 §9 CUDA graph 概念](02-core-theory.md#9-cuda-graph)
- **piecewise 切图依据 `splitting_ops`** —— 哪些 op 是默认 splitting 候选？为什么 `unified_kv_cache_update` 也在里面？ → [第 6 章 §10](06-worker-and-model-runner.md#10-cudagraph-dispatcher) + [第 11 章 §3](11-advanced-features.md#3-torchcompile-集成)
- **spec decode 怎么影响 capture？** draft model 也要 capture 一套；`uniform_decode_query_len = 1 + num_speculative_tokens`（见 `cudagraph_dispatcher.py:37`） → [第 11 章 §1 spec decode](11-advanced-features.md#1-投机解码)
- **TP/EP 下 capture 怎么变？** NCCL 通信 op 也会被录进图，所以 `init_device` 必须在 profile 之前完成（见 `gpu_worker.py:283`） → [第 10 章 §3 通信原语与 CUDA Graph](10-distributed-and-parallel.md#3-通信原语与-cuda-graph)
- **ubatching/DBO 模式下的多线程 capture** → [第 6 章 §11 ubatching wrapper](06-worker-and-model-runner.md#11-ubatching-wrapper)
- **LoRA 的 `cudagraph_specialize_lora` 是什么？** 为不同的 active adapter 数量各录一套图，避免无 LoRA 时还过 LoRA op → [第 11 章 §5 LoRA](11-advanced-features.md#5-lora)
- **encoder（视觉塔）单独有一个 EncoderCudaGraphManager** → [第 11 章 §6 多模态](11-advanced-features.md#6-多模态)
- **CompilationMode 三种取值**（NO_COMPILATION / DYNAMO_AS_IS / VLLM_COMPILE）以及和 cudagraph_mode 的正交关系 → [第 11 章 §3](11-advanced-features.md#3-torchcompile-集成)
- **术语"bucket"在 vllm 里别处也出现过**（input batch 的 `_pad_to_next_bucket`）→ [第 12 章 术语表 - bucket](12-glossary-and-faq.md#bucket)

## 8. 走完这一步你脑子里应该多了什么

1. CUDA Graph 是**消除 launch overhead** 的工具，不是消除算力的工具；它解决的是"几百次 kernel launch 累计成几毫秒 CPU 开销"这个具体问题，对 decode 阶段尤其关键
2. 输入形状必须固定 → 必须**离散化成几十个 bucket**，runtime 找最近 bucket 然后 pad；动态形状的 attention → 要么挖洞出去（PIECEWISE）要么走支持 cudagraph 的 backend（FULL）
3. capture 不是免费的：吃 5-20 秒启动时间、吃 1-2 GiB 显存（共享 graph pool）；这部分显存被预留在 `gpu_memory_utilization=0.9` 的"10% 容差"里，不进 KV cache
4. `CudagraphDispatcher` 是 capture 与 runtime 之间的**唯一中转站**：capture 阶段它枚举所有 (mode, batch_descriptor) 让 runner 录图；runtime 阶段它根据本次 batch 的特征（num_tokens / uniform_decode / has_lora）挑一张图，挑不到就降到 PIECEWISE，再挑不到就降到 NONE（裸 forward）
