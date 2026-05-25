# NanoClaw 中文参考 Wiki（非官方学习笔记）

> **分析的版本**：[`nanocoai/nanoclaw@0683c6e`](https://github.com/nanocoai/nanoclaw/tree/0683c6e)（v2.0.64，2026-05-18）。所有 `file:line` 引用、跳转链接都锁定在这个 commit——你点开链接看到的代码跟 wiki 写的时候是一致的。
>
> **免责声明**：本仓库是个人学习 [NanoClaw](https://github.com/nanocoai/nanoclaw) 源码时整理的中文笔记，**与 nanocoai 官方无任何关联**，未获其背书。所有解读基于本人理解，可能有误，准确性以源码为准。
>
> **AI 协助声明**：本仓库的章节正文与可视化由 Claude（Anthropic）协助生成，作者审阅并迭代修订。本仓库是 mono-repo——按「项目 / 版本」分目录存放多份 wiki，旧版本同时保留可查，见下方「多项目 / 多版本」。

---

## 这是什么

一份**面向第一次想认真读 NanoClaw 源码的人**的中文 wiki，包含：

- **18 步单条 CLI 消息 Trace 导览**：跟 `pnpm run chat "ping"` 这一次最简单的真实请求，按"当前情境 → 问题 → 朴素思路 → 为何崩 → 实际做法 → 代码位置 → 分支延伸 → 你脑子里多了什么"的固定 8 段模板，把消息穿过 router → inbound.db → container → poll-loop → Claude SDK → outbound.db → delivery 全链路一步步拆开
- **15 章参考手册**：覆盖架构总览、双 runtime 布局、三 DB 数据模型、实体模型与权限、host 入口与生命周期、入站路由、会话/容器生命周期、agent-runner 轮询循环、出站投递、60 秒 sweep、通道适配器、OneCLI 凭证与审批、ncl CLI 与 self-mod、v1→v2 迁移、术语表 + FAQ
- **手写架构图**：覆盖四层架构（接入层 / Host 调度层 / Agent 运行时 / 存储与基础设施）、关键状态机、调用流
- **交互式网页**：术语弹窗、全文搜索、键盘导航、可点击架构图、`file:line` 直跳 GitHub

---

## 多项目 / 多版本

本仓库是一个 mono-repo，三级结构 `仓库 / 项目 / 版本 / wiki`：

- 仓库根的 `index.html` 是**项目选择页**，列出所有项目。
- 每个项目目录下的 `index.html` 是**版本选择页**，列出该项目的所有版本。
- 进入某个版本后，查看器顶栏有**项目下拉**和**版本下拉**，可直接切换。
- 每个版本的 `file:line` 链接锁定在该版本分析时的 commit，互不影响。

## 怎么看

### 在线预览（推荐）

**<https://xgliu515.github.io/codebase-wikis/>**

### 本地打开

```bash
git clone https://github.com/xgliu515/codebase-wikis.git
cd codebase-wikis
python3 -m http.server 8765
# 浏览器打开 http://localhost:8765/ —— 先看到项目选择页，选项目 → 版本 → wiki
```

### 直接看 markdown

GitHub 仓库视图能渲染所有 markdown 和 SVG，只是交互功能需要浏览器。

---

## `file:line` 链接：默认 GitHub，可切本地 VSCode

文档里大量出现的 `path/to/file.ts:123` 这类引用，在网页版都是可点击链接。

**GitHub 模式（默认）**：点击 → 浏览器新 tab 打开 `nanocoai/nanoclaw` 在 `0683c6e` commit 下的对应行号。开箱即用。

**本地 VSCode 模式（可选）**：点顶栏右上角"**源码**"按钮，填本地 clone 的绝对路径，切换到 VSCode 跳转。设置存在 localStorage，做一次就行。

---

## 章节地图

### 单条 CLI 消息 Trace 导览（19 步，跟 `pnpm run chat "ping"`）

00. 导览总览
01. 客户端连上 CLI socket
02. CLI adapter 收到字节
03. onInbound 进入 channel-registry
04. router 解析 messaging_group
05. router 解析 agent_group
06. 权限检查 canAccessAgentGroup
07. session-manager 解析/创建 session
08. 写 messages_in 并发出 wake
09. container-runner 拉起容器
10. 容器内 agent-runner 启动
11. poll-loop 拿到 messages_in
12. formatter 组装 prompt
13. provider.query() 调用 Claude
14. 流式 push() 中途更新
15. 写入最终 messages_out
16. host delivery 轮询发现新行
17. adapter.deliver 写回 CLI client
18. 客户端打印并退出

### 15 章参考手册

01. 总览：一切皆消息
02. 代码布局与构建拓扑
03. 三 DB 数据模型
04. 实体模型与权限
05. Host 入口与生命周期
06. 入站路由 (router.ts)
07. 会话与容器生命周期
08. Agent-runner：容器内的轮询循环
09. 出站投递与系统动作
10. 60 秒 Sweep
11. 通道适配器与 Chat SDK 桥
12. 审批与凭证：OneCLI 网关
13. ncl CLI 与 self-modification
14. v1 → v2 迁移
15. 术语表 + FAQ + 速查

---

## 网页特性

- **3 栏布局**：左侧章节导航 / 中间正文 / 右侧本页 TOC（带 scrollspy 高亮）
- **首页可交互架构图**：点 4 层中任意一层跳转，可"播放"一次请求穿过 4 层的动画
- **术语高亮 + 弹窗**：正文中的术语自动加虚线下划线；点击弹出右侧 panel 显示定义，定义内可再点其它术语递归展开
- **全文搜索**：客户端 MiniSearch 索引所有文档（中英文）
- **`file:line` → 跳转**：默认 GitHub，可切 VSCode（见上）
- **键盘**：`/` 搜索、`j`/`k` 翻章、`t` 主题、`g h` 回首页、`Esc` 关弹窗
- **深 / 浅主题**：本地存储记忆，初次跟随系统

---

## 贡献

- 错误、行号失效 → 欢迎 Issue
- 想补章节或图 → 欢迎 PR，但先 Issue 讨论
- 大段重写不建议——架构和文风已成型

---

## License

[MIT](../../LICENSE)。NanoClaw 项目本身的 license 见上游；本仓库引用的所有源码 `file:line` 归 nanocoai 及其贡献者所有。

---

*用 [codebase-wiki](https://github.com/xgliu515/codebase-wiki) skill 生成。*
