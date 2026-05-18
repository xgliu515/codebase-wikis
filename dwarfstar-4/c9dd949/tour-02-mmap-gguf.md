# Trace 步骤 02 —— 几十 GiB 的模型文件，怎么不爆内存就打开？

## 1. 当前情境

步骤 01 结束后，`cli_config` 已经填好：

```
engine.model_path = "DS4.gguf"
engine.backend    = DS4_BACKEND_METAL   (Apple Silicon)
gen.n_predict     = 3
```

`main()` 把这份配置交给 `ds4_engine_open()`，后者的第一件事就是打开模型文件。
DS4.gguf 是 DeepSeek V4 Flash 的权重包，文件体量在 20–30 GiB 量级。
此刻进程刚起，内存里什么都没有——没有张量，没有分词器，没有 Metal 缓冲。
唯一拥有的是一个路径字符串 `"DS4.gguf"` 和操作系统提供的文件系统调用。

调用栈从 `model_open()` 进入（`ds4.c:1196`），它负责把这个路径变成一份可索引的
`ds4_model`：知道文件多大、元数据在哪里、张量目录在哪里、每个张量的字节从哪里到哪里。

## 2. 问题

这一步要解决的核心矛盾：

**模型文件动辄 20+ GiB，而启动延迟目标是秒级。** 如果把文件内容全部读进堆内存，
有两个硬伤：

1. **内存翻倍**：磁盘上 20 GiB，再在堆里复制一份，进程需要 40 GiB 才能站起来。
   多数开发机根本不具备这个条件。
2. **启动时间爆炸**：`read()` 系统调用把 20 GiB 从磁盘复制到用户空间缓冲区，
   在 NVMe SSD 上也要 20–60 秒。

具体要完成的三件事：
- 把整个 GGUF 文件映射进地址空间，**不拷贝字节**；
- 解析头部，读取元数据键值对目录；
- 读取张量目录，把每个张量的相对偏移转换成绝对 mmap 偏移，以便后续直接取指针。

## 3. 朴素思路

最直接的做法：`fopen()` + `fread()` 把文件内容全部读进 `malloc` 分配的缓冲区，
然后在这个缓冲区里做指针运算解析结构。

这个思路并不荒谬——对小文件（比如几百 MB 的词嵌入）这样做完全合理。问题在于
DwarfStar 4 针对的是 DS4 Flash，文件大小超过多数机器的可用 RAM。

## 4. 为什么朴素思路会崩

以 DS4 Flash 为例，张量 payload 约 24 GiB，元数据 + 目录几十 MB，合计接近 25 GiB。

- **M2 MacBook Air（24 GB unified memory）**：`malloc(25G)` 直接失败，程序连起步
  都迈不出去。
- **M3 Max（128 GB）**：`fread()` 从 SSD 把 25 GiB 复制进 RAM 需要 30–60 秒，
  即便复制完也多占 25 GiB 内存，与同时运行的其它进程竞争。
- **Metal 特殊需求**：Metal 把缓冲区包成 `MTLBuffer` 时，若来源是普通堆内存则必须
  再做一次设备侧拷贝。若直接用文件支持的共享映射，Metal 可以零拷贝构造
  `MTLBuffer`——这是 `MAP_SHARED` 的关键用途。

总结：`fread()` 方案在模型大小超过可用 RAM 的一半时必然失败或严重降级。

## 5. DwarfStar 4 的做法

