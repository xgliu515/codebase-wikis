# Trace 导览总览 —— 一次最小离线推理的全栈之旅

参考手册（第 01–15 章）是**按子系统**横切的：每章讲透一个模块。但读完 15 章，你脑子里仍然是 15 个孤岛——你知道 `Scheduler` 怎么组批，也知道 `RadixCache` 怎么匹配前缀，却不知道**一个真实请求是怎么从你的一行 Python 代码，一路穿过这些模块，最后变回一句话的**。

这份导览就是来补这条线的。我们挑一个**最小、真实、可运行**的用例，跟着它一步步走过 SGLang 的每一层，总共 18 步。每一步都用同一套「8 段模板」拆解，让每个设计决策都显得像是某个真实问题的**必然结果**，而不是凭空丢给你的结论。

---

## 被 trace 的代码

```python
from sglang import Engine

# 1. 起一个引擎，加载一个小模型（单卡、无并行、无量化）
engine = Engine(model_path="meta-llama/Llama-3.2-1B-Instruct")

# 2. 发一个请求，只生成 3 个 token
output = engine.generate(
    "The capital of France is",
    {"max_new_tokens": 3, "temperature": 0},
)

print(output["text"])   # ->  " Paris."
```

就这么两步。没有 HTTP，没有流式，没有张量并行，没有投机解码，没有约束解码，没有多模态。一个 1B 的小模型、一个短 prompt、`max_new_tokens=3`。

## 为什么挑这个 trace

设计 trace 目标时我们要求它同时满足四点，这个用例全中：

1. **复杂度最小**：单卡、`temperature=0`（贪心采样，连采样的随机性都省了）、3 个 token。任何高级特性都关掉——它们各自在参考手册里有独立章节，塞进主线只会让你看不清骨架。
2. **真实可跑**：这不是「假设有个请求」。把上面代码贴进装好 SGLang 的机器就能跑出 ` Paris.`。
3. **穿过每一层**：入口 → 分词 → 跨进程 IPC → 调度 → 前缀匹配 → KV 分配 → 前向 → 注意力内核 → 采样 → detokenize → 返回。少穿一层，那一层的 trace 步骤就是空的。
4. **输入尽量小**：短 prompt 让你能在脑子里逐 token 跟踪；`max_new_tokens=3` 让 decode 循环只转 3 圈，看得清「prefill→decode」这个最关键的状态切换。

`Engine` 是 SGLang 的**离线推理入口**（`python/sglang/srt/entrypoints/engine.py:178`）。HTTP 服务器（第 03 章）本质上只是在 `Engine` 外面包了一层 FastAPI——trace 完离线路径，HTTP 路径你自然就懂了。

---

## 8 段模板说明

导览的每一步（tour-01 到 tour-18）都严格按下面 8 段组织。这个结构的目的是：**让你先撞上问题，再看到答案**，而不是被动接收结论。

| # | 段名 | 它在帮你做什么 |
|---|------|----------------|
| 1 | 当前情境 | 把你「定位」到系统中的此刻——上一步刚结束，哪些数据结构现在长什么样 |
| 2 | 问题 | 立一个**具体的、有利害关系的**需求。没有它，后面的解释都像无源之水 |
| 3 | 朴素思路 | 激活你已有的直觉——「换我也会这么写」 |
| 4 | 为什么朴素思路会崩 | 给出**具体的**失败模式（不是「慢」，而是慢在哪、崩在哪、数字多大） |
| 5 | SGLang 的做法 | 此时真实设计读起来像是**水到渠成**，而不是空降的结论 |
| 6 | 代码位置 | 按「该读的顺序」列出 `file:line`，你可以照着翻源码验证 |
| 7 | 分支与延伸 | 链接回参考手册——这一步在高级场景下会怎么变 |
| 8 | 走完这一步你脑子里应该多了什么 | 3–5 条新知识，逼你显式说出学到了什么 |

---

## 18 步速览

导览分 6 个阶段，对应一次请求的生命周期。

### 阶段 A：初始化（请求到来之前，只做一次）

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [01](tour-01-engine-init.md) | Engine.__init__ 与 ServerArgs | 几十个参数怎么收敛成一份 `ServerArgs` |
| [02](tour-02-launch-processes.md) | 启动三个子进程 | 为什么要把 Tokenizer / Scheduler / Detokenizer 拆成独立进程 |
| [03](tour-03-load-weights.md) | 加载模型权重 | `ModelRunner` 怎么把几 GB 权重搬上 GPU |
| [04](tour-04-size-kv-pool.md) | 确定 KV cache 池大小 | 剩多少显存？能放下多少 token 的 KV |
| [05](tour-05-capture-cuda-graph.md) | 捕获 CUDA graph | 为常见 batch 形状预录前向图 |

### 阶段 B：请求进入

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [06](tour-06-generate-call.md) | Engine.generate() 与 GenerateReqInput | 你的字符串怎么变成一个标准请求对象 |
| [07](tour-07-tokenize.md) | TokenizerManager 分词 | 文本 → token id，并归一化采样参数 |
| [08](tour-08-enqueue.md) | ZMQ 发送与进入 waiting queue | 请求怎么跨进程飞到 Scheduler |

