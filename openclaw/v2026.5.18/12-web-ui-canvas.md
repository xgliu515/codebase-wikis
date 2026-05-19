# 第 12 章 · Web UI 与 Canvas

> 代码版本锁定：`openclaw/openclaw@50a2481652`（tag `v2026.5.18`，2026-05-18）
>
> 本章面向熟悉前端工程的读者，剖析 `ui/` 目录——OpenClaw 的 Control UI（也叫 WebChat）。它是一个由 gateway 在 HTTP 上托管的单页应用：用户在浏览器里和 agent 对话、看工具卡片流式渲染、配置 channel、切换模型。
>
> **重要更正**：尽管常被泛称为「React 前端」，OpenClaw 的 Control UI **不使用 React**。它的实际技术栈是 **Lit（Web Components）+ Vite + 原生 TS 模块**。本章按代码真实情况讲。如果你带着 React 心智模型来，请把「组件 = `LitElement`」「`useState` = `@state()`」「JSX = `html\`\`` 标签模板」做映射。

---

## 12.0 本章要回答的问题

打开浏览器访问 gateway 的控制台地址，你会看到一个聊天界面。这个界面背后要回答几个工程问题：

1. 它是怎么构建和加载的？（Vite、入口、Service Worker）
2. 它怎么连上 gateway？连接走 WebSocket，那鉴权、RPC、事件订阅怎么做？
3. agent 流式产出的文本、工具调用，怎么在界面上实时长出来？
4. 富内容——代码块、图片、语音、可交互的 Canvas 插件面板——怎么渲染？
5. 整个 UI 的组件是怎么组织的？
6. 用户点「发送」之后，到接收回 agent 事件流，前端代码走了哪条路？

