# 第 11 章 技能系统与 Curator

## 11.1 问题:把一次性经验变成可复用的程序性记忆

第 10 章讲的记忆系统解决的是**声明性记忆**——"是什么":环境约定、用户画像。但 agent 在工作中学到的另一类东西是**程序性知识**——"怎么做":如何在这个特定的群里 @某个人、如何对一个 PR 做分流抢救、如何用某个不常见的 CLI 跑出某个结果。

这类知识塞不进 `MEMORY.md`。它有结构(可能要带脚本、模板、参考文档)、有篇幅(几百到几千字的步骤说明)、有触发条件(只在某类任务下才用得上)。如果硬塞进系统提示,会把每个会话的 token 撑爆;如果不留下来,下次遇到同类任务又得从头摸索。

`skill_manager_tool.py` 的 docstring 把这个区分讲得很干脆(`tools/skill_manager_tool.py:10-12`):

> Skills are the agent's procedural memory. ... General memory (MEMORY.md, USER.md) is broad and declarative. Skills are narrow and actionable.

技能系统要解决的就是:**让 agent 把一次成功的经验沉淀成一个可复用的、按需加载的、可被自己后续改进的知识单元。**

一个技能在物理上就是**一个目录**:

```text
~/.hermes/skills/my-skill/
├── SKILL.md          ←  YAML frontmatter + Markdown 指令正文
├── references/       ←  会话级细节、知识库
├── templates/        ←  待复制修改的起始文件
├── scripts/          ←  可静态重跑的脚本
└── assets/           ←  其他资源
```

这个格式兼容 **agentskills.io 标准**——技能可以在不同的 agentskills 兼容工具间共享。`SKILL.md` 的 frontmatter 声明元数据,正文是给模型读的指令。一个真实的样例(`skills/yuanbao/SKILL.md:1-9`):

```yaml
---
name: yuanbao
description: "Yuanbao (元宝) groups: @mention users, query info/members."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [yuanbao, mention, at, group, members]
    related_skills: []
---
```

本章分四部分:技能如何被发现并注入对话(11.2–11.4);agent 如何自己创建和改进技能(11.5);后台 Curator 如何长期维护整个技能库(11.6–11.7);相关配置(11.8)。

---

## 11.2 技能发现与注入

### 11.2.1 三层技能目录

技能从三类目录被发现:

| 目录 | 内容 | 谁维护 |
|---|---|---|
| `skills/`(仓库内) | 内置技能(apple、github、creative、research...) | Hermes 团队 |
| `optional-skills/`(仓库内) | 重型/小众技能,默认不激活 | Hermes 团队 |
| `~/.hermes/skills/`(用户) | 用户创建或 agent 自创的技能 | 用户 / agent |

外加 `skills.external_dirs` 配置的外部目录。`get_external_skills_dirs()`(`agent/skill_utils.py:187`)读这个配置项,展开 `~` 和 `${VAR}`,只返回实际存在的目录;`get_all_skills_dirs()`(`agent/skill_utils.py:273`)把本地目录排第一,外部目录按配置顺序跟在后面。

`optional-skills/` 之所以"默认不激活"是因为它们或重(拉大依赖)或小众(只对特定领域用户有用)。把它们和 `skills/` 分开,默认安装就不会被它们撑大。

### 11.2.2 关键设计:技能作为 user message 注入,不进系统提示

这是技能系统**最重要的架构决定**,理由和第 10 章的"冻结快照"一脉相承——**保住 prompt 前缀缓存**。

如果技能内容注入系统提示:每次用户调用一个不同的 `/skill`,系统提示就变了,前缀缓存全部失效。而技能恰恰是"按需触发"的——这一轮可能用 A 技能,下一轮用 B 技能,系统提示会被反复改写。

所以技能内容**作为 user message 注入**。`reload_skills()` 的 docstring 把这个理由讲得很明确(`agent/skill_commands.py:330-333`):

> This does NOT invalidate the skills system-prompt cache. Skills are called by name via `/skill-name`, `skills_list`, or `skill_view` — they don't need to be in the system prompt for the model to use them. Keeping the prompt cache intact preserves prefix caching across the reload.

系统提示里只放一份**技能名 + 描述的轻量索引**(`name: description` 的列表),让模型知道"有哪些技能可用";技能的**完整内容**只在被实际调用时,以 user message 的形式注入这一轮。这样系统提示永远稳定,前缀缓存永远命中。

<svg viewBox="0 0 780 280" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Skills inject as user message, only a lightweight index lives in the system prompt">
  <defs>
    <marker id="r11ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="30" y="24" width="340" height="110" rx="10" fill="#16a34a" fill-opacity="0.1" stroke="#16a34a"/>
  <text x="200" y="48" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">系统提示（稳定 · 缓存命中）</text>
  <rect x="50" y="62" width="300" height="56" rx="6" fill="#fff" fill-opacity="0.6" stroke="#16a34a" stroke-opacity="0.5"/>
  <text x="200" y="84" font-size="10" fill="#64748b" text-anchor="middle">技能索引（只有名字 + 描述）</text>
  <text x="200" y="104" font-size="10" fill="currentColor" text-anchor="middle">- yuanbao: @mention 用户、查群信息</text>
  <text x="200" y="158" font-size="11" fill="#64748b" text-anchor="middle">某一轮，用户输入 /yuanbao</text>
  <line x1="200" y1="166" x2="200" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar1)"/>
  <rect x="410" y="24" width="340" height="234" rx="10" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="580" y="48" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">注入一条 user message（仅本轮）</text>
  <rect x="430" y="62" width="300" height="36" rx="5" fill="#fff" fill-opacity="0.6" stroke="#7c3aed" stroke-opacity="0.5"/>
  <text x="580" y="84" font-size="10" fill="currentColor" text-anchor="middle">[IMPORTANT: 用户调用了 "yuanbao" 技能…]</text>
  <rect x="430" y="106" width="300" height="60" rx="5" fill="#fed7aa" stroke="#ea580c"/>
  <text x="580" y="132" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">SKILL.md 完整正文</text>
  <text x="580" y="150" font-size="10" fill="#64748b" text-anchor="middle">模板替换 + 内联 shell 展开后</text>
  <rect x="430" y="174" width="300" height="36" rx="5" fill="#fff" fill-opacity="0.6" stroke="#7c3aed" stroke-opacity="0.5"/>
  <text x="580" y="196" font-size="10" fill="currentColor" text-anchor="middle">[Skill directory: …/skills/yuanbao]</text>
  <rect x="430" y="218" width="300" height="28" rx="5" fill="#fff" fill-opacity="0.6" stroke="#7c3aed" stroke-opacity="0.5"/>
  <text x="580" y="236" font-size="10" fill="#64748b" text-anchor="middle">支持文件清单 · config 块 · setup 注记</text>
  <line x1="370" y1="100" x2="408" y2="120" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r11ar1)"/>
