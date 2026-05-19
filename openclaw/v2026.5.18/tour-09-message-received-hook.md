# Tour 09：message_received 钩子

## 1. 当前情境

上一步（tour-08）结束时，会话已经就绪。我们在 `dispatchReplyFromConfig()` 内部，手上有：

- 一个 `FinalizedMsgContext`，带着消息正文「你好」、`SessionKey`、`Provider` 等字段。
- 一个明确的 agent id（`main`）、它的 agent 配置、以及定位到的 `SessionEntry`（这条新会话此刻还是 `undefined`，但 sessionKey 已确定）。

`dispatchReplyFromConfig()` 在解析完会话之后、把消息真正交给 agent 之前，还有一段「前处理」要走。这一步聚焦其中一环：当系统已经知道「这是一条来自 WebChat 的用户消息、属于哪个会话」之后、在它正式进入回复流程之前，先给**插件**一次介入的机会——这就是 `message_received` 钩子。

## 2. 问题

> 一条入站用户消息，在它正式进入 agent 回复流程之前，如何让第三方插件（以及 OpenClaw 自带的内置钩子）观察到它、并有能力做记录、旁路、甚至改写——而且不能因为某个插件写得烂就把整条主流程拖崩或拖慢？

## 3. 朴素思路

要让插件能「在消息进 agent 前插一脚」，最直接的做法：

1. 在 `dispatchReplyFromConfig` 里，遍历所有已加载的插件。
2. 对每个插件，如果它导出了一个 `onMessageReceived` 函数，就 `await` 调用它，把消息上下文传进去。
3. 插件可以在这个函数里随便干什么——记日志、查数据库、改消息、发请求。
4. 全部 `await` 完了，再继续往下走 agent 回复。

直接、好理解，插件作者也好写。

## 4. 为什么朴素思路会崩

这个朴素思路在 OpenClaw 这种「插件来自插件市场、质量参差」的环境里会以几种具体方式崩掉：

- **一个插件抛异常，整条对话挂掉。** 朴素思路里插件函数直接在主流程里 `await`。某个第三方插件的 `onMessageReceived` 因为一个空指针抛了异常，这个异常会冒泡穿过 `dispatchReplyFromConfig`，结果是用户发的「你好」永远收不到回复——一个无关紧要的日志插件，搞瘫了核心功能。
- **一个慢插件，拖慢每一条消息。** 某插件在 `onMessageReceived` 里同步去调一个外部 API，那个 API 这次响应要 8 秒。因为主流程 `await` 它，用户这条「你好」就要白等 8 秒才看到「正在输入」。一个纯观察性质的钩子，不该有能力卡住主流程。
- **「记录」和「改写」被混为一谈。** 有的钩子只是想看一眼消息（记日志、更新统计），有的钩子想真的改消息内容或拦截它（垃圾过滤、敏感词替换）。朴素思路里两类钩子用同一个签名、同一种调用方式，于是「只想看一眼」的钩子也必须被 `await`，「想拦截」的钩子又没有清晰的契约说明「返回什么表示拦截」。
- **没有插件就白付出遍历成本。** 朴素思路每条消息都遍历全部插件、逐个检查有没有 `onMessageReceived`。绝大多数部署根本没装会用这个钩子的插件，这个遍历是纯浪费。
- **插件钩子和 core 自己的钩子各搞一套。** OpenClaw 自身也有「消息收到时要做的事」（比如会话记忆、命令日志）。如果 core 自己硬编码这些逻辑、插件又走另一套机制，同一个生命周期点就有两套不一致的代码。

核心矛盾：`message_received` 是一个**观察/旁路**性质的扩展点，它的价值在于「让插件参与」，但它绝不能因此获得「拖垮主流程」的能力。朴素思路把扩展点和主流程的可靠性、性能死死绑在一起。

## 5. OpenClaw 的做法

**先把问题摆清楚**：`message_received` 要满足三个互相拉扯的诉求——可扩展（插件能参与）、可靠（坏插件不能拖垮主流程）、高效（没插件不付成本）。OpenClaw 的做法是把钩子收敛到一个**全局单例的 `HookRunner`**，并对 `message_received` 这类观察型钩子采用 **fire-and-forget（触发后不等待）** 的执行方式。

