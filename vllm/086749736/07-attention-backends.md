# 第 7 章 Attention Backends

本章解释 vLLM V1 是如何把"PagedAttention 计算"做成一个**多后端可插拔**子系统的：
统一的抽象层（基类、metadata、builder）位于 `vllm/v1/attention/backend.py`，
而每个具体后端（FlashAttention、FlashInfer、Triton、FlexAttention、MLA、Mamba 等）
被收敛到 `vllm/v1/attention/backends/` 下的一个文件或子包。模型代码只跟
`vllm/model_executor/layers/attention/attention.py:Attention` 这一个 `nn.Module`
打交道，剩下的"挑后端 → 构造 metadata → 调 kernel → 写回 KV cache"
全部由抽象层负责。

> 本章只覆盖 V1。`vllm/attention/` 在 V1 时代已经被移除——本仓库没有这个目录。
> 所有 attention 相关入口都集中在 `vllm/v1/attention/` 与
> `vllm/model_executor/layers/attention/`。

---

## 7.1 目录全景

```
vllm/v1/attention/
├── __init__.py
├── backend.py                       基类（AttentionBackend / AttentionImpl /
│                                    AttentionMetadataBuilder / CommonAttentionMetadata）
├── selector.py                      get_attn_backend()：根据 hw/dtype/flag 选后端
├── backends/
│   ├── registry.py                  AttentionBackendEnum 与 register_backend()
│   ├── utils.py                     PerLayerParameters、split_decodes_and_prefills 等共享工具
│   ├── fa_utils.py                  vllm_flash_attn 的版本检测与符号导入
│   ├── flash_attn.py                FlashAttention (FA2/FA3/FA4)
│   ├── flash_attn_diffkv.py         不同 K/V 头尺寸的 FA 变体
│   ├── flashinfer.py                FlashInfer（含 TRT-LLM-Gen）
│   ├── triton_attn.py               自研 Triton unified attention
│   ├── flex_attention.py            torch.nn.attention.flex_attention
│   ├── turboquant_attn.py           TurboQuant KV cache
│   ├── cpu_attn.py                  CPU 后端（IPEX / oneDNN）
│   ├── rocm_attn.py                 ROCm 通用
│   ├── rocm_aiter_fa.py             ROCm AITER FA
│   ├── rocm_aiter_unified_attn.py   ROCm AITER 统一 attention
│   ├── mamba1_attn.py               Mamba1
│   ├── mamba2_attn.py               Mamba2
│   ├── mamba_attn.py                Mamba 通用基类
│   ├── short_conv_attn.py           Short conv
│   ├── linear_attn.py               Linear attention
│   ├── gdn_attn.py                  GDN（Gated DeltaNet）
│   └── mla/                         DeepSeek-V2/V3 MLA 家族
│       ├── flashattn_mla.py         FA-MLA
│       ├── flashinfer_mla.py        FlashInfer-MLA
│       ├── flashinfer_mla_sparse.py FlashInfer 稀疏 MLA
│       ├── triton_mla.py            Triton-MLA (MLACommonBackend 默认 name)
│       ├── flashmla.py              FlashMLA (DeepSeek 官方)
│       ├── flashmla_sparse.py       FlashMLA sparse
│       ├── cutlass_mla.py           Cutlass-MLA (SM10x)
│       ├── tokenspeed_mla.py        Tokenspeed-MLA
│       ├── aiter_triton_mla.py      ROCm AITER+Triton MLA
│       ├── rocm_aiter_mla.py        ROCm AITER MLA
│       ├── rocm_aiter_mla_sparse.py / rocm_aiter_mla_sparse_dsv4.py
│       ├── xpu_mla_sparse.py        XPU sparse MLA
│       ├── indexer.py / sparse_*.py 稀疏 MLA 辅助
│       └── prefill/                 MLA prefill 子后端（FA/FlashInfer/TRTLLM-ragged 三选一）
└── ops/                             Triton / 复用 kernel 实现
    ├── triton_unified_attention.py  统一 prefill+decode kernel（被 TritonAttentionBackend 调）
    ├── triton_decode_attention.py / triton_prefill_attention.py
    ├── triton_reshape_and_cache_flash.py
    ├── chunked_prefill_paged_decode.py
    ├── flashmla.py
    ├── merge_attn_states.py / triton_merge_attn_states.py
    ├── common.py / dcp_alltoall.py  DCP（decode context parallel）拼合
    ├── paged_attn.py                Python 包装 csrc/attention 中的 v1/v2 kernel
    └── vit_attn_wrappers.py

vllm/model_executor/layers/attention/
├── attention.py                     Attention（标准 dense）
├── mla_attention.py                 MLAAttention + MLACommonBackend/Impl/Metadata
├── cross_attention.py               CrossAttention（encoder→decoder cross）
├── encoder_only_attention.py        EncoderOnlyAttention
├── chunked_local_attention.py       ChunkedLocalAttention（Llama 4 局部 chunk）
├── static_sink_attention.py         StaticSinkAttention（Sink 风格）
├── mm_encoder_attention.py          多模态 encoder
└── kv_transfer_utils.py             P/D disagg KV 流转辅助

csrc/attention/                      vLLM 自研 PagedAttention CUDA kernel
├── paged_attention_v1.cu            decode-only PA v1（小 seq）
├── paged_attention_v2.cu            split-KV decode PA v2（长 seq）
├── attention_kernels.cuh            主模板
├── attention_generic.cuh / attention_utils.cuh
├── dtype_{float16,bfloat16,float32,fp8}.cuh
├── merge_attn_states.cu             把 split-KV 的两段 lse+out 合并
└── vertical_slash_index.cu          稀疏 attention 索引构造
```

vLLM 还 vendor 了 FlashAttention 源码，作为 `vllm.vllm_flash_attn` 包随发行版本一起发布。
`flash_attn.py` 直接通过 `from vllm.vllm_flash_attn import flash_attn_varlen_func`
调用它（见 `vllm/v1/attention/backends/fa_utils.py:20`）。

### 7.1.1 后端清单（注册表）

所有可用后端在 `vllm/v1/attention/backends/registry.py:34` 的 `AttentionBackendEnum`
里登记，其字符串值就是该后端类的全限定路径。摘要如下（路径已省略，详见
`registry.py:44-90`）：

| 枚举名 | 用途 |
|---|---|
| `FLASH_ATTN` | NVIDIA GPU 默认后端（FA2/FA3/FA4 由设备能力自动选） |
| `FLASH_ATTN_DIFFKV` | K/V 头尺寸不同的 FA 变体 |
| `TRITON_ATTN` | 自研 Triton kernel；XPU/ROCm 与某些 quant 路径首选 |
| `FLASHINFER` | FlashInfer，含可选 TRT-LLM-Gen 后端（Hopper/Blackwell FP8/FP4） |
| `FLEX_ATTENTION` | 基于 PyTorch FlexAttention 的实验性后端（最灵活，支持 batch invariance） |
| `TURBOQUANT` | TurboQuant 量化 KV cache 专用 |
| `ROCM_ATTN` / `ROCM_AITER_FA` / `ROCM_AITER_UNIFIED_ATTN` | AMD GPU 三条路径 |
| `CPU_ATTN` | CPU 后端 |
| `FLASHMLA` / `FLASHMLA_SPARSE` | DeepSeek 官方 FlashMLA |
| `FLASH_ATTN_MLA` | FA-based MLA |
| `FLASHINFER_MLA` / `FLASHINFER_MLA_SPARSE` | FlashInfer MLA |
| `TRITON_MLA` | Triton MLA（也是 MLACommonBackend 的默认 `get_name`） |
| `CUTLASS_MLA` | Cutlass MLA |
| `TOKENSPEED_MLA` | Tokenspeed MLA |
| `ROCM_AITER_MLA` / `ROCM_AITER_TRITON_MLA` / `ROCM_AITER_MLA_SPARSE` | ROCm MLA 三档 |
| `XPU_MLA_SPARSE` | XPU sparse MLA |
| `NO_ATTENTION` | 占位（如 BERT 风格无 KV cache） |
| `TORCH_SDPA` | 仅用于 ViT 标签 |
| `CUSTOM` | 第三方注册（必须 `register_backend` 后才能用） |

Mamba 系列单独走 `MambaAttentionBackendEnum`（`registry.py:136`）：
`MAMBA1`、`MAMBA2`、`SHORT_CONV`、`LINEAR`、`GDN_ATTN`，避免与"真正的 attention"
后端混在一起，因为这些状态空间模型没有 KV cache 的概念。

枚举值是可覆盖的——`register_backend(AttentionBackendEnum.FLASH_ATTN, "my.module.MyFA")`
就能把默认实现替掉，方便测试或私有 fork（`registry.py:203`）。

### 7.1.2 为什么要做这一层抽象

1. **硬件碎片化**：FA 在 SM80+ 上跑，FA3 只在 Hopper，FA4 只在 Blackwell；
   FlashInfer 覆盖 SM75-12.x；MLA 必须用专门的 kernel 才能拿到 latent KV 的速度。
   没有这层抽象，模型代码会被 `if device == ...` 淹没。
2. **特性矩阵很宽**：causal/非 causal、sliding window、ALiBi、sinks、cascade、
   speculative decode、DCP/PCP、prefix caching、各种 FP8/FP4 KV cache……
   把"我支不支持这个组合"封装到后端类的 classmethod（`supports_*`）里，
   selector 就能做声明式选择。
3. **CUDA Graph 兼容性**：不同 kernel 对 CUDA Graph 的支持程度不同
   （见 `AttentionCGSupport` 四档），需要每个后端自己声明，否则上层调度器
   无法决定 piecewise vs full CG 策略。
4. **Metadata 复用**：每一步都要算的 `block_table`、`slot_mapping`、`query_start_loc`
   等被抽到 `CommonAttentionMetadata`，model runner 只构造一次，后端在 `build()`
   里按需"特化"成自己的 `XxxAttentionMetadata`。

---

## 7.2 后端选择逻辑

入口是 `vllm/v1/attention/selector.py:52` 的 `get_attn_backend(...)`：

```python
def get_attn_backend(
    head_size: int, dtype: torch.dtype, kv_cache_dtype: str | None,
    use_mla: bool = False, has_sink: bool = False, use_sparse: bool = False,
    use_mm_prefix: bool = False, use_per_head_quant_scales: bool = False,
    attn_type: str | None = None, num_heads: int | None = None,
) -> type[AttentionBackend]:
    ...
    return _cached_get_attn_backend(
        backend=vllm_config.attention_config.backend,
        attn_selector_config=attn_selector_config,
        num_heads=num_heads,
    )
```

它做三件事：

1. **打包请求**：把入参 + 全局 `vllm_config` 里的 `use_non_causal`、
   `envs.VLLM_BATCH_INVARIANT` 等组装成 `AttentionSelectorConfig`
   （`selector.py:21`）。这个 NamedTuple 是 hashable 的，方便 `@cache`。
