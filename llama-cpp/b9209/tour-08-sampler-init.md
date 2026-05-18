# Trace 步骤 08 —— 采样器是一个接口,为什么还需要一条"链"?

## 1. 当前情境

`llama_context` 已经完全就绪:KV 缓存分配完毕,计算图 reserve 过一遍,后端调度器就位。`simple.cpp` 接下来要做的第一件与"如何生成 token"有关的事,是这三行(`examples/simple/simple.cpp:128`-`132`):

```cpp
auto sparams = llama_sampler_chain_default_params();
sparams.no_perf = false;
llama_sampler * smpl = llama_sampler_chain_init(sparams);

llama_sampler_chain_add(smpl, llama_sampler_init_greedy());
```

此刻模型还没跑任何一次前向计算,但采样器必须在第一次 `llama_decode` 之前建好,因为解码循环里的 `llama_sampler_sample` 会直接拿这个指针。

## 2. 问题

前向计算结束后,输出的是一个长度等于词表大小的 `float` 数组——logits。词表动辄数万个 token,最终需要从里面"选出"一个 id 交给下一轮。这个"选"的过程叫**采样**。

问题有两层:

1. **接口层**:采样逻辑需要是可替换的。贪心、nucleus(top-p)、temperature、重复惩罚、grammar 约束……每种场景要用不同的组合。必须有一种统一的表示方式,让调用方不关心内部实现。
2. **组合层**:现实中一次采样往往不是单一算法,而是多个算法的串联(先 top-k 缩小候选,再 temperature 重新标定,最后 multinomial 抽样)。这几步如何无缝拼接在一起?

## 3. 朴素思路

定义一个函数指针或虚函数 `select(logits) -> token_id`,每种采样策略实现一遍。调用时如果想组合多个策略,就手写:

```cpp
top_k_filter(logits);
temperature_scale(logits);
token = multinomial_sample(logits);
```

想换策略就改代码,或者传几个函数指针进来。

## 4. 为什么朴素思路会崩

朴素思路在只有一种固定策略时勉强可以,但有几个结构性问题:

- **状态绑定困难**。重复惩罚采样器需要记住历史 token,Grammar 采样器需要维护解析状态机,mirostat 需要记住 `mu`。如果用裸函数指针,这些状态只能靠全局变量或额外的参数传递,调用约定立刻混乱。
- **组合顺序是配置,不是代码**。用户想在运行期通过命令行参数决定"先 top-k 还是先 top-p",纯函数指针的方案要求调用方写一大堆 `if/else` 拼接逻辑。
- **性能计数不通用**。llama.cpp 在 `llama_sampler_chain` 里统一计时 (`t_sample_us`)。如果每种采样器各自计时,聚合口径就不一致。
- **`accept` 语义消失**。采样选出 token 之后,有状态的采样器(比如 penalties)需要得到通知:"这个 token 已经被接受了,请把它加进历史"。裸函数模型里这一步没有标准位置。

## 5. llama.cpp 的做法

llama.cpp 把采样抽象为一个小型**插件接口**(`llama_sampler_i`),然后用一个特殊的采样器——`llama_sampler_chain`——把多个插件串成一条流水线。

**接口 `llama_sampler_i`** 定义在 `include/llama.h:1231`-`1260`,核心是三个回调:

```cpp
struct llama_sampler_i {
    void (*apply) (struct llama_sampler * smpl,
                   llama_token_data_array * cur_p);  // 必须实现:修改候选集
    void (*accept)(struct llama_sampler * smpl,
                   llama_token token);               // 可选:token 被接受后通知
    void (*reset) (struct llama_sampler * smpl);     // 可选:重置内部状态
    struct llama_sampler * (*clone)(…);
    void (*free)(…);
    // … 还有 backend_* 系列用于 GPU 端采样
};
```

每个采样器实例 `llama_sampler` 持有一个 `iface` 指针和一个私有的 `ctx`(`include/llama.h:1264`-`1267`)。这是经典的 C 接口+opaque 指针模式。

