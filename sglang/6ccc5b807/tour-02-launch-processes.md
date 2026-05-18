# Trace 步骤 02 —— 为什么不能把所有事情塞进一个进程？

## 1. 当前情境

上一步结束时，`server_args` 已经冻结成一份可 pickle 的「单一真相」。`Engine.__init__` 紧接着调用 `_launch_subprocesses`（`python/sglang/srt/entrypoints/engine.py:735`）。此刻我们手里只有配置，没有任何运行着的组件——没有分词器、没有调度器、没有模型。这一步要把骨架立起来。

## 2. 问题

一次推理涉及三类活儿，性质完全不同：

- **分词 / detokenize**：纯 CPU，调 HuggingFace tokenizer，吞字符串；
- **调度**：纯 CPU，维护队列、组批、管 KV 索引，但要求**极低延迟**——它得在 GPU 算完上一批的瞬间就把下一批喂上去；
- **模型前向**：GPU 重活，吃满显存和算力。

问题是：这三类活儿要怎么摆放，才能让 GPU 一刻不闲、而 CPU 上的分词又不拖累调度？

## 3. 朴素思路

最自然的写法：一个进程，三个线程。主线程跑调度，一个线程跑分词，一个线程发结果。Python 有 `threading`，共享内存、传对象都不要钱，看起来很美。

## 4. 为什么朴素思路会崩

崩在一个字上——**GIL**（全局解释器锁）。Python 的多线程在任意时刻只有一个线程能执行字节码：

- 分词线程正在 `tokenizer.encode()` 跑一段长 prompt，它**握着 GIL**。这段时间调度线程**完全停摆**——哪怕 GPU 已经算完、嗷嗷待哺，调度器也没法把下一批推上去。GPU 出现**气泡**（idle bubble），吞吐直接掉。
- detokenize 同理：每生成一个 token 就要把 id 转字符串，这活儿如果和调度抢 GIL，decode 的每一步都被拖慢。
- 更糟的是失败传染：分词线程抛个未捕获异常，整个进程一起死，调度状态全丢。

线程解决不了 GIL。要让分词、调度、detokenize **真正并行**，必须让它们各自待在**独立的进程**里——独立进程有独立的 GIL，互不阻塞。

## 5. SGLang 的做法

`_launch_subprocesses` 把系统拆成**三个进程**：

<svg viewBox="0 0 620 312" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-process topology connected by ZMQ IPC">
<defs>
<marker id="t2ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="310" y="20" text-anchor="middle" font-size="11" fill="#94a3b8">主进程（你的 Python 脚本）</text>
<rect x="160" y="30" width="300" height="60" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="310" y="55" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Engine + TokenizerManager</text>
<text x="310" y="76" text-anchor="middle" font-size="11" fill="#64748b">分词、收发请求</text>
<line x1="310" y1="90" x2="310" y2="118" stroke="#94a3b8" stroke-width="1.2"/>
<text x="318" y="108" font-size="10" fill="#94a3b8">ZMQ IPC（每个进程不同端口）</text>
<line x1="160" y1="118" x2="460" y2="118" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="160" y1="118" x2="160" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
<line x1="460" y1="118" x2="460" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t2ar)"/>
<rect x="60" y="160" width="200" height="110" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
<text x="160" y="186" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Scheduler</text>
<text x="160" y="208" text-anchor="middle" font-size="11" fill="#64748b">独立子进程</text>
<text x="160" y="230" text-anchor="middle" font-size="11" fill="#64748b">组批 / 驱动 GPU 前向</text>
<text x="160" y="252" text-anchor="middle" font-size="11" fill="#64748b">独立 GIL，全力跑调度</text>
<rect x="360" y="160" width="200" height="110" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
<text x="460" y="186" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">DetokenizerManager</text>
<text x="460" y="208" text-anchor="middle" font-size="11" fill="#64748b">独立子进程</text>
<text x="460" y="230" text-anchor="middle" font-size="11" fill="#64748b">token id → 文本</text>
<text x="460" y="252" text-anchor="middle" font-size="11" fill="#64748b">独立 GIL，与前向并行</text>
</svg>
<span class="figure-caption">图 T2.1 ｜ 三个独立进程靠 ZMQ IPC 连接——拆进程而非拆线程，根因是 GIL</span>

