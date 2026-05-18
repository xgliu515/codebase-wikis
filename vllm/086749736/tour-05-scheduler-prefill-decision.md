# Trace 步骤 05 —— 第一次 step：Scheduler 怎么决定先跑哪个？

> 上一步终态：`waiting` 队列里有 1 个 request（4 个 prompt token，status=WAITING），`running` 为空，KV pool 全 free。
> `_run_engine` 进入 `while has_unfinished_requests: step()`，触发第一次 `EngineCore.step()`。

## 1. 当前情境

`_run_engine`（`vllm/entrypoints/llm.py:1419-1472`）的循环转一圈：

```python
while self.llm_engine.has_unfinished_requests():
    step_outputs = self.llm_engine.step()
    ...
```

`LLMEngine.step`（`llm_engine.py:287`）调 `self.engine_core.get_output()`，对 InprocClient 而言等价于直接调 `EngineCore.step()`（`core.py:425`）。`EngineCore.step` 第一步就是：

```python
if not self.scheduler.has_requests():
    return {}, False
scheduler_output = self.scheduler.schedule()
future = self.model_executor.execute_model(scheduler_output, non_block=True)
...
```

也就是说 step 的第一件事就是调 `Scheduler.schedule()`（`scheduler.py:329`）。此刻 scheduler 看到的状态：

- `self.waiting`（`FCFSRequestQueue`）：1 个 request，4 个 prompt token，`num_computed_tokens=0`，`status=WAITING`
- `self.running`：空 list
- `self.kv_cache_manager.block_pool.free_block_queue.num_free_blocks`：满（≈ `num_gpu_blocks - 1`，减去 `null_block`）
- `self.max_num_scheduled_tokens = max_num_batched_tokens`（默认 8192 或更大；Qwen2.5-7B 通常 8192）
- `self.max_num_running_reqs = max_num_seqs`（默认 256）

`schedule()` 必须返回一个 `SchedulerOutput`，告诉 worker：本 step 跑哪些 request、每个 request 跑多少 token、各自落在哪些 KV block 上。

## 2. 问题

Scheduler 每个 step 都要回答四个互相耦合的问题：

1. **跑什么**：running 里的 request 该被 decode 多少 token？waiting 里的 request 能不能上场 prefill？
2. **跑多少**：单个 step 的总 token 数有上限（`max_num_batched_tokens`，本质是 GPU 一次能容纳的 forward 体量）。怎么在多个 request 之间分配？
3. **KV 够不够**：每个 prefill / decode 的 token 都要落到 KV block 上。block pool 剩余空间够不够？不够要不要 preempt？
4. **prefill 还是 decode 先**：vllm 是 continuous batching——同一 step 里既有 decode（每个 request 1 个新 token），也可能有 prefill（一个新 request 一次性吃 N 个 prompt token）。**谁优先？**

我们这条 trace 极简：running 空、只有 1 个 4-token 的新请求。第 4 问没有竞争，但**算法本身不能为这种简单情形特化**——它要写一段对所有情形都正确的代码。

## 3. 朴素思路

最直观的两段式调度：

```python
def schedule():
    if self.running:
        # decode 阶段：每个 running req 跑 1 个 token
        return decode_batch(self.running)
    elif self.waiting:
        # prefill 阶段：取一个 waiting req，跑全部 prompt token
        req = self.waiting.popleft()
        return prefill_batch([req])
```

每个 step 要么全 decode 要么全 prefill，逻辑清晰，KV 估算容易。

## 4. 为什么朴素思路会崩

四个具体场景：

1. **吞吐被 prefill 撕开**：假设有 100 个 running 在 decode（每 step 0.5 ms），来了一个 8K prompt 的新请求要 prefill（一次 100 ms）。两段式调度会让 100 个 decode 全部等 100 ms，TPS 瞬间塌掉。
2. **prompt 比 `max_num_batched_tokens` 还长怎么办？** 单 step 装不下，又不允许混排，整个请求永远卡在 waiting。
3. **prefill 内存峰值不可控**：8K prompt 一次性 forward，attention 中间态约 `O(8192² × num_heads)`。如果同时再 decode 一些 running，激活值峰值不可预测，容易 OOM。
4. **决策点散落**：先 decode 还是先 prefill、能不能 prefill 一半（chunked prefill）、跑到一半 KV 不够要不要 preempt——分散在 if/else 里，每加一个新特性（spec decode、cascade attention、async scheduling）就要改一遍调度逻辑。

