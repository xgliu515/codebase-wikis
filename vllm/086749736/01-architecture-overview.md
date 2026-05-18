# 第 1 章 整体架构总览

本章是 vLLM V1 架构的入口参考。后续各章将围绕此处建立的术语和分层来展开。本章只描述 V1（`vllm/v1/*`），不涉及已弃用的 V0（`vllm/engine/`、`vllm/core/`）。

## 1.1 四层架构

vLLM V1 在概念上是一个四层结构。每一层都有清晰的输入/输出类型和明确的进程边界，且层与层之间通过**强类型 `msgspec` 消息**或 **`collective_rpc` 调用**通信，而不是共享 Python 对象。这是 V1 相对 V0 最重要的设计变化。

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vLLM V1 四层架构：Entrypoint / EngineCore / Scheduler / Executor+Worker">
  <defs>
    <marker id="r1ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">vLLM V1 四层架构 — 每层之间通过强类型消息或 collective_rpc 通信，不共享 Python 对象</text>
  <g transform="translate(40, 50)">
    <rect x="0" y="0" width="680" height="98" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="8"/>
    <rect x="0" y="0" width="170" height="98" fill="#fb923c" rx="8"/>
    <text x="85" y="40" text-anchor="middle" font-size="14" font-weight="700" fill="white">Layer 1</text>
    <text x="85" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="white">Entrypoint</text>
    <text x="85" y="78" text-anchor="middle" font-size="10" fill="#fff7ed">用户进程 / API server</text>
    <text x="190" y="22" font-size="12" font-weight="700" fill="#9a3412">LLM (离线) / AsyncLLM (在线) / OpenAI API server</text>
    <text x="190" y="40" font-size="10" font-family="monospace" fill="#9a3412">vllm/entrypoints/llm.py · vllm/entrypoints/openai/api_server.py</text>
    <text x="190" y="54" font-size="10" font-family="monospace" fill="#9a3412">vllm/v1/engine/{async_llm,llm_engine}.py</text>
    <text x="190" y="74" font-size="11" fill="#9a3412"><tspan font-weight="700">职责：</tspan>prompt 渲染 + tokenization + 流式 detokenize + HTTP</text>
    <text x="190" y="90" font-size="11" fill="#9a3412"><tspan font-weight="700">类型：</tspan>PromptType / SamplingParams → RequestOutput</text>
  </g>
  <path d="M 380 148 L 380 178" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r1ar)"/>
  <rect x="195" y="153" width="370" height="22" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="380" y="168" text-anchor="middle" font-size="10" font-family="monospace" fill="#475569">EngineCoreRequest (msgspec) · ZMQ DEALER/ROUTER 或 in-proc</text>
  <g transform="translate(40, 185)">
    <rect x="0" y="0" width="680" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="8"/>
    <rect x="0" y="0" width="170" height="80" fill="#14b8a6" rx="8"/>
    <text x="85" y="32" text-anchor="middle" font-size="14" font-weight="700" fill="white">Layer 2</text>
    <text x="85" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="white">EngineCore</text>
    <text x="85" y="68" text-anchor="middle" font-size="10" fill="#ccfbf1">独立进程 + busy loop</text>
    <text x="190" y="22" font-size="12" font-weight="700" fill="#115e59">EngineCore + EngineCoreProc 主循环</text>
    <text x="190" y="38" font-size="10" font-family="monospace" fill="#115e59">vllm/v1/engine/core.py</text>
    <text x="190" y="58" font-size="11" fill="#115e59"><tspan font-weight="700">职责：</tspan>busy loop，连接 Scheduler 与 Executor，DP 协调</text>
    <text x="190" y="73" font-size="11" fill="#115e59"><tspan font-weight="700">类型：</tspan>EngineCoreRequest → EngineCoreOutputs</text>
  </g>
  <path d="M 380 265 L 380 295" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r1ar)"/>
  <rect x="195" y="270" width="370" height="22" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="380" y="285" text-anchor="middle" font-size="10" font-family="monospace" fill="#475569">同进程方法调用：schedule() / update_from_output()</text>
  <g transform="translate(40, 302)">
    <rect x="0" y="0" width="680" height="86" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="8"/>
    <rect x="0" y="0" width="170" height="86" fill="#a78bfa" rx="8"/>
    <text x="85" y="32" text-anchor="middle" font-size="14" font-weight="700" fill="white">Layer 3</text>
    <text x="85" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="white">Scheduler</text>
    <text x="85" y="68" text-anchor="middle" font-size="10" fill="#ede9fe">+ KVCacheManager</text>
    <text x="85" y="80" text-anchor="middle" font-size="10" fill="#ede9fe">逻辑层（无显存）</text>
    <text x="190" y="22" font-size="12" font-weight="700" fill="#5b21b6">Scheduler + KVCacheManager + BlockPool</text>
    <text x="190" y="38" font-size="10" font-family="monospace" fill="#5b21b6">vllm/v1/core/sched/scheduler.py</text>
    <text x="190" y="52" font-size="10" font-family="monospace" fill="#5b21b6">vllm/v1/core/kv_cache_manager.py + block_pool.py</text>
    <text x="190" y="70" font-size="11" fill="#5b21b6"><tspan font-weight="700">职责：</tspan>本步执行哪些 req、各跑几个 token、分配逻辑 KV 块</text>
    <text x="190" y="82" font-size="11" fill="#5b21b6"><tspan font-weight="700">类型：</tspan>Request 状态 → SchedulerOutput</text>
  </g>
  <path d="M 380 388 L 380 418" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r1ar)"/>
  <rect x="155" y="393" width="450" height="22" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="380" y="408" text-anchor="middle" font-size="10" font-family="monospace" fill="#475569">SchedulerOutput (经 SHM MessageQueue) · collective_rpc("execute_model", ...)</text>
  <g transform="translate(40, 425)">
    <rect x="0" y="0" width="680" height="98" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="8"/>
    <rect x="0" y="0" width="170" height="98" fill="#38bdf8" rx="8"/>
    <text x="85" y="32" text-anchor="middle" font-size="14" font-weight="700" fill="white">Layer 4</text>
    <text x="85" y="52" text-anchor="middle" font-size="12" font-weight="700" fill="white">Executor</text>
    <text x="85" y="68" text-anchor="middle" font-size="12" font-weight="700" fill="white">+ Worker(s)</text>
    <text x="85" y="86" text-anchor="middle" font-size="10" fill="#e0f2fe">N 个 GPU 进程</text>
    <text x="190" y="22" font-size="12" font-weight="700" fill="#075985">Executor + Worker + ModelRunner（物理层，持显存）</text>
    <text x="190" y="38" font-size="10" font-family="monospace" fill="#075985">vllm/v1/executor/{multiproc,uniproc,ray}_executor.py</text>
    <text x="190" y="52" font-size="10" font-family="monospace" fill="#075985">vllm/v1/worker/gpu_worker.py</text>
    <text x="190" y="66" font-size="10" font-family="monospace" fill="#075985">vllm/v1/worker/gpu_model_runner.py (+ gpu_input_batch.py)</text>
    <text x="190" y="84" font-size="11" fill="#075985"><tspan font-weight="700">职责：</tspan>跨 GPU 广播 / 构造 batch / forward / 采样</text>
    <text x="190" y="96" font-size="11" fill="#075985"><tspan font-weight="700">类型：</tspan>SchedulerOutput → ModelRunnerOutput</text>
  </g>
  <text x="40" y="548" font-size="11" font-style="italic" fill="#64748b">关键：Scheduler 只持有逻辑 block_id（int），Worker 持有物理 KV tensor——这是 V1 相对 V0 最大的设计变化</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ vLLM V1 的四层架构。每层独立进程边界 + 强类型消息接口，让 HTTP/tokenize、调度算法、GPU 执行三件事完全解耦</span>

