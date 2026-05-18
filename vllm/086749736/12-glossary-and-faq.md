# 第 12 章 术语表与 FAQ

本章为 vLLM 代码阅读和二次开发的速查手册。术语表按英文字母顺序排列；FAQ 直接给出代码定位；附录列出常用环境变量、benchmark 脚本与测试目录布局。本章引用的源代码以你本地 vllm 仓库根目录为基准（在网页版可通过顶栏"代码路径"按钮配置，用于 `vscode://` 跳转）。

---

## Part 1：术语表

### AsyncLLM
- 英文原名：`AsyncLLM`
- 中文译名：异步引擎客户端
- 定义：vLLM 在线服务面向 OpenAI 协议层的异步入口；通过 `AsyncGenerator` 协议向上层 streaming 服务出 token。`AsyncLLM` 持有一个 `EngineCoreClient`，把请求经 ZMQ/IPC 转发给跨进程的 `EngineCore` 真实执行体。
- 代码位置：`vllm/v1/engine/async_llm.py:70` 定义 `class AsyncLLM(EngineClient)`，`generate`/`encode` 方法用于发起请求；输出处理见 `OutputProcessor`（`vllm/v1/engine/output_processor.py`）。

### AttentionMetadata
- 英文原名：`AttentionMetadata` / `CommonAttentionMetadata`
- 中文译名：注意力元数据
- 定义：单个 forward step 中所有 batch 信息的容器，包含 `query_start_loc`、`seq_lens`、`block_table_tensor`、`slot_mapping`、`max_query_len`、`max_seq_len` 等。各 backend 通过 `AttentionMetadataBuilder` 从 `CommonAttentionMetadata` 构建自己的派生类。
- 代码位置：`vllm/v1/attention/backend.py:345` 定义基类，`vllm/v1/attention/backend.py:352` 定义 `CommonAttentionMetadata`，`vllm/v1/attention/backend.py:516` 定义 `AttentionMetadataBuilder`。

### Backend（attention backend）
- 英文原名：attention backend
- 中文译名：注意力后端
- 定义：实现 PagedAttention/MLA 等核函数的具体 kernel 提供方。所有可选后端在 `AttentionBackendEnum` 中枚举，包括 `FLASH_ATTN`、`FLASHINFER`、`TRITON_ATTN`、`TRITON_MLA`、`FLASHMLA`、`FLEX_ATTENTION`、`CUTLASS_MLA`、`ROCM_*`、`CPU_ATTN` 等。
- 代码位置：`vllm/v1/attention/backends/registry.py:34` 定义枚举；`vllm/v1/attention/backends/` 各 `*.py` 是具体实现；`vllm/v1/attention/selector.py:52` 为 `get_attn_backend()` 选择入口。

### Block（KV cache block）
- 英文原名：KV cache block / page
- 中文译名：KV 缓存块
- 定义：PagedAttention 的最小存储单元，一块固定容纳 `block_size`（默认 16）个 token 的 K/V 张量。block 由 `BlockPool` 管理，引用计数为 0 时归还；prefix 命中时块被复用。
- 代码位置：`vllm/v1/core/block_pool.py:130` 定义 `class BlockPool`，`vllm/config/cache.py` 中 `block_size` 字段。

### Block Table
- 英文原名：block table
- 中文译名：块表
- 定义：每个请求保存逻辑 token 位置到 KV cache 物理块号的映射张量。GPU 上以 `(max_num_reqs, max_num_blocks_per_req)` 的 `int32` 张量形式存在；同时维护一份 `slot_mapping`。
- 代码位置：`vllm/v1/worker/block_table.py:18` 定义 `class BlockTable`，字段 `block_table`、`slot_mapping`、`num_blocks_per_row`。

### Chunked Prefill
- 英文原名：chunked prefill
- 中文译名：分块预填
- 定义：把长 prompt 的 prefill 阶段切成多个 chunk，与其他请求的 decode 混合调度，避免长 prefill 占满 batch 造成 head-of-line blocking。配合 `max_num_batched_tokens` 设置 token 预算。
- 代码位置：`vllm/config/scheduler.py:84` 字段 `enable_chunked_prefill: bool = True`；调度逻辑在 `vllm/v1/core/sched/scheduler.py` 的 `schedule()`。

### Continuous Batching（迭代级调度）
- 英文原名：continuous batching / iteration-level scheduling
- 中文译名：连续批处理
- 定义：vLLM 的核心调度模型——每一个 forward step 都重新挑选要执行的请求集合，新到来的请求可在下一个 step 立即加入 batch，已完成的请求即刻退出。区别于静态 batching。
- 代码位置：`vllm/v1/core/sched/scheduler.py:64` `class Scheduler`，主循环位于 `vllm/v1/engine/core.py:91` 的 `EngineCore.step()`。

### CUDA Graph
- 英文原名：CUDA Graph
- 中文译名：CUDA 图
- 定义：把若干连续 kernel 启动序列录制成可重放的图，消除 launch overhead。vLLM 支持 `NONE`、`PIECEWISE`（按 FX 子图分段）、`FULL`（整 step 全图）、`FULL_DECODE_ONLY`、`FULL_AND_PIECEWISE` 五种模式。
- 代码位置：`vllm/config/compilation.py:53` 枚举 `CUDAGraphMode`；分发器位于 `vllm/v1/cudagraph_dispatcher.py`；近期新增的「可中断」实验性图见 `vllm/compilation/breakable_cudagraph.py`。

### Data Parallelism (DP)
- 英文原名：Data Parallelism
- 中文译名：数据并行
- 定义：把请求按 batch 维分到多个 engine 副本，每个副本完整持有模型权重。常用于 MoE 配合 EP，或单卡多副本提高吞吐。
- 代码位置：`vllm/config/parallel.py:117` 字段 `data_parallel_size`；DP 协调器 `vllm/v1/engine/coordinator.py`；DP 工具 `vllm/v1/worker/dp_utils.py`。

### Decode (decoding phase)
- 英文原名：decoding phase
- 中文译名：解码阶段
- 定义：prompt 处理完毕后，每个 step 只为每个请求送入 1 个 token（spec decode 时为 1+k 个），生成下一个 token 的过程。decode batch 的 query 长度通常很短，特别适合 CUDA Graph capture。
- 代码位置：见 `GPUModelRunner._dummy_run()`、`AttentionCGSupport` 枚举（`vllm/v1/attention/backend.py:499`）。

### Detokenizer
- 英文原名：Detokenizer
- 中文译名：反 tokenize 器
- 定义：把 token id 增量地拼回字符串、负责处理 special token、stop string、`include_stop_str_in_output` 等行为。vLLM 提供基于 Rust `tokenizers` 的 `FastIncrementalDetokenizer` 和基于 HF transformers 的 `SlowIncrementalDetokenizer` 两条路径。
- 代码位置：`vllm/v1/engine/detokenizer.py:30` 定义 `class IncrementalDetokenizer`，`:167` `FastIncrementalDetokenizer`，`:250` `SlowIncrementalDetokenizer`。

