# 第 4 章 系统提示与上下文构造

> 代码版本锁定：`NousResearch/hermes-agent@f36c89cd5`（2026-05-17）。本章所有 `file:line` 引用均基于此 commit。

## 4.1 本章要解决的问题

一个 agent 在每一轮对话里发给模型的请求，前面都挂着一段「系统提示」。它包含人格设定、可用工具的语义说明、行为规则、记忆快照、技能清单、运行环境信息。对于 Hermes 这种长生命周期、多轮、跨平台的 agent 来说，系统提示不是「写一段字符串塞进去」那么简单，它要同时满足三个互相冲突的目标：

1. **内容要全**——模型需要知道自己是谁、能用哪些工具、当前 cwd 在哪、用户的偏好是什么。
2. **token 要省**——系统提示动辄上万 token，每一轮都重发，是整个会话里最大的固定成本。
3. **要让上游的 prompt cache 命中**——Anthropic、OpenAI 等 provider 都按「前缀」缓存输入，只要某轮请求的前缀与上一轮逐字节一致，这部分 token 就按缓存价（约为原价的 1/10）计费。任何一个字符的变动都会让缓存失效。

这三个目标的张力，决定了 Hermes 系统提示构造的全部设计。本章拆解 `agent/system_prompt.py`、`agent/prompt_builder.py`、`agent/prompt_caching.py` 三个文件，回答：

- 系统提示由哪些块组成，为什么是这个顺序；
- 为什么系统提示一旦构建就在整个 session 内冻结；
- 为什么「技能」要作为 user message 注入，而不是塞进系统提示；
- SOUL.md / HERMES.md / AGENTS.md 这些上下文文件如何被发现、扫描、注入；
- 系统提示在什么时候被「作废」并重建。

## 4.2 三层模型：stable / context / volatile

整个系统提示构造的核心入口是 `build_system_prompt_parts()`（`agent/system_prompt.py:60`）。它不返回一个字符串，而是返回一个三键字典：

```python
return {
    "stable":   "\n\n".join(p.strip() for p in stable_parts   if p and p.strip()),
    "context":  "\n\n".join(p.strip() for p in context_parts  if p and p.strip()),
    "volatile": "\n\n".join(p.strip() for p in volatile_parts if p and p.strip()),
}
```
（`agent/system_prompt.py:267-271`）

`build_system_prompt()`（`agent/system_prompt.py:274`）再把这三层按固定顺序拼成一整段：

```python
parts = build_system_prompt_parts(agent, system_message=system_message)
return "\n\n".join(p for p in (parts["stable"], parts["context"], parts["volatile"]) if p)
```
（`agent/system_prompt.py:289-290`）

三层的语义边界来自文件顶部的 docstring（`agent/system_prompt.py:10-19`）：

| 层 | 内容 | 变化频率 | 缓存意义 |
|---|---|---|---|
| `stable` | 身份（SOUL.md / `DEFAULT_AGENT_IDENTITY`）、工具行为指引、Nous 订阅块、工具调用强制指引、按模型族的操作指引、技能清单、环境提示、平台提示 | 进程生命周期内基本不变 | 缓存前缀的主体 |
| `context` | caller 传入的 `system_message`、cwd 下发现的上下文文件（AGENTS.md / .cursorrules 等） | 每个 session 可能不同，session 内不变 | 仍可缓存（session 内稳定） |
| `volatile` | 记忆快照、USER.md 用户画像、外部记忆 provider 块、时间戳/session/model/provider 行 | 理论上每轮可变 | 不指望缓存 |

为什么要分三层而不是直接拼一个串？因为**缓存命中是「前缀匹配」**。把最稳定的内容放最前面，把最易变的内容放最后面，可以让前缀的「稳定区段」尽可能长。即使 `volatile` 段每轮都变，只要它在最后，前面的 `stable`+`context` 仍然能命中缓存。如果把时间戳放在开头，整段系统提示每轮都失效。

需要强调的是：**这三层只是「概念上」的分层**。一旦 `build_system_prompt()` 把它们拼成字符串，整段会被当作**一个不可分割的缓存块**对待（见 `agent/system_prompt.py:285-287` docstring：「The whole string is treated as one cached block — Hermes never rebuilds or reinjects parts of it mid-session」）。Hermes 不会在会话中途单独重渲染某一层。分层的意义在于**构造时的排序纪律**，而不是运行时的分段缓存。

<svg viewBox="0 0 780 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="System prompt construction flow from build_system_prompt to cached field">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="270" y="20" width="240" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="44" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">build_system_prompt()</text>
  <line x1="390" y1="60" x2="390" y2="86" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="230" y="88" width="320" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="112" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">build_system_prompt_parts(agent, system_message)</text>
  <line x1="390" y1="128" x2="390" y2="150" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="150" y1="150" x2="630" y2="150" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="150" y1="150" x2="150" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="390" y1="150" x2="390" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <line x1="630" y1="150" x2="630" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="40" y="174" width="220" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.3"/>
  <text x="150" y="195" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">stable_parts</text>
  <text x="150" y="213" text-anchor="middle" font-size="10" fill="#64748b">身份 / 工具指引 / 技能清单</text>
  <text x="150" y="225" text-anchor="middle" font-size="10" fill="#64748b">/ 环境提示 ...</text>
  <rect x="280" y="174" width="220" height="56" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="390" y="195" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">context_parts</text>
  <text x="390" y="213" text-anchor="middle" font-size="10" fill="#64748b">system_message</text>
  <text x="390" y="225" text-anchor="middle" font-size="10" fill="#64748b">+ AGENTS.md / HERMES.md ...</text>
  <rect x="520" y="174" width="220" height="56" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="630" y="195" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">volatile_parts</text>
  <text x="630" y="213" text-anchor="middle" font-size="10" fill="#64748b">记忆 / USER.md / 时间戳</text>
  <line x1="150" y1="230" x2="150" y2="262" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="390" y1="230" x2="390" y2="262" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="630" y1="230" x2="630" y2="262" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="150" y1="262" x2="630" y2="262" stroke="#94a3b8" stroke-width="1.2"/>
  <line x1="390" y1="262" x2="390" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="210" y="286" width="360" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="305" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">"\n\n".join(stable, context, volatile)</text>
  <text x="390" y="319" text-anchor="middle" font-size="10" fill="#64748b">单一字符串，整体缓存</text>
  <line x1="390" y1="326" x2="390" y2="352" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4)"/>
  <rect x="240" y="354" width="300" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="373" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">agent._cached_system_prompt</text>
  <text x="390" y="387" text-anchor="middle" font-size="10" fill="#64748b">缓存于 AIAgent 实例，session 内复用</text>
