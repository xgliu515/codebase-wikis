# Trace 步骤 17 —— 循环什么时候停?停了之后怎么收尾?

## 1. 当前情境

步骤 16 结束后,解码循环已经转了若干轮。每轮都在做同样的事情:喂入 1 个 token、跑计算图、采样出下一个 token、打印文字片段、把新 token 包成下一轮 batch。对于 `-n 4` 的命令,大约经历了 4 轮 decode,屏幕上已经打印了 4 个 token 对应的文字。

`simple.cpp` 的解码循环里,在采样到 `new_token_id` 之后,第一件事是检查它是否是生成结束信号(`examples/simple/simple.cpp:185`-`187`):

```cpp
if (llama_vocab_is_eog(vocab, new_token_id)) {
    break;
}
```

循环本身还受 `n_predict` 上限控制(`examples/simple/simple.cpp:171`)。两个退出条件各自独立。循环退出后,`simple.cpp` 打印性能计数、释放资源、返回 0。

## 2. 问题

两个具体问题:

1. **EOG 判断**:不同模型用不同的特殊 token 表示"生成结束"——有的叫 `<|eos|>`,有的叫 `<|im_end|>`,有的叫 `<|end_of_text|>`,还有 FIM 专用的 pad/rep/sep token。如何用一个统一的函数判断"这个 token 是结束信号"?

2. **资源释放顺序**:三个对象 `smpl`、`ctx`、`model` 之间有依赖关系——`ctx` 持有指向 `model` 内存的指针,`smpl` 内部有对 `ctx` 的引用。释放顺序错了会悬空指针或二次释放。

## 3. 朴素思路

EOG:从 GGUF 元数据里读 EOS token id,采样到这个 id 就停。

释放:随便什么顺序 free 三个指针就行,C++ 里反正都是 delete。

## 4. 为什么朴素思路会崩

**EOG 的坑**:

- 现代 chat 模型普遍使用**多个结束 token**。Llama 3 既有 `<|eot_id|>` 也有 `<|end_of_text|>`,两者功能略不同但都应该终止生成。DeepSeek 有 `<｜end▁of▁sentence｜>`。FIM 任务里 `<|fim_pad|>` 也是结束信号。单纯检查 EOS id 会漏掉这些情况,导致模型在 `<|im_end|>` 之后继续乱输出。
- `special_eos_id` 字段在某些模型配置里还可能错填——`is_eog` 有兜底逻辑,会检测 `special_eos_id` 不在 `special_eog_ids` 里时补入并打警告(`src/llama-vocab.cpp:2618`-`2619`)。

**释放顺序的坑**:

- 如果先 `llama_model_free(model)`,此时 `ctx` 还持有 `model` 的引用(`llama_context` 内部有 `const llama_model & model`);KV 缓存的 buffer 也通过 `model` 申请的 backend,被提前释放后 `ctx` 的析构会访问悬空引用,行为未定义。
- 如果先 `llama_free(ctx)` 而 `smpl` 的某些状态还在用 `ctx`(比如 mirostat 的 entropy 统计),会发生 use-after-free。事实上 `llama_sampler_free` 只释放采样器自身状态,不涉及 `ctx`,但顺序仍然应该是"从最外层到最内层"的依赖链。

## 5. llama.cpp 的做法

**EOG:special_eog_ids 集合**

`llama_vocab::impl` 维护一个 `std::set<llama_token> special_eog_ids`(`src/llama-vocab.cpp:1677`)。它在 vocab 初始化时(`init_tokenizer` 阶段)被填充:

1. FIM 专用 token(`special_fim_pad_id`、`special_fim_rep_id`、`special_fim_sep_id`)如果非空则先加入(`src/llama-vocab.cpp:2550`-`2560`)。
2. 遍历词表,按 token 文本名做白名单匹配——`<|eot_id|>`、`<|im_end|>`、`<|end|>`、`<end_of_turn>`、`<|endoftext|>` 等二十余种已知结束 token 文本全部插入(`src/llama-vocab.cpp:2562`-`2603`)。
3. 兜底:确保 `special_eos_id`、`special_eot_id`、`special_eom_id` 都在集合里(`src/llama-vocab.cpp:2618`-`2629`)。

查询时,`is_eog` 就是一次 `set::count` 查找(`src/llama-vocab.cpp:2851`-`2852`):

```cpp
bool llama_vocab::impl::is_eog(llama_token id) const {
    return id != LLAMA_TOKEN_NULL && special_eog_ids.count(id) > 0;
}
```

