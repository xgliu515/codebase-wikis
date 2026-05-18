# Trace 导览总览 —— 跟一次最简推理穿过 llama.cpp 全栈

这一份导览是整个 wiki 的"第一遍学习路线"。它不按子系统罗列知识,而是**盯住一个具体到不能再小的请求**,跟着它从命令行参数一路走到屏幕上吐出的第一个汉字,中间经过的每一层都停下来问一句:这一步要解决什么问题?为什么不能用最朴素的办法?llama.cpp 实际是怎么做的?

读完 17 步,你会对 llama.cpp 的控制流有一条完整的、不断裂的心智链条。之后再去翻 14 章参考手册,每一章都能挂到这条链条的某个环节上。

---

## 我们跟踪的请求

整个导览跟踪 `examples/simple/simple.cpp` 这个示例程序的一次运行。它是 llama.cpp 仓库里最短的、能完整跑通"加载模型 → 生成文本"的程序,只有 223 行(`examples/simple/simple.cpp:1`),不依赖 `common/`,直接调用 libllama 的公共 API。把它想象成这样一条命令:

```text
llama-simple -m qwen2.5-0.5b.gguf -n 4 "你好"
```

- `-m qwen2.5-0.5b.gguf` —— 一个小到能在任何笔记本上秒加载的模型(Qwen2.5-0.5B)
- `-n 4` —— 只生成 4 个 token,够看清解码循环转几圈就行
- `"你好"` —— prompt 短到分词后只有 1-2 个 token

为什么选它,而不是 `llama-cli` 或 `llama-server`?

- **最小复杂度**:没有聊天模板、没有 slot 调度、没有连续批处理、没有交互循环。这些都是 `common/` 和 `tools/` 叠上去的东西(见[第 11 章](11-common-and-chat.md)、[第 12 章](12-cli-and-server.md)),会淹没主干。
- **真实可跑**:`simple.cpp` 是仓库自带、CI 会编译的真实程序,不是"假设有这么个调用"。
- **穿透每一层**:它真实地碰到了动态后端加载、GGUF 解析、mmap、分词、上下文创建、KV 缓存、计算图构建、后端调度、采样、detokenize —— 一层都没跳过。

`simple.cpp` 的主体可以浓缩成这几行(对照 `examples/simple/simple.cpp:80`-`220`):

```cpp
ggml_backend_load_all();                                          // 步骤 01
llama_model * model = llama_model_load_from_file(path, mparams);   // 步骤 02-04
const llama_vocab * vocab = llama_model_get_vocab(model);
int n_prompt = -llama_tokenize(vocab, prompt, ...);                // 步骤 09
std::vector<llama_token> prompt_tokens(n_prompt);
llama_tokenize(vocab, prompt, prompt_tokens.data(), ...);          // 步骤 09
llama_context * ctx = llama_init_from_model(model, cparams);       // 步骤 05-07
llama_sampler * smpl = llama_sampler_chain_init(sparams);          // 步骤 08
llama_sampler_chain_add(smpl, llama_sampler_init_greedy());        // 步骤 08
llama_batch batch = llama_batch_get_one(prompt_tokens.data(), n);  // 步骤 10
for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict; ) {
    llama_decode(ctx, batch);                                      // 步骤 11-14
    n_pos += batch.n_tokens;
    llama_token id = llama_sampler_sample(smpl, ctx, -1);          // 步骤 15
    if (llama_vocab_is_eog(vocab, id)) break;                      // 步骤 17
    char buf[128];
    llama_token_to_piece(vocab, id, buf, ...);                     // 步骤 16
    batch = llama_batch_get_one(&id, 1);                           // 步骤 16
}
```

导览的 17 个步骤就是把这十几行代码每一个调用拆开,钻进 libllama、ggml、后端层里看它到底做了什么。

---

## 每一步都按这 8 段写

trace 导览的每一步都是固定的 8 段结构。这个结构的用意是:让每一个设计决策读起来都像是"一个真实问题的必然结果",而不是凭空抛给你的结论。

