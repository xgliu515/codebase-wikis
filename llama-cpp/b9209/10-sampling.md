# 第 10 章 采样与 token 生成

## 总览

llama.cpp 的每个推理步骤以 `llama_decode` 为起点，最终产出一组 logits（词表维度的原始得分向量）。采样系统的任务是从 logits 中选出下一个 token，并将结果反馈给采样器内部状态（用于惩罚等历史感知采样器）。整个流程如下：

<svg viewBox="0 0 640 500" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end token generation and sampling sequence">
  <defs>
    <marker id="ar10" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="640" height="500" fill="#f8fafc" rx="8"/>
  <rect x="160" y="14" width="320" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="320" y="31" text-anchor="middle" font-size="13" font-weight="700" fill="#ea580c">llama_decode(ctx, batch)</text>
  <text x="320" y="48" text-anchor="middle" font-size="10" fill="#64748b">产出 logits[seq_pos × n_vocab … +n_vocab]</text>
  <line x1="320" y1="54" x2="320" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10)"/>
  <rect x="100" y="74" width="440" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="94" text-anchor="middle" font-size="13" font-weight="700" fill="#7c3aed">llama_sampler_sample(smpl, ctx, idx)</text>
  <text x="320" y="110" text-anchor="middle" font-size="10" fill="#64748b">构建 cur[n_vocab]：llama_token_data{id, logit, p=0}</text>
  <text x="320" y="123" text-anchor="middle" font-size="10" fill="#94a3b8">p 初始化为 0，softmax 后才有意义</text>
  <line x1="320" y1="130" x2="320" y2="150" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10)"/>
  <rect x="60" y="150" width="520" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="320" y="170" text-anchor="middle" font-size="13" font-weight="700" fill="#0d9488">llama_sampler_apply(smpl, &amp;cur_p)</text>
  <text x="320" y="186" text-anchor="middle" font-size="11" fill="#64748b">依次调用采样器链中每个采样器的 apply</text>
  <rect x="90" y="194" width="460" height="26" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="211" text-anchor="middle" font-size="10" fill="#64748b">penalties → dry → top_k → top_p → temp → dist</text>
  <text x="320" y="238" text-anchor="middle" font-size="10" fill="#94a3b8">→ cur_p.selected 被最终选择型采样器设置为选中 token 的数组索引</text>
  <line x1="320" y1="244" x2="320" y2="264" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10)"/>
  <rect x="100" y="264" width="440" height="50" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="320" y="284" text-anchor="middle" font-size="13" font-weight="700" fill="#0ea5e9">llama_sampler_accept(smpl, token)</text>
  <text x="320" y="300" text-anchor="middle" font-size="10" fill="#64748b">通知所有采样器历史已接收该 token（penalties / mirostat 等更新内部状态）</text>
  <line x1="320" y1="314" x2="320" y2="334" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10)"/>
  <rect x="160" y="334" width="320" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="320" y="352" text-anchor="middle" font-size="13" font-weight="700" fill="#16a34a">返回 token id</text>
  <text x="320" y="366" text-anchor="middle" font-size="10" fill="#64748b">追加到 batch，进入下一轮 decode 循环</text>
  <line x1="320" y1="370" x2="320" y2="394" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar10)"/>
  <rect x="200" y="394" width="240" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="411" text-anchor="middle" font-size="11" fill="#64748b">追加到 batch → 下一轮循环</text>
  <path d="M 590,411 Q 630,411 630,200 Q 630,30 590,30" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4,3" marker-end="url(#ar10)"/>
  <text x="638" y="220" text-anchor="middle" font-size="9" fill="#94a3b8" transform="rotate(90,638,220)">下一轮</text>
</svg>
<span class="figure-caption">图 R10.1 ｜ 采样系统端到端 token 生成序列图</span>

<details>
<summary>ASCII 原版</summary>

```
llama_decode(ctx, batch)
    → ctx->logits[seq_pos * n_vocab ... (seq_pos+1)*n_vocab - 1]
         |
         v
llama_sampler_sample(smpl, ctx, idx)
    → cur[n_vocab]  逐个填充 llama_token_data{id, logit, p=0}
         |
         v
llama_sampler_apply(smpl, &cur_p)   // 调度采样器链逐步过滤
    → cur_p.selected 被设置为最终索引
         |
         v
llama_sampler_accept(smpl, token)   // 通知所有采样器历史已接收该 token
         |
         v
  返回 token id → 追加到 batch，下一轮循环
```

</details>

采样器通过**链式组合**实现可插拔架构：每个采样器只负责一项职责（截断、归一化、随机选择等），链中依次调用 `apply`，最后一个采样器负责设置 `cur_p.selected`。

---

## 10.1 核心数据结构

### 10.1.1 llama_token_data 与 llama_token_data_array

定义于 `include/llama.h:207-220`：

```c
typedef struct llama_token_data {
    llama_token id;    // token 在词表中的编号
    float       logit; // 原始 log-odds（logit），由模型输出
    float       p;     // 经过 softmax 后的概率，初始为 0
} llama_token_data;

typedef struct llama_token_data_array {
    llama_token_data * data;     // 指向候选 token 数组（可在采样过程中被截断）
    size_t             size;     // 当前有效候选数量
    int64_t            selected; // 选中 token 的数组索引（-1 表示尚未选择）
    bool               sorted;   // 若为 true，data 已按 logit/p 降序排列
} llama_token_data_array;
```

**设计关键点**：

- `data` 是可原地修改的数组。截断型采样器（top-k、top-p 等）直接缩小 `size` 或调整 `data` 指针。
- `sorted` 是延迟标志。top-p 等需要排序时才真正排序，greedy 只需扫一遍找最大值，无需完整排序。
- `selected` 由最终的"选择型"采样器（greedy、dist、mirostat 等）写入，其他过滤型采样器只修改 `size`/`data`/`sorted`。

### 10.1.2 llama_sampler_i 接口

`include/llama.h:1231-1261` 定义了采样器虚表：

```c
struct llama_sampler_i {
    const char *           (*name)  (const struct llama_sampler * smpl);
    void                   (*accept)(      struct llama_sampler * smpl, llama_token token);
    void                   (*apply) (      struct llama_sampler * smpl, llama_token_data_array * cur_p);
    void                   (*reset) (      struct llama_sampler * smpl);
    struct llama_sampler * (*clone) (const struct llama_sampler * smpl);
    void                   (*free)  (      struct llama_sampler * smpl);

    // GPU 侧采样扩展（可选）
    bool (*backend_init)  (struct llama_sampler * smpl, ggml_backend_buffer_type_t buft);
    void (*backend_accept)(...);
    void (*backend_apply) (...);
    void (*backend_set_input)(...);
};

struct llama_sampler {
    struct llama_sampler_i * iface;
    llama_sampler_context_t  ctx;   // void*，指向具体采样器的状态
};
```

五个核心方法语义：

| 方法 | 时机 | 有无状态变更 |
|---|---|---|
| `apply` | 每次 `llama_sampler_sample` 调用中对 `cur_p` 进行过滤或选择 | 无（过滤器），或写 `cur_p.selected`（选择器） |
| `accept` | 选出 token 后，通知采样器历史已更新 | 是（penalties、mirostat 等更新内部状态） |
| `reset` | 重置内部历史，但保留参数 | 是 |
| `clone` | 深拷贝采样器（含当前状态） | 无（返回新对象） |
| `free` | 释放 `ctx` 内存 | 是（析构） |

---

## 10.2 采样器链 llama_sampler_chain

### 10.2.1 结构

`src/llama-sampler.h:12-34`：

```c
struct llama_sampler_chain {
    llama_sampler_chain_params params;
    bool is_init;          // 是否已调用 backend_init

    struct info {
        bool            is_backend;  // 该采样器是否运行在 GPU 侧
        llama_sampler * ptr;
    };
    std::vector<info> samplers;

    std::vector<llama_token_data> cur;  // 预分配的候选 buffer，避免每次堆分配
    mutable int64_t t_sample_us;
    mutable int32_t n_sample;
};
```

### 10.2.2 链式 apply

`src/llama-sampler.cpp:642-661`：

```c
static void llama_sampler_chain_apply(
        struct llama_sampler * smpl, llama_token_data_array * cur_p) {
    auto * chain = (llama_sampler_chain *) smpl->ctx;
    bool is_backend = chain->is_init;

    for (auto & s : chain->samplers) {
        if (is_backend && s.is_backend) continue;  // 已在 GPU 执行，跳过
        is_backend = false;
        if (s.ptr->iface->apply) llama_sampler_apply(s.ptr, cur_p);
    }
}
```

**为什么用链而非单一函数？** 每个采样器是独立的策略，用户可以任意组合、插拔。链式设计让参数/状态完全封装于各自采样器中，避免一个全局参数结构体随功能增加而膨胀。

### 10.2.3 典型链顺序

按照 `common/sampling.cpp` 中的惯用配置：

<svg viewBox="0 0 880 200" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Typical sampler chain pipeline order">
  <defs>
    <marker id="ar11" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="880" height="200" fill="#f8fafc" rx="8"/>
  <text x="440" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">典型采样器链顺序（common/sampling.cpp）</text>
  <rect x="10" y="36" width="88" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="54" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">penalties</text>
  <text x="54" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">重复惩罚</text>
  <line x1="98" y1="58" x2="114" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="114" y="36" width="74" height="44" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="151" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#dc2626">dry</text>
  <text x="151" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">DRY 惩罚</text>
  <line x1="188" y1="58" x2="204" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="204" y="36" width="74" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="241" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">top_k</text>
  <text x="241" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">保留 top-k</text>
  <line x1="278" y1="58" x2="294" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="294" y="36" width="74" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="331" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">typical</text>
  <text x="331" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">典型性过滤</text>
  <line x1="368" y1="58" x2="384" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="384" y="36" width="74" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="421" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">top_p</text>
  <text x="421" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">核采样截断</text>
  <line x1="458" y1="58" x2="474" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="474" y="36" width="74" height="44" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="511" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">min_p</text>
  <text x="511" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">最小概率过滤</text>
  <line x1="548" y1="58" x2="564" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="564" y="36" width="74" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="601" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">temp</text>
  <text x="601" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">温度缩放</text>
  <line x1="638" y1="58" x2="654" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar11)"/>
  <rect x="654" y="36" width="74" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="691" y="55" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">dist</text>
  <text x="691" y="71" text-anchor="middle" font-size="9" fill="#94a3b8">最终选择</text>
  <text x="440" y="108" text-anchor="middle" font-size="11" fill="#64748b">↑ 过滤型（修改 size/data）</text>
  <text x="691" y="108" text-anchor="middle" font-size="11" fill="#ea580c">↑ 选择型（写 selected）</text>
  <rect x="10" y="122" width="640" height="26" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="320" y="139" text-anchor="middle" font-size="10" fill="#64748b">过滤型采样器：只修改 cur_p.size / cur_p.data，不设置 selected</text>
  <rect x="654" y="122" width="210" height="26" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="759" y="139" text-anchor="middle" font-size="10" fill="#ea580c">选择型：必须设置 selected</text>
  <text x="440" y="170" text-anchor="middle" font-size="10" fill="#94a3b8">greedy 解码时链中只有一个 greedy 采样器（无 dist）</text>
  <text x="440" y="184" text-anchor="middle" font-size="10" fill="#94a3b8">grammar 采样器插在 temp 与 dist 之间</text>
