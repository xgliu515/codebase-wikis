# 第 11 章 高级特性总览

本章按 "目的 → 算法/原理 → 代码入口 → 关键配置 → 已知限制" 五段结构，逐一拆解 vLLM 提供的高级特性。每个小节既可作为独立参考，也可作为前面章节（调度器、KV cache、模型执行）的扩展阅读。所有 `file:line` 引用均针对仓库 `main` 分支当前版本。

---

## 11.1 Speculative Decoding（投机解码）

### 11.1.1 目的

自回归解码每生成一个 token 都要执行一次完整的 LLM 前向。Memory bandwidth 远比算力先成为瓶颈，所以 batch=1 的 decode 阶段 GPU 利用率经常只有 5%-15%。投机解码用一个 "便宜" 的 drafter 一次提议 K 个 token，再用 "贵" 的 target 模型对 K+1 个位置做一次并行前向校验：吞吐保持不变（同样一次大模型前向），但每步进度可以是 1~K+1 个 token。

### 11.1.2 算法

vLLM 实现严格遵循 Chen et al. (2023) [https://arxiv.org/abs/2211.17192](https://arxiv.org/abs/2211.17192)。每个调度步内部分四个阶段：

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="投机解码单步的四个阶段">
  <defs>
    <marker id="ar11a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">投机解码单步的四个阶段</text>
  <g transform="translate(20, 60)">
    <rect x="0" y="0" width="160" height="80" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="80" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">draft</text>
    <text x="80" y="42" text-anchor="middle" font-size="10" fill="#9a3412">drafter 出 K 个候选</text>
    <text x="80" y="56" text-anchor="middle" font-size="10" fill="#9a3412">q_1, q_2, ..., q_K</text>
    <text x="80" y="72" text-anchor="middle" font-size="9" fill="#c2410c">便宜（ngram/EAGLE/MTP）</text>
  </g>
  <path d="M 180 100 L 208 100" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11a)"/>
  <g transform="translate(210, 60)">
    <rect x="0" y="0" width="160" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="80" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">target FW</text>
    <text x="80" y="42" text-anchor="middle" font-size="10" fill="#115e59">大模型 1 次 forward</text>
    <text x="80" y="56" text-anchor="middle" font-size="10" fill="#115e59">算 K+1 个分布 p_i</text>
    <text x="80" y="72" text-anchor="middle" font-size="9" fill="#0f766e">贵但只跑一次</text>
  </g>
  <path d="M 370 100 L 398 100" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11a)"/>
  <g transform="translate(400, 60)">
    <rect x="0" y="0" width="160" height="80" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="80" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">rejection sampling</text>
    <text x="80" y="42" text-anchor="middle" font-size="10" fill="#5b21b6">P(accept) = min(1, p/q)</text>
    <text x="80" y="56" text-anchor="middle" font-size="10" fill="#5b21b6">拒绝则从修正分布重采</text>
    <text x="80" y="72" text-anchor="middle" font-size="9" fill="#6d28d9">等价采样、无损质量</text>
  </g>
  <path d="M 560 100 L 588 100" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11a)"/>
  <g transform="translate(590, 60)">
    <rect x="0" y="0" width="160" height="80" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="80" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">append</text>
    <text x="80" y="42" text-anchor="middle" font-size="10" fill="#075985">accepted + bonus 入 seq</text>
    <text x="80" y="56" text-anchor="middle" font-size="10" fill="#075985">每步 1 ~ K+1 个 token</text>
    <text x="80" y="72" text-anchor="middle" font-size="9" fill="#0284c7">throughput 同，进度更快</text>
  </g>
  <g transform="translate(20, 160)">
    <rect x="0" y="0" width="730" height="44" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
    <text x="365" y="20" text-anchor="middle" font-size="11" fill="#64748b">核心收益：一次大模型 forward 推进 1 ~ K+1 个 token，而非 1 个 → memory-bound 的 decode 阶段被提升至更接近 compute-bound</text>
    <text x="365" y="36" text-anchor="middle" font-size="10" fill="#94a3b8">全部 K 接受时还从 p_{K+1} 多采一个 bonus（top_p / top_k 只对 bonus 生效，K 个 spec token 退化为 greedy/温度采样）</text>
  </g>
</svg>
<span class="figure-caption">图 R11.1 ｜ 投机解码 (Chen et al. 2023) 的四步单步：draft 出 K → target forward K+1 位置 → rejection sampling 决定接受/重采 → 接受序列 + bonus 写回</span>

<details>
<summary>ASCII 原版</summary>

```
+-------+   +-----------+   +----------+   +------------------+
| draft | → | target FW | → | rejection| → | append accepted  |
| K toks|   | (K+1 pos) |   | sampling |   | + bonus to seqs  |
+-------+   +-----------+   +----------+   +------------------+
```

</details>

- **draft tokens**：drafter 对当前 sequence 提出 K 个候选 `q_i(x)`。
- **target FW**：target 模型对 `[ctx | q_1, ..., q_K]` 一次性算出 `p_1, ..., p_{K+1}`（共 K+1 个分布；最后一个是 bonus 位置）。
- **接受规则**：对位置 i，以概率 `min(1, p_i(q_i) / q_i(q_i))` 接受 `q_i`；一旦拒绝，从修正分布 `norm(max(0, p_i - q_i))` 重新采样一个 "recovered" token，然后中止该序列在本步的扩展。
- **bonus token**：如果全部 K 个都被接受，从 `p_{K+1}` 直接采样一个额外的 bonus token。

vLLM 把 bonus token 的采样下放给标准 `Sampler`，因此 `top_p / top_k` 等只对 bonus 生效；其余 K 个位置只支持 greedy/temperature/penalty 的子集（见 `rejection_sampler.py:42` 注释）。

核心 kernel 入口（`vllm/v1/sample/rejection_sampler.py:392`）：

```python
def rejection_sample(draft_token_ids, num_draft_tokens, max_spec_len,
                     cu_num_draft_tokens, draft_probs, target_logits,
                     bonus_token_ids, sampling_metadata, ...):
    output_token_ids = torch.full((batch_size, max_spec_len + 1),
                                  PLACEHOLDER_TOKEN_ID, dtype=torch.int32)
    if not sampling_metadata.all_random:           # greedy 子集
        target_argmax = target_logits.argmax(dim=-1)
        rejection_greedy_sample_kernel[(batch_size,)](
            output_token_ids, cu_num_draft_tokens, draft_token_ids,
            target_argmax, bonus_token_ids, ...)
    if sampling_metadata.all_greedy:
        return output_token_ids
    target_probs = target_logits.softmax(dim=-1, dtype=torch.float32)
    rejection_random_sample_kernel[...](...)
    return output_token_ids
```

Greedy 子集走 `argmax` 加速：drafter 与 target 的 argmax 一致即接受；否则取 target argmax 作为 "recovered"。Random 子集才真正运行接受-拒绝采样（`rejection_random_sample_kernel` 在 `vllm/v1/sample/rejection_sampler.py:762`）。`SpecDecodeMetadata` （`vllm/v1/spec_decode/metadata.py:10`）携带 `target_logits_indices` 与 `bonus_logits_indices`，因为 target forward 的输出 logits 是把 K 个 draft 与 1 个 bonus 拼在一起做 indexing。

### 11.1.3 支持的 drafter

| Method | 实现类 | 思想 | 适用场景 |
| ------ | ------ | ---- | -------- |
| `ngram` | `NgramProposer` `vllm/v1/spec_decode/ngram_proposer.py:12` | 在已生成历史里查 n-gram，命中即复制后续 K 个 token | 长重复输出（代码补全、JSON 反序列化） |
| `[draft_model]` | `DraftModelProposer` `vllm/v1/spec_decode/draft_model.py:17` | 用一个完整的小型 LLM 做 K 次自回归 | 通用，但 drafter 内存占用高 |
| `eagle` / `eagle3` | `EagleProposer` `vllm/v1/spec_decode/eagle.py:10` | 把 target 隐藏状态喂给一个轻量 head；K 次串行 forward | 准确率高于纯 small-LLM |
| `medusa` | `MedusaProposer` `vllm/v1/spec_decode/medusa.py:18` | 多个独立 head 并行产生 K 个 token，无串行依赖 | latency 极敏感，可接受准确率折扣 |
| `mtp` / `dflash` / `gemma4` | `DFlashProposer`、`Gemma4Proposer` | Multi-Token Prediction：模型原生输出多个未来 token | DeepSeek-V3 系列、Gemma-4 |
| `suffix` | `SuffixDecodingProposer` `vllm/v1/spec_decode/suffix_decoding.py:9` | 共享后缀树缓存，按概率截断 | 多请求重复（agent、chat 模板） |
| `extract_hidden` | `ExtractHiddenStatesProposer` | 把 target hidden states 暴露给外部消费者，本身不出 token | 训练 EAGLE/Medusa head |
| custom | `create_custom_proposer` `vllm/v1/spec_decode/custom_class_proposer.py` | 通过 Python 路径注入第三方 proposer | 研究 |

所有 LLM 类 drafter 共享 `SpecDecodeBaseProposer`（`vllm/v1/spec_decode/llm_base_proposer.py:55`），统一处理 KV slot 分配、`pass_hidden_states_to_model`、并行 vs 串行 drafting。

### 11.1.4 与 scheduler / model runner 的耦合

- 调度阶段：`Scheduler` 在生成 `SchedulerOutput` 时附带每请求的 `scheduled_spec_decode_tokens`，参见 `vllm/v1/core/sched/scheduler.py:357`。`max_num_scheduled_tokens` 与 `max_num_batched_tokens` 分离（`config/scheduler.py:56`）——因为 spec decode 会动态多塞 K 个 token，token budget 需要预留。
- Worker 阶段：`GPUModelRunner` 把每条 sequence 扩展为 `[query] + [draft_1 ... draft_K]`，target forward 后调用 `RejectionSampler`（`vllm/v1/sample/rejection_sampler.py:37`）。
- KV cache：被拒绝位置的 KV 仍然写入，但 `num_computed_tokens` 通过 `update_num_computed_tokens_for_batch_change`（`vllm/v1/spec_decode/utils.py:567`）按实际接受长度回滚。
- Async spec decode：`use_async_spec_decode`（`vllm/v1/worker/gpu_model_runner.py:622`）允许 drafter 与下一步 target 调度重叠。

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="async spec decode 时序：drafter forward 与下一步 target 调度重叠">
  <defs>
    <marker id="ar11b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">async spec decode：drafter forward 与下一步 target 调度时间重叠</text>
  <line x1="60" y1="240" x2="720" y2="240" stroke="#94a3b8" stroke-width="1"/>
  <text x="730" y="244" font-size="10" fill="#64748b">t</text>
  <text x="60" y="56" font-size="11" font-weight="700" fill="#ea580c">target 流</text>
  <g transform="translate(120, 50)">
    <rect x="0" y="0" width="180" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="90" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">target_fw(ctx + drafts)</text>
    <rect x="200" y="0" width="80" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2" rx="4"/>
    <text x="240" y="22" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">sample</text>
    <rect x="290" y="0" width="60" height="36" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.2" rx="4"/>
    <text x="320" y="22" text-anchor="middle" font-size="10" font-weight="700" fill="#0c4a6e">commit</text>
    <rect x="380" y="0" width="220" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="490" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">target_fw(ctx' + new_drafts)</text>
  </g>
  <text x="270" y="100" text-anchor="middle" font-size="10" fill="#64748b">step t</text>
  <text x="610" y="100" text-anchor="middle" font-size="10" fill="#64748b">step t+1</text>
  <path d="M 440 90 L 500 130" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar11b)"/>
  <text x="60" y="156" font-size="11" font-weight="700" fill="#0d9488">drafter 流</text>
  <g transform="translate(440, 150)">
    <rect x="0" y="0" width="140" height="36" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
    <text x="70" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">drafter_fw</text>
  </g>
  <text x="510" y="200" text-anchor="middle" font-size="10" fill="#64748b">overlap：与 sample/commit 重叠</text>
  <g transform="translate(60, 250)">
    <rect x="0" y="0" width="690" height="22" fill="#f0fdf4" stroke="#86efac" rx="3"/>
    <text x="345" y="14" text-anchor="middle" font-size="10" fill="#166534">use_async_spec_decode：drafter 的 K 步串行 forward 不再阻塞 step 主线，被压到 sample/commit 的空隙</text>
  </g>
</svg>
<span class="figure-caption">图 R11.2 ｜ async spec decode 把 drafter forward 与下一步 target 调度重叠：step t 的 sample / commit 串口与 step t+1 的 draft 计算同时跑，掩盖串行 drafting 的延迟</span>

<details>
<summary>ASCII 原版</summary>

```
step t:
   target_fw(ctx+drafts) ─► sample ─► commit ─┐
                                              │     (overlap)
step t (async draft):                         │
                              drafter_fw  ◄───┘
                                  │
                                  ▼
step t+1: target_fw(ctx'+new_drafts) ─►...
```

</details>

EAGLE / draft-model 串行 drafting 时每个 K 都要重新进 KV cache，因此 EAGLE proposer 用 `eagle_step_update_slot_mapping_and_metadata`（`vllm/v1/spec_decode/utils.py:88`）边 forward 边写 slot mapping，避免单独 IO。`parallel_drafting=True` 把 K 步压缩成 1 步前向，要求模型本身 trained 在多输出位置上。

### 11.1.5 关键配置

`vllm/config/speculative.py:74` 中的 `SpeculativeConfig`：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `method` | 自动 | `ngram` / `eagle` / `medusa` / `draft_model` / `mtp` / `dflash` / `suffix` / 自定义 |
| `num_speculative_tokens` | 必填 | K，单步 propose 的 token 数 |
| `model` | None | draft model / EAGLE head HF id |
| `draft_tensor_parallel_size` | 与 target 同 | 只允许 1 或与 target TP 相同 |
| `prompt_lookup_min/max` | 1/N | n-gram 匹配窗口 |
| `parallel_drafting` | False | 让 EAGLE/draft 一次性出 K 个 token |
| `disable_padded_drafter_batch` | False | 关闭 padding，依赖支持 ragged 的 attention backend |
| `rejection_sample_method` | `standard` | `synthetic` 用预设接受率分布做 benchmarking |
| `suffix_decoding_*` | - | 后缀树深度、最大请求数、token 概率阈值 |

