# 第 14 章 Cron 调度、子 Agent 派发与批量运行

到目前为止，我们看到的 `AIAgent` 总是被一个人**实时**驱动着：用户在 CLI 或某个消息平台上敲一句话，agent 跑一轮工具调用循环，把结果回给用户，等下一句。这是**交互式**模式。

但 Hermes 还有三种把 `AIAgent` 跑起来的方式，它们的共同点是——**没有人在场**：

1. **Cron 调度**：到点了自动跑（"每天早上 8 点给我汇总新闻"）。
2. **子 Agent 派发**：一个 agent 自己 fork 出若干个子 agent 并行干活。
3. **批量运行**：拿一个 JSONL 数据集，对每条样本各跑一个 agent（多用于生成训练轨迹）。

本章把这三者放在一起讲，因为它们本质上是同一个工程命题的三种实例化：**如何在没有用户在场的情况下，安全地驱动 agent。** 最后一节会点出三者真正的共同点。

---

## 14.1 共同命题：非交互式驱动 agent

先把交互式和非交互式的区别摆清楚。一个 agent 在工具调用循环里跑到一个"危险操作"（删文件、跑 `rm`、网络写操作）时，需要批准。交互式模式下，批准来自用户——CLI 弹一个确认提示，或网关发一张确认卡片，人点"同意"。

非交互式模式下没有人。于是必须回答三个问题：

<svg viewBox="0 0 800 240" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Interactive vs non-interactive agent driving comparison">
  <defs/>
  <rect x="280" y="20" width="240" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="400" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">交互式 CLI</text>
  <rect x="540" y="20" width="240" height="34" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="660" y="42" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">非交互式 cron/delegate/batch</text>
  <g font-size="11">
    <text x="20" y="84" font-weight="600" fill="currentColor">危险操作</text>
    <text x="20" y="124" font-weight="600" fill="currentColor">谁在场</text>
    <text x="20" y="164" font-weight="600" fill="currentColor">输出去哪</text>
    <text x="20" y="204" font-weight="600" fill="currentColor">澄清提问</text>
  </g>
  <g font-size="11" fill="#64748b">
    <rect x="280" y="68" width="240" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="400" y="88" text-anchor="middle">人来批准</text>
    <rect x="280" y="108" width="240" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="400" y="128" text-anchor="middle">用户</text>
    <rect x="280" y="148" width="240" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="400" y="168" text-anchor="middle">回到终端 / 原聊天</text>
    <rect x="280" y="188" width="240" height="32" rx="4" fill="#fff" stroke="#cbd5e1"/>
    <text x="400" y="208" text-anchor="middle">人来回答</text>
    <rect x="540" y="68" width="240" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
    <text x="660" y="88" text-anchor="middle">auto-approve 或 auto-deny</text>
    <rect x="540" y="108" width="240" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
    <text x="660" y="128" text-anchor="middle">没有人</text>
    <rect x="540" y="148" width="240" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
    <text x="660" y="168" text-anchor="middle">delivery 路由 / 父 agent / 写轨迹</text>
    <rect x="540" y="188" width="240" height="32" rx="4" fill="#f1f5f9" stroke="#94a3b8"/>
    <text x="660" y="208" text-anchor="middle">禁用 clarify 工具（没人能答）</text>
  </g>
</svg>
<span class="figure-caption">图 R14.1 ｜ 交互式 CLI 与非交互式驱动在批准、在场、输出、澄清四个维度上的对比。</span>

<details>
<summary>ASCII 原版</summary>

```text
              交互式 CLI          非交互式（cron / delegate / batch）
  ──────────  ──────────────────  ──────────────────────────────────
  危险操作    人来批准            auto-approve 或 auto-deny
  谁在场      用户                没有人
  输出去哪    回到终端 / 原聊天   delivery 路由（cron）/ 返回父 agent / 写轨迹
  澄清提问    人来回答            禁用 clarify 工具（没人能答）
```

</details>

这三件事——批准策略、输出路由、禁用交互工具——是贯穿本章的主线。Cron、delegate、batch 各自给出了自己的答案，但思路一致。

还有一个第四件事：**成本**。交互式模式下，用户实时看着 token 消耗、看着账单，跑偏了能随手 Ctrl-C。非交互式模式下没人盯着——一个写错的 cron 作业可以每小时烧一次钱、一个失控的派发树可以并发 fork 出几十个 agent、一个大数据集的 batch 可以跑几千个 agent。所以这三种模式都内建了成本闸门：cron 默认剔除昂贵工具集、delegate 有深度上限和并发上限、batch 有 `batch_size` 与 worker 数限制。本章会反复看到这条线索。

为什么把它们放进同一章而不是各写一节散落各处？因为一旦你理解了"非交互式驱动"这个抽象，三者就从三个孤立的功能变成同一个模式的三次实例化——读懂一个，另外两个的设计取舍几乎可以推导出来。本章最后一节（14.5）会把这个抽象明确收口。

---

## 14.2 Cron 调度

Cron 让 Hermes 在指定时间自动跑一个 agent 任务。代码分两个文件：`cron/jobs.py` 管存储与作业模型，`cron/scheduler.py` 管"到点检查并执行"。

### 存储：cron/jobs.py

作业存储路径在 `cron/jobs.py:37-45`：

```python
# cron/jobs.py:37 起
HERMES_DIR = get_hermes_home().resolve()
CRON_DIR = HERMES_DIR / "cron"           # ~/.hermes/cron
JOBS_FILE = CRON_DIR / "jobs.json"       # 所有作业的清单
OUTPUT_DIR = CRON_DIR / "output"         # 每作业的历史输出
```

所有作业以 JSON 数组的形式存在 `jobs.json` 里。一个作业（job）是一个 dict，关键字段：

| 字段 | 含义 |
|------|------|
| `id` | 12 字符十六进制作业 ID |
| `name` | 人类可读名 |
| `schedule` | 调度表达式（cron 表达式 / `every 30m` / ISO 时间戳） |
| `prompt` | 给 agent 的提示词 |
| `skills` | 运行前要加载的技能列表（见[第 6 章](06-skills.md)） |
| `script` | 可选的数据采集脚本，输出注入提示 |
| `delivery` / `deliver` | 输出投递目标（见[第 13 章](13-messaging-gateway.md) 的 `DeliveryTarget`） |
| `enabled_toolsets` | 这个作业可用的工具集 |
| `enabled` | 是否启用（false = 暂停） |
| `next_run_at` | 下次运行的时间戳 |
| `workdir` | 可选的工作目录 |
| `no_agent` | 若为真，纯脚本作业，完全不调 LLM |
| `repeat` | `{times, completed}`，控制重复次数与计数 |
| `context_from` | 引用其它作业最近输出作为上下文的作业 ID 列表 |
| `origin` | 作业创建时所在的聊天，供 `deliver: origin` 还原 |
| `last_status` / `last_error` / `last_delivery_error` | 上次运行的终态 |

一个由 `create_job()`（`jobs.py:482`）生成的作业记录大致长这样——这里是一个"每天早上 8 点汇总科技新闻并发到 Telegram"的作业：

```json
{
  "id": "a3f9c1e07b22",
  "name": "每日科技新闻汇总",
  "prompt": "搜索过去 24 小时的重要科技新闻，按主题分类总结成简报。",
  "skills": [],
  "schedule": {"kind": "cron", "expr": "0 8 * * *", "display": "0 8 * * *"},
  "schedule_display": "0 8 * * *",
  "repeat": {"times": null, "completed": 12},
  "enabled": true,
  "state": "scheduled",
  "next_run_at": "2026-05-18T08:00:00+08:00",
  "last_run_at": "2026-05-17T08:00:03+08:00",
  "last_status": "ok",
  "deliver": "telegram",
  "enabled_toolsets": ["web"],
  "no_agent": false
}
```

`repeat.times: null` 表示无限重复；`completed: 12` 是已跑次数；`state` 是 `scheduled` / `paused` / `error` / `completed` 之一。一次性作业（`schedule.kind == "once"`）会自动带 `repeat.times: 1`，跑完即被 `mark_job_run()` 删除。

`schedule` 字段由 `parse_schedule()`（`cron/jobs.py:184`）解析，支持三种写法：标准 cron 表达式（靠 `croniter`）、`every <duration>` 自然语言、ISO 时间戳（一次性作业）。`jobs.json` 的读-改-写循环受一个进程内锁 `_jobs_file_lock`（`cron/jobs.py:44`）保护——因为 `tick()` 会并行跑多个作业，并发的 `mark_job_run` / `advance_next_run` 不加锁会互相覆盖。

### jobs.json 的原子写入与自愈

`jobs.json` 是 cron 子系统的唯一真相源，它的读写有两层防护。`save_jobs()`（`jobs.py:430`）从不就地改写文件——它先 `mkstemp` 一个临时文件、写入、`flush` + `fsync` 落盘，再用 `atomic_replace()` 原子地替换正式文件。这保证任何时刻读到的 `jobs.json` 要么是改动前的完整状态、要么是改动后的完整状态，绝不会读到写到一半的半截 JSON——即使进程在写入过程中被杀。

`load_jobs()`（`jobs.py:401`）则有一层**自愈**：如果 `json.load()` 因为字符串里有裸控制字符而失败，它会用 `strict=False` 重试解析，成功后立刻 `save_jobs()` 重写一遍（用正确的转义），并 `logger.warning` 留痕。只有连 `strict=False` 都救不回来时，才抛 `RuntimeError("Cron database corrupted and unrepairable")`。这套设计的意图是：`jobs.json` 可能被用户手动编辑过（文档里允许这么做），手编很容易引入小瑕疵，自愈让这些小瑕疵不至于让整个 cron 子系统瘫痪。

存储目录还有权限收紧：`_secure_dir()` / `_secure_file()`（`jobs.py:134-148`）把 `~/.hermes/cron/` 设为 `0700`、`jobs.json` 设为 `0600`——cron 作业的 prompt 里可能含敏感指令，作业输出里可能含私密数据，所以只对属主可读写。Windows 上 `chmod` 不支持时静默跳过。

`workdir` 字段也在创建时被 `_normalize_workdir()`（`jobs.py:449`）校验：必须是**绝对路径**，相对路径直接拒绝。理由很硬——cron 作业是脱离任何 shell 的 cwd 跑的，相对路径没有稳定的参照系。校验只在创建/更新时做一次，运行时不再重复检查（用户可能临时卸载了某个目录，调度器此时回落到旧行为并记一条警告，而不是让作业崩溃）。

### schedule 的三种 kind

`parse_schedule()` 不存原始字符串，而是把它**规范化成一个结构化 dict**，`kind` 字段把后续所有调度计算分成三条互斥路径：

```python
# cron/jobs.py:184 起（返回值形态）
{"kind": "interval", "minutes": 30,  "display": "every 30m"}        # 周期
{"kind": "cron",     "expr": "0 9 * * *", "display": "0 9 * * *"}   # cron 表达式
{"kind": "once",     "run_at": "2026-02-03T14:00:00+08:00", "display": "once at ..."}  # 一次性
```

三种写法的判定顺序（`jobs.py:207-262`）是有意排的：先看是不是 `every <duration>` 前缀（周期任务），再用正则 `^[\d\*\-,/]+$` 检查前 5 个字段是否构成合法 cron 表达式（必须 `croniter` 可用且能构造成功），再看含不含 `T` 或形如日期的串（ISO 时间戳，走一次性），最后才把裸 `30m`/`2h`/`1d` 当成"从现在起 N 分钟后跑一次"。判定顺序决定了歧义优先级——例如 `every` 一定先于 cron 被消费掉。

