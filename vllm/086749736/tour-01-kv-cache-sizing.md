# Trace 步骤样品：第 1 步 —— LLM 构造时，怎么知道 KV cache 能塞多少？

> 这是 "vllm 单请求 trace" 的第一个步骤样品，用来验证文档格式。
> 完整 trace 目标：`LLM("Qwen/Qwen2.5-7B-Instruct").generate(["你好"], SamplingParams(max_tokens=3, temperature=0))`

## 1. 当前情境

你写：

```python
from vllm import LLM
llm = LLM(model="Qwen/Qwen2.5-7B-Instruct")
```

按回车后，进程开始干活，**20-60 秒之后**才返回 `llm` 对象。这中间发生了一长串事，但我们先聚焦其中**最关键也最微妙的一步**：决定 KV cache pool 有多大。

（CUDA graph capture、attention backend 选定、模型权重加载等并行/串行进行，是后续步骤的主题。）

## 2. 问题

PagedAttention 的核心是一个**预先分配的物理 block 池**——所有 request 的 KV 都从这个池里申请。这个池建好后大小固定，运行中不再扩。

关键问题：**池子开多大？**

- 太小：能同时服务的请求少，吞吐低
- 太大：跑到一半 OOM，进程崩
- "动态调整"不行：在 GPU 上分配大块连续显存只能初始化时一次性做

所以必须在初始化阶段决定一个数字，并让它**接近上限但又安全**。

## 3. 朴素思路

"看看 GPU 还剩多少显存，按 90% 分给 KV cache 不就行了？"

```python
free, total = torch.cuda.mem_get_info()
kv_bytes = int(free * 0.9)
num_blocks = kv_bytes // per_block_bytes
```

听起来合理。

## 4. 为什么朴素思路会崩

会在跑某个真实请求时 OOM。因为**模型 forward 本身要吃显存**，而且不只是权重：

- 中间激活值（attention scores、SwiGLU 中间态）
- cuDNN / cuBLAS workspace
- NCCL 通信 buffer（TP 场景）
- torch.compile 编译后的 fused kernel workspace
- 各种 allocator fragmentation

这些**跟 batch size 和 seqlen 强相关**。模型刚加载完时它们大多还没被分配——你按"当前空闲"分了 KV，等真的来了一个大 batch、长 prompt，激活值塞不下，OOM。

## 5. vllm 的做法

**先模拟一次最坏情况的 forward，看 forward 自己峰值要多少显存，剩下的才能给 KV cache。**

伪代码：

```
1. 把模型加载到 GPU，记下此刻空闲显存 F_after_model
2. 构造一个 "最大 batch、最长 seqlen" 的假输入（dummy tensors，权重是真的）
3. 跑一次 forward（结果丢弃；目的是让所有 lazy allocation 都被触发）
4. 等显存峰值落定后，看此刻空闲 F_after_forward
5. forward 实测占用 = F_after_model - F_after_forward
6. 把 gpu_memory_utilization 比例（默认 0.9）应用进去，剩下的归 KV cache pool
7. 池子能开 num_blocks = kv_bytes / per_block_bytes 个 block
```

**关键是第 3 步**：通过真的跑一次 forward，把 PyTorch / CUDA / NCCL 的 lazy 分配全部触发，得到真实峰值。这一步之后，剩余显存才是"未来 KV cache 可以放心吃"的上限。

