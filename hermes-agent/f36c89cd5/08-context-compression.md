# 第 8 章 上下文压缩与轨迹压缩

> 代码版本锁定：`NousResearch/hermes-agent@f36c89cd5`（2026-05-17）。本章所有 `file:line` 引用均以此 commit 为准。

## 8.1 问题：context window 是有限的

Hermes 的工具调用循环（[第 3 章](03-tool-loop.md)）每一轮都会往消息历史里追加内容——用户的请求、模型的回复、工具调用的参数、工具返回的输出。一个长会话动辄几十上百轮交互，消息历史会单调增长。但大模型的上下文窗口是有限的：Opus 4.7 是约 200K token，本地小模型可能只有 32K。

历史一旦撑过上下文上限，会发生两件坏事之一：

1. **API 直接拒绝请求**——返回 400 错误，会话彻底卡死。
2. **悄无声息地截断**——某些提供商会自动丢掉最早的消息，模型"忘了"前面发生过什么，开始重复已完成的工作，或者答非所问。

所以 Hermes 必须主动管理上下文。核心矛盾是：**既要把历史压短到能装进窗口，又不能丢掉关键信息**。"系统提示里有什么"、"用户最终想要什么"、"已经做过哪些事"、"当前卡在哪里"——这些必须保留；而"读过的文件的完整内容"、"几十轮前一次成功的命令的完整输出"则可以压缩成一句话。

Hermes 有两套压缩，思想相同、形态不同：

- **在线压缩**——会话进行中实时压缩，防止下一次 API 调用爆窗。本章 8.2–8.6 详述。
- **离线轨迹压缩**——一个独立的批处理脚本，把磁盘上的 JSONL 轨迹目录压缩，用于训练数据准备。本章 8.7 详述。

本章先讲在线压缩的抽象层 `ContextEngine`（8.2），再讲默认实现 `ContextCompressor`（8.3–8.5），然后讲它在对话循环里的位置（8.6），最后对比离线轨迹压缩（8.7）。

## 8.2 ContextEngine：可插拔的上下文引擎抽象

Hermes 没有把上下文压缩逻辑硬编码进对话循环。它定义了一个抽象基类 `ContextEngine`（`agent/context_engine.py:32`），把"上下文如何管理"做成一个可替换的策略。`context_engine.py:1-9` 的模块 docstring 说明：

> A context engine controls how conversation context is managed when approaching the model's token limit. The built-in ContextCompressor is the default implementation. Third-party engines (e.g. LCM) can replace it via the plugin system.

引擎的选择是配置驱动的——`config.yaml` 里的 `context.engine` 字段，默认是 `"compressor"`（内置实现）。同一时刻只有一个引擎活跃。第三方引擎（比如 Nous 的 LCM——Latent Context Model，一种基于 DAG 的上下文管理）可以通过插件系统替换默认实现，放进 `plugins/context_engine/<name>/` 目录（参见[第 12 章](12-plugin-system.md)）。

### 8.2.1 引擎的职责与生命周期

`context_engine.py:12-26` 列出了引擎的四项职责和六步生命周期：

<svg viewBox="0 0 820 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="ContextEngine responsibilities and six-step lifecycle">
  <defs>
    <marker id="r8ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="26" font-size="13" font-weight="700" fill="currentColor">引擎职责</text>
  <rect x="20" y="38" width="240" height="118" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="34" y="62" font-size="11" fill="#64748b">· 决定何时该压缩</text>
  <text x="34" y="84" font-size="11" fill="#64748b">· 执行压缩（摘要 / 构建 DAG）</text>
  <text x="34" y="106" font-size="11" fill="#64748b">· 可选向 agent 暴露工具</text>
  <text x="34" y="128" font-size="11" fill="#64748b">· 跟踪 API 响应的 token 用量</text>
  <text x="320" y="26" font-size="13" font-weight="700" fill="currentColor">六步生命周期</text>
  <rect x="320" y="38" width="480" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="334" y="56" font-size="11" font-weight="600" fill="currentColor">1. 实例化并注册</text>
  <text x="334" y="71" font-size="10" fill="#94a3b8">插件 register() 或默认</text>
  <rect x="320" y="86" width="480" height="34" rx="6" fill="#99f6e4" stroke="#0d9488"/>
  <text x="334" y="107" font-size="11" font-weight="600" fill="currentColor">2. on_session_start()  ── 对话开始时</text>
  <rect x="320" y="128" width="480" height="34" rx="6" fill="#99f6e4" stroke="#0d9488"/>
  <text x="334" y="149" font-size="11" font-weight="600" fill="currentColor">3. update_from_response()  ── 每次 API 响应后，带 usage</text>
  <rect x="320" y="170" width="480" height="34" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="334" y="191" font-size="11" font-weight="600" fill="currentColor">4. should_compress()  ── 每轮之后检查</text>
  <rect x="320" y="212" width="480" height="34" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="334" y="233" font-size="11" font-weight="600" fill="currentColor">5. compress()  ── should_compress() 为 True 时</text>
  <rect x="320" y="254" width="480" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="334" y="272" font-size="11" font-weight="600" fill="currentColor">6. on_session_end()  ── 真正的会话边界</text>
  <text x="334" y="287" font-size="10" fill="#94a3b8">CLI 退出 / /reset / 网关过期 — NOT per-turn</text>
  <line x1="560" y1="78" x2="560" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <line x1="560" y1="120" x2="560" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <line x1="560" y1="162" x2="560" y2="170" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <line x1="560" y1="204" x2="560" y2="212" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar1)"/>
  <path d="M780,246 C795,238 795,222 780,214" fill="none" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r8ar1)"/>
  <text x="700" y="232" font-size="9" fill="#94a3b8">循环回 4</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ ContextEngine 的四项职责与六步生命周期：3~5 步每轮循环，第 6 步只在真正的会话边界触发。</span>

<details>
<summary>ASCII 原版</summary>

```text
引擎职责：
  - 决定何时该压缩
  - 执行压缩（摘要、构建 DAG，等等）
  - 可选地向 agent 暴露工具（如 LCM 的 lcm_grep）
  - 跟踪 API 响应里的 token 用量

生命周期：
  1. 引擎被实例化并注册（插件 register() 或默认）
  2. on_session_start()   ── 对话开始时
  3. update_from_response() ── 每次 API 响应后，带 usage 数据
  4. should_compress()    ── 每轮之后检查
  5. compress()           ── should_compress() 返回 True 时
  6. on_session_end()     ── 真正的会话边界（CLI 退出 / /reset / 网关过期）
```

</details>

第 6 步特意强调"NOT per-turn"——`on_session_end()` 只在会话真正结束时调用，不是每轮调用。这个区分对有持久状态的引擎（比如要关数据库连接的 LCM）很重要。

### 8.2.2 核心接口与共享 token 状态

`ContextEngine` 是个 ABC，有三个 `@abstractmethod`，子类必须实现（`context_engine.py:70-101`）：

```python
@abstractmethod
def update_from_response(self, usage: Dict[str, Any]) -> None:
    """从 API 响应更新跟踪的 token 用量。每次 LLM 调用后调用。"""

@abstractmethod
def should_compress(self, prompt_tokens: int = None) -> bool:
    """返回 True 表示本轮该压缩。"""

@abstractmethod
def compress(
    self,
    messages: List[Dict[str, Any]],
    current_tokens: int = None,
    focus_topic: str = None,
) -> List[Dict[str, Any]]:
    """压缩消息列表，返回新的消息列表。"""
```

`compress()` 的契约值得注意：它接收完整的消息列表，返回一个（可能更短的）列表，引擎"自由地去摘要、构建 DAG 或做任何事——只要返回的列表是合法的 OpenAI 格式消息序列"（`context_engine.py:90-94`）。这条契约把引擎内部实现和对话循环彻底解耦——循环只管把消息交出去、拿新消息回来，完全不关心引擎用了什么算法。

`focus_topic` 参数（`context_engine.py:97-101`）支持用户手动 `/compress <focus>` 做"聚焦压缩"——告诉引擎优先保留与某个话题相关的信息。不支持这个特性的引擎可以直接忽略它。

抽象基类还约定了一组**共享的 token 状态字段**（`context_engine.py:46-51`），引擎必须维护、对话循环会直接读取它们用于显示和日志：

```python
last_prompt_tokens: int = 0
last_completion_tokens: int = 0
last_total_tokens: int = 0
threshold_tokens: int = 0
context_length: int = 0
compression_count: int = 0
```

