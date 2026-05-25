## v1 到 v2 迁移

NanoClaw v2 不是 v1 的演进——它是一次 ground-up rewrite。从 entity model 到 DB layout 到 host/container 进程划分到 channel adapter 的安装方式，每一层都被重新设计。结果：**v2 没法 merge 进 v1 install**。

这章解释三件事：

1. **CLAUDE.md 顶部的 STOP banner 为什么存在**——它不是写给人类看的，是写给 Claude 看的。Claude 实例在 v1 install 里跑、用户让它 `git pull`、它看到 merge conflict 会本能想"修一修"。Banner 要它立刻 abort。
2. **`migrate-v2.sh` 怎么把 v1 install 翻新成 v2 install**——一个 standalone bash 脚本，调一系列 TypeScript step，最终把 service 切换过去然后把控制权交给 Claude Code 的 `/migrate-from-v1` skill。
3. **首次安装和迁移的关系**——纯新装走 `setup.sh`、迁移走 `migrate-v2.sh`，两条路最终都到达 "v2 service running"。

---

### 1. 设计问题

#### 1.1 v2 改了什么（vocabulary 速查）

完整对照请看 `docs/v1-to-v2-changes.md`。这里给个浓缩对照表：

| 层 | v1 | v2 |
|----|----|-----|
| 入口进程 | 单 Node 进程（host 同时跑 router + agent） | host 进程（Node）+ 每 session 一个容器（Bun） |
| 持久化 | 单 SQLite：`store/messages.db` | 三个：central `data/v2.db` + per-session `inbound.db` + per-session `outbound.db` |
| Group 模型 | 单表 `registered_groups(jid, name, folder, trigger_pattern, requires_trigger, is_main, channel_name)` | `agent_groups` × `messaging_groups`，中间表 `messaging_group_agents`（wirings） |
| 路由触发 | 一个 `trigger_pattern` regex 应用在每条消息上 | `engage_mode ∈ {pattern, mention, mention-sticky}` + 独立 `sender_scope` / `ignored_message_policy` |
| Channel 标识 | `jid` 列存 `dc:12345`/`tg:67890`，prefix → channel | `channel_type` + `platform_id` 显式分两列 |
| 权限 | `is_main=1` 单一标志，约定不强制 | 显式 `users` + `user_roles(role∈{owner,admin}, agent_group_id nullable)` + `agent_group_members` |
| Channel 安装 | edit code、加 dep、设 env | `/add-<channel>` skill：`git fetch channels && git show channels:src/channels/<n>.ts > ... && pnpm install <pkg>@<pin>` |
| Provider 安装 | 同上 | `/add-opencode` 从 providers 分支安装 |
| 凭证 | `.env` 明文环境变量 | OneCLI Agent Vault（本地 daemon，`http://127.0.0.1:10254`），HTTP proxy + CA cert 注入 |
| Scheduled tasks | 专用 `scheduled_tasks` 表 + 独立 scheduler 进程 | `messages_in` 行 `kind='task'` + host sweep 60s |
| Self-modification | 直接改源码、改 deps | MCP tool（`install_packages` / `add_mcp_server`）+ admin approval + 自动 rebuild + 自动 restart |
| Skill 安装位置 | `~/.claude/` 全局 | 项目里 `.claude/skills/` + container 内 `container/skills/` + 长生命 git branch（`channels`/`providers`） |
| Service 名 | `com.nanoclaw` / `nanoclaw` | `nanoclaw-v2-<hash>`（基于 install path 算 slug，多 install 不冲突） |
| Group 目录 | `groups/<f>/CLAUDE.md` 直写 | `groups/<f>/CLAUDE.md` **由 spawn 时合成**（`.claude-shared.md` symlink + `.claude-fragments/*` + `CLAUDE.local.md`），不要手改 |

不能 merge：v1 的 `store/messages.db` schema 在 v2 里完全不存在，文件路径变了（`store/` → `data/`），`registered_groups` 表不存在了；v1 的 `src/channels/*.ts` 是 native 适配器，v2 的 trunk 根本没有这些文件（在 `channels` 分支上）。`git merge upstream/main` 会把所有这些"删除/新增/重命名"当 conflict 抛出来，毫无意义。

<svg viewBox="0 0 880 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="v1 to v2 entity model before-after comparison"><defs><marker id="r14ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="220" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#dc2626">v1 (单体 Node 进程 + 单 SQLite)</text><text x="660" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="#16a34a">v2 (host + per-session container, 三 DB)</text><line x1="440" y1="34" x2="440" y2="400" stroke="#cbd5e1" stroke-dasharray="4,3"/><rect x="40" y="44" width="360" height="64" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="50" y="62" font-size="11" font-weight="700" fill="currentColor">入口进程</text><text x="50" y="80" font-size="10" fill="#64748b">Node: router + agent 同进程</text><text x="50" y="96" font-size="10" fill="#64748b">所有 session 共享 event loop</text><rect x="480" y="44" width="360" height="64" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/><text x="490" y="62" font-size="11" font-weight="700" fill="#0d9488">Host (Node) + Container (Bun) × N</text><text x="490" y="80" font-size="10" fill="#64748b">host 进程做 router/sweep</text><text x="490" y="96" font-size="10" fill="#64748b">每 session 一个隔离 Bun 容器</text><rect x="40" y="118" width="360" height="64" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="50" y="136" font-size="11" font-weight="700" fill="currentColor">持久化</text><text x="50" y="154" font-size="10" fill="#64748b">store/messages.db (single)</text><text x="50" y="170" font-size="10" fill="#64748b">registered_groups 单表</text><rect x="480" y="118" width="360" height="64" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/><text x="490" y="136" font-size="11" font-weight="700" fill="#7c3aed">data/v2.db (central) + per-session 双 DB</text><text x="490" y="154" font-size="10" fill="#64748b">agent_groups × messaging_groups + 中间表</text><text x="490" y="170" font-size="10" fill="#64748b">inbound.db + outbound.db (每 session)</text><rect x="40" y="192" width="360" height="64" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="50" y="210" font-size="11" font-weight="700" fill="currentColor">路由触发</text><text x="50" y="228" font-size="10" fill="#64748b">单 trigger_pattern regex</text><text x="50" y="244" font-size="10" fill="#64748b">requires_trigger 布尔</text><rect x="480" y="192" width="360" height="64" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/><text x="490" y="210" font-size="11" font-weight="700" fill="#0d9488">engage_mode ∈ {pattern, mention, mention-sticky}</text><text x="490" y="228" font-size="10" fill="#64748b">+ sender_scope / ignored_message_policy</text><text x="490" y="244" font-size="10" fill="#64748b">每 wiring 独立配置</text><rect x="40" y="266" width="360" height="64" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="50" y="284" font-size="11" font-weight="700" fill="currentColor">Channel 安装</text><text x="50" y="302" font-size="10" fill="#64748b">edit src/channels/*.ts (trunk)</text><text x="50" y="318" font-size="10" fill="#64748b">手动加 dep + 设 env</text><rect x="480" y="266" width="360" height="64" rx="6" fill="#eff6ff" stroke="#0ea5e9" stroke-width="1.2"/><text x="490" y="284" font-size="11" font-weight="700" fill="#0ea5e9">/add-&lt;channel&gt; skill</text><text x="490" y="302" font-size="10" fill="#64748b">git show channels:src/channels/&lt;n&gt;.ts &gt; ...</text><text x="490" y="318" font-size="10" fill="#64748b">pnpm install &lt;pkg&gt;@&lt;pin&gt; + 自动 rebuild</text><rect x="40" y="340" width="360" height="60" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="50" y="358" font-size="11" font-weight="700" fill="currentColor">凭证</text><text x="50" y="376" font-size="10" fill="#64748b">.env 明文环境变量</text><text x="50" y="392" font-size="10" fill="#dc2626">所有 channel 进程都能读</text><rect x="480" y="340" width="360" height="60" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/><text x="490" y="358" font-size="11" font-weight="700" fill="#7c3aed">OneCLI Agent Vault (本地 daemon)</text><text x="490" y="376" font-size="10" fill="#64748b">http://127.0.0.1:10254 HTTP proxy</text><text x="490" y="392" font-size="10" fill="#64748b">CA cert 注入容器，per-agent secret 隔离</text><line x1="400" y1="76" x2="478" y2="76" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar3)"/><line x1="400" y1="150" x2="478" y2="150" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar3)"/><line x1="400" y1="224" x2="478" y2="224" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar3)"/><line x1="400" y1="298" x2="478" y2="298" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar3)"/><line x1="400" y1="370" x2="478" y2="370" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="3,2" marker-end="url(#r14ar3)"/></svg>
<span class="figure-caption">图 R14.3 ｜ v1 → v2 entity model 关键变化对照：进程模型 / 持久化 / 路由 / channel 安装 / 凭证五条主轴全部断点。每条横向虚线箭头都是一个"无法 merge"的 vocabulary 跳跃——这就是 STOP banner 存在的根本原因。</span>

#### 1.2 Claude 实例会怎么搞砸这件事

想象用户在 v1 install 里跑 Claude Code，说"帮我 update nanoclaw"。Claude 会做什么？

朴素流程：
1. `git fetch upstream`
2. `git merge upstream/main`
3. 看到一堆 conflict
4. **本能尝试 resolve**——读两边的代码、选 "ours" / "theirs"、调和不一致的地方
5. `git commit`、`pnpm install`、`pnpm run build`
6. 大概率出现 type error 或 runtime crash
7. 继续 "fix"
8. 烧 1000 万 token，install 永久坏了，用户的 v1 service 也没法启动

