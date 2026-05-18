# 第 7 章 推理上下文与批处理

## 总览

`llama_context` 是 llama.cpp 推理管线的执行核心。它把 `llama_model`（只读权重）与运行时可变状态绑定在一起：KV cache（或 recurrent state）、后端调度器、计算缓冲、输出缓冲以及通过 `cparams` 固化的运行时超参数。所有推理入口（`encode`/`decode`）都通过这个对象完成。

本章涵盖以下内容：

1. `llama_context` 的组成与生命周期
2. 上下文创建过程——参数决策与 `sched_reserve`
3. `llama_batch` 的字段语义与两种构造方式
4. 微批（ubatch）的切分逻辑
5. `llama_decode` 的完整执行路径
6. logits / embeddings 的输出布局
7. encode 与 decode 的差异，以及状态保存/恢复

---

## 7.1 llama_context 的组成

`llama_context` 定义于 `src/llama-context.h:41`，成员可以分为五个功能组：

**引用与参数**

```cpp
// src/llama-context.h:267-269
const llama_model & model;   // 只读权重引用，不拥有所有权
llama_cparams cparams;       // 运行时上下文参数的完整拷贝
```

`cparams` 类型为 `llama_cparams`（`src/llama-cparams.h:9`），持有所有运行期超参数的最终值，包括：

```cpp
// src/llama-cparams.h:10-13
uint32_t n_ctx;      // 总上下文槽位数（经 256 对齐）
uint32_t n_ctx_seq;  // 单序列最大长度 = n_ctx / n_seq_max（unified=false 时）
uint32_t n_batch;    // llama_decode 可接受的最大 token 数（逻辑批次）
uint32_t n_ubatch;   // 实际送入 GPU 的最大 token 数（物理微批）
```

**内存子系统**

```cpp
// src/llama-context.h:276
std::unique_ptr<llama_memory_i> memory;
```

`memory` 指向一个多态的内存实现，通常是 `llama_kv_cache`，也可能是 `llama_memory_recurrent`（SSM 模型）或 `llama_memory_hybrid`（混合模型）。详见第 8 章。

**后端调度器与计算缓冲**

```cpp
// src/llama-context.h:327-347
ggml_backend_sched_ptr sched;
std::vector<ggml_backend_t>             backend_ptrs;
std::vector<ggml_backend_buffer_type_t> backend_buft;
```

`ggml_backend_sched_t` 负责跨多后端（CPU/GPU）的张量分配与执行调度。`backend_buft[i]` 记录第 `i` 个后端对应的缓冲类型，`sched_reserve()` 通过预运行最坏情况计算图来确定各后端需要的缓冲大小。

**输出缓冲**

```cpp
// src/llama-context.h:279-283
buffer_view<float> logits    = {nullptr, 0};   // [n_outputs][n_vocab]
buffer_view<float> embd      = {nullptr, 0};   // [n_outputs][n_embd]（仅 pooling=NONE）
buffer_view<float> embd_pre_norm = {nullptr, 0};
```

这三块均指向 `buf_output`（host buffer），由 `output_reserve()` 按需扩容。

**批次分配器**

```cpp
// src/llama-context.h:314
std::unique_ptr<llama_batch_allocr> balloc;
```

复用同一个 `llama_batch_allocr` 实例可以避免每次 decode 时重新分配内存。

---

## 7.2 上下文创建：llama_init_from_model

上下文由 `llama_context::llama_context(model, params)` 构造，公开接口为 `llama_init_from_model`（`include/llama.h`）。

### 7.2.1 n_ctx / n_batch / n_ubatch 的含义

```
n_ctx      ─── KV cache 总槽位（所有序列共享），经 256 对齐
n_ctx_seq  ─── = n_ctx（unified=true）或 n_ctx/n_seq_max（unified=false）
n_batch    ─── 一次 llama_decode 调用可接受的最大 token 数（API 层限制）
n_ubatch   ─── 一次实际 GPU/CPU 计算的 token 数（必须 <= n_batch）
```

`n_batch` 是逻辑批次，关键约束来自 `src/llama-context.cpp:181`：

