# 第 15 步 —— decode forward 跟 prefill 哪里不一样？

> 这是 vllm 单请求 trace 的第 15 步。
> 上一步：第二次 scheduler 决策完毕，`SchedulerOutput` 说"req#1 算 1 个 token"。Worker 现在准备好了 input batch：`input_ids` 长度 1（上一步生成的那 1 个 token id）、`positions = [4]`（prompt 4 token + 已生成 1 token，新位置是 index 4）、`cu_seqlens = [0, 1]`（只有一段、长度 1）。
> 本步：跟着这个 query=1 的 batch 跑一遍 forward，看 decode 跟第 9-11 步走的 prefill 哪里不一样。

## 1. 当前情境

input batch 已经在 GPU 上：

- `input_ids` shape `(1,)`，值 = `[tok1_id]`（上一步 sampler 出的那个 token）
- `positions` shape `(1,)`，值 = `[4]`
- `slot_mapping` shape `(1,)`，值 = 这一个新位置在物理 block 中的偏移（block#X 内的第 5 个 slot）
- `block_table` shape `(1, max_blocks_per_req)`，值 = `[[X, 0, 0, ...]]`，只用到第 1 个 block
- `seq_lens` = `[5]`（这个 request 的总历史长度，包含新 token 的位置）

`GPUModelRunner.execute_model` (`vllm/v1/worker/gpu_model_runner.py:3913`) 已经被叫起来，AttentionMetadata 已构造完毕。下一步 `model.forward()` 即将进入。

## 2. 问题

跟第 9-11 步的 prefill 比，decode 的"形状"完全变了：

- prefill：`input_ids` 4 个 token、attention 要算 4×4 的 QK 矩阵（causal mask）、KV 算完后写进 4 个连续 slot
- decode：`input_ids` 1 个 token、attention 要算 **1×5** 的 QK（新 query 看历史 5 个位置 KV）、新 K/V 算完后只写 1 个 slot

**核心问题**：Q 长度 = 1、K/V 长度 = 历史长度 = 5。 这种极度不对称的形状，attention kernel 怎么处理？KV 从哪儿读？新 KV 往哪儿写？

**更现实的问题**：decode 一次 forward 只算 1 个 token，但要走完 32 层 transformer（Qwen2.5-7B），每层都有 attention + MLP。**单 token 的浮点量小到 kernel launch overhead 都比计算时间长**——这是 decode 阶段的 GPU 利用率天敌。vllm 怎么破？

## 3. 朴素思路

直接复用 prefill 的 kernel：把 K/V 历史和新 token 拼起来当成一段 length=5 的序列，跑一次 prefill-style attention。但这样：

- 重新算了 4 次没必要的 K/V（历史 K/V 早就存着了）
- 走的是为长 seq 优化的 kernel（重排、tiling 都按长 seq 设计），对 length=5 没收益

更朴素的想法：每次 decode 都 launch 一堆 cudaMemcpy / kernel，每个 kernel 5-10μs latency，32 层 × 多个 kernel = 几百次 launch，几毫秒就过去了，**纯 overhead**。

## 4. 为什么朴素思路会崩

(a) **重算历史 K/V 是 O(N) 浪费**。decode 第 100 步要重算前 99 个位置的 K/V projection，相当于把整个 prefill 重来一遍。N 大了直接打回 KV cache 出现之前的世界。

(b) **CPU 端 kernel launch overhead 是 decode 的隐藏瓶颈**。Qwen2.5-7B 一层有 7-12 个 GPU kernel（qkv projection、reshape、attention、output projection、norm、gate、up、down、residual、norm、residual），32 层 × 10 ≈ 320 个 kernel。每个 launch 5μs，理论 latency 下限 1.6ms——而 7B decode 算力实际可能只要 0.5ms 跑完。**latency 被 launch 钉住了下限**。

(c) **batch_size=1 时算力极度浪费**。GPU 一个 SM 一次能并行几千 thread，单 token decode 的 GEMV 完全用不满。

## 5. vllm 的做法

(a) **PagedAttention 的 decode 路径专门读历史 K/V**。看 `vllm/v1/attention/backends/flash_attn.py` 的 forward：

