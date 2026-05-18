# Trace 步骤 11 —— llama_decode 收到 batch 后第一件事是什么?

## 1. 当前情境

步骤 10 结束时,`simple.cpp` 调用了 `llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size())`(`examples/simple/simple.cpp:149`),得到一个轻量的 `llama_batch`。该结构只有 `n_tokens` 和 `token` 两个字段非空,`pos`、`seq_id`、`logits` 全是 `nullptr`。

紧接着,主循环在 `examples/simple/simple.cpp:173` 发起第一次 decode:

```cpp
if (llama_decode(ctx, batch)) {
    fprintf(stderr, "%s : failed to eval, return code %d\n", __func__, 1);
    return 1;
}
```

这是 prefill 阶段——把整个 prompt 一次性喂入。`batch.n_tokens` 等于 prompt 的 token 数,所有 token 都是新的,KV 缓存里什么都没有。

---

## 2. 问题

`llama_batch_get_one` 交出的 batch 极度简化:没有位置编号、没有序列 ID、没有标注哪些 token 需要输出 logits。但后续的计算图构建和 KV 缓存槽位分配,都需要这些信息精确在场。

与此同时,还有一个更基础的约束:`n_ubatch`(微批大小)可以小于 `n_batch`。若 `n_batch = 512` 而 `n_ubatch = 256`,一个 512-token 的 prefill 必须分两趟走。每趟的 token 要明确知道自己在 KV 缓存里占哪些 cell,否则后一趟写入时会和前一趟冲突。

核心问题:**如何把一个"只有 token id 数组"的外部 batch 转成内部可以精确执行的一批或多批微批,并且为每批微批在 KV 缓存里找好互不冲突的槽位?**

---

## 3. 朴素思路

最直接的做法:让调用方把所有字段都填好——位置要调用方手动维护递增计数器,序列 ID 要调用方逐 token 填,logits 标志要调用方按需设。这样 decode 只需直接把数据交给计算图。

---

## 4. 为什么朴素思路会崩

- **调用方负担过重且容易出错**:维护递增的 `pos` 计数器、在多序列并发时管理各序列的独立计数,是重复劳动。`simple.cpp` 这样的简单程序会被迫变复杂,而且 off-by-one 的 bug 极难发现——位置错了,RoPE 算出来的结果就静默地错了,没有任何崩溃信号。
- **batch 拆 ubatch 的逻辑散落到调用方**:连续批处理场景(llama-server)里多个序列同时推进,`n_ubatch` 的拆分规则会因场景不同而异。如果每个调用方都要自己实现拆分,逻辑就会重复且难以维护。
- **KV 槽位分配必须与 ubatch 拆分同步**:找槽位和拆 ubatch 是一个"先猜后验"的过程——必须先知道这一个 ubatch 里有哪些 token,才能去 KV 缓存里找它们对应的空格。把这个逻辑拆到外面是行不通的。

---

## 5. llama.cpp 的做法

整个入口处理分为三层,依次在 `llama_decode → llama_context::decode` 里完成。

