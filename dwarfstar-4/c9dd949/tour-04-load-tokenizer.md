# Trace 步骤 04 —— 分词器从哪来？为什么也藏在 GGUF 里？

## 1. 当前情境

步骤 03 结束后，模型的张量世界已经完全就绪：

```
ds4_weights.layer[0..42]   所有 43 层的指针已绑定
ds4_weights.token_embd      词嵌入矩阵指针就绪（F16，4096 × 129280）
ds4_weights.output          输出投影矩阵就绪（Q8_0，4096 × 129280）
config_validate_model()     所有超参数通过校验
```

现在缺的是把「你好」这个字符串变成 token id 序列的能力。没有分词器，模型就是一堆
无法被喂食的权重矩阵。

`ds4_engine_open()` 在权重绑定完成后调用 `vocab_load()`（`ds4.c:14788`），把
分词器数据从 `ds4_model`（mmap）里读出来，装进 `ds4_vocab`。

## 2. 问题

分词器需要的三样东西：

1. **词表字符串**：129280 个 token，每个 token 是一段 UTF-8 字符串（或字节转义串）。
   查 token id → 文本（解码），查文本 → token id（编码）。
2. **BPE merge ranks**：数十万条「`A B` → rank」映射，BPE 算法每次贪心找 rank 最低
   的相邻对合并，ranks 的相对顺序决定分词结果。
3. **Special token id**：BOS、EOS、`<｜User｜>`、`<｜Assistant｜>`、`<think>` /
   `</think>` 等，这些 id 需要在构造 prompt 时直接插入，不走 BPE。

这些数据从哪里来？

## 3. 朴素思路

分词器和模型权重分开存：权重是 `.gguf`，分词器是一个独立的 `tokenizer.json`
（Hugging Face 格式）或 `vocab.txt` + `merges.txt`（旧格式）。程序启动时先加载权重，
再加载分词器文件。

这是 llama.cpp 早期版本的做法，也是 Hugging Face Transformers 的标准做法。

## 4. 为什么朴素思路会崩

**版本漂移**是根本问题。

- 用户下载了 `DS4-Flash-Q4.gguf`，也下载了 `tokenizer.json`，但两个文件来自模型仓库
  的不同 commit。一次 tokenizer 更新（比如添加了新的 special token，或修改了某个
  边缘字符的 BPE merge）会让已下载的权重文件和新 tokenizer 悄悄对不上。
- 分词器文件格式有 Hugging Face、SentencePiece、tiktoken 等多种，每种格式解析代码
  不同，增加分发和维护复杂度。
- 推理引擎需要分发两个文件而不是一个，用户部署时容易漏掉其中一个。

另一个问题是**编码一致性**：如果权重文件里的 `token_embd.weight` 行 `i` 对应 token
`i` 的嵌入，那么词表顺序必须和权重顺序严格一致。拆成两个文件时，这个一致性只能靠
文档约定，没有结构强制。

## 5. DwarfStar 4 的做法

GGUF 格式的设计决策之一就是**把分词器数据内嵌到模型文件的元数据区**。步骤 02 解析
出来的 `m->kv[]` 数组里，除了模型超参数，还包含三个关键数组键：

```
tokenizer.ggml.tokens   → 字符串数组，长度 = vocab_size
tokenizer.ggml.merges   → 字符串数组，格式 "A B"，顺序即 merge rank
```

`vocab_load()`（`ds4.c:14788`）直接从这里读取，过程分两阶段：

**阶段一：建词表索引**

```c
// ds4.c:14791-14810
model_get_array(model, "tokenizer.ggml.tokens", &tokens);
model_get_array(model, "tokenizer.ggml.merges", &merges);

vocab->n_vocab = (int)tokens.len;                         // 129280
vocab->token   = xcalloc(vocab->n_vocab, sizeof(...));    // token 字符串数组
table_init(&vocab->token_to_id, tokens.len);              // 哈希表：文本 → id

ds4_cursor c = cursor_at(model, tokens.data_pos);
for (int i = 0; i < vocab->n_vocab; i++) {
    cursor_string(&c, &vocab->token[i]);   // 字符串驻留在 mmap，不拷贝
    table_put(&vocab->token_to_id, vocab->token[i], i);
}
```

`vocab->token[i]` 是 `ds4_str`（指针 + 长度），指向 mmap 内的字节——词表字符串
也是零拷贝。`token_to_id` 哈希表是唯一需要额外分配的结构，用于 O(1) 编码查找。

**阶段二：建 merge rank 哈希表**

```c
// ds4.c:14813-14818
table_init(&vocab->merge_rank, merges.len);
c = cursor_at(model, merges.data_pos);
for (uint64_t i = 0; i < merges.len; i++) {
    ds4_str merge;
    cursor_string(&c, &merge);          // 形如 "Ġ he"（空格分隔的两段）
    table_put(&vocab->merge_rank, merge, (int)i);  // rank = 插入顺序
}
```

