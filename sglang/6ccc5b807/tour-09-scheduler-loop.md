# Trace 步骤 09 —— 调度器主循环，每一拍到底在干什么？

## 1. 当前情境

我们的请求以 `Req` 的形态躺在 Scheduler 的 `waiting_queue` 里。Scheduler 子进程从启动起就在跑一个**永不退出的循环**——`event_loop_normal`（`python/sglang/srt/managers/scheduler.py:1550`）或 `event_loop_overlap`（`:1577`）。这一步我们看清这个循环的骨架；接下来的步骤 10-12 是这一拍里「组批」环节的展开。

## 2. 问题

调度器要同时照顾两件事：

- **GPU 不能闲**：上一批前向算完的那一刻，下一批必须已经准备好喂上去；
- **新请求要及时进来**：用户随时在发请求，不能让它们干等。

问题是：组批（挑请求、匹配前缀、分配 KV）是 **CPU** 活儿，前向是 **GPU** 活儿。如果循环是「收请求 → 组批 → 跑前向 → 处理结果 → 收请求 …」严格串行，那么 CPU 组批的时候 GPU 在闲、GPU 前向的时候 CPU 在闲。怎么让两者重叠？

## 3. 朴素思路

写一个直白的串行循环：

```text
while True:
    收新请求
    组下一批
    跑前向 (等 GPU 算完)
    处理结果、发出去
```

每一行干完再干下一行，逻辑清晰，最容易写对。

## 4. 为什么朴素思路会崩

串行循环的问题在「跑前向」这一行——它会**阻塞等 GPU**。在 GPU 算这一批的几毫秒里，CPU 完全空着：

- CPU 本可以利用这段时间去给**下一批**收请求、匹配前缀、分配 KV。但串行循环不允许——它非要等当前批的前向回来才往下走。
- 结果：每一拍的墙上时间 = CPU 组批时间 + GPU 前向时间，两段**首尾相接**。如果组批要 0.5 ms、前向要 5 ms，那么稳态下 GPU 有 0.5/5.5 ≈ 9% 的时间在等 CPU。
- 这就是「CPU 调度开销」的来源。SGLang 标榜「零开销 CPU 调度器」——目标正是把这 9% 抹平。串行循环做不到。

## 5. SGLang 的做法

循环骨架其实很简单，`event_loop_normal`（`scheduler.py:1550`）四拍：

```text
while True:
    recv_reqs = recv_requests()          # 1. 收：从 ZMQ 捞新请求
    process_input_requests(recv_reqs)    #    新 Req 进 waiting_queue
    batch = get_next_batch_to_run()      # 2. 组：挑出下一批 (步骤 10-12)
    if batch:
        result = run_batch(batch)        # 3. 跑：调 ModelRunner 前向
        process_batch_result(...)        # 4. 回：处理输出、发给 detokenizer
```

`get_next_batch_to_run`（`scheduler.py:2498`）是「组」这一拍的总入口——它决定下一批是跑 **prefill**（处理 waiting_queue 里的新请求，调 `get_new_batch_prefill`，`:2624`）还是跑 **decode**（让正在生成的请求各走一步，`update_running_batch`，`:2906`）。规则是 **prefill 优先**：有新请求待处理就先 prefill，否则 decode（`scheduler.py:2592-2604`）。

真正消除 CPU 开销的是另一个循环——`event_loop_overlap`（`scheduler.py:1577`）。它的关键改动：`run_batch` 把这一批**发射**给 GPU 后**不等结果**，立刻把 `(batch, batch_result)` 塞进 `result_queue`，然后循环马上转下一拍——去给**下一批**收请求、组批：

