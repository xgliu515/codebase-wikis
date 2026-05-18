# Trace 步骤 08 —— AttentionMetadata 是什么？为什么每个 backend 一份？

> 单请求 trace 第 8 步。上一步：`input_ids` / `positions` / `cu_seqlens` / `slot_mapping` / `block_table_tensor` 都已在 GPU 上，packed varlen 形状准备就绪。
> 本步主题：在调 `model.forward(...)` 之前，先构造一个 attention 专用的 metadata 对象；同时决定本次 forward 走哪种 CUDA graph 模式。

## 1. 当前情境

我们在 `GPUModelRunner.execute_model()`（`vllm/v1/worker/gpu_model_runner.py:3913`）的中段：第 7 步的 `_prepare_inputs()` 刚返回 `logits_indices = [3]`、`spec_decode_metadata = None`。手里的状态：

- GPU 持久 buffer：`self.input_ids[:4]`、`self.positions[:4]`、`self.query_start_loc.gpu[:2] = [0, 4]`、`self.seq_lens[:1] = [4]`、`self.num_computed_tokens[:1] = [0]`
- 持久 `self.input_batch.block_table[0].get_device_tensor(1)`，第 0 行 `[17, 0, 0, ...]`
- 还没有：每个 attention 后端真正吃的 metadata 对象（包含 cascade attention 配置、AOT FA3 scheduler metadata、各种 mask / window 信息……）
- 还没决定：本次 forward 是 replay 一张 captured CUDA graph、跑 piecewise 多张小 graph、还是 eager？

`execute_model` 接下来的三件事按顺序：

1. `_determine_batch_execution_and_padding()`（`gpu_model_runner.py:4018`）——CudagraphDispatcher 决定 mode + padding
2. `_get_slot_mappings()`（`gpu_model_runner.py:4097`）——按是否要 pad attn 把 slot_mapping 拉到正确形状
3. `_build_attention_metadata()`（`gpu_model_runner.py:4108`）——给每个 KV cache group、每个 attention group 构造后端专属 metadata

然后才是 `set_forward_context(attn_metadata, ..., cudagraph_runtime_mode=mode, batch_descriptor=batch_desc, ...)`（`gpu_model_runner.py:4156`）并真正调 `_model_forward(...)`。

## 2. 问题

为什么不能把第 7 步那几个 tensor 直接传给 attention？因为不同 attention 后端需要的"额外信息"长得不一样：

- **FlashAttention 3**：需要 AOT scheduler metadata（一个 `1 + round_up(batch_size, 4) * 4` 大小的 int32 buffer，是 FA3 host 端预先算好的"每个 tile 的工作分配"，见 `vllm/v1/attention/backends/flash_attn.py:354-368`）；需要 `max_num_splits` 上界（CUDA graph 下必须固定，`flash_attn.py:431-440`）；需要 sliding window 配置
- **FlashInfer**：需要它自己的 `BatchPrefillWithPagedKVCacheWrapper` 状态，结构跟 FA 完全不一样
- **MLA（DeepSeek）**：prefill 和 decode 走两个不同 kernel，metadata 也分两份
- **Cascade attention**：要切公共前缀，多一组 `cu_prefix_query_lens` / `prefix_kv_lens` / `suffix_kv_lens`（`flash_attn.py:240-245`）
- **DCP（decode context parallel）**：要 `dcp_context_kv_lens`（`flash_attn.py:247-249`）

如果让 ModelRunner 直接构造一个"通吃所有后端"的大 metadata，它就要塞下所有后端的所有字段，并且每次新加 backend / 新加特性都得改 runner——耦合炸了。

第二个独立但相关的问题：**本次 forward 走什么执行模式？**

vllm 在 LLM 启动时会对一组 batch-size bucket 做 CUDA graph capture（步骤 02 主题）。运行时第 N 次 forward 来了，要回答两件事：

