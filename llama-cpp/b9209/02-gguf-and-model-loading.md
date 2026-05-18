# 第 2 章 GGUF 文件格式与模型加载

GGUF（GGML Universal Format）是 llama.cpp 使用的模型文件格式，自 2023 年 8 月引入，取代了之前的 ggml/ggmf/ggjt 系列格式。它的设计目标是"一个文件包含一切"：模型权重、超参数、tokenizer 配置、量化类型、甚至推荐采样参数——全部以自描述的键值对形式写入同一个文件。本章从文件字节布局讲到 C 解析实现，再到 libllama 层的多 split 加载、mmap 零拷贝，以及张量如何从原始字节变为可计算的 `ggml_tensor`。

---

## 1. 为什么需要 GGUF

早期 ggml 格式（.bin 文件）存在几个根本性问题：

**缺乏自描述**：文件头只有固定几个字段（词表大小、层数等），模型架构类型无法从文件本身判断，必须靠文件名或命令行参数传入。

**格式版本混乱**：先后出现 `GGML`（magic `0x67676d6c`）→ `GGMF`（v1 格式）→ `GGJT`（v3 格式，支持内存对齐），每次改格式就要写新的加载代码。

**不可 mmap**：早期格式中 tensor 数据不是页对齐的，无法用 mmap 直接使用。

**tokenizer 外置**：LLaMA 的 tokenizer 需要单独的 `tokenizer.model`（SentencePiece 格式），HuggingFace checkpoint 需要 `tokenizer.json`，给部署带来额外复杂度。

GGUF 通过以下机制解决这些问题：

```text
文件 = 固定头（magic + version + counts）
     + 任意数量的 KV 元数据（自描述）
     + tensor info 区（名称/形状/类型/偏移）
     + 对齐 padding
     + tensor data 区（对齐，可直接 mmap）
```

`ggml/include/gguf.h:41` 定义当前版本为 `GGUF_VERSION 3`，同时支持向后读取 v2 文件（v1 已不支持，`ggml/src/gguf.cpp:453-456`）。

---

## 2. GGUF 二进制布局

### 2.1 完整结构 ASCII 图

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GGUF binary file layout showing header, KV section, tensor info, padding and data sections">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <text x="50" y="22" font-size="11" fill="#94a3b8">偏移 0</text>
  <rect x="50" y="28" width="500" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="300" y="43" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">magic: "GGUF"  (4 bytes, 0x47 0x47 0x55 0x46)</text>
  <rect x="50" y="50" width="500" height="20" rx="0" fill="#fef9f5" stroke="#ea580c" stroke-width="1" stroke-dasharray="2,0"/>
  <text x="300" y="64" text-anchor="middle" font-size="11" fill="#64748b">version: uint32_t  (当前 = 3)</text>
  <rect x="50" y="70" width="500" height="20" rx="0" fill="#fef9f5" stroke="#ea580c" stroke-width="1"/>
  <text x="300" y="84" text-anchor="middle" font-size="11" fill="#64748b">n_tensors: int64_t  (文件包含的 tensor 数量)</text>
  <rect x="50" y="90" width="500" height="20" rx="0" fill="#fef9f5" stroke="#ea580c" stroke-width="1"/>
  <text x="300" y="104" text-anchor="middle" font-size="11" fill="#64748b">n_kv: int64_t  (键值对数量)</text>
  <rect x="50" y="114" width="500" height="80" rx="0" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="300" y="130" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">KV 区  (n_kv 个条目，顺序存放)</text>
  <text x="300" y="148" text-anchor="middle" font-size="10" fill="#64748b">entry[i].key:   uint64_t length + char[]（无 null）</text>
  <text x="300" y="163" text-anchor="middle" font-size="10" fill="#64748b">entry[i].type:  int32_t (enum gguf_type)</text>
  <text x="300" y="178" text-anchor="middle" font-size="10" fill="#64748b">entry[i].value: 标量直接存 | ARRAY: elem_type(i32) + n(u64) + 元素...</text>
  <text x="300" y="193" text-anchor="middle" font-size="10" fill="#94a3b8">entry[0] ... entry[n_kv-1]</text>
  <rect x="50" y="198" width="500" height="90" rx="0" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="300" y="214" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">tensor info 区  (n_tensors 个条目)</text>
  <text x="300" y="232" text-anchor="middle" font-size="10" fill="#64748b">info[i].name:    uint64_t length + char[]</text>
  <text x="300" y="247" text-anchor="middle" font-size="10" fill="#64748b">info[i].n_dims:  uint32_t</text>
  <text x="300" y="262" text-anchor="middle" font-size="10" fill="#64748b">info[i].ne[]:    int64_t × n_dims  (各维大小)</text>
  <text x="300" y="277" text-anchor="middle" font-size="10" fill="#64748b">info[i].type:    int32_t (ggml_type，量化类型)   info[i].offset: uint64_t</text>
  <text x="300" y="290" text-anchor="middle" font-size="10" fill="#94a3b8">info[0] ... info[n_tensors-1]</text>
  <rect x="50" y="292" width="500" height="28" rx="0" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2" stroke-dasharray="4,2"/>
  <text x="300" y="311" text-anchor="middle" font-size="10" fill="#94a3b8">对齐 padding: GGML_PAD(current_pos, alignment)  (默认 alignment=32，可被 general.alignment 覆盖)</text>
  <rect x="50" y="324" width="500" height="80" rx="0" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="300" y="342" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">tensor data 区  ← ctx-&gt;offset 记录此处</text>
  <text x="300" y="360" text-anchor="middle" font-size="10" fill="#64748b">tensor[0] data  (按 alignment 对齐)  ···  padding</text>
  <text x="300" y="375" text-anchor="middle" font-size="10" fill="#64748b">tensor[1] data  (按 alignment 对齐)  ···  padding</text>
  <text x="300" y="390" text-anchor="middle" font-size="10" fill="#94a3b8">···</text>
  <text x="300" y="413" text-anchor="middle" font-size="10" fill="#94a3b8">可直接 mmap — 页对齐，零拷贝读取</text>
  <text x="560" y="43" font-size="10" fill="#ea580c">固定头</text>
  <text x="560" y="130" font-size="10" fill="#7c3aed">自描述元数据</text>
  <text x="560" y="214" font-size="10" fill="#0ea5e9">张量元信息</text>
  <text x="560" y="342" font-size="10" fill="#16a34a">权重数据</text>