2. **委托给平台层**：`current_platform.get_attn_backend_cls(backend, ...)`
   （`selector.py:113`）返回一个**字符串路径**（不是类本身——为了延迟 import，
   避免装 vLLM 时强依赖 FlashInfer 等可选包）。
3. **解析并校正 KV cache layout**：`resolve_obj_by_qualname` 拿到类后，
   如果后端 `get_required_kv_cache_layout()` 返回 `"NHD"` 或 `"HND"`，
   就 `set_kv_cache_layout()` 全局覆盖（`selector.py:124`）——例如 FlashInfer
   在 SM10x 强制 HND（`flashinfer.py:429`）。

`_cached_get_attn_backend` 是 `@cache` 的——同样配置不会重复跑 selector。

### 7.2.1 每个后端"我支持什么"

`AttentionBackend` 暴露一组 classmethod 给 selector 用
（`vllm/v1/attention/backend.py:55`-`254`）：

| classmethod | 含义 | 默认 |
|---|---|---|
| `supported_dtypes` | Q/K/V 激活 dtype 白名单 | `[fp16, bf16]` |
| `supported_kv_cache_dtypes` | KV cache dtype 白名单 | `[auto, fp16, bf16]` |
| `supports_head_size(int)` | 该 kernel 编译过哪些 head_size | 通过 `get_supported_head_sizes` |
| `get_supported_kernel_block_sizes()` | block_size 必须是这些值或倍数 | `[MultipleOf(1)]` |
| `is_mla()` | 是否是 MLA 系列 | `False` |
| `is_sparse()` | 是否是稀疏 attention | `False` |
| `supports_sink()` / `supports_alibi_sqrt()` / `supports_mm_prefix()` | 特性开关 | `False` |
| `supports_non_causal()` | 双向 attention（无 KV cache 也走 decoder 接口） | `False` |
| `supports_batch_invariance()` | 是否能跑 batch-invariant 模式 | `False` |
| `supports_compute_capability(cap)` | 设备能力门槛 | 全部支持 |
| `supports_attn_type(attn_type)` | 仅 decoder 还是含 encoder/encoder_decoder | 仅 decoder |
| `supports_combination(...)` | 多维度组合的自由门 | `None`（通过） |

`validate_configuration()`（`backend.py:271`）把以上检查串成一个列表——
selector 在多个候选后端里挑出"无 invalid_reason"且优先级最高的那一个。

<svg viewBox="0 0 760 410" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="attention backend selector 的解析流程">
  <defs>
    <marker id="ar71" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(230, 14)">
    <rect x="0" y="0" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="150" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">get_attn_backend(head_size, dtype, …)</text>
    <text x="150" y="32" text-anchor="middle" font-size="10" fill="#64748b">selector.py:52　模型层公共入口</text>
  </g>
  <line x1="380" y1="54" x2="380" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <g transform="translate(150, 78)">
    <rect x="0" y="0" width="460" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="230" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">current_platform.get_attn_backend_cls(backend_hint, selector_cfg)</text>
    <text x="230" y="36" text-anchor="middle" font-size="10" fill="#64748b">@cache：相同 AttentionSelectorConfig 不会重复解析</text>
    <text x="230" y="50" text-anchor="middle" font-size="10" fill="#7c3aed">返回字符串路径（延迟 import，避免硬依赖 FlashInfer/MLA）</text>
  </g>
  <line x1="380" y1="134" x2="380" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <g transform="translate(40, 158)">
    <rect x="0" y="0" width="680" height="130" rx="6" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="4,3"/>
    <text x="14" y="18" font-size="11" font-weight="700" fill="#7c3aed">CudaPlatform.get_attn_backend_cls 的决策树（其它平台同模式）</text>
    <g transform="translate(14, 28)">
      <rect x="0" y="0" width="200" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="100" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">use_mla?</text>
      <text x="100" y="34" text-anchor="middle" font-size="9" fill="#64748b">→ MLA 子树（FlashMLA / …）</text>
      <rect x="216" y="0" width="200" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
      <text x="316" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">backend hint 给了？</text>
      <text x="316" y="34" text-anchor="middle" font-size="9" fill="#64748b">→ enum.get_path() 直选</text>
      <rect x="432" y="0" width="220" height="44" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="542" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">否则按优先级遍历候选</text>
      <text x="542" y="34" text-anchor="middle" font-size="9" fill="#64748b">cls.validate_configuration(...)</text>
    </g>
    <text x="340" y="98" text-anchor="middle" font-size="10" fill="#64748b">每个候选 backend 用 supports_dtypes / supports_compute_capability /</text>
    <text x="340" y="112" text-anchor="middle" font-size="10" fill="#64748b">supports_combination 等 classmethod 自报"我能不能跑这个组合"</text>
  </g>
  <line x1="380" y1="288" x2="380" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <g transform="translate(120, 310)">
    <rect x="0" y="0" width="520" height="40" rx="6" fill="#fef3c7" stroke="#facc15" stroke-width="1.5"/>
    <text x="260" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">字符串路径："vllm.v1.attention.backends.flash_attn.FlashAttentionBackend"</text>
    <text x="260" y="32" text-anchor="middle" font-size="10" fill="#a16207">resolve_obj_by_qualname → 拿到真正的类</text>
  </g>
  <line x1="380" y1="350" x2="380" y2="368" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar71)"/>
  <g transform="translate(140, 370)">
    <rect x="0" y="0" width="480" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="240" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">backend.get_required_kv_cache_layout() → set_kv_cache_layout()</text>
    <text x="240" y="30" text-anchor="middle" font-size="10" fill="#64748b">如 FlashInfer 在 SM10x 强制 HND；selector 全局生效</text>
  </g>
</svg>
<span class="figure-caption">图 R7.1 ｜ get_attn_backend 的解析链：模型入口 → 平台决策树 → 字符串路径 → resolve_obj_by_qualname → 全局 KV cache layout。延迟 import 是为了避免 vLLM 装包时硬依赖 FlashInfer 等可选库。</span>

<details>
<summary>ASCII 原版</summary>

```text
get_attn_backend()
    │
    ▼
current_platform.get_attn_backend_cls(backend=hint, selector_cfg)
    │ 例如 CudaPlatform：
    │   if use_mla → 走 mla 选择子树（FlashMLA / FlashInferMLA / FlashAttnMLA …）
    │   elif backend hint 给了 → 直接 enum.get_path()
    │   else: 按优先级遍历 candidate，每个 backend
    │         调 cls.validate_configuration(selector_cfg) 看是否过关
    │
    ▼
返回 "vllm.v1.attention.backends.flash_attn.FlashAttentionBackend"
    │
    ▼
resolve_obj_by_qualname → 真正的类
    │
    ▼
后端的 get_required_kv_cache_layout() 决定 KV cache 物理布局
```

</details>

设备能力到默认后端的粗略映射（CUDA 平台）：

```
SM 7.5 ~ 8.x  → FLASH_ATTN(FA2) 或 FLASHINFER
SM 9.0 (H100) → FLASH_ATTN(FA3) 默认；DeepSeek 时 FLASHMLA / FLASH_ATTN_MLA
SM 10.0+ (B200) → FLASH_ATTN(FA4) / FLASHINFER + TRT-LLM-Gen / CUTLASS_MLA
ROCm          → ROCM_AITER_FA / ROCM_AITER_UNIFIED_ATTN
XPU           → TRITON_ATTN（含 tensor descriptor 优化）
CPU           → CPU_ATTN（IPEX/oneDNN）
```

具体选择函数在每个 `vllm/platforms/*.py` 里，本章不再展开（参考
`vllm/platforms/cuda.py` 中 `get_attn_backend_cls`）。

---

## 7.3 AttentionMetadata 抽象

### 7.3.1 `CommonAttentionMetadata`：模型 runner 一份，全后端共享

`vllm/v1/attention/backend.py:352` 定义：

```python
@dataclass
class CommonAttentionMetadata:
    query_start_loc: torch.Tensor      # (B+1,) GPU
    query_start_loc_cpu: torch.Tensor  # (B+1,) CPU 镜像
    seq_lens: torch.Tensor             # (B,)   已计算 token 数
    num_reqs: int
    num_actual_tokens: int             # 本 step 总 token 数（≈ Σ query_len）
    max_query_len: int
    max_seq_len: int                   # 上界即可
    block_table_tensor: torch.Tensor   # (B, max_blocks_per_req) 逻辑→物理映射
    slot_mapping: torch.Tensor         # (num_actual_tokens,) 每个 new token 的 KV 槽位
    causal: bool = True
    logits_indices_padded: torch.Tensor | None = None   # FastPrefill 用
    num_logits_indices: int | None = None
    encoder_seq_lens: torch.Tensor | None = None        # CrossAttention 用
    encoder_seq_lens_cpu: np.ndarray | None = None
    dcp_local_seq_lens: torch.Tensor | None = None      # decode context parallel
    dcp_local_seq_lens_cpu: torch.Tensor | None = None
    positions: torch.Tensor | None = None               # DeepSeek-V4 topk 索引用
    is_prefilling: torch.Tensor | None = None           # 区分真 decode 与 short extend
    seq_lens_cpu_upper_bound: torch.Tensor | None = None
    # 已废弃字段（v0.15 移除）：_seq_lens_cpu / _num_computed_tokens_cpu
```

GPU runner 在 `execute_model` 里只构造一次这个对象，然后把它扔给每一个 kv-cache
group 的 builder——同一个 batch 同一个 step 共用。

#### 几个关键字段

```
query_start_loc:    [0, q0, q0+q1, ..., total_q]    形状 (B+1,)
seq_lens:           [s0, s1, ..., s_{B-1}]          已计算的 token 数（含本次 query）
                    s_i = num_computed + query_len_i

block_table:        每个 req 的逻辑 block → 物理 block 索引
  req 0:  [13, 7,  9, ...]
  req 1:  [22, 4, ...]
  ...

slot_mapping:       本 step 写 KV 的全局槽位，长度 = num_actual_tokens
  token0 → physical_block * block_size + offset
  token1 → ...
```

`block_table_tensor` 是 PagedAttention kernel 走 KV 的关键：kernel 拿
`block_table[req, k_logical // block_size]` 取到物理块号，再加
`k_logical % block_size` 得到位置。

`slot_mapping` 与 `block_table` 配对：写时用 `slot_mapping` 直接定位线性槽位
（`reshape_and_cache_flash` 等内核），读时用 `block_table` 跳页。

### 7.3.2 各后端的特化

`CommonAttentionMetadata` 不是 attention kernel 直接吃的对象。每个后端的
`AttentionMetadataBuilder.build()` 把它"翻译"成自己专属的 dataclass。最典型的
是 `FlashAttentionMetadata`（`vllm/v1/attention/backends/flash_attn.py:222`）：

