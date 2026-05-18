# Trace 步骤 03 —— 几百 MB 的权重怎样"零拷贝"进地址空间?

## 1. 当前情境

上一步结束后,`llama_model_loader` 已经完整持有:

- `metadata`(`gguf_context *`):全部元数据 KV 对;
- `weights_map`:张量名 → (所在文件句柄, 数据区偏移) 的哈希表;
- `arch_name` + `llm_kv`:模型架构字符串和枚举;
- `n_kv`、`n_tensors`、`fver`:计数与版本。

但每个 `ggml_tensor` 的 `->data` 指针都是 `nullptr`——权重数据完全没有进内存。

`llama_model_load` 在构造好 loader 之后,紧接着调用 `model->load_hparams(ml)`(步骤 04)和 `model->load_tensors(ml)`,本步就发生在 `load_tensors` 的内部。

## 2. 问题

一个 Qwen2.5-0.5B Q4_K_M 模型的 GGUF 文件大约 400 MB;7B 模型约 4 GB;70B 模型则超过 40 GB。把这些权重加载进内存并让每个 `ggml_tensor->data` 指向对应的字节范围,有这几个硬约束:

1. **速度**:启动延迟要尽量短,大文件不能全部 `fread` 完才能用。
2. **内存效率**:如果只把部分层放 GPU、其余层在 CPU,CPU 侧的权重不应该被无效地拷贝两次。
3. **跨平台**:Linux/macOS/Windows 都要支持,且不同文件系统下行为一致。
4. **可选的 GPU 上传**:GPU 层的权重必须拷到设备内存,CPU 层不应该。

## 3. 朴素思路

用 `fread` 把文件的数据区全部读进一块 `malloc` 出来的连续内存,然后把每个 `ggml_tensor->data` 指向该内存的对应偏移处。简单、直接、在任何 OS 上都能工作。

## 4. 为什么朴素思路会崩

- **启动时就要完整 I/O**。`fread` 是同步调用:400 MB 的模型文件意味着程序在第一个 token 产出之前必须等整个文件读完。即使只生成 4 个 token,也得等全部 400 MB 到内存。
- **两份内存**。`malloc` 申请的内存 + 内核页缓存里的副本同时存在。对于一个 CPU-only 的推理场景,内核其实已经缓存了文件内容,`fread` 只是把它再抄一遍到用户态——多了一倍内存消耗,多了一次 CPU memcpy 时间。
- **与 GPU 拷贝不正交**。对于 GPU 层,`fread` 拷到 CPU 内存后还要再 `cudaMemcpy` 到显存,于是 CPU 侧变成了不必要的中转站——既浪费 CPU RAM,又增加一次内存带宽的消耗。
- **大模型直接 OOM**。70B 模型 40 GB 文件 + 40 GB malloc = 同时需要 80 GB 可用内存,而实际推理只需要 40 GB。

## 5. llama.cpp 的做法

llama.cpp 默认使用 **`mmap`**,把文件数据区直接映射进进程的虚拟地址空间。CPU 侧的张量 `->data` 直接指向映射区的某个偏移,操作系统按需换入物理页(page fault 惰性加载)。GPU 侧则从映射区 `memcpy`(或异步 DMA)到设备缓冲区。

