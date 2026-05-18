# Trace 步骤 06 —— "你好" 两个字，怎么变成模型能吃的 token？

## 1. 当前情境

`ds4_engine_open` 已成功返回，`engine` 指针有效，`engine->metal_ready = true`。
执行流回到 `ds4_cli.c:717` 的 `run_generation()`，刚刚声明了空的 `ds4_tokens prompt = {0}`，
即将调用 `build_prompt(engine, &cfg->gen, &prompt)`（`ds4_cli.c:719`）。

此刻 `cfg->gen` 里的相关字段是：

```text
cfg->gen.prompt   = "你好"
cfg->gen.system   = "You are a helpful assistant"
cfg->gen.think_mode = DS4_THINK_HIGH   (默认值)
```

而 `prompt` 是全零的空 `ds4_tokens`：`{.v = NULL, .len = 0, .cap = 0}`。

## 2. 问题

模型的输入不是字符串，而是整数 token id 序列。这一步要把：

- 一段自然语言文本（"你好"，中文，UTF-8 编码）
- 包装进 DeepSeek V4 的对话格式（BOS + 可选 system + user turn + assistant 前缀）
- 并在 assistant 前缀之后插入正确的 thinking 标记

转化为一个 `ds4_tokens`（整数数组），传给后续的 prefill 阶段。

具体有三件事必须正确：

1. **对话模板**：DeepSeek V4 有固定的 special token 边界（BOS、`<｜User｜>`、
   `<｜Assistant｜>`、`<think>`/`</think>`）。顺序和有无直接影响模型行为。
2. **thinking 前缀**：`think_mode = DS4_THINK_HIGH` 要在 assistant 标记后插入 `<think>`
   而不是 `</think>`；`DS4_THINK_NONE` 则插入 `</think>` 告诉模型跳过思考链。
3. **BPE 编码**："你好" 是中文，需要走 byte-level BPE，而不是直接字节查表。

## 3. 朴素思路

直接把字符串 `"你好"` 查 token 词表，找到对应 id，加上 BOS token，拼成序列。
Chat 格式的话，在开头加上 system prompt 的 token，中间加角色标记就行。

## 4. 为什么朴素思路会崩

- **词表里没有"你好"这个条目**。DeepSeek V4 用的是 GPT-2 风格的 byte-level BPE：
  "你好" 会被先拆成单个 Unicode 字符，再通过 BPE merge rules 合并成一个或多个 token id。
  直接查词表只能查到字节级别的单字符条目，"你好"两个字最终会是 1–3 个 token id，
  而不是 1 个。
- **Special token 不走 BPE**。`<｜begin▁of▁sentence｜>`、`<｜User｜>` 等是单独
  存储在词表里的特殊条目，必须直接按 id 插入，不能让 BPE 把它们拆碎。
- **thinking 前缀的逻辑**：`DS4_THINK_HIGH` 插入 `<think>`，`DS4_THINK_MAX` 不仅
  插入 `<think>`，还在 BOS 之后额外插入一段长达 500 多字节的英文推理指示前缀。
  这是模型专属的提示工程，不是通用逻辑，必须在模板层面显式处理。

## 5. DwarfStar 4 的做法

`build_prompt`（`ds4_cli.c:453`）判断输入是否是"已渲染的 chat 格式"
（即用户自己写了 `<｜User｜>` 等 special token 的原始字符串），若否，
就调用 `ds4_encode_chat_prompt`，走标准对话模板路径：

<svg viewBox="0 0 640 160" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Call graph from build_prompt down to encode_chat_prompt">
  <defs>
    <marker id="ar6-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="20" width="200" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="160" y="43" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">build_prompt</text>
  <text x="268" y="43" text-anchor="start" font-size="10" fill="#94a3b8">ds4_cli.c:453</text>
  <line x1="160" y1="56" x2="160" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-1)"/>
  <rect x="40" y="74" width="360" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="220" y="97" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">ds4_encode_chat_prompt</text>
  <text x="410" y="97" text-anchor="start" font-size="10" fill="#94a3b8">(engine, system, prompt, think_mode, out)  ds4.c:14930</text>
  <line x1="220" y1="110" x2="220" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-1)"/>
  <rect x="60" y="128" width="320" height="24" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="220" y="145" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">encode_chat_prompt</text>
  <text x="390" y="145" text-anchor="start" font-size="10" fill="#94a3b8">(vocab, system, prompt, think_mode, out)  ds4.c:14840</text>
</svg>
<span class="figure-caption">图 T6.1 ｜ 提示词渲染调用链：build_prompt → ds4_encode_chat_prompt → encode_chat_prompt</span>

<details>
<summary>ASCII 原版</summary>

```
build_prompt
  └── ds4_encode_chat_prompt(engine, system, prompt, think_mode, out)
        └── encode_chat_prompt(vocab, system, prompt, think_mode, out)
```

</details>

`encode_chat_prompt`（`ds4.c:14840`）的执行序列：

