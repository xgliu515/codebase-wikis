# Trace 导览 —— 总览

参考手册（15 章）是**按子系统横切**的：哪一章讲哪个模块。但第一次读一个推理引擎，
你真正想知道的是：**一条请求到底是怎么从命令行走到屏幕上那几个字的？**

这份导览就是干这件事。它挑一条**最简单的真实请求**，把它穿过整个 DwarfStar 4
的过程拆成 17 步，每一步用固定的 8 段模板讲清楚「为什么这里要这样设计」。

---

## 被 trace 的请求

```bash
./ds4 -m DS4.gguf -p "你好" -n 3
```

一句话：**加载 DeepSeek V4 Flash 模型，对提示词「你好」生成 3 个 token，打印出来。**

### 为什么挑这条

- **最小复杂度**：单条提示、3 个 token、不开 thinking、不走服务器、不带工具调用、
  不复用磁盘 KV 缓存。能砍的高级特性全砍掉。
- **真实可跑**：这就是 `README.md` 里给的第一条命令，不是假想场景。
- **穿过每一层**：CLI 解析 → GGUF 加载 → 分词 → 引擎/会话 → prefill 前向 →
  采样 → decode 循环 → 输出。每一层都真实执行到，没有空步骤。
- **输入足够小**：「你好」分词后只有个位数 token，prefill 一个 ubatch 就吃完，
  3 个 decode token 足以展示生成循环而不冗长。

凡是这条 trace 没走到的高级路径——服务器 API、工具调用、磁盘 KV 复用、
推测解码/MTP、thinking 模式——都在每步的「第 7 段 分支与延伸」里给出指针，
链到对应的参考章节。

---

## 8 段模板

导览的每一步（tour-01 ~ tour-17）都严格按这 8 段写。这个结构的目的，是让每个
设计决策都读起来像**一个真实问题的必然结果**，而不是凭空抛出的结论。

| # | 段落 | 作用 |
|---|------|------|
| 1 | 当前情境 | 你现在站在系统的哪个位置，刚发生了什么，数据结构长什么样 |
| 2 | 问题 | 这一步必须解决的具体需求，以及不解决的代价 |
| 3 | 朴素思路 | 直觉上你会怎么做——而且这个直觉是合理的 |
| 4 | 为什么朴素思路会崩 | 具体的失败模式，带数字，不是泛泛的「慢」 |
| 5 | DwarfStar 4 的做法 | 此时真实设计读起来已是「水到渠成」 |
| 6 | 代码位置 | `file:line` 引用，按推荐阅读顺序排列 |
| 7 | 分支与延伸 | 链到参考章节的知识网络 |
| 8 | 走完这一步你脑子里应该多了什么 | 3-5 条新知识 |

---

## 17 步速览

导览分 6 个阶段，对应一次请求的生命周期。

### 阶段 A：初始化（请求之前只做一次的事）

| 步 | 标题 | 一句话 |
|----|------|--------|
| [01](tour-01-cli-parse.md) | CLI 解析与后端选择 | 命令行参数解析成 `cli_config`，按平台选默认后端 |
| [02](tour-02-mmap-gguf.md) | 打开并 mmap GGUF | 一次 `mmap` 把几十 GiB 模型映射进地址空间，不拷贝 |
| [03](tour-03-validate-bind.md) | 校验张量与绑定层布局 | 校验每个张量的类型/形状，绑定进固定的 43 层布局 |
| [04](tour-04-load-tokenizer.md) | 加载分词器 | 从 GGUF 元数据读 token 字符串、special token、BPE merges |
| [05](tour-05-create-engine.md) | 创建引擎与图状态 | `ds4_engine_open` 返回，Metal 整模型图状态分配完成 |

### 阶段 B：请求进入

| 步 | 标题 | 一句话 |
|----|------|--------|
| [06](tour-06-render-prompt.md) | 渲染对话提示为 token | 「你好」包成 BOS + 用户消息 + assistant 前缀，再 BPE 编码 |
| [07](tour-07-create-session.md) | 创建会话并 sync | `ds4_session` 持有 KV 缓存；`session_sync` 判定要全量 prefill |

### 阶段 C：执行前准备

| 步 | 标题 | 一句话 |
|----|------|--------|
| [08](tour-08-prefill-setup.md) | Prefill 准备 | 选 prefill ubatch 大小，HC 多流状态从 token 嵌入种子 |
| [09](tour-09-prefill-layermajor.md) | 层主序 Prefill | 所有 prompt token 一起逐层推进，填 raw SWA 与压缩器状态 |

### 阶段 D：执行（prefill 前向）

| 步 | 标题 | 一句话 |
|----|------|--------|
| [10](tour-10-attention-sublayer.md) | 一层注意力 | 低秩 Q/KV 投影、仅尾部 RoPE、带 sink 的注意力 |
| [11](tour-11-ffn-moe.md) | 一层 FFN 与 MoE | HC pre、哈希路由 vs 偏置 top-k、IQ2_XXS 专家、共享专家 |
| [12](tour-12-ratio4-compressor.md) | ratio-4 层的压缩器与 indexer | 压缩窗口池化，indexer 选哪些压缩行进注意力 |