<details>
<summary>ASCII 原版</summary>

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: Entrypoint                                                 │
│    LLM (离线) / AsyncLLM (在线) / OpenAI API server                  │
│    vllm/entrypoints/llm.py, vllm/entrypoints/openai/api_server.py    │
│    vllm/v1/engine/async_llm.py, vllm/v1/engine/llm_engine.py         │
│                                                                      │
│    职责：Prompt 渲染 + tokenization + 流式输出 + HTTP                │
│    类型：PromptType / SamplingParams  -->  RequestOutput             │
└────────────────────────────┬────────────────────────────────────────┘
                             │  EngineCoreRequest (msgspec)
                             │  ZMQ (DEALER/ROUTER) 或 in-proc
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 2: Engine (EngineCore)                                       │
│    EngineCore + EngineCoreProc 主循环                                │
│    vllm/v1/engine/core.py                                            │
│                                                                      │
│    职责：busy loop，连接 Scheduler 和 Executor，DP 协调              │
│    类型：EngineCoreRequest  -->  EngineCoreOutputs                   │
└────────────────────────────┬────────────────────────────────────────┘
                             │  schedule()/update_from_output()
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: Scheduler + KVCacheManager                                │
│    vllm/v1/core/sched/scheduler.py                                   │
│    vllm/v1/core/kv_cache_manager.py + block_pool.py                  │
│                                                                      │
│    职责：决定本步执行哪些 req、各跑几个 token、分配 KV 块            │
│    类型:Request 状态                -->  SchedulerOutput            │
└────────────────────────────┬────────────────────────────────────────┘
                             │  SchedulerOutput (经 SHM MessageQueue)
                             │  collective_rpc("execute_model", ...)
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 4: Executor + Worker + ModelRunner                           │
│    vllm/v1/executor/{multiproc,uniproc,ray}_executor.py              │
│    vllm/v1/worker/gpu_worker.py                                      │
│    vllm/v1/worker/gpu_model_runner.py (+ gpu_input_batch.py)         │
│                                                                      │
│    职责：跨 GPU 广播、构造 batch、forward、采样                      │
│    类型：SchedulerOutput            -->  ModelRunnerOutput           │
└─────────────────────────────────────────────────────────────────────┘
```

</details>

### 1.1.1 各层关键类型

| 层 | 输入类型 | 输出类型 | 序列化方式 |
| --- | --- | --- | --- |
| Entrypoint | `PromptType` + `SamplingParams` | `RequestOutput` (流式) | Python 对象 |
| EngineCore | `EngineCoreRequest` | `EngineCoreOutputs` | `msgspec.Struct` (msgpack) over ZMQ |
| Scheduler | `Request` 内部状态 | `SchedulerOutput` (`@dataclass`) | 进程内 |
| Executor → Worker | `SchedulerOutput` | `ModelRunnerOutput` | `cloudpickle` over SHM `MessageQueue` |

入口定义集中在 `vllm/v1/engine/__init__.py`：
- `EngineCoreRequest` (`vllm/v1/engine/__init__.py:80`)
- `EngineCoreOutput` / `EngineCoreOutputs` (`vllm/v1/engine/__init__.py:167`, `:212`)
- `SchedulerOutput` (`vllm/v1/core/sched/output.py:181`)
- `ModelRunnerOutput` (`vllm/v1/outputs.py`)

### 1.1.2 为什么要这样切分

层与层之间的边界对应的是**性能与功能的隔离需求**：

- **Entrypoint vs EngineCore**：tokenization、HTTP 解析、多模态预处理、模板渲染都是 CPU 重的、可阻塞的工作。V0 中这些和 GPU 调度在同一个 Python 进程里，造成 GIL 抢占；V1 把它们与 GPU 调度分到**两个不同的 OS 进程**，HTTP 端永远不会因为 GPU 忙而失去响应性。
- **EngineCore vs Scheduler**：`EngineCore` 是"轮询调度并触发执行"的胶水层；`Scheduler` 是"决定执行什么"的纯算法层。`Scheduler` 没有任何线程或 IPC 状态，便于单测和替换实现（见 `vllm/v1/core/sched/interface.py` 中的 `SchedulerInterface`，以及 `async_scheduler.py` 的另一种实现）。
- **Scheduler vs Worker**：Scheduler 只持有"逻辑 KV 块"（block id），不接触显存；Worker 持有"物理 KV 张量"。两者通过 `SchedulerOutput` 中的 `block_ids` 配对。这让 KV cache 大小可以独立于 GPU 数动态规划。
- **Executor vs Worker**：`Executor` 处理跨 GPU 通信编排（broadcast / aggregate），`Worker` 只关心单卡的模型加载、forward、采样。把"分布式"独立成一层后，单机和 Ray 两种部署可以复用相同的 Worker 代码。

## 1.2 一次推理请求的完整生命周期

下面以"在线模式下，OpenAI server 收到一条 `/v1/completions` 请求，最终把生成的 token 流式返回客户端"为例，展开完整链路。涉及四个进程：HTTP server / EngineCore process / Worker process(es)。

<svg viewBox="0 0 760 760" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="一次在线请求的端到端生命周期：HTTP → AsyncLLM → EngineCore → Workers → 流式回传">
  <defs>
    <marker id="r12ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">一次在线请求的完整生命周期：四个进程 + 双向 ZMQ + SHM 广播</text>
  <text x="100" y="50" font-size="11" font-weight="700" fill="#9a3412">API server</text>
  <text x="100" y="64" font-size="10" fill="#94a3b8">FastAPI 进程</text>
  <line x1="200" y1="40" x2="200" y2="380" stroke="#cbd5e1" stroke-dasharray="3,3"/>
  <text x="380" y="50" font-size="11" font-weight="700" fill="#115e59">EngineCore process</text>
  <text x="380" y="64" font-size="10" fill="#94a3b8">独立子进程 + busy loop</text>
  <line x1="555" y1="40" x2="555" y2="600" stroke="#cbd5e1" stroke-dasharray="3,3"/>
  <text x="640" y="50" font-size="11" font-weight="700" fill="#075985">Worker procs</text>
  <text x="640" y="64" font-size="10" fill="#94a3b8">N × GPU rank</text>
  <g transform="translate(20, 76)">
    <rect x="0" y="0" width="180" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="90" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">HTTP POST /v1/completions</text>
    <text x="90" y="34" text-anchor="middle" font-size="9" fill="#9a3412">FastAPI route handler</text>
  </g>
  <path d="M 110 120 L 110 138" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
  <g transform="translate(20, 140)">
    <rect x="0" y="0" width="180" height="62" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="90" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">AsyncLLM.generate</text>
    <text x="90" y="33" text-anchor="middle" font-size="9" fill="#9a3412">async_llm.py:524</text>
    <text x="90" y="48" text-anchor="middle" font-size="9" fill="#9a3412">render + tokenize</text>
    <text x="90" y="58" text-anchor="middle" font-size="9" fill="#9a3412">→ EngineCoreRequest</text>
  </g>
  <path d="M 200 170 L 320 170" fill="none" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r12ar)"/>
  <text x="260" y="160" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#9a3412">ZMQ PUSH</text>
  <text x="260" y="184" text-anchor="middle" font-size="9" fill="#64748b">msgpack(EngineCoreRequest)</text>
  <g transform="translate(320, 138)">
    <rect x="0" y="0" width="220" height="120" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="110" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">EngineCoreProc.busy_loop</text>
    <text x="110" y="32" text-anchor="middle" font-size="9" font-family="monospace" fill="#115e59">core.py:1187</text>
    <line x1="10" y1="40" x2="210" y2="40" stroke="#5eead4"/>
    <text x="14" y="55" font-size="10" fill="#134e4a">① input thread → input_queue</text>
    <text x="14" y="71" font-size="10" fill="#134e4a">② Scheduler.add_request()</text>
    <text x="14" y="87" font-size="10" fill="#134e4a">③ Scheduler.schedule()</text>
    <text x="22" y="100" font-size="9" fill="#5b21b6">→ SchedulerOutput</text>
    <text x="14" y="115" font-size="10" fill="#134e4a">④ Executor.execute_model(...)</text>
  </g>
  <path d="M 540 258 L 560 258 L 560 286 L 600 286" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r12ar)"/>
  <text x="595" y="276" text-anchor="end" font-size="9" font-family="monospace" fill="#115e59">SHM broadcast</text>
  <g transform="translate(600, 270)">
    <rect x="0" y="0" width="140" height="50" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6"/>
    <text x="70" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#075985">Worker 0 / 1 / …</text>
    <text x="70" y="32" text-anchor="middle" font-size="9" font-family="monospace" fill="#075985">multiproc_executor:944</text>
    <text x="70" y="44" text-anchor="middle" font-size="9" fill="#075985">收 rpc_broadcast_mq</text>
  </g>
  <path d="M 670 320 L 670 340" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
  <g transform="translate(600, 342)">
    <rect x="0" y="0" width="140" height="116" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6"/>
    <text x="70" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#075985">GPUModelRunner</text>
    <text x="70" y="32" text-anchor="middle" font-size="9" font-family="monospace" fill="#075985">execute_model</text>
    <line x1="10" y1="40" x2="130" y2="40" stroke="#7dd3fc"/>
    <text x="14" y="55" font-size="9" fill="#0c4a6e">_update_states</text>
    <text x="22" y="66" font-size="8" fill="#075985">InputBatch 增量更新</text>
    <text x="14" y="80" font-size="9" fill="#0c4a6e">_prepare_inputs</text>
    <text x="22" y="91" font-size="8" fill="#075985">build attn metadata</text>
    <text x="14" y="103" font-size="9" fill="#0c4a6e">model.forward + sampler</text>
    <text x="22" y="112" font-size="8" fill="#075985">→ ModelRunnerOutput</text>
  </g>
  <path d="M 600 400 L 560 400 L 560 426 L 540 426" fill="none" stroke="#0284c7" stroke-width="1.5" marker-end="url(#r12ar)"/>
  <text x="595" y="392" text-anchor="end" font-size="9" font-family="monospace" fill="#075985">response_mqs (SHM)</text>
  <g transform="translate(320, 398)">
    <rect x="0" y="0" width="220" height="74" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="110" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">EngineCoreProc 续</text>
    <line x1="10" y1="26" x2="210" y2="26" stroke="#5eead4"/>
    <text x="14" y="40" font-size="10" fill="#134e4a">⑤ output thread 收 ModelRunnerOutput</text>
    <text x="14" y="54" font-size="10" fill="#134e4a">⑥ Scheduler.update_from_output</text>
    <text x="22" y="66" font-size="9" fill="#5b21b6">→ EngineCoreOutputs</text>
  </g>
  <path d="M 320 446 L 200 446" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r12ar)"/>
  <text x="260" y="438" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">ZMQ PULL</text>
  <text x="260" y="460" text-anchor="middle" font-size="9" fill="#64748b">msgpack(EngineCoreOutputs)</text>
  <g transform="translate(20, 488)">
    <rect x="0" y="0" width="180" height="98" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="90" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">AsyncLLM 续</text>
    <text x="90" y="32" text-anchor="middle" font-size="9" font-family="monospace" fill="#9a3412">_run_output_handler</text>
    <line x1="10" y1="40" x2="170" y2="40" stroke="#fdba74"/>
    <text x="14" y="55" font-size="10" fill="#9a3412">OutputProcessor.process_outputs</text>
    <text x="22" y="68" font-size="9" fill="#7c2d12">IncrementalDetokenizer</text>
    <text x="22" y="80" font-size="9" fill="#7c2d12">LogprobsProcessor</text>
    <text x="22" y="92" font-size="9" fill="#7c2d12">stop string 检测</text>
  </g>
  <path d="M 110 586 L 110 604" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
  <g transform="translate(20, 606)">
    <rect x="0" y="0" width="180" height="44" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="90" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">RequestOutputCollector.put</text>
    <text x="90" y="34" text-anchor="middle" font-size="9" fill="#9a3412">唤醒 user task 的 await</text>
  </g>
  <path d="M 110 650 L 110 668" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r12ar)"/>
  <g transform="translate(20, 670)">
    <rect x="0" y="0" width="180" height="44" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5" rx="6"/>
    <text x="90" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">yield RequestOutput</text>
    <text x="90" y="34" text-anchor="middle" font-size="9" fill="#14532d">→ SSE chunk → HTTP client</text>
  </g>
  <text x="20" y="734" font-size="10" font-style="italic" fill="#64748b">关键边界：API server ↔ EngineCore 走 ZMQ（msgpack），EngineCore ↔ Workers 走 SHM MessageQueue（cloudpickle）。</text>
  <text x="20" y="748" font-size="10" font-style="italic" fill="#64748b">stop string 在 frontend 检测而非 scheduler——后者无 tokenizer，是无字符串的纯 token-id 层。</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ 一次在线请求的完整生命周期：四个进程 + 双向 ZMQ + SHM 广播；scheduler 不接触字符串，detokenize/stop-string 都在 frontend 进程异步完成</span>

<details>
<summary>ASCII 原版</summary>

```
                    ┌──────────────┐
   HTTP POST  ───▶  │ FastAPI      │  (API server process)
                    │ api_server   │
                    └──────┬───────┘
                           │ AsyncLLM.generate(prompt, params)
                           ▼
                    ┌──────────────┐
                    │ AsyncLLM     │  vllm/v1/engine/async_llm.py
                    │  - render    │
                    │  - tokenize  │
                    └──────┬───────┘
                           │ EngineCoreRequest (msgspec)  ─── ZMQ PUSH ──▶
                           ▼
   ────────────────────────────────────────────────────────────────────────
                    ┌──────────────┐
                    │ EngineCoreProc│  (EngineCore process)
                    │  busy_loop    │  vllm/v1/engine/core.py:1187
                    └──────┬───────┘
                           │ (1) input thread 推到 input_queue
                           │ (2) Scheduler.add_request()
                           │ (3) Scheduler.schedule() -> SchedulerOutput
                           │ (4) Executor.execute_model(SchedulerOutput)
                           ▼
                    ┌──────────────┐
                    │ MultiprocExec│  vllm/v1/executor/multiproc_executor.py
                    │ rpc_broadcast│
                    │   _mq        │  (SHM MessageQueue)
                    └──┬─────┬─────┘
                       │     │
   ────────────────────┼─────┼──────────────────────────────────────────────
                       ▼     ▼
                  ┌──────┐ ┌──────┐
                  │Worker│ │Worker│  (Worker processes, 1 per TP rank)
                  │ 0    │ │ 1    │  vllm/v1/worker/gpu_worker.py
                  └──┬───┘ └──┬───┘
                     │        │ GPUModelRunner.execute_model()
                     │        │   - _update_states (InputBatch 增量更新)
                     │        │   - _prepare_inputs (build attn metadata)
                     │        │   - model.forward
                     │        │   - sampler.forward
                     │        │ ModelRunnerOutput (一步生成的 token / logprobs)
                     ▼        ▼
                  response_mqs (SHM)
   ────────────────────────────────────────────────────────────────────────
                           │
                           ▼
                    ┌──────────────┐
                    │ EngineCoreProc│
                    │ output thread │
                    │ Scheduler.update_from_output() -> EngineCoreOutputs
                    └──────┬───────┘
                           │ EngineCoreOutputs ─── ZMQ PULL ──▶
                           ▼
                    ┌──────────────┐
                    │ AsyncLLM      │
                    │  output_handler (asyncio task)
                    │  OutputProcessor.process_outputs()
                    │    - IncrementalDetokenizer (token → text 片段)
                    │    - LogprobsProcessor
                    │    - 检测 stop string
                    │  RequestOutputCollector.put(RequestOutput)
                    └──────┬───────┘
                           │ await q.get()
                           ▼
                    yield RequestOutput  ──▶  SSE chunk  ──▶  client
