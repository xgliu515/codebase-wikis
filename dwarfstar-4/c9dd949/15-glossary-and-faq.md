# 第 15 章：术语表、FAQ 与速查

> 代码版本：antirez/ds4@c9dd949（2026-05-18）

---

## Part 1: 术语表

### DSML
- 英文原名: `DeepSeek Markup Language`
- 中文译名: DS4 工具调用标记语言
- 定义: 模型输出工具调用时使用的 XML-ish 文本格式，以 `<｜DSML｜tool_calls>` 开头，每个调用用 `<invoke name="...">` 包裹，参数用 `<parameter name="..." string="true/false">` 表示。服务器解析 DSML 并将其翻译为 OpenAI/Anthropic 协议格式。
- 代码位置: `ds4_server.c:4260`

### GGUF
- 英文原名: `GGUF (GPT-Generated Unified Format)`
- 中文译名: GGUF 模型文件格式
- 定义: llama.cpp 生态广泛使用的模型序列化格式，包含张量元数据、分词器词表和量化权重。DS4 只加载为本项目专门生成的特定 GGUF 文件，不是通用加载器。
- 代码位置: `ds4.c:2600`（模型字段读取）

### HC（超连接）
- 英文原名: `Hyper-Connection`
- 中文译名: 超连接
- 定义: DeepSeek V4 Flash 的残差增强机制，每层维护 `DS4_N_HC=4` 条超连接流，通过 Sinkhorn 迭代对 HC 权重进行归一化分配，使信息在层间有更灵活的路由路径。
- 代码位置: `ds4.c:107`（`DS4_N_HC` 常量），`ds4.c:4258`（`hc_split_sinkhorn_one()`）

### HC 流
- 英文原名: `Hyper-Connection flow`
- 中文译名: 超连接流
- 定义: 每个 HC 维度上的激活向量序列，与主残差流并行传播。预填充时用 `hc_flat` 批量处理，解码时逐 token 维护。
- 代码位置: `ds4.c:213`（`hc_flat` 字段），`ds4.c:4614`（批量 HC 前处理）

### IQ2_XXS
- 英文原名: `IQ2_XXS (importance-quantized 2-bit extra-extra-small)`
- 中文译名: IQ2_XXS 量化
- 定义: llama.cpp 生态的 2-bit 非均匀量化格式，结合重要性矩阵（imatrix）对权重排布进行优化，用于 MoE up/gate 权重。DS4 特有的混合量化方案中 IQ2_XXS 负责大多数 MoE expert 层。
- 代码位置: `gguf-tools/quants.c`，`gguf-tools/deepseek4-quantize.c`

### imatrix
- 英文原名: `importance matrix`
- 中文译名: 重要性矩阵
- 定义: 通过在校准数据集上收集每个权重列的激活均方值得到的矩阵，用于指导 2-bit 量化时权重的分布排布，显著改善低 bit 量化质量。
- 代码位置: `ds4.c:114`（`ds4_engine_collect_imatrix()` 声明），`gguf-tools/imatrix/` 目录

### indexer
- 英文原名: `indexer`
- 中文译名: 索引器（稀疏 KV 选择器）
- 定义: ratio-4 压缩层（约 40 层）中的一个额外 attention head 集合，用于从全量压缩 KV 缓存中选出最相关的 `DS4_N_INDEXER_TOP_K=512` 行参与 attention 计算，实现稀疏 attention。
- 代码位置: `ds4.c:104`（`DS4_N_INDEXER_HEAD=64`，`DS4_N_INDEXER_TOP_K=512`）

### KVC 文件
- 英文原名: `KV Cache file (.kvc)`
- 中文译名: KV 缓存磁盘文件
- 定义: ds4-server 保存到磁盘的会话快照文件，文件名为 `SHA1(rendered_text).kvc`，包含服务器定义的固定 header 和引擎序列化的 payload，可选附带 tool-id map。
- 代码位置: `ds4_server.c:8151`（格式说明），`ds4_server.c:8192`（magic 常量）

### layer-major
- 英文原名: `layer-major prefill`
- 中文译名: 层优先预填充
- 定义: Metal 和 CPU prefill 的执行顺序：一批 prompt token 先通过第 0 层所有计算，再通过第 1 层，以此类推。与 token-major 相对，层优先允许批量矩阵运算最大化 GPU 利用率。
- 代码位置: `ds4.c:7761`（CPU），`ds4.c:13222`（Metal）

