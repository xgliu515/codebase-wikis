import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15.0.4/lib/marked.esm.js';
// 用 jsdelivr 的 +esm 打包版：自带所有标准语言，不必逐个 register
import hljs from 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/+esm';
// LaTeX 数学公式渲染（KaTeX）。extension 必须在 marked 解析前注册，否则 $..$ 内部的 _ ^ 会被当 markdown 处理
import markedKatex from 'https://cdn.jsdelivr.net/npm/marked-katex-extension@5/+esm';

import { CHAPTER_BY_ID, TOURS, getRepoMode, PROJECT_NAME, PROJECT_TAGLINE, PROJECT_FOCUS, TRACE_TARGET,
         ANALYZED_COMMIT, ANALYZED_TAG, ANALYZED_DATE, PROJECT_GITHUB_REPO, normalizeTours } from './chapters.js';
import { parseFileRef, makeCodeURL, escapeHTML, slugify } from './utils.js';
import { renderMermaidIn } from './diagrams.js';
import { enhanceWithGlossary } from './glossary.js';
import { T } from './strings.js';

// =========================================================
// marked 配置：自定义 code 渲染器（mermaid + 语法高亮），自定义 heading 锚点
// =========================================================

const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  if (lang === 'mermaid') {
    return `<div class="mermaid-block" data-source="${escapeHTML(text)}">${T.rendering}</div>`;
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
    contentEl.innerHTML = `<div class="md"><h1>${T.err_chapter_not_found_h1}</h1><p>${T.err_chapter_not_found_body(escapeHTML(chapterId))}</p><p><a href="#/">${T.err_back_home}</a></p></div>`;
    return null;
  }
  contentEl.innerHTML = `<div class="loading">${T.loading_chapter(chap.title)}</div>`;

  let md;
  try {
    const res = await fetch(`${chap.id}.md`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    md = await res.text();
  } catch (err) {
    contentEl.innerHTML = `<div class="md"><h1>${T.err_load_failed_h1}</h1><pre>${escapeHTML(err.message)}</pre></div>`;
    return null;
  }

  usedIds.clear();
  const html = marked.parse(md);
  const bannerHtml = (chap.parentId)
    ? makeAddendumBanner(chap)
    : '';
  contentEl.innerHTML = `<div class="md">${bannerHtml}${html}</div>`;

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
  const tours = normalizeTours(TOURS);
  const primary = tours[0] || { steps: [], target: TRACE_TARGET };
  const primaryStepCount = Math.max(primary.steps.length - 1, 0);   // 减去 overview
  const primaryFirstStep = primary.steps.find(s => !s.id.endsWith('-00-overview'));
  const primaryOverview = primary.steps.find(s => s.id.endsWith('-00-overview')) || primary.steps[0];
  const chapterCount = chapters.length;
  let html = `
    <div class="home-hero">
      <h1>${PROJECT_NAME} ${T.title_suffix}</h1>
      <p class="lede">${PROJECT_TAGLINE}</p>
      <div class="home-stats">
        <div class="stat">${T.home_stats_summary(primaryStepCount, chapterCount)}</div>
        <div class="stat">${T.home_stats_analyzed} <a href="https://github.com/${PROJECT_GITHUB_REPO}/tree/${ANALYZED_COMMIT}" target="_blank" rel="noopener"><strong>${ANALYZED_TAG}</strong></a> <span style="color:var(--text-faint)">(${ANALYZED_DATE})</span></div>
        ${PROJECT_FOCUS ? `<div class="stat">${T.home_stats_focus} <strong>${PROJECT_FOCUS}</strong></div>` : ''}
      </div>
    </div>

    <section style="background:var(--accent-soft);border:1px solid var(--accent);border-radius:12px;padding:18px 22px;margin:24px 0 28px">
      <h2 style="margin:0 0 6px;font-size:20px;color:var(--accent);">${T.home_trace_h2(PROJECT_NAME)}</h2>
      <p style="margin:0 0 12px;color:var(--text-soft);font-size:14px;">
        ${T.home_trace_lede(primaryStepCount, PROJECT_NAME, escapeHTML(primary.target || TRACE_TARGET))}
      </p>
      ${primaryOverview ? `<a href="#/${primaryOverview.id}" style="display:inline-block;background:var(--accent);color:white;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px;">${T.home_trace_cta}</a>` : ''}
      ${primaryFirstStep ? `<a href="#/${primaryFirstStep.id}" style="display:inline-block;margin-left:8px;color:var(--accent);padding:8px 16px;border-radius:6px;text-decoration:none;font-size:14px;">${T.home_trace_sample}</a>` : ''}
    </section>

    <section class="arch-section" id="arch-section">
      <h2>${T.home_arch_h2}
        <div class="arch-controls">
          <button id="arch-play-btn">${T.home_arch_play}</button>
          <button id="arch-reset-btn">${T.home_arch_reset}</button>
        </div>
      </h2>
      <p style="color:var(--text-soft);margin-top:0;">${T.home_arch_caption}</p>
      <div class="arch-svg-wrap" id="arch-svg-wrap">
        <!-- 由 architecture.js 注入 -->
      </div>
    </section>

    ${tours.map(tour => `
      <section style="margin-top:24px;">
        <h2 style="font-size:20px;margin-bottom:8px;">${escapeHTML(tour.title || T.home_tour_h2(Math.max(tour.steps.length - 1, 0)))}</h2>
        <p style="color:var(--text-soft);margin-top:0;font-size:14px;">
          ${T.home_tour_lede(PROJECT_NAME)}
        </p>
        <div class="chapter-grid">
          ${tour.steps.map(s => `
            <a class="chapter-card" href="#/${s.id}" style="border-left:3px solid var(--accent)">
              <div class="chapter-card-num">TOUR ${s.num}</div>
              <div class="chapter-card-title">${s.title}</div>
              <div class="chapter-card-desc">${s.desc}</div>
            </a>
          `).join('')}
        </div>
      </section>
    `).join('')}

    <section style="margin-top:32px;">
      <h2 style="font-size:20px;margin-bottom:8px;">${T.home_ref_h2(chapterCount)}</h2>
      <p style="color:var(--text-soft);margin-top:0;font-size:14px;">
        ${T.home_ref_lede}
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
      <h2 style="font-size:20px;">${T.home_kbd_h2}</h2>
      <table class="md" style="font-size:13px;">
        <tr><td><span class="kbd">/</span></td><td>${T.home_kbd_search}</td></tr>
        <tr><td><span class="kbd">j</span> / <span class="kbd">k</span></td><td>${T.home_kbd_next_prev}</td></tr>
        <tr><td><span class="kbd">t</span></td><td>${T.home_kbd_theme}</td></tr>
        <tr><td><span class="kbd">g</span> <span class="kbd">h</span></td><td>${T.home_kbd_home}</td></tr>
        <tr><td><span class="kbd">Esc</span></td><td>${T.home_kbd_close}</td></tr>
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
  const verb = isLocal ? T.file_ref_verb_local : T.file_ref_verb_github;
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

// =========================================================
// Addendum banner: shown at the top of an addendum page
// =========================================================

function makeAddendumBanner(chap) {
  const parent = CHAPTER_BY_ID[chap.parentId];
  if (!parent) return '';
  const q = chap.question ? `<em>${escapeHTML(chap.question)}</em>` : '';
  const link = `<a href="#/${parent.id}">${T.addendum_banner_back(escapeHTML(parent.title))}</a>`;
  return `<div class="addendum-banner">${q ? `${T.addendum_banner_q_prefix}${q} · ` : ''}${link}</div>`;
}
