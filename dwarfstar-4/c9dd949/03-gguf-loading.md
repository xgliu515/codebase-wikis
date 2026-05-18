# 第 3 章：GGUF 加载与模型初始化

**代码版本**：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [GGUF 文件格式概述](#1-gguf-文件格式概述)
2. [一次 mmap 加载](#2-一次-mmap-加载)
3. [元数据 KV 表解析](#3-元数据-kv-表解析)
4. [张量目录解析](#4-张量目录解析)
5. [张量类型与形状校验](#5-张量类型与形状校验)
6. [语义元数据校验](#6-语义元数据校验)
7. [张量名绑定到固定层布局](#7-张量名绑定到固定层布局)
8. [可选 warm-up](#8-可选-warm-up)
9. [mmap 与后端的关系](#9-mmap-与后端的关系)

---

## 1. GGUF 文件格式概述

GGUF 是 llama.cpp 生态中广泛使用的模型文件格式，版本 3（ds4 只接受 v3）。文件从低地址到高地址由四个逻辑区域构成：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GGUF file binary layout with four regions: header, KV metadata, tensor directory, and tensor data">
  <defs>
    <marker id="ar-r3-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="20" width="400" height="48" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="260" y="40" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">Header（24 bytes）</text>
  <text x="260" y="58" font-size="11" fill="#64748b" text-anchor="middle">magic=0x46554747  version=3  n_tensors  n_kv</text>
  <rect x="60" y="84" width="400" height="48" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="260" y="104" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">KV 元数据表</text>
  <text x="260" y="122" font-size="11" fill="#64748b" text-anchor="middle">n_kv 条 key-type-value，变长，紧跟 header</text>
  <rect x="60" y="148" width="400" height="48" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="260" y="168" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">张量目录</text>
  <text x="260" y="186" font-size="11" fill="#64748b" text-anchor="middle">n_tensors 条（name, ndim, dim[], type, rel_offset）</text>
  <rect x="60" y="212" width="400" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="260" y="231" font-size="11" fill="#94a3b8" text-anchor="middle">对齐填充（补齐到 general.alignment，默认 32 字节）</text>
  <rect x="60" y="256" width="400" height="48" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="260" y="276" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">张量数据区</text>
  <text x="260" y="294" font-size="11" fill="#64748b" text-anchor="middle">所有张量的原始字节，不经过任何解压，直接 mmap</text>
  <line x1="480" y1="44" x2="560" y2="44" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-1)"/>
  <text x="568" y="40" font-size="10" fill="#64748b">低地址</text>
  <line x1="480" y1="280" x2="560" y2="280" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-1)"/>
  <text x="568" y="276" font-size="10" fill="#64748b">高地址</text>
  <line x1="595" y1="52" x2="595" y2="272" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-r3-1)"/>
</svg>
<span class="figure-caption">图 R3.1 ｜ GGUF v3 文件二进制布局：四个逻辑区域从低到高依次排列</span>

<details>
<summary>ASCII 原版</summary>

```
+---------------------+
|  Header (24 bytes)  |  magic=0x46554747 ("GGUF"), version, n_tensors, n_kv
+---------------------+
|  KV 元数据表         |  n_kv 条 key-type-value，变长，紧跟 header
+---------------------+
|  张量目录            |  n_tensors 条 (name, ndim, dim[], type, rel_offset)
+---------------------+
|  [对齐填充]          |  补齐到 general.alignment（默认 32 字节）
+---------------------+
|  张量数据区          |  所有张量的原始字节（不经过任何解压）
+---------------------+
```

</details>

Header 字段（`ds4.c:1229-1234`）：

```c
uint32_t magic;      /* 0x46554747 */
uint32_t version;    /* 必须为 3   */
uint64_t n_tensors;
uint64_t n_kv;
```

KV 值的类型枚举在 `ds4.c:834-848`，涵盖 UINT8/INT8/.../FLOAT64/BOOL/STRING/ARRAY 共 13 种，其中 STRING 和 ARRAY 是变长类型。张量目录中的 `rel_offset` 是相对于张量数据区起点的字节偏移，ds4 在加载时将其转换为绝对偏移（`abs_offset`）。

GGUF 的关键设计选择：**张量字节始终以量化原生格式存放于文件中，不经过二次压缩**。这使得 mmap 后能直接把文件内存范围传给 GPU，无需中间缓冲。

---

## 2. 一次 mmap 加载

### 入口函数

`ds4.c:1196` 的 `model_open()` 是整个模型加载的单一入口：

```c
/* ds4.c:1196 */
static void model_open(ds4_model *m, const char *path, bool metal_mapping,
                       bool prefetch_cpu) {
    memset(m, 0, sizeof(*m));
    m->fd = -1;

    int fd = open(path, O_RDONLY);
    ...
    struct stat st;
    fstat(fd, &st);
    ...
    const int mmap_flags = metal_mapping ? MAP_SHARED : MAP_PRIVATE;
    void *map = mmap(NULL, (size_t)st.st_size, PROT_READ, mmap_flags, fd, 0);
    ...
    m->fd = fd;
    m->map = map;
    m->size = (uint64_t)st.st_size;
    ...
    parse_metadata(m, &c);
    parse_tensors(m, &c);

    if (!metal_mapping && prefetch_cpu) model_prefetch_cpu_mapping(m);
}
```

调用点在 `ds4.c:17190`：

```c
const bool graph_backend = ds4_backend_uses_graph(opt->backend);
model_open(&e->model, opt->model_path, graph_backend, true);
```

`graph_backend` 为 true 时表示使用 Metal 或 CUDA，此时选 `MAP_SHARED`；CPU 后端选 `MAP_PRIVATE`。

### 为什么用 mmap

DeepSeek V4 Flash 量化模型（IQ2_XXS + Q8_0 组合）大约 80-90 GiB。直接 `read()` 进入私有堆会：

1. 需要同等大小的物理 RAM 预留；
2. 文件→内核页缓存→用户缓冲区 双重拷贝，浪费内存带宽；
3. 无法利用操作系统的文件缓存共享。

mmap 的优势：

- **按需分页**：OS 仅在第一次访问某个 4K 页时触发缺页中断，通过 `readahead` 机制流水线预取；
- **零拷贝路径**（Metal）：共享映射的物理页可直接被 GPU 读取，不需要 `cudaMemcpy` 或 `newBuffer(bytes:)`；
- **内核统一管理**：在内存压力下可被 OS 直接回收（文件页缓存），不会触发 OOM。

### MAP_SHARED vs MAP_PRIVATE 的选择

`ds4.c:1192-1220` 的注释明确解释了拆分策略：

```text
Metal 把此映射的切片包装成 no-copy MTLBuffer，所以 Metal 路径
保留文件级共享映射（MAP_SHARED）。CPU 路径只通过普通指针读取
权重，不应继承 Metal 的 VM 策略：改用私有只读映射（MAP_PRIVATE）。

这样设计是为了防御一个在 Darwin 内核中观察到的 VM bug：当 CPU
后端通过共享 mmap 流式读取超大 GGUF 时，内核可能在 VM map 计数
管理中 panic，而不是返回用户态错误。CPU 走私有映射规避了该路径。
```

---

## 3. 元数据 KV 表解析

### 数据结构

`ds4_model` 结构（`ds4.c:915-928`）持有 KV 表：

```c
typedef struct {
    int fd;
    const uint8_t *map;
    uint64_t size;

    uint32_t version;
    uint64_t n_kv;
    uint64_t n_tensors;
    uint64_t alignment;
    uint64_t tensor_data_pos;

    ds4_kv     *kv;        /* 堆上的 KV 索引数组，值不复制 */
    ds4_tensor *tensors;   /* 堆上的张量元数据数组 */
} ds4_model;
```

每条 KV 记录（`ds4.c:898-903`）：

```c
typedef struct {
    ds4_str  key;         /* ptr 指向 mmap 内，不复制 */
    uint32_t type;        /* GGUF_VALUE_* 枚举 */
    uint64_t value_pos;   /* 值在 mmap 中的绝对字节偏移 */
} ds4_kv;
```

### parse_metadata 实现

`ds4.c:1111-1139` 的 `parse_metadata()` 是 KV 解析的核心：

```c
/* ds4.c:1111-1139 */
static void parse_metadata(ds4_model *m, ds4_cursor *c) {
    m->kv = calloc((size_t)m->n_kv, sizeof(m->kv[0]));
    ...
    m->alignment = 32;  /* 默认对齐 */

    for (uint64_t i = 0; i < m->n_kv; i++) {
        ds4_kv *kv = &m->kv[i];

        if (!cursor_string(c, &kv->key)) ds4_die(c->error);
        if (!cursor_u32(c, &kv->type))   ds4_die(c->error);

        kv->value_pos = c->pos;   /* 只记录偏移，值留在 mmap */

        /* 特殊处理 alignment 键——它影响张量数据区定位 */
        if (ds4_streq(kv->key, "general.alignment") &&
            kv->type == GGUF_VALUE_UINT32)
        {
            ds4_cursor tmp = cursor_at(m, kv->value_pos);
            uint32_t alignment;
            if (cursor_u32(&tmp, &alignment) && alignment != 0)
                m->alignment = alignment;
        }

        if (!skip_value(c, kv->type, 0)) ds4_die(c->error);
    }
}
```

**设计要点**：值本身不被复制——`kv->value_pos` 只是文件内的偏移。后续所有通过 `model_get_u32()` / `required_u32()` 等辅助函数读取的元数据都是**懒惰求值**：从 `value_pos` 创建一个临时 `ds4_cursor`，在 mmap 内解析出来。这使得 KV 索引数组本身极其轻量（仅指针+类型+偏移，每条约 32 字节），与模型文件大小无关。

`skip_value()` 处理变长类型（STRING 读取 uint64_t 长度字段再跳过内容；ARRAY 递归处理每个元素），确保游标正确推进到下一条 KV。

---

## 4. 张量目录解析

### parse_tensors 实现

`ds4.c:1141-1190` 的 `parse_tensors()` 完成三件事：读取元数据、计算字节数、将相对偏移转换为绝对偏移。

```c
/* ds4.c:1141-1190 */
static void parse_tensors(ds4_model *m, ds4_cursor *c) {
    m->tensors = calloc((size_t)m->n_tensors, sizeof(m->tensors[0]));
    ...
    for (uint64_t i = 0; i < m->n_tensors; i++) {
        ds4_tensor *t = &m->tensors[i];

        cursor_string(c, &t->name);    /* ptr 指向 mmap */
        cursor_u32(c, &t->ndim);

        t->elements = 1;
        for (uint32_t d = 0; d < t->ndim; d++) {
            cursor_u64(c, &t->dim[d]);
            t->elements *= t->dim[d];  /* 带溢出检查 */
        }

        cursor_u32(c, &t->type);
        cursor_u64(c, &t->rel_offset);

        tensor_nbytes(t->type, t->elements, &t->bytes);
    }

    /* 张量数据区起点：张量目录末尾对齐到 m->alignment */
    m->tensor_data_pos = align_up(c->pos, m->alignment);

    /* 第二遍：rel_offset -> abs_offset，同时做越界检查 */
    for (uint64_t i = 0; i < m->n_tensors; i++) {
        ds4_tensor *t = &m->tensors[i];
        t->abs_offset = m->tensor_data_pos + t->rel_offset;
        /* 越界检查... */
    }
}
```

`ds4_tensor` 结构（`ds4.c:904-913`）：

```c
typedef struct {
    ds4_str  name;          /* ptr 指向 mmap */
    uint32_t ndim;
    uint64_t dim[DS4_MAX_DIMS];
    uint32_t type;
    uint64_t rel_offset;    /* GGUF 文件内相对张量数据区的偏移 */
    uint64_t abs_offset;    /* mmap 内绝对字节偏移（计算得出） */
    uint64_t elements;
    uint64_t bytes;
} ds4_tensor;
```

### in-place 张量数据访问

`ds4.c:1471-1473` 的 `tensor_data()` 是推理代码访问权重字节的唯一入口：

```c
/* ds4.c:1471 */
static const void *tensor_data(const ds4_model *m, const ds4_tensor *t) {
    return m->map + t->abs_offset;
}
```

这是关键的零拷贝保证：返回的指针直接指向 mmap 内存，没有任何数据复制。对于 Metal 后端，这块内存恰好被 `newBufferWithBytesNoCopy` 包装成 MTLBuffer（见第 9 节）；对于 CPU 后端，推理内核直接读取此指针。

### 常见张量类型字节数

GGUF 类型表（`ds4.c:856-886`）：

```text
类型        块大小    块字节数     bits/weight
q8_0         32        34         8.5
q2_K        256        84         2.625
q4_K        256       144         4.5
iq2_xxs     256        66         2.0625
q8_K        256       292         9.125
f16           1         2         16.0
f32           1         4         32.0
```

---

## 5. 张量类型与形状校验

`weights_validate_layout()`（`ds4.c:2355-2426`）在绑定完成后立即被调用，对每个张量进行精确的类型 + 维度校验。校验失败立即 `exit(1)`，没有降级逻辑。

### 校验逻辑结构

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="weights_validate_layout call tree showing global tensors and per-layer tensor validation branches">
  <defs>
    <marker id="ar-r3-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="12" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="35" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">weights_validate_layout()</text>
  <line x1="380" y1="48" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="180" y1="68" x2="580" y2="68" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="190" y1="68" x2="190" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="570" y1="68" x2="570" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <rect x="90" y="88" width="200" height="44" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="190" y="107" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">全局张量</text>
  <text x="190" y="122" font-size="10" fill="#64748b" text-anchor="middle">token_embd / output_norm / output</text>
  <rect x="370" y="88" width="400" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="570" y="107" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">逐层 il = 0..42</text>
  <text x="570" y="122" font-size="10" fill="#64748b" text-anchor="middle">tensor_expect_layout(t, type, ndim, d0, d1, d2)</text>
  <line x1="570" y1="132" x2="570" y2="152" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="420" y1="152" x2="720" y2="152" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="430" y1="152" x2="430" y2="168" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="520" y1="152" x2="520" y2="168" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="620" y1="152" x2="620" y2="168" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <line x1="710" y1="152" x2="710" y2="168" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-2)"/>
  <rect x="360" y="168" width="140" height="56" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="430" y="187" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">注意力权重</text>
  <text x="430" y="202" font-size="10" fill="#64748b" text-anchor="middle">q_a / q_b / kv</text>
  <text x="430" y="215" font-size="10" fill="#64748b" text-anchor="middle">output_a/b — Q8_0</text>
  <rect x="450" y="168" width="140" height="56" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="520" y="187" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">压缩器权重</text>
  <text x="520" y="202" font-size="10" fill="#64748b" text-anchor="middle">ratio != 0 的层</text>
  <text x="520" y="215" font-size="10" fill="#64748b" text-anchor="middle">F16</text>
  <rect x="550" y="168" width="140" height="56" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="620" y="187" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">FFN 路由张量</text>
  <text x="620" y="202" font-size="10" fill="#64748b" text-anchor="middle">gate/up/down_exps</text>
  <text x="620" y="215" font-size="10" fill="#dc2626" text-anchor="middle">IQ2_XXS|Q2_K|Q4_K</text>
  <rect x="640" y="168" width="140" height="56" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="710" y="187" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">共享专家</text>
  <text x="710" y="202" font-size="10" fill="#64748b" text-anchor="middle">gate/up/down_shexp</text>
  <text x="710" y="215" font-size="10" fill="#64748b" text-anchor="middle">Q8_0</text>
  <rect x="90" y="148" width="200" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="190" y="163" font-size="10" fill="#64748b" text-anchor="middle">tensor_expect_layout()</text>
  <text x="190" y="176" font-size="10" fill="#64748b" text-anchor="middle">类型/维度不符 → exit(1)</text>
  <text x="620" y="252" font-size="10" fill="#64748b" text-anchor="middle">tensor_expect_routed_expert()</text>
  <text x="620" y="266" font-size="10" fill="#64748b" text-anchor="middle">三选一量化，gate=up 类型</text>
</svg>
<span class="figure-caption">图 R3.2 ｜ weights_validate_layout() 调用树：全局张量与 43 层张量的类型/维度校验分支</span>

<details>
<summary>ASCII 原版</summary>

```
weights_validate_layout()
  ├── 全局张量（token_embd, output_norm 等）
  │     tensor_expect_layout(t, type, ndim, d0, d1, d2)
  └── 逐层（il = 0..42）
        ├── 注意力权重（q_a, q_b, kv, output_a/b 等）——Q8_0
        ├── 压缩器权重（ratio != 0 时）——F16
        ├── 索引器权重（ratio == 4 时）——F16
        ├── FFN 路由张量（gate_exps/up_exps/down_exps）
        │     tensor_expect_routed_expert()
        │     允许 IQ2_XXS / Q2_K / Q4_K 三选一
        └── 共享专家（gate_shexp/up_shexp/down_shexp）——Q8_0
```

</details>

`tensor_expect_layout()` 对比类型枚举和每个维度，均不符合则打印详细错误（`ds4.c:2322-2352`）。

### 路由专家的特殊处理

路由专家张量（`ffn_gate_exps`, `ffn_up_exps`, `ffn_down_exps`）允许三种量化类型之一（`ds4.c:2295-2298`）：

```c
static bool tensor_is_routed_expert_type(uint32_t type) {
    return type == DS4_TENSOR_IQ2_XXS ||
           type == DS4_TENSOR_Q2_K    ||
           type == DS4_TENSOR_Q4_K;
}
```

同时要求 gate 和 up 张量的类型必须相同（`ds4.c:2415-2418`），否则后续推理内核无法统一分派。

### 关键常量与期望维度

```text
DS4_N_LAYER   = 43    layers
DS4_N_EMBD    = 4096  embedding dim
DS4_N_VOCAB   = 129280
DS4_N_HEAD    = 64
DS4_N_HEAD_DIM = 512
DS4_N_LORA_Q  = 1024
DS4_N_EXPERT  = 256
DS4_N_FF_EXP  = 2048
DS4_N_HC      = 4     hyper-connection 宽度
```

校验代码中的期望维度直接用这些宏计算，如 `attn_q_b` 期望形状为 `[DS4_N_LORA_Q, DS4_N_HEAD * DS4_N_HEAD_DIM]`（`ds4.c:2380`），维度不对立即报错。

---

## 6. 语义元数据校验

`config_validate_model()`（`ds4.c:2562-2646`）在形状校验之后执行，读取所有影响推理语义的元数据键值并与编译时常量比对。

### 校验范围一览

```c
/* ds4.c:2562-2646（节选） */
config_expect_u32("embedding_length",       n_embd,         DS4_N_EMBD);
config_expect_u32("attention.head_count",   n_head,         DS4_N_HEAD);
config_expect_u32("attention.key_length",   n_head_dim,     DS4_N_HEAD_DIM);
config_expect_u32("expert_count",           n_expert,       DS4_N_EXPERT);
config_expect_u32("expert_used_count",      n_expert_used,  DS4_N_EXPERT_USED);
config_expect_u32("hash_layer_count",       n_hash_layer,   DS4_N_HASH_LAYER);
config_expect_u32("attention.sliding_window",n_swa,         DS4_N_SWA);
config_expect_u32("attention.indexer.head_count", n_indexer_head, DS4_N_INDEXER_HEAD);
config_expect_u32("hyper_connection.count", n_hc,           DS4_N_HC);
config_expect_f32("rope.freq_base",         rope_freq_base, DS4_ROPE_FREQ_BASE);
config_expect_f32("rope.scaling.factor",    rope_scale,     DS4_ROPE_SCALE_FACTOR);
config_expect_f32("expert_weights_scale",   ew_scale,       DS4_EXPERT_WEIGHT_SCALE);
```

另外还调用两个子校验函数：

- `validate_compress_ratio_metadata()`（`ds4.c:2474`）：读取 `deepseek4.attention.compress_ratios` 数组，逐层检查每一层的压缩比是否等于 `ds4_layer_compress_ratio(il)` 的返回值（`ds4.c:411-414`）：
  - 层 0-1：ratio = 0（无压缩）
  - 偶数层 >= 2：ratio = 4
  - 奇数层 >= 2：ratio = 128

- `validate_swiglu_clamp_metadata()`（`ds4.c:2510`）：读取 `deepseek4.swiglu_clamp_exp` 数组，确认每层的 SwiGLU 指数钳制值均等于编译常量 `DS4_SWIGLU_CLAMP_EXP = 10.0`。

### 设计理由

ds4 是专为单一模型定制的引擎，所有超参数已被编译进二进制文件。运行时元数据校验的作用是**防止意外加载非 DeepSeek V4 Flash 模型**——如果有人把另一个 GGUF 文件指向 ds4，校验会在推理开始前终止，而不是产生静默错误的输出。`config_expect_u32()` 在不匹配时直接 `exit(1)` 并打印具体字段和期望值（`ds4.c:2536-2540`），便于诊断。

---

## 7. 张量名绑定到固定层布局

### 设计动机

GGUF 张量目录是一个扁平的字符串→张量的映射。推理内核如果每次矩阵乘法都要按名字查找张量，O(n) 线性扫描在 43 层、每层约 20 个张量的情况下会产生可观的开销。

ds4 的做法是"绑定一次"：在 `weights_bind()`（`ds4.c:2648`）中一次性把所有张量名查找完成，结果存入 `ds4_weights` / `ds4_layer_weights` 的指针字段。此后推理代码完全通过结构体指针访问权重，**无运行时字符串查找**。

### weights_bind 实现节选

```c
/* ds4.c:2648 */
static void weights_bind(ds4_weights *w, const ds4_model *m) {
    memset(w, 0, sizeof(*w));
    w->token_embd  = required_tensor(m, "token_embd.weight");
    w->output_norm = required_tensor(m, "output_norm.weight");
    w->output      = required_tensor(m, "output.weight");
    ...
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        ds4_layer_weights *l = &w->layer[il];
        const uint32_t compress_ratio = ds4_layer_compress_ratio(il);

        l->attn_q_a      = required_tensorf(m, "blk.%u.attn_q_a.weight", il);
        l->attn_q_b      = required_tensorf(m, "blk.%u.attn_q_b.weight", il);
        l->attn_kv       = required_tensorf(m, "blk.%u.attn_kv.weight", il);
        ...
        l->ffn_gate_exps = required_tensorf(m, "blk.%u.ffn_gate_exps.weight", il);
        l->ffn_up_exps   = required_tensorf(m, "blk.%u.ffn_up_exps.weight", il);
        l->ffn_down_exps = required_tensorf(m, "blk.%u.ffn_down_exps.weight", il);

        if (compress_ratio != 0) {
            l->attn_compressor_kv = required_tensorf(m, "blk.%u.attn_compressor_kv.weight", il);
            ...
        }
        if (compress_ratio == 4) {
            l->indexer_attn_q_b = required_tensorf(m, "blk.%u.indexer.attn_q_b.weight", il);
            ...
        }
        ...
    }
    weights_validate_layout(w);  /* 绑定后立即校验 */
}
```

### 层张量布局速查

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="ds4_layer_weights tensor groups per layer: HC hyper-connection, attention, compressor, indexer, and FFN">
  <defs>
    <marker id="ar-r3-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="8" width="200" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="28" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">ds4_layer_weights（43 层）</text>
  <line x1="380" y1="38" x2="380" y2="55" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="80" y1="55" x2="680" y2="55" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="80" y1="55" x2="80" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-3)"/>
  <line x1="230" y1="55" x2="230" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-3)"/>
  <line x1="380" y1="55" x2="380" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-3)"/>
  <line x1="530" y1="55" x2="530" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-3)"/>
  <line x1="680" y1="55" x2="680" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-3)"/>
  <rect x="20" y="68" width="120" height="96" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="80" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">HC 超连接</text>
  <text x="80" y="102" font-size="10" fill="#64748b" text-anchor="middle">hc_attn_fn</text>
  <text x="80" y="116" font-size="10" fill="#64748b" text-anchor="middle">hc_attn_scale</text>
  <text x="80" y="130" font-size="10" fill="#64748b" text-anchor="middle">hc_attn_base</text>
  <text x="80" y="144" font-size="10" fill="#64748b" text-anchor="middle">hc_ffn_fn/scale/base</text>
  <text x="80" y="158" font-size="10" fill="#94a3b8" text-anchor="middle">F16/F32</text>
  <rect x="167" y="68" width="126" height="132" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="230" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">注意力</text>
  <text x="230" y="102" font-size="10" fill="#64748b" text-anchor="middle">attn_norm (F32)</text>
  <text x="230" y="116" font-size="10" fill="#64748b" text-anchor="middle">attn_q_a Q8_0 [4096,1024]</text>
  <text x="230" y="130" font-size="10" fill="#64748b" text-anchor="middle">attn_q_b Q8_0 [1024,32768]</text>
  <text x="230" y="144" font-size="10" fill="#64748b" text-anchor="middle">attn_kv Q8_0 [4096,512]</text>
  <text x="230" y="158" font-size="10" fill="#64748b" text-anchor="middle">attn_kv_a_norm / sinks</text>
  <text x="230" y="172" font-size="10" fill="#64748b" text-anchor="middle">attn_output_a/b Q8_0</text>
  <text x="230" y="192" font-size="10" fill="#94a3b8" text-anchor="middle">全部 43 层</text>
  <rect x="317" y="68" width="126" height="108" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="380" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">压缩器</text>
  <text x="380" y="102" font-size="10" fill="#64748b" text-anchor="middle">attn_compressor_kv</text>
  <text x="380" y="116" font-size="10" fill="#64748b" text-anchor="middle">gate / ape / norm</text>
  <text x="380" y="130" font-size="10" fill="#64748b" text-anchor="middle">F16 / F32</text>
  <text x="380" y="150" font-size="10" fill="#7c3aed" text-anchor="middle">ratio != 0 的层</text>
  <text x="380" y="164" font-size="10" fill="#94a3b8" text-anchor="middle">（il≥2，偶/奇交替）</text>
  <rect x="467" y="68" width="126" height="108" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1" stroke-dasharray="4,2"/>
  <text x="530" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">索引器</text>
  <text x="530" y="102" font-size="10" fill="#64748b" text-anchor="middle">indexer_attn_q_b</text>
  <text x="530" y="116" font-size="10" fill="#64748b" text-anchor="middle">proj</text>
  <text x="530" y="130" font-size="10" fill="#64748b" text-anchor="middle">compressor_*</text>
  <text x="530" y="148" font-size="10" fill="#64748b" text-anchor="middle">F16</text>
  <text x="530" y="164" font-size="10" fill="#7c3aed" text-anchor="middle">ratio == 4 的层</text>
  <rect x="617" y="68" width="126" height="180" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="680" y="86" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">FFN</text>
  <text x="680" y="102" font-size="10" fill="#64748b" text-anchor="middle">ffn_norm (F32)</text>
  <text x="680" y="116" font-size="10" fill="#64748b" text-anchor="middle">ffn_gate_inp F16 [4096,256]</text>
  <text x="680" y="130" font-size="10" fill="#64748b" text-anchor="middle">ffn_gate/up_exps</text>
  <text x="680" y="144" font-size="10" fill="#dc2626" text-anchor="middle">IQ2_XXS|Q2_K|Q4_K</text>
  <text x="680" y="158" font-size="10" fill="#64748b" text-anchor="middle">ffn_down_exps [2048,4096,256]</text>
  <text x="680" y="172" font-size="10" fill="#64748b" text-anchor="middle">ffn_gate/up/down_shexp Q8_0</text>
  <text x="680" y="188" font-size="10" fill="#64748b" text-anchor="middle">ffn_exp_probs_b (可选)</text>
  <text x="680" y="202" font-size="10" fill="#64748b" text-anchor="middle">ffn_gate_tid2eid I32</text>
  <text x="680" y="216" font-size="10" fill="#94a3b8" text-anchor="middle">（仅哈希层 il&lt;3）</text>
  <text x="680" y="238" font-size="10" fill="#94a3b8" text-anchor="middle">全部 43 层</text>