### 11.1.6 限制

- `top_p / top_k / min_p` 只对 bonus token 生效，对 K 个 spec token 等价 greedy/温度采样。
- draft TP 仅支持 1 或 target TP 相同（其他比例会引起 dynamo 缓存竞写，见 `draft_model.py:33`）。
- `parallel_drafting` 只支持 EAGLE 与 draft model，且 drafter 必须为 parallel-drafting 训练。
- Medusa 没有显式的接受率保证，吞吐提升来自较低的 head 计算开销，不是 rejection sampling 数学等价。

---

## 11.2 Quantization（量化）

### 11.2.1 目的

- 减少权重显存：FP16→INT4 节省 4×，是 70B-class 单卡推理的前提。
- 减少 HBM 带宽（decode 阶段的真正瓶颈）：每读一个 weight tile 都更便宜。
- 部分方案（FP8、INT8 activation）还能转用 TensorCore INT8/FP8 MMA，提升算力。

按维度区分：

| 维度 | 例子 |
| ---- | ---- |
| **weight-only** | AWQ, GPTQ, bitsandbytes, GGUF, Marlin |
| **weight + activation** | FP8 (per-tensor / per-channel / per-block), INT8 (per-channel), modelopt FP4 |
| **MoE 专用** | mxfp4, fp8 expert, moe_wna16 |
| **online quant** | 加载时即时量化（`online/` 目录），用 FP16 ckpt 跑 FP8 推理 |

### 11.2.2 算法 / 内核映射

vLLM 把 "quantization 格式" 与 "执行 kernel" 解耦：

```
weight on disk (GPTQ/AWQ INT4)
        │
        ▼
QuantizationConfig.from_config()      ← vllm/model_executor/layers/quantization/__init__.py:109
        │
        ▼
QuantizeMethodBase.create_weights()    ← 决定 weight 在 GPU 上的 layout
        │
        ▼
QuantizeMethodBase.apply()             ← 选 Marlin / Triton / cuBLAS / cutlass kernel
```

`QuantizeMethodBase` 定义在 `vllm/model_executor/layers/quantization/base_config.py:19`，注意它的 `process_weights_after_loading` hook：被 `model_loader` 在加载完毕后调用，用来把 packed INT4 权重重排成 Marlin layout，或预算 scale tile。

Marlin 是 vLLM 默认 INT4 GEMM kernel：以 AMP A100/H100 为目标，把 4-bit 权重 dequantize→FP16 累加→FP32 输出全部融合在一个 SM 内。AWQ 与 GPTQ 在加载后都会自动转 Marlin 形态（`awq_marlin.py:75`），用户也可强制旧 kernel（`quantization="awq"`、`quantization="gptq"`）。

典型 `QuantizeMethodBase` 实现（节选自 `vllm/model_executor/layers/quantization/fp8.py:261`）：

```python
class Fp8LinearMethod(LinearMethodBase):
    def create_weights(self, layer, ...):
        # 决定 weight / scale 在 GPU 上的 layout；标注 sharding 信息
        layer.weight = ModelWeightParameter(...)
        layer.weight_scale = ChannelQuantScaleParameter(...)

    def process_weights_after_loading(self, layer):
        # FP16 ckpt 走 online quant 时在此把权重转 FP8；
        # 静态 ckpt 在此 transpose / pad 到 kernel 要求的 layout
        layer.weight = _quantize_to_fp8(layer.weight)

    def apply(self, layer, x, bias=None):
        # 走 cutlass FP8 / cuBLASLt / scaled_mm_triton 中的某一个
        return scaled_fp8_gemm(x, layer.weight, layer.weight_scale, bias)
```

`uses_meta_device=True` 的 method 会先在 meta device 上构造权重再 layer-wise 量化，把峰值显存控制在单层而不是整个模型（对 70B FP8 这样的大模型至关重要）。

### 11.2.3 已注册方法

`get_quantization_config` `vllm/model_executor/layers/quantization/__init__.py:109` 内的映射枚举了所有支持：`awq`, `awq_marlin`, `auto_gptq` (=`gptq`/`gptq_marlin`), `fp8`, `fbgemm_fp8`, `modelopt`(fp8/fp4/mxfp8), `compressed-tensors`, `bitsandbytes`, `experts_int8`, `quark`, `moe_wna16`, `torchao`, `mxfp4`, `gpt_oss_mxfp4`, `gguf`, `humming`, `online`, `inc`。

第三方可通过 `register_quantization_config` 注册自定义格式（`__init__.py:59`）。

### 11.2.4 参数加载流

参数（scale/zero_point/g_idx）通过 `vllm/model_executor/parameter.py` 的 `ModelWeightParameter`、`GroupQuantScaleParameter`、`PackedColumnParameter` 等子类提供并行 sharding 信息；权重加载器（`vllm/model_executor/model_loader/weight_utils.py`）按这些注解切分张量到 TP rank。

### 11.2.5 配置入口

CLI/Python：`--quantization awq_marlin` / `LLM(quantization="fp8")`。还可以从 HF `config.json` 自动嗅探（`override_quantization_method`，`base_config.py:111`）。

KV cache 量化是独立特性：`--kv-cache-dtype fp8` 走 `vllm/model_executor/layers/quantization/kv_cache.py`，不依赖 weight quant 选择。

### 11.2.6 限制

- `get_min_capability` 决定 GPU 架构下限：Marlin FP8 需要 Ada (89)/Hopper (90)，bitsandbytes 仅 Volta+。
- `experts_int8`、`moe_wna16` 只覆盖 MoE 模型。
- `gguf` 仅支持权重，激活仍 FP16；解码内核为 Triton，速度低于 Marlin。
- 量化模型在 Speculative Decoding 中可单独配 `speculative.quantization`（与 target 解耦）。

---

## 11.3 torch.compile 集成

### 11.3.1 目的

PyTorch eager 模式下每个算子都是一次 Python→C++→CUDA launch，对于 RMSNorm + element-wise add + cast 这种瘦小算子，启动开销远超算子本身。vLLM 自定义 `torch.compile` 后端做三件事：

1. **图捕获**：通过 Dynamo 一次性提取 fx graph，避免 Python 解释器在 hot path 上转圈。
2. **算子融合**：Inductor + vLLM 自定义 pass（RMSNorm+Quant、SiluMul+Quant、QK-Norm+RoPE 等）减少 kernel 数量。
3. **图切分**：通过 `splitting_ops` 把 attention 等不能进 CUDA Graph 的算子切出，剩下的 sub-graph 进 CUDA Graph 复用。

