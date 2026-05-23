# Trace 步骤 14 —— 持久化与事件广播

## 1. 当前情境

上一步（第 13 步）里，assistant 的最后一片 text Part 已经在 `SessionProcessor` 内被合并到 part.text，时间戳 `time.end` 已经盖上，`finishReason = "stop"` 收尾。第二次 LLM 调用的 stream 也已经吐完最后一个 chunk，`isStreaming` 这个语义状态从内部视角看已经结束。

但是——你脑子里有可能误以为"流结束才统一写盘"。事实并非如此：每一片 text delta、每一次 tool_use、每一次 tool_result，从第 07 步到第 13 步之间**已经在不断写库 + 广播事件**了。本步骤要把这个"每次更新都走完一遍 SQLite + bus"的机制讲透。

从可见状态角度看，进入本步骤时：

- `MessageTable` 里有 user 消息（第 05 步落的）和 assistant 消息（第 08 步落的）。
- `PartTable` 里至少有 6 行：user 的 text part、assistant 的 step-start、tool_use（read）、step-finish、tool_result、再 step-start，加上最终的 text part。
- `SessionTable` 的 `cost / tokens_input / tokens_output / tokens_cache_read / tokens_cache_write / tokens_reasoning` 这几列已经被两次 `step-finish` 累加过了（一次第一轮 LLM 完成、一次第二轮 LLM 完成）。
- bus 上发过的事件列表包括 `session.created`、`message.updated` × 2、`message.part.updated` × 7+、`session.status` × 2（busy → ...）。

本步骤的视角是：把 "Session.updatePart / Session.updateMessage 一次调用" 当成单元，看它穿过 `SyncEvent.run` → projector 写库 → bus.publish → SSE 推流的整条链路。

## 2. 问题

CLI agent 这种东西**有三个看似不冲突、其实严重打架**的客户端形态：

1. **本进程内的 run CLI**（也就是本 trace 的角色）需要把 part delta 打到 stdout。
2. **同一进程内的 TUI**（用户选择 `opencode` 不带子命令时）需要重渲染消息流。
3. **外部进程的 web / desktop / VS Code 插件**通过 HTTP SSE 连本进程的 server，需要近实时拿到一样的事件。

更糟糕的是数据访问者还多了一份：

4. **历史回看 / fork / resume / stats**——这些功能用的是 SQL 查询，不能依赖事件，必须从持久化层读。

如果"写库"和"发事件"不是同一个原子动作，就会出现：客户端 A 拿到了"part 更新了" 的事件，立刻 GET /session/X/messages 查持久化态，结果库还没写，查到老数据。或者反过来——某个客户端断了几秒重连，期间事件丢了，但库里已经写完了，重连后却没有任何信号让它去 reconcile。

## 3. 朴素思路

最朴素的写法两步走：

```ts
// pseudo
function onPartChanged(part) {
  db.upsert(PartTable, part)        // 1. 写库
  bus.publish("message.part.updated", { part })  // 2. 发事件
}
```

直观且直觉上"分别成功"也没什么问题，反正都是本进程内同步调用。开发新功能的时候，谁要加新事件就在自己的 handler 里多加一行 `bus.publish`。

## 4. 为什么朴素思路会崩

把"写库"和"发事件"分成两个独立调用，至少有四个失败模式：

1. **写库失败但事件已发**：第二行先执行成功了，第一行 SQL 抛了 `SQLITE_CONSTRAINT_FOREIGNKEY`（message 还没建就先插 part 这种 race），所有订阅者都以为更新发生了，但库里没有；后续 `Session.messages` 查回来时这一片不存在，客户端 UI 出现"幽灵 part"。
2. **写库成功但事件未发**：bus 在那一刻 GC 出问题、scope 被释放、内部 PubSub 满了，没人通知客户端。库里悄悄变了，UI 永远停在老状态。
3. **没有版本号 / 序列号**：客户端断线重连无法知道"我错过了几条事件"。对于"流式 text delta"这种最高频事件，丢一条就少一段话，无法靠"查库重建"补偿，因为 text part 在落库时只保存最终态，delta 历史没了。
4. **多种事件、各发各的**：随着功能膨胀，每个 handler 都自己写 `db.upsert + bus.publish`，事件名拼错、顺序写反、漏发都成日常 bug，没有任何一处能集中校验。

