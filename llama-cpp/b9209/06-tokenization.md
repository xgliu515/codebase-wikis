# 第 6 章 分词与词表

## 总览

分词是推理流程的"门卫"：将用户输入的 UTF-8 字符串转换为模型可以处理的整数 token id 序列，推理结束后再将 token id 序列还原为文本。llama.cpp 在单一 `llama_vocab` 结构中整合了词表存储、多类分词器算法、Unicode 工具库，以及分词/反分词的公开 C API。

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tokenization pipeline: UTF-8 text to token ids and back">
  <defs>
    <marker id="ar6-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="400" fill="#f8fafc" rx="6"/>
  <rect x="260" y="20" width="240" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">用户文本</text>
  <text x="380" y="53" text-anchor="middle" font-size="11" fill="#64748b">UTF-8 string</text>
  <line x1="380" y1="60" x2="380" y2="88" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-1)"/>
  <rect x="220" y="90" width="320" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="107" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">tokenizer_st_partition()</text>
  <text x="380" y="124" text-anchor="middle" font-size="11" fill="#64748b">特殊 token 识别与分离</text>
  <line x1="380" y1="134" x2="380" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-1)"/>
  <rect x="60" y="164" width="640" height="110" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="380" y="184" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">正文片段逐段处理 (fragment_buffer)</text>
  <rect x="80" y="192" width="280" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="220" y="212" text-anchor="middle" font-size="11" fill="#0d9488">SPM: Unigram 贪心 + 优先队列 bigram merge</text>
  <rect x="80" y="227" width="280" height="30" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="220" y="247" text-anchor="middle" font-size="11" fill="#0d9488">BPE: 预分词正则切分 → rank 排序 bigram merge</text>
  <rect x="390" y="192" width="290" height="30" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="535" y="212" text-anchor="middle" font-size="11" fill="#7c3aed">WPM: 空白切分 + 最长匹配</text>
  <rect x="390" y="227" width="290" height="30" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="535" y="247" text-anchor="middle" font-size="11" fill="#7c3aed">UGM: NFD 归一化 + Viterbi DP</text>
  <line x1="380" y1="274" x2="380" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-1)"/>
  <rect x="180" y="304" width="400" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="326" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">[llama_token] 序列 → 模型前向推理</text>
  <line x1="380" y1="338" x2="380" y2="358" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar6-1)"/>
  <rect x="220" y="360" width="320" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="380" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">detokenize() → 最终文本</text>
</svg>
<span class="figure-caption">图 R6.1 ｜ 分词流水线：UTF-8 文本经特殊 token 预扫描后按算法类型逐片处理，最终生成 token 序列并可反分词还原</span>

<details>
<summary>ASCII 原版</summary>

```
用户文本 (UTF-8 string)
        │
        ▼
 tokenizer_st_partition()        ← 特殊 token 识别与分离
        │
 ┌──────▼───────────────────────────────────────────────┐
 │ 正文片段逐段处理 (fragment_buffer)                     │
 │  ├─ SPM: Unigram 贪心 + 优先队列 bigram merge         │
 │  ├─ BPE: 预分词正则切分 → rank 排序 bigram merge       │
 │  ├─ WPM: 空白切分 + 最长匹配                           │
 │  └─ UGM: NFD 归一化 + Viterbi DP                     │
 └──────────────────────────────────────────────────────┘
        │
 [llama_token] 序列 → 模型前向推理
        │
        ▼
 token_to_piece() × n            ← 逐 token 反分词
        │
 detokenize()                    ← 拼接成完整文本
        │
 最终文本 (UTF-8 string)
```

</details>

关键文件：
- `src/llama-vocab.h` — `llama_vocab` 公开接口、`llama_vocab_pre_type` 枚举
- `src/llama-vocab.cpp` — 所有分词器实现及 `llama_vocab::impl`
- `src/unicode.h` / `src/unicode.cpp` — UTF-8、码点归一化工具
- `include/llama.h:1124–1159` — C API：`llama_tokenize`、`llama_token_to_piece`、`llama_detokenize`

