# 第 7 章 模型 Provider 适配与凭证池

> 代码版本锁定：`NousResearch/hermes-agent@f36c89cd5`（2026-05-17）。本章所有 `file:line` 引用均以此 commit 为准。

## 7.1 问题：一个 agent，二十种 API 形态

Hermes Agent 的核心是一个同步的工具调用循环（参见[第 3 章](03-tool-loop.md)）。这个循环每一轮都要调用一次大模型推理 API。问题在于：用户可以把 Hermes 接到几乎任意一家推理提供商上——OpenRouter、Anthropic、Google Gemini、AWS Bedrock、OpenAI Codex、xAI、Kimi、MiniMax、Copilot、本地 Ollama／LM Studio……而这些提供商的 API 在三个维度上彼此不同：

1. **传输协议形态**。绝大多数提供商兼容 OpenAI 的 `/v1/chat/completions`，但 Anthropic 用的是 Messages API（`messages` 数组 + `system` 字段 + `content` 块），OpenAI Codex 用的是新的 Responses API（`input` 项流 + `reasoning` 项），AWS Bedrock 用的是 Converse API（`boto3` SDK，不走 HTTP），Gemini 原生 REST 用的是 `contents` + `parts` 结构。
2. **认证形态**。有的用静态 API key（`Authorization: Bearer`），有的用 `x-api-key`，有的用 OAuth 设备码流（token 会过期、需要刷新、refresh token 单次有效），有的用 AWS 的 IAM 凭证链（环境变量／SSO profile／IMDS）。
3. **请求级怪癖**。Kimi 要求服务端自己管温度（不能发 `temperature`），OpenRouter 把推理配置放在 `extra_body.reasoning`，Anthropic 4.7 模型禁止发 `temperature`／`top_p`，DashScope 把 `max_tokens` 限制在 `[1, 65536]`……

如果把每一个怪癖都做成 `AIAgent` 上的一个布尔标志，传输层很快就会变成一个有二十多个开关参数的怪物。Hermes 的解法是把"提供商的行为"和"如何发请求"分成两层：

- **声明式的 `ProviderProfile`**：用一个 dataclass 把"这家提供商长什么样"完整描述出来——认证方式、端点、客户端怪癖、请求级怪癖。
- **命令式的 adapter**：当某个提供商的 API 形态和 OpenAI Chat Completions 差异太大、无法靠声明字段抹平时，单独写一个 adapter 模块，把 Hermes 内部的 OpenAI 风格消息格式翻译成该提供商的原生格式。

本章自底向上地讲清楚这套体系：先是 `ProviderProfile` 抽象（7.2），然后是四种重量级 adapter（7.3），接着是横切的凭证池 `CredentialPool`（7.4）、模型元数据目录（7.5）、辅助 LLM 路由器（7.6），最后是 provider 插件的注册机制（7.7）。

### api_mode：传输层的三岔路口

理解整个体系的钥匙是 `api_mode` 这个概念。它是 `ProviderProfile` 上的一个字符串字段，告诉传输层"这家提供商的 API 协议属于哪一类"。`providers/base.py:44` 把它的默认值定为 `"chat_completions"`：

```python
@dataclass
class ProviderProfile:
    """Base provider profile — subclass or instantiate with overrides."""

    # ── Identity ─────────────────────────────────────────────
    name: str
    api_mode: str = "chat_completions"
    aliases: tuple = ()
```

实践中 `api_mode` 主要取三类值：

| `api_mode` 取值 | 含义 | 走哪条代码路径 |
| --- | --- | --- |
| `chat_completions` | OpenAI 兼容的 `/v1/chat/completions` | `agent/chat_completion_helpers.py`，用 `openai` SDK |
| `codex_responses` | OpenAI Responses API（`/v1/responses`） | `agent/codex_responses_adapter.py` |
| `anthropic_messages` | Anthropic Messages API | `agent/anthropic_adapter.py` |

此外 Bedrock 和 Gemini 原生走的是各自的专用客户端（boto3 Converse、Gemini REST），它们通过 base_url 形态或 provider 名字被识别，不一定依赖 `api_mode` 字符串本身。

整体的请求分发可以画成这样一棵决策树：

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Request dispatch decision tree across four provider transport paths">
  <defs>
    <marker id="ar7" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="14" width="280" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="34" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">AIAgent 工具循环每一轮</text>
  <line x1="410" y1="46" x2="410" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7)"/>
  <rect x="270" y="62" width="280" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">build_api_kwargs(agent, messages)</text>
  <text x="410" y="94" text-anchor="middle" font-size="9" fill="#64748b">chat_completion_helpers.py:233</text>
  <line x1="410" y1="100" x2="410" y2="116" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="105" y1="116" x2="715" y2="116" stroke="#94a3b8" stroke-width="1.2"/>
  <g>
    <line x1="105" y1="116" x2="105" y2="140" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
    <rect x="20" y="142" width="170" height="42" rx="5" fill="#99f6e4" stroke="#0d9488"/>
    <text x="105" y="160" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">api_mode ==</text>
    <text x="105" y="175" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">chat_completions</text>
    <line x1="308" y1="116" x2="308" y2="140" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
    <rect x="223" y="142" width="170" height="42" rx="5" fill="#99f6e4" stroke="#0d9488"/>
    <text x="308" y="160" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">api_mode ==</text>
    <text x="308" y="175" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">codex_responses</text>
    <line x1="511" y1="116" x2="511" y2="140" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
    <rect x="426" y="142" width="170" height="42" rx="5" fill="#99f6e4" stroke="#0d9488"/>
    <text x="511" y="167" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">provider 是 bedrock</text>
    <line x1="714" y1="116" x2="714" y2="140" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
    <rect x="629" y="142" width="170" height="42" rx="5" fill="#99f6e4" stroke="#0d9488"/>
    <text x="714" y="167" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">base_url 是原生 Gemini</text>
  </g>
  <line x1="105" y1="184" x2="105" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
  <line x1="308" y1="184" x2="308" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
  <line x1="511" y1="184" x2="511" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
  <line x1="714" y1="184" x2="714" y2="200" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7)"/>
  <rect x="20" y="202" width="170" height="48" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="105" y="222" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">openai SDK</text>
  <text x="105" y="237" text-anchor="middle" font-size="9" fill="#64748b">.chat.completions.create()</text>
  <rect x="223" y="202" width="170" height="48" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="308" y="222" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">codex_responses_adapter</text>
  <text x="308" y="237" text-anchor="middle" font-size="9" fill="#64748b">Responses API</text>
  <rect x="426" y="202" width="170" height="48" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="511" y="222" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">bedrock_adapter</text>
  <text x="511" y="237" text-anchor="middle" font-size="9" fill="#64748b">boto3 Converse</text>
  <rect x="629" y="202" width="170" height="48" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="714" y="222" text-anchor="middle" font-size="10" font-weight="600" fill="currentColor">gemini_native_adapter</text>
  <text x="714" y="237" text-anchor="middle" font-size="9" fill="#64748b">REST /v1beta</text>
  <line x1="105" y1="250" x2="105" y2="278" stroke="#94a3b8" stroke-width="1.1"/>
  <line x1="308" y1="250" x2="308" y2="278" stroke="#94a3b8" stroke-width="1.1"/>
  <line x1="511" y1="250" x2="511" y2="278" stroke="#94a3b8" stroke-width="1.1"/>
  <line x1="714" y1="250" x2="714" y2="278" stroke="#94a3b8" stroke-width="1.1"/>
  <line x1="105" y1="278" x2="714" y2="278" stroke="#94a3b8" stroke-width="1.1"/>
  <line x1="410" y1="278" x2="410" y2="294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7)"/>
  <rect x="240" y="296" width="340" height="46" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="410" y="316" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">归一化为 assistant_message 结构</text>
  <text x="410" y="332" text-anchor="middle" font-size="9" fill="#64748b">build_assistant_message() · chat_completion_helpers.py:456</text>
  <line x1="410" y1="342" x2="410" y2="358" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7)"/>
  <rect x="270" y="360" width="280" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="410" y="380" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">回到工具循环，解析 tool_calls</text>
