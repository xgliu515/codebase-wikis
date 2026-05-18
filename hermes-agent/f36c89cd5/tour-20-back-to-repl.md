# Trace 步骤 20 —— 一轮结束，回到那个闪烁的光标

## 1. 当前情境

[Trace 步骤 19](tour-19-post-turn.md) 里，收尾的后台任务已经派发出去——标题生成、记忆 sync 在各自的后台线程里跑。主流程这边，`chat()` 已经把答案渲染完、会话已落盘。控制权正一层层往回返：`run_conversation` → `AIAgent.chat` → CLI 层 `chat()` → `HermesCLI.run()`。

这是导览的最后一步。它要回答的问题很简单：一轮结束之后呢？

## 2. 问题

一轮对话走完了。系统要回到一个**干净、可接受下一条输入**的状态。但「干净」不等于「清空」——有些东西必须留下，有些东西必须复位：

- 内存里的 `messages` 列表要**保留**——否则用户下一句「那它的第二行呢？」就失去了上下文。
- 但这一轮的临时状态（中断标志、迭代计数器、流式缓冲）必须**复位**——不能让上一轮的残留污染下一轮。
- 光标要回到输入框，REPL 要重新阻塞等待用户。

## 3. 朴素思路

`run()` 写成一个 `while True`：读一行输入 → 调 `chat()` → 打印 → 回到循环顶。一轮就是循环的一次迭代，天然干净。

## 4. 为什么朴素思路会崩

这个朴素思路其实**基本正确**——REPL 就是一个循环。它真正容易忽略的是「一轮和下一轮之间，状态该怎么处理」：

- 如果每轮结束把 `messages` 清空，对话就失忆了，多轮交互不成立。
- 如果什么都不复位，上一轮如果是被 `Ctrl+C` 打断的，`_interrupt_requested` 标志还是 `True`——下一轮一进对话循环（[Trace 步骤 08](tour-08-enter-run-conversation.md)）立刻又被「中断」。流式缓冲 `_stream_buf` 若没清，上一轮的半行残留会粘到下一轮输出开头。
- 异常路径：`chat()` 中途抛错，循环不能跟着崩——得保证无论这一轮怎么结束，都能干净地回到等待输入的状态。

所以「回到 REPL」不是「跳回循环顶」这么轻——它是一次明确的状态交接。

## 5. Hermes 的做法

`HermesCLI.run()`（`cli.py:11604`）就是那个 REPL 循环。控制权从 `chat()` 返回后，落回循环体，准备下一次迭代。关键在于它对状态做了**有保留的复位**：

- **保留**：`messages` 列表留在内存里，对话连续。这一轮新增的 `assistant(tool_call)`、`tool`、`assistant(text)` 三条消息都还在——下一轮的 `messages` 会以它们为前缀继续生长。
- **复位**：一轮收尾时，本轮的临时标志被清掉——`_interrupt_requested` 复位、迭代计数器归零、流式缓冲（`_stream_buf` 等，见 [Trace 步骤 17](tour-17-streaming-render.md)）清空。下一轮从干净状态起步。
- **落盘已完成**：SQLite 那边（[Trace 步骤 18](tour-18-session-persist.md)）已经持久化——就算进程现在崩了，这一轮也不会丢，`hermes --continue` 还能接回来。

于是 REPL 重新阻塞，光标停回输入框：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="return to REPL loop with selective state reset">
  <defs>
    <marker id="t20ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="280" y="20" width="200" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="42" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">chat() 返回</text>
  <line x1="380" y1="54" x2="380" y2="78" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t20ar)"/>
  <rect x="130" y="80" width="500" height="130" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="148" y="103" font-size="13" font-weight="700" fill="currentColor">HermesCLI.run() 循环体</text>
  <text x="612" y="103" text-anchor="end" font-size="10" fill="#64748b">cli.py:11604</text>
  <rect x="148" y="114" width="464" height="26" rx="4" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="160" y="131" font-size="11" fill="#64748b">保留：messages 留在内存（对话连续）</text>
  <rect x="148" y="144" width="464" height="26" rx="4" fill="#fef2f2" stroke="#dc2626" stroke-width="1"/>
  <text x="160" y="161" font-size="11" fill="#64748b">复位：中断标志 / 迭代计数器 / 流式缓冲</text>
  <rect x="148" y="174" width="464" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="160" y="191" font-size="11" fill="#64748b">重新等待输入</text>
  <line x1="380" y1="210" x2="380" y2="234" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t20ar)"/>
  <rect x="180" y="236" width="400" height="56" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="259" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">光标停在输入框，等待下一条消息</text>
  <text x="380" y="279" text-anchor="middle" font-size="10" fill="#94a3b8">用户再发一句 → 新一轮 trace 从 Trace 步骤 07 重新开始</text>
