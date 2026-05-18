# 第 5 章 计算图构建与前向推理

## 总览

llama.cpp 的前向推理不依赖"静态计算图复用"模式。每次解码调用都会（有条件地）重新构建一张 `ggml_cgraph`，再提交给后端调度器执行。这种"懒惰重建"策略解决了 KV cache 位置、batch size、输出 token 数等动态信息难以预先固化的问题，同时引入了图拓扑复用（graph reuse）机制以减少重建开销。

整体调用链如下：

<svg viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_decode call chain showing graph reuse decision and execution flow">
  <defs>
    <marker id="ar51" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar51g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#16a34a"/></marker>
    <marker id="ar51r" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/></marker>
  </defs>
  <rect width="640" height="420" fill="#f8fafc" rx="8"/>
  <text x="320" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">llama_decode 整体调用链</text>
  <rect x="220" y="38" width="200" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="2" rx="6"/>
  <text x="320" y="59" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">llama_decode()</text>
  <line x1="320" y1="72" x2="320" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="185" y="92" width="270" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="320" y="113" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">llama_context::decode()</text>
  <line x1="320" y1="126" x2="320" y2="146" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="155" y="146" width="330" height="34" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="320" y="167" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">llama_context::process_ubatch()</text>
  <line x1="250" y1="180" x2="160" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="60" y="210" width="200" height="34" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="160" y="231" text-anchor="middle" font-size="11" fill="#64748b">graph_params()</text>
  <text x="160" y="244" text-anchor="middle" font-size="9" fill="#94a3b8">组装 llm_graph_params</text>
  <line x1="290" y1="180" x2="320" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="220" y="210" width="200" height="34" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="320" y="226" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">res->can_reuse(gparams)</text>
  <text x="320" y="241" text-anchor="middle" font-size="9" fill="#94a3b8">尝试复用上一张图</text>
  <line x1="255" y1="244" x2="175" y2="270" stroke="#16a34a" stroke-width="1.5" marker-end="url(#ar51g)"/>
  <text x="200" y="263" font-size="10" fill="#16a34a">yes</text>
  <rect x="60" y="270" width="230" height="38" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="4"/>
  <text x="175" y="288" text-anchor="middle" font-size="10" font-weight="600" fill="#16a34a">仅更新输入张量数据</text>
  <text x="175" y="302" text-anchor="middle" font-size="9" fill="#64748b">跳过 build_graph</text>
  <line x1="385" y1="244" x2="460" y2="270" stroke="#dc2626" stroke-width="1.5" marker-end="url(#ar51r)"/>
  <text x="435" y="263" font-size="10" fill="#dc2626">no</text>
  <rect x="350" y="270" width="230" height="38" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" rx="4"/>
  <text x="465" y="288" text-anchor="middle" font-size="10" font-weight="600" fill="#dc2626">res->reset() + build_graph()</text>
  <text x="465" y="302" text-anchor="middle" font-size="9" fill="#64748b">重新构建计算图</text>
  <line x1="175" y1="308" x2="240" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <line x1="465" y1="308" x2="390" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="150" y="338" width="340" height="34" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
  <text x="320" y="353" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">ggml_backend_sched_alloc_graph()</text>
  <text x="320" y="367" text-anchor="middle" font-size="9" fill="#64748b">内存分配 → set_inputs() → graph_compute()</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ llama_decode 整体调用链与图复用决策流程</span>

<details>
<summary>ASCII 原版</summary>

```
llama_decode()
  └─ llama_context::decode()
       └─ llama_context::process_ubatch()
            ├─ graph_params()           // 组装 llm_graph_params
            ├─ res->can_reuse(gparams)  // 尝试复用上一张图
            │     yes: 仅更新输入张量数据
            │     no:  res->reset() + model.build_graph(gparams)
            ├─ ggml_backend_sched_alloc_graph()
            ├─ res->set_inputs(&ubatch) // 填充叶子张量
            └─ graph_compute()          // 提交后端执行
```

</details>

关键入口：
- `src/llama-context.cpp:1243–1305` — 图构建/复用决策
- `src/llama-graph.h` — `llm_graph_params`、`llm_graph_context`、输入适配器类族
- `src/llama-graph.cpp` — 通用构建块实现
- `src/llama-model.cpp:2092` — `llama_model::build_graph()`
- `src/models/llama.cpp` — LLaMA 架构具体图实现

---

## 5.1 为什么每次 decode 都重新构建图

### 动态性来源

ggml 计算图本质是一棵有向无环图，节点引用其他节点（操作数）。建图时，节点的**形状**（`ne[]`）必须确定，因为后续内存分配依赖于此。而在 autoregressive 推理中，下列量每步都可能变化：

| 动态量 | 影响的图结构 |
|---|---|
| `n_tokens`（batch size）| 几乎所有算子维度 |
| `n_kv`（已用 KV 位置数）| attention mask 维度、KV view 偏移 |
| `n_outputs`（需要输出的 token 数）| `out_ids` 维度、`ggml_get_rows` 位置 |
| `ubatch.equal_seqs()`（流式 vs 统一 batch）| 注意力流分割方式 |

