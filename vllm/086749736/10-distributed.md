# 第 10 章 分布式与并行执行

本章描述 vLLM V1 在多 GPU、多节点上拆分模型与请求的方式。重点在于：

- 四种相互正交的并行轴 TP / PP / DP / EP 如何在同一进程拓扑中共存；
- 每个轴对应的进程组（`GroupCoordinator`）如何创建以及在前向中发出哪些集合通信；
- driver / worker 进程模型与三种 `Executor` 后端如何与之对应；
- KV cache 在并行下的切分，以及多节点（Ray / `torchrun`）启动路径。

阅读本章前应已了解 vLLM 的执行循环（第 5 章）、调度器（第 6 章）与 GPU model runner（第 7 章）；本章不会重复这些内容，只描述并行轴在它们之上引入的差异。

---

## 10.1 总览

### 10.1.1 `vllm/distributed/` 目录组织

```
vllm/distributed/
├── parallel_state.py            # TP/PP/DP/EP/DCP/PCP 进程组的创建与全局访问
├── communication_op.py          # tensor_model_parallel_{all_reduce,all_gather,...}
├── utils.py                     # StatelessProcessGroup, get_pp_indices, TCPStore
├── stateless_coordinator.py     # 弹性 EP 用的 GroupCoordinator 变体
├── device_communicators/        # 平台特定通信后端
│   ├── base_device_communicator.py
│   ├── cuda_communicator.py     # NCCL/CustomAR/FlashInferAR/SymmMem 派发
│   ├── pynccl.py                # ctypes 封装 NCCL
│   ├── custom_all_reduce.py     # 小消息一次 IPC 的 AR 内核
│   ├── quick_all_reduce.py      # ROCm 上对应的 AR
│   ├── flashinfer_all_reduce.py
│   ├── symm_mem.py              # 基于 torch 对称内存
│   ├── all2all.py               # DeepEP、NixlEP、FlashInferNVLink 等 MoE all2all
│   ├── shm_broadcast.py         # 共享内存广播 SchedulerOutput
│   └── ray_communicator.py      # Ray Compiled DAG 上的 NCCL 通道
├── eplb/                        # 专家负载均衡（EPLB）相关组件
├── kv_transfer/                 # PD 解耦的 KV 连接器（见第 11 章）
├── ec_transfer/                 # encoder cache 转移（多模态 EPD 解耦）
└── elastic_ep/                  # 在线 scale up/down EP 引擎组
```

`parallel_state.py` 是对 Megatron-LM `parallel_state.py` 的改写
（`vllm/distributed/parallel_state.py:5`），负责创建并持有全部模型并行组的句柄；其他文件
都依赖它返回的 `GroupCoordinator`。

### 10.1.2 四个并行轴的关系

vLLM 维护一个 5 维进程网格，在 `initialize_model_parallel` 中将全局 rank reshape 成

```
ExternalDP x DP x PP x PCP x TP
```

见 `vllm/distributed/parallel_state.py:1569`。每个轴的语义：

| 轴 | 切的是什么 | 一个 forward 期间的通信 | 触发条件 |
| --- | --- | --- | --- |
| **TP** tensor parallel | 单层权重切分（列/行） | 每个 Transformer block 至少 2 次 all-reduce | `--tensor-parallel-size > 1` |
| **PP** pipeline parallel | 把层分到不同 stage | 相邻 stage 间一次 send/recv | `--pipeline-parallel-size > 1` |
| **DP** data parallel | 完全复制模型，请求独立 | 仅 DP 元数据同步（barrier、padding） | `--data-parallel-size > 1` |
| **EP** expert parallel | MoE 中的专家分到不同 GPU | 每个 MoE 层一次 all2all dispatch + combine | `--enable-expert-parallel` |
| **DCP/PCP** context parallel | 序列维度切 KV cache | 与 attention backend 配合 | `--decode-context-parallel-size` / `--prefill-context-parallel-size` |
| **ExternalDP** | 外部框架（如 verl）按 DP 复制引擎 | 无 | RLHF 等外部场景 |

设计逻辑：四个轴通过 reshape 5D tensor 后沿不同维度 unbind 来生成；正交意味着它们的
`group_ranks` 列表互不重叠（同一全局 rank 同时只属于每个轴的一个 group）。所有轴
共享同一个 PyTorch `init_process_group`，但每个轴拥有独立的 NCCL communicator。

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="8 GPU 的 TP=2 PP=2 DP=2 进程网格分组">
  <defs>
    <marker id="ar10a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">8 GPU 拓扑：TP=2, PP=2, DP=2（同一 rank 同时属于 TP、PP、DP 各一个组）</text>
  <g transform="translate(40, 50)">
    <text x="0" y="0" font-size="12" font-weight="600" fill="currentColor">全局 rank 网格</text>
    <text x="0" y="14" font-size="10" fill="#94a3b8">reshape 成 [dp=2, pp=2, tp=2]</text>
    <g transform="translate(0, 28)">
      <rect x="0" y="0" width="140" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
      <text x="70" y="15" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">DP=0</text>
      <rect x="160" y="0" width="140" height="22" fill="#f1f5f9" stroke="#cbd5e1"/>
      <text x="230" y="15" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">DP=1</text>
    </g>
    <g transform="translate(0, 56)">
      <text x="-32" y="18" font-size="10" fill="#64748b">PP=0</text>
      <rect x="0" y="0" width="65" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
      <text x="32" y="14" text-anchor="middle" font-size="10" fill="#9a3412">tp=0</text>
      <text x="32" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#9a3412">0</text>
      <rect x="70" y="0" width="65" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
      <text x="102" y="14" text-anchor="middle" font-size="10" fill="#9a3412">tp=1</text>
      <text x="102" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#9a3412">1</text>
      <rect x="160" y="0" width="65" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
      <text x="192" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#9a3412">4</text>
      <rect x="230" y="0" width="65" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
      <text x="262" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#9a3412">5</text>
    </g>
    <g transform="translate(0, 96)">
      <text x="-32" y="18" font-size="10" fill="#64748b">PP=1</text>
      <rect x="0" y="0" width="65" height="32" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
      <text x="32" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#115e59">2</text>
      <rect x="70" y="0" width="65" height="32" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
      <text x="102" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#115e59">3</text>
      <rect x="160" y="0" width="65" height="32" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
      <text x="192" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#115e59">6</text>
      <rect x="230" y="0" width="65" height="32" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
      <text x="262" y="26" text-anchor="middle" font-size="14" font-weight="700" fill="#115e59">7</text>
    </g>
  </g>
  <g transform="translate(400, 50)">
    <text x="0" y="0" font-size="12" font-weight="600" fill="currentColor">各轴的 group_ranks</text>
    <text x="0" y="14" font-size="10" fill="#94a3b8">同一 rank 同时出现在每轴的一个 group</text>
    <g transform="translate(0, 28)">
      <rect x="0" y="0" width="18" height="14" fill="#ea580c"/>
      <text x="26" y="11" font-size="11" font-weight="600" fill="currentColor">TP 组（size 2）：相邻 rank 同 PP/DP</text>
      <text x="0" y="32" font-size="11" fill="#64748b">[0,1]  [2,3]  [4,5]  [6,7]</text>
    </g>
    <g transform="translate(0, 80)">
      <rect x="0" y="0" width="18" height="14" fill="#0d9488"/>
      <text x="26" y="11" font-size="11" font-weight="600" fill="currentColor">PP 组（size 2）：跨 stage 同 DP/TP</text>
      <text x="0" y="32" font-size="11" fill="#64748b">[0,2]  [1,3]  [4,6]  [5,7]</text>
    </g>
    <g transform="translate(0, 132)">
      <rect x="0" y="0" width="18" height="14" fill="#7c3aed"/>
      <text x="26" y="11" font-size="11" font-weight="600" fill="currentColor">DP 组（size 2）：跨副本同 PP/TP</text>
      <text x="0" y="32" font-size="11" fill="#64748b">[0,4]  [1,5]  [2,6]  [3,7]</text>
    </g>
    <g transform="translate(0, 184)">
      <rect x="0" y="0" width="18" height="14" fill="#0ea5e9"/>
      <text x="26" y="11" font-size="11" font-weight="600" fill="currentColor">EP 组（size DP*PCP*TP=4，启用时）</text>
      <text x="0" y="32" font-size="11" fill="#64748b">[0,1,4,5]  [2,3,6,7]</text>
    </g>
  </g>
  <g transform="translate(40, 240)">
    <rect x="0" y="0" width="680" height="100" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
    <text x="12" y="18" font-size="11" font-weight="700" fill="currentColor">通信开销（每 forward）</text>
    <text x="12" y="36" font-size="10" fill="#64748b">TP：每个 transformer block 2 次 all-reduce — 带宽敏感 → 限 NVLink 内（≤ 8）</text>
    <text x="12" y="52" font-size="10" fill="#64748b">PP：相邻 stage 一次 send/recv — 带宽友好 → 跨节点首选</text>
    <text x="12" y="68" font-size="10" fill="#64748b">DP：只在 step 边界同步元数据（barrier、padding） — 跨 DC 可行</text>
    <text x="12" y="84" font-size="10" fill="#64748b">EP（MoE）：每 MoE 层一次 all2all dispatch + combine — 取决于网络（NVLink/IB）</text>
  </g>
</svg>
<span class="figure-caption">图 R10.1 ｜ 8 GPU 上 TP=2/PP=2/DP=2 的拓扑：global rank 被 reshape 成 5D 网格后沿不同维度 unbind 出各轴的 group_ranks，每个 rank 同时属于 TP/PP/DP 各一个组</span>

<details>
<summary>ASCII 原版</summary>

```
8 张 GPU，TP=2, PP=2, DP=2 的进程网格（ExternalDP=1, PCP=1）：

  reshape 后  all_ranks[dp, pp, tp]      实际全局 rank
  ─────────  ────────────────────────   ─────────────
            dp=0 pp=0 tp=0..1            0, 1
            dp=0 pp=1 tp=0..1            2, 3
            dp=1 pp=0 tp=0..1            4, 5
            dp=1 pp=1 tp=0..1            6, 7

  TP groups (size 2):  [0,1] [2,3] [4,5] [6,7]
  PP groups (size 2):  [0,2] [1,3] [4,6] [5,7]
  DP groups (size 2):  [0,4] [1,5] [2,6] [3,7]
```

</details>

构造代码片段位于 `vllm/distributed/parallel_state.py:1569-1668`：

