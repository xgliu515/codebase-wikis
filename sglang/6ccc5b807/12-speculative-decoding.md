# 第 12 章 投机解码

## 本章导读

[第 08 章](08-scheduler.md) 提过:decode 阶段一次只生成 1 个 token,GPU 严重欠载。投机解码(speculative decoding)就是专治这个病的——它让 decode 一步能「赚」好几个 token。

本章讲清投机解码的原理,以及 SGLang 的三套实现:EAGLE、N-gram、MTP。代码在 `python/sglang/srt/speculative/`。

> 本章涉及大量投机解码专有术语。SGLang 代码库对这些命名有严格约定(见仓库 `.claude/rules/speculative-naming.md`),本章遵循同一套术语:`accept`(含 bonus token)、`correct`(仅草稿)、`bonus_token`(目标模型额外产出的那个 token)等。

## 1. 问题:decode 为什么慢

decode 是**自回归**的:生成第 N 个 token,必须先有第 N-1 个。所以 decode 天然串行,一步一个 token。

而一步 decode 的计算量极小(1 个 token 过一遍模型),却要把**整个模型的权重**从显存读一遍。decode 是**显存带宽瓶颈**(memory-bound),不是算力瓶颈——GPU 的算力大量闲置。

关键观察:一步 decode 把权重读进来后,**多算几个 token 几乎不增加额外的权重读取成本**。GPU 算 1 个 token 和算 5 个 token,瓶颈(读权重)是一样的。那能不能想办法一步**验证多个 token**?

## 2. draft-verify 范式

投机解码的核心套路:**让一个便宜的「草稿」机制猜出未来几个 token,再让真正的目标模型一次性并行验证。**

<svg viewBox="0 0 620 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Draft-verify-accept-bonus paradigm of speculative decoding">
<defs>
<marker id="r12ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="30" y="16" width="560" height="62" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="50" y="38" font-size="12" font-weight="700" fill="currentColor">① draft　便宜地猜 k 个 token</text>
<rect x="320" y="44" width="50" height="24" rx="3" fill="#fff" stroke="#ea580c"/><text x="345" y="60" text-anchor="middle" font-size="10" fill="currentColor">t1</text>
<rect x="374" y="44" width="50" height="24" rx="3" fill="#fff" stroke="#ea580c"/><text x="399" y="60" text-anchor="middle" font-size="10" fill="currentColor">t2</text>
<rect x="428" y="44" width="50" height="24" rx="3" fill="#fff" stroke="#ea580c"/><text x="453" y="60" text-anchor="middle" font-size="10" fill="currentColor">t3</text>
<rect x="482" y="44" width="50" height="24" rx="3" fill="#fff" stroke="#ea580c"/><text x="507" y="60" text-anchor="middle" font-size="10" fill="currentColor">t4</text>
<line x1="310" y1="78" x2="310" y2="96" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
<rect x="30" y="98" width="560" height="56" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
<text x="50" y="122" font-size="12" font-weight="700" fill="currentColor">② verify　目标模型一次前向，并行验证 k 个草稿</text>
<text x="50" y="142" font-size="10" fill="#64748b">每个位置算出「真实」分布——一次权重读取，确认多个 token</text>
<line x1="310" y1="154" x2="310" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
<rect x="30" y="174" width="560" height="62" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="50" y="196" font-size="12" font-weight="700" fill="currentColor">③ accept　从头比对，接受连续正确的前缀</text>
<rect x="320" y="204" width="50" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="345" y="220" text-anchor="middle" font-size="10" fill="#16a34a">t1 ✓</text>
<rect x="374" y="204" width="50" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="399" y="220" text-anchor="middle" font-size="10" fill="#16a34a">t2 ✓</text>
<rect x="428" y="204" width="50" height="24" rx="3" fill="#fef2f2" stroke="#dc2626"/><text x="453" y="220" text-anchor="middle" font-size="10" fill="#dc2626">t3 ✗</text>
<rect x="482" y="204" width="50" height="24" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/><text x="507" y="220" text-anchor="middle" font-size="10" fill="#dc2626">t4 丢</text>
<line x1="310" y1="236" x2="310" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
<rect x="30" y="256" width="560" height="52" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="50" y="278" font-size="12" font-weight="700" fill="currentColor">④ bonus　验证时「顺带」正确产出的下一个 token</text>
<text x="50" y="296" font-size="10" fill="#64748b">即使草稿全错也能拿到 → 这一步至少赚 1 个 bonus_token</text>
</svg>
<span class="figure-caption">图 R12.1 ｜ 投机解码的 draft-verify-accept-bonus 范式：一次目标模型前向确认多个 token</span>

