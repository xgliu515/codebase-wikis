# 单请求 Trace 导览

> 这是 vllm-wiki 的"第二层"——配合原有 12 章参考手册一起使用。
> 12 章告诉你"vllm 每个子系统是什么"；本导览告诉你"一个最简单的请求是怎么穿过这些子系统的"。
> 适合**第一次**学 vllm 的人按 01 → 17 顺序读一遍；之后再去翻参考手册时会发现每个细节都有了落脚点。

## Trace 目标

整个导览围绕**同一段代码**展开：

```python
from vllm import LLM, SamplingParams

llm = LLM("Qwen/Qwen2.5-7B-Instruct")              # ← 第 01-03 步
out = llm.generate(                                 # ← 第 04 步开始
    ["你好"],
    SamplingParams(max_tokens=3, temperature=0),    # 贪心 + 只生成 3 个 token
)
print(out[0].outputs[0].text)
```

**为什么挑这个**：
- **单 prompt、单 GPU、greedy、3 个 token**：把变量降到最低，每一步只剩本质
- 不开 TP、不开 spec decode、不开多模态、不开量化——所有"如果加了 X 怎么变"作为**分支链接**散出去，不污染主线
- 模型用 Qwen2.5-7B 是因为它够小能在单 24G 卡跑、又是标准 LLaMA-family，覆盖大多数模型族的共性结构

## 阅读方式

每一步都用**同一套 8 段模板**，是按你"problem-first → 推理链 → 知识网"的学习方式设计的：

| # | 段名 | 你应该读到什么 |
|---|------|--------------|
| 1 | 当前情境 | 我们走到了 trace 的哪儿，手里有什么 |
| 2 | 问题 | 这一步**要解决什么**——这就是"需求" |
| 3 | 朴素思路 | 直觉上你会怎么做 |
| 4 | 为什么朴素思路会崩 | 具体失败模式（不只是"性能差"这种泛泛说法） |
| 5 | vllm 的做法 | 在前面铺垫下，这个设计像是"显然的结论" |
| 6 | 代码位置 | `file:line` + 推荐阅读顺序 |
| 7 | 分支与延伸 | "如果加了 X 会怎样"——链接到 12 章参考手册对应小节 |
| 8 | 走完这一步你脑子里应该多了什么 | 1-4 条核心认知 |

如果某一步对应的部分有现成 mermaid / ASCII 图，就在第 5 段嵌进去。

## 全部 17 步速览

每行：**步号 / 标题 / 完成此步后系统状态的关键变化**。

### Phase A：LLM 构造（`LLM(...)` 内部）

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 01  | [KV cache 池能塞多少？](tour-01-kv-cache-sizing.md)           | num_gpu_blocks 已定，但池子还没分配                  |
| 02  | [CUDA graph 为什么 capture，怎么 capture？](tour-02-cudagraph-capture.md) | 多个 batch-size bucket 的 graph 已就绪               |
| 03  | [模型权重怎么从 HuggingFace 进到 vllm 的内部布局？](tour-03-weight-loading.md) | 模型在 GPU 上，KV cache 池已分配；`LLM(...)` 返回    |

### Phase B：请求入口（`llm.generate(...)` 开始）

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 04  | [`["你好"]` 怎么变成内部 Request 并入队？](tour-04-tokenize-and-enqueue.md) | 1 个 Request 在 EngineCore 的 waiting queue，状态 WAITING |
| 05  | [第一次 step：Scheduler 怎么决定先跑哪个？](tour-05-scheduler-prefill-decision.md) | Scheduler 决定本 step prefill 这一个 request 的所有 token |
| 06  | [KV cache manager 怎么分配 block 给这个 request？](tour-06-kv-allocation.md) | Request 有了 block table；池中对应 block 标记 in-use |

### Phase C：Worker 准备 forward

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 07  | [SchedulerOutput 怎么变成 GPU 上的 tensor batch？](tour-07-input-batch-assembly.md) | input_ids / positions / cu_seqlens / slot_mapping / block_table 都在 GPU 上 |
| 08  | [AttentionMetadata 是什么？为什么每个 backend 一份？](tour-08-attention-metadata.md) | metadata 构造完毕，CudagraphDispatcher 决定本次走什么 graph 模式 |

