# Trace 步骤 05 —— decode 一次只算一个 token，开销都花哪了？

## 1. 当前情境

上一步 KV cache 池已经建好，`max_total_num_tokens` 已确定。`ModelRunner` 初始化接近尾声，走到 CUDA graph 捕获——`init_cuda_graphs`，由 `CudaGraphRunner`（`python/sglang/srt/model_executor/cuda_graph_runner.py:548`）负责。这是初始化阶段的最后一件重活；做完，引擎就待命了。

## 2. 问题

回想 trace 目标：`max_new_tokens=3`。生成这 3 个 token 要跑 3 次 decode 前向，每次只处理**一个** token。问题来了：decode 一次的 GPU 实际计算量极小（一个 token 过一遍模型），但「发起这次计算」本身有固定成本。

一次前向在底层会启动**几百个 CUDA kernel**（每层的 QKV 投影、注意力、MLP、norm……）。每个 kernel 都要 CPU 通过驱动**逐个 launch**。这个 launch 动作本身要花时间——几微秒一个，几百个加起来就是几十到上百微秒。

对 prefill（一次算几百个 token）来说，launch 开销相比计算量可以忽略。但对 decode（一次算 1 个 token），计算只要十几微秒、launch 却要上百微秒——**开销比计算本身还大**。这一步要解决的就是：怎么把 decode 的 kernel launch 开销消掉。

## 3. 朴素思路

decode 就老老实实每步跑一遍前向：Python 调模型 `forward`，PyTorch 逐个 launch kernel。代码最简单，反正每步都一样。

## 4. 为什么朴素思路会崩

「每步重新 launch 几百个 kernel」会让 GPU 大半时间在**空等**：

- 假设 decode 一步的纯 GPU 计算是 15 微秒，而 CPU 逐个 launch 几百个 kernel 要 120 微秒。那么这一步的墙上时间是 ~135 微秒，**GPU 利用率只有约 11%**——剩下 89% 的时间 GPU 在等 CPU 把下一个 kernel 喂过来。
- 生成一个 100 token 的回复要 100 步 decode，每步都白白浪费上百微秒。延迟和吞吐都被 launch 开销拖死。
- 这个开销和 batch 大小、序列长度**几乎无关**——它是「步数」的函数。token 越多步数越多，浪费越线性增长。

朴素思路的根本问题：把「描述这次计算要做什么」（launch 几百个 kernel）和「真正算」绑在了一起，每步重做一遍前者。而 decode 每一步的计算结构其实**一模一样**——只是输入张量的数值不同。

## 5. SGLang 的做法

SGLang 用 **CUDA graph**：把一次 decode 前向涉及的几百个 kernel **录制成一张图**，之后每步只要 **replay（重放）这张图**，一个调用就把几百个 kernel 全发出去，CPU launch 开销从「几百次」压缩成「一次」。

但 CUDA graph 有个硬约束：图一旦录好，**张量的形状和显存地址就固定了**。而不同时刻 decode 的 batch size 不一样（同时在跑的请求数会变）。解法是：**为一组预设的 batch size 各录一张图**。

`get_batch_sizes_to_capture`（`cuda_graph_runner.py:500`）决定要录哪些 batch size：从 `server_args.cuda_graph_bs` 拿候选列表，过滤掉超过 `num_max_requests` 的、对齐到合法倍数（`:522-524`），得到最终的 `capture_bs`。

<svg viewBox="0 0 620 232" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="CUDA graph: capture once at init, replay at runtime">
<defs>
<marker id="t5ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="155" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">init 阶段（一次性）</text>
<rect x="30" y="32" width="250" height="170" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="155" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">capture()</text>
<text x="50" y="86" font-size="11" fill="#64748b">for bs in capture_bs:</text>
<text x="68" y="108" font-size="11" fill="#64748b">为该 batch size</text>
<text x="68" y="128" font-size="11" fill="#64748b">录一张 decode 前向图</text>
<rect x="60" y="142" width="80" height="22" rx="3" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="100" y="157" text-anchor="middle" font-size="10" fill="currentColor">graph[1]</text>
<rect x="148" y="142" width="80" height="22" rx="3" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="188" y="157" text-anchor="middle" font-size="10" fill="currentColor">graph[2]</text>
<text x="155" y="186" text-anchor="middle" font-size="10" fill="#94a3b8">… 一组预设 batch size 各一张</text>
<line x1="280" y1="117" x2="340" y2="117" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#t5ar)"/>
<text x="340" y="22" text-anchor="middle" font-size="11" fill="#94a3b8">运行时（每步 decode）</text>
<rect x="345" y="32" width="250" height="170" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="470" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">can_run(batch) → replay</text>
<text x="365" y="86" font-size="11" fill="#64748b">① 按 batch size 找匹配的图</text>
<text x="365" y="112" font-size="11" fill="#64748b">② replay(graph[bs])</text>
<text x="383" y="134" font-size="11" fill="#16a34a">1 次调用 = 几百 kernel 全发</text>
<text x="365" y="166" font-size="10" fill="#94a3b8">launch 开销：几百次 → 一次</text>
<text x="365" y="184" font-size="10" fill="#94a3b8">没匹配的图则退回普通逐 kernel 路径</text>
</svg>
<span class="figure-caption">图 T5.1 ｜ CUDA graph：初始化时为预设 batch size 各录一张图，运行时一次 replay 全发，消灭 decode 的内核启动开销</span>

