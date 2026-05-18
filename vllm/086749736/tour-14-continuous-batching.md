# 第 14 步 —— 第二次 step：continuous batching 在这里第一次发挥作用

> 这是 vllm 单请求 trace 的第 14 步。
> 上一步：第一个 token 已经回到 EngineCore，request 状态从 prefill 切到 decode，waiting queue 空，running queue 里只有这 1 个 request。
> 本步：第二次进入 `EngineCore.step()`，Scheduler 第二次开会，决定本 step 给这个 decode-mode 的 request 算 1 个 token。

## 1. 当前情境

trace 的状态变量目前长这样：

- `system.req_queue`：waiting 空；running 只有 req#1（已生成 1 个 token、`num_computed_tokens = 5`、`num_tokens_with_spec = 5`、还差 2 个 token 才到 `max_tokens=3`）
- `system.kv_pool`：req#1 持有 1 个 block（4 prompt token + 1 output token = 5 token，没超过 block_size=16）
- `outputs`：req#1 累积了 1 个 token id

`LLM._run_engine` 看见 `has_unfinished_requests() == True`，第二次调 `llm_engine.step()`，进而到 `EngineCore.step()` (`vllm/v1/engine/core.py:425`)，第一行就是 `scheduler_output = self.scheduler.schedule()` (`vllm/v1/engine/core.py:436`)。

我们就站在这一刻：scheduler 第二次被叫醒，要决定"本 step 跑哪些 request、各算多少 token"。

## 2. 问题

我们这个 request 现在只想要 1 个 token：用上一个 token 当 query，把 attention 跑一遍，sampler 出 1 个新 token。

**真正的问题不在"这 1 个 token 怎么算"**——那是第 15 步的事。本步要问的是：

**为什么 vllm 要在每个 step 都重新跑一次 schedule？这种"每 token 都重新调度"对单 request 看起来完全是浪费——直接循环 `forward → sample → forward → sample` 不就行了吗？**

更深一层的问题：**如果此刻有一个新 request 进来（waiting queue 不再是空的），vllm 怎么把它和这个 decode 一起跑？**

## 3. 朴素思路

传统 batching（HuggingFace `transformers.generate` 默认行为、早期的 inference server）是 **request-level batching**：

```
收一批 N 个 prompt → 拼成 batch → for step in range(max_new_tokens): forward → 全部跑完 → 返回
```

实现简单，单 request 看似没浪费。要加新 request？等当前这一批整体跑完再说。

## 4. 为什么朴素思路会崩

两个具体失败模式，**与"性能差"无关**：

**(a) 早完成的请求被劫持**。一批里如果有的 prompt 30 token 就 EOS、有的要 2000 token，那么前者要陪后者**白白做 1970 次 forward**——它的 KV 还在显存里、它的位置占着 batch 槽位、它的 token 被 mask 掉但仍参与计算。GPU 利用率没问题，**有效 throughput** 崩盘。

**(b) 新请求要排到下一整批**。哪怕 GPU 此刻只有 1 个 active 请求、闲了 90% 的 SM、KV pool 还剩一大半，新进来的 request 也得等当前这批彻底跑完。**首 token 延迟**直接退化成"上一批剩余生成时间"。

朴素思路把"调度粒度"和"请求生命周期"绑死，于是无法响应运行中状态变化。

## 5. vllm 的做法

**Iteration-level scheduling** ——每一个 step 都重新调度，所有还活着的 request（包括新进来的）一起进入决策。

具体到本 trace 第二次 step：

1. `Scheduler.schedule()` 进来时（`vllm/v1/core/sched/scheduler.py:329`），先看 running queue
2. 对 running 里每个 request，算 `num_new_tokens = num_tokens_with_spec + num_output_placeholders - num_computed_tokens` (`vllm/v1/core/sched/scheduler.py:385-389`)
3. 我们的 req#1：`5 - 5 = 0`？不对——`num_tokens_with_spec` 在上一步 `update_from_output` 已经更新成 6（prompt 4 + output 1 + 想算下一个 1 没算进去）。回看代码：实际上 `num_tokens_with_spec = num_prompt + num_output + num_spec`，第一个 token 已 append 到 output，于是 5；而 `num_computed_tokens` 也是 5（attention 算完那 5 个位置）。所以 num_new_tokens = ... **等等**。

