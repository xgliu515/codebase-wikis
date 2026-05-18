# Trace 步骤 09 —— prompt 字符串怎么变成整数序列?

## 1. 当前情境

采样器链就绪;`smpl` 指向一条含 greedy 采样器的 `llama_sampler_chain`。`prompt` 此刻还是一个普通的 C++ `std::string`——假设用户传入的是 `"你好"`。

`simple.cpp` 在初始化上下文之前就先做了分词(`examples/simple/simple.cpp:99`-`107`),因为上下文大小 `n_ctx` 需要 `n_prompt` 这个数字来计算:

```cpp
// 第一次调用:传 NULL/0,让函数返回负的所需长度
const int n_prompt = -llama_tokenize(vocab, prompt.c_str(), prompt.size(),
                                     NULL, 0, true, true);

// 第二次调用:分配好数组后真正填入 token
std::vector<llama_token> prompt_tokens(n_prompt);
if (llama_tokenize(vocab, prompt.c_str(), prompt.size(),
                   prompt_tokens.data(), prompt_tokens.size(),
                   true, true) < 0) {
    // 错误处理
}
```

这两次调用同一个函数,签名相同,行为却不同。

## 2. 问题

模型看不懂字符串,它接受的输入是整数序列——每个整数是词表里某个"token"的 id。需要把 `"你好"` 这样的 UTF-8 文本切成若干个 id。

具体需求是:

- 在调用 `llama_tokenize` 之前,调用方不知道 `"你好"` 会被切成几个 token。
- 不知道个数,就无法预先分配 `llama_token` 数组。
- 而 `llama_tokenize` 的 C API 要求调用方传进一个 `llama_token * tokens` 和它的最大容量 `n_tokens_max`。

这是一个经典的"不知道长度就没法分配,不分配就没法运行"的先有鸡还是先有蛋问题。

## 3. 朴素思路

最直觉的解法:先保守分配一个上界。UTF-8 字符串的字节数一定不少于 token 数,所以传 `text_len` 大小的数组一定够放。代码变成:

```cpp
std::vector<llama_token> prompt_tokens(prompt.size()); // 按字节数上界
int n = llama_tokenize(vocab, ..., prompt_tokens.data(), prompt_tokens.size(), ...);
prompt_tokens.resize(n); // 缩小到实际大小
```

这个思路基本没问题——UTF-8 多字节字符的字节数总是 >= 它产生的 token 数,上界是安全的。加上 BOS token 最多多一个,也就 `text_len + 1`。

## 4. 为什么朴素思路会崩

朴素思路没有逻辑错误,但有一个实际的使用摩擦:

- **浪费内存**:`"你好"` UTF-8 编码是 6 字节,但实际可能只产生 1-2 个 token。按字节数分配会多出 3-5 倍的空间,在 prompt 很长时显得浪费,而且 `resize` 之前的数组里留着垃圾值。
- **API 约定不统一**:llama.cpp 的 C 公共 API 设计目标是让绑定层(Python、Go、Rust…)易于封装。"传 NULL/0 拿长度,再传实际指针"是 C 标准库的惯用约定(类似 `snprintf`、`wcstombs` 等),绑定层对这种两次调用模式有现成的处理方法,而"传上界数组再 shrink"则不是标准约定,绑定层需要额外处理。
- **BOS/特殊 token 的数量不可预测**:某些 tokenizer 配置会在 BOS 之后再插一个额外 token,上界 `text_len` 未必能覆盖所有情形,会引入微妙的 off-by-one 隐患。

因此 llama.cpp 选择了"**负值表示所需长度**"的约定:当 `n_tokens_max` 不够时返回 `-(实际长度)`,调用方对返回值取反即可得到精确所需长度,然后只分配那么多空间。

## 5. llama.cpp 的做法

**两次调用约定** 的核心在 `src/llama-vocab.cpp:3817`-`3819`:

```cpp
if (n_tokens_max < (int) res.size()) {
    return -((int) res.size());   // 返回负值 = 所需空间
}
```

第一次传 `NULL, 0`,函数发现 `0 < 实际 token 数`,返回负数。调用方取反就得到了精确的 token 数量,再分配数组,第二次调用才真正把 id 填进去。

**内部分词流程**(`src/llama-vocab.cpp:3079`-`3220`,`llama_vocab::impl::tokenize`):

