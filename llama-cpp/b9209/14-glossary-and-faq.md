# 第 14 章 术语表与 FAQ

本章汇集 llama.cpp 代码库中高频出现的核心术语、常见工程问题以及开发调试速查表。术语按英文首字母大致排序。代码引用锁定至 commit `45b455e66`（2026-05-18）。

---

## Part 1：术语表

### backend（ggml_backend）
- 英文原名：`ggml_backend`
- 中文译名：计算后端
- 定义：抽象计算设备（CPU、CUDA、Metal、Vulkan 等）的接口层，提供缓冲区分配、张量读写及计算图执行能力。通过 `ggml_backend_load_all()` 在运行时动态发现和注册。
- 代码位置：`ggml/include/ggml-backend.h:27` 类型定义，`ggml/src/ggml-backend-reg.cpp:555` 注册加载逻辑。

### backend scheduler（ggml_backend_sched）
- 英文原名：`ggml_backend_sched`
- 中文译名：后端调度器
- 定义：将计算图中的各算子自动分配到最适合的后端执行，处理跨后端张量迁移（split/copy），支持 GPU offload 与 CPU fallback 共存。
- 代码位置：`ggml/include/ggml-backend.h:305` 类型定义，`ggml/include/ggml-backend.h:317` `ggml_backend_sched_new` API，`src/llama-context.cpp:371` 推理调用入口。

### ggml_backend_buffer
- 英文原名：`ggml_backend_buffer`
- 中文译名：后端缓冲区
- 定义：由特定后端分配和管理的内存区域，张量的实际数据存储其中；不同后端的缓冲区不可直接混用，跨后端数据传输通过调度器自动插入复制算子。
- 代码位置：`ggml/include/ggml-backend.h:25` 类型定义，`ggml/include/ggml-backend.h:55` 操作 API。

### ggml_cgraph
- 英文原名：`ggml_cgraph`
- 中文译名：计算图
- 定义：ggml 的有向无环图（DAG），记录所有张量操作节点及其依赖关系；每次 `llama_decode` 调用前通过 `model.build_graph()` 重新构建，`ggml_backend_sched_graph_compute` 执行它。
- 代码位置：`ggml/include/ggml.h:386` 前置声明，`ggml/include/ggml.h:2712` `ggml_new_graph` 创建接口，`src/llama-context.cpp:1269` 每次解码时构建图。

### ggml_context
- 英文原名：`ggml_context`
- 中文译名：ggml 上下文
- 定义：ggml 的内存竞技场（arena allocator），所有张量元数据和计算图节点从中分配；通过 `ggml_init` 创建、`ggml_free` 销毁，支持 `no_alloc` 模式（只分配元数据，数据由后端缓冲区管理）。
- 代码位置：`ggml/include/ggml.h:385` 前置声明，`ggml/include/ggml.h:800` `ggml_init` API。

### ggml_tensor
- 英文原名：`ggml_tensor`
- 中文译名：ggml 张量
- 定义：ggml 的基本数据单元，包含形状（`ne[4]`）、步长（`nb[4]`）、数据类型（`type`）、指向实际数据的指针（`data`）以及操作类型（`op`）；既用于权重存储也用于中间激活值。
- 代码位置：`ggml/include/ggml.h:660` 结构体定义，`ggml/include/ggml.h:673` stride 布局注释。

### GGUF
- 英文原名：`GGUF (GGML Unified File Format)`
- 中文译名：GGUF 模型文件格式
- 定义：llama.cpp 的模型序列化格式，magic 为 `"GGUF"`，version 当前为 3，包含 key-value 元数据区（架构参数、分词器信息）和张量数据区（各张量名称、类型、形状、量化数据）；替代了早期的 ggml/ggmf/ggjt 格式。
- 代码位置：`ggml/include/gguf.h:41` magic 定义，`ggml/include/gguf.h:79` `gguf_init_from_file` 加载接口。

### GQA（分组查询注意力）
- 英文原名：`GQA (Grouped Query Attention)`
- 中文译名：分组查询注意力
- 定义：KV head 数量少于 Q head 数量的注意力变体（如 Llama-3-8B 中 Q head 32 个、KV head 8 个），通过共享 KV head 减少 KV cache 占用；`n_gqa() = n_head / n_head_kv`。
- 代码位置：`src/llama-hparams.h:71` `n_head_arr`/`n_head_kv_arr` 字段，`src/llama-quant.cpp:490` 量化时根据 GQA 程度调整 attention_v 精度。

### imatrix（importance matrix）
- 英文原名：`imatrix (importance matrix)`
- 中文译名：重要性矩阵
- 定义：在代表性文本上统计每个权重矩阵各输入通道的激活平方均值，用于指导 IQ 系列量化选择量化码本，使关键通道受到更好的精度保护。
- 代码位置：`tools/imatrix/imatrix.cpp:61` `IMatrixCollector` 类，`ggml/src/ggml.c:7660` `ggml_quantize_requires_imatrix` 强制检查。

