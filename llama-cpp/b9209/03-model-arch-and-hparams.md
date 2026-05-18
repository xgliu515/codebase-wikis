# 第 3 章 模型架构与超参数

llama.cpp 在单一代码库内支持逾百种大语言模型架构。实现这一能力的核心思路是：将架构差异抽象为两张静态映射表——`llm_arch`（架构枚举）与 `LLM_KV`/`LLM_TENSOR` 命名体系，再配合每架构独立实现的 `load_arch_hparams` / `load_arch_tensors` / `build_arch_graph` 三个虚函数，使框架代码与架构细节完全解耦。超参数统一存放在 `llama_hparams` 中，模型权重指针统一挂载到 `llama_model` 及其 `layers` 数组中。加载阶段由 `llama_model_base` 完成通用流程，各架构子类只需覆写特定部分。

---

## 1. llm_arch 枚举：架构注册表

`llm_arch` 是一个 C++ 枚举（`src/llama-arch.h:13`），当前定义了 130+ 个枚举值，覆盖解码器、编码器、编码器-解码器、扩散模型、SSM 等多种范式：

```text
src/llama-arch.h:13
enum llm_arch {
    LLM_ARCH_CLIP,          // 视觉编码器，仅用于量化工具
    LLM_ARCH_LLAMA,         // Meta LLaMA 系列
    LLM_ARCH_LLAMA4,        // LLaMA 4（MoE 版）
    LLM_ARCH_QWEN2,         // 通义千问 2
    LLM_ARCH_QWEN2MOE,      // 通义千问 2 MoE
    LLM_ARCH_DEEPSEEK2,     // DeepSeek V2（MLA）
    LLM_ARCH_MAMBA,         // Mamba（纯 SSM）
    LLM_ARCH_JAMBA,         // 混合 Attention+SSM
    LLM_ARCH_RWKV7,         // RWKV v7
    LLM_ARCH_T5,            // 编码器-解码器
    // ...
    LLM_ARCH_UNKNOWN,
};
```

枚举值在 `src/llama-arch.cpp:9` 的静态映射表 `LLM_ARCH_NAMES` 中与 GGUF 字符串绑定：

```cpp
// src/llama-arch.cpp:9
static const std::map<llm_arch, const char *> LLM_ARCH_NAMES = {
    { LLM_ARCH_LLAMA,   "llama"   },
    { LLM_ARCH_QWEN2,   "qwen2"   },
    { LLM_ARCH_DEEPSEEK2, "deepseek2" },
    // ...
};
```

**从 GGUF 到枚举的映射路径**（`src/llama-model-loader.cpp:551`）：

```text
GGUF 文件
  └─ gguf_init_from_file()
       └─ get_key(LLM_KV_GENERAL_ARCHITECTURE, arch_name)
            → arch_name = "llama" / "qwen2" / ...
       └─ llm_arch_from_string(arch_name)
            → 线性扫描 LLM_ARCH_NAMES，返回对应枚举值
       └─ llm_kv = LLM_KV(arch)
```

`llm_arch_from_string`（`src/llama-arch.cpp:821`）对 `LLM_ARCH_NAMES` 做反查。若找不到匹配项则返回 `LLM_ARCH_UNKNOWN`，后续加载会报错退出。此设计的好处是新增架构只需在枚举和映射表中各增一行，无需修改加载框架主干。

辅助查询函数（`src/llama-arch.h:636`）：

| 函数 | 用途 |
|------|------|
| `llm_arch_is_recurrent(arch)` | 是否为纯循环模型（Mamba/RWKV） |
| `llm_arch_is_hybrid(arch)` | 是否为 Attention+SSM 混合模型 |
| `llm_arch_is_diffusion(arch)` | 是否为扩散语言模型 |
| `llm_arch_supports_sm_tensor(arch)` | 是否支持状态机张量 |

---

## 2. LLM_KV / LLM_TENSOR 命名体系

### 2.1 LLM_KV：元数据键

`llm_kv` 枚举（`src/llama-arch.h:143`）列举了所有 GGUF 元数据键的逻辑名称，分为几个命名域：

```text
通用区:  LLM_KV_GENERAL_ARCHITECTURE, LLM_KV_GENERAL_NAME, ...
模型结构: LLM_KV_EMBEDDING_LENGTH, LLM_KV_BLOCK_COUNT,
          LLM_KV_ATTENTION_HEAD_COUNT, LLM_KV_ATTENTION_HEAD_COUNT_KV,
          LLM_KV_FEED_FORWARD_LENGTH, LLM_KV_EXPERT_COUNT, ...
RoPE:    LLM_KV_ROPE_FREQ_BASE, LLM_KV_ROPE_SCALING_TYPE, ...
SSM:     LLM_KV_SSM_INNER_SIZE, LLM_KV_SSM_STATE_SIZE, ...
分词器:  LLM_KV_TOKENIZER_MODEL, LLM_KV_TOKENIZER_BOS_ID, ...
```

在 `LLM_KV_NAMES`（`src/llama-arch.cpp:139`）中，带 `%s` 占位符的键在实例化时用架构名替换：

```cpp
{ LLM_KV_EMBEDDING_LENGTH,       "%s.embedding_length"   },
{ LLM_KV_ATTENTION_HEAD_COUNT,   "%s.attention.head_count" },
{ LLM_KV_ROPE_FREQ_BASE,         "%s.rope.freq_base"     },
```

`LLM_KV` 结构体（`src/llama-arch.h:566`）持有 `arch` 字段，调用 `operator()(llm_kv)` 时完成格式化：

```cpp
// src/llama-arch.cpp:776
std::string LLM_KV::operator()(llm_kv kv) const {
    std::string name = ::format(LLM_KV_NAMES.at(kv), LLM_ARCH_NAMES.at(arch));
    // ...
    return name;
}
```