**cron 表达式 vs ISO datetime 的语义差别**值得强调：

- cron 表达式（`kind: cron`）描述的是**重复发生的时刻集合**。每次跑完，`compute_next_run()` 喂给 `croniter` 一个"当前时间"算出下一次。它没有"过期"概念——永远有下一次。
- ISO datetime（`kind: once`）描述的是**单个时刻**。它天然是一次性作业（`jobs.py:554` 把 `kind == "once"` 且未指定 `repeat` 的作业自动设为 `repeat=1`），跑完即删。`jobs.py:242` 在解析时就把 naive 时间戳转成带时区的——避免存储值依赖于"创建时和检查时系统时区一致"这种隐式假设。
- `interval`（`every 30m`）介于两者之间：是重复的，但下一次永远是"上次 + minutes"，与挂钟整点无关。

### 时区与遗漏作业的处理

cron 调度最容易出错的地方是时区和"网关宕机期间错过的作业"。Hermes 用两个辅助函数兜底。`_ensure_aware()`（`jobs.py:273`）把所有 naive 时间戳按"系统本地时间"解释后转换到 Hermes 配置时区——这保证旧版本存下的、没带时区的时间戳在时区变更后仍能保持正确的先后顺序，不会出现"误判为未到期"。

`get_due_jobs()`（`jobs.py:915`）里有一段**遗漏作业快进**逻辑：对周期型作业（`cron`/`interval`），如果 `next_run_at` 已经过去太久（超过随周期缩放的 grace 窗口——日级 2 小时、小时级 30 分钟、10 分钟级 5 分钟），就不补跑那个陈旧的时刻，而是直接 `compute_next_run()` 快进到下一个未来时刻。`jobs.py:984-1007` 的注释点明了它防的问题：网关宕机一整天后重启，不应该把这一天错过的几十次执行一次性全部触发（惊群）。一次性作业则相反——它走 `_recoverable_oneshot_run_at()` 给一个 `ONESHOT_GRACE_SECONDS = 120`（`jobs.py:46`）的小宽限窗口，确保"创建后几秒才轮到调度"的一次性作业不会因为差几秒就永久错过。

### 调度：tick()

`tick()` 定义在 `cron/scheduler.py:1669`，是调度器的心跳。网关每 60 秒从一个后台线程调它一次。它做的事情：

```python
# cron/scheduler.py:1669 起（节选）
def tick(verbose=True, adapters=None, loop=None) -> int:
    lock_dir, lock_file = _get_lock_paths()
    lock_fd = open(lock_file, "w")
    try:
        if fcntl:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)  # 非阻塞排他锁
    except (OSError, IOError):
        return 0   # 别的进程正持有锁 —— 本次 tick 直接跳过

    due_jobs = get_due_jobs()
    # 先把所有到期作业的 next_run_at 推进 —— 在文件锁内、执行之前
    for job in due_jobs:
        advance_next_run(job["id"])
    # 然后并行执行
    ...
```

两个关键设计：

**文件锁实现进程级互斥。** 锁文件是 `~/.hermes/cron/.tick.lock`（`scheduler.py:7`），Unix 用 `fcntl.flock`、Windows 用 `msvcrt.locking`。这道锁的意义是：网关进程内的定时 ticker、独立运行的 cron daemon、用户手动 `hermes cron tick`——这几个可能同时触发，文件锁保证**任何时刻只有一个 tick 在跑**。拿不到锁的直接返回 0、安静跳过。

**先推进 next_run_at，再执行。** `advance_next_run()` 在文件锁内、所有执行开始之前就把每个到期作业的下次运行时间推进。这保证了 **at-most-once（至多一次）** 语义：即使作业执行很慢、跨越了下一个 tick 周期，也不会被重复触发。

到期作业默认**并行**执行（`HERMES_CRON_MAX_PARALLEL=1` 可恢复串行），每个作业走一遍 `_process_job()` → `run_job()` → `save_job_output()` → `_deliver_result()` → `mark_job_run()`。

`tick()` 的并发模型用 `ThreadPoolExecutor` 跑 `_process_job()`（`scheduler.py:1743`）。一个容易被忽略的细节是它用 `contextvars.copy_context()` 给每个 worker 复制了上下文（`scheduler.py:1796`/`1804` 的 `_ctx.run(...)`）——因为 cron 的投递目标是用 `ContextVars` 传递的（见下文），每个作业必须拿到独立的上下文副本，否则并行作业会互相覆盖对方的投递目标。下面这张图描绘了一次 tick 从心跳到投递的完整路径：

<svg viewBox="0 0 780 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Cron tick execution path from heartbeat to delivery">
  <defs>
    <marker id="r14ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="250" y="14" width="280" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="34" text-anchor="middle" font-size="11" fill="currentColor">网关后台线程（每 60s）</text>
  <path d="M390,46 L390,64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="66" width="340" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="85" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">tick() ── flock(.tick.lock, LOCK_EX|LOCK_NB)</text>
  <text x="390" y="101" text-anchor="middle" font-size="10" fill="#64748b">拿不到锁 → return 0（已有 tick 在跑，安静跳过）</text>
  <path d="M390,110 L390,128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="130" width="340" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="153" text-anchor="middle" font-size="10.5" fill="currentColor">get_due_jobs() → 挑出 next_run_at ≤ now 的作业</text>
  <path d="M390,166 L390,184" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="186" width="340" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="209" text-anchor="middle" font-size="10.5" fill="currentColor">advance_next_run(job) ── 先推进（at-most-once）</text>
  <path d="M390,222 L390,240" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="160" y="242" width="460" height="36" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="265" text-anchor="middle" font-size="10.5" fill="currentColor">ThreadPoolExecutor ── copy_context() 给每作业独立 ContextVars</text>
  <g font-size="10" fill="currentColor">
    <rect x="170" y="290" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="235" y="308" text-anchor="middle">_process_job(A)</text>
    <rect x="325" y="290" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="390" y="308" text-anchor="middle">_process_job(B)</text>
    <rect x="480" y="290" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="545" y="308" text-anchor="middle">_process_job(C)</text>
  </g>
  <text x="630" y="308" font-size="10" fill="#94a3b8">并行</text>
  <path d="M390,318 L390,336" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="160" y="338" width="460" height="56" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="358" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">run_job(job)</text>
  <text x="390" y="374" text-anchor="middle" font-size="10" fill="#64748b">no_agent → _run_job_script() → stdout 直接投递</text>
  <text x="390" y="388" text-anchor="middle" font-size="10" fill="#64748b">否 → _build_job_prompt() → AIAgent → agent.run() 工具循环</text>
  <path d="M390,394 L390,412" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="414" width="340" height="32" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="434" text-anchor="middle" font-size="10" fill="currentColor">save_job_output() → ~/.hermes/cron/output/{job}/{ts}.md</text>
  <path d="M390,446 L390,462" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="464" width="340" height="32" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="484" text-anchor="middle" font-size="10" fill="currentColor">_deliver_result() → telegram/discord/email/origin/local</text>
  <path d="M390,496 L390,512" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar)"/>
  <rect x="220" y="514" width="340" height="24" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="390" y="530" text-anchor="middle" font-size="10" fill="currentColor">mark_job_run() ── 记 last_status；repeat 用尽则自动删除</text>
</svg>
<span class="figure-caption">图 R14.2 ｜ 一次 cron tick 的完整路径：从 60 秒心跳、文件锁、推进时间、并行处理到投递与状态标记。</span>

<details>
<summary>ASCII 原版</summary>

```text
  网关后台线程（每 60s）
        │
        ▼
   tick()  ── flock(.tick.lock, LOCK_EX|LOCK_NB)
        │         │
        │         └── 拿不到锁 → return 0（安静跳过，已有 tick 在跑）
        │
        ▼  拿到锁
   get_due_jobs()  ──→ [job A, job B, job C]   遍历 jobs.json，挑出 next_run_at <= now
        │
        ▼  文件锁内、执行前
   for job: advance_next_run(job)   ── 先推进 next_run_at（at-most-once 语义）
        │
        ▼
   ThreadPoolExecutor   ── copy_context() 给每个作业独立 ContextVars
   ┌─────────┬─────────┬─────────┐
   ▼         ▼         ▼
 _process_job(A)  _process_job(B)  _process_job(C)     ← 并行
   │
   ▼
 run_job(job)
   ├── no_agent?  ── 是 ──→ _run_job_script() → stdout 直接投递
   │
   └── 否 ──→ _build_job_prompt()  ── 注入扫描
              → 构造 AIAgent（disabled_toolsets, skip_memory...）
              → agent.run()  ── 工具循环（HERMES_CRON_SESSION 自动放行）
   │
   ▼
 save_job_output()  ── 写 ~/.hermes/cron/output/{job_id}/{ts}.md
   │
   ▼
 _deliver_result()  ── 路由到 telegram / discord / email / origin / local
   │
   ▼
 mark_job_run()  ── 记 last_status；repeat 用尽则自动删除作业
```

</details>

### compute_next_run 与"锚定到上次执行"

调度的正确性最终落在 `compute_next_run()`（`jobs.py:351`）这一个函数上。它按 `kind` 分三条路：

- `once`——委托给 `_recoverable_oneshot_run_at()`，要么返回那个还在宽限窗口内的时刻、要么 `None`（终态）；
- `interval`——下一次 = `last_run_at + minutes`；首次（没有 `last_run_at`）= `now + minutes`；
- `cron`——用 `croniter` 算。

`interval` 和 `cron` 都有一个共同的关键设计：**优先用 `last_run_at` 作为计算基准，而非 `now`**（`jobs.py:383-389`）。这在崩溃/重启后很重要——如果用 `now` 作基准，一个"每 30 分钟"的作业在网关重启那一刻就把计时器重置了，节奏会随每次重启漂移；用 `last_run_at` 作基准，下一次永远锚定在真实的上次执行时间上，节奏稳定。

注意 `compute_next_run()` 对 `cron` 类型在缺 `croniter` 时返回 `None`——这个 `None` 会一路传到 `mark_job_run()`，触发前面讲过的"周期作业标 error、保持 enabled"的防御逻辑。`croniter` 自 v0.9.x 起是核心依赖，缺它属于环境问题，必须让用户看见而不能静默吞掉。

### at-most-once 语义的两道保险

cron 最不能容忍的错误是**重复触发**——一个"发邮件"的作业被触发两次就是发两封邮件。Hermes 用两道独立的保险确保 at-most-once：

1. **文件锁**保证任何时刻只有一个 `tick()` 在跑——排除了"两个 tick 同时挑中同一个到期作业"的可能。
2. **执行前推进 `next_run_at`**——`tick()` 在文件锁内、所有作业执行**之前**就对每个到期作业调 `advance_next_run()`（`jobs.py:886`）。这意味着即使某个作业执行很慢、慢到跨越了下一个 tick 周期，下一次 tick 来检查时它的 `next_run_at` 早已被推到未来，不会被再次选中。

两道保险针对的是两种不同的并发场景：第一道防"同一瞬间的并发 tick"，第二道防"慢作业跨越 tick 周期"。少任何一道都有重复触发的窗口。

### 谁来调 tick()