### IQ-quant（importance-aware quantization）
- 英文原名：`IQ-quant (Importance-aware Quantization)`
- 中文译名：重要性感知量化
- 定义：llama.cpp 独有的量化族，IQ1/IQ2/IQ3/IQ4 系列；使用 imatrix 加权误差优化量化码本分配，在相同 bpw 下比传统量化具有更低的困惑度。
- 代码位置：`ggml/include/ggml.h:406` `GGML_TYPE_IQ2_XXS` 等枚举，`ggml/src/ggml-quants.c:3525` `quantize_iq2_xxs` 实现。

### K-quant（super-block quantization）
- 英文原名：`K-quant`
- 中文译名：K 量化（超级块量化）
- 定义：以 256 元素超级块（`QK_K=256`）为单位的量化族（Q2_K…Q6_K），超级块内的子块 scale 本身也被量化存储；与传统量化（QK=32）相比在高压缩比下精度更好。
- 代码位置：`ggml/src/ggml-common.h:89` `QK_K` 定义，`ggml/src/ggml-common.h:288` `block_q2_K` 结构体，`ggml/src/ggml-quants.c:1149` `quantize_q2_K` 实现。

### KV cache
- 英文原名：`KV cache (Key-Value Cache)`
- 中文译名：键值缓存
- 定义：存储自注意力机制中已生成或处理 token 的 Key/Value 张量，避免解码时重复计算历史上下文；显存占用约为 `2 × n_layers × n_kv_heads × d_head × n_ctx × dtype_size`。
- 代码位置：`src/llama-kv-cache.h:20` `llama_kv_cache` 类，`include/llama.h:337` `n_ctx` 参数控制最大容量。

### llama_batch
- 英文原名：`llama_batch`
- 中文译名：推理批次
- 定义：`llama_decode` 的输入结构体，包含 token 数组（`token`）、位置（`pos`）、序列 ID（`seq_id`）及是否输出 logits（`logits`）；`n_tokens` 可达 `n_batch` 上限。
- 代码位置：`include/llama.h:240` 结构体定义，`include/llama.h:911` `llama_batch_get_one` 便利函数。

### llama_context
- 英文原名：`llama_context`
- 中文译名：推理上下文
- 定义：单次推理会话的运行时状态容器，持有 KV cache、后端调度器（`sched`）、计算图缓冲区及各项参数（cparams）；每个 context 绑定到一个模型，支持多个并发 context 共享同一模型。
- 代码位置：`src/llama-context.h:41` 结构体定义，`include/llama.h:509` `llama_init_from_model` 创建接口。

### llama_ftype
- 英文原名：`llama_ftype (file type)`
- 中文译名：文件量化类型
- 定义：GGUF 文件元数据中记录整个模型文件主体量化策略的枚举，如 `LLAMA_FTYPE_MOSTLY_Q4_K_M=15`；与张量级 `ggml_type` 区别：ftype 是意图声明，实际每个张量的类型可通过量化逻辑调整。
- 代码位置：`include/llama.h:117` 枚举定义，`src/llama-quant.cpp:866` 转换为默认 `ggml_type`。

### llama_hparams
- 英文原名：`llama_hparams`
- 中文译名：模型超参数
- 定义：从 GGUF 元数据加载的模型结构参数集合，包括 `n_embd`、`n_layer`、`n_head`、`n_head_kv`、`n_ctx_train`、`n_expert` 等，决定模型计算图的形状。
- 代码位置：`src/llama-hparams.h:36` 结构体定义，`src/llama-hparams.h:43` 各字段注释。

### llama_kv_cache / llama_memory
- 英文原名：`llama_kv_cache / llama_memory`
- 中文译名：KV 缓存实现 / 推理记忆层
- 定义：`llama_memory_i` 是抽象接口（`src/llama-memory.h:71`），`llama_kv_cache` 是其主要实现，管理所有 KV 张量的分配、槽位（slot）分配与碎片整理；`llama_memory_t` 是对外暴露的不透明指针。
- 代码位置：`src/llama-memory.h:71` 接口声明，`src/llama-kv-cache.h:20` `llama_kv_cache` 类定义，`include/llama.h:550` `llama_get_memory` API。

### llama_layer
- 英文原名：`llama_layer`
- 中文译名：模型层（transformer 层）
- 定义：对应 transformer 一个 decoder layer 的所有权重张量集合，包含注意力权重（`attn_q`、`attn_k`、`attn_v`、`attn_out`）、FFN 权重（`ffn_gate`、`ffn_up`、`ffn_down`）及归一化权重。
- 代码位置：`src/llama-model.h:213` 结构体定义，`src/llama-model.h:558` `layers` 向量。

