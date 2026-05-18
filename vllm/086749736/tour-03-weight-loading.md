# Trace 步骤 03 —— 模型权重怎么从 HuggingFace 进到 vllm 的内部布局？

> 这是 "vllm 单请求 trace" 的第 03 步，紧接 [步骤 02：CUDA graph capture](tour-02-cudagraph-capture.md)。

## 1. 当前情境

走完前面两步，你已经知道 KV cache 池要开多大、CUDA graph bucket 也都录好了。本步实际上在时间轴上**早于** capture——但读到这里你才会问"那些参数到底是什么时候从 HF safetensors 文件搬进 GPU 的？"。

正确的顺序（见 `vllm/v1/engine/core.py:128-283` 和 `vllm/v1/worker/gpu_worker.py`）：

```
init_device           ← 步骤 01 之前
load_model            ← 本步的主题，发生在最早
determine_available_memory   ← 步骤 01（profile_run 用的就是已经加载好的真权重）
initialize_from_config       ← 步骤 01 末尾，分配 KV cache 池（!!）
compile_or_warm_up_model     ← 步骤 02（kernel warmup + capture_model）
```

把本步放在第 3 个讲，是因为它**最不影响主线推理流程**：权重一旦到 GPU 上就是静态的，trace 后面所有步骤都把它当作"已经在那"。但实际时序里它是最早发生的事。

走完本步，三件事齐了：

1. 所有 `nn.Parameter` 都有真实权重（不再是 meta device 上的占位）
2. KV cache 池已分配（步骤 01 末尾完成）
3. CUDA graph 已 capture（步骤 02 完成）

此时 `LLM(...)` 构造函数才返回。

## 2. 问题

HuggingFace 的 `safetensors` 文件里，每个张量有个名字，是 HF 模型代码定义的，比如 Qwen2.5/LLaMA 是：

```
model.embed_tokens.weight
model.layers.0.self_attn.q_proj.weight
model.layers.0.self_attn.k_proj.weight
model.layers.0.self_attn.v_proj.weight
model.layers.0.self_attn.o_proj.weight
model.layers.0.mlp.gate_proj.weight
model.layers.0.mlp.up_proj.weight
model.layers.0.mlp.down_proj.weight
...
lm_head.weight
```

vllm 的内部 `nn.Module` 是**不一样的结构**。出于性能考虑，vllm 把：

- `q_proj` + `k_proj` + `v_proj` 合并成一个 `QKVParallelLinear`，参数名叫 `qkv_proj.weight`
- `gate_proj` + `up_proj` 合并成一个 `MergedColumnParallelLinear`，参数名叫 `gate_up_proj.weight`

合并是为了**一次 GEMM 出三个结果**，省 launch、复用 cuBLAS workspace。

**核心问题**：HF 的 5 个张量 → vllm 的 2 个张量。简单的 key-by-key copy 不行。

还有几个相关子问题：

- HF safetensors 文件经常 10-100 GB，必须**流式加载**，一个文件读完一段就交给 model 写入 GPU，不能一次性塞内存
- 如果是 TP（tensor parallel），每个 rank 还只要其中一片；连读都不应该读完
- 量化模型 checkpoint 里有额外的 `scale`、`zero_point`，这些参数 vllm 模型代码里**没有对应字段**——它们要被路由到 attention 层的 `k_scale` / `v_scale` 这种特殊位置
- 加载失败该怎么报错？如果 HF 的某个 key 找不到对应 vllm Parameter，是 skip 还是抛？

## 3. 朴素思路

"读 state_dict，遍历，挨个 `param.data.copy_(loaded)` 不就行了？"

```python
import torch, safetensors
hf_state = {}
for f in glob("*.safetensors"):
    hf_state.update(safetensors.torch.load_file(f))

for name, p in model.named_parameters():
    p.data.copy_(hf_state[name])
```

四行代码，看上去就该这样。

## 4. 为什么朴素思路会崩

四处崩点：