每一步都是合理的局部决策，但整体灾难性。**因为 Claude 不知道这次 `merge upstream/main` 在 vocabulary 上是不可能的**——它看到的只是代码 diff。

#### 1.3 为什么需要一个 standalone 脚本（不能让 Claude 来跑）

`migrate-v2.sh` 不能在 Claude Code 内跑。原因是真实的：
- 有 **交互 prompt**：clack 多选 channel、`switch / skip` 二选、`keep / revert` 二选
- 有 **TUI**：spinner、彩色输出、box-drawing 字符
- 有 **长跑步骤**：`./container/build.sh` 用 docker build，30s-3min
- 有 **service 切换**：`launchctl unload` / `systemctl --user stop`，需要 desktop user session 上下文
- 输出量大、刷新频繁——Claude Code 的 Bash tool 会把这些 collapse 掉，没法看进度

所以 banner 还要明确告诉 Claude "exit 出去再跑，**别**在 Claude Code 里启动 migrate-v2.sh"。

---

### 2. STOP banner：写给 Claude 看的拦截器

`CLAUDE.md:1-13` 是文件开头的整块红字 banner：

```
# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`,
`git fetch && git merge`, or any equivalent to bring in upstream changes
— and you see merge conflicts or a large diff involving this file —
HALT IMMEDIATELY.**

This is NanoClaw v2, a ground-up rewrite with breaking changes throughout.
It cannot be merged into an existing v1 install. Attempting to resolve the
conflicts by hand, run builds, or "fix" anything will corrupt the user's
install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if
   the merge already completed).
2. Tell the user, verbatim: *"This is the v2 rewrite — it can't be merged
   into your existing install. Exit Claude Code (or open a separate
   terminal) and run `bash migrate-v2.sh` from the shell."*
3. Wait for the user to confirm before doing anything else. Do not run the
   migration script yourself — it requires an interactive terminal and
   cannot be run from within Claude Code.

If you are a fresh install (you ran `git clone`, not `git pull`) and there
are no conflicts, ignore this banner and continue below.
```

几个设计精髓：

**精髓 1：trigger condition 写在第一句**。Claude 在 fresh clone 里也会读 CLAUDE.md，这时 banner 不该触发。所以"如果你刚 `git pull` 看到 conflict——HALT"——条件清晰、单一，不歧义。最后一段又写明 "fresh clone 没 conflict 请忽略 banner，继续读下面"。

**精髓 2：明确说 "do this instead"，连命令带 verbatim 消息一起给**。Claude 实例最强的失败 mode 是"知道有问题，但不知道做什么、于是继续做错事"。Banner 写好 `git merge --abort` 命令、写好对用户要说的原话——Claude 直接复读即可，不用自己 reason。

**精髓 3：明确禁止 Claude 跑迁移脚本**。"Do not run the migration script yourself — it requires an interactive terminal and cannot be run from within Claude Code." 否则 Claude 会试图 spawn `bash migrate-v2.sh` 到 Bash tool 里，被 `[ -t 0 ]` 检测挡掉、报错，然后 Claude 试图 "fix" 这个错误……

`migrate-v2.sh:25-33` 就是那个挡板：

```bash
# This script has interactive prompts (channel selection, service switchover)
# and streams progress output — it must run in a real terminal, not inside
# a tool subprocess (e.g. Claude Code's Bash tool, which collapses output).
if ! [ -t 0 ] || ! [ -t 1 ]; then
  echo "This script requires an interactive terminal."
  echo ""
  echo "If you're in Claude Code, exit first or open a separate terminal,"
  echo "then run:"
  echo "  bash migrate-v2.sh"
  echo ""
  exit 1
fi
```

`[ -t 0 ] && [ -t 1 ]` = stdin 和 stdout 都连着 tty。Claude Code 的 Bash tool 是 piped subprocess，两端都不是 tty，所以条件假，脚本立刻退出。

**精髓 4：等用户确认**。"Wait for the user to confirm before doing anything else." Banner 不希望 Claude 自己继续——它的工作是"传递信息给用户"，让用户去跑脚本。

<svg viewBox="0 0 760 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="STOP banner decision tree and shell tty guard"><defs><marker id="r14ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="260" y="14" width="240" height="44" rx="6" fill="#eff6ff" stroke="#0ea5e9" stroke-width="1.2"/><text x="380" y="32" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Claude 启动 → 读 CLAUDE.md</text><text x="380" y="48" text-anchor="middle" font-size="10" fill="#64748b">第一秒看到红字 STOP banner</text><line x1="380" y1="58" x2="380" y2="74" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><polygon points="380,80 510,128 380,176 250,128" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="120" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">触发条件?</text><text x="380" y="138" text-anchor="middle" font-size="10" fill="#64748b">刚 git pull/merge</text><text x="380" y="152" text-anchor="middle" font-size="10" fill="#64748b">且看到 conflict?</text><text x="240" y="128" text-anchor="end" font-size="10" fill="#16a34a" font-weight="600">否 (fresh clone)</text><text x="520" y="128" font-size="10" fill="#dc2626" font-weight="600">是</text><line x1="250" y1="128" x2="160" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><line x1="510" y1="128" x2="600" y2="128" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><rect x="40" y="104" width="120" height="48" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/><text x="100" y="124" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">忽略 banner</text><text x="100" y="140" text-anchor="middle" font-size="10" fill="#64748b">继续读 CLAUDE.md</text><rect x="600" y="92" width="140" height="72" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/><text x="670" y="112" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">HALT</text><text x="670" y="128" text-anchor="middle" font-size="10" fill="#64748b">git merge --abort</text><text x="670" y="142" text-anchor="middle" font-size="10" fill="#64748b">复读 verbatim 给用户</text><text x="670" y="156" text-anchor="middle" font-size="10" fill="#64748b">等用户确认</text><line x1="670" y1="164" x2="670" y2="200" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><polygon points="670,204 760,244 670,284 580,244" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/><text x="670" y="240" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">Claude 想自己</text><text x="670" y="254" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">跑 migrate-v2.sh?</text><text x="580" y="244" text-anchor="end" font-size="10" fill="#16a34a" font-weight="600">否</text><text x="670" y="304" text-anchor="middle" font-size="10" fill="#dc2626" font-weight="600">是 (失败 mode)</text><line x1="670" y1="284" x2="670" y2="320" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><rect x="540" y="324" width="260" height="84" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.5"/><text x="670" y="344" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">第二道挡板 (脚本内)</text><text x="670" y="362" text-anchor="middle" font-size="10" fill="#64748b">migrate-v2.sh:25-33</text><text x="670" y="378" text-anchor="middle" font-size="10" fill="#64748b">[ -t 0 ] && [ -t 1 ] 检测</text><text x="670" y="394" text-anchor="middle" font-size="10" fill="#dc2626">非 tty → exit 1 + 提示用户去 shell 跑</text><line x1="580" y1="244" x2="490" y2="244" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar2)"/><rect x="280" y="216" width="210" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/><text x="385" y="238" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">用户去 shell 手动跑</text><text x="385" y="254" text-anchor="middle" font-size="10" fill="#64748b">bash migrate-v2.sh</text><text x="385" y="268" text-anchor="middle" font-size="10" fill="#64748b">tty 检查通过 → 进 phase 0</text><text x="380" y="396" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">两道挡板的设计：banner 拦住"想 fix conflict"，tty 检查拦住"想自己跑脚本"。</text><text x="380" y="412" text-anchor="middle" font-size="10" font-style="italic" fill="#64748b">Claude 实例在错误情境下能做的最有用的事 = escalate 给人类。</text></svg>
<span class="figure-caption">图 R14.2 ｜ STOP banner 决策树：fresh clone 路径 (绿) 继续；git pull 看到 conflict 路径 (红) HALT。banner 之外还有第二道挡板——脚本里 [ -t 0 ] tty 检测，专门挡住 Claude 想绕过 banner 自己 spawn migrate-v2.sh 的失败 mode。</span>

---

### 3. `migrate-v2.sh` 全景

<svg viewBox="0 0 760 600" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="migrate-v2.sh phase pipeline from bootstrap to handoff"><defs><marker id="r14ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><rect x="180" y="14" width="400" height="60" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/><text x="380" y="34" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">migrate-v2.sh (entry point)</text><text x="380" y="50" text-anchor="middle" font-size="10" fill="#64748b">必须交互 tty · logs/migrate-v2.log · logs/migrate-steps/</text><text x="380" y="64" text-anchor="middle" font-size="10" fill="#dc2626">trap write_handoff EXIT → handoff.json</text><line x1="380" y1="74" x2="380" y2="92" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="96" width="640" height="62" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/><text x="80" y="116" font-size="12" font-weight="700" fill="#0d9488">Phase 0  准备</text><text x="80" y="134" font-size="10" fill="#64748b">0a setup.sh → Node + pnpm + deps</text><text x="290" y="134" font-size="10" fill="#64748b">0b find_v1() 扫 sibling / NANOCLAW_V1_PATH</text><text x="80" y="150" font-size="10" fill="#64748b">0c validate v1 DB (registered_groups 表存在?)</text><line x1="380" y1="158" x2="380" y2="172" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="176" width="640" height="86" rx="6" fill="#faf5ff" stroke="#7c3aed" stroke-width="1.2"/><text x="80" y="196" font-size="12" font-weight="700" fill="#7c3aed">Phase 1  核心 state (run_step 包裹，全 idempotent)</text><text x="80" y="214" font-size="10" fill="#64748b">1a env.ts        merge .env keys</text><text x="350" y="214" font-size="10" fill="#64748b">1b db.ts          ← seed v2.db (agent_groups + messaging_groups + wiring)</text><text x="80" y="230" font-size="10" fill="#64748b">1c groups.ts    拷 groups/ 目录</text><text x="350" y="230" font-size="10" fill="#64748b">1d sessions.ts  拷 session 数据 + continuation</text><text x="80" y="246" font-size="10" fill="#64748b">1e tasks.ts      port scheduled tasks → messages_in kind='task'</text><line x1="380" y1="262" x2="380" y2="276" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="280" width="640" height="66" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="80" y="300" font-size="12" font-weight="700" fill="#ea580c">Phase 2  Channels (interactive)</text><text x="80" y="318" font-size="10" fill="#64748b">2a select-channels.ts  clack multiselect (默认预选 v1 detected)</text><text x="80" y="334" font-size="10" fill="#64748b">2b channel-auth.ts  拷凭证状态     2c install-&lt;ch&gt;.sh × N</text><line x1="380" y1="346" x2="380" y2="360" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="364" width="640" height="80" rx="6" fill="#f0fdfa" stroke="#0d9488" stroke-width="1.2"/><text x="80" y="384" font-size="12" font-weight="700" fill="#0d9488">Phase 3  Infrastructure</text><text x="80" y="402" font-size="10" fill="#64748b">3a Docker (没装就 install-docker.sh)</text><text x="350" y="402" font-size="10" fill="#64748b">3b OneCLI (setup --step onecli)</text><text x="80" y="418" font-size="10" fill="#64748b">3c Anthropic 凭证</text><text x="350" y="418" font-size="10" fill="#64748b">3d 拷 v1 container/skills</text><text x="80" y="434" font-size="10" fill="#64748b">3e container/build.sh ← 构建 agent image (30s-3min)</text><line x1="380" y1="444" x2="380" y2="458" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="462" width="640" height="62" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="80" y="482" font-size="12" font-weight="700" fill="#dc2626">Service switchover (interactive)</text><text x="80" y="500" font-size="10" fill="#64748b">detect v1 running → prompt switch/skip → stop v1 + start v2</text><text x="80" y="516" font-size="10" fill="#64748b">用户测试 → prompt keep/revert → disable_v1_service (保留 unit 文件，可回滚)</text><line x1="380" y1="524" x2="380" y2="538" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#r14ar1)"/><rect x="60" y="542" width="640" height="52" rx="6" fill="#eff6ff" stroke="#0ea5e9" stroke-width="1.2"/><text x="80" y="562" font-size="12" font-weight="700" fill="#0ea5e9">Phase 4  Handoff</text><text x="80" y="580" font-size="10" fill="#64748b">打印 summary → write_handoff() → exec claude "/migrate-from-v1" (替换 bash 进程)</text></svg>
<span class="figure-caption">图 R14.1 ｜ migrate-v2.sh 的 phase 流水线：bootstrap → seed v2 state → 装 channel → 装 infra → 切 service → exec 进 Claude skill。每个 step 通过 run_step 走统一协议，EXIT trap 保证任何路径都写 handoff.json。</span>

<details>
<summary>ASCII 原版</summary>

```
                              ┌──────────────────────────────────┐
                              │ migrate-v2.sh (entry point)     │
                              │ - 必须交互 tty                   │
                              │ - 写 logs/migrate-v2.log         │
                              │ - 每 step → logs/migrate-steps/  │
                              │ - EXIT trap → handoff.json       │
                              └────┬─────────────────────────────┘
                                   │
                                   ▼
              ┌────────────────────────────────────────┐
              │ Phase 0: 准备                            │
              │ 0a. bash setup.sh → 装 Node + pnpm + deps │
              │ 0b. find_v1() → 发现 v1 install path    │
              │ 0c. validate v1 DB (有 registered_groups?) │
              └────┬───────────────────────────────────┘
                   │
                   ▼
              ┌────────────────────────────────────────┐
              │ Phase 1: 核心 state (run_step 包裹)      │
              │ 1a env.ts                              │
              │ 1b db.ts          ← 核心，seed v2.db    │
              │ 1c groups.ts      ← 拷 groups/ 目录    │
              │ 1d sessions.ts    ← 拷 session 数据    │
              │ 1e tasks.ts       ← 拷 scheduled tasks │
              └────┬───────────────────────────────────┘
                   │
                   ▼
              ┌────────────────────────────────────────┐
              │ Phase 2: Channels (interactive)         │
              │ 2a select-channels.ts (clack multiselect)│
              │ 2b channel-auth.ts                       │
              │ 2c install-<ch>.sh × N（每选一个跑一次）│
              └────┬───────────────────────────────────┘
                   │
                   ▼
              ┌────────────────────────────────────────┐
              │ Phase 3: Infrastructure                  │
              │ 3a Docker（找不到就 install-docker.sh）│
              │ 3b OneCLI（找不到就走 setup --step onecli）│
              │ 3c Anthropic 凭证                       │
              │ 3d 拷 v1 container/skills                │
              │ 3e container/build.sh ← 构建 agent image │
              └────┬───────────────────────────────────┘
                   │
                   ▼
              ┌────────────────────────────────────────┐
              │ Service switchover (interactive)         │
              │ - detect v1 service running?            │
              │ - prompt switch / skip                  │
              │ - stop v1，安装并启动 v2 service           │
              │ - prompt keep / revert                  │
              └────┬───────────────────────────────────┘
                   │
                   ▼
              ┌────────────────────────────────────────┐
              │ Phase 4: Handoff                         │
              │ - 打印 summary                           │
              │ - write_handoff() → handoff.json         │
              │ - exec claude "/migrate-from-v1"         │
              │   (用 exec 替换 bash 进程，所以 trap 提前调) │
              └────────────────────────────────────────┘