</svg>
<span class="figure-caption">图 R4.1 ｜ 系统提示从入口函数到三层拼接、再冻结为 _cached_system_prompt 的构造流程</span>

<details>
<summary>ASCII 原版</summary>

```text
build_system_prompt()
        │
        ▼
build_system_prompt_parts(agent, system_message)
        │
        ├── stable_parts   ──► 身份 / 工具指引 / 技能清单 / 环境提示 ...
        ├── context_parts  ──► system_message + AGENTS.md/HERMES.md/...
        └── volatile_parts ──► 记忆 / USER.md / 时间戳
        │
        ▼
   "\n\n".join(stable, context, volatile)   ← 单一字符串，整体缓存
        │
        ▼
   agent._cached_system_prompt   ← 缓存于 AIAgent 实例，session 内复用
```

</details>

## 4.3 stable 层逐块拆解

`stable_parts` 是一个 `list`，块按 append 顺序排列（`agent/system_prompt.py:84-212`）。理解顺序就理解了设计意图。

### 4.3.1 身份块（slot #1）

第一块永远是 agent 的身份。优先尝试 `SOUL.md`，失败才用硬编码默认身份：

```python
_soul_loaded = False
if agent.load_soul_identity or not agent.skip_context_files:
    _soul_content = _r.load_soul_md()
    if _soul_content:
        stable_parts.append(_soul_content)
        _soul_loaded = True

if not _soul_loaded:
    stable_parts.append(DEFAULT_AGENT_IDENTITY)
```
（`agent/system_prompt.py:89-98`）

`_soul_loaded` 这个布尔值后面还会用到——它会作为 `skip_soul=True` 传给 `build_context_files_prompt()`（`agent/system_prompt.py:229`），防止 SOUL.md 被注入两次（一次作为身份，一次作为上下文文件）。

为什么身份必须排第一？因为它是整段提示里**最稳定**的内容（一个用户的 SOUL.md 几个月才改一次），把它放最前面，缓存前缀的不变区段最长。同时模型的「人设锚定」也最强——开头第一句话定义「你是谁」，后续所有指令都在这个身份之下生效。

### 4.3.2 hermes-agent 帮助指引

```python
stable_parts.append(HERMES_AGENT_HELP_GUIDANCE)
```
（`agent/system_prompt.py:101`）

这是一个固定字符串，告诉模型：当用户问的是「Hermes 本身」的问题（怎么配置、怎么加 provider），应去加载 `hermes-agent` 技能并参考其文档。它无条件注入。

### 4.3.3 工具感知的行为指引（条件注入）

接下来一组指引**只在对应工具实际存在时**才注入：

```python
tool_guidance = []
if "memory" in agent.valid_tool_names:
    tool_guidance.append(MEMORY_GUIDANCE)
if "session_search" in agent.valid_tool_names:
    tool_guidance.append(SESSION_SEARCH_GUIDANCE)
if "skill_manage" in agent.valid_tool_names:
    tool_guidance.append(SKILLS_GUIDANCE)
if "kanban_show" in agent.valid_tool_names:
    tool_guidance.append(KANBAN_GUIDANCE)
if tool_guidance:
    stable_parts.append(" ".join(tool_guidance))
```
（`agent/system_prompt.py:104-118`）

这是一条贯穿全章的设计原则：**不存在的工具不解释**。如果当前 toolset 里没有 `memory` 工具，那 `MEMORY_GUIDANCE`（教模型何时记笔记）就是纯粹的 token 浪费，还可能诱导模型去调用一个不存在的工具。`agent.valid_tool_names` 是当前会话实际启用的工具名集合（由 toolset 解析得到，详见第 5 章）。

`computer_use` 的指引是多段落文本，单独成块而非并进 `tool_guidance`（`agent/system_prompt.py:122-124`），并且用了**延迟导入**——只有真的需要时才 `from agent.prompt_builder import COMPUTER_USE_GUIDANCE`。

### 4.3.4 Nous 订阅块

```python
nous_subscription_prompt = _r.build_nous_subscription_prompt(agent.valid_tool_names)
if nous_subscription_prompt:
    stable_parts.append(nous_subscription_prompt)
```
（`agent/system_prompt.py:126-128`）

`build_nous_subscription_prompt()`（`agent/prompt_builder.py:1222`）做了几层条件判断：

- 如果 `managed_nous_tools_enabled()` 为假，直接返回空串（`agent/prompt_builder.py:1233-1234`）；
- 如果当前工具集与「Nous 订阅相关的工具」（web_search、browser_*、image_generate、terminal、execute_code 等，`agent/prompt_builder.py:1237-1254`）完全不交集，也返回空串——没有相关工具就没必要告诉模型订阅状态；
- 否则枚举每个特性的状态（`active via Nous subscription` / `currently using <provider>` / `not currently available`，见 `_status_line()` `agent/prompt_builder.py:1259-1270`），生成一个 `# Nous Subscription` 块。

这个块的作用是让模型知道哪些托管能力可用，从而**不会向用户索要其实已经由订阅托管的 API key**（`agent/prompt_builder.py:1278-1283`）。

### 4.3.5 工具调用强制指引（按 config 控制，含模型族分支）

`agent/system_prompt.py:136-160` 这一段处理「工具调用强制」。问题背景：某些模型倾向于「描述自己将要做什么」而不是真的发起 tool call。`TOOL_USE_ENFORCEMENT_GUIDANCE` 就是一段明确要求「立即调用工具，不要只描述」的指引。

是否注入由 `config.yaml` 的 `agent.tool_use_enforcement` 控制，逻辑见：

