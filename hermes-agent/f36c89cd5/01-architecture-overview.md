# 第 1 章 导论与全局架构

本章面向第一次接触 Hermes Agent 源码的资深工程师。它不教你"怎么用"这个 agent，而是回答两个问题：**这个项目想解决哪些工程问题**，以及**它用什么样的架构来解决**。读完本章，你应能在脑中建立起一张从入口脚本到模型 API 调用、再到工具执行的完整地图，并知道每个目录在这张图上的位置。

代码版本锁定在 `NousResearch/hermes-agent@f36c89cd5`（2026-05-17）。本章及全书所有 `file:line` 引用都基于这个 commit。

---

## 1.1 一个 AI agent 框架要解决哪些工程问题

"AI agent" 这个词在 2024-2026 年间被严重透支了。如果只看 demo，一个 agent 似乎只是一个 `while` 循环：把用户消息发给大模型，模型要求调用工具，执行工具，把结果塞回去，再发一次，直到模型不再要求工具为止。这个核心循环本身确实只有几十行。

真正困难的部分不在循环，而在循环之外的工程现实。任何打算长期运行、被真实用户依赖的 agent 框架，都必须正面回答下面这一串问题：

1. **模型供应商不是单一的，也不稳定。** 用户可能用 OpenRouter、Anthropic、Gemini、OpenAI、自建 vLLM 端点。它们的 API 协议不同（OpenAI chat completions、Anthropic messages、Codex responses）、鉴权方式不同（API key、OAuth、AWS SigV4）、限流行为不同。框架要在不改业务代码的前提下适配所有这些差异，还要在主模型挂掉时自动 failover 到备用模型。

2. **上下文窗口是有限的，对话却是无限的。** 一个跑了三小时的会话会塞满任何模型的上下文。框架必须在合适的时机压缩历史、保留关键信息、且不破坏供应商的 prefix 缓存（破坏缓存意味着成本翻几倍）。

3. **工具执行是不可信的、慢的、会失败的。** 工具可能跑 `rm -rf`、可能调用网络、可能挂死。框架要做审批、要做超时、要做并发、要能在工具跑到一半时被用户打断。

4. **agent 不只活在你的笔记本上。** 用户希望从 Telegram 给在云端 VM 上干活的 agent 发消息；希望它能在凌晨三点按 cron 计划自己跑起来；希望它能把任务派发给隔离的子 agent 并行处理。这意味着同一个 agent 核心要被终端 CLI、消息网关、批量 runner、cron 调度器等多种"前端"复用。

5. **agent 应该越用越聪明。** 大多数框架是无状态的：每次对话都从零开始。Hermes 的设计赌注是**一个闭合的学习循环**——agent 从经验中沉淀技能（skill）、在使用中改进技能、周期性提醒自己把知识写进持久记忆、能搜索自己过去的对话、跨会话构建对用户的画像。

Hermes Agent 是 Nous Research 对上述所有问题的一个完整的、有主见的回答。它的差异化定位可以浓缩成三句话：

- **闭合学习循环**——这是 Hermes 与 LangChain、AutoGPT、Claude Code 等同类项目最根本的区别。技能自动创建、技能自我改进、记忆 nudge、FTS5 会话搜索、Honcho 用户建模，这些不是插件，而是内建在对话循环里的一等公民（详见 [第 10 章 记忆与学习循环](10-memory-learning.md)）。
- **多平台、多后端**——单进程消息网关同时桥接 Telegram / Discord / Slack / WhatsApp / Signal 等；七种终端后端（local、Docker、SSH、Singularity、Modal、Daytona、Vercel Sandbox）让 agent 的执行环境从本地一路延伸到 serverless。
- **任意模型、零锁定**——通过 provider 适配层支持任意供应商，`hermes model` 一条命令切换，业务代码无感知。

值得强调的一个反直觉的设计决定：**Hermes 的核心对话循环是完全同步的**，不是 `async`。在一个到处都是 I/O 的系统里选择同步循环，是为了让中断、调试、状态可见性变得简单——这一点会在 [第 3 章](03-conversation-loop.md) 详细展开。

### 五个核心问题对应到代码的哪一处

上面五个问题不是抽象的，每一个在 Hermes 的代码库里都有明确的"负责人"。下表把问题、对应的核心抽象、和后续章节绑在一起，方便你带着问题去读源码：

| 工程问题 | 核心抽象 / 文件 | 关键入口 | 详见 |
|---|---|---|---|
| 状态管理——一个回合需要的所有上下文塞在哪 | `class AIAgent`（`run_agent.py:326`） | `AIAgent.__init__` / `init_agent()`（`agent/agent_init.py:74`） | 第 3 章 |
| 工具调用循环——模型 ↔ 工具的同步迭代 | `run_conversation()`（`agent/conversation_loop.py:85`） | `IterationBudget`（`agent/iteration_budget.py:17`）防死循环 | 第 3、5 章 |
| 上下文窗口——无限对话塞进有限窗口 | `context_compressor.py` + `trajectory_compressor.py`（1508 行） | `run_conversation()` 里的 preflight 压缩（`agent/conversation_loop.py:356` 起） | 第 6 章 |
| 多入口——同一个 agent 核心被多种前端复用 | 入口层（见 1.2） | 所有入口最终都构造 `AIAgent` 并调 `run_conversation()` | 第 2、12、13 章 |
| 可扩展性——加能力不改核心 | `tools/registry.py` 自注册 + `plugins/` 四层插件 | `discover_builtin_tools()`（`model_tools.py`） | 第 5、11 章 |

记住这张表，你在读任何一章时都能回答"我现在在解决哪个核心问题"。**状态管理**决定了一个回合能看到什么；**工具调用循环**决定了一个回合怎么推进；**上下文窗口**决定了长对话不会崩；**多入口**决定了同一套核心能跑在 CLI / Telegram / cron 上；**可扩展性**决定了第三方能不改核心地接入新工具与新后端。

### 同步循环 vs `async`：为什么逆潮流而行

2024-2026 年间几乎所有 Python agent 框架都是 `async` 的——这看似是"正确"的选择，因为 agent 的瓶颈全是 I/O（HTTP 调模型、子进程跑工具）。Hermes 偏偏选了同步 `while` 循环，理由是 agent 的真实痛点不在吞吐而在**可中断性与可调试性**：

- 用户随时可能按 `Ctrl-C` 打断一个跑到一半的回合。同步循环里，中断就是一个普通的 `KeyboardInterrupt`，落在确定的栈帧上；`async` 里中断要穿过事件循环、`CancelledError` 在 `await` 点不可预测地抛出。
- 一个回合的状态在同步循环里是"此刻栈上能看到的局部变量"，单步调试直接可见；`async` 里状态散落在挂起的协程里。
- 单个用户回合本来就是串行的——模型说完话才轮到工具，工具跑完才轮到模型。这里没有可并行的部分，`async` 带来的并发能力用不上。

并发的需求（多个网关会话、子 agent 并行）被推到**进程/线程边界**去解决，而不是污染核心循环。这个取舍是理解第 3 章的前提。

### 从 demo 到生产：那个 `while` 循环之外的世界

为了让"工程问题"具体化，设想把本节开头那个几十行的 demo 循环真的交给用户用一个月，会依次撞上什么：

<svg viewBox="0 0 860 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Demo loop steps colliding with production realities">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#dc2626"/>
    </marker>
  </defs>
  <text x="155" y="26" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">demo 循环（约 30 行）</text>
  <text x="640" y="26" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">生产环境逼出来的真实需求</text>
  <g font-size="11">
    <rect x="20" y="44" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="73" fill="currentColor" text-anchor="middle">发消息给模型</text>
    <rect x="420" y="44" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="65" fill="currentColor" text-anchor="middle">模型限流 / 超时 / 供应商宕机</text>
    <text x="630" y="82" fill="#64748b" text-anchor="middle">→ credential_pool 多 key 轮换 + failover</text>
    <line x1="290" y1="68" x2="416" y2="68" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
    <rect x="20" y="106" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="135" fill="currentColor" text-anchor="middle">模型要求调工具</text>
    <rect x="420" y="106" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="127" fill="currentColor" text-anchor="middle">工具是 rm -rf / 网络调用 / 会挂死</text>
    <text x="630" y="144" fill="#64748b" text-anchor="middle">→ 审批 + 超时 + 可中断 + 沙箱后端</text>
    <line x1="290" y1="130" x2="416" y2="130" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
    <rect x="20" y="168" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="197" fill="currentColor" text-anchor="middle">把结果塞回去再发一次</text>
    <rect x="420" y="168" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="189" fill="currentColor" text-anchor="middle">跑三小时后历史塞爆上下文窗口</text>
    <text x="630" y="206" fill="#64748b" text-anchor="middle">→ context_compressor 不破缓存地压缩</text>
    <line x1="290" y1="192" x2="416" y2="192" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
    <rect x="20" y="230" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="259" fill="currentColor" text-anchor="middle">循环直到模型不再要工具</text>
    <rect x="420" y="230" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="251" fill="currentColor" text-anchor="middle">模型陷入工具调用死循环</text>
    <text x="630" y="268" fill="#64748b" text-anchor="middle">→ IterationBudget 硬上限</text>
    <line x1="290" y1="254" x2="416" y2="254" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
    <rect x="20" y="292" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="321" fill="currentColor" text-anchor="middle">返回最终文本</text>
    <rect x="420" y="292" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="313" fill="currentColor" text-anchor="middle">用户想从 Telegram / cron / IDE 用它</text>
    <text x="630" y="330" fill="#64748b" text-anchor="middle">→ 入口层把同一个核心复用给多种前端</text>
    <line x1="290" y1="316" x2="416" y2="316" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
    <rect x="20" y="354" width="270" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="155" y="383" fill="currentColor" text-anchor="middle">对话结束</text>
    <rect x="420" y="354" width="420" height="48" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
    <text x="630" y="375" fill="currentColor" text-anchor="middle">下次对话又从零开始，什么也没学到</text>
    <text x="630" y="392" fill="#64748b" text-anchor="middle">→ 记忆 + 技能 + curator 的学习闭环</text>
    <line x1="290" y1="378" x2="416" y2="378" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar1)"/>
  </g>
  <text x="355" y="68" font-size="10" fill="#dc2626" text-anchor="middle">撞上</text>