公共 API `llama_vocab_is_eog` 只是把调用转发进去(`src/llama-vocab.cpp:3903`-`3904`)。这个设计的好处是:不同模型、不同任务类型的结束 token 都在一个集合里统一管理,调用方不需要知道具体有哪些 EOG token。

**双重退出条件**

`simple.cpp` 的循环退出有两个独立通路:

<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two independent loop exit conditions: n_predict hard limit and EOG soft break">
  <defs>
    <marker id="t17ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="200" fill="#f8fafc" rx="6"/>
  <rect x="180" y="16" width="280" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="30" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">解码循环 (for n_pos ...)</text>
  <text x="320" y="46" text-anchor="middle" font-size="9" fill="#94a3b8">examples/simple/simple.cpp:171</text>
  <line x1="180" y1="34" x2="80" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar1)"/>
  <line x1="460" y1="34" x2="560" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t17ar1)"/>
  <rect x="20" y="80" width="240" height="64" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="140" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">硬截断 (n_predict 上限)</text>
  <text x="140" y="116" text-anchor="middle" font-size="10" fill="#64748b">n_pos + n_tokens &lt; n_prompt + n_predict</text>
  <text x="140" y="130" text-anchor="middle" font-size="9" fill="#94a3b8">用户设定最大生成长度</text>
  <text x="140" y="143" text-anchor="middle" font-size="9" fill="#94a3b8">条件不满足时循环自然结束</text>
  <rect x="380" y="80" width="240" height="64" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="500" y="100" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">软截断 (EOG 检测)</text>
  <text x="500" y="116" text-anchor="middle" font-size="10" fill="#64748b">llama_vocab_is_eog(vocab, token)</text>
  <text x="500" y="130" text-anchor="middle" font-size="9" fill="#94a3b8">模型主动输出结束 token</text>
  <text x="500" y="143" text-anchor="middle" font-size="9" fill="#94a3b8">set::count 查 special_eog_ids</text>
  <line x1="140" y1="144" x2="240" y2="172" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t17ar1)"/>
  <line x1="500" y1="144" x2="400" y2="172" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#t17ar1)"/>
  <rect x="200" y="164" width="240" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="181" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">循环退出 → 打印性能计数 → 释放资源</text>
</svg>
<span class="figure-caption">图 T17.1 ｜ 解码循环的两个独立退出条件：n_predict 硬截断与 EOG 软截断互相独立</span>

<details>
<summary>ASCII 原版</summary>

```
循环条件: n_pos + batch.n_tokens < n_prompt + n_predict
                                    ← n_predict 上限,硬截断
采样后:   llama_vocab_is_eog(vocab, new_token_id)
                                    ← 模型主动结束,软截断
```

</details>

两者同时有效:遇到 EOG 立即 `break`;即使模型从不输出 EOG,到 `n_predict` 个 token 后循环也会自然退出。

**性能计数打印**

循环结束后,`simple.cpp` 先打印自己计算的 token/s(`examples/simple/simple.cpp:210`-`211`),再调两个库函数:

```cpp
llama_perf_sampler_print(smpl);   // examples/simple/simple.cpp:214
llama_perf_context_print(ctx);    // examples/simple/simple.cpp:215
```

`llama_perf_sampler_print` 读取 `llama_sampler_chain` 里的 `t_sample_us` 和 `n_sample` 计数器,打印采样总耗时和轮数(`src/llama-sampler.cpp:3870`-`3873`)。

`llama_perf_context_print` 读取 `llama_context` 里的四个计数器:`t_p_eval_us`(prefill 总耗时)、`n_p_eval`(prefill token 数)、`t_eval_us`(decode 总耗时)、`n_eval`(decode 轮数)(`src/llama-context.cpp:3939`-`3950`),还有 `n_reused`(计算图复用次数)。输出格式形如:

```text
llama_perf_context_print:        load time =    234.56 ms
llama_perf_context_print: prompt eval time =     12.34 ms /     3 tokens (  4.11 ms per token, 243.4 tokens per second)
llama_perf_context_print:        eval time =     45.67 ms /     4 runs   ( 11.42 ms per token,  87.6 tokens per second)
llama_perf_context_print:       total time =    780.90 ms /     7 tokens
llama_perf_context_print:    graphs reused =          3
```

`prompt eval time` 就是 prefill 一次的代价;`eval time` 是 decode 阶段每轮平均代价。两者数量级不同:prefill 处理多个 token 但只算一次;decode 每轮只有 1 个 token 但要读完整个 KV 缓存。