1. **`load_file` 会一次性把整个文件吃进 RAM。** Qwen2.5-72B 的 safetensors 总共 130+ GiB。机器没 200 G 内存就 OOM 死在这一步。
2. **`name` 对不上**。HF 给的是 `model.layers.0.self_attn.q_proj.weight`，vllm 的 `named_parameters()` 里这个名字根本不存在——只有 `model.layers.0.self_attn.qkv_proj.weight`。直接 `hf_state[name]` `KeyError`。
3. **就算你把名字 remap 对了**——HF 里 `q_proj.weight` 形状是 `[H_q, H]`，但 vllm 的 `qkv_proj.weight` 形状是 `[H_q + H_kv + H_kv, H]`。你必须把 q 写到前 `H_q` 行、k 写到中间、v 写到后面。`copy_()` 一上来就 size mismatch。
4. **量化 checkpoint**：HF 的 `q_proj.k_scale` 在 vllm 里要被映射到 `self_attn.attn.k_scale`（attention 层而不是 linear 层），还要 deprecate 老的 `kv_scale` 这种合并形式。朴素 copy 根本看不到这种语义层的 remap。

每一条都意味着"我得在拷贝点知道这个权重背后是什么意思"——这就是 vllm 必须搞 weight loader 框架而不是用 PyTorch 默认 `load_state_dict` 的根本原因。

## 5. vllm 的做法

vllm 的策略：**让 model 类自己说"我能吃哪些 HF key，每个 key 怎么吃"**。整个加载是一个**外层 streaming 迭代器 + 内层 model 的 `load_weights` 方法**的协作模式。

### 5.1 三层结构

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vllm 权重加载的三层结构：loader、流式 iterator、模型 load_weights">
  <defs>
    <marker id="t3ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">权重加载的三层协作：编排 / 流式读取 / 名字 remap</text>
  <g transform="translate(40, 44)">
    <rect x="0" y="0" width="680" height="118" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="20" y="22" font-size="13" font-weight="700" fill="#9a3412">① DefaultModelLoader.load_model （编排层）</text>
    <text x="20" y="44" font-size="11" fill="#7c2d12">1. initialize_model(...)　　← 在 meta-like 上下文造空结构</text>
    <text x="20" y="62" font-size="11" fill="#7c2d12">2. self.load_weights(model, ...)</text>
    <text x="40" y="80" font-size="10" fill="#9a3412">├─ get_all_weights()　返回 (name, tensor) 流式 generator</text>
    <text x="40" y="96" font-size="10" fill="#9a3412">└─ model.load_weights(generator)　← 真正的 name remap</text>
    <text x="20" y="112" font-size="11" fill="#7c2d12">3. process_weights_after_loading()　← 量化 kernel 整形</text>
  </g>
  <line x1="380" y1="166" x2="380" y2="190" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t3ar)"/>
  <text x="396" y="182" font-size="10" fill="#64748b">yield 流</text>
  <g transform="translate(40, 196)">
    <rect x="0" y="0" width="680" height="92" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="20" y="22" font-size="13" font-weight="700" fill="#115e59">② safetensors_weights_iterator （流式读取层）</text>
    <text x="20" y="42" font-size="11" font-family="monospace" fill="#134e4a">for file in files:</text>
    <text x="20" y="58" font-size="11" font-family="monospace" fill="#134e4a">　with safe_open(file, framework="pt") as f:</text>
    <text x="20" y="74" font-size="11" font-family="monospace" fill="#134e4a">　　for name in f.keys():  yield name, f.get_tensor(name)</text>
    <text x="540" y="86" text-anchor="end" font-size="10" fill="#0f766e">← mmap 不全读，host RAM 仅持当前 tensor</text>
  </g>
  <line x1="380" y1="292" x2="380" y2="316" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t3ar)"/>
  <text x="396" y="308" font-size="10" fill="#64748b">逐个消费</text>
  <g transform="translate(40, 322)">
    <rect x="0" y="0" width="680" height="148" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="20" y="22" font-size="13" font-weight="700" fill="#5b21b6">③ LlamaForCausalLM.load_weights （remap + 写入层）</text>
    <text x="20" y="42" font-size="10" font-family="monospace" fill="#4c1d95">stacked_params_mapping = [</text>
    <text x="20" y="56" font-size="10" font-family="monospace" fill="#4c1d95">　(".qkv_proj", ".q_proj", "q"),　(".qkv_proj", ".k_proj", "k"),　(".qkv_proj", ".v_proj", "v"),</text>
    <text x="20" y="70" font-size="10" font-family="monospace" fill="#4c1d95">　(".gate_up_proj", ".gate_proj", 0),　(".gate_up_proj", ".up_proj", 1),  ]</text>
    <text x="20" y="92" font-size="10" font-family="monospace" fill="#4c1d95">for hf_name, hf_tensor in weights:</text>
    <text x="20" y="106" font-size="10" font-family="monospace" fill="#4c1d95">　for (vllm_name, hf_sub, shard_id) in mapping:</text>
    <text x="20" y="120" font-size="10" font-family="monospace" fill="#4c1d95">　　if hf_sub in hf_name:</text>
    <text x="20" y="134" font-size="10" font-family="monospace" fill="#4c1d95">　　　params[remap(hf_name)].weight_loader(param, hf_tensor, shard_id)　← 写到 qkv_proj 的对应分片</text>
  </g>