</svg>
<span class="figure-caption">图 R1.1 ｜ demo 循环的每一步在生产环境都会撞上一个真实需求，催生 Hermes 的对应子系统。</span>

<details>
<summary>ASCII 原版</summary>

```text
  demo 循环（约 30 行）              生产环境逼出来的真实需求
  ─────────────────────             ────────────────────────────
  发消息给模型           ──撞上──►  模型限流 / 超时 / 供应商宕机
                                     → credential_pool 多 key 轮换 + failover

  模型要求调工具         ──撞上──►  工具是 rm -rf / 网络调用 / 会挂死
                                     → 审批 + 超时 + 可中断 + 沙箱后端

  把结果塞回去再发一次   ──撞上──►  跑三小时后历史塞爆上下文窗口
                                     → context_compressor 在不破缓存的前提下压缩

  循环直到模型不再要工具 ──撞上──►  模型陷入工具调用死循环
                                     → IterationBudget 硬上限

  返回最终文本           ──撞上──►  用户想从 Telegram / cron / IDE 用它
                                     → 入口层把同一个核心复用给多种前端

  对话结束               ──撞上──►  下次对话又从零开始，什么也没学到
                                     → 记忆 + 技能 + curator 的学习闭环
```

</details>

这张表是本章后续所有内容的"动机地图"。Hermes 代码库里那些看起来"多余"的复杂度——五个 provider 适配器、七个终端后端、压缩器、预算计数器、curator——没有一个是炫技，它们都是上面右栏某一行的直接产物。读源码时如果某处让你觉得"为什么要这么麻烦"，回头看一眼这张表，多半能找到答案。

### 与同类框架的定位差异

把 Hermes 放在 2026 年的 agent 框架坐标系里，它的位置可以这样标定：

- **相对 LangChain / LlamaIndex**——那些是"库"，给你积木让你自己拼 agent；Hermes 是一个"成品 agent"，开箱即用，有自己的主见。你不是在用 Hermes 搭 agent，你是在用 Hermes 这个 agent。
- **相对 AutoGPT / BabyAGI**——那一代强调"自主性"但缺乏工程纵深；Hermes 把自主性（学习闭环）和工程纵深（多 provider、多后端、可观测性）同时做厚。
- **相对 Claude Code / 各家厂商 CLI**——那些通常锁定单一模型厂商；Hermes 的核心卖点恰恰是 provider 中立 + 学习闭环，两者都是厂商 CLI 出于商业原因不会做的。

这个定位决定了 Hermes 的代码气质：它不追求"最小内核"，而追求"一个有主见的、完整的、能长期演进的 agent"。理解了这一点，你就能理解为什么它的代码库有 14000 行的 `cli.py`——那是"成品"必然付出的体量代价。

---

## 1.2 四层架构

把 Hermes 的代码库在心里压扁成四个水平层，是理解它最快的方式。从上到下，每一层只依赖它下面的层：

