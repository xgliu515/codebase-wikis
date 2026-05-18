# Trace 步骤 08 —— 正式算之前，prefill 还要先决定两件事

## 1. 当前情境

步骤 07 结束后，`ds4_session` 已建好，`session_sync` 判定当前 checkpoint 为空，
需要走全量 prefill。控制权回到 `ds4_session_sync`（`ds4.c:17415`）。

此刻内存里的状态：

```
s->checkpoint_valid = false          // 没有可复用的历史
s->prefill_cap      = N              // 尚未向你展示 N 是多少
s->graph.raw_cap    = M              // 同上
prompt              = [BOS, "你", "好", <|Assistant|>...]   // 步骤 06 产出
```

`ds4_session_sync` 接下来要做两件独立但都必须在正式前向开始前完成的事：

1. **决定 prefill ubatch 大小**：一次最多把多少个 token 一起喂进模型。
2. **把 HC 多流状态从 token 嵌入向量种子**：每条 HC 流用同一个 token embedding
   初始化，此后每过一个子层就各自演化。

这两件事在代码层面发生在调用 `metal_graph_prefill_raw_swa`（`ds4.c:13483`）或
`metal_graph_prefill_chunked`（`ds4.c:13688`）之前，由 `ds4_session_create`
（`ds4.c:17308`）和 `metal_graph_prefill_layer_major`（`ds4.c:13224`）分工完成。

---

## 2. 问题

这一步要解决两个具体问题：

**问题 A：prefill 要分几块？**
整批 prompt 一次喂进去最简单，但 Metal 的 GPU 命令缓冲区大小、内存临时张量大小、
macOS watchdog 超时都对单次 batch 有上限。`prefill_cap` 就是这个"一次最多多少行"
的预算。在我们的 trace 里，「你好」加 BOS 和 assistant 前缀只有个位数 token，
完全不是问题；但若 prompt 有几千 token，必须分块。

**问题 B：HC 流从哪里来？**
DwarfStar 4 的每个 token 带 4 条超连接流（`DS4_N_HC = 4`，`ds4.c:107`），每条
流都是 4096 维的激活向量（`DS4_N_EMBD = 4096`，`ds4.c:88`）。层与层之间的残差
不是一个 4096 维向量，而是 4 条并行的 4096 维向量。那么第 0 层开始算之前，这
4 × 4096 的张量怎么初始化？

---

## 3. 朴素思路

对 **问题 A**：把 prefill_cap 设成 ctx_size（最大上下文窗口）。任何 prompt 都
不会超过上下文窗口，所以一次肯定吃得下，绝不分块，最简单。

对 **问题 B**：既然超连接是网络里的一个新概念，也许每条流应该用不同的随机向量
初始化，让它们从一开始就各有"分工"。或者，也可以全部初始化为零。

---

## 4. 为什么朴素思路会崩

**问题 A 的朴素方案：prefill_cap = ctx_size**

`ctx_size` 默认 32768。`prefill_cap` 直接决定了 GPU 上的临时张量大小——
`batch_cur_hc` 和 `batch_next_hc` 各是 `prefill_cap × DS4_N_HC × DS4_N_EMBD`
个浮点数（`ds4.c:8678`）。设为 32768 时：

```
32768 × 4 × 4096 × 4 字节 = 2 GiB  （仅 cur_hc 一张）
```

两张就是 4 GiB，而 MacBook 的统一内存通常是 16-36 GiB，全被 prefill 临时张量
吃掉根本运行不了。实际上大多数 prompt 都不超过 2048 token，为最坏情况分配
16× 内存是极大的浪费。

此外，macOS 对单次 Metal 命令缓冲区有 watchdog 超时，一次喂入 32768 行的
attention 计算可能触发 WindowServer 看门狗（`ds4.c:13242`-13247 的注释明确提到
这个问题）。

**问题 B 的朴素方案：随机初始化或全零**

超连接流在第一个子层（attention pre）会乘以学好的 `hc_attn_fn` 变换矩阵并与
`token_embd` 混合（`ds4.c:4389`）。如果流初始为全零，混合后的贡献为零，等效于
抛弃了超连接机制；如果初始为随机，推理结果将在每次调用中不一致（不确定性）。
超连接的设计意图是用多条残差流携带「不同视角的激活」，它们的初始内容应当来自
模型真正知道的信息：当前 token 的语义嵌入。

---

## 5. DwarfStar 4 的做法

### A：按 prompt 长度自适应选 prefill_cap

```text
prompt_len <= 2048  =>  prefill_cap = prompt_len  （整批一次吃完）
prompt_len >  2048  =>  prefill_cap = 2048         （固定分块）
环境变量 DS4_METAL_PREFILL_CHUNK 可覆盖            （调试/调优）
```

这条规则在 `ds4_default_prefill_cap_for_prompt`（`ds4.c:6184`）里：

```c
} else if (prompt_len > 2048) {
    cap = 2048u;
}
```

对我们的 trace，「你好」分词后总长度是个位数（远小于 2048），所以
`prefill_cap = prompt_len`，一个 ubatch 吃完，不需要分块路径。