**`llama_sampler_chain`** 本身也是一个 `llama_sampler`,但它的 `apply` 是把内部 `samplers` 列表里的每个成员依次调用一遍;它的 `accept` 也是广播给每个成员(`src/llama-sampler.cpp:630`-`662`):

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_sampler_chain apply and accept broadcast sequence">
  <defs>
    <marker id="ar8b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="220" fill="#f8fafc" rx="6"/>
  <text x="16" y="28" font-size="12" font-weight="700" fill="currentColor">apply(cur_p) — 顺序管道</text>
  <rect x="16" y="36" width="100" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="66" y="59" text-anchor="middle" font-size="11" fill="#64748b">cur_p (logits)</text>
  <line x1="116" y1="54" x2="152" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="152" y="36" width="120" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="212" y="55" text-anchor="middle" font-size="11" fill="#64748b">smpl[0].apply</text>
  <text x="212" y="67" text-anchor="middle" font-size="10" fill="#94a3b8">top-k/top-p/…</text>
  <line x1="272" y1="54" x2="308" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="308" y="36" width="120" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="368" y="55" text-anchor="middle" font-size="11" fill="#64748b">smpl[1].apply</text>
  <text x="368" y="67" text-anchor="middle" font-size="10" fill="#94a3b8">temperature/…</text>
  <line x1="428" y1="54" x2="464" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="464" y="36" width="120" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="524" y="55" text-anchor="middle" font-size="11" fill="#64748b">smpl[N].apply</text>
  <text x="524" y="67" text-anchor="middle" font-size="10" fill="#94a3b8">greedy/sample</text>
  <line x1="584" y1="54" x2="620" y2="54" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="620" y="36" width="120" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="680" y="55" text-anchor="middle" font-size="11" fill="#64748b">cur_p.selected</text>
  <text x="680" y="67" text-anchor="middle" font-size="10" fill="#94a3b8">= 选出 token id</text>
  <line x1="16" y1="106" x2="744" y2="106" stroke="#cbd5e1" stroke-width="0.8" stroke-dasharray="4,2"/>
  <text x="16" y="128" font-size="12" font-weight="700" fill="currentColor">accept(token) — 广播通知</text>
  <rect x="16" y="136" width="100" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="66" y="155" text-anchor="middle" font-size="11" fill="#64748b">token 被接受</text>
  <line x1="116" y1="154" x2="152" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="152" y="136" width="120" height="36" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="212" y="155" text-anchor="middle" font-size="11" fill="#64748b">smpl[0].accept</text>
  <text x="212" y="167" text-anchor="middle" font-size="10" fill="#94a3b8">penalties 更新</text>
  <line x1="272" y1="154" x2="308" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="308" y="136" width="120" height="36" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
  <text x="368" y="155" text-anchor="middle" font-size="11" fill="#64748b">smpl[1].accept</text>
  <text x="368" y="167" text-anchor="middle" font-size="10" fill="#94a3b8">grammar 更新</text>
  <line x1="428" y1="154" x2="464" y2="154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8b)"/>
  <rect x="464" y="136" width="120" height="36" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="524" y="155" text-anchor="middle" font-size="11" fill="#64748b">smpl[N].accept</text>
  <text x="524" y="167" text-anchor="middle" font-size="10" fill="#94a3b8">nullptr → skip</text>
  <text x="664" y="155" font-size="11" fill="#64748b">greedy: accept=nullptr</text>
  <text x="664" y="169" font-size="10" fill="#94a3b8">无状态,无需通知</text>
</svg>
<span class="figure-caption">图 T8.2 ｜ chain.apply 顺序管道与 chain.accept 广播通知</span>

<details>
<summary>ASCII 原版</summary>

```
llama_sampler_chain_apply(cur_p):
    for each smpl in chain.samplers:
        smpl.iface->apply(smpl, cur_p)   // 依次缩减/重排 cur_p

llama_sampler_chain_accept(token):
    for each smpl in chain.samplers:
        smpl.iface->accept(smpl, token)  // 有状态采样器更新内部记录
```

</details>

**greedy 采样器** 是最简单的实现:它的 `apply` 仅三行,线性扫描找 logit 最大的那个 token,把 `cur_p->selected` 设为那个下标(`src/llama-sampler.cpp:963`-`969`):

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

