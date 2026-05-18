# Trace 步骤 19 —— 这轮答完了，还有什么没做完？

## 1. 当前情境

上一步（[步骤 18](tour-18-session-persist.md)）结束时，这一轮问答的五条消息已经写进 `state.db`：`sessions` 表多了元数据计数，`messages` 表多了四行，两张 FTS5 索引也同步好了。`session_id` 已分配，会话从此可被 `/resume` 和 `session_search` 找到。

用户那边——他早在步骤 17 就看到答案了。从用户的视角，这次交互**已经结束**。

但 `run_conversation` 还没 `return`。在它把控制权交还给 REPL 之前，还夹着一小段代码。这段代码做的事用户完全感知不到，可它决定了一件长期的事：这条会话在 `/sessions` 列表里叫什么名字、agent 下次还记不记得用户说过什么。这一步就讲这段「收尾」。

## 2. 问题

一轮对话答完后，有两类「该做但不紧急」的事：

- **给会话起个名字。** `/sessions` 列表如果每条都显示成 `session-a3f8c1...`，用户根本认不出哪条是哪条。需要一个人类可读的短标题，比如「读取 README 首行」。标题得**根据对话内容**生成——而判断内容、概括主题，本身就是个 LLM 任务。
- **更新长期记忆。** 如果这轮对话里出现了值得长期记住的事实（用户的偏好、项目的约定），记忆系统要把它沉淀下来，下次对话才能回忆起来。

这两件事有三个共同的硬约束：

1. **绝不能拖慢用户。** 用户已经看到答案了。再花两三秒调一次 LLM 生成标题，如果是同步的，用户就得对着一个「已经答完」的界面干等——体验上等于凭空多了两秒延迟。
2. **绝不能污染主对话。** 这两件事如果借用**主模型**、复用**主对话的 prompt**来做，会把无关内容塞进主模型的上下文里。
3. **绝不能因为失败而阻断主流程。** 标题生成的 LLM 可能 402 余额耗尽，记忆后端可能离线。这些都是「锦上添花」，它们失败了用户的答案照样在。

## 3. 朴素思路

最直接的写法：`run_conversation` 在 `return` 之前，**同步地**多做两件事。

```python
# 朴素版：在返回前顺手做完
title = main_model.complete("给这段对话起个标题：" + str(messages))
session_db.set_session_title(session_id, title)
memory.sync(messages)
return result
```

复用手头已经有的主模型客户端、把整个 `messages` 丢给它——代码最短，不用引入新的 client、新的线程。看起来顺理成章。

## 4. 为什么朴素思路会崩

这段「顺手做完」踩中了上一节列的全部三个约束：

- **同步 = 凭空的延迟。** `main_model.complete(...)` 是一次完整的网络往返加模型推理，两三秒起步。它卡在 `return` 之前，用户就得对着已经显示完的答案多等两三秒，光标才会回到输入框。用户感知到的「这次问答耗时」凭空变长——而且变长的部分对他毫无价值。
- **复用主模型 = 污染 prompt cache。** Hermes 对主对话开了 prompt caching：系统提示 + 历史消息那一大段前缀被缓存，下一轮命中缓存能省下大量 token 和延迟。如果用主模型客户端、带着主对话的上下文去插一个「起标题」的请求，这个请求要么打乱缓存前缀的连续性，要么让缓存状态变得难以预测。一次几毛钱的标题生成，代价是污染了主对话每一轮都在吃的缓存红利。
- **同步 = 失败会阻断。** 标题生成的辅助模型 402 了、记忆后端连不上——如果这些调用同步嵌在返回路径上且没包好异常，一个「锦上添花」的失败就能把整个 `run_conversation` 拖进错误分支，甚至让用户那条已经显示出来的答案对应的流程报错。

核心矛盾：标题和记忆是**事后辅助任务**，但朴素思路把它们当成了**返回路径上的必经步骤**。位置错了。

## 5. Hermes 的做法

Hermes 的原则是一句话：**辅助任务全部异步、全部走辅助 LLM、全部 best-effort**。具体落成三件事。

### 标题生成：后台线程 + 辅助 LLM

在 CLI 路径上，主对话一返回，`cli.py:11161` 就调 `maybe_auto_title(...)`。注意它**只在第一轮**有意义——标题只需要起一次：