```python
if agent.valid_tool_names:
    _enforce = agent._tool_use_enforcement
    _inject = False
    if _enforce is True or (isinstance(_enforce, str) and _enforce.lower() in {"true", "always", "yes", "on"}):
        _inject = True
    elif _enforce is False or (...):
        _inject = False
    elif isinstance(_enforce, list):
        model_lower = (agent.model or "").lower()
        _inject = any(p.lower() in model_lower for p in _enforce if isinstance(p, str))
    else:  # "auto" 或无法识别的值
        model_lower = (agent.model or "").lower()
        _inject = any(p in model_lower for p in TOOL_USE_ENFORCEMENT_MODELS)
```
（`agent/system_prompt.py:137-149`）

四种取值：`true` 总是注入，`false` 从不注入，`list` 按模型名子串匹配，`"auto"`（默认）按硬编码的 `TOOL_USE_ENFORCEMENT_MODELS` 列表匹配。

一旦决定注入，还会按模型族追加专属操作指引：

```python
if _inject:
    stable_parts.append(TOOL_USE_ENFORCEMENT_GUIDANCE)
    _model_lower = (agent.model or "").lower()
    if "gemini" in _model_lower or "gemma" in _model_lower:
        stable_parts.append(GOOGLE_MODEL_OPERATIONAL_GUIDANCE)
    if "gpt" in _model_lower or "codex" in _model_lower:
        stable_parts.append(OPENAI_MODEL_EXECUTION_GUIDANCE)
```
（`agent/system_prompt.py:150-160`）

Google 模型有 `GOOGLE_MODEL_OPERATIONAL_GUIDANCE`（强调简洁、绝对路径、并行调用、改前先验证），OpenAI GPT/Codex 有 `OPENAI_MODEL_EXECUTION_GUIDANCE`（工具持久性、前置检查、防幻觉）。这些指引是「按模型族打补丁」——同一套 agent 框架要驱动十几种 provider 的模型，各家模型的「坏习惯」不同，需要针对性纠偏。

注意 `agent.model` 和 `agent.provider` 在 `AIAgent` 构造时就固定了，所以这段输出在实例生命周期内是稳定的——放在 stable 层是正确的。

### 4.3.6 技能清单（skills index）

```python
has_skills_tools = any(name in agent.valid_tool_names for name in ['skills_list', 'skill_view', 'skill_manage'])
if has_skills_tools:
    avail_toolsets = {
        toolset
        for toolset in (_r.get_toolset_for_tool(t) for t in agent.valid_tool_names)
        if toolset
    }
    skills_prompt = _r.build_skills_system_prompt(
        available_tools=agent.valid_tool_names,
        available_toolsets=avail_toolsets,
    )
else:
    skills_prompt = ""
if skills_prompt:
    stable_parts.append(skills_prompt)
```
（`agent/system_prompt.py:162-178`）

这里注入的是**技能的「索引」**——一个紧凑的「分类 → 技能名 → 一句话描述」列表，而**不是技能正文**。技能正文走完全不同的注入路径，见 4.6 节。`build_skills_system_prompt()` 的内部机制（两层缓存、外部技能目录、条件过滤）见 4.5 节。

### 4.3.7 Alibaba 模型名修正

```python
if agent.provider == "alibaba":
    _model_short = agent.model.split("/")[-1] if "/" in agent.model else agent.model
    stable_parts.append(
        f"You are powered by the model named {_model_short}. "
        f"The exact model ID is {agent.model}. ..."
    )
```
（`agent/system_prompt.py:185-192`）

这是一个具体的 API bug workaround：阿里云 Coding Plan API 不管你请求哪个模型，都返回 `"glm-4.7"` 作为模型名。于是 Hermes 在系统提示里显式写明真实模型身份，让模型在被问「你是什么模型」时不要采信 API 返回的错误名字。这种 workaround 放 stable 层是合理的——provider 和 model 在构造时就固定。

### 4.3.8 环境提示与平台提示

`stable` 层最后两块：

```python
_env_hints = _r.build_environment_hints()
if _env_hints:
    stable_parts.append(_env_hints)

platform_key = (agent.platform or "").lower().strip()
if platform_key in PLATFORM_HINTS:
    stable_parts.append(PLATFORM_HINTS[platform_key])
elif platform_key:
    try:
        from gateway.platform_registry import platform_registry
        _entry = platform_registry.get(platform_key)
        if _entry and _entry.platform_hint:
            stable_parts.append(_entry.platform_hint)
    except Exception:
        pass
```
（`agent/system_prompt.py:197-212`）

`build_environment_hints()` 是 4.4 节的主题。平台提示 `PLATFORM_HINTS` 是一个 dict，按 `agent.platform`（telegram / discord / slack 等）选不同的提示文本——例如告诉模型 Telegram 消息有长度限制、Discord 支持 markdown 但不支持表格等。如果平台来自插件，则去 `platform_registry` 查 `platform_hint`。

## 4.4 build_environment_hints：Git/Docker/Modal 环境信息

`build_environment_hints()`（`agent/prompt_builder.py:736`）的作用：告诉模型它的工具实际在**哪台机器、哪个环境**里运行。这件事很关键，因为 Hermes 的 `terminal` / `read_file` / `write_file` / `patch` / `search_files` 工具不一定在本机执行——可能在 Docker 容器、SSH 远端、Modal serverless 沙箱里。如果模型以为自己在本机，就会用错路径、用错 shell 语法。

### 4.4.1 本地后端：报告宿主信息

当 `TERMINAL_ENV` 是 `local`（或未设），后端 == 工具执行处 == Hermes 进程所在机器，所以直接报告宿主信息：

```python
backend = (os.getenv("TERMINAL_ENV") or "local").strip().lower()
is_remote_backend = backend in _REMOTE_TERMINAL_BACKENDS

if not is_remote_backend:
    host_lines: list[str] = []
    if is_wsl():
        host_lines.append("Host: WSL (Windows Subsystem for Linux)")
    elif sys.platform == "win32":
        host_lines.append(f"Host: Windows ({platform.release()})")
    elif sys.platform == "darwin":
        host_lines.append(f"Host: macOS ({platform.mac_ver()[0] or platform.release()})")
    else:
        host_lines.append(f"Host: {platform.system()} ({platform.release()})")
    host_lines.append(f"User home directory: {os.path.expanduser('~')}")
    host_lines.append(f"Current working directory: {os.getcwd()}")
```
（`agent/prompt_builder.py:761-777`）

