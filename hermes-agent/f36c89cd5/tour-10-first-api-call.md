# Trace 步骤 10 —— 第一次 LLM API 调用，请求是怎么发出去的？

## 1. 当前情境

上一步（[步骤 09](tour-09-memory-prefetch.md)）结束时，`api_messages` 已经组装完毕。它是一个干净的列表：

```text
api_messages = [
    {"role": "system",  "content": "<SOUL.md + 工具定义 + 记忆...>"},
    {"role": "user",    "content": "读取 README.md 并告诉我它的第一行是什么"},
]
```

请求体已经做过一连串净化——`tool_call` 参数修复（`conversation_loop.py:649`）、role 交替修复（`:668`）、surrogate 字符清洗（`:815`）、prompt caching 断点注入（`:756`）。状态表里此刻 `api_call_count=0`，`messages=[system, user]`，还没有任何 `response` 对象。

这一步要回答的是整条 trace 里最关键的一跳：这个统一格式的消息列表，是怎么变成一个真实的 HTTP 请求、打到某个模型服务商、再把响应拿回来的。

## 2. 问题

Hermes 要支持的"模型来源"远不止一个 OpenAI。它要能对接：

- OpenAI 官方、以及任何 OpenAI 兼容网关（vLLM、llama.cpp、Ollama、OpenRouter、Fireworks、Mistral……）——走 chat completions 协议；
- Anthropic 官方 `messages` API——请求结构和 OpenAI 完全不同（system 是独立顶层字段、`content` 是 block 数组、tool 结果格式不一样）；
- OpenAI 的新 Responses API（Codex 系）——又是第三套结构；
- AWS Bedrock 的 `converse` 协议——第四套。

而对话循环 `conversation_loop.py` 本身**不应该知道**这些差异。它手里只有一个统一格式的 `api_messages` 和一句"把它发出去"。同时还有两个隐藏约束：

- **凭证不止一份**。同一个 provider 用户可能配了多把 key（多个 OpenRouter 账号、多个 ChatGPT 订阅），一把被限流了要能自动切下一把。
- **请求必须可重试可降级**。第一把 key 撞 429、provider 整个挂掉，循环要能切到 fallback provider 重来——这要求"发请求"这件事是一个能被反复调用的封装，而不是一段写死的代码。

## 3. 朴素思路

最直接的写法：在对话循环里直接 `import openai`，构造一个 client，把 `api_messages` 原样传给 `client.chat.completions.create(...)`，拿回 `response`。

要支持 Anthropic？加一个 `if provider == "anthropic"` 分支，里头 `import anthropic`，手动把 messages 转成 Anthropic 格式。再支持 Bedrock？再加一个 `elif`。凭证轮换？在调用前加一句 `api_key = keys[current_index]`。

看起来能跑，而且"按需加分支"很自然。

## 4. 为什么朴素思路会崩

`if provider == ...` 的分支会像癌一样扩散：

- **格式转换逻辑无处安放**。"OpenAI 消息 → Anthropic 消息"不是一句话，是几百行：system 字段要抽出来、`tool` 角色要变成 `tool_result` block、`tool_calls` 要变成 `tool_use` block、reasoning 字段要映射到 `thinking` block。把这几百行塞进对话循环的 `elif` 分支里，循环本身就没法读了。而且响应方向还要反着转一遍（Anthropic 响应 → 统一格式），分支数量直接翻倍。
- **每个 provider 还有几十个小怪癖**。Kimi 不接受 `temperature` 字段、Mistral 拒绝未知字段、Moonshot 要求 assistant 消息带独立的 `reasoning_content`、OpenCode Zen 的 WAF 会因为 User-Agent 返回 403……这些怪癖如果散落在对话循环里，就是几十个互相纠缠的布尔标志。`providers/base.py:7-9` 的注释点破了这件事：transport "读这个（profile）而不是收 20 多个布尔标志"。
- **凭证轮换和"发请求"耦合死**。如果轮换索引写在调用点旁边，那 fallback、限流冷却、OAuth token 刷新就全得在对话循环里实现——而这些逻辑跟"对话"毫无关系。
- **测试无从下手**。想单测"Anthropic 格式转换对不对"，却必须把整个对话循环拉起来。

