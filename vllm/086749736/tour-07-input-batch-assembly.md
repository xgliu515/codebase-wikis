# Trace 步骤 07 —— SchedulerOutput 怎么变成 GPU 上的 tensor batch？

> 单请求 trace 第 7 步。上一步：KVCacheManager 给我们的 request 分了 block，SchedulerOutput 已经离开 Scheduler，准备送进 worker。
> 本步主题：把这个跨进程的纯 Python 调度结果，翻译成"模型 forward 真正吃的"那几个 GPU tensor。

## 1. 当前情境

第 5、6 步结束时，EngineCore 进程手里有一个 `SchedulerOutput`：

- `num_scheduled_tokens = {"req#1": 4}`（"你好" 经 Qwen tokenizer 分成约 2-4 个 token，这里按 4 算）
- `scheduled_new_reqs = [NewRequestData("req#1", prompt_token_ids=[...4 个 id...], block_ids=([17],), ...)]`
- `total_num_scheduled_tokens = 4`
- `num_common_prefix_blocks = [0]`、`scheduled_spec_decode_tokens = {}`、`finished_req_ids = set()`

这是一份**纯 Python dataclass**——没有 tensor、没有 GPU 数据。EngineCore 通过 executor 把它喂给 worker，worker 再调到 `GPUModelRunner.execute_model()`（`vllm/v1/worker/gpu_model_runner.py:3913`）。`execute_model` 头几行做的是把 SchedulerOutput 落到 GPU 张量上：先 `_update_states()`（`gpu_model_runner.py:3955`）把新 request 加入 `InputBatch`，然后调 `_prepare_inputs()`（`gpu_model_runner.py:3997`）开始本步真正干的活。

调用链：`EngineCore.step()` → `Executor.execute_model(scheduler_output)`（uniproc 实现见 `vllm/v1/executor/uniproc_executor.py:107`，对应 `collective_rpc("execute_model", ...)`）→ `Worker.execute_model()`（`vllm/v1/worker/gpu_worker.py:783`）→ `GPUModelRunner.execute_model()` → `_prepare_inputs()`。

## 2. 问题

模型 `forward(input_ids, positions, ...)` 期望的输入有非常具体的形状要求：

- `input_ids: (total_num_tokens,) int32`——**所有 request、所有要算的 token 平铺成一个一维向量**
- `positions: (total_num_tokens,) int64`——每个 token 在它所属 request 里的绝对位置（不是在 batch 里的偏移）
- `slot_mapping: (total_num_tokens,) int64`——每个 token 的 KV 要写到物理 KV cache 池的**哪一个槽位**（block_id × block_size + 槽内偏移）
- `block_table: (num_reqs, max_blocks_per_req) int32`——每个 request 的逻辑→物理 block 映射，attention kernel 读 KV 时要用
- 还要有 `cu_seqlens`（cumulative sequence lengths）告诉 FlashAttention "第 i 个 request 在平铺数组的 \[cu\[i\], cu\[i+1\]) 区间"

但 SchedulerOutput 给我们的是：一堆 Python list、dict，散落在不同 request 上；一个 batch 里**可能同时有 prefill（多 token）和 decode（1 token）请求**；request 数量、每个 request 跑多少 token 都会随 step 而变。

问题：怎么把这堆异构的 Python 数据高效拼成一组紧凑的 GPU tensor，并且**每一步只做最少的 H2D 拷贝**？

## 3. 朴素思路

最直觉的写法：

1. 维护一个 `requests: dict[req_id, RequestState]`，每个 RequestState 自带 `token_ids: list[int]`、`block_ids: list[int]`。
2. 每 step：扫一遍 SchedulerOutput 里的 request，把它们的 token_ids 拼成一个 Python list，pad 到最长 seq，`torch.tensor(...).cuda()`。
3. positions、slot_mapping 同理：Python 循环算出来 → `torch.tensor → .cuda()`。
4. block_table 也每 step 重建。

