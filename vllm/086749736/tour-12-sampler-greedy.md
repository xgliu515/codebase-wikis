# Trace 步骤 12 —— Sampler 为什么不是一个 `argmax`？

> 上一步终态：第 11 步算完 `lm_head`，得到形状 `[num_sampled, vocab_size]` 的 logits tensor 在 GPU 上。
> 本步终态：1 个 token id（int32）封进 `SamplerOutput.sampled_token_ids`，shape `[1, 1]`，仍在 GPU 上，等待回传 EngineCore。

## 1. 当前情境

`gpu_model_runner.py:4306` 调用 `_sample(logits, spec_decode_metadata)`，里面（`gpu_model_runner.py:3439`）走 `spec_decode_metadata is None` 分支：

```python
return self.sampler(logits=logits, sampling_metadata=sampling_metadata)
```

`sampling_metadata` 来自 `self.input_batch.sampling_metadata`（`gpu_model_runner.py:3445`），由 `_make_sampling_metadata` 在每次 batch 变动后重建（`gpu_input_batch.py:831`）。本 trace 中 batch 只有一个 request，`SamplingParams(max_tokens=3, temperature=0)` 早已被解析、填进 input_batch 的 CPU 缓冲区、H2D 上 GPU。

我们要做的事看似一句话：`next_token = logits.argmax(dim=-1)`。为什么不是？

## 2. 问题

Sampler 在 vllm 里是一段 9 步流水线（`vllm/v1/sample/sampler.py:21` 的 docstring）。本 trace `temperature=0`，理论一个 `argmax` 就够。问题是：**这条流水线为什么不能省？为什么 greedy 也得过一遍？**

更深一层：sampler 是**每 step 跑一次、对整个 batch 一次性出结果**。所以真正要回答的是：

- 同 batch 里可能同时有 greedy / top-p / 带 frequency penalty / 带 logit bias / 走 structured output 的请求
- GPU 上的 logits 是一整块 `[B, V]`，kernel 想要 vectorized 操作，不能 Python 逐行循环
- 怎么用**固定结构的 GPU 代码**处理**每个 request 参数都不同**的"异构批处理"？

这就是 SamplingMetadata + LogitsProcessor 要解决的事。

## 3. 朴素思路

"一个 request 一个 sampler"：

```python
for req in batch:
    l = logits[req.idx]
    if req.params.temperature == 0:
        out.append(l.argmax())
    else:
        l = apply_penalties(l, req.history, req.params)
        l = l / req.params.temperature
        l = top_k(l, req.params.top_k); l = top_p(l, req.params.top_p)
        out.append(torch.multinomial(l.softmax(-1), 1))
```

清晰、对应 OpenAI 接口语义。

## 4. 为什么朴素思路会崩

**两个独立失败**。

**Python for-loop + 多次小 kernel = 灾难性慢**。每 request 单独发 5-6 个 small kernel，sampler 自身就能吃几毫秒；decode-only 单步 batch 才 ~10ms。GPU 大部分时间在 launch overhead 上 idle。

**异构参数无法在一个 kernel 里表达**。把 batch 一起喂给 `apply_temperature`，但每 request 的 temperature 不同；喂给 `top_k`，但 k 不同；算 frequency penalty 但 prompt 长度不同。这些"按 request 取不同值"的参数必须**预先打包成 per-request batched tensor**（`[B]` 或 `[B, V]`），让 kernel 用 vectorized 方式读。

还有隐藏成本：logit bias、min_tokens、structured-output bitmask 这类"和 token id 相关的稀疏 mask"必须先在 CPU 上汇总成 `(req_idx, tok_id)` 索引，再 1 次 `index_put_` / `masked_fill_` 写 GPU，否则同样陷入 per-request kernel 风暴。

所以即使本 trace 全 greedy，sampler 也必须沿着"为异构 batch 设计"的路径走——这条路径**对单 greedy request 的开销摊薄到几乎为零**，但结构是固定的。

## 5. vllm 的做法

