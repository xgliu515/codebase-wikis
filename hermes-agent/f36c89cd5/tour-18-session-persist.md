# Trace 步骤 18 —— 这一轮的消息怎么落进磁盘？

## 1. 当前情境

上一步（[步骤 17](tour-17-render-output.md)）结束时，spinner 已经收起，终端打印出了那个 response box：

```text
Hermes ▸ README.md 的第一行是一个居中的 <p> 标签，里面是项目 banner 图片。
```

用户已经看到答案了。但此刻整段对话只活在**一个地方**——进程内存里那个 `messages` 列表。走完两次 API 调用、一次工具执行之后，它长这样：

```text
messages = [
    {role: system,    content: "<拼好的系统提示>"},
    {role: user,      content: "读取 README.md 并告诉我它的第一行是什么"},
    {role: assistant, content: "",  tool_calls: [read_file(...)]},
    {role: tool,      tool_call_id: "...", content: "<read_file 的 JSON 结果>"},
    {role: assistant, content: "README.md 的第一行是一个居中的 <p> 标签……"},
]
```

这是一个纯粹的 Python list，住在 `AIAgent` 实例的栈帧里。`run_conversation` 即将返回，控制权即将回到 REPL。这一步要回答的问题是：在控制权离开对话循环之前，这五条消息怎样从「内存里的临时数据」变成「磁盘上的持久记录」。

## 2. 问题

对话必须**不丢**。具体来说：

- 用户下一条消息可能是 `/exit`，也可能是断电、`Ctrl-C`、或者一个把进程打挂的 bug——任何一种情况下，刚刚这轮问答都不能蒸发。
- 这条会话未来要能被 `/resume` 重新加载、被 `session_search` 全文检索到、在 `/sessions` 列表里带着标题和消息数显示出来。
- Hermes 不是单进程独占数据库。一个 `state.db` 同时被多方写：交互式 CLI、后台的 gateway 进程、worktree 里跑的子 agent、定时任务。落盘逻辑必须在这种并发下不串行化、不死锁、不互相覆盖。
- 落盘**不能拖慢用户**。用户已经看到答案了，磁盘 I/O 再慢也不该让他感觉卡。

换句话说：要的是一个能扛并发、不丢数据、还能被搜索的持久层——而不只是「把 list 序列化一下」。

## 3. 朴素思路

最直觉的做法是「退出时统一存」：在内存里一直攒着 `messages`，等用户敲 `/exit` 或进程收到退出信号时，把整个 list `json.dump` 进一个文件，比如 `~/.hermes/session-20260517.json`。

想检索？再写一个脚本，启动时把所有 session JSON 读进来，在内存里 grep。

这套思路代码量小、逻辑直白：一个 list、一次 `json.dump`、退出时触发。换谁第一版都会这么写。

## 4. 为什么朴素思路会崩

「退出时统一存」这五个字里藏着四个致命假设：

- **「会有退出时刻」是假的。** 进程不一定优雅退出。`kill -9`、OOM killer、笔记本合盖、一个未捕获的 `segfault` ——这些都不会触发 `atexit`。只要落盘绑定在退出钩子上，所有「还没退出」的对话就是一次崩溃的距离。用户问到一半电脑死机，整段历史归零。
- **JSON 文件不支持并发写。** gateway 和 CLI 同时给同一个用户追加消息，两个进程各自 `json.dump` 整个文件，后写的直接覆盖先写的——这不是「慢」，是**静默丢数据**。文件锁能缓解，但会把并发写串行化成排队，TUI 立刻卡给你看。
- **「启动时全读进内存再 grep」不可扩展。** 用了几个月的用户有几千条会话、几十万条消息。每次 `session_search` 都把它们全反序列化进内存线性扫一遍，又慢又吃内存。而且 grep 对中文无能为力——`unicode61` 之外的分词、子串匹配，纯文本扫描全做不到。
- **「攒着不落盘」放大了内存里那份数据的脆弱性。** 攒得越久，一次崩溃丢的越多。这与「不丢数据」的目标直接对立。