</svg>
<span class="figure-caption">图 T3.1 ｜ 权重加载三层结构：① loader 编排生命周期，② safetensors iterator 流式 mmap 出 (name, tensor)，③ 模型自己声明 stacked_params_mapping 告诉框架"我能吃哪些 HF 名字、各写到合并 tensor 的哪一片"</span>

<details>
<summary>ASCII 原版</summary>

```
┌───────────────────────────────────────────────────────────┐
│ DefaultModelLoader.load_model                             │
│   1. initialize_model(...)  ← 在 meta-like 上下文造结构  │
│   2. self.load_weights(model, ...)                        │
│        ├─ get_all_weights() 返回一个 (name, tensor)       │
│        │   流式 generator                                 │
│        └─ model.load_weights(generator)  ← 真正的 remap  │
│   3. process_weights_after_loading()  ← 量化 kernel 整形 │
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ safetensors_weights_iterator  (weight_utils.py:893)       │
│   for file in files:                                      │
│     with safe_open(file, framework="pt") as f:            │
│       for name in f.keys():                               │
│         yield name, f.get_tensor(name)  ← mmap, 不全读   │
└───────────────────────────────────────────────────────────┘
                          │
                          ▼
┌───────────────────────────────────────────────────────────┐
│ LlamaForCausalLM.load_weights  (llama.py:436)             │
│   stacked_params_mapping = [                              │
│     (".qkv_proj", ".q_proj", "q"),                        │
│     (".qkv_proj", ".k_proj", "k"),                        │
│     (".qkv_proj", ".v_proj", "v"),                        │
│     (".gate_up_proj", ".gate_proj", 0),                   │
│     (".gate_up_proj", ".up_proj", 1),                     │
│   ]                                                       │
│   for hf_name, hf_tensor in weights:                      │
│     for (vllm_name, hf_sub, shard_id) in mapping:         │
│       if hf_sub in hf_name:                               │
│         vllm_param = params[hf_name.replace(...)]         │
│         vllm_param.weight_loader(                         │
│             vllm_param, hf_tensor, shard_id)              │
│         ← 这里会写到 qkv_proj 的对应那一片                │
└───────────────────────────────────────────────────────────┘
```

</details>

关键是 `stacked_params_mapping`：每个 entry 三元组 `(目标合并参数名, HF 子参数名, shard_id)`。看到 HF 名字包含 `.q_proj`，就把它路由到 `.qkv_proj`，并告诉 `weight_loader` "这块要写到 q 那一片"。

`shard_id` 最终是被 `QKVParallelLinear.weight_loader`（`vllm/model_executor/layers/linear.py:1188`）消费——它知道 q/k/v 各自的 offset 和 size，做切片再 copy。

### 5.2 流式加载，省 RAM 也省 latency

`safetensors_weights_iterator`（`vllm/model_executor/model_loader/weight_utils.py:893`）是个 generator：

- 外层按 `_natural_sort_key` 排序遍历 `.safetensors` 文件
- 每个文件用 `safe_open(...)` 走 mmap，**不实读**
- `f.get_tensor(name)` 才真的从 mmap 区域读出该 tensor 的字节
- yield 给上层，上层立即用 `weight_loader` 写到 GPU，写完这一片就被 GC

这样一个 70B 模型只要持续占用"当前那一个 tensor"的 host RAM（最大几 GiB），不是整个 130 GiB。

加载策略（`safetensors_load_strategy`）有几档：

- `lazy`（默认）：上面的 mmap 流式
- `eager`：每个文件一次性读到 bytes 再 `safetensors.load(bytes)`——本地 SSD 上比 mmap 略快
- `prefetch`：网络盘（NFS/Lustre）情况下，开后台线程把文件 read-ahead 进 page cache，主线程到那个文件时直接命中（见 `weight_utils.py:801-893`）

策略 `None` 时自动检测：网络盘 + 装得下 RAM → 自动 `prefetch`；本地盘 → `lazy`。

### 5.3 量化 / 特殊参数 remap

`maybe_remap_kv_scale_name`（`vllm/model_executor/model_loader/weight_utils.py:1526-1610`）处理几种 KV-scale 命名差异：

