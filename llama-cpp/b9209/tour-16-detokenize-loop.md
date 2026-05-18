# Trace 步骤 16 —— 拿到 token id,如何还原文字并喂入下一轮?

## 1. 当前情境

步骤 15 结束后,`new_token_id` 是一个 `llama_token` 整数——比如 `220`(一个空格 token)或某个汉字 token 的编号。它对人类没有直接意义,需要还原成 UTF-8 字节片段才能打印。

与此同时,KV 缓存里已经写入了 prefill 阶段所有 prompt token 的 K/V 向量。这意味着下一轮 decode 不再需要重新处理整个 prompt,只需把这个新 token 送进去就能继续生成。

`simple.cpp` 在采样之后立刻执行这三件事(`examples/simple/simple.cpp:189`-`200`):

```cpp
char buf[128];
int n = llama_token_to_piece(vocab, new_token_id, buf, sizeof(buf), 0, true);
std::string s(buf, n);
printf("%s", s.c_str());
fflush(stdout);

// prepare the next batch with the sampled token
batch = llama_batch_get_one(&new_token_id, 1);
```

## 2. 问题

有两个具体问题需要同时解决:

1. **detokenize**:token id 怎么变回文字?词表里的 token 可能是普通 BPE 子词、字节 fallback token(`<0xFF>`)、特殊控制符,还需要处理 SentencePiece 风格的空格替换字符(`▁`)。

2. **下一轮 batch**:decode 阶段每轮只有 1 个新 token,但 `llama_decode` 的接口仍然接受 `llama_batch`。如何用最低开销把单个 token 包成合法的 batch?更深层的问题是:为什么可以只喂 1 个 token?KV 缓存里原来的 K/V 向量还在吗?

## 3. 朴素思路

detokenize:查词表的字符串字段,直接返回 `id_to_token[id].text`。

构造 batch:每次 decode 都把整个 prompt + 已生成的 token 重新打包进一个 batch,让模型从头看一遍。

## 4. 为什么朴素思路会崩

**detokenize 的坑**:

- `id_to_token[id].text` 存的是词表里的**原始字符串**,不是最终的 UTF-8 输出。SPM/UGM 词表用 `▁`(U+2581)表示空格;BPE 词表的字节 fallback token 存的是 `<0xE4>` 这样的十六进制字符串,不是真正的字节。直接返回 `.text` 会把 `▁你好` 打印成 `▁你好` 而不是 ` 你好`,或者把汉字首字节打印成 `<0xE4>`。

**每轮重新处理整个 prompt 的代价**:

- prefill 的时间复杂度是 O(N²)(注意力机制),N 是序列总长度。如果每生成一个 token 都从头算,生成第 k 个 token 的代价是 O((N+k)²)。生成 1000 个 token 的总代价就是 O(N² × 1000 + N × 1000²)——对于 4096 的 context,这是灾难级别的性能问题。
- 已经算好的注意力 K/V 值完全相同,重复计算是纯浪费。

## 5. llama.cpp 的做法

**detokenize:token_to_piece 的实现**

`llama_token_to_piece` 最终调用 `llama_vocab::impl::token_to_piece`(`src/llama-vocab.cpp:3275`)。它先查 `cache_token_to_piece`——一个在 vocab 初始化时就预填好的 `vector<string>`,避免每次 decode 都走完整的字节处理逻辑。对于 SPM/UGM 类型的 normal token,它调用 `llama_unescape_whitespace` 把 `▁` 替换回空格;对于字节 fallback token(`LLAMA_TOKEN_ATTR_BYTE`),它把 `<0xXX>` 解析成真实的单字节值(`src/llama-vocab.cpp:2855`-`2876`)。

返回值是写入 `buf` 的字节数。函数签名如下:

```cpp
int32_t llama_token_to_piece(
    const struct llama_vocab * vocab,
    llama_token   token,
    char        * buf,
    int32_t       length,
    int32_t       lstrip,   // 跳过前 lstrip 个空格
    bool          special); // 是否渲染特殊 token
```

`simple.cpp` 用 `lstrip=0, special=true`——保留所有空格,渲染特殊 token 的文本形式(`examples/simple/simple.cpp:190`)。

**下一轮 batch:llama_batch_get_one + KV 缓存复用**

```cpp
batch = llama_batch_get_one(&new_token_id, 1);
```

`llama_batch_get_one` 只做一件事:把传入的 token 指针和数量填进 `llama_batch` 结构体,`pos`、`seq_id`、`logits` 字段全部置 `nullptr`,让框架在下一次 `llama_decode` 时自动推断(`src/llama-batch.cpp:863`-`875`)。

