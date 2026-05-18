# Trace 步骤 11 —— 6 个新 token 的 KV，放进池子的哪里？

## 1. 当前情境

上一步 `match_prefix` 在空树上命中 0——我们这 6 个 token 全部是「新」的，没有现成 KV 可复用。`Req` 的 `prefix_indices` 是空的。要跑 prefill，就得先在步骤 04 建好的那个 KV cache 池里，为这 6 个 token 各划出一个 KV 槽位。

## 2. 问题

KV cache 池是一整块固定大小的显存（容量 `max_total_num_tokens` 个 token）。现在要为 6 个 token 安家。问题是：

- 池子里哪些槽位是空的？得有个东西管「空闲 / 占用」；
- 划出来的 6 个槽位，要让后面的注意力内核能找到——「请求的第 j 个 token 在池子的哪个位置」这个映射必须记下来；
- 分配要快——它在调度热路径上，每个请求每一步都要分配。

## 3. 朴素思路

为每个请求在池子里切一段**连续**的显存：请求 A 占 [0, 6)，请求 B 占 [6, 100)……像 C 的 `malloc` 那样,按需切连续块。

## 4. 为什么朴素思路会崩

「连续切块」会被两件事撕碎：

- **长度未知**：请求生成多少 token 事先不知道（取决于模型何时输出 EOS）。要么一开始按 `max` 长度预留一大段——绝大多数请求用不满，**显存浪费**严重，能并发的请求数被压得很低；要么先给一点、不够再扩——但旁边的槽位已经被别的请求占了，**扩不了**。
- **外部碎片**：请求结束释放掉中间一段，池子被切得七零八落。新请求要 6 个连续槽位，总空闲量明明够，却找不到一段连续的 6 格。这就是经典的外部碎片问题。

连续分配的根本错误：把「逻辑上连续的一个序列」和「物理上连续的一块显存」绑死了。

## 5. SGLang 的做法

解绑。SGLang 借鉴操作系统虚拟内存的思路——**分页**：KV 池按 `page_size` 个 token 一页来管理，一个请求的 token 可以散落在池子里**任意的、不连续的**页上。逻辑上的连续序列，由一张映射表来「拼」。

两个组件配合：

- **`ReqToTokenPool`**（`python/sglang/srt/mem_cache/memory_pool.py`）：一张二维映射表。`req_to_token[i][j]` = 「第 i 个请求的第 j 个 token」在 KV 池里的实际索引。注意力内核要读某个 token 的 KV，就靠查这张表拿到真实位置。
- **token-to-KV 分配器**（`python/sglang/srt/mem_cache/allocator.py:35` 的 `BaseTokenToKVPoolAllocator`，具体实现 `TokenToKVPoolAllocator` 在 `:121`）：管空闲页。它内部维护一个 `free_pages` 列表，`alloc` 从里面取页、`free` 把页还回去。`available_size`（`allocator.py:66`）= 空闲页数 × `page_size`。

<svg viewBox="0 0 620 286" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ReqToTokenPool maps a logical token sequence to non-contiguous physical KV slots">
<defs>
<marker id="t11ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
</defs>
<text x="40" y="28" font-size="11" font-weight="600" fill="#94a3b8">逻辑视图（请求看到的连续序列）</text>
<rect x="40" y="36" width="320" height="34" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<line x1="93" y1="36" x2="93" y2="70" stroke="#ea580c"/><line x1="146" y1="36" x2="146" y2="70" stroke="#ea580c"/>
<line x1="199" y1="36" x2="199" y2="70" stroke="#ea580c"/><line x1="252" y1="36" x2="252" y2="70" stroke="#ea580c"/>
<line x1="305" y1="36" x2="305" y2="70" stroke="#ea580c"/>
<text x="66" y="58" text-anchor="middle" font-size="11" fill="currentColor">t0</text>
<text x="119" y="58" text-anchor="middle" font-size="11" fill="currentColor">t1</text>
<text x="172" y="58" text-anchor="middle" font-size="11" fill="currentColor">t2</text>
<text x="226" y="58" text-anchor="middle" font-size="11" fill="currentColor">t3</text>
<text x="279" y="58" text-anchor="middle" font-size="11" fill="currentColor">t4</text>
<text x="332" y="58" text-anchor="middle" font-size="11" fill="currentColor">t5</text>
<rect x="40" y="100" width="540" height="56" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="56" y="122" font-size="11" font-weight="600" fill="currentColor">ReqToTokenPool 映射表</text>
<text x="56" y="143" font-size="11" fill="#64748b">req_to_token[i] = [ 37, 38, 39, 12, 13, 90 ]　逻辑序号 → 物理 KV 索引</text>
<text x="40" y="186" font-size="11" font-weight="600" fill="#94a3b8">物理视图（KV 池实际：分页，不连续）</text>
<rect x="40" y="196" width="540" height="40" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
<rect x="40" y="196" width="90" height="40" fill="#fef2f2" stroke="#94a3b8"/>
<rect x="220" y="196" width="90" height="40" fill="#99f6e4" stroke="#0d9488"/>
<rect x="400" y="196" width="90" height="40" fill="#99f6e4" stroke="#0d9488"/>
<text x="85" y="221" text-anchor="middle" font-size="9" fill="#94a3b8">空闲页</text>
<text x="175" y="221" text-anchor="middle" font-size="9" fill="#94a3b8">他人占用</text>
<text x="265" y="221" text-anchor="middle" font-size="9" fill="#0d9488">本请求</text>
<text x="355" y="221" text-anchor="middle" font-size="9" fill="#94a3b8">他人占用</text>
<text x="445" y="221" text-anchor="middle" font-size="9" fill="#0d9488">本请求</text>
<line x1="226" y1="156" x2="255" y2="194" stroke="#0d9488" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#t11ar)"/>
<line x1="300" y1="156" x2="440" y2="194" stroke="#0d9488" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#t11ar)"/>
<text x="310" y="262" text-anchor="middle" font-size="10" fill="#64748b">逻辑连续 ≠ 物理连续——映射表负责把散落的页「拼」成一个序列</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ 分页让一个请求的 token 散落在不连续的页上，ReqToTokenPool 把逻辑序列与物理 KV 解绑</span>