以及一组压缩参数（`context_engine.py:64-66`），子类可以覆盖：

```python
threshold_percent: float = 0.75
protect_first_n: int = 3
protect_last_n: int = 6
```

`protect_first_n` 的语义在 `context_engine.py:59-62` 的注释里有精确定义：它是"系统提示之外、额外保护的非系统头部消息数"。系统提示永远隐式被保护，`protect_first_n=3` 意味着"系统提示 + 前 3 条非系统消息"全部保护。

### 8.2.3 可选钩子

抽象基类还提供了一组带默认实现的可选钩子：

- `should_compress_preflight()`（`context_engine.py:105`）——API 调用**前**的快速粗检（此时还没有真实 token 计数）。默认返回 `False`。这是在线压缩能"防延迟"的关键，8.6 详述。
- `has_content_to_compress()`（`context_engine.py:115`）——给网关 `/compress` 命令做前置守卫，没东西可压时直接报告"nothing to compress yet"，不浪费一次 LLM 调用。
- `get_tool_schemas()`（`context_engine.py:156`）/`handle_tool_call()`（`context_engine.py:164`）——引擎可以向 agent 暴露自己的工具。注释举例 LCM 会在这里返回 `lcm_grep`、`lcm_describe`、`lcm_expand` 的 schema。内置压缩器返回空列表。
- `on_session_reset()`（`context_engine.py:144`）——`/new` 或 `/reset` 时重置每会话状态。
- `update_model()`（`context_engine.py:196`）——用户切换模型或故障转移时调用。默认实现重算 `threshold_tokens = context_length * threshold_percent`。模型从 200K 窗口切到 32K 窗口时，压缩阈值必须跟着变。

## 8.3 ContextCompressor：默认引擎

`ContextCompressor`（`agent/context_compressor.py:454`）是 `ContextEngine` 的默认实现。它的类 docstring（`context_compressor.py:455-463`）把算法概括成五步：

```text
1. 修剪老旧的工具结果（便宜，无 LLM 调用）
2. 保护头部消息（系统提示 + 首轮交互）
3. 按 token 预算保护尾部消息（最近约 20K token）
4. 用结构化 LLM 提示对中间的轮次做摘要
5. 后续压缩时，在前一份摘要上做迭代更新
```

核心思想用一句话概括：**保护头尾、只压中间**。下面这张图是 `compress()` 工作的整体形状：

<svg viewBox="0 0 820 300" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="compress() before and after message list structure">
  <defs>
    <marker id="r8ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="24" font-size="13" font-weight="700" fill="currentColor">原始消息列表（n 条）</text>
  <rect x="20" y="36" width="120" height="44" rx="4" fill="#99f6e4" stroke="#0d9488"/>
  <text x="80" y="62" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">system</text>
  <rect x="142" y="36" width="170" height="44" rx="4" fill="#99f6e4" stroke="#0d9488"/>
  <text x="227" y="62" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">msg1 · msg2 · msg3</text>
  <rect x="314" y="36" width="290" height="44" rx="4" fill="#fef2f2" stroke="#dc2626"/>
  <text x="459" y="62" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">........ 中间 turns_to_summarize ........</text>
  <rect x="606" y="36" width="194" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="703" y="62" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">最近若干条</text>
  <line x1="20" y1="92" x2="312" y2="92" stroke="#0d9488" stroke-width="1.5"/>
  <text x="166" y="106" font-size="10" fill="#0d9488" text-anchor="middle">头部：系统提示 + protect_first_n</text>
  <line x1="606" y1="92" x2="800" y2="92" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="703" y="106" font-size="10" fill="#7c3aed" text-anchor="middle">尾部：按 token 预算</text>
  <text x="314" y="130" font-size="10" fill="#dc2626">↑ compress_start</text>
  <text x="538" y="130" font-size="10" fill="#dc2626">compress_end ↑</text>
  <line x1="459" y1="136" x2="459" y2="178" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar2)"/>
  <text x="459" y="160" font-size="10" fill="#64748b" text-anchor="middle">中间区被辅助 LLM 摘要</text>
  <text x="20" y="208" font-size="13" font-weight="700" fill="currentColor">压缩后消息列表（远少于 n 条）</text>
  <rect x="20" y="220" width="160" height="44" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="100" y="240" font-size="10" font-weight="600" fill="currentColor" text-anchor="middle">system</text>
  <text x="100" y="254" font-size="9" fill="#64748b" text-anchor="middle">注入压缩说明</text>
  <rect x="182" y="220" width="170" height="44" rx="4" fill="#99f6e4" stroke="#0d9488"/>
  <text x="267" y="246" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">msg1 · msg2 · msg3</text>
  <rect x="354" y="220" width="160" height="44" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="434" y="246" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">[摘要]</text>
  <rect x="516" y="220" width="284" height="44" rx="4" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="658" y="246" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">最近若干条</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ compress() 的"保护头尾、只压中间"：中间区被一条摘要消息替换，头尾原样保留。</span>

<details>
<summary>ASCII 原版</summary>

```text
原始消息列表（n 条）
┌──────────────────────────────────────────────────────────────┐
│ system │ msg1 │ msg2 │ msg3 │ ........ 中间 ........ │ 最近若干条 │
└──────────────────────────────────────────────────────────────┘
   └──── 头部：系统提示 + protect_first_n ────┘
                                          └──── 尾部：按 token 预算 ────┘
                                          
        ┌── compress_start         compress_end ──┐
        ▼                                         ▼
        中间区域 turns_to_summarize 被辅助 LLM 摘要

压缩后消息列表（远少于 n 条）
┌────────────────────────────────────────────────────────┐
│ system(注入压缩说明) │ msg1│msg2│msg3 │ [摘要] │ 最近若干条 │
└────────────────────────────────────────────────────────┘
```

</details>

### 8.3.1 构造与触发参数

`ContextCompressor.__init__()`（`context_compressor.py:512`）的参数定义了压缩行为：

```python
def __init__(
    self,
    model: str,
    threshold_percent: float = 0.50,
    protect_first_n: int = 3,
    protect_last_n: int = 20,
    summary_target_ratio: float = 0.20,
    ...
):
```

注意这里有个值得说明的不一致：抽象基类 `ContextEngine` 的默认 `threshold_percent` 是 `0.75`、`protect_last_n` 是 `6`（`context_engine.py:64-66`），而 `ContextCompressor.__init__` 的默认是 `0.50` 和 `20`。实际运行时这些值由对话循环根据模型和配置传入。`threshold_percent` 的含义是：当 prompt token 数达到上下文窗口的这个百分比时触发压缩。

构造时第一件实质性的事是查上下文窗口大小（`context_compressor.py:538`）：

```python
self.context_length = get_model_context_length(
    model, base_url=base_url, api_key=api_key,
    config_context_length=config_context_length,
    provider=provider,
)
self.threshold_tokens = max(
    int(self.context_length * threshold_percent),
    MINIMUM_CONTEXT_LENGTH,
)
```

`get_model_context_length()` 来自[第 7 章](07-model-providers.md)的 `model_metadata.py`——压缩器必须知道当前模型的真实上下文上限才能正确计算阈值。`max(..., MINIMUM_CONTEXT_LENGTH)` 是个下限保护（`context_compressor.py:543-546` 注释）：即使百分比算出来很低，也不能压到 `MINIMUM_CONTEXT_LENGTH` 以下，否则大窗口模型在 50% 处就过早压缩。

构造时还有一项关键派生量——尾部 token 预算。`context_compressor.py:535` 先把 `summary_target_ratio` 钳到 `[0.10, 0.80]` 区间，然后 `context_compressor.py:554-555` 算出 `tail_token_budget`：

```python
self.summary_target_ratio = max(0.10, min(summary_target_ratio, 0.80))
...
target_tokens = int(self.threshold_tokens * self.summary_target_ratio)
self.tail_token_budget = target_tokens
```

注意 `tail_token_budget` 不是从上下文窗口算的，而是从 `threshold_tokens`（阈值）算的——`threshold_tokens * 0.20` 默认约是窗口的 `0.50 * 0.20 = 10%`。这个数字同时被三处复用：`_find_tail_cut_by_tokens()` 用它决定保护多少尾部消息、`_prune_old_tool_results()` 用它决定修剪边界、摘要预算计算间接用它。把它绑在 `threshold_tokens` 上的好处是：模型切换到小窗口时，阈值跟着 `update_model()` 重算，尾部预算也自动跟着缩——所有量级一致地随模型缩放，不会出现"窗口 32K 但还想保留 20K 尾部"的矛盾。

