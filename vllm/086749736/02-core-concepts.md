# 第 2 章 核心概念与算法理论

本章不讲实现，只讲“为什么”。LLM 推理引擎的所有工程复杂度——分块的 KV、迭代级调度、前缀复用、分段 prefill、推测解码、量化、CUDA Graph、张量/流水/专家并行——都是为了在显存与算力两个硬约束下，最大化吞吐 (throughput) 与最小化时延 (latency)。在 vLLM 中这些机制是耦合在一起协同工作的，而它们的耦合点恰恰是后续章节展开实现时的钩子。

> 阅读约定：每个小节按 *动机 → 算法/数学 → vLLM 中的入口* 三段式编排；具体源码会在第 5 章 (Scheduler)、第 6 章 (KV Cache Manager)、第 7 章 (Attention Backends)、第 8 章 (Spec Decode)、第 9 章 (Quantization)、第 10 章 (CUDA Graph & Compile)、第 11 章 (Distributed) 展开。

---

## 2.1 Transformer 自回归推理：prefill 与 decode 两阶段

### 2.1.1 自回归的算子结构

decoder-only Transformer 在生成第 $t$ 个 token 时，需要计算：

$$
h_t^{(l+1)} = \mathrm{Attn}\!\big(Q_t,\, [K_{1..t}, V_{1..t}]\big) \;\rightarrow\; \mathrm{FFN}(\cdot)
$$

其中 $Q_t, K_t, V_t = W_{Q,K,V} h_t^{(l)}$。注意 $K_{1..t-1}, V_{1..t-1}$ 已经在生成前序 token 时算过；只要把它们缓存下来，每生成一个新 token 时就只需算 $Q_t, K_t, V_t$ 一行，再做一次「1 × t」的注意力点积。这就是 **KV cache** 的存在意义（详见 §2.2）。

### 2.1.2 两阶段：prefill vs decode

一次请求的生命周期被天然地划分为两个阶段：

| 阶段 | 输入 token 数 | Attention shape (per layer) | 主要瓶颈 |
|---|---|---|---|
| **prefill** | $L$（全部 prompt） | $Q\in\mathbb R^{L\times d},\ K,V\in\mathbb R^{L\times d}$ | **compute-bound** |
| **decode**  | 1（新 token） | $Q\in\mathbb R^{1\times d},\ K,V\in\mathbb R^{(L+t)\times d}$ | **memory-bound** |

为何差异巨大？以 GEMM 的 *arithmetic intensity* (FLOPs / Bytes) 衡量。设 batch 中 prefill 的 token 数为 $T_p$，hidden size 为 $d$，head dim 为 $d_h$，layer 数 $N$，权重总参数 $P$。前向一次的近似量级：

- 权重读取： $\Theta(P)$ bytes（只读一次，被整 batch 摊销）
- 算术： $\Theta(2 \cdot P \cdot T_p)$ FLOPs

所以 intensity $\approx 2 T_p$ FLOPs/Byte。对 A100 (FP16 算力 312 TFLOPS，HBM 1.5 TB/s) 而言，平衡点约 $\sim 200$ FLOPs/Byte。换句话说：**只要 batch 内待计算的 token 数 $T_p \gtrsim 100$，就跨入 compute-bound 区域；否则永远卡在 memory-bound**。

- **prefill**：$T_p = L$ 通常 $\geq$ 几百到几千，纯粹算力受限。GPU 的 SM 在 GEMM 上接近 100% 利用率，HBM 反而闲着。
- **decode**：每请求只贡献 1 个 token，即使 batch 内 $B$ 个请求同时 decode， $T_p = B$。在 $B < 100$ 时，每生成一个 token 都要把全部权重 ($P$ bytes) 从 HBM 搬一次，吞吐被显存带宽锁死。

这一不对称是后续所有调度决策的基础：
- **continuous batching** (§2.4) 通过把多请求 decode 合到一个 batch 提高 $B$，向 compute-bound 靠拢。
- **chunked prefill** (§2.6) 把长 prefill 切碎，让一个 batch 同时容纳「decode 们 + 一小段 prefill」，既不让 prefill 排空 decode 也不让 decode 浪费带宽。
- **speculative decoding** (§2.7) 把 decode 阶段“一次只算 1 个 token”改成“一次验证 $k$ 个 token”，等效把 decode 推向 compute-bound。

### 2.1.3 vLLM 中的入口

