# Trace 步骤 09 —— embedding + LlamaDecoderLayer 循环怎么走？

> 进入模型 forward 内部。在这之前都在做调度/内存/metadata；从这一步开始关心**纯 PyTorch / kernel 层面**：张量怎么穿过一层又一层。

## 1. 当前情境

上一步（08）结束时 GPUModelRunner 已经准备好：

- `input_ids`：`[4]` 的 GPU int 张量（4 个 prefill token）
- `positions`：`[0, 1, 2, 3]`
- `attn_metadata`：FlashAttentionMetadata，里面有 `query_start_loc / seq_lens / block_table / slot_mapping / max_query_len / scheduler_metadata`
- forward context 通过上下文管理器注入，让每个 `Attention` 层能用 `get_forward_context().attn_metadata` 取到 metadata

GPUModelRunner 调到 `self.model(input_ids, positions, intermediate_tensors=None, inputs_embeds=None)`，进入 `LlamaForCausalLM.forward`。

## 2. 问题

模型 forward 是最热的代码，每个 step 都跑一遍。骨架跟 HuggingFace 的 `modeling_llama.py` 很像，但有几处差异不是凭直觉能猜到的：

- 为什么 embedding 不是 `nn.Embedding`，而是更复杂的 `VocabParallelEmbedding`？
- 为什么 `LlamaDecoderLayer.forward` 的签名里多了一个 `residual` 参数，并且 RMSNorm 吃两个张量、吐两个张量？
- 为什么 `LlamaModel` 上面挂了一个 `@support_torch_compile`？

这些都是为了让 forward 在 **TP 切分 + torch.compile + CUDA graph** 三个约束下还能跑得快。本步铺清楚它们，然后跟着 trace 走到"第 0 层 attention 入口"为止；attention 内部留给下一步。

## 3. 朴素思路

照 HuggingFace 直接搬：

```python
class NaiveLlamaModel(nn.Module):
    def forward(self, input_ids):
        x = self.embed_tokens(input_ids)
        for layer in self.layers:
            x = layer(x)
        return self.norm(x)

class NaiveDecoderLayer(nn.Module):
    def forward(self, x):
        x = x + self.self_attn(self.input_layernorm(x))
        x = x + self.mlp(self.post_attention_layernorm(x))
        return x
```

干净、纯函数式 dataflow。

## 4. 为什么朴素思路会崩

三处会崩：

**(a) 单卡放不下的模型**。`nn.Embedding` 没有"按 vocab 维切片再 all-reduce"语义；70B 类模型必须 TP 切。

**(b) 中间态张量浪费**。`x + self.self_attn(...)` 每次新建 residual 张量；`LayerNorm` 又读一次 `x` 写一次输出。Llama 的 LN-before-attention 结构理论上可以把 `add + RMSNorm` 合到一个 kernel——朴素写法做不到，多一次张量分配 + 多走一遍 `[num_tokens, hidden]` 的 HBM。

**(c) torch.compile 友好度差**。vllm 想把整段 forward 编进 inductor 图、切成 piecewise CUDA graph（attention 是 break point）。这要求：dynamic dim 标清楚；attention 作为图的裂缝，外面是连续的 fused kernel。朴素 forward 不标 dynamic dim，编出的图复用不了。

## 5. vllm 的做法

### 5.1 入口和编译装饰器

`vllm/model_executor/models/llama.py:565-575` 的 `LlamaForCausalLM.forward` 只做转发到 `self.model`（即 `LlamaModel`）。关键在 `LlamaModel` 头上的装饰器（llama.py:340-349）：

```python
@support_torch_compile(
    dynamic_arg_dims={
        "input_ids": {0: "b"},
        "positions": {0: "b"},
        "intermediate_tensors": {0: "b"},
        "inputs_embeds": {0: "b"},
    },
)
class LlamaModel(nn.Module, EagleModelMixin):
```

这告诉 vllm 编译框架：把整个 `LlamaModel.forward` 编进 inductor 图，第 0 维（token 数）动态，其它维度静态。框架内部把每个 `Attention.forward` 当作图边界——attention 内部从图里挖洞出来，外面（embedding / linear / RMSNorm / MLP / RoPE）合并成连续 fused block。这就是 piecewise CUDA graph 的来源。