</svg>
<span class="figure-caption">图 R3.3 ｜ ds4_layer_weights 各张量组：HC 超连接、注意力、压缩器（条件）、索引器（条件）、FFN</span>

<details>
<summary>ASCII 原版</summary>

```
每层 ds4_layer_weights 包含的张量组（43 层，按层结构分）：

  HC 超连接：
    hc_attn_fn / hc_attn_scale / hc_attn_base  (F16/F32)
    hc_ffn_fn  / hc_ffn_scale  / hc_ffn_base   (F16/F32)

  注意力：
    attn_norm             (F32)
    attn_q_a              (Q8_0, [4096, 1024])
    attn_q_a_norm         (F32)
    attn_q_b              (Q8_0, [1024, 64*512])
    attn_kv               (Q8_0, [4096, 512])
    attn_kv_a_norm        (F32)
    attn_sinks            (F32)
    attn_output_a/b       (Q8_0)

  压缩器（ratio != 0 的层）：
    attn_compressor_kv / gate / ape / norm  (F16/F32)

  索引器（ratio == 4 的层）：
    indexer_attn_q_b / proj / compressor_*  (F16)

  FFN：
    ffn_norm              (F32)
    ffn_gate_inp          (F16, [4096, 256])  路由 logit
    ffn_exp_probs_b       (F32, 可选)
    ffn_gate_exps/up_exps (IQ2_XXS|Q2_K|Q4_K, [4096, 2048, 256])
    ffn_down_exps         (IQ2_XXS|Q2_K|Q4_K, [2048, 4096, 256])
    ffn_gate_shexp/up/down_shexp (Q8_0)
    ffn_gate_tid2eid      (I32, 仅哈希层 il<3)
```