```

</details>

下面逐 phase 拆。

---

### 4. Phase 0：准备

#### 4.1 Bootstrap（`setup.sh`）

`migrate-v2.sh:147-176` 调 `bash setup.sh > "$BOOTSTRAP_RAW" 2>&1`。`setup.sh` 是 NanoClaw 的"安装 Node + pnpm + 项目依赖"的 bootstrap 脚本——`setup.sh:1-21` 注释说得清楚："this is the only bash script in the setup flow"。

`setup.sh` 干的事：
- detect platform（macOS / Linux / WSL / root）
- check_node：找符合最低版本要求的 Node
- 如果没有 Node，调 `setup/install-node.sh` 装一个
- 装 pnpm
- `pnpm install --frozen-lockfile`
- 输出 status block：`STATUS: success\nNODE_VERSION: ...`

`migrate-v2.sh` parse 这个 status block：

```bash
STATUS=$(grep '^STATUS:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^STATUS: *//')
NODE_VERSION=$(grep '^NODE_VERSION:' "$BOOTSTRAP_RAW" | head -1 | sed 's/^NODE_VERSION: *//')

if [ "$STATUS" = "success" ]; then
  step_ok "Prerequisites ready $(dim "(node $NODE_VERSION)")"
  log "Bootstrap succeeded: node=$NODE_VERSION"
else
  step_fail "Bootstrap reported: $STATUS"
  abort "bootstrap"
fi
```

bootstrap 后立即拼 PATH（`migrate-v2.sh:180-185`），因为 `setup.sh` 装的 pnpm 通常在 `~/.npm-global/bin` 或类似前缀里，可能不在当前 shell PATH 上。

#### 4.2 find v1 install

`migrate-v2.sh:194-225` `find_v1()` 函数有两种模式：

```bash
find_v1() {
  # 1. 显式 override
  if [ -n "${NANOCLAW_V1_PATH:-}" ]; then
    if [ -f "$NANOCLAW_V1_PATH/store/messages.db" ]; then
      echo "$NANOCLAW_V1_PATH"
      return 0
    fi
    step_fail "NANOCLAW_V1_PATH=$NANOCLAW_V1_PATH does not contain store/messages.db"
    return 1
  fi

  # 2. 扫 sibling 目录
  local parent
  parent="$(dirname "$PROJECT_ROOT")"
  for entry in "$parent"/*/; do
    [ -d "$entry" ] || continue
    [ "$(cd "$entry" && pwd)" = "$PROJECT_ROOT" ] && continue   # 跳过自己
    [ -f "$entry/store/messages.db" ] || continue               # 必须有 v1 DB
    # 必须 不是 v2（看 package.json version 不以 2. 开头）
    if [ -f "$entry/package.json" ]; then
      local ver
      ver=$(grep '"version"' "$entry/package.json" 2>/dev/null | head -1 | sed -E 's/.*"([0-9]+)\..*/\1/')
      [ "$ver" = "2" ] && continue
    fi
    echo "$(cd "$entry" && pwd)"
    return 0
  done

  return 1
}
```

判定 v1 的 signature：**有 `store/messages.db` 文件且 `package.json` 里 major version 不是 2**。如果用户的 v1 不在 sibling 位置，必须显式设 `NANOCLAW_V1_PATH=~/path/to/v1`。

#### 4.3 Validate v1 DB

`migrate-v2.sh:241-257` 验证 v1 DB schema：

```bash
V1_DB="$V1_PATH/store/messages.db"

# Quick schema check — make sure the tables we need exist.
# 用 in-tree wrapper 而不是 sqlite3 CLI：setup.sh (phase 0a) 装 Node + better-sqlite3
# 但 NOT sqlite3 CLI，#2191 记录过 "missing CLI 表现为 'registered_groups missing' 误报"
TABLES=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT name FROM sqlite_master WHERE type='table'" 2>/dev/null || true)