<details>
<summary>ASCII 原版</summary>

```text
        主进程 (你的 Python 脚本)
   ┌──────────────────────────────┐
   │  Engine  +  TokenizerManager │   分词、收发请求
   └───────────┬──────────────────┘
               │ ZMQ IPC (每个进程不同端口)
       ┌───────┴────────┐
       ▼                ▼
 ┌───────────┐   ┌──────────────────┐
 │ Scheduler │   │ DetokenizerMgr   │
 │ (子进程)  │   │ (子进程)         │
 │ 组批/前向 │   │ token id -> 文本 │
 └───────────┘   └──────────────────┘
```

</details>

- **TokenizerManager** 留在**主进程**里（和 `Engine` 同进程），`engine.py:846-849` 调 `init_tokenizer_manager_func` 创建它；
- **Scheduler** 在独立子进程，由 `_launch_scheduler_processes`（`engine.py:794`）用 `multiprocessing` 拉起，子进程入口是 `run_scheduler_process`（`python/sglang/srt/managers/scheduler.py:4029`）；
- **DetokenizerManager** 在另一个独立子进程，由 `_launch_detokenizer_subprocesses`（`engine.py:837`）拉起。

进程之间不能共享 Python 对象，所以它们靠 **ZMQ**（ZeroMQ）做 IPC。端口由 `PortArgs.init_new(server_args)`（`engine.py:766-767`）统一分配——每个进程一个端口，请求和结果以序列化消息的形式在管道里流动。这就是为什么上一步强调 `server_args` 必须可 pickle：它要被拷贝着发给每个子进程。

这样拆完，三个进程**真正并行**：Scheduler 全力驱动 GPU，TokenizerManager 同时给下一个请求分词，DetokenizerManager 同时把上一批的 token 转成文本。GPU 不再等 CPU。这正是 SGLang「零开销 CPU 调度器」能成立的物理前提——调度进程不被任何 CPU 杂活抢占。

注意 `engine.py:807-833` 那段：多节点部署时 `node_rank >= 1` 的节点**只起 Scheduler**，不起 tokenizer / detokenizer——非零号节点不接外部请求，只参与并行计算。本 trace 是单机，走 `node_rank == 0` 的完整路径。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/entrypoints/engine.py:735` —— `_launch_subprocesses`，三进程编排的总入口。
- `engine.py:766-767` —— `PortArgs.init_new`，分配 IPC 端口。
- `engine.py:794` —— `_launch_scheduler_processes`，拉起 Scheduler 子进程。
- `python/sglang/srt/managers/scheduler.py:4029` —— `run_scheduler_process`，Scheduler 子进程的入口函数。
- `engine.py:837` —— `_launch_detokenizer_subprocesses`。
- `engine.py:846-849` —— `init_tokenizer_manager_func`，在主进程内建 TokenizerManager。

## 7. 分支与延伸

- 三进程各自的完整职责、ZMQ socket 类型与消息格式 → [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md)
- Scheduler 子进程起来之后做的第一件事（建 ModelRunner、加载权重）→ [步骤 03](tour-03-load-weights.md)
- `tokenizer_worker_num > 1` 时会启 `MultiTokenizerRouter`（`engine.py:850-853`），多分词器分流 → [第 04 章](04-engine-and-processes.md)
- 多节点 / PD 分离场景下进程拓扑会变 → [第 13 章 分布式与并行执行](13-distributed.md)

## 8. 走完这一步你脑子里应该多了什么

1. SGLang 把推理拆成**三个独立进程**：TokenizerManager（主进程）、Scheduler（子进程）、DetokenizerManager（子进程）——拆进程而不是拆线程，根因是 **GIL**。
2. 拆进程的目的是让分词、调度、detokenize **物理并行**，使调度进程不被 CPU 杂活抢占——这是「零开销 CPU 调度器」的前提。
3. 进程间不共享内存，靠 **ZMQ IPC** 通信，端口由 `PortArgs` 统一分配；所有跨进程对象都必须可序列化。
4. 这一步只立了骨架——进程起来了、管道通了，但模型权重还没加载、KV 池还没分配。下一步 Scheduler 子进程会开始干这些重活。