- 调度器对两阶段统一抽象、不做硬区分：`vllm/v1/core/sched/scheduler.py:329` (`Scheduler.schedule`)，注释明确写 *"There's no decoding phase nor prefill phase in the scheduler"*。
- 每请求的进度通过 `num_computed_tokens` 单调递增，每次调度只往前推进一个 token chunk。
- 这一抽象与论文 [Orca, OSDI'22] 的「iteration-level scheduling」一致。

参考：
- Vaswani et al., *Attention Is All You Need*, NeurIPS 2017.
- NVIDIA, *Roofline Model*, https://docs.nvidia.com/deeplearning/performance/dl-performance-gpu-background/index.html

---

## 2.2 KV cache 的本质

### 2.2.1 为何必须缓存

对 layer $l$、head $h$，每 token 的 K / V 是
$$
K_t^{(l,h)} = W_K^{(l,h)} h_t^{(l)}, \quad V_t^{(l,h)} = W_V^{(l,h)} h_t^{(l)}
$$
它只依赖该 token 的 hidden state，不依赖未来 token；而每生成一个 token 都要拿当前 $Q_t$ 跟所有历史 $K_{1..t-1}$ 做点积。若不缓存，第 $t$ 步的 attention 复杂度是 $O(t \cdot d)$，整段 decode $O(L\cdot T \cdot d)$；缓存后变为 $O(d)$ 每步、$O(T \cdot d)$ 总量（不含历史扫描），代价是 $O((L+T) \cdot d)$ 显存。这是 attention 之外不可避免的状态。

### 2.2.2 单 token 的显存占用

每 token、每 layer、每个 KV head 占 $d_h$ 个元素，又因为 K 与 V 两份：

$$
\text{bytes/token} = 2 \cdot N_{\text{layer}} \cdot N_{\text{kv\_head}} \cdot d_h \cdot \text{dtype\_size}
$$

例：LLaMA-3-8B，$N=32, N_{\text{kv\_head}}=8, d_h=128$，bf16 = 2 bytes：

$$
2 \times 32 \times 8 \times 128 \times 2 = 131{,}072\ \text{bytes} = 128\ \text{KiB / token}
$$

对 8K 上下文，一条序列约 1 GiB；A100-80GB 减去权重 $\approx$ 16 GiB 后，剩余约 60 GiB，理论只能容下 60 条满长度序列。这种「KV 容量」就是吞吐量的天花板。

### 2.2.3 Naive 实现的浪费：内部 + 外部碎片

vLLM 之前的主流实现（HF Transformers、FasterTransformer、早期 TGI）把每条序列的 KV 存为一段 *连续* 显存。两类碎片都很严重：

- **内部碎片 (internal fragmentation)**：必须按 `max_seq_len` 预留，未生成的部分被锁死。LLM 生成长度方差极大，平均利用率往往 < 40%。
- **外部碎片 (external fragmentation)**：每条序列要求显存物理连续，频繁的请求到达/完成导致空洞碎片化，新请求难以找到足够大的连续块。
- **无法共享**：相同 prefix（system prompt、few-shot 示例）的多条请求必须各存一份。

PagedAttention (§2.3) 通过把 KV cache 拆成定长 block + 间接表，把利用率从 ~40% 拉到 > 96%。

<svg viewBox="0 0 880 410" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Naive KV cache vs PagedAttention 利用率对比">
  <defs>
    <pattern id="waste" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#fca5a5" stroke-width="2"/>
    </pattern>
  </defs>
  <g transform="translate(20, 14)">
    <text x="200" y="0" text-anchor="middle" font-size="14" font-weight="700" fill="#dc2626">Naive：per-request 连续预留</text>
    <text x="200" y="18" text-anchor="middle" font-size="11" fill="#94a3b8">每条请求按 max_len 锁死一大块连续显存</text>
    <text x="0" y="50" font-size="11" font-weight="600" fill="#475569">Request A</text>
    <text x="0" y="64" font-size="9" fill="#94a3b8">实际用 600 / 预留 2048</text>
    <g transform="translate(80, 38)">
      <rect x="0" y="0" width="111" height="28" fill="#ea580c"/>
      <rect x="111" y="0" width="269" height="28" fill="url(#waste)" stroke="#fca5a5" stroke-width="1"/>
      <text x="55" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="white">used</text>
      <text x="245" y="18" text-anchor="middle" font-size="10" fill="#b91c1c">wasted (1448 tokens 锁死，不可借)</text>
    </g>
    <text x="0" y="105" font-size="11" font-weight="600" fill="#475569">Request B</text>
    <text x="0" y="119" font-size="9" fill="#94a3b8">实际用 1900 / 预留 2048</text>
    <g transform="translate(80, 93)">
      <rect x="0" y="0" width="352" height="28" fill="#0d9488"/>
      <rect x="352" y="0" width="28" height="28" fill="url(#waste)" stroke="#fca5a5" stroke-width="1"/>
      <text x="176" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="white">used (1900 tokens, 用得满)</text>
    </g>
    <text x="0" y="160" font-size="11" font-weight="600" fill="#dc2626">Request C ✗</text>
    <text x="0" y="174" font-size="9" fill="#dc2626">想进来，要 2048</text>
    <g transform="translate(80, 148)">
      <rect x="0" y="0" width="380" height="28" fill="none" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="6,3"/>
      <text x="190" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="#dc2626">被拒收 ✗（剩余空间够，但不连续）</text>
    </g>
    <rect x="0" y="205" width="400" height="50" fill="#fef2f2" stroke="#fca5a5" rx="4"/>
    <text x="200" y="225" text-anchor="middle" font-size="12" font-weight="700" fill="#991b1b">总利用率 (600+1900) / (2048×2) ≈ 61%</text>
    <text x="200" y="244" text-anchor="middle" font-size="11" fill="#7f1d1d">且 C 拿不到资源——长度方差大时此数字常 &lt; 40%</text>
  </g>
  <line x1="450" y1="20" x2="450" y2="370" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <g transform="translate(465, 14)">
    <text x="200" y="0" text-anchor="middle" font-size="14" font-weight="700" fill="#16a34a">PagedAttention：共享 block 池</text>
    <text x="200" y="18" text-anchor="middle" font-size="11" fill="#94a3b8">所有 request 从同一个 block 池借 16-token 的小块</text>
    <g transform="translate(20, 38)">
      <text x="0" y="0" font-size="10" fill="#64748b">物理 block 池（32 个示意，4 × 8）</text>
      <g transform="translate(0, 12)">
        <rect x="0" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="44" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="88" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="132" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="176" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="220" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="264" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="308" y="0" width="42" height="32" fill="#0d9488"/>
      </g>
      <g transform="translate(0, 48)">
        <rect x="0" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="44" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="88" y="0" width="42" height="32" fill="#ea580c"/>
        <rect x="132" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="176" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="220" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="264" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="308" y="0" width="42" height="32" fill="#0d9488"/>
      </g>
      <g transform="translate(0, 84)">
        <rect x="0" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="44" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="88" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="132" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="176" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="220" y="0" width="42" height="32" fill="#0d9488"/>
        <rect x="264" y="0" width="42" height="32" fill="#7c3aed"/>
        <rect x="308" y="0" width="42" height="32" fill="#7c3aed"/>
      </g>
      <g transform="translate(0, 120)">
        <rect x="0" y="0" width="42" height="32" fill="#7c3aed"/>
        <rect x="44" y="0" width="42" height="32" fill="#7c3aed"/>
        <rect x="88" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
        <rect x="132" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
        <rect x="176" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
        <rect x="220" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
        <rect x="264" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
        <rect x="308" y="0" width="42" height="32" fill="#f1f5f9" stroke="#cbd5e1"/>
      </g>
    </g>
    <g transform="translate(20, 200)">
      <rect x="0" y="0" width="16" height="12" fill="#ea580c"/>
      <text x="22" y="11" font-size="10" fill="currentColor">A (8 块)</text>
      <rect x="80" y="0" width="16" height="12" fill="#0d9488"/>
      <text x="102" y="11" font-size="10" fill="currentColor">B (14 块)</text>
      <rect x="170" y="0" width="16" height="12" fill="#7c3aed"/>
      <text x="192" y="11" font-size="10" fill="currentColor">C (4 块, 顺利进来)</text>
      <rect x="285" y="0" width="16" height="12" fill="#f1f5f9" stroke="#cbd5e1"/>
      <text x="307" y="11" font-size="10" fill="currentColor">free (6 块)</text>
    </g>
    <rect x="0" y="225" width="400" height="50" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="200" y="245" text-anchor="middle" font-size="12" font-weight="700" fill="#166534">总利用率 26/32 ≈ 81%（在真实负载下常 > 96%）</text>
    <text x="200" y="264" text-anchor="middle" font-size="11" fill="#14532d">C 顺利分到 4 块且不要求连续——外部碎片彻底消失</text>
  </g>
</svg>
<span class="figure-caption">图 R2.1 ｜ 同样的 3 个 request、同样的 GPU 显存：naive 因「按 max_len 连续预留」浪费严重并拒收 C；PagedAttention 按 16-token 小块切分，所有 request 都装得下还有富余</span>

<details>
<summary>ASCII 原版</summary>

```
请求 A (max_len=2048, 实际生成 600)
[ used 600 | reserved 1448                                ]
请求 B (max_len=2048, 实际生成 1900)
[ used 1900 | reserved 148                                ]
请求 C 想进来，要 2048 连续空间……
[ used 600 | XXX | used 1900 | XX ]   <- 剩余空间总和够，但不连续 -> 拒收
```

</details>

### 2.2.4 vLLM 中的入口

- `KVCacheSpec` 描述「单层 KV 一个 block 的字节数」：`vllm/v1/kv_cache_interface.py:101` (`block_size`)，`vllm/v1/kv_cache_interface.py:106` (`page_size_bytes`)。
- 总显存预算估算：见第 6 章。

---

## 2.3 PagedAttention：从虚拟内存到分块 KV

### 2.3.1 动机：操作系统的虚拟内存

OS 的虚拟内存解决了与 KV cache 完全同构的问题：进程要求连续地址，物理内存却碎片化。OS 的方案是：
1. 把地址空间切成定长 **page**；
2. 通过 **page table** 把虚拟页号映射到任意位置的物理页；
3. 多进程可以通过让 page table 项指向同一物理页实现 **共享**（fork、shared library、COW）。

PagedAttention [Kwon et al., SOSP'23] 把这套机制原样搬到 KV cache：把每层 KV 缓存切成定长 **block**（vLLM 默认 16 token / block），每条请求维护一张 **block table** 把逻辑 block 号映射到物理 block 号。

### 2.3.2 数据结构

物理 KV cache pool 每层一张大张量按 block 划分；每个 request 一行 block table，把逻辑块号映射到物理块号。两条 request 的 block table 行指向同一个物理块就实现了 **prefix sharing**（§2.5）。

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="物理 KV cache pool 和 block table 的双层结构示意">
  <defs>
    <marker id="r22ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">PagedAttention 的双层结构：block table（逻辑） + 物理 block 池（GPU 显存）</text>
  <text x="40" y="56" font-size="12" font-weight="600" fill="currentColor">① 物理 KV cache pool（每 layer 一张大张量）</text>
  <text x="40" y="72" font-size="10" fill="#94a3b8">shape = [num_blocks, block_size=16, num_kv_heads, head_dim]，每个 block 装 16 个 token</text>
  <g transform="translate(40, 84)">
    <text x="0" y="14" font-size="11" fill="#64748b">K cache</text>
    <rect x="55" y="0" width="80" height="22" fill="#ea580c" stroke="#9a3412"/>
    <text x="95" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 0</text>
    <rect x="138" y="0" width="80" height="22" fill="#ea580c" stroke="#9a3412"/>
    <text x="178" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 1</text>
    <rect x="221" y="0" width="80" height="22" fill="#0d9488" stroke="#115e59"/>
    <text x="261" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 2</text>
    <rect x="304" y="0" width="80" height="22" fill="#0d9488" stroke="#115e59"/>
    <text x="344" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 3</text>
    <rect x="387" y="0" width="80" height="22" fill="#7c3aed" stroke="#5b21b6"/>
    <text x="427" y="15" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 4</text>
    <rect x="470" y="0" width="80" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="510" y="15" text-anchor="middle" font-size="10" fill="#94a3b8">block 5</text>
    <rect x="553" y="0" width="80" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="593" y="15" text-anchor="middle" font-size="10" fill="#94a3b8">…</text>
    <text x="0" y="46" font-size="11" fill="#64748b">V cache</text>
    <rect x="55" y="32" width="80" height="22" fill="#ea580c" stroke="#9a3412" opacity="0.85"/>
    <text x="95" y="47" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 0</text>
    <rect x="138" y="32" width="80" height="22" fill="#ea580c" stroke="#9a3412" opacity="0.85"/>
    <text x="178" y="47" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 1</text>
    <rect x="221" y="32" width="80" height="22" fill="#0d9488" stroke="#115e59" opacity="0.85"/>
    <text x="261" y="47" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 2</text>
    <rect x="304" y="32" width="80" height="22" fill="#0d9488" stroke="#115e59" opacity="0.85"/>
    <text x="344" y="47" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 3</text>
    <rect x="387" y="32" width="80" height="22" fill="#7c3aed" stroke="#5b21b6" opacity="0.85"/>
    <text x="427" y="47" text-anchor="middle" font-size="10" font-weight="700" fill="white">block 4</text>
    <rect x="470" y="32" width="80" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="510" y="47" text-anchor="middle" font-size="10" fill="#94a3b8">block 5</text>
    <rect x="553" y="32" width="80" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="593" y="47" text-anchor="middle" font-size="10" fill="#94a3b8">…</text>
    <text x="650" y="20" font-size="10" fill="#94a3b8">物理</text>
    <text x="650" y="34" font-size="10" fill="#94a3b8">块号 →</text>
  </g>
  <text x="40" y="180" font-size="12" font-weight="600" fill="currentColor">② Block table（每 request 一行，把逻辑块号映射到物理块号）</text>
  <g transform="translate(40, 200)">
    <text x="0" y="14" font-size="10" fill="#94a3b8">logical idx →</text>
    <rect x="90" y="0" width="50" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="115" y="15" text-anchor="middle" font-size="10" fill="#64748b">0</text>
    <rect x="140" y="0" width="50" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="165" y="15" text-anchor="middle" font-size="10" fill="#64748b">1</text>
    <rect x="190" y="0" width="50" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="215" y="15" text-anchor="middle" font-size="10" fill="#64748b">2</text>
    <rect x="240" y="0" width="50" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="265" y="15" text-anchor="middle" font-size="10" fill="#64748b">3</text>
    <rect x="290" y="0" width="50" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="315" y="15" text-anchor="middle" font-size="10" fill="#64748b">4</text>
    <text x="0" y="44" font-size="11" font-weight="600" fill="#9a3412">request A</text>
    <rect x="90" y="30" width="50" height="22" fill="#fed7aa" stroke="#ea580c"/>
    <text x="115" y="45" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">0</text>
    <rect x="140" y="30" width="50" height="22" fill="#fed7aa" stroke="#ea580c"/>
    <text x="165" y="45" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">1</text>
    <rect x="190" y="30" width="50" height="22" fill="#99f6e4" stroke="#0d9488"/>
    <text x="215" y="45" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">2</text>
    <rect x="240" y="30" width="50" height="22" fill="#99f6e4" stroke="#0d9488"/>
    <text x="265" y="45" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">3</text>
    <rect x="290" y="30" width="50" height="22" fill="#fff" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="315" y="45" text-anchor="middle" font-size="10" fill="#94a3b8">—</text>
    <text x="0" y="74" font-size="11" font-weight="600" fill="#9a3412">request B</text>
    <rect x="90" y="60" width="50" height="22" fill="#fed7aa" stroke="#ea580c"/>
    <text x="115" y="75" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">0</text>
    <rect x="140" y="60" width="50" height="22" fill="#fed7aa" stroke="#ea580c"/>
    <text x="165" y="75" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">1</text>
    <rect x="190" y="60" width="50" height="22" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="215" y="75" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">4</text>
    <rect x="240" y="60" width="50" height="22" fill="#fff" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="265" y="75" text-anchor="middle" font-size="10" fill="#94a3b8">—</text>
    <rect x="290" y="60" width="50" height="22" fill="#fff" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="315" y="75" text-anchor="middle" font-size="10" fill="#94a3b8">—</text>
    <g transform="translate(360, 30)">
      <rect x="0" y="0" width="270" height="52" fill="#fef3c7" stroke="#f59e0b" stroke-width="1" rx="4"/>
      <text x="135" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">A 和 B 行的前两列都是 0、1</text>
      <text x="135" y="38" text-anchor="middle" font-size="10" fill="#a16207">两个 request 共享物理 block 0 / 1 = prefix sharing</text>
    </g>
  </g>
  <path d="M 115 230 L 80 130" fill="none" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r22ar)" opacity="0.65"/>
  <path d="M 165 230 L 178 130" fill="none" stroke="#ea580c" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r22ar)" opacity="0.65"/>
  <path d="M 215 230 L 250 130" fill="none" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r22ar)" opacity="0.65"/>
  <path d="M 215 260 L 410 130" fill="none" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r22ar)" opacity="0.65"/>
  <g transform="translate(40, 335)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">块内 slot 索引：</tspan><tspan x="0" dy="18">逻辑 token 位置 p 落在第 ⌊p/B⌋ 个逻辑块的第 (p mod B) 个 slot。查 block table 得到物理块号 phys，</tspan>
      <tspan x="0" dy="18">最终 slot index = phys × B + (p mod B)。这就是 attention kernel 的 <tspan font-family="monospace" font-weight="700">slot_mapping</tspan>，写入位置一次确定，</tspan>
      <tspan x="0" dy="18">kernel 在 inner loop 里按这个表 gather KV，绝不在 Python 侧先拷成连续显存（这是 PagedAttention 的精髓）。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R2.2 ｜ 物理 KV pool 是连续大张量按 block 切分；每个 request 的 block table 记录"逻辑块 → 物理块"的映射，两条 request 行指向同一物理块即 prefix 共享</span>