</svg>
<span class="figure-caption">图 R10.2 ｜ 典型采样器链顺序与过滤/选择分工</span>

<details>
<summary>ASCII 原版</summary>

```
penalties        // 重复惩罚（需历史）
  → dry          // Don't Repeat Yourself 惩罚（Z 算法检测长重复序列）
  → top_k        // 保留 logit 最高的 k 个候选
  → typical      // 局部典型性采样（按信息熵过滤）
  → top_p        // 核采样：累计概率 ≥ p 截断
  → min_p        // 最小概率阈值过滤
  → temp         // 温度缩放（logit /= temp）
  → dist         // 归一化 + 按概率随机抽样（最终选择）
```

</details>

greedy 解码时链中只有一个 `greedy` 采样器，不需要 dist。

---

## 10.3 llama_sampler_sample：完整流程

`src/llama-sampler.cpp:806-873`：

```c
llama_token llama_sampler_sample(
        struct llama_sampler * smpl, struct llama_context * ctx, int32_t idx) {
    // 1. 检查 GPU 后端采样器是否已采样
    const llama_token sampled_token = llama_get_sampled_token_ith(ctx, idx);
    if (sampled_token != LLAMA_TOKEN_NULL) {
        return sampled_token;   // GPU 侧已完成，直接返回
    }

    // 2. 构建 cur_p
    const float * logits = llama_get_logits_ith(ctx, idx);  // [n_vocab]
    cur.resize(n_vocab);
    for (llama_token i = 0; i < n_vocab; i++) {
        cur[i] = llama_token_data{i, logits[i], 0.0f};
    }

    llama_token_data_array cur_p = {
        .data     = cur.data(),
        .size     = cur.size(),
        .selected = -1,
        .sorted   = false,
    };

    // 3. 运行整个采样器链
    llama_sampler_apply(smpl, &cur_p);

    // 4. 断言已选择
    GGML_ASSERT(cur_p.selected >= 0 && cur_p.selected < (int32_t)cur_p.size);
    auto token = cur_p.data[cur_p.selected].id;

    // 5. 通知采样器链接受该 token
    llama_sampler_accept(smpl, token);

    return token;
}
```