</details>

`required_tensor()` 在找不到张量时调用 `ds4_die()`；`tensor_by_namef()` 仅用于可选张量，找不到返回 NULL（`exp_probs_b.bias` 使用此路径）。

---

## 8. 可选 warm-up

`model_warm_weights()`（`ds4.c:1477`）在 `model_open()` 之后、推理开始之前被可选调用（仅当 `opt->warm_weights == true`）：

```c
/* ds4.c:1477 */
static void model_warm_weights(const ds4_model *m) {
    const uint64_t start = m->tensor_data_pos;
    const uint64_t end   = m->size;
    const uint64_t page  = (uint64_t)sysconf(_SC_PAGESIZE);
    const uint8_t *p     = m->map;

    /* 先发出建议性预取 */
    posix_madvise((void *)(p + start), (size_t)(end - start), POSIX_MADV_WILLNEED);

    /* 逐页读取以强制触发缺页 */
    volatile uint64_t checksum = 0;
    for (uint64_t off = start; off < end; off += page)
        checksum += p[off];
    checksum += p[end - 1];
}
```

- 仅触碰**张量数据区**（`tensor_data_pos` 到文件末尾），跳过 header 和目录；
- `posix_madvise(POSIX_MADV_WILLNEED)` 向内核提前请求 I/O；
- 循环每页采样一个字节，保证每个页被实际映射到物理内存；
- `volatile` checksum 防止编译器优化掉此循环；
- 完成后打印耗时，校验和防止死代码消除。