---

## 6.1 分词在推理流程中的位置

<svg viewBox="0 0 640 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tokenization position in inference pipeline">
  <defs>
    <marker id="ar6-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="520" fill="#f8fafc" rx="6"/>
  <rect x="160" y="16" width="320" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="36" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_tokenize()</text>
  <text x="320" y="54" text-anchor="middle" font-size="11" fill="#64748b">用户文本 → [token_id]</text>
  <line x1="320" y1="64" x2="320" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="100" y="94" width="440" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="320" y="114" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_batch_get_one() / 手动填充</text>
  <text x="320" y="132" text-anchor="middle" font-size="11" fill="#64748b">llama_batch</text>
  <line x1="320" y1="142" x2="320" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="160" y="172" width="320" height="48" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="192" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_decode()</text>
  <text x="320" y="210" text-anchor="middle" font-size="11" fill="#64748b">建图、执行前向推理</text>
  <line x1="320" y1="220" x2="320" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="160" y="250" width="320" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="320" y="270" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_get_logits_ith()</text>
  <text x="320" y="288" text-anchor="middle" font-size="11" fill="#64748b">取最后一个 token 的 logits</text>
  <line x1="320" y1="298" x2="320" y2="326" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="160" y="328" width="320" height="48" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="320" y="348" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_sampler_sample()</text>
  <text x="320" y="366" text-anchor="middle" font-size="11" fill="#64748b">采样得到下一个 token_id</text>
  <line x1="320" y1="376" x2="320" y2="404" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="160" y="406" width="320" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="426" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">llama_token_to_piece()</text>
  <text x="320" y="444" text-anchor="middle" font-size="11" fill="#64748b">token_id → UTF-8 片段</text>
  <line x1="320" y1="454" x2="320" y2="482" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="200" y="484" width="240" height="28" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="503" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">流式拼接输出文本</text>
  <rect x="496" y="172" width="130" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="561" y="189" text-anchor="middle" font-size="10" fill="#94a3b8">分词在此阶段（输入端）</text>
  <rect x="496" y="406" width="130" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="561" y="423" text-anchor="middle" font-size="10" fill="#94a3b8">反分词在此阶段（输出端）</text>
</svg>
<span class="figure-caption">图 R6.2 ｜ 分词在推理流程中的位置：tokenize 在前向推理前（输入端），detokenize 在采样后（输出端）</span>

<details>
<summary>ASCII 原版</summary>

```
llama_tokenize()
      │  用户文本 → [token_id]
      ▼
llama_batch_get_one() / 手动填充 llama_batch
      │
      ▼
llama_decode()          ← 建图、执行前向推理
      │
      ▼
llama_get_logits_ith()  ← 取最后一个 token 的 logits
      │
llama_sampler_sample()  ← 采样得到下一个 token_id
      │
      ▼
llama_token_to_piece()  ← token_id → UTF-8 片段
      │
 流式拼接输出文本
```

</details>

分词发生在推理之前（输入端），反分词发生在采样之后（输出端）。两者均是纯 CPU 操作，不参与 ggml 计算图。

---

## 6.2 `llama_vocab`：词表与分词器

### 公开接口

`llama_vocab`（`src/llama-vocab.h:68–189`）使用 pimpl 惯用法，通过 `llama_vocab::impl`（`src/llama-vocab.cpp:1620`）隐藏实现细节：

```cpp
struct llama_vocab {
    struct token_data {
        std::string      text;   // token 的文本表示（可含 Unicode 转义）
        float            score;  // Unigram 对数概率分（SPM/UGM 专用）
        llama_token_attr attr;   // 属性标志：NORMAL | CONTROL | BYTE | ...
    };
    // 公开查询接口
    enum llama_vocab_type     get_type()     const;
    enum llama_vocab_pre_type get_pre_type() const;
    uint32_t n_tokens()       const;
    bool is_normal(llama_token id)  const;
    bool is_control(llama_token id) const;
    bool is_byte(llama_token id)    const;
    bool is_eog(llama_token id)     const; // end-of-generation
    // ...
private:
    struct impl;
    std::unique_ptr<impl> pimpl;
};
```

