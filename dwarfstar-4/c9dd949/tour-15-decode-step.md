# Trace 步骤 15 —— 生成第二个 token，凭什么比 prefill 快这么多？

## 1. 当前情境

步骤 14 采样得到第 1 个生成 token（设为 token id `t1`）。
`run_sampled_generation` 的生成循环紧接着调用：

```c
// ds4_cli.c:528
if (ds4_session_eval(session, token, err, sizeof(err)) != 0) { ... }
```

此刻 `session.checkpoint.len`（即 `session.pos`）等于 prompt 的 token 数，
`session.logits` 里还存着步骤 13 算出的 prefill logits（将被覆盖）。KV 缓存里
已有 prefill 期间写入的所有 raw SWA 行和压缩器状态。

目标：把 `t1` 喂回模型，走完 43 层，把 `t1` 位置对应的 raw SWA 追加到缓存，
更新流式压缩器，然后算出下一个 token 的 logits，供步骤 14 的下一次迭代采样。

## 2. 问题

decode 要做的事和 prefill 本质相同：词嵌入 → 43 层 Transformer → logits 头。
但 decode 一次只处理**1 个 token**，而 prefill 可以一次处理多个。为什么 decode
每 token 的速度反而可以远快于 prefill 每 token 的均摊速度？

还有一个细节问题：压缩器在 prefill 时是批量填充状态的，到了 decode 时每次只来
1 个 token，如何保持与 prefill 路径语义一致的"流式"更新？

## 3. 朴素思路

最简单的想法：每次 decode 就是再走一遍和 prefill 完全相同的函数，只是把 prompt
替换成长度为 1 的"迷你 prompt"。KV 缓存追加完、新 logits 算出来，就完成了一步。

## 4. 为什么朴素思路会崩

朴素的"每次从头算注意力"是 O(pos²) 的复杂度——随着已生成 token 增多，每步
注意力要看的历史越来越长，速度线性下降。更重要的是：

- **不能复用已有 KV**：prefill 时已经算好了每个 prompt token 在每一层的 K/V
  投影，decode 时只要查表而不必重算。朴素方案每步都重算，等于把 prefill 的
  O(T) 工作再做一遍。
- **矩阵乘法维度完全不对**：prefill 中权重投影的批大小是 `n_tokens`，GPU 利用
  率高（tensor core 高效）；单 token 时批大小为 1，等于把一个向量乘矩阵，远小于
  GPU tensor core 的最优工作尺寸，效率天然低——这是 decode 的固有代价，但可以用
  Metal 流水线编码来摊薄 CPU 开销。

DwarfStar 4 的 decode 不是"重跑 prefill"，而是一条独立的、以 KV 缓存为中心的
单 token 热路径。

## 5. DwarfStar 4 的做法

decode 路径的核心是 **`metal_graph_encode_token_raw_swa`**（`ds4.c:10808`），
它把单步 decode 的全部计算编码进一个 Metal command buffer：

<svg viewBox="0 0 640 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Single-token decode pipeline: token embedding to HC state through 43 layers to logits output">
  <defs>
    <marker id="ar15a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="10" width="240" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="33" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">token id  t1</text>
  <line x1="320" y1="46" x2="320" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar15a)"/>
  <rect x="80" y="70" width="480" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ds4_gpu_embed_token_hc_tensor</text>
  <text x="320" y="102" text-anchor="middle" font-size="10" fill="#64748b">查 token_embd F16 表 → 初始 HC 状态 cur_hc（4×4096 float，4条HC流）</text>
  <line x1="320" y1="110" x2="320" y2="134" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar15a)"/>
  <rect x="200" y="134" width="240" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="152" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">cur_hc  [1×4×4096]</text>
  <line x1="320" y1="162" x2="320" y2="182" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar15a)"/>
  <rect x="50" y="182" width="540" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="200" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">for il = 0 .. 42  metal_graph_encode_decode_layer</text>
  <text x="320" y="218" text-anchor="middle" font-size="10" fill="#64748b">注意力子层：读 raw SWA 缓存，写新 raw_row = pos % raw_cap</text>
  <text x="320" y="234" text-anchor="middle" font-size="10" fill="#64748b">FFN/MoE 子层：HC pre/post，路由，专家，HC后</text>
  <text x="320" y="250" text-anchor="middle" font-size="10" fill="#64748b">swap cur_hc / after_ffn_hc</text>
  <line x1="320" y1="262" x2="320" y2="286" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar15a)"/>
  <rect x="180" y="286" width="280" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="303" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">cur_hc  [1×4×4096]  （走完43层）</text>
  <line x1="320" y1="314" x2="320" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar15a)"/>
  <rect x="50" y="338" width="540" height="30" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="354" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">metal_graph_encode_output_head  →  ds4_gpu_tensor_read</text>
  <line x1="320" y1="368" x2="320" y2="368" stroke="none"/>
  <text x="320" y="382" text-anchor="middle" font-size="10" fill="#64748b"/>
  <rect x="160" y="368" width="320" height="0" rx="0" fill="none"/>