```cpp
// src/llama-context.cpp:181-183
cparams.n_batch = cparams.causal_attn
    ? std::min(cparams.n_ctx, params.n_batch)
    : params.n_batch;
cparams.n_ubatch = std::min(cparams.n_batch,
    params.n_ubatch == 0 ? params.n_batch : params.n_ubatch);
```

因果注意力模型不允许 batch 超过 context。`n_ubatch` 是内部拆分粒度，决定 KV cache 槽位分配的最小原子单位。

### 7.2.2 后端枚举与 buft 选择

```cpp
// src/llama-context.cpp:241-268
for (const auto & dev : model.devices) {
    ggml_backend_t backend = ggml_backend_dev_init(dev.dev, nullptr);
    backends.emplace_back(backend);
}
// ACCEL 后端（如 BLAS）...
backend_cpu = ggml_backend_init_by_type(GGML_BACKEND_DEVICE_TYPE_CPU, nullptr);
backends.emplace_back(backend_cpu);
```

对于 CPU backend，如果模型已有 GPU 设备，则优先使用第一个 GPU 的 host buffer（pinned memory），以加速中间状态从 GPU 到 CPU 的传输（`src/llama-context.cpp:320-327`）。

### 7.2.3 sched_reserve 流程

`sched_reserve()`（`src/llama-context.cpp:411`）在首次执行前和某些参数变更时调用，其职责是：

1. 创建新的 `ggml_backend_sched_t`
2. 调用 `memory->init_full()` 模拟满缓存状态
3. 依次预运行 PP 图（prompt processing，n_tokens = n_ubatch）和 TG 图（token generation，n_tokens = n_seqs）
4. 记录各后端实际分配的缓冲大小到 `backend_buf_exp_size`

```cpp
// src/llama-context.cpp:580-621
// reserve pp (prompt processing) graph first
auto * gf = graph_reserve(n_tokens, n_seqs, n_tokens, mctx.get(), ...);
// reserve tg (token generation) graph
auto * gf = graph_reserve(n_seqs, n_seqs, n_seqs, mctx.get(), ...);
// reserve pp again to lock final buffer sizes
auto * gf = graph_reserve(n_tokens, n_seqs, n_tokens, mctx.get(), ...);
```

三次 reserve 的原因：第一次确定 PP 需要的缓冲；第二次确定 TG 需要的缓冲；第三次以 PP（最坏情况）为终态，防止 TG 反而分配更大缓冲导致 PP 运行时重新分配。

Flash Attention 的自动检测也在此阶段进行（`src/llama-context.cpp:451-488`）：以 split-only 模式运行图，检查 `GGML_OP_FLASH_ATTN_EXT` 节点所在设备与 KV cache 所在设备是否一致。

---

## 7.3 llama_batch 字段语义

`llama_batch` 定义于 `include/llama.h:240`：

```c
// include/llama.h:240-249
typedef struct llama_batch {
    int32_t n_tokens;

    llama_token  *  token;    // [n_tokens] token ids（与 embd 二选一）
    float        *  embd;     // [n_embd * n_tokens] float embeddings（与 token 二选一）
    llama_pos    *  pos;      // [n_tokens] 各 token 在序列中的位置；NULL = 自动追踪
    int32_t      *  n_seq_id; // [n_tokens] 各 token 所属序列数量
    llama_seq_id ** seq_id;   // [n_tokens][n_seq_id[i]] 序列 id 列表；NULL = 全为 seq_id=0
    int8_t       *  logits;   // [n_tokens] 非零表示该 token 需要输出 logits；NULL = 只输出最后一个
} llama_batch;
```

各字段说明：

| 字段 | NULL 时默认行为 | 典型用途 |
|------|-----------------|----------|
| `token` | 与 `embd` 必有其一 | 正常文本推理 |
| `embd` | 见上 | 输入已是浮点嵌入（如多模态特征） |
| `pos` | 自动从 `memory->seq_pos_max(s)+1` 续接 | 需要手动控制位置时填充 |
| `n_seq_id` | 全填 1 | 一个 token 属于多个序列（beam search） |
| `seq_id` | 全填 seq_id=0 | 多序列并行 |
| `logits` | 仅最后一个 token 输出 | 显式控制哪些位置需要输出 |

### 7.3.1 两种构造方式

