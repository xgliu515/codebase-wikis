# 第 05 章 请求对象与核心数据结构

## 本章导读

前四章是「按子系统」切的。本章不一样——它**追一个对象**:一个请求,从你的一行调用开始,到结果返回为止,在 SGLang 内部不断**变换形态**。

为什么要专门讲这个?因为 SGLang 的请求**不是一个对象一路走到底**。它在不同阶段是不同的类:用户面是 `GenerateReqInput`,跨进程时是 `TokenizedGenerateReqInput`,进了调度器变成 `Req`,组批后是 `ScheduleBatch`,要上 GPU 又转成 `ForwardBatch`。理解了这条变形链,你就理解了整个引擎的数据流骨架。

<svg viewBox="0 0 700 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Request object evolution across five forms">
<defs>
<marker id="r5ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
</defs>
<rect x="14" y="60" width="120" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="74" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">GenerateReq</text>
<text x="74" y="98" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">Input</text>
<line x1="134" y1="88" x2="160" y2="88" stroke="#ea580c" stroke-width="1.4" marker-end="url(#r5ar)"/>
<rect x="162" y="60" width="124" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="224" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">Tokenized</text>
<text x="224" y="98" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">GenerateReqInput</text>
<line x1="286" y1="88" x2="312" y2="88" stroke="#ea580c" stroke-width="1.4" marker-end="url(#r5ar)"/>
<rect x="314" y="60" width="90" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="359" y="92" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Req</text>
<line x1="404" y1="88" x2="430" y2="88" stroke="#ea580c" stroke-width="1.4" marker-end="url(#r5ar)"/>
<rect x="432" y="60" width="120" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="492" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">ScheduleBatch</text>
<text x="492" y="98" text-anchor="middle" font-size="9" fill="#64748b">CPU 调度批</text>
<line x1="552" y1="88" x2="578" y2="88" stroke="#ea580c" stroke-width="1.4" marker-end="url(#r5ar)"/>
<rect x="580" y="60" width="110" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="635" y="84" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">ForwardBatch</text>
<text x="635" y="98" text-anchor="middle" font-size="9" fill="#64748b">GPU 张量批</text>
<text x="74" y="40" text-anchor="middle" font-size="10" fill="#94a3b8">用户调用</text>
<text x="224" y="40" text-anchor="middle" font-size="10" fill="#94a3b8">跨进程</text>
<text x="359" y="40" text-anchor="middle" font-size="10" fill="#94a3b8">调度器内部</text>
<text x="563" y="40" text-anchor="middle" font-size="10" fill="#94a3b8">组批 / 上 GPU</text>
<rect x="14" y="150" width="272" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
<text x="150" y="167" text-anchor="middle" font-size="10" fill="#64748b">主进程 · TokenizerManager</text>
<rect x="314" y="150" width="376" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
<text x="502" y="167" text-anchor="middle" font-size="10" fill="#64748b">Scheduler 子进程（含 ModelRunner）</text>
<text x="352" y="200" text-anchor="middle" font-size="10" fill="#94a3b8">每次换类 = 过一道边界：进程边界 / CPU↔GPU / 单个↔批量</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ 一个请求在引擎内的五个形态，每次形态切换对应过一道边界</span>

<details>
<summary>ASCII 原版</summary>

```text
 用户调用                跨进程              调度器内部         上 GPU
 GenerateReqInput  ──►  TokenizedGenerate  ──►  Req      ──►  ScheduleBatch ──► ForwardBatch
 (io_struct.py)         ReqInput               (schedule_      (CPU,调度批)    (GPU 张量批)
                                                batch.py)
        │ 主进程 TokenizerManager │  Scheduler 子进程                          │ ModelRunner │
```

</details>

本章逐个拆解这五个形态:它们各装什么、为什么要换形态、归哪个进程管。

## 1. 为什么不能「一个对象走到底」

最朴素的设计:定义一个 `Request` 类,把所有字段都塞进去——用户传的文本、分词后的 id、KV 索引、已生成的 token、GPU 张量……一个对象从头用到尾。