若将这些维度全部参数化并静态建图，则需要 padding 到最大尺寸，且无法使用 ggml 的动态分配优化。

### 图拓扑复用机制

实际上 llama.cpp **不是每步都无条件重建**。`llm_graph_result::can_reuse()` 对比当前参数与上次参数，若图拓扑完全兼容（相同的 `n_tokens`、`n_outputs`、`arch`、`gtype`、`ubatch.equal_seqs()` 等），则跳过重建，仅刷新输入张量内容：

```cpp
// src/llama-context.cpp:1250
if (!graph_reuse_disable && res->can_reuse(gparams)) {
    // 仅同步 + set_inputs，跳过 build_graph
} else {
    res->reset();
    gf = model.build_graph(gparams);
    ggml_backend_sched_alloc_graph(sched.get(), gf);
}
```

`llm_graph_params::allow_reuse()` 检查的核心条件见 `src/llama-graph.h:574–635`。精髓在于：图的**拓扑**与 batch 结构和输出数量绑定，而图的**输入数据**（token id、position、mask）每步必须刷新。

### 内存分配与上下文生命周期

每次 `res->reset()` 都会重新初始化 `ggml_context`（使用 `buf_compute_meta` 中的预分配缓冲区）并创建空的 `ggml_cgraph`，节点元数据存于该 context，而权重张量的数据始终驻留在模型的 buffer 中：

```cpp
// src/llama-graph.cpp:822-833
buf_compute_meta.resize(
    ggml_tensor_overhead()*max_nodes + ggml_graph_overhead_custom(max_nodes, false));
ctx_compute.reset(ggml_init(params));
gf = ggml_new_graph_custom(ctx_compute.get(), max_nodes, false);
```

---

## 5.2 建图上下文：`llm_graph_params` 与 `llm_graph_context`

### `llm_graph_params` — 图的"建造蓝图"

`llm_graph_params`（`src/llama-graph.h:531–636`）是一次前向所有参数的快照，在 `llama_context::graph_params()` 中组装，传递给 `build_graph()`。关键字段：

```cpp
struct llm_graph_params {
    llm_arch arch;           // 架构类型，决定 dispatch 到哪个 builder
    llama_hparams hparams;   // 模型超参（层数、头数、维度等）
    llama_cparams cparams;   // 运行时参数（flash_attn、context size、pooling 等）
    llama_ubatch  ubatch;    // 当前 micro-batch（token id、pos、seq_id 等）
    llm_graph_type gtype;    // DECODER / ENCODER / DECODER_MTP

    ggml_backend_sched_t sched;
    ggml_backend_t       backend_cpu;

    const llama_adapter_cvec     * cvec;   // 控制向量
    const llama_adapter_loras    * loras;  // LoRA 适配器
    const llama_memory_context_i * mctx;  // KV cache / 循环状态
    const llama_cross            * cross;  // encoder 输出（cross-attention）
    std::map<llama_seq_id, llama_sampler *> samplers; // 后端采样器

    uint32_t n_outputs;  // 需输出的 token 数
    llm_graph_cb cb;     // 逐张量回调（用于 offload 决策、调试）
    llm_graph_result * res; // 结果容器，也是图节点的 ggml_context 所在地
};
```

### `llm_graph_context` — 建图期间的工作台

`llm_graph_context`（`src/llama-graph.h:720–1064`）从 `llm_graph_params` 构造，缓存所有常用维度为成员变量，提供全套通用构建块方法。架构特定的 graph builder（如 `llama_model_llama::graph<false>`）继承该类并在构造函数中完成建图：

```cpp
// src/llama-graph.cpp:921-963
llm_graph_context::llm_graph_context(const llm_graph_params & params) :
    arch          (params.arch),
    hparams       (params.hparams),
    cparams       (params.cparams),
    ubatch        (params.ubatch),
    n_embd        (hparams.n_embd),
    n_layer       (hparams.n_layer),
    // ... 展开所有常用维度 ...
    ctx0          (res->get_ctx()),
    gf            (res->get_gf()) {
        res->set_params(params);
    }
```

`ctx0` 是 ggml context 指针，`gf` 是计算图指针，所有 `ggml_*` 算子调用都使用这两者。

---

## 5.3 `llm_graph_input_i` 体系：图的叶子注入

计算图的叶子节点（图的"输入"，即数据从 CPU 传入）通过 `llm_graph_input_i` 的派生类管理。每个派生类：

1. 在建图阶段（build 时）用 `ggml_new_tensor_*` + `ggml_set_input()` 申请一个叶子张量
2. 在运行阶段（set_inputs 时）调用 `set_input(ubatch*)` 将真实数据写入该张量
3. 实现 `can_reuse()` 以支持图复用检查

`llm_graph_result::add_input()` 将适配器登记到 `inputs` 列表，`set_inputs()` 遍历调用：

