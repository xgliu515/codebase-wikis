# 第 09 章　TUI 渲染（终端用户界面）

> 代码版本锁定：`anomalyco/opencode@d74d166ac`（tag `v1.15.10`，2026-05-23）。本章所有 `file:line` 引用均基于该提交。

## 9.1 本章解决的问题

前面 8 章已经把 opencode 的**逻辑层**讲完了：session 怎么存、prompt 怎么生成、provider 怎么调、tool 怎么跑、permission 怎么问、project / workspace 怎么解析。这些全部跑在 server 进程里（第 10 章会讲清楚）。

但用户每天看到的不是 server，而是终端里那个**带边框、能高亮、能弹窗、能折叠工具输出**的 TUI。它需要回答下面这一类问题：

- 终端只是 21×80 个 ANSI cell，怎么把一棵**组件树**画出来、还能局部增量？
- 用户敲 `Tab` 切 agent、`Ctrl+C` 中断、`/` 唤起命令、`@` 提及文件，这套 keymap 怎么注册？
- LLM 流式回复一个 token 一个 token 来，怎么不把整屏重画？
- TUI 关闭后再开一次，session 还在——状态到底存哪儿？
- Windows 终端有一堆坑（`CTRL_C_EVENT`、`ENABLE_PROCESSED_INPUT`、CRLF），怎么屏蔽？

opencode TUI 的答案是：**SolidJS + `@opentui/core`，把终端当成一棵 reactive VDOM，把 session 状态完全留在 server，TUI 进程只做渲染。** 本章拆开这套方案。

整体结构：

<svg viewBox="0 0 760 420" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="TUI process and worker server process split with rendering stack">
  <defs>
    <marker id="ar91" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="40" y="16" width="680" height="248" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="1.5"/>
  <text x="60" y="36" font-size="12" font-weight="700" fill="#ea580c">TUI 进程（主线程）</text>
  <rect x="80" y="50" width="600" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="380" y="68" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">@opentui/solid（SolidJS adapter，render() / signal）</text>
  <text x="380" y="83" text-anchor="middle" font-size="10" fill="#64748b">把 SolidJS 出口接到 CliRenderer</text>
  <path d="M380,90 L380,108" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar91)"/>
  <rect x="80" y="110" width="600" height="34" rx="6" fill="#fff" stroke="#cbd5e1"/>
  <text x="380" y="131" text-anchor="middle" font-size="11.5" fill="currentColor">&lt;box&gt; &lt;text&gt; &lt;scrollbox&gt; &lt;textarea&gt; ...（VDOM 节点）</text>
  <path d="M380,144 L380,162" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar91)"/>
  <rect x="80" y="164" width="600" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="380" y="182" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">@opentui/core（CliRenderer + framebuffer）</text>
  <text x="380" y="197" text-anchor="middle" font-size="10" fill="#64748b">cell 级脏区刷新，60Hz</text>
  <path d="M380,204 L380,222" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar91)"/>
  <rect x="80" y="224" width="600" height="32" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="380" y="244" text-anchor="middle" font-size="11" fill="currentColor">stdout（ANSI 序列、Kitty keyboard protocol、mouse）</text>
  <path d="M180,266 L180,320" stroke="#0d9488" stroke-width="1.4" stroke-dasharray="4,3" marker-end="url(#ar91)"/>
  <text x="120" y="294" font-size="10" fill="#0d9488">SSE / RPC</text>
  <path d="M580,320 L580,266" stroke="#0d9488" stroke-width="1.4" stroke-dasharray="4,3" marker-end="url(#ar91)"/>
  <text x="600" y="294" font-size="10" fill="#0d9488">HTTP 响应</text>
  <rect x="40" y="324" width="680" height="80" rx="8" fill="#ccfbf1" stroke="#0d9488" stroke-width="1.5"/>
  <text x="60" y="346" font-size="12" font-weight="700" fill="#0d9488">server 进程（Bun Worker）</text>
  <rect x="80" y="356" width="600" height="36" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="380" y="378" text-anchor="middle" font-size="12" fill="currentColor">Hono + Effect HttpApi ｜ bus ｜ session ｜ tool ｜ MCP ｜ LSP ...</text>
</svg>
<span class="figure-caption">图 R9.1 ｜ TUI 主进程负责渲染（橙），所有逻辑（青）跑在 Worker 内的 server 进程；两侧通过 in-process fetch + SSE 双向通信。</span>

<details>
<summary>ASCII 原版</summary>

```
┌──────────────── TUI 进程 (Worker thread) ───────────────┐
│                                                          │
│   @opentui/solid  (SolidJS adapter, render() / signal)   │
│         │                                                │
│         ▼                                                │
│   <box> <text> <scrollbox> <textarea> ...                │
│         │                                                │
│         ▼                                                │
│   @opentui/core (CliRenderer, Renderable, framebuffer)   │
│         │                                                │
│         ▼                                                │
│   stdout (ANSI 序列、Kitty keyboard protocol、mouse)     │
└──────────────────────────────────────────────────────────┘
        ▲                            │
        │ SSE / RPC                  │ HTTP
        │                            ▼
┌────────────────────── server 进程 ──────────────────────┐
│  Hono + Effect HttpApi / bus / session / tool / ...     │
└──────────────────────────────────────────────────────────┘
```

</details>

---

## 9.2 为什么不是纯 ANSI 拼字符串

写过早期 CLI TUI 的人对 `\x1b[H\x1b[2J` 之类的逃逸序列不会陌生。最朴素的方案是：状态变了 → 清屏 → 重新打印整屏。问题是：

1. **闪烁**。每帧清屏意味着 60Hz 下整屏 21×80 = 1680 cell 全部重写一遍。
2. **流式不友好**。Assistant message 一个 token 一个 token 进来，每个 token 都要重画整屏，CPU/带宽双爆。
3. **嵌套布局难写**。dialog 浮在 message 上面、message 在 input 上面、toast 在最右上角——纯字符串拼接做不到 z-index、padding、flex。
4. **响应式更新难写**。state → view 这套数据流，每次都得手写 diff。

opencode 的解法是把**前端 reactive 框架**搬到终端：

- **SolidJS 提供 reactivity**——`createSignal` / `createMemo` / `createEffect`，所有派生状态变化时只触发**直接依赖**它的小段代码，没有 VDOM diff、没有 React 全树重渲。
- **`@opentui/core` 提供 cell-level framebuffer**——把终端格子抽象成 `Renderable` 节点树，每帧只把"脏区域"flush 到 stdout，借助 ANSI 的 cursor 移动序列做最小重绘。
- **`@opentui/solid` 把两者粘起来**——SolidJS 的 `render()` 出口指向 `CliRenderer` 而不是 DOM。