```python
# cli.py:11150 附近
if response and result and not result.get("failed") and not result.get("partial"):
    from agent.title_generator import maybe_auto_title
    maybe_auto_title(
        self._session_db, self.session_id,
        message, response, self.conversation_history,
        failure_callback=getattr(self.agent, "_emit_auxiliary_failure", None),
        main_runtime={"model": self.model, "provider": self.provider, ...},
    )
```

`maybe_auto_title`（`agent/title_generator.py:133`）先数一下历史里有几条 user 消息——只在头一两轮才继续，否则直接 `return`。然后它做的关键动作是**起一个 daemon 线程**，把活儿甩进去：

```python
# title_generator.py:160
thread = threading.Thread(
    target=auto_title_session,
    args=(session_db, session_id, user_message, assistant_response),
    kwargs={"failure_callback": ..., "main_runtime": ..., "title_callback": ...},
    daemon=True, name="auto-title",
)
thread.start()
```

`thread.start()` 之后函数立刻返回——主流程**一刻都没等**。真正的 LLM 调用 `generate_title`（`title_generator.py:29`）跑在那个后台线程里。它把首轮对话截短到各 500 字符，配一段固定的系统提示：

```python
# title_generator.py:22
_TITLE_PROMPT = (
    "Generate a short, descriptive title (3-7 words) for a conversation "
    "that starts with the following exchange. ... Return ONLY the title text."
)
```

然后调 `call_llm(task="title_generation", ...)`——这就是**辅助 LLM 客户端**（`agent/auxiliary_client.py`）。这一步是「不污染主 prompt cache」的关键：辅助调用走的是一个**独立的、最便宜最快的模型 + 全新的两条消息上下文**，跟主对话的缓存前缀完全不沾边。主模型那一大段被缓存的系统提示丝毫未动，下一轮照样命中。

拿到标题后线程自己把它写回 `sessions` 表（`set_session_title`）。整个 `generate_title` 包在 `try/except Exception` 里——辅助模型 402 了，就走 `failure_callback` 把一句警告递给用户（避免「会话静默无标题」这种沉默失败），主流程毫无影响。

### 记忆 sync：转折后异步镜像

记忆这一侧由 `run_conversation` 在返回前调 `agent._sync_external_memory_for_turn(...)` 触发（`conversation_loop.py:3973`）：

```python
# conversation_loop.py:3972
# External memory provider: sync the completed turn + queue next prefetch.
agent._sync_external_memory_for_turn(
    original_user_message=original_user_message,
    final_response=final_response,
    interrupted=interrupted,
)
```

这个方法（`run_agent.py:1955`）做两件事，都包在 `try/except` 里：

```python
# run_agent.py:1982
if interrupted:
    return                       # 被打断的轮次整轮跳过
if not (self._memory_manager and final_response and original_user_message):
    return
try:
    self._memory_manager.sync_all(
        original_user_message, final_response, session_id=self.session_id or "")
    self._memory_manager.queue_prefetch_all(
        original_user_message, session_id=self.session_id or "")
except Exception:
    pass                         # 外部记忆严格 best-effort
```

`sync_all`（`agent/memory_manager.py:317`）把这一轮的「用户说了什么 + agent 答了什么」推给每一个记忆 provider 去 `sync_turn`：

```python
def sync_all(self, user_content, assistant_content, *, session_id=""):
    for provider in self._providers:
        try:
            provider.sync_turn(user_content, assistant_content, session_id=session_id)
        except Exception as e:
            logger.warning("Memory provider '%s' sync_turn failed: %s", provider.name, e)
```

几个细节值得注意：

- **用 `original_user_message` 而不是 `user_message`。** 后者可能被注入过 skill 内容、nudge 提示——把那些东西写进长期记忆会污染未来的回忆。镜像进记忆的必须是用户**干净的原话**。
- **被打断的轮次整轮跳过**（`interrupted` 那行 `return`）。一次中途被 `Ctrl-C` 打断的对话不是「可信的对话事实」，把它写进记忆会让未来的回忆带上用户从没看到完成的状态。
- **provider 内部各自决定是否异步落库。** 记忆后端把这次 `sync_turn` 当成一个待处理事件——是不是「转折」（话题切换、值得沉淀的点）由 provider 判断，真正的写库往往在它自己的后台线程里完成。`queue_prefetch_all` 同理：它顺手为**下一轮**预热记忆检索的上下文。
- **整段包 `try/except Exception` 且 `pass`。** 记忆 provider 配错了、离线了，绝不能挡住用户拿到响应——注释把这条说得很直白。