- 本 batch（`num_tokens`、`num_reqs`、是否 uniform decode、是否 has_lora）能不能对上某张已 capture 的 graph？
- 如果能，是 PIECEWISE graph（多张小图拼起来，attention 在图外）还是 FULL graph（一整张大图，attention 也在图内）？
- 如果都不能，就 fallback 到 eager。

这件事不能靠"试着 replay 一下，看哪张匹配"——CUDA graph 错配会直接段错误。必须**显式查表 + 显式 pad** 到一个已 capture 的尺寸。

## 3. 朴素思路

**问题 1（metadata）的朴素做法**：在 `GPUModelRunner` 里写一个大函数，按 if-elif 分支判断当前后端是 FA2/FA3/FlashInfer/MLA/Triton/...，每个分支造一套字段。

**问题 2（cudagraph 选择）的朴素做法**：跑 forward 之前 if-else——"如果 batch_size <= 8 用 graph A，否则用 graph B，否则 eager"。Pad 时直接 `F.pad(input_ids, ...)`。

## 4. 为什么朴素思路会崩

**metadata 那一摊**：

- 后端十几个（看 `vllm/v1/attention/backends/` 目录：`flash_attn.py` / `flashinfer.py` / `triton_attn.py` / `flex_attention.py` / `mla/` 下一堆 / `mamba2_attn.py` / `gdn_attn.py` / `rocm_*` / `cpu_attn.py` / `flash_attn_diffkv.py` / `turboquant_attn.py` …），每个还可能有 prefill/decode 两条路径——大函数会膨胀到无法维护
- 后端有自己的私有依赖（FA3 的 AOT scheduler 来自 `flash_attn` 包，FlashInfer 来自 `flashinfer` 包），让 runner 直接 import 会让 runner 强依赖一堆可选包
- 不同 KV cache group（hybrid 模型：full-attention layer + sliding-window layer 用不同 spec）需要不同 block_table——大函数得在内层循环里再分叉

**cudagraph 那一摊**：

- "padding 后是否还能匹配 captured graph" 跟"现在的 attention 后端到底支持 ALWAYS / UNIFORM_BATCH / UNIFORM_SINGLE_TOKEN_DECODE / NEVER 哪一档 cudagraph"是两件事，要一起判断（`vllm/v1/attention/backend.py:499-513` 的 `AttentionCGSupport` 四档常量）
- LoRA 开关、cascade attention 开关、encoder-decoder、DP 同步……每一个都改变"哪些 graph 可用"。临时 if-else 会指数爆炸
- `F.pad(input_ids, ...)` 会让 slot_mapping、block_table、attention metadata 全部失配——pad 必须**整组一致**

## 5. vllm 的做法

### 5.1 两层 metadata 抽象

vllm 用**两层 dataclass**解耦：

- `CommonAttentionMetadata`（`vllm/v1/attention/backend.py:352-493`）：runner 一次性构造，**所有后端共享**的字段。包括：`query_start_loc` / `seq_lens` / `block_table_tensor` / `slot_mapping` / `num_reqs` / `num_actual_tokens` / `max_query_len` / `max_seq_len` / `causal` / `positions` / `is_prefilling` / `encoder_seq_lens` / `dcp_local_seq_lens`……
- **后端专属 metadata**（如 `FlashAttentionMetadata`, `vllm/v1/attention/backends/flash_attn.py:222-256`；MLA 系列在 `vllm/v1/attention/backends/mla/`；`triton_attn.py`、`flashinfer.py`、`flex_attention.py` 各自一份）：每个后端定义自己需要的字段（如 FA3 的 `scheduler_metadata` / `max_num_splits` / cascade 的 `cu_prefix_query_lens`）

