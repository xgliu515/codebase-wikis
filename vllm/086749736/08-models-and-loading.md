# 第 8 章 模型定义、注册与权重加载

本章解释 vLLM 如何把一份 HuggingFace 检查点变成可以执行的 GPU 模型：模型文件的目录组织、架构注册中心、组成 transformer 的并行 layer 库、attention layer 如何挂载到 KV cache、以及 weight loader 如何把检查点张量精确地切片、合并、复制到每张卡的对应 parameter 上。读完本章后，可以照着 `llama.py` 的形式实现一个新模型并接入 vLLM。

阅读前置：第 5 章 (Worker 与 Model Runner)、第 7 章 (KV cache 管理)。

---

## 8.1 `vllm/model_executor/` 的目录布局

```
vllm/model_executor/
├── __init__.py
├── custom_op.py                  # CustomOp / PluggableLayer 基类
├── parameter.py                  # BasevLLMParameter 系列，自带 weight_loader
├── utils.py
├── kernels/                      # 直接调用的算子封装
├── warmup/                       # CUDA graph / compile warmup
├── offloader/                    # weight 与 KV cache 的 CPU/UVA 卸载
├── layers/                       # 公共并行 layer 库（见 §8.4）
│   ├── linear.py                 # Column/Row/QKV/MergedColumn ParallelLinear
│   ├── layernorm.py              # RMSNorm / LayerNorm / GemmaRMSNorm
│   ├── activation.py             # SiluAndMul / GeluAndMul / ...
│   ├── vocab_parallel_embedding.py
│   ├── rotary_embedding/         # RoPE 家族
│   ├── attention/                # Attention layer wrapper
│   ├── fused_moe/                # FusedMoE
│   ├── quantization/             # GPTQ / AWQ / FP8 / NVFP4 / ...
│   ├── pooler/                   # 池化（embedding / reward / classification）
│   ├── mla.py, kda.py, mhc.py    # 特殊 attention 变体
│   ├── mamba/, fla/, conv.py     # 非 attention 层（状态空间模型 / 线性注意力 / 卷积）
│   └── logits_processor.py
├── models/                       # 每个架构一个 .py 文件，约 290 个
│   ├── registry.py               # 架构注册中心（§8.2）
│   ├── interfaces.py             # SupportsLoRA / SupportsPP / ... mixin
│   ├── interfaces_base.py        # VllmModel / VllmModelForTextGeneration
│   ├── utils.py                  # AutoWeightsLoader / WeightsMapper / make_layers / PPMissingLayer
│   ├── adapters.py               # as_embedding_model / as_seq_cls_model
│   ├── llama.py, qwen3.py, deepseek_v2.py, mixtral.py, ...
│   └── transformers/             # 通过 transformers backend 兜底
└── model_loader/                 # weight loader（§8.6）
    ├── __init__.py               # load format → loader 分发
    ├── base_loader.py            # BaseModelLoader 抽象
    ├── default_loader.py         # safetensors / *.bin / *.pt
    ├── sharded_state_loader.py   # 已 TP 切分的本地 ckpt
    ├── tensorizer_loader.py      # CoreWeave Tensorizer
    ├── runai_streamer_loader.py  # RunAI streamer
    ├── bitsandbytes_loader.py    # bnb 4bit/8bit
    ├── gguf_loader.py
    ├── dummy_loader.py           # 调试/profile 用，随机权重
    ├── weight_utils.py           # safetensors_weights_iterator / default_weight_loader / ...
    ├── ep_weight_filter.py       # MoE EP rank 过滤
    └── utils.py                  # initialize_model / process_weights_after_loading
```

设计上有四层职责分离：

| 层 | 职责 | 关键类型 |
| --- | --- | --- |
| `models/<arch>.py` | 模型拓扑：把 layer 组装成 transformer，并提供 `load_weights` | `LlamaForCausalLM` 之类 |
| `layers/` | 与并行策略和 quantization 解耦的可复用 layer | `QKVParallelLinear`, `RMSNorm`, `Attention`, `FusedMoE` |
| `parameter.py` | 每个 parameter 自带 `weight_loader` 回调，知道自己应如何分片 | `BasevLLMParameter`, `ModelWeightParameter`, `PackedvLLMParameter` |
| `model_loader/` | 从外部存储读取 raw 张量并喂给 `model.load_weights` | `DefaultModelLoader`, `BaseModelLoader` |

> **为什么这样设计？** 模型作者只需描述拓扑和 HF→vLLM 的命名映射；TP/PP/EP 切分、quant kernel 选择、scale 注册等横切关注点全部下沉到 `layers/` 与 `parameter.py`。这让加一个新模型 ≈ 写一个 PyTorch 模块加一个 `load_weights`。

---

## 8.2 模型注册：HF `architectures` → vLLM 模型类

入口在 `vllm/model_executor/models/registry.py`。HuggingFace `config.json` 的 `architectures` 字段（例如 `["LlamaForCausalLM"]`）就是 lookup key。

### 8.2.1 静态表

按任务类型（runner type）分桶：

- `_TEXT_GENERATION_MODELS` —— decoder-only / encoder-decoder 文本生成 (`registry.py:70-221`)
- `_EMBEDDING_MODELS` —— 通过 `convert_type="embed"` 取 last-hidden-state (`registry.py:223-276`)
- `_LATE_INTERACTION_MODELS` —— ColBERT 系 (`registry.py:278-292`)
- `_REWARD_MODELS` (`registry.py:294-298`)
- `_TOKEN_CLASSIFICATION_MODELS` (`registry.py:300-311`)
- `_SEQUENCE_CLASSIFICATION_MODELS` (`registry.py:313-341`)
- `_MULTIMODAL_MODELS` —— Vision/Audio/OCR 等带 encoder 的模型 (`registry.py:343-586`)
- `_SPECULATIVE_DECODING_MODELS` —— EAGLE/MTP/Medusa draft (`registry.py:588-634`)
- `_TRANSFORMERS_SUPPORTED_MODELS` / `_TRANSFORMERS_BACKEND_MODELS` —— 通过 transformers backend 跑 (`registry.py:636-679`)

最终合并到 `_VLLM_MODELS` (`registry.py:681-692`)。

每个 value 是 `(module_relname, class_name)` 元组。例如

```python
"LlamaForCausalLM": ("llama", "LlamaForCausalLM"),
"Qwen3ForCausalLM": ("qwen3", "Qwen3ForCausalLM"),
"DeepseekV3ForCausalLM": ("deepseek_v2", "DeepseekV3ForCausalLM"),
"MixtralForCausalLM": ("mixtral", "MixtralForCausalLM"),
```

注意一个文件可以承担多个架构，例如 `("llama", "LlamaForCausalLM")` 也被 `InternLM`, `InternLM3`, `Xverse`, `TeleChat3`, `CWM`, `Aquila` 等复用。

### 8.2.2 懒加载

`registry.py:805-911` 定义 `_LazyRegisteredModel`：

```python
@dataclass(frozen=True)
class _LazyRegisteredModel(_BaseRegisteredModel):
    module_name: str
    class_name: str

    def load_model_cls(self) -> type[nn.Module]:
        mod = importlib.import_module(self.module_name)
        return getattr(mod, self.class_name)
```

模块的实际 `import` 推迟到第一次被命中。`ModelRegistry` 的构造 (`registry.py:1331-1339`) 因此只是组装一堆 `_LazyRegisteredModel`，不会真正 import 任何模型文件 —— 这避免了启动时把所有 CUDA kernel 都触发 build/load。

### 8.2.3 inspect vs resolve

注册中心暴露两个层次的接口：

| 接口 | 用途 | 是否真的 import | 关键路径 |
| --- | --- | --- | --- |
| `inspect_model_cls(arch, model_config)` | 早期决策（`is_pooling_model`, `supports_pp`, `is_hybrid` 等） | 在子进程中 import 一次，结果缓存到 `~/.cache/vllm/modelinfos/*.json` | `registry.py:871-907` |
| `resolve_model_cls(arch, model_config)` | 真正实例化前的最后一步 | 在主进程 import | `registry.py:1188-1240` |

inspect 走子进程的核心原因：避免在主进程里把 PyTorch CUDA context 初始化，否则后续 `fork` worker 会抛 *Cannot re-initialize CUDA in forked subprocess*。子进程把 `_ModelInfo` 通过 pickle 传回主进程 (`registry.py:1344-1371`)。

### 8.2.4 fallback 链

`_ModelRegistry.resolve_model_cls` (`registry.py:1188-1240`) 与 `inspect_model_cls` (`registry.py:1136-1186`) 实现下面的解析顺序：

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vLLM model registry resolution fallback chain">
  <defs>
    <marker id="r8ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">architectures → model class 的解析瀑布</text>
  <g transform="translate(220, 38)">
    <rect x="0" y="0" width="320" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
    <text x="160" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">architectures = config.architectures</text>
    <text x="160" y="30" text-anchor="middle" font-size="10" fill="#64748b">来自 HF config.json</text>
  </g>
  <path d="M 380 76 L 380 92" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(40, 96)">
    <rect x="0" y="0" width="430" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="14" y="20" font-size="11" font-weight="600" fill="#9a3412">model_impl == "transformers"</text>
    <rect x="490" y="0" width="190" height="32" rx="4" fill="#fef3c7" stroke="#facc15" stroke-width="1"/>
    <text x="585" y="20" text-anchor="middle" font-size="11" fill="#92400e">transformers backend</text>
    <path d="M 430 16 L 488 16" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  </g>
  <path d="M 255 128 L 255 144" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(40, 148)">
    <rect x="0" y="0" width="430" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="14" y="20" font-size="11" font-weight="600" fill="#9a3412">model_impl == "terratorch"</text>
    <rect x="490" y="0" width="190" height="32" rx="4" fill="#fef3c7" stroke="#facc15" stroke-width="1"/>
    <text x="585" y="20" text-anchor="middle" font-size="11" fill="#92400e">Terratorch</text>
    <path d="M 430 16 L 488 16" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  </g>
  <path d="M 255 180 L 255 196" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(40, 200)">
    <rect x="0" y="0" width="430" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="14" y="20" font-size="11" font-weight="600" fill="#9a3412">所有 arch 都不在 _VLLM_MODELS</text>
    <rect x="490" y="0" width="190" height="32" rx="4" fill="#fef3c7" stroke="#facc15" stroke-width="1"/>
    <text x="585" y="20" text-anchor="middle" font-size="11" fill="#92400e">transformers backend（auto）</text>
    <path d="M 430 16 L 488 16" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  </g>
  <path d="M 255 232 L 255 248" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(40, 252)">
    <rect x="0" y="0" width="640" height="70" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="14" y="20" font-size="11" font-weight="700" fill="#5b21b6">逐个 arch 尝试：</text>
    <text x="14" y="38" font-size="11" fill="#5b21b6">_normalize_arch(arch)  (registry.py:1110-1134)</text>
    <text x="32" y="54" font-size="10" fill="#6d28d9">└─ 处理 ForConditionalGeneration / ForSequenceClassification</text>
    <text x="32" y="65" font-size="10" fill="#6d28d9">     与 runner_type / convert_type 的隐式映射</text>
  </g>
  <path d="M 360 322 L 360 338" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(150, 342)">
    <rect x="0" y="0" width="420" height="36" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
    <text x="210" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="#166534">找到 → _try_load_model_cls(arch)</text>
    <text x="210" y="30" text-anchor="middle" font-size="10" fill="#15803d">→ nn.Module class</text>
  </g>
  <path d="M 360 378 L 360 394" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <g transform="translate(80, 398)">
    <rect x="0" y="0" width="560" height="50" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="280" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#991b1b">仍未命中 → _raise_for_unsupported</text>
    <text x="280" y="38" text-anchor="middle" font-size="10" fill="#7f1d1d">含已下线、需 plugin 的友好提示（_PREVIOUSLY_SUPPORTED_MODELS / _OOT_SUPPORTED_MODELS）</text>
  </g>
</svg>
<span class="figure-caption">图 R8.1 ｜ HF config.architectures 的解析瀑布：先看 model_impl 显式覆盖，再看是否有原生实现，最后落到 transformers backend 兜底；任何一层命中就 short-circuit 返回</span>

<details>
<summary>ASCII 原版</summary>

```
architectures = config.architectures        # 来自 HF config.json
                  │
                  ▼
        model_impl == "transformers" ──► transformers backend
                  │
                  ▼
        model_impl == "terratorch"   ──► Terratorch
                  │
                  ▼
        所有 arch 都不在 _VLLM_MODELS ─► transformers backend（auto）
                  │
                  ▼
        逐个 arch 尝试:
            _normalize_arch(arch)            (registry.py:1110-1134)
            └─ 处理 ForConditionalGeneration / ForSequenceClassification
               与 runner_type/convert_type 的隐式映射
                  │
                  ▼
            找到 ─► _try_load_model_cls(arch) ─► nn.Module class
                  │
                  ▼
        仍未命中 ──► _raise_for_unsupported (含已下线、需 plugin 的提示)
```

</details>

`_PREVIOUSLY_SUPPORTED_MODELS` (`registry.py:700-709`) 保存“在 vLLM vX.Y 之前支持过、现在已移除”的架构，给用户友好提示。`_OOT_SUPPORTED_MODELS` (`registry.py:711-716`) 则把已下线的模型指向第三方 plugin。

### 8.2.5 外部注册

用户可在自己的 plugin 里 `ModelRegistry.register_model("MyArchForCausalLM", "my_pkg.modeling:MyArchForCausalLM")` (`registry.py:949-993`) 把模型挂进来，不需修改 vLLM 源码。

---

## 8.3 以 Llama 为例：模型如何写

`vllm/model_executor/models/llama.py` (601 行) 是其它模型的模板。完整层级如下：