**`llama_batch_get_one`**（`include/llama.h:911`）：传入 token 数组与长度，返回固定 seq_id=0、位置自动追踪的 batch。是最简单的用法，适合单序列、单路推理。

**`llama_batch_init` + 手动填充**：预分配所有字段的内存，调用者逐一填写 `token`、`pos`、`seq_id`、`logits` 等，适合服务端多请求并发（不同 seq_id）、beam search（一 token 多 seq_id）等场景。

---

## 7.4 微批（ubatch）：拆分逻辑

### 7.4.1 为什么要拆成 ubatch

KV cache 的槽位分配以 ubatch 为原子单位，一个 ubatch 内所有 token 的缓存写入要在同一次图执行中完成。`n_batch` 可以超过 GPU 内存一次处理的上限，`n_ubatch` 则是实际的计算粒度。两个约束驱动拆分：

1. **KV 内存上限**：一次 ubatch 占用的 cache 槽位不能超过可用容量。
2. **等长序列要求**：multi-stream cache（`unified=false`）要求 ubatch 内每条序列恰好有相同数量的 token，才能并行写入各自的 stream。

### 7.4.2 llama_ubatch 结构

`llama_ubatch` 定义于 `src/llama-batch.h:15`，其核心字段：

```cpp
// src/llama-batch.h:34-52
uint32_t b_equal_seqs;  // 是否等长序列模式
uint32_t n_tokens;      // 总 token 数 = n_seq_tokens * n_seqs
uint32_t n_seq_tokens;  // 每个序列的 token 数（equal_seqs 模式下）
uint32_t n_seqs;        // 序列组数
uint32_t n_seqs_unq;    // 不重复序列 id 数
uint32_t n_pos;         // 每 token 的位置维度数（M-RoPE 时 >= 3）

llama_token  *  token;
float        *  embd;
llama_pos    *  pos;      // [n_tokens * n_pos]
int32_t      *  n_seq_id;
llama_seq_id ** seq_id;
int8_t       *  output;   // 对应每个 token 是否输出
```

### 7.4.3 llama_batch_allocr 拆分策略

`llama_batch_allocr`（`src/llama-batch.h:72`）提供三种拆分方法：

```
split_simple(n_ubatch)           ─── 不关心等长，顺序切割；用于 encoder
split_equal(n_ubatch, sequential) ─── 等长序列组；用于 multi-stream decoder
split_seq(n_ubatch)              ─── 每个 ubatch 只包含一个序列组
```

KV cache 的 `init_batch` 中（`src/llama-kv-cache.cpp:627`）根据 `n_stream` 选择策略：

```cpp
// src/llama-kv-cache.cpp:638
auto ubatch = n_stream == 1
    ? balloc.split_simple(n_ubatch)
    : balloc.split_equal(n_ubatch, true);
```

`split_equal` 的目的：multi-stream cache 需要将序列 s 的 token 对应地写入 stream s 的 KV 张量切片，要求每个序列提供相同数量的 token，否则无法用一次矩阵操作（`ggml_set_rows`）完成写入。

---

## 7.5 llama_decode 主流程

`llama_decode`（`src/llama-context.cpp:1611`）是推理的核心入口。以下流程图从 API 调用到取出 logits：