### 低秩 Q 投影
- 英文原名: `low-rank Q projection`
- 中文译名: 低秩 Q 投影
- 定义: DeepSeek V4 Flash 使用低秩分解对 Q 矩阵进行投影：先将 embedding 投影到 `DS4_N_LORA_Q=1024` 维的低秩空间，再展开到完整的 Q head 维度，减少参数量和带宽。
- 代码位置: `ds4.c:96`（`DS4_N_LORA_Q` 常量）

### logits head
- 英文原名: `logits head / vocabulary projection`
- 中文译名: 词表投影头 / logits 头
- 定义: 模型最后的线性投影层，将 `DS4_N_EMBD=4096` 维 embedding 映射到 `DS4_N_VOCAB=129280` 个词的 logit 分数。ds4 保存最后一个 token 的 logits 到 payload 以避免重新计算。
- 代码位置: `ds4.c:89`（`DS4_N_VOCAB` 常量），`ds4.c:16123`（payload 中写入 logits）

### MoE
- 英文原名: `Mixture of Experts`
- 中文译名: 混合专家
- 定义: DeepSeek V4 Flash 的 FFN 层使用 MoE 架构：每个 token 经过路由器选出少量专家（6 路由 + 1 共享），仅激活部分参数，大幅减少每 token 的计算量。
- 代码位置: `ds4.c:98`（`DS4_N_EXPERT=256`，`DS4_N_EXPERT_USED=6`）

### mmap
- 英文原名: `memory-mapped file`
- 中文译名: 内存映射文件
- 定义: GGUF 权重通过 `mmap()` 惰性映射到进程虚拟地址空间，避免启动时的大量 I/O。KV 缓存磁盘文件故意不用 mmap，以避免给已经映射了大型 GGUF 的进程增加更多 VM 映射。
- 代码位置: `ds4.c:15620`（策略注释），`ds4_server.c:8162`（明确避免 mmap）

### MTP
- 英文原名: `Multi-Token Prediction`
- 中文译名: 多 token 预测（推测解码草稿模型）
- 定义: DS4 可选的投机解码草稿模型，加载一个较小的 MTP GGUF，在 greedy 解码时同时预测多个 draft token，经过验证后批量接受，以提升 token 生成速度。
- 代码位置: `ds4.h:188`（`ds4_engine_has_mtp()`），`ds4_server.c:10899`（MTP decode 路径）

### payload
- 英文原名: `session payload`
- 中文译名: 会话 payload（引擎序列化状态）
- 定义: 引擎侧的 KV 缓存序列化数据，包含 checkpoint token IDs、per-layer raw/compressed KV 张量数据和 logits，由 `ds4_session_save_payload()` 写入 / `ds4_session_load_payload()` 读取。
- 代码位置: `ds4.h:193`，`ds4.c:15858`（大小计算），`ds4.c:16131`（save）

### prefill
- 英文原名: `prefill`
- 中文译名: 预填充
- 定义: 将 prompt token 序列一次性（或分块）通过模型前向传播，建立 KV 缓存状态的过程。DS4 采用 layer-major 顺序按 chunk 执行，默认 chunk 大小随 context 动态调整。
- 代码位置: `ds4.c:6184`（chunk 大小），`ds4.c:13222`（Metal prefill 入口）

### Q2_K
- 英文原名: `Q2_K`
- 中文译名: Q2_K 量化
- 定义: llama.cpp 生态的 2-bit 块量化格式，使用 super-block + block 两级缩放，用于 MoE down 权重。相比 IQ2_XXS 解码更快但信息密度略低。
- 代码位置: `gguf-tools/quants.c`

### Q8_0
- 英文原名: `Q8_0`
- 中文译名: Q8_0 量化
- 定义: 8-bit 均匀量化，每 32 个元素共享一个 float16 缩放因子。DS4 混合量化方案中用于 shared expert、attention 投影和 output 层，保证质量关键路径的精度。
- 代码位置: `gguf-tools/quants.c`

### Q8_K
- 英文原名: `Q8_K`
- 中文译名: Q8_K 量化
- 定义: 8-bit 块量化的变体，缩放因子以 float32 存储，精度略高于 Q8_0，用于特定高精度层。
- 代码位置: `gguf-tools/quants.c`

### ratio-4 层
- 英文原名: `ratio-4 layer (compress ratio 4)`
- 中文译名: ratio-4 压缩层
- 定义: `ds4_layer_compress_ratio()` 对特定层返回 4，这些层除常规 compressed KV 外还启用 indexer，用稀疏 top-K attention 替代对全量压缩 KV 的 dense attention，是高效长上下文推理的核心。
- 代码位置: `ds4.c:411`（`ds4_layer_compress_ratio()`）