</svg>
<span class="figure-caption">图 R7.1 ｜ 请求分发决策树：四条传输路径处理后统一归一化为 assistant_message 结构</span>

<details>
<summary>ASCII 原版</summary>

```text
                    AIAgent 工具循环每一轮
                           │
                  build_api_kwargs(agent, messages)
                  chat_completion_helpers.py:233
                           │
            ┌──────────────┼───────────────┬──────────────┐
            │              │               │              │
     api_mode ==     api_mode ==      provider 是      base_url 是
   chat_completions  codex_responses    bedrock        原生 Gemini
            │              │               │              │
            ▼              ▼               ▼              ▼
     openai SDK     codex_responses_   bedrock_       gemini_native_
   .chat.completions   adapter.py      adapter.py      adapter.py
       .create()    (Responses API)  (boto3 Converse)  (REST /v1beta)
            │              │               │              │
            └──────────────┴───────────────┴──────────────┘
                           │
              统一归一化为「assistant_message」结构
                  build_assistant_message()
              chat_completion_helpers.py:456
                           │
                           ▼
                  回到工具循环，解析 tool_calls
```

</details>

关键设计点是：**无论走哪条路径，出口都被归一化成同一个结构**。`build_assistant_message()`（`agent/chat_completion_helpers.py:456`）负责把各家的响应（OpenAI 的 `ChatCompletionMessage`、Anthropic 的 `content` 块、Codex 的 `output` 项、Gemini 的 `candidates`）统一翻译成 Hermes 内部的 OpenAI 风格 assistant message。这样工具循环本身完全不需要知道当前接的是哪家提供商。

## 7.2 ProviderProfile：声明式的提供商配置

`ProviderProfile` 定义在 `providers/base.py:38`。它的模块 docstring（`providers/base.py:1-10`）把设计意图说得很清楚：

> A ProviderProfile declares everything about an inference provider in one place: auth, endpoints, client quirks, request-time quirks. The transport reads this instead of receiving 20+ boolean flags.
>
> Provider profiles are DECLARATIVE — they describe the provider's behavior. They do NOT own client construction, credential rotation, or streaming. Those stay on AIAgent.

也就是说：`ProviderProfile` 是一份**纯描述**。它不构造客户端、不轮换凭证、不处理流式——那些是 `AIAgent` 和 `CredentialPool` 的职责。这条边界划得很干净，让 profile 可以做成纯数据、可以被插件系统替换、可以被测试 mock。

### 7.2.1 字段分组

`ProviderProfile` 的字段按职责分成五组（`providers/base.py:42-79`）：

```python
@dataclass
class ProviderProfile:
    # ── Identity ─────────────────────────────────────────────
    name: str
    api_mode: str = "chat_completions"
    aliases: tuple = ()

    # ── Human-readable metadata ───────────────────────────────
    display_name: str = ""       # 例如 "GMI Cloud" — 选择器里显示
    description: str = ""        # 选择器副标题
    signup_url: str = ""         # setup 时引导用户去注册

    # ── Auth & endpoints ─────────────────────────────────────
    env_vars: tuple = ()
    base_url: str = ""
    models_url: str = ""         # 显式 models 端点，缺省回退到 {base_url}/models
    auth_type: str = "api_key"   # api_key|oauth_device_code|oauth_external|copilot|aws_sdk
    supports_health_check: bool = True

    # ── Model catalog ─────────────────────────────────────────
    fallback_models: tuple = ()  # 在线拉取失败时 /model 选择器里显示的策划清单
    hostname: str = ""           # 用于 base_url→provider 反向映射

    # ── Client-level quirks ──────────────────────────────────
    default_headers: dict[str, str] = field(default_factory=dict)

    # ── Request-level quirks ─────────────────────────────────
    fixed_temperature: Any = None        # None=用调用方默认；OMIT_TEMPERATURE=不发
    default_max_tokens: int | None = None
    default_aux_model: str = ""          # 供辅助任务用的便宜模型
```

几个值得展开的设计点：

**`fixed_temperature` 与 `OMIT_TEMPERATURE` 哨兵。** 温度参数有三种语义需要表达：用调用方默认值、强制成某个固定值、彻底不发这个字段。`None` 不够用——`None` 在 JSON 里有歧义。所以 `providers/base.py:21` 定义了一个哨兵对象：

```python
# Sentinel for "omit temperature entirely" (Kimi: server manages it)
OMIT_TEMPERATURE = object()
```

Kimi 这类提供商把温度交给服务端管理，发 `temperature` 反而会出错。`fixed_temperature = OMIT_TEMPERATURE` 让传输层知道"这个字段整个不要出现在请求体里"，而 `fixed_temperature = 0.0` 表示"强制成 0"，`fixed_temperature = None`（默认）表示"听调用方的"。一个字段、一个哨兵，三种语义全部表达清楚，没有用三个布尔开关。

**`auth_type` 的取值空间。** 注释（`providers/base.py:56`）列出了五种：`api_key`（标准 Bearer／x-api-key）、`oauth_device_code`（设备码 OAuth，token 会过期）、`oauth_external`（外部 OAuth，如 Claude Code 凭证）、`copilot`（GitHub Copilot 特殊流）、`aws_sdk`（走 boto3 凭证链）。凭证池（7.4）会根据这个字段决定是否需要刷新 token。

**`hostname` 用于反向映射。** 注释（`providers/base.py:64-66`）说明：`model_metadata.py` 需要从一个 `base_url` 反推出"这是哪家提供商"。`hostname` 字段（缺省由 `base_url` 推导）就是这个反向索引的键。`get_hostname()`（`providers/base.py:82`）实现了这个推导逻辑——优先用显式 `hostname`，否则 `urlparse(base_url).hostname`。

### 7.2.2 行为钩子：从声明退化为命令

纯声明字段能抹平 80% 的提供商差异，但剩下 20% 需要"做点什么"。`ProviderProfile` 为此暴露了四个可被子类覆盖的钩子方法：

**`prepare_messages()`（`providers/base.py:95`）。** 提供商特定的消息预处理。在 codex 字段清洗之后、developer 角色替换之前调用。默认是直通。

**`build_extra_body()`（`providers/base.py:103`）。** 返回要合并进 `extra_body` 的提供商特定字段。它接收 `session_id` 等上下文，默认返回空 dict。典型用途是注入提供商特定的路由提示或缓存控制。

**`build_api_kwargs_extras()`（`providers/base.py:112`）。** 这个钩子最能体现声明式抽象的边界在哪里。它的 docstring 把动机解释得很透：

```python
def build_api_kwargs_extras(
    self,
    *,
    reasoning_config: dict | None = None,
    **context: Any,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Provider-specific kwargs split between extra_body and top-level api_kwargs.

    Returns (extra_body_additions, top_level_kwargs).
    ...
    This split exists because some providers put reasoning config in
    extra_body (OpenRouter: extra_body.reasoning) while others put it
    as top-level api_kwargs (Kimi: api_kwargs.reasoning_effort).
    """
    return {}, {}
```

同样是"推理强度"这个概念，OpenRouter 要求放进 `extra_body.reasoning`，Kimi 要求放成顶层 `api_kwargs.reasoning_effort`。一个钩子返回**两个 dict**，分别让传输层合并到两个不同的位置，于是同一份"推理配置"语义可以被翻译成两种线格式。

**`fetch_models()`（`providers/base.py:132`）。** 在线拉取该提供商的模型清单。它的默认实现（`providers/base.py:157-184`）已经覆盖了绝大多数 OpenAI 兼容提供商：

```python
def fetch_models(self, *, api_key=None, timeout=8.0) -> list[str] | None:
    url = (self.models_url or "").strip()
    if not url:
        if not self.base_url:
            return None
        url = self.base_url.rstrip("/") + "/models"

    import json, urllib.request
    req = urllib.request.Request(url)
    if api_key:
        req.add_header("Authorization", f"Bearer {api_key}")
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", _profile_user_agent())  # 见下
    for k, v in self.default_headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode())
        items = data if isinstance(data, list) else data.get("data", [])
        return [m["id"] for m in items if isinstance(m, dict) and "id" in m]
    except Exception as exc:
        logger.debug("fetch_models(%s): %s", self.name, exc)
        return None
```