**核心流程**:

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="load_tensors mmap flow: init_mappings, backend buffer creation, load_all_data">
  <defs>
    <marker id="ar3a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar3ad" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="400" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="240" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="136" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">load_tensors(ml)</text>
  <text x="266" y="37" font-size="10" fill="#94a3b8">llama-model.cpp:1160</text>
  <line x1="36" y1="50" x2="36" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="36" y="72" width="240" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="156" y="92" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">① ml.init_mappings()</text>
  <text x="156" y="108" text-anchor="middle" font-size="11" fill="#64748b">for each file: llama_mmap()</text>
  <text x="156" y="120" text-anchor="middle" font-size="10" fill="#94a3b8">mmap(NULL,size,PROT_READ,MAP_SHARED,fd,0)</text>
  <line x1="276" y1="98" x2="360" y2="98" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="360" y="72" width="360" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="540" y="93" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">虚拟地址空间中出现映射区域</text>
  <text x="540" y="108" text-anchor="middle" font-size="11" fill="#64748b">[addr, addr+size) 已映射 → 物理页尚未换入</text>
  <text x="540" y="120" text-anchor="middle" font-size="10" fill="#94a3b8">mappings.push_back(mapping)</text>
  <line x1="36" y1="124" x2="36" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="36" y="156" width="240" height="80" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="156" y="176" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">② 创建后端 buffer</text>
  <text x="156" y="194" text-anchor="middle" font-size="11" fill="#64748b">CPU: buffer_from_host_ptr</text>
  <text x="156" y="209" text-anchor="middle" font-size="10" fill="#94a3b8">→ mmap 区域包成 backend buffer</text>
  <text x="156" y="226" text-anchor="middle" font-size="11" fill="#64748b">GPU: alloc_ctx_tensors_from_buft</text>
  <text x="156" y="232" text-anchor="middle" font-size="10" fill="#94a3b8"/>
  <line x1="276" y1="176" x2="360" y2="156" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <line x1="276" y1="216" x2="360" y2="236" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="360" y="140" width="360" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="540" y="163" text-anchor="middle" font-size="11" fill="#64748b">CPU: 零分配,tensor→data 指向 mmap 偏移</text>
  <rect x="360" y="220" width="360" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="540" y="243" text-anchor="middle" font-size="11" fill="#64748b">GPU: 分配真实设备显存 buffer</text>
  <line x1="36" y1="236" x2="36" y2="270" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="36" y="270" width="240" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="156" y="290" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">③ ml.load_all_data()</text>
  <text x="156" y="308" text-anchor="middle" font-size="11" fill="#64748b">CPU 层: cur→data = mmap+offs</text>
  <text x="156" y="322" text-anchor="middle" font-size="10" fill="#94a3b8">零拷贝</text>
  <text x="156" y="338" text-anchor="middle" font-size="11" fill="#64748b">GPU 层: tensor_set(mmap+offs…)</text>
  <text x="156" y="350" text-anchor="middle" font-size="10" fill="#94a3b8">memcpy → 显存</text>
  <line x1="276" y1="300" x2="360" y2="280" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar3ad)"/>
  <line x1="276" y1="338" x2="360" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3a)"/>
  <rect x="360" y="262" width="360" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="540" y="285" text-anchor="middle" font-size="11" fill="#64748b">CPU tensor→data 有效,无额外内存</text>
  <rect x="360" y="320" width="360" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="540" y="343" text-anchor="middle" font-size="11" fill="#64748b">GPU tensor→data 指向显存</text>
  <text x="400" y="390" font-size="10" fill="#94a3b8">llama-model-loader.cpp:1389 (CPU) / :1562 (GPU)</text>
</svg>
<span class="figure-caption">图 T3.1 ｜ load_tensors 的三阶段:mmap 建映射 → 后端 buffer 创建 → load_all_data 零拷贝/GPU 上传</span>

<details>
<summary>ASCII 原版</summary>

```
load_tensors(ml)                         src/llama-model.cpp:1160
  |
  +-- ml.init_mappings(true, ...)        src/llama-model-loader.cpp:1333
  |     for each file:
  |       llama_mmap(file, prefetch=-1)  src/llama-mmap.cpp:620
  |         mmap(NULL, size, PROT_READ,
  |              MAP_SHARED, fd, 0)      src/llama-mmap.cpp:457
  |       mappings.push_back(mapping)
  |
  +-- 为每个 buft/ctx 创建后端 buffer    src/llama-model.cpp:1432
  |     如果 buft 是 CPU host 类型 且
  |     supports buffer_from_host_ptr:
  |       ggml_backend_dev_buffer_from_host_ptr(
  |           dev, mmap_addr+first, last-first)
  |            <- 把 mmap 区域包成 backend buffer
  |     否则(GPU 层):
  |       ggml_backend_alloc_ctx_tensors_from_buft
  |            <- 在 GPU 上申请真实设备 buffer
  |
  +-- ml.load_all_data(ctx, buf_map)     src/llama-model.cpp:1545
        for each tensor:
          [CPU 层, use_mmap=true]
            cur->data = mmap_addr + w.offs   <- 零拷贝
                                          src/llama-model-loader.cpp:1389
          [GPU 层, use_mmap=true]
            ggml_backend_tensor_set(cur,
                mmap_addr + w.offs, ...)     <- memcpy 到显存
                                          src/llama-model-loader.cpp:1562
```

</details>

mmap 的关键调用(`src/llama-mmap.cpp:457`):

```cpp
addr = mmap(NULL, file->size(), PROT_READ, MAP_SHARED, fd, 0);
```

