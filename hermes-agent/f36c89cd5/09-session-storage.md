# 第 9 章 会话存储与全文搜索

agent 的每一轮对话——用户说了什么、模型回了什么、调了哪些工具、花了多少 token——都得留下来。不只是为了「continue 上次会话」，更是 Hermes 学习闭环的原料：`session_search` 工具要能翻出三个月前那次相似的对话。本章讲 `hermes_state.py` 里的 `SessionDB`——一个为「单进程多平台并发写、跨会话全文检索、还得在 NFS 上能跑」而精心设计的 SQLite 存储层。

---

## 9.1 为什么是 SQLite

一个 agent 框架的会话存储，最朴素的方案是把每个会话写成一个 JSON 文件。它的问题在 Hermes 的场景下会迅速暴露：

- **检索**。「找出我上次让 agent 配置 nginx 的那次对话」——JSON 文件没法做全文搜索，你得把所有文件读进内存逐个 grep。会话多了就是灾难。
- **并发**。Hermes 的网关是单进程、同时服务 Telegram/Discord/Slack 等多个平台（见[第 13 章](13-messaging-gateway.md)）。多个会话可能同时要写。JSON 文件没有事务，并发写就是数据损坏。
- **结构化查询**。「这个月一共花了多少钱」「哪个模型用得最多」——这些是 SQL 的 `SUM`/`GROUP BY` 一行就能干的事。

| 需求 | JSON 文件 | SQLite |
| --- | --- | --- |
| 全文检索 | 全量读入内存逐个 grep | FTS5 索引，毫秒级 |
| 并发写 | 无事务，易损坏 | WAL + 写锁，ACID |
| 结构化统计 | 手写脚本聚合 | `SUM`/`GROUP BY` 一行 SQL |
| 运维成本 | 零 | 零（单文件、无服务进程） |

SQLite 一次性解决了前三点、运维成本又和 JSON 文件一样低：单文件、零运维、ACID 事务、还自带 FTS5 全文搜索扩展。`hermes_state.py` 的模块 docstring 把设计目标列得很清楚——「WAL mode for concurrent readers + one writer」「Compression-triggered session splitting via parent_session_id chains」。它没有用 ORM，所有 SQL 都是手写的——存储层逻辑足够内聚（就一个类），手写 SQL 反而让事务边界、索引使用、并发控制这些关键细节完全可见、可控。

整个存储层就是一个类：`hermes_state.py:309` 的 `class SessionDB`。

## 9.1.1 连接管理：单连接 + 进程内锁

很多人对 SQLite 并发的第一反应是「每个方法开一个新连接」。`SessionDB` 没有这么做。`__init__`（`hermes_state.py:332`）在对象构造时**只开一个长连接**，存进 `self._conn`，整个对象生命周期内复用：

```python
def __init__(self, db_path: Path = None):
    self.db_path = db_path or DEFAULT_DB_PATH
    self.db_path.parent.mkdir(parents=True, exist_ok=True)

    self._lock = threading.Lock()
    self._write_count = 0
    self._conn = sqlite3.connect(
        str(self.db_path),
        check_same_thread=False,
        timeout=1.0,
        isolation_level=None,
    )
    self._conn.row_factory = sqlite3.Row
    apply_wal_with_fallback(self._conn, db_label="state.db")
    self._conn.execute("PRAGMA foreign_keys=ON")
    self._init_schema()
```

三个构造参数都不是默认值，每一个都对应一个明确的设计决策：

- **`check_same_thread=False`**——网关是单进程多线程（Telegram 线程、Discord 线程……都在一个进程里跑）。Python 的 `sqlite3` 默认禁止跨线程共用连接；这里关掉这道保险，因为线程安全由 `SessionDB` 自己的 `self._lock`（一把 `threading.Lock`）来保证，每个读写方法都在 `with self._lock:` 里操作 `self._conn`。类 docstring 那句「Thread-safe for the common gateway pattern」说的就是这个。
- **`timeout=1.0`**——SQLite 内置的 busy handler 默认会等 5 秒（甚至更久），且用的是一个确定性的退避序列。多个 Hermes 进程（网关 + 多个 CLI 会话 + worktree agent）共用一个 `state.db` 时，确定性退避会导致「车队效应」（convoy）——多个写者卡在同一个时间点同时重试、再同时失败。把 SQLite 超时压到 1 秒，把重试逻辑上提到应用层（见 9.5.1），用随机抖动打散竞争。
- **`isolation_level=None`**——Python `sqlite3` 的默认 `isolation_level=""` 会在遇到 DML 语句时**自动**开启事务。这会和 `_execute_write` 里显式的 `BEGIN IMMEDIATE` 打架（「cannot start a transaction within a transaction」）。设为 `None` 即 autocommit 模式，事务完全由 `SessionDB` 自己用 `BEGIN`/`commit`/`rollback` 管理。

`row_factory = sqlite3.Row` 让查询结果可以按列名下标访问（`row["title"]`），读取方法里大量出现的 `dict(row)` 也依赖它。

构造里还有一段 `try/except`：任何一步失败（最典型的是 NFS 上 WAL pragma 抛 `OperationalError`），都会先把 `f"{type(exc).__name__}: {exc}"` 写进进程级的 `_last_init_error`，再把异常重新抛出。这样上层捕获后即使把 `_session_db` 降级成 `None`，`/resume`、`/title`、`/history`、`/branch` 这些 slash 命令也能通过 `format_session_db_unavailable()`（`hermes_state.py:105`）告诉用户**为什么**数据库不可用——而不是干巴巴一句「Session database not available」。注意这里**只在失败路径写** `_last_init_error`，成功路径故意不清空：多线程下另一个线程的成功 open 不能擦掉本线程 `/resume` 即将格式化的错误原因。

## 9.1.2 关闭：退出时帮一把 checkpoint

`close()`（`hermes_state.py:448`）在关连接前先做一次 `PRAGMA wal_checkpoint(PASSIVE)`：

```python
def close(self):
    with self._lock:
        if self._conn:
            try:
                self._conn.execute("PRAGMA wal_checkpoint(PASSIVE)")
            except Exception:
                pass
            self._conn.close()
            self._conn = None
```

进程退出本来就是个把 WAL 刷回主库的好时机——顺手做一次 PASSIVE checkpoint，能帮整个共享 `state.db` 的进程群体把 WAL 文件压小一点。失败也无所谓（`except: pass`），它是 best-effort 的收尾，不是正确性的一环。

## 9.2 表结构

schema 版本钉在 `hermes_state.py:36` 的 `SCHEMA_VERSION = 11`。核心是四张表 + 两张 FTS5 虚拟表。

### sessions —— 会话元数据

`sessions` 表（`hermes_state.py:190`）一行就是一次会话，字段很多，因为它要承载计费、token 统计、跨平台交接等所有元信息：

```sql
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- 来源平台：cli / telegram / discord ...
    user_id TEXT,
    model TEXT,
    parent_session_id TEXT,          -- 压缩拆分链（见 9.5）
    started_at REAL NOT NULL,
    ended_at REAL,
    message_count INTEGER DEFAULT 0,
    tool_call_count INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    title TEXT,
    handoff_state TEXT,              -- 跨平台交接状态
    FOREIGN KEY (parent_session_id) REFERENCES sessions(id)
);
```

实际的 `sessions` 表（`hermes_state.py:190`）比上面这个精简版还要宽——一共 30 个字段。它们可以按用途分成几组，分组理解比逐行背诵有效得多。

**身份与血缘组**

| 字段 | 用途 |
| --- | --- |
| `id` | 会话主键（TEXT，由调用方生成的 UUID 风格字符串） |
| `source` | 来源平台：`cli` / `telegram` / `discord` / `slack` / `unknown` …… |
| `user_id` | 平台侧用户标识 |
| `parent_session_id` | 指向父会话，构成压缩拆分链 / branch 链（见 9.6） |
| `started_at` / `ended_at` | 会话开始 / 结束时间戳（REAL，`time.time()`） |
| `end_reason` | 结束原因：`compression`（压缩拆分）、`normal` 等——`get_compression_tip` 靠它区分压缩链和其它子会话 |

**模型与上下文快照组**

`model` 记录用的模型名；`model_config`（JSON）存模型参数快照；`system_prompt` 存**这次会话拼装出来的完整系统提示原文**——`update_system_prompt`（`hermes_state.py:744`）负责写入。把系统提示快照下来，是为了 `/resume` 时能完整还原当时的上下文，而不是用「现在」的系统提示去续一段「过去」的对话。

**计费字段组**

这一组字段全部服务于成本核算，由 `update_token_counts`（`hermes_state.py:753`）维护：