这写起来 30 行就够了。

## 4. 为什么朴素思路会崩

每一项都会咬人：

- **pad 到最长 seq 的浪费**：一个 batch 里若有一个 4000-token prefill + 七个 1-token decode，pad 之后你要算 8 × 4000 = 32000 个 token，浪费 ≈ 28000 个。这违反了 PagedAttention 的"packed varlen"前提。
- **每 step `torch.tensor(...).cuda()` 都是 pageable → pinned → device 三次拷贝**。Decode 阶段一步只算十几个 token，这种小拷贝的固定开销远大于实际数据量。
- **Python 循环算 positions/slot_mapping** 对每个 token 都要查表，N=10000 时直接吃掉一两毫秒——decode 整体只想跑 10 ms，光准备就吃了 20%。
- **block_table 每 step 重建** 要把所有活跃 request 的 block list 拷到 GPU。一个 request 假设 256 个 block，500 个 request → 128k 个 int32，每 step 一次 H2D 拷不起。
- **dict[req_id, RequestState] 的非连续内存** 让 CPU 端的 numpy 向量化算法完全用不上：你想 `np.repeat(...)`、`np.cumsum(...)` 这种快路径，前提是数据要紧密排列。

更根本的：朴素方案把"持久"状态（哪些 request 在 batch、它们 token 是什么）和"瞬态"状态（本 step 算几个 token）混在一起，每 step 都要从零拼起。

## 5. vllm 的做法

围绕两条主线：**InputBatch（SoA + 持久 CPU/GPU buffer）** 与 **packed + cu_seqlens + slot_mapping** 三件套。

**InputBatch（`vllm/v1/worker/gpu_input_batch.py:91`）** 是一个**持久**对象：在 LLM 初始化时按 `max_num_reqs × max_model_len` 一次性分配好所有 CPU/GPU 张量，运行中只往"行槽"里**填**，从不重建：

- `token_ids_cpu_tensor: (max_num_reqs, max_model_len) int32`（`gpu_input_batch.py:133`）——每行一个 request 的 token，按 row index 找
- `num_computed_tokens_cpu: (max_num_reqs,) int32`（`gpu_input_batch.py:162`）——每个 request 已经算过的 token 数
- `num_prompt_tokens_cpu: (max_num_reqs,) int32`、`num_tokens_no_spec_cpu: (max_num_reqs,) int32`
- `temperature / top_p / top_k / ...` 全部 SoA（`gpu_input_batch.py:184` 起）

为什么是 **SoA（Struct of Arrays）而不是 AoS**：每 step 要做的事是"对当前在 batch 的 N 个 request 同时拿出它们的 temperature"——SoA 下就是一个连续 `temperature_cpu[:num_reqs]` 切片，AoS 下要逐个 RequestState 取字段然后凑数组。第 6 章 §5.1（`06-worker-and-model-runner.md:218`）专门讲了这个动机。

`CachedRequestState`（`gpu_input_batch.py:33`）配套存"少量的、形状不规则的"per-request 信息（如 prompt_token_ids、mm_features、block_ids），不放进 SoA 张量里。

**CpuGpuBuffer（`vllm/v1/utils.py:108`）** 是 InputBatch 上每个张量的标配封装：同时持有 `cpu`（pinned）、`gpu`（device）和 `np`（cpu.numpy() 共享底层）三视图。CPU 端用 numpy 改值，然后一次 `copy_to_gpu(n)` 异步 H2D。这就解释了为什么 InputBatch 大量字段后面带 `_cpu_tensor`、`_cpu`、`_cpu_tensor.numpy()`。

**packed + cu_seqlens + slot_mapping** 三件套是 forward tensor 这一侧：所有 request 的 token **不 pad**，按 batch 内顺序首尾相接平铺成一维。第 i 个 request 的 token 在平铺数组里占 `[cu_seqlens[i], cu_seqlens[i+1])` 这一段。FlashAttention 内部循环时就用这个 cu_seqlens 来界定哪些 token 属于同一个 request、哪些可以相互看见。

