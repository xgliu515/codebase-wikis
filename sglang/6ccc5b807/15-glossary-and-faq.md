# 第 15 章 术语表与 FAQ

本章是 wiki 的参考层:术语表帮你随时查一个概念的精确定义和代码位置;FAQ 回答常见疑问;速查附录列出环境变量与命令。术语表里的术语会被 wiki 阅读器自动识别,在其他章节里出现时加下划线、可点击弹出释义。

---

## Part 1:术语表

### accept length

- 英文原名:`accept_length`
- 中文译名:接受长度
- 定义:投机解码中,每个 verify 步平均产出的 token 数(论文里的 τ),含 bonus token。衡量投机解码收益的关键指标。
- 代码位置:`python/sglang/srt/speculative/` 下各 worker;指标随 `python/sglang/srt/managers/io_struct.py:85` 的 `SpeculativeDecodingMetricsMixin` 带回。

### accept rate

- 英文原名:`accept_rate`
- 中文译名:接受率
- 定义:投机解码中,每个草稿 token 被接受的概率(论文里的 α),不含 bonus token。
- 代码位置:`python/sglang/srt/speculative/eagle_worker.py:931` 的 `verify` 计算。

### AttentionBackend

- 英文原名:`AttentionBackend`
- 中文译名:注意力后端
- 定义:注意力计算的可插拔抽象接口。各硬件/模型有不同实现(FlashAttention、FlashInfer 等),通过统一接口被模型骨架调用。
- 代码位置:`python/sglang/srt/layers/attention/base_attn_backend.py:18`。

### BatchStrOutput

- 英文原名:`BatchStrOutput`
- 中文译名:批字符串输出
- 定义:DetokenizerManager 把 token id 转回文本后的输出对象,发回 TokenizerManager 交给用户。
- 代码位置:`python/sglang/srt/managers/io_struct.py:1145`。

### BatchTokenIDOutput

- 英文原名:`BatchTokenIDOutput`
- 中文译名:批 token ID 输出
- 定义:Scheduler 产出的输出对象,装新生成的 token id,经 ZMQ 发给 DetokenizerManager。
- 代码位置:`python/sglang/srt/managers/io_struct.py:1073`。

### bonus token

- 英文原名:`bonus_token`
- 中文译名:奖励 token
- 定义:投机解码中,目标模型在验证草稿时「顺带」正确产出的那个额外 token(verify 位置的下一个 token)。即使草稿全错也能拿到。
- 代码位置:`python/sglang/srt/speculative/eagle_worker.py:931`。

### chunked prefill

- 英文原名:`chunked prefill`
- 中文译名:分块预填充
- 定义:把超长 prompt 切成多块、分多批做 prefill 的机制,避免超长请求堵塞队列、避免大 prefill 卡住 decode。
- 代码位置:`python/sglang/srt/managers/scheduler.py:2514`(`chunked_req` 处理)。

### 连续批处理

- 英文原名:`continuous batching`
- 中文译名:连续批处理
- 定义:批不固定——请求随时加入(prefill 完 merge)、随时退出(结束后 filter),GPU 利用率远高于静态批处理。
- 代码位置:`python/sglang/srt/managers/scheduler.py:2535` 起的 merge 逻辑;`ScheduleBatch.merge_batch` / `filter_batch`。

### CUDA Graph

- 英文原名:`CUDA Graph`
- 中文译名:CUDA 图
- 定义:把一次前向涉及的几百个 CUDA kernel 录成一张图,运行时一次 replay 全部发射,消除 decode 的内核启动开销。
- 代码位置:`python/sglang/srt/model_executor/cuda_graph_runner.py:548`(`CudaGraphRunner`)。

### Data Parallelism (DP)

- 英文原名:`Data Parallelism`
- 中文译名:数据并行
- 定义:每张卡持有一份完整模型,分摊不同请求以提升吞吐。卡间基本独立。
- 代码位置:`python/sglang/srt/managers/data_parallel_controller.py`;`python/sglang/srt/distributed/parallel_state.py:1507`。

### decode

