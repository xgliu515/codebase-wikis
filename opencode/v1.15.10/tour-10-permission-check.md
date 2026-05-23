# Trace 步骤 10 —— 权限评估

## 1. 当前情境

第 09 步把 args 校过，`ReadTool.execute` 已经在跑。控制流走到 `tool/read.ts:200-232` 这一段：

```ts
const run = Effect.fn("ReadTool.execute")(function* (params, ctx) {
  const instance = yield* InstanceState.context
  let filepath = params.filePath
  if (!path.isAbsolute(filepath)) {
    filepath = path.resolve(instance.directory, filepath)
  }
  // ... win32 normalize, reference.ensure, stat
  yield* assertExternalDirectoryEffect(ctx, filepath, { ... })

  yield* ctx.ask({                                       // ← 我们在这一行之前
    permission: "read",
    patterns: [path.relative(instance.worktree, filepath)],
    always: ["*"],
    metadata: {},
  })
  // ... 真正的 fs.readFile 在下面
})
```

也就是说：**absolute path 已经算出来**（`/Users/.../README.md`），`reference.ensure` 已经把这个路径登记进当前 session 的 reference table（trace 第 14 步会用到），`assertExternalDirectoryEffect` 也通过了（README.md 在 worktree 内）。接下来要进 `ctx.ask({permission: "read", ...})`——这一步要决定的是：**这个 read 调用允许 / 拒绝 / 要不要问用户**。

`ctx.ask` 是 `SessionTools.resolve` 在装配时注入的闭包，它会调 `Permission.ask({...})`。本步骤的主角就是 `Permission.ask` + `Permission.evaluate`。

## 2. 问题

权限层要回答的问题听上去很简单："这次 read 让不让？"实际要解决的事更细：

1. **谁来定 ruleset**？ opencode 默认 ruleset（agent.ts:106-125 那张表）、当前 agent 的自定义 ruleset（如 `plan` agent 禁所有 edit）、session 级 ruleset（`Session.create` 时可以传 `permission`，比如 subagent 会从父 session 继承）、用户配置文件 `opencode.json` 的 `permission` 块、运行时通过 `Permission.reply("always")` 累积起来的 approved 列表——五处都可能贡献规则。它们的优先级要明确。
2. **规则怎么匹配**？模式语法是 wildcard（`*.env` / `~/.ssh/**` / `*` 通配），不是字面量。`{permission: "read", pattern: "*.env"}` 要对 `path/to/.env.production` 命中、对 `README.md` 不命中。
3. **`ask` 分支怎么实现？** 三个 action：`allow` 立即继续、`deny` 立即报错、`ask` 要把控制权移交给用户。用户答 yes/no 之前 tool 调用必须**真的卡住**。
4. **跨 client**：CLI 用户答题靠 stdin/y or n，TUI 弹一个 modal，Web UI 弹一个对话框——同一个 `ask` 调用要能驱动这三种 client，不能把交互逻辑写死。
5. **`always` 分支**：用户答 "Always allow this" 后，下次同样的请求不该再问；持久化 + 重启后仍然记住。
6. **subagent**：当父 agent 处于 plan mode（edit 全 deny），通过 task 工具派生的 subagent 不能绕过这条限制——subagent 的 ruleset 必须从父 agent 那里继承 deny 规则。

## 3. 朴素思路

每个工具自己写 if-else：

```ts
if (filepath.endsWith(".env")) {
  const answer = await prompt("Read .env? (y/n)")
  if (answer !== "y") throw new Error("denied")
}
```

或者中心化一点：把"敏感文件名"和"允许目录"列在 config 里，run handler 第一行查一下。

## 4. 为什么朴素思路会崩

