// 思路 A：静态术语高亮 + 侧栏解释 + 递归展开
// - 解析第 12 章术语表
// - 在所有渲染内容里把术语高亮成虚线下划线
// - 点击 → 右侧 panel 显示定义；panel 里的术语再可点（递归）
// - localStorage 记录已查看的术语

import { marked } from 'https://cdn.jsdelivr.net/npm/marked@15.0.4/lib/marked.esm.js';
import { parseFileRef, makeCodeURL, escapeHTML } from './utils.js';

const STORAGE_KEY = 'vllm-wiki-viewed-terms';

// 解析得到的术语库：key 是规范化的术语名，value 是 {primary, variants, definition, codeLocation, html, slug}
const TERMS = new Map();
// 用于匹配的列表：[ {variant, key, lowerVariant, isCJK} ]，按长度降序
let VARIANTS = [];
// 已查看：Set<termKey>
let VIEWED = new Set();
// 浏览历史栈（panel 内部前进后退）
let HISTORY = [];

// =========================================================
// 初始化
// =========================================================

export async function initGlossary() {
  try {
    const res = await fetch('12-glossary-and-faq.md', { cache: 'force-cache' });
    const md = await res.text();
    parseGlossary(md);
    buildMatcher();
    loadViewed();
    installPanel();
    console.log(`[glossary] 加载 ${TERMS.size} 个术语，${VARIANTS.length} 个匹配变体`);
  } catch (err) {
    console.error('[glossary] 初始化失败', err);
  }
}

// =========================================================
// 解析第 12 章的 Part 1 术语表
// =========================================================

function parseGlossary(md) {
  // 截取 Part 1
  const p1Start = md.indexOf('## Part 1');
  const p2Start = md.indexOf('## Part 2');
  if (p1Start < 0) return;
  const part1 = md.slice(p1Start, p2Start > 0 ? p2Start : md.length);

  // 拆 ### 条目
  const blocks = part1.split(/\n(?=### )/g);
  for (const block of blocks) {
    if (!block.startsWith('### ')) continue;
    const lines = block.split('\n');
    const heading = lines[0].slice(4).trim();  // 去掉 "### "
    const body = lines.slice(1).join('\n').trim();

    const { primary, variants } = parseHeading(heading);
    if (!primary) continue;

    // 提取 - 英文原名 / - 中文译名 / - 定义 / - 代码位置
    let definition = '';
    let codeLocation = '';
    let chineseName = '';
    let englishName = '';
    for (const line of body.split('\n')) {
      const m = line.match(/^-\s*(英文原名|中文译名|定义|代码位置)[：:]\s*(.*)$/);
      if (m) {
        const [, key, val] = m;
        if (key === '定义') definition = val;
        else if (key === '代码位置') codeLocation = val;
        else if (key === '中文译名') chineseName = val;
        else if (key === '英文原名') englishName = val;
      } else if (definition && line.trim() && !line.startsWith('- ')) {
        // 定义可能跨行
        definition += ' ' + line.trim();
      }
    }

    // 把中文译名 / 英文原名拆出来当作匹配变体
    const allVariants = new Set(variants);
    allVariants.add(primary);
    if (chineseName) {
      for (const v of splitNames(chineseName)) allVariants.add(v);
    }
    if (englishName) {
      for (const v of splitNames(englishName)) allVariants.add(v);
    }

    const key = primary;
    // slug 必须基于原 heading 文本，因为 content.js 的标题渲染器对完整 heading 做 slugify
    const slug = slugify(heading);

    TERMS.set(key, {
      primary,
      variants: [...allVariants],
      definition,
      codeLocation,
      chineseName,
      englishName,
      slug,
    });
  }
}

// 解析 H3 文本，返回 {primary, variants}
//  "Backend（attention backend）" → primary: "Backend", variants: ["attention backend"]
//  "Data Parallelism (DP)" → primary: "Data Parallelism", variants: ["DP"]
//  "Guided Decoding / Structured Output" → primary: "Guided Decoding", variants: ["Structured Output"]
//  "Continuous Batching（迭代级调度）" → primary: "Continuous Batching", variants: ["迭代级调度"]
function parseHeading(h) {
  // 提取并去除括号内容
  const parenMatches = [...h.matchAll(/[（(]([^）)]+)[）)]/g)].map(m => m[1].trim());
  let bare = h.replace(/[（(][^）)]+[）)]/g, '').trim();
  // 拆 /
  const slashed = bare.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean);
  const primary = slashed[0] || bare;
  const variants = [...slashed.slice(1), ...parenMatches];
  return { primary, variants };
}