这个设计会崩在三个点上:

1. **跨进程边界**:请求要从主进程(`TokenizerManager`)经 ZMQ 传到 Scheduler 子进程(见 [第 04 章](04-engine-and-processes.md))。跨进程的对象必须可序列化、而且应该**尽量小**——把 GPU 张量、调度账目这些塞进去既传不过去也没必要传。
2. **CPU/GPU 的鸿沟**:调度是 CPU 活儿,操作的是 Python 对象、整数、list;前向是 GPU 活儿,要的是规整的张量。一个对象同时承载两种形态,只会让两边的代码都别扭(见 [导览步骤 13](tour-13-forward-batch.md))。
3. **「单个」vs「一批」**:用户发的是单个请求,但 GPU 一次处理一**批**。请求对象和批对象的字段结构根本不同——单个有「我的文本」,批有「所有请求的 token 拼成的大张量」。

所以 SGLang 的选择是:**每个阶段用一个为该阶段量身定做的类**,阶段切换时显式转换。每次转换都是一次「丢掉这一阶段不需要的、补上下一阶段需要的」。

## 2. 形态一:`GenerateReqInput` —— 用户面请求

定义在 `python/sglang/srt/managers/io_struct.py:135`,继承自 `BaseReq`(`:51`)。

这是你调 `Engine.generate` 或 HTTP `/generate` 时,你的输入被包装成的对象。它装的是**用户视角**的东西:

- `text` / `input_ids` / `input_embeds`:输入,三选一(给文本、给 token id、或直接给 embedding);
- `sampling_params`:采样参数,此刻通常还是一个原始 **dict**(`{"max_new_tokens": 3, "temperature": 0}`);
- `stream`:是否流式;
- `rid`:请求 id(可不传,自动生成);
- 多模态字段(`image_data` 等)、`lora_path`、`return_logprob` 等可选项。

`GenerateReqInput` 的一个关键方法是 `normalize_batch_and_arguments`——它处理「单条还是批量」「并行采样要不要展开」「默认值填充」「生成 `rid`」。这一步把用户五花八门的传参方式**归一化**成统一形态(见 [导览步骤 06](tour-06-generate-call.md))。

注意此刻**还没分词**——`text` 还是字符串,`sampling_params` 还是 dict。`GenerateReqInput` 是「输入 DTO」,只描述「用户要什么」,不带任何运行时状态。

`io_struct.py` 里还有平行的 `EmbeddingReqInput`(`:819`)——embedding 任务的用户面请求,结构类似。

## 3. 形态二:`TokenizedGenerateReqInput` —— 跨进程的请求

定义在 `io_struct.py:711`。

`TokenizerManager` 在主进程里把 `GenerateReqInput` **分词**之后,产出的就是它(见 [导览步骤 07](tour-07-tokenize.md))。相对上一个形态,变化是:

- `text` 没了,换成 `input_ids`——分词后的整数列表;
- `sampling_params` 从 dict **升级成 `SamplingParams` 对象**(经过构造、归一化、校验);
- 保留 `rid`、`input_text`(留作调试)等。

它的使命单一:**作为跨进程消息**,从 `TokenizerManager` 经 ZMQ 发到 Scheduler 子进程。所以它必须可序列化,而且只装「Scheduler 起步需要的最小信息」——分词结果 + 采样参数。还有一个 `BatchTokenizedGenerateReqInput`(`io_struct.py:804`),是它的批量打包版本。

为什么分词后要换个类、而不是在 `GenerateReqInput` 上改字段?因为跨进程边界是个天然的「形态检查点」:换类强制你想清楚「到底哪些字段要传过去」,避免把一堆主进程才有意义的东西误传给子进程。

## 4. 形态三:`Req` —— 调度器内部的请求

定义在 `python/sglang/srt/managers/schedule_batch.py:571`。

Scheduler 子进程的 `recv_requests` 收到 `TokenizedGenerateReqInput` 后,把它升级成 `Req`(见 [导览步骤 08](tour-08-enqueue.md))。`Req` 的 docstring 一句话点题:「The input and output status of a request」——它是请求在调度器里的**完整状态机**。

