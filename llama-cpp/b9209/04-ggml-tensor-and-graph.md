# 第 4 章 GGML 张量库与计算图

ggml 是 llama.cpp 内嵌的纯 C 张量库，也是整个推理引擎的数值计算基础。它的设计出发点是：在资源受限的设备上以最小代码量提供高性能张量运算，为此坚守三条原则——**无外部依赖**（只依赖标准 C 库）、**静态算子集**（编译期确定所有 op，无运行时注册）、**计算图先建后执**（所有算子只记录意图，不立即执行）。理解 ggml 是读懂 llama.cpp 推理管线的必要前提，本章聚焦于张量表示、上下文内存模型、算子建图、计算图结构、内存复用分配器以及量化类型与后端入口等核心主题。

---

## 1. ggml 的设计目标与约束

ggml 最初为在 Apple Silicon CPU 上快速运行 Whisper 而设计，目标是单头文件可裁剪、无动态链接依赖，因此做出了以下有意识的限制：

- **张量最多 4 维**（`GGML_MAX_DIMS = 4`，`ggml/include/ggml.h:222`），足以表达所有 LLM 中的权重与激活张量
- **算子类型枚举固定**（`ggml_op`，约 80+ 个），不存在插件化 op 机制，后端实现针对已知 op 列表优化
- **两阶段执行模型**：第一阶段调用 `ggml_add`/`ggml_mul_mat` 等 API 建立计算图（纯指针操作，无浮点运算），第二阶段调用 `ggml_backend_graph_compute` 执行
- **内存由调用方管理**：`ggml_init` 接受外部缓冲区，张量元数据和数据分开分配（no_alloc 模式）

这种设计使得 ggml 既能在嵌入式设备上以线性内存池管理所有对象，也能在 CUDA/Metal 等后端上按需分配设备内存，同一套图构建代码对所有后端通用。

---

## 2. struct ggml_tensor：张量的内存表示

`ggml_tensor`（`ggml/include/ggml.h:666`）是 ggml 中的核心数据结构：

```c
// ggml/include/ggml.h:666
struct ggml_tensor {
    enum ggml_type type;          // 数据类型（F32/F16/BF16/Q4_K/...）
    struct ggml_backend_buffer * buffer; // 后端缓冲区句柄

    int64_t ne[GGML_MAX_DIMS];   // 各维度元素数 [ne0, ne1, ne2, ne3]
    size_t  nb[GGML_MAX_DIMS];   // 各维度步长（字节）

    enum ggml_op op;              // 产生此张量的算子
    int32_t op_params[GGML_MAX_OP_PARAMS / sizeof(int32_t)]; // 算子参数
    int32_t flags;                // GGML_TENSOR_FLAG_INPUT/OUTPUT/PARAM/...

    struct ggml_tensor * src[GGML_MAX_SRC]; // 最多 10 个输入张量

    struct ggml_tensor * view_src; // 若是视图，指向源张量
    size_t               view_offs;

    void * data;                  // 实际数据指针（可为 NULL，no_alloc 模式）
    char name[GGML_MAX_NAME];     // 调试用名称（最长 64 字节）
    void * extra;                 // 后端私有扩展（如 CUDA kernel 参数）
    char padding[8];
};
```

### 2.1 ne[4] 与 nb[4]：形状与步长

ggml 采用**行主序**（row-major）存储，`ne[0]` 是最内层维度（列数），`ne[3]` 是最外层维度。`nb[i]` 是沿第 i 维移动一步所需的字节数：

```text
默认连续布局（contiguous）：
  nb[0] = sizeof(element_type)   // 相邻元素字节距离
  nb[1] = nb[0] * ne[0]          // 行字节跨度
  nb[2] = nb[1] * ne[1]          // slice 字节跨度
  nb[3] = nb[2] * ne[2]          // batch 字节跨度
```

注释中的完整定义（`ggml/include/ggml.h:672`）：

```c
// nb[0] = ggml_type_size(type)
// nb[1] = nb[0] * (ne[0] / ggml_blck_size(type)) + padding
// nb[i] = nb[i-1] * ne[i-1]
```

对于量化类型，`nb[0]` 等于一个 block 的字节数（而非单个元素），`ne[0] / ggml_blck_size(type)` 是该行含有的 block 数。

### 2.2 内存布局示意图