### 压缩 KV 缓存
- 英文原名: `compressed KV cache`
- 中文译名: 压缩 KV 缓存
- 定义: DeepSeek V4 Flash 的 MLA 注意力机制将每个 token 的 KV 状态压缩成低维表示存入 compressed KV cache，相比标准 MHA 的 KV 缓存体积减少了数十倍，是长上下文推理和磁盘持久化的基础。
- 代码位置: `ds4.c:4661`（注释），`ds4.c:15862`（payload 大小计算）

### raw SWA 缓存
- 英文原名: `raw SWA (Sliding Window Attention) cache`
- 中文译名: 原始滑动窗口注意力缓存
- 定义: 非压缩的最近 `DS4_N_SWA=128` 行 KV 缓存，用于短程局部注意力（SWA 层），以 E4M3 浮点格式存储非 RoPE 部分。每次 prefill/decode 后新行覆盖环形缓冲区旧行。
- 代码位置: `ds4.c:103`（`DS4_N_SWA`），`ds4.c:15846`（注释：只保存最后几行）

### RMSNorm
- 英文原名: `Root Mean Square Normalization`
- 中文译名: 均方根归一化
- 定义: 相对于 LayerNorm 去掉了均值中心化步骤，只用均方根进行归一化，计算更快且在 transformer 中效果相当。DS4 在 attention pre-norm、FFN pre-norm 等位置广泛使用。
- 代码位置: `ds4.c:52`（`DS4_RMS_EPS`）

### RoPE
- 英文原名: `Rotary Position Embedding`
- 中文译名: 旋转位置编码
- 定义: 将位置信息通过复数旋转嵌入到 Q/K 向量中，支持外推到训练长度之外的上下文。DS4 使用 YaRN 缩放的 RoPE（`DS4_ROPE_SCALE_FACTOR=16`），compressed KV 层使用更高的基频（`DS4_COMPRESS_ROPE_FREQ_BASE=160000`）。
- 代码位置: `ds4.c:56`（常量），`ds4.c:4818`（compressed prefill RoPE 条件）

### session_sync
- 英文原名: `ds4_session_sync`
- 中文译名: 会话同步
- 定义: 引擎侧的前缀复用核心函数。给定完整 prompt token 序列，检测与 live KV 的公共前缀长度，仅对新增后缀执行 prefill，避免全量重算。
- 代码位置: `ds4.h:166`

### sink 注意力
- 英文原名: `sink attention`
- 中文译名: sink 注意力（注意力汇聚）
- 定义: 每个注意力 head 有一个学习到的 sink logit（`attn_sinks` 权重），参与 softmax 分母计算。这为所有 token 提供一个可选的"无限期关注"目标，防止注意力分布在长上下文下过度稀释。
- 代码位置: `ds4.c:4967`（CPU sink 注意力实现）

### snapshot
- 英文原名: `session snapshot`
- 中文译名: 会话快照（内存中）
- 定义: `ds4_session_snapshot` 结构持有一个堆分配的字节缓冲区，通过 `fmemopen()` 包装为 FILE*，调用 save_payload/load_payload 进行内存中的 KV 状态保存和恢复，无需触及磁盘，用于 ds4-bench 等工具。
- 代码位置: `ds4.h:89`（结构定义），`ds4.c:16658`（save_snapshot 实现）

### SwiGLU
- 英文原名: `SwiGLU (Swish-Gated Linear Unit)`
- 中文译名: SwiGLU 激活函数
- 定义: FFN 的激活函数，形式为 `SiLU(gate) * up`，其中 SiLU = `x * sigmoid(x)`。DS4 对 exp 参数做了 clamp（`DS4_SWIGLU_CLAMP_EXP=10`）防止数值溢出。
- 代码位置: `ds4.c:55`（`DS4_SWIGLU_CLAMP_EXP` 常量）

### 哈希路由
- 英文原名: `hash router`
- 中文译名: 哈希路由（确定性专家选择）
- 定义: DeepSeek V4 Flash 的前 `DS4_N_HASH_LAYER=3` 层使用哈希函数确定性地分配专家，而不是学习的路由概率，消除了这些层的路由计算开销。
- 代码位置: `ds4.c:102`（`DS4_N_HASH_LAYER`），`ds4.c:5265`（`layer_hash_router_weights_from_probs()`）