### 8.3.2 图像 token 估算：1600 这个常数

压缩器在做 token 预算时需要给图片一个估算值。`context_compressor.py:71` 定义：

```python
_IMAGE_TOKEN_ESTIMATE = 1600
```

`context_compressor.py:66-71` 的注释解释了这个数字怎么来的：

> Real cost varies by provider and dimensions (Anthropic ≈ width×height/750, GPT-4o up to ~1700 for high-detail 2048×2048, Gemini 258/tile), but 1600 is a realistic ceiling that keeps compression budgeting honest for multi-image conversations.

不同提供商对图片的 token 计费方式完全不同——Anthropic 按 `宽×高/750`、GPT-4o 高清模式约 1700、Gemini 每 tile 258。Hermes 不去精确建模每家的公式，而是取一个"现实的上限"1600 作为统一估算。这个常数还被换算成"字符当量"`_IMAGE_CHAR_EQUIVALENT`（`context_compressor.py:75`，等于 `1600 * 4`），因为压缩器内部大量用"字符长度"作为 token 的代理货币。

为什么需要这个估算？`_content_length_for_budget()`（`context_compressor.py:79`）的 docstring 点明了：如果不给图片算 token，一个"挂了 5 张图但文字部分为空"的消息会被当成接近零 token，压缩器就不会去碰它——而实际上它占了上万 token。函数对多模态内容的处理是：文字部分按 `len(text)` 算，每个图片部分（`image_url`/`input_image`/Anthropic 风格 `image`）加一个固定的 `_IMAGE_CHAR_EQUIVALENT`。

`_CHARS_PER_TOKEN = 4`（`context_compressor.py:65`）是另一个粗略常数——平均每 token 约 4 个字符。这个估算贯穿整个压缩器的预算计算。

### 8.3.3 为什么用"字符长度"作为 token 代理货币

压缩器内部几乎所有预算判断都不调真正的 tokenizer，而是用 `len(text) // 4` 这种粗估。`_find_tail_cut_by_tokens()`（`context_compressor.py:1429-1438`）的核心循环就是典型例子：

```python
content_len = _content_length_for_budget(raw_content)
msg_tokens = content_len // _CHARS_PER_TOKEN + 10  # +10 for role/metadata
for tc in msg.get("tool_calls") or []:
    if isinstance(tc, dict):
        args = tc.get("function", {}).get("arguments", "")
        msg_tokens += len(args) // _CHARS_PER_TOKEN
```

为什么不用精确 tokenizer？三个理由。第一，**性能**——压缩器在每轮 `compress()` 里要对几十上百条消息反复算长度，真 tokenizer 编码一遍开销不小，而 `len()` 是 O(1)。第二，**无依赖**——精确 tokenizer 是模型相关的（Anthropic、OpenAI、各家本地模型分词器都不同），把 tokenizer 拉进压缩器会绑死模型。第三，**够用**——压缩判断本质是"够不够装得下"的粗粒度决策，估算偏差几个百分点不影响结论。每条消息额外 `+10` 是给 `role`/`tool_call_id` 这类元数据留的固定开销。

这套"字符即代理货币"的设计也解释了 8.3.2 里图片为什么要换算成 `_IMAGE_CHAR_EQUIVALENT`（`1600 * 4` 字符）——既然预算单位是字符，图片就必须折算成字符才能参与同一套加法。`_content_length_for_budget()` 把多模态消息里的文字按 `len()` 算、每张图加一个固定字符当量，统一成一个标量长度，下游所有预算循环就能无差别地处理纯文本和多模态消息。

## 8.4 compress() 主流程详解

`compress()`（`context_compressor.py:1482`）是整个引擎的主入口。我们按它的四个阶段逐一拆解。下面这张图是四个阶段串起来的数据流——它比 8.3 那张静态结构图多了"经过哪些函数"这一维：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="compress() four-phase data flow">
  <defs>
    <marker id="r8ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="14" width="220" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="35" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">compress(messages)</text>
  <line x1="380" y1="48" x2="380" y2="62" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <rect x="200" y="62" width="360" height="34" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="380" y="83" font-size="11" fill="currentColor" text-anchor="middle">守卫：n_messages ≤ head + 4 ?  ── 是 → 原样返回</text>
  <line x1="380" y1="96" x2="380" y2="110" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <rect x="60" y="110" width="640" height="80" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="74" y="130" font-size="12" font-weight="700" fill="currentColor">阶段一  _prune_old_tool_results()</text>
  <text x="540" y="130" font-size="10" fill="#64748b">[无 LLM]</text>
  <text x="74" y="150" font-size="10" fill="#64748b">· 去重相同工具结果</text>
  <text x="74" y="167" font-size="10" fill="#64748b">· 老工具结果换成单行摘要</text>
  <text x="74" y="184" font-size="10" fill="#64748b">· 截断超大 tool_call 参数</text>
  <line x1="380" y1="190" x2="380" y2="204" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <rect x="60" y="204" width="640" height="92" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="74" y="224" font-size="12" font-weight="700" fill="currentColor">阶段二  确定边界</text>
  <text x="74" y="244" font-size="10" fill="#64748b">compress_start = _protect_head_size() → _align_boundary_forward()</text>
  <text x="74" y="261" font-size="10" fill="#64748b">compress_end   = _find_tail_cut_by_tokens()</text>
  <text x="98" y="277" font-size="10" fill="#64748b">└ _align_boundary_backward() · _ensure_last_user_message_in_tail()</text>
  <text x="74" y="291" font-size="10" fill="#dc2626">若 compress_start ≥ compress_end → 原样返回</text>
  <line x1="380" y1="296" x2="380" y2="310" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <rect x="60" y="310" width="640" height="92" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="74" y="330" font-size="12" font-weight="700" fill="currentColor">阶段三  _generate_summary(turns_to_summarize)</text>
  <text x="520" y="330" font-size="10" fill="#64748b">[一次 LLM 调用]</text>
  <text x="74" y="350" font-size="10" fill="#64748b">· _compute_summary_budget()  算预算</text>
  <text x="74" y="367" font-size="10" fill="#64748b">· _serialize_for_summary()  裁剪+脱敏输入</text>
  <text x="74" y="384" font-size="10" fill="#64748b">· 有 _previous_summary ? 迭代更新 : 从头摘要</text>
  <text x="74" y="398" font-size="10" fill="#64748b">· 失败 → 回退主模型 / 进冷却 → 返回 None</text>
  <line x1="380" y1="402" x2="380" y2="416" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar3)"/>
  <rect x="60" y="416" width="640" height="106" rx="8" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="74" y="436" font-size="12" font-weight="700" fill="currentColor">阶段四  组装新列表</text>
  <text x="74" y="456" font-size="10" fill="#64748b">头部(注入压缩说明) + [摘要消息 或 静态兜底] + 尾部</text>
  <text x="74" y="476" font-size="10" fill="#64748b">→ _sanitize_tool_pairs()  清孤儿</text>
  <text x="74" y="493" font-size="10" fill="#64748b">→ _strip_historical_media()  剥旧图</text>
  <text x="74" y="510" font-size="10" fill="#64748b">→ 防抖统计：savings_pct &lt; 10% ? 累加无效计数 : 清零</text>
</svg>
<span class="figure-caption">图 R8.3 ｜ compress() 的四阶段数据流：廉价修剪 → 确定边界 → 一次 LLM 摘要 → 组装并做防抖统计。</span>

<details>
<summary>ASCII 原版</summary>

```text
compress(messages)
  │
  ├─ 守卫：n_messages <= head + 4 ?  ── 是 ─→ 原样返回
  │
  ├─ 阶段一  _prune_old_tool_results()         [无 LLM]
  │     · 去重相同工具结果
  │     · 老工具结果换成单行摘要
  │     · 截断超大 tool_call 参数
  │
  ├─ 阶段二  确定边界
  │     compress_start = _protect_head_size() → _align_boundary_forward()
  │     compress_end   = _find_tail_cut_by_tokens()
  │                        └─ _align_boundary_backward()
  │                        └─ _ensure_last_user_message_in_tail()
  │     若 compress_start >= compress_end ── 原样返回
  │
  ├─ 阶段三  _generate_summary(turns_to_summarize)   [一次 LLM 调用]
  │     · _compute_summary_budget()  算预算
  │     · _serialize_for_summary()   裁剪+脱敏输入
  │     · 有 _previous_summary ? 迭代更新 : 从头摘要
  │     · 失败 → 回退主模型 / 进冷却 → 返回 None
  │
  └─ 阶段四  组装新列表
        头部(注入压缩说明) + [摘要消息 或 静态兜底] + 尾部
        → _sanitize_tool_pairs()  清孤儿
        → _strip_historical_media()  剥旧图
        → 防抖统计：savings_pct < 10% ? 累加无效计数 : 清零
```