Windows 本地有两条特别的提示：一条警告「机器名 ≠ 用户名，构造 `C:\Users\<user>\` 路径要用上面的 home，不要用 hostname」（`agent/prompt_builder.py:779-786`），一条说明「Windows 本地的 `terminal` 跑的是 bash，不是 PowerShell」（`agent/prompt_builder.py:788-792`）——否则模型会发 PowerShell 语法导致失败。

### 4.4.2 远程后端：抑制宿主信息，活探后端

当后端是 docker / singularity / modal / daytona / ssh / vercel_sandbox 之一（`_REMOTE_TERMINAL_BACKENDS`），宿主信息**被抑制**——因为模型的工具碰不到宿主，宿主的 OS/home/cwd 是误导。取而代之的是对后端做一次「活探」：

```python
else:
    probe = _probe_remote_backend(backend)
    if probe:
        hints.append(
            f"Terminal backend: {backend}. Your `terminal`, `read_file`, "
            f"`write_file`, `patch`, and `search_files` tools all operate "
            f"inside this {backend} environment — NOT on the machine "
            f"where Hermes itself is running. ...\n{probe}"
        )
    else:
        description = _BACKEND_FALLBACK_DESCRIPTIONS.get(backend, ...)
        hints.append(... "probe didn't respond ... probe directly with "
                     "a terminal call like `uname -a && whoami && pwd`.")
```
（`agent/prompt_builder.py:793-818`）

`_probe_remote_backend()`（`agent/prompt_builder.py` 上方）会进容器/沙箱执行一段命令，回收 `os` / `kernel` / `user` / `home` / `cwd`，解析成键值对再格式化（`agent/prompt_builder.py:704-727`）。探测结果带进程级缓存 `_BACKEND_PROBE_CACHE`——探一次后整个进程复用。如果探测失败，退回静态描述并提示模型「需要的话自己用 terminal 探」。

WSL 环境下，无论本地还是远程都会再追加一段 `WSL_ENVIRONMENT_HINT`（`agent/prompt_builder.py:820-822`）。

这个设计回答了一个常见困惑：**为什么远程后端的系统提示里看不到本机路径？** 答案是故意抑制——模型只需知道沙箱状态，宿主状态是噪音。

## 4.5 build_skills_system_prompt：技能清单的两层缓存

`build_skills_system_prompt()`（`agent/prompt_builder.py:988`）生成 4.3.6 里那段技能索引。它要扫描 `~/.hermes/skills/` 下成百上千个 `SKILL.md`，解析 frontmatter，过滤平台/工具条件，再排版成索引。这是个 IO 密集操作，不能每次构建系统提示都重做。

### 4.5.1 两层缓存

<svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-layer cache for build_skills_system_prompt">
  <defs>
    <marker id="ar4b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="220" y="18" width="360" height="38" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">build_skills_system_prompt(tools, toolsets)</text>
  <line x1="400" y1="56" x2="400" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar4b)"/>
  <rect x="60" y="80" width="680" height="62" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.3"/>
  <text x="78" y="100" font-size="12" font-weight="600" fill="currentColor">Layer 1 · 进程内 LRU dict（_SKILLS_PROMPT_CACHE，最多 8 条）</text>
  <text x="78" y="118" font-size="10" fill="#64748b">key = (skills_dir, external_dirs, tools, toolsets, platform, disabled)</text>
  <text x="78" y="133" font-size="10" fill="#16a34a">命中 → 直接返回</text>
  <line x1="400" y1="142" x2="400" y2="160" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar4b)"/>
  <text x="416" y="155" font-size="10" fill="#94a3b8">未命中</text>
  <rect x="60" y="162" width="680" height="62" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.3"/>
  <text x="78" y="182" font-size="12" font-weight="600" fill="currentColor">Layer 2 · 磁盘快照（.skills_prompt_snapshot.json）</text>
  <text x="78" y="200" font-size="10" fill="#64748b">用 mtime/size manifest 校验是否仍然有效</text>
  <text x="78" y="215" font-size="10" fill="#16a34a">有效 → 用预解析的元数据走「快路径」</text>
  <line x1="400" y1="224" x2="400" y2="242" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#ar4b)"/>
  <text x="416" y="237" font-size="10" fill="#94a3b8">快照失效</text>
  <rect x="60" y="244" width="680" height="56" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.3"/>
  <text x="78" y="264" font-size="12" font-weight="600" fill="currentColor">冷路径 · 全量文件系统扫描</text>
  <text x="78" y="282" font-size="10" fill="#64748b">扫描所有 SKILL.md → 解析 frontmatter → 排版 → 写回磁盘快照</text>
</svg>
<span class="figure-caption">图 R4.2 ｜ 技能清单构造的两层缓存：进程内 LRU、磁盘快照、冷路径全量扫描逐级回退</span>

<details>
<summary>ASCII 原版</summary>

```text
build_skills_system_prompt(available_tools, available_toolsets)
        │
        ├─ Layer 1: 进程内 LRU dict（_SKILLS_PROMPT_CACHE，最多 8 条）
        │     key = (skills_dir, external_dirs, tools, toolsets, platform, disabled)
        │     命中 → 直接返回
        │
        ├─ Layer 2: 磁盘快照（.skills_prompt_snapshot.json）
        │     用 mtime/size manifest 校验是否仍然有效
        │     有效 → 用预解析的元数据走「快路径」
        │
        └─ 冷路径：全量文件系统扫描 → 写回磁盘快照