转换由后端各自的 `AttentionMetadataBuilder`（`vllm/v1/attention/backend.py:516`）负责：核心方法 `build(common_prefix_len, common_attn_metadata, fast_build=False) -> M` 和 capture 专用的 `build_for_cudagraph_capture(common_attn_metadata) -> M`；同时类属性 `_cudagraph_support`（`AttentionCGSupport`）声明本后端能支撑到哪一档 cudagraph、`supports_update_block_table` 控制能否复用已 build 的 metadata 仅改 block table（见 5.1 末的优化）。

ModelRunner 只跟 `CommonAttentionMetadata` 打交道，**不知道**也**不需要知道**具体后端字段。这是经典的"通用 part + 后端 part"分层。

Runner 端是这样喂的（`gpu_model_runner.py:2244-2260`）：

```python
cm_base = CommonAttentionMetadata(
    query_start_loc=self.query_start_loc.gpu[: num_reqs_padded + 1],
    query_start_loc_cpu=self.query_start_loc.cpu[: num_reqs_padded + 1],
    seq_lens=self.seq_lens[:num_reqs_padded],
    num_reqs=num_reqs_padded,
    num_actual_tokens=num_tokens_padded,
    max_query_len=max_query_len,
    max_seq_len=max_seq_len,
    block_table_tensor=block_table_gid_0,
    slot_mapping=slot_mapping_gid_0,
    causal=True,
    is_prefilling=is_prefilling,
    positions=self.positions[:num_tokens_padded],
)
```

然后对每个 (KV cache group, attention group) 调一次 `builder.build(common_attn_metadata=cm, ...)`（`gpu_model_runner.py:2337-2341`），builder 返回后端特化 metadata，最终塞进 `attn_metadata: dict[layer_name, AttentionMetadata]`（`gpu_model_runner.py:2352-2353`）。

为什么要按 layer_name 索引？因为 hybrid 模型（如某些 SWA + Full 混合层）不同层可能用不同后端 / 不同 block table。runner 把"哪层用哪份 metadata"算清楚后，attention forward 时每层各取各的。

**优化：cache key + `update_block_table`**（`gpu_model_runner.py:2288-2335`）。同一份 (kv_cache_spec, builder type) 的 metadata 只算一次，后续同类型层只复用——builder 支持 `update_block_table` 的话连 build 都省了。

### 5.2 一句话：CudagraphDispatcher

`CudagraphDispatcher`（`vllm/v1/cudagraph_dispatcher.py:15`）维护两组 captured key：

```python
self.cudagraph_keys: dict[CUDAGraphMode, set[BatchDescriptor]] = {
    CUDAGraphMode.PIECEWISE: set(),
    CUDAGraphMode.FULL: set(),
}
```

`BatchDescriptor`（`vllm/forward_context.py:29-58`）的字段就是 dispatch 的 key：`num_tokens` / `num_reqs` / `uniform` / `has_lora` / `num_active_loras`。CUDA graph capture 阶段（步骤 02）就按这些 key 一张张存下来。

`dispatch(num_tokens, uniform_decode, has_lora, num_active_loras, ...)`（`cudagraph_dispatcher.py:239-328`）的逻辑：

1. 把 `num_tokens` pad 到最近的 captured bucket（`_bs_to_padded_graph_size`，`cudagraph_dispatcher.py:76-95`）
2. 构造一个 `BatchDescriptor`
3. **优先 FULL**：完整 batch_desc 在 FULL set 里就用 FULL（`cudagraph_dispatcher.py:311-315`）
4. **次选 PIECEWISE**：把 `num_reqs=None, uniform=False` 放宽后查 PIECEWISE set（`cudagraph_dispatcher.py:317-322`）
5. 都没有：返回 `CUDAGraphMode.NONE`（eager）

返回的是 `(CUDAGraphMode, BatchDescriptor)`。`batch_desc.num_tokens` 就是 runner 接下来要把 batch pad 到的目标尺寸。

三种 mode 的本质区别（详见第 6 章 §10.1）：

