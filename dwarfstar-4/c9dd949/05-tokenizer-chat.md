# 第 5 章：分词器与对话提示渲染

本章覆盖 DwarfStar 4 的完整分词链路：从字节级 BPE 的基础数学原理，到 JoyAI/DeepSeek 预分词的正则逻辑，再到对话模板的构造、thinking 模式的调控，以及 token-to-text 的逆向解码。所有入口集中在 `ds4.c:14446–15086` 和 `ds4.h:128–150`。

---

## 5.1 字节级 BPE 的设计动机

GPT-2 引入的字节级 BPE（Byte-Level BPE）解决了一个根本矛盾：词表应当有限，但原始字节（0–255）中存在大量"不可打印"字节——空字节、控制字符、高字节——无法直接嵌入 UTF-8 字符串。若将这些字节原样插入合并规则字符串，合并查找就必须处理含 NUL 或二进制噪声的 key，既难读又破坏字符串哈希的一致性。

GPT-2 的解决方案：**在 BPE 操作之前，将每个原始字节映射到一个保证可打印的 Unicode codepoint**。映射规则如下：

- 字节已经是"视觉上可打印"字符（ASCII 33–126、Latin-1 161–172、174–255）：codepoint = 字节本身。
- 其余字节（空格 0x20、控制字符 0x00–0x1f、0x7f、0x80–0xa0 等共 188 个）：按它们在 0–255 中出现的顺序，映射到 U+0100 起始的连续块，即 `codepoint = 256 + ordinal_index`。

ds4 实现见 `ds4.c:14464`：

```c
// ds4.c:14464
static uint32_t gpt2_byte_to_codepoint(uint8_t b) {
    if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174)) {
        return b;   // 已经是可打印字符，直接复用
    }
    uint32_t n = 0;
    for (uint32_t x = 0; x < 256; x++) {
        if ((x >= 33 && x <= 126) || (x >= 161 && x <= 172) || (x >= 174)) {
            continue;
        }
        if (x == b) return 256 + n;
        n++;
    }
    return b;
}
```

**关键后果**：BPE merge 表中存储的所有合并片段都是可打印 UTF-8 字符串，不含任何二进制特殊字符。这使得合并表可以直接以 key=字符串 的哈希表存储，无需特殊处理。

`byte_encode`（`ds4.c:14482`）将一段原始字节串逐字节通过 `gpt2_byte_to_codepoint` 转换，输出扩展后的 UTF-8 字节序列：

```c
// ds4.c:14482
static char *byte_encode(ds4_str in, uint64_t *out_len) {
    char *out = xmalloc((size_t)in.len * 4 + 1);
    char *p = out;
    for (uint64_t i = 0; i < in.len; i++) {
        utf8_put(&p, gpt2_byte_to_codepoint((uint8_t)in.ptr[i]));
    }
    *p = '\0';
    *out_len = (uint64_t)(p - out);
    return out;
}
```

分配 `in.len * 4 + 1` 字节是因为每个 codepoint 最多占 4 字节 UTF-8 编码。

逆映射（token-to-text 使用）在 `ds4.c:15021`：

```c
// ds4.c:15021
static int gpt2_codepoint_to_byte(uint32_t cp) {
    if ((cp >= 33 && cp <= 126) || (cp >= 161 && cp <= 172) || (cp >= 174 && cp <= 255)) {
        return (int)cp;
    }
    uint32_t n = 0;
    for (uint32_t b = 0; b < 256; b++) {
        if ((b >= 33 && b <= 126) || (b >= 161 && b <= 172) || (b >= 174)) continue;
        if (cp == 256 + n) return (int)b;
        n++;
    }
    return -1;  // 非法 codepoint，跳过
}
```

---

## 5.2 哈希表：merge_rank 与 token_to_id

`ds4_vocab` 结构（`ds4.c:14358`）持有两张开放寻址哈希表（`str_i32_table`）：

| 字段 | 用途 |
|------|------|
| `token_to_id` | token 字符串（BPE 编码后的 UTF-8）→ token id |
| `merge_rank` | 合并对字符串（`"A B"` 形式）→ 合并优先级整数（越小越优先） |

`str_i32_table` 使用线性探测法（`ds4.c:14289`），初始容量为 `next_pow2(expected * 2 + 16)`，键为 `ds4_str`（指针+长度对）。合并查找的 key 拼接方式：`A + ' ' + B`（`ds4.c:14517`）：