于是，对 `LLM_ARCH_LLAMA`，`kv(LLM_KV_EMBEDDING_LENGTH)` → `"llama.embedding_length"`；对 `LLM_ARCH_QWEN2` 则 → `"qwen2.embedding_length"`。这一设计使得框架代码可以用相同的枚举常量读取不同架构的 GGUF 键，而无需硬编码字符串。

### 2.2 LLM_TENSOR 与 LLM_TN：权重张量命名

`llm_tensor` 枚举（`src/llama-arch.h:349`）定义了所有可能出现的张量逻辑名：

```text
全局张量: LLM_TENSOR_TOKEN_EMBD, LLM_TENSOR_OUTPUT, LLM_TENSOR_OUTPUT_NORM, ...
逐层注意力: LLM_TENSOR_ATTN_NORM, LLM_TENSOR_ATTN_Q/K/V, LLM_TENSOR_ATTN_OUT, ...
逐层 FFN: LLM_TENSOR_FFN_NORM, LLM_TENSOR_FFN_GATE/UP/DOWN, ...
MoE 专家: LLM_TENSOR_FFN_GATE_EXPS, LLM_TENSOR_FFN_DOWN_EXPS, ...
SSM: LLM_TENSOR_SSM_IN, LLM_TENSOR_SSM_A, LLM_TENSOR_SSM_D, ...
```

张量名模板存储在 `LLM_TENSOR_NAMES`（`src/llama-arch.cpp:344`）：

```cpp
{ LLM_TENSOR_TOKEN_EMBD,  "token_embd"         },  // 全局
{ LLM_TENSOR_ATTN_NORM,   "blk.%d.attn_norm"   },  // 逐层，%d = 层编号
{ LLM_TENSOR_FFN_GATE_EXP,"blk.%d.ffn_gate.%d" },  // 逐层逐专家
```

`LLM_TN` 是一个轻量工厂（`src/llama-arch.h:608`）：

```cpp
// src/llama-arch.h:608
struct LLM_TN {
    LLM_TN(llm_arch arch) : arch(arch) {}
    llm_arch arch;
    LLM_TN_IMPL operator()(llm_tensor tensor, const char * suffix, int bid=-1, int xid=-1) const;
    LLM_TN_IMPL operator()(llm_tensor tensor, int bid=-1, int xid=-1) const;
};
```

三个调用示例（`src/llama-arch.h:578`）：

```cpp
const auto tn = LLM_TN(LLM_ARCH_LLAMA);
tn(LLM_TENSOR_OUTPUT)                     // → "output"
tn(LLM_TENSOR_TOKEN_EMBD, "bias")         // → "token_embd.bias"
tn(LLM_TENSOR_ATTN_NORM, "weight", 3)     // → "blk.3.attn_norm.weight"
```

`LLM_TN_IMPL::str()`（`src/llama-arch.cpp:790`）完成最终格式化：先对 `LLM_TENSOR_NAMES` 中模板做 `format(template, bid, xid)`，再拼接 suffix。此设计的核心价值是：**张量名在整个代码库中只有一处定义**，加载侧、图构建侧共享同一套命名规则，避免了拼写不一致导致的张量找不到错误。

---

## 3. llama_hparams：超参数结构体

`llama_hparams`（`src/llama-hparams.h:36`）持有一个模型从 GGUF 读取后的所有超参数，并提供若干派生计算方法。以下按逻辑分组说明关键字段。

### 3.1 嵌入维度与层数

| 字段 | 含义 |
|------|------|
| `n_ctx_train` | 训练时的上下文窗口长度 |
| `n_embd` | 隐藏层（嵌入）维度，对应 GGUF `{arch}.embedding_length` |
| `n_layer` | Transformer 层数，对应 `{arch}.block_count` |

### 3.2 注意力头数与 GQA

注意力头数以 **逐层数组** 存储，支持 OpenELM 等每层头数不同的架构：

```cpp
// src/llama-hparams.h:71
std::array<uint32_t, LLAMA_MAX_LAYERS> n_head_arr;
std::array<uint32_t, LLAMA_MAX_LAYERS> n_head_kv_arr;
```

访问器方法（`src/llama-hparams.h:258`）：

```cpp
uint32_t n_head(uint32_t il = 0) const;     // 第 il 层的 Q 头数
uint32_t n_head_kv(uint32_t il = 0) const;  // 第 il 层的 KV 头数
uint32_t n_gqa(uint32_t il = 0) const;      // GQA 倍率 = n_head / n_head_kv
```

**GQA（Grouped Query Attention）**：当 `n_head_kv < n_head` 时启用。例如 LLaMA-3 8B 有 32 个 Q 头、8 个 KV 头，GQA 倍率为 4，KV cache 显存降至 MHA 的 1/4。当 `n_head_kv = 1` 时退化为 MQA（Multi-Query Attention）。

头维度由以下字段指定（`src/llama-hparams.h:52`）：

```cpp
uint32_t n_embd_head_k_full;  // 全局注意力层每头 key 维度
uint32_t n_embd_head_v_full;  // 全局注意力层每头 value 维度
uint32_t n_embd_head_k_swa;   // SWA 层每头 key 维度（滑动窗口注意力）
uint32_t n_embd_head_v_swa;   // SWA 层每头 value 维度
```

### 3.3 FFN 维度

```cpp
// src/llama-hparams.h:73
std::array<uint32_t, LLAMA_MAX_LAYERS> n_ff_arr;
uint32_t n_ff(uint32_t il = 0) const;
```

同样支持逐层不同的 FFN 宽度。MoE 相关字段（`src/llama-hparams.h:47`）：

```cpp
uint32_t n_expert      = 0;  // 专家总数（0 = 稠密 FFN）
uint32_t n_expert_used = 0;  // 每次激活的专家数（top-k）
uint32_t n_ff_exp      = 0;  // 每个专家的 FFN 中间维度
uint32_t n_ff_shexp    = 0;  // 共享专家的 FFN 中间维度（DeepSeek/Qwen2MoE）
```

### 3.4 RoPE 参数

