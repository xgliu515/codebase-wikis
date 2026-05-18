# 第 5 章 KV Cache 管理（PagedAttention 在 V1 中的实现）

本章只关注 V1 架构（`vllm/v1/core/` + `vllm/v1/kv_cache_interface.py`）。所有行号引用对应本仓库当前 `main` 分支的源码。

KV cache 是 LLM 推理的内存大头，也是吞吐量的决定性资源。vLLM 的核心抽象是 **PagedAttention**：把每一层的 KV cache 当作"页式虚拟内存"管理，让逻辑 token 位置 → 物理 block 的映射可以任意拼接、复用、淘汰。本章逐层展开这套机制：物理内存怎么组织、谁拥有这些 block、prefix caching 如何把"前缀相同"映射成"物理 block 相同"，以及调度器/worker 如何通过 block table 把这些信息喂给 attention kernel。

---

## 5.1 总体架构与目录划分

```
vllm/v1/core/
├── block_pool.py                    # 物理 block 池（自由队列 + 哈希索引）
├── kv_cache_manager.py              # 给 scheduler 看的高层接口
├── kv_cache_coordinator.py          # 多 KV cache group 的协调器
├── single_type_kv_cache_manager.py  # 一种 attention 类型对应的管理器
├── kv_cache_utils.py                # 数据结构、block hash、容量规划工具
├── kv_cache_metrics.py              # 残留时间 / 复用间隔等指标采样
└── encoder_cache_manager.py         # encoder-decoder 模型的 encoder 缓存（不在本章主线）
vllm/v1/kv_cache_interface.py        # KVCacheSpec / KVCacheTensor / KVCacheConfig 抽象
```

调用栈分为三层（设计文档 `docs/design/hybrid_kv_cache_manager.md:208-227` 也以此图描述）。

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache 管理的四层分层：KVCacheManager / Coordinator / SingleType / BlockPool">
  <defs>
    <marker id="ch5ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">KV cache 的四层分层：从 scheduler 接口一路下到物理 block 池</text>
  <g transform="translate(40, 50)">
    <rect x="0" y="0" width="100" height="50" fill="#e2e8f0" stroke="#64748b" stroke-width="1.5" rx="6"/>
    <text x="50" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#1f2937">Scheduler</text>
    <text x="50" y="38" text-anchor="middle" font-size="9" fill="#475569">vllm/v1/core/sched</text>
  </g>
  <path d="M 140 75 L 215 75" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <text x="178" y="68" text-anchor="middle" font-size="9" fill="#64748b">调用</text>
  <g transform="translate(220, 50)">
    <rect x="0" y="0" width="320" height="50" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="160" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#7c2d12">KVCacheManager</text>
    <text x="160" y="38" text-anchor="middle" font-size="10" fill="#9a3412">kv_cache_manager.py · allocate_slots / free</text>
  </g>
  <text x="560" y="78" font-size="10" fill="#64748b" font-style="italic">高层接口（per-request 语义）</text>
  <path d="M 380 100 L 380 130" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <g transform="translate(190, 135)">
    <rect x="0" y="0" width="380" height="56" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="190" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#134e4a">KVCacheCoordinator</text>
    <text x="190" y="38" text-anchor="middle" font-size="10" fill="#115e59">kv_cache_coordinator.py · 多 group 协调</text>
    <text x="190" y="52" text-anchor="middle" font-size="9" fill="#0f766e">NoPrefixCache / Unitary / Hybrid</text>
  </g>
  <text x="60" y="170" font-size="10" fill="#64748b" font-style="italic">把同一个分配请求</text>
  <text x="60" y="184" font-size="10" fill="#64748b" font-style="italic">fanout 到每个 group</text>
  <path d="M 290 191 L 200 240" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <path d="M 380 191 L 380 240" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <path d="M 470 191 L 560 240" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <g transform="translate(40, 245)">
    <rect x="0" y="0" width="220" height="56" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="110" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#4c1d95">FullAttentionManager</text>
    <text x="110" y="38" text-anchor="middle" font-size="10" fill="#5b21b6">single_type_kv_cache_manager.py</text>
    <text x="110" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">left-to-right 命中扫描</text>
  </g>
  <g transform="translate(270, 245)">
    <rect x="0" y="0" width="220" height="56" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="110" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#4c1d95">SlidingWindowManager</text>
    <text x="110" y="38" text-anchor="middle" font-size="10" fill="#5b21b6">single_type_kv_cache_manager.py</text>
    <text x="110" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">right-to-left + 窗口对齐</text>
  </g>
  <g transform="translate(500, 245)">
    <rect x="0" y="0" width="220" height="56" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6" stroke-dasharray="4,3"/>
    <text x="110" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#4c1d95">Mamba / CrossAttn / ...</text>
    <text x="110" y="38" text-anchor="middle" font-size="10" fill="#5b21b6">per-attn-type 实现</text>
    <text x="110" y="52" text-anchor="middle" font-size="9" fill="#6d28d9">未来可继续扩展</text>
  </g>
  <text x="700" y="275" text-anchor="end" font-size="10" fill="#64748b" font-style="italic" transform="translate(40, 0)">per-attn-type 算法</text>
  <path d="M 150 301 L 340 350" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <path d="M 380 301 L 380 350" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <path d="M 610 301 L 420 350" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar1)"/>
  <text x="200" y="333" text-anchor="middle" font-size="9" fill="#64748b">借块</text>
  <g transform="translate(220, 355)">
    <rect x="0" y="0" width="320" height="56" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5" rx="6"/>
    <text x="160" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">BlockPool</text>
    <text x="160" y="38" text-anchor="middle" font-size="10" fill="#92400e">block_pool.py · 唯一持有 KVCacheBlock 的地方</text>
    <text x="160" y="52" text-anchor="middle" font-size="9" fill="#a16207">free queue (双向链表 LRU) + hash 索引 + ref_cnt</text>
  </g>
  <text x="560" y="385" font-size="10" fill="#64748b" font-style="italic">物理 block 所有权</text>
  <text x="560" y="400" font-size="10" fill="#64748b" font-style="italic">（不知道 attention 类型）</text>
  <g transform="translate(40, 425)">
    <text x="0" y="0" font-size="10" fill="#94a3b8" font-style="italic">每层只看到下一层的接口：单类型管理器之间彼此对称，coordinator fanout，BlockPool 只关心 block id 与 ref_cnt。</text>
  </g>
</svg>
<span class="figure-caption">图 R5.1 ｜ KV cache 管理的四层分层：上层 KVCacheManager 给 scheduler 用，往下经 Coordinator 把动作 fanout 到每个 attention 类型的 SingleTypeKVCacheManager，最底层 BlockPool 拥有所有 KVCacheBlock 对象</span>

<details>
<summary>ASCII 原版</summary>

```
                  +------------------------------+
   Scheduler ---> |        KVCacheManager        |   高层接口
                  |   (kv_cache_manager.py)      |   allocate_slots / free
                  +---------------+--------------+
                                  |
                                  v
                  +------------------------------+
                  |     KVCacheCoordinator       |   协调多 group 的 allocate/cache hit
                  |   (kv_cache_coordinator.py)  |   - NoPrefixCache / Unitary / Hybrid
                  +---------------+--------------+
                                  |
              +-------------------+-------------------+
              v                                       v
   +-------------------------+         +-------------------------+
   | SingleTypeKVCacheManager|         | SingleTypeKVCacheManager|  per-attn-type
   |  (FullAttentionManager) |   ...   |  (SlidingWindowManager) |
   +-----------+-------------+         +-----------+-------------+
               \\                                  /
                v                                v
                  +------------------------------+
                  |          BlockPool           |   物理 block 池
                  |       (block_pool.py)        |   free queue + hash map
                  +------------------------------+
```

</details>

每一层的职责边界很清晰：

| 组件 | 职责 | 不负责什么 |
|------|------|------------|
| `KVCacheManager` (`kv_cache_manager.py:110`) | 给 scheduler 暴露 per-request 语义：`allocate_slots`、`free`、`get_computed_blocks` | 不直接操纵 block，全部转发给 coordinator |
| `KVCacheCoordinator` (`kv_cache_coordinator.py:28`) | 跨 group 把 N 个 `SingleTypeKVCacheManager` 聚合成一个原子的"分配请求" | 不存储 per-request 状态（状态在 single-type 里） |
| `SingleTypeKVCacheManager` (`single_type_kv_cache_manager.py:31`) | 实现某种 attention 类型的"分配/释放/缓存命中"算法 | 不持有物理块，全部去 `BlockPool` 借 |
| `BlockPool` (`block_pool.py:130`) | 物理 block 的所有权、引用计数、free queue（LRU 淘汰候选）、prefix hash 索引 | 不知道任何"请求"或"attention 类型"语义 |

这种分层的"为什么"：单类型管理器之间彼此完全对称（接口靠抽象基类强约束 `single_type_kv_cache_manager.py:31-478`）；coordinator 只需要把同一个动作 fanout 到每个 manager 上；最底层的 `BlockPool` 只关心 block id 和 ref count，让 prefix cache、KV connector、metrics 等正交特性都能挂上来。

---

## 5.2 KV cache 的物理布局

### 5.2.1 一个 block 是什么

对 full attention 而言，一层的 KV cache 是一个 4D tensor：

```
shape = (num_blocks, block_size, num_kv_heads, head_size)   # K 或 V
```

带上 K/V 维度，FlashAttention backend 给出的 shape 是 `(2, num_blocks, block_size, num_heads, head_size)`，见 `flash_attn.py:140-149`：