### `llama_vocab::impl` 的核心成员

```cpp
// src/llama-vocab.cpp:1620-1682
struct llama_vocab::impl {
    std::string tokenizer_model; // "llama" / "gpt2" / "bert" / "t5" / ...
    std::string tokenizer_pre;   // BPE 模型的预分词变体名，如 "llama3"

    enum llama_vocab_type     type;     // SPM / BPE / WPM / UGM / RWKV
    enum llama_vocab_pre_type pre_type; // BPE 预分词正则变体

    std::unordered_map<std::string, llama_token> token_to_id; // 文本 → id
    std::vector<token_data>                       id_to_token; // id → 数据

    std::vector<std::string> cache_token_to_piece; // 反分词缓存
    std::unordered_map<std::pair<std::string,std::string>, int, pair_hash> bpe_ranks;

    std::set<llama_token> special_eog_ids; // 所有 end-of-generation token

    std::unique_ptr<llm_tokenizer> tokenizer; // 具体分词器实例

    // 分词器行为标志
    bool add_space_prefix;        // SPM: 是否在首词前加空格
    bool add_bos;                 // 是否自动前置 BOS token
    bool add_eos;                 // 是否自动后置 EOS token
    bool ignore_merges;           // Llama3 BPE: 跳过 merge，直接查表
    bool clean_spaces;            // BPE: 去除 token 间多余空格
    bool escape_whitespaces;      // SPM 风格: 空格转 ▁
};
```

`load()` 函数（`src/llama-vocab.cpp:1757`）从 GGUF 元数据中读取 `tokenizer.ggml.model`、`tokenizer.ggml.tokens`、`tokenizer.ggml.scores`、`tokenizer.ggml.token_type` 等键，构建上述数据结构。

### `llama_vocab_type` 枚举

```cpp
// include/llama.h:72-79
enum llama_vocab_type {
    LLAMA_VOCAB_TYPE_NONE   = 0, // 无词表（纯视觉模型等）
    LLAMA_VOCAB_TYPE_SPM    = 1, // SentencePiece Unigram-like（LLaMA 1/2）
    LLAMA_VOCAB_TYPE_BPE    = 2, // GPT-2 风格 BPE（GPT-2、LLaMA3、Qwen、Mistral）
    LLAMA_VOCAB_TYPE_WPM    = 3, // WordPiece（BERT、nomic-bert）
    LLAMA_VOCAB_TYPE_UGM    = 4, // Unigram + sentencepiece normalization（T5、Gemma）
    LLAMA_VOCAB_TYPE_RWKV   = 5, // RWKV 自定义 byte 编码
    LLAMA_VOCAB_TYPE_PLAMO2 = 6, // PLaMo-2 Aho-Corasick + DP
};
```

**类型 → GGUF tokenizer.ggml.model 字段映射**：

| vocab_type | tokenizer_model 值 |
|---|---|
| SPM | `"llama"` |
| BPE | `"gpt2"` 或 `"gemma4"` |
| WPM | `"bert"` |
| UGM | `"t5"` |
| RWKV | `"rwkv"` |
| PLAMO2 | `"plamo2"` |

---

## 6.3 四类分词器算法

### SPM（SentencePiece Unigram-like）

用于 LLaMA 1/2、Baichuan、InternLM 等。代码：`src/llama-vocab.cpp:96–238`。

算法核心是一个以 **Unigram 分数**（log 概率）为键的优先队列 bigram merge：

```cpp
// src/llama-vocab.cpp:96-108
struct llm_bigram_spm {
    llm_symbol::index left;
    llm_symbol::index right;
    float score;   // 两段合并后 token 的 Unigram 分数
    size_t size;
};
```