```text
message_count / tool_call_count / api_call_count   ── 计数器
input_tokens / output_tokens                       ── 基础 token
cache_read_tokens / cache_write_tokens              ── prompt caching token
reasoning_tokens                                    ── 推理 token
estimated_cost_usd / actual_cost_usd                ── 预估 / 实际花费
cost_status / cost_source / pricing_version         ── 成本数据的来源与可信度
billing_provider / billing_base_url / billing_mode  ── 计费归属哪个 provider
```

`cache_read_tokens` / `cache_write_tokens` 单列出来，是因为 prompt caching（见[第 4 章](04-system-prompt.md)）的命中 token 和未命中 token 单价差一个数量级，混在 `input_tokens` 里就算不准账。`reasoning_tokens` 同理——推理模型的「思考」也是要计费的。`billing_*` 一组记录这笔花费该算到哪个 provider 头上，凭证池轮换（见[第 7 章](07-model-providers.md)）时尤其重要。

**跨平台 handoff 组**

`handoff_state` / `handoff_platform` / `handoff_error` 三个字段服务于「把一个会话从一个平台交接到另一个平台」的能力——例如在 CLI 里开的会话交接给 Telegram 继续。`handoff_state` 记交接进行到哪一步，`handoff_error` 记交接失败的原因。

`title` 字段由后台辅助 LLM 异步填上（见[第 7 章](07-model-providers.md)），并受一个唯一索引约束（见 9.4.1）。

### messages —— 全消息历史

`messages` 表（`hermes_state.py:224`）一行一条消息，是 OpenAI 消息格式的持久化形态：

```sql
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,              -- system / user / assistant / tool
    content TEXT,
    tool_call_id TEXT,               -- tool 消息回指哪次调用
    tool_calls TEXT,                 -- assistant 消息发起的工具调用（JSON）
    tool_name TEXT,
    timestamp REAL NOT NULL,
    token_count INTEGER,
    reasoning TEXT,                  -- 推理内容
    codex_reasoning_items TEXT,      -- Codex Responses API 专属
    ...
);
```

`messages` 表里有一组字段专门服务推理模型——`reasoning` / `reasoning_content` / `reasoning_details` / `codex_reasoning_items` / `codex_message_items`，五个字段全是为推理内容存在的。原因是不同 provider 的推理内容形态完全不一样（见[第 7 章](07-model-providers.md)）：

- `reasoning` / `reasoning_content`——纯文本形态的推理，OpenRouter、部分 OpenAI 兼容端走这里。
- `reasoning_details`——结构化推理（JSON），保留 provider 返回的完整结构。
- `codex_reasoning_items` / `codex_message_items`——OpenAI Codex 的 Responses API 专属，它的推理和消息是带 `id` 的结构化 item，回放时必须原样带回去，否则多轮推理上下文会断裂。

这些字段在存储时都以 JSON 序列化（`append_message` 里的 `json.dumps(...)`），读回时再反序列化。`get_messages_as_conversation`（见 9.5.4）只在 `role == "assistant"` 的行上还原这些字段——推理是 assistant 独有的。把每种 provider 的推理形态都单列一个字段、原样保留，是「存储层不替上层做有损归一化」这条原则的体现：归一化的活留给 provider 适配层，存储层只负责无损落盘。

`token_count`（每条消息的 token 数）和 `finish_reason`（这一轮 assistant 输出为何结束）也是逐消息记录的。`messages` 表没有 `parent_session_id`——消息属于哪个会话由 `session_id` 外键决定，跨会话的血缘在 `sessions` 表里表达。

### 多模态 content 的编码

`content` 列声明成 `TEXT`，但多模态消息的 `content` 其实是一个 part 列表——`[{"type": "text", ...}, {"type": "image_url", ...}]`。`sqlite3` 只能绑定 `str`/`bytes`/`int`/`float`/`None`，直接绑 list 会抛 `ProgrammingError`。`_encode_content`（`hermes_state.py:1397`）解决这个：

```python
@classmethod
def _encode_content(cls, content):
    if content is None or isinstance(content, (str, bytes, int, float)):
        return content
    try:
        return cls._CONTENT_JSON_PREFIX + json.dumps(content)
    except (TypeError, ValueError):
        return str(content)   # 最后兜底，持久化绝不失败
```

标量原样返回；list/dict 序列化成 JSON 并加一个**哨兵前缀**（`_CONTENT_JSON_PREFIX`）。`_decode_content`（`hermes_state.py:1419`）读回时靠这个前缀区分「这是一段被编码过的结构化内容」还是「一段恰好长得像 JSON 的普通字符串」——只有带前缀的才反序列化。哨兵前缀避免了「用户消息正文恰好是一个 JSON 串」被误解码的歧义。编码失败时退化成 `str(content)`——宁可存一个不那么好看的字符串，也绝不让 `append_message` 因为内容编码失败而整个失败。

### 其它表与索引

- `schema_version`（`hermes_state.py:186`）—— 单行记录当前 schema 版本，迁移时比对。
- `state_meta`（`hermes_state.py:242`）—— 通用 key/value 元数据，给存储层之外的杂项状态留一块地方。

索引一共四个（`hermes_state.py:247`–`250`），每个都对应一类高频查询：

| 索引 | 列 | 服务的查询 |
| --- | --- | --- |
| `idx_sessions_source` | `source` | 按平台过滤会话（`search_sessions` 的 `WHERE s.source = ?`） |
| `idx_sessions_parent` | `parent_session_id` | 沿拆分链找子会话（`get_compression_tip` / `resolve_resume_session_id`） |
| `idx_sessions_started` | `started_at DESC` | 按时间倒序列会话 |
| `idx_messages_session` | `(session_id, timestamp)` | `get_messages` / `get_messages_as_conversation` 按会话取消息并排序 |

`idx_messages_session` 是复合索引，把过滤列 `session_id` 和排序列 `timestamp` 放在一起——「取某会话全部消息并按时间排序」这个最高频的读，靠它一个索引就能既过滤又排序，不用额外的排序步骤。另外还有一个唯一索引 `idx_sessions_title_unique`（见 9.7），不在 `SCHEMA_SQL` 里、由 `_init_schema` 单独建。

## 9.2.1 schema 演进：声明式列对账 + 版本化数据迁移

`SCHEMA_VERSION = 11`（`hermes_state.py:36`）。但 Hermes 的 schema 管理不是「写 11 个迁移脚本一路 ALTER」的传统套路，而是分成两条互补的路径，由 `_init_schema`（`hermes_state.py:550`）统一调度。

**路径一：声明式列对账（处理「加一列」）**

`SCHEMA_SQL` 里的 `CREATE TABLE` 定义是 schema 的**唯一真相来源**。每次启动，`_reconcile_columns`（`hermes_state.py:506`）做一件事：把活库的实际列和 `SCHEMA_SQL` 声明的列对账，缺哪列就 `ALTER TABLE ADD COLUMN` 补哪列。

它怎么知道 `SCHEMA_SQL` 声明了哪些列？`_parse_schema_columns`（`hermes_state.py:463`）用了一个干净的技巧——开一个 `:memory:` 内存库，把 `SCHEMA_SQL` 执行进去，再用 `PRAGMA table_info` 读出列元数据。让 SQLite 自己解析 SQL，就不用写正则去抠 `CREATE TABLE` 里那些带逗号的 `DEFAULT` 表达式、内联 `REFERENCES`、`CHECK` 约束——零正则边角 case。

这个模式（Beets、sqlite-utils 都这么干）的好处是：**加一列就改 `SCHEMA_SQL`，下次启动自动出现**，不需要写版本门控的迁移块。即使某个迁移因为版本号重排被跳过，列对账也会自愈地把它补上。

**路径二：版本化数据迁移（处理「改数据」）**

加列能声明式搞定，但「回填一张索引表」「重建虚拟表」这类**数据变换**没法声明式表达——它们仍然走版本门控。`_init_schema` 读出 `schema_version` 当前值，按 `if current_version < N:` 逐级执行：

```python
if current_version < 10:
    # v10: 为 CJK/子串搜索引入 trigram FTS5 表。
    try:
        cursor.execute("SELECT * FROM messages_fts_trigram LIMIT 0")
        _fts_trigram_exists = True
    except sqlite3.OperationalError:
        _fts_trigram_exists = False
    if not _fts_trigram_exists:
        cursor.executescript(FTS_TRIGRAM_SQL)
        cursor.execute(
            "INSERT INTO messages_fts_trigram(rowid, content) "
            "SELECT id, content FROM messages WHERE content IS NOT NULL"
        )
```

v10 的迁移（`hermes_state.py:591`–`605`）做的就是：检测 `messages_fts_trigram` 是否存在，不存在则建表、并把历史 `messages` 一次性回填进 trigram 索引——新建的虚拟表是空的，触发器只对**未来**的写生效，历史数据必须显式回填。

