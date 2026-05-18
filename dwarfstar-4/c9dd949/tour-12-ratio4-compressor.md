# Trace 步骤 12 —— 1M 上下文，KV 缓存怎么不把内存撑爆？

## 1. 当前情境

步骤 10 和 11 完成了层内注意力与 FFN 的计算。现在从"单层内部"再退一步，关注整个
prefill 阶段最重要的副作用：**KV 缓存的填充过程**。

步骤 09 说每个 token 推进完所有 43 层时都在"填 raw SWA + 压缩器状态"，但没有细讲
这个"填"具体做了什么。本步补上这块拼图。

当 `./ds4 -m DS4.gguf -p "你好" -n 3` 执行完 prefill 后，每个压缩层的 `ds4_layer_cache`
里会有：

- `raw_kv`：最近 `DS4_N_SWA = 128`（`ds4.c:103`）个 position 的 KV 向量（滑窗）。
- `attn_comp_kv`：按 compress_ratio 聚合后的"压缩行"，每行代表一段历史 token 的
  信息蒸馏。
- `attn_state_kv` / `attn_state_score`：压缩窗口的滚动状态（ratio 个槽位），
  用于下一次压缩。
- 对 ratio-4 层：还有 `index_comp_kv`、`index_state_kv`、`index_state_score`——
  专为 indexer 服务的第二套压缩行。

## 2. 问题

DS4 的目标上下文是 1,048,576 token（约 1M）。若朴素地为每个 token 存一条完整 KV，
内存开销是：

```
1,048,576 token × 43 层 × 512 维 × 4 字节(f32) = 92 GiB
```

这已经超过绝大多数本地推理设备的显存和内存上限。更重要的是，注意力计算的时间
复杂度是 `O(seq_len)`（每个 decode token 要与所有历史 KV 做点积），1M 序列下
每一步 decode 都要扫描 1M 行，耗时不可接受。

这一步要回答：DS4 怎么在 1M 上下文下把 KV 缓存的内存和注意力扫描代价都压到可用范围？

## 3. 朴素思路

最常见的两种朴素解法：

1. **固定窗口（Sliding Window Attention, SWA）**：只保留最近 W 个 token 的 KV，
   超出的丢弃。窗口外的信息完全丢失，长程依赖能力为零。
2. **全量存储 + 稀疏注意力**：存下所有 KV，但注意力时只看部分行（如每 k 行取一行）。
   内存问题没解决，只是减少了注意力计算量。

这两种做法都是在"精确性"和"效率"之间做妥协，要么丢精度，要么不省内存。

## 4. 为什么朴素思路会崩

**纯 SWA 的精度崩**：语言模型经常需要引用文章开头的信息（文档标题、对话角色设定、
API 调用结果）。窗口外的 token 如果直接丢弃，这些长程依赖全部断掉，模型生成质量
会显著下降——在"你好"这条 3-token 请求里感受不到，但在实际应用中这是核心缺陷。

**全量 KV 的内存崩**：1M × 43 层 × 512 dim × f32 = 92 GiB，就算用 fp16 也是 46 GiB，
超过 M4 Max MacBook Pro 的 128 GB 统一内存的 1/3，还没算模型权重本身（>100 GiB）。

**稀疏注意力的计算崩**：即便是每 4 行跳一行的稀疏注意力，1M 长度下仍有 250K 行需要
点积，每层每 token 250K × 512 = 128M FLOPs，43 层 = 5.5G FLOPs/token，比 FFN 还贵。

## 5. DwarfStar 4 的做法

DS4 用的是**分层双轨 KV 缓存**：每一层同时维护一个 raw 滑窗（近期精确 KV）和一组
压缩行（远期信息蒸馏），两者在注意力时合并计算。

### 轨道一：raw 滑动窗口

```text
每个 token t（position = pos）:
   kv[pos] = layer_kv_projection_normed_one(token_t)
   kv_cache_push_raw(cache, kv[pos])          (ds4.c:6390)
```

`raw_kv` 是一个最多存 `DS4_N_SWA = 128` 行的环形缓冲区（`ds4.c:6177`）。满了之后
`memmove` 把最旧一行移出，最新一行追加到末尾（`ds4.c:6398`）。注意力时这 128 行全部
参与点积，代价恒定不随上下文长度增长。

### 轨道二：压缩行（软最大池化）

压缩行由**压缩器**流式生成，每处理 `compress_ratio` 个 token 产生一个压缩行。
层的 compress_ratio 由 `ds4_layer_compress_ratio(il)` 决定（`ds4.c:411`）：