`model_open()`（`ds4.c:1196`）用 **`mmap()`** 一步把整个文件映射进进程地址空间：

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="mmap flow: disk file opened with open and fstat, then mmap returns a virtual address without any disk IO, later page faults load pages on demand">
  <defs>
    <marker id="ar-t2-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar-t2-1b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#ea580c"/>
    </marker>
  </defs>
  <rect x="260" y="10" width="240" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="28" font-size="13" font-weight="600" fill="currentColor" text-anchor="middle">磁盘文件 DS4.gguf</text>
  <text x="380" y="46" font-size="11" fill="#64748b" text-anchor="middle">~25 GiB，SSD 上静止不动</text>
  <line x1="380" y1="54" x2="380" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-t2-1)"/>
  <rect x="200" y="72" width="360" height="36" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="88" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">open() + fstat()</text>
  <text x="380" y="101" font-size="10" fill="#64748b" text-anchor="middle">获得 fd 和文件大小 st.st_size</text>
  <line x1="380" y1="108" x2="380" y2="126" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar-t2-1)"/>
  <rect x="160" y="126" width="440" height="48" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="145" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">mmap(NULL, st.st_size, PROT_READ, mmap_flags, fd, 0)</text>
  <text x="380" y="163" font-size="10" fill="#7c3aed" text-anchor="middle">仅建立虚拟地址映射，此刻没有任何磁盘 I/O 发生</text>
  <line x1="380" y1="174" x2="380" y2="192" stroke="#ea580c" stroke-width="1.5" marker-end="url(#ar-t2-1b)"/>
  <rect x="200" y="192" width="360" height="48" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="210" font-size="12" font-weight="600" fill="currentColor" text-anchor="middle">m-&gt;map = map  /  m-&gt;size = st.st_size</text>
  <text x="380" y="228" font-size="10" fill="#64748b" text-anchor="middle">指向文件首字节的虚拟地址指针，已可用于指针运算</text>
  <line x1="380" y1="240" x2="380" y2="256" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-t2-1)"/>
  <rect x="200" y="256" width="360" height="36" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="380" y="272" font-size="11" fill="#64748b" text-anchor="middle">m-&gt;map[offset] 读操作 → 缺页中断 → 内核按需加载对应 4K 页</text>
</svg>
<span class="figure-caption">图 T2.1 ｜ mmap 调用流程：建立虚拟地址映射不产生 I/O，访问时内核按需分页</span>

<details>
<summary>ASCII 原版</summary>

```
磁盘文件 DS4.gguf （~25 GiB）
│
│  open() + fstat() 得到 fd 和文件大小
│
▼
mmap(NULL, st.st_size, PROT_READ, mmap_flags, fd, 0)
│
│  返回 void *map —— 一个虚拟地址
│  此时没有任何磁盘 I/O 发生
│
▼
m->map = map        // 指向文件首字节的指针
m->size = st.st_size

之后任何 m->map[offset] 读操作 → 内核按需从磁盘加载对应页
```

</details>

关键参数差异：`mmap_flags` 根据后端不同而变（`ds4.c:1220`）：

```c
const int mmap_flags = metal_mapping ? MAP_SHARED : MAP_PRIVATE;
```

- **Metal 路径（本 trace）**：`MAP_SHARED` —— 文件页直接暴露给 Metal，
  `MTLBuffer` 可以用 `newBufferWithBytesNoCopy` 零拷贝包裹这段映射，
  权重从来不进入 CPU 堆内存。
- **CPU 路径**：`MAP_PRIVATE` —— 用 copy-on-write 隔离映射，
  避免 Darwin 内核在 shared mapping 高并发 page fault 时触发的 VM 计数 bug。

映射建好之后，`model_open()` 立即在 mmap 内部做顺序解析（`ds4.c:1228` 起）。
它用一个游标 `ds4_cursor`（记录当前偏移 + 文件大小，不持有任何堆拷贝）在映射上
滑动读取：

**1. 读 GGUF 文件头（4+4+8+8 字节）**

```c
cursor_u32(&c, &magic);      // 0x46554747 == "GGUF"  ds4.c:1230
cursor_u32(&c, &m->version); // 必须是 3              ds4.c:1232
cursor_u64(&c, &m->n_tensors);
cursor_u64(&c, &m->n_kv);
```

**2. 读元数据键值对表 `parse_metadata()`（`ds4.c:1111`）**

```c
m->kv = calloc(m->n_kv, sizeof(ds4_kv));
for each kv:
    cursor_string → kv->key        // 键名字符串，驻留在 mmap
    cursor_u32    → kv->type       // 值类型
    kv->value_pos = c.pos          // 记录值在 mmap 内的偏移
    skip_value()                   // 跳过值，不拷贝
```

元数据**值本体继续留在 mmap**，`kv->value_pos` 只是偏移；后续需要哪个值再用
游标去读。`m->kv` 数组本身只有几万个条目，堆占用可忽略。

**3. 读张量目录 `parse_tensors()`（`ds4.c:1141`），并转换偏移**

```c
m->tensors = calloc(m->n_tensors, sizeof(ds4_tensor));
for each tensor:
    cursor_string → t->name        // 名字，驻留在 mmap
    cursor_u32    → t->ndim
    cursor_u64 × ndim → t->dim[]
    cursor_u32    → t->type
    cursor_u64    → t->rel_offset  // 相对张量数据区起点的偏移
    tensor_nbytes(t->type, elements, &t->bytes)

// 计算张量数据区的起点（对齐到 m->alignment，通常 32 字节）
m->tensor_data_pos = align_up(c.pos, m->alignment);

// in-place 转换：相对 → 绝对
for each tensor:
    t->abs_offset = m->tensor_data_pos + t->rel_offset
    // 同时做越界检查
```