`tick()` 不是自己跑起来的——它需要一个"心跳源"周期性地调用。Hermes 里有三个可能的心跳源，而文件锁的存在正是为了让它们安全共存（`scheduler.py:1673-1674` 的注释明说了这点）：

1. **网关进程内的后台 ticker**——网关启动后会起一个后台线程，每 60 秒调一次 `tick()`。这是最常见的部署形态：只要网关在跑，cron 就在跑。
2. **独立的 cron daemon**——不想跑整个网关、只想要 cron 的场景，可以单独起一个调度进程，自己循环调 `tick()`。
3. **手动 `hermes cron tick`**——用户在命令行手动触发一次，常用于调试某个作业。

这三者完全可能同时存在（网关在跑、用户又手动敲了一次），所以 `tick()` 用 `.tick.lock` 文件锁保证互斥——拿不到锁的安静返回 0。`tick()` 还接受 `adapters` 和 `loop` 两个可选参数：当心跳源是网关时，网关会把自己持有的活跃平台 adapter 字典和 asyncio 事件循环传进来，让投递能直接走网关的活连接；独立 daemon 没有这些，投递就走 standalone 发送路径。

### 执行：run_job()

`run_job()` 在 `cron/scheduler.py:1024`，是真正跑一个作业的地方。它有两条路径：

**`no_agent` 短路**（`scheduler.py:1052`）：如果作业设了 `no_agent`，那"脚本就是作业本身"——根本不构造 `AIAgent`、不调 LLM、不花 token。这对应经典的"定时跑个 bash 脚本、把 stdout 发到 Telegram"的看门狗模式。语义很明确（`scheduler.py:1045-1051` 的注释逐条列出）：

- 脚本 stdout（trimmed 后）→ 直接当最终消息投递；
- 空 stdout → 静默运行，不投递，`success=True`；
- 非零退出 / 超时 → 当一条错误告警投递，`success=False`；
- `wakeAgent=false` 门控 → 等同于空 stdout（静默），因为 `no_agent` 的全部意义就是"没有 agent 可唤醒"。

`create_job()` 在创建时就强制 `no_agent=True` 必须配 `script`（`jobs.py:581`），否则抛 `ValueError`——"既没 agent 又没脚本，作业无事可做"。这把坏配置挡在调度器之外，永远到不了 `tick()`。`no_agent` 短路块刻意做成自包含的：它在导入 `run_agent`、构造 `SessionDB` 之前就判定，所以一次纯脚本 tick 完全不为它用不到的 agent 机器付出导入成本。

**默认 LLM 路径**：构造 `AIAgent` 并跑。注意 `AIAgent` 的导入是放在函数内部的（`scheduler.py:1143`）——这样 `no_agent` 作业完全不为它用不到的 agent 机器付出导入成本。

LLM 路径下构造的 `AIAgent`（`scheduler.py:1437`）有几个非交互特征：

```python
# cron/scheduler.py:1437 起（节选）
agent = AIAgent(
    model=model,
    max_iterations=max_iterations,
    enabled_toolsets=_resolve_cron_enabled_toolsets(job, _cfg),
    disabled_toolsets=["cronjob", "messaging", "clarify"],   # 禁用交互/递归工具集
    quiet_mode=True,
    skip_context_files=not bool(_job_workdir),
    load_soul_identity=True,    # 仍继承用户的 SOUL.md 身份
    skip_memory=True,           # cron 系统提示会污染用户画像，跳过记忆
    platform="cron",
    session_id=_cron_session_id,
    session_db=_session_db,
)
```

逐条解释这些选择：

- `disabled_toolsets=["cronjob", "messaging", "clarify"]`：cron 作业不能再创建 cron 作业（递归），不能用 `messaging` 工具集（用 delivery 路由代替），不能 `clarify`（没人能答）。
- `skip_memory=True`：cron 的系统提示如果写进记忆，会污染对用户的画像——cron 不是用户。
- `load_soul_identity=True`：但仍然继承用户的 `SOUL.md` 身份，使得 cron agent 的语气、人设和交互 agent 一致。
- `platform="cron"`：让批准系统能识别出这是 cron 上下文并应用 `cron_mode`（自动批准）。

`enabled_toolsets` 不是直接取自作业字段，而是经 `_resolve_cron_enabled_toolsets()`（`scheduler.py:58`）按三级优先级解析：

1. 作业自己的 `enabled_toolsets` 字段（通过 `cronjob` 工具创建/更新时设的 job 级覆盖）；
2. 退而求其次，取 `cron` 平台的 `hermes tools` 全局配置——这让用户不必逐个重建作业就能全局收紧 cron 工具集；
3. 任何查找失败都回落到 `None`——`AIAgent` 加载完整默认工具集（旧行为，作为安全网保留）。

这里有一个真实事故的痕迹：`_DEFAULT_OFF_TOOLSETS`（`{moa, homeassistant, rl}`）会被 `_get_platform_tools` 对未配置平台默认剔除——`scheduler.py:70-73` 的注释提到，一个用户的 cron 作业曾因为默认带上了 `moa`（mixture-of-agents，会并发调多个模型）跑出一笔 4.63 美元的意外账单。默认关掉 `moa` 就是这条修复。这是"非交互式驱动 agent"成本失控的一个具体例子——没有人在场盯着账单，默认值就必须保守。

**auto-approve 怎么来的？** `scheduler.py:1215` 处设了 `os.environ["HERMES_CRON_SESSION"] = "1"`，这个进程级环境变量让批准系统对 cron 作业的工具调用自动放行。注意它是进程级的——cron 调度进程跑的每个作业都是 cron 作业，所以进程级就够了。

**delivery 路由。** cron 作业的输出不回到"用户"（没有用户），而是走 delivery。`scheduler.py:1242-1296` 用 `ContextVars` 设置 `HERMES_CRON_AUTO_DELIVER_PLATFORM` / `_CHAT_ID` / `_THREAD_ID` 三个变量。用 `ContextVars` 而非 `os.environ` 是因为并行作业不能互相覆盖投递目标（`os.environ` 是进程全局的）。注意 `scheduler.py:1242` 同时**显式清空**了 `HERMES_SESSION_*` 三个变量——`scheduler.py:1221-1241` 一大段注释解释，cron 执行是内部调度上下文、不是真实用户消息，如果从 `origin` 播种 `HERMES_SESSION_*`，多个工具消费者会误以为有个来自 origin 聊天的真人在驱动 agent，导致后台进程通知、TTS 格式选择等行为错乱。

**超时是基于"不活动"而非"总时长"。** cron agent 可能合法地跑很久——一个深度调研任务连着调几十次工具是正常的。所以 `run_job()` 不设"总时长上限"，而是设一个**不活动超时**（`scheduler.py:1470-1490`）：默认 600 秒（`HERMES_CRON_TIMEOUT` 可覆盖，`0` = 无限）。它靠 agent 内置的活动追踪器（`_touch_activity()` 在每次工具调用、API 调用、流式 token 到达时更新），`run_job()` 用一个单 worker 的 `ThreadPoolExecutor` 跑 `agent.run_conversation()`、主线程每 5 秒轮询一次 `get_activity_summary()`（`scheduler.py:1505-1522`）。只要 agent 还在动，它就一直跑；一旦 `seconds_since_activity` 超过限额——意味着卡在一个无响应的 API 调用或挂死的工具上——就判定超时并杀掉。这个区分很关键："跑得久"和"卡死了"是两回事，前者要容忍、后者要终止。`scheduler.py:1496` 还用 `copy_context()` 把调度器作用域的 ContextVar 状态（比如技能声明的环境变量透传）一并带进 worker 线程，避免超时监控这一跳丢掉上下文。

### 提示构造与注入防护

`_build_job_prompt()`（`cron/scheduler.py:849`）把作业的 `prompt` 字段、脚本输出、`context_from`（引用其他作业的历史输出）、加载的技能内容拼成最终提示。

这里有一个安全要点。cron agent 是 **auto-approve** 的——它的工具调用没人把关。如果一个恶意技能里藏了 prompt injection 载荷，loaded 进 cron 提示后，agent 就可能被劫持去执行危险操作而没有任何人能拦。

`_build_job_prompt()` 拼接的来源不止 `prompt` 字段一个。它会把以下几部分按顺序组装（`scheduler.py:849-998`）：

- `prompt`：作业本体的提示词；
- 数据采集脚本输出：当作业配了 `script` 但 `no_agent=False` 时，脚本 stdout 被注入提示作为上下文（"找数据 → 让 agent 处理"的模式）；
- `context_from`：可引用一个或多个其它作业的**最近一次输出**（`scheduler.py:891-928`）。这让 cron 作业可以串成链——作业 A 找数据、作业 B 消费 A 的产物。读取失败会 `logger.warning` 跳过，不让坏引用拖垮整个作业；
- 加载的技能内容：`skills` 字段里列出的技能在运行前被读入并拼进提示。

这里有一个安全要点。cron agent 是 **auto-approve** 的——它的工具调用没人把关。如果一个恶意技能里藏了 prompt injection 载荷，loaded 进 cron 提示后，agent 就可能被劫持去执行危险操作而没有任何人能拦。

为此 Hermes 加了 `CronPromptInjectionBlocked` 异常（`scheduler.py:45`）和一道**组装后扫描**：`_build_job_prompt()` 把所有部分（用户 prompt + 加载的技能内容）拼好之后，由 `_scan_assembled_cron_prompt()`（`scheduler.py:999`）整体过一遍注入扫描器（`tools/cronjob_tools.py::_CRON_THREAT_PATTERNS`）。`scheduler.py:48-55` 的注释点明了它补的漏洞——创建时扫描只覆盖用户填的 `prompt` 字段，运行时才加载的技能内容、`context_from` 引用的别的作业输出从未被扫描过。一旦命中，`run_job()` 捕获异常，拒绝运行 agent，给运维投递一条清晰的"作业被拦截"消息（`scheduler.py:1178-1200`），而不是让调度器崩溃或让被劫持的 agent 跑下去。这是一个典型的"信任边界"设计：**任何运行时才进入提示的外部内容都要重新过一遍扫描**，而不是假设创建时扫过就一劳永逸。

值得把这道防线放到更大的背景里看。cron agent 是本章三种非交互模式里**最危险**的一个：它 auto-approve（工具调用不经把关）、它周期性自动运行（一次被劫持可能反复执行）、它继承用户的 `SOUL.md` 身份（被劫持的 agent 看起来还是"用户的助手"）。这三点叠加意味着 cron 的提示注入防护不能是可选项。Hermes 的应对是"纵深防御"：创建时扫 `prompt` 字段、运行时扫组装后的完整提示、`CronPromptInjectionBlocked` 让失败成为一个干净的拦截而非崩溃、`disabled_toolsets` 又禁掉了 `cronjob`（防止被劫持的 agent 再创建恶意作业）。单看每一道都不完备，叠起来才构成对"auto-approve + 周期运行"这个高危组合的合理防护。

### 输出投递：DeliveryTarget 路由

cron 作业跑完后产出一段文本，但"没有用户"，所以必须显式回答"这段文本发到哪"。这就是 `deliver` 字段和 `_deliver_result()`（`scheduler.py:489`）。

`deliver` 字段是一个字符串，可以是单个目标，也可以是逗号分隔的多目标。`_resolve_delivery_targets()`（`scheduler.py:390`）把它解析成一组结构化 `DeliveryTarget`，支持的目标类型包括：