BPE merge 的顺序即为 rank——GGUF 里第 0 条是 rank 0（最高优先级合并）。
`bpe_rank()`（`ds4.c:14516`）在合并循环里查这张表：把相邻两个符号拼成
`"A B"` 格式的字符串（在栈上构造，优先不分配堆），查 `merge_rank` 表返回 rank，
找不到返回 -1 表示不能合并。

```c
// ds4.c:14516-14529  bpe_rank()
static int bpe_rank(const ds4_vocab *vocab,
                    const owned_str *a, const owned_str *b) {
    uint64_t len = a->len + 1 + b->len;
    char stack[512];
    char *buf = len <= sizeof(stack) ? stack : xmalloc((size_t)len);
    memcpy(buf, a->ptr, a->len);
    buf[a->len] = ' ';
    memcpy(buf + a->len + 1, b->ptr, b->len);
    int rank = -1;
    table_get(&vocab->merge_rank, buf, len, &rank);
    if (buf != stack) free(buf);
    return rank;
}
```

**阶段三：绑定 special token id**

```c
// ds4.c:14821-14827
vocab->bos_id         = vocab_lookup(vocab, "<｜begin▁of▁sentence｜>");
vocab->eos_id         = vocab_lookup(vocab, "<｜end▁of▁sentence｜>");
vocab->user_id        = vocab_lookup(vocab, "<｜User｜>");
vocab->assistant_id   = vocab_lookup(vocab, "<｜Assistant｜>");
vocab->think_start_id = vocab_lookup(vocab, "<think>");
vocab->think_end_id   = vocab_lookup(vocab, "</think>");
vocab->dsml_id        = vocab_lookup(vocab, "｜DSML｜");
```

`vocab_lookup()`（`ds4.c:14778`）在 `token_to_id` 表里找，找不到就 `exit(1)`——
这些 special token 是 chat 模板的结构性 token，缺少任何一个程序都无法构造合法 prompt。
这个检查也顺带验证了词表文件确实是 DeepSeek V4 的词表：LLaMA-3 的词表没有 `<｜User｜>`，
加载会在这里就终止。

整体内存布局：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Memory layout after vocab_load: mmap holds token strings and merge data zero-copy, heap holds only two hash tables and a pointer array">
  <defs>
    <marker id="ar-t4-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="10" width="310" height="240" rx="8" fill="#f8fafc" stroke="#0d9488" stroke-width="2"/>
  <text x="185" y="30" font-size="13" font-weight="600" fill="#0d9488" text-anchor="middle">mmap（ds4_model.map）</text>
  <rect x="50" y="42" width="270" height="110" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="185" y="60" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">元数据区（KV 表）</text>
  <rect x="62" y="68" width="246" height="26" rx="3" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="185" y="85" font-size="10" fill="#64748b" text-anchor="middle">tokenizer.ggml.tokens  —  129280 个 token 字符串</text>
  <rect x="62" y="100" width="246" height="26" rx="3" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="185" y="117" font-size="10" fill="#64748b" text-anchor="middle">tokenizer.ggml.merges  —  数十万条 BPE merge 对</text>
  <rect x="62" y="132" width="246" height="16" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="185" y="144" font-size="10" fill="#94a3b8" text-anchor="middle">deepseek4.* 超参数 / 其他 KV</text>
  <rect x="50" y="162" width="270" height="72" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="185" y="180" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">张量数据区</text>
  <text x="185" y="196" font-size="10" fill="#64748b" text-anchor="middle">~25 GiB 量化权重</text>
  <text x="185" y="212" font-size="10" fill="#94a3b8" text-anchor="middle">vocab_load 不触碰此区域</text>
  <text x="185" y="232" font-size="10" fill="#94a3b8" text-anchor="middle">零拷贝，内核按需分页</text>
  <rect x="420" y="10" width="310" height="200" rx="8" fill="#f8fafc" stroke="#ea580c" stroke-width="2"/>
  <text x="575" y="30" font-size="13" font-weight="600" fill="#ea580c" text-anchor="middle">堆（新分配）</text>
  <rect x="440" y="42" width="270" height="46" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="575" y="60" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">vocab-&gt;token[]</text>
  <text x="575" y="76" font-size="10" fill="#64748b" text-anchor="middle">ds4_str 数组（指针+长度），~1 MB</text>
  <rect x="440" y="96" width="270" height="46" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="575" y="114" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">vocab-&gt;token_to_id</text>
  <text x="575" y="130" font-size="10" fill="#64748b" text-anchor="middle">哈希表（文本→id），~4 MB</text>
  <rect x="440" y="150" width="270" height="46" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="575" y="168" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">vocab-&gt;merge_rank</text>
  <text x="575" y="184" font-size="10" fill="#64748b" text-anchor="middle">哈希表（"A B"→rank），~数十 MB</text>
  <line x1="308" y1="78" x2="438" y2="78" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-t4-1)"/>
  <text x="370" y="72" font-size="9" fill="#94a3b8" text-anchor="middle">ptr 指向</text>
  <line x1="308" y1="113" x2="438" y2="173" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar-t4-1)"/>
  <text x="374" y="132" font-size="9" fill="#94a3b8" text-anchor="middle">键来自</text>
  <text x="380" y="295" font-size="10" fill="#94a3b8" text-anchor="middle">25 GiB 权重仍留在 mmap，词表字符串零拷贝，堆新增仅约 50 MB</text>
