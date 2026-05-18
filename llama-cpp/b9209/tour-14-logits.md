# Trace 步骤 14 —— 计算图跑完了,logits 在哪里,怎么拿到?

## 1. 当前情境

步骤 13 里,`ggml_backend_sched_graph_compute` 执行完成,后端(CPU 或 GPU)已经把计算图里每个算子的结果写进了对应张量的 data 指针。此刻存放最终 logits 的那块内存还住在**后端 buffer**里:如果你用 Metal/CUDA,它可能在显存中;即使是 CPU 后端,它也住在由 `ggml_backend_alloc` 管理的一块专属缓冲里,不是 `llama_context` 的栈上变量。

`simple.cpp` 的解码循环刚走完 `llama_decode(ctx, batch)` 这一行(`examples/simple/simple.cpp:173`)。下一行就是:

```cpp
new_token_id = llama_sampler_sample(smpl, ctx, -1);
```

采样函数第一件事就是从 `ctx` 里取出 logits。如果取不到,后面一切都是空中楼阁。

## 2. 问题

计算图的输出张量(`t_logits`)里放着形如 `[n_outputs, n_vocab]` 的 float 矩阵——行数是这次 batch 里**标记为需要输出的位置数**,列数是词表大小(Qwen2.5-0.5B 约 151936)。

问题有两个层次:

1. **哪一行?** 一个 batch 里可能有多个 token 被标记为需要输出。对于 prefill,`llama_batch_get_one` 传进来的 batch 没有手动设 `logits` 字段,框架会默认只把**最后一个 token** 标记为需要输出(下文细讲)。调用方说"给我第 `-1` 个位置",这个 `-1` 怎么翻译成缓冲区里的某一行?

2. **从哪块内存取?** 后端 buffer 里的数据对 CPU 端的 C++ 代码不一定是直接可见的——尤其当后端是 CUDA 时,数据住在 GPU 内存里。采样器是纯 CPU 代码,它需要一个 CPU 可访问的 float 指针。

## 3. 朴素思路

最简单的做法:计算图执行完,立刻把整个输出张量同步拷到一个固定大小的 `float` 数组里,所有位置的 logits 全复制过来。调用方直接用下标读这个数组。

## 4. 为什么朴素思路会崩

- **内存浪费**:prefill 阶段 batch 里有 N 个 token,全部拷贝就是 `N × n_vocab` 个 float。Qwen2.5-0.5B 词表 151936,如果 prompt 有 512 个 token,那就是 512 × 151936 × 4 ≈ 310 MB 的拷贝——绝大多数根本用不到。
- **同步开销**:后端是异步的。`ggml_backend_tensor_get` 会强制等待 GPU 执行完,把整批数据拷过来。如果只是为了最后一行 logits 而同步整块缓冲,既增延迟又降并行度。
- **output_ids 索引混乱**:现实中 batch 里哪些 token 需要输出、它们对应缓冲区里的第几行,这个映射随每次 decode 变化。如果全量拷贝,调用方还要自己查这个映射,接口很难用。

核心矛盾:**调用方关心的只是"最后一个位置"这一行,却被迫为整张表付出代价。**

## 5. llama.cpp 的做法

llama.cpp 用两个机制组合解决这个问题:

**机制一:只输出需要的位置(output 标记)**

`llama_batch_get_one` 返回的 `llama_batch` 结构里 `logits` 字段为 `nullptr`(`src/llama-batch.cpp:863`)。`llama_context::decode` 在初始化 batch 分配器时检测到 `logits == nullptr`,就在 `llama_batch_allocr::init` 里生成一个默认标记:把除最后一个 token 外的所有位置标记为 `output=false`,只把最后一个位置标记为 `output=true`(`src/llama-batch.cpp:126`-`127`):

```cpp
// return the output only for the last token
output.resize(batch.n_tokens, false);
output[output.size() - 1] = true;
```

结果:`n_outputs_all == 1`。计算图构建时 `out_ids` 里只有一个条目,输出缓冲区就只为这一行分配了 `1 × n_vocab` 个 float。

**机制二:output_ids 映射 + 负索引**