</svg>
<span class="figure-caption">图 R11.1 ｜ 技能注入策略：系统提示只放轻量索引保住缓存，完整技能内容在被调用时作为 user message 注入。</span>

<details>
<summary>ASCII 原版</summary>

```text
系统提示(稳定,缓存命中)
  └─ 技能索引: "- yuanbao: @mention 用户、查群信息"  (只有名字+描述)

某一轮,用户输入 /yuanbao
  └─ 注入一条 user message:
       [IMPORTANT: 用户调用了 "yuanbao" 技能...]
       <SKILL.md 完整正文>
       [Skill directory: /Users/.../skills/yuanbao]
       ...
```

</details>

### 11.2.3 `_load_skill_payload()`:按名字/路径加载技能

`_load_skill_payload()`(`agent/skill_commands.py:53`)把一个技能标识符(名字或路径)解析成 `(loaded_payload, skill_dir, display_name)` 三元组:

```python
def _load_skill_payload(skill_identifier, task_id=None):
    raw_identifier = (skill_identifier or "").strip()
    if not raw_identifier:
        return None
    from tools.skills_tool import SKILLS_DIR, skill_view

    identifier_path = Path(raw_identifier).expanduser()
    if identifier_path.is_absolute():
        try:
            normalized = str(identifier_path.resolve().relative_to(SKILLS_DIR.resolve()))
        except Exception:
            normalized = raw_identifier
    else:
        normalized = raw_identifier.lstrip("/")

    loaded_skill = json.loads(skill_view(normalized, task_id=task_id, preprocess=False))
    if not loaded_skill.get("success"):
        return None
    ...
```

它处理绝对路径和相对路径两种形态,底层委派给 `skill_view()` 真正读取技能。注意 `preprocess=False`——预处理(模板替换、内联 shell)在后面 `_build_skill_message()` 里做,这里只取原始内容。返回的 `skill_dir` 优先用 `skill_view()` 给出的绝对路径(对本地和外部技能都正确),仅在缺失时才退回到 `SKILLS_DIR` 相对路径重建(`agent/skill_commands.py:87-94`)。

### 11.2.4 `_build_skill_message()`:把技能格式化成消息

`_build_skill_message()`(`agent/skill_commands.py:138`)是注入逻辑的核心,把一个加载好的技能拼装成最终的消息文本。流程:

```python
def _build_skill_message(loaded_skill, skill_dir, activation_note,
                         user_instruction="", runtime_note="", session_id=None):
    content = str(loaded_skill.get("content") or "")

    # ① 模板替换 + 内联 shell 展开 —— 必须最先做,
    #    这样下游的 setup 注记、支持文件提示看到的都是展开后的内容
    skills_cfg = _load_skills_config()
    if skills_cfg.get("template_vars", True):
        content = _substitute_template_vars(content, skill_dir, session_id)
    if skills_cfg.get("inline_shell", False):
        timeout = int(skills_cfg.get("inline_shell_timeout", 10) or 10)
        content = _expand_inline_shell(content, skill_dir, timeout)

    parts = [activation_note, "", content.strip()]

    # ② 注入技能目录绝对路径,省去一次额外的 skill_view 往返
    if skill_dir:
        parts.append(f"[Skill directory: {skill_dir}]")
        parts.append("Resolve any relative paths ... against that directory ...")

    # ③ 注入技能声明的 config 值
    _inject_skill_config(loaded_skill, parts)
    ...
```

它做的事按顺序:

1. **模板替换 + 内联 shell**(`agent/skill_commands.py:155-160`)——见 11.3。
2. **注入技能目录绝对路径**(`agent/skill_commands.py:164-172`)——让模型能直接用绝对路径引用技能里的脚本,不必再调一次 `skill_view`。
3. **注入技能声明的 config 值**(`_inject_skill_config`,`agent/skill_commands.py:99`)——如果技能 frontmatter 声明了 `metadata.hermes.config`,把它们当前的值(从 `config.yaml` 或默认值)拼成一个 `[Skill config: ...]` 块,这样 agent 不用自己去读 `config.yaml`。
4. **setup 注记**(`agent/skill_commands.py:177-197`)——如果技能需要环境配置但被跳过,加一条说明。
5. **支持文件清单**(`agent/skill_commands.py:199-228`)——扫描技能目录下的 `references/`、`templates/`、`scripts/`、`assets/`,把里面的文件列给模型,并告诉它怎么用 `skill_view` 或绝对路径加载。

`activation_note` 由调用方提供,根据触发方式不同而不同。slash command 触发时(`build_skill_invocation_message`,`agent/skill_commands.py:439-442`):

```python
activation_note = (
    f'[IMPORTANT: The user has invoked the "{skill_name}" skill, indicating they want '
    "you to follow its instructions. The full skill content is loaded below.]"
)
```

CLI 预加载触发时(`build_preloaded_skills_prompt`,`agent/skill_commands.py:486-490`)措辞略有不同,强调"整个会话期间作为活动指引"。

---

## 11.3 技能预处理:模板变量与内联 shell

预处理逻辑集中在 `agent/skill_preprocessing.py`。它让技能正文不是死文本,而能注入运行时上下文。

### 11.3.1 `load_skills_config()`

`load_skills_config()`(`agent/skill_preprocessing.py:23`)读 `config.yaml` 的 `skills` 段,best-effort——任何异常都退回空 dict。三个相关开关:`template_vars`(默认 `True`)、`inline_shell`(默认 `False`)、`inline_shell_timeout`(默认 10 秒)。