if echo "$TABLES" | grep -q "registered_groups"; then
  step_ok "v1 database has registered_groups"
else
  step_fail "v1 database missing registered_groups table"
  abort "v1-db-invalid"
fi
```

注释里那句很重要：**故意不依赖 sqlite3 CLI**，因为 setup 流程不装它（CLAUDE.md 也说了 `setup/verify.ts:5` 不查 sqlite3 binary）。改用 `scripts/q.ts` 直接通过 better-sqlite3（setup 必装的 dep）查询。这样在 fresh install 上跑 migrate 也不会因为 missing CLI 抛误报。

输出粗略 v1 state 概览：

```bash
GROUP_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM registered_groups" ...)
TASK_COUNT=$(pnpm exec tsx scripts/q.ts "$V1_DB" "SELECT COUNT(*) FROM scheduled_tasks WHERE status='active'" ...)
ENV_KEYS=$(grep -c '=' "$V1_PATH/.env" ...)
step_info "v1 state: $(bold "$GROUP_COUNT") groups, $(bold "$TASK_COUNT") active tasks, $(bold "$ENV_KEYS") env keys"
```

让用户在进入 phase 1 之前看到 "好，识别了你的 v1：5 个 group、3 个 active task、22 个 env key"。

最后 export 两个变量给后续 step 用：

```bash
export NANOCLAW_V1_PATH="$V1_PATH"
export NANOCLAW_V2_PATH="$PROJECT_ROOT"
```

---

### 5. `run_step` helper：统一的 step runner

每个迁移步骤通过 `run_step` 跑：

```bash
# migrate-v2.sh:283-322
run_step() {
  local name=$1 label=$2 script=$3
  shift 3
  local raw="$STEPS_DIR/${name}.log"

  if pnpm exec tsx "$script" "$@" > "$raw" 2>&1; then
    local result
    result=$(grep '^OK:' "$raw" | head -1 || true)
    step_ok "$label $(dim "$result")"
    log "$name: $result"
    record_step "$name" "success"
    # Surface partial errors（rows skipped due to parse/lookup failures）
    # 即使 step 退出 success，ERROR 行也要露给用户，避免静默漏掉
    if grep -q '^ERROR:' "$raw" 2>/dev/null; then
      local err_count
      err_count=$(grep -c '^ERROR:' "$raw")
      echo "  $(dim "${err_count} error(s) reported — see $raw")"
      grep '^ERROR:' "$raw" | head -3 | while IFS= read -r line; do
        echo "  $(dim "$line")"
      done
      log "$name: ${err_count} non-fatal errors"
    fi
  elif grep -q '^SKIPPED:' "$raw" 2>/dev/null; then
    local reason
    reason=$(grep '^SKIPPED:' "$raw" | head -1 | sed 's/^SKIPPED://')
    step_skip "$label $(dim "($reason)")"
    log "$name: skipped ($reason)"
    record_step "$name" "skipped"
  else
    step_fail "$label"
    echo
    tail -10 "$raw" 2>/dev/null | while IFS= read -r line; do
      echo "  $(dim "$line")"
    done
    echo
    log "$name: FAILED (see $raw)"
    record_step "$name" "failed"
  fi
}
```

每个 step 是一个 standalone tsx 脚本，约定输出形式：
- 第一行匹配 `^OK:...`：成功，标 success
- 第一行匹配 `^SKIPPED:...`：跳过（比如 "no v1 .env file"），标 skipped
- exit code 非 0：失败，把 tail 10 行 echo 给用户
- 中间 `^ERROR:` 行：partial error（比如某条 group 解析失败），即使 step 总体 success 也要露给用户看

这个协议让 `migrate-v2.sh` 不用关心 step 内部细节，只看 stdout 前缀。所有 step 共用一致的状态机和 raw log 位置（`logs/migrate-steps/<step>.log`）。

`record_step` 把每步 status 记到全局并行数组 `STEP_NAMES[]` / `STEP_STATUSES[]`（bash 3.2 没 associative array），最后 EXIT trap 里写进 handoff.json。

---

### 6. Phase 1：核心 state

5 个 step，全部 idempotent——可以多次跑。

#### 6.1 `1a env.ts`：merge `.env`

`setup/migrate-v2/env.ts:26-50` 复制 v1 `.env` 里**每个** key 到 v2 `.env`：
- 已存在的 key 跳过（不覆盖）
- 在 v2 `.env` 末尾加 `# ── migrated from v1 ──` 分隔块再附加

源代码片段（`env.ts:39-50`）：

```ts
const v2EnvPath = path.join(process.cwd(), '.env');
const v1Lines = parseEnv(fs.readFileSync(v1EnvPath, 'utf-8'));
const v2Text = fs.existsSync(v2EnvPath) ? fs.readFileSync(v2EnvPath, 'utf-8') : '';
const v2Lines = parseEnv(v2Text);

const copied: string[] = [];
const skipped: string[] = [];
const appended: string[] = [];

const BLOCK_START = '# ── migrated from v1 ──';
const alreadyMigrated = v2Text.includes(BLOCK_START);
```

为什么不直接进 OneCLI vault？因为 OneCLI vault 的迁移由 `/init-onecli` skill 单独处理（它知道哪些 key 是凭证、哪些是普通配置、怎么写到 vault 还是 stay 在 `.env`）。这一步只做"把字面 key 搬过来"，把决策留给后面。

#### 6.2 `1b db.ts`：seed v2 DB

这是最复杂的 step。`setup/migrate-v2/db.ts:49-`：

1. 打开 v1 `store/messages.db` readonly，读 `registered_groups`。
2. v1 schema 不稳定（`channel_name` 是后加的列），只 SELECT 跨版本一定有的列：

   ```ts
   const v1Groups = v1Db
     .prepare('SELECT jid, name, folder, trigger_pattern, requires_trigger, is_main FROM registered_groups')
     .all() as V1Group[];
   ```

3. 0 行就 `SKIPPED:no registered groups in v1`、exit 0。

4. 初始化 v2 DB（`initDb(path.join(DATA_DIR, 'v2.db'))`）、跑迁移（`runMigrations(v2Db)`）。

5. **Discord JID resolver**：v1 把 Discord 存成 `dc:<channelId>`，没有 guildId 也没有"DM vs guild channel"区分。v2 必须区分：
   - guild channel: `discord:<guildId>:<channelId>`
   - DM: `discord:@me:<channelId>`

   所以读 `DISCORD_BOT_TOKEN` 调 Discord API 枚举所有 guild 和 channel、为每个 v1 channelId 反查出 (guildId 或 @me)。失败的话 resolver 给所有 channel 返回 null，对应 group 在循环里 skip 并 log warning。

   ```ts
   // db.ts:93-101
   let discordResolver: DiscordResolver | null = null;
   const discordChannelIds = v1Groups
     .map((g) => parseJid(g.jid))
     .filter((p): p is NonNullable<typeof p> => p?.channel_type === 'discord')
     .map((p) => p.id);
   if (discordChannelIds.length > 0) {
     const env = readEnvFile(['DISCORD_BOT_TOKEN']);
     discordResolver = await buildDiscordResolver(env.DISCORD_BOT_TOKEN ?? '', discordChannelIds);
   }
   ```

6. 对每条 `V1Group`：
   - parse JID（`dc:` → `discord`、`tg:` → `telegram`、`wa:` → `whatsapp`，这些 alias 在 `setup/migrate-v2/shared.ts`）
   - 用 Discord resolver 把裸 channelId 升级到 `discord:<guild>:<channel>` 或 `discord:@me:<channel>`
   - `getAgentGroupByFolder(folder)` 找 v2 是否已有同 folder 的 agent_group——有就复用、无就 create
   - `getMessagingGroupByPlatform(channel_type, platform_id)` 同上
   - 用 `triggerToEngage(v1.trigger_pattern, v1.requires_trigger)` 把 v1 的 trigger 映射成 v2 的 `engage_mode + engage_pattern`（mapping 规则见 `docs/v1-to-v2-changes.md` §entity model）
   - 检查 wiring 是否已存在（`getMessagingGroupAgentByPair`），不存在就 create
   - 把 `messaging_groups.unknown_sender_policy` 设成 `public` —— 让 bot 先能响应所有用户，`/migrate-from-v1` skill 在 seed 完 owner 后再 tighten。这个决策记在 `docs/migration-dev.md` "Key decisions"。

注意 **不 seed users / user_roles**——v1 没有 owner 概念，无法 guess。`/migrate-from-v1` skill 会问用户 "你是哪个 handle？" 然后再写 user + grant owner role。

#### 6.3 `1c groups.ts`：拷贝 group 目录

`setup/migrate-v2/groups.ts` 把 `<v1>/groups/<folder>/` 拷贝到 `<v2>/groups/<folder>/`。规则：

- **v1 `CLAUDE.md` → v2 `CLAUDE.local.md`**：v2 的 `CLAUDE.md` 由 spawn 时合成（第 8 章），不能直接写。v1 的 instruction 装到 `.local` 子文件，spawn 时通过 `@./CLAUDE.local.md` 引用进来。
- **v1 `container_config` → `.v1-container-config.json` sidecar**：v1 在 DB 里存了 JSON、v2 在 DB 表 `container_configs` 里存。但两边 schema 不完全一致。所以原样写到 sidecar 文件，留给 `/migrate-from-v1` skill 去 reconcile（人在 loop 里检查、决定怎么映射 mounts / packages / mcp_servers）。
- **其他文件**：复制，但 `existsSync(d)` 已存在就跳过（"rsync semantics"），符号链接 skip。
- 跳过 SKIP_NAMES：`CLAUDE.md`、`logs`、`.git`、`.DS_Store`、`node_modules`。

