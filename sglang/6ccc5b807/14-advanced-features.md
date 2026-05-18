# 第 14 章 高级特性与模型网关

## 本章导读

前面 13 章覆盖了 SGLang 的主干。本章收拢若干**横切的高级特性**——它们不在主线 trace 上,但生产部署常常要用:LoRA、多模态、量化加载、function call、模型仓库,以及一个独立组件——Rust 写的模型网关。

## 1. LoRA:一个底座,多个适配器

LoRA(Low-Rank Adaptation)是主流的轻量微调方法:不改基座模型权重,只额外训练一组小的低秩矩阵(adapter)。一个基座 + 不同 adapter = 不同的「微调模型」。

SGLang 的 LoRA 支持让**同一个引擎同时挂多个 adapter**,而且**同一批请求里不同请求可以用不同 adapter**。代码在 `python/sglang/srt/lora/`:

- `lora_manager.py`:LoRA 总管,加载/卸载 adapter、维护注册表;
- `lora_registry.py`:adapter 注册表;
- `lora_config.py`:单个 adapter 的配置;
- `mem_pool.py`:adapter 权重的显存池——adapter 也要占显存,要池化管理;
- `layers.py`:LoRA 版本的层实现(在基座层的计算上叠加 adapter 的低秩项);
- `eviction_policy.py`、`lora_drainer.py`:adapter 不够显存时的淘汰;
- `backend/`、`triton_ops/`、`torch_ops/`:LoRA 计算的后端 kernel。

难点在「同一批不同 adapter」:一个 batch 里请求 A 用 adapter-1、请求 B 用 adapter-2,LoRA 层要能在一次批量计算里为不同请求套用不同的低秩矩阵。这就是 `lora/` 下那些专用 kernel 要解决的。请求通过 `Req.lora_id`(见 [第 05 章](05-request-data-structures.md))标明自己用哪个 adapter——`lora_id` 还会拼进前缀缓存的 `extra_key`,保证不同 adapter 的 KV 不会错误共享(见 [第 06 章](06-radix-cache.md))。

## 2. 多模态:图像/视频/音频进 LLM

多模态模型(VLM)的输入不只是文本,还有图片、视频、音频。SGLang 的多模态支持在 `python/sglang/srt/multimodal/`:

- `processors/`:各模型的多模态处理器——把原始图片/视频/音频转成模型能吃的形式;
- `mm_utils.py`:多模态工具;
- `audio_from_video.py`:从视频抽音频;
- `internvl_utils.py`、`evs/`:特定模型的处理逻辑;
- `vit_cuda_graph_runner.py`、`internvl_vit_cuda_graph_runner.py`:视觉编码器(ViT)的 CUDA graph。

核心流程:非文本内容先经各自的编码器(如 ViT 编码图片)变成 embedding,再和文本 token 的 embedding **拼接**成一个序列,后面就走和纯文本一样的 Transformer 前向。请求里的多模态数据由 `MultimodalDataItem`、`MultimodalInputs`(`schedule_batch.py:222`、`:416`)承载。多模态内容的缓存有专门的 `multimodal_cache.py`(在 `mem_cache/` 下)。

## 3. 模型加载与量化

[第 09 章](09-model-runner.md) 讲了 `model_loader` 怎么把权重灌进骨架。这里补充**量化**。

量化用更低的精度(FP8、FP4、INT4)存权重,显存占用大幅下降、访存也更快。SGLang 在加载时按量化方案解读权重:

- 加载器 `python/sglang/srt/model_loader/loader.py` 识别量化格式;
- 支持的格式包括 FP8、FP4、AWQ、GPTQ、Marlin 等;
- 量化的 GEMM kernel 在 `sgl-kernel/csrc/quantization/`、`sgl-kernel/csrc/gemm/`;
- `model_loader/ci_weight_validation.py` 做权重校验。

量化是「省显存/提速」和「精度」之间的权衡。不同量化方案的精度损失和速度收益不同,由 `server_args` 的量化参数选择。

## 4. 模型仓库:191 个架构怎么组织

`python/sglang/srt/models/` 下有 191 个文件,每个文件实现一个(或一族)模型架构——`llama.py`、`qwen3.py`、`deepseek_v2.py`、`mixtral.py`、`gemma3.py`、`gpt_oss.py` 等等。

