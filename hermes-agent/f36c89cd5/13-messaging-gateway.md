# 第 13 章 消息网关与多平台

前面十二章里，Hermes Agent 始终被当作一个跑在终端里的程序：一个用户、一个进程、一个会话。但 Hermes 的真正定位是一个"常驻 agent"——它应该同时活在 Telegram、Discord、Slack、WhatsApp、Signal、企业微信、飞书、邮件、短信等几十个消息平台上，随时响应任何一个渠道发来的消息。

这就引出了一个棘手的工程问题：**单个进程如何同时维护几十条长连接，把来自不同平台、不同聊天、不同用户的消息正确地分流给 agent，又把 agent 的回复精确地送回原处？** 本章讲清楚 Hermes 的答案——消息网关（gateway）。

网关代码集中在 `gateway/` 目录，核心是 `gateway/run.py`（17000 多行，是全仓库最大的单文件）。它不是另一个 agent，而是 agent 的"外壳"：它负责连接管理、消息路由、会话隔离、权限控制，而真正的推理仍然交给前面章节讲过的 `AIAgent`（见[第 2 章](02-aiagent-core.md)）。

---

## 13.1 问题：一个进程，几十条长连接

考虑把 agent 接入 Telegram 的最朴素做法：写一个 Telegram bot 脚本，长轮询拉取消息，每收到一条就调一次 agent。再接 Discord，再写一个脚本。再接 Slack、WhatsApp……很快就有几十个互不相干的进程，每个都要单独配置、单独重启、单独监控，而且它们之间无法共享会话、记忆、cron 调度。

Hermes 的设计目标恰恰相反：**一个进程承载所有平台**。这带来几个必须解决的难题。

<svg viewBox="0 0 820 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="GatewayRunner single-process message routing pipeline">
  <defs>
    <marker id="r13ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="14" y="14" width="792" height="392" rx="10" fill="#fff" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="410" y="40" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">GatewayRunner（单进程）</text>
  <g font-size="11" fill="#64748b">
    <text x="60" y="92" text-anchor="end">Telegram</text>
    <text x="60" y="112" text-anchor="end">Discord</text>
    <text x="60" y="132" text-anchor="end">Slack</text>
    <text x="60" y="152" text-anchor="end">WhatsApp</text>
    <text x="60" y="172" text-anchor="end">… (40+)</text>
  </g>
  <path d="M66,88 L150,100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <path d="M66,108 L150,108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <path d="M66,128 L150,116" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <path d="M66,148 L150,124" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <path d="M66,168 L150,132" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <rect x="160" y="84" width="200" height="56" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="260" y="106" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">adapters dict</text>
  <text x="260" y="126" text-anchor="middle" font-size="10" fill="#64748b">_create_adapter() · 每平台一个 Adapter</text>
  <text x="395" y="158" font-size="10" fill="#94a3b8">MessageEvent</text>
  <path d="M260,140 L260,176" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <rect x="120" y="178" width="280" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="260" y="203" text-anchor="middle" font-size="11" fill="currentColor">会话路由 → SessionSource → session_key</text>
  <path d="M260,218 L260,250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <rect x="120" y="252" width="280" height="40" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="260" y="277" text-anchor="middle" font-size="11" fill="currentColor">_agent_cache（每会话一个 AIAgent, LRU+TTL）</text>
  <path d="M260,292 L260,324" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar)"/>
  <rect x="120" y="326" width="280" height="40" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="260" y="351" text-anchor="middle" font-size="11" fill="currentColor">AIAgent.run_conversation()｜工具调用循环</text>
  <path d="M400,346 L470,346 L470,200 L400,200" fill="none" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r13ar)"/>
  <rect x="490" y="180" width="280" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="630" y="201" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">DeliveryRouter</text>
  <text x="630" y="218" text-anchor="middle" font-size="10" fill="#64748b">adapter.send() → 回到原处</text>
  <path d="M490,204 L478,204" stroke="#94a3b8" stroke-width="1.2"/>
</svg>
<span class="figure-caption">图 R13.1 ｜ GatewayRunner 单进程把几十个平台的消息汇入会话路由、agent 缓存、推理循环，再经 DeliveryRouter 送回原处。</span>

<details>
<summary>ASCII 原版</summary>