- 入参 `max_query_len`（`vllm/v1/attention/backends/flash_attn.py:233`）正是"本 batch 内 Q 段最长是多少"。decode-only batch 时 `max_query_len = 1`
- backend 计算新 token 的 Q / K / V（只算 1 个位置——`input_ids.shape[0] == 1`）
- 用 `reshape_and_cache_flash`（`vllm/v1/attention/backends/flash_attn.py:41` 处导入）把新算的 K/V 按 `slot_mapping` 写进 paged KV cache 的物理 slot
- attention kernel（FlashAttention varlen）用 `block_table` 把这个 request 的 5 个历史 KV 位置展开成"虚拟连续 KV 序列"，对 1 个 Q 做 attention
- FA2 有专门的 `max_query_len=1` packed-GQA 优化分支（`vllm/v1/attention/backends/flash_attn.py:281-284` 那段注释提到）

历史 K/V **不需要重算**——它们早就在 prefill 步骤被写进 block 了。新 K/V 只算这 1 个新位置。

(b) **CUDA graph 在 decode 这里通常命中**。`CudagraphDispatcher.dispatch` (`vllm/v1/cudagraph_dispatcher.py:239`) 在 `gpu_model_runner.py:2765`、`gpu_model_runner.py:3714-3734` 处被调用：

- 入参 `num_tokens = 1`、`uniform_decode = True`（batch 内所有 request 都是 decode，且 Q 长度都相同）
- dispatcher 在 cudagraph_keys[FULL] 里查 `BatchDescriptor(num_tokens=1, uniform=True, ...)`
- 命中 → 返回 `(CUDAGraphMode.FULL, batch_desc)`（`vllm/v1/cudagraph_dispatcher.py:311-315`）
- 后续 `execute_model` 不再 launch 单个 kernel，而是 launch **整张 graph**——一次 launch 等效几百次 kernel
- launch overhead 从 320 × 5μs ≈ 1.6ms 降到 单次 graph launch 的几十微秒

这就是为什么 vllm 在第 2 步要花那么大力气 capture 多个 batch-size bucket 的 graph——bucket 命中率是 decode 阶段 latency 的命门。`batch_size=1` 几乎必命中（默认 capture 列表里一定有 1）。

(c) **混合 batch 时降级到 PIECEWISE 或 NONE**。如果 batch 里既有 decode 又有 prefill，`uniform_decode=False`，FULL graph 不命中，dispatcher 退到 PIECEWISE（`vllm/v1/cudagraph_dispatcher.py:317-322`）或 NONE。本 trace 单 request 不存在这问题。

走完所有 32 层后到 final norm + lm_head（同第 11 步路径），得到 1 个位置的 vocab logits；sampler greedy argmax 出第 2 个 token id。

### 一个被忽略的细节：FA 的 `max_query_len=1` 路径

FlashAttention 2 在 `max_query_len=1` 时走专门的 packed-GQA 优化（Q 只有 1 行，KV 用 block_table 间接寻址），单独 capture 一份 graph (`vllm/v1/attention/backends/flash_attn.py:281-288` 那段注释解释了 spec-decode 时为什么不能复用)。decode 与 prefill 的 attention 实际走的是**两条不同的 kernel 调用路径**，vllm 在 backend 内部用 `max_query_len` 区分。

