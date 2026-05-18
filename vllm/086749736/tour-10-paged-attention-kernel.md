# Trace 步骤 10 —— 一次 PagedAttention kernel 到底干了什么？

> 整个 trace 里最技术、也最有 "vllm 味道" 的一步。
> PagedAttention 的全部精妙都浓缩在 attention layer 这一次 forward 里——KV cache 是非连续的，模型计算却不能跳出 SM 去拷贝；这是怎么做到的？

## 1. 当前情境

上一步走到了第 0 层的 `self.self_attn(positions=positions, hidden_states=hidden_states)`，手里：

- `hidden_states`：`[4, hidden_size]`，bf16，已经过 `input_layernorm`
- `positions`：`[0, 1, 2, 3]`
- forward context 里挂着本层的 `attn_metadata`（FlashAttentionMetadata）和 `kv_cache` 张量（shape `[2, num_blocks, block_size, num_kv_heads, head_size]`）；KV cache 此刻还是空的（第一次 prefill）
- `slot_mapping`：长度 4 的 int64，告诉本步 4 个新 token 各自要写到 KV cache 的哪个物理槽位

要看的是 `LlamaAttention.forward`（`vllm/model_executor/models/llama.py:223-233`）这 11 行：

```python
def forward(self, positions, hidden_states):
    qkv, _ = self.qkv_proj(hidden_states)
    q, k, v = qkv.split([self.q_size, self.kv_size, self.kv_size], dim=-1)
    q, k = self.rotary_emb(positions, q, k)
    attn_output = self.attn(q, k, v)
    output, _ = self.o_proj(attn_output)
    return output
```

## 2. 问题

PagedAttention 的 KV cache 按物理 block 离散分配——一个 request 的逻辑序列被切成若干 block，每个 block 在显存里可能位于任意位置（block table 把"逻辑 block id"映射到"物理 block id"）。第 6 步已经把这件事说清楚了。

但 attention kernel 算的是 `softmax(Q · K^T / sqrt(d)) · V`，它需要**遍历这个 request 历史上所有的 K、V**。它怎么读到这些离散物理块？

一次完整的 attention layer 内部其实有 5 件事：

1. `hidden_states → [Q | K | V]`（QKVParallelLinear）
2. 给 Q、K 加 RoPE
3. 把新算的 K、V 写到 KV cache 的指定 slot（slot_mapping 给位置）
4. 跑 attention kernel：读 Q、读历史 K/V（含刚写进去的），算 output
5. output 投回 hidden_size（o_proj）

关键是第 4 步怎么读非连续 KV，第 3 步怎么在不破坏 cache 物理布局的前提下写进去。

## 3. 朴素思路

启动 kernel 之前用 block table 把所有历史 block 拷成连续显存，喂给标准 FlashAttention：

```python
contiguous_k = torch.cat([kv_cache_k[bid] for bid in block_table[req_i]], dim=0)
contiguous_v = torch.cat([kv_cache_v[bid] for bid in block_table[req_i]], dim=0)
out = flash_attn(q, contiguous_k, contiguous_v)
```

干净、能复用任何标准 attention 实现。

## 4. 为什么朴素思路会崩

会把 PagedAttention 的意义抹没了：

- **KV 走两遍 HBM**：attention kernel 本来就要读 K、V 一次；先 gather 等于让 K、V 多走一次 HBM。HBM 带宽是 attention 在长序列下的瓶颈，多走一次直接砍掉一半性能
- **多分配 seq_len 同长度的连续显存**：长序列下这块 buffer 可能比 KV cache 池本身还显眼，OOM 风险陡增
- **抹掉 prefix cache 的好处**：PagedAttention + prefix cache 的精髓是"两个 request 共享同一个物理 block，永远不复制"；一旦每次 forward 都 gather 一份连续 KV，共享退化成"用同一份数据生成不同副本"

唯一可行方案是让 attention kernel **自己理解 block table**——在 inner loop 里 gather KV，而不是在外面做。

## 5. vllm 的做法

