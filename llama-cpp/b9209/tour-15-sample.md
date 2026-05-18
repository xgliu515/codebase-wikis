# Trace 步骤 15 —— 有了 logits,怎么决定下一个 token 是哪一个?

## 1. 当前情境

步骤 14 结束后,`ctx->logits.data` 里有一段长度为 `n_vocab`(Qwen2.5-0.5B 约 151936)的 float 数组,存放的是上一个 token 位置产生的原始 logits——每个元素对应词表里一个 token 的"打分",尚未经过 softmax。

`simple.cpp` 解码循环里就执行这一行(`examples/simple/simple.cpp:182`):

```cpp
new_token_id = llama_sampler_sample(smpl, ctx, -1);
```

`smpl` 是步骤 08 建好的采样器链,链里只有一个 greedy 采样器。`-1` 代表取最后一个输出位置的 logits。执行完,`new_token_id` 就是一个 `llama_token` 整数,代表下一步要生成的 token。

## 2. 问题

从 logits 数组里选出"下一个 token"需要回答两个具体问题:

1. **如何把 float 数组变成可操作的候选列表?** 采样器可能要对候选做排序、截断、重新归一化——它需要一个"(token_id, logit, prob)"三元组列表,而不是裸 float 数组。

2. **greedy 怎么从这个列表里选?** greedy 的语义是"概率最大的那个",等价于 logit 最大的那个(softmax 是单调的,不改变 argmax)。但具体实现是线性扫描还是排序,效率差别很大。

## 3. 朴素思路

直接对 logits 做 softmax,得到概率分布,然后取概率最大的那个 token。代码很直观:

```cpp
// 伪代码
float max_prob = -INF;
int   best_id  = 0;
for (int i = 0; i < n_vocab; i++) {
    float p = softmax(logits[i]);
    if (p > max_prob) { max_prob = p; best_id = i; }
}
return best_id;
```

## 4. 为什么朴素思路会崩

- **softmax 对 greedy 完全没用**:softmax 是单调变换,argmax 在变换前后不变。`argmax(logits) == argmax(softmax(logits))`。为 greedy 做 softmax 是纯粹的算力浪费——词表 15 万个 token,做一次 softmax 要 15 万次 exp,然后还要归一化,完全多余。
- **采样器链无法统一接口**:现实中用户不只用 greedy,还会叠加 temperature、top-k、top-p、min-p、repetition-penalty……这些操作都要能对同一个候选列表串行施加。如果每个采样器各自从 `float *` 读 logits,接口不统一,也没法传递"已排序""已截断"等状态。
- **accept 阶段需要额外信息**:采样链里部分采样器(如 penalty、mirostat)在 `accept` 时需要知道刚才选了哪个 token,以便更新内部状态。如果只返回一个整数,这个信息就丢失了。

## 5. llama.cpp 的做法

`llama_sampler_sample` 把整个过程分成三个阶段(`src/llama-sampler.cpp:806`-`873`):

**阶段一:构建 `llama_token_data_array`**

```cpp
// 从 ctx 里取 logits 指针
const auto * logits = llama_get_logits_ith(ctx, idx);
cur.resize(n_vocab);
for (llama_token token_id = 0; token_id < n_vocab; token_id++) {
    cur[token_id] = llama_token_data{token_id, logits[token_id], 0.0f};
}
```

`llama_token_data` 是一个三元组 `{id, logit, p}`,`p` 初始为 0,等哪个采样器需要概率时再填。`llama_token_data_array` 持有这个 vector 的指针和大小,以及 `selected`(最终选中的下标)和 `sorted`(是否已排序)两个标志位(`src/llama-sampler.cpp:857`-`862`):

```cpp
llama_token_data_array cur_p = {
    /* .data     = */ cur.data(),
    /* .size     = */ cur.size(),
    /* .selected = */ -1,
    /* .sorted   = */ false,
};
```

**阶段二:采样器链 apply**

```cpp
llama_sampler_apply(smpl, &cur_p);
```