### EAGLE
- 英文原名：EAGLE / EAGLE3
- 中文译名：EAGLE 投机解码
- 定义：使用一个轻量级 draft 模型预测多步候选 token 的投机解码方案。vLLM 的 EAGLE proposer 接收 target 模型隐藏状态，输出 draft token，经 `RejectionSampler` 校验。
- 代码位置：`vllm/v1/spec_decode/eagle.py:10` `class EagleProposer`；隐藏状态提取见 `vllm/v1/spec_decode/extract_hidden_states.py`。

### EngineCore
- 英文原名：`EngineCore` / `EngineCoreProc`
- 中文译名：引擎核心
- 定义：vLLM V1 的同步执行体——拥有 scheduler、executor、structured output manager。`EngineCoreProc` 把它包装到独立进程，通过 ZMQ 与前端 `AsyncLLM` 通信；`DPEngineCoreProc` 是数据并行版本。
- 代码位置：`vllm/v1/engine/core.py:91` `class EngineCore`，`:829` `class EngineCoreProc`，`:1645` `class DPEngineCoreProc`。

### Expert Parallelism (EP)
- 英文原名：Expert Parallelism
- 中文译名：专家并行
- 定义：MoE 模型把不同 expert 分散到多张卡上的并行策略；常与 DP 联合（DP+EP），少与单纯 TP 混用。开启方式 `enable_expert_parallel=True`。
- 代码位置：`vllm/config/parallel.py:151`；FusedMoE 实现 `vllm/model_executor/layers/fused_moe/layer.py:73`。

### FlashAttention
- 英文原名：FlashAttention (FA2/FA3/FA4)
- 中文译名：FlashAttention
- 定义：tile-based、显存带宽友好的标准 GPU attention kernel；vLLM 通过 `vllm-flash-attn` 子模块绑定。`flash_attn_version` 可固定为 2/3/4。
- 代码位置：`vllm/v1/attention/backends/flash_attn.py`；版本控制见 `vllm/config/attention.py:20`。

### FlashInfer
- 英文原名：FlashInfer
- 中文译名：FlashInfer
- 定义：NVIDIA 提供的专用推理 kernel 库，覆盖 attention、采样、MoE、allreduce 等。vLLM 在 sampler、MoE、attention 等多处可切到 FlashInfer 实现。
- 代码位置：`vllm/v1/attention/backends/flashinfer.py`、`vllm/v1/attention/backends/mla/flashinfer_mla.py`；最低版本由 `vllm/v1/attention/backends/registry.py` 引用，CI 升级见近期 commit `086749736`（flashinfer v0.6.11.post2）。

### Guided Decoding / Structured Output
- 英文原名：Guided decoding / Structured output
- 中文译名：受限解码 / 结构化输出
- 定义：通过 grammar/JSON schema/regex 约束 sampler，确保模型输出可被解析为指定格式。vLLM 支持 `xgrammar`、`guidance`、`outlines`、`lm-format-enforcer` 多后端。
- 代码位置：`vllm/v1/structured_output/__init__.py:35` `class StructuredOutputManager`；后端实现 `backend_xgrammar.py`、`backend_outlines.py`、`backend_guidance.py`、`backend_lm_format_enforcer.py`。

### Hybrid KV Cache
- 英文原名：Hybrid KV cache
- 中文译名：混合 KV 缓存
- 定义：同一个模型同时存在多种 KV 形态（如 full attention + sliding window，或 attention + mamba 状态）时，KV cache manager 用多个 group 分别管理，并按需对齐 block 大小。
- 代码位置：`vllm/v1/kv_cache_interface.py:81` `KVCacheSpecKind`；`vllm/v1/core/kv_cache_coordinator.py`；`vllm/v1/core/kv_cache_utils.py:571` `resolve_kv_cache_block_sizes()`。

### KV Cache
- 英文原名：KV cache
- 中文译名：KV 缓存
- 定义：解码时复用 prompt 阶段产生的 K/V 张量，避免重复 attention。vLLM 把 KV cache 切成定长 page（block），由 `BlockPool` 全局管理；可通过 `kv_cache_dtype=fp8/fp8_e4m3/...` 进行量化。
- 代码位置：`vllm/v1/core/kv_cache_manager.py`、`vllm/v1/core/block_pool.py`、`vllm/v1/kv_cache_interface.py`。

### KV Connector
- 英文原名：KV connector
- 中文译名：KV 传输连接器
- 定义：负责把 KV cache 在不同 worker 或不同 vLLM 实例之间搬移的抽象层，用于 P/D（prefill/decode）解耦、CPU offload、远程 KV 共享。
- 代码位置：`vllm/distributed/kv_transfer/kv_connector/v1/base.py:171` `class KVConnectorBase_V1`；工厂 `vllm/distributed/kv_transfer/kv_connector/factory.py:27`。

### LMHead
- 英文原名：LM head / `ParallelLMHead`
- 中文译名：词表输出投影
- 定义：模型最后一层线性变换，把 hidden state 投影到词表维度。在 vLLM 中由 `ParallelLMHead`（继承 `VocabParallelEmbedding`）实现，支持 vocab parallelism。
- 代码位置：`vllm/model_executor/layers/vocab_parallel_embedding.py:503` `class ParallelLMHead`；logits 计算由 `vllm/model_executor/layers/logits_processor.py:19` `class LogitsProcessor` 完成（注意此处与 sampling 的 logits processor 同名但不同义）。

### LoRA
- 英文原名：LoRA
- 中文译名：LoRA 适配器
- 定义：用低秩更新表达 fine-tuning 增量的 PEFT 方法；vLLM 支持多 LoRA 热切换，通过 `LoRARequest` 在请求级指定 adapter。
- 代码位置：`vllm/lora/request.py:8` `class LoRARequest`；模型支持靠 `SupportsLoRA` 协议（`vllm/model_executor/models/interfaces.py:537`）；运行时混入 `vllm/v1/worker/lora_model_runner_mixin.py`。

### Mamba (in vllm context)
- 英文原名：Mamba / SSM
- 中文译名：Mamba 状态空间模型
- 定义：以 SSM 替代部分/全部 attention 的非二次复杂度架构。vLLM 中 Mamba 层用专门的 attention backend 处理状态，并占用独立的 cache group。
- 代码位置：`vllm/model_executor/layers/mamba/mamba_mixer2.py:234` `class MambaMixer2`；mamba 后端 `vllm/v1/attention/backends/mamba1_attn.py`、`mamba2_attn.py`、`gdn_attn.py`、`linear_attn.py`、`short_conv_attn.py`；枚举 `MambaAttentionBackendEnum`（`vllm/v1/attention/backends/registry.py:136`）。

### MTP (Multi-Token Prediction)
- 英文原名：Multi-Token Prediction
- 中文译名：多 token 预测
- 定义：DeepSeek-V3 等模型在训练时引入的额外 MTP 头，可在推理时作为投机解码的 draft 模型。vLLM 通过 `--speculative-config` 启用 MTP 头。
- 代码位置：`tests/v1/spec_decode/test_mtp.py` 提供测试入口；proposer 复用 `EagleProposer` / `DraftModelProposer` 的能力。

### Medusa
- 英文原名：Medusa
- 中文译名：Medusa 多头投机
- 定义：在 target 模型上挂多个独立预测头，并行猜测后续若干 token。
- 代码位置：`vllm/v1/spec_decode/medusa.py:18` `class MedusaProposer`。