`_prepare_inputs()`（`gpu_model_runner.py:1839`）就是把这两侧捏在一起。本 step（4-token 单 prefill）的执行逻辑：

```
# 1. 把"本 step 要写的 block_ids"H2D（提前发，跟下面 CPU 计算重叠）
#    gpu_model_runner.py:1859
self.input_batch.block_table.commit_block_table(num_reqs=1)

# 2. 在 CPU 上 numpy 算 cu_num_tokens、req_indices、positions
#    [4] -> cu = [4]; req_indices = [0,0,0,0]; query_pos = [0,1,2,3]
#    positions = num_computed_tokens_cpu[0] + query_pos = [0,1,2,3]
#    (gpu_model_runner.py:1863-1893)

# 3. 从持久 token_ids_cpu_tensor 中 index_select 出本 step 要算的 input_ids
#    写到 self.input_ids.cpu[:4]，稍后一起 H2D
#    (gpu_model_runner.py:1899-1904)

# 4. 填 query_start_loc.np = [0, 4, 4, 4, ...]（pad 到 max_num_reqs+1），copy_to_gpu
#    (gpu_model_runner.py:1953-1958)

# 5. GPU 端用 self.num_computed_tokens[req_indices] + query_pos 算 positions
#    (gpu_model_runner.py:2051-2054)
#    seq_lens[:1] = [0+4] = [4]

# 6. 启动 Triton kernel 算 slot_mapping
#    block_table.compute_slot_mapping(...)  -> gpu_model_runner.py:2060-2064
#    内部 kernel: 见 block_table.py:325-380（_compute_slot_mapping_kernel）

# 7. 把 input_ids 从 CPU 异步 H2D 到 GPU
#    _prepare_input_ids -> self.input_ids.copy_to_gpu(total_num_scheduled_tokens)
#    (gpu_model_runner.py:1684)
```

为什么 `commit_block_table` 是第一件事：H2D 拷贝走 copy engine，跟后面纯 CPU 的 numpy 计算并行，藏拷贝延迟（`gpu_model_runner.py:1857-1859` 的注释明说了）。

**BlockTable（`vllm/v1/worker/block_table.py:18`）** 自己也是 CpuGpuBuffer-based 的持久结构：`(max_num_reqs, max_num_blocks_per_req) int32`（`block_table.py:70-72`）。`append_row` / `add_row`（`block_table.py:102-122`）只在 CPU numpy 视图上改值，`commit_block_table`（`block_table.py:166-167`）才一次 H2D。Scheduler 在第 6 步分配的 `block_ids = [17]` 通过 `_update_states()`（`gpu_model_runner.py:1107` 附近）调到 `block_table.append_row([17], row_idx=0)`，但**那时不立刻 H2D**——攒到 `_prepare_inputs` 才 commit。