<svg viewBox="0 0 880 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="LlamaForCausalLM 模块组成层级图">
  <defs>
    <marker id="r8ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">LlamaForCausalLM 模块组成与各 sub-module 职责</text>
  <g transform="translate(180, 36)">
    <rect x="0" y="0" width="520" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="260" y="15" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">LlamaForCausalLM</text>
    <text x="260" y="29" text-anchor="middle" font-size="9" fill="#9a3412">nn.Module, SupportsLoRA, SupportsPP, SupportsEagle, SupportsEagle3</text>
  </g>
  <g transform="translate(40, 92)">
    <rect x="0" y="0" width="540" height="380" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
    <text x="14" y="18" font-size="11" font-weight="700" fill="#9a3412">model: LlamaModel</text>
    <g transform="translate(20, 30)">
      <rect x="0" y="0" width="500" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" fill="#5b21b6">embed_tokens: VocabParallelEmbedding</text>
      <text x="490" y="16" text-anchor="end" font-size="10" fill="#6d28d9">仅 first PP rank</text>
    </g>
    <g transform="translate(20, 64)">
      <rect x="0" y="0" width="500" height="270" rx="3" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" font-weight="700" fill="#5b21b6">layers: ModuleList[LlamaDecoderLayer]</text>
      <text x="490" y="16" text-anchor="end" font-size="10" fill="#6d28d9">make_layers 按 PP rank 切分</text>
      <g transform="translate(14, 28)">
        <rect x="0" y="0" width="472" height="234" rx="3" fill="#ffffff" stroke="#cbd5e1" stroke-width="1"/>
        <text x="8" y="16" font-size="11" font-weight="600" fill="#475569">每个 LlamaDecoderLayer：</text>
        <g transform="translate(10, 24)">
          <rect x="0" y="0" width="452" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
          <text x="8" y="15" font-size="10" fill="#115e59">input_layernorm: RMSNorm</text>
        </g>
        <g transform="translate(10, 50)">
          <rect x="0" y="0" width="452" height="110" rx="3" fill="#ecfeff" stroke="#0d9488" stroke-width="1"/>
          <text x="8" y="14" font-size="11" font-weight="700" fill="#115e59">self_attn: LlamaAttention</text>
          <g transform="translate(8, 22)">
            <rect x="0" y="0" width="438" height="18" rx="2" fill="#ffffff" stroke="#94a3b8"/>
            <text x="6" y="13" font-size="10" fill="#475569">qkv_proj: QKVParallelLinear</text>
            <text x="432" y="13" text-anchor="end" font-size="9" fill="#64748b">q/k/v 融合</text>
          </g>
          <g transform="translate(8, 42)">
            <rect x="0" y="0" width="438" height="18" rx="2" fill="#ffffff" stroke="#94a3b8"/>
            <text x="6" y="13" font-size="10" fill="#475569">rotary_emb: RotaryEmbedding (get_rope)</text>
          </g>
          <g transform="translate(8, 62)">
            <rect x="0" y="0" width="438" height="18" rx="2" fill="#ffffff" stroke="#94a3b8"/>
            <text x="6" y="13" font-size="10" fill="#475569">attn: Attention</text>
            <text x="432" y="13" text-anchor="end" font-size="9" fill="#64748b">注册 KV cache、调度 backend</text>
          </g>
          <g transform="translate(8, 82)">
            <rect x="0" y="0" width="438" height="18" rx="2" fill="#ffffff" stroke="#94a3b8"/>
            <text x="6" y="13" font-size="10" fill="#475569">o_proj: RowParallelLinear</text>
            <text x="432" y="13" text-anchor="end" font-size="9" fill="#64748b">输出维度 all-reduce</text>
          </g>
        </g>
        <g transform="translate(10, 164)">
          <rect x="0" y="0" width="452" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
          <text x="8" y="15" font-size="10" fill="#115e59">post_attention_layernorm: RMSNorm</text>
          <text x="446" y="15" text-anchor="end" font-size="9" fill="#0f766e">与 residual 融合</text>
        </g>
        <g transform="translate(10, 190)">
          <rect x="0" y="0" width="452" height="38" rx="3" fill="#ecfeff" stroke="#0d9488" stroke-width="1"/>
          <text x="8" y="14" font-size="11" font-weight="700" fill="#115e59">mlp: LlamaMLP</text>
          <text x="8" y="26" font-size="10" fill="#0f766e">gate_up_proj: MergedColumnParallelLinear</text>
          <text x="220" y="26" font-size="10" fill="#0f766e">act_fn: SiluAndMul</text>
          <text x="340" y="26" font-size="10" fill="#0f766e">down_proj: RowParallelLinear</text>
        </g>
      </g>
    </g>
    <g transform="translate(20, 342)">
      <rect x="0" y="0" width="500" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" fill="#5b21b6">norm: RMSNorm</text>
      <text x="490" y="16" text-anchor="end" font-size="10" fill="#6d28d9">仅 last PP rank</text>
    </g>
  </g>
  <g transform="translate(600, 92)">
    <rect x="0" y="0" width="240" height="120" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
    <text x="120" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">PP 末端独占组件</text>
    <g transform="translate(14, 32)">
      <rect x="0" y="0" width="212" height="34" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="106" y="15" text-anchor="middle" font-size="11" font-weight="600" fill="#5b21b6">lm_head: ParallelLMHead</text>
      <text x="106" y="28" text-anchor="middle" font-size="9" fill="#6d28d9">可 tie embed_tokens 共享显存</text>
    </g>
    <g transform="translate(14, 72)">
      <rect x="0" y="0" width="212" height="34" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="106" y="15" text-anchor="middle" font-size="11" font-weight="600" fill="#5b21b6">logits_processor</text>
      <text x="106" y="28" text-anchor="middle" font-size="9" fill="#6d28d9">LogitsProcessor</text>
    </g>
  </g>
  <g transform="translate(40, 488)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">设计要点：</tspan><tspan x="0" dy="16">所有蓝色（紫）块都是「公共并行 layer」——TP/quant 的横切关注点全部下沉到 layers/，模型作者只描述拓扑；</tspan>
      <tspan x="0" dy="14">青色（teal）块是 attention 和 MLP 的「fused」入口——qkv_proj/gate_up_proj 把若干 HF 矩阵融合成单一 GPU buffer；</tspan>
      <tspan x="0" dy="14">PP 末端独占组件用 PPMissingLayer() 在其它 rank 占位，使 ModuleList 索引和 global layer index 仍对齐。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R8.2 ｜ LlamaForCausalLM 的模块层级；色块标出公共并行 layer（紫）vs fused 入口（青）；右侧框是 PP 末端 rank 独占的 lm_head + logits_processor</span>

<details>
<summary>ASCII 原版</summary>

```
LlamaForCausalLM (nn.Module, SupportsLoRA, SupportsPP, SupportsEagle, SupportsEagle3)
├── model: LlamaModel
│   ├── embed_tokens: VocabParallelEmbedding         # 仅 first PP rank
│   ├── layers: ModuleList[LlamaDecoderLayer]        # 经 make_layers 切分到本 PP rank
│   │   └── 每个 LlamaDecoderLayer：
│   │       ├── input_layernorm: RMSNorm
│   │       ├── self_attn: LlamaAttention
│   │       │   ├── qkv_proj: QKVParallelLinear      # 把 q/k/v 三个矩阵融合成一个
│   │       │   ├── rotary_emb: RotaryEmbedding (get_rope)
│   │       │   ├── attn: Attention                  # 注册 KV cache、调度 backend
│   │       │   └── o_proj: RowParallelLinear        # 输出维度 all-reduce
│   │       ├── post_attention_layernorm: RMSNorm    # 与 residual 融合
│   │       └── mlp: LlamaMLP
│   │           ├── gate_up_proj: MergedColumnParallelLinear
│   │           ├── act_fn: SiluAndMul
│   │           └── down_proj: RowParallelLinear
│   └── norm: RMSNorm                                # 仅 last PP rank
├── lm_head: ParallelLMHead                          # 仅 last PP rank，可 tie embed_tokens
└── logits_processor: LogitsProcessor
```

</details>

### 8.3.1 LlamaAttention：QKV 融合 + RoPE + Attention

来自 `llama.py:124-250`，关键片段：

```python
class LlamaAttention(nn.Module):
    def __init__(self, config, hidden_size, num_heads, num_kv_heads,
                 max_position_embeddings, quant_config, bias, bias_o_proj,
                 cache_config, prefix, attn_type):
        super().__init__()
        tp_size = get_tensor_model_parallel_world_size()
        self.total_num_heads = num_heads
        self.num_heads = self.total_num_heads // tp_size
        # GQA: kv_heads 不足 TP size 时复制
        self.num_kv_heads = max(1, num_kv_heads // tp_size)
        self.head_dim = getattr(config, "head_dim", None) or hidden_size // num_heads
        self.q_size  = self.num_heads * self.head_dim
        self.kv_size = self.num_kv_heads * self.head_dim
        self.scaling = self.head_dim ** -0.5

        self.qkv_proj = QKVParallelLinear(
            hidden_size, self.head_dim, num_heads, num_kv_heads,
            bias=bias, quant_config=quant_config, prefix=f"{prefix}.qkv_proj")
        self.o_proj = RowParallelLinear(
            num_heads * self.head_dim, hidden_size,
            bias=bias_o_proj, quant_config=quant_config, prefix=f"{prefix}.o_proj")

        self._init_rotary_emb(config, quant_config=quant_config)
        self.attn = Attention(
            self.num_heads, self.head_dim, self.scaling,
            num_kv_heads=self.num_kv_heads, cache_config=cache_config,
            quant_config=quant_config, prefix=f"{prefix}.attn")

    def forward(self, positions, hidden_states):
        qkv, _ = self.qkv_proj(hidden_states)                     # [T, q+k+v]/TP
        q, k, v = qkv.split([self.q_size, self.kv_size, self.kv_size], dim=-1)
        q, k = self.rotary_emb(positions, q, k)                   # RoPE
        attn_output = self.attn(q, k, v)                          # KV cache + flash/triton
        output, _ = self.o_proj(attn_output)                      # all-reduce
        return output
```

几个值得注意的点：

1. `qkv_proj` 是 `QKVParallelLinear`，weight 在 GPU 上是 `[(num_heads + 2*num_kv_heads)*head_dim/TP, hidden_size]` 的单个张量，但在 HF 检查点里仍是分开的 `q_proj.weight / k_proj.weight / v_proj.weight`。`LlamaModel.load_weights` 通过 `stacked_params_mapping` 把它们 fuse 到一起（§8.6.3）。
2. `o_proj` 是 `RowParallelLinear`，因为 attention 输出在 head 维已经 sharded；row parallel 自动在 forward 末尾做 all-reduce。
3. `rotary_emb` 由 `get_rope` (`rotary_embedding/__init__.py:33`) 工厂函数返回，根据 `rope_parameters` 字段自动选择 default RoPE / Llama3 scaling / YaRN / NTK / DeepSeek scaling / MRoPE / FoPE 等十几种变体之一，并按 `(head_size, rotary_dim, max_position, ...)` 缓存复用，避免重复构造 `cos/sin` cache。
4. `attn` 是 `vllm.model_executor.layers.attention.Attention`（§8.5），它在 `__init__` 里把自己注册到 `vllm_config.compilation_config.static_forward_context[prefix]`，是后续 KV cache 绑定与 `torch.compile` 跳过 attention 的关键。

### 8.3.2 LlamaMLP：SwiGLU 融合

`llama.py:81-121`：

```python
class LlamaMLP(nn.Module):
    def __init__(self, hidden_size, intermediate_size, hidden_act, ...):
        self.gate_up_proj = MergedColumnParallelLinear(
            input_size=hidden_size,
            output_sizes=[intermediate_size] * 2,   # gate 与 up 同尺寸，融合
            bias=bias, quant_config=quant_config, prefix=f"{prefix}.gate_up_proj")
        self.down_proj = RowParallelLinear(
            intermediate_size, hidden_size, ..., prefix=f"{prefix}.down_proj")
        self.act_fn = SiluAndMul()                  # silu(gate) * up

    def forward(self, x):
        x, _ = self.gate_up_proj(x)
        x = self.act_fn(x)
        x, _ = self.down_proj(x)
        return x
```

`MergedColumnParallelLinear` 与 `QKVParallelLinear` 是同一思路：把多个并列的列并行矩阵拼成一块连续 GPU buffer，发挥更大的 GEMM size，并把 weight 加载时的切分逻辑 (`shard_offset`, `shard_size`) 内置在 weight loader 里。

### 8.3.3 LlamaDecoderLayer：residual 与 fused-add-RMSNorm

`llama.py:253-337`：

```python
def forward(self, positions, hidden_states, residual):
    if residual is None:
        residual = hidden_states
        hidden_states = self.input_layernorm(hidden_states)
    else:
        # fused_add_rms_norm 在一个 kernel 内完成 residual + RMSNorm
        hidden_states, residual = self.input_layernorm(hidden_states, residual)
    hidden_states = self.self_attn(positions=positions, hidden_states=hidden_states)

    hidden_states, residual = self.post_attention_layernorm(hidden_states, residual)
    hidden_states = self.mlp(hidden_states)
    return hidden_states, residual
```

关键设计：**residual 不在 layer 内部相加，而是和 hidden_states 一起向外传**，由下一个 RMSNorm 的 `forward_native` 调用 `fused_add_rms_norm` 把 `add + RMSNorm` 合成一个 kernel（见 `layers/layernorm.py:82-102`）。这避免了在 layer 间反复读写一块 hidden tensor。

### 8.3.4 LlamaModel.forward 与 PP

`llama.py:340-434` 用 `@support_torch_compile` 装饰，使 `LlamaModel.__call__` 被 `vllm.compilation` 接管：