**步骤 2 说明**：`p` 字段初始化为 0，只有调用 softmax（`llama_sampler_softmax_impl`）后才有意义。各采样器按需调用 softmax；多次调用有幂等性保护（`sorted` 标志）。

---

## 10.4 各采样器详解

### 10.4.1 greedy

`src/llama-sampler.cpp:963-969`：

```c
static void llama_sampler_greedy_apply(
        struct llama_sampler * /*smpl*/, llama_token_data_array * cur_p) {
    cur_p->selected = 0;
    for (size_t i = 1; i < cur_p->size; ++i) {
        if (cur_p->data[i].logit > cur_p->data[cur_p->selected].logit)
            cur_p->selected = i;
    }
}
```

O(n_vocab) 线性扫描找最大 logit。不调用 softmax，不修改 `data`，只写 `selected`。适合确定性推理或温度为 0 的场景。GPU 侧等价实现为 `ggml_argmax`（第 992 行）。

### 10.4.2 dist（分布采样）

`src/llama-sampler.cpp:1036-1229`：

核心逻辑：

1. 计算 softmax（稳定版，先减 max logit 防止 exp 溢出）
2. 生成 [0,1) 均匀随机数，在归一化概率的累积分布上二分（实现为单遍扫描）

```c
// 高效单遍采样（比先归一化再二分快约 3×）
double sum_cum = 0.0f;
for (size_t i = 0; i < cur_p->size; ++i) {
    float p = expf(cur_p->data[i].logit - max_l);
    cur_p->data[i].p = p;
    sum_cum += p;
}
// 直接在累积和空间抽样，同时归一化
```