```python
all_ranks = torch.arange(world_size).reshape(
    -1, data_parallel_size, pipeline_model_parallel_size,
    prefill_context_model_parallel_size, tensor_model_parallel_size,
)
# TP: 最后一维 unbind
group_ranks = all_ranks.view(-1, tensor_model_parallel_size).unbind(0)
# PP: transpose 后 unbind
group_ranks = all_ranks.transpose(2, 4).reshape(-1, pp_size).unbind(0)
# DP
group_ranks = all_ranks.transpose(1, 4).reshape(-1, dp_size).unbind(0)
# EP: DP * PCP * TP 平铺成一个大组（专家分布在其上）
group_ranks = all_ranks.transpose(1, 2).reshape(-1, dp*pcp*tp).unbind(0)
```

注意 EP 组的大小等于 `DP * PCP * TP`：当 `--enable-expert-parallel`
时，TP 与 DP 上的所有进程合在一起组成 EP 组（每个进程持有自己的专家子集），见
`vllm/distributed/parallel_state.py:1670-1696`。

---

## 10.2 GroupCoordinator 抽象

### 10.2.1 数据结构

`GroupCoordinator` (`vllm/distributed/parallel_state.py:290`) 是对一个 PyTorch
`ProcessGroup` 的封装，每个并行轴持有一个：

```python
# vllm/distributed/parallel_state.py:301-317
rank: int                          # global rank
ranks: list[int]                   # 该组内的全局 rank
world_size: int                    # 该组大小
local_rank: int                    # 对应本地设备索引
rank_in_group: int                 # 在组内的 0-based 编号
cpu_group: ProcessGroup            # gloo backend，控制信息
device_group: ProcessGroup         # nccl backend，数据
device_communicator: DeviceCommunicatorBase | None  # CustomAR / pynccl 等
mq_broadcaster: MessageQueue | None  # 共享内存广播器
```

每个 GroupCoordinator 同时持有 device group（NCCL）和 CPU group（gloo），
原因：广播 Python 对象、`broadcast_tensor_dict` 的 metadata、`send_object` 都走
CPU 路径以避免 GPU 拷贝，避免每次集合通信都做 host-device 同步。

### 10.2.2 全局句柄

```python
# vllm/distributed/parallel_state.py:1226-1290
_WORLD: GroupCoordinator | None = None     # 全部 ranks
_TP:   GroupCoordinator | None = None      # TP
_PP:   GroupCoordinator | None = None      # PP
_DP:   GroupCoordinator | None = None      # DP（DPEngineCoreProc 之间）
_EP:   GroupCoordinator | None = None      # EP
_DCP:  GroupCoordinator | None = None      # decode context parallel
_PCP:  GroupCoordinator | None = None      # prefill context parallel
_EPLB: GroupCoordinator | None = None      # 与 EP 同 rank，专用于 EPLB

def get_tp_group() -> GroupCoordinator: ...  # :1229
def get_pp_group() -> GroupCoordinator: ...  # :1248
def get_dp_group() -> GroupCoordinator: ...  # :1256
def get_ep_group() -> GroupCoordinator: ...  # :1264
```

层代码不会直接持有 `ProcessGroup`，而是通过这些 getter；这让单元测试可以临时
`patch_tensor_parallel_group()` 替换 TP 组（如推测解码的草稿模型可能有不同 TP 度数，
见 `vllm/distributed/parallel_state.py:1812`）。

### 10.2.3 Custom op 包装

集合通信被注册为 PyTorch custom op，便于 `torch.compile` / Inductor 看到：

```python
# vllm/distributed/parallel_state.py:130-139, 262-279
def all_reduce(tensor, group_name):
    group = _groups[group_name]()
    return group._all_reduce_out_place(tensor)

direct_register_custom_op(op_name="all_reduce", op_func=all_reduce,
                          fake_impl=all_reduce_fake)
```

注释 (:507-516) 解释为什么需要这层包装：Dynamo 不支持把任意 Python 对象传给 custom
op，所以 vLLM 用 `unique_name` 作为字符串句柄，在 op 内部反查 `GroupCoordinator`。
另一原因是 PyTorch custom op 不允许 mutate 输入，所以 all-reduce 强制 out-of-place。

层调用 `tensor_model_parallel_all_reduce(x)`（`vllm/distributed/communication_op.py:12`），
当 `use_custom_op_call=True` 时进入 `torch.ops.vllm.all_reduce`，否则直接调用
device communicator，逻辑见 `vllm/distributed/parallel_state.py:502-529`。

---

## 10.3 Tensor Parallelism (TP)

### 10.3.1 原理：列并行 + 行并行 的 GEMM 切分

把一个 transformer block 的 MLP 部分 `Y = GeLU(X · A) · B + b` 切成两段：

<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Megatron 风格列并行 + 行并行的 GEMM 切分">
  <defs>
    <marker id="ar10b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Y = GeLU(X·A)·B：列并行 + 行并行 → 仅一次 all-reduce</text>
  <text x="160" y="50" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">ColumnParallel A</text>
  <text x="160" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">输入完整 X，输出按 dim 切片，无通信</text>
  <text x="600" y="50" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">RowParallel B</text>
  <text x="600" y="64" text-anchor="middle" font-size="10" fill="#94a3b8">输入是分片，输出仅局部和，需 all-reduce</text>
  <g transform="translate(40, 90)">
    <rect x="0" y="0" width="44" height="160" fill="#f1f5f9" stroke="#cbd5e1"/>
    <text x="22" y="86" text-anchor="middle" font-size="11" fill="#64748b">X</text>
    <text x="22" y="100" text-anchor="middle" font-size="9" fill="#94a3b8">(完整)</text>
    <path d="M 44 36 L 88 36" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <path d="M 44 86 L 88 86" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <path d="M 44 136 L 88 136" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <rect x="88" y="20" width="56" height="36" fill="#fed7aa" stroke="#ea580c"/>
    <text x="116" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">A_0</text>
    <rect x="88" y="70" width="56" height="36" fill="#fed7aa" stroke="#ea580c"/>
    <text x="116" y="92" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">A_1</text>
    <rect x="88" y="120" width="56" height="36" fill="#fed7aa" stroke="#ea580c"/>
    <text x="116" y="142" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">A_2</text>
    <path d="M 144 36 L 192 36" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <path d="M 144 86 L 192 86" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <path d="M 144 136 L 192 136" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10b)"/>
    <text x="168" y="24" text-anchor="middle" font-size="9" fill="#64748b">Y_0</text>
    <text x="168" y="74" text-anchor="middle" font-size="9" fill="#64748b">Y_1</text>
    <text x="168" y="124" text-anchor="middle" font-size="9" fill="#64748b">Y_2</text>
    <rect x="192" y="20" width="56" height="36" fill="#99f6e4" stroke="#0d9488"/>
    <text x="220" y="42" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">B_0</text>
    <rect x="192" y="70" width="56" height="36" fill="#99f6e4" stroke="#0d9488"/>
    <text x="220" y="92" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">B_1</text>
    <rect x="192" y="120" width="56" height="36" fill="#99f6e4" stroke="#0d9488"/>
    <text x="220" y="142" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">B_2</text>
    <path d="M 248 36 L 312 36 L 312 80" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
    <path d="M 248 86 L 312 86" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
    <path d="M 248 136 L 312 136 L 312 92" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
    <text x="280" y="24" text-anchor="middle" font-size="9" fill="#64748b">Z_0(局部和)</text>
    <text x="280" y="74" text-anchor="middle" font-size="9" fill="#64748b">Z_1(局部和)</text>
    <text x="280" y="124" text-anchor="middle" font-size="9" fill="#64748b">Z_2(局部和)</text>
    <rect x="312" y="68" width="120" height="40" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
    <text x="372" y="86" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">all_reduce</text>
    <text x="372" y="100" text-anchor="middle" font-size="9" fill="#6d28d9">2 次/层（attention + MLP）</text>
    <path d="M 432 88 L 472 88" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10b)"/>
    <rect x="472" y="68" width="56" height="40" fill="#fef3c7" stroke="#facc15"/>
    <text x="500" y="92" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">Z</text>
    <text x="500" y="124" text-anchor="middle" font-size="9" fill="#94a3b8">完整 hidden</text>
  </g>
  <g transform="translate(40, 270)">
    <text x="0" y="0" font-size="10" font-weight="600" fill="#64748b">rank 0</text>
    <text x="0" y="14" font-size="10" font-weight="600" fill="#64748b">rank 1</text>
    <text x="0" y="28" font-size="10" font-weight="600" fill="#64748b">rank 2</text>
    <text x="555" y="14" font-size="10" fill="#94a3b8">激活只在 block 边界做一次集合通信，避免逐 GEMM 通信</text>
  </g>
</svg>
<span class="figure-caption">图 R10.2 ｜ Megatron 风格 TP 切分：列并行不通信即可送入下一段，行并行末尾一次 all-reduce 合并；MLP 与 attention 各一次，共 2 次/层</span>

<details>
<summary>ASCII 原版</summary>

```
A 列并行 (ColumnParallel):     B 行并行 (RowParallel):

   A 在列方向切 P 份              B 在行方向切 P 份
   每个 rank 算 Y_i = X · A_i      每个 rank 算 Z_i = Y_i · B_i
   输出本地 dim/P 的张量            输出仍是 hidden_dim，但只是局部和

           ┌─────┐                 ┌─────┐
   X ────► │ A_0 │ ─► Y_0 ────►   │ B_0 │ ──► Z_0  ─┐
   X ────► │ A_1 │ ─► Y_1 ────►   │ B_1 │ ──► Z_1  ─┼─► all_reduce ─► Z
   X ────► │ A_2 │ ─► Y_2 ────►   │ B_2 │ ──► Z_2  ─┘
```

</details>

因此每个 transformer block 的 MLP 一次 all-reduce（行并行结尾），
attention 同理（QKV 是列并行，O proj 是行并行），所以**两次 all-reduce / 层**。

这样切的关键设计原因（Megatron 论文）：

- **列并行** 输入完整 `X`、输出沿最后一维分片：不需要任何通信即可送入下一段；
- **行并行** 输入是分片的、输出是完整 hidden_dim 但只是部分和：一次 all-reduce 即合并；
- 二者串联起来，激活只在每个 block 边界做一次 all-reduce，避免逐 GEMM 通信。

### 10.3.2 代码：`ColumnParallelLinear` 与 `RowParallelLinear`

`ColumnParallelLinear` (`vllm/model_executor/layers/linear.py:413`)：