以一个 2×3 的 F32 矩阵为例（ne = [2, 3, 1, 1]）：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="F32 2x3 matrix memory layout showing row-major order with nb stride annotations">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="320" fill="#f8fafc" rx="8"/>
  <text x="380" y="30" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">F32 矩阵内存布局（ne=[2,3,1,1]，行主序）</text>
  <text x="60" y="62" font-size="11" fill="#64748b">内存地址增长方向</text>
  <line x1="190" y1="57" x2="700" y2="57" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="60" y="76" width="100" height="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="3"/>
  <text x="110" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">[0,0]</text>
  <text x="110" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <text x="110" y="131" text-anchor="middle" font-size="10" fill="#94a3b8">nb[0]=4</text>
  <rect x="160" y="76" width="100" height="60" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="3"/>
  <text x="210" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">[1,0]</text>
  <text x="210" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <rect x="280" y="76" width="100" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="3"/>
  <text x="330" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">[0,1]</text>
  <text x="330" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <rect x="380" y="76" width="100" height="60" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="3"/>
  <text x="430" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">[1,1]</text>
  <text x="430" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <rect x="500" y="76" width="100" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="3"/>
  <text x="550" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">[0,2]</text>
  <text x="550" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <rect x="600" y="76" width="100" height="60" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="3"/>
  <text x="650" y="101" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">[1,2]</text>
  <text x="650" y="118" text-anchor="middle" font-size="10" fill="#64748b">4 bytes</text>
  <line x1="60" y1="158" x2="260" y2="158" stroke="#ea580c" stroke-width="1.5"/>
  <line x1="60" y1="158" x2="60" y2="150" stroke="#ea580c" stroke-width="1.5"/>
  <line x1="260" y1="158" x2="260" y2="150" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="174" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">行 0</text>
  <text x="160" y="187" text-anchor="middle" font-size="10" fill="#64748b">nb[1] = 8 bytes</text>
  <line x1="280" y1="158" x2="480" y2="158" stroke="#0d9488" stroke-width="1.5"/>
  <line x1="280" y1="158" x2="280" y2="150" stroke="#0d9488" stroke-width="1.5"/>
  <line x1="480" y1="158" x2="480" y2="150" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="174" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">行 1</text>
  <text x="380" y="187" text-anchor="middle" font-size="10" fill="#64748b">nb[1] = 8 bytes</text>
  <line x1="500" y1="158" x2="700" y2="158" stroke="#7c3aed" stroke-width="1.5"/>
  <line x1="500" y1="158" x2="500" y2="150" stroke="#7c3aed" stroke-width="1.5"/>
  <line x1="700" y1="158" x2="700" y2="150" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="600" y="174" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">行 2</text>
  <text x="600" y="187" text-anchor="middle" font-size="10" fill="#64748b">nb[1] = 8 bytes</text>
  <rect x="60" y="210" width="640" height="40" fill="#f1f5f9" rx="4" stroke="#cbd5e1"/>
  <text x="380" y="226" text-anchor="middle" font-size="12" fill="#64748b">nb[0] = sizeof(F32) = 4    nb[1] = nb[0] × ne[0] = 8    nb[2] = nb[1] × ne[1] = 24</text>
  <text x="380" y="242" text-anchor="middle" font-size="11" fill="#94a3b8">nb[3] = nb[2] × ne[2] = 24</text>
  <rect x="60" y="265" width="640" height="36" fill="#fff7ed" rx="4" stroke="#ea580c" stroke-width="1"/>
  <text x="380" y="280" text-anchor="middle" font-size="12" fill="#ea580c" font-weight="600">访问元素 [i0, i1]</text>
  <text x="380" y="295" text-anchor="middle" font-size="11" fill="#64748b">ptr = (char*)data + i1 × nb[1] + i0 × nb[0]</text>
</svg>
<span class="figure-caption">图 R4.1 ｜ 2×3 F32 矩阵的行主序内存布局及 nb 步长语义</span>

<details>
<summary>ASCII 原版</summary>

```
内存地址增长方向 ─────────────────────────────────────>
┌────────┬────────┬────────┬────────┬────────┬────────┐
│ [0,0]  │ [1,0]  │ [0,1]  │ [1,1]  │ [0,2]  │ [1,2]  │
│ 4 bytes│ 4 bytes│ 4 bytes│ 4 bytes│ 4 bytes│ 4 bytes│
└────────┴────────┴────────┴────────┴────────┴────────┘
 \────────────────/  \────────────────/  \────────────────/
        行 0                  行 1                  行 2
  nb[1]=8 bytes         nb[1]=8 bytes         nb[1]=8 bytes

访问元素 [i0, i1]:  ptr = (char*)data + i1*nb[1] + i0*nb[0]
```

</details>

非连续张量（`ggml_permute`/`ggml_transpose` 之后）仅修改 `nb` 数组，不移动数据，所有算子实现都必须通过 `nb` 计算实际偏移，不得假设张量连续（`ggml_is_contiguous()` 用于检查）。

### 2.3 视图张量

当 `view_src != nullptr` 时，该张量是一个视图——`data` 指向 `view_src->data + view_offs`，不占用额外内存。`ggml_view_tensor`/`ggml_reshape`/`ggml_permute` 等都会产生视图。内存分配器（gallocr）遇到视图张量时跳过分配，因为数据已由源张量持有。

---

## 3. ggml_context 与内存池

`ggml_context` 是所有张量元数据对象的分配池。通过 `ggml_init` 创建：

```c
// ggml/include/ggml.h:658
struct ggml_init_params {
    size_t mem_size;   // 内存池大小（字节）
    void * mem_buffer; // 外部缓冲区；为 NULL 时库内部 malloc
    bool   no_alloc;   // true → 只分配张量元数据，不分配 data 区域
};

struct ggml_context * ctx = ggml_init(params);
```

### 3.1 no_alloc 模式的必要性

llama.cpp 在加载权重和构建计算图时均使用 `no_alloc = true` 的 context：

- **权重加载侧**：先建立形状/类型正确的"空张量"（仅元数据），随后由 `ggml_backend_alloc_ctx_tensors_from_buft()` 在特定后端缓冲区（CPU/CUDA/Metal）上批量分配数据，再用 mmap 或 read 填充权重
- **计算图构建侧**：在 `no_alloc` context 中建立计算图（纯指针 DAG），图构建完成后由 `gallocr` 统一为中间激活分配内存

这一两阶段分配的好处是：**图构建代码不需要知道张量将被分配在哪个设备的内存上**，完全由后续的 allocator 决定。

### 3.2 context 的生命期与 ggml_reset

