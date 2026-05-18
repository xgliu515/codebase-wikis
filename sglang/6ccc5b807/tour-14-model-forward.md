# Trace 步骤 14 —— 6 个 token 过一遍 Transformer,要算什么、不算什么?

## 1. 当前情境

`ForwardBatch` 已经造好:`input_ids` 是 "The capital of France is" 的 6 个 token、`positions` 是 0-5、KV 写入位置就绪、`forward_mode=EXTEND`。`ModelRunner.forward`(`python/sglang/srt/model_executor/model_runner.py:3111`)拿到它,准备跑真正的 Transformer 前向。

## 2. 问题

我们要的最终结果是「下一个 token」——也就是接在 "is" 后面的那个词(应该是 " Paris")。下一个 token 由「最后一个位置(position 5,token 'is')的输出分布」决定。问题是:

- 这 6 个 token 要怎么过模型——一个一个串行过,还是一起过?
- 我们只要最后一个位置的预测,那前面 5 个位置的计算是白做吗?能不能跳过?

## 3. 朴素思路

像生成时那样,一个 token 一个 token 喂:先喂 "The" 跑一遍、再喂 "capital" 跑一遍……6 个 token 跑 6 遍前向。毕竟 decode 阶段就是这么逐 token 来的,prefill 照搬不就行了。

## 4. 为什么朴素思路会崩

「prompt 也逐 token 串行跑」会浪费掉 prefill 阶段最大的一个红利——**并行**:

- Transformer 处理一个序列时,position i 的注意力只看 position 0..i(因果掩码)。这意味着 6 个 token 的计算**没有前后依赖到「必须串行」的程度**——给定整个输入序列,6 个位置的 Q/K/V 投影、注意力、MLP 都可以**一次性并行**算完,用一个因果掩码保证 position i 不偷看 i 之后。
- 逐 token 串行跑,等于把一个能打满 GPU 的大矩阵乘,拆成 6 个小矩阵乘。GPU 在小算子上严重欠载——计算量没变,但因为 kernel launch 开销和低占用率,慢好几倍。
- prompt 越长,这个浪费越夸张:1000 token 的 prompt 串行跑 1000 遍,而本可以一遍解决。

这正是 prefill 和 decode 的**本质区别**:prefill 时**整个 prompt 已知**,可以一次性并行处理所有 token;decode 时下一个 token 还没生成,只能逐个来。

## 5. SGLang 的做法

`forward_mode=EXTEND` 走的就是「一次性并行处理所有新 token」的路径——`ModelRunner.forward`(`model_runner.py:3111`)根据模式分派到 `forward_extend`(`model_runner.py:2991`);decode 则走 `forward_decode`(`:2955`)。

`forward_extend` 把 6 个 token 作为一个序列,一次性过整个 Transformer 栈(`python/sglang/srt/models/llama.py` 里的模型实现):每一层做 QKV 投影 → 注意力(带因果掩码)→ MLP → 残差/norm。6 个位置在每个算子里都是**并行**算的,一遍走完拿到 6 个位置的 hidden state。

<svg viewBox="0 0 600 348" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Prefill forward: all prompt tokens processed in parallel, only last position needs logits">
<defs>
<marker id="t14ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="300" y="20" text-anchor="middle" font-size="11" fill="#94a3b8">输入：6 个 token 一次性进入</text>
<rect x="90" y="30" width="420" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
<line x1="160" y1="30" x2="160" y2="62" stroke="#94a3b8"/><line x1="230" y1="30" x2="230" y2="62" stroke="#94a3b8"/>
<line x1="300" y1="30" x2="300" y2="62" stroke="#94a3b8"/><line x1="370" y1="30" x2="370" y2="62" stroke="#94a3b8"/>
<line x1="440" y1="30" x2="440" y2="62" stroke="#94a3b8"/>
<text x="125" y="51" text-anchor="middle" font-size="10" fill="currentColor">The</text>
<text x="195" y="51" text-anchor="middle" font-size="10" fill="currentColor">capital</text>
<text x="265" y="51" text-anchor="middle" font-size="10" fill="currentColor">of</text>
<text x="335" y="51" text-anchor="middle" font-size="10" fill="currentColor">France</text>
<text x="405" y="51" text-anchor="middle" font-size="10" fill="currentColor">is</text>
<text x="475" y="51" text-anchor="middle" font-size="9" fill="#94a3b8">pos5</text>
<line x1="300" y1="62" x2="300" y2="84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
<rect x="90" y="86" width="420" height="78" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
<text x="300" y="110" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Transformer（N 层，因果掩码）</text>
<text x="300" y="130" text-anchor="middle" font-size="10" fill="#64748b">每层 QKV → Attention → MLP</text>
<text x="300" y="150" text-anchor="middle" font-size="10" fill="#ea580c">6 个位置一次性并行算（prompt 已知）</text>
<line x1="300" y1="164" x2="300" y2="186" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
<rect x="90" y="188" width="420" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="300" y="208" text-anchor="middle" font-size="11" fill="currentColor">6 个位置的 hidden state（K/V 已写入 KV cache，供 decode 回看）</text>
<line x1="475" y1="220" x2="475" y2="250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
<text x="300" y="242" text-anchor="middle" font-size="10" fill="#94a3b8">只取 position 5（'is'）的 hidden state——前 5 个位置不预测下一 token</text>
<rect x="200" y="252" width="200" height="36" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="300" y="275" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">lm_head → logits</text>
<line x1="300" y1="288" x2="300" y2="312" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t14ar)"/>
<rect x="220" y="314" width="160" height="30" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="300" y="334" text-anchor="middle" font-size="11" fill="currentColor">下一步：采样</text>
</svg>
<span class="figure-caption">图 T14.1 ｜ prefill 把整个 prompt 并行过 Transformer；前面位置的 K/V 为 decode 铺路，只有最后位置算 logits</span>