核心矛盾：对话循环关心的是"对话的逻辑流程"，provider 差异关心的是"协议和凭证"。这是两件正交的事，硬塞在一起两边都写不干净。

## 5. Hermes 的做法

Hermes 在对话循环和真实 provider 之间插了**两层抽象**，把"协议差异"和"凭证管理"各自关进一个盒子。

**第一层：ProviderProfile —— 声明式的 provider 描述。** `providers/base.py:38` 的 `ProviderProfile` 是一个 `@dataclass`，它把一个 provider 的所有信息集中声明在一处：身份（`name`、`api_mode`）、认证与端点（`base_url`、`auth_type`、`env_vars`）、客户端级怪癖（`default_headers`）、请求级怪癖（`fixed_temperature`、`default_max_tokens`）。注释把它的定位写得很死（`base.py:7-9`）：

```python
# Provider profiles are DECLARATIVE — they describe the provider's behavior.
# They do NOT own client construction, credential rotation, or streaming.
# Those stay on AIAgent.
```

`api_mode` 这个字段是路由的钥匙：`"chat_completions"`、`"anthropic_messages"`、`"codex_responses"`、`"bedrock_converse"` 四个值，决定了请求走哪套协议。复杂的 provider（Kimi、Codex）可以子类化 `ProviderProfile`，重写 `prepare_messages()`（`base.py:95`）和 `build_extra_body()`（`base.py:103`）这两个钩子来处理自家的怪癖——但对话循环看不到这些。

**第二层：transport —— 按 `api_mode` 选定的协议适配器。** `agent/transports/__init__.py:26` 的 `get_transport(api_mode)` 是一个注册表查找：传 `"anthropic_messages"` 返回 Anthropic transport，传 `"codex_responses"` 返回 Codex transport。transport 负责两个方向的转换——发请求时把统一格式转成 provider 专属请求，收响应时把 provider 响应 `normalize_response()` 回统一格式。对话循环只持有 `agent._get_transport()`，它从不写 `import anthropic`。

来看对话循环真正发请求的那几行（`conversation_loop.py:918-1012`）：

```python
api_kwargs = agent._build_api_kwargs(api_messages)      # :920  组装 provider 专属请求体
if agent.api_mode == "codex_responses":
    api_kwargs = agent._get_transport().preflight_kwargs(api_kwargs, allow_stream=False)  # :924

# ... 选流式还是非流式 ...

if _use_streaming:
    response = agent._interruptible_streaming_api_call(api_kwargs, on_first_delta=_stop_spinner)  # :1008
else:
    response = agent._interruptible_api_call(api_kwargs)  # :1012
```

`_build_api_kwargs()`（实现在 `chat_completion_helpers.py:233`）就是格式转换的入口——它内部按 `api_mode` 走不同的打包逻辑，需要时调 transport 和 profile 的钩子。对话循环这一段读起来只有"组装 → 发送 → 拿回 response"，provider 的名字一个都没出现。

**凭证池：CredentialPool 负责 failover。** `agent/credential_pool.py:387` 的 `CredentialPool` 把同一个 provider 的多份凭证（`PooledCredential` 列表）按 `priority` 排序持有：

```python
class CredentialPool:
    def __init__(self, provider: str, entries: List[PooledCredential]):
        self.provider = provider
        self._entries = sorted(entries, key=lambda entry: entry.priority)
        self._current_id: Optional[str] = None
        self._strategy = get_pool_strategy(provider)   # fill-first / round-robin ...
        self._lock = threading.Lock()
```