**步骤**：
1. 将输入文本按 UTF-8 码点切分为初始 symbol 链表
2. 对所有相邻 symbol 对尝试合并：查 `vocab.text_to_token(left+right)` 是否存在，若存在则将其 score 加入优先队列
3. 每次取队顶（最高 score）的 bigram 合并，更新链表，继续向两侧探索新 bigram
4. 遍历剩余 symbol：若找到对应 token 则直接输出；否则回退到逐字节 token（`byte_to_token`）

SPM 的关键属性：空格在 tokenize 前被转义为 `▁`（U+2581），确保分词不受空格位置影响。

### BPE（Byte Pair Encoding，GPT-2 风格）

用于 GPT-2、LLaMA3、Mistral、Qwen、Falcon 等。代码：`src/llama-vocab.cpp:279–725`。

BPE 与 SPM 的根本差异：**排序依据是 merge 规则的 rank（构建时确定的优先级）**，而非运行时分数。

```cpp
// src/llama-vocab.cpp:263-277
struct llm_bigram_bpe {
    llm_symbol::index left;
    llm_symbol::index right;
    std::string text;
    int rank;    // 来自 bpe_ranks 表，越小越优先合并
    size_t size;
};
```

**步骤**：
1. **预分词**：用 `unicode_regex_split` 按 `regex_exprs` 将文本切分为"词"集合（预分词边界不可跨越）
2. 对每个词：初始化为字节/字符 symbol 序列
3. 对所有相邻 symbol 对查 `vocab.find_bpe_rank(left, right)` 获取 rank
4. 按 rank 从小到大合并，每次合并后向两侧更新候选对

LLaMA3 的特殊之处：`ignore_merges = true`（`src/llama-vocab.cpp:1969`），即在合并时先查整个词是否直接是一个 token，若是则直接使用而不走 merge 过程，这与 tiktoken 的行为一致。

### WPM（WordPiece）

用于 BERT、nomic-bert 等。代码：`src/llama-vocab.cpp:731–841`。

算法思路与 BPE 反向：从**完整子串**开始，若不在词表中则向左收缩，直到找到最长前缀匹配；若无任何匹配则输出 `[UNK]`。

```cpp
// src/llama-vocab.cpp:756-775（简化）
for (int i = 0; i < n; ++i) {
    for (int j = std::min(n, i + vocab.max_token_len() + 1); j > i; j--) {
        auto id = vocab.text_to_token(word1.substr(i, j - i));
        if (id != LLAMA_TOKEN_NULL) {
            output.push_back(id);
            i = j - 1;
            break;
        }
    }
    // 若无匹配，丢弃整个词并追加 UNK
}
```

预处理（`preprocess()`）会将文本 NFD 归一化、小写化，并在标点/汉字前后插入词边界，确保每个汉字单独成词。词首自动追加 `▁` 前缀。

### UGM（Unigram Language Model，T5 SentencePiece）

用于 T5、mT5、FLAN-T5 等。代码：`src/llama-vocab.cpp:847–1102`（`llm_tokenizer_ugm`）以及 `llm_tokenizer_ugm_session`（`src/llama-vocab.cpp:914–1102`）。

与 SPM 共享"Unigram 分数最大化"目标，但实现上使用**完整 Viterbi DP** 而非贪心 bigram 优先队列：

```cpp
// src/llama-vocab.cpp:930（算法注释摘抄）
// - 按 UTF 码点逐步遍历输入
// - 每步通过 token_matcher trie 找所有可能前缀 token
// - 对每个位置维护最优分数 tokenization_results[offset]
// - 最终从末尾回溯得到最优分词
```

Viterbi 的状态 `tokenization_results[i]` 存储"到达位置 i 的最优 token id 和累计分数"，时间复杂度 O(n × max_token_len)。