</details>

我们按这四个阶段逐一拆解。

### 8.4.1 触发判断：should_compress 与防抖

在 `compress()` 之前，对话循环先调 `should_compress()`（`context_compressor.py:601`）判断该不该压：

```python
def should_compress(self, prompt_tokens: int = None) -> bool:
    tokens = prompt_tokens if prompt_tokens is not None else self.last_prompt_tokens
    if tokens < self.threshold_tokens:
        return False
    # 防抖：最近的压缩如果都不见效就退避
    if self._ineffective_compression_count >= 2:
        if not self.quiet_mode:
            logger.warning(
                "Compression skipped — last %d compressions saved <10%% each. ...",
                self._ineffective_compression_count,
            )
        return False
    return True
```

第一个判断很直接——token 没到阈值就不压。`should_compress()` 接收一个可选的 `prompt_tokens` 参数：传了就用传入值，没传就回退到 `self.last_prompt_tokens`（上一次 API 响应 `usage` 里记录的真实值）。这个参数让同一个判断逻辑能服务两种调用路径——响应后用真实 token 计数判断、预检时用粗估值判断。

第二个判断是**防抖动**（anti-thrashing）。docstring（`context_compressor.py:604-606`）解释：如果最近两次压缩每次都只省了不到 10%，就跳过压缩，避免陷入"每次只删 1-2 条消息"的无限循环。`_ineffective_compression_count` 计数器在 `compress()` 末尾根据实际节省比例增减（见 8.4.4）。当历史已经被压无可压时，与其反复做无效压缩，不如让 `should_compress()` 返回 `False`，并提示用户用 `/new` 开新会话。

**进入 compress() 后的最小消息数守卫。** `should_compress()` 之外，`compress()` 自己开头还有一道门（`context_compressor.py:1508-1517`）：

```python
n_messages = len(messages)
_min_for_compress = self._protect_head_size(messages) + 3 + 1
if n_messages <= _min_for_compress:
    logger.warning("Cannot compress: only %d messages (need > %d)", ...)
    return messages
```

`_min_for_compress` 等于"头部保护数 + 3 条最小尾部 + 1"。如果消息总数还不够同时填满头部和最小尾部，中间根本没有可压缩区间，`compress()` 直接原样返回。这道守卫保证后面的边界计算永远有非空中间区，否则 `compress_start >= compress_end` 时（`context_compressor.py:1536`）也会原样返回——两层防御都指向同一个不变式：没有可压的东西就什么都不做。

### 8.4.2 阶段一：修剪老旧工具结果（无 LLM 调用）

`compress()` 的第一个实质阶段是 `_prune_old_tool_results()`（`context_compressor.py:627`），它是一个**廉价的预处理，完全不调 LLM**。docstring（`context_compressor.py:631-648`）说明它做三件事：

```text
1. 把老旧工具结果的内容替换成信息丰富的单行摘要：
     [terminal] ran `npm test` -> exit 0, 47 lines output
     [read_file] read config.py from line 1 (3,400 chars)
2. 去重相同的工具结果（同一个文件读了 5 次，只留最新的完整副本）
3. 截断保护尾部之外的 assistant 消息里过大的 tool_call 参数
```

为什么这是个独立的便宜前置步骤？因为工具输出往往是消息历史里最臃肿的部分——一次 `npm test` 可能吐出几千行日志，一次文件读取可能是几万字符。但这些内容大多是**过程性**的：模型当时需要看到完整输出来做决策，但几十轮之后，"这个命令成功了、输出 47 行"这一句话就够了。把它们换成单行摘要，不需要任何 LLM 推理，就能省下大量 token——很多时候这一步之后就已经降到阈值以下，根本不用走后面昂贵的 LLM 摘要。

修剪边界的确定有两种方式（`context_compressor.py:672-693`）：按 token 预算（从尾部往回累加 token 直到 `protect_tail_tokens`）或按消息条数（最后 `protect_tail_count` 条）。两者同时给出时，token 预算优先，条数作为硬下限。`_PRUNED_TOOL_PLACEHOLDER`（`context_compressor.py:62`）是去重时用的占位符文本。`_summarize_tool_result()`（`context_compressor.py:332`）负责生成那些 `[terminal] ran ... -> exit 0` 风格的单行摘要。

### 8.4.3 阶段二：确定头尾边界

`compress()` 的 `context_compressor.py:1529-1537` 确定要压缩的中间区域：

```python
# Phase 2: 确定边界
compress_start = self._protect_head_size(messages)
compress_start = self._align_boundary_forward(messages, compress_start)

# 用 token 预算保护尾部，而非固定消息条数
compress_end = self._find_tail_cut_by_tokens(messages, compress_start)

if compress_start >= compress_end:
    return messages
```

**头部保护边界 `compress_start`。** `_protect_head_size()`（`context_compressor.py:1296`）返回要保护的头部消息总数。它的逻辑（`context_compressor.py:1311-1314`）是：系统提示（如果 index 0 是 system）算 1，加上 `protect_first_n`。docstring 强调系统提示"永远隐式被保护——它是承重的上下文，绝不能被摘要掉"。

**尾部保护边界 `compress_end`。** 注意 Hermes **不用固定消息条数**保护尾部，而是用 token 预算——`_find_tail_cut_by_tokens()`（`context_compressor.py:1400`）从消息列表末尾往回走，累加 token，直到达到 `tail_token_budget`（约 20K token），返回尾部起始的索引。这比"最后 N 条"更合理：一条挂满图片的消息和一条单行回复占的 token 差几十倍，按条数保护会保护得忽多忽少。

**边界对齐：不能切断 tool_call/result 组。** 一个 assistant 消息可能带着多个 `tool_calls`，紧跟着多条 `tool` 角色的结果消息。如果压缩边界正好落在这个组中间，会留下"孤儿"——一个 `tool_call` 没有对应的结果，或者一个结果没有对应的调用。API 收到不匹配的 tool ID 会直接报错。

`_align_boundary_forward()`（头部边界向前对齐）和 `_align_boundary_backward()`（`context_compressor.py:1316`，尾部边界向后对齐）就是解决这个问题。`_align_boundary_backward()` 的逻辑（`context_compressor.py:1330-1337`）是：如果边界落在 tool 结果组中间，往回走过所有连续的 tool 消息，找到带 `tool_calls` 的父 assistant 消息，把边界移到它之前——让整个 assistant+tool_results 组要么全在摘要区、要么全在保护区。

**保证最后一条用户消息在尾部。** 这里有个微妙但严重的 bug 修复，记录在 `_ensure_last_user_message_in_tail()`（`context_compressor.py:1353`）的 docstring 里（引用 issue #10896）：

> `_align_boundary_backward` can pull `cut_idx` past a user message... If the last user message ends up in the compressed middle region the LLM summariser writes it into "Pending User Asks", but `SUMMARY_PREFIX` tells the next model to respond only to user messages after the summary — so the task effectively disappears from the active context, causing the agent to stall, repeat completed work, or silently drop the user's latest request.

如果边界对齐把用户最新的请求推进了被压缩的中间区，摘要器会把它写进"Pending User Asks"——但 `SUMMARY_PREFIX`（见 8.5）告诉下一个模型"只回应摘要之后的用户消息"。结果就是用户的最新任务**从活跃上下文里消失了**，agent 卡住、重复工作或者干脆丢掉请求。修复办法是：检测最后一条用户消息是否在保护尾部里，不在就把边界往回拉到包含它（`_ensure_last_user_message_in_tail`，`context_compressor.py:1380-1398`）。这里有个细节——把边界拉回到用户消息时**不再**调 `_align_boundary_backward`，因为用户消息本身就是干净的边界（前面不会跟着孤儿 tool 结果），再对齐反而会把边界无谓地拉进前一个 assistant+tool_calls 组。

### 8.4.3.1 尾部预算的软上限与最小保护

`_find_tail_cut_by_tokens()` 从尾部往回累加 token 时，并不是严格"到了 `tail_token_budget` 就停"。`context_compressor.py:1424-1452` 给了它两条弹性规则：