<svg viewBox="0 0 760 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="encode_chat_prompt execution sequence inserting tokens step by step">
  <defs>
    <marker id="ar6-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="14" width="36" height="36" rx="18" fill="#ea580c"/>
  <text x="38" y="37" text-anchor="middle" font-size="13" font-weight="700" fill="white">1</text>
  <rect x="68" y="14" width="360" height="36" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="248" y="37" text-anchor="middle" font-size="12" font-weight="600" fill="#ea580c">token_vec_push(out, vocab->bos_id)</text>
  <text x="440" y="37" text-anchor="start" font-size="11" fill="#64748b">→ &lt;｜begin▁of▁sentence｜&gt;</text>
  <line x1="38" y1="50" x2="38" y2="68" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="68" width="36" height="36" rx="18" fill="#94a3b8"/>
  <text x="38" y="91" text-anchor="middle" font-size="13" font-weight="700" fill="white">2</text>
  <rect x="68" y="68" width="360" height="36" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="248" y="83" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">（think_mode == DS4_THINK_MAX 时）</text>
  <text x="248" y="98" text-anchor="middle" font-size="11" fill="#64748b">bpe_tokenize_text(vocab, REASONING_EFFORT_MAX_PREFIX, out)</text>
  <text x="440" y="91" text-anchor="start" font-size="11" fill="#94a3b8">→ ~500 字节英文推理指示</text>
  <line x1="38" y1="104" x2="38" y2="122" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="122" width="36" height="36" rx="18" fill="#94a3b8"/>
  <text x="38" y="145" text-anchor="middle" font-size="13" font-weight="700" fill="white">3</text>
  <rect x="68" y="122" width="360" height="36" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="248" y="137" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">（system 非空时）</text>
  <text x="248" y="152" text-anchor="middle" font-size="11" fill="#64748b">bpe_tokenize_text(vocab, "You are a helpful assistant", out)</text>
  <line x1="38" y1="158" x2="38" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="176" width="36" height="36" rx="18" fill="#0d9488"/>
  <text x="38" y="199" text-anchor="middle" font-size="13" font-weight="700" fill="white">4</text>
  <rect x="68" y="176" width="360" height="36" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="248" y="199" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">token_vec_push(out, vocab->user_id)</text>
  <text x="440" y="199" text-anchor="start" font-size="11" fill="#64748b">→ &lt;｜User｜&gt;</text>
  <line x1="38" y1="212" x2="38" y2="230" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="230" width="36" height="36" rx="18" fill="#0d9488"/>
  <text x="38" y="253" text-anchor="middle" font-size="13" font-weight="700" fill="white">5</text>
  <rect x="68" y="230" width="360" height="36" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="248" y="253" text-anchor="middle" font-size="12" font-weight="600" fill="#0d9488">bpe_tokenize_text(vocab, "你好", out)</text>
  <text x="440" y="253" text-anchor="start" font-size="11" fill="#64748b">→ BPE 编码，1–3 个 token id</text>
  <line x1="38" y1="266" x2="38" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="284" width="36" height="36" rx="18" fill="#7c3aed"/>
  <text x="38" y="307" text-anchor="middle" font-size="13" font-weight="700" fill="white">6</text>
  <rect x="68" y="284" width="360" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="248" y="307" text-anchor="middle" font-size="12" font-weight="600" fill="#7c3aed">token_vec_push(out, vocab->assistant_id)</text>
  <text x="440" y="307" text-anchor="start" font-size="11" fill="#64748b">→ &lt;｜Assistant｜&gt;</text>
  <line x1="38" y1="320" x2="38" y2="338" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar6-2)"/>
  <rect x="20" y="338" width="36" height="50" rx="18" fill="#7c3aed"/>
  <text x="38" y="368" text-anchor="middle" font-size="13" font-weight="700" fill="white">7</text>
  <rect x="68" y="338" width="360" height="50" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="248" y="356" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">THINK_HIGH / MAX → push think_start_id</text>
  <text x="248" y="374" text-anchor="middle" font-size="11" fill="#64748b">THINK_NONE → push think_end_id</text>
  <text x="440" y="356" text-anchor="start" font-size="11" fill="#64748b">→ &lt;think&gt;</text>
  <text x="440" y="374" text-anchor="start" font-size="11" fill="#94a3b8">→ &lt;/think&gt;</text>
</svg>
<span class="figure-caption">图 T6.2 ｜ encode_chat_prompt 七步执行序列，按顺序将 special token 与 BPE 结果插入输出数组</span>

<details>
<summary>ASCII 原版</summary>

```
1. token_vec_push(out, vocab->bos_id)
   -> <｜begin▁of▁sentence｜>

2. (think_mode == DS4_THINK_MAX 时)
   bpe_tokenize_text(vocab, DS4_REASONING_EFFORT_MAX_PREFIX, out)
   -> 把 ~500 字节的英文推理指示分词后插入

3. (system 非空时)
   bpe_tokenize_text(vocab, "You are a helpful assistant", out)

4. token_vec_push(out, vocab->user_id)
   -> <｜User｜>

5. bpe_tokenize_text(vocab, "你好", out)
   -> BPE 编码，得到 1-3 个 token id

6. token_vec_push(out, vocab->assistant_id)
   -> <｜Assistant｜>

7. (DS4_THINK_HIGH / DS4_THINK_MAX)
   token_vec_push(out, vocab->think_start_id)  -> <think>
   (DS4_THINK_NONE)
   token_vec_push(out, vocab->think_end_id)    -> </think>
```