**钩子运行器是全局单例。** 钩子的执行由 `HookRunner` 负责，由 `createHookRunner()` 创建，并在插件加载完成后由 `initializeGlobalHookRunner()` 注册成一个进程级单例。代码库任何地方都能 `getGlobalHookRunner()` 拿到它，不必层层传参。`dispatchReplyFromConfig` 就是这么取的。

**先问「有没有钩子」再付成本。** `HookRunner` 暴露一个 `hasHooks(hookName)`。`dispatchReplyFromConfig` 触发 `message_received` 之前先 `if (hookRunner?.hasHooks("message_received"))`——没有任何插件注册这个钩子时，整段直接跳过，零成本。这回答了朴素思路「没插件也白遍历」的问题。

**fire-and-forget：触发但不等待。** 这是关键的一招。`message_received` 不是用 `await` 接进主流程的，而是包在 `fireAndForgetHook(...)` 里：

```
if (hookRunner?.hasHooks("message_received")) {
  fireAndForgetHook(
    hookRunner.runMessageReceived(
      toPluginMessageReceivedEvent(hookContext),
      toPluginMessageContext(hookContext),
    ),
    "dispatch-from-config: message_received plugin hook failed",
  );
}
```

`fireAndForgetHook` 接过钩子返回的 Promise，但**不**让主流程等它。主流程触发完钩子就立刻往下走，不会因为某个慢插件而停顿——堵上了朴素思路「慢插件拖慢每条消息」的洞。`fireAndForgetHook` 同时挂了一个 `.catch`，把钩子里抛出的异常就地吞掉、记成一行日志（第二个参数就是日志前缀），异常永远不会冒泡回主流程——堵上了「坏插件搞瘫对话」的洞。

**catchErrors 是第二道防线。** `HookRunner` 创建时带 `catchErrors: true`：即便在 fire-and-forget 之外，单个插件钩子抛异常也会被 runner 接住，不会波及同一钩子点上的其他插件。

**插件钩子与内部钩子并行触发。** 触发完面向插件的 `message_received` 之后，`dispatchReplyFromConfig` 紧接着还会桥接一个**内部钩子**——通过 `triggerInternalHook` + `createInternalHookEvent("message", "received", sessionKey, ...)` 触发 core 自己基于 `HOOK.md` 的发现式钩子系统（会话记忆、命令日志这类 core 自带的处理器就挂在这里）。它同样走 `fireAndForgetHook`。这意味着 core 不为自己的「消息收到时要做的事」另造一套机制，而是和插件吃同一套钩子基础设施。

**「观察」与「拦截/改写」分别由不同钩子承担。** `message_received` 在这条路径上是**纯观察型**——fire-and-forget 决定了它无法阻止消息进入 agent，也无法改写发给模型的内容。真正能拦截、改写的扩展点是另一些钩子：`inbound_claim`（决定「这条入站消息归谁处理」）在更早的环节运行；`before_dispatch`（在模型 dispatch 前让插件检查或接管）和 `message_sending`（在回复发出前改写或取消）在更靠后的环节、且是被 `await` 的。OpenClaw 用「不同钩子、不同执行语义」把朴素思路里混在一起的「看一眼」和「动手改」拆开了——观察型走 fire-and-forget 不阻塞，安全门型才同步等待。

对我们这条 WebChat「你好」：如果当前部署没装用 `message_received` 的插件，`hasHooks` 返回 `false`，整段跳过；如果装了，钩子被 fire-and-forget 触发，主流程**不等它**就继续。无论哪种情况，「你好」都会顺畅地往下进入回复流程。

## 6. 代码位置