`select()`（`credential_pool.py:976`）在加锁下挑出一个**可用**凭证——`_available_entries()`（`:980`）会跳过仍在限流冷却里的条目（`last_status == STATUS_EXHAUSTED` 且冷却未到期，`:1034-1037`），还会顺手从磁盘 `~/.claude/.credentials.json` / `auth.json` 同步被别的进程刷新过的 OAuth token（`:994-1033`）。当一把 key 撞 429，`_mark_exhausted()`（`:425`）把它打上冷却标记并落盘，下次 `select()` 自动跳过它。对话循环侧的 `_recover_with_credential_pool()`（`run_agent.py:2820`，在 `conversation_loop.py:1895` 被调用）就是限流后从池里换一把 key 重试的入口。

整条链路连起来：

<svg viewBox="0 0 820 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Request path from build_api_kwargs through api_mode routing and credential pool to response">
  <defs>
    <marker id="ar10a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="20" width="340" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="40" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">_build_api_kwargs(api_messages)</text>
  <text x="410" y="55" text-anchor="middle" font-size="10" fill="#64748b">conversation_loop.py:920 — 按 agent.api_mode 选打包方式</text>
  <line x1="410" y1="64" x2="410" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10a)"/>
  <rect x="60" y="90" width="700" height="120" rx="8" fill="#fffbeb" stroke="#cbd5e1" stroke-width="1"/>
  <text x="76" y="110" font-size="11" font-weight="600" fill="#64748b">api_mode 路由</text>
  <rect x="76" y="118" width="668" height="22" rx="4" fill="#99f6e4" stroke="#0d9488" stroke-width="1"/>
  <text x="90" y="133" font-size="11" fill="currentColor">chat_completions → chat_completion_helpers</text>
  <rect x="76" y="144" width="668" height="22" rx="4" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="90" y="159" font-size="11" fill="currentColor">anthropic_messages → anthropic transport/adapter</text>
  <rect x="76" y="170" width="668" height="22" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1"/>
  <text x="90" y="185" font-size="11" fill="currentColor">codex_responses → codex_responses_adapter　｜　bedrock_converse → bedrock transport</text>
  <line x1="410" y1="210" x2="410" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10a)"/>
  <text x="425" y="226" font-size="10" fill="#64748b">provider 专属请求体 api_kwargs</text>
  <rect x="240" y="236" width="340" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="256" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">CredentialPool.select()</text>
  <text x="410" y="271" text-anchor="middle" font-size="10" fill="#64748b">取一把未冷却的凭证（429 → _mark_exhausted → 下次跳过）</text>
  <line x1="410" y1="280" x2="410" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10a)"/>
  <rect x="240" y="306" width="340" height="44" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="326" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">_interruptible_streaming_api_call(api_kwargs)</text>
  <text x="410" y="341" text-anchor="middle" font-size="10" fill="#64748b">真实 HTTP / SDK 调用，带 90s 停滞检测</text>
  <line x1="410" y1="350" x2="410" y2="372" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar10a)"/>
  <rect x="270" y="376" width="280" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="396" text-anchor="middle" font-size="13" font-weight="600" fill="currentColor">response</text>
  <text x="410" y="411" text-anchor="middle" font-size="10" fill="#64748b">含一个 read_file 的 tool_call</text>
</svg>
<span class="figure-caption">图 T10.1 ｜ 请求链路：_build_api_kwargs 按 api_mode 路由打包，CredentialPool 选凭证，流式调用拿回带 tool_call 的 response。</span>

<details>
<summary>ASCII 原版</summary>

```text
        conversation_loop.py:920  _build_api_kwargs(api_messages)
              │   按 agent.api_mode 选打包方式
              ▼
     ┌────────────────── api_mode 路由 ──────────────────┐
     │ chat_completions   → chat_completion_helpers      │
     │ anthropic_messages → anthropic transport/adapter  │
     │ codex_responses    → codex_responses_adapter      │
     │ bedrock_converse   → bedrock transport            │
     └───────────────────────────────────────────────────┘
              │   provider 专属请求体 api_kwargs
              ▼
        CredentialPool.select()  ── 取一把未冷却的凭证
              │   （撞 429 → _mark_exhausted → 下次跳过）
              ▼
        _interruptible_streaming_api_call(api_kwargs)
              │   真实 HTTP / SDK 调用，带 90s 停滞检测
              ▼
        response  ──（含一个 read_file 的 tool_call）
```