<svg viewBox="0 0 760 320" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="OpenClaw Control UI 浏览器端架构：入口加载、WebSocket 通信与渲染层三大模块">
  <defs>
    <marker id="ar1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
  </defs>
  <rect x="10" y="10" width="738" height="296" rx="8" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="380" y="30" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">浏览器</text>
  <rect x="30" y="42" width="700" height="52" rx="5" fill="white" stroke="#cbd5e1" stroke-width="1"/>
  <text x="60" y="60" font-size="11" font-weight="600" fill="currentColor">ui/index.html</text>
  <line x1="160" y1="60" x2="196" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="200" y="60" font-size="11" font-weight="600" fill="currentColor">ui/src/main.ts</text>
  <line x1="308" y1="60" x2="344" y2="60" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar1)"/>
  <text x="348" y="60" font-size="11" font-weight="600" fill="currentColor">ui/src/ui/app.ts</text>
  <text x="200" y="83" font-size="10" fill="#64748b">注册 Service Worker</text>
  <text x="348" y="83" font-size="10" fill="#0d9488">&lt;openclaw-app&gt; 自定义元素 (LitElement)</text>
  <rect x="30" y="106" width="340" height="90" rx="5" fill="white" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="200" y="124" text-anchor="middle" font-size="12" font-weight="700" fill="#0ea5e9">GatewayBrowserClient</text>
  <text x="200" y="138" text-anchor="middle" font-size="10" fill="#64748b">ui/src/ui/gateway.ts</text>
  <rect x="50" y="146" width="300" height="22" rx="3" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"/>
  <text x="200" y="161" text-anchor="middle" font-size="10" font-weight="600" fill="#0ea5e9">WebSocket ⇄ gateway</text>
  <text x="50" y="180" font-size="10" fill="#64748b">├─ req/res 帧 → RPC（chat.send / chat.abort / sessions.* ...）</text>
  <text x="50" y="194" font-size="10" fill="#64748b">└─ event 帧 → handleGatewayEvent → handleAgentEvent / handleChatEvent</text>
  <rect x="390" y="106" width="340" height="90" rx="5" fill="white" stroke="#ea580c" stroke-width="1.2"/>
  <text x="560" y="124" text-anchor="middle" font-size="12" font-weight="700" fill="#ea580c">渲染层</text>
  <text x="560" y="138" text-anchor="middle" font-size="10" fill="#64748b">app-render.ts + views/chat.ts + chat/*.ts</text>
  <text x="410" y="158" font-size="10" fill="#64748b">markdown.ts</text>
  <text x="530" y="158" font-size="10" fill="#94a3b8">markdown-it + DOMPurify</text>
  <text x="410" y="174" font-size="10" fill="#64748b">tool-display.ts</text>
  <text x="530" y="174" font-size="10" fill="#94a3b8">工具卡片</text>
  <text x="410" y="190" font-size="10" fill="#64748b">canvas-url.ts</text>
  <text x="530" y="190" font-size="10" fill="#94a3b8">Canvas iframe 富面板</text>
  <rect x="30" y="218" width="700" height="68" rx="5" fill="white" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="380" y="238" text-anchor="middle" font-size="12" font-weight="700" fill="#7c3aed">app-gateway.ts — 连接编排 + 事件分发</text>
  <text x="380" y="256" text-anchor="middle" font-size="10" fill="#64748b">handleGatewayEvent: evt.event==="agent" → handleAgentEvent　　evt.event==="chat" → handleChatEvent</text>
  <text x="380" y="274" text-anchor="middle" font-size="10" fill="#94a3b8">controllers/chat.ts（聊天 RPC）　　app-tool-stream.ts（工具流状态）</text>
  <line x1="200" y1="196" x2="200" y2="218" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
  <line x1="560" y1="196" x2="560" y2="218" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2"/>
</svg>
<span class="figure-caption">图 R12.1 ｜ Control UI 浏览器端架构：入口加载链、WebSocket 通信层与渲染层三大模块</span>

<details>
<summary>ASCII 原版</summary>

```
浏览器
  │
  ├─ ui/index.html ──→ ui/src/main.ts ──→ ui/src/ui/app.ts
  │                         │                   │
  │                    注册 Service Worker   <openclaw-app> 自定义元素 (LitElement)
  │
  ├─ GatewayBrowserClient (ui/src/ui/gateway.ts)
  │     WebSocket ⇄ gateway
  │       ├─ req/res 帧  → RPC（chat.send / chat.abort / sessions.* ...）
  │       └─ event 帧    → handleGatewayEvent → handleAgentEvent / handleChatEvent
  │
  └─ 渲染层 (ui/src/ui/app-render.ts + views/chat.ts + chat/*.ts)
        markdown.ts（markdown-it + DOMPurify）
        tool-display.ts（工具卡片）
        canvas-url.ts（Canvas iframe 富面板）
```

</details>

涉及的关键文件：

| 文件 | 角色 |
| --- | --- |
| `ui/package.json` | 依赖清单（Lit、markdown-it、DOMPurify…） |
| `ui/vite.config.ts` | Vite 构建配置、Service Worker build-id 注入 |
| `ui/index.html` | HTML 入口 |
| `ui/src/main.ts` | JS 入口、Service Worker 注册 |
| `ui/src/ui/app.ts` | `<openclaw-app>` 根 `LitElement` |
| `ui/src/ui/app-render.ts` | 顶层渲染函数 `renderApp` |
| `ui/src/ui/gateway.ts` | `GatewayBrowserClient`：WebSocket 客户端 |
| `ui/src/ui/app-gateway.ts` | 连接编排 + 事件分发 |
| `ui/src/ui/controllers/chat.ts` | 聊天 RPC 与事件处理 |
| `ui/src/ui/views/chat.ts` | 聊天视图渲染 |
| `ui/src/ui/app-tool-stream.ts` | 工具事件流状态管理 |
| `ui/src/ui/markdown.ts` | Markdown 渲染 + 净化 |
| `ui/src/ui/tool-display.ts` | 工具卡片的图标/标题解析 |
| `ui/src/ui/canvas-url.ts` | Canvas 富面板 iframe URL 解析 |

---

## 12.1 技术栈与构建

### 12.1.1 依赖清单

`ui/package.json`（`ui/package.json:11`）的 `dependencies` 很短，每一项都值得说明：

```jsonc
// ui/package.json:11
"dependencies": {
  "@create-markdown/preview": "2.0.3",
  "@noble/ed25519": "3.1.0",
  "dompurify": "3.4.3",
  "json5": "2.2.3",
  "lit": "3.3.3",
  "markdown-it": "14.1.1",
  "markdown-it-task-lists": "2.1.1",
  "marked": "18.0.3"
}
```

- **`lit`**：核心 UI 框架。Web Components + 响应式属性 + `html\`\`` 标签模板。**没有 React、没有 Vue**。
- **`markdown-it`** + **`markdown-it-task-lists`** + **`marked`**：Markdown 渲染。聊天消息是 Markdown。
- **`dompurify`**：HTML 净化。Markdown 渲染出的 HTML 在插入 DOM 前必须经过它，防 XSS。
- **`@noble/ed25519`**：椭圆曲线签名。用于设备身份（device identity）——浏览器生成一对 ed25519 密钥向 gateway 证明自己。
- **`json5`**：解析宽松 JSON（配置编辑器里允许注释、尾逗号）。

`devDependencies`（`ui/package.json:21`）里 `vite` 8、`vitest` 4、`playwright`——构建用 Vite，测试用 Vitest（含 `@vitest/browser-playwright` 跑浏览器环境测试）。

为什么选 Lit 而不是 React？Control UI 是被 gateway 内嵌托管的运维台，体量需要可控、零运行时开销越好。Lit 编译产物极小、基于浏览器原生 Custom Elements，没有虚拟 DOM 协调器的重量。对一个「主要功能是聊天 + 配置表单」的应用，这个取舍是合理的。

### 12.1.2 Vite 构建

`ui/vite.config.ts` 的 `defineConfig`（`ui/vite.config.ts:82`）几个要点：

**输出目录。** 产物打到 `../dist/control-ui`（`ui/vite.config.ts:9`），即仓库根的 `dist/control-ui`——gateway 在运行时从这里读静态资源并通过 HTTP 托管。

**base path 可配。** `base` 默认是 `"./"`（相对路径），可由环境变量 `OPENCLAW_CONTROL_UI_BASE_PATH` 覆盖（`ui/vite.config.ts:83`）。相对 base 让 UI 能被挂在任意子路径下——gateway 可能把控制台放在 `/admin/` 之类的路径。

**build-id 注入。** `resolveControlUiBuildId`（`ui/vite.config.ts:54`）拼出一个构建标识：优先环境变量，否则用 `package.json` 版本 + git short SHA：

```ts
// ui/vite.config.ts:54
function resolveControlUiBuildId(): string {
  const explicit =
    process.env.OPENCLAW_CONTROL_UI_BUILD_ID?.trim() || process.env.OPENCLAW_VERSION?.trim();
  if (explicit) {
    return normalizeBuildId(explicit);
  }
  const version = readPackageVersion();
  const gitSha = readGitShortSha();
  return normalizeBuildId(gitSha ? `${version}-${gitSha}` : version);
}
```

这个 build-id 通过 `define` 编译成全局常量 `__OPENCLAW_CONTROL_UI_BUILD_ID__`（`ui/vite.config.ts:88`），并由一个自定义 Vite 插件 `controlUiServiceWorkerBuildIdPlugin`（`ui/vite.config.ts:65`）在 `closeBundle` 阶段把 `sw.js` 里的占位符替换掉。注意它若发现占位符不存在会直接 `throw`（`ui/vite.config.ts:75`）——构建期的硬失败，宁可炸掉也不要发布一个缓存键错误的 SW。

**dev stub。** `configureServer`（`ui/vite.config.ts:111`）为开发服务器注册了 `/__openclaw/control-ui-config.json` 的 mock，让 `vite dev` 不需要真 gateway 也能跑起来。

### 12.1.3 CSS

UI 的样式是**单一全局样式表** `ui/src/styles.css`，由 `ui/src/main.ts:1` 直接 `import "./styles.css"` 引入。**不是 CSS Modules**——任务描述里提到的「CSS modules」与代码实情不符。配合 Lit 这个选择是自然的：聊天界面用 BEM 风格的全局 class（代码里到处是 `.code-block-copy`、`.slash-menu-icon` 这种），不需要 CSS Modules 的局部作用域。

主题切换是另一套机制：`OpenClawApp` 上有 `@state() theme` / `themeMode` / `themeResolved`（`ui/src/ui/app.ts:171`），通过切换 CSS 自定义属性（CSS variables）实现，主题定义在 `theme.ts` / `custom-theme.ts`。

---

## 12.2 入口与启动

### 12.2.1 HTML → JS → 自定义元素

启动链非常短：

`ui/index.html` 引入 `ui/src/main.ts`。`main.ts` 只做两件事（`ui/src/main.ts`）：

```ts
// ui/src/main.ts:1
import "./styles.css";
import "./ui/app.ts";
```

`import "./ui/app.ts"` 这个副作用导入触发 `app.ts` 底部的自定义元素注册：

```ts
// ui/src/ui/app.ts:1305
if (!customElements.get("openclaw-app")) {
  customElements.define("openclaw-app", OpenClawApp);
}
```

`index.html` 的 body 里写着 `<openclaw-app></openclaw-app>`。一旦 `customElements.define` 执行，浏览器就实例化它，整个应用启动。这就是 Web Components 模型——没有「React 把组件挂载到某个 div」的步骤，自定义元素自我升级（upgrade）。

### 12.2.2 Service Worker

`main.ts` 剩下的逻辑是 Service Worker 管理（`ui/src/main.ts:14`）：

```ts
// ui/src/main.ts:12
const isProd = (import.meta as ViteImportMeta).env?.PROD === true;

if (isProd && "serviceWorker" in navigator) {
  const swUrl = new URL("./sw.js", window.location.href);
  swUrl.searchParams.set("v", __OPENCLAW_CONTROL_UI_BUILD_ID__ || "dev");
  void navigator.serviceWorker.register(swUrl, { updateViaCache: "none" });
} else if (!isProd && "serviceWorker" in navigator) {
  // 开发环境：注销遗留的 SW，避免陈旧缓存
  void navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      void r.unregister();
    }
  });
}
```

生产环境注册 SW，URL 上挂 `?v=<build-id>` ——build-id 一变，SW URL 就变，浏览器据此判定要更新。`updateViaCache: "none"` 强制每次都从网络拉 SW 脚本本身。开发环境则反过来，主动注销任何遗留 SW，因为 SW 缓存在开发时只会带来「为什么我的改动没生效」的困惑。

build-id 即上一节那个编译期常量。SW 的存在让 Control UI 具备 PWA 离线能力（`ui/public/manifest.webmanifest` 提供 PWA 清单）。

### 12.2.3 根元素 OpenClawApp

`OpenClawApp extends LitElement`（`ui/src/ui/app.ts:153`）是整个 UI 的状态容器。它用 Lit 的 `@state()` 装饰器声明大量响应式状态——任何 `@state()` 字段变化都会触发重渲染。摘录几组：

```ts
// ui/src/ui/app.ts:153
export class OpenClawApp extends LitElement {
  readonly i18nController = new I18nController(this);
  clientInstanceId = generateUUID();
  @state() settings: UiSettings = loadSettings();
  // ...
  @state() tab: Tab = "chat";
  @state() connected = false;
  @state() theme: ThemeName = this.settings.theme ?? "claw";
  @state() hello: GatewayHelloOk | null = null;
  // ...
  @state() sessionKey = this.settings.sessionKey;
  @state() chatSending = false;
  @state() chatMessages: unknown[] = [];
  @state() chatToolMessages: unknown[] = [];
}
```

可以把 `OpenClawApp` 理解成「单一巨型状态对象 + 渲染入口」。它不持有 RPC、事件分发、聊天逻辑的实现——那些被拆到一堆无类的 `app-*.ts` 模块（`app-gateway.ts`、`app-chat.ts`、`app-lifecycle.ts`、`app-tool-stream.ts` 等），每个模块导出操作「host」对象的纯函数，`host` 就是 `OpenClawApp` 实例。这是一种刻意的「贫血组件 + 函数式控制器」架构：`LitElement` 只负责 state 和 render，业务逻辑全在可单测的纯函数里（仓库里 `app-gateway.node.test.ts`、`app-chat.test.ts` 等就是对这些函数的测试）。

渲染本身委托给 `renderApp`（`ui/src/ui/app-render.ts:895`）——`OpenClawApp.render()` 把自己的状态打包传给这个顶层函数。`renderApp` 在登录态未就绪时渲染登录门（`ui/src/ui/app-render.ts:906` 的 `renderLoginGate`），就绪后渲染主界面（侧边栏 + 当前 tab）。

---

## 12.3 WebSocket 协议

### 12.3.1 GatewayBrowserClient

前端与 gateway 的所有通信都经过一个 WebSocket，封装在 `GatewayBrowserClient`（`ui/src/ui/gateway.ts:438`）里。它管理三件事：连接生命周期、RPC 请求、事件订阅。

构造时即发起连接（`ui/src/ui/gateway.ts:458` 的 `this.connect()`）。`connect()`（`ui/src/ui/gateway.ts:477`）`new WebSocket(this.opts.url)`，并用 `connectGeneration` 计数器给每次连接打代号——后续所有回调都用 `isActiveSocket(ws, generation)`（`ui/src/ui/gateway.ts:745`）校验「这个回调是不是属于当前活跃连接」，避免旧连接的迟到事件污染新连接。

`connected` getter 直接看 socket 状态（`ui/src/ui/gateway.ts:473`）：

```ts
// ui/src/ui/gateway.ts:473
get connected() {
  return this.ws?.readyState === WebSocket.OPEN;
}
```

### 12.3.2 连接握手与鉴权

WebSocket 连上 ≠ 鉴权完成。OpenClaw 的握手是：连上后服务端先发一个 `connect.challenge` 事件带 `nonce`，客户端再发 `connect` RPC 带凭据。`handleMessage`（`ui/src/ui/gateway.ts:771`）里能看到 challenge 处理：

```ts
// ui/src/ui/gateway.ts:782
if (evt.event === "connect.challenge") {
  const payload = evt.payload as { nonce?: unknown } | undefined;
  const nonce = payload && typeof payload.nonce === "string" ? payload.nonce : null;
  if (nonce) {
    this.connectNonce = nonce;
    void this.sendConnect(ws, generation);
  }
  return;
}
```

`sendConnect`（`ui/src/ui/gateway.ts:749`）构造连接计划并发出 `connect` RPC。鉴权计划由 `buildConnectPlan`（`ui/src/ui/gateway.ts:614`）拼出，核心逻辑是**设备身份优先、token 兜底**：

```ts
// ui/src/ui/gateway.ts:620
// crypto.subtle 只在安全上下文（HTTPS、localhost）可用。
// 纯 HTTP 下跳过设备身份，退回到 token-only 鉴权。
const isSecureContext = typeof crypto !== "undefined" && !!crypto.subtle;
let deviceIdentity: ... = null;
let selectedAuth: SelectedConnectAuth = { authToken: explicitGatewayToken, ... };

if (isSecureContext) {
  deviceIdentity = await loadOrCreateDeviceIdentity();
  selectedAuth = this.selectConnectAuth({ role, deviceId: deviceIdentity.deviceId });
}
```

`loadOrCreateDeviceIdentity` 用 `@noble/ed25519` 在浏览器生成一对密钥（持久化在本地存储）。`selectConnectAuth`（`ui/src/ui/gateway.ts:835`）在「显式 token / 显式密码 / 已存设备 token」之间挑选凭据。握手成功后服务端在 `hello` 里下发 `deviceToken`，`handleConnectHello`（`ui/src/ui/gateway.ts:659`）把它存起来：

```ts
// ui/src/ui/gateway.ts:671
if (hello?.auth?.deviceToken && plan.deviceIdentity) {
  storeDeviceAuthToken({
    deviceId: plan.deviceIdentity.deviceId,
    role: hello.auth.role ?? plan.role,
    token: hello.auth.deviceToken,
    scopes: hello.auth.scopes ?? [],
  });
}
```

这样下次连接就能用设备 token 免密。`buildConnectParams`（`ui/src/ui/gateway.ts:599`）里 `caps: ["tool-events"]` 声明客户端有能力接收工具事件——服务端据此决定要不要把工具流推给它。

握手失败由 `handleConnectFailure`（`ui/src/ui/gateway.ts:683`）处理：区分「需要用户介入的不可恢复错误」（token 不匹配等）和「值得重连的临时错误」，并实现 `retry_with_device_token` 这类恢复建议。

### 12.3.3 三种 WebSocket 帧

`handleMessage`（`ui/src/ui/gateway.ts:771`）解析进来的每条消息。帧有 `type` 字段，三种取值：

**`event` 帧**（`ui/src/ui/gateway.ts:780`）：服务端推送的事件。前端检查 `seq` 单调性，跳号则调 `onGap`；然后分发给所有 `eventListeners`：

```ts
// ui/src/ui/gateway.ts:791
const seq = typeof evt.seq === "number" ? evt.seq : null;
if (seq !== null) {
  if (this.lastSeq !== null && seq > this.lastSeq + 1) {
    this.opts.onGap?.({ expected: this.lastSeq + 1, received: seq });
  }
  this.lastSeq = seq;
}
this.opts.onEvent?.(evt);
for (const listener of this.eventListeners) {
  listener(evt);
}
```

`seq` 即上一章 `server-broadcast.ts` 逐客户端打的递增序号——前后端共同维护这条序列，丢事件能被立刻发现。

**`res` 帧**（`ui/src/ui/gateway.ts:809`）：RPC 响应。按 `id` 在 `pending` Map 里找到对应的 Promise，resolve 或 reject：

```ts
// ui/src/ui/gateway.ts:810
const res = parsed as GatewayResponseFrame;
const pending = this.pending.get(res.id);
if (!pending) { return; }
this.pending.delete(res.id);
if (res.ok) {
  this.emitRequestTiming(res.id, pending, true);
  pending.resolve(res.payload);
} else {
  this.emitRequestTiming(res.id, pending, false, res.error?.code);
  pending.reject(new GatewayRequestError({ ... }));
}
```

**`req` 帧**：由客户端发出（见下节），不在 `handleMessage` 里处理。

### 12.3.4 发 RPC：request

`request`（`ui/src/ui/gateway.ts:869`）是发 RPC 的公开入口：

```ts
// ui/src/ui/gateway.ts:876
private requestOnSocket<T = unknown>(ws: WebSocket, method: string, params?: unknown): Promise<T> {
  if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("gateway not connected"));
  }
  const id = generateUUID();
  const frame = { type: "req", id, method, params };
  const startedAtMs = this.nowMs();
  const p = new Promise<T>((resolve, reject) => {
    this.pending.set(id, { resolve: (v) => resolve(v as T), reject, method, startedAtMs });
  });
  ws.send(JSON.stringify(frame));
  return p;
}
```

经典的 request/response over WebSocket：每个请求生成 UUID 作 `id`，把 `{resolve, reject}` 存进 `pending` Map，等 `res` 帧回来按 `id` 配对。`startedAtMs` 用于 `onRequestTiming` 遥测——前端能统计每个 RPC 方法的耗时。

`addEventListener`（`ui/src/ui/gateway.ts:894`）注册事件监听器并返回一个取消函数。

### 12.3.5 重连

`scheduleReconnect`（`ui/src/ui/gateway.ts:541`）实现退避重连。`backoffMs` 起步 800ms，握手成功后重置（`ui/src/ui/gateway.ts:679` 的 `this.backoffMs = 800`）。`socket.onclose` 里区分错误类型：`isNonRecoverableAuthError`（`ui/src/ui/gateway.ts:532`）为真就不重连（token 错了重连无意义），否则 `scheduleReconnect()`。`flushPending`（`ui/src/ui/gateway.ts:558`）在连接断开时把所有在途 RPC 用 `CLIENT_CLOSED` 错误 reject 掉，不让它们永久 pending。

---

## 12.4 实时渲染

### 12.4.1 事件分发：从 socket 到状态

`app-gateway.ts` 的 `onEvent` 回调（`ui/src/ui/app-gateway.ts:632`）是事件进入应用的总闸：

```ts
// ui/src/ui/app-gateway.ts:632
onEvent: (evt) => {
  if (host.client !== client) { return; }
  handleGatewayEvent(host, evt);
},
```

`handleGatewayEvent`（`ui/src/ui/app-gateway.ts:658`）包了一层 `try/catch` 防止单个事件处理崩溃拖垮整个流，内部 `handleGatewayEventUnsafe` 按 `evt.event` 路由：

```ts
// ui/src/ui/app-gateway.ts:863
if (evt.event === "agent") {
  // ...
  handleAgentEvent(host as unknown as Parameters<typeof handleAgentEvent>[0], ...);
}
// ...
if (evt.event === "chat") {
  // ... handleChatEvent
}
```

`"agent"` 事件 → `handleAgentEvent`（处理工具流、生命周期）；`"chat"` 事件 → `handleChatEvent`（处理高层对话状态）。这正好对应第 11 章广播侧的两个事件名。

### 12.4.2 文本流式渲染：handleChatEvent

`handleChatEvent`（`ui/src/ui/controllers/chat.ts:661`）处理 `"chat"` 事件。`payload.state` 决定怎么更新状态：

```ts
// ui/src/ui/controllers/chat.ts:704
if (payload.state === "delta") {
  const next = extractText(payload.message);
  if (typeof next === "string" && !isSilentReplyStream(next) && ...) {
    state.chatStream = next;
  }
} else if (payload.state === "final") {
  const finalMessage = normalizeFinalAssistantMessage(payload.message);
  if (finalMessage && !shouldHideAssistantChatMessage(finalMessage)) {
    state.chatMessages = [...state.chatMessages, finalMessage];
  } else if (state.chatStream?.trim() && ...) {
    state.chatMessages = [...state.chatMessages, {
      role: "assistant",
      content: [{ type: "text", text: state.chatStream }],
      timestamp: Date.now(),
    }];
  }
  reconcileTerminalRun("done", "done");
}
```

关键状态字段两个：

- `state.chatStream`：当前正在流入的助手文本（增量）。`delta` 事件不断覆盖它。因为它是 `@state()`，每次赋值都触发重渲染——这就是「打字效果」的来源。
- `state.chatMessages`：已定稿的消息数组。`final` 事件把流式文本「凝固」成一条消息追加进去，同时清空 `chatStream`。

注意 `final` 的兜底逻辑：如果 `payload.message` 为空但 `chatStream` 里有内容，就用 `chatStream` 拼一条消息。这保证「服务端 final 没带 message，但客户端已经流式收到文本」时不丢内容——典型场景是上一章讲的 150ms 节流可能让最后一段 delta 卡在缓冲里。

`handleChatEvent` 一开始还做了归属过滤（`ui/src/ui/controllers/chat.ts:665`）：事件必须 `sessionKey` 匹配当前 session，**或** `runId` 匹配当前活跃 run，否则忽略——避免别的 session 的事件串台。

### 12.4.3 工具流：handleAgentEvent

工具调用的实时渲染走 `"agent"` 事件 → `handleAgentEvent`（`ui/src/ui/app-tool-stream.ts:636`）。它先按 `stream` 分流：

```ts
// ui/src/ui/app-tool-stream.ts:641
if (payload.stream === "compaction") { handleCompactionEvent(...); return; }
if (payload.stream === "lifecycle") { handleLifecycleCompactionEvent(...); ... return; }
if (payload.stream === "fallback") { handleLifecycleFallbackEvent(...); return; }
if (payload.stream !== "tool") { return; }
```

只有 `stream === "tool"` 才进入工具卡片逻辑。每个工具调用有个 `toolCallId`，`handleAgentEvent` 用它在 `host.toolStreamById` Map 里维护一条「工具流条目」。`data.phase` 区分阶段：

```ts
// ui/src/ui/app-tool-stream.ts:675
const phase = typeof data.phase === "string" ? data.phase : "";
const args = phase === "start" ? data.args : undefined;
const output =
  phase === "update"
    ? formatToolOutput(data.partialResult)
    : phase === "result"
      ? formatToolOutput(data.result)
      : undefined;
```

`start` 携带参数、`update` 携带部分结果、`result` 携带最终结果——这正是上一章说的「`stream:"tool"` + `data.phase`」三相位。

一个微妙处理：工具卡片首次出现时，要把「工具调用之前那段流式文本」先凝固成一个 segment，让它渲染在工具卡片**上方**而不是下方：

```ts
// ui/src/ui/app-tool-stream.ts:692
if (!entry) {
  if (host.chatRunId && payload.runId === host.chatRunId &&
      host.chatStream && host.chatStream.trim().length > 0) {
    host.chatStreamSegments = [...host.chatStreamSegments, { text: host.chatStream, ts: now }];
    host.chatStream = null;
    host.chatStreamStartedAt = null;
  }
  // ... 新建 entry
}
```

注释（`ui/src/ui/app-tool-stream.ts:665`）还点明一个坑：工具事件按 **session** 过滤、不按 `chatRunId` 过滤——因为客户端的 `chatRunId` 是自己生成的 UUID，而工具事件带的是服务端引擎 runId，两者永远不会相等。这与第 11 章「runId 重映射」是同一枚硬币的两面。

最后 `scheduleToolStreamSync`（`ui/src/ui/app-tool-stream.ts:730`）把工具流状态节流同步到 `chatToolMessages`，触发重渲染。

### 12.4.4 typing 指示器

agent 还在思考、还没产出文本时，界面要显示一个「正在输入」指示器。`renderChat`（`ui/src/ui/views/chat.ts:978`）里：

```ts
// ui/src/ui/views/chat.ts:980
const isBusy = props.sending || props.stream !== null;
// ...
const displayStream = props.stream ?? (canAbort ? "" : null);
```

`grouped-render.ts` 提供了两个相关渲染函数：`renderReadingIndicatorGroup`（`ui/src/ui/chat/grouped-render.ts:324`，「正在阅读」指示）和 `renderStreamingGroup`（`ui/src/ui/chat/grouped-render.ts:343`，渲染正在流入的文本）。逻辑是：

- run 已开始、但 `chatStream` 还是空 → 显示 reading/typing 指示器。
- `chatStream` 开始有内容 → 切到 streaming group，实时渲染增量文本。
- `final` 事件到达 → streaming group 消失，文本作为定稿消息出现在 message group 里。

因为 `chatStream`、`chatSending`、`chatRunId` 都是 `@state()`，Lit 在它们变化时自动重渲染——前端不需要手动「推动」UI，只要更新状态。

### 12.4.5 断线时的状态收敛

`app-gateway.ts` 在重连成功（`hello` 到达）后做孤儿 run 清理（`ui/src/ui/app-gateway.ts:563`）：断线窗口里那个 in-flight run 的 `final` 事件已经丢了，所以把它标记为 `interrupted` / `killed`，清掉本地 run 状态、流式文本、工具流。这是必要的收敛——否则 UI 会永远卡在「正在输入」。`pendingAbort` 也在这里补发（`ui/src/ui/app-gateway.ts:546`）。

---

## 12.5 Canvas 与富消息渲染

「富消息」在 Control UI 里分两类：**inline 富内容**（代码块、图片、语音，由消息渲染器直接处理）和 **Canvas 富面板**（agent 通过插件提供的可交互 HTML 界面，用 iframe 嵌入）。

### 12.5.1 Markdown 渲染与净化

聊天消息文本是 Markdown。`markdown.ts` 用 `markdown-it` 渲染、`DOMPurify` 净化：

```ts
// ui/src/ui/markdown.ts:1
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
```

`md` 实例（`ui/src/ui/markdown.ts:154`）配置了链接、任务列表等扩展。**所有渲染产物在插入 DOM 前都过 DOMPurify**——`sanitizeOptions`（`ui/src/ui/markdown.ts:59`）声明了允许的标签和属性白名单，`afterSanitizeAttributes` 钩子（`ui/src/ui/markdown.ts:108`）做进一步处理。注释（`ui/src/ui/markdown.ts:286`、`:398`）反复强调一个原则：渲染器本身可以宽松，DOMPurify 是最终安全网，负责剥掉危险的 URL scheme。聊天内容来自 LLM 输出和外部消息，必须当不可信数据对待。

### 12.5.2 代码块

`markdown.ts` 覆写了 markdown-it 的 fenced code 渲染规则（`ui/src/ui/markdown.ts:432` 一带），给每个代码块加：语言标签、复制按钮、JSON 折叠：

```ts
// ui/src/ui/markdown.ts:432
const codeBlock = `<pre><code${langClass}>${safeText}</code></pre>`;
const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : "";
const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" ...>...</button>`;
const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;
```

代码文本被塞进按钮的 `data-code` 属性。复制按钮的点击不在每个按钮上单独绑事件，而是在 `renderChat` 用**事件委托**统一处理（`ui/src/ui/views/chat.ts:1009`）：

```ts
// ui/src/ui/views/chat.ts:1009
const handleCodeBlockCopy = (e: Event) => {
  const btn = (e.target as HTMLElement).closest(".code-block-copy");
  if (!btn) { return; }
  const code = (btn as HTMLElement).dataset.code ?? "";
  navigator.clipboard.writeText(code).then( /* ... */ );
};
```

为什么用委托？因为代码块是 markdown 动态渲染出来的 innerHTML，没有 Lit 组件实例可挂监听器；在容器上委托是处理「动态生成的 HTML 里的交互」的标准手法。缩进式代码块（`code_block` 规则，`ui/src/ui/markdown.ts:455`）同样处理。

### 12.5.3 图片与语音

消息 content 是结构化 block 数组。在 `sendChatMessage`（`ui/src/ui/controllers/chat.ts:503`）里能看到 block 的形状——`type` 可以是 `text` / `image` / `attachment`：

```ts
// ui/src/ui/controllers/chat.ts:530
contentBlocks.push({
  type: "image",
  url: previewUrl,
  source: { type: "url", url: previewUrl },
});
// ...
contentBlocks.push({
  type: "attachment",
  attachment: {
    url: previewUrl,
    kind: att.mimeType.startsWith("audio/") ? "audio" : "document",
    label: att.fileName?.trim() || "Attached file",
    mimeType: att.mimeType,
  },
});
```

`image` block 渲染成 `<img>`，`attachment` block 按 `kind` 渲染——`audio` 渲染成带播放控件的语音/音频元素，`document` 渲染成可下载的文件卡片。语音消息（agent 用 TTS 产出的、对应第 11 章 `audioAsVoice` 的 payload）在前端就是一个 `kind: "audio"` 的 attachment block，带 `<audio>` 播放器。

### 12.5.4 Canvas 富面板

「Canvas」在 OpenClaw 里**不是 HTML5 `<canvas>` 画布**，而是 agent 通过插件提供的**可交互富界面面板**——比如一个 agent 生成的小型 Web 应用、A2UI（agent-to-UI）界面。它以 iframe 形式嵌入聊天界面。

URL 解析逻辑全在 `canvas-url.ts`。三个路径常量（`ui/src/ui/canvas-url.ts:1`）：

```ts
// ui/src/ui/canvas-url.ts:1
const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
```

`resolveCanvasIframeUrl`（`ui/src/ui/canvas-url.ts:39`）把 agent 给的原始 entry URL 解析成一个能安全嵌进 iframe 的 URL。它的核心是安全过滤——`sanitizeCanvasEntryUrl`（`ui/src/ui/canvas-url.ts:18`）：

```ts
// ui/src/ui/canvas-url.ts:18
function sanitizeCanvasEntryUrl(rawEntryUrl: string, allowExternalEmbedUrls = false): string | undefined {
  try {
    const entry = new URL(rawEntryUrl, "http://localhost");
    if (entry.origin !== "http://localhost") {
      if (!allowExternalEmbedUrls || !isExternalHttpUrl(entry)) {
        return undefined;        // 拒绝非本地、非允许的外部 URL
      }
      return entry.toString();
    }
    if (!isCanvasHttpPath(entry.pathname)) {
      return undefined;          // 本地 URL 必须落在 canvas/a2ui 白名单路径
    }
    return `${entry.pathname}${entry.search}${entry.hash}`;
  } catch {
    return undefined;
  }
}
```

设计意图很清楚：**默认只允许 gateway 自己托管的 `/__openclaw__/canvas` 与 `/__openclaw__/a2ui` 路径**。任意外部 URL 一律拒绝，除非显式开了 `allowExternalEmbedUrls`（对应 `OpenClawApp` 上的 `@state() allowExternalEmbedUrls`，`ui/src/ui/app.ts:200`）。这防止 agent 被诱导嵌入恶意外站。

`resolveCanvasIframeUrl` 还支持 capability-scoped 的插件面板：当 gateway 给出一个 `canvasPluginSurfaceUrl`（路径以 `/__openclaw__/cap` 开头），它会把 canvas 路径重写到那个带 capability 前缀的作用域 host 上（`ui/src/ui/canvas-url.ts:55`-`:70`）——让每个插件面板跑在自己的隔离 URL 空间里。

`canvasPluginSurfaceUrl` 从 `OpenClawApp` 一路传到 `renderChat`（`ui/src/ui/app-render.ts:1175`、`:1384`、`ui/src/ui/views/chat.ts:120`），最终由 chat 视图把解析出的 URL 设到 iframe 的 `src`。iframe 还配合 `embed-sandbox.ts` 与 `OpenClawApp` 上的 `embedSandboxMode`（`strict` / `scripts` / `trusted`，`ui/src/ui/app.ts:199`）施加 `sandbox` 属性，进一步约束被嵌内容能干什么。

---

## 12.6 组件结构

### 12.6.1 三层目录

`ui/src/ui/` 下的代码大致分三层：

**控制器层 `controllers/`** —— 业务逻辑的纯函数模块。`chat.ts`（聊天）、`sessions.ts`、`agents.ts`、`channels.ts`、`config.ts`、`models.ts`、`exec-approval.ts`、`cron.ts`、`health.ts`、`usage.ts`、`logs.ts` 等。每个文件操作一个 `host`/`state` 对象，不含渲染。它们都有对应的 `.test.ts`。

**视图层 `views/`** —— Lit `html\`\`` 模板。每个文件导出 `renderXxx` 函数。`chat.ts`（聊天界面）、`agents.ts`、`channels.*.ts`（各 channel 的配置表单，按平台分文件：`channels.telegram.ts`、`channels.discord.ts`、`channels.slack.ts`…）、`config*.ts`（配置编辑器）、`models.ts`、`overview.ts`、`logs.ts`、`cron.ts`、`exec-approval.ts`、`login-gate.ts` 等。

