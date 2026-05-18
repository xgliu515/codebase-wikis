# Trace 步骤 06 —— KV 缓存的张量是怎么被分配出来的?

## 1. 当前情境

步骤 05 里,`llama_context` 构造函数在阶段四调用了:

```cpp
memory.reset(model.create_memory(params_mem, cparams));
// src/llama-context.cpp:305
```

这一行之后,`memory` 成员持有一个 `llama_kv_cache *`。对于 Qwen2.5-0.5B 这类标准 causal attention 模型,`create_memory` 的路径是(`src/llama-model.cpp:2070`-`2083`):

```cpp
res = new llama_kv_cache(
    *this,
    params.type_k,   // GGML_TYPE_F16 默认
    params.type_v,
    !cparams.flash_attn,  // v_trans
    cparams.offload_kqv,
    cparams.kv_unified,
    cparams.n_ctx_seq,    // kv_size:每流能缓存的 token 数
    cparams.n_seq_max,
    1,                    // n_pad
    hparams.n_swa,
    hparams.swa_type,
    filter, nullptr);
```

`llama_kv_cache` 的构造函数(`src/llama-kv-cache.cpp:80`)执行完毕后,每一层的 K 张量和 V 张量都已经在后端 buffer 上分配好了。这一步要把这件事讲清楚。

## 2. 问题

transformer 的 attention 需要访问**之前所有位置**的 K 和 V 向量。如果不预先把它们存起来,每次生成新 token 就必须把整段历史重新过一遍所有层,计算量随序列长度线性增长——1000 个 token 的上下文,每生成一个新 token 就要做 1000 个 token 的前向计算,完全无法实用。

具体到内存:K/V 张量的形状是 `[n_embd_kv, n_ctx, n_layer]`,不是运行时才能知道的——`n_ctx` 在构造 context 时已经确定,`n_layer` 和 `n_embd_kv`(即 `n_head_kv × head_dim`)来自 `hparams`。问题是:**要在什么时候、按什么形状、往哪台设备上分配这块内存?**

## 3. 朴素思路

每次 decode 时动态扩容:从一个小缓冲开始,随着 KV 写入增加,不够了就 `realloc` 扩一倍,就像 C++ `std::vector` 那样。这样初始化快、小序列省内存。

## 4. 为什么朴素思路会崩

- **GPU 上没有 realloc**。GPU 的显存分配由驱动管理,底层是 `cudaMalloc`/`MTLBuffer` 之类的调用——它们没有扩容语义。扩容意味着重新分配一块更大的内存,然后把旧数据从 GPU 拷到新地址。这个拷贝本身需要在命令队列里提交一个拷贝任务并等待完成,代价极高。
- **张量地址一旦写进计算图就固定了**。`ggml_cgraph` 里每个节点记录的是指针——KV 张量被 `set_rows`/view 算子直接引用。扩容后地址变了,已经 reserve 好的计算图里所有引用全部失效,整个图必须重建。
- **大小在 init 时已知,没有理由延迟**。`n_ctx × n_layer × n_embd_kv × sizeof(type_k)` 是一个在构造 `llama_context` 时就完全确定的值。延迟分配只换来"init 快了一点"的假好处,真实代价是首次扩容时的一次 GPU 拷贝与图重建。
- **OOM 发现太晚**。显存不足应该在 `llama_init_from_model` 时就报错返回 `nullptr`,让调用方有机会降低 `n_ctx` 重试。动态扩容把 OOM 推迟到推理途中,调用方无法在合适的时机做错误处理。

## 5. llama.cpp 的做法

`llama_kv_cache` 构造函数在创建时一次性完成全部分配。分三个子步骤:

**子步骤 A:按缓冲类型建 ggml_context**。KV 张量可能分布在多台设备(例如层 0-17 在 GPU0,层 18-27 在 GPU1),每种 `ggml_backend_buffer_type_t` 独立对应一个 `ggml_context`(`src/llama-kv-cache.cpp:107`-`130`)。`ggml_context` 本身不占 GPU 显存,只是一块 CPU 端的元数据区,用于描述张量的形状、stride、名字。