<svg viewBox="0 0 640 520" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Internal tokenize pipeline: partition then dispatch to vocab-type tokenizer">
  <defs>
    <marker id="t9ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="520" fill="#f8fafc" rx="6"/>
  <rect x="220" y="16" width="200" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="29" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">raw_text</text>
  <text x="320" y="44" text-anchor="middle" font-size="11" fill="#64748b">"你好" (UTF-8 字符串)</text>
  <line x1="320" y1="52" x2="320" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="130" y="80" width="380" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="100" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">tokenizer_st_partition</text>
  <text x="320" y="117" text-anchor="middle" font-size="10" fill="#94a3b8">fragment_buffer, parse_special</text>
  <line x1="320" y1="132" x2="320" y2="160" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="60" y="160" width="240" height="52" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="180" y="180" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">RAW_TEXT 片段</text>
  <text x="180" y="198" text-anchor="middle" font-size="10" fill="#64748b">普通文字 (如"你好")</text>
  <rect x="340" y="160" width="240" height="52" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="460" y="180" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">TOKEN 片段</text>
  <text x="460" y="198" text-anchor="middle" font-size="10" fill="#64748b">特殊 token (如 &lt;|im_start|&gt;)</text>
  <line x1="180" y1="212" x2="180" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <line x1="460" y1="212" x2="460" y2="240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="60" y="240" width="520" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="260" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">switch(vocab_type)</text>
  <text x="320" y="277" text-anchor="middle" font-size="10" fill="#94a3b8">分发到对应 tokenizer 实现</text>
  <line x1="160" y1="292" x2="160" y2="320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <line x1="320" y1="292" x2="320" y2="320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <line x1="480" y1="292" x2="480" y2="320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="60" y="320" width="180" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="150" y="338" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">SPM tokenizer</text>
  <text x="150" y="354" text-anchor="middle" font-size="10" fill="#64748b">LLaMA / Qwen 等</text>
  <rect x="230" y="320" width="180" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="320" y="338" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">BPE tokenizer</text>
  <text x="320" y="354" text-anchor="middle" font-size="10" fill="#64748b">GPT-2 系</text>
  <rect x="400" y="320" width="180" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="490" y="338" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">WPM tokenizer</text>
  <text x="490" y="354" text-anchor="middle" font-size="10" fill="#64748b">BERT 系</text>
  <line x1="320" y1="364" x2="320" y2="392" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="130" y="392" width="380" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="412" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">add_special &amp;&amp; add_bos → push_front(special_bos_id)</text>
  <text x="320" y="430" text-anchor="middle" font-size="11" fill="#64748b">add_special &amp;&amp; add_eos → push_back(special_eos_id)</text>
  <line x1="320" y1="444" x2="320" y2="472" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t9ar1)"/>
  <rect x="200" y="472" width="240" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="487" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">output: token id 序列</text>
  <text x="320" y="502" text-anchor="middle" font-size="10" fill="#64748b">如 [151644, 108386] (BOS + "你好")</text>
</svg>
<span class="figure-caption">图 T9.1 ｜ llama_vocab::impl::tokenize 内部流程：分区 → 类型分发 → 插入特殊 token</span>

<details>
<summary>ASCII 原版</summary>

```
raw_text ("你好")
    |
    v
tokenizer_st_partition(fragment_buffer, parse_special)
    |
    +--> 把文本切成两类片段:
    |       - FRAGMENT_BUFFER_VARIANT_TYPE_RAW_TEXT   (普通文字)
    |       - FRAGMENT_BUFFER_VARIANT_TYPE_TOKEN      (特殊 token,如 <|im_start|>)
    |
    v
switch(vocab_type):
    SPM (LLaMA/Qwen 等) -> llm_tokenizer_spm_session::tokenize(text, output)
    BPE (GPT-2 系)      -> llm_tokenizer_bpe_session::tokenize(...)
    WPM (BERT 系)       -> llm_tokenizer_wpm_session::tokenize(...)
    ...
    |
    v
add_special && add_bos  -> output.push_front(special_bos_id)
add_special && add_eos  -> output.push_back (special_eos_id)
```

</details>