### MoE (Mixture of Experts)
- 英文原名：Mixture of Experts
- 中文译名：专家混合模型
- 定义：用 router 选择 top-k expert 处理每个 token 的稀疏架构。vLLM 通过 `FusedMoE` 层实现，可与 EP/TP/DP 组合，并提供 FlashInfer / DeepGemm / Triton 多套 fused kernel。
- 代码位置：`vllm/model_executor/layers/fused_moe/layer.py:73` `class FusedMoE`；多种 backend 见 `vllm/model_executor/layers/fused_moe/` 目录。

### Model Runner
- 英文原名：Model Runner
- 中文译名：模型执行器
- 定义：每个 worker 进程的「模型层」入口；管理输入 batch 构建、attention metadata 构建、模型 forward、采样、KV 写回。GPU 实现是 `GPUModelRunner`。
- 代码位置：`vllm/v1/worker/gpu_model_runner.py:415` `class GPUModelRunner`；CPU 对应 `cpu_model_runner.py`；TPU/XPU 见 `tpu_input_batch.py` / `xpu_model_runner.py`。

### Multi-Head Latent Attention (MLA)
- 英文原名：Multi-Head Latent Attention
- 中文译名：多头潜空间注意力
- 定义：DeepSeek 系列将 K/V 压缩到低维 latent 空间，再用上投影展开，显著降低 KV cache 显存。vLLM 提供一整套独立 MLA backend。
- 代码位置：`vllm/model_executor/layers/mla.py`；MLA backends 在 `vllm/v1/attention/backends/mla/`（`flashmla.py`、`flashattn_mla.py`、`triton_mla.py`、`cutlass_mla.py`、`flashinfer_mla.py` 等）；MLA prefill 分发由 `MLAPrefillBackendEnum` 控制（`vllm/config/attention.py:43`）。

### Multimodal
- 英文原名：Multi-modal
- 中文译名：多模态
- 定义：图像/视频/音频等非文本输入。vLLM 通过 `MultiModalRegistry` 注册 processor，运行时把 placeholder token 展开成 encoder 嵌入并写入 encoder cache。
- 代码位置：`vllm/multimodal/registry.py:98` `class MultiModalRegistry`；`vllm/multimodal/inputs.py:302` `class MultiModalFeatureSpec`；encoder cache 管理 `vllm/v1/core/encoder_cache_manager.py:17`。

### Pipeline Parallelism (PP)
- 英文原名：Pipeline Parallelism
- 中文译名：流水线并行
- 定义：把模型按层切分到多张卡，用 micro-batch 流水线减小气泡。vLLM 通过 `IntermediateTensors` 跨 rank 传递中间激活。
- 代码位置：`vllm/config/parallel.py:111`；模型必须实现 `SupportsPP` 协议（`vllm/model_executor/models/interfaces.py:615`）。

### Pooling Model
- 英文原名：Pooling model
- 中文译名：池化模型 / 嵌入模型
- 定义：输出 embedding/classification/reward 标量而非 token 的模型；vLLM 用 `runner_type="pooling"` 标识，调度路径不经过 sampler。
- 代码位置：`vllm/model_executor/layers/pooler/abstract.py:16` `class Pooler`；V1 入口 `vllm/v1/pool/`；offline 接口 `vllm/entrypoints/llm.py` 中 `encode()`。

### Prefill (prefill phase)
- 英文原名：prefill phase
- 中文译名：预填阶段
- 定义：对 prompt 做一次性 attention，把全部 K/V 写入 cache，并产出第一个 output token 的过程。计算量与 prompt 长度成平方。
- 代码位置：`SchedulerOutput.num_scheduled_tokens` 中区分 prefill / decode（`vllm/v1/core/sched/output.py:181`）。

### Prefix Caching
- 英文原名：prefix caching
- 中文译名：前缀缓存
- 定义：把跨请求的相同前缀 KV block 通过 hash key 复用，加速 system prompt 共享、few-shot 等场景。默认开启。
- 代码位置：`vllm/config/cache.py:91` 字段 `enable_prefix_caching`；hash 函数 `vllm/v1/core/kv_cache_utils.py:541` `hash_block_tokens`；BlockPool 维护命中表（`vllm/v1/core/block_pool.py`）。

### PagedAttention
- 英文原名：PagedAttention
- 中文译名：分页注意力
- 定义：vLLM 的标志性算法——把 KV cache 切成 page，用 page table 寻址，实现近乎零碎片的显存利用。多数 attention backend 都对其有专门实现。
- 代码位置：算法定义贯穿 `vllm/v1/core/kv_cache_manager.py` 与各 backend 的 `forward()`；kernel 在 `csrc/attention/` 与各厂商提供的 paged attention kernel。

### Quantization
- 英文原名：Quantization
- 中文译名：量化
- 定义：把权重 / 激活 / KV cache 从 fp16/bf16 压到 fp8/int8/int4/fp4 等低精度。
- 代码位置：调度入口 `vllm/model_executor/layers/quantization/__init__.py:59`（`register_quantization_config`）；具体实现：
    - **GPTQ**：`auto_gptq.py`
    - **AWQ**：`awq.py`、`awq_marlin.py`、`awq_triton.py`
    - **FP8**：`fp8.py:100` `class Fp8Config`
    - **bitsandbytes**：`bitsandbytes.py`
    - **compressed-tensors / quark / mxfp4 / fbgemm_fp8 / modelopt / torchao**：同目录下各文件

### Ray Executor
- 英文原名：Ray Executor / `RayDistributedExecutor`
- 中文译名：Ray 执行器
- 定义：用 Ray 在多机多卡上拉起 worker 的 executor 后端，对应 `--distributed-executor-backend=ray`。`RayExecutorV2` 是新版基于 Ray Compiled DAG 的实现，由 `VLLM_USE_RAY_V2_EXECUTOR_BACKEND` 选择。
- 代码位置：`vllm/v1/executor/ray_executor.py`、`vllm/v1/executor/ray_executor_v2.py`；选择逻辑 `vllm/v1/executor/abstract.py:47`。

### Request (vllm internal)
- 英文原名：`Request`
- 中文译名：请求
- 定义：调度器视角的请求状态机：`prompt_token_ids`、`output_token_ids`、`num_computed_tokens`、`block_hashes`、`status` 等。完成 prefill 后状态从 `WAITING` 进入 `RUNNING`。
- 代码位置：`vllm/v1/request.py:59` `class Request`，状态枚举 `vllm/v1/request.py:316` `class RequestStatus`。

### RoPE
- 英文原名：Rotary Position Embedding
- 中文译名：旋转位置编码
- 定义：通过把 Q/K 视为复数后乘以旋转因子注入位置信息，支持 NTK/Yarn 等长度外推方案。
- 代码位置：`vllm/model_executor/layers/rotary_embedding/base.py:118` `class RotaryEmbedding`；变体如 `deepseek_scaling_rope.py`、`dual_chunk_rope.py`。

### Sampler
- 英文原名：Sampler
- 中文译名：采样器
- 定义：把 logits 转成下一个 token id 的模块；支持 greedy、top-k、top-p、min-p、temperature、penalty、logprobs 等。投机解码使用单独的 `RejectionSampler`。
- 代码位置：`vllm/v1/sample/sampler.py:21` `class Sampler`；`vllm/v1/sample/rejection_sampler.py:37` `class RejectionSampler`。