```python
def forward(self, input_ids, positions, intermediate_tensors,
            inputs_embeds=None, **extra_layer_kwargs):
    if get_pp_group().is_first_rank:
        hidden_states = inputs_embeds if inputs_embeds is not None \
                        else self.embed_input_ids(input_ids)
        residual = None
    else:                                              # 中间 / 末尾 PP rank
        hidden_states = intermediate_tensors["hidden_states"]
        residual = intermediate_tensors["residual"]

    for idx, layer in enumerate(islice(self.layers, self.start_layer, self.end_layer)):
        hidden_states, residual = layer(positions, hidden_states, residual,
                                        **extra_layer_kwargs)

    if not get_pp_group().is_last_rank:
        return IntermediateTensors({
            "hidden_states": hidden_states, "residual": residual})

    hidden_states, _ = self.norm(hidden_states, residual)
    return hidden_states
```

`make_layers` (`models/utils.py:620-652`) 根据 PP rank 把 `[0, start_layer)` 和 `[end_layer, N)` 替换成 `PPMissingLayer()` 占位，使 `ModuleList` 的索引和 global layer index 仍然对齐 —— 这非常关键，因为 `extract_layer_index(prefix)` 直接从字符串 `"model.layers.7.self_attn.attn"` 里解析出 layer id。

### 8.3.5 LlamaForCausalLM 与 packed_modules_mapping

`llama.py:501-589`：

```python
class LlamaForCausalLM(nn.Module, SupportsLoRA, SupportsPP, SupportsEagle, SupportsEagle3):
    packed_modules_mapping = {
        "qkv_proj":     ["q_proj", "k_proj", "v_proj"],
        "gate_up_proj": ["gate_proj", "up_proj"],
    }
    embedding_modules = {
        "embed_tokens": "input_embeddings",
        "lm_head":      "output_embeddings",
    }

    def __init__(self, *, vllm_config, prefix="", layer_type=LlamaDecoderLayer):
        super().__init__()
        config = vllm_config.model_config.hf_config
        quant_config = vllm_config.quant_config

        self.model = self._init_model(vllm_config=vllm_config,
                                      prefix=maybe_prefix(prefix, "model"))
        if get_pp_group().is_last_rank:
            self.lm_head = ParallelLMHead(config.vocab_size, config.hidden_size,
                                          quant_config=quant_config,
                                          prefix=maybe_prefix(prefix, "lm_head"))
            if config.tie_word_embeddings:
                self.lm_head = self.lm_head.tie_weights(self.model.embed_tokens)
            self.logits_processor = LogitsProcessor(config.vocab_size,
                                                    scale=getattr(config, "logit_scale", 1.0))
        else:
            self.lm_head = PPMissingLayer()

    def compute_logits(self, hidden_states):
        return self.logits_processor(self.lm_head, hidden_states)

    def load_weights(self, weights):
        loader = AutoWeightsLoader(
            self,
            skip_prefixes=(["lm_head."] if self.config.tie_word_embeddings else None))
        return loader.load_weights(weights)
```

`packed_modules_mapping` 给 LoRA 和 quant config 用，指明哪些 vLLM 内部 module 由哪些 HF module 合并而成；`embedding_modules` 告诉 LoRA 哪些 module 需要 special-case 处理（input/output embedding 上的 LoRA 形状不同）。

### 8.3.6 mixin 体系（SupportsXxx）

`vllm/model_executor/models/interfaces.py` 用 `typing.Protocol` 表达**可选能力**：

| Mixin | 必填属性/方法 | 文件位置 |
| --- | --- | --- |
| `SupportsLoRA` | `packed_modules_mapping`, `embedding_modules` | `interfaces.py:537-555` |
| `SupportsPP` | `make_empty_intermediate_tensors`, `forward(intermediate_tensors=...)` | `interfaces.py:615-650` |
| `SupportsMultiModal` | `_processor_factory`, `embed_multimodal`, `get_placeholder_str` | `interfaces.py:94-410` |
| `SupportsMultiModalPruning` | 裁剪不可见视觉 token | `interfaces.py:412-449` |
| `SupportsScoreTemplate` | reranker | `interfaces.py:493-535` |
| `HasInnerState` | 自带可变状态（mamba 系） | `interfaces.py:735-758` |
| `IsAttentionFree` | 没有 attention layer | `interfaces.py:761-786` |
| `IsHybrid` | 混合 attention + ssm | `interfaces.py:788-843` |
| `MixtureOfExperts` | 暴露 `num_moe_layers`, `num_experts_per_tok` 等 | `interfaces.py:845-928` |
| `SupportsQuant` | 模型类自行响应在线量化 | `interfaces.py:996-1037` |
| `SupportsTranscription` | ASR | `interfaces.py:1074-1239` |
| `SupportsEagle` / `SupportsEagle3` | 可被 EAGLE 推理加速 | `interfaces.py:1304+` |

Registry 在 inspect 阶段 (`registry.py:741-769`) 把这些 mixin 全部跑一遍 `isinstance` / `issubclass` 检查，结果记录在 `_ModelInfo` 里，调度器与 model runner 据此决定是否启用 PP / 是否开 prefix caching / 是否需要外部 multimodal processor 等。

---

## 8.4 公共 layer 库

### 8.4.1 并行 Linear 家族 (`layers/linear.py`)

四个核心类继承关系：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="vLLM 并行 Linear 类继承关系图">
  <defs>
    <marker id="r8ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">并行 Linear 家族：W 在哪一维被切，forward 末做不做 all-reduce</text>
  <g transform="translate(290, 40)">
    <rect x="0" y="0" width="180" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="90" y="18" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">LinearBase</text>
    <text x="90" y="32" text-anchor="middle" font-size="10" fill="#9a3412">PluggableLayer</text>
  </g>
  <path d="M 380 80 L 380 96 L 130 96 L 130 116" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <path d="M 380 96 L 380 116" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <path d="M 380 96 L 630 96 L 630 116" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <g transform="translate(30, 120)">
    <rect x="0" y="0" width="200" height="56" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
    <text x="100" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">ReplicatedLinear</text>
    <text x="100" y="34" text-anchor="middle" font-size="10" fill="#64748b">无 TP</text>
    <text x="100" y="48" text-anchor="middle" font-size="10" fill="#64748b">每张卡完整 [out, in]</text>
  </g>
  <g transform="translate(280, 120)">
    <rect x="0" y="0" width="200" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="100" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">ColumnParallelLinear</text>
    <text x="100" y="32" text-anchor="middle" font-size="10" fill="#0f766e">W 沿 output 维 sharded</text>
    <text x="100" y="46" text-anchor="middle" font-size="10" fill="#0f766e">每张卡 [out/TP, in]</text>
  </g>
  <g transform="translate(530, 120)">
    <rect x="0" y="0" width="200" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="100" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">RowParallelLinear</text>
    <text x="100" y="32" text-anchor="middle" font-size="10" fill="#6d28d9">W 沿 input 维 sharded</text>
    <text x="100" y="46" text-anchor="middle" font-size="10" fill="#6d28d9">每张卡 [out, in/TP] + all-reduce</text>
  </g>
  <path d="M 380 176 L 380 192 L 230 192 L 230 212" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <path d="M 380 176 L 380 192 L 530 192 L 530 212" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <g transform="translate(130, 216)">
    <rect x="0" y="0" width="200" height="56" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
    <text x="100" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">MergedColumnParallelLinear</text>
    <text x="100" y="32" text-anchor="middle" font-size="10" fill="#0f766e">多个输出维拼接</text>
    <text x="100" y="46" text-anchor="middle" font-size="10" fill="#0f766e">例：gate_up_proj</text>
  </g>
  <g transform="translate(430, 216)">
    <rect x="0" y="0" width="200" height="56" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
    <text x="100" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">QKVParallelLinear</text>
    <text x="100" y="32" text-anchor="middle" font-size="10" fill="#0f766e">q/k/v 拼接</text>
    <text x="100" y="46" text-anchor="middle" font-size="10" fill="#0f766e">特别处理 GQA 复制</text>
  </g>
  <g transform="translate(40, 290)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">读这张图：</tspan><tspan x="0" dy="16">一对 Column → Row 组成一个 attention/MLP 单元——Column 把激活在 head/intermediate 维切开各 TP rank 独立算；</tspan>
      <tspan x="0" dy="14">Row 接住已经切好的输入，最后通过一次 all-reduce 把部分和合并回 full hidden。整个单元只在末尾通信一次。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R8.3 ｜ 并行 Linear 类继承关系：青色族沿 output 维切（不通信或 all-gather），紫色族沿 input 维切（末尾必 all-reduce）；fused 子类降低 GEMM launch 次数</span>

<details>
<summary>ASCII 原版</summary>

```
LinearBase (PluggableLayer)
├── ReplicatedLinear              # 无 TP，每张卡完整副本
├── ColumnParallelLinear          # W 沿 output 维 sharded：每张卡 [out/TP, in]
│   ├── MergedColumnParallelLinear   # 多个输出维拼接（如 gate_up_proj）
│   └── QKVParallelLinear            # q/k/v 拼接，特别处理 GQA 复制
└── RowParallelLinear             # W 沿 input 维 sharded：每张卡 [out, in/TP]，forward 末 all-reduce
```

</details>

| 类 | 输入 | 输出 | weight 形状 (TP=N) | forward 末通信 |
| --- | --- | --- | --- | --- |
| `ColumnParallelLinear` (`linear.py:413`) | full hidden | sharded along output | `[out/N, in]` | 默认无；`gather_output=True` 时 all-gather |
| `MergedColumnParallelLinear` (`linear.py:610`) | full hidden | 多个 sharded 输出拼接 | `[(o1+o2+...)/N, in]` | 同上 |
| `QKVParallelLinear` (`linear.py:978`) | full hidden | q,k,v 拼接，head 维 sharded | `[(num_h + 2·num_kv_h)·head_dim/N, in]` | 同上 |
| `RowParallelLinear` (`linear.py:1395`) | sharded input | full output | `[out, in/N]` | all-reduce（`reduce_results=True`） |

**TP 语义直觉**：一对 column→row 组成一个 attention/MLP 单元 —— column 把激活在 head/intermediate 维切开，每张卡独立算自己的部分；row 接住已经被切开的输入，最后通过一次 all-reduce 把部分和合并回 full hidden。这样跨 TP 的通信被压到每个 attention/MLP 一次 all-reduce。

`QKVParallelLinear.__init__` (`linear.py:1006-1061`) 自动处理 GQA：

```python
if tp_size >= self.total_num_kv_heads:
    self.num_kv_heads = 1
    self.num_kv_head_replicas = tp_size // self.total_num_kv_heads   # KV head 被复制
else:
    self.num_kv_heads = self.total_num_kv_heads // tp_size
    self.num_kv_head_replicas = 1
self.output_sizes = [
    self.num_heads    * self.head_size * tp_size,   # q
    self.num_kv_heads * self.head_size * tp_size,   # k
    self.num_kv_heads * self.v_head_size * tp_size, # v
]
```

`output_sizes` 通过基类 `ColumnParallelLinear.__init__` 反推 `output_partition_sizes`，后者再交给 `quant_method.create_weights` 决定每个 logical 子矩阵在 GPU buffer 中的偏移。

每个 Linear class 都有一个 `weight_loader(param, loaded_weight, loaded_shard_id=...)`，它知道：

- 自己的 TP rank/size，因此能 `loaded_weight.narrow(output_dim, tp_rank * shard, shard)` 切自己那块；
- `loaded_shard_id` 是 `"q"/"k"/"v"` 或 fused index，因此能算出 `param_data.narrow(...)` 的写入目标；
- quantization adjustments（marlin tile、block-fp8 block_n、AWQ pack）；
- BitsAndBytes 已经按 rank 切好的特殊路径。

旧路径 `weight_loader` 与新路径 `weight_loader_v2` 并存。新路径仅适用于 `WEIGHT_LOADER_V2_SUPPORTED`（`linear.py:45-64`）中的 quant method，它把 narrow 逻辑下推到 `BasevLLMParameter` 的 `load_column_parallel_weight` / `load_qkv_weight` / `load_merged_column_weight` 上 (`parameter.py:99-200`)，使 parameter 而不是 layer 承担分片语义。

### 8.4.2 RMSNorm 与 fused-add (`layers/layernorm.py`)

`RMSNorm` (`layernorm.py:38-128`) 是 `CustomOp`，可根据后端 dispatch 到 native / cuda / xpu 实现。它的 `forward(x, residual=None)` 接受一个可选 residual：

```python
if residual is None:
    return ir.ops.rms_norm(x, weight, eps, var_size_override)
else:
    return ir.ops.fused_add_rms_norm.maybe_inplace(
        x, residual, weight, eps, var_size_override)
```

返回 `(normalized_x, new_residual)`，让 caller 在下一个 block 继续用 fused-add。`GemmaRMSNorm` (`layernorm.py:133`) 处理 Gemma 的 `(1 + w) * x` 变体；`RMSNormGated` 用于 mamba2；普通 `LayerNorm` 在 `layernorm.py:319`。

### 8.4.3 RotaryEmbedding (`layers/rotary_embedding/__init__.py`)

`get_rope` (`rotary_embedding/__init__.py:33-`) 是一个工厂 + 进程级缓存：

```python
_ROPE_DICT: dict[tuple, RotaryEmbedding] = {}

def get_rope(head_size, max_position, is_neox_style=True,
             rope_parameters=None, dtype=None,
             dual_chunk_attention_config=None):
    ...
    key = (head_size, rotary_dim, max_position, is_neox_style,
           rope_parameters_args, dual_chunk_attention_args, dtype)
    if key in _ROPE_DICT:
        return _ROPE_DICT[key]                       # 复用 cos/sin cache
    ...
```

`rope_parameters.rope_type` 选择具体实现：`default` / `linear` / `dynamic` / `yarn` / `llama3` / `longrope` / `mrope` / `deepseek_yarn` / `xdrope` / `fope` / `telechat3` 等。所有实现都来自 `rotary_embedding/` 下的同名文件，共享 `RotaryEmbeddingBase` 接口。`is_neox_style` 控制 cos/sin 排布（NeoX 的 `[d/2..d/2]` 与 GPT-J 的 `[0,2,4,...]`），由 `get_rope` 调用方决定。

