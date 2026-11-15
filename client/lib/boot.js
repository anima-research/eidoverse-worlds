// boot — the first fifteen seconds: the splash (static markup in index.html, painting before any JS), progress in
// real bytes and phases (never a fake timer), and the controls to learn while it waits.

import { bus, CONFIG } from './base.js';
import { escapeHtml } from './ui/markup.js';
// Injected, not imported: assets.js reaches the engine (GLTFLoader), and this splash
// is shared with a client that loads no assets and therefore has no bytes to count.
// The empty defaults are the truth for such a client — its phases finish on their own
// evidence. main.js wires the real counters.
let loadingItems = () => [];
let bootBytes = () => ({ done: 0, total: 0 });
export function setBootAssets({ items, bytes }) {
  if (items) loadingItems = items;
  if (bytes) bootBytes = bytes;
}

// Weights are measured shares of a cold boot; the late phases hold the tail so the bar never sits at 100%.
// The splash covers "somewhere to stand"; the sky is deliberately not waited for.
const PHASES = [
  { key: 'engine', label: 'waking the engine', weight: 14 },
  { key: 'connect', label: 'finding the world', weight: 6 },
  { key: 'world', label: 'folding the world log', weight: 40 },
  { key: 'body', label: 'assembling your body', weight: 40 },
];

const state = new Map(PHASES.map((p) => [p.key, 0])); // key -> 0..1
let el = null, bar = null, phaseEl = null, detailEl = null, tipEl = null;
let done = false;
let startedAt = performance.now();
const marks = {};

export function markPhase(key, value = 1) {
  if (done) return;
  const prev = state.get(key) ?? 0;
  if (value <= prev) return;
  state.set(key, Math.min(1, value));
  if (value >= 1 && !marks[key]) marks[key] = Math.round(performance.now() - startedAt);
  paint();
}

function progress() {
  let got = 0, total = 0;
  for (const p of PHASES) { total += p.weight; got += p.weight * (state.get(p.key) ?? 0); }
  return got / total;
}

function currentLabel() {
  for (const p of PHASES) if ((state.get(p.key) ?? 0) < 1) return p.label;
  return 'stepping in';
}

// ---- what's loading: named items, once they have been in flight > 2 s
const firstSeen = new Map();   // key → performance.now() when first seen in flight
const SHOW_AFTER_MS = 2000, MAX_ITEMS = 1;   // ONE line: two leave an empty gap above the tips
function paintItems() {
  if (!itemsEl || done) return;
  const now = performance.now();
  const items = loadingItems();
  const seen = new Set();
  for (const it of items) { const k = it.label; seen.add(k); if (!firstSeen.has(k)) firstSeen.set(k, now); }
  for (const k of firstSeen.keys()) if (!seen.has(k)) firstSeen.delete(k);
  const shown = items
    .filter((it) => now - (firstSeen.get(it.label) ?? now) > SHOW_AFTER_MS)
    .sort((a, b) => ((b.total || 0) - b.done) - ((a.total || 0) - a.done))
    .slice(0, MAX_ITEMS);
  itemsEl.innerHTML = shown.map((it) => `<div class="sp-load"><span class="sp-load-name">${escapeHtml(prettyLabel(it.label))}</span><span class="sp-load-bytes">${it.total > 0 ? `${(it.done / 1048576).toFixed(1)} / ${(it.total / 1048576).toFixed(1)} MB` : it.done > 0 ? `${(it.done / 1048576).toFixed(1)} MB…` : ''}</span></div>`).join('');
}
const prettyLabel = (l) => String(l).split('/').pop().replace(/\.(vrm|glb|gltf|png|jpg|ktx2|json|g|gl)(\?.*)?$/i, '').replace(/[_-]+/g, ' ');   // some labels arrive pre-truncated ('desk.g')