- `il < 2`：ratio = 0，不压缩（dense 层，无压缩行）。
- `il` 为偶数且 `≥ 2`：ratio = 4（ratio-4 层，含 indexer）。
- `il` 为奇数且 `≥ 2`：ratio = 128（ratio-128 层，无 indexer）。

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Compressor decode one: per-token projection and per-group softmax pooling pipeline">
  <defs>
    <marker id="ar12a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="740" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">every token（position = pos）</text>
  <text x="380" y="50" text-anchor="middle" font-size="11" fill="#64748b">调用 compressor_decode_one(out_comp, ...)  ds4.c:6514</text>
  <line x1="380" y1="60" x2="380" y2="85" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="80" y="85" width="260" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="210" y="100" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">投影 kv_cur = attn_compressor_kv(x)</text>
  <text x="210" y="115" text-anchor="middle" font-size="10" fill="#64748b">F16,  4096 → 512 / 1024</text>
  <rect x="420" y="85" width="260" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="550" y="100" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">投影 sc_cur = attn_compressor_gate(x)</text>
  <text x="550" y="115" text-anchor="middle" font-size="10" fill="#64748b">F16,  4096 → 512 / 1024</text>
  <line x1="210" y1="121" x2="210" y2="145" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <line x1="550" y1="121" x2="550" y2="145" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="160" y="145" width="440" height="30" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="156" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">sc_cur += APE[j, pos_mod]   （绝对位置嵌入）</text>
  <text x="380" y="169" text-anchor="middle" font-size="10" fill="#64748b">写入 state_kv[pos_mod]  /  state_score[pos_mod]</text>
  <line x1="380" y1="175" x2="380" y2="195" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3"/>
  <text x="380" y="208" text-anchor="middle" font-size="10" fill="#94a3b8">每 compress_ratio 个 token（即 (pos+1) % ratio == 0 时）触发</text>
  <line x1="380" y1="213" x2="380" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="60" y="228" width="640" height="50" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="248" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">compressor_pool_decode_state(...)   ds4.c:6457</text>
  <text x="380" y="265" text-anchor="middle" font-size="11" fill="#64748b">per-dimension softmax 池化：out[j] = Σ exp(score_r[j]−max_r)·kv_r[j]  /  Σ exp(score_r[j]−max_r)</text>
  <line x1="380" y1="278" x2="380" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="140" y="298" width="140" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="210" y="316" text-anchor="middle" font-size="11" fill="currentColor">RMSNorm（学习权重）</text>
  <rect x="310" y="298" width="140" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="316" text-anchor="middle" font-size="11" fill="currentColor">RoPE（comp_pos）</text>
  <rect x="480" y="298" width="140" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="550" y="311" text-anchor="middle" font-size="11" fill="currentColor">FP8 量化（attn）</text>
  <text x="550" y="323" text-anchor="middle" font-size="10" fill="#64748b">QAT（indexer）</text>
  <line x1="210" y1="326" x2="380" y2="354" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <line x1="380" y1="326" x2="380" y2="354" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <line x1="550" y1="326" x2="380" y2="354" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12a)"/>
  <rect x="200" y="354" width="360" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="369" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">kv_cache_push_comp → attn_comp_kv</text>
  <text x="380" y="383" text-anchor="middle" font-size="10" fill="#64748b">ds4.c:6405</text>
</svg>
<span class="figure-caption">图 T12.1 ｜ 压缩器 compressor_decode_one 的单 token 流程：投影→位置嵌入→状态窗口→每 ratio 触发 softmax 池化→量化→写入压缩行</span>

<details>
<summary>ASCII 原版</summary>

```
every token (position = pos):
   compressor_decode_one(out_comp, ...)       (ds4.c:6514)
   |
   +-- 投影 kv_cur = attn_compressor_kv(x)  [F16, 4096 → 512 or 1024]
   +-- 投影 sc_cur = attn_compressor_gate(x) [F16, 4096 → 512 or 1024]
   +-- sc_cur += APE[j, pos_mod]              (绝对位置嵌入，窗口内位置 j)
   +-- 写入 state_kv[pos_mod]  /  state_score[pos_mod]
   |
   每 compress_ratio 个 token（即 (pos+1) % ratio == 0 时）:
     +-- compressor_pool_decode_state(...)    (ds4.c:6457)
     |     per-dimension softmax 池化：
     |     out[j] = sum_r( exp(score_r[j] - max_r) * kv_r[j] )
     |              / sum_r( exp(score_r[j] - max_r) )
     +-- RMSNorm（有学习权重）
     +-- RoPE（作用于压缩行的代表位置 comp_pos）
     +-- FP8 量化（attn 维度）/ QAT 量化（indexer 维度）
     +-- kv_cache_push_comp → attn_comp_kv   (ds4.c:6405)
```