```python
@dataclass
class FlashAttentionMetadata:
    num_actual_tokens: int
    max_query_len: int
    query_start_loc: torch.Tensor
    max_seq_len: int
    seq_lens: torch.Tensor
    block_table: torch.Tensor
    slot_mapping: torch.Tensor

    # cascade（共享前缀的 prefix-caching 加速）
    use_cascade: bool
    common_prefix_len: int
    cu_prefix_query_lens: torch.Tensor | None
    prefix_kv_lens: torch.Tensor | None
    suffix_kv_lens: torch.Tensor | None

    # DCP（GQA decode context parallel）
    max_dcp_context_kv_len: int | None = None
    dcp_context_kv_lens: torch.Tensor | None = None

    # FA3 AOT scheduler 状态
    scheduler_metadata: torch.Tensor | None = None
    prefix_scheduler_metadata: torch.Tensor | None = None
    max_num_splits: int = 0

    causal: bool = True
```

而 MLA 后端用结构嵌套的 `MLACommonMetadata`
（`vllm/model_executor/layers/attention/mla_attention.py:1250`）：

```python
@dataclass
class MLACommonMetadata(AttentionMetadata, Generic[D]):
    num_reqs: int
    max_query_len: int
    max_seq_len: int
    num_actual_tokens: int
    query_start_loc: torch.Tensor
    slot_mapping: torch.Tensor

    # MLA 专属：prefill/decode 分裂
    num_decodes: int
    num_decode_tokens: int
    num_prefills: int

    head_dim: int | None = None
    prefill: MLACommonPrefillMetadata | None = None     # 走 MHA 路径
    decode:  D | None = None                            # 走 MQA 路径（带 latent）
```

为什么 MLA 要这样切？因为 MLA 在 prefill 阶段（Sq/Skv 比较接近）走"计算友好"的
MHA 路径，在 decode 阶段（Sq=1）走"数据搬运友好"的 MQA 路径，两个 kernel 完全
不同，需要分别 metadata。具体见 `mla_attention.py` 文件头的长注释（行 1-104）。

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="CommonAttentionMetadata 经各 backend builder 特化为后端专属 metadata">
  <defs>
    <marker id="ar72" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(280, 14)">
    <rect x="0" y="0" width="320" height="64" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="160" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">CommonAttentionMetadata</text>
    <text x="160" y="38" text-anchor="middle" font-size="10" fill="#64748b">model runner 每 step 构造一次</text>
    <text x="160" y="52" text-anchor="middle" font-size="10" fill="#64748b">所有 KV cache group 共享</text>
  </g>
  <line x1="440" y1="78" x2="120" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="440" y1="78" x2="316" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="440" y1="78" x2="440" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="440" y1="78" x2="564" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <line x1="440" y1="78" x2="760" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(20, 144)">
    <rect x="0" y="0" width="200" height="42" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="100" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FlashAttention</text>
    <text x="100" y="32" text-anchor="middle" font-size="9" fill="#64748b">Builder.build()</text>
  </g>
  <line x1="120" y1="186" x2="120" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(20, 206)">
    <rect x="0" y="0" width="200" height="78" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-dasharray="3,2"/>
    <text x="100" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">FlashAttentionMetadata</text>
    <text x="100" y="32" text-anchor="middle" font-size="9" fill="#64748b">cascade（共享前缀）</text>
    <text x="100" y="46" text-anchor="middle" font-size="9" fill="#64748b">DCP context</text>
    <text x="100" y="60" text-anchor="middle" font-size="9" fill="#64748b">scheduler_metadata（FA3 AOT）</text>
    <text x="100" y="74" text-anchor="middle" font-size="9" fill="#64748b">max_num_splits</text>
  </g>
  <g transform="translate(232, 144)">
    <rect x="0" y="0" width="168" height="42" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="84" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FlashInfer</text>
    <text x="84" y="32" text-anchor="middle" font-size="9" fill="#64748b">Builder.build()</text>
  </g>
  <line x1="316" y1="186" x2="316" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(232, 206)">
    <rect x="0" y="0" width="168" height="78" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-dasharray="3,2"/>
    <text x="84" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">FlashInferMetadata</text>
    <text x="84" y="32" text-anchor="middle" font-size="9" fill="#64748b">FIPrefill + FIDecode</text>
    <text x="84" y="46" text-anchor="middle" font-size="9" fill="#64748b">或</text>
    <text x="84" y="60" text-anchor="middle" font-size="9" fill="#64748b">TRTLLMPrefill +</text>
    <text x="84" y="74" text-anchor="middle" font-size="9" fill="#64748b">TRTLLMDecode wrapper</text>
  </g>
  <g transform="translate(412, 144)">
    <rect x="0" y="0" width="140" height="42" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="70" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Triton</text>
    <text x="70" y="32" text-anchor="middle" font-size="9" fill="#64748b">Builder.build()</text>
  </g>
  <line x1="482" y1="186" x2="482" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(412, 206)">
    <rect x="0" y="0" width="140" height="78" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-dasharray="3,2"/>
    <text x="70" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">TritonAttentionMetadata</text>
    <text x="70" y="34" text-anchor="middle" font-size="9" fill="#64748b">softmax_segm_output</text>
    <text x="70" y="48" text-anchor="middle" font-size="9" fill="#64748b">softmax_segm_max</text>
    <text x="70" y="62" text-anchor="middle" font-size="9" fill="#64748b">softmax_segm_expsum</text>
    <text x="70" y="74" text-anchor="middle" font-size="9" fill="#94a3b8">（split-K 累积）</text>
  </g>
  <g transform="translate(564, 144)">
    <rect x="0" y="0" width="140" height="42" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="70" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FlexAttention</text>
    <text x="70" y="32" text-anchor="middle" font-size="9" fill="#64748b">Builder.build()</text>
  </g>
  <line x1="634" y1="186" x2="634" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(564, 206)">
    <rect x="0" y="0" width="140" height="78" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-dasharray="3,2"/>
    <text x="70" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">FlexAttentionMetadata</text>
    <text x="70" y="34" text-anchor="middle" font-size="9" fill="#64748b">BlockSparsityHint</text>
    <text x="70" y="48" text-anchor="middle" font-size="9" fill="#64748b">逻辑↔物理映射</text>
    <text x="70" y="62" text-anchor="middle" font-size="9" fill="#64748b">mask_mod / score_mod</text>
  </g>
  <g transform="translate(716, 144)">
    <rect x="0" y="0" width="140" height="42" rx="4" fill="#fed7aa" stroke="#ea580c"/>
    <text x="70" y="18" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">MLACommon</text>
    <text x="70" y="32" text-anchor="middle" font-size="9" fill="#64748b">Builder.build()</text>
  </g>
  <line x1="786" y1="186" x2="786" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar72)"/>
  <g transform="translate(716, 206)">
    <rect x="0" y="0" width="140" height="78" rx="4" fill="#fff7ed" stroke="#ea580c" stroke-dasharray="3,2"/>
    <text x="70" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">MLACommonMetadata[D]</text>
    <text x="70" y="34" text-anchor="middle" font-size="9" fill="#64748b">prefill: MLACommonPrefill</text>
    <text x="70" y="48" text-anchor="middle" font-size="9" fill="#64748b">decode: D（latent kernel）</text>
    <text x="70" y="62" text-anchor="middle" font-size="9" fill="#94a3b8">两段分裂 metadata</text>
  </g>
  <text x="440" y="320" text-anchor="middle" font-size="11" fill="#64748b">每个 backend 把通用字段「特化」成自己 kernel 真正吃的 dataclass</text>
  <text x="440" y="338" text-anchor="middle" font-size="10" fill="#94a3b8">FA 走单 kernel；FlashInfer / MLA 把 prefill 与 decode 分开喂；Flex 暴露 mask 钩子</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ CommonAttentionMetadata 经各后端 Builder.build() 翻译成专属 metadata：FA 单 kernel 携带 cascade/DCP；FlashInfer/MLA 走 prefill+decode 双 wrapper；Triton 多带 split-K 累积 buffer；Flex 暴露 mask 钩子。</span>

<details>
<summary>ASCII 原版</summary>

```
CommonAttentionMetadata
        │
        ├── FlashAttentionMetadataBuilder.build()
        │        └── FlashAttentionMetadata  (cascade / DCP / scheduler_metadata)
        │
        ├── FlashInferMetadataBuilder.build()
        │        └── FlashInferMetadata  (FIPrefill+FIDecode 或 TRTLLMPrefill+TRTLLMDecode wrapper)
        │
        ├── TritonAttentionMetadataBuilder.build()
        │        └── TritonAttentionMetadata  (softmax_segm_* 三个 split-K 缓冲)
        │
        ├── FlexAttentionMetadataBuilder.build()
        │        └── FlexAttentionMetadata  (BlockSparsityHint / 逻辑↔物理映射)
        │
        └── MLACommonMetadataBuilder.build()
                 └── MLACommonMetadata[D]  (decode/prefill 分裂)
```

</details>

### 7.3.3 Builder 基类

```python
class AttentionMetadataBuilder(ABC, Generic[M]):
    _cudagraph_support: ClassVar[AttentionCGSupport] = AttentionCGSupport.NEVER
    reorder_batch_threshold: int | None = None
    supports_update_block_table: bool = False

    def __init__(self, kv_cache_spec, layer_names, vllm_config, device): ...

    @abstractmethod
    def build(self, common_prefix_len: int,
              common_attn_metadata: CommonAttentionMetadata,
              fast_build: bool = False) -> M: ...

    def build_for_cudagraph_capture(self, cm): ...
    def build_for_drafting(self, cm, draft_index): ...
    def update_block_table(self, metadata, blk_table, slot_mapping): ...
    def use_cascade_attention(self, ...): return False
```

`AttentionCGSupport`（`backend.py:499`）四档：

| 值 | 含义 |
|---|---|
| `ALWAYS` | 任意 batch（含混合 prefill+decode）都能进 CG |
| `UNIFORM_BATCH` | batch 内 query 长度必须一致（用于 spec-decode 的 1+k） |
| `UNIFORM_SINGLE_TOKEN_DECODE` | 仅纯 decode (`query_len=1`) 能进 CG |
| `NEVER` | 不进 CG |

V1 调度器靠这个枚举决定要不要给该层捕获 full CUDA Graph 还是回落到 piecewise。

`reorder_batch_threshold`：某些后端（特别是 MLA、FlashMLA）希望 batch 是
"decode 段在前、prefill 段在后"，于是上层会调用
`reorder_batch_to_split_decodes_and_prefills`（`utils.py:606`）按 threshold
把短 query 推到前面。

---

## 7.4 FlashAttention 后端（默认）

文件：`vllm/v1/attention/backends/flash_attn.py`（1223 行）。
导入 `vllm.vllm_flash_attn`——vLLM 把 FlashAttention 源码 vendored 进自己的
build，发行版自带 FA2、FA3、FA4（按设备能力编译）。

### 7.4.1 后端类