// The peg is the progress: it enters from the sphere's left skin and rests at 1. Its tip is at x = 48 + 40 = 88 and
// the sphere's leftmost point is 8, so D >= 80 hides it at rest; +0.5 clears the anti-aliased edge.
const PEG_D = 88 - 8 + 0.5;
/** Linear, easing out on the last stretch so the peg ARRIVES; ease(0) = 0, ease(1) = 1 exactly, monotone. */
function pegEase(p) { const k = 0.35; return (1 - k) * p + k * (1 - Math.pow(1 - p, 3)); }
/** The peg's x offset at progress p: −D at 0, exactly 0 at 1. */
const pegOffset = (p) => -PEG_D * (1 - pegEase(Math.min(1, Math.max(0, p))));
/** At p ≥ 1 the transform and clip are REMOVED, not zeroed: a no-op clip still re-antialiases the skin edge. */
export function paintPeg(p, root = document.getElementById('splash')) {
  const peg = root?.querySelector('.sp-peg'); if (!peg) return;
  const world = peg.parentNode;
  if (p >= 1) {
    peg.style.transform = '';
    // the clip goes once the .3s glide lands, or a still-gliding peg shows outside the sphere
    const drop = () => { if (peg.style.transform === '') world.removeAttribute?.('clip-path'); };
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) drop(); else setTimeout(drop, 350);
  } else {
    world.setAttribute?.('clip-path', 'url(#sp-sphere)');
    peg.style.transform = `translateX(${pegOffset(p).toFixed(3)}px)`;
  }
}

function paint() {
  if (!el || done) return;
  paintItems();
  const p = progress();
  paintPeg(p, el);
  const pct = Math.floor(p * 100);
  bar.style.width = `${pct}%`;
  phaseEl.textContent = currentLabel();
  const b = bootBytes();
  // Always show the expected total; it grows with late discoveries so the fraction never reads over 100%.
  const shownTotal = Math.max(b.total, b.done);
  detailEl.textContent = b.total > 0
    ? `${(b.done / 1048576).toFixed(1)} / ${(shownTotal / 1048576).toFixed(1)} MB`
    : '';
}

// rotating tips — keep them in step with the live bindings; an agent's wake rules are its own: describe, never promise
const TIPS = [
  ['@', 'Type <b>@</b> in chat to mention someone by name. An agent listening for its name may be pinged.'],
  ['/', 'Type <b>/</b> in chat for commands. Everything said in a world is public: everyone here hears it.'],
  ['B', '<b>B</b> toggles builder mode. Off by default, so looking around never moves anything.'],
  ['↕', 'In builder mode, click anything placed to select it — drag to move, <b>Q</b>/<b>E</b> to turn, <b>Ctrl+Z</b> to undo.'],
  ['∃', 'The <b>∃</b> menu is the drawer: the model library, save and recover, and every panel you have unpinned.'],
  ['X', 'Press <b>X</b> next to a chair and you will sit <i>on</i> it. Nobody had to make it a chair. <b>Z</b> lies down.'],
  ['V', 'Hold <b>V</b> to talk. Your body should wake up silent — the mic is off until you say so.'],
  ['1', 'Number keys play the bar\'s gestures, in its order (sit/stand/lie are X and Z). The bar shows which is which.'],
  ['Tab', '<b>Tab</b> hides every open panel and brings back exactly what you had. <b>F11</b> is full screen; <b>Esc</b> leaves it.'],
  ['●', 'Click your portrait in the profile to set present, away or busy. Everyone here sees it beside your name.'],
  ['P', '<b>P</b> is photo mode: free camera, <b>F1</b> hides the UI, <b>F2</b> saves the shot.'],
  ['▦', 'Every panel moves and resizes. Where you put them is remembered.'],
];
let tipIdx = Math.floor(Math.random() * TIPS.length);
let tipTimer = null;
let itemsEl = null, itemsTimer = null;
function rotateTip() {
  if (!tipEl) return;
  tipIdx = (tipIdx + 1) % TIPS.length;
  const [k, text] = TIPS[tipIdx];
  tipEl.innerHTML = `<span class="tipk">${k}</span><span>${text}</span>`;
}