**聊天细分 `chat/`** —— 聊天界面被拆得很细：`grouped-render.ts`（消息分组渲染）、`tool-cards.ts`（工具卡片）、`run-controls.ts`（运行控制条）、`chat-queue.ts`（消息队列）、`slash-commands.ts`（斜杠命令）、`side-result-render.ts`（侧栏结果）、`realtime-talk*.ts`（实时语音对话，含 WebRTC）、`session-controls.ts`（session 与模型选择控件）等。

**根目录 `ui/src/ui/`** —— 跨层的 `app-*.ts` 模块（`app.ts`、`app-render.ts`、`app-gateway.ts`、`app-chat.ts`、`app-tool-stream.ts`、`app-lifecycle.ts`…）+ 工具模块（`gateway.ts`、`markdown.ts`、`tool-display.ts`、`canvas-url.ts`、`icons.ts`、`theme.ts`、`storage.ts`…）。

`components/` 目录则放真正的可复用 Lit 组件：`modal-dialog.ts`、`resizable-divider.ts`、`dashboard-header.ts`。

### 12.6.2 渲染入口与 tab 路由

`OpenClawApp.render()` → `renderApp`（`ui/src/ui/app-render.ts:895`）。`renderApp` 先判定登录态（`ui/src/ui/app-render.ts:906`），未就绪渲染 `renderLoginGate`；就绪后渲染主框架：侧边栏 + 当前 `tab` 对应的视图。`tab` 是 `OpenClawApp` 上的 `@state()`（`ui/src/ui/app.ts:166`），取值是聊天 / agents / channels / config / overview 等。视图懒加载由 `lazy-view.ts` 支持——非 chat 的重型视图按需加载，减小首屏体积。