```cpp
// src/llama-graph.cpp:835-839
void llm_graph_result::set_inputs(const llama_ubatch * ubatch) {
    for (auto & input : inputs) {
        input->set_input(ubatch);
    }
}
```

### 主要输入适配器

| 类名 | 叶子张量 | 数据内容 |
|---|---|---|
| `llm_graph_input_embd` | `tokens` I32[n_batch]<br>`embd` F32[n_embd, n_batch] | token id 或预计算 embedding |
| `llm_graph_input_pos` | `pos` I32[n_batch] | 每个 token 的位置（支持 M-RoPE 时扩展为 4D）|
| `llm_graph_input_attn_no_cache` | `self_kq_mask` F32[n_tokens, n_tokens, 1, 1] | causal attention mask（无 KV cache）|
| `llm_graph_input_attn_kv` | `self_k_idxs` I64[n_batch]<br>`self_kq_mask` F32[n_kv, n_batch, 1, n_stream] | KV cache slot 索引 + attention mask |
| `llm_graph_input_attn_kv_iswa` | 同上 × 2（base + swa）| Interleaved SWA 的双重 KV cache |
| `llm_graph_input_out_ids` | `out_ids` I32[n_outputs] | 需要输出的 token 行索引 |
| `llm_graph_input_rs` | `s_copy` I32[n_rs] | 循环状态（RWKV/Mamba）拷贝索引 |
| `llm_graph_input_cross_embd` | `cross_embd` F32[n_embd, n_enc] | 编码器输出 embedding |
| `llm_graph_input_attn_cross` | `cross_kq_mask` F32[n_enc, n_batch, 1, 1] | 交叉注意力 mask |
| `llm_graph_input_attn_temp` | `attn_scale` F32[1, 1, n_batch] | Llama4 的温度缩放因子 |
| `llm_graph_input_mean` / `_cls` | `mean`/`cls` | embedding 模型的池化位置 |

`llm_graph_input_embd` 的叶子构造说明了"路径选择"模式——建图时同时创建 token-based 和 embedding-based 两条路径，运行时由 `ggml_build_forward_select` 根据 `ubatch.token != nullptr` 选择其一：

```cpp
// src/llama-graph.cpp:1772
ggml_tensor * cur = ggml_build_forward_select(gf, inps.data(), inps.size(),
                                               ubatch.token ? 0 : 1);
```

---

## 5.4 通用构建块

`llm_graph_context` 提供以下通用构建块，所有架构共享：

### `build_norm`：归一化层

```cpp
// src/llama-graph.cpp:1036-1069
ggml_tensor * llm_graph_context::build_norm(
        ggml_tensor * cur, ggml_tensor * mw, ggml_tensor * mb,
        llm_norm_type type, int il) const {
    switch (type) {
        case LLM_NORM:       cur = ggml_norm    (ctx0, cur, hparams.f_norm_eps);     break;
        case LLM_NORM_RMS:   cur = ggml_rms_norm(ctx0, cur, hparams.f_norm_rms_eps); break;
        case LLM_NORM_GROUP: /* reshape + group_norm + reshape */ break;
    }
    if (mw) cur = ggml_mul(ctx0, cur, mw);  // scale
    if (mb) cur = ggml_add(ctx0, cur, mb);  // bias
    return cur;
}
```

三种归一化类型对应不同架构需求：`LLM_NORM_RMS` 用于 LLaMA/Mistral/Qwen 系列，`LLM_NORM` 用于 GPT 风格模型，`LLM_NORM_GROUP` 用于 Nomic-BERT。

### `build_qkv`：Q/K/V 投影

支持两种路径（`src/llama-graph.cpp:1072–1146`）：

- **融合 QKV**（`layer.wqkv` 不为空）：单次 mat_mul 后用 `ggml_view_3d` 切分为 Q/K/V，减少 GPU kernel 启动次数
- **分离 Q/K/V**：三次独立 mat_mul，支持 GQA（`n_head_kv < n_head`）

输出形状均为 `[n_embd_head, n_head_kv/n_head, n_tokens]`，便于后续 RoPE 和注意力计算。

### `build_attn_mha`：多头注意力核心

`build_attn_mha`（`src/llama-graph.cpp:1940–2073`）执行 QKV 注意力计算，支持两条路径：

**Flash Attention 路径**（`cparams.flash_attn == true`）：
```cpp
cur = ggml_flash_attn_ext(ctx0, q, k, v, kq_mask, kq_scale,
                           hparams.f_max_alibi_bias,
                           hparams.attn_soft_cap ? hparams.f_attn_logit_softcapping : 0.0f);
```

**标准路径**：
```
kq = Q @ K^T
kq = softmax_ext(kq * scale + mask + alibi_bias)
kqv = kq @ V
```

GQA（Grouped Query Attention）通过 KV cache 中的广播视图实现：`n_head_kv` 个 KV 头通过 ggml 的广播机制复制给 `n_head` 个 Q 头，无需显式展开。

### `build_attn`：完整注意力子图（KV cache 版本）

`build_attn(llm_graph_input_attn_kv * inp, ...)` 是 autoregressive 解码的主路径，在 `build_attn_mha` 之外额外执行：