### 5.2 embedding：`VocabParallelEmbedding`

`llama.py:368-377` 注册 embed：

```python
if get_pp_group().is_first_rank or (config.tie_word_embeddings and get_pp_group().is_last_rank):
    self.embed_tokens = VocabParallelEmbedding(self.vocab_size, config.hidden_size, quant_config=quant_config)
```

`VocabParallelEmbedding.forward`（`vllm/model_executor/layers/vocab_parallel_embedding.py:470-490`）：

```python
def forward(self, input_):
    if self.tp_size > 1:
        masked_input, input_mask = get_masked_input_and_mask(input_, ...)
    else:
        masked_input = input_
    output_parallel = self.quant_method.embedding(self, masked_input.long())
    if self.tp_size > 1:
        output_parallel.masked_fill_(input_mask.unsqueeze(-1), 0)
    output = tensor_model_parallel_all_reduce(output_parallel)
    return output
```

本 trace 是 TP=1，整段近似退化为 `F.embedding(input_ids, weight)`。但代码统一走 `VocabParallelEmbedding`：

- vocab 维切分最自然（vocab ~150K，hidden ~4K）
- 切完每个 rank 只持有自己 vocab 段对应的行；对不属于自己段的 `token_id` 要 mask 掉再 all-reduce
- 同一份代码两套用法：TP=1 是 no-op；TP>1 是核心路径

`get_masked_input_and_mask` 上挂了 `@torch.compile(dynamic=True)`（vocab_parallel_embedding.py:162），让 mask 几个 pointwise op 融成一个 kernel。

走完 embedding，得到 `hidden_states`，shape `[4, hidden_size]`，dtype bf16。

### 5.3 主循环 + `residual`

`llama.py:395-434` 的 `LlamaModel.forward` 主体：

```python
if get_pp_group().is_first_rank:
    hidden_states = self.embed_input_ids(input_ids) if inputs_embeds is None else inputs_embeds
    residual = None
else:
    hidden_states = intermediate_tensors["hidden_states"]
    residual = intermediate_tensors["residual"]

for idx, layer in enumerate(islice(self.layers, self.start_layer, self.end_layer)):
    hidden_states, residual = layer(positions, hidden_states, residual, **extra_layer_kwargs)

if not get_pp_group().is_last_rank:
    return IntermediateTensors({"hidden_states": hidden_states, "residual": residual})

hidden_states, _ = self.norm(hidden_states, residual)
return hidden_states
```

注意：`residual` 一开始是 `None`；每层返回 `(hidden_states, residual)` **两个张量**；非 last PP rank 把 IntermediateTensors 直接抛给下一个 rank。

### 5.4 `LlamaDecoderLayer.forward` 与 fused add + RMSNorm

`llama.py:316-333`：

```python
def forward(self, positions, hidden_states, residual):
    if residual is None:
        residual = hidden_states
        hidden_states = self.input_layernorm(hidden_states)
    else:
        hidden_states, residual = self.input_layernorm(hidden_states, residual)
    hidden_states = self.self_attn(positions=positions, hidden_states=hidden_states)

    hidden_states, residual = self.post_attention_layernorm(hidden_states, residual)
    hidden_states = self.mlp(hidden_states)
    return hidden_states, residual
```

第 0 层走 `residual is None` 分支（普通 RMSNorm）；从第 1 层开始一直走 fused add + RMSNorm 分支。RMSNorm 的 fused 实现在 `vllm/model_executor/layers/layernorm.py:82-102`：

```python
if residual is None:
    return ir.ops.rms_norm(x, weight, eps, var_override)
else:
    return ir.ops.fused_add_rms_norm.maybe_inplace(x, residual, weight, eps, var_override)
```

`fused_add_rms_norm.maybe_inplace` 把 `residual = residual + x; out = rms_norm(residual)` 合到一个 kernel：读一次 `x` 和 `residual`、写一次 `residual` 和 `out`，没有中间张量。返回的 `residual` 是更新后的——下一层的 `input_layernorm` 又可以原地再加一次。整条 layer 循环里，residual 从头到尾都是同一块显存被反复 in-place 累加。