## 5. vllm 的做法

vllm 的核心抽象在 `schedule()` 注释里写得很清楚（`scheduler.py:330-339`）：

> "There's no 'decoding phase' nor 'prefill phase' in the scheduler. Each request just has the `num_computed_tokens` and `num_tokens_with_spec`. At each step, the scheduler tries to assign tokens to the requests so that each request's `num_computed_tokens` can catch up its `num_tokens_with_spec`."

**没有 prefill 阶段也没有 decode 阶段，只有"还差几个 token 算完"**。每个 step 给每个 request 分配 `num_new_tokens` 个 token 的预算去推进它的 `num_computed_tokens`。这一个抽象同时覆盖了：

- 纯 decode（`num_new_tokens=1`）
- 纯 prefill（`num_new_tokens = num_prompt_tokens`）
- chunked prefill（`num_new_tokens < num_prompt_tokens - num_computed_tokens`）
- spec decode（`num_new_tokens` 包含 draft token）
- prefill+decode 混排（同一 step 里不同 request 的 `num_new_tokens` 不一样）

### `schedule()` 算法骨架

```
token_budget = max_num_scheduled_tokens   # 例: 8192

# 阶段 A: 先扫 running（已有 KV 缓存的请求，优先续上）
for req in self.running:
    num_new_tokens = req.num_tokens_with_spec - req.num_computed_tokens
    num_new_tokens = min(num_new_tokens, token_budget,
                         max_model_len - 1 - req.num_computed_tokens)
    new_blocks = kv_cache_manager.allocate_slots(req, num_new_tokens, ...)
    if new_blocks is None:
        # 没 block 了，把 running 队尾 preempt 掉再重试
        preempted_req = self.running.pop(); self._preempt_request(...)
        continue
    schedule(req, num_new_tokens); token_budget -= num_new_tokens
    if token_budget == 0: break

# 阶段 B: 再扫 waiting（新请求，可能要触发 prefix cache lookup）
while self.waiting and token_budget > 0:
    if len(self.running) == max_num_running_reqs: break
    req = self.waiting.peek_request()
    new_computed_blocks, num_local_hit = kv_cache_manager.get_computed_blocks(req)
    num_new_tokens = req.num_tokens - num_local_hit
    if not enable_chunked_prefill and num_new_tokens > token_budget:
        break  # 这个 prefill 装不下，且不允许切分，停止整轮调度
    num_new_tokens = min(num_new_tokens, token_budget)
    new_blocks = kv_cache_manager.allocate_slots(req, num_new_tokens, ...)
    if new_blocks is None: break
    self.waiting.pop_request(); self.running.append(req)
    req.status = RUNNING; schedule(req, num_new_tokens); token_budget -= num_new_tokens
```

**先 running 后 waiting** 不是"decode 优先"——是"已经在算的优先续上"。这避免了"running 请求被新来的 prefill 挤掉以致前面算的 KV 全废"的退化。

### token_budget 是什么

`self.max_num_scheduled_tokens`（`scheduler.py:104-108`）取自 `scheduler_config.max_num_scheduled_tokens` 或回退到 `max_num_batched_tokens`。它表示**单个 step 最多处理多少 token**（prefill + decode 加在一起），物理意义就是"一次 GPU forward 的 input batch 长度上限"。

- 太小：prefill 要切很多刀、吞吐差
- 太大：decode 阶段 attention 算的 K/V 维度太大、激活值峰值高

默认值由 `EngineArgs` 根据模型规模启发式选（Qwen2.5-7B 通常 8192）。

### chunked prefill 在这里何时启动

代码位置在 `scheduler.py:659-669`：

```python
if (not self.scheduler_config.enable_chunked_prefill
        and num_new_tokens > token_budget):
    break
num_new_tokens = min(num_new_tokens, token_budget)
```