- 英文原名:`decode`
- 中文译名:解码阶段
- 定义:自回归生成阶段,每步只处理上一个生成的 token、产出 1 个新 token。显存带宽瓶颈。
- 代码位置:`python/sglang/srt/model_executor/model_runner.py:2955`(`forward_decode`);`ForwardMode.DECODE`(`forward_batch_info.py:83`)。

### DetokenizerManager

- 英文原名:`DetokenizerManager`
- 中文译名:反分词管理器
- 定义:独立子进程,把 Scheduler 产出的 token id 转回文本。
- 代码位置:`python/sglang/srt/managers/detokenizer_manager.py`。

### draft-verify

- 英文原名:`draft-verify`
- 中文译名:草稿-验证
- 定义:投机解码的核心范式——便宜地猜出多个草稿 token,目标模型一次前向并行验证,接受连续正确的前缀。
- 代码位置:`python/sglang/srt/speculative/eagle_worker.py:757`(`draft`)、`:931`(`verify`)。

### EAGLE

- 英文原名:`EAGLE`
- 中文译名:EAGLE 投机解码
- 定义:SGLang 主力投机解码方案,用轻量草稿头猜出树状候选 token,目标模型验证整棵树取最长合法路径。
- 代码位置:`python/sglang/srt/speculative/eagle_worker.py:91`(`EAGLEWorker`)。

### Engine

- 英文原名:`Engine`
- 中文译名:引擎
- 定义:SGLang 的离线推理入口类,封装三进程引擎,提供 `generate` 等方法。
- 代码位置:`python/sglang/srt/entrypoints/engine.py:178`。

### Expert Parallelism (EP)

- 英文原名:`Expert Parallelism`
- 中文译名:专家并行
- 定义:把 MoE 模型的专家分散到多卡,token 通过 all-to-all 通信路由到目标专家所在卡。
- 代码位置:`python/sglang/srt/distributed/parallel_state.py:1512`(`get_moe_ep_group`)。

### extend

- 英文原名:`extend` / `EXTEND`
- 中文译名:扩展(模式)
- 定义:SGLang 对 prefill 的内部叫法,指「在已有前缀后扩展若干新 token」,一次并行处理多个 token。
- 代码位置:`python/sglang/srt/model_executor/forward_batch_info.py:81`(`ForwardMode.EXTEND`)。

### FlashAttention

- 英文原名:`FlashAttention`
- 中文译名:FlashAttention
- 定义:IO 感知的注意力 kernel,在 SRAM 里分块做 fused softmax,不把注意力矩阵写回显存。SGLang 的主力通用注意力后端之一。
- 代码位置:`python/sglang/srt/layers/attention/flashattention_backend.py`。

### FlashInfer

- 英文原名:`FlashInfer`
- 中文译名:FlashInfer
- 定义:高度优化的注意力库,prefill/decode 均强,SGLang 的可选注意力后端。
- 代码位置:`python/sglang/srt/layers/attention/flashinfer_backend.py`。

### ForwardBatch

- 英文原名:`ForwardBatch`
- 中文译名:前向批
- 定义:执行层批对象,装 GPU 张量(input_ids/positions/KV 索引)和注意力元数据,由 ScheduleBatch 转换而来。
- 代码位置:`python/sglang/srt/model_executor/forward_batch_info.py`。

### ForwardMode

- 英文原名:`ForwardMode`
- 中文译名:前向模式
- 定义:标识一批前向的模式的枚举,主要取值 `EXTEND`(prefill)和 `DECODE`。
- 代码位置:`python/sglang/srt/model_executor/forward_batch_info.py:78`。

### GenerateReqInput

- 英文原名:`GenerateReqInput`
- 中文译名:生成请求输入
- 定义:用户面请求对象,装文本/input_ids、采样参数 dict、多模态数据等,是请求的第一个形态。
- 代码位置:`python/sglang/srt/managers/io_struct.py:135`。

### HiCache (Hierarchical Cache)

- 英文原名:`HiCache`
- 中文译名:分级缓存
- 定义:把冷的前缀 KV 从显存写出到主机内存(乃至磁盘/远端),命中时再搬回,突破单卡显存对缓存容量的限制。
- 代码位置:`python/sglang/srt/mem_cache/memory_pool_host.py`、`python/sglang/srt/mem_cache/hiradix_cache.py:68`。