context 内分配的所有对象（张量元数据、图对象）的生命期与 context 相同。`ggml_reset(ctx)` 重置内部偏移计数器但保留缓冲区，常用于批次间复用 context 而不重新 malloc。`ggml_free(ctx)` 释放所有资源。

---

## 4. 算子如何建图：以 ggml_mul_mat 为例

ggml 的所有算子 API 遵循相同范式：**接受输入张量，返回一个新的输出张量，仅记录 op 类型和 src 指针，不执行运算**。

以矩阵乘法为例（`ggml/include/ggml.h:1417`）：

```c
// A: n 列, m 行 (内部自动转置) → [x, y, m, n]
// B: k 列, m 行              → [x, y, m, k]
// 结果: n 列, k 行            → [x, y, k, n] (即 B @ A^T)
struct ggml_tensor * ggml_mul_mat(
    struct ggml_context * ctx,
    struct ggml_tensor  * a,   // 权重矩阵
    struct ggml_tensor  * b);  // 激活矩阵
```

调用后，返回的新张量具有：

```text
result->op     = GGML_OP_MUL_MAT
result->src[0] = a
result->src[1] = b
result->data   = NULL  (no_alloc context)
```

其他重要算子：

```c
// RoPE 旋转位置编码（ggml/include/ggml.h:1772）
struct ggml_tensor * ggml_rope(ctx, a, b, n_dims, mode);
// → op=GGML_OP_ROPE, src[0]=a(输入), src[1]=b(位置索引)

// Softmax（ggml/include/ggml.h:1716）
struct ggml_tensor * ggml_soft_max(ctx, a);
// → op=GGML_OP_SOFT_MAX, src[0]=a

// 逐元素加法（ggml/include/ggml.h:888）
struct ggml_tensor * ggml_add(ctx, a, b);
// → op=GGML_OP_ADD, src[0]=a, src[1]=b
```

### 4.1 可原位执行的算子

`ggml_op_can_inplace(op)`（`ggml/src/ggml-alloc.c:22`）标识哪些算子可以复用输入缓冲区：

```c
case GGML_OP_ADD: case GGML_OP_MUL: case GGML_OP_ROPE:
case GGML_OP_RMS_NORM: case GGML_OP_SOFT_MAX: ... return true;
```

`ggml_add_inplace`/`ggml_rope_inplace` 等变体会在输出张量的 `view_src` 上复用内存，内存分配器据此决定是否合并分配。

### 4.2 op_params 的作用

`op_params` 数组存储算子的超参数（如 RoPE 的频率基数、维度数、缩放因子等）。由于是固定大小数组（`GGML_MAX_OP_PARAMS = 64` 字节），避免了额外的堆分配，同时使张量节点完全自包含（图序列化时无外部依赖）。

---

## 5. struct ggml_cgraph：计算图

`ggml_cgraph`（`ggml/src/ggml-impl.h:329`）是一个有向无环图（DAG）的线性化表示：

```c
struct ggml_cgraph {
    int size;    // 节点数组最大容量
    int n_nodes; // 当前节点数（op != NONE 的张量）
    int n_leafs; // 当前叶节点数（op == NONE 的张量，权重/输入）

    struct ggml_tensor ** nodes;   // 有序节点数组（拓扑序）
    struct ggml_tensor ** leafs;   // 叶节点数组（权重、位置索引等）
    struct ggml_tensor ** grads;   // 梯度张量（推理时为 NULL）
    struct ggml_tensor ** grad_accs;

    struct ggml_hash_set visited_hash_set;
    enum ggml_cgraph_eval_order order;  // 执行顺序（LEFT_TO_RIGHT 等）
    uint64_t uid;  // 图唯一 ID，用于识别相同拓扑结构
};
```

### 5.1 节点与叶节点的区别

| 类别 | 条件 | 示例 |
|------|------|------|
| 叶节点（leaf） | `op == GGML_OP_NONE` | 权重张量（wq/wk/wv）、输入 token id 张量 |
| 节点（node） | `op != GGML_OP_NONE` | `ggml_mul_mat`/`ggml_rope`/`ggml_add` 的结果 |

叶节点不需要计算，其 `data` 已经由权重加载或外部赋值填充；节点的 `data` 在执行前由 gallocr 分配。

### 5.2 ggml_build_forward_expand：拓扑展开

`ggml_build_forward_expand(cgraph, tensor)`（`ggml/include/ggml.h:2702`）从输出张量出发，做**深度优先遍历**，将所有可达的节点和叶节点以拓扑序插入 `cgraph->nodes` 和 `cgraph->leafs`：

