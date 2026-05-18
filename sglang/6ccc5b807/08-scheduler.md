# 第 08 章 调度器与连续批处理

## 本章导读

调度器(Scheduler)是 SGLang 的心脏。前面几章讲的子系统——前缀缓存、KV 内存、请求对象——都是它在驱动。SGLang 那句标志性的宣传「零开销 CPU 调度器」,讲的就是本章。

调度器要回答的核心问题:GPU 一次只能跑一批,**每一个时刻,应该让哪些请求、以什么方式上 GPU?** 答好这个问题,GPU 就满载、吞吐就高;答不好,GPU 就空转。

调度器跑在一个独立子进程里(见 [第 04 章](04-engine-and-processes.md)),主体代码在 `python/sglang/srt/managers/scheduler.py`(约 4094 行),调度策略在 `schedule_policy.py`。

## 1. 事件循环:调度器的骨架

调度器子进程的入口是 `run_scheduler_process`(`scheduler.py:4029`)。它建好 `Scheduler` 对象后,进入一个**永不退出的事件循环**。

最直白的版本是 `event_loop_normal`(`scheduler.py:1550`):

```python
# scheduler.py:1550 (节选)
def event_loop_normal(self):
    while True:
        recv_reqs = self.recv_requests()              # 1. 收
        self.process_input_requests(recv_reqs)
        batch = self.get_next_batch_to_run()          # 2. 组
        self.cur_batch = batch
        if batch:
            result = self.run_batch(batch)            # 3. 跑
            self.process_batch_result(batch, result)  # 4. 回
        else:
            self.on_idle()
        self.last_batch = batch
```

四拍:**收**(收新请求)、**组**(决定下一批)、**跑**(前向)、**回**(处理输出)。本章后面几节就是逐拍展开。

## 2. 第一拍「收」:`recv_requests`

`recv_requests`(`scheduler.py:1669`)从 ZMQ socket **非阻塞地**捞取这一拍内到达的所有消息——新生成请求、中止请求、权重更新指令等。捞到的交给 `process_input_requests`(`scheduler.py:1855`)分发处理。

对一个新的生成请求,处理动作是:把跨进程传来的 `TokenizedGenerateReqInput` 升级成调度器内部的 `Req` 对象(见 [第 05 章](05-request-data-structures.md)),放进 `waiting_queue`(等待队列)。

「非阻塞」是关键:调度器绝不会卡在「等请求」上。没有新请求就立刻进入下一拍——它还有正在 decode 的请求要照顾。详见 [导览步骤 08](tour-08-enqueue.md)。

## 3. 第二拍「组」:`get_next_batch_to_run`

这是调度的大脑——`get_next_batch_to_run`(`scheduler.py:2498`)。它要决定下一批的**性质**和**内容**。

### prefill 还是 decode

一个请求的生命有两个阶段:**prefill**(把整个 prompt 一次性算出 KV)和 **decode**(逐 token 自回归生成)。调度器每一拍只能选一种模式跑。

`get_next_batch_to_run` 的规则是 **prefill 优先**(`scheduler.py:2592-2604`):

```python
# scheduler.py:2592 (节选)
new_batch = self.get_new_batch_prefill()
if new_batch is not None:
    ret = new_batch                       # 有新请求 → 先 prefill
else:
    if not self.running_batch.is_empty():
        self.running_batch = self.update_running_batch(self.running_batch)
        ret = self.running_batch          # 否则 → decode 一步
    else:
        ret = None
```

为什么 prefill 优先?因为新请求不 prefill 就没法开始 decode,它们的「首 token 延迟(TTFT)」在等。先把新请求 prefill 进来,再让大家一起 decode。

### 连续批处理:批是流动的

注意 `scheduler.py:2535-2562` 那段——它把**上一拍的 prefill 批 merge 进 `running_batch`**。`running_batch` 是「当前正在 decode 的所有请求」组成的批。

这就是**连续批处理(continuous batching)**的实现:批不是固定的。

