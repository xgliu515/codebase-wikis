# Trace 步骤 05 —— ds4_engine_open 返回之前，到底准备了什么？

## 1. 当前情境

步骤 02–04 依次完成了：GGUF 文件 mmap 进地址空间（`ds4_cli.c:1357` 调用 `ds4_engine_open`
之前）、43 层张量绑定到固定布局、词表与 merge ranks 就绪。此刻执行流停在
`ds4.c:17164` 的 `ds4_engine_open` 函数体内，已经做完
`model_open / vocab_load / config_validate_model / weights_bind`（`ds4.c:17190–17194`），
尚未初始化 GPU 后端与图状态。

引擎结构体此时的样子（`ds4.c:14372`）：

<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine struct layout showing five fields">
  <defs>
    <marker id="ar5-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="20" width="520" height="180" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">struct ds4_engine</text>
  <rect x="80" y="36" width="160" height="32" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="57" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">ds4_model  model</text>
  <text x="260" y="57" text-anchor="start" font-size="11" fill="#64748b">← mmap 句柄、张量目录</text>
  <rect x="80" y="80" width="160" height="32" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="160" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">ds4_vocab  vocab</text>
  <text x="260" y="101" text-anchor="start" font-size="11" fill="#64748b">← token 字符串、merge ranks、special token id</text>
  <rect x="80" y="124" width="160" height="32" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="160" y="145" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">ds4_weights  weights</text>
  <text x="260" y="145" text-anchor="start" font-size="11" fill="#64748b">← 43 层张量指针（引用 mmap，未拷贝）</text>
  <rect x="80" y="168" width="105" height="24" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="132" y="184" text-anchor="middle" font-size="11" fill="#64748b">ds4_backend  backend</text>
  <text x="200" y="184" text-anchor="start" font-size="11" fill="#64748b">← DS4_BACKEND_METAL</text>
  <rect x="380" y="168" width="100" height="24" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="430" y="184" text-anchor="middle" font-size="11" fill="#dc2626">metal_ready</text>
  <text x="488" y="184" text-anchor="start" font-size="11" fill="#94a3b8">← false (尚未)</text>
