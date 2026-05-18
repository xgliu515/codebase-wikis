# Trace 步骤 06 —— KV cache manager 怎么分配 block 给这个 request？

> 上一步终态：Scheduler 在 `schedule()` 的阶段 B 走到 `req#1`，决定本 step 给它 `num_new_tokens = 4`。但还**没真分配 KV**——下一行就是 `kv_cache_manager.allocate_slots(req, 4, ...)`。
> 本步聚焦这一行内部发生了什么。

## 1. 当前情境

我们在 `vllm/v1/core/sched/scheduler.py:721`，调用栈是：

```
EngineCore.step
  └─ Scheduler.schedule
        ├─ Scheduler.kv_cache_manager.get_computed_blocks(req)   # 已经调过，全 miss
        └─ Scheduler.kv_cache_manager.allocate_slots(req,
              num_new_tokens=4,
              num_new_computed_tokens=0,
              new_computed_blocks=empty,
              num_lookahead_tokens=0,         # 没开 spec decode
              num_external_computed_tokens=0, # 没开 KV connector
              ...)
```

环境（offline、单 GPU、无 prefix cache hit、无 LoRA、无 multi-modal、无 spec decode）下进一步收缩到：

- `req.num_computed_tokens = 0`
- `req.num_tokens = 4`（仅 prompt token）
- `req.num_prompt_tokens = 4`
- `req.block_hashes = [BlockHash(...)]`（如果 4 ≥ block_size 会有一个；如果 4 < block_size 则 `[]`——下面会推）
- `kv_cache_manager.enable_caching = True`（默认开）
- `kv_cache_manager.coordinator: UnitaryKVCacheCoordinator`（单 KV cache group，Qwen2.5-7B 全是 full attention）
- `kv_cache_manager.coordinator.single_type_managers = (FullAttentionManager,)`
- `block_pool.free_block_queue.num_free_blocks ≈ num_gpu_blocks - 1`（减 null_block）
- `block_size = 16`（默认）

`allocate_slots` 要在返回时让 `req` 有一个**确切的 block table**——指向物理 block 池中的某几个 block——供 worker 后续 forward 时把 K/V 写过去。

## 2. 问题

只有 4 个 token，但池子里 block 是 16 槽位一块。需要回答：

1. **要不要新拿 block，拿几个？** 4 token < 16，肯定只要 1 个 block，但要 1 个？还是 0 个（因为还没填满）？
2. **block 怎么从 pool 里拿出来？** pool 是 doubly-linked list（`FreeKVCacheBlockQueue`）；需要把表头 pop 出来，`ref_cnt` 从 0 → 1。
3. **拿出来的 block 要不要算 hash 立刻塞进 prefix cache？** 算的时机重要——只有"满"的 block 才能被 prefix cache 复用，不满的不能。
4. **新请求全 prefix miss，还需要算 hash 吗？** 关键问题，下文展开。
5. **block table 长什么样？** Scheduler 后面要把它打包进 `SchedulerOutput.scheduled_new_reqs[i].block_ids` 发给 worker。

## 3. 朴素思路

"4 个 token 还没填满一个 16-block，先不分配；等真要写时再说"。或者反过来——"管它满不满，按 `ceil(num_new_tokens / 16) = 1` 拿一块挂上去"。

```python
def allocate_slots(req, num_new_tokens):
    needed = ceil((req.num_computed_tokens + num_new_tokens) / block_size)
    new = needed - len(req.blocks)
    if new > 0:
        blocks = pool.pop_n(new)
        req.blocks.extend(blocks)
    return blocks
```

听起来够简单。

## 4. 为什么朴素思路会崩