```c
// ds4.c:14515
static int bpe_rank(const ds4_vocab *vocab, const owned_str *a, const owned_str *b) {
    uint64_t len = a->len + 1 + b->len;
    char stack[512];
    char *buf = len <= sizeof(stack) ? stack : xmalloc((size_t)len);
    memcpy(buf, a->ptr, (size_t)a->len);
    buf[a->len] = ' ';
    memcpy(buf + a->len + 1, b->ptr, (size_t)b->len);
    int rank = -1;
    table_get(&vocab->merge_rank, buf, len, &rank);
    if (buf != stack) free(buf);
    return rank;
}
```

使用栈缓冲区 `stack[512]` 避免绝大多数短合并对的动态分配，是对热路径的有效优化。返回 `-1` 表示该对无合并规则（不可合并）。

---

## 5.3 对单个预分词片段做 BPE：bpe_emit_piece

`bpe_emit_piece`（`ds4.c:14532`）是 BPE 的核心循环，处理一个预分词片段并输出 token id 列表：

<svg viewBox="0 0 640 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="bpe_emit_piece pipeline: raw bytes through four stages to token id sequence">
  <defs>
    <marker id="ar51" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="160" y="20" width="320" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="36" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">输入：原始字节序列</text>
  <text x="320" y="52" text-anchor="middle" font-size="11" fill="#64748b">预分词后的一个"词"片段</text>
  <line x1="320" y1="60" x2="320" y2="85" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="100" y="85" width="440" height="38" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="104" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">byte_encode</text>
  <text x="320" y="118" text-anchor="middle" font-size="10" fill="#94a3b8">每个原始字节 → GPT-2 可打印 Unicode codepoint</text>
  <line x1="320" y1="123" x2="320" y2="148" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="100" y="148" width="440" height="38" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="167" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">UTF-8 字符边界拆分</text>
  <text x="320" y="181" text-anchor="middle" font-size="10" fill="#94a3b8">初始符号数组 sym[]，每个元素为一个 codepoint</text>
  <line x1="320" y1="186" x2="320" y2="211" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="100" y="211" width="440" height="38" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="230" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">贪心合并循环</text>
  <text x="320" y="244" text-anchor="middle" font-size="10" fill="#64748b">bpe_rank 查 merge_rank 哈希表，选 rank 最小的相邻对合并，直到无可合并</text>
  <line x1="320" y1="249" x2="320" y2="274" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar51)"/>
  <rect x="160" y="274" width="320" height="20" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="289" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">输出：token id 序列（追加到 token_vec out）</text>
</svg>
<span class="figure-caption">图 R5.1 ｜ bpe_emit_piece 四阶段管线：从原始字节到 token id 序列</span>

<details>
<summary>ASCII 原版</summary>

```
输入：一段原始字节序列（预分词后的"词"）
  ↓  byte_encode：字节 → 可打印 Unicode
  ↓  按 UTF-8 字符边界拆分为初始符号数组 sym[]
  ↓  贪心合并循环：找 rank 最小的相邻对并合并
  ↓  遍历 sym[]，查 token_to_id 输出 id
输出：token id 序列（追加到 token_vec out）
```

</details>

贪心合并循环（`ds4.c:14552`）：

```c
// ds4.c:14552
for (;;) {
    int best_i = -1, best_rank = INT32_MAX;
    for (int i = 0; i + 1 < n_sym; i++) {
        int rank = bpe_rank(vocab, &sym[i], &sym[i + 1]);
        if (rank >= 0 && rank < best_rank) {
            best_rank = rank;
            best_i = i;
        }
    }
    if (best_i < 0) break;  // 无更多合并

    // 原地合并 sym[best_i] 和 sym[best_i+1]
    owned_str merged;
    merged.len = sym[best_i].len + sym[best_i + 1].len;
    merged.ptr = xmalloc((size_t)merged.len);
    memcpy(merged.ptr, sym[best_i].ptr, sym[best_i].len);
    memcpy(merged.ptr + sym[best_i].len, sym[best_i + 1].ptr, sym[best_i + 1].len);
    // ... 压缩 sym 数组，n_sym--
}
```

每次循环 O(n_sym) 扫描，总复杂度 O(n²)，但 BPE 词表设计保证每个片段合并次数有限（通常 < 20 次）。

合并完成后，对每个符号查表（`ds4.c:14582`）。若符号不在词表（异常字符），逐字节回退查找（`ds4.c:14587`）——这是对损坏输入的容错处理。

---

## 5.4 DeepSeek/JoyAI 预分词

### 5.4.1 为什么预分词形状很重要