vllm 的 attention layer 是三层结构：

- **`LlamaAttention`**（`llama.py:124-233`）：模型侧 wrapper
- **`Attention`**（`vllm/model_executor/layers/attention/attention.py:177`）：公共 attention 层，持有 KV cache，选 backend
- **`FlashAttentionImpl`**（`vllm/v1/attention/backends/flash_attn.py:592`）：具体 backend，调真正的 kernel

### 5.1 QKVParallelLinear：fused 投影

`llama.py:164-172` 建 `self.qkv_proj`，继承自 `ColumnParallelLinear`（`vllm/model_executor/layers/linear.py:978`）。output_size 等于 `(num_heads + 2 * num_kv_heads) * head_dim`（linear.py:1039-1048）。

**为何 fused**：Q、K、V 共享同一个输入 `hidden_states`；分开做要读三次 input、启三次 kernel。合一份后只读一次、启一次 GEMM、一次写出 `[num_tokens, q_size + kv_size + kv_size]`，再用 `qkv.split(...)` 拆视图（zero-copy）。

**为何 column parallel**：output 维度按 head 切给各 TP rank；下游 attention 在 rank 本地完成；最后 `o_proj` 是 row parallel + all-reduce 合回去。整个 attention 内部不需要任何通信——只在头尾两处。

走完 qkv_proj 和 split：`q`（`[4, num_heads*head_dim]`）、`k`、`v`（`[4, num_kv_heads*head_dim]`）。

### 5.2 RoPE 作用在 Q、K 上

`llama.py:230`：`q, k = self.rotary_emb(positions, q, k)`。`get_rope(...)` 创建的 `RotaryEmbedding`，其 `forward_cuda`（`vllm/model_executor/layers/rotary_embedding/base.py:200-231`）调 `ops.rotary_embedding`——一个 in-place CUDA kernel（`csrc/pos_encoding_kernels.cu`），用 `positions` 查预算好的 `cos_sin_cache`（shape `[max_position, rotary_dim]`），把 Q、K 原地旋转。

**in-place** 是关键：返回的 `q, k` 是原张量，只是数值被改写——跟 RMSNorm 的 fused-in-place 同样是省一次张量分配。

### 5.3 进入 `Attention.forward`，拆成两个 custom op

`llama.py:231`：`attn_output = self.attn(q, k, v)`。

`Attention.forward`（attention.py:437-529）先分配空 `output`（attention.py:476-478），然后调两个 custom op（attention.py:489-528）：

```python
if not self.attn_backend.forward_includes_kv_cache_update and ... and key is not None and value is not None:
    kv_cache_dummy_dep = torch.ops.vllm.unified_kv_cache_update(key, value, encoded)
torch.ops.vllm.unified_attention_with_output(
    query, key, value, output, encoded,
    kv_cache_dummy_dep=kv_cache_dummy_dep,
)
```

为什么拆两个 op：一个写 cache（side effect: 改 `kv_cache`），一个算 attention（改 `output`）。它们之间有数据依赖（attention 要读到刚写进去的 K/V），但 torch.compile 默认不知道 custom op 间的依赖；通过 `kv_cache_dummy_dep` 这个空 tensor 串起来，让 inductor 不会把"算"重排到"写"之前。某些 backend（FlashInfer）能把两件事合到一个 kernel（`forward_includes_kv_cache_update = True`），就只有第二个 op；FlashAttention backend 是分开的。

### 5.4 写 cache：`reshape_and_cache_flash`

`vllm/model_executor/layers/attention/attention.py:691-714` 的 `unified_kv_cache_update` 从 forward context 取出 `kv_cache / slot_mapping`，调 `FlashAttentionImpl.do_kv_cache_update`（`flash_attn.py:850-883`）：

```python
reshape_and_cache_flash(key, value, key_cache, value_cache, slot_mapping,
                       self.kv_cache_dtype, layer._k_scale, layer._v_scale)
```