**把"每 request 不同的参数"提前打包成 batched tensor，让固定结构的 GPU 流水线一次过完整 batch；分支只用 `torch.where` 这种 vectorized 操作，不让 Python 决策。**

`Sampler.forward`（`sampler.py:68`）主干：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Sampler.forward 五大阶段及 greedy / random 分裂">
  <defs>
    <marker id="t12ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Sampler.forward 五阶段流水线（本 trace greedy 走橙色快路径）</text>
  <g transform="translate(260, 38)">
    <rect x="0" y="0" width="240" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="5"/>
    <text x="120" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">输入：logits [B, V] (GPU)</text>
    <text x="120" y="30" text-anchor="middle" font-size="10" fill="#7c2d12">本 trace B=1, V=151936</text>
  </g>
  <line x1="380" y1="74" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
  <g transform="translate(60, 94)">
    <rect x="0" y="0" width="640" height="48" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" rx="5"/>
    <text x="20" y="20" font-size="11" font-weight="700" fill="#475569">① 备份 raw logprobs</text>
    <text x="20" y="36" font-size="10" fill="#64748b">仅 num_logprobs &gt; 0 才克隆；本 trace 跳过</text>
    <text x="620" y="30" text-anchor="end" font-size="10" font-style="italic" fill="#94a3b8">cond. skip</text>
  </g>
  <line x1="380" y1="142" x2="380" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
  <g transform="translate(60, 162)">
    <rect x="0" y="0" width="640" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="5"/>
    <text x="20" y="18" font-size="11" font-weight="700" fill="#115e59">② logits.to(float32)</text>
    <text x="20" y="32" font-size="10" fill="#0f766e">数值稳定（penalty / softmax 都要 fp32）</text>
  </g>
  <line x1="380" y1="202" x2="380" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
  <g transform="translate(60, 222)">
    <rect x="0" y="0" width="640" height="86" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2" rx="5"/>
    <text x="20" y="20" font-size="11" font-weight="700" fill="#5b21b6">③ apply_logits_processors（greedy 也要过）</text>
    <text x="30" y="38" font-size="10" fill="#6d28d9">• allowed_token_ids_mask（白名单 → -inf）　• bad_words mask</text>
    <text x="30" y="54" font-size="10" fill="#6d28d9">• non-argmax-invariant procs： MinTokens（屏蔽 EOS）、LogitBias</text>
    <text x="30" y="70" font-size="10" fill="#6d28d9">• penalties（repetition / frequency / presence）</text>
    <text x="620" y="82" text-anchor="end" font-size="9" font-style="italic" fill="#7c3aed">本 trace 所有子项 fast-return</text>
  </g>
  <line x1="380" y1="308" x2="380" y2="324" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
  <g transform="translate(60, 328)">
    <rect x="0" y="0" width="640" height="140" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="320" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">④ sample()： greedy / random 分裂</text>
    <rect x="20" y="32" width="290" height="96" fill="#fef3c7" stroke="#facc15" stroke-width="1.2" rx="4"/>
    <text x="165" y="50" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">本 trace 走这条（all_greedy=True）</text>
    <text x="30" y="68" font-size="10" font-family="monospace" fill="#7c2d12">greedy_sampled = argmax(logits)</text>
    <text x="30" y="84" font-size="10" font-family="monospace" fill="#7c2d12">if all_greedy: return greedy_sampled</text>
    <line x1="30" y1="92" x2="300" y2="92" stroke="#facc15" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="30" y="108" font-size="10" font-style="italic" fill="#a16207">temperature / min-p / top-k / top-p</text>
    <text x="30" y="122" font-size="10" font-style="italic" fill="#a16207">全部不执行（跳过 5 个 kernel）</text>
    <rect x="330" y="32" width="290" height="96" fill="white" stroke="#ea580c" stroke-width="1" stroke-dasharray="3,2" rx="4"/>
    <text x="475" y="50" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">混合 / random 时走这条</text>
    <text x="340" y="68" font-size="10" font-family="monospace" fill="#7c2d12">apply_temperature(logits, temp)</text>
    <text x="340" y="84" font-size="10" font-family="monospace" fill="#7c2d12">apply_min_p / top_k / top_p</text>
    <text x="340" y="100" font-size="10" font-family="monospace" fill="#7c2d12">random = multinomial(softmax)</text>
    <text x="340" y="116" font-size="10" font-family="monospace" fill="#7c2d12">torch.where(temp&lt;eps, greedy, random)</text>
  </g>
  <line x1="380" y1="468" x2="380" y2="484" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
  <g transform="translate(60, 488)">
    <rect x="0" y="0" width="640" height="42" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2" rx="5"/>
    <text x="20" y="18" font-size="11" font-weight="700" fill="#166534">⑤ long → int32 → SamplerOutput(sampled_token_ids = [B, 1])</text>
    <text x="20" y="34" font-size="10" fill="#14532d">本 trace 输出 shape [1, 1]，等待 D2H 回 EngineCore</text>
  </g>