```cpp
// src/llama-hparams.h:116
float    rope_freq_base_train;       // 基础频率，标准 LLaMA: 10000.0
float    rope_freq_scale_train;      // 频率缩放系数（线性外推）
uint32_t n_rot_full;                 // 旋转维度数（通常等于 n_embd_head_k）
float    yarn_ext_factor;            // YaRN 外插因子（-1 = 关闭）
float    yarn_attn_factor;           // YaRN 注意力因子
float    yarn_beta_fast;             // YaRN beta_fast
float    yarn_beta_slow;             // YaRN beta_slow
```

ROPE 缩放策略由 `rope_scaling_type_train`（枚举）指定，支持无缩放、线性缩放、YaRN、LongRoPE 等。

### 3.5 滑动窗口注意力（SWA）

部分模型（如 Gemma2、Mistral、Phi3 等）对部分层使用有限注意力窗口以降低计算开销：

```cpp
// src/llama-hparams.h:134
llama_swa_type swa_type = LLAMA_SWA_TYPE_NONE;  // STANDARD / CHUNKED / SYMMETRIC
uint32_t n_swa = 0;                              // 窗口大小（token 数）
std::array<uint32_t, LLAMA_MAX_LAYERS> swa_layers;  // 按层标记是否为 SWA 层
```

`set_swa_pattern(n_pattern, dense_first)`（`src/llama-hparams.h:253`）根据周期 `n_pattern` 批量填充 `swa_layers`。`is_swa(il)` 返回第 il 层是否为 SWA 层。

### 3.6 MLA 参数（DeepSeek V2）

```cpp
// src/llama-hparams.h:62
uint32_t n_embd_head_k_mla_impl = 0;  // MLA 低秩压缩后 K 的实现维度
uint32_t n_embd_head_v_mla_impl = 0;  // MLA 低秩压缩后 V 的实现维度
```

MLA（Multi-head Latent Attention）将 KV 投影到低秩潜空间，再解压为 MHA，`is_mla()` 方法判断当前模型是否启用。

### 3.7 SSM 参数

```cpp
// src/llama-hparams.h:144
uint32_t ssm_d_conv  = 0;  // SSM 卷积核大小
uint32_t ssm_d_inner = 0;  // SSM 内部维度
uint32_t ssm_d_state = 0;  // SSM 状态维度
uint32_t ssm_dt_rank = 0;  // SSM 时间步秩
```

---

## 4. llama_model：模型结构体

`llama_model`（`src/llama-model.h:512`）是一个抽象基类，持有模型的全局张量指针、层数组和词汇表。

### 4.1 全局张量

```cpp
// src/llama-model.h:524
struct ggml_tensor * tok_embd   = nullptr;  // token embedding 矩阵 [n_embd, n_vocab]
struct ggml_tensor * type_embd  = nullptr;  // token type embedding（BERT 等）
struct ggml_tensor * pos_embd   = nullptr;  // 绝对位置 embedding（GPT-2 等）
struct ggml_tensor * tok_norm   = nullptr;  // token embedding 后的 norm（GPT-2）
struct ggml_tensor * output_norm = nullptr; // 最终 RMS/LayerNorm 权重
struct ggml_tensor * output      = nullptr; // LM head 权重（logits 投影）
```

`output` 与 `tok_embd` 的关系：若 GGUF 中不存在 `output.weight`，则 LLM head 与 embedding 共享权重（权重绑定，weight tying），在加载时以 `TENSOR_DUPLICATED` 标志指向同一数据（`src/models/llama.cpp:45`）。

### 4.2 llama_layer：逐层张量

`layers` 是一个 `std::vector<llama_layer>`（`src/llama-model.h:558`），每个元素对应 Transformer 的一层。`llama_layer`（`src/llama-model.h:213`）将同一层的所有权重指针归组：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_layer struct tree showing four groups: normalization, attention, feed-forward, SSM, and RoPE">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="20" y="10" width="160" height="340" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="100" y="165" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" transform="rotate(-90,100,165)">llama_layer</text>
  <rect x="200" y="10" width="180" height="68" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="290" y="28" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">normalization</text>
  <text x="290" y="43" text-anchor="middle" font-size="10" fill="#64748b">attn_norm, attn_norm_b</text>
  <text x="290" y="57" text-anchor="middle" font-size="10" fill="#64748b">ffn_norm, ffn_norm_b</text>
  <text x="290" y="71" text-anchor="middle" font-size="10" fill="#94a3b8">layer_out_norm  attn_q_norm  attn_k_norm</text>
  <rect x="200" y="88" width="180" height="82" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="290" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">attention</text>
  <text x="290" y="122" text-anchor="middle" font-size="10" fill="#64748b">wq, wk, wv, wo</text>
  <text x="290" y="137" text-anchor="middle" font-size="10" fill="#64748b">wqkv（融合，Falcon 等）</text>
  <text x="290" y="152" text-anchor="middle" font-size="10" fill="#94a3b8">wq_a, wq_b, wkv_a_mqa, wkv_b</text>
  <text x="290" y="166" text-anchor="middle" font-size="10" fill="#94a3b8">（MLA 低秩分解，DeepSeek V2）</text>
  <rect x="200" y="180" width="180" height="96" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="290" y="198" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">feed-forward</text>
  <text x="290" y="214" text-anchor="middle" font-size="10" fill="#64748b">ffn_gate, ffn_up, ffn_down</text>
  <text x="290" y="229" text-anchor="middle" font-size="10" fill="#64748b">ffn_gate_inp（MoE 路由器）</text>
  <text x="290" y="244" text-anchor="middle" font-size="10" fill="#94a3b8">ffn_gate_exps, ffn_up_exps, ffn_down_exps</text>
  <text x="290" y="259" text-anchor="middle" font-size="10" fill="#94a3b8">ffn_gate_shexp, ffn_up_shexp, ffn_down_shexp</text>
  <text x="290" y="273" text-anchor="middle" font-size="10" fill="#94a3b8">（共享专家，DeepSeek/Qwen2MoE）</text>
  <rect x="200" y="286" width="180" height="36" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="290" y="304" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">SSM</text>
  <text x="290" y="318" text-anchor="middle" font-size="10" fill="#64748b">ssm_in  ssm_x  ssm_dt  ssm_a  ssm_d  ssm_out</text>
  <rect x="200" y="332" width="180" height="20" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="290" y="346" text-anchor="middle" font-size="10" fill="#64748b">RoPE: rope_long  rope_short  rope_freqs</text>
  <line x1="180" y1="44" x2="200" y2="44" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="180" y1="129" x2="200" y2="129" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="180" y1="228" x2="200" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="180" y1="304" x2="200" y2="304" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="180" y1="342" x2="200" y2="342" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="180" y1="44" x2="180" y2="342" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="400" y="88" width="330" height="56" rx="5" fill="#fef9f5" stroke="#ea580c" stroke-width="1"/>
  <text x="565" y="107" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">GQA 关键字段（hparams 层面）</text>
  <text x="565" y="123" text-anchor="middle" font-size="10" fill="#64748b">n_head（Q 头数）/ n_head_kv（KV 头数）/ n_gqa = n_head / n_head_kv</text>
  <text x="565" y="137" text-anchor="middle" font-size="10" fill="#94a3b8">LLaMA-3 8B: 32Q / 8KV → GQA×4，KV cache 节省 75%</text>
  <line x1="380" y1="129" x2="400" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="400" y="180" width="330" height="56" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="565" y="199" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">MoE 路由（hparams 层面）</text>
  <text x="565" y="215" text-anchor="middle" font-size="10" fill="#64748b">n_expert（总专家数）/ n_expert_used（top-k 激活）</text>
  <text x="565" y="231" text-anchor="middle" font-size="10" fill="#94a3b8">n_ff_exp（专家 FFN 宽度）/ n_ff_shexp（共享专家宽度）</text>
  <line x1="380" y1="228" x2="400" y2="208" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
