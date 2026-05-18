# 第 16 步 —— max_tokens=3 命中：怎么停下来、KV cache 怎么回收？

> 这是 vllm 单请求 trace 的第 16 步。
> 上一步：第三次 step 跑完，第 3 个 token 落地、append 到 `output_token_ids`，`num_output_tokens` 变成 3。
> 本步：scheduler 在 `update_from_output` 里检查到 stop 条件命中，把 request 标 FINISHED；KV blocks 被释放回 pool；但 block 没真删——保留给 prefix cache。

## 1. 当前情境

第三次 `EngineCore.step()` 已经走到 `self.scheduler.update_from_output(scheduler_output, model_output)` (`vllm/v1/engine/core.py:450`)。`model_output.sampled_token_ids` 里有 req#1 的第 3 个 token id。

trace 状态：

- `system.req_queue`：running 仍然只有 req#1，`num_output_tokens` 即将变 3
- `system.kv_pool`：req#1 占 1 个 block（5 prompt+output token, 现在加到 7 token, 仍在第 1 个 block 内）
- `outputs`：[tok1, tok2]，第 3 个还没 append

`SamplingParams(max_tokens=3)` 是用户传进来的硬上限。问题是：这个上限**什么时候**被检查、检查完之后**做什么**？

## 2. 问题

(a) **停止判定要早不要晚**。等到下一次 scheduler 调度时再说？太迟——多浪费一次 KV 占用、worker 多准备一次 input batch。

(b) **KV cache 要还回 pool**。req#1 持有 1 个 block，再不还，pool 的 free 列表少 1，下一个请求来要先抢这块。

(c) **真的"删"吗？** prefix caching 是 vllm 的关键优化（参考第 2 章 §5）。如果用户下一次发送相同的 "你好" 前缀，能不能命中这块刚算完 KV 的 block，跳过 prefill？要能命中，**就不能真删**——要在 free 队列里、但 hash 索引还在。

所以问题更精确地说：怎么实现一种"逻辑上 free 但物理上保留可复用"的释放？

## 3. 朴素思路

```python
if request.is_finished():
    for block in request.blocks:
        block_pool.return_to_free_list(block)
        del block_pool.hash_to_block[block.hash]  # 简单清理
del scheduler.requests[request.request_id]
```

简单粗暴。但每次 free 立即把 hash 索引清掉，prefix cache 永远不命中。

## 4. 为什么朴素思路会崩

(a) **prefix cache 失效**。chatbot 场景下大量请求共享 system prompt 前缀（几百到几千 token）。如果每次请求结束都清掉对应 block 的 hash，下一个请求的 prefill 要把这几千 token 重新算一遍——这是 vllm 最招牌的优化失效。

(b) **池容量管理变难**。如果"保留"意味着 block 留在 pool 占着不能 reuse，pool 容量会被早期请求长期挤占；如果"保留"意味着可以被 reuse，那要回答"什么时候真删它"。

(c) **多 request 共享 block 怎么办**。两个 request 共享前缀，前缀 block 被两个 request 引用。第一个 request 结束时直接"free"会把第二个 request 的 KV 也带走，崩。

## 5. vllm 的做法

**用 `ref_cnt` + LRU free queue 解耦"逻辑 free"和"物理 evict"**。

整个流程发生在 `Scheduler.update_from_output` 里 (`vllm/v1/core/sched/scheduler.py:1283`)，对每个返回了 token 的 request：

**Step 5a：append token + 检查 stop**（`vllm/v1/core/sched/scheduler.py:1406-1414`）

```python
new_token_ids, stopped = self._update_request_with_output(request, new_token_ids)
```

`_update_request_with_output` (`vllm/v1/core/sched/scheduler.py:1649-1665`) 内部循环：每 append 一个 token 就调一次 `check_stop` (`vllm/v1/core/sched/utils.py:94`)。

`check_stop` 按顺序判（`vllm/v1/core/sched/utils.py:94-117`）：

1. `num_output_tokens < min_tokens` → 不停
2. `last_token_id == eos_token_id` → 标 `FINISHED_STOPPED`
3. `last_token_id in stop_token_ids` → 标 `FINISHED_STOPPED`
4. `num_tokens >= max_model_len or num_output_tokens >= max_tokens` → 标 `FINISHED_LENGTH_CAPPED`

我们这个 trace：`max_tokens = 3`，append 第 3 个 token 时 `num_output_tokens = 3 >= 3` 命中第 4 条 → 状态变 `FINISHED_LENGTH_CAPPED`，返回 `True`。

**Step 5b：处理 stop**（`vllm/v1/core/sched/scheduler.py:1473-1485`）

