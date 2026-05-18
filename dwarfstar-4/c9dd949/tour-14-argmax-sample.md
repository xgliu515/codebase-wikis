# Trace 步骤 14 —— logits 到手，怎么挑出"下一个字"？

## 1. 当前情境

`session.logits` 是一个 `DS4_N_VOCAB = 129 280` 维的 float 数组，刚从 GPU 读回
CPU。每个分量是模型对"下一个 token 是 token i"的原始分数（未归一化），即
logit。在 `run_sampled_generation`（`ds4_cli.c:462`）里，prefill/sync 完成后
立刻进入生成循环的第一次采样：

```c
// ds4_cli.c:505-507
int token = ds4_session_sample(session, cfg->gen.temperature, 0,
                               cfg->gen.top_p, cfg->gen.min_p, &rng);
```

此处 `cfg->gen.temperature = 1.0f`、`cfg->gen.top_p = 1.0f`、
`cfg->gen.min_p = 0.05f`（均为步骤 01 解析出的默认值）。

## 2. 问题

给定一个 129 280 维的 logits 向量，要选出一个 token id 作为下一个生成 token。
选法不同会产生完全不同的输出质量和多样性：

- 选错了（如总选最高分），输出会重复、退化；
- 不加过滤直接按 softmax 概率采样，低概率垃圾 token 会随机出现；
- 过滤太激进，输出变成确定性的，和 argmax 无异。

此外，`temperature` 参数的语义必须在这里落地：`temperature <= 0` 时走确定性的
argmax，`temperature > 0` 才走随机采样。

## 3. 朴素思路

两种最直觉的做法：

- **argmax**：直接找 logits 最大值对应的 token，确定性、速度最快。适合需要
  可复现输出的场景（贪心解码）。
- **softmax 全量采样**：把所有 129 280 个 logit 转成概率（softmax），然后按概率
  抽样。无限制地从全词表采样，多样性最高。

## 4. 为什么朴素思路会崩

- **纯 argmax 退化**：对于文本生成，argmax 倾向于反复选同一个高频 token，导致
  输出重复循环（"the the the…" 或中文里的"是是是…"）。确定性意味着同一个 prompt
  永远得到同一个输出，创造性任务完全失效。
- **全量 softmax 采样噪声大**：词表中大量 token 对当前上下文几乎不合理（概率
  极低），但非零。129 280 个 token 全部参与采样时，这些"尾巴"会以小概率被抽
  到，污染输出。top-k（如 k=40）截断能缓解，但 k 的绝对值很难调——上下文不同，
  合理候选数差异极大：有时候只有 2-3 个合理词，有时候有几百个。
- **top-p（nucleus sampling）的改进与局限**：top-p 按累积概率截断（如 p=0.9），
  比 top-k 自适应，但对于概率分布非常尖锐（模型很确定）的情况，top-p=0.9 仍会
  放进一大批极低概率的尾巴 token。

## 5. DwarfStar 4 的做法

默认采样策略是 **min-p 过滤 + softmax 采样**，同时支持与 top-p 组合使用。
`temperature <= 0` 时直接走 argmax。

**min-p 的核心思想**：不按绝对概率值截断，而按**相对于最高概率的比值**截断。
具体地，设最高概率 token 的概率为 `p_max`，则保留所有满足
`p_i / p_max >= min_p` 的 token，其余过滤掉。对于 `min_p = 0.05`，这意味着
只有概率不低于最高概率 5% 的 token 才有资格被采样。