raw SWA 缓存大小（`raw_cap`）也在 `ds4_session_create` 阶段一并算好：
`metal_graph_raw_cap_for_context`（`ds4.c:13944`）要求 raw_cap 至少能容纳
SWA 窗口（`DS4_N_SWA = 128`）加上一个 prefill_cap，并对齐到 256 行：

```text
raw_cap = align_up(raw_window + prefill_cap, 256)
        ≤ 8192   （硬上限）
```

这两个值都在 `ds4_session_create`（`ds4.c:17329`-17330）里算出并写入
`s->prefill_cap` 和 `s->graph.raw_cap`，后续步骤直接使用。

### B：用 token embedding 把每条 HC 流种子到同一向量

CPU 路径（`ds4.c:7791`-7793）：

```c
for (uint64_t t = 0; t < n_tok; t++) {
    embed_token_f16(model, weights, prompt->v[t], plain);   // 查 F16 嵌入表
    hc_from_plain_embedding(cur + t * hc_dim, plain, DS4_N_EMBD, DS4_N_HC);
}
```

`hc_from_plain_embedding`（`ds4.c:4429`）把同一个 4096 维嵌入向量复制给所有 4
条 HC 流：

```c
for (uint32_t h = 0; h < n_hc; h++) {
    memcpy(out_hc + (uint64_t)h * n_embd, x, n_embd * sizeof(x[0]));
}
```

Metal 路径则对应 `metal_graph_upload_prompt_embeddings_hc`（`ds4.c:11003`）。当
token 数量不足 512（`gpu_min = 512`）时，走 CPU 回退函数
`metal_graph_upload_prompt_embeddings_hc_cpu`（`ds4.c:10974`），逻辑完全相同。
当 token 数量达到阈值时，直接调用 GPU 的
`ds4_gpu_embed_tokens_hc_tensor` kernel，在 GPU 上完成嵌入查表并原地重复填充
4 条 HC 流，节省 CPU-GPU 数据传输。

初始化后，HC 张量的形状是 `[n_tokens, DS4_N_HC, DS4_N_EMBD]`，即
每个 token 4 条流，每条流 4096 维，全部值相同——但随着网络逐层前进，
各流将通过 `hc_pre` / `hc_post` 分化出不同的激活轨迹。

整个流程如下图：

<svg viewBox="0 0 640 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="HC stream seeding from token embedding: token_id goes through embed lookup to plain vector, then copied to 4 HC streams">
  <defs>
    <marker id="ar81" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="20" y="20" width="120" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="80" y="43" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">token_id</text>
  <line x1="80" y1="56" x2="80" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="20" y="80" width="120" height="36" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="80" y="99" text-anchor="middle" font-size="11" fill="#64748b">embed_token_f16</text>
  <text x="80" y="112" text-anchor="middle" font-size="10" fill="#94a3b8">（查 F16 嵌入表）</text>
  <line x1="80" y1="116" x2="80" y2="140" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="20" y="140" width="120" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="80" y="159" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">plain[4096]</text>
  <text x="80" y="172" text-anchor="middle" font-size="10" fill="#94a3b8">F16 嵌入向量</text>
  <line x1="80" y1="176" x2="80" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="10" y="200" width="140" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="80" y="219" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">hc_from_plain</text>
  <text x="80" y="232" text-anchor="middle" font-size="10" fill="#64748b">_embedding</text>
  <line x1="160" y1="218" x2="200" y2="248" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar81)"/>
  <line x1="160" y1="218" x2="200" y2="278" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar81)"/>
  <line x1="160" y1="218" x2="200" y2="308" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar81)"/>
  <line x1="160" y1="218" x2="200" y2="338" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#ar81)"/>
  <rect x="200" y="234" width="160" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="280" y="251" text-anchor="middle" font-size="11" fill="currentColor">stream 0: plain[4096]</text>
  <rect x="200" y="264" width="160" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="280" y="281" text-anchor="middle" font-size="11" fill="currentColor">stream 1: plain[4096]</text>
  <rect x="200" y="294" width="160" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="280" y="311" text-anchor="middle" font-size="11" fill="currentColor">stream 2: plain[4096]</text>
  <rect x="200" y="324" width="160" height="26" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="280" y="341" text-anchor="middle" font-size="11" fill="currentColor">stream 3: plain[4096]</text>
  <text x="370" y="261" font-size="10" fill="#94a3b8">(copy)</text>
  <text x="370" y="291" font-size="10" fill="#94a3b8">(copy)</text>
  <text x="370" y="321" font-size="10" fill="#94a3b8">(copy)</text>
  <text x="370" y="351" font-size="10" fill="#94a3b8">(copy)</text>
  <line x1="280" y1="350" x2="280" y2="374" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <rect x="170" y="374" width="220" height="30" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="280" y="393" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">batch_cur_hc [token, 4, 4096]</text>
  <text x="80" y="260" text-anchor="middle" font-size="10" fill="#94a3b8">↓ 4 份</text>