更准确地说：第一步 prefill 的 `num_computed_tokens` 推到 4（prompt 完成）；sampler 出新 token，append 到 output_token_ids → `num_tokens` 变 5，但 `num_computed_tokens` 仍然 4。所以本 step 算 `5 - 4 = 1`，正是 decode 想要的 1 个 token。这就是为什么 scheduler 注释（`vllm/v1/core/sched/scheduler.py:330-339`）里强调："**There's no decoding phase nor prefill phase in the scheduler. Each request just has num_computed_tokens and num_tokens_with_spec.**"

4. `num_new_tokens = min(num_new_tokens, token_budget)` (`vllm/v1/core/sched/scheduler.py:392`)。token budget 来自 `max_num_batched_tokens`（构造时存在 `vllm/v1/core/sched/scheduler.py:107`，schedule 进来时复制成局部 `token_budget = self.max_num_scheduled_tokens` (`vllm/v1/core/sched/scheduler.py:348`)）。decode 1 个 token 几乎不占预算。
5. KVCacheManager 给这个 request 算"还需要多少新 block"——本 trace 还在第 1 个 block 内（5 < 16），不需要新 block。`allocate_slots` 返回空 list。
6. 把 req#1 加进 `scheduled_running_reqs`，记录 `num_scheduled_tokens[req#1] = 1`，进入 `CachedRequestData`（不是 `NewRequestData`：worker 已经缓存过该 request 的元数据）。
7. 接着 schedule waiting queue——空，跳过。
8. 组装 `SchedulerOutput` (`vllm/v1/core/sched/output.py:180`) 返回，关键字段：
   - `scheduled_new_reqs = []`
   - `scheduled_cached_reqs.req_ids = [req#1]`，对应 `num_computed_tokens = [4]`
   - `num_scheduled_tokens = {req#1: 1}`
   - `total_num_scheduled_tokens = 1`

**关键洞察**：这套设计让"新请求加入"零成本。假设此刻 waiting queue 有一个新 req#2 (10 token 的 prompt)：

- 调度 running 时给 req#1 留 1 个 token，token_budget 还剩很多
- 接着调度 waiting 时把 req#2 加入 `scheduled_new_reqs`，给它 10 个 prefill token
- `SchedulerOutput` 里两个 request 都在，**worker 一次 forward 同时算 req#1 的 1 个 decode token + req#2 的 10 个 prefill token**

这就是 **prefill-decode 混合 batch**——V1 的核心能力。`cu_seqlens = [0, 10, 11]`，attention kernel 内部用 varlen 接口一次跑完两段。

### chunked prefill 在这里的作用（虽然本 trace 不用）

如果一个 request 的 prompt 有 8000 token，`max_num_batched_tokens = 2048`，单 step 塞不下。`num_new_tokens` 会被 `min(num_new_tokens, token_budget)` 截到 2048（`vllm/v1/core/sched/scheduler.py:392`）；剩下的 5952 token 留到后续 step。每个 step 还能顺带带几个 decode-mode 的 token——chunked prefill 本质上就是"把超长 prefill 切成多个 step，每个 step 还能搭载 decode"。

`long_prefill_token_threshold` (`vllm/v1/core/sched/scheduler.py:390`) 是显式控制 chunk 上限的参数。

### 与 V0 调度器的差异

V0 调度器内部有 `running / waiting / swapped` 三态，且**显式区分** prefill / decode 阶段：一个 step 要么全是 prefill 要么全是 decode（早期甚至 prefill-only batch + 单独的 decode batch）。混合需要后期加的"chunked prefill"特性硬塞进去。

V1 的设计是"统一 token 视角"：scheduler 不知道什么叫 prefill、什么叫 decode，只看 `num_computed_tokens` 落后 `num_tokens_with_spec` 多少 token。这让 chunked prefill、spec decode、jump decoding 这些"非 1 即 N"的需求**自然落地**，不用额外分支。