### 记忆 nudge 计数：本轮只是「加一」

「记忆 nudge」是另一个机制：每隔 N 轮，提示主模型主动回顾一下要不要存点东西。它的计数在**本轮开头**就推进了——`conversation_loop.py:286` 附近：

```python
if (agent._memory_nudge_interval > 0
        and "memory" in agent.valid_tool_names
        and agent._memory_store):
    agent._turns_since_memory += 1
    if agent._turns_since_memory >= agent._memory_nudge_interval:
        _should_review_memory = True
        agent._turns_since_memory = 0
```

我们这次 trace 是头一轮，`_turns_since_memory` 从 0 加到 1，远没到阈值——所以 `_should_review_memory` 是 `False`，这轮**不触发**记忆回顾。`conversation_loop.py:3981` 那个后台 review 分支因此被跳过。计数留在 1，等着以后某一轮累积到阈值再说。

把收尾这一段串起来：

<svg viewBox="0 0 800 450" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="post-turn auxiliary tasks dispatch flow">
  <defs>
    <marker id="t19ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="20" width="300" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="40" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">run_conversation 即将 return（消息已落盘）</text>
  <line x1="400" y1="52" x2="400" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t19ar)"/>
  <rect x="80" y="76" width="640" height="98" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="98" y="98" font-size="12" font-weight="700" fill="currentColor">_sync_external_memory_for_turn()　conversation_loop.py:3973</text>
  <text x="116" y="120" font-size="11" fill="#64748b">└ MemoryManager.sync_all() → 各 provider.sync_turn() → 转折判定 → 后台写库</text>
  <text x="116" y="140" font-size="11" fill="#64748b">└ queue_prefetch_all() → 为下一轮预热</text>
  <text x="116" y="162" font-size="11" fill="#94a3b8">后台 review 分支：_should_review_memory == False（本轮计数=1）→ 跳过</text>
  <line x1="400" y1="174" x2="400" y2="196" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t19ar)"/>
  <rect x="280" y="198" width="240" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="218" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">return result → 控制权回到 CLI</text>
  <line x1="400" y1="230" x2="400" y2="252" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t19ar)"/>
  <rect x="200" y="254" width="400" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="400" y="276" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">cli.py:11161　maybe_auto_title()</text>
  <line x1="400" y1="288" x2="400" y2="310" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t19ar)"/>
  <rect x="180" y="312" width="440" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="400" y="332" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">threading.Thread(daemon, "auto-title").start() ← 立刻返回</text>
  <line x1="400" y1="344" x2="400" y2="366" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#t19ar)"/>
  <rect x="130" y="368" width="540" height="72" rx="8" fill="#f1f5f9" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="148" y="390" font-size="12" font-weight="700" fill="currentColor">后台线程：generate_title()　title_generator.py:29</text>
  <text x="166" y="412" font-size="11" fill="#64748b">└ call_llm(task="title_generation") ← 辅助 LLM，独立模型 + 全新上下文</text>
  <text x="166" y="430" font-size="11" fill="#64748b">└ session_db.set_session_title()</text>
</svg>
<span class="figure-caption">图 T19.1 ｜ 收尾任务派发：记忆 sync 与标题生成全部异步、走辅助 LLM，主流程不为它们等待。</span>

<details>
<summary>ASCII 原版</summary>

```text
run_conversation 即将 return（消息已落盘，见步骤 18）
        │
        ├─ _sync_external_memory_for_turn()      conversation_loop.py:3973
        │     └─ MemoryManager.sync_all()        memory_manager.py:317
        │           └─ 各 provider.sync_turn()  → 转折判定 → provider 后台写库
        │     └─ queue_prefetch_all()            → 为下一轮预热
        │
        ├─ 后台 review 分支：_should_review_memory == False（本轮才计数=1）→ 跳过
        │
        └─ return result  ──────────────┐
                                        │
        控制权回到 CLI                    ▼
        cli.py:11161  maybe_auto_title()
              └─ threading.Thread(daemon, "auto-title").start()  ← 立刻返回
                     │
                     └─ 后台线程: generate_title()  title_generator.py:29
                           └─ call_llm(task="title_generation")  ← 辅助 LLM
                                  独立模型 + 全新上下文 → 不碰主 prompt cache
                           └─ session_db.set_session_title()
```