```python
# linear.py:454-457
self.tp_rank = get_tensor_model_parallel_rank()
self.tp_size = get_tensor_model_parallel_world_size()
self.input_size_per_partition  = input_size                   # 完整输入
self.output_size_per_partition = divide(output_size, tp_size) # 输出切片
```

forward (`linear.py:581`)：

```python
output_parallel = self.quant_method.apply(self, input_, bias)
if self.gather_output and self.tp_size > 1:
    output = tensor_model_parallel_all_gather(output_parallel)  # 罕见
else:
    output = output_parallel                                    # 常见：保留分片
```

`RowParallelLinear` (`linear.py:1395`) 镜像处理：

```python
# linear.py:1448-1449
self.input_size_per_partition  = divide(input_size, tp_size)  # 输入切片
self.output_size_per_partition = output_size                   # 完整输出

# linear.py:1561-1564
if self.reduce_results and self.tp_size > 1:
    output = tensor_model_parallel_all_reduce(output_parallel)
```

`QKVParallelLinear` (`linear.py:978`) 是 `ColumnParallelLinear` 的特化，按 head 切：

```python
# linear.py:1031-1037
self.num_heads = divide(self.total_num_heads, tp_size)
if tp_size >= self.total_num_kv_heads:
    self.num_kv_heads = 1
    self.num_kv_head_replicas = divide(tp_size, self.total_num_kv_heads)  # GQA 复制
else:
    self.num_kv_heads = divide(self.total_num_kv_heads, tp_size)
    self.num_kv_head_replicas = 1
```

GQA / MQA 模型当 `tp_size > num_kv_heads` 时，KV head 在多个 TP rank 间复制
（每个 rank 仍持有完整 KV head）；这是 vLLM 支持 TP=8 跑 num_kv_heads=4 模型的原因。

`VocabParallelEmbedding` (`vllm/model_executor/layers/vocab_parallel_embedding.py:192`)
按词表沿 TP 切分；每个 rank 仅持有自己的部分，未命中部分输出 0，最后用 all-reduce
合并。

### 10.3.3 weight loading 的切分

加载时 `weight_loader` 仅取属于本 rank 的切片：

```python
# linear.py:560-563 (ColumnParallel)
if output_dim is not None and not is_sharded_weight:
    shard_size = param_data.shape[output_dim]
    start_idx = self.tp_rank * shard_size
    loaded_weight = loaded_weight.narrow(output_dim, start_idx, shard_size)
```

行并行同理但 narrow 在 input_dim (`linear.py:1521`)。这样每个 worker 只需读取自己
份内的权重数据；当配合 sharded checkpoint，可以避免完整加载到 host memory。

### 10.3.4 通信模式总结

<svg viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="单个 transformer block 在 TP 下的通信序列">
  <defs>
    <marker id="ar10c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="320" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Transformer block 在 TP=4 下：每层共 2 次 all-reduce</text>
  <rect x="50" y="40" width="540" height="200" fill="#fff7ed" stroke="#fed7aa" stroke-width="1" rx="6"/>
  <text x="70" y="62" font-size="12" font-weight="700" fill="#9a3412">Attention</text>
  <g transform="translate(170, 50)">
    <rect x="0" y="20" width="300" height="28" fill="#fed7aa" stroke="#ea580c"/>
    <text x="150" y="38" text-anchor="middle" font-size="11" font-weight="600" fill="#7c2d12">X（完整 hidden）</text>
    <path d="M 150 48 L 150 64" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/>
    <rect x="0" y="70" width="300" height="28" fill="#fed7aa" stroke="#ea580c"/>
    <text x="150" y="88" text-anchor="middle" font-size="11" font-weight="600" fill="#7c2d12">QKVParallelLinear（column）</text>
    <text x="310" y="88" font-size="10" fill="#16a34a">no comm</text>
    <path d="M 150 98 L 150 114" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/>
    <rect x="0" y="120" width="300" height="28" fill="#fef3c7" stroke="#facc15"/>
    <text x="150" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">Attention compute（per rank，按 head 切）</text>
    <text x="310" y="138" font-size="10" fill="#16a34a">no comm</text>
    <path d="M 150 148 L 150 164" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/>
    <rect x="0" y="170" width="300" height="28" fill="#99f6e4" stroke="#0d9488"/>
    <text x="150" y="188" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">O proj（RowParallelLinear）</text>
    <rect x="310" y="170" width="100" height="28" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="360" y="188" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">all_reduce 1</text>
  </g>
  <path d="M 320 240 L 320 270" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10c)"/>
  <rect x="50" y="270" width="540" height="180" fill="#f0fdfa" stroke="#99f6e4" stroke-width="1" rx="6"/>
  <text x="70" y="292" font-size="12" font-weight="700" fill="#115e59">MLP</text>
  <g transform="translate(170, 280)">
    <rect x="0" y="20" width="300" height="28" fill="#fed7aa" stroke="#ea580c"/>
    <text x="150" y="38" text-anchor="middle" font-size="11" font-weight="600" fill="#7c2d12">gate/up_proj（column, merged）</text>
    <text x="310" y="38" font-size="10" fill="#16a34a">no comm</text>
    <path d="M 150 48 L 150 64" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/>
    <rect x="0" y="70" width="300" height="28" fill="#fef3c7" stroke="#facc15"/>
    <text x="150" y="88" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">SiLU 激活（element-wise）</text>
    <path d="M 150 98 L 150 114" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10c)"/>
    <rect x="0" y="120" width="300" height="28" fill="#99f6e4" stroke="#0d9488"/>
    <text x="150" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">down_proj（row）</text>
    <rect x="310" y="120" width="100" height="28" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="360" y="138" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">all_reduce 2</text>
  </g>
  <text x="320" y="468" text-anchor="middle" font-size="10" fill="#94a3b8">两次 all-reduce 是 TP 的内在带宽瓶颈 → 一般限节点内 NVLink（TP ≤ 8）</text>
</svg>
<span class="figure-caption">图 R10.3 ｜ TP=4 下单个 transformer block 的通信序列：attention 与 MLP 内部各算各的，只在 RowParallel 末尾各做 1 次 all-reduce 合回完整 hidden，共 2 次/层</span>

<details>
<summary>ASCII 原版</summary>

```
Transformer block, TP=4:

  ┌─ Attention ──────────────────────────┐
  │   X (full hidden)                    │
  │      │                                │
  │      ▼ QKVParallelLinear (column)     │
  │   Q,K,V split by heads, no comm       │
  │      │                                │
  │      ▼ Attention compute (per rank)   │
  │      │                                │
  │      ▼ O proj (RowParallelLinear)     │
  │   *** all_reduce ***                  │
  └──────┼───────────────────────────────┘
         ▼
  ┌─ MLP ──────────────────────────────────┐
  │      ▼ gate/up_proj (column, merged)   │
  │   no comm                              │
  │      ▼ activation                      │
  │      ▼ down_proj (row)                 │
  │   *** all_reduce ***                   │
  └────────────────────────────────────────┘
```

</details>

每层 2 次 all-reduce 是 TP 的内在带宽瓶颈，所以 TP 一般只在单节点 NVLink 内做（最多 8）。
custom all-reduce（§10.7）专为小消息（< 8 MiB）替代 NCCL。

### 10.3.5 TP 组的初始化

在 `initialize_model_parallel` 中，TP 组用 `use_message_queue_broadcaster=True`
创建，因为 driver worker (TP rank 0) 需要向其他 TP rank 高频广播 `SchedulerOutput`：

```python
# vllm/distributed/parallel_state.py:1586-1592
_TP = init_model_parallel_group(
    group_ranks,
    get_world_group().local_rank,
    backend,
    use_message_queue_broadcaster=True,
    group_name="tp",
)
```

`MessageQueue` 走共享内存（同节点）或 ZMQ（跨节点），见
`vllm/distributed/device_communicators/shm_broadcast.py:358`。这样
`SchedulerOutput` 的广播不占用 NCCL 流，且不会阻塞 cudaStream。

---

## 10.4 Pipeline Parallelism (PP)

### 10.4.1 原理

PP 把 transformer layers 按段切分给不同 stage，stage 之间仅传递隐藏激活；每个 stage
还可以叠加 TP。`get_pp_indices` (`vllm/distributed/utils.py:95`) 决定每个 stage
负责哪些层：

```python
# vllm/distributed/utils.py:124-129
layers_per_partition = num_hidden_layers // pp_size
partitions = [layers_per_partition for _ in range(pp_size)]
if remaining_layers := num_hidden_layers % pp_size:
    for i in range(2, remaining_layers + 2):
        partitions[-i] += 1    # 多余层放到中段，平衡 compute
```

环境变量 `VLLM_PP_LAYER_PARTITION` 可以手动指定切分。

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="PP=4 把 32 层模型分到 4 个 stage">
  <defs>
    <marker id="ar10d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">PP=4，32 层模型：每 stage 8 层，相邻 stage 一次 send/recv</text>
  <g transform="translate(30, 60)">
    <rect x="0" y="0" width="160" height="140" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">stage 0</text>
    <text x="80" y="38" text-anchor="middle" font-size="10" fill="#9a3412">embedding</text>
    <line x1="14" y1="46" x2="146" y2="46" stroke="#fdba74" stroke-dasharray="3,2"/>
    <text x="80" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">layer 0 .. 7</text>
    <text x="80" y="80" text-anchor="middle" font-size="9" fill="#c2410c">8 layers</text>
    <text x="80" y="118" text-anchor="middle" font-size="9" fill="#94a3b8">持有 input embed</text>
  </g>
  <g transform="translate(210, 60)">
    <rect x="0" y="0" width="160" height="140" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">stage 1</text>
    <text x="80" y="48" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">layer 8 .. 15</text>
    <text x="80" y="66" text-anchor="middle" font-size="9" fill="#0f766e">8 layers</text>
  </g>
  <g transform="translate(390, 60)">
    <rect x="0" y="0" width="160" height="140" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">stage 2</text>
    <text x="80" y="48" text-anchor="middle" font-size="11" font-weight="600" fill="#5b21b6">layer 16 .. 23</text>
    <text x="80" y="66" text-anchor="middle" font-size="9" fill="#6d28d9">8 layers</text>
  </g>
  <g transform="translate(570, 60)">
    <rect x="0" y="0" width="160" height="140" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#0369a1">stage 3</text>
    <text x="80" y="48" text-anchor="middle" font-size="11" font-weight="600" fill="#075985">layer 24 .. 31</text>
    <text x="80" y="66" text-anchor="middle" font-size="9" fill="#0284c7">8 layers</text>
    <line x1="14" y1="86" x2="146" y2="86" stroke="#7dd3fc" stroke-dasharray="3,2"/>
    <text x="80" y="104" text-anchor="middle" font-size="10" fill="#075985">lm_head</text>
    <text x="80" y="124" text-anchor="middle" font-size="9" fill="#94a3b8">持有 sampler</text>
  </g>
  <path d="M 190 130 L 208 130" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10d)"/>
  <path d="M 370 130 L 388 130" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10d)"/>
  <path d="M 550 130 L 568 130" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10d)"/>
  <text x="200" y="220" text-anchor="middle" font-size="10" fill="#64748b">send_tensor_dict</text>
  <text x="200" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">(hidden, residual)</text>
  <text x="380" y="220" text-anchor="middle" font-size="10" fill="#64748b">send_tensor_dict</text>
  <text x="380" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">(hidden, residual)</text>
  <text x="560" y="220" text-anchor="middle" font-size="10" fill="#64748b">send_tensor_dict</text>
  <text x="560" y="232" text-anchor="middle" font-size="9" fill="#94a3b8">(hidden, residual)</text>
  <rect x="30" y="252" width="700" height="36" fill="#f8fafc" stroke="#cbd5e1" rx="4"/>
  <text x="380" y="272" text-anchor="middle" font-size="10" fill="#64748b">余下层（num_hidden_layers % pp_size）放到中段，平衡 compute；可用 VLLM_PP_LAYER_PARTITION 手动指定</text>
