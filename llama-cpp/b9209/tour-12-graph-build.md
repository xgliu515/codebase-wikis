# Trace 步骤 12 —— 计算图为什么每次 decode 都要重建?

## 1. 当前情境

步骤 11 结束后,`llama_context::decode` 已经拿到了一个就绪的 `llama_ubatch`:

- `ubatch.n_tokens` = prompt 长度
- `ubatch.token[]` = 各 token id
- `ubatch.pos[]` = 0, 1, 2, ..., n-1
- `ubatch.seq_id[][]` = 全 0
- `ubatch.output[]` = 仅末尾 1 个 token 置 1

对应的 KV 缓存槽位(`slot_info.idxs`)也已确定,`mctx->apply()` 已在 `src/llama-context.cpp:1237` 将 cell 元数据落地。

紧接着,`process_ubatch` (`src/llama-context.cpp:1236`) 被调用,它的第一件正事是**构建本次前向的 ggml 计算图**。

---

## 2. 问题

前向计算的数学结构是确定的——对一个 28 层(或任意层数)的 Transformer 来说,矩阵乘、RoPE、注意力、FFN 的拼接顺序不会变。但每次 decode 喂入的 token 数不同:prefill 是 n_prompt 个,后续每轮 decode 是 1 个。这两种情况下注意力矩阵的形状、KV mask 的形状都不一样。

核心问题:**如何让"结构固定但形状可变"的计算图在每次 decode 时都能正确对应当前 ubatch 的尺寸,同时又不至于每次重建都慢得不可接受?**

---

## 3. 朴素思路

预先编译一个"最大尺寸"的固定图——图里所有张量都按最大 batch 大小分配,每次运行时把多余的位置填零或 mask 掉。这样图只需建一次,反复执行。

---

## 4. 为什么朴素思路会崩

- **显存浪费严重**:prefill 时 n_tokens 可以是几百,decode 时只有 1。如果统一按最大 batch 分配激活张量,每次 decode 浪费几百倍的临时显存。在 KV 缓存本就紧张的情况下,这是不可接受的。
- **KQ mask 形状依赖当前的 n_kv**:注意力的 mask 张量形状是 `[n_kv, n_tokens]`,`n_kv` 随每次 decode 递增。固定图里这个尺寸是写死的,要么太大(浪费带宽)要么太小(越界)。
- **量化类型的 matmul 节点需要知道运行时的精确形状**:GGML 的量化 matmul(`GGML_OP_MUL_MAT`)会根据输入形状选择不同的 kernel 路径。在 reserve 阶段用最大形状"预热"后,实际执行时换成小形状,可能选到不同的 kernel,产生正确性问题。
- **LoRA、ControlVector 等插件的图拓扑取决于是否激活**:这些特性可能在运行时动态启用/禁用,固定图无法应对拓扑变化。

根本矛盾:**ggml 的计算图是"形状即图结构"的——张量的 `ne[]` 就是图的一部分,不能像符号计算框架那样"运行时绑定形状"。**

---

## 5. llama.cpp 的做法