</svg>
<span class="figure-caption">图 R3.1 ｜ llama_layer 张量树：五组权重指针（normalization / attention / FFN / SSM / RoPE）及 GQA/MoE 关键超参数</span>

<details>
<summary>ASCII 原版</summary>

```
llama_layer
  ├─ normalization
  │    attn_norm, attn_norm_b         # pre-attention norm
  │    ffn_norm, ffn_norm_b           # pre-FFN norm
  │    layer_out_norm                 # post-layer norm（GPT-NeoX 等）
  │    attn_q_norm, attn_k_norm       # Q/K norm（Qwen2 等）
  ├─ attention
  │    wq, wk, wv, wo                 # 独立 Q/K/V/O 权重
  │    wqkv                           # 融合 QKV 权重（Falcon 等）
  │    wq_a, wq_b, wkv_a_mqa, wkv_b  # MLA 低秩分解（DeepSeek V2）
  ├─ feed-forward
  │    ffn_gate, ffn_up, ffn_down     # SwiGLU/GeGLU 稠密 FFN
  │    ffn_gate_inp                   # MoE 路由器权重
  │    ffn_gate_exps, ffn_up_exps, ffn_down_exps  # 合并专家权重
  │    ffn_gate_shexp, ffn_up_shexp, ffn_down_shexp # 共享专家（DeepSeek）
  ├─ SSM
  │    ssm_in, ssm_x, ssm_dt, ssm_a, ssm_d, ssm_out
  └─ RoPE 频率修正
       rope_long, rope_short, rope_freqs
```

</details>

所有指针默认为 `nullptr`，加载时仅填充当前架构实际使用的指针。

### 4.3 设备分配相关字段

```cpp
// src/llama-model.h:571
std::vector<llama_device> devices;  // 参与推理的设备列表（CPU + 各 GPU）
```

`llama_device` 持有 `ggml_backend_dev_t`，由加载参数中的 `n_gpu_layers` 和 `split_mode` 决定如何分配。

---

## 5. 模型加载流程：架构识别与超参数填充

加载一个 GGUF 模型的调用链如下（`src/llama-model.cpp`）：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_model_load call chain showing six sequential steps from loader to tensor allocation">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="260" y="8" width="240" height="30" rx="15" fill="#ea580c"/>
  <text x="380" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">llama_model_load()</text>
  <line x1="380" y1="38" x2="380" y2="54" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="54" width="320" height="32" rx="4" fill="#fef9f5" stroke="#ea580c" stroke-width="1.2"/>
  <text x="240" y="70" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">llama_model_loader(fname)</text>
  <text x="240" y="82" text-anchor="middle" font-size="10" fill="#64748b">读取 "general.architecture" → llm_arch_from_string() → arch</text>
  <line x1="380" y1="86" x2="380" y2="102" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="102" width="320" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="240" y="118" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">llama_model_create(arch, params)</text>
  <text x="240" y="130" text-anchor="middle" font-size="10" fill="#64748b">根据 arch 实例化子类（如 llama_model_llama）</text>
  <line x1="380" y1="134" x2="380" y2="150" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="150" width="320" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="240" y="166" text-anchor="middle" font-size="11" fill="#64748b">model-&gt;load_stats(ml)    — 统计文件大小、张量数</text>
  <line x1="380" y1="174" x2="380" y2="190" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="190" width="320" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="240" y="206" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">model-&gt;load_hparams(ml)</text>
  <text x="240" y="218" text-anchor="middle" font-size="10" fill="#64748b">通用超参数 + 委托 load_arch_hparams()（子类覆写）</text>
  <line x1="380" y1="220" x2="380" y2="236" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="236" width="320" height="22" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="240" y="252" text-anchor="middle" font-size="11" fill="#64748b">model-&gt;load_vocab(ml)    — 词表加载</text>
  <line x1="380" y1="258" x2="380" y2="274" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar5)"/>
  <rect x="80" y="274" width="320" height="22" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="240" y="290" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">model-&gt;load_tensors(ml)  — 设备分配 + load_arch_tensors()</text>
  <rect x="440" y="54" width="290" height="242" rx="5" fill="#fafafa" stroke="#cbd5e1" stroke-width="1"/>
  <text x="585" y="72" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">子类覆写入口</text>
  <text x="585" y="90" text-anchor="middle" font-size="10" fill="#7c3aed">load_arch_hparams()</text>
  <text x="585" y="105" text-anchor="middle" font-size="10" fill="#94a3b8">读取架构专属超参数</text>
  <text x="585" y="120" text-anchor="middle" font-size="10" fill="#94a3b8">如 f_norm_rms_eps / n_expert ...</text>
  <line x1="585" y1="128" x2="585" y2="148" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2,2"/>
  <text x="585" y="165" text-anchor="middle" font-size="10" fill="#0d9488">load_arch_tensors()</text>
  <text x="585" y="180" text-anchor="middle" font-size="10" fill="#94a3b8">调用 create_tensor() 建立各层</text>
  <text x="585" y="195" text-anchor="middle" font-size="10" fill="#94a3b8">权重指针（wq/wk/wv/ffn_gate...）</text>
  <line x1="585" y1="203" x2="585" y2="223" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2,2"/>
  <text x="585" y="240" text-anchor="middle" font-size="10" fill="#ea580c">build_arch_graph()</text>
  <text x="585" y="255" text-anchor="middle" font-size="10" fill="#94a3b8">推理时调用，构建 ggml 计算图</text>
  <text x="585" y="270" text-anchor="middle" font-size="10" fill="#94a3b8">（第 8 章详述）</text>
  <line x1="400" y1="205" x2="440" y2="180" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar5)"/>