<svg viewBox="0 0 640 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="min-p sampling pipeline: temperature scaling, softmax, min-p filter, optional top-p cutoff, weighted random sampling to token id">
  <defs>
    <marker id="ar14a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="10" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="320" y="27" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">logits  (129 280 维)</text>
  <line x1="320" y1="42" x2="320" y2="62" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="160" y="62" width="320" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="77" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">temperature 缩放</text>
  <text x="320" y="88" text-anchor="middle" font-size="10" fill="#64748b">logit / temperature</text>
  <line x1="320" y1="90" x2="320" y2="110" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="160" y="110" width="320" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="125" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">softmax</text>
  <text x="320" y="136" text-anchor="middle" font-size="10" fill="#64748b">p_i = exp(logit_i/T − max_logit/T)  后归一化</text>
  <line x1="320" y1="138" x2="320" y2="158" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="160" y="158" width="320" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="320" y="173" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">min-p 过滤</text>
  <text x="320" y="184" text-anchor="middle" font-size="10" fill="#64748b">丢弃 p_i &lt; p_max × min_p 的 token</text>
  <line x1="320" y1="186" x2="320" y2="206" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="120" y="206" width="400" height="32" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="320" y="222" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">候选集</text>
  <text x="320" y="234" text-anchor="middle" font-size="10" fill="#64748b">大小随上下文自适应（通常几个到几百个）</text>
  <line x1="320" y1="238" x2="320" y2="258" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="160" y="258" width="320" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="320" y="273" text-anchor="middle" font-size="11" fill="#64748b">[可选] top-p 截断</text>
  <text x="320" y="284" text-anchor="middle" font-size="10" fill="#94a3b8">按累积概率进一步截断（top_p &lt; 1.0 时）</text>
  <line x1="320" y1="286" x2="320" y2="306" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="160" y="306" width="320" height="28" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="320" y="321" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">加权随机抽样</text>
  <text x="320" y="332" text-anchor="middle" font-size="10" fill="#64748b">按归一化概率  xorshift64 伪随机</text>
  <line x1="320" y1="334" x2="320" y2="354" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar14a)"/>
  <rect x="240" y="354" width="160" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/>
  <text x="320" y="376" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">token id</text>
</svg>
<span class="figure-caption">图 T14.1 ｜ min-p 采样流水线：temperature 缩放 → softmax → min-p 过滤 → 可选 top-p 截断 → 加权随机抽样</span>

<details>
<summary>ASCII 原版</summary>

```
logits (129280 维)
    |
    | temperature 缩放：logit / temperature
    v
scaled_logits
    |
    | softmax：p_i = exp(logit_i / T - max_logit/T) 后归一化
    v
概率分布 p (129280 维)
    |
    | min-p 过滤：丢弃 p_i < p_max * min_p 的 token
    v
候选集（大小随上下文自适应，通常几个到几百个）
    |
    | [若还开了 top-p] 按累积概率进一步截断
    v
最终候选集
    |
    | 按归一化概率抽样（xorshift64 伪随机）
    v
token id
```

</details>

min-p 相比 top-k/top-p 的优势在于**自适应**：当模型非常确定（概率集中在
1-2 个 token）时，候选集自然收缩为 1-2 个；当模型不确定（概率平铺在几十个
token）时，候选集同样自动扩展。这避免了固定 k 或固定 p 带来的"过窄"或
"过宽"问题。

**代码路径**：`ds4_session_sample`（`ds4.h:174`）直接委托给
`sample_top_p_min_p`（`ds4.c:15237`）：

```c
// ds4.c:15245
if (temperature <= 0.0f) return sample_argmax(logits, n_vocab);
// ...
if (top_k <= 0) return sample_full_vocab(logits, n_vocab, temperature, top_p, min_p, rng);
```

本 trace 中 `top_k = 0`，进入 `sample_full_vocab`（`ds4.c:15148`）。由于默认
`top_p = 1.0f`（不截累积概率），走快路径：

```c
// ds4.c:15169-15189  (top_p >= 1.0f 快路径，无需排序)
const float min_rel = min_p > 0.0f ? min_p : 0.0f;
for (uint32_t i = 0; i < n_vocab; i++) {
    const float p = expf((v - max_logit) / temperature);
    if (p < min_rel) continue;   // min-p 过滤：相对于 max_logit 的比例
    sum += p;
}
// 再扫一遍抽样
```

注意这里的 `min_rel` 即是 `min_p = 0.05f`，用的是**未归一化概率的比值**
（`expf((v - max_logit)/T) < min_p` 等价于 `p_i < p_max * min_p`）。整个过程
只扫两遍词表，O(vocab) 时间，无额外排序开销。