BPE 将整个文本分割为 token，但**在 BPE 之前必须先把文本切成"词（pieces）"**——BPE 不会跨"词"边界合并。不同的切分形状意味着不同的上下文，直接改变最终 token 序列。即使同样的字节，因预分词切法不同，logit 输出也会有差异，这就是注释 `ds4.c:14706` 中"split shape matters"的含义。

DeepSeek V4 Flash 的分词器使用 `tokenizer.ggml.pre = "joyai-llm"` 标记。正则规则集（`ds4.c:14688`）：

```text
\p{N}{1,3}                          数字：最多 3 位一组
[CJK/Hiragana/Katakana]+            CJK+假名连续块（逐字符边界）
[P/S][A-Za-z]+                      标点/符号开头 + 字母序列
[^\r\n\p{L}\p{P}\p{S}]?[\p{L}\p{M}]+  可选非字母前缀 + 字母序列
 ?[\p{P}\p{S}]+[\r\n]*              可选空格 + 标点符号序列（含尾随换行）
\s*[\r\n]+                           空白以换行结束
\s+(?!\S)                            末尾空白
\s+                                  普通空白
```

关键设计决策（`ds4.c:14702`）：**标点规则将尾随换行纳入同一 BPE 片段**（如 `">;\n"`），而不是单独切分换行。若拆开换行，代码提示的 token 流会不同，导致长上下文 logit 错误。

### 5.4.2 bpe_tokenize_text 分支逻辑

`bpe_tokenize_text`（`ds4.c:14708`）是预分词的主循环：

```c
// ds4.c:14708（简化）
while (pos < len) {
    uint8_t c = (uint8_t)text[pos];
    if (ascii_digit(c)) {
        // 最多 3 位数字一组
    } else if (joyai_cjk_at(text, len, pos)) {
        // 吸收连续 CJK/假名字符
    } else if (joyai_ascii_punct_symbol(c) && ascii_alpha(text[pos+1])) {
        // [P/S][A-Za-z]+
    } else if (joyai_letter_like_at(text, len, pos)) {
        // 字母序列
    } else if (ascii_space(c)) {
        // 空格的复杂处理：前导空格可以附着到后续词
    } else if (joyai_ascii_punct_symbol(c)) {
        // 标点 + 尾随换行
    } else {
        pos = next_utf8_char(text, len, pos);
    }
    bpe_emit_piece(vocab, (ds4_str){text+start, pos-start}, out);
}
```

**前导空格规则**（`ds4.c:14757`）值得特别注意：`"    int"` 被切分为 `"   "` + `" int"`，而不是 `"    "` + `"int"`。JoyAI 允许一个前导空格附着到后续字母或标点序列，这与 GPT-2 的 `Ġword` 前缀约定等价但实现方式不同。

CJK 字符检测（`ds4.c:14681`）覆盖 CJK 统一汉字（U+4E00–U+9FA5）、平假名（U+3040–U+309F）、片假名（U+30A0–U+30FF）：

```c
// ds4.c:14630
static bool utf8_is_cjk_hira_kata(uint32_t cp) {
    return (cp >= 0x4e00 && cp <= 0x9fa5) ||
           (cp >= 0x3040 && cp <= 0x309f) ||
           (cp >= 0x30a0 && cp <= 0x30ff);
}
```

非 ASCII、非 CJK、非控制字节被 `joyai_letter_like_at`（`ds4.c:14658`）视为"字母类"——这种宽泛处理保留了法语重音、阿拉伯字符等 UTF-8 文本的正确分组行为。