```

</details>

### 1.2.1 关键步骤源码定位

| 步骤 | 文件:行 |
| --- | --- |
| HTTP -> 创建 AsyncLLM | `vllm/entrypoints/openai/api_server.py:109` (`build_async_engine_client_from_engine_args`) |
| `AsyncLLM.generate` 入口 | `vllm/v1/engine/async_llm.py:524` |
| 渲染 + tokenize 成 `EngineCoreRequest` | `vllm/v1/engine/input_processor.py` (由 `AsyncLLM.__init__` 持有，见 `async_llm.py:135`) |
| 通过 ZMQ 把 request 发到 EngineCore | `AsyncLLM._add_request` → `engine_core.add_request_async` (`async_llm.py:400`) |
| EngineCore busy loop | `vllm/v1/engine/core.py:1187` (`run_busy_loop`) |
| `EngineCore.step` | `vllm/v1/engine/core.py:425` |
| `Scheduler.schedule` | `vllm/v1/core/sched/scheduler.py:329` |
| `Executor.execute_model` 跨进程派发 | `vllm/v1/executor/multiproc_executor.py:306` |
| Worker 主循环（接 RPC 调度） | `vllm/v1/executor/multiproc_executor.py:944` (`worker_busy_loop`) |
| `Worker.execute_model` | `vllm/v1/worker/gpu_worker.py:783` |
| `GPUModelRunner.execute_model` | `vllm/v1/worker/gpu_model_runner.py:3913` |
| `Scheduler.update_from_output` | `vllm/v1/core/sched/scheduler.py:1283` |
| AsyncLLM 后台输出处理 | `vllm/v1/engine/async_llm.py:637` (`_run_output_handler`) |
| 流式 detokenization | `vllm/v1/engine/detokenizer.py:30` (`IncrementalDetokenizer`) |
| 装配 `RequestOutput` | `vllm/v1/engine/output_processor.py:417` (`OutputProcessor.process_outputs`) |

### 1.2.2 一步 step 是什么

在 EngineCore 里，一次 `step()` 就是"产生一批 token"的最小单元。每个 step 内部：

```python
# vllm/v1/engine/core.py:425
def step(self) -> tuple[dict[int, EngineCoreOutputs], bool]:
    if not self.scheduler.has_requests():
        return {}, False
    scheduler_output = self.scheduler.schedule()
    future = self.model_executor.execute_model(scheduler_output, non_block=True)
    grammar_output = self.scheduler.get_grammar_bitmask(scheduler_output)
    model_output = future.result()
    if model_output is None:
        model_output = self.model_executor.sample_tokens(grammar_output)
    self._process_aborts_queue()
    engine_core_outputs = self.scheduler.update_from_output(
        scheduler_output, model_output
    )
    return engine_core_outputs, scheduler_output.total_num_scheduled_tokens > 0