这样写组件时和写网页 SolidJS 完全一样：

```tsx
<box flexDirection="column" backgroundColor={theme.background}>
  <text fg={theme.text}>{title()}</text>
  <Show when={loading()}>
    <Spinner />
  </Show>
</box>
```

`<box>` / `<text>` / `<scrollbox>` 这些标签由 `@opentui/core` 注册到 SolidJS 的 JSX 命名空间。整个 TUI 就是一棵这样的树，根挂载在 `packages/opencode/src/cli/cmd/tui/app.tsx:200-263` 的 `render(...)` 调用。

> `@opentui/core` 是 anomalyco 自家的库（仓库别处的 `packages/console/` 还有它的 storybook）。代码版本里它已经被发布到 npm，TUI 进程通过 `@opentui/core` / `@opentui/solid` / `@opentui/keymap` 三个包消费它。

---

## 9.3 TUI 进程 ≠ server 进程

一个特别值得强调的事实：**TUI 不是直接跑 session 逻辑的进程**。打开 `packages/opencode/src/cli/cmd/tui/thread.ts:146-148`：

```ts
const worker = new Worker(file, {
  env,
})
```

也就是说，`opencode` 主进程启动后，会把"逻辑那一半"扔进一个 Bun `Worker` 跑 server，自己留在前台跑 TUI。代码版本里这两半的关系是：

```
opencode 主进程 (TUI 渲染、键盘事件、stdout 控制)
    │
    ├── new Worker("./worker.ts")  ← server 进程 (Hono + Effect)
    │       │
    │       ├── Server.Default()    本地零 socket fetch handler
    │       └── Server.listen(opts) 也可以真起一个 TCP server
    │
    ├── createWorkerFetch(client)   把 SDK 的 fetch() 路由到 worker
    └── createEventSource(client)   把 worker 的 GlobalBus 桥到 TUI
```

`packages/opencode/src/cli/cmd/tui/thread.ts:201-211` 决定走哪条路：

```ts
const transport = external
  ? {
      url: (await client.call("server", network)).url,
      fetch: undefined,
      events: undefined,
    }
  : {
      url: "http://opencode.internal",
      fetch: createWorkerFetch(client),
      events: createEventSource(client),
    }
```

`external = true` 是指用户传了 `--port` / `--hostname` / `--mdns`——他想让外部 client 也连得上，于是 worker 起真正的 TCP server。否则走 in-process fetch：主进程发出 `fetch("http://opencode.internal/session/...")`，被劫持成 RPC 调用 worker 的 `rpc.fetch`（`worker.ts:50-68`），worker 内部直接调 `Server.Default().app.fetch(request)`，不经过 socket。

为什么这么折腾？

1. **逻辑层和渲染层进程隔离**。LSP 进程崩了不会拉垮 TUI；OOM 的 ai-sdk fetch 不会卡住键盘。
2. **同一份代码同时支持 headless 远端**。把 `external` 打开就是 `opencode serve` 模式（见 §10.13），TUI 关掉后 server 继续跑、外部 IDE/web 连进来。
3. **session 状态全在 server**。TUI 进程退出基本无副作用——重新启动 TUI，从 worker 的 db 把消息读回来就行，见 §9.12。

### 9.3.1 `--conditions=browser` 跑 Bun

`packages/opencode/src/cli/cmd/tui/thread.ts` 用 `target()` 选 worker 入口；构建时 `worker.ts` 被打成独立 chunk。注意 worker 里有：

```ts
// worker.ts:17
ensureProcessMetadata("worker")
```

而主进程在 thread.ts:140-144 注入：

```ts
const env = sanitizedProcessEnv({
  [OPENCODE_PROCESS_ROLE]: "worker",
  [OPENCODE_RUN_ID]: ensureRunID(),
})
```

`OPENCODE_PROCESS_ROLE` 是日志和遥测里区分 TUI / worker 的关键标签。

---

## 9.4 app.tsx：根组件与 provider 金字塔

`packages/opencode/src/cli/cmd/tui/app.tsx` 是入口。`tui(input)` 函数（166-265 行）做四件事：

1. **Windows guard**：`win32InstallCtrlCGuard()` / `win32DisableProcessedInput()`（详见 §9.11）。
2. **创建 renderer**：`createCliRenderer(rendererConfig(input.config))`（192 行）。renderer 是 `@opentui/core` 的核心对象，封装 stdout、framebuffer、mouse 跟踪、theme 探测。
3. **创建 keymap**：`createDefaultOpenTuiKeymap(renderer)` + `registerOpencodeKeymap(...)`（197-198 行）。
4. **挂载 SolidJS 组件树**：`render(() => <ErrorBoundary>...</ErrorBoundary>, renderer)`（200-263 行）。

### 9.4.1 Provider 金字塔

挂载时的组件树是一个夸张的洋葱：

<svg viewBox="0 0 760 460" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Provider pyramid wrapping App with 20 SolidJS context layers">
  <defs>
    <marker id="ar93" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">app.tsx:160-182 ｜ Provider 金字塔（从外到内）</text>
  <rect x="20" y="32" width="720" height="22" rx="3" fill="#fef2f2" stroke="#dc2626" stroke-width="1.2"/>
  <text x="32" y="48" font-size="11" font-weight="600" fill="currentColor">ErrorBoundary</text>
  <rect x="40" y="58" width="680" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.1"/>
  <text x="52" y="74" font-size="11" fill="currentColor">OpencodeKeymapProvider ｜ 键位绑定</text>
  <rect x="60" y="84" width="640" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="72" y="100" font-size="11" fill="currentColor">ArgsProvider · ExitProvider · KVProvider · ToastProvider</text>
  <rect x="80" y="110" width="600" height="22" rx="3" fill="#fed7aa" stroke="#ea580c" stroke-width="1.1"/>
  <text x="92" y="126" font-size="11" fill="currentColor">RouteProvider ｜ home / session / plugin 三选一</text>
  <rect x="100" y="136" width="560" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="112" y="152" font-size="11" fill="currentColor">TuiConfigProvider</text>
  <rect x="120" y="162" width="520" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="132" y="178" font-size="11" font-weight="600" fill="currentColor">SDKProvider ｜ HTTP client + SSE 事件源</text>
  <rect x="140" y="188" width="480" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="152" y="204" font-size="11" fill="currentColor">ProjectProvider</text>
  <rect x="160" y="214" width="440" height="22" rx="3" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="172" y="230" font-size="11" font-weight="600" fill="currentColor">SyncProvider ｜ 整应用状态镜像</text>
  <rect x="180" y="240" width="400" height="22" rx="3" fill="#99f6e4" stroke="#0d9488"/>
  <text x="192" y="256" font-size="11" fill="currentColor">SyncProviderV2 ｜ v2 schema 镜像</text>
  <rect x="200" y="266" width="360" height="22" rx="3" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.1"/>
  <text x="212" y="282" font-size="11" fill="currentColor">ThemeProvider</text>
  <rect x="220" y="292" width="320" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="232" y="308" font-size="11" fill="currentColor">LocalProvider · PromptStashProvider</text>
  <rect x="240" y="318" width="280" height="22" rx="3" fill="#fed7aa" stroke="#ea580c"/>
  <text x="252" y="334" font-size="11" fill="currentColor">DialogProvider ｜ modal 栈</text>
  <rect x="260" y="344" width="240" height="22" rx="3" fill="#fff" stroke="#cbd5e1"/>
  <text x="272" y="360" font-size="11" fill="currentColor">Frecency · History · PromptRef · EditorCtx</text>
  <rect x="280" y="372" width="200" height="42" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.6"/>
  <text x="380" y="390" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">&lt;App /&gt;</text>
  <text x="380" y="406" text-anchor="middle" font-size="10" fill="#64748b">真正的根组件</text>
  <text x="380" y="438" text-anchor="middle" font-size="10" fill="#64748b">每层 createContext，向内层注入 hooks ｜ 橙=主路径/青=状态/紫=UI/灰=次要</text>