### 共享专家
- 英文原名: `shared expert`
- 中文译名: 共享专家
- 定义: MoE 层中有 `DS4_N_EXPERT_SHARED=1` 个对所有 token 无条件激活的专家，与路由专家的输出相加，保证每个 token 都有基本的 FFN 变换能力。
- 代码位置: `ds4.c:100`（`DS4_N_EXPERT_SHARED`）

### 路由专家
- 英文原名: `routed expert`
- 中文译名: 路由专家
- 定义: MoE 层中由路由器动态选择的专家，每个 token 选择 `DS4_N_EXPERT_USED=6` 个（共 256 个）。后期层使用偏置 top-k 选择，但用无偏概率加权。
- 代码位置: `ds4.c:98`（`DS4_N_EXPERT=256`，`DS4_N_EXPERT_USED=6`）

### 偏置 top-k
- 英文原名: `biased top-k`
- 中文译名: 偏置 top-k 专家选择
- 定义: 非哈希层的专家选择方式：在路由 logit 上加上 load-balancing bias 后取 top-k 进行专家选择，但用无偏的原始 softmax 概率作为加权系数，平衡负载均衡和精确梯度。
- 代码位置: `ds4.c:5308`（注释："biased top-k, but weight them using the unbiased router probabilities"）

### 单实例锁
- 英文原名: `single instance lock`
- 中文译名: 单实例锁
- 定义: ds4 在启动时通过 `flock(fd, LOCK_EX | LOCK_NB)` 对 `/tmp/ds4.lock` 加独占锁，防止两个 ds4 进程同时运行（模型映射可达数十 GiB，并发会导致系统资源耗尽或 Metal/CUDA 资源冲突）。
- 代码位置: `ds4.c:111`（`g_ds4_lock_fd`），`ds4.c:15671`（`ds4_acquire_instance_lock()`）

### 推测解码
- 英文原名: `speculative decoding`
- 中文译名: 推测解码
- 定义: 利用 MTP 草稿模型在一次前向传播中验证多个 draft token，仅在 greedy 解码（temperature=0）时启用，通过 `ds4_session_eval_speculative_argmax()` 实现。
- 代码位置: `ds4.h:178`（接口声明），`ds4_server.c:10899`（使用条件）

### Think Max
- 英文原名: `Think Max (DS4_THINK_MAX)`
- 中文译名: Think Max 模式
- 定义: 最高级推理模式，在 prompt 开头注入特殊前缀（`DS4_REASONING_EFFORT_MAX_PREFIX`）引导模型尽可能深度推理，要求 context size 至少为 `DS4_THINK_MAX_MIN_CONTEXT=393216`，否则自动降级为 `DS4_THINK_HIGH`。
- 代码位置: `ds4.h:27`（`DS4_THINK_MAX`），`ds4.c:71`（最小 context），`ds4.c:15655`（降级逻辑）

### thinking 模式
- 英文原名: `thinking mode`
- 中文译名: 推理模式 / thinking 模式
- 定义: 让模型在可见答复之前生成 `<think>...</think>` 内部推理块的模式。DS4 有三个级别：`NONE`（直接回答）、`HIGH`（标准推理）、`MAX`（深度推理，需大 context）。
- 代码位置: `ds4.h:23`（枚举），`ds4_server.c:10292`（旧 reasoning 不重放的设计）

### ubatch
- 英文原名: `ubatch (micro-batch)`
- 中文译名: 微批次（prefill chunk）
- 定义: prefill 时将 prompt 分成的每个处理块，大小由 `ds4_default_prefill_cap_for_prompt()` 根据 prompt 长度动态决定，默认最大 2048（对齐 Metal kernel schedule）。
- 代码位置: `ds4.c:6184`（`ds4_default_prefill_cap_for_prompt()`）

### ds4_engine
- 英文原名: `ds4_engine`
- 中文译名: DS4 引擎（只读模型）
- 定义: 代表加载的模型权重和推理基础设施的不透明结构，在进程生命周期内不可变。CLI 和 server 代码通过 `ds4.h` 中的公共 API 访问，不直接接触张量布局。
- 代码位置: `ds4.h:57`（前置声明）

### ds4_session
- 英文原名: `ds4_session`
- 中文译名: DS4 会话（可变推理状态）
- 定义: 代表一次推理时间线的可变状态，持有 live KV 缓存、当前 token 序列和 logits。一个 engine 对应一个 session（服务器场景），所有 KV 状态变更由 Metal worker 线程独占。
- 代码位置: `ds4.h:58`（前置声明），`ds4.h:166`（session_sync）