</svg>
<span class="figure-caption">图 R10.4 ｜ PP=4 拆 32 层 LLM：每 stage 一段连续层；stage 0 含 embedding、stage N-1 含 lm_head；相邻 stage 之间只传 hidden + residual</span>

<details>
<summary>ASCII 原版</summary>

```
PP=4, 32 层模型：

  stage 0          stage 1          stage 2          stage 3
  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
  │ embed      │   │ layer 8    │   │ layer 16   │   │ layer 24   │
  │ layer 0..7 │ → │ layer 9    │ → │ ...        │ → │ ...        │
  │            │   │ ...        │   │ layer 23   │   │ layer 31   │
  │            │   │ layer 15   │   │            │   │ lm_head    │
  └────────────┘   └────────────┘   └────────────┘   └────────────┘
        send_tensor_dict (hidden, residual)
```

</details>

每相邻 stage 一次 P2P send/recv；stage 0 持有 embedding，stage N-1 持有 lm_head。

### 10.4.2 V1 中的 1F1B

vLLM V1 不使用经典的 1F1B 调度，而是把 PP 当作"调度器视角下的并发流水"：调度器
最多并行 `pp_size` 个 microbatch，每个 batch 仍然按完整模型走一遍，但不同 batch
在不同 stage 上交叉执行。`max_concurrent_batches` 由 executor 报告：

```python
# vllm/v1/executor/ray_executor.py:99-105
@property
def max_concurrent_batches(self) -> int:
    pp_size = self.parallel_config.pipeline_parallel_size
    return 2 if pp_size <= 1 and self.scheduler_config.async_scheduling else pp_size
```

异步调度（async scheduling）在 `pp_size <= 1` 时给出 2 个并发槽，PP > 1 时让 PP
本身提供并发。这是 V1 没有 1F1B 全套实现的原因：调度器只暴露并发度，runner 用
非阻塞 send/recv 让 PP stage 间自然形成 pipeline 重叠。

### 10.4.3 model runner 中的 PP 通信

`vllm/v1/worker/gpu_model_runner.py:4190-4238`：

```python
if not self.broadcast_pp_output:
    if not get_pp_group().is_last_rank:
        # 中间 stage：把隐藏状态传给下一个 stage
        assert isinstance(hidden_states, IntermediateTensors)
        hidden_states.kv_connector_output = kv_connector_output
        return hidden_states          # PP send 在更高层做
    sample_hidden_states = hidden_states[logits_indices]
    logits = self.model.compute_logits(sample_hidden_states)
else:
    sample_hidden_states = hidden_states[logits_indices]
    if not get_pp_group().is_last_rank:
        all_gather_tensors = {
            "residual": not is_residual_scattered_for_sp(
                self.vllm_config, num_tokens_padded
            )
        }
        get_pp_group().send_tensor_dict(
            hidden_states.tensors,
            all_gather_group=get_tp_group(),
            all_gather_tensors=all_gather_tensors,
        )
        logits = None
    else:
        logits = self.model.compute_logits(sample_hidden_states)

    model_output_broadcast_data: dict[str, Any] = {}
    if logits is not None:
        model_output_broadcast_data["logits"] = logits.contiguous()
    broadcasted = get_pp_group().broadcast_tensor_dict(
        model_output_broadcast_data, src=len(get_pp_group().ranks) - 1
    )
```

`send_tensor_dict` 用 `all_gather_group=get_tp_group()` 的小优化：当待传输的张量
在 TP 维度复制（如 hidden_states），每个 TP rank 只发自己分片的 1/tp_size，对端通过
TP all-gather 还原，把 PP 带宽降到 1/tp_size，见
`vllm/distributed/parallel_state.py:821-913`。

### 10.4.4 哪些 executor 支持 PP

只有 `supports_pp = True` 的 executor：

- `MultiprocExecutor` (`vllm/v1/executor/multiproc_executor.py:103`) — 单节点 PP
- `RayDistributedExecutor` (`vllm/v1/executor/ray_executor.py:68`) — 多节点 PP

`UniProcExecutor` 只有一个 worker，无法做 PP。

---

## 10.5 Data Parallelism (DP)

### 10.5.1 与 TP/PP 的关键区别

DP 中每个 DP rank 是**独立的引擎**，各自持有完整模型副本、独立的调度器、独立的 KV
cache 池。这与 TP/PP 不同：TP/PP 内的 ranks 一起执行同一个 batch，DP 之间 ranks
执行各自的 batch。

但在 MoE / EP 场景下，多个 DP rank **必须步调一致**，因为 MoE 层的 all2all 需要在
所有 EP-参与者上同步发起。这是 DP coordinator 存在的原因。

### 10.5.2 DPCoordinator 进程

`vllm/v1/engine/coordinator.py:23` 描述 `DPCoordinator`。它是一个独立进程，
通过 ZMQ 与 N 个 DP engine 和 M 个前端 API server 通信：

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DPCoordinator 进程与 API server 和 engine 的 ZMQ 通信">
  <defs>
    <marker id="ar10e" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">DPCoordinator：1 个独立进程协调多个 DP engine + 多个 API server</text>
  <g transform="translate(40, 60)">
    <rect x="0" y="0" width="180" height="70" fill="#bae6fd" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
    <text x="90" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#0c4a6e">API server</text>
    <text x="90" y="40" text-anchor="middle" font-size="10" fill="#075985">frontend (FastAPI)</text>
    <text x="90" y="56" text-anchor="middle" font-size="10" fill="#075985">前端负载均衡</text>
  </g>
  <g transform="translate(290, 50)">
    <rect x="0" y="0" width="180" height="90" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="90" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">DPCoordinator</text>
    <text x="90" y="38" text-anchor="middle" font-size="10" fill="#6d28d9">1 process</text>
    <line x1="14" y1="46" x2="166" y2="46" stroke="#c4b5fd" stroke-dasharray="3,2"/>
    <text x="90" y="62" text-anchor="middle" font-size="10" fill="#6d28d9">收 engine 队列长度</text>
    <text x="90" y="76" text-anchor="middle" font-size="10" fill="#6d28d9">广播 START_DP_WAVE</text>
  </g>
  <path d="M 220 80 L 288 80" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10e)"/>
  <text x="254" y="68" text-anchor="middle" font-size="9" fill="#64748b">stats publish</text>
  <path d="M 288 110 L 220 110" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10e)"/>
  <text x="254" y="124" text-anchor="middle" font-size="9" fill="#64748b">request notify</text>
  <g transform="translate(540, 60)">
    <rect x="0" y="0" width="180" height="70" fill="#fef3c7" stroke="#facc15" stroke-width="1" rx="6"/>
    <text x="90" y="22" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">前端可有多个</text>
    <text x="90" y="40" text-anchor="middle" font-size="10" fill="#a16207">每个都连同一</text>
    <text x="90" y="54" text-anchor="middle" font-size="10" fill="#a16207">coordinator</text>
  </g>
  <path d="M 380 140 L 380 178" fill="none" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar10e)"/>
  <text x="395" y="162" font-size="10" font-weight="600" fill="#5b21b6">start_wave</text>
  <g transform="translate(40, 190)">
    <path d="M 340 0 L 80 50" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10e)"/>
    <path d="M 340 0 L 230 50" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10e)"/>
    <path d="M 340 0 L 450 50" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10e)"/>
    <path d="M 340 0 L 600 50" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10e)"/>
  </g>
  <g transform="translate(40, 250)">
    <rect x="0" y="0" width="120" height="56" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="4"/>
    <text x="60" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">engine 0</text>
    <text x="60" y="42" text-anchor="middle" font-size="9" fill="#9a3412">DPEngineCoreProc</text>
    <rect x="150" y="0" width="120" height="56" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="4"/>
    <text x="210" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">engine 1</text>
    <text x="210" y="42" text-anchor="middle" font-size="9" fill="#9a3412">DPEngineCoreProc</text>
    <rect x="300" y="0" width="120" height="56" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="4"/>
    <text x="360" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">engine 2</text>
    <text x="360" y="42" text-anchor="middle" font-size="9" fill="#9a3412">DPEngineCoreProc</text>
    <rect x="450" y="0" width="120" height="56" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2" rx="4"/>
    <text x="510" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">engine 3</text>
    <text x="510" y="42" text-anchor="middle" font-size="9" fill="#9a3412">DPEngineCoreProc</text>
  </g>
  <rect x="40" y="320" width="680" height="32" fill="#f0fdf4" stroke="#86efac" rx="4"/>
  <text x="380" y="340" text-anchor="middle" font-size="10" fill="#166534">wave 机制让所有 DP rank 在 step 边界对齐 → MoE all2all 不会少 rank（无 N 路凑不齐死锁）</text>
</svg>
<span class="figure-caption">图 R10.5 ｜ DPCoordinator 拓扑：前端发布 stats 给 coordinator 做全局视图，coordinator 用 START_DP_WAVE 让 idle engine 一起进入 running，避免空闲 rank 错过 MoE all2all 同步窗口</span>

<details>
<summary>ASCII 原版</summary>