### llama_model
- 英文原名：`llama_model`
- 中文译名：模型对象
- 定义：加载后的完整模型状态，包含 hparams、vocab、所有层（`layers`）及输出权重；拥有所有模型张量的生命周期；`llama_model_base` 是其可实例化的子类，包含 `build_graph` 虚函数。
- 代码位置：`src/llama-model.h:512` 结构体定义，`src/llama-model.h:647` `llama_model_base` 子类。

### llama_sampler / sampler chain
- 英文原名：`llama_sampler / sampler chain`
- 中文译名：采样器 / 采样器链
- 定义：`llama_sampler` 是单步采样操作的接口（accept/apply 回调）；多个采样器通过 `llama_sampler_chain_add` 串联成链（依次执行 top-k → top-p → temperature → greedy/dist）实现灵活的采样策略。
- 代码位置：`include/llama.h:1264` 结构体定义，`include/llama.h:1288` `llama_sampler_chain_init`，`include/llama.h:1308` `llama_sampler_init_greedy` 等初始化函数。

### llama_token
- 英文原名：`llama_token`
- 中文译名：token ID
- 定义：词表中的整数索引，类型为 `int32_t`，是 llama.cpp 内部文本表示的基本单位；特殊 token（BOS/EOS/PAD 等）通过 `llama_vocab_bos/eos` 等函数获取。
- 代码位置：`include/llama.h:69` typedef 定义，`include/llama.h:1066` `llama_vocab_bos` 等特殊 token 访问函数。

### llama_ubatch
- 英文原名：`llama_ubatch`
- 中文译名：微批次（物理批次）
- 定义：`llama_batch`（逻辑批次，最大 `n_batch`）被拆分为更小的物理执行单元，每个 ubatch 最大 `n_ubatch` 个 token；目的是控制 KV cache 分配粒度和 GPU kernel 的中间激活显存峰值。
- 代码位置：`src/llama-batch.h:15` 结构体定义，`include/llama.h:339` `n_ubatch` 参数。

### llama_vocab
- 英文原名：`llama_vocab`
- 中文译名：词表
- 定义：存储模型词表（token↔字符串映射、token scores、特殊 token 标记）和分词器类型（SPM/BPE/WPM/UGM）的结构体；`llama_tokenize` 调用分词器将文本切分为 token ID 序列。
- 代码位置：`src/llama-vocab.h:68` 结构体定义，`include/llama.h:553` `llama_model_get_vocab` 访问接口。

### llm_arch
- 英文原名：`llm_arch`
- 中文译名：模型架构枚举
- 定义：标识支持的模型架构类型的枚举（LLaMA、Falcon、GPT-NeoX、Qwen 等），从 GGUF 的 `general.architecture` 键读取，决定 `build_graph` 时选用哪套权重名称和计算图结构。
- 代码位置：`src/llama-arch.h:13` 枚举定义，`src/llama-arch.h:14` 起各架构列表。

### llm_graph_context（build_attn）
- 英文原名：`llm_graph_context / build_attn`
- 中文译名：图构建上下文 / 注意力构建函数
- 定义：`llm_graph_context` 是所有模型架构共用的图构建辅助类，封装 RoPE、注意力（含 KV cache 写入）、FFN、归一化等子图构建函数；`build_attn` 系列函数构建自注意力子图并自动处理 KV cache 的读写。
- 代码位置：`src/llama-graph.h:720` 结构体定义，`src/llama-graph.h:912` `build_attn` 重载声明族。

### logits
- 英文原名：`logits`
- 中文译名：未归一化对数概率
- 定义：模型最后一层 language head 的输出，形状为 `[n_vocab]`（每个 token 的原始得分），经 softmax 后得到 token 概率分布；采样器基于 logits 选择下一个 token。
- 代码位置：`include/llama.h:987` 注释说明，`include/llama.h:993` `llama_get_logits` 获取接口，`include/llama.h:999` `llama_get_logits_ith`。

### mmap（memory-mapped file）
- 英文原名：`mmap (memory-mapped file)`
- 中文译名：内存映射文件加载
- 定义：通过操作系统 `mmap` 系统调用将 GGUF 文件直接映射到进程地址空间，避免显式文件读取；权重数据按需换入（page fault），显著减少加载时间并允许多进程共享同一物理内存页。
- 代码位置：`include/llama.h:320` `use_mmap` 参数，`include/llama.h:527` `llama_supports_mmap`，`src/llama-quant.cpp:873` 量化时的 mmap 使用注释。