```python
if stopped:
    finish_reason = request.get_finished_reason()  # → FinishReason.LENGTH
    finished = self._handle_stopped_request(request)
    if finished:
        kv_transfer_params = self._free_request(request)
    if status_before_stop == RequestStatus.RUNNING:
        stopped_running_reqs.add(request)
```

`_handle_stopped_request` (`vllm/v1/core/sched/scheduler.py:1631-1647`) 对 streaming / resumable 请求有分支；本 trace `resumable=False`，直接返回 `True`。

**Step 5c：真的 free**（`_free_request` at `vllm/v1/core/sched/scheduler.py:1842-1858`）

```python
def _free_request(self, request, delay_free_blocks=False):
    assert request.is_finished()
    connector_delay_free_blocks, kv_xfer_params = self._connector_finished(request)
    self.encoder_cache_manager.free(request)
    self.finished_req_ids.add(request_id)
    if not delay_free_blocks:
        self._free_blocks(request)
    return kv_xfer_params

def _free_blocks(self, request):
    self.kv_cache_manager.free(request)
    del self.requests[request.request_id]
```

`KVCacheManager.free` (`vllm/v1/core/kv_cache_manager.py:429`) 直接转给 coordinator：

```python
def free(self, request):
    self.coordinator.free(request.request_id)
```

coordinator 最终调到 `BlockPool.free_blocks` (`vllm/v1/core/block_pool.py:419-433`)：

```python
def free_blocks(self, ordered_blocks):
    blocks_list = list(ordered_blocks)
    for block in blocks_list:
        block.ref_cnt -= 1
    self.free_block_queue.append_n(
        [block for block in blocks_list if block.ref_cnt == 0 and not block.is_null]
    )
```

**这里是设计精华**：

1. `ref_cnt -= 1`——多 request 共享 block 的情况，只有所有持有者都 free 后 `ref_cnt` 才归零
2. `ref_cnt == 0` 的 block 被 `append_n` 到 `free_block_queue` **尾部**——这是个**双向链表 LRU**（`FreeKVCacheBlockQueue` at `vllm/v1/core/kv_cache_utils.py:164`），尾部最新、头部最旧（LRU 最先被复用）
3. **block 的 hash 索引没被删**——`cached_block_hash_to_block` 字典里还有 `block_hash → block` 的映射

**这意味着**：如果在 block 真的被 reuse 之前，有新请求带相同前缀进来，`get_cached_block` (`vllm/v1/core/block_pool.py:184`) 能查到这个 block，调 `touch` (`vllm/v1/core/block_pool.py:402`) 把它的 `ref_cnt` 从 0 增到 1、从 free queue 里移出。**prefix cache 命中**。

**block 何时真被从 prefix tree 里抹掉？**

只有当 pool 没新 block 可用、`get_new_blocks` (`vllm/v1/core/block_pool.py:333`) 从 free queue 头部 pop 一个 block，调 `_maybe_evict_cached_block` (`vllm/v1/core/block_pool.py:365-400`)，这一刻才把 `cached_block_hash_to_block` 里的对应条目清掉、`block.reset_hash()`。

所以 prefix cache 是"懒驱逐"：**直到真的需要这块物理内存做别的，才放弃它的缓存身份**。

### LRU + 顺序的微妙细节

`KVCacheManager.free` 注释（`vllm/v1/core/kv_cache_manager.py:429-432`）：

> "We free the blocks in reverse order so that the tail blocks are evicted first when caching is enabled."

意思是：一个 request 的 block 链 [b0, b1, b2]，free 时按 [b2, b1, b0] 顺序 append 到 free queue 尾。这样未来 pop 时是 b0 先被复用——前缀 block 留得更久，**提高 prefix cache 命中率**。这是个看似微小但对 chatbot 场景命中率影响巨大的细节。

### 序列层面：构造 RequestOutput

继续看 `update_from_output` (`vllm/v1/core/sched/scheduler.py:1500-1523`)：构造 `EngineCoreOutput`，字段含 `request_id`、`new_token_ids`、`finish_reason = LENGTH`、`stop_reason`、`kv_transfer_params`。这条 output **不发送给用户**——它沿 EngineCore 返回到 LLMEngine，由 OutputProcessor 接走（第 17 步主题）。

`finished_req_ids` 这个 set（`vllm/v1/core/sched/scheduler.py:1850`）会随下一次 `SchedulerOutput.finished_req_ids` 字段告诉 worker"这些 req 的 cached state 可以清了"。本 trace 没下一次 step，不影响主线。

## 6. 代码位置

主线：

