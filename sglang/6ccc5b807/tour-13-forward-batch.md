# Trace 步骤 13 —— CPU 上的调度批，怎么变成 GPU 能吃的张量？

## 1. 当前情境

上一步组好了一个 `ScheduleBatch`，`forward_mode=EXTEND`，里面是我们这个请求。但 `ScheduleBatch` 是**调度器视角**的对象——它装的是 `Req` 列表、Python 整数、CPU 上的元数据。GPU 看不懂这些。`run_batch`（`scheduler.py:3051`）要把它交给 `ModelRunner` 跑前向，中间隔着一道转换。

## 2. 问题

GPU 跑前向，吃的是**张量**——而且必须是已经在 GPU 显存上、形状规整、可以直接喂进 kernel 的张量。`ScheduleBatch` 里是什么？是 `Req` 对象、是 Python list、是「这个请求命中了多少前缀」这种调度账目。两者之间隔着鸿沟。这一步要解决的是：

- 把调度批里散落的信息**摊平**成几个大张量（所有请求的 input token 拼一起、position 拼一起……）；
- 把这些张量**搬上 GPU**；
- 还要额外准备一份**注意力后端需要的元数据**——每个请求的序列长度、前缀长度、KV 索引位置等,否则注意力 kernel 不知道该读 KV 池的哪里。

## 3. 朴素思路

让模型的 `forward` 直接收 `ScheduleBatch`,在 forward 内部边算边从 `Req` 列表里取数据、按需转张量、按需搬 GPU。反正信息都在,要啥取啥。

## 4. 为什么朴素思路会崩

「forward 内部边算边取」会把两件本该分开的事搅在一起,代价惨重：

- **零散的 H2D 拷贝**：每从 `Req` 取一个字段转张量搬 GPU,就是一次 host-to-device 传输。一次前向几十层、每层都取,就是几百次零散小拷贝——每次都有固定延迟,加起来比「一次性打包搬一个大张量」慢一个数量级。
- **CUDA graph 直接报废**：CUDA graph(步骤 05)要求每次 replay 时张量的**形状和显存地址固定**。如果 forward 内部动态地从 Python 对象取数据建张量,形状和地址每次都变,graph 根本没法录、没法 replay。decode 的核心优化当场失效。
- **CPU 逻辑混进 GPU 热路径**:遍历 `Req` 列表、查映射表这些 Python 操作如果嵌在 forward 里,就没法和 GPU 计算重叠(步骤 09 的 overlap 全靠「组批」和「前向」分离)。

根本问题:**张量的准备**和**张量的计算**必须是两个分开的阶段。准备阶段把一切 CPU 杂活做完、产出形状确定的 GPU 张量;计算阶段只管纯 GPU 运算。

## 5. SGLang 的做法

SGLang 设了一个专门的执行层批对象——**`ForwardBatch`**(`python/sglang/srt/model_executor/forward_batch_info.py`)。`ScheduleBatch` → `ForwardBatch` 这一道转换,就是「准备阶段」:

<svg viewBox="0 0 680 226" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ScheduleBatch converted to ForwardBatch of GPU tensors">
<defs>
<marker id="t13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
</defs>
<text x="150" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">CPU · 调度视角</text>
<rect x="30" y="32" width="240" height="150" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="150" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ScheduleBatch</text>
<line x1="46" y1="66" x2="254" y2="66" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="50" y="90" font-size="11" fill="#64748b">reqs: [Req, Req, …]</text>
<text x="50" y="114" font-size="11" fill="#64748b">forward_mode = EXTEND</text>
<text x="50" y="138" font-size="11" fill="#64748b">各 Req 的 CPU 元数据</text>
<text x="50" y="162" font-size="10" fill="#94a3b8">Python 对象，GPU 跑不了</text>
<line x1="272" y1="107" x2="408" y2="107" stroke="#ea580c" stroke-width="1.5" marker-end="url(#t13ar)"/>
<text x="340" y="98" text-anchor="middle" font-size="10" fill="#ea580c">摊平 + 上 GPU</text>
<text x="540" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">GPU · 执行视角</text>
<rect x="412" y="32" width="256" height="166" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="540" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ForwardBatch</text>
<line x1="428" y1="66" x2="652" y2="66" stroke="#fb923c" stroke-dasharray="4,3"/>
<text x="432" y="90" font-size="11" fill="#64748b">input_ids　　　 GPU 张量</text>
<text x="432" y="112" font-size="11" fill="#64748b">positions　　　 GPU 张量</text>
<text x="432" y="134" font-size="11" fill="#64748b">out_cache_loc　 KV 写入位置</text>
<text x="432" y="156" font-size="11" fill="#64748b">seq_lens / extend_seq_lens</text>
<text x="432" y="178" font-size="11" fill="#64748b">注意力后端元数据</text>
<text x="540" y="216" text-anchor="middle" font-size="10" fill="#94a3b8">形状/地址固定 → CUDA graph 可用</text>
</svg>
<span class="figure-caption">图 T13.1 ｜ ScheduleBatch → ForwardBatch：把调度视角的散乱信息摊平成 GPU 视角的规整张量</span>