- **同一份策略 N 个工具要复用**。`read`、`grep`、`glob`、`list`、`webfetch`、`websearch`、`bash`、`task`……每个都得做权限——if-else 散在十几处，规则改一次要十几个 PR。
- **agent 间策略不同**。`build` 默认 `*: allow` 加几个 deny；`plan` 禁所有 edit；`explore` 只允许 read 系；`general` 禁 todowrite——这些差异必须能声明式地表达，不能写死。
- **用户配置覆盖**。用户在 `opencode.json` 里写 `"read": {"~/.ssh/**": "deny"}`——这必须能在不动代码的情况下生效。
- **`ask` 是异步互动**。tool handler 卡住等用户答时，整个 LLM 流（包括其他并行 tool call）都还在跑——必须用 `Deferred`/`Promise` 而不是阻塞 wait。同时 session 关闭时所有 pending ask 要 reject 掉避免泄漏。
- **`always` 要持久化**。重启后还得记得用户上次说过的 "always allow read in ./scripts/"——朴素 if-else 没有这个能力。
- **bash 工具的"命令前缀"匹配**。同一个 `bash` 调用，`git status` 和 `git push origin main --force` 不能用同一条 pattern 匹配；要按命令前缀切。这种领域知识不可能塞进每个 tool 的 if-else。

## 5. opencode 的做法

opencode 的权限层是一个独立的 Service（`packages/opencode/src/permission/index.ts`），核心由三个零件组成：

**零件 A：规则 schema（`permission/index.ts:19-30`）**

```ts
export const Action = Schema.Literals(["allow", "deny", "ask"])

export const Rule = Schema.Struct({
  permission: Schema.String,   // 工具类别，如 "read" / "edit" / "bash"
  pattern: Schema.String,      // wildcard，如 "*.env" / "git push *"
  action: Action,
})

export const Ruleset = Schema.Array(Rule)
```

一条规则只关心三件事：哪个权限类别、哪个模式、什么动作。Ruleset 就是规则的有序数组——**顺序很重要**，后面的覆盖前面的。

**零件 B：纯函数 `evaluate`（`packages/core/src/permission.ts:21-31`）**

```ts
export function evaluate(permission, pattern, ...rulesets) {
  return (
    rulesets
      .flat()
      .findLast(
        (rule) =>
          Wildcard.match(permission, rule.permission) &&
          Wildcard.match(pattern, rule.pattern),
      ) ?? { action: "ask", permission, pattern: "*" }
  )
}
```

四十秒就读完了——把所有 ruleset 拍平，从后往前找第一个 (permission, pattern) 都命中的规则。**找不到默认 `ask`**（fail-safe：未声明的事项要问用户）。这个函数在 `permission/index.ts:138-140` 被重新导出，名字也叫 `evaluate`。

**零件 C：有状态的 Service `Permission.ask`（`permission/index.ts:171-211`）**——核心逻辑是这样的：遍历 `request.patterns`，每个 pattern 都 `evaluate(permission, pattern, ruleset, approved)`：任一返回 `deny` 立即 `return yield* new DeniedError({ruleset: <相关子集>})`；全部 `allow` 则函数直接 return；只要有一个 `ask` 就置 `needsAsk = true`、走 ask 路径——`Deferred.make()` + `pending.set(id, {info, deferred})` + `bus.publish(Event.Asked, info)`，最后 `Deferred.await(deferred)` 把当前 fiber 挂起，等 reply 释放。

几个关键设计：

- **Patterns 是数组**：bash 工具会传 `patterns: ["git", "git status"]`，任一 deny 就 deny、全 allow 才 allow——让"命令前缀逐级匹配"成为可能（`permission/arity.ts:1-9` 的 `BashArity.prefix` 把 `git push --force-with-lease` 切成 `["git", "git push"]`）。
- **`deny` 抛 typed error**：`DeniedError` 把命中的 ruleset 子集挂上去，回灌给模型时能看到为什么被拒、改写策略。
- **`ask` 走 `Deferred`**：fiber 挂起、bus 广播给所有 client（TUI / CLI run / Web UI）、它们各自渲染 prompt、最后通过 HTTP `POST /permission/:id/reply` 调到 `Permission.reply(...)`（`permission/index.ts:213-269`）。
- **`always` 累积进 `approved`**（`:247-253`）：转成一条 `{action: "allow"}` 规则加进 in-memory 列表，同时持久化到 SQLite `PermissionTable`（`:148-156` 启动时从这里读回）。
- **session 关闭 finalizer**（`:158-165`）：把所有 pending ask reject 掉，避免 tool 调用永远卡住。

**ruleset 怎么合出来**？看 `session/tools.ts:64-72` 的 `ctx.ask` 闭包：

```ts
ask: (req) =>
  permission.ask({
    ...req,
    sessionID: input.session.id,
    tool: { messageID: input.processor.message.id, callID: options.toolCallId },
    ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
  }),
```

