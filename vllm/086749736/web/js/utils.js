import { getRepoMode, getRepoRoot, VLLM_GITHUB_REPO, VLLM_ANALYZED_COMMIT } from './chapters.js';

// =========================================================
// 代码跳转链接（默认走 GitHub，可切到本地 VSCode）
// =========================================================

const FILE_REF_RE = /^([a-zA-Z0-9_\-./]+\.(?:py|cpp|cu|cuh|h|hpp|c|cc|md|yaml|yml|toml|sh|json|in|txt|ts|tsx|js|jsx|html|css))(?::(\d+(?:-\d+)?))?$/;

export function makeCodeURL(relPath, line) {
  if (getRepoMode() === 'local') {
    const root = getRepoRoot();
    const suf = line ? `:${String(line).split('-')[0]}` : '';
    return `vscode://file${root}/${relPath}${suf}`;
  }
  // GitHub mode (default)
  // 支持 line=`123` 或 `123-130`（GitHub URL 用 #L123 / #L123-L130）
  let suf = '';
  if (line) {
    const parts = String(line).split('-');
    suf = parts.length === 2 ? `#L${parts[0]}-L${parts[1]}` : `#L${parts[0]}`;
  }
  return `https://github.com/${VLLM_GITHUB_REPO}/blob/${VLLM_ANALYZED_COMMIT}/${relPath}${suf}`;
}

// 兼容旧名
export const makeVSCodeURL = makeCodeURL;

export function parseFileRef(text) {
  const m = text.trim().match(FILE_REF_RE);
  if (!m) return null;
  return { path: m[1], line: m[2] || null };
}

// =========================================================
// DOM / scroll helpers
// =========================================================

export function debounce(fn, wait = 150) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

export function throttle(fn, wait = 100) {
  let last = 0, t;
  return (...args) => {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      last = now;
      fn(...args);
    } else {
      clearTimeout(t);
      t = setTimeout(() => { last = Date.now(); fn(...args); }, remaining);
    }
  };
}

export function escapeHTML(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function slugify(s) {
  return s.trim().toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\w一-鿿\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function showToast(text, ms = 1800) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

// =========================================================
// 路由：hash 解析
// 格式：#/<chapterId>  或  #/<chapterId>/<anchorId>
// =========================================================

export function parseHash() {
  const h = location.hash.slice(1) || '/';
  const parts = h.split('/').filter(Boolean);
  return {
    chapterId: parts[0] || null,
    anchor: parts.slice(1).join('/') || null,
  };
}

export function buildHash(chapterId, anchor) {
  if (!chapterId) return '#/';
  return anchor ? `#/${chapterId}/${anchor}` : `#/${chapterId}`;
}
