# Trace 步骤 02 —— `llama_model_load_from_file` 到底打开了什么?

## 1. 当前情境

上一步(`ggml_backend_load_all`)已经扫好了这台机器上的算力家底:全局后端注册表里有 CPU、Metal(或 CUDA)等可用后端,随时可以接派活。

`simple.cpp` 接下来做的事(`examples/simple/simple.cpp:89`):

```cpp
llama_model * model = llama_model_load_from_file(model_path.c_str(), model_params);
```

这一行返回之前,需要读进一个 GGUF 文件,而 GGUF 文件里最重的东西是几百 MB 的权重数据。此刻还没有任何张量,没有任何模型结构信息。本步只负责把文件"打开"并"读懂文件头"——建立起从张量名到文件偏移的完整索引;权重数据本身留到步骤 03 才进内存。

## 2. 问题

一个 GGUF 文件的结构是:固定文件头(magic + version + 计数) → 若干 KV 元数据对(架构名、超参数、分词器配置……) → 若干张量信息记录(名字 + 形状 + 量化类型 + 数据在文件内的偏移) → 对齐填充 → 连续的权重数据区。

在把权重读进内存之前,必须先回答三个问题:

1. **这个文件合法吗?** magic 对不对、version 是否支持、张量数和 KV 数是否在合理范围?
2. **模型有哪些超参数?** 架构名、层数、头数、embedding 维度、RoPE 参数……后续初始化全靠它们。
3. **每个权重张量在文件的哪个位置?** 名字→类型→形状→偏移,不建这张索引,后面 mmap 或者 read 都没法精准指向。

## 3. 朴素思路

最直接的想法:用 `fopen` 打开文件,`fread` 整个文件进内存,然后从内存 buffer 里解析结构。反正最终权重也要进内存,一步到位不更省事吗?

## 4. 为什么朴素思路会崩

- **内存开销在解析阶段就爆**。一个 7B Q4 模型文件约 4 GB。解析元数据只需要文件头的几百 KB,把整个文件先读进来才能"开始解析"——这是几十倍的浪费。
- **读入时序错乱**。文件头包含张量数和 KV 数两个计数,必须先读头才知道要分配多大的结构体数组。而"全部先读进来"意味着在分配数组之前就已经把所有内容拷进了内存,随机访问一个未经解析的裸 buffer 很容易越界。
- **多文件分片支持困难**。超大模型可能分成多个 GGUF 分片文件(`-00001-of-00004.gguf`),每个分片都这么处理意味着要同时持有所有分片的完整内容,显然行不通。
- **无法区分"读元数据"和"读权重"两个阶段**。权重数据是否要进内存、进哪种内存(CPU RAM vs 显存),取决于后端分配结果——而那要到步骤 03 才决定。如果提前把权重也读进来,步骤 03 只能把它拷到正确的地方,白白多一次拷贝。

## 5. llama.cpp 的做法

llama.cpp 把"打开文件"拆成两个干净的阶段,严格分离"读元数据"和"映射权重数据"。本步只负责第一阶段。

**调用链总览**:

<svg viewBox="0 0 760 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_model_load_from_file call chain">
  <defs>
    <marker id="ar2a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="280" fill="#f8fafc" rx="6"/>
  <text x="16" y="28" font-size="11" fill="#94a3b8">调用层级</text>
  <rect x="16" y="38" width="280" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="156" y="57" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama_model_load_from_file()</text>
  <text x="310" y="57" font-size="10" fill="#94a3b8">src/llama.cpp:423</text>
  <line x1="36" y1="66" x2="36" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2a)"/>
  <rect x="36" y="78" width="280" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="176" y="97" text-anchor="middle" font-size="12" fill="#64748b">llama_model_load_from_file_impl()</text>
  <text x="330" y="97" font-size="10" fill="#94a3b8">src/llama.cpp:338</text>
  <line x1="56" y1="106" x2="56" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2a)"/>
  <rect x="56" y="118" width="260" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="186" y="137" text-anchor="middle" font-size="12" fill="#64748b">llama_model_load()</text>
  <text x="330" y="137" font-size="10" fill="#94a3b8">src/llama.cpp:276</text>
  <line x1="76" y1="146" x2="76" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2a)"/>
  <rect x="76" y="158" width="280" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="216" y="177" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_model_loader() 构造函数</text>
  <text x="370" y="177" font-size="10" fill="#94a3b8">llama-model-loader.cpp:510</text>
  <line x1="96" y1="186" x2="96" y2="198" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2a)"/>
  <rect x="96" y="198" width="280" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="236" y="217" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">gguf_init_from_file(no_alloc=true)</text>
  <text x="390" y="217" font-size="10" fill="#94a3b8">ggml/src/gguf.cpp:847</text>
  <line x1="116" y1="226" x2="116" y2="238" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2a)"/>
  <rect x="116" y="238" width="280" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="256" y="257" text-anchor="middle" font-size="12" fill="#64748b">gguf_init_from_file_ptr(file, params)</text>
  <text x="410" y="257" font-size="10" fill="#94a3b8">ggml/src/gguf.cpp:397</text>