</svg>
<span class="figure-caption">图 R2.1 ｜ GGUF 文件二进制布局：固定头 → KV 元数据区 → tensor info 区 → 对齐 padding → tensor data 区</span>

<details>
<summary>ASCII 原版</summary>

```
偏移 0
┌─────────────────────────────────────────────────────┐
│  magic: "GGUF"  (4 bytes, 0x47 0x47 0x55 0x46)     │
├─────────────────────────────────────────────────────┤
│  version: uint32_t  (当前 = 3)                      │
├─────────────────────────────────────────────────────┤
│  n_tensors: int64_t  (文件包含的 tensor 数量)        │
├─────────────────────────────────────────────────────┤
│  n_kv: int64_t  (键值对数量)                        │
├─────────────────────────────────────────────────────┤
│  ─── KV 区 (n_kv 个条目，顺序存放) ───              │
│  entry[0]:                                          │
│    key:     uint64_t length + char[] (无 null)      │
│    type:    int32_t (enum gguf_type)                │
│    value:   取决于 type                             │
│               标量: 直接二进制表示                  │
│               ARRAY: type(i32) + n(u64) + 元素...  │
│  entry[1] ... entry[n_kv-1]                         │
├─────────────────────────────────────────────────────┤
│  ─── tensor info 区 (n_tensors 个条目) ───          │
│  info[0]:                                           │
│    name:    uint64_t length + char[]                │
│    n_dims:  uint32_t                                │
│    ne[]:    int64_t × n_dims  (各维大小)            │
│    type:    int32_t (enum ggml_type，量化类型)      │
│    offset:  uint64_t  (相对 data 区起始的字节偏移)  │
│  info[1] ... info[n_tensors-1]                      │
├─────────────────────────────────────────────────────┤
│  对齐 padding: GGML_PAD(current_pos, alignment)     │
│  (默认 alignment=32，可被 general.alignment 覆盖)   │
├─────────────────────────────────────────────────────┤
│  ─── tensor data 区 ─── ← ctx->offset 记录此处     │
│  tensor[0] data  (按 alignment 对齐)                │
│  padding ...                                        │
│  tensor[1] data  (按 alignment 对齐)                │
│  padding ...                                        │
│  ...                                                │
└─────────────────────────────────────────────────────┘
```

</details>

关键规则（`ggml/include/gguf.h:1-32`，文件顶部注释）：
- 字符串 = `uint64_t` 长度 + char 数组（**无** null terminator）；
- 所有枚举存为 `int32_t`；
- bool 存为 `int8_t`；
- tensor data 区内每个 tensor 的字节数向 `alignment` 对齐后紧接下一个 tensor；
- `general.alignment` 这个 KV 键（若存在）覆盖默认值 32（`ggml/include/gguf.h:44-46`）。