```python
@staticmethod
def get_kv_cache_shape(
    num_blocks: int,
    block_size: int,
    num_kv_heads: int,
    head_size: int,
    cache_dtype_str: str = "auto",
) -> tuple[int, ...]:
    if block_size % 16 != 0:
        raise ValueError("Block size must be a multiple of 16.")
    return (2, num_blocks, block_size, num_kv_heads, head_size)
```

一个 "block" 是 `block_size` 个 token 在某一层上的 K 和 V 切片。物理上，每个 block 占用：

```
page_size_bytes = 2 * block_size * num_kv_heads * head_size * dtype_size
```

这是 `AttentionSpec.real_page_size_bytes`（`kv_cache_interface.py:166-185`）的定义。注意它**不包含 layer 维度**——一层一个独立的 `(num_blocks, ...)` 大 tensor。

### 5.2.2 多 layer 的组织：m 个共享 tensor

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="多 layer 的 KV cache 组织：m 个 KVCacheTensor，每层一个，统一按 block_id 索引">
  <defs>
    <marker id="ch5ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">m 层 = m 个独立的 KVCacheTensor，共享同一组 block_id</text>
  <g transform="translate(40, 50)">
    <text x="0" y="0" font-size="11" font-weight="600" fill="currentColor">worker 端实际分配的物理内存（per-layer 独立 buffer）</text>
  </g>
  <g transform="translate(40, 64)">
    <rect x="0" y="0" width="640" height="56" fill="#fff7ed" stroke="#fdba74" rx="4"/>
    <text x="10" y="14" font-size="10" font-weight="700" fill="#9a3412">KVCacheTensor 0</text>
    <text x="630" y="14" text-anchor="end" font-size="9" fill="#7c2d12" font-style="italic">shared_by = [layer.0]</text>
    <g transform="translate(10, 22)">
      <rect x="0" y="0" width="100" height="26" fill="#ea580c"/>
      <text x="50" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 0</text>
      <rect x="102" y="0" width="100" height="26" fill="#ea580c"/>
      <text x="152" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 1</text>
      <rect x="204" y="0" width="100" height="26" fill="#ea580c"/>
      <text x="254" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 2</text>
      <rect x="306" y="0" width="100" height="26" fill="#fed7aa" stroke="#ea580c" stroke-dasharray="3,2"/>
      <text x="356" y="17" text-anchor="middle" font-size="10" fill="#7c2d12">...</text>
      <rect x="408" y="0" width="212" height="26" fill="#ea580c"/>
      <text x="514" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block (num_blocks-1)</text>
    </g>
  </g>
  <g transform="translate(40, 130)">
    <rect x="0" y="0" width="640" height="56" fill="#ecfeff" stroke="#5eead4" rx="4"/>
    <text x="10" y="14" font-size="10" font-weight="700" fill="#115e59">KVCacheTensor 1</text>
    <text x="630" y="14" text-anchor="end" font-size="9" fill="#134e4a" font-style="italic">shared_by = [layer.1]</text>
    <g transform="translate(10, 22)">
      <rect x="0" y="0" width="100" height="26" fill="#0d9488"/>
      <text x="50" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 0</text>
      <rect x="102" y="0" width="100" height="26" fill="#0d9488"/>
      <text x="152" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 1</text>
      <rect x="204" y="0" width="100" height="26" fill="#0d9488"/>
      <text x="254" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 2</text>
      <rect x="306" y="0" width="100" height="26" fill="#99f6e4" stroke="#0d9488" stroke-dasharray="3,2"/>
      <text x="356" y="17" text-anchor="middle" font-size="10" fill="#134e4a">...</text>
      <rect x="408" y="0" width="212" height="26" fill="#0d9488"/>
      <text x="514" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block (num_blocks-1)</text>
    </g>
  </g>
  <g transform="translate(40, 196)">
    <text x="320" y="14" text-anchor="middle" font-size="13" font-weight="700" fill="#94a3b8">⋮</text>
  </g>
  <g transform="translate(40, 216)">
    <rect x="0" y="0" width="640" height="56" fill="#f5f3ff" stroke="#c4b5fd" rx="4"/>
    <text x="10" y="14" font-size="10" font-weight="700" fill="#5b21b6">KVCacheTensor (m-1)</text>
    <text x="630" y="14" text-anchor="end" font-size="9" fill="#4c1d95" font-style="italic">shared_by = [layer.(m-1)]</text>
    <g transform="translate(10, 22)">
      <rect x="0" y="0" width="100" height="26" fill="#7c3aed"/>
      <text x="50" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 0</text>
      <rect x="102" y="0" width="100" height="26" fill="#7c3aed"/>
      <text x="152" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 1</text>
      <rect x="204" y="0" width="100" height="26" fill="#7c3aed"/>
      <text x="254" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block 2</text>
      <rect x="306" y="0" width="100" height="26" fill="#ddd6fe" stroke="#7c3aed" stroke-dasharray="3,2"/>
      <text x="356" y="17" text-anchor="middle" font-size="10" fill="#4c1d95">...</text>
      <rect x="408" y="0" width="212" height="26" fill="#7c3aed"/>
      <text x="514" y="17" text-anchor="middle" font-size="10" font-weight="600" fill="white">block (num_blocks-1)</text>
    </g>
  </g>
  <g transform="translate(40, 290)">
    <rect x="0" y="0" width="680" height="68" fill="#fef3c7" stroke="#facc15" rx="4"/>
    <text x="340" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#78350f">KVCacheManager 看到的逻辑视图</text>
    <text x="340" y="38" text-anchor="middle" font-size="11" fill="#92400e">block_id ∈ [0, num_blocks)   ——只有一个数字</text>
    <text x="340" y="56" text-anchor="middle" font-size="11" fill="#92400e">一个 block_id 同时对应所有 m 层在该 block 上的 KV 切片</text>
  </g>
</svg>
<span class="figure-caption">图 R5.2 ｜ m 层 = m 个独立的 KVCacheTensor（每个是连续显存），但所有层共用同一套 block_id 索引——scheduler 只需追踪一个数字，worker 端按 layer 取自己的 buffer</span>

<details>
<summary>ASCII 原版</summary>

```
KV cache tensors（worker 端实际分配的物理内存）
┌──────────────────────────────────────────────────────────────────┐
│  KVCacheTensor 0                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ block 0 │ block 1 │ block 2 │ ... │ block (num_blocks-1)   │  │
│  └────────────────────────────────────────────────────────────┘  │
│  shared_by = [layer.0]                                           │
├──────────────────────────────────────────────────────────────────┤
│  KVCacheTensor 1                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ block 0 │ block 1 │ block 2 │ ... │ block (num_blocks-1)   │  │
│  └────────────────────────────────────────────────────────────┘  │
│  shared_by = [layer.1]                                           │
├──────────────────────────────────────────────────────────────────┤
│  ...                                                             │
├──────────────────────────────────────────────────────────────────┤
│  KVCacheTensor (m-1)                                             │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ block 0 │ block 1 │ block 2 │ ... │ block (num_blocks-1)   │  │
│  └────────────────────────────────────────────────────────────┘  │
│  shared_by = [layer.(m-1)]                                       │
└──────────────────────────────────────────────────────────────────┘

KVCacheManager 持有的逻辑视图：
   block_id ∈ [0, num_blocks)
   一个 block_id 同时对应所有 layer 在该 block 上的 KV 切片
```

</details>

`KVCacheTensor` 在 `kv_cache_interface.py:810-818` 定义：

```python
@dataclass
class KVCacheTensor:
    size: int                # 字节数
    shared_by: list[str]     # 共享该 tensor 的 layer 名字
```

为什么不把"layer × block × token × head × dim"塞进一个 5D 大 tensor？因为 hybrid 模型（见 5.8）里不同 group 的 layer 数不同；按 layer 切开后每个 buffer 仍是连续显存，cudagraph 与 backend 不需要关心更多维度。worker 侧的分配代码在 `gpu_model_runner.py:6780-6810`：

```python
for kv_cache_tensor in kv_cache_config.kv_cache_tensors:
    tensor = torch.zeros(
        kv_cache_tensor.size, dtype=torch.int8, device=self.device
    )
    for layer_name in kv_cache_tensor.shared_by:
        kv_cache_raw_tensors[layer_name] = tensor
```

先按字节分配，然后 `_reshape_kv_cache_tensors`（`gpu_model_runner.py:6821-6946`）按 backend 给出的 shape `view()` 出真正的 5D/4D 视图。

### 5.2.3 为什么按 block 组织

PagedAttention 的核心动机：**一条序列在 KV cache 中的物理位置可以不连续**。

- 若按序列连续分配，必须预留 `max_model_len` 的连续地址，碰撞、外部碎片严重。
- 按固定大小 block 切分后，每条序列只是 block id 的**列表**，新增 token 只需要再申请一个 block。
- block id 与序列彻底解耦后，相同 prefix 的两条序列可以**共享同一组 block id**——这就是 prefix caching 的物理基础。

V1 的 `block_size` 默认 16，必须能被 attention kernel 接受（FlashAttention 要求 `block_size % 16 == 0`，`flash_attn.py:147-148`）。

---

## 5.3 Block table：从逻辑位置到物理 block 的映射