v11 的迁移（`hermes_state.py:606`–`650`）更彻底：它要把两张 FTS 表的索引内容从「只索引 `content`」扩展到「索引 `content || tool_name || tool_calls`」。但旧 schema 的 FTS 表和触发器已经存在，`CREATE ... IF NOT EXISTS` 不会覆盖它们——所以 v11 先**显式 DROP** 掉 6 个旧触发器和 2 张旧 FTS 表，再让后面的存在性检查用新 schema 重建，最后把每一条 `messages` 行重新回填进两张索引（修复 #16751）。

迁移全部跑完后，`if current_version < SCHEMA_VERSION:` 把 `schema_version` 更新到 11。`schema_version` 表被保留下来，正是为了未来这种「无法声明式表达的数据迁移」继续有版本可以门控。

`_init_schema` 末尾还有一段无条件的兜底（`hermes_state.py:666`–`676`）：分别 `SELECT * FROM messages_fts LIMIT 0` 试探两张 FTS 虚拟表是否存在，不存在就建——因为 `CREATE VIRTUAL TABLE` 放进 `executescript` 配合 `IF NOT EXISTS` 不总是可靠，干脆用「探测 + 重建」兜住。

## 9.3 FTS5 全文搜索

光有 `messages` 表，搜索只能 `WHERE content LIKE '%docker%'`——全表扫描，慢且不支持布尔逻辑、相关度排序、短语匹配。SQLite 的 FTS5 扩展是专门的全文索引，Hermes 用它建了一张虚拟表 `messages_fts`（`hermes_state.py:254`），用 `CREATE VIRTUAL TABLE ... USING fts5(...)` 声明，默认 `unicode61` tokenizer。FTS5 相对 `LIKE` 多出来的能力，正是 `session_search` 工具想要的——布尔查询（`docker OR kubernetes`）、短语匹配（`"exact phrase"`）、前缀匹配（`deploy*`）、按相关度 `rank` 排序、以及内置的 `snippet()` 摘要高亮。

对外的搜索入口是 `search_messages()`（`hermes_state.py:1880`）。它的 docstring 列出了支持的查询语法——这正是 FTS5 相对 `LIKE` 的价值所在：

```python
def search_messages(self, query: str, source_filter=None,
                     exclude_sources=None, role_filter=None,
                     limit=20, offset=0) -> List[Dict[str, Any]]:
    """Full-text search across session messages using FTS5.

    Supports FTS5 query syntax:
      - Simple keywords: "docker deployment"
      - Phrases: '"exact phrase"'
      - Boolean: "docker OR kubernetes", "python NOT java"
    """
```

用户（或者 `session_search` 工具背后的 LLM）输入的查询会被当成 FTS5 query 语法处理。这里有一个安全考量：用户输入直接进 FTS5 MATCH 子句，畸形语法会让查询整个报错，恶意构造则可能是注入面。`search_messages` 第一件事就是 `query = self._sanitize_fts5_query(query)`，清洗后才送进 `MATCH`。

### FTS5 查询清洗的六个步骤

`_sanitize_fts5_query`（`hermes_state.py:1797`）的难点在于：它既要**防止语法报错和注入**，又要**尽量保留用户的查询意图**（引号短语、布尔操作符、连字符词组）。它分六步处理：

1. **抽出成对引号短语并占位保护**——`"exact phrase"` 这类合法的成对双引号短语先用 `\x00Q0\x00` 这样的占位符替换出来，避免后续步骤误伤它。
2. **剥掉剩下的 FTS5 特殊字符**——经过第一步后还残留的 `+ { } ( ) " ^` 都是不成对的、会引发语法错误的，统统替换成空格。
3. **规整通配符 `*`**——把 `***` 这种连续星号折叠成一个，并去掉行首的裸 `*`（前缀匹配要求 `*` 前至少有一个字符）。
4. **去掉悬空布尔操作符**——`"hello AND"`、`"OR world"` 这种开头/结尾的裸 `AND`/`OR`/`NOT` 会导致语法错误，剔除。
5. **给连字符 / 点号词组加引号**——FTS5 的 tokenizer 会在点和连字符上切词，`chat-send` 会被切成 `chat AND send`，`P2.2` 切成 `p2 AND 2`。正则 `\b(\w+(?:[._-]\w+)+)\b` 把这类词组整体包进双引号，保住短语语义。注释特意说明这里**一次正则搞定**，避免 dotted/hyphenated/underscored 分别处理时产生重复加引号的 bug（如 `my-app.config`）。
6. **还原第一步保护的引号短语**——把占位符换回原始的 `"exact phrase"`。

经过这六步，无论用户输入什么畸形字符串，进 `MATCH` 的都是合法 FTS5 语法。即便如此，`search_messages` 在执行 unicode61 路径时仍用 `try/except sqlite3.OperationalError` 兜底——清洗后万一还有语法错误，返回空列表而不是让整个工具调用崩掉（`hermes_state.py:2077`）。

注意所有过滤值（`source_filter`、`role_filter`、`limit`、`offset`）走的都是参数占位符 `?`，从不字符串拼接——这是结构上杜绝 SQL 注入。清洗只针对 FTS5 query 这一个无法参数化的位置。

### 触发器同步

`messages_fts` 的内容同步靠触发器：`messages` 表上的 INSERT/DELETE/UPDATE 各挂一个触发器自动维护索引。值得注意的是 v11 之后，索引的内容不只是 `content`：

```sql
CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, content) VALUES (
        new.id,
        COALESCE(new.content, '') || ' ' || COALESCE(new.tool_name, '')
            || ' ' || COALESCE(new.tool_calls, '')
    );
END;
```

触发器把 `content`、`tool_name`、`tool_calls` 三列**拼接**成一个索引文本。这意味着搜索能命中工具名和工具调用参数——「我上次是不是用 `bash` 跑过某个命令」也能搜到。`COALESCE(..., '')` 保证任一列为 NULL 时不会让整个拼接结果变 NULL。trigram 表（`hermes_state.py:288`–`301`）挂的是结构完全一样的三个触发器。`UPDATE` 触发器是「先 DELETE 旧 rowid 再 INSERT 新内容」——FTS5 没有原地更新，只能删了重建。

### inline content 模式

`messages_fts` 用 `CREATE VIRTUAL TABLE ... USING fts5(content)`，没有声明 `content=` 选项——这是 FTS5 的 **inline content 模式**：FTS5 表自己存一份索引文本的副本。另一种选择是 external content（`content='messages'`），让 FTS5 不存副本、查询时回原表取。v11 的迁移注释（`hermes_state.py:610`）明确说是「从 external-content 切到 inline」。

为什么切？因为索引的文本是 `content || tool_name || tool_calls` 的拼接结果——它不是 `messages` 表里任何**单独一列**。external content 模式要求索引列能从原表直接映射，而这里索引的是一个**计算值**。inline 模式让 FTS5 存一份拼接后的副本，触发器负责保持它和 `messages` 同步。代价是磁盘多占一份文本，换来的是「能索引跨列拼接值」这个能力。`snippet()` 也因此能直接在 FTS5 自己存的副本上生成摘要，不必回查原表。

## 9.4 CJK 检索难题与三元组表

### 问题

FTS5 默认的 `unicode61` tokenizer 是按「空白和标点分词」的——这对英文天然成立（`docker deployment` 切成 `docker` / `deployment`），但对中文彻底失效。「配置防火墙」是连续的五个汉字，中间没有空格，`unicode61` 会把它当成**一个** token。结果：你搜「防火墙」匹配不到「配置防火墙」，因为索引里压根没有「防火墙」这个独立 token。

### Hermes 的做法

Hermes 额外建了第二张 FTS5 虚拟表 `messages_fts_trigram`（`hermes_state.py:283`），用 trigram tokenizer：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts_trigram USING fts5(
    content,
    tokenize='trigram'
);
```

源码注释（`hermes_state.py:278`–`282`）说明了原理：trigram tokenizer 把内容切成**重叠的三字节序列**。「配置防火墙」会产生「配置防」「置防火」「防火墙」……这些三元组。搜「防火墙」时，它本身就是一个三元组，能直接命中索引。

`search_messages` 内部据查询特征在两张表间路由（`hermes_state.py:1955` 起）：

```text
查询「docker」          → 走 messages_fts（unicode61），英文按词索引最准
查询「配置防火墙」(≥3 CJK) → 走 messages_fts_trigram，三元组能匹配子串
查询「防火」(1-2 CJK)    → trigram 无能为力（注释 #20494：trigram 需要
                          每个 token ≥3 个 CJK 字符），回退处理