组织方式:每个模型文件用 SGLang 的公共层(`RadixAttention`、各种 `Linear`、MoE 层、norm)搭出该架构的前向。`load_model` 靠 `config.json` 的 `architectures` 字段选中对应文件里的类(见 [第 09 章](09-model-runner.md))。

**新增一个模型**大致是:在 `models/` 下新建文件,用公共层实现该架构的 `forward`,实现权重命名映射,注册架构名。因为注意力、KV、采样、并行这些都由公共层和后端处理,模型文件只需专注「这个架构的层怎么连」。

## 5. Function call / 工具调用

function call 让模型输出「调用某个工具」的结构化指令。SGLang 在 `python/sglang/srt/function_call/` 支持它:

- `function_call_parser.py`:总解析器;
- `base_format_detector.py`、`core_types.py`:抽象基础;
- 一堆 `*_detector.py`(`deepseekv3_detector.py`、`gemma4_detector.py`、`glm4_moe_detector.py`、`qwen*_detector.py` 等):**每个模型家族的工具调用格式不同**——有的用特定 token、有的用特定 JSON 结构——所以每家一个 detector,从模型输出里把工具调用解析出来。

HTTP 层的 `/parse_function_call` 接口(见 [第 03 章](03-http-server.md))就是调这套。function call 常和约束解码(见 [第 11 章](11-sampling-constrained.md))配合,保证工具调用参数是合法结构。

## 6. 可观测性

生产部署要能看到引擎在干什么。`python/sglang/srt/observability/`:

- `metrics_collector.py`:指标收集,导出 Prometheus 格式;
- `forward_pass_metrics.py`:前向耗时等;
- `scheduler_metrics_mixin.py`:调度器指标(队列长度、运行请求数等);
- `req_time_stats.py`:单请求的各阶段耗时(API→调度→detokenize);
- `trace.py`:分布式 trace(对应 `Engine` 的 `enable_trace`,见 [第 04 章](04-engine-and-processes.md))。

这些指标让你能监控吞吐、延迟、KV 利用率、缓存命中率,定位瓶颈。

## 7. Rust 模型网关

仓库根的 `sgl-model-gateway/` 是一个**独立的组件**——用 **Rust** 写的高性能模型网关/路由器。`rust/sglang-grpc/` 是配套的 gRPC 服务,`proto/sglang/` 是 protobuf 定义。

它解决的是**单引擎之上一层**的问题:

- **多实例路由**:一个集群有多个 SGLang 引擎实例,网关把请求路由到合适的实例。关键策略是**缓存感知路由**——把「可能命中同一前缀」的请求尽量路由到同一个实例,放大 RadixAttention 的前缀复用收益;
- **负载均衡**:在实例间均衡负载;
- **限流、熔断**:保护后端实例;
- **多模型**:一个网关后面挂多个不同模型;
- **PD 分离编排**:在 prefill 集群和 decode 集群之间路由(见 [第 13 章](13-distributed.md))。

为什么用 Rust:网关在请求热路径上,要求极低延迟和高并发,Rust 没有 GIL、没有 GC 停顿,适合这种角色。`sgl-model-gateway/src/` 是它的实现,`bindings/` 提供和 Python 侧的绑定。

网关和 SGLang 引擎的关系:引擎(本 wiki 前 13 章的主体)是「单个推理实例」;网关是「实例集群的入口」。小规模部署直接用引擎的 HTTP 服务器即可;大规模多实例部署才需要网关。

## 8. 插件系统

`Engine.__init__` 一开始就调 `load_plugins()`(见 [第 04 章](04-engine-and-processes.md) 的 `engine.py:207`)。SGLang 的插件机制允许在不改主仓库代码的前提下,挂钩到 `ServerArgs` 构造等扩展点——私有 fork 可以借此注入自定义行为。`Engine` 的 `server_args_class`、`init_tokenizer_manager_func` 等可覆盖的类属性(`engine.py:194-197`)也是同一思路的扩展点。

## 相关章节

- [第 05 章 请求对象与核心数据结构](05-request-data-structures.md) —— `Req.lora_id`、多模态字段、PD 字段
- [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) —— LoRA 的 `extra_key` 隔离
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— 模型加载、量化
- [第 11 章 采样与约束解码](11-sampling-constrained.md) —— function call 与约束解码
- [第 13 章 分布式与并行执行](13-distributed.md) —— PD 分离、MoE