</svg>
<span class="figure-caption">图 R9.3 ｜ App 被 19 层 Provider 包成洋葱：颜色突出 Keymap / Route / SDK / Sync / Theme / Dialog 等主路径。</span>

<details>
<summary>ASCII 原版</summary>

```tsx
<ErrorBoundary>
  <OpencodeKeymapProvider keymap={keymap}>
    <ArgsProvider>
      <ExitProvider>
        <KVProvider>
          <ToastProvider>
            <RouteProvider>
              <TuiConfigProvider>
                <SDKProvider url={input.url} fetch={...} events={...}>
                  <ProjectProvider>
                    <SyncProvider>
                      <SyncProviderV2>
                        <ThemeProvider mode={mode}>
                          <LocalProvider>
                            <PromptStashProvider>
                              <DialogProvider>
                                <FrecencyProvider>
                                  <PromptHistoryProvider>
                                    <PromptRefProvider>
                                      <EditorContextProvider>
                                        <App onSnapshot={...} />
```

</details>

每一层都是 SolidJS 的 `createContext`，对应 `packages/opencode/src/cli/cmd/tui/context/` 下的一个文件。这种"全部用 Provider"的风格在前端不算稀奇，但放到 TUI 里读着有点劝退——好处是测试 / mock 友好（每个 provider 可单独注入）、状态边界清晰。

几个最关键的 provider：

| Provider | 文件 | 提供什么 |
| --- | --- | --- |
| `SDKProvider` | `context/sdk.tsx` | `@opencode-ai/sdk/v2` client + SSE 事件源 |
| `SyncProvider` | `context/sync.tsx` | 整个应用的状态镜像（session/message/part/...) |
| `SyncProviderV2` | `context/sync-v2.tsx` | v2 schema 下的状态镜像（迁移中） |
| `ProjectProvider` | `context/project.tsx` | 当前 project / workspace 的元数据 |
| `LocalProvider` | `context/local.tsx` | 用户偏好（当前 model / agent / variant） |
| `ThemeProvider` | `context/theme.tsx` | 主题、配色、syntax 高亮表 |
| `DialogProvider` | `ui/dialog.tsx` | 弹窗栈（modal） |
| `ToastProvider` | `ui/toast.tsx` | 单个 toast 槽位 |
| `RouteProvider` | `context/route.tsx` | "页面"路由（home / session / plugin） |
| `KVProvider` | `context/kv.tsx` | 用户级 KV 配置（持久化到 disk） |
| `OpencodeKeymapProvider` | `keymap.tsx` (re-export) | `@opentui/keymap` 实例 |

`App` 组件（267 行起）从这些 provider 拿到 hooks，然后绘制根 box。

### 9.4.2 App 的整体布局

`app.tsx:942-980` 是真正出现在屏幕上的那个 box：

```tsx
<box width={dimensions().width} height={dimensions().height} flexDirection="column">
  <Show when={ready()}>
    <box flexGrow={1} minHeight={0} flexDirection="column">
      <Switch>
        <Match when={route.data.type === "home"}><Home /></Match>
        <Match when={route.data.type === "session"}><Session /></Match>
      </Switch>
      {plugin()}
    </box>
    <box flexShrink={0}>
      <TuiPluginRuntime.Slot name="app_bottom" />
    </box>
    <TuiPluginRuntime.Slot name="app" />
  </Show>
  <StartupLoading ready={ready} />
</box>
```

可见 TUI 有两种"页面"：`home`（欢迎页 + prompt）、`session`（消息流 + prompt）；外加 plugin 路由（运行时插件可以提供整页）。`StartupLoading` 是首屏加载动画，`ready()` 翻成 true 后退场。

`<TuiPluginRuntime.Slot>` 是插件可注入 UI 的"插槽"：home 页有 `home_logo` / `home_prompt` / `home_prompt_right` / `home_bottom` / `home_footer`；app 级有 `app_bottom` / `app`。

---

## 9.5 事件订阅：bus → TUI

TUI 几乎所有动态行为都来自 server 推过来的事件流。链路是这样的：

