# 第 04 章：Engine 入口与多进程编排

> 代码版本：sgl-project/sglang@6ccc5b807（2026-05-17）

本章描述 SGLang 运行时如何通过 `Engine` 类将配置、进程启动、IPC 通道三者统一管理，并说明将单次推理拆成三个操作系统进程的根本原因。

- 上游配置来源：[第 03 章 ServerArgs 与启动参数](03-server-args.md)（若存在）
- 下游数据流转：[第 05 章 请求对象与核心数据结构](05-request-data-structures.md)

---

## 目录

1. [Engine 类概览](#1-engine-类概览)
2. [ServerArgs：配置单一真相](#2-serverargs配置单一真相)
3. [三进程模型](#3-三进程模型)
4. [为什么拆成三个进程](#4-为什么拆成三个进程)
5. [ZMQ IPC：进程间通信](#5-zmq-ipc进程间通信)
6. [\_launch\_subprocesses 启动流程](#6-_launch_subprocesses-启动流程)
7. [Engine.generate 同步与异步路径](#7-enginegenerate-同步与异步路径)
8. [shutdown 与 watchdog](#8-shutdown-与-watchdog)

---

## 1. Engine 类概览

`Engine` 是离线（Python API）推理的顶层入口，定义于：

```
python/sglang/srt/entrypoints/engine.py:178
```

```python
class Engine(EngineScoreMixin, EngineBase):
    server_args_class: ServerArgs = ServerArgs
    init_tokenizer_manager_func: Callable = staticmethod(init_tokenizer_manager)
    run_scheduler_process_func: Callable = staticmethod(run_scheduler_process)
    run_detokenizer_process_func: Callable = staticmethod(run_detokenizer_process)
```

三个 `staticmethod` 字段的设计目的是允许外部 fork 通过子类化 `Engine` 来替换实现，而无需修改框架核心代码。这是一种"扩展点"模式，比直接 monkey-patching 更安全。

`Engine` 同时继承 `EngineScoreMixin`（`engine_score_mixin.py`）和 `EngineBase`（`EngineBase.py`），前者提供 embedding/scoring 相关接口，后者抽象出 `generate`/`async_generate` 的骨架签名。

### `__init__` 的执行顺序

`python/sglang/srt/entrypoints/engine.py:199`

```python
def __init__(self, **kwargs):
    load_plugins()                        # 1. 加载外部插件（影响 ServerArgs.__post_init__）
    server_args = self.server_args_class(**kwargs)   # 2. 构造 ServerArgs，触发 __post_init__
    self.server_args = server_args

    self.tokenizer_manager = None         # 3. 预置为 None，防止 atexit 中 AttributeError
    atexit.register(self.shutdown)        # 4. 注册退出钩子

    (tokenizer_manager, template_manager,
     port_args, scheduler_init_result,
     subprocess_watchdog) = self._launch_subprocesses(...)   # 5. 启动子进程

    context = zmq.Context(2)
    self.send_to_rpc = get_zmq_socket(    # 6. 建立 RPC socket（仅 node_rank=0）
        context, zmq.DEALER, self.port_args.rpc_ipc_name, True
    )
    self.loop = asyncio.get_running_loop() # 7. 绑定事件循环
```

步骤 3 的提前置 `None` 很重要：若步骤 5 抛出异常，`atexit` 回调中的 `self.tokenizer_manager is not None` 判断可以安全跳过，避免二次崩溃。

---

## 2. ServerArgs：配置单一真相

### ServerArgs

`python/sglang/srt/server_args.py:326`

`ServerArgs` 是一个 `@dataclass`，承担着配置的**唯一权威来源**（Single Source of Truth）角色：所有进程（TokenizerManager、Scheduler、DetokenizerManager）在创建时都接收同一个 `ServerArgs` 对象的副本。

**核心字段分组（选取）：**

| 分组 | 代表字段 | 说明 |
|------|---------|------|
| 模型 | `model_path`, `tokenizer_path`, `context_length` | HF 模型路径与上下文长度 |
| 内存调度 | `mem_fraction_static`, `max_total_tokens`, `chunked_prefill_size` | KV cache 大小与分块预填 |
| 运行时 | `tp_size`, `pp_size`, `dp_size` | 张量/流水线/数据并行 |
| 调度策略 | `schedule_policy`, `schedule_conservativeness` | FCFS 或优先级调度 |
| 投机解码 | `speculative_algorithm`, `speculative_num_steps` | 草稿模型配置 |
| 解离 | `disaggregation_mode` (`null`/`prefill`/`decode`) | PD 解离模式 |

### `__post_init__` 的处理链

`python/sglang/srt/server_args.py:827`

`__post_init__` 是 SGLang 配置系统的核心，约有 40 个私有方法在此串行调用，形成一条有序的"配置收敛流水线"：

```text
__post_init__
  |-- _maybe_download_model_for_runai()       # 远程模型先下载
  |-- _handle_load_balance_method()           # PD 解离时切 follow_bootstrap_room
  |-- _handle_multimodal()                    # 多模态合法性校验
  |-- _handle_ssl_validation()                # SSL 参数互斥检查
  |-- _handle_pd_disaggregation()             # disaggregation_mode 校验
  |-- _handle_deprecated_args()               # 废弃参数迁移
  |-- _handle_missing_default_values()        # mem_fraction_static 等默认值填充
  |-- _handle_hpu/cpu/npu/mps/xpu_backends() # 平台专属后端选择
  |-- _handle_gpu_memory_settings()           # 根据显存容量计算 max_total_tokens
  |-- _handle_model_specific_adjustments()    # 根据 HF config 推断 attention backend
  |-- _handle_sampling_backend()              # flashinfer / pytorch 采样后端
  |-- _handle_attention_backend_compatibility()
  |-- _handle_piecewise_cuda_graph()
  |-- _handle_data_parallelism()
  |-- handle_speculative_decoding()           # 投机解码参数自动推断
  |-- _handle_cache_compatibility()
  |-- _handle_other_validations()
```

**设计意图**：每个 `_handle_*` 方法职责单一，方便插件通过继承 `ServerArgs` 插入自定义处理逻辑。早期调用（如 `_handle_ssl_validation`）的校验不依赖模型配置，因此放在模型路径解析之前，避免无效的远程 IO。

**默认值填充示例**：`_handle_missing_default_values` 根据 GPU 内存容量决定 `mem_fraction_static`，而不是硬编码，原因是不同 GPU 型号的显存差异巨大（16 GB ~ 80 GB），固定分数无法通用。

**交叉校验示例**：若用户同时指定 `quantization="fp8"` 和 `attention_backend="triton"`，`_handle_attention_backend_compatibility` 会检查该组合的合法性并自动降级或报错，防止运行时出现难以调试的张量类型不匹配。

---

## 3. 三进程模型

<svg viewBox="0 0 600 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Engine process layout and ZMQ message ring">
<defs>
<marker id="r4ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="130" y="14" width="340" height="74" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="300" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">主进程 main process</text>
<text x="300" y="52" text-anchor="middle" font-size="10" fill="#64748b">HTTP Server（FastAPI/uvicorn）· Engine API</text>
<text x="300" y="68" text-anchor="middle" font-size="10" fill="#64748b">TokenizerManager（异步事件循环 · 分词 + 结果聚合）</text>
<line x1="300" y1="88" x2="300" y2="120" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r4ar)"/>
<text x="312" y="108" font-size="9" fill="#94a3b8">ZMQ PUSH · scheduler_input_ipc</text>
<rect x="130" y="122" width="340" height="68" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
<text x="300" y="144" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">子进程 1 · Scheduler</text>
<text x="300" y="162" text-anchor="middle" font-size="10" fill="#64748b">CPU 调度循环 + GPU 前向（含 TP workers）</text>
<text x="300" y="178" text-anchor="middle" font-size="10" fill="#64748b">ModelRunner 执行 ForwardBatch</text>
<line x1="300" y1="190" x2="300" y2="222" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r4ar)"/>
<text x="312" y="210" font-size="9" fill="#94a3b8">ZMQ PUSH · detokenizer_ipc</text>
<rect x="130" y="224" width="340" height="52" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
<text x="300" y="246" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">子进程 2 · DetokenizerManager</text>
<text x="300" y="264" text-anchor="middle" font-size="10" fill="#64748b">token_ids → str，增量解码</text>
<path d="M130 250 C 40 250, 40 51, 126 51" fill="none" stroke="#94a3b8" stroke-width="1.3" stroke-dasharray="4,3" marker-end="url(#r4ar)"/>
<text x="48" y="146" font-size="9" fill="#94a3b8">ZMQ PUSH</text>
<text x="48" y="160" font-size="9" fill="#94a3b8">tokenizer_ipc</text>
<text x="300" y="312" text-anchor="middle" font-size="10" fill="#94a3b8">结果回到主进程 TokenizerManager —— 三进程靠 ZMQ 单向管道闭环</text>
</svg>
<span class="figure-caption">图 R4.1 ｜ Engine 的三进程布局与 ZMQ 消息环：主进程 → Scheduler → Detokenizer → 主进程</span>

<details>
<summary>ASCII 原版</summary>

```text
主进程 (main process)
+--------------------+
|  HTTP Server       |  FastAPI / uvicorn，处理 HTTP 请求
|  Engine            |  Python API 入口
|  TokenizerManager  |  异步事件循环，分词 + 结果聚合
+--------|-----------+
         |  ZMQ PUSH  scheduler_input_ipc_name
         v
子进程 1 (subprocess)
+--------------------+
|  Scheduler         |  CPU 调度循环 + GPU 前向传播（含 TP workers）
|  ModelRunner       |  执行 ForwardBatch
+--------|-----------+
         |  ZMQ PUSH  detokenizer_ipc_name
         v
子进程 2 (subprocess)
+--------------------+
|  DetokenizerManager|  token_ids -> str，增量解码
+--------|-----------+
         |  ZMQ PUSH  tokenizer_ipc_name
         v
回到主进程 TokenizerManager
```

</details>

### TokenizerManager（主进程）

`python/sglang/srt/managers/tokenizer_manager.py:216`

- 使用 `asyncio + uvloop` 事件循环，天然支持并发处理多请求。
- 维护 `rid_to_state: Dict[str, ReqState]`，记录每个请求 ID 对应的输出状态和等待事件。
- 核心职责：
  1. 接收 `GenerateReqInput`，归一化批次参数（`normalize_batch_and_arguments`）。
  2. 异步分词（`_tokenize_one_request`），将文本转换为 token ID 序列，处理多模态输入。
  3. 通过 ZMQ PUSH 将 `TokenizedGenerateReqInput` 发送给 Scheduler（`_send_one_request` at line 1187）。
  4. 等待 Scheduler/DetokenizerManager 返回 `BatchStrOutput`，将结果分发给对应请求的 `asyncio.Event`。

### Scheduler（子进程 1）

`python/sglang/srt/managers/scheduler.py:324`，入口函数：

`python/sglang/srt/managers/scheduler.py:4029`

```python
def run_scheduler_process(
    server_args, port_args, gpu_id, tp_rank,
    attn_cp_rank, moe_dp_rank, moe_ep_rank, pp_rank, dp_rank,
    pipe_writer,
):
    scheduler = Scheduler(...)
    pipe_writer.send(scheduler.get_init_info())   # 握手
    scheduler.run_event_loop()                     # 阻塞式事件循环
```

`Scheduler` 持有 `ModelRunner`，负责：
1. 从 ZMQ PULL socket 接收 `TokenizedGenerateReqInput`。
2. 按策略（FCFS / 优先级）选批，构造 `ScheduleBatch`。
3. 调用 `run_batch` → `ForwardBatch.init_new` → `model_runner.forward`（GPU 前向）。
4. 将 `BatchTokenIDOutput` PUSH 给 DetokenizerManager。

### DetokenizerManager（子进程 2）

`python/sglang/srt/managers/detokenizer_manager.py:76`

- 持有 `tokenizer` 的副本，专门做 token ID → 字符串的批量解码。
- 维护 `decode_status: LimitedCapacityDict`（上限 `SGLANG_DETOKENIZER_MAX_STATES`，默认 65536），存储每个请求的增量解码状态（`surr_offset`/`read_offset`）。
- 增量解码的关键：每次只 decode 新增 token，避免每步重新 decode 整个序列，降低 CPU 负载。
- 处理完毕后将 `BatchStrOutput` PUSH 回 TokenizerManager。

---

## 4. 为什么拆成三个进程

### Python GIL 限制

Python 的全局解释器锁（GIL）使得多线程 CPU 密集代码无法真正并行。分词（正则匹配、BPE 编码）和 detokenize（Unicode 解码、增量文本拼接）都是 CPU 密集操作。放入独立进程后，操作系统可以将其调度到不同 CPU 核心上真正并行。

### CPU 调度与 GPU 前向的重叠

Scheduler 的核心循环（`event_loop_overlap` at `scheduler.py:1576`）把 CPU 侧"选批 + 分配 KV 缓存 + 前处理"和 GPU 侧"上一批的前向传播"重叠执行：

```text
时间轴:
  CPU: [选批 N] [处理结果 N-1] [选批 N+1] [处理结果 N] ...
  GPU:                [前向 N]                    [前向 N+1] ...
```

若 Scheduler、TokenizerManager、DetokenizerManager 共享同一进程或同一 GIL，上述重叠就会被破坏——分词操作会抢占 CPU 时间，导致 GPU 饥饿。独立进程确保 Scheduler 的 CPU 侧工作不被分词 / detokenize 中断。

### 分词与 detokenize 不阻塞调度

对于流式输出（`stream=True`），每生成一个 token 就需要调用一次 detokenize。若 DetokenizerManager 与 Scheduler 在同一进程，每步 detokenize 的锁竞争或 I/O 会增加调度延迟（影响 GPU 利用率）。独立进程通过 ZMQ 异步传递，detokenize 可以与下一批的 GPU 前向并发执行。

### 分布式场景的自然扩展

在多节点（`nnodes > 1`）场景下，node_rank >= 1 的节点不需要 TokenizerManager 和 DetokenizerManager（`engine.py:807`）：

```python
if server_args.node_rank >= 1:
    scheduler_init_result.wait_for_ready()
    return (None, None, port_args, scheduler_init_result, None)
```

进程边界天然隔离了"只跑推理"和"需要文本处理"的节点，无需任何条件分支污染推理核心路径。

---

## 5. ZMQ IPC：进程间通信

### PortArgs

`python/sglang/srt/server_args.py:7357`

```python
@dataclasses.dataclass
class PortArgs:
    tokenizer_ipc_name: str          # Detokenizer → TokenizerManager（PUSH→PULL）
    scheduler_input_ipc_name: str    # TokenizerManager → Scheduler（PUSH→PULL）
    detokenizer_ipc_name: str        # Scheduler → DetokenizerManager（PUSH→PULL）
    nccl_port: int                   # torch.distributed NCCL 初始化端口
    rpc_ipc_name: str                # Engine ↔ Scheduler RPC（DEALER→DEALER）
    metrics_ipc_name: str            # Scheduler → 指标收集器（PUSH）
    tokenizer_worker_ipc_name: Optional[str]  # 多 tokenizer worker 时使用
```

**IPC 命名策略**：

- 单节点（默认）：`ipc://<tmpfile>`，使用 Unix 域套接字，零拷贝、零网络开销。

```python
# server_args.py:7398
tokenizer_ipc_name=f"ipc://{tempfile.NamedTemporaryFile(delete=False).name}"
```

- 多节点 DP attention（`enable_dp_attention=True`）：切换为 `tcp://<host>:<port>`，基于 `dist_init_addr` 分配端口偏移量（`server_args.py:7415`）。

### Socket 类型选择

| 链路 | 发送端 | 接收端 | Socket 类型 | 选择原因 |
|------|--------|--------|-------------|---------|
| Tokenizer → Scheduler | PUSH | PULL | 单向流，无需应答，最小化延迟 |
| Scheduler → Detokenizer | PUSH | PULL | 同上 |
| Detokenizer → Tokenizer | PUSH | PULL | 同上 |
| Engine ↔ Scheduler RPC | DEALER | DEALER | 双向、异步、支持多路请求复用 |

PUSH/PULL 是 ZMQ 中开销最低的单向模式，没有消息确认或重传机制，适合 SGLang 这种局域网内进程通信的场景——丢包由进程崩溃检测（watchdog）而非 ZMQ 重传处理。

### 消息序列化

所有跨进程消息通过 `send_pyobj` / `recv_pyobj` 传输，底层使用 Python `pickle`：

```python
# tokenizer_manager.py:1193
self.send_to_scheduler.send_pyobj(tokenized_obj)

# detokenizer_manager.py:149
recv_obj = self.recv_from_scheduler.recv_pyobj()
```

选择 `pickle` 而非 protobuf/msgpack 的原因：SGLang 的消息对象（如 `TokenizedGenerateReqInput`）包含 `torch.Tensor`，而 `pickle` 对 PyTorch 张量有原生支持（共享内存机制），序列化开销低。对于多模态特征这类大张量，代码通过 `wrap_shm_features`（`tokenizer_manager.py:1192`）将其放入共享内存，IPC 只传递句柄，避免拷贝。

---

## 6. `_launch_subprocesses` 启动流程

`python/sglang/srt/entrypoints/engine.py:735`

```text
_launch_subprocesses(server_args, ...)
  |
  |-- configure_logger / _set_envs_and_config      # 全局环境配置
  |-- server_args.check_server_args()               # 二次校验（交叉依赖检查）
  |-- PortArgs.init_new(server_args)                # 分配 IPC 端点
  |
  |-- _launch_scheduler_processes(...)              # 启动 Scheduler 子进程（含 TP workers）
  |     |-- mp.Process(target=run_scheduler_process, ...)
  |     |-- pipe.recv() 阻塞等待握手                # Scheduler 发送 get_init_info()
  |     +-- scheduler_init_result.wait_for_ready()  # 等待模型加载完毕
  |
  |-- [node_rank >= 1 时直接返回]
  |
  |-- _launch_detokenizer_subprocesses(...)         # 启动 DetokenizerManager 子进程
  |     |-- 单 worker：mp.Process(target=run_detokenizer_process)
  |     +-- 多 worker：额外启动 multi_detokenizer_router
  |
  |-- init_tokenizer_manager_func(...)              # 在主进程初始化 TokenizerManager
  |
  |-- tokenizer_manager.max_req_input_len =         # 从 Scheduler 握手信息同步
  |     scheduler_init_result.scheduler_infos[0]["max_req_input_len"]
  |
  |-- SubprocessWatchdog(processes, names).start()  # 启动子进程存活监控
  |
  +-- return (tokenizer_manager, template_manager,
               port_args, scheduler_init_result,
               subprocess_watchdog)
```

**握手机制**：Scheduler 子进程通过 `pipe_writer.send(scheduler.get_init_info())` 将 `max_req_input_len`、`max_total_num_tokens` 等信息回传给主进程（`scheduler.py:4081`）。主进程阻塞在 `wait_for_ready()` 直到收到握手信号，再将 `max_req_input_len` 写入 `tokenizer_manager`，确保分词阶段不会构造超长请求。

**多 detokenizer worker**：当 `detokenizer_worker_num > 1` 时，额外启动一个 `multi_detokenizer_router` 进程，在路由层做负载均衡，各 worker 通过临时 IPC 端点与 router 通信（`engine.py:707-732`）。

---

## 7. Engine.generate 同步与异步路径

`python/sglang/srt/entrypoints/engine.py:309`

```python
def generate(self, prompt=None, ..., stream=False, ...) -> Union[Dict, Iterator[Dict]]:
    obj = GenerateReqInput(text=prompt, ...)
    generator = self.tokenizer_manager.generate_request(obj, None)

    if stream:
        def generator_wrapper():
            while True:
                try:
                    chunk = self.loop.run_until_complete(generator.__anext__())
                    yield chunk
                except StopAsyncIteration:
                    break
        return generator_wrapper()   # 返回同步生成器
    else:
        ret = self.loop.run_until_complete(generator.__anext__())
        return ret                   # 返回单个结果字典
```

**同步路径**（`stream=False`）：调用 `loop.run_until_complete` 将异步协程桥接到同步世界，适合离线批处理。

**流式路径**（`stream=True`）：包装成同步 `generator_wrapper`，每次 `next()` 调用阻塞式等待一个异步 chunk，对调用方呈现为普通 Python 生成器。

**异步路径**（`async_generate`，`engine.py:401`）：直接返回 `generate_request` 异步生成器，适合在 FastAPI 等异步框架内使用。

**TokenizerManager.generate_request 内部流程**（`tokenizer_manager.py:515`）：

```text
generate_request(obj)
  |-- obj.normalize_batch_and_arguments()   # 批次归一化
  |-- _init_req_state(obj)                  # 注册 rid_to_state
  |-- _tokenize_one_request(obj)            # 异步分词
  |-- _send_one_request(tokenized_obj)      # PUSH 给 Scheduler
  +-- _wait_one_response(obj)               # 等待 BatchStrOutput 事件
      |-- asyncio.Event.wait()              # 挂起，不占 CPU
      +-- yield response                    # 逐步 yield 给调用方
```

---

## 8. shutdown 与 watchdog

### shutdown

`python/sglang/srt/entrypoints/engine.py:882`

```python
def shutdown(self):
    if (self.tokenizer_manager is not None and
            self.tokenizer_manager._subprocess_watchdog is not None):
        self.tokenizer_manager._subprocess_watchdog.stop()
    kill_process_tree(os.getpid(), include_parent=False, wait_timeout=60)
```

`kill_process_tree` 递归终止所有子进程（Scheduler、DetokenizerManager 及其 TP worker 子进程）。`wait_timeout=60` 给 GPU 前向传播留出最多 60 秒的正常退出时间，确保 GPU 显存被释放后调用方才能在同一设备上重新分配。

`atexit.register(self.shutdown)` 确保即使程序异常退出也会清理子进程，避免 GPU 进程泄漏。`Engine.__exit__` 也调用 `shutdown`，支持 `with Engine(...) as engine:` 上下文管理器用法。

### SubprocessWatchdog

`engine.py:869`

```python
subprocess_watchdog = SubprocessWatchdog(
    processes=processes, process_names=names
)
subprocess_watchdog.start()
```

`SubprocessWatchdog` 在后台线程周期性检查所有子进程存活状态。若任一子进程意外退出（返回非零退出码），watchdog 向主进程发送 `SIGQUIT` 信号，触发整个引擎的清理关闭，而不是让主进程陷入无限等待死锁。

Scheduler 子进程内部同样有 Watchdog（`server_args.watchdog_timeout`，默认 300 秒），监控 event loop 推进速度。若 GPU 前向传播卡住超时，Scheduler 主动退出，watchdog 随即感知。

---

## 小结

| 组件 | 进程 | 关键文件 |
|------|------|---------|
| Engine | 主进程 | `entrypoints/engine.py:178` |
| ServerArgs | 构造于主进程，传播到所有子进程 | `server_args.py:326` |
| TokenizerManager | 主进程 | `managers/tokenizer_manager.py:216` |
| Scheduler | 子进程 1（含 TP workers） | `managers/scheduler.py:324` |
| DetokenizerManager | 子进程 2 | `managers/detokenizer_manager.py:76` |
| PortArgs / ZMQ | 主进程分配，子进程共享 | `server_args.py:7357` |

三进程模型的核心价值在于：**GIL 隔离 + CPU-GPU 重叠 + 进程边界失败隔离**。Scheduler 可以全力驱动 GPU，TokenizerManager 可以并发处理多请求的分词，DetokenizerManager 可以与 GPU 前向同步进行 detokenize，三者通过轻量级 ZMQ PUSH/PULL 解耦，整体吞吐和延迟均优于单进程方案。

下一章（[第 05 章](05-request-data-structures.md)）将追踪一个请求在三个进程之间的对象形态演化。