<details>
<summary>ASCII 原版</summary>

```
KV pool (per layer):
            ┌────────────┬────────────┬────────────┬─── ... ──┐
 K cache:   │  block 0   │  block 1   │  block 2   │          │   shape =
            │ (16 toks)  │ (16 toks)  │ (16 toks)  │          │  [num_blocks,
            └────────────┴────────────┴────────────┴──────────┘   block_size,
            ┌────────────┬────────────┬────────────┬─── ... ──┐   num_kv_heads,
 V cache:   │  block 0   │  block 1   │  block 2   │          │   head_dim]
            └────────────┴────────────┴────────────┴──────────┘

                      logical block idx
                  ┌────┬────┬────┬────┬────┐
 request_A row -> │ 17 │  3 │ 42 │ 88 │  - │
 request_B row -> │ 17 │  3 │ 91 │  - │  - │   <- A、B 共享前两块 (前缀)
 request_C row -> │  5 │ 12 │ 67 │ 21 │ 33 │
                  └────┴────┴────┴────┴────┘
```

物理块号 17、3 在 A、B 行同时出现：这就是 **prefix sharing**（§2.5）。

</details>

#### 块内布局与 slot

逻辑 token 位置 $p$ 在第 $\lfloor p / B \rfloor$ 个逻辑块的第 $(p \bmod B)$ 个 slot；查表后得到物理块号 `phys`，最终 slot index = `phys * B + (p % B)`。这个 slot index 即为 attention kernel 的 `slot_mapping`，写入位置一次确定。

### 2.3.3 分块 attention 计算

朴素 attention：$O = \mathrm{softmax}(QK^\top / \sqrt{d_h}) V$。
PagedAttention 把 $K, V$ 按 block 分散，对每个 block 单独做 attention，再用 [FlashAttention 风格的 log-sum-exp 重组] 拼接：

$$
\ell_i = \log\!\sum_j e^{s_{ij} - m_i}, \quad
o_i = \frac{\sum_b e^{m^{(b)}_i - m_i^*}\,o^{(b)}_i \cdot \ell^{(b)}_i}{\sum_b e^{m^{(b)}_i - m_i^*}\,\ell^{(b)}_i}
$$

这意味着 kernel 不要求 KV 物理连续——它接受 `(block_table, slot_mapping)` 然后逐块取数。

### 2.3.4 内存利用率的数学说明

设序列长度服从分布 $\mathcal D$，最大长度 $L_{\max}$，block 大小 $B$。

- **Naive (预留)** 利用率：$\mathbb E_{L\sim\mathcal D}[L] / L_{\max}$。常 < 0.4。
- **PagedAttention** 内部碎片仅来自每条序列最后一个未填满的 block：$\le B - 1$ token。平均利用率：

$$
\eta_{\text{paged}} = \frac{\mathbb E[L]}{\mathbb E[L] + (B-1)/2} \;\longrightarrow\; 1 \text{ 当 } \mathbb E[L] \gg B
$$

vLLM 默认 $B=16$，对均长 1024 的工作负载利用率约 99.3%。论文报告端到端 **吞吐量提升 2–4×**。

### 2.3.5 与 Copy-on-Write

并行采样 (`n>1`, beam search) 时多个候选共享 prompt：父序列的所有 block 设为只读共享；某个候选要写入新 token 而该 block 还被别人引用时，触发 CoW——分配新 block、复制旧内容、更新本候选的 block table。这与 OS fork 的 CoW 完全同构。

### 2.3.6 vLLM 中的入口

- block 池：`vllm/v1/core/block_pool.py`，核心类 `BlockPool` 与哈希索引 `BlockHashToBlockMap:34`。
- 自由块队列（双向链表 LRU）：`vllm/v1/core/kv_cache_utils.py` 的 `FreeKVCacheBlockQueue`。
- KV cache 管理器：`vllm/v1/core/kv_cache_manager.py:236` (`allocate_slots`)、`:221` (`find_longest_cache_hit`)。
- worker 端 block table（GPU 上的 int32 矩阵）：`vllm/v1/worker/block_table.py:18` (`class BlockTable`)。
- attention kernel 接入：`vllm/v1/attention/backends/flash_attn.py:592` (`FlashAttentionImpl`)，传入 `block_table` + `slot_mapping`。

参考：
- Kwon, Li, Zhuang et al., *Efficient Memory Management for Large Language Model Serving with PagedAttention*, SOSP 2023.
- Dao et al., *FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness*, NeurIPS 2022.

---

## 2.4 Continuous batching：迭代级调度

### 2.4.1 Static batching 的弊病

经典 batching：凑齐 $B$ 条请求 → 同时跑完整生成 → 全部返回 → 凑下一批。

两大问题：
1. **队头阻塞 (HOL)**：最长那条请求决定 batch 退出时间，期间整个 batch 锁定。
2. **slot 浪费**：短请求生成完后该 slot 闲置；新请求进不来。

### 2.4.2 Continuous batching（又名 iteration-level / in-flight batching）