```python
min_tail = min(3, n - head_end - 1) if n - head_end > 1 else 0
soft_ceiling = int(token_budget * 1.5)
...
if accumulated + msg_tokens > soft_ceiling and (n - i) >= min_tail:
    break
```

第一条是**硬下限**——`min_tail` 永远至少保护 3 条尾部消息，哪怕这 3 条加起来已经超预算。第二条是**软上限**——预算允许超出至多 1.5 倍。为什么要软上限？因为如果严格卡在预算上，边界可能正好落在一条超大消息（几万字符的文件读取、巨型工具输出）的**中间**——但消息是不可分割的最小单位，切不进去。软上限给了 1.5 倍的余量，让边界能把这条大消息整体收进尾部或整体留给中间区，而不是被它卡死。

还有一个极端情况（`context_compressor.py:1450-1452`）：小对话里 token 预算可能覆盖了全部消息，`cut_idx` 会落到头部里。这时强制把边界设到 `head_end + 1`，保证至少能压一条中间消息——否则一个"消息数够、token 数不够"的对话会永远压不动。`has_content_to_compress()`（`context_compressor.py:1467`）复用了完全相同的边界计算，给网关 `/compress` 命令做前置守卫：算出来 `compress_start < compress_end` 才有东西可压，否则直接报"nothing to compress yet"，不浪费一次 LLM 调用。

### 8.4.4 阶段三与四：生成摘要、组装新列表、防抖统计

`compress()` 的 `context_compressor.py:1581` 调 `_generate_summary()` 生成摘要（8.5 详述），然后 `context_compressor.py:1584-1664` 组装压缩后的消息列表：

1. **头部**——逐条复制保护的头部消息。给系统提示注入一段压缩说明（`context_compressor.py:1589`），告诉模型"早期对话已被压成 handoff 摘要，基于摘要和当前状态继续工作，别重做"。
2. **摘要消息**——把生成的摘要作为一条独立消息插入。这里有大量逻辑（`context_compressor.py:1613-1648`）处理摘要消息该用什么 `role`：要避免和前后消息形成连续同角色（很多 API 不接受连续两条 user 或两条 assistant）。如果两个角色都会撞车，就把摘要并进尾部第一条消息（`_merge_summary_into_tail`）。
3. **尾部**——逐条复制保护的尾部消息。

如果 `_generate_summary()` 失败返回了空，`compress()` 不会静默丢掉中间区，而是插入一个静态兜底标记（`context_compressor.py:1599-1611`），明确告诉模型"N 条消息被移除以释放上下文空间，但无法摘要"——让模型知道上下文丢了，而不是莫名其妙地缺一块。

组装完成后还有两步收尾：

- `_sanitize_tool_pairs()`（`context_compressor.py:1226`）——再扫一遍，清理任何残留的孤儿 tool_call/result 对。
- `_strip_historical_media()`（`context_compressor.py:275`）——把最新一条带图消息之前的所有图片部分替换成短文本占位符。`context_compressor.py:1670-1675` 的注释解释：不这么做的话，尾部消息会永远保留原始的几 MB base64 图片负载，可能把后续每个 API 请求都顶过提供商的请求体大小上限，把会话卡死。

最后是**防抖统计**（`context_compressor.py:1678-1687`）：

```python
new_estimate = estimate_messages_tokens_rough(compressed)
saved_estimate = display_tokens - new_estimate
savings_pct = (saved_estimate / display_tokens * 100) if display_tokens > 0 else 0
self._last_compression_savings_pct = savings_pct
if savings_pct < 10:
    self._ineffective_compression_count += 1
else:
    self._ineffective_compression_count = 0
```

这就是 8.4.1 里 `should_compress()` 读取的 `_ineffective_compression_count`。节省不到 10% 就累加，否则清零。连续两次无效后压缩被禁用。

## 8.5 结构化摘要：让模型不重复执行

`_generate_summary()`（`context_compressor.py:901`）是压缩器里唯一调 LLM 的地方。它通过[第 7 章](07-model-providers.md)的辅助客户端 `call_llm(task="compression")` 调用一个**便宜的辅助模型**（不是主对话那个旗舰模型）来生成摘要。这里有两个核心设计决策。

### 8.5.1 SUMMARY_PREFIX：防止模型把摘要当指令

摘要被插入消息历史后，下一个模型会读到它。问题来了：摘要里写着"用户要求重构 auth 模块"——下一个模型会不会以为这是**现在**的指令，于是又去重构一遍 auth 模块？

`SUMMARY_PREFIX`（`context_compressor.py:37`）就是用来防这个的。它是一段长前缀，每份摘要都以它开头：

```python
SUMMARY_PREFIX = (
    "[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted "
    "into the summary below. This is a handoff from a previous context "
    "window — treat it as background reference, NOT as active instructions. "
    "Do NOT answer questions or fulfill requests mentioned in this summary; "
    "they were already addressed. "
    "Your current task is identified in the '## Active Task' section of the "
    "summary — resume exactly from there. "
    "IMPORTANT: Your persistent memory (MEMORY.md, USER.md) in the system "
    "prompt is ALWAYS authoritative and active ... "
    "Respond ONLY to the latest user message "
    "that appears AFTER this summary. ..."
)
```

这段前缀做了几件事：明确声明"这是参考资料，不是活跃指令"；明确说"不要回答摘要里提到的问题，它们已经处理过了";把"当前任务"重定向到摘要的 `## Active Task` 小节；同时提醒持久记忆（MEMORY.md/USER.md，参见[第 10 章](10-memory-system.md)）依然权威——压缩说明不能让模型忽视记忆。

`_with_summary_prefix()`（`context_compressor.py:1191`）给摘要加前缀，`_strip_summary_prefix()`（`context_compressor.py:1182`）剥掉它，`_is_context_summary_content()`（`context_compressor.py:1197`）判断一条消息是不是摘要——它同时认 `SUMMARY_PREFIX` 和 `LEGACY_SUMMARY_PREFIX`（`context_compressor.py:52`，老版本用的旧前缀，为向后兼容保留）。

即便有前缀，弱模型仍可能把摘要里 `## Active Task` 那段对历史用户请求的逐字引用当成新输入（`context_compressor.py:1636-1637` 引用 issue #11475、#14521）。所以当摘要落成独立 `role="user"` 消息时，`compress()` 还会在末尾追加一个显式结束标记（`context_compressor.py:1640-1645`）：`--- END OF CONTEXT SUMMARY — respond to the message below, not the summary above ---`。

### 8.5.2 Resolved / Pending 结构化模板

`_generate_summary()` 不让摘要器自由发挥，而是给它一个**严格的结构化模板**（`context_compressor.py:948-1005`）。模板分成十几个固定小节，最关键的几个：

```text
## Active Task          ← 最重要的字段。逐字抄用户最近的请求。
## Goal                 ← 用户整体想达成什么
## Constraints & Preferences
## Completed Actions     ← 编号列表，每条含工具/目标/结果
## Active State          ← 当前工作状态（目录、分支、改过的文件、测试状态）
## In Progress
## Blocked               ← 阻塞点、错误，含确切错误消息
## Key Decisions
## Resolved Questions    ← 已经回答过的问题（含答案，避免重复）
## Pending User Asks     ← 尚未回答/完成的用户请求
## Relevant Files
## Remaining Work
## Critical Context      ← 不显式保留就会丢的具体值
```

`## Resolved Questions` 和 `## Pending User Asks` 这对小节正是为 8.5.1 的问题服务的——把"已解决"和"待办"明确分开。已解决的问题连答案一起记下来，让下一个模型知道"这个不用再答了";待办的明确列出，让任务不丢失。`## Active Task` 被模板标注为"THE SINGLE MOST IMPORTANT FIELD"，要求逐字复制用户最近的请求——这是任务连续性的命脉。

模板还反复强调"NEVER include API keys, tokens, passwords"（`context_compressor.py:941-944`、`context_compressor.py:1001`），凡是凭证一律替换成 `[REDACTED]`——摘要会被持久化进会话数据库（[第 9 章](09-session-storage.md)），绝不能把密钥写进去。摘要器前导语（`_summarizer_preamble`，`context_compressor.py:933`）还要求"用用户在对话里用的语言写摘要，不要翻译成英文"——一个中文会话压缩后摘要也该是中文。

### 8.5.3 迭代式摘要更新