每个请求拥有一个 block table，它就是一个 `int32` 数组，下标是"逻辑 block 序号"（即 `token_pos // block_size`），值是物理 `block_id`。

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="block_table 把逻辑 block 序号映射到物理 block id：4 个逻辑块对应 4 个分散的物理块">
  <defs>
    <marker id="ch5ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">block_table[req]：逻辑 block 序号 → 物理 block id 的小数组</text>
  <text x="40" y="50" font-size="11" font-weight="600" fill="currentColor">逻辑 token 视角（连续）</text>
  <g transform="translate(40, 60)">
    <rect x="0" y="0" width="160" height="22" fill="#fff7ed" stroke="#fdba74"/>
    <text x="80" y="15" text-anchor="middle" font-size="10" fill="#9a3412">token 0 1 2 3 ... 15</text>
    <rect x="160" y="0" width="160" height="22" fill="#ecfeff" stroke="#5eead4"/>
    <text x="240" y="15" text-anchor="middle" font-size="10" fill="#134e4a">token 16 ... 31</text>
    <rect x="320" y="0" width="160" height="22" fill="#f5f3ff" stroke="#c4b5fd"/>
    <text x="400" y="15" text-anchor="middle" font-size="10" fill="#4c1d95">token 32 ... 47</text>
    <rect x="480" y="0" width="160" height="22" fill="#fffbeb" stroke="#fde68a"/>
    <text x="560" y="15" text-anchor="middle" font-size="10" fill="#92400e">token 48 ... 63</text>
  </g>
  <g transform="translate(40, 86)">
    <text x="80" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">逻辑 block 0</text>
    <text x="240" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">逻辑 block 1</text>
    <text x="400" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">逻辑 block 2</text>
    <text x="560" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="#78350f">逻辑 block 3</text>
  </g>
  <text x="40" y="130" font-size="11" font-weight="600" fill="currentColor">block_table[req]（每个请求一行 int32 数组）</text>
  <g transform="translate(40, 140)">
    <rect x="0" y="0" width="160" height="38" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
    <text x="80" y="16" text-anchor="middle" font-size="10" fill="#7c2d12">下标 0</text>
    <text x="80" y="32" text-anchor="middle" font-size="15" font-weight="700" fill="#9a3412">17</text>
    <rect x="160" y="0" width="160" height="38" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
    <text x="240" y="16" text-anchor="middle" font-size="10" fill="#134e4a">下标 1</text>
    <text x="240" y="32" text-anchor="middle" font-size="15" font-weight="700" fill="#115e59">42</text>
    <rect x="320" y="0" width="160" height="38" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
    <text x="400" y="16" text-anchor="middle" font-size="10" fill="#4c1d95">下标 2</text>
    <text x="400" y="32" text-anchor="middle" font-size="15" font-weight="700" fill="#5b21b6">5</text>
    <rect x="480" y="0" width="160" height="38" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.4"/>
    <text x="560" y="16" text-anchor="middle" font-size="10" fill="#78350f">下标 3</text>
    <text x="560" y="32" text-anchor="middle" font-size="15" font-weight="700" fill="#92400e">108</text>
  </g>
  <text x="40" y="210" font-size="11" font-weight="600" fill="currentColor">物理 block 池（每个 KVCacheTensor 内部，按 block_id 索引）</text>
  <g transform="translate(40, 222)">
    <rect x="0" y="0" width="40" height="36" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="20" y="22" text-anchor="middle" font-size="10" fill="#94a3b8">0</text>
    <rect x="42" y="0" width="40" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
    <text x="62" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">5</text>
    <rect x="84" y="0" width="120" height="36" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="144" y="22" text-anchor="middle" font-size="10" fill="#94a3b8">… free / 别的 req …</text>
    <rect x="206" y="0" width="40" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
    <text x="226" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">17</text>
    <rect x="248" y="0" width="120" height="36" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="308" y="22" text-anchor="middle" font-size="10" fill="#94a3b8">…</text>
    <rect x="370" y="0" width="40" height="36" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
    <text x="390" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">42</text>
    <rect x="412" y="0" width="180" height="36" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="502" y="22" text-anchor="middle" font-size="10" fill="#94a3b8">… free / 别的 req …</text>
    <rect x="594" y="0" width="46" height="36" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.4"/>
    <text x="617" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">108</text>
  </g>
  <path d="M 80 178 Q 80 196 226 220" fill="none" stroke="#ea580c" stroke-width="1.3" stroke-dasharray="3,2" marker-end="url(#ch5ar3)" opacity="0.75"/>
  <path d="M 240 178 Q 240 196 390 220" fill="none" stroke="#0d9488" stroke-width="1.3" stroke-dasharray="3,2" marker-end="url(#ch5ar3)" opacity="0.75"/>
  <path d="M 400 178 Q 400 196 62 220" fill="none" stroke="#7c3aed" stroke-width="1.3" stroke-dasharray="3,2" marker-end="url(#ch5ar3)" opacity="0.75"/>
  <path d="M 560 178 Q 560 196 617 220" fill="none" stroke="#f59e0b" stroke-width="1.3" stroke-dasharray="3,2" marker-end="url(#ch5ar3)" opacity="0.75"/>
  <g transform="translate(40, 290)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">读这张图：</tspan>逻辑上 token 序号连续，物理上 4 个 block 散落在池子里；block_table 这一层 int32 间接表把"逻辑顺序"重新组装出来。</tspan>
      <tspan x="0" dy="18" fill="#94a3b8" font-style="italic">attention kernel 拿到 block_table 后，自己在 inner loop 里查表 → 加载对应物理 block 的 KV 到 SRAM。这跟 OS 的「页表 + MMU」是同一招。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R5.3 ｜ block_table 是每个 request 的一行 int32 数组：下标 = 逻辑 block 序号（token_pos / block_size），值 = 物理 block id；逻辑连续 ↔ 物理散落，全靠这层间接表</span>

<details>
<summary>ASCII 原版</summary>

```
逻辑 token 序号:    0  1  2  3 | 4  5  6  7 | 8  9 10 11 | 12 13 14 15
逻辑 block 序号:    0           | 1           | 2           | 3
                    v             v             v             v
block_table[req]:  [ 17,           42,           5,            108 ]
                    ^             ^             ^             ^
                    KVCacheTensor 0/.../m-1 的第 17 块
```

</details>

物理上，scheduler 的 KV cache manager 输出的"block id 列表"被复制到 worker 端的 `BlockTable.block_table`（`vllm/v1/worker/block_table.py:70-72`）：

```python
self.block_table = self._make_buffer(
    self.max_num_reqs, self.max_num_blocks_per_req, dtype=torch.int32
)
```

这是一个 `(max_num_reqs, max_num_blocks_per_req)` 的 GPU tensor。每行对应一个请求槽位。在每一 step：

1. scheduler 调 `KVCacheManager.allocate_slots()` 得到本步新增的 block ids（`scheduler.py:438-448`）。
2. scheduler 把 `block_ids` 通过 `req_to_new_blocks` 传给 model runner。
3. model runner 在 `BlockTable.append_row()`（`block_table.py:102-118`）追加这些 id 到对应行。
4. attention metadata builder 把行截到本 step 的实际长度，作为 `block_table` 字段塞进 `FlashAttentionMetadata`（`flash_attn.py:237`）。
5. attention kernel 读 `block_table[req_idx, logical_block_idx]` 得到物理 `block_id`，再加上 `block_offset`，按 stride 寻址到具体 token 的 KV 行。

`slot_mapping` 是 `block_table` 的一个 token 粒度展开：对本 step 要写入 KV 的每一个 token，告诉 kernel 在物理内存中的"插槽编号"（`block_id * block_size + offset`）。它由 triton kernel `_compute_slot_mapping_kernel`（`block_table.py:325-381`）计算：

```python
block_indices = pos // virtual_block_size
block_numbers = tl.load(block_table_ptr + row_offset + block_indices).to(tl.int64)
...
slot_ids = block_numbers * block_size + local_block_offsets
```

`block_table` 在 attention kernel 中负责"读旧 KV"，`slot_mapping` 负责"写新 KV"。两者都是 PagedAttention 的关键产物，由 KVCacheManager 间接决定（KVCacheManager 给的是 block ids，slot_mapping 是其推论）。

### 5.3.1 Block table 与 kernel block size 解耦

KV cache 的分配 block size（`KVCacheSpec.block_size`）与 kernel 实际操作的 block size 可以不同，`BlockTable.__init__` 处理这种情况（`block_table.py:47-66`）：当 `kernel_block_size != block_size` 时，每个分配 block 被拆成多个 kernel block，append 时通过 `map_to_kernel_blocks`（`block_table.py:173-201`）展开。这让上层分配单位可以更大（hybrid 模型常用），底层 kernel 仍按它擅长的 block size 工作。

---

## 5.4 BlockPool：物理 block 的所有权

`BlockPool`（`block_pool.py:130-520`）是唯一持有 `KVCacheBlock` 对象的地方。

### 5.4.1 KVCacheBlock 与自由队列

`KVCacheBlock`（`kv_cache_utils.py:115-161`）是 metadata，不是数据本身：

```python
@dataclass(slots=True)
class KVCacheBlock:
    block_id: int                  # [0, num_gpu_blocks)
    ref_cnt: int = 0               # 引用计数
    _block_hash: BlockHashWithGroupId | None = None  # 用于 prefix cache 检索
    prev_free_block: "KVCacheBlock | None" = None    # 自由队列指针（双向链表）
    next_free_block: "KVCacheBlock | None" = None
    is_null: bool = False          # 占位空块
```

注意：**这里没有任何 tensor 引用**。block 只是一个 id；id 到物理内存的映射在 worker 侧的 `KVCacheTensor` 上完成。这种分离让 scheduler 进程不持有任何 GPU 内存。

`FreeKVCacheBlockQueue`（`kv_cache_utils.py:164-372`）是一条**手写双向链表**，没有用 `collections.deque`。为什么？因为 LRU 淘汰要求"从中间 O(1) 删除"——一个被复用的 cached block 必须立刻从自由队列里拔出来。`deque` 不支持这种操作；`block_table.py` 不用 Python 对象层的链表节点，而是**直接复用 KVCacheBlock 自己的 prev/next 指针**，省掉额外 GC 压力。

