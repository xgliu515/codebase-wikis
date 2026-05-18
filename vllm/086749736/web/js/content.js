import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15.0.4/lib/marked.esm.js';
// 用 jsdelivr 的 +esm 打包版：自带所有标准语言，不必逐个 register
import hljs from 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/+esm';
// LaTeX 数学公式渲染（KaTeX）。extension 必须在 marked 解析前注册，否则 $..$ 内部的 _ ^ 会被当 markdown 处理
import markedKatex from 'https://cdn.jsdelivr.net/npm/marked-katex-extension@5/+esm';

import { CHAPTER_BY_ID, TOURS, getRepoMode, VLLM_ANALYZED_COMMIT, VLLM_ANALYZED_TAG, VLLM_ANALYZED_DATE, VLLM_GITHUB_REPO } from './chapters.js';
import { parseFileRef, makeCodeURL, escapeHTML, slugify } from './utils.js';
import { renderMermaidIn } from './diagrams.js';
import { enhanceWithGlossary } from './glossary.js';

// =========================================================
// marked 配置：自定义 code 渲染器（mermaid + 语法高亮），自定义 heading 锚点
// =========================================================

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" data-source="${escapeHTML(text)}">⏳ 渲染中…</div>`;
  }
  const language = (lang && hljs.getLanguage(lang)) ? lang : 'plaintext';
  let highlighted;
  try {
    highlighted = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    highlighted = escapeHTML(text);
  }
  return `<pre><code class="hljs language-${language}">${highlighted}</code></pre>`;
};

// 给标题加上 id，便于本页 TOC 跳转
const usedIds = new Map();
function makeUniqueSlug(text) {
  const base = slugify(text) || 'heading';
  const n = (usedIds.get(base) || 0) + 1;
  usedIds.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
}

renderer.heading = function ({ tokens, depth }) {
  const text = this.parser.parseInline(tokens);
  const plainText = tokens.map(t => t.text || '').join('');
  const id = makeUniqueSlug(plainText);
  return `<h${depth} id="${id}"><a class="anchor" href="#${id}"></a>${text}</h${depth}>`;
};

marked.use({ renderer, gfm: true, breaks: false });
marked.use(markedKatex({ throwOnError: false, nonStandard: true }));

// =========================================================
// 主入口：加载并渲染一个章节
// =========================================================