### KVCache

- 英文原名:`KVCache`
- 中文译名:KV 缓存(存储层)
- 定义:KV 池存储层的抽象基类,定义 get/set KV buffer 接口;主流实现 `MHATokenToKVPool`。
- 代码位置:`python/sglang/srt/mem_cache/memory_pool.py:693`。

### LoRA

- 英文原名:`LoRA`
- 中文译名:低秩适配
- 定义:轻量微调方法,只额外训练低秩矩阵。SGLang 支持一个底座挂多个 adapter,同批不同请求用不同 adapter。
- 代码位置:`python/sglang/srt/lora/lora_manager.py`。

### match_prefix

- 英文原名:`match_prefix`
- 中文译名:前缀匹配
- 定义:在 radix tree 上查一个 token 序列的最长缓存前缀,命中部分的 KV 可直接复用。
- 代码位置:`python/sglang/srt/mem_cache/radix_cache.py:360`。

### max_total_num_tokens

- 英文原名:`max_total_num_tokens`
- 中文译名:KV 池总容量
- 定义:整个引擎在任意时刻最多能为多少个 token 存 KV,由 `mem_fraction_static` 与权重占用算出,是引擎的硬容量上限。
- 代码位置:`python/sglang/srt/model_executor/model_runner.py:2124`。

### mem_fraction_static

- 英文原名:`mem_fraction_static`
- 中文译名:静态显存占比
- 定义:用户参数,划定「权重 + KV 池」最多占 GPU 显存的比例,其余留给激活值、CUDA graph 等动态开销。
- 代码位置:`python/sglang/srt/model_executor/model_runner.py:333`、`:353`。

### MLA (Multi-head Latent Attention)

- 英文原名:`Multi-head Latent Attention`
- 中文译名:多头潜在注意力
- 定义:DeepSeek 系模型的注意力变体,把 KV 压缩成低维潜在表示,KV cache 显存占用大幅降低。
- 代码位置:`python/sglang/srt/layers/attention/flashmla_backend.py`、`flashinfer_mla_backend.py`。

### MoE (Mixture of Experts)

- 英文原名:`Mixture of Experts`
- 中文译名:混合专家
- 定义:每层含多个专家(小 FFN),每个 token 只激活其中几个的模型架构。专家参数量大,常配合专家并行。
- 代码位置:`sgl-kernel/csrc/moe/`;`python/sglang/srt/distributed/parallel_state.py:1512`。

### ModelRunner

- 英文原名:`ModelRunner`
- 中文译名:模型运行器
- 定义:执行层中枢,负责加载模型、把 ScheduleBatch 转 ForwardBatch、跑前向、采样、管 CUDA graph。
- 代码位置:`python/sglang/srt/model_executor/model_runner.py:327`。

### MTP (Multi-Token Prediction)

- 英文原名:`Multi-Token Prediction`
- 中文译名:多 token 预测
- 定义:模型自带的「一次预测多个 token」能力(如 DeepSeek 系),可作为投机解码的草稿来源。
- 代码位置:`python/sglang/srt/speculative/frozen_kv_mtp_worker.py`。

### N-gram 投机

- 英文原名:`N-gram speculative decoding`
- 中文译名:N-gram 投机解码
- 定义:零训练成本的投机方案,从已生成文本/语料里找匹配 n-gram,把其后续 token 当草稿。
- 代码位置:`python/sglang/srt/speculative/ngram_worker.py`。

### PD 分离

- 英文原名:`Prefill/Decode Disaggregation`
- 中文译名:预填充/解码分离
- 定义:把 prefill 和 decode 拆到不同 worker 集群运行,各自按算力/带宽特征优化,中间传输 KV cache。
- 代码位置:`python/sglang/srt/disaggregation/prefill.py`、`decode.py`。

### Pipeline Parallelism (PP)