```
   ┌─────────────┐                   ┌──────────────┐
   │ API server  │ ───stats publish──│ DPCoordinator│
   │ (frontend)  │   request notify  │  (1 process) │
   └─────────────┘                   └─────┬────────┘
                                           │ start_wave
                ┌──────────────┬──────────┼──────────┐
                ▼              ▼          ▼          ▼
            ┌───────┐    ┌───────┐  ┌───────┐  ┌───────┐
            │engine0│    │engine1│  │engine2│  │engine3│  (DPEngineCoreProc)
            └───────┘    └───────┘  └───────┘  └───────┘
```

</details>

职责（见 docstring `coordinator.py:23-57`）：

1. 收集每个 engine 的 waiting/running 队列长度，发布给前端做负载均衡；
2. 跟踪 "request wave" 编号——所有 engine 在 running 与 paused 间集体切换的计数；
3. 收到新请求时给所有 idle engine 广播 `START_DP_WAVE`，让它们一起进入 running。

第 2、3 点的目的是避免空闲 DP rank 错过 MoE all2all 的同步窗口：若一个 rank 接到
请求开始 step，其他 rank 还在 idle，则 all2all 永远凑不齐 N 路。Wave 机制让所有 rank
在 step 边界对齐，并通过 `_has_global_unfinished_reqs` 内的 all-reduce 共识决定何时
集体暂停（`vllm/v1/engine/core.py:1645` 的 `DPEngineCoreProc`，第 1721-1723 行的注释
描述 phase 1/2）。

### 10.5.3 DP 的 token padding

```python
# vllm/v1/worker/dp_utils.py:101-161
def _synchronize_dp_ranks(num_tokens_unpadded, num_tokens_padded,
                          should_attempt_ubatching, cudagraph_mode,
                          parallel_config) -> tuple[bool, Tensor, int]:
    tensor = _run_ar(...)                            # all-reduce 4 行元数据
    synced_cudagraph_mode = _post_process_cudagraph_mode(tensor)
    should_ubatch = _post_process_ubatch(tensor, ...)
    should_dp_pad = synced_cudagraph_mode != 0 or should_ubatch
    num_tokens_after_padding = _post_process_dp_padding(tensor, should_dp_pad)
    return should_ubatch, num_tokens_after_padding, synced_cudagraph_mode
```

当 CUDA Graph 启用或 microbatching 启用时，所有 DP rank 必须跑相同 token 数，否则
graph shape 不匹配 / microbatch 划分错位。`coordinate_batch_across_dp`
(`dp_utils.py:164`) 在每个 step 开头做一次 all-reduce，决定 padding 到全局最大值。

为减少 GPU 同步开销，元数据 tensor 在 CPU 上构造再异步搬到 device：

```python
# vllm/v1/worker/dp_utils.py:47-53
tensor_cpu = torch.zeros(4, dp_size, dtype=torch.int32)
tensor_cpu[0][dp_rank] = orig_num_tokens_per_ubatch
tensor_cpu[1][dp_rank] = padded_num_tokens_per_ubatch
tensor_cpu[2][dp_rank] = 1 if should_ubatch else 0
tensor_cpu[3][dp_rank] = cudagraph_mode
tensor = tensor_cpu.to(device, non_blocking=True)
dist.all_reduce(tensor, group=group)
```

`disable_nccl_for_dp_synchronization` 标志可以强制走 CPU gloo all-reduce
（`dp_utils.py:27-32`），代价是引入 host-device sync。

### 10.5.4 DP+TP / DP+EP 组合

DP 与 TP 沿不同维度切：`DP * (PP * TP)` 个进程，前 `pp*tp` 个组成 DP rank 0 的引擎，
后续每 `pp*tp` 个组成 DP rank 1 的引擎，以此类推。`init_distributed_environment` 在
DP > 1 时调整 rank：

```python
# vllm/distributed/parallel_state.py:1387-1392
parallel_config = config.parallel_config
rank = parallel_config.data_parallel_rank * world_size + rank
world_size = parallel_config.world_size_across_dp
```

DP + EP 组合时，EP group 横跨多个 DP rank：每个 DP rank 在 TP 维度的 ranks 加入同
一个 EP group，组大小为 `DP * PCP * TP`。这是 DeepEP / NixlEP 的"big EP" 拓扑，
所有专家分布在 EP 组内，路由由 all2all 决定。

---

## 10.6 Expert Parallelism (EP)

### 10.6.1 MoE 的两种切法

对一个 MoE 层，weights 分布有两种自然选择：

1. **TP-only**：每个 expert 的 W1/W2 沿 hidden 维列/行切；每个 GPU 持有所有 expert
   的部分。优点：复用现有 TP 通信；缺点：所有 expert 同时被激活，浪费计算。
2. **EP**：把 expert 整体分到不同 GPU；每个 GPU 持有 `num_experts / ep_size` 个完整
   expert。优点：每 token 只激活 top-k expert，活跃 GPU 数 = top-k；缺点：需要
   all2all dispatch token 到 expert 所在 GPU。

vLLM 同时支持，由 `--enable-expert-parallel` 切换。开启时 EP 组在
`initialize_model_parallel` 中创建（§10.1.2）。

### 10.6.2 `FusedMoEParallelConfig`

`vllm/model_executor/layers/fused_moe/config.py:1007-1184` 描述各种 TP×DP×EP
组合下，每个 device 看到的 (tp_size, tp_rank, dp_size, dp_rank, ep_size, ep_rank)。
示例（节选 docstring）：

```
TP=2, DP=2, EP=True:
  device 0: TP={1,0} DP={2,0} EP={4,0}    # ep_size = TP*DP
  device 1: TP={1,0} DP={2,0} EP={4,1}
  device 2: TP={1,0} DP={2,1} EP={4,2}
  device 3: TP={1,0} DP={2,1} EP={4,3}
```

开启 EP 时 TP 大小被"吃掉" → 实际 attention 不再 TP 切；hidden_size 张量在 attention
和 MoE 之间通过 `dispatch` / `combine` 重新分布。

### 10.6.3 all2all backend

```python
# vllm/distributed/device_communicators/cuda_communicator.py:117-167
if self.use_all2all:
    if self.all2all_backend == "naive" or "allgather_reducescatter":
        self.all2all_manager = AgRsAll2AllManager(self.cpu_group, ...)
    elif self.all2all_backend == "deepep_high_throughput":
        self.all2all_manager = DeepEPHTAll2AllManager(...)
    elif self.all2all_backend == "deepep_low_latency":
        self.all2all_manager = DeepEPLLAll2AllManager(...)
    elif self.all2all_backend == "mori":
        self.all2all_manager = MoriAll2AllManager(self.cpu_group)
    elif self.all2all_backend == "nixl_ep":
        self.all2all_manager = NixlEPAll2AllManager(...)
    elif self.all2all_backend in ("flashinfer_all2allv",
                                  "flashinfer_nvlink_two_sided"):
        self.all2all_manager = FlashInferNVLinkTwoSidedManager(...)
    elif self.all2all_backend == "flashinfer_nvlink_one_sided":
        self.all2all_manager = FlashInferNVLinkOneSidedManager(self.cpu_group)
```

各 backend 的设计取舍：

- `naive` / `allgather_reducescatter`：仅依赖 NCCL，无外部依赖，适合调试；
- `deepep_high_throughput`：DeepEP 的 HT 模式，针对 prefill 类大 token batch；
- `deepep_low_latency`：DeepEP 的 LL 模式，针对 decode（小 token、要求低延迟）；
- `nixl_ep`：基于 NIXL，支持跨节点 RDMA；
- `flashinfer_nvlink_*`：纯 NVLink one-sided/two-sided，避免 NCCL 调度开销。

ep 选择哪种由 `VLLM_ALL2ALL_BACKEND` 环境变量控制。

### 10.6.4 dispatch / combine