**何时启用**：适合要求首 token 延迟稳定的批量 benchmark 场景。对话式推理通常不需要，因为对话流量随时间分散缺页开销。warm-up 对 CPU 路径尤其重要——CPU 推理直接读取 mmap 字节，缺页中断发生在关键路径上；Metal/CUDA 则在 GPU 图初始化时已经有独立的 warm 机制。

---

## 9. mmap 与后端的关系

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="mmap physical pages shared across CPU, Metal, and CUDA backends with different mapping strategies">
  <defs>
    <marker id="ar-r3-4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar-r3-4b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <rect x="295" y="8" width="170" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="24" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">GGUF 文件</text>
  <text x="380" y="40" font-size="10" fill="#64748b" text-anchor="middle">~25 GiB  DS4.gguf</text>
  <line x1="380" y1="48" x2="380" y2="68" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ar-r3-4b)"/>
  <text x="390" y="62" font-size="10" fill="#ea580c">MAP_SHARED / MAP_PRIVATE</text>
  <rect x="280" y="68" width="200" height="40" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="380" y="84" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">mmap 物理页</text>
  <text x="380" y="100" font-size="10" fill="#64748b" text-anchor="middle">内核统一管理，按需分页</text>
  <line x1="380" y1="108" x2="380" y2="128" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="128" x2="640" y2="128" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="120" y1="128" x2="120" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-4)"/>
  <line x1="380" y1="128" x2="380" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-4)"/>
  <line x1="640" y1="128" x2="640" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-4)"/>
  <rect x="20" y="148" width="200" height="88" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="120" y="167" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">CPU 后端</text>
  <text x="120" y="183" font-size="10" fill="#64748b" text-anchor="middle">MAP_PRIVATE</text>
  <text x="120" y="197" font-size="10" fill="#64748b" text-anchor="middle">tensor_data() 直接读指针</text>
  <text x="120" y="211" font-size="10" fill="#64748b" text-anchor="middle">POSIX_MADV_WILLNEED</text>
  <text x="120" y="225" font-size="10" fill="#94a3b8" text-anchor="middle">规避 Darwin VM bug</text>
  <rect x="270" y="148" width="220" height="104" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="167" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">Metal 后端（本 trace）</text>
  <text x="380" y="183" font-size="10" fill="#64748b" text-anchor="middle">MAP_SHARED</text>
  <text x="380" y="197" font-size="10" fill="#64748b" text-anchor="middle">newBufferWithBytesNoCopy()</text>
  <text x="380" y="211" font-size="10" fill="#64748b" text-anchor="middle">MTLResourceStorageModeShared</text>
  <text x="380" y="225" font-size="10" fill="#16a34a" text-anchor="middle">零拷贝，CPU+GPU 共享物理页</text>
  <text x="380" y="241" font-size="10" fill="#94a3b8" text-anchor="middle">ds4_metal.m:466</text>
  <rect x="540" y="148" width="200" height="120" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="640" y="167" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">CUDA 后端</text>
  <text x="640" y="183" font-size="10" fill="#64748b" text-anchor="middle">cudaHostRegister() (优先)</text>
  <text x="640" y="197" font-size="10" fill="#16a34a" text-anchor="middle">pinned 内存 → 设备指针</text>
  <text x="640" y="213" font-size="10" fill="#64748b" text-anchor="middle">——若 ATS/HMM 不支持——</text>
  <text x="640" y="227" font-size="10" fill="#dc2626" text-anchor="middle">cudaMalloc + cudaMemcpy</text>
  <text x="640" y="243" font-size="10" fill="#94a3b8" text-anchor="middle">ds4_cuda.cu:242</text>
  <text x="640" y="261" font-size="10" fill="#94a3b8" text-anchor="middle">兜底路径</text>