</svg>
<span class="figure-caption">图 T5.1 ｜ ds4_engine 结构体字段布局（GPU 初始化完成前的快照）</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_engine {
    ds4_model   model       <- mmap 句柄、张量目录
    ds4_vocab   vocab       <- token 字符串、merge ranks、special token id
    ds4_weights weights     <- 43 层张量指针（引用 mmap，未拷贝）
    ds4_backend backend     <- DS4_BACKEND_METAL
    bool        metal_ready <- false  (尚未)
}
```

</details>

## 2. 问题

`ds4_engine_open` 在返回之前，还需要完成两件事：

1. **初始化 GPU 后端**：在 Metal 上，这意味着调用驱动初始化、把 mmap 范围注册给 GPU，
   并将权重预热到 GPU 可寻址的视图中——否则推理内核无法访问权重。
2. **分配整模型图状态（Metal graph state）**：每一层的 KV 缓存缓冲、中间激活张量、
   HC（超连接）状态等，都需要在引擎层面一次性分配好。如果等到每条请求再分配，
   多请求并发时会产生竞争，且分配失败的时机难以预测。

如果这两步没做，`ds4_engine` 返回后第一个 `ds4_session_create` 调用就会找不到
已初始化的 GPU 设备，直接返回失败。

## 3. 朴素思路

把权重加载和 GPU 初始化分开：先返回一个"轻量 engine"，等第一条请求到来时懒加载 GPU
资源。这样启动快，不需要为从不使用的 GPU 提前分配内存。

## 4. 为什么朴素思路会崩

懒加载在单进程、单请求场景下勉强可行，但在推理服务里有两个硬问题：

- **分配失败时机不确定**：`ds4-server` 可能同时收到多条请求。第一条请求触发懒加载时
  可能因显存不足失败，此时已经读完 prompt、建好会话，所有前置工作都要回滚，错误路径极难测试。
  `ds4_engine_open` 集中分配并明确返回错误码，失败就是失败，不进入后续流程。
- **weight 视图的一次性性**：Metal 的 `ds4_gpu_set_model_map_range`（`ds4.c:17237`）
  把 mmap 区间注册为 GPU 可读的 shared buffer。这个操作在驱动层是全局状态——如果
  多条请求都试图注册同一个 mmap 范围，驱动会报重复映射错误。集中在 `ds4_engine_open`
  里做一次是唯一安全的选择。
- **图状态是整模型的**：Metal graph state 包含 43 层的 KV 缓存缓冲（`raw_cap × head_dim × f32`
  共 43 组）、HC 张量（4 路 × 4096 f32）等。这些大块内存与模型结构一一对应，
  必须在知道完整权重布局之后才能算出尺寸并分配。懒加载意味着把 `weights_bind` 的结果
  缓存到分配时刻，徒增复杂度。

## 5. DwarfStar 4 的做法

`ds4_engine_open` 把初始化拆成严格顺序的几步，任何一步失败都立即释放并返回非零：

<svg viewBox="0 0 640 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ds4_engine_open sequential initialization steps">
  <defs>
    <marker id="ar5-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="20" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="45" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">model_open</text>
  <text x="470" y="45" text-anchor="start" font-size="11" fill="#64748b">mmap GGUF，解析张量目录</text>
  <line x1="310" y1="60" x2="310" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="78" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="103" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">vocab_load</text>
  <text x="470" y="103" text-anchor="start" font-size="11" fill="#64748b">读 token/merge ranks 元数据</text>
  <line x1="310" y1="118" x2="310" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="136" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="161" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">config_validate</text>
  <text x="470" y="161" text-anchor="start" font-size="11" fill="#64748b">校验超参与 DS4 固定形状（43 层等）</text>
  <line x1="310" y1="176" x2="310" y2="194" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="194" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="219" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">weights_bind</text>
  <text x="470" y="219" text-anchor="start" font-size="11" fill="#64748b">绑定 43 层张量指针（引用 mmap）</text>
  <text x="470" y="233" text-anchor="start" font-size="10" fill="#94a3b8">（MTP 路径可选）</text>
  <line x1="310" y1="234" x2="310" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="252" width="300" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="277" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">ds4_gpu_init</text>
  <text x="470" y="277" text-anchor="start" font-size="11" fill="#64748b">初始化 Metal/CUDA 驱动</text>
  <line x1="310" y1="292" x2="310" y2="310" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="310" width="300" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="335" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">gpu_set_map_range</text>
  <text x="470" y="335" text-anchor="start" font-size="11" fill="#64748b">把 mmap 范围注册为 GPU 共享缓冲</text>
  <line x1="310" y1="350" x2="310" y2="368" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="160" y="368" width="300" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="393" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">cache_model_tensors</text>
  <text x="470" y="393" text-anchor="start" font-size="11" fill="#64748b">量化权重预热到 GPU 可访问视图</text>
  <line x1="310" y1="408" x2="310" y2="426" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-2)"/>
  <rect x="200" y="426" width="220" height="26" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="310" y="444" text-anchor="middle" font-size="12" font-weight="600" fill="#16a34a">metal_ready = true  → engine 返回</text>
</svg>
<span class="figure-caption">图 T5.2 ｜ ds4_engine_open 严格串行的八步初始化序列，任一步失败即早退</span>

<details>
<summary>ASCII 原版</summary>

```
model_open        <- mmap GGUF，解析张量目录
vocab_load        <- 读 token/merge ranks 元数据
config_validate   <- 校验超参与 DS4 固定形状（43 层等）
weights_bind      <- 绑定 43 层张量指针（引用 mmap）
    (MTP 路径可选)
ds4_gpu_init      <- 初始化 Metal/CUDA 驱动
gpu_set_map_range <- 把 mmap 范围注册为 GPU 共享缓冲
cache_model_tensors <- 把量化权重预热到 GPU 可访问视图
    -> metal_ready = true