</svg>
<span class="figure-caption">图 T12.1 ｜ Sampler.forward 五阶段流水线。greedy 路径在第 ④ 步早期 return，跳过 temperature / min-p / top-k / top-p；但前三步（fp32、logits processor、penalty）的骨架不论 greedy 与否都跑——这就是 sampler 必须 9 步而非 1 步 argmax 的原因</span>

<details>
<summary>ASCII 原版</summary>

```text
logits: [B, V] on GPU
│
├─ (1) 若需 logprobs：克隆 raw logprobs 备份
├─ (2) logits.to(float32)                       ← 数值稳定
├─ (3) apply_logits_processors(...)             ← sampler.py:360
│      • allowed_token_ids_mask（白名单 → -inf）
│      • bad_words mask
│      • non-argmax-invariant LogitsProcessor（min_tokens、logit_bias 等）
│      • penalties（repetition / frequency / presence）
├─ (4) sample(...)                              ← sampler.py:235
│      • 若 !all_random → greedy_sampled = argmax(logits)  ← 本 trace 在此拿到答案
│      • 若 all_greedy  → 直接 return
│      • 否则 apply_temperature → argmax-invariant procs (min_p) → top-k/top-p → multinomial
│      • 最后 torch.where(temp < eps, greedy, random) 按 request 二选一
└─ (5) long → int32 → SamplerOutput(sampled_token_ids=[B,1])
```

</details>

设计目标：每步要么不动 logits、要么对整批 vectorized 操作；per-request 标量参数都进 SamplingMetadata 的 batched tensor；per-request 稀疏状态由 LogitsProcessor 自己维护并提前聚合成索引张量。

### SamplingMetadata：batch 化的入口

`metadata.py:14` 的 dataclass 就是"异构 SamplingParams 的 batched 视图"：`temperature: [B]`、`top_p / top_k: [B]`、3 个 penalty `[B]`、`output_token_ids: list[list[int]]`（给 penalties / bad_words 看）、`allowed_token_ids_mask: [B, V]`、`bad_words_token_ids: dict`、`logitsprocs: LogitsProcessors`。

构造它的是 `gpu_input_batch.py:831` 的 `_make_sampling_metadata`：每次 batch 变动后把 CPU pinned 缓冲 `copy_slice` H2D 到 GPU 预分配 tensor 的前 `num_reqs` 行，再装进 SamplingMetadata。注意几个**性能开关**：`all_greedy=True` 时 `temperature` 不上 GPU（833-838）；`no_top_p / no_top_k` 对应 tensor slice 为 None；`no_penalties=True` 时 `prompt_token_ids` 不构造、不 H2D（844-875）；`output_token_ids` 只在需要时填，否则给空 list（883-893）。

**本 trace 中**：batch 只一个 greedy 请求，所以 `all_greedy=True`、`no_top_p=True`、`no_top_k=True`、`no_penalties=True`，几乎所有 batched tensor 都是 None。

### LogitsProcessor 流水线：argmax-invariant 与否的分裂

