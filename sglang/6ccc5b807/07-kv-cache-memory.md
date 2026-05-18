# 第 07 章 KV Cache 内存管理

## 本章导读

[第 06 章](06-radix-cache.md) 讲 RadixAttention 用 radix tree 复用 KV——但那是「逻辑层」:树管的是「哪段 token 序列对应哪些 KV 索引」。本章讲「物理层」:这些 KV **数值本身**存在哪、显存怎么切、满了怎么腾。

KV cache 是 LLM 推理里最吃显存、也最影响吞吐的一块。一个引擎能同时跑多少请求、支持多长上下文,几乎全由 KV 内存管理决定。本章拆解 SGLang 的方案,核心代码在 `python/sglang/srt/mem_cache/` 目录。

## 1. 问题:KV cache 为什么难管

每个 token 在每一层都要存一份 Key 和一份 Value,供后续 token 的注意力复用。一个请求生成得越长,它的 KV 就越多。难点在:

1. **总量巨大且固定**:KV 占的显存是 `序列长度 × 层数 × 2 × num_kv_heads × head_dim × dtype字节数`。一张卡的显存就那么多,装不下就没法再收请求。
2. **每个请求的长度事先未知**:请求会生成多少 token,取决于模型何时输出 EOS——调度时根本不知道。
3. **请求频繁进出**:连续批处理下,请求随时结束、随时加入。KV 空间不断被分配、释放。

如果用最朴素的「每个请求切一段连续显存」:长度未知就只能按最大长度预留,绝大多数请求用不满,显存浪费极严重;请求进出又会把显存切成碎片,总量够却找不到连续块。这个分析在 [导览步骤 11](tour-11-alloc-kv.md) 第 4 节有详述。

结论:KV 内存必须**池化 + 分页**。

## 2. 总体设计:三层结构

SGLang 的 KV 内存管理分三层,各司其职:

<svg viewBox="0 0 560 230" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three-layer structure of KV cache memory management">
<rect x="40" y="20" width="480" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.4"/>
<text x="60" y="44" font-size="12" font-weight="700" fill="currentColor">映射层　ReqToTokenPool</text>
<text x="60" y="64" font-size="10" fill="#64748b">req_to_token[i][j] = 第 i 请求第 j token 的 KV 物理索引</text>
<rect x="40" y="86" width="480" height="56" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
<text x="60" y="110" font-size="12" font-weight="700" fill="currentColor">分配层　TokenToKVPoolAllocator</text>
<text x="60" y="130" font-size="10" fill="#64748b">管空闲页，alloc 取页 / free 还页</text>
<rect x="40" y="152" width="480" height="56" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.4"/>
<text x="60" y="176" font-size="12" font-weight="700" fill="currentColor">存储层　KVCache（MHATokenToKVPool 等）</text>
<text x="60" y="196" font-size="10" fill="#64748b">真正存 K/V 张量的大块显存</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ KV cache 内存管理的三层结构：映射层翻译、分配层管空闲页、存储层存真实 K/V</span>

<details>
<summary>ASCII 原版</summary>

```text
  ┌──────────────────────────────────────────────────┐
  │ 映射层  ReqToTokenPool                            │
  │   req_to_token[i][j] = 第 i 请求第 j token 的     │
  │                        KV 物理索引                │
  ├──────────────────────────────────────────────────┤
  │ 分配层  TokenToKVPoolAllocator                    │
  │   管空闲页,alloc 取页 / free 还页 (见第 11 步)   │
  ├──────────────────────────────────────────────────┤
  │ 存储层  KVCache (MHATokenToKVPool 等)             │
  │   真正存 K/V 张量的大块显存                       │
  └──────────────────────────────────────────────────┘
```

</details>

- **映射层** `ReqToTokenPool`:逻辑到物理的翻译表;
- **分配层** `TokenToKVPoolAllocator`:管「哪些物理页空闲」(在 `allocator.py`,[导览步骤 11](tour-11-alloc-kv.md) 已细讲);
- **存储层** `KVCache`:实际存 K/V 数值的显存。

本章重点讲映射层和存储层。

## 3. 映射层:`ReqToTokenPool`

定义在 `python/sglang/srt/mem_cache/memory_pool.py:128`。

它是一张二维表:`req_to_token[i][j]` = 「内存里第 i 个请求槽位的逻辑第 j 个 token」对应 KV 存储层里的物理索引。

为什么需要它?因为分页之后,一个请求逻辑上连续的 token,物理上散落在不连续的页里。注意力 kernel 要读第 j 个 token 的 KV,得先查这张表拿到物理位置。`ReqToTokenPool` 就是「逻辑序列 ↔ 物理 KV」之间唯一的翻译器。

它本身也是个池子——`available_size`(`memory_pool.py:157`)报还能容纳多少请求,`alloc`(`:160`)为一批 `Req` 分配请求槽位。它的容量决定了引擎能**同时**跟踪多少个请求。

`HybridReqToTokenPool`(`memory_pool.py:487`)是它的混合变体,用于同时有 full attention 和 SWA(滑动窗口注意力)层的模型。