转换后，任何张量的字节可以用一行取到（`ds4.c:1472`）：

```c
static const void *tensor_data(const ds4_model *m, const ds4_tensor *t) {
    return m->map + t->abs_offset;  // 指针运算，零拷贝
}
```

这就是「分配进地址空间而非拷贝」在 ds4 里的具体形态：整个 GGUF 的物理内容
始终只有磁盘上那一份，进程通过指针访问，内核按需分页。

## 6. 代码位置

按阅读顺序：

- `ds4.c:1192`：`model_open()` 注释头，说明 Metal vs CPU 映射策略差异。
- `ds4.c:1196`：`model_open()` 函数体，`open()` + `fstat()` + `mmap()`。
- `ds4.c:1220`：`MAP_SHARED` vs `MAP_PRIVATE` 分支。
- `ds4.c:1228`：游标初始化，开始解析 GGUF 头部。
- `ds4.c:1111`：`parse_metadata()`，读取元数据键值表，值留在 mmap 内。
- `ds4.c:1141`：`parse_tensors()`，读张量目录，填 `t->rel_offset`。
- `ds4.c:1176`：`align_up()` 计算 `tensor_data_pos`，对齐到 `m->alignment`。
- `ds4.c:1178`：in-place 循环，把 `rel_offset` 转换为 `abs_offset` 并做越界检查。
- `ds4.c:1471`：`tensor_data()`，返回张量 payload 在 mmap 里的指针（一行实现）。
- `ds4.c:1087`：`model_prefetch_cpu_mapping()`，CPU 路径下发 `POSIX_MADV_WILLNEED`，
  提前把页加载进 page cache，规避 Darwin VM 计数 bug。

## 7. 分支与延伸

- GGUF 文件格式的完整规范（魔数、版本、键值表、张量目录的二进制布局）→
  [第 3 章 GGUF 加载](03-gguf-loading.md)
- `ds4_model` 结构体的字段含义、`ds4_kv` / `ds4_tensor` 的生命周期管理，
  以及 `model_close()` 里 `munmap()` + `free(kv)` + `free(tensors)` 的顺序 →
  [第 3 章 GGUF 加载](03-gguf-loading.md)
- Metal 路径为什么必须用 `MAP_SHARED`、`MTLBuffer` 的零拷贝构造原理、
  Metal 共享映射在 M 系列 unified memory 上的物理语义 →
  [第 1 章 架构总览](01-architecture-overview.md)
- CPU 路径的 `MAP_PRIVATE` + `POSIX_MADV_WILLNEED` 是为了规避 Darwin VM 计数 bug，
  以及 CPU 推理时专家权重的 lazy page-fault 模式 →
  [第 3 章 GGUF 加载](03-gguf-loading.md)

## 8. 走完这一步你脑子里应该多了什么

1. **mmap 是「地址空间映射」而非「内存拷贝」**：`mmap()` 调用本身几乎没有 I/O，
   内核只在访问对应虚拟地址时才从磁盘加载页——ds4 加载一个 25 GiB 模型，
   `mmap()` 本身的耗时不超过几毫秒。
2. **Metal 路径用 `MAP_SHARED`，CPU 路径用 `MAP_PRIVATE`**：前者让 Metal 可以零拷贝
   包裹文件页为 `MTLBuffer`；后者是主动规避一个已知的 Darwin VM 内核 bug。
3. **元数据值不拷贝出 mmap**：`ds4_kv` 只记录 `value_pos`（偏移），值本体留在
   文件映射里，需要时用游标去读，不产生额外堆内存。
4. **相对偏移在解析时 in-place 转换为绝对偏移**：`parse_tensors()` 读完目录后
   立即把每个 `t->rel_offset` 加上 `tensor_data_pos` 变成 `t->abs_offset`，
   之后取任意张量只需一次指针加法（`tensor_data()`）。
5. **这一步结束后进程内存增量极小**：新增的堆数据只有 `m->kv`（元数据索引）和
   `m->tensors`（张量目录），合计不超过几十 MB；25 GiB 的权重 payload 仍在磁盘，
   还没有任何权重字节被读入 CPU RAM。
