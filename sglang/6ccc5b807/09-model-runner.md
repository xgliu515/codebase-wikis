# 第 09 章 ModelRunner 与前向执行

## 本章导读

[第 08 章](08-scheduler.md) 的调度器决定「让哪些请求上 GPU」,然后调 `run_batch`。`run_batch` 之后的世界——把调度批变成 GPU 张量、跑 Transformer、采样——归 **`ModelRunner`** 管。

`ModelRunner` 是「调度世界」和「GPU 计算世界」的边界。它在 Scheduler 子进程里,主体代码在 `python/sglang/srt/model_executor/model_runner.py`(约 3500 行)。本章讲它的三件大事:**加载模型**、**前向执行**、**用 CUDA graph / torch.compile 加速**。

## 1. ModelRunner 是什么

`ModelRunner` 类定义在 `model_runner.py:327`。它持有:

- **模型**:GPU 上一个可跑前向的 Transformer;
- **KV cache 池**:存 K/V 的显存(见 [第 07 章](07-kv-cache-memory.md));
- **注意力后端**:执行注意力的具体实现(见 [第 10 章](10-attention-backends.md));
- **CUDA graph runner**:加速 decode 的图执行器。

它的初始化由 `__init__`(`model_runner.py:330`)和 `initialize`(`:599`)完成,关键步骤顺序是:

<svg viewBox="0 0 540 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ModelRunner initialization sequence">
<defs>
<marker id="r9ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="120" y="16" width="300" height="48" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="270" y="38" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">load_model()</text>
<text x="270" y="55" text-anchor="middle" font-size="10" fill="#64748b">加载权重（第 2 节）</text>
<line x1="270" y1="64" x2="270" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar)"/>
<rect x="120" y="90" width="300" height="48" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="270" y="112" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">profile + init_memory_pool()</text>
<text x="270" y="129" text-anchor="middle" font-size="10" fill="#64748b">定容 KV 池（须在权重加载后，知道剩多少显存）</text>
<line x1="270" y1="138" x2="270" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar)"/>
<rect x="120" y="164" width="300" height="48" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="270" y="186" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">init_attention_backend()</text>
<text x="270" y="203" text-anchor="middle" font-size="10" fill="#64748b">选注意力后端（第 10 章）</text>
<line x1="270" y1="212" x2="270" y2="236" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar)"/>
<rect x="120" y="238" width="300" height="48" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="270" y="260" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">init_cuda_graphs()</text>
<text x="270" y="277" text-anchor="middle" font-size="10" fill="#64748b">捕获 CUDA graph（须在 KV 池建好后，图要用池子地址）</text>
<text x="270" y="306" text-anchor="middle" font-size="10" fill="#94a3b8">顺序由依赖关系决定，不可调换</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ ModelRunner 初始化的四步固定顺序，每一步都依赖前一步的产物</span>

<details>
<summary>ASCII 原版</summary>

```text
  load_model()           加载权重 (第 2 节)
        │
  profile + init_memory_pool()   定容 KV 池 (第 07 章)
        │
  init_attention_backend()       选注意力后端 (第 10 章)
        │
  init_cuda_graphs()             捕获 CUDA graph (第 5 节)
```

</details>

这个顺序不是随意的:KV 池要在权重加载后定容(知道剩多少显存),CUDA graph 要在 KV 池建好后捕获(图要用池子地址)。详见 [导览步骤 03-05](tour-00-overview.md)。

## 2. 加载模型:骨架 + 权重数值

`load_model`(`model_runner.py:1214`)做的是「拼接」:SGLang 自己的模型骨架,灌进 HuggingFace 文件里的权重数值。

### 为什么不用 HuggingFace 的模型

HuggingFace 的模型实现能跑,但它的注意力层不认识 SGLang 的分页 KV cache、连续批处理、可插拔后端。所以**计算图必须是 SGLang 自己写的**,只有**权重数值**从 HF 文件拿(详细论证见 [导览步骤 03](tour-03-load-weights.md))。

### 模型骨架:`srt/models/`

`python/sglang/srt/models/` 下有 191 个模型文件——`llama.py`、`qwen*.py`、`deepseek_v2.py`、`mixtral.py`、`gemma*.py` 等等。每个文件用 SGLang 的层(`RadixAttention`、各种 `Linear`、MoE 层等)实现一个模型架构。

加载时,`load_model` 读 `config.json` 的 `architectures` 字段(如 `LlamaForCausalLM`),据此选中 `srt/models/` 里对应的骨架类。

### 权重加载器:`srt/model_loader/`

灌权重的活在 `python/sglang/srt/model_loader/`:

- `loader.py`:加载器主体,把 `*.safetensors` 里的张量按命名映射规则对应到骨架参数、`copy_` 进去、放 GPU;
- `weight_utils.py`:权重处理工具;
- `remote_instance_weight_loader_utils.py`:从远端实例传权重(权重共享场景)。

加载器还处理**量化**——FP8 / AWQ / GPTQ 等格式的权重在加载时按量化方案解读(见 [第 14 章](14-advanced-features.md))。

权重热更新由 `update_weights_from_disk`(`model_runner.py:1568`)、`update_weights_from_distributed`(`:1798`)、`update_weights_from_tensor`(`:1888`)、`update_weights_from_ipc`(`:3388`)等支持——RLHF 训练里训练侧把新权重推给推理侧,就走这些路径。

## 3. ScheduleBatch → ForwardBatch

`run_batch` 把 `ScheduleBatch` 交给 `ModelRunner` 后,第一件事是转成 `ForwardBatch`(`python/sglang/srt/model_executor/forward_batch_info.py`)。