### 12.6.3 工具卡片

工具卡片的「长什么样」由 `tool-display.ts` 决定。`resolveToolDisplay`（`ui/src/ui/tool-display.ts:100`）根据工具名查出图标、标题、动词、详情：

```ts
// ui/src/ui/tool-display.ts:100
export function resolveToolDisplay(params: { name?: string; args?: unknown; ... }): ToolDisplay {
  const name = normalizeToolName(params.name);
  const key = normalizeLowercaseStringOrEmpty(name);
  const spec = TOOL_MAP[key];
  const icon = (spec?.icon ?? FALLBACK.icon ?? "puzzle") as IconName;
  const title = spec?.title ?? defaultTitle(name);
  // ... 解析 verb 和 detail
}
```

值得注意的是 `TOOL_MAP` 的数据源：`ui/src/ui/tool-display.ts:1` 直接 `import` 了一个 JSON——`apps/shared/OpenClawKit/.../tool-display.json`。这是一份**跨端共享**的工具展示配置：Web UI 和原生 App（iOS/Android 的 OpenClawKit）读同一份 JSON，保证「同一个工具在所有客户端图标标题一致」。`convertSpec`（`ui/src/ui/tool-display.ts:60`）把共享 JSON 里的 emoji 通过 `EMOJI_ICON_MAP`（`ui/src/ui/tool-display.ts:36`）转成 Web UI 的图标名——共享配置用 emoji 描述（平台中立），Web UI 再映射到自己的 SVG 图标集。

