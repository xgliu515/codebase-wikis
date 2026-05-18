# Trace 步骤 15 —— 注意力 kernel 怎么读到散落在池子里的 KV?

## 1. 当前情境

上一步前向走到了某个 Transformer 层的注意力子层。这一层刚算出 6 个 token 的 Query、Key、Value。注意力的任务是:让每个位置的 Query 去和它能看到的所有位置的 Key/Value 做注意力。但这里有个麻烦——KV 不在一块连续显存里。

## 2. 问题

回想 [步骤 11](tour-11-alloc-kv.md):KV cache 池是分页的,我们这个请求的 6 个 token 的 KV 槽位是**不连续**的——可能是池子里的索引 `[37, 38, 39, 12, 13, 90]`。注意力 kernel 要解决两件事:

- **写**:这一层刚算出的 6 个 token 的 K/V,要写进它们各自分到的(不连续的)KV 槽位;
- **读**:每个 Query 做注意力时,要读取它能看到的所有历史位置的 K/V——而这些 K/V 散落在池子里。

标准的注意力 kernel 假设 K/V 是一块连续张量 `[seq_len, num_heads, head_dim]`。我们的 K/V 不连续。怎么办?

## 3. 朴素思路

简单:做注意力之前,先把这个请求散落各处的 KV「收集」到一块临时的连续缓冲区里,然后喂给标准注意力 kernel。算完再说。

## 4. 为什么朴素思路会崩

「先 gather 成连续再算」每一层、每一步都要付一次搬运税:

- decode 阶段每生成一个 token 就要做一次注意力,每次都把**整个历史 KV** 从池子 gather 到临时缓冲——历史 1000 token,就搬 1000 token 的 KV;再生成一个,又搬 1001 个。显存带宽被重复搬运吃光。
- 临时缓冲区本身要占显存,而且大小随上下文增长,又把分页省下的显存吐回去了。
- 最致命的:它让「分页」这个设计**失去意义**。分页的全部价值就是「逻辑连续 ≠ 物理连续」,如果每次算之前都要物理连续化,那当初为什么不直接连续分配?

正确的做法不是「把数据搬到 kernel 习惯的布局」,而是「让 kernel 学会读非连续布局」。

## 5. SGLang 的做法

SGLang 的注意力**后端**(FlashAttention / FlashInfer 等,见 [第 10 章](10-attention-backends.md))用的是**支持分页 KV 的 kernel**——它们直接接受一张「索引表」,在 kernel 内部按表去 KV 池里取数据,不需要任何预先的 gather。

这张索引表就是 [步骤 11](tour-11-alloc-kv.md) 的 `ReqToTokenPool`:`req_to_token[i][j]` 告诉 kernel「第 i 个请求逻辑上的第 j 个 token,其 KV 在池子的哪个物理索引」。注意力元数据(`seq_lens`、KV 索引等)在 [步骤 13](tour-13-forward-batch.md) 由 `init_forward_metadata` 准备好,正是喂给 kernel 的「导航信息」。

<svg viewBox="0 0 620 268" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Attention kernel reads non-contiguous paged KV via the index table">
<defs>
<marker id="t15ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/></marker>
</defs>
<rect x="30" y="40" width="150" height="60" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="105" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Query</text>
<text x="105" y="86" text-anchor="middle" font-size="10" fill="#64748b">t0..t5 要做注意力</text>
<line x1="180" y1="70" x2="228" y2="70" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar)"/>
<rect x="230" y="40" width="170" height="60" rx="6" fill="#f1f5f9" stroke="#0d9488" stroke-width="1.3"/>
<text x="315" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ReqToTokenPool 索引表</text>
<text x="315" y="84" text-anchor="middle" font-size="10" fill="#64748b">[37, 38, 39, 12, 13, 90]</text>
<text x="510" y="36" text-anchor="middle" font-size="11" fill="#94a3b8">KV 池（物理 · 分页 · 不连续）</text>
<rect x="430" y="44" width="160" height="52" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="510" y="74" text-anchor="middle" font-size="10" fill="#64748b">… 37 38 39 … 12 13 … 90 …</text>
<line x1="315" y1="100" x2="315" y2="150" stroke="#0d9488" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#t15ar)"/>
<rect x="150" y="152" width="340" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
<text x="320" y="176" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">注意力 kernel</text>
<text x="320" y="196" text-anchor="middle" font-size="10" fill="#64748b">内部按索引表直接去 KV 池取数据，不预先 gather</text>
<line x1="490" y1="96" x2="430" y2="152" stroke="#0d9488" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#t15ar)"/>
<text x="320" y="240" text-anchor="middle" font-size="10" fill="#16a34a">写新 KV（按 out_cache_loc）＋ 读历史 KV（含命中前缀的复用 KV）</text>
</svg>
<span class="figure-caption">图 T15.1 ｜ 注意力 kernel 不 gather——它按 ReqToTokenPool 索引表直接读取散落在分页 KV 池里的数据</span>