- 旧合并形式 `*.kv_scale` → 拆成 `*.attn.k_scale`（同值复制给 `v_scale`），并 deprecate warning
- ModelOpt 格式 `self_attn.q_proj.k_scale` → vllm 内部 `self_attn.attn.k_scale`
- compressed-tensors / FP8 各家格式各有 pattern，按优先级匹配

这一步发生在 `llama.py:454-465`：在 `stacked_params_mapping` 之前 hook 一下，先处理 scale 类参数，再走普通 qkv 合并逻辑。

### 5.4 父类 vs 子类、AutoWeightsLoader

`llama.py:584` 里 `LlamaForCausalLM.load_weights` 自己只调用 `AutoWeightsLoader(self).load_weights(weights)`，把活转给通用 helper。`AutoWeightsLoader`（`vllm/model_executor/models/utils.py:117-356`）按 module 树递归 dispatch：

- 走到一个子 module，如果它定义了自己的 `load_weights`，就把属于它前缀的所有权重交给它
- 否则回退到默认行为：按 `Parameter.weight_loader` 加载单个参数

这样实现"模型主体复用 LlamaModel.load_weights，特殊模块自己接管"的分层。

### 5.5 `process_weights_after_loading`

`vllm/model_executor/model_loader/base_loader.py:80` 在所有权重到 GPU 之后会再调一次 `process_weights_after_loading(model, model_config, target_device)`。意义是：**量化后处理**——例如 FP8 模型 checkpoint 里存的是 BF16 权重 + per-tensor scale，这一步会把 BF16 转成 FP8（per-tensor 或 per-channel 量化），并整形成 Marlin/CUTLASS kernel 期望的 packed 布局。在线量化（`uses_meta_device=True` 的 quant method）也是在这一步真正生成 GPU 上的 packed weight。

### 5.6 严格性检查

`DefaultModelLoader.track_weights_loading`（`vllm/model_executor/model_loader/default_loader.py:414-437`）会把 `model.named_parameters()` 的全集减去 `loaded_weights`，如果非空就抛：

```
ValueError: Following weights were not initialized from checkpoint: {...}
```

这是 vllm 加载阶段最常见的报错：HF checkpoint 缺了某个权重、或者 model class 实现的 `load_weights` 漏了 mapping。仅当模型是非量化、且 model 类的 `load_weights` 返回了 `loaded_params` 集合时才启用。

## 6. 代码位置

- worker 入口：`vllm/v1/worker/gpu_worker.py::load_model:338-345`
- model runner 入口：`vllm/v1/worker/gpu_model_runner.py::load_model:4971-5000`
- 选 loader：`vllm/model_executor/model_loader/__init__.py::get_model_loader`
- loader 基类生命周期：`vllm/model_executor/model_loader/base_loader.py::BaseModelLoader.load_model:42-82`
- safetensors 默认 loader：`vllm/model_executor/model_loader/default_loader.py::DefaultModelLoader:43-437`
  - 流式 iterator：`vllm/model_executor/model_loader/weight_utils.py::safetensors_weights_iterator:893`
- model 类的 load_weights（Llama 系列）：`vllm/model_executor/models/llama.py::LlamaModel.load_weights:436-498`
- packed_modules_mapping 声明：`vllm/model_executor/models/llama.py:504-507`（给 LoRA 知道哪些参数其实是 stacked 的）
- 递归 dispatcher：`vllm/model_executor/models/utils.py::AutoWeightsLoader:117-356`
- 合并参数实际写入：`vllm/model_executor/layers/linear.py::QKVParallelLinear.weight_loader:1188`、`::MergedColumnParallelLinear.weight_loader:695`
- 普通单参数 loader：`vllm/model_executor/model_loader/weight_utils.py::default_weight_loader:1383`
- KV scale 命名 remap：`vllm/model_executor/model_loader/weight_utils.py::maybe_remap_kv_scale_name:1526`
- Parameter 基类：`vllm/model_executor/parameter.py::BasevLLMParameter:31-127`
- 量化后处理：`vllm/model_executor/model_loader/utils.py::process_weights_after_loading:99`

**阅读顺序**：先看 `BaseModelLoader.load_model` 把整条骨架建立起来——`initialize_model` → `load_weights` → `process_weights_after_loading`。然后看 `LlamaModel.load_weights` 的 50 行循环理解 `stacked_params_mapping` 是怎么做名字 remap 的。最后看 `QKVParallelLinear.weight_loader` 看"写一片"的物理细节。`AutoWeightsLoader` 和 `safetensors_weights_iterator` 第一遍可以扫一眼就过。

