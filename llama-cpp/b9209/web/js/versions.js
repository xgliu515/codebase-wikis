import { getCurrentVersionDir, getCurrentProjectDir } from './chapters.js';

// =========================================================
// 版本切换下拉
// 运行时 fetch 顶层 ../versions.json，在顶栏渲染版本下拉。
// 切换版本 = 跳到目标版本首页（不做跨版本深链映射）。
// fetch 失败（如本地单目录打开、非版本化布局）时静默隐藏下拉。
// =========================================================

export async function initVersionSwitcher() {
  const sel = document.getElementById('version-switcher');
  if (!sel) return;

  let manifest;
  try {
    const resp = await fetch('../versions.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    manifest = await resp.json();
  } catch {
    sel.hidden = true;
    return;
  }

  const versions = Array.isArray(manifest && manifest.versions) ? manifest.versions : [];
  if (versions.length < 1) {
    sel.hidden = true;
    return;
  }

  const current = getCurrentVersionDir();
  sel.innerHTML = '';
  for (const v of versions) {
    const opt = document.createElement('option');
    opt.value = v.dir;
    opt.textContent = (v.label || v.dir) + (v.latest ? '  (latest)' : '');
    if (v.dir === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.hidden = false;

  sel.addEventListener('change', () => {
    const dir = sel.value;
    if (dir && dir !== current) {
      location.href = `../${dir}/index.html`;
    }
  });
}

// =========================================================
// 项目切换下拉（mono-repo）
// 运行时 fetch 顶层 ../../projects.json，在顶栏渲染项目下拉。
// 切换项目 = 跳到目标项目的版本选择页。
// fetch 失败（如非 mono-repo 布局、本地单目录打开）时静默隐藏下拉。
// =========================================================

export async function initProjectSwitcher() {
  const sel = document.getElementById('project-switcher');
  if (!sel) return;

  let manifest;
  try {
    const resp = await fetch('../../projects.json', { cache: 'no-cache' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    manifest = await resp.json();
  } catch {
    sel.hidden = true;
    return;
  }

  const projects = Array.isArray(manifest && manifest.projects) ? manifest.projects : [];
  if (projects.length < 1) {
    sel.hidden = true;
    return;
  }

  const current = getCurrentProjectDir();
  sel.innerHTML = '';
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.dir;
    opt.textContent = p.name || p.dir;
    if (p.dir === current) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.hidden = false;

  sel.addEventListener('change', () => {
    const dir = sel.value;
    if (dir && dir !== current) {
      location.href = `../../${dir}/index.html`;
    }
  });
}
