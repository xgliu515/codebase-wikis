// 首页的可交互架构图：4 层 + 子组件名 + 点击跳章节 + 播放一次请求流动画

const LAYERS = [
  {
    name: '入口层 / Entrypoint',
    sub: 'CLI (yargs)  ·  TUI (SolidJS + OpenTUI)  ·  HTTP Server (Hono)  ·  SDK / ACP / Desktop',
    chapters: ['01-entrypoints', '09-tui', '10-server'],
    color: '#fb923c',
  },
  {
    name: 'Session / Agent 层',
    sub: 'Session.chat  ·  MessageV2 / Part  ·  Agent 配置  ·  processor / run-state / retry',
    chapters: ['03-session-and-messages', '04-agents', '05-agent-loop', '13-advanced-features'],
    color: '#f97316',
  },
  {
    name: 'LLM 提供商层',
    sub: 'packages/llm  ·  Vercel AI SDK 封装  ·  protocols  ·  30+ providers  ·  cache policy',
    chapters: ['02-config-and-auth', '06-llm-provider'],
    color: '#ea580c',
  },
  {
    name: '工具与权限层',
    sub: 'Tool registry (bash · read · edit · grep · …)  ·  Permission  ·  MCP  ·  Plugins',
    chapters: ['07-tool-system', '08-permissions', '11-mcp', '12-plugins'],
    color: '#c2410c',
  },
];

export function renderArchSVG(container) {
  const W = 880, H = 420;
  const pad = 30;
  const layerH = 70;
  const layerW = W - pad * 2;
  const gap = (H - pad * 2 - layerH * LAYERS.length) / (LAYERS.length - 1);

  let layersHtml = '';
  let arrowsHtml = '';
  for (let i = 0; i < LAYERS.length; i++) {
    const y = pad + i * (layerH + gap);
    const l = LAYERS[i];
    const chHint = '第 ' + l.chapters.map(c => c.slice(0, 2)).join(', ') + ' 章 →';
    layersHtml += `
      <g class="arch-layer-group" data-layer="${i}" data-chapter="${l.chapters[0]}" style="cursor:pointer">
        <rect class="arch-layer-rect" x="${pad}" y="${y}" width="${layerW}" height="${layerH}" rx="10"></rect>
        <text class="arch-layer-label" x="${pad + 20}" y="${y + 28}">${l.name}</text>
        <text class="arch-layer-sub" x="${pad + 20}" y="${y + 50}">${l.sub}</text>
        <text class="arch-layer-sub" x="${pad + layerW - 20}" y="${y + 28}" text-anchor="end" style="font-weight:600;fill:${l.color}">${chHint}</text>
      </g>
    `;
    if (i < LAYERS.length - 1) {
      const y1 = y + layerH;
      const y2 = pad + (i + 1) * (layerH + gap);
      const mid = W / 2;
      arrowsHtml += `<path class="arch-arrow" d="M ${mid} ${y1 + 2} L ${mid} ${y2 - 6}"></path>`;
    }
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" id="arch-svg">
      <defs>
        <marker id="arrowhead" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-faint)"></path>
        </marker>
      </defs>
      ${arrowsHtml}
      ${layersHtml}
      <circle id="arch-token" class="arch-token-dot" r="6" cx="${W / 2}" cy="${pad - 20}" style="opacity:0"></circle>
    </svg>
  `;

  // 绑定点击：跳转到该层第一个章节
  container.querySelectorAll('.arch-layer-group').forEach(g => {
    g.addEventListener('click', () => {
      const ch = g.dataset.chapter;
      location.hash = `#/${ch}`;
    });
    g.addEventListener('mouseenter', () => {
      g.querySelector('.arch-layer-rect').classList.add('highlight');
    });
    g.addEventListener('mouseleave', () => {
      g.querySelector('.arch-layer-rect').classList.remove('highlight');
    });
  });
}

// 播放一次请求流：token 点从顶部依次落到每一层并高亮
let playingTimer = null;

export function playArchAnimation() {
  const svg = document.getElementById('arch-svg');
  if (!svg) return;
  const btn = document.getElementById('arch-play-btn');
  if (btn.classList.contains('playing')) return;
  btn.classList.add('playing');
  btn.textContent = '⏸ 播放中…';

  const token = svg.querySelector('#arch-token');
  const groups = [...svg.querySelectorAll('.arch-layer-group')];
  groups.forEach(g => g.querySelector('.arch-layer-rect').classList.remove('highlight'));

  const stepMs = 600;
  let i = 0;
  token.style.opacity = '1';

  function step() {
    if (i >= groups.length) {
      animateReturn(token, groups, () => {
        btn.classList.remove('playing');
        btn.textContent = '▶ 播放一次请求流';
        token.style.opacity = '0';
        groups.forEach(g => g.querySelector('.arch-layer-rect').classList.remove('highlight'));
      });
      return;
    }
    const rect = groups[i].querySelector('.arch-layer-rect');
    const bbox = rect.getBBox();
    const cy = bbox.y + bbox.height / 2;
    token.setAttribute('cy', cy);
    rect.classList.add('highlight');
    setTimeout(() => {
      if (i < groups.length - 1) rect.classList.remove('highlight');
      i++;
      playingTimer = setTimeout(step, stepMs);
    }, stepMs * 0.7);
  }
  playingTimer = setTimeout(step, 150);
}

function animateReturn(token, groups, onDone) {
  const reversed = [...groups].reverse();
  let i = 1;
  function back() {
    if (i >= reversed.length) {
      setTimeout(onDone, 400);
      return;
    }
    const rect = reversed[i].querySelector('.arch-layer-rect');
    const bbox = rect.getBBox();
    token.setAttribute('cy', bbox.y + bbox.height / 2);
    rect.classList.add('highlight');
    setTimeout(() => {
      rect.classList.remove('highlight');
      i++;
      playingTimer = setTimeout(back, 400);
    }, 280);
  }
  setTimeout(back, 300);
}

export function resetArchAnimation() {
  if (playingTimer) { clearTimeout(playingTimer); playingTimer = null; }
  const svg = document.getElementById('arch-svg');
  if (!svg) return;
  svg.querySelectorAll('.arch-layer-rect').forEach(r => r.classList.remove('highlight'));
  const token = svg.querySelector('#arch-token');
  if (token) token.style.opacity = '0';
  const btn = document.getElementById('arch-play-btn');
  btn.classList.remove('playing');
  btn.textContent = '▶ 播放一次请求流';
}