### Phase D：Prefill forward 内部

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 09  | [embedding + LlamaDecoderLayer 循环怎么走？](tour-09-embedding-and-layers.md) | 进入第 0 层 attention 之前所有准备就绪               |
| 10  | [一次 PagedAttention kernel 到底干了什么？](tour-10-paged-attention-kernel.md) | 第 0 层 attention 算完，KV 已写到物理 block；继续走完所有层 |
| 11  | [final norm + lm_head → logits](tour-11-layers-to-logits.md) | 最后一个位置的 vocab-size logits 在 GPU 上            |

### Phase E：第一个 token 产出

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 12  | [Sampler 为什么不是一个 `argmax`？](tour-12-sampler-greedy.md) | 1 个 new token id 生成                               |
| 13  | [新 token 怎么回到 EngineCore 并并入 request？](tour-13-token-back-to-engine.md) | Request 状态：已生成 1 token，停止条件未满足，状态从 prefill → decode |

### Phase F：进入 decode 阶段

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 14  | [第二次 step：continuous batching 在这里第一次发挥作用](tour-14-continuous-batching.md) | Scheduler 决定本 step decode 这一个 request 的 1 个 token |
| 15  | [decode forward 跟 prefill 哪里不一样？](tour-15-decode-forward.md) | 第 2 个 token 生成；CUDA graph 在 decode 这里通常命中 |

### Phase G：结束

| #   | 步骤                                          | 完成后系统状态                                        |
| --- | --------------------------------------------- | ----------------------------------------------------- |
| 16  | [max_tokens=3 命中：怎么停下来、KV cache 怎么回收？](tour-16-stop-and-cleanup.md) | Request 状态 FINISHED；KV blocks 引用计数减一，回到 free 队列（或保留供 prefix cache） |
| 17  | [token ids 怎么变回字符串、`llm.generate` 怎么返回？](tour-17-detokenize-and-return.md) | `out[0].outputs[0].text == "..."`；调用栈回到用户代码 |

## 状态变量

为了让你跟着 trace 时随时知道"现在系统长什么样"，下面列出三个**贯穿全程的状态**，每一步结束时它们的快照：

| 状态                  | 初始             | step 01 后                | step 03 后        | step 06 后                       | step 11 后                       | step 13 后                       | step 16 后                          | step 17 后  |
| --------------------- | ---------------- | ------------------------- | ----------------- | -------------------------------- | -------------------------------- | -------------------------------- | ----------------------------------- | ----------- |
| `system.kv_pool`      | 不存在           | 大小已知，未分配          | 已分配，全 free   | 部分 in-use（被我们 request 占） | 同 06（prefill 不分配新 block，假设 4 token 都进 1 个 block） | 同 06                            | 全部 free                           | 全部 free   |
| `system.req_queue`    | 空               | 空                        | 空                | { req#1: WAITING }→RUNNING       | RUNNING (prefill 完)             | RUNNING (decode, 1 token done)   | 空（FINISHED 移出）                 | 空          |
| `outputs`             | 无               | 无                        | 无                | 无                               | 无                               | [tok1]                            | [tok1, tok2, tok3]                 | "你好啊"等中文字符串 |

## 跟参考手册的关系

每一步第 7 段"分支与延伸"会有大量到这 12 章的跳转。建议第一遍读 tour 只看主线、把分支链接放着；第二遍按你感兴趣的分支去翻 12 章对应小节。

| 章节                                            | 在 trace 哪些步骤被引用最多 |
| ----------------------------------------------- | --------------------------- |
| 01 架构总览                                     | 全程（背景知识）            |
| 02 核心理论概念                                 | 05, 06, 10, 14              |
| 03 入口与引擎层                                 | 04, 13, 17                  |
| 04 调度器                                       | 05, 14, 16                  |
| 05 KV cache 管理                                | 01, 06, 16                  |
| 06 Worker 与 Model Runner                       | 01, 02, 07, 08, 15          |
| 07 Attention Backends                           | 08, 10, 15                  |
| 08 模型定义与加载                               | 03, 09, 11                  |
| 09 采样                                         | 12                          |
| 10 分布式与并行                                 | （主线不涉及）              |
| 11 高级特性（spec decode / 量化 / LoRA / MM …） | （主线不涉及，分支引用）    |
| 12 术语表与 FAQ                                 | 全程查词                    |

---

读完 17 步你大概会花 3-5 小时。结束时如果脑子里能复述"`llm.generate(['你好'])` 是怎么变成 `'你好啊...'` 的"——并且知道每一个 vllm 设计决定都是为了解决什么问题——这个导览就成功了。
