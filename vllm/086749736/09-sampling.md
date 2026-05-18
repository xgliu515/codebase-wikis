# 第 9 章 采样与 Logits 处理

本章只覆盖 vLLM V1 的实现（`vllm/v1/sample/`）。V0 的 sampler 早已被废弃，但部分共享算子仍位于 `vllm/model_executor/layers/utils.py` 与 `vllm/logits_process.py`。

读者预设：熟悉 PyTorch、了解 transformer 解码流程、读过本书第 6 章（ModelRunner）。

## 9.1 设计目标与目录结构

vLLM 的 sampler 必须同时满足三类相互拉扯的需求：

1. **正确性**：每条请求可以拥有完全不同的 `temperature`、`top_k`、`top_p`、`min_p`、惩罚、`logit_bias`、`allowed_token_ids`、`bad_words`、结构化输出约束等，并且必须按 OpenAI / HF 的语义工作。
2. **吞吐**：一次 forward 在同一个 batch 中处理几十到几百条请求；任何 Python 层 for-loop、CPU↔GPU 同步都会成为瓶颈。
3. **可扩展**：用户可以注入自定义 logits processor 插件；支持 speculative decoding、结构化解码、thinking budget 等需要在 logits 上"打补丁"的特性。

为此 V1 把整个采样链拆成了三层职责分明的组件。

```
vllm/v1/sample/
├── __init__.py                        (空)
├── metadata.py                        SamplingMetadata dataclass — 一步内对整批请求生效
├── sampler.py                         主 Sampler；标准 decode/prefill 末位采样
├── rejection_sampler.py               投机解码用 rejection sampling + bonus token
├── thinking_budget_state.py           思考预算 logits 掩码
├── logits_processor/
│   ├── __init__.py                    插件加载、AdapterLogitsProcessor、build_logitsprocs()
│   ├── interface.py                   LogitsProcessor 抽象基类、BatchUpdate 协议
│   ├── builtin.py                     内置三件套：MinTokens / LogitBias / MinP
│   └── state.py                       BatchUpdateBuilder、LogitsProcessors 容器
└── ops/
    ├── bad_words.py                   bad-words 字串黑名单（last-token 掩码）
    ├── logprobs.py                    batched_count_greater_than（排名计数）
    ├── penalties.py                   apply_all_penalties 包装
    ├── topk_topp_sampler.py           TopKTopPSampler nn.Module（多后端 dispatch）
    └── topk_topp_triton.py            top-k / top-p 的 Triton kernel（>= 8 行）
```

ModelRunner 与 Sampler 的接口非常窄：

```
ModelRunner.execute_model
    └─ self._sample(logits, spec_decode_metadata)
         ├─ sampling_metadata = self.input_batch.sampling_metadata    # 每步重组
         ├─ if spec_decode_metadata is None:
         │      return self.sampler(logits, sampling_metadata)
         └─ else:
                return self.rejection_sampler(spec_meta, draft_probs,
                                              logits, sampling_metadata)
```

入口在 `vllm/v1/worker/gpu_model_runner.py:3439`。注意：

- 模型只输出 `logits`（形状 `[num_sample_tokens, vocab]`，已经按 `logits_indices` 筛过——只保留每条请求要"取下一个 token"的那些位置）。这一步发生在 `_extract_sample_logits` 之类的钩子里，sampler 永远只看到要采样的行，从不知道 prefill 内部其他 token 的存在。
- 结构化输出 bitmask 在调用 sampler 前已经原地写到 `logits`（`vllm/v1/worker/gpu_model_runner.py:4301`，见 9.7）。
- 对于投机解码，logits 包含每条请求"K 个 draft 位置 + 1 个 bonus 位置"共 K+1 行，分发给 rejection sampler。

<svg viewBox="0 0 880 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="GPUModelRunner._sample 按 spec_metadata 是否为空分发到 Sampler 或 RejectionSampler">
  <defs>
    <marker id="r9ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">从 Model.forward 到 ModelRunnerOutput：按 spec_metadata 分发的两条采样路径</text>
  <g transform="translate(320, 38)">
    <rect x="0" y="0" width="240" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="120" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">Model.forward</text>
    <text x="120" y="38" text-anchor="middle" font-size="11" fill="#9a3412">→ logits [T, V]</text>
  </g>
  <path d="M 440 86 L 440 104" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <g transform="translate(280, 108)">
    <rect x="0" y="0" width="320" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="160" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">GPUModelRunner._sample()</text>
    <text x="160" y="36" text-anchor="middle" font-size="10" fill="#6d28d9">入口 gpu_model_runner.py:3439</text>
  </g>
  <path d="M 440 152 L 440 168 L 220 168 L 220 188" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <path d="M 440 152 L 440 168 L 660 168 L 660 188" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <text x="220" y="180" text-anchor="middle" font-size="10" font-style="italic" fill="#0d9488">spec_metadata is None</text>
  <text x="660" y="180" text-anchor="middle" font-size="10" font-style="italic" fill="#dc2626">spec_metadata not None</text>
  <g transform="translate(80, 192)">
    <rect x="0" y="0" width="280" height="62" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.5"/>
    <text x="140" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">Sampler</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#0f766e">sampler.py</text>
    <text x="140" y="52" text-anchor="middle" font-size="9" fill="#0f766e">标准 decode / prefill 末位采样</text>
  </g>
  <g transform="translate(520, 192)">
    <rect x="0" y="0" width="280" height="62" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
    <text x="140" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#991b1b">RejectionSampler</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#b91c1c">rejection_sampler.py</text>
    <text x="140" y="52" text-anchor="middle" font-size="9" fill="#b91c1c">投机解码：accept / recover / bonus</text>
  </g>
  <path d="M 220 254 L 220 274" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <path d="M 660 254 L 660 274" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <g transform="translate(80, 278)">
    <rect x="0" y="0" width="280" height="62" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="140" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">SamplerOutput</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#7c2d12">sampled_token_ids</text>
    <text x="140" y="52" text-anchor="middle" font-size="10" fill="#7c2d12">logprobs_tensors</text>
  </g>
  <g transform="translate(520, 278)">
    <rect x="0" y="0" width="280" height="62" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="140" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">SamplerOutput</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#7c2d12">sampled + recovered / bonus</text>
    <text x="140" y="52" text-anchor="middle" font-size="9" fill="#7c2d12">每行长度不一（PLACEHOLDER -1 填补）</text>
  </g>
  <path d="M 360 308 L 520 308" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r9ar1)"/>
  <text x="440" y="302" text-anchor="middle" font-size="9" fill="#64748b">结构同形（spec 用变长行）</text>
  <path d="M 220 340 L 220 360 L 440 360 L 440 380" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M 660 340 L 660 360 L 440 360 L 440 380" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <g transform="translate(200, 384)">
    <rect x="0" y="0" width="480" height="48" rx="6" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="240" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">ModelRunnerOutput.sampled_token_ids</text>
    <text x="240" y="38" text-anchor="middle" font-size="10" fill="#6d28d9">list[list[int]]  ·  D2H + IPC 回 scheduler 进程</text>
  </g>
</svg>
<span class="figure-caption">图 R9.1 ｜ GPUModelRunner._sample 按 spec_decode_metadata 是否为空分两条路径——None 走主 Sampler、有值走 RejectionSampler；两者都产 SamplerOutput，最终在 _bookkeeping_sync 阶段 D2H 成 Python list 返回 scheduler</span>

<details>
<summary>ASCII 原版</summary>

```
                   +----------------+
   batched         |  Model.forward |
   logits  ───────▶|  → logits[T,V] |
                   +----------------+
                            │
                            ▼
            +-------------------------------------+
            |  GPUModelRunner._sample()           |
            +-------------------------------------+
                            │
              spec_metadata │ None?            spec_metadata │ not None?
                            ▼                                ▼
                  +-----------------+              +------------------------+
                  |   Sampler       |              |   RejectionSampler     |
                  |   (sampler.py)  |              |   (rejection_sampler.py)|
                  +-----------------+              +------------------------+
                            │                                │
                            ▼                                ▼
                +-----------------------+         +-----------------------+
                |     SamplerOutput     |◀────────|     SamplerOutput     |
                |  sampled_token_ids    |         |  (+ recovered/bonus)  |
                |  logprobs_tensors     |         +-----------------------+
                +-----------------------+
                            │
                            ▼
                  ModelRunnerOutput.sampled_token_ids: list[list[int]]
```

</details>

---

## 9.2 SamplingParams：所有可配置的旋钮

`vllm/sampling_params.py:168` 定义的 `SamplingParams` 是 OpenAI Completions API 的超集，外加一些 vLLM 专属字段。它是一个 msgspec Struct（`omit_defaults=True`），所以默认值字段不会出现在序列化中——这对 EngineCore 跨进程传输至关重要。

### 9.2.1 核心采样字段

| 字段 | 默认 | 语义 / 落点 |
| --- | --- | --- |
| `n` (`sampling_params.py:182`) | 1 | 每个 prompt 要返回多少独立完成。`n>1` 在前端被拆成 n 个 child request，见 9.11 |
| `temperature` (`:205`) | 1.0 | `< _SAMPLING_EPS (1e-5)` 视为 greedy，此时 `top_p/top_k/min_p` 自动归零（`__post_init__` 中 `:436`）。负值在 `_verify_args` 报错 |
| `top_p` (`:209`) | 1.0 | 必须在 `(0, 1]` |
| `top_k` (`:212`) | 0 | 0 或 -1 表示禁用；`< -1` 报错 |
| `min_p` (`:215`) | 0.0 | 相对最大概率的最小阈值；0 禁用。spec decode 下不支持（`:788`） |
| `seed` (`:219`) | None | per-request `torch.Generator`，存到 `InputBatch.generators` |
| `presence_penalty` (`:193`) | 0.0 | 范围 `[-2, 2]`，对"出现过的 token 集合"减 |
| `frequency_penalty` (`:197`) | 0.0 | 范围 `[-2, 2]`，对"出现过的 token 计数"按比例减 |
| `repetition_penalty` (`:201`) | 1.0 | `> 0`；`> 1` 抑制重复，`< 1` 鼓励 |
| `logit_bias` (`:287`) | None | `{token_id: bias}`；OpenAI 风格 clamp 到 ±100，由 `LogitBiasLogitsProcessor` 应用 |
| `allowed_token_ids` (`:290`) | None | 白名单：其余位置直接 `-inf` |
| `bad_words` (`:306`) | None | 多 token 字串黑名单；只在最后一个 token 上掩码 |
| `stop` / `stop_token_ids` (`:221, :224`) | None | 停止条件，在 detokenizer 与 scheduler 中检查（9.12） |
| `max_tokens` (`:231`) | 16 | 输出长度上限，在 scheduler 与 output processor 中检查 |
| `min_tokens` (`:233`) | 0 | 在生成 `< min_tokens` 个 token 前，EOS / stop_token_ids 全部置 `-inf` |
| `ignore_eos` (`:228`) | False | 不把 EOS 列入 `_all_stop_token_ids` |

