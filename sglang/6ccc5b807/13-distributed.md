# 第 13 章 分布式与并行执行

## 本章导读

前面的章节默认单卡。但真实部署里,大模型放不进一张卡,或者要靠多卡冲吞吐。这就需要**并行**。

并行有好几种,切的东西各不相同。本章讲清 SGLang 的四种并行(TP/PP/DP/EP)、它们怎么协作,以及一个进阶部署形态——PD 分离。代码主要在 `python/sglang/srt/distributed/` 和 `python/sglang/srt/disaggregation/`。

## 1. 四种并行,切什么

| 并行 | 全称 | 切什么 | 解决什么 |
|------|------|--------|----------|
| **TP** | Tensor Parallelism(张量并行) | 把每一层的权重矩阵**横/竖切**到多卡 | 单卡放不下模型 |
| **PP** | Pipeline Parallelism(流水线并行) | 把模型**按层段**切到多卡 | 单卡放不下模型 |
| **DP** | Data Parallelism(数据并行) | 每卡一份**完整模型**,分摊不同请求 | 冲吞吐 |
| **EP** | Expert Parallelism(专家并行) | 把 MoE 的**专家**切到多卡 | MoE 模型的专家放不下 |

直观区别:

<svg viewBox="0 0 600 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Four kinds of parallelism: TP, PP, DP, EP">
<rect x="20" y="20" width="270" height="130" rx="8" fill="none" stroke="#ea580c" stroke-width="1.4"/>
<text x="36" y="42" font-size="12" font-weight="700" fill="#ea580c">TP　张量并行</text>
<rect x="36" y="54" width="110" height="34" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="91" y="76" text-anchor="middle" font-size="10" fill="currentColor">卡0：W_a</text>
<rect x="156" y="54" width="110" height="34" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="211" y="76" text-anchor="middle" font-size="10" fill="currentColor">卡1：W_b</text>
<text x="36" y="110" font-size="10" fill="#64748b">一层权重横切到多卡，</text>
<text x="36" y="126" font-size="10" fill="#64748b">all-reduce 合并结果。拆模型。</text>
<rect x="310" y="20" width="270" height="130" rx="8" fill="none" stroke="#0d9488" stroke-width="1.4"/>
<text x="326" y="42" font-size="12" font-weight="700" fill="#0d9488">PP　流水线并行</text>
<rect x="326" y="54" width="110" height="34" rx="4" fill="#99f6e4" stroke="#0d9488"/><text x="381" y="76" text-anchor="middle" font-size="10" fill="currentColor">卡0：层 1–16</text>
<rect x="446" y="54" width="110" height="34" rx="4" fill="#99f6e4" stroke="#0d9488"/><text x="501" y="76" text-anchor="middle" font-size="10" fill="currentColor">卡1：层 17–32</text>
<text x="326" y="110" font-size="10" fill="#64748b">模型按层段切到多卡，</text>
<text x="326" y="126" font-size="10" fill="#64748b">像流水线接力。拆模型。</text>
<rect x="20" y="170" width="270" height="130" rx="8" fill="none" stroke="#0ea5e9" stroke-width="1.4"/>
<text x="36" y="192" font-size="12" font-weight="700" fill="#0ea5e9">DP　数据并行</text>
<rect x="36" y="204" width="110" height="34" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/><text x="91" y="226" text-anchor="middle" font-size="10" fill="currentColor">卡0：整模型 → A</text>
<rect x="156" y="204" width="110" height="34" rx="4" fill="#e0f2fe" stroke="#0ea5e9"/><text x="211" y="226" text-anchor="middle" font-size="10" fill="currentColor">卡1：整模型 → B</text>
<text x="36" y="260" font-size="10" fill="#64748b">每卡一份完整模型，</text>
<text x="36" y="276" font-size="10" fill="#64748b">分摊请求。复制模型，冲吞吐。</text>
<rect x="310" y="170" width="270" height="130" rx="8" fill="none" stroke="#7c3aed" stroke-width="1.4"/>
<text x="326" y="192" font-size="12" font-weight="700" fill="#7c3aed">EP　专家并行</text>
<rect x="326" y="204" width="110" height="34" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="381" y="226" text-anchor="middle" font-size="10" fill="currentColor">卡0：专家 0–127</text>
<rect x="446" y="204" width="110" height="34" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="501" y="226" text-anchor="middle" font-size="10" fill="currentColor">卡1：专家 128–255</text>
<text x="326" y="260" font-size="10" fill="#64748b">MoE 专家分散到多卡，</text>
<text x="326" y="276" font-size="10" fill="#64748b">token all-to-all 路由。专属 MoE。</text>
</svg>
<span class="figure-caption">图 R13.1 ｜ 四种并行：TP/PP 拆模型，DP 复制模型冲吞吐，EP 切 MoE 专家</span>

<details>
<summary>ASCII 原版</summary>