```

</details>

Layer 1 的 cache key（`agent/prompt_builder.py:1010-1018`）包含了平台 hint 和被禁用技能名——因为 gateway 进程可能同时服务多个平台，每个平台有自己的 `skills.platform_disabled` 视图，必须产生不同的缓存项。

Layer 2 的磁盘快照由 `_load_skills_snapshot()`（`agent/prompt_builder.py:866`）加载，其有效性靠 `_build_skills_manifest()`（`agent/prompt_builder.py:855`）——它把每个 `SKILL.md` / `DESCRIPTION.md` 的 `(mtime_ns, size)` 收成一个 manifest，只要 manifest 不变就认为快照有效。这让技能索引能跨进程重启快速冷启动。

### 4.5.2 条件过滤

技能可以在 frontmatter 里声明「条件激活」规则，`_skill_should_show()`（`agent/prompt_builder.py:961`）实现过滤逻辑：

```python
# fallback_for: 当主工具/工具集存在时，隐藏该技能
for ts in conditions.get("fallback_for_toolsets", []):
    if ts in ats:
        return False
# requires: 当所需工具/工具集不存在时，隐藏该技能
for t in conditions.get("requires_tools", []):
    if t not in at:
        return False
```
（`agent/prompt_builder.py:973-985`）

`fallback_for` 让一个技能在「更好的原生工具存在」时自动隐身（例如某个用 curl 实现的搜索技能，在 `web_search` 工具可用时就不该出现）；`requires` 让技能在缺依赖时不出现，避免模型加载一个用不了的技能。

### 4.5.3 技能索引的措辞

最终生成的索引块以 `## Skills (mandatory)` 开头（`agent/prompt_builder.py:1180`），措辞相当强硬：「回复前必须扫描下列技能，只要有技能哪怕部分相关，你必须用 `skill_view(name)` 加载它并遵循其指令」。技能名/描述列在 `<available_skills>` 标签里，按 category 分组。

这个强硬措辞背后的设计意图：技能是 Hermes 自我改进闭环的产物，承载了「这个用户/项目偏好的做法」。系统提示要把「加载技能」变成默认行为而非可选项。

## 4.6 为什么技能正文不进系统提示——prompt caching 的核心权衡

这是本章最重要的设计决策。

### 4.6.1 上游 prompt caching 怎么工作

`agent/prompt_caching.py` 实现了 Anthropic 的缓存策略。整个文件只有一种布局，叫 `system_and_3`：

```python
def apply_anthropic_cache_control(api_messages, cache_ttl="5m", native_anthropic=False):
    """Place up to 4 cache_control breakpoints: system prompt + last 3
    non-system messages, all at the same TTL."""
    messages = copy.deepcopy(api_messages)
    marker = _build_marker(cache_ttl)
    breakpoints_used = 0
    if messages[0].get("role") == "system":
        _apply_cache_marker(messages[0], marker, native_anthropic=native_anthropic)
        breakpoints_used += 1
    remaining = 4 - breakpoints_used
    non_sys = [i for i in range(len(messages)) if messages[i].get("role") != "system"]
    for idx in non_sys[-remaining:]:
        _apply_cache_marker(messages[idx], marker, native_anthropic=native_anthropic)
    return messages
```
（`agent/prompt_caching.py:49-79`）

要点：

- Anthropic 最多支持 4 个 `cache_control` 断点。Hermes 把它们用在「系统提示 + 最后 3 条非系统消息」上。
- 缓存是**前缀**缓存。一个断点意味着「从对话开头到这个断点的所有 token」被缓存为一个块。
- 命中条件：这一段前缀与上一次请求**逐字节一致**。
- 文件 docstring 写明：在单个 session 的多轮对话里，这能把输入 token 成本降低约 75%（`agent/prompt_caching.py:4-6`）。

### 4.6.2 系统提示必须冻结

既然系统提示是第一个、也是最长的缓存块，它必须**逐字节稳定**。这就是为什么 `build_system_prompt()` 的 docstring 反复强调：

> Called once per session (cached on `agent._cached_system_prompt`) and only rebuilt after context compression events. ... Hermes never rebuilds or reinjects parts of it mid-session, which is the only way to keep upstream prompt caches warm across turns.
> （`agent/system_prompt.py:277-287`）

系统提示在 `AIAgent` 上有一个缓存字段 `_cached_system_prompt`。一个 session 内，它只构建一次。即使记忆更新了、技能增删了，也**不重建**系统提示——因为重建会让整段前缀失效，后续每一轮都要按全价重新计费整个系统提示。

### 4.6.3 技能正文走 user message

如果技能正文（动辄几千 token）塞进系统提示，会有两个致命问题：

1. **缓存被打爆**：用户每加载一个技能，系统提示就变长、变样，缓存失效。多轮会话里反复加载技能 = 反复全价计费整个系统提示。
2. **不可能预测**：系统提示在 session 开头构建，那时根本不知道用户后面会加载哪些技能。

Hermes 的解法：系统提示里只放**技能索引**（4.5 节，稳定、小），技能**正文**作为 **user message** 在用户真的调用 `/skill-name` 或 `skill_view` 时才注入对话流。

这一注入路径由 `agent/skill_commands.py` 实现。`build_skill_invocation_message()`（`agent/skill_commands.py:406`）在用户输入 `/skill-name` 时被调用，它加载技能 payload，包上一段激活说明，返回一段 message 内容：

```python
activation_note = (
    f'[IMPORTANT: The user has invoked the "{skill_name}" skill, indicating they want '
    "you to follow its instructions. The full skill content is loaded below.]"
)
return _build_skill_message(loaded_skill, skill_dir, activation_note,
                            user_instruction=user_instruction, ...)
```
（`agent/skill_commands.py:439-450`）

`_build_skill_message()`（`agent/skill_commands.py:138`）负责把技能正文、技能目录路径、解析后的技能 config、setup 提示、配套文件清单组装成一段文本（`agent/skill_commands.py:161-238`）。

这样做的妙处在于：技能正文进入的是「对话消息流」，而 `system_and_3` 缓存策略的另外 3 个断点恰好覆盖「最后 3 条非系统消息」。技能正文一旦注入，会随对话推进逐步落入可缓存的尾部断点；同时**系统提示这个前缀块完全不受影响**，永远命中缓存。

`reload_skills()` 的 docstring 把这层考量讲得很直白：