## 4. 存储层:`KVCache` 与 `MHATokenToKVPool`

存储层的抽象基类是 `KVCache`(`memory_pool.py:693`)。它定义了 KV 池的统一接口:

- `get_key_buffer(layer_id)`(`:755`)/ `get_kv_buffer(layer_id)`(`:763`):取某一层的 K / K&V 缓冲;
- `set_kv_buffer(...)`(`:767`):把新算的 K/V 写进池子。

最主流的实现是 **`MHATokenToKVPool`**(`memory_pool.py:789`)——标准多头注意力(MHA / GQA)的 KV 池。

### 物理布局

`MHATokenToKVPool` 为**每一层**各开一块大显存。布局是分页的(`memory_pool.py:960` 的注释点明):

```text
  layer_num × [page_num, page_size, head_num, head_dim]
```

也就是说:每层一块,这块按 `page_num` 个页切,每页装 `page_size` 个 token,每个 token 有 `head_num × head_dim` 的 K(V 同理)。`page_size` 是分页粒度——`page_size` 个 token 凑一页,整页分配、整页释放。

K 和 V 各占一块(`:908`、`:916` 分别建 key/value buffer)。写 KV 时 `set_kv_buffer`(`:1047`)把某个 token 这一层的 K/V 写进它分到的物理页;读 KV 时注意力后端通过 `get_kv_buffer`(`:1044`)拿到整层缓冲、再按索引表取(见 [第 10 章](10-attention-backends.md)、[导览步骤 15](tour-15-attention-kernel.md))。

### 其他存储变体

`mem_cache/` 下还有一系列针对不同模型/场景的 KV 池:

| 类 | 用途 |
|----|------|
| `MHATokenToKVPool` | 标准 MHA / GQA 模型(`memory_pool.py:789`) |
| `MLATokenToKVPool` 系列 | DeepSeek 的 MLA(多头潜在注意力),KV 被压缩,显存占用小得多 |
| `MambaPool`(`memory_pool.py:195`) | Mamba / 状态空间模型——它没有传统 KV,存的是状态 |
| `NoOpMHATokenToKVPool`(`:1136`) | 占位池,用于某些不需要真实 KV 存储的路径 |
| `deepseek_v4_memory_pool.py` 等 | 特定模型的专用池 |

这种「一个抽象基类 `KVCache` + 多个具体实现」的结构,让 SGLang 能在不动注意力上层逻辑的前提下,为新模型架构接入新的 KV 存储方式。

## 5. 池子开多大:`max_total_num_tokens`

KV 存储层的容量,落到一个数字——`max_total_num_tokens`,即整个引擎在任意时刻最多能为多少个 token 存 KV。

这个数字在 `ModelRunner.init_memory_pool` 里算出(见 [导览步骤 04](tour-04-size-kv-pool.md)):

```text
  GPU 总显存 × mem_fraction_static          = 静态显存预算
  静态预算 − 模型权重占用                   = KV 池可用显存
  KV 池可用显存 ÷ (每 token 每层 KV 字节数) = max_total_num_tokens
```

`mem_fraction_static` 是用户可调参数——它划定「权重 + KV 池」最多占多少显存,剩下的留给前向激活值、CUDA graph 等动态开销。设太大会运行时 OOM,设太小则并发能力受限。

关键性质:KV 池**启动时一次性预分配,运行中永不 resize**。这是为了杜绝运行时显存碎片和不确定延迟。`max_total_num_tokens` 算出后就是引擎的硬容量上限,调度器所有「还能不能收请求」的判断都基于它(见 [第 08 章](08-scheduler.md))。

## 6. 满了怎么办:淘汰策略

KV 池总会满。满了之后,新请求要 KV,就得腾空间——把一些**当前没被任何活跃请求使用**的 KV 释放掉。哪些先释放?这就是淘汰策略。

注意:能被淘汰的 KV,通常是 radix tree 里**缓存着、供未来复用、但此刻没有活跃请求引用**的前缀 KV(`lock ref` 为 0 的节点,见 [第 06 章](06-radix-cache.md))。淘汰它们 = 牺牲「未来可能的前缀命中」换「当下的可用空间」。

SGLang 把淘汰策略抽象成 `EvictionStrategy`(`python/sglang/srt/mem_cache/evict_policy.py:10`),提供一组实现:

| 策略 | 类 | 含义 |
|------|-----|------|
| LRU | `LRUStrategy`(`:16`) | 最久未访问的先淘汰——最常用 |
| LFU | `LFUStrategy`(`:21`) | 访问次数最少的先淘汰 |
| FIFO | `FIFOStrategy`(`:26`) | 最早进来的先淘汰 |
| MRU | `MRUStrategy`(`:31`) | 最近访问的先淘汰 |
| FILO | `FILOStrategy`(`:36`) | 最晚进来的先淘汰 |
| Priority | `PriorityStrategy`(`:41`) | 按优先级,低优先先淘汰,同优先级内 LRU |
| SLRU | `SLRUStrategy`(`:49`) | 分段 LRU |