### 9.2.2 logprobs 字段

| 字段 | 语义 |
| --- | --- |
| `logprobs` (`:236`) | 每个采样 token 返回多少 top logprobs；`-1` 表示返回整个 vocab |
| `prompt_logprobs` (`:244`) | 同上但针对 prompt token |
| `logprob_token_ids` (`:247`) | 自定义要查询的 token id 列表（用于 scoring API，比 `logprobs=-1` 高效） |
| `flat_logprobs` (`:253`) | 用 `FlatLogprobs` 列式结构而非 `list[dict]`，显著降低 GC 压力 |

### 9.2.3 与 sampler 解耦的字段

- `detokenize`、`skip_special_tokens`、`spaces_between_special_tokens`、`include_stop_str_in_output`：detokenizer 阶段消费。
- `structured_outputs`、`thinking_token_budget`、`routed_experts_prompt_start`、`repetition_detection`：交给专用组件（结构化解码后端、ThinkingBudget、Scheduler.check_stop 等）。
- `_eos_token_id`、`_all_stop_token_ids`、`_bad_words_token_ids`、`output_text_buffer_length`：由 `__post_init__` 和 `update_from_tokenizer` 计算，不接受用户输入。

### 9.2.4 设计决策

1. **零温度即贪婪**：`__post_init__` (`:436`) 强制覆盖 `top_p / top_k / min_p`，避免下游分支判断 corner case。代价：用户传 `temperature=0, top_p=0.5` 会被静默改写。
2. **缓存 `sampling_type`**：`@cached_property sampling_type` (`:628`) 返回 `GREEDY / RANDOM_SEED / RANDOM`，scheduler 与 InputBatch 用它决定 batch 重排。
3. **`skip_clone`**：(`:271`) 服务器侧每条请求都会 `clone()` 一份 SamplingParams 避免共享可变状态；批量离线 `LLM.generate` 不需要时可以跳过深拷贝。
4. **数值清理**：`__post_init__` 把 `0 < temperature < _MAX_TEMP` 强行抬到 `_MAX_TEMP` 以防 fp16/bf16 溢出（`:399`）。
5. **`min_p + spec decoding`、`logit_bias + spec decoding`** 在 `_validate_spec_decode` 显式拒绝（`:780`），因为投机解码下 logits 已被 draft / target 同时消费，再叠加 min_p 会破坏接受率推导。

---

## 9.3 SamplingMetadata：把异构请求整批化

`vllm/v1/sample/metadata.py:14` 定义的 `SamplingMetadata` 是 sampler 一次 forward 的全部输入——除了 `logits` 本身。它是一个纯 dataclass，每步都重新组装：

```python
@dataclass
class SamplingMetadata:
    temperature: torch.Tensor | None              # [num_reqs]
    all_greedy: bool
    all_random: bool

    top_p: torch.Tensor | None                    # [num_reqs] or None
    top_k: torch.Tensor | None                    # [num_reqs] or None

    generators: dict[int, torch.Generator]        # 仅有 seed 的请求

    max_num_logprobs: int | None                  # 全 batch 的 max(num_logprobs)

    no_penalties: bool                            # 全为 0 的 fast-path
    prompt_token_ids: torch.Tensor | None         # padded with vocab_size
    frequency_penalties: torch.Tensor             # [num_reqs]
    presence_penalties: torch.Tensor
    repetition_penalties: torch.Tensor

    output_token_ids: list[list[int]]             # 直接共享 InputBatch 引用

    allowed_token_ids_mask: torch.Tensor | None   # [num_reqs, vocab] bool
    bad_words_token_ids: dict[int, list[list[int]]]  # 稀疏
    logitsprocs: LogitsProcessors                 # argmax_invariant + non_argmax_invariant
    logprob_token_ids: dict[int, list[int]] | None
    spec_token_ids: list[list[int]] | None
    thinking_budget_state_holder: ThinkingBudgetStateHolder | None = None
```

组装入口是 `vllm/v1/worker/gpu_input_batch.py:831` 的 `InputBatch._make_sampling_metadata`。关键工程优化：

1. **CPU 镜像 + non-blocking copy**：每个张量字段都有一个 pin-memory 的 CPU 镜像（如 `temperature_cpu_tensor`），`copy_slice` 在每步只把 `[:num_reqs]` 这一段异步上传到 GPU（`:834`），避免 host↔device 同步。
2. **全 batch 的 fast-path 标志位**：`no_penalties` / `no_top_k` / `no_top_p` / `no_allowed_token_ids` / `all_greedy` / `all_random` 让 sampler 跳过不必要的 kernel——例如 `_make_sampling_metadata` 在 `all_greedy=True` 时根本不上传 `temperature`，sampler 也不会调 `apply_temperature`。
3. **`prompt_token_ids` 按需上传**：只有惩罚启用或 step pooler 需要时才 `_make_prompt_token_ids_cpu_tensor()` 再传 GPU（`:860`）。这是大头：prompt 通常远比 output 长。
4. **`output_token_ids` 是 Python list 的引用**：sampler 直接持有 `InputBatch.req_output_token_ids` 的同一引用，每步看到的就是 scheduler 写进去的最新值，无须拷贝。
5. **持久 batch + 增量更新**：`logitsprocs` 的状态（如 `LogitBiasLogitsProcessor.biases`）跨步保留，每步只通过 `BatchUpdateBuilder` 发布 add/remove/move 增量，见 9.5。

---

## 9.4 主 Sampler 流水线

`vllm/v1/sample/sampler.py:21` 的 `Sampler` 是一个 `nn.Module`，但没有可训练参数，只是为了能被 `torch.compile`。它的文档字符串清晰列出了 9 步流水线；下图把"argmax-invariant"和"non-argmax-invariant"的分界也画了出来。

<svg viewBox="0 0 880 760" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Sampler.forward 完整流水线及 non-argmax-invariant / argmax-invariant 切分">
  <defs>
    <marker id="r9ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">Sampler.forward 完整流水线：non-argmax-invariant 段（温度前）vs argmax-invariant 段（温度后）</text>
  <g transform="translate(200, 38)">
    <rect x="0" y="0" width="480" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="240" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">Sampler.forward(logits, sampling_metadata)</text>
    <text x="240" y="33" text-anchor="middle" font-size="10" fill="#9a3412">logits.shape == [num_reqs, vocab]</text>
  </g>
  <path d="M 440 78 L 440 94" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(100, 98)">
    <rect x="0" y="0" width="680" height="50" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
    <text x="14" y="20" font-size="11" font-weight="700" fill="currentColor">① 若需要 logprobs：备份 raw_logprobs</text>
    <text x="14" y="38" font-size="10" fill="#64748b">logprobs_mode=raw_logprobs → log_softmax  ·  raw_logits → clone</text>
  </g>
  <path d="M 440 148 L 440 164" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(280, 168)">
    <rect x="0" y="0" width="320" height="28" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
    <text x="160" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">② logits = logits.to(float32)</text>
  </g>
  <path d="M 440 196 L 440 212" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(60, 216)">
    <rect x="0" y="0" width="760" height="190" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
    <text x="380" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#991b1b">apply_logits_processors（non-argmax-invariant）— 可改变 argmax 结果，必须在温度前</text>
    <g transform="translate(14, 34)">
      <circle cx="10" cy="10" r="10" fill="#dc2626"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">3</text>
      <text x="28" y="14" font-size="11" fill="currentColor">allowed_token_ids_mask.masked_fill_(-inf)</text>
    </g>
    <g transform="translate(14, 62)">
      <circle cx="10" cy="10" r="10" fill="#dc2626"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">4</text>
      <text x="28" y="14" font-size="11" fill="currentColor">bad_words mask  ·  sampler.py:389 → ops/bad_words.py</text>
    </g>
    <g transform="translate(14, 90)">
      <circle cx="10" cy="10" r="10" fill="#dc2626"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">5</text>
      <text x="28" y="14" font-size="11" fill="currentColor">for proc in logitsprocs.non_argmax_invariant:  proc.apply(logits)</text>
      <text x="40" y="28" font-size="9" fill="#7f1d1d">MinTokens, LogitBias, 用户插件</text>
    </g>
    <g transform="translate(14, 126)">
      <circle cx="10" cy="10" r="10" fill="#dc2626"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">6</text>
      <text x="28" y="14" font-size="11" fill="currentColor">apply_all_penalties</text>
      <text x="40" y="28" font-size="9" fill="#7f1d1d">repetition / frequency / presence  ·  no_penalties=True 时整段跳过</text>
    </g>
    <g transform="translate(14, 162)">
      <circle cx="10" cy="10" r="10" fill="#fca5a5"/>
      <text x="10" y="14" text-anchor="middle" font-size="9" font-weight="700" fill="#7f1d1d">6.5</text>
      <text x="28" y="14" font-size="11" fill="currentColor">thinking_budget_holder.apply_to_logits(...)</text>
    </g>
  </g>
  <path d="M 440 406 L 440 422" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(320, 426)">
    <rect x="0" y="0" width="240" height="28" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="120" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">sample(logits, sm)</text>
  </g>
  <path d="M 440 454 L 440 470" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(60, 474)">
    <rect x="0" y="0" width="760" height="170" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
    <text x="380" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#166534">sample() — argmax-invariant 段：温度 → min-p → top-k/top-p → 类别采样</text>
    <g transform="translate(14, 34)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#15803d">if all_greedy:</text>
      <text x="14" y="28" font-size="10" fill="#166534">return argmax(logits), processed_logprobs?</text>
    </g>
    <g transform="translate(14, 70)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#15803d">greedy_sampled = argmax(logits)  </text>
      <text x="240" y="14" font-size="10" fill="#64748b">备用（与 random 同跑，最后用 where 选回）</text>
    </g>
    <g transform="translate(14, 90)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#15803d">logits = logits / temperature  </text>
      <text x="220" y="14" font-size="10" fill="#64748b">sampler.py:229, in-place div_</text>
    </g>
    <g transform="translate(14, 112)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#15803d">for proc in logitsprocs.argmax_invariant:  proc.apply(logits)  </text>
      <text x="400" y="14" font-size="10" fill="#64748b">MinP（在 top-k/p 之前）</text>
    </g>
    <g transform="translate(14, 134)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#15803d">random_sampled, processed_lp = TopKTopPSampler(logits, ...)</text>
    </g>
    <g transform="translate(14, 154)">
      <text x="0" y="12" font-size="11" font-weight="600" fill="#15803d">if mixed greedy/random:  sampled = where(temp &lt; eps, greedy, random)</text>
    </g>
  </g>
  <path d="M 440 644 L 440 660" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(160, 664)">
    <rect x="0" y="0" width="560" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
    <text x="280" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">gather_logprobs(raw_logprobs, num_logprobs, sampled)</text>
  </g>
  <path d="M 440 696 L 440 712" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <g transform="translate(280, 716)">
    <rect x="0" y="0" width="320" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="160" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">SamplerOutput</text>
    <text x="160" y="30" text-anchor="middle" font-size="10" fill="#9a3412">sampled_token_ids [N, 1] + logprobs_tensors</text>
  </g>