核心矛盾是：朴素思路把「持久化」理解成「序列化一个对象」，但真正要的是一个**事务性的、支持并发、自带索引**的存储——那是数据库的活，不是文件的活。

## 5. Hermes 的做法

Hermes 的答案是 `SessionDB`（`hermes_state.py:309`）——一个 SQLite 支撑、自带 FTS5 全文索引的会话存储。它的设计可以拆成三个决定。

### 决定一：每轮结束就落盘，而不是退出时统一写

对话循环 `run_conversation` 的每一条**退出路径**——正常完成、工具循环中途、各种 partial 错误——都在 `return` 之前调用 `agent._persist_session(messages, conversation_history)`。在 `conversation_loop.py` 里这个调用出现了十几次（`:899`、`:1206`、`:1615`、`:2168`、`:3012`、`:3058`……），覆盖了**每一个**能离开循环的口子。我们 trace 的这次正常问答走的是末尾正常返回那条路径。

`_persist_session`（`run_agent.py:1163`）本身只有四行实质逻辑：

```python
def _persist_session(self, messages, conversation_history=None):
    self._drop_trailing_empty_response_scaffolding(messages)
    self._apply_persist_user_message_override(messages)
    self._session_messages = messages
    self._save_session_log(messages)            # ① JSON 日志（人类可读备份）
    self._flush_messages_to_session_db(messages, conversation_history)  # ② SQLite
```

注意它写**两份**：一份人类可读的 JSON 日志，一份 SQLite。JSON 是给人翻的备份，SQLite 才是真正能被查询、被 `/resume` 加载的权威存储。

「每轮就落盘」直接消解了朴素思路的第一个崩点：根本不存在「等退出」这回事。一轮答完，磁盘上就有了。下一轮哪怕进程立刻被 `kill -9`，这轮也已经安全。

### 决定二：增量追加，靠水位线去重

`_flush_messages_to_session_db`（`run_agent.py:1232`）的关键不是「写」，而是「只写**新增的**」。它维护一个水位线 `_last_flushed_db_idx`：

```python
start_idx = len(conversation_history) if conversation_history else 0
flush_from = max(start_idx, self._last_flushed_db_idx)
for msg in messages[flush_from:]:
    ...
    self._session_db.append_message(session_id=self.session_id, role=role, ...)
```

`messages[flush_from:]` 只切出本轮真正新产生的消息。这一点很要紧，因为 `_persist_session` 会被多条退出路径重复调用——如果每次都把整个 `messages` 全量写进去，同一条消息会被插入好几遍（这正是注释里点名的 #860 重复写 bug）。水位线保证每条消息**恰好落盘一次**。

我们这轮新增了四条消息（user、assistant-with-tool_calls、tool、assistant-text），它们逐条进入 `SessionDB.append_message`（`hermes_state.py:1433`）。每条 `append_message` 做两件事，包在**同一个事务**里：

```python
def _do(conn):
    cursor = conn.execute(
        """INSERT INTO messages (session_id, role, content, tool_call_id,
           tool_calls, tool_name, timestamp, token_count, finish_reason, ...)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ...)""",
        (session_id, role, stored_content, tool_call_id, tool_calls_json, ...),
    )
    msg_id = cursor.lastrowid
    # 同一事务里更新 sessions 表的元数据计数
    if num_tool_calls > 0:
        conn.execute(
            """UPDATE sessions SET message_count = message_count + 1,
               tool_call_count = tool_call_count + ? WHERE id = ?""",
            (num_tool_calls, session_id))
    else:
        conn.execute(
            "UPDATE sessions SET message_count = message_count + 1 WHERE id = ?",
            (session_id,))
    return msg_id
```

一条 `messages` 表的 `INSERT`，加一条 `sessions` 表的 `UPDATE`（递增 `message_count`，必要时递增 `tool_call_count`）——两者在一个事务里要么都成功要么都回滚。`sessions` 表存的是会话级元数据：标题、模型、token 计数、消息数、起止时间。`messages` 表存的是逐条消息。这一轮跑完，`sessions` 行的 `message_count` 加了 4，`tool_call_count` 加了 1。

