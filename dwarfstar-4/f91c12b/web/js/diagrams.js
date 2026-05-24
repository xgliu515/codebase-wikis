import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

let currentTheme = 'default';
let counter = 0;

export function initMermaid(theme) {
  currentTheme = (theme === 'dark') ? 'dark' : 'default';
  mermaid.initialize({
    startOnLoad: false,
    theme: currentTheme,
    securityLevel: 'loose',
    fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
    flowchart: { curve: 'basis', useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
}

export function setMermaidTheme(theme) {
  initMermaid(theme);
}

// 将容器中所有 .mermaid-source 的内容渲染成 SVG，附加点击放大
export async function renderMermaidIn(container) {
  const blocks = container.querySelectorAll('.mermaid-block');
  for (const block of blocks) {
    const source = block.dataset.source;
    if (!source) continue;
    const id = `mmd-${++counter}-${Date.now().toString(36)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
      block.addEventListener('click', () => openDiagramModal(svg));
    } catch (err) {
      block.innerHTML = `<pre style="text-align:left;color:#c2410c">mermaid 渲染失败:\n${err.message}\n\n${source}</pre>`;
    }
  }
}

// 重新渲染当前页面所有 mermaid（用于切换主题后）
export async function reRenderAllMermaid() {
  const blocks = document.querySelectorAll('.mermaid-block');
  for (const block of blocks) {
    const source = block.dataset.source;
    if (!source) continue;
    const id = `mmd-${++counter}-${Date.now().toString(36)}`;
    try {
      const { svg } = await mermaid.render(id, source);
      block.innerHTML = svg;
    } catch (err) {
      // ignore
    }
  }
}

function openDiagramModal(svg) {
  const modal = document.getElementById('diagram-modal');
  const container = document.getElementById('modal-diagram');
  container.innerHTML = svg;
  modal.hidden = false;
}

export function initModal() {
  const modal = document.getElementById('diagram-modal');
  modal.addEventListener('click', (e) => {
    if (e.target.matches('[data-close]')) modal.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) modal.hidden = true;
  });
}