**slot_mapping 是怎么算的**（`block_table.py:141-164` + `_compute_slot_mapping_kernel`, `block_table.py:325-380`）：给每个本 step 要算的 token，从 GPU 上的 block_table 里查它所在的 block_id，然后算 `slot = block_id * block_size + (position % block_size)`。这是一个 Triton kernel，对 num_tokens 上千的 prefill batch 也一次启动算完。本 step 4 个 token、block_size=16、block_id=17、positions=[0,1,2,3] → slot_mapping = [17×16+0, 17×16+1, 17×16+2, 17×16+3] = [272, 273, 274, 275]。

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="SchedulerOutput 经过持久 InputBatch 到 forward tensor 的三段式翻译">
  <defs>
    <marker id="t7ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">SchedulerOutput → 持久 InputBatch → 本 step forward tensor</text>
  <g transform="translate(20, 44)">
    <rect x="0" y="0" width="260" height="288" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="130" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">SchedulerOutput</text>
    <text x="130" y="36" text-anchor="middle" font-size="10" fill="#7c2d12">纯 Python dataclass，跨进程</text>
    <line x1="12" y1="44" x2="248" y2="44" stroke="#ea580c" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="12" y="64" font-size="10" font-family="monospace" fill="#7c2d12">num_scheduled_tokens</text>
    <text x="20" y="78" font-size="10" font-family="monospace" fill="#9a3412">= {req#1: 4}</text>
    <text x="12" y="102" font-size="10" font-family="monospace" fill="#7c2d12">new_reqs = [</text>
    <text x="20" y="116" font-size="10" font-family="monospace" fill="#9a3412">NewRequestData(</text>
    <text x="32" y="130" font-size="10" font-family="monospace" fill="#9a3412">"req#1",</text>
    <text x="32" y="144" font-size="10" font-family="monospace" fill="#9a3412">block_ids=([17],),</text>
    <text x="32" y="158" font-size="10" font-family="monospace" fill="#9a3412">prompt_ids=[a,b,c,d])</text>
    <text x="12" y="172" font-size="10" font-family="monospace" fill="#7c2d12">]</text>
    <text x="12" y="200" font-size="10" font-family="monospace" fill="#7c2d12">finished_req_ids = ∅</text>
    <text x="12" y="222" font-size="10" font-family="monospace" fill="#7c2d12">scheduled_spec = {}</text>
    <text x="130" y="260" text-anchor="middle" font-size="10" font-style="italic" fill="#9a3412">无 tensor、无 GPU 数据</text>
    <text x="130" y="276" text-anchor="middle" font-size="10" font-style="italic" fill="#9a3412">"调度的意图"</text>
  </g>
  <path d="M 280 188 L 320 188" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t7ar)"/>
  <text x="300" y="180" text-anchor="middle" font-size="9" fill="#64748b">_update_states</text>
  <g transform="translate(320, 44)">
    <rect x="0" y="0" width="260" height="288" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="130" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">InputBatch（持久 SoA）</text>
    <text x="130" y="36" text-anchor="middle" font-size="10" fill="#4c1d95">启动时一次分配，只往里填，从不重建</text>
    <line x1="12" y1="44" x2="248" y2="44" stroke="#7c3aed" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="12" y="62" font-size="10" font-family="monospace" fill="#5b21b6">token_ids_cpu_tensor</text>
    <text x="12" y="74" font-size="9" fill="#7c3aed">(max_num_reqs × max_model_len)</text>
    <rect x="12" y="80" width="236" height="20" fill="white" stroke="#7c3aed" stroke-width="0.6"/>
    <text x="18" y="94" font-size="9" font-family="monospace" fill="#4c1d95">行 0: [ a  b  c  d  0  0 ...]</text>
    <text x="12" y="120" font-size="10" font-family="monospace" fill="#5b21b6">num_computed_tokens_cpu</text>
    <rect x="12" y="126" width="236" height="20" fill="white" stroke="#7c3aed" stroke-width="0.6"/>
    <text x="18" y="140" font-size="9" font-family="monospace" fill="#4c1d95">[ 0,  0, ... ]</text>
    <text x="12" y="166" font-size="10" font-family="monospace" fill="#5b21b6">block_table.cpu (int32)</text>
    <rect x="12" y="172" width="236" height="20" fill="white" stroke="#7c3aed" stroke-width="0.6"/>
    <text x="18" y="186" font-size="9" font-family="monospace" fill="#4c1d95">行 0: [17,  0,  0, ...]</text>
    <text x="12" y="214" font-size="10" font-family="monospace" fill="#5b21b6">temperature, top_p, ... (SoA)</text>
    <rect x="12" y="220" width="236" height="20" fill="white" stroke="#7c3aed" stroke-width="0.6"/>
    <text x="18" y="234" font-size="9" font-family="monospace" fill="#4c1d95">[0.0, ...]   [1.0, ...]</text>
    <text x="130" y="262" text-anchor="middle" font-size="10" font-style="italic" fill="#5b21b6">CpuGpuBuffer：cpu + gpu + np</text>
    <text x="130" y="276" text-anchor="middle" font-size="10" font-style="italic" fill="#5b21b6">CPU 改值 → 一次 H2D</text>
  </g>
  <path d="M 580 188 L 620 188" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t7ar)"/>
  <text x="600" y="180" text-anchor="middle" font-size="9" fill="#64748b">_prepare_inputs</text>
  <g transform="translate(620, 44)">
    <rect x="0" y="0" width="240" height="288" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="120" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">forward tensor（本 step）</text>
    <text x="120" y="36" text-anchor="middle" font-size="10" fill="#0f766e">GPU 上，packed varlen 形状</text>
    <line x1="12" y1="44" x2="228" y2="44" stroke="#0d9488" stroke-width="0.6" stroke-dasharray="2,2"/>
    <text x="12" y="62" font-size="10" font-family="monospace" fill="#115e59">input_ids</text>
    <text x="20" y="76" font-size="10" font-family="monospace" fill="#0f766e">[a, b, c, d]</text>
    <text x="12" y="100" font-size="10" font-family="monospace" fill="#115e59">positions</text>
    <text x="20" y="114" font-size="10" font-family="monospace" fill="#0f766e">[0, 1, 2, 3]</text>
    <text x="12" y="138" font-size="10" font-family="monospace" fill="#115e59">cu_seqlens</text>
    <text x="20" y="152" font-size="10" font-family="monospace" fill="#0f766e">[0, 4]</text>
    <text x="12" y="176" font-size="10" font-family="monospace" fill="#115e59">slot_mapping</text>
    <text x="20" y="190" font-size="10" font-family="monospace" fill="#0f766e">[272, 273, 274, 275]</text>
    <text x="12" y="214" font-size="10" font-family="monospace" fill="#115e59">block_table</text>
    <text x="20" y="228" font-size="10" font-family="monospace" fill="#0f766e">[[17, 0, 0, ...]]</text>
    <text x="120" y="262" text-anchor="middle" font-size="10" font-style="italic" fill="#0f766e">不 pad、首尾平铺</text>
    <text x="120" y="276" text-anchor="middle" font-size="10" font-style="italic" fill="#0f766e">直接喂 FlashAttention</text>
  </g>
  <g transform="translate(20, 344)">
    <text x="0" y="14" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">三段式：</tspan>橙色（调度意图，Python）→ 紫色（持久状态，SoA + pinned/gpu/np 三视图）→ 青色（packed forward 张量，slot_mapping = block_id × 16 + pos%16 = 17 × 16 + 0..3 = 272..275）</text>
  </g>