### Scheduler
- 英文原名：Scheduler
- 中文译名：调度器
- Definition：负责每个 step 决定哪些请求被 prefill/decode、分配 KV cache block、构造 `SchedulerOutput`。V1 中的实现是 `vllm/v1/core/sched/scheduler.py:64` 的 `class Scheduler`，遵循 `SchedulerInterface`（`vllm/v1/core/sched/interface.py:36`）。可通过 `SchedulerConfig.scheduler_cls` 替换为自定义实现（`vllm/config/scheduler.py:127`）。

### SchedulerOutput
- 英文原名：`SchedulerOutput`
- 中文译名：调度结果
- 定义：scheduler 与 worker 之间的接口数据结构：包含 `scheduled_new_reqs`、`scheduled_cached_reqs`、`num_scheduled_tokens`、`scheduled_spec_decode_tokens`、`scheduled_encoder_inputs`、`finished_req_ids`、`kv_connector_metadata` 等字段。worker 端只接收 diff，已注册请求只发增量。
- 代码位置：`vllm/v1/core/sched/output.py:181` `class SchedulerOutput`。

### Sequence Parallelism / Context Parallelism
- 英文原名：Sequence Parallelism (SP) / Context Parallelism (CP)
- 中文译名：序列并行 / 上下文并行
- 定义：把序列维切分到多 rank，可减少 attention 中间激活与 KV 占用。vLLM 区分 prefill CP (`pcp`) 与 decode CP (`dcp`)，并由 compilation pass 启用 SP（`PassConfig.enable_sp`）。
- 代码位置：`vllm/v1/worker/cp_utils.py`；`vllm/config/parallel.py` 中 `prefill_context_parallel_size`、`decode_context_parallel_size`；`vllm/config/compilation.py:129` `enable_sp`。

### Slot Mapping
- 英文原名：slot mapping
- 中文译名：槽位映射
- 定义：每个 token 写入 KV cache 时对应的物理 slot 索引（block_id * block_size + offset）。`BlockTable.slot_mapping` 缓存当前 batch 的映射；attention kernel 用它执行 KV 写入。
- 代码位置：`vllm/v1/worker/block_table.py:75`；`vllm/v1/attention/backends/utils.py` 中 `PAD_SLOT_ID` 用于 padding。

### Spec Decode (Speculative Decoding)
- 英文原名：Speculative decoding
- 中文译名：投机解码
- 定义：用便宜的 draft 模型/算法（n-gram、suffix、EAGLE、Medusa、MTP）预生成若干候选 token，再由 target 模型一次 forward 校验。被接受的 token 直接产出，等价采样下不损失质量。
- 代码位置：`vllm/v1/spec_decode/` 全目录；接受率统计 `vllm/v1/spec_decode/metrics.py`；采样使用 `vllm/v1/sample/rejection_sampler.py:392` `rejection_sample()`。

### Tensor Parallelism (TP)
- 英文原名：Tensor Parallelism
- 中文译名：张量并行
- 定义：把单个 linear/MoE 内部权重沿某一维切到多张卡，每 step 内部用 allreduce 同步。
- 代码位置：`vllm/config/parallel.py:113`；`vllm/model_executor/layers/linear.py` 中 `ColumnParallelLinear` / `RowParallelLinear`。

### Token Budget
- 英文原名：token budget / `max_num_batched_tokens`
- 中文译名：token 预算
- 定义：scheduler 每个 step 允许的总 token 数（prefill + decode 之和）。预算耗尽则余下请求等待下一个 step。
- 代码位置：`vllm/config/scheduler.py:49` 字段 `max_num_batched_tokens: int`（默认 `DEFAULT_MAX_NUM_BATCHED_TOKENS = 2048`）。

### Tokenizer
- 英文原名：Tokenizer
- 中文译名：分词器
- 定义：把文本切成 token id 的组件，vLLM 主要使用 HuggingFace transformers 或 Rust `tokenizers`。`TokenizerLike` 是 vllm 的抽象协议。
- 代码位置：`vllm/tokenizers/`；HF wrapper 入口经 `vllm/transformers_utils/`。

### Worker
- 英文原名：Worker
- 中文译名：工作进程
- 定义：单设备执行单元；持有 `ModelRunner` 和该设备的 KV cache。`Executor` 启动多个 worker（多进程/Ray Actor），每个 worker 对应一张 GPU。
- 代码位置：`vllm/v1/worker/gpu_worker.py:106` `class Worker(WorkerBase)`；基类 `vllm/v1/worker/worker_base.py`。

### torch.compile
- 英文原名：`torch.compile`
- 中文译名：PyTorch 编译器
- 定义：vLLM 通过自定义 `torch.compile` 后端把模型 FX 图传给 Inductor / 自家 pass manager，做 fusion、splitting 与 piecewise CUDA Graph 准备。`CompilationConfig` 控制 level、cache、pass 等。
- 代码位置：`vllm/compilation/backends.py:801`；`vllm/config/compilation.py:381` `class CompilationConfig`；编译缓存路径 `~/.cache/vllm/torch_compile_cache/`。

---

## Part 2：FAQ

### V1 和 V0 架构的核心区别是什么？为什么要重构？

V1 把所有非模型逻辑（scheduler、output processor、detokenizer、structured output、stat logger 等）整体重写并迁移到 `vllm/v1/`，主入口是 `vllm/v1/engine/core.py:91` 的 `EngineCore` 与 `vllm/v1/engine/async_llm.py:70` 的 `AsyncLLM`。最显著的差异：（1）调度结果 `SchedulerOutput`（`vllm/v1/core/sched/output.py:181`）只传 diff，scheduler 与 worker 间共享请求缓存；（2）`EngineCoreProc` 默认跑在独立进程中（由 `VLLM_ENABLE_V1_MULTIPROCESSING` 控制，见 `vllm/envs.py:130`），通过 ZMQ 通信；（3）KV cache、attention metadata 由专门的 `KVCacheManager`/`AttentionMetadataBuilder` 模型解耦各种 backend；（4）spec decode、structured output 等被一等公民化、不再以补丁形式嵌入。

V0 路径在近期版本已被基本废弃；目前代码库（master）默认就是 V1，`VLLM_USE_V1` 不再是开关。重构动机包括降低调度耗时（V0 的 SequenceGroup 状态机过重）、统一多模态/MoE/Mamba/MLA 的 KV 分组、为 disagg P/D 和 KV connector 留出抽象层。

### vLLM 如何选择 attention backend？我怎么强制指定？

选择入口在 `vllm/v1/attention/selector.py:52` 的 `get_attn_backend()`。其流程是：把 `head_size`、`dtype`、`kv_cache_dtype`、`use_mla`、`has_sink`、`use_sparse` 等打包成 `AttentionSelectorConfig`（`vllm/v1/attention/selector.py:21`），交给 `current_platform.get_attn_backend_cls()` 由平台层（CUDA/ROCm/CPU/XPU/TPU）按硬件能力与 head_size、量化要求挑选具体 backend；同时尊重用户在 `attention_config.backend` 中显式指定的枚举（`vllm/config/attention.py:17`）。