1. 用 `self_k_idxs` / `self_v_idxs` 把新的 K/V 写入 KV cache 对应 slot
2. 用 `ggml_get_rows` 从 cache 中读回所有历史 K/V（含当前）
3. 调用 `build_attn_mha` 完成注意力计算
4. 通过 `wo` 投影得到最终输出

<svg viewBox="0 0 640 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="build_attn KV cache write-read flow for autoregressive decoding">
  <defs>
    <marker id="ar52" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="240" fill="#f8fafc" rx="8"/>
  <text x="320" y="24" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">build_attn：KV cache 读写数据流</text>
  <rect x="40" y="44" width="140" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="110" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">new K / V</text>
  <text x="110" y="76" text-anchor="middle" font-size="10" fill="#64748b">当前 step 新向量</text>
  <rect x="250" y="44" width="160" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="6"/>
  <text x="330" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">KV cache slot</text>
  <text x="330" y="76" text-anchor="middle" font-size="10" fill="#64748b">kv_cache.k_l[il] / v_l[il]</text>
  <line x1="180" y1="62" x2="250" y2="62" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ar52)"/>
  <text x="215" y="56" text-anchor="middle" font-size="10" fill="#ea580c">ggml_set_rows</text>
  <line x1="330" y1="80" x2="330" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="200" y="110" width="260" height="36" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
  <text x="330" y="128" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">cache (all K/V)</text>
  <text x="330" y="143" text-anchor="middle" font-size="10" fill="#64748b">ggml_get_rows 读回全部历史</text>
  <line x1="330" y1="146" x2="330" y2="166" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="175" y="166" width="310" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="6"/>
  <text x="330" y="184" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">build_attn_mha(q, k_all, v_all, mask)</text>
  <text x="330" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">Q @ K^T → softmax → @ V</text>
  <line x1="480" y1="184" x2="555" y2="184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="555" y="168" width="60" height="34" fill="#0d9488" stroke="#0d9488" rx="4"/>
  <text x="585" y="184" text-anchor="middle" font-size="10" font-weight="600" fill="white">output</text>
  <text x="585" y="196" text-anchor="middle" font-size="9" fill="white">@ wo</text>
</svg>
<span class="figure-caption">图 R5.2 ｜ build_attn KV cache 写入→读回→注意力计算数据流</span>

<details>
<summary>ASCII 原版</summary>

```
new K/V ──write──> KV cache slot
                         |
cache (all K/V) <──read──
         |
    build_attn_mha(q, k_all, v_all, mask)
         |
    output @ wo ──> attn_out
```

</details>

### `build_ffn`：前馈网络

支持全部激活函数变体（`src/llama-graph.cpp:1149–1311`）：

| 激活 | 描述 | 代表模型 |
|---|---|---|
| `LLM_FFN_SILU` + `LLM_FFN_PAR` | SwiGLU，门控并行 | LLaMA、Mistral |
| `LLM_FFN_GELU` + `LLM_FFN_PAR` | GeGLU | PaLM |
| `LLM_FFN_RELU` + `LLM_FFN_PAR` | ReGLU | |
| `LLM_FFN_GELU` | 标准 GELU | GPT-2、BERT |
| `LLM_FFN_RELU_SQR` | ReLU^2 | Grok |

SwiGLU（最常见）的算子子图：

<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="SwiGLU FFN operator subgraph showing up proj, gate proj, silu activation, and down proj">
  <defs>
    <marker id="ar53" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="200" fill="#f8fafc" rx="8"/>
  <text x="320" y="22" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">SwiGLU 算子子图（build_ffn）</text>
  <rect x="30" y="80" width="80" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="70" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">cur</text>
  <text x="70" y="113" text-anchor="middle" font-size="9" fill="#64748b">[n_embd, n_tokens]</text>
  <line x1="110" y1="90" x2="160" y2="65" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar53)"/>
  <line x1="110" y1="110" x2="160" y2="135" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar53)"/>
  <rect x="160" y="44" width="130" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="225" y="62" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">up_proj (W_up)</text>
  <text x="225" y="76" text-anchor="middle" font-size="9" fill="#64748b">tmp [n_ff, n_tokens]</text>
  <rect x="160" y="114" width="130" height="40" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="225" y="132" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">gate_proj (W_gate)</text>
  <text x="225" y="146" text-anchor="middle" font-size="9" fill="#64748b">gate [n_ff, n_tokens]</text>
  <line x1="290" y1="64" x2="340" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar53)"/>
  <line x1="290" y1="134" x2="340" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar53)"/>
  <rect x="340" y="80" width="150" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="415" y="98" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">SwiGLU</text>
  <text x="415" y="112" text-anchor="middle" font-size="9" fill="#64748b">silu(gate) × tmp</text>
  <line x1="490" y1="100" x2="530" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar53)"/>
  <rect x="530" y="80" width="90" height="40" fill="#0d9488" stroke="#0d9488" rx="6"/>
  <text x="575" y="98" text-anchor="middle" font-size="10" font-weight="600" fill="white">down_proj</text>
  <text x="575" y="112" text-anchor="middle" font-size="9" fill="white">[n_embd]</text>
  <text x="415" y="160" text-anchor="middle" font-size="10" fill="#94a3b8">fused kernel: MUL_MAT + SILU + MUL</text>