</svg>
<span class="figure-caption">图 T20.1 ｜ 回到 REPL：messages 保留以延续对话，本轮临时状态复位，光标回到输入框等下一条。</span>

<details>
<summary>ASCII 原版</summary>

```text
   chat() 返回
        │
        ▼
   HermesCLI.run() 循环体          cli.py:11604
   ├─ messages 保留在内存（对话连续）
   ├─ 本轮临时状态复位（中断标志/计数器/流缓冲）
   └─ 重新等待输入
        │
        ▼
   光标停在输入框，等待下一条消息
   （用户再发一句 → 新一轮 trace 从 Trace 步骤 07 重新开始）
```

</details>

下一轮如果来，它不会从头走 [Trace 步骤 01–06](tour-01-shell-entry.md)（进程、CLI、agent、工具、系统提示都已就绪、缓存著），而是从 [Trace 步骤 07](tour-07-repl-input.md)「读取用户输入」直接进入——`AIAgent` 这个状态容器一直活著，只是 `run_conversation`（`agent/conversation_loop.py:532`）的循环又转一遍。

## 6. 代码位置

- REPL 循环：`cli.py:11604` —— `HermesCLI.run()`，控制权返回后落回这里。
- 下一轮的对话循环入口：`agent/conversation_loop.py:532` —— 同一个 `while` 循环，下一轮再转一遍。

## 7. 分支与延伸

- 想再看一遍全景、对照 20 步速览与状态演化表 → [导览总览](tour-00-overview.md)
- 想从子系统的角度系统地学，而不是顺著一条 trace → [第 1 章 导论与全局架构](01-architecture-overview.md)
- 对话循环本身的完整机制（迭代预算、grace call、四层中断） → [第 3 章 核心对话循环](03-conversation-loop.md)
- 上一步的后台收尾任务 → [Trace 步骤 19](tour-19-post-turn.md)

## 8. 走完整条导览，你脑子里应该有的全景

1. **`hermes` 不过是十来行的加载器**——真正的入口是 `hermes_cli/main.py::main()`；从 shell 到 `AIAgent` 实例化，经过了脚本 → 参数分发 → `HermesCLI` → `_init_agent` 这条清晰的链（[步骤 01–04](tour-01-shell-entry.md)）。
2. **agent 的本质是一个同步的工具调用循环**：模型「想」→ 返回 `tool_call` →工具执行 →结果回灌 → 模型再「想」。本次 trace 触发了**两次 API 调用**夹**一次工具执行**——这就是 agent（[步骤 10–16](tour-10-first-api-call.md)）。
3. **「想」和「做」之间隔著三层契约**：工具必须先注册进 `ToolRegistry`、再出现在某个 toolset 里才会暴露给模型；handler 一律返回 JSON 字符串；危险动作过 `approval.py` 审批闸（[步骤 05、12、13](tour-05-tool-discovery.md)）。
4. **四层架构各司其职**：入口层把请求接进来并渲染出去；Agent 核心跑对话循环；模型与上下文层负责 provider 适配、凭证、压缩、持久化；工具与扩展层真正触碰外部世界。一次请求穿过全部四层，缺一层这趟 trace 就有一步是空的。
5. **状态分两种命运**：`messages` 留在内存让对话连续、写进 SQLite 让它可恢复；而每轮的临时标志（中断、计数器、流缓冲）逐轮复位。理解了「什么留、什么清」，就理解了 Hermes 为什么能既连续又干净。

---

回到起点：[导览总览](tour-00-overview.md) ｜ 深入子系统：[参考手册第 1 章](01-architecture-overview.md)
