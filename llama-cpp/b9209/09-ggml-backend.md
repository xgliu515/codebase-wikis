# 第 9 章 GGML 后端系统与硬件加速

## 总览

ggml 的后端系统解决的核心问题是：同一张计算图（`ggml_cgraph`）需要在 CPU、Apple Metal、NVIDIA CUDA、Vulkan 等截然不同的硬件上执行，而上层代码不应该感知差异。整个体系由五个层次的抽象组成：

<svg viewBox="0 0 760 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Five-layer GGML backend abstraction hierarchy">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="340" fill="#f8fafc" rx="8"/>
  <rect x="300" y="14" width="160" height="36" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="37" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">调用者</text>
  <line x1="380" y1="50" x2="380" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="200" y="72" width="360" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="91" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ggml_backend_sched</text>
  <text x="380" y="107" text-anchor="middle" font-size="11" fill="#64748b">调度器：把计算图拆分并分配给各后端</text>
  <line x1="380" y1="116" x2="380" y2="138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="200" y="138" width="360" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="157" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">ggml_backend  (stream)</text>
  <text x="380" y="173" text-anchor="middle" font-size="11" fill="#64748b">后端流：提交计算、管理异步执行</text>
  <line x1="380" y1="182" x2="380" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="200" y="204" width="360" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="223" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">ggml_backend_device</text>
  <text x="380" y="239" text-anchor="middle" font-size="11" fill="#64748b">设备：一块 GPU 或 CPU 实例</text>
  <line x1="380" y1="248" x2="380" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="200" y="270" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="293" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">ggml_backend_reg</text>
  <text x="564" y="293" text-anchor="start" font-size="11" fill="#64748b">  注册项：一个驱动/库（CUDA、Metal…）</text>
  <line x1="260" y1="306" x2="260" y2="322" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <line x1="500" y1="306" x2="500" y2="322" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <rect x="80" y="322" width="340" height="12" rx="0" fill="none"/>
  <rect x="60" y="322" width="380" height="4" rx="0" fill="none"/>
  <rect x="60" y="314" width="280" height="22" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="200" y="329" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">ggml_backend_buffer_type</text>
  <rect x="420" y="314" width="280" height="22" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="560" y="329" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">ggml_backend_buffer</text>
  <text x="200" y="343" text-anchor="middle" font-size="10" fill="#94a3b8">内存类型：决定如何分配张量数据</text>
  <text x="560" y="343" text-anchor="middle" font-size="10" fill="#94a3b8">已分配内存块</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ GGML 后端五层抽象层次结构</span>

<details>
<summary>ASCII 原版</summary>

```
        调用者
          |
    ggml_backend_sched          -- 调度器：把图拆分并分配给各后端
          |
  ggml_backend (stream)         -- 后端流：提交计算、管理异步执行
          |
  ggml_backend_device           -- 设备：一块 GPU 或 CPU 实例
          |
  ggml_backend_reg              -- 注册项：一个驱动/库（CUDA、Metal…）
          |
  ggml_backend_buffer_type      -- 内存类型：决定如何分配张量数据
  ggml_backend_buffer           -- 已分配内存块
```

</details>

各抽象均通过 C 函数指针表（`_i` 结构）实现多态，对外只暴露不透明指针，实现完全隔离。

---

## 9.1 核心抽象与接口

### 9.1.1 五大 C 类型

以下类型定义在 `ggml/include/ggml-backend.h:24-30`：

```c
typedef struct ggml_backend_buffer_type * ggml_backend_buffer_type_t;
typedef struct ggml_backend_buffer      * ggml_backend_buffer_t;
typedef struct ggml_backend             * ggml_backend_t;
typedef struct ggml_backend_reg         * ggml_backend_reg_t;
typedef struct ggml_backend_device      * ggml_backend_dev_t;
```

所有具体实现对调用者完全不透明，只通过公开 API 访问。

### 9.1.2 buffer type 与 buffer

`ggml_backend_buffer_type` 是内存分配策略的描述符，`ggml_backend_buffer` 是已分配的内存块（`ggml/src/ggml-backend-impl.h:17-70`）：

```c
struct ggml_backend_buffer_type_i {
    const char *          (*get_name)      (ggml_backend_buffer_type_t buft);
    ggml_backend_buffer_t (*alloc_buffer)  (ggml_backend_buffer_type_t buft, size_t size);
    size_t                (*get_alignment) (ggml_backend_buffer_type_t buft);
    size_t                (*get_alloc_size)(ggml_backend_buffer_type_t buft, const struct ggml_tensor *);
    bool                  (*is_host)       (ggml_backend_buffer_type_t buft);
};

struct ggml_backend_buffer_i {
    void  (*free_buffer)(ggml_backend_buffer_t buffer);
    void *(*get_base)   (ggml_backend_buffer_t buffer);
    void  (*set_tensor) (ggml_backend_buffer_t, struct ggml_tensor *, const void *, size_t, size_t);
    void  (*get_tensor) (ggml_backend_buffer_t, const struct ggml_tensor *, void *, size_t, size_t);
    bool  (*cpy_tensor) (ggml_backend_buffer_t, const struct ggml_tensor * src, struct ggml_tensor * dst);
    void  (*clear)      (ggml_backend_buffer_t buffer, uint8_t value);
};
```

