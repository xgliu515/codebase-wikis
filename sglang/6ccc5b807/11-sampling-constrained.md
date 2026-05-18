# 第 11 章 采样与约束解码

## 本章导读

前向跑完,模型给出的是 **logits**——一个词表大小的向量,每个位置一个未归一化的分数。但用户要的是「下一个 token」。从 logits 到 token,中间这一步是**采样**。

更进一步:如果用户要求输出必须是合法 JSON、必须匹配某个正则,光采样还不够——还要**约束**采样,把不合法的 token 直接掐掉。这是**约束解码**。

本章讲这两件事。代码在 `python/sglang/srt/sampling/` 和 `python/sglang/srt/constrained/`。

## 1. 采样参数:`SamplingParams`

用户对「怎么采样」的控制,集中在 `SamplingParams`(`python/sglang/srt/sampling/sampling_params.py:31`)。主要字段(`sampling_params.py:78` 起):

| 参数 | 默认 | 作用 |
|------|------|------|
| `temperature` | 1.0 | 温度。越高越随机,越低越确定 |
| `top_p` | 1.0 | 核采样:只在累积概率 top-p 的 token 里采 |
| `top_k` | -1(全词表) | 只在概率最高的 k 个 token 里采 |
| `min_p` | 0.0 | 最小概率阈值 |
| `frequency_penalty` / `presence_penalty` / `repetition_penalty` | — | 抑制重复 |
| `max_new_tokens` | — | 最多生成多少 token |
| `stop` / `stop_token_ids` | — | 停止字符串 / 停止 token |
| `regex` / `json_schema` / `ebnf` | — | 约束解码(见后) |

### 贪心是采样的特例

`SamplingParams` 构造时有一个值得注意的归一化(`sampling_params.py:113-116`):

```python
if 0 <= self.temperature < _SAMPLING_EPS:
    # top_k = 1 means greedy sampling
    self.temperature = 1.0
    self.top_k = 1
```

`temperature=0` 不会真的去做「除以 0」——它被翻译成 `top_k=1`。`top_k=1` 意味着「只在概率最高的 1 个 token 里选」,也就是 **argmax,即贪心采样**。

这个设计很关键:**贪心不是一条独立的代码路径,它是「`top_k=1`」这个普通采样配置的特例**。下游的采样 kernel 不需要为 `temperature=0` 写特判,统一按 top-k 处理即可。本 wiki 的 trace 用的就是 `temperature=0`(见 [导览步骤 16](tour-16-sample-token.md))。

`verify`(`sampling_params.py:120`)在构造后校验参数合法性(`temperature` 非负、`top_p` 在 (0,1] 等)。

## 2. 批量采样:`SamplingBatchInfo`

GPU 一次处理一批请求,而这批里每个请求的采样参数可能都不同——A 要 `temperature=0.7`,B 要贪心,C 要 `top_p=0.9`。采样必须**批量**做,不能逐请求循环。

`SamplingBatchInfo`(`python/sglang/srt/sampling/sampling_batch_info.py:23`)就是把「一批请求的采样参数」打包成 GPU 张量的对象。`from_schedule_batch`(`sampling_batch_info.py:74`)从 `ScheduleBatch` 里把每个 `Req` 的 `SamplingParams` 抽出来,堆叠成 `temperatures`、`top_ps`、`top_ks` 等张量——每个张量形状 `[batch_size]`。

它有个重要的标志位 `is_all_greedy`(`sampling_batch_info.py:31`):

```python
# sampling_batch_info.py:176
is_all_greedy=all(r.sampling_params.top_k <= 1 for r in reqs)
```

如果**整批**都是贪心,可以走一条更快的纯 argmax 路径,完全跳过温度缩放、top-p/top-k 过滤。`merge`(合并批)时 `is_all_greedy` 取与(`:397`)——只要混进一个非贪心请求,整批就走通用路径。

## 3. 采样流程:从 logits 到 token

采样的执行在 `Sampler`(`python/sglang/srt/layers/sampler.py:57`),`forward`(`:93`)是入口。