</details>

池化的关键在于**逐维度 softmax**，而非对整行做 softmax。每个维度 `j` 独立做一次
归一化的加权平均：哪个 token 在这个维度上 gate 分数最高，它的 KV 值在这个维度上
贡献就越大。这保留了每个维度最"显眼"的信息，而不是简单平均。

对 ratio-4 层（ds4.c:6471），还有"主副双通道"：state 行数是 ratio × 2，前 ratio
行是上一窗口的旧状态，后 ratio 行是当前窗口的新状态，池化时两套都参与，让压缩行
更稳定。

<svg viewBox="0 0 760 210" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="KV cache accumulation timeline: raw sliding window and compressed rows for ratio=4">
  <defs>
    <marker id="ar12b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="24" font-size="13" font-weight="700" fill="currentColor">压缩行积累图（ratio=4，ctx_size=1024）</text>
  <text x="20" y="52" font-size="11" fill="#64748b">pos:</text>
  <text x="55" y="52" font-size="10" fill="#64748b">0</text>
  <text x="90" y="52" font-size="10" fill="#64748b">4</text>
  <text x="130" y="52" font-size="10" fill="#64748b">8</text>
  <text x="250" y="52" font-size="10" fill="#64748b">127</text>
  <text x="330" y="52" font-size="10" fill="#64748b">128</text>
  <text x="450" y="52" font-size="10" fill="#64748b">256</text>
  <text x="680" y="52" font-size="10" fill="#64748b">1023</text>
  <line x1="50" y1="57" x2="730" y2="57" stroke="#cbd5e1" stroke-width="1"/>
  <text x="20" y="90" font-size="11" font-weight="600" fill="currentColor">raw:</text>
  <rect x="50" y="68" width="250" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="175" y="87" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">最近 128 行（滑动窗口）</text>
  <line x1="308" y1="82" x2="730" y2="82" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="740" y="86" font-size="10" fill="#94a3b8">→</text>
  <text x="20" y="135" font-size="11" font-weight="600" fill="currentColor">comp:</text>
  <rect x="50" y="110" width="60" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="80" y="126" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">c0</text>
  <text x="80" y="138" text-anchor="middle" font-size="9" fill="#64748b">0..3</text>
  <rect x="120" y="110" width="60" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="150" y="126" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">c1</text>
  <text x="150" y="138" text-anchor="middle" font-size="9" fill="#64748b">4..7</text>
  <rect x="190" y="110" width="60" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="220" y="126" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">c2</text>
  <text x="220" y="138" text-anchor="middle" font-size="9" fill="#64748b">8..11</text>
  <text x="265" y="128" font-size="12" fill="#94a3b8">···</text>
  <rect x="290" y="110" width="60" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="320" y="128" text-anchor="middle" font-size="11" fill="currentColor">c31</text>
  <text x="265" y="170" font-size="10" fill="#94a3b8">每 4 token 产出 1 个压缩行</text>
  <text x="380" y="128" font-size="12" fill="#94a3b8">···</text>
  <rect x="410" y="110" width="60" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="440" y="128" text-anchor="middle" font-size="11" fill="currentColor">c64</text>
  <text x="490" y="128" font-size="12" fill="#94a3b8">···</text>
  <rect x="660" y="110" width="66" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="693" y="128" text-anchor="middle" font-size="11" fill="currentColor">c255</text>
  <text x="20" y="185" font-size="10" fill="#94a3b8">ratio=4：1024 token → 256 个压缩行；ratio=128：1024 token → 8 个压缩行</text>
</svg>
<span class="figure-caption">图 T12.2 ｜ ratio=4 时 raw 滑窗与压缩行的时间轴布局：每 4 个 token 产出一个压缩行 c_i，raw 始终保留最近 128 行</span>

<details>
<summary>ASCII 原版</summary>

```
压缩行积累图（ratio=4 为例，ctx_size=1024）：

pos:  0  1  2  3  4  5  6  7  8  9 ...  127  128  129 ... 1023
raw:  [---最近128行---]  滑动
comp: c0          c1          c2          ...              c255
      (0..3平均)  (4..7平均)  (8..11平均) ...
```