<svg viewBox="0 0 640 540" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="Event flow from server bus through worker RPC into TUI SolidJS store">
  <defs>
    <marker id="ar92" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="60" y="16" width="520" height="38" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.4"/>
  <text x="320" y="40" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">server: bus.publish(event)</text>
  <path d="M320,56 L320,80" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="82" width="520" height="40" rx="6" fill="#99f6e4" stroke="#0d9488" stroke-width="1.2"/>
  <text x="320" y="102" text-anchor="middle" font-size="12" fill="currentColor">GlobalBus.on("event", ...)</text>
  <text x="320" y="116" text-anchor="middle" font-size="10" fill="#64748b">worker.ts:43</text>
  <path d="M320,122 L320,146" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="148" width="520" height="40" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="320" y="168" text-anchor="middle" font-size="12" fill="currentColor">Rpc.emit("global.event", event)</text>
  <text x="320" y="182" text-anchor="middle" font-size="10" fill="#64748b">Worker.postMessage（跨线程）</text>
  <line x1="60" y1="208" x2="580" y2="208" stroke="#cbd5e1" stroke-dasharray="4,3"/>
  <text x="320" y="222" text-anchor="middle" font-size="10" fill="#64748b">— Worker / 主线程边界 —</text>
  <path d="M320,228 L320,250" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="252" width="520" height="40" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="320" y="272" text-anchor="middle" font-size="12" fill="currentColor">client.on("global.event", handler)</text>
  <text x="320" y="286" text-anchor="middle" font-size="10" fill="#64748b">createEventSource</text>
  <path d="M320,292 L320,316" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="318" width="520" height="48" rx="6" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="320" y="338" text-anchor="middle" font-size="12" font-weight="600" fill="currentColor">SDKProvider.handleEvent</text>
  <text x="320" y="354" text-anchor="middle" font-size="10.5" fill="#64748b">queue + 16ms batch → emitter.emit("event", e) ｜ sdk.tsx:60-72</text>
  <path d="M320,366 L320,390" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="392" width="250" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="185" y="414" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">useEvent().on(...)</text>
  <text x="185" y="430" text-anchor="middle" font-size="10" fill="#64748b">组件直接订阅</text>
  <text x="185" y="444" text-anchor="middle" font-size="10" fill="#64748b">"session.updated" 等</text>
  <rect x="330" y="392" width="250" height="60" rx="6" fill="#ddd6fe" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="455" y="414" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">useSync()</text>
  <text x="455" y="430" text-anchor="middle" font-size="10" fill="#64748b">订阅各类型事件</text>
  <text x="455" y="444" text-anchor="middle" font-size="10" fill="#64748b">produce 刷 store</text>
  <path d="M185,452 L185,476" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <path d="M455,452 L455,476" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar92)"/>
  <rect x="60" y="478" width="520" height="42" rx="6" fill="#fff" stroke="#94a3b8" stroke-width="1.2"/>
  <text x="320" y="498" text-anchor="middle" font-size="12" fill="currentColor">SolidJS fine-grained reactivity → 局部重渲</text>
  <text x="320" y="512" text-anchor="middle" font-size="10" fill="#64748b">只跑依赖该信号的响应函数，1500+ cell 不动</text>
</svg>
<span class="figure-caption">图 R9.2 ｜ server bus 事件经 Worker RPC 跨线程进入 TUI，被 16ms 批处理后再分发到组件与 store。</span>

<details>
<summary>ASCII 原版</summary>

```
server bus.publish(...)
    │
    ▼
GlobalBus.on("event", ...)              (worker.ts:43)
    │
    ▼ Rpc.emit("global.event", event)
    │
    ▼ (Worker postMessage)
    │
TUI 主进程: client.on("global.event", handler)   (createEventSource)
    │
    ▼
SDKProvider.handleEvent → batch → emitter.emit("event", e)   (sdk.tsx:60-72)
    │
    ▼
useEvent().on("session.updated", ...)            (context/event.ts)
useSync() 内部订阅各种事件类型，刷 store
```

</details>

### 9.5.1 SSE 模式：浏览器 / 外部 client

如果不是 worker 内连（即 `external` 模式或者来自浏览器），同样的事件从 `/event` SSE 端点流出（server 那边见 §10.5）。`SDKProvider.startSSE`（`context/sdk.tsx:74-109`）这样订阅：

```ts
const events = await sdk.global.event({
  signal: ctrl.signal,
  sseMaxRetryAttempts: 0,
})
for await (const event of events.stream) {
  if (ctrl.signal.aborted) break
  handleEvent(event)
}
```

注意 `sseMaxRetryAttempts: 0` 是因为重试逻辑在外层 while-true 里手写了指数退避（103-106 行：`Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)`）。

### 9.5.2 事件批处理

终端是 60Hz 的渲染目标，单帧 16ms。如果上游 1ms 一个 token，每个事件触发一次 SolidJS update，是浪费。`SDKProvider` 的 `handleEvent` (`sdk.tsx:60-72`) 这样合并：

```ts
const handleEvent = (event: GlobalEvent) => {
  queue.push(event)
  const elapsed = Date.now() - last
  if (timer) return
  if (elapsed < 16) {
    timer = setTimeout(flush, 16)
    return
  }
  flush()
}
```

flush 时用 SolidJS 的 `batch(() => { for (...) emitter.emit(...) })` 把这一批事件合并成一次 reactive 通知。这就是为什么 token 流是平滑的而不是抖动的。

### 9.5.3 `useEvent` 过滤

`packages/opencode/src/cli/cmd/tui/context/event.ts:13-23` 定义：

```ts
function subscribe(handler: (event: Event, metadata: EventMetadata) => void) {
  return sdk.event.on("event", (event) => {
    if (event.payload.type === "sync") return
    if (event.directory === "global" || event.project === project.project()) {
      handler(event.payload, { workspace: event.workspace })
    }
  })
}
```

这里做了两件事：丢掉 `sync` 内部事件（由 SyncProvider 自己消费）、按当前 project 过滤。组件里通常用 `event.on("session.updated", ...)`，里头自动 unwrap 到正确类型。

---

## 9.6 消息渲染：route/session/index.tsx

`packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` 是最复杂的一个文件（千行级），讲清楚结构而不展开实现：

```
<Session> (index.tsx)
  ├── 左侧 Sidebar    (sidebar.tsx)            session list + 状态徽章
  ├── 中央 ScrollBox  (index.tsx 内联)         消息流
  │     For (message of messages):
  │       <DialogMessage message=...>          (dialog-message.tsx)
  │         For (part of parts):
  │           Switch (part.type):
  │             "text"             → <TextPart>
  │             "reasoning"        → <ReasoningPart>
  │             "tool"             → <ToolPart tool=... state=...>
  │             "step-finish"      → <StepFinishPart>
  │             ...
  ├── PermissionPrompt (permission.tsx)        权限请求叠在消息上
  ├── QuestionPrompt   (question.tsx)          QuestionTool 弹窗
  ├── SubagentFooter   (subagent-footer.tsx)   子 agent 状态
  ├── Footer           (footer.tsx)            底部状态栏
  └── Prompt           (component/prompt/...)  输入框
```

### 9.6.1 Part 增量

LLM 流式返回的 part 不是一次性出现的——文本会逐 token 累积。SyncProvider 收到 `message.part.updated` 事件后，用 `produce`（solid-js/store 的 immer 风格）就地改 part data：

```ts
// context/sync.tsx 内（简化示意）
setStore("part", produce((part) => {
  part[messageID] = mergedParts
}))
```

SolidJS 的 fine-grained reactivity 保证只有依赖该 part 的子组件（典型是渲染该 part 文本的 `<text>`）重跑响应函数，其余 1500+ cell 不动。

### 9.6.2 工具调用渲染