<svg viewBox="0 0 760 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_decode main execution flow">
  <defs>
    <marker id="ar7-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="560" fill="#f8fafc" rx="6"/>
  <rect x="240" y="16" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="39" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama_decode(ctx, batch_inp)</text>
  <line x1="380" y1="52" x2="380" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="140" y="74" width="480" height="32" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="95" text-anchor="middle" font-size="12" fill="#64748b">校验 n_tokens &gt; 0，token / embd 非空</text>
  <line x1="380" y1="106" x2="380" y2="126" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="60" y="128" width="640" height="74" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="180" y="148" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">balloc→init()</text>
  <text x="380" y="165" text-anchor="middle" font-size="11" fill="#64748b">自动补全 pos（从 seq_pos_max+1 续接）/ seq_id（默认 0）/ logits（默认末 token）</text>
  <line x1="380" y1="202" x2="380" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="160" y="220" width="440" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="241" text-anchor="middle" font-size="12" fill="#7c3aed">sched_reserve()   ← sched_need_reserve = true 时执行</text>
  <line x1="380" y1="252" x2="380" y2="268" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="60" y="270" width="640" height="72" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="180" y="290" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">memory→init_batch()</text>
  <text x="380" y="308" text-anchor="middle" font-size="11" fill="#64748b">拆分 batch → ubatches[]，prepare() 找 KV 槽位 → slot_info_vec[]</text>
  <text x="380" y="326" text-anchor="middle" font-size="11" fill="#64748b">返回 llama_kv_cache_context（持有 ubatches + sinfos）</text>
  <line x1="380" y1="342" x2="380" y2="358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="240" y="360" width="280" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="379" text-anchor="middle" font-size="11" fill="#64748b">output_reserve()  按需扩大 logits/embd 缓冲</text>
  <line x1="380" y1="388" x2="380" y2="406" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="60" y="408" width="640" height="110" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="180" y="428" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">do-while (mctx→next())</text>
  <text x="380" y="448" text-anchor="middle" font-size="11" fill="#64748b">process_ubatch() → apply() 写 cells 元数据</text>
  <text x="380" y="465" text-anchor="middle" font-size="11" fill="#64748b">can_reuse? 复用图 : build_graph() + sched_alloc_graph</text>
  <text x="380" y="482" text-anchor="middle" font-size="11" fill="#64748b">set_inputs() 填充 k_idxs / v_idxs / kq_mask / pos</text>
  <text x="380" y="499" text-anchor="middle" font-size="11" fill="#64748b">graph_compute() 异步调度</text>
  <line x1="380" y1="518" x2="380" y2="536" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-1)"/>
  <rect x="200" y="538" width="360" height="16" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="380" y="550" text-anchor="middle" font-size="11" fill="#ea580c">logits.data + offset  →  output_ids 映射</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ llama_decode 主流程：从参数校验、batch 补全、KV 槽位预分配到逐 ubatch 图执行</span>

<details>
<summary>ASCII 原版</summary>

```
llama_decode(ctx, batch_inp)
    │
    ├─ [校验] batch_inp.n_tokens > 0, token 或 embd 非空
    │
    ├─ balloc->init(batch_inp, vocab, memory, ...)
    │       ├─ 自动补全 pos（从 memory->seq_pos_max+1 续接）
    │       ├─ 自动补全 seq_id（默认 0）
    │       └─ 自动补全 logits（默认只输出最后 token）
    │
    ├─ sched_reserve()           ← 如果 sched_need_reserve = true
    │
    ├─ memory_update(false)      ← 处理 pending shift/copy
    │
    ├─ memory->init_batch(balloc, n_ubatch, output_all)
    │       ├─ 拆分 batch → ubatches[]
    │       ├─ prepare(ubatches) → slot_info_vec[]  ← 为每个 ubatch 找 KV 槽位
    │       └─ 返回 llama_kv_cache_context（持有 ubatches + sinfos）
    │
    ├─ output_reserve(n_outputs_all)   ← 按需扩大 logits/embd 输出缓冲
    │
    └─ do-while (mctx->next())
            │
            ├─ ubatch = mctx->get_ubatch()
            │
            ├─ process_ubatch(ubatch, GRAPH_TYPE_DEFAULT, mctx, status)
            │       ├─ mctx->apply()              ← 将 ubatch 写入 KV cells 元数据
            │       ├─ res->can_reuse(gparams)?
            │       │     ├─ YES: 复用上次图（n_reused++）
            │       │     └─ NO:  model.build_graph(gparams) + sched_alloc_graph
            │       ├─ res->set_inputs(&ubatch)   ← 填充 k_idxs/v_idxs/kq_mask/pos 等
            │       └─ graph_compute(gf, batched) ← 异步调度
            │
            ├─ ggml_backend_tensor_get_async(t_logits, logits.data + offset, ...)
            │
            └─ n_outputs_prev += n_outputs
```

</details>

### 7.5.1 槽位获取（find_slot）

`prepare()` 调用 `find_slot(ubatch, false)`（`src/llama-kv-cache.cpp:818`），对 ubatch 的每个不重复序列 id，在对应 stream 的 `v_cells` 数组中搜索空闲 cell（`pos == -1`）或可被 SWA 窗口剔除的 cell，收集 `n_tokens` 个索引并存入 `slot_info::idxs`。