```text
            ┌─────────────────────────────────────────────┐
            │            GatewayRunner (单进程)           │
            │                                             │
  Telegram ─┤  ┌──────────┐                               │
  Discord  ─┤  │ adapters │   _create_adapter()           │
  Slack    ─┤  │  dict    │   每平台一个 BasePlatformAdapter│
  WhatsApp ─┤  └────┬─────┘                               │
  Signal   ─┤       │ MessageEvent                        │
  ...(40+) ─┤       ▼                                     │
            │  会话路由 → SessionSource → session_key      │
            │       │                                     │
            │       ▼                                     │
            │  _agent_cache (每会话一个 AIAgent, LRU+TTL)  │
            │       │                                     │
            │       ▼                                     │
            │  AIAgent.run_conversation()  ← 工具调用循环 │
            │       │                                     │
            │       ▼                                     │
            │  DeliveryRouter → adapter.send() → 回到原处  │
            └─────────────────────────────────────────────┘
```

</details>

难题清单：

1. **并发**：几十条连接，有的用 webhook、有的用长轮询、有的用 WebSocket，必须并发跑而不互相阻塞。Hermes 全部跑在一个 `asyncio` 事件循环里，每个适配器是若干个 `asyncio.Task`。
2. **隔离**：Telegram 群里 A 用户和 B 用户的对话不能串台；同一个用户在 Telegram 和 Discord 上应该是不同的会话；但又要能跨平台共享记忆。这靠 `SessionSource` + `session_key` 解决（§13.5）。
3. **生命周期**：某个平台凭证失效、网络抖动，不能把整个进程拖垮。`BasePlatformAdapter` 用 `_fatal_error_*` 字段隔离单平台故障（§13.3）。
4. **安全**：消息平台是开放入口，任何人都能给 bot 发消息。Hermes 不能对所有人都执行 agent。这靠 DM 配对（§13.6）和授权检查解决。
5. **资源**：每个活跃会话缓存一个 `AIAgent`（为了保住 prompt caching，见[第 7 章](07-context-engine.md)），但不能无限缓存。靠 LRU + idle TTL 淘汰（§13.5）。

接下来逐一拆解。

---

## 13.2 GatewayRunner：主控制器

`GatewayRunner` 定义在 `gateway/run.py:1175`，是整个网关的中枢。它的职责一句话概括：**管理所有平台适配器的生命周期，把消息在适配器与 agent 之间双向路由。**

构造函数 `__init__` 在 `gateway/run.py:1198`，做的事情可以分成四组：

```python
# gateway/run.py:1198 起（节选）
def __init__(self, config: Optional[GatewayConfig] = None):
    self.config = config or load_gateway_config()
    self.adapters: Dict[Platform, BasePlatformAdapter] = {}
    # ...
    self.session_store = SessionStore(self.config.sessions_dir, self.config, ...)
    self.delivery_router = DeliveryRouter(self.config)
    self._shutdown_event = asyncio.Event()
    # 每会话缓存一个 AIAgent，OrderedDict 实现 LRU
    self._agent_cache: "OrderedDict[str, tuple]" = OrderedDict()
    self._agent_cache_lock = _threading.Lock()
    # DM 配对存储
    from gateway.pairing import PairingStore
    self.pairing_store = PairingStore()
```

四组职责：

- **配置**：`load_gateway_config()` 读取 `config.yaml` 与环境变量，得到 `GatewayConfig`（平台开关、home channel、reset 策略等）。同时加载若干"临时配置"（prefill、ephemeral system prompt、reasoning config），这些只在 API 调用时注入、绝不持久化。
- **存储**：`SessionStore` 把每个会话的对话历史持久化到磁盘（`config.sessions_dir`），并接入 `process_registry`，使得"有后台进程在跑"的会话不会被 reset 策略误清。
- **路由**：`DeliveryRouter`（§13.7）负责把 agent 输出送到正确目的地。
- **运行态**：`_running_agents`（正在跑的 agent，用于中断）、`_agent_cache`（空闲 agent 缓存）、`_queued_events`（`/queue` 命令排队）、`_session_sources`（会话来源 LRU 缓存）等。

注意 `_agent_cache` 与 `_running_agents` 是两个不同的字典：前者是空闲缓存（为了下一轮复用 prompt cache），后者是当前正在执行的 agent（为了支持中断 / `/stop`）。一个 agent 在两者之间迁移。

### 启动入口 start_gateway()

模块级函数 `start_gateway()` 在 `gateway/run.py:16695`，是网关的真正入口（`hermes gateway` 命令最终调它）。它在构造 `GatewayRunner` 之前先做一件关键的事——**重复实例守卫**：