<svg viewBox="0 0 760 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="profile_run 后 24GB GPU 显存的分配示意">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#cbd5e1" stroke-width="2"/>
    </pattern>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">profile_run 之后：24 GB GPU 显存被四段切开</text>
  <g transform="translate(40, 130)">
    <rect x="0" y="0" width="397" height="56" fill="#475569"/>
    <text x="198" y="26" text-anchor="middle" font-size="13" font-weight="600" fill="white">Model weights</text>
    <text x="198" y="44" text-anchor="middle" font-size="11" fill="#e2e8f0">~14 GB</text>
    <rect x="397" y="0" width="113" height="56" fill="url(#hatch)" stroke="#94a3b8" stroke-width="1"/>
    <text x="453" y="26" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">Forward 峰值</text>
    <text x="453" y="42" text-anchor="middle" font-size="10" fill="#64748b">~4 GB</text>
    <rect x="510" y="0" width="153" height="56" fill="#ea580c"/>
    <text x="586" y="26" text-anchor="middle" font-size="13" font-weight="600" fill="white">KV cache pool</text>
    <text x="586" y="44" text-anchor="middle" font-size="11" fill="#fed7aa">~5.4 GB（= 6 × 0.9）</text>
    <rect x="663" y="0" width="17" height="56" fill="#fef3c7" stroke="#facc15" stroke-width="1"/>
    <text x="671" y="74" text-anchor="middle" font-size="9" fill="#92400e">容错</text>
    <text x="671" y="86" text-anchor="middle" font-size="9" fill="#a16207">0.6 GB</text>
    <line x1="0" y1="-12" x2="0" y2="-2" stroke="#64748b" stroke-width="1"/>
    <line x1="397" y1="-12" x2="397" y2="-2" stroke="#64748b" stroke-width="1"/>
    <line x1="510" y1="-12" x2="510" y2="-2" stroke="#64748b" stroke-width="1"/>
    <line x1="680" y1="-12" x2="680" y2="-2" stroke="#64748b" stroke-width="1"/>
    <text x="0" y="-18" font-size="10" fill="#64748b">0 GB</text>
    <text x="397" y="-18" text-anchor="middle" font-size="10" fill="#64748b">14 GB</text>
    <text x="510" y="-18" text-anchor="middle" font-size="10" fill="#64748b">18 GB</text>
    <text x="680" y="-18" text-anchor="end" font-size="10" fill="#64748b">24 GB</text>
  </g>
  <g transform="translate(40, 215)">
    <path d="M 397 0 L 397 10 L 680 10 L 680 0" fill="none" stroke="#0ea5e9" stroke-width="1.2"/>
    <text x="680" y="26" text-anchor="end" font-size="11" fill="#0369a1"><tspan font-weight="700">F_after_model</tspan> = 24 − 14 = 10 GB（模型加载后空闲）</text>
    <path d="M 510 38 L 510 48 L 680 48 L 680 38" fill="none" stroke="#a855f7" stroke-width="1.2"/>
    <text x="680" y="64" text-anchor="end" font-size="11" fill="#7e22ce"><tspan font-weight="700">F_after_forward</tspan> = 10 − 4 = 6 GB（profile_run 后空闲；× 0.9 归 KV pool）</text>
  </g>
</svg>
<span class="figure-caption">图 T1.1 ｜ 24 GB 卡跑 Qwen2.5-7B 的典型分配。中间灰色斜纹段是 profile_run 测出来的 forward 峰值；KV pool 是「forward 之后剩下的 × gpu_memory_utilization」</span>


`gpu_memory_utilization=0.9` 这个看似无足轻重的参数，本质是"留多少给后续运行时 fragmentation 增长的容错"。

## 6. 代码位置

- 入口（worker 接口）：`vllm/v1/worker/gpu_worker.py::GPUWorker.determine_available_memory`
- 真正的 dummy forward：`vllm/v1/worker/gpu_model_runner.py::GPUModelRunner.profile_run`
- bytes → block 数换算：`vllm/v1/core/kv_cache_utils.py`
- 触发链路：`vllm/v1/engine/core.py::EngineCore.__init__` → `Executor.determine_available_memory()` → 各 worker

**阅读顺序**：先看 `EngineCore.__init__` 怎么编排（哪步在哪步前），再下到 `determine_available_memory` 看测量逻辑，最后看 `profile_run` 怎么造假输入。

## 7. 分支与延伸

- **`gpu_memory_utilization` 参数为什么默认 0.9 而不是 0.95？** → 第 6 章 §3 "GPUWorker 生命周期 + profile run"
- **spec decode 怎么变？** draft model 也要算入 forward 峰值 → 第 11 章 "spec decode" 小节
- **ubatching / DP 怎么变？** "最大 batch" 的定义被改写 → 第 6 章 §11
- **CPU / TPU backend** 不用 PagedAttention，容量计算路径完全不同 → 第 6 章 §17
- **为什么用 `torch.cuda.mem_get_info()` 而不用 `torch.cuda.memory_allocated()`？** 因为 PyTorch 分配器有 caching 行为，会持有比"目前 live tensor 总和"更多的内存 → 见 PyTorch 内存管理文档 + 第 5 章 §10

## 8. 走完这一步你脑子里应该多了什么

1. PagedAttention block pool 是**初始化时一次性分配**，运行中不扩容
2. 池子大小不能"凭算式估"，必须**实测**——所以有 `profile_run` 这个看似奇怪的"先跑一次假 forward"
3. `gpu_memory_utilization` 这个参数本质是"留多少给后续 fragmentation 容错"，不是"GPU 总用量上限"
4. 第一次 `LLM(...)` 等了 30 秒，其中相当一部分时间花在这一步 + 紧跟着的 CUDA graph capture（下一步主题）