`buffer` 还携带一个 `usage` 枚举（`ggml/include/ggml-backend.h:49-53`）：

| 值 | 含义 |
|---|---|
| `GGML_BACKEND_BUFFER_USAGE_ANY` | 通用 |
| `GGML_BACKEND_BUFFER_USAGE_WEIGHTS` | 权重（提示调度器优先就近执行） |
| `GGML_BACKEND_BUFFER_USAGE_COMPUTE` | 计算中间结果 |

**为什么要区分 buffer type 与 buffer？** buffer type 是无状态的分配蓝图，可被多个 buffer 共享；buffer 是一次实际分配，持有 `context`（可以是 CUDA 设备指针、Metal MTLBuffer 等平台对象）。

### 9.1.3 backend stream

`ggml_backend`（`ggml/src/ggml-backend-impl.h:105-147`）代表一条命令流：

```c
struct ggml_backend_i {
    const char *     (*get_name)         (ggml_backend_t backend);
    void             (*free)             (ggml_backend_t backend);
    void             (*set_tensor_async) (ggml_backend_t, struct ggml_tensor *, const void *, size_t, size_t);
    void             (*get_tensor_async) (ggml_backend_t, const struct ggml_tensor *, void *, size_t, size_t);
    bool             (*cpy_tensor_async) (ggml_backend_t src, ggml_backend_t dst, ...);
    void             (*synchronize)      (ggml_backend_t backend);
    enum ggml_status (*graph_compute)    (ggml_backend_t backend, struct ggml_cgraph * cgraph);
    void             (*event_record)     (ggml_backend_t, ggml_backend_event_t);
    void             (*event_wait)       (ggml_backend_t, ggml_backend_event_t);
};

struct ggml_backend {
    ggml_guid_t           guid;
    struct ggml_backend_i iface;
    ggml_backend_dev_t    device;
    void                * context;
};
```

`ggml_backend_t` 是最终提交执行的句柄。每次 `graph_compute` 调用将整个子图或完整图提交到对应硬件执行队列。`synchronize` 等待该流上所有操作完成（CPU 后端同步为空操作，CUDA 后端会调用 `cudaStreamSynchronize`）。

### 9.1.4 device 与 reg

`ggml_backend_device` 描述一个具体硬件单元（如 GPU 0），它实现 `ggml_backend_device_i`（`ggml/src/ggml-backend-impl.h:160-208`），关键方法：

- `get_type` → `GGML_BACKEND_DEVICE_TYPE_GPU / CPU / IGPU / ACCEL`
- `init_backend` → 创建该设备上的一条命令流（`ggml_backend_t`）
- `get_buffer_type` → 返回该设备的默认内存类型
- `supports_op` → 判断设备能否执行某算子
- `offload_op` → 即使权重不在设备内存中，是否仍值得在此设备计算

`ggml_backend_reg` 代表一个完整驱动插件（例如 CUDA 驱动），它枚举所有可用设备，并可选地通过 `get_proc_address` 导出扩展函数指针。

---

## 9.2 运行时后端注册与发现

### 9.2.1 静态注册

`ggml/src/ggml-backend-reg.cpp` 实现全局注册表 `ggml_backend_registry`，其构造函数（第 115-167 行）按编译选项依次调用各后端的 `_reg()` 函数：

```c
// ggml/src/ggml-backend-reg.cpp:116-166
#ifdef GGML_USE_CUDA
    register_backend(ggml_backend_cuda_reg());
#endif
#ifdef GGML_USE_METAL
    register_backend(ggml_backend_metal_reg());
#endif
// ...（SYCL、Vulkan、BLAS、CPU 等）
#ifdef GGML_USE_CPU
    register_backend(ggml_backend_cpu_reg());  // CPU 始终最后注册（最低优先级）
#endif
```

GPU 类后端早于 CPU 注册意味着它们在 `devices[]` 数组中索引更低，调度器以低索引为高优先级。

### 9.2.2 动态库加载