注意两个细节。其一，端点解析有明确的优先级（docstring 在 `providers/base.py:143-149` 列出）：先用显式 `models_url`，否则回退到 `base_url + "/models"`。这是因为有些提供商把推理端点和模型目录端点分开了——OpenRouter 的推理在 `/api/v1`，但公开目录在 `/api/v1/models`，需要显式覆盖。其二，请求头里特意设置了一个 hermes-cli User-Agent。`_profile_user_agent()`（`providers/base.py:24`）的注释说明了原因：

> Some providers (e.g. OpenCode Zen) sit behind a WAF that returns 403 for the default `Python-urllib/<ver>` UA.

默认的 `Python-urllib/x.y` User-Agent 会被某些提供商前面的 WAF 直接拦掉，所以要伪装成 `hermes-cli/<version>`。这个函数还做了一层降级——如果连版本号都拿不到（`from hermes_cli import __version__` 失败），就退回到裸 `"hermes-cli"`。

`fetch_models()` 的返回约定也很关键：失败时返回 `None`，调用方必须回退到静态的 `fallback_models` 策划清单。在线目录和静态目录的"双轨"是 Hermes 在网络不稳定时仍能让用户用 `/model` 命令切换模型的保证。

## 7.3 四种重量级 adapter

当某家提供商的 API 形态和 OpenAI Chat Completions 差太多、无法靠 `ProviderProfile` 的声明字段和钩子抹平时，Hermes 就为它单独写一个 adapter 模块。adapter 的职责是**双向翻译**：把 Hermes 内部的 OpenAI 风格消息翻译成提供商原生格式（请求方向），再把提供商的原生响应翻译回 OpenAI 风格的 assistant message（响应方向）。

四个 adapter 体量都不小：

| Adapter 文件 | 行数 | 对接的 API |
| --- | --- | --- |
| `agent/anthropic_adapter.py` | 2086 | Anthropic Messages API |
| `agent/chat_completion_helpers.py` | 2043 | OpenAI Chat Completions（默认路径） |
| `agent/bedrock_adapter.py` | 1289 | AWS Bedrock Converse API |
| `agent/codex_responses_adapter.py` | 1084 | OpenAI Responses API |
| `agent/gemini_native_adapter.py` | 971 | Google Gemini 原生 REST |

### 7.3.1 Anthropic adapter：Messages API、OAuth、自适应思考

`agent/anthropic_adapter.py` 的模块 docstring（`anthropic_adapter.py:1-11`）把它要处理的三种认证形态列出来了：

> Auth supports:
> - Regular API keys (sk-ant-api*) → x-api-key header
> - OAuth setup-tokens (sk-ant-oat*) → Bearer auth + beta header
> - Claude Code credentials (~/.claude.json or ~/.claude/.credentials.json) → Bearer auth

**懒加载 SDK。** 第一个值得注意的设计是：`import anthropic` 故意不放在模块顶部。`anthropic_adapter.py:25-30` 的注释说明：

> The SDK pulls ~220 ms of imports ... and the 3 usage sites are all on cold user-triggered paths.

`anthropic` SDK 的导入耗时约 220 毫秒。Hermes 的启动路径不应该为一个可能用不上的提供商付这 220ms。所以 SDK 通过一个带哨兵的访问器 `_get_anthropic_sdk()`（`anthropic_adapter.py:34`）懒加载，首次调用后缓存，`ImportError` 时缓存 `None`。这种"模块级哨兵 + 懒访问器"的模式在整个 Hermes 代码库里反复出现，是冷启动优化的标准手法。

**THINKING_BUDGET 与自适应思考。** Anthropic 的扩展思考（extended thinking）需要一个 token 预算。`anthropic_adapter.py:55` 把 Hermes 的努力档位映射成 token 数：

```python
THINKING_BUDGET = {"xhigh": 32000, "high": 16000, "medium": 8000, "low": 4000}
```

但这只是老模型的逻辑。从 Claude 4.6 起，Anthropic 引入了"自适应思考"（adaptive thinking）——不再让客户端指定 token 预算，而是让客户端指定一个努力等级（`output_config.effort`），由模型自己决定思考多少。`anthropic_adapter.py:64` 的 `ADAPTIVE_EFFORT_MAP` 做的就是 Hermes 努力档位到 Anthropic 自适应努力等级的映射：

```python
ADAPTIVE_EFFORT_MAP = {
    "max":     "max",
    "xhigh":   "xhigh",
    "high":    "high",
    "medium":  "medium",
    "low":     "low",
    "minimal": "low",   # legacy 别名
}
```

这里还有版本兼容的细节。`xhigh` 这个等级是 Opus 4.7 才加的，介于 `high` 和 `max` 之间；4.6 的自适应模型不认它，会返回 400。`_XHIGH_EFFORT_SUBSTRINGS = ("4-7", "4.7")`（`anthropic_adapter.py:77`）这个子串列表用来识别"哪些模型接受 xhigh"，不接受的会被降级成 `max`。同理 `_NO_SAMPLING_PARAMS_SUBSTRINGS`（`anthropic_adapter.py:86`）标记了 4.7 这一代——它们禁止发 `temperature`／`top_p`／`top_k`，发了就 400。`_supports_adaptive_thinking()`（`anthropic_adapter.py:205`）和 `_supports_xhigh_effort()`（`anthropic_adapter.py:211`）把这些子串判断封装成可读的谓词。

`_ANTHROPIC_OUTPUT_LIMITS`（`anthropic_adapter.py:93`）是另一张必需的表。Anthropic 的 API 强制要求 `max_tokens` 字段，而思考 token 会算进这个上限。如果硬编码一个小值（历史上是 16384），会"饿死"启用思考的模型。所以这张表按模型族列出真实上限——Opus 4.7 是 128000，Claude 3 Haiku 只有 4096。

**OAuth 三态认证。** `_is_anthropic_oauth_token()`（`anthropic_adapter.py:326`）靠 token 的前缀正面识别 OAuth token：`sk-ant-`（但不是 `sk-ant-api`，那是普通 console key）、`eyJ`（OAuth 流签发的 JWT）、`cc-`（Claude Code OAuth 访问 token）。识别出来后走 Bearer 认证 + Claude Code 身份头——`anthropic_adapter.py:280-291` 的注释解释了为什么需要伪装 Claude Code 身份：

> Claude Code identity — required for OAuth requests to be routed correctly. Without these, Anthropic's infrastructure intermittently 500s OAuth traffic.

OAuth 流量必须带上 Claude Code 的 user-agent，否则 Anthropic 的基础设施会间歇性 500。OAuth token 会过期，所以 adapter 还提供了纯函数 `refresh_anthropic_oauth_pure()`（`anthropic_adapter.py:786`，"pure" 表示不改本地凭证文件，只返回刷新结果），以及 `read_claude_code_credentials()`（`anthropic_adapter.py:717`）从 `~/.claude/.credentials.json` 读取可刷新凭证。这些纯函数会被凭证池（7.4）调用。

`is_anthropic_compatible_endpoint()`（`anthropic_adapter.py:365`）处理另一种情况：有些第三方端点（MiniMax、私有网关）实现了 Anthropic 的 Messages API，但用自己的 API key 走 `x-api-key`，不是 Anthropic OAuth。adapter 必须区分"直连 Anthropic"和"第三方 Anthropic 兼容端点"，因为前者才能用 OAuth。

### 7.3.2 Bedrock adapter：boto3 原生 Converse API

`agent/bedrock_adapter.py` 不走 HTTP，而是用 AWS 的 boto3 SDK。模块 docstring（`bedrock_adapter.py:1-25`）列出了三个特性：原生 Converse API（统一接口）、AWS 凭证链（IAM role／SSO profile／环境变量／IMDS）、可选的 Bedrock Guardrails。

