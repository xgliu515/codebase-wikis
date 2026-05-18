# Trace 步骤 04 —— 剩下的显存，能放下多少 token 的 KV？

## 1. 当前情境

上一步模型权重已经搬上 GPU，`ModelRunner` 测出了权重 + 框架开销吃掉的显存。现在 `ModelRunner.__init__` 走到 `init_memory_pool`（在 `model_runner.py:741` 被调用）。GPU 上还剩一块空闲显存，这一步要决定：拿这块空闲显存建多大的 KV cache 池。

## 2. 问题

KV cache 是推理时最吃显存的东西：每个请求每生成一个 token，都要在每一层存下这个 token 的 Key 和 Value 张量，供后续 token 的注意力计算复用。问题是：

- KV 池要**一次性预分配**——运行中临时申请显存会引入碎片和不确定延迟；
- 池子开多大要恰到好处：开太小，能同时处理的请求数 / 上下文长度就上不去；开太大，前向计算的中间激活值没地方放，一跑就 OOM；
- 「剩多少显存」不是个固定数——它取决于 GPU 型号、模型大小、有没有别的进程在占卡。

这一步本质是一个**定容决策**（sizing decision）：算出一个数字 `max_total_num_tokens`——整个引擎在任意时刻最多能为多少个 token 保存 KV。

## 3. 朴素思路

查一下 GPU 总显存（比如 24 GB），减去权重大小（2.5 GB），剩下的 21.5 GB 全拿来当 KV 池。显存利用率拉满，听起来很划算。

## 4. 为什么朴素思路会崩

「剩下的全给 KV」会崩，因为它忘了 KV cache **不是前向时唯一要占显存的东西**：

- **中间激活值**：跑一次前向，每一层的 hidden state、注意力分数、MLP 中间结果都要临时显存。batch 越大、prompt 越长，激活值越多。
- **CUDA graph 的内存池**：下一步要捕获 CUDA graph，graph 会固定占一块显存。
- **通信缓冲、框架杂项**：NCCL buffer、PyTorch 的 caching allocator 碎片等。

如果 KV 池把这些的空间也吞了，那么**第一次跑一个稍大的 batch 就 OOM**——而且是运行时才崩，请求已经收进来了，体验极差。更隐蔽的是显存碎片：KV 池占满后，激活值想要一块连续显存却找不到。

所以不能「按理论剩余量分」，得**留出余量**，而且这个余量要可调。

## 5. SGLang 的做法

SGLang 用一个参数把「留多少余量」交给用户控制——`mem_fraction_static`（`model_runner.py:333`、`:353`）。它的语义是：**静态显存（权重 + KV 池）最多占 GPU 显存的这个比例**，剩下的留给激活值、CUDA graph 等动态开销。

定容流程大致是：

<svg viewBox="0 0 600 386" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache pool sizing computation flow">
<defs>
<marker id="t4ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="180" y="14" width="240" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
<text x="300" y="37" text-anchor="middle" font-size="12" fill="currentColor">GPU 总显存</text>
<line x1="300" y1="50" x2="300" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
<text x="312" y="68" font-size="10" fill="#ea580c">× mem_fraction_static</text>
<rect x="160" y="80" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="300" y="103" text-anchor="middle" font-size="12" fill="currentColor">静态预算 − 权重占用 = KV 池可用显存</text>
<line x1="300" y1="116" x2="300" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
<text x="312" y="134" font-size="10" fill="#ea580c">÷ 每 token 每层 KV 字节数</text>
<rect x="150" y="146" width="300" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="300" y="167" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">max_total_num_tokens</text>
<text x="300" y="184" text-anchor="middle" font-size="10" fill="#64748b">引擎的硬容量上限：能放多少 token 的 KV</text>
<line x1="300" y1="190" x2="300" y2="206" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="170" y1="206" x2="430" y2="206" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="170" y1="206" x2="170" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
<line x1="430" y1="206" x2="430" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t4ar)"/>
<rect x="50" y="250" width="240" height="86" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="170" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">ReqToTokenPool</text>
<text x="170" y="298" text-anchor="middle" font-size="10" fill="#64748b">请求 token → KV 物理索引</text>
<text x="170" y="318" text-anchor="middle" font-size="10" fill="#64748b">的映射表</text>
<rect x="310" y="250" width="240" height="86" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.3"/>
<text x="430" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">token-to-KV 池</text>
<text x="430" y="298" text-anchor="middle" font-size="10" fill="#64748b">真正存每层每 token 的</text>
<text x="430" y="318" text-anchor="middle" font-size="10" fill="#64748b">K/V 张量（分页）</text>
</svg>
<span class="figure-caption">图 T4.1 ｜ KV 池定容：从 GPU 总显存一路算到 max_total_num_tokens，再分配映射表与存储池</span>