自动推断的关键是 KV 缓存里的状态。KV 缓存为每个已处理的位置(0, 1, 2, ..., N+k-1)存有 K/V 向量。`llama_context::decode` 在 `llama_batch_allocr::init` 里查询 KV 缓存的当前最大位置,把新 token 分配到下一个空槽位,位置编号自动延续(`src/llama-batch.cpp:86`-`118`)。于是这一轮 `batch.n_tokens == 1`,计算图只需处理 1 个 token 的注意力——它能"看到"整个 prompt,是因为注意力机制可以从 KV 缓存里读出历史的 K/V,不需要重算。

prefill 与 decode 的对比:

<svg viewBox="0 0 880 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Prefill vs decode: token batch size and KV cache usage comparison">
  <defs>
    <marker id="t16ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="880" height="400" fill="#f8fafc" rx="6"/>
  <rect x="30" y="16" width="400" height="360" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="230" y="42" text-anchor="middle" font-size="14" font-weight="700" fill="#ea580c">第一轮 —— Prefill</text>
  <rect x="50" y="54" width="360" height="44" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="230" y="72" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">batch: [tok0, tok1, tok2, tok3]</text>
  <text x="230" y="88" text-anchor="middle" font-size="10" fill="#64748b">n_tokens = n_prompt  (全部 prompt token)</text>
  <rect x="50" y="112" width="360" height="80" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="230" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">KV 缓存操作</text>
  <text x="70" y="154" font-size="10" fill="#dc2626">写入</text>
  <rect x="100" y="140" width="40" height="28" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="120" y="158" text-anchor="middle" font-size="9" fill="#64748b">pos 0</text>
  <rect x="148" y="140" width="40" height="28" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="168" y="158" text-anchor="middle" font-size="9" fill="#64748b">pos 1</text>
  <rect x="196" y="140" width="40" height="28" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="216" y="158" text-anchor="middle" font-size="9" fill="#64748b">pos 2</text>
  <rect x="244" y="140" width="40" height="28" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="264" y="158" text-anchor="middle" font-size="9" fill="#64748b">pos 3</text>
  <text x="230" y="185" text-anchor="middle" font-size="10" fill="#64748b">KV 缓存: 空 → 写入 4 个 cell</text>
  <rect x="50" y="206" width="360" height="52" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="230" y="224" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">注意力计算</text>
  <text x="230" y="242" text-anchor="middle" font-size="10" fill="#64748b">因果掩码 O(n²)  完整自注意力</text>
  <text x="230" y="254" text-anchor="middle" font-size="9" fill="#94a3b8">n = n_prompt tokens</text>
  <rect x="50" y="272" width="360" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="230" y="290" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">输出</text>
  <text x="230" y="306" text-anchor="middle" font-size="10" fill="#64748b">只有 tok3 的 logits  (最后一个位置)</text>
  <rect x="50" y="330" width="360" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="230" y="344" text-anchor="middle" font-size="10" fill="#64748b">计算复杂度: O(n²)  高吞吐</text>
  <text x="230" y="358" text-anchor="middle" font-size="9" fill="#94a3b8">batched=true → 使用 threadpool_batch(更多线程)</text>
  <rect x="450" y="16" width="400" height="360" rx="8" fill="#f0fdfa" stroke="#0d9488" stroke-width="2"/>
  <text x="650" y="42" text-anchor="middle" font-size="14" font-weight="700" fill="#0d9488">第二轮起 —— Decode</text>
  <rect x="470" y="54" width="360" height="44" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="650" y="72" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">batch: [new_token_id]</text>
  <text x="650" y="88" text-anchor="middle" font-size="10" fill="#64748b">n_tokens = 1  (每轮只 1 个新 token)</text>
  <rect x="470" y="112" width="360" height="80" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="650" y="132" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">KV 缓存操作</text>
  <text x="490" y="154" font-size="10" fill="#16a34a">读取</text>
  <rect x="520" y="140" width="40" height="28" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="540" y="158" text-anchor="middle" font-size="9" fill="#64748b">0-3</text>
  <text x="590" y="154" font-size="10" fill="#dc2626">写入</text>
  <rect x="618" y="140" width="40" height="28" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="638" y="158" text-anchor="middle" font-size="9" fill="#64748b">pos 4</text>
  <text x="650" y="185" text-anchor="middle" font-size="10" fill="#64748b">历史 K/V 已存在, 只追加新 cell</text>
  <rect x="470" y="206" width="360" height="52" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="650" y="224" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">注意力计算</text>
  <text x="650" y="242" text-anchor="middle" font-size="10" fill="#64748b">new_token Q × 历史所有 K/V  O(N)</text>
  <text x="650" y="254" text-anchor="middle" font-size="9" fill="#94a3b8">N = 序列总长度, 只算 1 行</text>
  <rect x="470" y="272" width="360" height="44" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="650" y="290" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">输出</text>
  <text x="650" y="306" text-anchor="middle" font-size="10" fill="#64748b">new_token 位置的 logits  (下一个 token)</text>
  <rect x="470" y="330" width="360" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="650" y="344" text-anchor="middle" font-size="10" fill="#64748b">每步代价: O(N)  低延迟</text>
  <text x="650" y="358" text-anchor="middle" font-size="9" fill="#94a3b8">batched=false → 使用 threadpool(较少线程)</text>