**boto3 是可选依赖。** `bedrock_adapter.py:40-43` 的注释说明上游把 boto3 从 `[all]` extras 里移除了，所以 adapter 用 `lazy_deps` 在运行时按需安装。`_require_boto3()`（`bedrock_adapter.py:61`）在 boto3 缺失时抛出清晰的错误（"Install it with: pip install boto3"），而不是一个莫名其妙的 `ImportError`。

**客户端缓存与失效。** boto3 client 在 region 维度上缓存（`_bedrock_runtime_client_cache`、`_bedrock_control_client_cache`），`_get_bedrock_runtime_client(region)`（`bedrock_adapter.py:74`）按 region 取或建。但 boto3 把 HTTPS 连接池缓存在 client 对象内部——`bedrock_adapter.py:123` 的注释指出，进程长期运行时连接会失效。`is_stale_connection_error()`（`bedrock_adapter.py:155`）通过检查异常的 traceback 帧是否来自 urllib3／botocore／boto3 内部来识别"陈旧连接"错误，`invalidate_runtime_client(region)`（`bedrock_adapter.py:103`）则把对应 region 的 client 从缓存里踢掉，强制下次重建。

**凭证链。** `resolve_aws_auth_env_var()`（`bedrock_adapter.py:231`）先查环境变量（`AWS_PROFILE`、`AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY` 等），再回退到 boto3 自己的凭证解析链（IMDS／SSO）。`has_aws_credentials()`（`bedrock_adapter.py:273`）用于在 doctor 检查时判断"AWS 凭证是否可用"。这套逻辑对应 `ProviderProfile.auth_type = "aws_sdk"`——凭证不在 Hermes 的 auth.json 里，而是交给 AWS SDK 的标准链。

### 7.3.3 Gemini 原生 adapter：REST 协议与配额探测

`agent/gemini_native_adapter.py` 对接 Google Gemini 的原生 REST API（`https://generativelanguage.googleapis.com/v1beta`，`gemini_native_adapter.py:34`）。注意 Hermes 也支持通过 OpenAI 兼容层访问 Gemini，所以需要一个判断函数区分两条路径。

**`is_native_gemini_base_url()`（`gemini_native_adapter.py:37`）。** 判断一个 base_url 是不是 Gemini 原生端点。如果是，就走这个 adapter 的 REST 翻译；如果是 Gemini 的 OpenAI 兼容层，就走标准 chat_completions 路径。

**`probe_gemini_tier()`（`gemini_native_adapter.py:47`）。** 探测当前 API key 是免费档还是付费档。免费档有严格的速率限制和配额。`is_free_tier_quota_error()`（`gemini_native_adapter.py:121`）则用于在请求失败时识别"这是免费档配额耗尽"——区分配额错误和真正的故障，对故障转移决策很重要。

adapter 的翻译工作量集中在结构差异上。Gemini 用 `contents` + `parts` 而不是 `messages` + `content`。一系列私有函数完成双向翻译：`_build_gemini_contents()`（`gemini_native_adapter.py:276`）把 OpenAI 消息数组翻成 Gemini contents、`_translate_tool_call_to_gemini()`（`gemini_native_adapter.py:228`）翻译工具调用、`_translate_tools_to_gemini()`（`gemini_native_adapter.py:330`）翻译工具 schema、`build_gemini_request()`（`gemini_native_adapter.py:388`）组装最终请求；反方向有 `translate_gemini_response()`（`gemini_native_adapter.py:474`）和 `translate_stream_event()`（`gemini_native_adapter.py:618`）处理流式 SSE 事件。adapter 还给出了 `GeminiNativeClient`（`gemini_native_adapter.py:808`）和 `AsyncGeminiNativeClient`（`gemini_native_adapter.py:943`），它们的接口故意做成和 openai SDK 的 `client.chat.completions.create()` 同形，这样传输层换 client 时几乎不用改代码。

### 7.3.4 Codex Responses adapter：多模态转换

`agent/codex_responses_adapter.py` 对接 OpenAI 的 Responses API（`/v1/responses`）。模块 docstring（`codex_responses_adapter.py:1-6`）把它定位为"纯格式转换和归一化逻辑"。

Responses API 和 Chat Completions 的主要差异在于：它不是 `messages` 数组，而是 `input` 项流；它把推理过程作为独立的 `reasoning` 项；它对 assistant 消息里能放什么类型有更严格的约束。adapter 的核心函数：

- `_chat_messages_to_responses_input()`（`codex_responses_adapter.py:247`）：把 OpenAI 风格消息数组翻成 Responses API 的 input 项流。
- `_chat_content_to_responses_parts()`（`codex_responses_adapter.py:47`）：处理多模态内容。docstring（`codex_responses_adapter.py:48-57`）指出一个怪癖——Responses API **拒绝在 assistant 消息里出现 `input_text`**，所以转换时要按 role 区分。
- `_preflight_codex_input_items()`（`codex_responses_adapter.py:466`）和 `_preflight_codex_api_kwargs()`（`codex_responses_adapter.py:676`）：发请求前的清洗，确保不会因为格式问题被 API 拒绝。
- `_normalize_codex_response()`（`codex_responses_adapter.py:874`）：把 Responses API 的 `output` 项数组归一化成 assistant_message 风格的对象——这是响应方向的统一出口。

`_chat_messages_to_responses_input()` 有个 `is_xai_responses` 参数（`codex_responses_adapter.py:250`）。这是因为 xAI 的 OAuth／SuperGrok 也提供了 `/v1/responses` 接口，但它的协议和 OpenAI 的略有出入——比如它要求剥掉重放 reasoning 项里的 `encrypted_content` 字段。一个 adapter 服务两个提供商，靠这个布尔参数分流。

### 7.3.5 chat_completion_helpers：默认路径的胶水层

`agent/chat_completion_helpers.py` 不是某一家提供商的 adapter，而是**所有 `chat_completions` 模式提供商共享的请求构造与响应归一化逻辑**。它的几个核心入口：

- `build_api_kwargs(agent, api_messages)`（`chat_completion_helpers.py:233`）：把 agent 状态和消息列表组装成最终的 API kwargs。`ProviderProfile.build_extra_body()` 和 `build_api_kwargs_extras()` 的返回值就在这里被合并进去。
- `build_assistant_message(agent, assistant_message, finish_reason)`（`chat_completion_helpers.py:456`）：把 SDK 返回的响应归一化成 Hermes 内部结构——前面强调过的"统一出口"。
- `interruptible_api_call(agent, api_kwargs)`（`chat_completion_helpers.py:79`）和 `interruptible_streaming_api_call()`（`chat_completion_helpers.py:1133`）：可中断的 API 调用包装，让用户能按 Ctrl-C 打断一个进行中的推理。
- `try_activate_fallback(agent, reason)`（`chat_completion_helpers.py:651`）：故障转移入口——当前提供商挂了，切到下一个。这与凭证池（7.4）和辅助路由器（7.6）的故障转移逻辑配合工作。
- `handle_max_iterations(agent, messages, api_call_count)`（`chat_completion_helpers.py:883`）：工具循环达到迭代上限时的收尾处理。

## 7.4 凭证池：同提供商的多凭证故障转移

`agent/credential_pool.py`（1782 行）解决的是另一个维度的问题：**同一家提供商，用户可能配了多把 key**。比如三个 OpenRouter 账号、两个 Anthropic 订阅。凭证池让 Hermes 在一把 key 被限流／耗尽时自动轮换到下一把，而不是直接报错。

### 7.4.1 PooledCredential 与状态机

池里的每个凭证是一个 `PooledCredential` dataclass（`credential_pool.py:93`）。它的字段分三类：身份（`provider`/`id`/`label`/`source`/`priority`）、认证材料（`access_token`/`refresh_token`/`base_url`/`expires_at`）、健康状态（`last_status`/`last_error_code`/`last_error_reset_at`/`request_count`）。

健康状态只有两个值（`credential_pool.py:52-53`）：