更深一层的问题：opencode 用 **CQRS** 风格——"事件"是真相、"表"是这个事件流应用到 reducer 之后的状态投影。这种语义下，绝不能允许"事件发出了但状态没更新"，也不能允许"状态更新了但没事件"。

## 5. opencode 的做法

opencode 把这件事抽成 `SyncEvent` 系统（`packages/opencode/src/sync/index.ts`），核心是 `SyncEvent.run(def, data)` 这个统一入口。一次调用做四件事，**全部在同一个 `Database.transaction({ behavior: "immediate" })` 内**：

1. **分配 eventID + seq**：从 `EventSequenceTable` 拿到这个 aggregate（session 或别的根实体）的当前序号，自增 1。
2. **跑 projector**：根据 event type 找到注册的投影函数（`session/projectors.ts:99-198`），让它在同一 tx 内对 `SessionTable / MessageTable / PartTable` 做 upsert / delete。
3. **可选：写 `EventTable`**：在 `experimentalWorkspaces` 模式下持久化事件流本身（默认关，本 trace 不展开）。
4. **挂一个 `Database.effect()` 回调**：在 tx commit 后再 fork 一个 fiber 调 `Bus.publish(def, ...)`，并同时给 `GlobalBus.emit('event', ...)`（跨 instance 转发）。

关键的设计选择全在这里：

- **immediate transaction**：SQLite 的 BEGIN IMMEDIATE 立刻拿到写锁，避免两个 fiber 并发 read-then-write 的 lost update。`sync/index.ts:154-170` 的注释解释了为什么必须是 immediate 而不是默认的 deferred：projector 内部要先 read 再 write（比如 cost 累加），deferred 模式下两个并发 prompt 会撞车。
- **事件在 tx 内排序**：seq 是 aggregate 范围内的单调递增；客户端可以靠 `(aggregateID, seq)` 判断"我有没有漏"。
- **publish 是 commit 之后的 side effect**：`Database.effect()` 注册的 callback 在 tx 真正落盘后才执行（`storage/db.ts:169-176`）。机制上靠 `LocalContext` 这个 fiber-local context：tx 调用栈进入时把 `effects: []` 推进 ctx，出栈时遍历 effects 数组同步执行。意味着任何收到 bus 事件的订阅者去查库，**保证**能查到最新态。这一条不变式是整个分布式 UI 的基石。
- **WAL 模式：读不阻塞写**：`storage/db.ts:104` 启动时 `PRAGMA journal_mode = WAL`，让 reader fiber（比如 `Session.messages` 查询）和 writer fiber（`SyncEvent.run`）能并发，不会卡 SSE handler。
- **bus 是 in-process PubSub，server 用一个 wildcard 订阅 + SSE 编码桥到 HTTP**：`bus/index.ts:135-142` 提供 `subscribeAll()`；server 的 `/event` handler 在 `server/routes/instance/httpapi/handlers/event.ts:21-54` 拿到这个 stream 后用 `Sse.encode()` 转成 `text/event-stream`。
- **bus 有两种 PubSub：typed + wildcard**：`bus/index.ts:30-32` 的 State 同时维护 `typed: Map<string, PubSub>` 和 `wildcard: PubSub`；`publish` 时往两边各推一份（`:106-108`）。typed 给精确订阅（比如 TUI 只想要 `message.part.updated`），wildcard 给 SSE 这种全量转发场景。
- **`Session.updatePart` 是面向调用方的薄包装**：在 `session/session.ts:624-632`，它只是把数据交给 `SyncEvent.run(MessageV2.Event.PartUpdated, {...})`，所有累加 / 写表 / 发事件全都委托给 sync 子系统。这种"面向 sync 的统一入口"是 opencode 后期重构 v1 → v1.15 的成果——更早的版本里写库和发事件是分散在各个 service 的。

对于 cost / tokens 这种"聚合字段"，写库的位置不在 step-finish handler，而在 **PartUpdated projector 内部**：`session/projectors.ts:173-196` 拿到 part 对象后，如果 `part.type === "step-finish"`，会调 `applyUsage` 给 `SessionTable.cost` / `tokens_*` 用 SQL 的 `${SessionTable.cost} + ${value.cost}` 累加（`projectors.ts:32-45`）。这样的好处是——删除一条 step-finish part（fork / revert / undo 都会发生）时，projector 自动用 `sign = -1` 把它扣掉，账永远是对的。本 trace 里两次 step-finish part 各加了一次：第一次 LLM 调用结束累加首轮 token、第二次 LLM 调用结束累加 final answer token。当 `opencode stats` 在未来某天读这一行（`cli/cmd/stats.ts:84`），看到的就是这两笔的总和。