### decode
- 英文原名: `decode (autoregressive token generation)`
- 中文译名: 解码（自回归 token 生成）
- 定义: 逐 token 生成阶段：每次将上一个 token 作为输入执行一次完整前向传播，更新 KV 缓存，采样下一个 token。比 prefill 内存访问密集，带宽是瓶颈。
- 代码位置: `ds4.c:5670`（decode 详细 profile 入口）

### E4M3
- 英文原名: `E4M3 (FP8 format, 4-bit exponent 3-bit mantissa)`
- 中文译名: E4M3 浮点格式（FP8）
- 定义: DeepSeek V4 Flash 用 E4M3 格式（最大绝对值 448）对 compressed KV 的非 RoPE 部分进行量化存储，每组 64 个元素共享一个 float 缩放因子，大幅压缩 KV 内存占用。
- 代码位置: `ds4.c:1632`（CPU 参考实现注释）

### 词表投影
- 英文原名: `vocabulary projection / token embedding`
- 中文译名: 词表投影（token embedding）
- 定义: 模型的 `token_embd.weight` 张量（`DS4_N_VOCAB × DS4_N_EMBD`，F16），同时用于输入 embedding lookup 和输出 logit 计算（tied weights）。
- 代码位置: `ds4.c:2098`（权重字段），`ds4.c:2363`（layout 验证）

### 整模型图
- 英文原名: `whole-model Metal graph`
- 中文译名: 整模型 Metal 计算图
- 定义: Metal 后端将整个模型（所有 43 层）编译为一张 Metal command buffer 计划，而不是逐层动态调度，最大化 GPU pipeline 利用率。
- 代码位置: `ds4.c:8309`（`release` 注释），`ds4.c:15448`（Metal generation 入口注释）

---

## Part 2: FAQ

### Q1: 为什么 ds4 只支持一个模型（DeepSeek V4 Flash）？

ds4 的设计前提是"一次只支持一个模型，做到极致"。代码中的所有常量（层数 43、embedding 维度 4096、专家数 256 等）都是编译期常量，内核 shader 也针对这些维度硬编码了 tiling 和展开策略。支持通用模型会要求运行时维度查询、动态 kernel 选择和大量额外的抽象层，这与"small readable C codebase"的目标相违背。ds4 的质量保证（官方 logits 向量验证）也只对一个已知模型有意义。

### Q2: 为什么 CPU 路径会让 macOS 内核崩溃？

README 直接承认：`current macOS versions have a bug in the virtual memory implementation that will crash the kernel`。根本原因是 CPU 推理需要大量 intermediate buffer，当这些 buffer 加上已 mmap 的大型 GGUF 的总虚拟地址占用超过某个阈值时，macOS 的 VM 子系统会产生致命错误。目前已知无法在不重启机器的情况下修复，因此 macOS 上必须使用 Metal 路径。CPU 路径仅在 Linux 上安全使用（`make cpu`）。

### Q3: 2-bit 量化为什么够用？

DS4 采用极度不对称的量化策略：只对 MoE 路由专家的 up/gate 权重用 IQ2_XXS（2-bit），down 权重用 Q2_K（2-bit）。这些是参数量最多但每 token 只激活少量的权重（256 专家中只用 6 个）。其余所有参数——共享专家、attention 投影（Q/KV/O）、routing 权重、output norm、token embedding——保持 Q8_0 或 F16 精度。结果是质量足以支持编码 agent 工作流，在标准 benchmark 上与更高精度量化差距很小。2-bit 的 imatrix 版本效果更好，因为重要性矩阵指导了量化分布。

### Q4: 96 GB Mac 能跑吗？

可以。README 明确指出 q2-imatrix 版本在 96 GB Mac 上可运行，很多用户还报告了在 250k context window 下正常工作。Metal 后端在 unified memory 架构上直接使用系统 RAM 作为 GPU 内存，ds4 的 KV 缓存压缩设计也专门针对这种内存受限场景。128 GB Mac 推荐使用，512 GB Mac Studio 可以跑 q4-imatrix 获得更好质量。

### Q5: 磁盘 KV 缓存怎么启动？

```sh
./ds4-server -m ds4flash.gguf \
  --ctx 100000 \
  --kv-disk-dir /tmp/ds4-kv \
  --kv-disk-space-mb 8192
```

首次请求时，如果 prompt 超过 `min_tokens`（默认 512），服务器在 prefill 完成后保存 checkpoint。后续相同前缀的请求自动命中磁盘缓存，只需 prefill 新增的 suffix 部分。`--kv-disk-space-mb` 控制总磁盘预算，超出时按 LRU+hit 评分淘汰。