</svg>
<span class="figure-caption">图 T7.1 ｜ SchedulerOutput 翻译成 forward tensor 的三段式：纯 Python 调度结果 → 持久 SoA InputBatch（启动时一次分配）→ 本 step 的 packed + cu_seqlens + slot_mapping 三件套</span>

<details>
<summary>ASCII 原版</summary>

```
SchedulerOutput (Python)         InputBatch (持久 SoA)              forward tensors (本 step)
─────────────────────────        ─────────────────────────         ───────────────────────────
num_scheduled_tokens             token_ids_cpu_tensor              input_ids:  [a,b,c,d]
  = {req#1: 4}              →    [行 0: a b c d 0 0 ...]      →    positions:  [0,1,2,3]
new_reqs = [                     num_computed_tokens_cpu           cu_seqlens: [0,4]
  NewRequestData(                [0, ...]                          slot_mapping:[272,273,274,275]
    "req#1",                     block_table.cpu                   block_table:[[17,0,0,...]]
    block_ids=([17],),           [行 0: 17 0 0 ...]
    prompt_ids=[a,b,c,d])
]
```

</details>

`_prepare_inputs` 最后返回 `(logits_indices, spec_decode_metadata)`：`logits_indices = query_start_loc[1:] - 1`（`gpu_model_runner.py:2102`）= `[3]`，告诉后续 sampler "只对位置 3（最后一个 token）算 logits"——prefill 的中间位置不需要采样。