```python
# gateway/run.py:16695 起（节选）
async def start_gateway(config=None, replace=False, verbosity=0) -> bool:
    existing_pid = get_running_pid()
    if existing_pid is not None and existing_pid != os.getpid():
        if replace:
            write_takeover_marker(existing_pid)   # 告诉旧进程这是计划内接管
            terminate_pid(existing_pid, force=False)
            # 等待最多 10 秒，仍不退出则 SIGKILL
            ...
        else:
            return False   # 已有实例在跑，直接拒绝
```

为什么需要这个守卫？因为两个网关进程跑在同一个 `HERMES_HOME` 下会争抢 `gateway.pid`、`sessions/` 目录、cron 锁——会话历史会被互相覆盖。PID 文件按 `HERMES_HOME` 作用域隔离，所以未来的多 profile 部署（每个 profile 一个 `HERMES_HOME`）天然允许并发实例而不会触发这个守卫。

`--replace` 选项是为 systemd 设计的：服务重启时旧进程可能还没完全退出，`--replace` 会先杀掉它。注意 `write_takeover_marker()` 这个细节——它在旧进程的目录里写一个标记，让旧进程的 shutdown 处理器识别出"这个 SIGTERM 是计划内接管"，从而以退出码 0 退出。否则 systemd 的 `Restart=on-failure` 会把非零退出当成崩溃，触发重启风暴。

### 适配器的动态实例化 _create_adapter()

`_create_adapter()` 在 `gateway/run.py:5256`，根据 `Platform` 枚举创建对应的适配器实例。它的查找顺序是设计要点：

```python
# gateway/run.py:5256 起（节选）
def _create_adapter(self, platform, config):
    # ① 先查插件注册表
    from gateway.platform_registry import platform_registry
    if platform_registry.is_registered(platform.value):
        adapter = platform_registry.create_adapter(platform.value, config)
        if adapter is not None:
            return adapter
        return None   # 注册了但创建失败 → 不回落到内置
    # ② 回落到内置 if/elif 链
    if platform == Platform.TELEGRAM:
        from gateway.platforms.telegram import TelegramAdapter, ...
        ...
    elif platform == Platform.DISCORD:
        ...
```

**先查插件注册表，再回落到内置 if/elif 链。** 这个顺序意味着插件可以覆盖内置适配器（比如某用户想用自己的 Telegram 实现替换官方实现）。注意：如果一个平台在注册表里登记了但 `create_adapter()` 返回 `None`（依赖缺失或配置错误），代码不会再回落到内置链——因为插件平台本就没有内置实现，静默回落只会掩盖错误。

内置适配器的每个分支都先调 `check_*_requirements()` 检查依赖（Telegram 需要 `python-telegram-bot`，Slack 需要 `slack-bolt`，Signal 需要 `SIGNAL_HTTP_URL`……），缺依赖就 log 一条 warning 并返回 `None`，让该平台优雅地不上线，而不是让整个网关崩溃。

---

## 13.3 平台适配器模式：BasePlatformAdapter

40 多个平台，每个平台的 API 千差万别——Telegram 是 Bot API + 长轮询，Discord 是 Gateway WebSocket，Slack 是 Bolt 框架，WhatsApp 走一个 Node.js 桥接进程……Hermes 用经典的**适配器模式**把这些差异收敛到一个统一接口背后。

`BasePlatformAdapter` 定义在 `gateway/platforms/base.py:1268`，是所有平台适配器的抽象基类。`GatewayRunner` 只与这个接口打交道，完全不知道某条消息究竟来自 Telegram 还是 Discord。

### 三个必须实现的抽象方法

`BasePlatformAdapter` 用 `@abstractmethod` 强制子类实现三个方法：

```python
# gateway/platforms/base.py:1541 起
@abstractmethod
async def connect(self) -> bool:
    """连接平台并开始接收消息。成功返回 True。"""

@abstractmethod
async def disconnect(self) -> None:
    """断开连接。"""

@abstractmethod
async def send(self, chat_id, content, reply_to=None, metadata=None) -> SendResult:
    """向某个聊天发送一条消息。"""
```

`connect()`（`base.py:1542`）是适配器的启动点——建立长连接、注册消息回调、开始接收。`send()`（`base.py:1556`）是出站接口——把 agent 的文字回复送出去。`disconnect()`（`base.py:1551`）在网关关闭时优雅断连。

### 富媒体发送的默认实现

除了三个抽象方法，基类还提供了大量**带默认实现**的富媒体方法，子类按需覆盖：