<svg viewBox="0 0 760 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Three-layer decode entry: field completion, ubatch split and KV slot allocation, per-ubatch execution">
  <defs>
    <marker id="t11ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="500" fill="#f8fafc" rx="6"/>
  <rect x="240" y="12" width="280" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">llama_decode(ctx, batch)</text>
  <text x="380" y="44" text-anchor="middle" font-size="10" fill="#64748b">examples/simple/simple.cpp:173</text>
  <line x1="380" y1="52" x2="380" y2="72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t11ar1)"/>
  <rect x="200" y="72" width="360" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="88" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">llama_context::decode(batch_inp)</text>
  <text x="380" y="102" text-anchor="middle" font-size="10" fill="#94a3b8">src/llama-context.cpp:1611</text>
  <line x1="380" y1="108" x2="380" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t11ar1)"/>
  <rect x="30" y="128" width="200" height="108" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="130" y="148" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">[1] 补全缺失字段</text>
  <text x="130" y="164" text-anchor="middle" font-size="10" fill="#64748b">balloc→init(batch_inp,...)</text>
  <text x="130" y="180" text-anchor="middle" font-size="10" fill="#64748b">补全 pos: 0,1,...,n-1</text>
  <text x="130" y="196" text-anchor="middle" font-size="10" fill="#64748b">补全 seq_id: 全部 0</text>
  <text x="130" y="212" text-anchor="middle" font-size="10" fill="#64748b">补全 logits: 末尾 token=1</text>
  <text x="130" y="228" text-anchor="middle" font-size="10" fill="#94a3b8">llama-batch.cpp:25</text>
  <rect x="260" y="128" width="240" height="108" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="148" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">[2] 拆 ubatch + 找 KV 槽</text>
  <text x="380" y="164" text-anchor="middle" font-size="10" fill="#64748b">memory→init_batch(*balloc, n_ubatch)</text>
  <text x="380" y="180" text-anchor="middle" font-size="10" fill="#64748b">split_simple(n_ubatch) → ubatch_i</text>
  <text x="380" y="196" text-anchor="middle" font-size="10" fill="#64748b">kv.prepare(ubatches)</text>
  <text x="380" y="212" text-anchor="middle" font-size="10" fill="#64748b">find_slot() → slot_info</text>
  <text x="380" y="228" text-anchor="middle" font-size="10" fill="#94a3b8">llama-kv-cache.cpp:627</text>
  <rect x="530" y="128" width="200" height="108" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="630" y="148" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">[3] 逐 ubatch 执行</text>
  <text x="630" y="164" text-anchor="middle" font-size="10" fill="#64748b">do {</text>
  <text x="630" y="180" text-anchor="middle" font-size="10" fill="#64748b">  get_ubatch()</text>
  <text x="630" y="196" text-anchor="middle" font-size="10" fill="#64748b">  process_ubatch(...)</text>
  <text x="630" y="212" text-anchor="middle" font-size="10" fill="#64748b">} while(mctx→next())</text>
  <text x="630" y="228" text-anchor="middle" font-size="10" fill="#94a3b8">llama-context.cpp:1753</text>
  <line x1="130" y1="236" x2="130" y2="260" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="236" x2="380" y2="260" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="630" y1="236" x2="630" y2="260" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <rect x="30" y="260" width="200" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="130" y="278" text-anchor="middle" font-size="10" fill="#64748b">batch 完整</text>
  <text x="130" y="294" text-anchor="middle" font-size="10" fill="#64748b">所有字段有值</text>
  <rect x="260" y="260" width="240" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="380" y="278" text-anchor="middle" font-size="10" fill="#64748b">ubatches[] + sinfos[]</text>
  <text x="380" y="294" text-anchor="middle" font-size="10" fill="#64748b">KV 槽位已确定</text>
  <rect x="530" y="260" width="200" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="630" y="278" text-anchor="middle" font-size="10" fill="#64748b">前向计算图执行完毕</text>
  <text x="630" y="294" text-anchor="middle" font-size="10" fill="#64748b">logits 写入输出缓冲</text>
  <rect x="30" y="330" width="700" height="148" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="352" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">prefill 场景示例 (n_tokens=2, n_ubatch≥2)</text>
  <text x="120" y="376" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">split_simple</text>
  <text x="120" y="392" text-anchor="middle" font-size="10" fill="#64748b">n_ubatch≥n_prompt</text>
  <text x="120" y="408" text-anchor="middle" font-size="10" fill="#64748b">一次切完 → 1 ubatch</text>
  <text x="320" y="376" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">find_slot</text>
  <text x="320" y="392" text-anchor="middle" font-size="10" fill="#64748b">KV 缓存全空, head=0</text>
  <text x="320" y="408" text-anchor="middle" font-size="10" fill="#64748b">顺序找到 cell [0, n_prompt)</text>
  <text x="550" y="376" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">process_ubatch</text>
  <text x="550" y="392" text-anchor="middle" font-size="10" fill="#64748b">apply() 写 cell 元数据</text>
  <text x="550" y="408" text-anchor="middle" font-size="10" fill="#64748b">build_graph + compute</text>
  <text x="380" y="464" text-anchor="middle" font-size="10" fill="#94a3b8">find_slot 只查不写; apply() 才把 seq_id/pos 落地到 KV cell</text>