### 2.2 gguf_type 类型系统

```c
// ggml/include/gguf.h:53-68
enum gguf_type {
    GGUF_TYPE_UINT8   = 0,
    GGUF_TYPE_INT8    = 1,
    GGUF_TYPE_UINT16  = 2,
    GGUF_TYPE_INT16   = 3,
    GGUF_TYPE_UINT32  = 4,
    GGUF_TYPE_INT32   = 5,
    GGUF_TYPE_FLOAT32 = 6,
    GGUF_TYPE_BOOL    = 7,   // 存储为 int8
    GGUF_TYPE_STRING  = 8,
    GGUF_TYPE_ARRAY   = 9,   // 嵌套：元素类型 + 长度 + 元素
    GGUF_TYPE_UINT64  = 10,
    GGUF_TYPE_INT64   = 11,
    GGUF_TYPE_FLOAT64 = 12,
    GGUF_TYPE_COUNT,
};
```

`GGUF_TYPE_ARRAY` 不是独立的 KV 类型，而是一个"容器"：当 `type == GGUF_TYPE_ARRAY` 时，接下来读取元素类型（`gguf_type`）和元素数量（`uint64_t`），再读取所有元素。`ARRAY` 不可嵌套（数组元素类型不能是 `ARRAY`，`ggml/src/gguf.cpp:544-546`）。

---

## 3. gguf.cpp 的解析实现

### 3.1 `gguf_init_from_file` 入口

```c
// ggml/include/gguf.h:81
struct gguf_context * gguf_init_from_file(const char * fname, struct gguf_init_params params);
```

实际实现在 `gguf_init_from_file_ptr`（`ggml/src/gguf.cpp:397`），通过 `FILE *` 操作文件。核心解析器是内部类 `gguf_reader`：

```cpp
// ggml/src/gguf.cpp:230-365（精简）
struct gguf_reader {
    gguf_reader(FILE * file) : file(file) {
        nbytes_remain = file_remain(file);
    }
    template <typename T> bool read(T & dst) const {
        const size_t nread = fread(&dst, 1, sizeof(T), file);
        nbytes_remain -= nread;
        return nread == sizeof(T);
    }
    bool read(std::string & dst) const {
        uint64_t size = 0;
        read(size);  // 读字符串长度
        dst.resize(size);
        const size_t nread = fread(dst.data(), 1, size, file);
        nbytes_remain -= nread;
        return nread == size;
    }
private:
    FILE * file;
    mutable uint64_t nbytes_remain;
};
```

`nbytes_remain` 在每次读取后递减，防止读出文件边界。字符串读取的特殊处理（先读 `uint64_t` 长度，再按长度读字节）对应 GGUF 的字符串序列化规则。

### 3.2 解析流程

```cpp
// ggml/src/gguf.cpp:397-800（路径概要）
struct gguf_context * gguf_init_from_file_ptr(FILE * file, struct gguf_init_params params) {
    // 1. 验证 magic
    gr.read(magic, 4);  // 必须 == "GGUF"  [:407-428]

    // 2. 读取 header
    gr.read(ctx->version);  // 检查版本范围 [:435-462]
    gr.read(n_tensors);     // int64_t [:466-475]
    gr.read(n_kv);          // int64_t [:477-486]

    // 3. 逐个解析 KV 对 [:495-557]
    for (int64_t i = 0; i < n_kv; ++i) {
        gr.read(key);         // 字符串
        gr.read(type);        // gguf_type
        if (type == GGUF_TYPE_ARRAY) {
            gr.read(elem_type); gr.read(n);
        }
        // 根据类型分发读取
        switch (type) {
            case GGUF_TYPE_UINT32:
                gguf_read_emplace_helper<uint32_t>(gr, ctx->kv, key, is_array, n);
            // ...
        }
    }
    // 更新 alignment（若 general.alignment KV 存在）[:560-567]

    // 4. 逐个解析 tensor info [:571-692]
    for (int64_t i = 0; i < n_tensors; ++i) {
        gr.read(name);         // tensor 名称
        gr.read(n_dims);       // 维度数
        for j in 0..n_dims: gr.read(info.t.ne[j]);
        gr.read(info.t.type);  // ggml_type（量化类型）
        gr.read(info.offset);  // 相对 data 区偏移
        ctx->info.push_back(info);
    }

    // 5. 跳过 padding，记录 data 区起始偏移 [:702-710]
    gguf_fseek(file, GGML_PAD(gguf_ftell(file), ctx->alignment), SEEK_SET);
    ctx->offset = gguf_ftell(file);  // 这是 data 区的起始字节位置

    // 6. 若 params.ctx != nullptr，创建 ggml_context 并（可选）读入 tensor data [:736-830]
}
```