```ts
// setup/migrate-v2/groups.ts:31-54
function copyTree(src: string, dst: string): number {
  let written = 0;
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dst, { recursive: true });

  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP_NAMES.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);

    if (entry.isSymbolicLink()) {
      console.log(`SKIP:symlink ${path.relative(process.cwd(), s)}`);
      continue;
    }
    if (entry.isDirectory()) {
      written += copyTree(s, d);
      continue;
    }
    if (fs.existsSync(d)) continue;
    fs.copyFileSync(s, d);
    written += 1;
  }
  return written;
}
```

symlink 跳过的原因写在注释里——v1 group 里有 `.claude-shared.md → /app/CLAUDE.md` 这种容器内路径，host 上跟着复制会 ENOENT 崩、整个 traversal abort。v2 自己有 fragment 系统，这些 symlink 没用。

#### 6.4 `1d sessions.ts`：拷贝 session 数据

`setup/migrate-v2/sessions.ts` 干四件事：

1. `resolveSession()` 在 v2.db `sessions` 表里创建/复用 session 行
2. 初始化 session 目录：建 `inbound.db` / `outbound.db` / `outbox/`
3. 写 session routing（让容器知道往哪里回消息）
4. 拷贝 v1 `.claude/` 目录（Claude Code 的 session 持久化）到 v2 的 `.claude-shared/` 目录

v1 sessions 在 `data/sessions/<folder>/.claude/`，v2 sessions 在 `data/v2-sessions/<agent_group_id>/.claude-shared/`。

关键细节：v1 用的目录名是 `-workspace-group/`（Claude Code 把 workspace 目录的 `/` 替换成 `-` 当 session 子目录名），v2 容器 cwd 是 `/workspace/agent`，所以目录名变成 `-workspace-agent/`。`sessions.ts` 要把 JSONL 从 `-workspace-group/` 拷到 `-workspace-agent/`，并把 session ID 写到 outbound.db 的 `session_state` 表，key 是 `continuation:claude`——这样 agent-runner 启动时会 resume 同一段 Claude 对话。

#### 6.5 `1e tasks.ts`：port scheduled tasks

`setup/migrate-v2/tasks.ts` 把 v1 `scheduled_tasks` 表里 `status='active'` 的行迁到 v2：

- v1 schema：`(schedule_type, schedule_value, next_run, last_run, status, context_mode, script, ...)`
- v2 形式：`messages_in` 行 `kind='task'`，列 `process_after`（ISO 时间）+ `recurrence`（cron string）+ `series_id`

映射规则把 v1 的 `(schedule_type, schedule_value)` 对（`'cron','0 9 * * *'` / `'one_shot','2026-05-30T12:00Z'` 等）翻译成单个 cron string + `process_after`，调 `insertTask()` 写进对应 session 的 inbound.db。

非 active 的 task 不迁移，但导出到 `logs/setup-migration/inactive-tasks.json` 给 `/migrate-from-v1` skill 引用（让用户决定哪些值得手动恢复）。

---

### 7. Phase 2：Channels（interactive）

#### 7.1 `2a select-channels.ts`：clack multiselect

`setup/migrate-v2/select-channels.ts:17-31` 列出可选 channel：

```ts
const CHANNELS = [
  { value: 'telegram',       label: 'Telegram' },
  { value: 'discord',        label: 'Discord' },
  { value: 'slack',          label: 'Slack' },
  { value: 'whatsapp',       label: 'WhatsApp' },
  { value: 'teams',          label: 'Microsoft Teams' },
  { value: 'matrix',         label: 'Matrix' },
  { value: 'imessage',       label: 'iMessage' },
  { value: 'webex',          label: 'Webex' },
  { value: 'gchat',          label: 'Google Chat' },
  { value: 'resend',         label: 'Resend (email)' },
  { value: 'github',         label: 'GitHub' },
  { value: 'linear',         label: 'Linear' },
  { value: 'whatsapp-cloud', label: 'WhatsApp Cloud API' },
];
```

clack 多选 UI 让用户勾选要装的 adapter（默认基于检测到的 v1 channel 预选）。`NANOCLAW_CHANNELS=telegram,discord bash migrate-v2.sh` 可以跳过 prompt 走 env var 路径，给 CI 用。

结果写到临时文件，每行一个 channel name。`migrate-v2.sh:365-369` 把它读回 `SELECTED_CHANNELS[]` 数组。

#### 7.2 `2b channel-auth.ts`：拷贝凭证状态

`setup/migrate-v2/channel-auth.ts`：每个 channel 在 `setup/migrate-v2/shared.ts: CHANNEL_AUTH_REGISTRY` 里声明：
- 它用哪些 env key（已在 1a 拷过，这里再次确认）
- 它在 v1 文件系统上有哪些状态目录/文件需要拷（如 Baileys WhatsApp keystore `baileys/auth/*`、Matrix sync state、iMessage tokens……）

把所有相关文件用 glob 复制到 v2 对应路径，env key 用 `appendEnvKey` 写到 v2 `.env`（已存在的不动）。

#### 7.3 `2c install-<channel>.sh × N`

对每个 selected channel，跑 `setup/install-<ch>.sh`：

```bash
# migrate-v2.sh:385-413
for ch in "${SELECTED_CHANNELS[@]}"; do
  INSTALL_SCRIPT="setup/install-${ch}.sh"
  STEP_NAME="2c-install-${ch}"
  if [ -f "$INSTALL_SCRIPT" ]; then
    STEP_LOG="$STEPS_DIR/${STEP_NAME}.log"
    if bash "$INSTALL_SCRIPT" > "$STEP_LOG" 2>&1; then
      STATUS_LINE=$(grep '^STATUS:' "$STEP_LOG" | head -1 | sed 's/^STATUS: *//')
      if [ "$STATUS_LINE" = "already-installed" ]; then
        step_skip "Install $ch $(dim "(already installed)")"
        record_step "$STEP_NAME" "skipped"
      else
        step_ok "Install $ch"
        record_step "$STEP_NAME" "success"
      fi
      ...
```

这些脚本本质上是 channel branch 的安装器（CLAUDE.md "Channels and Providers" 节描述了它们做什么）：
- `git fetch origin channels`
- `git show channels:src/channels/<name>.ts > src/channels/<name>.ts`
- 把 `import './<name>.js';` append 到 `src/channels/index.ts`
- `pnpm install <pkg>@<pinned-version>`
- `pnpm run build`

每个脚本输出 `STATUS: ok` / `STATUS: already-installed` / `STATUS: failed`，`migrate-v2.sh` 按这个区分 success vs skip。

#### 7.4 已删除的步骤：v6 WhatsApp LID

`migrate-v2.sh:415-421` 留了一段注释解释为什么删了一个曾经存在的 step：

```bash
# 2d. (Removed) WhatsApp LID resolution was previously needed because the
# v6 adapter couldn't reliably translate LID→phone JIDs, so the migration
# pre-created dual messaging_groups rows. With Baileys v7, the adapter
# resolves LIDs via extractAddressingContext + signalRepository.lidMapping
# on every inbound message, so dual rows are unnecessary and were causing
# split sessions.
```

留这段是给未来读 git log 的人看：如果你怀疑"为什么没处理 WhatsApp LID 这事"——答案是上游 adapter 自己搞定了。

---

### 8. Phase 3：Infrastructure

#### 8.1 `3a Docker`

如果系统没装 docker，跑 `setup/install-docker.sh`。OneCLI 和 agent container 都依赖 docker。

```bash
# migrate-v2.sh:433-449
if command -v docker >/dev/null 2>&1; then
  DOCKER_V=$(docker --version 2>/dev/null | head -1)
  step_ok "Docker available $(dim "($DOCKER_V)")"
else
  step_info "Installing Docker…"
  ...
```

#### 8.2 `3b OneCLI`

```bash
# migrate-v2.sh:452-479
ONECLI_OK=false
ONECLI_URL_FROM_ENV=$(grep '^ONECLI_URL=' .env 2>/dev/null | head -1 | sed 's/^ONECLI_URL=//')
ONECLI_URL_CHECK="${ONECLI_URL_FROM_ENV:-http://127.0.0.1:10254}"

if curl -sf "${ONECLI_URL_CHECK}/api/health" >/dev/null 2>&1; then
  step_ok "OneCLI running at $(dim "$ONECLI_URL_CHECK")"
  ONECLI_OK=true
elif command -v docker >/dev/null 2>&1; then
  step_info "Setting up OneCLI…"
  ...
  if pnpm exec tsx setup/index.ts --step onecli > "$ONECLI_LOG" 2>"$ONECLI_ERR"; then
    step_ok "OneCLI ready"
    ONECLI_OK=true
  ...
```

OneCLI 是个独立的本地 daemon (HTTP server on 10254)。如果还没装，调 NanoClaw 的 setup orchestrator `setup/index.ts` 的 `--step onecli` 子任务装它。需要 Docker（OneCLI 自己跑在 container 里）。

#### 8.3 `3c Anthropic credential`

```bash
# migrate-v2.sh:482-501
if grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
  step_ok "Anthropic credential found in .env"
elif [ "$ONECLI_OK" = "true" ]; then
  step_info "Registering Anthropic credential…"
  ...
```

如果 `.env` 里有 Anthropic key（已被 1a 拷过来）就跳过；否则交给 `setup/index.ts --step auth` 处理（走 OAuth 或交互输入 key）。