</svg>
<span class="figure-caption">图 T2.1 ｜ llama_model_load_from_file 调用链</span>

<details>
<summary>ASCII 原版</summary>

```
simple.cpp:89
  llama_model_load_from_file()                        src/llama.cpp:423
    llama_model_load_from_file_impl()                 src/llama.cpp:338
      llama_model_load()                              src/llama.cpp:276
        llama_model_loader(fname, ...)   [构造函数]   src/llama-model-loader.cpp:510
          gguf_init_from_file(fname, {no_alloc=true}) ggml/src/gguf.cpp:847
            gguf_init_from_file_ptr(file, params)     ggml/src/gguf.cpp:397
```

</details>

**`gguf_init_from_file_ptr` 的四步顺序解析**(`ggml/src/gguf.cpp:397`):

<svg viewBox="0 0 760 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="gguf_init_from_file_ptr four-step sequential parsing">
  <defs>
    <marker id="ar2b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="380" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="100" height="340" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="66" y="192" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor" transform="rotate(-90,66,192)">文 件 流(顺序读取)</text>
  <line x1="116" y1="50" x2="150" y2="50" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <rect x="150" y="28" width="320" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="310" y="47" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">[1] 读 magic 并校验 == "GGUF"</text>
  <text x="310" y="63" text-anchor="middle" font-size="10" fill="#94a3b8">gguf.cpp:408-428</text>
  <line x1="116" y1="120" x2="150" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <rect x="150" y="98" width="320" height="44" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="310" y="117" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">[2] 读文件头:version / n_tensors / n_kv</text>
  <text x="310" y="133" text-anchor="middle" font-size="10" fill="#94a3b8">gguf.cpp:435, 466, 477</text>
  <line x1="116" y1="200" x2="150" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <rect x="150" y="178" width="320" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="310" y="197" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">[3] 逐条解析 n_kv 个 KV 对</text>
  <text x="310" y="213" text-anchor="middle" font-size="10" fill="#94a3b8">key + type + value → ctx-&gt;kv   gguf.cpp:496</text>
  <line x1="116" y1="290" x2="150" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <rect x="150" y="268" width="320" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="310" y="287" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">[4] 逐条解析 n_tensors 个张量信息</text>
  <text x="310" y="303" text-anchor="middle" font-size="10" fill="#94a3b8">name+shape+type+offset → ctx-&gt;info   gguf.cpp:571</text>
  <line x1="470" y1="50" x2="530" y2="50" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <line x1="470" y1="120" x2="530" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <line x1="470" y1="200" x2="530" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <line x1="470" y1="290" x2="530" y2="290" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar2b)"/>
  <rect x="530" y="14" width="210" height="340" rx="8" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="635" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">gguf_context</text>
  <line x1="530" y1="48" x2="740" y2="48" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="542" y="68" font-size="11" fill="#64748b">version</text>
  <text x="542" y="88" font-size="11" fill="#64748b">n_tensors, n_kv</text>
  <line x1="530" y1="98" x2="740" y2="98" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="542" y="118" font-size="11" fill="#64748b">kv[ ]</text>
  <text x="542" y="134" font-size="10" fill="#94a3b8">std::vector&lt;gguf_kv&gt;</text>
  <line x1="530" y1="148" x2="740" y2="148" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="542" y="172" font-size="11" fill="#64748b">info[ ]</text>
  <text x="542" y="188" font-size="10" fill="#94a3b8">std::vector&lt;gguf_tensor_info&gt;</text>
  <text x="542" y="208" font-size="10" fill="#94a3b8">含 offset 字段</text>
  <line x1="530" y1="220" x2="740" y2="220" stroke="#cbd5e1" stroke-width="0.8"/>
  <text x="542" y="244" font-size="11" fill="#64748b">offset (数据区起点)</text>
  <text x="542" y="264" font-size="11" fill="#64748b">size</text>
  <text x="542" y="284" font-size="11" fill="#64748b">data = nullptr</text>
  <text x="635" y="310" text-anchor="middle" font-size="10" fill="#94a3b8">no_alloc=true</text>
  <text x="635" y="326" text-anchor="middle" font-size="10" fill="#94a3b8">权重不进内存</text>
  <text x="635" y="348" text-anchor="middle" font-size="10" fill="#ea580c">→ 步骤 03 再 mmap</text>