### 11.3.2 `substitute_template_vars()`:模板变量

`substitute_template_vars()`(`agent/skill_preprocessing.py:37`)替换技能正文里的 `${...}` 占位符。支持两个 token(`agent/skill_preprocessing.py:13`):

- `${HERMES_SKILL_DIR}` —— 技能目录的绝对路径
- `${HERMES_SESSION_ID}` —— 当前会话 ID

```python
def _replace(match):
    token = match.group(1)
    if token == "HERMES_SKILL_DIR" and skill_dir_str:
        return skill_dir_str
    if token == "HERMES_SESSION_ID" and session_id:
        return str(session_id)
    return match.group(0)   # 无值则原样保留
```

一个细节:**无法解析的 token 原样保留**(`agent/skill_preprocessing.py:42-46`)。比如某个会话没有 session_id,`${HERMES_SESSION_ID}` 不被替换——这样技能作者一眼能看出哪个变量没解析上,便于调试。

### 11.3.3 `run_inline_shell()`:内联 shell 展开

技能正文里可以写 `` !`命令` `` 这样的内联 shell 片段(`agent/skill_preprocessing.py:17` 的正则),`expand_inline_shell()`(`agent/skill_preprocessing.py:93`)把每个片段替换成它的 stdout。例如技能里写 `` 今天是 !`date +%Y-%m-%d` `` ,注入时就变成实际日期。

`run_inline_shell()`(`agent/skill_preprocessing.py:63`)执行单个片段,有三重保护:

```python
def run_inline_shell(command, cwd, timeout):
    try:
        completed = subprocess.run(["bash", "-c", command], cwd=..., capture_output=True,
                                   text=True, timeout=max(1, int(timeout)), check=False)
    except subprocess.TimeoutExpired:
        return f"[inline-shell timeout after {timeout}s: {command}]"
    except FileNotFoundError:
        return "[inline-shell error: bash not found]"
    except Exception as exc:
        return f"[inline-shell error: {exc}]"

    output = (completed.stdout or "").rstrip("\n")
    ...
    if len(output) > _INLINE_SHELL_MAX_OUTPUT:   # 4000 字符
        output = output[:_INLINE_SHELL_MAX_OUTPUT] + "...[truncated]"
    return output
```

三重保护对应三个设计考量:**(a)** 失败返回 `[inline-shell error: ...]` 标记而非抛异常——一个坏片段不能毁掉整条技能消息;**(b)** 有超时——避免卡死;**(c)** 输出截断到 4000 字符(`agent/skill_preprocessing.py:20`)——避免一个失控命令把上下文撑爆。注意内联 shell **默认关闭**(`inline_shell` 默认 `False`),因为它会执行任意命令,是个需要用户主动开启的能力。

### 11.3.4 `parse_frontmatter()`:元数据解析

技能元数据由 `parse_frontmatter()`(`agent/skill_utils.py:52`)解析。它优先用 PyYAML 的 `CSafeLoader` 做完整 YAML 解析(支持嵌套 `metadata`、列表),解析失败时退回到简单的 `key: value` 行切分(`agent/skill_utils.py:79-84`)——容错优先。

`skill_utils.py` 整个模块刻意保持轻量(`agent/skill_utils.py:3-6`):不导入工具注册表、CLI 配置或任何重依赖链,可以在模块级安全 import 而不触发工具注册或 provider 解析。它还从 frontmatter 里抽取若干结构化字段:`skill_matches_platform()`(`agent/skill_utils.py:92`)按 `platforms` 列表判断技能是否兼容当前 OS;`extract_skill_conditions()`(`agent/skill_utils.py:287`)抽取条件激活字段;`extract_skill_config_vars()`(`agent/skill_utils.py:307`)抽取技能声明的 config 变量。

---

## 11.4 slash command 如何从技能派生

每个技能都自动派生出一个 `/slash` 命令。`scan_skill_commands()`(`agent/skill_commands.py:241`)扫描所有技能目录,为每个 `SKILL.md` 构建一个 `/命令名 → 技能信息` 的映射:

```python
# 把技能名归一化成连字符 slug,剥掉非字母数字字符
cmd_name = name.lower().replace(' ', '-').replace('_', '-')
cmd_name = _SKILL_INVALID_CHARS.sub('', cmd_name)
cmd_name = _SKILL_MULTI_HYPHEN.sub('-', cmd_name).strip('-')
_skill_commands[f"/{cmd_name}"] = {
    "name": name, "description": description or f"Invoke the {name} skill",
    "skill_md_path": str(skill_md), "skill_dir": str(skill_md.parent),
}
```

名字归一化(`agent/skill_commands.py:289-291`)很有讲究:剥掉 `+`、`/` 这类字符,因为下游的 Telegram bot 命令名对字符有严格限制。扫描时还会跳过 `.git`/`.github`/`.hub`/`.archive` 目录(`agent/skill_commands.py:264`),并尊重用户配置的禁用技能列表和平台不兼容技能。