```

要点：
- `schedule()` 一次可能同时调度 prefill chunk + decode（V1 默认 chunked prefill）。
- `execute_model` 与 `sample_tokens` 是**两阶段**——为了支持结构化输出（grammar bitmask）和 PP 重叠，allow 在 forward 完成后再做采样（见 `step_with_batch_queue`, `core.py:466`）。
- 一个 step 产出的所有 token，按 request 拆成 `EngineCoreOutput` 序列后封装为 `EngineCoreOutputs`，通过 ZMQ 推回 frontend。

### 1.2.3 第一个 token 与之后的 token

| 阶段 | 在 Scheduler 中 | 在 Worker 中 |
| --- | --- | --- |
| 首 token (prefill / TTFT) | `Scheduler.schedule` 把请求从 `waiting` 移到 `running`；分配 KV blocks；可能切 chunk | `_prepare_inputs` 构造大 query_len 的 attn metadata；forward 拿 prompt logits；sampler 出第一个 token |
| 后续 token (decode / TPOT) | 已在 `running`；每步只给 +1 token 预算（或 +k 用于 spec decode） | query_len=1（或 spec 的 1+k）；走 CUDA Graph 路径 |

V1 的 scheduler **不区分 prefill 和 decode**——每个请求始终维护 `num_computed_tokens` 与 `num_tokens_with_spec`，schedule 时只是把差值塞满 token 预算。这是 V1 取消独立 prefill 队列的关键，详见 `scheduler.py:329-339` 的注释。

## 1.3 V0 vs V1：为什么要重构

V1 是 2024 年下半年开始的重写，到 2025 年成为默认。V0 还存活于 `vllm/engine/` 与 `vllm/core/` 但已不再接受新功能；本 wiki 不展开 V0 代码。下表罗列 V1 修复的核心痛点：

| 维度 | V0 现象 | V1 解法 |
| --- | --- | --- |
| **进程模型** | LLMEngine 与 GPU 调度在同一个 Python 进程，HTTP 端被 GIL 阻塞 | EngineCore 独立成进程 (`EngineCoreProc`)，HTTP/tokenize 留在 frontend，进程间用 ZMQ 通信 (`core.py:829`) |
| **Detokenizer** | 同步走 frontend，与 forward 串行 | `IncrementalDetokenizer` 在 frontend 进程的后台 asyncio task / 工作线程中跑 (`async_llm.py:637`)，与 GPU forward 完全重叠 |
| **Scheduler** | 三个并列队列 waiting/running/swapped，prefill 阶段独占，难以 chunked prefill | 单一时间轴 + token 预算（`num_computed_tokens` 追赶 `num_tokens_with_spec`），天然支持 chunked prefill / prefix cache / spec decode |
| **请求表示** | `SequenceGroup` + `Sequence` 嵌套，状态分散 | 扁平的 `Request` 对象 (`vllm/v1/request.py:59`)，子请求（n>1）通过 `ParentRequest` 显式管理 |
| **KV cache** | `BlockManager` v1/v2 两套，逻辑/物理混杂 | `KVCacheManager` + `BlockPool` + `KVCacheCoordinator`，逻辑块只在 scheduler，物理张量只在 worker (`vllm/v1/core/kv_cache_manager.py:110`) |
| **CUDA Graph** | 仅 decode；切 batch size 必须 padding 到桶 | `CUDAGraphDispatcher` (`vllm/v1/cudagraph_dispatcher.py`) 支持多种 batch descriptor，prefill 也能进入图 |
| **多模态** | 编码器结果在 worker 内部缓存，scheduler 不感知 | `EncoderCacheManager` 让 scheduler 把编码作为可调度任务管理 (`vllm/v1/core/encoder_cache_manager.py`) |
| **PP** | PP 与 scheduling 紧耦合 | `step_with_batch_queue` (`core.py:466`) 用 `batch_queue` 异步流水，scheduler 不需要感知 PP |
| **Async scheduling** | 不支持 | `AsyncScheduler` (`vllm/v1/core/sched/async_scheduler.py`) + worker 端 draft token 反馈，可在 forward 时已经开始 schedule 下一步 |
| **跨节点 KV 传输** | 没有抽象 | `KVConnector` (`vllm/distributed/kv_transfer/kv_connector/v1/`) 与 scheduler/executor 集成，支持 P/D 解耦、offload |

简言之，V1 把"调度算法"、"GPU 执行"、"前端 I/O"三件事**彻底解耦成三个层 + 三套进程**；V0 的所有性能优化都被重新设计成 V1 的一等公民。

## 1.4 进程模型

### 1.4.1 在线模式（OpenAI server, `AsyncLLM`）

最少 1 + 1 + N 个进程：

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="在线模式 1+1+N 进程拓扑">
  <defs>
    <marker id="r13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">在线模式的进程拓扑：1 个 API server + 1 个 EngineCore + N 个 Worker（每张 GPU 一个）</text>
  <g transform="translate(40, 52)">
    <rect x="0" y="0" width="280" height="160" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="8"/>
    <text x="140" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#9a3412">API server process</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#9a3412">运行 HTTP + tokenize + detokenize</text>
    <line x1="14" y1="46" x2="266" y2="46" stroke="#fdba74"/>
    <text x="20" y="64" font-size="11" fill="#7c2d12">uvicorn / FastAPI</text>
    <text x="20" y="82" font-size="11" fill="#7c2d12">AsyncLLM</text>
    <text x="20" y="100" font-size="11" fill="#7c2d12">InputProcessor（渲染 + tokenize）</text>
    <text x="20" y="118" font-size="11" fill="#7c2d12">OutputProcessor（停止符 + logprobs）</text>
    <text x="20" y="136" font-size="11" fill="#7c2d12">IncrementalDetokenizer（async task）</text>
    <text x="20" y="152" font-size="9" fill="#94a3b8">CPU-heavy 任务全在这里，与 GPU 完全异步</text>
  </g>
  <g transform="translate(440, 52)">
    <rect x="0" y="0" width="280" height="160" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="8"/>
    <text x="140" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#115e59">EngineCore process</text>
    <text x="140" y="36" text-anchor="middle" font-size="10" fill="#115e59">纯 GPU 调度循环 + 子进程编排</text>
    <line x1="14" y1="46" x2="266" y2="46" stroke="#5eead4"/>
    <text x="20" y="64" font-size="11" fill="#134e4a">EngineCoreProc (busy loop + 3 thread)</text>
    <text x="20" y="82" font-size="11" fill="#134e4a">Scheduler + KVCacheManager</text>
    <text x="20" y="100" font-size="11" fill="#134e4a">MultiprocExecutor</text>
    <text x="20" y="118" font-size="11" fill="#134e4a">input / output / monitor 三线程</text>
    <text x="20" y="136" font-size="9" fill="#94a3b8">无 tokenizer、无 HTTP，节省 GIL；</text>
    <text x="20" y="148" font-size="9" fill="#94a3b8">通过 collective_rpc 派发到 worker</text>
  </g>
  <path d="M 320 132 L 440 132" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r13ar)"/>
  <path d="M 440 152 L 320 152" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r13ar)"/>
  <text x="380" y="124" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#475569">ZMQ DEALER / ROUTER</text>
  <text x="380" y="170" text-anchor="middle" font-size="9" fill="#64748b">msgpack(EngineCoreRequest / EngineCoreOutputs)</text>
  <path d="M 580 212 L 580 240" fill="none" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r13ar)"/>
  <text x="588" y="230" font-size="9" font-family="monospace" fill="#115e59">SHM MessageQueue (rpc_broadcast_mq)</text>
  <g transform="translate(280, 242)">
    <rect x="0" y="0" width="110" height="76" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6"/>
    <text x="55" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#075985">Worker 0</text>
    <text x="55" y="38" text-anchor="middle" font-size="10" fill="#075985">GPU 0</text>
    <text x="55" y="54" text-anchor="middle" font-size="9" fill="#0c4a6e">gpu_worker.py</text>
    <text x="55" y="66" text-anchor="middle" font-size="9" fill="#0c4a6e">+ GPUModelRunner</text>
  </g>
  <g transform="translate(410, 242)">
    <rect x="0" y="0" width="110" height="76" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6"/>
    <text x="55" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#075985">Worker 1</text>
    <text x="55" y="38" text-anchor="middle" font-size="10" fill="#075985">GPU 1</text>
    <text x="55" y="54" text-anchor="middle" font-size="9" fill="#0c4a6e">gpu_worker.py</text>
    <text x="55" y="66" text-anchor="middle" font-size="9" fill="#0c4a6e">+ GPUModelRunner</text>
  </g>
  <g transform="translate(540, 242)">
    <rect x="0" y="0" width="110" height="76" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="6" stroke-dasharray="4,3"/>
    <text x="55" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#075985">Worker …</text>
    <text x="55" y="38" text-anchor="middle" font-size="10" fill="#075985">GPU N-1</text>
    <text x="55" y="58" text-anchor="middle" font-size="9" fill="#64748b">TP × PP 一格一进程</text>
  </g>
  <path d="M 280 280 L 200 280 Q 180 280 180 296 L 180 318" fill="none" stroke="#0284c7" stroke-width="1.2" stroke-dasharray="3,2"/>
  <path d="M 650 280 L 720 280 Q 740 280 740 296 L 740 318" fill="none" stroke="#0284c7" stroke-width="1.2" stroke-dasharray="3,2"/>
  <text x="40" y="338" font-size="10" font-style="italic" fill="#64748b">Worker ↔ Worker 之间靠 NCCL collectives（TP all-reduce / PP send-recv）；EngineCore 不参与张量级通信。</text>
  <text x="40" y="352" font-size="10" font-style="italic" fill="#64748b">DP 启用时另有 DPCoordinator 进程做 wave 同步；Ray 部署时 worker 由 Ray actor 替代但接口一致。</text>
</svg>
<span class="figure-caption">图 R1.3 ｜ 在线模式的 1+1+N 进程拓扑：CPU/HTTP 跟 GPU 完全异进程；ZMQ 串 frontend ↔ EngineCore，SHM 串 EngineCore ↔ workers，worker 之间走 NCCL</span>

<details>
<summary>ASCII 原版</summary>

```
┌─────────────────────────┐         ┌──────────────────────────┐
│ API server process      │  ZMQ    │ EngineCore process       │
│  - uvicorn / FastAPI    │ ◀────▶  │  - EngineCoreProc        │
│  - AsyncLLM             │ DEALER/ │  - Scheduler             │
│  - InputProcessor       │ ROUTER  │  - MultiprocExecutor     │
│  - OutputProcessor      │         │                          │
│  - Detokenizer (async)  │         │                          │
└─────────────────────────┘         └────────┬─────────────────┘
                                              │ SHM MessageQueue
                                              │ (rpc_broadcast_mq)
                                              ▼
                         ┌──────────┐ ┌──────────┐  ...
                         │ Worker 0 │ │ Worker 1 │
                         │  (GPU 0) │ │  (GPU 1) │
                         └──────────┘ └──────────┘
```

</details>

- **API server ↔ EngineCore**：ZMQ over TCP/IPC，消息编码 `msgspec.msgpack`。Frontend 是 `AsyncMPClient` (`vllm/v1/engine/core_client.py:887`)，engine 端是 `EngineCoreProc.process_input_sockets` / `process_output_sockets` (`core.py:1395`)。
- **EngineCore ↔ Workers**：共享内存 ring buffer，由 `MessageQueue` 实现（`vllm/distributed/device_communicators/shm_broadcast.py`）。EngineCore 把 `SchedulerOutput` 一次性广播给所有 worker；worker 完成后把 `ModelRunnerOutput` 写回各自的 `response_mqs`。Driver worker (rank 0 PP-last) 是聚合点，由 `output_rank` (`multiproc_executor.py:480`) 决定。
- **进程启动**：`MultiprocExecutor._init_executor` (`multiproc_executor.py:109`) 通过 `WorkerProc.make_worker_process` fork/spawn 出 N 个 worker，每个 worker 在 `worker_busy_loop` (`multiproc_executor.py:944`) 中等 RPC。
- **DP 协调**：若启用数据并行，存在额外的 `DPCoordinator` 进程，多 EngineCore 之间通过它做 wave 同步（见 `vllm/v1/engine/coordinator.py`）。

握手细节（启动顺序）：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="启动握手序列：Frontend、EngineCoreProc、Workers 三方时序">
  <defs>
    <marker id="r14ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">启动握手时序：Frontend ↔ EngineCoreProc ↔ Workers</text>
  <text x="120" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">Frontend</text>
  <text x="380" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#115e59">EngineCoreProc</text>
  <text x="640" y="56" text-anchor="middle" font-size="12" font-weight="700" fill="#075985">Workers</text>
  <line x1="120" y1="68" x2="120" y2="350" stroke="#ea580c" stroke-width="1.5"/>
  <line x1="380" y1="68" x2="380" y2="350" stroke="#0d9488" stroke-width="1.5"/>
  <line x1="640" y1="68" x2="640" y2="350" stroke="#0284c7" stroke-width="1.5"/>
  <rect x="110" y="68" width="20" height="12" fill="#fed7aa" stroke="#ea580c"/>
  <rect x="370" y="68" width="20" height="12" fill="#99f6e4" stroke="#0d9488"/>
  <rect x="630" y="68" width="20" height="12" fill="#bae6fd" stroke="#0284c7"/>
  <path d="M 130 96 L 370 96" fill="none" stroke="#9a3412" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="250" y="90" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#9a3412">HELLO</text>
  <path d="M 370 124 L 130 124" fill="none" stroke="#115e59" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="250" y="118" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">EngineHandshakeMeta</text>
  <path d="M 370 152 L 130 152" fill="none" stroke="#115e59" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="250" y="146" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">EngineCoreReady</text>
  <path d="M 390 180 L 630 180" fill="none" stroke="#115e59" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="174" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">spawn workers</text>
  <text x="510" y="194" text-anchor="middle" font-size="9" fill="#94a3b8">fork/spawn N 个 WorkerProc</text>
  <path d="M 390 218 L 630 218" fill="none" stroke="#115e59" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="212" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">rpc("init_device")</text>
  <text x="510" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">NCCL 初始化 / set_device</text>
  <path d="M 390 256 L 630 256" fill="none" stroke="#115e59" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="250" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#115e59">rpc("load_model")</text>
  <text x="510" y="270" text-anchor="middle" font-size="9" fill="#94a3b8">权重加载到 HBM</text>
  <path d="M 390 294 L 630 294" fill="none" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="288" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#5b21b6">determine_available_memory</text>
  <text x="510" y="306" text-anchor="middle" font-size="9" fill="#94a3b8">profile_run 探测显存峰值</text>
  <path d="M 390 322 L 630 322" fill="none" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="316" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#5b21b6">initialize_from_config</text>
  <text x="510" y="336" text-anchor="middle" font-size="9" fill="#94a3b8">分配 KV pool</text>
  <path d="M 390 348 L 630 348" fill="none" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r14ar)"/>
  <text x="510" y="342" text-anchor="middle" font-size="10" font-family="monospace" font-weight="700" fill="#5b21b6">compile_or_warm_up_model</text>
  <text x="510" y="362" text-anchor="middle" font-size="9" fill="#94a3b8">CUDA Graph capture</text>
</svg>
<span class="figure-caption">图 R1.4 ｜ 启动握手时序：Frontend 先与 EngineCoreProc 握手，EngineCore 再串行驱动 workers 完成 init_device → load_model → KV 探测 → KV 分配 → CUDA Graph 预热</span>

<details>
<summary>ASCII 原版</summary>

```
Frontend                    EngineCoreProc                Workers
   │  HELLO  ──────────────▶  │                              │
   │  ◀── EngineHandshakeMeta │                              │
   │  ◀── EngineCoreReady     │  spawn workers ────────────▶ │
   │                          │  rpc("init_device") ───────▶ │
   │                          │  rpc("load_model")  ───────▶ │
   │                          │  determine_available_memory  │
   │                          │  initialize_from_config ───▶ │ (alloc KV)
   │                          │  compile_or_warm_up_model ─▶ │ (CUDA graph)