`prepare()` 的特殊处理（`src/llama-kv-cache.cpp:676`）：为了对所有 ubatch 做原子预检，先模拟将每个 ubatch emplaced 进 cells，最后再逐步回滚恢复，确保 `init_batch` 要么全部成功要么全部失败。

### 7.5.2 图复用机制

每次 `process_ubatch` 会比较当前的 `gparams`（包含 n_tokens、n_kv、ubatch 指针等）与上次图的 `gparams`。若完全相同（`res->can_reuse(gparams)`），则跳过图构建和内存分配，只重新 `set_inputs`，节约了大量开销。这在 TG 阶段（每次 1 个 token）尤为显著。

---

## 7.6 logits 与 embeddings 输出

### 7.6.1 output_ids 映射

`output_ids`（`src/llama-context.h:318`）是一个从 batch 索引到 logits 行号的映射数组：

```cpp
// src/llama-context.h:318
std::vector<int32_t> output_ids;
// output_ids[batch_token_idx] = logits_row
// -1 表示该 token 未输出 logits
```

设置过程在 `decode()` 末尾（`src/llama-context.cpp:1941`）：

```cpp
// src/llama-context.cpp:1941-1948
auto & out_ids = balloc->get_out_ids();
for (int64_t i = 0; i < n_outputs; ++i) {
    int64_t out_id = out_ids[i];
    output_ids[out_id] = i;
}
```

`out_ids` 由 `llama_batch_allocr` 按 ubatch 切分顺序记录，而非按原始 batch 顺序，因此需要这个反向映射来支持随机访问。

### 7.6.2 get_logits_ith

```cpp
// src/llama-context.cpp:825-843
float * llama_context::get_logits_ith(int32_t i) {
    output_reorder();                       // 延迟排序
    const int64_t j = output_resolve_row(i); // batch 索引 → logits 行
    return logits.data + j*model.vocab.n_tokens();
}
```

`output_resolve_row(i)`（`src/llama-context.cpp:796`）支持负索引（`-1` 取最后一行），也会抛出越界异常。

### 7.6.3 哪些 token 产出 logits

由 `batch.logits[i]` 控制：

- 为 NULL 时：只有最后一个 token 输出（`llama_batch_allocr::init` 中自动设置）
- 非 NULL 时：`logits[i] != 0` 的 token 输出

在 embedding 模式（`cparams.embeddings=true`）下，所有 token 都输出（`output_all=true`）。

### 7.6.4 embeddings 输出

`embd`（`src/llama-context.h:283`）在 `cparams.pooling_type == LLAMA_POOLING_TYPE_NONE` 时按 token 填充；其他 pooling 模式（MEAN/CLS/LAST/RANK）下结果存入 `embd_seq`（以 seq_id 为键的 map），通过 `get_embeddings_seq(seq_id)` 取得。

---

## 7.7 encode 与 decode 的区别

| 维度 | encode | decode |
|------|--------|--------|
| KV cache | 不使用（`memory == nullptr` 或跳过） | 必须有 memory |
| 注意力类型 | 强制非因果（双向） | 遵循 `cparams.causal_attn` |
| 输出 | 所有 token 的 embeddings | 只有 `logits[i]!=0` 的 token |
| ubatch 拆分 | `split_simple`，不拆（`n_ubatch >= n_tokens`） | 可能多轮循环 |
| 图类型 | `LLM_GRAPH_TYPE_ENCODER` | `LLM_GRAPH_TYPE_DEFAULT`（或 MTP） |

`encode` 的实现（`src/llama-context.cpp:1308`）调用 `process_ubatch` 时传入 `nullptr` 作为 `mctx`（即不操作 KV cache），并在调用前后临时将 `cparams.causal_attn` 置为 false（`src/llama-context.cpp:1366`）。

### 7.7.1 状态保存与恢复

状态操作接口定义于 `src/llama-context.h:145`：

**全局状态**：
- `state_get_data(dst, size)` / `state_set_data(src, size)`：序列化整个上下文的 KV cache 状态到字节流（文件格式为 GGSN magic）
- `state_save_file` / `state_load_file`：带 token 序列的文件版本