`dist` 是最终"消费" `cur_p` 的采样器，一般位于链末尾。持有 `std::mt19937` RNG，支持通过 `reset` 重置到指定种子。

### 10.4.3 top-k

`src/llama-sampler.cpp:1255-1258`（apply 委托给 `llama_sampler_top_k_impl`）：

用 `std::partial_sort`（或 GPU 侧 `ggml_top_k`）保留 logit 最高的 k 个 token，截断 `cur_p->size = k`。

`k <= 0` 时 `llama_sampler_init_top_k` 返回 empty 占位采样器（无操作），允许用户禁用 top-k 而不改变链结构。

GPU 侧实现（`backend_apply`，第 1281-1306 行）：直接用 `ggml_top_k` 算子作为计算图节点，可在 GPU 上执行，避免 logits 数据回传 CPU。

### 10.4.4 top-p（核采样）

`src/llama-sampler.cpp:1351-1403`：

```text
算法:
1. 调用 softmax 获得概率
2. 若候选数 > 1024：先用 partial_sort 取前 256 个（自适应 top-k 启发）
3. 累加概率，找最小 last_idx 使 cumsum >= p（且 last_idx >= min_keep）
4. 将 data 截断到 last_idx，sorted = true
```

为避免全量排序开销，先取较小的 top-k（256）近似，若累积还不够再扩大至全量。这是在精确度与性能之间的工程权衡。