- **NONE**：纯 eager，CPU 一条条 launch CUDA op
- **PIECEWISE**：模型 forward 被 `torch.compile` 切成多段；每段（除了 attention）capture 成一张小 graph；attention 仍然 eager。Attention 后端只要不限制 batch shape 都能用
- **FULL**：包含 attention 在内 capture 成一张大 graph。要求后端 `AttentionCGSupport >= UNIFORM_BATCH`（FA3 是 `ALWAYS`，FA2 是 `UNIFORM_BATCH`，TritonAttn / FlashInfer 取决于版本）

### 5.3 怎么决定走哪条 + 本步具体执行

`_determine_batch_execution_and_padding()`（`gpu_model_runner.py:3679-3791`）是组合逻辑入口，做四件事：先调 `_is_uniform_decode()`（`gpu_model_runner.py:3659`）判断是不是"每个 req 都只算 `uniform_decode_query_len` 个 token"；算 `has_lora`、`num_active_loras`；调 `_pad_for_sequence_parallelism(num_tokens)` 做 SP 对齐；最后调 `cudagraph_dispatcher.dispatch(...)`（`gpu_model_runner.py:3724`），用 `invalid_modes={FULL}` 把 cascade attention / encoder-decoder 这类 FULL 不支持的 case 强制掉到 PIECEWISE/NONE。DP 下还会做一次跨 rank `coordinate_batch_across_dp` 同步后 re-dispatch（`gpu_model_runner.py:3751-3774`）。返回 `(cudagraph_mode, batch_descriptor, should_ubatch, num_tokens_across_dp, stats)`。

本步实际值（4-token 单 prefill）：`uniform_decode_query_len=1`，`_is_uniform_decode` 返回 False（`max=4 ≠ 1`）。`dispatch(num_tokens=4, uniform_decode=False, has_lora=False)` 把 4 pad 到最近 capture bucket（比如 8），先查 FULL key，未命中后用 `replace(num_reqs=None, uniform=False)` 查 PIECEWISE。`compilation_config.cudagraph_mode` 默认 `FULL_AND_PIECEWISE` 下混合模式会注册 PIECEWISE key，命中后返回 `(PIECEWISE, BatchDescriptor(num_tokens=8, ...))`。真正第一个 prefill step 也可能因 KV scale 首次计算（`gpu_model_runner.py:4138-4141`）等原因强制 NONE，第二步 decode 才是 captured graph 命中的好例子（步骤 14、15）。

接着 `_build_attention_metadata()` 调 `FlashAttentionMetadataBuilder.build(common_attn_metadata=cm)`（`flash_attn.py:388`），返回 `FlashAttentionMetadata(num_actual_tokens=4, max_query_len=4, query_start_loc=[0,4], max_seq_len=4, seq_lens=[4], block_table=[[17,...]], slot_mapping=[272,273,274,275], use_cascade=False, scheduler_metadata=..., causal=True)`。本模型只有一种 attention 类型，所有 32 层 `Qwen2Attention` 共享同一份 metadata：`attn_metadata = {"model.layers.0.self_attn": fa_md, ..., "model.layers.27.self_attn": fa_md}`。

最后 `set_forward_context(attn_metadata, ..., cudagraph_runtime_mode=mode, batch_descriptor=batch_desc, ...)`（`gpu_model_runner.py:4155-4166`）把 metadata 与 cudagraph 决策塞进线程局部 context——下游 `Attention` 层从这里取；`CudagraphWrapper` / piecewise wrapper / eager pass-through 也读 `cudagraph_runtime_mode` 决定 capture / replay / passthrough。

## 6. 代码位置

抽象层：

- `vllm/v1/attention/backend.py:345` —— `AttentionMetadata`（空 marker 基类）
- `vllm/v1/attention/backend.py:352-493` —— `CommonAttentionMetadata` 全部字段
- `vllm/v1/attention/backend.py:499-513` —— `AttentionCGSupport` 四档常量
- `vllm/v1/attention/backend.py:516-560` —— `AttentionMetadataBuilder` 基类接口