### 8.4.4 VocabParallelEmbedding 与 ParallelLMHead

`layers/vocab_parallel_embedding.py:192-501` 把 vocab 维 sharded 到 TP ranks 上。两层关键 padding：

1. 把 `org_vocab_size` 上 padding 到 `DEFAULT_VOCAB_PADDING_SIZE`（通常 64），保证 GEMM 友好；
2. 留出 LoRA 追加 token 的空间，放在 base vocab 后；
3. 再做一次全局 padding。

布局示意（TP=2 的例子，原 vocab=1010，padding=64，LoRA=16）：

<svg viewBox="0 0 880 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="VocabParallelEmbedding 在 TP=1 与 TP=2 时的布局对比">
  <defs>
    <pattern id="r8padhatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="6" stroke="#cbd5e1" stroke-width="2"/>
    </pattern>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">VocabParallelEmbedding：原 vocab=1010，DEFAULT_PADDING=64，LoRA=16</text>
  <g transform="translate(40, 46)">
    <text x="0" y="0" font-size="12" font-weight="700" fill="currentColor">TP=1（单卡完整布局，总长 1088）</text>
    <g transform="translate(0, 12)">
      <rect x="0" y="0" width="492" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
      <text x="246" y="22" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">BASE 0..1009 (1010)</text>
      <rect x="492" y="0" width="68" height="36" fill="url(#r8padhatch)" stroke="#94a3b8" stroke-width="1"/>
      <text x="526" y="22" text-anchor="middle" font-size="10" fill="#475569">PAD 14</text>
      <rect x="560" y="0" width="78" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
      <text x="599" y="22" text-anchor="middle" font-size="11" font-weight="600" fill="#5b21b6">LoRA 1010..1025 (16)</text>
      <rect x="638" y="0" width="156" height="36" fill="url(#r8padhatch)" stroke="#94a3b8" stroke-width="1"/>
      <text x="716" y="22" text-anchor="middle" font-size="10" fill="#475569">LoRA PAD 32</text>
    </g>
    <g transform="translate(0, 56)" font-size="9" fill="#64748b">
      <text x="246" y="0" text-anchor="middle">1010 → padded to 1024</text>
      <text x="599" y="0" text-anchor="middle">16 → padded to 64 (但只用 16)</text>
    </g>
  </g>
  <line x1="40" y1="124" x2="840" y2="124" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <g transform="translate(40, 138)">
    <text x="0" y="0" font-size="12" font-weight="700" fill="currentColor">TP=2，按 vocab 维 shard 到两张卡（每 rank 负责自己 vocab 区间）</text>
    <g transform="translate(0, 16)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#9a3412">rank 0</text>
      <g transform="translate(60, 0)">
        <rect x="0" y="0" width="256" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
        <text x="128" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="#9a3412">BASE 0..511</text>
        <rect x="256" y="0" width="100" height="32" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
        <text x="306" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="#5b21b6">LoRA 1010..1025</text>
        <rect x="356" y="0" width="200" height="32" fill="url(#r8padhatch)" stroke="#94a3b8" stroke-width="1"/>
        <text x="456" y="20" text-anchor="middle" font-size="10" fill="#475569">LoRA PAD</text>
      </g>
    </g>
    <g transform="translate(0, 60)">
      <text x="0" y="14" font-size="11" font-weight="600" fill="#9a3412">rank 1</text>
      <g transform="translate(60, 0)">
        <rect x="0" y="0" width="256" height="32" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
        <text x="128" y="20" text-anchor="middle" font-size="10" font-weight="600" fill="#9a3412">BASE 512..1009</text>
        <rect x="256" y="0" width="100" height="32" fill="url(#r8padhatch)" stroke="#94a3b8" stroke-width="1"/>
        <text x="306" y="20" text-anchor="middle" font-size="10" fill="#475569">BASE PAD</text>
        <rect x="356" y="0" width="200" height="32" fill="url(#r8padhatch)" stroke="#94a3b8" stroke-width="1"/>
        <text x="456" y="20" text-anchor="middle" font-size="10" fill="#475569">LoRA PAD</text>
      </g>
    </g>
    <g transform="translate(60, 104)">
      <line x1="0" y1="0" x2="556" y2="0" stroke="#94a3b8"/>
      <line x1="0" y1="-4" x2="0" y2="4" stroke="#94a3b8"/>
      <line x1="556" y1="-4" x2="556" y2="4" stroke="#94a3b8"/>
      <text x="278" y="-6" text-anchor="middle" font-size="10" fill="#64748b">每 rank padded 长度相同：约 544（对齐到 padding 边界）</text>
    </g>
  </g>
  <g transform="translate(40, 268)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">读这张图：</tspan><tspan x="0" dy="16">base vocab 在 rank 间均分（rank0 拿前一半 token id，rank1 拿后一半）；</tspan>
      <tspan x="0" dy="14">LoRA 追加的 token 必须复制到所有 rank（蓝色块在两 rank 都出现）——否则任何 rank 都可能见到 LoRA token id；</tspan>
      <tspan x="0" dy="14">斜纹的 PAD 是 -1，forward 时被 get_masked_input_and_mask 屏蔽掉，输出做 all-reduce 把非本 rank 部分加成 0。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R8.4 ｜ VocabParallelEmbedding 的双重 padding 布局：BASE 在 TP rank 间分片，LoRA 复制到每 rank，斜纹 PAD 让所有 rank 长度对齐到 GEMM 友好边界</span>

<details>
<summary>ASCII 原版</summary>

```
TP=1:  [BASE 0..1009][BASE_PAD -1..-1][LORA 1010..1025][LORA_PAD -1..-1]
       <----- 1024 ----><----- 16 -----><----- 16 -----><----- 32 ----->

TP=2, rank0: [BASE 0..511][LORA 1010..1025][LORA_PAD -1..-1]
TP=2, rank1: [BASE 512..1009][BASE_PAD][LORA_PAD]
```

</details>

`get_masked_input_and_mask` (`vocab_parallel_embedding.py:163`) 在 forward 时把不属于本 rank 的 token id 屏蔽掉，输出再走 all-reduce 加和（属于本 rank 的位置非零，其它为零）。

`ParallelLMHead` (`vocab_parallel_embedding.py:503-567`) 继承 `VocabParallelEmbedding`，但 `forward` 故意 raise —— LM head 的 GEMM 是在 `LogitsProcessor` 里以 `lm_head.weight` 为参数显式调用的。`tie_weights(embed_tokens)` 让 `self.weight = embed_tokens.weight`，从而省一份显存（GGUF 因要先 dequantize，做法不同）。

### 8.4.5 激活函数 (`layers/activation.py`)

主要类（每个都是 `CustomOp`）：

| Class | 用途 |
| --- | --- |
| `SiluAndMul` | Llama/Mistral/Qwen 的 SwiGLU：`silu(gate) * up`，预期输入是 `[..., 2*intermediate]` |
| `MulAndSilu` | 顺序相反的变体 |
| `GeluAndMul`, `GeluAndMulSparse`, `SwigluOAIAndMul`, `SwigluStepAndMul`, `FatreluAndMul` | 其它族 |
| `GELU`, `NewGELU`, `FastGELU`, `QuickGELU`, `ReLUSquaredActivation`, `XIELU` | 单输入激活 |
| `ScaledActivation` | 对 activation 做静态/动态量化 scale 的 wrapper |

`get_act_fn(name)` (`activation.py:736`) 和 `get_act_and_mul_fn(name)` (`activation.py:764`) 是 string → class 的查找入口。

### 8.4.6 Attention layer wrapper (`layers/attention/`)

`__init__.py` 导出五个 wrapper（`attention/__init__.py:1-26`），都继承 `AttentionLayerBase`：

| Wrapper | 用途 | 关键不同点 |
| --- | --- | --- |
| `Attention` | 标准 decoder self-attention | 注册 KV cache，调度后端 |
| `EncoderOnlyAttention` | bidirectional/encoder-only | 不写 KV cache |
| `CrossAttention` | encoder-decoder（Whisper） | KV 来自 encoder |
| `ChunkedLocalAttention` | sliding-window 变体 | 与全局 attn 共存 |
| `MLAAttention` | DeepSeek 的 Multi-Latent Attention | 与普通 attn 完全不同的 KV 布局 |
| `MMEncoderAttention` | 视觉/音频 encoder | 不参与 LLM KV cache |
| `StaticSinkAttention` | StreamingLLM 风格 sink | 永久保留前 k 个 token |

见 §8.5 详细解析 `Attention`。

### 8.4.7 其它

- `quantization/` —— 30+ 种量化后端的 `LinearMethodBase` 实现（GPTQ / AWQ / FP8 / NVFP4 / TorchAO / BitsAndBytes / Marlin / FBGEMM / Quark / ModelOpt / Compressed-Tensors / Hummmingbird 等）；
- `mamba/`, `fla/`, `conv.py`, `kda.py`, `lightning_attn.py`, `sparse_attn_indexer.py` —— 非标准 token-mixer；
- `pooler/` —— embedding / reward / sequence classification 的池化操作；
- `logits_processor.py` —— 顶部的 `LogitsProcessor`，包装 `ParallelLMHead.weight` 做最后一次 GEMM；
- `deepseek_compressor.py`, `deepseek_v4_attention.py`, `mhc.py`, `mla.py` —— 特定模型的专用 layer。

---

## 8.5 模型如何调用 attention：`Attention` wrapper

`vllm/model_executor/layers/attention/attention.py` 中的 `Attention(nn.Module, AttentionLayerBase)`（`attention.py:177-611`）做四件事：

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Attention wrapper 的 forward 流程与左右依赖">
  <defs>
    <marker id="r8ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">Attention.forward 把 Q/K/V → output 的四个步骤，以及左右两侧的依赖来源</text>
  <g transform="translate(320, 38)">
    <rect x="0" y="0" width="240" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="120" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">forward(query, key, value)</text>
  </g>
  <path d="M 440 70 L 440 86" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
  <g transform="translate(280, 90)">
    <rect x="0" y="0" width="320" height="180" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <g transform="translate(12, 18)">
      <circle cx="10" cy="10" r="10" fill="#ea580c"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">1</text>
      <text x="28" y="14" font-size="11" fill="currentColor">（可选）calc kv_scales / quant Q</text>
    </g>
    <g transform="translate(12, 56)">
      <circle cx="10" cy="10" r="10" fill="#ea580c"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">2</text>
      <text x="28" y="14" font-size="11" fill="currentColor">reshape Q/K/V 到 (T, H, D)</text>
    </g>
    <g transform="translate(12, 94)">
      <circle cx="10" cy="10" r="10" fill="#ea580c"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">3</text>
      <text x="28" y="14" font-size="11" fill="currentColor">调用后端：</text>
      <text x="40" y="110" font-size="10" fill="#7c2d12" font-style="italic">unified_attention_with_output</text>
      <text x="40" y="124" font-size="10" fill="#7c2d12" font-style="italic">unified_kv_cache_update</text>
    </g>
    <g transform="translate(12, 148)">
      <circle cx="10" cy="10" r="10" fill="#ea580c"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">4</text>
      <text x="28" y="14" font-size="11" fill="currentColor">reshape 回 (T, hidden) 返回</text>
    </g>
  </g>
  <path d="M 280 180 L 248 180" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)" stroke-dasharray="3,2"/>
  <path d="M 600 180 L 632 180" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)" stroke-dasharray="3,2"/>
  <g transform="translate(20, 100)">
    <rect x="0" y="0" width="228" height="160" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
    <text x="114" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">self.attn_backend</text>
    <text x="114" y="32" text-anchor="middle" font-size="10" fill="#0f766e">get_attn_backend(...)</text>
    <line x1="10" y1="42" x2="218" y2="42" stroke="#94a3b8" stroke-dasharray="2,2"/>
    <text x="14" y="58" font-size="10" fill="currentColor">FLASH_ATTN</text>
    <text x="120" y="58" font-size="10" fill="currentColor">FLASHINFER</text>
    <text x="14" y="74" font-size="10" fill="currentColor">TRITON_ATTN</text>
    <text x="120" y="74" font-size="10" fill="currentColor">FLEX_ATTENTION</text>
    <text x="14" y="88" font-size="10" fill="#94a3b8">...</text>
    <line x1="10" y1="98" x2="218" y2="98" stroke="#94a3b8" stroke-dasharray="2,2"/>
    <text x="114" y="114" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">impl_cls(...)</text>
    <text x="14" y="130" font-size="9" fill="#0f766e">num_heads, head_dim, scale,</text>
    <text x="14" y="142" font-size="9" fill="#0f766e">num_kv_heads, sliding_window,</text>
    <text x="14" y="154" font-size="9" fill="#0f766e">kv_cache_dtype, attn_type, ...</text>
  </g>
  <g transform="translate(632, 100)">
    <rect x="0" y="0" width="228" height="160" rx="6" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="114" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">forward_context</text>
    <text x="114" y="32" text-anchor="middle" font-size="10" fill="#6d28d9">由 model runner 注入</text>
    <line x1="10" y1="42" x2="218" y2="42" stroke="#94a3b8" stroke-dasharray="2,2"/>
    <text x="14" y="60" font-size="10" fill="currentColor">attn_metadata</text>
    <text x="14" y="74" font-size="9" fill="#6d28d9">  block tables / slot_mapping / ...</text>
    <text x="14" y="94" font-size="10" fill="currentColor">no_compile_layers[prefix]</text>
    <text x="14" y="108" font-size="9" fill="#6d28d9">  → self（layer 自我注册）</text>
    <line x1="10" y1="120" x2="218" y2="120" stroke="#94a3b8" stroke-dasharray="2,2"/>
    <text x="14" y="138" font-size="10" fill="#5b21b6">使 torch.compile 把整个</text>
    <text x="14" y="150" font-size="10" fill="#5b21b6">attention 当 opaque op 跳过</text>
  </g>
  <g transform="translate(40, 290)">
    <text x="0" y="0" font-size="11" fill="currentColor"><tspan font-weight="700" fill="#475569">读这张图：</tspan><tspan x="0" dy="16">Attention 是模型与 KV cache 管理器、attention backend 的唯一耦合点——左侧 backend 决定 kernel 路径，</tspan>
      <tspan x="0" dy="14">右侧 forward_context 把"本 step 这个 layer 要用的 KV cache / block table"按 prefix 名查回来；</tspan>
      <tspan x="0" dy="14">这种"layer 在 __init__ 时把自己挂到 static_forward_context"的模式让模型代码完全不需要传 attn_metadata 参数。</tspan>
    </text>
  </g>