`reshape_and_cache_flash` 注册在 `csrc/torch_bindings.cpp:520-527`，实现是 `csrc/cache_kernels.cu::reshape_and_cache_flash_kernel`（cache_kernels.cu:303-352）。每个 CUDA block 处理一个 token，按 `slot_mapping[token_idx]` 算目标位置：

```cpp
const int64_t slot_idx = slot_mapping[token_idx];
if (slot_idx < 0) return;            // padding 跳过
const int64_t block_idx = slot_idx / block_size;
const int64_t block_offset = slot_idx % block_size;
cache_t* key_dst = key_cache + block_idx * block_stride + block_offset * page_stride;
cache_t* value_dst = value_cache + block_idx * block_stride + block_offset * page_stride;
```

**slot_mapping 是 scheduler 在第 7 步算好的**：对本步要算的每个 token，给一个"应该写到 cache 的哪个位置"的物理 slot id。kernel 看到的是平铺的 `slot_id`，自己除取模换算成 `(block_idx, offset)`。这一步**不读 block table**——slot_mapping 是 block table 的展开形式。

### 5.5 算 attention：`flash_attn_varlen_func` + `block_table`

`unified_attention_with_output`（attention.py:733-761）从 forward context 取出 `attn_metadata / kv_cache`，调 `FlashAttentionImpl.forward`（flash_attn.py:667-819）。核心调用（flash_attn.py:796-818）：

```python
flash_attn_varlen_func(
    q=query[:num_actual_tokens],
    k=key_cache,                  # 整个 cache，不是 gather 后的连续 K
    v=value_cache,                # kernel 自己按 block_table 去 gather
    out=output[:num_actual_tokens],
    cu_seqlens_q=cu_seqlens_q,
    max_seqlen_q=max_seqlen_q,
    seqused_k=seqused_k,
    max_seqlen_k=max_seqlen_k,
    softmax_scale=self.scale,
    causal=attn_metadata.causal,
    window_size=sliding_window_size,
    block_table=block_table,      # <-- 关键
    scheduler_metadata=scheduler_metadata,
    fa_version=self.vllm_flash_attn_version,
    ...
)
```