step 6 的 `params.no_alloc = true` 模式是模型加载的常用路径：只创建空的 `ggml_tensor` 结构体（记录名称/形状/类型，`data` 指针为 NULL），不立即读入数据。真正的数据通过后续的 mmap 或 `load_all_data` 填充。

### 3.3 gguf_context 内部结构

```cpp
// ggml/src/gguf.cpp:217-228
struct gguf_context {
    uint32_t version = GGUF_VERSION;
    std::vector<struct gguf_kv> kv;           // 所有 KV 对
    std::vector<struct gguf_tensor_info> info; // 所有 tensor 元信息
    size_t alignment = GGUF_DEFAULT_ALIGNMENT;
    size_t offset    = 0;   // data 区在文件中的字节偏移
    size_t size      = 0;   // data 区总字节数（含 padding）
    void * data = nullptr;  // 若 no_alloc=false 时持有 data 副本
};
```

`gguf_kv` 内部存储字节向量（对标量）或字符串向量（对 string 类型），通过 `get_val<T>()` 模板方法类型安全地取值（`ggml/src/gguf.cpp:192-203`）。

---

## 4. `llama_model_loader` 的职责

`llama_model_loader`（`src/llama-model-loader.h`）是 libllama 层的 GGUF 聚合器，负责把一个或多个 GGUF split 文件展现成统一的张量索引。

### 4.1 构造函数：聚合多 split 文件

```cpp
// src/llama-model-loader.cpp:510-697（路径概要）
llama_model_loader::llama_model_loader(...)
{
    // 加载主文件
    metadata_ptr.reset(gguf_init_from_file(fname.c_str(), params));  // :545
    get_key(LLM_KV_GENERAL_ARCHITECTURE, arch_name, false);          // :551
    llm_kv = LLM_KV(llm_arch_from_string(arch_name));               // :552

    // 建立张量索引：tensor name → llama_tensor_weight
    for (ggml_tensor * cur = ggml_get_first_tensor(ctx); ...) {
        weights_map.emplace(tensor_name,
            llama_tensor_weight(files.back().get(), 0, metadata, cur));  // :582
    }

    // 若有多个 split（n_split > 1），循环加载其余 split
    uint16_t n_split = 0;
    get_key(LLM_KV_SPLIT_COUNT, n_split, false);  // :585
    if (n_split > 1) {
        for (idx = 1; idx < n_split; idx++) {
            gguf_init_from_file(splits[idx].c_str(), ...);  // :619
            // 继续建立同一 weights_map
        }
    }
}
```

`llama_tensor_weight` 记录了三个关键信息（`src/llama-model-loader.h:33-50`）：
- `idx`：来自哪个 split 文件（对应 `files[idx]`）；
- `offs`：在该文件中的字节偏移（= `gguf_get_data_offset(gguf_ctx) + gguf_get_tensor_offset(gguf_ctx, tid)`）；
- `tensor`：指向 `ggml_context` 中的元信息 tensor（只有名称/形状/类型，data=NULL）。

### 4.2 元数据读取模板

```cpp
// src/llama-model-loader.cpp:270-412
template<typename T>
bool llama_model_loader::get_key(const std::string & key, T & result, bool required) {
    auto it = kv_overrides.find(key);
    const struct llama_model_kv_override * override =
        it != kv_overrides.end() ? &it->second : nullptr;

    const bool found = GGUFMeta::GKV<T>::set(metadata, key, result, override);
    if (required && !found) {
        throw std::runtime_error(format("key not found in model: %s", key.c_str()));
    }
    return found;
}
```

`GGUFMeta::GKV<T>` 是一个模板特化体系（`src/llama-model-loader.cpp:103-268`），将 C++ 类型（`bool`、`uint32_t`、`float`、`std::string` 等）映射到对应的 `gguf_type` 枚举，并调用正确的 `gguf_get_val_*` 函数。如果调用方提供了 `kv_overrides`（通过 `llama_model_params.kv_overrides`），则优先使用覆盖值。

### 4.3 张量维度校验