</svg>
<span class="figure-caption">图 R5.3 ｜ SwiGLU FFN 算子子图（up/gate 并行投影 + silu 门控 + down 投影）</span>

<details>
<summary>ASCII 原版</summary>

```
cur ──up_proj──> tmp [n_ff, n_tokens]
cur ──gate_proj─> cur [n_ff, n_tokens]
cur = swiglu_split(cur, tmp)   // silu(cur) * tmp，fused kernel
cur ──down_proj──> [n_embd, n_tokens]
```

</details>

### `build_moe_ffn`：MoE 前馈

`build_moe_ffn` 的算子流（`src/llama-graph.cpp:1355–1709`）：

```text
cur ──gate_inp──> logits [n_expert, n_tokens]
logits ──softmax/sigmoid──> probs
[可选] probs + exp_probs_b ──> selection_probs (DeepSeek V3 selection bias)
[可选] group topk (DeepSeek V3 expert groups)
selection_probs ──argsort_top_k──> selected_experts [n_expert_used, n_tokens]
probs ──get_rows──> weights [1, n_expert_used, n_tokens]
[可选] weights 归一化
cur ──mul_mat_id(up/gate_exps)──> per-expert up/gate [n_ff, n_expert_used, n_tokens]
激活函数 (SiLU/GELU/ReLU)
cur ──mul_mat_id(down_exps)──> experts_out [n_embd, n_expert_used, n_tokens]
experts_out * weights ──sum──> moe_out [n_embd, n_tokens]
```

`ggml_mul_mat_id` 是 MoE 核心算子：接受一个 `[n_embd, n_ff, n_expert]` 的专家权重矩阵和 `selected_experts` 索引，仅对选中的专家执行矩阵乘法，避免计算全部专家。

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="MoE FFN operator pipeline showing gating, expert selection, and sparse matrix multiplication">
  <defs>
    <marker id="ar54" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="420" fill="#f8fafc" rx="8"/>
  <text x="380" y="24" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">MoE FFN 算子流（build_moe_ffn）</text>
  <rect x="30" y="44" width="80" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="70" y="65" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">cur</text>
  <line x1="110" y1="62" x2="150" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="150" y="44" width="130" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="215" y="62" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">gate_inp (W_g)</text>
  <text x="215" y="76" text-anchor="middle" font-size="9" fill="#94a3b8">logits [n_expert, n_tokens]</text>
  <line x1="280" y1="62" x2="320" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="320" y="44" width="130" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="385" y="62" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">softmax / sigmoid</text>
  <text x="385" y="76" text-anchor="middle" font-size="9" fill="#94a3b8">probs [n_expert, n_tokens]</text>
  <line x1="450" y1="62" x2="490" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="490" y="44" width="130" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="555" y="62" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">argsort_top_k</text>
  <text x="555" y="76" text-anchor="middle" font-size="9" fill="#94a3b8">selected [n_expert_used, n_tokens]</text>
  <line x1="555" y1="80" x2="555" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="430" y="110" width="250" height="40" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="555" y="128" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">get_rows(probs, selected)</text>
  <text x="555" y="142" text-anchor="middle" font-size="9" fill="#94a3b8">weights [1, n_expert_used, n_tokens]</text>
  <line x1="555" y1="150" x2="555" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <line x1="110" y1="76" x2="110" y2="180" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2"/>
  <line x1="110" y1="180" x2="150" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="150" y="162" width="200" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="250" y="180" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">mul_mat_id(up/gate_exps)</text>
  <text x="250" y="194" text-anchor="middle" font-size="9" fill="#64748b">per-expert up/gate [n_ff, n_expert_used, n_tokens]</text>
  <line x1="350" y1="182" x2="430" y2="182" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <text x="390" y="176" text-anchor="middle" font-size="9" fill="#94a3b8">仅对选中专家计算</text>
  <rect x="430" y="162" width="250" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="555" y="180" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">激活函数 (SiLU/GELU/ReLU)</text>
  <text x="555" y="194" text-anchor="middle" font-size="9" fill="#64748b">gated: silu(gate) × up</text>
  <line x1="555" y1="202" x2="555" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="430" y="232" width="250" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="555" y="250" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">mul_mat_id(down_exps)</text>
  <text x="555" y="264" text-anchor="middle" font-size="9" fill="#64748b">experts_out [n_embd, n_expert_used, n_tokens]</text>
  <line x1="555" y1="272" x2="555" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="390" y="302" width="330" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="555" y="322" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">experts_out × weights ──sum──> moe_out</text>
  <text x="555" y="336" text-anchor="middle" font-size="9" fill="#64748b">[n_embd, n_tokens]</text>
  <rect x="30" y="360" width="700" height="44" fill="#f1f5f9" rx="6" stroke="#cbd5e1"/>
  <text x="380" y="379" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ggml_mul_mat_id 核心优化</text>
  <text x="380" y="396" text-anchor="middle" font-size="10" fill="#64748b">接受 [n_embd, n_ff, n_expert] 专家矩阵 + selected 索引，仅对 n_expert_used 个选中专家执行矩阵乘法</text>