</svg>
<span class="figure-caption">图 T2.2 ｜ gguf_init_from_file_ptr 四步顺序解析与产出的 gguf_context 结构</span>

<details>
<summary>ASCII 原版</summary>

```
文件流
  |
  +-- [1] 读 4 字节 magic,校验必须 == "GGUF"      gguf.cpp:408-428
  |
  +-- [2] 读文件头三个字段:
  |         version  (uint32)                       gguf.cpp:435
  |         n_tensors (int64)                        gguf.cpp:466
  |         n_kv      (int64)                        gguf.cpp:477
  |
  +-- [3] 逐条解析 n_kv 个 KV 对:                  gguf.cpp:496
  |         key (string)
  |         type (gguf_type)
  |         value (按类型分支读取)
  |       -> 全部存入 ctx->kv (std::vector<gguf_kv>)
  |
  +-- [4] 逐条解析 n_tensors 个张量信息:           gguf.cpp:571
            name (string)
            n_dims (uint32) + ne[i] (int64[n_dims])
            type (ggml_type)
            offset (uint64)  <- 距数据区起点的偏移
          -> 全部存入 ctx->info (std::vector<gguf_tensor_info>)
          -> ctx->offset 记录数据区在文件中的起始位置  gguf.cpp:710
```

</details>

解析完成后,`gguf_init_from_file_ptr` 返回一个 `gguf_context *`(`ggml/src/gguf.cpp:217`):

```cpp
struct gguf_context {
    uint32_t version;
    std::vector<gguf_kv>          kv;    // 所有元数据键值
    std::vector<gguf_tensor_info> info;  // 所有张量信息 (含 offset)
    size_t alignment;  // 数据区对齐粒度
    size_t offset;     // 数据区在文件内的起点
    size_t size;       // 数据区总大小
    void * data;       // 本步 no_alloc=true,始终为 nullptr
};
```

注意 `gguf_init_params.no_alloc = true`(`src/llama-model-loader.cpp:541`)。这是关键:要求 `gguf_init_from_file` **只建张量元信息**(名字、形状、类型、偏移),不读也不分配权重数据。`ctx->data` 在这一步永远是 `nullptr`。

**`llama_model_loader` 构造函数收尾**(`src/llama-model-loader.cpp:510`):

1. 调用 `gguf_init_from_file` 取得 `metadata`(`llama-model-loader.cpp:545`)。
2. 立即从 KV 读出 `general.architecture` 字段并调用 `llm_arch_from_string` 得到架构枚举,存入 `llm_kv`(`llama-model-loader.cpp:551-552`)。
3. 遍历 `ggml_context` 里的每个张量对象,把 `(名字 → llama_tensor_weight{file, idx, tensor, offset})` 塞进 `weights_map`(`llama-model-loader.cpp:574-583`)。这是后续步骤用来按名字查偏移的索引。
4. 检测是否有 `split.count > 1`,若是则依次打开每个分片的 GGUF 并把其中的张量追加进 `weights_map`(`llama-model-loader.cpp:588-663`)。