</svg>
<span class="figure-caption">图 R9.2 ｜ Sampler.forward 九步流水线；红色段（non-argmax-invariant）必须在温度前执行以保证 greedy 路径也被约束，绿色段（argmax-invariant）在温度后执行——这是 vLLM 把"全 greedy batch 整段跳过 min-p / top-k/p"的关键</span>

<details>
<summary>ASCII 原版</summary>

```
                  ┌────────────────────────────────────────────────────┐
                  │  Sampler.forward(logits, sampling_metadata)        │
                  │  logits.shape == [num_reqs, vocab]                 │
                  └──────────────────────┬─────────────────────────────┘
                                         │
        ┌────────────────────────────────┴────────────────────────────────┐
        │ 1. 若需要 logprobs：先把 raw logits 备份成 raw_logprobs         │
        │    (logprobs_mode=raw_logprobs → log_softmax；                  │
        │     logprobs_mode=raw_logits   → clone)                         │
        └────────────────────────────────┬────────────────────────────────┘
                                         ▼
                              logits = logits.to(float32)
                                         │
        ╔════════════════════════════════╧════════════════════════════════╗
        ║  apply_logits_processors  (non-argmax-invariant)                ║
        ╠══════════════════════════════════════════════════════════════════╣
        ║  3. allowed_token_ids_mask.masked_fill_(-inf)                    ║
        ║  4. bad_words mask (sampler.py:389 → ops/bad_words.py)           ║
        ║  5. for proc in logitsprocs.non_argmax_invariant:               ║
        ║          logits = proc.apply(logits)                            ║
        ║         (MinTokens, LogitBias, 用户插件)                         ║
        ║  6. apply_all_penalties                                          ║
        ║         repetition / frequency / presence                       ║
        ║  6.5 thinking_budget_holder.apply_to_logits(...)                ║
        ╚══════════════════════════════════════════════════════════════════╝
                                         │
                                         ▼
                                   sample(logits, sm)
        ╔══════════════════════════════════════════════════════════════════╗
        ║  if all_greedy:                                                  ║
        ║      return argmax(logits), processed_logprobs?                 ║
        ║                                                                  ║
        ║  greedy_sampled = argmax(logits)  # 备用                        ║
        ║  logits = logits / temperature      (sampler.py:229, in-place)  ║
        ║                                                                  ║
        ║  for proc in logitsprocs.argmax_invariant:                       ║
        ║      logits = proc.apply(logits)   # MinP 等                    ║
        ║                                                                  ║
        ║  random_sampled, processed_lp = TopKTopPSampler(logits, ...)    ║
        ║                                                                  ║
        ║  if mixed greedy/random:                                         ║
        ║      sampled = where(temp < eps, greedy, random)                ║
        ╚══════════════════════════════════════════════════════════════════╝
                                         │
                                         ▼
                       gather_logprobs(raw_logprobs, num_logprobs, sampled)
                                         │
                                         ▼
                                   SamplerOutput(
                                     sampled_token_ids=[N, 1],
                                     logprobs_tensors=...)
```

</details>

下面把每一步的"为什么"展开。

### 9.4.1 logits 取出

模型 forward 返回的 `hidden_states` 是 `[total_tokens, hidden]`。每条请求只在某些位置上需要采样：

- **Decode 步**：每条请求只 sample 末尾一个 token。
- **Prefill 末段**：只在 prompt 的最后一个 token 处 sample（除非要求 `prompt_logprobs`，那是 9.9 的另一条路径）。

`logits_indices` 是 ModelRunner 在 `_prepare_inputs` 中预算好的整数索引张量（`vllm/v1/worker/gpu_model_runner.py:2102` `logits_indices = query_start_loc[1:] - 1`），喂给 LMHead 时直接对 hidden_states 做 gather。Sampler 拿到的 `logits` 因此已经按 `req_id_to_index` 顺序排好，每条请求一行。

对投机解码，`logits_indices` 还包含每条请求的 K 个 draft 位置 + 1 个 bonus 位置（共 K+1 行，见 `vllm/v1/spec_decode/metadata.py:24`），这部分由 RejectionSampler 拆开处理（9.7）。

### 9.4.2 备份 raw logits 用于 logprobs

```python
# sampler.py:80
num_logprobs = sampling_metadata.max_num_logprobs
if num_logprobs is not None:
    if logprobs_mode == "raw_logprobs":
        raw_logprobs = self.compute_logprobs(logits)   # log_softmax (float32)
    elif logprobs_mode == "raw_logits":
        raw_logprobs = logits.to(torch.float32) if ... else logits.clone()
```

`LogprobsMode` 共有 `raw_logprobs / raw_logits / processed_logprobs / processed_logits` 四档（`vllm/config/model.py`）。

设计决策（`sampler.py:76-79` 注释）：**返回给用户的 top-k logprobs 默认基于"未加任何 processor / temperature"的原始 logits**，与 V0 不同。V0 用经过 top-k/top-p 截断后的 logits，导致返回的 logprobs 不可解释（被截断的 token 永远是 `-inf`）。V1 把"采样用 logits"和"汇报用 logprobs"显式分离；想要旧行为就显式传 `logprobs_mode="processed_logprobs"`。

### 9.4.3 allowed_token_ids 与 bad_words

```python
# sampler.py:385
if sampling_metadata.allowed_token_ids_mask is not None:
    logits.masked_fill_(sampling_metadata.allowed_token_ids_mask, float("-inf"))
if bad_words_token_ids:
    apply_bad_words(logits, bad_words_token_ids, output_token_ids)
```

- `allowed_token_ids_mask` 是 `[max_num_reqs, vocab]` 的 bool 张量；约定 **True = 屏蔽**（见 `gpu_input_batch.py:267` 注释）。每条请求的整行通常稀疏，但维护成稠密 mask 是为了让 `masked_fill_` 走单一 kernel。
- `apply_bad_words`（`vllm/v1/sample/ops/bad_words.py`）按请求逐行 Python 循环执行；这是 vLLM 中少数没做 batch 化的 path，因为 bad_words 通常是几个短 sequence，且要按"最后 k-1 个 token 与 bad word 前缀匹配"做有状态匹配，向量化收益有限。

### 9.4.4 Logits Processors 的两类切分

```python
# sampler.py:393
for processor in sampling_metadata.logitsprocs.non_argmax_invariant:
    logits = processor.apply(logits)
# ...
# 在 sample() 中，温度之后才执行：
for processor in sampling_metadata.logitsprocs.argmax_invariant:
    logits = processor.apply(logits)
```

切分的依据来自 `LogitsProcessor.is_argmax_invariant()` (`logits_processor/interface.py:85`)：

- **非 argmax-invariant**（可能改变 greedy 结果）：`MinTokensLogitsProcessor`（屏蔽 EOS）、`LogitBiasLogitsProcessor`（重赋分）。在 **温度/截断之前** 执行，保证 greedy 路径也受其约束。
- **Argmax-invariant**（只在概率分布上做截断/重缩，不改 argmax）：`MinPLogitsProcessor`。放在 **温度之后、top-k/p 之前**，因为 min-p 的阈值是相对最大概率定义的。

这种分类是性能 + 正确性的折衷：argmax-invariant 的 processor 在全 greedy batch 上整段被跳过（`sample()` 早早 return）。

### 9.4.5 惩罚

```python
# vllm/v1/sample/ops/penalties.py:11
def apply_all_penalties(logits, prompt_token_ids, presence_penalties,
                        frequency_penalties, repetition_penalties,
                        output_token_ids):
    output_tokens_t = _convert_to_tensors(output_token_ids, vocab_size, ...)
    # async scheduling 可能留下 -1 占位，用 vocab_size 替换以便 scatter
    output_tokens_t.masked_fill_(output_tokens_t == -1, vocab_size)
    return apply_penalties(logits, prompt_token_ids, output_tokens_t,
                           presence_penalties, frequency_penalties,
                           repetition_penalties)
```

底层 `apply_penalties` 在 `vllm/model_executor/layers/utils.py:51`：

```python
def apply_penalties(logits, prompt_tokens_tensor, output_tokens_tensor,
                    presence_penalties, frequency_penalties, repetition_penalties):
    num_seqs, vocab_size = logits.shape
    _, prompt_mask = get_token_bin_counts_and_mask(prompt_tokens_tensor, vocab_size, num_seqs)
    output_bin_counts, output_mask = get_token_bin_counts_and_mask(
        output_tokens_tensor, vocab_size, num_seqs)
    apply_repetition_penalties(logits, prompt_mask, output_mask, repetition_penalties)
    logits -= frequency_penalties.unsqueeze(1) * output_bin_counts   # 按出现次数
    logits -= presence_penalties.unsqueeze(1) * output_mask          # 按是否出现
    return logits
```

`get_token_bin_counts_and_mask` 用 `scatter_add_` 把 `[num_seqs, max_len]` 的 token id 张量统计成 `[num_seqs, vocab]` 的 one-hot 计数；这是 vLLM 把 per-request padding 转成稠密 vocab 维向量的标准手法。`vocab_size` 这一列用作 padding bin，最后切片丢弃。

注意：