`logits_processor/__init__.py:49` 列出 3 个内置：`MinTokensLogitsProcessor`（强制屏蔽 EOS 直到生成 min_tokens 个）、`LogitBiasLogitsProcessor`（OpenAI logit_bias）、`MinPLogitsProcessor`（nucleus 之上的 min-p）。

每个都实现 `is_argmax_invariant()`（`interface.py:84`）回答一个关键问题：**这个处理器会改变 argmax 结果吗？**

- `MinTokens` → **False**（屏蔽 EOS 可能改变最大值位置，`builtin.py:186`）
- `LogitBias` → **False**（加 bias 直接改 argmax）
- `MinP` → **True**（只删尾部低概率 token，不影响最大值）

`LogitsProcessors` 容器（`state.py:148`）按这个开关把 procs 分成两组：

- `non_argmax_invariant`：在 `apply_logits_processors` 里（penalties 之前）跑——**greedy 也要过**
- `argmax_invariant`：在 `sample()` 内、temperature 之后跑——**greedy 路径完全跳过**

这就解释了 docstring 第 7c 步为什么写"argmax-invariant"：它们只对 random sampling 有意义，greedy 在 `sampler.py:253-260` 早就 return 了。

### Penalties / structured output 怎么 mask

`apply_penalties`（`sampler.py:411`）调 `apply_all_penalties`：把 `prompt_token_ids`、`output_token_ids`、3 个 penalty tensor 一起喂给一个 fused kernel，对 batch 一次 in-place 改写。

structured output 不在 sampler 里完成耦合——它在更早位置：`gpu_model_runner.py:4299-4303`，**`_sample` 调用之前**就把 grammar bitmask 用 `apply_grammar_bitmask` 直接 `masked_fill_(-inf)` 到 logits。Sampler 拿到 logits 时不知道有没有 structured output；屏蔽已物化成 -inf，下一步走 argmax 还是 multinomial 行为都一致。

### 本 trace 的实际足迹

逐步对照 SamplingParams = `max_tokens=3, temperature=0`：

1. `num_logprobs=None` → 跳过 raw logprobs 备份（80-88）
2. `logits.to(float32)`（91）
3. `apply_logits_processors`：`allowed_token_ids_mask is None` 跳；`bad_words_token_ids` 空 跳；`non_argmax_invariant` 里 `MinTokens`（`min_tokens=0`，dict 空）和 `LogitBias`（biases 空）都因字典空 fast-return（`builtin.py:161, 234`）；`no_penalties=True` 让 `apply_penalties` 在 417 fast-return
4. `sample()`：`all_random=False` → 算 `greedy_sampled = logits.argmax(dim=-1).view(-1)`（233）；`all_greedy=True` → 直接 return `(greedy_sampled, None)`（253-260）。**temperature / min-p / top-k / top-p 全部不执行**
5. `sampled.long()` → `int64`；跳 logprobs gather；`sampled.to(int32)`；`sampled_token_ids = sampled.unsqueeze(-1)`，shape `[1, 1]`

**3 步即出结果，但流水线骨架全部跑过**——这就是 sampler 必须 9 步而非 1 步 argmax 的实证：骨架为异构 batch 准备，单 greedy 请求只是走了它的最短路径。

## 6. 代码位置

- `vllm/v1/sample/sampler.py:21` —— `Sampler` 类 docstring 明列 9 步
- `vllm/v1/sample/sampler.py:68` —— `Sampler.forward` 主入口
- `vllm/v1/sample/sampler.py:235` —— `sample()` 的 greedy / random 分裂
- `vllm/v1/sample/sampler.py:360` —— `apply_logits_processors`，penalties 之前的 non-argmax-invariant 流水线
- `vllm/v1/sample/metadata.py:14` —— `SamplingMetadata` 字段
- `vllm/v1/sample/logits_processor/interface.py:60` —— LogitsProcessor 抽象类、`is_argmax_invariant` 契约
- `vllm/v1/sample/logits_processor/builtin.py:22` / `:167` —— `MinPLogitsProcessor`（True）/ `MinTokensLogitsProcessor`（False）
- `vllm/v1/sample/logits_processor/__init__.py:184` —— `build_logitsprocs`，注册 3 个内置 + 插件
- `vllm/v1/sample/logits_processor/state.py:148` —— `LogitsProcessors` 容器，按 argmax-invariant 分组
- `vllm/v1/worker/gpu_input_batch.py:831` —— `_make_sampling_metadata`
- `vllm/v1/worker/gpu_model_runner.py:3439` —— `_sample`
- `vllm/v1/worker/gpu_model_runner.py:4299-4303` —— structured output bitmask 在 sampler 之前 mask 到 logits
- `vllm/sampling_params.py:168` —— `SamplingParams` 字段定义（异构性的源头）