<svg viewBox="0 0 640 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DFS traversal tree showing ggml_build_forward_expand topology order">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="480" fill="#f8fafc" rx="8"/>
  <text x="320" y="28" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">ggml_build_forward_expand 深度优先遍历</text>
  <rect x="220" y="44" width="200" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="320" y="60" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">logits_tensor</text>
  <text x="320" y="76" text-anchor="middle" font-size="10" fill="#64748b">DFS 起点（输出节点）</text>
  <line x1="320" y1="84" x2="320" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <rect x="180" y="116" width="200" height="40" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="280" y="132" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">lm_head_mm</text>
  <text x="280" y="148" text-anchor="middle" font-size="10" fill="#94a3b8">→ nodes[n-1]</text>
  <line x1="255" y1="156" x2="210" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <line x1="305" y1="156" x2="430" y2="188" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)" stroke-dasharray="3,2"/>
  <rect x="110" y="188" width="200" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
  <text x="210" y="204" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">output_norm</text>
  <text x="210" y="220" text-anchor="middle" font-size="10" fill="#94a3b8">→ nodes[n-2]</text>
  <rect x="380" y="188" width="160" height="40" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
  <text x="460" y="204" text-anchor="middle" font-size="12" font-weight="600" fill="#16a34a">output_weight</text>
  <text x="460" y="220" text-anchor="middle" font-size="10" fill="#94a3b8">→ leafs[k]</text>
  <line x1="185" y1="228" x2="185" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <rect x="85" y="260" width="200" height="40" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="6"/>
  <text x="185" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">rms_norm</text>
  <text x="185" y="292" text-anchor="middle" font-size="10" fill="#94a3b8">→ nodes[n-3]</text>
  <line x1="185" y1="300" x2="185" y2="332" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <text x="185" y="350" text-anchor="middle" font-size="11" fill="#94a3b8">... 更深的节点 ...</text>
  <text x="185" y="370" text-anchor="middle" font-size="10" fill="#94a3b8">（各层 ffn / attn 节点）</text>
  <rect x="80" y="390" width="480" height="68" fill="#f1f5f9" rx="6" stroke="#cbd5e1"/>
  <text x="320" y="410" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">最终结果：</text>
  <text x="320" y="428" text-anchor="middle" font-size="11" fill="#64748b">nodes[0..n_nodes-1] — 按拓扑序（叶到根）排列，执行时从 nodes[0] 顺序推进</text>
  <text x="320" y="446" text-anchor="middle" font-size="11" fill="#64748b">leafs[0..n_leafs-1] — op=NONE 的权重/输入张量（data 已填充，无需计算）</text>
  <text x="460" y="236" text-anchor="middle" font-size="10" fill="#16a34a">op=NONE，data 已填充</text>
</svg>
<span class="figure-caption">图 R4.2 ｜ ggml_build_forward_expand 的 DFS 遍历与拓扑排序结果</span>

<details>
<summary>ASCII 原版</summary>

```
ggml_build_forward_expand(gf, logits_tensor)
  DFS(logits_tensor)
    DFS(lm_head_mm)      → nodes[n-1]
      DFS(output_norm)   → nodes[n-2]
        DFS(rms_norm)    → nodes[n-3]
          ...
      DFS(output_weight) → leafs[k]  (已有 data，直接加入 leafs)
    ...
```

</details>

`visited_hash_set` 防止同一张量被重复访问（ggml 使用基于指针地址的哈希集合，`ggml/src/ggml-impl.h:259`）。结果是一个**拓扑排序**的节点数组，执行时从 `nodes[0]` 到 `nodes[n_nodes-1]` 依次求值即可满足依赖关系。

---

## 6. ggml-alloc：gallocr 图分配器

权重张量在模型加载时已分配好内存，而计算图中的**中间激活张量**需要在每次推理时动态分配。ggml-alloc 的 gallocr（Graph Allocator）负责这一任务，其核心设计目标是：**通过生命期分析复用内存，最小化 working set 大小**。

### 6.1 gallocr 的结构

```c
// ggml/src/ggml-alloc.c:481
struct ggml_gallocr {
    ggml_backend_buffer_type_t * bufts;    // 每个 buffer 的类型
    struct vbuffer ** buffers;             // 实际分配的后端 buffer
    struct ggml_dyn_tallocr ** buf_tallocs;// 动态线性分配器（每 buffer 一个）
    int n_buffers;

    struct ggml_hash_set hash_set;
    struct hash_node * hash_values;        // 每张量的分配状态

    struct node_alloc * node_allocs;       // 每节点的分配记录
    int n_nodes;
    struct leaf_alloc * leaf_allocs;
    int n_leafs;
};
```

`ggml_dyn_tallocr` 维护一个有序的空闲块链表（`free_blocks[]`，`ggml/src/ggml-alloc.c:115`），采用 **best-fit** 策略（`ggml/src/ggml-alloc.c:212`）在当前所有 chunk 中寻找最接近所需大小的空闲块。

### 6.2 reserve 阶段：测量阶段

```c
// ggml/include/ggml-alloc.h:57
bool ggml_gallocr_reserve(ggml_gallocr_t galloc, struct ggml_cgraph * graph);
```

`reserve` 阶段（`ggml/src/ggml-alloc.c:965`）的工作：

1. 遍历图中每个节点，模拟分配/释放——对已完成计算（没有后续消费者）的中间张量调用 `ggml_dyn_tallocr_free_bytes` 归还虚拟空间
2. 此阶段**只记录每个张量所需的最大偏移量**（即 `buf_tallocs` 中 `max_size`），不实际分配设备内存
3. 计算完成后根据 `max_size` 向后端申请真实 buffer

**设计理由**：对于变长 batch 或不同上下文长度，图的拓扑结构不变但张量大小不同。先 `reserve` 一个最坏情况（最大 batch）的图，可以确定 buffer 上界，避免后续频繁 realloc；之后对较小的图直接复用已分配的 buffer（`ggml_gallocr_needs_realloc` 判断是否需要重新分配，`ggml/src/ggml-alloc.c:1008`）。

### 6.3 alloc_graph 阶段：执行分配

```c
// ggml/include/ggml-alloc.h:72
bool ggml_gallocr_alloc_graph(ggml_gallocr_t galloc, struct ggml_cgraph * graph);
```

`alloc_graph` 实际将已确定大小的 buffer 中的地址写入各张量的 `data` 指针，并处理原位算子的内存复用（`ggml_gallocr_alloc_graph_impl`，`ggml/src/ggml-alloc.c:717`）。

