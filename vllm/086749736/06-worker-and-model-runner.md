# 第 6 章 Worker 与 Model Runner（Layer 4：GPU 执行层）

本章聚焦 vLLM V1 在单个 GPU 上把 `SchedulerOutput` 落地为一次前向 + 采样的全部代码路径。前面几章描述了请求生命周期（Layer 1）、EngineCore 调度（Layer 2）和 KV cache 管理（Layer 3）。这里是最后一层：在 worker 进程内部，按调度结果组装连续 tensor、构造 attention metadata、跑 CUDA graph、采样、回传结果。

目录：

- [6.1 三层抽象总览](#61-三层抽象总览)
- [6.2 `WorkerBase`：硬件无关的 worker 协议](#62-workerbase硬件无关的-worker-协议)
- [6.3 `Worker`（GPU）：进程级生命周期](#63-workergpu进程级生命周期)
- [6.4 `GPUModelRunner` 的状态结构](#64-gpumodelrunner-的状态结构)
- [6.5 Input Batch：持久化批的拼装](#65-input-batch持久化批的拼装)
- [6.6 `BlockTable` 与 slot mapping](#66-blocktable-与-slot-mapping)
- [6.7 `execute_model()` 主循环](#67-execute_model-主循环)
- [6.8 `_prepare_inputs()`：把多请求拼成连续 tensor](#68-_prepare_inputs把多请求拼成连续-tensor)
- [6.9 attention metadata：prefill 与 decode 的统一表达](#69-attention-metadataprefill-与-decode-的统一表达)
- [6.10 CUDA Graph：dispatcher、捕获与回放](#610-cuda-graphdispatcher捕获与回放)
- [6.11 微批 / ubatching（DBO）](#611-微批--ubatchingdbo)
- [6.12 多模态编码器与 `encoder_cudagraph`](#612-多模态编码器与-encoder_cudagraph)
- [6.13 Connector mixin：KV / EC / LoRA](#613-connector-mixinkv--ec--lora)
- [6.14 `_dummy_run()`、`profile_run()`、`capture_model()`](#614-_dummy_runprofile_runcapture_model)
- [6.15 Executor 抽象与三种实现](#615-executor-抽象与三种实现)
- [6.16 Worker 与 EngineCore 的通信：Future 和 tensor IPC](#616-worker-与-enginecore-的通信future-和-tensor-ipc)
- [6.17 其他 ModelRunner](#617-其他-modelrunner)

---

## 6.1 三层抽象总览

EngineCore 不直接接触 GPU。所有 GPU 上的工作都被三层抽象隔离：

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="EngineCore 到 GPU 的三层抽象">
  <defs>
    <marker id="ar61" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(40, 24)">
    <rect x="0" y="0" width="170" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="85" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">EngineCore</text>
    <text x="85" y="38" text-anchor="middle" font-size="10" fill="#64748b">调度 / 上层入口</text>
  </g>
  <line x1="125" y1="74" x2="320" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <text x="240" y="82" font-size="10" fill="#64748b">execute_model(...)</text>
  <g transform="translate(290, 98)">
    <rect x="0" y="0" width="380" height="58" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="190" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Executor（1 driver process）</text>
    <text x="190" y="40" text-anchor="middle" font-size="10" fill="#64748b">collective_rpc + 消息队列；唯一面向 EngineCore 的接口</text>
    <text x="190" y="53" text-anchor="middle" font-size="10" fill="#7c3aed">UniProc / Multiproc / Ray</text>
  </g>
  <g transform="translate(40, 180)">
    <text x="0" y="0" font-size="10" fill="#64748b">broadcast 给每个 rank 一份</text>
    <line x1="80" y1="-8" x2="80" y2="36" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
    <line x1="80" y1="36" x2="200" y2="36" stroke="#94a3b8" stroke-width="1.2"/>
    <line x1="200" y1="36" x2="200" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
    <line x1="80" y1="36" x2="430" y2="36" stroke="#94a3b8" stroke-width="1.2"/>
    <line x1="430" y1="36" x2="430" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
    <line x1="80" y1="36" x2="610" y2="36" stroke="#94a3b8" stroke-width="1.2"/>
    <line x1="610" y1="36" x2="610" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  </g>
  <g transform="translate(40, 244)">
    <rect x="100" y="0" width="200" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker (rank 0)</text>
    <text x="200" y="36" text-anchor="middle" font-size="10" fill="#64748b">进程代理：device / 通信 / sleep</text>
    <rect x="330" y="0" width="200" height="48" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="430" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker (rank 1)</text>
    <text x="430" y="36" text-anchor="middle" font-size="10" fill="#64748b">…</text>
    <rect x="530" y="0" width="160" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="3,2"/>
    <text x="610" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#64748b">Worker (rank N)</text>
    <text x="610" y="36" text-anchor="middle" font-size="10" fill="#94a3b8">…</text>
  </g>
  <line x1="240" y1="292" x2="240" y2="316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar61)"/>
  <g transform="translate(140, 316)">
    <rect x="0" y="0" width="200" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="100" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">ModelRunner</text>
    <text x="100" y="33" text-anchor="middle" font-size="10" fill="#64748b">拼 tensor → forward → 采样</text>
  </g>
  <text x="500" y="338" font-size="10" fill="#94a3b8">每个 Worker 持有一份 ModelRunner，最终走到 model.forward()</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ EngineCore 与 GPU 之间的三层抽象：Executor（驱动进程）→ Worker（每个 device 一份）→ ModelRunner（真正与 GPU tensor 打交道）。</span>

<details>
<summary>ASCII 原版</summary>

```text
                  +---------------------------+
   EngineCore --> | Executor (1 driver proc)  |   collective_rpc + 消息队列
                  +-----+---------------------+
                        |
        broadcast       |   每个 rank 一份
                        v
                  +---------------------------+
                  | Worker (1 per device)     |   进程内代理，管 device/通信/sleep
                  +-----+---------------------+
                        |
                        v
                  +---------------------------+
                  | ModelRunner (1 per rank)  |   组装 tensor、调模型、采样
                  +-----+---------------------+
                        |
                        v
                       model.forward()
```

</details>

- **Executor**（`vllm/v1/executor/abstract.py:37`）是 EngineCore 唯一的接口。负责把单条 `execute_model(scheduler_output)` 调用扩散到所有并行 rank（TP × PP × PCP），并把结果聚合返回。三种实现：`UniProcExecutor`、`MultiprocExecutor`、`RayDistributedExecutor`/`RayExecutorV2`。
- **Worker**（`vllm/v1/worker/worker_base.py:39`）是单个进程的代理。它持有 `vllm_config`、`device`、`distributed_init_method`，处理 CUDA 设备初始化、distributed group 初始化、模型加载、KV cache 容量探测（`determine_available_memory`）以及 sleep/wake。
- **ModelRunner**（`vllm/v1/worker/gpu_model_runner.py:418`，超 7300 行）是真正与 GPU tensor 打交道的对象。它持有 `InputBatch`、KV cache、attention metadata builder、speculative decoding drafter、CUDA graph dispatcher。每一步都从 `SchedulerOutput` 走到 `ModelRunnerOutput`。

**为什么三层分开**：Worker 和 ModelRunner 拆开是历史包袱也是必要的——Worker 处理"进程"的语义（信号、健康检查、内存监控、PP send/recv 异步、weight transfer），ModelRunner 处理"批"的语义。在 TP/PP 多卡场景下，所有 rank 的 Worker 都执行相同流程，ModelRunner 上的 attention metadata 与 KV layout 也需保持一致；Executor 的 collective_rpc 给了这种"所有 rank 同步执行同一方法"的原语。

---

## 6.2 `WorkerBase`：硬件无关的 worker 协议

`vllm/v1/worker/worker_base.py:39` 的 `WorkerBase` 定义了 vLLM 期望任何硬件后端必须实现的"生命周期"接口。它本身几乎不做任何事，只持有 `vllm_config` 与 device 元数据：

| 方法 | 调用时机 | 语义 |
|------|----------|------|
| `__init__` (`:45`) | Executor 启动每个 worker 时 | 拆解 `vllm_config` 到 model/cache/lora 等字段；保存 `local_rank`、`rank`、`distributed_init_method` |
| `init_device` (`:114`) | 紧随 `__init__` | 设置 CUDA device、初始化 distributed group、做内存快照 |
| `load_model` (`:138`) | `init_device` 之后 | 把模型权重加载到 device 上 |
| `get_kv_cache_spec` (`:98`) | EngineCore 决定 KV layout 之前 | 返回每一层 attention 需要的 cache shape/dtype |
| `compile_or_warm_up_model` (`:102`) | `initialize_from_config` 之后 | 跑 warmup forward、捕获 CUDA graph |
| `execute_model` (`:142`) | 每个调度步 | 接收 `SchedulerOutput`，触发前向 |
| `sample_tokens` (`:153`) | `execute_model` 返回 `None` 时 | 拆分结构化输出场景下的两阶段执行 |
| `add_lora` / `remove_lora` / `pin_lora` / `list_loras` (`:165`-`:175`) | LoRA 热插拔 | 转发到 model runner |
| `shutdown` (`:182`) | 终止前 | 释放 GPU 资源 |

`WorkerWrapperBase`（`:187`）是一层 "lazy init" 包装：在子进程里被先创建，然后通过 `init_worker(all_kwargs)` 解析出真正的 worker class 名（来自 `parallel_config.worker_cls`，是个字符串），实例化对应类。这一层存在的原因是 spawn 子进程时通过 pickle 传递配置很脆弱——通过字符串延迟解析能避开很多导入顺序问题。

`WorkerWrapperBase.execute_model`（`:340`）在调用 worker 前先调用 `_apply_mm_cache(scheduler_output)`（`:330`）：把多模态特征从 worker 端的 receiver cache 里取回来——这是 EngineCore 与 Worker 之间 mm 数据共享内存的"消费"端，对应 §6.16 的 tensor IPC 机制。

---

## 6.3 `Worker`（GPU）：进程级生命周期

`vllm/v1/worker/gpu_worker.py:106` 的 `Worker` 类是 CUDA/HIP/XPU 通用的 GPU Worker。XPU 通过 `vllm/v1/worker/xpu_worker.py` 略作覆写。

### 6.3.1 启动顺序

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GPU Worker 启动阶段顺序图">
  <defs>
    <marker id="ar62" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(220, 14)">
    <rect x="0" y="0" width="320" height="42" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="160" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">WorkerWrapperBase.init_worker</text>
    <text x="160" y="34" text-anchor="middle" font-size="10" fill="#64748b">lazy 解析 worker_cls 字符串 → 实例化</text>
  </g>
  <line x1="380" y1="56" x2="380" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <g transform="translate(220, 80)">
    <rect x="0" y="0" width="320" height="42" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="160" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker.__init__ → Worker.init_device</text>
    <text x="160" y="34" text-anchor="middle" font-size="10" fill="#64748b">gpu_worker.py:239　set device + NCCL + MemorySnapshot</text>
  </g>
  <line x1="380" y1="122" x2="380" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <g transform="translate(220, 146)">
    <rect x="0" y="0" width="320" height="42" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="160" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker.load_model</text>
    <text x="160" y="34" text-anchor="middle" font-size="10" fill="#64748b">gpu_worker.py:338　把权重加载到 device</text>
  </g>
  <line x1="380" y1="188" x2="380" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <g transform="translate(190, 212)">
    <rect x="0" y="0" width="380" height="58" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker.determine_available_memory</text>
    <text x="190" y="36" text-anchor="middle" font-size="10" fill="#64748b">gpu_worker.py:354　profile_run + cudagraph 估算</text>
    <text x="190" y="50" text-anchor="middle" font-size="10" fill="#7c3aed">输出：num_gpu_blocks（KV pool 大小）</text>
  </g>
  <line x1="380" y1="270" x2="380" y2="292" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <g transform="translate(190, 294)">
    <rect x="0" y="0" width="380" height="58" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker.initialize_from_config</text>
    <text x="190" y="36" text-anchor="middle" font-size="10" fill="#64748b">gpu_worker.py:539</text>
    <text x="190" y="50" text-anchor="middle" font-size="10" fill="#0d9488">KV cache 实际分配（按上一步算出的 num_blocks）</text>
  </g>
  <line x1="380" y1="352" x2="380" y2="374" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar62)"/>
  <g transform="translate(190, 376)">
    <rect x="0" y="0" width="380" height="58" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Worker.compile_or_warm_up_model</text>
    <text x="190" y="36" text-anchor="middle" font-size="10" fill="#64748b">gpu_worker.py:574</text>
    <text x="190" y="50" text-anchor="middle" font-size="10" fill="#0d9488">torch.compile + CUDA Graph 捕获（需要真实 KV cache）</text>
  </g>
  <text x="40" y="455" font-size="10" fill="#94a3b8">关键依赖：profile_run 必须在 KV cache 分配之前——否则 KV 把激活峰值挤掉，profile 拿到的就是错的</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ GPU Worker 启动阶段：橙色阶段决定 KV 容量，青色阶段在 KV cache 真实分配后做编译与 CUDA Graph 捕获。</span>

<details>
<summary>ASCII 原版</summary>

```text
WorkerWrapperBase.init_worker  ->  Worker.__init__
                                       |
                                       v
                             Worker.init_device   (gpu_worker.py:239)
                                       |
                                       v
                             Worker.load_model    (:338)
                                       |
                                       v
                             Worker.determine_available_memory  (:354)
                                       |
                                       v
                             Worker.initialize_from_config       (:539)   <- KV cache 实际分配
                                       |
                                       v
                             Worker.compile_or_warm_up_model     (:574)   <- 编译 + CUDA graph
```

</details>

### 6.3.2 `init_device`（`gpu_worker.py:239`）

关键工作：
1. 计算物理 `local_rank`：`DP_LOCAL_RANK * (TP*PP) + TP_LOCAL_RANK`（`:261`）。注释解释了 DP 与 TP/PP 嵌套时怎么映射到物理 device。
2. 调用 `init_worker_distributed_environment`（`:1121`）初始化 NCCL/gloo group。注意必须**先**初始化 NCCL 再做内存快照——NCCL 自己会分配 buffer，要把它算进基线（`:281`-`:289`）。
3. 调用 `MemorySnapshot`（`:302`）记录当前 free/total，作为 `determine_available_memory` 的基准。
4. 根据 `use_v2_model_runner` 实例化 V1（`gpu_model_runner.py`）或 V2（`gpu/model_runner.py`）的 `GPUModelRunner`（`:316`-`:330`）。

### 6.3.3 `determine_available_memory`（`gpu_worker.py:354`）

这是 vLLM 决定 `num_gpu_blocks` 的核心步骤——经典的 "profile run" 思路：

```python
# gpu_worker.py:388
with memory_profiling(
    self.init_snapshot,
    weights_memory=int(self.model_runner.model_memory_usage),
) as profile_result:
    self.model_runner.profile_run()
    profile_torch_peak = torch.accelerator.memory_stats(self.device).get(
        "allocated_bytes.all.peak", 0
    )
    cudagraph_memory_estimate = 0
    if (current_platform.is_cuda()
        and self.vllm_config.compilation_config.cudagraph_mode
        != CUDAGraphMode.NONE):
        cudagraph_memory_estimate = self.model_runner.profile_cudagraph_memory()
```

`profile_run` 用 `max_num_batched_tokens` 跑一遍假数据前向（详见 §6.14），`memory_profiling` 上下文管理器在前后做 snapshot。
KV cache 可用容量 = `gpu_memory_utilization * total` - `weights` - `peak_activation` - `non_torch` - `cudagraph_estimate`（`:443`-`:447`）。

`profile_cudagraph_memory` 是 v0.21.0 之后的默认行为：用一份**最小** KV cache（够 cudagraph 跑就行，`gpu_model_runner.py:6109`）真捕获一遍 graph，量出 graph pool 的实际占用，避免 OOM。如果用户禁用该 flag，会给出 `--gpu-memory-utilization` 应该下调多少的警告（`:494`）。

### 6.3.4 `execute_model`（`gpu_worker.py:782`）

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Worker.execute_model 四步流程">
  <defs>
    <marker id="ar63" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 100)">
    <rect x="0" y="0" width="130" height="48" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="65" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">SchedulerOutput</text>
    <text x="65" y="38" text-anchor="middle" font-size="10" fill="#64748b">从 EngineCore 来</text>
  </g>
  <line x1="150" y1="124" x2="172" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar63)"/>
  <g transform="translate(178, 24)">
    <rect x="0" y="0" width="560" height="232" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
    <text x="280" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Worker.execute_model（gpu_worker.py:782）</text>
    <g transform="translate(20, 40)">
      <rect x="0" y="0" width="240" height="56" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="120" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">1. wait 上一步 PP send</text>
      <text x="120" y="38" text-anchor="middle" font-size="10" fill="#64748b">_pp_send_work（避免延迟传染）</text>
      <text x="120" y="50" text-anchor="middle" font-size="10" fill="#64748b">非阻塞模式拿 future</text>
    </g>
    <g transform="translate(280, 40)">
      <rect x="0" y="0" width="240" height="56" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="120" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">2. irecv 上游中间 tensor</text>
      <text x="120" y="38" text-anchor="middle" font-size="10" fill="#64748b">非 PP first rank 时</text>
      <text x="120" y="50" text-anchor="middle" font-size="10" fill="#7c3aed">→ AsyncIntermediateTensors</text>
    </g>
    <g transform="translate(20, 110)">
      <rect x="0" y="0" width="500" height="50" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
      <text x="250" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">3. self.model_runner.execute_model(...)</text>
      <text x="250" y="36" text-anchor="middle" font-size="10" fill="#64748b">真正调 GPUModelRunner，返回 ModelRunnerOutput 或 IntermediateTensors</text>
    </g>
    <g transform="translate(20, 174)">
      <rect x="0" y="0" width="500" height="44" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="250" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4. isend 到下游（非 PP last rank）</text>
      <text x="250" y="34" text-anchor="middle" font-size="10" fill="#64748b">把 IntermediateTensors 发给下一段，下一步开头 wait</text>
    </g>
  </g>
  <text x="380" y="276" text-anchor="middle" font-size="10" fill="#94a3b8">AsyncIntermediateTensors 把 wait_for_comm 延迟到第一次访问 .tensors —— overlap 通信 + CPU 拼装</text>
</svg>
<span class="figure-caption">图 R6.3 ｜ Worker.execute_model 把"等待上游 / model_runner 主体 / 异步发下游"三件事编排成单步流水，PP 通信尽量与 CPU 拼装 overlap。</span>

<details>
<summary>ASCII 原版</summary>

```text
                      ┌───────────────────────────┐
scheduler_output ─►   │ Worker.execute_model      │
                      │                           │
                      │ 1. 等待上一步 PP send 完成 │
                      │ 2. 若非 PP first rank：    │
                      │    irecv 上游中间 tensor   │ ─► AsyncIntermediateTensors
                      │ 3. self.model_runner.     │
                      │    execute_model(...)     │ ─► ModelRunnerOutput / IntermediateTensors
                      │ 4. 若非 PP last rank：    │
                      │    isend 到下游            │
                      └───────────────────────────┘
```

</details>

`AsyncIntermediateTensors`（`gpu_worker.py:74`）是 IntermediateTensors 的子类，把 `wait_for_comm` 延迟到第一次访问 `.tensors`（`__getattribute__` 拦截）。这样 PP 模型的上游通信可以 overlap 在 model runner 准备 input 的 CPU 阶段——典型的延迟同步优化。

`_pp_send_work`（`:158`、`:786`）保存上一步异步 send 的句柄，每步首先等待它完成。如果直接 blocking send，PP last rank 的延迟会传染到所有上游 rank。

---

## 6.4 `GPUModelRunner` 的状态结构

`GPUModelRunner.__init__`（`gpu_model_runner.py:418`-`:891`，~470 行）做了大量"为后续步骤分配持久 buffer"的工作。理解这些 buffer 的命名约定是看懂剩余代码的关键。

### 6.4.1 持久 CPU/GPU 双 buffer：`CpuGpuBuffer`

vLLM 大量使用 `CpuGpuBuffer`（`vllm/v1/utils.py`）：一对 pinned-CPU + GPU tensor，附带一份 numpy view。
`_make_buffer`（`gpu_model_runner.py:979`）创建这种对象：

```python
# gpu_model_runner.py:709
self.input_ids       = self._make_buffer(self.max_num_tokens, dtype=torch.int32)
self.query_start_loc = self._make_buffer(self.max_num_reqs + 1, dtype=torch.int32)
self.req_indices     = self._make_buffer(self.max_num_tokens, dtype=torch.int64)
self.num_scheduled_tokens = self._make_buffer(self.max_num_reqs, dtype=torch.int32)
self.prev_positions  = self._make_buffer(self.max_num_reqs, dtype=torch.int64)
```

属性约定：
- `.np` —— 直接操作 numpy。CPU 上做拼装非常快。
- `.cpu` —— 同一块内存的 `torch.Tensor`，pin 内存。
- `.gpu` —— GPU 上的对应 tensor。
- `.copy_to_gpu(n)` —— H2D 拷贝前 `n` 个元素，**non-blocking**（依赖默认 stream）。

**为什么这样设计**：CUDA graph 要求每步使用相同的 tensor 地址。所有 input metadata buffer 都按 `max_num_tokens` / `max_num_reqs` 预分配，每步只覆写前 N 个元素，剩余位置由 padding 或 `NULL_BLOCK_ID` 填充。

### 6.4.2 关键 buffer 列表

| 字段 | 形状 | 含义 |
|------|------|------|
| `input_ids` | `[max_num_tokens]` int32 | flatten 后的 token id 序列 |
| `positions` | `[max_num_tokens]` int64 | 每个 token 的绝对位置（GPU only） |
| `query_start_loc` | `[max_num_reqs+1]` int32 | 累计 token 计数（cumsum） |
| `seq_lens` | `[max_num_reqs]` int32 | 每个 req 当前的 KV 长度（含本步） |
| `num_computed_tokens` | `[max_num_reqs]` int32 | KV 已存在的 token 数 |
| `req_indices` | `[max_num_tokens]` int64 | 每个 token 属于第几个 req（in-batch） |
| `query_pos` | `[max_num_tokens]` int64 | 每个 token 在自身 req 内的 query offset |
| `num_scheduled_tokens` | `[max_num_reqs]` int32 | 每个 req 本步要处理的 token 数 |
| `prev_positions` | `[max_num_reqs]` int64 | 当前 batch 位置 → 上一步 batch 位置 |
| `discard_request_mask` | `[max_num_reqs]` bool | 哪些 req 的采样要丢弃（chunked prefill） |
| `num_accepted_tokens` | `[max_num_reqs]` int32 | spec decode 中上一步接受的 token 数 |

### 6.4.3 其它持久状态

- `self.requests: dict[str, CachedRequestState]`（`:627`）—— req_id → 完整请求状态。Worker 端的"请求字典"，与 EngineCore 的 `Request` 是镜像。
- `self.input_batch: InputBatch`（`:650`）—— 持久批（见 §6.5）。
- `self.kv_caches: list[torch.Tensor]`（`:519`）—— 一层一份的 KV cache。
- `self.cudagraph_dispatcher`（`:808`）—— 见 §6.10。
- `self.execute_model_state: ExecuteModelState | None`（`:887`）—— 在 `execute_model` 与 `sample_tokens` 之间传递的临时状态（见 `:405`-`:412` 的 `ExecuteModelState` 定义）。

---

## 6.5 Input Batch：持久化批的拼装

`vllm/v1/worker/gpu_input_batch.py:91` 的 `InputBatch` 是 vLLM V1 最重要的 datastructure 之一。它把"在线增删的 N 个请求"持久化为"固定 max_num_reqs 行的 SoA（Structure of Arrays）"。

### 6.5.1 SoA 布局动机

一种自然的写法是为每个 req 持有 `SamplingParams`，每步再 zip 起来生成 tensor。但每步都要分配几十个 `torch.empty` + `to(device)`，CPU 开销巨大。

vLLM 反其道而行：每个 sampling 字段（`temperature`、`top_p`、`top_k`、`frequency_penalties` 等）都是一个长度 `max_num_reqs` 的 tensor，并且持有 CPU/GPU 两份。增减请求时只更新对应**单个 slot**：

```python
# gpu_input_batch.py:380
if sampling_params := request.sampling_params:
    if sampling_params.sampling_type == SamplingType.GREEDY:
        self.temperature_cpu[req_index] = 0.0
        self.greedy_reqs.add(req_id)
    else:
        self.temperature_cpu[req_index] = sampling_params.temperature
        self.random_reqs.add(req_id)
    self.top_p_cpu[req_index] = sampling_params.top_p
    ...
```

`greedy_reqs` / `top_p_reqs` 这些 set 充当"哪些字段需要 H2D 同步"的标志，`_make_sampling_metadata`（`:831`）只在 `not self.no_top_p` 时才 `copy_slice` 到 GPU。

### 6.5.2 ASCII：请求加入流程

<svg viewBox="0 0 880 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="InputBatch SoA 请求加入流程">
  <defs>
    <marker id="ar64" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 14)">
    <text x="200" y="0" font-size="13" font-weight="700" fill="currentColor">SchedulerOutput.scheduled_new_reqs</text>
    <rect x="0" y="14" width="400" height="42" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="200" y="32" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">NewReqData(req_X, prompt=[1,2,3], block_ids=([0,1],))</text>
    <text x="200" y="48" text-anchor="middle" font-size="10" fill="#64748b">EngineCore 这一步新加入的请求</text>
    <g transform="translate(20, 76)">
      <rect x="0" y="0" width="360" height="32" rx="3" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
      <text x="180" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">add_request(req_X)</text>
    </g>
    <g transform="translate(40, 122)">
      <rect x="0" y="0" width="340" height="24" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="170" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_register_add_request → req_index=3</text>
    </g>
    <text x="40" y="160" font-size="10" fill="#64748b">复用 pop_removed() 的空位</text>
    <text x="40" y="174" font-size="10" fill="#64748b">否则追加 num_reqs++</text>
    <g transform="translate(40, 190)">
      <rect x="0" y="0" width="340" height="24" rx="3" fill="#fef3c7" stroke="#facc15" stroke-width="1"/>
      <text x="170" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="#92400e">写入 SoA 的第 3 行</text>
    </g>
    <text x="40" y="232" font-size="10" fill="#64748b" font-family="monospace">_req_ids[3] = "X"</text>
    <text x="40" y="246" font-size="10" fill="#64748b" font-family="monospace">token_ids_cpu[3, :3] = [1, 2, 3]</text>
    <text x="40" y="260" font-size="10" fill="#64748b" font-family="monospace">num_prompt_tokens[3] = 3</text>
    <text x="40" y="274" font-size="10" fill="#64748b" font-family="monospace">block_table.add_row(([0,1],), 3)</text>
    <text x="40" y="288" font-size="10" fill="#64748b" font-family="monospace">temperature_cpu[3] = 0.0</text>
    <text x="40" y="302" font-size="10" fill="#64748b" font-family="monospace">greedy_reqs.add("X")</text>
  </g>
  <line x1="440" y1="100" x2="478" y2="100" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar64)"/>
  <text x="460" y="92" text-anchor="middle" font-size="10" fill="#64748b">apply</text>
  <g transform="translate(480, 14)">
    <text x="190" y="0" font-size="13" font-weight="700" fill="currentColor">InputBatch state（max_num_reqs=4 示意）</text>
    <text x="0" y="22" font-size="10" fill="#64748b">_req_ids:</text>
    <g transform="translate(0, 30)">
      <rect x="0" y="0" width="55" height="24" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="27" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">A</text>
      <rect x="57" y="0" width="55" height="24" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
      <text x="84" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">B</text>
      <rect x="114" y="0" width="55" height="24" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="141" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">C</text>
      <rect x="171" y="0" width="55" height="24" fill="#fef3c7" stroke="#facc15" stroke-width="1.5" stroke-dasharray="3,2"/>
      <text x="198" y="16" text-anchor="middle" font-size="10" font-weight="700" fill="#a16207">X ← 新</text>
    </g>
    <text x="0" y="78" font-size="10" fill="#64748b">token_ids_cpu (2D, [max_num_reqs, max_model_len]):</text>
    <g transform="translate(0, 88)">
      <rect x="0" y="0" width="280" height="20" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="140" y="14" text-anchor="middle" font-size="9" fill="currentColor">row 0: tok(A)...</text>
      <rect x="0" y="22" width="280" height="20" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
      <text x="140" y="36" text-anchor="middle" font-size="9" fill="currentColor">row 1: tok(B)...</text>
      <rect x="0" y="44" width="280" height="20" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="140" y="58" text-anchor="middle" font-size="9" fill="currentColor">row 2: tok(C)...</text>
      <rect x="0" y="66" width="280" height="20" fill="#fef3c7" stroke="#facc15" stroke-width="1.5"/>
      <text x="140" y="80" text-anchor="middle" font-size="9" font-weight="700" fill="#92400e">row 3: [1, 2, 3] ← 刚填</text>
    </g>
    <text x="0" y="200" font-size="10" fill="#64748b">分类 set（每条 sampling 字段对应一个）：</text>
    <g transform="translate(0, 212)">
      <rect x="0" y="0" width="130" height="20" rx="3" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
      <text x="65" y="14" text-anchor="middle" font-size="10" fill="currentColor">greedy_reqs: {A, X}</text>
      <rect x="138" y="0" width="130" height="20" rx="3" fill="#f0fdfa" stroke="#0d9488" stroke-width="1"/>
      <text x="203" y="14" text-anchor="middle" font-size="10" fill="currentColor">top_p_reqs: {B}</text>
      <rect x="0" y="26" width="268" height="20" rx="3" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
      <text x="134" y="40" text-anchor="middle" font-size="10" fill="currentColor">… 其它 sampling 字段</text>
    </g>
    <text x="0" y="280" font-size="10" fill="#94a3b8">SoA 关键：增删请求只更新单 slot，不重建任何 GPU tensor</text>
    <text x="0" y="294" font-size="10" fill="#94a3b8">refresh_metadata 只 H2D 实际被 dirty 的字段</text>
  </g>
</svg>
<span class="figure-caption">图 R6.4 ｜ 一个新请求加入 InputBatch 的全过程：所有 sampling 字段都是按列存放的 max_num_reqs 长 tensor，add 只往第 req_index 行写一次，避免每步重建。</span>

<details>
<summary>ASCII 原版</summary>

```text
SchedulerOutput.scheduled_new_reqs                          InputBatch state（max_num_reqs=4 示意）
  ├─ NewReqData(req_X, prompt=[1,2,3], block_ids=([0,1],))      _req_ids: [A, B, C, None]
  │                                                              token_ids_cpu[2D]:
  │  add_request(req_X)                                            row 0: [tok(A)...]
  │   └─ _register_add_request                                     row 1: [tok(B)...]
  │       └─ pop_removed() 或 num_reqs++ -> req_index=3            row 2: [tok(C)...]
  │   └─ _req_ids[3] = "X"                                         row 3:  ← 即将填
  │   └─ req_id_to_index["X"] = 3
  │   └─ token_ids_cpu[3, :3] = [1, 2, 3]
  │   └─ num_prompt_tokens[3] = 3                              greedy_reqs: {A, X}
  │   └─ block_table.add_row(([0,1],), 3)                      top_p_reqs:  {B}
  │   └─ temperature_cpu[3] = 0.0                              ...
  │   └─ greedy_reqs.add("X")
  │
  ├─ NewReqData(req_Y, ...)  add_request -> req_index=...
  ...
```

</details>

`req_index` 由 `_register_add_request`（`:309`）决定：
- 优先复用上一步刚 `remove_request` 留下的空位（`batch_update_builder.pop_removed()`）。
- 否则追加到 `num_reqs`。

### 6.5.3 请求移除与 `condense`

`remove_request`（`gpu_input_batch.py:510`）只清空 slot 并把 index 推入 `batch_update_builder.removed`。它**不**搬迁数据。条件再多请求加入时，这些空位会优先复用。

如果一步内 remove 多 add 少，空位散落在 batch 中间，最终需要调用 `condense`（`:683`）压缩：把后段非空 slot 整体搬到前段空 slot，保证 `num_reqs` 个有效 req 占据 `[0, num_reqs)` 连续区域。

**为什么必须连续**：attention kernel、采样 kernel 都按 `[0, num_reqs)` 切片操作；为 CUDA graph 捕获的 buffer 大小固定，必须保证 batch 内的有效行连续。

### 6.5.4 metadata 缓存与 `refresh_metadata`

`SamplingMetadata`（GPU tensor 的集合）也是缓存的：只在 `batch_update_builder` 报告 batch 实际变化时（`refresh_metadata`，`:811`）重新构造。每一步 logits processor 通过 `update_state(batch_update)` 拿到精确的"哪些 req 被加 / 删 / 移动"。这个细颗粒度更新是 V1 输入路径"零拷贝"的关键。

---

## 6.6 `BlockTable` 与 slot mapping

`vllm/v1/worker/block_table.py:18` 的 `BlockTable` 把每个 req 持有的 KV cache block id 表（来自 KV cache manager）落到 GPU 上。

### 6.6.1 数据布局

```text
block_table.np    shape: [max_num_reqs, max_num_blocks_per_req]   int32
block_table.gpu   同步上来的 GPU tensor
num_blocks_per_row[max_num_reqs]   每行有效 block 数（CPU only）
slot_mapping      shape: [max_num_batched_tokens]   int64
```

`append_row` / `add_row` / `clear_row` / `move_row` / `swap_row`（`:102`-`:139`）对应 `InputBatch` 的 add/remove/condense 操作。
`commit_block_table(num_reqs)`（`:166`）把前 `num_reqs` 行 H2D 拷贝过去。

### 6.6.2 Hybrid block：`block_size != kernel_block_size`

KV cache manager 分配的 block 可能比 attention kernel 接受的 block 大。例如 manager block = 32 token，kernel block = 16 token，那么 `blocks_per_kv_block = 2`，每个 manager block 映射到两个连续 kernel block：

```python
# block_table.py:184
>>> kv_manager_block_ids = np.array([0, 1, 2])
>>> map_to_kernel_blocks(...) -> [0, 1, 2, 3, 4, 5]
```

**为什么搞这种映射**：让 KV cache manager（按 page 思想分配）和 attention backend（按硬件向量长度组织）解耦。block 16/32/64/128 是不同 backend 的最优长度，allocation 粒度可以单独优化。

### 6.6.3 `compute_slot_mapping`：把绝对位置→物理 slot

`compute_slot_mapping`（`:141`）启动一个 Triton kernel（`_compute_slot_mapping_kernel`，`:325`）：

```python
# 概念伪代码（block_table.py:341-381）
for token in batch:
    pos = positions[token]                     # 该 token 的绝对位置
    block_idx = pos // virtual_block_size      # 它在哪个逻辑 block
    block_num = block_table[req, block_idx]    # 这个逻辑 block 在物理上是几号
    slot_id   = block_num * block_size + (pos % block_size)
    slot_mapping[token] = slot_id              # KV write 直接 store 到这个 slot
```

这一步把"绝对 token 位置 → 物理 KV slot"的映射准备好。attention kernel 的 KV write 路径只看 `slot_mapping`：第 i 个 token 的 K/V 应该写到 `kv_cache[slot_mapping[i]]`。kernel 还会用 `PAD_SLOT_ID`（`:11`）填充剩余位置，确保 CUDA graph capture 的固定 shape 下也安全（被 padding 的 token 不会写入有效 slot）。

DCP（decode context parallel）/ PCP（prefill context parallel）下，KV 在多 rank 间切分；kernel 用 `is_local` mask 决定该 token 是否归本 rank 处理（`:369`-`:379`）。不归本 rank 的 token 写 `PAD_SLOT_ID`。

`MultiGroupBlockTable`（`:223`）持有多个 `BlockTable`——每个 KV cache group 一份（full attention / sliding window / mamba 等可以是不同 group）。

---

## 6.7 `execute_model()` 主循环

`gpu_model_runner.py:3912` 的 `execute_model` 是单步前向的入口。结构上分四个阶段：

<svg viewBox="0 0 880 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="GPUModelRunner.execute_model 四阶段主循环 + sample_tokens 后半段">
  <defs>
    <marker id="ar65" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 14)">
    <rect x="0" y="0" width="840" height="476" rx="8" fill="none" stroke="#cbd5e1" stroke-width="1.2"/>
    <text x="420" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">GPUModelRunner.execute_model(scheduler_output, intermediate_tensors)</text>
    <g transform="translate(14, 38)">
      <rect x="0" y="0" width="812" height="160" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
      <text x="14" y="20" font-size="12" font-weight="700" fill="#ea580c">阶段 A：同步输入准备</text>
      <g transform="translate(14, 32)">
        <rect x="0" y="0" width="250" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="125" y="14" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_update_states()</text>
        <text x="125" y="26" text-anchor="middle" font-size="9" fill="#64748b">InputBatch 增删 req</text>
        <rect x="260" y="0" width="250" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="385" y="14" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_prepare_inputs()</text>
        <text x="385" y="26" text-anchor="middle" font-size="9" fill="#64748b">CPU 拼装 + H2D 拷贝</text>
        <rect x="520" y="0" width="260" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="650" y="14" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_determine_batch_execution_and_padding</text>
        <text x="650" y="26" text-anchor="middle" font-size="9" fill="#64748b">选 CUDA graph mode + padding</text>
        <rect x="0" y="38" width="250" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="125" y="52" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">maybe_create_ubatch_slices</text>
        <text x="125" y="64" text-anchor="middle" font-size="9" fill="#64748b">切分微批（可选）</text>
        <rect x="260" y="38" width="250" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="385" y="52" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_get_slot_mappings</text>
        <text x="385" y="64" text-anchor="middle" font-size="9" fill="#64748b">KV slot 写入位置表</text>
        <rect x="520" y="38" width="260" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="650" y="52" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_build_attention_metadata</text>
        <text x="650" y="64" text-anchor="middle" font-size="9" fill="#64748b">CommonAttentionMetadata → backend</text>
        <rect x="260" y="76" width="250" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
        <text x="385" y="90" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_preprocess()</text>
        <text x="385" y="102" text-anchor="middle" font-size="9" fill="#64748b">MM encoder / embed / PP recv</text>
      </g>
    </g>
    <line x1="420" y1="200" x2="420" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
    <g transform="translate(14, 220)">
      <rect x="0" y="0" width="812" height="66" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
      <text x="14" y="20" font-size="12" font-weight="700" fill="#7c3aed">阶段 B：forward</text>
      <rect x="80" y="28" width="652" height="30" rx="4" fill="#f5f3ff" stroke="#7c3aed"/>
      <text x="406" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">with set_forward_context(attn_metadata, cudagraph_mode, batch_desc, ubatch_slices):</text>
      <text x="406" y="54" text-anchor="middle" font-size="10" fill="#64748b">model_output = self._model_forward(input_ids, positions, ...)</text>
    </g>
    <line x1="420" y1="288" x2="420" y2="306" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
    <g transform="translate(14, 308)">
      <rect x="0" y="0" width="812" height="100" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/>
      <text x="14" y="20" font-size="12" font-weight="700" fill="#0d9488">阶段 C：后处理 + logits</text>
      <text x="14" y="42" font-size="11" fill="currentColor">hidden_states = model_output</text>
      <text x="14" y="58" font-size="10" fill="#64748b">if 非 last PP rank: → return IntermediateTensors</text>
      <text x="14" y="72" font-size="10" fill="#64748b">elif pooling model: → return self._pool(...)</text>
      <text x="14" y="86" font-size="10" fill="#64748b">else: sample_hidden_states = hidden_states[logits_indices]; logits = model.compute_logits(...)</text>
    </g>
    <line x1="420" y1="410" x2="420" y2="428" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
    <g transform="translate(14, 430)">
      <rect x="0" y="0" width="812" height="40" rx="6" fill="#fef3c7" stroke="#facc15" stroke-width="1.2"/>
      <text x="406" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">阶段 D：把状态存入 self.execute_model_state，返回 None</text>
      <text x="406" y="32" text-anchor="middle" font-size="10" fill="#a16207">让 grammar bitmask 异步算完再 sample（结构化输出走 critical path 之外）</text>
    </g>
  </g>
  <line x1="440" y1="490" x2="440" y2="510" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar65)"/>
  <text x="450" y="504" font-size="10" fill="#64748b">Worker 紧接调用</text>
  <g transform="translate(20, 512)">
    <rect x="0" y="0" width="840" height="78" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="420" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">sample_tokens(grammar_output)</text>
    <g transform="translate(14, 30)">
      <rect x="0" y="0" width="155" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="77" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">apply_grammar_bitmask</text>
      <text x="77" y="30" text-anchor="middle" font-size="9" fill="#64748b">结构化输出 mask</text>
      <rect x="163" y="0" width="155" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="240" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_sample()</text>
      <text x="240" y="30" text-anchor="middle" font-size="9" fill="#64748b">→ SamplerOutput</text>
      <rect x="326" y="0" width="155" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="403" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_update_states_after</text>
      <text x="403" y="30" text-anchor="middle" font-size="9" fill="#64748b">_model_execute</text>
      <rect x="489" y="0" width="155" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="566" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">propose_draft_tokens</text>
      <text x="566" y="30" text-anchor="middle" font-size="9" fill="#64748b">spec decode</text>
      <rect x="652" y="0" width="155" height="38" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="729" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">_bookkeeping_sync</text>
      <text x="729" y="30" text-anchor="middle" font-size="9" fill="#64748b">→ ModelRunnerOutput</text>
    </g>
  </g>
</svg>
<span class="figure-caption">图 R6.5 ｜ execute_model 的四阶段主循环（阶段 A 同步准备 → B forward → C logits → D 暂停返回 None），紧接由 Worker 调度的 sample_tokens 完成结构化 mask、采样、spec decode 三步后才出 ModelRunnerOutput。</span>

<details>
<summary>ASCII 原版</summary>

```text
+--------------------------------------------------------------------------+
| execute_model(scheduler_output, intermediate_tensors)                    |
|                                                                          |
|  阶段 A: 同步输入准备                                                    |
|  ┌─────────────────────────────────────────────────────────────────┐    |
|  │ _update_states()                       # 增删 req，更新 InputBatch │    |
|  │ _prepare_inputs()                      # CPU 拼装 + H2D 拷贝       │    |
|  │ _determine_batch_execution_and_padding # 选 CUDA graph 模式/padding │    |
|  │ maybe_create_ubatch_slices             # 切分微批                   │    |
|  │ _get_slot_mappings                     # KV slot 表                 │    |
|  │ _build_attention_metadata              # AttentionMetadata          │    |
|  │ _preprocess()                          # MM encoder/embed/PP recv   │    |
|  └─────────────────────────────────────────────────────────────────┘    |
|                                                                          |
|  阶段 B: forward                                                         |
|  ┌─────────────────────────────────────────────────────────────────┐    |
|  │ with set_forward_context(attn_metadata, cudagraph_runtime_mode,  │    |
|  │                          batch_descriptor, ubatch_slices, ...):  │    |
|  │     model_output = self._model_forward(input_ids, positions,...) │    |
|  └─────────────────────────────────────────────────────────────────┘    |
|                                                                          |
|  阶段 C: 后处理 + logits                                                 |
|  ┌─────────────────────────────────────────────────────────────────┐    |
|  │ hidden_states = model_output                                     │    |
|  │ 若非 last PP rank: return IntermediateTensors                    │    |
|  │ 若 pooling model: return self._pool(...)                         │    |
|  │ 否则: sample_hidden_states = hidden_states[logits_indices]       │    |
|  │       logits = self.model.compute_logits(sample_hidden_states)   │    |
|  └─────────────────────────────────────────────────────────────────┘    |
|                                                                          |
|  阶段 D: 把状态存入 self.execute_model_state，返回 None                 |
+--------------------------------------------------------------------------+
                            │
                            ▼ Worker 紧接调用
+--------------------------------------------------------------------------+
| sample_tokens(grammar_output)                                            |
|   - apply_grammar_bitmask (结构化输出 mask)                              |
|   - _sample()  -> SamplerOutput                                          |
|   - _update_states_after_model_execute()                                 |
|   - propose_draft_token_ids() (spec decode)                              |
|   - _bookkeeping_sync()                                                  |
|   - 返回 ModelRunnerOutput / AsyncModelRunnerOutput                      |
+--------------------------------------------------------------------------+
```

</details>

`execute_model` 在阶段 D 之所以返回 `None` 而非直接 sample，是为了**让结构化输出（structured outputs）有机会异步计算 grammar bitmask**：scheduler 在调度本步时启动 grammar 计算（CPU 上），worker forward GPU 上算 logits，等 forward 完成时 grammar 也几乎就绪——`sample_tokens` 拿到 `grammar_output` 才动手把 bitmask apply 到 logits 上。这一切都为了让 grammar 不挡在 critical path 上。`WorkerBase.execute_model` 的注释（`worker_base.py:142`-`:150`）专门解释了这一点。

`ExecuteModelState`（`gpu_model_runner.py:395`-`:412`）保存中间结果以传递给 `sample_tokens`：scheduler_output、logits、spec_decode_metadata、hidden_states 等。

---

## 6.8 `_prepare_inputs()`：把多请求拼成连续 tensor

`gpu_model_runner.py:1839` 的 `_prepare_inputs` 是把"N 个不同长度 req"翻译成"一根扁平 tensor"的核心。

### 6.8.1 拼装过程

设当前调度了 3 个请求，分别 schedule 了 [2, 5, 3] 个 token（混合 prefill + decode 是常态）：

```text
num_scheduled_tokens = [2, 5, 3]      total = 10

req_indices   = repeat([0,1,2], [2,5,3])
              = [0, 0, 1, 1, 1, 1, 1, 2, 2, 2]      # 每个 token 属于哪个 req

cu_num_tokens = cumsum([2,5,3])
              = [2, 7, 10]

query_pos     = [0,1, 0,1,2,3,4, 0,1,2]              # 每 token 在自身 req 的偏移

positions     = num_computed[req_indices] + query_pos
              = [ Cb,  Cb+1,  Cc, Cc+1, Cc+2, Cc+3, Cc+4,  Cd, Cd+1, Cd+2 ]

query_start_loc = [0, 2, 7, 10]                       # 每段在 flat 序列里的起点

token_indices  = positions + req_indices * max_model_len
input_ids      = token_ids_cpu.flatten()[token_indices]
               = [t0, t1, t2, t3, ..., t9]            # flat 整批的 token id
```

代码实现摘录（`gpu_model_runner.py:1863`-`:1904`）：

```python
req_indices = np.repeat(self.arange_np[:num_reqs], num_scheduled_tokens)
cu_num_tokens = self._get_cumsum_and_arange(
    num_scheduled_tokens, self.query_pos.np
)
positions_np = (
    self.input_batch.num_computed_tokens_cpu[req_indices]
    + self.query_pos.np[: cu_num_tokens[-1]]
)
token_indices = (
    positions_np + req_indices * self.input_batch.token_ids_cpu.shape[1]
)
token_indices_tensor = torch.from_numpy(token_indices)
torch.index_select(
    self.input_batch.token_ids_cpu_tensor.flatten(),
    0, token_indices_tensor,
    out=self.input_ids.cpu[:total_num_scheduled_tokens],
)
```

`torch.index_select` 比 `np.take` 在大 tensor 上快得多——注释（`:1896`）专门说明。

### 6.8.2 H2D 拷贝时机

`_prepare_inputs` 把所有 metadata 准备好后才一次性 H2D。关键的 H2D 调用：

```python
# gpu_model_runner.py:1958
self.query_start_loc.copy_to_gpu()
# :2010
self.num_accepted_tokens.copy_to_gpu()
# :2044
self.req_indices.copy_to_gpu(total_num_scheduled_tokens)
# :2047
self.query_pos.copy_to_gpu(total_num_scheduled_tokens)
# :2049
self.num_scheduled_tokens.copy_to_gpu(num_reqs)
```

之前 `_prepare_inputs` 一开始就调用了 `self.input_batch.block_table.commit_block_table(num_reqs)`（`:1859`），把 block table 先发出去——目的是 overlap：H2D 在后台进行的同时，CPU 继续做剩余拼装。

### 6.8.3 `_prepare_input_ids` 与 async scheduling

`_prepare_input_ids`（`:1665`）专门处理 async scheduling 下的"input_ids 拷贝"——async 模式下上一步采样的 token 还没到 CPU，本步需要从 GPU 上的 `prev_sampled_token_ids` 拼接到 `input_ids`。

### 6.8.4 `_calc_spec_decode_metadata`

如果有 speculative decode draft token（`scheduler_output.scheduled_spec_decode_tokens` 非空），`_calc_spec_decode_metadata`（`:2670`）生成 `SpecDecodeMetadata`：logits_indices 和 num_draft_tokens 等。无 spec 时 `logits_indices = query_start_loc[1:] - 1`，即每个 req 的最后一个 token（`:2102`）。

---

## 6.9 attention metadata：prefill 与 decode 的统一表达

`_build_attention_metadata`（`gpu_model_runner.py:2150`）把上一步生成的 `query_start_loc`、`seq_lens`、`block_table_tensor`、`slot_mapping` 装入 `CommonAttentionMetadata`（`vllm/v1/attention/backend.py`）：

```python
# gpu_model_runner.py:2244
cm_base = CommonAttentionMetadata(
    query_start_loc=self.query_start_loc.gpu[: num_reqs_padded + 1],
    query_start_loc_cpu=self.query_start_loc.cpu[: num_reqs_padded + 1],
    seq_lens=self.seq_lens[:num_reqs_padded],
    _seq_lens_cpu=seq_lens_cpu,
    _num_computed_tokens_cpu=num_computed_tokens_cpu,
    ...
    block_table_tensor=block_table_gid_0,
    slot_mapping=slot_mapping_gid_0,
)
```

每个 KV cache group（full / sliding-window / mamba 等）有自己的 `AttentionMetadataBuilder`（来自 `self.attn_groups`，§6.10），每个 builder 把 `CommonAttentionMetadata` 转成自己 backend 需要的具体 metadata（如 FlashAttention 的 scheduler_metadata、ChunkedLocalAttention 的 window mask）。

**统一 batch 的核心 invariant**：
- `query_start_loc[i+1] - query_start_loc[i]` 是第 i 个 req 本步的 query 长度（prefill 是大数、decode 是 1）。
- `seq_lens[i]` 是第 i 个 req 的 KV 总长度（含本步），attention kernel 对每个 req 做 `query[query_start_loc[i]:query_start_loc[i+1]]` × `K[0:seq_lens[i]]`。
- `block_table_tensor[i]` 给 backend KV gather 用的物理 block id。
- `slot_mapping[token_idx]` 给 KV write 用。

prefill 和 decode 只是"query 长度不同"的特例——没有专门的"prefill kernel"或"decode kernel"路径。但是某些 backend（FA2/3）对纯 decode 有专门优化（FlashDecode），所以 dispatcher 会区分 `uniform_decode`（见 §6.10）。

`for_cudagraph_capture=True` 时（`:2180`），`max_seq_len = self.max_model_len`——sliding window backend 需要看到比 window size 大的 max_seq_len 才会选对 kernel。

---

## 6.10 CUDA Graph：dispatcher、捕获与回放

CUDA graph 是 vLLM V1 性能的关键。复杂度在于：不同 batch shape 需要不同 graph，而 vLLM 同时支持 piecewise（按算子切分捕获）和 full（端到端捕获）两种模式。

### 6.10.1 三种 mode

`CUDAGraphMode`（`vllm/config/__init__.py` 中定义）：

- `NONE` —— 不捕获，纯 eager。
- `PIECEWISE` —— 把 model.forward 按 attention 切成几段，每段是一个 graph。attention 之外用 graph 跑，attention 用 eager（attention metadata 复杂、batch shape 变多，全 graph 化的成本很高）。
- `FULL` —— 整段 forward 都进 graph，包括 attention。要求 batch 必须 padding 到捕获过的某个 size。

### 6.10.2 `CudagraphDispatcher`

`vllm/v1/cudagraph_dispatcher.py:15` 的 `CudagraphDispatcher` 是运行时调度器：根据 `(num_tokens, uniform_decode, has_lora, num_active_loras)` 等条件选择"用哪种 mode + 哪个 batch_descriptor"。

核心数据结构是两个集合：
```python
# cudagraph_dispatcher.py:44
self.cudagraph_keys: dict[CUDAGraphMode, set[BatchDescriptor]] = {
    CUDAGraphMode.PIECEWISE: set(),
    CUDAGraphMode.FULL: set(),
}
```

`initialize_cudagraph_keys`（`:170`）在 attention backend 初始化完成后填充这两个集合。对每个 `cudagraph_capture_sizes` 中的 `bs`、每个 lora 配置，生成一个 `BatchDescriptor`：

```python
# cudagraph_dispatcher.py:197
for bs, num_active_loras in product(
    self.compilation_config.cudagraph_capture_sizes, lora_cases
):
    batch_desc = self._create_padded_batch_descriptor(
        bs, False, num_active_loras > 0, num_active_loras
    )
    if cudagraph_mode.mixed_mode() == CUDAGraphMode.PIECEWISE:
        batch_desc = replace(batch_desc, num_reqs=None, uniform=False)
    self.add_cudagraph_key(cudagraph_mode.mixed_mode(), batch_desc)
```

PIECEWISE 的 key 把 `num_reqs` 设为 `None`、`uniform=False`，因为 PIECEWISE graph 只捕非 attention 部分，不关心 batch 内的 req 分布。FULL 的 key 必须精确——FA3 的 scheduler_metadata 与 num_reqs 绑定。

`dispatch`（`:239`）：

```python
batch_desc = self._create_padded_batch_descriptor(...)
if CUDAGraphMode.FULL in allowed_modes:
    if batch_desc in self.cudagraph_keys[CUDAGraphMode.FULL]:
        return CUDAGraphMode.FULL, batch_desc
if CUDAGraphMode.PIECEWISE in allowed_modes:
    relaxed = replace(batch_desc, num_reqs=None, uniform=False)
    if relaxed in self.cudagraph_keys[CUDAGraphMode.PIECEWISE]:
        return CUDAGraphMode.PIECEWISE, relaxed
return CUDAGraphMode.NONE, BatchDescriptor(num_tokens)
```

逻辑直白：先看 FULL graph 有没有匹配的 key，没有再退化到 PIECEWISE，再不行就 eager。

### 6.10.3 Forward context 把 mode 注入算子

`execute_model`（`gpu_model_runner.py:4155`-`:4166`）用 `set_forward_context` 把 `cudagraph_runtime_mode`、`batch_descriptor` 写入线程局部 forward context。
`CUDAGraphWrapper`（`vllm/compilation/cuda_graph.py`）包裹的算子在 forward 时读 forward context：

- 若 `cudagraph_runtime_mode` 与自己的 mode 匹配，且 batch_desc 在自己的 capture 表里 → 回放。
- 否则 → 透传到底层 eager runnable。

这就是"分发器的 key 是 graph 是否存在的唯一真理来源"的含义（dispatcher 的 docstring，`:23`-`:32`）。

### 6.10.4 `capture_model` 实际捕获

`capture_model`（`gpu_model_runner.py:6303`）：

1. 启用 cudagraph capture: `set_cudagraph_capturing_enabled(True)`（`:6345`）。
2. 进入 `graph_capture(device=...)` 上下文。
3. 对每个 `(runtime_mode, batch_descs)`（从 dispatcher.get_capture_descs() 拿，大 batch 先捕获以便复用内存池）：调用 `_capture_cudagraphs`，它内部对每个 batch_desc 调用 `_warmup_and_capture`（`:6393`），先做 N 次 warmup forward（不捕获），最后一次设 `cudagraph_runtime_mode=mode`，由 `CUDAGraphWrapper` 实际记录 graph。
4. 捕获结束后 lock workspace（防止后续 resize），关闭全局捕获开关——之后任何意外的 graph capture 都会报错。

### 6.10.5 Piecewise 编译

`vllm/compilation/` 下的 inductor 编译流程把 model 按 `splitting_ops`（默认是 attention op 等）拆段，每段编译为独立 graph：

- `vllm/compilation/breakable_cudagraph.py` —— 支持运行时"打断" graph 的实验性 wrapper（最近的 PR #42304）。
- `vllm/compilation/cuda_graph.py` —— 标准 CUDAGraphWrapper。

dispatcher 的 `assert` 强制：使用 piecewise cudagraph 必须 `CompilationMode.VLLM_COMPILE`（`:53`-`:65`）。

---

## 6.11 微批 / ubatching（DBO）

`vllm/v1/worker/ubatching.py` 和 `vllm/v1/worker/ubatch_utils.py` 实现 vLLM 的 "Dual Batch Overlap"（DBO）。

### 6.11.1 目的

DP（data parallel）/ EP（expert parallel）场景下，通信（all-to-all、all-reduce）占很大比重。如果把一个 batch 切成两个 micro-batch，让 micro-batch A 跑 compute 时 micro-batch B 跑 comm，两条 stream 互相 overlap，可以隐藏通信延迟。

### 6.11.2 切分

`maybe_create_ubatch_slices`（`ubatch_utils.py:63`）按 token 数对半切：

```python
split_point = num_tokens_padded // num_ubatches  # 默认 2
token_split_points = [split_point * i for i in range(1, num_ubatches)]
```

返回 `UBatchSlice(request_slice, token_slice)` 列表。一个请求可以横跨两个 slice（如果 prefill 很长），slice 自带"是否跨界"的元数据，`_make_metadata_with_slice`（`ubatch_utils.py:134`）按需调整 `query_start_loc[-1]` 和 `seq_lens[-1]`。

### 6.11.3 双线程同步：`UBatchContext`

`UBatchContext`（`ubatching.py:20`）是关键：每个 ubatch 跑在一条 worker 线程上，两个线程通过 CPU `Event` 协调，再用 CUDA Event 在 compute_stream / comm_stream 上排序。

```text
              cpu_signal_event/wait_event  ←→  另一个 ubatch 线程
              gpu_compute_done_event       (compute_stream)
              gpu_comm_done_event          (comm_stream)
```

`switch_to_comm_sync` / `switch_to_compute_sync` 是模型代码里手动插入的"切换点"。MoE 的 dispatch/combine、TP all-gather 等位置会调用：

```python
dbo_yield_and_switch_from_compute_to_comm()    # 我（A）算完 compute，切到 comm，让 B 跑 compute
... NCCL collective ...
dbo_yield_and_switch_from_comm_to_compute()    # comm 完，切回 compute
```

### 6.11.4 包装：`UBatchWrapper`

`vllm/v1/worker/gpu_ubatch_wrapper.py:113` 的 `UBatchWrapper` 把 model 的 `forward` 整体包装成"分两条线程跑"。`make_ubatch_contexts`（`ubatching.py:202`）一次性创建 N 个 `UBatchContext`、N 个 CUDA Event、配套 CPU Event。`SMControlContextManager`（`gpu_ubatch_wrapper.py:68`）还能控制 NCCL kernel 占用的 SM 数（留更多 SM 给 compute）。

阈值控制在 `check_ubatch_thresholds`（`ubatch_utils.py:38`）：`dbo_decode_token_threshold` / `dbo_prefill_token_threshold` 决定 batch 多大才值得开 ubatch。

`_determine_batch_execution_and_padding`（`gpu_model_runner.py:3679`）的返回值之一 `should_ubatch` 控制本步是否走 ubatching。

---

## 6.12 多模态编码器与 `encoder_cudagraph`

多模态模型的 vision encoder 与 LM 解码是两个截然不同的 workload：
- **Encoder**：单次输入是固定 shape 的图像/视频帧 batch，可独立捕获 graph。
- **LM**：mixed prefill+decode 的动态 batch。

`vllm/v1/core/encoder_cache_manager.py:17` 的 `EncoderCacheManager` 是 EngineCore 端的资源管理：决定哪些 mm input 当步可以 encode、缓存大小（按 token budget）。Worker 端的 `self.encoder_cache: dict[str, torch.Tensor]`（`gpu_model_runner.py:528`）保存实际的 vision embedding。`encode` 在 `_execute_mm_encoder`（`:2817`）里跑。

`vllm/v1/worker/encoder_cudagraph.py:50` 的 `EncoderCudaGraphManager` 是 budget-based CUDA graph 捕获器：
- `token_budgets`：捕获 N 个 budget 大小（例如 1024、2048、4096 token），每个 budget 一个 graph。
- `BudgetGraphMetadata`（`:26`）：每个 budget 对应一组 `(input_buffer, metadata_buffers, output_buffer, graph)`。运行时把当前 mm batch 拷贝到 `input_buffer`，replay graph，从 `output_buffer` 读 embedding。

`capture_model`（`gpu_model_runner.py:6361`）在 LM graph 捕获完后会触发 `self.encoder_cudagraph_manager.capture()`。

`vllm/v1/worker/encoder_cudagraph_defs.py` 定义 `EncoderCudaGraphConfig`，模型类（如 Qwen2-VL）通过 `SupportsEncoderCudaGraph.get_encoder_cudagraph_config` 暴露自己的 token budget 范围。

---

## 6.13 Connector mixin：KV / EC / LoRA

`GPUModelRunner` 用 mixin 注入跨子系统的功能：

```python
# gpu_model_runner.py:418 (类签名所在 import 区)
from vllm.v1.worker.ec_connector_model_runner_mixin import ECConnectorModelRunnerMixin
from vllm.v1.worker.kv_connector_model_runner_mixin import KVConnectorModelRunnerMixin
from vllm.v1.worker.lora_model_runner_mixin import LoRAModelRunnerMixin
```

### 6.13.1 `KVConnectorModelRunnerMixin`

`vllm/v1/worker/kv_connector_model_runner_mixin.py:36` 提供 KV transfer connector 在 `execute_model` 的生命周期 hooks：

- `kv_connector_no_forward`（`:38`）—— 没有调度 token 但 connector 仍需做 send/recv 时用。
- `maybe_get_kv_connector_output`（`:57`）—— 在 forward 期间打开 context，触发 `start_load_kv` 与最终的 `get_finished` / `wait_for_save`。
- `finalize_kv_connector`（`:71`）—— spec decode 场景下，drafter 跑完才能 finalize（避免提前丢弃 metadata）。
- `allocate_uniform_kv_caches`（`:193`）—— 当 connector 偏好"所有层共享一个连续 KV 张量"的 layout（cross-layer block）时使用。

`use_uniform_kv_cache`（`:122`）会做严格的兼容性检查：单 KV group + connector 支持 + flash backend 给出 layers 维度才返回 True。

### 6.13.2 `ECConnectorModelRunnerMixin`

`vllm/v1/worker/ec_connector_model_runner_mixin.py:25` 是 encoder cache (EC) connector 的等价物：用于解耦 encoder-only instance（专门跑 vision encoder）与 LM instance（EPD disaggregation）。consumer 端 `start_load_caches`，producer 端 `save_caches`。

### 6.13.3 `LoRAModelRunnerMixin`

`vllm/v1/worker/lora_model_runner_mixin.py:30` 持有 `LRUCacheWorkerLoRAManager`。
- `set_active_loras`（`:73`）——在 `_prepare_inputs` 末尾（`gpu_model_runner.py:2141`）每步调用，按 `request_lora_mapping` 决定哪些 adapter 需要 activate。
- `maybe_dummy_run_with_lora`——为 dummy_run/capture 阶段提供模拟的 LoRA activation，否则 cudagraph 捕获时 lora 不在线就无法 trace 相关分支。

---

## 6.14 `_dummy_run()`、`profile_run()`、`capture_model()`

这三个方法不在运行时 critical path，但理解它们才能理解 vLLM 为何启动慢。

### 6.14.1 `_dummy_run`（`gpu_model_runner.py:5468`）

构造一个假 batch 跑一次 forward。三种模式（参数 `uniform_decode`、`create_mixed_batch`）：
- `uniform_decode=True` —— `num_reqs = num_tokens / max_query_len`，每个 req `max_query_len` 个 token，用于 FULL graph 捕获 decode-only batch。
- `create_mixed_batch=True` —— 一半 decode（1 token/req）+ 一个长 prefill，用于 warmup mixed batch。
- 默认 —— 尽量平均分配 token 到 `num_reqs` 个 req。

跑完之后通过 `slot_mappings.fill_(-1)`（`:5635`）确保 KV write 不写入有效 slot（dummy 不能污染真实 KV cache）。

### 6.14.2 `profile_run`（`gpu_model_runner.py:6034`）

`Worker.determine_available_memory` 调用它。先跑一遍 mm encoder（如果有）、然后 `_dummy_run(self.max_num_tokens, is_profile=True)`，再跑 `_dummy_sampler_run` / `_dummy_pooler_run`。
`memory_profiling` 上下文管理器测出整段的峰值 activation 内存，作为 KV 容量计算的输入。

### 6.14.3 `capture_model`（`gpu_model_runner.py:6303`）

`Worker.compile_or_warm_up_model` 调用它。流程见 §6.10.4。它独立于 KV cache 大小，但**需要**真实 KV cache 已经分配——`compile_or_warm_up_model` 在 `initialize_from_config` 之后被调用，KV cache 是真实的。

`profile_cudagraph_memory`（`:6195`）是单独一段流程，用最小 KV cache 跑一次假捕获，量出 cuda graph pool 真实占用。这一步在 `determine_available_memory` 内、KV cache 真实分配**之前**调用——避免一开始就给 KV 留太多内存，结果 cuda graph 装不下。

---

## 6.15 Executor 抽象与三种实现

`Executor`（`vllm/v1/executor/abstract.py:37`）的核心方法是 `collective_rpc(method, args, kwargs, non_block)`：把一次调用扩散到所有 rank 的 worker。

```python
# abstract.py:198
@abstractmethod
def collective_rpc(
    self, method, timeout=None, args=(), kwargs=None, non_block: bool = False
):
    raise NotImplementedError
```

所有上层 API（`determine_available_memory`、`get_kv_cache_specs`、`execute_model`、`sample_tokens`、`add_lora`、`profile`、`sleep` 等）都封装为 `collective_rpc` 调用。`execute_model` 与 `sample_tokens` 支持 `non_block=True`——返回 Future，由调度循环在合适时机 `result()`。

### 6.15.1 `UniProcExecutor`

`vllm/v1/executor/uniproc_executor.py:45`。最简单实现：driver_worker 与 EngineCore 同进程，`collective_rpc` 直接 `run_method(self.driver_worker, method, args, kwargs)`（`:93`）。`non_block=True` 时把 `AsyncModelRunnerOutput` 包成 `AsyncOutputFuture`（`:26`）。

### 6.15.2 `MultiprocExecutor`

`vllm/v1/executor/multiproc_executor.py:102`。多卡场景常用：
- 通过 `MessageQueue`（shm-based）`rpc_broadcast_mq` 发送 `(method, args, kwargs, output_rank)`；
- N 个子进程的 `WorkerProc` 通过 `worker_busy_loop`（`:944`）轮询接收；
- 每个 worker 有自己的 `worker_response_mq`，把结果按 rank 回传；
- driver 一侧用 `FutureWrapper`（`:69`）做异步等待，队列 FIFO 保证不串号。

`execute_model`（`:306`）只从 `output_rank`（默认 last PP rank，`_get_output_rank`）拿一个返回值——其他 rank 的 forward 结果（中间 tensor）通过 PP send/recv 处理，不需要走 RPC 回路。

`start_worker_monitor`（`:267`）启动后台线程监听 worker sentinel：任一 worker 死亡立刻 shutdown 所有 worker + 触发 failure callback。

### 6.15.3 Ray executors

- `vllm/v1/executor/ray_executor.py` —— 旧版基于 Ray actor 的实现。
- `vllm/v1/executor/ray_executor_v2.py` —— 新版（`VLLM_USE_RAY_V2_EXECUTOR_BACKEND=1`），针对多节点优化的 actor + 消息队列混合方案。

Ray 后端的区别主要在于 actor 的 placement group、跨节点 NCCL 初始化、object store 的资源回收策略。`collective_rpc` 仍然是核心抽象。

### 6.15.4 `ExecutorWithExternalLauncher`

`vllm/v1/executor/uniproc_executor.py:149`。专为 torchrun 启动场景设计：每个进程一个 EngineCore + 一个 Executor + 一个 Worker，所有 EngineCore 跑相同 prompt + 确定性调度，因此可以避免 RPC 路径（`determine_available_memory` 用 `all_reduce(MIN)` 同步）。

### 6.15.5 选择哪个

`Executor.get_class`（`abstract.py:47`）按 `parallel_config.distributed_executor_backend` 选择：`"ray"` / `"mp"` / `"uni"` / `"external_launcher"` / 自定义路径。默认值由 `VllmConfig.__post_init__` 在解析 args 后确定。

---

## 6.16 Worker 与 EngineCore 的通信：Future 和 tensor IPC

### 6.16.1 控制面：消息队列 + Future

EngineCore 通过 `executor.execute_model(scheduler_output, non_block=True)` 发起一步。`MultiprocExecutor` 把 scheduler_output 序列化（msgpack）后写入 `rpc_broadcast_mq`：

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="EngineCore 与 Worker 之间通过消息队列 + Future 的控制面通信">
  <defs>
    <marker id="ar66" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 20)">
    <rect x="0" y="0" width="280" height="340" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
    <text x="140" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">EngineCore 进程</text>
    <g transform="translate(20, 38)">
      <rect x="0" y="0" width="240" height="40" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="120" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">EngineCore 调度循环</text>
      <text x="120" y="32" text-anchor="middle" font-size="9" fill="#64748b">每步发出 scheduler_output</text>
    </g>
    <line x1="140" y1="80" x2="140" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
    <text x="150" y="93" font-size="9" fill="#64748b">non_block=True</text>
    <g transform="translate(20, 100)">
      <rect x="0" y="0" width="240" height="40" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="120" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">executor.execute_model</text>
      <text x="120" y="32" text-anchor="middle" font-size="9" fill="#64748b">序列化 (msgpack) → enqueue</text>
    </g>
    <g transform="translate(20, 162)">
      <rect x="0" y="0" width="240" height="32" rx="4" fill="#fef3c7" stroke="#facc15"/>
      <text x="120" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="#92400e">返回 FutureWrapper → futures_queue</text>
    </g>
    <text x="20" y="222" font-size="11" font-weight="700" fill="#7c3aed">稍后：</text>
    <g transform="translate(20, 234)">
      <rect x="0" y="0" width="240" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="120" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">future.result()</text>
    </g>
    <text x="20" y="280" font-size="9" fill="#64748b">从对应 worker 的 response mq 出队</text>
    <g transform="translate(20, 290)">
      <rect x="0" y="0" width="240" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="120" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">拿到 ModelRunnerOutput</text>
    </g>
  </g>
  <g transform="translate(320, 70)">
    <rect x="0" y="0" width="240" height="48" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
    <text x="120" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">rpc_broadcast_mq</text>
    <text x="120" y="36" text-anchor="middle" font-size="10" fill="#64748b">shm-based MessageQueue（请求）</text>
    <rect x="0" y="170" width="240" height="48" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
    <text x="120" y="190" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">worker_response_mq</text>
    <text x="120" y="206" text-anchor="middle" font-size="10" fill="#64748b">每个 worker 一份（响应）</text>
  </g>
  <line x1="300" y1="120" x2="316" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
  <line x1="564" y1="94" x2="600" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
  <line x1="600" y1="264" x2="564" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
  <line x1="316" y1="264" x2="300" y2="306" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
  <g transform="translate(600, 20)">
    <rect x="0" y="0" width="260" height="340" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="130" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Worker 子进程</text>
    <g transform="translate(20, 60)">
      <rect x="0" y="0" width="220" height="40" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="110" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">worker_busy_loop</text>
      <text x="110" y="32" text-anchor="middle" font-size="9" fill="#64748b">轮询 rpc_broadcast_mq</text>
    </g>
    <line x1="130" y1="102" x2="130" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
    <g transform="translate(20, 122)">
      <rect x="0" y="0" width="220" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="110" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">run_method(worker, "execute_model")</text>
      <text x="110" y="30" text-anchor="middle" font-size="9" fill="#64748b">forward GPU</text>
    </g>
    <line x1="130" y1="160" x2="130" y2="174" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
    <g transform="translate(20, 176)">
      <rect x="0" y="0" width="220" height="38" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="110" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">run_method(worker, "sample_tokens")</text>
      <text x="110" y="30" text-anchor="middle" font-size="9" fill="#64748b">execute_model 返回 None 时跟一次</text>
    </g>
    <line x1="130" y1="214" x2="130" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar66)"/>
    <g transform="translate(20, 230)">
      <rect x="0" y="0" width="220" height="38" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="110" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">enqueue (status, result)</text>
      <text x="110" y="30" text-anchor="middle" font-size="9" fill="#64748b">→ worker_response_mq</text>
    </g>
    <text x="20" y="295" font-size="9" fill="#94a3b8">每个 rank 一份 worker_busy_loop，</text>
    <text x="20" y="307" font-size="9" fill="#94a3b8">只 output_rank（默认 last PP）的</text>
    <text x="20" y="319" font-size="9" fill="#94a3b8">返回值走 response mq，其它 rank</text>
    <text x="20" y="331" font-size="9" fill="#94a3b8">通过 PP send/recv 互相传中间张量</text>
  </g>
</svg>
<span class="figure-caption">图 R6.6 ｜ EngineCore ↔ Worker 控制面通信：请求走 shm 广播队列，响应走每个 worker 单独的 response 队列，FutureWrapper 把"发出去"和"取结果"解耦，支持调度循环 in-flight pipelining。</span>

<details>
<summary>ASCII 原版</summary>

```text
EngineCore loop
   │   non_block=True
   ▼
executor.execute_model  ──► rpc_broadcast_mq.enqueue((method, args, kwargs, output_rank))
   │
   └─► 返回 FutureWrapper（加入 futures_queue）
                                 ▲
                                 │ 调度循环稍后 future.result() 时 dequeue
                                 │ output_rank 对应 worker 的 response mq 出队
                                 │
worker (子进程) ◄──── 出 rpc_broadcast_mq ──── worker_busy_loop
   │
   ├─ run_method(worker, "execute_model", args, kwargs)
   ├─ run_method(worker, "sample_tokens", ...)（execute_model 返回 None 时跟一次）
   └─ enqueue (status, result) → worker_response_mq
```

</details>

调度循环（`vllm/v1/engine/core.py`）做 in-flight pipelining：先把当前步发出去拿 Future，并行准备下一步的 scheduler_output，需要本步结果（采样 token 等）时才 `future.result()`。这就是 `max_concurrent_batches` 的语义（uniproc 也支持 `=2`，前提是 `async_scheduling=True`）。

`AsyncModelRunnerOutput`（`vllm/v1/outputs.py`，对应 `gpu_model_runner.py:236` 的 `AsyncGPUModelRunnerOutput`）是 worker 端的"还在 GPU 上"的输出包装：sampled_token_ids 还在 GPU，CPU 拷贝在另一条 stream 上做，`.get_output()` 时才等待事件并返回 final `ModelRunnerOutput`。这个机制配合 async scheduling 把 GPU 输出回传到 EngineCore 的时延藏在调度间隙里。

### 6.16.2 数据面：multimodal tensor IPC

多模态输入（PIL image 数组、video frame、long pixel tensor）走 msgpack 太慢且占带宽。`vllm/v1/engine/tensor_ipc.py` 提供基于 `torch.multiprocessing.Queue` 的 OOB（out-of-band）tensor 传输：

```python
# tensor_ipc.py:30
@dataclasses.dataclass
class TensorIpcData:
    sender_id: str
    message_id: int
    tensor_id: int
    tensor: torch.Tensor   # 共享内存 tensor
```

- **API server 进程**用 `TensorIpcSender` 把 tensor 放进 `mp.Queue`（zero-copy 共享内存），同时在 msgpack 主消息里只附 `(sender_id, tensor_id)`。
- **EngineCore 进程**用 `TensorIpcReceiver`（`vllm/v1/engine/core.py:860`）从 queue 取回 tensor，按 id 还原。
- **Worker 进程**通过 `WorkerWrapperBase.mm_receiver_cache`（`worker_base.py:304`）再次从 shared memory cache 取出已 process 完的 multimodal feature，避免 worker 重复处理。

`mm_processor_cache_type='shm'` 是这条路径启用的开关，依赖 `shared_worker_lock`（`worker_base.py:289`）在多 worker 间协调写入。

---

## 6.17 其他 ModelRunner

### 6.17.1 `CPUModelRunner`

`vllm/v1/worker/cpu_model_runner.py:22` —— 继承 `GPUModelRunner`。构造时用 `_torch_cuda_wrapper`（`:27`）把 `torch.cuda.*` 替换成 no-op（让父类不再调 CUDA API），再用 `_postprocess_tensors`（`:39`）把所有 `CpuGpuBuffer.gpu` 别名到 `.cpu`、替换 `block_table` 的 Triton kernel 为 CPU 版本（`_postprocess_triton`，`:62`）。`use_cuda_graph = False`，`cascade_attn_enabled = False`。

### 6.17.2 `XPUModelRunner` 与 `XPUModelRunnerV2`

`vllm/v1/worker/xpu_model_runner.py:15` —— 同样继承 GPU 版本，用 `_torch_cuda_wrapper` 把 `torch.cuda.*` 重定向到 `torch.xpu.*`。极短，靠继承复用。

### 6.17.3 TPU input batch

`vllm/v1/worker/tpu_input_batch.py:21` —— TPU 用单独的 `InputBatch`（不继承 GPU 版），因为 TPU 的 batch 需要静态 shape padding + XLA graph 编译，sampling state 处理方式不同。它共享 `CachedRequestState`（从 `gpu_input_batch.py` import）。

### 6.17.4 V2 GPU model runner

`vllm/v1/worker/gpu/model_runner.py:109` —— 实验性新版（README 标明 "[Experimental] Model Runner V2"）。结构上把方法拆得更细：`finish_requests`、`free_states`、`add_requests`、`update_requests`、`prepare_inputs`、`prepare_attn`、`sample`、`postprocess` 都是独立公共方法，便于子类化和测试。`Worker.__init__` 通过 `use_v2_model_runner = vllm_config.use_v2_model_runner` 开关二选一（`gpu_worker.py:316`）。短期内 V1 仍是默认。

### 6.17.5 子目录 `vllm/v1/worker/gpu/`

V2 配套的工具模块：`gpu/input_batch.py`、`gpu/block_table.py`、`gpu/attn_utils.py`、`gpu/cudagraph_utils.py`、`gpu/sample/`、`gpu/states.py` 等。它们与 V1 平级目录下的同名文件并行存在，V2 在演进时不破坏 V1。

---

## 附录 A：`SchedulerOutput → ModelRunnerOutput` 一帧路径速查

```
SchedulerOutput                       gpu_model_runner.py 行号
   │
   ▼
Worker.execute_model              gpu_worker.py:782
   │
   ▼
GPUModelRunner.execute_model      gpu_model_runner.py:3913
   │
   ├── _update_states                 :1103   持久 batch 增删
   ├── _prepare_inputs                :1839   拼装 input_ids / positions / metadata
   │     ├── block_table.commit       block_table.py:166
   │     ├── _calc_spec_decode_meta   :2670
   │     └── block_table.compute_slot_mapping  block_table.py:141 (triton)
   ├── _compute_cascade_attn_prefix_lens   :2441
   ├── _determine_batch_execution_and_padding  :3679   cudagraph dispatch
   ├── maybe_create_ubatch_slices    ubatch_utils.py:63
   ├── _get_slot_mappings             :3829
   ├── _build_attention_metadata      :2150
   ├── _preprocess                    :3321   MM encoder + embed
   ├── _model_forward                 :3626   self.model(input_ids, positions, ...)
   ├── compute_logits / pool          :4209
   └── set ExecuteModelState
                                     return None
   │
   ▼
Worker.sample_tokens               gpu_worker.py:777
   │
   ▼
GPUModelRunner.sample_tokens      gpu_model_runner.py:4262
   ├── apply_grammar_bitmask
   ├── _sample                       :3439
   ├── _update_states_after_model_execute   :1473
   ├── propose_draft_token_ids       :4689
   └── _bookkeeping_sync             :3470
                                     return ModelRunnerOutput
```

## 附录 B：常用调试切入点

- 想看输入张量长什么样：在 `gpu_model_runner.py:2049` 附近打印 `self.num_scheduled_tokens.np`、`self.query_start_loc.np`、`self.seq_lens` 切片。
- 想知道为什么没走 CUDA graph：检查 `cudagraph_dispatcher.dispatch` 返回 `(CUDAGraphMode.NONE, ...)` 的分支（`cudagraph_dispatcher.py:278`），通常是 `num_tokens > max_size` 或 capture key 不存在。
- 想知道 `_dummy_run` 行为：所有 mode（profile / capture / warmup）共用同一份代码，主要分支由 `cudagraph_runtime_mode`、`uniform_decode`、`is_profile`、`is_graph_capturing` 标志位决定（`gpu_model_runner.py:5468`-）。
- KV 写不进对应位置：先检查 `block_table.commit_block_table` 是否被调用、`slot_mapping` 是否为 `PAD_SLOT_ID`（DCP/PCP 切分下 non-local token 是合理的 pad）。
- async scheduling 死锁：通常是 `prepare_inputs_event` / `async_output_copy_stream` 与 `transfer_event`（`gpu_model_runner.py:843`）的事件顺序错乱，把 `use_async_scheduling=False` 跑一遍能快速排除嫌疑。

---

本章覆盖的代码位置以行号形式列出供查阅；GPU 执行层是 vLLM 最复杂的部分，理解 `InputBatch`、`BlockTable`、`_prepare_inputs`、`_build_attention_metadata`、`CudagraphDispatcher` 五者的协作，是自己实现一个 LLM 推理引擎"runtime 层"的核心知识。