**阅读顺序**：先读 `sampler.py` 顶部 docstring 了解 9 步；再去 `metadata.py` 看字段；回 `Sampler.forward` 跟一次 greedy 的 fast path；最后翻 `gpu_input_batch.py:_make_sampling_metadata` 看 batched tensor 怎么从 SamplingParams 装配出来。

## 7. 分支与延伸

- **`temperature > 0` 的随机采样路径**：batched temperature `logits.div_(temp.unsqueeze(1))`、min-p / top-k / top-p 怎么共享 buffer → 第 9 章 §4 "Sampler 流水线"
- **`SamplingParams` 都支持哪些字段、和 OpenAI 的对应**：本步只用 `max_tokens / temperature`，其它字段如何反映为 SamplingMetadata 的 batched tensor → 第 9 章 §2 "SamplingParams"
- **SamplingMetadata 是怎么 batch 化构造的、为什么拆 CPU/GPU 两份**：`gpu_input_batch` 的 add/remove/move 怎么增量更新 → 第 9 章 §3 "SamplingMetadata"
- **自定义 LogitsProcessor 怎么写**：`AdapterLogitsProcessor`（`__init__.py:234`）适配 OpenAI 风格 per-request callable；插件机制 `LOGITSPROCS_GROUP` → 第 9 章 §5 "LogitsProcessor"
- **structured output / guided decoding（JSON Schema、grammar）**：bitmask 在哪生成、`apply_grammar_bitmask` 怎么把 `accept_tokens` 结果以 `[B, V/32]` packed bool mask 到 logits → 第 9 章 §6 "structured output"
- **speculative decoding 走 rejection_sampler**：本 trace 在 `_sample` 的 None 分支直返 sampler；spec decode 走 `gpu_model_runner.py:3462` 的 `rejection_sampler` → 第 11 章 "spec decode"
- **`logprobs > 0`**：第 1 步备份 raw_logprobs、第 8 步 `gather_logprobs` 取 top-k+采样位置的 logprob+rank → 第 9 章 §4 末段
- **FlashInfer 顶替 PyTorch 的 top-k/top-p kernel**：`TopKTopPSampler` 在 SM ≥ 8.0 时自动切到 FlashInfer（`topk_topp_sampler.py:40`），greedy 不走 → 第 7 章 §6

## 8. 走完这一步你脑子里应该多了什么

1. **Sampler 是为异构 batch 设计的**：同 batch 内 greedy / top-p / penalty 各异，必须能用一段 vectorized 流水线全部处理；greedy 是这条流水线的最短路径，不是唯一形态。
2. **SamplingMetadata 是异构 SamplingParams 的 batched 视图**：per-request 标量参数打包成 `[B]` tensor，per-request 稀疏 mask 打包成 `(req_idx, tok_id)` index 张量；`all_greedy / no_top_p / no_penalties` 等 fast-path 开关避免无谓 H2D。
3. **`is_argmax_invariant` 是 LogitsProcessor 的核心契约**：把 procs 分成两组——greedy 前必跑（min_tokens、logit_bias）vs 只在 random 时跑（min_p）。这是 docstring 里 5/7c 两段并存的原因。
4. **structured output 的接入点比 sampler 更早**：grammar bitmask 在 `_sample` 之前就 `masked_fill_(-inf)` 写进 logits，sampler 对它无感、行为统一——一个干净的解耦。