**释放顺序:从浅到深**

```cpp
llama_sampler_free(smpl);   // examples/simple/simple.cpp:218
llama_free(ctx);            // examples/simple/simple.cpp:219
llama_model_free(model);    // examples/simple/simple.cpp:220
```

正确顺序是**从最外层对象到最内层**,原因如下:

- `smpl` 不持有 `ctx` 或 `model` 的所有权,释放最安全。`llama_sampler_free` 调用链里每个采样器的 `iface->free`(如果非空),然后 `delete smpl`(`src/llama-sampler.cpp:416`-`426`)。
- `ctx` 持有 KV 缓存、计算图缓冲、backend scheduler——这些资源通过 `model` 的 backend 设备分配,在 `ctx` 析构时需要 `model` 的 backend 信息才能正确释放。`llama_free(ctx)` 就是 `delete ctx`(`src/llama-context.cpp:3457`-`3459`),析构函数打印 compute buffer 大小的校验日志后由 `unique_ptr` / `shared_ptr` 成员按声明逆序自动析构(`src/llama-context.cpp:391`-`409`)。
- `model` 持有权重 tensor 的 mmap 区域和 GGUF 元数据。在 `ctx` 已经被释放、不再有任何访问后,`llama_model_free(model)` 最后执行 `delete model`(`src/llama-model.cpp:2149`-`2151`),unmap 权重文件,关闭 GGUF 文件描述符。

<svg viewBox="0 0 640 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Resource release order: smpl then ctx then model, each with its destructor chain">
  <defs>
    <marker id="t17ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="220" fill="#f8fafc" rx="6"/>
  <text x="320" y="28" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">释放顺序：从最外层到最内层</text>
  <rect x="30" y="44" width="160" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="110" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">① smpl</text>
  <text x="110" y="78" text-anchor="middle" font-size="10" fill="#64748b">llama_sampler_free</text>
  <text x="110" y="94" text-anchor="middle" font-size="9" fill="#94a3b8">delete chain + greedy</text>
  <line x1="190" y1="74" x2="230" y2="74" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t17ar2)"/>
  <rect x="230" y="44" width="180" height="60" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">② ctx</text>
  <text x="320" y="78" text-anchor="middle" font-size="10" fill="#64748b">llama_free</text>
  <text x="320" y="94" text-anchor="middle" font-size="9" fill="#94a3b8">~sched → ~memory(KV)</text>
  <line x1="410" y1="74" x2="450" y2="74" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#t17ar2)"/>
  <rect x="450" y="44" width="160" height="60" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="530" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">③ model</text>
  <text x="530" y="78" text-anchor="middle" font-size="10" fill="#64748b">llama_model_free</text>
  <text x="530" y="94" text-anchor="middle" font-size="9" fill="#94a3b8">unmap + ~gguf_context</text>
  <rect x="30" y="120" width="160" height="52" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="110" y="138" text-anchor="middle" font-size="9" fill="#64748b">iface→free 钩子</text>
  <text x="110" y="152" text-anchor="middle" font-size="9" fill="#64748b">delete smpl</text>
  <rect x="230" y="120" width="180" height="52" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="320" y="138" text-anchor="middle" font-size="9" fill="#64748b">~backends → ~buf_output</text>
  <text x="320" y="152" text-anchor="middle" font-size="9" fill="#64748b">需 model 的 backend 才能正确释放</text>
  <rect x="450" y="120" width="160" height="52" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="530" y="138" text-anchor="middle" font-size="9" fill="#64748b">权重 mmap 解除映射</text>
  <text x="530" y="152" text-anchor="middle" font-size="9" fill="#64748b">关闭 GGUF 文件描述符</text>
  <line x1="110" y1="104" x2="110" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="320" y1="104" x2="320" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="530" y1="104" x2="530" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="320" y="196" text-anchor="middle" font-size="10" fill="#94a3b8">ctx 持有 model 的 backend 资源 → 必须在 model 之前释放</text>
</svg>
<span class="figure-caption">图 T17.2 ｜ 资源释放链：smpl → ctx → model，依赖链的逆序释放</span>

<details>
<summary>ASCII 原版</summary>

```
释放链:
  smpl  ──── delete sampler_chain + delete greedy
  ctx   ──── ~llama_context: ~sched → ~memory(KV) → ~backends → ~buf_output
  model ──── ~llama_model: ~tensors(unmap) → ~gguf_context
```