队列的语义（`kv_cache_utils.py:170-184`）：

- 头部 = 最先被淘汰候选（LRU）。
- 同一请求的多个 block 释放时按"尾→头"反向加入，使 chain 末尾的 block 先被淘汰——这保证了链式 prefix 的根 block 更难被淘汰。详见 `block_pool.py:419-433` `free_blocks` 注释和 `single_type_kv_cache_manager.py:338-353` `SingleTypeKVCacheManager.free` 中的 `reversed(req_blocks)`。

### 5.4.2 ref_cnt 与"自由 = 可淘汰"语义

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KVCacheBlock 的 ref_cnt 状态机：in free / in use，以及与 prefix cache 哈希表的正交关系">
  <defs>
    <marker id="ch5ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ch5ar4o" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
    <marker id="ch5ar4t" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">KVCacheBlock 状态机：ref_cnt 与 block_hash 是两个正交属性</text>
  <g transform="translate(60, 60)">
    <rect x="0" y="0" width="240" height="100" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5" rx="8"/>
    <text x="120" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="#475569">in free queue</text>
    <line x1="14" y1="34" x2="226" y2="34" stroke="#cbd5e1"/>
    <text x="120" y="52" text-anchor="middle" font-size="11" fill="#475569">ref_cnt == 0</text>
    <text x="120" y="70" text-anchor="middle" font-size="11" fill="#475569">在 FreeKVCacheBlockQueue 链上</text>
    <text x="120" y="88" text-anchor="middle" font-size="10" fill="#64748b" font-style="italic">下一次 get_new_blocks 会弹它出去</text>
  </g>
  <g transform="translate(460, 60)">
    <rect x="0" y="0" width="240" height="100" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="8"/>
    <text x="120" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="#7c2d12">in use</text>
    <line x1="14" y1="34" x2="226" y2="34" stroke="#fdba74"/>
    <text x="120" y="52" text-anchor="middle" font-size="11" fill="#9a3412">ref_cnt ≥ 1</text>
    <text x="120" y="70" text-anchor="middle" font-size="11" fill="#9a3412">不在 free queue</text>
    <text x="120" y="88" text-anchor="middle" font-size="10" fill="#7c2d12" font-style="italic">被一个或多个 request hold</text>
  </g>
  <path d="M 300 95 L 458 95" fill="none" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ch5ar4o)"/>
  <text x="378" y="86" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">touch / allocate</text>
  <text x="378" y="108" text-anchor="middle" font-size="10" fill="#7c2d12">ref_cnt: 0 → 1，从链上 remove</text>
  <path d="M 458 130 L 300 130" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#ch5ar4t)"/>
  <text x="378" y="123" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">free（ref_cnt → 0）</text>
  <text x="378" y="146" text-anchor="middle" font-size="10" fill="#134e4a">归零者 append 回 free queue 尾</text>
  <g transform="translate(180, 200)">
    <rect x="0" y="0" width="400" height="100" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5" rx="8"/>
    <text x="200" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="#78350f">cached_block_hash_to_block</text>
    <line x1="14" y1="34" x2="386" y2="34" stroke="#fde68a"/>
    <text x="200" y="52" text-anchor="middle" font-size="11" fill="#92400e">block_hash → KVCacheBlock</text>
    <text x="200" y="70" text-anchor="middle" font-size="11" fill="#92400e">凡是 block_hash != None 的 block 都在这里</text>
    <text x="200" y="88" text-anchor="middle" font-size="10" fill="#78350f" font-style="italic">与 ref_cnt 正交：被驱逐 / in-use / free 三种状态都可能在表里</text>
  </g>
  <path d="M 180 100 Q 60 200 220 198" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ch5ar4)" opacity="0.7"/>
  <text x="36" y="216" font-size="10" fill="#64748b" font-style="italic">ref_cnt=0 但仍可命中</text>
  <text x="36" y="230" font-size="10" fill="#64748b" font-style="italic">→「已驱逐 cached」</text>
  <path d="M 580 100 Q 720 200 540 198" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ch5ar4)" opacity="0.7"/>
  <text x="640" y="216" font-size="10" fill="#64748b" font-style="italic">in-use 也可命中</text>
  <text x="640" y="230" font-size="10" fill="#64748b" font-style="italic">→ 并发 hit，ref_cnt++</text>
  <g transform="translate(40, 320)">
    <text x="0" y="0" font-size="10" fill="#94a3b8" font-style="italic">关键性质：「free」≠「失效」。一个 block 可以 ref_cnt=0、躺在 free queue、同时仍是 prefix cache 命中候选；只有真的被 get_new_blocks 拿去重分配时才从 hash 表拔出。</text>
  </g>
</svg>
<span class="figure-caption">图 R5.4 ｜ KVCacheBlock 的两个正交属性：ref_cnt（in free queue ↔ in use）与 block_hash（是否在 prefix cache 表里）；「ref_cnt=0 但仍在 hash 表」就是「已驱逐但仍可命中」的 cached block</span>

<details>
<summary>ASCII 原版</summary>

```
        +---------+    touch / allocate    +-----------+
        | in free |  ------------------->  | in use    |
        | queue   |       ref_cnt: 0 → 1   | ref_cnt≥1 |
        | ref_cnt |                        | not in    |
        |  == 0   |  <-------------------  | free queue|
        +---------+    free (ref_cnt→0)    +-----------+
            ^                                   |
            |                                   | (when cached)
            |                                   v
            |                              +-----------------+
            +------------------------------+ also indexed by |
                                           | block_hash      |
                                           +-----------------+
```

</details>

关键性质：**`ref_cnt == 0` 但仍可能在 `cached_block_hash_to_block` 哈希表中**——这就是"已驱逐的 cached block"——它仍是 prefix cache 命中候选，但一旦被 `get_new_blocks` 重新分配，会从哈希表中拔出（`block_pool.py:344-364`）：

```python
ret: list[KVCacheBlock] = self.free_block_queue.popleft_n(num_blocks)
if self.enable_caching:
    for block in ret:
        self._maybe_evict_cached_block(block)   # 清掉 hash → block 索引
        assert block.ref_cnt == 0
        block.ref_cnt += 1
```

`touch()`（`block_pool.py:402-417`）用于"prefix cache 命中后接管这些 block"：把它们从 free 队列里 `remove()` 出来，并把 ref_cnt + 1。

`free_blocks()`（`block_pool.py:419-433`）：ref_cnt 减 1，归零者 append 回 free 队列。注意 `is_null` 的块永远不入队列。

### 5.4.3 Null block：占位的不可释放空块

`__init__` 的最后一步（`block_pool.py:176-177`）：

```python
self.null_block = self.free_block_queue.popleft()
self.null_block.is_null = True
```

block 0 永远是 null block。它用于：

- 占位被"跳过"的逻辑位置。sliding window 把窗口外的逻辑 block 替换成 null block，使 block table 的 index 仍然对应 token 位置（见 `single_type_kv_cache_manager.py:443-461`）。
- mamba "align" 模式占位被搬迁状态的旧 block。
- 让 `get_usage()`（`block_pool.py:497-508`）减 1 时分母不为零。

null block 的 `ref_cnt` 不维护，永远不能 free——`free_blocks` 跳过它，`get_new_blocks` 在它被弹出时也会跳过。

---

## 5.5 KVCacheManager：scheduler 的接口

### 5.5.1 关键方法摘录

```python
class KVCacheManager:                                            # kv_cache_manager.py:110
    @property
    def usage(self) -> float: ...                                # block 池占用 [0,1]
    def get_computed_blocks(self, request) -> tuple[KVCacheBlocks, int]: ...  # 194
    def allocate_slots(self, request, num_new_tokens, ...) -> KVCacheBlocks | None:  # 236
    def free(self, request) -> None: ...                         # 429
    def get_block_ids(self, request_id) -> tuple[list[int], ...]: ...        # 540
    def cache_blocks(self, request, num_computed_tokens) -> None: ...        # 544
    def take_new_block_ids(self) -> list[int]: ...               # 561 (zeroing)
    def get_num_common_prefix_blocks(self, running_request_id) -> list[int]: ...  # 476
    def reset_prefix_cache(self) -> bool: ...                    # 460
    def evict_blocks(self, block_ids: set[int]) -> None: ...     # 452
    def take_events(self) -> list[KVCacheEvent]: ...             # 510
```

scheduler 持有唯一一个 `KVCacheManager` 实例（`scheduler.py:225-237`），所有 KV cache 相关动作都从这里出去。

### 5.5.2 `get_computed_blocks`：prefix cache 查询

```python
def get_computed_blocks(self, request: Request) -> tuple[KVCacheBlocks, int]:    # 194
    if not self.enable_caching or request.skip_reading_prefix_cache:
        return self.empty_kv_cache_blocks, 0

    # 至少留一个 token 用来求 logits
    max_cache_hit_length = request.num_tokens - 1
    computed_blocks, num_new_computed_tokens = (
        self.coordinator.find_longest_cache_hit(
            request.block_hashes, max_cache_hit_length
        )
    )
    return self.create_kv_cache_blocks(computed_blocks), num_new_computed_tokens
```

返回的是"哪些已 cached 的 block 可以直接接管"。注意它**不修改任何 ref_cnt**——只是查询。真正的"接管"在 `allocate_slots` → `coordinator.allocate_new_computed_blocks` → `BlockPool.touch` 里完成。

为什么要留最后一个 token？因为生成第一个新 token 必须有 logits，而 logits 来自 attention 的输出；如果整个 prefix 都命中，就没有"被计算"的最后一步可言。所以最大命中长度被夹在 `num_tokens - 1`。

### 5.5.3 `allocate_slots`：核心分配方法