llama.cpp 每次 decode 都重建计算图,但通过**图复用检测**把重建成本压到接近零。

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="process_ubatch call flow: apply KV, check reuse, build graph, alloc, set inputs">
  <defs>
    <marker id="t12ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="t12ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
  </defs>
  <rect width="760" height="600" fill="#f8fafc" rx="6"/>
  <rect x="220" y="12" width="320" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">process_ubatch(ubatch, gtype, mctx, ...)</text>
  <text x="380" y="42" text-anchor="middle" font-size="10" fill="#64748b">src/llama-context.cpp:1236</text>
  <line x1="380" y1="48" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="200" y="68" width="360" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="82" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">mctx→apply()</text>
  <text x="380" y="94" text-anchor="middle" font-size="10" fill="#94a3b8">写 KV cell 元数据 (seq_id / pos)</text>
  <line x1="380" y1="100" x2="380" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="200" y="120" width="360" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="134" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">graph_params(res, ubatch, mctx, gtype)</text>
  <text x="380" y="146" text-anchor="middle" font-size="10" fill="#94a3b8">收集本次图的唯一参数</text>
  <line x1="380" y1="152" x2="380" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="200" y="172" width="360" height="32" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="186" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">res→can_reuse(gparams)?</text>
  <text x="380" y="200" text-anchor="middle" font-size="10" fill="#94a3b8">图参数与上次相同 → 可复用</text>
  <line x1="220" y1="188" x2="100" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="20" y="172" width="80" height="32" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="60" y="188" text-anchor="middle" font-size="10" fill="#16a34a">YES</text>
  <text x="60" y="200" text-anchor="middle" font-size="9" fill="#64748b">直接 set_inputs</text>
  <line x1="380" y1="204" x2="380" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <text x="420" y="218" font-size="9" fill="#64748b">NO → 重建图</text>
  <rect x="120" y="224" width="520" height="200" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="380" y="242" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">model.build_graph(gparams) → build_arch_graph</text>
  <text x="380" y="256" text-anchor="middle" font-size="10" fill="#94a3b8">Qwen2: llama_model_qwen2::build_arch_graph  src/models/qwen2.cpp:48</text>
  <rect x="135" y="262" width="150" height="52" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="210" y="278" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">叶子节点</text>
  <text x="210" y="292" text-anchor="middle" font-size="9" fill="#64748b">build_inp_embd</text>
  <text x="210" y="304" text-anchor="middle" font-size="9" fill="#64748b">build_inp_pos</text>
  <text x="210" y="316" text-anchor="middle" font-size="9" fill="#64748b">build_attn_inp_kv</text>
  <rect x="305" y="262" width="200" height="52" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="405" y="278" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">per-layer (×n_layer)</text>
  <text x="405" y="292" text-anchor="middle" font-size="9" fill="#64748b">norm → QKV → RoPE</text>
  <text x="405" y="304" text-anchor="middle" font-size="9" fill="#64748b">attn (cpy_k/cpy_v + MHA)</text>
  <text x="405" y="316" text-anchor="middle" font-size="9" fill="#64748b">FFN (up/gate/down SiLU)</text>
  <rect x="525" y="262" width="100" height="52" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="575" y="278" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">输出头</text>
  <text x="575" y="292" text-anchor="middle" font-size="9" fill="#64748b">output_norm</text>
  <text x="575" y="304" text-anchor="middle" font-size="9" fill="#64748b">lm_head</text>
  <text x="575" y="316" text-anchor="middle" font-size="9" fill="#64748b">(lora_mm)</text>
  <text x="380" y="348" text-anchor="middle" font-size="9" fill="#94a3b8">只添加节点到 ggml_cgraph,不做实际计算</text>
  <text x="380" y="362" text-anchor="middle" font-size="9" fill="#94a3b8">cpy_k/cpy_v 节点会在执行阶段把 K/V 写入 KV cache</text>
  <text x="380" y="378" text-anchor="middle" font-size="9" fill="#94a3b8">src/models/qwen2.cpp:61-153</text>
  <text x="380" y="392" text-anchor="middle" font-size="9" fill="#94a3b8">src/llama-model.cpp:2092  src/llama-graph.cpp:1712,1796,2174</text>
  <line x1="380" y1="424" x2="380" y2="444" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="180" y="444" width="400" height="32" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="458" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ggml_backend_sched_alloc_graph(sched, gf)</text>
  <text x="380" y="470" text-anchor="middle" font-size="10" fill="#94a3b8">为图上每个张量分配显存/内存</text>
  <line x1="380" y1="476" x2="380" y2="496" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t12ar1)"/>
  <rect x="150" y="496" width="460" height="52" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="514" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">res→set_inputs(&amp;ubatch)</text>
  <text x="380" y="530" text-anchor="middle" font-size="10" fill="#64748b">inp_tokens ← token[]  |  inp_pos ← pos[]</text>
  <text x="380" y="544" text-anchor="middle" font-size="10" fill="#64748b">kq_mask ← 因果掩码(上三角 -inf)  |  K/V 槽位下标 ← sinfo.idxs</text>
  <text x="380" y="560" text-anchor="middle" font-size="9" fill="#94a3b8">此后叶子张量有值,中间张量由后端执行时填充</text>
  <text x="380" y="576" text-anchor="middle" font-size="9" fill="#94a3b8">src/llama-context.cpp:1291</text>