`GGML_BACKEND_DL=ON` 时各后端编译为独立共享库（Linux `libggml-cuda-*.so`，macOS 例外不支持 MODULE + dyld 的 RPATH 组合）。`ggml_backend_load_all()` 从可执行文件目录或 `GGML_BACKEND_DIR` 目录扫描（`ggml/src/ggml-backend-reg.cpp:555-586`）：

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Dynamic backend loading call tree">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="280" fill="#f8fafc" rx="8"/>
  <rect x="220" y="14" width="320" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ggml_backend_load_all()</text>
  <line x1="380" y1="48" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <rect x="180" y="68" width="400" height="34" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="90" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">ggml_backend_load_all_from_path(dir)</text>
  <line x1="260" y1="102" x2="260" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <line x1="380" y1="102" x2="380" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <line x1="500" y1="102" x2="500" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2)"/>
  <rect x="100" y="118" width="320" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="260" y="135" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">ggml_backend_load_best("cuda", ...)</text>
  <text x="260" y="148" text-anchor="middle" font-size="10" fill="#64748b">扫描 libggml-cuda-*.so，按 score 选最优</text>
  <rect x="100" y="162" width="320" height="22" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="260" y="177" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">ggml_backend_load_best("metal", ...)</text>
  <rect x="100" y="194" width="320" height="22" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="260" y="209" text-anchor="middle" font-size="11" fill="#64748b">… (vulkan, sycl, cpu …)</text>
  <rect x="430" y="118" width="300" height="50" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="580" y="138" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">读取 GGML_BACKEND_PATH</text>
  <text x="580" y="154" text-anchor="middle" font-size="10" fill="#64748b">加载外部/第三方后端动态库</text>
  <rect x="100" y="234" width="600" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="400" y="247" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">ggml_backend_score()  →  选最高分变体</text>
  <text x="400" y="261" text-anchor="middle" font-size="10" fill="#64748b">libggml-cpu-avx2.so / libggml-cpu-avx512.so → 运行时 CPUID 决策</text>
</svg>
<span class="figure-caption">图 R9.2 ｜ 动态后端加载调用树与 score 选优机制</span>

<details>
<summary>ASCII 原版</summary>

```
ggml_backend_load_all()
  └─ ggml_backend_load_all_from_path(dir)
       ├─ ggml_backend_load_best("cuda", ...)
       │    扫描 libggml-cuda-*.so，调用 ggml_backend_score() 选最高分变体
       ├─ ggml_backend_load_best("metal", ...)
       ├─ ...
       └─ 读取 GGML_BACKEND_PATH 环境变量加载外部后端
```

</details>

动态库必须导出两个符号（`ggml/src/ggml-backend-impl.h:235-238`）：

```c
typedef ggml_backend_reg_t (*ggml_backend_init_t)(void);  // 必须
typedef int                (*ggml_backend_score_t)(void); // 可选，0 表示不支持当前系统
```

`ggml_backend_load_best` 策略：先对同名所有变体文件调用 `ggml_backend_score`，选分数最高的文件加载。这样可以同时提供 `libggml-cpu-avx2.so`、`libggml-cpu-avx512.so`，运行时自动选择最优。

---

## 9.3 backend scheduler：多后端协作

`ggml_backend_sched` 是 llama.cpp 中实现 CPU+GPU 混合推理的核心，定义于 `ggml/src/ggml-backend.cpp:774-828`。

### 9.3.1 数据结构

```c
// ggml/src/ggml-backend.cpp:774-828
struct ggml_backend_sched {
    int n_backends;
    ggml_backend_t          backends[GGML_SCHED_MAX_BACKENDS];  // 最多 16 个后端
    ggml_backend_buffer_type_t bufts[GGML_SCHED_MAX_BACKENDS];

    struct ggml_hash_set  hash_set;
    int * hv_tensor_backend_ids;     // [hash_set.size]  每个张量分配到哪个后端
    struct ggml_tensor ** hv_tensor_copies;  // [hash_set.size][n_backends][n_copies]

    struct ggml_backend_sched_split * splits;  // 图被拆为若干 split
    int n_splits;

    int n_copies;       // pipeline parallelism 副本数（默认 1，最大 4）
    int cur_copy;       // 当前使用的副本索引

    ggml_backend_event_t events[GGML_SCHED_MAX_BACKENDS][GGML_SCHED_MAX_COPIES];
    bool op_offload;
};

struct ggml_backend_sched_split {
    int backend_id;
    int i_start, i_end;     // 对应原始 cgraph 的节点范围
    struct ggml_tensor * inputs[GGML_SCHED_MAX_SPLIT_INPUTS];  // 最多 30 个跨 split 输入
    int n_inputs;
    struct ggml_cgraph graph;   // 该 split 的图视图
};
```

### 9.3.2 张量后端分配算法