### 5.4.3 预分词整体流程示意

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Pre-tokenization example splitting input text into pieces before BPE">
  <defs>
    <marker id="ar52" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="12" width="360" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="25" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">输入文本</text>
  <text x="380" y="40" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">" Hello, 世界123\n"</text>
  <line x1="380" y1="46" x2="380" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="280" y="66" width="200" height="22" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="81" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">bpe_tokenize_text（JoyAI 预分词）</text>
  <line x1="220" y1="88" x2="110" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="290" y1="88" x2="240" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="340" y1="88" x2="340" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="390" y1="88" x2="420" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="430" y1="88" x2="500" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="480" y1="88" x2="580" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="520" y1="88" x2="670" y2="110" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <rect x="40" y="110" width="130" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="105" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">" Hello"</text>
  <text x="105" y="139" text-anchor="middle" font-size="9" fill="#64748b">前导空格附着字母</text>
  <rect x="180" y="110" width="100" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="230" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">","</text>
  <text x="230" y="139" text-anchor="middle" font-size="9" fill="#64748b">ASCII 标点</text>
  <rect x="295" y="110" width="90" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="340" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">" "</text>
  <text x="340" y="139" text-anchor="middle" font-size="9" fill="#64748b">单独空格</text>
  <rect x="390" y="110" width="90" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="435" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">"世"</text>
  <text x="435" y="139" text-anchor="middle" font-size="9" fill="#64748b">CJK 单字</text>
  <rect x="487" y="110" width="90" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="532" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">"界"</text>
  <text x="532" y="139" text-anchor="middle" font-size="9" fill="#64748b">CJK 单字</text>
  <rect x="584" y="110" width="90" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="629" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">"123"</text>
  <text x="629" y="139" text-anchor="middle" font-size="9" fill="#64748b">3 位数字一组</text>
  <rect x="680" y="110" width="70" height="36" rx="4" fill="#f1f5f9" stroke="#0d9488" stroke-width="1"/>
  <text x="715" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">"\n"</text>
  <text x="715" y="139" text-anchor="middle" font-size="9" fill="#64748b">换行</text>
  <line x1="105" y1="146" x2="105" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="230" y1="146" x2="230" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="340" y1="146" x2="340" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="435" y1="146" x2="435" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="532" y1="146" x2="532" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="629" y1="146" x2="629" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <line x1="715" y1="146" x2="715" y2="185" stroke="#94a3b8" stroke-width="1" marker-end="url(#ar52)"/>
  <rect x="40" y="185" width="710" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="395" y="205" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">对每个片段调用 bpe_emit_piece</text>
  <line x1="395" y1="215" x2="395" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar52)"/>
  <rect x="200" y="250" width="390" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="395" y="270" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">最终 token id 序列</text>
</svg>
<span class="figure-caption">图 R5.2 ｜ JoyAI 预分词将输入文本切分为 7 个片段再逐一调用 bpe_emit_piece</span>

<details>
<summary>ASCII 原版</summary>

```
输入文本：" Hello, 世界123\n"
         |
         ↓ bpe_tokenize_text
         |
  片段1: " Hello"  （前导空格附着到字母序列）
  片段2: ","       （ASCII 标点）
  片段3: " "       （单独空格）
  片段4: "世"      （单个 CJK，每个单独一组）
  片段5: "界"
  片段6: "123"     （3 位数字一组）
  片段7: "\n"      （换行，独立片段）
         |
         ↓ 对每个片段调用 bpe_emit_piece
         |
  最终 token id 序列
```

</details>

---

## 5.5 从 GGUF 元数据加载词表

`vocab_load`（`ds4.c:14787`）从 GGUF 键读取三类信息：

| GGUF 键 | 内容 |
|---------|------|
| `tokenizer.ggml.tokens` | 词表字符串数组，索引即 token id |
| `tokenizer.ggml.merges` | 合并对字符串数组，数组下标即 rank |

加载流程：

```c
// ds4.c:14787（精简）
static void vocab_load(ds4_vocab *vocab, const ds4_model *model) {
    // 1. 读取 tokens 数组，建立 token_to_id 哈希表
    vocab->n_vocab = (int)tokens.len;
    vocab->token = xcalloc((size_t)vocab->n_vocab, sizeof(vocab->token[0]));
    table_init(&vocab->token_to_id, tokens.len);
    for (int i = 0; i < vocab->n_vocab; i++) {
        cursor_string(&c, &vocab->token[i]);
        table_put(&vocab->token_to_id, vocab->token[i], i);
    }
    // 2. 读取 merges 数组，以数组下标为 rank 建立 merge_rank 哈希表
    table_init(&vocab->merge_rank, merges.len);
    for (uint64_t i = 0; i < merges.len; i++) {
        cursor_string(&c, &merge);
        table_put(&vocab->merge_rank, merge, (int)i);
    }
    // 3. 查找特殊 token id
    vocab->bos_id       = vocab_lookup(vocab, "<｜begin▁of▁sentence｜>");
    vocab->eos_id       = vocab_lookup(vocab, "<｜end▁of▁sentence｜>");
    vocab->user_id      = vocab_lookup(vocab, "<｜User｜>");
    vocab->assistant_id = vocab_lookup(vocab, "<｜Assistant｜>");
    vocab->think_start_id = vocab_lookup(vocab, "<think>");
    vocab->think_end_id   = vocab_lookup(vocab, "</think>");
    vocab->dsml_id        = vocab_lookup(vocab, "｜DSML｜");
}
```

`vocab_lookup`（`ds4.c:14778`）若找不到特殊 token 则直接 `exit(1)`，因为缺失任何一个特殊 token 都会导致对话模板或推理模式完全失效。