// 用于拆"英文原名/中文译名"行的内容（可能含 / 或反引号）
function splitNames(s) {
  return s
    .split(/\s*\/\s*/)
    .map(x => x.replace(/`/g, '').trim())
    .filter(Boolean);
}

function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w一-鿿\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// =========================================================
// 构造匹配器：按变体长度降序，跑一遍 regex
// =========================================================

function buildMatcher() {
  const items = [];
  for (const [key, t] of TERMS) {
    for (const v of t.variants) {
      if (v.length < 2) continue;
      items.push({ variant: v, key, lower: v.toLowerCase(), isCJK: /[一-鿿]/.test(v) });
    }
  }
  // 长度降序——优先匹配更长的术语
  items.sort((a, b) => b.variant.length - a.variant.length);
  VARIANTS = items;
}

// =========================================================
// 在 container 内高亮所有术语（每个术语每个 container 只高亮第一次）
// =========================================================

export function enhanceWithGlossary(container) {
  if (!VARIANTS.length) return;
  const seen = new Set();  // term key set，避免重复高亮

  // 收集所有 text node（避开 code/pre/a/heading/已包装）
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('code, pre, a, h1, h2, h3, h4, h5, h6, svg, .gloss-term, .file-ref, .mermaid-block')) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  let n;
  while ((n = walker.nextNode())) textNodes.push(n);

  for (const node of textNodes) {
    const text = node.nodeValue;
    // 找出本节点内所有 match，再批量替换
    // 用一个简单的扫描：对每个 variant 检查 indexOf
    const matches = [];  // { start, end, key, variant }
    for (const v of VARIANTS) {
      if (seen.has(v.key)) continue;  // 该术语本页已经标过
      let idx;
      if (v.isCJK) {
        idx = text.indexOf(v.variant);
        if (idx < 0) continue;
      } else {
        // ASCII：使用 word boundary
        const re = new RegExp('\\b' + escapeRegex(v.variant) + '\\b', 'i');
        const m = text.match(re);
        if (!m) continue;
        idx = m.index;
      }
      // 检查与已有匹配是否重叠
      const end = idx + v.variant.length;
      let overlap = false;
      for (const m of matches) {
        if (!(end <= m.start || idx >= m.end)) { overlap = true; break; }
      }
      if (overlap) continue;
      matches.push({ start: idx, end, key: v.key, variant: v.variant });
      seen.add(v.key);
    }

    if (!matches.length) continue;
    matches.sort((a, b) => a.start - b.start);

    // 把 text node 拆成原文 + span 混合
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
      }
      const span = document.createElement('span');
      span.className = 'gloss-term';
      if (VIEWED.has(m.key)) span.classList.add('viewed');
      span.dataset.term = m.key;
      span.textContent = text.slice(m.start, m.end);
      span.title = `点击查看「${m.key}」的解释`;
      frag.appendChild(span);
      cursor = m.end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    node.parentNode.replaceChild(frag, node);
  }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// =========================================================
// 侧栏 panel
// =========================================================

function installPanel() {
  // 创建 panel DOM
  const panel = document.createElement('aside');
  panel.id = 'gloss-panel';
  panel.className = 'gloss-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <header class="gloss-panel-head">
      <button class="gloss-back" title="返回上一个 (←)" hidden>‹ 返回</button>
      <span class="gloss-trail"></span>
      <button class="gloss-close" title="关闭 (Esc)">×</button>
    </header>
    <div class="gloss-panel-body"></div>
    <footer class="gloss-panel-foot">
      <span class="gloss-counter"></span>
      <button class="gloss-clear-viewed" title="清除本地"已查看"记录">重置</button>
    </footer>
  `;
  document.body.appendChild(panel);

  // 事件：点击文档中的术语
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.gloss-term');
    if (t) {
      e.preventDefault();
      openTerm(t.dataset.term, false);
    }
  });

  // 点击 panel 外面 + 非术语 → 关闭 panel
  document.addEventListener('click', (e) => {
    if (panel.hidden) return;
    if (panel.contains(e.target)) return;        // 点 panel 内部不关
    if (e.target.closest('.gloss-term')) return; // 点术语让 openTerm 处理
    closePanel();
  });

  // 关闭、返回、清空
  panel.querySelector('.gloss-close').addEventListener('click', closePanel);
  panel.querySelector('.gloss-back').addEventListener('click', goBack);
  panel.querySelector('.gloss-clear-viewed').addEventListener('click', () => {
    VIEWED.clear();
    saveViewed();
    document.querySelectorAll('.gloss-term.viewed').forEach(el => el.classList.remove('viewed'));
    updateCounter();
  });

  // Esc 关闭、← 返回
  document.addEventListener('keydown', (e) => {
    if (panel.hidden) return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'Escape') { closePanel(); return; }
    if (e.key === 'ArrowLeft' && HISTORY.length > 1) { goBack(); return; }
  });

  updateCounter();
}