(engine 返回给调用者)
```

</details>

注意：**图状态（`ds4_gpu_graph`）不在 engine 里**，而在 `ds4_session` 里。
`ds4_engine_open` 只做模型级别的一次性初始化；per-request 的 KV 缓存与中间张量
由 `ds4_session_create`（步骤 07）在 `metal_graph_alloc_raw_cap` 里按 `ctx_size`
和 `raw_cap` 分配。

`metal_graph_alloc_raw_cap`（`ds4.c:8689`）的分配策略值得单独看一下：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="metal_graph_alloc_raw_cap memory layout showing inputs and allocated buffers">
  <defs>
    <marker id="ar5-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="20" width="680" height="50" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="39" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">输入参数</text>
  <text x="130" y="58" text-anchor="middle" font-size="11" fill="#64748b">raw_cap（SWA 缓存行数）</text>
  <text x="380" y="58" text-anchor="middle" font-size="11" fill="#64748b">ctx_size（逻辑窗口）</text>
  <text x="620" y="58" text-anchor="middle" font-size="11" fill="#64748b">prefill_cap（ubatch 上限）</text>
  <line x1="380" y1="70" x2="380" y2="90" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-3)"/>
  <text x="380" y="86" text-anchor="middle" font-size="10" fill="#94a3b8">metal_graph_alloc_raw_cap</text>
  <rect x="40" y="100" width="320" height="44" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="200" y="118" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">每层 raw SWA 缓冲（×43 层）</text>
  <text x="200" y="136" text-anchor="middle" font-size="10" fill="#64748b">raw_cap × DS4_N_HEAD_DIM × sizeof(float)</text>
  <rect x="400" y="100" width="320" height="44" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="560" y="118" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">压缩缓冲（ratio≠0 层）</text>
  <text x="560" y="136" text-anchor="middle" font-size="10" fill="#64748b">comp_cap × DS4_N_HEAD_DIM × sizeof(float)</text>
  <rect x="40" y="158" width="320" height="44" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="200" y="176" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">indexer 缓冲（ratio==4 层）</text>
  <text x="200" y="194" text-anchor="middle" font-size="10" fill="#64748b">comp_cap × DS4_N_INDEXER_HEAD_DIM × sizeof(float)</text>
  <rect x="400" y="158" width="320" height="44" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="560" y="176" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">HC 状态（4 项）</text>
  <text x="560" y="194" text-anchor="middle" font-size="10" fill="#64748b">cur_hc / flat_hc / hc_mix / hc_split  4096×4 f32 each</text>
  <rect x="40" y="216" width="320" height="44" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="200" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">注意力中间缓冲</text>
  <text x="200" y="252" text-anchor="middle" font-size="10" fill="#64748b">qr / q / kv / heads / attn_low / attn_out</text>
  <rect x="400" y="216" width="320" height="44" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="560" y="234" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">FFN 中间缓冲</text>
  <text x="560" y="252" text-anchor="middle" font-size="10" fill="#64748b">ffn_cur / router_* / routed_* / shared_*</text>
  <rect x="160" y="280" width="440" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="298" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">输出：logits</text>
  <text x="380" y="316" text-anchor="middle" font-size="10" fill="#64748b">DS4_N_VOCAB = 129 280 × f32</text>
  <line x1="200" y1="260" x2="200" y2="278" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="560" y1="260" x2="560" y2="278" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="200" y1="278" x2="380" y2="278" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="560" y1="278" x2="380" y2="278" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="278" x2="380" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5-3)"/>
  <text x="380" y="362" text-anchor="middle" font-size="10" fill="#94a3b8">ds4_session_create 调用；非 ds4_engine_open</text>
</svg>
<span class="figure-caption">图 T5.3 ｜ metal_graph_alloc_raw_cap 分配的各类缓冲区（KV 缓存、HC 状态、激活张量、logits）</span>

<details>
<summary>ASCII 原版</summary>

```
输入：raw_cap（SWA 缓存行数）、ctx_size（逻辑窗口）、prefill_cap（ubatch 上限）
           |
           v
  每层 raw SWA 缓冲：raw_cap × DS4_N_HEAD_DIM × sizeof(float)
  ratio!=0 层的压缩缓冲：comp_cap × DS4_N_HEAD_DIM × sizeof(float)
  ratio==4 层的 indexer 缓冲：comp_cap × DS4_N_INDEXER_HEAD_DIM × sizeof(float)
  HC 状态：cur_hc / flat_hc / hc_mix / hc_split（4096×4 f32 每项）
  注意力中间：qr / q / kv / heads / attn_low / attn_out
  FFN 中间：ffn_cur / router_* / routed_* / shared_*
  输出：logits（DS4_N_VOCAB = 129280 × f32）