`ggml_backend_sched_split_graph`（`ggml/src/ggml-backend.cpp:1014`）是调度器的核心：

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Five-pass tensor backend assignment algorithm">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="380" fill="#f8fafc" rx="8"/>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">ggml_backend_sched_split_graph — 5-Pass 张量后端分配</text>
  <rect x="30" y="36" width="700" height="52" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="90" y="57" text-anchor="start" font-size="12" font-weight="700" fill="#ea580c">Pass 1</text>
  <text x="150" y="57" text-anchor="start" font-size="12" font-weight="600" fill="currentColor">从 buffer 推断</text>
  <text x="90" y="75" text-anchor="start" font-size="11" fill="#64748b">若张量 .data 已在某后端 buffer → backend_id = 能支持该 buffer 的最高优先级后端</text>
  <line x1="380" y1="88" x2="380" y2="104" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="30" y="104" width="700" height="52" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="90" y="125" text-anchor="start" font-size="12" font-weight="700" fill="#7c3aed">Pass 2</text>
  <text x="150" y="125" text-anchor="start" font-size="12" font-weight="600" fill="currentColor">向下传播（src → 节点）</text>
  <text x="90" y="143" text-anchor="start" font-size="11" fill="#64748b">若 src 已有 backend_id 且该后端能执行此节点 → 节点继承同一后端（避免无谓数据拷贝）</text>
  <line x1="380" y1="156" x2="380" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="30" y="172" width="700" height="52" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="90" y="193" text-anchor="start" font-size="12" font-weight="700" fill="#0d9488">Pass 3</text>
  <text x="150" y="193" text-anchor="start" font-size="12" font-weight="600" fill="currentColor">向上传播（节点 → src，反向）</text>
  <text x="90" y="211" text-anchor="start" font-size="11" fill="#64748b">若节点已有 backend_id → 反向将其 src 也拉到同一后端</text>
  <line x1="380" y1="224" x2="380" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="30" y="240" width="700" height="52" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="90" y="261" text-anchor="start" font-size="12" font-weight="700" fill="#0ea5e9">Pass 4</text>
  <text x="150" y="261" text-anchor="start" font-size="12" font-weight="600" fill="currentColor">Fallback</text>
  <text x="90" y="279" text-anchor="start" font-size="11" fill="#64748b">仍未分配的节点依次尝试 backends[0]…backends[n-1]，选第一个能执行该 op 的后端</text>
  <line x1="380" y1="292" x2="380" y2="308" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3)"/>
  <rect x="30" y="308" width="700" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="90" y="329" text-anchor="start" font-size="12" font-weight="700" fill="#16a34a">Pass 5</text>
  <text x="150" y="329" text-anchor="start" font-size="12" font-weight="600" fill="currentColor">Split 边界检测</text>
  <text x="90" y="347" text-anchor="start" font-size="11" fill="#64748b">扫描节点序列，cur_backend_id 切换时生成新 split；</text>
  <text x="90" y="362" text-anchor="start" font-size="11" fill="#64748b">跨 split 的张量依赖记录到 inputs[]，后续插入异步数据拷贝</text>
</svg>
<span class="figure-caption">图 R9.3 ｜ 调度器五阶段张量后端分配算法</span>

<details>
<summary>ASCII 原版</summary>

```
Pass 1：从 buffer 推断
  对每个张量：若其 data 已在某后端 buffer 中，
              则将该张量的 backend_id 设置为能支持该 buffer 的最高优先级后端

Pass 2：向下传播
  若节点的某个 src 已被分配了 backend_id，
  且该后端也能执行此节点，则将节点也分配给同一后端
  （避免无谓的数据拷贝）

Pass 3：向上传播（反向）
  若节点已有 backend_id，反向把其 src 拉到同一后端

Pass 4：fallback
  仍未分配的节点依次尝试 backends[0]…backends[n-1]，
  选第一个能执行该 op 的后端

Pass 5：split 边界检测
  扫描已分配的节点序列，当 cur_backend_id 发生切换时生成新 split
  跨 split 的张量依赖被记录为 inputs[]，后续需要插入数据拷贝
```

</details>

关键宏（`ggml/src/ggml-backend.cpp:831-833`）：

```c
#define hash_id(tensor)   ggml_hash_find_or_insert(&sched->hash_set, tensor)
#define tensor_backend_id(tensor) sched->hv_tensor_backend_ids[hash_id(tensor)]
#define tensor_id_copy(id, backend_id, copy_id) \
    sched->hv_tensor_copies[(id)*sched->n_backends*sched->n_copies + (backend_id)*sched->n_copies + (copy_id)]
```

`hv_tensor_copies` 三维数组为 pipeline parallelism 预分配多份副本；`n_copies > 1` 时不同批次的输入可以在不同副本间流水进行。

### 9.3.3 split 图与数据拷贝

每个 `split` 对应一条连续的节点序列，由同一个后端执行。跨 split 的张量需要拷贝（`ggml/src/ggml-backend.cpp:1554-1670`）：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="compute_splits execution flow with async copy and event sync">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar4d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="320" fill="#f8fafc" rx="8"/>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">compute_splits 执行流程</text>
  <rect x="30" y="34" width="700" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="53" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">for split in sched-&gt;splits:</text>
  <line x1="380" y1="62" x2="380" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="60" y="78" width="640" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="97" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">for input in split.inputs:</text>
  <line x1="220" y1="106" x2="220" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="540" y1="106" x2="540" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="30" y="120" width="360" height="52" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="210" y="141" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">用户输入 (GGML_TENSOR_FLAG_INPUT)</text>
  <text x="210" y="157" text-anchor="middle" font-size="10" fill="#64748b">ggml_backend_tensor_copy(input, input_cpy)</text>
  <text x="210" y="169" text-anchor="middle" font-size="10" fill="#94a3b8">同步拷贝，防止数据被提前覆写</text>
  <rect x="400" y="120" width="330" height="52" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="565" y="141" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">普通权重（非用户输入）</text>
  <text x="565" y="157" text-anchor="middle" font-size="10" fill="#64748b">MoE: copy_used_experts_only()</text>
  <text x="565" y="169" text-anchor="middle" font-size="10" fill="#64748b">其他: cpy_tensor_async()</text>
  <line x1="380" y1="172" x2="380" y2="192" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="100" y="192" width="560" height="34" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="214" text-anchor="middle" font-size="12" font-weight="700" fill="#0d9488">ggml_backend_graph_compute_async(split_backend, split.graph)</text>
  <line x1="380" y1="226" x2="380" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="100" y="246" width="560" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="268" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">ggml_backend_event_record(event[split_backend][cur_copy])</text>
  <text x="380" y="296" text-anchor="middle" font-size="10" fill="#94a3b8">pipeline parallelism: n_copies &gt; 1 时 split N 的计算与 split N-1 的拷贝重叠执行</text>
