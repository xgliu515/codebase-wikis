# Trace 步骤 11 —— final norm + lm_head → logits

> 模型 forward 的最后一段。从这里出去的就是 vocab-size 的 logits，喂给 sampler 选下一个 token。

## 1. 当前情境

上一步从第 0 层一路走完了所有 N 层 decoder layer（Qwen2.5-7B 有 28 层）。手里的张量：

- `hidden_states`：`[4, hidden_size]`（4 个 prefill token，每个一个 hidden vector），bf16
- `residual`：`[4, hidden_size]`，最后一层 MLP 之后但**还没加到 hidden_states**——`LlamaDecoderLayer.forward` 返回的是分离的两份，让最后一次 add 跟 final RMSNorm 也能 fuse
- KV cache：所有 28 层的 K/V 都已写到对应物理 block
- `logits_indices`：`[1]`，值 `[3]`——只有"最后一个 token 位置（index=3）"需要算 logits
- `attn_metadata` 已经不再用，但还挂在 forward context 里

代码上正在 `LlamaModel.forward`（`vllm/model_executor/models/llama.py:395-434`）的尾巴。`LlamaModel.forward` 返回 `hidden_states`（**所有 4 个 token 位置都返回**）给 `LlamaForCausalLM.forward`（llama.py:565-575），后者原样转回给 GPUModelRunner。然后 runner 调 `compute_logits` 算 logits。

## 2. 问题

到这里有三件事要做：

1. **final RMSNorm**：把最后一层 attention block 的输出归一化
2. **lm_head**：`[seq_len, hidden_size] → [seq_len, vocab_size]`（vocab ~150K、hidden ~4K——这是模型里最大的 GEMM 之一）
3. **挑出"需要"的位置**：本 trace 是 prefill 4 个 token，但 greedy 只关心第 4 个 token 的下一个 token——前 3 个位置的 logits 是浪费

第 3 点是隐藏的设计选择：要不要把全部 4 个位置都算 logits？如果都算，浪费 75% 算力；如果只算最后一个，又得跟 decode（每个 token 都要 logits）、spec decode（每个 draft token 都要）、prompt logprobs（所有位置）等多种模式共存。vllm 怎么处理？

## 3. 朴素思路

照 HuggingFace 写法：

```python
hidden_states = self.norm(hidden_states)
logits = self.lm_head(hidden_states)     # [4, vocab_size]
last_token_logits = logits[-1]            # 只取最后一个
```

或反过来——先切片再算：

```python
hidden_states = self.norm(hidden_states)
last_hidden = hidden_states[-1:]          # [1, hidden_size]
logits = self.lm_head(last_hidden)        # [1, vocab_size]
```

后者明显更优（GEMM 输入小了 4 倍），但只在 prefill + greedy 这种"每 request 只关心最后一个位置"时成立。

## 4. 为什么朴素思路会崩

prefill + greedy 用"先切再算"很合理，但 vllm 要同时支持的场景多了去了：

- **decode**：每个 request 本 step 算 1 个新 token；要算的位置就是这 1 个
- **chunked prefill**：长 prompt 分多次 step 跑；前几次 step 不需要 logits，最后 chunk 才需要
- **spec decode**：本 step 可能算 `1 (decode) + k (draft)` 个位置，每个位置都要 logits
- **prompt logprobs**：用户开了 `logprobs` 要求返回 prompt 每个位置的 logprob——所有位置都要算
- **pooling 模型**：根本不需要 lm_head，要的是 hidden_states 本身

把"该取哪些位置"硬编码到模型代码里就死路一条；得有一个跟模型无关的统一索引机制。

## 5. vllm 的做法

### 5.1 logits_indices：调度时算好的位置索引

`vllm/v1/worker/gpu_model_runner.py:2102` 一句话：

```python
logits_indices = query_start_loc[1:] - 1
```

`query_start_loc` 是 attention metadata 早算好的 cumulative query length（`[num_reqs + 1]`），比如 4-token prefill 单 request batch 是 `[0, 4]`；2 个 request、每个 decode 1 token 是 `[0, 1, 2]`。`[1:] - 1` 就拿到每个 request 的最后一个 token 在拼接 batch 里的下标：

- 单 prefill 4 token：`logits_indices = [3]`
- 单 decode 1 token：`logits_indices = [0]`
- 一 prefill (4 token) + 一 decode：`logits_indices = [3, 4]`

这就是 vllm 处理"每个 request 只关心最后一个位置"的统一方式——**调度阶段算好索引；模型 forward 完整算所有 token 的 hidden；用索引切片**。

spec decode 时位置不止"最后一个"——`logits_indices = spec_decode_metadata.logits_indices`（gpu_model_runner.py:2128），对每个 request 的 draft + bonus 位置都生成一个索引。这就把"哪些位置要 sample"这个**调度层决策**和"算 logits"这个**模型层操作**完全解耦了。

### 5.2 final RMSNorm