`<ToolPart>`（在 `routes/session/index.tsx` 里）按 `tool` 名字做巨大的 switch，每种工具有自己的折叠/展开行为：

- `read` → 显示文件路径，展开后 head/tail 摘要
- `write` / `edit` / `apply_patch` → 显示 diff
- `shell` → 显示命令 + 输出（`collapseToolOutput` 折叠长输出）
- `grep` → 显示匹配数 + 文件列表
- `task` → 子 agent 显示嵌套
- `question` → 切到 QuestionPrompt 模式
- `todo` → 显示 `<TodoItem>` 列表

这部分逻辑很死板（一个 if/else 列表），但因为代码量大，所以才放进 `index.tsx`。

---

## 9.7 输入框：Prompt 组件

`packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx` 是 1500+ 行的 super-component。核心 `PromptRef` 接口（`prompt/index.tsx:80-88`）：

```ts
export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}
```

它管的事情远比"一个输入框"多：

1. **多行编辑**：底层是 `@opentui/core` 的 `TextareaRenderable`，支持光标、选择、撤销、`@opentui/keymap/addons/opentui` 提供的标准文本编辑键位（`registerManagedTextareaLayer` 在 keymap.tsx:212-215）。
2. **stdin pipe**：`thread.ts:66-71` 的 `input(value?)` 会读 `Bun.stdin.text()`，如果有非 TTY 输入就当 prompt 前缀拼上。
3. **`@`-mention 文件**：`component/prompt/autocomplete.tsx` 提供 fuzzy 文件搜索（结合 `component/prompt/frecency.tsx` 排序）。
4. **`/`-斜杠命令**：`useCommandSlashes()`（keymap.tsx:243-273）从 keymap 把所有带 `slashName` 的 `palette` 命令收集出来，autocomplete 里展示。
5. **草稿/历史/Stash**：
   - `PromptHistoryProvider` 跨 session 保留历史（`component/prompt/history.tsx`）。
   - `PromptStashProvider` 让用户把当前输入"暂存"换 session 再回来（`component/prompt/stash.tsx`）。
   - `FrecencyProvider` 给文件提及做 frequency × recency 排序。
6. **粘贴处理**：长粘贴会被替换为 `<paste:1>` 占位，`expandPastedTextPlaceholders`（在 `prompt/part.ts`）提交时再展开。
7. **selection 上下文**：连 VS Code/Zed 接来的 editor selection 也会附在 prompt 里（`context/editor-zed.ts`、`context/editor.ts`、`prompt/index.tsx:106-128` 的 `formatEditorContext`）。

### 9.7.1 提交

`promptRef.submit()` 最终调 SDK：

```ts
await sdk.client.session.prompt({
  sessionID,
  body: { providerID, modelID, parts: [...] },
})
```

server 拿到后走 §第 04-05 章的 SessionPrompt 链路，事件经 bus → SSE → SyncProvider → 重新渲染。整个回路是单向的。

---

## 9.8 Keymap：`@opentui/keymap`

`packages/opencode/src/cli/cmd/tui/keymap.tsx` 是 anomalyco 在 `@opentui/keymap` 之上的薄壳。

### 9.8.1 概念

`@opentui/keymap` 是一个**模式化、可组合**的键位库。基本概念：

- **mode**：当前键位上下文（`base`、`modal`、`textarea`...）。
- **layer**：一组绑定，归属某个 mode；可以临时 push 一个 layer 在最上面（如 dialog 打开）。
- **command**：带名字的可执行操作（`session.list`、`prompt.submit`）。
- **binding**：key sequence → command 的映射；key 可以是序列（`leader > s`）或带修饰键（`ctrl+c`）。
- **leader**：一个"前缀键"，按了之后有 timeout 等下一个键，用来做和-弦绑定。

### 9.8.2 注册流程

`registerOpencodeKeymap`（`keymap.tsx:196-227`）一次性注册了：

```ts
const modeStack = createOpencodeModeStack(keymap)
const offCommaBindings = addons.registerCommaBindings(keymap)
const offAliasExpander = registerKeyAliases(keymap)
const offBaseLayout = addons.registerBaseLayoutFallback(keymap)
const offLeader = addons.registerTimedLeader(keymap, {
  trigger: config.keybinds.get(LEADER_TOKEN),
  name: LEADER_TOKEN,
  timeoutMs: config.leader_timeout,
})
const offEscape = addons.registerEscapeClearsPendingSequence(keymap)
const offBackspace = addons.registerBackspacePopsPendingSequence(keymap)
const offInputBindings = addons.registerManagedTextareaLayer(keymap, renderer, {
  enabled: () => renderer.currentFocusedEditor !== null,
  bindings: config.keybinds.gather("input", inputCommands),
})
```

每一项返回一个 `off()`，最后 `return () => { offInputBindings(); ... }` 是反向卸载。

### 9.8.3 mode stack

`createOpencodeModeStack`（keymap.tsx:41-88）维护一个 `{ id, mode }[]` 栈，栈顶决定 keymap 看到的 mode：

```ts
push(mode: string) {
  const id = Symbol(mode)
  stack.push({ id, mode })
  update()
  return () => { /* 弹出对应 id */ }
}
```

`ui/dialog.tsx:78-82` 里 dialog 一打开就 `modeStack.push("modal")`，关闭时 cleanup 回 base。这是为什么打开 dialog 后 `Ctrl+C` 是"关 dialog"而不是"中断 LLM"——它们绑在不同 mode 上。

### 9.8.4 commands 注册

`app.tsx:458-823` 那个超长的 `appCommands` 数组是所有 palette 命令的定义。每条形如：

```ts
{
  name: "session.list",
  title: "Switch session",
  category: "Session",
  slashName: "sessions",
  slashAliases: ["resume", "continue"],
  run: () => { dialog.replace(() => <DialogSessionList />) },
}
```

随后通过 `useBindings(() => ({ commands: appCommands() }))`（825-827 行）把命令登记进 keymap，又通过另一个 `useBindings` 把 `tuiConfig.keybinds.gather("app", appBindingCommands)` 的快捷键绑到命令名上（829-832 行）。

用户在 `~/.config/opencode/keybinds.json` 里改键位，最终就是改 `tuiConfig.keybinds`，命令名固定。

---

## 9.9 Dialog & Toast

### 9.9.1 Dialog 栈

`packages/opencode/src/cli/cmd/tui/ui/dialog.tsx` 实现一个简单的栈：

```ts
const [store, setStore] = createStore({
  stack: [] as { element: JSX.Element; onClose?: () => void }[],
  size: "medium" as ...,
})
```

API：

