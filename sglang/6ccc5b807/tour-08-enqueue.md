# Trace 步骤 08 —— 一个请求怎么从主进程「飞」到调度进程？

## 1. 当前情境

上一步分词结束，主进程的 `TokenizerManager` 手里有一个 `TokenizedGenerateReqInput`：里面是 `input_ids`（约 6 个整数）、实例化好的 `SamplingParams`、原始文本。但调度器在**另一个进程**里。这个对象现在还卡在主进程，得想办法送过去。

## 2. 问题

`TokenizedGenerateReqInput` 是主进程地址空间里的一个 Python 对象。Scheduler 子进程**看不到**它——两个进程内存隔离。问题是：

- 怎么把这个对象**跨进程**送到 Scheduler；
- Scheduler 收到之后，这个「外部请求」要变成调度器内部能直接调度的形态；
- 整个过程不能阻塞——主进程还要继续接别的请求，Scheduler 还在跑着上一批的前向。

## 3. 朴素思路

进程间通信，最朴素的想法是搞个共享文件，或者用 `multiprocessing.Queue`：主进程 `put`，子进程 `get`。Python 标准库现成的。

## 4. 为什么朴素思路会崩

`multiprocessing.Queue` 能用，但用在推理引擎的热路径上有真问题：

- 它的实现里有锁和后台 feeder 线程，跨进程同步的开销和延迟抖动不可控；推理引擎要求请求入队是**确定性低延迟**的。
- 它和 Scheduler 的事件循环模型不匹配——Scheduler 的循环要「非阻塞地看一眼有没有新请求」，看完立刻去干别的（组批、跑前向）。`Queue.get` 要么阻塞、要么轮询，都别扭。
- 它没法自然地扩展到「多个 detokenizer worker」「多节点」这类拓扑。

更关键的是：就算把对象送过去了，`TokenizedGenerateReqInput` 也**不是调度器能直接用的形态**。它是「输入 DTO」，没有调度器需要的运行时字段——KV 索引指针、已生成 token 数、前缀命中信息、finish reason……这些都还不存在。

## 5. SGLang 的做法

**传输用 ZMQ。** 上一步（[步骤 02](tour-02-launch-processes.md)）三个进程之间就是靠 ZMQ socket 连起来的，端口由 `PortArgs` 分配。`TokenizerManager` 把 `TokenizedGenerateReqInput` 序列化，从它那一端的 socket 发出去；消息穿过 IPC 管道，到达 Scheduler 进程的 socket。ZMQ 的 PUSH/PULL 模式天然契合「生产者非阻塞投递、消费者按需收取」。

**接收 + 转形态在 Scheduler 这边。** Scheduler 的事件循环每一拍都先调 `recv_requests`（`python/sglang/srt/managers/scheduler.py:1669`）——从 socket 把这一拍内到达的所有消息**非阻塞**地捞出来。捞到的原始消息交给 `process_input_requests` 处理。

处理的核心动作是：把「输入 DTO」`TokenizedGenerateReqInput` 升级成调度器的内部请求对象 **`Req`**（`python/sglang/srt/managers/schedule_batch.py` 约 :571）。`Req` 才是调度器全程操作的对象，它带着所有运行时字段：