默认 LRU 的逻辑朴素而有效:最久没被碰过的前缀,未来再被命中的概率也最低,优先牺牲它。`match_prefix` 每次匹配都会刷新节点的访问时间戳(见 [第 06 章](06-radix-cache.md)),正是为淘汰策略提供「最近访问」信息。

## 7. 突破单卡:HiCache 分级缓存

单卡显存有限,能缓存的前缀 KV 总量受 `max_total_num_tokens` 卡死。但**主机内存(CPU RAM)**通常比显存大一两个数量级。能不能把「冷」的前缀 KV 挪到主机内存,需要时再搬回显存?

这就是 **HiCache(Hierarchical Cache,分级缓存)**。它的存储层在 `python/sglang/srt/mem_cache/memory_pool_host.py`:

- `HostKVCache`(`:155`)是主机侧 KV 池的抽象基类;
- `MHATokenToKVPoolHost`(`:291`)、`MLATokenToKVPoolHost`(`:788`)等是对应设备侧池子的主机版本。

逻辑层对应 `HiRadixCache`(`python/sglang/srt/mem_cache/hiradix_cache.py:68`),它继承 `RadixCache`,在普通 radix tree 之上多管一层「这个前缀节点的 KV 在显存还是在主机」。

工作方式:

<svg viewBox="0 0 560 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="HiCache moves cold KV between device memory and host memory">
<defs>
<marker id="r7ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="40" y="50" width="180" height="100" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="130" y="78" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">设备显存</text>
<text x="130" y="98" text-anchor="middle" font-size="10" fill="#64748b">快 · 小</text>
<text x="130" y="124" text-anchor="middle" font-size="11" fill="#ea580c">热 KV</text>
<rect x="340" y="50" width="200" height="100" rx="10" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.5"/>
<text x="440" y="78" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">主机内存</text>
<text x="440" y="98" text-anchor="middle" font-size="10" fill="#64748b">慢 · 大（容量数量级提升）</text>
<text x="440" y="124" text-anchor="middle" font-size="11" fill="#0d9488">冷 KV</text>
<line x1="222" y1="82" x2="338" y2="82" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#r7ar)"/>
<text x="280" y="74" text-anchor="middle" font-size="10" fill="#64748b">写出（offload，被淘汰时）</text>
<line x1="338" y1="118" x2="222" y2="118" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="4,3" marker-end="url(#r7ar)"/>
<text x="280" y="138" text-anchor="middle" font-size="10" fill="#64748b">搬回（load back，命中时）</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ HiCache：冷的前缀 KV 在设备显存与主机内存间写出/搬回，突破单卡显存对缓存容量的限制</span>

<details>
<summary>ASCII 原版</summary>

```text
  设备显存 (快,小)        主机内存 (慢,大)
  ┌──────────────┐        ┌──────────────────┐
  │ 热 KV        │ ──写出──► │ 冷 KV            │
  │              │ ◄─load back─ │                  │
  └──────────────┘        └──────────────────┘
```

</details>

- 显存里的前缀 KV 要被淘汰时,不直接丢弃,而是**写出(offload)到主机内存**;
- 之后若有请求命中这个前缀,把 KV 从主机**搬回(load back)显存**再用。

`match_prefix` 返回的 `MatchResult` 里 `last_device_node` / `last_host_node` 之分(见 [第 06 章](06-radix-cache.md))就是为 HiCache 服务的——告诉调度器命中的前缀有多少在显存、多少要从主机搬回。

代价是 host↔device 的传输带宽和延迟,但换来的是**缓存容量数量级的提升**——对前缀复用率高的负载(同一系统提示被海量请求共用)非常划算。`mem_cache/storage/`、`hicache_storage.py` 还支持把 KV 进一步外溢到磁盘/远端存储。

## 8. 与其他子系统的接口

KV 内存管理是个底层服务,几乎和所有上层都有接口:

- **RadixCache**([第 06 章](06-radix-cache.md)):radix tree 节点存的「KV 索引」,指的就是存储层的物理索引;`insert` / `evict` 操作的是这一层。
- **Scheduler**([第 08 章](08-scheduler.md)):调度前查 `available_size` 决定能否再收请求;`PrefillAdder` 的预算之一就是 KV 余量。
- **ModelRunner / 注意力后端**([第 09 章](09-model-runner.md)、[第 10 章](10-attention-backends.md)):前向时通过 `set_kv_buffer` 写新 KV、通过索引表读历史 KV。
- **Req**([第 05 章](05-request-data-structures.md)):`Req.kv_committed_len` / `kv_allocated_len` 记录这个请求的 KV 占用状态。

## 相关章节

- [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md) —— KV 索引的逻辑层管理
- [第 08 章 调度器与连续批处理](08-scheduler.md) —— 调度器如何用 KV 余量做收请求决策
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— `max_total_num_tokens` 的计算、KV 池初始化
- [第 10 章 注意力后端与 CUDA 内核](10-attention-backends.md) —— 注意力 kernel 如何读写 KV 池
- [导览步骤 04](tour-04-size-kv-pool.md)、[步骤 11](tour-11-alloc-kv.md) —— KV 定容与分配的实际 trace