Orca [Yu et al., OSDI'22] 提出的核心思想：**调度粒度从「一批请求的完整生成」改为「一次 forward step」**。

每次 step 之后：
- 已完成的请求立刻离开 batch；
- 新到的请求立刻被加入下一 step；
- batch 维度在每个 step 可以动态变化。

<svg viewBox="0 0 880 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Static batching 与 Continuous batching 的时序对比">
  <defs>
    <pattern id="r23waste" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#fca5a5" stroke-width="2"/>
    </pattern>
    <marker id="r23ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 14)">
    <text x="200" y="0" text-anchor="middle" font-size="14" font-weight="700" fill="#dc2626">Static batching</text>
    <text x="200" y="18" text-anchor="middle" font-size="11" fill="#94a3b8">凑齐一批 → 全跑完才能换 → 短请求空等到最长那条结束</text>
    <line x1="50" y1="38" x2="400" y2="38" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r23ar)"/>
    <text x="225" y="32" text-anchor="middle" font-size="10" fill="#64748b">time →</text>
    <text x="0" y="65" font-size="11" font-weight="600" fill="#475569">req A</text>
    <rect x="50" y="55" width="340" height="20" fill="#ea580c"/>
    <text x="220" y="69" text-anchor="middle" font-size="10" font-weight="600" fill="white">长请求 (主导 batch 退出时间)</text>
    <text x="0" y="95" font-size="11" font-weight="600" fill="#475569">req B</text>
    <rect x="50" y="85" width="80" height="20" fill="#0d9488"/>
    <rect x="130" y="85" width="260" height="20" fill="url(#r23waste)" stroke="#fca5a5" stroke-width="1"/>
    <text x="90" y="99" text-anchor="middle" font-size="10" font-weight="600" fill="white">短(done)</text>
    <text x="260" y="99" text-anchor="middle" font-size="10" fill="#b91c1c">slot idle — 不可借给新请求</text>
    <text x="0" y="125" font-size="11" font-weight="600" fill="#475569">req C</text>
    <rect x="50" y="115" width="180" height="20" fill="#7c3aed"/>
    <rect x="230" y="115" width="160" height="20" fill="url(#r23waste)" stroke="#fca5a5" stroke-width="1"/>
    <text x="140" y="129" text-anchor="middle" font-size="10" font-weight="600" fill="white">中等 (done)</text>
    <text x="310" y="129" text-anchor="middle" font-size="10" fill="#b91c1c">slot idle</text>
    <text x="0" y="160" font-size="11" font-weight="700" fill="#dc2626">req D</text>
    <text x="0" y="174" font-size="9" fill="#dc2626">新到</text>
    <rect x="50" y="145" width="340" height="20" fill="none" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="6,3"/>
    <text x="220" y="159" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">必须等整批结束才能上 ← HOL 阻塞</text>
    <rect x="0" y="185" width="400" height="44" fill="#fef2f2" stroke="#fca5a5" rx="4"/>
    <text x="200" y="204" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">长度方差越大 → 红色 idle 越大 → 吞吐越糟</text>
    <text x="200" y="221" text-anchor="middle" font-size="10" fill="#7f1d1d">TTFT = O(batch lifetime)，每个新请求都被锁定</text>
  </g>
  <line x1="450" y1="20" x2="450" y2="420" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <g transform="translate(465, 14)">
    <text x="200" y="0" text-anchor="middle" font-size="14" font-weight="700" fill="#16a34a">Continuous batching（iteration-level）</text>
    <text x="200" y="18" text-anchor="middle" font-size="11" fill="#94a3b8">每个 step 后 done 的离开、新到的进入；batch 维度每步动态变化</text>
    <line x1="0" y1="50" x2="400" y2="50" stroke="#cbd5e1" stroke-width="1"/>
    <line x1="0" y1="180" x2="400" y2="180" stroke="#cbd5e1" stroke-width="1"/>
    <text x="50" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">step n</text>
    <text x="140" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">step n+1</text>
    <text x="230" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">step n+2</text>
    <text x="320" y="42" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">step n+3</text>
    <line x1="90" y1="50" x2="90" y2="180" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <line x1="180" y1="50" x2="180" y2="180" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <line x1="270" y1="50" x2="270" y2="180" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="-15" y="70" text-anchor="end" font-size="11" font-weight="600" fill="#9a3412">A</text>
    <rect x="10" y="60" width="80" height="22" fill="#ea580c"/>
    <text x="50" y="74" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="100" y="60" width="80" height="22" fill="#ea580c"/>
    <text x="140" y="74" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="190" y="60" width="80" height="22" fill="#ea580c"/>
    <text x="230" y="74" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="280" y="60" width="80" height="22" fill="#ea580c"/>
    <text x="320" y="74" text-anchor="middle" font-size="9" fill="white">decode</text>
    <text x="-15" y="98" text-anchor="end" font-size="11" font-weight="600" fill="#115e59">B</text>
    <rect x="10" y="88" width="80" height="22" fill="#0d9488"/>
    <text x="50" y="102" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="100" y="88" width="80" height="22" fill="#0d9488"/>
    <text x="140" y="102" text-anchor="middle" font-size="9" fill="white">dec ✓done</text>
    <rect x="190" y="88" width="170" height="22" fill="none" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="275" y="102" text-anchor="middle" font-size="9" fill="#94a3b8">B evicted（slot 立即释放）</text>
    <text x="-15" y="126" text-anchor="end" font-size="11" font-weight="600" fill="#5b21b6">C</text>
    <rect x="10" y="116" width="80" height="22" fill="#7c3aed"/>
    <text x="50" y="130" text-anchor="middle" font-size="9" fill="white">prefill chunk</text>
    <rect x="100" y="116" width="80" height="22" fill="#7c3aed"/>
    <text x="140" y="130" text-anchor="middle" font-size="9" fill="white">prefill chunk</text>
    <rect x="190" y="116" width="80" height="22" fill="#a78bfa"/>
    <text x="230" y="130" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="280" y="116" width="80" height="22" fill="#a78bfa"/>
    <text x="320" y="130" text-anchor="middle" font-size="9" fill="white">decode</text>
    <text x="-15" y="154" text-anchor="end" font-size="11" font-weight="600" fill="#0369a1">E</text>
    <rect x="10" y="144" width="80" height="22" fill="none" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="50" y="158" text-anchor="middle" font-size="9" fill="#94a3b8">(not arrived)</text>
    <rect x="100" y="144" width="80" height="22" fill="#0ea5e9"/>
    <text x="140" y="158" text-anchor="middle" font-size="9" fill="white">E 加入 (prefill)</text>
    <rect x="190" y="144" width="80" height="22" fill="#0ea5e9"/>
    <text x="230" y="158" text-anchor="middle" font-size="9" fill="white">prefill chunk</text>
    <rect x="280" y="144" width="80" height="22" fill="#38bdf8"/>
    <text x="320" y="158" text-anchor="middle" font-size="9" fill="white">decode</text>
    <rect x="0" y="195" width="400" height="64" fill="#f0fdf4" stroke="#86efac" rx="4"/>
    <text x="200" y="214" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">B done 立刻退场 / E 立刻进入 / batch 维度每 step 重新组装</text>
    <text x="200" y="232" text-anchor="middle" font-size="10" fill="#14532d">TTFT 降到 O(单 step latency)；decode 始终能凑够 B 摆脱 memory-bound</text>
    <text x="200" y="248" text-anchor="middle" font-size="10" fill="#14532d">所有难题压到 scheduler：每步选谁、配多少 token、何时 preempt</text>
  </g>
</svg>
<span class="figure-caption">图 R2.3 ｜ 同一组 4 个请求的两种调度方式：static batching 受最长那条阻塞 + slot 闲置；continuous batching 每个 step 重新拼 batch，done 离场、新到入场，吞吐与时延同时改善</span>

<details>
<summary>ASCII 原版</summary>

```
time ─────────────────────────────────────────────►
batch  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮  (长请求拖住)
       ▮▮▮▮(短请求早完)............  (idle slot)
       ▮▮▮▮▮▮▮▮▮▮(中等请求).......  (idle slot)
                                  ↑ 新请求只能等

step n     : [A_dec, B_dec, C_prefill_chunk, D_dec]
step n+1   : [A_dec, B_dec(done!→evict), C_prefill_chunk, D_dec, E_prefill_chunk]
step n+2   : [A_dec, C_dec, D_dec, E_prefill_chunk]
```

</details>

吞吐提升来源：
- batch 维度饱和度由「最长请求」变成「平均请求」。
- decode 始终能凑齐足够 $B$ 摆脱 memory-bound。
- 新请求 TTFT 从 *O(batch lifetime)* 降到 *O(单 step latency)*。

### 2.4.3 调度难点

Continuous batching 把所有难题塞给调度器：
- 每 step 决定哪些请求参与、参与几个 token；
- 受 **KV 容量** 与 **token budget**（max_num_batched_tokens）两条约束；
- 决定何时 **preempt**（请求中途换出，KV 释放）：vLLM 使用 LRU recompute 或 swap 策略。

### 2.4.4 vLLM 中的入口

- 主循环：`vllm/v1/engine/core.py:91` (`class EngineCore`)，`:425` (`step`)。
- 调度逻辑：`vllm/v1/core/sched/scheduler.py:329` (`Scheduler.schedule`)。统一的 token 预算 `max_num_batched_tokens`。
- 注释 `vllm/v1/core/sched/scheduler.py:330-339` 明确说本调度器不区分 prefill/decode。

参考：
- Yu, Jeong, Golikov, Chowdhury, *Orca: A Distributed Serving System for Transformer-Based Generative Models*, OSDI 2022.

---

## 2.5 Prefix caching：跨请求共享前缀

### 2.5.1 场景动机

实际负载里前缀重复极其普遍：
- **System prompt**：API 的「You are a helpful assistant…」每次请求都一模一样。
- **Few-shot prompt**：示例段被所有用户复用。
- **多轮对话**：第 $k$ 轮的 prompt 包含前 $k-1$ 轮所有内容；只在末尾追加。
- **Agent / chain-of-thought**：工具调用模板、ReAct loop 中固定段落。
- **批量评测**：同一道题对多个模型，或同一模型多个 sampling。

如果每条请求都重新 prefill 一遍前缀，计算和显存全是浪费。

### 2.5.2 算法：基于哈希的 block 复用

PagedAttention 把 KV 拆成定长 block 后，前缀复用变得几乎免费：只要两条请求的前 $k$ 个 block 内容一致，就能让它们的 block table 指向同一物理 block。识别「内容一致」的标准方法是 **滚动哈希**：

$$
h_i = H\!\big(h_{i-1},\, \text{tokens}[i \cdot B : (i+1) \cdot B]\big)
$$