## 6. 代码位置

入口顺序：

- `vllm/v1/worker/gpu_worker.py:783` —— `Worker.execute_model`，PP/DP 协调，转交给 ModelRunner
- `vllm/v1/worker/gpu_model_runner.py:3913` —— `GPUModelRunner.execute_model`
- `vllm/v1/worker/gpu_model_runner.py:3955` —— `_update_states(scheduler_output)`，把新 req 写入 InputBatch、把 block_ids 添加到 BlockTable.np（**还没 H2D**）
- `vllm/v1/worker/gpu_model_runner.py:1839` —— `_prepare_inputs` 主函数
- `vllm/v1/worker/gpu_model_runner.py:1665` —— `_prepare_input_ids`，H2D input_ids（含 async scheduling 路径）

数据结构：

- `vllm/v1/worker/gpu_input_batch.py:33` —— `CachedRequestState`：per-req Python 状态
- `vllm/v1/worker/gpu_input_batch.py:91-242` —— `InputBatch.__init__`：所有 SoA buffer 一次性分配
- `vllm/v1/worker/gpu_model_runner.py:708-755` —— GPUModelRunner 持久 forward buffer：`input_ids` / `positions` / `query_start_loc` / `seq_lens` / `req_indices` / `num_scheduled_tokens` 等
- `vllm/v1/utils.py:108-143` —— `CpuGpuBuffer`：cpu/gpu/np 三视图 + `copy_to_gpu`
- `vllm/v1/worker/block_table.py:18-220` —— `BlockTable`：(max_reqs × max_blocks) 持久缓冲 + `append_row`/`commit_block_table`/`compute_slot_mapping`
- `vllm/v1/worker/block_table.py:223-323` —— `MultiGroupBlockTable`：每个 KV cache group 一份 BlockTable

关键算法位置：

- `vllm/v1/worker/gpu_model_runner.py:1859` —— **先发** `commit_block_table` 让 H2D 跟下面 CPU 计算重叠
- `vllm/v1/worker/gpu_model_runner.py:1863-1893` —— numpy 算 req_indices / cu_num_tokens / positions
- `vllm/v1/worker/gpu_model_runner.py:1953-1959` —— `query_start_loc` 填值 + H2D（注意填到 `num_reqs+1:` 也得 pad）
- `vllm/v1/worker/gpu_model_runner.py:2060-2064` —— `compute_slot_mapping` 启 Triton kernel
- `vllm/v1/worker/block_table.py:325-380` —— `_compute_slot_mapping_kernel`：把绝对 position 翻译成物理 slot id

**推荐阅读顺序**：先看 `InputBatch.__init__`（理解持久 SoA 的全貌） → 再看 `GPUModelRunner.__init__` 的 `input_ids/positions/...` 那一段（forward 侧 tensor） → 再看 `_prepare_inputs` 主线 → 最后翻 `block_table.py` 看 slot_mapping 怎么算。

## 7. 分支与延伸