`allocate_slots`（`kv_cache_manager.py:236-427`）是整个模块最复杂的方法。它处理：

```
分配 = 释放窗口外的旧 block
     + 接管 prefix cache 命中的 block（touch + 加入 req）
     + 为外部 connector 已缓存的 token 分配新 block
     + 为本步新 token + lookahead 分配新 block
     + 缓存满块（cache_blocks）
```

注释里画出的 token 分段图（截选自 `kv_cache_manager.py:273-294`）：

```
----------------------------------------------------------------------
| < comp > | < new_comp > | < ext_comp >  | < new >  | < lookahead > |
----------------------------------------------------------------------
                                          |   < to be computed >     |
----------------------------------------------------------------------
                          |            < to be allocated >           |
----------------------------------------------------------------------
                          | < to be cached (roughly, |
                          | details below)>          |
----------------------------------------------------------------------
```

执行三步（`kv_cache_manager.py:311-318`）：

1. **释放窗口外的 block**：调 `coordinator.remove_skipped_blocks`。这一步必须先做，否则 `get_num_blocks_to_allocate` 把要释放的块计入"必须保留"，会高估需求。
2. **预算 + 接管**：`coordinator.get_num_blocks_to_allocate(...)` 返回净需求；若 free 池不够，返回 `None`（让调度器降级或排队）；够了就 `coordinator.allocate_new_computed_blocks` touch 住命中块、`coordinator.allocate_new_blocks` 取新块。
3. **缓存**：`coordinator.cache_blocks(request, num_tokens_to_cache)` 把刚算完的 full block 写入 prefix hash 表。

返回 `None` 是 scheduler 的"内存不足"信号；返回 `KVCacheBlocks` 表示"本步可调度"，其中 `blocks` 字段按 group 分桶（`KVCacheBlocks.blocks: tuple[Sequence[KVCacheBlock], ...]`，`kv_cache_manager.py:25-46`）。

### 5.5.4 `KVCacheBlocks`：scheduler 看到的"分配结果"

```python
@dataclass
class KVCacheBlocks:
    blocks: tuple[Sequence[KVCacheBlock], ...]   # 外层按 group，内层是 block 列表
```

为什么外层是 group 而不是 token？因为不同 group 的 block_size 可以不同（hybrid 模型）；如果用"按 token 切片"，会假设所有 group 同 block_size。

`get_block_ids` (`kv_cache_manager.py:69-84`) 把它降维成 `tuple[list[int], ...]`，正是 worker 端 `MultiGroupBlockTable.append_row` 需要的形态（`block_table.py:283-285`）。

### 5.5.5 `free`：归还顺序很关键

```python
def free(self, request: Request) -> None:
    self.coordinator.free(request.request_id)
```

底层（`single_type_kv_cache_manager.py:338-353`）：

```python
req_blocks = self.req_to_blocks.pop(request_id, [])
ordered_blocks = reversed(req_blocks)   # 尾部先释放
self.block_pool.free_blocks(ordered_blocks)
```

**为什么要 reversed？** 因为 free 队列尾部先被淘汰，而我们希望**链尾（深前缀）的 block 先被淘汰**——它们被复用的概率小于"靠近根"的 block。这是用 LRU 队列实现"prefix tree 式优先级"的 trick：把高价值（共享前缀）的根 block 推到队尾。

---

## 5.6 Prefix Caching 算法

### 5.6.1 Block hash：链式构造

```python
def hash_block_tokens(
    hash_function: Callable[[Any], bytes],
    parent_block_hash: BlockHash | None,
    curr_block_token_ids: Sequence[int],
    extra_keys: tuple[Any, ...] | None = None,
) -> BlockHash:                                                 # kv_cache_utils.py:541
    if not parent_block_hash:
        parent_block_hash = NONE_HASH
    curr_block_token_ids_tuple = tuple(curr_block_token_ids)
    return BlockHash(
        hash_function((parent_block_hash, curr_block_token_ids_tuple, extra_keys))
    )
```

每个 block 的 hash = `H(parent_hash, current_block_tokens, extra_keys)`。这是一条**链式哈希**，意义是：

- 如果两条请求有相同前缀，它们前缀部分的 block hash 完全相同；后缀第一次出现差异时，从那个 block 开始 hash 序列分叉。
- 给定一个 hash，意味着确认了"从开头到本 block 的所有 token"完全一致——这正是"安全复用"的充要条件。
- 这把 prefix tree 在哈希空间里"扁平化"为一个 `{block_hash: block}` 字典，免去显式维护 trie 的指针开销。

`extra_keys` 包含多模态特征 hash、LoRA name、cache_salt、prompt embeds hash（`kv_cache_utils.py:503-538`）——任何能让"相同 token id 序列实际语义不同"的因素，都必须并入 hash key，否则会产生错误命中。

block hash 在 **请求构造时**预计算（`get_request_block_hasher`，`kv_cache_utils.py:637-688`），新生成 token 后增量计算（解码阶段每凑满一个 block 都会追加一个新 hash），最终落在 `Request.block_hashes`。

### 5.6.2 Prefix tree 的物理表示

把它想象成树，但实现上只是哈希表：

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="prefix tree 的两种视角：概念上的树形结构与物理上的扁平哈希表">
  <defs>
    <marker id="ch5ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">prefix tree：概念上是树（左），实现上是扁平哈希表（右）</text>
  <text x="180" y="48" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">概念视角：链式哈希自然形成树</text>
  <g transform="translate(80, 60)">
    <rect x="60" y="0" width="200" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="160" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">H_root</text>
    <text x="160" y="32" text-anchor="middle" font-size="10" fill="#9a3412">"Hello world this is"</text>
    <text x="160" y="42" text-anchor="middle" font-size="9" font-weight="700" fill="#9a3412">ref_cnt=2 · blk=17</text>
  </g>
  <path d="M 200 110 L 110 145" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar5)"/>
  <path d="M 240 110 L 330 145" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar5)"/>
  <g transform="translate(20, 150)">
    <rect x="0" y="0" width="180" height="44" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4" rx="4"/>
    <text x="90" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">H_A</text>
    <text x="90" y="28" text-anchor="middle" font-size="9" fill="#134e4a">"vLLM. Tell me about"</text>
    <text x="90" y="40" text-anchor="middle" font-size="9" font-weight="700" fill="#134e4a">ref_cnt=1 · blk=42</text>
  </g>
  <g transform="translate(240, 150)">
    <rect x="0" y="0" width="180" height="44" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4" rx="4"/>
    <text x="90" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">H_B</text>
    <text x="90" y="28" text-anchor="middle" font-size="9" fill="#134e4a">"rust. Why borrow"</text>
    <text x="90" y="40" text-anchor="middle" font-size="9" font-weight="700" fill="#134e4a">ref_cnt=1 · blk=5</text>
  </g>
  <path d="M 110 198 L 110 232" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar5)"/>
  <path d="M 330 198 L 330 232" fill="none" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ch5ar5)"/>
  <g transform="translate(20, 238)">
    <rect x="0" y="0" width="180" height="44" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4" rx="4"/>
    <text x="90" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#4c1d95">H_A2</text>
    <text x="90" y="28" text-anchor="middle" font-size="9" fill="#5b21b6">"PagedAttention please"</text>
    <text x="90" y="40" text-anchor="middle" font-size="9" font-weight="700" fill="#5b21b6">ref_cnt=1 · blk=88</text>
  </g>
  <g transform="translate(240, 238)">
    <rect x="0" y="0" width="180" height="44" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4" rx="4"/>
    <text x="90" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#4c1d95">H_B2</text>
    <text x="90" y="28" text-anchor="middle" font-size="9" fill="#5b21b6">"checker exists?"</text>
    <text x="90" y="40" text-anchor="middle" font-size="9" font-weight="700" fill="#5b21b6">ref_cnt=1 · blk=108</text>
  </g>
  <line x1="450" y1="50" x2="450" y2="360" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="600" y="48" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">物理视角：BlockHashToBlockMap</text>
  <g transform="translate(470, 60)">
    <rect x="0" y="0" width="260" height="300" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5" rx="6"/>
    <text x="130" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#78350f">cached_block_hash_to_block</text>
    <line x1="14" y1="32" x2="246" y2="32" stroke="#fde68a"/>
    <g font-family="monospace" font-size="11">
      <text x="14" y="58" fill="#475569"><tspan font-weight="700" fill="#ea580c">H_root</tspan> → blk_id=17, ref=2</text>
      <text x="14" y="98" fill="#475569"><tspan font-weight="700" fill="#0d9488">H_A</tspan>    → blk_id=42, ref=1</text>
      <text x="14" y="138" fill="#475569"><tspan font-weight="700" fill="#0d9488">H_B</tspan>    → blk_id=5,  ref=1</text>
      <text x="14" y="178" fill="#475569"><tspan font-weight="700" fill="#7c3aed">H_A2</tspan>   → blk_id=88, ref=1</text>
      <text x="14" y="218" fill="#475569"><tspan font-weight="700" fill="#7c3aed">H_B2</tspan>   → blk_id=108, ref=1</text>
    </g>
    <line x1="14" y1="240" x2="246" y2="240" stroke="#fde68a" stroke-dasharray="2,3"/>
    <text x="130" y="258" text-anchor="middle" font-size="10" font-weight="700" fill="#78350f">没有显式 parent 指针</text>
    <text x="130" y="274" text-anchor="middle" font-size="10" fill="#92400e">「H_A 是 H_root 的儿子」</text>
    <text x="130" y="288" text-anchor="middle" font-size="10" fill="#92400e">已经编码在 H_A 的哈希值里</text>
  </g>
  <text x="40" y="320" font-size="10" fill="#94a3b8" font-style="italic">链式 hash：H_A = H(H_root, tokens, extra) → 命中 H_A 即等价于命中"H_root + 这一段 token"的完整前缀</text>
  <text x="40" y="336" font-size="10" fill="#94a3b8" font-style="italic">这把 prefix tree 在哈希空间里扁平化，免去维护 trie 指针；查找 = 一次 dict lookup，O(1)</text>
