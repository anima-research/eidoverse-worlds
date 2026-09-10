// capnotice — one persistent, dismissible card when this browser is on a reduced
// path. Toasts fade in seconds; a capability is for the whole visit.
import { backendName } from './core.js';
import { bus } from './base.js';

const LS = 'ew-capnotice-dismissed';
export const WEBGL = {
  title: 'Running on WebGL 2',
  body: 'This browser has no WebGPU (or it is switched off), so three.js is using its WebGL 2 backend. ' +
        'The world works. Expect the sky’s cached lighting to be off, heavier scenes to run slower, and shadows to filter a little differently. ' +
        'Chrome or Edge 113+, or Firefox with WebGPU enabled, get the full version.',
};

let card = null;
function dismissed() { try { return new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch { return new Set(); } }

function show(key, title, body) {
  const seen = dismissed();
  if (seen.has(key)) return;
  if (!card) { card = document.createElement('div'); card.className = 'panel capnotice'; document.body.appendChild(card); }
  if (card.querySelector(`[data-key="${CSS.escape(key)}"]`)) return;
  const item = document.createElement('div');
  item.className = 'cn-item'; item.dataset.key = key;
  item.innerHTML = '<b></b><p></p><div class="cn-btns"><button class="cn-ok">got it</button><button class="cn-never">don’t show again</button></div>';
  item.querySelector('b').textContent = title;
  item.querySelector('p').textContent = body;
  const close = () => { item.remove(); if (card && !card.childElementCount) { card.remove(); card = null; } };
  item.querySelector('.cn-ok').onclick = close;
  item.querySelector('.cn-never').onclick = () => { try { seen.add(key); localStorage.setItem(LS, JSON.stringify([...seen])); } catch {} close(); };
  card.appendChild(item);
}

export function initCapNotice() {
  if (backendName() === 'webgl') show('webgl', WEBGL.title, WEBGL.body);
  bus.on('sky-degraded', ({ msg } = {}) => { if (msg) show('sky', 'Sky simplified', msg); });
}
