# Trace 步骤 05 —— llama_init_from_model 做了什么,上下文从哪里来?

## 1. 当前情境

走到这里,`llama_model` 已经完全就绪:权重通过 mmap 映射进地址空间,模型架构已从 GGUF 元数据中确定,`llama_hparams` 的每一个字段都有了值(`src/llama-model.h`)。全局后端注册表也在步骤 01 里填好了,记录了这台机器真实可用的 CPU/Metal/CUDA 后端。

`simple.cpp` 接下来先算出 prompt 长度(`n_prompt`),然后做三件事(`examples/simple/simple.cpp:111`-`119`):

```cpp
llama_context_params ctx_params = llama_context_default_params();
ctx_params.n_ctx   = n_prompt + n_predict - 1;
ctx_params.n_batch = n_prompt;
ctx_params.no_perf = false;

llama_context * ctx = llama_init_from_model(model, ctx_params);
```

`ctx_params` 只设了三个字段,其余全部走默认值。调用返回后,`ctx` 指向一个完整的 `llama_context` 实例。这一步要搞清楚这个实例里到底构造了哪些东西。

## 2. 问题

一次推理需要若干资源——它们不属于模型本身(模型是只读的共享数据),而属于"这一次推理会话":

- **上下文窗口有多大**:模型权重里没有这个信息,用户每次调用可以选不同的 `n_ctx`。
- **KV 缓存放在哪台设备上**:CPU 推理和 GPU 推理的布局完全不同。
- **计算图的中间张量用哪块内存**:不同批大小、不同序列数,峰值显存需求差异极大。
- **logits 输出缓冲在哪里**:需要可以被 CPU 读取,但可能要从 GPU 拷来。

如果这些每次 `decode` 时再现场分配,程序就无法在推理前告诉用户"你的显卡装不下"——一跑就 OOM 崩溃。

## 3. 朴素思路

最简单的想法:调 `llama_init_from_model` 时把 `n_ctx`、`n_batch` 之类的参数记下来,真正需要内存时(第一次 decode)再懒加载、按需分配 KV 缓存和计算缓冲。

这样 `init` 调用会很快,API 也"轻量"。

## 4. 为什么朴素思路会崩

- **显存不够只有到运行时才知道**。用户传入 `n_ctx=32768`,在 4 GB 显卡上完全装不下。懒加载方案让这个错误推迟到第一次 decode 才暴露,此时往往已经完成了几百毫秒的 prefill 初始化工作,白费时间。
- **计算图大小与 batch 大小有关**。计算图的节点数、每个节点的内存开销,取决于一次处理多少 token。如果不在 init 阶段就把最坏情况的图跑一遍,scheduler 就无法预先告知每个后端需要多大的计算缓冲。
- **后端实例不能共享**。Metal/CUDA 后端持有设备级状态(命令队列、流、事件),必须每个上下文独立持有一套,共享会引发竞态。
- **线程池绑定需要提前完成**。CPU 线程池的数量影响矩阵乘法的切分方式;如果在 decode 途中才确定线程数,整个切分方案就要重做。

核心矛盾:**运行期参数(n_ctx、设备列表)与显存布局(KV 大小、计算缓冲)之间的绑定,必须发生在第一次 decode 之前,不能更晚。**

## 5. llama.cpp 的做法