</details>

ratio-128 层每 128 个 token 才产出一个压缩行，1M token 只有约 8K 个压缩行，
内存占用可忽略不计。ratio-4 层每 4 个 token 产出一个压缩行，1M token 约 250K 行，
这就需要 indexer 进一步筛选。

### ratio-4 层的 indexer（`ds4.c:6941`）

ratio-4 层维护第二套压缩结构（`index_comp_kv`），其维度更小（`DS4_N_INDEXER_HEAD_DIM = 128`
而非 512）。注意力时，indexer 用一个轻量注意力机制，从所有 `n_comp` 个压缩行中
选出最相关的 `DS4_N_INDEXER_TOP_K = 512` 行（`ds4.c:6955`），返回一个 `bool[]` 允许掩码。
主注意力只与被允许的压缩行做点积，未被选中的行得分被强制设为 `DS4_NEG_INF`。

indexer 的选择流程：

<svg viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Indexer selection pipeline: from cur and qr_norm to top-512 allowed mask">
  <defs>
    <marker id="ar12c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="31" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">cur [4096]</text>
  <rect x="380" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="480" y="31" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">qr_norm [1024]</text>
  <line x1="480" y1="42" x2="480" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="310" y="72" width="340" height="32" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="480" y="88" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">matvec(indexer_attn_q_b, qr_norm)</text>
  <text x="480" y="98" text-anchor="middle" font-size="10" fill="#64748b">→ q [64 × 128]</text>
  <line x1="480" y1="104" x2="480" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="360" y="128" width="240" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="480" y="147" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">RoPE(q, pos)</text>
  <line x1="480" y1="156" x2="480" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="300" y="180" width="360" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="480" y="194" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">dsv4_indexer_qat_rows_inplace_cpu(q)</text>
  <text x="480" y="205" text-anchor="middle" font-size="10" fill="#64748b">QAT 量化激活</text>
  <line x1="160" y1="42" x2="160" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="60" y="250" width="200" height="32" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="160" y="266" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">matvec(indexer_proj, cur)</text>
  <text x="160" y="278" text-anchor="middle" font-size="10" fill="#64748b">→ weights [64]</text>
  <line x1="480" y1="208" x2="480" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <line x1="260" y1="266" x2="310" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <line x1="480" y1="250" x2="450" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="120" y="290" width="400" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="309" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">score[c] = Σ_h max(dot(q_h, index_comp[c]), 0) × weights[h]</text>
  <text x="320" y="326" text-anchor="middle" font-size="10" fill="#64748b">对所有 n_comp 个压缩行 c 计算</text>
  <line x1="320" y1="334" x2="320" y2="358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12c)"/>
  <rect x="160" y="358" width="320" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="376" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">top-512 by score</text>
  <text x="320" y="391" text-anchor="middle" font-size="11" fill="#64748b">→ allowed[n_comp]  布尔掩码</text>
</svg>
<span class="figure-caption">图 T12.3 ｜ indexer 选 top-512 压缩行的流程：双路输入（cur+qr_norm）→ Q投影+RoPE+QAT量化 + weights投影 → 点积打分 → top-512 允许掩码</span>

<details>
<summary>ASCII 原版</summary>

```
cur [4096], qr_norm [1024]
   |
   matvec(indexer_attn_q_b, qr_norm) → q [64 × 128]
   |
   RoPE(q, pos)
   |
   dsv4_indexer_qat_rows_inplace_cpu(q)   ← QAT 量化激活
   |
   matvec(indexer_proj, cur) → weights [64]
   |
   for each comp row c:
     score[c] = sum_h( max(dot(q_h, index_comp[c]), 0) * weights[h] )
   |
   top-512 by score → allowed[n_comp]
```

</details>

整个 indexer 前向用的是小维度（128 vs 512），计算量远小于主注意力。

### prefill 后重建 ratio-4 压缩器状态（`ds4.c:10904`）

prefill 是批量矩阵矩阵乘，但压缩器的滚动状态（`attn_state_kv`/`attn_state_score`）
是流式的，不能直接由批量 matmul 恢复。因此 prefill 结束后，`metal_graph_refresh_ratio4_compressor_state()`
用 prefill 序列的**最后 4 个 token**重新跑一遍 small-batch 投影，精确恢复滚动窗口的
中间状态，使后续 decode 阶段的压缩器能接续正确的位置。

