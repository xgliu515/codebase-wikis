# Trace 步骤 12 —— 这一批 prefill，到底放进去哪些请求？

## 1. 当前情境

我们这个 `Req` 的 6 个 token 已经分到了 KV 槽位。现在 `get_next_batch_to_run` 判定这一拍跑 prefill，调用 `get_new_batch_prefill`（`python/sglang/srt/managers/scheduler.py:2624`）。本 trace 只有一个请求，但生产环境里 `waiting_queue` 可能排着几十上百个请求——这一步要决定：这一批 prefill 装哪些、装多少。

## 2. 问题

GPU 一次前向能处理一批请求。组这一批要回答三个问题：

- **挑谁**：`waiting_queue` 里若有多个请求，先 prefill 哪些？
- **装多少**：一批不能无限大——所有请求的 token 总数受 KV 池余量、前向激活值显存的限制；
- **半个怎么办**：来了个 8000 token 的超长 prompt，一批装不下，难道让它一直插队不到、把别人都饿死？

## 3. 朴素思路

先到先服务（FIFO）：`waiting_queue` 是个队列，从队头开始往批里塞，塞到塞不下为止。公平、简单、符合直觉。

## 4. 为什么朴素思路会崩

纯 FIFO 有两个明显的浪费点：

- **错过前缀复用**：假设队列里有请求 A、B、C，B 和 C 共享一大段前缀，A 谁也不沾。FIFO 按 A→B→C 顺序塞。但如果先把 B、C 放一批,它俩的公共前缀只算一次;A 单独一批。FIFO 完全无视「哪些请求能共享前缀」这个信息——而前缀复用是 SGLang 最大的性能来源（见 [步骤 10](tour-10-match-prefix.md)）。
- **超长 prompt 堵门**：队头来个 32000 token 的 prompt，一批装不下。FIFO 死守队头顺序，要么让它一直占着队头、后面全堵住；要么跳过它、它永远轮不到——**饿死**。
- 还有：FIFO 不区分请求优先级,也无法在「批已经半满」时聪明地决定还能不能再塞一个。

## 5. SGLang 的做法

SGLang 把「挑谁」和「装多少」拆成两个组件。

**挑谁——`SchedulePolicy`**（`python/sglang/srt/managers/schedule_policy.py:140`）。它的 `calc_priority`（`:161`）给 `waiting_queue` 里的请求**排序**。策略分两类（`schedule_policy.py:124`、`:131`）：

- **cache-aware（缓存感知）**：按「和前缀缓存的匹配程度」排序——能命中长前缀的请求优先,让它们扎堆进同一批,公共前缀只算一次。这是默认、也是 SGLang 的精髓。
- **cache-agnostic（缓存无关）**：FCFS、LPM(最长前缀优先)等不依赖缓存状态的策略。

**装多少——`PrefillAdder`**（`schedule_policy.py:407`）。它拿着排好序的请求列表，一个个尝试往批里加：`add_one_req`（`:815`）每次返回一个 `AddReqResult`（`:401`），告诉调度器「加成功了 / 批满了 / 装不下了」。`PrefillAdder` 盯着两个预算——KV 池余量、批的 token 总数上限——加到任一预算耗尽就停。

<svg viewBox="0 0 700 230" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Building a prefill batch: schedule policy ranks, PrefillAdder fills">
<defs>
<marker id="t12ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="80" y="24" text-anchor="middle" font-size="11" font-weight="600" fill="#94a3b8">waiting_queue</text>
<rect x="30" y="34" width="100" height="120" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
<rect x="44" y="48" width="72" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="80" y="65" text-anchor="middle" font-size="10" fill="currentColor">req A</text>
<rect x="44" y="80" width="72" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="80" y="97" text-anchor="middle" font-size="10" fill="currentColor">req B</text>
<rect x="44" y="112" width="72" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="80" y="129" text-anchor="middle" font-size="10" fill="currentColor">req C</text>
<line x1="130" y1="94" x2="178" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
<rect x="180" y="40" width="190" height="108" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="275" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">SchedulePolicy</text>
<text x="275" y="80" text-anchor="middle" font-size="10" fill="#64748b">calc_priority 排序</text>
<text x="275" y="100" text-anchor="middle" font-size="10" fill="#64748b">cache-aware：命中长前缀的优先</text>
<rect x="200" y="110" width="150" height="26" rx="3" fill="#fff" stroke="#ea580c"/>
<text x="275" y="127" text-anchor="middle" font-size="10" fill="currentColor">[ B, C, A, … ]</text>
<line x1="370" y1="94" x2="418" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
<rect x="420" y="40" width="200" height="108" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="520" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">PrefillAdder</text>
<text x="438" y="84" font-size="10" fill="#16a34a">+ B　OK</text>
<text x="438" y="104" font-size="10" fill="#16a34a">+ C　OK</text>
<text x="438" y="124" font-size="10" fill="#dc2626">+ A　批满（KV / token 预算耗尽）</text>
<text x="520" y="142" text-anchor="middle" font-size="9" fill="#94a3b8">受 KV 余量 + token 上限双预算约束</text>
<line x1="520" y1="148" x2="520" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar)"/>
<rect x="420" y="178" width="200" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="520" y="200" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">prefill ScheduleBatch</text>
</svg>
<span class="figure-caption">图 T12.1 ｜ 组 prefill 批两步走：SchedulePolicy 排序「挑谁」，PrefillAdder 受双预算约束「装多少」</span>