</svg>
<span class="figure-caption">图 T4.1 ｜ vocab_load 完成后的内存布局：token 字符串和 merge 键零拷贝留在 mmap，堆上仅两张哈希表</span>

<details>
<summary>ASCII 原版</summary>

```
mmap（ds4_model.map）
├── 元数据区
│   ├── tokenizer.ggml.tokens  ← vocab->token[i].ptr 指向这里（零拷贝）
│   ├── tokenizer.ggml.merges  ← vocab->merge_rank 的键来自这里（零拷贝）
│   └── deepseek4.* 超参数
└── 张量数据区（~25 GiB）
堆
├── vocab->token[]             ds4_str 数组（指针+长度），~1 MB
├── vocab->token_to_id         哈希表，~4 MB
└── vocab->merge_rank          哈希表，~数十 MB
```

</details>

## 6. 代码位置

按阅读顺序：

- `ds4.c:14787`：`vocab_load()` 注释 + 函数体，加载 token 字符串、special token、
  merge ranks 的入口。
- `ds4.c:14791`：`model_get_array()` 读取 `tokenizer.ggml.tokens` 数组引用。
- `ds4.c:14798`：`model_get_array()` 读取 `tokenizer.ggml.merges` 数组引用。
- `ds4.c:14807`：游标定位到 token 字符串区，开始逐条读取并建 `token_to_id` 哈希表。
- `ds4.c:14813`：游标定位到 merges 区，逐条读取并以插入顺序作为 rank 填入 `merge_rank` 表。
- `ds4.c:14821`：special token id 绑定，`vocab_lookup()` 找不到就 `exit(1)`。
- `ds4.c:14778`：`vocab_lookup()`，在 `token_to_id` 哈希表里找 special token，
  缺失则打印名字并退出。
- `ds4.c:14515`：`bpe_rank()`，BPE 合并循环里的 merge rank 查找，优先在栈上构造查询串。

## 7. 分支与延伸

- BPE 完整算法（`bpe_emit_piece()`、`bpe_tokenize_text()`）、字节级编码（`byte_encode()`）、
  special token 的优先匹配逻辑（`special_token_at()`）、以及 chat 模板如何用
  `encode_chat_prompt()` 把 `vocab` 里的 special id 拼成 prompt token 序列 →
  [第 5 章 分词器与对话模板](05-tokenizer-chat.md)
- GGUF 元数据的数组值类型、`model_get_array()` 的返回结构 `ds4_array_ref`、
  游标如何在 mmap 上顺序读取字符串数组而不拷贝内容 →
  [第 3 章 GGUF 加载](03-gguf-loading.md)
- `vocab->token_embd` 行 `i` 对应 token id `i` 的嵌入向量——词表顺序与权重行顺序
  强制一致，这正是分词器内嵌 GGUF 的结构保证；步骤 09 的 token 嵌入查表直接用
  `vocab->bos_id` 等 id 索引 `token_embd` →
  [第 3 章 GGUF 加载](03-gguf-loading.md)

## 8. 走完这一步你脑子里应该多了什么

1. **分词器内嵌 GGUF 是「版本锁定」设计**：词表、merge ranks 和权重打包在同一文件，
   消除了版本漂移的可能性——你下载的那个 `.gguf` 文件，词表和权重永远对齐。
2. **词表字符串是零拷贝的**：`vocab->token[i]` 的 `.ptr` 直接指向 mmap 内的字节，
   没有额外的字符串复制；只有两张哈希表（`token_to_id` 和 `merge_rank`）是新分配的堆内存。
3. **BPE merge rank 用「插入顺序即 rank」的编码**：GGUF 里 merges 数组的第 0 条就是
   rank 0（最优先合并），`bpe_rank()` 用 `"A B"` 格式的拼接字符串查哈希表，
   优先在 512 字节的栈缓冲里操作，避免热路径分配。
4. **Special token 查找兼做模型身份验证**：`<｜User｜>` 等 special token 在 LLaMA /
   Mistral 的词表里不存在，`vocab_lookup()` 一旦找不到就 `exit(1)`，相当于用
   分词器结构做了一次额外的「这是 DS4 系列模型」校验。
5. **这一步结束后引擎即将就绪**：词表、merge ranks、special token id 都已加载，
   下一步 `ds4_engine_open()` 完成收尾（Metal 图状态分配），之后就可以接受
   encode_chat_prompt 的调用，把「你好」变成 token 序列。