```python
# vllm/distributed/parallel_state.py:1101-1129
def dispatch(self, hidden_states, topk_weights, topk_ids,
             is_sequence_parallel=False, extra_tensors=None):
    if self.device_communicator is not None:
        return self.device_communicator.dispatch(
            hidden_states, topk_weights, topk_ids,
            is_sequence_parallel, extra_tensors)
    return hidden_states, topk_weights, topk_ids

def combine(self, hidden_states, is_sequence_parallel=False):
    if self.device_communicator is not None:
        return self.device_communicator.combine(hidden_states,
                                                is_sequence_parallel)
    return hidden_states
```

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MoE EP=4 的 dispatch 和 combine all2all 流程">
  <defs>
    <marker id="ar10f" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">MoE 层 EP=4：每 token 走 top-2 expert，dispatch → expert apply → combine</text>
  <g transform="translate(30, 56)">
    <text x="80" y="0" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">源 rank（持有 token）</text>
    <rect x="0" y="14" width="160" height="120" fill="#fef3c7" stroke="#facc15" rx="4"/>
    <text x="80" y="34" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">rank 0</text>
    <text x="14" y="58" font-size="10" fill="#a16207">T0 → (e1, e5)</text>
    <text x="14" y="76" font-size="10" fill="#a16207">T1 → (e0, e7)</text>
    <text x="14" y="94" font-size="10" fill="#a16207">T2 → (e3, e6)</text>
    <text x="14" y="120" font-size="9" fill="#94a3b8">topk_ids[token]</text>
    <rect x="0" y="146" width="160" height="40" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
    <text x="80" y="170" text-anchor="middle" font-size="10" fill="#64748b">rank 1..3 同理</text>
  </g>
  <g transform="translate(220, 60)">
    <rect x="0" y="40" width="120" height="120" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="60" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">all2all</text>
    <text x="60" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">dispatch</text>
    <text x="60" y="106" text-anchor="middle" font-size="9" fill="#6d28d9">按 topk_ids</text>
    <text x="60" y="120" text-anchor="middle" font-size="9" fill="#6d28d9">送 token 去</text>
    <text x="60" y="134" text-anchor="middle" font-size="9" fill="#6d28d9">expert 所在 rank</text>
  </g>
  <path d="M 193 110 L 218 105" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10f)"/>
  <path d="M 193 160 L 218 130" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10f)"/>
  <g transform="translate(380, 56)">
    <text x="100" y="0" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">expert 分布（EP=4）</text>
    <rect x="0" y="14" width="100" height="44" fill="#fed7aa" stroke="#ea580c" rx="3"/>
    <text x="50" y="32" text-anchor="middle" font-size="10" font-weight="700" fill="#7c2d12">GPU 0</text>
    <text x="50" y="48" text-anchor="middle" font-size="10" fill="#9a3412">e0, e1</text>
    <rect x="110" y="14" width="100" height="44" fill="#99f6e4" stroke="#0d9488" rx="3"/>
    <text x="160" y="32" text-anchor="middle" font-size="10" font-weight="700" fill="#115e59">GPU 1</text>
    <text x="160" y="48" text-anchor="middle" font-size="10" fill="#115e59">e2, e3</text>
    <rect x="0" y="64" width="100" height="44" fill="#ddd6fe" stroke="#7c3aed" rx="3"/>
    <text x="50" y="82" text-anchor="middle" font-size="10" font-weight="700" fill="#5b21b6">GPU 2</text>
    <text x="50" y="98" text-anchor="middle" font-size="10" fill="#5b21b6">e4, e5</text>
    <rect x="110" y="64" width="100" height="44" fill="#bae6fd" stroke="#0ea5e9" rx="3"/>
    <text x="160" y="82" text-anchor="middle" font-size="10" font-weight="700" fill="#0369a1">GPU 3</text>
    <text x="160" y="98" text-anchor="middle" font-size="10" fill="#0369a1">e6, e7</text>
    <text x="100" y="138" text-anchor="middle" font-size="9" fill="#64748b">每 GPU 持 num_experts/ep_size 个完整 expert</text>
    <text x="100" y="154" text-anchor="middle" font-size="9" fill="#64748b">每 token 只激活 top-k 个</text>
  </g>
  <path d="M 343 115 L 378 95" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10f)"/>
  <g transform="translate(610, 60)">
    <rect x="0" y="40" width="120" height="120" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="60" y="62" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">all2all</text>
    <text x="60" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">combine</text>
    <text x="60" y="106" text-anchor="middle" font-size="9" fill="#6d28d9">把各 expert 的</text>
    <text x="60" y="120" text-anchor="middle" font-size="9" fill="#6d28d9">输出按 topk_weights</text>
    <text x="60" y="134" text-anchor="middle" font-size="9" fill="#6d28d9">加权汇回源 rank</text>
  </g>
  <path d="M 580 115 L 608 115" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10f)"/>
  <g transform="translate(30, 260)">
    <text x="0" y="0" font-size="11" font-weight="600" fill="currentColor">各 all2all backend 取舍</text>
    <text x="0" y="20" font-size="10" fill="#64748b">naive / allgather_reducescatter：仅 NCCL，调试用</text>
    <text x="0" y="36" font-size="10" fill="#64748b">deepep_high_throughput：prefill 大 batch，吞吐优先</text>
    <text x="0" y="52" font-size="10" fill="#64748b">deepep_low_latency：decode 小 batch，延迟优先</text>
    <text x="380" y="20" font-size="10" fill="#64748b">nixl_ep：跨节点 RDMA</text>
    <text x="380" y="36" font-size="10" fill="#64748b">flashinfer_nvlink_*：纯 NVLink one/two-sided</text>
    <text x="380" y="52" font-size="10" fill="#64748b">mori：AMD 平台对应实现</text>
  </g>
</svg>
<span class="figure-caption">图 R10.6 ｜ EP=4 的 MoE 层：dispatch 把每个 token 按 topk_ids 路由到目标 expert 所在 GPU，expert 本地计算后再 combine 按 topk_weights 加权汇回；EP 组大小 = DP × PCP × TP</span>

<details>
<summary>ASCII 原版</summary>

```
MoE 层 (EP=4)：

   每个 token 选 top-2 expert
                                            expert 分布：
   ┌─────────────┐                          GPU0: e0,e1
   │ rank 0      │  ─ dispatch by topk_ids ─►  ─┐
   │  T0,T1,T2   │                              │
   │  -> (e1,e5)  │                             ▼
   │  -> (e0,e7)  │                          ┌──────────────┐
   │  -> (e3,e6)  │                          │  expert e1   │  applies T0
   └─────────────┘                          │  expert e5   │  applies T0
                       all2all dispatch     │  ...         │
   ┌─────────────┐                          └──────────────┘
   │ rank 1..3   │  ─────────────────────►   每个 token 到达若干 rank
   └─────────────┘                                  │
                                                    ▼
                                            all2all combine
                                                    │
                                                    ▼
                                          weighted sum back to source rank
```

</details>

### 10.6.5 EPLB

EP 时各 expert 负载不均：少数热门 expert 会拖慢整个 step。EPLB（Expert Load
Balancer）通过周期性重排专家分布缓解。EPLB 组与 EP 组 rank 相同但 process group
独立（`vllm/distributed/parallel_state.py:1697-1719`），避免 EPLB 集合与 MoE
forward 的 NCCL 集合互相阻塞造成死锁。

---

## 10.7 通信原语

### 10.7.1 高层 API

```python
# vllm/distributed/communication_op.py
tensor_model_parallel_all_reduce(input_)        # :12
tensor_model_parallel_all_gather(input_, dim)   # :17
tensor_model_parallel_reduce_scatter(input_, dim)  # :24
tensor_model_parallel_gather(input_, dst, dim)  # :31
broadcast_tensor_dict(tensor_dict, src)         # :38
```

所有都委托给 `get_tp_group()`。其他轴对应的 op 也存在（如 `get_pp_group().send_tensor_dict`），
只是没有便捷函数包装。

### 10.7.2 CudaCommunicator 的 fallback 链

`vllm/distributed/device_communicators/cuda_communicator.py:174-231` 描述
TP all-reduce 的优先级回退：

```python
def all_reduce(self, input_):
    if pynccl_comm is not None and should_nccl_symm_mem_allreduce(...):
        out = torch.ops.vllm.all_reduce_symmetric_with_copy(input_)
        if out is not None:
            return out
    if qr_comm is not None and qr_comm.should_quick_allreduce(input_):
        return qr_comm.quick_all_reduce(input_)          # ROCm MI300
    if fi_ar_comm is not None and fi_ar_comm.should_use_fi_ar(input_):
        return fi_ar_comm.all_reduce(input_)             # FlashInfer
    if ca_comm is not None and ca_comm.should_custom_ar(input_):
        return ca_comm.custom_all_reduce(input_)         # CustomAllreduce
    if symm_mem_comm is not None and symm_mem_comm.should_use_symm_mem(input_):
        return symm_mem_comm.all_reduce(input_)          # torch symm mem
    return pynccl_comm.all_reduce(input_)                # NCCL fallback
```

判断使用哪个 backend 主要看张量大小：小消息（< 8 MiB）走 CustomAllreduce，大消息
走 NCCL。pynccl 是 NCCL 的 ctypes 封装，避免 PyTorch NCCL 路径的额外开销
（`vllm/distributed/device_communicators/pynccl.py`）。

### 10.7.3 CustomAllreduce 的设计

`vllm/distributed/device_communicators/custom_all_reduce.py:50-196`：

- 仅在单节点（`in_the_same_node_as` 检查 `:89`）、世界大小 2/4/6/8、有 NVLink
  / GPU P2P 时启用；
- 用 `create_shared_buffer` 通过 IPC 分配跨进程共享的 device memory（`:175-180`）；
- `_ptr` 是 C++ 端持有的 communicator 句柄；`ops.init_custom_ar` 初始化
  （`:193-196`）；
- 在 CUDA Graph capture 上下文中调用 `register_graph_buffers`，把 buffer 地址注册
  给 graph，让 graph replay 时仍能用同一 buffer（`:199-211`）。

设计要点：对于 < 8 MiB 的张量，NCCL 的 ring-allreduce 单次调用开销（kernel launch、
同步）远大于实际数据传输；CustomAllreduce 用 IPC pinned buffer + 一个
fused kernel 直接 reduce，省掉 launch 与同步开销。

### 10.7.4 MessageQueue（共享内存广播）

`vllm/distributed/device_communicators/shm_broadcast.py:358` 提供 `MessageQueue`，
用 POSIX 共享内存做 SPMC 队列。每次 driver worker 把 `SchedulerOutput` 序列化后
enqueue，其他 worker 在 busy loop 中 dequeue。

为什么不用 NCCL broadcast 或 ZMQ：

- NCCL broadcast 会占用 GPU 计算流，与模型 forward 抢资源；
- ZMQ 网络栈延迟在 µs 级，shm 在 ns 级；
- 同节点常态下 shm 永远更快。

跨节点情况下 `create_from_process_group` 检测到不在同节点会自动 fallback 到 ZMQ。

### 10.7.5 多节点初始化

`init_distributed_environment` (`vllm/distributed/parallel_state.py:1358-1492`)
在 `nnodes > 1 or data_parallel_size > 1` 时使用 `master_addr:master_port` 作为
rendezvous 端点：

```python
# vllm/distributed/parallel_state.py:1395-1402
if parallel_config.nnodes > 1:
    ip = parallel_config.master_addr
    port = parallel_config.master_port
    distributed_init_method = get_distributed_init_method(ip, port)
else:
    ip = parallel_config.data_parallel_master_ip
    port = parallel_config.get_next_dp_init_port()
    distributed_init_method = get_distributed_init_method(ip, port)
```

`StatelessProcessGroup` (`vllm/distributed/utils.py:166-251`) 提供一个仅用 TCPStore
做控制信息交换的轻量化组，用于 elastic EP 等需要动态加入/离开的场景，不依赖
PyTorch process group（后者一旦创建无法扩缩容）。

---

## 10.8 Executor 抽象

### 10.8.1 三种 Executor

`vllm/v1/executor/abstract.py:37` 定义 `Executor`，子类必须实现 `_init_executor`、
`collective_rpc`、`check_health`。`Executor.get_class` (`abstract.py:48-92`)
根据 `distributed_executor_backend` 字段选择：

| 后端 | 类 | 适用场景 |
| --- | --- | --- |
| `uni` | `UniProcExecutor` | TP=PP=1，无并行；快速启动 |
| `mp` | `MultiprocExecutor` | 单节点多 GPU；TP/PP via Python multiprocessing |
| `ray` | `RayDistributedExecutor` | 多节点；TP/PP/DP via Ray placement group |
| `external_launcher` | `ExecutorWithExternalLauncher` | torchrun 启动 |
| `<dotted path>` | 用户自定义 | 插件 |

默认值由 `ParallelConfig.__post_init__` 决定：
`world_size == 1` → `uni`；`world_size > 1` 且单节点 → `mp`；多节点 → `ray`
（`vllm/config/parallel.py:875-908`）。

### 10.8.2 UniProcExecutor