`llama_sampler_chain_apply` 顺序遍历链里的每个采样器(`src/llama-sampler.cpp:642`-`661`),逐一调用 `apply`。对于 `simple.cpp` 的 greedy 链,只有一个采样器,其 `apply` 实现极其简洁(`src/llama-sampler.cpp:963`-`969`):

```cpp
static void llama_sampler_greedy_apply(struct llama_sampler *, llama_token_data_array * cur_p) {
    cur_p->selected = 0;
    for (size_t i = 1; i < cur_p->size; ++i) {
        if (cur_p->data[i].logit > cur_p->data[cur_p->selected].logit) {
            cur_p->selected = i;
        }
    }
}
```

这就是 greedy 的本质:**一次线性扫描,找 logit 最大的下标,写入 `cur_p->selected`**。不做 softmax,不做排序,O(n_vocab) 时间,O(1) 额外空间。为什么 logit 最大等于概率最大?因为 softmax 里每个 `exp(logit_i) / sum` 关于 `logit_i` 单调递增,argmax 不变。

整体流程:

<svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Greedy sampling three-phase flow: build token data array, apply argmax, accept">
  <defs>
    <marker id="t15ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="400" fill="#f8fafc" rx="6"/>
  <rect x="100" y="16" width="440" height="52" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">logits[0..n_vocab-1]  (float*)</text>
  <text x="320" y="50" text-anchor="middle" font-size="10" fill="#64748b">ctx→logits.data + j×n_vocab  (原始 logit, 未 softmax)</text>
  <text x="320" y="64" text-anchor="middle" font-size="9" fill="#94a3b8">n_vocab ≈ 151936</text>
  <line x1="320" y1="68" x2="320" y2="96" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar1)"/>
  <rect x="180" y="84" width="280" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="320" y="100" text-anchor="middle" font-size="10" fill="#64748b">构造 cur[]: {id, logit=logits[id], p=0}</text>
  <line x1="320" y1="108" x2="320" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar1)"/>
  <rect x="100" y="136" width="440" height="52" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama_token_data_array  cur_p</text>
  <text x="320" y="170" text-anchor="middle" font-size="10" fill="#64748b">{data, size=n_vocab, selected=-1, sorted=false}</text>
  <text x="320" y="182" text-anchor="middle" font-size="9" fill="#94a3b8">src/llama-sampler.cpp:857</text>
  <line x1="320" y1="188" x2="320" y2="216" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar1)"/>
  <rect x="100" y="204" width="440" height="52" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="222" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">greedy_apply:  argmax(logits)</text>
  <text x="320" y="238" text-anchor="middle" font-size="10" fill="#64748b">线性扫描 O(n_vocab),找最大 logit 的下标 k</text>
  <text x="320" y="250" text-anchor="middle" font-size="9" fill="#94a3b8">cur_p.selected = k   (softmax 单调, argmax 不变)</text>
  <line x1="320" y1="256" x2="320" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar1)"/>
  <rect x="180" y="272" width="280" height="24" rx="4" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="320" y="288" text-anchor="middle" font-size="10" fill="#64748b">token = cur_p.data[k].id</text>
  <line x1="320" y1="296" x2="320" y2="324" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t15ar1)"/>
  <rect x="160" y="324" width="320" height="52" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="342" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">new_token_id  (llama_token)</text>
  <text x="320" y="358" text-anchor="middle" font-size="10" fill="#64748b">下一步 accept(smpl, token) 通知采样器链</text>
  <text x="320" y="370" text-anchor="middle" font-size="9" fill="#94a3b8">greedy: accept 为空; penalty/mirostat 等会更新状态</text>
</svg>
<span class="figure-caption">图 T15.1 ｜ greedy 采样三阶段：构造候选数组 → argmax 线性扫描 → accept 通知采样器链</span>

<details>
<summary>ASCII 原版</summary>