`get_skill_commands()`(`agent/skill_commands.py:307`)是对外查询入口。它有一个细节:**当活动平台变化时会重新扫描**(`agent/skill_commands.py:314-318`)。一个网关进程可能同时服务 Telegram 和 Discord,各自有不同的 `skills.platform_disabled` 视图——`_skill_commands_platform` 记下上次扫描的平台,变了就丢弃缓存重扫(issue #14536)。

用户在 CLI 或网关里输入 `/yuanbao`,`build_skill_invocation_message()`(`agent/skill_commands.py:406`)被调用:它查映射、`_load_skill_payload()` 加载、`_build_skill_message()` 格式化,返回一条要注入的 user message。这里还有一行不起眼但关键的代码(`agent/skill_commands.py:433-437`):

```python
from tools.skill_usage import bump_use
bump_use(skill_name)
```

每次技能被调用,使用计数 +1。这个计数喂给后面的 Curator——它需要知道哪些技能在被实际使用。

`reload_skills()`(`agent/skill_commands.py:322`)支持运行时重扫:它对比重扫前后的快照,返回 `added`/`removed`/`unchanged` 的 diff。如 11.2.2 所述,它**不动系统提示缓存**——用户执行 `/reload-skills` 不付任何缓存重置代价。

---

## 11.5 技能自创建与自改进

技能系统真正的"自我改进"含义在这里:agent 不只是**使用**技能,它还能**创建和编辑**技能。这由 `skill_manage` 工具实现,后端是 `tools/skill_manager_tool.py`。

### 11.5.1 `skill_manage` 的六个 action

`skill_manage` 是单工具多 action 设计(`tools/skill_manager_tool.py:14-20`):

| action | 作用 |
|---|---|
| `create` | 创建新技能(SKILL.md + 目录结构),建在 `~/.hermes/skills/` |
| `edit` | 全文重写一个技能的 SKILL.md |
| `patch` | 在 SKILL.md 或任意支持文件里做定点 find-and-replace |
| `delete` | 删除一个用户技能 |
| `write_file` | 新增/覆盖一个支持文件(reference/template/script/asset) |
| `remove_file` | 删除一个支持文件 |

`_create_skill()`(`tools/skill_manager_tool.py:373`)是创建流程:校验名字 → 校验 category → 校验 frontmatter → 校验内容大小 → 检查跨目录名字冲突 → 建目录 → 原子写 SKILL.md → **安全扫描**。

注意创建后立刻安全扫描,失败则回滚(`tools/skill_manager_tool.py:410-413`):

```python
scan_error = _security_scan_skill(skill_dir)
if scan_error:
    shutil.rmtree(skill_dir, ignore_errors=True)
    return {"success": False, "error": scan_error}
```

`_edit_skill()`(`tools/skill_manager_tool.py:431`)同理——它先备份原内容,扫描失败就用原内容回写回滚(`tools/skill_manager_tool.py:457-460`)。

### 11.5.2 `skills_guard.py`:安全检查

新建/编辑技能为什么要扫描?因为技能正文是注入对话、技能脚本是可执行的——技能是攻击面。`tools/skills_guard.py` 提供静态安全扫描。

`scan_skill()`(`tools/skills_guard.py:599`)扫描一个技能目录,返回一个 `ScanResult`(`tools/skills_guard.py:72`),含 `verdict` 字段——三档之一:`"safe"` / `"caution"` / `"dangerous"`。

判定是否放行不仅看 verdict,还看**来源的信任级别**(`tools/skills_guard.py:9-13`):

- `trusted` —— 只有 `openai/skills` 和 `anthropics/skills` 两个官方源,`caution` 级别也放行。
- 其他社区源 —— 信任级别更低,门槛更高。

`should_allow_install()`(`tools/skills_guard.py:646`)综合 verdict 和信任级别给出"放行/需确认/拦截"的决定。

对 **agent 自己创建的技能**,安全扫描默认是**关闭**的——`_guard_agent_created_enabled()`(`tools/skill_manager_tool.py:59`)读 `skills.guard_agent_created` 配置,默认 `False`。`_security_scan_skill()`(`tools/skill_manager_tool.py:78`)在这个开关关闭时直接 no-op。理由:agent 创建的技能来自 agent 自己,不是外来代码;但对偏执的用户,可以用 `hermes config set skills.guard_agent_created true` 开启。开启后,agent 创建的技能若扫出"dangerous"级别会被拦截(`tools/skill_manager_tool.py:94-98`)。

### 11.5.3 `skill_provenance.py`:来源追踪

这是连接"技能自创建"和"Curator"的关键机制。问题是:Curator 会自动归并、归档技能——但它**只应该动 agent 自己创建的技能,绝不能动用户让前台 agent 写的技能**。怎么区分这两种?

`tools/skill_provenance.py` 的 docstring 把这件事讲得很清楚(`tools/skill_provenance.py:3-7`):

> The curator only consolidates/prunes skills it autonomously created via the background self-improvement review fork. Skills a user asks a foreground agent to write belong to the user and must never be auto-curated.

机制是一个 **ContextVar**——`_write_origin`(`tools/skill_provenance.py:38`),默认值 `"foreground"`。`run_agent.py` 在每次工具循环前设置它;工具处理器(比如 `skill_manage create`)可以查它,判断自己是不是在后台审查 fork 里执行:

```python
token = set_current_write_origin("background_review")
try:
    ...  # 工具在这里运行
finally:
    reset_current_write_origin(token)

# 工具内部:
if get_current_write_origin() == "background_review":
    mark_agent_created(skill_name)
```

`is_background_review()`(`tools/skill_provenance.py:75`)是便捷判断。只有在 `background_review` 来源下创建的技能才被 `mark_agent_created()` 标记为"agent 创建"——也只有这些技能进入 Curator 的管辖范围。用 ContextVar 而非显式传参的好处:它沿调用栈自动传播,工具处理器不需要在签名里多接一个参数。

### 11.5.4 技能使用追踪:`skill_usage.py`

`tools/skill_usage.py` 维护一个使用记录文件,记录每个 agent 创建技能的状态和活动。它定义了三个生命周期状态(`tools/skill_usage.py:52-55`):

```python
STATE_ACTIVE = "active"
STATE_STALE = "stale"
STATE_ARCHIVED = "archived"
```

以及一组计数器更新函数:`bump_view()`(被 `skill_view` 查看)、`bump_use()`(被实际调用,见 11.4)、`bump_patch()`(被 patch)、`mark_agent_created()`(标记为 agent 创建)。`set_state()`(`tools/skill_usage.py:441`)转移状态,转到 `archived` 时记 `archived_at` 时间戳。`is_agent_created()`(`tools/skill_usage.py:287`)是 Curator 反复用到的守卫——`agent_created_report()`(`tools/skill_usage.py:592`)产出 Curator 要审查的候选清单。

`archive_skill()`(`tools/skill_usage.py:479`)把技能目录移到 `~/.hermes/skills/.archive/`,并且**自己再 double-check 一次** `is_agent_created()`(`tools/skill_usage.py:485-486`)——即便调用方理应已经检查过,这里再设一道安全网,确保内置技能和 hub 安装的技能永远不被归档。

---

## 11.6 后台 Curator

`agent/curator.py`(1781 行)是技能系统的长期维护者。它的角色 docstring 写得很清楚(`agent/curator.py:1-8`):

> The curator is an auxiliary-model task that periodically reviews agent-created skills and maintains the collection. It runs inactivity-triggered (no cron daemon): when the agent is idle and the last curator run was longer than `interval_hours` ago, `maybe_run_curator()` spawns a forked AIAgent to do the review.

### 11.6.1 为什么需要 Curator

agent 自创建技能久了会出问题。Curator 的审查提示词把这个失败模式说得很直白(`agent/curator.py:332-340`):

> A collection of hundreds of narrow skills where each one captures one session's specific bug is a FAILURE of the library — not a feature.

每次会话碰到一个具体问题,agent 就可能创建一个针对那个具体问题的窄技能。半年后技能库里堆了几百个一次性的微技能。agent 检索技能是按**描述**匹配的——一个有清晰子章节的宽"伞形"技能,比五个窄的同胞技能更容易被检索到。所以技能库的健康形态是"类级指令的库",不是"一会话一技能"的垃圾堆。

Curator 做两件事:

1. **自动状态转移**(纯函数,无 LLM)——基于活动时间戳把技能在 active/stale/archived 之间移动。
2. **LLM 审查**——派生一个后台 agent,跑"伞形化归并"的审查提示词。

### 11.6.2 四条铁律(strict invariants)

`agent/curator.py:14-19` 列出 Curator 的不变式,理解 Curator 必须先理解这四条:

1. **只动 agent 创建的技能**。候选清单本身就由 `is_agent_created` 过滤过。内置技能、hub 安装的技能 Curator 一概不碰。
2. **永不自动删除,只归档**。归档(把技能目录移进 `.archive/`)是最大破坏性动作。归档可恢复,删除不可恢复。
3. **pinned 技能跳过所有自动转移**。用户可以 `hermes curator pin <skill>` 把一个技能钉住,Curator 完全不动它。
4. **用辅助客户端,绝不污染主会话的 prompt 缓存**。Curator 的 LLM 审查跑在一个独立的 forked agent 上,用辅助模型槽位的凭证。

### 11.6.3 `.curator_state`:持久化调度状态

Curator 没有 cron 守护进程,它靠"不活动触发"。要做到这点,它需要持久化"上次什么时候跑过"。`.curator_state` 文件(`agent/curator.py:66`,位于 `~/.hermes/skills/.curator_state`)就是这个状态:

```python
def _default_state():
    return {
        "last_run_at": None,
        "last_run_duration_seconds": None,
        "last_run_summary": None,
        "last_run_summary_shown_at": None,
        "last_report_path": None,
        "paused": False,
        "run_count": 0,
    }
```

`load_state()` / `save_state()`(`agent/curator.py:82` / `:97`)读写它。`save_state()` 用临时文件 + `os.fsync` + `os.replace` 原子写——和记忆文件、技能文件一样的原子写模式。

### 11.6.4 `should_run_now()`:何时该跑

`should_run_now()`(`agent/curator.py:199`)决定 Curator 是否该立即运行。它检查三道静态门:

```python
def should_run_now(now=None):
    if not is_enabled():       # curator.enabled
        return False
    if is_paused():            # 用户 hermes curator pause
        return False

    state = load_state()
    last = _parse_iso(state.get("last_run_at"))
    if last is None:
        # 从没跑过 —— 不立即跑,而是"播种" last_run_at = now,
        # 推迟首次真正运行一整个 interval
        ...
        return False

    interval = timedelta(hours=get_interval_hours())
    return (now - last) >= interval
```

**首次运行行为**值得专门说(`agent/curator.py:206-214`)。当 `last_run_at` 为空(全新安装,或老安装刚升级到带 Curator 的版本),Curator **不立即跑**。它把 `last_run_at` 播种为"现在",把首次真正运行推迟一整个 interval(默认 7 天)。理由:Curator 设计成在至少积累了 `interval_hours` 的技能活动之后才跑,而不是在 `hermes update` 后的第一个后台 tick 上就跑。想立刻跑的用户可以显式 `hermes curator run`(可带 `--dry-run`),那条路径绕过这道门。

注意 `should_run_now()` 只管**静态门**——`min_idle_hours` 的空闲检查在调用点做(那里才知道有没有 agent 正在活动)。`maybe_run_curator()`(`agent/curator.py:1763`)是会话启动钩子的对外入口,它先调 `should_run_now()`,再额外检查 `idle_for_seconds`:

```python
def maybe_run_curator(*, idle_for_seconds=None, on_summary=None):
    try:
        if not should_run_now():
            return None
        if idle_for_seconds is not None:
            min_idle_s = get_min_idle_hours() * 3600.0
            if idle_for_seconds < min_idle_s:
                return None
        return run_curator_review(on_summary=on_summary)
    except Exception as e:
        logger.debug("maybe_run_curator failed: %s", e, exc_info=True)
```

整个函数包在 `try/except` 里——Curator 是 best-effort,它**永远不抛异常**,绝不能因为自身故障拖垮 agent 启动。

### 11.6.5 `apply_automatic_transitions()`:基于时间戳的纯转移

`apply_automatic_transitions()`(`agent/curator.py:256`)是 Curator 的第一阶段:**纯函数,不调 LLM**。它遍历每个 agent 创建的技能,根据"最近真实活动时间戳"把它在状态间移动:

```python
def apply_automatic_transitions(now=None):
    stale_cutoff = now - timedelta(days=get_stale_after_days())     # 默认 30 天
    archive_cutoff = now - timedelta(days=get_archive_after_days()) # 默认 90 天
    counts = {"marked_stale": 0, "archived": 0, "reactivated": 0, "checked": 0}

    for row in _u.agent_created_report():
        counts["checked"] += 1
        name = row["name"]
        if row.get("pinned"):
            continue                            # 铁律 3:pinned 跳过

        last_activity = _parse_iso(row.get("last_activity_at"))
        # 从没活动过 —— 用 created_at 作锚点,新技能不会立刻归档自己
        anchor = last_activity or _parse_iso(row.get("created_at")) or now
        current = row.get("state", _u.STATE_ACTIVE)

        if anchor <= archive_cutoff and current != _u.STATE_ARCHIVED:
            ok, _msg = _u.archive_skill(name)
            if ok:
                counts["archived"] += 1
        elif anchor <= stale_cutoff and current == _u.STATE_ACTIVE:
            _u.set_state(name, _u.STATE_STALE)
            counts["marked_stale"] += 1
        elif anchor > stale_cutoff and current == _u.STATE_STALE:
            # 标记为 stale 之后又被用了 —— 重新激活
            _u.set_state(name, _u.STATE_ACTIVE)
            counts["reactivated"] += 1

    return counts
```

转移规则:

<svg viewBox="0 0 760 220" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Skill state machine: active, stale, archived transitions">
  <defs>
    <marker id="r11ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="80" width="150" height="60" rx="10" fill="#16a34a" fill-opacity="0.12" stroke="#16a34a" stroke-width="1.5"/>
  <text x="135" y="116" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">ACTIVE</text>
  <rect x="305" y="80" width="150" height="60" rx="10" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="116" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">STALE</text>
  <rect x="550" y="80" width="150" height="60" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
  <text x="625" y="116" font-size="13" font-weight="700" fill="currentColor" text-anchor="middle">ARCHIVED</text>
  <line x1="210" y1="100" x2="303" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar2)"/>
  <text x="256" y="92" font-size="10" fill="#64748b" text-anchor="middle">30 天未活动</text>
  <line x1="455" y1="100" x2="548" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar2)"/>
  <text x="501" y="92" font-size="10" fill="#64748b" text-anchor="middle">90 天未活动</text>
  <path d="M305,128 C256,158 188,158 142,142" fill="none" stroke="#16a34a" stroke-width="1.2" marker-end="url(#r11ar2)"/>
  <text x="222" y="172" font-size="10" fill="#16a34a" text-anchor="middle">又被使用了 → reactivate</text>
  <text x="380" y="44" font-size="11" fill="#94a3b8" text-anchor="middle">纯函数转移 · 不调 LLM · pinned 技能跳过 · 归档可恢复</text>