### 看图：decode 一次 forward 的数据流

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="decode 一次 forward 的数据流：embed + 32 层 + lm_head + sampler，整体被一张 cudagraph 包住">
  <defs>
    <marker id="t15ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">decode 一次 forward：1 token 走完 32 层 → 第 2 个 token</text>
  <rect x="30" y="36" width="700" height="488" fill="none" stroke="#0d9488" stroke-width="2" stroke-dasharray="6,4" rx="10"/>
  <text x="48" y="54" font-size="11" font-weight="700" fill="#0d9488">CUDA Graph (FULL) ─ 整个虚线框 = 一次 graph replay</text>
  <g transform="translate(60, 66)">
    <rect x="0" y="0" width="640" height="50" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="320" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">输入张量 (GPU, shape=1)</text>
    <text x="20" y="38" font-size="10" font-family="monospace" fill="#7c2d12">input_ids=[tok1]　positions=[4]　slot_mapping=[X*16+4]　block_table=[[X,...]]</text>
  </g>
  <line x1="380" y1="116" x2="380" y2="134" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <g transform="translate(60, 138)">
    <rect x="0" y="0" width="640" height="30" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="3"/>
    <text x="320" y="20" text-anchor="middle" font-size="11" fill="#475569">embed_tokens  →  hidden (1, hidden_size)</text>
  </g>
  <line x1="380" y1="168" x2="380" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <g transform="translate(60, 190)">
    <rect x="0" y="0" width="640" height="240" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="320" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">LlamaDecoderLayer × 32</text>
    <line x1="16" y1="28" x2="624" y2="28" stroke="#7c3aed" stroke-width="0.6" stroke-dasharray="2,2"/>
    <rect x="40" y="40" width="560" height="24" fill="white" stroke="#7c3aed" stroke-width="0.6" rx="3"/>
    <text x="320" y="56" text-anchor="middle" font-size="10" fill="#4c1d95">input_layernorm  →  qkv_proj → q(1,H)　k(1,H_kv)　v(1,H_kv)</text>
    <rect x="40" y="72" width="560" height="100" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2" rx="4"/>
    <text x="320" y="90" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">attention backend forward</text>
    <rect x="60" y="100" width="240" height="56" fill="white" stroke="#dc2626" stroke-width="0.8" rx="3"/>
    <text x="180" y="118" text-anchor="middle" font-size="10" font-weight="700" fill="#7f1d1d">reshape_and_cache_flash</text>
    <text x="180" y="132" text-anchor="middle" font-size="9" fill="#991b1b">把新 K/V 写到</text>
    <text x="180" y="146" text-anchor="middle" font-size="9" font-family="monospace" fill="#991b1b">paged_cache[X*16 + 4]</text>
    <rect x="340" y="100" width="240" height="56" fill="white" stroke="#dc2626" stroke-width="0.8" rx="3"/>
    <text x="460" y="118" text-anchor="middle" font-size="10" font-weight="700" fill="#7f1d1d">flash_attn_varlen_func</text>
    <text x="460" y="132" text-anchor="middle" font-size="9" fill="#991b1b">Q=(1,H)，KV 按 block_table</text>
    <text x="460" y="146" text-anchor="middle" font-size="9" fill="#991b1b">取 5 个历史位置 → (1, H)</text>
    <rect x="40" y="180" width="560" height="24" fill="white" stroke="#7c3aed" stroke-width="0.6" rx="3"/>
    <text x="320" y="196" text-anchor="middle" font-size="10" fill="#4c1d95">o_proj  →  post_attention_layernorm</text>
    <rect x="40" y="208" width="560" height="24" fill="white" stroke="#7c3aed" stroke-width="0.6" rx="3"/>
    <text x="320" y="224" text-anchor="middle" font-size="10" fill="#4c1d95">mlp: gate_up_proj  →  silu * mul  →  down_proj  →  residual</text>
  </g>
  <line x1="380" y1="430" x2="380" y2="448" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <g transform="translate(60, 452)">
    <rect x="0" y="0" width="640" height="30" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="3"/>
    <text x="320" y="20" text-anchor="middle" font-size="11" fill="#475569">final norm  →  lm_head  →  logits (1, vocab_size)</text>
  </g>
  <line x1="380" y1="482" x2="380" y2="500" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
  <g transform="translate(60, 504)">
    <rect x="0" y="0" width="640" height="40" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="4"/>
    <text x="320" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">sampler → tok2_id</text>
    <text x="320" y="34" text-anchor="middle" font-size="9" fill="#14532d">虚线框（整张图）= 一次 graph launch，省下 ~320 次 kernel launch ≈ 1.6 ms</text>
  </g>
</svg>
<span class="figure-caption">图 T15.1 ｜ decode 一次 forward 数据流。1 个 query 走完 embed + 32 层 LlamaDecoderLayer + lm_head + sampler，attention 内部 reshape_and_cache_flash 写新 K/V（1 个 slot），flash_attn_varlen_func 按 block_table 读 5 个历史 KV。整张图被 FULL cudagraph 包成单次 launch——这是 decode latency 的命门</span>

<details>
<summary>ASCII 原版</summary>

```text
input_ids=[tok1_id]   positions=[4]   slot_mapping=[X*16+4]   block_table=[[X,...]]
        │
        ▼
  embed_tokens   → hidden (1, hidden_size)
        │
        ▼
┌────────  LlamaDecoderLayer × 32  ────────┐
│ input_layernorm                          │
│ qkv_proj  → q (1, H)  k (1, H_kv)  v ... │
│ ┌── attention backend forward ─────────┐ │
│ │ reshape_and_cache_flash:             │ │
│ │   把新 K/V 写到 paged cache[X*16+4]  │ │
│ │ flash_attn_varlen_func:              │ │
│ │   Q=(1,H), KV 从 block_table 取出 5  │ │
│ │   个历史位置 → 输出 (1, H)           │ │
│ └──────────────────────────────────────┘ │
│ o_proj                                   │
│ post_attention_layernorm                 │
│ mlp (gate_up_proj → silu*mul → down)     │
└──────────────────────────────────────────┘
        │
        ▼
  norm  →  lm_head  →  logits (1, vocab_size)
        │
        ▼
  sampler → tok2_id
```