<svg viewBox="0 0 600 336" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Sampler forward: greedy fast path versus general sampling path">
<defs>
<marker id="r11ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<rect x="180" y="14" width="240" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
<text x="300" y="34" text-anchor="middle" font-size="11" fill="currentColor">logits　[batch, vocab]</text>
<line x1="300" y1="46" x2="300" y2="66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<path d="M300 68 L356 92 L300 116 L244 92 Z" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
<text x="300" y="96" text-anchor="middle" font-size="10" fill="currentColor">is_all_greedy?</text>
<line x1="356" y1="92" x2="452" y2="92" stroke="#16a34a" stroke-width="1.3" marker-end="url(#r11ar)"/>
<text x="404" y="84" text-anchor="middle" font-size="9" fill="#16a34a">是</text>
<rect x="454" y="74" width="132" height="38" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
<text x="520" y="91" text-anchor="middle" font-size="10" fill="currentColor">torch.argmax</text>
<text x="520" y="105" text-anchor="middle" font-size="9" fill="#64748b">直接取最大，结束</text>
<line x1="300" y1="116" x2="300" y2="136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<text x="312" y="132" font-size="9" fill="#94a3b8">否</text>
<rect x="200" y="138" width="200" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="157" text-anchor="middle" font-size="10" fill="currentColor">应用惩罚项 freq/presence/rep</text>
<line x1="300" y1="166" x2="300" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<rect x="200" y="182" width="200" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="201" text-anchor="middle" font-size="10" fill="currentColor">温度缩放　logits / temperature</text>
<line x1="300" y1="210" x2="300" y2="224" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<rect x="200" y="226" width="200" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="245" text-anchor="middle" font-size="10" fill="currentColor">softmax → 概率分布</text>
<line x1="300" y1="254" x2="300" y2="268" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<rect x="200" y="270" width="200" height="28" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
<text x="300" y="289" text-anchor="middle" font-size="10" fill="currentColor">top-k / top-p / min-p 过滤</text>
<line x1="300" y1="298" x2="300" y2="312" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar)"/>
<rect x="190" y="313" width="220" height="22" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
<text x="300" y="328" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">multinomial 采样 → next_token_id</text>
</svg>
<span class="figure-caption">图 R11.1 ｜ Sampler 的两条路：整批贪心走 argmax 快速结束，否则走惩罚/温度/过滤/采样的通用流水线</span>

<details>
<summary>ASCII 原版</summary>

```text
  logits  [batch, vocab]
     │
     ├─ is_all_greedy?  ──是──►  torch.argmax(logits, -1)   (sampler.py:121-123)
     │                            直接取最大,结束
     │ 否
     ▼
  应用惩罚项 (frequency / presence / repetition)
     │
  温度缩放:  logits / temperature
     │
  softmax  ──►  概率分布
     │
  top-k / top-p / min-p 过滤:把不在候选集里的概率清零
     │
  multinomial 采样:按概率随机抽一个 token
     │
     ▼
  next_token_id
```

</details>

贪心路径(`sampler.py:121-123`)就是一句 `torch.argmax`——这正是上面 `is_all_greedy` 的回报。通用路径则依次做惩罚、温度、过滤、随机抽样,全程批量 GPU kernel。

**惩罚项**抑制重复:`frequency_penalty` 按 token 已出现次数压低其 logits,`presence_penalty` 只看出没出现过,`repetition_penalty` 是乘性惩罚。实现在 `sampling/penaltylib/`,运行时由 `SamplingBatchInfo.update_penalties`(`sampling_batch_info.py:235`)更新。

**自定义 logits 处理器**:`sampling/custom_logit_processor.py` 允许用户插入自己的 logits 变换逻辑。

采到的 `next_token_id` 被 append 进 `Req.output_ids`,完成一步生成。详见 [导览步骤 16](tour-16-sample-token.md)。

## 4. 约束解码:为什么采样还不够

用户说「给我返回一个 JSON」。模型大概率能配合,但**不保证**——它可能漏个引号、多个逗号,产出非法 JSON。下游程序 `json.loads` 一下就崩。

光靠 prompt 里写「请输出 JSON」是软约束,不可靠。要**硬保证**输出合法,必须在**每一步采样**时就把「会导致非法」的 token 掐掉——这就是约束解码(也叫结构化输出 / guided decoding)。

原理:把「合法输出的格式」描述成一个**形式语法**(正则、JSON schema、EBNF)。语法对应一个**状态机**。在生成的每一步,状态机知道「当前状态下,哪些 token 是合法的下一步」。采样前,把所有**不合法** token 的 logits 设成 `-inf`——它们的概率变成 0,绝不可能被采到。