<details>
<summary>ASCII 原版</summary>

```text
 ScheduleBatch (CPU, 调度视角)        ForwardBatch (GPU, 执行视角)
 ┌────────────────────────┐          ┌─────────────────────────────┐
 │ reqs: [Req, Req, ...]   │          │ input_ids   : GPU 张量      │
 │ forward_mode = EXTEND   │  ──────► │ positions   : GPU 张量      │
 │ 各 Req 的 CPU 元数据    │   转换   │ out_cache_loc: KV 写入位置  │
 │                         │          │ seq_lens / extend_seq_lens  │
 │                         │          │ attn_backend metadata       │
 └────────────────────────┘          └─────────────────────────────┘
```

</details>

转换做的事:

- 把所有请求要算的 token id 拼成一个一维张量 `input_ids`、对应的位置拼成 `positions`,搬上 GPU——**一次性**大拷贝;
- 算出每个请求的 `seq_lens`(总长)、`extend_seq_lens`(本次要算的新 token 数)等;本 trace 单请求、命中前缀 0,所以「新 token 数」就是 6;
- 准备 `out_cache_loc`——这 6 个 token 算出的 K/V 该写进 KV 池的哪些索引(来自步骤 11 的分配结果);
- 调用注意力后端的 `init_forward_metadata`,建好注意力 kernel 需要的元数据(见 [步骤 15](tour-15-attention-kernel.md))。

`forward_mode` 用一个枚举 `ForwardMode`(`forward_batch_info.py:78`)表示。我们这批是 `ForwardMode.EXTEND`(`:81`)——「extend」是 SGLang 对 prefill 的内部叫法,意思是「在已有前缀(可能为空)后面**扩展**若干新 token」。它和 `ForwardMode.DECODE`(`:83`,一次只扩展 1 个 token)是前向的两种主模式。`is_extend()` / `is_decode()` 这些判定方法(`:111` 起)决定后续走哪条 kernel 路径。

`ForwardBatch` 造好,所有 GPU 张量、注意力元数据就位。它形状确定、地址稳定——这正是 CUDA graph 能工作的前提。下一步 `ModelRunner` 拿它跑真正的前向。

## 6. 代码位置

按顺序读:

- `python/sglang/srt/managers/scheduler.py:3051` —— `run_batch`,把 `ScheduleBatch` 交给 `ModelRunner`。
- `python/sglang/srt/model_executor/forward_batch_info.py:78` —— `ForwardMode` 枚举;`:81` 的 `EXTEND`、`:83` 的 `DECODE`。
- `forward_batch_info.py:111` 起 —— `is_extend()` / `is_decode()` 等模式判定。
- `forward_batch_info.py` 里的 `ForwardBatch` 类 —— 执行层批对象,看它有哪些 GPU 张量字段。
- `python/sglang/srt/model_executor/model_runner.py:3111` —— `ModelRunner.forward`,转换后的 `ForwardBatch` 在这里被消费。

## 7. 分支与延伸

- `ScheduleBatch` 与 `ForwardBatch` 的字段对照、生命周期 → [第 05 章 请求对象与核心数据结构](05-request-data-structures.md)
- `ForwardBatch` 的构建、`ModelRunner` 怎么用它 → [第 09 章 ModelRunner 与前向执行](09-model-runner.md)
- 注意力元数据(`seq_lens` / `out_cache_loc` 等)怎么被注意力 kernel 使用 → [步骤 15](tour-15-attention-kernel.md)、[第 10 章](10-attention-backends.md)
- CUDA graph 为什么依赖张量形状/地址固定 → [步骤 05](tour-05-capture-cuda-graph.md)、[第 09 章](09-model-runner.md)

## 8. 走完这一步你脑子里应该多了什么

1. `ScheduleBatch`(CPU、调度视角)和 `ForwardBatch`(GPU、执行视角)是**两个不同对象**,中间隔着一道显式的转换。
2. 转换 = 「准备阶段」:摊平成大张量、一次性搬 GPU、算注意力元数据;它和「计算阶段」分开,是为了避免零散 H2D 拷贝、并让 CUDA graph 能工作。
3. `ForwardMode` 枚举区分前向模式:`EXTEND`(prefill,一次扩展多个 token)和 `DECODE`(一次扩展 1 个);本 trace 当前是 `EXTEND`。
4. `ForwardBatch` 造好后形状确定、地址稳定——这是 CUDA graph、以及 CPU/GPU 重叠能成立的基础。