| 方法 | 位置 | 用途 |
|------|------|------|
| `send_image()` | `base.py:1906` | 发送单张图片 |
| `send_multiple_images()` | `base.py:1849` | 发送图片组 |
| `send_animation()` | `base.py:1925` | 发送 GIF / 动图 |
| `send_voice()` | `base.py:1996` | 发送语音消息（语音气泡） |
| `send_video()` | `base.py:2038` | 发送视频 |
| `send_document()` | `base.py:2058` | 发送文件附件 |
| `send_draft()` | `base.py:1358` | 流式草稿预览（Telegram 9.5+） |
| `send_typing()` | `base.py:1832` | "正在输入"指示器 |
| `send_slash_confirm()` | `base.py:1720` | 危险命令确认卡片 |
| `send_clarify()` | `base.py:1755` | 澄清提问 |

这种"抽象方法少、默认实现多"的设计让新增一个平台适配器的成本很低：只要实现 `connect/disconnect/send`，bot 就能收发文字；富媒体能力可以渐进式补充。

### 单平台故障隔离

基类还内置了一套故障隔离机制（`base.py:1284` 附近的 `_fatal_error_*` 字段）。当某个平台遇到**不可恢复**的错误（比如 token 被撤销），适配器把 `_fatal_error_message`、`_fatal_error_code`、`_fatal_error_retryable` 填好，`has_fatal_error` 属性变为真。`GatewayRunner` 检测到后，只让这一个平台下线，其余平台继续服务。这就是"一个 Telegram token 失效不会拖垮 Discord"的保证。

适配器还为**中断支持**维护了精细的运行态：`_active_sessions`（每会话的中断 Event）、`_session_tasks`（每会话当前正在处理的 Task）、`_background_tasks`（后台消息处理任务集合）。`_session_tasks` 这个映射很关键——`/stop`、`/new`、`/reset` 这类"终结会话"的命令需要取消**正确的那个** Task。如果没有 owner-task 映射，一个旧 Task 的 `finally` 块可能误删一个更新 Task 的守卫，留下"卡死"的 busy 状态。

---

## 13.4 平台注册表：PlatformEntry

内置平台靠 `_create_adapter()` 里的 if/elif 链，那**插件提供的平台**怎么接入？答案是 `gateway/platform_registry.py` 里的注册表。

`PlatformEntry` 定义在 `gateway/platform_registry.py:38`，是一个 `dataclass`，描述了一个平台适配器的全部元数据与工厂。它不是"一个类",而是"一份登记表"——把适配器需要的所有信息打包成数据，让网关可以无 if/elif 地发现并实例化。

核心字段：

```python
# gateway/platform_registry.py:38 起（节选）
@dataclass
class PlatformEntry:
    name: str                              # config.yaml 里的标识符，如 "irc"
    label: str                             # 人类可读名，如 "IRC"
    adapter_factory: Callable[[Any], Any]  # 工厂：传入 PlatformConfig，返回适配器实例
    check_fn: Callable[[], bool]           # 依赖是否就绪
    validate_config: Optional[Callable]    # 配置是否完整
    required_env: list                     # 需要的环境变量（供 hermes setup 显示）
    install_hint: str                      # check_fn 为假时的安装提示
    source: str = "plugin"                 # "builtin" 或 "plugin"
    standalone_sender_fn: Optional[Callable] = None  # 脱离网关的独立发送
    # ……还有 ~20 个可选字段
```

几个设计要点：

**为什么用工厂而不是裸类？** 注释（`platform_registry.py:48-50`）说得很清楚：工厂让插件能做自定义初始化——传入额外 kwargs、包一层 try/except 等。一个裸类构造函数做不到这些。

**`check_fn` 与 `validate_config` 的分工**：`check_fn` 检查"依赖装了没"（库、外部进程），`validate_config` 检查"配对了没"（token、server 地址）。`create_adapter()`（`platform_registry.py:208`）按顺序跑这两个检查，任何一个失败就返回 `None` 并 log warning，绝不抛异常打断网关。

**插件覆盖内置**：`register()`（`platform_registry.py:172`）采用"后写者胜"——同名条目直接替换。这让插件能够覆盖内置适配器。配合 `_create_adapter()` 里"先查注册表"的顺序，覆盖才真正生效。

