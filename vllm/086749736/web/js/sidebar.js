import { CHAPTERS, TOURS } from './chapters.js';
import { throttle } from './utils.js';

export function renderChapterList(currentChapterId) {
  const list = document.getElementById('chapter-list');
  let html = '';

  // 首页
  html += `<a class="ch-item ${!currentChapterId ? 'active' : ''}" href="#/" style="margin-bottom:6px"><span class="ch-num">★</span>首页</a>`;

  // Tour 段
  if (TOURS && TOURS.length) {
    html += `<div class="sidebar-head">单请求 Trace 导览</div>`;
    for (const t of TOURS) {
      const active = t.id === currentChapterId ? 'active' : '';
      html += `<a class="ch-item ${active}" href="#/${t.id}"><span class="ch-num">${t.num}</span>${t.title}</a>`;
    }
  }

  // 参考章节段
  html += `<div class="sidebar-head" style="margin-top:14px">参考手册（12 章）</div>`;
  for (const c of CHAPTERS) {
    const active = c.id === currentChapterId ? 'active' : '';
    html += `<a class="ch-item ${active}" href="#/${c.id}"><span class="ch-num">${c.num}</span>${c.title}</a>`;
  }

  list.innerHTML = html;
}

export function renderPageToc(toc, contentEl) {
  const nav = document.getElementById('page-toc');
  if (!toc || toc.length === 0) {
    nav.innerHTML = `<div style="color:var(--text-faint);font-size:13px;">无目录</div>`;
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