```

### 路由判定的实际代码

判定走哪条路的逻辑在 `search_messages` 内部（`hermes_state.py:1959` 起）。`_contains_cjk` / `_count_cjk`（`hermes_state.py:1861`/`1876`）判断和计数 CJK 字符——它们认的 Unicode 区段不只是汉字，还包括 CJK 扩展 A/B、CJK 符号、平假名、片假名、谚文音节，所以日文、韩文一样适用。

```python
is_cjk = self._contains_cjk(query)
if is_cjk:
    raw_query = query.strip('"').strip()
    cjk_count = self._count_cjk(raw_query)
    _tokens_for_check = [
        t for t in raw_query.split()
        if t.upper() not in {"AND", "OR", "NOT"} and self._contains_cjk(t)
    ]
    _any_short_cjk = any(self._count_cjk(t) < 3 for t in _tokens_for_check)
    if cjk_count >= 3 and not _any_short_cjk:
        # 走 trigram 路径
    else:
        # 走 LIKE 兜底路径
```

### issue #20494：1-2 字 CJK 与 mixed 查询的边角 case

trigram tokenizer 的硬约束是：**每个 token 至少要有 3 个 CJK 字符**（trigram 切的是 3 字符滑动窗口，token 不足 3 字就切不出任何三元组）。仅看「整个查询的 CJK 总数 ≥ 3」是不够的：

- 查询 `防火`——总数才 2，trigram 无能为力。
- 查询 `广西 OR 桂林 OR 漓江`——CJK 总数是 6（≥3），但拆成 token 后，每个实词 token 只有 2 个 CJK 字符。如果按总数判定就走了 trigram，结果是**返回 0 条**——这正是 issue #20494 记录的坑。

所以路由判定多了一道 `_any_short_cjk` 检查：把查询拆成 token，跳过 `AND`/`OR`/`NOT` 操作符，只要**任何一个**实词 token 的 CJK 字符数 `< 3`，就不走 trigram，改走 LIKE 兜底。

LIKE 兜底路径（`hermes_state.py:2026`–`2072`）也专门处理了多 token 的情况：对 `广西 OR 桂林 OR 漓江` 这种查询，它给每个非操作符 token 单独建一个 `LIKE` 条件、用 `OR` 连起来，让每个词独立匹配——而不是把整串当一个 `LIKE '%...%'`。每个词都经过 `\` 转义（`replace("%", "\\%")` 等）后用 `ESCAPE '\'`，防止用户查询里的 `%`/`_` 被当成 LIKE 通配符。snippet 则用 `substr` + `instr` 在命中位置前后截一段文本来近似。

trigram 路径自己也做了一层保护：每个非操作符 token 用 `'"' + tok.replace('"', '""') + '"'` 包成 FTS5 引号短语，既能处理 token 里的 `%`/`*` 等特殊字符，又保留了 `AND`/`OR`/`NOT` 的布尔语义。

### 三条检索路径对照

把三条路径并排看，它们的取舍一目了然：

| 路径 | 触发条件 | 用的表/手段 | 排序 | snippet | 局限 |
| --- | --- | --- | --- | --- |
| unicode61 FTS5 | 查询不含 CJK | `messages_fts` | FTS5 `rank` | `snippet()` 内置 | CJK 失效 |
| trigram FTS5 | 含 CJK 且每个实词 token ≥3 CJK 字 | `messages_fts_trigram` | FTS5 `rank` | `snippet()` 内置 | 短 token 切不出三元组 |
| LIKE 兜底 | 含 CJK 但有实词 token <3 CJK 字 | `messages` 表 `LIKE` 扫描 | `timestamp DESC` | `substr`+`instr` 近似 | 全表扫描，无相关度排序 |

前两条都是真正的索引检索，有相关度 `rank` 排序；LIKE 兜底退化成按时间倒序的全表扫描，是「能搜到总比搜不到强」的保底。三条路径对调用方完全透明——`session_search` 工具只管传查询词，路由由 `search_messages` 内部决定。

两张表的存在也解释了 schema 演进：trigram 表是 v10 引入的，迁移逻辑见 9.2.1——检测 `messages_fts_trigram` 是否存在，不存在就建表并回填历史消息。

## 9.5 并发模型：WAL 与 NFS 兼容

### WAL 模式

`SessionDB` 默认开启 SQLite 的 WAL（Write-Ahead Logging）模式——它允许「多个读 + 一个写」并发不互相阻塞。这对网关至关重要：Telegram 会话在读历史时，Discord 会话可以同时写新消息。

理解 Hermes 的并发模型，要分清两个层次的并发：

<svg viewBox="0 0 800 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Two-layer concurrency model: in-process lock and inter-process WAL lock">
  <defs>
    <marker id="r9ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="20" y="24" font-size="13" font-weight="700" fill="currentColor">进程内 — 一个网关进程，多平台线程</text>
  <rect x="20" y="34" width="120" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="55" font-size="11" fill="currentColor" text-anchor="middle">Telegram 线程</text>
  <rect x="20" y="74" width="120" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="95" font-size="11" fill="currentColor" text-anchor="middle">Discord 线程</text>
  <rect x="20" y="114" width="120" height="34" rx="5" fill="#fed7aa" stroke="#ea580c"/>
  <text x="80" y="135" font-size="11" fill="currentColor" text-anchor="middle">Slack 线程</text>
  <rect x="270" y="64" width="200" height="54" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="370" y="86" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">一个 SessionDB</text>
  <text x="370" y="104" font-size="10" fill="#64748b" text-anchor="middle">self._conn · self._lock 串行化</text>
  <line x1="140" y1="51" x2="268" y2="80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <line x1="140" y1="91" x2="268" y2="91" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <line x1="140" y1="131" x2="268" y2="102" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <line x1="20" y1="166" x2="780" y2="166" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <text x="20" y="192" font-size="13" font-weight="700" fill="currentColor">进程间 — 网关 + 多个 CLI 会话 + worktree agent</text>
  <rect x="20" y="204" width="150" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="95" y="225" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">网关进程</text>
  <text x="95" y="242" font-size="10" fill="#64748b" text-anchor="middle">独立 SessionDB</text>
  <rect x="190" y="204" width="150" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="265" y="225" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">CLI 会话</text>
  <text x="265" y="242" font-size="10" fill="#64748b" text-anchor="middle">独立 SessionDB</text>
  <rect x="360" y="204" width="150" height="50" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="435" y="225" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">worktree agent</text>
  <text x="435" y="242" font-size="10" fill="#64748b" text-anchor="middle">独立 SessionDB</text>
  <rect x="560" y="200" width="220" height="58" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="670" y="222" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">同一个 state.db 文件</text>
  <text x="670" y="240" font-size="10" fill="#64748b" text-anchor="middle">WAL 写锁 + 应用层抖动重试</text>
  <line x1="95" y1="254" x2="600" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <line x1="265" y1="258" x2="600" y2="258" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
  <line x1="435" y1="254" x2="600" y2="248" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar1)"/>
</svg>
<span class="figure-caption">图 R9.1 ｜ 两层并发模型：进程内多线程靠 self._lock 串行化，进程间多实例靠 WAL 写锁 + 抖动重试协调。</span>

<details>
<summary>ASCII 原版</summary>

```text
进程内（一个网关进程，多个平台线程）
   │  Telegram 线程  ┐
   │  Discord 线程   ├─→  共用一个 SessionDB / 一个 self._conn
   │  Slack 线程     ┘     ── 用 self._lock 串行化
   │
进程间（网关 + 多个 CLI 会话 + worktree agent）
   │  各自独立的 SessionDB 实例 / 各自的连接
   │     ── 共享同一个 state.db 文件
   │     ── 用 SQLite 的 WAL 写锁 + 应用层抖动重试协调
```

</details>

**进程内**——所有平台线程共用同一个 `SessionDB` 对象和同一个 `self._conn`，靠 `self._lock` 这把 `threading.Lock` 串行化，保证同进程内不会有两个线程同时操作连接。**进程间**——多个 Hermes 进程各开各的 `SessionDB`、各连各的，但落到同一个 `state.db` 文件上，靠 SQLite 的 WAL 写锁来协调，谁拿不到锁谁就走 9.5.1 的抖动重试。这两层缺一不可：只有进程内锁挡不住别的进程，只靠 WAL 锁则会让同进程的线程白白互相竞争。

### 9.5.1 `_execute_write`：BEGIN IMMEDIATE + 抖动重试

所有写操作（`create_session`、`append_message`、`update_token_counts`……）都不直接碰 `self._conn`，而是把「要做什么」包成一个闭包 `fn`，交给 `_execute_write`（`hermes_state.py:375`，docstring 里也叫写事务）执行。它的完整骨架：