- prompt 与 output 的 mask 用同一个函数算，但 prompt 只用 mask（出现/未出现），output 同时用 mask 和 count；这对应 OpenAI 文档里 frequency_penalty 按计数线性扣分、presence_penalty 只看是否出现的语义。
- `apply_repetition_penalties` 是 `_custom_ops` 中的 CUDA 算子（fused），把 `>0` 的 logits 除以 penalty、把 `<0` 的乘以 penalty，按 HF 经典实现。

整段在 `no_penalties=True` 时被跳过；这是常见情况（OpenAI 默认全 0），代价仅为一次 boolean 检查。

### 9.4.6 温度

```python
# sampler.py:219
@staticmethod
def apply_temperature(logits, temp, all_random):
    if not all_random:
        # 避免 greedy 行除以 0；后续 where() 会把 greedy 行的结果替换回去
        temp = torch.where(temp < _SAMPLING_EPS, 1.0, temp)
    return logits.div_(temp.unsqueeze(dim=1))
```

注意 in-place `div_`：温度后 logits 就被破坏掉了，只有 9.4.2 备份过的 `raw_logprobs` 还保留原值。

### 9.4.7 top-k / top-p

入口在 `vllm/v1/sample/ops/topk_topp_sampler.py:22` 的 `TopKTopPSampler`。它在 `__init__` 中按平台/编译期能力 dispatch `forward` 方法：

| 后端 | 触发条件 | 关键实现 |
| --- | --- | --- |
| `forward_cuda` | CUDA + FlashInfer 可用 + 不要 processed_logprobs | 调 `flashinfer.sampling.top_k_top_p_sampling_from_logits` |
| `forward_hip` | ROCm + aiter 可用 | `aiter.ops.sampling.top_k_top_p_sampling_from_probs` |
| `forward_xpu` | XPU | 自定义 `torch.ops.vllm.xpu_topk_topp_sampler` |
| `forward_cpu` | CPU（非 PowerPC/RISCV） | PyTorch native + `compiled_random_sample` |
| `forward_native` | 默认 / fallback | `apply_top_k_top_p_pytorch` + `random_sample` |

PyTorch native 的实现在 `apply_top_k_top_p_pytorch` (`topk_topp_sampler.py:323`)：

```python
def apply_top_k_top_p_pytorch(logits, k, p, allow_cpu_sync=False):
    if p is None:
        if k is None:
            return logits
        if allow_cpu_sync:
            return apply_top_k_only(logits, k)     # 不排序，省 vocab*log(vocab)

    logits_sort, logits_idx = logits.sort(dim=-1, descending=False)
    if k is not None:
        top_k_mask = logits_sort.size(1) - k.to(torch.long)
        top_k_mask = logits_sort.gather(1, top_k_mask.unsqueeze(1))
        logits_sort.masked_fill_(logits_sort < top_k_mask, -float("inf"))
    if p is not None:
        probs_sort = logits_sort.softmax(dim=-1)
        probs_sum = torch.cumsum(probs_sort, dim=-1, out=probs_sort)
        top_p_mask = probs_sum <= 1 - p.unsqueeze(1)
        top_p_mask[:, -1] = False                  # 至少保留一个
        logits_sort.masked_fill_(top_p_mask, -float("inf"))
    return logits.scatter_(-1, logits_idx, logits_sort)
```

为什么这样设计：

1. **同一次 sort 服务 k 与 p**：top-p 必须排序才能做 cumsum，top-k 只要 partial sort 即可；二者并行处理时一次 full sort 反而比两次 partial sort 快（且省内存）。
2. **per-request 的 k 是张量而非标量**：通过 `gather` 选出每行第 k 大的阈值，实现真正的 batched per-row top-k。代价是必须排序整列 vocab；对 vocab 很小或 batch 很大时可以走 `apply_top_k_only`（用 `torch.topk` + 行内 `gather`，省了排序，但要 CPU 同步算 `max_top_k`）。
3. **Triton 路径**：`apply_top_k_top_p` (`topk_topp_sampler.py:310`) 在 `batch >= 8` 且 Triton 可用时直接走 `apply_top_k_top_p_triton`，这是 vLLM 自己写的 fused kernel（`ops/topk_topp_triton.py`，1000+ 行），把 sort+mask+softmax 全部塞进一个 kernel。
4. **FlashInfer 用 rejection sampling 跳过排序**：见 `flashinfer_sample` 注释（`topk_topp_sampler.py:419`），统计上等价、但不保证逐位 bitwise 相同。

### 9.4.8 类别采样：Gumbel-max 而非 multinomial

```python
# topk_topp_sampler.py:390
def random_sample(probs, generators):
    q = torch.empty_like(probs)
    if len(generators) != probs.shape[0]:
        q.exponential_()                                 # batch 默认 generator
    if generators:
        for i, generator in generators.items():          # 有 seed 的行覆盖
            q[i].exponential_(generator=generator)
    return probs.div_(q).argmax(dim=-1).view(-1)
```

刻意不用 `torch.multinomial`，因为它在 CUDA 上会触发隐式 CPU 同步。`probs / Exp(1)` 然后取 argmax 等价于 Gumbel-max trick，全 GPU、无 sync。

per-request seed 用 `dict[int, torch.Generator]` 而非张量，因为 CUDA generator 是 host-side 对象；少量有 seed 的请求按行覆盖采样，常见情况（无 seed）走单一 batch generator，避免 N 次 kernel launch。

### 9.4.9 Greedy 与 Random 共存

```python
# sampler.py:235
if sampling_metadata.all_random:
    greedy_sampled = None
else:
    greedy_sampled = self.greedy_sample(logits)          # 全部行都先 argmax
    if sampling_metadata.all_greedy:
        return greedy_sampled, ...

# ...走完 random 路径，得到 random_sampled
sampled = torch.where(
    sampling_metadata.temperature < _SAMPLING_EPS,
    greedy_sampled,
    random_sampled,
    out=greedy_sampled,                                 # 复用张量
)
```

即使 batch 里只有一行 greedy、其余 random，也会跑完整的 random 路径再用 `where` 选回去。这是因为：

- 把 greedy / random 拆成两个 sub-batch 需要 gather/scatter，开销与 vocab 成正比；
- `where` 只要 `[num_reqs]` 比较，几乎免费。

---

## 9.5 Logits Processor 框架

### 9.5.1 抽象基类

`vllm/v1/sample/logits_processor/interface.py:60`：

```python
class LogitsProcessor(ABC):
    @abstractmethod
    def __init__(self, vllm_config: "VllmConfig", device, is_pin_memory): ...

    @abstractmethod
    def apply(self, logits: torch.Tensor) -> torch.Tensor:
        """对整批 [num_reqs, vocab] 操作，可 in-place。"""

    @abstractmethod
    def is_argmax_invariant(self) -> bool: ...

    @abstractmethod
    def update_state(self, batch_update: "BatchUpdate | None") -> None:
        """每步 forward 前调用一次，告知 batch 增删改。"""
```

设计上 logits processor 是 **持久状态对象**（生命周期 = vLLM 进程），不是 per-request 对象：

- 一份 `MinPLogitsProcessor` 实例维护 `[max_num_reqs]` 的 GPU/CPU 镜像张量。
- 每步通过 `BatchUpdate`（`interface.py:36`）告诉它哪些 batch slot 加入、移除、移动了请求。
- 自己负责增量更新内部张量；不要每步重建。

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="InputBatch 变更通过 BatchUpdate 推送给 LogitsProcessors 的数据流">
  <defs>
    <marker id="r9ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">InputBatch 变更 → BatchUpdateBuilder → 每步推给所有 LogitsProcessor</text>
  <g transform="translate(40, 46)">
    <rect x="0" y="0" width="280" height="120" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="140" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">InputBatch 端事件</text>
    <g transform="translate(14, 32)">
      <rect x="0" y="0" width="252" height="22" rx="3" fill="#ffffff" stroke="#fed7aa"/>
      <text x="8" y="15" font-size="10" fill="currentColor">add_request(...)</text>
      <text x="244" y="15" text-anchor="end" font-size="9" fill="#9a3412">→ added</text>
    </g>
    <g transform="translate(14, 58)">
      <rect x="0" y="0" width="252" height="22" rx="3" fill="#ffffff" stroke="#fed7aa"/>
      <text x="8" y="15" font-size="10" fill="currentColor">remove_request(idx)</text>
      <text x="244" y="15" text-anchor="end" font-size="9" fill="#9a3412">→ removed</text>
    </g>
    <g transform="translate(14, 84)">
      <rect x="0" y="0" width="252" height="22" rx="3" fill="#ffffff" stroke="#fed7aa"/>
      <text x="8" y="15" font-size="10" fill="currentColor">_swap_states(i, j)</text>
      <text x="244" y="15" text-anchor="end" font-size="9" fill="#9a3412">→ moved</text>
    </g>
  </g>
  <path d="M 320 106 L 360 106" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <g transform="translate(360, 46)">
    <rect x="0" y="0" width="240" height="120" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="120" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">BatchUpdateBuilder</text>
    <text x="120" y="38" text-anchor="middle" font-size="9" fill="#6d28d9">state.py:18</text>
    <g transform="translate(14, 48)">
      <rect x="0" y="0" width="212" height="22" rx="3" fill="#ffffff" stroke="#c4b5fd"/>
      <text x="8" y="15" font-size="10" fill="#5b21b6">.added: list</text>
    </g>
    <g transform="translate(14, 74)">
      <rect x="0" y="0" width="212" height="22" rx="3" fill="#ffffff" stroke="#c4b5fd"/>
      <text x="8" y="15" font-size="10" fill="#5b21b6">.removed: list (降序)</text>
    </g>
    <g transform="translate(14, 100)">
      <rect x="0" y="0" width="212" height="14" rx="3" fill="#ffffff" stroke="#c4b5fd"/>
      <text x="8" y="11" font-size="9" fill="#5b21b6">.moved: list[(i, j, dir)]</text>
    </g>
  </g>
  <path d="M 480 166 L 480 188" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <g transform="translate(220, 192)">
    <rect x="0" y="0" width="520" height="44" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
    <text x="260" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">每步 forward 前：batch_update = builder.get_and_reset(batch_size)</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#0f766e">无变更 → None（sampler 完全跳过 update）</text>
  </g>
  <path d="M 480 236 L 480 254" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <g transform="translate(220, 258)">
    <rect x="0" y="0" width="520" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="260" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">for proc in logitsprocs.all:  proc.update_state(batch_update)</text>
    <text x="260" y="36" text-anchor="middle" font-size="10" fill="#b91c1c">每个 processor 自行增量更新内部 GPU/CPU 镜像张量</text>
  </g>
  <path d="M 480 302 L 480 320" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <g transform="translate(160, 324)">
    <rect x="0" y="0" width="640" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="320" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">Sampler.forward(logits, sampling_metadata)</text>
    <text x="320" y="36" text-anchor="middle" font-size="10" fill="#7c2d12">non_argmax_invariant.apply → 温度 → argmax_invariant.apply → top-k/p → sample</text>
  </g>