- `PROT_READ`:只读映射,防止意外修改模型权重。
- `MAP_SHARED`:映射与内核页缓存共享同一套物理页,进程与内核不各自维护一份。
- `fd, 0`:从文件头开始映射整个文件。

**page fault 惰性加载**:

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="mmap page fault lazy loading sequence">
  <defs>
    <marker id="ar3b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="300" fill="#f8fafc" rx="6"/>
  <rect x="20" y="20" width="200" height="50" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">mmap() 调用完成</text>
  <text x="120" y="60" text-anchor="middle" font-size="10" fill="#64748b">虚拟地址 [addr, addr+size)</text>
  <text x="230" y="48" font-size="10" fill="#94a3b8">物理内存:空</text>
  <line x1="120" y1="70" x2="120" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3b)"/>
  <rect x="20" y="100" width="200" height="50" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="120" y="122" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">推理时访问第 L 层权重</text>
  <text x="120" y="140" text-anchor="middle" font-size="10" fill="#64748b">CPU 产生缺页中断 (page fault)</text>
  <line x1="120" y1="150" x2="120" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3b)"/>
  <rect x="20" y="180" width="200" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="120" y="202" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">内核换入 4 KB 页</text>
  <text x="120" y="220" text-anchor="middle" font-size="10" fill="#64748b">磁盘/SSD → RAM → 页表</text>
  <line x1="120" y1="230" x2="120" y2="260" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar3b)"/>
  <rect x="20" y="260" width="200" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="120" y="280" text-anchor="middle" font-size="11" fill="#64748b">该页留在 RAM (LRU),下次无需读盘</text>
  <rect x="300" y="20" width="440" height="260" rx="8" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="520" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">内存状态对比</text>
  <line x1="300" y1="54" x2="740" y2="54" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="380" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">mmap 后(立即)</text>
  <rect x="312" y="84" width="156" height="40" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="390" y="104" text-anchor="middle" font-size="11" fill="#64748b">虚拟地址:已映射</text>
  <text x="390" y="118" text-anchor="middle" font-size="10" fill="#94a3b8">物理页:0 个</text>
  <text x="600" y="76" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">访问后(按需换入)</text>
  <rect x="488" y="84" width="240" height="40" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="608" y="104" text-anchor="middle" font-size="11" fill="#64748b">虚拟地址:已映射</text>
  <text x="608" y="118" text-anchor="middle" font-size="10" fill="#64748b">物理页:仅被访问的层</text>
  <line x1="300" y1="136" x2="740" y2="136" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="520" y="158" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">与 fread 对比</text>
  <rect x="312" y="166" width="200" height="50" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="412" y="186" text-anchor="middle" font-size="11" fill="#64748b">fread:启动即读完整文件</text>
  <text x="412" y="202" text-anchor="middle" font-size="10" fill="#94a3b8">400MB 模型 → 等 400MB I/O</text>
  <text x="412" y="215" text-anchor="middle" font-size="10" fill="#94a3b8">双倍内存占用</text>
  <rect x="524" y="166" width="204" height="50" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="626" y="186" text-anchor="middle" font-size="11" fill="#64748b">mmap:启动几乎零 I/O</text>
  <text x="626" y="202" text-anchor="middle" font-size="10" fill="#64748b">惰性换页,共享页缓存</text>
  <text x="626" y="215" text-anchor="middle" font-size="10" fill="#64748b">无多余拷贝</text>
</svg>
<span class="figure-caption">图 T3.2 ｜ mmap 惰性加载:page fault 按需换入与 fread 的内存对比</span>

<details>
<summary>ASCII 原版</summary>

```
mmap 调用完成        ->  进程虚拟地址空间里出现了一段 [addr, addr+size)
                         此时物理内存里什么都没有
                         |
推理时访问第 L 层权重  ->  CPU 产生缺页中断(page fault)
                         |
内核把对应的 4 KB 页   ->  从磁盘/SSD 换入 RAM,挂到进程页表
从文件读入               |
                         计算完成后该页留在 RAM(LRU 缓存)
                         下次访问同一权重无需再读盘
```

</details>

对于 `-ngl 99`(全部层放 GPU)的情况,`load_all_data` 里的 `mmap_addr + w.offs` 访问会触发所有页的换入,GPU 上传完成后这些页可以被内核回收(通过 `unmap_fragment` 归还)。

**`--no-mmap` 回退路径**:

当用户传 `--no-mmap` 时,`use_mmap = false`,`load_data_for` 走另一条分支(`src/llama-model-loader.cpp:1393`):