强制指定的方法是通过 CLI 或 `EngineArgs`：`--attention-config.backend=FLASHINFER` 或 `--attention-config.backend=TRITON_ATTN`。可选枚举值见 `vllm/v1/attention/backends/registry.py:34` 的 `AttentionBackendEnum`（如 `FLASH_ATTN`、`FLASHINFER`、`TRITON_ATTN`、`FLEX_ATTENTION`、`TRITON_MLA`、`FLASHMLA`、`CUTLASS_MLA` 等）。MLA 模型可用 `--attention-config.mla-prefill-backend` 单独覆盖 prefill 后端；MLA 整体禁用走 `VLLM_MLA_DISABLE=1`（`vllm/envs.py:139`）。第三方后端可通过 `register_backend(AttentionBackendEnum.CUSTOM, "your.module.YourBackend")` 注册（`vllm/v1/attention/backends/registry.py:203`）。

### 如何为 vLLM 添加一个新模型？需要实现哪些接口？

最少要做三件事：（1）在 `vllm/model_executor/models/` 新建模块，类需继承 `nn.Module`，构造函数签名为 `(vllm_config: VllmConfig, prefix: str = "")`，权重加载用 `WeightsMapper` 配合 `weight_loader` 协议；（2）按需实现可选 protocol —— `SupportsMultiModal`、`SupportsLoRA`、`SupportsPP` 等（`vllm/model_executor/models/interfaces.py:94`/`:537`/`:615`）；（3）在 `vllm/model_executor/models/registry.py` 的 `_TEXT_GENERATION_MODELS`、`_MULTIMODAL_MODELS`、`_EMBEDDING_MODELS` 等表中加入 `(architecture, ("module_name", "ClassName"))`。

attention 层应使用 `vllm.attention.Attention` 包装、不要自己造 KV cache；模型应通过 `ParallelLMHead`（`vllm/model_executor/layers/vocab_parallel_embedding.py:503`）输出 logits、通过 `LogitsProcessor`（`vllm/model_executor/layers/logits_processor.py:19`）应用 logits bias，从而自动获得 TP/PP 支持。多模态模型额外需要注册 processor、dummy inputs builder 到 `MultiModalRegistry`（`vllm/multimodal/registry.py:98`）。完整指引参考仓库内 `docs/contributing/model/`、`docs/design/` 系列文档与现有实现（如 `vllm/model_executor/models/llama.py`、`vllm/model_executor/models/qwen2.py`）。

### 如何调试 vLLM 的请求执行？有哪些日志/profiling 工具？

日志层：`VLLM_LOGGING_LEVEL=DEBUG`（`vllm/envs.py:40`）开 debug；`VLLM_TRACE_FUNCTION=1`（`vllm/envs.py:47`）会把所有函数调用打到日志、用于复现卡死；`VLLM_LOG_STATS_INTERVAL`（`vllm/envs.py:46`，秒）控制 iteration stats 刷新频率；`VLLM_LOG_BATCHSIZE_INTERVAL`（`vllm/envs.py:131`）打印 batch size 直方图；`VLLM_DEBUG_DUMP_PATH`（`vllm/envs.py:244`）把每个 step 的输入张量 dump 到磁盘以便复现；`VLLM_LOG_MODEL_INSPECTION=1`（`vllm/envs.py:257`）记录模型结构 inspection 结果。

Profiling：通过 `--profiler-config.profiler=torch --profiler-config.torch_profiler_dir=/tmp/vllm-trace` 启用 PyTorch profiler（`vllm/config/profiler.py:43`）；运行时通过 `POST /start_profile`、`POST /stop_profile` 控制（在线服务）或调用 `LLM.start_profile()`（离线）。NVIDIA Nsight 用户可加 `VLLM_NVTX_SCOPES_FOR_PROFILING=1` 注入 NVTX range（`vllm/envs.py:236`）。在线服务的 Prometheus metrics 见 `vllm/v1/metrics/prometheus.py`。

### chunked prefill 什么时候启用？怎么影响延迟？

`SchedulerConfig.enable_chunked_prefill` 默认 `True`（`vllm/config/scheduler.py:84`），仅当配置不兼容（例如部分 V0 残留路径或显式 `enable_chunked_prefill=False`）时关闭。当 prompt 长度超过单 step 的 `max_num_batched_tokens` 预算时，scheduler 会把 prefill 切成多个 chunk，每个 chunk 与其他请求的 decode 共同填满该 step 的 token 预算。

对延迟的影响：开启后 prefill 与 decode 混合调度，长 prompt 不再阻塞已运行请求的 decode，平均 ITL（inter-token latency）更平稳；但每个 chunk 多出一次 kernel 启动与 attention metadata 构建开销，单个请求的 TTFT（time to first token）可能略升。可用 `--long-prefill-token-threshold`、`--max-long-partial-prefills`、`--max-num-partial-prefills`（`vllm/config/scheduler.py:70-82`）控制长 prompt 调度策略。

### prefix caching 怎么开/关？跨请求 cache key 是怎么计算的？

开关位于 `--enable-prefix-caching` / `--no-enable-prefix-caching`，对应 `vllm/config/cache.py:91` 的 `enable_prefix_caching: bool = True`，默认开启。哈希算法由 `--prefix-caching-hash-algo` 控制，可选 `sha256`（默认）、`sha256_cbor`、`xxhash`、`xxhash_cbor`（`vllm/config/cache.py:93`）。

Cache key 计算见 `vllm/v1/core/kv_cache_utils.py:541` 的 `hash_block_tokens()`：每个满 block 的哈希 = `hash_function((parent_block_hash, curr_block_token_ids_tuple, extra_keys))`，相当于把链上前缀拼起来一起哈希。`extra_keys` 包含 LoRA id、多模态 hash、cache salt 等会破坏 KV 等价性的因素，避免不同上下文误命中。`NONE_HASH` 用作首块的「父哈希」，可由 `PYTHONHASHSEED` 控制使其跨进程一致（`vllm/v1/core/kv_cache_utils.py:93`）。命中后由 `BlockPool` 增加引用计数，避免被驱逐。

### 如何 benchmark 吞吐和延迟？有哪些内置脚本？

vLLM 提供两套 benchmark 入口。仓库根目录 `benchmarks/` 是历史脚本集合：`benchmark_latency.py`（端到端延迟）、`benchmark_throughput.py`（offline 吞吐）、`benchmark_serving.py`（向已启动的 OpenAI 服务发压）、`benchmark_prefix_caching.py`、`benchmark_long_document_qa_throughput.py`、`benchmark_topk_topp.py`、`benchmark_ngram_proposer.py`、`benchmark_serving_structured_output.py` 等。

新版统一入口在 `vllm/benchmarks/`，对应 CLI 子命令 `vllm bench`：`vllm bench latency`（`vllm/benchmarks/latency.py:79`）、`vllm bench serve`（`vllm/benchmarks/serve.py:1633`）、`vllm bench startup`、`vllm bench sweep`（`vllm/benchmarks/sweep/`）。`vllm bench serve` 支持多种数据集 sampler（`vllm/benchmarks/datasets/`）与多种 backend（`backend_request_func.py`）。

kernel-level 微基准在 `benchmarks/kernels/`、`benchmarks/attention_benchmarks/`、`benchmarks/cutlass_benchmarks/`、`benchmarks/fused_kernels/`、`benchmarks/overheads/` 下。Disagg P/D 与 multi-turn 场景的脚本分别在 `benchmarks/disagg_benchmarks/`、`benchmarks/multi_turn/`。