<svg viewBox="0 0 800 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Four-layer architecture of Hermes Agent">
  <defs>
    <marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="40" y="20" width="720" height="100" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="60" y="42" font-size="13" font-weight="700" fill="currentColor">第 1 层　入口层 (Entrypoints)</text>
    <text x="60" y="64" fill="currentColor">hermes 脚本　hermes_cli/main.py　cli.py (HermesCLI)　gateway/run.py</text>
    <text x="60" y="82" fill="currentColor">batch_runner.py　mini_swe_runner.py　ui-tui + tui_gateway　cron/scheduler.py</text>
    <text x="60" y="108" font-size="10" fill="#64748b">职责：解析参数、加载配置、构造 AIAgent、把人类/平台的输入喂进去</text>
    <rect x="40" y="148" width="720" height="100" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
    <text x="60" y="170" font-size="13" font-weight="700" fill="currentColor">第 2 层　Agent 核心 (Agent Core)</text>
    <text x="60" y="192" fill="currentColor">run_agent.py — class AIAgent（状态容器 + 公开接口）</text>
    <text x="60" y="210" fill="currentColor">agent/agent_init.py — init_agent()　agent/conversation_loop.py — run_conversation()</text>
    <text x="60" y="236" font-size="10" fill="#64748b">职责：驱动一个用户回合走完——模型调用、工具派发、重试、压缩、post-hook</text>
    <rect x="40" y="276" width="720" height="100" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
    <text x="60" y="298" font-size="13" font-weight="700" fill="currentColor">第 3 层　模型与上下文 (Model &amp; Context)</text>
    <text x="60" y="320" fill="currentColor">providers/ + agent/*_adapter.py　agent/credential_pool*</text>
    <text x="60" y="338" fill="currentColor">agent/context_compressor.py + trajectory_compressor.py　hermes_state.py SessionDB</text>
    <text x="60" y="364" font-size="10" fill="#64748b">职责：把 agent 意图翻译成供应商 HTTP 请求；管理上下文与持久化</text>
    <rect x="40" y="404" width="720" height="116" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
    <text x="60" y="426" font-size="13" font-weight="700" fill="currentColor">第 4 层　工具与扩展 (Tools &amp; Extensions)</text>
    <text x="60" y="448" fill="currentColor">tools/registry.py + tools/*.py（40+ 内建工具，import 时自注册）</text>
    <text x="60" y="466" fill="currentColor">tools/environments/（七种终端后端）　tools/mcp_tool.py　skills/ + agent/skill_*</text>
    <text x="60" y="484" fill="currentColor">agent/memory_manager.py　plugins/（memory/model-provider/...）</text>
    <text x="60" y="510" font-size="10" fill="#64748b">职责：agent 真正做事的地方——执行命令、读写文件、调用 MCP、跑技能</text>
  </g>
  <line x1="400" y1="120" x2="400" y2="146" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar2)"/>
  <text x="408" y="138" font-size="10" fill="#64748b">构造 AIAgent(...)，调用 run_conversation()</text>
  <line x1="400" y1="248" x2="400" y2="274" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar2)"/>
  <text x="408" y="266" font-size="10" fill="#64748b">调用 provider client，读写会话/上下文</text>
  <line x1="400" y1="376" x2="400" y2="402" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar2)"/>
  <text x="408" y="394" font-size="10" fill="#64748b">工具调用经 model_tools 派发</text>
</svg>
<span class="figure-caption">图 R1.2 ｜ Hermes 的四层水平架构，每层只依赖其下方的层，依赖方向严格单向向下。</span>

<details>
<summary>ASCII 原版</summary>

```text
┌─────────────────────────────────────────────────────────────────────┐
│  第 1 层  入口层 (Entrypoints)                                         │
│                                                                       │
│  hermes 脚本   hermes_cli/main.py   cli.py (HermesCLI)                 │
│  gateway/run.py   batch_runner.py   mini_swe_runner.py                 │
│  ui-tui + tui_gateway   acp_adapter   cron/scheduler.py                │
│                                                                       │
│  职责：解析参数、加载配置、构造 AIAgent、把人类/平台的输入喂进去         │
└────────────────────────────────┬──────────────────────────────────────┘
                                  │ 构造 AIAgent(...)，调用 run_conversation()
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第 2 层  Agent 核心 (Agent Core)                                      │
│                                                                       │
│  run_agent.py        class AIAgent —— 状态容器 + 公开接口               │
│  agent/agent_init.py init_agent() —— ~1400 行的初始化                  │
│  agent/conversation_loop.py  run_conversation() —— 同步工具调用循环      │
│  agent/iteration_budget.py   IterationBudget —— 迭代预算                │
│                                                                       │
│  职责：驱动一个用户回合走完——模型调用、工具派发、重试、压缩、post-hook   │
└────────────────────────────────┬──────────────────────────────────────┘
                                  │ 调用 provider client，读写会话/上下文
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第 3 层  模型与上下文 (Model & Context)                                │
│                                                                       │
│  providers/ + agent/*_adapter.py  Provider 适配 (chat/messages/codex)  │
│  agent/credential_pool*           凭证池 / 多 key 轮换                  │
│  agent/context_compressor.py      上下文压缩 + trajectory_compressor.py │
│  hermes_state.py  SessionDB       SQLite 会话存储 + FTS5 搜索           │
│                                                                       │
│  职责：把 agent 的"意图"翻译成具体供应商的 HTTP 请求；管理上下文与持久化  │
└────────────────────────────────┬──────────────────────────────────────┘
                                  │ 工具调用经 model_tools 派发
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  第 4 层  工具与扩展 (Tools & Extensions)                               │
│                                                                       │
│  tools/registry.py + tools/*.py   40+ 内建工具，import 时自注册         │
│  tools/environments/              七种终端后端                          │
│  tools/mcp_tool.py                MCP 集成                              │
│  skills/  +  agent/skill_*        技能系统（程序性记忆）                 │
│  agent/memory_manager.py          记忆系统                              │
│  plugins/                         插件系统（memory/model-provider/...）  │
│                                                                       │
│  职责：agent 真正"做事"的地方——执行命令、读写文件、调用 MCP、跑技能      │
└─────────────────────────────────────────────────────────────────────┘
```

</details>

这个分层不是装饰。它对应了代码里真实的依赖方向：入口层 `import` agent 核心，agent 核心 `import` 模型层和工具层，反过来则不成立。理解这个方向，你就能预测"改某处会影响哪里"——这是阅读任何大型代码库时最值钱的能力。

为什么恰好是四层，而不是三层或五层？因为这四层对应了四个**正交的关注点**，每一层换掉都不该惊动其它三层：入口层换掉（比如新增一个 IDE 集成）不该改对话循环；模型层换掉（换个供应商）不该改工具；工具层加东西不该改核心。如果某次改动被迫跨多层，那通常是一个抽象泄漏的信号——值得停下来想想是不是哪一层的接口设计漏了东西。这种"每层可独立替换"的性质，是判断分层是否健康的试金石。

四层各自的代表性入口文件：

| 层 | 代表文件 | 一句话职责 |
|---|---|---|
| 入口层 | `hermes_cli/main.py`、`cli.py`、`gateway/run.py`、`batch_runner.py` | 把外部输入转化为对 `AIAgent` 的构造与调用 |
| Agent 核心 | `run_agent.py`、`agent/conversation_loop.py`、`agent/agent_init.py` | 驱动一个回合的同步循环 |
| 模型与上下文 | `providers/`、`agent/context_compressor.py`、`hermes_state.py` | provider 适配、上下文压缩、会话持久化 |
| 工具与扩展 | `tools/`、`model_tools.py`、`toolsets.py`、`skills/`、`plugins/` | 工具发现、派发、执行；技能与插件扩展 |

### 逐层拆解

四层的边界不是模糊的"大概在这里"，每一层都有清晰的职责清单和承重文件。

**第 1 层 入口层。** 它的唯一职责是"把外部世界翻译成 `AIAgent` 的构造参数"。它不包含任何对话逻辑——所有入口最终都殊途同归地构造一个 `AIAgent` 并调用 `run_conversation()`。承重文件：

- `hermes` 脚本（仓库根，~262 字节）——只做一件事：找到 Python 并 `exec` 进 `hermes_cli/main.py`。
- `hermes_cli/main.py`——CLI 参数解析与子命令分发。
- `cli.py`（14246 行）——`class HermesCLI`，交互式 REPL 编排器，是入口层里最大的文件。
- `gateway/run.py`——消息网关入口，把 Telegram/Discord 等平台消息翻译成 agent 回合。
- `batch_runner.py`（56 KB）、`mini_swe_runner.py`（28 KB）——批量/评测 runner。
- `cron/scheduler.py`、`acp_adapter/entry.py`、`tui_gateway/entry.py`——定时、IDE、TUI 三个非交互入口。

**第 2 层 Agent 核心。** 职责是"驱动一个用户回合从开始到结束"。这一层是整个项目的心脏。承重文件：

- `run_agent.py`（4094 行）——`class AIAgent`（`run_agent.py:326`）是一个**纯状态容器加薄公开接口**。`run_conversation()`（`run_agent.py:3838`）和 `chat()`（`run_agent.py:3851`）只是转发到 `agent/` 子模块。
- `agent/agent_init.py`（1469 行）——`init_agent()`（`agent/agent_init.py:74`）负责把 provider、工具、记忆、技能、压缩器等几十个子系统装配进一个 `AIAgent` 实例。初始化逻辑被刻意从 `__init__` 里抽出来，因为它太重。`AIAgent.__init__` 本身只是一个转发器：

```python
    ):
        """Forwarder — see ``agent.agent_init.init_agent``."""
        from agent.agent_init import init_agent
        init_agent(
            self,
            base_url=base_url,
            api_key=api_key,
            provider=provider,
            ...
        )
```

`AIAgent.__init__` 的参数列表本身就值得一读——它有 70 多个参数，从 `base_url` / `api_key` 这样的连接信息，到 `platform` / `user_id` / `chat_id` 这样的网关上下文，再到 `iteration_budget` / `credential_pool` / `fallback_model` 这样的子系统句柄，还有一大批 `*_callback` 用于把对话过程中的事件流式回调给前端。这 70 多个参数就是"一个 agent 回合需要知道的全部外部信息"的清单。把它们全部接受、再原样转发给 `init_agent()`，是为了让 `run_agent.py` 不背负初始化的复杂度。
- `agent/conversation_loop.py`（4018 行）——`run_conversation()`（`agent/conversation_loop.py:85`）是真正的同步工具调用循环。它的签名就揭示了一个回合需要的全部输入：

```python
def run_conversation(
    agent,
    user_message: str,
    system_message: str = None,
    conversation_history: List[Dict[str, Any]] = None,
    task_id: str = None,
    stream_callback: Optional[callable] = None,
    persist_user_message: Optional[str] = None,
) -> Dict[str, Any]:
```

注意第一个参数就是 `agent`——`run_conversation()` 不是 `AIAgent` 的方法，而是一个**接收 agent 作为参数的自由函数**。这是 Hermes 一以贯之的风格：`run_agent.py` 里 `AIAgent.run_conversation()`（`run_agent.py:3838`）只是一行转发，真正的逻辑住在 `agent/conversation_loop.py`。把巨型逻辑从类里抽成自由函数，让 `run_agent.py` 保持"状态容器"的纯粹性，也让对话循环可以被独立测试。`task_id` 用于隔离并发任务的 VM，`persist_user_message` 用于在 `user_message` 含合成前缀时把"干净版本"写进会话历史。
- `agent/iteration_budget.py`——`IterationBudget`（`agent/iteration_budget.py:17`），一个极小但关键的类，`consume()` / `refund()` / `remaining()` 防止模型陷入无限工具调用。

`IterationBudget` 值得整段看一眼，因为它浓缩了 Hermes 对"agent 必须有硬边界"的态度：

```python
class IterationBudget:
    def __init__(self, max_total: int):
        self.max_total = max_total
        self._used = 0
        self._lock = threading.Lock()

    def consume(self) -> bool:
        """Try to consume one iteration.  Returns True if allowed."""
        with self._lock:
            if self._used >= self.max_total:
                return False
            self._used += 1
            return True

    def refund(self) -> None:
        """Give back one iteration (e.g. for execute_code turns)."""
        with self._lock:
            if self._used > 0:
                self._used -= 1
```

三个设计细节：（1）它带 `threading.Lock`——核心循环虽是同步的，但子 agent 可能在别的线程里跑，预算计数必须线程安全。（2）父 agent 的预算来自 `max_iterations`（默认 90，见 `run_agent.py` 的 `AIAgent.__init__` 签名），每个子 agent 拿独立预算（默认 50），所以"父 + 子"总迭代数可以超过父的上限——这是有意的。（3）`execute_code` 这类程序化工具调用会通过 `refund()` 把迭代还回去，不占预算。一个 60 行的小文件，把"防失控"这件事做得干净彻底。

**第 3 层 模型与上下文。** 职责是"把 agent 的意图翻译成具体供应商的 HTTP 请求，并管理上下文生命周期"。承重文件：

- `agent/anthropic_adapter.py`、`agent/codex_responses_adapter.py`、`agent/gemini_native_adapter.py`、`agent/gemini_cloudcode_adapter.py`、`agent/bedrock_adapter.py`——五个 provider 适配器，把统一的内部消息格式翻译成各家协议。
- `providers/base.py`——provider 抽象基类。
- `agent/credential_pool.py`——多 key 轮换与限流退避。
- `agent/context_compressor.py` + 根目录 `trajectory_compressor.py`（1508 行）——上下文压缩。
- `hermes_state.py`（2966 行）——`class SessionDB`，SQLite 会话存储，`search_messages()`（`hermes_state.py:1880`）与 `search_sessions()`（`hermes_state.py:2151`）提供 FTS5 全文检索。

**第 4 层 工具与扩展。** 职责是"agent 真正做事的地方"。承重文件：

- `tools/registry.py` + 40+ 个 `tools/*.py`——内建工具，import 即注册。
- `tools/environments/`——七个终端后端（`local.py`、`docker.py`、`ssh.py`、`modal.py`、`daytona.py`、`singularity.py`、`vercel_sandbox.py`）。
- `tools/mcp_tool.py`、`mcp_serve.py`（31 KB）——MCP 客户端与服务端。
- `tools/skill_manager_tool.py`、`tools/skills_hub.py`——技能的增删改查与自创建工具。
- `agent/memory_manager.py`——`class MemoryManager`（`agent/memory_manager.py:190`），记忆系统。
- `agent/curator.py`——会话策展（自动归档、技能蒸馏建议）。
- `plugins/`——17 个插件目录，四类插件（memory / model-provider / context-engine / platform 及其它）。

依赖方向严格单向：第 1 层 import 第 2 层，第 2 层 import 第 3、4 层，反向 import 不存在。一个实用的验证方法是 `grep -rn 'import run_agent' tools/`——你会发现工具层从不反向依赖核心。

### 一次请求如何穿过四层

把上面的静态分层动起来。下面是一条用户消息从进程启动到模型返回、工具执行、记忆 nudge 的端到端时序，每一步都标注了它落在哪一层。这张图是 trace 导览（20 步）的"压缩版速写"——细节留给 trace 导览，这里只求让你看见整体形状：

<svg viewBox="0 0 800 560" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="End-to-end request flow through the four layers">
  <defs>
    <marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="10" font-weight="700">
    <rect x="20" y="24" width="56" height="20" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="48" y="38" fill="currentColor" text-anchor="middle">第1层</text>
    <rect x="20" y="92" width="56" height="20" rx="4" fill="#99f6e4" stroke="#0d9488"/><text x="48" y="106" fill="currentColor" text-anchor="middle">第2层</text>
    <rect x="20" y="324" width="56" height="20" rx="4" fill="#99f6e4" stroke="#0d9488"/><text x="48" y="338" fill="currentColor" text-anchor="middle">第2层</text>
    <rect x="20" y="416" width="56" height="20" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="48" y="430" fill="currentColor" text-anchor="middle">第3层</text>
    <rect x="20" y="500" width="56" height="20" rx="4" fill="#fed7aa" stroke="#ea580c"/><text x="48" y="514" fill="currentColor" text-anchor="middle">第1层</text>
  </g>
  <g font-size="11">
    <rect x="100" y="20" width="680" height="48" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="116" y="40" font-weight="600" fill="currentColor">hermes 脚本 → hermes_cli/main.py → cmd_chat</text>
    <text x="116" y="58" font-size="10" fill="#64748b">解析 argv、加载 config.yaml + .env</text>
    <rect x="100" y="88" width="680" height="74" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/>
    <text x="116" y="108" font-weight="600" fill="currentColor">init_agent() → 得到填满状态的 AIAgent</text>
    <text x="116" y="126" font-size="10" fill="#64748b">装配 provider / 工具注册表 / 记忆 / 技能 / 压缩器</text>
    <text x="116" y="144" font-size="10" fill="#94a3b8">agent/agent_init.py:74　run_agent.py:326</text>
    <rect x="100" y="182" width="680" height="60" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/>
    <text x="116" y="202" font-weight="600" fill="currentColor">run_conversation() → preflight 上下文压缩</text>
    <text x="116" y="220" font-size="10" fill="#64748b">若历史 token 超阈值，先压缩再进循环</text>
    <text x="116" y="236" font-size="10" fill="#94a3b8">conversation_loop.py:85 / :356</text>
    <rect x="100" y="262" width="680" height="120" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2" stroke-dasharray="5,3"/>
    <text x="116" y="282" font-weight="600" fill="currentColor">同步 while 循环：模型 ↔ 工具交替</text>
    <text x="116" y="302" font-size="10" fill="#64748b">[第3层] provider 适配器翻译协议；credential_pool 取 key 发 HTTP，必要时 failover</text>
    <text x="116" y="320" font-size="10" fill="#64748b">模型返回 → 文本则跳出；tool_calls 则继续</text>
    <text x="116" y="340" font-size="10" fill="#64748b">[第4层] handle_function_call() 派发到 tools/*；IterationBudget.consume() 防无限循环</text>
    <text x="116" y="358" font-size="10" fill="#64748b">工具在 tools/environments/&lt;backend&gt; 执行，结果塞回 messages 回到循环顶部</text>
    <text x="116" y="374" font-size="10" fill="#94a3b8">无 tool_calls → 跳出循环</text>
    <rect x="100" y="402" width="680" height="48" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/>
    <text x="116" y="422" font-weight="600" fill="currentColor">post-turn hooks</text>
    <text x="116" y="440" font-size="10" fill="#64748b">记忆 flush / 周期性 memory nudge / 技能 review nudge</text>
    <rect x="100" y="402" width="0" height="0"/>
    <rect x="100" y="416" width="0" height="0"/>
  </g>
  <g font-size="11">
    <rect x="100" y="458" width="680" height="36" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="116" y="481" font-weight="600" fill="currentColor">SessionDB.append(...) — 写入 SQLite + 更新 FTS5 索引</text>
    <rect x="100" y="510" width="680" height="36" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="116" y="533" font-weight="600" fill="currentColor">把最终文本回显给用户 / 回传给网关平台</text>
  </g>
  <line x1="440" y1="68" x2="440" y2="86" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="440" y1="162" x2="440" y2="180" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="440" y1="242" x2="440" y2="260" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="440" y1="382" x2="440" y2="400" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="440" y1="450" x2="440" y2="456" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
  <line x1="440" y1="494" x2="440" y2="508" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar3)"/>
</svg>
<span class="figure-caption">图 R1.3 ｜ 一条用户消息从进程启动、压缩、同步循环到 post-hook 与持久化的端到端时序，每步标注所在层。</span>

<details>
<summary>ASCII 原版</summary>

```text
 时间 ──────────────────────────────────────────────────────────────►

 [第1层]  hermes 脚本 → hermes_cli/main.py → cmd_chat
            │  解析 argv、加载 config.yaml + .env
            ▼
 [第2层]  init_agent()                         agent/agent_init.py:74
            │  装配 provider / 工具注册表 / 记忆 / 技能 / 压缩器
            │  → 得到一个填满状态的 AIAgent     run_agent.py:326
            ▼
 [第2层]  run_conversation()                   agent/conversation_loop.py:85
            │
            ├─► preflight 上下文压缩            conversation_loop.py:356
            │      若历史 token 超阈值，先压缩再进循环
            │
            ▼   进入同步 while 循环 ┐
            │                       │
 [第3层]    ├─► provider 适配器把消息翻译成供应商协议
            │      anthropic_adapter / codex_responses_adapter / ...
            │      credential_pool 取 key，发 HTTP，必要时 failover
            │                       │
            │   ◄── 模型返回：要么是文本，要么是 tool_calls
            │                       │
 [第4层]    ├─► 有 tool_calls → handle_function_call() 派发到 tools/*
            │      IterationBudget.consume()  防无限循环
            │      工具在 tools/environments/<backend> 里执行
            │      结果塞回 messages，回到循环顶部 ┘
            │
            │   无 tool_calls → 跳出循环
            ▼
 [第2层]  post-turn hooks                      conversation_loop.py
            │  记忆 flush / 周期性 memory nudge / 技能 review nudge
            ▼
 [第3层]  SessionDB.append(...)  把回合写入 SQLite + 更新 FTS5 索引
            ▼
 [第1层]  把最终文本回显给用户 / 回传给网关平台
```

</details>

读这张图时要抓住三个节奏点：**进循环前**有一次 preflight 压缩（保证不会一上来就超窗口）；**循环内**是模型与工具的同步交替，`IterationBudget` 在每次工具调用时递减;**出循环后**才是 post-hook——记忆与技能的"自我改进"动作发生在这里，不打断对话本身。

### 状态住在哪一层

理解架构的另一个角度是问"一个回合执行时，状态散落在哪"。不同层持有不同生命周期的状态：

| 状态 | 持有者 | 生命周期 |
|---|---|---|
| 连接信息（base_url / api_key / provider） | `AIAgent` 实例字段（第 2 层） | 整个 agent 实例 |
| 当前回合的消息列表 `messages` | `run_conversation()` 的局部变量（第 2 层） | 一个回合 |
| 迭代计数 | `IterationBudget`（第 2 层） | 一个 agent 实例（父子各一份） |
| 凭证轮换游标 | `credential_pool`（第 3 层） | 整个进程 |
| 会话历史与全文索引 | `SessionDB` → SQLite 文件（第 3 层） | 持久，跨进程 |
| 工具注册表 | `tools/registry.py` 模块级单例（第 4 层） | 整个进程 |
| 语义记忆 / 技能 | `~/.hermes/` 下的文件（第 4 层 + 文件系统） | 持久，跨进程，跨会话 |

一个有用的规律：**越靠下的层，状态的生命周期越长**。第 2 层的状态多是"一个回合"或"一个实例"级的内存对象；第 3、4 层则把状态落到 SQLite 和文件系统，能跨进程、跨会话存活。这解释了为什么"重启 Hermes 不会丢记忆"——记忆从来不在内存里，它在第 4 层的文件系统上。

---

## 1.3 顶层目录导览

下面这张表是 `AGENTS.md:16` 起的 "Project Structure" 一节的精炼版，并补上了"读源码时你会真正打开它的理由"。仓库根目录文件数量经常变动，**文件系统才是权威**，但下面这些是承重的入口点。

### 根目录的关键单文件

| 文件 | 行数量级 | 职责 | 你为什么会打开它 |
|---|---|---|---|
| `run_agent.py` | ~4100 行 | `class AIAgent`（`run_agent.py:326`）——agent 的状态容器与公开接口 | 想知道 agent 有哪些状态、`chat()` / `run_conversation()` 的入口 |
| `agent/conversation_loop.py` | ~4000 行 | `run_conversation()`——真正的同步工具调用循环 | 想读懂"一个回合是怎么跑完的" |
| `model_tools.py` | ~39 KB | 工具编排：`discover_builtin_tools()`、`handle_function_call()`、`get_tool_definitions()` | 想知道工具是怎么被发现、被派发的 |
| `toolsets.py` | ~29 KB | toolset 定义、`_HERMES_CORE_TOOLS` 列表 | 想知道"哪些工具属于哪个 toolset" |
| `cli.py` | ~14000 行 | `class HermesCLI`——交互式 CLI 编排器 | 改 CLI 行为、slash 命令、显示 |
| `hermes_state.py` | ~127 KB | `class SessionDB`——SQLite 会话存储，带 FTS5 全文搜索 | 想知道会话怎么存、怎么搜 |
| `hermes_constants.py` | 345 行 | `get_hermes_home()`、`display_hermes_home()` 等 profile 感知路径 | 想知道 `~/.hermes` 路径怎么解析 |
| `hermes_logging.py` | ~14 KB | `setup_logging()`——`agent.log` / `errors.log` / `gateway.log` | 排查日志、profile 感知的日志路径 |
| `hermes_bootstrap.py` | 130 行 | Windows UTF-8 引导 | 理解为什么入口点第一行都 import 它 |
| `batch_runner.py` | ~56 KB | 并行批量处理（轨迹生成） | 研究批量跑 agent、生成训练数据 |
| `mini_swe_runner.py` | ~28 KB | SWE-bench 风格的精简批量 runner | 跑评测基准 |

### 关键子目录

| 目录 | 职责 |
|---|---|
| `agent/` | Agent 内部实现——provider 适配、记忆、缓存、压缩、子 agent、工具执行器等。`conversation_loop.py`、`agent_init.py` 都在这里 |
| `hermes_cli/` | CLI 子命令、setup 向导、插件加载器、skin 引擎、命令注册表 |
| `tools/` | 工具实现——通过 `tools/registry.py` 在 import 时自动发现 |
| `tools/environments/` | 七种终端后端：local、docker、ssh、modal、daytona、singularity、vercel sandbox |
| `gateway/` | 消息网关——`run.py` + `session.py` + `platforms/`（每平台一个适配器） |
| `gateway/platforms/` | telegram、discord、slack、whatsapp、signal、matrix、email、sms 等适配器 |
| `plugins/` | 插件系统：`memory/`（记忆 provider）、`model-providers/`（推理后端）、`context_engine/`、`kanban/` 等 |
| `skills/` | 仓库自带的内建技能 |
| `optional-skills/` | 默认不激活的较重/小众技能 |
| `cron/` | 调度器——`jobs.py`、`scheduler.py` |
| `ui-tui/` | Ink (React) 终端 UI——`hermes --tui` |
| `tui_gateway/` | TUI 的 Python JSON-RPC 后端 |
| `acp_adapter/` | ACP server（VS Code / Zed / JetBrains 集成） |
| `providers/` | 推理 provider 的相关代码——`base.py` 是 provider 抽象基类 |
| `acp_adapter/` | ACP（Agent Client Protocol）server，让 VS Code / Zed / JetBrains 把 Hermes 当成后端 agent；`server.py`、`session.py`、`permissions.py` |
| `acp_registry/` | ACP 相关的注册数据 |
| `tui_gateway/` | `hermes --tui` 的 Python 后端，与 `ui-tui/`（Ink 前端）通过 JSON-RPC 通信；`server.py`、`transport.py`、`slash_worker.py` |
| `cron/` | 定时调度——`scheduler.py` 决定何时该跑、`jobs.py` 定义任务，含 `CronPromptInjectionBlocked` 这类安全防护（`cron/scheduler.py:45`） |
| `locales/` | i18n 文案，每语言一个 YAML（`en.yaml`、`ja.yaml`、`zh-*.yaml` 等十余种），CLI 与网关共用 |
| `mcp_serve.py` | 反向 MCP——把 Hermes 自己暴露成一个 MCP server 供其它 agent 调用 |
| `web/`、`website/` | Web 相关前端资源 |
| `docs/`、`packaging/`、`nix/`、`docker/` | 文档、打包、Nix flake、容器化构建 |
| `datagen-config-examples/` | 批量数据生成的配置样例，配合 `batch_runner.py` |
| `tests/` | Pytest 套件（截至 2026 年 5 月约 1.7 万个测试，分布在 ~900 个文件） |

### 代码量与复杂度概览

Hermes 不是一个小项目。几个数量级上的事实有助于校准你的阅读预期：

| 文件 | 体量 | 含义 |
|---|---|---|
| `cli.py` | 646 KB / 14246 行 | 全仓库最大单文件。`class HermesCLI` 承载了所有交互式 REPL 逻辑、slash 命令、显示渲染。**不要顺序读它。** |
| `run_agent.py` | 178 KB / 4094 行 | `class AIAgent` 状态容器 + 公开接口。状态字段极多，但方法大多是薄转发。 |
| `hermes_state.py` | 127 KB / 2966 行 | `SessionDB`——SQLite schema、迁移、FTS5 检索都在这里。 |
| `trajectory_compressor.py` | 65 KB / 1508 行 | 轨迹压缩，批量场景下把长会话蒸馏成训练样本。 |
| `agent/conversation_loop.py` | ~4018 行 | 真正的对话循环，逻辑密度最高。 |
| `cli-config.yaml.example` | 56 KB | 配置项的"穷举清单"，想知道某个开关存不存在直接搜它。 |
| `.env.example` | 23 KB | 所有可设的密钥/环境变量样例。 |

`cli.py` 和 `run_agent.py` 加起来近两万行——这是一个明确的信号：**Hermes 用"少数巨型文件 + 大量小模块"的混合结构**。巨型文件多是历史演进的产物（CLI 与 agent 核心一直在长），而 `agent/`、`tools/`、`plugins/` 下则是细粒度的小文件。阅读时把巨型文件当作"用 `file:line` 随机访问的字典"，把小模块当作"可以整篇读完的章节"。

阅读建议：**不要从 `cli.py` 或 `run_agent.py` 顺序读**——它们分别有 1.4 万行和 4 千行。正确的姿势是带着具体问题，用 `file:line` 跳转。本 wiki 的每一章都为你预先做了这件事。

### 终端后端：一个抽象基类撑起七种执行环境

`tools/environments/` 是观察 Hermes "用抽象屏蔽差异"风格的最佳样本。七个后端文件——`local.py`、`docker.py`、`ssh.py`、`modal.py`、`daytona.py`、`singularity.py`、`vercel_sandbox.py`——全部继承同一个 `BaseEnvironment`（`tools/environments/base.py:288`）。基类用的是经典的模板方法模式：

```python
class BaseEnvironment(ABC):
    """Common interface and unified execution flow for all Hermes backends.

    Subclasses implement ``_run_bash()`` and ``cleanup()``.  The base class
    provides ``execute()`` with session snapshot sourcing, CWD tracking,
    interrupt handling, and timeout enforcement.
    """
```

基类 `BaseEnvironment` 把"通用流程"——会话快照、CWD 跟踪、中断处理、超时——全部实现好，子类只需要回答两个问题：怎么 spawn 一个 bash 进程（`_run_bash()`），以及怎么释放资源（`cleanup()`，是唯一的 `@abstractmethod`）。一个新后端因此可能只需几十行。`init_session()`（`tools/environments/base.py:351`）会在后端构造后捕获一次 login shell 环境到快照文件，之后的命令 source 这个快照而不是每次跑 `bash -l`——这是一个针对"冷启动 shell 很慢"的真实优化。这个目录是第 7 章的主题。

### 插件生态的规模

`plugins/` 下 17 个目录远比根目录表格能展示的丰富。光是 `plugins/model-providers/` 就有 30 多个供应商目录（`openrouter`、`anthropic`、`gemini`、`bedrock`、`deepseek`、`ollama-cloud`、`nous` 等），`plugins/memory/` 有 8 个外部记忆 provider（`honcho`、`mem0`、`supermemory` 等），`plugins/web/` 有 8 个 web 搜索 provider，`plugins/platforms/` 还能补充 `irc`、`line`、`teams` 等网关平台。这个数量级说明 Hermes 的"零锁定"承诺不是口号——它的可扩展点真的被大量填充了。插件系统的加载机制是第 11 章的内容。

---

## 1.4 文件依赖链：工具是怎么被"连"起来的

工具系统的依赖链是整个项目里最值得先理解的一条链，因为它解释了"为什么 import 一个文件就会触发一连串副作用"。`AGENTS.md:69` 给出的依赖图是：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Tool self-registration dependency chain">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="12">
    <rect x="200" y="246" width="360" height="52" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="380" y="270" font-weight="700" fill="currentColor" text-anchor="middle">tools/registry.py</text>
    <text x="380" y="288" font-size="10" fill="#64748b" text-anchor="middle">无任何依赖，被所有工具文件 import</text>
    <rect x="200" y="170" width="360" height="52" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/>
    <text x="380" y="194" font-weight="700" fill="currentColor" text-anchor="middle">tools/*.py</text>
    <text x="380" y="212" font-size="10" fill="#64748b" text-anchor="middle">每个文件 import 时调用 registry.register()</text>
    <rect x="200" y="94" width="360" height="52" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="380" y="118" font-weight="700" fill="currentColor" text-anchor="middle">model_tools.py</text>
    <text x="380" y="136" font-size="10" fill="#64748b" text-anchor="middle">import tools/registry + 触发工具发现</text>
    <rect x="120" y="22" width="520" height="48" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="380" y="45" font-weight="700" fill="currentColor" text-anchor="middle">run_agent.py / cli.py / batch_runner.py</text>
    <text x="380" y="62" font-size="10" fill="#64748b" text-anchor="middle">tools/environments/ —— 最上层消费者</text>
  </g>
  <line x1="380" y1="246" x2="380" y2="226" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <line x1="380" y1="170" x2="380" y2="150" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <line x1="380" y1="94" x2="380" y2="74" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar4)"/>
  <text x="600" y="195" font-size="10" fill="#94a3b8" text-anchor="middle">import 即注册</text>
  <text x="600" y="270" font-size="10" fill="#94a3b8" text-anchor="middle">向上单向汇聚</text>
</svg>
<span class="figure-caption">图 R1.4 ｜ 工具系统的自注册依赖链：箭头表示 import 方向，全链向上汇聚到 model_tools.py。</span>

<details>
<summary>ASCII 原版</summary>

```text
tools/registry.py        ← 无任何依赖，被所有工具文件 import
        ▲
tools/*.py               ← 每个文件 import 时调用 registry.register()
        ▲
model_tools.py           ← import tools/registry + 触发工具发现
        ▲
run_agent.py / cli.py / batch_runner.py / tools/environments/
```

</details>

这条链的关键设计是**自注册（self-registration）**：

- `tools/registry.py` 本身没有任何依赖。它只提供一个注册表和 `register()` 函数。这让它可以被任何工具文件安全地 import，永远不会产生循环导入。
- 每个 `tools/*.py` 在被 import 的那一刻，就在模块作用域里调用 `registry.register(...)`，把自己的工具登记进去。换句话说，**import 即注册**。
- `model_tools.py` 负责"触发"——它 import `tools/registry`，并通过 `discover_builtin_tools()` 扫描并 import 所有 `tools/*.py`，从而让所有工具完成自注册。
- 最上层的 `run_agent.py`、`cli.py`、`batch_runner.py` 只需要 import `model_tools.py`，就能拿到一个已经填满的工具注册表。

这种设计的好处：**加一个新工具不需要修改任何现有文件**——你只要在 `tools/` 下新建一个文件并在里面 `register()`，发现机制自动把它接上。代价是 import 的副作用变得不那么"纯粹"，调试 import 顺序问题时需要记住这一点。

### 发现机制比"import 所有文件"更聪明

一个朴素的实现会无脑 import `tools/` 下的每个 `.py`。Hermes 没这么做——它先用**静态 AST 扫描**判断一个文件是否真的是工具文件，再决定要不要 import。`tools/registry.py` 里的 `_module_registers_tools()` 把文件解析成 AST，只看模块体（module body）里有没有顶层的 `registry.register(...)` 调用：

```python
def _module_registers_tools(module_path: Path) -> bool:
    """Return True when the module contains a top-level
    ``registry.register(...)`` call."""
    try:
        source = module_path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(module_path))
    except (OSError, SyntaxError):
        return False
    return any(_is_registry_register_call(stmt) for stmt in tree.body)
```

为什么要这么绕？因为 `tools/` 下不只有工具文件，还有 helper 模块。helper 模块里也可能在某个函数体内出现 `registry.register()` 字样——但那不是"注册一个工具"。`_module_registers_tools()` 只扫 `tree.body`（顶层语句），不进函数体，从而精确区分"这是一个工具文件"和"这只是个工具用的辅助模块"。这避免了"import 一个纯 helper 反而触发副作用"的隐患。这是一个值得借鉴的模式：**用静态分析为动态 import 做守门员**。

### 这条链的代价

自注册不是没有代价的。它把"哪些工具存在"这个信息从一处显式清单变成了"散落在 40 多个文件里的副作用"。后果是：

- import 顺序问题更难排查——一个工具没注册上，可能是它的文件根本没被 import，也可能是 import 时抛了异常被吞掉。
- 静态分析工具（IDE、类型检查器）看不出工具之间的关系。
- 测试时如果只 import 了部分工具文件，注册表就是不完整的。

Hermes 接受这个代价，是因为它换来的"加工具零侵入"对一个有 40+ 工具且持续增长的项目来说收益巨大。

工具系统的细节（注册表结构、`handle_function_call()` 的派发逻辑、toolset 过滤）留给 [第 5 章 工具系统](05-tool-system.md)。这里你只需要记住：**这条链是单向的，向上汇聚到 `model_tools.py`**。

---

## 1.5 用户配置与状态布局

Hermes 的所有持久状态都集中在一个目录下，默认是 `~/.hermes/`。这个目录的解析逻辑全部收敛在 `hermes_constants.py`，这是一个**刻意做到零依赖、import 安全**的模块——它被 30 多个文件在模块作用域 import，任何一处引入循环依赖都会让整个项目无法启动。

### `get_hermes_home()`：单一事实来源

`hermes_constants.py:14` 的 `get_hermes_home()` 是所有路径解析的唯一入口：

```python
def get_hermes_home() -> Path:
    val = os.environ.get("HERMES_HOME", "").strip()
    if val:
        return Path(val)
    # ...（profile 错配的一次性告警，见下文）...
    return Path.home() / ".hermes"
```

逻辑很简单：**先看环境变量 `HERMES_HOME`，没有就回退到 `~/.hermes`**。但简单背后藏着一个 profile（多实例隔离）相关的陷阱。Hermes 支持多个相互隔离的"profile"，每个 profile 有自己独立的 `HERMES_HOME` 目录（例如 `~/.hermes/profiles/coder`）。当一个子进程被派生出来却忘了显式传递 `HERMES_HOME` 时，它会静默回退到默认 profile，导致数据写错地方。`get_hermes_home()` 为此专门埋了一段**一次性告警逻辑**（`hermes_constants.py:35-66`）：如果 `active_profile` 文件显示当前激活的是非 default profile，却没有 `HERMES_HOME`，就直接往 stderr 写一条醒目的警告——故意不走 `logging`，因为这个函数在 30 多处于 import 时被调用，那时 logging 可能还没配好。

这是一个值得学习的工程细节：**当一个函数被极广泛地在 import 时调用，它就不能假设任何运行时设施已经就绪**。

### 标准目录布局

| 路径 | 内容 | 解析函数 |
|---|---|---|
| `~/.hermes/config.yaml` | 所有行为配置（非密钥） | `get_config_path()`（`hermes_constants.py:277`） |
| `~/.hermes/.env` | **仅密钥**——API key、token、密码 | `get_env_path()`（`hermes_constants.py:292`） |
| `~/.hermes/logs/agent.log` | INFO 及以上日志 | `hermes_logging.py` |
| `~/.hermes/logs/errors.log` | WARNING 及以上 | `hermes_logging.py` |
| `~/.hermes/logs/gateway.log` | 网关运行时日志 | `hermes_logging.py` |
| `~/.hermes/skills/` | 用户技能 | `get_skills_dir()`（`hermes_constants.py:286`） |
| `~/.hermes/profiles/<name>/` | 非 default profile 的隔离根 | `get_default_hermes_root()`（`hermes_constants.py:71`） |
| `~/.hermes/home/` | 子进程的 per-profile `HOME`（git/ssh/gh 配置落盘处） | `get_subprocess_home()`（`hermes_constants.py:165`） |

`config.yaml` 与 `.env` 的分工是一条硬规则（`AGENTS.md:360`）：**`.env` 只放密钥**，所有非密钥设置（超时、阈值、特性开关、路径、显示偏好）都属于 `config.yaml`。

### 几个值得留意的辅助函数

- `display_hermes_home()`（`hermes_constants.py:145`）——给**用户看**的路径字符串，用 `~/` 缩写。代码里需要真实 `Path` 时用 `get_hermes_home()`，给用户打印时用这个。
- `get_hermes_dir(new, old)`（`hermes_constants.py:124`）——向后兼容的子目录解析：老安装如果磁盘上已有旧路径就继续用，新安装用合并后的新布局，**免迁移**。
- `is_termux()` / `is_wsl()` / `is_container()`——环境探测，结果缓存。Hermes 在很多地方根据运行环境调整行为，这些探测是基础。
- `apply_ipv4_preference()`（`hermes_constants.py:300`）——在 IPv6 不通的服务器上，monkey-patch `socket.getaddrinfo` 强制走 IPv4，避免每次连接都卡满 TCP 超时。由 `config.yaml` 的 `network.force_ipv4` 开关控制。

配置加载本身有三条不同的代码路径（CLI、子命令、网关），这个看似冗余的设计有其原因，[第 2 章](02-entrypoints.md) 会专门解释。

### 三个日志文件，按职责分流

Hermes 的可观测性入口是 `hermes_logging.py` 的 `setup_logging()`（`hermes_logging.py:156`）。它一次性创建三个日志文件，每个回答一个不同的问题：

| 文件 | 级别 | 回答的问题 |
|---|---|---|
| `agent.log` | INFO+ | "agent 到底做了什么"——所有 agent / 工具 / 会话活动的 catch-all 主日志 |
| `errors.log` | WARNING+ | "哪里出问题了"——只收错误与警告，用于快速分诊 |
| `gateway.log` | INFO+ | "网关层发生了什么"——仅在 `mode="gateway"` 时创建，只收 `gateway.*` logger 的记录 |

三个文件全部用 `RotatingFileHandler`（`hermes_logging.py:29`）做大小轮转，并套一层 `RedactingFormatter` 自动脱敏——日志里不会泄露 API key 与 token。分流的关键在于一个自定义 filter：`gateway.log` 只接收 `gateway.*` 命名空间的 logger 记录，而 `agent.log` 保持 catch-all。这样运维网关时可以单看 `gateway.log` 不被 agent 噪声淹没，排查 agent 行为时又能在 `agent.log` 里看到全貌。这三个文件的路径都是 profile 感知的——非 default profile 的日志落在自己的隔离目录里。可观测性的完整讨论在第 15 章。

### 会话为什么存在 SQLite 而不是 JSON

`SessionDB`（`hermes_state.py`，2966 行）把所有会话存进一个 SQLite 文件，而不是常见的"一个会话一个 JSON 文件"。这个选择背后有三个理由：

- **全文检索。** 学习闭环需要 `search_messages()`（`hermes_state.py:1880`）和 `search_sessions()`（`hermes_state.py:2151`）——让 agent 能搜索自己过去的对话。SQLite 的 FTS5 扩展提供了开箱即用、零额外依赖的全文索引；JSON 文件要做到这点得自己造倒排索引。
- **原子性与并发。** 网关模式下多个会话可能同时写入。SQLite 的事务保证了写入要么完整要么不发生，不会出现半截损坏的会话；多个 JSON 文件的并发写则需要自己加锁。
- **结构化查询。** "列出最近 7 天来自 Telegram 的会话"这类查询，在 SQL 里是一行 `WHERE`，在 JSON 文件堆里是一次全量扫描。

代价是会话不再是人类可直接 `cat` 的文本，调试时要靠 `sqlite3` 或 Hermes 自带的查询命令。但对一个把"搜索自己的历史"当作核心能力的 agent 来说，这个代价是必须付的。第 6 章会深入 `SessionDB` 的 schema 与压缩如何协作。

---

## 1.6 自我改进学习闭环

1.1 节说过，Hermes 与 LangChain、AutoGPT、Claude Code 最根本的区别是它内建了一个**闭合的学习循环**。这一节把这个循环拆开看：它由四个组件咬合而成，每一个都不是插件，而是对话循环里的一等公民。

四个组件各司其职：

- **记忆系统**（`agent/memory_manager.py`，`class MemoryManager` 在 `agent/memory_manager.py:190`）——持久化的语义记忆。agent 把跨会话有效的事实写进记忆，下次对话开头自动注入。
- **技能自创建**（`tools/skill_manager_tool.py`、`tools/skills_hub.py`）——agent 可以调用工具把一段成功的工作流程蒸馏成一个 SKILL.md 技能，存进 `~/.hermes/skills/`。技能是**程序性记忆**（"怎么做"），区别于记忆系统的语义记忆（"是什么"）。`_guard_agent_created_enabled()`（`tools/skill_manager_tool.py:59`）和 `_security_scan_skill()`（`:78`）给自创建加了开关和安全扫描。
- **curator**（`agent/curator.py`）——一个周期性的后台策展者。`should_run_now()`（`agent/curator.py:199`）按 interval 与空闲时长决定是否触发，`apply_automatic_transitions()`（`agent/curator.py:256`）自动归档陈旧会话，并在合适时向用户建议"把这类工作沉淀成一个技能"。
- **session_search**（`hermes_state.py` 的 `search_messages()` @ `:1880` 与 `search_sessions()` @ `:2151`）——基于 SQLite FTS5 的全文检索，让 agent 能搜索自己过去说过的话、做过的事。

四者如何咬合成一个闭环：

<svg viewBox="0 0 800 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Self-improvement learning loop of four components">
  <defs>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <g font-size="11">
    <rect x="220" y="20" width="360" height="50" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
    <text x="400" y="50" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">一次次真实对话</text>
    <rect x="120" y="118" width="220" height="58" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="230" y="142" font-weight="600" fill="currentColor" text-anchor="middle">memory nudge</text>
    <text x="230" y="160" font-size="10" fill="#64748b" text-anchor="middle">周期性提醒"把知识写进记忆"</text>
    <rect x="460" y="118" width="220" height="58" rx="8" fill="#0ea5e9" fill-opacity="0.18" stroke="#0ea5e9" stroke-width="1.2"/>
    <text x="570" y="142" font-weight="600" fill="currentColor" text-anchor="middle">session_search</text>
    <text x="570" y="160" font-size="10" fill="#64748b" text-anchor="middle">检索过去对话作上下文</text>
    <rect x="120" y="222" width="220" height="58" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="230" y="246" font-weight="600" fill="currentColor" text-anchor="middle">MemoryManager</text>
    <text x="230" y="264" font-size="10" fill="#64748b" text-anchor="middle">语义记忆持久化 · 下次对话注入</text>
    <rect x="120" y="332" width="220" height="58" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="230" y="356" font-weight="600" fill="currentColor" text-anchor="middle">curator</text>
    <text x="230" y="374" font-size="10" fill="#64748b" text-anchor="middle">周期性策展、归档</text>
    <rect x="460" y="332" width="220" height="58" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="570" y="356" font-weight="600" fill="currentColor" text-anchor="middle">技能自创建</text>
    <text x="570" y="374" font-size="10" fill="#64748b" text-anchor="middle">skill_manager_tool 蒸馏 SKILL.md</text>
  </g>
  <line x1="300" y1="70" x2="240" y2="116" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <text x="220" y="98" font-size="10" fill="#64748b">回合结束 post-hook</text>
  <line x1="500" y1="70" x2="560" y2="116" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <text x="540" y="98" font-size="10" fill="#64748b">回合中按需</text>
  <line x1="230" y1="176" x2="230" y2="220" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <path d="M460,160 L355,235" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3,2" marker-end="url(#ar5)"/>
  <text x="380" y="200" font-size="10" fill="#94a3b8">下次对话开头注入</text>
  <line x1="230" y1="280" x2="230" y2="330" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <line x1="340" y1="361" x2="456" y2="361" stroke="#94a3b8" stroke-width="1.4" marker-end="url(#ar5)"/>
  <text x="398" y="352" font-size="10" fill="#64748b" text-anchor="middle">建议沉淀</text>
  <path d="M570,332 C570,300 420,300 420,55 L582,55" fill="none" stroke="#94a3b8" stroke-width="1.4" stroke-dasharray="3,2" marker-end="url(#ar5)"/>
  <text x="610" y="300" font-size="10" fill="#94a3b8" text-anchor="middle">技能在后续对话被加载</text>
</svg>
<span class="figure-caption">图 R1.5 ｜ 记忆、技能、curator、session_search 四个组件咬合成的闭合学习循环：经验沉淀后在新对话中复用。</span>

<details>
<summary>ASCII 原版</summary>

```text
   ┌──────────────────────────────────────────────────────────┐
   │                    一次次真实对话                          │
   └───────────────┬──────────────────────────┬───────────────┘
                   │ 回合结束 post-hook        │ 回合中按需
                   ▼                          ▼
        ┌──────────────────┐        ┌──────────────────────┐
        │  memory nudge    │        │  session_search      │
        │  周期性提醒 agent │        │  检索过去的对话作上下文 │
        │  "把知识写进记忆" │        └──────────┬───────────┘
        └────────┬─────────┘                   │
                 ▼                             │
        ┌──────────────────┐                   │
        │  MemoryManager   │◄──────────────────┘
        │  语义记忆持久化   │  下次对话开头注入
        └────────┬─────────┘
                 │
                 ▼
        ┌──────────────────┐        ┌──────────────────────┐
        │  curator         │───────►│  技能自创建            │
        │  周期性策展、归档 │ 建议   │  skill_manager_tool   │
        │  "该沉淀技能了"   │        │  蒸馏出 SKILL.md      │
        └──────────────────┘        └──────────┬───────────┘
                 ▲                             │
                 │       技能在后续对话被加载   │
                 └─────────────────────────────┘
```

</details>

闭环的关键在于"沉淀"和"复用"形成回路：对话产生经验 → memory nudge 与 curator 在 post-hook 阶段（不打断对话）把经验沉淀为语义记忆和技能 → 下一次对话开头自动注入记忆、按需加载技能、用 session_search 翻历史 → 新对话又产生新经验。**agent 用得越久，注入的上下文质量越高。**

这套机制的代价是它引入了"非确定性的后台行为"——同一句输入在第一次和第一百次对话里得到的回应可能不同，因为注入的记忆与技能变了。这对调试和评测都是挑战，第 10 章会讨论 Hermes 如何用 profile 隔离与开关来控制这种非确定性。

### curator 的"延迟首跑"——一个值得学的克制

curator 是这个闭环里最容易"过度热情"的组件——它会自动归档会话、自动建议蒸馏技能。如果它在 `hermes update` 之后的第一个后台 tick 就立刻开跑，用户会被一堆莫名其妙的自动变更吓到。`should_run_now()`（`agent/curator.py:199`）为此专门处理了"从未跑过"这种情况：

```python
    state = load_state()
    last = _parse_iso(state.get("last_run_at"))
    if last is None:
        # Never run before. Seed state so we wait a full interval before
        # the first real pass.
        ...
        state["last_run_at"] = now.isoformat()
        state["last_run_summary"] = (
            "deferred first run — curator seeded, will run after one "
            "interval; use `hermes curator run --dry-run` to preview now"
        )
        save_state(state)
        return False
```

逻辑是：第一次观察到"没有 `last_run_at`"时，不立刻跑，而是把 `last_run_at` 播种成"现在"，从而把第一次真正的策展推迟整整一个 interval（默认 7 天）。想立刻看效果的用户可以显式跑 `hermes curator run --dry-run`，那条路径绕过这个 gate。这是 Hermes 对"自动化系统"的一贯态度：**自动化的默认行为应该保守，激进的行为留给用户显式触发。** 一个学习闭环要被信任，前提是它不会在用户没准备好时擅自行动。

### 记忆系统的"一个外部 provider"约束

记忆系统允许接入外部 provider（如 Honcho 用户建模），但 `MemoryManager.add_provider()`（`agent/memory_manager.py:190` 起）有一条硬约束：builtin provider 永远在第一位，且**最多只允许一个非 builtin 的外部 provider**——第二个外部 provider 会被带警告地拒绝。这个约束避免了"记忆写到哪个 provider"的歧义：内建记忆总在，外部记忆唯一。一个 provider 失败也绝不阻塞另一个。这又是一个"用约束换确定性"的取舍，和 1.7 节的主题一脉相承。

### 技能的生命周期：active → stale → archived

学习闭环不只会"创建"技能，还会"淘汰"技能——一个只增不减的技能库最终会变成噪声。curator 的 `apply_automatic_transitions()`（`agent/curator.py:256`）是一个**纯函数、不调 LLM** 的状态机，按技能最近一次真实使用的时间戳在三个状态间迁移：

```python
        if anchor <= archive_cutoff and current != _u.STATE_ARCHIVED:
            ok, _msg = _u.archive_skill(name)
            ...
        elif anchor <= stale_cutoff and current == _u.STATE_ACTIVE:
            _u.set_state(name, _u.STATE_STALE)
            ...
        elif anchor > stale_cutoff and current == _u.STATE_STALE:
            # Skill got used again after being marked stale — reactivate.
            _u.set_state(name, _u.STATE_ACTIVE)
```

三条迁移规则：长期没用 → 归档；中期没用 → 标记为 stale；stale 的技能又被用了 → 重新激活。两个值得注意的守护：被 pin 的技能永远不动；从未被用过的新技能用 `created_at` 作为锚点，避免刚创建就被立刻归档。这个状态机让技能库自我维护——常用的留下、不用的沉底、重新被需要的能复活，整个过程不花一个 LLM token。它是 1.6 节学习闭环里"沉淀"之外的另一半：**遗忘也是学习的一部分。**

---

## 1.7 关键设计取舍

读架构图只能告诉你"是什么"，读懂取舍才能告诉你"为什么"。下面四个决定是理解 Hermes 性格的钥匙——每一条都是有代价的选择，不是免费的优点。

**同步对话循环。** 已在 1.1 节展开：放弃 `async` 的吞吐换取可中断性与可调试性。代价是核心循环内不能并发，并发需求被推到进程/线程边界。这是为"agent 是交互式的、会被打断的"这一现实付出的合理代价。

**声明式 provider 适配。** 新增一个模型供应商不需要改对话循环——只要写一个适配器（如 `agent/anthropic_adapter.py`）把内部统一消息格式翻译成供应商协议，再在 provider 注册表登记即可。`run_conversation()` 永远只跟一个抽象的 provider 接口对话。代价是"统一消息格式"必须是所有供应商能力的最大公约数加可选扩展，维护这个抽象本身有成本；好处是支持任意供应商、`hermes model` 一键切换、主模型挂掉自动 failover。

**四层插件体系。** Hermes 的可扩展性不是单一机制，而是分层的：`tools/` 是 import 即注册的内建工具；`tools/environments/` 是可插拔的终端后端；`plugins/` 是更重的功能插件（memory provider、model provider、context engine、platform 适配等四类）；MCP 则接入外部 server。为什么不统一成一种机制？因为这四类扩展的生命周期、信任级别、加载时机都不同——内建工具随进程启动，MCP server 是外部进程，model provider 决定了整个会话的后端。强行统一会让简单的事情变复杂。代价是新人要先搞清"我的扩展属于哪一层"。

下面这张表把四个扩展层放在一起对比，帮你判断"我要加的东西属于哪一层"：

| 扩展层 | 加载时机 | 信任级别 | 进程边界 | 典型例子 |
|---|---|---|---|---|
| 内建工具 `tools/*.py` | 进程启动，import 即注册 | 完全信任（与核心同仓） | 同进程 | `bash`、`read_file`、`web_search` |
| 终端后端 `tools/environments/` | 会话首次需要执行命令时构造 | 完全信任 | 同进程，但命令在远端/容器执行 | `docker`、`ssh`、`modal` |
| 功能插件 `plugins/` | 按 `config.yaml` 配置选择性加载 | 半信任（仓内但可选） | 多为同进程，部分起子进程 | `honcho` 记忆、`openrouter` 后端 |
| MCP server | 运行时连接，可热插拔 | 不信任（第三方进程） | 独立进程，经 stdio/HTTP 通信 | 任意第三方 MCP server |

读这张表的关键是"信任级别"和"进程边界"这两列从上到下递减/外推。越往下，扩展越不可信、越需要进程隔离、加载越晚。把它们强行塞进同一个机制，就会被迫用最严格的隔离去对待最可信的内建工具——那是巨大的浪费。Hermes 的分层正是让每一类扩展只承担它该承担的那份复杂度。

**profile 隔离。** 每个 profile 有独立的 `HERMES_HOME`（`~/.hermes/profiles/<name>/`），会话、记忆、技能、日志、子进程 `HOME` 全部隔离。这让"工作 agent"和"实验 agent"互不污染，也让上一节提到的学习闭环的非确定性可控——你可以在一个 profile 里放心地让 agent 自创建技能，不影响另一个。代价是 profile 必须被显式传递给每一个子进程，否则会静默回退到 default profile 写错数据——`get_hermes_home()` 为此专门埋了告警逻辑（见 1.5 节）。

**少数巨型文件 + 大量小模块的混合结构。** `cli.py`（14246 行）、`run_agent.py`（4094 行）这样的巨型文件与 `agent/`、`tools/` 下的细粒度小文件并存。这不是"技术债"那么简单——巨型文件集中了高内聚的有状态逻辑（一个 CLI 编排器、一个 agent 状态容器），强行拆分反而会制造大量跨文件的状态传递。代价是这些文件无法顺序通读，必须靠 `file:line` 随机访问。

理解这五个取舍，你就不会在阅读源码时把"看起来怪"的设计当成 bug——它们多半是某个被刻意权衡过的决定的下游结果。

### 几个容易踩的认知误区

新读者带着对其它 agent 框架的预期来读 Hermes，常会形成几个错误的心智模型。提前纠正：

- **误区："`AIAgent` 类里应该有对话逻辑。"** 没有。`AIAgent`（`run_agent.py:326`）是状态容器，`__init__` 是转发器，`run_conversation()` 也是转发器。真正的逻辑在 `agent/conversation_loop.py` 和 `agent/agent_init.py` 的自由函数里。读对话逻辑别打开 `run_agent.py`。
- **误区："工具列表在某个文件里有一份清单。"** 没有集中清单。工具通过 import 副作用注册（见 1.4），"有哪些工具"是运行时注册表的状态，不是源码里的一个数组。`toolsets.py` 里的 `_HERMES_CORE_TOOLS` 是 toolset 成员关系，不是工具的存在性来源。
- **误区："这是个 `async` 框架。"** 不是。核心循环是同步的（见 1.1）。看到 `async` 多半是网关层或某个 I/O 适配器，不是对话核心。
- **误区："改一个工具会影响 agent 核心。"** 不会。依赖方向严格单向向上（见 1.2）。工具层从不被核心反向依赖，改工具的影响半径止于工具自己。
- **误区："记忆和技能是可选插件。"** 不是。它们是对话循环的一等公民，post-hook 阶段内建触发（见 1.6）。可选的是"外部记忆 provider"，不是记忆机制本身。

每纠正一个误区，你读源码时就少走一段弯路。

---

## 1.8 本 wiki 的阅读路线

本 wiki 由两部分组成：**15 章参考手册** + **一个单请求叙事 trace 导览（20 步）**。两者定位不同——参考手册是"按主题切分的字典"，trace 导览是"跟着一条真实请求走一遍的故事"。

参考手册各章及推荐阅读顺序：

<svg viewBox="0 0 800 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Reference manual chapters grouped into four themes">
  <g font-size="11">
    <rect x="20" y="20" width="160" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
    <text x="100" y="44" font-weight="700" fill="currentColor" text-anchor="middle">入口与核心</text>
    <rect x="220" y="20" width="560" height="40" rx="6" fill="#fff7ed" stroke="#cbd5e1"/>
    <text x="240" y="44" fill="currentColor">第 1 章 导论与全局架构（你在这里）　·　第 2 章 入口与进程引导　·　第 3 章 核心对话循环</text>
    <rect x="20" y="80" width="160" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
    <text x="100" y="104" font-weight="700" fill="currentColor" text-anchor="middle">模型与上下文</text>
    <rect x="220" y="80" width="560" height="40" rx="6" fill="#f0fdfa" stroke="#cbd5e1"/>
    <text x="240" y="104" fill="currentColor">第 4 章 Provider 适配与凭证池　·　第 6 章 上下文压缩与会话存储</text>
    <rect x="20" y="140" width="160" height="124" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="100" y="206" font-weight="700" fill="currentColor" text-anchor="middle">能力扩展</text>
    <rect x="220" y="140" width="560" height="124" rx="6" fill="#faf5ff" stroke="#cbd5e1"/>
    <text x="240" y="166" fill="currentColor">第 5 章 工具系统</text>
    <text x="240" y="186" fill="currentColor">第 7 章 终端后端</text>
    <text x="240" y="206" fill="currentColor">第 8 章 MCP 集成</text>
    <text x="240" y="226" fill="currentColor">第 9 章 技能系统</text>
    <text x="240" y="246" fill="currentColor">第 10 章 记忆与学习循环　·　第 11 章 插件系统</text>
    <rect x="20" y="284" width="160" height="104" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.2"/>
    <text x="100" y="340" font-weight="700" fill="currentColor" text-anchor="middle">多前端与运维</text>
    <rect x="220" y="284" width="560" height="104" rx="6" fill="#f0f9ff" stroke="#cbd5e1"/>
    <text x="240" y="310" fill="currentColor">第 12 章 子 agent 派发与 cron 调度</text>
    <text x="240" y="332" fill="currentColor">第 13 章 消息网关</text>
    <text x="240" y="354" fill="currentColor">第 14 章 批量运行与轨迹压缩</text>
    <text x="240" y="376" fill="currentColor">第 15 章 测试、配置与可观测性</text>
  </g>
  <text x="400" y="424" font-size="10" fill="#64748b" text-anchor="middle">15 章参考手册按四个主题分组；左色块表示主题，右块列出章节</text>
</svg>
<span class="figure-caption">图 R1.6 ｜ 参考手册的 15 章按"入口与核心 / 模型与上下文 / 能力扩展 / 多前端与运维"四个主题分组。</span>

<details>
<summary>ASCII 原版</summary>

```text
                  ┌─ 第 1 章 导论与全局架构（你在这里）
                  │
   入口与核心 ────┼─ 第 2 章 入口与进程引导
                  ├─ 第 3 章 核心对话循环
                  │
   模型与上下文 ──┼─ 第 4 章 Provider 适配与凭证池
                  ├─ 第 6 章 上下文压缩与会话存储
                  │
   能力扩展 ──────┼─ 第 5 章 工具系统
                  ├─ 第 7 章 终端后端
                  ├─ 第 8 章 MCP 集成
                  ├─ 第 9 章 技能系统
                  ├─ 第 10 章 记忆与学习循环
                  ├─ 第 11 章 插件系统
                  │
   多前端与运维 ──┼─ 第 12 章 子 agent 派发与 cron 调度
                  ├─ 第 13 章 消息网关
                  ├─ 第 14 章 批量运行与轨迹压缩
                  └─ 第 15 章 测试、配置与可观测性
```

</details>

建议路线：

- **想快速建立全局观**：读完第 1、2、3 章，再扫一遍 trace 导览。这三章加上一次端到端的 trace，足以让你对"一条消息进来发生了什么"有完整认知。
- **想改某个具体子系统**：直接跳到对应章节。每章末尾的"延伸阅读"会把你导向相关章节。
- **想做研究/训练数据**：第 14 章是入口，配合第 6 章理解轨迹压缩。

trace 导览不按主题切分，而是选一个真实的用户请求，从 `hermes` 脚本启动一路跟到模型返回、工具执行、记忆 nudge——20 个步骤，每步都带 `file:line`。它是把前面分章学到的碎片重新缝合成整体的最好方式，建议在读完第 3 章之后看。

### 按角色选择阅读深度

不同读者来 Hermes 源码的目的不同，没必要每章都精读：

- **集成方**（想把 Hermes 接进自己的产品）：第 1、2 章建立全局观，第 13 章看网关，第 8 章看 MCP，`acp_adapter/` 相关内容看第 2 章。可跳过第 14 章。
- **贡献者**（想给 Hermes 提 PR）：第 1、3、5 章是必读——它们覆盖核心循环与工具系统这两个最常被改动的区域。再根据你要改的子系统跳读对应章节。
- **研究者**（想用 Hermes 跑评测、生成训练数据）：第 1、14 章是主线，第 6 章理解轨迹压缩，其余按需。
- **运维**（想把 Hermes 部署成长期服务）：第 1、2、13、15 章——进程引导、网关、可观测性是你的关注点。

无论哪种角色，第 1 章都是地基，trace 导览都是把碎片缝合的"验收测试"。

### 几个贯穿全书的术语

提前统一几个词，避免后续章节产生歧义：

- **回合（turn）**——一次完整的"用户输入 → 模型 + 工具交替 → 最终回复"。一次 `run_conversation()` 调用驱动一个回合。
- **迭代（iteration）**——回合内部 `while` 循环的一轮，对应一次模型调用（可能伴随工具调用）。一个回合包含一到多次迭代，受 `IterationBudget` 约束。
- **会话（session）**——跨多个回合的持久对话，存在 `SessionDB` 里，有自己的 ID。
- **provider**——一个模型供应商的适配单元（OpenRouter、Anthropic 等），区别于"插件"这个更宽的词。
- **toolset**——工具的逻辑分组，决定一个 agent 实例启用哪些工具，定义在 `toolsets.py`。
- **profile**——一个隔离的 Hermes 实例，有独立的 `HERMES_HOME`。

记住"回合 ⊃ 迭代"这个包含关系，你读第 3 章时就不会把两者混为一谈。

---

## 延伸阅读

- [第 2 章 入口与进程引导](02-entrypoints.md)——`hermes` 脚本如何一路引导到 `cmd_chat`，三大入口（CLI / 网关 / 批量）的对比。
- [第 3 章 核心对话循环](03-conversation-loop.md)——`AIAgent`、`run_conversation()` 与那个同步的 `while` 循环。
- [第 4 章 Provider 适配与凭证池](04-provider-credentials.md)——模型层如何屏蔽供应商差异。
- [第 5 章 工具系统](05-tool-system.md)——`tools/registry.py` 自注册链与工具派发的完整细节。
- [第 6 章 上下文压缩与会话存储](06-context-session.md)——`SessionDB` 与上下文压缩。
- [第 13 章 消息网关](13-gateway.md)——多平台单进程网关的架构。