- `origin`——投递回作业**创建时所在的那个聊天**。`create_job()` 把创建上下文存在 `origin` 字段（`jobs.py:627`），`_resolve_origin()`（`scheduler.py:148`）从中还原出平台 + chat_id；
- `telegram` / `discord` / `email` 等具名平台——投递到该平台配置的"主聊天"（home target，`scheduler.py:215` 的 `_get_home_target_chat_id`）；
- `local`——只写到 `~/.hermes/cron/output/` 下的历史文件，不往任何聊天发。这是没有 `origin` 时的默认值（`jobs.py:558`）。

实际投递时，`run_job()` 用 `ContextVars` 设置 `HERMES_CRON_AUTO_DELIVER_PLATFORM` / `_CHAT_ID` / `_THREAD_ID` 三个变量（`scheduler.py:1290-1292`）。用 `ContextVars` 而非 `os.environ` 是因为并行作业不能互相覆盖投递目标——`os.environ` 是进程全局的，三个作业并行时后写的会盖掉先写的。`_deliver_result()` 还能通过 adapter 直接发送媒体附件（`_send_media_via_adapter`，`scheduler.py:435`），不止纯文本。投递失败不算作业失败——错误记在作业的 `last_delivery_error` 字段里，作业本身的 `last_status` 仍可为成功。

具名平台的合法性是被校验的：`_KNOWN_DELIVERY_PLATFORMS`（`scheduler.py:90`）是一个白名单 frozenset，`scheduler.py:88-89` 的注释说明它的安全意义——防止用户在 `deliver` 字段里塞一个精心构造的"平台名"去枚举环境变量。home target 的解析（`_HOME_TARGET_ENV_VARS`，`scheduler.py:99`）也只认白名单内平台对应的固定环境变量名。

### 作业生命周期：mark_job_run 与自动删除

一个作业跑完后，`mark_job_run()`（`jobs.py:813`）在文件锁内更新它的终态字段并决定它的去留：

- `last_run_at` / `last_status`（`ok`/`error`）/ `last_error` / `last_delivery_error`——注意 agent 错误与投递错误是**分开记的**，作业可以"成功产出但投递失败"；
- `repeat.completed` 自增。如果设了 `repeat.times` 且 `completed >= times`，作业**直接从 jobs.json 里 pop 掉**——一次性作业（`repeat.times=1`）跑完即自动删除；
- 否则 `compute_next_run()` 算下一次。

`mark_job_run()` 里有一段防御性逻辑（`jobs.py:851-876`）值得单独看。如果 `compute_next_run()` 返回 `None`：

- 对**周期型**作业（`cron`/`interval`），这通常意味着运行环境缺了 `croniter` 包——这种情况绝不能把作业静默禁用，否则用户的定时任务会悄无声息地失效。代码把作业标成 `state="error"`、写一条明确的 `last_error`、**保持 enabled**，让用户看得见问题；
- 对**一次性**作业，`next_run_at` 为 `None` 是正常的终态——作业被标成 `state="completed"`、`enabled=False`。

这个区分体现了一条原则：**"算不出下一次"对一次性作业是正常完成，对周期作业是故障**，两者必须用不同方式处理，不能一刀切。

### 数据采集脚本与 wakeAgent 门控

`script` 字段配合 `_run_job_script()`（`scheduler.py:708`）支持一种很实用的模式：**先用脚本采数据，再让 agent 处理**。脚本按扩展名选解释器——`.sh` / `.bash` 走 `/bin/bash`，其它走当前 Python 解释器。脚本必须放在 `HERMES_HOME/scripts/` 目录下，`_run_job_script()` 会把传入路径（无论相对、绝对还是 `~` 开头）解析后用 `path.relative_to(scripts_dir)` 校验——防止路径穿越、绝对路径注入、符号链接逃逸去执行目录外的任意脚本。

脚本的角色取决于 `no_agent`：

- `no_agent=False`：脚本 stdout 被注入 agent 提示作为上下文（"找数据 → agent 处理"）；
- `no_agent=True`：脚本就是作业本身，stdout 直接投递（经典看门狗）。

在 `no_agent=False` 这条路上还有一个 `wakeAgent` 门控（`_parse_wake_gate()`，`scheduler.py:823`）。脚本可以在 stdout 里输出一个信号表明"这次没必要唤醒 agent"——比如一个变更检测脚本发现"自上次以来没有任何变化"，它就没必要让 agent 跑一轮、花 token 去处理"无事发生"。门控关闭时这次运行被当成静默处理，跳过 agent。这把"是否值得动用 LLM"的判断权交给了便宜的脚本，是又一处成本控制——让确定性的 shell/Python 逻辑做前置过滤，agent 只在真正有事时才被唤醒。

### 输出历史与作业链

每次作业跑完，`save_job_output()`（`jobs.py:1017`）把完整输出写到 `~/.hermes/cron/output/{job_id}/{时间戳}.md`——每个作业一个子目录，每次运行一个带时间戳的 Markdown 文件。写入同样走"临时文件 + `fsync` + `atomic_replace`"的原子套路，目录和文件都收紧到属主可读写。这份历史有两个用途：

- `deliver: local` 的作业只把结果留在这里，用户事后翻阅；
- `context_from` 引用——作业 B 的提示里可以注入作业 A 的**最近一次**输出。`_build_job_prompt()` 读的就是 A 的输出目录里时间戳最新的那个文件。

`context_from` 让 cron 作业能串成**链**：作业 A 每小时抓一次原始数据、作业 B 每天读 A 的最新输出做汇总分析。这比把所有逻辑塞进一个作业更灵活——A 和 B 可以有不同的调度频率、不同的工具集、不同的模型。但要记住前面提过的安全细节：`context_from` 注入的别的作业输出，会在 `_build_job_prompt()` 组装后被注入扫描器一并扫描——一个作业的输出若被污染，不会顺着 `context_from` 链劫持下游作业。

还有一个运维细节：作业的 `skills` 字段引用的技能名可能在 curator 整合技能后失效（技能 X 被并进 Y 或被归档）。`rewrite_skill_refs()`（`jobs.py:1049`）在 curator 跑完整合后自动改写所有 cron 作业的 `skills` 引用，避免作业在运行时因为"技能 X 找不到"而静默地缺失它本该遵循的指令。这是"非交互式"的又一个隐性代价——没有人在场，技能引用失效这种问题不会有人当场发现，只能靠系统自动修复。

---

## 14.3 子 Agent 派发：delegate_task

`delegate_task` 工具让一个 agent **自己 fork 出若干子 agent** 并行干活。代码在 `tools/delegate_tool.py`。

典型场景：主 agent 要"调研三个竞品",它可以一次派发三个子 agent，每个调研一个，三个并行跑，主 agent 阻塞等结果，最后拿到三份摘要。

文件头 docstring（`delegate_tool.py:9-16`）讲清了每个子 agent 拿到什么：

```text
每个子 agent 获得：
  - 全新的 conversation（不带父 agent 的历史）
  - 独立的 task_id（独立的终端会话、文件操作缓存）
  - 受限的工具集（可配置，且永久剥除若干工具）
  - 聚焦的系统提示（由委派目标 + context 构建）

父 agent 的上下文只看到「派发调用」和「摘要结果」，
看不到子 agent 的中间工具调用和推理。
```

最后一句是 delegate 的核心价值——**上下文隔离**。子 agent 的 token 消耗、中间步骤不污染父 agent 的上下文窗口，父 agent 只看到一份干净的摘要。这本质上是一种上下文压缩手段（对比[第 7 章](07-context-engine.md)的压缩思路）。

下面这张图描绘了父子 agent 的关系——注意父 agent 的上下文窗口里只有"派发调用"和"摘要结果"两个节点，子 agent 的整棵工具调用树都在父的上下文之外：

<svg viewBox="0 0 800 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Parent and sub-agent context isolation in delegate_task">
  <defs>
    <marker id="r14ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="20" width="720" height="200" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="44" font-size="12" font-weight="700" fill="currentColor">父 agent（上下文窗口）</text>
  <rect x="60" y="56" width="680" height="40" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="400" y="73" text-anchor="middle" font-size="10.5" fill="currentColor">[assistant] 调用 delegate_task(tasks=["调研竞品A","调研竞品B","调研竞品C"])</text>
  <text x="400" y="89" text-anchor="middle" font-size="10" fill="#64748b">↓ 阻塞等待（ThreadPoolExecutor）</text>
  <rect x="60" y="160" width="680" height="44" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="1"/>
  <text x="400" y="178" text-anchor="middle" font-size="10.5" fill="currentColor">[tool] delegate_task 返回：聚合摘要</text>
  <text x="400" y="194" text-anchor="middle" font-size="10" fill="#64748b">"任务1：摘要A / 任务2：摘要B / 任务3：摘要C" ← 父只看到这一段</text>
  <g font-size="10" fill="currentColor">
    <rect x="100" y="250" width="160" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="180" y="270" text-anchor="middle" font-weight="600">子A · task_id_a</text>
    <text x="180" y="288" text-anchor="middle" fill="#64748b">工具循环…</text>
    <text x="180" y="306" text-anchor="middle" fill="#64748b">→ 摘要A</text>
    <rect x="320" y="250" width="160" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="400" y="270" text-anchor="middle" font-weight="600">子B · task_id_b</text>
    <text x="400" y="288" text-anchor="middle" fill="#64748b">工具循环…</text>
    <text x="400" y="306" text-anchor="middle" fill="#64748b">→ 摘要B</text>
    <rect x="540" y="250" width="160" height="80" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
    <text x="620" y="270" text-anchor="middle" font-weight="600">子C · task_id_c</text>
    <text x="620" y="288" text-anchor="middle" fill="#64748b">工具循环…</text>
    <text x="620" y="306" text-anchor="middle" fill="#64748b">→ 摘要C</text>
  </g>
  <path d="M260,116 L180,248" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar2)"/>
  <path d="M400,116 L400,248" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar2)"/>
  <path d="M540,116 L620,248" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar2)"/>
  <path d="M180,330 L260,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/>
  <path d="M400,330 L400,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/>
  <path d="M620,330 L540,206" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/>
  <text x="400" y="352" text-anchor="middle" font-size="10" fill="#94a3b8">各自独立的 AIAgent · 全新 conversation · 受限工具集 / 聚焦提示</text>
  <text x="400" y="370" text-anchor="middle" font-size="10" fill="#94a3b8">子 agent 的中间工具调用、推理 token 从不进入父 agent 的上下文窗口</text>
</svg>
<span class="figure-caption">图 R14.3 ｜ delegate_task 的上下文隔离：父 agent 只看到派发调用与聚合摘要，子 agent 的工具调用树在父窗口之外。</span>

<details>
<summary>ASCII 原版</summary>

```text
   父 agent（上下文窗口）
   ┌──────────────────────────────────────────┐
   │ ...                                       │
   │ [assistant] 调用 delegate_task(           │
   │   tasks=["调研竞品A","调研竞品B","调研竞品C"])│
   │                                           │
   │        ╎ 阻塞等待（ThreadPoolExecutor）     │
   │        ╎                                  │
   │        ╎   子A          子B          子C   │  ← 各自独立的 AIAgent
   │        ╎   task_id_a    task_id_b   task_id_c│    全新 conversation
   │        ╎   工具循环…     工具循环…    工具循环… │    受限工具集 / 聚焦提示
   │        ╎   摘要A         摘要B        摘要C   │
   │        ╎                                  │
   │ [tool] delegate_task 返回：               │  ← 父只看到聚合摘要
   │   "任务1：摘要A / 任务2：摘要B / 任务3：摘要C" │
   │ ...                                       │
   └──────────────────────────────────────────┘
        子 agent 的中间工具调用、推理 token
        从不进入父 agent 的上下文窗口
```