```python
STATUS_OK = "ok"
STATUS_EXHAUSTED = "exhausted"
```

`ok` 表示可用，`exhausted` 表示暂时不可用、进入冷却期。`__getattr__`（`credential_pool.py:123`）有个巧妙处理：那些只在 JSON 里来回穿梭、从不当属性用的字段（`_EXTRA_KEYS`，`credential_pool.py:86`，如 `token_type`、`scope`、`client_id`）被收进一个 `extra` dict，靠 `__getattr__` 透明代理访问。这让 dataclass 的"逻辑字段"保持干净，又不丢任何持久化数据。

`runtime_api_key` 和 `runtime_base_url`（`credential_pool.py:166-176`）是两个 property，封装了 provider 特定的解析——比如 Nous 用 `agent_key` 而不是 `access_token`。

### 7.4.2 差异化冷却：401 / 429 / 402 不一样

凭证耗尽后要冷却多久才重试？Hermes 的关键洞察是：**不同的 HTTP 错误码意味着不同的恢复时间**。`credential_pool.py:75-77` 定义了三档：

```python
EXHAUSTED_TTL_401_SECONDS = 5 * 60       # 5 分钟
EXHAUSTED_TTL_429_SECONDS = 60 * 60      # 1 小时
EXHAUSTED_TTL_DEFAULT_SECONDS = 60 * 60  # 1 小时
```

`_exhausted_ttl()`（`credential_pool.py:197`）做映射：

```python
def _exhausted_ttl(error_code: Optional[int]) -> int:
    """Return cooldown seconds based on the HTTP status that caused exhaustion."""
    if error_code == 401:
        return EXHAUSTED_TTL_401_SECONDS
    if error_code == 429:
        return EXHAUSTED_TTL_429_SECONDS
    return EXHAUSTED_TTL_DEFAULT_SECONDS
```

`credential_pool.py:72-74` 的注释解释了为什么 401 只冷却 5 分钟：

> Transient 401 auth failures cool down briefly so single-key setups can recover. 429 (rate-limited), 402 (billing/quota), and other failures cool down after 1 hour.

401（认证失败）往往是 token 临时过期这种瞬态问题——OAuth token 刚好在请求那一刻过期了，刷一下就能恢复。如果按 1 小时冷却，单 key 用户就被困住了。所以 401 只冷 5 分钟。而 429（限流）和 402（账单／配额耗尽）是真的"额度用完了"，需要更长的恢复窗口。

更精细的是：**提供商如果自己给出了重置时间戳，它会覆盖这些默认值**。`_exhausted_until()`（`credential_pool.py:274`）的逻辑是——先看凭证的 `last_error_reset_at`（来自提供商响应里的 `reset_at`/`resets_at`/`retry_until` 字段），有就用它；没有才回退到 `last_status_at + _exhausted_ttl(error_code)`。`_normalize_error_context()`（`credential_pool.py:249`）负责从响应里抽取这个时间戳，它甚至能从错误消息文本里正则匹配出 `quotaResetDelay` 和 `retry after N seconds`（`_extract_retry_delay_seconds()`，`credential_pool.py:236`）。

<svg viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Credential exhaustion and rotation flow with cooldown computation">
  <defs>
    <marker id="ar7b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="14" width="300" height="32" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.3"/>
  <text x="400" y="34" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">请求失败，HTTP status 已知</text>
  <line x1="400" y1="46" x2="400" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="200" y="62" width="400" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="80" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">mark_exhausted_and_rotate(status_code, error_context)</text>
  <text x="400" y="94" text-anchor="middle" font-size="9" fill="#64748b">credential_pool.py:1101</text>
  <line x1="400" y1="100" x2="400" y2="114" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="200" y="116" width="400" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="136" text-anchor="middle" font-size="10" fill="currentColor">_normalize_error_context() 抽取提供商给的 reset_at</text>
  <line x1="400" y1="148" x2="400" y2="162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="200" y="164" width="400" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="184" text-anchor="middle" font-size="10" fill="currentColor">_mark_exhausted() — 凭证状态 → exhausted，记录 status/reset_at</text>
  <line x1="400" y1="196" x2="400" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="200" y="212" width="400" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="232" text-anchor="middle" font-size="10" fill="currentColor">_current_id = None，重新 _select_unlocked()</text>
  <line x1="400" y1="244" x2="400" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7b)"/>
  <rect x="160" y="260" width="480" height="62" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="180" y="280" font-size="10.5" font-weight="600" fill="currentColor">下次 select() 时 _exhausted_until() 计算冷却到期点</text>
  <text x="180" y="298" font-size="10" fill="#64748b">有 reset_at → 用它</text>
  <text x="180" y="313" font-size="10" fill="#64748b">无 reset_at → last_status_at + _exhausted_ttl(code)</text>
  <line x1="320" y1="322" x2="240" y2="350" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7b)"/>
  <line x1="480" y1="322" x2="560" y2="350" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7b)"/>
  <rect x="80" y="352" width="280" height="34" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="220" y="373" text-anchor="middle" font-size="10" fill="currentColor">now &lt; 到期点 → 跳过这个凭证</text>
  <rect x="440" y="352" width="280" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="580" y="373" text-anchor="middle" font-size="10" fill="currentColor">now ≥ 到期点 → clear_expired 复活成 ok</text>
</svg>
<span class="figure-caption">图 R7.2 ｜ 凭证耗尽与轮换流程：标记 exhausted、抽取 reset_at、按冷却到期点决定跳过或复活</span>

<details>
<summary>ASCII 原版</summary>

```text
请求失败，HTTP status 已知
            │
   mark_exhausted_and_rotate(status_code, error_context)
   credential_pool.py:1101
            │
   _normalize_error_context() 抽取提供商给的 reset_at
            │
   _mark_exhausted(): 凭证状态 → exhausted, 记录 status_code/reset_at
            │
   _current_id = None, 重新 _select_unlocked()
            │
            ▼
   下次 select() 时 _exhausted_until() 计算冷却到期点：
     有 reset_at → 用它
     无 reset_at → last_status_at + _exhausted_ttl(code)
            │
   now < 到期点 → 跳过这个凭证
   now ≥ 到期点 → clear_expired 把它复活成 ok
```

</details>

### 7.4.3 四种选择策略

池在多个可用凭证之间怎么挑？`credential_pool.py:60-69` 定义了四种策略：

```python
STRATEGY_FILL_FIRST = "fill_first"
STRATEGY_ROUND_ROBIN = "round_robin"
STRATEGY_RANDOM = "random"
STRATEGY_LEAST_USED = "least_used"
```

策略由用户在 `config.yaml` 的 `credential_pool_strategies` 段按提供商配置，`get_pool_strategy()`（`credential_pool.py:368`）读取，缺省 `fill_first`。`_select_unlocked()`（`credential_pool.py:1061`）实现选择逻辑：

- **`fill_first`**（默认）：永远用优先级最高的可用凭证，把它榨干再换下一个。适合"主 key + 备用 key"的场景。
- **`round_robin`**（`credential_pool.py:1081`）：轮流。选中一个后把它的优先级降到末尾，重排整个池。
- **`random`**（`credential_pool.py:1068`）：随机选。
- **`least_used`**（`credential_pool.py:1073`）：选 `request_count` 最小的，并自增计数。适合在多把 key 之间均摊负载。

`_available_entries()`（`credential_pool.py:980`）是选择前的过滤器——它遍历所有凭证，跳过仍在冷却期的，可选地把冷却到期的复活（`clear_expired`），可选地刷新需要刷新 token 的（`refresh`）。

此外池还支持"软租约"（soft lease）。`acquire_lease()`（`credential_pool.py:1124`）/`release_lease()`（`credential_pool.py:1155`）让并发的多个请求倾向于分散到不同凭证上——`_max_concurrent`（默认 1，`credential_pool.py:384`）是每凭证的软并发上限，超过上限时仍会返回最少租约的那个而不是阻塞。

### 7.4.4 OAuth token 刷新与单次有效 refresh token 的竞态