> This does NOT invalidate the skills system-prompt cache. Skills are called by name ... they don't need to be in the system prompt for the model to use them. Keeping the prompt cache intact preserves prefix caching across the reload, so a user invoking `/reload-skills` pays no cache-reset cost.
> （`agent/skill_commands.py:329-334`）

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Frozen system prompt versus skill body injected into message stream">
  <rect x="40" y="20" width="720" height="120" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="44" font-size="12" font-weight="700" fill="currentColor">系统提示（冻结，缓存断点 #1）</text>
  <rect x="60" y="54" width="680" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="72" y="70" font-size="10.5" fill="currentColor">stable：身份 + 工具指引 + 技能"索引"</text>
  <text x="730" y="70" text-anchor="end" font-size="10" fill="#16a34a">只有名字+描述，几十 token</text>
  <rect x="60" y="82" width="680" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="72" y="98" font-size="10.5" fill="currentColor">context：AGENTS.md ...</text>
  <rect x="60" y="110" width="680" height="24" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="72" y="126" font-size="10.5" fill="currentColor">volatile：记忆 + 时间戳</text>
  <line x1="40" y1="156" x2="760" y2="156" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4,3"/>
  <text x="400" y="178" text-anchor="middle" font-size="12" font-weight="600" fill="#64748b">对话消息流</text>
  <rect x="60" y="190" width="680" height="24" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="72" y="206" font-size="10.5" fill="currentColor">user：「帮我做 X」</text>
  <rect x="60" y="218" width="680" height="24" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="72" y="234" font-size="10.5" fill="currentColor">assistant：...</text>
  <rect x="60" y="246" width="680" height="48" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="72" y="266" font-size="10.5" font-weight="600" fill="currentColor">user：「/code-review」 ← 技能"正文"在这里注入，几千 token</text>
  <text x="72" y="284" font-size="10" fill="#7c3aed">↑ 落入 system_and_3 的尾部 3 个缓存断点</text>
  <rect x="60" y="298" width="680" height="24" rx="3" fill="#fff" stroke="#94a3b8"/>
  <text x="72" y="314" font-size="10.5" fill="currentColor">assistant：...</text>
  <text x="400" y="346" text-anchor="middle" font-size="10" fill="#94a3b8">系统提示前缀块永远命中缓存，技能正文随尾部断点滚动</text>
</svg>
<span class="figure-caption">图 R4.3 ｜ 冻结的系统提示只放技能索引，技能正文作为 user message 注入消息流尾部缓存断点</span>

<details>
<summary>ASCII 原版</summary>

```text
系统提示（冻结，缓存断点 #1）
├─ stable: 身份 + 工具指引 + 技能"索引" ← 只有名字+描述，几十 token
├─ context: AGENTS.md ...
└─ volatile: 记忆 + 时间戳
─────────────────────────────────────────────
对话消息流
├─ user: "帮我做 X"
├─ assistant: ...
├─ user: "/code-review"  ← 技能"正文"在这里注入，几千 token
│        ↑ 落入 system_and_3 的尾部 3 个缓存断点
├─ assistant: ...
└─ ...
```

</details>

一句话总结这个权衡：**技能索引（小、稳定）进系统提示换取「模型知道有哪些技能」；技能正文（大、动态）进消息流换取「不破坏系统提示缓存」。**

## 4.7 上下文文件：SOUL.md / HERMES.md / AGENTS.md 的注入

`context` 层的内容来自 `build_context_files_prompt()`（`agent/prompt_builder.py:1419`）。它在 `build_system_prompt_parts` 里被调用：

```python
if not agent.skip_context_files:
    _context_cwd = os.getenv("TERMINAL_CWD") or None
    context_files_prompt = _r.build_context_files_prompt(
        cwd=_context_cwd, skip_soul=_soul_loaded)
    if context_files_prompt:
        context_parts.append(context_files_prompt)
```
（`agent/system_prompt.py:222-231`）

注意这里特意用 `TERMINAL_CWD` 而非 `os.getcwd()`——在 gateway 模式下，gateway 进程是从 hermes-agent 安装目录启动的，用 `os.getcwd()` 会误把仓库自己的 `AGENTS.md` 等开发文件读进来，平白多 ~10k token（`agent/system_prompt.py:223-227` 注释）。

### 4.7.1 文件优先级

`build_context_files_prompt()` 的核心逻辑——**项目上下文「先找到的赢」，只加载一种**：

```python
project_context = (
    _load_hermes_md(cwd_path)        # 1. .hermes.md / HERMES.md（向上走到 git root）
    or _load_agents_md(cwd_path)     # 2. AGENTS.md / agents.md（仅当前目录）
    or _load_claude_md(cwd_path)     # 3. CLAUDE.md / claude.md（仅当前目录）
    or _load_cursorrules(cwd_path)   # 4. .cursorrules + .cursor/rules/*.mdc
)
if project_context:
    sections.append(project_context)

if not skip_soul:
    soul_content = load_soul_md()
    if soul_content:
        sections.append(soul_content)
```
（`agent/prompt_builder.py:1438-1452`）

四种项目上下文文件互斥，只取第一个命中的。`SOUL.md`（来自 `HERMES_HOME`）是独立的，总是包含——除非 `skip_soul=True`（即 SOUL.md 已被当作身份注入，4.3.1 节）。

四个加载器的差异：

| 函数 | 文件 | 搜索范围 |
|---|---|---|
| `_load_hermes_md()` (`prompt_builder.py:1332`) | `.hermes.md` / `HERMES.md` | cwd 起向上走，**直到 git root** |
| `_load_agents_md()` (`prompt_builder.py:1357`) | `AGENTS.md` / `agents.md` | 仅 cwd（不递归） |
| `_load_claude_md()` (`prompt_builder.py:1372`) | `CLAUDE.md` / `claude.md` | 仅 cwd |
| `_load_cursorrules()` (`prompt_builder.py:1387`) | `.cursorrules` + `.cursor/rules/*.mdc` | 仅 cwd |

为什么 HERMES.md 要向上走到 git root，而 AGENTS.md 只看当前目录？因为 `.hermes.md` 是 Hermes 自家约定的「项目级」配置，理应整个仓库共享一份；而 `AGENTS.md` / `CLAUDE.md` / `.cursorrules` 是别的工具的约定，Hermes 只「兼容读取」最近的一份，不主动向上找。`_find_hermes_md()`（`agent/prompt_builder.py:96`）的实现就是从 cwd 逐级向上，在 git root（`_find_git_root()`，`agent/prompt_builder.py:79`）处停下。