</details>

为什么这种隔离重要？设想没有 delegate：主 agent 要调研三个竞品，它得在自己的对话里依次完成三轮调研，每轮可能十几次工具调用。三轮下来，上下文窗口里塞满了三十多次工具调用的原始结果——网页全文、搜索结果列表、中间笔记。等它要写最终对比时，真正有用的信息（三份结论）被淹没在海量中间产物里，而且窗口可能已经接近上限、触发压缩。delegate 把每一轮调研下放给一个独立子 agent，子 agent 在自己的窗口里翻腾、最后只交回一段结论。主 agent 的窗口因此始终干净：一次派发调用 + 一段聚合结果。这就是为什么 delegate 被归为一种"上下文工程"手段——它和[第 7 章](07-context-engine.md)的自动压缩是互补的两条路子，一个是事后压缩、一个是事前隔离。

换个角度看收益：假设每个子 agent 的调研要烧 8000 token 的中间产物、最后产出 400 token 的结论。三个竞品并行调研，没有 delegate 时父 agent 的窗口会涨 `3 × 8400 ≈ 25200` token；有 delegate 时父 agent 只增加"一次派发调用 + 三段结论" ≈ `200 + 3 × 400 = 1400` token。窗口占用差了将近 18 倍——而这还没算上"父窗口被中间产物撑大后，后续每一轮 API 调用都要重复发送这些 token"的累积成本。delegate 的价值在长对话里会被进一步放大。

### DELEGATE_BLOCKED_TOOLS：永久禁用的五个工具

`DELEGATE_BLOCKED_TOOLS` 定义在 `tools/delegate_tool.py:40-48`：

```python
# tools/delegate_tool.py:40 起
DELEGATE_BLOCKED_TOOLS = frozenset([
    "delegate_task",  # 不允许递归派发
    "clarify",        # 不允许与用户交互
    "memory",         # 不允许写共享的 MEMORY.md
    "send_message",   # 不允许跨平台副作用
    "execute_code",   # 子 agent 应该一步步推理，而非写脚本
])
```

无论调用方传什么 `toolsets`，这五个工具都会被剥掉。逐个讲**为什么**：

- **`delegate_task`**——禁止递归派发。如果子 agent 还能再派发，会形成无界的 fork 炸弹。（注意：`role="orchestrator"` 的子 agent 是例外，它保留派发能力但受 `max_spawn_depth` 深度限制，见下文。这里禁的是默认的 `leaf` 角色。）
- **`clarify`**——子 agent 跑在 `ThreadPoolExecutor` 的 worker 线程里，没有用户在场，也没有 stdin。让它澄清提问只会卡死。
- **`memory`**——`MEMORY.md` 是父 agent 与所有子 agent 共享的。多个并行子 agent 同时写记忆会冲突；而且子 agent 的临时任务不该沉淀成长期记忆。
- **`send_message`**——子 agent 不该产生跨平台副作用（往用户的 Telegram 发消息）。副作用应该由父 agent 在拿到摘要后统一决定。
- **`execute_code`**——这条最微妙：注释说"子 agent 应该一步步推理，而非写脚本"。设计者希望子 agent 的工作过程是可观察、可逐步审计的工具调用序列，而不是一个黑盒脚本。

### 子 agent 的批准回调

子 agent 跑在 `ThreadPoolExecutor` 的 worker 线程里——这带来一个隐蔽的死锁风险。CLI 的交互式批准回调存在 `tools/terminal_tool.py` 的 `threading.local()` 里，worker 线程**不会继承**它。没有回调的话，`prompt_dangerous_approval()` 会回落到从 worker 线程调 `input()`，而 `input()` 会和父 agent 那个占着 stdin 的 prompt_toolkit TUI 死锁。

解法是给每个 worker 线程装一个**非交互式回调**。默认是 `_subagent_auto_deny()`（`tools/delegate_tool.py:68`）：

```python
# tools/delegate_tool.py:68 起
def _subagent_auto_deny(command, description, **kwargs) -> str:
    """子 agent 线程里自动拒绝危险命令（安全默认）。
    返回 'deny' 让子 agent 看到一个可恢复的拒绝，且绝不调 input()。
    """
    logger.warning("Subagent auto-denied dangerous command: %s (%s). ...", command, description)
    return "deny"
```

默认 **auto-deny** 是安全的——它和 `DELEGATE_BLOCKED_TOOLS` 的精神一致：子 agent 默认能力受限。若配置 `delegation.subagent_auto_approve: true`，则换成 `_subagent_auto_approve()`（`delegate_tool.py:82`，返回 `'once'`）——这是给 cron / batch 这类无人值守场景的 opt-in YOLO 模式。两个回调都会 `logger.warning` 留审计痕迹。注意：网关会话不受这两个 TLS 回调影响，它走 `tools/approval.py` 的按会话队列。

### role：leaf 与 orchestrator 两种角色

`role` 参数（`delegate_tool.py:1921`）控制子 agent 能否再派发，只有两个合法值，`_normalize_role()`（`delegate_tool.py:307`）把任何未知值都退化成 `leaf`：

- `leaf`（默认）——纯执行者，不能再派发。`DELEGATE_BLOCKED_TOOLS` 把 `delegate_task` 剥掉，它就没有派发能力；
- `orchestrator`——编排者，保留 `delegation` 工具集、可以派发自己的 worker。它的系统提示会被 `_build_child_system_prompt()`（`delegate_tool.py:564`）追加一段编排能力说明（`delegate_tool.py:606-635`），告诉它"协调 worker 的结果并综合，最终摘要来自你而非你的 worker"。

`role` 不是无条件生效的。`_build_child_agent()`（`delegate_tool.py:899-908`）有一个"单点降级"逻辑：只有当**全局 kill switch** `orchestrator_enabled` 为真（`_get_orchestrator_enabled`，`delegate_tool.py:427`）**且**子 agent 的深度 `child_depth < max_spawn` 时，`orchestrator` 才被尊重；否则一律降级成 `leaf`。`max_spawn_depth`（`delegate_tool.py:389`）被钳在 `[1, 3]`，默认 `1`——即"扁平"模式：父（深度 0）可派发，子（深度 1）就是叶子地板，孙子被拒。要解锁嵌套编排，得显式把 `max_spawn_depth` 调到 2 或 3。

`delegate_task()` 入口（`delegate_tool.py:1955`）开头就做深度检查——`depth >= max_spawn` 直接报错返回。这道深度限制 + `leaf` 角色经 `DELEGATE_BLOCKED_TOOLS` 禁递归 + 全局 kill switch + `set_spawn_paused()`（`delegate_tool.py:153`，运行时可暂停所有派发），四道闸门共同防止派发树失控成 fork 炸弹。

### 工具集求交集：子 agent 不能比父强

`_build_child_agent()`（`delegate_tool.py:865`）构造子 agent 时有一条不变量：**子 agent 的工具集是父 agent 工具集的子集**。`delegate_tool.py:940-956` 的逻辑分情况：

- 调用方显式传了 `toolsets`：与父的可用工具集**求交集**（`child_toolsets = [t for t in toolsets if t in expanded_parent]`），再剥掉被禁工具。即使调用方写了一个父没有的工具集，也会被交集滤掉——子 agent 永远不能凭空获得父没有的能力；
- 调用方没传：直接继承父的 `enabled_toolsets`（或从父已加载的工具名反推），同样剥掉被禁工具。

剥离用 `_strip_blocked_tools()`（`delegate_tool.py:667`）完成，它移除 `DELEGATE_BLOCKED_TOOLS` 涉及的工具集名。一个例外：`orchestrator` 角色的子 agent 会在 `_strip_blocked_tools()` 之后被**无条件重新加回** `delegation` 工具集（`delegate_tool.py:962`）——因为编排能力是由 `role` 授予的，不是从父继承的，所以不受交集约束。

### task_id 隔离与子 agent 构造

每个子 agent 拿到一个独立的 `task_id`，这把它的**终端会话、文件操作缓存**与父 agent 和兄弟 agent 隔离开——子 A 在它的 shell 里 `cd` 到某个目录，不会影响子 B 的 shell，也不会影响父 agent 的 shell。这是 delegate 能安全并行的前提：没有这层隔离，三个子 agent 并行操作同一个终端会话就会互相踩踏。

子 agent 还有一个 `subagent_id`（`delegate_tool.py:915`，形如 `sa-0-a1b2c3d4`），它在 `_build_child_agent()` 里一次性生成，并贯穿进度回调、`spawn_requested` 事件、`_active_subagents` 注册表（`_register_subagent`，`delegate_tool.py:170`）——三处共用一个 key，使 TUI 能重建派发树、把子 agent 的工具调用以缩进形式实时显示在父 agent 输出下方，并对单个分支做控制（`interrupt_subagent()`，`delegate_tool.py:183`，中断某个特定子 agent）。

子 agent 实例本身在 `delegate_tool.py:1101` 构造，关键参数：

- `enabled_toolsets=child_toolsets`——上面求交集后的受限工具集；
- `ephemeral_system_prompt=child_prompt`——由 `_build_child_system_prompt()` 构造的聚焦提示，开头即 "You are a focused subagent working on a specific delegated task."，后接 `goal` 与 `context`；
- `skip_context_files=True` / `skip_memory=True`——子 agent 不读 `AGENTS.md` 之类的上下文文件，也不碰记忆；
- `parent_session_id`——链回父会话，便于事后追溯整棵派发树；
- `_delegate_depth`——比父深一层，`delegate_task()` 入口据此做深度检查。

子 agent 还可以通过 `override_provider` / `override_base_url` / `override_api_key`（`delegate_tool.py:874-878`）用与父**不同的 provider:model**——例如父跑在 Nous Portal、把便宜快速的 worker 路由到 OpenRouter 的小模型上。一个细节是构造函数本身被设计成在**主线程**完成（`delegate_tool.py:888` 注释 "thread-safe construction"）：`_build_child_agent()` 只负责构造、返回未运行的 agent 实例，真正的工具循环才下放到 worker 线程跑——构造过程涉及配置读取、工具注册等非线程安全操作，集中在主线程做最稳妥。

### 结果如何回传父 agent

子 agent 跑完后，`delegate_task()` 不会把子 agent 的完整对话塞回父——那会瓦解上下文隔离的全部意义。它只取**输出尾部**：`_extract_output_tail()`（`delegate_tool.py:219`）从子 agent 的消息列表里抽出最后一条 `assistant` 消息（也即子 agent 自己写的"任务摘要"），并能识别 `tool` 消息里的错误特征（`_looks_like_error_output`，`delegate_tool.py:272`），把失败的子任务标注出来。

多个子任务的摘要被聚合成一段文本，作为 `delegate_task` 这一个工具调用的**单条 `tool` 返回**回到父 agent。从父 agent 的视角看，它发出一次工具调用、收到一段结果——和调用任何普通工具没有区别。这正是 delegate 把"一群子 agent 的全部工作"压缩成"父上下文里一个工具调用 + 一条结果"的实现机制。