```cpp
// src/llama-model-loader.cpp:862-890
const struct ggml_tensor * llama_model_loader::check_tensor_dims(
        const std::string & name, const std::vector<int64_t> & ne, bool required) const {
    const struct ggml_tensor * cur = get_tensor_meta(name.c_str());
    // ...
    bool is_ok = true;
    for (size_t i = 0; i < GGML_MAX_DIMS; ++i) {
        if ((i < ne.size() && ne[i] != cur->ne[i]) ||
            (i >= ne.size() && cur->ne[i] != 1)) {
            is_ok = false; break;
        }
    }
    if (!is_ok) throw std::runtime_error(format(
        "%s: tensor '%s' has wrong shape; expected %s, got %s", ...));
    return cur;
}
```

在 `create_tensor` 调用时（`src/llama-model-loader.cpp:1267`），每个期望张量都会调用 `check_tensor_dims` 验证实际形状是否与模型架构的预期一致，防止加载格式不兼容的权重。

### 4.4 `n_created`/`n_tensors` 完整性检查

```cpp
// src/llama-model-loader.h:71-73
int n_kv      = 0;
int n_tensors = 0;
int n_created = 0;
```

每次 `create_tensor` 成功后 `n_created++`（`src/llama-model-loader.cpp:1281`）。`done_getting_tensors()` 检查 `n_created == n_tensors`（`src/llama-model-loader.cpp:1315-1331`），确保文件中的所有张量都被消费，没有意外遗漏。

---

## 5. `llama_mmap` 与 `llama_file`

### 5.1 `llama_file`

```cpp
// src/llama-mmap.h:16-41
struct llama_file {
    llama_file(const char * fname, const char * mode, bool use_direct_io = false);
    size_t tell() const;
    size_t size() const;
    void seek(size_t offset, int whence) const;
    void read_raw(void * ptr, size_t len);
    // ...
private:
    struct impl;
    std::unique_ptr<impl> pimpl;
};
```

`llama_file` 用 pimpl 模式隐藏了平台差异（POSIX `FILE *`/`fd` vs Windows `HANDLE`）。Direct I/O 模式（`use_direct_io=true`）时使用 `O_DIRECT` 打开文件，读取必须以扇区大小（通常 512 或 4096 字节）对齐，通过 `read_aligned_chunk` 方法实现（`src/llama-mmap.cpp:319-341`）。Direct I/O 与 mmap 互斥，前者绕过 page cache，适合内存极紧张的场景。

### 5.2 `llama_mmap`：零拷贝的本质

```cpp
// src/llama-mmap.cpp:445-476（POSIX 实现）
impl(struct llama_file * file, size_t prefetch, bool numa) {
    size = file->size();
    int fd = file->file_id();
    int flags = MAP_SHARED;
    if (numa) { prefetch = 0; }  // NUMA 下禁用预取
#ifdef __linux__
    if (prefetch) { flags |= MAP_POPULATE; }  // 预先填充页表
#endif
    addr = mmap(NULL, file->size(), PROT_READ, flags, fd, 0);
    // POSIX_MADV_WILLNEED 提示内核预取
    if (prefetch > 0) {
        posix_madvise(addr, min(file->size(), prefetch), POSIX_MADV_WILLNEED);
    }
    if (numa) {
        posix_madvise(addr, file->size(), POSIX_MADV_RANDOM);  // NUMA 下随机访问
    }
}
```

**零拷贝的含义**：`mmap` 调用后，内核建立了从文件 → 进程虚拟地址空间的映射，但不立即读入任何数据。当 CPU 第一次访问某个地址（page fault），内核才从磁盘读入对应的 4 KB 页。对于 CPU 推理，张量数据直接从 mmap 区使用，RAM 的实际占用等于活跃使用的页数，而非整个模型大小。

**`MAP_POPULATE`**（Linux）：mmap 时立即为所有页建立页表并预取到 page cache，减少推理时的 page fault 延迟，代价是加载时间略长。

**`unmap_fragment`**：加载完成后，已经被复制到 GPU VRAM 的权重可以通过 `unmap_fragment` 归还物理内存（`src/llama-mmap.cpp:490-523`）。`mapped_fragments` 维护当前仍映射的区间列表，析构时 `munmap` 所有剩余片段。

**Windows**：使用 `CreateFileMapping` + `MapViewOfFile`（`src/llama-mmap.cpp:533` 起），语义相同。

**`llama_mlock`**：调用 `mlock`/`VirtualLock` 将 mmap 页钉在 RAM 中，防止被交换到 swap（`src/llama-mmap.h:60-71`）。适用于对延迟敏感的场景，但需要足够的 RAM 和相应权限（Linux 下 `RLIMIT_MEMLOCK`）。