**这就是 PagedAttention 的真正发挥点**：
- `k`、`v` 是**整个 KV cache 池**（`[num_blocks, block_size, num_kv_heads, head_size]`）
- `block_table` 告诉 kernel "对第 i 个 request，它的逻辑 KV block 依次对应物理 block_id 是 block_table[i, 0..num_blocks_i]"
- FlashAttention 的 inner loop 在加载每个 block 的 K/V tile 到 SRAM 之前先查 block_table，得到物理 block_id 才知道读 HBM 上哪段地址
- **没有任何"先 gather 成连续显存"的步骤**——KV 从 HBM 直接进 SRAM，gather 索引由 kernel 自己做，不增加额外 HBM read/write

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="PagedAttention 的逻辑视图、block table 和物理 block 池">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="18" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">同一个 request 的 33 个 token：逻辑上连续，物理上散落</text>
  <text x="155" y="50" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">逻辑视角</text>
  <text x="155" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">query 看到的连续序列</text>
  <text x="22" y="92" font-size="11" fill="#64748b">block 0</text>
  <rect x="65" y="78" width="200" height="20" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="3"/>
  <text x="165" y="92" text-anchor="middle" font-size="10" fill="#9a3412">token 0 … 15（已满）</text>
  <text x="22" y="125" font-size="11" fill="#64748b">block 1</text>
  <rect x="65" y="111" width="200" height="20" fill="#99f6e4" stroke="#0d9488" stroke-width="1" rx="3"/>
  <text x="165" y="125" text-anchor="middle" font-size="10" fill="#115e59">token 16 … 31（已满）</text>
  <text x="22" y="158" font-size="11" fill="#64748b">block 2</text>
  <rect x="65" y="144" width="13" height="20" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" rx="2"/>
  <rect x="80" y="144" width="185" height="20" fill="none" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2" rx="2"/>
  <text x="172" y="158" text-anchor="middle" font-size="10" fill="#94a3b8">token 32 / 15 个空 slot 留给 decode</text>
  <text x="370" y="50" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">block table</text>
  <text x="370" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">per-request 的小数组</text>
  <g transform="translate(325, 75)">
    <rect x="0" y="0" width="90" height="100" fill="none" stroke="#cbd5e1"/>
    <rect x="0" y="0" width="90" height="22" fill="#f1f5f9"/>
    <text x="22" y="15" text-anchor="middle" font-size="10" fill="#64748b">逻辑 idx</text>
    <text x="68" y="15" text-anchor="middle" font-size="10" fill="#64748b">物理 #</text>
    <line x1="0" y1="22" x2="90" y2="22" stroke="#cbd5e1"/>
    <line x1="0" y1="48" x2="90" y2="48" stroke="#cbd5e1"/>
    <line x1="0" y1="74" x2="90" y2="74" stroke="#cbd5e1"/>
    <line x1="44" y1="22" x2="44" y2="100" stroke="#cbd5e1"/>
    <text x="22" y="40" text-anchor="middle" font-size="11" fill="currentColor">0</text>
    <text x="68" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">7</text>
    <text x="22" y="66" text-anchor="middle" font-size="11" fill="currentColor">1</text>
    <text x="68" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">2</text>
    <text x="22" y="92" text-anchor="middle" font-size="11" fill="currentColor">2</text>
    <text x="68" y="92" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">11</text>
  </g>
  <path d="M 270 88 L 322 100" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <path d="M 270 121 L 322 126" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <path d="M 270 154 L 322 152" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="600" y="50" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">物理 block 池</text>
  <text x="600" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">GPU 显存（16 个示意，其他被别的 request 占）</text>
  <g transform="translate(465, 75)">
    <g><rect x="0" y="0" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="30" y="15" text-anchor="middle" font-size="10" fill="#94a3b8">0</text></g>
    <g><rect x="68" y="0" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="98" y="15" text-anchor="middle" font-size="10" fill="#94a3b8">1</text></g>
    <g><rect x="136" y="0" width="60" height="22" fill="#0d9488" stroke="#0d9488"/><text x="166" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="white">2</text></g>
    <g><rect x="204" y="0" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="234" y="15" text-anchor="middle" font-size="10" fill="#94a3b8">3</text></g>
    <g><rect x="0" y="28" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="30" y="43" text-anchor="middle" font-size="10" fill="#94a3b8">4</text></g>
    <g><rect x="68" y="28" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="98" y="43" text-anchor="middle" font-size="10" fill="#94a3b8">5</text></g>
    <g><rect x="136" y="28" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="166" y="43" text-anchor="middle" font-size="10" fill="#94a3b8">6</text></g>
    <g><rect x="204" y="28" width="60" height="22" fill="#ea580c" stroke="#ea580c"/><text x="234" y="43" text-anchor="middle" font-size="11" font-weight="700" fill="white">7</text></g>
    <g><rect x="0" y="56" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="30" y="71" text-anchor="middle" font-size="10" fill="#94a3b8">8</text></g>
    <g><rect x="68" y="56" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="98" y="71" text-anchor="middle" font-size="10" fill="#94a3b8">9</text></g>
    <g><rect x="136" y="56" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="166" y="71" text-anchor="middle" font-size="10" fill="#94a3b8">10</text></g>
    <g><rect x="204" y="56" width="60" height="22" fill="#7c3aed" stroke="#7c3aed"/><text x="234" y="71" text-anchor="middle" font-size="11" font-weight="700" fill="white">11</text></g>
    <g><rect x="0" y="84" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="30" y="99" text-anchor="middle" font-size="10" fill="#94a3b8">12</text></g>
    <g><rect x="68" y="84" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="98" y="99" text-anchor="middle" font-size="10" fill="#94a3b8">13</text></g>
    <g><rect x="136" y="84" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="166" y="99" text-anchor="middle" font-size="10" fill="#94a3b8">14</text></g>
    <g><rect x="204" y="84" width="60" height="22" fill="#f1f5f9" stroke="#cbd5e1"/><text x="234" y="99" text-anchor="middle" font-size="10" fill="#94a3b8">15</text></g>
  </g>
  <path d="M 415 96 Q 440 96 700 86" fill="none" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1)" opacity="0.7"/>
  <path d="M 415 122 Q 440 110 632 78" fill="none" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1)" opacity="0.7"/>
  <path d="M 415 148 Q 440 148 700 142" fill="none" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar1)" opacity="0.7"/>
  <g transform="translate(40, 215)">
    <text x="0" y="0" font-size="12" fill="currentColor"><tspan font-weight="700" fill="#475569">读这张图：</tspan><tspan x="0" dy="18">attention kernel 拿到的是「整个物理 block 池」+「这个 request 的 block table」。</tspan>
      <tspan x="0" dy="18">它的 inner loop 在加载每个逻辑 block 的 K/V 之前，先查 block table[i] 取到物理 block 编号，</tspan>
      <tspan x="0" dy="18">再去物理池里那个位置读 KV——逻辑序列的"连续性"是 block table 这个一层间接表凭空造出来的。</tspan>
      <tspan x="0" dy="22" font-style="italic" fill="#94a3b8">同样的把戏在 OS 里叫做"页表 + MMU"。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 T10.1 ｜ block table 把逻辑连续的 KV 序列指向物理上离散的 block；attention kernel 通过查表完成 gather，不需要先拷成连续显存</span>

