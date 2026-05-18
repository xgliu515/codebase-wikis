# Trace 步骤 13 —— 一张计算图怎么跑到 CPU 和 GPU 上?

## 1. 当前情境

步骤 12 结束后,`process_ubatch` 已经完成了:

- `model.build_graph(gparams)` —— 返回一张 `ggml_cgraph *gf`,节点数约为 `n_layer × 算子数 / 层 + 头尾`
- `ggml_backend_sched_alloc_graph(sched, gf)` —— 为图上每个张量分配了显存/内存
- `res->set_inputs(&ubatch)` —— 把 token id、位置、KQ mask 写入叶子张量

现在 `gf` 里每个节点都知道自己的形状,所有叶子的数据已经就位,但所有中间张量(Q、K、V、注意力输出、FFN 输出……)还是空的。

紧接着,`src/llama-context.cpp:1296` 调用:

```cpp
const auto status = graph_compute(res->get_gf(), ubatch.n_tokens > 1);
```

这一行触发整个前向计算。

---

## 2. 问题

一台装了 GPU 的机器上,模型权重的大部分层在 GPU 显存里(`-ngl` 参数决定几层上 GPU),嵌入表和最后几层可能还在 CPU 内存里。`gf` 里的节点混合指向这两种内存——矩阵乘节点的权重在 GPU,但输入 token id 在 CPU 上。

核心问题:**如何把一张"节点指向不同设备"的计算图正确地分片执行,在需要时自动把张量数据从一个设备搬到另一个设备,而上层代码完全不需要感知设备边界?**

---

## 3. 朴素思路

最直接的做法:图构建时就确定每个节点在哪个设备,执行时按拓扑顺序逐节点调度——如果节点在 GPU,就把它的所有输入先手动 `memcpy` 到 GPU,再调用 GPU kernel。

---

## 4. 为什么朴素思路会崩

- **拷贝发生的时机难以优化**:朴素方案在每个节点执行前都同步等待拷贝完成。但很多情况下,前一个 CPU 节点和后一个 GPU 节点可以**流水线**执行——CPU 算完之后立刻发出异步拷贝,GPU 只需等拷贝完就能启动,不需要 CPU 一直阻塞。朴素方案做不到这点。
- **切分粒度不合理**:若为每个跨设备的张量都单独拷贝,PCIe 带宽会被大量小拷贝打碎。把连续在同一设备执行的节点打包成一个"子图",只在子图边界做拷贝,才能批量利用 DMA。
- **算子路由逻辑侵入图构建**:如果"这个节点该去哪个设备"的逻辑分散在每个 `build_attn`、`build_ffn` 里,架构代码会被设备感知逻辑污染。

---

## 5. llama.cpp 的做法