```python
class FlashAttentionBackend(AttentionBackend):
    supported_dtypes = [torch.float16, torch.bfloat16]
    supported_kv_cache_dtypes = ["auto", "float16", "bfloat16"]   # fp8 仅 FA3+H100
    forward_includes_kv_cache_update: bool = False                # 见 7.4.4

    @staticmethod
    def get_kv_cache_shape(num_blocks, block_size, num_kv_heads, head_size, ...):
        # (K|V split, num_blocks, block_size, num_kv_heads, head_size)
        return (2, num_blocks, block_size, num_kv_heads, head_size)

    @classmethod
    def supports_compute_capability(cls, capability):
        return capability >= DeviceCapability(8, 0)
```

`get_kv_cache_shape` 是关键约定——KV cache 内存按 `(2, B, S, H, D)` 申请
（`flash_attn.py:140`）。后端的 `forward()` 拿到 `kv_cache.unbind(0)`
就能拆出 `key_cache` 和 `value_cache`。

`get_kv_cache_stride_order`（`flash_attn.py:152`）决定物理 layout：FA 支持 NHD
与 HND 两种 stride 排列，由 `set_kv_cache_layout()` 全局选择。

### 7.4.2 Builder 与 AOT scheduler

`FlashAttentionMetadataBuilder.build()`（`flash_attn.py:388`）的核心是调用
`get_scheduler_metadata`：FA3 在 Hopper 上引入了 ahead-of-time scheduler，
预先在 host 端算出每个 SM 拿到哪些 (block, query) 工作单元，把这个
"调度元信息" 当作普通 tensor 传给 kernel，能省下 kernel 启动时的动态分发开销。
这就是 `scheduler_metadata: torch.Tensor | None` 字段的意义。

`_cudagraph_support`：FA3 给 `ALWAYS`，FA2 给 `UNIFORM_BATCH`
（`flash_attn.py:295`，因为 FA2 对 `max_query_len=1` 的 packed-GQA 有特殊路径）。

### 7.4.3 Forward：prefill + decode 走同一个 kernel

```python
# flash_attn.py:667
def forward(self, layer, query, key, value, kv_cache, attn_metadata, output, ...):
    # 1) encoder-only/encoder：旁路（不进 KV cache）
    if attn_type in (ENCODER_ONLY, ENCODER):
        return self._forward_encoder_attention(...)

    # 2) 拆 KV cache
    key_cache, value_cache = kv_cache.unbind(0)
    key_cache = canonicalize_singleton_dim_strides(key_cache)   # H100 TMA 16B 对齐
    value_cache = canonicalize_singleton_dim_strides(value_cache)

    # 3) cascade（共享前缀）走另一条路
    if not attn_metadata.use_cascade:
        flash_attn_varlen_func(
            q=query[:num_actual_tokens],
            k=key_cache, v=value_cache, out=output[:num_actual_tokens],
            cu_seqlens_q=attn_metadata.query_start_loc,
            max_seqlen_q=attn_metadata.max_query_len,
            seqused_k=attn_metadata.seq_lens,
            max_seqlen_k=attn_metadata.max_seq_len,
            softmax_scale=self.scale,
            causal=attn_metadata.causal,
            window_size=list(self.sliding_window),     # GQA sliding 也走这里
            block_table=attn_metadata.block_table,
            softcap=self.logits_soft_cap,
            scheduler_metadata=attn_metadata.scheduler_metadata,   # FA3 AOT
            fa_version=self.vllm_flash_attn_version,
            q_descale=q_descale, k_descale=k_descale, v_descale=v_descale,
            num_splits=attn_metadata.max_num_splits,
            s_aux=self.sinks,                          # attention sink
        )
        return output
    cascade_attention(...)   # rare：>1 个 req 共享公共前缀
```

注意 vLLM 的 FA 路径**把 prefill 和 decode 全部走 varlen kernel**——
prefill 是 query_len > 1，decode 是 query_len = 1，通过 `cu_seqlens_q`
把变长 query 拼起来，统一一次 kernel 调用，避免分支也方便 CUDA Graph。

### 7.4.4 KV cache 写入分离：`forward_includes_kv_cache_update = False`

`FlashAttentionBackend.forward_includes_kv_cache_update = False`
（`flash_attn.py:96`）表示 kernel 本身**不**负责写 KV cache。
写入由独立调用 `do_kv_cache_update` 触发：

```python
# flash_attn.py:850
def do_kv_cache_update(self, layer, key, value, kv_cache, slot_mapping):
    key_cache, value_cache = kv_cache.unbind(0)
    reshape_and_cache_flash(
        key, value, key_cache, value_cache, slot_mapping,
        self.kv_cache_dtype, layer._k_scale, layer._v_scale,
    )
```

这种分离让 `torch.compile` 可以**把 KV 写入与 attention 调用建模成两个独立的
custom op**——参考 `vllm/model_executor/layers/attention/attention.py:491`
里的 `kv_cache_dummy_dep`：

```python
if not self.attn_backend.forward_includes_kv_cache_update and ...:
    kv_cache_dummy_dep = unified_kv_cache_update(key, value, self.layer_name)
unified_attention_with_output(query, key, value, output, self.layer_name,
                              kv_cache_dummy_dep=kv_cache_dummy_dep)
```

`kv_cache_dummy_dep` 不真使用，只是用作 op 间的 data dependency，让
`torch.compile` 在重排时保留正确顺序。

### 7.4.5 DCP（decode context parallel）

`_forward_with_dcp`（`flash_attn.py:885`）会把 query 在 dcp_group 里 all-gather，
对本地 KV 段算一次 attention 拿到 `(out, lse)`，再用 `merge_attn_states` 合并
全局结果——这是把 long context 的 KV 切到多张卡上做 decode 的关键。

---

## 7.5 FlashInfer 后端

文件：`vllm/v1/attention/backends/flashinfer.py`（1969 行，最大）。

```python
class FlashInferBackend(AttentionBackend):
    supported_kv_cache_dtypes = [
        "auto", "float16", "bfloat16",
        "fp8", "fp8_e4m3", "fp8_e5m2", "nvfp4",   # 比 FA 多 FP4
    ]
    @staticmethod
    def get_supported_kernel_block_sizes(): return [16, 32, 64]
    @classmethod
    def get_supported_head_sizes(cls): return [64, 128, 256]
    @classmethod
    def supports_compute_capability(cls, c):
        return DeviceCapability(7,5) <= c <= DeviceCapability(12,1)
```

### 7.5.1 与 FlashAttention 的区别

- **多 wrapper、状态化**：FlashInfer 是有"plan + run"两阶段 API 的库。
  vLLM 在 builder 里维护四种 wrapper（`flashinfer.py:439-498`）：
  - `FIPrefill` 用 `BatchPrefillWithPagedKVCacheWrapper`
  - `FIDecode` 用 `BatchDecodeWithPagedKVCacheWrapper`
  - `TRTLLMPrefill` / `TRTLLMDecode`：调 `trtllm_batch_*` 走 TRT-LLM-Gen kernel
- **prefill / decode 路径分离**：与 FA 不同，FlashInfer 在两条 wrapper 上跑，
  builder 用 `split_decodes_and_prefills`（`utils.py:507`）把 batch 切两段。
- **支持更广的 KV cache dtype**：FP8/FP4 在 Hopper 以上设备可用，且可以走
  TRT-LLM-Gen 拿到极致 latency。
- **强制 HND layout（SM10x）**：`get_required_kv_cache_layout()` 在 Blackwell
  返回 `"HND"`（`flashinfer.py:429`），selector 会全局 set。

### 7.5.2 何时挑 FlashInfer

V1 在 CUDA 平台的"自动模式"通常优先 FlashAttention；以下情况会跳到 FlashInfer：

- 设备能力在 FA 不支持的范围（如 Turing/Volta 上 head_size=256）。
- 需要 nvfp4 KV cache。
- 需要 TRT-LLM-Gen 路径（`use_trtllm_attention`）并且模型/形状被它支持
  （decode batch 必须 uniform、head_size 受限）。
- 用户显式 `--attention-config.backend FLASHINFER`。

---

## 7.6 Triton 后端

文件：`vllm/v1/attention/backends/triton_attn.py`。
依赖 `vllm/v1/attention/ops/triton_unified_attention.py` 里的 Triton kernel。

```python
class TritonAttentionBackend(AttentionBackend):
    forward_includes_kv_cache_update: bool = False
    @staticmethod
    def get_kv_cache_shape(num_blocks, block_size, num_kv_heads, head_size, ...):
        # 与 FA 不同：把 K/V 分量放在第二维
        return (num_blocks, 2, block_size, num_kv_heads, head_size)
```

### 7.6.1 适用场景

- **XPU**（Intel）：Triton 在 XPU 上有 tensor descriptor 优化路径（`use_td`，
  `triton_attn.py:506`），靠 HW 2D block read 拿性能。
- **ROCm**：作为 AITER 之外的备选。
- **Per-token-head 量化 KV cache**：`triton_attn.py:392`
  专门处理 `(num_blocks, 2, block_size, nkv, hs+pad)` 这种内嵌 float32 scale 的
  布局，FA 暂不支持。
- **Chunked attention with lookback**：`Attention.__init__` 里强制要求
  `chunk_lookback > -1` 时必须用 Triton（`attention.py:343`）。
- **批不变性（batch invariance）**：需要 deterministic 才有的"split=1"路径。

Kernel 入口 `unified_attention(...)` 同时支持 prefill 与 decode：
通过 `seq_threshold_3D` 决定 launch 2D（小 batch）还是 3D（大 batch）grid，
并用 `NUM_PAR_SOFTMAX_SEGMENTS=16` 段并行计算 softmax，三个
`softmax_segm_{output,max,expsum}` 是 split-K 的中间累积 buffer
（`triton_attn.py:55`）。

---

## 7.7 FlexAttention 后端

文件：`vllm/v1/attention/backends/flex_attention.py`（1269 行）。

```python
class FlexAttentionBackend(AttentionBackend):
    supported_dtypes = [torch.float16, torch.bfloat16, torch.float32]
    forward_includes_kv_cache_update: bool = False
    @classmethod
    def supports_non_causal(cls): return True
    @classmethod
    def supports_mm_prefix(cls): return True          # 多模态前缀全 attention
    @classmethod
    def supports_batch_invariance(cls): return True
    @staticmethod
    def get_kv_cache_shape(num_blocks, block_size, num_kv_heads, head_size, ...):
        return (2, num_blocks, block_size, num_kv_heads, head_size)
    @staticmethod
    def get_supported_kernel_block_sizes(): return [MultipleOf(16)]
```

基于 `torch.nn.attention.flex_attention`。它把 attention mask（causal、
sliding window、custom mask）用 score_mod / mask_mod 函数表达，
由 PyTorch inductor 编译出 fused kernel。

### 7.7.1 用途

- **最灵活**：支持任意自定义 mask（如 multimodal 中"图像 token 之间双向、
  文本 token causal"的混合 mask）。靠 `BlockSparsityHint`（`flex_attention.py:328`）
  给 mask_mod 提示稀疏结构。
- **批不变性**：FA/FlashInfer 都依赖 split-K，输出与 split 数有关；FlexAttention
  可以走 `block_m/block_n` 受控的路径拿确定性输出。
