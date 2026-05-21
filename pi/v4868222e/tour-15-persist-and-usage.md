# Tour 步骤 15:流结束 -> JSONL 写盘 + usage 统计

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:第二轮 stream 已完成,`assistant_2` 消息(`stopReason: "end_turn"`)已追加到 `currentContext.messages`,`runLoop` 检测到 `hasMoreToolCalls = false` 且无挂起 steering/follow-up 消息,发出 `turn_end` 事件,随后发出 `agent_end` 事件。

**下一步起点**:JSONL 已落盘,usage 已记账,`phase` 已归 `"idle"`。事件流仍在向 `InteractiveMode` 推送 `agent_end`,UI 即将把 loading 动画移除并让输入框重新可用。

---

## 1. 当前情境

`agent_end` 事件从 `runLoop` 发出(`agent-loop.ts:268`),经由 `AgentHarness.handleAgentEvent` 处理。调用链是:

```
runLoop (agent-loop.ts)
  emit({ type:"agent_end", messages:newMessages })
  └─ AgentHarness.handleAgentEvent (agent-harness.ts:483)
       └─ 落盘逻辑 + phase 归位 + settled 事件
```

此时 `session` 对象的 `phase` 字段仍为 `"turn"`,`pendingSessionWrites` 中积累了若干待写条目:每次 `message_end` 到来时,`handleAgentEvent` 就已经调用 `session.appendMessage` 写入那条消息(`agent-harness.ts:485`),但若 harness 处于 `turn` 阶段中途发生了 model 切换或 thinking level 切换,这些操作会被缓冲进 `pendingSessionWrites` 而不是立即落盘。

---

## 2. 问题

本步需要回答三个具体问题:

1. **每条消息(user、assistant、toolResult)各在什么时机写入 JSONL 文件**,是 turn 结束后批量写还是实时追加。

2. **usage 数据(input/output tokens、cache hit、cost)存储在哪里**,agent loop 结束后如何把它们汇总。

3. **`shouldCompact` 何时求值、阈值是多少**,本次 trace 不触发压缩的原因是什么。

---

## 3. 朴素思路

最简单的做法:turn 全部结束后,把 `newMessages` 一次性序列化成 JSON 写到文件末尾。这样实现简单,但如果进程在 turn 中途崩溃,当前 turn 所有内容都丢失——用户会看到空会话。

---

## 4. 为什么朴素思路会崩

pi 的会话需要支持 `--resume`。若进程崩溃时 JSONL 只有 session header 而没有任何消息,用户恢复后看到的是一个空会话,但磁盘上的文件也没有任何有价值的 debug 信息。

更严重的问题是:多轮工具调用中,每次 tool_result 写入后,若下一次 LLM 调用崩溃,JSONL 应当已经包含那次 tool_result,这样恢复会话时历史是完整的。因此需要"收到即落盘"。

---

## 5. pi 的做法

**实时追加:message_end 触发立即写盘**

`AgentHarness.handleAgentEvent`(`agent-harness.ts:483-510`) 的关键逻辑:

```typescript
// agent-harness.ts:484-487
if (event.type === "message_end") {
    await this.session.appendMessage(event.message);
    await this.emitAny(event, signal);
    return;
}
```

每次 `message_end` 到来——不管是 user、assistant 还是 toolResult——都调用 `session.appendMessage`。该方法最终走到 `JsonlSessionStorage.appendEntry`(`packages/agent/src/harness/session/jsonl-storage.ts:250-258`):

```typescript
// jsonl-storage.ts:250-258
async appendEntry(entry: SessionTreeEntry): Promise<void> {
    getFileSystemResultOrThrow(
        await this.fs.appendFile(this.filePath, `${JSON.stringify(entry)}\n`),
        `Failed to append session entry ${entry.id}`,
    );
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.currentLeafId = leafIdAfterEntry(entry);
}
```

`appendFile` 是追加写,每条消息一行 JSON,与 JSONL 格式完全对应。对于本次 trace,消息写入的时序是:

```
message_end(user)         -> JSONL line 2
message_end(assistant_1)  -> JSONL line 3  (含 tool_use block)
message_end(toolResult)   -> JSONL line 4
message_end(assistant_2)  -> JSONL line 5  (最终文本)
```

**turn_end:冲刷挂起写操作**

`handleAgentEvent`(`agent-harness.ts:489-500`) 对 `turn_end` 的处理:

```typescript
// agent-harness.ts:489-500
if (event.type === "turn_end") {
    let eventError: unknown;
    try {
        await this.emitAny(event, signal);
    } catch (error) {
        eventError = error;
    }
    const hadPendingMutations = this.pendingSessionWrites.length > 0;
    await this.flushPendingSessionWrites();
    if (eventError) throw eventError;
    await this.emitOwn({ type: "save_point", hadPendingMutations });
    return;
}
```

`flushPendingSessionWrites`(`agent-harness.ts:459-481`) 逐条处理 `pendingSessionWrites` 队列——model 切换、thinking level 切换等 turn 内元数据变更都在此时落盘。落盘完成后发出 `save_point` 事件,上层可用它做 checkpoint 标记。