</svg>
<span class="figure-caption">图 R9.4 ｜ compute_splits 跨后端数据拷贝与异步执行流程</span>

<details>
<summary>ASCII 原版</summary>

```
compute_splits 流程（伪代码）:
  for split in sched->splits:
    for input in split.inputs:
      input_cpy = tensor_copy(input, split.backend_id, cur_copy)
      if input->flags & GGML_TENSOR_FLAG_INPUT:
        # 用户输入，同步拷贝防止数据被提前覆写
        ggml_backend_tensor_copy(input, input_cpy)
      else:
        # MoE 权重特殊优化：仅拷贝本批次实际使用的 expert
        if is_moe_weight(input):
          copy_used_experts_only(input, input_cpy)
        else:
          cpy_tensor_async(input_backend, split_backend, input, input_cpy)
    ggml_backend_graph_compute_async(split_backend, split.graph)
    ggml_backend_event_record(event[split_backend][cur_copy])
```

</details>

**copy 复用（pipeline parallelism）**：`n_copies > 1` 时 split N 的计算与 split N-1 的输入拷贝重叠执行，用 `ggml_backend_event_wait` / `ggml_backend_event_record` 进行流间同步，避免 GPU 等待 CPU 数据搬运。

### 9.3.4 完整 graph_compute 调用链

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Complete graph_compute call chain from sched to hardware">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="400" fill="#f8fafc" rx="8"/>
  <rect x="160" y="10" width="440" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">ggml_backend_sched_graph_compute(sched, graph)</text>
  <line x1="380" y1="42" x2="380" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="140" y="58" width="480" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="79" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">ggml_backend_sched_graph_compute_async(sched, graph)</text>
  <line x1="260" y1="90" x2="260" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <line x1="560" y1="90" x2="560" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="30" y="106" width="410" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="235" y="125" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">[若未分配] ggml_backend_sched_alloc_graph(sched, graph)</text>
  <line x1="140" y1="136" x2="140" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <line x1="310" y1="136" x2="310" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="30" y="152" width="190" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="125" y="170" text-anchor="middle" font-size="10" font-weight="600" fill="#0ea5e9">ggml_backend_sched_split_graph</text>
  <text x="125" y="182" text-anchor="middle" font-size="9" fill="#94a3b8">5-pass 分配</text>
  <rect x="240" y="152" width="200" height="56" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="340" y="170" text-anchor="middle" font-size="10" font-weight="600" fill="#64748b">ggml_backend_sched_alloc_splits</text>
  <text x="340" y="184" text-anchor="middle" font-size="10" fill="#64748b">检查 backend_ids 是否相同</text>
  <text x="340" y="196" text-anchor="middle" font-size="9" fill="#16a34a">相同 → gallocr 原地复用</text>
  <text x="340" y="207" text-anchor="middle" font-size="9" fill="#dc2626">不同 → reserve + 重新规划</text>
  <rect x="450" y="106" width="280" height="130" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="590" y="124" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">ggml_backend_sched_compute_splits</text>
  <text x="590" y="140" text-anchor="middle" font-size="10" fill="#64748b">for each split:</text>
  <line x1="540" y1="148" x2="540" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="470" y="162" width="220" height="24" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="580" y="178" text-anchor="middle" font-size="10" fill="#dc2626">拷贝跨 split 输入张量</text>
  <line x1="580" y1="186" x2="580" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="470" y="200" width="220" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="580" y="216" text-anchor="middle" font-size="10" fill="#16a34a">graph_compute_async(split)</text>
  <line x1="380" y1="250" x2="380" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar5)"/>
  <rect x="160" y="270" width="440" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="290" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">ggml_backend_sched_synchronize(sched)</text>
  <text x="380" y="306" text-anchor="middle" font-size="10" fill="#64748b">等待所有后端完成（CPU: noop；CUDA: cudaStreamSynchronize）</text>
  <rect x="80" y="322" width="600" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="340" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">返回 ggml_status 给调用者</text>
  <line x1="380" y1="350" x2="380" y2="370" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar5)"/>
  <text x="380" y="386" text-anchor="middle" font-size="10" fill="#94a3b8">pipeline parallelism: event_record / event_wait 流间同步</text>
</svg>
<span class="figure-caption">图 R9.5 ｜ graph_compute 完整调用链（调度器到硬件）</span>