### 决定三：FTS5 索引由触发器自动同步

为什么 `session_search` 能秒级全文检索？因为有两张 FTS5 虚表替 `messages` 表维护倒排索引——而且**应用层完全不用管它们**。

建表时（`hermes_state.py:253` 的 `FTS_SQL`、`:282` 的 `FTS_TRIGRAM_SQL`）连同三个 SQLite 触发器一起建好：

```sql
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content,'') || ' ' ||
        COALESCE(new.tool_name,'') || ' ' || COALESCE(new.tool_calls,'')
    );
END;
```

`append_message` 那条 `INSERT INTO messages` 一旦提交，SQLite 在**同一事务内**自动触发 `messages_fts_insert` 和 `messages_fts_trigram_insert`，把消息内容（外加 `tool_name`、`tool_calls`）写进两张索引。应用代码从头到尾没碰过 FTS 表——索引和数据天然不会失同步。

为什么是**两**张 FTS 表？

- `messages_fts`：默认的 `unicode61` 分词器，按词切分，适合英文、代码标识符的关键词检索。
- `messages_fts_trigram`：trigram（三字符滑窗）分词器。默认分词器会把每个 CJK 汉字切成单独 token，破坏中文短语匹配；trigram 把内容切成重叠的三字节序列，让**任意脚本的子串查询**（中文、泰文……）原生可用。

我们这轮的 user 消息「读取 README.md……」就这样进了 trigram 索引——往后用户搜「README」或者「第一行」都能命中这一轮。

### 决定四：WAL 模式 + 应用层抖动重试扛并发

`SessionDB.__init__`（`hermes_state.py:332`）打开连接后立刻 `apply_wal_with_fallback(...)` 把数据库切到 **WAL（Write-Ahead Logging）模式**。WAL 的关键性质：写不阻塞读。一个写者在追加 WAL 帧的同时，多个读者仍能读主库——这正好匹配 Hermes「多读者、单写者」的并发形态。

但 WAL 只允许一个写者。多个 Hermes 进程同时要写，仍会撞上写锁。Hermes 没有让线程傻等 SQLite 内置的 30 秒 busy handler（注释明确指出它的确定性退避会在高并发下造成「车队效应」convoy），而是把 SQLite 超时压到 1 秒，自己在应用层重试。看 `_execute_write`（`hermes_state.py:375`）：

```python
for attempt in range(self._WRITE_MAX_RETRIES):   # 最多 15 次
    try:
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")   # 立刻拿写锁，争用马上暴露
            ...commit...
        return result
    except sqlite3.OperationalError as exc:
        if "locked" in str(exc).lower() or "busy" in str(exc).lower():
            jitter = random.uniform(0.020, 0.150)   # 随机 20-150ms
            time.sleep(jitter)
            continue
        raise
```

`BEGIN IMMEDIATE` 在事务**开始**就抢写锁（而非提交时），让争用立刻浮现；撞锁后睡一个**随机**抖动再重试——随机性把竞争的写者天然错开，正是这一点打散了 SQLite 确定性退避造成的车队。每写满 50 次还会做一次 PASSIVE WAL checkpoint（`_try_wal_checkpoint`，`:427`），把 WAL 帧刷回主库、防止它无限膨胀。

把整步串起来：