如果会话已经被压缩过一次（`self._previous_summary` 非空），第二次压缩**不会从头重新摘要**，而是做迭代更新（`context_compressor.py:1007-1019`）。提示词变成"这是上一次压缩的摘要，新发生了这些轮次，把它们并进去"——保留所有仍相关的信息、把新的已完成动作续编号加进列表、把"In Progress"里完成的项移到"Completed Actions"、把已回答的问题移到"Resolved Questions"。

为什么要迭代而不是重新摘要？因为重新摘要会逐渐丢失信息——第三次压缩时，第一次压缩之前的细节早已不在输入里了。迭代更新让摘要成为一份**持续维护的活文档**，越早的信息越浓缩但不会凭空消失。

`_previous_summary` 这个状态有个微妙的恢复问题：进程重启后从会话数据库恢复一个已压缩过的会话时，`_previous_summary` 是空的（内存状态没了），但消息历史里其实有一条上次压缩留下的摘要消息。如果不处理，下一次压缩会把这条旧摘要当成普通中间消息重新摘要——等于摘要的摘要，信息再损失一层。`compress()` 的 `context_compressor.py:1547-1556` 解决了这点：它在压缩窗口里调 `_find_latest_context_summary()` 找最近一条摘要消息，找到就把它的正文**回灌**进 `_previous_summary`，并把 `turns_to_summarize` 截到那条摘要之后——这样恢复出来的会话第一次压缩就能正确走迭代更新路径，而不是从头摘要。这是"摘要状态"和"会话持久化"两个系统之间的一个接缝处理。

`_generate_summary()` 还有失败处理：`_summary_failure_cooldown_until`（`context_compressor.py:919-925`）——摘要连续失败后进入冷却期（`_SUMMARY_FAILURE_COOLDOWN_SECONDS = 600`，`context_compressor.py:76`），冷却期内直接返回 `None`，让 `compress()` 走静态兜底，不去反复撞一个坏掉的辅助模型。`_fallback_to_main_for_compression()`（`context_compressor.py:874`）则在配置的辅助模型出错时退回用主模型做摘要，并记录失败信息让对话循环能提醒用户"你 config.yaml 里的 auxiliary.compression.model 坏了"。

### 8.5.4 摘要预算与喂给摘要器的输入裁剪

摘要本身也要控制长度——一份摘要太长就违背了压缩的初衷，太短又会丢信息。`_compute_summary_budget()`（`context_compressor.py:799-808`）让预算**随被压内容的体量浮动**：

```python
content_tokens = estimate_messages_tokens_rough(turns_to_summarize)
budget = int(content_tokens * _SUMMARY_RATIO)
return max(_MIN_SUMMARY_TOKENS, min(budget, self.max_summary_tokens))
```

预算是"被压内容 token 数 × `_SUMMARY_RATIO`"，再夹在 `[_MIN_SUMMARY_TOKENS, max_summary_tokens]` 之间。`max_summary_tokens` 本身随模型上下文窗口缩放（约窗口的 5%，封顶 `_SUMMARY_TOKENS_CEILING`），docstring（`context_compressor.py:802-804`）解释这是为了让大窗口模型拿到更丰富的摘要，而不是被硬卡在固定的 8K。算出预算后，`_generate_summary()` 把它写进模板的 `Target ~{summary_budget} tokens` 一行，并把 `call_llm` 的 `max_tokens` 设为 `summary_budget * 1.3`（`context_compressor.py:1054`）——留 30% 余量给模型不严格守目标的情况。

另一个值得分清的概念是**喂给摘要器的输入裁剪**。摘要器自己也有上下文窗口，被压的中间区可能比它还大，所以 `_serialize_for_summary()`（`context_compressor.py:819`）在序列化每条消息时按一组常数截断（`context_compressor.py:813-817`）：

```python
_CONTENT_MAX = 6000       # 每条消息正文总字符上限
_CONTENT_HEAD = 4000      # 从开头保留的字符
_CONTENT_TAIL = 1500      # 从结尾保留的字符
_TOOL_ARGS_MAX = 1500     # 工具调用参数字符上限
_TOOL_ARGS_HEAD = 1200    # 从参数开头保留的字符
```

超过 `_CONTENT_MAX` 的消息正文被截成"开头 4000 字符 + `...[truncated]...` + 结尾 1500 字符"——头尾都留，因为一段文件内容或命令输出往往开头（路径、命令）和结尾（结果、错误）都关键。注意这套截断和阶段一的 `_prune_old_tool_results()` 是两回事：修剪改的是**会回传给主模型**的真实消息历史，而这里的截断只影响**喂给摘要器**的临时序列化文本，原始 `turns_to_summarize` 不变。`_serialize_for_summary()` 还在序列化前对所有内容跑 `redact_sensitive_text()`，凭证在到达辅助模型之前就被抹掉——双保险，因为模板里也写了"NEVER include API keys"，但不能指望摘要器一定遵守。

## 8.6 在线压缩在对话循环里的位置

在线压缩的"在线"二字，关键在于它**实时**发生、而且要**防延迟**。`agent/conversation_compression.py` 是连接压缩器和对话循环的胶水层。它的模块 docstring（`conversation_compression.py:1-27`）列出了三个关注点，其中 `compress_context()`（`conversation_compression.py:243`）是实际的压缩调用。

### 8.6.1 为什么要"预检"压缩

普通的压缩时机是：API 调用返回后，从 `usage` 里拿到真实的 `prompt_tokens`，`should_compress()` 判断超阈值，下一轮之前压缩。但这有个问题——如果这一轮历史已经很长，**这次 API 调用本身就可能爆窗或者非常慢**。等到响应回来再压就晚了。

这就是 `should_compress_preflight()`（`context_engine.py:105`）存在的意义。它在 API 调用**之前**做一个廉价的粗估（用 `estimate_messages_tokens_rough` 算字符数，不需要真实 token 计数），如果粗估已经超阈值，就在发请求前先压一次。`conversation_compression.py` 的 docstring 把 `compress_context` 描述为"the actual compression call"——对话循环在预检命中时就调它，实时压缩，避免那次注定慢或失败的 API 往返。

`check_compression_model_feasibility()`（`conversation_compression.py:44`）是另一个相关函数：会话启动时探测配置的辅助压缩模型，如果它的上下文窗口装不下主模型的压缩阈值（辅助模型太小，摘要时塞不下要摘要的内容），就发警告，可能时自动调低会话阈值。

### 8.6.2 手动压缩反馈

用户可以用 `/compress` 命令手动触发压缩。`agent/manual_compression_feedback.py`（仅 49 行）提供 `summarize_manual_compression()`——给手动压缩生成一致的用户可见反馈。它对比压缩前后的消息数和 token 数，处理几种情况：

- **无变化**（`noop`）——压缩没改变任何东西，报"No changes from compression"。
- **正常压缩**——报 `Compressed: 50 → 12 messages`、`~80,000 → ~25,000 tokens`。
- **反直觉情况**——消息变少了但 token 估算反而变多了。这时加一条 note 解释（`manual_compression_feedback.py:38-42`）：压缩把对话重写成了更密集的摘要，更少的消息也可能抬高估算。

这个小模块单独存在，是因为手动压缩的反馈措辞需要在 CLI 和网关多个调用点保持一致。

### 8.6.3 图片过大的恢复

`try_shrink_image_parts_in_messages()`（`conversation_compression.py:438`）是一个特殊的恢复路径。当 API 因为请求体里的图片太大（Anthropic 限 5MB）而拒绝请求时，这个函数把 `data:image/...;base64,...` 的图片部分用更小的尺寸重新编码，让重试能压进提供商的体积上限。`_shrink_data_url()`（`conversation_compression.py:472`）是它的内部实现。这和 8.4.4 的 `_strip_historical_media()` 是配套的——一个预防（压缩时剥旧图）、一个补救（请求被拒后缩图重试）。

### 8.6.4 压缩为什么要开新会话：parent_session_id 链

一个容易忽略但很重要的事实：**每次在线压缩都会把当前会话拆成一条新会话**。`compress_context()` 在压完消息后，如果有会话数据库，会执行一段会话轮转逻辑（`conversation_compression.py:336-353`）：

```python
agent.commit_memory_session(messages)
agent._session_db.end_session(agent.session_id, "compression")
old_session_id = agent.session_id
agent.session_id = f"{datetime.now().strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
...
agent._session_db.create_session(
    session_id=agent.session_id,
    ...
    parent_session_id=old_session_id,
)
```

旧会话被 `end_session(..., "compression")` 标记结束，一条全新的会话被创建，新会话的 `parent_session_id` 指向旧会话——形成一条**会话血统链**。压缩可能发生多次，于是链可以是 `A → B → C → ...`，每一段都是一次压缩边界。