UGM 还有一个 `llm_tokenizer_plamo2`（`src/llama-vocab.cpp:1103`），使用 Aho-Corasick 自动机加速多模式匹配，配合 DP 实现 PLaMo-2 的特殊分词。

---

## 6.4 预分词（Pre-tokenization）

### 为什么存在 50+ 种预分词变体

BPE 分词器在 merge 之前需要先将文本切成不可跨越的"词"单元。这一步的正则规则直接决定了数字切分粒度、标点连接方式、多语言处理策略——不同模型的训练阶段使用了不同的 tokenizer 实现（tiktoken、HuggingFace tokenizers、SentencePiece），各自有略有差异的预分词行为。若不精确复现，分词结果就会与训练时不一致，导致性能下降。

`llama_vocab_pre_type`（`src/llama-vocab.h:10–62`）枚举了 52 种变体（截至该版本）。每个变体在 `llm_tokenizer_bpe` 构造函数中硬编码对应的 `regex_exprs`（`src/llama-vocab.cpp:279–530`）。

### 典型正则对比

**LLaMA3 / tiktoken 风格**（`LLAMA_VOCAB_PRE_TYPE_LLAMA3`）：

```
(?:'[sS]|'[tT]|'[rR][eE]|'[vV][eE]|'[mM]|'[lL][lL]|'[dD])|
[^\r\n\p{L}\p{N}]?\p{L}+|
\p{N}{1,3}|
 ?[^\s\p{L}\p{N}]+[\r\n]*|
\s*[\r\n]+|
\s+(?!\S)|
\s+
```
核心特征：数字按 **1–3 位**切分（避免长数字串），英文缩写（`'s`、`'t` 等）作为独立单元。

**DeepSeek V1 风格**（`LLAMA_VOCAB_PRE_TYPE_DEEPSEEK_LLM`）：

```
[\r\n]
\s?[A-Za-z...]+        ← 拉丁字母串
\s?[!-/:-~！-／：-～...]+  ← 标点符号串
\s+$                   ← 行尾空格
[一-龥ࠀ-一가-퟿]+     ← CJK/韩文
\p{N}+                 ← 数字
```
中文字符与拉丁字母完全分离，数字不限位数。

### `unicode_regex_split` 的实现

`src/unicode.cpp` 中的 `unicode_regex_split` 是预分词的执行引擎，将 Unicode 属性感知的正则（含 `\p{L}`、`\p{N}` 等 Unicode 类别）转换为基于 `unicode_cpt_flags` 的扫描。它不依赖 C++ `<regex>` 或 PCRE，而是用自定义的 Unicode 分类表实现，确保跨平台行为一致性。

`byte_encode` 标志控制 fallback 字节的表示：`true` 时将字节表示为单字符（GPT-2 的字节-Unicode 映射），`false` 时使用 `<0xXX>` 格式。

---

## 6.5 特殊 Token

### 特殊 token 的分类

`llama_token_attr` 是位掩码枚举，描述每个 token 的语义属性：

| 属性 | 含义 |
|---|---|
| `LLAMA_TOKEN_ATTR_NORMAL` | 普通词表 token |
| `LLAMA_TOKEN_ATTR_CONTROL` | 控制 token（`<bos>`、`<eos>`、`<|im_end|>` 等） |
| `LLAMA_TOKEN_ATTR_BYTE` | 单字节 fallback token（`<0x0A>` 等） |
| `LLAMA_TOKEN_ATTR_USER_DEFINED` | 用户定义 token（特殊字符串，优先于 merge）|
| `LLAMA_TOKEN_ATTR_UNKNOWN` | UNK token |
| `LLAMA_TOKEN_ATTR_UNUSED` | 词表中的占位符，不参与编码 |
| `LLAMA_TOKEN_ATTR_LSTRIP` / `RSTRIP` | 匹配时裁剪左/右空格 |

### 各特殊 token 的 id 存储