</svg>
<span class="figure-caption">图 T12.1 ｜ process_ubatch 完整调用流：KV 落地 → 图复用检测 → 架构图构建 → 显存分配 → 叶子填值</span>

<details>
<summary>ASCII 原版</summary>

```
process_ubatch(ubatch, gtype, mctx, ...)
    [src/llama-context.cpp:1236]
    |
    +-- mctx->apply()                         写 KV cell 元数据
    |
    +-- graph_params(res, ubatch, mctx, gtype) 收集本次图的唯一参数
    |   [src/llama-context.cpp:1248]
    |
    +-- res->can_reuse(gparams) ?
    |       YES -> 跳过建图,直接 set_inputs  (decode 第 2+ 次通常走这里)
    |       NO  -> 重建图
    |               |
    |               v
    |           model.build_graph(gparams)     [src/llama-model.cpp:2092]
    |               |
    |               v
    |           build_arch_graph(params)       架构分发
    |           [src/llama-model.cpp:2093]
    |           对 Qwen2 -> llama_model_qwen2::build_arch_graph
    |           [src/models/qwen2.cpp:48]
    |               |
    |               +-- build_inp_embd(tok_embd)    token id 查嵌入表
    |               |   [src/llama-graph.cpp:1712]
    |               +-- build_inp_pos()             位置张量叶子
    |               |   [src/llama-graph.cpp:1796]
    |               +-- build_attn_inp_kv()         KQ mask + K/V 索引叶子
    |               |   [src/llama-graph.cpp:2174]
    |               +-- for il in 0..n_layer:
    |               |     build_norm(attn_norm)
    |               |     build_qkv -> Q, K, V
    |               |     ggml_rope_ext(Q), ggml_rope_ext(K)
    |               |     build_attn(inp_attn, wo, Q,K,V, ...)
    |               |       cpy_k / cpy_v -> 写 KV cache 的 ggml 节点
    |               |       build_attn_mha -> QK^T softmax V
    |               |     ffn_inp = attn_out + residual
    |               |     build_norm(ffn_norm)
    |               |     build_ffn(up, gate, down, SiLU)
    |               |     cur = ffn_out + ffn_inp
    |               +-- build_norm(output_norm)
    |               +-- build_lora_mm(output, cur) -> lm_head
    |               [src/models/qwen2.cpp:61-153]
    |
    +-- ggml_backend_sched_alloc_graph(sched, gf)  为图分配显存
    |   [src/llama-context.cpp:1279]
    |
    +-- res->set_inputs(&ubatch)              把真实数据写入叶子张量
        [src/llama-context.cpp:1291]
        - inp_tokens <- ubatch.token[]
        - inp_pos    <- ubatch.pos[]
        - kq_mask    <- 因果掩码矩阵 (上三角 -inf)
        - K/V 槽位下标 <- sinfo.idxs
```

</details>

**构建的不是"执行",而是"描述"**

`build_inp_embd`、`build_qkv`、`build_attn` 等函数都只是在 `ggml_context`(`ctx0`)里调用 `ggml_get_rows`、`ggml_mul_mat`、`ggml_rope_ext` 等 API——这些调用只是把算子节点添加进 `gf`(一个 `ggml_cgraph`),记录"谁依赖谁"。实际的矩阵运算一个都没有发生。

**叶子张量与输入适配器**

图的输入靠三类"叶子":

| 叶子名称 | 类型 | 内容 |
|---------|------|------|
| `inp_tokens` | `GGML_TYPE_I32` | token id 数组,形状 `[n_tokens]` |
| `inp_pos` | `GGML_TYPE_I32` | 位置数组,形状 `[n_tokens]` |
| KQ mask | `GGML_TYPE_F32` | 因果掩码矩阵,形状 `[n_kv, n_tokens/n_stream]` |

这三个张量都由 `ggml_set_input` 标记,分配在 CPU 可写的 host buffer 里。`res->set_inputs(&ubatch)` 在 `ggml_backend_sched_alloc_graph` 之后把真实数值逐一填入(`src/llama-context.cpp:1291`)。

**图复用检测**