- `vllm/v1/core/sched/scheduler.py::Scheduler.update_from_output` (`vllm/v1/core/sched/scheduler.py:1283`) —— stop 判定 + free 入口
- `vllm/v1/core/sched/scheduler.py::Scheduler._update_request_with_output` (`vllm/v1/core/sched/scheduler.py:1649`) —— append + check_stop 循环
- `vllm/v1/core/sched/utils.py::check_stop` (`vllm/v1/core/sched/utils.py:94`) —— 4 个停止条件
- `vllm/v1/core/sched/scheduler.py::Scheduler._free_request` (`vllm/v1/core/sched/scheduler.py:1842`) → `_free_blocks` (`vllm/v1/core/sched/scheduler.py:1860`)
- `vllm/v1/core/kv_cache_manager.py::KVCacheManager.free` (`vllm/v1/core/kv_cache_manager.py:429`)
- `vllm/v1/core/block_pool.py::BlockPool.free_blocks` (`vllm/v1/core/block_pool.py:419`) —— ref_cnt 减一 + LRU append
- `vllm/v1/core/block_pool.py::BlockPool.get_new_blocks` (`vllm/v1/core/block_pool.py:333`) —— 真 evict 在这里发生
- `vllm/v1/core/block_pool.py::BlockPool._maybe_evict_cached_block` (`vllm/v1/core/block_pool.py:365`) —— hash 索引清理
- `vllm/v1/core/kv_cache_utils.py::FreeKVCacheBlockQueue` (`vllm/v1/core/kv_cache_utils.py:164`) —— LRU 双向链表实现

**阅读顺序**：从 `update_from_output` 进入，看 stopped 分支怎么调 `_free_request`；下到 `_free_blocks` → `KVCacheManager.free` → `BlockPool.free_blocks` 看 ref_cnt 怎么变；再单独看 `_maybe_evict_cached_block` 理解"懒驱逐"；最后扫一眼 `FreeKVCacheBlockQueue` 的注释（`vllm/v1/core/kv_cache_utils.py:172-180`）理解 LRU 顺序约定。

## 7. 分支与延伸

- **抢占场景下 free 怎么变？** preempt 时同样调 `_free_request`（路径在 `vllm/v1/core/sched/scheduler.py:935-940`），但 request 被推回 waiting 队列、KV 全释放、下次重 schedule 时重新 prefill → 第 4 章 §6 "抢占与 free"
- **prefix tree 怎么组织 hash？为什么不直接用 block_id？** `block_hash` 是 `(prev_hash, token_ids_chunk)` 的 hash，构造 prefix chain → 第 5 章 §6 "prefix tree"
- **多 request 共享 block 的 ref_cnt 是怎么算上去的？** prefix cache 命中调 `touch` (`vllm/v1/core/block_pool.py:402-417`)；新 request 走 `allocate_slots` 内部判定，复用走 `touch` 否则走 `get_new_blocks` → 第 5 章 §4 "BlockPool ref_cnt"
- **`enable_prefix_caching=False` 时这一切退化成什么？** ref_cnt 还在，但不维护 hash 索引；free 后下次直接 pop reuse、永不命中 → 第 2 章 §5 "prefix caching"
- **disk offload / KV connector 场景下 `delay_free_blocks` 干什么？** 等异步 KV 传输完成才真 free → 第 5 章 §9 "KV connector" + `vllm/v1/core/sched/scheduler.py:1854`
- **stop 条件里还有 `repetition_detection`、structured output grammar 等高级特性的 stop hook，分别怎么挂？** → 第 4 章 §3 + 第 9 章 §5（采样后处理）

## 8. 走完这一步你脑子里应该多了什么

1. stop 判定在 **append token 的同时**做（`_update_request_with_output` 的 for 循环里），不等下一步 schedule
2. `RequestStatus.FINISHED_LENGTH_CAPPED` vs `FINISHED_STOPPED` vs `FINISHED_ABORTED` 几种 finish 状态对应不同 `FinishReason`——`max_tokens` 触发的是 `LENGTH`，会反映到用户拿到的 `RequestOutput.outputs[0].finish_reason`
3. **free 是逻辑操作不是物理操作**：`ref_cnt -= 1` + 进 LRU 队列。物理 evict 只在新 block 不够用、要从 free queue 头部 pop 时才发生
4. block 在 free queue 里期间，**hash 索引还在**——这就是 prefix cache 命中的窗口；窗口宽窄取决于 pool 压力（请求多→快被复用→prefix cache miss 多）
5. `free_blocks` 内部按 reverse 顺序 append 的细节，是把"前缀 block"留到 free queue 更靠后位置——专门为提高 chatbot system prompt 命中率而设
6. `_free_request` 不直接返给用户输出——它只清理 EngineCore 侧的状态；用户拿到 string 是第 17 步 OutputProcessor + Detokenizer 的事