## 7. 分支与延伸

- **vllm 完整的模型加载流程**（loader 种类、生命周期）→ [第 8 章 §6 模型加载](08-model-definition-and-loading.md#6-模型加载)
- **LLaMA 家族模型类的解读**（为什么 `LlamaModel` 和 `LlamaForCausalLM` 拆开、`packed_modules_mapping` 的具体作用）→ [第 8 章 §3 Llama 解读](08-model-definition-and-loading.md#3-llama-解读)
- **`QKVParallelLinear` / `MergedColumnParallelLinear` 的设计与并行切分**→ [第 8 章 §4 公共 layer 库](08-model-definition-and-loading.md#4-公共-layer-库)
- **量化（FP8 / AWQ / GPTQ / Marlin / compressed-tensors）的加载分支** + `process_weights_after_loading` 在每种量化里干什么 → [第 11 章 §2 量化](11-advanced-features.md#2-量化)
- **不同 model loader**（DefaultModelLoader / TensorizerLoader / BitsAndBytesLoader / RunaiStreamerLoader / ShardedStateLoader / DummyLoader / GGUFLoader）的取舍 → [第 8 章 §6 模型加载](08-model-definition-and-loading.md#6-模型加载)
- **LoRA adapter 的加载** 走的是另一条路径（`load_lora_model`）；`packed_modules_mapping` 在 LoRA 里被反向用来推导 q/k/v 各自的 adapter → [第 11 章 §5 LoRA](11-advanced-features.md#5-lora)
- **TP（tensor parallel）下的权重切分**：`QKVParallelLinear` 的 `weight_loader` 会按 `tp_rank` 只 copy 自己那片 head 范围；rank 间不传整张权重 → [第 10 章 §2 TP 通信与权重切分](10-distributed-and-parallel.md#2-tp-通信与权重切分)
- **PP（pipeline parallel）下的 `is_pp_missing_parameter`**（`llama.py:479`）：当前 rank 没这一层时，对应权重直接 skip → [第 10 章 §4 PP](10-distributed-and-parallel.md#4-pp)
- **多模态模型（vision tower / audio encoder）的二级加载** + secondary weight loading 的 revision 传递（参考最近提交 `d1586e1a1`） → [第 11 章 §6 多模态](11-advanced-features.md#6-多模态)
- **dummy weight 加载**（`load_dummy_weights=True`）：profile 不需要真权重时用全零或随机权重，省下载时间 → [第 6 章 §3 GPUWorker 生命周期](06-worker-and-model-runner.md#3-gpuworker-生命周期)
- **加载完后能不能 reload？** `reload_weights` API 用于 RLHF / online weight update → [第 8 章 §6 模型加载](08-model-definition-and-loading.md#6-模型加载)
- **术语**：state_dict、parameter、buffer、persistent buffer 在 vllm 加载链路里的区别 → [第 12 章 术语表](12-glossary-and-faq.md#参数与权重相关)

## 8. 走完这一步你脑子里应该多了什么

1. HF checkpoint 和 vllm 内部 Parameter **不是一一对应**：vllm 把 q/k/v 合并、gate/up 合并，是为 GEMM 性能；代价是必须有 `stacked_params_mapping` 这种"我能吃哪些 HF 名字 + 各写到合并 tensor 的哪一片"的声明
2. 加载是**流式的**：mmap 读 safetensors → yield (name, tensor) → 立即 `weight_loader` 写 GPU → host 端 tensor 被释放。这是为什么 70B 模型能在 100 G 内存的机器上加载
3. 量化模型在 `load_weights` 之后还有 `process_weights_after_loading` 这一步，把 BF16 权重转成 FP8/INT4 + scale 的 packed 布局；在线量化也在这一步真正分配 packed 权重
4. 整个 trace 里"模型权重"是**静态的**：本步结束之后没有任何步骤会再改它（除非显式 reload）。后续 trace 你看到 `self.model(...)` 就当成"权重已经在 GPU 上"——profile_run、capture_model、prefill、decode 看到的都是同一份
5. 时序排列：**load_model → profile_run（步骤 01）→ initialize_kv_cache（步骤 01 末尾）→ capture_model（步骤 02）→ `LLM(...)` 返回**——本步在第 3 个讲只是"在主线推理意义上最不重要"，在物理时间轴上它是最早完成的事