V0 还把 swap（KV 换到 CPU）作为 first-class 概念；V1 直接放弃 swap，**抢占就是把 KV 释放、request 推回 waiting 队列下次重算**——理由是显存换 CPU 来回搬本身比 recompute 慢，且 V1 prefix caching 高命中率使 recompute 经常能复用历史 block。这是 V1 一个看似"退化"实则提升的设计选择。

### 本步的产物：SchedulerOutput 长这样

```text
SchedulerOutput(
    scheduled_new_reqs=[],
    scheduled_cached_reqs=CachedRequestData(req_ids=["req#1"], num_computed_tokens=[4], ...),
    num_scheduled_tokens={"req#1": 1},
    total_num_scheduled_tokens=1,
    finished_req_ids=set(),
    ...
)
```

这玩意会被 `model_executor.execute_model(scheduler_output, ...)` (`vllm/v1/engine/core.py:437`) 送到 worker 进程；worker 据此组装 input batch、跑 forward——下一步主题。

## 6. 代码位置

主线：

- `vllm/v1/engine/core.py::EngineCore.step` (`vllm/v1/engine/core.py:425`) —— 第二次进入此函数
- `vllm/v1/core/sched/scheduler.py::Scheduler.schedule` (`vllm/v1/core/sched/scheduler.py:329`) —— 主调度循环
- `vllm/v1/core/sched/scheduler.py:364-465` —— RUNNING 队列调度分支
- `vllm/v1/core/sched/utils.py::check_stop` (`vllm/v1/core/sched/utils.py:94`) —— 上一步生成 token 后才知道有没有触发 stop
- `vllm/v1/core/sched/output.py::SchedulerOutput` (`vllm/v1/core/sched/output.py:180`) + `CachedRequestData` (`vllm/v1/core/sched/output.py:112`) —— 输出数据结构

**阅读顺序**：先读 `EngineCore.step` 看一个 step 的整体编排（schedule → execute_model → update_from_output）；再到 `Scheduler.schedule` 头部那段 `NOTE(woosuk)` 注释（`vllm/v1/core/sched/scheduler.py:330-339`）——它把 V1 调度哲学浓缩成 10 行；最后看 `SchedulerOutput` 的字段定义，理解 worker 需要哪些信息。

## 7. 分支与延伸

- **多 request 的 prefill / decode 混合到底怎么打包？** → 第 4 章 §3 "schedule 主流程" + §4 "continuous batching"
- **token budget 怎么定？为什么默认 2048？** → 第 4 章 §3；与第 1 章 §3 "调度器与 EngineCore 的边界"
- **chunked prefill 真要展开看？** → 第 2 章 §1 "prefill / decode 两阶段" + 第 4 章 §3（`long_prefill_token_threshold`）
- **async scheduling 模式（调度和 worker 异步流水）有什么区别？** → 第 4 章 §10 "与 worker 异步流水线"；本 trace 默认同步模式
- **优先级调度（如 `priority` 字段）怎么改变这套循环？** → 第 4 章 §5 "优先级与抢占"
- **V0 vs V1 调度差异要再多看？** → 第 2 章 §4 "continuous batching" 中两段历史背景

## 8. 走完这一步你脑子里应该多了什么

1. **Iteration-level scheduling** 是 vllm 的根：每个 step 都重 schedule 一次，不是优化、是设计前提
2. V1 scheduler **不区分** prefill / decode——只看 `num_computed_tokens` vs `num_tokens_with_spec`。这是它能优雅支持 chunked prefill / spec decode / 混合 batch 的根本原因
3. `SchedulerOutput` 里 `scheduled_new_reqs` 和 `scheduled_cached_reqs` 的分裂，是为了"worker 缓存每个 request 的元数据，重复 step 只发增量"——这是性能优化，不是逻辑必需
4. 单 request 看似浪费的"每 token 都 schedule"，是为了**新请求可以零延迟插入**——这才是 continuous batching 真正打中传统 batching 的点