`can_reuse(gparams)` 检查本次图参数与上一次是否完全相同。decode 阶段每次喂 1 个 token,`n_tokens = 1` 不变、`n_kv` 每轮加 1,KQ mask 形状变化——所以 decode 阶段通常**不能**复用。但 speculative decoding 等场景下连续喂相同形状时可以复用(`src/llama-context.cpp:1250`)。

---

## 6. 代码位置

按阅读顺序:

- `process_ubatch` 入口:`src/llama-context.cpp:1236`
- `graph_params` 收集参数:`src/llama-context.cpp:1248` 调用,定义在 `src/llama-context.cpp:2270`
- 图复用检测:`src/llama-context.cpp:1250` — `res->can_reuse(gparams)`
- `model.build_graph`:`src/llama-model.cpp:2092`
- 架构分发 `build_arch_graph`:`src/llama-model.cpp:2093`
- Qwen2 图构建:`src/models/qwen2.cpp:48`-`153`
- token 嵌入叶子:`src/llama-graph.cpp:1712` — `build_inp_embd`
- 位置叶子:`src/llama-graph.cpp:1796` — `build_inp_pos`
- KQ mask + KV 索引叶子:`src/llama-graph.cpp:2174` — `build_attn_inp_kv`
- 注意力(含 KV 写入):`src/llama-graph.cpp:2182` — `build_attn(inp_attn_kv, ...)`
  - KV 写入节点:`src/llama-graph.cpp:2220-2221` — `mctx_cur->cpy_k / cpy_v`
  - MHA 核心:`src/llama-graph.cpp:2230` — `build_attn_mha`
- FFN:`src/llama-graph.cpp:1149` — `build_ffn`
- 图分配:`src/llama-context.cpp:1279` — `ggml_backend_sched_alloc_graph`
- 输入填充:`src/llama-context.cpp:1291` — `res->set_inputs(&ubatch)`

---

## 7. 分支与延伸

- `ggml_cgraph` 节点/叶子的数据结构、`ggml_build_forward_expand` 如何从输出节点反向推导依赖链 → [第 4 章 GGML 张量与计算图](04-ggml-tensor-and-graph.md)
- `llm_graph_context`、`llm_graph_params`、`llm_graph_result` 的设计分工 → [第 5 章 计算图构建与前向推理](05-graph-construction.md)
- GQA(分组查询注意力)、Flash Attention 对图拓扑的影响 → [第 5 章 §注意力变体](05-graph-construction.md)
- LoRA 权重如何被注入图(`build_lora_mm`) → [第 5 章 §LoRA](05-graph-construction.md)
- `ggml_backend_sched_alloc_graph` 在分配阶段做了什么(split_graph + gallocr_reserve_n) → [第 9 章 GGML 后端系统](09-ggml-backend.md)
- 图构建完成后图是怎么被执行的 → [步骤 13 后端执行前向计算](tour-13-backend-compute.md)

---

## 8. 走完这一步你脑子里应该多了什么

1. **ggml 图的"建图"是零计算的**:所有 `ggml_mul_mat`、`ggml_rope_ext` 调用只是在内存里追加算子节点,真正的矩阵运算发生在步骤 13 的后端执行阶段。
2. **图的形状由 ubatch 的 n_tokens 决定**,这是为什么每次 decode(n_tokens = 1)和 prefill(n_tokens = n_prompt)的图不同——节点的 `ne[]` 不同,图结构就不同。
3. **三类叶子张量是图和外部世界的唯一接口**:`inp_tokens`(token id)、`inp_pos`(位置)、KQ mask 在 `set_inputs` 时被填入实际数值,其余所有中间张量都在图内自动派生。
4. **图里的 KV 写入是计算图的一部分**:`cpy_k / cpy_v` 节点会在执行阶段把这一层算出的 K、V 写进 KV 缓存对应的 cell——写 KV 不是一个独立的"后处理"步骤,它嵌在前向计算图里。
5. **图复用机制让 decode 阶段的重建开销可忽略**:当连续两次的图参数完全相同时,跳过重建,直接更新叶子数值后复用上一张图。

下一步:[步骤 13 —— 后端执行前向计算](tour-13-backend-compute.md)。