### MoE（专家混合）
- 英文原名：`MoE (Mixture of Experts)`
- 中文译名：混合专家
- 定义：transformer FFN 层由多个"专家"子网络组成，每次前向只激活其中 `n_expert_used` 个（由路由器门控选择），实现参数量增大但计算量不变的稀疏模型；llama.cpp 通过 `build_moe_ffn` 构建对应子图。
- 代码位置：`src/llama-hparams.h:47` `n_expert`/`n_expert_used` 字段，`src/llama-graph.h:834` `build_moe_ffn` 声明。

### n_batch / n_ubatch
- 英文原名：`n_batch / n_ubatch`
- 中文译名：逻辑批大小 / 物理微批大小
- 定义：`n_batch` 是一次 `llama_decode` 调用的最大 token 数（逻辑上限）；`n_ubatch` 是实际分配 KV cache 和执行计算图的物理粒度（`n_ubatch ≤ n_batch`）。两者独立控制，允许大 prompt 分批推进。
- 代码位置：`include/llama.h:338` 参数定义注释，`include/llama.h:537` `llama_n_batch`/`llama_n_ubatch` 查询函数。

### n_ctx
- 英文原名：`n_ctx`
- 中文译名：上下文长度（KV cache 容量）
- 定义：当前推理上下文能同时处理的最大 token 数，决定 KV cache 的分配大小；可以超过模型训练时的 `n_ctx_train`（需配合 RoPE 外推）。
- 代码位置：`include/llama.h:337` 参数定义，`src/llama-hparams.h:43` `n_ctx_train` 区分。

### n_gpu_layers
- 英文原名：`n_gpu_layers`
- 中文译名：GPU 层数
- 定义：将模型前 `n_gpu_layers` 层（及对应 KV cache）的权重卸载到 GPU 显存，其余层保留在 CPU 内存；设置为 -1 或超大值时全部层使用 GPU。
- 代码位置：`include/llama.h:298` 参数定义，`common/arg.cpp:2360` 环境变量 `LLAMA_ARG_N_GPU_LAYERS`。

### prefill / decode
- 英文原名：`prefill / decode`
- 中文译名：预填充 / 解码
- 定义：prefill（prompt processing）指并行处理输入 prompt 的所有 token，batch 大、计算密集；decode（autoregressive generation）指每步只生成一个 token，内存带宽受限。两个阶段对应不同的 CUDA kernel（MMQ vs MMVQ）。
- 代码位置：`src/llama-context.cpp:580` 调度器 reserve 时分别优化 pp/tg 两种图形状，`ggml/src/ggml-cuda/ggml-cuda.cu:2537` CUDA 路径分发注释。

### quantization / block quantization
- 英文原名：`quantization / block quantization`
- 中文译名：量化 / 块量化
- 定义：将 FP32/FP16 权重压缩为低精度整数表示以降低模型体积和推理带宽；块量化以固定大小的块（`QK=32` 或超级块 `QK_K=256`）为单位共享缩放因子，在精度和压缩率之间取得平衡。
- 代码位置：`ggml/src/ggml-common.h:184` `block_q4_0` 基础块结构，`ggml/include/ggml.h:2769` `ggml_quantize_chunk` 统一量化接口。

### RoPE（旋转位置编码）
- 英文原名：`RoPE (Rotary Position Embedding)`
- 中文译名：旋转位置编码
- 定义：通过对 Q/K 向量施加旋转变换编码相对位置信息，无需额外参数且天然支持外推；llama.cpp 在 `build_attn` 内通过 `ggml_rope_ext` 算子实现，支持 YaRN、NTK 等多种外推方法。
- 代码位置：`ggml/include/ggml.h:1813` `ggml_rope_ext` API，`src/llama-graph.h:754` `rope_type` 字段。

### slot（server_slot）
- 英文原名：`slot / server_slot`
- 中文译名：推理槽位
- 定义：`llama-server` 中表示一个并发推理请求的逻辑单元，管理该请求的 token 序列、KV cache 占用范围和解码状态；槽位数由 `n_parallel` 控制，上限即 `n_seq_max`。
- 代码位置：`tools/server/README-dev.md:49` 架构说明，`tools/server/server-common.h:18` `SLT_DBG` 等日志宏。

### speculative decoding
- 英文原名：`speculative decoding`
- 中文译名：投机解码
- 定义：用轻量草稿模型（draft model）预生成多个候选 token，再由目标模型并行验证并接受符合分布的前缀，在不改变输出分布的前提下提高有效吞吐量；llama.cpp 支持多种实现变体（draft model、lookahead、medusa 等）。
- 代码位置：`common/speculative.h:23` `common_speculative_init` 接口，`common/speculative.cpp:125` 统计计数器，`tools/server/server-task.cpp:10` 服务端集成。