`llama_init_from_model`(`src/llama-context.cpp:3361`) 校验参数后,直接 `new llama_context(*model, params)`(`src/llama-context.cpp:3441`),把全部初始化工作集中到构造函数里。构造过程分五个阶段:

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_init_from_model five construction phases">
  <defs>
    <marker id="ar5a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="360" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="240" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="136" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">llama_init_from_model()</text>
  <line x1="136" y1="50" x2="136" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="16" y="66" width="240" height="48" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="136" y="85" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">① 解析 cparams</text>
  <text x="136" y="103" text-anchor="middle" font-size="11" fill="#64748b">n_ctx 对齐到 256 · n_batch ≤ n_ctx · n_ubatch</text>
  <line x1="256" y1="90" x2="320" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="320" y="66" width="424" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="532" y="86" text-anchor="middle" font-size="11" fill="#64748b">ctx_params → llama_cparams</text>
  <text x="532" y="103" text-anchor="middle" font-size="10" fill="#94a3b8">每字段均为确定最终值,无"0=默认"</text>
  <line x1="136" y1="114" x2="136" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="16" y="130" width="240" height="48" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="136" y="149" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">② 实例化后端</text>
  <text x="136" y="167" text-anchor="middle" font-size="11" fill="#64748b">GPU0/GPU1 + ACCEL + CPU 后端实例</text>
  <line x1="256" y1="154" x2="320" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="320" y="130" width="424" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="532" y="150" text-anchor="middle" font-size="11" fill="#64748b">ggml_backend_dev_init × N + CPU</text>
  <text x="532" y="167" text-anchor="middle" font-size="10" fill="#94a3b8">per-context 独立实例,非全局共享</text>
  <line x1="136" y1="178" x2="136" y2="194" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="16" y="194" width="240" height="48" rx="6" fill="#f1f5f9" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="136" y="213" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">③ 准备输出缓冲</text>
  <text x="136" y="231" text-anchor="middle" font-size="11" fill="#64748b">buf_output: logits / embeddings</text>
  <line x1="256" y1="218" x2="320" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="320" y="194" width="424" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="532" y="214" text-anchor="middle" font-size="11" fill="#64748b">n_vocab × n_outputs_max × sizeof(float)</text>
  <text x="532" y="231" text-anchor="middle" font-size="10" fill="#94a3b8">host buffer,CPU 可读 (GPU→CPU 落点)</text>
  <line x1="136" y1="242" x2="136" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="16" y="258" width="240" height="48" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="136" y="277" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">④ 创建 memory (KV 缓存)</text>
  <text x="136" y="295" text-anchor="middle" font-size="11" fill="#64748b">→ new llama_kv_cache(…)  步骤 06</text>
  <line x1="256" y1="282" x2="320" y2="282" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="320" y="258" width="424" height="48" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="532" y="278" text-anchor="middle" font-size="11" fill="#64748b">KV 张量按层按设备分配完毕</text>
  <text x="532" y="295" text-anchor="middle" font-size="10" fill="#94a3b8">llama_memory_i 接口,对 decode 透明</text>
  <line x1="136" y1="306" x2="136" y2="322" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="16" y="322" width="240" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="136" y="342" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">⑤ sched_reserve()  步骤 07</text>
  <line x1="256" y1="337" x2="320" y2="337" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5a)"/>
  <rect x="320" y="322" width="424" height="30" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="532" y="342" text-anchor="middle" font-size="11" fill="#64748b">dry-run 最大图 → gallocr 固化计算 buffer 显存</text>
</svg>
<span class="figure-caption">图 T5.1 ｜ llama_init_from_model 构造函数的五个阶段</span>

<details>
<summary>ASCII 原版</summary>

```
llama_init_from_model(model, ctx_params)
    |
    v  1. 解析 cparams(ctx_params -> llama_cparams)
    |     n_ctx 对齐到 256; n_batch <= n_ctx; n_ubatch = min(n_batch, ...)
    |
    v  2. 实例化后端(backends 列表)
    |     model.devices[] -> ggml_backend_dev_init -> GPU 后端实例
    |     ACCEL 类型后端 (BLAS) -> 追加
    |     ggml_backend_init_by_type(CPU) -> CPU 后端实例
    |
    v  3. 准备输出缓冲 output_reserve(n_seq_max)
    |     分配 buf_output:存放 logits / embeddings 的 host buffer
    |
    v  4. 创建 memory 模块(KV 缓存)
    |     model.create_memory(params_mem, cparams)
    |     -> 对于 Qwen2.5 这类标准 attention 模型 -> new llama_kv_cache(...)
    |
    v  5. 调 sched_reserve() 固化计算缓冲
           建 ggml_backend_sched; 用最大 ubatch dry-run 计算图
           gallocr 量出峰值显存并分配
```

</details>

**阶段一:解析 cparams**。`llama_context_params` 是对外 API 结构,字段不完整且有"0 表示用默认值"的约定。构造函数把它转化为内部的 `llama_cparams`(`src/llama-cparams.h:9`)——每个字段都是最终值,不含任何"未指定"语义。关键处理(`src/llama-context.cpp:75`-`201`):

- `n_ctx == 0` 时退回模型训练时的 `hparams.n_ctx_train`。
- `n_ctx` 向上对齐到 256(`GGML_PAD`,`src/llama-context.cpp:201`),保证后续张量分配对齐友好。
- `n_batch = min(n_ctx, params.n_batch)`,防止批大小超上下文长度。
- `n_ubatch = min(n_batch, params.n_ubatch)`,控制每次 scheduler 实际处理的 token 上限。