</svg>
<span class="figure-caption">图 R9.3 ｜ Logits processor 是持久状态对象：InputBatch 的 add/remove/swap 通过 BatchUpdateBuilder 累积为单个 BatchUpdate，每步 forward 前推给所有 processor 做增量更新，然后 Sampler.forward 才真正消费这些状态</span>

<details>
<summary>ASCII 原版</summary>

```
                                       ┌───────────────────────┐
   InputBatch.add_request   ───────────│ BatchUpdateBuilder    │
   InputBatch.remove_request────────── │  .added / .removed /  │──┐
   InputBatch._swap_states ─────────── │  .moved               │  │
                                       └───────────────────────┘  │
                                                                  ▼
                            每步 forward 前：build_batch_update()
                                                                  │
                                                                  ▼
                            for proc in logitsprocs.all:
                                proc.update_state(batch_update)
                                                                  │
                                                                  ▼
                            Sampler.forward(logits, sampling_metadata)
                                for proc in non_argmax_invariant: proc.apply(logits)
                                ...
                                for proc in argmax_invariant:     proc.apply(logits)
```

</details>

### 9.5.2 BatchUpdate 数据结构

```python
@dataclass(frozen=True)
class BatchUpdate:
    batch_size: int
    removed: Sequence[int]                                # 退出 batch 的 slot
    added: Sequence[tuple[int, SamplingParams,            # 新进入的请求
                          list[int] | None, list[int]]]
    moved: Sequence[tuple[int, int, MoveDirectionality]]  # slot 重排
```

约定的处理顺序：**removed → added → moved**（`interface.py:53` 注释）。added 中携带 `output_tok_ids` 的 **引用**（不是拷贝），processor 后续 step 看到的就是请求最新的生成序列——这是 `MinTokensLogitsProcessor` 能在 `update_state` 内判断"该请求是否已经达到 min_tokens"的关键。

`BatchUpdateBuilder` 在 `state.py:18`，关键约束：

- `removed` 按降序保证 InputBatch 重排时 pop 的稳定性。
- `pop_removed()` 后不允许再 `removed_append`，否则破坏排序不变量。
- `get_and_reset(batch_size)` 把累积的变更冻结成 `BatchUpdate`、清空内部 list，并返回（无变更则返回 None，sampler 完全跳过 update）。

### 9.5.3 内置 processor

三个内置 processor 在 `builtin.py`，按 `BUILTIN_LOGITS_PROCESSORS = [MinTokens, LogitBias, MinP]`（`__init__.py:49`）的顺序加载。

**MinTokensLogitsProcessor** (`builtin.py:167`)：
- 状态：`dict[req_idx, (min_toks, output_token_ids_ref, stop_token_ids)]`。
- `update_state`：新增 → 加入 dict；每步检查 `len(output_tok_ids) >= min_toks` 自动移除。
- `apply`：把所有"未达 min_tokens"请求的 stop token 位置 `index_put_` 成 `-inf`。
- `apply_with_spec_decode` (`:240`)：投机解码下 logits 形状是 `[sum(num_draft_tokens), V]`，需要按累积 draft 数量计算每条请求占用的行段。

**LogitBiasLogitsProcessor** (`builtin.py:118`)：
- 状态：`dict[req_idx, dict[token_id, bias]]`。
- 每步把所有 (req, tok, bias) 三元组打包成 `(req_idx_tensor, tok_id_tensor)` 索引和 `bias_tensor` 值，单次 `logits[idx] += bias_tensor` 完成所有偏置。
- `is_argmax_invariant=False`：偏置可以翻转 argmax，所以放在温度之前。

**MinPLogitsProcessor** (`builtin.py:22`)：
- 状态：`min_p_cpu_tensor[max_num_reqs]`，每步更新 dirty 行后整体 non-blocking 上传 GPU。
- `apply`：softmax → 每行 max → 乘 min_p → 小于阈值的 token 置 `-inf`。
- `is_argmax_invariant=True`：min-p 永远不会改 argmax（最大值的概率永远是最大值，min_p × max ≤ max），所以放在温度之后。

### 9.5.4 自定义 processor 接口

两种途径：

1. **注册 entry point**：`vllm.logits_processors` group，进程启动时 `_load_logitsprocs_plugins()` 扫描安装的 plugin。
2. **FQCN 字符串**：构造 `VllmConfig` 时传 `logits_processors=["x.y.z:MyProcessor"]`，由 `_load_logitsprocs_by_fqcns` (`__init__.py:86`) 解析。

二者都被 `build_logitsprocs` (`__init__.py:184`) 统一构造。注意：

- Pooling 模型禁止 custom processor（`STR_POOLING_REJECTS_LOGITSPROCS`）。
- Speculative decoding 也禁止 custom processor（`STR_SPEC_DEC_REJECTS_LOGITSPROCS`）；只保留 MinTokens，其余 min_p / logit_bias 直接 warn。原因：rejection sampling 的 token 接受率推导只在"target 模型的真实分布上"才成立。

### 9.5.5 AdapterLogitsProcessor：把 per-request callable 包成 batched

老式的 HF 风格 `LogitsProcessor` 是 per-request 的 `(past_tokens, logits) -> logits` callable（vllm 类型别名见 `vllm/logits_process.py:10`）。V1 提供 `AdapterLogitsProcessor` (`__init__.py:234`) 让用户继承后只实现 `new_req_logits_processor(params)` 返回 per-request callable；adapter 负责：

- 维护 `dict[req_idx, partial(req_lp, output_ids)]`；
- `apply` 时按行 Python loop 调用每个 callable 并写回。

这条 path 性能较差（Python loop），仅作为兼容层；写新 processor 应直接继承 `LogitsProcessor` 做向量化。

---

## 9.6 结构化输出（guided decoding）与 sampler 的接口

结构化输出（JSON schema、正则、CFG 等）的核心实现在第 11 章；这里只讲它和 sampler 的耦合点。

<svg viewBox="0 0 880 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="结构化输出的 grammar bitmask 在 sampler 入口前 in-place 写到 logits 的流程">
  <defs>
    <marker id="r9ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">grammar bitmask 在 sampler 入口前 in-place 写 -inf，sampler 完全不感知 grammar</text>
  <g transform="translate(80, 40)">
    <rect x="0" y="0" width="720" height="98" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="360" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">Scheduler.schedule  ·  EngineCore 进程</text>
    <g transform="translate(20, 30)">
      <text x="0" y="14" font-size="11" fill="currentColor">对每条 structured request：</text>
      <text x="20" y="32" font-size="11" fill="#5b21b6">① advance grammar state with last accepted token</text>
      <text x="20" y="50" font-size="11" fill="#5b21b6">② fill grammar_bitmask[req_row, :] — 允许的 token 位置为 1</text>
      <text x="20" y="68" font-size="10" fill="#6d28d9">bitmask 是 np.ndarray (packed int32)，IPC 比 torch.Tensor 高效</text>
    </g>
  </g>
  <path d="M 440 138 L 440 158" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar4)"/>
  <g transform="translate(220, 162)">
    <rect x="0" y="0" width="440" height="34" rx="6" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
    <text x="220" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="#5b21b6">SchedulerOutput.grammar_output : GrammarOutput</text>
  </g>
  <path d="M 440 196 L 440 216" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar4)"/>
  <g transform="translate(60, 220)">
    <rect x="0" y="0" width="760" height="160" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
    <text x="380" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">ModelRunner.execute_model  ·  ModelRunner 进程</text>
    <g transform="translate(20, 30)">
      <rect x="0" y="0" width="320" height="36" rx="6" fill="#ffffff" stroke="#fed7aa"/>
      <text x="160" y="22" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">模型 forward → logits [T, V]</text>
    </g>
    <path d="M 340 48 L 380 48" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar4)"/>
    <g transform="translate(380, 30)">
      <rect x="0" y="0" width="340" height="36" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
      <text x="170" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">apply_grammar_bitmask(...)</text>
      <text x="170" y="28" text-anchor="middle" font-size="10" fill="#b91c1c">非允许 token 原地写 -inf  ·  gpu_model_runner.py:4301</text>
    </g>
    <path d="M 380 96 L 380 116" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar4)"/>
    <g transform="translate(180, 96)">
      <rect x="0" y="0" width="400" height="44" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
      <text x="200" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">Sampler.forward(logits, sampling_metadata)</text>
      <text x="200" y="36" text-anchor="middle" font-size="10" fill="#0f766e">不感知 grammar — -inf 已钉死非法 token</text>
    </g>
  </g>
  <g transform="translate(40, 400)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">关键设计：</tspan><tspan x="0" dy="16">bitmask 不走 LogitsProcessor 接口——它在 sampler 之前 in-place 写 logits，让后续 penalty / logit_bias 永远改不回非法 token；</tspan>
      <tspan x="0" dy="14">投机解码下每条 structured 请求占 (1 + num_spec_tokens) 行，bitmask 必须按 draft 一步步演化。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R9.4 ｜ 结构化输出的 grammar bitmask 跨进程流：Scheduler 推进语法状态并构造 packed bitmask；ModelRunner 进程在 sampler 入口前调 apply_grammar_bitmask 原地写 -inf，sampler 之后完全不感知 grammar 存在</span>

<details>
<summary>ASCII 原版</summary>

```
              Scheduler.schedule  (per step)
                       │
                       │ 对每条 structured request：
                       │   advance grammar state with last accepted token
                       │   fill grammar_bitmask[req_row, :] 中允许 token 为 1
                       │
                       ▼
        SchedulerOutput.grammar_output : GrammarOutput
                       │
                       ▼
              ModelRunner.execute_model
                       │
                       │ 模型 forward → logits
                       │
                       ▼
        apply_grammar_bitmask(scheduler_output, grammar_output,
                              input_batch, logits)        # 原地写 -inf
                       │
                       ▼
              Sampler.forward(logits, sampling_metadata)  # 不感知 grammar
```