### SPM / BPE / WPM / UGM
- 英文原名：`SPM / BPE / WPM / UGM (SentencePiece / Byte-Pair Encoding / WordPiece / Unigram)`
- 中文译名：四种分词算法
- 定义：llama.cpp 支持的四种分词器类型：SPM（LLaMA 原始，字节级 BPE+回退）、BPE（GPT-2 风格）、WPM（BERT WordPiece）、UGM（T5 Unigram）；类型从 GGUF 元数据读取。
- 代码位置：`include/llama.h:72` `llama_vocab_type` 枚举，`src/llama-vocab.h:68` `llama_vocab` 结构体。

### temperature
- 英文原名：`temperature`
- 中文译名：温度（采样温度）
- 定义：除以 logits 的缩放系数，值越大输出越随机（分布更均匀），值越小输出越确定（趋向 argmax）；`temperature=0` 等效于贪心采样；通过 `llama_sampler_init_temp` 设置。
- 代码位置：`include/llama.h:1327` `llama_sampler_init_temp`，`include/llama.h:1329` `llama_sampler_init_temp_ext`（动态温度）。

### top-k / top-p
- 英文原名：`top-k / top-p (nucleus sampling)`
- 中文译名：Top-K 采样 / Top-P（核采样）
- 定义：top-k 保留概率最高的 k 个候选 token；top-p（nucleus sampling）保留概率累计达到 p 的最小候选集合；两者通常在 temperature 前应用以裁剪低质候选，通过 `llama_sampler_init_top_k`/`_top_p` 设置。
- 代码位置：`include/llama.h:1315` `llama_sampler_init_top_k`，`include/llama.h:1318` `llama_sampler_init_top_p`。

### BOS / EOS / EOG token
- 英文原名：`BOS / EOS / EOG (Beginning/End-of-Sequence / End-of-Generation)`
- 中文译名：序列开始/结束/生成结束 token
- 定义：控制序列边界的特殊 token；BOS 标记序列开始，EOS 标记序列结束，EOG（end-of-generation）是更广泛的概念，包括 EOS、EOT 等所有应终止生成的 token；`llama_vocab_is_eog` 检查一个 token 是否为 EOG。
- 代码位置：`include/llama.h:1066` `llama_vocab_bos/eos/eot`，`include/llama.h:1059` `llama_vocab_is_eog` 判断函数。

### causal mask
- 英文原名：`causal mask`
- 中文译名：因果遮蔽掩码
- 定义：自注意力中用于防止当前 token 关注未来 token 的上三角遮蔽矩阵；在 KV cache 模式下退化为向量（每个查询 token 可见 KV cache 中所有已有位置），由 `self_kq_mask` 张量表示。
- 代码位置：`src/llama-graph.h:277` `self_kq_mask` 字段，`src/llama-graph.h:273` `get_kq_mask()` 访问函数。

### continuous batching
- 英文原名：`continuous batching`
- 中文译名：连续批处理
- 定义：服务端将多个不同阶段（prefill/decode）的请求合并在同一 `llama_decode` 调用中执行，允许新请求随时插入而无需等待当前批次全部完成，大幅提升 GPU 利用率。
- 代码位置：`common/arg.cpp:2182` `LLAMA_ARG_CONT_BATCHING` 环境变量，`tools/server/README-dev.md:49` 架构说明。

### flash attention
- 英文原名：`flash attention`
- 中文译名：闪存注意力
- 定义：通过分块计算（tiling）在 SRAM 中完成注意力的 softmax 和加权求和，避免将完整 `n_ctx × n_ctx` 注意力矩阵写入 HBM，显著减少显存占用（从 O(n²) 降至 O(n)）并提速；在 ggml 中实现为 `GGML_OP_FLASH_ATTN_EXT`。
- 代码位置：`ggml/include/ggml.h:557` `GGML_OP_FLASH_ATTN_EXT` 枚举，`ggml/include/ggml.h:2398` `ggml_flash_attn_ext` API，`common/arg.cpp:1388` `LLAMA_ARG_FLASH_ATTN` 环境变量。

### grammar / GBNF
- 英文原名：`grammar / GBNF (GGML BNF)`
- 中文译名：结构化输出语法 / GBNF 语法
- 定义：llama.cpp 自定义的 BNF 变体语法格式，通过约束采样阶段的 logits 确保模型输出符合指定语法（如 JSON、函数调用格式）；通过 `llama_sampler_init_grammar` 启用。
- 代码位置：`include/llama.h:1361` `llama_sampler_init_grammar` 注释，`grammars/README.md` 格式说明。

### greedy sampling
- 英文原名：`greedy sampling`
- 中文译名：贪心采样
- 定义：每步选择概率最高（logit 最大）的 token，无随机性，确保可复现的确定性输出；相当于 `temperature=0` 或直接 argmax；通过 `llama_sampler_init_greedy()` 初始化。
- 代码位置：`include/llama.h:1308` `llama_sampler_init_greedy`。