<details>
<summary>ASCII 原版</summary>

```text
  GPU 总显存  ──┐
                │ × mem_fraction_static     -> 静态预算
                ▼
        静态预算 - 权重占用 = KV 池可用显存
                │
                │ ÷ (每个 token 的 KV 字节数)
                ▼
        max_total_num_tokens  (池子能放多少 token)
                │
   ┌────────────┴─────────────┐
   ▼                          ▼
 ReqToTokenPool          token-to-KV 池
 (请求 -> token 槽位)    (每层每 token 的 K/V 张量)
```

</details>

「每个 token 的 KV 字节数」由模型结构定死：`层数 × 2(K和V) × num_kv_heads × head_dim × dtype字节数`。拿 KV 池可用显存除以它，就得到 `max_total_num_tokens`。

算出来之后 `init_memory_pool` 分配两样东西：

- **`ReqToTokenPool`**（`python/sglang/srt/mem_cache/memory_pool.py`）：一张映射表，记录「第 i 个请求的第 j 个 token」用的是 KV 池里哪个槽位；
- **token-to-KV 池 + 分配器**（`python/sglang/srt/mem_cache/allocator.py:35` 的 `BaseTokenToKVPoolAllocator`）：真正存 K/V 张量的大块显存，按 **page**（页）粒度分配——`page_size` 个 token 为一页，和操作系统的分页内存是同一个思想。

这两样都是**启动时一次性建好、运行中永不 resize** 的。从这一刻起，引擎清楚地知道自己的「容量上限」是 `max_total_num_tokens` 个 token，调度器之后所有的「能不能再收一个请求」判断都基于这个数。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/model_executor/model_runner.py:333`、`:353` —— `mem_fraction_static` 参数的接收与保存。
- `model_runner.py:741` —— `init_memory_pool` 的调用点（注意它在 CUDA graph 捕获之前）。
- `python/sglang/srt/mem_cache/memory_pool.py` —— `ReqToTokenPool` 与 token-to-KV 池的定义。
- `python/sglang/srt/mem_cache/allocator.py:35` —— `BaseTokenToKVPoolAllocator`，分页分配器的抽象基类；`:121` 的 `TokenToKVPoolAllocator` 是具体实现。
- `model_runner.py:2122-2124` —— `max_total_num_tokens` 的读取点。

## 7. 分支与延伸

- KV 池的物理布局、分配器的 page 粒度分配细节 → [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md)
- `max_total_num_tokens` 怎么被调度器用来判断「还能不能收请求」→ [第 08 章 调度器与连续批处理](08-scheduler.md)
- HiCache 把一部分 KV 放到主机内存、突破单卡显存上限 → [第 07 章 §HiCache](07-kv-cache-memory.md)
- 已经算好 KV 的前缀怎么被复用、而不是重新占池子 → [步骤 10](tour-10-match-prefix.md)、[第 06 章](06-radix-cache.md)

## 8. 走完这一步你脑子里应该多了什么

1. KV cache 池是**启动时一次性预分配、运行中永不 resize** 的——这是为了避免运行时显存碎片和不确定延迟。
2. 池子大小不是「剩多少给多少」，而是 `mem_fraction_static` 划出的静态预算减去权重——必须给激活值、CUDA graph 留余量，否则运行时 OOM。
3. 定容的产物是一个数字 `max_total_num_tokens`，它是整个引擎的「容量上限」，调度器的收请求决策全基于它。
4. KV 显存按 **page** 粒度管理（`page_size` 个 token 一页），`ReqToTokenPool` 负责「请求 token → KV 槽位」的映射。
