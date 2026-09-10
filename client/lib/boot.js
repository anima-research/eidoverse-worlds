// boot — the first fifteen seconds.
//
// Arriving used to be: a black page while 2.1MB of engine parsed, then a dark
// empty grid while ~22MB of body, clips and sky streamed in, with a small
// bottom-right tray of filenames as the only evidence anything was happening.
// Nothing said what was going on, how far along it was, or when you could move.
//
// Three things fix that, in descending order of how much they matter:
//   1. Something on screen IMMEDIATELY — the splash is static markup in
//      index.html, so it paints before any JavaScript has loaded at all.
//   2. Progress measured in real bytes and real phases, never a fake timer.
//   3. The wait made useful: the controls are on the splash, so the time is
//      spent learning them instead of watching a bar.

import { bus } from './base.js';
import { loadingItems, bootBytes } from './assets.js';

// Phase weights are rough shares of a cold boot, measured rather than guessed
// (see the timings in the commit that added this). They only need to be
// approximately right — what must never happen is the bar reaching 100% and
// then sitting there, so `world` and `sky` deliberately hold the tail.
// What the splash covers is "is there somewhere to stand", which is the engine,
// the connection, the folded log, a body, and ground. The sky is deliberately
// NOT here: it arrives over your head a second later, and waiting for it was
// most of a cold boot.
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
const SHOW_AFTER_MS = 2000, MAX_ITEMS = 1;   // ONE line of load detail (R 09-06 13:24: two left a fat empty gap between the MB line and the tips)
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
const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function paint() {
  if (!el || done) return;
  paintItems();
  const pct = Math.round(progress() * 100);
  bar.style.width = `${pct}%`;
  phaseEl.textContent = currentLabel();
  const b = bootBytes();
  // ALWAYS show the expected total (R, 16:01 — people deserve to know how
  // much they're in for, in case they want to bail). done can overrun the
  // manifest total when late discoveries join; display total grows with it
  // so the fraction stays honest instead of reading 117%.
  const shownTotal = Math.max(b.total, b.done);
  detailEl.textContent = b.total > 0
    ? `${(b.done / 1048576).toFixed(1)} / ${(shownTotal / 1048576).toFixed(1)} MB`
    : '';
}

// Rotating tips — the wait is the best teaching moment the client gets, since
// it's the one time the user is looking at the UI and not at the world.
const TIPS = [
  // audited against the live bindings 09-05 (R: "see if anything needs updating")
  ['@', 'Type <b>@</b> in chat to mention someone. Agents are pinged by name — and get it even if they were away.'],
  ['/', '<b>/w name message</b> whispers privately. It is never written to the world log.'],
  ['B', '<b>B</b> toggles edit mode. Off by default, so looking around never moves anything.'],
  ['↕', 'In edit mode, click anything placed to select it — drag to move, <b>Q</b>/<b>E</b> to turn, <b>Ctrl+Z</b> to undo.'],
  ['∃', 'The <b>∃</b> menu is the drawer: the model library, save and recover, and every panel you have unpinned.'],
  ['X', 'Press <b>X</b> next to a chair and you will sit <i>on</i> it. Nobody had to make it a chair. <b>Z</b> lies down.'],
  ['V', 'Hold <b>V</b> to talk. Your body should wake up silent — the mic is off until you say so.'],
  ['1', 'Number keys play the emote bar\'s gestures, in its order. The bar shows which is which.'],
  ['Esc', '<b>Esc</b> closes every open panel. <b>Esc</b> again brings back exactly the set you had.'],
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
  }[new URLSearchParams(location.search).get('why')];
  if (WHY) { const w = document.createElement('div'); w.className = 'sp-why'; w.textContent = WHY; el.querySelector('.sp-status')?.after(w); }
  bus.on('loading', paintItems);
  itemsTimer = setInterval(paintItems, 500);   // the > 2 s gate needs a clock, not just events
  tipEl = el.querySelector('.sp-tip');
  el.querySelector('.sp-world').textContent = world;
  el.querySelector('.sp-name').textContent = name;
  startedAt = performance.now();

  rotateTip();
  tipTimer = setInterval(rotateTip, 5200);

  // The engine is already parsed by the time this module runs — that phase is
  // complete by definition, and its duration is measurable from navigation.
  // performance.now() is already ms since navigation, so this IS how long the
  // engine took to arrive and parse — the part of the boot the splash exists to
  // cover, and the part no JavaScript can measure from the inside any earlier.
  markPhase('engine', 1);
  marks.engine = Math.round(performance.now());

  // Byte progress refreshes the numbers even when no phase boundary moves, so
  // the bar never looks frozen during one big download.
  bus.on('loading', paint);

  // An escape hatch, always. A stuck asset must never trap someone outside the
  // world — they can walk in and let the rest arrive around them.
  const skip = el.querySelector('.sp-skip');
  skip.onclick = () => finishBoot('skipped');
  setTimeout(() => { if (!done) skip.classList.add('show'); }, 4000);
  // Hard ceiling: if something never reports, leave anyway.
  setTimeout(() => { if (!done) finishBoot('timeout'); }, 45000);

  paint();
}