**agent_end:phase 归位 + settled**

`handleAgentEvent`(`agent-harness.ts:502-509`):

```typescript
// agent-harness.ts:502-509
if (event.type === "agent_end") {
    await this.flushPendingSessionWrites();
    this.phase = "idle";
    await this.emitAny(event, signal);
    await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
    return;
}
```

`phase = "idle"` 解除 harness 的"忙"锁定,后续可以接受新的 `prompt()` 调用。`settled` 事件携带 `nextTurnQueue.length`,让订阅者知道是否还有待处理的排队消息。

**usage 统计**

usage 数据随 `AssistantMessage` 的 `usage` 字段一起写入 JSONL。`assistant_2` 的 usage 字段结构如下(来自 Anthropic API 响应):

```typescript
// packages/ai/src/types.ts (AssistantMessage.usage)
{
    input: number,      // 本次请求输入 tokens(含缓存读)
    output: number,     // 输出 tokens
    cacheRead: number,  // 从 prompt cache 读取的 tokens
    cacheWrite: number, // 写入 prompt cache 的 tokens
    totalTokens: number,
    cost: { input, output, cacheRead, cacheWrite, total }
}
```

`AgentSession`(`coding-agent`) 层通过订阅 `agent_end` 事件,从最后一条 `AssistantMessage` 读取 usage 并更新 `FooterDataProvider`,状态栏的 token 计数随之更新。

**shouldCompact 检查**

compaction 的触发条件定义于 `packages/agent/src/harness/compaction/compaction.ts:196-199`:

```typescript
// compaction.ts:196-199
export function shouldCompact(
    contextTokens: number,
    contextWindow: number,
    settings: CompactionSettings,
): boolean {
    if (!settings.enabled) return false;
    return contextTokens > contextWindow - settings.reserveTokens;
}
```

`DEFAULT_COMPACTION_SETTINGS`(`compaction.ts:112-116`)中 `reserveTokens = 16384`。本次 trace 的消息极短(user: 约 10 tokens,两次 assistant: 约 200 tokens,toolResult: 约 50 tokens),总计不超过 300 tokens,远低于任何模型的 context window(claude-3-5-sonnet 为 200k tokens)。因此 `shouldCompact` 返回 `false`,不触发压缩。若 context 达到阈值则会进入 `compact()` 流程。

<svg viewBox="0 0 760 480" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="持久化与 usage 统计:message_end 写盘到 agent_end 归位">
  <defs>
    <marker id="arT15" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker>
  </defs>
  <rect width="760" height="480" fill="#f8fafc" rx="6"/>
  <text x="380" y="26" text-anchor="middle" font-size="14" font-weight="600" fill="#1e293b">持久化与 usage 统计流程</text>
  <rect x="60" y="44" width="640" height="90" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="62" text-anchor="middle" font-size="11" font-weight="600" fill="#475569">message_end 事件写盘 (appendFile → JSONL)</text>
  <rect x="80" y="70" width="280" height="24" rx="3" fill="white" stroke="#cbd5e1"/>
  <text x="220" y="86" text-anchor="middle" font-size="9" fill="#64748b">message_end(user)        → line 2</text>
  <rect x="390" y="70" width="290" height="24" rx="3" fill="white" stroke="#cbd5e1"/>
  <text x="535" y="86" text-anchor="middle" font-size="9" fill="#64748b">message_end(assistant_1) → line 3</text>
  <rect x="80" y="98" width="280" height="24" rx="3" fill="white" stroke="#cbd5e1"/>
  <text x="220" y="114" text-anchor="middle" font-size="9" fill="#64748b">message_end(toolResult)  → line 4</text>
  <rect x="390" y="98" width="290" height="24" rx="3" fill="white" stroke="#cbd5e1"/>
  <text x="535" y="114" text-anchor="middle" font-size="9" fill="#64748b">message_end(assistant_2) → line 5</text>
  <line x1="380" y1="134" x2="380" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT15)"/>
  <rect x="180" y="158" width="400" height="28" rx="5" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/>
  <text x="380" y="176" text-anchor="middle" font-size="11" font-weight="600" fill="#92400e">turn_end</text>
  <line x1="380" y1="186" x2="380" y2="208" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT15)"/>
  <rect x="60" y="208" width="640" height="70" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="80" y="228" font-size="9" fill="#64748b">emitAny(turn_end) → 扩展 hooks 执行(只读 metrics)</text>
  <text x="80" y="246" font-size="9" fill="#64748b">flushPendingSessionWrites() → 写 model/thinking_level 变更(若有)</text>
  <text x="80" y="264" font-size="9" fill="#64748b">emitOwn(save_point)  → checkpoint 标记</text>
  <line x1="380" y1="278" x2="380" y2="302" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT15)"/>
  <rect x="180" y="302" width="400" height="28" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="320" text-anchor="middle" font-size="11" font-weight="600" fill="#9a3412">agent_end</text>
  <line x1="380" y1="330" x2="380" y2="352" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT15)"/>
  <rect x="60" y="352" width="640" height="72" rx="6" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="80" y="372" font-size="9" fill="#64748b">flushPendingSessionWrites()  (再次清空,防止遗漏)</text>
  <text x="80" y="390" font-size="9" fill="#64748b">phase = "idle"  → 解除 harness 忙锁</text>
  <text x="80" y="407" font-size="9" fill="#64748b">emitAny(agent_end) → InteractiveMode.handleEvent(agent_end)</text>
  <text x="80" y="422" font-size="9" fill="#64748b">emitOwn(settled, nextTurnCount=0)</text>
  <line x1="380" y1="424" x2="380" y2="448" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#arT15)"/>
  <rect x="200" y="448" width="360" height="26" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="465" text-anchor="middle" font-size="11" font-weight="600" fill="#134e4a">JSONL 完整:5 行 (header + 4 messages)</text>