```text
  TP: 一层权重 W = [W_a | W_b]，卡0 算 W_a，卡1 算 W_b，结果拼起来
  PP: 卡0 跑第 1-16 层，卡1 跑第 17-32 层，像流水线接力
  DP: 卡0、卡1 各有整个模型，卡0 服务请求 A，卡1 服务请求 B
  EP: MoE 有 256 个专家，卡0 放 0-127 号，卡1 放 128-255 号
```

</details>

- **TP / PP 是「拆模型」**:模型太大、一张卡装不下时用。代价是卡间要通信。
- **DP 是「复制模型」**:模型装得下、但想用更多卡提吞吐时用。卡之间基本独立。
- **EP 专属 MoE**:MoE 模型的专家参数量极大,单独切。

这几种可以**组合**:比如「TP=4 + DP=2」共用 8 张卡——4 卡一组做张量并行装下模型,两组之间数据并行分摊请求。

## 2. 并行进程组:`parallel_state`

多卡协作的基础设施是**进程组**——「哪些 GPU 进程属于同一个 TP 组 / DP 组」。SGLang 用 `python/sglang/srt/distributed/parallel_state.py` 管理。

`init_distributed_environment`(`parallel_state.py:1668`)初始化整个分布式环境(底层 NCCL 等),`initialize_model_parallel`(`parallel_state.py:1755`)按 `tensor_model_parallel_size`、`pipeline_model_parallel_size` 等参数把所有 GPU 划分成各种并行组。约束 `parallel_state.py:1816`:

```python
if world_size != tensor_model_parallel_size * pipeline_model_parallel_size:
    raise ...   # 总卡数必须等于 TP × PP
```

划分完,代码通过一组 getter 拿到自己所属的组:

- `get_tp_group()`(`parallel_state.py:1478`)/ `get_tensor_model_parallel_group`(`:1523`):张量并行组;
- `get_pp_group()`(`:1528`):流水线并行组;
- `get_attn_tp_group()`(`:1488`):注意力的 TP 组(注意力的 TP 切法可能和 MLP 不同);
- `get_moe_ep_group()`(`:1512`)/ `get_moe_tp_group()`(`:1517`)/ `get_moe_dp_group()`(`:1507`):MoE 的各种组。

注意力、MLP、MoE 各有独立的组 getter——因为它们的最优切分方式不一样,SGLang 允许它们用不同的并行配置。

## 3. TP 怎么工作:切矩阵 + all-reduce

张量并行把一层的权重矩阵切到多卡。以一个线性层 `Y = X·W` 为例:

- 把 `W` 按列切成 `[W_a | W_b]`,卡0 持 `W_a`、卡1 持 `W_b`;
- 卡0 算 `X·W_a`、卡1 算 `X·W_b`,各得一半结果;
- 下一层若需要完整的 `Y`,就要把两半**通信合并**——这就是 **all-reduce / all-gather**。

所以 TP 的代价是:每层(或每隔几个算子)要做一次卡间通信。通信走 NCCL,SGLang 在 `distributed/communication_op.py`、`distributed/device_communicators/` 里封装通信原语;`sgl-kernel/csrc/allreduce/` 还有自定义的高性能 all-reduce。

TP 的权重加载也特殊:每张卡只加载**自己那一份**切片,`ModelRunner` 的模型加载会按 TP rank 取对应切片(见 [第 09 章](09-model-runner.md))。`apply_torch_tp`(`model_runner.py:2945`)是相关入口。

因为通信开销,TP 一般只在**单机多卡**(卡间有 NVLink 高速互联)用。跨机器做 TP,通信会成为瓶颈。

## 4. DP 与数据并行控制器

数据并行下,每个 DP rank 是一个**完整、独立**的引擎实例。难点不在计算(各算各的),在**协调**:

- 请求来了,该发给哪个 DP rank?要负载均衡;
- 各 rank 的运行状态要汇总(给 `/v1/loads` 这类接口报负载)。

这件事由**数据并行控制器** `python/sglang/srt/managers/data_parallel_controller.py` 负责。它在请求入口和各 DP rank 之间做调度分发——把请求路由到当前最空的 rank。`Engine` 的 `routed_dp_rank` 参数(见 [第 04 章](04-engine-and-processes.md) 的 `engine.py:278` 的 `_resolve_routed_dp_rank`)允许调用方指定请求走哪个 DP rank。

**DP attention** 是一个进阶点:纯 DP 下每个 rank 的 KV cache 互相独立,前缀缓存无法跨 rank 共享。DP attention 让注意力部分共享,需要 rank 间同步 batch——`Scheduler.maybe_prepare_mlp_sync_batch`(见 [第 08 章](08-scheduler.md))就是处理这种同步的。

## 5. EP:MoE 的专家并行

MoE(Mixture of Experts)模型每层有很多个「专家」(小 FFN),每个 token 只激活其中几个。专家总参数量极大——DeepSeek-V3 有 256 个专家。

专家并行把专家分散到多卡:卡0 放一部分专家、卡1 放另一部分。一个 token 要用的专家可能在别的卡上,于是需要 **all-to-all** 通信:把 token 路由(发送)到持有其目标专家的卡,算完再收回来。