`LlamaModel.forward` 最后一句（llama.py:430）：

```python
hidden_states, _ = self.norm(hidden_states, residual)
```

`self.norm = RMSNorm(config.hidden_size, eps=config.rms_norm_eps)`（llama.py:384）。注意传了**两个**张量——跟前面 `post_attention_layernorm(hidden_states, residual)` 一致——走 fused add + RMSNorm 路径（`vllm/model_executor/layers/layernorm.py:95-102`）。一次性把"最后一次 residual add"和"最后一次 RMSNorm"合到一个 kernel。返回的 `hidden_states` 是 `[4, hidden_size]`（所有 token 都做 norm；切片是后面的事）。第二个返回值丢弃。

### 5.3 切片：`hidden_states[logits_indices]`

`vllm/v1/worker/gpu_model_runner.py:4208`：

```python
sample_hidden_states = hidden_states[logits_indices]
logits = self.model.compute_logits(sample_hidden_states)
```

**先切片再算 lm_head**。切片在 model forward **返回之后**才做——模型 forward 内部所有 layer 都算了全部 4 个位置的 hidden（不可避免，attention 内部需要全序列的 K/V）；只有"hidden → logits"这个大 GEMM 才用切片。

对单 prefill 的 trace，`logits_indices = [3]`，`sample_hidden_states.shape = [1, hidden_size]`。lm_head 的 GEMM 输入是 `[1, hidden_size]`，输出 `[1, vocab_size]`——只算了原本 1/4 的算力。

### 5.4 lm_head：`ParallelLMHead` + `LogitsProcessor`

`LlamaForCausalLM.compute_logits`（llama.py:577-582）：

```python
def compute_logits(self, hidden_states):
    logits = self.logits_processor(self.lm_head, hidden_states)
    return logits
```

`self.lm_head` 是 `ParallelLMHead`（`vllm/model_executor/layers/vocab_parallel_embedding.py:503`），继承自 `VocabParallelEmbedding`——共用 vocab 切分逻辑。它本身**不直接 `forward`**（vocab_parallel_embedding.py:565-567 是 raise RuntimeError 的占位）；真正用它的是 `LogitsProcessor`。

`LogitsProcessor.forward`（`vllm/model_executor/layers/logits_processor.py:54-73`）调 `_get_logits`（logits_processor.py:89-104）：

```python
def _get_logits(self, hidden_states, lm_head, embedding_bias):
    logits = lm_head.quant_method.apply(lm_head, hidden_states, bias=embedding_bias)
    logits = self._gather_logits(logits)
    if logits is not None:
        logits = logits[..., : self.org_vocab_size]
    return logits
```

三件事：
- `lm_head.quant_method.apply(...)`：本质 `hidden_states @ lm_head.weight.T`（unquantized 时走 `UnquantizedEmbeddingMethod.apply`，vocab_parallel_embedding.py:67-75），输出 `[1, vocab_per_partition]`
- `_gather_logits`（logits_processor.py:75-87）：TP > 1 时把各 rank 的 vocab 段 gather/all-gather 成完整 `[1, vocab_size_padded]`；TP = 1 是 no-op
- `[..., : self.org_vocab_size]`：去掉 padding（VocabParallelEmbedding 为了让 vocab_size 整除 TP 数会 pad 到 64 的倍数）

接着 `LogitsProcessor.forward` 还会做可选 soft cap（`logits = tanh(logits/cap) * cap`）和 `scale`（logits_processor.py:66-72）。走完，`logits.shape = [1, vocab_size]`，dtype 通常 bf16，在 GPU 上。

### 5.5 tied embedding：lm_head.weight 跟 embed_tokens 共享

`LlamaForCausalLM.__init__`（llama.py:533-541）：

```python
if get_pp_group().is_last_rank:
    self.lm_head = ParallelLMHead(config.vocab_size, config.hidden_size, quant_config=quant_config, prefix=maybe_prefix(prefix, "lm_head"))
    if config.tie_word_embeddings:
        self.lm_head = self.lm_head.tie_weights(self.model.embed_tokens)
```

`ParallelLMHead.tie_weights`（vocab_parallel_embedding.py:556-563）直接把 `lm_head.weight` 指向 `embed_tokens.weight`（**共享同一块显存**）。Qwen2.5-7B 的 config 是 `tie_word_embeddings = False`（7B 这种规模一般独立），但很多小模型（Qwen2.5-0.5B、Gemma-2B、Llama-3.2-1B）会 `tie_word_embeddings = True`——对小模型这块 `vocab_size * hidden_size` 的权重往往占总参数量 20% 以上。

配套地，`LlamaForCausalLM.load_weights`（llama.py:584-589）把 `lm_head.` 加进 skip_prefixes：

```python
loader = AutoWeightsLoader(
    self,
    skip_prefixes=(["lm_head."] if self.config.tie_word_embeddings else None),
)
```