**阶段二:实例化后端**(`src/llama-context.cpp:242`-`268`)。遍历 `model.devices`(在加载模型时按 `-ngl` 规则决定了哪些层放 GPU)——对每个设备调 `ggml_backend_dev_init`,得到一个运行期的 `ggml_backend` 实例。再追加 ACCEL 类型后端(如 BLAS)和 CPU 后端。这些实例都压入 `backends` 向量,后面 scheduler 和 KV 缓存都从这里取。

**阶段三:准备输出缓冲**(`src/llama-context.cpp:284`-`293`)。`output_reserve` 在 host 侧(或 GPU 的 pinned buffer)分配一块连续内存 `buf_output`,大小为 `n_vocab × n_outputs_max × sizeof(float)`,供 decode 完成后存放 logits。KV 缓存和计算图的中间张量都在 GPU 上,但 logits 必须能被 CPU 读取——这一块 buffer 正是 GPU→CPU 传输的落点(`src/llama-context.cpp:1991`-`2070`)。

**阶段四:创建 memory 模块**(`src/llama-context.cpp:297`-`305`)。调 `model.create_memory(params_mem, cparams)`,返回一个 `llama_memory_i *`。对于 Qwen2.5 这类纯 attention 模型,它返回 `new llama_kv_cache(...)`,KV 张量的实际分配发生在 `llama_kv_cache` 构造函数里——这就是步骤 06 要讲的内容。

**阶段五:调 sched_reserve()**(`src/llama-context.cpp:371`)。创建 `ggml_backend_sched`,然后用最大尺寸(`n_ubatch × n_seqs`)dry-run 构建一遍计算图,让图分配器 `gallocr` 量出显存峰值并固化——这就是步骤 07 要讲的内容。

走完构造函数,`llama_context` 的成员结构如下:

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_context data structure layout">
  <rect width="760" height="280" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="728" height="252" rx="8" fill="#fff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama_context</text>
  <line x1="16" y1="48" x2="744" y2="48" stroke="#cbd5e1" stroke-width="0.8"/>
  <rect x="32" y="58" width="168" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="116" y="77" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">cparams</text>
  <text x="210" y="71" font-size="11" fill="#64748b">llama_cparams</text>
  <text x="420" y="71" font-size="10" fill="#94a3b8">n_ctx / n_batch / n_ubatch … 所有运行参数最终值</text>
  <rect x="32" y="96" width="168" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="116" y="115" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">backends[]</text>
  <text x="210" y="109" font-size="11" fill="#64748b">ggml_backend_ptr[]</text>
  <text x="420" y="109" font-size="10" fill="#94a3b8">GPU0 / GPU1 / … / ACCEL / CPU 实例 (per-context)</text>
  <rect x="32" y="134" width="168" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="116" y="153" text-anchor="middle" font-size="11" fill="#64748b">backend_cpu</text>
  <text x="210" y="147" font-size="11" fill="#64748b">ggml_backend_t</text>
  <text x="420" y="147" font-size="10" fill="#94a3b8">CPU 实例裸指针副本(兜底引用)</text>
  <rect x="32" y="172" width="168" height="28" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="116" y="191" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">sched</text>
  <text x="210" y="185" font-size="11" fill="#64748b">ggml_backend_sched_ptr</text>
  <text x="420" y="185" font-size="10" fill="#94a3b8">调度器 ← 步骤 07 完成后就绪</text>
  <rect x="32" y="210" width="168" height="28" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="116" y="229" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">memory</text>
  <text x="210" y="223" font-size="11" fill="#64748b">llama_memory_ptr</text>
  <text x="420" y="223" font-size="10" fill="#94a3b8">KV 缓存 ← 步骤 06 完成后就绪</text>
  <rect x="32" y="248" width="168" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="116" y="263" text-anchor="middle" font-size="11" fill="#64748b">buf_output / output_ids</text>
  <text x="210" y="261" font-size="10" fill="#94a3b8">logits 输出 buffer + batch token 到行的映射</text>
</svg>
<span class="figure-caption">图 T5.2 ｜ llama_context 关键成员布局</span>

<details>
<summary>ASCII 原版</summary>

