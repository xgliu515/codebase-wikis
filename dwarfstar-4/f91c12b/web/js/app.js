import { CHAPTERS, TOURS, ALL_DOCS, getRepoRoot, setRepoRoot, PROJECT_NAME, STORAGE_PREFIX, ANALYZED_COMMIT } from './chapters.js';
import { parseHash, buildHash, showToast } from './utils.js';
import { loadChapter, renderHome } from './content.js';
import { renderChapterList, renderPageToc } from './sidebar.js';
import { buildIndex, initSearchUI } from './search.js';
import { initMermaid, setMermaidTheme, initModal, reRenderAllMermaid } from './diagrams.js';
import { renderArchSVG, playArchAnimation, resetArchAnimation } from './architecture.js';
import { initGlossary } from './glossary.js';
import { initVersionSwitcher, initProjectSwitcher } from './versions.js';
import { T } from './strings.js';

const contentEl = document.getElementById('content');

// =========================================================
// 主题
// =========================================================

function applyTheme(theme) {
  document.body.dataset.theme = theme;
  localStorage.setItem(`${STORAGE_PREFIX}-theme`, theme);
  // highlight.js 主题切换
  document.getElementById('hljs-theme').href = (theme === 'dark')
    ? 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-dark.min.css'
    : 'https://cdn.jsdelivr.net/npm/highlight.js@11.10.0/styles/atom-one-light.min.css';
  setMermaidTheme(theme);
  reRenderAllMermaid();
}

function toggleTheme() {
  const cur = document.body.dataset.theme || 'light';
  applyTheme(cur === 'light' ? 'dark' : 'light');
}

// =========================================================
// 路由
// =========================================================

async function route() {
  const { chapterId, anchor } = parseHash();

  if (!chapterId) {
    renderChapterList(null);
    renderPageToc([], contentEl);
    renderHome(contentEl, CHAPTERS);
    // 渲染交互架构图
    const wrap = document.getElementById('arch-svg-wrap');
    if (wrap) {
      renderArchSVG(wrap);
      document.getElementById('arch-play-btn')?.addEventListener('click', playArchAnimation);
      document.getElementById('arch-reset-btn')?.addEventListener('click', resetArchAnimation);
    }
    contentEl.scrollTo({ top: 0 });
    document.title = `${PROJECT_NAME} ${T.title_suffix}`.trim();
    return;
  }

  renderChapterList(chapterId);
  const result = await loadChapter(chapterId, anchor, contentEl);
  if (result) {
    renderPageToc(result.toc, contentEl);
    document.title = `${result.chapter.num} · ${result.chapter.title} — ${PROJECT_NAME} Wiki`;
  } else {
    renderPageToc([], contentEl);
  }
}

// =========================================================
// 章节导航
// =========================================================

function gotoChapter(delta) {
  const { chapterId } = parseHash();
  if (!chapterId) {
    if (delta > 0) location.hash = buildHash(ALL_DOCS[0].id);
    return;
  }
  // 在 ALL_DOCS（tour + chapters）里前进后退
  const idx = ALL_DOCS.findIndex(c => c.id === chapterId);
  if (idx < 0) return;
  const next = idx + delta;
  if (next < 0) { showToast(T.toast_first); return; }
  if (next >= ALL_DOCS.length) { showToast(T.toast_last); return; }
  location.hash = buildHash(ALL_DOCS[next].id);
}

// =========================================================
// 键盘快捷键
// =========================================================

function initKeybindings() {
  let lastG = 0;
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    switch (e.key) {
      case '/':
        e.preventDefault();
        document.getElementById('search-input').focus();
        break;
      case 'j':
        gotoChapter(1);
        break;
      case 'k':
        gotoChapter(-1);
        break;
      case 't':
        toggleTheme();
        break;
      case 'h':
        if (Date.now() - lastG < 600) location.hash = '#/';
        break;
      case 'g':
        lastG = Date.now();
        break;
    }
  });
}

// =========================================================
// 启动
// =========================================================

// =========================================================
// i18n: 把 strings.js 的当前语言表写入 DOM
// =========================================================

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.title = T[el.dataset.i18n];
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = T[el.dataset.i18nPlaceholder];
  });
  document.querySelectorAll('[data-i18n-text]').forEach(el => {
    el.textContent = T[el.dataset.i18nText];
  });
}

async function main() {
  // 主题初始化
  const savedTheme = localStorage.getItem(`${STORAGE_PREFIX}-theme`)
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(savedTheme);
  initMermaid(savedTheme);
  initModal();
  // i18n 注入(必须先于读取 DOM 文案的代码)
  applyI18n();

  // 工具栏按钮
  document.getElementById('theme-toggle').addEventListener('click', toggleTheme);
  document.getElementById('prev-chapter').addEventListener('click', () => gotoChapter(-1));
  document.getElementById('next-chapter').addEventListener('click', () => gotoChapter(1));
  document.getElementById('repo-root-btn').addEventListener('click', () => {
    const cur = getRepoRoot();
    const mode = cur ? T.source_mode_local : `GitHub (${PROJECT_NAME}@${ANALYZED_COMMIT})`;
    const updated = prompt(T.source_mode_prompt(mode, PROJECT_NAME), cur);
    if (updated === null) return;
    setRepoRoot(updated);
    showToast(updated.trim() ? T.source_mode_switched_local : T.source_mode_switched_github);
  });

  // 版本切换下拉（无 versions.json 时自动隐藏，不阻塞启动）
  initVersionSwitcher();

  // 项目切换下拉（无 projects.json 时自动隐藏，不阻塞启动）
  initProjectSwitcher();

  // 键盘
  initKeybindings();

  // 路由
  window.addEventListener('hashchange', route);

  // 先初始化术语库（用于高亮），完成后再 route，确保第一个页面就有术语标记
  await initGlossary();
  await route();

  // 后台构建搜索索引
  buildIndex().then(() => {
    initSearchUI();
    console.log(`[${PROJECT_NAME} Wiki] 搜索索引已就绪`);
  }).catch(err => console.error('索引构建失败', err));
}

main().catch(err => {
  console.error(err);
  contentEl.innerHTML = `<div class="md"><h1>${T.err_startup_failed_h1}</h1><pre>${err.stack || err.message}</pre></div>`;
});
