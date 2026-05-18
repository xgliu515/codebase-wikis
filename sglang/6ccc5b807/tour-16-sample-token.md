# Trace 步骤 16 —— logits 怎么变成第一个 token？

## 1. 当前情境

prefill 的前向传播刚刚跑完（步骤 14-15）。GPU 上现在有一个形状为
`[1, vocab_size]` 的张量——对应 prompt 最后一个位置的 **next_token_logits**，
由 `LogitsProcessorOutput.next_token_logits` 持有
（`python/sglang/srt/layers/logits_processor.py`）。

`vocab_size` 对于 Llama-3.2-1B 是 128 256，因此这个张量里有 128 256 个浮点数，
每一个对应词表里的一个 token。我们需要从中挑出"最可能的下一个 token"。

本例的采样参数是 `temperature=0`，其余采样参数均为默认值（`top_p=1.0`，
`top_k=-1`，`min_p=0`）。

## 2. 问题

拿到 logits 之后，要做两件事才能得到 token id：

1. 把 logits **变成**一个可以决策的概率分布（或直接做 argmax）；
2. **采出**一个 token id，并把它追加进 `req.output_ids`。

但 batch 里可能同时跑着多个请求，每个请求的采样参数各不相同——有的贪心、有的
top-p、有的 top-k。怎么在一次 GPU 调用里把所有请求都处理掉，又不让一个请求的
参数污染另一个？

## 3. 朴素思路

在 Python 里循环：对 batch 里每个请求，分别读出其 `temperature`、`top_p`
等参数，做一次 `softmax`，再做 `torch.multinomial`。

直觉上合理——逻辑清晰，每个请求独立处理，不会串。

## 4. 为什么朴素思路会崩

Python 循环意味着：每个请求一次 GPU kernel 调用，且每次都要同步等待。
`batch_size=256` 时就是 256 次串行 kernel 启动——这是 GPU 最怕的模式，
kernel 启动开销本身就能吃掉几十毫秒，而实际算术量几乎为零。

更根本的问题是：`SamplingBatchInfo`（`python/sglang/srt/sampling/sampling_batch_info.py`）
在 `ScheduleBatch` 准备阶段就已经把所有请求的采样参数**批量打包**成 GPU 张量
（`temperatures`、`top_ps`、`top_ks`……），专门就是为了让采样走一次批量 kernel。
如果再用 Python 循环，打包这一步就白做了。

## 5. SGLang 的做法

整个采样路径分三层：

```text
ModelRunner.sample()
   │
   ├─ _preprocess_logits()           <- 先施加 vocab mask / logit bias / penalty
   │      sampling_info.update_regex_vocab_mask()
   │      sampling_info.apply_logits_bias(logits)
   │
   └─ self.sampler(...)              <- Sampler.forward()
          │
          ├─[is_all_greedy=True]─── torch.argmax(logits, -1)   ← 本例走这里
          │
          └─[is_all_greedy=False]
                │
                logits /= temperatures          (批量除温度)
                logits = softmax(logits)        (批量 softmax)
                │
                ├─[simple_case]── torch.multinomial(probs)
                │
                └─[top-k/top-p/min-p]
                      flashinfer: top_k_top_p_sampling_from_probs()
                      pytorch fallback: top_k_top_p_min_p_sampling_from_probs_torch()
```

**本例（temperature=0）的走法**

`SamplingBatchInfo.from_schedule_batch` 在创建时会检查：

```python
is_all_greedy = all(r.sampling_params.top_k <= 1 for r in reqs)
# python/sglang/srt/sampling/sampling_batch_info.py:176
```

`temperature=0` 在 SGLang 内部被规范化为 `top_k=1`，因此 `is_all_greedy=True`。
`Sampler.forward` 走 argmax 分支：

```python
if sampling_info.is_all_greedy:
    batch_next_token_ids = torch.argmax(logits, -1)
# python/sglang/srt/layers/sampler.py:121-123
```