</svg>
<span class="figure-caption">图 R8.5 ｜ Attention wrapper 的 forward 流程：中间 4 步是核心，左侧由 get_attn_backend 决定的 backend + impl 提供 kernel，右侧 forward_context 提供 per-step KV cache 与 block table 数据</span>

<details>
<summary>ASCII 原版</summary>

```
                    forward(query, key, value)
                              │
                              ▼
            ┌──────────────────────────────────────┐
            │ 1. （可选）calc kv_scales / quant Q   │
            │ 2. reshape Q/K/V 到 (T, H, D)         │
            │ 3. 调用后端 unified_attention_with_   │
            │    output / unified_kv_cache_update   │
            │ 4. reshape 回 (T, hidden) 返回        │
            └──────────────────────────────────────┘
                              │
        ┌─────────────────────┴─────────────────────┐
        ▼                                           ▼
self.attn_backend = get_attn_backend(...)   forward_context（由 model runner 注入）
  - FLASH_ATTN / FLASHINFER /                  - attn_metadata (block tables, ...)
    TRITON_ATTN / FLEX_ATTENTION / ...          - no_compile_layers[prefix] = self
  - impl_cls(num_heads, head_dim, scale,
    num_kv_heads, sliding_window,
    kv_cache_dtype, attn_type, ...)
```

</details>

`__init__` 中的关键步骤（`attention.py:189-435`）：

1. 解析 `cache_config`、`kv_cache_dtype`、`per_layer_sliding_window`；处理 `quant_config.kv_cache_scheme` 与 `cache_config.kv_cache_dtype_skip_layers`（按 layer index 或 sliding 标识跳过 FP8 KV cache）。
2. `get_attn_backend(head_size, dtype, kv_cache_dtype, use_mla=False, ...)` 选 backend；不同 head_size / dtype / kv_cache_dtype / sliding / has_sink 组合可能落到不同 backend。
3. `impl = backend.get_impl_cls()(...)` —— backend 自带一个 `AttentionImpl` 子类负责真正 kernel 调用。
4. `compilation_config.static_forward_context[prefix] = self` —— 把自己挂到 forward context，使后续 `forward_context.no_compile_layers[layer_name]` 能 O(1) 找回 layer 实例。`prefix` 必须全局唯一（重名会抛错）。
5. `self.kv_cache = torch.tensor([])` —— 占位，真正的 KV cache buffer 由 `bind_kv_cache` 在 worker 启动后写入（参考第 7 章 KV cache 章节）。
6. `_init_kv_cache_quant(self, quant_config, prefix)` —— 注册 `_k_scale / _v_scale / _q_scale / _prob_scale` 为 buffer。这些 buffer 必须在 state_dict 中存在，否则 `.to(device)` 不会搬运它们（`attention.py:138-152` 的 Note 详细解释）。

`forward` (`attention.py:437-529`) 在 `use_direct_call=True`（CUDA/ROCm/CPU）时直接调用 `unified_attention_with_output(...)`；否则通过 `torch.ops.vllm.unified_attention_with_output` 走 dispatcher，让 `torch.compile` 把整个 attention 当作 opaque op 跳过。`maybe_calc_kv_scales` (`attention.py:613-645`) 是注册的 `direct_register_custom_op`，第一次 forward 会扫描 Q/K/V 的最大绝对值估计 FP8 scale 并存到 layer 上，之后置 `calculate_kv_scales=False`。

`get_kv_cache_spec(vllm_config)` (`attention.py:566-610`) 返回 `FullAttentionSpec` / `SlidingWindowSpec` / `TQFullAttentionSpec`，告诉 KVCacheManager 这一层需要多大、何种 dtype、是否 sliding。这是 model 与 KV cache manager 唯一的耦合点。

`process_weights_after_loading(act_dtype)` (`attention.py:549-561`) 由 `model_loader/utils.py:115-122` 在权重全部 load 完后调用，用来：

- 让 backend impl 把 quant tensor 重排成 kernel 期望的布局；
- 在 quant method 不要求 load scale 时把 `_k_scale / _v_scale` 重置为 1.0（避免 dummy weights 留下的脏值，`attention.py:138-152` Note）。

---

## 8.6 模型加载：从 checkpoint 到 GPU parameter

### 8.6.1 入口与 load format 分发

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="get_model 入口的调用链与 load format 分发">
  <defs>
    <marker id="r8ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">get_model 入口的调用链与 BaseModelLoader.load_model 的五段式</text>
  <g transform="translate(220, 38)">
    <rect x="0" y="0" width="320" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="160" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">get_model(vllm_config)</text>
    <text x="160" y="28" text-anchor="middle" font-size="9" fill="#9a3412">model_loader/__init__.py:128</text>
  </g>
  <path d="M 380 72 L 380 88" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar5)"/>
  <g transform="translate(220, 92)">
    <rect x="0" y="0" width="320" height="34" rx="6" fill="#fef3c7" stroke="#facc15" stroke-width="1.2"/>
    <text x="160" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="#92400e">get_model_loader(load_config)</text>
    <text x="160" y="28" text-anchor="middle" font-size="9" fill="#92400e">__init__.py:120</text>
  </g>
  <path d="M 380 126 L 380 142" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar5)"/>
  <g transform="translate(120, 146)">
    <rect x="0" y="0" width="520" height="34" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1.2"/>
    <text x="260" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">loader = _LOAD_FORMAT_TO_MODEL_LOADER[load_format](load_config)</text>
  </g>
  <path d="M 380 180 L 380 196" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar5)"/>
  <g transform="translate(60, 200)">
    <rect x="0" y="0" width="640" height="230" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="320" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">loader.load_model(vllm_config, model_config, prefix)</text>
    <text x="320" y="34" text-anchor="middle" font-size="10" fill="#6d28d9">base_loader.py:42</text>
    <g transform="translate(20, 50)">
      <circle cx="10" cy="10" r="10" fill="#7c3aed"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">1</text>
      <text x="28" y="14" font-size="11" font-weight="600" fill="currentColor">initialize_model(...)</text>
      <text x="28" y="28" font-size="9" fill="#6d28d9">在 set_default_torch_dtype + target_device 上下文里调 model_class(vllm_config, prefix)</text>
    </g>
    <g transform="translate(20, 90)">
      <circle cx="10" cy="10" r="10" fill="#7c3aed"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">2</text>
      <text x="28" y="14" font-size="11" font-weight="600" fill="currentColor">log_model_inspection(model)</text>
      <text x="28" y="28" font-size="9" fill="#6d28d9">可选；打印 param 数 / dtype 摘要</text>
    </g>
    <g transform="translate(20, 130)">
      <circle cx="10" cy="10" r="10" fill="#7c3aed"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">3</text>
      <text x="28" y="14" font-size="11" font-weight="600" fill="currentColor">self.load_weights(model, model_config)</text>
      <text x="28" y="28" font-size="9" fill="#6d28d9">子类实现：DefaultModelLoader / BitsAndBytesModelLoader / GGUFModelLoader / ...</text>
    </g>
    <g transform="translate(20, 170)">
      <circle cx="10" cy="10" r="10" fill="#7c3aed"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">4</text>
      <text x="28" y="14" font-size="11" font-weight="600" fill="currentColor">finalize_layerwise_processing(...)</text>
      <text x="28" y="28" font-size="9" fill="#6d28d9">在线量化收尾（如果开启）</text>
    </g>
    <g transform="translate(20, 200)">
      <circle cx="10" cy="10" r="10" fill="#7c3aed"/>
      <text x="10" y="14" text-anchor="middle" font-size="11" font-weight="700" fill="white">5</text>
      <text x="28" y="14" font-size="11" font-weight="600" fill="currentColor">process_weights_after_loading(model, model_config, target_device)</text>
      <text x="40" y="28" font-size="9" fill="#6d28d9">├─ 每个 quant_method.process_weights_after_loading</text>
    </g>
    <text x="68" y="222" font-size="9" fill="#6d28d9">└─ 每个 Attention/MLA layer.process_weights_after_loading</text>
  </g>
</svg>
<span class="figure-caption">图 R8.6 ｜ get_model 三步调用链：① 工厂选 loader → ② loader 实例化 → ③ 统一五段式 load_model（init 模型 / 加载权重 / 在线 quant / KV scale 后处理）</span>

<details>
<summary>ASCII 原版</summary>

```
get_model(vllm_config) [model_loader/__init__.py:128]
        │
        ▼
get_model_loader(load_config) [__init__.py:120]
        │
        ▼
loader = _LOAD_FORMAT_TO_MODEL_LOADER[load_format](load_config)
        │
        ▼
loader.load_model(vllm_config, model_config, prefix)  [base_loader.py:42]
        ├─ initialize_model(...)  # 在 set_default_torch_dtype + target_device 上下文里
        │     └─ model_class(vllm_config=..., prefix=...)
        ├─ log_model_inspection(model)                        # 可选
        ├─ self.load_weights(model, model_config)             # 子类实现
        ├─ finalize_layerwise_processing(...)                 # 在线 quant
        └─ process_weights_after_loading(model, model_config, target_device)
              ├─ 调每个 quant_method.process_weights_after_loading
              └─ 调每个 Attention/MLA layer.process_weights_after_loading
```

</details>

`_LOAD_FORMAT_TO_MODEL_LOADER` (`model_loader/__init__.py:48-64`) 是 load format → loader 类的表：

| load_format | loader | 用途 |
| --- | --- | --- |
| `auto` / `hf` / `safetensors` / `fastsafetensors` / `instanttensor` / `mistral` / `pt` / `npcache` | `DefaultModelLoader` | 标准 HF 仓库 |
| `bitsandbytes` | `BitsAndBytesModelLoader` | bnb 4/8bit |
| `dummy` | `DummyModelLoader` | 随机权重，用于 profile / unit test |
| `gguf` | `GGUFModelLoader` | llama.cpp 兼容 |
| `runai_streamer` | `RunaiModelStreamerLoader` | RunAI 流式 |
| `runai_streamer_sharded`, `sharded_state` | `ShardedStateLoader` | 已 TP-切分的本地 ckpt |
| `tensorizer` | `TensorizerLoader` | CoreWeave Tensorizer |

可用 `@register_model_loader("my_loader")` (`model_loader/__init__.py:67-117`) 注册自定义 loader，例如读 S3、读 webdataset。

### 8.6.2 `DefaultModelLoader` 的工作流

`model_loader/default_loader.py:43-437` 是日常使用的核心。`load_weights` 的关键流程：

```
load_weights(model, model_config):
    _init_ep_weight_filter(model_config)         # MoE EP rank 计算本地 expert id 集合
    weights_iter = self.get_all_weights(model_config, model)
    loaded = model.load_weights(weights_iter)    # 把 (name, tensor) 流推给模型
    if enable_weights_track: 校验所有 named_parameters 都被覆盖过
```

`get_all_weights` (`default_loader.py:288-307`) 把 primary + 多个 secondary 权重源 (`model.secondary_weights`) 串成单个 iterator。`_get_weights_iterator` (`default_loader.py:211-286`) 根据 load_format 选择具体迭代器：

| 迭代器 | 文件位置 |
| --- | --- |
| `safetensors_weights_iterator` | `weight_utils.py:893` |
| `multi_thread_safetensors_weights_iterator` | 同文件，启用 `enable_multithread_load=True` |
| `fastsafetensors_weights_iterator` | 走 `fastsafetensors` C++ 实现 |
| `instanttensor_weights_iterator` | 极速本地 mmap |
| `np_cache_weights_iterator` | `.bin`→ numpy mmap 缓存，二次启动加速 |
| `pt_weights_iterator` / `multi_thread_pt_weights_iterator` | 退路：`*.pt` |

`safetensors_weights_iterator` 会：

1. 自然顺序排序文件，使 layer 顺序贴近 GPU 上的 layer 顺序；
2. 探测文件系统类型（NFS / Lustre / 本地）；
3. 当判断为 net-fs 且 ckpt 装得下 RAM 时，后台启 `safetensors_prefetch` 把文件搬进 page cache；
4. 用 `safe_open(...)` 流式产出 `(name, tensor)`；如果传了 `local_expert_ids`，在 yield 前就过滤非本 rank 的 expert，**避免读盘**（`ep_weight_filter.should_skip_weight`）。

### 8.6.3 模型侧的 `load_weights`：以 Llama 为例

`models/llama.py:436-498` 的 `LlamaModel.load_weights` 展示了几乎所有模型都会用的模式：