</details>

到这一步结束：记忆 sync 与标题生成都已**派发到后台**，在各自的线程里跑；主流程没有为它们等过一毫秒。`run_conversation` 已经 `return`，控制权正在回到 CLI。

## 6. 代码位置

按阅读顺序：

- 记忆 sync 触发点：`agent/conversation_loop.py:3973` —— `agent._sync_external_memory_for_turn(...)`。
- 记忆镜像实现：`run_agent.py:1955` —— `_sync_external_memory_for_turn()`，`interrupted` 跳过在 `:1982`，`sync_all` + `queue_prefetch_all` 在 `:1987`。
- 多 provider 分发：`agent/memory_manager.py:317` —— `sync_all()`，循环每个 provider 调 `sync_turn`。
- 记忆 nudge 计数：`agent/conversation_loop.py:286` 附近 —— `_turns_since_memory += 1` 与阈值判断；后台 review 分支在 `:3981`。
- 标题生成触发：`cli.py:11161` —— 主对话返回后调 `maybe_auto_title(...)`。
- 标题派发：`agent/title_generator.py:133` —— `maybe_auto_title()`，首轮判定在 `:156`，`threading.Thread(daemon, "auto-title")` 在 `:160`。
- 标题 LLM 调用：`agent/title_generator.py:29` —— `generate_title()`，固定提示 `_TITLE_PROMPT` 在 `:22`，`call_llm(task="title_generation")` 在 `:57`。
- 辅助 LLM 客户端：`agent/auxiliary_client.py` —— `call_llm()`，所有非主对话的小型 LLM 任务都走这里。

## 7. 分支与延伸

- 辅助 LLM 为什么是一套独立于主模型的客户端、它怎样挑「最便宜最快」的模型、为什么把它和主对话隔离能保住 prompt cache → [第 7 章 §辅助 LLM](07-model-providers.md)。
- 记忆系统的全貌——provider 架构、`sync_turn` 里的「转折判定」、`prefetch` 如何在下一轮转折前把记忆喂回上下文、记忆 nudge 的完整触发逻辑 → [第 10 章 记忆系统](10-memory-system.md)。
- 上一步会话与消息怎样落进 SQLite、`session_id` 在哪分配 → [Trace 步骤 18](tour-18-session-persist.md)。
- 后台任务派发完之后，`run_conversation` 返回，控制权一路回到 REPL 循环顶 → [Trace 步骤 20](tour-20-back-to-repl.md)。

## 8. 走完这一步你脑子里应该多了什么

1. 一轮对话真正「结束」之后还有一段**收尾**：起会话标题、把这轮镜像进长期记忆——用户感知不到，但它决定了会话列表的可读性和 agent 的长期记性。
2. 收尾任务全部**异步**：标题生成被甩进一个 `daemon` 线程，记忆 sync 交给 provider 自己的后台。主流程一毫秒都不等——因为用户早就看到答案了，让他为锦上添花的事干等就是凭空的延迟。
3. 收尾任务全部走**辅助 LLM**（`auxiliary_client.call_llm`），不碰主模型。这是为了**不污染主对话的 prompt cache**：辅助调用用独立的廉价模型 + 全新上下文，主对话那段被缓存的前缀丝毫不动。
4. 收尾任务全部 **best-effort**：包在 `try/except` 里，被打断的轮次整轮跳过，记忆用的是用户**干净的原话**而非注入过 skill/nudge 的版本——失败或脏数据绝不能阻断主流程、也不能污染未来回忆。
5. 记忆 nudge 是**计数器驱动**的：本轮（首轮）只是把 `_turns_since_memory` 从 0 加到 1，远未达阈值，所以这轮不触发记忆回顾——攒够轮数才会。

---

下一步：[Trace 步骤 20 —— 回到 REPL，一轮完成](tour-20-back-to-repl.md)
