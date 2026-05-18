# Trace 步骤 10 —— token 数组怎么变成 llama_decode 能吃的"批"?

## 1. 当前情境

`prompt_tokens` 是一个填满了整数 id 的 `std::vector<llama_token>`,长度是 `n_prompt`。上下文和采样器都已就绪。

`simple.cpp` 接下来要把这个向量喂给 `llama_decode`。但 `llama_decode` 的参数类型不是 `std::vector`,而是一个名为 `llama_batch` 的结构体(`examples/simple/simple.cpp:149`):

```cpp
llama_batch batch = llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size());
```

一行代码,`batch` 就构造好了,紧接着就可以传给解码循环。

## 2. 问题

`llama_decode` 需要的信息远不止"哪些 token id"——它还需要知道:

- 每个 token 在序列里的**位置**(position),用于 RoPE 位置编码。
- 每个 token 属于哪条**序列**(seq_id),用于 KV 缓存的多序列管理和注意力掩码。
- 哪些 token 需要输出 logits,哪些不需要。
- 如果是 embedding 模式,输入可能不是 token id 而是浮点向量。

这些信息都需要打包进同一个对象传给 decode。问题是:对于 `simple.cpp` 这种只有一条序列的最简场景,调用方真的要手动填所有字段吗?

## 3. 朴素思路

定义一个结构体:

```cpp
struct batch {
    int n_tokens;
    int * token_ids;
    int * positions;
    int * seq_ids;
    // ...
};
```

调用方在每次推理前手动填所有字段。对于 prompt,位置是 `0, 1, 2, …, n-1`,序列 id 是 `0, 0, 0, …`——写起来很机械但并不难。

## 4. 为什么朴素思路会崩

手动填字段在简单场景没问题,但有几个结构性麻烦:

- **位置跟踪出错概率高**:解码阶段每次送入一个 token,调用方必须自己记录"当前 pos 是多少",并在每轮 decode 之后更新。一旦算错,RoPE 结果就错了,生成质量悄悄下降却没有报错。
- **多序列场景极其繁琐**:server 同时跑多个请求时,每个请求对应不同的 seq_id,位置互相独立——手动填意味着调用方要维护一张 seq_id 到 pos 的映射表。
- **字段语义不对称**:`pos` 和 `seq_id` 是"几乎总是能自动推断"的信息,而 `token` 是"调用方必须提供"的信息。把这两类字段放在同一个层级、要求调用方全部手填,是不必要的对称。
- **NULL 表示"让系统推断"是更安全的约定**:如果调用方留空某个字段,系统按规则补全,而不是拿到未初始化的垃圾值——这样在字段语义发生演化时调用方不需要改代码。

## 5. llama.cpp 的做法

`llama_batch` 结构体的字段设计成**可选填**:任何字段传 `NULL` 时,`llama_batch_allocr::init`(在 decode 入口处调用)会按规则自动补全(`src/llama-batch.cpp:73`-`130`)。

**结构体定义**(`include/llama.h:240`-`249`):

```cpp
typedef struct llama_batch {
    int32_t n_tokens;

    llama_token  *  token;     // token id 数组 (与 embd 二选一)
    float        *  embd;      // embedding 向量数组 (与 token 二选一)
    llama_pos    *  pos;       // 每个 token 的位置,NULL = 自动推断
    int32_t      *  n_seq_id;  // 每个 token 的 seq_id 数量
    llama_seq_id ** seq_id;    // 每个 token 的 seq_id 列表,NULL = 全为 0
    int8_t       *  logits;    // 0 = 不输出 logits,NULL = 只输出最后一个
} llama_batch;
```

各字段含义:

| 字段 | NULL 时的自动行为 | simple.cpp 的情形 |
|------|------------------|--------------------|
| `token` | — (必须与 embd 二选一) | 指向 `prompt_tokens.data()` |
| `embd` | — | `nullptr`(我们用 token 模式) |
| `pos` | 从 KV 缓存末尾 +1 开始连续编号 | `nullptr`,由 allocr 补全 |
| `n_seq_id` | 全部设为 1 | `nullptr` |
| `seq_id` | 全部设为 `[0]` | `nullptr` |
| `logits` | 只标记最后一个 token 为输出 | `nullptr` |

**`llama_batch_get_one` 的实现**(`src/llama-batch.cpp:863`-`875`):

```cpp
struct llama_batch llama_batch_get_one(llama_token * tokens, int32_t n_tokens) {
    return {
        /*n_tokens =*/ n_tokens,
        /*tokens   =*/ tokens,
        /*embd     =*/ nullptr,
        /*pos      =*/ nullptr,   // 交给 decode 入口补全
        /*n_seq_id =*/ nullptr,
        /*seq_id   =*/ nullptr,
        /*logits   =*/ nullptr,
    };
}
```

