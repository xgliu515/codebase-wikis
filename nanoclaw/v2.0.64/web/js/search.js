import MiniSearch from 'https://cdn.jsdelivr.net/npm/minisearch@7.1.0/+esm';
import { ALL_DOCS, CHAPTER_BY_ID } from './chapters.js';
import { debounce, escapeHTML } from './utils.js';
import { T } from './strings.js';

let mini = null;
const documents = []; // {id, chapterId, chapterTitle, heading, content, anchor}

export async function buildIndex() {
  for (const c of ALL_DOCS) {
    try {
      const res = await fetch(`${c.id}.md`, { cache: 'force-cache' });
      const md = await res.text();
      const sections = splitByHeading(md);
      for (const sec of sections) {
        documents.push({
          id: `${c.id}::${sec.anchor || 'top'}::${documents.length}`,
          chapterId: c.id,
          chapterTitle: c.title,
          chapterNum: c.num,
          heading: sec.heading,
          anchor: sec.anchor,
          content: sec.content,
        });
      }
    } catch (e) {
      console.warn('索引失败', c.id, e);
    }
  }

  mini = new MiniSearch({
    fields: ['heading', 'content', 'chapterTitle'],
    storeFields: ['chapterId', 'chapterNum', 'chapterTitle', 'heading', 'anchor', 'content'],
    searchOptions: {
      boost: { heading: 3, chapterTitle: 2 },
      fuzzy: 0.15,
      prefix: true,
      combineWith: 'AND',
    },
    // 中英文 token：保留中文、英文、数字
    tokenize: (s) => (s.match(/[一-鿿]|[a-zA-Z0-9_./]+/g) || []),
    processTerm: (term) => term.toLowerCase(),
  });
  mini.addAll(documents);
}

function splitByHeading(md) {
  // 去除 mermaid / code block 内的 # 标题误识别
  const lines = md.split('\n');
  let inFence = false;
  const sections = [];
  let cur = { heading: '(开头)', anchor: '', content: '', level: 0 };
  for (const line of lines) {
    if (/^```/.test(line)) { inFence = !inFence; cur.content += line + '\n'; continue; }
    if (!inFence && /^#{1,6}\s+/.test(line)) {
      if (cur.content.trim() || cur.heading !== '(开头)') sections.push(cur);
      const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
      cur = { heading: m[2], level: m[1].length, anchor: slugify(m[2]), content: '' };
    } else {
      cur.content += line + '\n';
    }
  }
  sections.push(cur);
  return sections;
}

function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w一-鿿\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// =========================================================
// 搜索 UI
// =========================================================

export function initSearchUI() {
  const input = document.getElementById('search-input');
  const panel = document.getElementById('search-results');
  let hits = [];
  let activeIdx = -1;

  const doSearch = debounce(() => {
    const q = input.value.trim();
    if (!q || !mini) { panel.hidden = true; return; }
    hits = mini.search(q, { limit: 30 });
    activeIdx = hits.length > 0 ? 0 : -1;
    renderResults(panel, hits, q, activeIdx);
    panel.hidden = false;
  }, 120);

  input.addEventListener('input', doSearch);
  input.addEventListener('focus', () => { if (input.value && hits.length) panel.hidden = false; });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.blur(); panel.hidden = true; return; }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % hits.length; renderResults(panel, hits, input.value, activeIdx); scrollActive(panel); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + hits.length) % hits.length; renderResults(panel, hits, input.value, activeIdx); scrollActive(panel); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const h = hits[activeIdx];
      if (h) { navigateToHit(h); panel.hidden = true; }
    }
  });

  document.addEventListener('click', (e) => {
    if (!panel.contains(e.target) && e.target !== input) panel.hidden = true;
  });

  panel.addEventListener('click', (e) => {
    const hit = e.target.closest('.search-hit');
    if (!hit) return;
    const idx = parseInt(hit.dataset.idx);
    navigateToHit(hits[idx]);
    panel.hidden = true;
  });
}

function navigateToHit(h) {
  const url = h.anchor ? `#/${h.chapterId}/${h.anchor}` : `#/${h.chapterId}`;
  location.hash = url;
}

function renderResults(panel, hits, query, activeIdx) {
  if (!hits.length) {
    panel.innerHTML = `<div style="padding:14px;color:var(--text-faint);">${T.search_no_results}</div>`;
    return;
  }
  const tokens = (query.match(/[一-鿿]|[a-zA-Z0-9_.]+/g) || []).filter(t => t.length > 0);
  const html = hits.map((h, i) => {
    const snippet = makeSnippet(h.content, tokens, 120);
    return `<div class="search-hit ${i === activeIdx ? 'active' : ''}" data-idx="${i}">
      <div class="search-hit-title"><span class="search-hit-ch">[${h.chapterNum}]</span>${escapeHTML(h.heading)}</div>
      <div class="search-hit-snippet">${snippet}</div>
    </div>`;
  }).join('');
  panel.innerHTML = html;
}

function scrollActive(panel) {
  const a = panel.querySelector('.search-hit.active');
  if (a) a.scrollIntoView({ block: 'nearest' });
}

function makeSnippet(text, tokens, len) {
  if (!text) return '';
  // 找到第一个匹配 token 的位置
  let pos = -1;
  for (const t of tokens) {
    const i = text.toLowerCase().indexOf(t.toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  let start = Math.max(0, pos - 30);
  let end = Math.min(text.length, start + len);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  snippet = escapeHTML(snippet);
  for (const t of tokens) {
    const re = new RegExp(`(${escapeRegex(t)})`, 'gi');
    snippet = snippet.replace(re, '<mark>$1</mark>');
  }
  return (start > 0 ? '… ' : '') + snippet + (end < text.length ? ' …' : '');
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