<details>
<summary>ASCII 原版</summary>

```text
  逻辑视图 (请求看到的)        物理视图 (KV 池实际)
  token: t0 t1 t2 t3 t4 t5     页: [..][占用][..][占用][..]
          │  │  │  │  │  │
  ReqToTokenPool 映射表:
   req_to_token[i] = [37, 38, 39, 12, 13, 90]
                      └── 6 个不连续的真实 KV 索引
```

</details>

对我们这个请求，prefill 的批准备阶段 `ScheduleBatch.prepare_for_extend`（`python/sglang/srt/managers/schedule_batch.py:1688`）会调分配器为这 6 个新 token 申请 KV 索引，然后把这 6 个索引写进 `ReqToTokenPool` 里属于本请求的那一行。分配按页粒度——`page_size` 个 token 凑一页（`allocator.py` 的 `alloc_extend` 系列处理 prefill 这种「在已有前缀后面追加若干 token」的情形，见 `alloc_extend_naive`，`:180`）。

分配前分配器会先检查 `available_size` 够不够。如果池子快满了、装不下，这个请求就**暂时不被调度**——留在 `waiting_queue` 里等下一拍，等别的请求结束、释放出页来。这正是调度器「能不能再收一个请求」判断的物理依据（见 [步骤 12](tour-12-build-batch.md)）。

分配完成：6 个 token 的 KV 槽位有了，索引记在了 `ReqToTokenPool` 里。注意——**槽位有了，但里面还是空的**；K/V 的数值要等步骤 14-15 跑前向时才写进去。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/mem_cache/memory_pool.py` —— `ReqToTokenPool` 定义，「请求 token → KV 索引」映射表。
- `python/sglang/srt/mem_cache/allocator.py:35` —— `BaseTokenToKVPoolAllocator`，分配器抽象基类。
- `allocator.py:121` —— `TokenToKVPoolAllocator`，具体实现；`:148` 的 `alloc`、`:159` 的 `free`。
- `allocator.py:66` —— `available_size`，判断池子还剩多少。
- `allocator.py:180` —— `alloc_extend_naive`，prefill 追加 token 的分配逻辑。
- `python/sglang/srt/managers/schedule_batch.py:1688` —— `prepare_for_extend`，prefill 批准备时触发分配。

## 7. 分支与延伸

- KV 池的物理布局、分页分配器、各种淘汰策略 → [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md)
- 注意力内核怎么靠 `ReqToTokenPool` 读到非连续的 KV → [步骤 15](tour-15-attention-kernel.md)、[第 10 章](10-attention-backends.md)
- 命中的前缀 KV 不用重新分配、直接复用 → [步骤 10](tour-10-match-prefix.md)、[第 06 章](06-radix-cache.md)
- 池子满时调度器怎么决定收不收请求 → [步骤 12](tour-12-build-batch.md)、[第 08 章](08-scheduler.md)
- decode 阶段每步只追加 1 个 token 的 KV → [步骤 17](tour-17-decode-loop.md)

## 8. 走完这一步你脑子里应该多了什么

1. KV 池用**分页**管理：一个请求的 token 可以散落在不连续的页上——这解决了「请求长度未知」和「外部碎片」两个连续分配的死结。
2. `ReqToTokenPool` 是「逻辑序列 → 物理 KV 索引」的映射表，把逻辑连续和物理连续解绑。
3. 分配器（`TokenToKVPoolAllocator`）管空闲页，`alloc` 取页、`free` 还页；分配前查 `available_size`，不够就让请求继续在队列里等。
4. 这一步只是**划了槽位**，槽位里还没有数据——K/V 的真实数值要等前向（步骤 14-15）才写入。