<details>
<summary>ASCII 原版</summary>

```text
  1. draft:  便宜地猜 k 个 token   →  [t1, t2, t3, t4]  (草稿)
  2. verify: 目标模型一次前向,
             并行验证这 k 个草稿        每个位置算出"真实"分布
  3. accept: 从头比对,接受连续正确的前缀
             t1 ✓  t2 ✓  t3 ✗  →  接受 t1 t2,丢弃 t3 t4
  4. bonus:  目标模型在验证时还会"顺便"
             正确产出验证位置的下一个 token  → bonus_token
```

</details>

为什么这是对的:目标模型一次前向能并行算 k 个位置的分布(就像 prefill 并行算多个 token,见 [导览步骤 14](tour-14-model-forward.md))。它检查每个草稿 token 是不是「自己也会生成的那个」。验证一次前向 = 一次权重读取,但能确认好几个 token。

- 草稿全对:一步赚 k+1 个 token(k 个草稿 + 1 个 bonus)。
- 草稿全错:退化成普通 decode,一步 1 个 bonus token——**不会更差**。

收益取决于草稿的命中率。术语上:
- **`accept_rate`**:每个草稿 token 的接受概率(论文里的 α);
- **`accept_length`**:每个 verify 步平均产出多少 token(论文里的 τ);
- **`num_correct_drafts`**:被接受的草稿数(不含 bonus);**`num_accept_tokens`**:接受的 token 总数(含 bonus)。

正确性保证:经过适当的验证/采样方案,投机解码产出的 token 分布和「目标模型直接 decode」**完全一致**——它只加速,不改变结果。

## 3. EAGLE:用一个小草稿模型猜

草稿从哪来?最有效的方式是训练一个**小的草稿模型**。**EAGLE** 是 SGLang 的主力投机方案。

EAGLE 的草稿模型不是一个独立的小 LLM,而是一个**轻量的草稿头**——它复用目标模型的部分信息(隐藏状态等),用极小的额外计算预测接下来几个 token。而且 EAGLE 的草稿是**树状**的:它一次猜出一棵候选 token 树,verify 时并行验证整棵树,接受其中最长的合法路径,命中率比线性猜更高。

实现在 `speculative/eagle_worker.py`,核心类 `EAGLEWorker`(`eagle_worker.py:91`,继承 `TpModelWorker`)。它的 `forward_batch_generation`(`:445`)是一步投机 decode 的总入口,关键方法:

| 方法 | 作用 |
|------|------|
| `draft`(`eagle_worker.py:757`) | 用草稿模型猜出候选 token 树 |
| `draft_forward`(`:847`) | 草稿模型前向 |
| `verify`(`eagle_worker.py:931`) | 目标模型并行验证草稿,接受合法前缀 |
| `forward_draft_extend`(`:1102`) | 把已接受的 token 喂回草稿模型、更新其状态 |
| `forward_draft_extend_after_decode`(`:1142`) | decode 之后的草稿状态扩展 |

EAGLE 的草稿和验证都有专门的 **CUDA graph**:`eagle_draft_cuda_graph_runner.py`、`eagle_draft_extend_cuda_graph_runner.py`——草稿前向的形状和普通 decode 不同,要单独捕获图。

`speculative/` 下还有 EAGLE 的进阶版本:`eagle_worker_v2.py`、`multi_layer_eagle_worker.py`(多层草稿头)、`multi_layer_eagle_worker_v2.py`。