### 用 `LLM` 类做离线推理 vs `AsyncLLM`/OpenAI server 做在线服务，资源使用和延迟有什么差异？

`LLM`（`vllm/entrypoints/llm.py:92`）封装的是单进程同步引擎，构造时一并初始化 `EngineCore` 与 worker，调用 `generate()` 时阻塞等待整批结果返回。优点是无 IPC、无前端开销、最高吞吐；缺点是无法在生成中并发新请求、所有请求一次性塞入调度器。

`AsyncLLM`（`vllm/v1/engine/async_llm.py:70`）默认把 `EngineCore` 启动为独立进程（`VLLM_ENABLE_V1_MULTIPROCESSING=1`），前端 asyncio 协程通过 ZMQ 把请求送进去、再以 streaming 方式取回 token。OpenAI server（`vllm/entrypoints/openai/`）在 `AsyncLLM` 之上加 FastAPI、tokenization、tool call、reasoning 等。这种架构延迟下限略高（每条请求多一次 IPC + 输出 chunk 聚合，受 `VLLM_V1_OUTPUT_PROC_CHUNK_SIZE` 影响，见 `vllm/envs.py:138`），但允许真正的连续 batching、动态加入新请求，对长尾、高并发场景吞吐更好。

显存占用两者一致（同一个模型 + 同一份 KV cache）；CPU 占用 `AsyncLLM` 略高一些（多一个 engine 进程 + 网络栈）。开发调试和 batch 评测用 `LLM`，生产服务用 `AsyncLLM`/OpenAI server。

### CUDA graph capture 失败怎么排查？

CUDA Graph 由 `GPUModelRunner._dummy_run(for_cudagraph_capture=True)`（`vllm/v1/worker/gpu_model_runner.py:5680` 附近）触发，捕获大小列表来自 `CompilationConfig.cudagraph_capture_sizes`（`vllm/config/compilation.py:631`）。常见失败原因：（1）模型内部出现了不 capture-safe 的操作，例如同步拷贝、CPU↔GPU 调度、动态 shape allocator；（2）attention backend 不支持当前的 `AttentionCGSupport`（`vllm/v1/attention/backend.py:499`，区分 `NEVER`/`PURE_DECODE_ONLY`/`UNIFORM_BATCH`/`ALWAYS`），多见于 prefill 含 chunked 或非均匀 query 长度；（3）custom kernel 或 logits processor 使用了不可重放的 host-side 分支。

排查步骤：先用 `--compilation-config.cudagraph_mode=NONE` 关掉 CUDA Graph 看是否仍然报错（隔离 capture 与计算问题）；保留 `PIECEWISE` 但 disable `FULL` 试试 (`cudagraph_mode=PIECEWISE`)；查 worker 日志里 `Cuda graph` 字样的栈；必要时设 `VLLM_ENABLE_CUDAGRAPH_GC=1`（`vllm/envs.py:216`）触发显式 GC；自定义模型层一定要避免 `tensor.item()`、`.cpu()`、`.numpy()` 与 Python-side `if tensor`。

### TP 切分到多少卡最合适？怎么估算显存？

经验法则：`tensor_parallel_size` 取「能让模型权重 + 单卡 KV cache + activation 工作集放进显存」的最小值，且需满足 `num_attention_heads % tp_size == 0`。模型权重显存约等于 `参数量 × dtype_bytes / tp_size`（fp16/bf16 是 2 字节，fp8 是 1 字节，int4 ≈ 0.5 字节）。

KV cache 显存由 `gpu_memory_utilization` 与剩余空间共同决定：`vllm/config/cache.py` 中 `gpu_memory_utilization` 默认 0.9，扣除权重和 activation 后的部分全部分给 KV cache，向上换算成 `num_gpu_blocks`（每 block 占 `2 × num_kv_heads × head_size × block_size × dtype_bytes × num_layers / tp_size` 字节）。可通过 `--num-gpu-blocks-override` 或 `--kv-cache-memory-bytes`（`vllm/config/cache.py:158`）精确控制。

跨节点先用 PP，节点内用 TP（TP 通信对 NVLink 带宽敏感）。MoE 模型优先考虑 DP+EP 而非纯 TP。具体可用 `python -c "from vllm import LLM; LLM(model='...', tensor_parallel_size=...)"` 启动后观察日志中的 `# GPU blocks` 行确认 KV 余量。

### 怎么自定义 logits processor / sampling 行为？

vLLM 把「采样前对 logits 做加工」与「最终采样」分开。Sampling 参数（`temperature`、`top_p`、`top_k`、`min_p`、`presence_penalty`、`frequency_penalty`、`repetition_penalty`、`logit_bias`、`min_tokens`、`stop_token_ids`、`bad_words` 等）在 `vllm/sampling_params.py` 定义并由 `Sampler`（`vllm/v1/sample/sampler.py:21`）应用。

要插入自定义 logits processor，实现 `vllm/v1/sample/logits_processor/interface.py:60` 的 `class LogitsProcessor` 抽象（实现 `apply(...)`、`update_state(...)`、`is_argmax_invariant()`），然后两种注册方式：（1）作为 `LLM(..., logits_processors=[YourCls])` 或 `EngineArgs.logits_processors=[...]` 传入 FQCN；（2）通过 entry point `vllm.logits_processors`（`vllm/v1/sample/logits_processor/__init__.py:47`）发布插件包。受限解码（grammar/JSON）走 `StructuredOutputManager`（`vllm/v1/structured_output/__init__.py:35`），不需要自己写 logits processor。

### 如何贡献一个新的 attention backend？

新增后端要做的事：（1）实现 `AttentionBackend` 抽象（`vllm/v1/attention/backend.py:55`）—— 提供 `get_name()`、`get_kv_cache_shape()`、`get_metadata_builder_cls()`、`get_impl_cls()` 等类方法；（2）实现 `AttentionMetadataBuilder`（`vllm/v1/attention/backend.py:516`），把 `CommonAttentionMetadata` 转换为后端自己的 metadata 派生类；（3）实现 `AttentionImpl`（`vllm/v1/attention/backend.py:763`）即 `forward()`，配合自己的 paged/MLA kernel；（4）声明 `AttentionCGSupport`（`:499`）告知调度器你能 capture 什么形状；（5）在 `AttentionBackendEnum`（`vllm/v1/attention/backends/registry.py:34`）中加成员，或对外部代码使用 `register_backend(AttentionBackendEnum.CUSTOM, "your.module.YourBackend")`；（6）在对应平台（`vllm/platforms/cuda.py` 等）的 `get_attn_backend_cls()` 中加入挑选规则。

建议参考 `vllm/v1/attention/backends/triton_attn.py`（结构清晰）、`vllm/v1/attention/backends/flash_attn.py`（生产实现）和 `vllm/v1/attention/backends/mla/flashmla.py`（MLA 范例）。测试可放在 `tests/v1/attention/` 与 `tests/kernels/`。

### 多模态模型的内存占用怎么估？encoder cache 是什么？

多模态模型的额外显存有三块：（1）encoder 权重（如 ViT / CLIP / SigLIP）；（2）encoder 中间激活；（3）encoder cache —— 一份共享缓冲区，缓存每个 multimodal item 的视觉/音频嵌入，直到对应请求消费掉这些 placeholder token。

