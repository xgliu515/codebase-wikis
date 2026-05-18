# Trace 步骤 07 —— 为什么 init 时要跑一遍"假的"计算图?

## 1. 当前情境

步骤 05 和步骤 06 分别完成了后端实例化和 KV 缓存分配。此时 `llama_context::sched_reserve()` 被调用(`src/llama-context.cpp:371`)——这是构造函数的最后一个主要动作。

`sched_reserve` 的职责用一句话说:用"最大可能的 batch"构造一遍计算图,让调度器和图分配器量出所有中间张量的显存峰值,然后把那块显存实际分配好——在任何真实的 decode 发生之前。

## 2. 问题

transformer 的前向计算会产生大量中间张量:每一层的 Q/K/V 投影、attention score 矩阵、FFN 的两个中间激活……它们的大小都与"这次处理了多少 token"成正比。一个 n_ubatch = 512 的 batch 和 n_ubatch = 1 的 decode 步骤,中间张量的峰值内存差距可以是几十倍。

问题是:**在第一次 decode 之前,调度器 (scheduler) 需要在每个后端上持有一块足够大的计算缓冲。"足够大"是多大?**

没有一个公式可以不构造计算图就算出来——图的每个节点形状、相邻节点之间的复用关系、跨设备的拷贝算子数量,这些都只有在真正拼出 `ggml_cgraph` 之后才能知道。

## 3. 朴素思路

第一次 decode 时,按 batch 大小动态构造计算图,让调度器按需分配缓冲——用到什么尺寸就分配什么尺寸,类似"按需延迟分配"。

## 4. 为什么朴素思路会崩

- **第一次推理会触发 GPU 内存分配,造成不可预测的延迟**。在推理服务的场景下,首次 decode 的延迟往往有 SLA 约束;如果它包含了一次 GPU 缓冲分配(可能涉及驱动层的页面锁定、地址空间建立),延迟会不稳定且难以排查。
- **显存不足只有到运行时才能发现**。4 GB 显卡跑 32k 上下文的大模型时,单是计算缓冲就可能耗尽显存。不 reserve 就不知道行不行——应该在 `llama_init_from_model` 时就报告失败,而不是在第一次推理时崩溃。
- **多次 decode 的 batch 大小各不相同,但计算图拓扑不变**。prefill 时 batch = n_prompt,decode 时 batch = 1。如果每种尺寸都懒加载,就会出现两次分配;但如果第一次 reserve 按最大尺寸做了,后续所有尺寸都能复用同一块缓冲,不需要再分配。
- **图拓扑变化(比如开关 Flash Attention、换 LoRA)需要重新 reserve**。如果从来没有做过 reserve,代码就无法判断"当前 sched 对应的图拓扑是否与即将执行的图一致",每次 decode 都需要重新分配。

## 5. llama.cpp 的做法

`sched_reserve`(`src/llama-context.cpp:411`-`652`)分以下几个动作:

**A. 创建 ggml_backend_sched**(`src/llama-context.cpp:434`)。

```cpp
sched.reset(ggml_backend_sched_new(
    backend_ptrs.data(), backend_buft.data(),
    backend_ptrs.size(), max_nodes,
    cparams.pipeline_parallel, cparams.op_offload));
```

`ggml_backend_sched_new`(`ggml/include/ggml-backend.h:317`)创建一个调度器实例,持有:
- 所有后端的指针列表(优先级从高到低:GPU0、GPU1、CPU);
- 每个后端对应的 buffer type;
- 一个内部的 `ggml_gallocr`(图分配器),负责把图节点的中间张量分配到对应后端的 buffer 里。

**B. 初始化"满缓存"的 memory context**(`src/llama-context.cpp:436`-`443`)。

```cpp
mctx = memory->init_full();
```

`init_full()` 返回一个模拟"KV 缓存完全填满"状态的上下文对象——这是对 reserve 图来说最大的 KV 输入尺寸。用真实的空缓存跑 reserve 会让注意力 mask 矩阵退化成极小形状,低估显存峰值。

**C. dry-run 构建计算图**。`sched_reserve` 对 pp(prefill)和 tg(token generation)两种场景各调用一次 `graph_reserve`(`src/llama-context.cpp:582`-`621`):