从构造函数(`schedule_batch.py:574`)和初始化体(`:617` 起)能看到它的字段分几组:

**输入与输出**
- `origin_input_ids`(`:624`):原始输入 token;
- `output_ids`(`:626`):**已生成**的 token,decode 每出一个就 append 一个——这个 list 的增长就是「生成」本身;
- `fill_ids`(`:628`):`origin_input_ids + output_ids`,即「当前完整序列」,chunked 时会更新。

**KV 内存管理**(`:634-638`)
- `kv_committed_len`、`kv_allocated_len`:这个请求已分配/已落实的 KV 长度——调度器据此知道还要为它分配多少 KV(见 [第 07 章](07-kv-cache-memory.md)、[导览步骤 11](tour-11-alloc-kv.md))。

**采样与缓存**
- `sampling_params`(`:670`):此刻是 `SamplingParams` 对象;
- `extra_key`(`:680`)、`lora_id`(`:681`):前缀缓存的命名空间隔离键——不同 LoRA / cache salt 的请求不会错误共享前缀 KV(见 [第 06 章](06-radix-cache.md));
- `prefix_indices` 等(在后续初始化里):前缀匹配命中的 KV 索引。

**结束状态**
- `finished_reason`:请求结束的原因,取值是 `schedule_batch.py:128` 起定义的一组类——`FINISH_LENGTH`(`:169`,命中 `max_new_tokens`)、`FINISH_MATCHED_TOKEN`(`:133`,生成了 EOS)、`FINISH_MATCHED_STR`(`:145`,命中停止字符串)、`FINISH_ABORT`(`:181`,被中止)等。把「为什么结束」做成类型而非字符串,是为了让结束判定逻辑清晰可枚举(见 [导览步骤 18](tour-18-finish-return.md))。

`Req` 是调度器**全程持有、不断更新**的对象。从进 `waiting_queue`,到被组进批、prefill、一轮轮 decode、最后结束——同一个 `Req` 实例,字段一直在变。它是请求生命周期里**最长寿、最有状态**的形态。

## 5. 形态四:`ScheduleBatch` —— CPU 端的调度批

定义在 `schedule_batch.py:1371`。

GPU 一次处理一批请求,所以调度器要把若干 `Req` **组成批**。`ScheduleBatch` 就是这个批——它装一个 `reqs: List[Req]`,加上批级别的元数据。

关键字段:

- `reqs`:本批包含的 `Req` 列表;
- `forward_mode`:本批的前向模式,`EXTEND`(prefill)或 `DECODE`——决定这批走哪条计算路径;
- `is_prefill_only` 等标志;
- chunked prefill、KV 池引用等调度账目。

`ScheduleBatch` 是**纯 CPU 对象**——里面是 `Req` 列表和 Python 元数据,不是 GPU 张量。它有两个重要的「准备」方法:

- `prepare_for_extend`(`schedule_batch.py:1688`):为 prefill 批准备数据,触发 KV 分配(见 [导览步骤 11](tour-11-alloc-kv.md)、[步骤 12](tour-12-build-batch.md));
- `prepare_for_decode`(`schedule_batch.py:2280`):为 decode 批准备数据,每个请求追加 1 个 token 的 KV 槽位(见 [导览步骤 17](tour-17-decode-loop.md))。

`ScheduleBatch` 还能 `merge_batch`(把新 prefill 批并进正在 decode 的批)、`filter_batch`(把结束的请求剔出去)——这正是**连续批处理**的实现:批不是固定的,请求随时进出(见 [第 08 章](08-scheduler.md))。

## 6. 形态五:`ForwardBatch` —— GPU 端的执行批

定义在 `python/sglang/srt/model_executor/forward_batch_info.py`。

`ScheduleBatch` 是 CPU 视角的,GPU 跑不了。最后一次变形,是把它转成 `ForwardBatch`(见 [导览步骤 13](tour-13-forward-batch.md))。`ForwardBatch` 装的全是**GPU 张量**:

- `input_ids`:所有请求要算的 token 拼成的一维张量;
- `positions`:对应的位置张量;
- `out_cache_loc`:新算的 K/V 该写进 KV 池的哪些索引;
- `seq_lens` / `extend_seq_lens`:各请求的序列长度信息;
- 注意力后端元数据(由后端的 `init_forward_metadata` 建)。

前向模式用枚举 `ForwardMode`(`forward_batch_info.py:78`)表示,主要取值 `EXTEND`(`:81`)和 `DECODE`(`:83`),配套 `is_extend()` / `is_decode()`(`:111` 起)等判定方法。

`ForwardBatch` 的特点:字段形状确定、显存地址稳定。这不是巧合——这是 **CUDA graph** 能工作的前提(见 [导览步骤 05](tour-05-capture-cuda-graph.md))。`ScheduleBatch → ForwardBatch` 这道转换,本质就是把「调度视角的散乱信息」摊平成「GPU 视角的规整张量」。

## 7. 输出形态:`BatchTokenIDOutput` 与 `BatchStrOutput`

请求算完,结果也要分形态往回走:

- **`BatchTokenIDOutput`**(`io_struct.py:1073`):Scheduler 产出的输出,装的是**新生成的 token id**。它从 Scheduler 经 ZMQ 发给 `DetokenizerManager`。
- **`BatchStrOutput`**(`io_struct.py:1145`):`DetokenizerManager` 把 token id 转成**文本**后的输出,再发回 `TokenizerManager`,最终变成用户拿到的结果。

两者都混入了 `SpeculativeDecodingMetricsMixin`(`io_struct.py:85`)——投机解码的统计指标(接受率等)跟着输出一路带回(见 [第 12 章](12-speculative-decoding.md))。embedding 任务则走 `BatchEmbeddingOutput`(`:1211`)。

输出的「id → 文本」分两段、跨两个进程,和输入的「文本 → id」对称——分词在 `TokenizerManager`、detokenize 在 `DetokenizerManager`,各占一个进程(见 [第 04 章](04-engine-and-processes.md))。

## 8. 全景:对象演化表

| 阶段 | 形态 | 装什么 | 归属进程 | 定义位置 |
|------|------|--------|----------|----------|
| 用户调用 | `GenerateReqInput` | 文本 / 原始采样 dict | 主进程 | `io_struct.py:135` |
| 分词后 | `TokenizedGenerateReqInput` | `input_ids` + `SamplingParams` | 主进程→子进程(ZMQ) | `io_struct.py:711` |
| 调度中 | `Req` | 完整状态:输入/输出/KV/结束原因 | Scheduler 子进程 | `schedule_batch.py:571` |
| 组批后 | `ScheduleBatch` | `Req` 列表 + 批元数据(CPU) | Scheduler 子进程 | `schedule_batch.py:1371` |
| 上 GPU | `ForwardBatch` | GPU 张量 + 注意力元数据 | Scheduler 子进程 | `forward_batch_info.py` |
| 输出(id) | `BatchTokenIDOutput` | 新生成 token id | 子进程→Detokenizer | `io_struct.py:1073` |
| 输出(文本) | `BatchStrOutput` | 文本结果 | Detokenizer→主进程 | `io_struct.py:1145` |

每一次形态切换,都对应一次「过边界」:过进程边界(ZMQ 序列化)、过 CPU/GPU 边界(张量化)、过单个/批量边界(组批)。SGLang 用「换类」把这些边界**显式化**——你看到对象换了类,就知道它过了一道关。

## 相关章节

- [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md) —— 这些对象在三个进程之间怎么流动
- [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) —— `Req.extra_key` / `prefix_indices` 的用途
- [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md) —— `Req` 的 KV 字段、`ForwardBatch.out_cache_loc`
- [第 08 章 调度器与连续批处理](08-scheduler.md) —— `ScheduleBatch` 的 merge / filter
- [导览步骤 06-08、13](tour-00-overview.md) —— 对象演化的实际 trace