</svg>
<span class="figure-caption">图 R5.4 ｜ MoE FFN 算子流：门控选择→稀疏矩阵乘法→加权求和</span>

<details>
<summary>ASCII 原版</summary>

```
cur ──gate_inp──> logits [n_expert, n_tokens]
logits ──softmax/sigmoid──> probs
[可选] probs + exp_probs_b ──> selection_probs (DeepSeek V3 selection bias)
[可选] group topk (DeepSeek V3 expert groups)
selection_probs ──argsort_top_k──> selected_experts [n_expert_used, n_tokens]
probs ──get_rows──> weights [1, n_expert_used, n_tokens]
[可选] weights 归一化
cur ──mul_mat_id(up/gate_exps)──> per-expert up/gate [n_ff, n_expert_used, n_tokens]
激活函数 (SiLU/GELU/ReLU)
cur ──mul_mat_id(down_exps)──> experts_out [n_embd, n_expert_used, n_tokens]
experts_out * weights ──sum──> moe_out [n_embd, n_tokens]
```

</details>

---

## 5.5 架构分发机制

### 工厂函数

`src/llama-model.cpp:37` 的 `llama_model_mapping()` 依据 `llm_arch` 枚举实例化对应的模型子类：

```cpp
static llama_model * llama_model_mapping(llm_arch arch, ...) {
    switch (arch) {
        case LLM_ARCH_LLAMA:   return new llama_model_llama(params);
        case LLM_ARCH_LLAMA4:  return new llama_model_llama4(params);
        case LLM_ARCH_QWEN3:   return new llama_model_qwen3(params);
        // ... 60+ 架构
    }
}
```

### `build_graph` 的两层调用

```cpp
// src/llama-model.cpp:2092-2110
ggml_cgraph * llama_model::build_graph(const llm_graph_params & params) const {
    std::unique_ptr<llm_graph_context> llm = build_arch_graph(params); // 虚函数，架构特定
    llm->build_pooling(...);   // embedding 模型的池化层
    llm->build_sampling();     // 后端采样器
    llm->build_dense_out(...); // sentence-transformer 的 dense 投影
    llm->res->set_outputs();   // 标记输出张量
    return llm->res->get_gf(); // 返回 ggml_cgraph
}
```

`build_arch_graph` 是纯虚函数，每个架构子类实现：

```cpp
// src/models/llama.cpp:96-98
std::unique_ptr<llm_graph_context> llama_model_llama::build_arch_graph(
        const llm_graph_params & params) const {
    return std::make_unique<graph<false>>(*this, params);
}
```

`graph<false>` 的构造函数**就是**建图过程——调用链展开在初始化列表之后的构造体中完成。

### 两个典型架构示例

**LLaMA（`src/models/llama.cpp`）**：  
模板参数 `embed` 控制是否输出 lm_head 输出（`<false>` = 解码模式，`<true>` = embedding 模式，共享同一套图结构）。

```cpp
// src/models/llama.cpp:113-120
using inp_attn_type = std::conditional_t<embed,
    llm_graph_input_attn_no_cache, llm_graph_input_attn_kv>;
inp_attn_type * inp_attn = nullptr;
if constexpr (embed) {
    inp_attn = build_attn_inp_no_cache();  // 无 KV cache
} else {
    inp_attn = build_attn_inp_kv();        // 有 KV cache
}
```

**DeepSeek2（`src/models/deepseek2.cpp`）**：  
使用 MLA（Multi-head Latent Attention）——先将 KV 压缩到低秩空间，再在 attention 中用 `v_mla` 参数恢复（吸收优化），从而减小 KV cache 体积。通过 `build_attn(..., v_mla, ...)` 中的额外矩阵乘法实现。

---

## 5.6 图类型与 KV cache、scheduler 的接线

### `llm_graph_type` 枚举

```cpp
// src/llama-graph.h:31-36
enum llm_graph_type {
    LLM_GRAPH_TYPE_DEFAULT,      // 标准解码器
    LLM_GRAPH_TYPE_ENCODER,      // 纯编码器（BERT、T5 编码端）
    LLM_GRAPH_TYPE_DECODER,      // 编解码器中的解码器端
    LLM_GRAPH_TYPE_DECODER_MTP,  // Medusa/Multi-Token Prediction 解码器
};
```

`ENCODER` 模式下，`build_attn_inp_no_cache()` 被调用（双向注意力），不使用 KV cache。`DECODER` 模式下，交叉注意力通过 `build_attn_inp_cross()` + `llama_cross` 结构传入编码器输出。

### KV cache 接线