```python
def _execute_write(self, fn):
    last_err = None
    for attempt in range(self._WRITE_MAX_RETRIES):   # 15 次
        try:
            with self._lock:
                self._conn.execute("BEGIN IMMEDIATE")
                try:
                    result = fn(self._conn)
                    self._conn.commit()
                except BaseException:
                    try:
                        self._conn.rollback()
                    except Exception:
                        pass
                    raise
            self._write_count += 1
            if self._write_count % self._CHECKPOINT_EVERY_N_WRITES == 0:
                self._try_wal_checkpoint()
            return result
        except sqlite3.OperationalError as exc:
            err_msg = str(exc).lower()
            if "locked" in err_msg or "busy" in err_msg:
                last_err = exc
                if attempt < self._WRITE_MAX_RETRIES - 1:
                    jitter = random.uniform(0.020, 0.150)  # 20-150ms
                    time.sleep(jitter)
                    continue
            raise   # 非锁错误，或重试耗尽 —— 直接抛
```

逐点拆解这个设计：

- **`BEGIN IMMEDIATE` 而非默认的 `DEFERRED`**——`DEFERRED` 事务直到遇到第一个写语句才申请写锁，最坏情况是一路执行到 `COMMIT` 才发现锁拿不到、然后整个事务回滚重来。`IMMEDIATE` 在事务**一开始**就申请 WAL 写锁，锁竞争**立刻**暴露成 `database is locked`，配合下面的重试在毫秒级化解，而不是浪费一整个事务的工作量。
- **应用层重试 + 随机抖动**——SQLite 内置 busy handler 用确定性退避，多个写者会形成「车队」：一起醒来、一起重试、一起再失败。`_execute_write` 把超时压到 1 秒（见 9.1.1），自己用 `random.uniform(20ms, 150ms)` 的随机睡眠重试最多 15 次。随机抖动天然把竞争的写者错开，打散车队。
- **`with self._lock` 包住整个 BEGIN…commit**——进程内的多个线程串行化到这把锁上，先保证同进程内不会有两个线程同时持有 SQLite 写事务；跨进程的竞争才交给 SQLite 的写锁 + 上面的重试处理。
- **`except BaseException` 回滚**——注意不是 `Exception` 而是 `BaseException`，连 `KeyboardInterrupt`、`SystemExit` 都会触发回滚，确保任何中断都不会留下半截事务。`rollback()` 本身的失败被吞掉（`except: pass`），因为此刻的首要目标是把原始异常抛上去。
- **错误分类**——只有错误信息里含 `locked` 或 `busy` 才重试；其它 `OperationalError`（如磁盘满、schema 错误）立刻抛出，不做无谓重试。重试耗尽则抛出最后一次的 `last_err`。

调用方写起来很简洁，以 `end_session` 为例：

```python
def end_session(self, session_id, end_reason):
    def _do(conn):
        conn.execute(
            "UPDATE sessions SET ended_at = ?, end_reason = ? "
            "WHERE id = ? AND ended_at IS NULL",
            (time.time(), end_reason, session_id),
        )
    self._execute_write(_do)
```

闭包 `_do` 里只管写 SQL，**不许调 `commit()`**——提交由 `_execute_write` 统一负责。

### 9.5.2 WAL checkpoint：防 WAL 文件膨胀

WAL 模式下，写入先追加到 `state.db-wal` 文件，并不立即落进主库。如果一直没有 checkpoint，WAL 文件会无限增长——尤其当多个进程都持有长连接、谁也不主动 checkpoint 时。

`SessionDB` 的对策是**每 50 次成功写做一次 PASSIVE checkpoint**（`_CHECKPOINT_EVERY_N_WRITES = 50`，`hermes_state.py:330`）。`_execute_write` 每成功一次就 `self._write_count += 1`，整除 50 时调用 `_try_wal_checkpoint`（`hermes_state.py:427`）：

```python
def _try_wal_checkpoint(self):
    try:
        with self._lock:
            result = self._conn.execute(
                "PRAGMA wal_checkpoint(PASSIVE)"
            ).fetchone()
            if result and result[1] > 0:
                logger.debug("WAL checkpoint: %d/%d pages checkpointed",
                             result[2], result[1])
    except Exception:
        pass  # Best effort — never fatal.
```

关键词是 **PASSIVE**：PASSIVE checkpoint 只把「当前没有任何其它连接需要」的 WAL 帧刷回主库，**遇到正在被读的帧就跳过、绝不阻塞、绝不等待**。它换来的是「WAL 不会无限膨胀」，代价是「不保证每次都能把 WAL 清空」——但在多进程长连接的场景下，不阻塞比清得干净重要得多。整个方法用 `try/except: pass` 包住，checkpoint 失败对正确性毫无影响，纯属锦上添花。

`PRAGMA wal_checkpoint` 返回三元组 `(busy, log, checkpointed)`，`result[1]` 是 WAL 里的总帧数、`result[2]` 是这次刷回的帧数，仅用于 debug 日志。`close()` 时还会再补一次 PASSIVE checkpoint（见 9.1.2），让退出的进程也帮一把。

### NFS 回退

WAL 有个硬约束：它依赖共享内存（mmap）和 `fcntl` 字节范围锁来协调多连接。NFS、SMB/CIFS、某些 FUSE 挂载、WSL1 都不可靠地支持这些——在这些文件系统上 `PRAGMA journal_mode=WAL` 会直接抛 `sqlite3.OperationalError: locking protocol`（即 SQLITE_PROTOCOL）。

很多 Hermes 用户会把 `~/.hermes` 放在网络盘上。所以 `SessionDB` 不假设 WAL 一定能用——这套回退逻辑提取成了一个独立函数 `apply_wal_with_fallback`（`hermes_state.py:128`），`SessionDB.__init__` 和 `kanban_db.connect()` 共用它，保证两个数据库的行为一致：

```python
def apply_wal_with_fallback(conn, *, db_label="state.db"):
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        return "wal"
    except sqlite3.OperationalError as exc:
        msg = str(exc).lower()
        if not any(marker in msg for marker in _WAL_INCOMPAT_MARKERS):
            raise   # 无关的 OperationalError —— 不静默吞掉
        _log_wal_fallback_once(db_label, exc)
        conn.execute("PRAGMA journal_mode=DELETE")
        return "delete"
```

逻辑链条：

1. **先尝试 WAL**——大多数本地文件系统会成功，直接返回 `"wal"`。
2. **精确识别「文件系统不兼容」错误**——`_WAL_INCOMPAT_MARKERS`（`hermes_state.py:54`）是一个标志字符串元组：`"locking protocol"`（NFS/SMB 的 SQLITE_PROTOCOL）、`"not authorized"`（某些 FUSE 挂载直接禁掉 WAL pragma）、`"disk i/o error"`（WAL 建立期间网络盘抖动）。**只有**错误信息命中其中之一才回退；命中不到（比如真正的磁盘故障）就 `raise`——绝不把无关错误静默吞掉当成「正常回退」。
3. **回退到 `journal_mode=DELETE`**——DELETE 是 WAL 之前的老式回滚日志模式，在 NFS 上能稳定工作。代价是并发下降：写期间读者会被阻塞（不再是「多读 + 一写」），但功能不挂。
4. **每进程每库只 WARNING 一次**——`_log_wal_fallback_once`（`hermes_state.py:164`）用一个进程级 set `_wal_fallback_warned_paths` 去重。这一点很关键：kanban 每次操作都新开一次连接（约 30 处调用点），如果不去重，NFS 用户的 `errors.log` 一小时就会被几百条一模一样的告警刷爆。去重按 `db_label` 维度做——`state.db` 和 `kanban.db` 在同一个 NFS 挂载上各告警一次，互不干扰。

这是一个典型的 Hermes 设计取舍：不要求用户「别把数据放网络盘」，而是检测环境、优雅降级，并把降级原因清晰地告诉用户（见 9.1.1 的 `_last_init_error`）。

## 9.6 核心读写方法巡览

`SessionDB` 对外有几十个方法，但绝大多数会话流程只用到下面六个。把它们串起来看，就是一次会话从创建到检索的全生命周期。

### create_session —— 建会话

`create_session`（`hermes_state.py:713`）只是 `_insert_session_row`（`hermes_state.py:684`）的一层薄包装，核心是一句 `INSERT OR IGNORE`：

```python
conn.execute(
    """INSERT OR IGNORE INTO sessions (id, source, user_id, model, model_config,
       system_prompt, parent_session_id, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
    (session_id, source, user_id, model,
     json.dumps(model_config) if model_config else None,
     system_prompt, parent_session_id, time.time()),
)
```

`INSERT OR IGNORE` 是关键——它让建会话**幂等**：会话 ID 已存在就静默跳过，不会报主键冲突。这一点被反复利用：`update_token_counts`（`hermes_state.py:786`）在写计费前会先无条件 `_insert_session_row(session_id, "unknown", ...)` 兜底——并发高压下（cron + kanban + delegate_task）最初的 `create_session` 可能因 SQLite 锁失败，这句廉价的 `INSERT OR IGNORE` 确保后续的 `UPDATE` 不会因为「行不存在」而静默影响 0 行。

### end_session / reopen_session —— 结束与重开