<details>
<summary>ASCII 原版</summary>

```text
  逻辑上连续的序列          KV 池 (物理, 分页, 不连续)
  Q[t0..t5] 要看的 KV       ┌──┬──┬──┬──┬──┬──┐
       │                    │  │37│38│39│  │12│ ...
       │  ReqToTokenPool     └──┴──┴──┴──┴──┴──┘
       │  [37,38,39,12,13,90]    ▲  ▲  ▲   ▲
       └────────────────────────┘  按索引表
        kernel 内部直接按索引取 KV,不 gather
```

</details>

这一层注意力分两个动作:

1. **写新 KV**:把这 6 个 token 这一层刚算出的 K/V,按 `out_cache_loc`(步骤 13 准备的写入位置)写进 KV 池对应的槽位。写完,KV 池里这 6 个槽位才**第一次有了数据**(步骤 11 只是划了空槽位)。
2. **算注意力**:对 `EXTEND` 模式,每个 Query 位置 i 看 position 0..i(因果掩码)。kernel 通过索引表读取这些位置的 K/V——本 trace 是首个请求、无前缀命中,要读的就是刚写进去的这 6 个 token 自己的 KV。

> 如果前缀有命中([步骤 10](tour-10-match-prefix.md) 命中非 0),那么命中前缀的 K/V **早就在池子里了**——它们是之前别的请求算好留下的。这一步的注意力会同时读「复用的前缀 KV」+「本次新写的 KV」,而新 token 的 K/V 一个都不用为前缀重算。这就是 RadixAttention 省下计算的地方:省的不是注意力本身,是**前缀那部分 K/V 的投影计算**。

FlashAttention 类 kernel 还会把注意力的 softmax 做 **fused**(在 SRAM 里分块累加,不把巨大的注意力矩阵写回显存),这是另一层优化,但和「分页读 KV」是正交的两件事。

注意力算完,输出回到 Transformer 层继续往下(MLP 等)。所有层都走完,就是 [步骤 14](tour-14-model-forward.md) 说的「拿到 hidden state」。

## 6. 代码位置

按顺序读:

- `python/sglang/srt/layers/attention/` —— 注意力后端目录,先 `ls` 看有哪些后端。
- `python/sglang/srt/layers/attention/flashattention_backend.py` —— 默认后端之一,看 `init_forward_metadata`、`forward_extend`、`forward_decode`。
- `python/sglang/srt/layers/radix_attention.py` —— `RadixAttention` 层,模型骨架里的注意力模块,对接后端。
- `python/sglang/srt/mem_cache/memory_pool.py` —— KV 池与 `ReqToTokenPool`,kernel 按索引读写的对象。
- `sgl-kernel/csrc/` —— 自定义 CUDA 算子(含分页注意力相关 kernel)。

## 7. 分支与延伸

- 各注意力后端(FlashAttention / FlashInfer / FlashMLA)的差异、如何选择 → [第 10 章 注意力后端与 CUDA 内核](10-attention-backends.md)
- 分页 KV 池的物理布局、`page_size` 的影响 → [第 07 章 KV Cache 内存管理](07-kv-cache-memory.md)
- 前缀命中时复用的 KV 从哪来 → [步骤 10](tour-10-match-prefix.md)、[第 06 章 RadixAttention](06-radix-cache.md)
- decode 阶段注意力只算 1 个新 Query、KV 历史只增量加 1 → [步骤 17](tour-17-decode-loop.md)

## 8. 走完这一步你脑子里应该多了什么

1. SGLang 不把散落的 KV「gather 成连续再算」——它用**支持分页的注意力 kernel**,kernel 在内部按 `ReqToTokenPool` 索引表直接去 KV 池取数据。
2. 这一层注意力做两件事:**写**(新 token 的 K/V 写进池子分到的槽位,槽位至此才有数据)和**读**(Query 按索引表读历史 K/V 做注意力)。
3. 前缀命中时,复用的 K/V 早就在池子里,注意力直接读它——RadixAttention 省下的是**前缀那部分 K/V 投影的计算**。
4. 「让 kernel 适应分页布局」而不是「让数据适应 kernel」,才能保住分页的全部价值;FlashAttention 的 fused softmax 是正交的另一层优化。