### 4.7.2 SOUL.md 与 HERMES.md 的语义分工

- **SOUL.md** 是 agent 的**人格/身份**文件，存于 `HERMES_HOME`（用户级，跨项目）。`load_soul_md()`（`agent/prompt_builder.py:1304`）加载它。它在系统提示里占「身份 slot #1」。
- **HERMES.md / .hermes.md** 是**项目上下文**文件，存于项目目录（项目级）。`_load_hermes_md()` 加载它，会剥掉 YAML frontmatter（`_strip_yaml_frontmatter()`，`agent/prompt_builder.py:124`），只注入人类可读的 markdown 正文，并加上 `## <相对路径>` 标题。

二者的注入位置也不同：SOUL.md 进 `stable` 层（身份），HERMES.md 进 `context` 层（项目上下文）。

### 4.7.3 上下文文件的安全扫描

上下文文件来自用户的项目目录，**可能被投毒**——一个恶意仓库的 `AGENTS.md` 里可能藏着 prompt injection。所以每个上下文文件在注入前都过一遍 `_scan_context_content()`（`agent/prompt_builder.py:60`）：

```python
_CONTEXT_THREAT_PATTERNS = [
    (r'ignore\s+(previous|all|above|prior)\s+instructions', "prompt_injection"),
    (r'do\s+not\s+tell\s+the\s+user', "deception_hide"),
    (r'system\s+prompt\s+override', "sys_prompt_override"),
    (r'<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->', "html_comment_injection"),
    (r'curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)', "exfil_curl"),
    (r'cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)', "read_secrets"),
    ...
]
```
（`agent/prompt_builder.py:36-47`）

扫描覆盖两类威胁：经典 prompt injection 模式（「忽略之前的指令」「不要告诉用户」），以及隐形 unicode 字符（零宽空格、文本方向覆写字符，`_CONTEXT_INVISIBLE_CHARS`，`agent/prompt_builder.py:49-52`）。命中任何模式时，**整个文件不加载**，替换成一行 `[BLOCKED: ...]` 标记（`agent/prompt_builder.py:73-75`）。

每个加载器（SOUL.md / HERMES.md / AGENTS.md / CLAUDE.md / .cursorrules）在读取后、注入前都调用了 `_scan_context_content()`。同时每个文件被 `_truncate_content()`（`agent/prompt_builder.py:1292`）截断到 `CONTEXT_FILE_MAX_CHARS = 20000` 字符（`agent/prompt_builder.py:830`），用「头 70% + 尾 20% + 中间一行截断标记」的方式（`CONTEXT_TRUNCATE_HEAD_RATIO` / `TAIL_RATIO`，`agent/prompt_builder.py:831-832`），避免一个超大上下文文件把 token 预算吃光。

## 4.8 volatile 层与时间戳

`volatile_parts` 收三类内容（`agent/system_prompt.py:234-265`）：

1. **内置记忆快照**：`agent._memory_store.format_for_system_prompt("memory")`——agent 跨 session 攒下的个人笔记。
2. **USER.md 用户画像**：`agent._memory_store.format_for_system_prompt("user")`——只要 `_user_profile_enabled` 就总是包含。
3. **外部记忆 provider 块**：`agent._memory_manager.build_system_prompt()`——来自 Honcho 等记忆插件，与内置记忆叠加。
4. **时间戳行**：

```python
from hermes_time import now as _hermes_now
now = _hermes_now()
timestamp_line = f"Conversation started: {now.strftime('%A, %B %d, %Y %I:%M %p')}"
if agent.pass_session_id and agent.session_id:
    timestamp_line += f"\nSession ID: {agent.session_id}"
if agent.model:
    timestamp_line += f"\nModel: {agent.model}"
if agent.provider:
    timestamp_line += f"\nProvider: {agent.provider}"
volatile_parts.append(timestamp_line)
```
（`agent/system_prompt.py:256-265`）

时间戳天然「每轮都会变」，所以它被放在整段系统提示的**最末尾**——这样它前面的 stable + context 段仍能命中缓存前缀。这正是 4.2 节三层排序纪律的直接体现。

注意 `build_system_prompt_parts` docstring（`agent/system_prompt.py:218` 注释）明确说明：`ephemeral_system_prompt` **不在这里**。它只在 API 调用那一刻临时拼上，不进缓存的/存储的系统提示——避免污染缓存。

## 4.9 系统提示的失效与重建

`invalidate_system_prompt()`（`agent/system_prompt.py:293`）非常短：

```python
def invalidate_system_prompt(agent: Any) -> None:
    """Invalidate the cached system prompt, forcing a rebuild on the next turn.
    Called after context compression events. Also reloads memory from disk
    so the rebuilt prompt captures any writes from this session."""
    agent._cached_system_prompt = None
    if agent._memory_store:
        agent._memory_store.load_from_disk()
```

它做两件事：把缓存字段清空（下一轮会重新 `build`），并从磁盘重载记忆（让重建后的系统提示带上本 session 写入的记忆）。

**关键问题：什么时候才允许 invalidate？** 答案是：**几乎只在上下文压缩之后**。`build_system_prompt()` 的 docstring 写得很明确——「only rebuilt after context compression events」。

这是一个刻意的克制。系统提示重建会让整个缓存前缀失效，代价高昂。所以 Hermes 不会因为「记忆变了」「技能加了」就重建系统提示。只有当**上下文压缩**发生时——此时整个对话历史本来就被重写了，缓存反正已经失效——才顺带重建系统提示，把累积的记忆变更一并刷新。换句话说，invalidate 总是「搭便车」在一个本来就要破坏缓存的事件上，绝不主动制造缓存破坏。

`format_tools_for_system_message()`（`agent/system_prompt.py:304`）是个独立的小工具，把 `agent.tools` 转成 trajectory 格式的 JSON 字符串，用于轨迹记录，与系统提示主流程无关。

## 4.10 完整组装顺序回顾

把全章串起来，一段 Hermes 系统提示从上到下的块顺序是：