它做的事极简:把 `token` 和 `n_tokens` 填进去,其余全设 `nullptr`。注意它**不拷贝**数组内容——`batch.token` 直接指向调用方传入的 `prompt_tokens.data()`。这意味着 `prompt_tokens` 必须在 `llama_decode` 执行期间保持有效。

**`nullptr` 字段在哪里被补全**:进入 `llama_decode` 后,`llama_batch_allocr::init`(`src/llama-batch.cpp:25`-`389`)负责校验并补全缺失字段:

<svg viewBox="0 0 760 360" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="llama_batch_allocr init: auto-filling nullptr fields">
  <defs>
    <marker id="t10ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="360" fill="#f8fafc" rx="6"/>
  <rect x="240" y="16" width="280" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">llama_batch_allocr::init</text>
  <text x="380" y="46" text-anchor="middle" font-size="10" fill="#64748b">batch, vocab, memory, ...</text>
  <line x1="380" y1="52" x2="380" y2="76" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t10ar1)"/>
  <rect x="30" y="76" width="160" height="58" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="110" y="96" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">n_seq_id == nullptr</text>
  <text x="110" y="112" text-anchor="middle" font-size="10" fill="#64748b">n_seq_id[i] = 1</text>
  <text x="110" y="126" text-anchor="middle" font-size="10" fill="#94a3b8">每个 token 各属 1 序列</text>
  <rect x="210" y="76" width="160" height="58" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="290" y="96" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">seq_id == nullptr</text>
  <text x="290" y="112" text-anchor="middle" font-size="10" fill="#64748b">seq_id[i] = [0]</text>
  <text x="290" y="126" text-anchor="middle" font-size="10" fill="#94a3b8">全部归属序列 0</text>
  <rect x="390" y="76" width="180" height="58" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="480" y="96" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">pos == nullptr</text>
  <text x="480" y="110" text-anchor="middle" font-size="10" fill="#64748b">p0 = memory→seq_pos_max(0)+1</text>
  <text x="480" y="124" text-anchor="middle" font-size="10" fill="#64748b">pos[i] = p0 + i</text>
  <rect x="590" y="76" width="150" height="58" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="665" y="96" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">logits == nullptr</text>
  <text x="665" y="112" text-anchor="middle" font-size="10" fill="#64748b">output[n-1] = true</text>
  <text x="665" y="126" text-anchor="middle" font-size="10" fill="#64748b">output[0..n-2] = false</text>
  <line x1="110" y1="76" x2="110" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="110" y1="60" x2="380" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="290" y1="76" x2="290" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="480" y1="76" x2="480" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="665" y1="76" x2="665" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="60" x2="665" y2="60" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="380" y1="134" x2="380" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t10ar1)"/>
  <rect x="180" y="162" width="400" height="60" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="182" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">batch 完整(所有字段有效)</text>
  <text x="380" y="198" text-anchor="middle" font-size="10" fill="#64748b">pos, seq_id, logits 均已填充</text>
  <text x="380" y="212" text-anchor="middle" font-size="10" fill="#64748b">KV 缓存可安全读写</text>
  <rect x="30" y="250" width="680" height="92" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="270" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">首次 prefill 的等效结果 (2 token: BOS + "你好")</text>
  <text x="100" y="294" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">n_tokens</text>
  <text x="100" y="310" text-anchor="middle" font-size="11" fill="#64748b">2</text>
  <text x="220" y="294" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">pos</text>
  <text x="220" y="310" text-anchor="middle" font-size="11" fill="#64748b">[0, 1]</text>
  <text x="340" y="294" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">seq_id</text>
  <text x="340" y="310" text-anchor="middle" font-size="11" fill="#64748b">[[0],[0]]</text>
  <text x="480" y="294" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">n_seq_id</text>
  <text x="480" y="310" text-anchor="middle" font-size="11" fill="#64748b">[1, 1]</text>
  <text x="620" y="294" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">logits</text>
  <text x="620" y="310" text-anchor="middle" font-size="11" fill="#64748b">[0, 1]</text>
  <text x="380" y="332" text-anchor="middle" font-size="10" fill="#94a3b8">只有最后一个 token 产出 logits;首次 prefill p0=0</text>
</svg>
<span class="figure-caption">图 T10.1 ｜ llama_batch_allocr::init 对 nullptr 字段的自动补全逻辑</span>

<details>
<summary>ASCII 原版</summary>