- 英文原名:`Pipeline Parallelism`
- 中文译名:流水线并行
- 定义:把模型按层段切到多卡,各卡像流水线接力跑不同层段。
- 代码位置:`python/sglang/srt/distributed/parallel_state.py:1528`(`get_pp_group`)。

### prefill

- 英文原名:`prefill`
- 中文译名:预填充阶段
- 定义:把整个 prompt 一次性并行算出 KV 的阶段。算力瓶颈。SGLang 内部叫 `extend`。
- 代码位置:`python/sglang/srt/model_executor/model_runner.py:2991`(`forward_extend`)。

### RadixAttention

- 英文原名:`RadixAttention`
- 中文译名:基数注意力
- 定义:SGLang 标志性技术,用 radix tree 管理缓存的 KV 前缀,让共享前缀的请求复用已算好的 KV。
- 代码位置:`python/sglang/srt/layers/radix_attention.py:53`;`python/sglang/srt/mem_cache/radix_cache.py`。

### RadixCache

- 英文原名:`RadixCache`
- 中文译名:基数缓存
- 定义:RadixAttention 的逻辑层实现,一棵 radix tree,节点存 token 段与对应 KV 索引。
- 代码位置:`python/sglang/srt/mem_cache/radix_cache.py:269`。

### ReqToTokenPool

- 英文原名:`ReqToTokenPool`
- 中文译名:请求到 token 映射池
- 定义:二维映射表,记录每个请求的每个 token 对应 KV 池里的物理索引,实现逻辑序列与物理 KV 的解耦。
- 代码位置:`python/sglang/srt/mem_cache/memory_pool.py:128`。

### Req

- 英文原名:`Req`
- 中文译名:请求(调度器内部)
- 定义:调度器内部的请求状态机,装输入/输出 token、KV 索引、结束原因等,全程被调度器持有更新。
- 代码位置:`python/sglang/srt/managers/schedule_batch.py:571`。

### ScheduleBatch

- 英文原名:`ScheduleBatch`
- 中文译名:调度批
- 定义:调度层批对象(CPU 端),装 Req 列表和批元数据,支持 merge/filter 实现连续批处理。
- 代码位置:`python/sglang/srt/managers/schedule_batch.py:1371`。

### Scheduler

- 英文原名:`Scheduler`
- 中文译名:调度器
- 定义:运行在独立子进程的核心组件,跑事件循环:收请求、组批、跑前向、回结果。
- 代码位置:`python/sglang/srt/managers/scheduler.py:340`;`run_scheduler_process` 在 `:4029`。

### SchedulePolicy

- 英文原名:`SchedulePolicy`
- 中文译名:调度策略
- 定义:决定从 waiting_queue 挑哪些请求组 prefill 批的策略,分缓存感知(LPM 等)和缓存无关(FCFS 等)两类。
- 代码位置:`python/sglang/srt/managers/schedule_policy.py:140`。

### ServerArgs

- 英文原名:`ServerArgs`
- 中文译名:服务参数
- 定义:全系统的单一配置真相,一个含上百字段的 dataclass,`__post_init__` 做默认值填充、模型推断、交叉校验。
- 代码位置:`python/sglang/srt/server_args.py`。

### SamplingBatchInfo

- 英文原名:`SamplingBatchInfo`
- 中文译名:采样批信息
- 定义:把一批请求的采样参数打包成 GPU 张量的对象,带 `is_all_greedy` 标志以走快速路径。
- 代码位置:`python/sglang/srt/sampling/sampling_batch_info.py:23`。

### SamplingParams

- 英文原名:`SamplingParams`
- 中文译名:采样参数
- 定义:单个请求的采样配置,含 temperature/top_p/top_k/惩罚项/停止条件/约束解码字段。`temperature=0` 归一化为 `top_k=1`(贪心)。
- 代码位置:`python/sglang/srt/sampling/sampling_params.py:31`。

### SGLang DSL

- 英文原名:`SGLang DSL` / `frontend language`
- 中文译名:SGLang 前端语言
- 定义:用 `@sgl.function`、`sgl.gen`、`sgl.select` 等构件程序化编排 LLM 调用的领域特定语言。
- 代码位置:`python/sglang/lang/api.py`、`python/sglang/lang/ir.py`。