<svg viewBox="0 0 700 250" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="event_loop_overlap overlaps CPU scheduling with GPU forward">
<defs>
<marker id="t9ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="60" y="48" font-size="12" font-weight="600" fill="#dc2626">串行</text>
<rect x="100" y="34" width="110" height="26" rx="3" fill="#fed7aa" stroke="#ea580c"/>
<text x="155" y="51" text-anchor="middle" font-size="10" fill="currentColor">组批 N</text>
<rect x="210" y="34" width="160" height="26" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/>
<text x="290" y="51" text-anchor="middle" font-size="10" fill="#dc2626">前向 N（CPU 空等）</text>
<rect x="370" y="34" width="110" height="26" rx="3" fill="#fed7aa" stroke="#ea580c"/>
<text x="425" y="51" text-anchor="middle" font-size="10" fill="currentColor">组批 N+1</text>
<rect x="480" y="34" width="160" height="26" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-dasharray="3,2"/>
<text x="560" y="51" text-anchor="middle" font-size="10" fill="#dc2626">前向 N+1</text>
<text x="650" y="80" text-anchor="end" font-size="10" fill="#dc2626">墙上时间 = CPU + GPU</text>
<line x1="40" y1="110" x2="660" y2="110" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="60" y="150" font-size="12" font-weight="600" fill="#16a34a">重叠</text>
<text x="44" y="138" font-size="9" fill="#64748b">CPU</text>
<rect x="100" y="126" width="100" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
<text x="150" y="142" text-anchor="middle" font-size="10" fill="currentColor">组批 N</text>
<rect x="205" y="126" width="100" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
<text x="255" y="142" text-anchor="middle" font-size="10" fill="currentColor">组批 N+1</text>
<rect x="310" y="126" width="100" height="24" rx="3" fill="#fed7aa" stroke="#ea580c"/>
<text x="360" y="142" text-anchor="middle" font-size="10" fill="currentColor">组批 N+2</text>
<text x="44" y="180" font-size="9" fill="#64748b">GPU</text>
<rect x="205" y="168" width="150" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
<text x="280" y="184" text-anchor="middle" font-size="10" fill="#16a34a">前向 N</text>
<rect x="360" y="168" width="150" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a"/>
<text x="435" y="184" text-anchor="middle" font-size="10" fill="#16a34a">前向 N+1</text>
<line x1="255" y1="150" x2="255" y2="166" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar)"/>
<text x="360" y="218" text-anchor="middle" font-size="10" fill="#16a34a">组批 N+1 藏进 GPU 算前向 N 的时间里</text>
<text x="650" y="218" text-anchor="end" font-size="10" fill="#16a34a">墙上时间 = max(CPU, GPU)</text>
</svg>
<span class="figure-caption">图 T9.1 ｜ event_loop_overlap 把 CPU 组批藏进 GPU 前向的时间里——这才是「零开销 CPU 调度器」</span>

<details>
<summary>ASCII 原版</summary>

```text
event_loop_overlap 的重叠:

  拍 N:   组批 N ──► 发射前向 N ──┐ (不等)
                                   │
  拍 N+1: 处理结果 N-1            │  GPU 在后台算 N
          组批 N+1 ──► 发射前向 N+1
              ▲
              └── 这段 CPU 组批，和 GPU 算前向 N 同时进行
```

</details>

CPU 给「下一批」组批的时间，被藏进了 GPU 算「这一批」的时间里。两段时间**重叠**，墙上时间从「CPU + GPU」变成「max(CPU, GPU)」。只要 CPU 组批比 GPU 前向快（通常如此），CPU 开销就被完全吸收——这就是「零开销 CPU 调度器」。`pop_and_process`（`scheduler.py:1583`）负责在合适的时机回头处理上一批的结果。

本 trace 是单请求、为说清楚按 `event_loop_normal` 的四拍来走，但要记住生产环境跑的是 overlap 版本。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/managers/scheduler.py:1550` —— `event_loop_normal`，看清「收-组-跑-回」四拍。
- `scheduler.py:1577` —— `event_loop_overlap`，重叠版本，注意 `run_batch` 之后不等、直接进 `result_queue`。
- `scheduler.py:2498` —— `get_next_batch_to_run`，组批总入口。
- `scheduler.py:2592-2604` —— prefill 优先于 decode 的判定。
- `scheduler.py:2624` —— `get_new_batch_prefill`；`:2906` —— `update_running_batch`（decode 路径）。
- `scheduler.py:3051` —— `run_batch`，把批发给 ModelRunner。

## 7. 分支与延伸

- 调度器的完整结构、prefill/decode 调度策略 → [第 08 章 调度器与连续批处理](08-scheduler.md)
- 「组」这一拍的展开：前缀匹配 → KV 分配 → 组 prefill 批 → [步骤 10](tour-10-match-prefix.md)、[步骤 11](tour-11-alloc-kv.md)、[步骤 12](tour-12-build-batch.md)
- 「跑」这一拍：批怎么变成 GPU 张量并前向 → [步骤 13](tour-13-forward-batch.md)、[步骤 14](tour-14-model-forward.md)
- decode 路径（`update_running_batch`）的细节 → [步骤 17](tour-17-decode-loop.md)

## 8. 走完这一步你脑子里应该多了什么

1. 调度器是一个**永不退出的事件循环**，每拍四件事：收请求、组批、跑前向、处理结果。
2. `get_next_batch_to_run` 决定下一批是 **prefill 还是 decode**，规则是 **prefill 优先**——有新请求就先把它们 prefill 进来。
3. 串行循环会让 CPU 在 GPU 前向时空等；`event_loop_overlap` 把前向**发射后不等**，用「算这一批」的时间给「下一批」组批——CPU 开销被藏进 GPU 时间里。
4. 「零开销 CPU 调度器」不是说 CPU 不干活，而是 CPU 干的活和 GPU **重叠**了，不再额外占用墙上时间。