- 新请求 prefill 完,`merge_batch` 并进 `running_batch`,加入 decode 大军;
- 某个请求生成完了,`filter_batch` 把它剔出 `running_batch`;
- 剩下的请求继续 decode。

<svg viewBox="0 0 560 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="running_batch changing over time under continuous batching">
<text x="50" y="30" font-size="11" font-weight="600" fill="#94a3b8">running_batch 随时间变化</text>
<text x="40" y="62" font-size="11" fill="#64748b">t0</text>
<rect x="70" y="48" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="100" y="64" text-anchor="middle" font-size="10" fill="currentColor">req A</text>
<rect x="136" y="48" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="166" y="64" text-anchor="middle" font-size="10" fill="currentColor">req B</text>
<text x="240" y="64" font-size="10" fill="#94a3b8">A、B 在 decode</text>
<text x="40" y="102" font-size="11" fill="#64748b">t1</text>
<rect x="70" y="88" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="100" y="104" text-anchor="middle" font-size="10" fill="currentColor">req A</text>
<rect x="136" y="88" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="166" y="104" text-anchor="middle" font-size="10" fill="currentColor">req B</text>
<rect x="202" y="88" width="60" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="232" y="104" text-anchor="middle" font-size="10" fill="#16a34a">req C</text>
<text x="300" y="104" font-size="10" fill="#16a34a">C prefill 完 → merge 进来</text>
<text x="40" y="142" font-size="11" fill="#64748b">t2</text>
<rect x="70" y="128" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="100" y="144" text-anchor="middle" font-size="10" fill="currentColor">req A</text>
<rect x="136" y="128" width="60" height="24" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/><text x="166" y="144" text-anchor="middle" font-size="10" fill="#dc2626">req B</text>
<rect x="202" y="128" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="232" y="144" text-anchor="middle" font-size="10" fill="currentColor">req C</text>
<text x="300" y="144" font-size="10" fill="#dc2626">B 生成完 → filter 出去</text>
<text x="40" y="182" font-size="11" fill="#64748b">t3</text>
<rect x="70" y="168" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="100" y="184" text-anchor="middle" font-size="10" fill="currentColor">req A</text>
<rect x="136" y="168" width="60" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="166" y="184" text-anchor="middle" font-size="10" fill="currentColor">req C</text>
<rect x="202" y="168" width="60" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="232" y="184" text-anchor="middle" font-size="10" fill="#16a34a">req D</text>
<rect x="268" y="168" width="60" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="298" y="184" text-anchor="middle" font-size="10" fill="#16a34a">req E</text>
<text x="360" y="184" font-size="10" fill="#94a3b8">D、E 补位</text>
<text x="280" y="218" text-anchor="middle" font-size="10" fill="#94a3b8">批是流动的：请求随时 merge 进、filter 出</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ 连续批处理：running_batch 不固定——请求 prefill 完就 merge 进来，生成完就 filter 出去</span>

<details>
<summary>ASCII 原版</summary>

```text
   running_batch 随时间变化:

   t0:  [req A, req B]            ← A、B 在 decode
   t1:  [req A, req B, req C]     ← C prefill 完,merge 进来
   t2:  [req A, req C]            ← B 生成完,filter 出去
   t3:  [req A, req C, req D, req E]
```

</details>

对比「静态批处理」(一批请求必须全部跑完才能换下一批),连续批处理让先结束的请求立刻让出资源、新请求立刻补位,GPU 利用率高得多。`ScheduleBatch` 的 `merge_batch` / `filter_batch` 方法(见 [第 05 章](05-request-data-structures.md))就是为此而生。

## 4. 挑请求:调度策略

`get_new_batch_prefill`(`scheduler.py:2624`)组 prefill 批时,要从 `waiting_queue` 里挑请求。挑的顺序由 `SchedulePolicy`(`schedule_policy.py:140`)的 `calc_priority` 决定。

策略分两类(`schedule_policy.py:124`、`:131`):

**缓存感知(CacheAwarePolicy)** —— 知道前缀缓存的存在:
- `LPM`(longest prefix match):最长前缀匹配优先。能命中长前缀的请求排前面;
- `DFS_WEIGHT`:基于 radix tree 的深度优先权重。