`llama_vocab::impl` 中直接存储常用特殊 token 的 id（`src/llama-vocab.cpp:1633–1650`）：

```cpp
llama_token special_bos_id  = 1;            // Begin-of-Sequence
llama_token special_eos_id  = 2;            // End-of-Sequence
llama_token special_eot_id  = LLAMA_TOKEN_NULL; // End-of-Turn（<|eot_id|>、<|im_end|> 等）
llama_token special_eom_id  = LLAMA_TOKEN_NULL; // End-of-Message
llama_token special_unk_id  = 0;            // Unknown
llama_token special_sep_id  = LLAMA_TOKEN_NULL; // SEP（BERT 风格）
llama_token special_pad_id  = LLAMA_TOKEN_NULL; // PAD
llama_token special_fim_pre_id = LLAMA_TOKEN_NULL; // FIM prefix（代码补全）
llama_token special_fim_suf_id = LLAMA_TOKEN_NULL; // FIM suffix
llama_token special_fim_mid_id = LLAMA_TOKEN_NULL; // FIM middle
```

`special_eog_ids`（`std::set<llama_token>`）收集**所有**导致生成终止的 token id，供采样循环中的 `is_eog()` 检查。

### EOT 自动检测

许多模型的 EOT token 没有统一的 id，而是通过 token 文本识别。`load()` 中的自动检测逻辑（`src/llama-vocab.cpp:2364–2389`）遍历所有 token，匹配文本如 `<|eot_id|>`、`<|im_end|>`、`<end_of_turn>`、`<｜end▁of▁sentence｜>`（DeepSeek）等，将其标记为 `CONTROL` 并加入 `special_eog_ids`。

### `add_bos` / `add_eos` 语义

- `add_special = true` 且 `add_bos = true` 时，`tokenize()` 在结果序列首部插入 `special_bos_id`
- `add_special = true` 且 `add_eos = true` 时，在尾部插入 `special_eos_id`
- 若输入文本本身已以 BOS/EOS 开头/结尾，会发出警告（双重 BOS/EOS 常见于使用 chat template 的场景）

### Byte Fallback

SPM/UGM 词表通常包含 256 个字节 token（`<0x00>` ... `<0xFF>`），用于表示无法被正常 token 覆盖的字节序列。`token_to_byte()` / `byte_to_token()` 执行 byte token ↔ 字节值的双向转换。BPE 的 byte fallback 基于 GPT-2 的字节-Unicode 映射（`Ā`→0x00, `ā`→0x01 等），通过 `llama_decode_text()` 反转。

---

## 6.6 Tokenize 与 Detokenize API

### `tokenizer_st_partition`：特殊 token 预扫描

分词的第一步是处理特殊 token（`src/llama-vocab.cpp:2916–3030`）。将输入字符串表示为 `forward_list<fragment_buffer_variant>`，其中每个元素要么是"原始文本片段"，要么是"已识别的特殊 token id"。

扫描过程按 `cache_special_tokens` 中的所有特殊 token 文本逐一扫描：若在文本中找到匹配，则将该区域切分为三部分（左文本、特殊 token、右文本），随后对各文本片段运行对应的子分词器。`parse_special = false` 时跳过 CONTROL 类特殊 token（将其视为普通文本）。

### `llama_tokenize` C API

```cpp
// include/llama.h:1124-1131
LLAMA_API int32_t llama_tokenize(
    const struct llama_vocab * vocab,
                  const char * text,
                     int32_t   text_len,
                 llama_token * tokens,
                     int32_t   n_tokens_max,
                        bool   add_special,
                        bool   parse_special);
```

**返回值约定**：
- 返回 `> 0`：成功，值为写入的 token 数量
- 返回 `< 0`（如 `-512`）：`tokens` 缓冲区不够，返回值的绝对值是所需 token 数量
- 返回 `INT32_MIN`：溢出（分词结果超过 `int32_t` 上限，极罕见）