</svg>
<span class="figure-caption">图 T15.1 ｜ message_end 写盘 → turn_end flush → agent_end 归位的完整持久化路径</span>

<details>
<summary>ASCII 原版</summary>

```
message_end(user)        -> appendFile(JSONL, line 2)
message_end(assistant_1) -> appendFile(JSONL, line 3)
message_end(toolResult)  -> appendFile(JSONL, line 4)
message_end(assistant_2) -> appendFile(JSONL, line 5)
    |
turn_end
    |
    +-- emitAny(turn_end) -> 扩展 hooks 执行(只读 metrics)
    +-- flushPendingSessionWrites() -> 写 model/thinking_level 变更(若有)
    +-- emitOwn(save_point)
    |
agent_end
    |
    +-- flushPendingSessionWrites() (再次清空,防止遗漏)
    +-- phase = "idle"
    +-- emitAny(agent_end) -> InteractiveMode.handleEvent(agent_end)
    +-- emitOwn(settled, nextTurnCount=0)
    |
    v
JSONL 完整:5 行 (header + 4 messages)
```

</details>

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/agent/src/harness/agent-harness.ts` | 483-509 | `handleAgentEvent`:message_end/turn_end/agent_end 分支 |
| `packages/agent/src/harness/agent-harness.ts` | 459-481 | `flushPendingSessionWrites`:冲刷待写队列 |
| `packages/agent/src/harness/session/jsonl-storage.ts` | 250-258 | `appendEntry`:追加写 JSONL 单行 |
| `packages/agent/src/harness/session/jsonl-storage.ts` | 191-213 | `create`:写 session header 行 |
| `packages/agent/src/harness/compaction/compaction.ts` | 112-116 | `DEFAULT_COMPACTION_SETTINGS` |
| `packages/agent/src/harness/compaction/compaction.ts` | 196-199 | `shouldCompact` 函数 |
| `packages/agent/src/harness/compaction/compaction.ts` | 119-121 | `calculateContextTokens`:从 usage 计算总 tokens |

---

## 7. 分支与延伸

- **JSONL 文件格式与 session header 结构**:见 [第 06 章 §6.2「JSONL 存储格式」](./06-agent-runtime-sessions-compaction.md#62-jsonl-存储格式)。

- **Compaction 触发条件与压缩流程**:见 [第 06 章 §6.4「Compaction:上下文压缩」](./06-agent-runtime-sessions-compaction.md#64-compaction上下文压缩)。

- **扩展系统的 turn_end hook 与 save_point 事件**:见 [第 09 章 §9.3「生命周期钩子:turn_end 与 save_point」](./09-coding-agent-extensions.md#93-生命周期钩子turn_end-与-save_point)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **消息落盘是"收到即写"而非"turn 结束后批写"**:`message_end` 事件到来时立即调用 `appendFile`,每条消息独占一行。进程在任意 `message_end` 之后崩溃,JSONL 都包含已到达的消息,`--resume` 可以正确重建历史。

2. **pendingSessionWrites 是 turn 内"元数据变更"的缓冲区**:model 切换、thinking level 切换发生在 turn 进行时,不能立即落盘(因为落盘后 session 内容与内存状态不一致),所以先排队,在 `turn_end` 和 `agent_end` 时统一冲刷。

3. **usage 随 AssistantMessage 一起持久化**:不需要单独的 usage 文件。`--resume` 后 pi 可以从 JSONL 里最后一条 assistant 消息读取 usage 字段,重建 token 计数。

4. **shouldCompact 是事后检查而非预防机制**:它在 `turn_end` 阶段计算当前 context window 使用量,超过阈值才触发。对本次 trace 这条极短会话,远不会触发压缩。

5. **phase = "idle" 是解锁信号**:`AgentHarness.prompt()` 入口检查 `this.phase !== "idle"`,如果 harness 还在 `"turn"` 阶段就会抛 `AgentHarnessError("busy")`。`agent_end` 处理完后 `phase` 归 `"idle"`,下一条用户消息才能被处理。