`shortenHomeInString`（`ui/src/ui/tool-display.ts:79`）把工具详情里的 `/Users/xxx`、`/home/xxx`、`C:\Users\xxx` 缩成 `~`——注释（`ui/src/ui/tool-display.ts:84`）特意说明用纯正则而不 import Node-only 模块，以免破坏 Vite 在 Docker/CI 里的构建。

### 12.6.4 设置与模型选择

设置散布在 `views/config*.ts`（配置编辑器，含 JSON5 解析）、`app-settings.ts`（本地 UI 偏好）、`theme.ts`（主题）等。

模型选择没有一个独立的 "model picker" 组件，逻辑在 `chat-model-select-state.ts` + `chat/session-controls.ts`。`chat-model-select-state.ts` 导出 `resolveChatModelSelectState`（`ui/src/ui/chat-model-select-state.ts:88`）和 `resolveChatModelOverrideValue`（`:34`），把「当前 session 的模型覆盖」算成一个下拉选择状态；`session-controls.ts` 渲染那个下拉。模型本身的目录由 `controllers/models.ts` 拉取。`renderChat` 里读 `activeSession?.reasoningLevel`（`ui/src/ui/views/chat.ts:986`）决定要不要显示 reasoning——模型能力直接影响界面元素的取舍。

---