#### 8.4 `3d` 拷贝 v1 container skills

```bash
# migrate-v2.sh:504-528
V1_SKILLS_DIR="$V1_PATH/container/skills"
V2_SKILLS_DIR="$PROJECT_ROOT/container/skills"

if [ -d "$V1_SKILLS_DIR" ]; then
  SKILLS_COPIED=0
  SKILLS_SKIPPED=0
  for skill_dir in "$V1_SKILLS_DIR"/*/; do
    [ -d "$skill_dir" ] || continue
    skill_name=$(basename "$skill_dir")
    if [ -d "$V2_SKILLS_DIR/$skill_name" ]; then
      SKILLS_SKIPPED=$((SKILLS_SKIPPED + 1))
    else
      cp -r "$skill_dir" "$V2_SKILLS_DIR/$skill_name"
      SKILLS_COPIED=$((SKILLS_COPIED + 1))
    fi
  done
  ...
```

把 v1 的 container skill 目录（v2 trunk 里不存在的）原样拷过来。v2 trunk 自带的 `onecli-gateway`、`welcome`、`self-customize`、`agent-browser`、`slack-formatting`——已存在的不覆盖。

#### 8.5 `3e container/build.sh`

```bash
# migrate-v2.sh:531-549
if command -v docker >/dev/null 2>&1; then
  step_info "Building agent container image…"
  BUILD_LOG="$STEPS_DIR/3e-container-build.log"
  if bash container/build.sh > "$BUILD_LOG" 2>&1; then
    step_ok "Container image built"
  else
    step_fail "Container build failed"
  ...
```

这是耗时大头——`docker build` 拉 Bun base image、装 pnpm global deps（claude-code、vercel、agent-browser 等）、可选装 CJK 字体（如果 `.env` 有 `INSTALL_CJK_FONTS=true`）。fresh build 30s-3min，cached 几秒。

---

### 9. Service switchover

`migrate-v2.sh:558-677` 是用户在脚本里最关键的交互点。

#### 9.1 检测 platform 和 service 名

```bash
V1_SERVICE=""
V2_SERVICE=""
PLATFORM_SERVICE=""

if [ "$(uname -s)" = "Darwin" ]; then
  PLATFORM_SERVICE="launchd"
  V1_SERVICE="com.nanoclaw"
  # v2 uses install-slug for unique service names
  V2_SERVICE=$(pnpm exec tsx -e "import{getLaunchdLabel}from'./src/install-slug.js';console.log(getLaunchdLabel())" 2>/dev/null || echo "")
elif [ "$(uname -s)" = "Linux" ]; then
  PLATFORM_SERVICE="systemd"
  V1_SERVICE="nanoclaw"
  V2_SERVICE=$(pnpm exec tsx -e "import{getSystemdUnit}from'./src/install-slug.js';console.log(getSystemdUnit())" 2>/dev/null || echo "")
fi
```

v1 service 名是固定的 (`com.nanoclaw` / `nanoclaw`)。v2 用 install-slug 算唯一名 (`nanoclaw-v2-<hash>`)——所以多个 v2 install 不会撞 systemd unit。

#### 9.2 检测 v1 是否在跑

```bash
V1_RUNNING=false
if [ "$PLATFORM_SERVICE" = "systemd" ]; then
  systemctl --user is-active "$V1_SERVICE" >/dev/null 2>&1 && V1_RUNNING=true
elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
  launchctl list "$V1_SERVICE" >/dev/null 2>&1 && V1_RUNNING=true
fi
```

如果没在跑，直接 `disable_v1_service`（确保它不会 auto-start）并跳过 switchover。

#### 9.3 Prompt：switch or skip

跑 `switchover-prompt.ts --offer-switch`：

```ts
// setup/migrate-v2/switchover-prompt.ts:25-34
const answer = await p.select({
  message: 'Want to stop the v1 service and start v2 so you can test?',
  options: [
    { value: 'switch', label: 'Yes, switch to v2 now', hint: 'you can switch back after' },
    { value: 'skip', label: 'No, skip for now', hint: 'start v2 manually later' },
  ],
});
fs.writeFileSync(outFile, p.isCancel(answer) ? 'skip' : String(answer));
```

bash 通过临时文件读结果。如果 `switch`：

1. stop v1（systemctl/launchctl）
2. 跑 `setup/index.ts --step service` 安装 v2 launchd plist / systemd unit、start v2
3. 从 step 输出 parse 出 `SERVICE_UNIT:` / `SERVICE_LABEL:` 拿到 v2 service 名

#### 9.4 Prompt：keep or revert

切换完后立刻给用户机会回滚：

```bash
# 然后等用户去 telegram/discord 测试 bot
echo
step_info "v2 is running — send a test message to your bot"
echo

# Ask: keep or revert?
KEEP_ANSWER_FILE=$(mktemp)
pnpm exec tsx setup/migrate-v2/switchover-prompt.ts --keep-or-revert "$KEEP_ANSWER_FILE" || true
KEEP_ANSWER=$(cat "$KEEP_ANSWER_FILE" 2>/dev/null || echo "keep")
```

如果用户测试发现 v2 有问题：选 revert，脚本 stop v2 service、disable + restart v1。

如果 keep：脚本调 `disable_v1_service`——v1 service 文件留在磁盘上，但 disable 掉防止 auto-start。这样用户随时可以 `systemctl --user start nanoclaw` 手动回滚（脚本最后会打印命令）。

```bash
# disable_v1_service (migrate-v2.sh:564-579)
disable_v1_service() {
  if [ "$PLATFORM_SERVICE" = "systemd" ]; then
    local v1_file="$HOME/.config/systemd/user/${V1_SERVICE}.service"
    if [ -f "$v1_file" ] || [ -L "$v1_file" ]; then
      systemctl --user stop "$V1_SERVICE" 2>/dev/null || true
      systemctl --user disable "$V1_SERVICE" 2>/dev/null || true
      step_ok "Disabled $V1_SERVICE (unit file kept for rollback)"
    fi
  elif [ "$PLATFORM_SERVICE" = "launchd" ]; then
    local v1_plist="$HOME/Library/LaunchAgents/${V1_SERVICE}.plist"
    if [ -f "$v1_plist" ] || [ -L "$v1_plist" ]; then
      launchctl unload "$v1_plist" 2>/dev/null || true
      step_ok "Unloaded $V1_SERVICE (plist kept for rollback)"
    fi
  fi
}
```

---

### 10. Phase 4：handoff 给 Claude

#### 10.1 `handoff.json`

```bash
# migrate-v2.sh:58-101
write_handoff() {
  local handoff_dir="$LOGS_DIR/setup-migration"
  mkdir -p "$handoff_dir"

  local has_failures=false
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    [ "${STEP_STATUSES[$i]}" = "failed" ] && has_failures=true
  done

  local overall="success"
  $has_failures && overall="partial"
  [ -n "$ABORTED_AT" ] && overall="failed"

  local steps_json="{"
  for ((i=0; i<${#STEP_NAMES[@]}; i++)); do
    local n="${STEP_NAMES[$i]}"
    local s="${STEP_STATUSES[$i]}"
    steps_json="${steps_json}\"${n}\": {\"status\": \"${s}\", \"log\": \"logs/migrate-steps/${n}.log\"},"
  done
  steps_json="${steps_json%,}}"

  cat > "$handoff_dir/handoff.json" <<HANDOFF_EOF
{
  "version": 1,
  "started_at": "$(ts_utc)",
  "v1_path": "$V1_PATH",
  "v1_version": "$V1_VERSION",
  "overall_status": "$overall",
  "aborted_at": "$ABORTED_AT",
  "source": "migrate-v2.sh",
  "channels_installed": [$(printf '"%s",' "${SELECTED_CHANNELS[@]}" 2>/dev/null | sed 's/,$//')],
  "onecli_healthy": $ONECLI_OK,
  "service_switched": $SERVICE_SWITCHED,
  "steps": $steps_json,
  "step_logs_dir": "logs/migrate-steps",
  "followups": [
    "Seed owner user and access policy",
    "Review CLAUDE.local.md files for v1-specific patterns",
    "Verify container.json mount paths are valid"
  ]
}
HANDOFF_EOF
}

trap write_handoff EXIT
```

`trap write_handoff EXIT` —— **任何**退出路径（成功、abort、Ctrl-C）都写 handoff.json。Claude skill 始终能读到一份描述这次 migration 状态的文件。

#### 10.2 Summary 打印

```bash
echo "$(bold '── Migration complete ──')"
echo
echo "  $(dim 'v1:')  $V1_PATH"
echo "  $(dim 'v2:')  $PROJECT_ROOT"
echo
echo "  $(bold 'What was done:')"
echo "    $(green '✓')  .env keys merged"
echo "    $(green '✓')  Database seeded (agent groups, messaging groups, wiring)"
...
echo "  $(bold 'What still needs a human:')"
if [ "$ONECLI_OK" = "false" ]; then
echo "    $(dim '·')  Set up OneCLI: pnpm exec tsx setup/index.ts --step onecli"
fi
if ! grep -qE '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' .env 2>/dev/null; then
echo "    $(dim '·')  Add Anthropic credential to .env or OneCLI vault"
fi
echo "    $(dim '·')  Run $(bold '/migrate-from-v1') in Claude to finish:"
echo "       $(dim '- Seed your owner account')"
echo "       $(dim '- Set access policies')"
echo "       $(dim '- Port any custom v1 code')"
```

如果 service 切了，还会打印 rollback 命令。