```
llama_batch_allocr::init(batch, vocab, memory, ...)
    |
    +--> 如果 batch.n_seq_id == nullptr:
    |       为每个 token 填 n_seq_id[i] = 1
    |
    +--> 如果 batch.seq_id == nullptr:
    |       为每个 token 填 seq_id[i] = [0]
    |
    +--> 如果 batch.pos == nullptr:
    |       查询 KV 缓存里 seq 0 的末尾位置 p0 = memory->seq_pos_max(0) + 1
    |       (首次调用 memory 为空时 p0 = 0)
    |       为每个 token 填 pos[i] = p0 + i
    |
    +--> 如果 batch.logits == nullptr:
    |       output[n_tokens - 1] = true (只输出最后一个 token 的 logits)
    |       output[0..n-2] = false
```

</details>

对于 `"你好"` 这个 prompt(假设 2 个 token),补全后的等效结果:

```text
batch.n_tokens   = 2
batch.token      = [151644, 108386]   (BOS + "你好" 的 id)
batch.pos        = [0, 1]             (首次 prefill 从位置 0 开始)
batch.n_seq_id   = [1, 1]
batch.seq_id     = [[0], [0]]
batch.logits     = [0, 1]             (只有最后一个 token 产出 logits)
```

**`logits` 字段为什么只标记最后一个**:prefill 阶段我们只需要最后一个 token 的 logits 来采样下一个词。输出 n_prompt 个位置的 logits 会额外消耗显存并增加 CPU 拷贝量,对生成没有好处。

## 6. 代码位置

按阅读顺序:

- 调用点:`examples/simple/simple.cpp:149` —— `llama_batch_get_one(prompt_tokens.data(), prompt_tokens.size())`
- 结构体定义与字段注释:`include/llama.h:225`-`249` —— `llama_batch` 及每个字段的 NULL 语义说明
- `llama_batch_get_one` 声明:`include/llama.h:905`-`913` —— 附有 NOTE 说明这是简化过渡 API
- `llama_batch_get_one` 实现:`src/llama-batch.cpp:863`-`875` —— 7 行实现
- `llama_batch_init` 实现(对比参考):`src/llama-batch.cpp:877`-`905` —— 为字段动态分配内存的完整版
- NULL 字段补全逻辑:`src/llama-batch.cpp:73`-`130` —— `llama_batch_allocr::init` 的补全部分
- pos 自动推断:`src/llama-batch.cpp:90`-`118` —— 从 `memory->seq_pos_max` 推算起始位置

## 7. 分支与延伸

- `llama_batch` 与 `llama_ubatch` 的关系、batch 在 decode 入口被拆成多个 ubatch 的分割逻辑 → [第 7 章 上下文与批处理](07-context-and-batching.md)
- KV 缓存如何管理多条序列的 cell 槽位、`seq_pos_max` 从哪里读 → [第 8 章 KV 缓存](08-kv-cache.md)
- encoder-decoder 模型(T5/Whisper 等)在步骤 10 之后还有一个 `llama_encode` 分支(`examples/simple/simple.cpp:151`-`163`),本导览跳过它 → [第 3 章 模型架构与超参数](03-model-arch-and-hparams.md)
- 步骤 11 中 `llama_decode` 接手这个 batch,做校验、拆 ubatch、分配 KV 槽位 → [步骤 11:进入 llama_decode](tour-11-decode-entry.md)

## 8. 走完这一步你脑子里应该多了什么

1. **`llama_batch` 是一个轻量包装,不拷贝数据**:`batch.token` 指向调用方的原始数组,`llama_batch_get_one` 返回的结构体本身只有 7 个字段,没有任何堆分配。
2. **NULL 字段是"委托系统推断"的信号**:pos、seq_id、logits 传 NULL 时,`llama_batch_allocr::init` 按规则自动补全——这是让单序列简单用法不必手填每个字段的关键设计。
3. **pos 是从 KV 缓存末尾续接的**:第一次 prefill 时 KV 缓存为空,pos 从 0 开始;之后每轮 decode 送入新 token 时,pos 自动接在上一轮末尾之后,调用方不需要维护计数器。
4. **logits 字段默认只输出最后一个 token**:`nullptr` 等价于"只有 `output[n_tokens-1] = true`",这避免了不必要的 logits 拷贝。如果需要全部 token 的 logits(比如做 perplexity 评估),应显式填满 `logits` 数组。
5. 此刻 `batch.n_tokens = n_prompt`,batch 已装载完毕,下一步把它送入 `llama_decode` 启动真正的前向计算。

下一步:[步骤 11 —— 进入 llama_decode](tour-11-decode-entry.md)。