```python
def load_weights(self, weights: Iterable[tuple[str, torch.Tensor]]) -> set[str]:
    stacked_params_mapping = [
        # (vllm_param_name, hf_shard_name, shard_id)
        (".qkv_proj",     ".q_proj",    "q"),
        (".qkv_proj",     ".k_proj",    "k"),
        (".qkv_proj",     ".v_proj",    "v"),
        (".gate_up_proj", ".gate_proj",  0),
        (".gate_up_proj", ".up_proj",    1),
    ]
    params_dict = dict(self.named_parameters())
    loaded_params: set[str] = set()
    for name, loaded_weight in weights:
        if "rotary_emb.inv_freq" in name: continue
        if "rotary_emb.cos_cached" in name or "rotary_emb.sin_cached" in name: continue
        if self.quant_config is not None and (
            scale_name := self.quant_config.get_cache_scale(name)):
            # KV cache 量化 scale（每模型不同位置）
            param = params_dict[scale_name]
            param.weight_loader(param, loaded_weight if loaded_weight.dim() == 0
                                       else loaded_weight[0])
            loaded_params.add(scale_name); continue
        if "scale" in name or "zero_point" in name:
            name = maybe_remap_kv_scale_name(name, params_dict)   # §8.6.4
            if name is None: continue
        for param_name, weight_name, shard_id in stacked_params_mapping:
            if weight_name not in name: continue
            name = name.replace(weight_name, param_name)
            if name.endswith(".bias") and name not in params_dict: continue
            if is_pp_missing_parameter(name, self): continue       # PP rank 外
            param = params_dict[name]
            param.weight_loader(param, loaded_weight, shard_id)    # 走 layer 内的 weight_loader
            break
        else:
            # 普通直传：embed_tokens / layernorm.weight / o_proj / down_proj / ...
            if name.endswith(".bias") and name not in params_dict: continue
            if is_pp_missing_parameter(name, self): continue
            param = params_dict[name]
            getattr(param, "weight_loader", default_weight_loader)(param, loaded_weight)
        loaded_params.add(name)
    return loaded_params
```

要点：

- **`stacked_params_mapping` 是 HF→vLLM 名称映射的核心**。HF 给的是 `model.layers.0.self_attn.q_proj.weight`，vLLM 内部 parameter 是 `model.layers.0.self_attn.qkv_proj.weight`；mapping 表把 HF 名替换成 vLLM 名，并附带 `shard_id`，`QKVParallelLinear.weight_loader` 据此把张量切到正确偏移。MLP 的 `gate_proj` / `up_proj` 用 int shard id (0/1) 给 `MergedColumnParallelLinear`。
- **`param.weight_loader` 是 per-parameter 的闭包**，由 layer 在 `__init__` 时通过 `quant_method.create_weights(... weight_loader=self.weight_loader)` 注入。Llama 这里因此完全不关心 quant 细节：是 fp16 / fp8 / gptq / awq 走的都是同一段代码。
- `is_pp_missing_parameter` (`models/utils.py:677-685`) 检查 name 是否落在某个 `PPMissingLayer` 下面；如果是则忽略，因为这一层根本不在本 PP rank。
- 返回 `loaded_params: set[str]` 让 `DefaultModelLoader.track_weights_loading` (`default_loader.py:414-437`) 校验 `weights_to_load - loaded_params` 为空（在线 quant scale 等可豁免）。

### 8.6.4 `AutoWeightsLoader`：简化 `load_weights`

很多模型的 `load_weights` 形式高度类似，因此 `models/utils.py:117-356` 提供 `AutoWeightsLoader`，递归走 `named_children` + `named_parameters`，自动把权重路由到子模块的 `load_weights` 或参数的 `weight_loader`：

```python
class LlamaForCausalLM(...):
    def load_weights(self, weights):
        loader = AutoWeightsLoader(
            self,
            skip_prefixes=(["lm_head."] if self.config.tie_word_embeddings else None))
        return loader.load_weights(weights)
```

注意：`LlamaForCausalLM.load_weights` 用 `AutoWeightsLoader` 把流转给 `self.model`（即 `LlamaModel`），后者自己实现了 §8.6.3 的细粒度逻辑。当 `tie_word_embeddings=True` 时 `lm_head.*` 不存在于 ckpt，skip 掉。

`WeightsMapper` (`models/utils.py:44-114`) 是另一类常用工具：当一个 vllm 模型复用别的 base model 的代码但 HF 的命名有 prefix 差异时（例如 `language_model.model.layers.x` vs `model.layers.x`），可以在 wrapper 模型的 `load_weights` 顶部用 `WeightsMapper(orig_to_new_prefix={"language_model.": ""}).apply(weights)` 把流先 rename 再喂给底层。

### 8.6.5 KV scale 名字的 remap

`maybe_remap_kv_scale_name` (`model_loader/weight_utils.py:1526-1605`) 处理常见的 8 种 quant 厂商命名：

```
HF 原名                                          → vllm 名
.kv_scale (deprecated)                          → .attn.k_scale (同时复制到 v_scale)
.self_attn.k_proj.k_scale                       → .self_attn.attn.k_scale
.self_attn.qkv_proj.k_scale (ModelOpt 已 fuse)  → .self_attn.attn.k_scale
.self_attn.qkqkv_proj.k_scale (Qwen3 MoE)       → .self_attn.attn.k_scale
.mixer.k_proj.k_scale (NemotronH)               → .mixer.attn.k_scale
.self_attn.q.scale (HYV3)                       → .self_attn.attn.q_scale
.self_attn.k_cache.scale (HYV3)                 → .self_attn.attn.k_scale
.k_scale / .v_scale / .q_scale (default)        → .attn.{k,v,q}_scale
```

`Attention.__init__` 注册的 `_k_scale / _v_scale / _q_scale` 在 state_dict 中以 `prefix.attn.k_scale` 的形式存在，因此 remap 后能正确匹配。

### 8.6.6 parameter 自带 weight loader：`BasevLLMParameter`

`vllm/model_executor/parameter.py:31-127` 定义 `BasevLLMParameter`：

```python
class BasevLLMParameter(Parameter):
    def __new__(cls, data, **kwargs):
        return super().__new__(cls, data=data, requires_grad=False)

    def __init__(self, data, weight_loader: Callable):
        from vllm.platforms import current_platform
        if current_platform.use_sync_weight_loader():
            weight_loader = current_platform.make_synced_weight_loader(weight_loader)
        self._weight_loader = weight_loader
        self.tp_rank = get_tensor_model_parallel_rank()
        self.tp_size = get_tensor_model_parallel_world_size()

    @property
    def weight_loader(self) -> Callable: return self._weight_loader

    def load_column_parallel_weight(self, loaded_weight): self._assert_and_load(loaded_weight)
    def load_row_parallel_weight   (self, loaded_weight): self._assert_and_load(loaded_weight)
    def load_merged_column_weight  (self, loaded_weight, **kw): self._assert_and_load(loaded_weight)
    def load_qkv_weight            (self, loaded_weight, **kw): self._assert_and_load(loaded_weight)
```

子类细化分片语义（`parameter.py:129-`）：

| Parameter 子类 | 语义 |
| --- | --- |
| `_ColumnvLLMParameter` | 知道自己的 `output_dim`，按 TP rank narrow |
| `RowvLLMParameter` | 知道自己的 `input_dim`，按 TP rank narrow input |
| `ModelWeightParameter` | column + row 都支持，标准 dense 矩阵 |
| `PackedColumnParameter`, `PackedvLLMParameter` | 处理 AWQ / GPTQ 的 packed dim |
| `PerTensorScaleParameter` | scalar scale，按 fused index 写入 |
| `BlockQuantScaleParameter` | FP8 block-wise scale，按 block_n 取整 |
| `ChannelQuantScaleParameter`, `GroupQuantScaleParameter` | per-channel / per-group scale |

这种设计让模型 `load_weights` 完全不需要分支 quant 类型 —— 它只需要拿到 parameter，调 `param.weight_loader(param, loaded_weight, shard_id)`，每个 parameter 子类自己知道 narrow 哪一维、按 group size 取整、要不要乘 marlin tile 等。

> **为什么不直接用 `torch.nn.Parameter` + `param.shard_id_offset` 这样的属性？** 因为 quant 后端非常多（GPTQ / AWQ / FP8 / NVFP4 / TorchAO ...），每个都有不同的 packing/shape；如果 layer 端去 dispatch，每加一个新 quant 就要改所有 Linear 类。让 parameter 类自描述能力，把分片协议（shard_offset, shard_size, shard_id, num_heads）固化成基类方法，新增 quant 只需添加一个 Parameter 子类。

### 8.6.7 其它 loader 简介

| Loader | 文件 | 使用场景与关键点 |
| --- | --- | --- |
| `ShardedStateLoader` | `sharded_state_loader.py:29-` | 假设 ckpt 已按 `(tp_rank, pp_rank)` 切好（vLLM 自己 dump 的格式），跳过 narrow，按 rank 直接 mmap |
| `TensorizerLoader` | `tensorizer_loader.py:43-` | 走 CoreWeave Tensorizer 协议，把整模型序列化成一个流式 blob，启动极快 |
| `RunaiModelStreamerLoader` | `runai_streamer_loader.py` | RunAI 的并行流式 |
| `BitsAndBytesModelLoader` | `bitsandbytes_loader.py:56-` | 在线 4/8bit 量化加载，weight 形状已是 quantized；调用 `param.use_bitsandbytes_4bit=True` 路径 |
| `GGUFModelLoader` | `gguf_loader.py:38-` | llama.cpp `.gguf`，weight 是 UninitializedParameter，加载时才 materialize |
| `DummyModelLoader` | `dummy_loader.py:22-` | 给 parameter 填随机数，用于 max_num_seqs profiling |

`BaseModelLoader.load_model` 统一调度 `process_weights_after_loading` 与 `finalize_layerwise_processing`，从而所有 loader 都享受同一套 quant 后处理 / KV scale 初始化 / 设备搬运逻辑。

---

## 8.7 MoE 模型：FusedMoE 与 EP

### 8.7.1 `FusedMoE` (`layers/fused_moe/layer.py:73`)

```python
class FusedMoE(PluggableLayer):
    """FusedMoE layer for MoE models.

    This layer contains both MergedColumnParallel weights (gate_up_proj / w13)
    and RowParallelLinear weights (down_proj / w2).

    Note: Mixtral uses w1/w2/w3 for gate/up/down; we keep that convention
    internally and handle any remapping in load_weights of each model.
    """
```

构造参数包含 `num_experts`, `top_k`, `intermediate_size`, `tp_size`, `ep_size`, `dp_size`, `pcp_size`, `enable_eplb`, `num_redundant_experts`, `expert_mapping`, `n_shared_experts`, `routed_scaling_factor`, `activation`, ...。

它在内部把所有 expert 的 `gate_up_proj` 与 `down_proj` 合并成两个大 3D tensor `w13_weight: [num_local_experts, 2*intermediate, hidden]` 与 `w2_weight: [num_local_experts, hidden, intermediate]`，提供 `weight_loader(param, loaded_weight, weight_name, shard_id, expert_id)` 给 model 调用，知道：

- 当前是 EP 模式还是 TP 模式（或两者复合）；
- 把 `gate_proj` / `up_proj` / `down_proj` 哪个轴 narrow 到本 rank；
- expert_id 是否落在本 rank 的 local expert set 内。

模型侧（例如 `mixtral.py`, `deepseek_v2.py`, `qwen3_moe.py`）的 `load_weights` 通过 `model.get_expert_mapping()` 拿到 `[(param_name, weight_name, expert_id, shard_id), ...]` 三/四元组，遍历 ckpt 时识别 `experts.{eid}.{w1,w2,w3}.weight` 并 dispatch。

### 8.7.2 EP weight 过滤

`DefaultModelLoader._init_ep_weight_filter` (`default_loader.py:318-379`) 在 ckpt 流之前计算本 rank 的 `local_expert_ids: set[int]`：

```
ep_size = dp_size * pcp_size * tp_size
ep_rank = dp_rank*pcp_size*tp_size + pcp_rank*tp_size + tp_rank
local_expert_ids = compute_local_expert_ids(num_experts, ep_size, ep_rank,
                                            placement=expert_placement_strategy)
```

这个集合传入 `safetensors_weights_iterator`，后者在 yield 前用 `should_skip_weight(name, local_expert_ids)` (`ep_weight_filter.py`) 把不属于本 rank 的 expert 文件**跳过读取**。对于 16x 甚至 128x experts 的 MoE，这把启动 IO 减少 10x+。

EPLB（Expert-Parallel Load Balancing）开启时不能预过滤 —— 一个 logical expert 可能映射到多个 physical slot，weight loader 需要看到所有 expert 才能正确填充冗余 slot；`_init_ep_weight_filter` 检测 `enable_eplb=True` 时直接 return。

---

## 8.8 ASCII 总览：从启动到第一个 forward