### 5.3 不支持 mmap 时的回退

```cpp
// src/llama-model-loader.cpp:810-813
if (!llama_mmap::SUPPORTED) {
    LLAMA_LOG_WARN("%s: mmap is not supported on this platform\n", __func__);
    use_mmap = false;
}
```

`llama_mmap::SUPPORTED` 是编译期静态常量（`src/llama-mmap.cpp` 中对应平台的初始化）。不支持 mmap 时，`load_data_for` 通过 `file->seek` + `file->read_raw` 将张量数据读到已分配的缓冲区（`src/llama-model-loader.cpp:1393-1399`）。

---

## 6. 一个张量从文件字节到 `ggml_tensor`

完整的转换过程分三个阶段：

### 6.1 阶段一：`gguf_init_from_file`（元信息解析）

解析 tensor info 区，为每个张量建立 `gguf_tensor_info`（含名称、形状、类型、文件内 data 区偏移）。此时 `ggml_tensor.data = NULL`。

```cpp
// ggml/src/gguf.cpp:212-215
struct gguf_tensor_info {
    struct ggml_tensor t;  // 持有名称/形状/类型/stride，data=NULL
    uint64_t offset;       // 相对 data 区起始的偏移
};
```

### 6.2 阶段二：`llama_model_loader::create_tensor`（分配 ggml_tensor）

模型图构建时（`src/llama-model.cpp` 中各架构的 `build` 方法），对每个权重调用 `create_tensor`：

```cpp
// src/llama-model-loader.cpp:1251-1285（精简）
struct ggml_tensor * llama_model_loader::create_tensor(...) {
    // 1. 通过名称查 weights_map，得到 t_meta（来自 gguf_init 的元信息 tensor）
    ggml_tensor * t_meta = get_tensor_meta(tn.str().c_str());

    // 2. 选择 buffer type（CPU/GPU VRAM/etc.）
    ggml_backend_buffer_type_t buft = buft_for_tensor(t_meta);

    // 3. 在对应的 ggml_context（ctx_map[buft]）中分配 ggml_tensor
    ggml_context * ctx = ctx_for_buft(buft);
    ggml_tensor * tensor = ggml_dup_tensor(ctx, t_meta);

    // 4. 验证形状
    check_tensor_dims(tn.str(), ne, ...);
    n_created++;
    return tensor;
}
```

`ggml_dup_tensor` 复制元信息（名称、形状、类型），但不分配 data——`data` 指针仍为 NULL。tensor 被加入到 `ctx_map[buft]` 管理的 ggml_context 中，后续 `ggml_backend_alloc_ctx_tensors` 会为同一 buffer type 的所有 tensor 一次性分配显存/内存。

### 6.3 阶段三：`load_all_data`（填充实际数据）

```cpp
// src/llama-model-loader.cpp:1383-1403（mmap 路径）
void llama_model_loader::load_data_for(struct ggml_tensor * cur) const {
    const auto & w = require_weight(ggml_get_name(cur));
    if (use_mmap) {
        const auto & mapping = mappings.at(w.idx);
        if (cur->data == nullptr) {
            // mmap 零拷贝：直接指向映射区
            cur->data = (uint8_t *)mapping->addr() + w.offs;
        } else {
            // 已有分配（如 GPU buffer），则 memcpy
            memcpy(cur->data, (uint8_t *)mapping->addr() + w.offs, ggml_nbytes(cur));
        }
    } else {
        // 非 mmap：seek + read
        file->seek(w.offs, SEEK_SET);
        file->read_raw(cur->data, ggml_nbytes(cur));
    }
}
```

对于 CPU 推理 + mmap 的组合，`cur->data` 直接指向 mmap 区（`mapping->addr() + w.offs`），不发生任何数据复制——这就是"零拷贝"的实现：tensor 的数据指针就是文件映射区的地址。

对于 GPU 推理，tensor 已被分配在 VRAM buffer（由 `ggml_backend_alloc_ctx_tensors` 完成），`cur->data` 指向 GPU 内存，无法直接用 mmap。此时的路径是：mmap 区 → `memcpy` 到 pinned host memory → 异步 DMA 传输到 VRAM（`load_all_data` 中的 `upload_backend` 路径，`src/llama-model-loader.cpp:1440-1512`）。

---

## 7. 元数据键命名空间与特殊键

### 7.1 `LLM_KV` 命名空间（src/llama-arch.cpp）