`end_session`（`hermes_state.py:717`）给会话打上 `ended_at` 和 `end_reason`，SQL 里带一个 `AND ended_at IS NULL` 条件——**已结束的会话不会被再次结束**。这是一个刻意的「第一个 end_reason 胜出」语义：压缩拆分出来的会话带着 `end_reason = 'compression'` 的记录很重要，如果后来一个过期的 `end_session()` 调用（比如 `/resume` 或 `/branch` 之后 CLI 的 `session_id` 失步）用别的原因再结束它一次，那条 `compression` 记录不能被覆盖——`get_compression_tip` 的链判定就靠它。

如果确实需要把一个已结束的会话重新结束成别的原因，得先调 `reopen_session`（`hermes_state.py:735`）——它把 `ended_at` 和 `end_reason` 双双清成 NULL，会话回到「活跃」状态，`/resume` 续接前会用到它。

### append_message —— 追加一条消息

`append_message`（`hermes_state.py:1433`）是写得最频繁的方法。它的流程分两段：

1. **进事务前**——把所有结构化字段 JSON 序列化（`tool_calls`、`reasoning_details`、`codex_*` 等），把多模态 `content`（part 列表）用 `_encode_content` 编码——`sqlite3` 不能直接绑定 list/dict 参数。同时预计算 `num_tool_calls`。这些纯 CPU 工作放在写锁外，缩短持锁时间。
2. **进事务**——一条 `INSERT INTO messages`，拿到 `cursor.lastrowid`，再 `UPDATE sessions` 把 `message_count`（必要时连 `tool_call_count`）加一，返回新消息的行 ID。

整个第 2 步包在一个 `_execute_write` 闭包里，所以「插消息」和「更计数器」是**同一个事务**——计数器永远和消息数一致。两张 FTS 表则由触发器在同一事务内自动同步（见 9.6.2 的图）。

### get_messages —— 取原始消息

`get_messages`（`hermes_state.py:1599`）是最朴素的读：`SELECT * FROM messages WHERE session_id = ? ORDER BY id`，按插入顺序（自增主键）返回。它把每行转成 dict，并把 `content` 解码、`tool_calls` 反序列化回对象。反序列化失败时不抛异常，而是 `logger.warning` 后退化成 `[]`——一条坏数据不该让整个会话读不出来。这个方法返回的是**贴近数据库原始形态**的消息，`export_session`、`/history` 等用它。

### get_messages_as_conversation —— 取对话回放格式

`get_messages_as_conversation`（`hermes_state.py:1686`）才是网关 `/resume` 真正用的——它返回的是**可以直接喂回 LLM 的 OpenAI 对话格式**，和 `get_messages` 有几个关键差别：

- 只 `SELECT` 回放需要的列，重组成 `{"role": ..., "content": ...}` 字典。
- `user`/`assistant` 的纯文本 `content` 会过一遍 `sanitize_context()` 清洗。
- assistant 消息上按需还原 `finish_reason`、`reasoning`、`reasoning_content`、`reasoning_details`、`codex_*`——让支持推理回放的 provider（OpenRouter、OpenAI、Nous）拿到连贯的多轮推理上下文。
- `include_ancestors=True` 时，先用 `_session_lineage_root_to_tip` 把整条血缘链从根到尖排好，`session_id IN (...)` 一次性取出全链消息，并用 `_is_duplicate_replayed_user_message` 去掉跨会话边界重复的用户消息。

`_session_lineage_root_to_tip`（`hermes_state.py:1756`）的走法和 9.8 里那些方法相反——它沿 `parent_session_id` 向**父代**方向回溯，把从当前会话一路到根的链条收集起来，再反转成「根 → 尖」的顺序。同样有 100 层的深度上限和 `seen` 集合防环。这样 `get_messages_as_conversation(include_ancestors=True)` 用一条 `IN (...)` 查询、按全局 `id` 排序，就能把一整条被压缩拆分过的对话完整、有序地还原成可回放的消息流。这正是「压缩拆分对上层透明」的关键一环——上层只看到一段连贯历史，不必关心它底下被切成了几个会话。

### search_messages —— 全文检索

见 9.3 / 9.4，是 FTS5 的对外入口，内部在 unicode61 / trigram / LIKE 三条路径间路由。命中之后它还做了一件对「回忆」很重要的事——**为每个命中补上下文**：`hermes_state.py:2083` 起的查询用 `WITH target AS (...)` 取出命中消息的 `(session_id, timestamp, id)`，再用三段 `UNION ALL` 分别取「同会话里时间紧挨在前的一条」「命中消息本身」「时间紧挨在后的一条」。这样 `session_search` 拿到的不是孤零零一句话，而是「前一句 + 命中句 + 后一句」的小片段，辅助 LLM 更容易把它总结成连贯回忆。排序用 `(timestamp, id)` 复合键——同一时间戳下还能靠自增 `id` 稳定定序。

这段补上下文的查询在写锁内逐个命中执行，但**整体放在主查询的锁之外**——不会因为补 N 次上下文而长时间占着锁阻塞其它读者。最后 `match.pop("content", None)` 把完整 `content` 从结果里删掉，只留 `snippet`，给调用方省 token。

`snippet(messages_fts, 0, '>>>', '<<<', '...', 40)` 是 FTS5 内置的摘要函数：在命中词周围截一段、用 `>>>`/`<<<` 高亮命中词、最多 40 个 token、省略部分用 `...`。LIKE 兜底路径没有 `snippet()` 可用，改用 `substr(content, max(1, instr(content, ?) - 40), 120)` 手工在命中位置前后截 120 字近似。

### search_sessions —— 列会话

`search_sessions`（`hermes_state.py:2151`）和 `search_messages` 名字像，干的是另一件事——它不做全文检索，而是**列出会话**，可按 `source` 过滤。它的查询里有一个 `LEFT JOIN` 子查询算出每个会话的 `last_active`（该会话最后一条消息的时间戳，没有消息则回退到 `started_at`），并据此 `ORDER BY last_active DESC` 把最近活跃的会话排在前面。`/history`、会话列表 UI 用它。

### update_token_counts —— 增量 vs 绝对两种写法

`update_token_counts`（`hermes_state.py:753`）维护整组计费字段，它有一个 `absolute` 开关决定写入语义：

- **`absolute=False`（默认，增量）**——SQL 是 `input_tokens = input_tokens + ?`，用于「每次 API 调用的 delta」。CLI 路径每完成一次 API 调用就把这次的 token 增量累加上去。
- **`absolute=True`（绝对）**——SQL 是 `input_tokens = ?` 直接覆盖，用于调用方手里已经握着「累计总量」的场景。网关路径里那个缓存的 agent 对象跨多条消息自己累加，到点直接把累计值绝对写入，避免重复累加。

两套 SQL 大量用 `COALESCE` 处理 NULL：增量模式下 `estimated_cost_usd = COALESCE(estimated_cost_usd, 0) + COALESCE(?, 0)`——旧值为 NULL 当 0，新值为 NULL 也当 0。`billing_provider`/`billing_base_url`/`billing_mode` 则用 `COALESCE(billing_provider, ?)`——**只在原值为空时填**，已有的计费归属不被后续调用覆盖。`actual_cost_usd` 用 `CASE WHEN ? IS NULL THEN ... ELSE ...` 区分「没传实际成本」和「实际成本就是 0」。

### replace_messages —— 原子重写整段转录

`replace_messages`（`hermes_state.py:1520`）服务于 `/retry`、`/undo`、`/compress` 这类需要**重写整段对话历史**的流程。它在一个 `_execute_write` 闭包里完成：`DELETE` 掉该会话所有消息、把计数器清零、逐条重新 `INSERT`、最后把 `message_count`/`tool_call_count` 设成正确的总数。「删 + 重插」必须是一个事务——中途失败绝不能给 SQLite 留下半截转录。重插时给每条消息的 `timestamp` 递增一个 `1e-6` 的微小步长，保证即便原本时间戳相同，消息间也有稳定的先后次序。

## 9.6.1 一次会话的完整生命周期

把上面六个方法串成一条时间线，就能看清一次会话在存储层留下的全部痕迹：