export function initBoot({ world, name }) {
  el = document.getElementById('splash');
  if (!el) return;
  bar = el.querySelector('.sp-bar-fill');
  startRays(el);
  phaseEl = el.querySelector('.sp-phase');
  detailEl = el.querySelector('.sp-detail');
  itemsEl = el.querySelector('.sp-items');
  const WHY = {
    'vr-webgl': 'restarted on WebGL 2 for VR — this browser can\'t present VR from WebGPU yet (Video settings › VR renderer)',
    'vr': 'restarted in VR mode',
  }[CONFIG.params.get('why')];
  if (WHY) { const w = document.createElement('div'); w.className = 'sp-why'; w.textContent = WHY; el.querySelector('.sp-status')?.after(w); }
  bus.on('loading', paintItems);
  itemsTimer = setInterval(paintItems, 500);   // the > 2 s gate needs a clock, not just events
  tipEl = el.querySelector('.sp-tip');
  el.querySelector('.sp-world').textContent = world;
  el.querySelector('.sp-name').textContent = name;
  startedAt = performance.now();

  rotateTip();
  tipTimer = setInterval(rotateTip, 5200);

  // The engine is parsed by the time this runs; performance.now() (ms since navigation) is its arrival time.
  markPhase('engine', 1);
  marks.engine = Math.round(performance.now());

  // bytes refresh the numbers between phases, so one big download never looks frozen
  bus.on('loading', paint);

  // an escape hatch, always: a stuck asset must never trap someone outside the world
  const skip = el.querySelector('.sp-skip');
  skip.onclick = () => finishBoot('skipped');
  setTimeout(() => { if (!done) skip.classList.add('show'); }, 4000);
  // Hard ceiling: if something never reports, leave anyway.
  setTimeout(() => { if (!done) finishBoot('timeout'); }, 45000);

  paint();
}

// ?holdsplash=N keeps the splash up until N s after boot began, to preview a long load; only the dismissal waits.
const HOLD_S = Number(CONFIG.params.get('holdsplash')) || 0;
export function finishBoot(reason = 'ready') {
  if (done || !el) return;
  if (HOLD_S > 0) {
    const left = HOLD_S * 1000 - (performance.now() - startedAt);
    if (left > 0) { if (phaseEl) phaseEl.textContent = `holding the splash for a look · ${Math.ceil(left / 1000)}s`; setTimeout(() => finishBoot(reason), Math.min(left, 1000)); return; }
  }
  done = true;
  disarmTripwire();
  clearInterval(tipTimer);
  clearInterval(itemsTimer);
  if (itemsEl) itemsEl.innerHTML = '';
  bar.style.width = '100%';
  paintPeg(1, el);   // skipped, timed out, or arrived: the mark comes to rest whatever the count said
  phaseEl.textContent = 'welcome';
  el.classList.add('gone');
  stopRays();
  setTimeout(() => { el.style.display = 'none'; }, 620);
  const total = Math.round(performance.now() - startedAt);
  console.log(`[boot] ready in ${total}ms (${reason})`, marks);
  bus.emit('booted', { ms: total, reason, marks });
  releaseBoot?.();
}

/** A refused join (close 4005 and kin) keeps the splash up in the server's words; nothing lifts it, a reload returns. */
export function refuseBoot(text) {
  const root = el ?? document.getElementById('splash');
  if (!root) return;
  el = root;
  done = true;   // finishBoot, the 45 s ceiling and the progress painters all stand down
  clearInterval(tipTimer);
  clearInterval(itemsTimer);
  stopRays();
  root.classList.remove('gone');
  root.style.display = '';
  root.classList.add('refused');
  const phase = root.querySelector('.sp-phase');
  if (phase) { phase.textContent = String(text ?? ''); phase.setAttribute('role', 'alert'); }
  const detail = root.querySelector('.sp-detail');
  if (detail) detail.textContent = '';
  const sub = root.querySelector('.sp-sub');
  if (sub) sub.textContent = "couldn't step in";
}