<details>
<summary>ASCII 原版</summary>

```text
  输入: [The, capital, of, France, is]  (6 个 token, 一次性)
          │
   ┌──────▼───────────────────────────┐
   │  Transformer (N 层),因果掩码     │   6 个位置并行算
   │  每层: QKV → Attn → MLP          │
   └──────┬───────────────────────────┘
          ▼
   6 个位置的 hidden state
          │
          └──► 只取 position 5 ('is') 的 ──► 算 logits ──► 下一步采样
```

</details>

**那前 5 个位置的计算白做了吗?没有。** 关键在 KV cache:这 6 个 token 在注意力层算出的 **K 和 V,会被写进步骤 11 分配好的 KV 槽位**(见 [步骤 15](tour-15-attention-kernel.md))。前 5 个位置的 hidden state 我们确实不直接用来预测,但它们的 **K/V 是后续 decode 必须的**——生成第 7 个 token 时,它的注意力要回看 position 0-5 的 K/V。所以 prefill 的工作量一点没浪费,它在「为 decode 铺路」。

至于**算 logits**:`forward_extend` 之后只需要把 **position 5** 的 hidden state 过最后的输出投影(lm_head),得到一个词表大小的向量 `logits`——下一个 token 的未归一化分布。前 5 个位置不需要 logits(我们不预测 prompt 内部的 token),所以输出投影只对最后一个位置做,省掉 5/6 的 lm_head 计算。

`forward` 跑完,返回的结果里带着 position 5 的 logits。下一步交给采样。

## 6. 代码位置

按顺序读:

- `python/sglang/srt/model_executor/model_runner.py:3111` —— `ModelRunner.forward`,按 `forward_mode` 分派。
- `model_runner.py:2991` —— `forward_extend`,prefill 路径(一次性并行处理所有 token)。
- `model_runner.py:2955` —— `forward_decode`,decode 路径(对照看,一次 1 token)。
- `python/sglang/srt/models/llama.py` —— 一个具体模型的前向实现,看 Transformer 层怎么搭。
- `model_runner.py:3304` —— `sample`,前向之后的采样入口(下一步)。

## 7. 分支与延伸

- `ModelRunner` 前向的完整流程、模型骨架的组织 → [第 09 章 ModelRunner 与前向执行](09-model-runner.md)
- 注意力层具体怎么写 K/V、怎么读历史 KV → [步骤 15](tour-15-attention-kernel.md)、[第 10 章 注意力后端](10-attention-backends.md)
- decode 阶段(逐 token)的前向和 prefill 有何不同 → [步骤 17](tour-17-decode-loop.md)
- 投机解码会让「一次验证多个 token」,改变这个并行结构 → [第 12 章 投机解码](12-speculative-decoding.md)

## 8. 走完这一步你脑子里应该多了什么

1. prefill(`EXTEND` 模式)把整个 prompt 的所有 token **一次性并行**过 Transformer——因为 prompt 已知,因果掩码就能保证正确性,不需要逐 token 串行。
2. 这是 prefill 和 decode 的**本质区别**:prefill 整段已知可并行,decode 下一个 token 未知只能逐个来。
3. 前面位置的计算不浪费——它们的 **K/V 被写进 KV cache**,是后续 decode 的注意力必须回看的历史。
4. 只有**最后一个位置**需要算 logits(预测下一个 token),所以输出投影只对它做,省掉其余位置的 lm_head 开销。