**`standalone_sender_fn` 解决的问题**：cron 调度器可能跑在与网关**不同的进程**里（见[第 14 章](14-cron-delegate-batch.md)）。这时进程内拿不到活的适配器，`tools/send_message_tool` 就调用 `standalone_sender_fn`——它临时开一条连接、发完即关。没有这个钩子，插件平台就无法作为 cron 的 `deliver=` 目标。

注册表本身 `PlatformRegistry`（`platform_registry.py:162`）只是一个 `dict` 的薄封装，模块级单例 `platform_registry`（`platform_registry.py:260`）全局唯一。写操作只在启动时的顺序发现阶段发生，读操作（dict 查找在 GIL 下原子）线程安全。

---

## 13.5 会话上下文：SessionSource 与每会话 agent 缓存

网关收到一条消息后，第一件事是回答："这条消息属于哪个会话？" 这由 `SessionSource` 回答。

`SessionSource` 定义在 `gateway/session.py:71`，是一个 `dataclass`，描述"一条消息从哪来"：

```python
# gateway/session.py:71 起（节选）
@dataclass
class SessionSource:
    platform: Platform
    chat_id: str
    chat_name: Optional[str] = None
    chat_type: str = "dm"          # "dm" / "group" / "channel" / "thread"
    user_id: Optional[str] = None
    user_name: Optional[str] = None
    thread_id: Optional[str] = None      # 论坛话题 / Discord 线程
    guild_id: Optional[str] = None       # Discord guild / Slack workspace
    message_id: Optional[str] = None     # 触发消息的 ID（用于回复/置顶/表态）
    # ……
```

这份信息有三个用途（见 `session.py:72-79` 的 docstring）：① 把回复路由回正确的地方；② 注入到系统提示里让 agent 知道自己身处何处；③ 给 cron 作业记录 origin 用于投递。

`chat_type` 字段区分了 DM、群、频道、线程——这决定了会话隔离粒度。Telegram 群里每个用户是不是独立会话，取决于 `group_sessions_per_user` 配置。

### PII 哈希

消息平台的用户 ID 和聊天 ID 是敏感信息。`session.py` 顶部定义了一组哈希工具：

```python
# gateway/session.py:34 起
def _hash_id(value: str) -> str:
    """标识符的确定性 12 字符十六进制哈希。"""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]

def _hash_sender_id(value: str) -> str:
    return f"user_{_hash_id(value)}"
```

`_PII_SAFE_PLATFORMS`（`session.py:195`）列出了可以安全脱敏的平台——WhatsApp、Signal、Telegram、BlueBubbles。**Discord 被排除在外**，因为 Discord 的 @提及语法是 `<@user_id>`，LLM 需要真实 ID 才能正确标记用户。这是一个"安全 vs 功能"的精确权衡：哪里能脱敏就脱敏，哪里脱敏会破坏功能就保留原值。

### 每会话一个 AIAgent：LRU + idle TTL

网关为**每个活跃会话**缓存一个独立的 `AIAgent` 实例，存在 `_agent_cache`（`gateway/run.py:1275`，一个 `OrderedDict`）里。

为什么不复用一个全局 agent？因为：① 不同会话的对话历史必须隔离；② 每个 agent 持有自己的 memory provider、prompt cache。复用一个 agent 会导致会话串台。

为什么不无限缓存？因为每个 agent 占内存。所以缓存有两道淘汰闸门：

- **硬上限**：`_AGENT_CACHE_MAX_SIZE` 限制条目数，`_enforce_agent_cache_cap()` 在超限时弹出最久未用的（`OrderedDict` 头部）。
- **idle TTL**：`_AGENT_CACHE_IDLE_TTL_SECS = 3600.0`（`gateway/run.py:63`），`_sweep_idle_cached_agents()` 周期性清掉空闲超过 1 小时的 agent。

**为什么要缓存而不是每次新建？** 关键在 prompt caching（见[第 7 章](07-context-engine.md)）。同一个会话连续多轮对话，系统提示和历史前缀不变。如果每轮都新建 agent，provider 端的 prompt cache 就失效了，每轮都要重新计费整个前缀。复用 agent 实例 = 命中 prompt cache = 省钱省延迟。`OrderedDict` 让"最近用过的排到尾部、最久未用的在头部"成为 O(1) 操作，完美匹配 LRU 语义。

---

## 13.6 DM 配对安全：PairingStore

消息平台是开放入口——任何知道 bot 用户名的人都能给它发私信。如果网关对所有人都执行 agent，那就等于把一个能跑 shell 命令、能花 token 的 AI 暴露给全世界。这显然不行。