正确用法：先以 `n_tokens_max = 0` / `tokens = nullptr` 调用获取所需大小（返回负值），再分配缓冲区后重新调用。或者直接使用 C++ `llama_vocab::tokenize()` 版本，返回 `std::vector<llama_token>`，无需手动管理缓冲区。

### `llama_token_to_piece` C API

```cpp
// include/llama.h:1138-1144
LLAMA_API int32_t llama_token_to_piece(
          const struct llama_vocab * vocab,
                       llama_token   token,
                              char * buf,
                           int32_t   length,
                           int32_t   lstrip,
                              bool   special);
```

**返回值约定**（`src/llama-vocab.cpp:3275–3395`）：
- 返回 `> 0`：成功，值为写入字节数（**不写 null-terminator**）
- 返回 `< 0`：`buf` 太小，返回值绝对值为所需字节数
- 返回 `0`：`special = false` 且 token 为控制 token，不输出任何内容

`lstrip` 参数允许跳过前置空格：对于 SPM 词表中以 `▁` 开头的 token，`lstrip = 1` 会跳过该前导空格，常用于解码时的空格去重。

`special = true` 时，控制 token 以其原始文本形式输出（如 `<bos>`），`false` 时静默忽略。

**缓存优化**：`cache_token_to_piece` 在 `load()` 完成后预填充（`src/llama-vocab.cpp:2724`），使热路径只需一次 `cache.at(token)` 查找，避免重复计算转义逻辑。

### `llama_detokenize` C API

```cpp
// include/llama.h:1152-1159
LLAMA_API int32_t llama_detokenize(
    const struct llama_vocab * vocab,
           const llama_token * tokens,
                     int32_t   n_tokens,
                        char * text,
                     int32_t   text_len_max,
                        bool   remove_special,
                        bool   unparse_special);
```

`detokenize` 本质是对每个 token 调用 `token_to_piece`，将结果追加到输出缓冲区。`remove_special = true` 时跳过 BOS/EOS；`unparse_special = true` 时将控制 token 输出为其文本形式（与 `special` 参数一致）。

**返回值**与 `llama_tokenize` 类似：正值表示成功字节数，负值表示所需更大缓冲区的大小。

---

## 6.7 Unicode 处理

### 为何需要独立的 Unicode 库

C++ 标准库的 `<regex>` 不支持 `\p{L}`（Unicode 字母类）等 Unicode 属性正则；各平台的 Unicode 支持版本不一；SentencePiece/tiktoken 的行为需要精确复现而非近似。llama.cpp 因此在 `src/unicode.cpp` + `src/unicode-data.cpp` 中内嵌了一套轻量级 Unicode 工具。

### 核心 API（`src/unicode.h`）

```cpp
size_t unicode_len_utf8(char src);               // 当前 UTF-8 序列长度（1–4）
std::string unicode_cpt_to_utf8(uint32_t cpt);   // 码点 → UTF-8 字节串
uint32_t unicode_cpt_from_utf8(const std::string & s, size_t & offset);
std::vector<uint32_t> unicode_cpts_from_utf8(const std::string & utf8); // 全文解码

// 码点属性查询
unicode_cpt_flags unicode_cpt_flags_from_cpt(uint32_t cpt);

// NFD 归一化（WPM 预处理用）
std::vector<uint32_t> unicode_cpts_normalize_nfd(const std::vector<uint32_t> & cpts);

// 大小写转换
uint32_t unicode_tolower(uint32_t cpt);

// 核心正则切分（BPE 预分词引擎）
std::vector<std::string> unicode_regex_split(
    const std::string & text,
    const std::vector<std::string> & regex_exprs,
    bool byte_encode = true);
```

### `unicode_cpt_flags`：码点分类

每个 Unicode 码点的属性存储为 `uint16_t` 位掩码，包含 Unicode 类别（Letter/Number/Punctuation/Symbol/Control/Separator/Mark）和辅助标志（whitespace/lowercase/uppercase/NFD）。