</details>

整张图（32 层）被打包成一张 cudagraph，一次 launch 跑完。

## 6. 代码位置

主线：

- `vllm/v1/worker/gpu_model_runner.py::GPUModelRunner.execute_model` (`vllm/v1/worker/gpu_model_runner.py:3913`) —— 入口，和 prefill 共用
- `vllm/v1/worker/gpu_model_runner.py:3714-3768` —— `dispatch_cudagraph` 局部函数；决定本次走 FULL / PIECEWISE / NONE
- `vllm/v1/cudagraph_dispatcher.py::CudagraphDispatcher.dispatch` (`vllm/v1/cudagraph_dispatcher.py:239`) —— 查表逻辑
- `vllm/v1/attention/backends/flash_attn.py` —— attention 后端 forward；注意 `max_query_len` 在 `vllm/v1/attention/backends/flash_attn.py:233`、`reshape_and_cache_flash` 在 `vllm/v1/attention/backends/flash_attn.py:41`
- FA varlen kernel `flash_attn_varlen_func`（`vllm/v1/attention/backends/flash_attn.py:39`）+ scheduler metadata `get_scheduler_metadata`（`vllm/v1/attention/backends/flash_attn.py:40`）

**阅读顺序**：先看 `execute_model` 头部如何调 `dispatch_cudagraph`、根据返回的 `cudagraph_mode` 选择 graph replay 还是 eager；再到 `CudagraphDispatcher.dispatch` 看 key lookup 怎么命中；最后到 flash_attn backend 的 forward，关注 prefill / decode 分支怎么靠 `max_query_len` 切换。

## 7. 分支与延伸

- **FlashAttention 后端 vs FlashInfer / Triton / FlexAttention，decode 路径有什么差别？** → 第 7 章 §4 "FlashAttention" + §5-§7（FlashInfer、Triton、Flex 章节）
- **一次 attention 调用从 Python 到 kernel 的完整链路？** → 第 7 章 §12 "一次 attention 调用流程"
- **CUDA graph capture 时 batch_size bucket 怎么选？为什么默认列表是 `[1, 2, 4, 8, ...]`？** → 第 6 章 §10 "CudagraphDispatcher"
- **`execute_model` 在 async scheduling 下流水线怎么打？** → 第 6 章 §7 "execute_model"
- **MLA（DeepSeek、Kimi）的 decode 路径完全不同（K/V 压缩），不走这条 backend。** → 第 7 章 mla/ 子目录章节
- **spec decode（draft + target）的 decode forward 怎么变？** Q 长度不再是 1，要算 spec_token_ids 个 token → 第 11 章 "spec decode"
- **uniform decode 在 batch 不均匀时（部分 spec、部分非 spec）怎么 fallback？** → 第 6 章 §10 + 第 7 章 §1 "attention metadata 设计"
- **TP 场景下 decode kernel 还要等 AllReduce，latency 怎么变？** → 第 10 章 "分布式与并行"

## 8. 走完这一步你脑子里应该多了什么

1. decode forward 和 prefill 在 vllm 是**同一份代码路径**——区别只在 input shape (`max_query_len=1` vs `>1`) 和 cudagraph dispatch 结果
2. PagedAttention 的 decode 是"读历史 KV、算新 K/V、写一个 slot、做 1×N attention"——历史 KV **从不重算**
3. **CUDA graph 是 decode latency 的命门**：launch overhead 在 batch_size=1 时占大头，graph replay 把几百次 launch 折成一次。这就是为什么第 2 步要 capture 那么多 bucket
4. `max_query_len == 1` 是 FA 内部的快路径触发条件；spec decode 把它打破，所以 spec decode 的 graph 要单独 capture（你能从 `flash_attn.py:281-288` 那段注释看到这个细节的成本）
5. 第 2 个 token 出来后，状态：`num_output_tokens = 2`，离 `max_tokens=3` 还差 1——再来一次 step，就是第 16 步要处理的"停下来"