</svg>
<span class="figure-caption">图 T15.1 ｜ 单 token decode 流水线：词嵌入 → HC初始化 → 43层注意力+FFN/MoE → 输出头 → session.logits</span>

<details>
<summary>ASCII 原版</summary>

```
token id t1
    |
    | ds4_gpu_embed_token_hc_tensor
    |   查 token_embd F16 表 → 初始 HC 状态 cur_hc (4×4096 float, 4条HC流)
    v
cur_hc  [1×4×4096]
    |
    | for il = 0..42:  metal_graph_encode_decode_layer
    |   每层：注意力子层（读 raw SWA 缓存，写新 raw_row = pos % raw_cap）
    |         + FFN/MoE 子层（HC pre/post，路由，专家，HC后）
    |   -> swap cur_hc / after_ffn_hc
    v
cur_hc  [1×4×4096]  (走完 43 层后)
    |
    | metal_graph_encode_output_head  (同步骤 13)
    v
logits  [129280 float]  (GPU → ds4_gpu_tensor_read → session.logits)
```

</details>

**与 prefill 的关键区别：KV 查表而非重算**

每一层的注意力只需要：
- 计算当前 token 的 Q 向量（新工作）；
- 从 raw SWA 缓存里读出已有的 K/V 行（之前算好的，直接查）；
- 计算 1×n_cached 的注意力分数矩阵（n_cached 最大 128 行）。

这就是 decode 比 prefill 快的根本原因：**已有 token 的 K/V 不需要重算**。
prefill 每个 token 都得算自己的 K/V 投影；decode 只算新 token 的 K/V，并立刻追加。

**raw SWA 追加**（`ds4.c:6389`）：

```c
// ds4.c:6389-6403
static void kv_cache_push_raw(ds4_layer_cache *cache, const float *kv) {
    if (cache->n_raw < cache->cap_raw) {
        // 缓存未满：直接追加到末尾
        float *dst = cache->raw_kv + (uint64_t)cache->n_raw * DS4_N_HEAD_DIM;
        for (uint32_t i = 0; i < DS4_N_HEAD_DIM; i++) dst[i] = f16_to_f32(f32_to_f16(kv[i]));
        cache->n_raw++;
        return;
    }
    // 缓存满（SWA 窗口 128 行）：整体左移一行，新行写在末尾
    memmove(cache->raw_kv,
            cache->raw_kv + DS4_N_HEAD_DIM,
            (size_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM * sizeof(cache->raw_kv[0]));
    float *dst = cache->raw_kv + (uint64_t)(cache->cap_raw - 1) * DS4_N_HEAD_DIM;
    ...
}
```

raw SWA 缓存容量为 `DS4_N_SWA = 128`（每层）。满了之后以 **滑动窗口** 方式运作：
最老一行被丢弃，新行写入末尾。GPU 路径中等效操作由 Metal 内核在
`metal_graph_encode_decode_layer` 内完成（写入 `raw_row = pos % raw_cap`），无需
memmove。

**流式压缩器更新**（`ds4.c:6512`）：

```c
// ds4.c:6512-6568
static bool compressor_decode_one(..., uint32_t pos) {
    const uint32_t pos_mod = pos % compress_ratio;
    const bool should_compress = ((pos + 1) % compress_ratio) == 0;
    // 1. 计算当前 token 的 kv_cur 和 sc_cur（通过 Q8_0 投影）
    // 2. 写入滚动状态窗口 state_kv[row], state_score[row]
    // 3. 若 pos+1 是 compress_ratio 的整数倍，则触发池化
    //    → 产生一行新的压缩 KV，追加到 comp_kv 缓冲
    if (!should_compress) return false;  // 未到边界，只更新状态
    compressor_pool_decode_state(pooled, state_kv, state_score, ...);
    // RMSNorm + RoPE + 量化 → out_comp
    return true;
}
```