`torch.argmax` 是单次 GPU kernel，返回形状 `[batch_size]` 的 int64 张量。
本例 batch_size=1，得到一个标量 tensor——值就是" Paris"对应的 token id
（Llama tokenizer 中通常是 3681 或类似值）。

**一般路径（temperature>0）的走法**

<svg viewBox="0 0 600 332" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="General sampling pipeline from logits to next token">
<defs>
<marker id="t16ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="170" y="14" width="260" height="34" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="300" y="30" text-anchor="middle" font-size="11" fill="currentColor">logits　[B, V]　原始分数</text>
<text x="300" y="43" text-anchor="middle" font-size="9" fill="#94a3b8">前向输出</text>
<line x1="300" y1="48" x2="300" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="68" width="260" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
<text x="300" y="84" text-anchor="middle" font-size="11" fill="currentColor">÷ temperatures　[B,1]</text>
<text x="300" y="96" text-anchor="middle" font-size="9" fill="#64748b">温度越低分布越尖</text>
<line x1="300" y1="100" x2="300" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="118" width="260" height="28" rx="6" fill="#fed7aa" stroke="#ea580c"/>
<text x="300" y="137" text-anchor="middle" font-size="11" fill="currentColor">softmax → 概率分布　[B, V]</text>
<line x1="300" y1="146" x2="300" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="164" width="260" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="183" text-anchor="middle" font-size="11" fill="currentColor">top-k 截断　排名 &gt;k 的概率清零</text>
<line x1="300" y1="192" x2="300" y2="206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="208" width="260" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="227" text-anchor="middle" font-size="11" fill="currentColor">top-p 截断　累积概率尾部清零</text>
<line x1="300" y1="236" x2="300" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="252" width="260" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="271" text-anchor="middle" font-size="11" fill="currentColor">min-p 过滤　去掉相对低概率 token</text>
<line x1="300" y1="280" x2="300" y2="294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t16ar)"/>
<rect x="170" y="296" width="260" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="300" y="316" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">multinomial 采样 → next token　[B]</text>
<text x="525" y="34" text-anchor="middle" font-size="9" fill="#16a34a">贪心路径</text>
<path d="M430 31 C 512 31, 512 312, 432 312" fill="none" stroke="#16a34a" stroke-width="1.3" stroke-dasharray="4,3" marker-end="url(#t16ar)"/>
<text x="535" y="170" text-anchor="middle" font-size="9" fill="#16a34a">直接 argmax</text>
<text x="535" y="184" text-anchor="middle" font-size="9" fill="#16a34a">跳过中间步</text>
</svg>
<span class="figure-caption">图 T16.1 ｜ 通用采样流水线（全程 GPU 批量、零 Python 循环）；temperature=0 时整批走 argmax 贪心快速路径</span>

<details>
<summary>ASCII 原版</summary>

```text
logits                [B, V]   原始 logits
  ÷ temperatures      [B, 1]   广播相除，温度越低分布越尖
  → softmax            [B, V]   变成概率
  → top-k 截断        [B, V]   把排名 >k 的位置概率清零
  → top-p 截断        [B, V]   把累积概率超过 p 的尾部清零
  → min-p 过滤        [B, V]   去掉相对最高概率 <min_p 倍的 token
  → multinomial 采样  [B]      从剩余分布中按概率随机抽一个
```

</details>

整条路径全部在 GPU 上批量完成，零 Python 循环。

**logit bias 与惩罚项的施加时机**

在调用 `Sampler.forward` 之前，`ModelRunner._preprocess_logits`
（`python/sglang/srt/model_executor/model_runner.py:3287`）先调用
`sampling_info.apply_logits_bias`，它按顺序施加：

- 频率/重复惩罚（`penalizer_orchestrator.apply`）；
- 结构化输出的词表 mask（`apply_mask_func`）；
- 用户指定的 `logit_bias`。