- **新硬件 day-0**：只要 PyTorch inductor 能编译，就能跑。
- **代价**：相对原生 FA 在常规场景慢 1.2-2x，主要作为 fallback / 研究后端。

builder 需要把 paged KV cache 的逻辑顺序展开成 inductor 友好的 mapping
（`physical_to_logical_mapping`，`flex_attention.py:148` 起的长注释展示了
逻辑块↔物理块的反向映射怎么处理 garbage padding 与 sliding window 复用）。

---

## 7.8 其它通用后端

### 7.8.1 TurboQuant：`turboquant_attn.py`

为 TurboQuant 量化 KV cache 设计——它要求每 slot 多带一个 `slot_size_aligned`
对齐量，KV cache 的 `(num_blocks, 2, block_size, num_kv_heads, head_size + ?)`
有额外的 scale 内嵌。模型里 `Attention.get_kv_cache_spec` 在
`kv_cache_dtype.startswith("turboquant_")` 时会返回 `TQFullAttentionSpec`
（`attention.py:585`），自动指向这个后端。

### 7.8.2 CPU：`cpu_attn.py`

走 IPEX / oneDNN paged attention，metadata 比较精简（无 cascade、无 DCP），
forward 时直接调 `torch.ops.vllm.cpu_paged_attention`。

### 7.8.3 ROCm

三种实现选择：

- `rocm_attn.py`：通用，兼容性好。
- `rocm_aiter_fa.py`：AMD AITER 库里的 FlashAttention port，1471 行的大文件，
  接口跟 vLLM FA 几乎一致。
- `rocm_aiter_unified_attn.py`：AITER 的统一 prefill+decode kernel。

### 7.8.4 `flash_attn_diffkv.py`

某些模型 K head 数与 V head 数不同（变体 GQA）。FA 默认假设两者一致，
此后端把它们解耦。

### 7.8.5 `no_attention`（registry 里的 `NO_ATTENTION`）

`vllm/v1/attention/backends/no_attention.py` 给那些 forward 完全不调 attention
（如某些 SSM 模型已经吃掉 attention 的 hybrid 架构）的占位用。

---

## 7.9 MLA 后端家族（DeepSeek）

MLA = Multi-head Latent Attention。DeepSeek V2/V3 把 KV 压缩到一个低维
latent（512 维 vs 传统 4096+），decode 阶段只缓存这个 latent + 64 维 RoPE，
极大减小 KV cache 内存与 bandwidth 需求。代价是计算形态变了——decode 必须
用专门 kernel。

所有 MLA 后端都继承 `MLACommonBackend`
（`vllm/model_executor/layers/attention/mla_attention.py:1166`）：

```python
class MLACommonBackend(AttentionBackend):
    @staticmethod
    def get_kv_cache_shape(num_blocks, block_size, num_kv_heads, head_size, ...):
        # num_kv_heads 永远是 1（latent 共享）
        return (num_blocks, block_size, head_size)
    @classmethod
    def get_supported_head_sizes(cls): return [320, 576]    # 512+64 / DSV4 配置
    @classmethod
    def is_mla(cls): return True
```

KV cache 是三维的（无 `2,` 维，因为 K、V 共享同一 latent 加 RoPE 段），
这是与所有 MHA 后端最显眼的不同。head_sizes 也只支持 `320 = 256+64`（V2 早期）
和 `576 = 512+64`（V3/V4）这两个特殊值。

### 7.9.1 子后端清单

| 后端 | 何时使用 |
|---|---|
| `triton_mla.py:TritonMLABackend` | 通用 fallback；纯 Triton |
| `flashmla.py:FlashMLABackend` | DeepSeek 官方 FlashMLA kernel；Hopper/Blackwell，固定 block_size=64 |
| `flashmla_sparse.py` | DSV4 sparse 路径（每个 token 选 top-k KV） |
| `flashattn_mla.py:FlashAttnMLABackend` | 基于 FA3/FA4 内部对 MLA 形状的优化 |
| `flashinfer_mla.py` / `flashinfer_mla_sparse.py` | FlashInfer 的 MLA wrapper |
| `cutlass_mla.py` | Cutlass 直接手写 GEMM，SM10x 上很激进 |
| `tokenspeed_mla.py` | TokenSpeed 第三方 kernel |
| `aiter_triton_mla.py` / `rocm_aiter_mla*.py` / `xpu_mla_sparse.py` | 各平台 port |

### 7.9.2 Prefill / Decode 路径分裂

`MLACommonMetadata` 包含 `prefill: MLACommonPrefillMetadata | None` 与
`decode: D | None` 两个字段（`mla_attention.py:1282`）。在每个 step：

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="MLA 单步 batch 内 decode 与 prefill 分裂走两条 kernel">
  <defs>
    <marker id="ar73" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(20, 14)">
    <text x="0" y="0" font-size="11" font-weight="600" fill="currentColor">输入 batch（query_len 混合）</text>
    <g transform="translate(0, 14)">
      <rect x="0" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="30" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=1</text>
      <rect x="62" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="92" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=64</text>
      <rect x="124" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="154" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=2048</text>
      <rect x="186" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="216" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=1</text>
      <rect x="248" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="278" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=4096</text>
      <rect x="310" y="0" width="60" height="28" fill="#fff7ed" stroke="#cbd5e1"/>
      <text x="340" y="18" text-anchor="middle" font-size="10" fill="#64748b">q=128</text>
    </g>
  </g>
  <line x1="380" y1="56" x2="430" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar73)"/>
  <g transform="translate(440, 14)">
    <rect x="0" y="0" width="400" height="84" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="200" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">reorder_batch_threshold = 128</text>
    <text x="200" y="36" text-anchor="middle" font-size="10" fill="#64748b">query_len ≤ 128 的 req 推到前面</text>
    <text x="200" y="50" text-anchor="middle" font-size="10" fill="#64748b">（flashmla.py:112）</text>
    <text x="200" y="68" text-anchor="middle" font-size="10" fill="#7c3aed">split_decodes_and_prefills() → (num_decodes, num_prefills, …)</text>
  </g>
  <line x1="640" y1="98" x2="640" y2="118" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="440" y1="118" x2="840" y2="118" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="440" y1="118" x2="440" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar73)"/>
  <line x1="840" y1="118" x2="840" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar73)"/>
  <g transform="translate(20, 140)">
    <text x="0" y="0" font-size="11" font-weight="700" fill="currentColor">重排后的 batch</text>
    <g transform="translate(0, 14)">
      <rect x="0" y="0" width="50" height="28" fill="#fed7aa" stroke="#ea580c"/>
      <text x="25" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=1</text>
      <rect x="52" y="0" width="50" height="28" fill="#fed7aa" stroke="#ea580c"/>
      <text x="77" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=1</text>
      <rect x="104" y="0" width="50" height="28" fill="#fed7aa" stroke="#ea580c"/>
      <text x="129" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=64</text>
      <rect x="156" y="0" width="50" height="28" fill="#fed7aa" stroke="#ea580c"/>
      <text x="181" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=128</text>
      <rect x="216" y="0" width="80" height="28" fill="#99f6e4" stroke="#0d9488"/>
      <text x="256" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=2048</text>
      <rect x="298" y="0" width="80" height="28" fill="#99f6e4" stroke="#0d9488"/>
      <text x="338" y="18" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">q=4096</text>
    </g>
    <line x1="208" y1="14" x2="208" y2="46" stroke="#7c3aed" stroke-width="2" stroke-dasharray="3,2"/>
    <text x="100" y="60" text-anchor="middle" font-size="10" fill="#ea580c">num_decodes（含 short extend）</text>
    <text x="305" y="60" text-anchor="middle" font-size="10" fill="#0d9488">num_prefills</text>
  </g>
  <g transform="translate(20, 218)">
    <rect x="0" y="0" width="420" height="142" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
    <text x="210" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">forward_mqa()　decode 路径</text>
    <text x="210" y="40" text-anchor="middle" font-size="10" fill="#64748b">数据搬运友好（latent KV + RoPE 段）</text>
    <rect x="20" y="52" width="380" height="34" rx="4" fill="#fed7aa" stroke="#ea580c"/>
    <text x="210" y="68" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">flash_mla_with_kvcache(...)</text>
    <text x="210" y="80" text-anchor="middle" font-size="9" fill="#64748b">或子后端的 MQA decode kernel</text>
    <text x="210" y="104" text-anchor="middle" font-size="10" fill="#64748b">Sq=1 占绝大多数；q≤128 的 short extend 也走这条</text>
    <text x="210" y="120" text-anchor="middle" font-size="10" fill="#94a3b8">支持 FlashMLA / FlashInferMLA / Cutlass MLA / FlashAttnMLA …</text>
  </g>
  <g transform="translate(460, 218)">
    <rect x="0" y="0" width="400" height="142" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
    <text x="200" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">forward_mha()　prefill 路径</text>
    <text x="200" y="40" text-anchor="middle" font-size="10" fill="#64748b">计算友好的 MHA + chunked prefill</text>
    <rect x="20" y="52" width="360" height="34" rx="4" fill="#99f6e4" stroke="#0d9488"/>
    <text x="200" y="66" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">vllm/v1/attention/backends/mla/prefill/*</text>
    <text x="200" y="80" text-anchor="middle" font-size="9" fill="#64748b">flash_attn / flashinfer / trtllm_ragged / tokenspeed_mla 四选一</text>
    <text x="200" y="104" text-anchor="middle" font-size="10" fill="#64748b">长 context 时按 workspace 切 chunk</text>
    <text x="200" y="120" text-anchor="middle" font-size="10" fill="#94a3b8">ChunkedContextMetadata 记录每 chunk 的 cu_seq_lens / starts</text>
  </g>
</svg>
<span class="figure-caption">图 R7.3 ｜ MLA 单步 batch：先按 reorder_batch_threshold=128 把短 query 推到前面，split_decodes_and_prefills 把 batch 切成两段，分别走数据搬运友好的 MQA decode kernel 与计算友好的 MHA prefill kernel。</span>

<details>
<summary>ASCII 原版</summary>

```
batch 进来
   │ reorder_batch_threshold=128 把 query_len≤128 的 req 推到前面（见 flashmla.py:112）
   ▼
split_decodes_and_prefills() 返回 (num_decodes, num_prefills, ...)
   │
   ├─ 前段 num_decodes 个 req → forward_mqa() 走 latent decode kernel
   │     例如 flash_mla_with_kvcache(...)
   │
   └─ 后段 num_prefills 个 req → forward_mha() 走计算友好的 MHA
         由 vllm/v1/attention/backends/mla/prefill/ 下的某个 sub-backend 选择：
         flash_attn.py / flashinfer.py / trtllm_ragged.py / tokenspeed_mla.py
```

</details>

MLA 的 prefill 还要做 **chunked prefill**：context 长度很大时一次 GEMM 装不下，
按 workspace size 切块——`MLACommonPrefillMetadata.ChunkedContextMetadata`
（`mla_attention.py:1209`）记录每个 chunk 的 `cu_seq_lens / starts / workspace`。