### SRT (SGLang Runtime)

- 英文原名:`SGLang Runtime`
- 中文译名:SGLang 运行时
- 定义:SGLang 的后端推理运行时,`python/sglang/srt/` 整个包,与前端语言协同设计。
- 代码位置:`python/sglang/srt/`。

### Tensor Parallelism (TP)

- 英文原名:`Tensor Parallelism`
- 中文译名:张量并行
- 定义:把每层的权重矩阵切到多卡,各算一部分、用 all-reduce 合并结果,使单卡放不下的模型可运行。
- 代码位置:`python/sglang/srt/distributed/parallel_state.py:1478`(`get_tp_group`)。

### TokenizerManager

- 英文原名:`TokenizerManager`
- 中文译名:分词管理器
- 定义:运行在主进程,负责把请求分词、收发请求,是离线 Engine 和 HTTP 服务器共用的组件。
- 代码位置:`python/sglang/srt/managers/tokenizer_manager.py`。

### TokenToKVPoolAllocator

- 英文原名:`TokenToKVPoolAllocator`
- 中文译名:KV 池分配器
- 定义:管理 KV 池空闲页的分配器,按 page 粒度 alloc/free。
- 代码位置:`python/sglang/srt/mem_cache/allocator.py:35`(基类)、`:121`(实现)。

### TreeNode

- 英文原名:`TreeNode`
- 中文译名:树节点
- 定义:radix tree 的节点,存一段 token 序列与对应的 KV 索引,带访问时间戳供淘汰策略使用。
- 代码位置:`python/sglang/srt/mem_cache/radix_cache.py:206`。

### xgrammar

- 英文原名:`XGrammar`
- 中文译名:XGrammar
- 定义:SGLang 默认的约束解码 grammar 后端,把 JSON schema/正则/EBNF 编译成状态机、产出 token mask。
- 代码位置:`python/sglang/srt/constrained/xgrammar_backend.py`。

### ZMQ IPC

- 英文原名:`ZMQ IPC`
- 中文译名:ZMQ 进程间通信
- 定义:SGLang 三个进程之间的通信机制,基于 ZeroMQ,端口由 `PortArgs` 分配。
- 代码位置:`python/sglang/srt/entrypoints/engine.py:766`(`PortArgs.init_new`)。

---

## Part 2:FAQ

### SGLang 的前端语言和后端运行时是什么关系?

它们是**协同设计**的两层。前端语言(SGLang DSL,`python/sglang/lang/`)让你程序化编排 LLM 调用;后端运行时(SRT,`python/sglang/srt/`)是实际执行推理的引擎。协同体现在:DSL 里的并行分支、共享前缀等结构,正好能被后端的 RadixAttention 前缀缓存高效复用。但两层也各自独立可用——只用 HTTP 服务器、不碰 DSL 完全可以。详见 [第 01 章](01-architecture-overview.md)、[第 02 章](02-frontend-language.md)。

### 为什么 Engine 要拆成三个进程?

因为 Python 的 GIL。分词、调度、detokenize 是三类性质不同的活,若放在一个进程的三个线程里,GIL 会让它们互相阻塞——分词时调度停摆,GPU 出现气泡。拆成 TokenizerManager(主进程)、Scheduler、DetokenizerManager 三个独立进程,各有独立 GIL,真正并行,靠 ZMQ 通信。见 `python/sglang/srt/entrypoints/engine.py:182` 的 docstring、[第 04 章](04-engine-and-processes.md)、[导览步骤 02](tour-02-launch-processes.md)。

### RadixAttention 和 vLLM 的 PagedAttention 有什么区别?

PagedAttention 解决的是**单请求内**的 KV 显存碎片(分页管理)。RadixAttention 在分页之上再进一步:用 radix tree 管理**跨请求**的 KV 前缀复用——多个请求共享的前缀,KV 只算一次、大家共用。SGLang 两者都有:分页见 `mem_cache/allocator.py`,radix tree 见 `mem_cache/radix_cache.py:269`。见 [第 06 章](06-radix-cache.md)、[第 07 章](07-kv-cache-memory.md)。