<details>
<summary>ASCII 原版</summary>

```
ggml_backend_sched_graph_compute(sched, graph)
  └─ ggml_backend_sched_graph_compute_async(sched, graph)
       ├─ [若未分配] ggml_backend_sched_alloc_graph(sched, graph)
       │    ├─ ggml_backend_sched_split_graph(sched, graph)   // 5-pass 分配
       │    └─ ggml_backend_sched_alloc_splits(sched)
       │         ├─ 检查 backend_ids 是否与上次相同
       │         ├─ 若相同：ggml_gallocr_alloc_graph(galloc, &sched->graph)  // 原地复用
       │         └─ 若不同：ggml_gallocr_reserve + ggml_gallocr_alloc_graph  // 重新规划
       └─ ggml_backend_sched_compute_splits(sched)            // 逐 split 执行
            for each split:
              ├─ 拷贝跨 split 输入张量
              └─ ggml_backend_graph_compute_async(split.backend, split.graph)
  └─ ggml_backend_sched_synchronize(sched)                    // 等待所有后端完成
```

</details>

---

## 9.4 CPU 后端

### 9.4.1 注册与初始化

CPU 后端通过 `ggml_backend_cpu_reg()` 注册，返回静态单例（`ggml/src/ggml-cpu/ggml-cpu.cpp:690-700`）。

`ggml_backend_cpu_init()` 分配 `ggml_backend_cpu_context`（第 99-110 行）：

```c
struct ggml_backend_cpu_context {
    int               n_threads;    // 默认 GGML_DEFAULT_N_THREADS
    ggml_threadpool_t threadpool;   // 可外部传入，也可内部创建
    uint8_t *         work_data;    // 算子临时 scratch 内存
    size_t            work_size;
    ggml_abort_callback abort_callback;
    bool              use_ref;      // 强制使用参考实现（用于调试）
};
```

### 9.4.2 图执行入口

`ggml_backend_cpu_graph_compute`（第 170-191 行）：

```c
static enum ggml_status ggml_backend_cpu_graph_compute(
        ggml_backend_t backend, struct ggml_cgraph * cgraph) {
    struct ggml_backend_cpu_context * cpu_ctx = backend->context;
    struct ggml_cplan cplan = ggml_graph_plan(cgraph, cpu_ctx->n_threads,
                                               cpu_ctx->threadpool);
    // 按需扩容 work_data
    if (cpu_ctx->work_size < cplan.work_size) { /* realloc */ }
    cplan.work_data = cpu_ctx->work_data;
    return ggml_graph_compute(cgraph, &cplan);
}
```

`ggml_graph_plan` 预扫描图，计算出最大 scratch 内存需求并决定每个节点可用的线程数（`ggml/src/ggml-cpu/ggml-cpu.c:2191`）。

### 9.4.3 算子分发

`ggml_compute_forward`（`ggml/src/ggml-cpu/ggml-cpu.c:1702`）是 CPU 侧算子分发的核心 switch-case，例：

```c
// ggml/src/ggml-cpu/ggml-cpu.c:1827-1835
case GGML_OP_MUL_MAT:
    ggml_compute_forward_mul_mat(params, tensor);
    break;
case GGML_OP_MUL_MAT_ID:
    ggml_compute_forward_mul_mat_id(params, tensor);
    break;
```

每个算子实现在 `ggml/src/ggml-cpu/ops.cpp` 或 `ggml-cpu.c` 中，通过 `params->ith`（线程索引）和 `params->nth`（总线程数）进行数据切片并行。

### 9.4.4 多线程：threadpool

`ggml_threadpool`（`ggml/src/ggml-cpu/ggml-cpu.c:471-495`）采用 work-stealing 模型：

```c
struct ggml_threadpool {
    ggml_mutex_t mutex;
    ggml_cond_t  cond;
    struct ggml_cgraph  * cgraph;
    struct ggml_cplan   * cplan;

    atomic_int  n_graph;          // 图计数器，每次新图触发工作线程醒来
    atomic_int  current_chunk;    // MUL_MAT 行级 work-stealing 游标
    atomic_bool stop, pause;
    atomic_int  abort;

    struct ggml_compute_state * workers;  // 每线程状态（含 CPU affinity mask）
    int  n_threads;
    int32_t prio;
    uint32_t poll;   // 0 = 纯等待；>0 = 先自旋 poll 轮再休眠
};
```

工作线程在每个 `ggml_graph_compute` 调用期间通过 `ggml_barrier` 两阶段同步，保证 INIT → COMPUTE → FINALIZE 三步的全局顺序。

空闲线程可选择自旋等待（降低唤醒延迟）或睡眠（降低功耗），由 `poll` 字段控制。

### 9.4.5 SIMD 分发

CPU 后端在编译期根据 `-mavx2`、`-mavx512f`、`-march=armv8-a+simd` 等标志选择向量路径。`GGML_CPU_ALL_VARIANTS=ON` 时 CMake 生成多个 CPU 变体目标（`ggml-cpu-haswell`、`ggml-cpu-avx512` 等），动态加载时 `ggml_backend_score` 通过 CPUID 判断选择最优库。