```

</details>

代码入口：`EngineCoreProc._perform_handshakes` (`core.py:944`)；KV 初始化 `EngineCore._initialize_kv_caches` (`core.py:231`)。

### 1.4.2 离线模式（`LLM`）

```
┌─────────────────────────────────────────┐
│ User process                            │
│  - LLM.__init__                         │
│  - LLMEngine                            │
│  - EngineCoreClient                     │
│    ├─ InprocClient   (单进程,默认 off) │
│    └─ SyncMPClient   (开 multiproc)    │
└─────────────────────────────────────────┘
```

`LLM.generate()` 是同步阻塞循环，结构上比 `AsyncLLM` 简单：

```python
# vllm/entrypoints/llm.py:1440
while self.llm_engine.has_unfinished_requests():
    step_outputs = self.llm_engine.step()
    for output in step_outputs:
        if output.finished:
            outputs.append(output)
```

`LLMEngine.step` 直接调 `engine_core.get_output()` (`vllm/v1/engine/llm_engine.py:287`)。如果 `VLLM_ENABLE_V1_MULTIPROCESSING=1`（默认），`engine_core` 是 `SyncMPClient`，背后仍然是独立的 EngineCore 进程；否则是 `InprocClient`，EngineCore 与 user code 同进程。

### 1.4.3 通信通道速查

| 通道 | 用途 | 类型 | 序列化 |
| --- | --- | --- | --- |
| Frontend ↔ EngineCore (input) | `EngineCoreRequest`, abort, utility RPC | ZMQ `DEALER`/`ROUTER` | msgpack (`msgspec.Struct`) |
| Frontend ↔ EngineCore (output) | `EngineCoreOutputs` | ZMQ `PULL`/`PUSH` | msgpack |
| EngineCore ↔ Workers (broadcast) | `SchedulerOutput`, RPC method/args | SHM `MessageQueue` (`shm_broadcast.py`) | `cloudpickle` + pickle |
| Workers ↔ EngineCore (response) | `ModelRunnerOutput` | SHM `MessageQueue` (per worker) | `cloudpickle` |
| Worker ↔ Worker (TP/PP) | activation / KV | NCCL collectives (custom AllReduce 等) | torch tensor |
| Across engines (DP) | wave 同步、stats | ZMQ via `DPCoordinator` | msgpack |
| Cross-host KV | prefix block KV bytes | NIXL / Mooncake / 其他 `KVConnector` | 自定义 |

## 1.5 离线 vs 在线模式

`LLM` 与 `AsyncLLM` 都最终调用同一个 `EngineCore`，区别只在前端形态：

| 维度 | `LLM` (离线) | `AsyncLLM` + OpenAI server (在线) |
| --- | --- | --- |
| 调用方式 | 同步 `generate(prompts, params)` -> 列表 | 异步 `async for out in async_llm.generate(...)` |
| Engine client | `InprocClient` 或 `SyncMPClient` | `AsyncMPClient` / `DPAsyncMPClient` / `DPLBAsyncMPClient` |
| 输出消费 | 主线程 while loop pull `step()` | 后台 asyncio task 持续 `get_output_async()` 并 `put` 到每个 request 的 `RequestOutputCollector` |
| Detokenization | 主线程同步调用 `OutputProcessor.process_outputs` (`llm_engine.py:300`) | 后台 task 异步执行，结果通过 `RequestOutputCollector` 推到 generator (`async_llm.py:637`) |
| 流式 | 不天然支持（每个 step 都返回累计输出，调用方筛 finished） | 天然支持；每个 token/chunk 直接 yield |
| 适用 | 批量评测、训练数据生成、RL rollout | 生产推理服务 |

源码差异极小：
- 共享 `InputProcessor` (`vllm/v1/engine/input_processor.py`) 与 `OutputProcessor` (`vllm/v1/engine/output_processor.py`)。
- 共享 `EngineCore` 与所有 V1 worker 代码。
- 不共享：`LLMEngine` 是阻塞封装 (`vllm/v1/engine/llm_engine.py`)，`AsyncLLM` 是异步封装 (`vllm/v1/engine/async_llm.py`)。

OpenAI server 只是在 `AsyncLLM` 外层加了 HTTP 路由（`vllm/entrypoints/openai/`），由 `build_async_engine_client_from_engine_args` (`api_server.py:109`) 创建 `AsyncLLM` 并以 FastAPI dependency 注入。

## 1.6 目录速查表

只列出 V1 相关、读源码时最常访问的目录。

### `vllm/v1/engine/` — 引擎与前端

| 文件 | 主要内容 |
| --- | --- |
| `__init__.py` | `EngineCoreRequest` / `EngineCoreOutput` / `EngineCoreOutputs` 消息定义 |
| `async_llm.py` | `AsyncLLM` 异步前端，含 `generate` 与后台 output handler |
| `llm_engine.py` | `LLMEngine` 同步前端（离线 `LLM` 使用） |
| `core.py` | `EngineCore` 主类 + `EngineCoreProc` 进程包装 + busy loop + ZMQ |
| `core_client.py` | `InprocClient` / `SyncMPClient` / `AsyncMPClient` 三种客户端 |
| `coordinator.py` | DP 多引擎协调进程 |
| `input_processor.py` | 把 user prompt 渲染、tokenize、多模态预处理成 `EngineCoreRequest` |
| `output_processor.py` | `EngineCoreOutput` -> `RequestOutput`，处理 stop string、prompt logprobs |
| `detokenizer.py` | 增量 detokenization（fast 路径使用 `tokenizers` 库的 `DecodeStream`） |
| `logprobs.py` | top-k logprobs 累积 |
| `parallel_sampling.py` | `n > 1` 的子请求 fan-out (`ParentRequest`) |
| `tensor_ipc.py` | 多模态 tensor 跨进程零拷贝传输（共享内存） |

### `vllm/v1/core/` — 调度与 KV 管理

| 文件 | 主要内容 |
| --- | --- |
| `sched/scheduler.py` | 默认 `Scheduler` 实现，包含 `schedule()` 与 `update_from_output()` |
| `sched/async_scheduler.py` | 异步调度变体（与 worker 端反馈协作） |
| `sched/interface.py` | `SchedulerInterface` 抽象 + `PauseState` |
| `sched/output.py` | `SchedulerOutput` / `NewRequestData` / `CachedRequestData` / `GrammarOutput` |
| `sched/request_queue.py` | FCFS / priority 等待队列 |
| `kv_cache_manager.py` | 顶层 KV cache 接口，分配/释放/前缀缓存查询 |
| `block_pool.py` | 物理块 ID 池 + LRU 回收 + 前缀缓存哈希表 |
| `kv_cache_coordinator.py` | 多 KV 组（attention + mamba 等混合架构）协调器 |
| `kv_cache_utils.py` | 块哈希、KV 配置生成（含 auto-fit `max_model_len`） |
| `single_type_kv_cache_manager.py` | 同类 KV 组的实际块分配逻辑（attention/sliding window/chunked） |
| `encoder_cache_manager.py` | 多模态编码器输出缓存（调度可感知） |

### `vllm/v1/worker/` — Worker 与 ModelRunner

| 文件 | 主要内容 |
| --- | --- |
| `worker_base.py` | `WorkerBase` / `WorkerWrapperBase`（被 executor 通过 cloudpickle 发到子进程实例化） |
| `gpu_worker.py` | `Worker` 主类，含 `init_device`/`load_model`/`determine_available_memory`/`execute_model` |
| `gpu_model_runner.py` | `GPUModelRunner`，最重要的单体类（7k+ 行）；构造 batch、跑 forward、采样 |
| `gpu_input_batch.py` | `InputBatch` 持久 batch 结构 + `CachedRequestState` 增量更新 |
| `block_table.py` | 每个 KV 组的 block table（GPU 上的 int32 张量） |
| `gpu/` | 新一代 V2 ModelRunner（实验中，通过 `use_v2_model_runner` 切换） |
| `ubatching.py` / `gpu_ubatch_wrapper.py` | DBO (Dual Batch Overlap) 微批拆分 |
| `kv_connector_model_runner_mixin.py` | KV connector 与 runner 的集成（pull/push 远端 KV） |
| `lora_model_runner_mixin.py` | LoRA 适配器加载/切换 |
| `cpu_worker.py` / `cpu_model_runner.py` / `xpu_*` / `tpu_*` | 其他硬件后端 |

### `vllm/v1/executor/` — 分布式执行编排

| 文件 | 主要内容 |
| --- | --- |
| `abstract.py` | `Executor` 抽象基类，所有 `execute_model`/`sample_tokens`/`collective_rpc` 入口 |
| `uniproc_executor.py` | 单进程（同进程跑 worker），开发/调试用；`ExecutorWithExternalLauncher` 用于 `torchrun` |
| `multiproc_executor.py` | 单机多 GPU 的子进程 executor（默认） |
| `ray_executor.py` / `ray_executor_v2.py` | 基于 Ray actor 的多机 executor |

### `vllm/v1/attention/` — V1 attention backend 接口

| 文件 | 主要内容 |
| --- | --- |
| `backend.py` | `AttentionBackend` / `AttentionMetadataBuilder` 抽象 |
| `selector.py` | 运行时选择 backend（FlashAttention / FlashInfer / Triton / Mamba…） |
| `backends/flash_attn.py` 等 | 各具体后端，每个负责构造 metadata + 调用对应 kernel |
| `backends/mla/` | MLA (DeepSeek-style multi-head latent attention) |
| `ops/` | 通用注意力工具函数（rotary 等） |

### `vllm/v1/sample/` — 采样

| 文件 | 主要内容 |
| --- | --- |
| `sampler.py` | `Sampler` 主类：top-p/top-k/temperature/min-p/seeded 等 |
| `metadata.py` | `SamplingMetadata`（从 `InputBatch` 抽取的张量化采样参数） |
| `logits_processor/` | 可插拔 logits processors（含 structured output、min-p、自定义） |
| `rejection_sampler.py` | Speculative decoding 的拒绝采样 |
| `ops/` | top-p/top-k 等 kernel |

### `vllm/model_executor/` — 模型与层（V0/V1 共享）

| 子目录 | 主要内容 |
| --- | --- |
| `models/` | 每个模型架构一个文件（LLaMA / Mistral / Qwen / DeepSeek / …） |
| `layers/` | `Linear`、`RotaryEmbedding`、`LayerNorm`、`fused_moe`、`quantization` 等 |
| `model_loader/` | safetensors / GGUF / sharded checkpoint 加载 |
| `kernels/` | 自定义 CUDA / Triton kernel |

注意：模型类是 V0/V1 共用的；V1 通过 `set_current_vllm_config` 上下文 + monkey-patch attention 层来让同一模型代码跑在 V1 attention backend 上。

### `vllm/distributed/` — 并行与跨节点通信

| 子目录 / 文件 | 主要内容 |
| --- | --- |
| `parallel_state.py` | 全局 `tp_group`/`pp_group`/`dp_group`/`ep_group` 单例与 `init_distributed_environment` |
| `device_communicators/` | NCCL / 自定义 AllReduce / SHM `MessageQueue`（`shm_broadcast.py` 即 executor 用的 ring buffer） |
| `kv_transfer/` | KV connector V1：跨节点 KV pull/push 抽象（NIXL、Mooncake、LMCache 等） |
| `kv_events.py` | 对外发布的 KV cache 事件（用于路由层做亲和度调度） |
| `weight_transfer/` | RL 训练时从 trainer 推权重到 inference 实例 |
| `eplb/` | 专家并行负载均衡（MoE） |

## 1.7 KV cache 的"逻辑 / 物理"分离

V1 的一项关键设计是 **scheduler 不接触 GPU 显存**。它只持有"逻辑 block id"，把"id → 实际 KV tensor 切片"的映射完全交给 worker。这个对称结构是阅读 KV 相关代码时容易卡住的地方，单独抽出来说明。

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="KV cache 在 scheduler 与 worker 进程间的逻辑/物理分离">
  <defs>
    <marker id="r15ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">KV cache 的逻辑 / 物理双层：scheduler 只持 int，worker 持张量</text>
  <text x="40" y="56" font-size="11" font-weight="700" fill="#5b21b6">EngineCore 进程 ─ 逻辑层（全程零显存）</text>
  <g transform="translate(40, 66)">
    <rect x="0" y="0" width="680" height="156" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="8"/>
    <text x="20" y="22" font-size="12" font-weight="700" fill="#5b21b6">Scheduler</text>
    <text x="20" y="38" font-size="9" font-family="monospace" fill="#5b21b6">vllm/v1/core/sched/scheduler.py</text>
    <g transform="translate(40, 50)">
      <rect x="0" y="0" width="280" height="88" fill="#ede9fe" stroke="#a78bfa" rx="4"/>
      <text x="14" y="18" font-size="11" font-weight="700" fill="#5b21b6">KVCacheManager</text>
      <text x="14" y="34" font-size="10" fill="#5b21b6">└─ BlockPool</text>
      <text x="28" y="48" font-size="10" fill="#5b21b6">├─ free_block_queue（LRU）</text>
      <text x="28" y="62" font-size="10" fill="#5b21b6">├─ block_hash → block_id</text>
      <text x="28" y="76" font-size="10" fill="#5b21b6">└─ ref_cnt per block</text>
    </g>
    <g transform="translate(340, 50)">
      <rect x="0" y="0" width="320" height="88" fill="#ede9fe" stroke="#a78bfa" rx="4"/>
      <text x="14" y="18" font-size="11" font-weight="700" fill="#5b21b6">每个 Request 持有</text>
      <text x="14" y="34" font-size="10" fill="#5b21b6">block_ids: list[int]</text>
      <text x="14" y="48" font-size="10" fill="#5b21b6">num_computed_tokens / num_tokens</text>
      <text x="14" y="62" font-size="10" fill="#5b21b6">+ KVCacheCoordinator 处理多组（attn+ssm 混合）</text>
      <text x="14" y="80" font-size="9" fill="#7c3aed" font-style="italic">block_id 全程只是 int，与 GPU 显存零耦合</text>
    </g>
  </g>
  <path d="M 380 222 L 380 290" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r15ar)"/>
  <rect x="200" y="232" width="360" height="52" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="380" y="250" text-anchor="middle" font-size="11" font-weight="700" fill="#475569">SchedulerOutput（每 step 广播一次）</text>
  <text x="380" y="266" text-anchor="middle" font-size="10" font-family="monospace" fill="#475569">block_ids per request · new_block_ids_to_zero</text>
  <text x="380" y="278" text-anchor="middle" font-size="9" fill="#94a3b8">只发 int 数组，不发 KV 张量本身</text>
  <text x="40" y="306" font-size="11" font-weight="700" fill="#075985">Worker 进程 ─ 物理层（实际显存）</text>
  <g transform="translate(40, 316)">
    <rect x="0" y="0" width="680" height="148" fill="#bae6fd" stroke="#0284c7" stroke-width="1.5" rx="8"/>
    <text x="20" y="22" font-size="12" font-weight="700" fill="#075985">GPUModelRunner</text>
    <text x="20" y="38" font-size="9" font-family="monospace" fill="#075985">vllm/v1/worker/gpu_model_runner.py</text>
    <g transform="translate(20, 50)">
      <rect x="0" y="0" width="320" height="82" fill="#e0f2fe" stroke="#38bdf8" rx="4"/>
      <text x="14" y="18" font-size="11" font-weight="700" fill="#075985">KV tensor（per layer，真的张量）</text>
      <text x="14" y="36" font-size="10" font-family="monospace" fill="#0c4a6e">shape = [num_blocks, block_size,</text>
      <text x="14" y="50" font-size="10" font-family="monospace" fill="#0c4a6e">          num_kv_heads, head_dim]</text>
      <text x="14" y="68" font-size="10" fill="#075985">block_id 即第 1 维下标</text>
      <text x="14" y="78" font-size="9" font-style="italic" fill="#0369a1">由 initialize_from_config 一次性分配，永不扩</text>
    </g>
    <g transform="translate(360, 50)">
      <rect x="0" y="0" width="300" height="82" fill="#e0f2fe" stroke="#38bdf8" rx="4"/>
      <text x="14" y="18" font-size="11" font-weight="700" fill="#075985">InputBatch.block_table（GPU int32）</text>
      <text x="14" y="36" font-size="10" font-family="monospace" fill="#0c4a6e">[max_req, max_blocks] = block_id</text>
      <text x="14" y="52" font-size="10" fill="#075985">每 step 增量从 SchedulerOutput 写入</text>
      <text x="14" y="68" font-size="10" fill="#075985">Attention backend 读这张表做 paged gather</text>
      <text x="14" y="78" font-size="9" font-style="italic" fill="#0369a1">FlashAttention / FlashInfer 的核心入参</text>
    </g>
  </g>
  <g transform="translate(40, 472)">
    <text x="0" y="0" font-size="10" fill="currentColor"><tspan font-weight="700" fill="#475569">关键不变量：</tspan>scheduler 改 block_ids 不会触碰任何 GPU 张量；worker 只信 block_table——一旦表里某 id 指向错误物理 block，attention 就读到旧 NaN（所以 new_block_ids_to_zero 必须 forward 前清零）。</text>
  </g>
</svg>
<span class="figure-caption">图 R1.5 ｜ KV cache 在 EngineCore 与 Worker 之间的逻辑/物理切分：scheduler 只决策 block_id，worker 持有真正的 KV 张量与 block_table；二者只通过 int 数组沟通</span>

<details>
<summary>ASCII 原版</summary>

```
                    ┌──────────────────────────────┐