### 10.4.5 min-p

`src/llama-sampler.cpp:1599-1684`：

过滤掉 `p < p_base * max_p` 的 token（`p_base` 由参数指定，`max_p` 为当前批次中最高概率）。保证候选集中所有 token 的概率不低于最高概率的某个比例。min-p 是对 top-p 的互补：top-p 从高端截断，min-p 从低端截断。

### 10.4.6 temp（温度）与 temp-ext（动态温度）

**temp**（`src/llama-sampler.cpp:1807-1810`）：对所有 logit 除以 `temp`：

```c
static void llama_sampler_temp_apply(
        struct llama_sampler * smpl, llama_token_data_array * cur_p) {
    llama_sampler_temp_impl(cur_p, ((llama_sampler_temp *)smpl->ctx)->temp);
}
// 内部：for each candidate: cur_p->data[i].logit /= temp
```

`temp == 0` 退化为 greedy（GPU 侧用 `ggml_argmax`，第 1829 行）。`temp > 1` 使分布更平坦，`temp < 1` 使分布更尖锐。

**temp-ext（动态温度，`src/llama-sampler.cpp:1986-2079`）**：根据当前分布的熵动态调整温度。熵高（不确定）时使用较低温度；熵低（确定性强）时使用较高温度。GPU 侧实现通过一系列 ggml 算子（`ggml_soft_max`、`ggml_log`、`ggml_sum`、`ggml_scale_bias`）构建动态温度计算图，完全在 GPU 上执行。

### 10.4.7 typical（局部典型性采样）

`src/llama-sampler.cpp:1698-1755`：

基于 Meister 等人 2023 年论文。思路：选择"信息量接近分布熵"的 token（即信息量既不太高也不太低的 token）。

```text
1. 计算 softmax 和分布熵 H = -Σ p_i * log(p_i)
2. 计算每个 token 的偏移分数 |(-log p_i) - H|
3. 按偏移分数升序排列（信息量最接近熵的 token排在前面）
4. 累加概率直到 cumsum > p，截断
```

与 top-p 不同：top-p 保留高概率 token；typical 保留信息量适中的 token，有助于生成更有创意的文本。

### 10.4.8 xtc（排除最高概率 token）

`src/llama-sampler.cpp:2118-2148`：

概率 `probability`（默认 0）的采样器，以该概率激活；激活时排除所有概率 >= `threshold` 的 token（除非满足 `min_keep`）。直觉：强制模型从"第二选择"开始采样，增加多样性。

```c
if (cur_p->data[i].p >= ctx->threshold) {
    pos_last = i;   // 找最后一个超过阈值的位置
}
// 截掉 [0, pos_last]，从 pos_last+1 开始采样
cur_p->data += pos_last;
cur_p->size -= pos_last;
```