传统做法是**静态白名单**：在配置里写死允许的 user ID 列表。但这很笨——用户 ID 难获取、难输入、加人要改配置重启。Hermes 用的是**配对码**机制，代码在 `gateway/pairing.py`。

`PairingStore` 定义在 `gateway/pairing.py:76`。流程是这样的：

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="DM pairing code approval flow">
  <defs>
    <marker id="r13ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="20" width="360" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="45" text-anchor="middle" font-size="12" fill="currentColor">陌生人首次私信 bot</text>
  <path d="M380,60 L380,84" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar2)"/>
  <rect x="160" y="86" width="440" height="44" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="105" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">generate_code()</text>
  <text x="380" y="121" text-anchor="middle" font-size="10" fill="#64748b">生成 8 字符配对码（如 "K7M2PQR4"）</text>
  <path d="M380,130 L380,154" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar2)"/>
  <rect x="160" y="156" width="440" height="40" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="181" text-anchor="middle" font-size="11" fill="currentColor">bot 回复："你的配对码是 K7M2PQR4，请让管理员批准"</text>
  <path d="M380,196 L380,220" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar2)"/>
  <rect x="160" y="222" width="440" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="247" text-anchor="middle" font-size="11" fill="currentColor">管理员 CLI: hermes pairing approve K7M2PQR4</text>
  <path d="M380,262 L380,286" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r13ar2)"/>
  <rect x="160" y="288" width="440" height="28" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/>
  <text x="380" y="306" text-anchor="middle" font-size="11" fill="currentColor">approve_code() → 进入 approved 列表，之后正常对话</text>
</svg>
<span class="figure-caption">图 R13.2 ｜ DM 配对安全流程：陌生人首次私信生成配对码，管理员 CLI 批准后才进入授权列表。</span>

<details>
<summary>ASCII 原版</summary>

```text
陌生人首次私信 bot
        │
        ▼
generate_code() → 生成 8 字符配对码（如 "K7M2PQR4"）
        │
        ▼
bot 回复："你的配对码是 K7M2PQR4，请让管理员批准"
        │
        ▼
管理员在 CLI 里运行 hermes pairing approve K7M2PQR4
        │
        ▼
approve_code() → 该用户进入 approved 列表，之后正常对话
```

</details>

`gateway/pairing.py:8-17` 的 docstring 列出了完整的安全特性，每一条都基于 OWASP / NIST SP 800-63-4 指南：

```python
# gateway/pairing.py:34 起
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # 无歧义字母表，排除 0/O 1/I
CODE_LENGTH = 8
CODE_TTL_SECONDS = 3600        # 配对码 1 小时过期
RATE_LIMIT_SECONDS = 600       # 每用户每 10 分钟限 1 次请求
LOCKOUT_SECONDS = 3600         # 失败过多后锁定 1 小时
MAX_PENDING_PER_PLATFORM = 3   # 每平台最多 3 个待批准码
MAX_FAILED_ATTEMPTS = 5        # 5 次失败批准后触发锁定
```

逐条解释**为什么需要**：

- **无歧义字母表**：排除 `0/O`、`1/I`，因为配对码要靠人眼读、人手输——歧义字符会让用户反复输错。
- **`secrets.choice()` 生成**（`pairing.py:179`）：用密码学安全随机数，不是 `random`。配对码本质是临时凭证，可预测的随机数能被暴力破解。
- **1 小时过期**：配对码是一次性凭证，长期有效会扩大攻击窗口。
- **速率限制**：每用户每 10 分钟只能请求一次，防止刷码 DoS。
- **每平台最多 3 个待批准码**：限制待处理队列，防止陌生人塞满队列。
- **失败锁定**：连续 5 次错误的批准尝试 → 该平台锁定 1 小时。这是防暴力破解的核心。

注意 `approve_code()`（`pairing.py:194`）里有一个细节性安全修复：**锁定检查必须在 pending 查找之前**。注释（`pairing.py:206-213`）解释，如果不这样，一个已经发出的有效配对码即使在锁定期内也能被接受——锁定就只防住了 `generate_code` 而没防住 `approve_code`，等于让暴力破解保护失效。

存储层面，所有数据文件都用 `_secure_write()`（`pairing.py:50`）写入：先写临时文件、`fsync`、原子 rename、再 `chmod 0600`。`PairingStore` 用一个 `threading.RLock`（`pairing.py:90`）保护所有读-改-写循环——因为网关在多个线程里并发跑多个平台适配器，它们共享同一个 `PairingStore`。配对码本身**从不打印到 stdout**（`pairing.py:16`），避免泄漏进日志。

