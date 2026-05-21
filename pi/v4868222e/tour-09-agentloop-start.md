# Tour 步骤 09:进入 agentLoop → 调 streamSimple

> 代码版本锁定:earendil-works/pi@4868222e(2026-05-20)。本步骤所有 `file:line` 引用均基于该 commit。

**上一步终态**:`AgentContext` 完整(systemPrompt、messages、tools),`AbortController` 已绑定到 `harness.runAbortController`,`runAgentLoop()` 已被调用,栈帧建立。

**下一步起点**:控制流进入 anthropic provider 的 `streamAnthropic()` 内部,messages 还未翻译成 Anthropic API 格式,HTTP 请求尚未发出。

---

## 1. 当前情境

`runAgentLoop()` 在 `packages/agent/src/agent-loop.ts:95` 被调用。此时调用栈如下:

```
AgentHarness.executeTurn()          agent-harness.ts:560
  └─ runAgentLoop(prompts, context, config, emit, signal, streamFn)
       agent-loop.ts:95
```

进程状态:

- `prompts` = `[UserMessage("读一下 README.md 的第一行")]`,已在 step-07 由 `createUserMessage()` 构造。
- `context.messages` = 历史消息浅拷贝 + prompts 待合并。
- `context.tools` = activeTools 数组(7 个内置工具)。
- `emit` = harness 的 `handleAgentEvent` 包装。
- `streamFn` = `harness.createStreamFn()` 返回的闭包。
- `signal` = `AbortController.signal`,尚未触发。

---

## 2. 问题

本步需要回答两个相关问题:

1. **agentLoop 在把控制权交给 provider 之前做了什么准备工作**?loop 本身的职责不是做 HTTP,它需要先处理消息合并、事件发射、上下文变换,再才触发 stream。

2. **`streamSimple(model, context, options)` 是如何找到 anthropic provider 的**?ai 层有多个 provider(anthropic、openai、google……),`streamSimple` 必须通过 api-registry 动态路由,而不是硬编码。

---

## 3. 朴素思路

最直接的做法:在 `agentLoop` 内直接 `import { streamAnthropic }` 并调用,无需注册表。

---

## 4. 为什么朴素思路会崩

**provider 不可硬编码**:同一个 agentLoop 可能被用于 Anthropic、Google、OpenAI 等不同 provider。硬编码 import 意味着每次切换 provider 需要修改 loop 代码。

**循环 import 问题**:如果 `agent-loop.ts` 直接 import `anthropic.ts`,而 anthropic.ts 依赖 `types.ts`,types.ts 又被 agent-loop.ts 引用,就会形成循环依赖。通过 `streamFn` 参数注入打破了这个循环。

**副作用隔离**:每个 provider 模块有 side-effect(SDK 初始化、axios 拦截器等)。懒加载注册表(`register-builtins.ts`)让这些副作用只在第一次使用时发生,测试环境可以注入 mock provider 而不 import 任何真实 SDK。

**`streamFn` 注入点**:`runAgentLoop` 接受可选的 `streamFn` 参数(`agent-loop.ts:101`)。harness 传入的 `streamFn` 是 `createStreamFn()` 的返回值,它在调用 `streamSimple` 之前先执行认证 token 刷新(`getApiKeyAndHeaders`)和 `before_provider_request` hook,这些逻辑不属于 loop 自身关心的范畴。

---

## 5. pi 的做法

**第一阶段:runAgentLoop 初始化(`agent-loop.ts:95-117`)**

```typescript
export async function runAgentLoop(
    prompts: AgentMessage[],
    context: AgentContext,
    config: AgentLoopConfig,
    emit: AgentEventSink,
    signal?: AbortSignal,
    streamFn?: StreamFn,
): Promise<AgentMessage[]> {
    const newMessages: AgentMessage[] = [...prompts];
    const currentContext: AgentContext = {
        ...context,
        messages: [...context.messages, ...prompts],  // 合并历史+prompt
    };

    await emit({ type: "agent_start" });       // 发射生命周期事件
    await emit({ type: "turn_start" });
    for (const prompt of prompts) {            // 每个 prompt 发 start+end
        await emit({ type: "message_start", message: prompt });
        await emit({ type: "message_end", message: prompt });
    }

    await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
    return newMessages;
}
```

注意 `await emit()` 是串行的——每个事件都等待 harness 的 `handleAgentEvent` 处理完毕才继续。harness 在 `message_end` 时通过 `session.appendMessage()` 持久化 UserMessage,这个写入在这里完成。

**第二阶段:runLoop 外层循环与 streaming 前准备(`agent-loop.ts:155-193`)**