</svg>
<span class="figure-caption">图 T11.1 ｜ llama_decode 入口的三层处理：字段补全 → ubatch 拆分与 KV 槽位分配 → 逐批执行</span>

<details>
<summary>ASCII 原版</summary>

```
llama_decode(ctx, batch)                    [examples/simple/simple.cpp:173]
    |
    v
llama_context::decode(batch_inp)            [src/llama-context.cpp:3912 / :1611]
    |
    +--[1] balloc->init(batch_inp, ...)      [src/llama-context.cpp:1662]
    |       |                                [src/llama-batch.cpp:25]
    |       |  补全 pos  (0,1,2,...,n-1)
    |       |  补全 seq_id (全部 0)
    |       |  补全 logits (只有最后一个 token = 1)
    |       v
    |   batch 在 balloc 内部已经是完整的
    |
    +--[2] memory->init_batch(*balloc, n_ubatch, ...)
    |       |                                [src/llama-kv-cache.cpp:627]
    |       |  loop: balloc.split_simple(n_ubatch)  -> ubatch_0, ubatch_1, ...
    |       |        [src/llama-batch.cpp:474]
    |       |  kv.prepare(ubatches)          [src/llama-kv-cache.cpp:676]
    |       |    for each ubatch: find_slot() -> slot_info (cell 下标列表)
    |       |                                [src/llama-kv-cache.cpp:818]
    |       v
    |   llama_kv_cache_context 持有 ubatches[] + sinfos[]
    |
    +--[3] do { ubatch = mctx->get_ubatch(); process_ubatch(ubatch, ...) }
            while (mctx->next())             [src/llama-context.cpp:1753-]
```

</details>

**第一层:补全缺失字段(`llama_batch_allocr::init`)**

`balloc`(`llama_batch_allocr`)在 `src/llama-batch.cpp:25` 实现的 `init` 方法里,对 `pos == nullptr` 的情况自动填充:`p0[seq_id] = memory->seq_pos_max(seq_id) + 1`(从 KV 缓存已有的最大位置加一开始)(`src/llama-batch.cpp:93-117`)。prefill 时 KV 缓存为空,`seq_pos_max` 返回 -1,所以 `p0 = 0`,各 token 依次得到位置 0, 1, 2, …, n-1。同样地,`seq_id == nullptr` 时全部填 0(`src/llama-batch.cpp:81-88`),`logits == nullptr` 时只有最后一个 token 的 `output` 标志置 1(`src/llama-batch.cpp:120-130`)。

**第二层:拆 ubatch + 找 KV 槽位(`llama_kv_cache::init_batch`)**

`src/llama-kv-cache.cpp:638` 调用 `balloc.split_simple(n_ubatch)` 反复切出下一个 ubatch,直到 `n_tokens == 0`。对于 prefill(n_ubatch >= n_prompt),一次就切完,得到 1 个 ubatch。

随后 `prepare(ubatches)`(`src/llama-kv-cache.cpp:676`) 对每个 ubatch 调用 `find_slot(ubatch, false)`(`src/llama-kv-cache.cpp:818`)。`find_slot` 从当前 `head` 开始线性扫描 cell 数组,找到 `n_tokens` 个空闲 cell,把它们的下标收进 `slot_info.idxs`。prefill 时缓存全空,`head = 0`,顺序找到 `[0, n_prompt)` 区间。

`find_slot` 只查找、不修改缓存;真正写入(把 token 的 seq_id / pos 填进 cell)发生在 `process_ubatch` 开始时的 `mctx->apply()`(`src/llama-context.cpp:1237` → `src/llama-kv-cache.cpp:2406`)。

**第三层:逐 ubatch 执行**