`Permission.merge(agentRuleset, sessionRuleset)` 在 `permission/index.ts:302-304` 就是 `rulesets.flat()`——把 agent 默认规则放前面、session 自定义规则放后面（后者覆盖前者）。`agent.permission` 怎么来的：`agent/agent.ts:106-125` 先建 `defaults`（含 `read: {"*": "allow", "*.env": "ask", ...}` 等），然后每种 agent 在 `:130-202` 用 `Permission.merge(defaults, perAgentConfig, userConfig)` 叠加。所以**最终顺序**是：

```
内置 defaults  →  per-agent rules  →  user config (opencode.json) → session-specific
            （越靠后越优先；evaluate 用 findLast）
```

approved（运行时累积的 always 规则）在 `permission.ask` 内部跟 ruleset 一起平铺给 `evaluate`，相当于追加在最末。

**回到本 trace**：`read README.md` 触发的 `Permission.ask` 入参——`permission: "read"`、`patterns: ["README.md"]`（`path.relative(worktree, filepath)`）、`ruleset` 是 `build` agent 合并出来的那一长串规则（核心几条：`{*: *: allow}`、`{read: *: allow}`、`{read: *.env: ask}`、`{read: *.env.*: ask}`、`{read: *.env.example: allow}`，外加 `external_directory` 白名单和几条 `deny`）。

`evaluate("read", "README.md", ruleset, approved)` 从后往前找：`*.env.example` / `*.env.*` / `*.env` 都不匹配 `README.md`；`{permission: "read", pattern: "*", action: "allow"}` 匹配。返回 `allow`。`needsAsk` 保持 false，`ask` 函数早期返回。

控制权回到 `ReadTool.execute`，下一步就是真的去 `fs.readFile`（trace 第 11 步）。

如果换成 `read .env`：`evaluate` 从后往前找到 `{permission: "read", pattern: "*.env", action: "ask"}`——`needsAsk = true`，`ask` 进入 `Deferred` 等待路径，`bus.publish(Event.Asked, ...)`，`opencode run` 命令的订阅者（在 `cli/cmd/run/permission.shared.ts`，本 trace 的入口订阅了这个事件）渲染 prompt，用户答完后 `Permission.reply({requestID, reply: "once"|"always"|"reject"})` 把 `Deferred` 释放。

## 6. 代码位置

按读源码的顺序：

- `packages/opencode/src/session/tools.ts:64-72` —— `ctx.ask` 闭包：本步骤的入口；`Permission.merge(input.agent.permission, input.session.permission ?? [])` 那一行合并 ruleset。
- `packages/opencode/src/tool/read.ts:227-232` —— ReadTool 内的 `ctx.ask({permission: "read", patterns: [path.relative(...)], always: ["*"]})`。
- `packages/opencode/src/permission/index.ts:19-30` —— `Action` / `Rule` / `Ruleset` schema。
- `packages/opencode/src/permission/index.ts:36-50` —— `Request`：广播到 client 的 payload。
- `packages/opencode/src/permission/index.ts:69-79` —— Bus events：`Event.Asked` / `Event.Replied`。
- `packages/opencode/src/permission/index.ts:81-101` —— 三种 typed error：`RejectedError` / `CorrectedError`（reject 带 message）/ `DeniedError`（命中 deny 规则）。
- `packages/opencode/src/permission/index.ts:138-140` —— `evaluate` 的 re-export。
- `packages/opencode/src/permission/index.ts:171-211` —— `ask` 实现：`:171-187` 快路径（全 allow / 任一 deny 立即返回），`:190-211` ask 路径（写 pending、bus publish、`Deferred.await`、finalizer）。
- `packages/opencode/src/permission/index.ts:213-269` —— `reply`：`once` / `always` / `reject` 三个分支；`always` 把规则推进 `approved`。
- `packages/opencode/src/permission/index.ts:288-308` —— `fromConfig` / `merge` / `disabled`：用户 config 转 Rule[]、拍平 rulesets、算"全 deny 的工具集"用于 system prompt 屏蔽。
- `packages/core/src/permission.ts:21-31` —— `evaluate`：本步骤灵魂，10 行 findLast。
- `packages/opencode/src/permission/arity.ts:1-9` —— `BashArity.prefix`：bash 工具的命令前缀切分（patterns 数组语义的典型用例）。
- `packages/opencode/src/config/permission.ts:1-58` —— 用户配置文件解析 schema：`"read": "allow"` shorthand 自动展开成 `{"*": "allow"}`。
- `packages/opencode/src/agent/agent.ts:106-125` —— 默认 ruleset `defaults` 的真容（含 `read: {"*": "allow", "*.env": "ask", ...}`）。
- `packages/opencode/src/agent/agent.ts:130-202` —— `build` / `plan` / `general` / `explore` 各自如何 `merge(defaults, per-agent, user)` 出 final ruleset。
- `packages/opencode/src/agent/subagent-permissions.ts:17-34` —— `deriveSubagentSessionPermission`：plan-mode 的 edit deny 怎么传到 subagent。
- `packages/opencode/src/server/routes/instance/httpapi/handlers/permission.ts:8-41` —— HTTP 端点：`GET /permission` 列出 pending、`POST /permission/:requestID/reply` 走 `Permission.reply(...)`；CLI run / TUI / Web 共用。

