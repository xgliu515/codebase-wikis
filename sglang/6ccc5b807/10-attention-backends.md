# 第 10 章 注意力后端与 CUDA 内核

## 本章导读

注意力是 Transformer 里最重、也最讲究实现的算子。LLM 推理性能的相当一部分,就压在「注意力算得多快」上。SGLang 没有把注意力实现写死——它做成**可插拔的后端**:FlashAttention、FlashInfer、FlashMLA…… 一个统一接口,多种实现,按硬件和模型选。

本章讲清这套后端机制:为什么要可插拔、统一接口长什么样、有哪些后端、注意力怎么对接分页 KV,以及底层的 sgl-kernel 自定义算子。代码主要在 `python/sglang/srt/layers/attention/` 和 `sgl-kernel/`。

## 1. 为什么注意力后端要可插拔

写死一个注意力实现,会在三个方向上碰壁:

1. **硬件多样**:NVIDIA Hopper、Blackwell、AMD、Intel、华为昇腾…… 各家 GPU 的最优注意力 kernel 不同。AMD 上跑得快的 kernel(aiter)在 NVIDIA 上未必能用。
2. **模型架构多样**:标准 MHA/GQA 用一种 kernel;DeepSeek 的 **MLA**(多头潜在注意力)把 KV 压缩了,需要专门的 MLA kernel;Mamba 这类线性注意力根本不是 softmax 注意力。
3. **场景多样**:prefill 和 decode 的注意力计算形状完全不同;投机解码的 verify 阶段又是另一种形状;长上下文有专门的 dual-chunk 方案。

如果注意力写死,每加一种硬件/模型/场景都要改核心代码。可插拔后端把「注意力怎么算」从「模型怎么搭」里解耦出来——模型骨架只管调一个统一接口,具体算法由后端提供。

## 2. 统一接口:`AttentionBackend`

所有后端都实现同一个抽象基类 `AttentionBackend`(`python/sglang/srt/layers/attention/base_attn_backend.py:18`)。核心方法:

| 方法 | 作用 |
|------|------|
| `init_forward_metadata(forward_batch)`(`:22`) | 前向前,准备这一批注意力需要的元数据(序列长度、KV 索引等) |
| `init_forward_metadata_capture_cuda_graph(...)`(`:30`) | CUDA graph 捕获时的元数据准备 |
| `init_forward_metadata_replay_cuda_graph(...)`(`:43`) | CUDA graph 重放时的元数据更新 |
| `forward_extend(...)`(`:147`) | prefill 模式的注意力计算 |
| `forward_decode(...)`(`:134`) | decode 模式的注意力计算 |
| `forward(...)`(`:90`) | 总入口,按模式分派到 extend / decode |

注意 `forward_extend` 和 `forward_decode` 是分开的——和 [第 09 章](09-model-runner.md) 里 `ModelRunner` 的 extend/decode 分界对应。prefill 一次算多个 token 的注意力,decode 一次算 1 个,kernel 路径不同。

`init_forward_metadata` 系列方法的存在,是因为注意力 kernel 需要「导航信息」——每个请求的序列多长、它的 KV 在池子里的索引是什么。这些元数据每批都不同,且要和 CUDA graph 的捕获/重放配合,所以单独成一组方法。

## 3. 后端注册表

后端通过一张注册表登记。`python/sglang/srt/layers/attention/attention_registry.py:20` 定义了 `ATTENTION_BACKENDS` 字典,`register_attention_backend`(`:23`)是注册装饰器:

```python
# attention_registry.py:23, 31 (节选)
def register_attention_backend(name):
    def decorator(fn):
        ATTENTION_BACKENDS[name] = fn
        return fn
    return decorator

@register_attention_backend("flashinfer")
def create_flashinfer_backend(runner):
    ...
```

`ModelRunner.init_attention_backend`(`model_runner.py:2215`)根据 `server_args.attention_backend`(用户配置或自动推断)从注册表里查出对应的工厂函数,创建后端实例。加新后端 = 写一个类 + 注册一个名字,核心代码一行不用改。

## 4. 主要后端一览

`layers/attention/` 目录下的后端(部分):

| 后端文件 | 适用 |
|----------|------|
| `flashattention_backend.py` | FlashAttention,NVIDIA GPU 上的主力通用后端 |
| `flashinfer_backend.py` | FlashInfer,高度优化的注意力库,prefill/decode 均强 |
| `flashinfer_mla_backend.py` `flashmla_backend.py` | MLA 专用(DeepSeek 系模型) |
| `trtllm_mha_backend.py` `trtllm_mla_backend.py` | 基于 TensorRT-LLM kernel |
| `cutlass_mla_backend.py` | 基于 CUTLASS 的 MLA |
| `aiter_backend.py` | AMD GPU |
| `triton_backend.py` | Triton 实现,可移植性好 |
| `torch_native_backend.py` `torch_flex_backend.py` | 纯 PyTorch 实现,无需额外 kernel 库,适合调试/兜底 |
| `dual_chunk_flashattention_backend.py` | 超长上下文的双块注意力 |
| `nsa_backend.py` | 原生稀疏注意力 |
| `xpu_backend.py` `intel_amx_backend.py` `wave_backend.py` | Intel / 其他硬件 |