---

## 13.7 消息投递路由：DeliveryTarget

agent 产出一段回复，要送到哪里去？大多数时候是"送回消息来的地方"，但 cron 作业（[第 14 章](14-cron-delegate-batch.md)）的输出可能要送到一个完全不同的频道。`gateway/delivery.py` 用一套字符串路由语法统一处理。

`DeliveryTarget` 定义在 `gateway/delivery.py:28`，表示一个投递目的地。它的精髓在 `parse()` 类方法（`delivery.py:46`）——把一个字符串解析成结构化目标：

```python
# gateway/delivery.py 路由语法
"origin"                      # 送回消息来源（agent 回复的默认行为）
"local"                       # 只存本地文件，不发任何平台
"telegram"                    # 送到 Telegram 的 home channel
"telegram:123456"             # 送到指定的 Telegram 聊天
"telegram:123456:789"         # 送到指定聊天的指定线程/话题
```

解析逻辑（`delivery.py:56-94`）：

```python
@classmethod
def parse(cls, target: str, origin: Optional[SessionSource] = None):
    target_lower = target.strip().lower()
    if target_lower == "origin":
        # 用 origin 的 platform/chat_id/thread_id 填充
        return cls(platform=origin.platform, chat_id=origin.chat_id, ...)
    if target_lower == "local":
        return cls(platform=Platform.LOCAL)
    if ":" in target_stripped:
        # platform:chat_id 或 platform:chat_id:thread_id
        parts = target_stripped.split(":", 2)
        return cls(platform=Platform(parts[0].lower()),
                   chat_id=parts[1], thread_id=parts[2] if len(parts) > 2 else None)
    # 裸平台名 → 用 home channel
    return cls(platform=Platform(target_lower))
```

几个设计细节：

- **平台名大小写不敏感**（`parts[0].lower()`），但 **chat_id / thread_id 保留原大小写**——因为有些平台的 ID 是大小写敏感的。
- **未知平台一律降级为 LOCAL**——遇到无法识别的目标，宁可存本地文件也不丢消息。
- **`origin` 需要 `SessionSource`**——没有 origin 时（比如某些后台路径），同样降级为 LOCAL。

`DeliveryRouter`（`delivery.py:109`）拿着解析好的 `DeliveryTarget` 列表，调用 `deliver()` 逐个投递。投递到平台的 `_deliver_to_platform()`（`delivery.py:226`）里有一道**长度保护**：cron 输出可能很长，超过 `MAX_PLATFORM_OUTPUT`（4000 字符）就把完整输出存盘、消息体截断到 3800 字符并附上文件路径。这避免了"一条几万字的 cron 报告"撑爆平台消息长度上限。

---

## 13.8 网关里的 slash 命令

CLI 里能用 `/new`、`/model`、`/tools` 等斜杠命令。网关也支持这些命令——你在 Telegram 里发 `/new` 同样能开新会话。关键设计是：**网关、CLI、Telegram BotCommand 菜单、Slack 子命令映射，全部从同一个中央注册表派生。**

这个注册表是 `hermes_cli/commands.py` 里的 `COMMAND_REGISTRY`（`commands.py:64`），一个 `CommandDef` 列表：

```python
# hermes_cli/commands.py:45 起
@dataclass(frozen=True)
class CommandDef:
    name: str                             # 规范名（无斜杠），如 "background"
    description: str                      # 人类可读描述
    category: str                         # "Session" / "Configuration" / ...
    aliases: tuple[str, ...] = ()         # 别名，如 ("bg", "btw")
    args_hint: str = ""                   # 参数占位符
    subcommands: tuple[str, ...] = ()     # 可 Tab 补全的子命令
    cli_only: bool = False                # 仅 CLI 可用
    gateway_only: bool = False            # 仅网关可用
    gateway_config_gate: str | None = None  # 配置门控
```

文件头的 docstring（`commands.py:3-8`）把设计意图说得很直白：

> 所有 slash 命令的中央注册表。每个消费者——CLI 帮助、网关分发、Telegram BotCommands、Slack 子命令映射、自动补全——都从 `COMMAND_REGISTRY` 派生数据。新增命令：往 `COMMAND_REGISTRY` 加一个 `CommandDef`。

从这个注册表派生出的下游产物：