### 10.4.9 mirostat v1 / v2（目标困惑度采样）

`src/llama-sampler.cpp:2232-2410`：

**mirostat**（Basu 等人 2020 年）通过闭环控制使每步采样的"惊讶度"（cross-entropy）维持在目标值 `tau` 附近：

```text
mirostat v1:
1. 估计分布的 s_hat（幂律指数）
2. 由 s_hat 和 mu 计算动态 k
3. top-k(k) + softmax + 分布采样
4. observed_surprise = -log2(p_selected)
5. mu -= eta * (observed_surprise - tau)

mirostat v2（简化版，src/llama-sampler.cpp:2343-2368）:
1. softmax 后截掉所有 -log2(p) > mu 的 token（即惊讶度过大的 token）
2. 重归一化 + 采样
3. mu -= eta * (observed_surprise - tau)
```

`mu` 是内部状态，`reset` 时重置为 `2 * tau`，`accept` 在 v1/v2 内部隐含（apply 直接更新 mu）。

### 10.4.10 penalties（重复惩罚）

`src/llama-sampler.cpp:2620-2766`：

持有 `ring_buffer<llama_token>` 记录最近 `penalty_last_n` 个已生成 token 和频率计数表。

```c
// apply 中的惩罚公式：
if (cur_p->data[i].logit <= 0)
    cur_p->data[i].logit *= penalty_repeat;   // 负 logit 乘以（>1）使其更负
else
    cur_p->data[i].logit /= penalty_repeat;   // 正 logit 除以（>1）减小

cur_p->data[i].logit -= count * penalty_freq + (count > 0) * penalty_present;
```

三项惩罚：

| 参数 | 含义 |
|---|---|
| `penalty_repeat` | 重复惩罚因子（1.0 无效）|
| `penalty_freq` | 频率惩罚：与 token 出现次数成比例 |
| `penalty_present` | 存在惩罚：只要出现过就惩罚，与次数无关 |

`accept` 更新 ring buffer 和频率计数表（第 2638-2656 行）。

### 10.4.11 DRY（Don't Repeat Yourself 惩罚）

`src/llama-sampler.cpp:2900-3100+`：

DRY 是更强的重复惩罚，专门针对长序列重复。算法分四步：

```text
Step 1: 确定"重新开始"序列的最大允许重复长度 rep_limit
        （通过扫描 seq_breakers 找到最近的重启标记）

Step 2: Z 算法（线性时间字符串后缀匹配）
        在最近 N 个 token 中计算每个位置的重复后缀长度
        dry_repeat_count[i] = 以位置 i 结尾的最长后缀匹配长度（≤ rep_limit）

Step 3: 遍历 dry_repeat_count，找到所有"下一个 token 若为 X 则会延长重复序列"的 X
        记录每个 X 对应的最大重复长度到 dry_max_token_repeat[X]

Step 4: 对 cur_p 中 dry_max_token_repeat 中的 token 施加指数惩罚：
        penalty = multiplier * base^(max_repeat_len - allowed_length)
        logit -= penalty
```

Z 算法的时间复杂度为 O(N)，大幅优于朴素的 O(N²) 后缀匹配，使长上下文 DRY 惩罚可实用。

---

## 10.5 grammar / 结构化输出约束

### 10.5.1 GBNF 语法格式

llama.cpp 支持 GBNF（GGML BNF，类 BNF 扩展），定义于 `src/llama-grammar.h`：

```text
GBNF 规则示例（JSON object）：
root  ::= "{" ws members ws "}"
members ::= pair ("," ws pair)*
pair ::= string ":" ws value
...
```

每个规则元素用 `llama_grammar_element` 表示（`src/llama-grammar.h:47-50`），类型包括 `LLAMA_GRETYPE_CHAR`（字符）、`LLAMA_GRETYPE_RULE_REF`（规则引用）、`LLAMA_GRETYPE_TOKEN`（直接 token ID 约束）等。