线性注意力 / 状态空间模型走专门的子目录:

- `layers/attention/mamba/`:Mamba 选择性状态空间模型——它没有传统 KV cache,维护的是循环状态;
- `layers/attention/linear/`、`fla/`:线性注意力(linear attention / FLA 架构);
- `hybrid_linear_attn_backend.py`、`hybrid_attn_backend.py`:混合架构(部分层 full attention、部分层线性/SWA)。

## 5. 注意力层:`RadixAttention`

模型骨架(`srt/models/` 下的文件)里,注意力子层用的是 `RadixAttention` 模块(`python/sglang/srt/layers/radix_attention.py:53`)。

它是模型骨架和注意力后端之间的**适配层**:模型骨架统一调 `RadixAttention.forward`(`radix_attention.py:105`),`RadixAttention` 再转调当前选定的后端。模型代码因此完全不需要知道底层用的是 FlashAttention 还是 FlashInfer——这正是可插拔的价值。

「RadixAttention」这个名字点出了它和前缀缓存的绑定:它对接的 KV 是分页的、可跨请求共享的(见 [第 06 章](06-radix-cache.md)、[第 07 章](07-kv-cache-memory.md))。`AttentionType`(`radix_attention.py:39`)区分不同的注意力类型(因果、双向等)。

## 6. 注意力怎么对接分页 KV

这是后端最关键的能力。回顾 [第 07 章](07-kv-cache-memory.md):KV 池是分页的,一个请求的 KV 散落在不连续的物理页上。注意力 kernel 必须能处理这种非连续布局。

后端的 kernel **不预先 gather**——它直接接受 `ReqToTokenPool` 那张索引表,在 kernel 内部按表去 KV 池取数据。`init_forward_metadata` 准备的就是这套「导航信息」:每个请求的 `seq_lens`、KV 索引、page table。

一层注意力做两件事:

1. **写新 KV**:这一层算出的 K/V,按 `out_cache_loc` 写进 KV 池(`KVCache.set_kv_buffer`,见 [第 07 章](07-kv-cache-memory.md));
2. **算注意力**:Query 通过索引表读历史 K/V(含命中前缀的复用 KV),做注意力。

FlashAttention 类 kernel 还会把 softmax 做 **fused**——在 SRAM 里分块累加,不把巨大的 `[seq, seq]` 注意力矩阵写回显存,省下大量显存带宽。「fused softmax」和「分页读 KV」是正交的两层优化。完整论证见 [导览步骤 15](tour-15-attention-kernel.md)。

## 7. sgl-kernel:自定义 CUDA 算子

光有 Python 层的后端不够——很多算子需要手写 CUDA 才能跑到最快。这些自定义算子在仓库根的 **`sgl-kernel/`** 目录,是一个独立编译的 C++/CUDA 扩展。

`sgl-kernel/csrc/` 下按算子类型分目录:

| 目录 | 算子 |
|------|------|
| `attention/` | 注意力相关 kernel |
| `gemm/` | 矩阵乘(含量化 GEMM) |
| `moe/` | 混合专家(MoE)的路由、专家计算 |
| `elementwise/` | 逐元素算子(激活、norm 等) |
| `quantization/` | 量化/反量化 |
| `speculative/` | 投机解码专用 kernel |
| `grammar/` | 约束解码相关 |
| `allreduce/` | 自定义 all-reduce 通信 |
| `moe/` `mamba/` `memory/` `kvcacheio/` | MoE、Mamba、显存、KV IO |

Python 侧通过编译好的扩展模块调用这些 kernel。把高频算子下沉到手写 CUDA,是 SGLang 性能的底座之一。注意力后端(如 FlashAttention/FlashMLA 后端)调用的就是 `sgl-kernel` 里或第三方库的 kernel。

## 8. 扩展点:如何加一个新注意力后端

1. 在 `layers/attention/` 新建 `xxx_backend.py`,实现一个继承 `AttentionBackend`(`base_attn_backend.py:18`)的类,填齐 `init_forward_metadata`、`forward_extend`、`forward_decode` 等方法;
2. 在 `attention_registry.py` 用 `@register_attention_backend("xxx")` 注册一个工厂函数;
3. 启动时通过 `--attention-backend xxx` 选用。

模型骨架、`RadixAttention`、`ModelRunner` 一律不用改——这就是注册表 + 统一接口的回报。

## 相关章节

- [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) —— 前缀复用的逻辑层
- [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) —— 注意力读写的 KV 池
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— `init_attention_backend`、前向调度
- [第 12 章 投机解码](12-speculative-decoding.md) —— verify 阶段的特殊注意力形状
- [导览步骤 15](tour-15-attention-kernel.md) —— 注意力读 KV 的实际 trace
