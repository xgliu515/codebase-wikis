import { CHAPTERS, TOURS, CHAPTER_BY_ID, STORAGE_PREFIX } from './chapters.js';
import { throttle } from './utils.js';
import { T } from './strings.js';

const EXPANDED_KEY = `${STORAGE_PREFIX}-sidebar-expanded`;

function loadExpanded() {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveExpanded(set) {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...set]));
  } catch {}
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function renderChapterList(currentChapterId) {
  const list = document.getElementById('chapter-list');
  let html = '';

  // 当前激活项的 parentId（若激活的是 addendum）
  const activeChap = currentChapterId ? CHAPTER_BY_ID[currentChapterId] : null;
  const activeParentId = activeChap && activeChap.parentId ? activeChap.parentId : null;

  const expanded = loadExpanded();
  if (activeParentId) expanded.add(activeParentId);

  // 首页
  html += `<a class="ch-item ${!currentChapterId ? 'active' : ''}" href="#/" style="margin-bottom:6px"><span class="ch-num">★</span>${T.sidebar_home}</a>`;

  // Tour 段
  if (TOURS && TOURS.length) {
    html += `<div class="sidebar-head">${T.sidebar_tour_head}</div>`;
    for (const t of TOURS) {
      const active = t.id === currentChapterId ? 'active' : '';
      html += `<a class="ch-item ${active}" href="#/${t.id}"><span class="ch-num">${t.num}</span>${t.title}</a>`;
    }
  }

  // 参考章节段（支持 addenda 嵌套）
  html += `<div class="sidebar-head" style="margin-top:14px">${T.sidebar_ref_head(CHAPTERS.length)}</div>`;
  for (const c of CHAPTERS) {
    const hasAddenda = Array.isArray(c.addenda) && c.addenda.length > 0;
    const isActive = c.id === currentChapterId;
    const hasActiveChild = activeParentId === c.id;
    const isExpanded = hasAddenda && expanded.has(c.id);

    const classes = ['ch-item'];
    if (isActive) classes.push('active');
    if (hasActiveChild) classes.push('has-active-child');

    if (hasAddenda) {
      html += `<div class="ch-row">`;
      html += `<a class="${classes.join(' ')}" href="#/${c.id}"><span class="ch-num">${c.num}</span>${c.title}</a>`;
      html += `<button class="ch-toggle" type="button" data-toggle="${escapeAttr(c.id)}" aria-label="${T.sidebar_toggle_aria}" aria-expanded="${isExpanded ? 'true' : 'false'}">${isExpanded ? '▾' : '▸'}</button>`;
      html += `</div>`;
      html += `<div class="ch-children" data-children-of="${escapeAttr(c.id)}"${isExpanded ? '' : ' hidden'}>`;
      for (const a of c.addenda) {
        const aActive = a.id === currentChapterId ? 'active' : '';
        html += `<a class="ch-item addendum ${aActive}" href="#/${a.id}"><span class="ch-num">·</span>${a.title}</a>`;
      }
      html += `</div>`;
    } else {
      html += `<a class="${classes.join(' ')}" href="#/${c.id}"><span class="ch-num">${c.num}</span>${c.title}</a>`;
    }
  }

  list.innerHTML = html;

  // 绑定折叠/展开
  list.querySelectorAll('.ch-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.toggle;
      const children = btn.closest('.ch-row')?.nextElementSibling;
      if (!children) return;
      const set = loadExpanded();
      if (set.has(id)) {
        set.delete(id);
        children.hidden = true;
        btn.textContent = '▸';
        btn.setAttribute('aria-expanded', 'false');
      } else {
        set.add(id);
        children.hidden = false;
        btn.textContent = '▾';
        btn.setAttribute('aria-expanded', 'true');
      }
      saveExpanded(set);
    });
  });
}

export function renderPageToc(toc, contentEl) {
  const nav = document.getElementById('page-toc');
  if (!toc || toc.length === 0) {
    nav.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">${T.toc_empty}</div>`;
    return;
  }
  nav.innerHTML = toc.map(item =>
    `<a class="toc-link lvl-${item.lvl}" href="#${item.id}" data-id="${item.id}">${escapeText(item.text)}</a>`
  ).join('');

  // 点击 TOC：scroll 并更新 hash 第二段
  nav.querySelectorAll('.toc-link').forEach(a => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const id = a.dataset.id;
      const target = contentEl.querySelector(`#${CSS.escape(id)}`);
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // 更新 hash 第二段
        const m = location.hash.match(/^#\/([^/]+)/);
        if (m) {
          history.replaceState(null, '', `#/${m[1]}/${id}`);
        }
      }
    });
  });

  // 滚动监听：高亮当前 section
  bindScrollSpy(toc, contentEl, nav);
}

function bindScrollSpy(toc, contentEl, nav) {
  const links = new Map([...nav.querySelectorAll('.toc-link')].map(a => [a.dataset.id, a]));
  const handler = throttle(() => {
    const cTop = contentEl.scrollTop;
    let activeId = toc[0]?.id;
    for (const item of toc) {
      const el = contentEl.querySelector(`#${CSS.escape(item.id)}`);
      if (!el) continue;
      const offset = el.offsetTop - 100;
      if (offset <= cTop) activeId = item.id;
      else break;
    }
    links.forEach((a, id) => a.classList.toggle('active', id === activeId));
  }, 80);
  contentEl.addEventListener('scroll', handler, { passive: true });
  handler();
}

function escapeText(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}