还有一点关于 Session 表本身的 update 路径：除了 cost/tokens 累加，Session 还有 `title` / `time_updated` 这类需要随 prompt 变化的字段——这些通过 `Session.Event.Updated`（`session/session.ts:340-345`）单独走一遍 sync run；对应的 projector 在 `projectors.ts:110-119`，注意它**保留** `time_updated` 不动（`set({ time_updated: sql\`\${SessionTable.time_updated}\`, ...patch })`），这是为了让"流式 part 反复触发 Session.Updated"不会让 updated 时间戳到处跳。所有"什么时候真的算 updated"的语义都集中在这一行。

把所有信息串起来，本次 trace 在第 13 步收尾时，最后一片 text part 被 `Session.updatePart` 处理的过程是：

```
session.updatePart(textPart)
  └─ sync.run(MessageV2.Event.PartUpdated, { sessionID, part, time })
       └─ Database.transaction(behavior: "immediate", tx => {
              projector(tx, data)           // upsert PartTable
              // 这一次 part 是 type=text，没有 cost/tokens；不动 SessionTable
              Database.effect(() => {       // tx commit 后才跑：
                  bus.publish(PartUpdated, ...)
                  GlobalBus.emit('event', ...)
              })
          })
```

之后这条事件穿过：

- `bus.publish` → 进程内所有 subscriber，包括 server 的 SSE handler 持有的 `subscribeAll()` stream。
- `GlobalBus.emit` → 用 Node `EventEmitter` 跨 InstanceState 转发，给那些跨 instance 看事件的订阅者（比如 `desktop` GUI）。
- SSE handler 把 payload 序列化成 `data: {"type":"message.part.updated", ...}\n\n` 推给所有连着 `/event` 的 HTTP 客户端。

而本 trace 里，run CLI 自己就是这些客户端之一——它通过 SDK 连了进程内嵌 server，订阅 `/event`。下一步（第 15 步）就讲它怎么把这条 SSE 转回 stdout。

## 6. 代码位置

按数据流方向：