encoder cache 由 `EncoderCacheManager`（`vllm/v1/core/encoder_cache_manager.py:17`）管理，大小由 `SchedulerConfig.encoder_cache_size` 决定（`vllm/config/scheduler.py:103`，按 max embedding token 数 × 模型隐藏维度自动估算）。如果一个 item 的嵌入 token 数超过 `max_num_encoder_input_tokens`，调度器会拒绝该请求。估显存时把 encoder cache ≈ `encoder_cache_size × hidden_size × dtype_bytes` 计入，并预留 fp16 编码激活的 1–2× 倍。可参考 `vllm/multimodal/encoder_budget.py:MultiModalBudget`，并用 `VLLM_LOG_MODEL_INSPECTION=1` 检查打印的预算。

### spec decode 接受率低怎么办？

先看指标：`SpecDecodingStats`（`vllm/v1/spec_decode/metrics.py`）会上报 `num_drafts`、`num_accepted_tokens`、acceptance rate 等。常见排查方向：

1. **draft 长度过大**：`--speculative-config.num_speculative_tokens` 应根据数据分布选 3–7，太大会把方差转嫁到拒绝率。
2. **采样温度不匹配**：贪心解码下接受率最高；高温（>1.0）下 EAGLE/MTP 都会显著掉点，必要时让 draft 在更低温度下决策（参考 `RejectionSampler`，`vllm/v1/sample/rejection_sampler.py:37`）。
3. **draft 模型差**：换 EAGLE/EAGLE3、MTP 头或更大的 draft model；n-gram 适合代码/重复文本场景，对话场景可能 0% 接受。
4. **batch 太大**：batch 中混入很多请求时，单条 spec 的额外开销可能盖过收益。可降低 `--max-num-seqs` 或在低 QPS 时启用。
5. 检查 `num_invalid_spec_tokens`（`vllm/v1/core/sched/output.py:230`）——结构化解码会让大量 draft token 因不满足 grammar 而失效。

### vllm 怎么写单元测试 / e2e 测试？测试目录组织是怎样的？

`tests/` 顶层按主题分目录：`tests/basic_correctness/`（端到端正确性 smoke）、`tests/v1/`（V1 引擎专属，下分 `engine/`、`core/`、`worker/`、`executor/`、`attention/`、`spec_decode/`、`structured_output/`、`kv_connector/`、`kv_offload/`、`sample/`、`metrics/`、`cudagraph/`、`e2e/` 等）、`tests/distributed/`（多卡）、`tests/kernels/`（kernel-level）、`tests/models/`（按模型族分子目录）、`tests/multimodal/`、`tests/lora/`、`tests/quantization/`、`tests/spec_decode/`（与 V1 重叠的历史目录）、`tests/entrypoints/`（OpenAI server / offline LLM）、`tests/benchmarks/`、`tests/compile/`（torch.compile / CUDA Graph）。

写测试的常用 fixture 在 `tests/conftest.py` 与 `tests/v1/utils.py`；统一通过 `pytest` 运行，例如 `.venv/bin/python -m pytest tests/v1/core/ -v`；GPU 必需的测试用 `@pytest.mark.requires_gpu` / `@pytest.mark.gpu` 之类的标记跳过 CPU 环境。多卡测试位于 `tests/distributed/` 与 `tests/v1/distributed/`，通常通过 `torchrun` 或 `spawn_distributed` helper 拉起。模型 e2e 测试遵循 `tests/models/<family>/test_*.py` 模式，最小复用 `LLM` 接口跑 1–2 个 prompt 校对输出。

---

## Part 3：调试与开发速查

### 常用环境变量（节选）

> 完整列表见 `vllm/envs.py:1` 的 `TYPE_CHECKING` 块（声明）和 `:560` 之后的 `environment_variables` dict（解析）。

| 变量 | 作用 | 默认 / 取值 | 源码 |
| --- | --- | --- | --- |
| `VLLM_LOGGING_LEVEL` | 全局日志级别 | `INFO` | `vllm/envs.py:40`、`:721` |
| `VLLM_LOGGING_CONFIG_PATH` | 自定义 logging dictConfig 文件 | `None` | `vllm/envs.py:43` |
| `VLLM_CONFIGURE_LOGGING` | 是否让 vLLM 接管 logging 配置 | `1` | `vllm/envs.py:39`、`:716` |
| `VLLM_LOG_STATS_INTERVAL` | iteration stats 上报间隔（秒，<=0 关闭） | `10.0` | `vllm/envs.py:46`、`:733` |
| `VLLM_LOG_BATCHSIZE_INTERVAL` | batch size 直方图上报间隔 | `-1` | `vllm/envs.py:131` |
| `VLLM_TRACE_FUNCTION` | 是否打印每次 Python 函数调用（调试卡死用） | `0` | `vllm/envs.py:47`、`:741` |
| `VLLM_DEBUG_DUMP_PATH` | 把每步输入张量 dump 到目录 | `None` | `vllm/envs.py:244`、`:656` |
| `VLLM_NVTX_SCOPES_FOR_PROFILING` | 在关键路径注入 NVTX range | `0` | `vllm/envs.py:236` |
| `VLLM_CUSTOM_SCOPES_FOR_PROFILING` | torch profiler scope tag | `0` | `vllm/envs.py:235` |
| `VLLM_USE_PRECOMPILED` | 安装时跳过 C++ 编译，仅装 Python | `0` | `vllm/envs.py:88`、`:552` |
| `VLLM_USE_AOT_COMPILE` | 启用 torch AOT 编译路径 | 自动 | `vllm/envs.py:101`、`:317` |
| `VLLM_DISABLE_COMPILE_CACHE` | 禁用 torch.compile 缓存 | `0` | `vllm/envs.py:132`、`:313` |
| `VLLM_ENABLE_V1_MULTIPROCESSING` | EngineCore 独立进程开关 | `1` | `vllm/envs.py:130` |
| `VLLM_V1_OUTPUT_PROC_CHUNK_SIZE` | output processor batch 大小 | `128` | `vllm/envs.py:138` |
| `VLLM_RPC_TIMEOUT` | 前端↔EngineCore RPC 超时（ms） | `10000` | `vllm/envs.py:95`、`:948` |
| `VLLM_ENGINE_ITERATION_TIMEOUT_S` | 单 iteration 上限（秒） | `60` | `vllm/envs.py:25` |
| `VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS` | worker `execute_model` 超时 | `300` | `vllm/envs.py:201` |
| `VLLM_WORKER_MULTIPROC_METHOD` | worker 进程启动方式 | `fork` / `spawn` | `vllm/envs.py:65`、`:810` |
| `VLLM_ALLOW_LONG_MAX_MODEL_LEN` | 允许 `max_model_len` 超过 config | `0` | `vllm/envs.py:94`、`:933` |
| `VLLM_MAX_N_SEQUENCES` | 单引擎并发请求上限 | `16384` | `vllm/envs.py:97` |
| `VLLM_API_KEY` | OpenAI 兼容服务的 API key | `None` | `vllm/envs.py:27` |
| `VLLM_HOST_IP` / `VLLM_PORT` | 服务监听地址 | — | `vllm/envs.py:15-16` |
| `VLLM_CACHE_ROOT` | 编译缓存根目录 | `~/.cache/vllm` | `vllm/envs.py:33`、`:587` |
| `VLLM_CONFIG_ROOT` | 用户配置根目录 | `~/.config/vllm` | `vllm/envs.py:34` |
| `VLLM_MLA_DISABLE` | 强制关闭 MLA backend | `0` | `vllm/envs.py:139`、`:1156` |
| `VLLM_KV_CACHE_LAYOUT` | KV cache 张量布局 (`NHD` / `HND`) | `None` | `vllm/envs.py:202`、`:1479` |
| `VLLM_USE_FLASHINFER_SAMPLER` | sampler 走 FlashInfer | `1` | `vllm/envs.py:48`、`:745` |
| `VLLM_USE_FLASHINFER_MOE_*` | MoE 各精度走 FlashInfer | `0` | `vllm/envs.py:178-225` |
| `VLLM_USE_DEEP_GEMM` | 使用 DeepGemm 内核 | `1` | `vllm/envs.py:167` |
| `VLLM_FLASHINFER_WORKSPACE_BUFFER_SIZE` | FlashInfer workspace 大小 | `394MB` | `vllm/envs.py:186` |
| `VLLM_ENABLE_CUDAGRAPH_GC` | capture 阶段强制 GC | `0` | `vllm/envs.py:216`、`:1549` |
| `VLLM_USE_BREAKABLE_CUDAGRAPH` | 试验性可中断 CUDA Graph | `0` | `vllm/envs.py:148` |
| `VLLM_ALLOW_RUNTIME_LORA_UPDATING` | LoRA 运行时热加载 | `0` | `vllm/envs.py:106`、`:983` |
| `VLLM_DP_RANK` / `VLLM_DP_SIZE` / `VLLM_DP_MASTER_IP` / `VLLM_DP_MASTER_PORT` | DP 拓扑参数 | — | `vllm/envs.py:143-151` |
| `VLLM_USE_RAY_V2_EXECUTOR_BACKEND` | 切到 RayExecutorV2 | `0` | `vllm/envs.py:63` |
| `VLLM_USE_RAY_COMPILED_DAG_CHANNEL_TYPE` | Ray DAG channel (`auto`/`nccl`/`shm`) | `auto` | `vllm/envs.py:60` |
| `VLLM_RAY_PER_WORKER_GPUS` | Ray actor 每 worker GPU 占比 | `1.0` | `vllm/envs.py:140` |
| `VLLM_BATCH_INVARIANT` | 强制 batch-invariant kernel | `0` | `vllm/envs.py:84` |
| `VLLM_DISABLED_KERNELS` | 禁用 kernel 名列表（逗号） | `[]` | `vllm/envs.py:108`、`:998` |
| `VLLM_V1_USE_OUTLINES_CACHE` | outlines grammar 缓存 | `0` | `vllm/envs.py:163` |
| `VLLM_USE_MODELSCOPE` | 用 ModelScope 替代 HuggingFace | `0` | `vllm/envs.py:18` |
| `VLLM_NO_USAGE_STATS` / `VLLM_DO_NOT_TRACK` | 关闭使用统计上报 | `0` | `vllm/envs.py:36-37` |