<svg viewBox="0 0 800 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="session persistence call flow from run_conversation to SQLite write transaction">
  <defs>
    <marker id="t18ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="290" y="20" width="220" height="32" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="400" y="40" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">run_conversation 即将 return</text>
  <line x1="400" y1="52" x2="400" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18ar)"/>
  <rect x="200" y="76" width="400" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="98" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">agent._persist_session(messages, …)</text>
  <text x="592" y="98" text-anchor="end" font-size="10" fill="#64748b" opacity="0">x</text>
  <line x1="300" y1="110" x2="300" y2="134" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18ar)"/>
  <line x1="500" y1="110" x2="500" y2="134" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18ar)"/>
  <rect x="120" y="136" width="280" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="260" y="153" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">_save_session_log()</text>
  <text x="260" y="169" text-anchor="middle" font-size="10" fill="#64748b">~/.hermes/…json（人类可读备份）</text>
  <rect x="420" y="136" width="280" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="560" y="153" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">_flush_messages_to_session_db()</text>
  <text x="560" y="169" text-anchor="middle" font-size="10" fill="#64748b">flush_from = max(start_idx, 水位线) 去重</text>
  <line x1="560" y1="176" x2="560" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18ar)"/>
  <rect x="420" y="202" width="280" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="560" y="219" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">SessionDB.append_message()</text>
  <text x="560" y="233" text-anchor="middle" font-size="10" fill="#64748b">对 messages[flush_from:] 每条</text>
  <line x1="560" y1="238" x2="560" y2="262" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#t18ar)"/>
  <rect x="160" y="264" width="540" height="178" rx="8" fill="#fef2f2" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="178" y="286" font-size="12" font-weight="700" fill="currentColor">_execute_write()　hermes_state.py:375</text>
  <rect x="178" y="296" width="504" height="24" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1"/>
  <text x="190" y="312" font-size="11" fill="#64748b">BEGIN IMMEDIATE　← 抢 WAL 写锁</text>
  <rect x="178" y="324" width="504" height="44" rx="3" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="190" y="341" font-size="11" fill="#64748b">INSERT INTO messages（逐条消息）</text>
  <text x="206" y="359" font-size="10" fill="#94a3b8">└→ 触发器 messages_fts_insert / messages_fts_trigram_insert（同事务）</text>
  <rect x="178" y="372" width="504" height="24" rx="3" fill="#f1f5f9" stroke="#94a3b8" stroke-width="1"/>
  <text x="190" y="388" font-size="11" fill="#64748b">UPDATE sessions SET message_count += 1（元数据）</text>
  <rect x="178" y="400" width="504" height="24" rx="3" fill="#f0fdf4" stroke="#16a34a" stroke-width="1"/>
  <text x="190" y="416" font-size="11" fill="#64748b">COMMIT</text>
  <text x="178" y="436" font-size="10" fill="#dc2626">撞锁? → sleep(random 20-150ms) → 重试 (≤15 次)</text>
</svg>
<span class="figure-caption">图 T18.1 ｜ 会话落盘调用链：_persist_session 同时写 JSON 备份与 SQLite，写事务靠 BEGIN IMMEDIATE 抢锁、抖动重试扛并发。</span>

<details>
<summary>ASCII 原版</summary>

```text
run_conversation 即将 return
        │
        ▼
agent._persist_session(messages, conversation_history)   run_agent.py:1163
        │
        ├─ _save_session_log()            → ~/.hermes/…json（人类可读备份）
        │
        └─ _flush_messages_to_session_db()  run_agent.py:1232
               │  flush_from = max(start_idx, _last_flushed_db_idx)  ← 水位线去重
               │
               └─ 对 messages[flush_from:] 每条 →
                      SessionDB.append_message()  hermes_state.py:1433
                          │
                          └─ _execute_write()  hermes_state.py:375
                                 BEGIN IMMEDIATE         ← 抢 WAL 写锁
                                 ├─ INSERT INTO messages          (逐条消息)
                                 │     └→ 触发器 messages_fts_insert        ┐ 同
                                 │     └→ 触发器 messages_fts_trigram_insert ┘ 事务
                                 ├─ UPDATE sessions SET message_count += 1  (元数据)
                                 COMMIT
                                 撞锁? → sleep(random 20-150ms) → 重试 (≤15 次)
```

</details>

到这一步结束，磁盘上的 `state.db` 里：`sessions` 表有这条会话的一行（`message_count` 现在是 4，`tool_call_count` 是 1），`messages` 表多了 4 行，`messages_fts` 和 `messages_fts_trigram` 两张索引也同步更新完毕。会话已持久化，`session_id` 已分配——这条会话从此可被 `/resume` 加载、被 `session_search` 检索到。