llama.cpp 把设备调度完全封装在 `ggml_backend_sched`(后端调度器)里,对上层完全透明。`graph_compute` 只是一个薄封装:

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="graph_compute dispatch flow: split graph into per-backend sub-graphs, copy tensors across devices, execute async">
  <defs>
    <marker id="t13ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="480" fill="#f8fafc" rx="6"/>
  <rect x="220" y="12" width="320" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">graph_compute(gf, batched)</text>
  <text x="380" y="42" text-anchor="middle" font-size="10" fill="#64748b">src/llama-context.cpp:2294</text>
  <line x1="380" y1="48" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar1)"/>
  <rect x="180" y="68" width="400" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="82" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ggml_backend_sched_graph_compute_async(sched, gf)</text>
  <text x="380" y="94" text-anchor="middle" font-size="9" fill="#94a3b8">ggml/src/ggml-backend.cpp:1889</text>
  <line x1="380" y1="100" x2="380" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar1)"/>
  <rect x="180" y="120" width="400" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="134" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ggml_backend_sched_compute_splits(sched)</text>
  <text x="380" y="146" text-anchor="middle" font-size="9" fill="#94a3b8">遍历 sched→splits[0..n_splits)</text>
  <line x1="380" y1="152" x2="380" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar1)"/>
  <rect x="100" y="172" width="560" height="176" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="380" y="192" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">for each split (连续同设备子图)</text>
  <rect x="115" y="200" width="250" height="60" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="240" y="218" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">跨设备输入拷贝</text>
  <text x="240" y="234" text-anchor="middle" font-size="9" fill="#64748b">input_backend ≠ split_backend?</text>
  <text x="240" y="248" text-anchor="middle" font-size="9" fill="#64748b">→ tensor_copy / cpy_tensor_async</text>
  <text x="240" y="260" text-anchor="middle" font-size="9" fill="#94a3b8">(GPU peer-to-peer 或 PCIe)</text>
  <rect x="395" y="200" width="250" height="60" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="520" y="218" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">执行子图 (异步)</text>
  <text x="520" y="234" text-anchor="middle" font-size="9" fill="#64748b">CPU → 线程池 + SIMD</text>
  <text x="520" y="248" text-anchor="middle" font-size="9" fill="#64748b">Metal → command buffer</text>
  <text x="520" y="260" text-anchor="middle" font-size="9" fill="#64748b">CUDA → CUDA stream</text>
  <text x="380" y="292" text-anchor="middle" font-size="9" fill="#94a3b8">ggml_backend_graph_compute_async(split_backend, &amp;split→graph)</text>
  <text x="380" y="308" text-anchor="middle" font-size="9" fill="#94a3b8">可选: callback_eval 逐节点回调(调试/性能分析)</text>
  <text x="380" y="324" text-anchor="middle" font-size="9" fill="#94a3b8">return GGML_STATUS_SUCCESS</text>
  <text x="380" y="340" text-anchor="middle" font-size="9" fill="#94a3b8">ggml/src/ggml-backend.cpp:1541  |  split_graph pass 5: 切分点插"影子张量"</text>
  <line x1="380" y1="348" x2="380" y2="368" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar1)"/>
  <rect x="180" y="368" width="400" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="382" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ggml_backend_sched_synchronize(sched)</text>
  <text x="380" y="394" text-anchor="middle" font-size="9" fill="#94a3b8">阻塞直到所有后端命令完成</text>
  <line x1="380" y1="400" x2="380" y2="420" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t13ar1)"/>
  <rect x="200" y="420" width="360" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="438" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">所有张量计算完毕</text>
  <text x="380" y="454" text-anchor="middle" font-size="10" fill="#64748b">logits 张量 t_logits 已有真实数值  (异步拷回 CPU)</text>
  <text x="380" y="468" text-anchor="middle" font-size="9" fill="#94a3b8">ggml_backend_tensor_get_async → ctx→logits.data</text>
</svg>
<span class="figure-caption">图 T13.1 ｜ graph_compute 后端调度流程：子图分片 → 跨设备拷贝 → 异步执行 → 同步等待</span>

<details>
<summary>ASCII 原版</summary>

```
graph_compute(gf, batched=true)
    [src/llama-context.cpp:2294]
    |
    +-- 设置各后端线程数
    |
    +-- ggml_backend_sched_graph_compute_async(sched, gf)
        [ggml/src/ggml-backend.cpp:1889]
        |
        +-- (若未 alloc) ggml_backend_sched_alloc_graph(sched, gf)
        |
        +-- ggml_backend_sched_compute_splits(sched)
            [ggml/src/ggml-backend.cpp:1541]
            |
            for split_id in 0 .. sched->n_splits:
              split = sched->splits[split_id]
              split_backend = sched->backends[split.backend_id]
              |
              +-- [跨设备拷贝] for each input in split.inputs[]:
              |     input_backend != split_backend?
              |       -> ggml_backend_tensor_copy(input, input_cpy)
              |          或 cpy_tensor_async (GPU 侧 peer-to-peer)
              |
              +-- [执行子图] ggml_backend_graph_compute_async(split_backend, &split->graph)
              |     CPU backend  -> 线程池 + SIMD 算子
              |     Metal backend -> Metal command buffer (GPU)
              |     CUDA backend  -> CUDA stream (GPU)
              |
              +-- (可选) callback_eval 逐节点回调(调试/性能分析用)
            |
            return GGML_STATUS_SUCCESS
        |
    +-- (sync 版本) ggml_backend_sched_synchronize(sched)
        等待所有后端的异步命令完成
```