### 7.9.3 一个具体子后端：FlashMLA

```python
# flashmla.py:47
class FlashMLABackend(MLACommonBackend):
    supported_kv_cache_dtypes = ["auto","float16","bfloat16","fp8","fp8_e4m3"]

    @staticmethod
    def get_supported_kernel_block_sizes(): return [64]   # 固定 64
    @classmethod
    def supports_compute_capability(cls, c): return c.major in [9, 10]
    @classmethod
    def supports_combination(cls, ..., use_sparse, ...):
        if use_sparse: return is_flashmla_sparse_supported()[1]
        return is_flashmla_dense_supported()[1]

class FlashMLAMetadataBuilder(MLACommonMetadataBuilder[FlashMLAMetadata]):
    _cudagraph_support = AttentionCGSupport.UNIFORM_BATCH
    query_len_support = QueryLenSupport.UNIFORM
    reorder_batch_threshold: int = 128
```

`reorder_batch_threshold = 128` 表示"query_len ≤ 128 的请求按 decode 路径处理"——
FlashMLA 的 MQA decode kernel 在 128 以下都比 prefill kernel 更快，
所以连一些 chunked-prefill 的 short extend 也走 decode 路径。

---

## 7.10 Sliding window / cross / encoder-only / chunked-local 等特化

vLLM 没有为这些场景单独写 kernel——它们通过**装饰 builder/impl**的方式
复用底层后端。模式是：

```python
# vllm/model_executor/layers/attention/chunked_local_attention.py:31
@functools.lru_cache
def create_chunked_local_attention_backend(
    underlying_attn_backend: type[AttentionBackend],
    attention_chunk_size: int,
) -> type[AttentionBackend]:
    underlying_builder = underlying_attn_backend.get_builder_cls()

    class ChunkedLocalAttentionBuilder(underlying_builder):
        def build(self, common_prefix_len, common_attn_metadata, fast_build=False):
            cm, vbt = make_local_attention_virtual_batches(
                attention_chunk_size, common_attn_metadata, self.kv_cache_spec.block_size,
            )
            metadata = super().build(common_prefix_len, cm, fast_build)
            metadata.make_virtual_batches_block_table = vbt
            return metadata

    return subclass_attention_backend(
        name_prefix=f"ChunkedLocalAttention_{attention_chunk_size}_",
        attention_backend_cls=underlying_attn_backend,
        builder_cls=ChunkedLocalAttentionBuilder,
    )
```

工厂函数 `subclass_attention_backend(...)`（`backend.py:1013`）会动态生成一个
新类，只覆盖 `get_builder_cls`。`ChunkedLocalAttention` 这个 `nn.Module` 在
`__init__` 里调它得到改造后的 backend，再交给基类 `Attention`。

同样的套路：

- **Sliding window**：不是单独后端，模型 init 时通过 `per_layer_sliding_window`
  注入 `Attention(..., per_layer_sliding_window=4096)`，
  最终走到 `FlashAttentionImpl` 的 `window_size=(4095, 0)`
  参数，由 FA kernel 内部处理。
- **`EncoderOnlyAttention`**：`encoder_only_attention.py:29` 同样工厂模式，
  把 `causal=False`、`attn_type=ENCODER_ONLY` 注入到 builder/impl。
- **`CrossAttention`**：`cross_attention.py:81` 工厂模式，
  覆盖 `build()` 把 K/V 长度换成 `encoder_seq_lens`，覆盖 `forward()` 在第一次
  decode 时跳过 KV cache 写入（cross KV cache 一次填好）。
  同时把 `forward_includes_kv_cache_update` 强制改成 `True`，因为它把 KV 写入
  和 forward 合并到自己的 wrapper 里了。
- **`StaticSinkAttention` / `MMEncoderAttention`**：同模式。

### 7.10.1 Mamba 系列

`mamba1_attn.py` / `mamba2_attn.py` / `short_conv_attn.py` / `linear_attn.py` /
`gdn_attn.py` 都继承 `AttentionBackend`，但实际**不做** scaled-dot-product
attention——它们封装的是 SSM（state space model）的 selective scan kernel，
共用 builder/metadata 框架是为了让 model runner 用同一套 `forward_context`
去 dispatch。`MambaSpec`（`vllm/v1/kv_cache_interface.py`）描述的是
SSM state 而不是 KV pages。

---

## 7.11 C++/CUDA kernel 入口（csrc/attention）

```
csrc/attention/
├── paged_attention_v1.cu      decode-only PagedAttention，单 SM 一路到底
├── paged_attention_v2.cu      Split-KV 版本，长 seq 时多 SM 并行 + merge
├── attention_kernels.cuh      模板核心：vllm::paged_attention_{v1,v2}_kernel
├── attention_generic.cuh
├── attention_utils.cuh
├── dtype_{float16,bfloat16,float32,fp8}.cuh   每种 dtype 的向量化访问器
├── merge_attn_states.cu       把 split-KV 的 (out, lse) 合并
└── vertical_slash_index.cu    Vertical+Slash 稀疏 attention 索引构造
```

### 7.11.1 暴露给 Python 的 op

在 `csrc/torch_bindings.cpp:39` 注册：

```cpp
ops.def(
    "paged_attention_v1("
    "    Tensor! out, Tensor query, Tensor key_cache,"
    "    Tensor value_cache, int num_kv_heads, float scale,"
    "    Tensor block_tables, Tensor seq_lens, int block_size,"
    "    int max_seq_len, Tensor? alibi_slopes,"
    "    str kv_cache_dtype, Tensor k_scale, Tensor v_scale,"
    "    int tp_rank, int blocksparse_local_blocks,"
    "    int blocksparse_vert_stride, int blocksparse_block_size,"
    "    int blocksparse_head_sliding_step) -> ()");
ops.impl("paged_attention_v1", torch::kCUDA, &paged_attention_v1);
```

C++ 函数签名在 `csrc/ops.h:34`：

```cpp
void paged_attention_v1(
    torch::Tensor& out, torch::Tensor& query, torch::Tensor& key_cache,
    torch::Tensor& value_cache, int64_t num_kv_heads, double scale,
    torch::Tensor& block_tables, torch::Tensor& seq_lens, int64_t block_size,
    int64_t max_seq_len, const std::optional<torch::Tensor>& alibi_slopes,
    const std::string& kv_cache_dtype, torch::Tensor& k_scale,
    torch::Tensor& v_scale, const int64_t tp_rank,
    const int64_t blocksparse_local_blocks,
    const int64_t blocksparse_vert_stride, const int64_t blocksparse_block_size,
    const int64_t blocksparse_head_sliding_step);
```

Python 侧通过 `vllm/_custom_ops.py` 包装；V1 后端通常不直接调它，而是经过
`vllm/v1/attention/ops/paged_attn.py` 这一层。

### 7.11.2 launcher 模板

`csrc/attention/paged_attention_v1.cu:43` 的 `paged_attention_v1_launcher`：

```cpp
template <typename T, typename CACHE_T, int BLOCK_SIZE,
          vllm::Fp8KVCacheDataType KV_DTYPE, bool IS_BLOCK_SPARSE,
          int NUM_THREADS = 128>
void paged_attention_v1_launcher(
    torch::Tensor& out, torch::Tensor& query,
    torch::Tensor& key_cache, torch::Tensor& value_cache,
    int num_kv_heads, float scale,
    torch::Tensor& block_tables, torch::Tensor& seq_lens,
    int max_seq_len, const std::optional<torch::Tensor>& alibi_slopes,
    torch::Tensor& k_scale, torch::Tensor& v_scale,
    const int tp_rank, ...);
```

按 `head_size` 走 `switch`（编译时 case 32/64/80/96/112/120/128/192/256，
见 `paged_attention_v1.cu:90`-`120`），launch grid `(num_heads, num_seqs, 1)`。
为什么要 switch？因为 `HEAD_SIZE` 是模板参数——预先 instantiate 限定的几个
head size 可以让编译器把 vector load/store 完全展开，比运行时分支快得多。

### 7.11.3 V1 vs V2 的差别

- `paged_attention_v1`：每个 (head, seq) 由 **一个 thread block** 处理完整个 seq。
  适合 seq 不太长的 decode（多 seq batch 已经能填满 SM）。
- `paged_attention_v2`：把单个 seq 的 KV 沿时间维**切成 chunk**，每 chunk 一个
  thread block 出局部 `(out, exp_sums, max_logits)`，再用 `merge_attn_states`
  归约——所以接口多出 `Tensor! exp_sums, Tensor! max_logits, Tensor! tmp_out`
  四个中间 buffer（`torch_bindings.cpp:53`）。长 seq 必须用 v2 才能填满 SM。

### 7.11.4 在 V1 后端中的位置

vLLM V1 默认**不**直接调 csrc PagedAttention v1/v2——FA/FlashInfer/Triton 各自
都有更先进的 paged kernel。csrc 的实现保留下来主要用于：

- 平台 fallback（某些 head_size / dtype / block_size 组合，三大库都不支持）。
- 教学/参考实现。
- 测试基线（`tests/kernels/attention/` 用它作为 ground truth）。

但 `csrc/cache_kernels.cu` 里的 `reshape_and_cache_flash`、`concat_and_cache_mla`
（`torch_bindings.cpp:519`、`530`）是被所有后端依赖的核心 op，
负责把新 token 的 K/V 按 `slot_mapping` 写入 paged KV cache。

---

## 7.12 一次 attention 调用的完整流程

以 GPU + FlashAttention 为例，单层走完一次：