## 12.7 一次 chat.send 的完整前端旅程

把本章串起来，跟踪用户点「发送」之后前端发生了什么：

<svg viewBox="0 0 760 640" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="chat.send 完整前端旅程：从用户点发送到 Lit 渲染更新的 10 个步骤">
  <defs>
    <marker id="ar4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
    </marker>
    <marker id="ar5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0ea5e9"/>
    </marker>
    <marker id="ar6" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#7c3aed"/>
    </marker>
  </defs>
  <line x1="60" y1="28" x2="60" y2="622" stroke="#cbd5e1" stroke-width="1.5"/>
  <circle cx="60" cy="40" r="11" fill="#ea580c"/>
  <text x="60" y="44" text-anchor="middle" font-size="10" font-weight="700" fill="white">1</text>
  <rect x="82" y="26" width="380" height="28" rx="4" fill="#fed7aa" stroke="#ea580c" stroke-width="1.2"/>
  <text x="272" y="44" text-anchor="middle" font-size="11" font-weight="600" fill="#ea580c">用户在 composer 输入文本、点发送</text>
  <line x1="60" y1="54" x2="60" y2="74" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar4)"/>
  <circle cx="60" cy="88" r="11" fill="#ea580c"/>
  <text x="60" y="92" text-anchor="middle" font-size="10" font-weight="700" fill="white">2</text>
  <rect x="82" y="74" width="480" height="76" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="322" y="91" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">sendChatMessage(state, message, attachments)</text>
  <text x="322" y="105" text-anchor="middle" font-size="10" fill="#64748b">controllers/chat.ts:483　　组装 contentBlocks（text / image / attachment）</text>
  <text x="322" y="119" text-anchor="middle" font-size="10" fill="#64748b">state.chatMessages = [...旧, {role:"user", ...}]　→　乐观渲染（零延迟反馈）</text>
  <text x="322" y="133" text-anchor="middle" font-size="10" fill="#64748b">runId = generateUUID()　　chatSending = true　　chatStream = ""</text>
  <line x1="60" y1="150" x2="60" y2="170" stroke="#cbd5e1" stroke-width="1.5" marker-end="url(#ar4)"/>
  <circle cx="60" cy="184" r="11" fill="#ea580c"/>
  <text x="60" y="188" text-anchor="middle" font-size="10" font-weight="700" fill="white">3</text>
  <rect x="82" y="170" width="480" height="60" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="322" y="187" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">requestChatSend(state, {message, attachments, runId})</text>
  <text x="322" y="201" text-anchor="middle" font-size="10" fill="#64748b">controllers/chat.ts:416　　client.request("chat.send", {..., idempotencyKey: runId})</text>
  <text x="322" y="216" text-anchor="middle" font-size="10" fill="#94a3b8">idempotencyKey 保证重发不被服务端执行两次</text>
  <line x1="60" y1="230" x2="60" y2="250" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#ar5)"/>
  <circle cx="60" cy="264" r="11" fill="#0ea5e9"/>
  <text x="60" y="268" text-anchor="middle" font-size="10" font-weight="700" fill="white">4</text>
  <rect x="82" y="250" width="480" height="56" rx="4" fill="#f0f9ff" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="322" y="267" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">GatewayBrowserClient.request → requestOnSocket</text>
  <text x="322" y="281" text-anchor="middle" font-size="10" fill="#64748b">gateway.ts:876　　frame = { type:"req", id, method:"chat.send", params }</text>
  <text x="322" y="295" text-anchor="middle" font-size="10" fill="#64748b">pending.set(id, {resolve, reject})　　ws.send(JSON.stringify(frame))</text>
  <rect x="82" y="316" width="480" height="28" rx="4" fill="#0ea5e9"/>
  <text x="322" y="334" text-anchor="middle" font-size="11" font-weight="700" fill="white">WebSocket → gateway（第 11 章）</text>
  <line x1="60" y1="306" x2="60" y2="316" stroke="#0ea5e9" stroke-width="1.5"/>
  <line x1="60" y1="344" x2="60" y2="364" stroke="#0ea5e9" stroke-width="1.5" marker-end="url(#ar5)"/>
  <circle cx="60" cy="378" r="11" fill="#0ea5e9"/>
  <text x="60" y="382" text-anchor="middle" font-size="10" font-weight="700" fill="white">5</text>
  <rect x="82" y="364" width="480" height="56" rx="4" fill="#f0f9ff" stroke="#0ea5e9" stroke-width="1.2"/>
  <text x="322" y="381" text-anchor="middle" font-size="11" font-weight="600" fill="#0ea5e9">gateway 流式回推 event 帧</text>
  <text x="322" y="395" text-anchor="middle" font-size="10" fill="#64748b">event "agent" (stream="assistant", data.text/delta)</text>
  <text x="322" y="409" text-anchor="middle" font-size="10" fill="#64748b">event "agent" (stream="tool", data.phase)　　event "chat" (state="delta" | "final")</text>
  <line x1="60" y1="420" x2="60" y2="440" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
  <circle cx="60" cy="454" r="11" fill="#64748b"/>
  <text x="60" y="458" text-anchor="middle" font-size="10" font-weight="700" fill="white">6</text>
  <rect x="82" y="440" width="480" height="28" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="322" y="457" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">GatewayBrowserClient.handleMessage　gateway.ts:771</text>
  <text x="322" y="469" text-anchor="middle" font-size="10" fill="#64748b">type==="event" → 校验 seq → onEvent + eventListeners</text>
  <line x1="60" y1="468" x2="60" y2="488" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#ar4)"/>
  <circle cx="60" cy="502" r="11" fill="#64748b"/>
  <text x="60" y="506" text-anchor="middle" font-size="10" font-weight="700" fill="white">7</text>
  <rect x="82" y="488" width="480" height="42" rx="4" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1.2"/>
  <text x="322" y="505" text-anchor="middle" font-size="11" font-weight="600" fill="currentColor">app-gateway.ts onEvent → handleGatewayEvent　app-gateway.ts:632</text>
  <text x="322" y="519" text-anchor="middle" font-size="10" fill="#64748b">evt.event==="agent" → handleAgentEvent（工具流 / 生命周期）　　evt.event==="chat" → handleChatEvent</text>
  <line x1="60" y1="530" x2="60" y2="550" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#ar6)"/>
  <circle cx="60" cy="564" r="11" fill="#7c3aed"/>
  <text x="60" y="568" text-anchor="middle" font-size="10" font-weight="700" fill="white">8</text>
  <rect x="82" y="550" width="480" height="28" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="322" y="567" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">handleChatEvent: state==="delta" → chatStream = next</text>
  <text x="322" y="580" text-anchor="middle" font-size="10" fill="#64748b">@state 变化 → Lit 重渲染 → renderStreamingGroup 实时显示打字</text>
  <rect x="82" y="596" width="480" height="28" rx="4" fill="#f5f3ff" stroke="#7c3aed" stroke-width="1.2"/>
  <text x="322" y="613" text-anchor="middle" font-size="11" font-weight="600" fill="#7c3aed">state==="final": chatMessages 追加定稿 · chatStream 清空 · chatSending=false</text>
  <line x1="60" y1="580" x2="60" y2="596" stroke="#7c3aed" stroke-width="1.5"/>