### Q6: 怎么开启 thinking 模式？

CLI：`./ds4 --think`（标准）或 `./ds4 --think-max --ctx 393216`（深度，需大 context）  
API：OpenAI 请求中设置 `"reasoning_effort": "high"` 或 `"thinking": {"type":"enabled","budget_tokens":N}`；Anthropic 请求中使用标准 `thinking` 参数。服务器默认 think mode 可由 `--think` / `--nothink` 启动参数控制。

### Q7: Metal 和 CUDA 哪个快？

在相应的硬件上各有优势。M3 Max（128 GB）上 q2 greedy 解码约 26 t/s，M3 Ultra（512 GB）约 37 t/s，DGX Spark（128 GB GB10 CUDA）约 14 t/s（但 prefill 更快：343 t/s vs 250 t/s）。DGX Spark 的解码速度受带宽限制，而 Mac 的 unified memory 带宽在这个模型大小上更有优势。Metal 是主要开发和测试目标，CUDA 针对 DGX Spark 优化。

### Q8: 多客户端（Codex + Claude Code + Pi）能同时使用吗？

可以，但服务器只有一个 Metal session，每次只能服务一个请求（排队执行）。多客户端切换时，live KV 会被新 session 替换，旧 session 保存到磁盘，切回时从磁盘恢复（需要一次磁盘读取 + suffix prefill）。`--trace /tmp/trace.txt` 会记录每次请求的缓存命中状况，方便诊断切换开销。

### Q9: 为什么 tool call id 需要服务器端 tool memory？

DSML 是模型输出的原始格式。当客户端在后续请求中重放工具调用历史时，它发送的是从 DSML 解析出的 JSON，而 JSON 的键顺序和空白格式可能与原始 DSML 不同。如果重新渲染 JSON → DSML，生成的 token 序列与原始 DSML 不同，导致 KV 缓存前缀失配，触发不必要的 prefill。tool memory 记录原始 DSML 文本，通过 tool id 查找后逐字节重放，确保 token 序列与 live KV 完全对齐。

### Q10: server 进程崩溃或重启后，agent 会话能恢复吗？

可以（需要 `--kv-disk-dir`）。进程关闭时，live session 以 `reason=shutdown` 保存到磁盘。重启后，新请求的文本前缀匹配会找到对应的 `.kvc` 文件，恢复 KV 状态，只需 prefill 新增内容。对于 Responses API，磁盘文件用 visible transcript 作为 key，Codex session 可以跨进程重启继续。

### Q11: 为什么不支持 previous_response_id 或 conversation？

Responses API 的 `previous_response_id` 和 `conversation` 需要服务器端持久化的 response 对象存储，ds4 目前没有实现这一层（只有 KV 快照存储，没有 response 元数据存储）。发送非 null 的这两个字段会返回 HTTP 400，建议客户端用完整 input 列表实现 stateless 多轮。

### Q12: 如何验证模型推理的正确性？

ds4 内置了针对官方 DeepSeek V4 Flash 输出向量的验证测试（`tests/test-vectors/`）。运行 `make test`（需要模型和 Metal）会执行 logit 回归测试，确保不同上下文长度下的 token 预测与官方实现一致。`--head-test`、`--first-token-test`、`--metal-graph-test` 等 flag 提供更轻量的 smoke test。

---

## Part 3: 调试与开发速查

### 环境变量