</svg>
<span class="figure-caption">图 R3.4 ｜ mmap 物理页被三种后端以不同策略访问：CPU 直接指针、Metal 零拷贝 MTLBuffer、CUDA 分级注册</span>

<details>
<summary>ASCII 原版</summary>

```
GGUF 文件
     |
     | MAP_SHARED (Metal/CUDA)
     | MAP_PRIVATE (CPU)
     v
  mmap 物理页
     |
     +------ CPU 后端 --------> tensor_data() 直接读指针
     |
     +------ Metal 后端 ------> newBufferWithBytesNoCopy()
     |         ds4_metal.m:466     把整个映射切片为 MTLBuffer 视图
     |         MTLResourceStorageModeShared
     |         无需复制，GPU 和 CPU 共享同一物理页
     |
     +------ CUDA 后端 -------> cudaHostRegister() (ds4_cuda.cu:242)
               如果 ATS/HMM 支持：注册为设备可访问的 pinned 内存
               不支持时：cudaMemcpy 拷贝到设备显存（cudaMalloc）
```

</details>

### Metal 零拷贝机制

`ds4_metal.m:466` 核心逻辑：

```objc
id<MTLBuffer> buffer =
    [g_device newBufferWithBytesNoCopy:(void *)(model_addr + offset)
                                length:(NSUInteger)view_bytes
                               options:MTLResourceStorageModeShared
                           deallocator:nil];
```