EP 的进程组由 `get_moe_ep_group` 等管理,MoE 的计算/路由 kernel 在 `sgl-kernel/csrc/moe/`。MoE 通常 EP 和 TP 组合使用。SGLang 还支持弹性专家备份(`enable_elastic_expert_backup`,见 [第 04 章](04-engine-and-processes.md) 的 `engine.py:801`)。

## 6. PD 分离:prefill 和 decode 拆开

这是一个和上面四种并行不同维度的部署形态——**PD 分离**(Prefill/Decode Disaggregation)。代码在 `python/sglang/srt/disaggregation/`。

动机:prefill 和 decode 的资源特征截然相反(见 [第 08 章](08-scheduler.md)、[导览步骤 14/17](tour-00-overview.md)):

- **prefill** 算力瓶颈:一次并行算几百上千 token,吃算力;
- **decode** 显存带宽瓶颈:一次 1 token,吃带宽。

把它们混在同一批/同一组卡上跑,会互相干扰——一个大 prefill 会卡住所有 decode 请求,推高 inter-token 延迟。

PD 分离的解法:**用两组独立的 worker**,一组专做 prefill(`disaggregation/prefill.py`)、一组专做 decode(`disaggregation/decode.py`)。请求先在 prefill worker 上算完 prompt 的 KV,再把 **KV cache 传输**给 decode worker 继续生成。

<svg viewBox="0 0 640 180" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Prefill/Decode disaggregation: separate worker clusters">
<defs>
<marker id="r13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="20" y="62" width="90" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="65" y="91" text-anchor="middle" font-size="11" fill="currentColor">请求</text>
<line x1="110" y1="87" x2="146" y2="87" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r13ar)"/>
<rect x="148" y="48" width="180" height="78" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="238" y="74" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Prefill Worker</text>
<text x="238" y="94" text-anchor="middle" font-size="10" fill="#64748b">算 prompt KV</text>
<text x="238" y="111" text-anchor="middle" font-size="10" fill="#ea580c">算力优化</text>
<line x1="328" y1="87" x2="392" y2="87" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r13ar)"/>
<text x="360" y="78" text-anchor="middle" font-size="9" fill="#94a3b8">KV cache</text>
<text x="360" y="106" text-anchor="middle" font-size="9" fill="#94a3b8">网络传输</text>
<rect x="394" y="48" width="180" height="78" rx="10" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
<text x="484" y="74" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Decode Worker</text>
<text x="484" y="94" text-anchor="middle" font-size="10" fill="#64748b">逐 token 生成</text>
<text x="484" y="111" text-anchor="middle" font-size="10" fill="#0d9488">带宽优化</text>
<line x1="574" y1="87" x2="610" y2="87" stroke="#94a3b8" stroke-width="1.3" marker-end="url(#r13ar)"/>
<text x="620" y="91" text-anchor="end" font-size="11" fill="currentColor">输出</text>
<text x="320" y="158" text-anchor="middle" font-size="10" fill="#94a3b8">两组 worker 各按算力/带宽特征独立优化、独立扩缩容</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ PD 分离：prefill 与 decode 拆到独立 worker 集群，中间传输 KV cache</span>

<details>
<summary>ASCII 原版</summary>

```text
   请求 ──► Prefill Worker ──(KV cache 传输)──► Decode Worker ──► 输出
            算 prompt KV                        逐 token 生成
            (算力优化)                          (带宽优化)
```

</details>

关键挑战是 **KV 传输**——prefill 算出的 KV 要高效地搬到 decode worker。SGLang 支持多种传输后端:`disaggregation/mooncake/`、`disaggregation/nixl/`、`disaggregation/mori/`。`kv_events.py` 管理传输事件。

PD 分离的好处:prefill 集群和 decode 集群可以**各自独立扩缩容、各自优化**——prefill 多给算力卡、decode 多给大显存卡。代价是多一道 KV 网络传输。它适合**大规模在线 serving**。`Engine` 的 `disaggregation_mode`、`bootstrap_*` 参数(见 [第 05 章](05-request-data-structures.md) 的 `Req` 字段)就是为此服务的。

## 7. 多节点部署

跨机器部署时,每台机器是一个 node,有 `node_rank`。回顾 [导览步骤 02](tour-02-launch-processes.md):`node_rank >= 1` 的非零号节点**只起 Scheduler**,不起 tokenizer / detokenizer(`engine.py:807-833`)——它们只参与并行计算,不接外部请求。零号节点负责对外。所有节点通过 `init_distributed_environment` 加入同一个分布式环境。

## 相关章节

- [第 04 章 Engine 入口与多进程编排](04-engine-and-processes.md) —— 多节点进程拓扑、`routed_dp_rank`
- [第 08 章 调度器与连续批处理](08-scheduler.md) —— DP attention 的 batch 同步
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— TP 下的权重切分加载
- [第 14 章 高级特性与模型网关](14-advanced-features.md) —— MoE 模型、Rust 模型网关
- [导览步骤 02](tour-02-launch-processes.md) —— 多节点进程启动