`llm_graph_input_attn_kv` 持有 `const llama_kv_cache_context * mctx`，在 `set_input()` 中用 `mctx->set_input_k_idxs()` / `set_input_v_idxs()` 等方法填充 slot 索引。建图时，`build_attn` 用这些索引生成：

```text
新 K ──ggml_set_rows──> kv_cache.k_l[il]    // 写入 cache
kv_cache.k_l[il] ──ggml_get_rows──> k_all   // 读回所有 K
```

KV cache 的张量（`kv_cache.k_l[il]`、`kv_cache.v_l[il]`）是永久分配的权重级别张量，与计算图共存于不同的 ggml_context。

### Backend Scheduler 接线

`ggml_backend_sched` 负责将各个算子分配给最优后端（GPU/CPU）。`llm_graph_params::cb`（回调）在 `llm_graph_context::cb()` 中被触发，允许调用者（`llama_context`）对每个节点调用 `ggml_backend_sched_set_tensor_backend()` 指定后端。

无法 offload 的路径（如 `offload_kqv == false`）在 `build_attn_mha` 中显式标记：

```cpp
// src/llama-graph.cpp:2064-2067
if (!cparams.offload_kqv) {
    ggml_backend_sched_set_tensor_backend(sched, cur, backend_cpu);
}
```

---

## 5.7 一次前向的完整算子流

以 LLaMA decoder-only 模型为例：

<svg viewBox="0 0 640 580" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="LLaMA decoder-only full forward pass operator flow from token embedding through transformer layers to logits">
  <defs>
    <marker id="ar55" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="580" fill="#f8fafc" rx="8"/>
  <text x="320" y="22" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">LLaMA 一次前向完整算子流</text>
  <rect x="200" y="32" width="240" height="36" fill="#f1f5f9" stroke="#cbd5e1" rx="6"/>
  <text x="320" y="50" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">token_ids  I32[n_tokens]</text>
  <text x="320" y="63" text-anchor="middle" font-size="9" fill="#94a3b8">输入 token id</text>
  <line x1="320" y1="68" x2="320" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar55)"/>
  <rect x="190" y="88" width="260" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="320" y="106" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">build_inp_embd(tok_embd)</text>
  <text x="320" y="119" text-anchor="middle" font-size="9" fill="#64748b">get_rows → inpL [n_embd × n_tokens]</text>
  <line x1="320" y1="124" x2="320" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar55)"/>
  <rect x="30" y="144" width="580" height="282" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5" rx="8" stroke-dasharray="5,3"/>
  <text x="320" y="162" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">for il = 0 .. n_layer-1</text>
  <rect x="50" y="170" width="540" height="44" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="320" y="188" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">attn_norm: build_norm(inpL, attn_norm_w, RMS)</text>
  <text x="320" y="202" text-anchor="middle" font-size="9" fill="#94a3b8">inpSA = inpL（保存残差）</text>
  <rect x="50" y="220" width="540" height="62" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="320" y="238" text-anchor="middle" font-size="10" font-weight="600" fill="#0d9488">self-attention: build_qkv → RoPE → build_attn</text>
  <text x="320" y="252" text-anchor="middle" font-size="9" fill="#64748b">write K/V to cache  |  read all K/V  |  Q@K^T → softmax → @V  |  @wo</text>
  <text x="320" y="266" text-anchor="middle" font-size="9" fill="#94a3b8">输出 cur [n_embd × n_tokens]</text>
  <rect x="50" y="288" width="540" height="30" fill="#eff6ff" stroke="#0ea5e9" rx="4"/>
  <text x="320" y="308" text-anchor="middle" font-size="10" fill="#0ea5e9">残差连接: ffn_inp = cur + inpSA</text>
  <rect x="50" y="324" width="540" height="30" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="320" y="344" text-anchor="middle" font-size="10" fill="#64748b">ffn_norm: build_norm(ffn_inp, ffn_norm_w, RMS)</text>
  <rect x="50" y="360" width="540" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="320" y="378" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">FFN: build_ffn(SwiGLU)   或   build_moe_ffn(MoE)</text>
  <text x="320" y="391" text-anchor="middle" font-size="9" fill="#94a3b8">可选: build_cvec(cur, il)  ControlVector</text>
  <rect x="50" y="400" width="540" height="20" fill="#eff6ff" stroke="#0ea5e9" rx="4"/>
  <text x="320" y="415" text-anchor="middle" font-size="10" fill="#0ea5e9">残差连接: inpL = cur + ffn_inp</text>
  <line x1="320" y1="426" x2="320" y2="450" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar55)"/>
  <rect x="170" y="450" width="300" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="320" y="468" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">build_norm(cur, output_norm, RMS)</text>
  <text x="320" y="481" text-anchor="middle" font-size="9" fill="#64748b">res->t_embd = cur（embedding 输出）</text>
  <line x1="320" y1="486" x2="320" y2="506" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar55)"/>
  <rect x="170" y="506" width="300" height="36" fill="#0d9488" stroke="#0d9488" rx="6"/>
  <text x="320" y="524" text-anchor="middle" font-size="11" font-weight="600" fill="white">build_lora_mm(model.output, cur)</text>
  <text x="320" y="537" text-anchor="middle" font-size="9" fill="#99f6e4">lm_head 投影（仅解码模式）</text>
  <line x1="320" y1="542" x2="320" y2="560" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar55)"/>
  <rect x="170" y="560" width="300" height="14" fill="#f0fdf4" stroke="#16a34a" rx="4"/>
  <text x="320" y="571" text-anchor="middle" font-size="9" font-weight="600" fill="#16a34a">t_logits [n_vocab × n_outputs]</text>