## 6. 代码位置

按阅读顺序:

- 调用点:`examples/simple/simple.cpp:89` —— `llama_model_load_from_file`
- 公开 API 实现:`src/llama.cpp:423` —— `llama_model_load_from_file`
- impl 包装:`src/llama.cpp:338` —— `llama_model_load_from_file_impl`
- 核心加载函数:`src/llama.cpp:276` —— `llama_model_load`(在这里构造 `llama_model_loader`)
- loader 构造函数:`src/llama-model-loader.cpp:510` —— `llama_model_loader::llama_model_loader`
- `gguf_init_from_file` 文件打开:`ggml/src/gguf.cpp:847`
- `gguf_init_from_file_ptr` 核心解析:`ggml/src/gguf.cpp:397`
- magic 校验:`ggml/src/gguf.cpp:408`
- 文件头读取:`ggml/src/gguf.cpp:431`-`492`
- KV 对解析循环:`ggml/src/gguf.cpp:496`
- 张量信息解析循环:`ggml/src/gguf.cpp:571`
- 数据区偏移记录:`ggml/src/gguf.cpp:710`
- `gguf_context` 结构体:`ggml/src/gguf.cpp:217`
- `gguf_tensor_info` 结构体:`ggml/src/gguf.cpp:212`
- GGUF 文件格式注释:`ggml/include/gguf.h:1`-`32`
- `weights_map` 建立:`src/llama-model-loader.cpp:574`-`583`
- 架构名解析:`src/llama-model-loader.cpp:551`-`552`

## 7. 分支与延伸

- GGUF 格式的完整规范(magic、KV 类型体系、张量信息记录的二进制布局)详见 [第 2 章 GGUF 与模型加载](02-gguf-and-model-loading.md)
- `gguf_context` 里的 `kv` 向量如何被 `llama_model_loader` 的 `get_key` 包装成强类型访问 → [第 2 章](02-gguf-and-model-loading.md)
- `gguf_tensor_info` 中的 `ggml_tensor` 是一个"只有形状和类型的空壳"(`data == nullptr`),真正的张量对象体系 → [第 4 章 GGML 张量](04-ggml-tensor-and-graph.md)
- 多分片(split)GGUF 的文件名约定及合并 `weights_map` 的逻辑 → [第 2 章](02-gguf-and-model-loading.md)
- `no_alloc=true` 的含义:只建元信息不分配数据区 → 下一步骤 [步骤 03:把权重 mmap 进内存](tour-03-tensor-mmap.md)
- `general.architecture` 读出来以后如何对应到 `llm_arch` 枚举 → [步骤 04:识别模型架构](tour-04-arch-detect.md)

## 8. 走完这一步你脑子里应该多了什么

1. **GGUF 文件头是顺序流式读取的**:magic → version → n_tensors → n_kv → KV 表 → 张量信息表 → 对齐填充 → 数据区。解析器不需要随机访问,从头到尾扫一遍就能建好所有索引。
2. **`gguf_context` 是这一步的唯一产物**,它持有所有元数据 KV 对和所有张量的"名字 + 类型 + 形状 + 文件偏移",但 `data == nullptr`——权重数据完全没有进内存。
3. **`llama_model_loader::weights_map` 是"张量名 → (文件句柄, 偏移)"的索引**。步骤 03 靠它知道每个张量在文件的哪个位置;步骤 04 靠它把 hparams 里的 KV 值对应到正确的张量。
4. **`no_alloc=true` 是关键控制参数**:它使 `gguf_init_from_file` 只读元信息不拷数据,把"决定内存布局"的权力留给后面按设备分配的逻辑。
5. **架构名在 loader 构造时已经解码为 `llm_arch` 枚举**(`llm_arch_from_string`),这是一次"字符串世界"到"枚举世界"的转换,后续所有 `switch(arch)` 分支都依赖它。

下一步:[步骤 03 —— 把权重 mmap 进内存](tour-03-tensor-mmap.md)。