后端子类（代表）：

- `vllm/v1/attention/backends/flash_attn.py:222-256` —— `FlashAttentionMetadata`
- `vllm/v1/attention/backends/flash_attn.py:276-300` —— `FlashAttentionMetadataBuilder` 头部 + `_cudagraph_support`
- `vllm/v1/attention/backends/flash_attn.py:388-469` —— `Builder.build()` 主体
- `vllm/v1/attention/backends/flashinfer.py` / `triton_attn.py` / `flex_attention.py` / `mla/` —— 其它后端
- `vllm/v1/attention/selector.py:52-136` —— `get_attn_backend()` 后端选择

ModelRunner 端：

- `vllm/v1/worker/gpu_model_runner.py:808` —— `CudagraphDispatcher` 构造点
- `vllm/v1/worker/gpu_model_runner.py:3659-3677` —— `_is_uniform_decode()`
- `vllm/v1/worker/gpu_model_runner.py:3679-3791` —— `_determine_batch_execution_and_padding()`
- `vllm/v1/worker/gpu_model_runner.py:2150-2400` —— `_build_attention_metadata()`（含 `_build_attn_group_metadata` 内嵌函数 `:2292-2353`，cache_key 复用与 `update_block_table` 优化）
- `vllm/v1/worker/gpu_model_runner.py:2244-2260` —— `cm_base = CommonAttentionMetadata(...)`
- `vllm/v1/worker/gpu_model_runner.py:4108-4172` —— `execute_model` 调 build + `set_forward_context`

CUDA graph 调度：

- `vllm/v1/cudagraph_dispatcher.py:15-73` —— `CudagraphDispatcher.__init__`
- `vllm/v1/cudagraph_dispatcher.py:76-114` —— `_compute_bs_to_padded_graph_size` 桶映射
- `vllm/v1/cudagraph_dispatcher.py:170-237` —— `initialize_cudagraph_keys`，capture 阶段注册所有合法 key
- `vllm/v1/cudagraph_dispatcher.py:239-328` —— **`dispatch()` 主函数**，运行时决定 mode + 返回 padded batch_desc
- `vllm/forward_context.py:29-58` —— `BatchDescriptor`（dispatch 的 key 结构）

**推荐阅读顺序**：先看 `CommonAttentionMetadata`（认全字段） → 再看 `FlashAttentionMetadata` + `FlashAttentionMetadataBuilder.build`（看一个后端怎么把通用 → 特化） → 看 `_build_attention_metadata` 主框架（理解多 KV group + cache_key 复用） → 看 `CudagraphDispatcher.dispatch` → 最后看 `_determine_batch_execution_and_padding` 怎么把这些串起来。

## 7. 分支与延伸