---

## Part 2：FAQ

### GGUF 与早期 ggml/ggmf/ggjt 格式的区别是什么？

GGUF（`ggml/include/gguf.h:41`，magic `"GGUF"`，v3）引入了结构化 key-value 元数据区（存储架构参数、分词器配置等）和自描述的张量区（包含名称、类型、量化格式）。早期格式将参数硬编码在加载代码中，不同版本/架构需要不同解析逻辑，扩展性差。GGUF 做到了格式与代码解耦，任何工具只需读取元数据即可解析模型，还允许存储 imatrix 等附加信息（`tools/imatrix/imatrix.cpp:37`）。

### llama.cpp 不依赖 PyTorch 怎么做推理？

llama.cpp 使用自研的 `ggml` 张量库（`ggml/src/ggml.c`），实现了矩阵乘、卷积、归一化等算子的 CPU（含 SIMD）和 GPU（CUDA/Metal/Vulkan）后端。推理时通过 `llm_graph_context`（`src/llama-graph.h:720`）以手写 C++ 构建计算图，再由 `ggml_backend_sched_graph_compute` 执行，全程无 Python 或自动求导框架依赖。

### 如何为 llama.cpp 新增一个模型架构？

需要在 `src/llama-arch.h:13` 中添加 `LLM_ARCH_*` 枚举，在 `src/llama-arch.cpp` 中注册架构名称和张量名称映射，在 `src/llama-model.cpp` 中实现 `load_hparams`、`load_tensors` 以及继承 `llm_graph_context` 的 `build_graph` 方法。详细流程见 `docs/development/HOWTO-add-model.md`。

### KV cache 占多少内存，如何估算？

基本公式：`KV cache 大小 = 2 × n_layers × n_kv_heads × d_head × n_ctx × sizeof(dtype)`。以 Llama-3-8B（32 层、8 KV head、128 维、FP16）、`n_ctx=4096` 为例：`2 × 32 × 8 × 128 × 4096 × 2 bytes ≈ 537 MB`。使用 Q8_0 KV cache（`LLAMA_ARG_CACHE_TYPE_K`）可减半。`n_ctx` 翻倍则 KV cache 成比例增长（`include/llama.h:337`）。

### 为什么每次 decode 都要重建计算图？

因为每次调用的 batch shape（token 数、序列数）可能不同，导致 ggml 张量的形状和图拓扑改变。`model.build_graph(gparams)` 在每次 decode 执行（`src/llama-context.cpp:1269`），但图的内存分配通过 `sched_reserve` 预先按最坏情况分配（`src/llama-context.cpp:411`），实际执行时的分配开销极低，图构建本身的 CPU 时间约为微秒级。

### n_batch 和 n_ubatch 的区别是什么？

`n_batch`（`include/llama.h:338`）是 `llama_decode` 单次调用允许的最大逻辑 token 数，控制 API 接口粒度。`n_ubatch`（第 339 行）是内部将批次拆分后每次实际执行计算图的物理大小，决定 KV cache 分配的粒度和 GPU 显存峰值。例如 `n_batch=2048, n_ubatch=512` 时，2048 token 的 prompt 会被分 4 次 ubatch 执行，每次只占用一个 512-token 图的中间激活显存。

### 量化类型这么多，应该如何选择？

对于大多数用户：Q4_K_M 是性价比最优选择（4.58 GB 对 Llama-3-8B，+0.18 ppl）；追求精度用 Q5_K_M 或 Q6_K；显存极紧张选 IQ4_XS（需 imatrix）；CPU 推理优先 Q4_K_M 或 Q4_K_S（有 SIMD 优化）。有 imatrix 时选 IQ4_XS 可以在比 Q4_0 更小的体积下达到更好精度。TQ/MXFP4/NVFP4 适用于特殊场景（原生三值模型或 Blackwell GPU）。数据来源：`tools/quantize/quantize.cpp:34`。

### mmap 加载和普通（read）加载有什么区别？

mmap 加载（`use_mmap=true`，`include/llama.h:320`）不在加载时复制权重到内存，而是通过页错误（page fault）按需换入，首次推理延迟可能略高，但后续如权重已在页缓存中则几乎无读取开销，且多进程共享模型可节省物理内存。普通加载（`use_mmap=false`）将权重全量读入 RAM，随机访问更稳定，适合显存不足需要多次换入换出的场景。Linux/Windows 默认启用 mmap，macOS 默认关闭（`src/llama-quant.cpp:873` 注释说明 macOS 上 mmap 可能减速）。

### llama-cli 和 llama-server 各适用什么场景？