greedy 不需要 `accept`(无状态),因此 `llama_sampler_greedy_i` 的 `accept` 字段是 `nullptr`(`src/llama-sampler.cpp:1000`)。

**初始化流程**如下:

<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="sampler chain init and add call hierarchy">
  <defs>
    <marker id="ar8c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="260" fill="#f8fafc" rx="6"/>
  <rect x="16" y="14" width="240" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="136" y="34" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama_sampler_chain_init(sparams)</text>
  <line x1="36" y1="46" x2="36" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/>
  <rect x="36" y="60" width="280" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="176" y="80" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_init(&chain_i, new llama_sampler_chain{})</text>
  <line x1="56" y1="92" x2="56" y2="106" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/>
  <rect x="56" y="106" width="340" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="226" y="126" text-anchor="middle" font-size="11" fill="#64748b">返回 llama_sampler *  iface=chain_vtable  ctx.samplers=[]</text>
  <line x1="16" y1="158" x2="740" y2="158" stroke="#cbd5e1" stroke-width="0.8" stroke-dasharray="4,2"/>
  <rect x="16" y="166" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="156" y="186" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">llama_sampler_chain_add(smpl, greedy)</text>
  <line x1="36" y1="198" x2="36" y2="212" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/>
  <rect x="36" y="212" width="280" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="176" y="232" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_init_greedy()</text>
  <line x1="316" y1="228" x2="360" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8c)"/>
  <rect x="360" y="212" width="380" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="550" y="232" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_init(&greedy_i, new llama_sampler_greedy{})</text>
  <line x1="196" y1="244" x2="196" y2="258" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="210" y="258" font-size="10" fill="#94a3b8">chain→samplers.push_back(greedy_sampler)</text>
</svg>
<span class="figure-caption">图 T8.3 ｜ 采样器链的两步初始化:chain_init 创建空链,chain_add 插入 greedy 成员</span>

<details>
<summary>ASCII 原版</summary>

```
llama_sampler_chain_init(sparams)
    └─> llama_sampler_init(&llama_sampler_chain_i, new llama_sampler_chain{...})
            └─> 返回一个 llama_sampler *,iface 指向 chain 的 vtable,ctx 是空的 samplers 列表

llama_sampler_chain_add(smpl, llama_sampler_init_greedy())
    └─> llama_sampler_init_greedy()
            └─> llama_sampler_init(&llama_sampler_greedy_i, new llama_sampler_greedy{})
    └─> chain->samplers.push_back({is_backend=false, ptr=greedy_sampler})
```

</details>

走完这两步,`smpl` 指向一条只含一个成员的采样器链:

<svg viewBox="0 0 640 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="llama_sampler_chain structure containing one greedy sampler">
  <rect width="640" height="200" fill="#f8fafc" rx="6"/>
  <rect x="20" y="20" width="220" height="160" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="130" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">smpl</text>
  <text x="130" y="62" text-anchor="middle" font-size="11" fill="#64748b">llama_sampler_chain</text>
  <line x1="20" y1="70" x2="240" y2="70" stroke="#ea580c" stroke-width="0.8"/>
  <text x="36" y="90" font-size="11" fill="#64748b">iface → chain_vtable</text>
  <text x="36" y="110" font-size="11" fill="#64748b">ctx.samplers[]</text>
  <text x="36" y="130" font-size="11" fill="#64748b">t_sample_us (计时)</text>
  <text x="36" y="150" font-size="11" fill="#64748b">no_perf = false</text>
  <line x1="240" y1="100" x2="340" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar8a)"/>
  <text x="258" y="95" font-size="10" fill="#94a3b8">samplers[0]</text>
  <rect x="340" y="40" width="280" height="140" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="480" y="64" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">llama_sampler_greedy</text>
  <line x1="340" y1="74" x2="620" y2="74" stroke="#7c3aed" stroke-width="0.8"/>
  <text x="356" y="96" font-size="11" fill="#64748b">iface → greedy_vtable</text>
  <text x="356" y="116" font-size="11" fill="#64748b">apply = greedy_apply</text>
  <text x="356" y="132" font-size="10" fill="#94a3b8">argmax over cur_p→data</text>
  <text x="356" y="152" font-size="11" fill="#64748b">accept = nullptr</text>
  <text x="356" y="168" font-size="10" fill="#94a3b8">无状态,不需要通知</text>
  <defs>
    <marker id="ar8a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