### 「零开销 CPU 调度器」指什么?

不是说 CPU 不干调度活,而是把 CPU 的调度活和 GPU 的前向活**完全重叠**。`event_loop_overlap`(`scheduler.py:1577`)把前向发射给 GPU 后不等结果,立刻去给下一批组批——CPU 组批的时间藏进 GPU 算前向的时间里,墙上时间从「CPU+GPU」变成「max(CPU,GPU)」。见 [第 08 章](08-scheduler.md)、[导览步骤 09](tour-09-scheduler-loop.md)。

### prefill 和 decode 有什么区别?chunked prefill 解决什么?

prefill 把整个 prompt 一次性并行算出 KV(整段已知,可并行,算力瓶颈);decode 逐 token 自回归生成(下一个 token 未知,只能串行,显存带宽瓶颈)。chunked prefill 把超长 prompt 切块分批做,避免超长请求堵塞队列、也避免一个大 prefill 长时间卡住 decode 请求。见 `model_runner.py:2991`/`2955`、[导览步骤 14/17](tour-00-overview.md)。

### KV cache 池大小怎么决定?

`max_total_num_tokens = (GPU总显存 × mem_fraction_static − 模型权重占用) ÷ 每token每层KV字节数`。在 `ModelRunner.init_memory_pool` 算出。池子启动时一次性预分配、运行中永不 resize。`mem_fraction_static` 要给激活值和 CUDA graph 留余量,否则运行时 OOM。见 [第 07 章](07-kv-cache-memory.md)、[导览步骤 04](tour-04-size-kv-pool.md)。

### 怎么给 SGLang 加一个新模型?

在 `python/sglang/srt/models/` 下新建文件,用 SGLang 公共层(`RadixAttention`、各种 `Linear`、MoE 层)实现该架构的前向,实现权重命名映射,注册架构名(对应 `config.json` 的 `architectures` 字段)。注意力、KV、采样、并行都由公共层和后端处理,模型文件只管「层怎么连」。见 [第 09 章](09-model-runner.md)、[第 14 章](14-advanced-features.md)。

### 怎么加一个新注意力后端?

在 `layers/attention/` 写一个继承 `AttentionBackend`(`base_attn_backend.py:18`)的类,实现 `init_forward_metadata`、`forward_extend`、`forward_decode` 等;在 `attention_registry.py` 用 `@register_attention_backend("名字")` 注册;启动时 `--attention-backend 名字` 选用。核心代码不用改。见 [第 10 章](10-attention-backends.md)。

### 投机解码什么时候有收益?

当 decode 是显存带宽瓶颈(batch 不大、模型大)且草稿命中率高(可预测内容多,如代码生成)时,一步赚多个 token,延迟明显下降。当 batch 已经很大、GPU 算力吃满,或草稿命中率低时,收益小甚至为负。SGLang 提供自适应机制。见 [第 12 章](12-speculative-decoding.md)。

### TP 和 DP 怎么选?

模型单卡装不下 → 用 TP(或 PP)拆模型,TP 因通信开销一般限单机多卡。模型装得下、想冲吞吐 → 用 DP,每卡一份完整模型分摊请求。两者可组合(如 TP=4 × DP=2)。见 [第 13 章](13-distributed.md)。

### 约束解码(JSON 输出)的原理是什么?

把「合法输出格式」(JSON schema/正则/EBNF)编译成状态机。每步采样前,状态机算出「当前状态下哪些 token 合法」,把不合法 token 的 logits 设为 -inf,概率清零,绝不会被采到。这样输出**一定**符合语法。grammar 后端见 `python/sglang/srt/constrained/xgrammar_backend.py`、[第 11 章](11-sampling-constrained.md)。

### PD 分离适合什么场景?

适合大规模在线 serving。prefill(算力瓶颈)和 decode(带宽瓶颈)资源特征相反,混跑会互相干扰。PD 分离用两组独立 worker 分别处理,各自按特征优化、独立扩缩容,代价是中间要传输 KV cache。小规模部署不必用。见 [第 13 章](13-distributed.md)。

### 离线 Engine 和 HTTP server 是什么关系?