历史上 vllm v0 还有自己写的 `csrc/attention/paged_attention_v1.cu / paged_attention_v2.cu`，接口形态相同（`block_tables` 必传，paged_attention_v1.cu:169）。CUDA + bf16/fp16 主路径已迁到 FlashAttention v2/v3 / FlashInfer，因为后者 SRAM 利用率更高；v1/v2 现在主要给 ROCm / CPU / 某些量化路径用。

### 5.6 o_proj 与 N 层重复

`llama.py:232`：`output, _ = self.o_proj(attn_output)`。`o_proj` 是 `RowParallelLinear`，输入按 head 切给各 TP rank，输出 hidden_size；每个 rank 本地算自己头的输出，最后 all-reduce 合并。

回到 `LlamaDecoderLayer.forward`（llama.py:328-332）：继续 `post_attention_layernorm`（fused add + RMSNorm）→ `self.mlp(...)` → 返回 `(hidden_states, residual)`。

后续第 1、2、...、N-1 层重复同样的流程。所有 layer 通常**共享同一份 attn_metadata**（metadata 跟"输入张量布局"而非"层"绑定；只有 sliding window 之类差异才让某些层用不同 metadata）；但每层的 `Attention.kv_cache` 是**独立张量**。走完所有层，hidden_states 是最后一层输出，准备做 final norm（下一步）。

## 6. 代码位置

- 模型侧 wrapper：`vllm/model_executor/models/llama.py::LlamaAttention.forward`（llama.py:223-233）
- QKVParallelLinear：`vllm/model_executor/layers/linear.py::QKVParallelLinear`（linear.py:978-1061）
- RoPE：`vllm/model_executor/layers/rotary_embedding/base.py::RotaryEmbedding.forward_cuda`（base.py:200-231）
- 公共 attention 层：`vllm/model_executor/layers/attention/attention.py::Attention.forward`（attention.py:437-529）
- forward context 桥梁：`attention.py::get_attention_context`（attention.py:648-688）
- 两个 custom op：`attention.py::unified_kv_cache_update`（attention.py:691-714）+ `unified_attention_with_output`（attention.py:733-761）
- 写 cache：`vllm/v1/attention/backends/flash_attn.py::FlashAttentionImpl.do_kv_cache_update`（flash_attn.py:850-883）
- 算 attention：`flash_attn.py::FlashAttentionImpl.forward`（flash_attn.py:667-819）
- CUDA kernel：`csrc/cache_kernels.cu::reshape_and_cache_flash_kernel`（cache_kernels.cu:303-352）+ `csrc/torch_bindings.cpp:520-527`
- 历史 PagedAttention kernel：`csrc/attention/paged_attention_v1.cu::paged_attention_v1`（paged_attention_v1.cu:160-182）