完整的双轨 KV 缓存结构图：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_layer_cache memory layout for ratio-4 layer: raw_kv, attn compression, and indexer compression fields">
  <defs>
    <marker id="ar12d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="740" height="44" rx="8" fill="#ea580c" stroke="#ea580c" stroke-width="1"/>
  <text x="380" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="white">ds4_layer_cache（ratio-4 层，如 il=2）</text>
  <text x="380" y="46" text-anchor="middle" font-size="11" fill="#fed7aa">三轨结构：raw 滑窗 ＋ attn 压缩行 ＋ indexer 压缩行</text>
  <line x1="60" y1="54" x2="60" y2="96" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="74" x2="80" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12d)"/>
  <rect x="80" y="62" width="630" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="300" y="78" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">raw_kv  [128 行 × 512]</text>
  <text x="560" y="78" text-anchor="middle" font-size="11" fill="#64748b">最近 128 token，浮点精度，注意力时全部参与</text>
  <line x1="60" y1="96" x2="60" y2="180" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="116" x2="80" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12d)"/>
  <rect x="80" y="104" width="630" height="76" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="260" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">attn_comp_kv  [n_comp × 512]</text>
  <text x="530" y="122" text-anchor="middle" font-size="11" fill="#64748b">压缩行（ratio=4 聚合），FP8 量化</text>
  <line x1="110" y1="126" x2="110" y2="156" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="142" x2="125" y2="142" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar12d)"/>
  <rect x="125" y="134" width="270" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="260" y="149" text-anchor="middle" font-size="10" fill="currentColor">attn_state_kv [8 × 512]  当前窗口滚动状态（ratio × 2 行）</text>
  <line x1="110" y1="156" x2="125" y2="156" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar12d)"/>
  <rect x="125" y="152" width="270" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="260" y="167" text-anchor="middle" font-size="10" fill="currentColor">attn_state_score [8 × 512]  当前窗口 gate 分数（同布局）</text>
  <line x1="60" y1="180" x2="60" y2="260" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="60" y1="200" x2="80" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12d)"/>
  <rect x="80" y="188" width="630" height="76" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="260" y="206" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">index_comp_kv  [n_comp × 128]</text>
  <text x="530" y="206" text-anchor="middle" font-size="11" fill="#64748b">indexer 压缩行，QAT 量化，dim=128</text>
  <line x1="110" y1="210" x2="110" y2="240" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="226" x2="125" y2="226" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar12d)"/>
  <rect x="125" y="218" width="260" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="255" y="233" text-anchor="middle" font-size="10" fill="currentColor">index_state_kv [8 × 128]  indexer 滚动状态</text>
  <line x1="110" y1="240" x2="125" y2="240" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar12d)"/>
  <rect x="125" y="236" width="260" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="255" y="251" text-anchor="middle" font-size="10" fill="currentColor">index_state_score [8 × 128]  indexer gate 分数</text>
  <rect x="10" y="285" width="230" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="125" y="301" text-anchor="middle" font-size="10" fill="#64748b">raw_kv：f32，256 KiB</text>
  <text x="125" y="315" text-anchor="middle" font-size="10" fill="#64748b">注意力时全量参与点积</text>
  <rect x="260" y="285" width="230" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="375" y="301" text-anchor="middle" font-size="10" fill="#64748b">attn_comp：FP8，≈122 MiB（1M ctx）</text>
  <text x="375" y="315" text-anchor="middle" font-size="10" fill="#64748b">indexer top-512 掩码筛选后参与</text>
  <rect x="510" y="285" width="240" height="40" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="630" y="301" text-anchor="middle" font-size="10" fill="#64748b">index_comp：QAT，≈30 MiB（1M ctx）</text>
  <text x="630" y="315" text-anchor="middle" font-size="10" fill="#64748b">仅供 indexer 打分，dim=128</text>
</svg>
<span class="figure-caption">图 T12.4 ｜ ds4_layer_cache（ratio-4 层）三轨内存布局：raw 滑窗、attn 压缩行（FP8）与 indexer 压缩行（QAT），以及各自的滚动状态槽</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_layer_cache (ratio-4 层，如 il=2)
|
+-- raw_kv [128 行 × 512]      最近 128 token，浮点精度，注意力时全用
|
+-- attn_comp_kv [n_comp × 512]  压缩行（ratio=4 聚合），FP8 量化
|   attn_state_kv   [8 × 512]    当前窗口滚动状态（ratio × 2 行）
|   attn_state_score [8 × 512]   当前窗口 gate 分数（同布局）
|
+-- index_comp_kv [n_comp × 128]  indexer 压缩行，QAT 量化
    index_state_kv   [8 × 128]    indexer 滚动状态
    index_state_score [8 × 128]   indexer gate 分数