> 注：仓库现版本默认走 V1 引擎，历史上的 `VLLM_USE_V1` 已不再作为运行时开关存在；如需了解 V1 vs V0 切换历史，请查阅 `vllm/v1/` 的目录注释与 PR 历史。

### 常用调试 / benchmark 命令

```bash
# 启动 OpenAI 兼容服务（最常用入口）
vllm serve <model> --tensor-parallel-size 2 --max-model-len 4096

# 离线吞吐 benchmark
python benchmarks/benchmark_throughput.py \
    --model <model> --dataset-name sharegpt --num-prompts 1000

# 离线延迟 benchmark
python benchmarks/benchmark_latency.py --model <model> --batch-size 1 \
    --input-len 1024 --output-len 128

# 在线压测（先 vllm serve 起服务）
python benchmarks/benchmark_serving.py --backend vllm --model <model> \
    --dataset-name sharegpt --num-prompts 500 --request-rate 8

# 新版统一 CLI（推荐）
vllm bench latency --model <model> --batch-size 1
vllm bench serve  --model <model> --dataset-name sharegpt --num-prompts 500
vllm bench startup --model <model>

# 前缀缓存 / 长文档
python benchmarks/benchmark_prefix_caching.py --model <model>
python benchmarks/benchmark_long_document_qa_throughput.py --model <model>

# 投机解码 draft proposer 微基准
python benchmarks/benchmark_ngram_proposer.py

# 抓取 torch profiler trace
vllm serve <model> \
    --profiler-config.profiler torch \
    --profiler-config.torch_profiler_dir /tmp/vllm-trace
# 然后 curl -X POST http://localhost:8000/start_profile / stop_profile

# 调试卡死：打印每次函数调用
VLLM_TRACE_FUNCTION=1 VLLM_LOGGING_LEVEL=DEBUG vllm serve <model>

# 一次性导出环境信息（提 issue 时附）
python -m vllm.collect_env
```

### 测试目录速查（`tests/`）

| 目录 | 关注点 |
| --- | --- |
| `tests/basic_correctness/` | 端到端 smoke 正确性 |
| `tests/v1/` | V1 引擎全部子系统的回归（`core/` 调度、`worker/` 模型执行、`engine/` async/llm、`attention/`、`spec_decode/`、`structured_output/`、`kv_connector/`、`kv_offload/`、`sample/`、`metrics/`、`cudagraph/`、`e2e/` 等） |
| `tests/distributed/` | 多进程 / 多机分布式 |
| `tests/v1/distributed/` | V1 路径的 DP/TP/PP 测试 |
| `tests/kernels/` | 单独 kernel 单测 |
| `tests/compile/` | torch.compile、PassManager、CUDA Graph |
| `tests/models/` | 各模型族 e2e |
| `tests/multimodal/` | 多模态 processor / encoder |
| `tests/lora/` | LoRA 加载、调度、kernel |
| `tests/quantization/` | GPTQ / AWQ / FP8 / bitsandbytes 等 |
| `tests/spec_decode/` | 投机解码（与 `tests/v1/spec_decode/` 有重叠，新增请优先放 V1 路径） |
| `tests/entrypoints/` | `LLM`、`AsyncLLM`、OpenAI server |
| `tests/samplers/` | 采样器和 logprobs |
| `tests/reasoning/` | reasoning（思考）解析与控制 |
| `tests/tool_use/` / `tests/tool_parsers/` | 工具调用解析 |
| `tests/benchmarks/` | benchmark 脚本自身的回归 |
| `tests/standalone_tests/` | 不依赖 GPU 的独立单测 |
| `tests/tracing/` | OpenTelemetry tracing |
| `tests/system_messages/` | system prompt / chat template |
| `tests/cuda/` / `tests/rocm/` | 平台特有 |

> 单测推荐入口：`.venv/bin/python -m pytest tests/v1/core/ -v`；CI 配置参考 `tests/ci_envs.py` 与 `.buildkite/`（仓库根目录）。

---

至此本章结束。后续如发现新增的术语、环境变量或测试目录变化，请按字母顺序补入对应小节，并保持代码引用使用 `file:line` 形式以便 IDE 跳转。
