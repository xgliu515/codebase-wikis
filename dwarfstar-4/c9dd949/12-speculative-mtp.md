# 第 12 章：推测解码与 MTP

> 代码版本：antirez/ds4@c9dd949（2026-05-18）

---

## 目录

1. [MTP 是什么](#1-mtp-是什么)
2. [引擎级 MTP 接口](#2-引擎级-mtp-接口)
3. [推测解码的基本原理](#3-推测解码的基本原理)
4. [状态机全貌（`ds4.c:17782`）](#4-状态机全貌)
5. [第零步：免费验证 draft[0]](#5-第零步免费验证-draft0)
6. [自回归 MTP 草稿生成](#6-自回归-mtp-草稿生成)
7. [margin-skip 快速路径](#7-margin-skip-快速路径)
8. [验证器选择逻辑](#8-验证器选择逻辑)
9. [layer-major 验证器（`ds4.c:13712`）](#9-layer-major-验证器)
10. [精确 N=2 验证器（`ds4.c:13805`）](#10-精确-n2-验证器)
11. [Prefix-1 状态捕获与提交（`ds4.c:9039`、`16070`）](#11-prefix-1-状态捕获与提交)
12. [批量输出头（`ds4.c:10042`）](#12-批量输出头)
13. [贪心验证辅助函数（`ds4.c:12814`）](#13-贪心验证辅助函数)
14. [CLI 激活条件](#14-cli-激活条件)
15. [MTP raw cache 回滚](#15-mtp-raw-cache-回滚)
16. [调试环境变量](#16-调试环境变量)
17. [性能模型与权衡](#17-性能模型与权衡)

---

## 1. MTP 是什么

**MTP（Multi-Token Prediction）** 是 DeepSeek V4 Flash 模型原生携带的推测草稿头（draft head）。它不是一个独立的小语言模型，而是挂在目标模型最后一层之后的额外推理路径：使用目标模型已经计算好的隐状态 `h_t`，再经过一层轻量变换（embedding projection + 单 transformer 层）直接预测下一个 token（即 `t+1`）。

<svg viewBox="0 0 760 260" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="MTP module architecture: target model produces h_t which feeds the single MTP layer to draft the next token">
  <defs>
    <marker id="ar12-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar12-1m" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0d9488"/>
    </marker>
  </defs>
  <text x="30" y="28" font-size="12" font-weight="700" fill="currentColor">目标模型</text>
  <rect x="30" y="38" width="72" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="66" y="61" text-anchor="middle" font-size="11" fill="#64748b">token_t</text>
  <line x1="102" y1="56" x2="126" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="126" y="38" width="88" height="36" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="170" y="57" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">[0..42 层]</text>
  <text x="170" y="70" text-anchor="middle" font-size="10" fill="#64748b">transformer</text>
  <line x1="214" y1="56" x2="238" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="238" y="38" width="60" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="268" y="61" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">h_t</text>
  <line x1="298" y1="56" x2="322" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="322" y="38" width="96" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="370" y="57" text-anchor="middle" font-size="11" fill="#64748b">output_head</text>
  <text x="370" y="70" text-anchor="middle" font-size="10" fill="#94a3b8">lm_head</text>
  <line x1="418" y1="56" x2="442" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="442" y="38" width="72" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="478" y="57" text-anchor="middle" font-size="11" fill="#64748b">logits_t</text>
  <text x="478" y="70" text-anchor="middle" font-size="10" fill="#94a3b8">argmax</text>
  <line x1="514" y1="56" x2="538" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="538" y="38" width="90" height="36" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="583" y="61" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">token_{t+1}</text>
  <text x="30" y="138" font-size="12" font-weight="700" fill="currentColor">MTP 模块</text>
  <rect x="30" y="148" width="90" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="75" y="167" text-anchor="middle" font-size="11" fill="#7c3aed">h_t</text>
  <text x="75" y="180" text-anchor="middle" font-size="10" fill="#94a3b8">来自目标模型</text>
  <rect x="180" y="148" width="90" height="36" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="225" y="167" text-anchor="middle" font-size="11" fill="#7c3aed">token_{t+1}</text>
  <text x="225" y="180" text-anchor="middle" font-size="10" fill="#94a3b8">目标模型输出</text>
  <line x1="120" y1="166" x2="156" y2="166" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="270" y1="166" x2="295" y2="166" stroke="#94a3b8" stroke-width="1.2"/>
  <path d="M156,166 L156,200 L295,200 L295,166" fill="none" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="225" y1="200" x2="225" y2="218" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="160" y="218" width="130" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="225" y="236" text-anchor="middle" font-size="11" fill="#64748b">mtp_input_hc</text>
  <line x1="290" y1="232" x2="330" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="330" y="218" width="88" height="28" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="374" y="236" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">MTP 层 (×1)</text>
  <line x1="418" y1="232" x2="452" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="452" y="218" width="112" height="28" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="508" y="236" text-anchor="middle" font-size="11" fill="#64748b">mtp_output_head</text>
  <line x1="564" y1="232" x2="596" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-1)"/>
  <rect x="596" y="218" width="110" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="651" y="232" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">draft_{t+2}</text>
  <text x="651" y="243" text-anchor="middle" font-size="10" fill="#64748b">argmax</text>
  <line x1="268" y1="56" x2="268" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="268" y1="120" x2="75" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="75" y1="120" x2="75" y2="148" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar12-1)"/>
  <line x1="583" y1="74" x2="583" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="583" y1="120" x2="225" y2="120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="225" y1="120" x2="225" y2="148" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar12-1)"/>
</svg>
<span class="figure-caption">图 R12.1 ｜ MTP 模块架构：目标模型 42 层产出隐状态 h_t，MTP 仅用 1 层草稿头从 (h_t, token_{t+1}) 预测 draft_{t+2}</span>

<details>
<summary>ASCII 原版</summary>

```
目标模型：
  token_t → [0..42 层] → h_t → output_head → logits_t → argmax → token_{t+1}

MTP 模块：
  (h_t, token_{t+1}) → mtp_input_hc
      → [MTP 层] → mtp_output_hc
      → mtp_output_head → draft_logits → argmax → draft_{t+2}
```

</details>

MTP 的关键性质：
- **依赖目标模型的隐状态**：draft 质量随目标模型质量线性提升，比独立小模型更可靠
- **只有 1 个草稿层**：延迟极低，适合 N=2 深度
- **草稿与目标共享 KV cache**：draft 运行在自己的小 raw SWA ring（`g->mtp_raw_cache`），不污染目标模型的 KV cache

---

## 2. 引擎级 MTP 接口

`ds4.h` 暴露的 MTP 相关 API：

```c
// ds4.h:187-188
bool ds4_engine_has_mtp(ds4_engine *e);
int  ds4_engine_mtp_draft_tokens(ds4_engine *e);

// ds4.h:64-74（ds4_engine_options 成员）
const char *mtp_path;         // MTP 模型 GGUF 路径（NULL 则不启用）
int         mtp_draft_tokens; // 最大草稿深度（默认 1，1 即禁用推测）
float       mtp_margin;       // confidence margin 阈值（默认 3.0）
```

会话级的推测解码入口（`ds4.h:178`）：

```c
int ds4_session_eval_speculative_argmax(
        ds4_session *s,
        int first_token,          // 刚产出的目标 token
        int max_tokens,           // 本次最多提交 token 数
        int eos_token,
        int *accepted,            // 输出：被接受的 token 序列
        int  accepted_cap,        // accepted 数组容量
        char *err, size_t errlen);
// 返回值：接受的 token 数（>=1），或 -1 表示失败
```

---

## 3. 推测解码的基本原理

推测解码的标准算法：

```text
1. draft model 生成 D 个 draft token：d_1, d_2, ..., d_D
2. target model 并行验证所有 D 个位置
3. 找到第一个不匹配的位置 k：
     若 target[i] == d_i 对所有 i <= k，则接受 d_1..d_k 并继续
     若 target[1] != d_1，则只接受 target[1]
4. 无论如何，都从 target model 的输出分布中采样/argmax 得到确定的续接 token
```

ds4 实现的约束条件：
- 只支持 **argmax（贪心）** 验证（`temperature <= 0`）：这是推测解码正确性最容易保证的情况
- 默认草稿深度 **N=2**（`mtp_draft_tokens=2`），因为 MTP 只有 1 层，更深的草稿需要递归调用 MTP 自身
- target model 与 draft model 是**同一个模型体**加不同的输出头，不存在分布不匹配

---

## 4. 状态机全貌

`ds4.c:17782` 处的注释精确描述了四步状态机：

```c
/* Speculative decode state machine:
 * 1. commit the normal target token and use its logits to validate draft[0];
 * 2. let MTP recursively draft a tiny suffix from its own raw-cache frontier;
 * 3. verify the suffix with the target graph, committing only the accepted
 *    prefix and rolling back speculative Metal state on miss;
 * 4. fall back to ordinary one-token decode if the fast verifier cannot prove
 *    the target stream. */
```

函数入口：

```c
int ds4_session_eval_speculative_argmax(
        ds4_session *s, int first_token, int max_tokens, int eos_token,
        int *accepted, int accepted_cap, char *err, size_t errlen) {

    // 步骤 1：先正常提交 first_token，得到 base logits
    if (ds4_session_eval(s, first_token, err, errlen) != 0) return -1;
    accepted[n_accept++] = first_token;

    // 若 MTP 未就绪或 draft_tokens<=1，退回单 token 路径
    if (!e->mtp_ready || !s->mtp_draft_valid || e->mtp_draft_tokens <= 1)
        return n_accept;

    // 步骤 2：从 base logits 验证 draft[0]（免费），再自回归生成 draft[1..]
    // 步骤 3：layer-major 或 exact-N=2 验证器
    // 步骤 4：失败时返回已接受的 n_accept（至少是 1）
}
```

整个函数确保返回值 `>= 1`：即使推测完全失败，`first_token` 已经被正常提交并接受。

---

## 5. 第零步：免费验证 draft[0]

`ds4_session_eval(s, first_token)` 调用后，`s->logits` 已经包含了目标模型在 `first_token` 之后的完整词表分布。此时无需任何额外计算，直接 argmax：

```c
// ds4.c:17860
if (sample_argmax(s->logits, DS4_N_VOCAB) != drafts[0]) {
    // draft[0] 不匹配：草稿无效，直接返回
    return n_accept;   // n_accept == 1
}
```

这是推测解码的"免费验证"：draft[0] 是 MTP 在上一轮 decode 中预测的 token，而目标模型刚好已经产出了验证所需的 logits。只有 draft[0] 通过验证，才值得继续生成更深的草稿。

---

## 6. 自回归 MTP 草稿生成

draft[0] 验证通过后，循环调用 MTP 生成 draft[1]..draft[N-1]（`ds4.c:17880`）：

```c
for (; draft_n < draft_cap; draft_n++) {
    ds4_gpu_tensor *prev_hc = (draft_n & 1) ? s->graph.mtp_state_hc : s->graph.mtp_next_hc;
    ds4_gpu_tensor *out_hc  = (draft_n & 1) ? s->graph.mtp_next_hc  : s->graph.mtp_state_hc;

    int mtp_top = -1;
    if (!metal_graph_eval_mtp_draft_from_hc(&s->graph, ...,
                                             prev_hc, out_hc,
                                             drafts[draft_n - 1],
                                             s->checkpoint.len + draft_n - 1,
                                             mtp_need_logits ? s->mtp_logits : NULL,
                                             &mtp_top))
        return n_accept;

    drafts[draft_n] = mtp_top >= 0 ? mtp_top : sample_argmax(s->mtp_logits, DS4_N_VOCAB);
    if (drafts[draft_n] == eos_token) { draft_n++; break; }
}
```

MTP 有自己独立的 raw SWA cache（`g->mtp_raw_cache`，`g->mtp_n_raw`），与目标模型的 `layer_raw_cache` 完全分离。draft 生成时写入 MTP raw cache；验证通过的 token 对应的行保留，未通过的行"逻辑失效"（通过减小 `mtp_n_raw` 计数器，而不是物理清除——下一轮草稿会覆盖这些槽位）。

---

## 7. Margin-skip 快速路径

当 `strict_mtp == false`（非 `--quality` 模式）且 `draft_n == 2` 时，引擎先检查 MTP 对 draft[1] 的置信度（`ds4.c:17911`）：

```c
if (!strict_mtp && draft_n == 2 && mtp_margin_threshold > 0.0f) {
    float v0, v1;
    logits_top2(s->mtp_logits, DS4_N_VOCAB, &top0, &v0, &top1, &v1);
    float margin = v0 - v1;  // top-1 与 top-2 logit 差值

    if (margin < mtp_margin_threshold) {
        // MTP 对 draft[1] 不自信：直接用目标模型做单 token decode
        // 跳过昂贵的 N=2 batch 验证
        metal_graph_eval_token_raw_swa(&s->graph, ..., drafts[0], start, ...);
        accepted[n_accept++] = drafts[0];
        return n_accept;
    }
}
```

**为什么有效**：当 MTP 的 top-1/top-2 logit 差值（margin）小于阈值 `mtp_margin`（默认 3.0），说明模型对 draft[1] 非常不确定，继续验证概率低且代价高。此时提前退出，省去一次 batch verify kernel launch。`DS4_MTP_CONF_LOG` 环境变量可记录每次推测的 margin 值。

---

## 8. 验证器选择逻辑

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Verifier selection decision tree: exact N=2 verifier vs layer-major batch verifier based on draft_n and strict_mtp flags">
  <defs>
    <marker id="ar12-2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="16" width="300" height="56" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="38" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">验证器选择</text>
  <text x="380" y="56" text-anchor="middle" font-size="11" fill="#64748b">draft_n == 2 且 strict_mtp 且 无 DS4_MTP_BATCH_VERIFY？</text>
  <line x1="280" y1="72" x2="160" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <text x="198" y="104" text-anchor="middle" font-size="11" fill="#16a34a" font-weight="600">是</text>
  <line x1="480" y1="72" x2="600" y2="120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-2)"/>
  <text x="562" y="104" text-anchor="middle" font-size="11" fill="#64748b" font-weight="600">否</text>
  <rect x="30" y="120" width="260" height="72" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="160" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="#16a34a">精确 N=2 验证器</text>
  <text x="160" y="159" text-anchor="middle" font-size="10" fill="#64748b">metal_graph_verify_decode2_exact</text>
  <text x="160" y="175" text-anchor="middle" font-size="10" fill="#64748b">与逐 token decode 完全一致</text>
  <text x="160" y="188" text-anchor="middle" font-size="10" fill="#94a3b8">速度略低于批量版</text>
  <rect x="470" y="120" width="260" height="72" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="600" y="142" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">layer-major 批量验证器</text>
  <text x="600" y="159" text-anchor="middle" font-size="10" fill="#64748b">metal_graph_verify_suffix_tops</text>
  <text x="600" y="175" text-anchor="middle" font-size="10" fill="#64748b">draft_n &gt; 2 或非 strict 模式</text>
  <text x="600" y="188" text-anchor="middle" font-size="10" fill="#94a3b8">速度快，极少数 tied logit 可能不同</text>
</svg>
<span class="figure-caption">图 R12.2 ｜ 验证器选择逻辑：draft_n==2 且 strict 模式走精确 N=2 验证器，否则走 layer-major 批量验证器</span>

<details>
<summary>ASCII 原版</summary>

```
draft_n == 2 且 strict_mtp 且 无 DS4_MTP_BATCH_VERIFY
    → metal_graph_verify_decode2_exact（精确 N=2 验证器）

否则（draft_n > 2 或非 strict 模式）
    → metal_graph_verify_suffix_tops（layer-major 批量验证器）
```

</details>

核心权衡（`ds4.c:17954-17961`）：

```c
/* The useful N=2 verifier is the tiny batch path: it verifies two target
 * positions in one layer-major pass and commits prefix-1 directly on a
 * partial accept.  Like the rest of the non-quality Metal path, it may pick
 * a different greedy token when batched reductions perturb nearly-tied
 * logits.  --quality / DS4_MTP_STRICT selects the exact decode verifier,
 * which preserves the one-token target stream but is not a speed win. */
```

即：
- **layer-major 批量验证器**：速度快，但极少数情况下 batch reduce 的浮点舍入会改变 tied logit 的排序，产生与逐 token decode 不完全相同的输出（不影响生成质量，只影响严格可重现性）
- **精确 N=2 验证器**：保持与逐 token decode 完全相同的输出，但由于使用单独的 command stream 逐层编码两个 token，速度不如批量版

---

## 9. Layer-major 验证器

`metal_graph_verify_suffix_tops`（`ds4.c:13712`）使用已有的 prefill batch kernels 对整个草稿序列做一次 layer-major forward：

```c
static bool metal_graph_verify_suffix_tops(
        ds4_gpu_graph *g, ...,
        uint32_t start, uint32_t n_tokens,
        bool capture_prefix1,
        int *row_tops, float *row_logits) {

    metal_graph_upload_prompt_tokens(g->prefill_tokens, prompt, start, n_tokens);
    metal_graph_upload_prompt_embeddings_hc(g->batch_cur_hc, ..., start, n_tokens);

    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        ds4_gpu_begin_commands();
        metal_graph_encode_layer_batch(g, model, &weights->layer[il],
                                       il, start, n_tokens);
        ds4_gpu_end_commands();
    }

    // 批量输出头：计算所有行的 top-1，只读取最后一行完整 logits
    metal_graph_encode_output_head_batch(g, model, weights, n_tokens, vocab_dim);

    // row_tops[0..n_tokens-2]：各行 top-1 id
    // row_logits：最后一行完整 logits（用于继续生成）
    for (uint32_t r = 0; r < top_rows; r++)
        ds4_gpu_tensor_read(spec_tops_row_view, 0, &row_tops[r], sizeof(int));
    if (row_logits)
        ds4_gpu_tensor_read(spec_last_logits, 0, row_logits, vocab_size_bytes);
}
```

验证逻辑（`ds4.c:18094`）：

```c
int commit_drafts = 1;
for (int i = 1; i < draft_n; i++) {
    if (row_tops[i - 1] != drafts[i]) break;
    commit_drafts++;
}
```

即：从 position `start` 开始，目标模型在每个位置的 top-1 必须等于下一个草稿 token，才能继续接受。

---

## 10. 精确 N=2 验证器

`metal_graph_verify_decode2_exact`（`ds4.c:13805`）是专为 N=2 场景设计的高保真验证器：

```c
static bool metal_graph_verify_decode2_exact(
        ds4_gpu_graph *g, ...,
        int token0, int token1, uint32_t start,
        int *top0, float *logits0, float *logits1) {

    // 嵌入两个 token 到 batch_cur_hc 的 row 0 和 row 1
    ds4_gpu_embed_token_hc_tensor(cur0, ..., token0, ...);
    ds4_gpu_embed_token_hc_tensor(cur1, ..., token1, ...);

    g->spec_capture_prefix1 = true;
    ds4_gpu_begin_commands();
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        uint32_t pos0 = start, pos1 = start + 1;

        // token0 经过层 il（使用 decode kernel，精确语义）
        g->cur_hc = cur0; g->after_ffn_hc = next0;
        metal_graph_encode_decode_layer(g, ..., il, pos0, ..., token0);

        // 在 token0 之后捕获 prefix-1 compressor state
        metal_graph_capture_prefix1_attn_state(g, il);
        metal_graph_capture_prefix1_index_state(g, il);

        // token1 经过层 il（紧接 token0 之后，使用相同 decode kernel）
        g->cur_hc = cur1; g->after_ffn_hc = next1;
        metal_graph_encode_decode_layer(g, ..., il, pos1, ..., token1);
    }
    ds4_gpu_end_commands();

    // 分别产出 token0 和 token1 的输出头（两次单独 command buffer）
    // top0 = argmax(logits after token0)，logits1 = full logits after token1
}
```

关键设计：
- 两个 token 在**同一个命令流**内逐层处理，层间无同步点，避免 N=2 变成 2 次单独 decode 的开销
- 每层先处理 token0 再处理 token1，保证 KV cache 写入顺序与串行 decode 完全一致（token1 能看到 token0 的 KV）
- `spec_capture_prefix1 = true` 触发每层在处理完 token0 后立即保存 compressor frontier

---

## 11. Prefix-1 状态捕获与提交

### 11.1 捕获（`ds4.c:9039`）

`metal_graph_capture_prefix1_attn_state` 在 N=2 验证器的每层循环内调用（token0 之后）：

```c
static bool metal_graph_capture_prefix1_attn_state(ds4_gpu_graph *g, uint32_t il) {
    if (!g->spec_capture_prefix1 || !g->spec_prefix1_attn_state_kv[il]) return true;

    g->spec_prefix1_n_comp[il] = g->layer_n_comp[il];  // 保存 CPU 侧计数器
    return ds4_gpu_tensor_copy(g->spec_prefix1_attn_state_kv[il], 0,
                               g->layer_attn_state_kv[il], 0, bytes) != 0 &&
           ds4_gpu_tensor_copy(g->spec_prefix1_attn_state_score[il], 0,
                               g->layer_attn_state_score[il], 0, bytes) != 0;
}
```

对于 ratio-4 indexer 层，`metal_graph_capture_prefix1_index_state` 同理保存 indexer compressor state（`ds4.c:9063`）。

**为什么只捕获 compressor state 而不捕获 raw cache**：raw SWA ring 的容量远大于逻辑 128-token 窗口，写入 token1 的投机行不会驱逐 token0 可见的 raw 行。只有 compressor frontier（小 state 张量 + 行计数器）需要回滚（`ds4.c:9039-9061` 注释）。

### 11.2 提交（`ds4.c:16070`）

当 N=2 验证结果为"只接受 token0"时，调用 `spec_frontier_commit_prefix1`：

```c
static bool spec_frontier_commit_prefix1(ds4_session *s) {
    ds4_gpu_graph *g = &s->graph;
    bool ok = ds4_gpu_begin_commands() != 0;
    for (uint32_t il = 0; il < DS4_N_LAYER; il++) {
        const uint32_t ratio = ds4_layer_compress_ratio(il);
        if (ratio == 0) continue;

        g->layer_n_comp[il] = g->spec_prefix1_n_comp[il];   // 恢复 CPU 计数器
        // 恢复 GPU 侧 compressor KV 和 score（设备到设备拷贝）
        ok = ds4_gpu_tensor_copy(g->layer_attn_state_kv[il], 0,
                                 g->spec_prefix1_attn_state_kv[il], 0, ab) != 0 &&
             ds4_gpu_tensor_copy(g->layer_attn_state_score[il], 0,
                                 g->spec_prefix1_attn_state_score[il], 0, ab) != 0;
        if (ratio == 4) {
            g->layer_n_index_comp[il] = g->spec_prefix1_n_index_comp[il];
            // 同理恢复 index_state
        }
    }
    return ok && ds4_gpu_end_commands();
}
```

这避免了"部分接受时重新 replay 一个 token"的开销——只需用已经保存好的 prefix-1 快照覆盖当前状态，代价是 43 层的 device-to-device 内存拷贝（每层只有小 state 张量，通常远小于完整 KV cache）。

---

## 12. 批量输出头

`metal_graph_encode_output_head_batch`（`ds4.c:10042`）是为验证器专设的输出头：

```c
/* A target verifier only needs top-1 ids for intermediate draft rows and
 * full logits for the last accepted row.  Running the normal one-row output
 * head in a loop serializes the HC collapse, output norm, and Q8 vocab
 * projection.  For tiny MTP suffixes we instead process all rows together
 * and let the GPU reduce each row to a top id; the CPU reads back just
 * those ids plus the last row's logits needed to continue the exact target
 * stream. */
```

实现策略：

<svg viewBox="0 0 880 340" xmlns="http://www.w3.org/2000/svg" class="figure-svg wide" role="img" aria-label="Batch output head pipeline: from batch_cur_hc through 6 GPU kernels to spec_tops and final logits">
  <defs>
    <marker id="ar12-3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="20" width="116" height="44" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="68" y="38" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">batch_cur_hc</text>
  <text x="68" y="54" text-anchor="middle" font-size="10" fill="#64748b">n_tokens × N_HC</text>
  <line x1="126" y1="42" x2="148" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="148" y="20" width="132" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="214" y="36" text-anchor="middle" font-size="10" fill="#64748b">rms_norm_plain_rows</text>
  <text x="214" y="54" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="280" y1="42" x2="302" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="302" y="20" width="116" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="360" y="38" text-anchor="middle" font-size="11" fill="#64748b">batch_flat_hc</text>
  <text x="360" y="54" text-anchor="middle" font-size="10" fill="#94a3b8">n_tokens × N_HC</text>
  <line x1="418" y1="42" x2="440" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="440" y="20" width="140" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="510" y="36" text-anchor="middle" font-size="10" fill="#64748b">matmul_f16 output_hc_fn</text>
  <text x="510" y="54" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="580" y1="42" x2="602" y2="42" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="602" y="20" width="116" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="660" y="38" text-anchor="middle" font-size="11" fill="#64748b">output_pre</text>
  <text x="660" y="54" text-anchor="middle" font-size="10" fill="#94a3b8">n_tokens × N_HC</text>
  <line x1="660" y1="64" x2="660" y2="94" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="598" y="94" width="124" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="660" y="111" text-anchor="middle" font-size="10" fill="#64748b">output_hc_weights_batch</text>
  <text x="660" y="127" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="598" y1="116" x2="570" y2="116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="448" y="94" width="122" height="44" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="509" y="111" text-anchor="middle" font-size="11" fill="#64748b">output_weights</text>
  <text x="509" y="127" text-anchor="middle" font-size="10" fill="#94a3b8">n_tokens × N_HC</text>
  <line x1="509" y1="138" x2="509" y2="166" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="68" y1="64" x2="68" y2="180" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="68" y1="180" x2="370" y2="180" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <text x="160" y="174" font-size="10" fill="#94a3b8">batch_cur_hc</text>
  <line x1="509" y1="166" x2="420" y2="180" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="370" y1="180" x2="420" y2="180" stroke="#94a3b8" stroke-width="1.2"/>
  <rect x="330" y="168" width="172" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="416" y="184" text-anchor="middle" font-size="10" fill="#64748b">hc_weighted_sum_batch</text>
  <text x="416" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="330" y1="186" x2="302" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="180" y="168" width="122" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="241" y="184" text-anchor="middle" font-size="11" fill="#64748b">output_embd</text>
  <text x="241" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">n_tokens × N_EMBD</text>
  <line x1="180" y1="186" x2="158" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="30" y="168" width="128" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="94" y="184" text-anchor="middle" font-size="10" fill="#64748b">rms_norm_weight_rows</text>
  <text x="94" y="198" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="94" y1="204" x2="94" y2="228" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="30" y="228" width="128" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="94" y="244" text-anchor="middle" font-size="11" fill="#64748b">output_norm</text>
  <text x="94" y="257" text-anchor="middle" font-size="10" fill="#94a3b8">n_tokens × N_EMBD</text>
  <line x1="158" y1="246" x2="186" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="186" y="228" width="140" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="256" y="244" text-anchor="middle" font-size="10" fill="#64748b">matmul_q8_0_batch</text>
  <text x="256" y="257" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="326" y1="246" x2="352" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="352" y="228" width="122" height="36" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="413" y="244" text-anchor="middle" font-size="11" font-weight="600" fill="#0d9488">spec_logits</text>
  <text x="413" y="257" text-anchor="middle" font-size="10" fill="#64748b">n_tokens × N_VOCAB</text>
  <line x1="474" y1="246" x2="502" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="502" y="228" width="148" height="36" rx="5" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="576" y="244" text-anchor="middle" font-size="10" fill="#64748b">indexer_topk (k=1, per row)</text>
  <text x="576" y="257" text-anchor="middle" font-size="10" fill="#94a3b8">kernel</text>
  <line x1="650" y1="246" x2="676" y2="246" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar12-3)"/>
  <rect x="676" y="228" width="122" height="36" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="737" y="244" text-anchor="middle" font-size="11" font-weight="700" fill="#ea580c">spec_tops</text>
  <text x="737" y="257" text-anchor="middle" font-size="10" fill="#64748b">n_tokens 个 int32</text>
  <text x="440" y="306" text-anchor="middle" font-size="11" fill="#64748b">CPU 仅读取 spec_tops[0..n-2] 和 spec_logits[n-1]（最后行完整 logits），共 2 次 readback</text>
</svg>
<span class="figure-caption">图 R12.3 ｜ 批量输出头流水线：batch_cur_hc 经 6 个 GPU kernel 得到 spec_tops（每行 top-1 id）和最后行完整 logits</span>

<details>
<summary>ASCII 原版</summary>

```
n_tokens 行的 batch_cur_hc → [rms_norm_plain_rows] → batch_flat_hc
batch_flat_hc → [matmul_f16 output_hc_fn] → output_pre（n_tokens × N_HC）
output_pre → [output_hc_weights_batch] → output_weights（n_tokens × N_HC）
(batch_cur_hc, output_weights) → [hc_weighted_sum_batch] → output_embd（n_tokens × N_EMBD）
output_embd → [rms_norm_weight_rows] → output_norm（n_tokens × N_EMBD）
output_norm → [matmul_q8_0_batch] → spec_logits（n_tokens × N_VOCAB）
spec_logits → [indexer_topk with k=1, per row] → spec_tops（n_tokens 个 int32）
```

</details>

CPU 读取 `spec_tops[0..n_tokens-2]`（每行 top-1）和 `spec_logits[n_tokens-1]`（最后行完整 logits），只需两次 `ds4_gpu_tensor_read`，而不是 N 次单独输出头的 N × `N_VOCAB * sizeof(float)` 读取。

---

## 13. 贪心验证辅助函数

`metal_graph_eval_token_raw_swa_top`（`ds4.c:12814`，函数注释说明）：

```c
/* Greedy verifier helper.  Speculative decoding only needs the target model's
 * top token after most accepted draft rows; the full vocabulary row is needed
 * once, for the final committed state that normal sampling will continue from.
 * Keeping intermediate rows device-resident avoids turning verification into a
 * sequence of large CPU readbacks. */
static bool metal_graph_eval_token_raw_swa_top(
        ds4_gpu_graph *g, ...,
        int token, uint32_t pos,
        int *top_id, float *logits) {

    ds4_gpu_begin_commands();
    metal_graph_encode_token_raw_swa(g, ..., token, pos, true, true);
    // 在 GPU 上直接 top-k(1)，只读回 1 个 int32
    ds4_gpu_indexer_topk_tensor(g->comp_selected, g->logits, DS4_N_VOCAB, 1, 1);
    ds4_gpu_end_commands();
    ds4_gpu_tensor_read(g->comp_selected, 0, top_id, sizeof(*top_id));
    if (logits)
        ds4_gpu_tensor_read(g->logits, 0, logits, N_VOCAB * sizeof(float));
}
```

这个函数在 margin-skip 路径（`ds4.c:17921`）使用：当 margin 不足时，用它做单 token decode + top-1 提取，避免读回完整 logits 数组。

---

## 14. CLI 激活条件

`ds4_cli.c:512-521`（生成循环）：

```c
if (cfg->gen.temperature <= 0.0f
    && ds4_engine_mtp_draft_tokens(engine) > 1
    && getenv("DS4_MTP_SPEC_DISABLE") == NULL) {

    ntok = ds4_session_eval_speculative_argmax(session,
                                               token,
                                               max_tokens - generated,
                                               ds4_token_eos(engine),
                                               toks, sizeof(toks)/sizeof(toks[0]),
                                               err, sizeof(err));
} else {
    ds4_session_eval(session, token, err, sizeof(err));
    toks[0] = token; ntok = 1;
}
```

激活推测解码的**三个必要条件**：
1. `temperature <= 0`（贪心采样）
2. `mtp_draft_tokens > 1`（需要 `--mtp FILE --mtp-draft N`，N≥2）
3. 环境变量 `DS4_MTP_SPEC_DISABLE` 未设置

条件 1 是正确性保证：推测解码当前只实现了 argmax 验证（非采样验证需要拒绝采样，实现更复杂）。条件 2 确保 MTP 模型已加载。

相同逻辑在 `ds4_cli.c:974`（chat 循环）中重复使用。

---

## 15. MTP raw cache 回滚

MTP 模块有自己的 raw SWA cache（`g->mtp_raw_cache`，大小 = `raw_window`）。草稿生成写入未来槽位，验证后通过 `DS4_MTP_KEEP_ACCEPTED(n)` 宏调整 `mtp_n_raw`：

```c
#define DS4_MTP_KEEP_ACCEPTED(n_) do { \
    uint32_t keep_ = mtp_base_raw + (uint32_t)(n_); \
    if (keep_ > s->graph.raw_window) keep_ = s->graph.raw_window; \
    s->graph.mtp_n_raw = keep_; \
} while (0)
```

不同结果对应的 `keep_` 值：

| 接受情况 | `DS4_MTP_KEEP_ACCEPTED(n)` | 效果 |
|----------|---------------------------|------|
| 全部接受 N=2 | `(2)` | MTP raw 窗口前进 2 行 |
| 只接受 token0 | `(1)` | MTP raw 窗口前进 1 行，token1 的行逻辑失效 |
| 无草稿（单 token 回退） | `(1)` | 同上 |

由于 raw cache 是环形，逻辑失效的槽位在下一轮草稿生成时会被覆盖，不需要清零。

---

## 16. 调试环境变量

| 环境变量 | 说明 |
|----------|------|
| `DS4_MTP_SPEC_DISABLE` | 完全禁用推测解码，即使条件满足 |
| `DS4_MTP_STRICT` | 强制 strict 模式（等同 `--quality`），即使非 quality build |
| `DS4_MTP_BATCH_VERIFY` | 强制用 layer-major 批量验证器，即使 `strict_mtp=true` |
| `DS4_MTP_CAPTURE_PREFIX1` | 在非 strict 模式下也强制捕获 prefix-1 state（用于测量对比） |
| `DS4_MTP_TIMING` | 打印 draft/snapshot/verify 各阶段耗时 |
| `DS4_MTP_CONF_LOG` | 打印每次推测的 drafted/committed/margin/top-1/top-2 |
| `DS4_MTP_MIN_MARGIN` | 覆盖 margin-skip 阈值（float） |
| `DS4_MTP_SPEC_LOG` | 打印 first draft miss 和 decode2 verifier fallback 日志 |
| `DS4_MTP_FULL_LOGITS` | 强制读取完整 MTP logits（即使只需要 top-1） |
| `DS4_MTP_EXACT_REPLAY` | 验证后用精确逐 token replay 替代 batch 接受（调试一致性用） |
| `DS4_MTP_FORCE_SNAPSHOT` | 强制在批量验证前拍 compressor 快照 |

---

## 17. 性能模型与权衡

```text
理想情况（全部接受 N=2）：
  成本 = 1× target decode + 1× MTP draft + 1× N=2 verify
  产出 = 2 tokens
  加速比 ≈ 2 × (target_decode / (target_decode + mtp_draft + verify))

实际加速条件：
  verify 成本 ≈ prefill(2 token) ≈ 2 × target_decode / throughput_ratio
  MTP draft 成本 << target decode（只有 1 层）
  → 当 N=2 verify 比 1× 额外 target decode 快时，净收益为正
```

MTP 只有在以下情况下净收益为正：
- batch prefill 效率远高于逐 token decode（即 prefill(2) < decode(1)），这在大型模型的 MoE FFN 层上通常成立（路由专家可以 batch 覆盖）
- draft 接受率高（通常 >70%，因为 MTP 与目标模型共享权重）
- margin-skip 正确过滤掉低置信度草稿，避免无谓的验证开销

CLI 默认 `mtp_margin=3.0`（`ds4_cli.c:1196`）是经验调优值，在实践中过滤约 20-30% 的低置信度草稿。

---

## 相关章节

- [第 10 章：Metal 后端](10-metal-backend.md) —— `metal_graph_encode_decode_layer`、`metal_graph_verify_suffix_tops`、`metal_graph_verify_decode2_exact` 的实现细节
- [第 11 章：CUDA 后端](11-cuda-backend.md) —— 推测解码在 CUDA 路径下透明运行，`ds4_session_eval_speculative_argmax` 不区分后端