// ?holdsplash=N keeps the splash up until N seconds after boot began, even
// though the world is ready — R, 09-05: "fake a longer load so I can see what
// it might look like on a big world". Everything else (tips, breath) runs as
// on a real long load; only the dismissal waits.
const HOLD_S = Number(new URLSearchParams(location.search).get('holdsplash')) || 0;
export function finishBoot(reason = 'ready') {
  if (done || !el) return;
  if (HOLD_S > 0) {
    const left = HOLD_S * 1000 - (performance.now() - startedAt);
    if (left > 0) { if (phaseEl) phaseEl.textContent = `holding the splash for a look · ${Math.ceil(left / 1000)}s`; setTimeout(() => finishBoot(reason), Math.min(left, 1000)); return; }
  }
  done = true;
  clearInterval(tipTimer);
  clearInterval(itemsTimer);
  if (itemsEl) itemsEl.innerHTML = '';
  bar.style.width = '100%';
  phaseEl.textContent = 'welcome';
  el.classList.add('gone');
  stopRays();
  setTimeout(() => { el.style.display = 'none'; }, 620);
  const total = Math.round(performance.now() - startedAt);
  console.log(`[boot] ready in ${total}ms (${reason})`, marks);
  bus.emit('booted', { ms: total, reason, marks });
  releaseBoot?.();
}

export const bootDone = () => done;

// Scenery that isn't gating arrival should also not COMPETE with it. Without
// this the sky's 7.5MB simply moved from blocking the boot to stealing its
// bandwidth, and the body — which arrival does wait for — got slower by almost
// exactly what the sky gained.
let releaseBoot;
const bootGate = new Promise((res) => { releaseBoot = res; });
// Yielding to arrival must never become waiting on it FOREVER. Anything that
// awaits this is background work; if boot is somehow stuck, background work
// proceeding is strictly better than a deadlock, and a deadlock here already
// cost a 45-second join once.
const BOOT_GATE_MAX = 12000;
export const whenBooted = () => (done
  ? Promise.resolve()
  : Promise.race([bootGate, new Promise((r) => setTimeout(r, BOOT_GATE_MAX))]));
bus.on('booted', () => releaseBoot?.());

// ---- the rays live in a WORKER (splashrays.worker.js): a WebGL2 shader on an
// OffscreenCanvas, so the splash animates every frame regardless of what
// loading does to the main thread, and stops only if the tab is hard-frozen
// (R, 09-05). Dithered in the shader — Canvas2D banded. Falls back to the
// static gradient (already under it) when OffscreenCanvas/WebGL2 is missing.
let raysWorker = null;
function startRays(el) {
  const cv = el.querySelector('.sp-rays');
  if (!cv || typeof OffscreenCanvas === 'undefined' || !cv.transferControlToOffscreen) return;
  if (new URLSearchParams(location.search).get('rays') === '0') return;   // A/B: does the splash shader slow the load?
  try {
    const calm = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;
    cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    const off = cv.transferControlToOffscreen();
    raysWorker = new Worker(new URL('./splashrays.worker.js', import.meta.url), { type: 'module' });
    raysWorker.onmessage = (e) => { if (e.data?.type === 'nogl') { cv.style.display = 'none'; stopRays(); } };
    raysWorker.postMessage({ type: 'init', canvas: off, calm }, [off]);
    const onResize = () => raysWorker?.postMessage({ type: 'size', w: cv.clientWidth, h: cv.clientHeight });
    addEventListener('resize', onResize);
    globalThis.__raysWorker = raysWorker;   // harness: postMessage({type:'frames'}) answers with the frame count
  } catch { cv.style.display = 'none'; }
}
function stopRays() { raysWorker?.postMessage({ type: 'stop' }); raysWorker = null; }