1. **延迟分配 = forward 中途 OOM**：worker 真要 forward 时才发现 KV 不够，但那时已经过了 schedule 决策点；要么强行 abort、要么 OOM 崩。所以 allocate 必须**在 schedule 阶段事先完成**，schedule 才能基于"分得到才放 running"决策。
2. **不算 hash → prefix caching 永远命中不了别人**：即使**当前**请求全 prefix miss，**未来**另一个 request 如果前 16 token 跟它一样，应该能直接复用这个 block 的 K/V。但要复用就必须当时算 hash 并塞进 `cached_block_hash_to_block`。若推迟到"我用完才算"，复用机会丢光。
3. **block_size 与 hash 切分不能想当然**：vllm 允许 `hash_block_size != block_size`（hybrid KV 时），算 hash 是按 hash_block_size 切的；而 `req_to_blocks` 是按物理 block_size 切的。两者要一致维护。
4. **`get_num_free_blocks()` 必须**在真 pop 之前**检查**：否则 pop 到一半失败、状态不一致。
5. **shared block 的 ref_cnt**：prefix cache 命中后那个 block 被多个 request 引用，必须 `ref_cnt += 1`、且如果之前在 free_queue 里要从 queue 里移除。简单实现忘了这一步就会有 use-after-free。

## 5. vllm 的做法