```text
sched_reserve()
├── graph_reserve(n_tokens=n_ubatch, n_seqs, n_outputs=n_ubatch, mctx)  # pp
├── graph_reserve(n_tokens=n_seqs,   n_seqs, n_outputs=n_seqs,  mctx)  # tg
└── graph_reserve(n_tokens=n_ubatch, n_seqs, n_outputs=n_ubatch, mctx)  # pp 再跑一遍
                                                                           确保缓冲按最大 pp 图固化
```

`graph_reserve`(`src/llama-context.cpp:2209`-`2268`)的工作:

1. 用 `balloc.ubatch_reserve(n_tokens/n_seqs, n_seqs)` 构造一个"假" ubatch——不含真实 token 数据,只有正确的形状。
2. 调 `model.build_graph(gparams)` 拼出完整的 `ggml_cgraph`。
3. 调 `ggml_backend_sched_reserve(sched, gf)` 让调度器把这张图"走一遍":
   - **split**:按 tensor 的设备归属把图切成多个 split(子图),每个 split 分配给一个后端;
   - **gallocr reserve**:对每个 split,`ggml_gallocr_reserve`(`ggml/src/ggml-alloc.c:965`)遍历节点,用一个"动态区间分配器"(`ggml_dyn_tallocr`)模拟内存分配,记录每个节点的 buffer_id 和地址偏移,得到峰值所需字节数;
   - **实际分配**:如果当前 buffer 小于峰值,在对应后端上 `ggml_backend_buft_alloc_buffer` 分配新缓冲(`ggml/src/ggml-alloc.c:938`)。

整个流程没有任何真实的张量计算——图只是被"遍历了一遍来测量",没有调用后端的 compute kernel。