整块 $i$ 的哈希依赖前一块哈希 + 块内 token 序列。第一次某 prompt 进入时，每填满一块就计算 $h_i$ 并存入 `BlockHashToBlockMap`。下次再来一条 prompt：从块 0 开始按块查哈希，命中则复用、未命中即停止匹配，剩余部分仍走正常 prefill。

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="prefix caching 的滚动哈希块匹配流程">
  <defs>
    <marker id="r24ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Prefix caching：滚动哈希命中 → 直接挂物理 block；首个 miss 之后才真正算</text>
  <text x="40" y="56" font-size="11" font-weight="600" fill="#475569">新请求 prompt 切成 5 个 block（16 token / block）</text>
  <g transform="translate(40, 70)">
    <rect x="0" y="0" width="120" height="34" fill="#fed7aa" stroke="#ea580c"/>
    <text x="60" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">B0</text>
    <text x="60" y="28" text-anchor="middle" font-size="9" fill="#9a3412">tokens[0..16)</text>
    <rect x="125" y="0" width="120" height="34" fill="#fed7aa" stroke="#ea580c"/>
    <text x="185" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">B1</text>
    <text x="185" y="28" text-anchor="middle" font-size="9" fill="#9a3412">tokens[16..32)</text>
    <rect x="250" y="0" width="120" height="34" fill="#fed7aa" stroke="#ea580c"/>
    <text x="310" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">B2</text>
    <text x="310" y="28" text-anchor="middle" font-size="9" fill="#9a3412">tokens[32..48)</text>
    <rect x="375" y="0" width="120" height="34" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="435" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">B3</text>
    <text x="435" y="28" text-anchor="middle" font-size="9" fill="#5b21b6">tokens[48..64)</text>
    <rect x="500" y="0" width="120" height="34" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="560" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">B4</text>
    <text x="560" y="28" text-anchor="middle" font-size="9" fill="#5b21b6">tokens[64..80)</text>
  </g>
  <text x="40" y="128" font-size="11" font-weight="600" fill="#475569">滚动哈希：hᵢ = H(hᵢ₋₁, tokens[i·B : (i+1)·B])</text>
  <g transform="translate(40, 138)">
    <text x="60" y="14" text-anchor="middle" font-size="10" font-family="monospace" fill="#64748b">h0</text>
    <text x="185" y="14" text-anchor="middle" font-size="10" font-family="monospace" fill="#64748b">h1</text>
    <text x="310" y="14" text-anchor="middle" font-size="10" font-family="monospace" fill="#64748b">h2</text>
    <text x="435" y="14" text-anchor="middle" font-size="10" font-family="monospace" fill="#64748b">h3</text>
    <text x="560" y="14" text-anchor="middle" font-size="10" font-family="monospace" fill="#64748b">h4</text>
  </g>
  <text x="40" y="178" font-size="11" font-weight="600" fill="#475569">查 BlockHashToBlockMap：</text>
  <g transform="translate(40, 188)">
    <rect x="0" y="0" width="120" height="26" fill="#dcfce7" stroke="#16a34a"/>
    <text x="60" y="17" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">HIT</text>
    <rect x="125" y="0" width="120" height="26" fill="#dcfce7" stroke="#16a34a"/>
    <text x="185" y="17" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">HIT</text>
    <rect x="250" y="0" width="120" height="26" fill="#dcfce7" stroke="#16a34a"/>
    <text x="310" y="17" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">HIT</text>
    <rect x="375" y="0" width="120" height="26" fill="#fef2f2" stroke="#dc2626"/>
    <text x="435" y="17" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">MISS — 停止匹配</text>
    <rect x="500" y="0" width="120" height="26" fill="#f1f5f9" stroke="#cbd5e1" stroke-dasharray="3,2"/>
    <text x="560" y="17" text-anchor="middle" font-size="10" fill="#94a3b8">不再查</text>
  </g>
  <path d="M 100 226 Q 100 248 220 248" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2"/>
  <path d="M 225 226 Q 225 256 220 256" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2"/>
  <path d="M 350 226 Q 350 264 220 264" fill="none" stroke="#16a34a" stroke-width="1.2" stroke-dasharray="3,2"/>
  <rect x="120" y="244" width="200" height="26" fill="#bbf7d0" stroke="#16a34a" rx="3"/>
  <text x="220" y="261" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">直接挂在 block table 上</text>
  <text x="220" y="280" text-anchor="middle" font-size="10" fill="#14532d">prefill 跳过这 48 个 token（计算 + KV 写入全省）</text>
  <path d="M 475 226 L 475 248" fill="none" stroke="#7c3aed" stroke-width="1.2" marker-end="url(#r24ar)"/>
  <rect x="375" y="252" width="200" height="26" fill="#ede9fe" stroke="#7c3aed" rx="3"/>
  <text x="475" y="269" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">从这里才真正 prefill</text>
  <text x="475" y="288" text-anchor="middle" font-size="10" fill="#5b21b6">剩余 token 走 chunked prefill 推进</text>
  <text x="40" y="320" font-size="10" fill="#94a3b8">命中率 ≈ shared prefix tokens / total prompt tokens；多轮对话场景前 k-1 轮接近 100% 命中</text>
</svg>
<span class="figure-caption">图 R2.4 ｜ 滚动哈希按块查表：连续命中的前缀直接复用 block table 项（跳过 prefill），首个 miss 之后才走正常 prefill 路径</span>

<details>
<summary>ASCII 原版</summary>

```
新请求 prompt 切块:   [B0][B1][B2][B3][B4]
计算哈希:             h0   h1   h2   h3   h4
查表:                 hit  hit  hit  miss ...
                       ↑    ↑    ↑
                       └────┴────┴── 直接挂在 block table 上, 跳过这部分 prefill
                                ↑
                              从这里开始真正算
```

</details>

### 2.5.3 与 PagedAttention 的天然契合

- block 已经是定长不可变单位，正好作为哈希粒度。
- 物理 block 引用计数 (`ref_cnt`) 让多请求共享和 LRU 驱逐天然成立。
- 部分块（最后一个不满的）不被哈希、不被共享——避免“写入污染他人”的正确性问题。

匹配过程的复杂度是 $O(L/B)$ 次哈希查表，对 $B=16, L=8K$ 是 512 次 dict 查询，可忽略。

### 2.5.4 命中率与上限

命中收益 $\approx \dfrac{\text{shared prefix tokens}}{\text{total prompt tokens}}$ 的 prefill FLOPs。对多轮对话，前 $k-1$ 轮命中率接近 100%，第 $k$ 轮只 prefill 新增 user turn。

### 2.5.5 vLLM 中的入口

- 哈希定义：`vllm/v1/core/kv_cache_utils.py` 中 `BlockHash`、`get_block_hash`、`hash_request_tokens`。
- 最长前缀匹配：`vllm/v1/core/kv_cache_manager.py:221` (`find_longest_cache_hit`)。
- 缓存反向索引：`vllm/v1/core/block_pool.py:34` (`class BlockHashToBlockMap`)。
- 跨进程/跨节点扩展（disk、Mooncake、LMCache 等 KV connector）：`vllm/distributed/kv_transfer/`。

参考：
- Zheng et al., *SGLang: Efficient Execution of Structured Language Model Programs*, NeurIPS 2024（介绍 RadixAttention，思想相近，用 trie 而非平铺哈希）。
- Juravsky et al., *Hydragen: High-Throughput LLM Inference with Shared Prefixes*, 2024。

---

## 2.6 Chunked prefill：长 prompt 与 decode 共存

### 2.6.1 动机

未启用 chunked prefill 时，调度器面临两种坏选择：
1. **prefill-first**：长 prompt 全部 prefill 完才 decode → 长 prompt 进入瞬间，全 batch 的 decode 暂停几百毫秒，TPOT 抖动巨大。
2. **decode-first**：等 decode 全做完才 prefill → TTFT 飙升，新请求迟迟无响应。

更糟糕的是，单个 batch 里若混入 8K token 的 prefill，整批 step 时间被它拉长，decode 的高吞吐特性被毁掉。

### 2.6.2 算法

把 prefill 切成长度 $\le C$ 的 chunk（C = `long_prefill_token_threshold` 或受 `max_num_batched_tokens` 约束），每个 step 只前进一段：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Chunked prefill 把长 prompt 切成 token 预算内的 chunk，与 decode 共存">
  <defs>
    <marker id="r25ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Chunked prefill：每个 step 都填满 token budget，decode + 一段 prefill 共存</text>
  <text x="380" y="40" text-anchor="middle" font-size="11" fill="#94a3b8">token_budget = max_num_batched_tokens = 2048</text>
  <g transform="translate(40, 60)">
    <line x1="80" y1="0" x2="80" y2="220" stroke="#cbd5e1"/>
    <text x="40" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">step n</text>
    <rect x="80" y="8" width="60" height="22" fill="#ea580c"/>
    <text x="110" y="23" text-anchor="middle" font-size="10" font-weight="700" fill="white">60 dec</text>
    <rect x="142" y="8" width="558" height="22" fill="#7c3aed"/>
    <text x="421" y="23" text-anchor="middle" font-size="10" font-weight="700" fill="white">prefill chunk of req X：1988 tokens</text>
    <text x="40" y="60" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">step n+1</text>
    <rect x="80" y="48" width="60" height="22" fill="#ea580c"/>
    <text x="110" y="63" text-anchor="middle" font-size="10" font-weight="700" fill="white">60 dec</text>
    <rect x="142" y="48" width="558" height="22" fill="#7c3aed"/>
    <text x="421" y="63" text-anchor="middle" font-size="10" font-weight="700" fill="white">prefill chunk of req X：1988 tokens</text>
    <text x="40" y="100" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">step n+2</text>
    <rect x="80" y="88" width="61" height="22" fill="#ea580c"/>
    <text x="110" y="103" text-anchor="middle" font-size="10" font-weight="700" fill="white">61 dec</text>
    <rect x="143" y="88" width="557" height="22" fill="#a78bfa"/>
    <text x="421" y="103" text-anchor="middle" font-size="10" font-weight="700" fill="white">prefill chunk of req X：1987 tokens（最后一段）</text>
    <text x="40" y="140" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">step n+3</text>
    <rect x="80" y="128" width="80" height="22" fill="#ea580c"/>
    <text x="120" y="143" text-anchor="middle" font-size="10" font-weight="700" fill="white">61+1 dec</text>
    <text x="430" y="143" text-anchor="middle" font-size="10" fill="#94a3b8">X 进入 decode，token budget 此时主要是 decode token</text>
    <line x1="80" y1="160" x2="700" y2="160" stroke="#cbd5e1"/>
    <line x1="80" y1="160" x2="80" y2="170" stroke="#64748b" stroke-width="1"/>
    <line x1="700" y1="160" x2="700" y2="170" stroke="#64748b" stroke-width="1"/>
    <line x1="390" y1="160" x2="390" y2="170" stroke="#64748b" stroke-width="1"/>
    <text x="80" y="184" text-anchor="middle" font-size="10" fill="#64748b">0</text>
    <text x="390" y="184" text-anchor="middle" font-size="10" fill="#64748b">1024 tokens</text>
    <text x="700" y="184" text-anchor="middle" font-size="10" fill="#64748b">2048 tokens (budget)</text>
    <g transform="translate(80, 200)">
      <rect x="0" y="0" width="14" height="12" fill="#ea580c"/>
      <text x="20" y="11" font-size="10" fill="currentColor">decode token</text>
      <rect x="120" y="0" width="14" height="12" fill="#7c3aed"/>
      <text x="140" y="11" font-size="10" fill="currentColor">long-prompt prefill chunk</text>
    </g>
  </g>
  <g transform="translate(40, 280)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">关键点：</tspan>每个 step 总 token T ≈ budget（compute-bound 区），权重一次读取被整 batch 摊销 → prefill 利用算力 + decode 摆脱 memory-bound。Sarathi-Serve 称之为 stall-free batching。</text>
  </g>
</svg>
<span class="figure-caption">图 R2.5 ｜ 长 prefill 被切成 token 预算内的 chunk，每个 step 同时容纳 decode 和一段 prefill；prefill 进入 decode 后 budget 自然让位给 decode</span>