### 进度回放与并发控制

虽然父 agent 的**上下文**只看到最终摘要，但用户的**屏幕**上不是黑盒——子 agent 跑的时候，它的工具调用会以缩进的形式实时显示在父 agent 输出下方。这靠 `_build_child_progress_callback()`（`delegate_tool.py:678`）实现：它给每个子 agent 装一个回调，把子 agent 发出的工具调用事件中继（relay）给父 agent 的显示层。回调通过 `subagent_id` 给事件打上身份标签，TUI 据此把同一个子 agent 的多条进度归到同一个缩进分支下。注意这条进度链只是**显示**——中继的内容不进父 agent 的上下文窗口，上下文隔离不受影响。

并发不是无限的。`_get_max_concurrent_children()`（`delegate_tool.py:324`）从配置读出同时在跑的子 agent 上限，`ThreadPoolExecutor` 的池大小据此设置——派发 10 个任务、上限是 4，那就 4 个先跑、其余排队。`_get_child_timeout()`（`delegate_tool.py:362`）给每个子 agent 设一个超时，卡死的子 agent 不会无限拖住父 agent。这两道限制 + 前面说的深度上限，共同把派发的资源占用框在可控范围。

### 子 agent 死锁的全貌

把前面散落的几点串起来，子 agent 在 worker 线程里跑会撞上三个独立的陷阱，delegate 各有对策：

- **批准回调死锁**——worker 线程不继承 TLS 里的交互式批准回调，回落到 `input()` 会和父 agent 的 TUI 抢 stdin。对策：装非交互式回调（`_subagent_auto_deny` / `_subagent_auto_approve`）。
- **构造非线程安全**——工具注册、配置读取在多线程里并发跑不安全。对策：`_build_child_agent()` 在主线程构造，只把"跑"下放给 worker。
- **终端会话踩踏**——多个子 agent 并行操作同一个 shell 会互相覆盖工作目录、环境。对策：每个子 agent 独立 `task_id`，终端会话彼此隔离。

三个陷阱的共同根源是同一件事：**delegate 把单线程的交互式 agent 强行搬进了多线程并发环境**。理解了这一点，这三处看似零散的防御就成了同一个设计应对的三个面。

### 一次派发的完整时序

把前面几节串成一条时间线，一次 `delegate_task` 调用从头到尾经历：

<svg viewBox="0 0 780 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Sequence of a single delegate_task call">
  <defs>
    <marker id="r14ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="170" y="14" width="440" height="32" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="34" text-anchor="middle" font-size="10.5" fill="currentColor">父 agent 调用 delegate_task(tasks=[t1,t2,t3], role="leaf")</text>
  <path d="M390,46 L390,64" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="66" width="520" height="52" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="86" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">delegate_task() ── 入口守卫</text>
  <text x="390" y="103" text-anchor="middle" font-size="10" fill="#64748b">_delegate_depth ≥ max_spawn？/ is_spawn_paused()？ → 报错返回</text>
  <path d="M390,118 L390,136" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="138" width="520" height="80" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="158" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">主线程逐个构造 _build_child_agent()（线程安全）</text>
  <text x="390" y="176" text-anchor="middle" font-size="10" fill="#64748b">角色解析（kill switch + 深度约束，可能降级 leaf）</text>
  <text x="390" y="191" text-anchor="middle" font-size="10" fill="#64748b">工具集求交集 child ⊆ parent，剥 DELEGATE_BLOCKED_TOOLS</text>
  <text x="390" y="206" text-anchor="middle" font-size="10" fill="#64748b">生成 subagent_id · 装非交互式批准回调</text>
  <path d="M390,218 L390,236" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="238" width="520" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="258" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">ThreadPoolExecutor(max_concurrent_children)</text>
  <text x="390" y="276" text-anchor="middle" font-size="10" fill="#64748b">每 worker：child_agent.run() 工具循环，受 child_timeout</text>
  <text x="390" y="291" text-anchor="middle" font-size="10" fill="#64748b">进度经 _build_child_progress_callback 中继到父 TUI（仅显示）</text>
  <path d="M390,298 L390,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="318" width="520" height="48" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="338" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">_extract_output_tail()（全部完成 / 超时）</text>
  <text x="390" y="355" text-anchor="middle" font-size="10" fill="#64748b">取最后一条 assistant 消息 · _looks_like_error_output 标注失败</text>
  <path d="M390,366 L390,384" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="386" width="520" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="390" y="406" text-anchor="middle" font-size="10.5" fill="currentColor">聚合成单段文本 → 作为 tool 返回交给父 agent</text>
  <path d="M390,418 L390,434" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar3)"/>
  <rect x="130" y="436" width="520" height="22" rx="6" fill="#fff" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="390" y="451" text-anchor="middle" font-size="10" fill="currentColor">_unregister_subagent() ── 清理注册表</text>
</svg>
<span class="figure-caption">图 R14.4 ｜ 一次 delegate_task 调用的完整时序：入口守卫 → 主线程构造 → worker 并行执行 → 提取聚合 → 清理。</span>

<details>
<summary>ASCII 原版</summary>

```text
  父 agent 调用 delegate_task(tasks=[t1, t2, t3], role="leaf")
        │
        ▼
  delegate_task()  ── 检查 _delegate_depth >= max_spawn？ 是 → 报错返回
        │           ── 检查 is_spawn_paused()？ 是 → 报错返回
        │
        ▼  主线程，逐个构造（线程安全）
  for i, task: _build_child_agent(i, ...)
        │   ├── 角色解析：role 受 kill switch + 深度约束，可能降级 leaf
        │   ├── 工具集求交集：child ⊆ parent，剥 DELEGATE_BLOCKED_TOOLS
        │   ├── 生成 subagent_id，_register_subagent()
        │   └── 装非交互式批准回调（auto_deny / auto_approve）
        │
        ▼  下放给 worker 线程
  ThreadPoolExecutor(max_concurrent_children)
        │   每个 worker：child_agent.run()  ── 工具循环，受 child_timeout
        │   进度经 _build_child_progress_callback 中继到父 TUI（仅显示）
        │
        ▼  全部完成 / 超时
  _extract_output_tail()  ── 每个子 agent 取最后一条 assistant 消息
        │                 ── _looks_like_error_output 标注失败子任务
        ▼
  聚合成单段文本 → 作为 delegate_task 的 tool 返回交给父 agent
        │
        ▼
  _unregister_subagent()  ── 清理注册表
```

</details>

注意整个过程父 agent 是**阻塞**的——`delegate_task` 是一个同步工具调用，父 agent 发出后就等，等到聚合结果回来才继续。从父 agent 的对话流看，这和调用一个慢一点的普通工具没有任何区别。

### 运行时的派发控制

派发不是发出去就完全失控的——`delegate_tool.py` 维护了一个全局的活跃子 agent 注册表 `_active_subagents`，并暴露了几个运行时控制点：

- `list_active_subagents()`（`delegate_tool.py:206`）——列出当前在跑的所有子 agent，TUI 用它显示派发树的实时状态；
- `interrupt_subagent(subagent_id)`（`delegate_tool.py:183`）——按 `subagent_id` 中断**某一个特定**子 agent。用户在 TUI 上看到某个子 agent 跑偏了，可以只掐掉它，不影响其兄弟；
- `set_spawn_paused(True)`（`delegate_tool.py:153`）——全局暂停所有新的派发。已在跑的子 agent 继续，但任何新的 `delegate_task` 调用会在入口处被 `is_spawn_paused()` 拦下报错。这是一个"刹车"，用于发现派发行为异常时快速止血。

这些控制点的存在体现了一个原则：非交互式地 fork agent 是有风险的，所以系统必须保留**事后干预**的手柄——能观察（list）、能精确中断（interrupt）、能全局急停（pause）。它和创建时的静态限制（深度上限、kill switch）互补：静态限制防患于未然，运行时控制处理"已经出问题了怎么办"。

---

## 14.4 批量运行：BatchRunner 与 MiniSWERunner

第三种非交互驱动方式是批量运行——拿一个数据集，对每条样本各跑一个 agent。这主要服务于**生成训练轨迹**：跑大量任务、收集 agent 的工具调用序列，用来训练下一代工具调用模型。

### BatchRunner

`BatchRunner` 定义在 `batch_runner.py:527`。它的输入是一个 JSONL 数据集（每行一条带 `prompt` 字段的样本），输出是轨迹文件。用法（`batch_runner.py:14`）：

```bash
python batch_runner.py --dataset_file=data.jsonl --batch_size=10 --run_name=my_run
# 断点续跑
python batch_runner.py --dataset_file=data.jsonl --batch_size=10 --run_name=my_run --resume
```

输入数据集的每一行是一条独立 JSON 对象，最少要有 `prompt` 字段：

```jsonl
{"prompt": "写一个 Python 函数计算斐波那契数列并测试它"}
{"prompt": "在当前目录找出所有大于 1MB 的文件并列出"}
{"prompt": "调研 Rust 和 Go 的并发模型差异，给出对比表"}
```

输出则是另一组 JSONL——每条样本产出一个 `{"prompt": ..., "conversations": [...]}` 对象，`conversations` 就是该样本 agent 的完整轨迹。

关键能力（`batch_runner.py:5-11` 的 docstring）：

- **并行处理**：用 `multiprocessing.Pool`，`num_workers` 个 worker 进程并行（不同于 delegate 的线程池——批量任务可能 CPU 密集，多进程绕开 GIL）。
- **每样本一个 AIAgent**：每条样本独立构造一个 agent，互不干扰。
- **检查点**：`--resume` 支持断点续跑，跑到一半中断不用从头来。
- **轨迹保存**：按 `from`/`value` 对的格式保存对话轨迹。
- **工具使用统计**：跨所有批次聚合 tool 使用统计。

`BatchRunner.__init__`（`batch_runner.py:532`）的参数清单几乎是 `AIAgent` 构造参数的镜像——`model`、`max_iterations`、provider 路由、`reasoning_config`、`prefill_messages` 等——因为它的职责就是把这些参数透传给每个样本的 agent。`ephemeral_system_prompt`（`batch_runner.py:544`）是一个值得注意的字段：它在 agent 执行期间生效，但**不会写进轨迹**——避免训练数据被系统提示污染。

### 从数据集到轨迹的流水线

一次 `BatchRunner.run()`（`batch_runner.py:810`）的处理流程是：