</svg>
<span class="figure-caption">图 T8.1 ｜ 初始化后的采样器链结构:chain 包含一个 greedy 成员</span>

<details>
<summary>ASCII 原版</summary>

```
smpl (llama_sampler_chain)
  └─ samplers[0]: llama_sampler_greedy
                    apply  = greedy_apply   (argmax)
                    accept = nullptr
                    ctx    = llama_sampler_greedy{}
```

</details>

## 6. 代码位置

按阅读顺序:

- 调用点:`examples/simple/simple.cpp:128`-`132` —— `llama_sampler_chain_default_params` / `llama_sampler_chain_init` / `llama_sampler_chain_add`
- 接口定义:`include/llama.h:1221`-`1267` —— `llama_sampler_context_t`、`llama_sampler_i`、`llama_sampler` 结构体
- 链参数结构:`include/llama.h:426`-`428` —— `llama_sampler_chain_params`
- 链的内部结构:`src/llama-sampler.h:12`-`34` —— `struct llama_sampler_chain`
- 链 vtable:`src/llama-sampler.cpp:779`-`790` —— `llama_sampler_chain_i`
- 链 init/add 实现:`src/llama-sampler.cpp:792`-`882` —— `llama_sampler_chain_init` 和 `llama_sampler_chain_add`
- 链 apply 实现:`src/llama-sampler.cpp:642`-`662` —— `llama_sampler_chain_apply`
- 链 accept 实现:`src/llama-sampler.cpp:630`-`640` —— `llama_sampler_chain_accept`
- greedy vtable:`src/llama-sampler.cpp:998`-`1009` —— `llama_sampler_greedy_i`
- greedy apply:`src/llama-sampler.cpp:963`-`969` —— `llama_sampler_greedy_apply`
- greedy init:`src/llama-sampler.cpp:1011`-`1018` —— `llama_sampler_init_greedy`
- 公共 API:`include/llama.h:1285`-`1468` —— 全部 `llama_sampler_*` 和 `llama_sampler_init_*` 函数

## 7. 分支与延伸

- 采样器的完整分类(top-k、top-p、mirostat、grammar、DRY、penalties…)以及每种算法的数学含义 → [第 10 章 采样](10-sampling.md)
- 步骤 15 中 `llama_sampler_sample` 如何把 logits 转成 `llama_token_data_array` 并调用本步骤建好的链 → [步骤 15:采样下一个 token](tour-15-sample.md)
- GPU 端采样(`backend_init` / `backend_apply`)是 `llama_sampler_i` 扩展出的一套并行路径,让 argmax 可以在显卡上完成而不必把 logits 拷回 CPU → [第 10 章 §GPU 端采样](10-sampling.md)
- 性能计数(`sparams.no_perf = false`)的数据最终在 `llama_perf_sampler_print` 里打印(`examples/simple/simple.cpp:214`) → [第 7 章 上下文与批处理](07-context-and-batching.md)

## 8. 走完这一步你脑子里应该多了什么

1. **采样器是一个带状态的插件**:三个核心回调 `apply`(修改候选集)、`accept`(接受反馈)、`reset`(重置状态),分别对应"运行"、"确认"、"清零"三个生命周期动作。
2. **链(`chain`)本身也是采样器**:它的 `apply` 是顺序调用链内所有成员的 `apply`——这是 Chain of Responsibility 模式,让 top-k、temperature、penalties、grammar 可以任意组合而不互相依赖。
3. **greedy 是链中最简单的终止器**:无状态、无 `accept`、仅做一次线性扫描取 argmax,适合不需要随机性的确定性推理。
4. **`llama_sampler_chain_add` 转移所有权**:被 `add` 进链的采样器的生命周期由链管理,`llama_sampler_free(smpl)` 会递归释放链内每个成员。
5. 此刻没有 logits,也没有运行任何采样——这一步只是把"选 token 的决策引擎"组装好放在那里,等步骤 15 来激活它。

下一步:[步骤 09 —— 把 prompt 切成 token](tour-09-tokenize.md)。