`llama_context` 持有一个 `output_ids` 向量(`src/llama-context.cpp:1942`-`1944`),它把"batch 里第 i 个 token"映射到"输出缓冲区的第 j 行":

```cpp
for (int64_t i = 0; i < n_outputs; ++i) {
    int64_t out_id = out_ids[i];
    output_ids[out_id] = i;
}
```

调用方通过 `llama_get_logits_ith(ctx, -1)` 取 logits。`-1` 由 `output_resolve_row` 翻译成 `n_outputs + (-1) = 0`,即第 0 行(`src/llama-context.cpp:801`):

```cpp
if (i < 0) {
    j = n_outputs + i;   // -1 → n_outputs - 1,对于 n_outputs==1 就是 0
}
```

最终返回 `logits.data + j * n_vocab`,正好指向那唯一一行 float(`src/llama-context.cpp:834`)。

**机制三:异步拷贝 + 延迟同步**

实际的数据拷贝在 `process_ubatch` 末尾,用的是异步接口(`src/llama-context.cpp:1831`):

```cpp
ggml_backend_tensor_get_async(backend_res, t_logits, logits_out,
                               0, n_outputs*n_vocab*sizeof(float));
```

`_async` 的意思是:把"拷贝"这个操作加入后端的命令队列,不立刻等待完成。真正的同步发生在 `llama_context::get_logits_ith`(或 `get_logits`)第一次被调用时,通过 `output_reorder()`(如有必要)以及调用链里的 `llama_synchronize` 完成。这样在采样器真正要读数据之前,GPU 还在跑下一个算子,主机端可以做别的事。

整体数据流如下:

<svg viewBox="0 0 640 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Logits data flow: from backend buffer through async copy to host pointer returned by get_logits_ith">
  <defs>
    <marker id="t14ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="380" fill="#f8fafc" rx="6"/>
  <rect x="80" y="16" width="480" height="72" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">后端 buffer (GPU/CPU 显存)</text>
  <text x="320" y="50" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">t_logits 张量  [n_outputs × n_vocab]</text>
  <text x="320" y="66" text-anchor="middle" font-size="10" fill="#64748b">row 0: last_token_logits[0 .. n_vocab-1]  (prefill 时 n_outputs=1)</text>
  <text x="320" y="80" text-anchor="middle" font-size="9" fill="#94a3b8">n_vocab ≈ 151936 (Qwen2.5-0.5B)</text>
  <line x1="320" y1="88" x2="320" y2="120" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,2" marker-end="url(#t14ar1)"/>
  <rect x="200" y="108" width="240" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="124" text-anchor="middle" font-size="10" fill="#64748b">ggml_backend_tensor_get_async</text>
  <text x="460" y="116" font-size="9" fill="#94a3b8">异步拷贝</text>
  <line x1="320" y1="132" x2="320" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar1)"/>
  <rect x="80" y="160" width="480" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="178" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ctx→logits.data  (host-side float[])</text>
  <text x="320" y="196" text-anchor="middle" font-size="10" fill="#64748b">[ 0×n_vocab .. 1×n_vocab-1 ]   连续 float 数组</text>
  <text x="320" y="210" text-anchor="middle" font-size="9" fill="#94a3b8">src/llama-context.cpp:1821-1831  (process_ubatch 末尾)</text>
  <line x1="320" y1="220" x2="320" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar1)"/>
  <rect x="180" y="240" width="280" height="32" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="254" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">get_logits_ith(ctx, -1)</text>
  <text x="320" y="266" text-anchor="middle" font-size="9" fill="#64748b">output_resolve_row(-1) → j = n_outputs + (-1) = 0</text>
  <line x1="320" y1="272" x2="320" y2="300" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar1)"/>
  <rect x="100" y="300" width="440" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="320" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">返回指针: logits.data + 0 × n_vocab</text>
  <text x="320" y="338" text-anchor="middle" font-size="10" fill="#64748b">float[n_vocab] — 词表上每个 token 的原始 logit</text>
  <text x="320" y="354" text-anchor="middle" font-size="9" fill="#94a3b8">尚未经过 softmax;采样器在步骤 15 处理</text>