</svg>
<span class="figure-caption">图 R5.5 ｜ prefix tree 在概念上是树（左），但物理实现只是一张哈希表（右）：链式 hash 把「父节点」编码进每个节点的 hash 值，于是不需要显式 parent 指针，查找退化成 O(1) dict lookup</span>

<details>
<summary>ASCII 原版</summary>

```
                  [H_root, "Hello world this is"]
                          / ref_cnt=2
                         /
              [H_A, "...vLLM. Tell me about"]      [H_B, "...rust. Why borrow"]
              ref_cnt=1                            ref_cnt=1
                  |                                    |
              [H_A2, "PagedAttention please"]    [H_B2, "checker exists?"]
              ref_cnt=1                          ref_cnt=1

物理实现:  cached_block_hash_to_block:  {
              H_root: KVCacheBlock(block_id=17, ref_cnt=2),
              H_A:    KVCacheBlock(block_id=42, ref_cnt=1),
              H_A2:   KVCacheBlock(block_id=88, ref_cnt=1),
              H_B:    KVCacheBlock(block_id=5,  ref_cnt=1),
              H_B2:   KVCacheBlock(block_id=108, ref_cnt=1),
          }
```

</details>

`BlockHashToBlockMap`（`block_pool.py:34-127`）：键是 `BlockHashWithGroupId`，值通常是单个 `KVCacheBlock`，少数情况（同 hash 不同 block，可能出现在并发竞争窗口）退化成 `dict[block_id, KVCacheBlock]`。

`BlockHashWithGroupId` 把 4 字节大端 group id 直接 append 到 block hash 后面（`kv_cache_utils.py:55-74`），避免构造 tuple。这样在 hybrid 模型里，"同一组 token 在不同 group 的 cached 状态"被独立索引。

### 5.6.3 Cache hit 查找

对单一 full attention 组，`FullAttentionManager.find_longest_cache_hit`（`single_type_kv_cache_manager.py:481-529`）从左到右扫：

```python
max_num_blocks = max_length // block_size
for block_hash in itertools.islice(block_hashes, max_num_blocks):
    if cached_block := block_pool.get_cached_block(block_hash, kv_cache_group_ids):
        for computed, cached in zip(computed_blocks, cached_block):
            computed.append(cached)
    else:
        break  # 链式 hash 的性质：一旦 miss，后续不可能命中
```

`break` 是有 trust assumption 的：因为 block hash 是链式，hash[i] 命中意味着前 i 个 block 的 token 序列与 cached block 完全相同；如果 hash[i] miss，hash[i+1] 也不会有意义。这把查找从 O(n) 退到 O(命中长度)。

对 sliding window：从右往左扫（`SlidingWindowManager.find_longest_cache_hit`，`single_type_kv_cache_manager.py:547-639`），因为 sliding window 只要求"最右侧连续 `sliding_window_size` 个 block"在 cache 里——左侧 token 不影响下一个 token 的输出。这是 hybrid 模型设计文档 `hybrid_kv_cache_manager.md:174-189` 详细解释的。

### 5.6.4 Cache 写入：`cache_full_blocks`

block 凑满之后，调 `BlockPool.cache_full_blocks`（`block_pool.py:211-331`）：

```python
for i, blk in enumerate(new_full_blocks):
    if blk.is_null or (block_mask is not None and not block_mask[i]):
        continue
    assert blk.block_hash is None
    block_hash = new_block_hashes[i]

    block_hash_with_group_id = make_block_hash_with_group_id(
        block_hash, kv_cache_group_id
    )
    blk.block_hash = block_hash_with_group_id
    self.cached_block_hash_to_block.insert(block_hash_with_group_id, blk)
```

注意 `blk.block_hash` 被赋值后，这个 block 就"加入了 prefix cache"。它仍可以被 ref_cnt 维护，仍可以被 free 后留在自由队列里（"可命中但已是淘汰候选"的状态）。只有 `get_new_blocks` 真正把它拿去重新分配时，`_maybe_evict_cached_block` 才会把它从 hash 表中拔出来。

`note #1` 在 `block_pool.py:48-52` 写得很明白："we don't check if there is already an identical block in the cache"。原因是 block table 必须 append-only——若把"已存在 block id"塞回给请求，需要在多个地方同步替换；vLLM 选择"允许极少数同 hash 不同 block 共存"。

### 5.6.5 KV cache events

如果开启 `enable_kv_cache_events`，每次 store/remove/reset 都会向 `kv_event_queue` 推一条事件（`block_pool.py:285-331, 392-400, 484-486`），让 scheduler 通过 `KVCacheManager.take_events()` 取走并广播给订阅者（如 P/D disaggregation 的元数据服务）。

---

## 5.7 一个请求的完整生命周期

```
[Request 进入]
    request.block_hashes = [h0, h1, h2, h3, h4]    （由 add_request 时预算好；新生成 token 时增量补全）
    request.num_tokens = 80                          （prompt 长度，block_size=16 → 5 个 full block）

[Step 1: scheduler.schedule()]
    1) kv_cache_manager.get_computed_blocks(request)
         → coordinator.find_longest_cache_hit([h0..h4], max_length=79)
         → 命中 h0, h1, h2 三个 block（block id 17, 42, 88）
         → 返回 (KVCacheBlocks([blk17, blk42, blk88]), num_hits=48)

    2) kv_cache_manager.allocate_slots(
           request,
           num_new_tokens=32,            # 80 - 48 = 32 个 token 需要计算
           num_new_computed_tokens=48,
           new_computed_blocks=KVCacheBlocks([blk17,blk42,blk88]),
       )
       a) coordinator.remove_skipped_blocks  → 无（full attention 不跳）
       b) coordinator.get_num_blocks_to_allocate
            num_required_blocks = cdiv(80, 16) = 5
            new_computed_blocks 提供 3 个，再申请 2 个新 block
            返回 2
       c) BlockPool 池子里至少有 2 个 free? 是 → 继续
       d) coordinator.allocate_new_computed_blocks:
            block_pool.touch([blk17, blk42, blk88])
            blk17.ref_cnt: 0 → 1（从 free 队列 remove）
            blk42, blk88 同理
            req_to_blocks[req_id] = [blk17, blk42, blk88]
       e) coordinator.allocate_new_blocks(num_tokens_need_slot=80):
            block_pool.get_new_blocks(2) → 返回 [blk201, blk205]
            blk201/blk205.ref_cnt: 0 → 1（已从 free 队列 popleft）
            req_to_blocks[req_id] = [blk17, blk42, blk88, blk201, blk205]
       f) coordinator.cache_blocks(request, num_tokens_to_cache=80):
            前 3 个 block 已 cached（num_cached_block[req_id]=3），跳过
            后 2 个：调 block_pool.cache_full_blocks
              blk201.block_hash = (h3, group_id) → 插入 hash map
              blk205.block_hash = (h4, group_id) → 插入 hash map
            num_cached_block[req_id] = 5
       g) 返回 KVCacheBlocks([blk201, blk205])  ← 本步要写 KV 的新块

    3) scheduler 把 [blk17, blk42, blk88, blk201, blk205] 的 block ids
       写入 worker 端的 BlockTable 行：
         block_table[row_idx] = [17, 42, 88, 201, 205, 0, 0, ...]
         num_blocks_per_row[row_idx] = 5

[Step 1.5: worker 计算]
    BlockTable.compute_slot_mapping(...)
       → slot_mapping = [17*16+0, ..., 17*16+15, 42*16+0, ..., 88*16+15,
                         201*16+0, ..., 205*16+15]  （仅本步要写的 token 部分）
    attention kernel：
       - 用 block_table[row_idx] 读旧 KV
       - 用 slot_mapping 写新 KV
    output token 67 生成

[Step 2~N: 解码循环]
    request.num_tokens 增至 81, 82, ..., 96
    第 96 个 token 时凑满第 6 个 block：
       request.block_hashes 由 request_block_hasher 增量补出 h5
       allocate_slots(request, num_new_tokens=1):
         num_required_blocks=6, 已有 5 个 → 申请 1 个新 block blk318
         cache_blocks: blk318.block_hash = (h5, group_id) → 插入 hash map

[Request finish]
    kv_cache_manager.free(request)
      → coordinator.free
        → SingleTypeKVCacheManager.free:
            ordered_blocks = reversed([blk17, blk42, blk88, blk201, blk205, blk318, ...])
            block_pool.free_blocks(ordered_blocks)
              逐个 ref_cnt -= 1；归零者按"链尾在前"顺序 append 回 free 队列
              （但 blk17/blk42/blk88 可能因别的请求还在用，ref_cnt 仍 > 0，不入队列）
```

后续如果一条 prompt 与本请求前 48 个 token 相同，会再次命中 blk17/blk42/blk88（前提：未被淘汰）。

---

## 5.8 Hybrid KV Cache：多 attention 类型并存

详细设计：`docs/design/hybrid_kv_cache_manager.md`。下面只展开 V1 实现的入口。

### 5.8.1 KVCacheGroup 与 KVCacheConfig

```python
@dataclass
class KVCacheGroupSpec:                                          # kv_cache_interface.py:820
    layer_names: list[str]
    kv_cache_spec: KVCacheSpec
    is_eagle_group: bool = False

@dataclass
class KVCacheConfig:                                             # kv_cache_interface.py:835
    num_blocks: int
    kv_cache_tensors: list[KVCacheTensor]
    kv_cache_groups: list[KVCacheGroupSpec]
```