| 变量名 | 作用 | 位置 |
|---|---|---|
| `DS4_MTP_SPEC_DISABLE` | 禁用 MTP 推测解码（即使已加载 MTP 模型） | `ds4_server.c:10903` |
| `DS4_THREADS` | 覆盖 CPU 推理线程数 | `ds4.c:689` |
| `DS4_CUDA_WEIGHT_PRELOAD_SPAN_MB` | CUDA 权重预加载块大小 | `ds4.c:1364` |
| `DS4_CUDA_DIRECT_MODEL` | CUDA 直接模型路径 | `ds4.c:1429` |
| `DS4_CUDA_Q8_F16_PRELOAD` / `DS4_CUDA_Q8_F32_PRELOAD` | CUDA 预加载 Q8 权重精度 | `ds4.c:1436` |
| `DS4_DECODE_PROFILE_DETAIL` | 解码阶段详细 profile | `ds4.c:5670` |
| `DS4_PREFILL_PROFILE_DETAIL` | prefill 阶段详细 profile | `ds4.c:5981` |
| `DS4_PREFILL_PROFILE_TOKEN` | per-token prefill profile | `ds4.c:7499` |
| `DS4_ROUTED_TOKEN_PARALLEL` | 强制并行路由 token | `ds4.c:5997` |
| `DS4_NO_ROUTED_TOKEN_PARALLEL` | 禁用并行路由 token | `ds4.c:5998` |
| `DS4_METAL_PREFILL_CHUNK` | 覆盖 Metal prefill chunk 大小 | `ds4.c:6188` |
| `DS4_PARALLEL_ATTN_ROWS` | 强制并行 attention rows | `ds4.c:7270` |
| `DS4_NO_PARALLEL_ATTN_ROWS` | 禁用并行 attention rows | `ds4.c:7273` |
| `DS4_BATCHED_ROPE_MAX` | 批处理 RoPE 最大 token 数 | `ds4.c:7280` |
| `DS4_NO_BATCHED_ROPE` | 禁用批处理 RoPE | `ds4.c:7287` |
| `DS4_PREFILL_BATCH` | 覆盖 prefill 批大小 | `ds4.c:7783` |
| `DS4_BATCHED_FFN` | 启用批量 FFN | `ds4.c:7780` |
| `DS4_PARALLEL_FFN` | 启用并行 FFN | `ds4.c:7781` |
| `DS4_NO_SHARED_BATCH_FFN` | 禁用共享专家批量 FFN | `ds4.c:7782` |
| `DS4_METAL_GRAPH_DUMP_PREFIX` | 导出 Metal 图中间结果的文件前缀 | `ds4.c:8585` |
| `DS4_METAL_GRAPH_DUMP_NAME` / `DS4_METAL_GRAPH_DUMP_LAYER` / `DS4_METAL_GRAPH_DUMP_POS` | 精细控制图 dump | `ds4.c:8588` |
| `DS4_METAL_DECODE_STAGE_PROFILE` | Metal decode 阶段 stage profile | `ds4.c:9248` |
| `DS4_METAL_INDEXER_STAGE_PROFILE` | Metal indexer stage profile | `ds4.c:9401` |
| `DS4_METAL_LAYER_STAGE_PROFILE` | Metal layer stage profile | `ds4.c:11173` |
| `DS4_METAL_Q_STAGE_PROFILE` | Metal Q projection stage profile | `ds4.c:11174` |
| `DS4_METAL_GRAPH_TOKEN_PROFILE` | Metal 完整 token graph profile | `ds4.c:12783` |
| `DS4_METAL_GRAPH_PREFILL_PROFILE` | Metal prefill graph profile | `ds4.c:13248` |
| `DS4_METAL_GRAPH_PREFILL_SPLIT_PROFILE` | Metal prefill split profile | `ds4.c:13240` |
| `DS4_METAL_GRAPH_OUTPUT_ROW` | 覆盖 Metal graph 输出行号 | `ds4.c:13278` |
| `DS4_METAL_GRAPH_TRACE_LAYERS` | trace Metal 图层执行 | `ds4.c:10682` |
| `DS4_METAL_GRAPH_TEACHER_FORCE` | Metal teacher forcing 调试 | `ds4.c:10685` |
| `DS4_METAL_GPU_BATCH_EMBED_MIN` | GPU batch embed 最小 token 数 | `ds4.c:11017` |
| `DS4_METAL_NO_PREFILL_KERNEL_WARMUP` | 禁用 prefill kernel warmup | `ds4.c:11050` |
| `DS4_METAL_GRAPH_TOKEN_SPLIT_LAYERS` | Metal token graph 层分割 | `ds4.c:10842` |
| `DS4_METAL_DISABLE_SHARED_GATE_UP_SWIGLU_FUSION` | 禁用共享专家 gate+up SwiGLU 融合 | `ds4.c:9892` |

### 构建命令

```sh
# 主构建目标
make                    # macOS Metal（默认）
make cuda-spark         # Linux CUDA，DGX Spark / GB10
make cuda-generic       # Linux CUDA，通用 GPU
make cpu                # CPU 仅推理（Linux 安全，macOS 危险）

# 测试构建
make ds4_test           # 编译单元测试 runner
make test               # 构建 + 运行测试（需要模型和 Metal）

# 服务器
make ds4-server         # 仅编译服务器（快速检查编译）
```

### CLI 主要 Flag