运行时特性枚举（`ggml/src/ggml-cpu/ggml-cpu.cpp:540-611`）通过 `get_proc_address("ggml_backend_get_features")` 导出，llama.cpp 用于日志打印：

```
AVX=1 AVX2=1 AVX512=1 AVX512_VBMI=1 AVX512_VNNI=1 AVX512_BF16=1
```

---

## 9.5 GPU 后端概览

### 9.5.1 Metal（macOS/iOS）

Metal 后端源码位于 `ggml/src/ggml-metal/`，使用 Objective-C++（`.m`/`.cpp` 混合）。

**统一内存特点**：Apple Silicon 的 CPU 与 GPU 共享物理 DRAM。Metal 后端在 `has_unified_memory` 为真时（`ggml/src/ggml-metal/ggml-metal-device.m:652,784`），对权重 buffer 使用 `MTLStorageMode.shared`，CPU 写入的权重无需显式拷贝即可被 GPU kernel 直接访问。这使得 Metal 下的"数据上传"成本接近零，而 CUDA 对独立显存的 CPU→GPU 拷贝是真实的 PCIe 带宽瓶颈。

图执行入口：`ggml_backend_metal_graph_compute`（`ggml/src/ggml-metal/ggml-metal.cpp:534-537`）调用 `ggml_metal_graph_compute`，后者将每个算子编码为 Metal Compute Command Encoder，提交到 MTLCommandBuffer。算子 kernel 用 MSL（Metal Shading Language）实现，编译为 `.metallib`，可嵌入可执行文件（`GGML_METAL_EMBED_LIBRARY=ON`）。

### 9.5.2 CUDA

CUDA 后端在 `ggml/src/ggml-cuda/` 下，每个算子独立为 `<op>.cu` 文件（`mul_mat.cu`、`flash_attn.cu` 等）。

**CUDA Graphs 加速**：当 `GGML_CUDA_GRAPHS=ON`（`ggml/CMakeLists.txt:209`），`ggml_backend_cuda_graph_compute`（`ggml/src/ggml-cuda/ggml-cuda.cu:4454`）在第一次执行时捕获整个 kernel 序列为 CUDA Graph，后续迭代直接 replay，消除每次内核提交的 CPU 开销。不支持 CUDA Graph 的情况（split buffer、MoE 等）会自动降级到逐 kernel 提交。

**多 GPU**：CUDA 后端注册时枚举所有 `cudaGetDeviceCount()` 发现的 GPU，每块 GPU 注册为独立 `ggml_backend_dev_t`。llama.cpp 层初始化时为每个 GPU 创建一个 `ggml_backend_t`，全部传给 `ggml_backend_sched_new`。

---

## 9.6 buffer 与张量数据绑定

`ggml_tensor.data` 指针直接指向 buffer 内的裸地址。分配流程：

<svg viewBox="0 0 760 330" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Buffer and tensor data binding lifecycle in three stages">
  <defs>
    <marker id="ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="330" fill="#f8fafc" rx="8"/>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">buffer 与张量数据绑定的三个阶段</text>
  <rect x="30" y="36" width="700" height="70" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="55" y="57" text-anchor="start" font-size="12" font-weight="700" fill="#ea580c">① 权重加载</text>
  <text x="55" y="74" text-anchor="start" font-size="11" fill="#64748b">ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS)</text>
  <text x="55" y="90" text-anchor="start" font-size="10" fill="#94a3b8">→ 标记为权重 buffer，调度器 Pass 1 优先在拥有该 buffer 的后端执行相关算子</text>
  <line x1="380" y1="106" x2="380" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6)"/>
  <rect x="30" y="122" width="700" height="70" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="55" y="143" text-anchor="start" font-size="12" font-weight="700" fill="#7c3aed">② sched_alloc_graph 之后</text>
  <text x="55" y="160" text-anchor="start" font-size="11" fill="#64748b">每个计算中间张量的 .data 被 gallocr 填充为某后端 buffer 内的偏移地址</text>
  <text x="55" y="176" text-anchor="start" font-size="10" fill="#94a3b8">→ ggml_tensor.buffer 字段也被设置，供调度器后续判断归属后端</text>
  <line x1="380" y1="192" x2="380" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6)"/>
  <rect x="30" y="208" width="700" height="70" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="55" y="229" text-anchor="start" font-size="12" font-weight="700" fill="#0d9488">③ 跨后端 copy 时</text>
  <text x="55" y="246" text-anchor="start" font-size="11" fill="#64748b">input_cpy = tensor_copy(input, split_backend_id, cur_copy)</text>
  <text x="55" y="262" text-anchor="start" font-size="10" fill="#94a3b8">→ input_cpy-&gt;data 指向 split 目标后端 buffer 内的对应空间（view 继承 view_src.buffer）</text>
  <rect x="30" y="294" width="700" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="311" text-anchor="middle" font-size="10" fill="#64748b">ggml_backend_view_init：view 不拥有独立内存，data = view_src-&gt;data + offset，buffer 继承自 view_src</text>