```cpp
file->seek(w.offs, SEEK_SET);
file->read_raw(cur->data, ggml_nbytes(cur));
```

这是标准的 `fseek` + `fread`,要求 `cur->data` 已经由 `ggml_backend_alloc_ctx_tensors_from_buft` 预先分配好,会产生完整的 I/O 拷贝。速度更慢、内存更高,但在不支持 mmap 的环境(某些嵌入式系统、加密文件系统)下是唯一选项。

## 6. 代码位置

按阅读顺序:

- `load_tensors` 入口:`src/llama-model.cpp:1160`
- `ml.init_mappings` 调用:`src/llama-model.cpp:1421`
- `init_mappings` 实现:`src/llama-model-loader.cpp:1333` —— 对每个文件构造 `llama_mmap`
- `llama_mmap` 构造函数:`src/llama-mmap.cpp:620`
- POSIX `mmap` 调用:`src/llama-mmap.cpp:457` —— `mmap(NULL, size, PROT_READ, MAP_SHARED, fd, 0)`
- `unmap_fragment`(归还已上传给 GPU 的页):`src/llama-mmap.cpp:490`
- CPU host buffer 从 mmap 区创建:`src/llama-model.cpp:1458`-`1478`
- GPU buffer 分配:`src/llama-model.cpp:1480`-`1499`
- `load_all_data` 函数签名:`src/llama-model-loader.cpp:1406`
- `load_all_data` mmap 路径(CPU):`src/llama-model-loader.cpp:1542` —— `data = mmap_addr + offset`
- `load_all_data` mmap 路径(GPU):`src/llama-model-loader.cpp:1562` —— `ggml_backend_tensor_set`
- `load_all_data` 调用点:`src/llama-model.cpp:1545`
- `load_data_for`(单张量版,供 no-mmap):`src/llama-model-loader.cpp:1383`

## 7. 分支与延伸

- mmap 的原理、`MAP_SHARED` vs `MAP_PRIVATE`、page fault 与 TLB 的关系 → [第 2 章 GGUF 与模型加载](02-gguf-and-model-loading.md)
- `ggml_tensor` 的 `data` 指针、`nb[]` stride 数组以及 buffer 所有权模型 → [第 4 章 GGML 张量](04-ggml-tensor-and-graph.md)
- `ggml_backend_buffer_from_host_ptr`:Metal/CUDA 如何把 mmap 区域封装成可被 GPU 访问的 buffer → [第 4 章](04-ggml-tensor-and-graph.md)
- `--no-mmap` 选项在 `llama_model_params` 中的字段名是 `use_mmap`(默认 `true`) → [第 2 章](02-gguf-and-model-loading.md)
- `--mlock` 选项:通过 `mlock`/`VirtualLock` 防止 mmap 页被换出,适合延迟敏感场景 → [第 2 章](02-gguf-and-model-loading.md)
- `unmap_fragment`:GPU 上传完成后主动归还不再需要的 mmap 页以节省 RAM → [第 2 章](02-gguf-and-model-loading.md)
- 后端 buffer 分配与 `ggml_backend_buffer_type` 的层级关系 → [第 9 章 GGML 后端系统](09-ggml-backend.md)

## 8. 走完这一步你脑子里应该多了什么

1. **mmap 是"不拷贝"的秘密**。`mmap` 只建虚拟地址映射,实际的磁盘读 I/O 分散到推理时第一次访问各页时按需发生——这就是"page fault 惰性加载"。启动时几乎没有真正的 I/O。
2. **CPU 侧张量的 `->data` 直接指向 mmap 区**(`llama-model-loader.cpp:1389`)。没有额外的 `malloc`,也没有 `memcpy`——内核的页缓存就是模型权重的内存。
3. **GPU 侧必须真正拷贝**。GPU 访问不了普通的进程虚拟地址,所以从 mmap 区到设备内存的 `memcpy`(或异步 DMA)是必要且不可省略的。
4. **`--no-mmap` 是一条完整的备用路径**,通过 `fseek + fread` 把权重读进预分配的 CPU 缓冲区,代价是更高的内存和更长的启动时间。
5. 走完这步,`llama_model` 里的每个 `ggml_tensor->data` 都有效了:CPU 层指向 mmap 区某偏移,GPU 层指向设备内存——后续所有矩阵乘法都可以直接使用。

下一步:[步骤 04 —— 识别模型架构](tour-04-arch-detect.md)。