```typescript
async function runLoop(initialContext, newMessages, initialConfig, signal, emit, streamFn) {
    let currentContext = initialContext;
    let config = initialConfig;
    let firstTurn = true;
    let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

    while (true) {          // 外层:有 follow-up 就继续
        let hasMoreToolCalls = true;
        while (hasMoreToolCalls || pendingMessages.length > 0) {   // 内层:有工具调用就继续
            if (!firstTurn) {
                await emit({ type: "turn_start" });
            } else {
                firstTurn = false;
            }
            // 注入 pending steering messages...
            const message = await streamAssistantResponse(
                currentContext, config, signal, emit, streamFn
            );
            // ...处理工具调用、turn_end
        }
        // 检查 follow-up messages...
    }
    await emit({ type: "agent_end", messages: newMessages });
}
```

第一次进入 inner loop 时,`firstTurn = true`,因此不重复发射 `turn_start`(已在 `runAgentLoop` 发过)。`getSteeringMessages` 检查用户是否在模型响应之前已经排队了新消息(极罕见,本 trace 为空)。

**第三阶段:streamAssistantResponse 的上下文变换(`agent-loop.ts:275-308`)**

```typescript
async function streamAssistantResponse(context, config, signal, emit, streamFn) {
    // 1. transformContext hook(可做 compaction、token 估算)
    let messages = context.messages;
    if (config.transformContext) {
        messages = await config.transformContext(messages, signal);
    }

    // 2. convertToLlm:AgentMessage[] -> Message[]
    const llmMessages = await config.convertToLlm(messages);

    // 3. 拼装 LLM context
    const llmContext: Context = {
        systemPrompt: context.systemPrompt,
        messages: llmMessages,
        tools: context.tools,
    };

    // 4. 使用 streamFn 或 fallback 到 streamSimple
    const streamFunction = streamFn || streamSimple;

    // 5. 解析 apiKey(支持 OAuth 短期 token)
    const resolvedApiKey =
        (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

    const response = await streamFunction(config.model, llmContext, {
        ...config,
        apiKey: resolvedApiKey,
        signal,
    });
    // ...事件循环
}
```

`convertToLlm`(`packages/agent/src/harness/messages.ts:120`) 把 `AgentMessage[]` 展平为 `Message[]`:bashExecution 消息转为 user 消息、compactionSummary 包装进 `<summary>` 标签、branchSummary 同样包装——这些是 harness 特有的消息类型,LLM 不认识,需要在这里翻译。

**第四阶段:streamFn 闭包执行与 streamSimple 路由(`agent-harness.ts:358-388`)**

harness 传入的 `streamFn` 在被 `streamAssistantResponse` 调用时执行:

```typescript
// packages/agent/src/harness/agent-harness.ts:358-388
private createStreamFn(getTurnState): StreamFn {
    return async (model, context, streamOptions) => {
        const turnState = getTurnState();
        const auth = await this.getApiKeyAndHeaders?.(model);  // OAuth token 刷新
        const snapshotOptions = {
            ...turnState.streamOptions,
            headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
        };
        const requestOptions = await this.emitBeforeProviderRequest(
            model, turnState.sessionId, snapshotOptions
        );
        return streamSimple(model, context, {
            cacheRetention: requestOptions.cacheRetention,
            headers: requestOptions.headers,
            // ...其他选项
            signal: streamOptions?.signal,
            sessionId: turnState.sessionId,
            apiKey: auth?.apiKey,
        });
    };
}
```

`streamSimple` 在 `packages/ai/src/stream.ts:43-50`:

```typescript
export function streamSimple<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
): AssistantMessageEventStream {
    const provider = resolveApiProvider(model.api);   // 查注册表
    return provider.streamSimple(model, context, options);
}
```

`resolveApiProvider(model.api)` 调用 `getApiProvider(api)`(`packages/ai/src/api-registry.ts:80`):

```typescript
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
    return apiProviderRegistry.get(api)?.provider;
}
```

`apiProviderRegistry` 是模块级 `Map<string, RegisteredApiProvider>`(`api-registry.ts:40`)。`stream.ts:1` 的 `import "./providers/register-builtins.ts"` 在模块加载时即执行 `registerBuiltInApiProviders()`(`register-builtins.ts:406`),把所有 provider 注册进去。对于 `model.api = "anthropic-messages"`,注册表命中 `streamSimpleAnthropic`(懒加载包装器)。

**懒加载路径(`register-builtins.ts:183-204`)**:

`streamSimpleAnthropic` 是 `createLazySimpleStream(loadAnthropicProviderModule)` 的返回值。第一次调用时,`loadAnthropicProviderModule()` 执行 `import("./anthropic.ts")`,动态加载 anthropic 模块并提取 `streamSimpleAnthropic` 函数。后续调用复用已加载的 Promise(`anthropicProviderModulePromise ||=`)。被调用后返回一个 `AssistantMessageEventStream`,内部异步地把模块加载结果 forward 到外部 stream。