### 11.3.2 体系结构

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vLLM 自定义 torch.compile 后端的体系结构">
  <defs>
    <marker id="ar11c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">vLLM 自定义 torch.compile 后端 (VllmBackend)</text>
  <g transform="translate(220, 50)">
    <rect x="0" y="0" width="320" height="44" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="160" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">user model.forward(...)</text>
    <text x="160" y="36" text-anchor="middle" font-size="10" fill="#0369a1">vllm/model_executor/models/*.py</text>
  </g>
  <path d="M 380 94 L 380 116" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11c)"/>
  <g transform="translate(220, 118)">
    <rect x="0" y="0" width="320" height="44" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="6"/>
    <text x="160" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">@support_torch_compile</text>
    <text x="160" y="36" text-anchor="middle" font-size="10" fill="#a16207">vllm/compilation/decorators.py</text>
  </g>
  <path d="M 380 162 L 380 184" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11c)"/>
  <g transform="translate(140, 186)">
    <rect x="0" y="0" width="480" height="140" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="240" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">VllmBackend  (vllm/compilation/backends.py:800)</text>
    <line x1="14" y1="30" x2="466" y2="30" stroke="#c4b5fd"/>
    <g transform="translate(20, 42)">
      <rect x="0" y="0" width="140" height="80" fill="#ede9fe" stroke="#a78bfa" rx="4"/>
      <text x="70" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">split_graph()</text>
      <text x="70" y="38" text-anchor="middle" font-size="9" fill="#6d28d9">按 splitting_ops 切</text>
      <text x="70" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">attention 段独立</text>
      <text x="70" y="68" text-anchor="middle" font-size="9" fill="#6d28d9">其余段进图</text>
    </g>
    <g transform="translate(170, 42)">
      <rect x="0" y="0" width="140" height="80" fill="#ede9fe" stroke="#a78bfa" rx="4"/>
      <text x="70" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">PiecewiseCompile</text>
      <text x="70" y="34" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">Interp</text>
      <text x="70" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">Inductor 逐段编译</text>
      <text x="70" y="66" text-anchor="middle" font-size="9" fill="#6d28d9">+ 自定义 fusion pass</text>
    </g>
    <g transform="translate(320, 42)">
      <rect x="0" y="0" width="140" height="80" fill="#ede9fe" stroke="#a78bfa" rx="4"/>
      <text x="70" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">wrap_with</text>
      <text x="70" y="34" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">_cudagraph...</text>
      <text x="70" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">非 attention 段套</text>
      <text x="70" y="66" text-anchor="middle" font-size="9" fill="#6d28d9">CUDAGraphWrapper</text>
    </g>
  </g>
  <path d="M 380 326 L 380 348" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11c)"/>
  <g transform="translate(180, 350)">
    <rect x="0" y="0" width="400" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">per-shape sub-graph cache</text>
    <text x="200" y="36" text-anchor="middle" font-size="10" fill="#9a3412">vllm/compilation/caching.py（按 hash 跨进程复用编译产物）</text>
  </g>
</svg>
<span class="figure-caption">图 R11.3 ｜ vLLM 的 torch.compile 后端做三件事：split_graph 把 attention 切出去 → 逐段 Inductor 编译并跑融合 pass → 把非 attention 段套 CUDAGraphWrapper，全部结果按 shape 缓存复用</span>

<details>
<summary>ASCII 原版</summary>

```
   user model.forward(...)
            │
            ▼
   @support_torch_compile (vllm/compilation/decorators.py)
            │
            ▼
   VllmBackend  (vllm/compilation/backends.py:800)
   ├─ split_graph()           # 按 splitting_ops 切
   ├─ PiecewiseCompileInterp  # 走 Inductor 编译每段
   └─ wrap_with_cudagraph...  # 给非 attention 段套 CUDAGraphWrapper
            │
            ▼
   per-shape sub-graph cache  (vllm/compilation/caching.py)
```

</details>

`CompilationMode`（`vllm/config/compilation.py:37`）分级：

- `NONE`：纯 eager。
- `STOCK_TORCH_COMPILE`：直接走 PyTorch 默认，无 vLLM 自定义。
- `DYNAMO_TRACE_ONCE`：只 trace 一次，不真编译。
- `VLLM_COMPILE`：vLLM 自定义 Inductor backend，支持 piecewise + 缓存 + 自定义 pass。

`CompilerManager`（`backends.py:124`）负责编译产物落盘缓存：相同 hash（模型结构 + dtype + shape + pass 配置）跨进程复用，避免冷启动 5-10 分钟编译时间。

`split_graph`（`backends.py:548`）按 `splitting_ops` 把 fx graph 切成连续 SplitItem 列表：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="split_graph 把 attention 算子从 fx 图切出来">
  <defs>
    <marker id="ar11d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">split_graph：按 splitting_ops 把 attention 切成 passthrough，其余段进 CUDA Graph</text>
  <text x="40" y="60" font-size="11" font-weight="600" fill="currentColor">原 forward graph</text>
  <g transform="translate(40, 70)">
    <rect x="0" y="0" width="60" height="32" fill="#bae6fd" stroke="#0ea5e9"/>
    <text x="30" y="20" text-anchor="middle" font-size="11" fill="#075985">pre0</text>
    <rect x="62" y="0" width="60" height="32" fill="#bae6fd" stroke="#0ea5e9"/>
    <text x="92" y="20" text-anchor="middle" font-size="11" fill="#075985">pre1</text>
    <rect x="124" y="0" width="80" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="164" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">attn0</text>
    <rect x="206" y="0" width="60" height="32" fill="#bae6fd" stroke="#0ea5e9"/>
    <text x="236" y="20" text-anchor="middle" font-size="11" fill="#075985">post0</text>
    <rect x="268" y="0" width="60" height="32" fill="#bae6fd" stroke="#0ea5e9"/>
    <text x="298" y="20" text-anchor="middle" font-size="11" fill="#075985">post1</text>
    <rect x="330" y="0" width="80" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="370" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">attn1</text>
    <rect x="412" y="0" width="60" height="32" fill="#bae6fd" stroke="#0ea5e9"/>
    <text x="442" y="20" text-anchor="middle" font-size="11" fill="#075985">post2</text>
  </g>
  <text x="540" y="92" font-size="10" fill="#7c2d12">splitting_ops = ['vllm::unified_attention']</text>
  <path d="M 380 110 L 380 138" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11d)"/>
  <text x="40" y="142" font-size="11" font-weight="600" fill="currentColor">分段后</text>
  <g transform="translate(40, 152)">
    <rect x="0" y="0" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
    <text x="80" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">SplitItem 0</text>
    <text x="80" y="30" text-anchor="middle" font-size="9" fill="#6d28d9">[pre0, pre1]  compile + CG</text>
    <rect x="170" y="0" width="120" height="38" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="4"/>
    <text x="230" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#92400e">SplitItem 1</text>
    <text x="230" y="30" text-anchor="middle" font-size="9" fill="#a16207">[attn0]  passthrough</text>
    <rect x="300" y="0" width="180" height="38" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
    <text x="390" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">SplitItem 2</text>
    <text x="390" y="30" text-anchor="middle" font-size="9" fill="#6d28d9">[post0, post1]  compile + CG</text>
    <rect x="490" y="0" width="120" height="38" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="4"/>
    <text x="550" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#92400e">SplitItem 3</text>
    <text x="550" y="30" text-anchor="middle" font-size="9" fill="#a16207">[attn1]  passthrough</text>
    <rect x="620" y="0" width="100" height="38" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
    <text x="670" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">SplitItem 4</text>
    <text x="670" y="30" text-anchor="middle" font-size="9" fill="#6d28d9">[post2]  compile + CG</text>
  </g>
  <g transform="translate(40, 220)">
    <rect x="0" y="0" width="220" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
    <rect x="0" y="0" width="18" height="36" fill="#ddd6fe"/>
    <text x="100" y="22" text-anchor="middle" font-size="11" fill="currentColor">compile + cudagraph（蓝紫段）</text>
    <rect x="240" y="0" width="220" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
    <rect x="240" y="0" width="18" height="36" fill="#fef3c7"/>
    <text x="345" y="22" text-anchor="middle" font-size="11" fill="currentColor">passthrough（attention 段）</text>
  </g>
  <g transform="translate(40, 272)">
    <rect x="0" y="0" width="680" height="40" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="340" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">attention 留给 backend 自决（FA / Triton / FlashInfer 各异）</text>
    <text x="340" y="32" text-anchor="middle" font-size="10" fill="#14532d">其余段被 Inductor 编译并按 shape 缓存，按 BatchDescriptor 派发对应 CUDA Graph</text>
  </g>
</svg>
<span class="figure-caption">图 R11.4 ｜ split_graph 按 splitting_ops 把 fx 图切成「可 capture 段 + attention passthrough 段」交错的 SplitItem 列表；只有非 attention 段进 CUDA Graph</span>

<details>
<summary>ASCII 原版</summary>

```
原 forward graph:  [pre0] [pre1] [attn0] [post0] [post1] [attn1] [post2]
                          │                       │
                          │  splitting_ops=       │
                          │  ['vllm::unified_attention']
                          ▼                       ▼
分段:        SplitItem(idx=0, computational=[pre0,pre1])    ← compile + cudagraph
             SplitItem(idx=1, computational=[attn0])         ← passthrough
             SplitItem(idx=2, computational=[post0,post1])   ← compile + cudagraph
             SplitItem(idx=3, computational=[attn1])         ← passthrough
             SplitItem(idx=4, computational=[post2])         ← compile + cudagraph
```

</details>

之后 `PiecewiseCompileInterpreter`（`backends.py:682`）逐段编译，每段编译产物被 `PiecewiseBackend`（`vllm/compilation/piecewise_backend.py:86`）按 shape 索引保存为 `RangeEntry`，配合 dynamic shape 标注实现一份编译多份 shape 复用。

### 11.3.3 自定义 pass

`vllm/compilation/passes/`：

- `fusion/`：RMSNorm+Quant、SiluMul+Quant、Attn+Quant 三类融合。
- `pass_manager.py`：根据 `PassConfig`（`vllm/config/compilation.py:107`）按平台启用 / 关闭。
- `vllm_inductor_pass.py`：在 Inductor 调度前介入。

控制位：`PassConfig.fuse_norm_quant`、`fuse_act_quant`、`fuse_attn_quant`、`enable_sp`（sequence parallelism）、`fuse_allreduce_rms`（FlashInfer allreduce 融合）等。详细见 `docs/design/fusions.md` 与 `docs/design/optimization_levels.md`。

### 11.3.4 与 piecewise CUDA Graph 协作

`splitting_ops`（`config/compilation.py:500`）默认包含 attention 算子（`vllm::unified_attention`、`vllm::unified_kv_cache_update` 等）。当 `cudagraph_mode=PIECEWISE`：

- 切分点之外的子图被 `wrap_with_cudagraph_if_needed`（`backends.py:628`）套上 `CUDAGraphWrapper`。
- 注意力部分留给 attention backend 自己决定是否捕获（FA、Triton、FlashInfer 各有差异）。

启用 `use_inductor_graph_partition=True`（`config/compilation.py:652`）后，可以让 Inductor 直接做 graph partitioning，不需要手动列 `splitting_ops`；这要求 PyTorch ≥ 2.10。

### 11.3.5 自定义 op 注册

`vllm/compilation/decorators.py` 中 `support_torch_compile`、`ignore_torch_compile` 控制哪些 `nn.Module` 进入图。`vllm/_custom_ops.py` 把 C++ 算子用 `torch.library` 注册成可被 Inductor 看到的 ATen op。`should_torch_compile_mm_encoder`（`decorators.py:53`）则按 `CompilationConfig.compile_mm_encoder` 决定多模态 encoder 是否进编译。

### 11.3.6 限制

- 动态 shape 引起 Dynamo recompile：实际通过 `dynamic_shapes_config`（`config/compilation.py:317`）把 token / batch 维度标成 unbacked symint，否则每个 batch size 都重编。
- 自定义 Python 控制流（`if attention_meta.has_xxx`）必须 graph-break 或用 `torch.cond` 改写，否则不会被融合。
- 编译失败时 vLLM fallback 到 eager（在 `VllmBackend.__call__` 内有 try/except），但 throughput 显著退化；首次启动建议查日志。
- 详见 `docs/design/torch_compile.md` 与 `docs/design/debug_vllm_compile.md`。

---

## 11.4 CUDA Graph

### 11.4.1 目的

CPU 端构造 launch 参数 + Python overhead，单 step decode 加起来 0.5-2 ms。对 batch=1 的小模型来说，这就是 30%-60% 的延迟。CUDA Graph 把一组 launch 录制下来，replay 时整段 push 到 stream，CPU 几乎零开销。

### 11.4.2 三种模式

`CUDAGraphMode`（`vllm/config/compilation.py:53`）：

| 模式 | 含义 | 适用 |
| ---- | ---- | ---- |
| `NONE` | 不捕获 | 调试或形状极不规则 |
| `PIECEWISE` | 把非 attention 段单独捕获（attention 走 eager 或自己的 graph） | 默认；prefill + decode 都能受益 |
| `FULL` | 整 forward 一段 graph | decode-only 收益最大 |
| `FULL_DECODE_ONLY` | decode 走 FULL，prefill 走 eager | mixed batch 的折中 |
| `FULL_AND_PIECEWISE` | 同时捕获两套 | 内存换性能 |

### 11.4.3 dispatch 机制

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="CudagraphDispatcher 按 BatchDescriptor 派发到 FULL/PIECEWISE/NONE 模式">
  <defs>
    <marker id="ar11e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">CudagraphDispatcher：按 BatchDescriptor 选择 capture/replay 模式</text>
  <g transform="translate(260, 50)">
    <rect x="0" y="0" width="240" height="46" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="120" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">forward(input_batch)</text>
    <text x="120" y="36" text-anchor="middle" font-size="10" fill="#075985">batch shape, uniform_decode, lora_count</text>
  </g>
  <path d="M 380 96 L 380 118" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11e)"/>
  <g transform="translate(180, 120)">
    <rect x="0" y="0" width="400" height="50" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">CudagraphDispatcher.dispatch(batch_descriptor)</text>
    <text x="200" y="38" text-anchor="middle" font-size="10" fill="#6d28d9">vllm/v1/cudagraph_dispatcher.py:15</text>
  </g>
  <path d="M 380 170 L 150 220" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11e)"/>
  <path d="M 380 170 L 380 220" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11e)"/>
  <path d="M 380 170 L 610 220" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11e)"/>
  <g transform="translate(20, 224)">
    <rect x="0" y="0" width="240" height="76" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="120" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">FULL graph</text>
    <text x="120" y="40" text-anchor="middle" font-size="10" fill="#9a3412">整 forward 一段 graph → replay</text>
    <text x="120" y="58" text-anchor="middle" font-size="9" fill="#c2410c">decode-only 收益最大</text>
    <text x="120" y="70" text-anchor="middle" font-size="9" fill="#94a3b8">attention metadata 必须固定地址</text>
  </g>
  <g transform="translate(280, 224)">
    <rect x="0" y="0" width="200" height="76" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="100" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">PIECEWISE graph</text>
    <text x="100" y="40" text-anchor="middle" font-size="10" fill="#0f766e">attention 走 eager</text>
    <text x="100" y="54" text-anchor="middle" font-size="10" fill="#0f766e">其余段 replay 子图</text>
    <text x="100" y="68" text-anchor="middle" font-size="9" fill="#94a3b8">默认；prefill + decode 都受益</text>
  </g>
  <g transform="translate(500, 224)">
    <rect x="0" y="0" width="240" height="76" fill="#f1f5f9" stroke="#cbd5e1" rx="6"/>
    <text x="120" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#475569">NONE</text>
    <text x="120" y="40" text-anchor="middle" font-size="10" fill="#64748b">直接调用 underlying callable</text>
    <text x="120" y="54" text-anchor="middle" font-size="10" fill="#64748b">不录制、不 replay</text>
    <text x="120" y="68" text-anchor="middle" font-size="9" fill="#94a3b8">调试或 shape 极不规则</text>
  </g>
</svg>
<span class="figure-caption">图 R11.5 ｜ CudagraphDispatcher 把 (num_tokens, uniform_decode, lora_count, ...) 打成 key 查表，结果广播给所有 CUDAGraphWrapper，每个 wrapper 自决 capture / replay / passthrough</span>

<details>
<summary>ASCII 原版</summary>

```
forward(input_batch)
        │
        ▼
 CudagraphDispatcher.dispatch(batch_descriptor)   ← vllm/v1/cudagraph_dispatcher.py:15
        │
        ├─→ FULL graph?      replay
        ├─→ PIECEWISE graph? replay 子图
        └─→ NONE             直接走原 callable
```

</details>

`BatchDescriptor`（`vllm/forward_context.py`）由 `(num_tokens, uniform_decode, lora_count, ...)` 组成。Dispatcher 在 capture 阶段为每个有效 descriptor 录制一份 graph；运行时按 batch 形状查表。当 spec decode 启用时，`uniform_decode_query_len = 1 + num_speculative_tokens`（`cudagraph_dispatcher.py:37`），所以 decode 的 query 维度也会被纳入 key。

`CudagraphDispatcher.dispatch` 的语义（`vllm/v1/cudagraph_dispatcher.py:15-32` 注释）：

```python
runtime_mode, dispatched_key = dispatcher.dispatch(input_key)
# runtime_mode ∈ {FULL, PIECEWISE, NONE}
# 当 mode = NONE 时 wrapper 直接调用 underlying callable，不录制不 replay
# 当 mode = PIECEWISE 时只 replay piecewise 子图，attention 走 eager
# 当 mode = FULL 时 replay 整段 forward
```

由 `forward_context` 把 dispatch 结果广播给所有 `CUDAGraphWrapper`，每个 wrapper 自决定 capture / replay / passthrough，避免 dispatcher 与 wrapper 之间多次串行查表。

### 11.4.4 与 attention backend 的协调

不是所有 attention backend 都能进 graph：

- FlashAttention / Triton：支持 piecewise（splitting_ops 把它切出去后自己用 CUDA Graph）。
- FlashInfer decode：要求 metadata buffer 全部在固定地址；`vllm/v1/attention/backends/flashinfer.py` 内为此预分配 pinned host buffer。
- MLA / mamba：通常只在 decode-only batch 启用 FULL 模式。

### 11.4.5 batched LoRA、ubatch 与 CUDA Graph

- `LoRAConfig.specialize_active_lora`（`config/lora.py`）会按 active LoRA 数量（2 的幂次）多录几份 graph。
- `UBatchWrapper`（`vllm/v1/worker/gpu_ubatch_wrapper.py:113`）让两个 micro-batch 流水重叠：每个 micro-batch 单独 dispatch 一份 graph，两份在不同 stream replay。
- `BreakableCudaGraph`（`vllm/compilation/breakable_cudagraph.py`）允许 graph 中嵌入条件 break，用于 EAGLE 等需要在中途读 host tensor 的场景。

### 11.4.6 关键配置

| 参数 | 路径 |
| --- | --- |
| `cudagraph_mode` | `compilation_config.cudagraph_mode`，默认按平台推断 |
| `cudagraph_capture_sizes` | 显式给定要捕获的 batch 列表 |
| `max_cudagraph_capture_size` | 单 graph 的 token 数上限 |
| `cudagraph_num_of_warmups` | 录制前的 warmup 步数 |
| `encoder_cudagraph_token_budgets` | encoder（多模态）独立预算列表 |
| `encoder_cudagraph_max_vision_items_per_batch` | encoder 单 batch 图像数上限 |

### 11.4.7 限制

- 任何带 host-sync 的 op（`item()`、`.cpu()`、`if tensor.any()`）都会让 graph 失败。
- shape 必须可枚举：实践中按 capture size 向上 padding，浪费一点显存换 launch 节省。
- 详细原理见 `docs/design/cuda_graphs.md` 与多模态特例 `docs/design/cuda_graphs_multimodal.md`。

---

## 11.5 LoRA（multi-tenant LoRA serving）

### 11.5.1 目的

一个 base model + 多个 task-specific LoRA adapter（每个几十 MB），可以在同一进程内服务多个微调版本，无需重复占用 base 权重。难点是：单 batch 内不同 sequence 可能来自不同 LoRA，需要 "per-row" 的 GEMM。

### 11.5.2 Punica 算法

vLLM 实现基于 Punica 论文 [Chen et al. 2023](https://arxiv.org/abs/2310.18547)：

```
base output  Y = X · W_base                              (普通 GEMM)
LoRA delta:  Y += alpha * (X · A_r) · B_r                (按 row 选 r)
```

`PunicaWrapperGPU`（`vllm/lora/punica_wrapper/punica_gpu.py:33`）把：

1. `add_shrink`：`Y' = X · A_r`，每行 r 不同，调用 SGMV (Segmented Gather Matrix-Vector) kernel。
2. `add_expand`：`Y += Y' · B_r`，再来一次 SGMV。

`LoRAMapping`（`vllm/lora/layers/`）保存每 token 的 adapter index、序列分段信息，传给 wrapper 的 `update_metadata`（`punica_base.py:27`）。

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Punica SGMV：按 adapter 分段，每段一次小型 GEMM">
  <defs>
    <marker id="ar11f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Punica SGMV：同 adapter 的连续 token 合并成 segment，逐 segment 跑 GEMM</text>
  <text x="40" y="56" font-size="11" font-weight="600" fill="currentColor">batch tokens（9 个，混三个 LoRA）</text>
  <g transform="translate(40, 66)">
    <rect x="0" y="0" width="60" height="30" fill="#fed7aa" stroke="#ea580c"/>
    <text x="30" y="20" text-anchor="middle" font-size="11" fill="#7c2d12">t0</text>
    <rect x="60" y="0" width="60" height="30" fill="#fed7aa" stroke="#ea580c"/>
    <text x="90" y="20" text-anchor="middle" font-size="11" fill="#7c2d12">t1</text>
    <rect x="120" y="0" width="60" height="30" fill="#fed7aa" stroke="#ea580c"/>
    <text x="150" y="20" text-anchor="middle" font-size="11" fill="#7c2d12">t2</text>
    <rect x="200" y="0" width="60" height="30" fill="#99f6e4" stroke="#0d9488"/>
    <text x="230" y="20" text-anchor="middle" font-size="11" fill="#115e59">t3</text>
    <rect x="260" y="0" width="60" height="30" fill="#99f6e4" stroke="#0d9488"/>
    <text x="290" y="20" text-anchor="middle" font-size="11" fill="#115e59">t4</text>
    <rect x="340" y="0" width="60" height="30" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="370" y="20" text-anchor="middle" font-size="11" fill="#5b21b6">t5</text>
    <rect x="400" y="0" width="60" height="30" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="430" y="20" text-anchor="middle" font-size="11" fill="#5b21b6">t6</text>
    <rect x="460" y="0" width="60" height="30" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="490" y="20" text-anchor="middle" font-size="11" fill="#5b21b6">t7</text>
    <rect x="520" y="0" width="60" height="30" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="550" y="20" text-anchor="middle" font-size="11" fill="#5b21b6">t8</text>
  </g>
  <g transform="translate(40, 106)">
    <text x="0" y="0" font-size="10" fill="#64748b">adapter_idx</text>
    <text x="105" y="0" font-size="11" font-weight="700" fill="#9a3412">0  0  0</text>
    <text x="265" y="0" font-size="11" font-weight="700" fill="#115e59">1  1</text>
    <text x="445" y="0" font-size="11" font-weight="700" fill="#5b21b6">2  2  2  2</text>
  </g>
  <g transform="translate(40, 130)">
    <text x="0" y="0" font-size="10" fill="#64748b">seg starts</text>
    <text x="105" y="0" font-size="10" fill="currentColor">0</text>
    <text x="200" y="0" font-size="10" fill="currentColor">3</text>
    <text x="340" y="0" font-size="10" fill="currentColor">5</text>
    <text x="580" y="0" font-size="10" fill="currentColor">9</text>
  </g>
  <g transform="translate(40, 154)">
    <rect x="0" y="0" width="180" height="14" fill="#fed7aa" stroke="#ea580c"/>
    <text x="90" y="11" text-anchor="middle" font-size="9" fill="#7c2d12">segment 0（adapter A_0 / B_0）</text>
    <rect x="200" y="0" width="120" height="14" fill="#99f6e4" stroke="#0d9488"/>
    <text x="260" y="11" text-anchor="middle" font-size="9" fill="#115e59">segment 1</text>
    <rect x="340" y="0" width="240" height="14" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="460" y="11" text-anchor="middle" font-size="9" fill="#5b21b6">segment 2</text>
  </g>
  <g transform="translate(40, 190)">
    <rect x="0" y="0" width="700" height="50" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
    <text x="14" y="20" font-size="11" font-weight="700" fill="currentColor">step 1（add_shrink）</text>
    <text x="14" y="36" font-size="10" fill="#64748b">Y' = X · A[adapter_idx]，每段一次小 GEMM，输出 shape [num_tokens, r]（r 小到不足以填 TensorCore，因此按 segment 合批）</text>
  </g>
  <g transform="translate(40, 252)">
    <rect x="0" y="0" width="700" height="50" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="14" y="20" font-size="11" font-weight="700" fill="#166534">step 2（add_expand）</text>
    <text x="14" y="36" font-size="10" fill="#14532d">Y += Y' · B[adapter_idx]，再一次按 segment 的 SGMV，输出 [num_tokens, hidden]；与 base 输出加和</text>
  </g>
</svg>
<span class="figure-caption">图 R11.6 ｜ Punica SGMV：把 batch 内同 adapter 的连续 token 合成 segment，两步 SGMV (shrink + expand) 各按 segment 跑一次小型 GEMM，实现 per-row LoRA 的 multi-tenant 服务</span>

<details>
<summary>ASCII 原版</summary>

```
batch tokens:  [t0  t1  t2 | t3  t4 | t5  t6  t7  t8]
adapter idx:   [ 0   0   0 |  1   1 |  2   2   2   2]   ← per-token LoRA index
seg starts:    [ 0,          3,         5,            9 ]  ← SGMV segments

step 1 (add_shrink):  X · A[adapter_idx]  → shape [num_tokens, r]
step 2 (add_expand):  Y' · B[adapter_idx] → shape [num_tokens, hidden]
```

</details>

之所以叫 SGMV（Segmented GMV）而非普通 batched GEMM：同一 adapter 的 r 维度小到不足以填满 TensorCore，把同 adapter 的连续 token 合并成 segment 后即可作为一次小型 GEMM，多 segment 之间共用 kernel。`vllm/lora/ops/` 内对 GPU/CPU/XPU 都有 Triton/CUDA 实现，由 `punica_selector.py` 在初始化时按 platform 选择。

### 11.5.3 代码入口

| 模块 | 作用 |
| --- | --- |
| `vllm/lora/lora_model.py` | 单 adapter 的元信息 + 权重 |
| `vllm/lora/lora_weights.py` | 加载、量化兼容、shard |
| `vllm/lora/model_manager.py` | adapter 池管理、LRU 换入换出 |
| `vllm/lora/peft_helper.py` | 兼容 HuggingFace `peft` 格式 |
| `vllm/lora/resolver.py` + `vllm/plugins/lora_resolvers/` | 通过插件按 ID 拉取 adapter（filesystem / HF Hub） |
| `vllm/lora/punica_wrapper/punica_selector.py` | 按平台选 GPU/CPU/XPU 实现 |
| `vllm/v1/worker/lora_model_runner_mixin.py:30` | model runner 端在前向前刷新 mapping，CUDA Graph capture 时穷举 LoRA 数 |

### 11.5.4 配置

`vllm/config/lora.py`：

| 参数 | 含义 |
| --- | --- |
| `max_loras` | 同一 batch 最多并发 adapter 数 |
| `max_lora_rank` | r 上限，决定 buffer 形状 |
| `max_cpu_loras` | CPU 池容量（换入换出阈值） |
| `specialize_active_lora` | 为每个 active LoRA 数量录单独 CUDA Graph |
| `fully_sharded_loras` | 沿 TP 切 LoRA |
| `lora_dtype` | adapter 计算 dtype |

### 11.5.5 限制

- A/B 矩阵的 dtype 与 base 一致（不支持混合精度 adapter）。
- Embedding LoRA 走 `add_lora_embedding` 路径，要求 vocab parallel embedding 与 base 对齐。
- 启用 `specialize_active_lora` 后 CUDA Graph 内存翻倍：每个 active count 一份。
- 当 `enable_prefix_caching=True` 且不同 adapter 共享前缀时，前缀 hash 会包含 adapter ID（见 `vllm/v1/core/kv_cache_utils.py:_gen_lora_extra_hash_keys`），避免脏读。

---

## 11.6 Multimodal（视觉、视频、音频）

### 11.6.1 目的

LLaVA、Qwen2-VL、InternVL 等模型在 token 序列中插入 `<image_pad>` / `<video_pad>` 占位符，由独立的 vision encoder 把像素转 token-shape 的 embedding，再让 LLM 主体消费。vLLM 必须解决：

- encoder 计算与 LLM 计算的资源争用。
- encoder 输出在 prefix caching、chunked prefill、PP 之间的生命周期。
- 多模态 placeholder 在 attention mask、KV cache 索引上的特殊处理。

### 11.6.2 体系结构

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="多模态请求从 HF Processor 到 LLM forward 的流水线">
  <defs>
    <marker id="ar11g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">多模态请求生命周期：encoder 与 LLM 分两条算力轨，按 mm_hash 跨请求复用</text>
  <g transform="translate(120, 50)">
    <rect x="0" y="0" width="520" height="46" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="6"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">HF Processor</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#9a3412">image bytes → pixel_values + token_ids（含 &lt;image_pad&gt; 占位符）</text>
    <text x="525" y="28" font-size="9" fill="#94a3b8">vllm/multimodal/processing/</text>
  </g>
  <path d="M 380 96 L 380 116" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11g)"/>
  <g transform="translate(120, 120)">
    <rect x="0" y="0" width="520" height="46" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="6"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">Scheduler</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#115e59">决定本步需要哪些 mm_input 项 + 抽取 mm_hash</text>
    <text x="525" y="28" font-size="9" fill="#94a3b8">v1/core/sched/scheduler.py</text>
  </g>
  <path d="M 380 166 L 380 186" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11g)"/>
  <g transform="translate(120, 190)">
    <rect x="0" y="0" width="520" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">EncoderCacheManager</text>
    <text x="260" y="38" text-anchor="middle" font-size="10" fill="#6d28d9">按 mm_hash 去重，跨请求复用 vision embedding</text>
    <text x="260" y="52" text-anchor="middle" font-size="9" fill="#7c3aed">命中 → 跳过 encoder；miss → 入队</text>
    <text x="525" y="34" font-size="9" fill="#94a3b8">v1/core/encoder_cache_manager.py:17</text>
  </g>
  <path d="M 380 250 L 380 270" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11g)"/>
  <path d="M 380 250 L 380 260 L 70 260 L 70 280" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="60" y="276" font-size="9" font-weight="600" fill="#16a34a">cache hit</text>
  <g transform="translate(120, 274)">
    <rect x="0" y="0" width="520" height="46" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.2" rx="6"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">Vision Encoder forward</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#075985">可走 EncoderCudaGraphManager（budget triple 化捕获）</text>
    <text x="525" y="28" font-size="9" fill="#94a3b8">v1/worker/encoder_cudagraph.py:50</text>
  </g>
  <path d="M 380 320 L 380 340" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11g)"/>
  <g transform="translate(120, 344)">
    <rect x="0" y="0" width="520" height="46" fill="#fef3c7" stroke="#facc15" stroke-width="1.2" rx="6"/>
    <text x="260" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">ec_connector</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#a16207">把 encoder 输出 stash 给 LLM forward（按位置对齐）</text>
    <text x="525" y="28" font-size="9" fill="#94a3b8">ec_connector_model_runner_mixin</text>
  </g>
  <path d="M 380 390 L 380 410" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11g)"/>
  <g transform="translate(120, 414)">
    <rect x="0" y="0" width="520" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="260" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">LLM forward</text>
    <text x="260" y="32" text-anchor="middle" font-size="10" fill="#9a3412">placeholder slot 被 scatter 替换为 embedding</text>
  </g>
  <g transform="translate(20, 274)">
    <rect x="0" y="0" width="94" height="46" fill="#f0fdf4" stroke="#16a34a" stroke-width="1" rx="4"/>
    <text x="47" y="18" text-anchor="middle" font-size="10" font-weight="700" fill="#166534">cache 命中</text>
    <text x="47" y="34" text-anchor="middle" font-size="9" fill="#16a34a">直接复用 emb</text>
  </g>
</svg>
<span class="figure-caption">图 R11.7 ｜ 多模态请求生命周期：encoder 计算独立于 LLM 算力预算，EncoderCacheManager 按 mm_hash 跨请求复用 vision embedding，命中后直接跳到 ec_connector 阶段</span>

<details>
<summary>ASCII 原版</summary>

```
HF Processor (image bytes → pixel_values, token_ids w/ placeholders)
        │   vllm/multimodal/processing/, vllm/multimodal/inputs.py
        ▼
Scheduler 决定本步需要哪些 mm_input 项
        │   vllm/v1/core/sched/scheduler.py
        ▼
EncoderCacheManager   ←  vllm/v1/core/encoder_cache_manager.py:17
   (按 mm_hash 去重，跨请求复用 vision embedding)
        │
        ▼
Vision Encoder forward (可走 EncoderCudaGraphManager)
        │   vllm/v1/worker/encoder_cudagraph.py:50
        ▼
ec_connector 把 embedding stash 给 LLM forward
        │   vllm/v1/worker/ec_connector_model_runner_mixin.py
        ▼
LLM forward：placeholder slot 被 scatter 替换为 embedding
```

</details>

### 11.6.3 关键模块

| 模块 | 作用 |
| --- | --- |
| `vllm/multimodal/registry.py:98` (`MultiModalRegistry`) | 注册模型的 processor / dummy data 生成器 |
| `vllm/multimodal/processing/` | 把 HF processor 包成 vLLM 接受的 `MultiModalKwargs` |
| `vllm/multimodal/hasher.py` | 基于 SHA256 给每个图片/帧算 `mm_hash`，作为 encoder cache key |
| `vllm/multimodal/evs.py` | Encoder-side Variable Sampling，按帧采样视频降本 |
| `vllm/v1/core/encoder_cache_manager.py` | 调度侧缓存管理；按 mm_hash 去重，LRU evict 空引用项 |
| `vllm/v1/worker/encoder_cudagraph.py` | budget 化的 encoder CUDA Graph：固定 `(token_budget, max_vision_items, max_frames)` 等组合捕获 |
| `vllm/v1/worker/ec_connector_model_runner_mixin.py` | 把 encoder 输出与 LLM batch 对齐 |

### 11.6.4 调度特殊性

- encoder 的算力预算独立于 token 预算：`max_num_encoder_input_tokens`（`config/scheduler.py:96`）与 `encoder_cache_size` 在 `__post_init__` 中按 `max_num_batched_tokens` 推算。
- `disable_chunked_mm_input=True` 强制 mm item 一次性入队（避免把同一张图切成两步 prefill）。
- prefix cache：encoder 输出的 hash 既可参与 prefix cache key（`mm_feature.identifier`），又能让 KV cache 跨请求命中（见 `vllm/v1/core/kv_cache_utils.py:_gen_mm_extra_hash_keys`）。

`EncoderCacheManager.check_and_update_cache`（`vllm/v1/core/encoder_cache_manager.py:91`）的核心语义：

```python
def check_and_update_cache(self, request, input_id):
    mm_hash = request.mm_features[input_id].identifier
    if mm_hash not in self.cached:
        return False                              # 必须重新计算
    if not self.cached[mm_hash]:                  # 0 ref 的旧 entry
        num = self.freeable.pop(mm_hash)
        self.num_freeable_slots -= num            # 收回 reclaimable 容量
    self.cached[mm_hash].add(request.request_id)  # 增加引用
    return True                                   # 命中，scheduler 跳过 encoder
```

引用归零的 entry 不立即释放，而是进 `freeable` 队列；只有当 `can_allocate` 发现 `num_free_slots` 不够才按 LRU 真正驱逐（`encoder_cache_manager.py:119`）。这种"懒释放"是为了让同一张图被下一条请求很快复用的场景免去重算。

### 11.6.5 多模态 + torch.compile / CUDA Graph

- `compile_mm_encoder=True`（`config/compilation.py:518`）让 vision encoder 也进 Inductor 编译。
- `EncoderCudaGraphManager` 用 budget triple 而非 batch size 作为 key：因为图像数 × patch 数 是二维的，没法直接用一维 batch 表达。
- 视频专用 `max_frames_per_batch` 自动按 model 提供的 `processing_info.get_max_frames_per_video()` 推算。

### 11.6.6 限制

- encoder cache 只缓存 vision embedding，**不**缓存 LLM KV（后者复用 prefix caching 的常规逻辑）。
- `mm_hash` 基于像素字节，对 image transform 顺序敏感。
- 高分辨率（>4K）图片可能撑爆 encoder budget，需调 `encoder_cudagraph_token_budgets`。
- 详见 `docs/design/mm_processing.md`、`docs/design/cuda_graphs_multimodal.md`、`docs/design/torch_compile_multimodal.md`。

---

## 11.7 Structured Output / Guided Decoding

### 11.7.1 目的

强制 LLM 输出合法 JSON / 正则 / 上下文无关文法。原理是在每步采样之前，根据当前已生成 token 计算一个 vocab-size 的 bitmask，把违反语法的 token 概率清零再 softmax。

### 11.7.2 算法

每个 grammar 维护一个 FSM（正则）或下推自动机（CFG）：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Guided decoding 每步循环：Grammar.advance → fill_bitmask → 屏蔽 logits → 采样">
  <defs>
    <marker id="ar11h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Guided decoding 每步循环：FSM/PDA 决定哪些 token 合法，sampler 把违法 logit 设 -inf</text>
  <g transform="translate(20, 60)">
    <rect x="0" y="20" width="140" height="64" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="6"/>
    <text x="70" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">prev_tokens</text>
    <text x="70" y="60" text-anchor="middle" font-size="10" fill="#9a3412">上一步采样结果</text>
    <text x="70" y="74" text-anchor="middle" font-size="9" fill="#c2410c">（batch 内每请求 1 个）</text>
  </g>
  <path d="M 160 92 L 200 92" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11h)"/>
  <g transform="translate(200, 60)">
    <rect x="0" y="20" width="160" height="64" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="6"/>
    <text x="80" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">Grammar.advance()</text>
    <text x="80" y="60" text-anchor="middle" font-size="10" fill="#115e59">FSM/PDA 状态转移</text>
    <text x="80" y="74" text-anchor="middle" font-size="9" fill="#0d9488">accept_tokens()</text>
  </g>
  <path d="M 360 92 L 400 92" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11h)"/>
  <g transform="translate(400, 60)">
    <rect x="0" y="20" width="160" height="64" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2" rx="6"/>
    <text x="80" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">fill_bitmask()</text>
    <text x="80" y="60" text-anchor="middle" font-size="10" fill="#6d28d9">vocab-size 位掩码</text>
    <text x="80" y="74" text-anchor="middle" font-size="9" fill="#7c3aed">合法 token=1 / 其它=0</text>
  </g>
  <path d="M 560 92 L 600 92" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11h)"/>
  <g transform="translate(600, 60)">
    <rect x="0" y="20" width="140" height="64" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.2" rx="6"/>
    <text x="70" y="42" text-anchor="middle" font-size="11" font-weight="700" fill="#0c4a6e">Sampler</text>
    <text x="70" y="60" text-anchor="middle" font-size="10" fill="#075985">违法 logit ← -inf</text>
    <text x="70" y="74" text-anchor="middle" font-size="9" fill="#0284c7">softmax → 采样</text>
  </g>
  <path d="M 670 124 Q 670 184 380 184 Q 90 184 90 124" fill="none" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar11h)"/>
  <text x="380" y="200" text-anchor="middle" font-size="10" fill="#ea580c">采样得到 next token，回到 Grammar.advance() 进下一步</text>
  <g transform="translate(40, 220)">
    <rect x="0" y="0" width="680" height="46" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
    <text x="12" y="18" font-size="10" font-weight="700" fill="#475569">StructuredOutputGrammar 接口（每请求一个状态机实例）</text>
    <text x="12" y="34" font-size="10" fill="#64748b">accept_tokens(prev) / fill_bitmask(out, idx) / rollback(n)（spec decode 回退） / is_terminated()</text>
  </g>
</svg>
<span class="figure-caption">图 R11.8 ｜ Guided decoding 每步循环：grammar 状态机吞下上一步 token、生成 vocab 大小的合法位掩码，sampler 把违法位置 logit 置 -inf 后再 softmax，采样结果回喂状态机</span>

<details>
<summary>ASCII 原版</summary>

```
prev_tokens  →  Grammar.advance() → new state
                       │
                       ▼
                Grammar.fill_bitmask(out_bitmask, batch_idx)
                       │
                       ▼
        Sampler 把 disallowed logits 设为 -inf
                       │
                       ▼
                采样 → token → 回到 Grammar.advance()
```

</details>

`StructuredOutputGrammar`（`vllm/v1/structured_output/backend_types.py:31`）是 request-级状态机抽象，必须实现 `accept_tokens`、`fill_bitmask`、`rollback`、`is_terminated`。

### 11.7.3 后端

| Backend | 实现 | 特点 |
| --- | --- | --- |
| `xgrammar` | `XgrammarBackend` `backend_xgrammar.py:35` | C++/CUDA 加速，bitmask 直接在 GPU 填，最快 |
| `outlines` | `OutlinesBackend` `backend_outlines.py:52` | Python 实现，支持复杂正则与 CFG |
| `guidance` | `GuidanceBackend` `backend_guidance.py:87` | Microsoft Guidance 兼容；支持 lark 语法 |
| `lm_format_enforcer` | `backend_lm_format_enforcer.py` | 轻量 JSON / regex |

`StructuredOutputManager`（`vllm/v1/structured_output/__init__.py:35`）按需挑后端、用 `ThreadPoolExecutor` 异步编译 grammar（避免阻塞调度），调度状态机为 `WAITING_FOR_STRUCTURED_OUTPUT_GRAMMAR`。

### 11.7.4 与 sampler 耦合

- 编译完成的 bitmask 张量被 manager 缓存（`_grammar_bitmask`），每步 in-place 填新值。
- `Sampler.forward`（`vllm/v1/sample/sampler.py:21`）在 logits processor 阶段把 bitmask 应用为加性 `-inf`。
- 与 speculative decoding 协同：spec token 在 rejection sampling 前会先被 grammar 验证 (`accept_tokens`)，违法直接拒绝。
- 与 reasoning 模型协同：`enable_in_reasoning` 决定 reasoning 段是否也施加 grammar；通常 reasoning 内允许自由文本，结束 token 后才开始严格 JSON。

调度状态机扩展（`vllm/v1/request.py`）：

```
WAITING ──admit──► WAITING_FOR_STRUCTURED_OUTPUT_GRAMMAR
                                │   (后台 ThreadPool 编译 grammar)
                                ▼
                              WAITING
                                │
                                ▼
                              RUNNING ──step──► finish
```

`async_grammar_compilation` 默认开启；在 `external_launcher` 模式下被强制禁用（`__init__.py:46-55`），原因是多 TP rank 同时调度时这个状态转换会引入不确定性，破坏 external_launcher 依赖的 deterministic 调度假设。

### 11.7.5 配置

`vllm/config/structured_outputs.py`：

| 参数 | 含义 |
| --- | --- |
| `backend` | `auto` / `xgrammar` / `outlines` / `guidance` / `lm-format-enforcer` |
| `disable_fallback` | xgrammar 不支持时是否回落到 outlines |
| `disable_any_whitespace` | JSON 输出禁止空白（紧凑模式） |
| `disable_additional_properties` | guidance 后端对 `additionalProperties: false` 的处理 |
| `enable_in_reasoning` | reasoning 段是否也用 grammar |

请求级通过 `SamplingParams.structured_outputs`（`guided_json`、`guided_regex`、`guided_choice`、`guided_grammar`、`structural_tag`）打开。

### 11.7.6 限制

- xgrammar 不支持 `$ref` 之外的 JSON Schema 高级功能（`has_xgrammar_unsupported_json_features` `backend_xgrammar.py:221` 会自动 fallback）。
- guidance 对包含 `unevaluatedProperties` 等 schema 子集 fallback 慢。
- grammar 状态对 token 边界敏感：Mistral / Llama 等分词器对同一字符可能产生多种 token，因此 `validate_tokens` 用来"猜测"前缀。

---

## 11.8 Prefix Caching（高级用法）

### 11.8.1 目的

让相同 system prompt / few-shot 示例 / 长上下文在多请求间共享 KV cache，避免重复 prefill。基础原理在第 6 章 KV cache 章节。本节聚焦三个高级议题：跨请求复用、key 设计、与多特性的交互。

### 11.8.2 跨请求复用

KV cache 以 **block**（默认 16 token）为粒度做内容寻址。`hash_request_tokens` (`vllm/v1/core/kv_cache_utils.py:545`) 用 sha256 / builtin hash 计算每 block 的 hash：

```
block_hash = H(parent_block_hash, tuple(token_ids), extra_keys)
```

形成 prefix 链：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="prefix cache 块 hash 链匹配：req A 与 req B 在 block 2 处分叉">
  <defs>
    <marker id="ar11i" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">block_hash = H(parent_hash, token_ids, extra_keys) — 第一个不等的块即分叉点</text>
  <g transform="translate(20, 70)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="#475569">req A</text>
    <rect x="60" y="-14" width="110" height="34" fill="#16a34a" stroke="#15803d" rx="4"/>
    <text x="115" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 0</text>
    <text x="115" y="18" text-anchor="middle" font-size="9" fill="#f0fdf4">h0</text>
    <path d="M 170 3 L 192 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="195" y="-14" width="110" height="34" fill="#16a34a" stroke="#15803d" rx="4"/>
    <text x="250" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 1</text>
    <text x="250" y="18" text-anchor="middle" font-size="9" fill="#f0fdf4">h1 = H(h0, …)</text>
    <path d="M 305 3 L 327 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="330" y="-14" width="110" height="34" fill="#16a34a" stroke="#15803d" rx="4"/>
    <text x="385" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 2</text>
    <text x="385" y="18" text-anchor="middle" font-size="9" fill="#f0fdf4">h2 = H(h1, …)</text>
    <path d="M 440 3 L 462 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="465" y="-14" width="110" height="34" fill="#ea580c" stroke="#c2410c" rx="4"/>
    <text x="520" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 3</text>
    <text x="520" y="18" text-anchor="middle" font-size="9" fill="#fed7aa">h3</text>
  </g>
  <g transform="translate(330, 100)">
    <rect x="0" y="0" width="200" height="80" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="100" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">block 2 内容相同 → h2 全等</text>
    <text x="100" y="34" text-anchor="middle" font-size="10" fill="#14532d">req B 直接复用 block 0/1/2 的</text>
    <text x="100" y="48" text-anchor="middle" font-size="10" fill="#14532d">已写入物理 KV block，跳过 prefill</text>
    <text x="100" y="68" text-anchor="middle" font-size="9" fill="#16a34a">命中前缀 = 3 × 16 = 48 token</text>
  </g>
  <path d="M 430 92 L 430 200" fill="none" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#ar11i)"/>
  <g transform="translate(20, 230)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="#475569">req B</text>
    <rect x="60" y="-14" width="110" height="34" fill="#16a34a" stroke="#15803d" rx="4"/>
    <text x="115" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 0</text>
    <text x="115" y="18" text-anchor="middle" font-size="9" fill="#f0fdf4">h0（复用）</text>
    <path d="M 170 3 L 192 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="195" y="-14" width="110" height="34" fill="#16a34a" stroke="#15803d" rx="4"/>
    <text x="250" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 1</text>
    <text x="250" y="18" text-anchor="middle" font-size="9" fill="#f0fdf4">h1（复用）</text>
    <path d="M 305 3 L 327 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="330" y="-14" width="110" height="34" fill="#dc2626" stroke="#991b1b" rx="4"/>
    <text x="385" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 2'</text>
    <text x="385" y="18" text-anchor="middle" font-size="9" fill="#fef2f2">h2' ≠ h2 → miss</text>
    <path d="M 440 3 L 462 3" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11i)"/>
    <rect x="465" y="-14" width="110" height="34" fill="#dc2626" stroke="#991b1b" rx="4"/>
    <text x="520" y="6" text-anchor="middle" font-size="11" font-weight="700" fill="white">block 4</text>
    <text x="520" y="18" text-anchor="middle" font-size="9" fill="#fef2f2">h4</text>
  </g>
  <text x="385" y="276" text-anchor="middle" font-size="10" fill="#dc2626">第一个不等的块即 prefill 起点 → 从 block 2' 开始算新 KV</text>
</svg>
<span class="figure-caption">图 R11.9 ｜ prefix cache 按 block 做内容寻址 hash 链：req B 与 req A 在 block 0/1 全等 → 直接复用物理 block；block 2' token 一变即 hash 失配，从此处起新 prefill</span>

<details>
<summary>ASCII 原版</summary>

```
req A:   [block_0] ── [block_1] ── [block_2] ── [block_3]
                                       │
                                       │  H(block_2_content, parent=block_1)
                                       │  全等  →  命中
                                       ▼
req B:   [block_0] ── [block_1] ── [block_2'] ── [block_4]
                                       │
                                       └─ 不同  →  从这里开始 prefill
```

</details>

`extra_keys` 由 `generate_block_hash_extra_keys` (`kv_cache_utils.py:503`) 构造：

- **mm_extra_keys**：每段多模态 placeholder 注入 `(mm_hash, offset)`，保证图片不同则前缀不命中。
- **lora_extra_keys**：当前 adapter ID，避免不同 LoRA 共享 KV。
- **cache_salt**：用户级随机盐（`Request.cache_salt`），实现"租户隔离"。
- **prompt_embeds_keys**：纯 embedding 输入时的额外 hash。

### 11.8.3 手动 vs 自动

- **自动**：客户端只发 prompt，vLLM 按 token block 自动 hash 命中。
- **手动**：API 层可附加 `cache_salt`（OpenAI 兼容字段）显式强制 "这条请求与 salt=X 的其他请求才能共享"。常用于多租户。

### 11.8.4 配置

`vllm/config/cache.py`：

| 参数 | 含义 |
| --- | --- |
| `enable_prefix_caching` | 总开关，默认 `True` |
| `prefix_caching_hash_algo` | `sha256`（默认，跨进程稳定）或 `builtin`（更快但 Python 哈希随机化） |
| `block_size` | 默认 16；越大复用越粗糙，但少计算 |
| `cache_salt` (per request) | API 层透传到 `Request.cache_salt` |

### 11.8.5 与其他特性的交互

| 与什么 | 行为 |
| --- | --- |
| Chunked prefill | 分块 prefill 仍按 block 命中；未填满最后一块用临时 hash |
| Spec decode | 接受/拒绝引起的 KV 写入仍按真实长度结算，hash 不变 |
| LoRA | adapter id 进入 extra_keys |
| Multimodal | mm_hash 进入 extra_keys，图片差则前缀不复用 |
| KV offloading | 命中后若 block 在 CPU/远端，会触发拉回（见 11.11） |
| Pooling | `skip_reading_prefix_cache=True` 的池化任务默认跳过 prefix cache（防止部分输出） |

详见 `docs/design/prefix_caching.md`、`docs/design/hybrid_kv_cache_manager.md`。

### 11.8.6 限制

- sha256 默认更安全但更慢；高 QPS 短 prompt 场景可换 `builtin`（牺牲跨进程稳定性）。
- block 内若部分 token 不同则整块不命中，因此对 system prompt 长度建议是 `block_size` 的整数倍。
- 在 `external_launcher` 分布式模式下 hash 算法必须一致，否则 ranks 间命中分歧。

---

## 11.9 Chunked Prefill（配置细节）

### 11.9.1 目的

让 prefill 不再独占整个 step：把一次长 prompt 切成多个 token-budget 片段，与 decode batch 同步执行。好处：

- decode 长尾延迟下降（不再被一条大 prefill 卡住）。
- GPU 利用率上升（prefill 与 decode 一起喂满 MMA）。

### 11.9.2 Token budget 计算

调度器伪代码（`vllm/v1/core/sched/scheduler.py` 主循环 simplified）：

```python
budget = scheduler_config.max_num_batched_tokens
# 1) 先扣掉运行中 decode 请求的 next tokens（含 spec K+1）
for req in running:
    budget -= 1 + num_spec_tokens(req)
# 2) 用剩余预算给 waiting 请求做 (partial) prefill
for req in waiting:
    if budget <= 0: break
    chunk = min(req.num_remaining_prefill_tokens, budget,
                long_prefill_token_threshold if req.is_long else inf)
    schedule(req, chunk); budget -= chunk
```

### 11.9.3 关键参数（`vllm/config/scheduler.py`）

| 参数 | 默认 | 用途 |
| --- | --- | --- |
| `enable_chunked_prefill` | `True` | 主开关 |
| `max_num_batched_tokens` | 2048 (测试默认) | 每 step 总 token 预算 |
| `max_num_seqs` | 128 | 同时 in-flight 请求上限 |
| `max_num_partial_prefills` | 1 | 同时 partial-prefill 的 prompt 数 |
| `max_long_partial_prefills` | 1 | 同时进行的 "长" prompt 数 |
| `long_prefill_token_threshold` | 0 (自动 = 4% × max_model_len) | 判定 prompt 是否 "长" |
| `disable_chunked_mm_input` | False | 多模态 item 是否允许跨步 |
| `scheduler_reserve_full_isl` | True | admit 前是否检查整个 prompt 装得下 KV |

### 11.9.4 与 spec decode 的交互

- spec decode 把每条 decode 序列的 token 数从 1 变成 `1 + K`，所以 chunked prefill 的 token 预算会被 decode 抢得更多。
- `max_num_scheduled_tokens` (`config/scheduler.py:56`) 与 `max_num_batched_tokens` 解耦：调度器按 `max_num_scheduled_tokens` 决定 worker 该处理多少 token，避免 spec 末位溢出 buffer。
- 启用 `parallel_drafting` 时，draft 仍然只额外消耗 K 个 token；scheduler 不区分 EAGLE vs n-gram。

### 11.9.5 与其他特性

| 与什么 | 行为 |
| --- | --- |
| Pooling 模型 | 默认 `not enable_chunked_prefill`，因为池化需要看到完整序列；除非显式开启 |
| Prefix caching | chunk 内沿用全 prompt 的 block hash；未对齐的 tail token 不进 cache |
| Multimodal | `disable_chunked_mm_input` 保护 image item 完整性 |
| LoRA | chunk 不影响 mapping；同请求仍是同一 adapter |

### 11.9.6 限制

- max_num_batched_tokens 过小会让长 prompt 占用过多调度步，TTFT 变高。
- max_long_partial_prefills 太大可能让多个长 prompt 互相挤兑 decode budget，需结合 SLO 调。

---

## 11.10 Pooling / Embedding 模型

### 11.10.1 目的

把 LLM 主体当作 encoder，最后一层输出做 pooling，得到向量 / 分类分数 / reward score。常见任务：

- **embed**：sentence embedding（bi-encoder）。
- **classify**：cross-encoder 分类，含 reward modeling。
- **token_embed** / **token_classify**：每 token 输出（late-interaction、token classification、ColBERT）。
- **embed&token_classify**：两路输出同时返回。
- **plugin**：通过 io_processor plugin 定义自定义任务。

### 11.10.2 架构

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="pooling 请求的执行流水：单次 prefill → hidden → Pooler → PoolerOutput">
  <defs>
    <marker id="ar11j" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Pooling 模型：只跑一次 prefill 取 hidden，没有 decode 自回归循环</text>
  <g transform="translate(160, 50)">
    <rect x="0" y="0" width="440" height="46" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="6"/>
    <text x="220" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">Request(prompt + PoolingParams)</text>
    <text x="220" y="36" text-anchor="middle" font-size="10" fill="#9a3412">task ∈ embed / classify / token_embed / token_classify / plugin</text>
  </g>
  <path d="M 380 96 L 380 116" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11j)"/>
  <g transform="translate(160, 120)">
    <rect x="0" y="0" width="440" height="46" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="6"/>
    <text x="220" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">Scheduler</text>
    <text x="220" y="36" text-anchor="middle" font-size="10" fill="#115e59">不进 decode 循环；单次 prefill 即可结束</text>
  </g>
  <path d="M 380 166 L 380 186" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11j)"/>
  <g transform="translate(160, 190)">
    <rect x="0" y="0" width="440" height="46" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2" rx="6"/>
    <text x="220" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">Model forward → 取 hidden states</text>
    <text x="220" y="36" text-anchor="middle" font-size="10" fill="#6d28d9">复用 generate 路径的 attention / KV，但不写 sampler</text>
  </g>
  <path d="M 380 236 L 380 256" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11j)"/>
  <g transform="translate(40, 260)">
    <rect x="0" y="0" width="680" height="56" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.2" rx="6"/>
    <text x="340" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">Pooler → PoolerOutput</text>
    <g transform="translate(20, 28)">
      <rect x="0" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="44" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">mean</text>
      <rect x="96" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="140" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">cls</text>
      <rect x="192" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="236" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">last</text>
      <rect x="288" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="332" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">step</text>
      <rect x="384" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="428" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">all</text>
      <rect x="480" y="0" width="88" height="22" fill="#e0f2fe" stroke="#7dd3fc" rx="3"/>
      <text x="524" y="14" text-anchor="middle" font-size="10" fill="#0c4a6e">token</text>
      <rect x="576" y="0" width="64" height="22" fill="#fef3c7" stroke="#facc15" rx="3"/>
      <text x="608" y="14" text-anchor="middle" font-size="10" fill="#92400e">plugin</text>
    </g>
  </g>
  <path d="M 380 316 L 380 336" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11j)"/>
  <g transform="translate(160, 340)">
    <rect x="0" y="0" width="440" height="34" fill="#fef3c7" stroke="#facc15" stroke-width="1" rx="4"/>
    <text x="220" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="#92400e">PoolingMetadata</text>
    <text x="220" y="28" text-anchor="middle" font-size="9" fill="#a16207">batch 内每请求的 task / dim / cursor —— v1/pool/metadata.py:49</text>
  </g>
</svg>
<span class="figure-caption">图 R11.10 ｜ Pooling 请求执行流水：Scheduler 跳过 decode 循环，model forward 后直接交给 Pooler（mean/cls/last/step/all/token/plugin 之一），PoolingMetadata 在 batch 内按请求选不同 task</span>

<details>
<summary>ASCII 原版</summary>

```
Request(prompt + PoolingParams)
        │
        ▼
Scheduler 不需要解码 loop，单次 prefill 即结束
        │
        ▼
Model forward → 取 hidden states
        │
        ▼
Pooler（mean/cls/last/step/all/token）→ PoolerOutput
        │
        ▼
PoolingMetadata 控制 batch 内不同请求的 task 与维度  (vllm/v1/pool/metadata.py:49)
```

</details>

`PoolingTask`（`vllm/tasks.py:8`）枚举支持的任务；`PoolingParams`（`vllm/pooling_params.py:37`）持有请求级覆盖：

```python
PoolingParams(
    task="embed",
    dimensions=512,       # matryoshka 截断
    use_activation=True,  # 是否对输出做激活
)
```

### 11.10.3 代码入口

- `vllm/pooling_params.py`：API 参数与校验。
- `vllm/model_executor/layers/pooler.py`：Pooler 层定义（mean、cls、last token、step、all、weighted、token-level）。
- `vllm/v1/pool/metadata.py`：`PoolingMetadata` / `PoolingCursor` / `PoolingStates`，包含 batch 内每请求的 cursor 信息。
- `vllm/v1/pool/late_interaction.py`：late-interaction 评分（MaxSim）。
- `vllm/config/pooler.py`：模型 `pooler_config`，控制默认 pooling type、normalize、激活、softmax 等。

### 11.10.4 与其他特性

- 默认 `skip_reading_prefix_cache=True` 对 token-level 任务（避免读到部分输出）。
- 不支持 spec decode、不支持 sampler 的随机/惩罚处理；走 `Sampler` 的纯 pooling 分支。
- chunked prefill 默认禁用（见 11.9）。

### 11.10.5 限制

- 只有满足 `SupportsPooling` 接口的模型可加载 pooler。
- `task` 必须在加载时模型声明的 supported pooling tasks 内，否则 `PoolingParams.verify` 抛错。
- `dimensions` 仅对训练过 matryoshka 的 embedding 模型生效。

### 11.10.6 late-interaction（ColBERT 风格）

`vllm/v1/pool/late_interaction.py` 提供 ColBERT 风格 retrieval 的实现：query / doc 各自走一次 token-level pooling，检索时按 token 计算 MaxSim：

```
score(q, d) = sum_i max_j  q_i · d_j
```

`compute_maxsim_score_batched`（`late_interaction.py:59`）把多个 `(query_emb, doc_emb)` 对在一次 forward 后批量打分。`get_late_interaction_engine_index`（`late_interaction.py:15`）决定 query 与 doc 是否走不同 engine 实例（典型部署：document 走大 batch GPU，query 走低延迟 GPU）。

`LateInteractionParams`（`vllm/pooling_params.py:17`）携带 query / doc id 信息：

```python
PoolingParams(
    task="token_embed",
    late_interaction_params=LateInteractionParams(
        kind="query",          # "query" 或 "doc"
        max_query_tokens=32,
    ),
)
```

---

## 11.11 KV Cache Offloading & P/D Disaggregation

### 11.11.1 目的

两个互相独立但常被一起讨论的能力：

1. **KV offloading**：当 GPU 内存装不下所有活跃序列的 KV 时，把冷 block 暂存到 CPU / NVMe / 远端节点，按需拉回。长上下文 (>128K) 推理的必须项。
2. **P/D disaggregation**：把 **P**refill 与 **D**ecode 部署在不同实例。Prefill 算密集 / decode 带宽密集，硬件配比不同；分开能避免互相 SLO 干扰，且 prefill 阶段产生的 KV 可以直接传到 decode 节点而非重新计算。

### 11.11.2 体系结构

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KVConnectorBase 抽象层把 offload 与跨节点 KV 传输统一">
  <defs>
    <marker id="ar11k" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">KVConnectorBase 抽象层：上游统一传 metadata，下游分三类后端</text>
  <g transform="translate(290, 50)">
    <rect x="0" y="0" width="180" height="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="90" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">Scheduler</text>
    <text x="90" y="40" text-anchor="middle" font-size="10" fill="#9a3412">knows KV layout</text>
    <text x="90" y="54" text-anchor="middle" font-size="9" fill="#c2410c">填充 KVConnectorMetadata</text>
  </g>
  <path d="M 380 110 L 380 144" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11k)"/>
  <text x="395" y="130" font-size="10" fill="#64748b">KVConnectorMetadata</text>
  <g transform="translate(260, 148)">
    <rect x="0" y="0" width="240" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="120" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">KVConnectorBase</text>
    <text x="120" y="40" text-anchor="middle" font-size="10" fill="#6d28d9">抽象层（4 个 hook）</text>
    <text x="120" y="54" text-anchor="middle" font-size="9" fill="#7c3aed">start_load_kv / wait_for_save / get_finished / bind_metadata</text>
  </g>
  <path d="M 380 208 L 130 244" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11k)"/>
  <path d="M 380 208 L 380 244" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11k)"/>
  <path d="M 380 208 L 630 244" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11k)"/>
  <g transform="translate(30, 248)">
    <rect x="0" y="0" width="200" height="92" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="6"/>
    <text x="100" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">SimpleCPU offload</text>
    <text x="100" y="38" text-anchor="middle" font-size="9" fill="#115e59">单进程 GPU ↔ CPU 拷贝</text>
    <line x1="14" y1="46" x2="186" y2="46" stroke="#5eead4" stroke-dasharray="3,2"/>
    <text x="100" y="62" text-anchor="middle" font-size="9" fill="#0f766e">simple_cpu_offload_</text>
    <text x="100" y="74" text-anchor="middle" font-size="9" fill="#0f766e">connector.py</text>
    <text x="100" y="86" text-anchor="middle" font-size="9" fill="#94a3b8">最简可靠</text>
  </g>
  <g transform="translate(280, 248)">
    <rect x="0" y="0" width="200" height="92" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.2" rx="6"/>
    <text x="100" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#0c4a6e">CPU / Tiering offload</text>
    <text x="100" y="38" text-anchor="middle" font-size="9" fill="#0c4a6e">通用 multi-tier 框架</text>
    <line x1="14" y1="46" x2="186" y2="46" stroke="#7dd3fc" stroke-dasharray="3,2"/>
    <text x="100" y="62" text-anchor="middle" font-size="9" fill="#075985">v1/kv_offload/{cpu,tiering}/</text>
    <text x="100" y="74" text-anchor="middle" font-size="9" fill="#075985">spec + manager + worker</text>
    <text x="100" y="86" text-anchor="middle" font-size="9" fill="#94a3b8">CPU / NVMe / 对象存储</text>
  </g>
  <g transform="translate(530, 248)">
    <rect x="0" y="0" width="200" height="92" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="6"/>
    <text x="100" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">P2P / 远端 KV 传输</text>
    <text x="100" y="38" text-anchor="middle" font-size="9" fill="#9a3412">跨节点 P/D 解耦</text>
    <line x1="14" y1="46" x2="186" y2="46" stroke="#fdba74" stroke-dasharray="3,2"/>
    <text x="100" y="62" text-anchor="middle" font-size="9" fill="#c2410c">P2pNccl / Mooncake / NIXL</text>
    <text x="100" y="74" text-anchor="middle" font-size="9" fill="#c2410c">LMCache / Hf3fs / FlexKV</text>
    <text x="100" y="86" text-anchor="middle" font-size="9" fill="#94a3b8">prefill → decode 直推 KV</text>
  </g>
</svg>
<span class="figure-caption">图 R11.11 ｜ Scheduler 通过 KVConnectorBase 的四个 hook 与三类后端统一对话：单进程 CPU offload、通用 multi-tier 框架、以及跨节点 P2P/远端 KV 传输（P/D 解耦走最后一类）</span>

<details>
<summary>ASCII 原版</summary>

```
                    +-------------------+
                    |   Scheduler       |
                    | (knows KV layout) |
                    +---------+---------+
                              │ KVConnectorMetadata
                              ▼
                    +-------------------+
                    | KVConnectorBase   |  ← 抽象层
                    +---------+---------+
                              │
   ┌──────────────────────────┼───────────────────────────┐
   ▼                          ▼                           ▼
 SimpleCPU            CPU/Tiering offload          P2P NCCL / Mooncake / NIXL
 offload_connector    spec.py + manager.py         (跨节点 KV 传输)
 (单进程, GPU↔CPU)    + worker.py (vllm/v1/        
                       kv_offload/cpu/)
```

</details>

### 11.11.3 KV offload 子系统

vLLM 提供 **两个独立** 的 offload 实现：

- `vllm/v1/simple_kv_offload/`：单进程 GPU↔CPU 拷贝，简单可靠；通过 `simple_cpu_offload_connector.py` 暴露为标准 connector。`SimpleCPUOffloadScheduler` (`manager.py:67`) 在 scheduler 端跟踪 GPU block ↔ CPU block 的映射。
- `vllm/v1/kv_offload/`：通用 multi-tier 框架，支持 CPU、NVMe、远端：
  - `base.py`：`OffloadingSpec`（`base.py:330`）、`OffloadingManager`（`base.py:109`）、`LoadStoreSpec`、`OffloadingEvent`。
  - `factory.py`：按名查找具体 spec（`CPUOffloadingSpec`、`TieringOffloadingSpec`）。
  - `cpu/`：CPU tier 实现（page-locked memory, async cudaMemcpyAsync）。
  - `tiering/`：CPU + 持久化层（NVMe / 对象存储）的分级。
  - `worker/`：worker 端 copy backend，含 `copy_backend.py` 与 `cuda_mem_ops.py`。

### 11.11.4 KV connector 抽象（P/D + 远端 cache）

`KVConnectorBase` 把所有跨节点 / 跨进程的 KV 传输统一为四个 hook：

```
bind_connector_metadata(meta)
start_load_kv(forward_context)      # async pull from remote
wait_for_save()                     # async push to remote
get_finished(finished_req_ids)      # report finished sends/recvs
```

`KVConnectorModelRunnerMixin` (`vllm/v1/worker/kv_connector_model_runner_mixin.py:36`) 把这些 hook 嵌入 `execute_model` 的 lifecycle context：

```python
@contextmanager
def _get_kv_connector_output(scheduler_output, wait_for_save=True, ...):
    kv_connector = get_kv_transfer_group()
    kv_connector.bind_connector_metadata(scheduler_output.kv_connector_metadata)
    kv_connector.start_load_kv(get_forward_context())   # async pull
    try:
        yield output                                    # model.forward 在这里
    finally:
        if wait_for_save and not defer_finalize:
            kv_connector.wait_for_save()                # fence push
        output.finished_sending, output.finished_recving = \
            kv_connector.get_finished(scheduler_output.finished_req_ids)
        output.invalid_block_ids = kv_connector.get_block_ids_with_load_errors()
```

`defer_finalize=True` 用于 spec decode + remote KV：把 `wait_for_save` 推迟到 draft model forward 之后，让 KV push 与 draft 计算重叠。`invalid_block_ids` 用于上游 retry：如果远端 block 拉失败，scheduler 将相应请求重新 enqueue。

已注册的 connector（`vllm/distributed/kv_transfer/kv_connector/v1/`）：

| Connector | 文件 | 用途 |
| --- | --- | --- |
| `P2pNcclConnector` | `p2p/p2p_nccl_connector.py:74` | 节点间 NCCL P2P 传输，prefill→decode 直推 |
| `MooncakeConnector` | `mooncake/mooncake_connector.py` | Mooncake transfer engine，支持 NVMe / RDMA |
| `MooncakeStoreConnector` | `mooncake/...` | Mooncake KV store backend，按 hash 复用 |
| `NixlConnector` | `nixl/` | NVIDIA NIXL，跨进程零拷贝 |
| `LMCacheConnector` | `lmcache_connector.py` | LMCache 集成（长上下文重用） |
| `Hf3fsConnector` | `hf3fs/` | DeepSeek 3FS |
| `FlexKVConnector` | `flexkv_connector.py` | FlexKV |
| `MoriIOConnector` | `moriio/` | MoriIO |
| `MultiConnector` | `multi_connector.py` | 多 connector 链接（如先查 LMCache 命中再走 Mooncake） |
| `SimpleCPUOffloadConnector` | `simple_cpu_offload_connector.py` | 见 11.11.3 |
| `OffloadingConnector` | `offloading_connector.py` | 通用 offload 框架的 connector 包装 |

### 11.11.5 配置

`vllm/config/kv_transfer.py` 的 `KVTransferConfig`：

| 参数 | 含义 |
| --- | --- |
| `kv_connector` | connector 类名（如 `MooncakeConnector`） |
| `kv_role` | `kv_producer` (prefill) / `kv_consumer` (decode) / `kv_both` |
| `kv_connector_extra_config` | 子 connector 的字段（如 `spec_name`、URL） |
| `kv_buffer_size` / `kv_buffer_device` | 中转 buffer |

`vllm/config/offload.py` 的 `KVOffloadConfig`：

| 参数 | 含义 |
| --- | --- |
| `kv_offload_dtype` | 通常与 GPU 一致 |
| `kv_offload_capacity` | CPU 池容量 (bytes) |
| `kv_offload_lazy` | 是否懒拷贝 |

### 11.11.6 限制

- P2P NCCL 要求所有节点同构 (TP 形状相同)；异构通过 Mooncake / NIXL 解决。
- Mooncake 的 store backend 需独立部署 Mooncake master + worker 进程。
- offload 命中带来的 `start_load_kv` 是 async，但 `wait_for_save` 的 fence 可能在 decode 末段引入抖动，调度器通过 `defer_finalize=True` 推迟到 spec decode draft 之后。
- 参考 `docs/design/p2p_nccl_connector.md`，KV transfer README `vllm/distributed/kv_transfer/README.md`。

---

## 11.12 Reasoning Models

### 11.12.1 目的

DeepSeek-R1、QwQ、Gemma-Thinking 等模型把 chain-of-thought 包在专用标签 (`<think>...</think>`、`<seed:think>...`) 内；推理服务必须：

1. 在流式输出中识别 reasoning 段，与 final answer 分离上报。
2. 把 reasoning 段从 tool/function call 解析中排除。
3. 与 structured output 协调：reasoning 段允许自由文本，最终答案才走 grammar。

### 11.12.2 抽象与实现

`ReasoningParser`（`vllm/reasoning/abs_reasoning_parsers.py:26`）定义：

- `reasoning_start_str` / `reasoning_end_str`：开始 / 结束 token。
- `extract_reasoning_content(...)`：从最终文本切分 reasoning vs response。
- `extract_reasoning_content_streaming(...)`：流式增量处理。
- `is_reasoning_end(token_ids)`：当前是否已进入 final answer。

`ReasoningParserManager`（`abs_reasoning_parsers.py:189`）按名注册，可被 plugin 扩展。

```
model raw output:  <think> step1... step2... </think> Answer: 42
                          ─────reasoning_content─────  ──content──
                                                       │
ReasoningParser.is_reasoning_end(token_ids=...)── True 起，
                  StructuredOutputManager 才开始
                  对后续位置施加 grammar bitmask
```

`enable_in_reasoning=True` 时反过来：grammar 从一开始就生效，常见于强制 reasoning 段也是 JSON 的场景。

### 11.12.3 已注册解析器（`vllm/reasoning/`）

`basic_parsers.py`、`deepseek_r1_reasoning_parser.py`、`deepseek_v3_reasoning_parser.py`、`qwen3_reasoning_parser.py`、`gemma4_reasoning_parser.py`、`gptoss_reasoning_parser.py`、`hunyuan_a13b_reasoning_parser.py`、`kimi_k2_reasoning_parser.py`、`minimax_m2_reasoning_parser.py`、`mistral_reasoning_parser.py`、`step3_reasoning_parser.py` 等。

### 11.12.4 与 structured output 集成

`StructuredOutputManager._get_reasoner` (`vllm/v1/structured_output/__init__.py:99`) 在每条 request 上 lazy 构造 reasoner，借助 `is_reasoning_end` 决定何时开始施加 grammar bitmask。`enable_in_reasoning` 控制是否在 reasoning 段也启用。

### 11.12.5 配置

`vllm/config/structured_outputs.py:35` 的 `reasoning_parser` 与 `reasoning_parser_plugin`；可用 `--reasoning-parser deepseek_r1` 启用。

### 11.12.6 限制

- reasoning token 仍计入 max_tokens 与 KV cache；服务端不会"白嫖"它的代价。
- 部分模型 reasoning 段在 tokenizer 中没有专用 token，依靠字面字符串匹配，遇到 byte-pair fragmentation 时可能漏判，需要 model-specific 实现。

---

## 11.13 Tool Use / Function Calling

### 11.13.1 目的

让模型按 OpenAI tools / function-calling 协议输出工具调用：

```
< tool_call > {"name":"search","args":{"q":"..."}} </ tool_call >
```

服务端必须把这种自由文本流式解析回 `tool_calls: [...]` JSON 字段。

### 11.13.2 抽象

`ToolParser`（`vllm/tool_parsers/abstract_tool_parser.py:43`）：

- `extract_tool_calls(text, request)`：一次性。
- `extract_tool_calls_streaming(...)`：增量，状态机维护。
- 通过 `ToolParserManager`（`abstract_tool_parser.py:192`）按名注册，支持 plugin 扩展。

### 11.13.3 已注册解析器

`vllm/tool_parsers/` 下覆盖：DeepSeek (v3/v31/v32/v4)、Hermes、Granite (3/4/20b_fc)、Mistral、Llama (3.1/4 pythonic)、Internlm2、Jamba、Kimi-K2、LFM2、Hunyuan、Gemma4、GLM4 MoE / GLM47 MoE、GigaChat3、Cohere Command、MiniMax、Minimax-M2、Longcat、Hy-V3、Ernie45、Functiongemma 等。每个解析器对应一种模型 family 的 tool-call 输出格式。

### 11.13.4 与其他特性

- 通常与 reasoning parser 同时启用：reasoning 段不应被解析为 tool call。
- 与 structured output 互补：`structural_tag` 模式可以强制 tool call 块是合法 JSON。
- 流式接口：增量 parser 必须保证每帧返回的 delta 与 OpenAI 兼容。

### 11.13.5 配置

`--tool-parser hermes`（或 plugin 名），与 `--enable-auto-tool-choice` 配合。请求级 `tools` / `tool_choice` 通过 `SamplingParams` / chat 请求传入。

### 11.13.6 限制

- 解析器是 model-specific：错配会让 tool_calls 永远空；选错容易静默丢失。
- 流式状态机对反斜杠 / unicode escape 行为各异；建议先在 non-streaming 调通。

---

## 11.14 Tracing & Metrics

### 11.14.1 目的

生产环境需要：

- Prometheus 指标暴露（QPS、TTFT、TPOT、KV cache 利用率、queue length、preemption）。
- 分布式 trace（每个 request 在 frontend / engine / worker 内的 span 链）。
- 离线 stats 文件（cost 分析）。

### 11.14.2 Metrics 体系

`vllm/v1/metrics/`：

- `stats.py`：`SchedulerStats`、`IterationStats`、`PrefillStats`、`FinishedRequestStats`、`LoRAStats` 等 dataclass，scheduler 每 step 填充。
- `loggers.py`：`StatLoggerBase` (`loggers.py:44`) 抽象，子类：
  - `LoggingStatLogger`（`loggers.py:99`）：周期打印到 stdout。
  - `PrometheusStatLogger`（`loggers.py:404`）：暴露 metrics 给 `/metrics`。
  - `AggregatedLoggingStatLogger`、`PerEngineStatLoggerAdapter`：DP/PP 多引擎聚合。
- `prometheus.py`：注册 collector、setup multi-process registry（与 gunicorn 兼容）。
- `reader.py`：把 EngineCore 发出的 IPC 消息解码成 stats。
- `perf.py`：高频性能采样。
- `ray_wrappers.py`：Ray 多 actor 环境下的 metrics 聚合。

接入第三方 logger：通过 `vllm.stat_logger_plugins` entry point（`vllm/plugins/__init__.py:22`）。

### 11.14.3 Tracing

`vllm/tracing/otel.py`：

- `is_otel_available()`、`init_otel_tracer(...)`、`init_otel_worker_tracer(...)`：分别在前端与 worker 初始化 OTLP exporter。
- `extract_trace_context(headers)` / `propagate_trace_to_env()`：在 HTTP / 子进程边界传播 W3C trace context。
- `instrument_otel(...)` / `manual_instrument_otel(...)`：装饰器与手动 span。
- `_get_smart_context()`：在 collective_rpc 等 multi-worker 场景把同一 root span 对齐。

`vllm/tracing/utils.py` 提供 `SpanAttributes`（按 OpenInference / OpenLLMetry 兼容字段命名）。

### 11.14.4 关键指标（节选）

| 指标 | 含义 |
| --- | --- |
| `vllm:num_requests_running` | 当前 in-flight 请求数 |
| `vllm:num_requests_waiting` | queue 长度 |
| `vllm:gpu_cache_usage_perc` | KV cache 占用率 |
| `vllm:time_to_first_token_seconds` | TTFT |
| `vllm:time_per_output_token_seconds` | TPOT |
| `vllm:request_prefill_seconds` | prefill 阶段耗时 |
| `vllm:request_decode_seconds` | decode 阶段耗时 |
| `vllm:spec_decode_num_accepted_tokens_total` | 投机解码累计接受 token |
| `vllm:lora_requests_info` | per-LoRA 请求计数 |

详见 `docs/design/metrics.md`。

### 11.14.5 限制

- multiprocess Prometheus 需要 `PROMETHEUS_MULTIPROC_DIR` 环境变量（`prometheus.py:17`）。
- OTel 不会自动 trace `torch.compile` 编译时间；要用 `monitor_torch_compile` 单独读取。

### 11.14.6 stats 流水

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="metrics 流水：execute_model → EngineCore → IPC → StatLoggerManager fanout">
  <defs>
    <marker id="ar11l" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">stats 流水：worker 产生 per-step 数据 → engine 聚合 → IPC → 多 sink 同时消费</text>
  <g transform="translate(180, 50)">
    <rect x="0" y="0" width="400" height="50" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="6"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#7c2d12">GPUModelRunner.execute_model</text>
    <text x="200" y="38" text-anchor="middle" font-size="10" fill="#9a3412">每 step 产出 model output + KV cache stats</text>
  </g>
  <path d="M 380 100 L 380 124" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11l)"/>
  <g transform="translate(180, 128)">
    <rect x="0" y="0" width="400" height="58" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2" rx="6"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">EngineCore（per-iteration aggregation）</text>
    <text x="200" y="38" text-anchor="middle" font-size="10" fill="#115e59">IterationStats / PrefillStats /</text>
    <text x="200" y="52" text-anchor="middle" font-size="10" fill="#115e59">FinishedRequestStats / LoRAStats</text>
  </g>
  <path d="M 380 186 L 380 210" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11l)"/>
  <g transform="translate(220, 214)">
    <rect x="0" y="0" width="320" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2" rx="4"/>
    <text x="160" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">IPC message（ZMQ / Ray queue）</text>
  </g>
  <path d="M 380 250 L 380 270" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar11l)"/>
  <g transform="translate(160, 274)">
    <rect x="0" y="0" width="440" height="46" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="220" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">StatLoggerManager (process0)</text>
    <text x="220" y="36" text-anchor="middle" font-size="10" fill="#075985">多 logger 注册 + fan-out</text>
  </g>
  <path d="M 220 320 L 110 354" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11l)"/>
  <path d="M 380 320 L 380 354" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11l)"/>
  <path d="M 540 320 L 650 354" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11l)"/>
  <g transform="translate(30, 332)">
    <rect x="0" y="20" width="160" height="40" fill="#fef3c7" stroke="#facc15" rx="4"/>
    <text x="80" y="36" text-anchor="middle" font-size="10" font-weight="700" fill="#92400e">LoggingStatLogger</text>
    <text x="80" y="52" text-anchor="middle" font-size="9" fill="#a16207">stdout 每 N 秒</text>
  </g>
  <g transform="translate(300, 332)">
    <rect x="0" y="20" width="160" height="40" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="80" y="36" text-anchor="middle" font-size="10" font-weight="700" fill="#166534">PrometheusStatLogger</text>
    <text x="80" y="52" text-anchor="middle" font-size="9" fill="#14532d">/metrics 抓取</text>
  </g>
  <g transform="translate(570, 332)">
    <rect x="0" y="20" width="160" height="40" fill="#fef2f2" stroke="#fca5a5" rx="4"/>
    <text x="80" y="36" text-anchor="middle" font-size="10" font-weight="700" fill="#991b1b">user-defined plugin</text>
    <text x="80" y="52" text-anchor="middle" font-size="9" fill="#b91c1c">datadog / OTel / S3 …</text>
  </g>
</svg>
<span class="figure-caption">图 R11.12 ｜ metrics 数据流：worker per-step stats → EngineCore 聚合成 IterationStats/FinishedRequestStats → IPC 到 process0 → StatLoggerManager 同时 fan-out 给 stdout、Prometheus 与任意第三方 plugin</span>

<details>
<summary>ASCII 原版</summary>

```
GPUModelRunner.execute_model
        │  emit per-step model output + KV cache stats
        ▼
EngineCore  (per-iteration aggregation)
        │  IterationStats / PrefillStats / FinishedRequestStats
        ▼
IPC message  (zmq / Ray queue)
        │
        ▼
StatLoggerManager  (process0)
   ├─ LoggingStatLogger   → stdout 每 N 秒
   ├─ PrometheusStatLogger → /metrics
   └─ user-defined plugin → datadog / opentelemetry / s3 ...
```

</details>

`IterationStats`（`stats.py:325`）聚合 per-step 全 batch 信息；`FinishedRequestStats`（`stats.py:224`）只在请求 finish 时记录端到端 TTFT/TPOT/总长度。Prometheus 直方图按 `build_1_2_5_buckets`（`loggers.py:1259`）生成 1-2-5 系列 bucket（1, 2, 5, 10, 20, 50, ...），覆盖横跨多个数量级的延迟分布。

---

## 11.15 Plugins

### 11.15.1 目的

允许第三方在不修改 vLLM 源码的前提下扩展行为：自定义平台、量化方法、tool/reasoning parser、io-processor、KV connector、stat logger、LoRA resolver。

### 11.15.2 机制

通过 Python entry points（`pyproject.toml` 中的 `[project.entry-points."<group>"]`）：

`vllm/plugins/__init__.py:13-22` 注册四个 group：

| Group | 加载时机 | 用途 |
| --- | --- | --- |
| `vllm.general_plugins` | 所有进程 | 注册模型架构、量化方法、自定义 op |
| `vllm.io_processor_plugins` | process0 | 自定义 pooling 任务 IO 处理 |
| `vllm.platform_plugins` | 第一次访问 `current_platform` | 注册新硬件后端 |
| `vllm.stat_logger_plugins` | process0 (async) | 自定义 metrics sink |

加载入口 `load_plugins_by_group`（`vllm/plugins/__init__.py:28`）：

```python
discovered = entry_points(group=group)
for plugin in discovered:
    if allowed_plugins is None or plugin.name in allowed_plugins:
        plugin.load()()   # 调用 entry 函数
```

通过 `VLLM_PLUGINS` 环境变量白名单限制（按名加载）。

### 11.15.3 已内置插件子系统

- `vllm/plugins/io_processors/`：`interface.py` 定义 `IOProcessor` 抽象，pooling 模型 `task="plugin"` 时使用。
- `vllm/plugins/lora_resolvers/`：
  - `filesystem_resolver.py`：按本地路径解析 LoRA 名称。
  - `hf_hub_resolver.py`：直接从 HF Hub 拉。
  - 注册到 `vllm.lora.resolver.LoRAResolverRegistry`，让 `LLM(..., lora_modules=[...])` 支持远端 ID。

### 11.15.4 已通过 plugin 暴露的扩展点

- 自定义 attention backend（`AttentionBackendEnum` + plugin 注册）。
- 自定义 scheduler（`scheduler_cls="my_mod.MyScheduler"`，`vllm/config/scheduler.py:127`）。
- 自定义 quantization 方法（`register_quantization_config`，11.2.3）。
- 自定义 reasoning / tool parser（`ReasoningParserManager` / `ToolParserManager`）。
- 自定义 KV connector（注册到 `KVConnectorFactory`，11.11.4）。
- 自定义 spec decode proposer（`create_custom_proposer`，11.1.3）。

### 11.15.5 限制

- 一个 plugin 函数会在多个进程被多次调用，必须幂等（`__init__.py:70` 注释）。
- entry point 一旦发现失败会被 `logger.exception` 静默吞掉，仅看 warning 日志才能发现。
- 详见 `docs/design/plugin_system.md`、`docs/design/io_processor_plugins.md`、`docs/design/lora_resolver_plugins.md`。

### 11.15.6 示例：注册自定义量化方法

```python
# my_pkg/__init__.py
from vllm.model_executor.layers.quantization import (
    register_quantization_config,
)
from vllm.model_executor.layers.quantization.base_config import (
    QuantizationConfig,
)

@register_quantization_config("my_int3")
class MyInt3Config(QuantizationConfig):
    def get_name(self): return "my_int3"
    def get_min_capability(self): return 80
    def get_supported_act_dtypes(self): return [torch.float16]
    @classmethod
    def from_config(cls, cfg): return cls()
    def get_quant_method(self, layer, prefix): ...

def register():
    pass  # 只要 import 完成 @register 装饰器就生效
```

```toml
# pyproject.toml
[project.entry-points."vllm.general_plugins"]
my_int3 = "my_pkg:register"
```

随后 `vllm serve --quantization my_int3 ...` 即可加载（前提是 `VLLM_PLUGINS` 未将其排除）。

---

## 11.A 特性矩阵速查

```
                          spec  prefix  chunked  CUDA   torch   LoRA  MM   pool  struct  P/D
                          dec.  cache   prefill  Graph  comp.                     out.    disagg
generate 模型              Y      Y       Y       Y      Y      Y    Y    -     Y       Y
embedding/classify pool    -      *       *       Y      Y      Y    Y    Y     -       -
multimodal generate        Y      Y       Y(MM*)  Y      Y      Y    Y    -     Y       Y
reasoning model            Y      Y       Y       Y      Y      Y    -    -     Y(seg)  Y
P/D consumer (decode)      Y      Y       Y       Y      Y      Y    Y    -     Y       Y
P/D producer (prefill)     -      Y       Y       Y      Y      Y    Y    -     -       Y

* pooling 默认 skip prefix cache；chunked prefill 需显式开启
* MM chunked prefill 受 disable_chunked_mm_input 控制
```

## 11.B 文档与代码 cross-reference

| 主题 | 主要代码 | 设计文档 |
| --- | --- | --- |
| Spec decode | `vllm/v1/spec_decode/`, `vllm/v1/sample/rejection_sampler.py` | (源代码注释为主) |
| Quantization | `vllm/model_executor/layers/quantization/` | (源代码 + HF 文档) |
| torch.compile | `vllm/compilation/` | `docs/design/torch_compile.md`, `docs/design/optimization_levels.md`, `docs/design/debug_vllm_compile.md`, `docs/design/fusions.md`, `docs/design/vllm_ir.md` |
| CUDA Graph | `vllm/v1/cudagraph_dispatcher.py`, `vllm/compilation/cuda_graph.py`, `vllm/v1/worker/gpu_ubatch_wrapper.py` | `docs/design/cuda_graphs.md`, `docs/design/cuda_graphs_multimodal.md` |
| LoRA | `vllm/lora/` | (Punica paper) |
| Multimodal | `vllm/multimodal/`, `vllm/v1/core/encoder_cache_manager.py`, `vllm/v1/worker/encoder_cudagraph.py` | `docs/design/mm_processing.md`, `docs/design/torch_compile_multimodal.md` |
| Structured output | `vllm/v1/structured_output/` | (源代码 + xgrammar/outlines 上游文档) |
| Prefix caching | `vllm/v1/core/kv_cache_*.py` | `docs/design/prefix_caching.md`, `docs/design/hybrid_kv_cache_manager.md` |
| Chunked prefill | `vllm/v1/core/sched/scheduler.py`, `vllm/config/scheduler.py` | `docs/design/arch_overview.md` |
| Pooling | `vllm/v1/pool/`, `vllm/pooling_params.py`, `vllm/model_executor/layers/pooler.py` | (源代码) |
| KV offload / P-D | `vllm/v1/kv_offload/`, `vllm/v1/simple_kv_offload/`, `vllm/distributed/kv_transfer/` | `docs/design/p2p_nccl_connector.md`, `vllm/distributed/kv_transfer/README.md` |
| Reasoning | `vllm/reasoning/` | (源代码) |
| Tool use | `vllm/tool_parsers/` | (源代码) |
| Tracing & Metrics | `vllm/v1/metrics/`, `vllm/tracing/` | `docs/design/metrics.md` |
| Plugins | `vllm/plugins/` | `docs/design/plugin_system.md`, `docs/design/io_processor_plugins.md`, `docs/design/lora_resolver_plugins.md` |