用 ASCII 图示意 reserve 阶段发生的事:

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="sched_reserve internal flow: build graph, split by device, gallocr virtual alloc, fix compute buffer">
  <defs>
    <marker id="ar7a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="520" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="200" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="116" y="33" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">model.build_graph()</text>
  <text x="116" y="50" text-anchor="middle" font-size="10" fill="#64748b">gparams (最大 ubatch)</text>
  <line x1="216" y1="36" x2="280" y2="36" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <rect x="280" y="14" width="460" height="80" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="510" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ggml_cgraph (pp 最大图)</text>
  <text x="510" y="54" text-anchor="middle" font-size="11" fill="#64748b">node[0]: embd  node[1]: attn_q[0]</text>
  <text x="510" y="70" text-anchor="middle" font-size="11" fill="#64748b">…  node[N]: logits</text>
  <text x="510" y="86" text-anchor="middle" font-size="10" fill="#94a3b8">纯拓扑描述,无任何计算</text>
  <line x1="510" y1="94" x2="510" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="290" y="116" font-size="10" fill="#94a3b8">ggml_backend_sched_reserve(sched, gf)</text>
  <rect x="280" y="120" width="460" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="510" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">split — 按设备切分</text>
  <rect x="296" y="152" width="130" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="361" y="168" text-anchor="middle" font-size="11" fill="#64748b">split[0]</text>
  <text x="361" y="182" text-anchor="middle" font-size="10" fill="#94a3b8">GPU0 层 0-17</text>
  <rect x="436" y="152" width="130" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="501" y="168" text-anchor="middle" font-size="11" fill="#64748b">split[1]</text>
  <text x="501" y="182" text-anchor="middle" font-size="10" fill="#94a3b8">GPU1 层 18-27</text>
  <rect x="576" y="152" width="148" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="650" y="168" text-anchor="middle" font-size="11" fill="#64748b">split[2]</text>
  <text x="650" y="182" text-anchor="middle" font-size="10" fill="#94a3b8">CPU output</text>
  <line x1="510" y1="200" x2="510" y2="226" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="290" y="222" font-size="10" fill="#94a3b8">ggml_gallocr_reserve_n (每个 split)</text>
  <rect x="280" y="226" width="460" height="100" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="510" y="248" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">dyn_tallocr 虚拟模拟内存分配</text>
  <text x="510" y="268" text-anchor="middle" font-size="11" fill="#64748b">attn_q[l]: offset=0, 64 MB</text>
  <text x="510" y="284" text-anchor="middle" font-size="11" fill="#64748b">attn_k[l]: offset=64 MB …</text>
  <text x="510" y="300" text-anchor="middle" font-size="11" fill="#64748b">复用到期节点后释放区间</text>
  <text x="510" y="318" text-anchor="middle" font-size="10" fill="#94a3b8">峰值 = max(offset + size)  ← 无实际 GPU 分配</text>
  <line x1="510" y1="326" x2="510" y2="352" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7a)"/>
  <text x="290" y="348" font-size="10" fill="#94a3b8">若峰值 &gt; 当前 buffer: ggml_backend_buft_alloc_buffer(buft, peak)</text>
  <rect x="280" y="352" width="460" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="510" y="376" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">compute buffer 固化在每个后端</text>
  <text x="510" y="398" text-anchor="middle" font-size="11" fill="#64748b">METAL compute buffer = 128.00 MiB</text>
  <line x1="280" y1="420" x2="16" y2="420" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,2"/>
  <line x1="16" y1="420" x2="16" y2="460" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,2"/>
  <line x1="16" y1="460" x2="210" y2="460" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4,2" marker-end="url(#ar7a)"/>
  <rect x="210" y="440" width="320" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="370" y="462" text-anchor="middle" font-size="11" fill="#64748b">重复 pp → tg → pp 三次确保最大图固化</text>
  <text x="20" y="445" font-size="10" fill="#94a3b8">循环</text>
  <rect x="210" y="488" width="460" height="24" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="440" y="504" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">llama_context 完全就绪 ← sched_reserve 返回</text>
</svg>
<span class="figure-caption">图 T7.1 ｜ sched_reserve 内部流程:构图 → split 切分 → gallocr 虚拟模拟 → 固化 compute buffer</span>

<details>
<summary>ASCII 原版</summary>

```
sched_reserve() 内部:
                                    ┌──────────────────────────┐
model.build_graph(gparams)  ────>   │  ggml_cgraph (pp 最大图)  │
                                    │  node[0]: embd           │
                                    │  node[1]: attn_q[0]      │
                                    │  ...                     │
                                    │  node[N]: logits         │
                                    └─────────────┬────────────┘
                                                  │
                                    ggml_backend_sched_reserve(sched, gf)
                                                  │
                                    ┌─────────────▼────────────┐
                                    │   split:                  │
                                    │   split[0] -> GPU0 (层 0-17) │
                                    │   split[1] -> GPU1 (层 18-27)│
                                    │   split[2] -> CPU (output)   │
                                    └─────────────┬────────────┘
                                                  │
                                    ggml_gallocr_reserve_n (每个 split)
                                                  │
                                    ┌─────────────▼────────────┐
                                    │   dyn_tallocr 虚拟模拟:    │
                                    │   attn_q[l]: offset=0, 64MB│
                                    │   attn_k[l]: offset=64MB   │
                                    │   ...  (复用到期后释放)    │
                                    │   峰值 = max(offset+size)  │
                                    └─────────────┬────────────┘
                                                  │
                                    若峰值 > 当前 buffer 大小:
                                    ggml_backend_buft_alloc_buffer(buft, peak)
                                                  │
                                    compute buffer 固化在每个后端
```

</details>

`sched_reserve` 连续跑了三遍图:pp → tg → pp。原因是:tg 图(batch=1)的分法可能与 pp 不同(split 数不同),如果只跑 pp、然后只用 tg 做推理,sched 的 split 缓存会失配。跑完 tg 图之后再跑一遍 pp,保证最终 sched 的 buffer 大小以最大的 pp 图为准,tg 图永远是 pp 图的子集。

**D. 自动检测 Flash Attention 可用性**(`src/llama-context.cpp:451`-`489`)。在真正 reserve 之前还有一次 split-only dry-run:如果 `auto_fa` 为真,构造一个单 token 的图,检查 `GGML_OP_FLASH_ATTN_EXT` 节点被分派到哪个设备——如果 FA 算子和 KV 张量不在同一个设备,就禁用 FA,避免跨设备的注意力计算。

**E. 打印结果**。reserve 完成后打印每个后端的计算 buffer 大小(`src/llama-context.cpp:623`-`645`)——用户在终端看到的形如 `METAL compute buffer size = 128.00 MiB` 的行,就是这里打出来的。至此,`llama_context` 完全就绪。

## 6. 代码位置

按阅读顺序:

- sched_reserve 调用点:`src/llama-context.cpp:371` —— 构造函数末尾
- sched_reserve 实现:`src/llama-context.cpp:411`-`652`
- ggml_backend_sched_new:`ggml/include/ggml-backend.h:317` —— API 声明
- sched 创建:`src/llama-context.cpp:434` —— `ggml_backend_sched_new(...)`
- init_full 调用:`src/llama-context.cpp:436`-`443` —— 满缓存 memory context
- pp graph reserve:`src/llama-context.cpp:581`-`598`
- tg graph reserve:`src/llama-context.cpp:600`-`609`
- pp 再跑一遍:`src/llama-context.cpp:611`-`621`
- graph_reserve 实现:`src/llama-context.cpp:2209`-`2268` —— 构造假 ubatch + build_graph + sched_reserve
- ggml_backend_sched_reserve:`ggml/include/ggml-backend.h:322` —— API 声明
- gallocr_reserve_n_impl:`ggml/src/ggml-alloc.c:824`-`948` —— 核心:虚拟模拟 + 实际分配
- gallocr_alloc_graph_impl:`ggml/src/ggml-alloc.c:717` —— 遍历图节点做虚拟分配
- gallocr_reserve_n:`ggml/src/ggml-alloc.c:961`-`966` —— 公共入口
- 打印 buffer 大小:`src/llama-context.cpp:623`-`634`
- Flash Attention auto 检测:`src/llama-context.cpp:451`-`489`
- output_reserve:`src/llama-context.cpp:1991`-`2090` —— logits 输出 buffer 分配(步骤 05 阶段三)

## 7. 分支与延伸

- `ggml_gallocr` 的完整设计——`ggml_dyn_tallocr`(动态区间分配)、"inplace 重用"(一个节点的输出直接复用其某个输入的内存)以及多 buffer 分配 -> [第 4 章 GGML 张量与计算图](04-ggml-tensor-and-graph.md)
- `ggml_backend_sched` 如何决定每个节点该派给哪个后端——tensor 的 buft 优先规则、`GGML_BACKEND_DEVICE_TYPE_ACCEL` 的特殊处理 -> [第 9 章 GGML 后端系统](09-ggml-backend.md)
- `n_ubatch` 参数的选择对 reserve 后计算 buffer 大小的影响;`n_ubatch` 过大会浪费显存,过小会让 prefill 变慢 -> [第 7 章 上下文与批处理](07-context-and-batching.md)
- `sched_need_reserve` 标志:LoRA 切换、sampler 变更等操作会把它重置为 `true`,导致下次 decode 前触发重新 reserve(`src/llama-context.cpp:412`-`416`)-> [第 9 章](09-ggml-backend.md)
- pipeline parallelism:当 `n_devices > 1` 且模型按层分布时,`cparams.pipeline_parallel` 置真,sched 会启用异步流水线;`sched_reserve` 如果因 pipeline 导致 buffer 分配失败,会自动 fallback 关闭它重试(`src/llama-context.cpp:585`-`593`)-> [第 9 章](09-ggml-backend.md)
- `model.build_graph` 实际拼图的过程——embed、N 层注意力+FFN、输出 norm -> [第 4 章 GGML 张量与计算图](04-ggml-tensor-and-graph.md)、[步骤 12:构建本次的计算图](tour-12-graph-build.md)

## 8. 走完这一步你脑子里应该多了什么

1. **reserve 是一次"不执行计算的完整图遍历"**。`gallocr` 虚拟地把每个中间张量分配到一个线性 buffer 上,算出峰值,然后真正分配那块 GPU 内存——整个过程没有调用任何 compute kernel。
2. **reserve 必须用最大尺寸(n_ubatch × n_seqs)来做**。用小 batch reserve 会低估显存峰值;后续 prefill 的大 batch 就会触发 gallocr 重新分配,增加延迟且可能导致 OOM。
3. **pp 图和 tg 图各 reserve 一次,然后再跑一遍 pp**。这保证最终 compute buffer 以 pp 图(最大尺寸)为准,tg 图是 pp 的严格子集,不需要单独的缓冲。
4. **`ggml_backend_sched` 在 reserve 阶段完成两件事**:一是把图切 split(按设备分配算子);二是让 gallocr 量出每个 split 的显存峰值并分配。split 的结果缓存在 sched 里,后续 decode 只要图拓扑不变就直接复用,不重新 split。
5. **走完 sched_reserve,`llama_context` 完全就绪**:cparams 确定、后端实例就位、KV 张量分配完毕、计算缓冲固化。后续任何 `llama_decode` 调用只需要往 KV 缓存写数据、执行 scheduler 分发好的图,不会再有分配动作(除非切换 LoRA 等操作触发重新 reserve)。

下一步:[步骤 08 —— 初始化采样器链](tour-08-sampler-init.md)。
