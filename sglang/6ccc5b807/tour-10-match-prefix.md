# Trace 步骤 10 —— 这段 prompt，以前算过吗？

## 1. 当前情境

调度器的循环转到「组批」这一拍，开始处理 `waiting_queue` 里我们这个请求。`Req` 此刻持有 `origin_input_ids`——"The capital of France is" 对应的约 6 个 token id。在为它分配 KV、组批之前，调度器要先做一件事：查一查这段 token 序列**有没有算过**。

## 2. 问题

注意力计算的代价集中在 prefill：prompt 有多少 token，就要为多少 token 算 K/V 并存进 KV cache。问题是——在真实负载里，大量请求的**开头是一样的**：

- 同一个系统提示（system prompt）被成千上万个请求共用；
- few-shot 示例、RAG 检索到的同一段上下文、同一个对话的历史轮次……

如果每个请求都把自己的 prompt 从头算一遍 KV，那么这些**公共前缀**会被重复计算无数次。这一步要解决的是：能不能认出「这段前缀以前算过」，直接复用那份算好的 KV，跳过重算。

## 3. 朴素思路

搞一个哈希表：key 是「整段 token 序列」，value 是「这段序列的 KV 索引」。新请求来了，把它的 token 序列哈希一下查表,命中就复用。

## 4. 为什么朴素思路会崩

「整段序列做 key」只能匹配**完全相同**的请求，匹配不了**前缀**：

- 请求 A 是 "你是助手。 问题1"，请求 B 是 "你是助手。 问题2"。它们共享前缀 "你是助手。"，但整段哈希完全不同——哈希表认为它俩毫无关系，B 还是得把 "你是助手。" 重算一遍。
- 真实场景里几乎没有两个请求**完全**一样，但**前缀重叠**极其普遍。整段哈希命中率接近 0。
- 就算改成「枚举所有前缀长度去查」，一个 n token 的请求要查 n 次,而且 n 个前缀都得各自存进表里，存储爆炸。

要复用的是**最长公共前缀**，需要一个能高效做「前缀查找」的数据结构——哈希表不是。

## 5. SGLang 的做法

SGLang 用 **radix tree（基数树）** 管理所有缓存过的 KV 前缀，这就是 **RadixAttention** 的核心。树的每条从根出发的路径代表一段 token 序列，路径上每个节点存着「这一段 token 对应的 KV 索引」。前缀天然共享同一批靠近根的节点：

<svg viewBox="0 0 560 270" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Radix tree sharing a common prefix between two requests">
<circle cx="280" cy="40" r="22" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
<text x="280" y="44" text-anchor="middle" font-size="11" fill="#64748b">root</text>
<line x1="280" y1="62" x2="280" y2="96" stroke="#ea580c" stroke-width="2"/>
<rect x="190" y="98" width="180" height="48" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="280" y="120" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">"你是助手。"</text>
<text x="280" y="138" text-anchor="middle" font-size="10" fill="#64748b">公共前缀 · KV 只算/存一次</text>
<line x1="240" y1="146" x2="150" y2="190" stroke="#94a3b8" stroke-width="1.2"/>
<line x1="320" y1="146" x2="410" y2="190" stroke="#94a3b8" stroke-width="1.2"/>
<rect x="60" y="192" width="180" height="56" rx="8" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="150" y="214" text-anchor="middle" font-size="12" fill="currentColor">" 问题1"</text>
<text x="150" y="234" text-anchor="middle" font-size="10" fill="#64748b">请求 A 独有后缀</text>
<rect x="320" y="192" width="180" height="56" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.3"/>
<text x="410" y="214" text-anchor="middle" font-size="12" fill="currentColor">" 问题2"</text>
<text x="410" y="234" text-anchor="middle" font-size="10" fill="#64748b">请求 B 独有后缀</text>
</svg>
<span class="figure-caption">图 T10.1 ｜ radix tree：共享前缀扎在同一批靠根的节点，KV 只算一次；各自后缀分叉为独立叶子</span>

<details>
<summary>ASCII 原版</summary>