<details>
<summary>ASCII 原版</summary>

```
token_budget = max_num_batched_tokens (e.g. 2048)
step n:  decode * 60   +  prefill_chunk_of_req_X (1988 toks)  = 2048
step n+1: decode * 60  +  prefill_chunk_of_req_X (1988 toks)  = 2048
step n+2: decode * 61  +  prefill_chunk_of_req_X (1987 toks)  = 2048   <- X 进入 decode
...
```

</details>

每个 step 都达到接近最优的 batch token 数（compute-bound 区），同时 decode 没有空窗。

### 2.6.3 数学：为什么必须配合 continuous batching

记单 step 总 token = $T$，decode 请求数 $D$，prefill chunk 长度 $P$，则 $T = D + P$。
- 算力近似 $\propto T$；
- 显存带宽 $\propto P_{\text{weights}}$ 一次（被整 batch 摊销）。

把 $T$ 拉到 GPU 平衡点附近（A100 上 ~2048），即可同时满足：
- prefill 充分利用算力（因为 $P$ 仍很大，主导）；
- decode 不再 memory-bound（因为权重读取被 prefill chunk 顺带摊销）。

这是 Sarathi-Serve [Agrawal et al., OSDI'24] 的关键洞见：**stall-free batching**。

### 2.6.4 与 prefix caching 的交互

Prefix caching 跳过了开头若干个完整 block 的 prefill；chunked prefill 切分剩余部分。两者顺序：先做前缀匹配确定 `num_computed_tokens`，再按 chunk 推进。

### 2.6.5 vLLM 中的入口

- 调度器同一循环统一处理：`vllm/v1/core/sched/scheduler.py:385-398`（`num_new_tokens` 取 min of `num_tokens_with_spec - num_computed_tokens`、`long_prefill_token_threshold`、`token_budget`、`max_model_len`）。
- `long_prefill_token_threshold` 在 `vllm/config/scheduler.py` 中定义。

参考：
- Agrawal et al., *Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*, OSDI 2024.

---

## 2.7 Speculative decoding：把 decode 推向 compute-bound

### 2.7.1 动机

decode 阶段是 memory-bound：每生成一个 token 都要读一遍整个 W。如果能在「读一次权重」的代价下验证 $k$ 个 token，理论上吞吐提升 $k\times$（受接受率折扣）。

### 2.7.2 基本算法：draft + verify

[Leviathan et al., ICML'23; Chen et al., 2023] 提出推测采样：

1. **Draft**：用一个轻量提议器（draft model 或 n-gram 或 head 等）给出 $k$ 个候选 token $\tilde y_{1..k}$ 及其分布 $q_i(\cdot)$。
2. **Verify**：把 $(\tilde y_1, \dots, \tilde y_k)$ 一次性喂给 target model，得到 $k$ 个位置的目标分布 $p_i(\cdot)$。
3. **接受采样**（与 target 模型采样等价）：对位置 $i$，以概率 $\min(1, p_i(\tilde y_i)/q_i(\tilde y_i))$ 接受 $\tilde y_i$。一旦在位置 $i^*$ 拒绝，则从修正分布 $\mathrm{normalize}(\max(0, p_{i^*} - q_{i^*}))$ 重采，丢弃后续 draft。

证明该方案产生的样本分布严格等于直接从 $p$ 采样。

### 2.7.3 加速来源

一次 target forward 同时验证 $k+1$ 个位置：
- target 算力多花一点（forward 输入从 1 token 增至 $k+1$ token，仍 < memory-bound 阈值），权重读取不变；
- 平均接受 $\bar k$ 个 token，单步等效吞吐 $\bar k\times$。

整体加速：
$$
\text{speedup} \approx \frac{\bar k}{1 + c_{\text{draft}}/c_{\text{target}}}
$$
其中 $c_{\text{draft}}, c_{\text{target}}$ 是 draft / target 模型 forward 时间。draft 越便宜、$\bar k$ 越大，收益越高。

### 2.7.4 不同提议器

| 类型 | 工作方式 | 何时好用 |
|---|---|---|
| **Draft model**  | 小一档的同家族模型（如 Llama-8B 给 Llama-70B 当 draft） | 通用，但要训练/找到匹配的小模型 |
| **N-gram**       | 在 prompt + 已生成历史中找最长后缀匹配 → 续写候选 | 重复性强的文本（代码补全、文档抽取） |
| **EAGLE / EAGLE-2** | 在 target 模型 hidden state 上叠一个小的自回归 head | 高接受率，结构紧凑 |
| **Medusa**       | target 顶部接 $k$ 个并行 MLP head，每个预测「未来第 $i$ 个 token」 | 训练成本低，单步 draft 极快 |
| **Suffix decoding** | 基于后缀树的多步 n-gram 强化版 | 长上下文 + 重复模式 |

### 2.7.5 与 PagedAttention 的协同

verify 阶段是 prefix 已知 + 多 token 一起算：天然适合 chunked prefill 那一套（共用 KV、共用调度路径）。vLLM 调度器把 spec tokens 计入 `num_tokens_with_spec`，统一推进。

### 2.7.6 vLLM 中的入口

- 提议器基类 / 实现：
  - `vllm/v1/spec_decode/eagle.py:10` (`EagleProposer`)
  - `vllm/v1/spec_decode/medusa.py:18` (`MedusaProposer`)
  - `vllm/v1/spec_decode/ngram_proposer.py:12` (`NgramProposer`)
  - `vllm/v1/spec_decode/draft_model.py:17` (`DraftModelProposer`)
  - `vllm/v1/spec_decode/suffix_decoding.py`
- 拒绝采样：`vllm/v1/sample/rejection_sampler.py:37` (`class RejectionSampler`)、`:392` (`rejection_sample`)、`:659` (`sample_recovered_tokens`)。
- 调度器集成：`vllm/v1/core/sched/scheduler.py` 中的 `num_spec_tokens`、`num_lookahead_tokens`。

参考：
- Leviathan, Kalman, Matias, *Fast Inference from Transformers via Speculative Decoding*, ICML 2023.
- Chen et al., *Accelerating Large Language Model Decoding with Speculative Sampling*, arXiv:2302.01318.
- Cai et al., *Medusa: Simple LLM Inference Acceleration Framework with Multiple Decoding Heads*, 2024.
- Li et al., *EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty*, ICML 2024.

---

## 2.8 Quantization：把权重和激活塞进更窄的位宽

### 2.8.1 动机

decode 阶段瓶颈是带宽，权重读取量 $\propto$ bytes/param。把 FP16 (2B) 换成 INT4 (0.5B) 理论上带宽需求降到 1/4，decode 吞吐相应上升。同时显存占用更小，可容纳更多并发请求或更长上下文。

### 2.8.2 分类

| 维度 | 选项 | 影响 |
|---|---|---|
| **被量化的对象** | weight-only / weight + activation / KV cache | weight-only 最易做，精度损失小 |
| **粒度** | per-tensor / per-channel / per-group (e.g. group_size=128) | 越细越准，反量化开销越大 |
| **方法** | round-to-nearest / GPTQ / AWQ / SmoothQuant | 是否依赖校准集与误差补偿 |
| **目标格式** | INT8, INT4, FP8 (E4M3/E5M2), MXFP4 | FP8 在 Hopper/Blackwell 上有原生 Tensor Core |

### 2.8.3 常见方案要点

- **GPTQ** [Frantar et al., ICLR'23]：基于二阶 Hessian 的逐列量化补偿，对 INT4 weight-only 效果好。
- **AWQ** [Lin et al., MLSys'24]：发现少数「显著权重」对精度贡献大，给它们留更宽 scale（per-channel scaling），用 INT4/INT3 weight-only。
- **SmoothQuant**：把激活的难量化部分通过等价变换 $X \cdot W = (X/s)\cdot(sW)$ 转嫁到权重，实现 W8A8。
- **FP8**：Hopper 起原生支持 E4M3 (训练 / 激活) 与 E5M2 (梯度 / 大范围)。weight + activation FP8 几乎无需校准，精度接近 FP16。
- **KV cache 量化**：把 K, V 也存成 FP8 / INT8，显存减半，attention kernel 反量化。

### 2.8.4 vLLM 中的入口

- 量化方法注册：`vllm/model_executor/layers/quantization/__init__.py`。
- 典型实现：
  - `vllm/model_executor/layers/quantization/awq.py:34` (`AWQConfig`), `:172` (`AWQLinearMethod`)
  - `vllm/model_executor/layers/quantization/fp8.py:100` (`Fp8Config`), `:261` (`Fp8LinearMethod`), `:565` (`Fp8MoEMethod`)
  - `vllm/model_executor/layers/quantization/auto_gptq.py`
  - `vllm/model_executor/layers/quantization/compressed_tensors/`
  - `vllm/model_executor/layers/quantization/kv_cache.py`（KV cache 量化）

参考：
- Frantar, Ashkboos, Hoefler, Alistarh, *GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers*, ICLR 2023.
- Lin et al., *AWQ: Activation-aware Weight Quantization*, MLSys 2024.
- Xiao et al., *SmoothQuant*, ICML 2023.
- NVIDIA Hopper FP8 White Paper.

---

## 2.9 CUDA Graph 与 torch.compile

### 2.9.1 动机

每次 forward step 启动几百个 kernel；在 decode 阶段单 step 只有几十 µs 算力工作量，Python + PyTorch + cuLaunchKernel 的 host 开销可以高达 30–50% 的步时延。两个互补技术解决：

- **CUDA Graph**：把一段 kernel 序列录制成图，单次提交 GPU 执行。完全消除 launch overhead。代价：图的 shape / pointer 必须固定 ⇒ 需要按 batch size 分桶捕获多张图；需要 dynamic shape 的部分（如 attention 因 seq 长度变化）只能用「piecewise CUDA graph」或回退到 eager。
- **torch.compile (Inductor)**：把 PyTorch 子图编译成融合 kernel（matmul + bias + activation 等），减少访存。可在编译后再用 CUDA Graph 包裹得到双重收益。

### 2.9.2 vLLM 的策略

vLLM v1 把模型 forward 切成「可捕获段」与「不可捕获段」（attention kernel 因 dynamic seq 不便捕）：
- `CUDAGraphMode.PIECEWISE`：每段单独捕获 CUDA Graph；
- `CUDAGraphMode.FULL`：整图捕获，要求 attention 也兼容；
- `CUDAGraphMode.NONE`：完全 eager。

按 `(batch_size, uniform_decode_or_not)` 维度建立 graph 字典。decode 通常 batch_size 桶 + uniform query len = 1 + spec_tokens；prefill chunk 走 eager 或 piecewise。

### 2.9.3 入口

- 配置：`vllm/config/compilation.py:381` (`class CompilationConfig`)。
- 分发器：`vllm/v1/cudagraph_dispatcher.py:171` (`initialize_cudagraph_keys`)、`:147`（决定 FULL vs PIECEWISE）。
- piecewise 编译实现：`vllm/compilation/backends.py:682` (`class PiecewiseCompileInterpreter`)。
- 包装器：`vllm/compilation/wrapper.py`。

参考：
- NVIDIA CUDA Graphs documentation, https://docs.nvidia.com/cuda/cuda-c-programming-guide/#cuda-graphs
- PyTorch `torch.compile`, https://pytorch.org/docs/stable/torch.compiler.html

---

## 2.10 TP / PP / EP：三种并行方式的本质区别

模型不能 fit 进单卡，或单卡延迟不达标时，就要切分。三种主流切法在「**切什么**」上根本不同：

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TP / PP / EP 三种并行方式分别切层内、切层间、切专家">
  <defs>
    <marker id="r26ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">三种切法的根本区别：切「什么」</text>
  <g transform="translate(40, 50)">
    <rect x="0" y="0" width="100" height="80" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="50" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">TP</text>
    <text x="50" y="36" text-anchor="middle" font-size="10" fill="#9a3412">Tensor Parallel</text>
    <text x="50" y="56" text-anchor="middle" font-size="10" fill="#9a3412">切层内的</text>
    <text x="50" y="70" text-anchor="middle" font-size="10" fill="#9a3412">GEMM 矩阵</text>
    <text x="170" y="20" font-size="11" font-weight="600" fill="currentColor">单层 Transformer block 沿 head / hidden 维切分到各卡</text>
    <g transform="translate(170, 30)">
      <rect x="0" y="0" width="60" height="50" fill="#ffedd5" stroke="#fb923c"/>
      <text x="30" y="20" text-anchor="middle" font-size="9" fill="#9a3412">QKV proj</text>
      <text x="30" y="33" text-anchor="middle" font-size="8" fill="#9a3412">(col split)</text>
      <text x="30" y="44" text-anchor="middle" font-size="8" fill="#c2410c">heads/N</text>
      <rect x="62" y="0" width="60" height="50" fill="#ffedd5" stroke="#fb923c"/>
      <text x="92" y="20" text-anchor="middle" font-size="9" fill="#9a3412">Attn</text>
      <text x="92" y="33" text-anchor="middle" font-size="8" fill="#c2410c">本地</text>
      <rect x="124" y="0" width="60" height="50" fill="#ffedd5" stroke="#fb923c"/>
      <text x="154" y="20" text-anchor="middle" font-size="9" fill="#9a3412">O proj</text>
      <text x="154" y="33" text-anchor="middle" font-size="8" fill="#9a3412">(row split)</text>
      <text x="154" y="44" text-anchor="middle" font-size="8" fill="#c2410c">AllReduce</text>
      <rect x="186" y="0" width="60" height="50" fill="#ffedd5" stroke="#fb923c"/>
      <text x="216" y="20" text-anchor="middle" font-size="9" fill="#9a3412">FFN_up</text>
      <text x="216" y="33" text-anchor="middle" font-size="8" fill="#9a3412">(col)</text>
      <rect x="248" y="0" width="60" height="50" fill="#ffedd5" stroke="#fb923c"/>
      <text x="278" y="20" text-anchor="middle" font-size="9" fill="#9a3412">FFN_down</text>
      <text x="278" y="33" text-anchor="middle" font-size="8" fill="#9a3412">(row)</text>
      <text x="278" y="44" text-anchor="middle" font-size="8" fill="#c2410c">AllReduce</text>
    </g>
    <text x="500" y="100" font-size="9" fill="#94a3b8">每层 2 次 AllReduce → 节点内 NVLink 友好</text>
  </g>
  <g transform="translate(40, 150)">
    <rect x="0" y="0" width="100" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
    <text x="50" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">PP</text>
    <text x="50" y="36" text-anchor="middle" font-size="10" fill="#115e59">Pipeline Parallel</text>
    <text x="50" y="56" text-anchor="middle" font-size="10" fill="#115e59">沿层数切</text>
    <text x="50" y="70" text-anchor="middle" font-size="10" fill="#115e59">stage 流水</text>
    <text x="170" y="20" font-size="11" font-weight="600" fill="currentColor">把 N 层分成 P 个 stage，每张卡持有连续若干 layer</text>
    <g transform="translate(170, 30)">
      <rect x="0" y="0" width="70" height="44" fill="#ccfbf1" stroke="#14b8a6"/>
      <text x="35" y="20" text-anchor="middle" font-size="10" fill="#115e59">layer 0</text>
      <text x="35" y="34" text-anchor="middle" font-size="9" fill="#115e59">stage 0</text>
      <path d="M 72 22 L 80 22" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r26ar)"/>
      <rect x="82" y="0" width="70" height="44" fill="#ccfbf1" stroke="#14b8a6"/>
      <text x="117" y="20" text-anchor="middle" font-size="10" fill="#115e59">layer 1</text>
      <text x="117" y="34" text-anchor="middle" font-size="9" fill="#115e59">stage 1</text>
      <path d="M 154 22 L 162 22" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r26ar)"/>
      <rect x="164" y="0" width="70" height="44" fill="#ccfbf1" stroke="#14b8a6"/>
      <text x="199" y="20" text-anchor="middle" font-size="10" fill="#115e59">layer 2</text>
      <text x="199" y="34" text-anchor="middle" font-size="9" fill="#115e59">stage 2</text>
      <path d="M 236 22 L 244 22" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r26ar)"/>
      <rect x="246" y="0" width="70" height="44" fill="#ccfbf1" stroke="#14b8a6"/>
      <text x="281" y="20" text-anchor="middle" font-size="10" fill="#115e59">layer 3</text>
      <text x="281" y="34" text-anchor="middle" font-size="9" fill="#115e59">stage 3</text>
    </g>
    <text x="345" y="100" text-anchor="end" font-size="9" fill="#94a3b8">stage 边界仅传 hidden state → 通信小，能跨节点</text>
  </g>
  <g transform="translate(40, 250)">
    <rect x="0" y="0" width="100" height="80" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
    <text x="50" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">EP</text>
    <text x="50" y="36" text-anchor="middle" font-size="10" fill="#5b21b6">Expert Parallel</text>
    <text x="50" y="56" text-anchor="middle" font-size="10" fill="#5b21b6">MoE 专用</text>
    <text x="50" y="70" text-anchor="middle" font-size="10" fill="#5b21b6">切 FFN 的专家</text>
    <text x="170" y="20" font-size="11" font-weight="600" fill="currentColor">MoE FFN = Σ gate(x)·E_i(x)；不同专家放不同卡</text>
    <g transform="translate(170, 30)">
      <rect x="0" y="0" width="55" height="44" fill="#ede9fe" stroke="#a78bfa"/>
      <text x="27" y="20" text-anchor="middle" font-size="10" fill="#5b21b6">E₀ E₁</text>
      <text x="27" y="34" text-anchor="middle" font-size="9" fill="#5b21b6">GPU 0</text>
      <rect x="60" y="0" width="55" height="44" fill="#ede9fe" stroke="#a78bfa"/>
      <text x="87" y="20" text-anchor="middle" font-size="10" fill="#5b21b6">E₂ E₃</text>
      <text x="87" y="34" text-anchor="middle" font-size="9" fill="#5b21b6">GPU 1</text>
      <rect x="120" y="0" width="55" height="44" fill="#ede9fe" stroke="#a78bfa"/>
      <text x="147" y="20" text-anchor="middle" font-size="10" fill="#5b21b6">E₄ E₅</text>
      <text x="147" y="34" text-anchor="middle" font-size="9" fill="#5b21b6">GPU 2</text>
      <rect x="180" y="0" width="55" height="44" fill="#ede9fe" stroke="#a78bfa"/>
      <text x="207" y="20" text-anchor="middle" font-size="10" fill="#5b21b6">E₆ E₇</text>
      <text x="207" y="34" text-anchor="middle" font-size="9" fill="#5b21b6">GPU 3</text>
      <path d="M 240 22 L 290 22" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r26ar)"/>
      <text x="265" y="14" text-anchor="middle" font-size="9" fill="#5b21b6">all-to-all</text>
      <text x="265" y="36" text-anchor="middle" font-size="9" fill="#5b21b6">route tokens</text>
    </g>
    <text x="500" y="100" font-size="9" fill="#94a3b8">每卡只装自己负责的专家 → 显存友好，但带宽要求高</text>
  </g>
  <g transform="translate(40, 365)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">组合：</tspan>world_size = TP × PP × DP，EP 寄生在已有 group 上。例：8 × H100 + 70B → TP=8；DeepSeek-V3 → TP=8, EP=8, DP=多副本。</text>
  </g>