Metal 的 `MTLResourceStorageModeShared` 表示 CPU 和 GPU 共享同一物理地址空间（Apple Silicon 统一内存），因此文件页缓存可以直接被 GPU 读取。此调用**不触发任何数据复制**，只是告知 Metal 框架这段虚拟地址范围的 GPU 访问权限。

由于 Metal 的 `maxBufferLength` 有限制，`ds4_metal.m` 将整个模型映射分割为若干个相互重叠（overlap）的视图窗口，每个视图单独注册为 MTLBuffer，推理内核通过 buffer+offset 访问任意张量。

### CUDA 的分级策略

CUDA 后端（`ds4_cuda.cu:228-294`）尝试以下策略，按优先级降序：

1. **已注册缓存命中**：如果该偏移范围已在 `g_model_ranges` 中，直接返回设备指针；
2. **文件描述符缓存**（`DS4_CUDA_NO_FD_CACHE` 未设置时）；
3. **cudaHostRegister 映射**：把 mmap 页标记为 pinned + mapped，通过 `cudaHostGetDevicePointer` 获得设备指针——零拷贝但 GPU 每次访问都走 PCIe；
4. **cudaMalloc + cudaMemcpy 上传**：ATS/HMM 不支持时的兜底路径。

对于 MacBook 上的 ds4 实际用例（96GB/128GB 统一内存 M 系列芯片），Metal 路径因统一内存架构天然是零拷贝，无 PCIe 瓶颈。