EngineCore process: │  Scheduler                   │
                    │   ├─ KVCacheManager          │  逻辑层
                    │   │   ├─ BlockPool           │  - block_id 是 int
                    │   │   │   ├─ free_block_queue│  - 全程不分配显存
                    │   │   │   └─ block_hash → id │  - 决策：哪个 req 用哪些 id
                    │   │   └─ Coordinator (多组)  │
                    │   └─ Request.block_ids       │
                    └──────────────┬───────────────┘
                                   │ SchedulerOutput
                                   │   - block_ids per request
                                   │   - new_block_ids_to_zero
                                   ▼
                    ┌──────────────────────────────┐
Worker process:     │  GPUModelRunner              │  物理层
                    │   ├─ KV tensor (per layer)   │  - 实际显存
                    │   │   形状: [num_blocks,     │  - block_id 索引这里
                    │   │           block_size,    │  - 由 InputBatch 拼成
                    │   │           num_heads,     │    attention 的 KV cache
                    │   │           head_dim]      │
                    │   ├─ InputBatch.block_table  │  - block table GPU 张量
                    │   │   形状: [max_req, max_blk│    [req_idx][slot] = blk_id
                    │   │                          │
                    │   └─ Attention backend       │  - 根据 block_table 做
                    │       (FlashAttn/FlashInfer) │    paged KV gather
                    └──────────────────────────────┘
```

</details>

设计要点：
- **块大小**：`block_size` 由 `vllm/v1/core/kv_cache_utils.py:resolve_kv_cache_block_sizes` 决定（依赖模型架构与后端约束），通常 16 或 32 个 token。
- **块哈希**：开启 `enable_prefix_caching` 时，每个块由 `hash(parent_hash, token_ids[start:end], lora_id, mm_features)` 计算（见 `kv_cache_utils.py` 里的 `get_request_block_hasher`）。哈希命中后 `BlockPool` 直接复用旧块；引用计数为 0 时归还到 LRU 队列。
- **零化新块**：scheduler 在 `SchedulerOutput.new_block_ids_to_zero` (`sched/output.py:241`) 告知 worker 哪些块是首次分配，worker 在 forward 前把这些块的显存清零，避免 SSM/attention 读到旧 NaN。
- **多组（hybrid）**：`KVCacheCoordinator` 在像 Jamba / Hymba 这种 attention+mamba 混合架构里同时管理多个 spec，不同组可能 `block_size` 不同。Scheduler 用一组 `block_ids` 元组（每组一份）表达。
- **跨节点 KV**：`KVConnector` (`vllm/distributed/kv_transfer/kv_connector/v1/`) 既能在 scheduler 端"声明这个 req 的 prefix 在远端有缓存，请发起拉取"，也能在 worker 端"完成后向 sink 推送"。Scheduler 看到的是 `KVConnectorMetadata`，worker 看到的是真实的 NCCL/NIXL 句柄。

## 1.8 关键并发原语

V1 的"看似简单"背后有几条并发线，初读时容易忽略：

1. **EngineCoreProc 三线程**（同一进程内）  
   - **input 线程** (`process_input_sockets`, `core.py:1395`)：ZMQ 收 → `msgspec` 解码 → 推 `input_queue`。  
   - **output 线程** (`process_output_sockets`)：从 `output_queue` 取 → `msgspec` 编码 → ZMQ 发。  
   - **主线程** (`run_busy_loop`, `core.py:1187`)：消费 `input_queue`、调 `step()`、推 `output_queue`。  
   这种分离让 I/O 序列化与 GPU 执行并行（ZMQ 与 msgpack 都释放 GIL）。

2. **AsyncLLM 的两条 asyncio 流**  
   - **user task**：`async for out in llm.generate(...)`，在 `RequestOutputCollector.get()` 上 await。  
   - **output handler task** (`async_llm.py:637`)：持续从 ZMQ 取 `EngineCoreOutputs` → 调 `OutputProcessor.process_outputs` → `RequestOutputCollector.put(...)` 唤醒 user task。  
   每个请求的 collector 是一个 `asyncio.Event` 上的简单缓冲，支持 delta-mode 合并。

3. **MultiprocExecutor 的 FutureWrapper 串行链**  
   `non_block=True` 调用返回的 `Future` 不是直接挂在 thread pool 上的，而是通过 `futures_queue` 串成一条**严格 FIFO 链**（`multiproc_executor.py:69`）。这保证 EngineCore 即便积压多个 step 也能按发送顺序拿到结果，与 PP/async scheduling 配合时不会乱序。

4. **Worker 端 model forward 与 sample 拆分**  
   `execute_model` 可以返回 `None`，表示"forward 完了但还没采样"，让 EngineCore 在等待期间先计算 grammar bitmask。`sample_tokens` 用 `unique_reply_rank=output_rank` 只让 driver worker 回传结果（`multiproc_executor.py:318`），避免 N 个 worker 都发同一份 sampled tokens。

## 1.9 初始化时序详解

启动一个 V1 实例（在线模式）的关键时序：

<svg viewBox="0 0 760 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="V1 在线模式启动时序：21 步关键事件">
  <defs>
    <marker id="r16ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">V1 在线模式启动时序：从 from_vllm_config 到 Ready to serve</text>
  <text x="90" y="46" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">Frontend</text>
  <text x="350" y="46" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">EngineCore proc</text>
  <text x="600" y="46" text-anchor="middle" font-size="11" font-weight="700" fill="#075985">Worker proc(s)</text>
  <line x1="180" y1="50" x2="180" y2="550" stroke="#cbd5e1" stroke-dasharray="3,3"/>
  <line x1="520" y1="50" x2="520" y2="550" stroke="#cbd5e1" stroke-dasharray="3,3"/>
  <g transform="translate(20, 60)">
    <circle cx="14" cy="10" r="9" fill="#ea580c"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">0</text>
    <text x="30" y="14" font-size="11" fill="#9a3412">AsyncLLM.from_vllm_config()</text>
  </g>
  <g transform="translate(20, 84)">
    <circle cx="14" cy="10" r="9" fill="#fb923c"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">1</text>
    <text x="30" y="14" font-size="11" fill="#9a3412">AsyncLLM.__init__</text>
  </g>
  <g transform="translate(20, 108)">
    <circle cx="14" cy="10" r="9" fill="#fb923c"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">2</text>
    <text x="30" y="14" font-size="11" fill="#9a3412">build InputProcessor / OutputProcessor</text>
  </g>
  <g transform="translate(20, 132)">
    <circle cx="14" cy="10" r="9" fill="#fb923c"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">3</text>
    <text x="30" y="14" font-size="11" fill="#9a3412">EngineCoreClient.make_async_mp_client</text>
  </g>
  <path d="M 180 152 L 200 152" stroke="#ea580c" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(200, 144)">
    <circle cx="14" cy="10" r="9" fill="#0d9488"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">4</text>
    <text x="30" y="14" font-size="11" fill="#115e59">spawn EngineCore process</text>
  </g>
  <g transform="translate(200, 168)">
    <circle cx="14" cy="10" r="9" fill="#14b8a6"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">5</text>
    <text x="30" y="14" font-size="11" fill="#115e59">EngineCoreProc._perform_handshakes</text>
  </g>
  <g transform="translate(200, 192)">
    <circle cx="14" cy="10" r="9" fill="#14b8a6"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">6</text>
    <text x="30" y="14" font-size="11" fill="#115e59">HELLO ↔ READY + 地址交换</text>
  </g>
  <g transform="translate(200, 216)">
    <circle cx="14" cy="10" r="9" fill="#14b8a6"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">7</text>
    <text x="30" y="14" font-size="11" fill="#115e59">EngineCore.__init__</text>
  </g>
  <g transform="translate(200, 240)">
    <circle cx="14" cy="10" r="9" fill="#14b8a6"/>
    <text x="14" y="14" text-anchor="middle" font-size="10" font-weight="700" fill="white">8</text>
    <text x="30" y="14" font-size="11" fill="#115e59">Executor(MultiprocExecutor) 构造</text>
  </g>
  <path d="M 520 260 L 540 260" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(540, 252)">
    <circle cx="10" cy="10" r="9" fill="#0284c7"/>
    <text x="10" y="14" text-anchor="middle" font-size="9" font-weight="700" fill="white">9</text>
    <text x="22" y="14" font-size="10" fill="#075985">spawn N × WorkerProc</text>
  </g>
  <g transform="translate(540, 276)">
    <rect x="0" y="0" width="20" height="14" fill="#38bdf8" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">10</text>
    <text x="24" y="11" font-size="10" fill="#075985">Worker.init_device（NCCL / 分布式）</text>
  </g>
  <g transform="translate(540, 296)">
    <rect x="0" y="0" width="20" height="14" fill="#38bdf8" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">11</text>
    <text x="24" y="11" font-size="10" fill="#075985">Worker.load_model（权重入 HBM）</text>
  </g>
  <path d="M 540 326 L 520 326" stroke="#0284c7" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(200, 320)">
    <rect x="0" y="0" width="20" height="14" fill="#7c3aed" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">12</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">Executor.determine_available_memory</text>
  </g>
  <path d="M 520 342 L 540 342" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(540, 336)">
    <rect x="0" y="0" width="20" height="14" fill="#a78bfa" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">13</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">Worker._profile_run（探测峰值）</text>
  </g>
  <path d="M 540 360 L 520 360" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(200, 354)">
    <rect x="0" y="0" width="20" height="14" fill="#7c3aed" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">14</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">get_kv_cache_configs → 决定 num_blocks（可能 auto-fit max_model_len）</text>
  </g>
  <g transform="translate(200, 374)">
    <rect x="0" y="0" width="20" height="14" fill="#7c3aed" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">15</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">Executor.initialize_from_config</text>
  </g>
  <path d="M 520 390 L 540 390" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(540, 384)">
    <rect x="0" y="0" width="20" height="14" fill="#a78bfa" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">16</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">Worker.initialize_from_config</text>
  </g>
  <g transform="translate(540, 404)">
    <rect x="0" y="0" width="20" height="14" fill="#a78bfa" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">17</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">分配 KV tensor + 注册 block table</text>
  </g>
  <g transform="translate(540, 424)">
    <rect x="0" y="0" width="20" height="14" fill="#a78bfa" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">18</text>
    <text x="24" y="11" font-size="10" fill="#5b21b6">compile_or_warm_up_model（CUDA Graph capture）</text>
  </g>
  <path d="M 540 454 L 520 454" stroke="#0284c7" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(200, 448)">
    <rect x="0" y="0" width="20" height="14" fill="#14b8a6" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">19</text>
    <text x="24" y="11" font-size="10" fill="#115e59">start input / output threads（busy loop 就位）</text>
  </g>
  <path d="M 200 472 L 180 472" stroke="#0d9488" stroke-width="1.5" marker-end="url(#r16ar)" fill="none"/>
  <g transform="translate(20, 466)">
    <rect x="0" y="0" width="20" height="14" fill="#fb923c" rx="2"/>
    <text x="10" y="11" text-anchor="middle" font-size="9" font-weight="700" fill="white">20</text>
    <text x="24" y="11" font-size="10" fill="#9a3412">AsyncLLM start_output_handler task</text>
  </g>
  <rect x="20" y="492" width="720" height="22" fill="#dcfce7" stroke="#16a34a" rx="4"/>
  <text x="380" y="507" text-anchor="middle" font-size="12" font-weight="700" fill="#166534">Ready to serve</text>
  <g transform="translate(20, 524)">
    <text x="0" y="0" font-size="10" fill="currentColor"><tspan font-weight="700" fill="#475569">关键顺序：</tspan>13 必须在 11 之后（权重已占住显存才能测剩余）、14 之前（先有 profile 数才能定 num_blocks）；
      <tspan x="0" dy="14">14 可能反向修改 max_model_len，需通过 collective_rpc 重新告知 worker（这就是 worker 启动后才知 KV 配置的原因）；</tspan>
      <tspan x="0" dy="14">18 的 CUDA Graph 决定所有支持的 batch descriptor——运行时遇到没预热过的组合要 fallback 或 padding。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R1.6 ｜ V1 在线模式启动时序：21 步事件在三类进程间编排，深紫色 12–18 是 KV cache 协议的核心（profile → 决定 num_blocks → 分配 → CUDA Graph）</span>

<details>
<summary>ASCII 原版</summary>

```
t  Event                                                    File:Line
─  ─────────────────────────────────────────────────────── ────────────────────────────
0  AsyncLLM.from_vllm_config()                              async_llm.py:from_vllm_config
1    AsyncLLM.__init__                                      async_llm.py:73
2      InputProcessor / OutputProcessor 构建                async_llm.py:135-143
3      EngineCoreClient.make_async_mp_client               async_llm.py:146
4        spawn EngineCore process(es)                       core.py:run_engine_core
5          EngineCoreProc._perform_handshakes              core.py:944
6            HELLO -> READY 握手 + addresses 交换            core.py:1048
7          EngineCore.__init__                              core.py:91
8            Executor(MultiprocExecutor) 构造                multiproc_executor.py:109
9              spawn N 个 WorkerProc                        multiproc_executor.py:181
10               Worker.init_device (NCCL/分布式)           gpu_worker.py:239
11               Worker.load_model                          gpu_worker.py:338
12            Executor.determine_available_memory          executor/abstract.py:146
13              Worker._profile_run -> 测剩余显存          (in model_runner)
14            get_kv_cache_configs -> 决定 num_blocks       kv_cache_utils.py
15            Executor.initialize_from_config              executor/abstract.py:118
16              Worker.initialize_from_config              gpu_worker.py:539
17                分配 KV tensor + 注册 block table        gpu_model_runner.py:7065
18              compile_or_warm_up_model                   (CUDA Graph capture)
19          start input/output threads                      core.py:912-934
20      AsyncLLM start_output_handler task                  async_llm.py:174
─  Ready to serve.
```

</details>

为什么这个顺序值得记：
- 第 13 步必须发生在第 11 步之后、第 14 步之前。模型权重加载会吃掉一部分显存，profile 必须知道这点才能算出 KV cache 可用容量。
- 第 18 步是 CUDA Graph 预热，决定了**所有支持的 batch descriptor**（batch size + query len 组合）。运行时遇到没预热过的组合要么 fallback 到 eager 要么 padding。`CUDAGraphDispatcher` (`vllm/v1/cudagraph_dispatcher.py`) 负责挑桶。
- 第 14 步可能反向修改 `max_model_len`（"auto-fit"，`core.py:268`），需要通过 `collective_rpc("update_max_model_len")` 同步给已启动的 worker。这就是为什么 worker 启动顺序是"先 init device → 再被告知 KV 配置"。

## 1.10 错误传播与生命周期

| 失败位置 | 检测者 | 行为 |
| --- | --- | --- |
| Worker 进程 OOM / CUDA error | `worker_busy_loop` 捕获 Exception | 序列化为字符串写回 response_mq，executor 收到非 SUCCESS 状态 → 抛 `RuntimeError` |
| Worker 进程崩溃 | EngineCore 监控线程 (`monitor_workers`) | `executor_fail_callback` 触发 → input_queue 收到 `EXECUTOR_FAILED` → busy loop 抛异常 |
| EngineCore 整体崩溃 | 在 finally 中调 `_send_engine_dead`，向 output socket 发 `ENGINE_CORE_DEAD` 哨兵 (`core.py:832`) | Frontend `AsyncMPClient` 检测到哨兵 → 把 `EngineDeadError` 推给所有未完成的 `RequestOutputCollector` |
| 单 request grammar reject / NaN logits | Scheduler 在 `update_from_output` 标记 `FINISHED_ERROR` | 正常 `EngineCoreOutput` 流出，frontend 转 500 |
| Client 断开 (asyncio CancelledError) | `AsyncLLM.generate` 的 except 块 | 调 `abort(req_id, internal=True)`，scheduler 释放 KV blocks |
| Stop string 命中 | `OutputProcessor.process_outputs` 在 frontend 检测 | 累加到 `reqs_to_abort`，由 `EngineCoreClient.abort_requests_async` 发回 EngineCore |

值得注意：**stop string 检测在 frontend 不在 scheduler**。原因是 stop string 是字符串级别的，需要 detokenized text；scheduler 是无 tokenizer 的纯 token-id 层。这个反向 abort 链路是 V1 中常被忽略的细节。

## 1.11 推荐阅读顺序

按"由前端到底层"的顺序读，每一步都验证你对前一步抽象的理解。

1. **离线最小路径**  
   `vllm/entrypoints/llm.py:198`（`LLM.__init__`）→ `vllm/entrypoints/llm.py:1419`（`_run_engine`）→ `vllm/v1/engine/llm_engine.py:287`（`step`）。  
   目标：看懂"调一次 `step()` 实际上做了什么"。可以先把 `multiprocess_mode=False` 当成默认理解，对应 `InprocClient` (`core_client.py:274`)。

2. **EngineCore 与 Scheduler**  
   `vllm/v1/engine/core.py:91-310`（`EngineCore.__init__` 与 KV 初始化）→ `core.py:425`（`step`）→ `vllm/v1/core/sched/scheduler.py:329-700`（`schedule`）→ `scheduler.py:1283`（`update_from_output`）。  
   目标：理解"在没有 GPU 的情况下，scheduler 怎么单独决策"。`Request` (`vllm/v1/request.py:59`) 与 `SchedulerOutput` (`vllm/v1/core/sched/output.py:181`) 是核心数据结构。

3. **KV 管理**  
   `vllm/v1/core/kv_cache_manager.py:110`（`KVCacheManager`）→ `vllm/v1/core/block_pool.py:130`（`BlockPool`）→ `vllm/v1/core/kv_cache_utils.py`（块哈希）。  
   目标：理解 prefix caching 的 block hash 怎么算、命中怎么查、preempt 时怎么回收。

4. **Executor + Worker**  
   `vllm/v1/executor/abstract.py:37`（`Executor`）→ `vllm/v1/executor/uniproc_executor.py`（先看单进程版本，最简）→ `vllm/v1/executor/multiproc_executor.py:102`（`MultiprocExecutor`）→ `multiproc_executor.py:944`（`worker_busy_loop`）。  
   目标：理解 `collective_rpc` 是怎么把一次 Python 方法调用变成 SHM 消息 + 多 worker 执行 + 聚合返回的。

5. **ModelRunner**  
   `vllm/v1/worker/gpu_worker.py:106`（`Worker`）→ `gpu_worker.py:239`（`init_device`）→ `gpu_worker.py:783`（`execute_model`）→ `vllm/v1/worker/gpu_input_batch.py:91`（`InputBatch`）→ `vllm/v1/worker/gpu_model_runner.py:3913`（`execute_model`）。  
   目标：理解持久 `InputBatch` 如何增量更新，以及一次 forward 的输入张量是怎么从 `SchedulerOutput` 转出来的。`gpu_model_runner.py` 很长，先只看 `execute_model` + `_prepare_inputs` 两个方法。

6. **Attention + Sampler**  
   `vllm/v1/attention/backend.py` + `vllm/v1/attention/selector.py` → 选一个具体后端如 `backends/flash_attn.py` → `vllm/v1/sample/sampler.py:21` 与 `sample/metadata.py`。  
   目标：理解 attention metadata 是怎么从 KV block table + seqlen 数组构造的，以及 sampler 在哪些张量上做 top-p/top-k。

7. **回到在线模式**  
   `vllm/v1/engine/async_llm.py:524`（`generate`）→ `async_llm.py:637`（`_run_output_handler`）→ `vllm/entrypoints/openai/api_server.py:109`（HTTP 装配）。  
   目标：理解 async generator + `RequestOutputCollector` 的流式协议，以及 OpenAI 兼容层在哪一层做 chat template / tool call 解析。

8. **分布式与高级特性（按需）**  
   - 数据并行：`vllm/v1/engine/coordinator.py` + `core.py` 里的 `DPEngineCoreProc`  
   - Speculative decoding：`vllm/v1/spec_decode/`  
   - 结构化输出：`vllm/v1/structured_output/`  
   - KV 连接器：`vllm/distributed/kv_transfer/kv_connector/v1/`

读完上述 7 步，应该能在 1000 行代码内复刻一个最小可运行的 vLLM-V1 风格推理引擎（单 GPU、无 prefix cache、无 spec decode、无 LoRA）。后续章节会按上述顺序展开每个组件。