</svg>
<span class="figure-caption">图 R2.6 ｜ TP 切层内 GEMM、PP 切层间 stage、EP 切 MoE 的专家——三种切法正交，vLLM 允许任意组合</span>

<details>
<summary>ASCII 原版</summary>

```
                          single layer (Transformer block)
                ┌─────────────────────────────────────────────┐
   TP 切 这里 →│  QKV proj | Attn | O proj | FFN_up | FFN_down │
                └─────────────────────────────────────────────┘
                           ↓ 多层堆叠
                ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
   PP 切 这里 →│ layer 0 │ │ layer 1│ │ layer 2│ │ layer 3│
                └────────┘ └────────┘ └────────┘ └────────┘
                           ↓ MoE 时
                ┌─────────────────────────────────────────────┐
   EP 切 这里 →│ FFN = Σ gate(x)·expert_i(x)                  │
                └─────────────────────────────────────────────┘
```

</details>

### 2.10.1 Tensor Parallelism (TP)

**切 GEMM 矩阵的行/列。** Megatron-LM [Shoeybi et al., 2019] 经典做法：
- `QKV` projection 沿 head 维列切：$W_{QKV} = [W^{(1)}_{QKV} | \dots | W^{(N)}_{QKV}]$，每卡算自己负责的 heads。
- `O` projection 行切，配合一次 `all_reduce` 汇聚。
- FFN 同理：up-proj 列切、down-proj 行切。
- 每层 2 次 `all_reduce`（attention + FFN），通信量 $\propto$ batch × hidden。