## 4. N-gram:不要模型,查历史

EAGLE 要训练草稿模型。有没有**零训练成本**的草稿来源?有——**N-gram**。

N-gram 投机的思路:在已经生成的文本(以及 prompt)里,找和「当前上下文」匹配的 n-gram,把它后面跟过的 token 拿来当草稿。比如上下文以 "the United" 结尾,而前文出现过 "the United States",那就猜下一个是 "States"。

这对**有大量重复/可预测内容**的场景特别有效——代码生成、长文档改写、结构化输出里大量 token 是「抄」上下文的。N-gram 命中这些时,草稿几乎零成本、命中率还高。

实现在 `speculative/ngram_worker.py`、`ngram_info.py`,底层 n-gram 匹配有 C++ 实现 `speculative/cpp_ngram/`。`external_corpus_manager.py` 支持从外部语料库找 n-gram(对应 [第 03 章](03-http-server.md) 提到的 `/add_external_corpus` 接口)。

## 5. MTP 与其他变体

**MTP(Multi-Token Prediction,多 token 预测)**:有些模型(如 DeepSeek 系)在训练时就带了「一次预测多个 token」的能力——模型本身有 MTP 头。SGLang 用 `frozen_kv_mtp_worker.py` 等支持:利用模型自带的 MTP 头产生草稿,KV「冻结」(frozen)以复用。配套 `frozen_kv_mtp_cuda_graph_runner.py`、`frozen_kv_mtp_info.py`。

其他变体:`dflash_worker.py`(decode flash)、`standalone_worker.py`(独立草稿模型)。所有 worker 都基于统一基类 `base_spec_worker.py`,通过 `spec_registry.py` 注册——和注意力后端、grammar 后端一样的可插拔模式。`adaptive_spec_params.py`、`adaptive_runtime_state.py` 支持**自适应**地调整投机参数(命中率低时少猜、高时多猜)。

## 6. 与调度器、注意力的集成

投机解码不是独立模块,它改变了 decode 一步的形态,所以和多处耦合:

- **调度器**([第 08 章](08-scheduler.md)):`get_next_batch_to_run`、`run_batch` 里有 `spec_algorithm` 判断。投机解码开启时,decode 批的「一步」是 draft+verify,不是普通前向;
- **注意力后端**([第 10 章](10-attention-backends.md)):verify 阶段一次验证多个(树状)token,注意力的形状特殊,需要后端支持(`eagle_info.py` 准备这些元数据);
- **采样**([第 11 章](11-sampling-constrained.md)):verify 的接受判定本质是一种采样方案,要保证分布不变;
- **统计指标**:`accept_rate`、`accept_length`、`spec_verify_ct`(verify 累计次数)等指标,通过 `SpeculativeDecodingMetricsMixin`(`io_struct.py:85`)随输出带回(见 [第 05 章](05-request-data-structures.md))。

## 7. 什么时候用投机解码

投机解码不是免费午餐:

- **有收益**:decode 是显存带宽瓶颈(batch 不大、模型大),且草稿命中率高(可预测内容多)。这时一步赚多个 token,延迟显著下降。
- **收益小甚至负**:batch 已经很大、GPU 算力已经吃满(此时多算草稿反而抢算力);或草稿命中率很低(每步都白猜)。

所以 SGLang 提供自适应机制,并把投机算法做成可选、可切换——按负载特征决定用不用、用哪种。

## 相关章节

- [第 08 章 调度器与连续批处理](08-scheduler.md) —— 投机 decode 在调度循环里的位置
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— 草稿/验证的前向与 CUDA graph
- [第 10 章 注意力后端与 CUDA 内核](10-attention-backends.md) —— verify 阶段的注意力
- [第 11 章 采样与约束解码](11-sampling-constrained.md) —— 接受判定与分布保真
- [导览步骤 17](tour-17-decode-loop.md) —— 普通 decode 循环(投机解码替换的对象)