```

</details>

内存核算（1M 上下文，ratio-4 层）：

| 组件 | 大小 |
|------|------|
| raw_kv（f32） | 128 × 512 × 4 = 256 KiB |
| attn_comp_kv（FP8，约1字节/dim） | 250K × 512 × 1 ≈ 122 MiB |
| index_comp_kv（QAT，约1字节/dim） | 250K × 128 × 1 ≈ 30 MiB |
| 滚动状态（f32） | 8 × 512 × 2 × 4 ≈ 32 KiB |
| **单层合计** | **约 152 MiB** |

43 层全算（并非每层都是 ratio-4，ratio-128 层更省）整体约 **2-4 GiB**，相比朴素
92 GiB 缩减约 **20-40 倍**。

## 6. 代码位置

按阅读顺序：

- `ds4.c:6331` —— `kv_cache_init()`：分配 per-layer KV state，包括 raw 滑窗、
  attn 压缩行、ratio-4 indexer 压缩行，容量按 `ctx_size / ratio + 2` 计算。
- `ds4.c:6457` —— `compressor_pool_decode_state()`：per-dimension softmax 池化核心，
  ratio-4 层有主副双通道；ratio-128 层只有单通道。
- `ds4.c:6512` —— `compressor_decode_one()`：流式压缩器主函数，处理单 token：
  投影、加 APE、写状态槽、在 ratio 边界触发池化、RMSNorm、RoPE、量化、push comp。
- `ds4.c:6941` —— `indexer_allowed_decode_one()`：indexer 选 top-512 压缩行，
  返回 `bool[]` 允许掩码，供 `layer_attention_mixed_one()` 屏蔽不相关的压缩行。
- `ds4.c:7005` —— `indexer_allowed_decode_one_decode_scratch()`：decode 热路径
  版本，使用预分配 scratch 缓冲区，避免 malloc。
- `ds4.c:10904` —— `metal_graph_refresh_ratio4_compressor_state()`：prefill 后
  用最后 4 个 token 重跑 small-batch 投影，精确恢复 ratio-4 滚动窗口状态。

## 7. 分支与延伸

- `ds4_layer_cache` 结构的完整字段定义、内存布局与生命周期 →
  [第 7 章 KV 缓存](07-kv-cache.md)
- 注意力时 raw + 压缩行如何混合（`layer_attention_mixed_one()`）与 sink logit
  的协同工作 → [第 8 章 注意力子层](08-attention.md)
- ratio 分配规则（`ds4_layer_compress_ratio()`）与 DS4 的层布局设计 →
  [第 2 章 模型结构](02-model-architecture.md)
- Metal 后端的压缩器实现与 CPU 参考实现的差异（GPU kernel vs CPU 循环）→
  [第 7 章 KV 缓存](07-kv-cache.md)
- decode 阶段的压缩器流式更新：每生成一个 token 就调用一次压缩器，与 prefill
  的批量版本行为一致 → [第 8 章 注意力子层](08-attention.md)

## 8. 走完这一步你脑子里应该多了什么

1. DS4 的 KV 缓存是**双轨**的：raw 滑窗保证最近 128 token 的精确注意力，
   压缩行保证超出窗口的长程信息不丢失，两者在注意力时拼接为一个 KV 序列。
2. 压缩器的核心是**逐维度 softmax 池化**（而非简单平均）：每个 KV 维度独立做
   加权平均，权重由学习的 gate 分数决定，最"显眼"的 token 贡献最多。
3. ratio-4 层有一个轻量 **indexer**：从最多 250K 个压缩行中用小维度（128）注意力
   选出 top-512，主注意力只看这 512 行，把 O(n_comp) 的扫描代价降到 O(512)。
4. prefill 后必须用最后 4 个 token **重建**压缩器的滚动状态，因为批量 matmul
   的 FP 舍入顺序与流式路径不同，不重建会导致 decode 时压缩窗口状态不连续。
5. 量化贯穿压缩行全程：attn 压缩行用 FP8（约 1 bit/dim）、indexer 压缩行用 QAT
   量化，使 1M 上下文的压缩行内存从数十 GiB 降到约 2-4 GiB。