也就是说 chunked prefill **不是一个独立的代码路径**——它就是"允许 `num_new_tokens < num_remaining_prompt_tokens`"这一个判断。开了 chunked prefill 就用 `min(num_new_tokens, token_budget)` 切；没开就在装不下时 break，整轮调度提前结束。V1 默认是开的。

### 本 trace 走到 `schedule()` 时具体发生了什么

`running=[]`、`waiting=[req#1]`、`token_budget=8192`：

1. 阶段 A 不进循环（`running` 空）。
2. 阶段 B：waiting 非空、`token_budget > 0`、`len(running) < max_num_running_reqs`，进循环。`peek_request()` 拿到 `req#1`（不出队，可能因 KV 不够跳过）。
3. `req.num_computed_tokens == 0`，触发 `kv_cache_manager.get_computed_blocks(req)`（`scheduler.py:591-594`），即 prefix cache lookup。**新请求且 pool 全空，全 miss**：`num_new_local_computed_tokens=0`。
4. `num_new_tokens = 4 - 0 = 4`，`4 < 8192`，进入分配。
5. 调 `kv_cache_manager.allocate_slots(req, num_new_tokens=4, ...)`（`scheduler.py:721`，下一篇主题）。预期返回 1 个新 block（block_size=16 ≥ 4）。
6. `pop_request()` 把 `req#1` 从 waiting 移到 running，`status=RUNNING`，`num_computed_tokens` 仍为 0（这一步只调度、没真跑），`num_scheduled_tokens[req_id] = 4`。
7. 构造 `SchedulerOutput`（`scheduler.py:887-903`）：`scheduled_new_reqs = [NewRequestData(req#1, block_ids=([blk_id],))]`、`scheduled_cached_reqs=empty`、`num_scheduled_tokens={req_id: 4}`、`total_num_scheduled_tokens=4`、`num_common_prefix_blocks=[0]`。

### NewRequestData vs CachedRequestData

`SchedulerOutput`（`vllm/v1/core/sched/output.py:181`）有两个请求列表：

- `scheduled_new_reqs: list[NewRequestData]` —— **首次**被调度的请求，把完整元数据（prompt_token_ids、sampling_params、block_ids）一次性发给 worker，worker 在自己进程里缓存
- `scheduled_cached_reqs: CachedRequestData` —— 之前已发过元数据的请求，只发增量（新分配的 block_id、新 token id）

我们这一步 `req#1` 是 first-time，所以进 `scheduled_new_reqs`。后续 decode step 进 `scheduled_cached_reqs`（步骤 14 见）。这个 new/cached 拆分是 V1 一个明显的设计——避免每个 step 重复序列化几 KB 的 prompt token id。

## 6. 代码位置

- `vllm/v1/engine/core.py:425` —— `EngineCore.step`（入口；判 `has_requests` → 调 `schedule` → 调 `execute_model`）
- `vllm/v1/core/sched/scheduler.py:329` —— `Scheduler.schedule`（**本步主战场**）
- `vllm/v1/core/sched/scheduler.py:330-339` —— `schedule` 的算法核心注释（务必读）
- `vllm/v1/core/sched/scheduler.py:364-499` —— 阶段 A：running 队列循环
- `vllm/v1/core/sched/scheduler.py:544-823` —— 阶段 B：waiting 队列循环
- `vllm/v1/core/sched/scheduler.py:591-633` —— prefix cache lookup（`get_computed_blocks`）
- `vllm/v1/core/sched/scheduler.py:654-669` —— chunked prefill 切分决策
- `vllm/v1/core/sched/scheduler.py:721-740` —— 调 `allocate_slots`（→ 步骤 06）
- `vllm/v1/core/sched/scheduler.py:783-804` —— request 从 waiting 移到 running、状态改 RUNNING
- `vllm/v1/core/sched/scheduler.py:825-903` —— 构造 `SchedulerOutput`
- `vllm/v1/core/sched/scheduler.py:80-108` —— scheduler 配置：`max_num_scheduled_tokens`、`max_num_running_reqs`、`max_model_len`
- `vllm/v1/core/sched/scheduler.py:1755` —— `add_request`（上一篇）
- `vllm/v1/core/sched/output.py:30-83` —— `NewRequestData`
- `vllm/v1/core/sched/output.py:111-177` —— `CachedRequestData`
- `vllm/v1/core/sched/output.py:181-241` —— `SchedulerOutput`
- `vllm/v1/core/sched/request_queue.py:75` —— `FCFSRequestQueue`（默认 waiting 队列）