<details>
<summary>ASCII 原版</summary>

```text
  init 阶段 (一次性)             运行时 (每步 decode)
  ┌────────────────────┐        ┌──────────────────────┐
  │ capture():         │        │ can_run(batch)?      │
  │  for bs in         │        │   找匹配的图          │
  │    capture_bs:     │  ───►  │ replay(graph[bs])    │
  │   录一张 decode 图 │        │   1 次调用 = 几百     │
  │                    │        │   kernel 全发        │
  └────────────────────┘        └──────────────────────┘
```

</details>

`CudaGraphRunner.capture`（`cuda_graph_runner.py:817`）在初始化时把每个 `bs` 的图逐一录好（`capture_one_batch_size`，`:921`）。运行时 decode 来一批，`can_run`（`:722`）判断这批的 batch size 有没有对应的图；有就 `replay`，没有就退回普通逐 kernel 路径。

录图发生在 `init_memory_pool` **之后**（上一步），因为图要用到已经分配好的 KV 池地址；图本身也占一块显存，这正是上一步 `mem_fraction_static` 要留余量的原因之一。

prefill 一般**不**用 CUDA graph——prefill 的 token 数千变万化、计算量也大，launch 开销占比小，录图的收益不划算（也有 piecewise 等部分图方案，见参考章节）。CUDA graph 主要是为 decode 服务的。

捕获完成，初始化全部结束。引擎进入待命，等 `engine.generate` 的调用。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/model_executor/cuda_graph_runner.py:500` —— `get_batch_sizes_to_capture`，决定录哪些 batch size。
- `cuda_graph_runner.py:548` —— `CudaGraphRunner` 类定义，`:551` 的 `__init__`。
- `cuda_graph_runner.py:817` —— `capture`，逐个 batch size 录图。
- `cuda_graph_runner.py:921` —— `capture_one_batch_size`，录单张图。
- `cuda_graph_runner.py:722` —— `can_run`，运行时判断能否走图。
- 另见 `breakable_cuda_graph_runner.py`、`piecewise_cuda_graph_runner.py` —— 部分图 / 可打断图变体。

## 7. 分支与延伸

- CUDA graph 的完整机制、与 torch.compile 的配合 → [第 09 章 ModelRunner §CUDA graph](09-model-runner.md)
- 为什么 prefill 走非图路径、piecewise graph 是什么 → [第 09 章](09-model-runner.md)
- decode 每一步具体怎么跑、怎么用上这些图 → [步骤 17](tour-17-decode-loop.md)
- 投机解码会改变 decode 的 batch 形状，对应的图捕获也不同 → [第 12 章 投机解码](12-speculative-decoding.md)

## 8. 走完这一步你脑子里应该多了什么

1. decode 一次只算一个 token，**CPU 逐个 launch 几百个 kernel 的开销比 GPU 计算本身还大**——这是 decode 的头号性能杀手。
2. CUDA graph 把一次前向的几百个 kernel **录成一张图**，运行时一次 replay 全发出去，把 launch 开销从几百次压成一次。
3. CUDA graph 要求张量形状固定，所以 SGLang **为一组预设 batch size 各录一张图**（`capture_bs`），运行时按 batch size 选图。
4. 录图在初始化阶段一次性完成，且在 KV 池分配之后；图本身占显存——这是 `mem_fraction_static` 要留余量的原因之一。至此初始化全部结束，引擎待命。