两者共用同一个 `TokenizerManager` + 三进程引擎。区别只在最外层:离线 `Engine` 外层是 Python 类、`generate` 是方法;HTTP server 外层是 FastAPI、`generate` 被 HTTP 路由包着,且多一层 OpenAI 协议转换。核心引擎只有一个,入口可以有多种。见 [第 03 章](03-http-server.md)、[第 04 章](04-engine-and-processes.md)。

### temperature=0 是怎么实现贪心采样的?

`SamplingParams` 构造时(`sampling_params.py:113-116`),`temperature` 接近 0 会被归一化成 `temperature=1.0, top_k=1`。`top_k=1` 即「只在概率最高的 1 个 token 里选」,也就是 argmax。贪心因此不是独立代码路径,而是普通采样的特例,采样 kernel 无需为它写特判。见 [第 11 章](11-sampling-constrained.md)、[导览步骤 16](tour-16-sample-token.md)。

---

## Part 3:调试与开发速查

### 环境变量

SGLang 的环境变量大量以 `SGLANG_` 为前缀,集中定义见 `python/sglang/srt/environ.py`。常见的几个:

| 变量 | 作用 |
|------|------|
| `SGLANG_CACHE_DIR` / `SGLANG_CACHE_ROOT` | 缓存目录 |
| `SGLANG_BLOCK_NONZERO_RANK_CHILDREN` | 多节点时非零号节点子进程是否阻塞(Engine 作为 Python API 用时设 0) |
| `SGLANG_ALLOW_OVERWRITE_LONGER_CONTEXT_LEN` | 允许覆盖更长的上下文长度 |
| `SGLANG_AUTO_NUMA_BIND` | 自动 NUMA 绑定 |
| `SGLANG_CPU_OMP_THREADS_BIND` | CPU OMP 线程绑定 |
| `SGLANG_DEBUG_MEMORY_POOL` | 调试 KV 显存池 |
| `SGLANG_ENABLE_STRICT_MEM_CHECK_DURING_BUSY` | 忙时严格显存检查 |
| `SGLANG_CHUNKED_PREFIX_CACHE_THRESHOLD` | 分块前缀缓存阈值 |
| `SGLANG_CUDA_COREDUMP` / `SGLANG_CUDA_COREDUMP_DIR` | CUDA core dump |

完整列表以 `python/sglang/srt/environ.py` 为准。

### 常用命令

```bash
# 启动 HTTP 服务器
python -m sglang.launch_server --model-path meta-llama/Llama-3.2-1B-Instruct --port 30000

# 启动并指定张量并行
python -m sglang.launch_server --model-path <model> --tp-size 4

# 调小 KV 池占比(显存紧张时)
python -m sglang.launch_server --model-path <model> --mem-fraction-static 0.8

# 指定注意力后端
python -m sglang.launch_server --model-path <model> --attention-backend flashinfer

# 离线推理(Python)
python -c "from sglang import Engine; e=Engine(model_path='<model>'); print(e.generate('Hi', {'max_new_tokens': 8})['text'])"

# 吞吐 benchmark
python -m sglang.bench_serving --backend sglang --num-prompts 1000

# 单次前向 / 延迟 benchmark
python -m sglang.bench_one_batch --model-path <model> --batch-size 1 --input-len 128 --output-len 8
```

### 测试目录速查

| 目录 | 内容 |
|------|------|
| `test/srt/` | SRT 运行时的测试主体 |
| `test/lm_eval_configs/` | 模型质量评测配置 |
| `test/manual/` | 手动测试脚本 |
| `test/run_suite.py` | 测试套件入口 |
| `sgl-kernel/tests/` | 自定义 CUDA 算子测试 |
| `sgl-model-gateway/tests/` `e2e_test/` | Rust 模型网关测试 |

运行单个测试:`python -m pytest test/srt/test_xxx.py -v`。

## 相关章节

- [第 01 章 架构总览与核心概念](01-architecture-overview.md) —— 从全局重新理解这些术语的位置
- [导览总览](tour-00-overview.md) —— 跟着一个真实请求把术语串起来