- **`GATEWAY_KNOWN_COMMANDS`**（`commands.py:297`）：一个 `frozenset`，列出所有网关可用命令。网关收到斜杠消息时用 `is_gateway_known_command()`（`commands.py:305`）判断"这是命令还是普通文本"。
- **`gateway_help_lines()`**（`commands.py:422`）：生成网关里 `/help` 的输出文本。
- **Telegram BotCommand 菜单**：网关启动时把 `COMMAND_REGISTRY` 里 `gateway` 可见的命令推送给 Telegram，用户就能在输入框看到命令菜单。
- **Slack 子命令映射**：Slack 的 slash 命令是注册式的，网关同样从注册表生成映射。

网关分发命令时（`gateway/run.py:6408` 附近），流程是：取出命令 → `resolve_command()`（`commands.py:237`）把别名解析成规范名 → 按规范名分发。别名解析放在这里，使得后续分发逻辑和 hook 名称都不依赖用户实际输入的是哪个别名。

`cli_only` / `gateway_only` / `gateway_config_gate` 三个字段控制命令在哪个环境可见。比如 `/clear`（清屏）只在 CLI 有意义（`cli_only=True`），`/topic`（Telegram DM 话题）只在网关有意义（`gateway_only=True`）。`gateway_config_gate` 更微妙——某些默认 CLI-only 的命令，当某个配置项为真时也对网关开放。

这套设计的价值是**单一事实来源**：加一个新命令只需改 `COMMAND_REGISTRY` 一处，CLI 帮助、网关分发、Telegram 菜单、Slack 映射、Tab 补全全部自动同步。`gateway/run.py:12280` 附近有一段注释专门提醒：忘了把命令登记进注册表，BotCommand 菜单、Slack 子命令映射等会"静默失效"。

---

## 13.9 网关的工作目录：terminal.cwd

最后一个容易被忽视但很重要的设计点：**网关里的工具用什么目录作为工作目录？**

CLI 里跑 agent，工作目录就是用户启动 CLI 时所在的目录（`os.getcwd()`）——很自然。但网关是一个常驻服务，可能由 systemd 启动，`os.getcwd()` 完全不可控（可能是 `/` 或 systemd 的工作目录）。如果终端工具、文件工具直接用 `os.getcwd()`，agent 的文件操作会落在一个莫名其妙的地方。

Hermes 的解法是：**网关的工作目录由配置显式指定**，走 `config.yaml` 的 `terminal.cwd`。`gateway/run.py:614-622` 是这段桥接逻辑：

```python
# gateway/run.py:614 起
# config.yaml terminal.cwd 是规范来源（由上面的 config bridge 桥接到
# TERMINAL_CWD 环境变量）。未设置或为占位符时，默认家目录。
_configured_cwd = os.environ.get("TERMINAL_CWD", "")
if not _configured_cwd or _configured_cwd in {".", "auto", "cwd"}:
    _fallback = os.getenv("MESSAGING_CWD") or str(Path.home())
    os.environ["TERMINAL_CWD"] = _fallback
```

链路是：`config.yaml` 的 `terminal.cwd` → 配置桥接成 `TERMINAL_CWD` 环境变量 → 终端 / 文件 / 代码执行工具读 `TERMINAL_CWD` 而不是 `os.getcwd()`。当 `terminal.cwd` 未设置或是 `.`/`auto`/`cwd` 这类占位符时，回落到家目录（`MESSAGING_CWD` 是已废弃的兼容别名，`gateway/run.py:601` 处有一段弃用警告）。

这样一来，无论网关被谁、从哪个目录启动，agent 的文件操作都落在一个**可预测、用户指定**的目录里。这是把"常驻服务"和"交互式 CLI"区别对待的一个典型例子——同一个 `AIAgent`，因为运行环境不同，工作目录的确定方式也不同。

---

## 延伸阅读

- [第 2 章 AIAgent 核心](02-aiagent-core.md)——网关为每会话缓存的 `AIAgent` 实例本身。
- [第 7 章 上下文引擎](07-context-engine.md)——为什么每会话缓存 agent 是为了保住 prompt caching。
- [第 14 章 Cron 调度、子 Agent 派发与批量运行](14-cron-delegate-batch.md)——`DeliveryTarget`、`standalone_sender_fn` 在 cron 投递里的作用。
- [第 11 章 插件系统与 MCP](11-plugins-and-mcp.md)——插件如何通过 `PluginContext.register_platform()` 往 `platform_registry` 注册新平台。