为什么压缩要拆会话，而不是就地改写当前会话？三个理由。第一，**会话存储的不可变性**——[第 9 章](09-session-storage.md)的会话数据库把每条会话当作一段不可变的消息记录；压缩是一次破坏性重写（中间区被摘要替换），如果就地改写，旧的完整历史就永久丢了。拆成新会话后，旧会话 `A` 里仍然保留压缩前的完整 transcript，可以回看、可以做训练数据、可以全文搜索。第二，**血统可追溯**——`get_next_title_in_lineage()`（`conversation_compression.py:357`）会给续接会话自动编号标题（如 `My Task (2)`），用户在会话列表里能看出这几段属于同一个逻辑任务。第三，**插件引擎的连续性**——压缩轮转后调 `on_session_start(..., boundary_reason="compression", old_session_id=...)`（`conversation_compression.py:374-378`），让有持久状态的插件引擎（如 LCM 的 DAG）能区分"压缩导致的轮转"和"用户 `/new` 开的全新会话"——前者要保留 DAG 血统，后者要重置。同理 `memory_manager.on_session_switch(..., reset=False, reason="compression")`（`conversation_compression.py:387-392`）告诉记忆系统逻辑对话仍在继续、只是 id 滚动了。

所以一句话总结：**在线压缩在内存里压消息列表，在存储层拆会话**。这两件事在 `compress_context()` 里是连在一起做的，理解压缩就必须理解它和会话拆分链是一体两面。

## 8.7 离线轨迹压缩

`trajectory_compressor.py`（1508 行）是一个**完全独立的批处理脚本**，不是对话循环的一部分。它的用途和在线压缩完全不同——它压缩磁盘上的 JSONL 轨迹目录，用于**训练数据准备**。

### 8.7.1 用途与用法

模块顶部的注释（`trajectory_compressor.py:24-30`）给出了典型命令行用法：

```bash
python trajectory_compressor.py --input=data/trajectories.jsonl --sample_percent=15
python trajectory_compressor.py --input=data/my_run --sample_percent=10
```

它读取 agent 跑过的轨迹（每条轨迹是一串 turn——`system`/`human`/`gpt`/`tool` 角色的消息），把过长的轨迹压缩到一个目标 token 数以下，输出新的 JSONL。压缩后的数据用于训练或微调模型——一个 agent 框架要自我改进（这是 Hermes 的核心定位），就需要把历史轨迹整理成适合训练的形态。

`main()`（`trajectory_compressor.py:1290`）是入口。`--sample_percent` 参数（`trajectory_compressor.py:1296`）让你只采样一部分轨迹再压缩——准备训练数据时往往不需要全量。

### 8.7.2 CompressionConfig

离线压缩的配置是 `CompressionConfig`（`trajectory_compressor.py:82`），一个 dataclass，可以从 YAML 加载（`from_yaml()`，`trajectory_compressor.py:126`）。关键字段：

```python
@dataclass
class CompressionConfig:
    # Tokenizer
    tokenizer_name: str = "moonshotai/Kimi-K2-Thinking"

    # 压缩目标
    target_max_tokens: int = 15250
    summary_target_tokens: int = 750

    # 保护的轮次
    protect_first_system: bool = True
    protect_first_human: bool = True
    protect_first_gpt: bool = True
    protect_first_tool: bool = True
    protect_last_n_turns: int = 4

    # 摘要（OpenRouter）
    summarization_model: str = "google/gemini-3-flash-preview"
    base_url: str = OPENROUTER_BASE_URL
    api_key_env: str = "OPENROUTER_API_KEY"

    # 处理
    num_workers: int = 4
    max_concurrent_requests: int = 50
```

注意它和在线压缩器的相似之处：都有"保护头部 + 保护尾部 + 摘要中间"的结构，都用一个便宜的辅助模型生成摘要。`protect_first_*` 四个布尔分别保护第一个 system/human/gpt/tool 轮次，`protect_last_n_turns=4` 保护最后 4 轮。

`_find_protected_indices()`（`trajectory_compressor.py:482`）实现保护逻辑——遍历轨迹找出每种角色的首次出现，加进 `protected` 集合；再把最后 N 轮加进去；然后算出可压缩区域 `[compressible_start, compressible_end)`：

```python
# 保护首批轮次
if self.config.protect_first_system and first_system is not None:
    protected.add(first_system)
# ... human / gpt / tool 同理 ...

# 保护最后 N 轮
for i in range(max(0, n - self.config.protect_last_n_turns), n):
    protected.add(i)
```

### 8.7.3 采样与可复现性

`--sample_percent` 让你只压一部分轨迹——准备训练数据时往往不需要全量，先采样能省下大量 API 调用和时间。`main()` 的采样逻辑（`trajectory_compressor.py:1391-1395`）很简单：

```python
if sample_percent is not None:
    random.seed(seed)
    sample_size = max(1, int(total_entries * sample_percent / 100))
    entries = random.sample(entries, sample_size)
```

关键是 `random.seed(seed)`——`seed` 参数默认 `42`（`trajectory_compressor.py:1297`），意味着**采样是可复现的**：同一个输入文件、同一个 `sample_percent`、同一个 `seed`，每次跑出来的子集完全一样。这对训练数据准备很重要——实验要可重复，不能每次跑出不同的训练集。`sample_size` 用 `max(1, ...)` 兜底，保证哪怕百分比算出来是 0 也至少采一条。

输入是目录时（`trajectory_compressor.py:1447-1473`）逻辑略有不同：**从每个文件分别采样**而不是全局采样，且每个文件采样前都重新 `random.seed(seed)`——这样单个文件的采样结果不依赖目录里文件的处理顺序，可复现性更强。

### 8.7.4 高并发批处理

离线压缩面对的是磁盘上成千上万条轨迹，吞吐量是第一目标。`process_directory()`（`trajectory_compressor.py:975`）是同步入口，但它内部 `asyncio.run()` 进一个全异步的 `_process_directory_async()`。并发由一个信号量控制（`trajectory_compressor.py:1031`）：

```python
semaphore = asyncio.Semaphore(self.config.max_concurrent_requests)
```

`max_concurrent_requests` 默认 50——同时最多 50 个摘要请求在飞，避免一次性把几千个请求砸向 OpenRouter 触发限流。每条轨迹的压缩用 `asyncio.wait_for()` 包了超时（`trajectory_compressor.py:1058`），单条卡死不会拖垮整批。失败的请求走 `jittered_backoff()` 带抖动的指数退避重试（`trajectory_compressor.py:704`）。整批用 `asyncio.gather()`（`trajectory_compressor.py:1143`）收尾。`CompressionConfig` 里的 `num_workers`（默认 4）是另一层并行度。这套"信号量限流 + 超时隔离 + 退避重试 + gather 汇聚"的组合，是离线压缩区别于在线压缩最明显的工程特征——在线压缩是单会话串行的，根本不需要这些。

统计上，`TrajectoryMetrics`（`trajectory_compressor.py:183`）记录单条轨迹的压缩前后 token 数、压缩比等，`AggregateMetrics`（`trajectory_compressor.py:228`）汇总整批——跑完一批能直接看到"平均压缩比 X%、Y 条失败"。

### 8.7.5 在线压缩 vs 离线压缩

两套压缩的对比：

| 维度 | 在线压缩 `ContextCompressor` | 离线压缩 `TrajectoryCompressor` |
| --- | --- | --- |
| 触发 | 会话进行中，token 超阈值 | 手动跑脚本 |
| 输入 | 内存里的活跃消息列表 | 磁盘上的 JSONL 轨迹目录 |
| 目的 | 防止下一次 API 调用爆窗 | 准备训练数据 |
| 摘要模型 | 辅助客户端路由（main→OpenRouter→…） | 固定走 OpenRouter |
| 保护策略 | 系统提示 + protect_first_n + 按 token 预算的尾部 | 首个 system/human/gpt/tool + 最后 N 轮 |
| 迭代摘要 | 是（`_previous_summary`） | 否（一次性） |
| 并发 | 单会话，串行 | `num_workers` + `max_concurrent_requests` 高并发 |
| 防抖 | 有（连续无效则禁用） | 无（批处理一次性） |
| 采样 | 无 | 有（`--sample_percent`） |