</details>

调用点在 `vllm/v1/worker/gpu_model_runner.py:4301`，实现在 `vllm/v1/structured_output/utils.py:44`：

```python
def apply_grammar_bitmask(scheduler_output, grammar_output, input_batch, logits):
    grammar_bitmask = grammar_output.grammar_bitmask    # np.ndarray, packed bits
    # 1) 按 input_batch 顺序重排 bitmask（scheduler 顺序未必匹配）
    sorted_bitmask = np.full((logits.shape[0], grammar_bitmask.shape[1]),
                             -1, dtype=grammar_bitmask.dtype)
    # ...对每个 structured req 计算其在 logits 中的行（含 spec tokens）
    grammar_bitmask = torch.from_numpy(sorted_bitmask).to(logits.device,
                                                          non_blocking=True)
    # 2) 调 xgrammar 的 CUDA kernel：对应位为 0 的 token 置 -inf
    xgr.apply_token_bitmask_inplace(logits, grammar_bitmask, indices=index_tensor)
```

设计要点：

1. **bitmask 在 scheduler 进程算好，序列化为 np.ndarray 传过来**（packed int32，每位对应一个 token）。np.ndarray 的 IPC 比 torch.Tensor 高效得多。
2. **不走 LogitsProcessor 接口**。结构化输出和 logitsprocs 共存于同一 batch 时顺序敏感：grammar mask 必须在 penalties / logit_bias 之后才能保证"被 grammar 允许的 token 一定是有效候选"，但要在 top-k/top-p 截断之前。当前实现选择在 sampler 入口前就执行（即"penalties 之前"），靠 xgrammar 把不合法 token 钉死 `-inf`，后续任何加减都改不回来。
3. **投机解码兼容**：bitmask 的行数对每条结构化请求是 `1 + num_spec_tokens`，与 `target_logits_indices + bonus_logits_indices` 拼出来的总行数一一对应（`utils.py:90-97`）。这意味着 grammar 推进必须按 draft 一步步演化（speculative grammar），这是结构化解码 + 投机解码的难点之一，详见第 11 章。

---

## 9.7 投机解码中的采样：RejectionSampler

`vllm/v1/sample/rejection_sampler.py:37` 实现了经典的 speculative decoding 接受/恢复算法（arXiv:2211.17192）。术语：

- **accepted token**：draft 提议、在 target 分布下被接受的 token。
- **recovered token**：被拒绝位置上，从 `max(0, p_target - p_draft)` 归一化后采样的 token。
- **bonus token**：若全部 K 个 draft 都被接受，再额外从 target 的下一步分布上 sample 一个；只在这种情况下额外赠送。

### 9.7.1 输入张量布局

<svg viewBox="0 0 880 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="SpecDecodeMetadata 中 logits 行的 target_logits_indices 与 bonus_logits_indices 切分示例">
  <defs>
    <marker id="r9ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">logits[K_total + B, V] 的两类索引：target_logits_indices（draft 位置）+ bonus_logits_indices（bonus 位置）</text>
  <g transform="translate(60, 44)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="currentColor">例：B=3 条请求，num_draft_tokens=[2, 1, 2]  ·  logits 共 5+3 = 8 行</text>
    <g transform="translate(0, 16)">
      <rect x="0" y="0" width="760" height="42" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
      <text x="-46" y="16" font-size="10" fill="#64748b">row idx</text>
      <text x="-46" y="34" font-size="10" fill="#64748b">用途</text>
      <g font-size="10" text-anchor="middle">
        <line x1="95" y1="0" x2="95" y2="42" stroke="#cbd5e1"/>
        <line x1="190" y1="0" x2="190" y2="42" stroke="#cbd5e1"/>
        <line x1="285" y1="0" x2="285" y2="42" stroke="#cbd5e1"/>
        <line x1="380" y1="0" x2="380" y2="42" stroke="#cbd5e1"/>
        <line x1="475" y1="0" x2="475" y2="42" stroke="#cbd5e1"/>
        <line x1="570" y1="0" x2="570" y2="42" stroke="#cbd5e1"/>
        <line x1="665" y1="0" x2="665" y2="42" stroke="#cbd5e1"/>
        <text x="47" y="16" fill="currentColor">0</text>
        <text x="142" y="16" fill="currentColor">1</text>
        <text x="237" y="16" fill="currentColor">2</text>
        <text x="332" y="16" fill="currentColor">3</text>
        <text x="427" y="16" fill="currentColor">4</text>
        <text x="522" y="16" fill="currentColor">5</text>
        <text x="617" y="16" fill="currentColor">6</text>
        <text x="712" y="16" fill="currentColor">7</text>
      </g>
    </g>
  </g>
  <g transform="translate(60, 116)">
    <g font-size="10" text-anchor="middle" font-weight="700">
      <rect x="0" y="0" width="190" height="26" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="95" y="17" fill="#9a3412">req 0 · draft (k=2)</text>
      <rect x="190" y="0" width="95" height="26" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="237" y="17" fill="#5b21b6">req0 · bonus</text>
      <rect x="285" y="0" width="95" height="26" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="332" y="17" fill="#9a3412">req1 · draft (k=1)</text>
      <rect x="380" y="0" width="95" height="26" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="427" y="17" fill="#5b21b6">req1 · bonus</text>
      <rect x="475" y="0" width="190" height="26" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="570" y="17" fill="#9a3412">req 2 · draft (k=2)</text>
      <rect x="665" y="0" width="95" height="26" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="712" y="17" fill="#5b21b6">req2 · bonus</text>
    </g>
  </g>
  <g transform="translate(60, 168)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="#9a3412">target_logits_indices = [0, 1, 3, 5, 6]  → 5 行（K_total = 2+1+2）</text>
    <g transform="translate(0, 10)" font-size="9" text-anchor="middle">
      <rect x="0" y="0" width="95" height="20" fill="#fff7ed" stroke="#fed7aa"/><text x="47" y="14" fill="#9a3412">0</text>
      <rect x="95" y="0" width="95" height="20" fill="#fff7ed" stroke="#fed7aa"/><text x="142" y="14" fill="#9a3412">1</text>
      <rect x="285" y="0" width="95" height="20" fill="#fff7ed" stroke="#fed7aa"/><text x="332" y="14" fill="#9a3412">3</text>
      <rect x="475" y="0" width="95" height="20" fill="#fff7ed" stroke="#fed7aa"/><text x="522" y="14" fill="#9a3412">5</text>
      <rect x="570" y="0" width="95" height="20" fill="#fff7ed" stroke="#fed7aa"/><text x="617" y="14" fill="#9a3412">6</text>
    </g>
  </g>
  <g transform="translate(60, 216)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="#5b21b6">bonus_logits_indices = [2, 4, 7]  → 3 行（B 条请求各一个）</text>
    <g transform="translate(0, 10)" font-size="9" text-anchor="middle">
      <rect x="190" y="0" width="95" height="20" fill="#f5f3ff" stroke="#ddd6fe"/><text x="237" y="14" fill="#5b21b6">2</text>
      <rect x="380" y="0" width="95" height="20" fill="#f5f3ff" stroke="#ddd6fe"/><text x="427" y="14" fill="#5b21b6">4</text>
      <rect x="665" y="0" width="95" height="20" fill="#f5f3ff" stroke="#ddd6fe"/><text x="712" y="14" fill="#5b21b6">7</text>
    </g>
  </g>
  <g transform="translate(60, 260)">
    <rect x="0" y="0" width="760" height="120" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="14" y="18" font-size="11" font-weight="700" fill="currentColor">前缀和（用于行 → 请求映射）：</text>
    <g font-size="10" fill="currentColor">
      <text x="14" y="36"><tspan font-weight="700" fill="#475569">cu_num_draft_tokens   = [2, 3, 5]</tspan>  ·  本 step 累计 draft 行数（target_logits_indices 的分段点）</text>
      <text x="14" y="54"><tspan font-weight="700" fill="#475569">cu_num_sampled_tokens = [3, 5, 8]</tspan>  ·  累计采样行数（包含 bonus）</text>
      <text x="14" y="72"><tspan font-weight="700" fill="#475569">logits_indices        = [0, 1, 2, 3, 4, 5, 6, 7]</tspan>  ·  原 hidden_states 中的 gather 索引</text>
    </g>
    <text x="14" y="98" font-size="11" font-weight="700" fill="#16a34a">主流程：bonus_logits 走主 Sampler；target_logits 走 rejection_sample（per-row top-k/p 共享同请求参数）</text>
    <text x="14" y="112" font-size="10" fill="#15803d">同请求的 K 行共享一组 (top_k, top_p, min_p)，靠 cu_num_draft_tokens repeat_interleave 出来</text>
  </g>
</svg>
<span class="figure-caption">图 R9.5 ｜ SpecDecodeMetadata 的 logits 行布局：橙色块是 K_total 个 draft 位置（rejection sampling 决定接受/恢复），紫色块是 B 个 bonus 位置（走主 Sampler 当普通 decode 处理）；cu_num_draft_tokens 是把扁平行索引映射回每条请求的关键</span>

<details>
<summary>ASCII 原版</summary>

```
   logits 形状：[K_total + B, V]            (K_total = sum(num_draft_tokens))
   |--- target_logits_indices --|--- bonus_logits_indices ---|
   |  K_total 个"draft 位置"行  |  B 个"bonus 位置"行         |

   例：B=3，num_draft_tokens=[2,1,2]
       cu_num_draft_tokens   = [2,3,5]
       cu_num_sampled_tokens = [3,5,8]
       logits_indices        = [0,1, 2, 3, 4,5, 6, 7]
       target_logits_indices = [0,1, 3, 5,6]    # 5 行
       bonus_logits_indices  = [2, 4, 7]        # 3 行
```

</details>

布局源自 `vllm/v1/spec_decode/metadata.py:10` 的 `SpecDecodeMetadata`，由 ModelRunner 在 `_prepare_inputs` 中构造。

### 9.7.2 主流程