<svg viewBox="0 0 880 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="FlashAttention 路径下，一层 attention 从 ModelRunner 到 flash_attn_varlen_func 的完整调用链">
  <defs>
    <marker id="ar74" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g transform="translate(120, 14)">
    <rect x="0" y="0" width="640" height="120" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
    <text x="320" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">GPUModelRunner.execute_model(scheduler_output)</text>
    <g transform="translate(14, 32)">
      <rect x="0" y="0" width="190" height="40" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="95" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">1. 构造 CommonAttentionMetadata</text>
      <text x="95" y="30" text-anchor="middle" font-size="9" fill="#64748b">query_start_loc / seq_lens / slot_mapping</text>
      <rect x="206" y="0" width="190" height="40" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="301" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">2. builder.build()（每个 kv_cache_group）</text>
      <text x="301" y="30" text-anchor="middle" font-size="9" fill="#64748b">FA AOT scheduler / cascade / DCP</text>
      <rect x="412" y="0" width="200" height="40" rx="4" fill="#fed7aa" stroke="#ea580c"/>
      <text x="512" y="16" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">3. set_forward_context(attn_metadata)</text>
      <text x="512" y="30" text-anchor="middle" font-size="9" fill="#64748b">dict[layer_name → metadata]</text>
    </g>
    <rect x="14" y="78" width="612" height="32" rx="4" fill="#fed7aa" stroke="#ea580c"/>
    <text x="320" y="92" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4. model(input_ids, positions, ...) → 进入每一层 Attention</text>
    <text x="320" y="104" text-anchor="middle" font-size="9" fill="#64748b">model 不知道 metadata 在哪——用 get_forward_context 隐式取</text>
  </g>
  <line x1="440" y1="134" x2="440" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar74)"/>
  <g transform="translate(160, 158)">
    <rect x="0" y="0" width="560" height="78" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="280" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">TransformerBlock.forward / Attention.forward</text>
    <text x="280" y="38" text-anchor="middle" font-size="10" fill="#64748b">q,k,v = qkv_proj(hidden_states)　·　output = torch.empty(num_tokens, num_heads × head_size_v)</text>
    <text x="280" y="54" text-anchor="middle" font-size="10" fill="#7c3aed">在 custom op 之外做 reshape / slice（让 piecewise CG 不被这些便宜算子污染）</text>
    <text x="280" y="68" text-anchor="middle" font-size="9" fill="#94a3b8">attention.py:437</text>
  </g>
  <line x1="280" y1="236" x2="220" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar74)"/>
  <line x1="600" y1="236" x2="660" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar74)"/>
  <text x="120" y="248" font-size="10" fill="#64748b">if not forward_includes_kv_cache_update</text>
  <text x="700" y="248" font-size="10" fill="#64748b">总是</text>
  <g transform="translate(40, 256)">
    <rect x="0" y="0" width="380" height="118" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">torch.ops.vllm.unified_kv_cache_update</text>
    <text x="190" y="36" text-anchor="middle" font-size="9" fill="#64748b">attention.py:691　custom op</text>
    <rect x="20" y="46" width="340" height="62" rx="4" fill="#99f6e4" stroke="#0d9488"/>
    <text x="190" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">impl.do_kv_cache_update(layer, k, v, kv_cache, slot_mapping)</text>
    <text x="190" y="80" text-anchor="middle" font-size="10" fill="#64748b">→ reshape_and_cache_flash(k, v, kc, vc, slot_mapping, …)</text>
    <text x="190" y="96" text-anchor="middle" font-size="9" fill="#94a3b8">把新 token 的 KV 写到 paged cache</text>
  </g>
  <g transform="translate(460, 256)">
    <rect x="0" y="0" width="380" height="118" rx="8" fill="#fef3c7" stroke="#facc15" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#92400e">torch.ops.vllm.unified_attention_with_output</text>
    <text x="190" y="36" text-anchor="middle" font-size="9" fill="#a16207">attention.py:734　custom op（mutates_args=["output"]）</text>
    <rect x="20" y="46" width="340" height="62" rx="4" fill="#fef9c3" stroke="#facc15"/>
    <text x="190" y="64" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">attn_metadata, layer, kv_cache = get_attention_context</text>
    <text x="190" y="80" text-anchor="middle" font-size="10" fill="#64748b">impl.forward(layer, q, k, v, kv_cache, attn_metadata, output, …)</text>
    <text x="190" y="96" text-anchor="middle" font-size="9" fill="#a16207">kv_cache_dummy_dep 让 compile 看到两个 op 的依赖</text>
  </g>
  <line x1="650" y1="374" x2="650" y2="396" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar74)"/>
  <g transform="translate(460, 398)">
    <rect x="0" y="0" width="380" height="108" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="190" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">flash_attn_varlen_func</text>
    <text x="190" y="38" text-anchor="middle" font-size="10" fill="#64748b">q, k=kc, v=vc, out=output</text>
    <text x="190" y="54" text-anchor="middle" font-size="10" fill="#64748b">cu_seqlens_q=query_start_loc</text>
    <text x="190" y="68" text-anchor="middle" font-size="10" fill="#64748b">seqused_k=seq_lens, block_table=…</text>
    <text x="190" y="82" text-anchor="middle" font-size="10" fill="#64748b">scheduler_metadata=…（FA3 AOT）</text>
    <text x="190" y="98" text-anchor="middle" font-size="10" fill="currentColor" font-weight="700">prefill + decode 同一个 varlen kernel</text>
  </g>
  <line x1="380" y1="506" x2="380" y2="528" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar74)"/>
  <g transform="translate(240, 530)">
    <rect x="0" y="0" width="400" height="60" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="200" y="22" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">return output → hidden_states</text>
    <text x="200" y="40" text-anchor="middle" font-size="10" fill="#64748b">下一层 attention 复用同一份 attn_metadata（按 layer_name 索引）</text>
    <text x="200" y="54" text-anchor="middle" font-size="10" fill="#94a3b8">直到所有层跑完，回到 GPUModelRunner 做 logits / sample</text>
  </g>
</svg>
<span class="figure-caption">图 R7.4 ｜ FlashAttention 路径下，一层 attention 的完整调用链：ModelRunner 一次性构造 metadata、model 在每层把 KV 写入与 attention 拆成两个 custom op（让 torch.compile 看到依赖），最终 prefill 和 decode 都走同一个 flash_attn_varlen_func。</span>

<details>
<summary>ASCII 原版</summary>

```
GPUModelRunner.execute_model(scheduler_output)
  │
  │  1. 用 scheduler_output 构造 CommonAttentionMetadata
  │     - 算 query_start_loc / seq_lens / slot_mapping / block_table
  │     - 一次构造，所有层共享
  │
  │  2. 对每个 kv_cache_group 调 builder.build()
  │     - FlashAttentionMetadataBuilder.build(common_prefix_len, cm)
  │     - 跑 AOT scheduler 得到 scheduler_metadata
  │     - 处理 cascade / DCP 等特化
  │     - 返回 FlashAttentionMetadata
  │
  │  3. 把 metadata 装入 forward_context.attn_metadata（dict[layer_name → metadata]）
  │
  ▼  4. with set_forward_context(...): model(input_ids, positions, ...)
  ─────── model 内的每一层 attention 调用 ───────
  │
  │  TransformerBlock.forward:
  │    q, k, v = qkv_proj(hidden)
  │    out = self.attn(q, k, v)         ← Attention.__call__
  │
  │  Attention.forward (model_executor/layers/attention/attention.py:437):
  │    if calculate_kv_scales: torch.ops.vllm.maybe_calc_kv_scales(q,k,v,...)
  │    output = torch.empty((num_tokens, num_heads*head_size_v))
  │    if not backend.forward_includes_kv_cache_update:
  │        kv_cache_dummy_dep = torch.ops.vllm.unified_kv_cache_update(k, v, name)
  │    torch.ops.vllm.unified_attention_with_output(q, k, v, output, name, ...)
  │    return output
  │
  │  unified_kv_cache_update (custom op, attention.py:691):
  │    attn_layer.impl.do_kv_cache_update(layer, k, v, kv_cache, slot_mapping)
  │       → reshape_and_cache_flash(k, v, kc, vc, slot_mapping, ...)
  │
  │  unified_attention_with_output (custom op, attention.py:734):
  │    attn_metadata, layer, kv_cache, _ = get_attention_context(layer_name)
  │    layer.impl.forward(layer, q, k, v, kv_cache, attn_metadata, output, ...)
  │       → flash_attn_varlen_func(q=..., k=kc, v=vc, out=output,
  │                                cu_seqlens_q=..., seqused_k=...,
  │                                block_table=..., scheduler_metadata=...)
  │
  ▼
返回 hidden_states
```

</details>

几个**为什么这样设计**：

1. **metadata 一次构造，所有层共享**：在 V0 时代 metadata 每层重建一次，
   现在 host 端开销已经成为 decode bottleneck，所以 V1 把它抽出来。
2. **`Attention` 在 forward 里 reshape，custom op 之外做**（`attention.py:481`）：
   `view`/`slice` 在 piecewise CG 里执行成本不低，把它们留在 eager 段，
   custom op 内部只做"重活"。
3. **`get_forward_context()` 而不是参数传 metadata**：模型代码不需要知道
   attention metadata 是什么——它只调 `Attention.forward(q,k,v)`。
   metadata 由 forward context 这个隐式参数提供，便于 `torch.compile`
   把 attention 当成完全 opaque op。
4. **`unified_attention_with_output` 是个真正的 custom op**（`attention.py:777`），
   `mutates_args=["output", "output_block_scale"]`。这样 `torch.compile`
   知道 output buffer 会被原地写，不会被错误地优化掉。
5. **`use_direct_call`**（`attention.py:393`）：CPU/CUDA/ROCm 之外的平台（如 XPU）
   `opaque_attention_op()` 返回 False，attention 不走 custom op，直接 Python 调用
   ——因为这些平台 `torch.compile` 路径尚不成熟。

---

## 7.13 `Attention` 类：模型代码看到的唯一接口

文件：`vllm/model_executor/layers/attention/attention.py:177`。

```python
class Attention(nn.Module, AttentionLayerBase):
    def __init__(
        self, num_heads, head_size, scale,
        num_kv_heads=None, alibi_slopes=None, use_alibi_sqrt=None,
        cache_config=None, quant_config=None,
        logits_soft_cap=None, per_layer_sliding_window=None,
        prefix="", attn_type=AttentionType.DECODER,
        kv_sharing_target_layer_name=None,
        attn_backend: type[AttentionBackend] | None = None,
        head_size_v: int | None = None, **extra_impl_args,
    ):
        ...
        self.attn_backend = attn_backend or get_attn_backend(
            head_size, dtype, kv_cache_dtype,
            use_mla=False, has_sink=self.has_sink,
            use_mm_prefix=self.use_mm_prefix,
            use_per_head_quant_scales=use_per_head_quant_scales,
            attn_type=attn_type,
        )
        impl_cls = self.attn_backend.get_impl_cls()
        self.impl = impl_cls(num_heads, head_size, scale, num_kv_heads,
                             alibi_slopes, sliding_window, kv_cache_dtype,
                             logits_soft_cap, attn_type,
                             kv_sharing_target_layer_name, **extra_impl_args)
        self.use_direct_call = not current_platform.opaque_attention_op()
        compilation_config.static_forward_context[prefix] = self    # 自注册
        self.kv_cache = torch.tensor([])    # bind_kv_cache 后被替换
        _init_kv_cache_quant(self, quant_config, prefix)
```

模型里写法：

```python
class DecoderLayer(nn.Module):
    def __init__(self, config, cache_config, quant_config, prefix):
        ...
        self.attn = Attention(
            num_heads=self.num_heads,
            head_size=self.head_dim,
            scale=self.scaling,
            num_kv_heads=self.num_kv_heads,
            cache_config=cache_config,
            quant_config=quant_config,
            per_layer_sliding_window=4096 if layer_is_sliding else None,
            prefix=f"{prefix}.attn",
        )

    def forward(self, hidden_states, positions):
        q, k, v = self.qkv_proj(hidden_states)
        q, k = self.rotary_emb(positions, q, k)
        attn_out = self.attn(q, k, v)
        return self.o_proj(attn_out)
```

模型作者**只**关心 Q/K/V 的形状 (`[num_tokens, num_heads, head_size]`) 与输出
shape，不需要碰 attention metadata、block table、slot mapping、KV cache layout。