### 6.4 内存复用示意

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Memory reuse timeline showing gallocr lifetime-aware allocation across nodes A to F">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="300" fill="#f8fafc" rx="8"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">gallocr 内存复用时间线</text>
  <text x="50" y="50" font-size="11" fill="#64748b">执行顺序 →</text>
  <line x1="110" y1="45" x2="710" y2="45" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <text x="380" y="42" text-anchor="middle" font-size="11" fill="#94a3b8">时间轴</text>
  <text x="140" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">A</text>
  <text x="240" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">B</text>
  <text x="340" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">C</text>
  <text x="440" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">D</text>
  <text x="540" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">E</text>
  <text x="640" y="65" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">F</text>
  <line x1="110" y1="68" x2="710" y2="68" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="50" y="105" text-anchor="middle" font-size="11" fill="#64748b">M1</text>
  <rect x="110" y="80" width="320" height="36" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5" rx="4"/>
  <text x="190" y="102" font-size="11" font-weight="600" fill="#ea580c">A 占用 M1</text>
  <rect x="430" y="80" width="20" height="36" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" rx="2"/>
  <text x="440" y="102" text-anchor="middle" font-size="9" fill="#dc2626">free</text>
  <rect x="450" y="80" width="260" height="36" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5" rx="4"/>
  <text x="580" y="102" font-size="11" font-weight="600" fill="#7c3aed">F 复用 M1</text>
  <text x="50" y="155" text-anchor="middle" font-size="11" fill="#64748b">M2</text>
  <rect x="210" y="130" width="120" height="36" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5" rx="4"/>
  <text x="270" y="152" font-size="11" font-weight="600" fill="#0d9488">B 占用 M2</text>
  <rect x="330" y="130" width="20" height="36" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5" rx="2"/>
  <text x="340" y="152" text-anchor="middle" font-size="9" fill="#dc2626">free</text>
  <rect x="350" y="130" width="180" height="36" fill="#99f6e4" stroke="#0d9488" stroke-width="0.8" rx="4" stroke-dasharray="4,2"/>
  <text x="440" y="152" font-size="11" font-weight="600" fill="#0d9488">C/E 复用 M2</text>
  <rect x="80" y="188" width="600" height="90" fill="#f1f5f9" rx="6" stroke="#cbd5e1"/>
  <text x="380" y="207" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">内存峰值分析</text>
  <text x="380" y="225" text-anchor="middle" font-size="11" fill="#16a34a">Peak memory = sizeof(M1) + sizeof(M2)   (仅两块，非全部激活之和)</text>
  <text x="380" y="243" text-anchor="middle" font-size="11" fill="#64748b">A 的输出 M1 在 D 计算完成后释放 → F 复用 M1</text>
  <text x="380" y="261" text-anchor="middle" font-size="11" fill="#64748b">B 的输出 M2 在 C 完成后释放 → E 复用 M2</text>
</svg>
<span class="figure-caption">图 R4.3 ｜ gallocr 生命期感知内存复用时间线（best-fit 策略）</span>

<details>
<summary>ASCII 原版</summary>

```
时间线（执行顺序 →）
节点:  A   B   C   D   E   F
          ↓   ↓   ↓   ↓
内存:
  M1: [A ──────── free][D ──── free][F ....]
  M2:     [B ── free][ C ─── free][E .....]

A 的输出 M1 在 D 计算完成后释放，M1 被 F 复用。
B 的输出 M2 在 C 完成后释放，M2 被 E 复用。
Peak memory = sizeof(M1) + sizeof(M2)，而非所有激活之和。
```

</details>

### 6.5 输入/输出张量的特殊处理

`ggml_set_input(tensor)` 和 `ggml_set_output(tensor)`（`ggml/include/ggml.h:870`）分别设置 `GGML_TENSOR_FLAG_INPUT` 和 `GGML_TENSOR_FLAG_OUTPUT` 标志。gallocr 对 output 张量不释放内存（防止被后续节点覆写），对 input 张量在图开始时按非重叠地址分配（`ggml/include/ggml-alloc.h:43`）。

---

## 7. 量化类型在 ggml 中的表示

### 7.1 ggml_type 枚举

`ggml_type`（`ggml/include/ggml.h:389`）枚举了 ggml 支持的所有数据类型：

```c
enum ggml_type {
    GGML_TYPE_F32  = 0,
    GGML_TYPE_F16  = 1,
    GGML_TYPE_Q4_0 = 2,   // 4-bit 量化，绝对最大值量化
    GGML_TYPE_Q4_1 = 3,   // 4-bit 量化，带 min 的非对称量化
    GGML_TYPE_Q5_0 = 6,
    GGML_TYPE_Q5_1 = 7,
    GGML_TYPE_Q8_0 = 8,   // 8-bit 量化（常用于激活）
    GGML_TYPE_Q2_K = 10,  // k-quant：超级 block，2-bit
    GGML_TYPE_Q3_K = 11,
    GGML_TYPE_Q4_K = 12,
    GGML_TYPE_Q5_K = 13,
    GGML_TYPE_Q6_K = 14,
    GGML_TYPE_IQ2_XXS = 16, // i-quant（importance-aware）
    GGML_TYPE_BF16 = 30,
    GGML_TYPE_NVFP4 = 40,  // NVFP4（4 blocks，E4M3 scale）
    // ...
    GGML_TYPE_COUNT = 42,
};
```