这就是为什么 `LlamaDecoderLayer.forward` 必须返回 `(hidden_states, residual)`——不是算法需要，是为了**让 fused 算子能链起来**。

### 5.5 走到 attention 入口

本步只跟"第 0 层"走到 `self.self_attn(...)` 调用**之前**就停。此时手里：

- `hidden_states`：`[4, hidden_size]`，是 `input_layernorm` 之后的张量
- `residual`：`[4, hidden_size]`，等于原始 embedding（第 0 层走 `residual is None` 分支，第一句把 hidden_states 备份给 residual 再做 norm）
- `positions`：`[0, 1, 2, 3]`

下一步进 `self.self_attn`，也就是 `LlamaAttention.forward`（llama.py:223-233）——QKV proj、RoPE、PagedAttention kernel 都在那里。

## 6. 代码位置

- 入口：`vllm/model_executor/models/llama.py::LlamaForCausalLM.forward`（llama.py:565-575）
- 主循环：`LlamaModel.forward`（llama.py:395-434）
- DecoderLayer：`LlamaDecoderLayer.forward`（llama.py:316-333）
- Embedding：`vllm/model_executor/layers/vocab_parallel_embedding.py::VocabParallelEmbedding.forward`（vocab_parallel_embedding.py:470-490）
- mask 计算：`vocab_parallel_embedding.py:162-187`
- RMSNorm：`vllm/model_executor/layers/layernorm.py::RMSNorm.forward_native`（layernorm.py:82-102）
- `@support_torch_compile` 定义：`vllm/compilation/decorators.py`；应用点 `llama.py:340-349`

**阅读顺序**：`LlamaModel.forward` 主循环 → `LlamaDecoderLayer.forward` 注意 residual 的两个分支 → `RMSNorm.forward_native` 看两个分支为何共享同一签名 → `VocabParallelEmbedding.forward` 看 mask + all_reduce（TP=1 时近似 no-op）。

## 7. 分支与延伸

- **`tie_word_embeddings = True`** → 共享 weight 的 rank 要本地持有 `embed_tokens`，下一步（11）lm_head 那边复用同一份 weight → 第 8 章 §3
- **多模态模型**走 `inputs_embeds is not None` 分支——图像编码后直接喂到 embedding 之后的位置 → 第 8 章 §3
- **Gemma / Phi / Qwen-VL** 等模型族走类似 layer 列表结构，但 RMSNorm 公式略不同（如 GemmaRMSNorm 用 `x * (1 + w)`）；公共层库就是为了让差异只改 1-2 个 class → 第 8 章 §4
- **PP**：`is_first_rank / is_last_rank` 分支决定是否做 embed / final norm；中间 rank 只跑 layer 子集，返回 IntermediateTensors → 第 10 章
- **LoRA** 怎么改 embed？`VocabParallelEmbedding` 文档（vocab_parallel_embedding.py:192-229）描述了 base + LoRA 追加 vocab 的内存布局——LoRA 部分总在分片末尾 → 第 11 章 LoRA 小节
- **`@support_torch_compile`** 内部把 `Attention.forward` 注册为图边界，从而切出 piecewise CUDA graph → 第 6 章 §1 / §11 + 第 7 章 §12

## 8. 走完这一步你脑子里应该多了什么

1. 模型 forward 的骨架是 `embed → for layer in layers → final norm`，但 vllm 每个环节都为"TP + torch.compile + CUDA graph"做了让步
2. `VocabParallelEmbedding` 在 TP=1 时是 thin wrapper；TP>1 时通过 `mask + lookup + all_reduce` 完成 vocab 切片——同一份代码两套用法
3. `LlamaDecoderLayer.forward` 多带 `residual` 参数、返回 `(hidden_states, residual)` 是为了让 `fused_add_rms_norm` 在层与层之间链起来，省一次张量分配 + 一次读写
4. `@support_torch_compile` 是 vllm 编译框架的入口；每个 `Attention` 层会变成 piecewise CUDA graph 的 break point，所以 attention 之外的 layer 代码必须对编译友好（dynamic dim 标清楚、没有 host fallback）