一个 group = 一组"在 manager 视角等价"的 layer。比如 Gemma-3-27b 有 52 sliding window + 10 full：拆成 1 个 full group（10 层）+ 6 个 SW group（每组 10 层 + 一个补 padding 的尾组）。每个 group 拥有自己的 block table；m = 每组 layer 数 = 10，于是分配 m 个 `KVCacheTensor`，每个被"每组一个 layer"共享。详细规则在 `kv_cache_utils.py:1057-1176` 的 `_get_kv_cache_groups_uniform_page_size`。

### 5.8.2 Coordinator 选择

`get_kv_cache_coordinator`（`kv_cache_coordinator.py:610-658`）的分支：

| 条件 | Coordinator |
|------|-------------|
| `enable_caching=False` | `KVCacheCoordinatorNoPrefixCache` |
| `len(kv_cache_groups) == 1` | `UnitaryKVCacheCoordinator` |
| 其他 | `HybridKVCacheCoordinator` |

### 5.8.3 Hybrid 的 cache hit 算法

`HybridKVCacheCoordinator.find_longest_cache_hit`（`kv_cache_coordinator.py:503-607`）实现"两种 attention 类型的不动点交集"：

```
1. 用 full attention（如果存在）从左扫到右，给出初始候选 hit_length。
2. 对每个 attention group 依次调用其 find_longest_cache_hit(max_length=hit_length)。
   若某 group 把 hit_length 缩短了，回到步骤 2 重扫一遍。
3. hit_length 单调非增，必然在有限步内停。
   简单 2-类型 hybrid（full + 1 other）一次迭代即可完成。
```

为什么需要 LCM 对齐？多 group block size 可能不同（mamba 与 full attention 常常如此）。"命中长度"必须是各 group `block_size` 的公倍数，否则某个 group 会出现"部分命中一个 block"——当前还不支持部分块复用。LCM 在 `HybridKVCacheCoordinator.verify_and_split_kv_cache_groups()`（`kv_cache_coordinator.py:436-485`）算好。

### 5.8.4 Hybrid cache_blocks 的对齐裁剪

```python
def cache_blocks(self, request: Request, num_computed_tokens: int) -> None:     # 487
    num_computed_tokens = (
        num_computed_tokens // self.lcm_block_size * self.lcm_block_size
    )
    for manager in self.single_type_managers:
        manager.cache_blocks(
            request, num_computed_tokens, alignment_tokens=self.lcm_block_size,
        )
```

被对齐到 LCM 后，SWA 组的"窗口外的块"完全不进 prefix cache hash 表（由 `_cache_block_mask`，`single_type_kv_cache_manager.py:641-652`）——因为它们永远不可能在任何"LCM 对齐前缀"上被命中。这避免了无意义的 hash 表膨胀。

---

## 5.9 KVCacheSpec：把 attention 类型变成可计算的内存预算

`KVCacheSpec` 是 hybrid 设计的关键抽象。它必须能回答：

- 一个 block 占多少字节？(`page_size_bytes`)
- 这种 attention 类型，单个请求最多需要多少字节？(`max_memory_usage_bytes`)
- 多个相邻 layer 是否能合并成同一 spec？(`merge`)

### 5.9.1 Spec 家族

```
KVCacheSpec                                                  # kv_cache_interface.py:94
├── AttentionSpec                                            # 143  (num_kv_heads, head_size, dtype)
│   ├── FullAttentionSpec                                    # 187
│   │   ├── TQFullAttentionSpec                              # 310  (TurboQuant)
│   │   ├── MLAAttentionSpec                                 # 336  (DeepseekV2/V3/V4)
│   │   │   └── HiddenStateCacheSpec                         # 399
│   │   └── SinkFullAttentionSpec                            # 612  (attention sink)
│   ├── ChunkedLocalAttentionSpec                            # 406  (Llama 4 local)
│   ├── SlidingWindowSpec                                    # 434  (Gemma, Mistral)
│   │   └── SlidingWindowMLASpec                             # 497
│   ├── EncoderOnlyAttentionSpec                             # 592  (无 KV cache)
│   └── CrossAttentionSpec                                   # 599  (Whisper 等)
├── MambaSpec                                                # 562
└── UniformTypeKVCacheSpecs                                  # 664  (DeepseekV4 的"组中组")
```

每种 spec 的 `max_memory_usage_bytes` 实现就是"该类型每请求所需 block 数 × page_size_bytes"。例如：

```python
# FullAttentionSpec.max_memory_usage_bytes (210-218)
return cdiv(max_model_len, self.block_size) * self.page_size_bytes

# SlidingWindowSpec.max_admission_blocks_per_request (463-483)
num_tokens = min(self.sliding_window - 1 + max_num_batched_tokens, max_model_len)
return cdiv(num_tokens, self.block_size) + 1   # +1: 窗口可能跨 block 起点
```

为什么 SW 加 1？例子见行 480-483：`block_size=4`，`num_token=4`，窗口 6 个 token `[CDEF]` 跨了块边界 `[XXCD][EF]`，所以需要 2 个 block。

### 5.9.2 一个 group 内所有 layer 的 spec 必须能 merge

`KVCacheSpec.merge`（`kv_cache_interface.py:132-140`）是一个保护性方法：把同 group 各 layer 的 spec 合并成一个；如果不同 layer 的 spec 不等就 assert。子类（`FullAttentionSpec.merge` 等）做更细致的 sliding window / attention chunk 大小检查。这保证了一个 group 对所有 layer 真的"等价"，可以安全共用 block table。

---

## 5.10 可用 block 数量是如何确定的

这是一个 worker 与 scheduler 之间的协议。流程（参考 `engine/core.py:240-260` 与 `worker/gpu_worker.py:354-460`）：

```
[engine.core.EngineCore.__init__]
    1) executor.determine_available_memory()
         → 每个 worker 调 GPUWorker.determine_available_memory():
             (a) 保存 init_snapshot (free memory before)
             (b) model_runner.profile_run()
                 - 用 max_num_batched_tokens 的 dummy 输入跑一遍 forward
                 - 让 torch caching allocator 把激活峰值"撑出来"
             (c) profile_cudagraph_memory()（若启用 cudagraph）
             (d) 计算
                  non_kv_cache = weights + torch_peak + non_torch_increase
                  available_kv_cache_memory = requested_memory - non_kv_cache - cudagraph_estimate
             (e) 返回 available_kv_cache_memory_bytes
       executor 取所有 rank 的最小值作为可用预算

    2) 取 vllm_config 中各 layer 的 KVCacheSpec（attention layer 注册时收集）
       check_enough_kv_cache_memory(...) 确保"至少能放一个 max_model_len 的请求"
                                                    (kv_cache_utils.py:794-819)

    3) get_kv_cache_groups(...) 划分 group  (kv_cache_utils.py:1618-)
    4) get_kv_cache_config_from_groups(vllm_config, groups, available_memory):
                                                    (kv_cache_utils.py:1236-1321)

         一般情况 (general case)：
             group_size = max(layers in each group)
             page_size = uniform across groups        (单 layer 单 block 的字节)
             num_blocks = available_memory // page_size // group_size
             # 即 = available_memory / (page_size * group_size)
             # page_size * group_size 就是"所有 group 加起来一个 block 的字节"

         kv_cache_tensors[i] = KVCacheTensor(
             size=page_size * num_blocks,
             shared_by=[group_j.layer_names[i] for j in groups if i < ...]
         )

    5) 回写 vllm_config.cache_config.num_gpu_blocks = num_blocks
    6) worker.initialize_from_config(kv_cache_config)
         → model_runner._allocate_kv_cache_tensors(...)
            torch.zeros(kv_cache_tensor.size, dtype=int8, device=cuda)
         → model_runner._reshape_kv_cache_tensors(...)
            view 成 (2, num_blocks, block_size, num_kv_heads, head_size)
```

要点：

- **profile_run 的作用是"撑大 torch peak"**，让我们知道激活内存的水位。不撑大就会高估可用预算，运行时 OOM。
- `cudagraph_memory_estimate` 是 cuda graph capture 时**额外**占用的内存（受 `VLLM_MEMORY_PROFILER_ESTIMATE_CUDAGRAPHS` 控制），不算就会在 graph capture 阶段 OOM。
- `kv_cache_memory_bytes` 配置（`gpu_worker.py:366-384`）允许跳过自动估算，但仍跑一次 profile_run 以触发编译。

---

## 5.11 与 attention backend 的接口

每个 attention backend 用 `AttentionMetadataBuilder` 把 KVCacheManager 的输出"翻译"成 backend 自己的 metadata。以 FlashAttention 为例（`flash_attn.py:222-258, 561-577`）：

```python
@dataclass
class FlashAttentionMetadata:
    num_actual_tokens: int
    max_query_len: int
    query_start_loc: torch.Tensor         # 每个请求 query 的起止
    max_seq_len: int
    seq_lens: torch.Tensor                # 每个请求当前总 seq 长度
    block_table: torch.Tensor             # ← 来自 BlockTable.get_device_tensor
    slot_mapping: torch.Tensor            # ← 来自 BlockTable.slot_mapping.gpu
    use_cascade: bool                     # 共同前缀优化（见 5.6.4 take_events 之外的事）
    common_prefix_len: int                # ← KVCacheManager.get_num_common_prefix_blocks
    ...
```

`get_num_common_prefix_blocks`（`kv_cache_manager.py:476-508` + `FullAttentionManager.get_num_common_prefix_blocks` `single_type_kv_cache_manager.py:531-539`）实现：