</svg>
<span class="figure-caption">图 R3.2 ｜ 模型加载调用链：llama_model_load 六步流程，子类覆写三个虚函数实现架构差异</span>

<details>
<summary>ASCII 原版</summary>

```
llama_model_load()
  └─ llama_model_loader(fname)
       └─ 读取 "general.architecture" → llm_arch_from_string() → arch
  └─ llama_model_create(arch, params)
       └─ 根据 arch 实例化对应的子类（如 llama_model_llama）
  └─ model->load_stats(ml)     // 统计文件大小、张量数等
  └─ model->load_hparams(ml)   // 通用超参数 + load_arch_hparams()
  └─ model->load_vocab(ml)     // 词表加载
  └─ model->load_tensors(ml)   // 设备分配 + load_arch_tensors()
```

</details>

### 5.1 load_hparams 的分工

`llama_model_base::load_hparams()`（`src/llama-model.cpp:975`）负责读取各架构共有的字段：

```cpp
ml.get_key(LLM_KV_CONTEXT_LENGTH,       hparams.n_ctx_train);
ml.get_key(LLM_KV_EMBEDDING_LENGTH,     hparams.n_embd);
ml.get_key(LLM_KV_BLOCK_COUNT,          hparams.n_layer);
ml.get_key(LLM_KV_EXPERT_COUNT,         hparams.n_expert, false);
ml.get_key(LLM_KV_ATTENTION_HEAD_COUNT, n_head_arr[...]);
// ...
load_arch_hparams(ml);  // 委托给子类：架构专属参数
```

以 LLaMA 子类为例（`src/models/llama.cpp:3`）：

```cpp
void llama_model_llama::load_arch_hparams(llama_model_loader & ml) {
    ml.get_key(LLM_KV_ATTENTION_LAYERNORM_RMS_EPS, hparams.f_norm_rms_eps);
    // 根据 n_layer 推断模型规模
    switch (hparams.n_layer) {
        case 32: type = LLM_TYPE_7B; break;
        case 80: type = /* 65B or 70B */; break;
        // ...
    }
}
```

### 5.2 load_tensors 的职责

`llama_model_base::load_tensors()`（`src/llama-model.cpp:1160`）完成以下工作：

1. **构建设备缓冲区类型列表**：为 CPU 建立 `cpu_buft_list`，为每个 GPU 建立 `gpu_buft_list`
2. **计算层分配切割点**：根据 `n_gpu_layers` 和多 GPU 显存比例计算 `splits`
3. **逐层分配设备**：填充 `pimpl->dev_layer[il]`
4. **调用子类**：`load_arch_tensors(ml)` 完成实际张量创建

---

## 6. 张量到设备的放置策略

### 6.1 n_gpu_layers 与层分配

```cpp
// src/llama-model.cpp:1222
const int i_gpu_start = std::max(int(hparams.n_layer) + 1 - n_gpu_layers, 0);
```

低于 `i_gpu_start` 的层留在 CPU，其余层按显存比例分配到各 GPU：

```text
层编号  0 … i_gpu_start-1   → CPU
层编号  i_gpu_start … n_layer → GPU(s)，按 splits 比例分段
输出层 (n_layer)              → 与最后一个 GPU 层相同设备
输入层 (embedding)            → 始终在 CPU（几乎无收益上 GPU）
```

多 GPU 分配使用 `upper_bound(splits, fraction)` 确定每层归属的 GPU（`src/llama-model.cpp:1230`）：

```cpp
const int layer_gpu = std::upper_bound(
    splits.begin(), splits.begin() + n_devices(),
    float(il - i_gpu_start) / act_gpu_layers
) - splits.begin();
```

### 6.2 buft 选择：select_buft

`llama_model::select_buft(int il)`（`src/llama-model.h:611`）通过查询层的 `buft_list` 选出第一个能容纳所需操作类型的缓冲区类型：

```text
对于 GPU 层:  尝试 CUDA/Metal/Vulkan host buffer → 回退 CPU buffer
对于 CPU 层:  尝试 CPU pinned → 普通 CPU malloc
```

回退机制确保即使设备不支持某种缓冲区类型，也总能找到可用选项。

### 6.3 张量分割（tensor split）

通过 `params.tensor_split` 数组可手动指定每个 GPU 承担的权重比例。若全部为 0，则根据运行时查询的显存大小（`ggml_backend_dev_memory`）自动计算比例，优先将更多层放到显存更大的 GPU 上。

