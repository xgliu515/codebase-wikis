// Interactive architecture diagram for the home page: 4 layers + sub-components + click-to-chapter + one-shot request-flow animation

const LAYERS = [
  {
    name: 'Entrypoint',
    sub: 'ds4 CLI  ·  ds4-server (OpenAI/Anthropic API)  ·  ds4-agent  ·  chat template rendering',
    chapters: ['01-architecture-overview', '13-http-server-api', '05-tokenizer-chat'],
    color: '#fb923c',
  },
  {
    name: 'Engine & Session',
    sub: 'ds4_engine  ·  ds4_session  ·  session_sync  ·  disk KV cache',
    chapters: ['06-engine-session', '14-disk-kv-cache'],
    color: '#f97316',
  },
  {
    name: 'Model Forward',
    sub: 'GGUF loading  ·  compressed KV cache  ·  attention sublayer  ·  HC + MoE',
    chapters: ['02-model-architecture', '03-gguf-loading', '07-kv-cache', '08-attention', '09-moe-hyperconnections'],
    color: '#ea580c',
  },
  {
    name: 'Backends',
    sub: 'Metal whole-model graph  ·  CUDA (DGX Spark)  ·  CPU reference  ·  speculative decoding + MTP',
    chapters: ['10-metal-backend', '11-cuda-backend', '12-speculative-mtp', '04-quantization'],
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
    layersHtml += `
      <g class="arch-layer-group" data-layer="${i}" data-chapter="${l.chapters[0]}" style="cursor:pointer">
        <rect class="arch-layer-rect" x="${pad}" y="${y}" width="${layerW}" height="${layerH}" rx="10"></rect>
        <text class="arch-layer-label" x="${pad + 20}" y="${y + 28}">${l.name}</text>
        <text class="arch-layer-sub" x="${pad + 20}" y="${y + 50}">${l.sub}</text>
        <text class="arch-layer-sub" x="${pad + layerW - 20}" y="${y + 28}" text-anchor="end" style="font-weight:600;fill:${l.color}">Ch ${l.chapters.map(c => c.slice(0, 2)).join(', ')} →</text>
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

let playingTimer = null;

export function playArchAnimation() {
  const svg = document.getElementById('arch-svg');
  if (!svg) return;
  const btn = document.getElementById('arch-play-btn');
  if (btn.classList.contains('playing')) return;
  btn.classList.add('playing');
  btn.textContent = '⏸ Playing…';

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
        btn.textContent = '▶ Play one request flow';
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
  btn.textContent = '▶ Play one request flow';
}