加载权重时跳过 `lm_head.weight`（因为它 = `embed_tokens.weight`，加载 embed_tokens 时已经填进去）。

### 5.6 走到 sampler 入口

`logits` 和 `sample_hidden_states` 一起被打包进 `ExecuteModelState`（gpu_model_runner.py:4240-4251）。后续 step 会从这里取出 `logits` 喂给 sampler——下一步（12）的主题。

## 6. 代码位置

- model 出口：`vllm/model_executor/models/llama.py::LlamaModel.forward` 的尾巴（llama.py:425-434）
- LM head 注册：`LlamaForCausalLM.__init__`（llama.py:533-541）+ `compute_logits`（llama.py:577-582）
- `ParallelLMHead`：`vllm/model_executor/layers/vocab_parallel_embedding.py:503-567`；tie_weights：`vocab_parallel_embedding.py:556-563`
- logits 主流程：`vllm/model_executor/layers/logits_processor.py::LogitsProcessor`（整个文件）
- final RMSNorm：`vllm/model_executor/layers/layernorm.py::RMSNorm.forward_native`（layernorm.py:82-102，走 residual is not None 分支）
- logits_indices 计算：`vllm/v1/worker/gpu_model_runner.py:2095-2148`（prefill / decode / spec 三分支）
- 切片 + compute_logits：`gpu_model_runner.py:4208-4209`
- 权重加载跳过 lm_head：`llama.py:584-589`

**阅读顺序**：先看 `gpu_model_runner.py:2102` 体会 `logits_indices` 怎么从 `query_start_loc` 算出来 → 跳到 `gpu_model_runner.py:4208` 看"切片 + compute_logits"两行 → `LlamaForCausalLM.compute_logits` → `LogitsProcessor.forward` → `_get_logits`；最后翻 `tie_weights` + `load_weights` skip_prefixes 理解 tied embedding。

## 7. 分支与延伸

- **`tie_word_embeddings = True`**（小模型常用）：lm_head 跟 embed_tokens 共享 weight，省 ~20% 参数；要求 lm_head 跟 embed 在同一个 PP rank → 第 8 章 §3
- **prompt logprobs**：`SamplingParams(prompt_logprobs=k)` 要求返回 prompt 内每个位置的 top-k logprobs；`logits_indices` 需要包含 prompt 内所有位置 → 第 9 章
- **spec decode**：`logits_indices = spec_decode_metadata.logits_indices`，对每个 request 算 `(num_draft + 1)` 个位置；verify 比较 draft 和真 sample 是否一致 → 第 11 章 spec decode
- **chunked prefill 中间 chunk**：scheduler 把 `num_sampled_tokens` 设为 0；comments 在 gpu_model_runner.py:2097-2102 提到 "for simplicity 都算了再丢" → 第 4 章 §3
- **pooling / embedding 模型**：走 `gpu_model_runner.py:4199-4206` 的 `self._pool(...)`，根本不调 `compute_logits` → 第 8 章 §3
- **Gemma 系的 soft cap**：`final_logit_softcapping` 让 `LogitsProcessor.forward` 走 `soft_cap` 分支（logits_processor.py:66-69），tanh 把 logits 压到 `[-cap, cap]` → 第 8 章 §3
- **TP 优化的 argmax**：`LogitsProcessor.get_top_tokens`（logits_processor.py:106-156）专给"greedy + TP > 1"——每 rank 本地 argmax，只 all-gather `(value, index)` 而不是 `[batch, vocab_size]`；通信量从 O(batch * vocab) 降到 O(batch * 2 * tp_size) → 第 9 章 §4
- **batch invariant 模式**：`VLLM_BATCH_INVARIANT` 让 lm_head GEMM 走 `linear_batch_invariant` 路径（vocab_parallel_embedding.py:73-74），牺牲性能换 batch size 无关的确定性 → 第 9 章

## 8. 走完这一步你脑子里应该多了什么

1. 模型 forward 内部**一定算了所有 token 位置的 hidden**——attention 自身的因果性决定了这一点；省算的地方是 hidden → logits 这个大 GEMM，通过 `logits_indices` 切片让 lm_head 只对"要 sample 的位置"算
2. `logits_indices` 是 vllm 解耦"模型层算啥"和"调度层用啥"的核心机制——`query_start_loc[1:] - 1` 给 prefill/decode 通用情况，spec decode 走专门构造的索引；模型代码完全不感知
3. final RMSNorm 跟 layer 里的 post-attention RMSNorm 是同一个 fused-add-RMSNorm kernel——`(hidden_states, residual)` 两个参数到最后一次还能用上
4. `lm_head` 通过 `ParallelLMHead`（继承 VocabParallelEmbedding）+ `LogitsProcessor` 配合：前者持有按 vocab 切分的 weight，后者负责"GEMM + TP gather + 去 padding + 可选 soft cap"。tied embedding 时 weight 是同一块显存，靠 `skip_prefixes` 在加载时跳过 lm_head 自身的权重项