<svg viewBox="0 0 880 760" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="从 VllmConfig 到 ModelRunner 持有 model 的完整调用链">
  <defs>
    <marker id="r8ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">从 VllmConfig 到 ModelRunner 持有 model 的完整调用链</text>
  <g transform="translate(360, 36)">
    <rect x="0" y="0" width="160" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="80" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#9a3412">VllmConfig</text>
  </g>
  <path d="M 200 100 L 200 84 L 440 84 L 440 68" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M 440 84 L 440 68" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M 680 100 L 680 84 L 440 84 L 440 68" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <g transform="translate(120, 102)">
    <rect x="0" y="0" width="160" height="56" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">ModelConfig</text>
    <text x="80" y="34" text-anchor="middle" font-size="9" fill="#7c2d12">.hf_config</text>
    <text x="80" y="48" text-anchor="middle" font-size="9" fill="#7c2d12">.architectures</text>
  </g>
  <g transform="translate(360, 102)">
    <rect x="0" y="0" width="160" height="56" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">ParallelConfig</text>
    <text x="80" y="38" text-anchor="middle" font-size="9" fill="#7c2d12">.tp / pp / dp / ep</text>
  </g>
  <g transform="translate(600, 102)">
    <rect x="0" y="0" width="160" height="56" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1"/>
    <text x="80" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#9a3412">LoadConfig</text>
    <text x="80" y="38" text-anchor="middle" font-size="9" fill="#7c2d12">.load_format</text>
  </g>
  <path d="M 200 158 L 200 178 L 440 178 L 440 198" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar6)"/>
  <g transform="translate(200, 200)">
    <rect x="0" y="0" width="480" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="240" y="18" text-anchor="middle" font-size="11" font-weight="700" fill="#5b21b6">ModelRegistry.resolve_model_cls(architectures, model_config)</text>
    <text x="240" y="34" text-anchor="middle" font-size="9" fill="#6d28d9">models/registry.py:1188  → _LazyRegisteredModel.load_model_cls() → importlib.import_module</text>
  </g>
  <path d="M 440 244 L 440 260" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar6)"/>
  <g transform="translate(280, 264)">
    <rect x="0" y="0" width="320" height="32" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="160" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#115e59">model_cls = LlamaForCausalLM</text>
  </g>
  <path d="M 440 296 L 440 312" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar6)"/>
  <g transform="translate(220, 316)">
    <rect x="0" y="0" width="440" height="38" rx="6" fill="#ecfeff" stroke="#0d9488" stroke-width="1"/>
    <text x="220" y="16" text-anchor="middle" font-size="11" font-weight="600" fill="#115e59">get_model_loader(load_config) → DefaultModelLoader</text>
    <text x="220" y="30" text-anchor="middle" font-size="9" fill="#0f766e">model_loader/__init__.py:120</text>
  </g>
  <path d="M 440 354 L 440 370" fill="none" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar6)"/>
  <g transform="translate(30, 374)">
    <rect x="0" y="0" width="820" height="362" rx="8" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="410" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="#5b21b6">loader.load_model(vllm_config, model_config)  ·  base_loader.py:42</text>
    <g transform="translate(14, 32)">
      <rect x="0" y="0" width="396" height="156" rx="6" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" font-weight="700" fill="#5b21b6">① with target_device: initialize_model(...)</text>
      <text x="10" y="32" font-size="10" fill="currentColor">→ LlamaForCausalLM.__init__</text>
      <text x="14" y="48" font-size="10" fill="#475569">├─ LlamaModel(...)</text>
      <text x="28" y="62" font-size="10" fill="#475569">├─ VocabParallelEmbedding (first PP)</text>
      <text x="28" y="76" font-size="10" fill="#475569">├─ make_layers → LlamaDecoderLayer/PPMissingLayer</text>
      <text x="42" y="90" font-size="9" fill="#64748b">每个 DecoderLayer: RMSNorm / LlamaAttention</text>
      <text x="42" y="102" font-size="9" fill="#64748b">  QKVParallelLinear（注册 weight_loader）</text>
      <text x="42" y="114" font-size="9" fill="#64748b">  get_rope（缓存复用）/ Attention（注册 forward_context）</text>
      <text x="42" y="126" font-size="9" fill="#64748b">  RowParallelLinear / LlamaMLP</text>
      <text x="14" y="142" font-size="10" fill="#475569">├─ ParallelLMHead (last PP)（可 tie embed）</text>
      <text x="14" y="154" font-size="10" fill="#475569">└─ LogitsProcessor</text>
    </g>
    <g transform="translate(424, 32)">
      <rect x="0" y="0" width="382" height="156" rx="6" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" font-weight="700" fill="#5b21b6">② loader.load_weights(model, model_config)</text>
      <text x="10" y="32" font-size="10" fill="currentColor">default_loader.py:381</text>
      <text x="14" y="48" font-size="10" fill="#475569">├─ _init_ep_weight_filter()（MoE）</text>
      <text x="14" y="62" font-size="10" fill="#475569">├─ iter = get_all_weights(...)</text>
      <text x="28" y="76" font-size="9" fill="#64748b">safetensors_weights_iterator → 流式 yield</text>
      <text x="14" y="92" font-size="10" fill="#475569">└─ model.load_weights(iter)</text>
      <text x="28" y="106" font-size="9" fill="#64748b">AutoWeightsLoader → LlamaModel.load_weights</text>
      <text x="28" y="118" font-size="9" fill="#64748b">  for (name, w) in iter:</text>
      <text x="42" y="130" font-size="9" fill="#64748b">    maybe_remap_kv_scale_name(name)</text>
      <text x="42" y="142" font-size="9" fill="#64748b">    stacked_params_mapping → weight_loader</text>
      <text x="42" y="154" font-size="9" fill="#64748b">    或 default_weight_loader(param, w)</text>
    </g>
    <g transform="translate(14, 200)">
      <rect x="0" y="0" width="396" height="74" rx="6" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" font-weight="700" fill="#5b21b6">③ finalize_layerwise_processing(...)</text>
      <text x="10" y="34" font-size="10" fill="#475569">在线量化收尾</text>
      <text x="10" y="54" font-size="9" fill="#64748b">（仅当启用 quantization on-the-fly 时生效；</text>
      <text x="10" y="66" font-size="9" fill="#64748b">  把 fp16/bf16 权重转成目标 quant 格式）</text>
    </g>
    <g transform="translate(424, 200)">
      <rect x="0" y="0" width="382" height="74" rx="6" fill="#ffffff" stroke="#7c3aed" stroke-width="1"/>
      <text x="10" y="16" font-size="11" font-weight="700" fill="#5b21b6">④ process_weights_after_loading(...)</text>
      <text x="10" y="34" font-size="10" fill="#475569">├─ quant_method.process_weights_after_loading</text>
      <text x="10" y="48" font-size="10" fill="#475569">└─ Attention.process_weights_after_loading</text>
      <text x="28" y="62" font-size="9" fill="#64748b">重设 _k_scale/_v_scale=1.0 当 ckpt 不带</text>
    </g>
    <g transform="translate(14, 286)">
      <rect x="0" y="0" width="792" height="62" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
      <text x="396" y="20" text-anchor="middle" font-size="11" font-weight="700" fill="#166534">model.eval()  返回给 Worker，由 Worker 的 ModelRunner 持有</text>
      <text x="396" y="38" text-anchor="middle" font-size="10" fill="#15803d">下一步：KVCacheManager 调每个 Attention.get_kv_cache_spec(...) 收集规格，</text>
      <text x="396" y="52" text-anchor="middle" font-size="10" fill="#15803d">分配 KV cache buffer，通过 bind_kv_cache 写到每个 Attention.kv_cache 上</text>
    </g>
  </g>
</svg>
<span class="figure-caption">图 R8.7 ｜ 从 VllmConfig 到 model 实例化的完整路径：① resolve 架构 → ② 选 loader → ③ 五段式 load_model（构图 / 灌权重 / 在线 quant / KV scale 后处理）；最后由 ModelRunner 持有并等待 KV cache 绑定</span>

<details>
<summary>ASCII 原版</summary>

```
                       VllmConfig
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ModelConfig         ParallelConfig      LoadConfig
   │   .hf_config      .tp/pp/dp/ep        .load_format
   │   .architectures
   │
   ▼
ModelRegistry.resolve_model_cls(architectures, model_config)
   │   [model_executor/models/registry.py:1188]
   ▼
model_cls = LlamaForCausalLM      ◄── _LazyRegisteredModel.load_model_cls()
                                       └─ importlib.import_module(...) 第一次触发
   │
   ▼
get_model_loader(load_config)  →  DefaultModelLoader
   │   [model_executor/model_loader/__init__.py:120]
   ▼
loader.load_model(vllm_config, model_config)
   │   [model_executor/model_loader/base_loader.py:42]
   ├─ with target_device:
   │      initialize_model(...) → model_cls(vllm_config=..., prefix="")
   │          │
   │          ▼
   │      LlamaForCausalLM.__init__
   │          ├─ LlamaModel(...)
   │          │     ├─ VocabParallelEmbedding   (first PP rank)
   │          │     ├─ make_layers(...)  → ModuleList[LlamaDecoderLayer / PPMissingLayer]
   │          │     │     └─ 每个 DecoderLayer:
   │          │     │           ├─ RMSNorm
   │          │     │           ├─ LlamaAttention
   │          │     │           │     ├─ QKVParallelLinear  (注册 weight_loader)
   │          │     │           │     ├─ get_rope(...)      (复用缓存)
   │          │     │           │     ├─ Attention          (注册到 static_forward_context)
   │          │     │           │     └─ RowParallelLinear
   │          │     │           ├─ RMSNorm
   │          │     │           └─ LlamaMLP
   │          │     └─ RMSNorm                  (last PP rank)
   │          ├─ ParallelLMHead                 (last PP rank, 可 tie embed)
   │          └─ LogitsProcessor
   │
   ├─ loader.load_weights(model, model_config)
   │     [model_executor/model_loader/default_loader.py:381]
   │     ├─ _init_ep_weight_filter()             (MoE 才生效)
   │     ├─ iter = self.get_all_weights(...)
   │     │     ├─ Source(primary) → safetensors_weights_iterator(*.safetensors)
   │     │     │     └─ 流式 yield (name, tensor)
   │     │     └─ 可选 secondary_weights（多模态 tower）
   │     └─ model.load_weights(iter)             (LlamaForCausalLM.load_weights)
   │           └─ AutoWeightsLoader.load_weights
   │                 └─ LlamaModel.load_weights
   │                       └─ for (name, w) in iter:
   │                             ├─ maybe_remap_kv_scale_name(name)
   │                             ├─ stacked_params_mapping 找到 (qkv_proj, q_proj, "q")
   │                             │     └─ params_dict[name].weight_loader(param, w, "q")
   │                             │           └─ QKVParallelLinear.weight_loader
   │                             │                 └─ narrow output_dim by tp_rank
   │                             │                       copy into qkv_proj.weight
   │                             └─ 否则 default_weight_loader(param, w)
   │
   ├─ finalize_layerwise_processing(...)         (在线量化收尾)
   └─ process_weights_after_loading(...)
         ├─ 每个 quant_method.process_weights_after_loading(module)
         └─ 每个 Attention.process_weights_after_loading(act_dtype)
               └─ 重设 _k_scale/_v_scale 为 1.0（当 ckpt 不带 KV scale 时）

model.eval()  返回给 Worker，由 Worker 的 ModelRunner 持有
```

</details>

第一次 forward 前，KVCacheManager 会调用 `model` 上所有 `Attention.get_kv_cache_spec(...)` 收集每层规格，分配 `block_size * num_blocks * head_dim * num_kv_heads` 大小的 KV cache buffer，再通过 `bind_kv_cache` 写到每个 `Attention.kv_cache` 上。

---

## 8.9 配置体系：`vllm/config/`

模型加载相关的配置类（每个一个文件，集中在 `vllm/config/`）：

| 文件 | 类 | 关键字段 |
| --- | --- | --- |
| `model.py` | `ModelConfig` (`model.py:109`) | `model`, `revision`, `dtype`, `quantization`, `tokenizer`, `trust_remote_code`, `convert`, `runner`, `model_impl`, `hf_config`(派生), `architectures`(从 HF config) |
| `load.py` | `LoadConfig` | `load_format`, `download_dir`, `model_loader_extra_config`, `ignore_patterns`, `use_tqdm_on_load`, `safetensors_load_strategy`, `safetensors_prefetch_num_threads`, ... |
| `parallel.py` | `ParallelConfig` | `tensor_parallel_size`, `pipeline_parallel_size`, `data_parallel_size`, `enable_expert_parallel`, `enable_eplb`, `expert_placement_strategy`, `prefill_context_parallel_size`, ... |
| `cache.py` | `CacheConfig` | `block_size`, `gpu_memory_utilization`, `cache_dtype`, `kv_cache_dtype_skip_layers`, `enable_prefix_caching`, `sliding_window`, `calculate_kv_scales`, ... |
| `quantization.py` | `QuantizationConfig` 工厂 | 解析 `quantization` 字符串到具体 quant config 类 |
| `lora.py`, `multimodal.py`, `speculative.py`, `pooler.py`, `scheduler.py` | 各自的 ...Config | |
| `vllm.py` | `VllmConfig` | 持有上述所有 sub-config 的 dataclass；`set_current_vllm_config(...)` 把它放进 ContextVar，让 layer/parameter 在构造时按需 `get_current_vllm_config()` |

`ModelConfig.__post_init__` 内部调用 `_get_hf_config(...)` 加载 `config.json`（必要时 trust_remote_code），并把 `config.architectures` 暴露给 registry。`iter_architecture_defaults()` 与 `try_match_architecture_defaults()` (`config/model.py:1892-`) 为 registry 提供 “suffix 等价”规则（例如 `Qwen3ForSequenceClassification` 实际上落到 `Qwen3ForCausalLM` + `convert_type="classify"`）。

`VllmConfig` 在 worker 启动时由 EngineCore 构造，随后通过 `with set_current_vllm_config(vllm_config, check_compile=True, prefix=""):` (`model_loader/utils.py:60-63`) 设到 ContextVar；layer/parameter 构造 (`Attention.__init__`, `RMSNorm.__init__`, `MergedColumnParallelLinear._maybe_allow_fp8_block_shape_mismatch`, ...) 全部直接 `get_current_vllm_config()` 读，避免每个构造函数都被迫多接受十几个参数。

---

## 8.10 支持的模型族（按 `vllm/model_executor/models/` 中的文件归类）

vLLM 当前共注册约 ~290 个架构，分布在以下家族里（每个家族列出代表性入口文件）：

**Llama 系（≈70 个架构复用）**：`llama.py`, `llama4.py`, `mistral.py`, `mistral3.py`, `mistral_large_3.py`, `mixtral.py`, `granite.py`, `granitemoe*.py`, `solar.py`, `arcee.py`, `apertus.py`, `nemotron*.py`, `fairseq2_llama.py`, `teleflm.py`, `telechat2.py`, `iquest_loopcoder.py`。

**Qwen 系**：`qwen.py`, `qwen2.py`, `qwen2_moe.py`, `qwen3.py`, `qwen3_moe.py`, `qwen3_next.py`, `qwen3_5.py`, `qwen3_dflash.py`, `qwen_vl.py`, `qwen2_vl.py`, `qwen2_5_vl.py`, `qwen3_vl.py`, `qwen3_vl_moe.py`, `qwen2_audio.py`, `qwen3_omni_moe_thinker.py`, `qwen3_asr*.py`。