</svg>
<span class="figure-caption">图 R11.2 ｜ 技能状态机：基于活动时间戳在 active/stale/archived 间转移；被重新使用的 stale 技能会拉回 active。</span>

<details>
<summary>ASCII 原版</summary>

```text
            ─── 30 天未活动 ───▶
   ACTIVE ───────────────────▶ STALE ────── 90 天未活动 ──▶ ARCHIVED
      ▲                          │
      └──── 又被使用了 ───────────┘
            (reactivate)
```

</details>

几个细节:**(a)** pinned 技能 `continue` 跳过(铁律 3)。**(b)** 从没活动过的技能用 `created_at` 当锚点(`agent/curator.py:277-278`)——否则一个刚建好的技能会因为 `last_activity_at` 为空而立刻归档自己。**(c)** stale → active 的**重新激活**:一个被标 stale 的技能又被用了,说明它还有价值,拉回 active。**(d)** archive 走 `archive_skill()`,它自己还会 double-check `is_agent_created`(11.5.4)。

这个阶段是纯的、确定的、不花钱的——它先跑,处理"按时间该转移的"。真正需要判断的事(哪些技能该归并)留给下一阶段的 LLM。

### 11.6.6 `run_curator_review()`:启动后台审查

`run_curator_review()`(`agent/curator.py:1369`)编排一次完整审查:

<svg viewBox="0 0 780 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="run_curator_review orchestration with dry-run and sync/async branches">
  <defs>
    <marker id="r11ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="290" y="14" width="200" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="35" font-size="12" font-weight="700" fill="currentColor" text-anchor="middle">run_curator_review()</text>
  <line x1="390" y1="46" x2="390" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <rect x="320" y="60" width="140" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="390" y="80" font-size="11" fill="currentColor" text-anchor="middle">dry_run ?</text>
  <line x1="320" y1="75" x2="210" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <text x="240" y="92" font-size="10" fill="#64748b">是</text>
  <line x1="460" y1="75" x2="570" y2="100" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <text x="528" y="92" font-size="10" fill="#64748b">否</text>
  <rect x="40" y="102" width="280" height="40" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="180" y="126" font-size="10" fill="currentColor" text-anchor="middle">只统计候选数，不做转移</text>
  <rect x="420" y="102" width="320" height="64" rx="6" fill="#0d9488" fill-opacity="0.12" stroke="#0d9488"/>
  <text x="580" y="124" font-size="10" fill="currentColor" text-anchor="middle">① curator_backup.snapshot_skills()  快照</text>
  <text x="580" y="146" font-size="10" fill="currentColor" text-anchor="middle">② apply_automatic_transitions()  自动转移</text>
  <text x="580" y="160" font-size="9" fill="#94a3b8" text-anchor="middle">纯函数 · 无 LLM</text>
  <line x1="580" y1="166" x2="580" y2="180" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <rect x="220" y="182" width="500" height="36" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="470" y="204" font-size="10" fill="currentColor" text-anchor="middle">LLM 阶段前先持久化 state（崩溃也不会立刻重触发）</text>
  <line x1="470" y1="218" x2="470" y2="232" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <rect x="320" y="234" width="300" height="30" rx="5" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="470" y="254" font-size="11" fill="currentColor" text-anchor="middle">_llm_pass()  ── synchronous ?</text>
  <line x1="370" y1="264" x2="280" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <text x="305" y="278" font-size="10" fill="#64748b">是</text>
  <line x1="560" y1="264" x2="640" y2="284" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar3)"/>
  <text x="616" y="278" font-size="10" fill="#64748b">否</text>
  <rect x="120" y="286" width="180" height="30" rx="5" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="210" y="306" font-size="10" fill="currentColor" text-anchor="middle">当前线程跑</text>
  <rect x="500" y="286" width="220" height="30" rx="5" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="610" y="306" font-size="10" fill="currentColor" text-anchor="middle">daemon 线程跑（默认）</text>
</svg>
<span class="figure-caption">图 R11.3 ｜ run_curator_review() 编排：dry-run 只统计；正式运行先快照与自动转移，持久化 state 后再跑 LLM 审查。</span>

<details>
<summary>ASCII 原版</summary>

