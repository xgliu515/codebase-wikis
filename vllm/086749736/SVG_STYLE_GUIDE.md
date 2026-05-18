# SVG 图风格指南（vllm-wiki 内部使用）

把 wiki 里所有有价值的 ASCII 图升级为 SVG 时，**严格按本指南**，保证 30 个文件里 80+ 张图视觉风格统一。

---

## 文件命名 / 图号

- **tour 文件中的图**：`图 T<N>.<seq>` —— N 是 tour 编号（去前导零），seq 是该文件内顺序号
  - 例：tour-01 第 1 张 → **图 T1.1**；tour-10 第 1 张 → **图 T10.1**
- **参考章节中的图**：`图 R<N>.<seq>`
  - 例：02-core-concepts 第 1 张 → **图 R2.1**；第 6 张 → **图 R2.6**

理由：T/R 前缀让读者一眼看出图在 tour 还是参考手册（之前没前缀，"图 1.1" 跟 "图 10.1" 同在一个 tour 里，但 "图 2.1" 却在另一个 doc set 里，造成误导）。

---

## 整体格式（必须照搬）

每张图按以下顺序插入：

```markdown
<svg viewBox="0 0 W H" xmlns="http://www.w3.org/2000/svg" class="figure-svg" role="img" aria-label="简短英文描述（screen reader 用）">
  <defs>...</defs>
  ...SVG 内容...
</svg>
<span class="figure-caption">图 T3.1 ｜ 一句话描述图在讲什么</span>

<details>
<summary>ASCII 原版</summary>

\`\`\`
[原 ASCII 一字不改地放这里]
\`\`\`

</details>
```

注意：
- `<svg>` 标签开头**不能有缩进**（必须在行首）
- **SVG 内部不能有空行**，否则 marked.js 会把它当成 HTML 块结束
- **SVG 内部不能有 HTML 注释** `<!-- -->`，同上原因
- `<details>` / `</details>` / 代码块前后保留空行（markdown 块语义需要）
- caption 用 `<span class="figure-caption">` 而不是另起段落，避免段距冲突

---

## 哪些 ASCII 要转成 SVG

**要转**：
- 分层架构图（多个 box 上下堆叠 + 箭头穿过）
- 数据结构图（block table 映射、内存布局、链表、tree）
- 状态机 / 状态转移图
- 数据流 / 调用关系图
- 时间线 / 序列图
- 对比图（naive vs 优化 / before vs after）
- 散点 / 矩阵 / 表格化的 visual layout

**不要转**：
- 单纯的目录树 / 文件路径列表（保留 ASCII 即可，转 SVG 没增值）
- 代码片段（不是图）
- 纯文本表格（用 markdown 表格更好）
- 简单的 `A → B → C` 单行流程（保留即可）

判断不准时：**转**。

---

## 颜色调色板（必须用这些，保证全局一致）

| 用途 | 色值 | 备注 |
|------|------|------|
| **category 1 / 主角橙** | `#ea580c` | 与全站 accent 一致，最重要的元素 |
| category 1 soft | `#fed7aa` | 浅版（背景色用） |
| **category 2 / 青** | `#0d9488` | 第二个分类 |
| category 2 soft | `#99f6e4` | |
| **category 3 / 紫** | `#7c3aed` | 第三个分类 |
| category 3 soft | `#ddd6fe` | |
| **category 4 / 蓝** | `#0ea5e9` | 第四个分类（少用） |
| **错误 / 警告 / wasted** | `#dc2626` 边框 / `#fef2f2` 背景 / `#fca5a5` 斜纹 | naive 浪费区域 |
| **成功 / 高亮** | `#16a34a` 边框 / `#f0fdf4` 背景 | vllm 优化后 |
| **结构 / 边框** | `#cbd5e1` | 浅边框 |
| **结构 / 重边框** | `#94a3b8` | 重边框 / 箭头 |
| **次文字** | `#64748b` | 标签 |
| **辅助文字** | `#94a3b8` | 灰提示 |
| **背景灰格** | `#f1f5f9` | free / 未占用块 |
| **强调文字** | `currentColor` | 用此让深浅主题自动跟随 |

---

## SVG 写法约定

### 推荐 viewBox 尺寸
- 横向图：760 × 280-340（高度按内容调）
- 对比图（左右双面板）：880 × 380-440
- 数据结构图：760 × 320-420
- 时间线 / 序列图：760-880 × 240-360
- 纵向流程图：640 × 480-600

### `<defs>` 常用元素

```xml
<defs>
  <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0,0 L10,5 L0,10 z" fill="#94a3b8"/>
  </marker>
  <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <line x1="0" y1="0" x2="0" y2="6" stroke="#fca5a5" stroke-width="2"/>
  </pattern>
</defs>
```

marker id 用 `ar1`、`ar2`、`ar3` 区分（同页面多张图时避免 id 冲突——但实际页面只渲染当前 chapter 的图，所以一般无碰撞；保险起见单文件内的 id 不同就行）。

### 文字
- 标题：`font-size="13-14" font-weight="600-700" fill="currentColor"`
- 标签：`font-size="11" fill="#64748b"`
- 微小说明：`font-size="10" fill="#94a3b8"`
- 字体不指定 `font-family`，让 CSS 接管（CSS 已设好）

### 箭头 / 连线
- 实箭头：`stroke="#94a3b8" stroke-width="1.2" marker-end="url(#ar)"`
- 虚箭头（次要 / 类比连接）：再加 `stroke-dasharray="3,2"`
- 分隔线：`stroke="#cbd5e1" stroke-dasharray="4,3"`

### 圆角与边框
- 主要矩形：`rx="3"` 到 `rx="10"`，看大小
- 强调框：`stroke="#ea580c" stroke-width="1.5"`
- 弱化框：`stroke="#cbd5e1" stroke-width="1"`

---

## 参考样品

已实现的 3 张图就是范例：
- `tour-01-kv-cache-sizing.md` 的图 T1.1（横条 + 上下标注的"切显存"风格）
- `tour-10-paged-attention-kernel.md` 的图 T10.1（左中右三段，箭头连接）
- `02-core-concepts.md` 的图 R2.1（左右双面板对比）

**直接打开看 SVG 源码，照着写**。三张图覆盖了三种最常见的图式。

---

## 质量自检

提交前问自己：
1. 信息密度合适吗？太空 / 太挤？
2. 在浅色背景看清楚后，把 `<body data-theme="dark">` 切到深色还能看清吗？（用 `currentColor` 是关键）
3. 标签会不会和元素重叠？
4. category 颜色用得一致吗（不要这张图 A 是橙、那张图 A 又是青）
5. caption 一句话说清这张图在讲什么？