export async function loadChapter(chapterId, anchor, contentEl) {
  const chap = CHAPTER_BY_ID[chapterId];
  if (!chap) {
    contentEl.innerHTML = `<div class="md"><h1>章节未找到</h1><p>未知章节 ID: <code>${escapeHTML(chapterId)}</code></p><p><a href="#/">回到首页</a></p></div>`;
    return null;
  }
  contentEl.innerHTML = `<div class="loading">加载 ${chap.title}…</div>`;

  let md;
  try {
    const res = await fetch(`${chap.id}.md`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    md = await res.text();
  } catch (err) {
    contentEl.innerHTML = `<div class="md"><h1>加载失败</h1><pre>${escapeHTML(err.message)}</pre></div>`;
    return null;
  }

  usedIds.clear();
  const html = marked.parse(md);
  contentEl.innerHTML = `<div class="md">${html}</div>`;

  // 后处理：file:line 链接 + mermaid 渲染 + 术语高亮
  enhanceFileRefs(contentEl);
  await renderMermaidIn(contentEl);
  enhanceWithGlossary(contentEl);

  // 提取本页 TOC
  const toc = extractToc(contentEl);

  // 跳转到锚点（如果有）
  if (anchor) {
    requestAnimationFrame(() => {
      const el = contentEl.querySelector(`#${CSS.escape(anchor)}`);
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
    });
  } else {
    contentEl.scrollTo({ top: 0 });
  }

  return { chapter: chap, toc };
}

// =========================================================
// 渲染首页
// =========================================================

export function renderHome(contentEl, chapters) {
  const totalLines = 11705 + 3124;
  let html = `
    <div class="home-hero">
      <h1>vLLM 中文参考 Wiki</h1>
      <p class="lede">为深入学习 vLLM 源码、最终自己实现一个 LLM 推理引擎而写的可查询参考文档。</p>
      <div class="home-stats">
        <div class="stat"><strong>17</strong> 步导览 + <strong>12</strong> 章参考</div>
        <div class="stat"><strong>${totalLines.toLocaleString()}</strong> 行</div>
        <div class="stat">分析版本：<a href="https://github.com/${VLLM_GITHUB_REPO}/tree/${VLLM_ANALYZED_COMMIT}" target="_blank" rel="noopener"><strong>${VLLM_ANALYZED_TAG}</strong></a> <span style="color:var(--text-faint)">(${VLLM_ANALYZED_DATE})</span></div>
        <div class="stat">聚焦：<strong>V1 架构</strong></div>
      </div>
    </div>

    <section style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:12px;padding:18px 22px;margin:24px 0 28px">
      <h2 style="margin:0 0 6px;font-size:20px;color:var(--accent);">推荐第一遍这样学：跟一次最简请求穿过 vllm 全栈</h2>
      <p style="margin:0 0 12px;color:var(--text-soft);font-size:14px;">
        17 步导览，按 <strong>问题 → 朴素思路为何崩 → vllm 怎么解决</strong> 的逻辑链展开。
        围绕 <code>llm.generate(["你好"], max_tokens=3)</code> 一个具体请求，逐层走完整个 vllm。
      </p>
      <a href="#/tour-00-overview" style="display:inline-block;background:var(--accent);color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">→ 进入导览（建议第一次学先读这个）</a>
      <a href="#/tour-01-kv-cache-sizing" style="display:inline-block;margin-left:8px;color:var(--accent);padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;">或直接看第 1 步样品</a>
    </section>

    <section class="arch-section" id="arch-section">
      <h2>架构总览
        <div class="arch-controls">
          <button id="arch-play-btn">▶ 播放一次请求流</button>
          <button id="arch-reset-btn">重置</button>
        </div>
      </h2>
      <p style="color:var(--text-soft);margin-top:0;">点击任一层跳转到对应章节；点击"播放"看一次请求穿过四层。</p>
      <div class="arch-svg-wrap" id="arch-svg-wrap">
        <!-- 由 architecture.js 注入 -->
      </div>
    </section>

    <section>
      <h2 style="font-size:20px;margin-bottom:8px;">单请求 Trace 导览（17 步）</h2>
      <p style="color:var(--text-soft);margin-top:0;font-size:14px;">
        每步约 150 行，按 8 段模板：当前情境 → 问题 → 朴素思路 → 为何崩 → vllm 做法 → 代码位置 → 分支链接 → 学到了什么。
      </p>
      <div class="chapter-grid">
        ${TOURS.map(t => `
          <a class="chapter-card" href="#/${t.id}" style="border-left:3px solid var(--accent)">
            <div class="chapter-card-num">TOUR ${t.num}</div>
            <div class="chapter-card-title">${t.title}</div>
            <div class="chapter-card-desc">${t.desc}</div>
          </a>
        `).join('')}
      </div>
    </section>

    <section style="margin-top:32px;">
      <h2 style="font-size:20px;margin-bottom:8px;">参考手册（12 章）</h2>
      <p style="color:var(--text-soft);margin-top:0;font-size:14px;">
        完整的子系统参考，作为导览的深度补充。每章独立，可随时跳转。
      </p>
      <div class="chapter-grid">
        ${chapters.map(c => `
          <a class="chapter-card" href="#/${c.id}">
            <div class="chapter-card-num">CHAPTER ${c.num}</div>
            <div class="chapter-card-title">${c.title}</div>
            <div class="chapter-card-desc">${c.desc}</div>
          </a>
        `).join('')}
      </div>
    </section>

    <section style="margin-top:32px;">
      <h2 style="font-size:20px;">键盘快捷键</h2>
      <table class="md" style="font-size:13px;">
        <tr><td><span class="kbd">/</span></td><td>聚焦搜索框</td></tr>
        <tr><td><span class="kbd">j</span> / <span class="kbd">k</span></td><td>下一章 / 上一章</td></tr>
        <tr><td><span class="kbd">t</span></td><td>切换深色/浅色主题</td></tr>
        <tr><td><span class="kbd">g</span> <span class="kbd">h</span></td><td>回首页</td></tr>
        <tr><td><span class="kbd">Esc</span></td><td>关闭弹窗 / 搜索结果</td></tr>
      </table>
    </section>
  `;
  contentEl.innerHTML = `<div class="md">${html}</div>`;
}

// =========================================================
// 后处理：将 <code> 中匹配 file:line 模式的节点转为 vscode:// 跳转链接
// =========================================================

function enhanceFileRefs(container) {
  const isLocal = getRepoMode() === 'local';
  const verb = isLocal ? '在 VSCode 中打开' : '在 GitHub 打开';
  const codes = container.querySelectorAll('code:not(.hljs)');
  for (const code of codes) {
    const ref = parseFileRef(code.textContent);
    if (!ref) continue;
    const a = document.createElement('a');
    a.className = 'file-ref';
    a.href = makeCodeURL(ref.path, ref.line);
    a.textContent = code.textContent;
    a.title = `${verb} ${ref.path}${ref.line ? ':' + ref.line : ''}`;
    if (!isLocal) { a.target = '_blank'; a.rel = 'noopener'; }
    code.replaceWith(a);
  }
}

// =========================================================
// 提取本页 TOC：扫描 h2/h3/h4
// =========================================================

function extractToc(container) {
  const headings = container.querySelectorAll('.md h2, .md h3, .md h4');
  const items = [];
  for (const h of headings) {
    const lvl = parseInt(h.tagName[1]);
    const text = h.textContent.replace(/^\s*#\s*/, '').trim();
    items.push({ id: h.id, text, lvl });
  }
  return items;
}