/** Nothing is pinned: the next successful join finishes it as usual. */
export function waitBoot(text) {
  const root = el ?? document.getElementById('splash');
  if (!root || done) return false;
  el = root;
  const phase = root.querySelector('.sp-phase');
  if (phase) { phase.textContent = String(text ?? ''); phase.setAttribute('role', 'status'); }
  const sub = root.querySelector('.sp-sub');
  if (sub) sub.textContent = 'waiting for room — trying again by itself';
  return true;
}

/** On pagehide or after DWELL_MS, never at finishBoot: assets stream on after arrival, and that tail is where phones die.
 *  A crash after the dwell is forgotten, on purpose. */
const DWELL_MS = 60000;
function disarmTripwire() {
  // A lite session (lite.js calls finishBoot too) proves nothing about the full client: don't clear its evidence.
  if (globalThis.__ewLite) return;
  const key = globalThis.__ewTripKey?.(new URLSearchParams(location.search)) ?? 'ew-boot-attempt';
  // unconditional: a bfcache restore re-arms, so an "already cleared" guard would leave the flag set forever
  setTimeout(() => {
    globalThis.__ewTripDisarmed = true;
    try {
      localStorage.removeItem(key);
      localStorage.removeItem(globalThis.__ewRetryKey?.(new URLSearchParams(location.search)) ?? 'ew-boot-retried');   // the retry worked
    } catch { /* storage blocked; never armed either */ }
  }, DWELL_MS);
}

export const bootDone = () => done;

// Scenery that doesn't gate arrival must not compete with it for bandwidth (the sky would slow the body).
let releaseBoot;
const bootGate = new Promise((res) => { releaseBoot = res; });
// Yielding to arrival must never become waiting forever: if boot is stuck, background work proceeds.
const BOOT_GATE_MAX = 12000;
export const whenBooted = () => (done
  ? Promise.resolve()
  : Promise.race([bootGate, new Promise((r) => setTimeout(r, BOOT_GATE_MAX))]));
bus.on('booted', () => releaseBoot?.());

// ---- the rays live in a WORKER (splashrays.worker.js) so they animate whatever the main thread does
// worker, resize listener and harness handle are one resource: stopRays releases all three, idempotently
let raysWorker = null, raysResize = null;
export function startRays(el) {
  const cv = el.querySelector('.sp-rays');
  if (!cv || typeof OffscreenCanvas === 'undefined' || !cv.transferControlToOffscreen) return;
  if (CONFIG.params.get('rays') === '0') return;   // A/B: does the splash shader slow the load?
  stopRays();   // a second start releases the first worker + listener instead of stacking them
  try {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;
    cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    const off = cv.transferControlToOffscreen();
    raysWorker = new Worker(new URL('./splashrays.worker.js', import.meta.url), { type: 'module' });
    // three outcomes kept distinct: ACK = drew a frame; NOGL = declined (fallback); silence = neither
    raysWorker.onmessage = (e) => {
      const t = e.data?.type;
      if (t === 'ready') { globalThis.__raysAck = true; return; }
      if (t === 'nogl') { globalThis.__raysNoGl = true; cv.style.display = 'none'; stopRays(); }
    };
    raysWorker.postMessage({ type: 'init', canvas: off, calm }, [off]);
    raysResize = () => raysWorker?.postMessage({ type: 'size', w: cv.clientWidth, h: cv.clientHeight });
    addEventListener('resize', raysResize);
    globalThis.__raysWorker = raysWorker;   // harness: postMessage({type:'frames'}) answers with the frame count
    // cumulative, never cleared: a polling sampler can miss a short-lived worker
    globalThis.__raysStarted = true;
  } catch { cv.style.display = 'none'; stopRays(); }
}
export function stopRays() {
  const w = raysWorker;
  raysWorker = null;
  if (raysResize) { removeEventListener('resize', raysResize); raysResize = null; }
  if (globalThis.__raysWorker) globalThis.__raysWorker = null;
  if (w) { try { w.postMessage({ type: 'stop' }); } catch { /* already closed */ } }
}
export const raysActive = () => raysWorker !== null;