- **CommonAttentionMetadata 每个字段干嘛？** → 第 7 章 §3.1 [`CommonAttentionMetadata`：模型 runner 一份，全后端共享](07-attention-backends.md#731-commonattentionmetadata模型-runner-一份全后端共享)、§3.2 [各后端的特化](07-attention-backends.md#732-各后端的特化)
- **Builder 接口契约？** → 第 7 章 §3.3 [Builder 基类](07-attention-backends.md#733-builder-基类)
- **FA3 的 AOT scheduler、cascade、DCP 详细？** → 第 7 章 §4.1 [后端类](07-attention-backends.md#741-后端类)、§4.2 [Builder 与 AOT scheduler](07-attention-backends.md#742-builder-与-aot-scheduler)、§4.5 [DCP（decode context parallel）](07-attention-backends.md#745-dcpdecode-context-parallel)
- **后端选择是怎么发生的？** → 第 7 章 §2 [后端选择逻辑](07-attention-backends.md#72-后端选择逻辑)；本步前提：LLM 启动时已经选好了
- **三种 CUDAGraphMode 各自含义、PIECEWISE 是怎么切的？** → 第 6 章 §10.1 [三种 mode](06-worker-and-model-runner.md#6101-三种-mode)、§10.5 [Piecewise 编译](06-worker-and-model-runner.md#6105-piecewise-编译)
- **CudagraphDispatcher 完整字段与 dispatch 决策表？** → 第 6 章 §10.2 [`CudagraphDispatcher`](06-worker-and-model-runner.md#6102-cudagraphdispatcher)
- **forward context 是怎么把 mode 传到 attention wrapper 的？** → 第 6 章 §10.3 [Forward context 把 mode 注入算子](06-worker-and-model-runner.md#6103-forward-context-把-mode-注入算子)、§10.4 [`capture_model` 实际捕获](06-worker-and-model-runner.md#6104-capture_model-实际捕获)
- **attention metadata 与 prefill/decode 统一表达？** → 第 6 章 §9 [attention metadata：prefill 与 decode 的统一表达](06-worker-and-model-runner.md#69-attention-metadata-prefill-与-decode-的统一表达)
- **整个 attention 调用流程？** → 第 7 章 §12 [一次 attention 调用的完整流程](07-attention-backends.md#712-一次-attention-调用的完整流程)
- **如果加 spec decode？** `uniform_decode_query_len = 1 + num_speculative_tokens`，`num_decode_draft_tokens` 影响 metadata；FULL graph 上界由 `max_num_seqs * uniform_decode_query_len` 决定 → `cudagraph_dispatcher.py:37-41, 213-217`；第 11 章 spec decode 小节
- **如果加 LoRA？** dispatch key 多 `has_lora` / `num_active_loras` 维度；`cudagraph_specialize_lora` 决定是否每个 LoRA 数量都各 capture 一张 graph → `cudagraph_dispatcher.py:115-134`、第 11 章
- **如果模型是 hybrid（full + SWA + mamba）？** 多个 KV cache group，每个 group 一份独立 block_table + slot_mapping；`_build_attention_metadata` 的 `for kv_cache_gid, kv_cache_group in enumerate(kv_cache_groups)` 循环（`gpu_model_runner.py:2358`）就是干这个；具体 mamba 后端见第 7 章 §10.1
- **DP 下 dispatch 会重做一次？** 因为要跟其它 rank 对齐 num_tokens，见 `gpu_model_runner.py:3751-3774` 的 `coordinate_batch_across_dp`，第 10 章

## 8. 走完这一步你脑子里应该多了什么

1. **两层 metadata 是解耦关键**：`CommonAttentionMetadata`（runner 出，所有后端共享）+ 后端专属 `XXXMetadata`（builder 出）。Runner 不知道也不需要知道后端字段；新增后端只加一个 `XXXMetadataBuilder` 子类。
2. **CudagraphDispatcher 是一张 "(BatchDescriptor) → captured graph" 的查找表**。运行时按 `(num_tokens_padded, num_reqs, uniform, has_lora, num_active_loras)` 查；查不到就降级 PIECEWISE，再不行就 NONE（eager）。capture 时（步骤 02）也是它定义"哪些 key 要 capture"。
3. **CUDAGraphMode 三档**：FULL = 整个 forward（含 attention）一张图；PIECEWISE = 多张小图 + attention eager；NONE = 全 eager。能不能用 FULL 取决于 attention 后端的 `AttentionCGSupport` 等级 + 是否触发 cascade / encoder 之类 "FULL 不支持" 的特性。
4. **`set_forward_context` 是 metadata 和 cudagraph 决策的 single source of truth**——下游 `Attention` 层与 wrapper 都从 forward context 取，runner 与各层 forward 之间没有显式参数。
5. 走出本步时手里有：`attn_metadata: dict[layer_name, FlashAttentionMetadata]`、`cudagraph_mode`、`batch_descriptor`、padded `num_tokens` / `num_reqs`，准备进 `_model_forward` 跑真正的 embedding + 32 层 LlamaDecoderLayer（下一步主题）。