`llama-cli`（`tools/llama-cli/`）是单次交互的命令行工具，适合快速测试、单用户对话；`llama-server`（`tools/server/`）实现 OpenAI 兼容 API（`/v1/completions`、`/v1/chat/completions`），支持连续批处理（`LLAMA_ARG_CONT_BATCHING`）和多并发槽位（`LLAMA_ARG_N_PARALLEL`），适合生产服务和多用户场景。

### 后端是如何在运行时被发现和加载的？

`ggml_backend_load_all()`（`ggml/src/ggml-backend-reg.cpp:555`）按优先级依次尝试加载各后端的动态库（blas、cuda、hip、metal、vulkan、opencl 等），通过 `ggml_backend_load_best` 找到最匹配当前硬件的版本。若动态库不存在则静默跳过。此外可通过环境变量 `GGML_BACKEND_PATH` 加载外部后端（第 582 行）。所有成功加载的后端注册到全局注册表，后续 `ggml_backend_sched` 按优先级分配算子。

### 投机解码（speculative decoding）的基本原理是什么？

草稿模型（通常是同架构小模型）串行生成 N 个候选 token；目标模型以此为输入一次性并行执行前向传播，得到每个位置的条件概率；按投机采样（speculative sampling）接受规则判断前缀的接受程度，拒绝后从修正分布补采一个 token。被全部接受时等于免费获得 N-1 个额外 token。实现见 `common/speculative.cpp`，`n_acc_drafts`/`n_gen_drafts` 统计接受率（第 125-126 行）。

### 为什么 prompt 处理（prefill）比逐 token 解码（decode）快得多？

prefill 阶段将整个 prompt 组成一个大矩阵一次性做矩阵乘（`GEMM`），充分利用 GPU 的并行计算能力，算力利用率高；decode 阶段每步只有一个（或少数几个）新 token，退化为矩阵-向量乘（`GEMV`），GPU 算术单元大量闲置，性能瓶颈转为内存带宽（需要每步从显存读取全部权重）。这也是量化主要加速 decode 而非 prefill 的根本原因。参见 `ggml/src/ggml-cuda/ggml-cuda.cu:2537` MMVQ vs MMQ 路径选择逻辑。

---

## Part 3：调试与开发速查

### 环境变量

以下环境变量在代码中有实际效果，通过 `common/arg.cpp` 的 `set_env()` 机制或后端代码中的 `getenv()` 直接读取。

| 变量 | 作用 |
|------|------|
| `LLAMA_ARG_MODEL` | 默认加载的模型路径（等价于 `-m`） |
| `LLAMA_ARG_N_GPU_LAYERS` | 卸载到 GPU 的层数（等价于 `--n-gpu-layers`） |
| `LLAMA_ARG_CTX_SIZE` | 上下文长度（等价于 `-c`） |
| `LLAMA_ARG_BATCH` | 逻辑批大小 `n_batch` |
| `LLAMA_ARG_UBATCH` | 物理微批大小 `n_ubatch` |
| `LLAMA_ARG_THREADS` | CPU 推理线程数 |
| `LLAMA_ARG_FLASH_ATTN` | 启用 flash attention（`1` 启用） |
| `LLAMA_ARG_MMAP` | 是否使用 mmap 加载（`0` 禁用） |
| `LLAMA_ARG_CACHE_TYPE_K` | KV cache K 的量化类型（如 `q8_0`） |
| `LLAMA_ARG_CACHE_TYPE_V` | KV cache V 的量化类型 |
| `LLAMA_ARG_HOST` | llama-server 监听地址 |
| `LLAMA_ARG_PORT` | llama-server 监听端口 |
| `LLAMA_ARG_CONT_BATCHING` | 启用连续批处理（`1` 启用） |
| `LLAMA_ARG_N_PARALLEL` | 并发推理槽位数 |
| `LLAMA_ARG_N_PREDICT` | 最大生成 token 数 |
| `LLAMA_ARG_CONTEXT_SHIFT` | 启用上下文移位（`1` 启用） |
| `LLAMA_ARG_MAIN_GPU` | 主 GPU 设备 ID |
| `LLAMA_ARG_TOP_K` | top-k 采样值 |
| `LLAMA_ARG_ROPE_SCALING_TYPE` | RoPE 外推缩放类型 |
| `GGML_BACKEND_PATH` | 加载额外后端动态库的路径 |
| `GGML_CUDA_ENABLE_UNIFIED_MEMORY` | 启用 CUDA 统一内存 |
| `GGML_CUDA_NO_PINNED` | 禁用 CUDA 钉住内存 |
| `GGML_CUDA_DISABLE_FUSION` | 禁用 CUDA 算子融合 |
| `GGML_CUDA_FORCE_CUBLAS_COMPUTE_32F` | 强制 cuBLAS FP32 计算 |
| `GGML_VK_PREFER_HOST_MEMORY` | Vulkan 后端优先使用主机内存 |
| `GGML_VK_DISABLE_MMVQ` | 禁用 Vulkan MMVQ 路径 |
| `GGML_NO_BACKTRACE` | 崩溃时不打印 backtrace |