**共同的核心思想**是一致的：长对话／长轨迹无法整体保留，于是用"保护承重的头尾、用便宜模型摘要可丢弃的中间"这个策略，在保留关键信息的前提下把长度压下去。在线压缩追求的是低延迟和任务连续性（所以有预检、迭代摘要、防抖、`SUMMARY_PREFIX`），离线压缩追求的是吞吐量（所以有高并发、采样）。两者是同一个抽象思想在两种约束下的不同落地。

`TrajectoryCompressor`（`trajectory_compressor.py:332`）单条轨迹的压缩入口是 `compress_trajectory()`（`trajectory_compressor.py:709`）及其异步版本——它复用 `_find_protected_indices()` 定位可压缩区间，再调辅助模型生成摘要，逻辑上和在线压缩器的 `compress()` 同构，区别只在保护策略和无迭代摘要（见上表）。8.7.4 的批处理、统计都是围绕这个单条入口展开的高吞吐包装。

## 8.8 ContextEngine 作为插件

回到 8.2 开头：上下文引擎是可替换的。`config.yaml` 的 `context.engine` 选哪个引擎，默认 `compressor`。`plugins/context_engine/` 目录是放第三方引擎的地方。一个第三方引擎只需要继承 `ContextEngine`、实现三个 `@abstractmethod`，就能完全替换内置的 `ContextCompressor`——它可以用完全不同的算法（比如 LCM 的 DAG 上下文模型），可以通过 `get_tool_schemas()` 给 agent 暴露自己的检索工具，对话循环对此一无所知。

这正是 8.2 那个抽象基类的回报：上下文管理从对话循环里彻底解耦出来，成为一个可插拔的策略。插件的注册和发现机制参见[第 12 章](12-plugin-system.md)。

### 8.8.1 替换引擎需要满足的契约

一个第三方上下文引擎要能"无痛替换" `ContextCompressor`，必须严格满足 `ContextEngine` ABC 的契约——不只是实现三个 `@abstractmethod`，还包括维护那组共享 token 状态字段。对话循环不会去问引擎"你是哪种引擎"，它只做这几件事：

<svg viewBox="0 0 800 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Engine contract from the conversation loop's perspective">
  <defs>
    <marker id="r8ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="24" font-size="13" font-weight="700" fill="currentColor">对话循环视角下的引擎契约</text>
  <rect x="20" y="36" width="160" height="220" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="100" y="150" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">对话循环</text>
  <rect x="540" y="36" width="240" height="220" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="660" y="58" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">ContextEngine</text>
  <text x="660" y="76" font-size="10" fill="#64748b" text-anchor="middle">维护共享 token 状态字段</text>
  <rect x="200" y="48" width="320" height="34" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="210" y="69" font-size="10" fill="currentColor">API 调用前 → should_compress_preflight(msgs)</text>
  <line x1="520" y1="65" x2="538" y2="65" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
  <rect x="200" y="92" width="320" height="34" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="210" y="113" font-size="10" fill="currentColor">每次 API 响应后 → update_from_response(usage)</text>
  <line x1="520" y1="109" x2="538" y2="109" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
  <rect x="200" y="136" width="320" height="34" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="210" y="157" font-size="10" fill="currentColor">API 响应后 → should_compress(prompt_tokens)</text>
  <line x1="520" y1="153" x2="538" y2="153" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
  <rect x="200" y="180" width="320" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
  <text x="210" y="201" font-size="10" fill="currentColor">判定 True → messages = compress(messages, …)</text>
  <line x1="520" y1="197" x2="538" y2="197" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
  <rect x="200" y="224" width="320" height="34" rx="5" fill="#99f6e4" stroke="#0d9488"/>
  <text x="210" y="245" font-size="10" fill="currentColor">显示/日志 ← 直接读 last_prompt_tokens / …</text>
  <line x1="538" y1="241" x2="520" y2="241" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r8ar4)"/>
</svg>
<span class="figure-caption">图 R8.4 ｜ 对话循环只通过五个调用点和一组共享 token 字段与引擎交互，完全不关心引擎内部算法。</span>

<details>
<summary>ASCII 原版</summary>

```text
对话循环视角下的引擎契约
  ── 每次 API 响应后 ── engine.update_from_response(usage)
                         （引擎必须更新 last_prompt_tokens 等字段）
  ── API 调用前 ──────── engine.should_compress_preflight(messages)
  ── API 响应后 ──────── engine.should_compress(prompt_tokens)
  ── 判定为 True ──────── messages = engine.compress(messages, ...)
  ── 显示/日志 ───────── 直接读 engine.last_prompt_tokens / threshold_tokens / ...
```

</details>

只要引擎诚实地维护共享字段、`compress()` 返回的列表是合法的 OpenAI 格式消息序列，对话循环就完全不在乎它内部用了摘要、DAG 还是别的什么。这就是为什么 `ContextEngine` 把那组 token 状态字段定为契约的一部分——它们是引擎和循环之间唯一的"公共数据接口"。

引擎还可以**主动扩展 agent 能力**：通过 `get_tool_schemas()` 和 `handle_tool_call()` 给 agent 注册自己的工具。`ContextCompressor` 这两个方法返回空——它是个纯被动引擎，不给 agent 加任何工具。但一个基于检索的引擎可以在这里返回 `lcm_grep`、`lcm_expand` 这类工具的 schema，让 agent 能**主动查询**被压缩的历史，而不是只能依赖一份静态摘要。这是"压缩"和"检索"两种上下文管理哲学的分野，而 `ContextEngine` 抽象层让两者能在同一个对话循环里互换。

## 8.9 本章小结

- **抽象层**——`ContextEngine`（`context_engine.py:32`）是可插拔的上下文引擎 ABC。三个 `@abstractmethod`（`update_from_response`/`should_compress`/`compress`）定义核心接口，一组共享 token 状态字段供对话循环读取，`config.yaml` 的 `context.engine` 选择引擎。
- **默认实现**——`ContextCompressor`（`context_compressor.py:454`）的算法是"保护头尾、摘要中间"。`compress()`（`context_compressor.py:1482`）分四阶段：廉价修剪老旧工具结果（无 LLM）→ 确定头尾边界（按 token 预算、对齐 tool_call 组）→ 用结构化模板让辅助 LLM 生成摘要 → 组装新列表并做防抖统计。
- **预算货币**——压缩器全程用"字符长度 / 4"作 token 代理货币（性能、无 tokenizer 依赖、够用），图片折算成 `1600 * 4` 字符当量；尾部预算 `tail_token_budget` 绑在 `threshold_tokens` 上随模型缩放，带 1.5 倍软上限避免切进超大消息。
- **关键设计**——`SUMMARY_PREFIX`（`context_compressor.py:37`）防止模型把摘要当成活跃指令；Resolved/Pending 结构化模板把"已解决"和"待办"分开；迭代式摘要更新让摘要成为持续维护的活文档，恢复会话时回灌 `_previous_summary`；摘要预算随被压体量浮动并随模型窗口缩放。
- **在线特性**——`should_compress_preflight()` 让压缩在 API 调用前发生，避免爆窗延迟；`manual_compression_feedback.py` 给手动 `/compress` 一致反馈；`try_shrink_image_parts_in_messages()` 在请求被拒后缩图重试。每次在线压缩在存储层把会话拆成一条新会话，`parent_session_id` 形成可追溯的血统链。
- **离线轨迹压缩**——`trajectory_compressor.py` 是独立的批处理脚本，用 `CompressionConfig`（`trajectory_compressor.py:82`）配置，把 JSONL 轨迹目录压缩用于训练数据准备。它和在线压缩共享"保护头尾、摘要中间"的核心思想，但追求吞吐量而非低延迟——固定 `seed` 的可复现采样、信号量限流的高并发批处理是它独有的工程特征。

## 延伸阅读

- [第 3 章 同步工具调用循环](03-tool-loop.md)——上下文压缩在工具循环的每一轮之间被触发。
- [第 7 章 模型 Provider 适配与凭证池](07-model-providers.md)——压缩阈值依赖 `get_model_context_length()` 给出的上下文上限，摘要生成走 `call_llm(task="compression")` 辅助客户端。
- [第 9 章 会话存储与全文搜索](09-session-storage.md)——压缩触发时会话通过 `parent_session_id` 链分裂，压缩摘要被持久化进会话数据库。
- [第 10 章 记忆系统](10-memory-system.md)——`SUMMARY_PREFIX` 反复强调 MEMORY.md/USER.md 持久记忆的权威性，压缩不能让模型忽视记忆。
- [第 12 章 插件系统](12-plugin-system.md)——`ContextEngine` 作为可插拔引擎，第三方实现放在 `plugins/context_engine/`。