### 阶段 C：调度准备

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [09](tour-09-scheduler-loop.md) | Scheduler 事件循环 | 调度器主循环的「收-组-跑-回」四拍 |
| [10](tour-10-match-prefix.md) | RadixCache 前缀匹配 | 这个 prompt 有没有算过？复用已有 KV |
| [11](tour-11-alloc-kv.md) | 分配 KV 索引 | 给没命中的 token 划 KV 槽位 |
| [12](tour-12-build-batch.md) | 组建 prefill ScheduleBatch | 调度策略挑请求、拼成一个 prefill 批 |

### 阶段 D：执行

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [13](tour-13-forward-batch.md) | ScheduleBatch → ForwardBatch | CPU 调度数据转成 GPU 张量 |
| [14](tour-14-model-forward.md) | ModelRunner 前向（prefill） | 走一遍 Transformer，算出 logits |
| [15](tour-15-attention-kernel.md) | 注意力后端读 KV | 内核怎么按页读非连续 KV、写回新 KV |

### 阶段 E：产出

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [16](tour-16-sample-token.md) | 采样出第一个 token | logits → token id |
| [17](tour-17-decode-loop.md) | decode 单 token 循环 | 请求从 prefill 转 decode，逐 token 生成 |

### 阶段 F：收尾

| 步骤 | 标题 | 一句话 |
|------|------|--------|
| [18](tour-18-finish-return.md) | 结束判定、detokenize 与释放 | 命中停止条件、转回文本、释放 KV、交还用户 |

---

## 状态演化表

下表追踪几个关键状态在 18 步中的变化。每个写步骤的人都靠它确认自己的「输入」和「输出」对得上邻居。

| 步骤 | 关键状态变化 |
|------|--------------|
| 01 | `ServerArgs` 落地：模型路径、`mem_fraction_static`、attention backend 等全部确定 |
| 02 | 三个子进程起好，ZMQ socket 建好，进程间通道打通 |
| 03 | 模型权重已在 GPU 显存里；`ModelRunner` 就绪 |
| 04 | KV cache 池大小确定：`max_total_num_tokens` 算出，`ReqToTokenPool` / KV 池分配完毕 |
| 05 | 一组 batch size 的 CUDA graph 已捕获并缓存 |
| 06 | 用户字符串包成 `GenerateReqInput`，参数归一化 |
| 07 | prompt 变成 `input_ids`（约 6 个 token），打包为 `TokenizedGenerateReqInput` |
| 08 | 请求经 ZMQ 到达 Scheduler，进入 `waiting_queue` |
| 09 | Scheduler 主循环转起来，从队列里看到这个请求 |
| 10 | `match_prefix` 在 radix tree 上查命中（首次请求：命中 0） |
| 11 | 为未命中的 token 在 KV 池里分配出索引 |
| 12 | 请求被选入一个 prefill `ScheduleBatch` |
| 13 | `ScheduleBatch` 转成 `ForwardBatch`，注意力元数据建好 |
| 14 | 前向跑完，得到最后一个位置的 hidden state / logits |
| 15 | KV 写回 KV 池；注意力算出 attention 输出 |
| 16 | logits 经采样得到第 1 个生成 token（` Paris` 的 token） |
| 17 | 请求转入 decode 模式，再跑 2 步，得到 ` Paris.` 共 3 个 token |
| 18 | 命中 `max_new_tokens=3`，请求结束；KV 退回 radix tree / 释放；文本返回 |

---

## 与参考手册的交叉引用

每个 trace 步骤的第 7 段都会链接回参考手册深挖。下表是总览：

| 步骤 | 主要关联章节 |
|------|--------------|
| 01–02 | [第 04 章 Engine 与多进程编排](04-engine-and-processes.md) |
| 03 | [第 09 章 ModelRunner](09-model-runner.md)、[第 14 章 模型加载](14-advanced-features.md) |
| 04 | [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) |
| 05 | [第 09 章 ModelRunner §CUDA graph](09-model-runner.md) |
| 06 | [第 05 章 请求数据结构](05-request-data-structures.md) |
| 07 | [第 04 章 TokenizerManager](04-engine-and-processes.md)、[第 11 章 采样参数](11-sampling-constrained.md) |
| 08–09 | [第 08 章 调度器](08-scheduler.md) |
| 10 | [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) |
| 11 | [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) |
| 12 | [第 08 章 调度器 §调度策略](08-scheduler.md) |
| 13–14 | [第 09 章 ModelRunner](09-model-runner.md) |
| 15 | [第 10 章 注意力后端](10-attention-backends.md) |
| 16 | [第 11 章 采样与约束解码](11-sampling-constrained.md) |
| 17 | [第 08 章 调度器](08-scheduler.md)、[第 12 章 投机解码](12-speculative-decoding.md) |
| 18 | [第 06 章 前缀缓存淘汰](06-radix-cache.md)、[第 04 章 DetokenizerManager](04-engine-and-processes.md) |

---

准备好了就从 [步骤 01：Engine.__init__ 与 ServerArgs](tour-01-engine-init.md) 开始。