本例没有任何惩罚或约束，这一步是空操作。

采样结果返回后，`process_batch_result_prefill` 把 token id 追加进
`req.output_ids`（`scheduler_output_processor_mixin.py:248`）：

```python
req.output_ids.append(next_token_id)
```

至此 `output_ids` 长度从 0 变成 1，第一个生成 token 落地。

## 6. 代码位置

按阅读顺序：

- `python/sglang/srt/sampling/sampling_batch_info.py:74-189`
  —— `SamplingBatchInfo.from_schedule_batch`：把所有请求的采样参数批量打包进 GPU 张量，
  第 176 行计算 `is_all_greedy`。
- `python/sglang/srt/model_executor/model_runner.py:3287-3335`
  —— `ModelRunner._preprocess_logits` 与 `ModelRunner.sample`：先施加 bias，再调用 sampler。
- `python/sglang/srt/layers/sampler.py:93-203`
  —— `Sampler.forward`：greedy 走 argmax（`sampler.py:121-123`），
  非 greedy 走温度 + softmax + top-k/top-p/min-p + multinomial（`sampler.py:129-186`）。
- `python/sglang/srt/layers/sampler.py:205-256`
  —— `Sampler._sample_from_probs`：分发到 flashinfer / pytorch 采样 backend。
- `python/sglang/srt/layers/sampler.py:464-509`
  —— `top_k_top_p_min_p_sampling_from_probs_torch`：纯 PyTorch 实现的完整采样路径，
  代码量少，适合理解算法本身。
- `python/sglang/srt/managers/scheduler_output_processor_mixin.py:239-256`
  —— `process_batch_result_prefill` 里把 `next_token_id` 追加进 `req.output_ids`。

## 7. 分支与延伸

- 采样参数的完整语义（温度、top-p、top-k、min-p、频率惩罚等）及其相互作用
  → [第 11 章 采样与约束解码](11-sampling-constrained.md)

- 结构化输出（grammar-guided decoding）如何在采样前修改词表 mask，
  以及 xgrammar 的 `fill_vocab_mask` 如何和 `SamplingBatchInfo.vocab_mask` 衔接
  → [第 11 章 采样与约束解码 §结构化输出](11-sampling-constrained.md)

- 投机解码（speculative decoding）在 verify 阶段有自己的"接受/拒绝"逻辑，
  不走 `Sampler.forward` 的标准路径，而是用 target model 的 logits 修正 draft token
  → [第 12 章 投机解码](12-speculative-decoding.md)

- 多 GPU 张量并行时（`tp_size > 1`），各 rank 分别持有词表的一个分片，
  `Sampler._sync_token_ids_across_tp` 用 `all_reduce(MIN)` 同步最终 token id
  → [第 13 章 分布式与并行执行](13-distributed.md)

## 8. 走完这一步你脑子里应该多了什么

1. **greedy 是采样的特例**：`temperature=0` 被规范化为 `top_k=1`，触发
   `is_all_greedy=True`，整条路径退化成一次 `torch.argmax`，连 softmax 都省了。

2. **采样参数在进入采样前就已批量向量化**：`SamplingBatchInfo.from_schedule_batch`
   把整个 batch 的 `temperature`、`top_p`、`top_k`、`min_p` 统统打包成 GPU 张量，
   采样 kernel 只需要一次向量化操作，没有 Python 循环。

3. **logit bias 和 penalty 在采样前统一施加**：`_preprocess_logits` 是采样的门卫，
   grammar mask、频率惩罚、用户 logit_bias 都在这里写入 logits，之后 sampler 看到的
   已经是"修改后的 logits"。

4. **第一个 token 落进 `req.output_ids`**：采样结果由
   `process_batch_result_prefill` 追加，`output_ids` 长度从 0 变 1，
   这个请求正式进入 decode 阶段（步骤 17 的起点）。