</svg>
<span class="figure-caption">图 T16.1 ｜ Prefill（首轮）与 Decode（后续轮）的批大小、KV 缓存操作及计算复杂度对比</span>

<details>
<summary>ASCII 原版</summary>

```
第一轮(prefill):
  batch: [tok0, tok1, tok2, tok3]  (prompt 全部 token)
  KV 缓存:  空 → 写入 pos 0,1,2,3
  输出:     只有 tok3 的 logits

第二轮起(decode):
  batch: [new_token_id]  (只有 1 个新 token)
  KV 缓存:  pos 0,1,2,3 已在 → 读取;pos 4 → 写入
  注意力:   new_token 的 Q 与历史所有 K/V 做点积
  输出:     new_token 位置的 logits
```

</details>

这就是"增量式 decode"的核心洞察:**KV 缓存把 O(N²) 的历史计算摊平到了 O(N) 的空间代价,让每一个新 token 的生成代价恒为 O(N) 而不是 O((N+k)²)**。

循环控制也在这里收口。`simple.cpp` 的循环条件是(`examples/simple/simple.cpp:171`):

```cpp
for (int n_pos = 0; n_pos + batch.n_tokens < n_prompt + n_predict; )
```

每轮循环末尾`n_pos += batch.n_tokens`(第一轮 `+= n_prompt`,后续每轮 `+= 1`)。当 `n_pos + 1 >= n_prompt + n_predict` 时循环退出,即已生成 `n_predict` 个 token。

## 6. 代码位置

按阅读顺序:

- `examples/simple/simple.cpp:171` —— 循环条件:`n_pos + batch.n_tokens < n_prompt + n_predict`
- `examples/simple/simple.cpp:178` —— `n_pos += batch.n_tokens`(更新已处理位置数)
- `examples/simple/simple.cpp:189`-`196` —— `llama_token_to_piece` 调用、打印、`fflush`
- `examples/simple/simple.cpp:200` —— `batch = llama_batch_get_one(&new_token_id, 1)`:单 token batch
- `examples/simple/simple.cpp:202` —— `n_decode += 1`:decode 轮数统计
- `src/llama-batch.cpp:863`-`875` —— `llama_batch_get_one` 实现:填指针,其余 `nullptr`
- `src/llama-batch.cpp:86`-`130` —— `llama_batch_allocr::init`:自动推断 pos、补全 logits 标记
- `src/llama-vocab.cpp:3275`-`3309` —— `llama_vocab::impl::token_to_piece`:缓存查找与字节处理
- `src/llama-vocab.cpp:2855`-`2876` —— `token_to_byte`:字节 fallback token 的十六进制解析

## 7. 分支与延伸

- BPE / SPM / UGM 词表各自的 token 类型(normal、byte、control、user_defined……)与 `token_to_piece` 的分支处理 → [第 6 章 分词与词表](06-tokenization.md)
- KV 缓存的 cell 槽位管理:prefill 写槽、decode 复用槽、`seq_rm` 清槽 → [第 8 章 KV 缓存](08-kv-cache.md)
- 多序列并发解码(continuous batching)时每个序列各自维护 KV 位置,`n_seq_id` 与 `seq_id` 字段的作用 → [第 7 章 上下文与批处理](07-context-and-batching.md)
- `llama_detokenize` vs `llama_token_to_piece`:前者一次处理整个序列并处理拼接边界,后者每次处理单个 token → [第 6 章](06-tokenization.md)
- 为何 decode 阶段计算图可以复用 prefill 时 reserve 的图(`n_reused` 计数) → [步骤 07](tour-07-graph-reserve.md)

## 8. 走完这一步你脑子里应该多了什么

1. **`llama_token_to_piece` 不是简单的查表**:它处理 SPM 空格字符替换和字节 fallback token 的十六进制解码,保证输出是合法的 UTF-8 片段。
2. **`llama_batch_get_one(&new_token_id, 1)` 是"最轻量的 batch 构造"**:只有一个 token,位置、序列号、logits 标记全由框架推断。
3. **decode 阶段每轮只喂 1 个 token,性能代价从 O(N²) 降到 O(N)**:这是因为 KV 缓存在 prefill 时已经写入了所有历史 K/V,后续 decode 只做增量注意力计算。
4. **prefill 和 decode 走的是同一个 `llama_decode` 路径**,差别仅在于 `batch.n_tokens` 的大小和 KV 缓存的占用情况——没有两套代码分支。
5. 循环的终止条件由 `n_pos` 与 `n_predict` 的关系控制,与 EOG token 判断是两个独立的退出机制(另一个在步骤 17 处理)。

下一步:[步骤 17 —— EOG 判定与收尾](tour-17-eog-cleanup.md)。