所有元数据键通过 `LLM_KV` 枚举管理（`src/llama-arch.h:160+`），`LLM_KV_NAMES` map（`src/llama-arch.cpp:139+`）给出字符串模板：

```cpp
// src/llama-arch.cpp:166-173（节选）
{ LLM_KV_GENERAL_ARCHITECTURE, "general.architecture"   },
{ LLM_KV_CONTEXT_LENGTH,       "%s.context_length"       },
{ LLM_KV_EMBEDDING_LENGTH,     "%s.embedding_length"     },
{ LLM_KV_BLOCK_COUNT,          "%s.block_count"          },
{ LLM_KV_ATTENTION_HEAD_COUNT, "%s.attention.head_count" },
```

其中 `%s` 被架构名替换，例如对于 LLaMA 架构（`general.architecture = "llama"`），`%s.context_length` 展开为 `llama.context_length`。这个替换由 `LLM_KV` 包装器的 `operator()` 完成（`src/llama-arch.h` 中的 `LLM_KV_IMPL` 结构）。

**命名规范**：
- `general.*`：全局元数据（架构、名称、版权、文件类型）
- `<arch>.*`：架构特定超参数（层数、头数、embedding 大小等）
- `<arch>.attention.*`：注意力机制参数
- `<arch>.rope.*`：RoPE 位置编码参数
- `tokenizer.ggml.*`：tokenizer 配置
- `split.*`：多 split 文件元数据

### 7.2 `ftype` 量化标识

```cpp
// src/llama-model-loader.cpp:774-779
uint32_t ftype_val = 0;
if (get_key(LLM_KV_GENERAL_FILE_TYPE, ftype_val, false)) {
    ftype = (llama_ftype) ftype_val;
}
```

`general.file_type` KV（枚举值参见 `include/llama.h:116-160`）声明了权重的主要量化类型（如 `LLAMA_FTYPE_MOSTLY_Q4_K_M = 15`）。若文件中没有此键，loader 会通过统计各张量的 `ggml_type` 猜测（`src/llama-model-loader.cpp:710-771`），并打上 `LLAMA_FTYPE_GUESSED` 标志位。

### 7.3 split 模型元数据

对于超大模型（如 70B+），GGUF 支持分 split 存储。split 相关的 KV 键：

| 键（模板） | 含义 |
|---|---|
| `split.count` | 总 split 数量 |
| `split.no` | 本文件是第几个（从 0 起） |
| `split.tensors.count` | 所有 split 合计的 tensor 数量 |

文件名约定：`<name>-00001-of-00004.gguf`（五位数格式）。`llama_get_list_splits` 函数（`src/llama-model-loader.cpp:78-101`）根据主文件名和 split 总数自动生成其余 split 的路径，无需用户手动指定。`tools/gguf-split` 工具负责将单文件 GGUF 切分或将多 split 合并。

---

## 8. 小结：从文件字节到可计算张量的完整数据流