- **为什么 InputBatch 用 SoA + persistent buffer 而不是每 step 重建？** → 第 6 章 §5.1 [SoA 布局动机](06-worker-and-model-runner.md#651-soa-布局动机)、§5.2 [请求加入流程 ASCII](06-worker-and-model-runner.md#652-ascii请求加入流程)
- **`_update_states` 里 condense / 行复用具体逻辑？** → 第 6 章 §5.3 [请求移除与 `condense`](06-worker-and-model-runner.md#653-请求移除与-condense)、§4 [`GPUModelRunner` 的状态结构](06-worker-and-model-runner.md#64-gpumodelrunner-的状态结构)
- **CpuGpuBuffer 为什么这么设计？** → 第 6 章 §4.1 [持久 CPU/GPU 双 buffer：`CpuGpuBuffer`](06-worker-and-model-runner.md#641-持久-cpugpu-双-buffer-cpugpubuffer)、§4.2 [关键 buffer 列表](06-worker-and-model-runner.md#642-关键-buffer-列表)
- **BlockTable 的 hybrid block / kernel_block_size 是什么？** → 第 6 章 §6.2 [Hybrid block：`block_size != kernel_block_size`](06-worker-and-model-runner.md#662-hybrid-blockblock_size--kernel_block_size)、§6.3 [`compute_slot_mapping`：把绝对位置→物理 slot](06-worker-and-model-runner.md#663-compute_slot_mapping把绝对位置物理-slot)
- **整个 `_prepare_inputs` 的字段拼装详细分解？** → 第 6 章 §8.1 [拼装过程](06-worker-and-model-runner.md#681-拼装过程)、§8.2 [H2D 拷贝时机](06-worker-and-model-runner.md#682-h2d-拷贝时机)、§8.3 [`_prepare_input_ids` 与 async scheduling](06-worker-and-model-runner.md#683-_prepare_input_ids-与-async-scheduling)
- **async scheduling 下 `_prepare_input_ids` 的特殊路径？** → 第 6 章 §8.3；trace 主线是同步的，所以走 `gpu_model_runner.py:1684` 那条 fast path
- **chunked prefill / mixed prefill+decode batch 怎么拼？** → 同一份 _prepare_inputs 流程，`num_scheduled_tokens` 数组里同时有大值（prefill 部分 token）和 1（decode 各 1 token）。本步骤的代码路径完全相同，差别只是 cu_seqlens / positions 的具体数值。参考第 1 章 §2.2 [一步 step 是什么](01-architecture-overview.md#122-一步-step-是什么)
- **多模态：mrope_positions 是什么？** → 第 6 章 §4，搜 `mrope` 关键字（`gpu_model_runner.py:758-780`、`_calc_mrope_positions`）。主线 Qwen2.5-7B 是纯文本，不走这条路
- **TP/PP/DP 下这一步怎么变？** Worker 多份；input batch 在 rank 0 准备，DP 时还要 `coordinate_batch_across_dp`。→ 第 6 章 §11 微批/ubatching；第 10 章
- **整体在请求生命周期的位置？** → 第 1 章 §1.2 [一次推理请求的完整生命周期](01-architecture-overview.md#12-一次推理请求的完整生命周期)（"step 内部 forward 准备"）

## 8. 走完这一步你脑子里应该多了什么

1. **InputBatch 是持久 SoA**——在 LLM 启动时按 `max_num_reqs × max_model_len` 一次分好全部 CPU/GPU buffer，每 step 只往里填，从不重建。`CpuGpuBuffer` 是这套设计的物理载体（cpu + gpu + np 三视图）。
2. **forward 侧 tensor 用 packed + cu_seqlens 而不是 pad**——所有 request 的 token 平铺成一维，靠 `query_start_loc` 区分边界。这就是为什么 FlashAttention 接口长成 `(total_tokens, ...)` + `cu_seqlens_q` 这种 varlen 形状。
3. **`slot_mapping` 是 KV cache 写回的唯一坐标**——每个 token 有一个独立的 int64 槽位 id，由 `block_id × block_size + offset` 在 GPU 端 Triton kernel 里算出来。后面 attention 算完 KV 就按这个 mapping `scatter_` 到物理池。
4. **H2D 拷贝的时机被刻意编排**：block_table 第一时间发 H2D 跟 CPU numpy 计算重叠，input_ids 攒到最后一起发。"看似简单的张量准备"里藏着不少 latency hiding。
5. 走出本步时手里有：`input_ids`、`positions`、`query_start_loc`、`seq_lens`、`slot_mapping`、`block_table_tensor`——全在 GPU 上，全是 packed 形状，准备喂给下一步的 AttentionMetadata builder。