对于 Qwen2.5(BPE 类型),`"你好"` 经过 BPE 合并规则后通常只产生一个 token id(BPE 词表里直接有 `你好` 这个合并)。加上 `add_special=true` 触发的 BOS token,`prompt_tokens` 最终可能是 `[151644, 108386]`(仅为示例,实际 id 因模型而异)。

**`add_special` 与 `parse_special` 两个参数** 的含义:

- `add_special=true`:按模型配置自动在开头/结尾插入 BOS/EOS 等特殊 token。`simple.cpp` 两次调用都传 `true`。
- `parse_special=true`:允许输入文本里的 `<|im_start|>` 这类字面量被识别为特殊 token 而不是普通文字。`simple.cpp` 两次调用也都传 `true`。

如果两次调用时这两个参数不一致,第一次和第二次算出来的 token 数量就会不同,第二次填写时会越界——这是使用这个 API 最常见的坑。

**`add_bos` 的来源**:不是调用方决定的,而是词表元数据里记录的配置(`src/llama-vocab.cpp:1654`)。`llama_vocab_get_add_bos` 可以查询它(`include/llama.h` 通过 `src/llama-vocab.cpp:3940`)。`add_special=true` 只是"尊重模型配置",而不是无条件插入。

## 6. 代码位置

按阅读顺序:

- 调用点:`examples/simple/simple.cpp:99`-`107` —— 两次 `llama_tokenize` 的完整代码
- 公共 API 声明:`include/llama.h:1118`-`1131` —— `llama_tokenize` 签名与参数注释
- 公共 API 实现:`src/llama-vocab.cpp:4085`-`4094` —— 转发给 `vocab->tokenize`
- C++ 层实现(含负值逻辑):`src/llama-vocab.cpp:3803`-`3827` —— `llama_vocab::tokenize(text, text_len, tokens, n_tokens_max, ...)`
- 内部 impl 实现:`src/llama-vocab.cpp:3079`-`3082` —— `llama_vocab::impl::tokenize` 入口
- 特殊 token 分区:`src/llama-vocab.cpp:2916` —— `tokenizer_st_partition`
- `add_bos` 字段:`src/llama-vocab.cpp:1654` —— `struct llama_vocab::impl` 内的 `bool add_bos`
- `add_bos` 查询:`src/llama-vocab.cpp:3742`-`3743` —— `llama_vocab::get_add_bos()`

## 7. 分支与延伸

- SPM/BPE/WPM/UGM 各类 tokenizer 算法的原理、Qwen 和 LLaMA 分别用哪种、GGUF 里怎么存词表数据 → [第 6 章 分词与词表](06-tokenization.md)
- BOS/EOS/PAD/EOG 等特殊 token 的 id 从哪里来、`llama_vocab_bos` 等函数 → [第 6 章 §特殊 token](06-tokenization.md)
- `parse_special=true` 使得聊天模板里的控制标记(如 `<|im_start|>`)能被正确处理 → [第 11 章 common 与聊天模板](11-common-and-chat.md)
- 步骤 10 紧接着把本步骤产出的 `prompt_tokens` 包装成 `llama_batch` → [步骤 10:构造 llama_batch](tour-10-batch.md)

## 8. 走完这一步你脑子里应该多了什么

1. **两次调用约定**:`llama_tokenize` 传 `NULL/0` 时返回负的所需长度;取反分配空间后再调用一次才真正填入 token id。两次调用的参数必须完全一致,否则长度会对不上。
2. **`add_special` 不等于无条件加 BOS**:它的实际行为由词表里 `add_bos`/`add_eos` 字段决定,不同模型行为不同。
3. **`parse_special` 决定字面量特殊 token 的处理方式**:设为 `true` 时文本里的 `<|im_start|>` 会被当作一个特殊 token,设为 `false` 时则当作普通字符串逐字符分词。
4. **分词结果是整数,不是字符串**:`prompt_tokens` 是一个 `std::vector<llama_token>`(即 `int32_t` 的 vector),后续所有计算都只看这些数字。
5. 此刻上下文还没有被创建——但 `n_prompt` 这个数字已经用于 `ctx_params.n_ctx` 的计算(`examples/simple/simple.cpp:113`)。分词在上下文初始化**之前**完成,是因为上下文大小取决于 prompt 长度。

下一步:[步骤 10 —— 构造 llama_batch](tour-10-batch.md)。