</svg>
<span class="figure-caption">图 R12.2 ｜ chat.send 完整前端旅程：从用户点发送到 Lit 响应式重渲染的 10 步调用链</span>

<details>
<summary>ASCII 原版</summary>

```
1. 用户在 composer 输入文本、点发送
        │
2. sendChatMessage(state, message, attachments)   ui/src/ui/controllers/chat.ts:483
        │  组装 user 消息的 contentBlocks（text / image / attachment）
        │  state.chatMessages = [...旧, {role:"user", content, timestamp}]   → 乐观渲染
        │  state.chatSending = true
        │  runId = generateUUID()                  客户端自己生成 runId
        │  state.chatRunId = runId
        │  state.chatStream = ""                    准备接收流式文本
        │
3. requestChatSend(state, {message, attachments, runId})   ui/src/ui/controllers/chat.ts:416
        │  state.client.request("chat.send", {
        │    sessionKey, sessionId?, message, deliver: false,
        │    idempotencyKey: runId, attachments,
        │  })
        │
4. GatewayBrowserClient.request → requestOnSocket   ui/src/ui/gateway.ts:876
        │  frame = { type:"req", id, method:"chat.send", params }
        │  pending.set(id, {resolve, reject, ...})
        │  ws.send(JSON.stringify(frame))
        │
   ─────────────── WebSocket ───────────────→ gateway（第 11 章）
        │
5. gateway 流式回推 event 帧：
        │  event "agent" (stream="assistant", data.text/delta)
        │  event "agent" (stream="tool", data.phase)
        │  event "chat"  (state="delta" | "final")
        │
6. GatewayBrowserClient.handleMessage   ui/src/ui/gateway.ts:771
        │  type==="event" → 校验 seq → onEvent + eventListeners
        │
7. app-gateway.ts onEvent → handleGatewayEvent   ui/src/ui/app-gateway.ts:632
        │  evt.event==="agent" → handleAgentEvent  → 更新工具流 / 生命周期
        │  evt.event==="chat"  → handleChatEvent   → 更新 chatStream / chatMessages
        │
8. handleChatEvent: state==="delta" → state.chatStream = next   ui/src/ui/controllers/chat.ts:704
        │  @state 变化 → Lit 重渲染 → renderStreamingGroup 实时显示打字
        │
9. handleChatEvent: state==="final"
        │  → chatMessages 追加定稿消息，chatStream 清空
        │  → reconcileTerminalRun("done","done")，chatSending=false
        │
10. handleAgentEvent: 若有工具事件 → final 后 loadChatHistory 重载
         以持久化的工具结果替换已清空的流式状态   ui/src/ui/app-gateway.ts (handleTerminalChatEvent)
```