### 7.2 Block 结构概念

量化类型的核心思想是以 **block** 为单位存储一组整数量化值 + 共享缩放因子，从而降低位宽的同时保留精度。例如 Q4_0 中，每 32 个 float 值共享 1 个 float16 缩放因子，存储为 1 个 block = 2 字节（scale_fp16）+ 16 字节（32 个 4-bit 值）= 18 字节，相比 F32 节省 32×4-18=110 字节（约 6.4:1 压缩率）。

关键 API（`ggml/include/ggml.h:740`）：

```c
int64_t ggml_blck_size(enum ggml_type type); // block 含的元素数（如 Q4_0=32）
size_t  ggml_type_size(enum ggml_type type); // 一个 block 的字节数
size_t  ggml_row_size (enum ggml_type type, int64_t ne); // 一整行的字节数
```

张量的 `nb[0]` 等于 `ggml_type_size(type)`（一个 block 字节数），而非单个元素字节数。这与 F32 张量（`nb[0] = 4`）的处理方式一致：都以 "最小可寻址单元" 为 `nb[0]`。量化 kernel 通过 `ne[0] / ggml_blck_size(type)` 计算实际 block 数量。

量化类型的详细 block 结构（`block_q4_0` 等 C 结构体）及量化/反量化 kernel 详见第 13 章。

---

## 8. 图执行的入口：ggml_backend_graph_compute

ggml 本身只定义图结构和算子语义，真正执行在**后端（backend）**层进行。后端负责将抽象的 `ggml_op` 映射到具体硬件指令。

统一入口（`ggml/include/ggml-backend.h`）：

```c
enum ggml_status ggml_backend_graph_compute(
    ggml_backend_t  backend,
    struct ggml_cgraph * cgraph);
```

调用时，backend 遍历 `cgraph->nodes`，对每个节点查找对应的 kernel 实现并执行。各后端（CPU/CUDA/Metal/Vulkan 等）的注册与调度机制详见第 9 章。

在 llama.cpp 的推理管线中，实际使用的是更高层的 `ggml_backend_sched`（后端调度器），它可以将不同节点分发到不同后端：CPU 后端处理不支持 GPU 的算子，GPU 后端处理权重计算密集的矩阵乘法。这一层的分析同样留给第 9 章。

---

## 9. 完整数据流：从算子调用到执行

以一层 Transformer 的 attention norm → Q 投影为例，展示完整的两阶段流程：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-phase ggml pipeline: graph construction, memory allocation, and execution">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="540" fill="#f8fafc" rx="8"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">完整两阶段流程：图构建 → 内存分配 → 图执行</text>
  <rect x="30" y="40" width="700" height="148" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5" rx="6"/>
  <text x="48" y="58" font-size="12" font-weight="700" fill="#ea580c">阶段一：图构建（纯指针操作，无数值计算）</text>
  <rect x="48" y="66" width="130" height="28" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="113" y="84" text-anchor="middle" font-size="10" fill="#64748b">inpL  op=NONE leafs</text>
  <rect x="198" y="66" width="150" height="28" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="273" y="84" text-anchor="middle" font-size="10" fill="#64748b">attn_norm_w  op=NONE leafs</text>
  <rect x="48" y="106" width="130" height="28" fill="#fed7aa" stroke="#ea580c" rx="4"/>
  <text x="113" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">RMS_NORM</text>
  <line x1="113" y1="94" x2="113" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="198" y="106" width="130" height="28" fill="#fed7aa" stroke="#ea580c" rx="4"/>
  <text x="263" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">MUL</text>
  <line x1="178" y1="120" x2="198" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="348" y="106" width="130" height="28" fill="#fed7aa" stroke="#ea580c" rx="4"/>
  <text x="413" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">MUL_MAT</text>
  <line x1="328" y1="120" x2="348" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="498" y="106" width="130" height="28" fill="#fed7aa" stroke="#ea580c" rx="4"/>
  <text x="563" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">ROPE</text>
  <line x1="478" y1="120" x2="498" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <text x="48" y="162" font-size="10" fill="#94a3b8">所有节点 data=NULL，src[] 指向前驱张量</text>
  <text x="400" y="162" font-size="10" fill="#94a3b8">→ gf->nodes = [rms_norm, mul, mul_mat, rope, ...]</text>
  <rect x="30" y="202" width="700" height="128" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" rx="6"/>
  <text x="48" y="220" font-size="12" font-weight="700" fill="#16a34a">阶段二：内存分配（gallocr）</text>
  <rect x="48" y="230" width="290" height="44" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="193" y="248" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">ggml_gallocr_reserve(galloc, gf)</text>
  <text x="193" y="264" text-anchor="middle" font-size="10" fill="#94a3b8">遍历图，计算最大 buffer 上界</text>
  <line x1="338" y1="252" x2="368" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="368" y="230" width="340" height="44" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="538" y="248" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">ggml_gallocr_alloc_graph(galloc, gf)</text>
  <text x="538" y="264" text-anchor="middle" font-size="10" fill="#94a3b8">写入各节点 data 指针，处理原位复用</text>
  <text x="48" y="308" font-size="10" fill="#16a34a">可复用：rms_norm 的缓冲区在 mul 消耗后被 rope 复用（生命期感知）</text>
  <rect x="30" y="344" width="700" height="128" fill="#eff6ff" stroke="#0ea5e9" stroke-width="1.5" rx="6"/>
  <text x="48" y="362" font-size="12" font-weight="700" fill="#0ea5e9">阶段三：图执行（后端负责）</text>
  <rect x="48" y="372" width="220" height="44" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="158" y="390" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">ggml_backend_graph_compute</text>
  <text x="158" y="406" text-anchor="middle" font-size="10" fill="#94a3b8">(backend, gf)</text>
  <line x1="268" y1="394" x2="298" y2="394" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="298" y="372" width="220" height="44" fill="#f1f5f9" stroke="#cbd5e1" rx="4"/>
  <text x="408" y="390" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">for node in gf->nodes</text>
  <text x="408" y="406" text-anchor="middle" font-size="10" fill="#94a3b8">拓扑序逐节点求值</text>
  <line x1="518" y1="394" x2="548" y2="394" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="548" y="372" width="162" height="44" fill="#ddd6fe" stroke="#7c3aed" rx="4"/>
  <text x="629" y="390" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">dispatch_kernel</text>
  <text x="629" y="406" text-anchor="middle" font-size="10" fill="#94a3b8">CPU / CUDA / Metal</text>
  <text x="48" y="456" font-size="10" fill="#0ea5e9">后端负责将 ggml_op 映射到具体硬件指令；CPU/GPU 后端均使用同一 cgraph</text>
  <rect x="30" y="482" width="700" height="38" fill="#f1f5f9" rx="6" stroke="#cbd5e1"/>
  <text x="380" y="497" text-anchor="middle" font-size="11" fill="#64748b">关键点：图构建代码不需要知道张量将被分配在哪个设备上 — 由 allocator 决定</text>
  <text x="380" y="513" text-anchor="middle" font-size="10" fill="#94a3b8">同一套图构建代码对所有后端（CPU / CUDA / Metal / Vulkan）通用</text>