<svg viewBox="0 0 780 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="BatchRunner pipeline from dataset to trajectories">
  <defs>
    <marker id="r14ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="300" height="34" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="390" y="35" text-anchor="middle" font-size="10.5" fill="currentColor">dataset.jsonl ── 每行一条 {"prompt": …} 样本</text>
  <path d="M390,48 L390,66" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <rect x="200" y="68" width="380" height="34" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="89" text-anchor="middle" font-size="10.5" fill="currentColor">_load_dataset() → _create_batches()（切成 batch_size 一组）</text>
  <path d="M390,102 L390,120" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <rect x="200" y="122" width="380" height="34" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="390" y="143" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">multiprocessing.Pool(num_workers)</text>
  <g font-size="10" fill="currentColor">
    <rect x="170" y="178" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="235" y="196" text-anchor="middle">_process_batch_worker</text>
    <rect x="325" y="178" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="390" y="196" text-anchor="middle">worker …</text>
    <rect x="480" y="178" width="130" height="28" rx="4" fill="#fff" stroke="#94a3b8"/>
    <text x="545" y="196" text-anchor="middle">worker …</text>
  </g>
  <text x="635" y="196" font-size="10" fill="#94a3b8">每进程一批</text>
  <path d="M390,156 L235,176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <path d="M390,156 L390,176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <path d="M390,156 L545,176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <path d="M390,206 L390,226" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <rect x="170" y="228" width="440" height="74" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="390" y="248" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">_process_single_prompt()（对批内每条样本）</text>
  <text x="390" y="266" text-anchor="middle" font-size="10" fill="#64748b">构造全新 AIAgent（注入 ephemeral_system_prompt）</text>
  <text x="390" y="281" text-anchor="middle" font-size="10" fill="#64748b">agent 跑工具循环</text>
  <text x="390" y="296" text-anchor="middle" font-size="10" fill="#64748b">_convert_to_trajectory_format() → from/value 对</text>
  <path d="M390,302 L390,320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar4)"/>
  <rect x="200" y="322" width="380" height="32" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="390" y="342" text-anchor="middle" font-size="10.5" fill="currentColor">写 batch_{n}.jsonl + 原子更新 checkpoint.json</text>
</svg>
<span class="figure-caption">图 R14.5 ｜ BatchRunner 流水线：数据集切批、多进程池并行处理、每样本新建 agent、产出轨迹与检查点。</span>

<details>
<summary>ASCII 原版</summary>

```text
  dataset.jsonl  ── 每行一条 {"prompt": "...", ...} 样本
        │
        ▼
  _load_dataset() ──→ _create_batches()  ── 切成 batch_size 一组的批
        │
        ▼
  multiprocessing.Pool(num_workers)
   ┌──────────┬──────────┬──────────┐
   ▼          ▼          ▼
 _process_batch_worker  …  …          ← 每个 worker 进程处理一批
   │
   ▼  对批内每条样本：
 _process_single_prompt()
   ├── 构造一个全新 AIAgent（ephemeral_system_prompt 注入）
   ├── agent 跑工具循环
   └── agent._convert_to_trajectory_format()  ── 转成 from/value 对
   │
   ▼
 写 batch_{n}.jsonl  +  原子更新 checkpoint.json
```

</details>

`_process_single_prompt()`（`batch_runner.py:244`）是单条样本的核心：它为每条样本构造一个**全新的 `AIAgent`**，互不干扰，跑完后调 `agent._convert_to_trajectory_format()`（`batch_runner.py:358`）把内部消息转成训练用的 `from`/`value` 对（`from` 取 `system`/`human`/`gpt`/`tool`），写进该批的 `batch_{n}.jsonl`。

### 为什么 batch 用进程而 delegate 用线程

这是本章最值得对比的一个工程选择。delegate 用 `ThreadPoolExecutor`、batch 用 `multiprocessing.Pool`，差异不是随意的：

- **delegate 的子 agent 共享父 agent 的进程**——它们要把进度中继回父 agent 的显示层、要把结果聚合回父 agent 的上下文，本质上是"一个任务内部的协作子结构"。线程共享内存，中继和聚合几乎零成本；线程也轻，几个子 agent 的开销可忽略。delegate 的工作量以"等 LLM 和等工具 I/O"为主，GIL 不是瓶颈。
- **batch 的样本彼此完全独立**——没有共享状态、没有结果聚合（各写各的 `batch_{n}.jsonl`）。batch 要跑成千上万个样本，工作量里有相当一部分是 CPU 密集的（轨迹格式转换、统计聚合、JSON 序列化），多进程能绕开 GIL 让多核真正并行。进程级隔离还有一个好处：一条样本把 agent 跑崩了（OOM、段错误），只死掉那一个 worker 进程，其它样本不受牵连——这对动辄跑几小时的大批量任务很重要。

一句话：**delegate 要的是"协作 + 轻量"，batch 要的是"隔离 + 吞吐"**，并发原语的选择直接服务于这两个不同目标。`Pool` 还有一个全局 `Lock`（`batch_runner.py:41` 导入）用于序列化检查点写入，避免多个 worker 进程同时写 `checkpoint.json`。

顺带一提，cron 的并发又是第三种选择——它用 `ThreadPoolExecutor`（像 delegate）但配 `copy_context()` 给每个作业独立的 `ContextVars`。cron 作业彼此独立（像 batch 的样本），按说该用进程；但 cron 的 tick 周期短、作业数通常不多、且需要共享网关传入的 `adapters` 活连接做投递——线程能直接共享这些活连接，进程则要额外的跨进程传递。所以 cron 选了"线程 + 上下文隔离"这个折中。三种模式、三种并发选择，背后是三套不同的约束权衡——这本身就是"同一个抽象的不同实例化"最好的注脚。

注意 batch 用 `multiprocessing.Pool`（`batch_runner.py:41`）而非 delegate 那样的线程池——批量任务可能 CPU 密集（大量轨迹格式转换、统计聚合），多进程能绕开 GIL，且进程级隔离避免一条样本崩溃污染其他样本。

### 检查点与断点续跑

`--resume` 的实现比"读一个进度计数器"更稳健。`_scan_completed_prompts_by_content()`（`batch_runner.py:732`）会扫描已有的 `batch_*.jsonl` 文件，**按 prompt 文本内容**匹配出哪些样本已经跑完，再用 `_filter_dataset_by_completed()`（`batch_runner.py:776`）把这些样本从待办数据集里剔除。按内容匹配而非按行号，意味着即使数据集顺序变了、或中途崩溃留下半截文件，续跑也能正确对齐。`_process_batch_worker()` 里有一条关键规则（`batch_runner.py:506`）：**只有成功且轨迹非空的样本才标记为已完成**——失败的样本会在 `--resume` 时自动重试。`checkpoint.json` 的写入走 `atomic_json_write()`，避免并发 worker 写坏检查点文件。

`BatchRunner` 还跨所有批次聚合**工具使用统计**（`_extract_tool_stats`，`batch_runner.py:125`）和推理统计（`_extract_reasoning_stats`，`batch_runner.py:208`），并用 `_normalize_tool_stats()` 把统计形态规范化——保证产出的 JSONL 能被 HuggingFace `datasets` 直接加载而不报 schema 不一致。`--distribution` 参数（用法示例 `batch_runner.py:20`）则按预设的工具集分布配置每个样本 agent 的可用工具。

### 轨迹的样子

`_convert_to_trajectory_format()` 产出的 `conversations` 是一个消息数组，每个元素是一个 `{"from": ..., "value": ...}` 对。`from` 的取值是训练框架习惯的角色名：`system`（系统提示）、`human`（用户/任务）、`gpt`（模型回复，含工具调用）、`tool`（工具返回）。一段精简的轨迹大致是：

```text
{"from": "human", "value": "在当前目录找出所有 .py 文件"}
{"from": "gpt",   "value": "我来查找。<tool_call>{\"name\":\"terminal\",
                            \"arguments\":{\"command\":\"ls *.py\"}}</tool_call>"}
{"from": "tool",  "value": "<tool_response>main.py\nutils.py</tool_response>"}
{"from": "gpt",   "value": "当前目录有两个 Python 文件：main.py 和 utils.py。"}
```

工具调用和工具返回被分别包进 `<tool_call>` / `<tool_response>` XML 标签。这正是 Hermes 工具调用模型训练时见到的格式——轨迹生成、压缩、训练三个环节用的是同一套表示，不需要中途做格式转换。`ephemeral_system_prompt` 不出现在这个数组里，就是前面说的"训练数据卫生"：执行时注入、轨迹里抹掉。

### MiniSWERunner

`MiniSWERunner` 定义在 `mini_swe_runner.py:160`，是专门给 SWE（软件工程）任务设计的执行环境。它的特点是用 Hermes 内置的**执行环境**抽象（见[第 9 章](09-environments.md)的 `BaseEnvironment`）来跑任务。

`MiniSWERunner.__init__`（`mini_swe_runner.py:166`）的 `env_type` 参数可选 `local` / `docker` / `modal`——分别对应在本机、Docker 容器、Modal 云沙箱里执行命令。`_create_environment()`（`mini_swe_runner.py:121`）按 `env_type` 实例化对应的 `BaseEnvironment` 子类，每个环境都暴露统一的 `execute()` / `cleanup()` 接口。这让 SWE 任务能在隔离环境里安全地跑——SWE 任务通常要改文件、装依赖、跑测试，本机直接跑有风险，Docker / Modal 给一个用完即弃的沙箱。

`MiniSWERunner` 与 `BatchRunner` 的关键区别在于"agent 跑命令的地方"：`BatchRunner` 的样本 agent 用 Hermes 标准工具集在本进程里跑；`MiniSWERunner` 把命令执行下放给 `BaseEnvironment`，agent 的工具调用被翻译成在容器/沙箱里执行。`run_task()`（`mini_swe_runner.py:417`）跑完一个任务后，`_convert_to_hermes_format()`（`mini_swe_runner.py:307`）把内部消息转成与 `batch_runner.py` 完全相同的 `from`/`value` 轨迹格式（工具调用用 `<tool_call>` / `<tool_response>` XML 包裹），`finally` 块里 `_cleanup_env()` 销毁环境。格式一致是有意的——MiniSWE 产出的轨迹可以无缝喂给同一条 `trajectory_compressor.py` 压缩流水线，和 batch 轨迹混在一起做训练数据。SWE 任务的系统提示同样是 ephemeral 的（`mini_swe_runner.py:437` 注释明确"not saved to trajectory"），不污染训练数据。

`env_type` 三个选项对应的安全/速度权衡值得展开：

- `local`——在跑 runner 的这台机器上直接执行命令。最快、零启动开销，但 SWE 任务可能 `rm` 文件、装包、改系统状态，本机跑有污染风险。适合可信任务或一次性调试。
- `docker`——每个任务在一个 Docker 容器里跑，`--image` 指定基础镜像。容器是隔离的、用完即弃，任务再怎么折腾也不影响宿主。代价是每个任务的容器启动开销。
- `modal`——在 Modal 云沙箱里跑。和 docker 同样隔离，但执行发生在云端、不占本机资源，适合大规模并行或本机算力不足的场景。

三者背后是同一个 `BaseEnvironment` 接口，`MiniSWERunner` 的代码不关心具体是哪种——它只调 `env.execute()` / `env.cleanup()`。这种抽象让"任务在哪跑"成为一个纯配置项，runner 逻辑完全复用。

`mini_swe_runner.py` 自己也支持 `--prompts_file` 批量模式（用法 `mini_swe_runner.py:26`），从 JSONL 读多个 SWE 任务、逐个 `run_task()`、汇总成轨迹文件。它和 `BatchRunner` 的分工是：`BatchRunner` 面向通用 agent 任务、用多进程池追求吞吐；`MiniSWERunner` 面向 SWE 任务、强调执行环境隔离。两者产物格式一致，可以汇入同一个训练数据集。

---

## 14.5 三者的共同点

回到本章开头的命题。Cron、delegate、batch 表面上风马牛不相及——一个是定时任务，一个是 agent 内部 fork，一个是数据集批处理。但它们底层是同一件事：**非交互式地驱动 `AIAgent`**。

把三者放在一张表里对比，与交互式 CLI 的差异一目了然：

