# 第 06 章：RadixAttention 与前缀缓存

> 代码版本：sgl-project/sglang@6ccc5b807  
> 相关章节：[第 07 章 KV Cache 内存管理](./07-kv-cache-memory.md)

---

## 目录

1. [问题背景：重算的浪费](#1-问题背景重算的浪费)
2. [核心数据结构](#2-核心数据结构)
   - 2.1 [RadixKey：键空间抽象](#21-radixkey键空间抽象)
   - 2.2 [TreeNode：树节点](#22-treenode树节点)
   - 2.3 [RadixCache：整棵树](#23-radixcache整棵树)
3. [抽象接口 BasePrefixCache](#3-抽象接口-baseprefixcache)
4. [前缀匹配：match\_prefix](#4-前缀匹配match_prefix)
   - 4.1 [_match_prefix_helper 逐层下探](#41-_match_prefix_helper-逐层下探)
   - 4.2 [节点分裂：_split_node](#42-节点分裂_split_node)
5. [写入：insert 与 cache\_finished\_req](#5-写入insert-与-cache_finished_req)
6. [引用计数与锁定：lock\_ref](#6-引用计数与锁定lock_ref)
7. [淘汰策略](#7-淘汰策略)
   - 7.1 [evict 流程](#71-evict-流程)
   - 7.2 [六种策略](#72-六种策略)
8. [RadixAttention 与注意力计算的关系](#8-radixattention-与注意力计算的关系)
9. [进阶：Bigram 视图与 EAGLE 推测解码](#9-进阶bigram-视图与-eagle-推测解码)
10. [ASCII 示意图](#10-ascii-示意图)

---

## 1. 问题背景：重算的浪费

LLM 服务中最常见的场景是：多个并发请求共享同一段系统提示（system prompt）或 few-shot 示例。朴素实现下，每条请求都要在 prefill 阶段独立运行 Transformer 的 Attention 计算，对这段公共前缀产生等量的 KV 张量，浪费了大量算力与显存。

RadixAttention 的核心观察是：**只要 token id 序列相同，attention 产生的 K/V 张量也完全相同**（前提：没有采样随机性影响 KV，LoRA/adapter 相同）。因此可以把这些 KV 张量以前缀为键缓存在一棵 radix tree 里，后续命中公共前缀的请求直接复用，无需重新执行前向传播的 attention 层。

---

## 2. 核心数据结构

### 2.1 RadixKey：键空间抽象

`python/sglang/srt/mem_cache/radix_cache.py:66`

```python
class RadixKey:
    """is_bigram=True: token_ids holds raw tokens (N+1 for N bigrams);
       slices share one boundary token."""
    __slots__ = ("token_ids", "extra_key", "is_bigram")

    def __init__(
        self,
        token_ids: List[int],
        extra_key: Optional[str] = None,
        is_bigram: bool = False,
    ):
        self.token_ids = token_ids
        self.extra_key = extra_key  # 用于隔离 LoRA ID / cache_salt 等命名空间
        self.is_bigram = is_bigram  # EAGLE 推测解码用的 bigram 视图
```

`RadixKey` 封装了 token id 序列，并额外携带一个 `extra_key` 字符串作为命名空间隔离器。`extra_key` 非空时，不同 LoRA 的请求即使 token 序列相同也不会互相命中缓存——这是**租户隔离**的关键机制。

`__len__` / `__iter__` / `__getitem__` 的实现均依据 `is_bigram` 标志自动切换：普通模式下遍历单 token，bigram 模式下遍历相邻 token 对 `(t_i, t_{i+1})`（`radix_cache.py:84-115`）。

`page_aligned(page_size)` 把键长对齐到 `page_size` 的倍数，配合分页分配器保证每个节点存储整数页（`radix_cache.py:121-125`）。

`child_key(page_size)` 返回当前键开头 `page_size` 个逻辑单元组成的、可哈希的字典键，用于索引 `TreeNode.children`（`radix_cache.py:178-188`）。

### 2.2 TreeNode：树节点

`python/sglang/srt/mem_cache/radix_cache.py:206`

```python
class TreeNode:
    counter = 0

    def __init__(self, id=None, priority=0):
        self.children = defaultdict(TreeNode)
        self.parent: TreeNode = None
        self.key: RadixKey = None        # 本节点存的 token 段（边标签）
        self.value: Optional[torch.Tensor] = None  # 设备上的 KV 索引张量
        self.lock_ref = 0                # 引用计数，> 0 时禁止淘汰
        self.last_access_time = time.monotonic()
        self.creation_time = time.monotonic()
        self.hit_count = 0               # LFU/SLRU 统计
        self.host_ref_counter = 0        # HiCache 写回操作的保护计数
        self.host_value: Optional[torch.Tensor] = None  # 主机内存索引（HiCache）
        self.hash_value: Optional[List[str]] = None     # 分页 SHA256（KV 事件）
        self.priority = priority         # 优先级感知淘汰
```

每个 `TreeNode` 代表 radix tree 中从父节点到本节点这条边上的一段 token 序列（**边标签存在节点里**，而非存在边上）。具体来说：

- `key`：本段的 `RadixKey`，即这条边所对应的 token 序列片段。
- `value`：`torch.int64` 张量，存储对应 token 在设备 KV 池中的**槽位索引**，长度等于 `len(key)`。
- `lock_ref`：引用计数。正在被某个请求使用的节点 `lock_ref > 0`，淘汰器不得释放它。
- `host_value` / `host_ref_counter`：HiCache 分级缓存专用，见[第 07 章](./07-kv-cache-memory.md#6-hicache-分级缓存)。
- `evicted` 属性：`value is None` 时为 `True`，说明设备 KV 已被释放。

### 2.3 RadixCache：整棵树

`python/sglang/srt/mem_cache/radix_cache.py:269`

```python
class RadixCache(KVCacheEventMixin, BasePrefixCache):
    def __init__(self, params: CacheInitParams):
        self.disable = params.disable
        self.req_to_token_pool = params.req_to_token_pool
        self.token_to_kv_pool_allocator = params.token_to_kv_pool_allocator
        self.page_size = params.page_size
        self.eviction_policy = params.eviction_policy.lower()
        # ...
        self.evictable_leaves = set()  # 可淘汰叶节点集合，供 evict 快速访问
        self.reset()
```

`RadixCache` 持有两个关键池子的引用：
- `req_to_token_pool`：请求到 token 槽位的映射表（详见[第 07 章 2 节](./07-kv-cache-memory.md#2-reqtotokenpool)）。
- `token_to_kv_pool_allocator`：管理 KV 物理页的分配器（详见[第 07 章 3 节](./07-kv-cache-memory.md#3-token-to-kv-池与分配器)）。

`reset()` 时创建根节点，根节点的 `key=[]`、`value=[]`，`lock_ref=1`（永不被淘汰），`priority=-sys.maxsize`（总是最后被选中）。

---

## 3. 抽象接口 BasePrefixCache

`python/sglang/srt/mem_cache/base_prefix_cache.py:196`

```python
class BasePrefixCache(ABC, PrefixCacheTrait):
    @abstractmethod
    def reset(self): ...

    @abstractmethod
    def match_prefix(self, params: MatchPrefixParams) -> MatchResult: ...

    @abstractmethod
    def cache_finished_req(self, req: Req, is_insert: bool = True, **kwargs): ...

    @abstractmethod
    def cache_unfinished_req(self, req: Req, **kwargs): ...

    @abstractmethod
    def evict(self, params: EvictParams) -> EvictResult: ...

    @abstractmethod
    def inc_lock_ref(self, node: Any) -> IncLockRefResult: ...

    @abstractmethod
    def dec_lock_ref(self, node: Any, params=None) -> DecLockRefResult: ...
```

这是整个前缀缓存体系的公共契约。实现类包括：

| 实现类 | 文件 | 适用场景 |
|--------|------|----------|
| `RadixCache` | `radix_cache.py` | 标准 MHA/MLA 模型 |
| `HiRadixCache` | `hiradix_cache.py` | 启用 HiCache 分级缓存 |
| `ChunkCache` | `chunk_cache.py` | 禁用 radix cache 时的简单实现 |
| `UnifiedRadixCache` | `unified_radix_cache.py` | Hybrid SWA/Mamba 模型 |

**数据流说明**（`base_prefix_cache.py:39-178`）：

- `MatchPrefixParams`：包含 `key: RadixKey` 和 Mamba 专用的 `cow_mamba` 等字段。
- `MatchResult`（NamedTuple）：`device_indices`（命中的 KV 槽位张量）、`last_device_node`、`last_host_node`（HiCache 分层节点）、`best_match_node`（用于触发 host→device 加载回放）、`host_hit_length`（主机命中长度）。
- `InsertParams`：`key`、`value`（KV 槽位张量）、`priority`、`chunked`（分块 prefill 标志）。
- `EvictParams`：`num_tokens`（请求淘汰的 token 数）。

---

## 4. 前缀匹配：match\_prefix

`python/sglang/srt/mem_cache/radix_cache.py:360`

```python
def match_prefix(self, params: MatchPrefixParams) -> MatchResult:
    key = params.key
    key, _ = key.maybe_to_bigram_view(self.is_eagle)  # EAGLE 模式切换

    if self.disable or len(key) == 0:
        return self._empty_match_result

    key = key.page_aligned(self.page_size)   # 对齐到页大小

    if len(key) == 0:
        return self._empty_match_result

    value, last_node = self._match_prefix_helper(self.root_node, key)
    if value:
        value = torch.cat(value)
    else:
        value = self._empty_match_result.device_indices
    return MatchResult(
        device_indices=value,
        last_device_node=last_node,
        last_host_node=last_node,
        best_match_node=last_node,
    )
```

匹配流程分三步：

1. **bigram 转换**：EAGLE 推测解码场景下，键被转换为 bigram 视图（O(1) 操作，仅翻转 `is_bigram` 标志）。
2. **页对齐裁剪**：`page_size > 1` 时，键末尾不足一页的部分被截去，保证匹配只在整页边界发生。
3. **树上下探**：委托 `_match_prefix_helper` 执行实际匹配，返回命中 KV 索引列表和末节点。

### 4.1 _match_prefix_helper 逐层下探

`python/sglang/srt/mem_cache/radix_cache.py:645`

```python
def _match_prefix_helper(self, node: TreeNode, key: RadixKey):
    access_time = time.monotonic()
    node.last_access_time = access_time      # 更新 LRU 时间戳

    child_key = key.child_key(self.page_size)

    value = []
    while len(key) > 0 and child_key in node.children.keys():
        child = node.children[child_key]
        child.last_access_time = access_time
        prefix_len = child.key.match(key, page_size=self.page_size)
        if prefix_len < len(child.key):
            # 匹配在节点内部中断，需要分裂
            new_node = self._split_node(child.key, child, prefix_len)
            value.append(new_node.value)
            node = new_node
            break
        else:
            # 整段匹配成功，继续向下
            value.append(child.value)
            node = child
            key = key[prefix_len:]
            if len(key):
                child_key = key.child_key(self.page_size)

    return value, node
```

**关键设计点**：

- 每个循环迭代消耗一段 `child.key` 的长度，通过 `RadixKey.match` 找到公共前缀的字节数，再按 `page_size` 向下取整。
- 若 `prefix_len < len(child.key)`，说明匹配在该节点中途停止，此时调用 `_split_node` 将该节点拆分，使下次匹配可以精确命中分裂点。
- 返回的 `value` 是各段 `torch.int64` 张量的列表，`match_prefix` 会将它们 `torch.cat` 成一个完整的 KV 槽位序列。

### 4.2 节点分裂：_split_node

`python/sglang/srt/mem_cache/radix_cache.py:671`

```python
def _split_node(self, key: RadixKey, child: TreeNode, split_len: int):
    new_node = TreeNode(priority=child.priority)
    new_node.hit_count = child.hit_count
    new_node.children = {key[split_len:].child_key(self.page_size): child}
    new_node.parent = child.parent
    new_node.lock_ref = child.lock_ref
    new_node.key = child.key[:split_len]
    new_node.value = child.value[:split_len].clone()
    child.parent = new_node
    child.key = child.key[split_len:]
    child.value = child.value[split_len:].clone()
    new_node.parent.children[key.child_key(self.page_size)] = new_node
    # ...
    return new_node
```

分裂在 `split_len` 位置把原 child 一分为二：`new_node`（共享前缀段）→ `child`（剩余段）。分裂后 `new_node.value` 和 `child.value` 各执 clone，是为了保证两段内存独立，互不影响后续的淘汰与释放。

---

## 5. 写入：insert 与 cache\_finished\_req

### insert 的核心逻辑

`python/sglang/srt/mem_cache/radix_cache.py:701`

`_insert_helper` 从根节点开始，沿树下探找到公共前缀终止处。若新键与现有节点部分重叠，先执行 `_split_node`；若新键超出现有树的覆盖范围，则创建新的叶节点挂上去。返回值是已成功插入的**已有前缀长度**（`total_prefix_length`），调用方用它来释放重复分配的 KV 槽位。

### cache\_finished\_req：请求完成时的写入

`python/sglang/srt/mem_cache/radix_cache.py:440`

```python
def cache_finished_req(self, req: Req, is_insert: bool = True):
    kv_committed_len = req.pop_committed_kv_cache()
    token_ids = (req.origin_input_ids + req.output_ids)[:kv_committed_len]
    kv_indices = self.req_to_token_pool.req_to_token[
        req.req_pool_idx, : len(token_ids)
    ]
    radix_key = RadixKey(token_ids, req.extra_key, is_bigram=self.is_eagle
                         ).page_aligned(self.page_size)
    values = kv_indices[: len(radix_key)].to(dtype=torch.int64, copy=True)

    if is_insert:
        result = self.insert(InsertParams(key=radix_key, value=values, priority=...))
        # 释放已在树中重复的 KV 槽位
        self.token_to_kv_pool_allocator.free(
            kv_indices[req.cache_protected_len : result.prefix_len]
        )
    # ...
    if req.last_node is not None:
        self.dec_lock_ref(req.last_node)   # 解锁，允许淘汰
```

写入后立即释放与树中已有节点重叠的 KV 槽位（从 `cache_protected_len` 到 `result.prefix_len`），这是**内存去重**的关键环节。`result.prefix_len` 表示已存入树中的前缀长度，对应的 KV 槽位现在由树节点持有，无需请求继续保留。

---

## 6. 引用计数与锁定：lock\_ref

`python/sglang/srt/mem_cache/radix_cache.py:589`

```python
def inc_lock_ref(self, node: TreeNode) -> IncLockRefResult:
    delta = 0
    while node != self.root_node:
        if node.lock_ref == 0:
            self.evictable_size_ -= len(node.key)   # 从可淘汰池移出
            self.protected_size_ += len(node.key)
            delta -= len(node.key)
        node.lock_ref += 1
        self._update_leaf_status(node)
        node = node.parent       # 沿路径向上锁定所有祖先
    return IncLockRefResult(delta=delta)
```

**为什么要沿路径向上锁定所有祖先？** 因为淘汰只能删除叶节点（`_delete_leaf`），删除叶节点后其父节点可能变成新的叶节点并被继续淘汰。如果某个请求正在使用某个节点对应的 KV，必须保证从该节点到根节点的整条路径都不被淘汰，否则路径的中间节点被删除后，树的拓扑结构被破坏，`dec_lock_ref` 就无法正确沿路径向上找到根节点。

`dec_lock_ref` 是对称操作，沿路径向上递减引用计数。当某节点的 `lock_ref` 从 1 降为 0 时，该节点重新进入可淘汰状态（`evictable_size_` 增加）。

`evictable_leaves` 集合维护当前所有可淘汰叶节点，供 `evict` 快速获取候选，由 `_update_leaf_status` 维护：一个节点是可淘汰叶当且仅当 `lock_ref == 0` 且所有子节点均已被淘汰（`value is None`）。

---

## 7. 淘汰策略

### 7.1 evict 流程

`python/sglang/srt/mem_cache/radix_cache.py:560`

```python
def evict(self, params: EvictParams) -> EvictResult:
    num_tokens = params.num_tokens
    leaves = list(self.evictable_leaves)
    eviction_heap = [
        (self.eviction_strategy.get_priority(node), node) for node in leaves
    ]
    heapq.heapify(eviction_heap)    # 最小堆，优先级最小的最先被淘汰

    num_evicted = 0
    while num_evicted < num_tokens and len(eviction_heap):
        _priority, x = heapq.heappop(eviction_heap)
        self.token_to_kv_pool_allocator.free(x.value)  # 归还 KV 槽位
        num_evicted += len(x.value)
        self._delete_leaf(x)        # 从树中删除该节点

        # 若父节点因此变成叶节点且可淘汰，加入堆继续处理
        if len(x.parent.children) == 0 and x.parent.lock_ref == 0:
            new_priority = self.eviction_strategy.get_priority(x.parent)
            heapq.heappush(eviction_heap, (new_priority, x.parent))
        self._record_remove_event(x)

    return EvictResult(num_tokens_evicted=num_evicted)
```

淘汰流程是**叶优先的贪心算法**：始终从叶节点开始删除，因为叶节点没有子节点，删除不会造成树结构破碎。删除叶节点后其父节点可能晋升为新叶节点并继续被选中——这保证了树的"收缩"是从外向内进行的。

`token_to_kv_pool_allocator.free(x.value)` 把该节点持有的 KV 槽位归还给分页分配器，使其可被新请求重用。

### 7.2 六种策略

`python/sglang/srt/mem_cache/evict_policy.py`

```python
class LRUStrategy(EvictionStrategy):
    def get_priority(self, node) -> float:
        return node.last_access_time      # 越老越先被淘汰

class LFUStrategy(EvictionStrategy):
    def get_priority(self, node) -> Tuple[int, float]:
        return (node.hit_count, node.last_access_time)  # 命中次数少的先淘汰

class FIFOStrategy(EvictionStrategy):
    def get_priority(self, node) -> float:
        return node.creation_time         # 越早创建越先被淘汰

class MRUStrategy(EvictionStrategy):
    def get_priority(self, node) -> float:
        return -node.last_access_time     # 最近访问的先被淘汰（适合扫描场景）

class FILOStrategy(EvictionStrategy):
    def get_priority(self, node) -> float:
        return -node.creation_time        # 最新创建的先被淘汰

class SLRUStrategy(EvictionStrategy):
    """Segmented LRU：按访问次数分两段，低频段优先淘汰，段内 LRU。"""
    def __init__(self, protected_threshold: int = 2):
        self.protected_threshold = protected_threshold

    def get_priority(self, node) -> Tuple[int, float]:
        is_protected = 1 if node.hit_count >= self.protected_threshold else 0
        return (is_protected, node.last_access_time)

class PriorityStrategy(EvictionStrategy):
    """优先级感知：低优先级先淘汰，同优先级内 LRU。"""
    def get_priority(self, node) -> Tuple[int, float]:
        return (node.priority, node.last_access_time)
```

默认策略为 `lru`，通过 `--eviction-policy` 参数切换。`SLRUStrategy` 是对 LRU 的改进：将缓存分为"观察段"（hit_count < threshold）和"保护段"（hit_count >= threshold），前者比后者更早被淘汰，避免了偶发单次访问污染缓存。

---

## 8. RadixAttention 与注意力计算的关系

RadixAttention 本质上是一个**在 attention 算子层面无侵入的优化**。其工作方式如下：

```text
Scheduler.get_next_batch_to_run()
    |
    +--> tree_cache.match_prefix(key)
    |         返回命中的 device_indices (KV 槽位序列)
    |
    +--> req.prefix_indices = device_indices  (已有 KV 不需要重算)
    |
    +--> ModelRunner 执行 prefill
    |         prefill 阶段只需处理 (total_len - prefix_len) 个新 token
    |         attention 后端读取 k_buffer/v_buffer 时，前缀部分的
    |         KV 已经存在对应槽位，直接参与注意力计算
    |
    +--> cache_unfinished_req / cache_finished_req
              把新生成的 KV 写回 radix tree
```

**命中前缀的请求节省在哪里？**

- prefill 阶段 Transformer 的 attention 计算量是 `O(n^2)`（n 为序列长度）。前缀命中时，新 token 只需与整个序列（含前缀）做 attention，但**前缀的 QKV 不需要重新计算 Q 和重新存储 KV**，因为 KV 已存在缓冲区。实际节省是前缀段不执行 MLP 和 Attention 的前向，只有新 token 才走完整的前向网络。
- 对于纯共享系统提示（system prompt 共享、不同用户输入）的场景，节省的计算量约等于 `prefix_len / total_len` 比例的 prefill FLOPs。

`RadixAttention` 类（`python/sglang/srt/layers/radix_attention.py`）实际上是各注意力后端（FlashAttention、FlashInfer 等）的封装层，`match_prefix` 返回的 `device_indices` 作为 `loc` 参数传给 `set_kv_buffer`，告诉后端 KV 存在哪些物理槽位。

---

## 9. 进阶：Bigram 视图与 EAGLE 推测解码

EAGLE 推测解码的 draft model 预测下一个 token 时依赖**两个相邻 token 的联合特征**（bigram），其 KV 语义因此也是以 bigram 为单位——一条 KV 对应一对 `(t_i, t_{i+1})` 而非单个 `t_i`。

`RadixKey.maybe_to_bigram_view` 通过一次 O(1) 的标志位翻转实现视图切换，无需物化 tuple 列表（`radix_cache.py:127-138`）。在 bigram 模式下：

- `len(RadixKey(tokens))` 返回 `len(tokens) - 1`（N+1 个 token 产生 N 个 bigram）。
- `__iter__` 遍历相邻对 `(t[i], t[i+1])`。
- `match` 比较时，以原始 token 序列对齐，L 个匹配 token 意味着 L-1 个匹配 bigram（`radix_cache.py:153-160`）。
- `hash_page` 为每个 bigram 写入两个 4 字节 token id（`radix_cache.py:198-203`），保证哈希与单 token 模式的不同命名空间互不干扰。

切换是通过 `CacheInitParams.is_eagle` 标志在 `RadixCache.__init__` 时决定的，整棵树统一使用 bigram 语义或普通语义，不混用。

---

## 10. ASCII 示意图

### Radix Tree 结构举例

插入序列 `[1,2,3]`、`[1,2,4,5]`、`[1,2,4,5,6,7]`、`[8,9,10,11,12]` 后树形如：

<svg viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="A radix cache tree with several nodes">
<rect x="240" y="16" width="120" height="40" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
<text x="300" y="34" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">root</text>
<text x="300" y="49" text-anchor="middle" font-size="9" fill="#64748b">key=[] · lock_ref=1</text>
<line x1="270" y1="56" x2="170" y2="92" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="330" y1="56" x2="460" y2="92" stroke="#94a3b8" stroke-width="1.2"/>
<rect x="100" y="94" width="140" height="42" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="170" y="113" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[1,2]</text>
<text x="170" y="128" text-anchor="middle" font-size="9" fill="#64748b">value=[kv0,kv1]</text>
<rect x="380" y="94" width="170" height="42" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
<text x="465" y="113" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[8,9,10,11,12]</text>
<text x="465" y="128" text-anchor="middle" font-size="9" fill="#64748b">叶 · value=[kv7..kv11]</text>
<line x1="140" y1="136" x2="90" y2="174" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="200" y1="136" x2="250" y2="174" stroke="#94a3b8" stroke-width="1.2"/>
<rect x="24" y="176" width="120" height="42" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
<text x="84" y="195" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[3]</text>
<text x="84" y="210" text-anchor="middle" font-size="9" fill="#64748b">叶 · value=[kv2]</text>
<rect x="190" y="176" width="140" height="42" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="260" y="195" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[4,5]</text>
<text x="260" y="210" text-anchor="middle" font-size="9" fill="#64748b">value=[kv3,kv4]</text>
<line x1="260" y1="218" x2="260" y2="248" stroke="#94a3b8" stroke-width="1.2"/>
<rect x="190" y="250" width="140" height="42" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
<text x="260" y="269" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[6,7]</text>
<text x="260" y="284" text-anchor="middle" font-size="9" fill="#64748b">叶 · value=[kv5,kv6]</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ 一棵 radix cache 树：每个节点存一段 token 与对应 KV 索引，叶节点 lock_ref=0 时可被淘汰</span>

<details>
<summary>ASCII 原版</summary>

```text
root (key=[], value=[], lock_ref=1)
 |
 +-- [1,2] (key=[1,2], value=[kv0,kv1], lock_ref=0)
 |     |
 |     +-- [3]   (key=[3], value=[kv2], lock_ref=0)  <- 叶节点
 |     |
 |     +-- [4,5] (key=[4,5], value=[kv3,kv4], lock_ref=0)
 |           |
 |           +-- [6,7] (key=[6,7], value=[kv5,kv6], lock_ref=0)  <- 叶节点
 |
 +-- [8,9,10,11,12] (key=[8,9,10,11,12], value=[kv7..kv11], lock_ref=0)  <- 叶节点
```

</details>

### 节点分裂过程

<svg viewBox="0 0 600 250" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Radix tree node split before and after">
<defs>
<marker id="r6ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="40" y="34" font-size="11" font-weight="600" fill="#dc2626">分裂前</text>
<text x="40" y="52" font-size="9" fill="#64748b">match_prefix 匹配 [1,2,4,5]，停在节点内部第 4 位</text>
<rect x="60" y="64" width="100" height="38" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="110" y="87" text-anchor="middle" font-size="11" fill="currentColor">[1,2]</text>
<line x1="160" y1="83" x2="206" y2="83" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r6ar)"/>
<rect x="208" y="64" width="160" height="38" rx="8" fill="#fef2f2" stroke="#dc2626"/>
<text x="288" y="83" text-anchor="middle" font-size="11" fill="currentColor">[4,5,6,7]</text>
<text x="288" y="96" text-anchor="middle" font-size="9" fill="#dc2626">匹配边界落在节点中间</text>
<line x1="30" y1="124" x2="570" y2="124" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="40" y="150" font-size="11" font-weight="600" fill="#16a34a">分裂后</text>
<text x="40" y="168" font-size="9" fill="#64748b">在边界处一分为二，暴露精确前缀边界（不复制数据）</text>
<rect x="60" y="182" width="100" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="110" y="208" text-anchor="middle" font-size="11" fill="currentColor">[1,2]</text>
<line x1="160" y1="204" x2="206" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r6ar)"/>
<rect x="208" y="182" width="150" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="283" y="201" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[4,5]　new_node</text>
<text x="283" y="217" text-anchor="middle" font-size="9" fill="#64748b">value=[kv3,kv4]</text>
<line x1="358" y1="204" x2="404" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r6ar)"/>
<rect x="406" y="182" width="150" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="481" y="201" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">[6,7]　child</text>
<text x="481" y="217" text-anchor="middle" font-size="9" fill="#64748b">value=[kv5,kv6]</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ 节点分裂：当匹配边界落在某节点内部时，节点在边界处一分为二，暴露精确的前缀边界</span>

<details>
<summary>ASCII 原版</summary>

```text
插入 [1,2,4,5] 之前，树中已有节点 [1,2,4,5,6,7]。
match_prefix 匹配 [1,2,4,5] 时，在 [1,2,4,5,6,7] 节点内部的第 4 位停止。

分裂前：
  [1,2] --> [4,5,6,7]

分裂后：
  [1,2] --> [4,5] --> [6,7]
             ^
          new_node (key=[4,5], value=[kv3,kv4])
          child    (key=[6,7], value=[kv5,kv6])
```

</details>

### match_prefix 查询 [1,2,4,5,X,Y] 的路径

```text
root
  |  child_key = 1 (或按 page_size 取前 N 个)
  v
 [1,2]
  |  match([4,5,X,Y], key=[4,5,6,7]) -> prefix_len=2 == len([4,5])
  v
 [4,5]
  |  match([X,Y], key=[6,7]) -> prefix_len=0 (X != 6)
  停止，last_node=[4,5] 节点

返回：device_indices = cat([kv0,kv1], [kv3,kv4])
      last_device_node = [4,5] 节点
```

### 淘汰顺序（LRU 为例）

```text
evictable_leaves = {[3], [6,7], [8,9,10,11,12]}  (均 lock_ref=0 且为叶)

heapq 按 last_access_time 升序排列：
  最久未访问的叶节点先被淘汰

删除 [6,7] 后，[4,5] 无子节点 + lock_ref=0 -> 加入 evictable_leaves
删除 [4,5] 后，[1,2] 若 lock_ref=0 且无其他非 evicted 子节点 -> 加入 evictable_leaves
...
```

---

**相关章节**：[第 07 章 KV Cache 内存管理](./07-kv-cache-memory.md) 详述 `ReqToTokenPool`、`TokenToKVPoolAllocator`、`MHATokenToKVPool` 的物理布局与显存管理。