</svg>
<span class="figure-caption">图 R4.4 ｜ ggml 推理三阶段流程：图构建→内存分配→后端执行</span>

<details>
<summary>ASCII 原版</summary>

```
阶段一：图构建（纯指针操作，无数值计算）
─────────────────────────────────────────
 inpL                         → ggml_tensor (op=NONE, data=已分配, leafs)
 attn_norm_w                  → ggml_tensor (op=NONE, data=权重, leafs)
 cur = ggml_rms_norm(ctx, inpL, eps)
   → cur {op=RMS_NORM, src[0]=inpL, data=NULL}
 cur = ggml_mul(ctx, cur, attn_norm_w)
   → cur {op=MUL, src[0]=rms_norm, src[1]=attn_norm_w, data=NULL}
 Qcur = ggml_mul_mat(ctx, wq, cur)
   → Qcur {op=MUL_MAT, src[0]=wq, src[1]=cur, data=NULL}
 Qcur = ggml_rope_ext(ctx, Qcur, inp_pos, ...)
   → Qcur {op=ROPE, src[0]=mul_mat, src[1]=inp_pos, data=NULL}

ggml_build_forward_expand(gf, final_output_tensor)
   → gf->nodes = [rms_norm, mul, mul_mat, rope, ...]（拓扑序）
   → gf->leafs = [inpL, attn_norm_w, wq, inp_pos, ...]

阶段二：内存分配
─────────────────────────────────────────
 ggml_gallocr_reserve(galloc, gf)
   → 遍历 gf，计算每节点所需内存，确定 buffer 大小上界
 ggml_gallocr_alloc_graph(galloc, gf)
   → 为 rms_norm.data, mul.data, mul_mat.data, rope.data 分配地址
   → 可复用：rms_norm 的缓冲区在 mul 消耗后被 rope 复用

阶段三：图执行（后端负责）
─────────────────────────────────────────
 ggml_backend_graph_compute(backend, gf)
   → for node in gf->nodes:
       dispatch_kernel(node->op, node->src, node->data)
```

</details>

---