</svg>
<span class="figure-caption">图 T8.1 ｜ 每个 token 的 F16 嵌入向量被复制四份，初始化 4 条 HC 超连接流</span>

<details>
<summary>ASCII 原版</summary>

```
token_id  →  embed_token_f16  →  plain[4096]
                                      |
                         ┌────────────┴────────────┐
                         │  hc_from_plain_embedding│
                         └────────────┬────────────┘
                   stream 0: plain[4096]   (copy)
                   stream 1: plain[4096]   (copy)
                   stream 2: plain[4096]   (copy)
                   stream 3: plain[4096]   (copy)
                         │
                  batch_cur_hc[token, 4, 4096]
                         │
                    第 0 层开始
```

</details>

---

## 6. 代码位置

按阅读顺序：

- `ds4.c:6184` —— `ds4_default_prefill_cap_for_prompt`：核心 ubatch 选择逻辑，
  含 2048 分块阈值与 env 覆盖。
- `ds4.c:13944` —— `metal_graph_raw_cap_for_context`：raw SWA 容量计算，
  `align_up(raw_window + prefill_cap, 256)` 及硬上限 8192。
- `ds4.c:17308` —— `ds4_session_create`（Metal 路径，第 17324 行起）：
  调用上面两个函数，把结果写进 `s->prefill_cap` 与 `s->graph.raw_cap`。
- `ds4.c:4429` —— `hc_from_plain_embedding`：把单个 embedding 复制给 4 条 HC 流。
- `ds4.c:10974` —— `metal_graph_upload_prompt_embeddings_hc_cpu`：
  CPU 回退版批量种子，用 `memcpy` 循环实现。
- `ds4.c:11003` —— `metal_graph_upload_prompt_embeddings_hc`（Metal 版入口）：
  小批量走 CPU 回退，大批量调用 GPU kernel 直接完成嵌入查表与重复填充。
- `ds4.c:13224` —— `metal_graph_prefill_layer_major`：前向入口，第一件事就是
  调用 `metal_graph_upload_prompt_embeddings_hc` 把 HC 状态种子好（`ds4.c:13254`）。
- `ds4.c:7791` —— CPU prefill 的嵌入种子，与 Metal 逻辑一一对应，可用于对比阅读。

---

## 7. 分支与延伸

- **HC 多流的全貌**——每条流在 pre/post 步骤里如何分化、`hc_attn_fn` / `hc_ffn_fn`
  变换矩阵的作用——见
  [第 9 章 超连接与 MoE](09-moe-hyperconnections.md)。

- **raw SWA 缓存的物理布局**——`raw_cap` 算出来后如何分配 GPU 缓冲区，
  为什么要对齐到 256 行——见
  [第 7 章 KV 缓存](07-kv-cache.md)。

- **Metal GPU graph 的内存预算**——`prefill_cap` 如何影响
  `batch_cur_hc` / `batch_next_hc` 等临时张量的大小，以及整个 Metal graph
  的内存估算接口 `ds4_context_memory_estimate`（`ds4.c:14002`）——见
  [第 10 章 Metal](10-metal-backend.md)。

- **长 prompt 分块 prefill**——当 `prefill_cap < prompt_len` 时走
  `metal_graph_prefill_chunked`，每个 chunk 都经历一次完整的 43 层 layer-major
  前向，block 边界对齐到 `prefill_cap` 倍数以保证压缩窗口调度正确——这条路径
  在步骤 09 不会走到，但其细节见
  [第 10 章 Metal §分块 prefill](10-metal-backend.md)。

- **磁盘 KV 缓存命中后的 prefill 跳过**——当 `s->checkpoint_valid` 为真且新
  prompt 共享前缀时，`session_sync` 走增量路径（只对新增 token 做 decode 或
  resumed prefill），完全跳过本步骤——见
  [第 7 章 KV 缓存 §磁盘 checkpoint](07-kv-cache.md)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **prefill_cap 不是 ctx_size**。它是根据实际 prompt 长度自适应算出的：短于
   2048 的 prompt 一次吃完，更长的默认按 2048 切块。这个决策同时约束了临时 GPU
   张量的内存占用和单次命令缓冲区的计算量。

2. **raw_cap 与 prefill_cap 绑定**。raw SWA 缓存必须能同时容纳一个 SWA 窗口
   （128 行）加上当前 ubatch，所以 `raw_cap = align_up(raw_window + prefill_cap, 256)`。
   这两个值在 `ds4_session_create` 时就已锁定，前向过程中不再改变。

3. **HC 流的初始化是"4 份相同的 token 嵌入"**。不是随机，不是全零，而是同一个
   token 的 F16 嵌入向量拷贝四份。从这个共同起点出发，各流在每个子层的
   `hc_pre` / `hc_post` 变换下逐渐分化。

4. **Metal 路径有批量阈值**。token 数 < 512 时走 CPU memcpy 回退，否则直接调
   GPU kernel 在显卡上完成嵌入查表加重复填充，避免大批量数据经过 PCIe 总线。