特殊 token 使用 Unicode 全角竖线 `｜`（U+FF5C）和中间点 `▁`（U+2581），这是刻意选择——与 ASCII `|` 不同，避免在普通文本中误触。`vocab_token_is_literal_special`（`ds4.c:15037`）通过检测 `U+FF5C` 的 UTF-8 编码（`0xef 0xbd 0x9c`）来识别这类 token，跳过字节解码。

词表大小：`DS4_N_VOCAB = 129280`（`ds4.c:89`）。

---

## 5.6 对话模板渲染

### 5.6.1 模板结构

DeepSeek V4 Flash 的对话格式遵循固定模板，`encode_chat_prompt`（`ds4.c:14837`）实现：

```text
[BOS]
[Think Max 前缀（仅 DS4_THINK_MAX）]
[system 文本（若非空，直接 BPE 编码，无角色标记）]
<｜User｜>
[user prompt 文本]
<｜Assistant｜>
<think>  （DS4_THINK_NONE: </think>；DS4_THINK_HIGH/MAX: <think>）
```

```c
// ds4.c:14840
static void encode_chat_prompt(
        const ds4_vocab *vocab, const char *system,
        const char *prompt, ds4_think_mode think_mode, token_vec *out) {
    token_vec_push(out, vocab->bos_id);
    if (think_mode == DS4_THINK_MAX) {
        bpe_tokenize_text(vocab, DS4_REASONING_EFFORT_MAX_PREFIX, out);
    }
    if (system && system[0]) {
        bpe_tokenize_text(vocab, system, out);
    }
    token_vec_push(out, vocab->user_id);
    bpe_tokenize_text(vocab, prompt, out);
    token_vec_push(out, vocab->assistant_id);
    token_vec_push(out, ds4_think_mode_enabled(think_mode) ?
                   vocab->think_start_id : vocab->think_end_id);
}
```

**注意**：system 文本直接以 BPE token 插入，没有专用角色标记——DeepSeek V4 Flash 的提示格式将 system 内容视为 BOS 后的纯文本前缀，紧接其后才是 `<｜User｜>` 标记。

### 5.6.2 公共 API

`ds4.h:136` 声明的完整对话构建 API：

| 函数 | 用途 |
|------|------|
| `ds4_chat_begin` | 推送 BOS token |
| `ds4_encode_chat_prompt` | 一次性编码完整单轮对话（BOS + system + user + assistant 前缀） |
| `ds4_chat_append_message` | 追加一条消息（支持 system/developer/assistant/user/tool/function 角色） |
| `ds4_chat_append_assistant_prefix` | 追加 `<｜Assistant｜>` + `<think>` 或 `</think>` |
| `ds4_chat_append_max_effort_prefix` | 追加 Think Max 的长推理前缀文本 |
| `ds4_tokenize_text` | 对纯文本做 BPE（不插特殊 token） |
| `ds4_tokenize_rendered_chat` | 对已渲染的对话字符串做分词（能识别并直接映射特殊 token） |

`ds4_chat_append_message`（`ds4.c:14943`）对不同角色的处理差异：
- `system`/`developer`：仅 BPE 编码内容，不推角色标记。
- `assistant`：推 `<｜Assistant｜>`，若内容不以 `<think>`/`</think>` 开头则自动插入 `</think>`。
- `user`/`tool`/`function`：推 `<｜User｜>`，tool 类消息前加 `"Tool: "` 前缀。

`ds4_tokenize_rendered_chat`（`ds4.c:14922`）与 `ds4_tokenize_text` 的区别：前者在普通 BPE 流中识别特殊 token 字面量（如 `<｜Assistant｜>`），将其直接映射为对应 id，而不是拆散为 BPE 片段。