### 常用命令

```bash
# ===== 构建 =====
# 标准 CPU 构建
cmake -B build && cmake --build build --config Release -j$(nproc)

# 启用 CUDA 支持
cmake -B build -DGGML_CUDA=ON && cmake --build build --config Release -j$(nproc)

# 启用 Metal（macOS）
cmake -B build -DGGML_METAL=ON && cmake --build build --config Release -j$(nproc)

# 启用 Vulkan
cmake -B build -DGGML_VULKAN=ON && cmake --build build --config Release -j$(nproc)

# ===== 基本推理（llama-cli）=====
./build/bin/llama-cli \
    -m models/llama-3-8b-q4_k_m.gguf \
    -p "Tell me about llama.cpp:" \
    -n 200 \
    --n-gpu-layers 35 \
    --ctx-size 4096 \
    --temp 0.7 --top-k 50 --top-p 0.9

# 交互式对话模式
./build/bin/llama-cli -m model.gguf --conversation -i

# ===== 服务端（llama-server）=====
./build/bin/llama-server \
    -m models/llama-3-8b-q4_k_m.gguf \
    --n-gpu-layers 35 \
    --ctx-size 8192 \
    --port 8080 \
    --parallel 4 \
    --cont-batching \
    --flash-attn

# 调用服务端（curl）
curl http://localhost:8080/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"default","messages":[{"role":"user","content":"Hello"}]}'

# ===== 量化（llama-quantize）=====
# 基本量化
./build/bin/llama-quantize models/llama-3-8b-f16.gguf models/llama-3-8b-q4km.gguf Q4_K_M

# 使用 imatrix 量化（IQ 系列推荐）
./build/bin/llama-imatrix -m models/llama-3-8b-f16.gguf -f wiki.txt -o imatrix.gguf
./build/bin/llama-quantize --imatrix imatrix.gguf models/llama-3-8b-f16.gguf out.gguf IQ4_XS

# 列出所有量化类型
./build/bin/llama-quantize --list

# ===== 性能测试（llama-bench）=====
./build/bin/llama-bench \
    -m models/llama-3-8b-q4_k_m.gguf \
    --n-gpu-layers 35 \
    -p 512 -n 128 \
    -r 3

# ===== 收集 imatrix =====
./build/bin/llama-imatrix \
    -m models/llama-3-8b-f16.gguf \
    -f calibration_data.txt \
    -o imatrix.gguf \
    --chunk 512 \
    --save-frequency 10 \
    --n-gpu-layers 35
```

### 目录速查

| 目录 | 内容 |
|------|------|
| `ggml/` | ggml 张量库核心（独立子库，可单独使用） |
| `ggml/include/` | 公共 API：`ggml.h`、`ggml-backend.h`、`gguf.h` |
| `ggml/src/` | ggml 实现：`ggml.c`、`ggml-quants.c`、各后端目录 |
| `ggml/src/ggml-cpu/` | CPU 后端，含 AVX/NEON SIMD 路径 |
| `ggml/src/ggml-cuda/` | CUDA 后端（`ggml-cuda.cu`、`mmq.cu`、`mmvq.cuh` 等） |
| `ggml/src/ggml-metal/` | Metal 后端（`ggml-metal.m`、`ggml-metal.metal`） |
| `ggml/src/ggml-vulkan/` | Vulkan 后端 |
| `include/` | llama.cpp 公共 API：`llama.h` |
| `src/` | llama.cpp 核心实现：`llama-model.cpp`、`llama-context.cpp`、`llama-quant.cpp`、`llama-graph.cpp` 等 |
| `src/llama-kv-cache.*` | KV cache 管理 |
| `src/llama-arch.*` | 架构注册和张量名称映射 |
| `common/` | 工具函数：参数解析（`arg.cpp`）、投机解码（`speculative.cpp`）、采样（`sampling.cpp`）等 |
| `tools/` | 各类工具的 main 函数和业务代码 |
| `tools/llama-cli/` | 命令行推理工具 |
| `tools/server/` | OpenAI 兼容 HTTP 服务端 |
| `tools/quantize/` | 量化工具 `llama-quantize` |
| `tools/imatrix/` | imatrix 收集工具 `llama-imatrix` |
| `tools/bench/` | 性能测试工具 `llama-bench` |
| `tests/` | 单元测试和集成测试 |
| `grammars/` | GBNF 语法示例（JSON、算术等） |
| `models/` | 模型文件存放约定目录（通常为空或含示例） |
| `docs/` | 文档：构建指南、开发指南、架构说明 |
| `examples/` | 各类示例程序（embedding、infill、parallel 等） |