```sh
# 基础
./ds4 -m MODEL.gguf -p "prompt text"      # 单次推理
./ds4 -m MODEL.gguf                       # 交互式 REPL
./ds4 -m MODEL.gguf --prompt-file FILE    # 从文件读取 prompt
./ds4 --ctx 65536                         # 设置 context window

# 推理模式
./ds4 --think                             # 标准 thinking 模式
./ds4 --think-max --ctx 393216            # 最大 thinking 模式
./ds4 --nothink                           # 关闭 thinking

# MTP 推测解码（仅 greedy）
./ds4 --mtp mtp.gguf --mtp-draft 2 --mtp-margin 0.5

# 诊断
./ds4 --dump-tokens -p "text"             # 显示 tokenization 结果
./ds4 --inspect                           # 显示模型信息
./ds4 --head-test -p "text"              # logit head smoke test
./ds4 --first-token-test -p "text"       # 第一个 token 生成测试
./ds4 --metal-graph-test -p "text"       # Metal 图执行测试（全图）
./ds4 --metal-graph-full-test -p "text"  # 完整 Metal 图验证测试
./ds4 --mtp --mtp-draft 2                # MTP 推测解码调试

# 质量
./ds4 --quality                          # 启用高精度量化路径
```

### ds4-server 主要 Flag

```sh
./ds4-server \
  -m MODEL.gguf \                        # 模型路径（默认 ./ds4flash.gguf）
  --ctx 100000 \                         # context window
  --port 8080 \                          # 监听端口（默认 8080）
  --cors \                               # 启用 CORS（默认关闭）
  --chdir /path/to/ds4 \                 # 工作目录（用于 metal/*.metal 路径解析）
  --kv-disk-dir /tmp/ds4-kv \            # 磁盘 KV 缓存目录
  --kv-disk-space-mb 8192 \              # 磁盘缓存预算 MiB
  --think \                              # 默认 thinking 模式
  --nothink \                            # 默认关闭 thinking
  --mtp mtp.gguf --mtp-draft 2 \         # MTP 推测解码
  --trace /tmp/ds4-trace.txt \           # 会话 trace 日志
  --no-exact-dsml-replay \               # 禁用 DSML 精确重放（调试用）
  --tool-memory-max-ids N \              # 工具内存最大 ID 数
  --kv-cache-reject-different-quant      # 拒绝跨量化版本复用 KV 缓存
```

### 测试命令

```sh
# 单元测试
make ds4_test
./ds4_test                          # 全部单元测试
./ds4_test --server                 # 仅服务器相关单元测试

# ASAN 构建调试
make -f Makefile CFLAGS="-fsanitize=address,undefined" ds4_test
./ds4_test --server                 # 地址/UB 检查

# 回归测试（需要模型和 Metal）
make test                           # 内置 token logit 向量验证

# 服务器 smoke test
curl -s http://localhost:8080/v1/models | jq
curl -s http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"ds4","messages":[{"role":"user","content":"Hello"}],"stream":false}'
```

### ds4-bench 使用

```sh
./ds4-bench \
  -m ds4flash.gguf \
  --prompt-file speed-bench/promessi_sposi.txt \
  --ctx-start 2048 \
  --ctx-max 65536 \
  --step-incr 2048 \
  --gen-tokens 128
```

输出 CSV：每行 frontier token 数 / prefill t/s / decode t/s / kvcache_bytes。

### ds4-eval 质量评估

```sh
./ds4-eval -m ds4flash.gguf --trace /tmp/ds4-eval.txt
# 92 题：25 GPQA Diamond + 25 SuperGPQA + 25 AIME 2025 + 17 COMPSEC
# 按 p 暂停，q 退出，方向键选题，Enter 运行选题
```

### trace 诊断关键字

查找 trace 文件时的常用关键词：

| 关键词 | 含义 |
|---|---|
| `cache_source: memory-token` | 精确 token 前缀命中 |
| `cache_source: memory-text` | rendered text 前缀命中（live KV） |
| `cache_source: responses-visible` | Responses visible transcript 命中 |
| `cache_source: responses-tool-output` | Responses tool-output-only 命中 |
| `cache_source: anthropic-tool-output` | Anthropic live tool 命中 |
| `cache_source: thinking-visible` | thinking visible 前缀命中 |
| `kv cache hit text` | 磁盘 KV 缓存命中 |
| `canonicalization needs rebuild` | 工具 checkpoint 需要重建（应尽量避免） |
| `tool replay: mem=N disk=M` | tool memory 重放统计 |
| `thinking live checkpoint remembered` | thinking visible key 已保存 |