## 10. 关键数据结构关系总图

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Key data structure relationships: ggml_context, ggml_cgraph, and ggml_gallocr">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar5d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
  </defs>
  <rect width="760" height="380" fill="#f8fafc" rx="8"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="currentColor">关键数据结构关系总图</text>
  <rect x="30" y="40" width="220" height="150" fill="#fff7ed" stroke="#ea580c" stroke-width="2" rx="8"/>
  <text x="140" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ggml_context</text>
  <text x="140" y="73" text-anchor="middle" font-size="10" fill="#64748b">内存池，持有张量元数据</text>
  <rect x="45" y="82" width="190" height="26" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="140" y="99" text-anchor="middle" font-size="10" fill="#64748b">weight_A  op=NONE  data→后端buffer</text>
  <rect x="45" y="112" width="190" height="26" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="140" y="129" text-anchor="middle" font-size="10" fill="#64748b">weight_B  op=NONE  data→后端buffer</text>
  <rect x="45" y="142" width="190" height="36" fill="#fed7aa" stroke="#ea580c" rx="3"/>
  <text x="140" y="158" text-anchor="middle" font-size="10" font-weight="600" fill="#ea580c">result_1  op=MUL_MAT</text>
  <text x="140" y="171" text-anchor="middle" font-size="10" fill="#64748b">src[0]=A, src[1]=B, data=NULL</text>
  <rect x="270" y="40" width="220" height="150" fill="#f0fdf4" stroke="#16a34a" stroke-width="2" rx="8"/>
  <text x="380" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="#16a34a">ggml_cgraph</text>
  <text x="380" y="73" text-anchor="middle" font-size="10" fill="#64748b">计算图（DAG 线性化）</text>
  <rect x="285" y="82" width="190" height="42" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="380" y="98" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">nodes[0..n_nodes-1]</text>
  <text x="380" y="114" text-anchor="middle" font-size="10" fill="#94a3b8">拓扑序排列的计算节点</text>
  <rect x="285" y="128" width="190" height="42" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="380" y="144" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">leafs[0..n_leafs-1]</text>
  <text x="380" y="160" text-anchor="middle" font-size="10" fill="#94a3b8">权重/输入等叶节点</text>
  <rect x="510" y="40" width="220" height="150" fill="#eff6ff" stroke="#0ea5e9" stroke-width="2" rx="8"/>
  <text x="620" y="58" text-anchor="middle" font-size="13" font-weight="700" fill="#0ea5e9">ggml_gallocr</text>
  <text x="620" y="73" text-anchor="middle" font-size="10" fill="#64748b">图分配器</text>
  <rect x="525" y="82" width="190" height="26" fill="#f1f5f9" stroke="#cbd5e1" rx="3"/>
  <text x="620" y="99" text-anchor="middle" font-size="10" fill="#64748b">bufts/buffers  后端buffer(CPU/CUDA)</text>
  <rect x="525" y="112" width="190" height="66" fill="#ddd6fe" stroke="#7c3aed" rx="3"/>
  <text x="620" y="128" text-anchor="middle" font-size="10" font-weight="600" fill="#7c3aed">buf_tallocs</text>
  <text x="620" y="142" text-anchor="middle" font-size="10" fill="#64748b">动态线性分配器</text>
  <text x="620" y="156" text-anchor="middle" font-size="10" fill="#94a3b8">（空闲块链表）</text>
  <text x="620" y="170" text-anchor="middle" font-size="10" fill="#94a3b8">best-fit 策略</text>
  <line x1="250" y1="115" x2="270" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <line x1="490" y1="115" x2="510" y2="115" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="30" y="212" width="700" height="148" fill="#f1f5f9" rx="6" stroke="#cbd5e1"/>
  <text x="380" y="230" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">运行时关系</text>
  <rect x="50" y="240" width="200" height="44" fill="#fff7ed" stroke="#ea580c" rx="4"/>
  <text x="150" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">ggml_context</text>
  <text x="150" y="274" text-anchor="middle" font-size="10" fill="#64748b">持有所有张量的元数据</text>
  <line x1="250" y1="262" x2="280" y2="262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="280" y="240" width="200" height="44" fill="#f0fdf4" stroke="#16a34a" rx="4"/>
  <text x="380" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">ggml_cgraph.nodes</text>
  <text x="380" y="274" text-anchor="middle" font-size="10" fill="#64748b">引用 context 中的张量</text>
  <line x1="480" y1="262" x2="510" y2="262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="510" y="240" width="200" height="44" fill="#eff6ff" stroke="#0ea5e9" rx="4"/>
  <text x="610" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">ggml_gallocr</text>
  <text x="610" y="274" text-anchor="middle" font-size="10" fill="#64748b">为 data=NULL 分配地址</text>
  <text x="380" y="316" text-anchor="middle" font-size="11" fill="#64748b">图执行前：gallocr 为 nodes 中 data=NULL 的张量分配真实内存地址</text>
  <text x="380" y="336" text-anchor="middle" font-size="11" fill="#64748b">生命期感知：前一节点 data 用完后归还空闲块，下一节点可复用</text>
  <text x="380" y="352" text-anchor="middle" font-size="10" fill="#94a3b8">权重张量的 data 已由模型加载时分配，gallocr 不再处理</text>
</svg>
<span class="figure-caption">图 R4.5 ｜ ggml_context / ggml_cgraph / ggml_gallocr 三者关系总图</span>

<details>
<summary>ASCII 原版</summary>

```
ggml_context
  │  (内存池，持有所有 ggml_tensor 的元数据)
  ├─ ggml_tensor* [weight_A]    op=NONE, data→后端buffer
  ├─ ggml_tensor* [weight_B]    op=NONE, data→后端buffer
  └─ ggml_tensor* [result_1]    op=MUL_MAT, src[0]=A, src[1]=B, data=NULL

ggml_cgraph
  ├─ nodes[0..n_nodes-1]        按拓扑序排列的计算节点
  └─ leafs[0..n_leafs-1]        权重/输入等叶节点

ggml_gallocr
  ├─ bufts/buffers              后端 buffer（CPU/CUDA 等）
  └─ buf_tallocs                动态线性分配器（空闲块链表）
       └─ 图执行前：为 nodes 中 data=NULL 的张量分配地址
       └─ 生命期感知：前一节点 data 使用完毕后归还给空闲块
```

</details>

---

## 11. 关键文件速查

| 文件 | 主要内容 |
|------|---------|
| `ggml/include/ggml.h` | `ggml_tensor` / `ggml_type` / `ggml_op` 定义，所有算子 API 声明 |
| `ggml/src/ggml-impl.h` | `ggml_cgraph` 内部结构，`ggml_hash_set`，`ggml_bitset` |
| `ggml/src/ggml.c` | 算子 API 实现（建图部分），图构建 / 遍历逻辑 |
| `ggml/include/ggml-alloc.h` | `ggml_gallocr_t` / `ggml_tallocr` 声明，reserve/alloc 接口 |
| `ggml/src/ggml-alloc.c` | gallocr 完整实现，best-fit 分配器，inplace 复用逻辑 |
| `ggml/include/ggml-backend.h` | `ggml_backend_graph_compute` 声明，后端类型定义 |