**Mistral / Mixtral / Pixtral**：`mistral*.py`, `mixtral.py`, `pixtral.py`, `voxtral*.py`。

**DeepSeek / Kimi / MiniMax**：`deepseek_v2.py`, `deepseek_v4.py`, `deepseek_vl2.py`, `deepseek_ocr*.py`, `kimi_*.py`, `minimax_*.py`。

**Gemma / Phi / Granite**：`gemma.py`, `gemma2.py`, `gemma3*.py`, `gemma4*.py`, `phi.py`, `phi3*.py`, `phi4*.py`, `phimoe.py`, `granite*.py`。

**MoE 模型**：`mixtral.py`, `dbrx.py`, `arctic.py`, `qwen2_moe.py`, `qwen3_moe.py`, `glm4_moe*.py`, `deepseek_v2.py` (V2/V3/V3.2/V4), `ernie45_moe.py`, `olmoe.py`, `hunyuan_v1.py`, `grok1.py`, `cohere2_moe.py`, `phimoe.py`, `bailing_moe*.py`, `granitemoe*.py`, `exaone_moe.py`, `openpangu.py`, `flex_olmo.py`, `lfm2_moe.py`, `longcat_flash.py`, `minimax_*.py`, `sarvam.py`, `param2moe.py`。

**多模态（视觉/音频/OCR/全能体）**：`llava*.py`, `internvl.py`, `interns1*.py`, `minicpmv*.py`, `mllama4.py`, `qwen*_vl*.py`, `glm4_1v.py`, `gemma3_mm.py`, `gemma4_mm.py`, `gemma3n_mm.py`, `nano_nemotron_vl.py`, `nemotron_vl.py`, `paligemma.py`, `aria.py`, `chameleon.py`, `idefics3.py`, `smolvlm.py`, `pixtral.py`, `keye*.py`, `kimi_vl.py`, `cohere2_vision.py`, `step3_vl.py`, `step_vl.py`, `nvlm_d.py`, `molmo.py`, `molmo2.py`, `moondream3.py`, `ovis*.py`, `nemotron_parse.py`, `paddleocr_vl.py`, `dots_ocr.py`, `qianfan_ocr.py`, `whisper.py`, `audioflamingo3.py`, `granite_speech.py`, `kimi_audio.py`, `ultravox.py`, `voxtral*.py`, `qwen2_audio.py`, `qwen2_5_omni_thinker.py`, `qwen3_asr*.py`, `funasr.py`, `funaudiochat.py`, `glmasr.py`, `parakeet.py`, `cohere_asr.py`。

**Mamba / Hybrid（状态空间 + attention）**：`mamba.py`, `mamba2.py`, `jamba.py`, `bamba.py`, `falcon_h1.py`, `nemotron_h.py`, `granitemoehybrid.py`, `plamo2.py`, `plamo3.py`, `zamba2.py`, `lfm2.py`, `lfm2_moe.py`, `olmo_hybrid.py`, `qwen3_next.py`, `minimax_m2.py`, `kimi_linear.py`。

**Encoder / Embedding / Reranker / Reward**：`bert.py`, `bert_with_rope.py`, `roberta.py`, `modernbert.py`, `jina.py`, `jina_vl.py`, `voyage.py`, `colbert.py`, `colpali.py`, `colmodernvbert.py`, `colqwen3*.py`, `gritlm.py`, `qwen2_rm.py`, `terratorch.py`, `siglip.py`, `clip.py`, `aimv2.py`, `radio.py`, `vision.py`, `intern_vit.py`, `interns1_vit.py`, `kimi_k25_vit.py`, `moonvit.py`, `siglip2navit.py`, `blip.py`, `blip2.py`, `idefics2_vision_model.py`, `pixtral.py`(vision tower)。

**Speculative decoding draft（EAGLE / EAGLE3 / MTP / Medusa）**：`llama_eagle.py`, `llama_eagle3.py`, `llama4_eagle.py`, `mistral_eagle.py`, `deepseek_eagle.py`, `deepseek_eagle3.py`, `minicpm_eagle.py`, `cohere_eagle.py`, `mimo_mtp.py`, `mimo_v2_mtp.py`, `deepseek_mtp.py`, `deepseek_v4_mtp.py`, `gemma4_mtp.py`, `ernie_mtp.py`, `exaone_moe_mtp.py`, `exaone4_5_mtp.py`, `nemotron_h_mtp.py`, `longcat_flash_mtp.py`, `glm4_moe_mtp.py`, `glm4_moe_lite_mtp.py`, `glm_ocr_mtp.py`, `medusa.py`, `openpangu_mtp.py`, `qwen3_next_mtp.py`, `step3p5_mtp.py`, `qwen3_5_mtp.py`, `hy_v3_mtp.py`, `gemma4_mtp.py`。

**Transformers backend**：`transformers/` 目录（`TransformersForCausalLM`, `TransformersMoEForCausalLM`, `TransformersMultiModalForCausalLM`, ... 各自有对应 `*MoE*` / `*MultiModal*` / `*Embedding*` / `*SequenceClassification*` 变体）。这是 vLLM 没有原生实现时的兜底：直接复用 HuggingFace `transformers` 的 `nn.Module`，附加 vLLM 的 KV cache & TP 支持。

---

## 8.11 添加新模型的步骤

假设要支持一个新架构 `Foo3ForCausalLM`，HF 实现存放在 `transformers/models/foo3/modeling_foo3.py`。

### 步骤 1：选定基线模型

如果它就是“Llama + 几行小改动”（更换 norm、改 head_dim、加 q_norm/k_norm 等），优先**继承**而非重写。例如 `qwen3.py`, `arcee.py`, `solar.py` 都是这种风格，往往只覆盖 `LlamaAttention` 或 `LlamaDecoderLayer` 的一两个方法。

如果架构差异更大（如 MoE / hybrid SSM / 多模态），从最相近的现有模型 fork 一个文件。

### 步骤 2：实现 model classes

按 §8.3 的层级写：

```python
class Foo3MLP(nn.Module): ...
class Foo3Attention(nn.Module): ...
class Foo3DecoderLayer(nn.Module):
    def __init__(self, vllm_config, prefix=""):
        ...
    def forward(self, positions, hidden_states, residual):
        ...
class Foo3Model(nn.Module, EagleModelMixin):
    def __init__(self, *, vllm_config, prefix=""):
        ...
        self.start_layer, self.end_layer, self.layers = make_layers(
            config.num_hidden_layers,
            lambda prefix: Foo3DecoderLayer(vllm_config=vllm_config, prefix=prefix),
            prefix=f"{prefix}.layers")
    def forward(self, input_ids, positions, intermediate_tensors, inputs_embeds=None):
        ...
class Foo3ForCausalLM(nn.Module, SupportsLoRA, SupportsPP):
    packed_modules_mapping = {
        "qkv_proj":     ["q_proj", "k_proj", "v_proj"],
        "gate_up_proj": ["gate_proj", "up_proj"],
    }
    embedding_modules = {"embed_tokens": "input_embeddings",
                         "lm_head":     "output_embeddings"}

    def __init__(self, *, vllm_config, prefix=""):
        ...
    def forward(self, input_ids, positions, intermediate_tensors=None, inputs_embeds=None):
        ...
    def compute_logits(self, hidden_states):
        return self.logits_processor(self.lm_head, hidden_states)
    def load_weights(self, weights):
        loader = AutoWeightsLoader(self, skip_prefixes=...)
        return loader.load_weights(weights)
```

要点：

1. `__init__` 必须接受 `vllm_config: VllmConfig, prefix: str`（旧式签名已不再支持，见 `model_loader/utils.py:65-78`）。
2. 用 `make_layers` 而不是 `nn.ModuleList([... for _ in range(N)])`，否则 PP 会失败。
3. 用 `get_pp_group().is_first_rank` / `.is_last_rank` 守护 `embed_tokens` / `norm` / `lm_head` 的创建；否则用 `PPMissingLayer()`。
4. 给所有 sub-module 传 `prefix=f"{prefix}.sub_name"`，使每个 `Attention` 在 `static_forward_context` 中有唯一名字。

### 步骤 3：实现 mixin 能力

按需 mix in：

| 想支持 | 必做 |
| --- | --- |
| `SupportsLoRA` | 定义 `packed_modules_mapping` 与 `embedding_modules`；如有 MoE 还要 `is_3d_moe_weight = True` |
| `SupportsPP` | `forward` 接受 `intermediate_tensors`，`Foo3Model` 暴露 `make_empty_intermediate_tensors`（用 `make_empty_intermediate_tensors_factory(["hidden_states", "residual"], hidden_size)`） |
| `SupportsMultiModal` | 注册 `MULTIMODAL_REGISTRY.register_processor(...)`，实现 `embed_multimodal`, `get_placeholder_str`，把视觉/音频 tower 列入 `_tower_model_names` |
| `MixtureOfExperts` | 暴露 `num_moe_layers`, `num_experts_per_tok`, `num_routed_experts`, `num_redundant_experts`, `set_eplb_state(...)` 等 |
| `IsHybrid` / `HasInnerState` | 实现 `get_mamba_state_dtype_from_config` / `get_mamba_state_shape_from_config`，让 KV cache manager 分配 SSM state |
| `SupportsEagle` / `SupportsEagle3` | 让模型暴露中间 hidden state 供 draft 模型使用 |

### 步骤 4：注册到 `_TEXT_GENERATION_MODELS`（或对应桶）

在 `vllm/model_executor/models/registry.py` 的对应字典加一行：

```python
"Foo3ForCausalLM": ("foo3", "Foo3ForCausalLM"),
```

key 必须与 `config.architectures[0]` 完全一致。如果该模型也有 vision 变体，加到 `_MULTIMODAL_MODELS`；MTP / EAGLE draft 加到 `_SPECULATIVE_DECODING_MODELS`。

### 步骤 5：实现 `load_weights`

最常见两种风格：

- **复用 Llama 模式**：直接 `from .llama import LlamaModel; class Foo3Model(LlamaModel): ...` 并复用 `LlamaModel.load_weights`。
- **自定义 stacked_params_mapping**：复制 `LlamaModel.load_weights` 的代码骨架（§8.6.3），替换 mapping 表。

如果 HF ckpt 命名有 prefix 差异（例如多模态模型把语言部分塞在 `language_model.model.layers.x`），在最外层 `Foo3ForCausalLM.load_weights` 里用 `WeightsMapper(orig_to_new_prefix={"language_model.": ""}).apply(weights)` 先 rename。

如果模型有 MoE，调用 `self.model.get_expert_mapping()` 拿 `[(param_name, weight_name, expert_id, shard_id), ...]`，在循环里识别 `experts.{eid}.{w1,w2,w3}.weight` 并 dispatch 到 `FusedMoE.weight_loader`。

### 步骤 6：测试与注册示例

`tests/models/registry.py` 是测试入口：把架构和一个公开的小模型 ID 配对，CI 会基于此跑 inspect / load smoke test。

`AGENTS.md` 提示：纯代码 agent PR 不被接受，须由人类提交者全程审阅；测试命令必须写进 PR 描述。

---

## 8.12 关键源码位置速查表

| 功能 | 文件:行 |
| --- | --- |
| 架构→class 注册表 | `vllm/model_executor/models/registry.py:70-692` |
| 注册中心实现 | `vllm/model_executor/models/registry.py:941-1240` |
| 懒加载 + 子进程 inspect | `vllm/model_executor/models/registry.py:805-911`, `1344-1371` |
| 模型 mixin (SupportsLoRA/PP/MM/...) | `vllm/model_executor/models/interfaces.py` |
| 基础协议 (VllmModel*) | `vllm/model_executor/models/interfaces_base.py` |
| Llama 模型实现 | `vllm/model_executor/models/llama.py` |
| AutoWeightsLoader / WeightsMapper / make_layers / PPMissingLayer | `vllm/model_executor/models/utils.py:44-715` |
| Linear (Column/Row/Merged/QKV) | `vllm/model_executor/layers/linear.py` |
| BasevLLMParameter 与子类 | `vllm/model_executor/parameter.py` |
| RMSNorm / fused-add-RMSNorm | `vllm/model_executor/layers/layernorm.py:38-128` |
| RoPE 工厂 | `vllm/model_executor/layers/rotary_embedding/__init__.py:33` |
| VocabParallelEmbedding / ParallelLMHead | `vllm/model_executor/layers/vocab_parallel_embedding.py:192-567` |
| Attention wrapper | `vllm/model_executor/layers/attention/attention.py:177-611` |
| FusedMoE | `vllm/model_executor/layers/fused_moe/layer.py:73-` |
| Loader 注册 / 分发 | `vllm/model_executor/model_loader/__init__.py:48-141` |
| BaseModelLoader.load_model | `vllm/model_executor/model_loader/base_loader.py:42-82` |
| DefaultModelLoader | `vllm/model_executor/model_loader/default_loader.py:43-437` |
| safetensors 迭代器 | `vllm/model_executor/model_loader/weight_utils.py:893-` |
| default_weight_loader / sharded_weight_loader | `vllm/model_executor/model_loader/weight_utils.py:1383-1447` |
| KV scale 名称 remap | `vllm/model_executor/model_loader/weight_utils.py:1526-1605` |
| EP weight 过滤 | `vllm/model_executor/model_loader/ep_weight_filter.py`, `default_loader.py:318-379` |
| initialize_model / process_weights_after_loading | `vllm/model_executor/model_loader/utils.py:40-128` |
| get_model_architecture (含 ParamMapping, configure_quant_config) | `vllm/model_executor/model_loader/utils.py:175-` |
| ModelConfig | `vllm/config/model.py:109` |
| LoadConfig | `vllm/config/load.py` |
| VllmConfig | `vllm/config/vllm.py` |