</details>

对这条 trace（`think_mode = DS4_THINK_HIGH`），最终 token 序列结构是：

```text
[ BOS | "You are a helpful assistant" BPE tokens | <｜User｜> | "你好" BPE tokens | <｜Assistant｜> | <think> ]
```

BPE 编码本身（`bpe_tokenize_text`，`ds4.c:14708`）分两层：

**第一层——预分词（pre-tokenization）**。`bpe_tokenize_text` 先用 JoyAI 规则把
输入文本切成"piece"：CJK 字符每个单独成 piece，西文单词连续成一 piece，标点另处理。
"你好" 的两个汉字各自成一个 piece：`["你", "好"]`。

**第二层——BPE 合并**。`bpe_emit_piece`（`ds4.c:14532`）处理单个 piece：
先通过 `byte_encode`（`ds4.c:14482`）把原始字节映射到 GPT-2 可打印 Unicode 代理字符
（每个字节变为一个 UTF-8 字符，以保持 BPE 操作的字节粒度），再初始化 symbol 数组，
然后不断查 `bpe_rank`（`ds4.c:14515`）找最低 rank（最高优先级）的相邻 symbol 对，
将其合并，直到没有可合并的对为止，最后查词表得到 token id。

"你好" 的两个汉字经过这套流程后，通常各自对应 1 个 token id，
最终整个序列约 15–20 个 token（取决于 system prompt 的具体分词结果）。

## 6. 代码位置

按阅读顺序：

- `ds4_cli.c:453` —— `build_prompt()`，决定走"已渲染"还是"标准模板"路径。
- `ds4_cli.c:719` —— `run_generation()` 里调用 `build_prompt` 的位置。
- `ds4.h:136–141` —— `ds4_encode_chat_prompt` 公开声明。
- `ds4.c:14837` —— `encode_chat_prompt()` 实现，带注释说明各 token 的插入顺序。
- `ds4.c:14930` —— `ds4_encode_chat_prompt()` 公开包装，转发给内部 `encode_chat_prompt`。
- `ds4.c:63–66` —— `DS4_REASONING_EFFORT_MAX_PREFIX` 字符串常量（think_max 才插）。
- `ds4.c:14708` —— `bpe_tokenize_text()`，JoyAI 预分词规则，CJK 字符的分段逻辑在第 14722 行。
- `ds4.c:14532` —— `bpe_emit_piece()`，对单个 piece 做 byte-encode + BPE 合并循环。
- `ds4.c:14480` —— `byte_encode()`，原始字节到 GPT-2 代理 Unicode 的映射。
- `ds4.c:14515` —— `bpe_rank()`，拼接两个 symbol 查 merge_rank 哈希表。

## 7. 分支与延伸

- 词表结构（`ds4_vocab`）、merge ranks 哈希表的加载方式，以及 special token id
  是如何从 GGUF 元数据里读出来的 →
  [第 5 章 分词器与对话模板](05-tokenizer-chat.md)
- `DS4_THINK_MAX` 路径插入的长推理前缀与 `DS4_THINK_MAX_MIN_CONTEXT=393216` 的
  关系（上下文窗口不够大时会被降级）→
  [第 5 章 §thinking 模式](05-tokenizer-chat.md)
- 对话模板里各 special token 对应的 chat format，与 DeepSeek V4 模型期望的格式
  如何保持一致 →
  [第 2 章 模型结构与嵌入层](02-model-architecture.md)
- HTTP 服务器里的多轮对话如何把历史消息追加到 token 序列（`ds4_chat_append_message`），
  以及 rendered chat 格式的用途 →
  [第 5 章 §rendered chat](05-tokenizer-chat.md)

## 8. 走完这一步你脑子里应该多了什么

1. "你好" 不会被直接查词表——它先被预分词成按 CJK 切割的 piece，再在 piece 粒度上
   走 byte-level BPE，最终输出 1–2 个 token id，不是 2 个字节对应 2 个 id。
2. Special token（BOS、`<｜User｜>` 等）**绕过 BPE**，直接按词表 id 插入序列；
   用户文本则必须通过 BPE，即使文本里包含看起来像 special token 的字符串。
3. `DS4_THINK_HIGH` 与 `DS4_THINK_NONE` 只差最后一个 token 的差别：前者在
   `<｜Assistant｜>` 后面跟 `<think>`，后者跟 `</think>`——模型读到不同的
   后缀就选择不同的推理路径。
4. 对话模板的拼装顺序是固定的，由 `encode_chat_prompt` 硬编码，不是运行时配置——
   这是 DeepSeek V4 专用实现，不是通用模板引擎。