---

## 7. 两个架构的对照：LLM_ARCH_LLAMA vs LLM_ARCH_QWEN2

下表对比两种主流架构在关键维度上的差异：

<svg viewBox="0 0 880 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Comparison table of LLM_ARCH_LLAMA vs LLM_ARCH_QWEN2 across eight dimensions">
  <rect x="10" y="10" width="860" height="32" rx="5" fill="#f1f5f9"/>
  <text x="160" y="30" text-anchor="middle" font-size="11" font-weight="700" fill="#94a3b8">维度</text>
  <text x="400" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">LLM_ARCH_LLAMA</text>
  <text x="680" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">LLM_ARCH_QWEN2</text>
  <line x1="300" y1="10" x2="300" y2="400" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="545" y1="10" x2="545" y2="400" stroke="#cbd5e1" stroke-width="1"/>
  <rect x="10" y="42" width="860" height="42" rx="0" fill="#fff"/>
  <text x="160" y="58" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">RoPE 类型</text>
  <text x="400" y="58" text-anchor="middle" font-size="11" fill="#64748b">LLAMA_ROPE_TYPE_NORM</text>
  <text x="400" y="72" text-anchor="middle" font-size="10" fill="#94a3b8">连续对旋转</text>
  <text x="680" y="58" text-anchor="middle" font-size="11" fill="#64748b">LLAMA_ROPE_TYPE_NEOX</text>
  <text x="680" y="72" text-anchor="middle" font-size="10" fill="#94a3b8">交错对旋转（偏移 n_rot/2）</text>
  <rect x="10" y="84" width="860" height="42" rx="0" fill="#fafafa"/>
  <text x="160" y="100" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">RMS eps</text>
  <text x="400" y="100" text-anchor="middle" font-size="11" fill="#64748b">f_norm_rms_eps</text>
  <text x="400" y="114" text-anchor="middle" font-size="10" fill="#94a3b8">1e-5（LLaMA-2）</text>
  <text x="680" y="100" text-anchor="middle" font-size="11" fill="#64748b">f_norm_rms_eps</text>
  <text x="680" y="114" text-anchor="middle" font-size="10" fill="#94a3b8">1e-6（Qwen2，更小）</text>
  <rect x="10" y="126" width="860" height="42" rx="0" fill="#fff"/>
  <text x="160" y="142" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">输出偏置</text>
  <text x="400" y="142" text-anchor="middle" font-size="11" fill="#64748b">无 output bias</text>
  <text x="400" y="156" text-anchor="middle" font-size="10" fill="#94a3b8">output_b = nullptr</text>
  <text x="680" y="142" text-anchor="middle" font-size="11" fill="#64748b">可选 output bias</text>
  <text x="680" y="156" text-anchor="middle" font-size="10" fill="#94a3b8">output_b 按需加载（qwen2.cpp:26）</text>
  <rect x="10" y="168" width="860" height="42" rx="0" fill="#fafafa"/>
  <text x="160" y="184" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FFN 激活</text>
  <text x="400" y="184" text-anchor="middle" font-size="11" fill="#64748b">SiLU (SwiGLU)</text>
  <text x="400" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">三矩阵: gate / up / down</text>
  <text x="680" y="184" text-anchor="middle" font-size="11" fill="#64748b">SiLU (SwiGLU)</text>
  <text x="680" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">三矩阵: gate / up / down</text>
  <rect x="10" y="210" width="860" height="42" rx="0" fill="#fff"/>
  <text x="160" y="226" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Attention 尺度</text>
  <text x="400" y="226" text-anchor="middle" font-size="11" fill="#64748b">1/√n_embd_head</text>
  <text x="400" y="240" text-anchor="middle" font-size="10" fill="#94a3b8">或 f_attention_scale</text>
  <text x="680" y="226" text-anchor="middle" font-size="11" fill="#64748b">1/√n_embd_head</text>
  <text x="680" y="240" text-anchor="middle" font-size="10" fill="#94a3b8">固定公式</text>
  <rect x="10" y="252" width="860" height="42" rx="0" fill="#fafafa"/>
  <text x="160" y="268" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">Q/K norm</text>
  <text x="400" y="268" text-anchor="middle" font-size="11" fill="#64748b">部分变体有</text>
  <text x="400" y="282" text-anchor="middle" font-size="10" fill="#94a3b8">use_kq_norm=true</text>
  <text x="680" y="268" text-anchor="middle" font-size="11" fill="#64748b">attn_q_norm 可选</text>
  <text x="680" y="282" text-anchor="middle" font-size="10" fill="#94a3b8">wq 尺寸等于 n_embd</text>
  <rect x="10" y="294" width="860" height="36" rx="0" fill="#fff"/>
  <text x="160" y="316" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">权重绑定</text>
  <text x="400" y="316" text-anchor="middle" font-size="11" fill="#64748b">output 可 = tok_embd（TENSOR_DUPLICATED）</text>
  <text x="680" y="316" text-anchor="middle" font-size="11" fill="#64748b">output 可 = tok_embd（TENSOR_DUPLICATED）</text>
  <rect x="10" y="330" width="860" height="62" rx="0" fill="#fef9f5"/>
  <text x="160" y="354" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">MoE 支持</text>
  <text x="400" y="350" text-anchor="middle" font-size="11" fill="#64748b">LLM_ARCH_LLAMA（via n_expert）</text>
  <text x="400" y="366" text-anchor="middle" font-size="10" fill="#94a3b8">MoE 直接内联，无共享专家</text>
  <text x="680" y="350" text-anchor="middle" font-size="11" fill="#64748b">LLM_ARCH_QWEN2MOE</text>
  <text x="680" y="366" text-anchor="middle" font-size="10" fill="#94a3b8">独立枚举，含共享专家（ffn_*_shexp）</text>
  <rect x="10" y="10" width="860" height="380" rx="5" fill="none" stroke="#cbd5e1" stroke-width="1.2"/>
  <line x1="10" y1="42" x2="870" y2="42" stroke="#cbd5e1" stroke-width="1"/>
  <line x1="10" y1="84" x2="870" y2="84" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="126" x2="870" y2="126" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="168" x2="870" y2="168" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="210" x2="870" y2="210" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="252" x2="870" y2="252" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="294" x2="870" y2="294" stroke="#cbd5e1" stroke-width="0.5"/>
  <line x1="10" y1="330" x2="870" y2="330" stroke="#cbd5e1" stroke-width="0.5"/>