```text
run_curator_review()
  │
  ├─ dry_run?  ── 是 ──▶ 只统计候选数,不做转移
  │              否 ──▶ ① curator_backup.snapshot_skills()  快照
  │                     ② apply_automatic_transitions()      自动转移
  │
  ├─ 在 LLM 阶段前先持久化 state(崩溃也不会立刻重触发)
  │
  └─ _llm_pass()  ── synchronous? ── 是 ──▶ 当前线程跑
                                     否 ──▶ daemon 线程跑(默认)
```

</details>

`_llm_pass()` 内部:先快照 LLM 前的技能状态(用于 diff),拼出审查提示词(`CURATOR_REVIEW_PROMPT` + 候选清单,dry-run 时额外加 `CURATOR_DRY_RUN_BANNER`),调 `_run_llm_review()`,然后构建"重命名映射"(`old-name → umbrella`)追加进摘要(`agent/curator.py:1496-1506`)——让用户不用翻 `REPORT.md` 就知道技能被归并到哪去了。最后写 per-run 报告并更新 state。

注意 `dry_run` 的处理(`agent/curator.py:1438-1442`):dry-run **不 bump `last_run_at` 和 `run_count`**——一次预览不该把下一次计划中的真正运行推后。但仍记一条摘要,这样 `hermes curator status` 能显示"有过一次预览"。

### 11.6.7 `_run_llm_review()`:派生审查 agent

`_run_llm_review()`(`agent/curator.py:1622`)是 LLM 审查的实际执行。它派生一个 `AIAgent` fork 跑审查提示词:

```python
review_agent = AIAgent(
    model=_model_name,
    provider=_resolved_provider,
    api_key=_api_key, base_url=_base_url, api_mode=_api_mode,
    max_iterations=9999,        # 伞形化一个大技能库值得高迭代上限
    quiet_mode=True,
    platform="curator",
    skip_context_files=True,
    skip_memory=True,
)
# 关键:禁掉递归 nudge —— curator 绝不能派生自己的审查
review_agent._memory_nudge_interval = 0
review_agent._skill_nudge_interval = 0
```

几个关键参数:

- **`max_iterations=9999`**(`agent/curator.py:1702`)——审查上百个候选技能、做伞形归并,典型要 50–100 次 API 调用,需要很高的迭代上限。普通的单会话审查路径会用小得多的上限,因为它不做整库扫描。
- **`skip_memory=True`、`platform="curator"`**——审查 fork 不该有记忆会话(回顾第 10 章:cron/curator 这类上下文不写记忆,免得污染用户表征)。
- **`_memory_nudge_interval = 0`、`_skill_nudge_interval = 0`**(`agent/curator.py:1709-1710`)——把 nudge 全关掉。**curator 绝不能在审查中触发自己的审查**——否则就递归了。

模型选择走辅助任务槽位。`_resolve_review_runtime()`(`agent/curator.py:1557`)按优先级解析 provider/model:`auxiliary.curator.{provider,model}`(规范的辅助任务槽位)→ 旧的 `curator.auxiliary.{provider,model}`(已弃用)→ 主对话模型。这呼应铁律 4——Curator 用辅助客户端,有独立的凭证链,**不碰主会话的 prompt 缓存**。

审查 fork 的 stdout/stderr 在运行期间被重定向到 `/dev/null`(`agent/curator.py:1717-1719`),免得它的工具调用噪音污染前台终端。`_run_llm_review()` 也**永不抛异常**——失败时返回一个结构化的失败字典(`agent/curator.py:1633`)。

### 11.6.8 dry-run 与 LLM 审查提示词

`CURATOR_REVIEW_PROMPT`(`agent/curator.py:330`)是给审查 fork 的提示词,它把审查框定为"伞形化归并 pass",不是被动审计也不是查重器。它给审查 agent 三种归并手法(`agent/curator.py:371-393`):

- **a. 归并进现有伞形技能** —— 簇里某个技能已经够宽,patch 它加子章节,归档同胞。
- **b. 创建新伞形 SKILL.md** —— 没有现成的够宽,用 `skill_manage create` 写一个新的类级技能,归档被吸收的窄同胞。
- **c. 降级为 references/templates/scripts** —— 同胞里的窄但有价值的会话级内容,移进伞形技能的对应支持目录。

`CURATOR_DRY_RUN_BANNER`(`agent/curator.py:303`)是 dry-run 模式额外加在提示词前面的横幅,它明确禁止审查 agent 调用任何变更性动作(`skill_manage` 的 patch/create/delete/write_file,`terminal` 的 mv/cp/rm),只允许 `skills_list` 和 `skill_view`。dry-run 的产出**就是那份报告**——描述"会做什么",而不是真的做。下游 reviewer 读报告后决定要不要批准一次真正的 `hermes curator run`。

---

## 11.7 Curator 数据流全景