</svg>
<span class="figure-caption">图 T14.1 ｜ logits 数据流：后端 buffer 异步拷贝到 host，output_ids 映射负索引到行号，返回 float 指针</span>

<details>
<summary>ASCII 原版</summary>

```
后端 buffer (GPU/CPU)
  t_logits 张量
  [ row0: last_token_logits[0..n_vocab-1] ]
             |
             | ggml_backend_tensor_get_async
             v
  ctx->logits.data (host-side float 数组)
  [ 0*n_vocab .. 1*n_vocab-1 ]
             |
             | get_logits_ith(ctx, -1)
             | output_resolve_row(-1) -> j=0
             v
  返回指针: logits.data + 0*n_vocab
```

</details>

## 6. 代码位置

按阅读顺序:

- `examples/simple/simple.cpp:149` —— `llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size())`;`logits` 字段未设,默认 `nullptr`
- `examples/simple/simple.cpp:173` —— `llama_decode(ctx, batch)` 调用点
- `src/llama-batch.cpp:120`-`130` —— `llama_batch_allocr::init` 中默认只标记最后一个位置为 output
- `src/llama-batch.cpp:155`-`157` —— 统计 `n_outputs`
- `src/llama-context.cpp:1668` —— `n_outputs_all = balloc->get_n_outputs()`
- `src/llama-context.cpp:1821`-`1831` —— `ggml_backend_tensor_get_async` 异步拷贝 logits
- `src/llama-context.cpp:1931`-`1944` —— `n_outputs = n_outputs_all`;建立 `output_ids` 映射
- `src/llama-context.cpp:796`-`823` —— `output_resolve_row`:负索引到行号的翻译
- `src/llama-context.cpp:825`-`843` —— `llama_context::get_logits_ith`:先 `output_reorder`,再返回指针
- `include/llama.h:995`-`999` —— `llama_get_logits_ith` 公共 API 声明及注释

## 7. 分支与延伸

- `llama_batch` 结构、`batch.logits` 字段的含义、`llama_batch_get_one` 与 `llama_batch_init` 的区别 → [第 7 章 上下文与批处理](07-context-and-batching.md)
- 如何让 prefill 阶段输出**所有**位置的 logits(用于教师强迫训练或 perplexity 评估):手动把 `batch.logits[i]` 全置 1,此时 `n_outputs == n_tokens` → [第 7 章](07-context-and-batching.md)
- `llama_context::output_reorder`:当 ubatch 是乱序时,如何用选择排序把输出行重新对齐到 batch 原始顺序 → [第 7 章](07-context-and-batching.md)
- 后端异步拷贝(`ggml_backend_tensor_get_async`)与显式同步(`llama_synchronize`)的关系 → [第 9 章 GGML 后端系统](09-ggml-backend.md)
- 当后端采样器(GPU-side greedy)启用时,logits 不走 `logits.data` 这条路,而是通过 `sampling.logits` 另一个缓冲取回 → [第 10 章 采样与 token 生成](10-sampling.md)

## 8. 走完这一步你脑子里应该多了什么

1. **prefill 默认只产一行 logits**:框架在 `llama_batch_get_one` 返回的 batch 上自动把最后一个 token 以外的所有位置标记为 `output=false`,输出缓冲区只分配 `1 × n_vocab` 个 float,不浪费。
2. **`output_ids` 是 batch 下标到缓冲区行号的间接映射**:它的存在让调用方可以用 batch 里的位置索引(包括负数)取 logits,而不用关心缓冲区内部排列。
3. **`-1` 是"最后一个输出"的惯用写法**:对于 `n_outputs==1` 的解码轮次,`idx=-1` 等价于 `idx=0`,两种写法都合法。
4. **拷贝是异步的,同步发生在首次读取时**:后端可以利用这个窗口继续执行其他任务,不用在计算结束后立刻阻塞。
5. 此刻 `ctx->logits.data` 里是一个长度为 `n_vocab` 的 float 数组,每个元素是一个原始 logit 值,还没有经过 softmax——采样器会在下一步处理它。

下一步:[步骤 15 —— 采样下一个 token](tour-15-sample.md)。