`KVCacheManager.allocate_slots`（`kv_cache_manager.py:236`）的核心顺序：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="allocate_slots 9 步流水线及本 trace 的执行轨迹">
  <defs>
    <marker id="t6ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">allocate_slots 9 步流水线（左：通用逻辑 ｜ 右：本 trace 4-token prefill 实际走向）</text>
  <g transform="translate(20, 44)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">① 算 num_local_computed_tokens</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">= req.num_computed + num_new_computed</text>
    <rect x="380" y="0" width="360" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#475569">→ 0 + 0 = 0</text>
    <text x="390" y="34" font-size="10" fill="#64748b">本 trace req 全 fresh</text>
  </g>
  <g transform="translate(20, 94)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">② 算 total_computed_tokens</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">+= num_external_computed (KV connector 用)</text>
    <rect x="380" y="0" width="360" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#475569">→ 0</text>
    <text x="390" y="34" font-size="10" fill="#64748b">无 KV connector</text>
  </g>
  <g transform="translate(20, 144)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">③ coordinator.remove_skipped_blocks</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">SWA / mamba 用</text>
    <rect x="380" y="0" width="360" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#475569">→ no-op</text>
    <text x="390" y="34" font-size="10" fill="#64748b">Qwen 是 full attention</text>
  </g>
  <g transform="translate(20, 194)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">④ get_num_blocks_to_allocate</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">ceil(total / block_size) − 已持有 block</text>
    <rect x="380" y="0" width="360" height="44" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#92400e">→ ceil(4/16) − 0 = 1</text>
    <text x="390" y="34" font-size="10" fill="#a16207">要从池子拿 1 个 block</text>
  </g>
  <g transform="translate(20, 244)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">⑤ 容量检查</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">if needed &gt; free → return None（触发 preempt）</text>
    <rect x="380" y="0" width="360" height="44" fill="#f0fdf4" stroke="#16a34a" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#166534">→ free ≫ 1，通过</text>
    <text x="390" y="34" font-size="10" fill="#14532d">池子初始几乎全空</text>
  </g>
  <g transform="translate(20, 294)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">⑥ touch prefix-cached blocks</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">命中前缀 block 的 ref_cnt += 1</text>
    <rect x="380" y="0" width="360" height="44" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#475569">→ skip</text>
    <text x="390" y="34" font-size="10" fill="#64748b">new_computed_blocks 为空</text>
  </g>
  <g transform="translate(20, 344)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">⑦ allocate_new_blocks</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">从 free_queue 真 pop，ref_cnt 0→1</text>
    <rect x="380" y="0" width="360" height="44" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#92400e">→ pop block #1, ref_cnt=1</text>
    <text x="390" y="34" font-size="10" fill="#a16207">req_to_blocks[req_id] = [#1]</text>
  </g>
  <g transform="translate(20, 394)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">⑧ cache_blocks</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">把"满"的 block 算 hash 写进 prefix map</text>
    <rect x="380" y="0" width="360" height="44" fill="#fef2f2" stroke="#fca5a5" stroke-width="1.5" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#991b1b">→ num_full = 4//16 = 0，return</text>
    <text x="390" y="34" font-size="10" fill="#b91c1c">4 token 不到 1 满 block，hash 不写</text>
  </g>
  <g transform="translate(20, 444)">
    <rect x="0" y="0" width="370" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1" rx="4"/>
    <text x="10" y="18" font-size="11" font-weight="700" fill="#9a3412">⑨ return KVCacheBlocks</text>
    <text x="10" y="34" font-size="10" fill="#7c2d12">交给 scheduler，写入 SchedulerOutput</text>
    <rect x="380" y="0" width="360" height="44" fill="#f0fdf4" stroke="#16a34a" stroke-width="1" rx="4"/>
    <text x="390" y="18" font-size="11" font-family="monospace" fill="#166534">→ KVCacheBlocks(([#1],))</text>
    <text x="390" y="34" font-size="10" fill="#14532d">block_ids=([1],) 进 NewRequestData</text>
  </g>
  <g transform="translate(20, 500)">
    <text x="0" y="14" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">关键洞察：</tspan>只有"满"的 block 才能写进 prefix cache（步骤 ⑧）——未满 block 的剩余 slot 会被本 request 的 decode token 覆盖，若提前算 hash 会污染他人复用</text>
  </g>
</svg>
<span class="figure-caption">图 T6.1 ｜ allocate_slots 的 9 步流水线（左侧通用逻辑、右侧本 trace 4-token 全 miss 的实际执行）。"算需求 → 容量检查 → touch 命中 block → pop 新 block → cache 满 block 算 hash" 覆盖了 prefix cache、容量决策、ref_cnt 维护三件事</span>

<details>
<summary>ASCII 原版</summary>

```
1. 算 num_local_computed_tokens = req.num_computed_tokens + num_new_computed_tokens   # 已计算的 token
2. 算 total_computed_tokens = num_local_computed_tokens + num_external_computed_tokens
3. 调 coordinator.remove_skipped_blocks(...)            # SWA / mamba 用，full attention 是 no-op
4. num_blocks_to_allocate = coordinator.get_num_blocks_to_allocate(
       num_tokens = total_computed_tokens + num_new_tokens + num_lookahead_tokens,
       ...)
5. if num_blocks_to_allocate > block_pool.get_num_free_blocks(): return None   # 容量不够，回到 schedule
6. if 有 prefix-cached blocks 要追加:
       coordinator.allocate_new_computed_blocks(...)    # touch（ref_cnt++）那些被命中的 block
7. new_blocks = coordinator.allocate_new_blocks(req_id, num_tokens_need_slot, ...)
       # 从 block_pool 真的 pop 出新 block
8. if enable_caching and not delay_cache_blocks:
       coordinator.cache_blocks(req, num_tokens_to_cache)   # 把已满的 block 算 hash 并塞进 cache map
9. return KVCacheBlocks(new_blocks)
```

</details>

每一步对应到本 trace（`num_new_tokens=4, num_computed_tokens=0, new_computed_blocks=empty`）：

- 第 1-3 步：`num_local_computed_tokens=0, total_computed_tokens=0`；`FullAttentionManager.remove_skipped_blocks` 是 no-op（只 SWA / chunked-local 有真实逻辑）。
- 第 4 步：`num_tokens_need_slot = 4`，`FullAttentionManager.get_num_blocks_to_allocate`（`single_type_kv_cache_manager.py:89-168`）算 `num_required_blocks = ceil(4/16) = 1`、`num_req_blocks=0`、`num_local_computed_blocks=0`、`num_new_blocks = max(1 - 0, 0) = 1`。**要分配 1 个 block**。
- 第 5 步：池子 `num_gpu_blocks - 1` 个空闲 >> 1，通过。
- 第 6 步：`new_computed_blocks` 空，跳过。
- 第 7 步：`coordinator.allocate_new_blocks → FullAttentionManager.allocate_new_blocks`（`single_type_kv_cache_manager.py:243`）调 `block_pool.get_new_blocks(1)`，pop 表头 block（比如 `block_id=1`），`req_to_blocks[req_id].append(block#1)`、`new_block_ids.append(1)`。
   `BlockPool.get_new_blocks`（`block_pool.py:333-363`）四件事：① `popleft_n(1)` 从 `free_block_queue` 取出表头；② `_maybe_evict_cached_block`：若这块之前缓存过别的 request 的 hash，先擦掉；③ `block.ref_cnt = 1`；④ 记 metrics。
- 第 8 步：`num_tokens_to_cache = min(0 + 4, 4) = 4`。`FullAttentionManager.cache_blocks(req, 4)`（`single_type_kv_cache_manager.py:278`）算 `num_full_blocks = 4 // 16 = 0` —— **关键：不到一个完整 block，直接 return**。
   **block 没算 hash、没进 prefix cache map**。原因：prompt 只 4 个 token，物理 block 只填了 4/16 个槽位。**只有满的 block 才能加入 prefix cache**，否则后续 12 个槽位会被本 request 的 decode token 覆盖，hash 复用就错了。
- 第 9 步：返回 `KVCacheBlocks(([block#1],))`。

返回到 `Scheduler.schedule`，`new_blocks` 非 None，进入 783-804 行的"调度成功"分支：

```python
self.running.append(request)
req_to_new_blocks[request_id] = self.kv_cache_manager.get_blocks(request_id)
num_scheduled_tokens[request_id] = 4
request.status = RequestStatus.RUNNING
request.num_computed_tokens = 0   # 此刻仍 0，forward 跑完后才推进
```

然后 824 行后构造 `SchedulerOutput`，把 `block_ids=([1],)` 塞进 `NewRequestData`。

### block hash 怎么算（chain hash）

虽然本 request 这一步**没**算 hash（因为没满），下一步（decode 阶段 token 数继续增长，或者更长 prompt 的请求）就会触发。机制要在这里说清楚：

`Request.__init__` 末尾调用 `update_block_hashes()`（`request.py:177,230`），其内部回调是 `request_block_hasher`（`kv_cache_utils.py:637-688`）。这个 hasher 在每个 `block_size`-aligned 边界算一次：

```python
block_hash = hash_block_tokens(
    hash_fn,
    prev_block_hash_value,   # ← chain：前一个 block 的 hash 进入本 block 的 hash
    block_tokens,            # 16 个 token id
    extra_keys,              # mm / lora / cache_salt 的额外区分键
)
```

这就是**chain hash**：`H_i = hash(H_{i-1}, tokens_i, extra_keys)`。任何前缀 token 序列只要完全一致、hash 链就一致；只要错一个 token，从那个 block 开始链就断了。

`Request.block_hashes` 是按 hash 顺序排好的 list，长度始终 ≤ `floor(num_tokens / block_size)`。本 trace 里 `num_tokens=4 < 16`，所以 `req.block_hashes = []`。

### 为什么"全 miss 的新请求"也要算 hash

`get_computed_blocks`（`kv_cache_manager.py:194`）拿 `req.block_hashes` 去 `coordinator.find_longest_cache_hit` 查命中。新请求第一次进来时 `block_hashes` 已经在 `__init__` 时算好了（如果 prompt 够长能凑出整 block）。`find_longest_cache_hit`（`single_type_kv_cache_manager.py:483-529`）逐块去 `block_pool.cached_block_hash_to_block` 里 lookup，一旦 miss 立即 break。**所以本 trace 这一步 lookup 是真发生的，只是 prompt 只有 4 个 token、`block_hashes=[]`，循环 0 次，立刻返回 0 命中**。

但当请求确实有满 block 时，**两个角色**：

1. **作为消费者**：用自己的 `block_hashes` 去 lookup，命中就 `touch`（ref_cnt++）别人的 block 复用 K/V。
2. **作为生产者**：自己 forward 完后，`cache_blocks` 把自己的满 block 算 hash 写进 map，**让未来的请求复用**。

`KVCacheBlock.block_hash` 字段（`kv_cache_utils.py:125`）在生产者侧赋值；`BlockPool.cached_block_hash_to_block`（`block_pool.py:171`）是消费者侧 lookup 入口。

### 引用计数的迁移

| 操作 | block.ref_cnt 变化 | free_block_queue |
| --- | --- | --- |
| `BlockPool.get_new_blocks` 拿出新 block | 0 → 1 | popleft，从队列移除 |
| 另一个 request prefix 命中已 cached 的 block，`BlockPool.touch` | k → k+1 | 若 k=0 则从队列移除 |
| `BlockPool.free_blocks` (request 结束) | k → k-1 | 若降到 0 则 append 到队尾（成为 eviction candidate） |
| `cache_full_blocks` 给已满 block 算 hash 并 insert map | 不变 | 不变 |

注意 `ref_cnt=0` 不等于"立即被回收"——它只是"可被驱逐"。只要 hash 还在 `cached_block_hash_to_block` 里且没被新 `get_new_blocks` 弹出来覆盖，下一个相同前缀的请求依然能命中。这是 prefix cache 的核心：**LRU 复用而非立即清空**。

## 6. 代码位置

- `vllm/v1/core/kv_cache_manager.py:194` —— `KVCacheManager.get_computed_blocks`（prefix cache lookup 入口；本 trace 全 miss）
- `vllm/v1/core/kv_cache_manager.py:236` —— `KVCacheManager.allocate_slots`（**本步核心**；编排整个分配流程）
- `vllm/v1/core/kv_cache_manager.py:273-294` —— `allocate_slots` 内部 block 布局图示，务必看
- `vllm/v1/core/kv_cache_coordinator.py:80` —— `KVCacheCoordinator.get_num_blocks_to_allocate`（多 KV cache group 聚合）
- `vllm/v1/core/kv_cache_coordinator.py:163` —— `KVCacheCoordinator.allocate_new_blocks`
- `vllm/v1/core/kv_cache_coordinator.py:198` —— `KVCacheCoordinator.cache_blocks`
- `vllm/v1/core/single_type_kv_cache_manager.py:89` —— `SingleTypeKVCacheManager.get_num_blocks_to_allocate`（算 num_new_blocks 的核心公式）
- `vllm/v1/core/single_type_kv_cache_manager.py:243` —— `SingleTypeKVCacheManager.allocate_new_blocks`（从池中真 pop）
- `vllm/v1/core/single_type_kv_cache_manager.py:278` —— `SingleTypeKVCacheManager.cache_blocks`（把已满 block 算 hash 进 map）
- `vllm/v1/core/single_type_kv_cache_manager.py:481-529` —— `FullAttentionManager.find_longest_cache_hit`（prefix cache lookup 实际算法）
- `vllm/v1/core/block_pool.py:130` —— `BlockPool` 类
- `vllm/v1/core/block_pool.py:149-182` —— `BlockPool.__init__`（构造 `KVCacheBlock` 数组、`FreeKVCacheBlockQueue`、`null_block`）
- `vllm/v1/core/block_pool.py:184-209` —— `BlockPool.get_cached_block`（prefix cache 字典 lookup）
- `vllm/v1/core/block_pool.py:211-331` —— `BlockPool.cache_full_blocks`（生产者侧：算 hash 写 map）
- `vllm/v1/core/block_pool.py:333-363` —— `BlockPool.get_new_blocks`（消费者侧：pop + ref_cnt++）
- `vllm/v1/core/block_pool.py:402-417` —— `BlockPool.touch`（prefix 命中时 ref_cnt++）
- `vllm/v1/core/block_pool.py:419-433` —— `BlockPool.free_blocks`（request 结束时 ref_cnt-- 并可能回收）
- `vllm/v1/core/kv_cache_utils.py:115-161` —— `KVCacheBlock` 数据结构（`block_id`、`ref_cnt`、`_block_hash`、双向链表指针）
- `vllm/v1/core/kv_cache_utils.py:164-279` —— `FreeKVCacheBlockQueue`（O(1) 中间删除的双向链表）
- `vllm/v1/core/kv_cache_utils.py:541-568` —— `hash_block_tokens`（chain hash 单步）
- `vllm/v1/core/kv_cache_utils.py:637-688` —— `get_request_block_hasher`（每 `block_size` 算一次 hash）

**阅读顺序**：先看 `KVCacheBlock` 和 `FreeKVCacheBlockQueue` 的数据结构（kv_cache_utils.py 115-161、164-279），再看 `BlockPool.get_new_blocks` 与 `touch`、`free_blocks` 这三个 ref_cnt 变化点（block_pool.py 333、402、419）；然后回到 `allocate_slots` 的步骤 1-9（kv_cache_manager.py 236-427）整体扫一遍；最后看 `hash_block_tokens` + `get_request_block_hasher` 理解 chain hash。

## 7. 分支与延伸

- **prompt 长到能凑满 N 个完整 block**：第 8 步 `num_full_blocks > 0`，`cache_full_blocks` 把这些 block 算 hash 写入 `cached_block_hash_to_block`，未来相同前缀请求可命中。→ 第 5 章 §6 + 第 2 章 §5
- **prefix cache 命中**：`get_computed_blocks` 返回 `(computed_blocks, num_new_computed_tokens > 0)`；`allocate_slots` 第 6 步走 `allocate_new_computed_blocks` → `BlockPool.touch` 把命中 block ref_cnt++（`block_pool.py:402-417`）；scheduler 那侧 `num_new_tokens` 直接变小。→ 第 5 章 §6
- **KV 不够 → preempt**：第 5 步返回 `None`；scheduler 那侧（`scheduler.py:442-487`）从 running 队尾驱逐再重试。被 preempt 的 request `free()` 还 block、`status=PREEMPTED`、`num_computed_tokens` 归零。→ 第 4 章 §6
- **sliding window / mamba / hybrid KV**：分别由 `SlidingWindowManager`、`MambaManager`、`HybridKVCacheCoordinator`（`kv_cache_coordinator.py:392`）实现；`remove_skipped_blocks` 与 `_max_admission_blocks_per_request` 在 SWA 才有真实逻辑。→ 第 5 章 §5
- **spec decode（eagle / draft model）**：`num_lookahead_tokens > 0`，多分配 lookahead 空间；被拒 draft token 对应 block 在 `cache_blocks` 时通过 `min(..., request.num_tokens)` 排除（`kv_cache_manager.py:421-424`）。→ 第 11 章
- **KV transfer（P/D 解耦）**：`num_external_computed_tokens > 0`；`delay_cache_blocks=True` 让本地 cache 延后到远端 KV 送达后再做。→ 第 5 章 §5 + 第 11 章
- **`cache_salt`**：`SamplingParams.extra_args.cache_salt` 进 `extra_keys`，相同 prompt 不同 salt 不互相命中（多租户隔离）。→ 第 5 章 §6
- **`null_block`**：`block_pool.py:176-177` 把 `block_id=0` 设为 null block，从不参与分配；SWA / mamba 用它作占位。
- **`reset_prefix_cache`**：`block_pool.py:454-487` 仅当所有 block 都 free 时才允许（RLHF / benchmark 用）。
- **block_size 调整**：默认 16；越小内部碎片少但 metadata 多。→ 第 5 章 §4
- **PagedAttention kernel 怎么用 block_table**：`block_ids` 会被 worker 整成 GPU tensor `block_table[B, max_blocks_per_seq]`，kernel 根据 logical position 算 `block_idx`、`offset_in_block` 拿 K/V。→ 第 2 章 §3 + 第 7 章
- **一个 request 完整生命周期里 block 怎么走**：alloc → cache（满时）→ 多请求 touch → finish → `free_blocks` ref-- → 回 free_queue → 可能被新 request `get_new_blocks` 顶掉（`_maybe_evict_cached_block`）。→ 第 5 章 §7

## 8. 走完这一步你脑子里应该多了什么

1. **`allocate_slots` 是 9 步流水线**：算需求 → 容量检查 → touch 命中 block → pop 新 block → cache 满 block 算 hash。9 步覆盖了 prefix cache、容量决策、ref_cnt 维护三件事。
2. **本 trace 4 token 只分配 1 个 block、不算 hash**：因为 `4 // block_size(16) = 0`，没有"满"的 block 可缓存。`req.block_hashes` 也是 `[]`。下一篇 decode 几轮后 `num_tokens` 涨到 16 才会触发 `cache_blocks` 的真正写入。
3. **chain hash 让 prefix cache 用 O(块数) 时间命中任意前缀**：`H_i = hash(H_{i-1}, tokens_i, extra_keys)`，一旦 token 变就断链。新请求即使全 miss 也会**为未来请求**生成 hash——这就是为什么算 hash 跟"自己命不命中"无关。
4. **block.ref_cnt=0 ≠ 立即回收**：它只是"可驱逐"。`cached_block_hash_to_block` 里仍可查到，新请求命中即被 `touch` 救活。**vllm 的 prefix cache 本质上就是这个 LRU + 引用计数 + chain hash 的组合**——没有独立的"缓存层"，prefix cache 就是"free_queue 里还留着 hash 的 block"。