```text
              (root)
                │ "你是助手。"      <- 公共前缀, KV 只算/存一次
            ┌───┴───┐
       " 问题1"   " 问题2"          <- 各自独有的后缀
        (请求A)    (请求B)
```

</details>

调度器调 `match_prefix`（`python/sglang/srt/mem_cache/radix_cache.py:360`）在树上查我们这个请求的最长公共前缀。它沿着 token id 一路往下走，能匹配多深就匹配多深，返回一个 `MatchResult`（`radix_cache.py:413`）：

- `device_indices`：命中前缀那部分 token 的 KV 索引（一个 `torch.int64` 张量）——这些 token 的 KV **已经在池子里**，直接拿来用，不进前向；
- `last_device_node`：匹配停在哪个树节点。

```python
# radix_cache.py:408-418
value, last_node = self._match_prefix_helper(self.root_node, key)
if value:
    value = torch.cat(value)
...
return MatchResult(device_indices=value, last_device_node=last_node, ...)
```

匹配命中后，那段前缀的 KV 索引会被记到 `Req.prefix_indices` 上。请求真正要算的，只剩「总长度 − 命中前缀长度」那部分新 token。

**但我们这个 trace 是第一个请求，树是空的。** `match_prefix` 沿根往下，一步都匹配不动，返回的 `device_indices` 长度为 0（`radix_cache.py:400-401` 处理空树/空 key 的快速返回）。所以这 6 个 token **全部未命中**，下一步要为它们全部分配 KV。

虽然本例命中 0，但机制要记牢：等这个请求算完，它的 KV 会被 `insert` 进树（[步骤 18](tour-18-finish-return.md)）；下一个以 "The capital of France is" 开头的请求就能命中、白嫖这 6 个 token 的 KV。`match_prefix` 还会在匹配停在某段中间时**分裂节点**（`radix_cache.py:393-395`），让前缀边界更精确。`extra_key` 机制（`radix_cache.py:369-372`）让不同 LoRA adapter 等场景的 KV 互相隔离、不会错误共享。

## 6. 代码位置

按顺序读：

- `python/sglang/srt/mem_cache/radix_cache.py:269` —— `RadixCache` 类。
- `radix_cache.py:206` —— `TreeNode`，树节点结构（存 token 段与 KV 索引）。
- `radix_cache.py:66` —— `RadixKey`，匹配用的 key（token 序列 + 可选 `extra_key`）。
- `radix_cache.py:360` —— `match_prefix`，前缀匹配主函数。
- `radix_cache.py:400-418` —— 空树快速返回、`MatchResult` 的组装。
- `radix_cache.py:420` —— `insert`，请求算完后把 KV 插回树（步骤 18 用）。

## 7. 分支与延伸

- radix tree 的节点分裂、`lock ref` 引用计数、缓存淘汰 → [第 06 章 RadixAttention 与前缀缓存](06-radix-cache.md)
- 命中的前缀 KV 在注意力计算里怎么被直接读取 → [步骤 15](tour-15-attention-kernel.md)、[第 10 章](10-attention-backends.md)
- 未命中的 token 接下来怎么分配 KV 槽位 → [步骤 11](tour-11-alloc-kv.md)
- HiCache 把冷前缀挪到主机内存、`extra_key` 隔离 LoRA → [第 07 章 §HiCache](07-kv-cache-memory.md)、[第 06 章](06-radix-cache.md)

## 8. 走完这一步你脑子里应该多了什么

1. RadixAttention 的本质：用 **radix tree** 管理所有缓存过的 KV 前缀，让共享前缀的请求**复用**已算好的 KV，跳过重算。
2. 哈希表只能匹配「完全相同」，radix tree 能匹配「最长公共前缀」——而真实负载里前缀重叠才是常态。
3. `match_prefix` 返回 `MatchResult`，命中部分的 token 直接拿现成 KV、不进前向；未命中部分才需要新算。
4. 本 trace 是首个请求、树空、命中 0——但请求算完后 KV 会 `insert` 回树，后续同前缀请求即可命中。前缀缓存是**越用越值钱**的。