```python
# rejection_sampler.py:87
def forward(self, metadata, draft_probs, logits, sampling_metadata):
    bonus_logits = logits[metadata.bonus_logits_indices]           # [B, V]
    bonus_sampler_output = self.sampler(                           # 复用主 Sampler
        logits=bonus_logits,
        sampling_metadata=replace(sampling_metadata, max_num_logprobs=-1),
        predict_bonus_token=True,
        logprobs_mode_override="processed_logits" or "raw_logits",
    )
    bonus_token_ids = bonus_sampler_output.sampled_token_ids

    target_logits = logits[metadata.target_logits_indices].to(torch.float32)
    target_logits = self.apply_logits_processors(target_logits, ...)
    target_logits = apply_sampling_constraints(                    # min_p/top_k/top_p
        target_logits, metadata.cu_num_draft_tokens, sampling_metadata)

    output_token_ids = rejection_sample(
        metadata.draft_token_ids, metadata.num_draft_tokens,
        metadata.max_spec_len, metadata.cu_num_draft_tokens,
        draft_probs, target_logits, bonus_token_ids,
        sampling_metadata, ...)
    return SamplerOutput(sampled_token_ids=output_token_ids,
                         logprobs_tensors=...)
```

关键差异点：

1. **bonus token 走主 Sampler**（`:129`）：所有 top-k / top-p / min_p / 惩罚都对 bonus 生效，因为 bonus 是"在已接受全部 draft 之后多采的一个真实 token"，应该和普通 decode 等价。`predict_bonus_token=True` 让 `apply_logits_processors` 用 "spec_token_ids 合并 output_token_ids" 后的序列计算惩罚（`sampler.py:374`）。
2. **draft 位置的 logits 走特殊路径**（`apply_sampling_constraints`）：对 K_total 行同时应用 per-request 的 top-k/top-p；同一请求的 K 行共享同一组 `(k, p, min_p)`，靠 `cu_num_draft_tokens` 把行索引 repeat-interleave 出来。
3. **rejection 主循环用 Triton kernel**（`rejection_greedy_sample_kernel` / `rejection_random_sample_kernel`）：每个 grid 处理一条请求的 K 个 draft 位置，从左到右扫描；遇到第一个被拒的位置就采 recovered token 然后中断（后续 draft 必须丢弃，因为后续位置依赖前面那个被丢的 token）。
4. **greedy fast-path** (`:432`)：若 `all_greedy`，直接比 `target_argmax == draft_token_ids[i]` 即可决定接受；不必算 target_probs。
5. **logprobs 计算**（`_get_logprobs_tensors`，`:197`）：对每条请求的每个**实际生成**位置返回 top-k logprobs。被拒的 draft 位置在最终输出中被替换成 `PLACEHOLDER_TOKEN_ID = -1`，`parse_output` 在 numpy 端按 mask 过滤掉（`:265`）。

### 9.7.3 与主 Sampler 的代码复用

`RejectionSampler` 内嵌一个 `Sampler` 实例（`__init__` 时传入），并：

- 复用 `compute_logprobs` / `gather_logprobs` 静态方法；
- 复用 `apply_all_penalties` / `apply_bad_words_with_drafts`；
- 覆写 `apply_logits_processors` 以处理 `repeat_indices`（一请求 K 行）。

值得注意的是 **MinTokensLogitsProcessor** 在投机解码下用 `apply_with_spec_decode` 而非 `apply`（`rejection_sampler.py:333`），因为这是唯一一个 spec-aware 的内置 processor。其他 logitsprocs（min_p、logit_bias、自定义）在 spec decode 模式下被 `build_logitsprocs` 直接屏蔽。

---

## 9.8 batched 采样的工程优化总结

把分散在各处的优化集中列一下，便于读者自己实现引擎时参考：

| 优化 | 位置 | 收益 |
| --- | --- | --- |
| pin-memory CPU 镜像 + non-blocking H2D | `gpu_input_batch.py:215+` | 隐藏 batch 元数据上传延迟 |
| `all_greedy` / `no_penalties` / `no_top_k` 等 fast-path 标志 | `_make_sampling_metadata` | 跳过 kernel launch |
| 持久 batch + 增量 `BatchUpdate` | `logits_processor/state.py:18` | 避免每步重建 processor 状态 |
| `output_token_ids` 引用共享 | `SamplingMetadata.output_token_ids` | 零拷贝读 token 历史 |
| Gumbel-max 替代 multinomial | `topk_topp_sampler.py:390` | 消除 CUDA→CPU sync |
| `torch.where` 混合 greedy/random | `sampler.py:285` | 避免 sub-batch gather |
| FlashInfer fused sampling kernel | `flashinfer_sample` | 用 rejection sampling 跳过 sort |
| Triton top-k/top-p fused kernel | `ops/topk_topp_triton.py` | 比 PyTorch native 快 1.5–2× |
| Bin counts via `scatter_add_` | `model_executor/layers/utils.py:34` | 把 padded token 列表→ vocab 维 mask 一次 kernel |
| `argmax_invariant` 切分 | `LogitsProcessors` 容器 | greedy 路径跳过 min_p |
| `apply_top_k_only` 不排序 | `topk_topp_sampler.py:367` | top-k 无 top-p 时省 O(V log V) |
| float32 sampling | `sampler.py:91` | 避免 fp16/bf16 在 log_softmax 上的数值灾难 |
| `mark_unbacked` 防 dynamo 特化 | `sampler.py:334` | 防止 batch_size=1 → ≥2 时重编译 |

---

## 9.9 Logprobs 计算

### 9.9.1 Sampler 端

`Sampler.gather_logprobs` (`sampler.py:298`)：

```python
@staticmethod
def gather_logprobs(logprobs, num_logprobs, token_ids):
    topk_logprobs, topk_indices = torch.topk(logprobs, num_logprobs, dim=-1)
    token_ids = token_ids.unsqueeze(-1)
    token_logprobs = logprobs.gather(-1, token_ids)
    token_ranks = batched_count_greater_than(logprobs, token_logprobs)  # rank 1-based
    indices = torch.cat((token_ids, topk_indices), dim=1)               # 采样 token 排第 0 列
    logprobs = torch.cat((token_logprobs, topk_logprobs), dim=1)
    return LogprobsTensors(indices.to(torch.int32), logprobs, token_ranks)
```

输出 `LogprobsTensors`（`vllm/v1/outputs.py:51`），共三个张量：

- `logprob_token_ids[N, K+1]`：列 0 是采样 token，列 1..K 是 top-K（可能重叠）。
- `logprobs[N, K+1]`：同形 logprob。
- `selected_token_ranks[N]`：采样 token 在该位置 logits 上的真实 rank（用 `batched_count_greater_than` 算，定义在 `ops/logprobs.py:11`，是一个 `@torch.compile` 的 `(x >= v).sum(-1)`）。

返回值可能比用户请求的 `logprobs=K` 多一个：因为采样 token 排在第 0 列，可能与 top-K 中某个重复。Engine 端的 `LogprobsProcessor` 负责去重（见下文）。

特殊情形：

- `num_logprobs=-1`：返回全量 vocab `logprobs`，`indices` / `ranks` 为空（`sampler.py:117`）。
- `logprob_token_ids` 给定：走 `gather_specific_token_logprobs` (`sampler.py:145`)，用 fused Triton kernel `compute_token_logprobs`，比稀疏 gather 快约 1.4×。这是 scoring API（如分类任务）的 fast-path。

### 9.9.2 Prompt logprobs

Prompt logprobs 是另一条路径：模型 forward 必须保留 prompt 区间的所有 logits（而不是只取末位）。在 `gpu_model_runner.py:5345` 单独处理：

```python
logprobs = self.sampler.compute_logprobs(logits)
token_ids, logprobs, ranks, _ = self.sampler.gather_logprobs(
    logprobs, num_prompt_logprobs, token_ids=prompt_token_ids)
```

代价巨大：必须在 prefill 时跳过 KV cache fast prefill，且 logits 张量随 prompt 长度线性增长。`SamplingParams.skip_reading_prefix_cache` 在 `prompt_logprobs is not None` 时默认为 True（`sampling_params.py:446`），强制重算前缀。

### 9.9.3 Engine 端组装

`vllm/v1/engine/logprobs.py:30` 的 `LogprobsProcessor` 是 per-request 的 Python 端组件，负责：

1. 把 `LogprobsLists`（GPU→CPU 后的 numpy 结构）拆成每个 position 的 dict / FlatLogprobs。
2. 用 tokenizer 把 token id 解码成字符串；处理 byte-fallback 多字节 UTF-8 跨 token 的拼接（`_correct_decoded_token`）。
3. 维护 `cumulative_logprob`（采样 token 的 log-prob 累加，仅对采样而非 top-K 算）。
4. 在 spec decoding 时，一个 step 可能返回多个 token，外层 list 长度 > 1（`_update_sample_logprobs` 注释 `:71`）。

这里 sampler 输出"采样 token logprob 永远排第 0"是一个跨进程的弱约定，`_update_sample_logprobs` 直接用 `logprobs[0]` 累加。

---

## 9.10 SamplerOutput 与 ModelRunnerOutput

`SamplerOutput`（`vllm/v1/outputs.py:184`）极其精简：

```python
@dataclass
class SamplerOutput:
    sampled_token_ids: torch.Tensor          # [num_reqs, max_num_generated_tokens]
    logprobs_tensors: LogprobsTensors | None
```

- 在普通 decode 下 `max_num_generated_tokens = 1`，二维只是为了和 spec decoding 形状一致。
- 在 spec decoding 下，每行长度不一（被拒后 padded 成 `PLACEHOLDER_TOKEN_ID = -1`）。

`ModelRunnerOutput`（`outputs.py:233`）是发回 scheduler 进程的最终结构：

```python
@dataclass
class ModelRunnerOutput:
    req_ids: list[str]
    req_id_to_index: dict[str, int]
    sampled_token_ids: list[list[int]]                   # 已 CPU 化，按请求变长
    logprobs: LogprobsLists | None                       # numpy
    prompt_logprobs_dict: dict[str, LogprobsTensors | None]
    pooler_output: list[torch.Tensor | None] | None
    kv_connector_output: KVConnectorOutput | None
    ec_connector_output: ECConnectorOutput | None
    num_nans_in_logits: dict[str, int] | None
    cudagraph_stats: CUDAGraphStat | None
    routed_experts: RoutedExpertsLists | None
```

ModelRunner 的 `_bookkeeping_sync`（`gpu_model_runner.py:3470`）把 `SamplerOutput.sampled_token_ids` 这个 GPU 张量 D2H 转成 Python `list[list[int]]`，因为：

1. `ModelRunnerOutput` 要 IPC 给 scheduler 进程，张量序列化成本高。
2. Scheduler 后续做 `check_stop` 等 Python 端逻辑，本就需要 list。