```python
# vllm/v1/executor/uniproc_executor.py:45-66
class UniProcExecutor(Executor):
    def _init_executor(self) -> None:
        self.driver_worker = WorkerWrapperBase(rpc_rank=0)
        distributed_init_method, rank, local_rank = self._distributed_args()
        kwargs = dict(
            vllm_config=self.vllm_config,
            local_rank=local_rank, rank=rank,
            distributed_init_method=distributed_init_method,
            is_driver_worker=True, shared_worker_lock=Lock(),
        )
        self.driver_worker.init_worker(all_kwargs=[kwargs])
        self.driver_worker.init_device()
        self.driver_worker.load_model()
```

只有一个 in-process worker。`collective_rpc` 直接同步调用方法
（`uniproc_executor.py:80-105`），无 IPC 开销。

`ExecutorWithExternalLauncher` (`uniproc_executor.py:149`) 在 UniProc 上叠加
`torchrun` 的 env-vars 启动方式：每个进程都是 UniProcExecutor，但 `RANK` /
`LOCAL_RANK` / `MASTER_ADDR` 由 launcher 设置，多个 engine 并行处理同一批 prompt。
要求 `VLLM_ENABLE_V1_MULTIPROCESSING=0`，确保调度确定性
（`uniproc_executor.py:168-171`）。

### 10.8.3 MultiprocExecutor

```python
# vllm/v1/executor/multiproc_executor.py:102-246（节选）
class MultiprocExecutor(Executor):
    supports_pp: bool = True

    def _init_executor(self) -> None:
        tp_size, pp_size, pcp_size = self._get_parallel_sizes()
        assert self.world_size == tp_size * pp_size * pcp_size
        ...
        # leader node 持有 SchedulerOutput 广播队列
        self.rpc_broadcast_mq = MessageQueue(
            self.world_size, self.local_world_size,
            max_chunk_bytes=max_chunk_bytes, connect_ip=mq_connect_ip)
        scheduler_output_handle = self.rpc_broadcast_mq.export_handle()

        for local_rank in range(self.local_world_size):
            global_rank = global_start_rank + local_rank
            is_driver_worker = self._is_driver_worker(global_rank)
            unready_worker_handle = WorkerProc.make_worker_process(
                vllm_config=self.vllm_config,
                local_rank=local_rank, rank=global_rank,
                distributed_init_method=distributed_init_method,
                input_shm_handle=scheduler_output_handle,
                ...)
            unready_workers.append(unready_worker_handle)

        self.workers = WorkerProc.wait_for_ready(unready_workers)
```

进程模型：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MultiprocExecutor 的进程模型与共享内存广播通道">
  <defs>
    <marker id="ar10g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">MultiprocExecutor 进程模型：1 个 main + N 个 worker，通过共享内存 MessageQueue 广播</text>
  <g transform="translate(220, 50)">
    <rect x="0" y="0" width="320" height="84" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
    <text x="160" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">EngineCoreProc (main)</text>
    <text x="160" y="40" text-anchor="middle" font-size="10" fill="#6d28d9">+ MultiprocExecutor</text>
    <text x="160" y="56" text-anchor="middle" font-size="10" fill="#6d28d9">+ Scheduler（产 SchedulerOutput）</text>
    <rect x="60" y="62" width="200" height="18" fill="#fef3c7" stroke="#facc15"/>
    <text x="160" y="75" text-anchor="middle" font-size="10" font-weight="700" fill="#92400e">rpc_broadcast_mq（共享内存）</text>
  </g>
  <text x="380" y="158" text-anchor="middle" font-size="10" fill="#64748b">enqueue(scheduler_output) → 所有 worker dequeue</text>
  <path d="M 380 165 L 110 200" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10g)"/>
  <path d="M 380 165 L 295 200" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10g)"/>
  <path d="M 380 165 L 465 200" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10g)"/>
  <path d="M 380 165 L 650 200" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10g)"/>
  <g transform="translate(40, 210)">
    <rect x="0" y="0" width="140" height="80" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
    <text x="70" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#7c2d12">WorkerProc rank 0</text>
    <text x="70" y="40" text-anchor="middle" font-size="10" font-weight="700" fill="#9a3412">(driver worker)</text>
    <text x="70" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">execute_model</text>
    <text x="70" y="72" text-anchor="middle" font-size="9" fill="#94a3b8">回 ModelRunnerOutput</text>
  </g>
  <g transform="translate(220, 210)">
    <rect x="0" y="0" width="140" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
    <text x="70" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">WorkerProc rank 1</text>
    <text x="70" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">execute_model</text>
    <text x="70" y="72" text-anchor="middle" font-size="9" fill="#94a3b8">仅返回必要部分</text>
  </g>
  <g transform="translate(400, 210)">
    <rect x="0" y="0" width="140" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
    <text x="70" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">WorkerProc rank 2</text>
    <text x="70" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">...</text>
  </g>
  <g transform="translate(580, 210)">
    <rect x="0" y="0" width="140" height="80" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
    <text x="70" y="22" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">WorkerProc rank N-1</text>
    <text x="70" y="58" text-anchor="middle" font-size="9" fill="#94a3b8">execute_model</text>
  </g>
  <g transform="translate(40, 308)">
    <rect x="0" y="0" width="680" height="40" fill="#fef3c7" stroke="#facc15" rx="4"/>
    <text x="340" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">NCCL 进程组（TP / PP / DP / EP）</text>
    <text x="340" y="32" text-anchor="middle" font-size="10" fill="#a16207">all-reduce / all-gather / send-recv，所有 worker 共同参与</text>
  </g>
  <text x="380" y="368" text-anchor="middle" font-size="10" fill="#94a3b8">execute_model 只从 output_rank 取结果（通常是 PP 最后 stage 的某个 TP rank），减少 IPC 量</text>
</svg>
<span class="figure-caption">图 R10.7 ｜ MultiprocExecutor 把 SchedulerOutput 经共享内存广播给所有 WorkerProc；driver worker（TP rank 0）兼任 scheduler 端，其它 rank 共同参与 NCCL 集合</span>

<details>
<summary>ASCII 原版</summary>

```
                    ┌─────────────────────────┐
                    │  EngineCoreProc (main)  │
                    │  + MultiprocExecutor    │
                    │  + rpc_broadcast_mq     │  ← 共享内存队列
                    └─────────────┬───────────┘
                                  │ enqueue(scheduler_output)
                    ┌─────────────┼──────────────────────┐
                    ▼             ▼                      ▼
              ┌─────────┐   ┌─────────┐            ┌─────────┐
              │WorkerProc│  │WorkerProc│   ...     │WorkerProc│
              │ rank 0  │   │ rank 1  │            │ rank N-1│
              │(driver) │   │         │            │         │
              └─────────┘   └─────────┘            └─────────┘
                  │             │                       │
                  └─────────────┴───────────────────────┘
                       NCCL 进程组（TP/PP/DP/EP）
```

</details>

driver worker（TP rank 0）执行调度并把结果广播给所有 worker，所有 worker
共同执行 NCCL；`response_mqs` 收回 ModelRunnerOutput。

`execute_model` 只从 `output_rank` 那一个 worker 取结果
（`multiproc_executor.py:306-316`），减少 IPC 量；这个 rank 通常是 PP 的最后一个
stage 的某一个 TP rank。

### 10.8.4 RayDistributedExecutor

```python
# vllm/v1/executor/ray_executor.py:64-105
class RayDistributedExecutor(Executor):
    uses_ray: bool = True
    supports_pp: bool = True

    def _init_executor(self) -> None:
        initialize_ray_cluster(self.parallel_config)
        placement_group = self.parallel_config.placement_group
        self._init_workers_ray(placement_group)
```

`initialize_ray_cluster` (`vllm/v1/executor/ray_utils.py:526`) 创建或复用一个
`PACK` 策略的 placement group，确保 worker bundle 尽量装在同节点
（`ray_utils.py:635-662`）：

```python
placement_group_specs: list[dict[str, float]] = [
    {device_key: 1.0} for _ in range(world_size)
]
placement_group_specs[0][f"node:{current_ip}"] = 0.001  # 第 0 个 bundle 锁定到 driver 节点

current_placement_group = ray.util.placement_group(
    placement_group_specs, strategy="PACK")
```

之后 `_init_workers_ray` 按 bundle 创建 N 个 `RayWorkerWrapper` actor，按 `(node_id,
ip)` 排序（驱动节点优先 → 同节点的 worker 编号连续，§10.4 的 PP 才能高效利用 NVLink）。

```python
# vllm/v1/executor/ray_executor.py:386-395
for pp_rank in range(self.parallel_config.pipeline_parallel_size):
    self.pp_tp_workers.append([])
    for tp_rank in range(self.parallel_config.tensor_parallel_size):
        # PP=2, TP=4 → pp_tp_workers = [[0,1,2,3], [4,5,6,7]]
        rank = (pp_rank * self.parallel_config.tensor_parallel_size) + tp_rank
        self.pp_tp_workers[pp_rank].append(self.workers[rank])
```

执行用 Ray Compiled DAG (`_execute_dag`, `ray_executor.py:451-479`)：
DAG 一次性把 SchedulerOutput 广播到所有 worker，结果按 PP stage 拓扑收集；与
NCCL channel 复用 P2P。

---

## 10.9 进程模型与环境变量

### 10.9.1 driver vs worker

- **Driver process**：运行 `EngineCore` + `Executor`，持有 scheduler。
- **Worker process**：每张 GPU 一个；执行 model forward；持有 KV cache、weights。
- **Driver worker**：约定 TP rank 0 兼任 driver worker（`MultiprocExecutor._is_driver_worker`,
  `multiproc_executor.py:264-265`）。它收到 SchedulerOutput 后向其他 TP rank 广播
  额外信息（如 sampler params）。

PP > 1 时，每个 PP stage 的 TP rank 0 都是该 stage 的 driver worker；
ranks 之间用 PP send/recv 串联。

### 10.9.2 环境变量

```python
# vllm/envs.py
LOCAL_RANK            # :23   该进程在本节点的 GPU 索引
VLLM_HOST_IP          # :15   节点对外通信用的 IP
VLLM_DP_MASTER_PORT   # :150  DP rendezvous 端口
```

标准 PyTorch 分布式还需要：

- `RANK`、`WORLD_SIZE`、`MASTER_ADDR`、`MASTER_PORT`（仅 `external_launcher` 后端
  从 env 读取，其他后端由 executor 自己设置）；