</details>

## 6. 代码位置

按阅读顺序:

- `examples/simple/simple.cpp:171` —— 循环条件:`n_pos + batch.n_tokens < n_prompt + n_predict`
- `examples/simple/simple.cpp:185`-`187` —— `llama_vocab_is_eog(vocab, new_token_id)`;EOG 检测点
- `examples/simple/simple.cpp:206`-`215` —— 循环退出后打印换行、手动 token/s 统计、调 perf 打印
- `examples/simple/simple.cpp:218`-`220` —— 三行释放:`smpl → ctx → model`
- `src/llama-vocab.cpp:1677` —— `special_eog_ids` 成员声明
- `src/llama-vocab.cpp:2548`-`2629` —— `special_eog_ids` 的填充逻辑:FIM、白名单、兜底
- `src/llama-vocab.cpp:2851`-`2852` —— `is_eog`:set::count 查找
- `src/llama-vocab.cpp:3903`-`3904` —— `llama_vocab_is_eog` 公共 API
- `src/llama-sampler.cpp:3870`-`3873` —— `llama_perf_sampler_print`:打印采样计时
- `src/llama-sampler.cpp:416`-`426` —— `llama_sampler_free`:调 free 钩子后 delete
- `src/llama-context.cpp:3939`-`3950` —— `llama_perf_context_print`:打印 prefill/decode 计时
- `src/llama-context.cpp:3457`-`3459` —— `llama_free`:delete ctx
- `src/llama-context.cpp:391`-`409` —— `llama_context::~llama_context`:析构检查
- `src/llama-model.cpp:2149`-`2151` —— `llama_model_free`:delete model

## 7. 分支与延伸

- `llama_context` 里的性能计数器什么时候累加、`n_p_eval` 与 `n_eval` 如何区分 prefill 和 decode → [第 7 章 上下文与批处理](07-context-and-batching.md)
- EOG 与 EOS 的区别:EOS 是词表里一个特定的 token id,EOG 是一个集合,可以包含多个 token;某些模型的 EOS 不在 EOG 集合里时会触发警告 → [第 10 章 采样与 token 生成](10-sampling.md)
- FIM(fill-in-the-middle)任务的 pad/rep/sep token 为何也是 EOG:FIM 填充完成后模型会输出这些 token 作为结束标志 → [第 10 章](10-sampling.md)
- `llama_perf_context_reset` / `llama_perf_sampler_reset`:如何在同一个 ctx 上跑多轮推理而不累积计数 → [第 7 章](07-context-and-batching.md)
- `ctx` 析构时为何要检查 `compute buffer size` 是否与预期一致(`backend_buf_exp_size[i]`):这是对步骤 07 里 `graph_reserve` dry-run 精度的校验,偏差意味着 graph reserve 的尺寸估计有误 → [步骤 07](tour-07-graph-reserve.md)
- `llama_model_free` 触发 mmap 解除映射;如果模型权重被 pin 进 RAM(`mlock`)此时也一并解锁 → [步骤 03](tour-03-tensor-mmap.md)

## 8. 走完这一步你脑子里应该多了什么

1. **EOG 是一个集合,不是单一 token**:`special_eog_ids` 在 vocab 初始化时按词表文本名白名单填充,涵盖二十余种模型的结束 token。`llama_vocab_is_eog` 是一次 O(log n) 的 set 查找,不依赖具体模型的 EOS id 字段。
2. **两个退出条件互相独立**:EOG 是"模型说结束了",`n_predict` 是"用户说够了"。正确的做法是两者都检查,不能只有其中一个。
3. **性能计数区分了 prefill 和 decode**:`llama_perf_context_print` 输出的 `prompt eval time` 和 `eval time` 分别对应这两个阶段,前者描述 prefill 吞吐(通常高),后者描述 decode 吞吐(通常低)。
4. **释放顺序必须是 smpl → ctx → model**:这是依赖链的逆序释放。`ctx` 持有 `model` 的 backend 资源,必须在 `model` 之前释放;`smpl` 独立于两者,但也应该在 `ctx` 之前释放以避免任何潜在的 use-after-free。
5. **到这里导览完整闭环**:从 `ggml_backend_load_all` 到 `llama_model_free`,17 步走完了一次完整的 llama.cpp 推理生命周期。每一步都有具体的设计问题和对应的答案,没有哪一层是多余的。

导览完结。继续深入请从 [第 1 章 系统架构总览](01-architecture-overview.md) 起步通读参考手册。