</details>

**第一阶段:图的分片(split_graph)**

`ggml_backend_sched_alloc_graph` 内部调用 `ggml_backend_sched_split_graph`(`ggml/src/ggml-backend.cpp:1014`)。它对图做 5 遍扫描:

| 遍 | 作用 |
|----|------|
| pass 1 | 把已预分配内存的张量(权重、KV 缓存)的后端 id 打到节点上 |
| pass 2 | 向前/向后扩展,让相邻节点尽量与已知节点同一后端 |
| pass 3 | 把节点升级到更高优先级后端(如 CPU 节点可升 GPU) |
| pass 4 | 用 `view_src` 和 `dst` 传播后端 id |
| pass 5 | 线性扫描,遇到后端切换就切一刀,切出 `split` 子图;若切口两侧同一张量,自动插入一个"影子张量"(`tensor_copy`)作为拷贝目标 |

每个 `split` 是 `struct ggml_backend_sched_split`(`ggml/src/ggml-backend.cpp:764`):

```text
struct ggml_backend_sched_split {
    int backend_id;        // 这段子图跑在哪个后端
    int i_start, i_end;    // gf->nodes[i_start..i_end) 构成本子图
    ggml_tensor * inputs[GGML_SCHED_MAX_SPLIT_INPUTS]; // 跨设备输入
    int n_inputs;
    struct ggml_cgraph graph;  // gf 的子视图
};
```

**第二阶段:执行(compute_splits)**

对每个 split,调度器先把跨设备的输入张量拷贝到 split 的目标后端(`ggml/src/ggml-backend.cpp:1555-1674`),然后调用 `ggml_backend_graph_compute_async(split_backend, &split->graph)`(`ggml/src/ggml-backend.cpp:1678`)。这个调用通过后端的 `iface.graph_compute` 函数指针派发到具体实现:

- **CPU 后端**:用 `ggml_threadpool` 并发执行节点,SIMD(AVX2 / NEON)加速 `GGML_OP_MUL_MAT`
- **Metal 后端**:把子图编译成 Metal command buffer,提交给 GPU 异步执行
- **CUDA 后端**:把子图编码进 CUDA graph,在 CUDA stream 上提交

**量化权重的按需反量化**

模型权重以量化格式(`Q4_K_M`、`Q8_0` 等)存储。当 `GGML_OP_MUL_MAT` 的一个操作数是量化张量时,GGML 的 matmul kernel 直接接受量化数据——在 CPU 上用 AVX2/NEON 的 dot product 一边反量化一边累加(`src[0]` 是量化权重时不需要先 dequant 到 F32 再乘,而是在 kernel 内部联合处理)。GPU 上(Metal / CUDA)有对应的 shader/kernel 实现相同的"融合 dequant-matmul"。因此不存在单独的"反量化步骤",反量化融合在 matmul 的每次乘累加里。

**异步执行与最终同步**

`graph_compute_async` 仅把命令提交到设备队列,不等待完成。`process_ubatch` 在调用链末尾通过 `ggml_backend_sched_synchronize`(或在 logits 拷贝时隐式触发)等待所有后端完成(`ggml/src/ggml-backend.cpp:1904`)。同步后,输出张量(logits 张量 `t_logits`)中已有真实数值。

---

## 6. 代码位置

按阅读顺序:

- `graph_compute` 薄封装:`src/llama-context.cpp:2294`
- 实际调用点:`src/llama-context.cpp:2313` — `ggml_backend_sched_graph_compute_async`
- `ggml_backend_sched_graph_compute_async`:`ggml/src/ggml-backend.cpp:1889`
- 同步版本:`ggml/src/ggml-backend.cpp:1883` — `ggml_backend_sched_graph_compute`
- `ggml_backend_sched_compute_splits`:`ggml/src/ggml-backend.cpp:1541`
  - 跨设备输入拷贝:`ggml/src/ggml-backend.cpp:1554-1674`
  - 子图执行:`ggml/src/ggml-backend.cpp:1678` — `ggml_backend_graph_compute_async`
- `ggml_backend_sched_split_graph`:`ggml/src/ggml-backend.cpp:1014`
  - pass 1(权重分配):`ggml/src/ggml-backend.cpp:1035`
  - pass 5(切分 + 插影子):`ggml/src/ggml-backend.cpp:1245`
- `struct ggml_backend_sched_split`:`ggml/src/ggml-backend.cpp:764`
- `struct ggml_backend_sched`:`ggml/src/ggml-backend.cpp:774`
- `ggml_backend_sched_alloc_graph`:`ggml/src/ggml-backend.cpp:1864`
- 同步:`ggml/src/ggml-backend.cpp:1904` — `ggml_backend_sched_synchronize`
- logits 异步拷回:`src/llama-context.cpp:1831` — `ggml_backend_tensor_get_async`

---

## 7. 分支与延伸

- `ggml_backend` / `ggml_backend_buffer_type` / `ggml_backend_buffer` 三层抽象的完整定义 → [第 9 章 GGML 后端系统](09-ggml-backend.md)
- `ggml_cgraph` 节点遍历顺序、拓扑排序、`ggml_build_forward_expand` → [第 4 章 GGML 张量与计算图](04-ggml-tensor-and-graph.md)
- `gallocr`(graph allocator)如何在 reserve 阶段计算显存峰值并复用 → [第 9 章 §内存分配器](09-ggml-backend.md)
- 量化格式(`Q4_K`、`Q8_0`)的位存储结构与 matmul kernel 里融合反量化的实现细节 → [第 4 章 §量化类型](04-ggml-tensor-and-graph.md)
- Pipeline Parallelism(流水线并行)如何利用 n_copies 和 event 机制让多个子图交叠执行 → [第 9 章 §流水线并行](09-ggml-backend.md)
- 执行完毕后 logits 如何被读回供采样器使用 → [步骤 14 取出 logits](tour-14-logits.md)

---

## 8. 走完这一步你脑子里应该多了什么

1. **`ggml_backend_sched` 是设备感知的唯一层**:图构建(步骤 12)完全不关心哪个节点跑哪个设备;设备分配、子图切分、跨设备拷贝全部封装在调度器里,上层代码只需调用一个函数。
2. **split 是调度的基本单元**:调度器把图切成若干连续子图,每个子图绑定一个后端。子图之间的数据依赖用"影子张量"桥接——影子张量在目标后端上有自己的内存副本,拷贝在执行前自动发生。
3. **量化 matmul 是融合的**:CPU/GPU 的 matmul kernel 直接消费量化权重,在 dot product 内部联合完成反量化与累加,不存在"先整体 dequant 再乘"的额外步骤——这是量化推理高效的关键原因之一。
4. **执行是异步的,同步是显式的**:`graph_compute_async` 把命令推进设备队列即返回;`synchronize` 才真正阻塞直到所有设备完成。logits 的 `tensor_get_async` 同样是异步的,随后的 `synchronize` 使数据可读。
5. **prefill(n_tokens > 1)使用批量线程池**:`graph_compute` 里 `batched = (n_tokens > 1)`,决定使用 `threadpool_batch`(更多线程)还是 `threadpool`(更少线程),这是 CPU 推理中 prefill 和 decode 吞吐差异的直接原因之一。

下一步:[步骤 14 —— 取出 logits](tour-14-logits.md)。