<svg viewBox="0 0 760 470" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Complete lifecycle of a session in the storage layer">
  <defs>
    <marker id="r9ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="230" y="14" width="300" height="30" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="380" y="34" font-size="11" fill="currentColor" text-anchor="middle">用户在 Telegram 里发起对话</text>
  <line x1="380" y1="44" x2="380" y2="56" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <rect x="150" y="56" width="460" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="170" y="76" font-size="11" font-weight="600" fill="currentColor">create_session(id, source="telegram")</text>
  <text x="600" y="76" font-size="10" fill="#64748b" text-anchor="end">sessions 插入一行</text>
  <line x1="380" y1="88" x2="380" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <rect x="150" y="100" width="460" height="32" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="170" y="120" font-size="11" font-weight="600" fill="currentColor">update_system_prompt(id, prompt)</text>
  <text x="600" y="120" font-size="10" fill="#64748b" text-anchor="end">落下系统提示快照</text>
  <line x1="380" y1="132" x2="380" y2="144" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <rect x="110" y="144" width="540" height="124" rx="8" fill="#99f6e4" stroke="#0d9488"/>
  <text x="124" y="164" font-size="11" font-weight="700" fill="currentColor">每一轮对话（循环）</text>
  <rect x="130" y="174" width="500" height="22" rx="4" fill="#fff" fill-opacity="0.5" stroke="#0d9488" stroke-opacity="0.4"/>
  <text x="142" y="189" font-size="10" fill="currentColor">append_message("user", …)  → messages + 2×FTS + 计数器</text>
  <rect x="130" y="200" width="500" height="22" rx="4" fill="#fff" fill-opacity="0.5" stroke="#0d9488" stroke-opacity="0.4"/>
  <text x="142" y="215" font-size="10" fill="currentColor">append_message("assistant", …)  → 同上，带 reasoning 字段</text>
  <rect x="130" y="226" width="500" height="22" rx="4" fill="#fff" fill-opacity="0.5" stroke="#0d9488" stroke-opacity="0.4"/>
  <text x="142" y="241" font-size="10" fill="currentColor">append_message("tool", …)  → 同上，tool_call_count++</text>
  <rect x="130" y="252" width="500" height="22" rx="4" fill="#fff" fill-opacity="0.5" stroke="#0d9488" stroke-opacity="0.4"/>
  <text x="142" y="267" font-size="10" fill="currentColor">update_token_counts(id, delta)  → 计费字段累加</text>
  <line x1="380" y1="268" x2="380" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <text x="395" y="280" font-size="10" fill="#dc2626">上下文涨满，触发压缩</text>
  <rect x="150" y="284" width="460" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="170" y="304" font-size="11" font-weight="600" fill="currentColor">end_session(id, "compression")</text>
  <text x="600" y="304" font-size="10" fill="#64748b" text-anchor="end">ended_at + end_reason</text>
  <line x1="380" y1="316" x2="380" y2="328" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <rect x="150" y="328" width="460" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="170" y="348" font-size="11" font-weight="600" fill="currentColor">create_session(id2, parent_session_id=id)</text>
  <text x="600" y="348" font-size="10" fill="#64748b" text-anchor="end">fork 子会话，拆分链 +1</text>
  <line x1="380" y1="360" x2="380" y2="376" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <text x="395" y="372" font-size="10" fill="#64748b">用户隔天 /resume</text>
  <rect x="150" y="376" width="460" height="32" rx="6" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="170" y="396" font-size="11" font-weight="600" fill="currentColor">resolve_resume_session_id(id) → id2</text>
  <text x="600" y="396" font-size="10" fill="#64748b" text-anchor="end">重定向到有消息的子会话</text>
  <line x1="380" y1="408" x2="380" y2="420" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar2)"/>
  <rect x="150" y="420" width="460" height="38" rx="6" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="170" y="437" font-size="11" font-weight="600" fill="currentColor">get_messages_as_conversation(id2,</text>
  <text x="170" y="451" font-size="11" font-weight="600" fill="currentColor">  include_ancestors=True)  ── 沿链还原完整历史</text>
</svg>
<span class="figure-caption">图 R9.2 ｜ 一次会话的完整生命周期：创建 → 每轮追加消息 → 压缩拆分 → 隔天 /resume 沿链还原。</span>

<details>
<summary>ASCII 原版</summary>

```text
用户在 Telegram 里发起对话
   │
   ▼
create_session(id, source="telegram")        ── sessions 插入一行
   │
   ▼
update_system_prompt(id, prompt)              ── 落下系统提示快照
   │
   ▼ ┌────────── 每一轮对话 ──────────┐
   │ │ append_message("user", ...)    │  ── messages + 2×FTS + 计数器
   │ │ append_message("assistant",...)│  ── 同上，带 reasoning 字段
   │ │ append_message("tool", ...)    │  ── 同上，tool_call_count++
   │ │ update_token_counts(id, delta) │  ── 计费字段累加
   │ └────────────────────────────────┘
   │
   ▼ （上下文涨满，触发压缩）
end_session(id, "compression")                ── 打上 ended_at + end_reason
create_session(id2, parent_session_id=id)     ── fork 子会话，拆分链 +1
   │
   ▼ （用户隔天 /resume）
resolve_resume_session_id(id) → id2           ── 重定向到有消息的子会话
get_messages_as_conversation(id2,
                  include_ancestors=True)     ── 沿链还原完整历史
```

</details>

`sessions` 表攒下元数据与计费，`messages` 表攒下逐条转录，两张 FTS 表攒下检索索引——三者由触发器和单事务保证永不失步。后续无论是 `/resume` 续接、`session_search` 回忆，还是 `export_all` 做成本统计，读的都是这套在对话进行中就已经一致落盘的数据。

## 9.6.2 一次 append_message 如何同时更新三张表

`append_message` 表面上只对 `messages` 表 `INSERT` 了一行，但因为 `messages` 上挂着 FTS 触发器，一次插入会在**同一个事务**里连带写三张表：

<svg viewBox="0 0 780 400" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="One append_message writes three tables atomically in a single transaction">
  <defs>
    <marker id="r9ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="300" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="34" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">append_message(role, content, tool_calls, …)</text>
  <line x1="390" y1="46" x2="390" y2="58" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <rect x="120" y="58" width="540" height="296" rx="10" fill="#7c3aed" fill-opacity="0.07" stroke="#7c3aed" stroke-dasharray="4,3"/>
  <text x="140" y="78" font-size="11" font-weight="700" fill="#7c3aed">_execute_write 闭包  ── BEGIN IMMEDIATE</text>
  <rect x="200" y="90" width="380" height="34" rx="6" fill="#0d9488" fill-opacity="0.18" stroke="#0d9488"/>
  <text x="390" y="111" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">INSERT INTO messages (…) VALUES (…)</text>
  <line x1="390" y1="124" x2="390" y2="142" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <text x="400" y="138" font-size="9" fill="#64748b">AFTER INSERT 触发器自动触发</text>
  <line x1="390" y1="142" x2="225" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <line x1="390" y1="142" x2="390" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <line x1="390" y1="142" x2="555" y2="158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <rect x="140" y="160" width="160" height="100" rx="8" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="220" y="182" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">messages_fts</text>
  <text x="220" y="200" font-size="10" fill="#64748b" text-anchor="middle">unicode61</text>
  <text x="220" y="222" font-size="10" fill="#64748b" text-anchor="middle">INSERT rowid +</text>
  <text x="220" y="238" font-size="10" fill="#64748b" text-anchor="middle">content || tool_name</text>
  <text x="220" y="252" font-size="10" fill="#64748b" text-anchor="middle">|| tool_calls</text>
  <rect x="310" y="160" width="160" height="100" rx="8" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="390" y="182" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">messages_fts_trigram</text>
  <text x="390" y="200" font-size="10" fill="#64748b" text-anchor="middle">trigram</text>
  <text x="390" y="222" font-size="10" fill="#64748b" text-anchor="middle">INSERT rowid +</text>
  <text x="390" y="238" font-size="10" fill="#64748b" text-anchor="middle">content || tool_name</text>
  <text x="390" y="252" font-size="10" fill="#64748b" text-anchor="middle">|| tool_calls</text>
  <rect x="480" y="160" width="160" height="100" rx="8" fill="#fed7aa" stroke="#ea580c"/>
  <text x="560" y="182" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">回到闭包</text>
  <text x="560" y="204" font-size="10" fill="#64748b" text-anchor="middle">UPDATE sessions</text>
  <text x="560" y="222" font-size="10" fill="#64748b" text-anchor="middle">message_count += 1</text>
  <text x="560" y="240" font-size="10" fill="#64748b" text-anchor="middle">tool_call_count += N</text>
  <line x1="220" y1="260" x2="380" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <line x1="390" y1="260" x2="390" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <line x1="560" y1="260" x2="400" y2="298" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r9ar3)"/>
  <rect x="290" y="300" width="200" height="36" rx="6" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a"/>
  <text x="390" y="323" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">commit ── 四处写入原子生效</text>
</svg>
<span class="figure-caption">图 R9.3 ｜ 一次 append_message：messages 行、两张 FTS 索引、sessions 计数器在同一事务内原子写入，永不失步。</span>

<details>
<summary>ASCII 原版</summary>