- `packages/opencode/src/session/session.ts:618-632` —— `Session.updateMessage` / `Session.updatePart`：薄薄两个调用，全都委托给 sync。
- `packages/opencode/src/sync/index.ts:136-171` —— `SyncEvent.run`：分配 seq、起 immediate tx、跑 projector、挂 effect。
- `packages/opencode/src/sync/index.ts:293-374` —— `process()` 与 `Database.effect(() => publish(...))`：commit 后的发布。
- `packages/opencode/src/storage/db.ts:155-198` —— `Database.use` / `transaction` / `effect`：基于 `LocalContext` 的 tx 上下文；`effect` 就是把回调延迟到 tx 出栈后执行。
- `packages/opencode/src/storage/db.ts:95-140` —— `Database.Client()`：单例 SQLite 连接，启动时 `PRAGMA journal_mode = WAL` / `synchronous = NORMAL` / `busy_timeout = 5000`。WAL 模式让"读不阻塞写"，对边写边订阅的场景至关重要。
- `packages/opencode/src/session/projectors.ts:99-198` —— 投影函数注册表：Session.Created / Updated / Deleted、MessageV2 各种事件、`PartUpdated` 在 `:173-196` 同时管 part 存表和 SessionTable cost/tokens 累加。
- `packages/opencode/src/session/projectors.ts:32-45` —— `applyUsage`：用 SQL 表达式做"原子加减"，避免 read-then-write race。
- `packages/opencode/src/session/session.sql.ts:36-41` —— `SessionTable.cost / tokens_*` 列定义。
- `packages/opencode/src/bus/index.ts:100-121` —— `publish`：在 typed PubSub 和 wildcard PubSub 上各发一份，再 GlobalBus.emit 转发跨进程。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:21-54` —— `/event` SSE handler：`bus.subscribeAll()` → `Sse.encode()` → HTTP body。
- `packages/opencode/src/server/projectors.ts:8-26` —— `initProjectors()`：装上 session projectors，并注入 `convertEvent`——bus 上发的 `session.updated` 事件 payload 会被 `Session.fromRow(row)` 改写成"读模型快照"，让客户端不用再二次查库。
- `packages/opencode/src/server/init-projectors.ts:1-3` —— 仅一行 `import { initProjectors }; initProjectors()`：server 模块加载时就立刻调用，确保 projector 表早于任何 `SyncEvent.run` 准备好。

## 7. 分支与延伸

- **流式 Part 在 storage 层为什么不是末尾批量写**：见 [第 03 章 §流式 Part 与增量更新](03-session-and-messages.md#流式-part-与增量更新)；那里讲了 `PartUpdated` 和 `PartDelta` 这两个事件的语义对比——前者是"已写库的态"，后者是"还没落库的中间 token 增量"。
- **Storage façade 上还有 file-based 实现吗**：见 [第 03 章 §Storage 抽象](03-session-and-messages.md#storage-抽象)；本 trace 走的是 SQLite 路径，旧的 JSON Storage 已经只在测试和迁移代码里出现。
- **SSE 这条管道服务谁**：见 [第 10 章 §10.5 SSE：实时事件流](10-server.md#105-sse实时事件流)、[§10.6 Projector：CQRS 风的读模型](10-server.md#106-projector-cqrs-风的读模型)。
- **cost / token 拿了之后给谁看**：见 [第 13 章 §13.7 成本统计](13-advanced-features.md#137-成本统计) 和它讲的 `opencode stats`——后者就是直接读 `SessionTable.cost` / `tokens_*` 列出报表。
- **EventV2 / Sync Event 名词解释**：见 [第 14 章 §EventV2 / Sync Event](14-glossary-and-faq.md#eventv2--sync-event)。
- **bus 在 TUI 里怎么消费**：见 [第 09 章 §9.5 事件订阅：bus → TUI](09-tui.md#95-事件订阅bus--tui)；TUI 走的是同一个 bus，区别只在 subscriber 是 React `useEvent` 还是 stdout 写入。
- **`GlobalBus` 跨进程 / 跨 instance 转发**：见 [第 14 章 §Global Bus](14-glossary-and-faq.md#global-bus)；本步骤里它在 `bus/index.ts:114-119` 被同步触发，让 desktop GUI 这种"跨 instance 看事件流"的场景能拿到本 instance 的事件。
- **`convertEvent` 钩子**：见 [第 10 章 §10.6.2 `convertEvent` 干嘛](10-server.md#1062-convertevent-干嘛)；它的作用是在 sync event 转 bus event 那一刻把"原始 patch"翻译成"完整快照"，让 SSE 订阅者不用再二次查库。

## 8. 走完这一步你脑子里应该多了什么

1. **"写库 + 发事件" 是不可分割的原子动作**——靠 `SyncEvent.run` 的 immediate transaction + `Database.effect` commit-after callback 实现。任何看到 bus 事件的人去查库，都保证能查到最新态。这一条不变式是 opencode 多端 UI 都能协同的根基。
2. **SQLite 在本 trace 里被当作"事件 reducer 的状态投影"用**——CQRS 风：`SyncEvent` 是命令，projector 是 reducer，`SessionTable` / `PartTable` 是当前态。Fork / revert / undo 之所以能优雅地反操作（`applyUsage(..., -1)`），靠的就是这个范式。
3. **bus 是进程内 PubSub，SSE 是它的 HTTP 外延**——同一个 `subscribeAll()` stream 同时驱动同进程订阅者和 `/event` HTTP 流；GlobalBus 再多一层跨 instance 转发。typed + wildcard 两份 PubSub 各司其职。
4. **cost / tokens 在 `step-finish` part 写入时由 projector 用 SQL 表达式累加**——不是末尾一次性统计；这让账目对 fork / 删消息这种"撤销动作"鲁棒。下一步 `opencode stats` 直接读这张表就能拿到准确账。
5. **每次 Part 增量更新都走完一遍完整链路**——这是反直觉的：你以为流式应该缓冲到最后批量写，opencode 选择每片都写。代价是 SQLite 写入次数高（靠 WAL + PRAGMA synchronous=NORMAL 压住），收益是任何一刻断电都能完整 resume。
6. **走到这一步，所有持久化和广播都已经完成**——库里 part 全在，最后一条 `message.part.updated` SSE 已经发出去了；run 进程的 SSE consumer 正等着它。下一步进入第 15 步，看 SSE 怎么变成 stdout 的字符。

下一步：[Trace 步骤 15 —— 渲染到终端 / stdout](tour-15-stream-render.md)