| 段 | 标题 | 作用 |
|----|------|------|
| 1 | 当前情境 | 把你的位置锚定在 trace 的某个点上:刚发生了什么、现在数据结构长什么样 |
| 2 | 问题 | 这一步必须解决的具体需求,带上"做不到会怎样"的代价 |
| 3 | 朴素思路 | 直觉上你会怎么做 —— 而且这个想法得是合理的 |
| 4 | 为什么朴素思路会崩 | 具体的失败方式,不是"慢",而是"为什么慢、慢多少、哪里崩" |
| 5 | llama.cpp 的做法 | 此时真正的设计读起来像是水到渠成的解法 |
| 6 | 代码位置 | 按阅读顺序给出的 `file:line` 引用 |
| 7 | 分支与延伸 | 链接到参考手册各章,这一步是知识网络层 |
| 8 | 走完这一步你脑子里应该多了什么 | 3-5 条明确的新知识点 |

建议第一遍**顺序读完 01 → 17**,不要跳。每一步的"上一步终态"都接着上一步的"下一步起点",跳着读会断链。

---

## 17 步速览

导览分成 6 个阶段,对应一次推理请求的生命周期。

### 阶段 A:进程启动与模型加载(步骤 01-04)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [01](tour-01-backend-load.md) | 加载动态后端 | `ggml_backend_load_all` 在运行时扫描并注册 CPU/Metal/CUDA 后端 |
| [02](tour-02-open-gguf.md) | 打开 GGUF 文件 | 读 magic、解析元数据键值、建立张量名到偏移的索引 |
| [03](tour-03-tensor-mmap.md) | mmap 权重进内存 | 把几百 MB 权重映射进地址空间,零拷贝填充 `ggml_tensor` |
| [04](tour-04-arch-detect.md) | 识别模型架构 | 从元数据判定 `llm_arch`、填充 `hparams`、决定层数与维度 |

### 阶段 B:上下文与运行期资源(步骤 05-08)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [05](tour-05-create-context.md) | 创建推理上下文 | `llama_init_from_model` 算 `n_ctx`、建后端实例、准备 scheduler |
| [06](tour-06-kv-alloc.md) | 分配 KV 缓存 | 按上下文长度 × 层数预留 K/V 张量,准备 cell 槽位 |
| [07](tour-07-graph-reserve.md) | 预留计算图与调度器 | 用最大尺寸 dry-run 一遍图,定下显存峰值并固化分配 |
| [08](tour-08-sampler-init.md) | 初始化采样器链 | `llama_sampler_chain` + greedy:确定怎么从 logits 选 token |

### 阶段 C:输入处理(步骤 09-10)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [09](tour-09-tokenize.md) | 把 prompt 切成 token | `llama_tokenize`:"你好" 经词表变成整数 id 序列 |
| [10](tour-10-batch.md) | 构造 llama_batch | `llama_batch_get_one`:token 序列包装成一次 decode 的输入 |

### 阶段 D:一次前向计算(步骤 11-14)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [11](tour-11-decode-entry.md) | 进入 llama_decode | 校验 batch、拆 ubatch、为这批 token 找 KV 槽位 |
| [12](tour-12-graph-build.md) | 构建本次的计算图 | `llm_graph_context` 按 ubatch 拼出 embed→层→输出的算子图 |
| [13](tour-13-backend-compute.md) | 后端执行前向计算 | backend scheduler 把图派给 CPU/GPU,跑注意力与 FFN |
| [14](tour-14-logits.md) | 取出 logits | 从输出张量拷回 logits,得到下一 token 的概率分布原料 |

### 阶段 E:产出 token(步骤 15-16)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [15](tour-15-sample.md) | 采样下一个 token | `llama_sampler_sample`:greedy 取 argmax 选出 `new_token_id` |
| [16](tour-16-detokenize-loop.md) | 解码并进入下一轮 | `token_to_piece` 还原文字、写回 KV、把新 token 当下个 batch |

### 阶段 F:结束与收尾(步骤 17)

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [17](tour-17-eog-cleanup.md) | EOG 判定与收尾 | 判断生成结束、打印性能计数、释放 context 与 model |

---

## 状态演进表

下面这张表追踪几个关键状态量在 17 步里如何变化。每个写步骤的人都靠它确认自己的"输入"和"输出"。