```

</details>

`raw_cap` 的计算来自 `metal_graph_raw_cap_for_context`（`ds4.c:13946`）：它把
`raw_window（DS4_N_SWA = 128）+ prefill_cap` 向上对齐到 256 行倍数，最大 8192 行。

```text
ctx_size=32768, prefill_cap≈32768  ->  raw_cap = align_up(128+32768, 256) clamped to 8192
```

这意味着即使上下文窗口是 32 K，SWA 的 raw 缓存只需要容纳最近的滑动窗口，
内存大幅低于"全上下文"方案。

"engine = 不可变的已加载模型"这个设计思想体现在 `ds4_engine` 结构体里：
它只有 `ds4_model`（mmap 句柄）、`ds4_vocab`（词表）、`ds4_weights`（张量指针）
和 `metal_ready` 标志，**没有任何可变的会话状态**。多个并发会话可以安全地
持有同一个 `ds4_engine` 指针，因为 engine 从 `ds4_engine_open` 返回后就只读。

## 6. 代码位置

按阅读顺序：

- `ds4_cli.c:1357` —— `main()` 调用 `ds4_engine_open(&engine, &cfg.engine)`，
  失败直接 `return 1`。
- `ds4.h:62–74` —— `ds4_engine_options` 结构体，含 `model_path / backend / warm_weights / quality` 等字段。
- `ds4.h:95` —— `ds4_engine_open` 公开声明。
- `ds4.c:14372` —— `struct ds4_engine` 定义，展示"engine 只持有不可变模型状态"。
- `ds4.c:17164` —— `ds4_engine_open` 实现入口；`17190–17194` 是加载序列。
- `ds4.c:17227` —— `ds4_gpu_init()` 调用；`17237` 是 `ds4_gpu_set_model_map_range`；
  `17264` 是 `accelerator_cache_model_tensors`（权重预热）。
- `ds4.c:8687` —— `metal_graph_alloc_raw_cap`：整模型图状态分配（注：此函数在
  `ds4_session_create` 而非 `ds4_engine_open` 里调用，但理解它是理解内存布局的关键）。
- `ds4.c:13946` —— `metal_graph_raw_cap_for_context`：raw_cap 计算逻辑。
- `ds4.c:9005` —— `metal_graph_alloc`（测试用途的最小分配，`raw_cap=DS4_N_SWA=128`）。

## 7. 分支与延伸

- engine 不可变、session 可变的分工如何支撑 HTTP 服务器里的多并发请求 →
  [第 6 章 引擎与会话](06-engine-session.md)
- Metal 后端的 `ds4_gpu_init` / `ds4_gpu_set_model_map_range` 内部机制，以及
  CUDA 路径的差异 →
  [第 10 章 Metal 与 CUDA 后端](10-metal-backend.md)
- `weights_bind` 如何把 43 层张量指针绑定到 GGUF mmap 区间，以及量化类型校验 →
  [第 3 章 GGUF 加载与张量绑定](03-gguf-loading.md)
- `raw_cap / comp_cap / prefill_cap` 三个容量参数如何换算成 KV 缓存内存，
  以及 `ds4_context_memory` 估算 API →
  [第 6 章 §内存估算](06-engine-session.md)
- MTP（推测解码）路径下 `mtp_model` 与主模型并行加载的细节 →
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)

## 8. 走完这一步你脑子里应该多了什么

1. `ds4_engine_open` 是一次性的"完整加载"：mmap、词表、校验、权重绑定、GPU 初始化、
   mmap 注册、权重预热——全部串行完成，任何一步失败都早退，**不存在半初始化状态**。
2. `ds4_engine` 结构体本身不含 KV 缓存或中间激活张量；**图状态属于 session，不属于 engine**。
   engine 从返回起就只读，可被多个并发 session 共享。
3. raw SWA 缓冲的大小由 `DS4_N_SWA=128`（滑动窗口）加 `prefill_cap` 决定，并对齐到
   256 行倍数且上限 8192——远小于 ctx_size，这是 SWA 设计节省显存的直接体现。
4. Metal 权重**不拷贝**：`ds4_gpu_set_model_map_range` 把 mmap 区间直接注册为 GPU
   共享缓冲，推理时内核直接读 mmap 页，避免了额外的显存复制。
5. `accelerator_cache_model_tensors` 做的是"预热"而非复制——它触发页面访问，让 OS
   把模型文件的冷页加载进物理内存，避免推理第一步时的大量缺页中断。