### 10.5.2 grammar sampler 内部结构

`src/llama-sampler.cpp:2428-2435`：

```c
struct llama_sampler_grammar {
    const struct llama_vocab * vocab;
    std::string grammar_str;
    std::string grammar_root;
    struct llama_grammar * grammar;  // 运行时状态（NFA 当前栈）
};
```

`llama_grammar` 维护 `stacks`（NFA 栈集合，每个栈代表一种可能的解析路径）。初始状态包含所有从根规则出发的路径。

### 10.5.3 apply：token 裁剪

`src/llama-sampler.cpp:2448-2452` 调用 `llama_grammar_apply_impl`（`src/llama-grammar.cpp:1355-1379`）：

```text
llama_grammar_apply_impl(*grammar, cur_p):
  for each candidate token t in cur_p:
    piece = vocab.token_to_piece(t)   // token → UTF-8 文本片段
    decode_utf8(piece) → code_points  // 处理跨 token 边界的 UTF-8

  rejects = llama_grammar_reject_candidates(rules, stacks, candidates_grammar)
  for r in rejects:
    cur_p->data[r.index].logit = -INFINITY   // 将违法 token 的 logit 设为 -∞
```

`llama_grammar_reject_candidates`（`src/llama-grammar.cpp:936-953`）对每个 NFA 栈调用 `llama_grammar_reject_candidates_for_stack`，取所有栈的拒绝集**交集**：只有在**所有**活跃 NFA 栈下都非法的 token 才会被拒绝（宽松语义：只要存在一条合法路径就允许）。

### 10.5.4 accept：推进 NFA 状态

`src/llama-sampler.cpp:2441-2445` 调用 `llama_grammar_accept_impl`（`src/llama-grammar.cpp:1382-1438`）：

```text
llama_grammar_accept_impl(grammar, token):
  piece = vocab.token_to_piece(token)
  
  if grammar.awaiting_trigger:
    # lazy grammar 模式：等待触发词出现后才开始约束
    检查是否匹配 trigger_tokens 或 trigger_patterns
    若匹配：grammar.awaiting_trigger = false，开始约束
    否则：缓冲到 trigger_buffer，继续等待

  else:
    llama_grammar_accept_token(grammar, token, piece)
    # 推进 NFA：对每个活跃栈，消费 piece 中的字符，得到新栈集合
```

**lazy grammar**（`llama_sampler_init_grammar_lazy_patterns`）允许指定触发词或触发 token，在生成中间某个关键词（如 "JSON:"）之前不约束输出，触发后才激活 grammar。这解决了 system prompt 格式与 JSON 输出混合的场景。

### 10.5.5 grammar 在链中的位置

grammar 采样器必须放在**选择型采样器**（greedy/dist）之前，因为它只是修改 logit（设为 -∞），不选择 token：

```text
penalties → dry → top_k → top_p → temp → grammar → dist
                                           ^^^^^^^^^
                                   grammar 在 dist 之前，确保非法 token 已被排除
```

---

## 10.6 采样器的 backend 扩展

`include/llama.h:1244-1261` 定义了 GPU 侧采样接口。部分采样器（greedy、top-k、top-p、temp、dist）实现了 `backend_init`/`backend_apply`，可以将采样操作构建为 ggml 计算图节点，在 GPU 上执行，避免 logits 回传 CPU 的带宽开销。