</svg>
<span class="figure-caption">图 R9.6 ｜ buffer 与张量数据绑定的三个生命周期阶段</span>

<details>
<summary>ASCII 原版</summary>

```
1. llama_model 加载权重时：
   ggml_backend_buffer_set_usage(buf, GGML_BACKEND_BUFFER_USAGE_WEIGHTS)
   → 标记为权重 buffer，调度器将优先在拥有该 buffer 的后端执行相关算子

2. ggml_backend_sched_alloc_graph 执行后：
   每个计算中间张量的 .data 被 gallocr 填充为某后端 buffer 内的偏移地址
   → ggml_tensor.buffer 字段也被设置，供调度器后续判断

3. 跨后端 copy 时：
   input_cpy = tensor_copy(input, split_backend_id, cur_copy)
   input_cpy->data 指向 split 目标后端 buffer 内的对应空间
```

</details>

`ggml_backend_view_init`（`ggml/include/ggml-backend.h:423`）处理 view 张量：view 不拥有独立内存，其 `data = view_src->data + offset`，buffer 引用也继承自 `view_src`。

---

## 9.7 构建系统

### 9.7.1 库拆分策略

`ggml/src/CMakeLists.txt:192-242` 定义了两个核心目标：

| 目标 | 内容 | 说明 |
|---|---|---|
| `ggml-base` | `ggml.c`、`ggml-backend.cpp`、`ggml-alloc.c` 等 | 不含任何后端，纯接口实现 |
| `ggml` | `ggml-backend-dl.cpp`、`ggml-backend-reg.cpp` | 链接注册逻辑；静态时链接所有后端 |

各后端通过 `ggml_add_backend_library` 宏添加：

```cmake
# ggml/src/CMakeLists.txt:248-293
function(ggml_add_backend_library backend)
    if (GGML_BACKEND_DL)
        add_library(${backend} MODULE ${ARGN})  # 动态模块 .so/.dylib
        target_compile_definitions(${backend} PRIVATE GGML_BACKEND_DL)
    else()
        add_library(${backend} ${ARGN})          # 静态/共享库
        target_link_libraries(ggml PUBLIC ${backend})
    endif()
    target_link_libraries(${backend} PRIVATE ggml-base)
endfunction()
```

### 9.7.2 主要 CMake 选项

| 选项 | 默认 | 作用 |
|---|---|---|
| `GGML_CUDA` | OFF | 编译 CUDA 后端 |
| `GGML_METAL` | Apple 平台 ON | 编译 Metal 后端 |
| `GGML_METAL_EMBED_LIBRARY` | 同 `GGML_METAL` | 将 .metallib 嵌入二进制 |
| `GGML_VULKAN` | OFF | 编译 Vulkan 后端 |
| `GGML_SYCL` | OFF | 编译 SYCL/oneAPI 后端 |
| `GGML_BACKEND_DL` | OFF | 各后端编译为独立动态库 |
| `GGML_CPU_ALL_VARIANTS` | OFF | 生成多个 CPU 指令集变体 |
| `GGML_CUDA_GRAPHS` | OFF（可配） | CUDA Graph 捕获加速 |

当 `GGML_BACKEND_DL=OFF`（静态链接默认）时，`ggml-backend-reg.cpp` 的 `#ifdef GGML_USE_CUDA` 等条件分支直接调用后端的 `_reg()` 函数；当 `GGML_BACKEND_DL=ON` 时，这些宏未定义，所有注册通过 `ggml_backend_load_all()` 的动态加载路径完成。

### 9.7.3 后端 score 机制

每个动态库可实现 `ggml_backend_score()` 返回整数优先级（`ggml/src/ggml-backend-impl.h:238`）。0 表示当前硬件不支持（如 AVX-512 库在无 AVX-512 CPU 上）。`ggml_backend_load_best` 对所有匹配文件取最高分，从而在不同 CPU 微架构下自动选择最优实现。

---

## 9.8 关键文件索引

| 文件 | 作用 |
|---|---|
| `ggml/include/ggml-backend.h` | 全部公开 API |
| `ggml/src/ggml-backend-impl.h` | 内部接口结构体（`_i` vtable） |
| `ggml/src/ggml-backend.cpp` | buffer/device/stream/scheduler 实现 |
| `ggml/src/ggml-backend-reg.cpp` | 注册表与动态加载 |
| `ggml/src/ggml-cpu/ggml-cpu.cpp` | CPU backend 注册、graph_compute |
| `ggml/src/ggml-cpu/ggml-cpu.c` | threadpool、算子分发 switch |
| `ggml/src/ggml-cpu/ops.cpp` | CPU 算子实现 |
| `ggml/src/ggml-metal/ggml-metal.cpp` | Metal backend（含统一内存处理） |
| `ggml/src/ggml-cuda/ggml-cuda.cu` | CUDA backend（含 CUDA Graph） |
| `ggml/src/CMakeLists.txt` | 后端库编译规则 |
| `ggml/CMakeLists.txt` | 后端 CMake 选项定义 |