**单序列状态**：
- `state_seq_get_data(seq_id, dst, size, flags)`
- `state_seq_set_data(seq_id, src, size, flags)`

底层实现将 `memory->state_write(io, seq_id, flags)` 序列化为包含 KV tensor 数据的字节流。恢复时调用 `state_read`，重建 cells 元数据并将 tensor 数据写回 device buffer。这是 server 端实现 "slot save/restore" 来支持请求迁移的基础机制。

---

## 7.8 关键调用路径汇总

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Key call paths summary for llama context API">
  <defs>
    <marker id="ar7-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="340" fill="#f8fafc" rx="6"/>
  <rect x="20" y="14" width="140" height="310" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="90" y="175" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor" transform="rotate(-90,90,175)">用户代码</text>
  <rect x="180" y="18" width="560" height="60" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="270" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_init_from_model()</text>
  <text x="490" y="50" text-anchor="middle" font-size="11" fill="#64748b">→ llama_context 构造 → sched_reserve() → 图预留 + 缓冲分配</text>
  <rect x="180" y="96" width="560" height="86" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="260" y="114" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_decode(ctx, batch)</text>
  <text x="490" y="130" text-anchor="middle" font-size="11" fill="#64748b">→ balloc→init()  补全 pos / seq_id / logits</text>
  <text x="490" y="148" text-anchor="middle" font-size="11" fill="#64748b">→ memory→init_batch()  拆 ubatch + 找 KV 槽</text>
  <text x="490" y="166" text-anchor="middle" font-size="11" fill="#64748b">→ loop: process_ubatch()  建图/复用 → 调度执行 → output_ids</text>
  <rect x="180" y="200" width="560" height="58" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="280" y="218" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_get_logits_ith(ctx, i)</text>
  <text x="490" y="234" text-anchor="middle" font-size="11" fill="#64748b">→ output_resolve_row(i)  batch idx → logits row</text>
  <text x="490" y="250" text-anchor="middle" font-size="11" fill="#64748b">→ return logits.data + row * n_vocab</text>
  <rect x="180" y="276" width="560" height="46" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="294" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_state_save_file / load_file</text>
  <text x="490" y="312" text-anchor="middle" font-size="11" fill="#64748b">→ state_write/read_data()  序列化 KV 状态</text>
  <line x1="160" y1="48" x2="180" y2="48" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-2)"/>
  <line x1="160" y1="139" x2="180" y2="139" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-2)"/>
  <line x1="160" y1="229" x2="180" y2="229" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-2)"/>
  <line x1="160" y1="299" x2="180" y2="299" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7-2)"/>
</svg>
<span class="figure-caption">图 R7.2 ｜ 关键调用路径汇总：上下文初始化、推理解码、logits 读取与状态序列化四条主干路径</span>

<details>
<summary>ASCII 原版</summary>

```
用户代码
    │
    ├─ llama_init_from_model(model, params)
    │       → llama_context 构造函数
    │         → sched_reserve() → 图预留 + 缓冲分配
    │
    ├─ llama_decode(ctx, batch)
    │       → decode()
    │         → balloc->init()          [补全 pos/seq_id/logits]
    │         → memory->init_batch()    [拆 ubatch + 找 KV 槽]
    │         → loop: process_ubatch()  [建图/复用 → 调度执行]
    │         → output_ids 设置
    │
    ├─ llama_get_logits_ith(ctx, i)
    │       → output_resolve_row(i)     [batch idx → logits row]
    │       → return logits.data + row * n_vocab
    │
    └─ llama_state_save_file / llama_state_load_file
            → state_write/read_data()   [序列化 KV 状态]
```

</details>

---

## 参考源文件

- `src/llama-context.h` / `src/llama-context.cpp` — 上下文定义与所有推理入口
- `src/llama-cparams.h` — 运行时参数结构
- `src/llama-batch.h` / `src/llama-batch.cpp` — `llama_ubatch` 与 `llama_batch_allocr`
- `include/llama.h:240` — `llama_batch` 公开 API
- `include/llama.h:911,922,936,952` — `llama_batch_get_one`, `llama_batch_init`, `llama_encode`, `llama_decode`