这道转换把「调度视角的散乱信息」摊平成「GPU 视角的规整张量」:`input_ids`、`positions`、`out_cache_loc`(新 KV 写入位置)、`seq_lens`,并调用注意力后端的 `init_forward_metadata` 建好注意力元数据。它是 CPU 杂活的集中地——做完之后,纯 GPU 计算阶段就不再碰 Python 对象。这也是 CUDA graph 能工作的前提(张量形状/地址固定)。完整论证见 [导览步骤 13](tour-13-forward-batch.md)。

## 4. 前向执行:extend 与 decode 两条路

`ModelRunner.forward`(`model_runner.py:3111`)是前向总入口。它按 `ForwardBatch.forward_mode` 分派到不同路径:

| 模式 | 方法 | 含义 |
|------|------|------|
| `EXTEND` | `forward_extend`(`model_runner.py:2991`) | prefill:一次并行处理多个新 token |
| `DECODE` | `forward_decode`(`model_runner.py:2955`) | decode:一次只处理 1 个新 token |
| `IDLE` | `forward_idle`(`model_runner.py:3059`) | 空转(并行同步用) |
| split prefill | `forward_split_prefill`(`model_runner.py:3084`) | 分块 prefill |

**extend 和 decode 为什么要分开**:prefill 时整个 prompt 已知,所有 token 可以一次性并行过 Transformer(因果掩码保证正确);decode 时下一个 token 还没生成,只能逐个来。两者的计算形状、kernel 路径、是否走 CUDA graph 都不同。这是 SGLang 前向逻辑里最根本的一条分界(详见 [导览步骤 14](tour-14-model-forward.md)、[步骤 17](tour-17-decode-loop.md))。

前向跑完得到 hidden state,最后一个位置过 lm_head 得到 logits,再交给 `sample`(`model_runner.py:3304`)采样(见 [第 11 章](11-sampling-constrained.md))。

## 5. CUDA graph:消灭 decode 的内核启动开销

decode 一次只算 1 个 token,GPU 实际计算量极小,但「发起这次计算」要 CPU 逐个 launch 几百个 CUDA kernel——launch 开销比计算本身还大,GPU 利用率可能跌到 10% 出头。

**CUDA graph** 把一次前向涉及的几百个 kernel **录成一张图**,运行时一次 `replay` 全发出去,launch 开销从「几百次」压成「一次」。

由 `CudaGraphRunner`(`python/sglang/srt/model_executor/cuda_graph_runner.py:548`)负责:

- CUDA graph 要求张量形状/地址固定,所以 SGLang 为**一组预设 batch size** 各录一张图。`get_batch_sizes_to_capture`(`cuda_graph_runner.py:500`)从 `server_args.cuda_graph_bs` 算出要录的 `capture_bs`;
- `capture`(`cuda_graph_runner.py:817`)在初始化时把每个 bs 的图录好;
- 运行时 `can_run`(`:722`)判断当前 batch 有没有对应的图,有就走图、没有就退回普通路径。

SGLang 还有图的变体:

- `breakable_cuda_graph_runner.py`:可打断的图;
- `piecewise_cuda_graph_runner.py`:**部分图**——把前向切成若干段,只对适合的段录图。这让一部分 prefill 计算也能享受图加速。
- `cpu_graph_runner.py`:CPU 后端的对应物。

prefill 一般不整体走图(token 数千变万化、launch 占比小),但 piecewise 图是个折中。完整论证见 [导览步骤 05](tour-05-capture-cuda-graph.md)。

## 6. torch.compile 集成

CUDA graph 解决「launch 开销」,但不优化「kernel 本身」。**torch.compile** 是另一条路:它用 PyTorch 2 的编译栈(TorchDynamo + Inductor)把模型代码编译成融合后的高效 kernel——比如把若干小算子融成一个,减少显存读写。

相关代码在 `python/sglang/srt/compilation/`:

- `backend.py`、`compiler_interface.py`:编译后端接口;
- `cuda_piecewise_backend.py`:piecewise 编译后端——和 piecewise CUDA graph 配合;
- `pass_manager.py`、`inductor_pass.py`、`fix_functionalization.py`:编译优化 pass。

torch.compile 和 CUDA graph 不是二选一——它们正交:torch.compile 让每个 kernel 更快,CUDA graph 让 kernel 不用反复 launch。SGLang 可以同时用(`get_batch_sizes_to_capture` 里 `compile_bs` 就是为 torch.compile 准备的 batch size 集合,`cuda_graph_runner.py:528`)。

## 7. 与其他子系统的接口

`ModelRunner` 是执行层的中枢:

- 上游 **Scheduler**([第 08 章](08-scheduler.md)):`run_batch` 调进来;
- **KV cache**([第 07 章](07-kv-cache-memory.md)):`init_memory_pool` 建池子,前向时读写;
- **注意力后端**([第 10 章](10-attention-backends.md)):`init_attention_backend`(`model_runner.py:2215`)选后端,前向时调它算注意力;
- **采样**([第 11 章](11-sampling-constrained.md)):`sample` 把 logits 变成 token;
- **分布式**([第 13 章](13-distributed.md)):`apply_torch_tp`(`model_runner.py:2945`)、张量并行下的权重切分。

## 相关章节

- [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) —— `init_memory_pool` 与 KV 池
- [第 08 章 调度器与连续批处理](08-scheduler.md) —— `run_batch` 的来路
- [第 10 章 注意力后端与 CUDA 内核](10-attention-backends.md) —— `ModelRunner` 调用的注意力实现
- [第 11 章 采样与约束解码](11-sampling-constrained.md) —— `sample` 之后
- [第 14 章 高级特性与模型网关](14-advanced-features.md) —— 量化加载、模型仓库
- [导览步骤 03、05、13、14](tour-00-overview.md) —— 加载、捕获图、前向的实际 trace