<svg viewBox="0 0 780 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Curator end-to-end data flow from trigger to report">
  <defs>
    <marker id="r11ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="240" y="14" width="300" height="32" rx="6" fill="#f1f5f9" stroke="#cbd5e1"/>
  <text x="390" y="35" font-size="11" fill="currentColor" text-anchor="middle">会话启动钩子 / hermes curator run</text>
  <line x1="390" y1="46" x2="390" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="250" y="60" width="280" height="44" rx="6" fill="#fed7aa" stroke="#ea580c"/>
  <text x="390" y="80" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">maybe_run_curator()</text>
  <text x="390" y="96" font-size="10" fill="#64748b" text-anchor="middle">should_run_now() + idle 检查</text>
  <line x1="390" y1="104" x2="390" y2="118" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="250" y="118" width="280" height="32" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="390" y="139" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">run_curator_review()</text>
  <line x1="390" y1="150" x2="390" y2="164" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="130" y="164" width="520" height="76" rx="8" fill="#0d9488" fill-opacity="0.12" stroke="#0d9488"/>
  <text x="150" y="184" font-size="11" font-weight="700" fill="currentColor">非 dry-run（廉价、确定先做）</text>
  <text x="150" y="204" font-size="10" fill="#64748b">curator_backup.snapshot_skills()  ← 变更前快照，可回滚</text>
  <text x="150" y="222" font-size="10" fill="#64748b">apply_automatic_transitions()  ← 纯函数，无 LLM</text>
  <text x="150" y="236" font-size="10" fill="#94a3b8">active ─30d→ stale ─90d→ archived</text>
  <line x1="390" y1="240" x2="390" y2="254" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="250" y="254" width="280" height="32" rx="6" fill="#0ea5e9" fill-opacity="0.12" stroke="#0ea5e9"/>
  <text x="390" y="275" font-size="11" fill="currentColor" text-anchor="middle">_llm_pass()  （daemon 线程）</text>
  <line x1="390" y1="286" x2="390" y2="300" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="190" y="300" width="400" height="50" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="390" y="320" font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">_run_llm_review()</text>
  <text x="390" y="338" font-size="10" fill="#64748b" text-anchor="middle">派生 AIAgent fork（辅助模型, skip_memory, nudge 全关）</text>
  <line x1="390" y1="350" x2="390" y2="364" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="110" y="364" width="560" height="92" rx="8" fill="#ddd6fe" stroke="#7c3aed"/>
  <text x="130" y="386" font-size="11" font-weight="700" fill="currentColor">审查 agent 用 skill_manage 做伞形归并</text>
  <text x="130" y="408" font-size="10" fill="#64748b">a. patch 现有伞形技能加子章节</text>
  <text x="130" y="426" font-size="10" fill="#64748b">b. create 新伞形 SKILL.md</text>
  <text x="130" y="444" font-size="10" fill="#64748b">c. 降级窄同胞为 references / templates / scripts</text>
  <line x1="390" y1="456" x2="390" y2="470" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r11ar4)"/>
  <rect x="170" y="470" width="440" height="44" rx="8" fill="#16a34a" fill-opacity="0.1" stroke="#16a34a"/>
  <text x="390" y="490" font-size="11" font-weight="600" fill="currentColor" text-anchor="middle">写 REPORT.md + 更新 .curator_state</text>
  <text x="390" y="506" font-size="10" fill="#64748b" text-anchor="middle">last_run_at / summary / 重命名映射</text>
</svg>
<span class="figure-caption">图 R11.4 ｜ Curator 数据流全景：触发 → 快照与确定性自动转移 → 后台 fork 跑 LLM 伞形归并 → 写报告与状态。</span>

<details>
<summary>ASCII 原版</summary>

```text
会话启动钩子 / hermes curator run
        │
        ▼
  maybe_run_curator()
        │  should_run_now() + idle 检查
        ▼
  run_curator_review()
        │
   ┌────┴─────────────────────────────────┐
   │  非 dry-run:                          │
   │   curator_backup.snapshot_skills()    │  ← 变更前快照,可回滚
   │   apply_automatic_transitions()       │  ← 纯函数,无 LLM
   │     active ─30d─▶ stale ─90d─▶ archived│
   └────┬─────────────────────────────────┘
        ▼
  _llm_pass()  (daemon 线程)
        │
        ▼
  _run_llm_review()
        │  派生 AIAgent fork(辅助模型, skip_memory, nudge 全关)
        │  跑 CURATOR_REVIEW_PROMPT
        ▼
  审查 agent 用 skill_manage 做伞形归并
   ├─ patch 现有伞形技能加子章节
   ├─ create 新伞形 SKILL.md
   └─ 降级窄同胞为 references/templates/scripts
        │
        ▼
  写 REPORT.md + 更新 .curator_state(last_run_at / summary / 重命名映射)
```

</details>

整个流程体现的设计哲学:**廉价的、确定的先做(自动转移),昂贵的、需判断的隔离开做(LLM 审查跑在独立 fork);任何环节都不能影响主会话(独立凭证、独立线程、永不抛异常);任何破坏性动作都可逆(只归档不删除、变更前快照)。**

---

## 11.8 配置

Curator 的行为由 `config.yaml` 的 `curator` 段控制。`agent/curator.py` 顶部定义了默认值(`agent/curator.py:56-59`):

```python
DEFAULT_INTERVAL_HOURS = 24 * 7   # 7 天
DEFAULT_MIN_IDLE_HOURS = 2
DEFAULT_STALE_AFTER_DAYS = 30
DEFAULT_ARCHIVE_AFTER_DAYS = 90
```

对应的配置键:

| 配置键 | 默认 | 含义 | 读取函数 |
|---|---|---|---|
| `curator.enabled` | `true` | 是否启用 Curator(无配置时默认开) | `is_enabled()` `:148` |
| `curator.interval_hours` | 168 | 两次审查的最小间隔 | `get_interval_hours()` `:154` |
| `curator.min_idle_hours` | 2 | agent 空闲多久才允许跑 | `get_min_idle_hours()` `:162` |
| `curator.stale_after_days` | 30 | 多少天无活动标记为 stale | `get_stale_after_days()` `:170` |
| `curator.archive_after_days` | 90 | 多少天无活动归档 | `get_archive_after_days()` `:178` |
| `curator.backup` | — | 变更前快照相关配置 | `agent/curator_backup.py` |

每个读取函数都对配置缺失/类型错误做了容错——读不到就退回 `DEFAULT_*` 常量。`is_enabled()` 的默认是 `True`(`agent/curator.py:149-151`):"无配置说不就默认开"。

技能侧还有几个相关配置(`skills` 段):`skills.template_vars`、`skills.inline_shell`、`skills.inline_shell_timeout`(11.3)、`skills.external_dirs`(11.2.1)、`skills.disabled` / `skills.platform_disabled`(11.4 的禁用过滤)、`skills.guard_agent_created`(11.5.2 的安全扫描开关)。

命令行侧由 `hermes_cli/curator.py` 提供:`hermes curator status`、`run`(可带 `--dry-run`)、`pause` / `resume`、`pin` / `unpin`、`prune --days N`。注意 `pin`/`unpin` 只能用在 agent 创建的技能上——内置和 hub 安装的技能本来就不归 Curator 管,试图 pin 它们会被拒绝(`hermes_cli/curator.py:238`)。

---

## 延伸阅读

- [第 10 章 记忆系统与学习闭环](./10-memory-system.md) —— 声明性记忆与技能这一程序性记忆的分工,以及学习闭环全景
- [第 12 章 MCP 集成与插件系统](./12-mcp-and-plugins.md) —— 插件如何提供技能、`PluginManager` 的技能注册表