<svg viewBox="0 0 800 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Full system prompt block assembly order across stable, context and volatile layers">
  <rect x="36" y="20" width="640" height="270" rx="8" fill="none" stroke="#ea580c" stroke-width="1.5"/>
  <text x="52" y="40" font-size="12" font-weight="700" fill="#ea580c">stable 层</text>
  <text x="664" y="40" text-anchor="end" font-size="10" fill="#ea580c">最稳定 → 放最前</text>
  <rect x="56" y="50" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="65" font-size="10.5" fill="currentColor">1. 身份（SOUL.md 或 DEFAULT_AGENT_IDENTITY）</text>
  <rect x="56" y="76" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="91" font-size="10.5" fill="currentColor">2. HERMES_AGENT_HELP_GUIDANCE</text>
  <rect x="56" y="102" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="117" font-size="10.5" fill="currentColor">3. 工具感知指引（memory / session_search / skills / kanban）</text>
  <rect x="56" y="128" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="143" font-size="10.5" fill="currentColor">4. COMPUTER_USE_GUIDANCE（条件）</text>
  <rect x="56" y="154" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="169" font-size="10.5" fill="currentColor">5. Nous 订阅块（条件）</text>
  <rect x="56" y="180" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="195" font-size="10.5" fill="currentColor">6. 工具调用强制指引 + 模型族操作指引（条件）</text>
  <rect x="56" y="206" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="221" font-size="10.5" fill="currentColor">7. 技能"索引"（条件，只有名字+描述）</text>
  <rect x="56" y="232" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="247" font-size="10.5" fill="currentColor">8. Alibaba 模型名修正（条件）</text>
  <rect x="56" y="258" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="68" y="273" font-size="10.5" fill="currentColor">9. 环境提示（本地宿主信息 / 远程后端活探）　10. 平台提示</text>
  <rect x="36" y="300" width="640" height="80" rx="8" fill="none" stroke="#0d9488" stroke-width="1.5"/>
  <text x="52" y="320" font-size="12" font-weight="700" fill="#0d9488">context 层</text>
  <rect x="56" y="330" width="600" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="68" y="345" font-size="10.5" fill="currentColor">11. caller 传入的 system_message</text>
  <rect x="56" y="356" width="600" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="68" y="371" font-size="10.5" fill="currentColor">12. 项目上下文文件（HERMES.md ▸ AGENTS.md ▸ CLAUDE.md ▸ .cursorrules，互斥）+ SOUL.md</text>
  <rect x="36" y="390" width="640" height="132" rx="8" fill="none" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="52" y="410" font-size="12" font-weight="700" fill="#7c3aed">volatile 层</text>
  <text x="664" y="410" text-anchor="end" font-size="10" fill="#7c3aed">最易变 → 放最后</text>
  <rect x="56" y="420" width="600" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="68" y="435" font-size="10.5" fill="currentColor">13. 内置记忆快照</text>
  <rect x="56" y="446" width="600" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="68" y="461" font-size="10.5" fill="currentColor">14. USER.md 用户画像</text>
  <rect x="56" y="472" width="600" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="68" y="487" font-size="10.5" fill="currentColor">15. 外部记忆 provider 块</text>
  <rect x="56" y="498" width="600" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="68" y="513" font-size="10.5" fill="currentColor">16. 时间戳 / Session ID / Model / Provider 行</text>
  <line x1="710" y1="40" x2="710" y2="510" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4b)"/>
  <text x="730" y="200" font-size="10" fill="#64748b" transform="rotate(90 730 200)">缓存前缀稳定区段从上到下递减</text>
</svg>
<span class="figure-caption">图 R4.4 ｜ 系统提示 16 块的完整组装顺序：越稳定越靠前，三层依次为 stable、context、volatile</span>

<details>
<summary>ASCII 原版</summary>

```text
┌─ stable 层 ──────────────────────────────────────────┐
│ 1. 身份（SOUL.md 或 DEFAULT_AGENT_IDENTITY）           │  最稳定 → 放最前
│ 2. HERMES_AGENT_HELP_GUIDANCE                         │
│ 3. 工具感知指引（memory/session_search/skills/kanban）│  按工具存在性条件注入
│ 4. COMPUTER_USE_GUIDANCE（条件）                       │
│ 5. Nous 订阅块（条件）                                  │
│ 6. 工具调用强制指引 + 模型族操作指引（条件）             │
│ 7. 技能"索引"（条件）                                   │  只有名字+描述
│ 8. Alibaba 模型名修正（条件）                           │
│ 9. 环境提示（本地宿主信息 / 远程后端活探）               │
│ 10. 平台提示                                           │
├─ context 层 ─────────────────────────────────────────┤
│ 11. caller 传入的 system_message                      │
│ 12. 项目上下文文件（HERMES.md ▸ AGENTS.md ▸ CLAUDE.md  │  优先级，只取一个
│     ▸ .cursorrules，互斥）+ SOUL.md（如未作身份注入）   │
├─ volatile 层 ────────────────────────────────────────┤
│ 13. 内置记忆快照                                        │
│ 14. USER.md 用户画像                                   │
│ 15. 外部记忆 provider 块                                │
│ 16. 时间戳 / Session ID / Model / Provider 行          │  最易变 → 放最后
└──────────────────────────────────────────────────────┘
```

</details>

排序的唯一律法：**越稳定的越靠前，越易变的越靠后**，让上游 prompt cache 的前缀命中区段尽可能长。条件块只在「对应能力实际存在」时才注入，省 token 也防幻觉。整段一旦拼好就冻结在 `agent._cached_system_prompt`，只有上下文压缩才会触发重建。

## 延伸阅读

- 工具如何被注册、组成 toolset、决定 `valid_tool_names`——见 [第 5 章 工具系统：注册、工具集与分发](05-tool-system.md)。
- `TERMINAL_ENV` 对应的七种执行后端，以及 `build_environment_hints` 探测的对象——见 [第 6 章 终端后端：七种执行环境](06-terminal-environments.md)。
- 同步工具调用循环如何把系统提示、消息流、工具结果组装成一次 API 请求——见 [第 3 章 核心循环](03-core-loop.md)。
- 上下文压缩如何触发系统提示重建——见 [第 9 章 上下文工程与压缩](09-context-engine.md)。