<details>
<summary>ASCII 原版</summary>

```text
 waiting_queue        SchedulePolicy.calc_priority        PrefillAdder
 ┌─────────┐          排序 (cache-aware:                  逐个 add_one_req
 │ req A   │   ───►   命中长前缀的优先)         ───►      ┌──────────────┐
 │ req B   │          [B, C, A, ...]                      │ + B  OK      │
 │ req C   │                                              │ + C  OK      │
 └─────────┘                                              │ + A  批满    │
                                                          └──────────────┘
                                                          → ScheduleBatch
```

</details>

**超长 prompt 不饿死——chunked prefill。** 一个 prompt 太长、一批装不下时，SGLang 把它**切块**：这一批只 prefill 它的前一截，剩下的下一批继续。被切的请求记为 `chunked_req`（`get_next_batch_to_run` 里到处在处理它，如 `scheduler.py:2514-2520`）。这样超长 prompt 既不堵门、也终会被处理完。

最终产物是一个 **`ScheduleBatch`**（`python/sglang/srt/managers/schedule_batch.py`），`forward_mode` 为 `EXTEND`（prefill 的内部叫法）。本 trace 里它只含我们这一个请求。`get_new_batch_prefill` 内部会调 `prepare_for_extend`（`schedule_batch.py:1688`，即上一步触发 KV 分配的地方）把批的 CPU 端数据准备好。

到这里，一个 prefill `ScheduleBatch` 组好了。它是 **CPU 端**的数据——还不是 GPU 能直接吃的张量。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/managers/scheduler.py:2624` —— `get_new_batch_prefill`，组 prefill 批的入口。
- `python/sglang/srt/managers/schedule_policy.py:140` —— `SchedulePolicy`；`:161` 的 `calc_priority` 排序。
- `schedule_policy.py:124`、`:131` —— `CacheAwarePolicy` / `CacheAgnosticPolicy` 两类策略枚举。
- `schedule_policy.py:407` —— `PrefillAdder`；`:815` 的 `add_one_req`；`:401` 的 `AddReqResult`。
- `python/sglang/srt/managers/schedule_batch.py:1688` —— `prepare_for_extend`，准备批的 CPU 数据。
- `scheduler.py:2514-2520` —— `chunked_req` 的处理。

## 7. 分支与延伸

- 调度策略全貌、prefill/decode 调度、chunked prefill 细节 → [第 08 章 调度器与连续批处理](08-scheduler.md)
- cache-aware 策略为什么能提升前缀命中 → [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md)
- `ScheduleBatch` 的字段、与 `ForwardBatch` 的关系 → [第 05 章 请求对象与核心数据结构](05-request-data-structures.md)
- 组好的批怎么转成 GPU 张量 → [步骤 13](tour-13-forward-batch.md)

## 8. 走完这一步你脑子里应该多了什么

1. 组 prefill 批分两步：`SchedulePolicy` **挑谁**（排序），`PrefillAdder` **装多少**（受 KV 余量和 token 上限双预算约束）。
2. 默认是 **cache-aware** 策略——按前缀命中程度排序，让能共享前缀的请求扎堆进同一批,把前缀复用收益做到最大。
3. 超长 prompt 用 **chunked prefill** 切块,分多批处理,既不堵门也不饿死。
4. 产物是一个 `forward_mode=EXTEND` 的 `ScheduleBatch`,但它还是 **CPU 端数据**,下一步才转成 GPU 张量。