- `src/auto-reply/reply/dispatch-from-config.ts:541` — `getGlobalHookRunner()`，取全局钩子运行器单例。
- `src/auto-reply/reply/dispatch-from-config.ts:548` — `deriveInboundMessageHookContext(ctx, ...)`，从入站上下文派生钩子上下文 `hookContext`。
- `src/auto-reply/reply/dispatch-from-config.ts:971` — `hookRunner?.hasHooks("message_received")`，先判断有没有钩子再付成本。
- `src/auto-reply/reply/dispatch-from-config.ts:972` — `fireAndForgetHook(hookRunner.runMessageReceived(...))`，fire-and-forget 触发面向插件的 `message_received`。
- `src/auto-reply/reply/dispatch-from-config.ts:982` — `triggerInternalHook(createInternalHookEvent("message", "received", sessionKey, ...))`，桥接 core 的内部钩子系统。
- `src/plugins/hooks.ts:995` — `runMessageReceived`，`HookRunner` 上 `message_received` 的执行实现。
- `src/plugins/hooks.ts:1472` — `hasHooks`，按钩子名判断是否有插件注册。
- `src/plugins/hook-runner-global.ts:32` — `initializeGlobalHookRunner`，插件加载完成后注册全局单例。
- `src/plugins/hook-types.ts:68` — `PluginHookName`，全部钩子事件名的联合类型（含 `message_received`）。
- `src/hooks/fire-and-forget.ts` — `fireAndForgetHook`，触发后不等待、就地吞掉异常并记日志。
- `src/hooks/message-hook-mappers.ts` — `toPluginMessageReceivedEvent` / `toPluginMessageContext`，把内部上下文映射成插件可见的事件/上下文形态。

## 7. 分支与延伸

我们这条 trace 走的是「`message_received` 纯观察、fire-and-forget、消息确认进入回复流程」。这一步附近的岔路：

- **`inbound_claim` 钩子**：在更早的环节决定「这条入站消息归哪个 agent / 处理者所有」。`thread-ownership` 插件靠它实现「一个对话线程归一个 agent」。
- **`before_dispatch` 钩子**：在模型 dispatch 之前同步运行，插件可以检查甚至接管——它**会**被 `await`，因为它有阻断能力。
- **`message_sending` 钩子**：在回复真正发出前运行，能改写回复文本或整条取消（返回 `cancel`）——tour-10 之后的投递路径会用到它。
- **fail-closed 钩子**：`before_agent_run`、`before_tool_call` 这类「安全门」钩子的失败策略是 fail-closed——钩子失败时默认**拦截**而非放行。`message_received` 则是 fail-open（失败就跳过）。
- **内置钩子**：`src/hooks/bundled/` 下的 `session-memory`、`command-logger`、`compaction-notifier` 等是 core 用钩子机制实现自身功能的例子。
- **用户级钩子**：用户可以在配置目录里写带 frontmatter 的钩子脚本，被加载进同一套 `HookRunner`。

想系统理解钩子机制——36 个生命周期事件、`HookRunner` 的 `catchErrors` 与 `failurePolicyByHook`、同步钩子与 fire-and-forget 钩子的区别、内置钩子与用户钩子，去读 [第 10 章](10-plugin-system.md)。想了解回复发出前的 `message_sending` 钩子如何改写/取消回复，去读 [第 11 章](11-delivery-and-events.md)。

## 8. 走完这一步你脑子里应该多了什么

- **`message_received` 是一个观察型扩展点。** 它让插件「看到」入站消息，但在这条路径上它走 fire-and-forget，**不能**阻止消息进入 agent，也不能改写发给模型的内容——拦截/改写是 `inbound_claim`、`before_dispatch`、`message_sending` 这些钩子的职责。
- **fire-and-forget 是可靠性的关键。** 钩子被触发但主流程不 `await` 它，慢插件拖不慢主流程；钩子抛的异常被就地 `.catch` 吞掉并记日志，坏插件搞不瘫对话。
- **先 `hasHooks` 再付成本。** 没有插件注册某钩子时整段直接跳过，没插件的部署零开销。
- **钩子运行器是进程级全局单例。** `getGlobalHookRunner()` 在代码库任何地方都能拿到同一个 `HookRunner`，无需层层传参。
- **core 和插件共用同一套钩子基础设施。** 插件钩子之外，OpenClaw 还桥接一套内部钩子（`triggerInternalHook`），自家的会话记忆、命令日志等功能也走钩子机制——core 吃自己的狗粮。
- 这一步结束时，钩子已经触发完毕（无论是否真有插件），消息**确认进入回复流程**——下一步，`ReplyDispatcher` 会被创建，准备好接管回复的投递、排队、重试与打字指示器。