- `replace(element, onClose?)`：清栈、压一个新的（102-104 行：刚打开时把 `currentFocusedRenderable` 存下来 blur 掉，关闭时 `refocus()` 还回去）。
- `clear()`：清栈、依次调 `onClose`、refocus。
- 自动绑了 `escape` / `ctrl+c` → 弹栈顶（102-134 行的 `useBindings`）。

实际 dialog 长这样（dialog.tsx:11-64）：

```tsx
<box position="absolute" zIndex={3000} backgroundColor={RGBA.fromInts(0,0,0,150)}>
  <box width={width()} backgroundColor={theme.backgroundPanel} paddingTop={1}>
    {props.children}
  </box>
</box>
```

`zIndex={3000}` 让它浮在所有 message / prompt 之上。`RGBA(0,0,0,150)` 是半透明遮罩——`@opentui/core` 在终端里**模拟透明度**（向下采样背景色再 alpha 混合）。

### 9.9.2 常用 dialog

`packages/opencode/src/cli/cmd/tui/component/dialog-*.tsx` 一大堆：

| 文件 | 用途 |
| --- | --- |
| `dialog-model.tsx` | 切换 provider/model |
| `dialog-agent.tsx` | 切 agent |
| `dialog-mcp.tsx` | 启/停 MCP server |
| `dialog-provider.tsx` | provider 登录流程 |
| `dialog-status.tsx` | `/status` 全景查看 |
| `dialog-session-list.tsx` | session 切换 |
| `dialog-session-rename.tsx` | 改 session 标题 |
| `dialog-stash.tsx` | prompt 草稿管理 |
| `dialog-skill.tsx` | skill 选择 |
| `dialog-tag.tsx` | session 标签 |
| `dialog-theme-list.tsx` | 主题切换 |
| `dialog-workspace-*.tsx` | workspace 创建 / 不可用提示 |

通用 dialog 工具在 `ui/`：
- `dialog-alert.tsx` / `dialog-confirm.tsx` / `dialog-prompt.tsx` / `dialog-select.tsx`：alert/confirm/prompt/select 四种基础 modal。它们都是 promise-style API，例如：

```ts
const choice = await DialogConfirm.show(dialog, "Update Available", `v${v} ...`, "skip")
if (choice === true) { ... }
```

见 `app.tsx:893-898` 处的升级流程。

### 9.9.3 权限请求

`routes/session/permission.tsx` 是个不走通用 dialog 的 inline 组件。当 server 发出 `permission.requested` 事件，SyncProvider 把它存到 `store.permission[sessionID]`，session 路由检测到非空就把 `<PermissionPrompt>` 显示在消息流和 prompt 之间。用户按 `y/n/a` 选择，组件调 `sdk.client.permission.reply({ requestID, body: { reply: ..., message: ... } })`。

### 9.9.4 Toast

`ui/toast.tsx` 实现单槽 toast：固定右上角，同时只显示一个，新的覆盖旧的。`toast.show({ message, variant: "info"|"warning"|"error", duration })` 注入计时器到期自动 dismiss。

---

## 9.10 Attention：吸引用户注意

`packages/opencode/src/cli/cmd/tui/attention.ts` 处理一个看似奇怪的需求：**LLM 跑了 30 秒终于回完话，但用户已经切到别的窗口了，怎么把他叫回来？**

`createTuiAttention(...)`（116-262 行）暴露两个能力：

1. **桌面通知**：调 `renderer.triggerNotification(message, title)`（@opentui/core 触发系统级 notification）。
2. **声音**：内置一个 sound pack（`@opencode-ai/ui/audio/*.mp3`），按事件类型分 `default` / `question` / `permission` / `error` / `done` / `subagent_done`。

调用入口是 `tui.notify(...)`（plugin API），典型路径：tool 跑完 → SessionPrompt 触发 `attention.done` 事件 → plugin 调 `tui.notify({ message: "Done", sound: { name: "done" } })`。

### 9.10.1 焦点状态

`@opentui/core` 通过 escape 序列（`\x1b[?1004h` enable focus tracking）能拿到当前终端窗口是否 focused：

```ts
input.renderer.on("focus", onFocus)
input.renderer.on("blur", onBlur)
```

`focusSkip(when, focus)` 决定是否跳过通知：默认通知只在 `blurred` 触发，声音默认 `always`。用户在配置里可改。

### 9.10.2 Sound pack

`soundboard.registerPack(pack)` / `activate(id)` / `current()` / `list()` 让插件能注册自定义 sound pack。`@opencode-ai/plugin/tui` 是公共类型。

---

## 9.11 Worker thread

`packages/opencode/src/cli/cmd/tui/worker.ts`（99 行）就是上面 §9.3 提到的那个独立 Worker。它做几件事：

```ts
// worker.ts:43-45
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})
```

把 server 内部 bus 的所有事件转发给 TUI 进程（RPC over `Worker.postMessage`）。

它对 TUI 暴露的 RPC（`worker.ts:49-97`）：

| RPC | 行为 |
| --- | --- |
| `fetch(req)` | 把请求送进 in-process `Server.Default().app.fetch(...)`，回响应 |
| `server(opts)` | 启动真正的 TCP server（external 模式） |
| `snapshot()` | `writeHeapSnapshot("server.heapsnapshot")` |
| `checkUpgrade(...)` | 后台跑升级检查 |
| `reload()` | 热重载 config + dispose 所有 instance |
| `shutdown()` | 优雅停所有 instance + close server |

`InstanceRuntime.disposeAllInstances()` 是这套架构能"热重载"的关键，由 SIGUSR2 触发（`thread.ts:172`）。

### 9.11.1 为什么单独一个 worker

放进 worker 后，TUI 主线程**永远不会** block 在：

- ai-sdk 的 fetch（网络栈）
- LSP 子进程 stdin/stdout
- ripgrep / sqlite 同步 I/O
- session prompt 期间的大量计算

主线程只做"读输入 → 维护 renderer → 刷帧"这一个循环，60Hz 才能稳。

---

## 9.12 退出与持久化

session 状态、消息、part、todo、所有事件流——**全部存在 worker 内部的 sqlite db**（session.sql / event.sql），不在 TUI 进程的内存里。SyncProvider 持有的是这些数据的 in-memory 镜像，它从 `bus.subscribeAll()` 实时拉。

所以 TUI 关闭时：

1. `app.tsx` 的 `onBeforeExit` 调 `offKeymap()`、`TuiPluginRuntime.dispose()`、`TuiAudio.dispose()`（音频解码器）。
2. `thread.ts:174-187` 的 `stop()` 把 worker 也优雅停掉（`client.call("shutdown")` 5 秒超时，然后 `worker.terminate()`）。
3. db 已经在每个事件 commit 时写盘了，TUI 进程一退就完。