| 步骤 | 关键状态变化 |
|------|--------------|
| 01 | `ggml_backend_reg` 全局表填好;可用后端(CPU、Metal…)登记完毕 |
| 02 | GGUF 文件头解析完;`gguf_context` 持有全部元数据键值 + 张量信息表 |
| 03 | 权重文件 mmap 进地址空间;`llama_model` 的每个 `ggml_tensor->data` 指向映射区 |
| 04 | `llm_arch` 确定;`llama_hparams` 全部字段填好(层数、维度、头数…) |
| 05 | `llama_context` 创建;`n_ctx`/`n_batch` 定下;backend scheduler 就位 |
| 06 | KV 缓存张量分配完毕;`n_ctx` 个 cell 槽位空着待用 |
| 07 | 计算图按最大尺寸 reserve 过一遍;计算缓冲显存峰值固化 |
| 08 | `llama_sampler_chain` 建好,内含一个 greedy 采样器 |
| 09 | "你好" → `prompt_tokens`(若干个 `llama_token` 整数) |
| 10 | `prompt_tokens` 包进 `llama_batch`;`batch.n_tokens` = prompt 长度 |
| 11 | batch 校验通过;拆成 1 个 `ubatch`;KV 槽位 `[0, n_prompt)` 分配给它 |
| 12 | 本次 ubatch 的 `ggml_cgraph` 拼好:embd→N 层→output |
| 13 | 图在后端上算完;输出张量里是 logits 的原始数值 |
| 14 | 最后一个位置的 logits 拷进 `ctx` 的输出缓冲,可被读取 |
| 15 | greedy 在 logits 上取 argmax,得到 `new_token_id` |
| 16 | token 转成文字片段打印;KV 缓存里多了 prefill 写入的 K/V;新 token 成为下一个 batch |
| 17 | 循环跑满 4 个 token 或遇 EOG 退出;性能计数打印;`ctx`/`model` 释放 |

注意步骤 11-16 在生成 4 个 token 的过程中会重复执行:第一次是 prefill(一次喂入整个 prompt),之后每次是 decode(一次喂入 1 个 token)。导览用第一次走完讲清楚,在步骤 16 说明后续几轮的差异。

---

## 每步链接到哪些参考章节

trace 导览是线性的主干;参考手册是可深入的支线。下表是它们的接线图。

| 步骤 | 主要关联章节 |
|------|--------------|
| 01 | [第 9 章 GGML 后端系统](09-ggml-backend.md) |
| 02 | [第 2 章 GGUF 与模型加载](02-gguf-and-model-loading.md) |
| 03 | [第 2 章](02-gguf-and-model-loading.md)、[第 4 章 GGML 张量](04-ggml-tensor-and-graph.md) |
| 04 | [第 3 章 模型架构与超参数](03-model-arch-and-hparams.md) |
| 05 | [第 7 章 上下文与批处理](07-context-and-batching.md) |
| 06 | [第 8 章 KV 缓存](08-kv-cache.md) |
| 07 | [第 4 章](04-ggml-tensor-and-graph.md)、[第 9 章](09-ggml-backend.md) |
| 08 | [第 10 章 采样](10-sampling.md) |
| 09 | [第 6 章 分词与词表](06-tokenization.md) |
| 10 | [第 7 章](07-context-and-batching.md) |
| 11 | [第 7 章](07-context-and-batching.md)、[第 8 章](08-kv-cache.md) |
| 12 | [第 5 章 计算图构建](05-graph-construction.md) |
| 13 | [第 9 章](09-ggml-backend.md)、[第 4 章](04-ggml-tensor-and-graph.md) |
| 14 | [第 7 章](07-context-and-batching.md) |
| 15 | [第 10 章 采样](10-sampling.md) |
| 16 | [第 6 章](06-tokenization.md)、[第 8 章](08-kv-cache.md) |
| 17 | [第 7 章](07-context-and-batching.md) |

读完导览后,推荐按 [第 1 章 系统架构总览](01-architecture-overview.md) 起步通读参考手册,把线性记忆补成网状理解。

---

准备好了就从 [步骤 01:加载动态后端](tour-01-backend-load.md) 开始。