</svg>
<span class="figure-caption">图 R3.3 ｜ LLM_ARCH_LLAMA vs LLM_ARCH_QWEN2 八维对比：RoPE 旋转方式是最关键的差异点</span>

<details>
<summary>ASCII 原版</summary>

```
维度              LLM_ARCH_LLAMA              LLM_ARCH_QWEN2
─────────────────────────────────────────────────────────────────
RoPE 类型        LLAMA_ROPE_TYPE_NORM          LLAMA_ROPE_TYPE_NEOX
                 连续对旋转                     交错对旋转（偏移 n_rot/2）

RMS eps          f_norm_rms_eps                f_norm_rms_eps
                 1e-5（LLaMA-2）               1e-6（Qwen2）

输出偏置         无 output bias                可选 output bias
                 output_b = nullptr             output_b 按需加载
                                               (src/models/qwen2.cpp:26)

FFN 激活         SiLU (SwiGLU)                 SiLU (SwiGLU)
                 三矩阵: gate/up/down           三矩阵: gate/up/down

Attention 尺度   1/sqrt(n_embd_head)           1/sqrt(n_embd_head)
                 或 f_attention_scale            固定公式

Q/K norm         部分变体有（use_kq_norm=true）  wq 尺寸等于 n_embd
                                               attn_q_norm 可选

权重绑定         output 可 = tok_embd           output 可 = tok_embd
                 TENSOR_DUPLICATED              TENSOR_DUPLICATED

MoE 支持         LLM_ARCH_LLAMA（via n_expert） LLM_ARCH_QWEN2MOE
                 Mixture of Experts 直接内联    独立架构枚举，专属 hparams
```

</details>

**LLaMA 的 rope 不同于 Qwen2 的关键体现**：在 `llama_model_rope_type()` 函数（`src/llama-model.cpp:2245`）中，`LLM_ARCH_LLAMA` 返回 `LLAMA_ROPE_TYPE_NORM`（相邻两两旋转），而 `LLM_ARCH_QWEN2` 返回 `LLAMA_ROPE_TYPE_NEOX`（前半后半分别旋转），这直接影响 `ggml_rope_ext` 的 mode 参数，进而影响 KV cache 的旋转方式。若混淆则会导致位置编码错误。

**Qwen2MoE 与 LLaMA MoE 的结构差异**：`LLM_ARCH_QWEN2MOE` 设有共享专家（shared expert），对应 `ffn_gate_shexp/ffn_up_shexp/ffn_down_shexp` 张量，路由器将 token 同时送入 top-k 路由专家和共享专家的输出之和，而 LLaMA MoE 没有共享专家这一设计。

---