**AbortSignal 串联**:

```
AbortController (harness)
    |
    +-- signal -> runAgentLoop (signal 参数)
    |                |
    |                +-> streamAssistantResponse (signal)
    |                        |
    |                        +-> streamFn(model, context, { signal })
    |                                |
    |                                +-> streamSimple(model, context, { signal })
    |                                        |
    |                                        +-> anthropic provider -> HTTP AbortSignal
```

任意一处的 `signal.aborted` 检查都指向同一个 `AbortController`,保证 `harness.abort()` 可以及时终止 HTTP 请求。

---

## 6. 代码位置

| 文件 | 行号 | 内容 |
|------|------|------|
| `packages/agent/src/agent-loop.ts` | 95-117 | `runAgentLoop()`:合并 prompts、发射初始事件 |
| `packages/agent/src/agent-loop.ts` | 155-268 | `runLoop()`:外层 while + 内层 while,第一次进入 `streamAssistantResponse` |
| `packages/agent/src/agent-loop.ts` | 275-308 | `streamAssistantResponse()`:transformContext、convertToLlm、streamFn 调用 |
| `packages/agent/src/harness/agent-harness.ts` | 358-388 | `createStreamFn()`:认证刷新、before_provider_request hook、调用 `streamSimple` |
| `packages/ai/src/stream.ts` | 43-50 | `streamSimple()`:查注册表,委托给 provider |
| `packages/ai/src/api-registry.ts` | 40 | `apiProviderRegistry`:模块级 Map |
| `packages/ai/src/api-registry.ts` | 80-82 | `getApiProvider()`:注册表查询 |
| `packages/ai/src/providers/register-builtins.ts` | 183-204 | `createLazySimpleStream()`:懒加载包装器工厂 |
| `packages/ai/src/providers/register-builtins.ts` | 206-217 | `loadAnthropicProviderModule()`:动态 import anthropic.ts |
| `packages/ai/src/providers/register-builtins.ts` | 345-399 | `registerBuiltInApiProviders()`:注册全部内置 provider |
| `packages/ai/src/providers/register-builtins.ts` | 406 | 模块顶层立即调用 `registerBuiltInApiProviders()` |

---

## 7. 分支与延伸

- **agentLoop 完整状态机(外层/内层循环的退出条件)**:见 [第 05 章 §4「核心 Loop 状态机」](./05-agent-runtime-loop.md#4-核心-loop-状态机)。

- **AgentLoopConfig 各 hook 的语义与调用时机**:见 [第 05 章 §2.2「AgentLoopConfig 参数语义」](./05-agent-runtime-loop.md#22-agentloopconfig-参数语义)。

- **api-registry 注册表的数据结构与 registerApiProvider 接口**:见 [第 02 章 §2.4「Provider 注册表机制」](./02-ai-layer-providers-registry.md#24-provider-注册表机制)。

- **懒加载注册机制的设计原因**:见 [第 02 章 §2.4.3「register-builtins.ts 的懒加载注册机制」](./02-ai-layer-providers-registry.md#243-register-builtinsts-的懒加载注册机制)。

- **stream() 与 streamSimple() 的语义差异**:见 [第 02 章 §2.2「三个公共入口的语义差异」](./02-ai-layer-providers-registry.md#22-三个公共入口的语义差异)。

---

## 8. 走完这一步你脑子里应该多了什么

1. **agentLoop 的三层结构**:outer while(follow-up)→ inner while(tool calls + steering)→ `streamAssistantResponse`。第一次进入 inner while 时 `firstTurn` 机制跳过重复 `turn_start`。

2. **两次消息转换**:`convertToLlm` 把 AgentMessage 层面的 bashExecution/compactionSummary 等 harness 特有类型转换为 LLM 可理解的 Message[],之后 anthropic provider 内的 `transformMessages` 再做 Anthropic API 格式转换——两层各司其职。

3. **`streamFn` 是 harness 与 loop 的解耦接口**:loop 本身不关心认证、session 头部、before_provider_request hook,这些都封装在 harness 传入的 `streamFn` 闭包里。loop 只负责驱动事件循环,provider 细节对 loop 不可见。

4. **注册表在模块加载时填充**:`stream.ts` 顶部的 `import "./providers/register-builtins.ts"` 是 side-effect import,模块第一次被引入时即执行 `registerBuiltInApiProviders()`。因此当 `getApiProvider("anthropic-messages")` 被调用时,注册表已经有值,不需要任何显式初始化调用。

5. **懒加载不影响注册**:provider 被注册(进 Map)是同步的,但 provider 模块代码的实际执行是懒加载的。第一次 `streamSimpleAnthropic` 被调用时才执行 `import("./anthropic.ts")`。这意味着如果用户只使用 Google provider,anthropic SDK 永远不会被加载进内存。