### 阶段 E：输出生产

| 步 | 标题 | 一句话 |
|----|------|--------|
| [13](tour-13-logits-head.md) | Prefill 末尾 logits head | HC collapse、输出 RMSNorm、Q8_0 词表投影得 logits |
| [14](tour-14-argmax-sample.md) | 采样首 token | 默认 min-p 过滤 + 采样，得到生成的第一个 token |
| [15](tour-15-decode-step.md) | 单步 decode | 单 token Metal 图，追加 raw SWA，流式更新压缩器 |
| [16](tour-16-decode-loop.md) | decode 循环到 n=3 | 重复 decode，检测 EOS 与停止条件 |

### 阶段 F：清理

| 步 | 标题 | 一句话 |
|----|------|--------|
| [17](tour-17-output-cleanup.md) | token 解码输出与清理 | token 转文本流式打印，释放 session 与 engine |

---

## 状态演化表

这张表记录关键状态在 17 步里怎么变。每个步骤的 agent / 读者用它确认依赖：
某一步需要的状态，必须是前面某一步产生的。

| 步 | 此步结束后新增/改变的状态 |
|----|--------------------------|
| 01 | `cli_config` 填好：模型路径、后端、`n_predict=3`、采样参数 |
| 02 | GGUF 文件 `mmap` 进地址空间；张量目录解析为绝对偏移 |
| 03 | 43 层张量指针全部绑定；模型超参（维度、专家数等）校验通过 |
| 04 | 词表、merge ranks、special token id 就绪 |
| 05 | `ds4_engine` 建好；Metal 整模型图与权重缓冲分配完成 |
| 06 | 「你好」→ `ds4_tokens` 序列（BOS + 文本 + assistant 前缀） |
| 07 | `ds4_session` 建好（持有空 KV 缓存）；`sync` 判定走全量 prefill |
| 08 | prefill ubatch 大小定下；HC 多流状态用 token 嵌入种子 |
| 09 | 所有 prompt token 走完全部 43 层；raw SWA + 压缩器状态填满 |
| 10 | （层内）注意力子层输出注入 HC 流 |
| 11 | （层内）FFN/MoE 输出注入 HC 流 |
| 12 | （层内）ratio-4 层压缩器状态推进，indexer 选择完成 |
| 13 | 最后一个 prompt token 的 logits 算出（vocab 维向量） |
| 14 | 采样得到第 1 个生成 token；`session.pos` +1 |
| 15 | 该 token 评估完毕，KV 缓存追加一行；下个 token 的 logits 就绪 |
| 16 | 循环到生成 3 个 token 或遇 EOS 提前停 |
| 17 | 3 个 token 转成文本打印；`session`/`engine` 释放 |

---

## 与参考手册的交叉引用

导览是线性的一条线；参考手册是按子系统铺开的面。每步的第 7 段把线织进面。
下表是总索引：

| 步 | 主要链接到的参考章节 |
|----|----------------------|
| 01 | [第 1 章 架构总览](01-architecture-overview.md)、[第 5 章](05-tokenizer-chat.md) |
| 02 | [第 3 章 GGUF 加载](03-gguf-loading.md) |
| 03 | [第 2 章 模型结构](02-model-architecture.md)、[第 3 章](03-gguf-loading.md)、[第 4 章 量化](04-quantization.md) |
| 04 | [第 5 章 分词器](05-tokenizer-chat.md) |
| 05 | [第 6 章 引擎与会话](06-engine-session.md)、[第 10 章 Metal](10-metal-backend.md) |
| 06 | [第 5 章 分词器与对话模板](05-tokenizer-chat.md) |
| 07 | [第 6 章 引擎与会话](06-engine-session.md)、[第 14 章 磁盘 KV](14-disk-kv-cache.md) |
| 08 | [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)、[第 10 章 Metal](10-metal-backend.md) |
| 09 | [第 6 章](06-engine-session.md)、[第 10 章 Metal](10-metal-backend.md) |
| 10 | [第 8 章 注意力子层](08-attention.md)、[第 7 章 KV 缓存](07-kv-cache.md) |
| 11 | [第 9 章 超连接与 MoE](09-moe-hyperconnections.md) |
| 12 | [第 7 章 KV 缓存](07-kv-cache.md) |
| 13 | [第 9 章](09-moe-hyperconnections.md)、[第 2 章 模型结构](02-model-architecture.md) |
| 14 | [第 6 章 引擎与会话](06-engine-session.md) |
| 15 | [第 10 章 Metal](10-metal-backend.md)、[第 7 章 KV 缓存](07-kv-cache.md) |
| 16 | [第 12 章 推测解码与 MTP](12-speculative-mtp.md) |
| 17 | [第 5 章](05-tokenizer-chat.md)、[第 1 章](01-architecture-overview.md) |

---

准备好了就从 [步骤 01 —— CLI 解析与后端选择](tour-01-cli-parse.md) 开始。