```text
                    append_message(role, content, tool_calls, ...)
                                      │
                                      ▼
                       _execute_write 闭包  ── BEGIN IMMEDIATE
                                      │
              ┌───────────────────────┴───────────────────────┐
              │   INSERT INTO messages (...) VALUES (...)      │
              └───────────────────────┬───────────────────────┘
                                      │  AFTER INSERT 触发器自动触发
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
   ┌────────────────────┐  ┌────────────────────┐  ┌────────────────────┐
   │  messages_fts      │  │ messages_fts_trigram│  │  (回到闭包)         │
   │  (unicode61)       │  │  (trigram)          │  │  UPDATE sessions    │
   │  INSERT rowid +    │  │  INSERT rowid +     │  │  message_count += 1 │
   │  content||tool_name│  │  content||tool_name │  │  tool_call_count    │
   │  ||tool_calls      │  │  ||tool_calls       │  │  += N               │
   └────────────────────┘  └────────────────────┘  └────────────────────┘
              │                       │                       │
              └───────────────────────┴───────────────────────┘
                                      │
                                  commit  ── 四处写入原子生效
```

</details>

四处写入（`messages` 行、两张 FTS 索引、`sessions` 计数器）要么一起成功、要么一起回滚。这正是用 SQLite + 触发器而非 JSON 文件的价值：索引和数据**不可能失步**——不存在「消息存了但搜不到」或「计数器和消息数对不上」的中间态。代价是每次 `append_message` 都要付两张 FTS 表的写入成本，但会话写入本来就不是热路径，这个代价可以接受。

## 9.7 会话标题与去重

`title` 字段上有一个唯一索引 `idx_sessions_title_unique`（`hermes_state.py:660`，`WHERE title IS NOT NULL` 的部分索引——允许多个会话 `title` 为 NULL）。这意味着两个会话不能有完全相同的标题。但压缩拆分（见 9.8）会产生「同一个对话的多段」，它们需要相关但不冲突的标题。Hermes 用「血缘编号」解决：`my session` → `my session #2` → `my session #3`。

`resolve_session_by_title`（`hermes_state.py:1062`）和 `get_next_title_in_lineage`（`hermes_state.py:1091`）都要按「`base #N`」模式去库里搜。这里有一个容易踩的坑：用户的标题里可能本身就含 SQL `LIKE` 的通配符 `%` 和 `_`。如果直接 `title LIKE 'my_session #%'`，那个 `_` 会被当成「任意一个字符」的通配符，匹配到 `my-session #2`、`myXsession #2` 之类的无关会话。

解法是先转义、再用 `ESCAPE` 子句声明转义符：

```python
escaped = base.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
cursor = self._conn.execute(
    "SELECT title FROM sessions WHERE title = ? OR title LIKE ? ESCAPE '\\'",
    (base, f"{escaped} #%"),
)
```

`escaped` 把标题里的 `\`、`%`、`_` 全部前缀 `\`，再用 `ESCAPE '\'` 告诉 SQLite「`\` 后面的 `%`/`_` 是字面字符」。这样 `LIKE` 模式里**只有结尾我们自己拼的 `#%`** 是真通配符，用户标题部分一律按字面匹配。`resolve_session_by_title`（`hermes_state.py:1075`）和 `get_next_title_in_lineage`（`hermes_state.py:1106`）用的是同一套转义逻辑。

`get_next_title_in_lineage` 的算法：先用正则 `^(.*?) #(\d+)$` 剥掉已有的 `#N` 后缀拿到真正的 base，再把 `base` 本身和所有 `base #N` 变体一次查出来，扫出最大编号 `max_num`（无后缀的原始标题算作 `#1`），返回 `base #{max_num + 1}`。没有任何冲突时直接返回裸 `base`。

## 9.8 会话拆分链

`sessions` 表那个 `parent_session_id` 字段，是为上下文压缩服务的。当一次对话长到触发压缩（见[第 8 章](08-context-compression.md)），Hermes 不是原地改写历史，而是开一个**新会话**，把它的 `parent_session_id` 指向旧会话——形成一条链：

```text
session_A ──parent──> session_B ──parent──> session_C
（最早）                              （当前活跃）
```

这样做的好处是历史不可变：压缩前的完整原文留在 `session_A` 里可追溯，当前活跃的 `session_C` 持有压缩后的精简上下文。`idx_sessions_parent` 索引让「沿着链往上找祖先」很快。

但拆分链也带来一个真实的坑（#15000）：压缩把当前会话标记为 `ended`、fork 出新子会话，flush cursor 重置后，**新消息其实落在子会话里**，父会话可能 `message_count = 0`。如果用户 `/resume` 的目标恰好是那个空的父会话，会续到一段空对话。`resolve_resume_session_id`（`hermes_state.py:1621`）专门处理这个：

- 若 `session_id` 自己就有消息行，直接返回——无需重定向。
- 否则沿 `parent_session_id` 向**子代**方向走（每步挑 `started_at` 最新的子会话），找到第一个真正有消息行的后代并返回。
- 深度上限 32，并用 `seen` 集合防止畸形数据里的环。

另一个相关方法 `get_compression_tip`（`hermes_state.py:1126`）解决的是「找到压缩链最尖端」。它向子代方向走，但加了一个判定来区分「压缩续接」和别的子会话：子会话必须满足「父会话 `end_reason = 'compression'`」**且**「子会话 `started_at >= 父会话 ended_at`」。第二个条件很重要——delegate 子 agent、`/branch` 子会话也有 `parent_session_id`，但它们是在父会话**还活着**时创建的，时间戳判定能把它们排除掉。

## 9.9 跨会话回忆：session_search 工具

`SessionDB` 提供能力，`session_search` 工具（`tools/session_search_tool.py`）把它包装成 agent 可调用的形式。它是 Hermes 学习闭环的一环：

1. agent 想起「用户以前提过类似的事」，调 `session_search`，给一个查询词。
2. 工具调 `SessionDB.search_messages()`（必要时也用 `search_sessions()`，`hermes_state.py:2151`）拿到 FTS5 命中的消息片段。
3. 命中片段往往零碎，工具再调一个**辅助 LLM**（见[第 7 章](07-model-providers.md)）把它们总结成连贯的回忆，喂回主对话。

于是 agent 拥有了「翻自己旧账」的能力——这正是 README 所说「searches its own past conversations」。存储层的全文索引是这件事的物理基础。

## 9.10 导出、清理与计数

`SessionDB` 还有一组面向运维和分析的方法：

- `export_session`（`hermes_state.py:2217`）—— 把单个会话连同全部消息打成一个 dict。
- `export_all`（`hermes_state.py:2225`）—— 把所有会话导出成 dict 列表，适合写成 JSONL 备份/离线分析；它内部用 `search_sessions(limit=100000)` 拿全量会话再逐个取消息。
- `clear_messages`（`hermes_state.py:2237`）—— 删掉某会话全部消息并把计数器清零，走 `_execute_write` 事务。
- `session_count` / `message_count`（`hermes_state.py:2191`/`2202`）—— 简单的计数查询，可按 `source` 或 `session_id` 过滤。

这组方法解释了本章开头第三个动机——「这个月花了多少钱」「哪个模型用得最多」这类问题，导出后用 SQL 的 `SUM`/`GROUP BY` 一行就能算，根本不需要写脚本去 grep JSON。`sessions` 表那一整组计费字段（见 9.2）就是为这种结构化统计准备的。

## 9.11 小结：存储层的几条设计原则

把本章的细节抽象一下，`SessionDB` 反复体现了几条原则：

- **无损落盘，归一化留给上层**——五个推理字段、多模态 content、每种 provider 的 codex item 都原样存，存储层不做有损归一化。
- **声明式优于命令式**——`SCHEMA_SQL` 是 schema 的唯一真相，加列靠对账自愈，而不是手写迁移链。
- **检测环境、优雅降级**——NFS 上 WAL 不可用就回退 DELETE，并把原因告诉用户，而不是要求用户改环境。
- **best-effort 与正确性分层**——WAL checkpoint、关闭时 checkpoint、debug 日志全部 `try/except: pass`，它们失败不影响正确性；而事务原子性、计数器一致性这些则用 `BEGIN IMMEDIATE` + 单事务严格保证。
- **结构上杜绝注入**——过滤值一律参数化，唯一无法参数化的 FTS5 query 单独做六步清洗。

---

## 延伸阅读

- 上下文压缩如何触发会话拆分 → [第 8 章 上下文压缩与轨迹压缩](08-context-compression.md)
- 网关为何需要单进程多平台并发写 → [第 13 章 消息网关与多平台](13-messaging-gateway.md)
- `cache_*_tokens` 字段背后的 prompt caching → [第 4 章 系统提示与上下文构造](04-system-prompt.md)
- `title` 字段由谁异步填充、辅助 LLM 如何选 → [第 7 章 模型 Provider 适配与凭证池](07-model-providers.md)
- 会话持久化在一次真实请求中的位置 → [Trace 步骤 18](tour-18-session-persist.md)
- `session_search` 与记忆系统如何共同构成学习闭环 → [第 10 章 记忆系统与学习闭环](10-memory-system.md)