**缓存无关(CacheAgnosticPolicy)**:
- `FCFS`:先到先服务;
- `LOF`(longest output first):预计输出最长的优先;
- `RANDOM`、`ROUTING_KEY` 等。

默认走缓存感知策略。它的精妙之处:让**能共享前缀的请求扎堆进同一批**。同一批里若 5 个请求共享一段系统提示,这段提示的 KV 只算一次、5 个请求共用。把这个收益做到最大,正是 RadixAttention 性能优势的来源(见 [第 06 章](06-radix-cache.md))。`SchedulePolicy` 甚至维护一棵 `waiting_queue_radix_tree`(`schedule_policy.py` 构造函数末尾)来模拟「队列内请求互相之间的前缀共享」。

挑出请求后,`PrefillAdder`(`schedule_policy.py:407`)负责往批里加,受 KV 池余量和 token 总数上限两个预算约束。详见 [导览步骤 12](tour-12-build-batch.md)。

## 5. chunked prefill:超长 prompt 不堵门

一个 32000 token 的 prompt,一批装不下怎么办?如果死守「整段一起算」,它要么堵住后面所有请求,要么永远轮不到。

SGLang 的解法是 **chunked prefill**:把超长 prompt **切块**,这一批只 prefill 它的前一截,剩下的下一批继续。被切的请求记为 `chunked_req`——`get_next_batch_to_run` 里有大量代码在处理它(如 `scheduler.py:2514-2520` 把 `chunked_req` 移出批,避免半截请求被错误地 merge 进 `running_batch`)。

chunked prefill 还有个好处:它让 prefill 和 decode 能更平滑地交错,避免一个大 prefill 把所有 decode 请求卡住太久(decode 请求卡住会拉高 inter-token 延迟)。

## 6. 第三拍「跑」:`run_batch`

`run_batch`(`scheduler.py:3051`)把组好的 `ScheduleBatch` 交给 `ModelRunner` 跑前向。它内部会:

- 递增 `forward_ct`(前向计数器);
- 处理 profiler、PD 分离等特殊路径;
- 调 `ModelRunner` 把 `ScheduleBatch` 转成 `ForwardBatch`、执行前向、采样(见 [第 09 章](09-model-runner.md)、[导览步骤 13-16](tour-00-overview.md));
- 返回一个 `GenerationBatchResult`(生成任务)或 `EmbeddingBatchResult`。

## 7. 第四拍「回」:`process_batch_result`

`process_batch_result`(`scheduler.py:3210`)处理前向的产出:

- 把每个请求新生成的 token append 进 `Req.output_ids`;
- 检查每个请求是否结束(命中 `max_new_tokens` / EOS / stop 字符串),设 `finished_reason`;
- 把新 token 打包成 `BatchTokenIDOutput`,经 ZMQ 发给 `DetokenizerManager`;
- 结束的请求触发 KV 释放、从 `running_batch` 剔除(见 [导览步骤 18](tour-18-finish-return.md))。

## 8. 「零开销」的真相:overlap 事件循环

到这里,四拍走完了。但若严格串行——收、组、跑(等 GPU)、回、再收……——会有个浪费:第三拍「跑」要等 GPU 算完,这期间 CPU(收、组)闲着;CPU 组批时,GPU 又闲着。

这就是「CPU 调度开销」。消除它的是另一个事件循环——`event_loop_overlap`(`scheduler.py:1577`)。

它的改动:`run_batch` 把这批**发射**给 GPU 后**不等结果**,立刻把 `(batch, result)` 塞进 `result_queue`,然后马上转下一拍——去给**下一批**收请求、组批:

<svg viewBox="0 0 640 230" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Serial event loop versus overlapped event loop">
<text x="40" y="40" font-size="12" font-weight="600" fill="#dc2626">event_loop_normal（串行）</text>
<rect x="40" y="50" width="90" height="26" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="85" y="67" text-anchor="middle" font-size="10" fill="currentColor">组批 N</text>
<rect x="132" y="50" width="150" height="26" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/><text x="207" y="67" text-anchor="middle" font-size="10" fill="#dc2626">前向 N（CPU 空等）</text>
<rect x="284" y="50" width="90" height="26" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="329" y="67" text-anchor="middle" font-size="10" fill="currentColor">组批 N+1</text>
<rect x="376" y="50" width="150" height="26" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/><text x="451" y="67" text-anchor="middle" font-size="10" fill="#dc2626">前向 N+1</text>
<text x="600" y="92" text-anchor="end" font-size="10" fill="#dc2626">墙上时间 = CPU + GPU</text>
<line x1="30" y1="110" x2="610" y2="110" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="40" y="140" font-size="12" font-weight="600" fill="#16a34a">event_loop_overlap（重叠）</text>
<text x="34" y="160" font-size="9" fill="#64748b">CPU</text>
<rect x="64" y="148" width="86" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="107" y="164" text-anchor="middle" font-size="10" fill="currentColor">组批 N</text>
<rect x="152" y="148" width="86" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="195" y="164" text-anchor="middle" font-size="10" fill="currentColor">组批 N+1</text>
<rect x="240" y="148" width="86" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/><text x="283" y="164" text-anchor="middle" font-size="10" fill="currentColor">组批 N+2</text>
<text x="34" y="196" font-size="9" fill="#64748b">GPU</text>
<rect x="152" y="184" width="130" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="217" y="200" text-anchor="middle" font-size="10" fill="#16a34a">前向 N</text>
<rect x="284" y="184" width="130" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/><text x="349" y="200" text-anchor="middle" font-size="10" fill="#16a34a">前向 N+1</text>
<text x="600" y="200" text-anchor="end" font-size="10" fill="#16a34a">墙上时间 = max(CPU, GPU)</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ 串行循环让 CPU/GPU 互相空等；overlap 循环把组批藏进前向时间里——「零开销 CPU 调度器」</span>

<details>
<summary>ASCII 原版</summary>

```text
  串行 (event_loop_normal):
    [组批N][===前向N等GPU===][组批N+1][===前向N+1===]
            CPU 空闲          GPU 空闲

  重叠 (event_loop_overlap):
    [组批N][组批N+1  ][组批N+2  ]      ← CPU 不停
           [==前向N==][==前向N+1==]    ← GPU 不停
```

</details>

CPU 给「下一批」组批的时间,被藏进 GPU 算「这一批」的时间里。墙上时间从「CPU + GPU」变成「max(CPU, GPU)」。只要 CPU 组批比 GPU 前向快(通常如此),CPU 调度开销就被完全吸收——**这才是「零开销 CPU 调度器」的真正含义**:不是 CPU 不干活,是 CPU 的活和 GPU 的活完全重叠了。`pop_and_process`(`scheduler.py:1583`)负责在恰当时机回头处理上一批的结果。生产环境默认跑 overlap 版本。详见 [导览步骤 09](tour-09-scheduler-loop.md)。

## 9. 与高级特性的集成点

调度器是中枢,很多高级特性在这里挂钩:

- **投机解码**([第 12 章](12-speculative-decoding.md)):decode 一步会变成「draft 多个 token + verify」,`get_next_batch_to_run` 和 `run_batch` 有专门分支(`spec_algorithm` 相关判断);
- **PD 分离**([第 13 章](13-distributed.md)):prefill 和 decode 拆到不同 worker,调度器有 disaggregation 模式;
- **DP attention**:`maybe_prepare_mlp_sync_batch`(`scheduler.py:2589`、`:2607`)处理数据并行下的 batch 同步。

本章只点到为止,细节见对应章节。

## 相关章节

- [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md) —— 调度器作为子进程的启动
- [第 05 章 请求对象与核心数据结构](05-request-data-structures.md) —— `Req` / `ScheduleBatch` 的字段
- [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) —— 缓存感知调度的基础
- [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) —— 调度的 KV 余量预算
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— `run_batch` 之后的世界
- [导览步骤 09-12、17](tour-00-overview.md) —— 调度全过程的实际 trace