### 5.6.3 多轮对话示例 token 序列

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Multi-turn chat token sequence showing BOS, special tokens and BPE tokens across two rounds">
  <defs>
    <marker id="ar53" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="30" y="20" font-size="11" font-weight="600" fill="#64748b">位置 →</text>
  <rect x="20" y="30" width="60" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="50" y="49" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">BOS</text>
  <rect x="88" y="30" width="160" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="168" y="49" text-anchor="middle" font-size="11" fill="currentColor">system BPE tokens</text>
  <rect x="256" y="30" width="90" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="301" y="49" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">&lt;｜User｜&gt;</text>
  <text x="301" y="64" text-anchor="middle" font-size="9" fill="#94a3b8">user_id</text>
  <line x1="20" y1="72" x2="720" y2="72" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="20" y="80" width="200" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="120" y="99" text-anchor="middle" font-size="11" fill="currentColor">user 内容 BPE tokens</text>
  <rect x="228" y="80" width="110" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="283" y="99" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">&lt;｜Assistant｜&gt;</text>
  <text x="283" y="114" text-anchor="middle" font-size="9" fill="#94a3b8">assistant_id</text>
  <rect x="346" y="80" width="80" height="28" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="386" y="99" text-anchor="middle" font-size="10" font-weight="700" fill="#0d9488">&lt;/think&gt;</text>
  <text x="386" y="114" text-anchor="middle" font-size="9" fill="#94a3b8">THINK_NONE</text>
  <line x1="20" y1="122" x2="720" y2="122" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="20" y="130" width="300" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="170" y="149" text-anchor="middle" font-size="11" fill="currentColor">第一轮 assistant 内容 BPE tokens</text>
  <line x1="20" y1="172" x2="720" y2="172" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="375" y="168" text-anchor="middle" font-size="10" fill="#64748b">——— 第二轮开始 ———</text>
  <rect x="20" y="178" width="90" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="65" y="197" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">&lt;｜User｜&gt;</text>
  <text x="65" y="212" text-anchor="middle" font-size="9" fill="#94a3b8">user_id</text>
  <rect x="118" y="178" width="220" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="228" y="197" text-anchor="middle" font-size="11" fill="currentColor">第二轮 user 内容 BPE tokens</text>
  <line x1="20" y1="220" x2="720" y2="220" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <rect x="20" y="228" width="110" height="28" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="75" y="247" text-anchor="middle" font-size="10" font-weight="700" fill="#7c3aed">&lt;｜Assistant｜&gt;</text>
  <rect x="138" y="228" width="80" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="178" y="247" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">&lt;think&gt;</text>
  <text x="178" y="262" text-anchor="middle" font-size="9" fill="#94a3b8">THINK_HIGH</text>
  <rect x="226" y="228" width="460" height="28" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="5,3"/>
  <text x="456" y="247" text-anchor="middle" font-size="11" font-weight="600" fill="#16a34a">← 模型在此开始生成</text>
  <text x="30" y="300" font-size="10" fill="#94a3b8">颜色说明：</text>
  <rect x="110" y="288" width="14" height="14" rx="2" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="128" y="300" font-size="10" fill="#64748b">BOS / 强调特殊 token</text>
  <rect x="290" y="288" width="14" height="14" rx="2" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="308" y="300" font-size="10" fill="#64748b">角色标记 token</text>
  <rect x="430" y="288" width="14" height="14" rx="2" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="448" y="300" font-size="10" fill="#64748b">think 控制 token</text>
  <rect x="110" y="308" width="14" height="14" rx="2" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="128" y="320" font-size="10" fill="#64748b">BPE 普通 token 块</text>
</svg>
<span class="figure-caption">图 R5.3 ｜ 两轮对话的完整 token 序列，第二轮以 THINK_HIGH 模式结尾等待模型生成</span>

<details>
<summary>ASCII 原版</summary>

```
BOS
  ↓
[system BPE tokens]           （若有）
<｜User｜>                    vocab->user_id
[user 内容 BPE tokens]
<｜Assistant｜>               vocab->assistant_id
</think>                       vocab->think_end_id  （THINK_NONE）
[assistant 内容 BPE tokens]
<｜User｜>                    第二轮用户消息
[user 内容 BPE tokens]
<｜Assistant｜>
<think>                        vocab->think_start_id  （THINK_HIGH）
                               ← 模型在此开始生成
```

</details>

---

## 5.7 Thinking 模式

### 5.7.1 三种模式

`ds4_think_mode`（`ds4.h:23`）：

| 枚举值 | 含义 | 结尾 token |
|--------|------|-----------|
| `DS4_THINK_NONE` | 禁用思考，直接输出 | `</think>` |
| `DS4_THINK_HIGH` | 启用标准思考 | `<think>` |
| `DS4_THINK_MAX` | 最大推理强度 | `<think>` + Max 前缀 |

`ds4_think_mode_enabled`（`ds4.c:15634`）：`HIGH` 和 `MAX` 均返回 `true`。

### 5.7.2 Think Max 前缀与上下文要求

`DS4_THINK_MAX` 会在 BOS 之后、system 之前注入一段长文本（`ds4.c:63`）：