function openTerm(key, fromHistory) {
  const term = TERMS.get(key);
  const panel = document.getElementById('gloss-panel');
  const body = panel.querySelector('.gloss-panel-body');
  const back = panel.querySelector('.gloss-back');
  const trail = panel.querySelector('.gloss-trail');

  if (!term) {
    body.innerHTML = `<p style="color:var(--text-faint)">未找到术语：<code>${escapeHTML(key)}</code></p>`;
    panel.hidden = false;
    return;
  }

  // 历史
  if (!fromHistory) HISTORY.push(key);
  back.hidden = HISTORY.length <= 1;

  // 面包屑
  trail.innerHTML = HISTORY
    .map((k, i) =>
      i === HISTORY.length - 1
        ? `<strong>${escapeHTML(k)}</strong>`
        : `<span class="gloss-trail-prev" data-back-to="${i}">${escapeHTML(k)}</span>`
    )
    .join(' <span style="color:var(--text-faint)">›</span> ');

  // 面包屑点击：跳到该位置
  trail.querySelectorAll('.gloss-trail-prev').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.backTo);
      HISTORY = HISTORY.slice(0, idx + 1);
      openTerm(HISTORY[HISTORY.length - 1], true);
    });
  });

  // 渲染定义为 HTML
  const defHtml = marked.parse(term.definition || '*（无定义）*');
  const locHtml = term.codeLocation ? marked.parseInline(term.codeLocation) : '';
  body.innerHTML = `
    <h2 class="gloss-title">${escapeHTML(term.primary)}</h2>
    <div class="gloss-aliases">
      ${term.chineseName ? `<div><span class="gloss-meta">中文译名</span>${escapeHTML(term.chineseName)}</div>` : ''}
      ${term.englishName && term.englishName !== term.primary ? `<div><span class="gloss-meta">英文原名</span><code>${escapeHTML(term.englishName)}</code></div>` : ''}
    </div>
    <div class="gloss-definition md">${defHtml}</div>
    ${locHtml ? `<div class="gloss-location md"><span class="gloss-meta">代码位置</span>${locHtml}</div>` : ''}
    <div class="gloss-jump">
      <a href="#/12-glossary-and-faq/${term.slug}">在术语表里查看完整条目 →</a>
    </div>
  `;

  // 递归：panel 内容里也高亮术语，但要排除当前术语自己
  const currentTermSet = new Set([key]);
  enhancePanel(body, currentTermSet);

  // file:line 链接
  body.querySelectorAll('code').forEach(code => {
    const ref = parseFileRef(code.textContent);
    if (!ref) return;
    const a = document.createElement('a');
    a.className = 'file-ref';
    a.href = makeCodeURL(ref.path, ref.line);
    a.textContent = code.textContent;
    a.title = `打开 ${ref.path}${ref.line ? ':' + ref.line : ''}`;
    code.replaceWith(a);
  });

  // 标记已查看
  if (!VIEWED.has(key)) {
    VIEWED.add(key);
    saveViewed();
    // 给页面上所有同 key 的 .gloss-term 加上 viewed 样式
    document.querySelectorAll(`.gloss-term[data-term="${cssEscape(key)}"]`).forEach(el => el.classList.add('viewed'));
    updateCounter();
  }

  panel.hidden = false;
  body.scrollTop = 0;
}

function goBack() {
  if (HISTORY.length <= 1) return;
  HISTORY.pop();
  openTerm(HISTORY[HISTORY.length - 1], true);
}

function closePanel() {
  document.getElementById('gloss-panel').hidden = true;
  HISTORY = [];
}

// 在 panel 内部对 .md 内容做术语高亮（recursive）
// 注意：要排除当前正在显示的术语自己（避免点开 A 又显示 A）
function enhancePanel(container, excludeKeys) {
  // 临时把 excluded 的 variants 拿掉
  const saved = VARIANTS;
  VARIANTS = saved.filter(v => !excludeKeys.has(v.key));
  enhanceWithGlossary(container);
  VARIANTS = saved;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/"/g, '\\"');
}

// =========================================================
// localStorage：已查看的术语
// =========================================================

function loadViewed() {
  try {
    const arr = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    VIEWED = new Set(arr);
  } catch { VIEWED = new Set(); }
}

function saveViewed() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...VIEWED])); } catch {}
}

function updateCounter() {
  const el = document.querySelector('.gloss-counter');
  if (el) el.textContent = `已查看 ${VIEWED.size} / ${TERMS.size} 条术语`;
}