下次 `opencode` 启动，`-c` / `-s` 选项让 SyncProvider 从 worker 的 db 把对应 session 的 message / part / todo 拉出来，重建 UI。`Home` 路由的 `args.continue` 走的就是这条路（`app.tsx:212-220` + `app.tsx:401-421`）。

---

## 9.13 win32 跨平台

`packages/opencode/src/cli/cmd/tui/win32.ts`（130 行）解决的是 Windows 终端最大的几个坑。

### 9.13.1 `ENABLE_PROCESSED_INPUT`

Windows 控制台默认开 `ENABLE_PROCESSED_INPUT`，结果就是 `Ctrl+C` 不进 stdin，而是变成进程组的 `CTRL_C_EVENT`，操作系统直接 kill 整个进程组。TUI 需要把 `Ctrl+C` 当**普通键**用（比如"中断当前 LLM 输出"或者"关 dialog"）。

`win32DisableProcessedInput`（30-42 行）调 `kernel32.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT)` 关掉它。底层用 `bun:ffi` 的 `dlopen("kernel32.dll", { GetStdHandle, GetConsoleMode, SetConsoleMode, FlushConsoleInputBuffer })`。

### 9.13.2 持续守护

更恶心的是某些运行时会**重新把 flag 设回来**——例如 Node/Bun 内部把 stdin 切换到 raw mode 时。`win32InstallCtrlCGuard`（69-129 行）的策略：

1. **wrap `process.stdin.setRawMode`**：每次切换 raw mode 之后调 `enforce()` 再清 flag。
2. **低频轮询**：`setInterval(enforce, 100)`（112-113 行），并且 `interval.unref()` 让它不阻止进程退出。

退出时 `unhook()` 恢复 setRawMode 原函数和 console mode 初值。

### 9.13.3 Other platforms

macOS / Linux 这两个函数都直接早退（`process.platform !== "win32"` 检查）。

---

## 9.14 Route：home / session / plugin

`packages/opencode/src/cli/cmd/tui/context/route.tsx` 维护一个**极简的路由 store**：

```ts
export type Route = HomeRoute | SessionRoute | PluginRoute

export type HomeRoute    = { type: "home";    prompt?: PromptInfo }
export type SessionRoute = { type: "session"; sessionID: string; prompt?: PromptInfo }
export type PluginRoute  = { type: "plugin";  id: string; data?: Record<string, unknown> }
```

`RouteProvider` 的 `navigate(route)` 用 `setStore(reconcile(route))` 把整个路由对象替换掉，SolidJS 的 fine-grained reactivity 让 `<App>` 里 `<Switch><Match when={route.data.type === "home"}>...` 自动切。

特别的两点：

1. **首次进入可以从 env 读**：`process.env["OPENCODE_ROUTE"]` 存在时反序列化它当初始路由。这给"程序化启动 TUI 时直接打开某 session"的脚本场景留口子。
2. **prompt 也可携带**：路由对象本身可携带一段 PromptInfo——`route.navigate({ type: "session", sessionID, prompt: ... })` 是切到 session 顺便预填输入框。Home 的 `bind` 函数（`routes/home.tsx:33-45`）正是用这条路实现 `--prompt` 自动填入。

### 9.14.1 plugin 路由

插件可以注册"我有一个叫 `my-thing` 的整页路由"。app.tsx:934-940 的 `plugin = createMemo(...)` 计算：

```ts
const plugin = createMemo(() => {
  if (!ready()) return
  if (route.data.type !== "plugin") return
  const render = routeView(route.data.id)
  if (!render) return <PluginRouteMissing id={route.data.id} ... />
  return render({ params: route.data.data })
})
```

`routes` 是个 `RouteMap`（注册表），插件通过 `api.route.register(id, renderFn)` 加，`api` 来自 `createTuiApi(...)`（plugin/api.ts）。`setRouteRev` signal 用来在插件 register/unregister 时强制 memo 重算。

---

## 9.15 SyncProvider：单页应用的状态镜像

`packages/opencode/src/cli/cmd/tui/context/sync.tsx`（千行级）是 TUI 状态最复杂的一块。store 形状（39-90 行节选）：

```ts
const [store, setStore] = createStore<{
  status: "loading" | "partial" | "complete"
  provider: Provider[]
  agent: Agent[]
  command: Command[]
  permission: { [sessionID: string]: PermissionRequest[] }
  question:   { [sessionID: string]: QuestionRequest[] }
  config: Config
  session: Session[]
  session_status: { [sessionID: string]: SessionStatus }
  session_diff:   { [sessionID: string]: Snapshot.FileDiff[] }
  todo:    { [sessionID: string]: Todo[] }
  message: { [sessionID: string]: Message[] }
  part:    { [messageID: string]: Part[] }
  lsp: LspStatus[]
  mcp: { [key: string]: McpStatus }
  formatter: FormatterStatus[]
  vcs: VcsInfo | undefined
  ...
}>(...)
```

可以看到几乎所有"client 需要的服务端状态"都被镜像了一份。每种状态都有对应的事件 handler 订阅 bus：

```ts
event.on("session.updated", (evt) => {
  setStore("session", produce((list) => {
    const idx = list.findIndex(s => s.id === evt.properties.info.id)
    if (idx >= 0) list[idx] = evt.properties.info
    else list.push(evt.properties.info)
  }))
})

event.on("message.part.updated", (evt) => {
  setStore("part", produce((parts) => {
    const list = parts[evt.properties.messageID] ?? []
    // merge by part.id, update or insert
    ...
  }))
})
```

### 9.15.1 三阶段加载

`status` 字段从 `"loading"` → `"partial"` → `"complete"` 三段：

- `loading`：刚启动，啥都没拉。
- `partial`：第一批关键数据（session 列表、provider 列表、agent 列表）到位，UI 可以开始展示主框架。
- `complete`：所有 sync 流（包括 vcs/lsp/mcp/formatter）都完成了。

`app.tsx:401-421` 处理 `-c` continue 时显式区分：

```ts
createEffect(() => {
  if (continued || sync.status === "loading" || !args.continue) return
  const match = sync.data.session
    .toSorted((a, b) => b.time.updated - a.time.updated)
    .find((x) => x.parentID === undefined)?.id
  // ...
})
```

注释说"When using -c, session list is loaded in blocking phase, so we can navigate at `partial`"——意思是 session 列表是 first batch 拉进来的，无需等 `complete`。

### 9.15.2 `aggregateFailures`

`context/aggregate-failures.ts` 把 sync 过程中各种 sub-task 的失败聚合起来，用 toast/dialog 一次性给用户报。第 11 章谈错误处理时还会用到。