**Discard 的请求**：`discard_sampled_tokens_req_indices`（`gpu_model_runner.py:3491`）会把已经被前一步标记为 abort/finished 的请求的采样结果丢弃（设置成空 list），并把它们的 generator 偏移回退 4，保证下次该 slot 复用时随机状态正确。

---

## 9.11 n>1 与 best_of：parallel sampling

OpenAI API 的 `n` 参数（"为同一个 prompt 返回 n 个独立完成"）在 vLLM V1 中 **不在 sampler 内部实现**，而是在前端层把请求复制成 n 个子请求：

```python
# vllm/v1/engine/async_llm.py:381
if is_pooling or params.n == 1:
    await self._add_request(request, prompt_text, None, 0, queue)
    return queue

parent_request = ParentRequest(request)
for idx in range(parent_params.n):
    request_id, child_params = parent_request.get_child_info(idx)
    child_request = request if idx == parent_params.n - 1 else copy(request)
    child_request.request_id = request_id
    child_request.sampling_params = child_params
    await self._add_request(child_request, prompt_text, parent_request, idx, queue)
```

`ParentRequest`（`vllm/v1/engine/parallel_sampling.py:13`）做三件事：

1. **生成 child sampling params**：`_get_child_sampling_params` (`:52`) 把 `n=1`，无 seed 时所有 child 共用同一个 `SamplingParams` 实例（缓存）；有 seed 时每个 child 用 `seed + index` 派生独立 seed。
2. **聚合输出**：streaming 模式下逐 child 直接转发；FINAL_ONLY 模式下用 `output_aggregator[index] = completion_output` 收齐 n 个后一次性返回。
3. **完成追踪**：`child_requests` set 在每个 child 完成时移除，全空时 parent 完成。

设计理由：

- **共享前缀缓存**：n 个 child 拥有相同的 prompt，自动命中 prefix cache（第 7 章），KV cache 重用率高。
- **保持 sampler 简单**：sampler 只看一维 `num_reqs`，不需要处理"一条请求 sample 多个独立 token"。
- **代价**：n 个 child 占用 n 个 batch slot；如果 prompt 较短而 n 很大，调度开销略高于 V0 的"一条 sequence group 包 n 个 seq"。

`best_of` 在 V1 中已不再支持（OpenAI 也已废弃），需要时由用户自己在 client 端用 `n` + 后处理实现。

---

## 9.12 停止条件检查

vLLM 把停止条件分摊到三个层面，没有任何停止判断在 sampler 内部完成：

### 9.12.1 EOS / stop_token_ids / max_tokens — Scheduler 检查

`vllm/v1/core/sched/utils.py:94`：

```python
def check_stop(request: Request, max_model_len: int) -> bool:
    sampling_params = request.sampling_params
    if request.num_output_tokens < sampling_params.min_tokens:
        return False

    last_token_id = request.output_token_ids[-1]
    if last_token_id == sampling_params.eos_token_id:
        request.status = RequestStatus.FINISHED_STOPPED
        return True
    if last_token_id in (sampling_params.stop_token_ids or ()):
        request.status = RequestStatus.FINISHED_STOPPED
        request.stop_reason = last_token_id
        return True
    if (request.num_tokens >= max_model_len
            or request.num_output_tokens >= request.max_tokens):
        request.status = RequestStatus.FINISHED_LENGTH_CAPPED
        return True

    repetition_detection = sampling_params.repetition_detection
    if repetition_detection is not None and check_sequence_repetition(...):
        request.status = RequestStatus.FINISHED_REPETITION
        return True
    return False
```

scheduler 每个 step 处理完 ModelRunnerOutput 后对每条请求调一次。状态映射在 `vllm/v1/request.py:351`：

```python
RequestStatus.FINISHED_STOPPED        → FinishReason.STOP
RequestStatus.FINISHED_LENGTH_CAPPED  → FinishReason.LENGTH
RequestStatus.FINISHED_ABORTED        → FinishReason.ABORT
RequestStatus.FINISHED_IGNORED        → FinishReason.LENGTH
```

### 9.12.2 stop 字符串 — Detokenizer 检查

字符串级 stop 必须等 detokenize 完成才能判断（因为一个 token 可能跨字符）。在 `vllm/v1/engine/detokenizer.py:131`：

```python
if self.stop and self.num_output_tokens() > self.min_tokens:
    stop = check_stop_strings(
        output_text=self.output_text,
        new_char_count=len(self.output_text) - stop_check_offset,
        stop=self.stop,
        include_in_output=self.include_stop_str_in_output,
    )
    if stop is not None:
        stop_string, truncate_to = stop
        if truncate_to != -1:
            self.output_text = self.output_text[:truncate_to]
```

`check_stop_strings` (`detokenizer.py:309`) 仅对**新增字符段**做 `find`，避免每步全文扫描。命中后按 `include_stop_str_in_output` 决定是否截断输出文本中的 stop 串本身。

### 9.12.3 min_tokens — 双重保险

`min_tokens` 在两个地方"软"实现：

1. `MinTokensLogitsProcessor` 在 sampler 内屏蔽 EOS / stop_token_ids 的 logits，让模型"采不到 stop"。
2. `check_stop` 在 scheduler 侧二次确认 `num_output_tokens >= min_tokens` 才认 stop。

二者都生效是因为：sampler 屏蔽 token 时只看采样输入，但 `include_stop_str_in_output` 等串级停止 detokenizer 仍可能截断到 stop 串末尾产生"提前结束"。两层防御确保 `min_tokens` 严格遵守。

### 9.12.4 设计原因

为什么不把停止条件做在 sampler 里？

- **延迟**：sampler 跑在 ModelRunner 进程；scheduler 在 EngineCore 进程。让 scheduler 判停可以在下一步立刻把 slot 释放给 waiting 队列。
- **stop 串需要 tokenizer**：sampler 一般跑在 GPU rank 0，detokenizer 跑在 EngineCore；让 sampler 持有 tokenizer 是反耦合的。
- **min_tokens 例外**：必须在 sampler 内屏蔽 logits，否则 `argmax` 仍然可能命中 EOS。所以它是"少数侵入 sampler 的停止逻辑"。

---

## 9.13 异步调度下的复杂性补丁

V1 支持 async scheduling：scheduler 进程不等 ModelRunner 把 step k 跑完，就开始 prepare step k+1 的输入。这给 sampler 带来几个补丁，集中说明：

1. **`-1` 占位 token**：`output_token_ids` 中允许出现 `-1`（async 下尚未真正生成）。`apply_all_penalties` 把 `-1` 替换成 `vocab_size`，让 scatter 落到 padding bin（`ops/penalties.py:30`）。
2. **`update_async_output_token_ids`**：sampler 调用前先把"上一步采样结果"补回 `output_token_ids`（`gpu_model_runner.py:3448`），确保 penalties / logitsprocs 看到的是真实序列。
3. **`update_async_spec_token_ids`**：投机解码 + async 下，draft token 也是上一步异步算的，同样需要在 sampler 前修正（`gpu_model_runner.py:3457`）。
4. **discard mask + generator rewind**：对已经标记 abort 的请求，sampler 仍然会算它的 logits 和采样（无法停掉 batched kernel），bookkeeping 时丢弃结果并把它的 generator 偏移回退 4 步，保证下次复用该 slot 时随机状态一致（`gpu_model_runner.py:3494`）。

---

## 9.14 新版 GPU Sampler（实验路径）

在 `vllm/v1/worker/gpu/sample/sampler.py` 有一个独立的 `Sampler` 类（`gpu/model_runner.py:206` 中按条件实例化），是 woosuk 在 2026 年正在推进的简化版重构。要点：

- 不再用 `SamplingMetadata` dataclass；改为直接持有 `SamplingStates`、`PenaltiesState`、`LogitBiasState`、`BadWordsState`、`LogprobTokenIdsState` 等独立 state 对象，每个负责自己的 GPU 张量 lifecycle 和 batch 增删（`add_request` / `apply_staged_writes`）。
- 采样核心改用 `gumbel_sample`（`vllm/v1/worker/gpu/sample/gumbel.py`），把温度 / 随机性 / per-request seed 全部用 Gumbel-max trick fused 成一个 kernel。
- 仅支持 `raw_logprobs` / `processed_logprobs`（明确不支持返回 logits 的两种模式）。
- logits_processor 插件接口（`apply_logits_processors`）暂时缺失。

本章主要按主线 `vllm/v1/sample/sampler.py` 描述。读者实现自己的引擎时可以先复刻主线，新路径的 staged-write 模式作为长批稳态优化思路参考。

---

## 9.15 实现者指南：最小可工作 Sampler

如果你要自己实现一个 LLM 推理引擎，下面是从本章 distill 出的最小必要功能清单，按"先做这个，再做那个"排序：

1. **第一版**：`temperature → softmax → torch.multinomial`，加 `greedy if temperature == 0`。能跑通。
2. **加 top-k / top-p**：`sort → cumsum → mask → re-scatter`。直接抄 `apply_top_k_top_p_pytorch`。
3. **避开 multinomial**：换 Gumbel-max（`probs / Exponential(1) → argmax`），消除 sync。
4. **per-request 参数**：把 temperature/top_k/top_p 改成 `[num_reqs]` 张量，所有 op 都用 broadcasting。
5. **per-request seed**：维护 `dict[int, torch.Generator]`，少数 seeded 行按 row override `q` 张量。
6. **惩罚**：实现 `get_token_bin_counts_and_mask`（用 `scatter_add_`），叠加 repetition / frequency / presence。
7. **min_tokens / logit_bias / allowed_token_ids**：作为可插拔 logits processor，区分 argmax-invariant 与否。
8. **logprobs**：`gather_logprobs` 返回 top-K + sampled，rank 用 `(logits >= sampled_logits).sum(-1)`。
9. **n>1**：在前端层 fan-out 成 n 个请求，复用 prefix cache，不要在 sampler 里展开。
10. **结构化输出**：把 grammar bitmask 在 sampler 入口前 in-place 写到 logits（`-inf`），不要走 LogitsProcessor 抽象。
11. **投机解码**：单独写 `RejectionSampler`，复用主 Sampler 处理 bonus token；对 draft 位置用 `cu_num_draft_tokens` 做 repeat-interleave。
12. **停止条件**：放到 scheduler 而非 sampler；min_tokens 是唯一需要 sampler 配合的（屏蔽 EOS）。

到第 7 步你就有一个可以服务 OpenAI 兼容 API 的引擎了；其余是投机解码、结构化输出和性能优化。