<svg viewBox="0 0 820 290" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Four-way comparison of interactive CLI cron delegate and batch">
  <defs/>
  <g font-size="10.5" font-weight="700">
    <rect x="160" y="16" width="160" height="30" rx="5" fill="#f1f5f9" stroke="#94a3b8"/>
    <text x="240" y="36" text-anchor="middle" fill="currentColor">交互式 CLI</text>
    <rect x="324" y="16" width="160" height="30" rx="5" fill="#fed7aa" stroke="#ea580c"/>
    <text x="404" y="36" text-anchor="middle" fill="currentColor">Cron</text>
    <rect x="488" y="16" width="160" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
    <text x="568" y="36" text-anchor="middle" fill="currentColor">Delegate</text>
    <rect x="652" y="16" width="160" height="30" rx="5" fill="#99f6e4" stroke="#0d9488"/>
    <text x="732" y="36" text-anchor="middle" fill="currentColor">Batch</text>
  </g>
  <g font-size="10" font-weight="600" fill="currentColor">
    <text x="12" y="68">谁触发</text>
    <text x="12" y="106">危险操作</text>
    <text x="12" y="144">输出去哪</text>
    <text x="12" y="182">禁用工具</text>
    <text x="12" y="220">并发模型</text>
    <text x="12" y="258">AIAgent</text>
  </g>
  <g font-size="9.5" fill="#64748b">
    <text x="240" y="68" text-anchor="middle">用户实时输入</text>
    <text x="404" y="68" text-anchor="middle">调度器到点触发</text>
    <text x="568" y="68" text-anchor="middle">父 agent 调工具</text>
    <text x="732" y="68" text-anchor="middle">数据集每条样本</text>
    <text x="240" y="106" text-anchor="middle">人来批准（卡片）</text>
    <text x="404" y="100" text-anchor="middle">HERMES_CRON_</text>
    <text x="404" y="112" text-anchor="middle">SESSION 自动放行</text>
    <text x="568" y="100" text-anchor="middle">_subagent_auto_</text>
    <text x="568" y="112" text-anchor="middle">deny（默认拒绝）</text>
    <text x="732" y="100" text-anchor="middle">subagent_auto_</text>
    <text x="732" y="112" text-anchor="middle">approve（可配）</text>
    <text x="240" y="144" text-anchor="middle">回终端/原聊天</text>
    <text x="404" y="144" text-anchor="middle">DeliveryTarget 路由</text>
    <text x="568" y="144" text-anchor="middle">返回父 agent 摘要</text>
    <text x="732" y="144" text-anchor="middle">写轨迹文件</text>
    <text x="240" y="182" text-anchor="middle">无</text>
    <text x="404" y="176" text-anchor="middle">cronjob/messaging</text>
    <text x="404" y="188" text-anchor="middle">/clarify</text>
    <text x="568" y="176" text-anchor="middle">DELEGATE_BLOCKED</text>
    <text x="568" y="188" text-anchor="middle">_TOOLS（5 个）</text>
    <text x="732" y="182" text-anchor="middle">按 distribution</text>
    <text x="240" y="220" text-anchor="middle">单会话</text>
    <text x="404" y="220" text-anchor="middle">ThreadPool 作业</text>
    <text x="568" y="220" text-anchor="middle">ThreadPool 子 agent</text>
    <text x="732" y="220" text-anchor="middle">multiprocessing.Pool</text>
    <text x="240" y="258" text-anchor="middle">每会话缓存复用</text>
    <text x="404" y="258" text-anchor="middle">每作业新建</text>
    <text x="568" y="258" text-anchor="middle">每子任务新建</text>
    <text x="732" y="258" text-anchor="middle">每样本新建</text>
  </g>
  <g stroke="#cbd5e1" stroke-width="1">
    <line x1="8" y1="80" x2="812" y2="80"/>
    <line x1="8" y1="122" x2="812" y2="122"/>
    <line x1="8" y1="160" x2="812" y2="160"/>
    <line x1="8" y1="198" x2="812" y2="198"/>
    <line x1="8" y1="236" x2="812" y2="236"/>
  </g>
</svg>
<span class="figure-caption">图 R14.6 ｜ 交互式 CLI 与 cron / delegate / batch 三种非交互模式在触发、批准、输出、禁用工具、并发、agent 复用六个维度的对比。</span>

<details>
<summary>ASCII 原版</summary>

```text
              交互式 CLI       Cron                Delegate              Batch
  ──────────  ───────────────  ──────────────────  ────────────────────  ─────────────────
  谁触发      用户实时输入     调度器到点触发      父 agent 调工具       数据集每条样本
  危险操作    人来批准         HERMES_CRON_SESSION  _subagent_auto_deny   subagent_auto_
              （CLI/卡片）     → 自动放行          （默认拒绝）          approve（可配）
  输出去哪    回终端/原聊天    DeliveryTarget 路由  返回父 agent 摘要     写轨迹文件
  禁用工具    无               cronjob/messaging/   DELEGATE_BLOCKED_     （按 distribution）
                               clarify             TOOLS（5 个）
  并发模型    单会话           ThreadPool 并行作业  ThreadPool 并行子 agent  multiprocessing.Pool
  AIAgent     每会话缓存复用   每作业新建          每子任务新建          每样本新建
```

</details>

四个共同特征：

1. **批准必须自动化**。没有人在场就没人能点"同意"。Cron 用进程级 `HERMES_CRON_SESSION` 自动放行；delegate 用线程级 TLS 回调（默认 auto-deny，可配 auto-approve）；batch 同样靠 `subagent_auto_approve` 配置。批准策略从"问人"退化成"按规则"。一个值得品味的细节是**默认值的方向**：cron 默认放行（因为 cron 作业是用户主动创建、显式信任的），delegate 默认拒绝（因为子 agent 是 agent 自己 fork 的、不享有用户的完整信任）。同样是"没人在场"，信任来源不同，默认就不同。
2. **输出需要显式路由**。交互式模式输出天然回到用户面前；非交互式模式必须显式指定"输出去哪"——cron 的 `DeliveryTarget`、delegate 的"返回父 agent 摘要"、batch 的"写轨迹文件"。
3. **交互工具必须禁用**。`clarify`（澄清提问）在没人时毫无意义；递归触发能力（cron 创建 cron、子 agent 再派发）会导致失控，所以也禁。三者禁的工具集不同，但理由同构——凡是"假设有人在场"或"能无界放大自身"的工具，在非交互式模式下都要关掉。
4. **成本必须设界**。没人盯着账单，所以默认值必须保守、必须有硬上限。cron 默认剔除 `moa`（前面那笔 4.63 美元事故的修复），delegate 有 `max_concurrent_children` / `max_spawn_depth` / `child_timeout` 三道限制，batch 有 `batch_size` / `num_workers`。

还有一个隐含的共同点在表的最后一行：**`AIAgent` 在这三种模式里都是"用完即弃"的**——每作业、每子任务、每样本都新建一个，跑完丢掉。这和交互式 CLI"每会话缓存复用一个 agent"截然不同。原因是非交互式任务彼此独立、没有跨任务的对话连续性需求，新建 agent 反而保证了干净的隔离（独立的上下文、独立的工具状态）。`AIAgent` 因此被设计成**轻量、可大量实例化**的——这个设计约束正是被 cron / delegate / batch 三种用法共同逼出来的。

### 何时用哪一个

三者虽然底层同构，但适用场景界限分明，选错会很别扭：

- **要"到点自动跑"用 cron**。判据是**时间触发**——任务的发生取决于时钟，而非某个 agent 的决策。"每天汇总新闻"、"每小时检查磁盘"是 cron；"现在帮我调研一下"不是。cron 还能用 `no_agent` 退化成纯脚本看门狗，连 LLM 都不需要。
- **要"一个任务内部并行分解"用 delegate**。判据是**有一个父 agent 想把活拆开并行干、且想保持自己上下文干净**。它是 agent 运行**期间**的一个工具调用，生命周期嵌在父 agent 的一轮对话里。它不是用来跑大批量任务的——delegate 的并发上限只有个位数。
- **要"对一个数据集逐条跑、收集结果"用 batch**。判据是**有一个静态数据集、要为每条样本各跑一个独立 agent、主要为了产出轨迹**。它是离线的、面向吞吐的，跑几千条样本是它的常态。SWE 类任务则进一步用 `MiniSWERunner` 拿到执行环境隔离。

一个容易混淆的点：delegate 和 batch 都"并行跑多个 agent"，但 delegate 的并行是**一个 agent 任务内部的子结构**（父子关系、结果回传父上下文），batch 的并行是**多个互不相关的顶层任务**（无父无子、结果各写各的轨迹）。前者用线程池（共享进程、轻量）、后者用进程池（隔离、抗崩溃），并发模型的选择正反映了这个本质差异。

### 与轨迹压缩、训练数据生成的关系

batch 和 mini-swe runner 产出的轨迹，并不是终点。Hermes 是一个**自我改进的 agent 框架**——它会把这些轨迹经过压缩（`trajectory_compressor.py`，见[第 8 章](08-self-improvement.md)）加工成训练数据，用来训练**下一代工具调用模型**。

这条链路上有几个工程细节值得点明：

- **轨迹格式是统一的**。`batch_runner.py` 的 `_convert_to_trajectory_format()` 和 `mini_swe_runner.py` 的 `_convert_to_hermes_format()` 产出的都是 `from`/`value` 对（`from` 取 `system`/`human`/`gpt`/`tool`），工具调用用 `<tool_call>` / `<tool_response>` XML 包裹。格式统一意味着两种 runner 的产物可以混进同一个数据集、喂给同一条压缩流水线。
- **ephemeral_system_prompt 是"训练数据卫生"措施**。batch 和 mini-swe 的系统提示都标成 ephemeral——执行时生效、但不写进轨迹。如果系统提示进了轨迹，训练数据就会被特定提示词污染，模型会学到对那段提示的过拟合。把它排除掉，轨迹里只剩"任务 + agent 的真实工具调用序列"。
- **delegate 也间接参与**。delegate 产生的父子 agent 对话同样可以成为轨迹的一部分——一个会派发子任务的 agent 轨迹，能教模型学会"如何分解任务"。

也就是说，今天用 batch 跑出来的轨迹，会变成明天那个更强的 Hermes 模型的养料。这就是 Hermes "学习闭环"在工程上的落点：cron / delegate / batch 不只是把 agent 跑起来，它们还是数据飞轮的进料口。本章这三个看似只是"运维设施"的功能，实际上同时是 Hermes 自我改进闭环的基础设施——这也是它们值得放在一起、单独成章讲的深层原因。

---

## 延伸阅读

- [第 2 章 AIAgent 核心](02-aiagent-core.md)——cron / delegate / batch 反复构造的 `AIAgent` 本身。
- [第 6 章 技能系统](06-skills.md)——cron 作业的 `skills` 字段、为什么需要扫描加载的技能内容。
- [第 7 章 上下文引擎](07-context-engine.md)——delegate 的"父 agent 只看摘要"本质上是上下文隔离/压缩。
- [第 8 章 自我改进](08-self-improvement.md)——batch / mini-swe 轨迹如何经压缩进入训练闭环。
- [第 9 章 执行环境](09-environments.md)——`MiniSWERunner` 使用的 `BaseEnvironment`（local / docker / modal）。
- [第 13 章 消息网关与多平台](13-messaging-gateway.md)——cron 投递所用的 `DeliveryTarget` 与 `standalone_sender_fn`。