**阅读顺序**：`LlamaAttention.forward` 整体感（11 行）→ `Attention.forward` 看"写 cache + 算 attention"拆两个 op → `unified_kv_cache_update` 看 forward context 查找模式 → `FlashAttentionImpl.do_kv_cache_update` + `reshape_and_cache_flash_kernel` 看一个 token 怎么落到一个 slot → `FlashAttentionImpl.forward` 看 `flash_attn_varlen_func` 的 `block_table` 参数 → 翻 `paged_attention_v1.cu` 感受老 kernel 怎么把 `block_tables` 当索引数组。

## 7. 分支与延伸

- **MLA（DeepSeek 系）**：`MLAAttention` 是另一条 layer 实现，KV cache 是"压缩 latent + 部分 RoPE 维度"，对应 `vllm/v1/attention/backends/mla/*` → 第 7 章 §11；第 8 章 §3 DeepSeek
- **FlashInfer backend**：把"写 cache + attention + sampling 后处理"链得更紧 → 第 7 章 §4
- **Triton backend**：纯 Triton 写的 attention kernel，跨平台 → 第 7 章 §11
- **GQA / MQA**：`num_kv_heads < num_heads`；QKVParallelLinear 的 output_sizes 自动反映，kernel 内部做 broadcast → 第 8 章 §4
- **量化 KV cache（fp8）**：`reshape_and_cache_flash_kernel` 的 `CopyWithScaleOp` 写入时量化（cache_kernels.cu:340-352）；attention kernel 通过 `k_descale / v_descale` 还原算 softmax → 第 11 章
- **CUDA graph 与 attention**：attention 是 piecewise graph 的裂缝——`get_attention_context` 的 host 字典查找不能进 graph，所以 `unified_attention_with_output` 整段在 eager 跑；graph 只 capture 前后的 fused block → 第 6 章 §11 + 第 7 章 §12
- **prefix cache** 与 PagedAttention 协同：两个 request 共享前缀时 block_table 前几行指向同一物理 block，kernel 不知道也不关心——只要 block_table 给出正确物理 id 就读得对 → 第 2 章 §3 + 第 5 章 §11
- **cascade attention**（flash_attn.py:821-847）：多个 request 共享一段长前缀时，"前缀 attention"和"私有 attention"拆两次 kernel 调用 → 第 7 章 §4
- **csrc 老 kernel 角色**：v1/v2 主要给 ROCm 和某些量化路径用，CUDA fp16/bf16 主路径已是 FlashAttention 3/4 → 第 7 章 §11

## 8. 走完这一步你脑子里应该多了什么

1. attention layer 是**三层结构**：`LlamaAttention` → `Attention` → `FlashAttentionImpl`；职责清晰：模型侧拼 QKV 和 RoPE，公共层挂 KV cache + 决定 backend，backend 调 kernel
2. KV cache 和 slot_mapping 都不在函数签名里——通过 **forward context** 按 `layer_name` 查找；这是 vllm "保持 model 代码干净 + 跟 backend 解耦"的核心 trick
3. **PagedAttention 的真正发挥点**是 `flash_attn_varlen_func` 收 `block_table` 作为参数，kernel 自己在 inner loop 里 gather KV——绝不在 Python 侧 gather 成连续显存，否则 HBM 带宽白白多走一次
4. 写 cache 用 `reshape_and_cache_flash`（按 `slot_mapping[token_idx]` 除取模算物理位置）；算 attention 用 `flash_attn_varlen_func` + `block_table`。两件事拆两个 custom op，靠 `kv_cache_dummy_dep` 串数据依赖让 torch.compile 不重排
5. QKVParallelLinear / RowParallelLinear 让整层 attention 内部零通信——只在入口和 o_proj 出口发生