```cpp
// src/unicode.h:8-89
struct unicode_cpt_flags {
    uint16_t is_letter      : 1;  // \p{L}
    uint16_t is_number      : 1;  // \p{N}
    uint16_t is_punctuation : 1;  // \p{P}
    uint16_t is_symbol      : 1;  // \p{S}
    uint16_t is_whitespace  : 1;  // \s
    uint16_t is_lowercase   : 1;
    // ...
};
```

实际的码点→标志映射数据存储在 `src/unicode-data.cpp` 的静态表中（通过脚本从 Unicode 官方数据生成），避免在运行时加载 ICU 之类的重型库。

### NFD 归一化

`unicode_cpts_normalize_nfd` 将输入码点序列分解为标准分解形式（Canonical Decomposition）。WPM 预分词需要 NFD 确保带变音符号的字符（如 `é` = `e` + 组合重音）被正确分割为多个码点，再按 Unicode 字符类分词。

### `unicode_regex_split` 的实现策略

面对 `\p{L}`、`\p{N}` 等 Unicode 属性类正则，`unicode_regex_split` 的实现是：先将整个字符串按码点解码，然后用 `unicode_cpt_flags_from_cpt()` 查询每个码点的分类标志，再按正则模式逐码点扫描匹配，而不是使用传统的 NFA/DFA 正则引擎。对于纯 ASCII 子模式（如 `[\r\n]`、`[0-9]` 等），则退化为简单的字节级扫描，保持性能。

---

## 6.8 分词全流程串联

以 LLaMA3 BPE 分词 `"Hello, 世界!"` 为例：

```text
输入: "Hello, 世界!"

1. tokenizer_st_partition()
   → 无特殊 token 匹配，fragment_buffer = [raw_text("Hello, 世界!")]

2. unicode_regex_split("Hello, 世界!", regex_exprs=[llama3_regex])
   按正则切分词单元:
   → ["Hello", ",", " 世", "界", "!"]
   (注: "世"、"界" 不属于 \p{L} 的拉丁类，与前缀 " " 合并行为取决于具体匹配)

3. 对每个词单元，初始化 symbol 链表
   "Hello" → ['H','e','l','l','o']

4. 查 bpe_ranks 找 rank 最小的合并对，依次合并
   ('H','e') rank=xxx → 'He'
   ('He','l') → 'Hel'
   ...
   最终: "Hello" → token_id 9906 (如 LLaMA3 词表)

5. 对特殊字符 "," 查 vocab.text_to_token(",")
   → 直接得到 token_id

6. 汉字 "世界" 若不在词表，fallback 到 UTF-8 字节 token
   "世" = 0xE4 0xB8 0x96 → 三个 byte token

7. 添加 BOS (add_bos = true for llama3-bpe):
   output = [bos_id, 9906, ',', ' 世' byte tokens..., ...]
```

```text
输出: [1, 9906, 29892, 29871, 30793, ...]  ← llama_token 序列（举例，非真实值）
```

---

## 小结

| 设计决策 | 理由 |
|---|---|
| pimpl 隐藏实现 | 避免 `llama_vocab.h` 暴露 STL 容器，减少头文件依赖 |
| `cache_token_to_piece` 预填充 | 反分词是热路径，O(1) 查缓存比重复解析 token_text 快 1–2 个数量级 |
| 50+ BPE 预分词变体 | 严格复现各模型训练时的 tokenizer 行为，误差会导致生成质量下降 |
| `tokenizer_st_partition` 优先识别特殊 token | 确保 `<bos>`、`<|im_end|>` 等被完整识别而不被 BPE/SPM 切碎 |
| 自建 Unicode 工具库 | 跨平台一致性 + 无外部依赖（ICU 过重），且行为与 SentencePiece/tiktoken 对齐 |
| `token_to_piece` 返回负值表示缓冲区不足 | 与 `snprintf` 风格一致，允许两遍调用精确分配缓冲区 |