```c
// ds4.c:63
static const char DS4_REASONING_EFFORT_MAX_PREFIX[] =
    "Reasoning Effort: Absolute maximum with no shortcuts permitted.\n"
    "You MUST be very thorough in your thinking and comprehensively "
    "decompose the problem to resolve the root cause, rigorously "
    "stress-testing your logic against all potential paths, edge cases, "
    "and adversarial scenarios.\n"
    "Explicitly write out your entire deliberation process, documenting "
    "every intermediate step, considered alternative, and rejected "
    "hypothesis to ensure absolutely no assumption is left unchecked.\n\n";
```

该前缀本身会消耗大量 token，且引导模型输出大量思考内容。DeepSeek 要求 Think Max 至少配置 384K token 上下文窗口（`ds4.c:71`）：

```c
// ds4.c:71
#define DS4_THINK_MAX_MIN_CONTEXT 393216u  /* 384 * 1024 */
```

`ds4_think_mode_for_context`（`ds4.c:15655`）在运行时自动降级：

```c
// ds4.c:15655
ds4_think_mode ds4_think_mode_for_context(ds4_think_mode mode, int ctx_size) {
    if (mode == DS4_THINK_MAX &&
        (uint32_t)(ctx_size > 0 ? ctx_size : 0) < DS4_THINK_MAX_MIN_CONTEXT) {
        return DS4_THINK_HIGH;  // 静默降级，不中止
    }
    return mode;
}
```

调用方（CLI/server）在构造 prompt 前应先调用此函数获取实际使用的模式，而不是直接使用用户传入的模式。若不降级，在小上下文中注入 Max 前缀会导致模型期望大量推理空间却被截断。

---

## 5.8 token 转文本：ds4_token_text

`ds4_token_text`（`ds4.h:146`，实现 `ds4.c:15046`）将一个 token id 转换为原始字节字符串。由于词表中存储的是 GPT-2 字节编码后的 UTF-8，需要逆映射：

```c
// ds4.c:15046
char *ds4_token_text(ds4_engine *e, int token, size_t *len) {
    ds4_vocab *vocab = &e->vocab;
    // 边界检查...
    ds4_str s = vocab->token[token];
    char *out = xmalloc((size_t)s.len + 1);

    if (vocab_token_is_literal_special(s)) {
        // 含 U+FF5C 的特殊 token，直接复制原始 UTF-8
        memcpy(out, s.ptr, (size_t)s.len);
        out[s.len] = '\0';
        if (len) *len = (size_t)s.len;
        return out;
    }

    size_t n = 0;
    uint64_t pos = 0;
    while (pos < s.len) {
        uint32_t cp = utf8_decode_one(s.ptr, s.len, &pos);
        int b = gpt2_codepoint_to_byte(cp);
        if (b >= 0) out[n++] = (char)b;  // 逆映射回原始字节
    }
    out[n] = '\0';
    if (len) *len = n;
    return out;
}
```

**返回值生命周期**：调用方负责 `free()`。函数每次调用都 `xmalloc`，不缓存结果。

**多字节 UTF-8 跨 token 边界**：`ds4_token_text` 返回的原始字节可能是 UTF-8 多字节序列的片段（例如中文字符的前半部分）。这是正常行为——生成层在累积多个 token 后，将字节流整体解释为 UTF-8。调用方（`ds4_cli.c`、`ds4_server.c`）应维护跨 token 的字节缓冲，用 `utf8_len_from_first_byte`（`ds4.c:14494`）判断何时完成一个合法 UTF-8 码点后再输出。

**特殊 token 的特殊处理**：`vocab_token_is_literal_special`（`ds4.c:15037`）检测 token 字符串是否包含全角竖线 `｜`（U+FF5C，UTF-8: `0xef 0xbd 0x9c`）。若是，直接返回原始 UTF-8 字符串（如 `"<｜Assistant｜>"`），不做字节逆映射。这保证了特殊 token 在日志输出中可读。

---