</svg>
<span class="figure-caption">图 R5.5 ｜ LLaMA decoder-only 一次前向完整算子流（embedding → n_layer Transformer → logits）</span>

<details>
<summary>ASCII 原版</summary>

```
输入: [token_ids I32(n_tokens)]
                   |
         build_inp_embd(tok_embd)
          ├─ ggml_get_rows(tok_embd, tokens)   // token embedding lookup
          └─ ggml_build_forward_select(...)    // token vs. raw embedding 路径选择
                   |
                  inpL [F32: n_embd × n_tokens]
                   |
         ┌─────────────────────────────────────────┐
         │  for il = 0 .. n_layer-1:               │
         │                                          │
         │  inpSA = inpL                            │
         │                                          │
         │  ── attn_norm ──                         │
         │  cur = build_norm(inpL, attn_norm, RMS)  │
         │                                          │
         │  ── self-attention ──                    │
         │  [Q,K,V] = build_qkv(layer, cur)         │
         │  Q,K = ggml_rope_ext(Q/K, inp_pos, ...)  │  RoPE 位置编码
         │  cur = build_attn(inp_attn,               │
         │           layer.wo, Q, K, V, kq_scale)   │
         │    内部: write K/V to cache              │
         │          read all K/V from cache         │
         │          Q @ K^T → softmax → @ V         │
         │          output @ wo                     │
         │                                          │
         │  ── 残差连接 ──                          │
         │  ffn_inp = cur + inpSA                   │
         │                                          │
         │  ── ffn_norm ──                          │
         │  cur = build_norm(ffn_inp, ffn_norm, RMS)│
         │                                          │
         │  ── FFN (SwiGLU / MoE) ──                │
         │  cur = build_ffn(cur, up, gate, down)    │
         │     或                                   │
         │  cur = build_moe_ffn(cur, gate_inp, ...) │
         │                                          │
         │  ── 残差连接 ──                          │
         │  cur = cur + ffn_inp                     │
         │                                          │
         │  ── ControlVector (可选) ──               │
         │  cur = build_cvec(cur, il)               │
         │                                          │
         │  inpL = cur                              │
         └─────────────────────────────────────────┘
                   |
         build_norm(cur, output_norm, NULL, RMS)    // 最终 RMSNorm
                   |
         res->t_embd = cur                          // embedding 输出
                   |
         build_lora_mm(model.output, cur)           // lm_head 投影 (仅解码模式)
                   |
         res->t_logits = cur                        // logits [n_vocab × n_outputs]
                   |
         ggml_build_forward_expand(gf, cur)         // 标记终止节点
```

</details>

`inp_out_ids` 的作用：在最后一层后（`il == n_layer - 1`）用 `ggml_get_rows(cur, inp_out_ids)` 只保留需要输出的行，避免对 prefill 阶段中间 token 做无谓的 lm_head 计算。`res->t_h_pre_norm` 则在 output_norm 之前截取隐状态，供 speculative decoding 等功能使用。

---

## 5.8 `llm_graph_result`：图的结果容器

`llm_graph_result`（`src/llama-graph.h:638–703`）同时承担三个角色：

1. **ggml context 持有者**：`ctx_compute`（`ggml_context_ptr`）存储图节点元数据
2. **输入适配器容器**：`inputs` 列表持有所有 `llm_graph_input_i` 对象
3. **输出张量注册表**：`t_logits`、`t_embd`、`t_embd_pooled`、`t_sampled` 等在 `set_outputs()` 中被标记为图输出

`llama_context` 通过 `gf_res_prev` 持有上一次的 `llm_graph_result`，以便下次尝试复用。`gf_res_reserve` 则用于预分配内存（KV cache 扩容时使用）。

---

## 小结

| 关键设计决策 | 动机 |
|---|---|
| 每步重建图（有条件跳过）| batch size、KV 位置等动态，静态图无法表达 |
| 输入适配器 `llm_graph_input_i` 分离建图与填数 | 图复用时仅刷新数据，不重建拓扑 |
| 架构特定 builder 继承 `llm_graph_context` | 代码复用：所有架构共享 norm/attn/ffn 构建块 |
| `build_arch_graph` 虚函数 dispatch | 运行时多态，60+ 架构共享同一调用路径 |
| 通用构建块(`build_ffn`, `build_attn_mha`)内嵌 lora/cvec/scale 支持 | 避免在每个架构中重复实现适配器逻辑 |