若 `top_p < 1.0f`（用户手动设置），则会先排序候选集，再截累积概率，代码见
`ds4.c:15207-15216`。

**temperature = 0 时走 argmax**：`run_sampled_generation` 中，若
`temperature <= 0`，`sample_top_p_min_p` 在第一行就 `return sample_argmax`；
此外 MTP 推测解码也只在 `temperature <= 0` 时生效（`ds4_cli.c:512`）。

**采样得到 token 后**：`run_sampled_generation` 检查是否是 EOS（`ds4_cli.c:508`），
若不是则调 `ds4_session_eval(session, token, ...)` 把该 token 喂回模型，
同时 `session.checkpoint` 追加该 token（即 `session.pos +1`）——这是步骤 15 的
起点。

## 6. 代码位置

按推荐阅读顺序：

- `ds4.h:172-174` —— `ds4_session_argmax` / `ds4_session_argmax_excluding` / `ds4_session_sample` 公开接口声明。
- `ds4.h:53-55` —— `DS4_DEFAULT_TEMPERATURE=1.0f`、`DS4_DEFAULT_MIN_P=0.05f`、`DS4_DEFAULT_TOP_P=1.0f` 默认常量。
- `ds4_cli.c:462` —— `run_sampled_generation`：采样循环入口，持有 temperature > 0 时的完整生成流程。
- `ds4_cli.c:505-507` —— 第一次调 `ds4_session_sample`，传入 temperature/top_p/min_p。
- `ds4.c:17638-17639` —— `ds4_session_sample` 实现：直接委托 `sample_top_p_min_p`。
- `ds4.c:15237` —— `sample_top_p_min_p`：temperature 分流、top_k 分流。
- `ds4.c:15148` —— `sample_full_vocab`：top_p=1.0 快路径（无排序 min-p 过滤 + 抽样）和 top_p<1.0 慢路径（排序+截断）。
- `ds4.c:15245` —— `temperature <= 0.0f` 时直接 `return sample_argmax`。
- `ds4_cli.c:512` —— `temperature <= 0` 且 MTP 可用时走推测解码分支。

## 7. 分支与延伸

- 采样完成后调用 `ds4_session_eval` 将采样 token 喂回模型、推进会话状态，
  这是 decode 步骤，参见
  [第 6 章 引擎与会话](06-engine-session.md)。
- temperature / min_p / top_p / top_k 在 CLI 解析时就已经定好，parse 路径和
  默认值来源，参见
  [第 1 章 架构总览](01-architecture-overview.md)。
- 服务器 API 场景下采样参数来自请求 JSON，`ds4_session_sample` 本身不变，改变
  的只是调用方，参见
  [第 13 章 HTTP 服务器与 Agent API](13-http-server-api.md)。
- `temperature <= 0` 时走 `ds4_session_argmax`，并且 MTP 推测解码（批量并行验证
  多个草稿 token）才会被激活，参见
  [第 12 章 推测解码与 MTP](12-speculative-mtp.md)。

## 8. 走完这一步你脑子里应该多了什么

1. **temperature 是执行路径的分叉**：`<= 0` 走确定性 argmax，`> 0` 走随机
   采样；本 trace 默认 temperature=1.0f，走采样路径。
2. **min-p 的自适应性**：以最高概率 token 为基准，只保留相对概率不低于 `min_p`
   倍的候选——模型越确定，候选集越小；模型越不确定，候选集自然扩大，无需人工
   调 k。
3. **top_p=1.0 时采样无需排序**：两遍线性扫描词表即可完成 min-p 过滤和加权
   抽样，O(vocab) 时间；只有 top_p<1.0 时才需排序。
4. **`ds4_session_sample` 只读 logits，不修改会话状态**：它返回一个 token id，
   会话 `pos` 的推进由后续的 `ds4_session_eval` 完成，两者职责分离。
5. 随机数生成器是 `uint64_t *rng` 传入的 xorshift64 状态，seed 由时间戳+进程ID
   初始化（`ds4_cli.c:501`），确保每次运行结果不同（除非手动固定 seed）。