**子步骤 B:按层创建 K/V 张量元数据**(`src/llama-kv-cache.cpp:162`-`227`)。对每一个有 KV 缓存的层(由 `hparams.has_kv(il)` 判断)计算:

```text
n_embd_k_gqa = n_head_kv(il) × head_dim_k(il)   (GQA 的 key 宽度)
n_embd_v_gqa = n_head_kv(il) × head_dim_v(il)   (GQA 的 value 宽度)

K 张量形状: [n_embd_k_gqa, kv_size, n_stream]    type_k
V 张量形状: [n_embd_v_gqa, kv_size, n_stream]    type_v
```

`kv_size` = `cparams.n_ctx_seq`(即步骤 05 里对齐到 256 后的 `n_ctx`,在 `kv_unified=true` 时就是整个 `n_ctx`)——这是**每流**最多缓存的 token 数。对于 Qwen2.5-0.5B(24 层,8 个 KV 头,head_dim=128,kv_size=n_ctx),每层的 K 张量形状是 `[1024, n_ctx, 1]`(f16)。张量只是通过 `ggml_new_tensor_3d` 在 `ggml_context` 里登记元数据,此时**还没有任何显存被分配**。

**子步骤 C:按缓冲类型一次性分配显存**(`src/llama-kv-cache.cpp:253`-`272`)。遍历 `ctx_map`,对每种 buft 调 `ggml_backend_alloc_ctx_tensors_from_buft(ctx, buft)`,这一个调用会:
1. 遍历 ctx 里所有张量,累加它们的对齐大小,得到总字节数;
2. 在对应设备上分配一个连续的 `ggml_backend_buffer`;
3. 将每个张量的 `data` 指针指向 buffer 内的对应偏移。

最后对 buffer 做一次 `ggml_backend_buffer_clear(buf, 0)` 初始化为零,防止 NaN 污染后续注意力计算。

构造完成后,`llama_kv_cache` 的内存布局如下:

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="llama_kv_cache memory layout: GPU tensor buffers and CPU cell metadata">
  <defs>
    <marker id="ar6a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="880" height="420" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="880" height="392" rx="8" fill="#fff" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="444" y="38" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">llama_kv_cache</text>
  <line x1="16" y1="48" x2="864" y2="48" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="32" y="68" font-size="12" font-weight="600" fill="#0d9488">GPU0_buf</text>
  <rect x="32" y="76" width="380" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="222" y="94" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">layers[0]  K [1024, n_ctx, 1]  @offset 0x000000</text>
  <text x="222" y="107" text-anchor="middle" font-size="10" fill="#64748b">il=0, type_k=F16, n_embd_k=1024</text>
  <rect x="32" y="120" width="380" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="222" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">layers[0]  V [1024, n_ctx, 1]  @offset 0x100000</text>
  <text x="222" y="151" text-anchor="middle" font-size="10" fill="#64748b">il=0, type_v=F16</text>
  <rect x="32" y="162" width="380" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="222" y="180" text-anchor="middle" font-size="11" fill="#64748b">layers[1]  K/V  @offset 0x200000 …</text>
  <text x="32" y="216" font-size="10" fill="#94a3b8">… 层 0 ~ N/2-1 全在 GPU0_buf …</text>
  <text x="452" y="68" font-size="12" font-weight="600" fill="#7c3aed">GPU1_buf</text>
  <rect x="452" y="76" width="380" height="36" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="642" y="94" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">layers[N-1]  K/V  (若 -ngl 让后几层在 GPU1)</text>
  <text x="642" y="107" text-anchor="middle" font-size="10" fill="#64748b">il=N-1, 独立后端 buffer</text>
  <text x="452" y="216" font-size="10" fill="#94a3b8">… 后几层 in GPU1_buf …</text>
  <line x1="16" y1="228" x2="864" y2="228" stroke="#cbd5e1" stroke-width="0.8" stroke-dasharray="4,2"/>
  <text x="32" y="250" font-size="12" font-weight="600" fill="#ea580c">CPU 端元数据(不占 GPU 显存)</text>
  <rect x="32" y="260" width="420" height="120" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="242" y="280" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">v_cells[0]  (llama_kv_cells)</text>
  <text x="242" y="298" text-anchor="middle" font-size="11" fill="#64748b">size = kv_size (= n_ctx_seq 对齐后)</text>
  <rect x="48" y="306" width="392" height="22" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="0.8"/>
  <text x="244" y="321" text-anchor="middle" font-size="10" fill="#64748b">pos[0..kv_size-1] = -1  (空槽)</text>
  <rect x="48" y="334" width="392" height="22" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="0.8"/>
  <text x="244" y="349" text-anchor="middle" font-size="10" fill="#64748b">seq[0..kv_size-1] = 0  ·  used = {} (初始空集)</text>
  <text x="48" y="374" font-size="10" fill="#94a3b8">decode 时先查 v_cells 找空槽 → 再 set_rows 写 GPU 张量对应行</text>
  <rect x="480" y="260" width="368" height="120" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="664" y="280" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">v_heads[0] = 0</text>
  <text x="664" y="298" text-anchor="middle" font-size="11" fill="#64748b">KV 槽位搜索起点游标</text>
  <text x="664" y="316" text-anchor="middle" font-size="10" fill="#94a3b8">init 时为 0 (全部空)</text>
  <text x="664" y="334" text-anchor="middle" font-size="10" fill="#64748b">每次 find_slot 从此处开始</text>
  <text x="664" y="356" text-anchor="middle" font-size="10" fill="#94a3b8">写入后 v_heads 向后移动</text>
  <text x="664" y="374" text-anchor="middle" font-size="10" fill="#94a3b8">seq_rm 释放后可复用</text>