压缩器以 `compress_ratio`（通常 2 或 4）个 token 为一组：每来一个 decode token
都更新状态窗口，但只在凑够一组时才产出一行压缩 KV 追加进压缩缓冲区。这和
prefill 时批量填充状态后再调 `kv_cache_finish_prefill_states` 的语义完全等价，
保证两条路径在相同 token 序列下产出相同的压缩 KV 行序列。

**Metal 命令提交**（`ds4.c:12775`）：

```c
// ds4.c:12775-12811
static bool metal_graph_eval_token_raw_swa(...) {
    bool ok = ds4_gpu_begin_commands() != 0;
    if (ok) ok = metal_graph_encode_token_raw_swa(g, model, weights,
                                                  token, pos, logits != NULL, true);
    // allow_split_flush=true: 编码前 4 层后先 flush 一次
    if (ok) ok = ds4_gpu_end_commands() != 0;
    if (ok && logits)
        ok = ds4_gpu_tensor_read(g->logits, 0, logits, DS4_N_VOCAB * sizeof(float)) != 0;
    return ok;
}
```

`allow_split_flush=true` 让 GPU 在编码完前 `split_after_layers=4` 层后提前
flush 一个命令缓冲区，使 GPU 在 CPU 继续编码剩余层的同时就开始执行——CPU/GPU
重叠流水线，进一步降低端到端延迟。

整体流程对比：

<svg viewBox="0 0 880 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Prefill vs decode comparison: computation differences for K/V projection, attention matrix, FFN, and time complexity">
  <defs>
    <marker id="ar15b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="420" height="260" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="2"/>
  <rect x="10" y="10" width="420" height="44" rx="8" fill="#0d9488"/>
  <rect x="10" y="44" width="420" height="10" fill="#0d9488"/>
  <text x="220" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">prefill（n tokens）</text>
  <text x="220" y="48" text-anchor="middle" font-size="11" fill="#99f6e4">本 trace n = 几个（完整 prompt）</text>
  <rect x="30" y="70" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="84" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">K/V 投影</text>
  <text x="220" y="99" text-anchor="middle" font-size="10" fill="#64748b">一次性算所有 n token 的 K/V 投影</text>
  <rect x="30" y="116" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">注意力矩阵</text>
  <text x="220" y="145" text-anchor="middle" font-size="10" fill="#64748b">n × n（批量计算）</text>
  <rect x="30" y="162" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="176" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FFN / MoE</text>
  <text x="220" y="191" text-anchor="middle" font-size="10" fill="#64748b">批量矩阵乘法，tensor core 高效</text>
  <rect x="30" y="208" width="380" height="36" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="220" y="222" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">耗时</text>
  <text x="220" y="238" text-anchor="middle" font-size="10" fill="#16a34a">耗时 ∝ n，每 token 均摊较低</text>
  <rect x="450" y="10" width="420" height="260" rx="8" fill="#f1f5f9" stroke="#ea580c" stroke-width="2"/>
  <rect x="450" y="10" width="420" height="44" rx="8" fill="#ea580c"/>
  <rect x="450" y="44" width="420" height="10" fill="#ea580c"/>
  <text x="660" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="white">decode（1 token）</text>
  <text x="660" y="48" text-anchor="middle" font-size="11" fill="#fed7aa">每步只生成一个新 token</text>
  <rect x="470" y="70" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="660" y="84" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">K/V 投影</text>
  <text x="660" y="99" text-anchor="middle" font-size="10" fill="#64748b">只算新 token 的 K/V 投影，旧 K/V 查表</text>
  <rect x="470" y="116" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="660" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">注意力矩阵</text>
  <text x="660" y="145" text-anchor="middle" font-size="10" fill="#64748b">1 × 128（单行查表，raw SWA 固定窗口）</text>
  <rect x="470" y="162" width="380" height="36" rx="4" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="660" y="176" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FFN / MoE</text>
  <text x="660" y="191" text-anchor="middle" font-size="10" fill="#64748b">向量乘矩阵（batch=1），效率较低</text>
  <rect x="470" y="208" width="380" height="36" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="660" y="222" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">耗时</text>
  <text x="660" y="238" text-anchor="middle" font-size="10" fill="#16a34a">耗时是常数，与已生成长度无关！</text>
</svg>
<span class="figure-caption">图 T15.2 ｜ prefill（n token 批量）与 decode（1 token）的对比：K/V复用是 decode 速度恒定的根本原因</span>