<svg viewBox="0 0 680 248" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TokenizedGenerateReqInput upgraded to internal Req object">
<defs>
<marker id="t8ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
</defs>
<text x="140" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">跨进程到达的「输入 DTO」</text>
<rect x="30" y="32" width="220" height="150" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
<text x="140" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">TokenizedGenerateReqInput</text>
<line x1="46" y1="66" x2="234" y2="66" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="50" y="90" font-size="11" fill="#64748b">input_ids</text>
<text x="50" y="114" font-size="11" fill="#64748b">sampling_params</text>
<text x="50" y="138" font-size="11" fill="#64748b">rid</text>
<text x="50" y="162" font-size="11" fill="#64748b">input_text</text>
<line x1="252" y1="107" x2="408" y2="107" stroke="#ea580c" stroke-width="1.5" marker-end="url(#t8ar)"/>
<text x="330" y="98" text-anchor="middle" font-size="10" fill="#ea580c">升级 / 补运行时字段</text>
<text x="550" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">调度器全程持有的状态机</text>
<rect x="412" y="32" width="256" height="186" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="540" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Req（调度器内部）</text>
<line x1="428" y1="66" x2="652" y2="66" stroke="#fb923c" stroke-dasharray="4,3"/>
<text x="432" y="88" font-size="11" fill="#64748b">origin_input_ids　　输入 token</text>
<text x="432" y="110" font-size="11" fill="#64748b">output_ids　　　　　已生成 token</text>
<text x="432" y="132" font-size="11" fill="#64748b">sampling_params</text>
<text x="432" y="154" font-size="11" fill="#64748b">prefix_indices　　　前缀命中</text>
<text x="432" y="176" font-size="11" fill="#64748b">req_to_token 指针　 KV 索引</text>
<text x="432" y="198" font-size="11" fill="#64748b">finished_reason　　 结束原因</text>
<text x="540" y="238" text-anchor="middle" font-size="10" fill="#94a3b8">新建时运行时字段大多为空 → 进入 waiting_queue</text>
</svg>
<span class="figure-caption">图 T8.1 ｜ 请求过进程边界后，从「输入 DTO」升级为带运行时字段的内部对象 Req</span>

<details>
<summary>ASCII 原版</summary>

```text
TokenizedGenerateReqInput          Req  (调度器内部)
┌──────────────────────┐          ┌────────────────────────────┐
│ input_ids            │  ──────► │ origin_input_ids  (输入)    │
│ sampling_params      │          │ output_ids        (已生成)  │
│ rid                  │          │ sampling_params             │
│ input_text           │          │ prefix_indices    (前缀命中)│
└──────────────────────┘          │ req_to_token 指针 (KV 索引) │
                                   │ finished_reason   (结束原因)│
                                   │ ...                         │
                                   └────────────────────────────┘
```

</details>

新建的 `Req` 此刻字段大多是空的——`output_ids` 是空列表，`prefix_indices` 还没匹配，KV 索引还没分配。它被放进 Scheduler 的 **`waiting_queue`**（等待队列）。

到这里，请求成功「落地」到了调度进程：它以 `Req` 的形态躺在 `waiting_queue` 里，排队等待被调度。`recv_requests` 是非阻塞的，所以 Scheduler 收完请求立刻就去干循环里的下一件事，不会卡。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/managers/tokenizer_manager.py` —— 发送端，搜 `send_to_scheduler` 之类的 socket 发送。
- `python/sglang/srt/managers/scheduler.py:1669` —— `recv_requests`，从 ZMQ 非阻塞收消息。
- `scheduler.py:1555` —— `process_input_requests`，把消息分发处理。
- `python/sglang/srt/managers/schedule_batch.py:571` 附近 —— `Req` 类定义，看它有哪些运行时字段。
- `scheduler.py:1554`（在 `event_loop_normal` 里）—— `recv_requests` 作为循环第一拍被调用的位置。

## 7. 分支与延伸

- ZMQ 的 socket 类型、`PortArgs` 端口分配、跨进程序列化细节 → [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md)
- `Req` 对象的完整字段与生命周期 → [第 05 章 请求对象与核心数据结构](05-request-data-structures.md)
- `waiting_queue` 里的请求接下来怎么被挑出来组批 → [步骤 09](tour-09-scheduler-loop.md)、[步骤 12](tour-12-build-batch.md)
- 调度器事件循环的整体结构 → [第 08 章 调度器与连续批处理](08-scheduler.md)

## 8. 走完这一步你脑子里应该多了什么

1. 跨进程传请求用的是 **ZMQ**，不是 `multiprocessing.Queue`——因为热路径要的是确定性低延迟和与事件循环匹配的非阻塞收取。
2. `recv_requests` 是**非阻塞**的：Scheduler 每拍捞一次新消息，捞完立刻去干别的，绝不卡在收请求上。
3. 跨进程到达的 `TokenizedGenerateReqInput` 会被升级成调度器内部对象 **`Req`**——`Req` 才带运行时字段（output_ids / KV 索引 / finish reason），是调度器全程操作的形态。
4. 新 `Req` 进入 `waiting_queue`，此刻它的运行时字段基本是空的；它在排队，等待被调度。