</details>

请求发出后，`_interruptible_streaming_api_call`（`chat_completion_helpers.py:1133`）回来一个 `response`。Hermes 默认**总是走流式路径**（`conversation_loop.py:983` `_use_streaming = True`），哪怕没有任何流式消费者——因为流式路径自带 90 秒停滞检测和 60 秒读超时（`:964-974` 注释），能防止 provider 用 SSE 心跳吊住连接却永不返回。拿回的 `response` 随后会过一道形状校验（`:1032-1110`，按 `api_mode` 分别校验 `choices` / `content` / `output`），校验不过就走 fallback。

本例里，模型读到"读取 README.md"，决定它需要先调工具——返回的 `response` 里带着一个 `tool_call`，`finish_reason="tool_calls"`。

## 6. 代码位置

按阅读顺序：

- 发请求主段：`agent/conversation_loop.py:918-1012` —— `_build_api_kwargs` → 选流式 → `_interruptible_streaming_api_call`。
- 请求体组装：`agent/chat_completion_helpers.py:233` —— `build_api_kwargs(agent, api_messages)`。
- 流式调用实现：`agent/chat_completion_helpers.py:1133` —— `interruptible_streaming_api_call`。
- transport 注册表：`agent/transports/__init__.py:26` —— `get_transport(api_mode)`。
- provider 声明：`providers/base.py:38` —— `ProviderProfile` dataclass；`base.py:95` `prepare_messages`、`base.py:103` `build_extra_body` 钩子。
- 凭证池：`agent/credential_pool.py:387` —— `CredentialPool.__init__`；`:976` `select()`；`:980` `_available_entries()`；`:425` `_mark_exhausted()`。
- 响应形状校验：`agent/conversation_loop.py:1032-1110`。

## 7. 分支与延伸

- provider profile 体系、四种 `api_mode`、各 transport 如何转换请求与响应、凭证池的 failover 策略 → [第 7 章 模型 Provider 适配](07-model-providers.md)。
- 上一步 `api_messages` 是怎么组装出来的（记忆 prefetch + 消息构造）→ [Trace 步骤 09](tour-09-memory-prefetch.md)。
- 下一步：`response` 回来了，对话循环如何从里头解析出 `tool_call` → [Trace 步骤 11](tour-11-parse-tool-call.md)。
- 如果第一把 key 撞 429 或 provider 整个挂掉，会走 `_recover_with_credential_pool` / fallback chain（`conversation_loop.py:1127-1133`、`:1895`）→ [第 7 章 §失败与降级](07-model-providers.md)。
- 第二次 API 调用（带工具结果再问）走的是同一段代码，只是 `messages` 更长 → [Trace 步骤 15](tour-15-second-api-call.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 对话循环和真实 provider 之间隔着**两层抽象**：`ProviderProfile`（声明式描述一个 provider）和 transport（按 `api_mode` 选定的协议适配器）——循环本身从不 `import anthropic`。
2. `api_mode` 是路由钥匙：`chat_completions` / `anthropic_messages` / `codex_responses` / `bedrock_converse` 四个值决定请求走哪套协议、响应怎么 normalize 回统一格式。
3. provider profile 是**声明式**的——它描述行为，但不拥有客户端构造、凭证轮换、流式（`providers/base.py:7-9`）；那些归 `AIAgent`。
4. `CredentialPool` 让同一 provider 的多份凭证可以 failover：`select()` 跳过限流冷却中的条目，`_mark_exhausted()` 在 429 后给凭证打冷却标记并落盘。
5. Hermes **默认总是走流式路径**，哪怕没有流式消费者——为的是流式自带的停滞/读超时检测，防止连接被吊死。

---

下一步：[Trace 步骤 11 —— 模型回了一个 tool_call，怎么解析？](tour-11-parse-tool-call.md)