**阅读顺序**：先读 `schedule` 注释（330-339 行）理解"没有 prefill/decode 阶段"的设计；再跳到 364-499 行看阶段 A 骨架（即便本 trace 不进，理解它是理解阶段 B 的前提）；再读 544-823 行的阶段 B，对照本步具体走到第 591、721、783 行的分支；最后读 825-903 行 `SchedulerOutput` 怎么打包。

## 7. 分支与延伸

- **running 非空（continuous batching）**：阶段 A 先消耗 token_budget 给 running，剩多少给 waiting prefill。decode 和 prefill 会出现在同一个 `SchedulerOutput` 里，对 worker 是一次 forward。→ 第 4 章 §4 + 第 2 章 §4
- **chunked prefill 打开 vs 关闭**：开（默认）→ 长 prompt 切多个 step；关 → 单 step 装不下就 break。→ 第 4 章 §5 + 第 2 章 §6
- **`max_num_batched_tokens` / `max_num_seqs` 调小**：前者降低单 step 算力上限、prefill 被切碎；后者限制 concurrency。→ 第 4 章 §12
- **priority scheduling**：阶段 A preempt 时选最低优先级（`scheduler.py:456-466`），阶段 B 从 `PriorityRequestQueue` 取。→ 第 4 章 §12
- **PP > 1**：`scheduler.py:425` 注释指出 `num_new_tokens=0` 的合法情形之一就是 PP 已调度但未完成。→ 第 10 章
- **spec decode**：阶段 A 的 `num_tokens_with_spec` 包含 draft token；`scheduled_spec_decode_tokens` 单独列出。→ 第 11 章
- **结构化输出**：grammar 未编译完的请求被 `_is_blocked_waiting_status` 跳过、塞进 `skipped_waiting`（`scheduler.py:558-569`）。→ 第 11 章
- **KV 不够 → preempt**：阶段 A 的 `while True: allocate_slots ... preempt`（`scheduler.py:442-487`）从 running 队尾抢资源。本 trace 不触发但是核心机制。→ 第 4 章 §6
- **async scheduling**：`AsyncScheduler` 允许在 forward 没完成时提前 schedule 下一个 step。→ 第 4 章 §10
- **cascade attention**：`num_common_prefix_blocks` 让多 request 共享 prefix 的 attention 计算（`kv_cache_manager.py:476`）。→ 第 5 章 §8 + 第 7 章

## 8. 走完这一步你脑子里应该多了什么

1. **scheduler 没有 prefill/decode 阶段的概念**，只有"`num_new_tokens` = `num_tokens_with_spec - num_computed_tokens`"这一条统一公式。这个抽象一次性吃下了 chunked prefill、continuous batching、spec decode 三大特性。
2. **每个 step 由 `token_budget`（= `max_num_batched_tokens`）切两段：先 running 后 waiting**。阶段 A 保证已在跑的 request 不被新 prefill 挤掉，阶段 B 让剩余预算去启新 prefill。
3. **chunked prefill 不是独立路径**，只是允许 `num_new_tokens < num_remaining_prompt_tokens` 的一个判断（`scheduler.py:659-669`）。
4. **`SchedulerOutput` 把 first-time 与已 cached 请求分两段发**：`scheduled_new_reqs` 带完整元数据、`scheduled_cached_reqs` 只带增量。本 trace 里 `req#1` 是 first-time，所以进前者。
5. 本步**没真分配 KV**——`schedule()` 调了 `kv_cache_manager.allocate_slots`（步骤 06 主题）才真的把 block 拿出来。schedule 这一层只是"决策 + 触发"。