<svg viewBox="0 0 620 210" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Normal sampling versus constrained sampling with a grammar mask">
<defs>
<marker id="r11br" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
</defs>
<text x="40" y="44" font-size="11" font-weight="600" fill="#64748b">正常采样</text>
<rect x="120" y="28" width="90" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8"/><text x="165" y="48" text-anchor="middle" font-size="10" fill="currentColor">logits</text>
<line x1="210" y1="44" x2="246" y2="44" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11br)"/>
<rect x="248" y="28" width="90" height="32" rx="5" fill="#fed7aa" stroke="#ea580c"/><text x="293" y="48" text-anchor="middle" font-size="10" fill="currentColor">采样</text>
<line x1="338" y1="44" x2="374" y2="44" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11br)"/>
<rect x="376" y="28" width="140" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8"/><text x="446" y="48" text-anchor="middle" font-size="10" fill="#dc2626">任意 token（可能非法）</text>
<line x1="30" y1="80" x2="600" y2="80" stroke="#cbd5e1" stroke-dasharray="4,3"/>
<text x="40" y="130" font-size="11" font-weight="600" fill="#0d9488">约束采样</text>
<rect x="120" y="114" width="80" height="32" rx="5" fill="#f1f5f9" stroke="#94a3b8"/><text x="160" y="134" text-anchor="middle" font-size="10" fill="currentColor">logits</text>
<line x1="200" y1="130" x2="236" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11br)"/>
<rect x="238" y="108" width="150" height="44" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
<text x="313" y="127" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">套用语法 mask</text>
<text x="313" y="142" text-anchor="middle" font-size="9" fill="#64748b">非法 token → −inf</text>
<line x1="388" y1="130" x2="424" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11br)"/>
<rect x="426" y="114" width="80" height="32" rx="5" fill="#fed7aa" stroke="#ea580c"/><text x="466" y="134" text-anchor="middle" font-size="10" fill="currentColor">采样</text>
<line x1="506" y1="130" x2="542" y2="130" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11br)"/>
<rect x="430" y="160" width="160" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
<text x="510" y="179" text-anchor="middle" font-size="10" fill="#16a34a">保证合法的 token</text>
<line x1="544" y1="130" x2="566" y2="130 " stroke="#94a3b8" stroke-width="1"/>
<path d="M566 130 L566 160" stroke="#94a3b8" stroke-width="1" fill="none"/>
<text x="313" y="180" text-anchor="middle" font-size="10" fill="#0d9488">采到的 token 推进语法状态机 → 下一步的 mask</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ 约束采样在采样前用语法 mask 把非法 token 的 logits 设为 −inf，硬保证输出符合语法</span>

<details>
<summary>ASCII 原版</summary>

```text
  正常采样:     logits ──► 采样 ──► 任意 token
  约束采样:     logits ──► 套用语法 mask (非法 token → -inf)
                              │
                              ▼
                          采样 ──► 保证合法的 token ──► 推进状态机
```

</details>

这样,无论模型「想」输出什么,采样出来的 token 序列**一定**符合语法。

## 5. 约束解码的实现:grammar 后端

和注意力一样,SGLang 把约束解码做成**可插拔后端**。代码在 `python/sglang/srt/constrained/`:

| 后端 | 文件 | 说明 |
|------|------|------|
| XGrammar | `xgrammar_backend.py` | 默认,高性能 grammar 引擎 |
| Outlines | `outlines_backend.py` | 基于 Outlines 库,支持正则/JSON schema |
| LLGuidance | `llguidance_backend.py` | 微软 LLGuidance |

抽象基类是 `base_grammar_backend.py`。`grammar_manager.py` 管理 grammar 的编译与缓存——把一个 JSON schema 编译成状态机是有成本的,所以编译结果要缓存,相同 schema 的请求复用。

后端要提供的核心能力:

- **编译**:把 `regex` / `json_schema` / `ebnf` 编译成状态机;
- **算 mask**:给定当前状态,产出「哪些 token 合法」的 bitmask。`SamplingBatchInfo.update_regex_vocab_mask`(`sampling_batch_info.py:208`)在采样前把这个 mask 应用到 logits 上;
- **推进状态**:采到一个 token 后,把状态机推进到下一状态。

**jump-forward 优化**:`outlines_jump_forward.py` 实现了一个加速——如果语法在某个状态下「只有唯一一条合法路径」(比如 JSON 里 `"key":` 后面必然跟某些固定字符),那这些 token 不必让模型一个个生成,可以**直接跳过去**。这省掉了若干次前向。

`reasoner_grammar_backend.py` 处理「带推理过程」的约束——推理段不约束、最终答案段才约束。

## 6. 与调度器、ModelRunner 的集成

约束解码不是孤立的——它和调度、前向都有耦合:

- grammar 的编译可能较慢,调度器要处理「grammar 还没编译好」的请求(`schedule_batch.py` 里有 grammar 相关的等待逻辑);
- 每步采样前,`SamplingBatchInfo` 要从 grammar 后端取当前 mask;
- 采样后,要把采到的 token 喂回 grammar 后端推进状态。

这条链路保证了:从 prompt 进来到 token 出去,约束自始至终在生效。

## 相关章节

- [第 05 章 请求对象与核心数据结构](05-request-data-structures.md) —— `SamplingParams` 在 `Req` 中的位置
- [第 08 章 调度器与连续批处理](08-scheduler.md) —— grammar 编译与调度的耦合
- [第 09 章 ModelRunner 与前向执行](09-model-runner.md) —— `sample` 的调用点
- [第 12 章 投机解码](12-speculative-decoding.md) —— 投机解码下的采样/验证
- [导览步骤 16](tour-16-sample-token.md) —— 采样的实际 trace