凭证池里最复杂、注释最密集的部分是 OAuth token 刷新。难点不在"刷新"本身，而在于：**OAuth refresh token 通常是单次有效的**。一旦用某个 refresh token 换了新 token，旧的 refresh token 就作废。如果有多个进程（Hermes gateway、CLI、另一个 profile、Claude Code CLI）共享同一份凭证，它们会互相把对方的 refresh token "消费"掉，导致 `refresh_token_reused` 之类的撤销错误。

`_refresh_entry()`（`credential_pool.py:747`）是刷新入口，按 provider 分派到 `refresh_anthropic_oauth_pure()` / `refresh_codex_oauth_pure()` / `refresh_xai_oauth_pure()` / `refresh_nous_oauth_from_state()`。但真正解决竞态的是一组"同步"方法：

- `_sync_anthropic_entry_from_credentials_file()`（`credential_pool.py:445`）：刷新前先看 `~/.claude/.credentials.json` 里的 token 是否比池里的新。Claude Code CLI 或另一个 Hermes profile 可能已经刷过了。
- `_sync_codex_entry_from_auth_store()`（`credential_pool.py:482`）、`_sync_xai_oauth_entry_from_auth_store()`（`credential_pool.py:546`）、`_sync_nous_entry_from_auth_store()`（`credential_pool.py:604`）：同样的模式，从 `auth.json` 的单例状态里采纳更新的 token。

`_sync_codex_entry_from_auth_store()` 的 docstring（`credential_pool.py:482-498`）把这个竞态场景讲得最透——一个 Codex OAuth token 因为 ChatGPT 周配额耗尽被标成 `exhausted`、`reset_at` 在几小时后；同时用户跑了 `hermes auth` 重新设备码登录、写了新 token 进 `auth.json`；如果不同步，池里那个凭证会被冻到几小时后才解冻，**哪怕磁盘上已经躺着一把新鲜的 key**。

刷新成功后还要**反向同步**：`_sync_device_code_entry_to_auth_store()`（`credential_pool.py:659`）把刷新后的 token 写回 `auth.json`。它的 docstring（`credential_pool.py:659-680`）解释了为什么——下次 `load_pool()` 调用 `_seed_from_singletons()` 时会读 `auth.json`，如果不回写，会用陈旧（已消费）的 refresh token 覆盖池里的新 token。注意回写时一律 `set_active=False`：刷新是 token 轮换的副作用，不是用户主动选了某个提供商，不能误改 `active_provider` 标志。

整套竞态防御可以总结成一个原则：**`auth.json` 单例和凭证池条目互为镜像，刷新前从对方采纳更新值，刷新后向对方回写**。`_load_provider_state` / `_save_provider_state` 都在 `_auth_store_lock()` 下进行，保证多进程下的原子性。

### 7.4.5 池的加载与种子

`load_pool(provider)`（`credential_pool.py:1760`）是池的构造入口。它做四件事：

1. `read_credential_pool(provider)` 从持久化存储读出已有条目。
2. `_seed_from_singletons()`（`credential_pool.py:1317`）：从 `auth.json` 的 OAuth 单例状态里"种"出条目——Anthropic 的 Claude Code 凭证、Nous／Codex／xAI 的 device_code 状态、Copilot 的 `gh auth token`、Qwen 的 `~/.qwen/oauth_creds.json` 等。
3. `_seed_from_env()`（`credential_pool.py:1579`）：从环境变量和 `~/.hermes/.env` 里种出 API key 条目。注意它优先 `~/.hermes/.env` 而非 `os.environ`（`credential_pool.py:1583-1586` 的注释：用户的配置文件才是权威，父进程残留的 env var 不该覆盖）。
4. `_prune_stale_seeded_entries()`（`credential_pool.py:1670`）：清理那些不再被任何来源种出的旧条目。

种子机制还尊重用户的"抑制"操作——`hermes auth remove <provider> <N>` 会把某个来源标记为 suppressed，`is_source_suppressed()` 的检查散布在每个种子点，保证移除操作不会在下次 `load_pool()` 时被悄悄撤销。自定义 OpenAI 兼容端点走单独的 `_seed_custom_pool()`（`credential_pool.py:1687`），它们共享 `provider='custom'`，靠 `custom:<name>` 形式的池键区分（`CUSTOM_POOL_PREFIX`，`credential_pool.py:82`）。

## 7.5 模型元数据：目录、上下文上限与 cost 估算

`agent/model_metadata.py`（1827 行）和 `agent/models_dev.py`（723 行）解决一个看似简单实则琐碎的问题：**给定一个模型名和一个 base_url，它的上下文窗口有多大？一次请求要花多少钱？**

上下文窗口大小直接决定了上下文压缩（[第 8 章](08-context-compression.md)）的触发阈值。如果 Hermes 不知道当前模型的上下文上限，它要么压缩得太早（浪费），要么压缩得太晚（请求被 API 拒绝）。

### 7.5.1 get_model_context_length 的多级回退

`get_model_context_length()`（`model_metadata.py:1429`）是上下文长度的统一查询入口。它的 docstring（`model_metadata.py:1455` 附近）列出了一条多级解析链：

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Multi-level fallback chain for resolving model context length">
  <defs>
    <marker id="ar7c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="180" y="14" width="440" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="34" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">get_model_context_length(model, base_url, api_key, provider)</text>
  <g font-size="10.5">
    <line x1="400" y1="46" x2="400" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7c)"/>
    <rect x="150" y="60" width="500" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
    <text x="166" y="79" fill="currentColor"><tspan font-weight="700">a.</tspan> 缓存命中？get_cached_context_length()</text>
    <text x="634" y="79" text-anchor="end" font-size="9" fill="#64748b">miss ↓</text>
    <line x1="400" y1="90" x2="400" y2="100" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="102" width="500" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.1"/>
    <text x="166" y="121" fill="currentColor"><tspan font-weight="700">b.</tspan> 端点是 Anthropic？_query_anthropic_context_length()</text>
    <line x1="400" y1="132" x2="400" y2="142" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="144" width="500" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.1"/>
    <text x="166" y="163" fill="currentColor"><tspan font-weight="700">c.</tspan> 端点是 Codex OAuth？_resolve_codex_oauth_context_length()</text>
    <line x1="400" y1="174" x2="400" y2="184" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="186" width="500" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.1"/>
    <text x="166" y="205" fill="currentColor"><tspan font-weight="700">d.</tspan> 端点是 Nous？_resolve_nous_context_length()</text>
    <line x1="400" y1="216" x2="400" y2="226" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="228" width="500" height="30" rx="5" fill="#99f6e4" stroke="#0d9488" stroke-width="1.1"/>
    <text x="166" y="247" fill="currentColor"><tspan font-weight="700">e.</tspan> 本地 Ollama？query_ollama_num_ctx() / _query_ollama_api_show()</text>
    <line x1="400" y1="258" x2="400" y2="268" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="270" width="500" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.1"/>
    <text x="166" y="289" fill="currentColor"><tspan font-weight="700">f.</tspan> models.dev / OpenRouter 目录元数据 — fetch_model_metadata()</text>
    <line x1="400" y1="300" x2="400" y2="310" stroke="#94a3b8" stroke-width="1.1" stroke-dasharray="3,2" marker-end="url(#ar7c)"/>
    <rect x="150" y="312" width="500" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.1"/>
    <text x="166" y="331" fill="currentColor"><tspan font-weight="700">g.</tspan> DEFAULT_CONTEXT_LENGTHS 静态兜底表 — 最长前缀匹配</text>
  </g>
</svg>
<span class="figure-caption">图 R7.3 ｜ get_model_context_length 的七级回退链：从缓存到端点查询再到静态兜底表</span>

<details>
<summary>ASCII 原版</summary>