#### 10.3 `exec claude /migrate-from-v1`

```bash
# migrate-v2.sh:738-742
if command -v claude >/dev/null 2>&1; then
  write_handoff
  trap - EXIT
  exec claude "/migrate-from-v1"
fi
```

如果系统装了 `claude` binary，脚本用 `exec` **替换**自己为 claude 进程，立即把控制权交出去——bash 进程不再存在。

注意 `exec` 之前要 **明确再调一次 `write_handoff`**——因为 `exec` 替换进程，bash 的 EXIT trap 不会触发。如果不显式调，handoff.json 就是空的或者旧的。然后 `trap - EXIT` 清掉 trap 避免重复。

<svg viewBox="0 0 880 380" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="handoff.json EXIT trap timeline and exec process replacement"><defs><marker id="r14ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/></marker></defs><text x="440" y="22" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">bash 进程生命周期 + EXIT trap 触发矩阵</text><line x1="60" y1="90" x2="820" y2="90" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#r14ar4)"/><text x="60" y="106" font-size="10" fill="#64748b">t=0 启动</text><text x="820" y="106" text-anchor="end" font-size="10" fill="#64748b">t=end</text><circle cx="100" cy="90" r="5" fill="#0ea5e9"/><text x="100" y="74" text-anchor="middle" font-size="10" fill="currentColor">trap write_handoff EXIT</text><text x="100" y="124" text-anchor="middle" font-size="9" fill="#64748b">migrate-v2.sh:101</text><circle cx="220" cy="90" r="5" fill="#0d9488"/><text x="220" y="74" text-anchor="middle" font-size="10" fill="currentColor">Phase 0-3 跑</text><text x="220" y="124" text-anchor="middle" font-size="9" fill="#64748b">record_step ×N</text><circle cx="360" cy="90" r="5" fill="#7c3aed"/><text x="360" y="74" text-anchor="middle" font-size="10" fill="currentColor">Phase 4 summary</text><text x="360" y="124" text-anchor="middle" font-size="9" fill="#64748b">打印 ✓/·</text><circle cx="500" cy="90" r="6" fill="#ea580c"/><text x="500" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="#ea580c">显式 write_handoff()</text><text x="500" y="124" text-anchor="middle" font-size="9" fill="#64748b">migrate-v2.sh:739</text><circle cx="620" cy="90" r="5" fill="#dc2626"/><text x="620" y="74" text-anchor="middle" font-size="10" fill="currentColor">trap - EXIT</text><text x="620" y="124" text-anchor="middle" font-size="9" fill="#64748b">清掉 trap 避免重复</text><circle cx="780" cy="90" r="6" fill="#0ea5e9"/><text x="780" y="74" text-anchor="middle" font-size="10" font-weight="700" fill="#0ea5e9">exec claude</text><text x="780" y="124" text-anchor="middle" font-size="9" fill="#dc2626">bash 进程被替换 → trap 不触发</text><text x="60" y="170" font-size="12" font-weight="700" fill="currentColor">三种退出路径 → handoff.json 始终被写：</text><rect x="60" y="184" width="240" height="80" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.2"/><text x="180" y="202" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">A. 成功跑完</text><text x="70" y="220" font-size="10" fill="#64748b">显式 write_handoff() → trap -</text><text x="70" y="236" font-size="10" fill="#64748b">→ exec claude /migrate-from-v1</text><text x="70" y="252" font-size="10" fill="#16a34a">overall_status: "success"</text><rect x="320" y="184" width="240" height="80" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/><text x="440" y="202" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">B. step failed / aborted</text><text x="330" y="220" font-size="10" fill="#64748b">abort() → exit 1</text><text x="330" y="236" font-size="10" fill="#64748b">trap 触发 → write_handoff()</text><text x="330" y="252" font-size="10" fill="#dc2626">overall_status: "failed" + aborted_at</text><rect x="580" y="184" width="240" height="80" rx="6" fill="#fff7ed" stroke="#ea580c" stroke-width="1.2"/><text x="700" y="202" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">C. 用户 Ctrl-C</text><text x="590" y="220" font-size="10" fill="#64748b">SIGINT → bash exit</text><text x="590" y="236" font-size="10" fill="#64748b">trap 触发 → write_handoff()</text><text x="590" y="252" font-size="10" fill="#ea580c">overall_status: "partial" (已成功 step 保留)</text><rect x="60" y="284" width="760" height="80" rx="6" fill="#eff6ff" stroke="#0ea5e9" stroke-width="1.2"/><text x="70" y="304" font-size="11" font-weight="700" fill="#0ea5e9">claude 进程接手 (PID 不变)</text><text x="70" y="324" font-size="10" fill="#64748b">读 logs/setup-migration/handoff.json → 知道哪些 step 成功 / 失败 / 跳过</text><text x="70" y="340" font-size="10" fill="#64748b">问用户 "Which handle is you?" → seed user + owner role → tighten unknown_sender_policy</text><text x="70" y="356" font-size="10" fill="#64748b">reconcile .v1-container-config.json sidecar → 清理 CLAUDE.local.md 里的 v1 残留</text></svg>
<span class="figure-caption">图 R14.4 ｜ handoff.json EXIT trap 时间线：三种退出路径都触发 write_handoff，保证 /migrate-from-v1 skill 接手时一定能读到状态。关键陷阱：exec 替换进程会绕过 trap，所以 §10.3 必须在 exec 前显式调一次 write_handoff() 再 trap -。</span>

`/migrate-from-v1` 是个 Claude Code skill，从 `.claude/skills/migrate-from-v1/SKILL.md` 加载。它读 `handoff.json`、问用户 "Which handle is you?"、seed owner、调整 `unknown_sender_policy` 从 `public` 改回 `strict`、reconcile `.v1-container-config.json` sidecar、检查 `CLAUDE.local.md` 里残留的 v1-specific 内容（旧的 trigger pattern 描述、v1 路径引用、过时的 MCP server 配置），最后告诉用户 "你已经在 v2 上跑了，下一步可以 `/init-onecli` / `/add-<channel>` / `/customize` ..."。

---

### 11. `migrate-v2-reset.sh`：开发用清理

`migrate-v2-reset.sh` 是给开发者的：每次改了某个 step 想重新跑迁移测试，需要一个 "把 v2 state 退回纯 git 状态" 的命令：

```bash
# migrate-v2-reset.sh:31-99
clean "data"  "data/"          # 删 v2 DB、session 目录、所有持久化
clean "logs"  "logs/"          # 删 migration log、step log、setup log
clean ".env"  ".env"           # 删 merged env

# 删所有 group 目录然后 git checkout 恢复 tracked 的
if [ -d "groups" ]; then
  rm -rf groups
fi
git checkout -- groups/

# 恢复 container/skills/（删 v1 拷来的、留 tracked 的）
git checkout -- container/skills/
for d in container/skills/*/; do
  ...
  if ! git ls-files --error-unmatch "$d" >/dev/null 2>&1; then
    rm -rf "$d"
  fi
done

# 恢复 src/channels/（删 channel install 拷来的 .ts）
git checkout -- src/channels/
for f in src/channels/*.ts; do
  ...
  if ! git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    rm -f "$f"
  fi
done

# 恢复 setup/ 里 channel install 改过的文件
git checkout -- setup/whatsapp-auth.ts setup/pair-telegram.ts setup/index.ts
rm -f setup/groups.ts

# 恢复 package.json + lockfile（channel install 加的 dep）
git checkout -- package.json pnpm-lock.yaml
```

**不**碰：
- `node_modules/`：重新装很贵（pnpm install --frozen-lockfile 几十秒到几分钟）
- `setup/migrate-v2/*`：迁移脚本本身（包括开发者正在改的 WIP）
- v1 install：read-only，从不修改

`docs/migration-dev.md` 给的开发循环：

```bash
bash migrate-v2-reset.sh && bash migrate-v2.sh
```

一行命令重新跑整个 migration。

---

### 12. `docs/migration-dev.md`：开发指南

`docs/migration-dev.md` 是给给开发 / 修 migration bug 的人。关键内容：

**单 step 测试**：每个 step 是 standalone tsx 脚本，可以单独跑：

```bash
pnpm exec tsx setup/migrate-v2/env.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/db.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/groups.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/sessions.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/tasks.ts /path/to/v1
pnpm exec tsx setup/migrate-v2/channel-auth.ts /path/to/v1 telegram discord
```

每个打 `OK:<details>` / `SKIPPED:<reason>` / 报错。exit code 0 = success/skip，非 0 = failure。

**Debug 查询**：

```bash
# Agent groups
sqlite3 data/v2.db "SELECT * FROM agent_groups"

# Messaging groups + wiring
sqlite3 data/v2.db "SELECT mg.id, mg.channel_type, mg.platform_id, mg.unknown_sender_policy, mga.engage_mode, mga.engage_pattern FROM messaging_groups mg JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id"

# Session continuation
AG_ID=$(sqlite3 data/v2.db "SELECT id FROM agent_groups LIMIT 1")
SESS_ID=$(sqlite3 data/v2.db "SELECT id FROM sessions LIMIT 1")
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/outbound.db "SELECT * FROM session_state"

# Tasks
sqlite3 data/v2-sessions/$AG_ID/$SESS_ID/inbound.db "SELECT id, kind, recurrence, status FROM messages_in WHERE kind='task'"
```

**常见问题**：