</details>

注意第 2 步的**乐观渲染**：用户消息在 RPC 还没发出之前就立刻进 `chatMessages` 显示出来，界面零延迟有反馈。`chat.send` 的 `idempotencyKey` 用的就是客户端 `runId`——同一条消息重发不会被服务端执行两次。第 8 步的「打字效果」纯粹是 `@state() chatStream` 反复赋值 + Lit 自动重渲染的副产物，没有任何手写的动画代码。

---

## 12.8 小结

- Control UI 的真实技术栈是 **Lit（Web Components）+ Vite + 全局 CSS + markdown-it + DOMPurify**——**不是 React，不是 CSS Modules**。心智映射：组件 = `LitElement`，状态 = `@state()`，模板 = `html\`\``。
- 启动链：`index.html` → `main.ts`（注册 SW + 引入 app）→ `app.ts` 注册 `<openclaw-app>` 自定义元素（`ui/src/ui/app.ts:1305`）。
- 架构是「贫血 `LitElement` + 函数式控制器」：`OpenClawApp` 只持有 `@state()` 状态、渲染委托给 `renderApp`；业务逻辑全在可单测的 `app-*.ts` / `controllers/*.ts` 纯函数里。
- 前后端通信走单条 WebSocket，封装在 `GatewayBrowserClient`（`ui/src/ui/gateway.ts:438`）。握手是 `connect.challenge` → `connect` RPC，鉴权优先设备身份（ed25519）、token 兜底。三种帧：`req` / `res`（RPC）+ `event`（推送），`event` 帧带 `seq` 做丢事件检测。
- 实时渲染靠 `@state()` 的响应式：`chatStream` 接收 `"chat"` delta 事件产生打字效果，`final` 把它凝固进 `chatMessages`；`handleAgentEvent` 按 `toolCallId` + `data.phase` 维护工具卡片流。
- 富消息：Markdown 经 markdown-it 渲染 + DOMPurify 净化（安全网思维）；代码块加复制按钮并用事件委托处理；图片/语音是结构化 content block。
- **Canvas** 指 agent 通过插件提供的可交互 iframe 富面板（非 HTML5 canvas）。`canvas-url.ts` 默认只允许 gateway 自托管的 `/__openclaw__/canvas` 与 `/__openclaw__/a2ui` 路径，外部 URL 须显式放行。
- 组件按 `controllers/`（逻辑）、`views/`（模板）、`chat/`（聊天细分）、`components/`（可复用组件）四层组织；工具卡片展示读跨端共享的 `tool-display.json`。
- 一次 `chat.send`：乐观渲染用户消息 → `request("chat.send")` over WebSocket → 流式收 `agent`/`chat` 事件 → `@state()` 更新驱动 Lit 重渲染。