<svg viewBox="0 0 760 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Six-step data flow from GGUF file to computable ggml_tensor">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect x="260" y="8" width="240" height="30" rx="15" fill="#ea580c"/>
  <text x="380" y="28" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">.gguf 文件</text>
  <line x1="380" y1="38" x2="380" y2="58" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="58" width="700" height="60" rx="5" fill="#fef9f5" stroke="#ea580c" stroke-width="1.2"/>
  <text x="380" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 1 步：gguf_init_from_file  (ggml/src/gguf.cpp:397)</text>
  <text x="380" y="93" text-anchor="middle" font-size="10" fill="#64748b">解析 KV 区 + tensor info 区，建立 gguf_context（kv 向量 + tensor_info 向量），记录 data 区偏移 ctx-&gt;offset</text>
  <text x="60" y="92" font-size="10" fill="#ea580c" font-weight="600">①</text>
  <line x1="380" y1="118" x2="380" y2="138" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="138" width="700" height="60" rx="5" fill="#fef3ff" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="156" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 2 步：llama_model_loader 构造  (src/llama-model-loader.cpp:510)</text>
  <text x="380" y="173" text-anchor="middle" font-size="10" fill="#64748b">遍历空 tensor，建立 weights_map: name → llama_tensor_weight(idx, offs, tensor*)，处理多 split 文件</text>
  <text x="60" y="172" font-size="10" fill="#7c3aed" font-weight="600">②</text>
  <line x1="380" y1="198" x2="380" y2="218" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="218" width="700" height="72" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="380" y="236" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 3 步：llama_model::load  (src/llama-model.cpp)</text>
  <text x="380" y="253" text-anchor="middle" font-size="10" fill="#64748b">读取超参数 (get_key LLM_KV_*)，按架构调用 create_tensors</text>
  <text x="380" y="270" text-anchor="middle" font-size="10" fill="#64748b">→ ggml_dup_tensor 分配元信息（data=NULL），选择 buffer type（CPU/GPU），加入 ctx_map[buft]</text>
  <text x="60" y="252" font-size="10" fill="#0ea5e9" font-weight="600">③</text>
  <line x1="380" y1="290" x2="380" y2="310" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="310" width="700" height="56" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="380" y="328" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 4 步：init_mappings  (src/llama-model-loader.cpp:1333)</text>
  <text x="380" y="345" text-anchor="middle" font-size="10" fill="#64748b">对每个文件调用 llama_mmap(file, prefetch, numa)，mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)</text>
  <text x="60" y="344" font-size="10" fill="#16a34a" font-weight="600">④</text>
  <line x1="380" y1="366" x2="380" y2="386" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="386" width="700" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="380" y="404" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 5 步：ggml_backend_alloc_ctx_tensors</text>
  <text x="380" y="421" text-anchor="middle" font-size="10" fill="#64748b">为每个 buffer type 分配连续后端内存，给 ggml_tensor.data 赋实际地址（CPU RAM / GPU VRAM）</text>
  <text x="60" y="420" font-size="10" fill="#16a34a" font-weight="600">⑤</text>
  <line x1="380" y1="430" x2="380" y2="450" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar3)"/>
  <rect x="30" y="450" width="700" height="60" rx="5" fill="#fef9f5" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="468" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">第 6 步：load_all_data  (src/llama-model-loader.cpp:1406)</text>
  <text x="380" y="485" text-anchor="middle" font-size="10" fill="#64748b">mmap 路径: cur-&gt;data = mmap_addr + w.offs（零拷贝）｜ 非mmap: seek+read ｜ GPU: mmap→pinned→DMA→VRAM</text>
  <text x="60" y="484" font-size="10" fill="#ea580c" font-weight="600">⑥</text>
  <text x="380" y="510" text-anchor="middle" font-size="10" fill="#94a3b8">可选：ggml_validate_row_data 数值校验</text>
</svg>
<span class="figure-caption">图 R2.2 ｜ 从 .gguf 文件字节到可计算 ggml_tensor 的六步数据流</span>

<details>
<summary>ASCII 原版</summary>

```
.gguf 文件
│
├─ 第1步：gguf_init_from_file (ggml/src/gguf.cpp:397)
│    解析 KV 区 + tensor info 区
│    建立 gguf_context（含 kv 向量 + tensor_info 向量）
│    记录 data 区偏移 ctx->offset
│
├─ 第2步：llama_model_loader 构造 (src/llama-model-loader.cpp:510)
│    遍历 ggml_context 中所有空 tensor（由 gguf_init 创建）
│    建立 weights_map: name → llama_tensor_weight(idx, offs, tensor*)
│    处理 split：循环加载其余 split 文件，扩充 weights_map
│
├─ 第3步：llama_model::load (src/llama-model.cpp)
│    读取超参数 (get_key LLM_KV_*)
│    按架构调用 build_graph / create_tensors
│      ↓ llama_model_loader::create_tensor
│        ggml_dup_tensor → 分配 ggml_tensor 元信息
│        选择 buffer type（CPU/GPU）
│        加入 ctx_map[buft]
│
├─ 第4步：init_mappings (src/llama-model-loader.cpp:1333)
│    对每个文件调用 llama_mmap(file, prefetch, numa)
│    mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)
│    建立 file → virtual address 映射
│
├─ 第5步：ggml_backend_alloc_ctx_tensors
│    为每个 buffer type 分配连续的后端内存
│    给 ggml_tensor.data 赋实际地址
│
└─ 第6步：load_all_data (src/llama-model-loader.cpp:1406)
     对每个 tensor:
       mmap 路径：cur->data = mmap_addr + w.offs  (零拷贝)
       非mmap路径：file.seek(w.offs) + file.read_raw(cur->data)
       GPU 路径：mmap → pinned memory → async DMA → VRAM
     （可选）check_tensors: ggml_validate_row_data 验证数值
```

</details>

理解这个流程后，第 8 章的"架构注册与图构建"就可以自然地接在第 3 步之后展开，第 9 章的 KV 缓存建立在第 5 步之后，第 6/7 章的后端实现则是第 5/6 步的内部细节。