```text
get_model_context_length(model, base_url, api_key, provider)
            │
   a. 缓存命中？ get_cached_context_length()        ← model_metadata.py:855
            │ miss
   b. 端点是 Anthropic？_query_anthropic_context_length()
            │ miss
   c. 端点是 Codex OAuth？_resolve_codex_oauth_context_length()
            │ miss
   d. 端点是 Nous？_resolve_nous_context_length()
            │ miss
   e. 本地 Ollama？query_ollama_num_ctx() / _query_ollama_api_show()
            │ miss
   f. models.dev / OpenRouter 目录元数据      ← fetch_model_metadata()
            │ miss
   g. DEFAULT_CONTEXT_LENGTHS 静态兜底表      ← 最长前缀匹配
```

</details>

成功解析后会 `save_context_length()`（`model_metadata.py:834`）写进磁盘缓存，下次直接命中。还有一个自学习机制：当某次请求因为超长被 API 拒绝时，`parse_context_limit_from_error()`（`model_metadata.py:886`）能从错误消息里把真实上限解析出来，`_invalidate_cached_context_length()`（`model_metadata.py:862`）则把错误的缓存值作废——Hermes 会从自己的失败中学到模型的真实上下文上限。

### 7.5.2 base_url → provider 反向映射

`config.yaml` 里用户经常只填了一个 base_url 和一个模型名，没填 provider。Hermes 需要从 base_url 反推提供商。`_infer_provider_from_url()`（`model_metadata.py:392`）就是这个反向索引——它拿 base_url 的 hostname 去匹配所有已注册 `ProviderProfile` 的 `get_hostname()`。`_is_known_provider_base_url()`（`model_metadata.py:410`）判断一个 base_url 是否对应某个已知提供商；`is_local_endpoint()`（`model_metadata.py:414`）和 `detect_local_server_type()`（`model_metadata.py:466`）则识别本地服务器（Ollama／LM Studio／llama.cpp）。这是 `ProviderProfile.hostname` 字段（7.2.1）的主要消费者。

### 7.5.3 cost 估算

`_extract_pricing()`（`model_metadata.py:571`）从目录元数据里抽取定价。它要应对一个现实：不同目录用不同的键名表示同一个概念。比如"输入 token 单价"在不同来源里叫 `prompt`／`input`／`input_cost_per_token`／`prompt_token_cost`。`model_metadata.py:583-587` 列出了这套别名表：

```python
"prompt": ("prompt", "input", "input_cost_per_token", "prompt_token_cost"),
"completion": ("completion", "output", "output_cost_per_token", "completion_token_cost"),
"request": ("request", "request_cost"),
"cache_read": ("cache_read", "cached_prompt", "input_cache_read", "cache_read_cost_per_token"),
"cache_write": ("cache_write", "cache_creation", "input_cache_write", "cache_write_cost_per_token"),
```

注意它还区分了 `cache_read` 和 `cache_write`——prompt caching 的读写单价不同，cost 估算必须分开算才准。`agent/models_dev.py` 封装了对 models.dev 这个公开模型目录的访问，是 `fetch_model_metadata()`（`model_metadata.py:611`）的数据源之一。`estimate_request_tokens_rough()`（`model_metadata.py:1806`）和 `estimate_messages_tokens_rough()`（`model_metadata.py:1730`）提供粗略 token 估算——它们被上下文压缩器（[第 8 章](08-context-compression.md)）大量使用。

## 7.6 辅助 LLM 客户端：侧任务的 provider 路由

`agent/auxiliary_client.py`（4899 行）是本章最大的文件，也是设计意图最值得讲清楚的一个。它解决的问题是：**Hermes 除了主对话，还有一大堆"侧任务"也需要调 LLM**——上下文压缩生成摘要、视觉分析图片、生成 embedding、给会话起标题（[第 9 章](09-session-storage.md)）、跨会话搜索总结……这些侧任务不应该都用主对话那个昂贵的旗舰模型，也不应该各自重新实现一遍"选 provider、处理认证、故障转移"的逻辑。

### 7.6.1 call_llm：集中式同步入口

`call_llm()`（`auxiliary_client.py:4237`）是所有侧任务的统一同步入口。它的签名第一个参数是 `task`：

```python
def call_llm(
    task: str = None,
    *,
    provider: str = None,
    model: str = None,
    base_url: str = None,
    api_key: str = None,
    main_runtime: Optional[Dict[str, Any]] = None,
    messages: list,
    ...
) -> Any:
```

`task` 取值是侧任务名——docstring（`auxiliary_client.py:4258-4259`）列出：`"compression"`、`"vision"`、`"web_extract"`、`"session_search"`、`"skills_hub"`、`"mcp"`、`"title_generation"`。给定 `task`，`call_llm()` 会从 `config.yaml` 的 `auxiliary.<task>` 段读取该任务配置的 provider 和 model。模块 docstring（`auxiliary_client.py:30-34`）说明：

> Per-task overrides are configured in config.yaml under the `auxiliary:` section (e.g. `auxiliary.vision.provider`, `auxiliary.compression.model`).

也就是说，用户可以在 `config.yaml` 里精确指定"压缩摘要用 Gemini Flash"、"视觉分析用 GPT-4o"，互不干扰。`_resolve_task_provider_model()`（`auxiliary_client.py:3949`）负责把 `task` 解析成具体的 `(provider, model, base_url, api_key, api_mode)` 五元组——优先级是任务配置 > 显式参数 > 自动探测。

### 7.6.2 fallback 链：main → OpenRouter → Nous → custom → 其他

如果某个任务配的是 `auto`，`call_llm()` 走自动探测的 fallback 链。`_resolve_auto()`（`auxiliary_client.py:2582`）的 docstring 把这条链描述为两步：

<svg viewBox="0 0 800 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-step auxiliary provider fallback chain">
  <defs>
    <marker id="ar7d" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="100" y="18" width="600" height="80" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="120" y="42" font-size="12" font-weight="700" fill="currentColor">Step 1 · 主 provider + 主 model → 直接用它们</text>
  <text x="120" y="64" font-size="10" fill="#64748b">OpenRouter / Nous 这类聚合器用户拿到自己选的 chat 模型</text>
  <text x="120" y="80" font-size="10" fill="#64748b">API-key 提供商用户切到便宜的 fallback 模型做侧任务</text>
  <line x1="400" y1="98" x2="400" y2="124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7d)"/>
  <text x="416" y="115" font-size="10" fill="#dc2626">主 provider 不可用，或最近 402 过</text>
  <rect x="100" y="126" width="600" height="58" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="120" y="150" font-size="12" font-weight="700" fill="currentColor">Step 2 · fallback 链</text>
  <text x="120" y="172" font-size="10" fill="#64748b">只在主 provider 没有可用 client 时用</text>
  <line x1="400" y1="184" x2="400" y2="210" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar7d)"/>
  <g font-size="10.5" font-weight="600">
    <rect x="40" y="212" width="116" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="98" y="234" text-anchor="middle" fill="currentColor">OpenRouter</text>
    <rect x="172" y="212" width="100" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="222" y="234" text-anchor="middle" fill="currentColor">Nous</text>
    <rect x="288" y="212" width="100" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="338" y="234" text-anchor="middle" fill="currentColor">custom</text>
    <rect x="404" y="212" width="100" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="454" y="234" text-anchor="middle" fill="currentColor">Codex</text>
    <rect x="520" y="212" width="170" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="605" y="234" text-anchor="middle" fill="currentColor">API-key 提供商</text>
  </g>
  <line x1="156" y1="229" x2="170" y2="229" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7d)"/>
  <line x1="272" y1="229" x2="286" y2="229" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7d)"/>
  <line x1="388" y1="229" x2="402" y2="229" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7d)"/>
  <line x1="504" y1="229" x2="518" y2="229" stroke="#94a3b8" stroke-width="1.1" marker-end="url(#ar7d)"/>
  <text x="400" y="272" text-anchor="middle" font-size="10" fill="#94a3b8">聚合器模型最全、最可能成功，排在前面；Anthropic 兜底</text>
</svg>
<span class="figure-caption">图 R7.4 ｜ 辅助 LLM 的两步 fallback 链：先用主 provider，失败后沿聚合器优先的链逐级回退</span>

<details>
<summary>ASCII 原版</summary>