### CPU prefetch

CPU 后端在 `model_open()` 末尾（`ds4.c:1241`）调用 `model_prefetch_cpu_mapping()`（`ds4.c:1087`）：用 `posix_madvise(POSIX_MADV_WILLNEED)` 提前向内核请求将整个文件预取到页缓存，防止 Darwin VM 在推理 decode 阶段遇到专家权重缺页时触发已知的 map-count 内核 panic。

---

## 加载初始化全流程

<svg viewBox="0 0 640 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full model loading initialization flow from ds4_engine_open through model_open, warm weights, validate, bind, and GPU graph init">
  <defs>
    <marker id="ar-r3-5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="190" y="10" width="260" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="26" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">ds4_engine_open()</text>
  <text x="320" y="40" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:17189</text>
  <line x1="320" y1="46" x2="320" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="140" y="62" width="360" height="36" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="78" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">model_open()</text>
  <text x="320" y="92" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:1196</text>
  <line x1="320" y1="98" x2="320" y2="112" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="160" y1="112" x2="480" y2="112" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="190" y1="112" x2="190" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <line x1="290" y1="112" x2="290" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <line x1="390" y1="112" x2="390" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <line x1="470" y1="112" x2="470" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="130" y="122" width="120" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="190" y="140" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">open() + fstat()</text>
  <text x="190" y="156" font-size="10" fill="#64748b" text-anchor="middle">+ mmap()</text>
  <rect x="230" y="122" width="120" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="290" y="138" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">parse_metadata()</text>
  <text x="290" y="152" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:1111</text>
  <text x="290" y="162" font-size="10" fill="#94a3b8" text-anchor="middle">KV 偏移索引</text>
  <rect x="330" y="122" width="120" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="390" y="138" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">parse_tensors()</text>
  <text x="390" y="152" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:1141</text>
  <text x="390" y="162" font-size="10" fill="#94a3b8" text-anchor="middle">目录+绝对偏移</text>
  <rect x="410" y="122" width="120" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,2"/>
  <text x="470" y="138" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">prefetch_cpu</text>
  <text x="470" y="152" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:1087</text>
  <text x="470" y="162" font-size="10" fill="#94a3b8" text-anchor="middle">CPU only</text>
  <line x1="320" y1="166" x2="320" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="140" y="186" width="360" height="44" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,2"/>
  <text x="320" y="205" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">model_warm_weights()</text>
  <text x="320" y="221" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:1477  ·  若 warm_weights=true，逐页触发缺页</text>
  <line x1="320" y1="230" x2="320" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="140" y="250" width="360" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="269" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">config_validate_model()</text>
  <text x="320" y="285" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2564  ·  RoPE / 专家数 / HC 等语义元数据校验</text>
  <line x1="320" y1="294" x2="320" y2="314" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="140" y="314" width="360" height="60" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="333" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">weights_bind()</text>
  <text x="320" y="349" font-size="10" fill="#64748b" text-anchor="middle">ds4.c:2650  ·  张量名字符串 → 固定指针</text>
  <text x="320" y="365" font-size="10" fill="#94a3b8" text-anchor="middle">↳ weights_validate_layout()  ds4.c:2357</text>
  <line x1="320" y1="374" x2="320" y2="394" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-r3-5)"/>
  <rect x="140" y="394" width="360" height="44" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="4,2"/>
  <text x="320" y="413" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">GPU 图初始化</text>
  <text x="320" y="429" font-size="10" fill="#64748b" text-anchor="middle">Metal / CUDA 后端专属  ·  MTLBuffer / cuGraph</text>
  <text x="320" y="460" font-size="10" fill="#94a3b8" text-anchor="middle">虚线框 = 条件执行</text>
  <text x="320" y="478" font-size="10" fill="#94a3b8" text-anchor="middle">实线框 = 必须执行</text>
</svg>
<span class="figure-caption">图 R3.5 ｜ 加载初始化全流程：从 ds4_engine_open 到 GPU 图初始化的六个阶段</span>

<details>
<summary>ASCII 原版</summary>

```
ds4_engine_open()           ds4.c:17189
    |
    |-- model_open()        ds4.c:1196
    |       |-- open() + fstat()
    |       |-- mmap(MAP_SHARED or MAP_PRIVATE)
    |       |-- parse_metadata()       ds4.c:1111  KV 偏移索引
    |       |-- parse_tensors()        ds4.c:1141  目录+绝对偏移
    |       `-- model_prefetch_cpu_mapping()  (CPU only)
    |
    |-- model_warm_weights()           ds4.c:1477  (若 warm_weights=true)
    |
    |-- config_validate_model()        ds4.c:2564  语义元数据校验
    |
    |-- weights_bind()                 ds4.c:2650  名字→指针一次绑定
    |       `-- weights_validate_layout()   ds4.c:2357  类型+形状校验
    |
    `-- [GPU 图初始化，Metal/CUDA 后端专属]
```

</details>

---

**参考章节**：[第 4 章：特化 2-bit 量化与 imatrix](./04-quantization.md)
