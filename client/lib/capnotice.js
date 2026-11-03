// capnotice — the notices that are true of this whole visit (a reduced backend, a GPU that reset under us, a sky that
// had to simplify) as CHIPS on the status strip (statuschips.js) beside the ∃'s mic/ear glyphs, not a card over the
// world. A chip stays for the visit; a click opens its full text with "got it" (folds it) and "don't show again"
// (gone for good, remembered under the same key the card used).
//
// It was a 340px card, top-centre over everything for 30 s (INVENTORY §2: at z 60 it covered the ∃ menu and the help
// sheet). A chip needs no auto-dismiss: at rest it covers nothing.
import { backendName } from './core.js';
import { bus } from './base.js';
import { takeGpuRecovered, recentGpuLosses } from './gpulost.js';
import { statusChip, clearStatusChip } from './statuschips.js';

const LS = 'ew-capnotice-dismissed';
export const WEBGL = {
  label: 'WebGL 2',
  title: 'Running on WebGL 2',
  body: 'This browser is using its WebGL 2 backend instead of WebGPU — usually a phone, an older browser, or VR on a browser without WebGPU flags. ' +
        'The world may render a little differently. Chrome or Edge 113+, or Firefox with WebGPU enabled, get the full version.',
};

function dismissed() { try { return new Set(JSON.parse(localStorage.getItem(LS) || '[]')); } catch { return new Set(); } }

// the one notice that can't be silenced for good (review 12a L1): the page stopped reloading and draws nothing, so a
// remembered 'don't show again' would leave it black and unexplained. It also opens itself, for the same reason.
const ESSENTIAL = new Set(['gpu-stop']);

function show(key, { level = 'attn', label, title, body }) {
  if (dismissed().has(key) && !ESSENTIAL.has(key)) return;
  const actions = [{ label: 'got it' }];
  if (!ESSENTIAL.has(key)) {
    actions.push({ label: 'don’t show again', clear: true, run: () => {
      const seen = dismissed(); seen.add(key);
      try { localStorage.setItem(LS, JSON.stringify([...seen])); } catch {}
    } });
  }
  statusChip({ id: key, level, label, title, body, actions, open: ESSENTIAL.has(key) });
}

const times = (n) => (n > 1 ? ` ×${n}` : '');

export function initCapNotice() {
  if (backendName() === 'webgl') show('webgl', WEBGL);
  const lost = takeGpuRecovered();
  if (lost) {
    const n = recentGpuLosses();
    show('gpu-recovered', { level: 'err', label: `graphics reset${times(n)}`, title: 'Graphics reset',
      body: `Your GPU dropped this page's graphics (${lost}), so it reloaded you back into the world` +
        `${n > 1 ? ` — ${n} times in the last 15 minutes` : ''}. If it keeps happening, lower the sky or render quality in video settings.` });
  }
  bus.on('gpu-lost-stop', ({ rule } = {}) => {
    clearStatusChip('gpu-recovered');   // one chip for the GPU: the newer, worse news replaces it
    const n = recentGpuLosses();
    show('gpu-stop', { level: 'err', label: `graphics lost${times(n)}`, title: 'Graphics lost again',
      body: `The GPU reset again (${rule ?? 'twice in two minutes'}), so the page stopped reloading on its own. Reload when you are ready, ideally with lower sky or render quality.` });
  });
  bus.on('sky-degraded', ({ msg } = {}) => { if (msg) show('sky', { label: 'sky simplified', title: 'Sky simplified', body: msg }); });
}