## 5.9 分词链路完整流程

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Complete tokenization pipeline from raw prompt string to chat template wrapped token sequence">
  <defs>
    <marker id="ar54" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="10" width="300" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">原始 prompt 字符串</text>
  <line x1="380" y1="40" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="130" y="62" width="500" height="90" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="80" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">bpe_tokenize_text（JoyAI 预分词）</text>
  <rect x="150" y="88" width="110" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="205" y="103" text-anchor="middle" font-size="10" fill="#64748b">ascii_digit：≤3 位数字</text>
  <rect x="270" y="88" width="110" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="325" y="103" text-anchor="middle" font-size="10" fill="#64748b">joyai_cjk_at：逐字 CJK</text>
  <rect x="390" y="88" width="110" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="445" y="103" text-anchor="middle" font-size="10" fill="#64748b">标点/字母规则</text>
  <rect x="510" y="88" width="110" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="565" y="103" text-anchor="middle" font-size="10" fill="#64748b">空白（前导空格附着）</text>
  <text x="380" y="140" text-anchor="middle" font-size="10" fill="#94a3b8">→ 预分词片段列表</text>
  <line x1="380" y1="152" x2="380" y2="174" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="130" y="174" width="500" height="100" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="192" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">bpe_emit_piece（对每个片段）</text>
  <rect x="150" y="200" width="140" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="220" y="215" text-anchor="middle" font-size="10" fill="#64748b">byte_encode：字节→Unicode</text>
  <rect x="300" y="200" width="140" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="370" y="215" text-anchor="middle" font-size="10" fill="#64748b">UTF-8 拆初始符号数组</text>
  <rect x="450" y="200" width="170" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="535" y="215" text-anchor="middle" font-size="10" fill="#7c3aed">贪心合并：bpe_rank 查 merge_rank</text>
  <rect x="280" y="230" width="200" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="380" y="245" text-anchor="middle" font-size="10" fill="#0d9488">逐符号查 token_to_id → token id</text>
  <line x1="380" y1="274" x2="380" y2="296" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="230" y="296" width="300" height="26" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="314" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">token id 序列</text>
  <line x1="380" y1="322" x2="380" y2="344" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar54)"/>
  <rect x="130" y="344" width="500" height="110" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="380" y="362" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">encode_chat_prompt（对话模板包装）</text>
  <rect x="150" y="370" width="55" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="177" y="385" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">BOS</text>
  <rect x="213" y="370" width="100" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="263" y="385" text-anchor="middle" font-size="10" fill="#64748b">Think Max prefix</text>
  <rect x="321" y="370" width="100" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="371" y="385" text-anchor="middle" font-size="10" fill="#64748b">system tokens</text>
  <rect x="429" y="370" width="80" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="469" y="385" text-anchor="middle" font-size="9" font-weight="700" fill="#7c3aed">&lt;｜User｜&gt;</text>
  <rect x="150" y="398" width="100" height="22" rx="3" fill="#fff" stroke="#cbd5e1" stroke-width="1"/>
  <text x="200" y="413" text-anchor="middle" font-size="10" fill="#64748b">user tokens</text>
  <rect x="258" y="398" width="110" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="313" y="413" text-anchor="middle" font-size="9" font-weight="700" fill="#7c3aed">&lt;｜Assistant｜&gt;</text>
  <rect x="376" y="398" width="130" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="441" y="413" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">&lt;think&gt; 或 &lt;/think&gt;</text>
  <text x="380" y="448" text-anchor="middle" font-size="11" fill="#94a3b8">↑ 取决于 ds4_think_mode</text>
</svg>
<span class="figure-caption">图 R5.4 ｜ 分词链路完整流程：从原始 prompt 经 JoyAI 预分词、BPE 合并到对话模板包装</span>

<details>
<summary>ASCII 原版</summary>

```
原始 prompt 字符串
    │
    ▼ bpe_tokenize_text（JoyAI 预分词）
    │
    ├─ ascii_digit：最多 3 位数字
    ├─ joyai_cjk_at：逐字 CJK/假名
    ├─ 标点/字母规则
    └─ 空白处理（前导空格附着）
    │
    ▼ bpe_emit_piece（对每个片段）
    │
    ├─ byte_encode：字节 → 可打印 Unicode codepoint
    ├─ 按 UTF-8 字符拆初始符号数组
    ├─ 贪心合并循环：bpe_rank 查 merge_rank 哈希表
    └─ 逐符号查 token_to_id → token id
    │
    ▼ token id 序列
    │
    ▼ encode_chat_prompt（对话模板包装）
    │
    ├─ BOS
    ├─ [Think Max prefix]
    ├─ [system BPE tokens]
    ├─ <｜User｜>
    ├─ [user BPE tokens]
    ├─ <｜Assistant｜>
    └─ <think> 或 </think>
```

</details>

---

## 5.10 相关章节

- GGUF 格式与元数据读取见 [第 3 章](03-gguf-loading.md)
- ds4_session 消费 token id 序列进行推理见 [第 6 章](06-engine-session.md)
- 服务端 HTTP 层对 `ds4_chat_append_message` 的调用见 [第 13 章](13-http-server-api.md)
- 磁盘 KV 缓存持久化见 [第 14 章](14-disk-kv-cache.md)