| 症状 | 怀疑 |
|------|------|
| 切换后 bot 不响应 | 两个 service 同时在跑（`systemctl --user list-units 'nanoclaw*'`）；`unknown_sender_policy` 还是 `strict`；engage pattern 不对 |
| Session 没续上 | 没设 `continuation:claude`；JSONL 路径错（应该在 `-workspace-agent/` 而不是 `-workspace-group/`） |
| Revert 不工作 | v2 service 名是 `nanoclaw-v2-<hash>`——`list-units` 找出来手动 stop+disable，然后 start v1 |

---

### 13. Edge cases & rollback

#### 13.1 v1 install 找不到

- `NANOCLAW_V1_PATH` 没设、sibling 目录里没匹配的——脚本 abort，告诉用户怎么设。

#### 13.2 v1 DB schema 残缺

- 没 `registered_groups` 表 → abort `v1-db-invalid`。这通常意味着这个目录根本不是 NanoClaw v1（可能用户指错了路径）。

#### 13.3 Channel adapter 缺包 / install 失败

- step 跑 `setup/install-<ch>.sh` 失败，`record_step "failed"`，但**不 abort 整个 migration**——其他 channel / phase 继续。最后 summary 会显示哪个失败、log 在哪。
- `/migrate-from-v1` skill 读到 `handoff.json` 里这个 channel 是 failed，会引导用户手动调试或选 skip。

#### 13.4 docker build 失败

- step 3e 失败，`record_step "failed"`，phase 3 继续走 service switchover（但 switchover 会拒绝切——因为没 image agent 起不来；实际行为：脚本仍然切，运行时容器启动失败，用户会在 telegram 测试时看到 bot 没响应；下一步进 debug）。
- 实际：build 失败往往是 docker daemon 没起、磁盘满、网络问题。`docs/migration-dev.md` 让用户先看 `logs/migrate-steps/3e-container-build.log`。

#### 13.5 用户 Ctrl-C 中断

- bash `set -uo pipefail`（注意没设 `-e`）——任何一步报错不 abort 整体，只标 failed。
- Ctrl-C 触发 EXIT trap，`write_handoff` 仍然跑、状态写成 `aborted_at: <这一步>`。
- 再跑一次 `bash migrate-v2.sh`——所有 step idempotent，已成功的 SKIP（如 `env.ts` 看到 key 已存在），未完成的从头跑。

#### 13.6 Rollback

- service 切了后想退回 v1：脚本 summary 打印命令（systemd / launchctl 用对应命令切回）
- v1 install 从不被改——所有 v1 数据原样保留，rollback 就是 stop v2 + start v1
- v2 state 在 `data/`、`groups/`（v1 不存在的目录）、`.env`（添加了 `# ── migrated from v1 ──` 块），全部可独立删除

---

### 14. CLAUDE.md banner 的"为什么"再述

把 banner 存在的理由讲全：

**1. Failure mode 是真实的、可复现的**。用户在 v1 install 跑 Claude Code 说"帮我升级 nanoclaw"——这事每个月都在发生。如果没 banner，Claude **会** 尝试 merge，**会** 试图 resolve conflict，**会** 烧大量 token + 永久弄坏 install。这是已观察到的真实 incident。

**2. Banner 占领"Claude 读 CLAUDE.md 的第一秒"**。Claude 启动一定读 CLAUDE.md（这是 Claude Code 的 hardcoded 行为）。banner 是文件头一行——Claude 读到第一段时还没有任何 context 让它判断"这条警告是过时的还是仍然适用"。它必须假定 banner 仍然有效。

**3. Verbatim message 给 Claude 一条逃生路径**。Banner 不只说 "abort"——它给出**字面要对用户说的话**和**具体的 shell 命令**（`git merge --abort`）。Claude 不用 reason，复读即可。这避免了"知道有问题但不知道怎么传达" 的失败。

**4. 同时拦住"Claude 想自己跑 migrate-v2.sh"**。Banner 明确禁止；脚本里 `[ -t 0 ]` 检测也挡。两层冗余。

**5. fresh clone 不触发**。Banner 最后一段 ("If you are a fresh install ... ignore this banner") 让 Claude 知道在没 conflict 的环境下可以继续——避免 banner 永远蒙蔽 Claude 的判断。

设计的核心 invariant：**Claude 实例在错误情境下能做的最有用的事就是 escalate 给人类**。banner + 脚本挡板共同保证这一点。

---

### 15. 完成后的状态

成功跑完后，用户应该有：

- v2 service running（或者 v1 还在跑、v2 装好了准备手动启）
- `data/v2.db` 包含 agent_groups / messaging_groups / wirings 行（但**没**有 user / user_role 行）
- `data/v2-sessions/<agent_group>/<session>/` 包含 inbound.db / outbound.db，session 续上 v1 的 Claude 对话
- `.env` 包含 v1 所有 key + v2 必要的新 key
- 装好了选中的 channel adapter（`src/channels/<n>.ts` + 依赖装好）
- agent container image build 完成
- `logs/setup-migration/handoff.json` 描述上面所有 state

**Verification**：

```bash
# v2 service 在跑？
launchctl list nanoclaw-v2-<hash>     # macOS
systemctl --user is-active nanoclaw-v2-<hash>  # Linux

# v2.db 有内容？
sqlite3 data/v2.db "SELECT COUNT(*) FROM agent_groups"
sqlite3 data/v2.db "SELECT COUNT(*) FROM messaging_group_agents"

# Image build 好了？
docker images | grep nanoclaw-agent

# Bot 响应？
# (用户在 telegram/discord 发一条消息，bot 应该回)
```

然后开 Claude Code 跑 `/migrate-from-v1`，完成 owner 配置、policy 收紧、custom 代码 port、CLAUDE.local.md 清理。

---

### 16. 首次安装 vs 迁移

两条入口路径，最终都到 "running v2"：

| 路径 | 入口 | 适用场景 |
|------|------|---------|
| Fresh install | `bash setup.sh && pnpm run setup:auto`（或 Claude 内 `/setup`） | 全新机器，没装过任何版本 NanoClaw |
| Migration | `bash migrate-v2.sh` | 已有 v1 install，要升到 v2 |

`bash setup.sh` 只 bootstrap Node + pnpm + deps（共用代码），然后 `setup/index.ts`（也叫 `setup/auto.ts`）做主流程：交互问 user 怎么称呼 (display name)、装 OneCLI、装 docker、build container image、装 first channel、`init-first-agent` 起第一个 agent group + welcome DM。

`migrate-v2.sh` 共用 phase 0（bootstrap）和 phase 3（infrastructure：docker / onecli / build），但其他全是迁移特有：phase 1（seed from v1 DB）+ phase 2（channel install 是基于 v1 detected channel 列表）+ service switchover。

两者交集：
- 都用 `setup.sh` bootstrap Node
- 都用 `setup/install-<ch>.sh` 装 channel
- 都用 `setup/install-docker.sh` 装 docker
- 都用 `setup/index.ts --step onecli` 装 OneCLI
- 都用 `container/build.sh` build image
- 都用 `setup/index.ts --step service` 安装 launchd/systemd unit

差异：
- fresh 走 `setup/auto.ts`（clack 多 prompt + spinners + 完整 setup orchestrator）；migrate 走 `migrate-v2.sh`（更 minimal 的 step runner，重点是迁移 v1 state）
- fresh 在最后跑 `scripts/init-first-agent.ts` 起第一个 agent；migrate 在最后 exec 进 Claude 跑 `/migrate-from-v1` skill
- fresh 用户从零选 channel；migrate 默认 pre-select v1 已有的 channel

---

### 17. `/init-first-agent` 和 `/init-onecli` skills

完成 setup 或 migrate 之后还需要做的两件事：

#### 17.1 `/init-first-agent`

CLAUDE.md "Skills" 节列出来的——bootstrap 第一个 DM-wired agent。底层是 `scripts/init-first-agent.ts`（第 13 章 §14 讲过）：

- 选 channel
- 输入 user id + display name
- 创建 user + grant owner role
- 创建 agent group + 设 `cli_scope='global'`
- 创建 DM messaging group + 创建 wiring（`engage_mode='pattern'`、`engage_pattern='.'`）
- 投 welcome DM（"/welcome"），让 agent 在 DM 里自我介绍

完成后用户在 telegram / discord 等 channel 上就能开始和 agent 对话。

#### 17.2 `/init-onecli`

OneCLI Agent Vault 的设置 + `.env` 凭证迁移到 vault：

- 检查 OneCLI daemon 健康
- 扫 `.env` 找凭证 key
- 帮用户决定哪些进 vault（带 host pattern 的）、哪些留 `.env`（不敏感的配置）
- 创建 OneCLI secret
- 关联到 agent (set-secret-mode all 或 selective)
- 重启 container 让新配置生效

这是 fresh install 和 migrate 都需要的——尤其 migrate，因为 v1 没有 vault 概念，所有凭证都在 `.env` 里。

---

### 18. 一句话总结

`migrate-v2.sh` 是一次性、idempotent、可 resume 的迁移 orchestrator：bootstrap → 找 v1 install → 5 个 phase-1 step seed v2 state → 装用户选的 channel → 装 infrastructure（docker/onecli/anthropic/skills/build image）→ service 切换 → 写 handoff.json → exec 进 Claude Code 跑 `/migrate-from-v1` skill 完成 owner 配置和清理。CLAUDE.md 顶部的 STOP banner 是给 Claude 实例的硬挡板，确保它在看到 merge conflict 时立刻 abort + 让用户去 shell 跑这个脚本，而不是试图 fix。fresh install 走 `setup.sh + setup/auto.ts`；两条路最终都到 "v2 service running、第一个 channel 装好、第一个 agent 可对话"。