<svg viewBox="0 0 760 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GPU backend sampling flow bypassing CPU token transfer">
  <defs>
    <marker id="ar12" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
    <marker id="ar12d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="300" fill="#f8fafc" rx="8"/>
  <text x="380" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">采样器 backend 扩展：GPU 侧采样旁路</text>
  <rect x="30" y="36" width="700" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="55" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">backend_init：llama_sampler_backend_support 检查硬件支持</text>
  <text x="380" y="69" text-anchor="middle" font-size="10" fill="#64748b">若支持 → is_backend = true（greedy / top_k / top_p / temp / dist）</text>
  <line x1="200" y1="80" x2="200" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12)"/>
  <line x1="560" y1="80" x2="560" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12)"/>
  <rect x="30" y="100" width="320" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="190" y="120" text-anchor="middle" font-size="11" font-weight="700" fill="#0d9488">GPU 子图执行路径</text>
  <text x="190" y="136" text-anchor="middle" font-size="10" fill="#64748b">chain_apply 中 is_backend &amp;&amp; s.is_backend</text>
  <text x="190" y="150" text-anchor="middle" font-size="10" fill="#64748b">→ continue（跳过 CPU apply）</text>
  <rect x="410" y="100" width="320" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="570" y="120" text-anchor="middle" font-size="11" font-weight="700" fill="#7c3aed">CPU 路径（无 GPU 支持）</text>
  <text x="570" y="136" text-anchor="middle" font-size="10" fill="#64748b">正常逐个调用每个采样器的 apply</text>
  <text x="570" y="150" text-anchor="middle" font-size="10" fill="#64748b">logits 回传 CPU 后处理</text>
  <line x1="190" y1="156" x2="190" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12)"/>
  <line x1="570" y1="156" x2="570" y2="176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12)"/>
  <rect x="30" y="176" width="320" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="190" y="196" text-anchor="middle" font-size="11" font-weight="700" fill="#16a34a">llama_sampler_sample 入口</text>
  <text x="190" y="210" text-anchor="middle" font-size="10" fill="#64748b">llama_get_sampled_token_ith → 非 NULL</text>
  <text x="190" y="222" text-anchor="middle" font-size="10" fill="#16a34a">→ 直接 return（GPU 已采样完毕）</text>
  <rect x="410" y="176" width="320" height="46" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.5"/>
  <text x="570" y="196" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">构建 cur_p → 调用链 apply</text>
  <text x="570" y="210" text-anchor="middle" font-size="10" fill="#64748b">→ cur_p.selected 由最终选择器写入</text>
  <text x="570" y="222" text-anchor="middle" font-size="10" fill="#64748b">→ return token id</text>
  <text x="380" y="274" text-anchor="middle" font-size="10" fill="#94a3b8">GPU 侧：top_k + temp + dist 全部在 GPU 串联执行，仅结果 token id 返回 CPU</text>
</svg>
<span class="figure-caption">图 R10.3 ｜ 采样器 backend 扩展：GPU 侧采样旁路 CPU 路径</span>

<details>
<summary>ASCII 原版</summary>

```
backend_init:
  llama_sampler_backend_support 检查硬件是否支持
  若支持：is_backend = true

chain_apply 中：
  if is_backend && s.is_backend: continue  // 跳过，由 GPU 子图处理
  
llama_sampler_sample 入口：
  sampled_token = llama_get_sampled_token_ith(ctx, idx)
  if sampled_token != NULL: return sampled_token  // GPU 已采样完毕
```

</details>

这一机制允许 top-k + temp + dist 全部在 GPU 上串联执行，只有结果（单个 token id）需要返回 CPU。

---

## 10.7 关键文件索引

| 文件 | 作用 |
|---|---|
| `include/llama.h:207-221` | `llama_token_data`、`llama_token_data_array` 定义 |
| `include/llama.h:1231-1435` | `llama_sampler_i`、`llama_sampler`、所有 init 函数声明 |
| `src/llama-sampler.h` | `llama_sampler_chain` 内部结构 |
| `src/llama-sampler.cpp` | 所有采样器实现、`llama_sampler_sample` |
| `src/llama-grammar.h` | `llama_gretype`、`llama_grammar_element`、`llama_grammar_candidate` |
| `src/llama-grammar.cpp:936-953` | `llama_grammar_reject_candidates`（Z 算法 + NFA 拒绝） |
| `src/llama-grammar.cpp:1382-1438` | `llama_grammar_accept_impl`（NFA 状态推进） |