## 6. 代码位置

按阅读顺序：

- 持久化入口：`run_agent.py:1163` —— `_persist_session()`，每条退出路径都会调它。
- 退出路径上的调用点（举例）：`agent/conversation_loop.py:899`、`:1615`、`:3012` —— `agent._persist_session(messages, conversation_history)`。
- 增量刷库：`run_agent.py:1232` —— `_flush_messages_to_session_db()`，水位线 `_last_flushed_db_idx` 在 `:1247`。
- 存储类：`hermes_state.py:309` —— `SessionDB`，类 docstring 说明「多读者 + 单写者 WAL」并发模型。
- 连接初始化与 WAL：`hermes_state.py:332` 的 `__init__`，`apply_wal_with_fallback` 在 `:353`。
- 写事务与抖动重试：`hermes_state.py:375` —— `_execute_write()`，`BEGIN IMMEDIATE` 在 `:394`，随机退避在 `:414`。
- WAL checkpoint：`hermes_state.py:427` —— `_try_wal_checkpoint()`。
- 追加消息：`hermes_state.py:1433` —— `append_message()`，`INSERT INTO messages` 加 `sessions` 计数 `UPDATE` 在同一个 `_do(conn)` 事务里。
- 会话行插入：`hermes_state.py:684` —— `_insert_session_row()`（`INSERT OR IGNORE`，幂等）。
- FTS5 表与触发器定义：`hermes_state.py:253`（`FTS_SQL`，`unicode61`）、`hermes_state.py:282`（`FTS_TRIGRAM_SQL`，trigram，CJK 子串）。
- FTS5 建表兜底：`hermes_state.py:666` 附近 —— 因为 `CREATE VIRTUAL TABLE` 不能可靠地塞进 `executescript` 而单独处理。

## 7. 分支与延伸

- `SessionDB` 的完整表结构（`sessions` / `messages` / 两张 FTS 虚表）、schema 版本迁移、`session_search` 如何把 FTS5 查询拼成 SQL → [第 9 章 会话存储与全文搜索](09-session-storage.md)。
- 这一步只「追加」消息；当 `/retry`、`/undo`、`/compress` 需要重写整段历史时，走的是 `replace_messages()`（`hermes_state.py:1520`）的「全删 + 重插」单事务路径 → 同见[第 9 章](09-session-storage.md)。
- 上一步 spinner 收起、response box 打印到终端 → [Trace 步骤 17](tour-17-render-output.md)。
- 落盘完成后，`run_conversation` 还没真正返回——它紧接着会派发一组后台辅助任务（标题生成、记忆 sync） → [Trace 步骤 19](tour-19-post-turn.md)。

## 8. 走完这一步你脑子里应该多了什么

1. Hermes **每一轮结束就落盘**，不是退出时统一写——因为「优雅退出时刻」根本不可依赖（`kill -9`、OOM、断电都没有 `atexit`）。`_persist_session` 出现在对话循环的**每一条**退出路径上。
2. 持久化是数据库的活，不是文件的活。`SessionDB` 用 SQLite 提供事务性：一条 `messages` 的 `INSERT` 和一条 `sessions` 的计数 `UPDATE` 在同一事务里原子提交。
3. 重复写由**水位线 `_last_flushed_db_idx`** 防住：`_persist_session` 被多条路径反复调用，但每条消息只切片刷库一次。
4. 全文索引由 **SQLite 触发器**在同一事务内自动维护——应用代码从不直接碰 FTS 表，所以索引和数据永不失同步；两张 FTS 表分工，trigram 那张专门让中文子串检索原生可用。
5. 并发安全靠 **WAL 模式 + 应用层随机抖动重试**：WAL 让写不阻塞读，`BEGIN IMMEDIATE` 让锁争用立刻暴露，随机退避打散多写者的「车队效应」——这是为「一个 state.db 被多进程共写」专门设计的。

---

下一步：[Trace 步骤 19 —— 收尾：标题生成与记忆 sync](tour-19-post-turn.md)