## 8. 数据结构关系总图

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Data structure relationship diagram: llama_model_loader feeds into llama_model which contains hparams, vocab, global tensors, and per-layer tensors; concrete subclasses override three methods">
  <defs>
    <marker id="ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar6w" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/></marker>
  </defs>
  <rect x="10" y="10" width="220" height="70" rx="6" fill="#fef9f5" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="30" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">llama_model_loader</text>
  <text x="120" y="47" text-anchor="middle" font-size="10" fill="#64748b">gguf_context</text>
  <text x="120" y="62" text-anchor="middle" font-size="10" fill="#64748b">"general.architecture"</text>
  <text x="120" y="74" text-anchor="middle" font-size="10" fill="#94a3b8">→ llm_arch_from_string() → llm_arch 枚举</text>
  <line x1="230" y1="45" x2="260" y2="45" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ar6w)"/>
  <rect x="260" y="10" width="470" height="320" rx="6" fill="#f8f9fb" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="495" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama_model  (抽象基类)</text>
  <rect x="275" y="38" width="200" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="375" y="53" text-anchor="middle" font-size="10" fill="#64748b">llm_arch  arch  (架构枚举)</text>
  <rect x="275" y="66" width="430" height="90" rx="4" fill="#fef9f5" stroke="#ea580c" stroke-width="1"/>
  <text x="490" y="82" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">llama_hparams  hparams  (超参数)</text>
  <text x="490" y="97" text-anchor="middle" font-size="10" fill="#64748b">n_embd, n_layer  ｜  n_head_arr[n_layer], n_head_kv_arr[n_layer]</text>
  <text x="490" y="111" text-anchor="middle" font-size="10" fill="#64748b">n_ff_arr[n_layer]  ｜  n_expert, n_expert_used  ｜  rope_freq_base_train</text>
  <text x="490" y="125" text-anchor="middle" font-size="10" fill="#94a3b8">swa_type, n_swa  ｜  ssm_d_inner, ssm_d_state, ssm_d_conv, ssm_dt_rank</text>
  <text x="490" y="139" text-anchor="middle" font-size="10" fill="#94a3b8">n_embd_head_k_mla_impl, n_embd_head_v_mla_impl</text>
  <rect x="275" y="162" width="200" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="375" y="176" text-anchor="middle" font-size="10" fill="#64748b">llama_vocab  vocab</text>
  <rect x="275" y="188" width="430" height="20" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="490" y="202" text-anchor="middle" font-size="10" fill="#64748b">ggml_tensor*  tok_embd / output_norm / output  (全局张量)</text>
  <rect x="275" y="214" width="430" height="100" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="490" y="231" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">std::vector&lt;llama_layer&gt;  layers</text>
  <text x="490" y="247" text-anchor="middle" font-size="10" fill="#64748b">[i].attn_norm, wq, wk, wv, wo  (注意力权重)</text>
  <text x="490" y="262" text-anchor="middle" font-size="10" fill="#64748b">[i].ffn_norm, ffn_gate, ffn_up, ffn_down  (稠密 FFN)</text>
  <text x="490" y="277" text-anchor="middle" font-size="10" fill="#94a3b8">[i].ffn_gate_inp, ffn_gate_exps, ffn_up_exps, ffn_down_exps  (MoE)</text>
  <text x="490" y="292" text-anchor="middle" font-size="10" fill="#94a3b8">[i].ssm_in, ssm_a, ssm_d  (SSM)</text>
  <text x="490" y="306" text-anchor="middle" font-size="10" fill="#94a3b8">[i].rope_long, rope_short, rope_freqs  (RoPE)</text>
  <line x1="495" y1="330" x2="495" y2="360" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4,2" marker-end="url(#ar6)"/>
  <text x="495" y="355" text-anchor="middle" font-size="10" fill="#94a3b8">继承</text>
  <rect x="50" y="370" width="680" height="120" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="390" y="390" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">llama_model_llama  /  llama_model_qwen2  /  ...  (具体子类)</text>
  <rect x="68" y="400" width="200" height="78" rx="4" fill="#fef9f5" stroke="#ea580c" stroke-width="1"/>
  <text x="168" y="416" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">load_arch_hparams()</text>
  <text x="168" y="430" text-anchor="middle" font-size="10" fill="#64748b">覆写：读取架构</text>
  <text x="168" y="444" text-anchor="middle" font-size="10" fill="#64748b">专属超参数</text>
  <text x="168" y="458" text-anchor="middle" font-size="10" fill="#94a3b8">如 rms_eps / n_expert</text>
  <text x="168" y="472" text-anchor="middle" font-size="10" fill="#94a3b8">/ rope 类型 ...</text>
  <rect x="284" y="400" width="200" height="78" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="384" y="416" text-anchor="middle" font-size="10" font-weight="600" fill="#16a34a">load_arch_tensors()</text>
  <text x="384" y="430" text-anchor="middle" font-size="10" fill="#64748b">覆写：按架构</text>
  <text x="384" y="444" text-anchor="middle" font-size="10" fill="#64748b">创建张量指针</text>
  <text x="384" y="458" text-anchor="middle" font-size="10" fill="#94a3b8">create_tensor(wq/wk/wv</text>
  <text x="384" y="472" text-anchor="middle" font-size="10" fill="#94a3b8">ffn_gate/...)  </text>
  <rect x="500" y="400" width="212" height="78" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="606" y="416" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">build_arch_graph()</text>
  <text x="606" y="430" text-anchor="middle" font-size="10" fill="#64748b">覆写：构建</text>
  <text x="606" y="444" text-anchor="middle" font-size="10" fill="#64748b">ggml 计算图</text>
  <text x="606" y="458" text-anchor="middle" font-size="10" fill="#94a3b8">推理时调用</text>
  <text x="606" y="472" text-anchor="middle" font-size="10" fill="#94a3b8">（第 8 章详述）</text>
</svg>
<span class="figure-caption">图 R3.4 ｜ 核心数据结构关系：llama_model_loader 解析 arch → llama_model 持有 hparams/vocab/layers → 子类覆写三虚函数实现差异</span>

<details>
<summary>ASCII 原版</summary>

```
llama_model_loader
  └─ gguf_context (GGUF 元数据)
       └─ "general.architecture" ──→ llm_arch_from_string() ──→ llm_arch 枚举

llama_model  (抽象基类)
  ├─ llm_arch  arch          (架构枚举)
  ├─ llama_hparams  hparams  (超参数)
  │    ├─ n_embd, n_layer
  │    ├─ n_head_arr[n_layer], n_head_kv_arr[n_layer]
  │    ├─ n_ff_arr[n_layer]
  │    ├─ n_expert, n_expert_used
  │    ├─ rope_freq_base_train, swa_type, n_swa
  │    └─ ssm_d_inner, ssm_d_state, ...
  ├─ llama_vocab  vocab
  ├─ ggml_tensor* tok_embd / output_norm / output  (全局张量)
  └─ std::vector<llama_layer>  layers
       └─ [i] llama_layer
             ├─ attn_norm, wq, wk, wv, wo  (注意力)
             ├─ ffn_norm, ffn_gate, ffn_up, ffn_down  (FFN)
             ├─ ffn_gate_inp, ffn_gate_exps, ...  (MoE)
             └─ ssm_in, ssm_a, ssm_d, ...  (SSM)

llama_model_llama / llama_model_qwen2 / ...  (具体子类)
  ├─ load_arch_hparams()  覆写：读取架构专属超参数
  ├─ load_arch_tensors()  覆写：按架构创建张量指针
  └─ build_arch_graph()   覆写：构建计算图
```

</details>

---

## 9. 关键文件速查

| 文件 | 主要职责 |
|------|---------|
| `src/llama-arch.h` | `llm_arch` / `llm_kv` / `llm_tensor` 枚举定义，`LLM_KV` / `LLM_TN` 工厂 |
| `src/llama-arch.cpp` | `LLM_ARCH_NAMES` / `LLM_KV_NAMES` / `LLM_TENSOR_NAMES` 映射表，`LLM_KV::operator()` / `LLM_TN_IMPL::str()` |
| `src/llama-hparams.h` | `llama_hparams` 结构体及其所有派生访问方法 |
| `src/llama-model.h` | `llama_model` 抽象基类，`llama_layer` 逐层张量 |
| `src/llama-model.cpp` | `load_hparams` / `load_tensors` 通用逻辑，GPU 分层策略 |
| `src/models/llama.cpp` | LLaMA 子类的 `load_arch_hparams` / `load_arch_tensors` / `build_arch_graph` |
| `src/models/qwen2.cpp` | Qwen2 子类同上 |