---

## 9.16 主题系统

`packages/opencode/src/cli/cmd/tui/context/theme.tsx` + `context/theme/` 目录管主题。要点：

1. **mode 探测**：`renderer.waitForThemeMode(1000)`（`app.tsx:195`）尝试用 `\x1b]11;?\x1b\\` 查询终端背景色，给出 `"dark" | "light"`，超时 fallback `"dark"`。
2. **palette 预热**：`renderer.getPalette({ size: 16 })`（app.tsx:194）提前异步拉调色板，避免 ThemeProvider 首次挂载时阻塞。
3. **system theme**：用户配 `theme: "system"` 时，theme 跟随终端 mode 切换。
4. **lock**：`theme.mode.lock` 命令 freeze 当前 mode，不再随终端切。

主题对象（`theme.tsx` 内）暴露 `theme.background`、`theme.text`、`theme.borderActive`、`theme.error`、`syntax.<lang>` 等大量颜色字段。组件直接 `const { theme } = useTheme(); <text fg={theme.text} />`。

### 9.16.1 selectedForeground

`tint(...)` / `selectedForeground(...)`（theme.tsx 内）实现"在 selected 状态下混合 highlight 色"，统一了所有 list 类组件的选中态视觉。

---

## 9.17 Attach 模式与 stdin 路由

`packages/opencode/src/cli/cmd/tui/attach.ts`（未在本章详述）让用户的 `opencode --attach <socket>` 接到一个已有的 TUI session。`validate-session.ts` 做 session 存在性校验，错的话立即报错退出（`thread.ts:213-224`）。

### 9.17.1 stdin pipe 拼接

`thread.ts:66-71` 那个 `input(value?)` 容易被忽略：

```ts
async function input(value?: string) {
  const piped = process.stdin.isTTY ? undefined : await Bun.stdin.text()
  if (!value) return piped
  if (!piped) return value
  return piped + "\n" + value
}
```

当 stdin 不是 TTY（被 pipe）时，读完全部 stdin 当 prompt 前缀拼上 `--prompt` 后面的字符串。这就是为啥 `cat file.md | opencode -p "translate this"` 能直接把文件内容当上文。

---

## 9.18 Sidebar：session 副栏

`packages/opencode/src/cli/cmd/tui/routes/session/sidebar.tsx` 是 session 路由左侧那一条侧栏（默认 42 列宽，可隐藏）。它显示：

- 当前 session 标题 / workspace 标签 / 创建时间。
- session 列表（同 project 下的）。
- 当前 MCP / LSP / formatter 健康状态。
- `<TuiPluginRuntime.Slot name="sidebar_title">` 等多个插件槽。

实现细节不复杂，重点是它演示了 SolidJS `<scrollbox>` + `getScrollAcceleration(tuiConfig)`——`@opentui/core` 的滚动加速曲线由 `tuiConfig.scroll.acceleration` 决定，多次连续上下方向键时加速。

---

## 9.19 TUI 插件运行时

`packages/opencode/src/cli/cmd/tui/plugin/runtime.ts` 与 `plugin/api.ts` 实现了 TUI 内的**插件机制**——和 server 端的 plugin 不同，这套是给"想往 UI 里塞自定义组件 / 路由 / slash 命令 / soundboard"的插件用的。

### 9.19.1 插件入口

每个 TUI plugin 是一个独立模块，导出一个函数：

```ts
export default function myPlugin(api: TuiApi) {
  api.route.register("my-thing", ({ params }) => <MyView params={params} />)
  api.keymap.registerCommand({
    name: "my.thing.open",
    title: "Open My Thing",
    slashName: "mything",
    run: () => api.route.navigate({ type: "plugin", id: "my-thing" }),
  })
  api.attention.soundboard.registerPack({ id: "my-pack", sounds: { ... } })
}
```

`TuiPluginRuntime.init({ api, config, dispose })`（app.tsx:310-320）扫描 config 里声明的 plugin，按顺序 load 它们，把同一个 `api` 注入。

### 9.19.2 Slot

`<TuiPluginRuntime.Slot name="..." mode="..." />` 是插件挂载点：

```tsx
<TuiPluginRuntime.Slot name="home_logo" mode="replace">
  <Logo />            <!-- 默认内容 -->
</TuiPluginRuntime.Slot>
```

`mode` 决定 fallback / replace / single_winner / append 等行为。命名空间有 `app` / `app_bottom` / `home_logo` / `home_prompt` / `home_prompt_right` / `home_bottom` / `home_footer` / `sidebar_title` / ...

### 9.19.3 dispose 顺序

退出时 `onBeforeExit`（app.tsx:186-190）按这个顺序：

```ts
const onBeforeExit = async () => {
  offKeymap()
  await TuiPluginRuntime.dispose()
  TuiAudio.dispose()
}
```

先解绑 keymap（避免 plugin 卸载途中触发命令）、再 dispose 插件、最后释放 audio decoder。`attention.dispose()` 在 `App` 的 `onCleanup` 里跑。

---

## 9.20 一图回顾

```
            ┌──── @opentui/core CliRenderer ────┐
            │ 60 Hz framebuffer, mouse, theme   │
            └──────────────┬────────────────────┘
                           │
                    SolidJS render()
                           │
   ┌───────────────────────┴───────────────────────┐
   │  Provider 金字塔（context/）                  │
   │  SDK → Sync → Project → Theme → Local → ...   │
   └───────────────────────┬───────────────────────┘
                           │
                           ▼
   ┌─────────── App ───────────┐
   │  Switch(route):           │
   │   home   → <Home>         │
   │   session→ <Session>      │
   │   plugin → <PluginView>   │
   ├───────────────────────────┤
   │  <DialogProvider> 栈      │
   │  <Toast>                  │
   │  <StartupLoading>         │
   └───────────────────────────┘
            ▲                         ▲
            │ keymap                  │ event
            │ (commands + bindings)   │ (SSE/RPC)
            │                         │
        @opentui/keymap        SDKProvider → Worker → server
```

---

## 9.21 小结

TUI 在 opencode 里是一个**纯渲染层**：

- 进程隔离：渲染（主进程） + 逻辑（Worker 内的 server）。
- 框架选型：SolidJS 提供细粒度 reactivity、`@opentui/core` 提供终端 framebuffer、`@opentui/keymap` 提供模式化键位。
- 状态在 server：TUI 退出零副作用，重启从 db 恢复。
- 平台细节封堵：win32 的 console mode 持续 guard。

下一章看 server 这一半——它是 TUI、SDK、headless 远程客户端共同的访问点。