</svg>
<span class="figure-caption">图 T6.1 ｜ llama_kv_cache 内存布局:GPU 侧 K/V 张量 buffer 与 CPU 侧 cell 元数据分离</span>

<details>
<summary>ASCII 原版</summary>

```
llama_kv_cache
├── layers[0]  il=0, k=[1024, n_ctx, 1] @ GPU0_buf offset 0x000000
│                  v=[1024, n_ctx, 1] @ GPU0_buf offset 0x100000
├── layers[1]  il=1, k=[1024, n_ctx, 1] @ GPU0_buf offset 0x200000
│                  ...
├── layers[N-1] il=N-1, k/v @ GPU1_buf (若 -ngl 让后几层在 GPU1)
│
├── v_cells[0]  llama_kv_cells  size=kv_size  (纯 CPU 元数据)
│   ├── pos[0..kv_size-1]  = -1   (空槽)
│   ├── seq[0..kv_size-1]  = 0    (无序列)
│   └── used = {}                 (空集合)
└── v_heads[0] = 0               (搜索起点)
```

</details>

`v_cells` 是纯 CPU 侧的元数据数组(`src/llama-kv-cells.h:32`)——它不是张量、不占 GPU 显存——专门记录每个 cell 槽位当前属于哪个序列、对应哪个 position。张量数据(权重级别的 K/V 向量)在 GPU buffer 里,元数据在 CPU 里;decode 时先查 `v_cells` 找到空槽,再用 `set_rows` 算子把新的 K/V 写进 GPU buffer 的对应行。

## 6. 代码位置

按阅读顺序:

- memory 创建入口:`src/llama-context.cpp:297`-`305` —— `model.create_memory(params_mem, cparams)`
- create_memory 路由:`src/llama-model.cpp:1923`-`2090` —— 按架构选择具体 memory 类型;Qwen2.5 走 `2070` 行的 `llama_kv_cache`
- KV cache 构造函数签名:`src/llama-kv-cache.h:96`-`109` —— 参数列表
- 构造函数主体:`src/llama-kv-cache.cpp:80`-`330` —— 全部三个子步骤
- buft -> ggml_context 映射:`src/llama-kv-cache.cpp:107`-`130` —— `ctx_for_buft` lambda
- 按层创建张量元数据:`src/llama-kv-cache.cpp:162`-`227` —— `ggml_new_tensor_3d` 调用,`210`-`211` 行是 K/V 的具体形状
- 按 buft 分配显存:`src/llama-kv-cache.cpp:253`-`272` —— `ggml_backend_alloc_ctx_tensors_from_buft`
- cell 元数据结构:`src/llama-kv-cells.h:32`-`533` —— `llama_kv_cells` 类;`64`-`70` 行是 `resize`,`395`-`403` 行是 `pos_set`
- KV cache 成员布局:`src/llama-kv-cache.h:211`-`270` —— `layers`/`v_cells`/`v_heads` 等私有成员
- memory 接口:`src/llama-memory.h:71`-`123` —— `llama_memory_i` 抽象,`init_full()` 在步骤 07 的 reserve 中被调用

## 7. 分支与延伸

- KV 缓存的完整生命周期——init 后如何在 decode 时写入 K/V、如何通过 `seq_rm`/`seq_cp` 管理会话、如何 shift 和 defrag -> [第 8 章 KV 缓存与内存子系统](08-kv-cache.md)
- `n_ctx_seq` 与 `kv_size` 的关系:当 `kv_unified=false`(默认)时,`kv_size = n_ctx / n_seq_max`,每个序列只能占用上下文的 1/n_seq_max;当 `kv_unified=true` 时,所有序列共享整个 `n_ctx` 长度 -> [第 8 章](08-kv-cache.md)、[第 7 章 上下文与批处理](07-context-and-batching.md)
- GQA(Grouped Query Attention)为什么让 KV 头数少于 Q 头数,以及 `n_embd_k_gqa`/`n_embd_v_gqa` 的计算方式 -> [第 3 章 模型架构与超参数](03-model-arch-and-hparams.md)
- `v_trans`(V 张量是否转置)与 Flash Attention 的关系:不用 FA 时 V 必须转置以加速 attention score 的矩阵乘 -> [第 8 章](08-kv-cache.md)
- `ggml_backend_alloc_ctx_tensors_from_buft` 在 `ggml-alloc.c` 里的实现——先测量再分配的两遍扫描 -> [第 4 章 GGML 张量与计算图](04-ggml-tensor-and-graph.md)
- `llama_kv_cache_iswa`(SWA 模式)和 `llama_memory_recurrent`(循环网络)作为 `llama_memory_i` 的其他实现 -> [第 8 章](08-kv-cache.md)

## 8. 走完这一步你脑子里应该多了什么

1. **KV 缓存在 context 构造时一次性预分配,不动态扩容**。原因是 GPU 无 realloc、张量指针在计算图里固定、OOM 应在 init 时暴露。
2. **K/V 张量的形状是 `[n_embd_kv, kv_size, n_stream]`**。`kv_size` 来自对齐后的 `n_ctx_seq`,`n_embd_kv` = `n_head_kv × head_dim`——对 GQA 模型远小于 Q 的维度。
3. **张量元数据(shape、dtype、指针)在 CPU 端的 ggml_context 里,张量数据在 GPU 的 backend_buffer 里**。这两者分开管理:CPU 负责描述,GPU 负责存储。
4. **`llama_kv_cells` 是纯 CPU 侧的 slot 元数据**,记录每个缓存槽位的 position 和 sequence 归属。每次 decode 时先查 `v_cells` 找空槽,再用 GGML set_rows 算子把 K/V 写进 GPU 张量对应的行。
5. **`llama_kv_cache` 实现了 `llama_memory_i` 接口**。从 decode 循环的视角看,memory 是透明的——`init_batch`/`init_full` 负责准备 slot 信息,`apply` 负责把 slot 写进 cells;KV 缓存的实现细节对上层 decode 循环不可见。

下一步:[步骤 07 —— 预留计算图与调度器](tour-07-graph-reserve.md)。