```
logits[0..n_vocab-1]  (float*)
        |
        | 构造 cur[]: {id=0, logit=logits[0], p=0}, ...
        v
llama_token_data_array cur_p {data, size, selected=-1, sorted=false}
        |
        | greedy_apply: 线性扫 logit, cur_p.selected = argmax
        v
cur_p.selected = k   (最大 logit 的下标)
        |
        | token = cur_p.data[k].id
        v
new_token_id  (llama_token 整数)
```

</details>

**阶段三:采样器链 accept**

```cpp
llama_sampler_accept(smpl, token);
```

`accept` 通知链里所有采样器"我们刚选了这个 token"(`src/llama-sampler.cpp:368`-`376`)。greedy 的 `accept` 为空(`nullptr`),但 penalty、mirostat 等采样器会在这里更新频率统计、滑动窗口等状态。

## 6. 代码位置

按阅读顺序:

- `examples/simple/simple.cpp:182` —— `llama_sampler_sample(smpl, ctx, -1)` 调用点
- `src/llama-sampler.cpp:806`-`873` —— `llama_sampler_sample` 完整实现:取 logits、构建数组、apply、accept
- `src/llama-sampler.cpp:848`-`854` —— 从 `llama_get_logits_ith` 取原始 logits 并填入 `cur`
- `src/llama-sampler.cpp:857`-`862` —— 构造 `llama_token_data_array cur_p`
- `src/llama-sampler.cpp:864` —— `llama_sampler_apply(smpl, &cur_p)` 调用链
- `src/llama-sampler.cpp:642`-`661` —— `llama_sampler_chain_apply`:逐个 apply
- `src/llama-sampler.cpp:963`-`969` —— `llama_sampler_greedy_apply`:argmax 实现
- `src/llama-sampler.cpp:368`-`376` —— `llama_sampler_accept`:通知链里各采样器
- `src/llama-sampler.cpp:870` —— `llama_sampler_accept(smpl, token)` 调用点
- `include/llama.h` —— `llama_token_data` 和 `llama_token_data_array` 结构体定义

## 7. 分支与延伸

- 完整的采样器类型(temperature、top-k、top-p、min-p、mirostat、XTC……)及其 apply 逻辑 → [第 10 章 采样与 token 生成](10-sampling.md)
- `llama_sampler_i` 接口结构体:name / apply / accept / reset / clone / free / backend_init / backend_apply 各钩子的含义 → [第 10 章](10-sampling.md)
- backend sampler(GPU 端 greedy):当链里启用了 `backend_apply`,greedy 会在计算图里插入 `ggml_argmax` 算子,在 GPU 上完成采样,完全跳过 CPU 端的 `cur` 数组构造;`llama_sampler_sample` 开头的 `sampled_token` 检测就是为此设计的(`src/llama-sampler.cpp:807`-`816`) → [第 10 章](10-sampling.md)
- `llama_token_data_array` 的 `sorted` 标志:top-k apply 后会把 `sorted=true`,后续 top-p 可以跳过重复排序 → [第 10 章](10-sampling.md)
- accept 阶段如何支持 repetition penalty 和 presence penalty 的状态维护 → [第 10 章](10-sampling.md)

## 8. 走完这一步你脑子里应该多了什么

1. **greedy 就是 argmax,不需要 softmax**:softmax 是单调变换,argmax 前后不变,greedy 实现就是一次 O(n_vocab) 线性扫描。
2. **`llama_token_data_array` 是采样器链的统一载体**:所有采样器操作都通过这个结构传递候选列表和状态标志,避免每个采样器各自持有状态。
3. **apply 改变候选集,accept 更新历史状态**:两个阶段职责分离——apply 是从当前 logits 里选 token,accept 是把结果告诉下一轮的历史相关采样器。
4. **采样器链是可组合的**:在 `greedy` 前插入 `temperature` 或 `top-k`,只需在链里 add 一个采样器,不改变后续逻辑。
5. 执行完这一步,`new_token_id` 是一个具体的 `llama_token` 整数——下一步要把它还原成人类可读的文字片段并打印出来。

下一步:[步骤 16 —— 解码并进入下一轮](tour-16-detokenize-loop.md)。