```text
Step 1: 主 provider + 主 model → 直接用它们
        （OpenRouter / Nous 这类聚合器用户拿到自己选的 chat 模型；
         API-key 提供商用户切到便宜的 fallback 模型做侧任务）
            │ 主 provider 不可用，或最近 402 过
            ▼
Step 2: OpenRouter → Nous → custom → Codex → API-key 提供商
        （fallback 链，只在主 provider 没有可用 client 时用）
```

</details>

模块 docstring（`auxiliary_client.py:8-12`）给出的标准 fallback 顺序是：`main → OpenRouter → Nous → custom → Anthropic`。设计逻辑是：聚合器（OpenRouter、Nous）模型最全、最可能成功，所以排在前面；用户自己的主 provider 优先（不浪费配置）；Anthropic 兜底。

### 7.6.3 402 信用耗尽：不健康 provider 缓存

`call_llm()` 里最精巧的一段是 402 处理。`auxiliary_client.py:36-40` 的注释说明动机：

> Payment / credit exhaustion fallback: When a resolved provider returns HTTP 402 or a credit-related error, the chain advances to the next provider.

但如果只是"遇到 402 就往下走"，会有一个性能问题。`auxiliary_client.py:1981-1986` 的注释点出来了：

> When an auxiliary provider returns HTTP 402 ... [without caching] every aux call burns ~1 RTT, gets 402 again, then falls back. On a long Discord/LCM session that adds up to dozens of doomed 402s.

如果某个 provider 的信用已经耗尽，那么这个会话里**接下来每一次**辅助调用都会先打这个 provider、吃一个 402、再 fallback——一次往返白白浪费。在长会话里这能累积成几十次注定失败的 402。

解法是一个"最近 402 过的不健康 provider 缓存"。`_is_payment_error()`（`auxiliary_client.py:2089` 附近）识别 402——它不仅看 status 是否等于 402，还看错误体里有没有 `credits`／`afford` 这类词（`auxiliary_client.py:2096-2098`，因为 OpenRouter 等提供商的 402 体里会带这些）。`_mark_provider_unhealthy()`（`auxiliary_client.py:2029` 附近）把这个 provider 标记成"最近 402 过、暂时从链里隐藏"。下次 `_resolve_auto()` 走 Step 1 时，`_is_provider_unhealthy()` 检查（`auxiliary_client.py:2642-2645` 附近）会直接跳过它，省掉那次注定失败的往返。

这个机制让一个典型场景变得平滑：用户 OpenRouter 余额耗尽，但有 Codex OAuth 可用——第一次 402 之后，整个会话的辅助调用都直接走 Codex，不再反复撞 OpenRouter 的墙。

### 7.6.4 OpenRouter 归因头

辅助客户端在调 OpenRouter 时会带上归因头。`build_or_headers()`（`auxiliary_client.py:321`）构造它们，`auxiliary_client.py:308-314` 的注释说明 `X-Title` 是 OpenRouter dashboard 认的规范归因头（之前用的 `X-OpenRouter-Title` 不被识别）。这些头还可以携带响应缓存配置（`X-OpenRouter-Cache`、`X-OpenRouter-Cache-TTL`）。`auxiliary_client.py` 也有针对 Nvidia NIM（`build_nvidia_nim_headers()`，`auxiliary_client.py:380`）和 Codex Cloudflare（`_codex_cloudflare_headers()`，`auxiliary_client.py:444`）的专用头构造。

## 7.7 Provider 插件：声明式 profile 的注册

回到 7.2 的 `ProviderProfile`：它是纯数据。那二十多家提供商的 profile 实例放在哪里？答案是 `plugins/model-providers/` 目录——每个子目录是一个自包含的 provider profile 插件。

`plugins/model-providers/` 下当前有 30 个条目（ai-gateway、alibaba、anthropic、arcee、azure-foundry、bedrock、copilot、deepseek、gemini、gmi、huggingface、kimi-coding、minimax、nous、novita、nvidia、ollama-cloud、openai-codex、opencode-zen、openrouter、qwen-oauth、stepfun、xai、xiaomi、zai 等）。每个插件目录的结构很简单（`plugins/model-providers/README.md`）：

```text
plugins/model-providers/openrouter/
├── __init__.py      # 调用 register_provider(profile) 注册 ProviderProfile
└── plugin.yaml      # manifest：name、kind、version、description
```

发现机制是惰性的：`providers/__init__.py._discover_providers()` 在第一次有人调 `get_provider_profile()` 或 `list_providers()` 时扫描这个目录（以及 `$HERMES_HOME/plugins/model-providers/`）。每个 `__init__.py` 被 import，预期它调用 `providers.register_provider(profile)`。

一个最小的 provider 插件就是几行声明（`README.md` 给的模板）：

```python
from providers import register_provider
from providers.base import ProviderProfile

my_provider = ProviderProfile(
    name="your-provider",
    aliases=("alias1", "alias2"),
    display_name="Your Provider",
    description="One-line description shown in the setup picker",
    signup_url="https://your-provider.example.com/keys",
    env_vars=("YOUR_PROVIDER_API_KEY", "YOUR_PROVIDER_BASE_URL"),
    base_url="https://api.your-provider.example.com/v1",
    default_aux_model="your-cheap-model",
)
register_provider(my_provider)
```

用户在 `$HERMES_HOME/plugins/model-providers/<name>/` 放一个同名插件，可以覆盖内置插件（last-writer-wins）。这意味着新增一个 OpenAI 兼容提供商，通常**只需要写一个声明式 dataclass**，不用碰 `auth.py`、`config.py`、传输层任何一行代码——这正是 7.1 里"声明式 vs 命令式"分层的回报：大多数提供商落在声明式那一侧。只有 Anthropic／Bedrock／Gemini／Codex 这四家因为 API 形态差异太大，才需要 7.3 那样的命令式 adapter。

provider 插件的注册机制、发现顺序、用户覆盖的更多细节，参见[第 12 章](12-plugin-system.md)。

## 7.8 本章小结

Hermes 的多 provider 支持建立在一个清晰的分层上：

- **声明式层**——`ProviderProfile`（`providers/base.py:38`）用一个 dataclass 描述提供商的认证、端点、怪癖。`api_mode` 字段把传输路径分成 `chat_completions` / `codex_responses` / `anthropic_messages` 三类。绝大多数提供商落在这一层，新增一家只需写几行声明。
- **命令式层**——四个重量级 adapter（Anthropic Messages、Bedrock Converse、Gemini 原生 REST、Codex Responses）为 API 形态差异过大的提供商做双向格式翻译。出口统一归一化成 OpenAI 风格 assistant message，工具循环对此无感。
- **横切关注点**——`CredentialPool`（`credential_pool.py:387`）做同提供商多凭证的故障转移，401/429/402 差异化冷却，OAuth 单次有效 refresh token 的多进程竞态防御；`model_metadata.py` 做上下文上限查询和 cost 估算；`auxiliary_client.call_llm()`（`auxiliary_client.py:4237`）为侧任务做 provider 路由，带 402 不健康缓存的 fallback 链。

这套体系的核心价值是：工具循环只需要面对一个统一的"调一次 LLM"接口，二十多家提供商的全部异构性都被收敛在 profile、adapter、凭证池这三个边界清晰的模块里。

## 延伸阅读

- [第 3 章 同步工具调用循环](03-tool-loop.md)——本章的 adapter 和凭证池服务于工具循环的每一轮推理调用。
- [第 8 章 上下文压缩与轨迹压缩](08-context-compression.md)——上下文压缩的触发阈值依赖本章 `get_model_context_length()` 给出的上下文上限，压缩摘要通过 `call_llm(task="compression")` 走辅助客户端。
- [第 9 章 会话存储与全文搜索](09-session-storage.md)——会话标题生成、跨会话搜索总结都是本章辅助客户端服务的"侧任务"。
- [第 12 章 插件系统](12-plugin-system.md)——`plugins/model-providers/` 下 30 个 provider 插件的注册、发现与用户覆盖机制。