```python
for block in blocks:                          # 任选一个 running request 的 block 链
    if block.ref_cnt == len(self.req_to_blocks):  # 所有 req 都引用这个 block
        num_common_blocks += 1
    else:
        break
```

它用引用计数等于"已分配 KV cache 的请求数"作为"所有请求共享"的近似判据。在 cascade attention 优化中，对共同前缀只算一次。

`block_table` tensor 进 kernel 后的寻址逻辑（伪代码）：

```
for token t in query:
    seq_pos = past_seen_tokens + (t - q_start)
    logical_block = seq_pos // block_size
    block_offset = seq_pos % block_size
    physical_block = block_table[req_idx, logical_block]
    K = kv_cache[physical_block, block_offset, :, :]
    V = kv_cache[physical_block, block_offset, :, :]   # 不同 dim 偏移
    ...
```

这正是 PagedAttention paper 描述的"按页查表"机制；在 V1 中由 attention backend 完成（kernel 实现见各 backend 文件，不在本章范围）。

---

## 5.12 KV connector & offload（导读）

`evict_blocks`（`kv_cache_manager.py:452-458`）暴露给 KV connector：connector 把某些 block 卸到 CPU/disk 后，告诉 manager 把它们从 prefix cache 表里拔出来（但不释放，ref_cnt 由 connector 自己处理）。

`take_events`（`kv_cache_manager.py:510-534`）把 `BlockStored / BlockRemoved / AllBlocksCleared`（`vllm/distributed/kv_events.py`）打包给上层广播。`enable_kv_cache_events` 默认关闭，开启后才有事件。

scheduler 还会把分配信息通过 `req_to_new_blocks` 一并发给 worker（`scheduler.py:798`），如果有 KV transfer 的请求，scheduler 调用 `allocate_slots(..., delay_cache_blocks=True)` 表示"先分配 block，等接收完远端 KV 再缓存"（`kv_cache_manager.py:413-414`）。

具体 connector（Mooncake / NIXL / P2P-NCCL 等）的实现在 `vllm/distributed/kv_transfer/` 与 `vllm/v1/kv_connector/`，留待"高级特性"章详述。

---

## 5.13 KV Cache 指标与可观测性

`KVCacheMetricsCollector`（`kv_cache_metrics.py:46-96`）以 `sample_rate`（默认 1%）采样跟踪 block 的：

- `birth_time_ns`：何时被分配
- `last_access_ns`：上一次 touch
- `access_history`：最近 4 次访问时刻（用于算"复用间隔"）

每次驱逐时 `on_block_evicted` 推一条 `KVCacheEvictionEvent`（包含 lifetime、idle、reuse_gaps）。Prometheus 端使用这些数据估算 cache 复用模式。指标被采样而非全量是为了避免每次分配/访问都走 dict 修改的开销。

`PrefixCacheStats`（`metrics/stats.py`，本章不展开）记录 hit/miss 比例。打开 `log_stats` 才会真正记录（`KVCacheManager.__init__` `kv_cache_manager.py:139`）。

---

## 5.14 关键数据结构速查

| 类型 | 文件:行 | 用途 |
|------|---------|------|
| `KVCacheBlock` | `kv_cache_utils.py:115` | 单个 block 的 metadata（id, ref_cnt, hash, prev/next） |
| `FreeKVCacheBlockQueue` | `kv_cache_utils.py:164` | 自由 block 的双向链表（LRU） |
| `BlockPool` | `block_pool.py:130` | 所有 block 的拥有者 |
| `BlockHashToBlockMap` | `block_pool.py:34` | `block_hash → block` 索引 |
| `KVCacheBlocks` | `kv_cache_manager.py:25` | 给 scheduler 的"分配结果"包装 |
| `KVCacheManager` | `kv_cache_manager.py:110` | scheduler 接口 |
| `KVCacheCoordinator` | `kv_cache_coordinator.py:28` | group 协调器（抽象） |
| `UnitaryKVCacheCoordinator` | `kv_cache_coordinator.py:324` | 单 group 优化 |
| `HybridKVCacheCoordinator` | `kv_cache_coordinator.py:392` | 多 group 不动点求交 |
| `SingleTypeKVCacheManager` | `single_type_kv_cache_manager.py:31` | 单 attention 类型管理器（抽象） |
| `FullAttentionManager` | `single_type_kv_cache_manager.py:481` | 全注意力 |
| `SlidingWindowManager` | `single_type_kv_cache_manager.py:542` | 滑窗 |
| `ChunkedLocalAttentionManager` | `single_type_kv_cache_manager.py:692` | Llama4 local |
| `MambaManager` | `single_type_kv_cache_manager.py:842` | Mamba |
| `CrossAttentionManager` | `single_type_kv_cache_manager.py:1122` | encoder-decoder cross attn |
| `KVCacheSpec` 系列 | `kv_cache_interface.py:94+` | 表达"这种 layer 要多少 KV cache" |
| `KVCacheTensor` | `kv_cache_interface.py:810` | worker 端实际 tensor 描述 |
| `KVCacheConfig` | `kv_cache_interface.py:835` | 全局 KV cache 蓝图 |
| `BlockTable` (worker) | `vllm/v1/worker/block_table.py:18` | 把 block ids 同步到 GPU |
| `MultiGroupBlockTable` (worker) | `vllm/v1/worker/block_table.py:223` | 多 group 的 block table 集合 |
| `BlockHash` / `BlockHashWithGroupId` | `kv_cache_utils.py:42, 47` | hash 类型别名 |
| `hash_block_tokens` | `kv_cache_utils.py:541` | 链式哈希 |

---

## 5.15 设计要点回顾（"为什么这样设计"）

1. **block 大小为何固定**：vLLM 把"按序列连续分配"的外部碎片转化成"按 block 分配"的极小内部碎片（最后一个不满块）。一旦 block_size 固定，所有 block 同尺寸，free queue 与 hash 表都是 O(1)。

2. **为什么 block 不直接持有 tensor**：scheduler 进程不持 GPU，block 只是 metadata；worker 持 tensor，通过 block id 寻址。这让 scheduler 可以放心做"分配/排队/淘汰"决策而无 GPU 依赖。

3. **为什么用引用计数而不是 lease/owner**：一个 block 同时被多个请求共享（prefix caching），lease 模型无法清晰表达"既被运行中请求 hold，又是 cache 命中候选"的状态。`ref_cnt == 0` + `block_hash != None` 自然表达"可命中但可淘汰"。

4. **为什么 free 队列要支持中间删除**：因为命中 block 必须立刻退出 LRU 候选，否则后续 `popleft` 会把它当成自由块弹出。自带 prev/next 指针的 KVCacheBlock + 手写双向链表是最朴素的 O(1) 解。

5. **为什么 hash 是链式 (`H(parent, tokens, extra)`)**：单点哈希只能比"局部相同"；链式哈希让"hash 相同 ⇔ 整段 prefix 相同"，于是 cache hit 查找可以 break-on-miss，从 O(n) 退到 O(命中长度)。

6. **为什么 hybrid 用 LCM 对齐**：不同 group block_size 不同时，命中长度必须是公倍数，否则会"部分命中一个 block"——而部分块不可复用（PagedAttention 的最小复用单元是 block）。

7. **为什么 free 时要 `reversed(req_blocks)`**：自由队列尾部最晚被淘汰，靠近"根"的 block 应该最难被淘汰（它们更可能被新请求复用）。倒序入队让链尾先进队列头、先被淘汰。

8. **为什么 prefix cache 允许同 hash 不同 block 共存**：block table 一旦给出 block id 就 append-only，不可替换；若强制 dedup，需要在多个请求的 block table 同步替换 id，复杂且会破坏 cudagraph capture 的稳定性。允许并发期短暂存在重复，是 throughput 与 correctness 的最佳折中。

9. **为什么把 attention spec 抽象成 dataclass 树**：不同 attention 类型只在"每请求需要多少 token slot"、"哪些 block 可释放"、"命中算法"上不同；其他完全共享。子类化让新 attention 类型只需补三个小函数：`max_memory_usage_bytes`、`get_num_skipped_tokens`、`find_longest_cache_hit`。

10. **为什么 worker 端 BlockTable 还要 kernel_block_size 解耦**：分配粒度（block_size）受调度效率与 prefix hash 粒度约束（大些好），但 kernel 实际 IO 粒度受硬件指令对齐约束（小些好）。让两者解耦，分配用大块、kernel 用小块，由 `map_to_kernel_blocks` 在 append 时展开。

---

## 5.16 自己实现时的最小切片

如果只想复现 V1 KV cache 管理的最小可工作版本，建议按以下顺序实现：

1. `KVCacheBlock` + `FreeKVCacheBlockQueue`（自由块管理）。
2. `BlockPool` 只支持 `get_new_blocks` / `free_blocks`（无 prefix cache）。
3. `FullAttentionManager` 只支持 `allocate_new_blocks` / `free`（无窗口）。
4. 单 group 版 `KVCacheManager`（直接调 single-type，跳过 coordinator）。
5. worker 端最小 `BlockTable`：每个 step 全量重发 block ids；slot_mapping 用 Python/numpy 算（不上 triton）。
6. 接 FlashAttention backend 跑通一条请求。

跑通后再加：

7. block hash + `BlockHashToBlockMap` + `cache_full_blocks` + `get_computed_blocks`。
8. ref_cnt 与 `touch` 的语义。
9. LRU 淘汰（已经有，verify 一次）。
10. SlidingWindow / Mamba / hybrid coordinator。

每一步都对应本章的一个小节，相应代码在 `vllm/v1/core/` 中都有清晰的对照可参考。