- `CUDA_VISIBLE_DEVICES`：Ray 后端会设为节点所有 GPU 而非单个，让每个 worker 用
  `local_rank` 索引（`ray_executor.py:308-325`，注释解释了为什么不设为单个 GPU——
  custom AR 与 P2P 检测都需要看到全部 GPU）。

### 10.9.3 init_worker_distributed_environment

```python
# vllm/v1/worker/gpu_worker.py:1121-1156
def init_worker_distributed_environment(
    vllm_config: VllmConfig, rank: int,
    distributed_init_method: str | None = None,
    local_rank: int = -1, backend: str = "nccl",
) -> None:
    parallel_config = vllm_config.parallel_config
    set_custom_all_reduce(not parallel_config.disable_custom_all_reduce)
    init_method = distributed_init_method or "env://"

    init_distributed_environment(
        parallel_config.world_size, rank, init_method, local_rank, backend)

    ensure_model_parallel_initialized(
        parallel_config.tensor_parallel_size,
        parallel_config.pipeline_parallel_size,
        parallel_config.prefill_context_parallel_size,
        parallel_config.decode_context_parallel_size,
    )
```

调用顺序：

1. `init_distributed_environment` — `torch.distributed.init_process_group("nccl")`
   并创建 `_WORLD`；
2. `ensure_model_parallel_initialized` — 创建 TP/PP/DP/EP/PCP/DCP 子组；
3. 后续 `WorkerBase` 才能调用 `get_tp_group()` 等。

对于 DP，在 `init_device` 里还会调整 `local_rank` 为 `dp_local_rank * tp_pp_world_size + tp_local_rank`
（`gpu_worker.py:243-274`），保证不同 DP rank 的 worker 落到不同 GPU 索引。

---

## 10.10 KV cache 与并行

### 10.10.1 TP 下的 KV cache 切分

KV cache 形状由 attention 的 num_kv_heads 决定，并按 TP 切分：每个 TP rank 持有
`num_kv_heads / tp_size`（或在 GQA tp_size > num_kv_heads 时持有 1 个 head 的副本）。
KV cache 的 block 由 `BlockTable` 管理（见第 8 章），所有 TP rank 共享同一 block id
空间——每个 rank 用自己的 KV head 切片，但 block id 是全局一致的。

调度器只在 driver worker 看到完整的 KV state；调度决策（分配/释放 block、preemption）
由 driver 广播给其他 TP rank。这是为什么 SchedulerOutput 需要走 `MessageQueue`
而非各 rank 各算一遍。

### 10.10.2 PP 下的 KV cache

每个 PP stage 只持有自己负责的层的 KV cache；不同 stage 的 cache 完全独立，
block id 也是 per-stage 的。`KVCacheConfig` 是每个 rank 各报一份给 executor 的
（`vllm/v1/executor/abstract.py:118-137` 的 `initialize_from_config`）。

### 10.10.3 DP 下的 KV cache

每个 DP rank 自己独立维护 KV cache 池，没有跨 DP 的 cache 共享。当一个 DP rank
满载而另一个空闲时，前端的负载均衡器（基于 coordinator 发布的 stats）会把新请求
路由到空闲 rank。

### 10.10.4 Context Parallelism

DCP（decode context parallel）和 PCP（prefill context parallel）沿**序列维度**切
KV cache：`cp_kv_cache_interleave_size` 控制每个 rank 拿到的 KV slice 大小。需要
attention impl 支持 `need_to_return_lse_for_decode` (DCP) 或 `supports_pcp` (PCP)：

```python
# vllm/v1/worker/cp_utils.py:14-45
def check_attention_cp_compatibility(vllm_config: VllmConfig) -> None:
    pcp_size = vllm_config.parallel_config.prefill_context_parallel_size
    dcp_size = vllm_config.parallel_config.decode_context_parallel_size
    if pcp_size * dcp_size > 1:
        for layer in layers.values():
            ...
            if dcp_size > 1:
                assert layer_impl.need_to_return_lse_for_decode
            if pcp_size > 1:
                assert layer_impl.supports_pcp
```

DCP 复用 TP 的 GPU（`tp_size % dcp_size == 0`），不增加 world_size——它把同一组
GPU 在 attention 中按 KV head 切换成按 token 切（`vllm/distributed/parallel_state.py:1596-1614`）。
适合 long context decode：原本受 KV head 数限制的 attention 计算转为受 token 数
限制，可在更多 GPU 上分担长序列的 attention。

---

## 10.11 多节点

### 10.11.1 Ray 路径

1. 用户在每个节点起一个 ray daemon (`ray start --head` / `--address=...`)；
2. 客户端 / engine 进程调用 `LLM(...)`，最终触发 `initialize_ray_cluster`；
3. Ray 创建 placement group，bundles 分布到各节点；
4. `RayDistributedExecutor._init_workers_ray` 创建跨节点 actor；
5. 每个 actor 内的 `WorkerProc.init_worker` 设置 `RANK`、`LOCAL_RANK`、
   `MASTER_ADDR/PORT` 并调用 `init_worker_distributed_environment`；
6. NCCL 通过这些 env 完成 rendezvous（节点间走 IB/RDMA 或 TCP）。

### 10.11.2 多节点 MultiprocExecutor

`MultiprocExecutor` 也支持多节点：leader 节点（`node_rank_within_dp == 0`）
拥有 `rpc_broadcast_mq`，其他节点的 worker 通过 `inner_dp_world_group` 接入
ZMQ-backed MessageQueue：

```python
# vllm/v1/executor/multiproc_executor.py:549-576
if vllm_config.parallel_config.nnodes_within_dp == 1:
    self.rpc_broadcast_mq = MessageQueue.create_from_handle(
        input_shm_handle, self.worker.rank)
    self.worker_response_mq = MessageQueue(1, 1)
else:
    # 跨节点 broadcast 走 inner DP world group
    self.rpc_broadcast_mq = get_inner_dp_world_group().create_mq_broadcaster(
        external_writer_handle=input_shm_handle, blocking=False)
    self.worker_response_mq, self.peer_response_handles = (
        get_inner_dp_world_group().create_single_reader_mq_broadcasters(
            reader_rank_in_group=0))
```

`_INNER_DP_WORLD` 是一个跨节点的 gloo 组，专门承担 SchedulerOutput / ModelRunnerOutput
的传输（见 `vllm/distributed/parallel_state.py:1475-1491`）。

### 10.11.3 torchrun

`ExecutorWithExternalLauncher` 让 vLLM 嵌入到 torchrun 启动的 SPMD 进程组里：
每个进程是一个独立的 `UniProcExecutor`，所有进程必须接到相同 prompt 并保证
调度确定性。常见用例是 RLHF（每个 trainer 进程内置一个 vLLM 推理 actor）。

---

## 10.12 配置项一览

### 10.12.1 ParallelConfig 主要字段

```python
# vllm/config/parallel.py:108-160
pipeline_parallel_size: int = 1      # PP
tensor_parallel_size: int = 1        # TP
data_parallel_size: int = 1          # DP
data_parallel_size_local: int = 1    # 本节点的 DP 数
enable_expert_parallel: bool = False # EP（仅 MoE）
prefill_context_parallel_size: int = 1
decode_context_parallel_size: int = 1
distributed_executor_backend: str | type | None = None
```

派生字段：

- `world_size = pp * tp * pcp` — 单个 DP rank 的进程数
- `world_size_across_dp = world_size * dp`
- `nnodes_within_dp` — 单个 DP rank 跨几个节点

### 10.12.2 CLI 选项

```
--tensor-parallel-size, -tp       # arg_utils.py:954
--pipeline-parallel-size           # arg_utils.py:934
--data-parallel-size, -dp          # arg_utils.py:979
--data-parallel-size-local         # arg_utils.py:997
--enable-expert-parallel           # arg_utils.py:1032
--distributed-executor-backend     # uni | mp | ray | external_launcher
--enable-eplb
--disable-custom-all-reduce
```

约束（部分在 `vllm/config/parallel.py:__post_init__` 验证）：

- `tp * pp * pcp * dp` 必须等于实际 GPU 数；
- EP 要求 `is_moe`；
- EPLB 要求 EP 并且 `tp * dp > 1`；
- `decode_context_parallel_size` 必须能整除 `tensor_parallel_size`；
- ROCm 上 CustomAllreduce 限制 world_size ∈ {2,4,6,8}。

### 10.12.3 推荐拓扑

| 模型 / 场景 | 推荐配置 |
| --- | --- |
| 70B dense, 1 节点 8×A100 | `-tp 8`（单层 2 次 NVLink AR，纯 TP 即可） |
| 405B dense, 2 节点 16×H100 | `-tp 8 -pp 2`（节点内 TP，节点间 PP，避免跨节点 AR） |
| 671B MoE, 8 节点 64×H100 | `-tp 8 --dp 8 --enable-expert-parallel`（每节点 1 个 DP rank，每节点内 TP=8 attention，跨节点 EP=64） |
| 高吞吐多模型并发 | `--dp N`（多个独立引擎；负载均衡靠前端 + coordinator） |
| RLHF rollout | `--distributed-executor-backend external_launcher` + torchrun |
| 长 context decode | 在 TP 基础上加 `--decode-context-parallel-size N` |

设计要点：**TP 永远不跨节点**——每层 2 次 all-reduce，跨节点带宽撑不住；**PP 跨节点**——
仅每 stage 1 次小 send/recv；**DP 跨 DC 也可**——只在引擎边界同步元数据；
**EP 跨节点** 取决于网络（NVLink/IB），需要选对应的 all2all backend。

---

## 10.13 与其他章节的关系

- **第 5 章（执行循环）** 描述了单进程下 `EngineCore` 如何拉 SchedulerOutput；
  本章描述多进程下 SchedulerOutput 如何分发；
- **第 6 章（调度器）** 假设单 KV cache 池；DP 下每个引擎各跑一份调度；
  EP / TP / PP 不影响调度器，因为它们在 worker 侧执行；
- **第 7 章（GPU model runner）** 中的 forward 调用 TP all-reduce / PP send/recv，
  本章给出这些通信的源头；
- **第 8 章（KV cache）** 的 block manager 在每个 TP rank 上保持一致，因为调度器
  在 driver worker 广播；
- **第 11 章（KV connector）** 中的 PD 解耦构建在 PP / DP 拓扑之上。

外部参考：

- Megatron-LM `parallel_state.py`（vLLM 的设计原型）
- DeepSpeed Inference paper（PP + TP 联合）
- DeepEP 论文（`deepep_high_throughput` / `deepep_low_latency` 的来源）
- NCCL programming guide（理解 all-reduce / all-gather / reduce-scatter）