<details>
<summary>ASCII 原版</summary>

```
prefill (n tokens, 本 trace n=几个)        decode (1 token)
--------------------------------------     ---------------------------------
一次性算所有 token 的 K/V 投影             只算新 token 的 K/V 投影
注意力矩阵 n×n（批量）                    注意力矩阵 1×128（单行查表）
批量 FFN/MoE（tensor core 高效）           单 token FFN/MoE（向量乘矩阵）
对最后一行算 logits                        对唯一一行算 logits
耗时 ∝ n（每 token 均摊较低）              耗时是常数（与已生成长度无关！）
```

</details>

decode 每步耗时与已生成 token 数无关（raw SWA 固定 128 行，注意力扫描恒定），
这是滑动窗口缓存设计的核心收益。

## 6. 代码位置

按推荐阅读顺序：

- `ds4.h:177` —— `ds4_session_eval` 公开接口声明：把一个 token 喂回模型、推进会话。
- `ds4.c:17778` —— `ds4_session_eval`：委托 `ds4_session_eval_internal`。
- `ds4.c:17701` —— `ds4_session_eval_internal`：CPU 分支调 `forward_token_raw_swa_cpu_decode_scratch`；Metal 分支调 `metal_graph_eval_token_raw_swa`，再 `token_vec_push` 推进 checkpoint。
- `ds4.c:10808` —— `metal_graph_encode_token_raw_swa`：Metal decode 单步完整编码——词嵌入 HC → 43 层 → 输出头；生成热路径。
- `ds4.c:12775` —— `metal_graph_eval_token_raw_swa`：begin/encode/end/read 四步执行一次 Metal decode token，含 CPU/GPU split flush。
- `ds4.c:6389` —— `kv_cache_push_raw`：CPU 路径 raw SWA 追加一行（缓存未满则 append，满则滑动）。
- `ds4.c:6512` —— `compressor_decode_one`：流式压缩器更新——每 token 更新状态窗口，每 compress_ratio token 产出一行压缩 KV。
- `ds4.c:7701` —— `forward_token_raw_swa_cpu_decode_scratch`：CPU decode 全 43 层入口，使用预分配 scratch 避免 per-token malloc。

## 7. 分支与延伸

- Metal decode 单步 `metal_graph_encode_token_raw_swa` 内部的每层算子（注意力
  缓存读写、Q8_0 FFN 投影、HC pre/post）的 MTL shader 实现，参见
  [第 10 章 Metal 后端](10-metal-backend.md)。
- raw SWA 缓存的容量（128 行）、与压缩缓冲区的分工，以及 decode 时注意力如何
  同时查 raw SWA 和压缩 KV，参见
  [第 7 章 KV 缓存](07-kv-cache.md)。
- `ds4_session_eval` 完成后 `session.checkpoint` 更新、会话状态如何被 `session_sync`
  在后续请求中复用（磁盘 KV 缓存前缀匹配），参见
  [第 6 章 引擎与会话](06-engine-session.md)。
- `temperature <= 0` 时 `ds4_session_eval_speculative_argmax` 会在同一步同时
  触发 MTP 草稿预测，节省多个 token 的验证轮次，参见
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)。

## 8. 走完这一步你脑子里应该多了什么

1. decode 比 prefill 快的根本原因是 **KV 缓存复用**：已有 token 的 K/V 投影在
   prefill 时已算好并缓存，decode 每步只算 1 个新 token 的 K/V，注意力查表
   范围固定（raw SWA 最多 128 行），每步耗时与已生成长度无关。
2. **raw SWA 是滑动窗口**：容量 128 行，未满时 append，满了之后丢弃最老行并右
   移新行——GPU 路径以 `pos % raw_cap` 环形寻址，无需 memmove。
3. **流式压缩器以 compress_ratio 为节拍**：每个 decode token 都更新滚动状态
   窗口，只在凑够一组（2 或 4 个 token）时才输出一行压缩 KV，语义与 prefill
   路径完全等价。
4. Metal decode 热路径把词嵌入 → 43 层 → logits 头编码进单一 command buffer，
   并在前 4 层后插入 split flush，让 GPU 执行与 CPU 继续编码并行，摊薄延迟。
5. `ds4_session_eval` 本身只返回成功/失败，新 logits 写入 `session.logits`；
   `session.checkpoint` 的更新（`token_vec_push`）是"pos 推进"的真实载体，
   下次调 `ds4_session_sample` 读取的就是这次覆盖后的 logits。