### 7.13.1 Custom op vs direct call

- `use_direct_call = True`（XPU/CPU 等）：`self.impl.forward(...)` 直接 Python 调，
  KV cache 写入也直接调 `do_kv_cache_update`。
- `use_direct_call = False`（CUDA/ROCm）：包到 `torch.ops.vllm.unified_attention_with_output`
  custom op 里。原因——**`torch.compile` 不能优化进 attention kernel**
  （后者通常是预编译的 CUDA/Triton kernel），把它包成 opaque op 后，
  inductor 看到的就是 `(args) -> out` 黑盒，能正确处理依赖、CUDA graph 捕获、
  以及 RoPE/QKV-fusion-pass 等图变换。

### 7.13.2 `get_kv_cache_spec()`：告诉调度器要分配多大 KV

`attention.py:566` 的 `get_kv_cache_spec()` 在 init 之后被
`KVCacheManager` 调用，返回这一层对应的 `KVCacheSpec`：

```python
if self.sliding_window is not None:
    return SlidingWindowSpec(block_size, num_kv_heads, head_size, ..., sliding_window)
elif kv_cache_dtype.startswith("turboquant_"):
    return TQFullAttentionSpec(...)
else:
    return FullAttentionSpec(block_size, num_kv_heads, head_size, head_size_v, dtype, kv_quant_mode)
```

调度器据此**为每一层分配独立或共享的 KV pool**（hybrid models 中
sliding-window 层与全 attention 层尺寸不同）。

### 7.13.3 子类化模式

| 子类 | 关键差异 |
|---|---|
| `MLAAttention` (`mla_attention.py:322`) | 用 MLA backend，构造时传 `kv_lora_rank` / `qk_*_head_dim` / `kv_b_proj`，forward 走 `forward_mha`/`forward_mqa` |
| `EncoderOnlyAttention` | 工厂改造 backend：`causal=False`、`attn_type=ENCODER_ONLY` |
| `CrossAttention` | 工厂改造 backend：cross-attn KV cache、`forward_includes_kv_cache_update=True` |
| `ChunkedLocalAttention` | 工厂改造 builder：`make_local_attention_virtual_batches` 把长 seq 切成 chunk |
| `StaticSinkAttention` | 在 Q 前面拼若干个固定 sink token |
| `MMEncoderAttention` | 多模态 encoder（ViT 等），KV cache spec 不同 |

这些子类**不引入新后端**——它们都是上面 5 个工厂模式的薄壳。

---

## 7.14 如何添加新后端

最小可工作集需要四块东西：

1. **`AttentionBackend` 子类**：声明能力。
   ```python
   class MyBackend(AttentionBackend):
       supported_dtypes = [torch.bfloat16]
       supported_kv_cache_dtypes = ["auto", "bfloat16"]
       forward_includes_kv_cache_update = False
       @staticmethod
       def get_name() -> str: return "MY_BACKEND"
       @staticmethod
       def get_impl_cls(): return MyImpl
       @staticmethod
       def get_builder_cls(): return MyBuilder
       @staticmethod
       def get_kv_cache_shape(num_blocks, block_size, num_kv_heads, head_size, ...):
           return (2, num_blocks, block_size, num_kv_heads, head_size)
       @classmethod
       def get_supported_head_sizes(cls): return [64, 128]
       @classmethod
       def supports_compute_capability(cls, capability): return capability >= DeviceCapability(8,0)
   ```

2. **`AttentionMetadataBuilder` 子类**：吃 `CommonAttentionMetadata`，
   输出自定义 metadata。
   ```python
   class MyBuilder(AttentionMetadataBuilder[MyMetadata]):
       _cudagraph_support = AttentionCGSupport.UNIFORM_BATCH
       def __init__(self, kv_cache_spec, layer_names, vllm_config, device):
           super().__init__(kv_cache_spec, layer_names, vllm_config, device)
       def build(self, common_prefix_len, common_attn_metadata, fast_build=False):
           return MyMetadata(
               num_actual_tokens=common_attn_metadata.num_actual_tokens,
               query_start_loc=common_attn_metadata.query_start_loc,
               seq_lens=common_attn_metadata.seq_lens,
               block_table=common_attn_metadata.block_table_tensor,
               slot_mapping=common_attn_metadata.slot_mapping,
               ...
           )
   ```

3. **`AttentionImpl` 子类**：把 metadata + Q/K/V 喂给 kernel。
   ```python
   class MyImpl(AttentionImpl[MyMetadata]):
       def __init__(self, num_heads, head_size, scale, num_kv_heads,
                    alibi_slopes, sliding_window, kv_cache_dtype,
                    logits_soft_cap, attn_type,
                    kv_sharing_target_layer_name, **kwargs):
           ...
       def forward(self, layer, query, key, value, kv_cache,
                   attn_metadata, output, output_scale=None,
                   output_block_scale=None) -> torch.Tensor:
           if attn_metadata is None:
               return output.fill_(0)   # profiling pass
           my_kernel(query, key, value, output, kv_cache,
                     attn_metadata.block_table, attn_metadata.seq_lens, ...)
           return output
       def do_kv_cache_update(self, layer, key, value, kv_cache, slot_mapping):
           # 仅当 backend.forward_includes_kv_cache_update == False 时被调
           write_kv_cache(key, value, kv_cache, slot_mapping,
                          layer._k_scale, layer._v_scale)
   ```

4. **注册**：
   ```python
   from vllm.v1.attention.backends.registry import (
       AttentionBackendEnum, register_backend)
   register_backend(AttentionBackendEnum.CUSTOM, "my.module.MyBackend")
   ```
   或装饰器写法：
   ```python
   @register_backend(AttentionBackendEnum.CUSTOM)
   class MyBackend(AttentionBackend): ...
   ```

   然后启动 vLLM 时 `--attention-config.backend CUSTOM`。

### 7.14.1 常见坑

- **`forward_includes_kv_cache_update` 必须正确**——如果 kernel 内部已经写 KV，
  必须设 `True`，否则 `Attention.forward` 会重复调 `do_kv_cache_update`
  造成双写。
- **`get_kv_cache_shape` 是合约**：调度器据此分配显存，第一维大小就是
  KV cache 块数 (`num_blocks`)。`get_kv_cache_block_dim()`
  （`backend.py:99`）用一个 magic number `_S=1234567` 探测块维位置——
  shape 中必须只出现 num_blocks 一次。
- **`supports_compute_capability` 与 `supports_combination`**：selector 在
  fallback 链里靠这些来淘汰不兼容的后端，写错会被静默跳过。
- **CUDA Graph**：如果 `_cudagraph_support != NEVER`，必须保证 `build()` 在
  capture 与 replay 时**返回结构形状相同的 metadata**（同样的 dtype/shape，
  允许内容不同）。否则会触发 cudagraph capture failure。
- **批不变性**：如果 kernel 用 split-K 累加，输出会随 split 数变化；
  要支持 `VLLM_BATCH_INVARIANT` 必须显式 `num_splits=1`
  （参考 `flash_attn.py:443`）。
- **`AttentionLayerBase` 注册**：把 backend 注册到 enum 之外，
  通常还需要让你的 `Attention` 子类调 `compilation_config.static_forward_context[prefix] = self`，
  这样 forward context 在每 step 能找到层。基类 `Attention` 已经做了；自定义
  layer 应该继承 `Attention` 而不是从头实现。

### 7.14.2 复用现有能力

- 想做 sliding window：不需要新后端，传 `per_layer_sliding_window=`。
- 想做 chunked local：包一层 `create_chunked_local_attention_backend`
  （见 7.10），不需要新 kernel。
- 想做 cross attention：用 `CrossAttention` 子类。
- 想做新硬件：实现 `Platform.get_attn_backend_cls`，把候选后端按优先级列出来，
  selector 会自动 dispatch。

---

## 7.15 速查表

### 7.15.1 关键文件入口

| 内容 | 路径 |
|---|---|
| `Attention` 公共层 | `vllm/model_executor/layers/attention/attention.py:177` |
| `MLAAttention` 公共层 | `vllm/model_executor/layers/attention/mla_attention.py:322` |
| 抽象基类 | `vllm/v1/attention/backend.py:55` (Backend) / `516` (Builder) / `685` (Impl) |
| `CommonAttentionMetadata` | `vllm/v1/attention/backend.py:352` |
| 后端枚举 | `vllm/v1/attention/backends/registry.py:34` |
| Selector | `vllm/v1/attention/selector.py:52` |
| 通用工具 | `vllm/v1/attention/backends/utils.py` (`split_decodes_and_prefills:507`, `reorder_batch_to_split_decodes_and_prefills:606`, `get_dcp_local_seq_lens:831`) |
| FlashAttention | `vllm/v1/attention/backends/flash_attn.py:68` (Backend) `/276` (Builder) `/592` (Impl) |
| FlashInfer | `vllm/v1/attention/backends/flashinfer.py:325` `/538` `/1258` |
| Triton | `vllm/v1/attention/backends/triton_attn.py:266` `/126` `/391` |
| FlexAttention | `vllm/v1/attention/backends/flex_attention.py:80` `/747` `/969` |
| MLA common | `vllm/model_executor/layers/attention/mla_attention.py:1166` `/1360` `/1925` |
| Custom op 注册 | `vllm/model_executor/layers/attention/attention.py:725-782` |
| C++ PA v1 launcher | `csrc/attention/paged_attention_v1.cu:43` |
| C++ PA v2 launcher | `csrc/attention/paged_attention_v2.cu` |
| Op bindings | `csrc/torch_bindings.cpp:39-78` / `csrc/ops.h:34-62` |
| KV cache 写入 | `csrc/cache_kernels.cu` (`reshape_and_cache_flash`, `concat_and_cache_mla`) |

### 7.15.2 常用判定

| 问题 | 看哪里 |
|---|---|
| 我这块卡上默认走哪个后端？ | `vllm/platforms/<device>.py:get_attn_backend_cls` + `selector.py:52` |
| 这个后端能用 fp8 KV cache 吗？ | `Backend.supports_kv_cache_dtype("fp8")` |
| 这个后端能进 CUDA Graph 吗？ | `Builder._cudagraph_support` / `get_cudagraph_support()` |
| KV cache 内存怎么算？ | `Backend.get_kv_cache_shape()` + `get_kv_cache_stride_order()` |
| 这层用了 sliding window 后 KV 还要多大？ | `Attention.get_kv_cache_spec()` 返回 `SlidingWindowSpec` |
| 为什么 KV 写入和 attention 是两个 op？ | `Backend.forward_includes_kv_cache_update == False` 时分两个 op 让 `torch.compile` 看到依赖 |
| 为什么 MLA 的 KV cache 只有 3 维？ | latent 共享：`MLACommonBackend.get_kv_cache_shape` 返回 `(num_blocks, block_size, head_size=576)` |
| reorder batch 是干什么的？ | MLA/FlashMLA 要 decode 段在前，靠 `Builder.reorder_batch_threshold` + `reorder_batch_to_split_decodes_and_prefills` |