**适用**：单节点内（高带宽 NVLink）。延迟敏感场景因为单卡算力被瓜分而 latency 下降。
**约束**：head 数必须能被 TP size 整除（或更细粒度切）。

### 2.10.2 Pipeline Parallelism (PP)

**沿层数切。** stage $i$ 持有连续若干 layer。一个 batch 顺序流经 stage 0 → stage $P-1$。
- 通信量小：每 stage 边界只传一份 hidden state。
- 但有 *pipeline bubble*：流水线启动/排空时部分 stage 闲置。解决：micro-batch 切分 + 1F1B 调度。
- **推理中**：与 continuous batching 配合时，每 step 让 micro-batch 流过 pipeline，bubble 几乎消失。

**适用**：跨节点（低带宽 InfiniBand 也能跑）；超大模型层数多时。
**缺点**：延迟随 stage 数线性增加，单 token 时延不友好。

### 2.10.3 Expert Parallelism (EP)

**MoE 模型专用。** FFN 替换为 $\sum_e g_e(x)\, E_e(x)$，每层有若干专家 $E_e$。EP 把不同专家分到不同卡：
- token 路由后通过 `all-to-all` 把各 token 发到拥有对应专家的卡；
- 计算完再 `all-to-all` 收回。
- 通信量与 batch、top-k 路由相关，对带宽要求高。

**适用**：MoE 模型（DeepSeek-V3、Mixtral 等），每张卡内存只放自己负责的专家。
**配合**：常与 TP / DP 组合，例如 EP × DP 的 *expert parallelism + data parallelism*。

### 2.10.4 组合与正交

vLLM 允许 TP × PP × DP × EP 任意组合。world_size = $tp\cdot pp\cdot dp$，EP 寄生在已有 group 上。常见配方：
- 单节点 8×H100：TP=8。
- 双节点 16×H100 跑 70B：TP=8, PP=2。
- DeepSeek-V3 MoE：TP=8, EP=8, DP=多副本。

### 2.10.5 vLLM 中的入口

- 配置：`vllm/config/parallel.py:108` (`class ParallelConfig`)，字段 `tensor_parallel_size:113`、`pipeline_parallel_size:111`、`data_parallel_size`、`expert_parallel_size`。
- 通信组管理：`vllm/distributed/parallel_state.py`、`vllm/distributed/communication_op.py`。
- EPLB（专家负载均衡）：`vllm/distributed/eplb/`。
- 张量切分实现在各 Linear 层：`vllm/model_executor/layers/linear.py` (ColumnParallelLinear, RowParallelLinear)。

参考：
- Shoeybi et al., *Megatron-LM: Training Multi-Billion Parameter Language Models Using Model Parallelism*, 2019.
- Narayanan et al., *Efficient Large-Scale Language Model Training on GPU Clusters Using Megatron-LM*, SC 2021.
- Lepikhin et al., *GShard: Scaling Giant Models with Conditional Computation*, ICLR 2021（EP 鼻祖）.
- Fedus et al., *Switch Transformers*, JMLR 2022.

---

## 2.11 概念交互速查

各机制并非独立，而是相互催化：

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vLLM 各核心机制之间的催化关系图">
  <defs>
    <marker id="r27ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">各机制相互催化：所有路径最终汇入"统一调度 + 多卡扩展"</text>
  <g transform="translate(140, 50)">
    <rect x="0" y="0" width="170" height="48" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">PagedAttention</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#9a3412">block 池 + block table</text>
  </g>
  <g transform="translate(440, 50)">
    <rect x="0" y="0" width="170" height="48" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">Prefix Caching</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#9a3412">哈希复用 block</text>
  </g>
  <path d="M 310 74 L 438 74" fill="none" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r27ar)"/>
  <text x="374" y="68" text-anchor="middle" font-size="9" fill="#9a3412">提供分块粒度</text>
  <g transform="translate(140, 140)">
    <rect x="0" y="0" width="170" height="48" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">Continuous Batching</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#115e59">iteration-level 调度</text>
  </g>
  <g transform="translate(440, 140)">
    <rect x="0" y="0" width="170" height="48" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">Chunked Prefill</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#115e59">长 prompt 切片填预算</text>
  </g>
  <path d="M 225 98 L 225 138" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r27ar)"/>
  <text x="232" y="123" font-size="9" fill="#115e59">slot_mapping</text>
  <path d="M 525 98 L 525 138" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r27ar)"/>
  <text x="532" y="123" font-size="9" fill="#115e59">跳过完整块</text>
  <path d="M 438 164 L 312 164" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r27ar)"/>
  <text x="374" y="158" text-anchor="middle" font-size="9" fill="#115e59">每 step 推进 num_computed_tokens</text>
  <g transform="translate(290, 215)">
    <rect x="0" y="0" width="170" height="48" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">Speculative Decoding</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#5b21b6">一次验证 k 个 token</text>
  </g>
  <path d="M 375 215 L 375 192" fill="none" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r27ar)"/>
  <text x="382" y="207" font-size="9" fill="#5b21b6">num_tokens_with_spec → 统一循环</text>
  <g transform="translate(290, 290)">
    <rect x="0" y="0" width="170" height="48" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#075985">Quantization / FP8 KV</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#075985">减少 bytes/token</text>
  </g>
  <path d="M 375 290 L 375 265" fill="none" stroke="#0284c7" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r27ar)"/>
  <text x="382" y="280" font-size="9" fill="#075985">间接扩大 batch / context</text>
  <g transform="translate(290, 365)">
    <rect x="0" y="0" width="170" height="48" fill="#fde68a" stroke="#d97706" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">CUDA Graph / torch.compile</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#92400e">削减 launch overhead</text>
  </g>
  <path d="M 375 365 L 375 340" fill="none" stroke="#d97706" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r27ar)"/>
  <text x="382" y="355" font-size="9" fill="#92400e">decode-heavy 步骤提速</text>
  <g transform="translate(290, 440)">
    <rect x="0" y="0" width="170" height="48" fill="#fecaca" stroke="#dc2626" stroke-width="1.5" rx="6"/>
    <text x="85" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#991b1b">TP / PP / EP</text>
    <text x="85" y="38" text-anchor="middle" font-size="9" fill="#991b1b">多卡扩 算力 / 显存 / 专家</text>
  </g>
  <path d="M 375 440 L 375 415" fill="none" stroke="#dc2626" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r27ar)"/>
  <text x="382" y="430" font-size="9" fill="#991b1b">单步算力扩到多卡</text>
  <text x="40" y="500" font-size="11" font-style="italic" fill="#64748b">「调度器对所有请求都是同一种状态机：每 step 推进若干 token，KV 按 block 分配，前缀按哈希复用，长 prompt 按预算切片，候选按 spec 倍数生成」</text>
</svg>
<span class="figure-caption">图 R2.7 ｜ vLLM 各核心机制并非独立——PagedAttention 是底座，Prefix Caching/Chunked Prefill/Spec Decoding 全部汇入 Continuous Batching 的统一调度循环，Quantization/CUDA Graph/并行只是从不同维度放大其上限</span>

<details>
<summary>ASCII 原版</summary>

```
   PagedAttention ──── 提供分块结构 ────► Prefix Caching
        │                                       │
        │ 提供 slot_mapping 接口                │ 跳过开头若干完整块
        ▼                                       ▼
  Continuous Batching ◄──── 每 step 推进 num_computed_tokens ──── Chunked Prefill
        ▲                                       ▲
        │ 同一 batch 容纳多请求                 │ 把长 prompt 拆成 token 预算内的 chunk
        │                                       │
   Speculative Decoding ─── num_tokens_with_spec ─── 进入统一调度循环
        │
        ▼
   Quantization / FP8 KV ─── 减少 bytes/token ─── 间接增加可容 batch 与上下文
        │
        ▼
   CUDA Graph / torch.compile ─── 削减 launch overhead ─── 让 decode-heavy 步骤继续提速
        │
        ▼
   TP / PP / EP ─── 把单步算力 / 显存 / 专家容量扩到多卡
```

</details>

理解这张图就理解了 vLLM 调度器 (`vllm/v1/core/sched/scheduler.py:329`) 那段 *"There's no decoding phase nor prefill phase"* 注释的全部含义：**所有请求被抽象成同一种状态机——每 step 推进若干 token，KV 按 block 分配，前缀按哈希复用，长 prompt 按预算切片，候选按 spec 倍数生成**。后续章节将按这条主线展开实现。

---

## 2.12 延伸阅读清单

- vLLM 主页 & 文档：https://docs.vllm.ai
- PagedAttention 博文：https://blog.vllm.ai/2023/06/20/vllm.html
- Sarathi-Serve 技术报告：https://arxiv.org/abs/2403.02310
- FlashAttention-3：https://tridao.me/blog/2024/flash3/
- DeepSeek-V3 技术报告（MoE + EP 实战）：https://arxiv.org/abs/2412.19437
- Anthropic *Speculative Decoding* 综述：https://www.anthropic.com/news/claude-3-5-sonnet
- NVIDIA Hopper Tensor Core FP8：https://developer.nvidia.com/blog/nvidia-hopper-architecture-in-depth/