## 7. 分支与延伸

- **Rule schema / Ruleset / `Permission.evaluate`**：见 [第 08 章 §规则 schema](08-permissions.md#83-规则-schemarule--ruleset--action) / [§Ruleset 评估](08-permissions.md#84-ruleset-评估permissionevaluate)。
- **询问用户的全过程：bus + reply**：见 [第 08 章 §`Permission.ask`：从工具到询问的全流程](08-permissions.md#85-permissionask从工具到询问的全流程) 和 [§用户回应：`Permission.reply`](08-permissions.md#86-用户回应permissionreply)。
- **持久化 always**：见 [第 08 章 §持久化 always](08-permissions.md#87-持久化-always内存--sqlite)。
- **subagent 权限继承**：见 [第 04 章 §Subagent permissions](04-agents.md#agent-数据结构) + `subagent-permissions.ts:17-34`。
- **`disabled` 与 system prompt**：被通配 deny 的工具压根不会出现在送给 LLM 的工具表里（trace 第 06 步装配 tool 列表时就已经过滤过）；详见 [第 07 章 §按 agent / model 过滤](07-tool-system.md#723-按-agent--model-过滤)。
- **bash 的命令前缀匹配**：bash 工具用 `BashArity.prefix(["git", "push", "origin", "main", "--force"])` 切出 `["git", "git push"]`，再两条都喂给 `permission.ask({permission: "bash", patterns: [...]})`——任一 deny 就 deny。这是 patterns 数组设计的最大受益者。

## 8. 走完这一步你脑子里应该多了什么

1. **opencode 的权限是一棵小型 DSL**：`{permission, pattern, action}` 三字段、`evaluate` 是 10 行的 findLast、`ask` 用 Deferred 阻塞——所有复杂度从这个最小核长出来。
2. **`evaluate` 的"找不到就 ask"是 fail-safe 默认**：忘记声明一个权限 = 触发用户询问，而不是默认放行。这种保守默认是 LLM agent 工具系统的关键安全属性。
3. **ruleset 是有序数组、`findLast` 取胜——所以合并顺序定优先级**：defaults → per-agent → user config → session → approved。越靠后越权威。
4. **`ask` 是异步阻塞，用 `Deferred` + Bus event**：tool fiber 挂起、bus 广播给所有 client、HTTP `POST /permission/:id/reply` 答复后 Deferred 释放——CLI / TUI / Web UI 三种 client 共用这一条机制，互不感知彼此。
5. **`always` 不只是 in-memory**：会持久化到 SQLite `PermissionTable`，重启 opencode 后仍然记得用户上次说的"always allow"。
6. **patterns 是数组，不是单个**：bash 走前缀分级匹配；read/edit/glob 等只传一个 pattern。同一个 API 兼容两种语义。
7. **走完这一步**：`Permission.ask` 因为命中 `{permission: "read", pattern: "*", action: "allow"}` 直接返回，控制权回到 `ReadTool.execute`。下一步真的去敲文件——`fs.stream(filepath)`。

下一步：[Trace 步骤 11 —— 执行 `read("README.md")`](tour-11-read-execute.md)