```
llama_context
├── cparams          (llama_cparams)     <- 所有运行参数最终值
├── backends[]       (ggml_backend_ptr)  <- GPU0/GPU1/.../ACCEL/CPU 实例
├── backend_cpu      (ggml_backend_t)    <- CPU 实例的裸指针副本
├── sched            (ggml_backend_sched_ptr) <- 调度器(步骤 07 完成后就绪)
├── memory           (llama_memory_ptr)  <- KV 缓存 (步骤 06 完成后就绪)
├── buf_output       (ggml_backend_buffer_ptr) <- logits 输出缓冲
└── output_ids[]     <- batch token 位置到 logits 行的映射
```

</details>

## 6. 代码位置

按阅读顺序:

- 调用入口:`examples/simple/simple.cpp:111`-`119` —— ctx_params 设置与 `llama_init_from_model` 调用
- 公共 API 实现:`src/llama-context.cpp:3361`-`3448` —— `llama_init_from_model`(参数校验 + `new llama_context`)
- 构造函数签名:`src/llama-context.h:43`-`45` —— `llama_context::llama_context`
- 构造函数主体:`src/llama-context.cpp:33`-`389` —— 全部五个阶段
- cparams 解析:`src/llama-context.cpp:49`-`217` —— 各字段处理;`201` 行是 `n_ctx` 对齐到 256
- 后端实例化:`src/llama-context.cpp:242`-`268` —— GPU + ACCEL + CPU 后端 init
- 输出缓冲:`src/llama-context.cpp:284`-`293` —— `output_reserve` 调用
- memory 创建:`src/llama-context.cpp:297`-`305` —— `model.create_memory`
- sched_reserve 调用:`src/llama-context.cpp:371` —— `sched_reserve()`
- cparams 结构体:`src/llama-cparams.h:9`-`51` —— 所有内部参数字段
- context 成员布局:`src/llama-context.h:267`-`377` —— 全部私有成员
- memory 接口定义:`src/llama-memory.h:71`-`125` —— `llama_memory_i` 抽象接口

## 7. 分支与延伸

- `llama_context` 里的 `backends`、`sched` 与 `backend_ptrs`/`backend_buft` 四个向量的关系,以及 scheduler 怎么在多设备间分派算子 -> [第 9 章 GGML 后端系统](09-ggml-backend.md)
- `n_ctx`、`n_batch`、`n_ubatch`、`n_seq_max` 这四个参数的确切语义与 decode 循环的关系 -> [第 7 章 上下文与批处理](07-context-and-batching.md)
- `llama_cparams` 中 `flash_attn`、`offload_kqv`、`kv_unified`、`pipeline_parallel` 等字段对后续 KV 分配和图构建的影响 -> [第 7 章 上下文与批处理](07-context-and-batching.md)
- `model.devices` 是在加载模型阶段按 `-ngl` 规则填好的,`ggml_backend_dev_init` 拿到的是同一个 `ggml_backend_device` 的运行期实例 -> [步骤 04:识别模型架构](tour-04-arch-detect.md)、[第 9 章](09-ggml-backend.md)
- 步骤 06 会深入 `llama_kv_cache` 的构造——KV 张量如何按层按设备分配 -> [步骤 06:分配 KV 缓存](tour-06-kv-alloc.md)
- 步骤 07 会深入 `sched_reserve`——`gallocr` 的 dry-run 如何量出显存峰值 -> [步骤 07:预留计算图与调度器](tour-07-graph-reserve.md)

## 8. 走完这一步你脑子里应该多了什么

1. **`llama_context` 在构造函数里就完成了全部资源分配**。`llama_init_from_model` 返回后,显存是否足够已经有了答案——不够会在构造期抛异常,`nullptr` 返回给调用方。
2. **`llama_context_params` 与 `llama_cparams` 是两套不同的结构**。前者是对外 API(允许 0 表示"用默认值");后者是内部参数(每个字段都是确定的最终值)。两者在构造函数入口处完成转换。
3. **后端实例是 per-context 的,不是全局共享的**。每个 `llama_context` 持有自己的 `ggml_backend` 实例列表,和全局注册表里的 `ggml_backend_reg` 是不同层级的概念。
4. **`n_ctx` 会被对齐到 256**(`src/llama-context.cpp:201`),这会影响 KV 缓存的实际大小,也是步骤 06 里 `kv_size` 的来源。
5. **memory 模块是一个抽象接口(`llama_memory_i`)**,对 Qwen2.5 等标准模型实例化为 `llama_kv_cache`,对循环神经网络模型实例化为 `llama_memory_recurrent`,两者都实现相同的接口,对 decode 循环透明。

下一步:[步骤 06 —— 分配 KV 缓存](tour-06-kv-alloc.md)。