拿到 `llama_kv_cache_context` 之后,`llama_context::decode` 进入 `do { … } while (mctx->next())` 循环(`src/llama-context.cpp:1753`)。每次迭代取出一个 ubatch,调用 `process_ubatch` 构建并执行计算图(步骤 12-13 负责讲这部分)。

---

## 6. 代码位置

按阅读顺序:

- 外部入口:`src/llama-context.cpp:3912` — `llama_decode` 薄包装
- 内部实现:`src/llama-context.cpp:1611` — `llama_context::decode` 主体
- 校验 + 补全字段:`src/llama-context.cpp:1662` — `balloc->init(...)` 调用
- `llama_batch_allocr::init`:`src/llama-batch.cpp:25` — 填充 `pos`、`seq_id`、`logits`
- pos 自动推断:`src/llama-batch.cpp:90-118` — 从 `memory->seq_pos_max` 起步
- logits 标志默认值:`src/llama-batch.cpp:120-130` — 只有末尾 token 置 1
- `split_simple`:`src/llama-batch.cpp:474` — 按 n_ubatch 切出下一 ubatch
- `llama_kv_cache::init_batch`:`src/llama-kv-cache.cpp:627` — 拆批 + 找槽 总入口
- `llama_kv_cache::prepare`:`src/llama-kv-cache.cpp:676` — 对每 ubatch 调 find_slot
- `llama_kv_cache::find_slot`:`src/llama-kv-cache.cpp:818` — 线性扫描找空闲 cell
- `mctx->apply()`:`src/llama-kv-cache.cpp:2406` — 把 slot_info 写入 KV cell 元数据
- `process_ubatch` 调用处:`src/llama-context.cpp:1774` — 逐 ubatch 执行循环

---

## 7. 分支与延伸

- `llama_batch`、`llama_ubatch`、`llama_batch_allocr` 的结构设计与"内外两层 batch"的设计理由 → [第 7 章 上下文与批处理](07-context-and-batching.md)
- KV 缓存 cell 模型、`find_slot` 的扫描策略、SWA(滑动窗口注意力)对槽位的影响 → [第 8 章 KV 缓存](08-kv-cache.md)
- prefill vs. decode 阶段的 ubatch 差异(prefill: n_tokens = n_prompt,decode: n_tokens = 1) → [第 16 步 解码并进入下一轮](tour-16-detokenize-loop.md)
- `n_ubatch` 的来源与意义:`src/llama-context.cpp:183` 中 `n_ubatch = min(n_batch, params.n_ubatch)` → [第 7 章 §上下文参数](07-context-and-batching.md)
- `memory_update` 处理 KV 缓存的 shift / copy 操作 → [第 8 章 §缓存管理](08-kv-cache.md)

---

## 8. 走完这一步你脑子里应该多了什么

1. **`llama_batch_get_one` 交出的是一个"省力 batch"**:pos、seq_id、logits 全部 nullptr,由 `llama_batch_allocr::init` 自动补全——调用方无需维护位置计数器。
2. **batch 和 ubatch 是两个层次**:`llama_batch` 是外部接口的输入单元,`llama_ubatch` 是内部执行的最小单元;`split_simple` 负责把前者切成后者,切割点由 `n_ubatch` 决定。
3. **prefill 时 KV 缓存从 cell 0 开始顺序分配**:`find_slot` 在空缓存里扫一圈找到 `[0, n_prompt)` 区间,这些 cell 下标就是这批 token 的"家"。
4. **`find_slot` 只查不写**,真正将 cell 的 seq_id/pos 元数据落地是 `mctx->apply()` 在 `process_ubatch` 开始时完成的——找槽和写槽是两个阶段。
5. **KV 槽位找不到不是崩溃,是可恢复的失败**:`LLAMA_MEMORY_STATUS_FAILED_PREPARE` 会触发一次 `memory_update(true)`(缓存整理)后重试,再失败才返回错误码 1。

下一步:[步骤 12 —— 构建本次的计算图](tour-12-graph-build.md)。
