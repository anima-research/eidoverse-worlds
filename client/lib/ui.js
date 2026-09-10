// ui — everything that isn't the 3D scene and isn't the chat window.
// Toasts, the loading tray, the HUD, the hint bar, the panel frames, the dock,
// and the two overlays (help, front door).

import { bus, CONFIG, setName, setToken, setErrorSink, report, colorFor } from './base.js';
import { resizeZoneAt } from './frames.js';
import { flipMic, flipEar, micLive, earOn, glyphPinned, setGlyphPinned, micGlyph, earGlyph, xrGlyph, xrGlyphAvailable, xrLive, flipXr } from './mictoggle.js';
import { svg, fsvg, hasFill, rsvg, hasLine } from './icons.js';
import { registerXRPanel } from './xrpanels.js';

// section-head emoji → Phosphor fill glyph (menu chrome never rides emoji —
// the canvas-emoji trap generalizes: platform glyph gaps are silent)
const EMOJI_ICON = {
  '🧱': 'hammer', '🧍': 'person-arms-spread', '🌿': 'plant', '☀': 'sun',
  '✨': 'sparkle', '🌳': 'tree', '📜': 'scroll', '🧩': 'puzzle-piece', '🔊': 'speaker-high', '🎨': 'palette', '🖥': 'monitor', '🥽': 'virtual-reality',
};
import { loadingItems } from './assets.js';
import { makeFrame, getFrame, isLocked, setLocked, resetLayout } from './frames.js';
import { defsRegistry } from './defs.js';

const $ = (id) => document.getElementById(id);
export const el = {
  hud: $('hud'), loading: $('loading'), toasts: $('toasts'), hint: $('hintbar'),
  door: $('door'), help: $('help'), dock: $('dock'), touch: $('touch'),
};

// ============================================================ toasts

const liveToasts = new Map();

export function toast(message, kind = 'info', ttl = kind === 'err' ? 9000 : 5000) {
  const key = `${kind}:${message}`;
  const existing = liveToasts.get(key);
  if (existing) { // same thing again — bump a counter instead of stacking dupes
    existing.n++;
    existing.count.textContent = ` ×${existing.n}`;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(key), ttl);
    return;
  }
  const node = document.createElement('div');
  node.className = `toast panel ${kind}`;
  const body = document.createElement('span');
  body.textContent = message;
  const count = document.createElement('span');
  count.className = 'ctx';
  node.append(body, count);
  node.onclick = () => dismiss(key);
  el.toasts.appendChild(node);
  liveToasts.set(key, { node, count, n: 1, timer: setTimeout(() => dismiss(key), ttl) });
  while (el.toasts.children.length > 5) el.toasts.removeChild(el.toasts.firstChild);
}
function dismiss(key) {
  const t = liveToasts.get(key);
  if (!t) return;
  liveToasts.delete(key);
  clearTimeout(t.timer);
  t.node.classList.add('out');
  setTimeout(() => t.node.remove(), 320);
}
setErrorSink((context, message) => toast(`${context}: ${message}`, 'err'));

// ============================================================ loading tray

bus.on('loading', () => {
  const items = loadingItems();
  // the raw load list is debug's, not the HUD's (R, 09-05): shown only while debug is open
  el.loading.classList.toggle('on', items.length > 0 && !!getFrame('debug')?.visible);
  el.loading.textContent = items.map((l) =>
    l.total ? `⏳ ${l.label} ${Math.min(99, Math.round((l.done / l.total) * 100))}%` : `⏳ ${l.label}…`,
  ).join('\n');
});

// ============================================================ HUD + hints

export function setHud(parts) { el.hud.innerHTML = parts; }

export function setHint(html, { sticky = false } = {}) {
  el.hint.innerHTML = html;
  el.hint.classList.remove('gone');
  if (!sticky) setTimeout(() => el.hint.classList.add('gone'), 30000);
}

// The ambient hint is what the bar shows when nothing louder is happening —
// a standing offer from the world ("X — sit"), set and cleared by proximity.
// A flash (emote names, mode switches) borrows the bar and gives it back.
let ambientHint = null;
export function setAmbientHint(html) {
  if (html === ambientHint) return;   // don't fight setHint's boot message over nothing
  ambientHint = html;
  if (el.hint._t) return;             // a flash owns the bar; it restores us when done
  if (ambientHint) { el.hint.innerHTML = ambientHint; el.hint.classList.remove('gone'); }
  else el.hint.classList.add('gone');
}
export function flashHint(html, ms = 2600) {
  el.hint.innerHTML = html;
  el.hint.classList.remove('gone');
  clearTimeout(el.hint._t);
  el.hint._t = setTimeout(() => {
    el.hint._t = null;
    if (ambientHint) el.hint.innerHTML = ambientHint;
    else el.hint.classList.add('gone');
  }, ms);
}

// ============================================================ cursors
// The loupe cursor is inked with --fg (white — R 09-04: 'non-accent for now'). CSS url() cursors can't read
// custom properties, so the tint is baked here and published as --cur-loupe
// (index.html holds the rule and the native fallback). Rebuilt when the style
// panel writes a new accent.

let _cursorBrand = null;
function buildCursors() {
  const brand = (getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#ebebe9').trim();
  if (brand === _cursorBrand) return;
  _cursorBrand = brand;
  const ink = '#101b1a';
  const enc = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
  const loupe =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<circle cx='10' cy='10' r='6.5' fill='rgba(16,27,26,0.25)' stroke='${brand}' stroke-width='2'/>` +
    `<line x1='15' y1='15' x2='21' y2='21' stroke='${brand}' stroke-width='2.6' stroke-linecap='round'/>` +
    `<line x1='15' y1='15' x2='21' y2='21' stroke='${ink}' stroke-width='1' stroke-linecap='round'/></svg>`;
  document.documentElement.style.setProperty('--cur-loupe', `${enc(loupe)} 10 10, crosshair`);
}
buildCursors();
// the style panel writes tokens straight onto the root element's style;
// buildCursors is a no-op unless --brand actually changed, so our own
// --cur-loupe write can't feed the observer back into itself
new MutationObserver(buildCursors)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// ============================================================ slider fill
// WebKit custom tracks have no progress fill, so every .row range carries a
// --p custom property the track gradient reads (index.html). Painted on user
// input, and swept every 200 ms because panels also set .value from code
// (syncSky and friends fire no events).

function paintRange(i) {
  const min = +i.min || 0, max = +i.max || 100;
  i.style.setProperty('--p', `${(((+i.value || 0) - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=range]')) paintRange(e.target);
}, true);
/** Repaint every slider fill under `root` NOW — call after setting .value from
 *  code (a reset, a sync). The sweep below also catches it, but a code-driven
 *  reset showed stale fills for up to a second (R, 09-04: 'half the sliders
 *  highlight oddly' after Reset Hair). */
export function paintRangesIn(root = document) {
  for (const i of root.querySelectorAll('input[type=range]')) paintRange(i);
}
setInterval(() => paintRangesIn(document), 200);

// ============================================================ tooltips
// Every hover hint in the client is a native title= attribute, which browsers
// paint in OS chrome no token can reach — so "style the tooltips" means owning
// them. One delegated chip: on hover we borrow the title (native suppressed by
// removing the attribute), show the house version, and hand it back on leave.
// Zero call-site changes; new code keeps writing title= and inherits this.

const tip = document.createElement('div');
tip.id = 'tipchip';
document.body.appendChild(tip);
let tipTimer = null, tipHost = null;

function tipHide() {
  clearTimeout(tipTimer); tipTimer = null;
  if (tipHost) { if (tipHost._tip) tipHost.setAttribute('title', tipHost._tip); tipHost._tip = null; tipHost = null; }
  tip.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const host = e.target.closest?.('[title]');
  if (!host || host === tipHost) return;
  tipHide();
  const text = host.getAttribute('title');
  if (!text) return;
  tipHost = host; host._tip = text; host.removeAttribute('title');
  tipTimer = setTimeout(() => {
    if (tipHost !== host || !document.body.contains(host)) return;
    tip.textContent = host._tip;   // reread: paintHud may have refreshed it
    const r = host.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';   // reset before measuring
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.round(r.left + r.width / 2 - tw / 2);
    let y = Math.round(r.bottom + 7);
    if (y + th > innerHeight - 4) y = Math.round(r.top - th - 7);   // flip above
    x = Math.max(4, Math.min(x, innerWidth - tw - 4));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }, 450);
}, true);
document.addEventListener('mouseout', (e) => {
  if (tipHost && !tipHost.contains(e.relatedTarget)) tipHide();
}, true);
document.addEventListener('mousedown', tipHide, true);

// paintHud rewrites #hud.title at 1Hz; while we hold the borrow, route the
// refresh into the stash instead of re-arming the native tooltip mid-hover.
new MutationObserver(() => {
  if (tipHost && !document.body.contains(tipHost)) return tipHide();   // host repainted away mid-hover
  if (tipHost?.hasAttribute('title')) {
    tipHost._tip = tipHost.getAttribute('title');
    tipHost.removeAttribute('title');
    if (tip.classList.contains('show')) tip.textContent = tipHost._tip;
  }
}).observe(document.body, { attributes: true, attributeFilter: ['title'], childList: true, subtree: true });

// ============================================================ panel frames

let worldFrame = null;
export function panelFrame() {
  if (!worldFrame) {
    worldFrame = makeFrame('world', {
      title: 'world', x: -10, y: 52, w: 232, h: 300, minW: 200,   // eight rows, no bleed
    });
    const stack = document.createElement('div');
    stack.className = 'stack';
    worldFrame.body.appendChild(stack);
    worldFrame.stack = stack;
  }
  return worldFrame;
}

// engine settings — machine-noun home (video, sound, controls). First tenant:
// the audio panel, moved out of the world menu. Same stack shape.
let settingsFrameApi = null;
export function settingsFrame() {
  if (!settingsFrameApi) {
    settingsFrameApi = makeFrame('settings', {
      title: 'settings', x: -10, y: 364, w: 232, h: 260, minW: 210, hidden: true,   // right column, UNDER world (52+300+12)
    });
    const stack = document.createElement('div');
    stack.className = 'stack';
    settingsFrameApi.body.appendChild(stack);
    settingsFrameApi.stack = stack;
    // the frame registers its own dock entry (its section heads live INSIDE it, so nothing else can open it);
    // a caller that already listed 'settings' wins, and a frame born after initDock still gets its button
    if (!dockEntries.some((e) => e.id === 'settings')) { const entry = { id: 'settings', icon: 'gear-six' }; dockEntries.push(entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
  }
  return settingsFrameApi;
}

/** Collapsible section inside the world frame. onOpen is awaited each time it
 *  opens, so rosters and catalogs re-fetch instead of going stale. */
export function makeSection(title, onOpen, { id = '', host: hostName = 'world' } = {}) {
  const hostFrame = hostName === 'settings' ? settingsFrame() : panelFrame();
  const host = hostFrame.stack;
  const box = document.createElement('div');
  box.className = 'sec';
  if (id) box.id = `sec-${id}`;
  const head = document.createElement('button');
  head.className = 'head';
  const m = title.match(/^(\S+)\s+(.*)$/);
  const glyph = m && EMOJI_ICON[m[1].replace(/️/g, '')];
  if (glyph && hasFill(glyph)) head.innerHTML = `${fsvg(glyph, 15)}<span>${m[2]}</span>`;
  else head.textContent = title;
  head.setAttribute('aria-expanded', 'false');
  const body = document.createElement('div');
  body.className = 'body';

  const api = {
    box, head, body,
    get isOpen() { return box.classList.contains('open'); },
    async toggle(force) {
      const open = force ?? !box.classList.contains('open');
      box.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
      if (open) { hostFrame.show(); await onOpen?.(body); }
    },
  };
  head.onclick = () => api.toggle().catch((e) => report(title, e));
  box.append(head, body);
  host.appendChild(box);
  return api;
}

export function collapseAll() {
  for (const s of document.querySelectorAll('.sec.open')) s.classList.remove('open');
}

// ============================================================ who's here

// (the roster frame is gone — 'present' lives in Chat's side pane, R 09-05)
export const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ============================================================ dock
// A closed frame has to be findable again. One row of toggles, plus the
// layout lock — the MMO convention: arrange it, then lock it so a stray drag
// can't undo an hour of fiddling.

// Rail semantics (the dev sheet's): an icon rides the rail while its window
// is OPEN or while it is PINNED; otherwise it hides. Pinning lives in the
// ∃ menu. Layout lock also lives there — the rail carries only windows.
const PINS_LS = 'ew-dock-pins';
let pins = new Set();
// every panel starts pinned to the dock; unpinning is the personal choice, not pinning (R, 09-06 23:34)
const DEFAULT_PINS = ['profile', 'world', 'chat', 'emotes', 'debug', 'settings', 'edit'];   // 'edit' too (R 09-07 10:55) — its ownership gate still decides visibility
try { pins = new Set(JSON.parse(localStorage.getItem(PINS_LS) ?? JSON.stringify(DEFAULT_PINS))) } catch { pins = new Set(DEFAULT_PINS); }
const savePins = () => { try { localStorage.setItem(PINS_LS, JSON.stringify([...pins])) } catch {} };
let dockEntries = [];

const DOCKPOS_LS = 'ew-dock-pos';
// ---- mod seam (get un-painted out of the corner; the WoW/Resonite
// lesson — the HUD is a REGISTRY, core panels are just the built-in entries).
// A mod calls eido.ui.registerPanel() and gets: a frame, a menu row, a rail
// icon when open/pinned, arrange/lock/reset participation — everything the
// built-ins get, through the same door. See docs/MODDING-UI.md.
export function registerPanel({ id, icon = 'puzzle-piece', title = id, mount,
                                w = 260, h = 200, x = 60, y = 60 }) {
  if (!id || dockEntries.some((e) => e.id === id)) return null;
  const f = makeFrame(id, { title, x, y, w, h, hidden: true });
  try { mount?.(f.body, f); } catch (err) { console.error(`[mod:${id}] mount failed`, err); }
  const entry = { id, icon };
  dockEntries.push(entry);
  addDockButton(entry);
  paintDock();
  return f;
}
if (typeof window !== 'undefined') {
  window.eido = Object.assign(window.eido ?? {}, { ui: { registerPanel } });
}

/** The rail as DATA, for the VR ring (R, 09-04 22:02: the radial IS the dock
 *  rendered radially — same pins). Open ∪ pinned, in dock order; action
 *  entries (the wrench) are not frames and stay out. */
/** The profile button wears a presence dot in its bottom-right corner. */
export function paintPresence(state) {
  const b = el.dock.querySelector('button[data-toggles="profile"]');
  if (!b) return;
  b.dataset.presence = state;
  b.title = `profile · ${state}`;
}

export function dockPins() {
  return dockEntries
    .filter((e) => !e.action && (pins.has(e.id) || !!getFrame(e.id)?.visible))
    .map((e) => ({ id: e.id, icon: e.icon, open: !!getFrame(e.id)?.visible }));
}

function addDockButton(entry) {
  const { id, label, icon, action } = entry;
  const b = document.createElement('button');
  // both weights ride the button; CSS shows the LINE glyph at rest and the
  // FILL glyph while the window is open (the .on class) — a glyph swap, not
  // a color change, is what makes inactive read as inactive
  if (icon && hasFill(icon)) b.innerHTML = (hasLine(icon) ? rsvg(icon, 21) : '') + fsvg(icon, 21);   // +25% glyph, same 34px button
  else b.textContent = label ?? id;
  b.title = action ? id : `toggle ${id}`;
  b.onclick = () => {
    if (action) { action(); paintDock(); return; }
    const f = getFrame(id);
    if (!f) return;
    f.toggle();
    paintDock();
  };
  b.dataset.toggles = id;   // NOT data-frame — that belongs to the window itself
  if (entry.last) b.dataset.last = '1';
  // before the first `last` button if there is one, else before the grip — so
  // the wrench keeps the end and the grip stays after it
  el.dock.insertBefore(b, (!entry.last && el.dock.querySelector('button[data-last]')) || el.dock.querySelector('.dock-grip'));
  return b;
}

/** The panels the UI owns — profile, style, video, capability notice — and the select skinning.
 *  Called from initDock so they exist wherever the dock does: main.js lists the dock, the UI owns
 *  what's behind it. Returns the entries that lead the rail (profile sits right under ∃). */
function initPanels() {
  // dynamic, not static: profile/videopanel reach controller.js through xrpanels/mybody, and a static edge from
  // ui.js closed an import loop that read controller's `pointerClaimed` before initialization (rung-4 boot).
  // The dock entry is pushed now; the frames land a tick later and the dock repaints so the button shows.
  Promise.all([import('./profile.js'), import('./stylepanel.js'), import('./videopanel.js'), import('./capnotice.js'), import('./dropdown.js')])
    .then(([p, st, v, c, d]) => { p.initProfile(); st.initStylePanel(); v.initVideoPanel(); c.initCapNotice(); d.initDropdowns(); paintDock(); })
    .catch((e) => report('ui panels', e));
  return [{ id: 'profile', icon: 'user-circle' }];
}
export function initDock(entries) {
  const lead = initPanels();
  // built-ins lead; a mod registered before boot keeps its entry, once
  const seen = new Set();
  dockEntries = [...lead, ...entries, ...dockEntries].filter((e) => !seen.has(e.id) && seen.add(e.id));
  // `last: true` entries (the edit wrench) ALWAYS close the list: edit is a
  // MODE, not a window, and it reads as one only when it sits apart at the end
  // (R, 09-05). Mods registering later insert ahead of them (addDockButton).
  dockEntries.sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  el.dock.innerHTML = '';
  // ∃ leads the rail — one unit. (Mic/ear are separate fixed elements that
  // anchor to the ∃'s live box, so they ride along without being "in" it.)
  el.dock.appendChild(el.hud);
  for (const entry of dockEntries) addDockButton(entry);
  // grip: bottom of the rail, exists only while arranging (CSS-gated)
  const grip = document.createElement('button');
  grip.className = 'dock-grip';
  grip.title = 'move the hotbar';
  grip.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="6" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      // LIVE snap: the rail rides its nearest edge THROUGHOUT the
      // drag — no free-floating ghost, no repaint surprise at release
      applyDockEdge(edgeFromPointer(ev));
      dispatchEvent(new CustomEvent('dockmoved'));
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      snapDock(ev);             // persists the final {edge, along}
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  el.dock.appendChild(grip);
  applyDockEdge(loadDockEdge());
  addEventListener('resize', () => applyDockEdge(loadDockEdge()));
  paintDock();
  bus.on('frames', () => paintDock());
  setInterval(paintDock, 2000);   // role grants land async; the wrench follows
  initEMenu();

}

// ---- the rail lives flat on an edge. {edge, along} persisted;
// left/right = vertical (∃ on top), top/bottom = horizontal (∃ leftmost).
function loadDockEdge() {
  try { const p = JSON.parse(localStorage.getItem(DOCKPOS_LS) || 'null'); if (p?.edge) return p; } catch {}
  return { edge: 'left', along: 10 };
}
function applyDockEdge({ edge, along }) {
  el.dock.dataset.edge = edge;   // CSS welds the rail to this side; mic/ear read it too
  const d = el.dock;
  const horiz = edge === 'top' || edge === 'bottom';
  d.classList.toggle('horizontal', horiz);
  // 'auto', not '' — the stylesheet's top:10px/left:10px come back from the
  // dead on '' and pair with the new side into a full-length stretch
  d.style.left = d.style.right = d.style.top = d.style.bottom = 'auto';
  const r = d.getBoundingClientRect();
  const max = horiz ? innerWidth - r.width - 4 : innerHeight - r.height - 4;
  // whole pixels: the rail sits on a blur layer, and a fractional offset (drag
  // coords on a 125% display) rasterizes every glyph on it soft (R, 09-04)
  const a = Math.round(Math.max(4, Math.min(max, along)));
  if (edge === 'left') { d.style.left = '0'; d.style.top = `${a}px`; }
  if (edge === 'right') { d.style.right = '0'; d.style.top = `${a}px`; }
  if (edge === 'top') { d.style.top = '0'; d.style.left = `${a}px`; }
  if (edge === 'bottom') { d.style.bottom = '0'; d.style.left = `${a}px`; }
  // NO resize dispatch here — the window-resize listener calls this function,
  // so announcing via 'resize' recurses (the alt-drag lesson, same shape).
  // mic/ear re-anchor via mictoggle's own observer + safety interval.
}
function edgeFromPointer(ev) {
  const d = [
    { edge: 'left', dist: ev.clientX },
    { edge: 'right', dist: innerWidth - ev.clientX },
    { edge: 'top', dist: ev.clientY },
    { edge: 'bottom', dist: innerHeight - ev.clientY },
  ].sort((a, b) => a.dist - b.dist)[0].edge;
  const vert = d === 'left' || d === 'right';
  return { edge: d, along: Math.round((vert ? ev.clientY : ev.clientX) - 21) };
}
function snapDock(ev) {
  const r = el.dock.getBoundingClientRect();
  // the POINTER picks the edge (dock-center is ambiguous near corners):
  // you drop toward the edge you mean
  const cx = ev?.clientX ?? r.left + r.width / 2;
  const cy = ev?.clientY ?? r.top + r.height / 2;
  const d = [
    { edge: 'left', dist: cx, along: r.top },
    { edge: 'right', dist: innerWidth - cx, along: r.top },
    { edge: 'top', dist: cy, along: r.left },
    { edge: 'bottom', dist: innerHeight - cy, along: r.left },
  ].sort((a, b) => a.dist - b.dist)[0];
  const pos = { edge: d.edge, along: Math.round(d.along) };
  try { localStorage.setItem(DOCKPOS_LS, JSON.stringify(pos)) } catch {}
  applyDockEdge(pos);
}
function paintDock() {
  // the rail never hides — it carries the ∃, which is always visible
  for (const b of el.dock.querySelectorAll('button[data-toggles]')) {
    const id = b.dataset.toggles;
    const entry = dockEntries.find((x) => x.id === id);
    if (entry?.action) {                          // action buttons (edit wrench)
      b.hidden = (entry.gate ? !entry.gate() : false) || (!entry.active?.() && !pins.has(id));
      b.classList.toggle('on', !!entry.active?.());
      continue;
    }
    const open = !!getFrame(id)?.visible;
    b.classList.toggle('on', open);
    b.hidden = !open && !pins.has(id) && !entry?.always;
  }
  paintEMenu();
}

// ---- the ∃ menu — window list, pins, layout lock; open = arranging --------
// Alt = the universal window-manager "grab anywhere" chord; show the hand
// so the convention teaches itself.
addEventListener('keydown', (e) => { if (e.key === 'Alt') document.body.classList.add('altgrab'); });
addEventListener('keyup', (e) => { if (e.key === 'Alt') document.body.classList.remove('altgrab'); });
addEventListener('blur', () => document.body.classList.remove('altgrab'));

const EMENUPOS_LS = 'ew-emenu-pos';
function initEMenu() {
  el.hud.onclick = () => toggleEMenu();
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !emenuEl().hidden) toggleEMenu(false); });
  // Arranging survives clicks on ANY chrome (panels, headers, rail, menu) —
  // it ends only out in the world (canvas/body) or back on the ∃.
  addEventListener('pointerdown', (e) => {
    const m = emenuEl();
    if (m.hidden) return;
    const t = e.target;
    if (el.hud.contains(t)) return;                       // ∃ itself toggles via click
    const inChrome = (t instanceof Element &&
      (m.contains(t) || t.closest('.frame, #dock, .panel, .hud-pop, #micbtn, #earbtn'))) ||
      resizeZoneAt(e.clientX, e.clientY);   // the grab band hangs 6px outside frames
    if (!inChrome) toggleEMenu(false);
  }, true);
  // the menu is a panel like any other: drag it by its empty parts, kept
  const m = emenuEl();
  m.addEventListener('pointerdown', (e) => {
    if (e.target !== m && e.target.className !== 'msep' && !e.target.closest?.('.fr-title')) return;
    e.preventDefault();
    const r = m.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    let moved = false;
    const move = (ev) => {
      moved = true;
      m.style.left = `${Math.max(4, Math.min(innerWidth - r.width - 4, ev.clientX - ox))}px`;
      m.style.top = `${Math.max(34, Math.min(innerHeight - r.height - 4, ev.clientY - oy))}px`;
      m.style.right = m.style.bottom = 'auto';
    };
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      if (!moved) return;
      try { localStorage.setItem(EMENUPOS_LS, JSON.stringify({ x: parseInt(m.style.left), y: parseInt(m.style.top) })) } catch {}
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}
const emenuEl = () => document.getElementById('emenu');
export function toggleEMenu(force) {
  const m = emenuEl();
  const open = force ?? m.hidden;
  m.hidden = !open;
  document.body.classList.toggle('arranging', open);
  if (open) {
    let placed = false;
    try {
      const p = JSON.parse(localStorage.getItem(EMENUPOS_LS) || 'null');
      if (p) p.y = Math.max(34, p.y);   // tab headroom on restore too
      if (p && p.x >= 0) { m.style.left = `${p.x}px`; m.style.top = `${p.y}px`; m.style.right = m.style.bottom = 'auto'; placed = true; }
    } catch {}
    if (!placed) {
      // pop out beside the rail, toward the roomier side of the mark
      const r = el.dock.getBoundingClientRect();
      const right = r.left > innerWidth / 2;
      // folded mic/ear ride beside the ∃ — the menu must clear them too
      let clearRight = r.right;
      for (const id of ['micbtn', 'earbtn']) {
        const g = document.getElementById(id)?.getBoundingClientRect();
        if (g && g.left < r.right + 80 && g.top < r.bottom && g.bottom > r.top) clearRight = Math.max(clearRight, g.right);
      }
      // 'auto', never '' — the sheet's top:54px/left:10px resurrect on '' (the dock's lesson)
      m.style.left = right ? 'auto' : `${Math.round(clearRight + 8)}px`;
      m.style.right = right ? `${Math.round(innerWidth - r.left + 8)}px` : 'auto';
      const h = el.hud.getBoundingClientRect();
      const below = h.top < innerHeight / 2;
      // ≥34px: the menu carries its tab ABOVE itself now — leave it headroom
      m.style.top = below ? `${Math.max(34, Math.round(h.top))}px` : 'auto';
      m.style.bottom = below ? 'auto' : `${Math.round(innerHeight - h.bottom)}px`;
    }
    paintEMenu();
    dodgeEMenu(m);
  }
}
// The menu opens onto the nearest EMPTY spot (R 09-07 11:07: it opened over the profile panel). Its remembered
// or default position is kept when clear; otherwise candidate positions spiral outward from it on a 40 px grid
// and the closest one that overlaps no visible frame wins. Never persisted — a dodge is not a choice.
function dodgeEMenu(m) {
  const r = m.getBoundingClientRect(); if (!r.width) return;
  const frames = [...document.querySelectorAll('.frame')].filter((f) => f.style.display !== 'none')   // frames are position:fixed — offsetParent is null for them, so don't test it
    .map((f) => f.getBoundingClientRect()).filter((b) => b.width && b.height);
  const hits = (x, y) => frames.some((b) => x < b.right + 6 && x + r.width > b.left - 6 && y < b.bottom + 6 && y + r.height > b.top - 6);
  if (!hits(r.left, r.top)) return;
  const W = innerWidth, H = innerHeight, step = 40;
  let best = null;
  for (let dy = 0; dy <= H; dy += step) for (const sy of dy ? [-1, 1] : [1]) {
    const y = Math.round(r.top + sy * dy); if (y < 34 || y + r.height > H - 4) continue;
    for (let dx = 0; dx <= W; dx += step) for (const sx of dx ? [-1, 1] : [1]) {
      const x = Math.round(r.left + sx * dx); if (x < 4 || x + r.width > W - 4) continue;
      const d = dx * dx + dy * dy; if (best && d >= best.d) continue;
      if (!hits(x, y)) best = { x, y, d };
    }
  }
  if (!best) return;
  m.style.left = `${best.x}px`; m.style.top = `${best.y}px`; m.style.right = m.style.bottom = 'auto';
}
function fsvgOrStroke(name, size) {
  if (hasFill(name)) return fsvg(name, size);
  try { return svg(name, size); } catch { return ''; }
}
const emenuKey = () => dockEntries.filter((e) => !e.action || !e.gate || e.gate()).map((e) => e.id).join('|');
function paintEMenu() {
  const m = emenuEl();
  if (!m || m.hidden) return;
  // rows are built once per entry-set; the 2s sweep only moves their state
  const key = emenuKey();
  if (m.dataset.key !== key) { buildEMenu(m); m.dataset.key = key; }
  for (const row of m.querySelectorAll('.mrow[data-row]')) {
    const id = row.dataset.row;
    const entry = dockEntries.find((x) => x.id === id);
    const on = id === 'glyph:mic' ? micLive() : id === 'glyph:ear' ? earOn()
      : entry?.action ? !!entry.active?.() : !!getFrame(id)?.visible;
    row.classList.toggle('open', on);
    // the glyph bakes its ink at build; re-stamp it when the state flips
    const glyph = id === 'glyph:mic' ? micGlyph : id === 'glyph:ear' ? earGlyph : id === 'glyph:xr' ? xrGlyph : null;
    if (glyph && row.dataset.on !== String(on)) {
      row.dataset.on = String(on);
      const g = row.querySelector('svg');
      if (g) g.outerHTML = glyph(16);
    }
  }
  for (const pin of m.querySelectorAll('.mpin[data-pin]')) {
    const id = pin.dataset.pin;
    const on = id.startsWith('glyph:') ? glyphPinned(id.slice(6)) : pins.has(id);
    pin.classList.toggle('on', on);
    pin.title = id.startsWith('glyph:')
      ? (on ? `detach ${pin.dataset.nm} from the rail` : `attach ${pin.dataset.nm} to the rail`)
      : (on ? 'unpin from rail' : 'pin to rail');
  }
  const lock = m.querySelector('.mrow[data-lock]');
  const lockHtml = `${fsvg(isLocked() ? 'lock' : 'lock-open', 15)}<span class="mname">${isLocked() ? 'layout locked' : 'layout unlocked'}</span>`;
  if (lock && lock.dataset.lock !== String(isLocked())) { lock.dataset.lock = String(isLocked()); lock.innerHTML = lockHtml; }
  lock?.classList.toggle('open', isLocked());
}
function buildEMenu(m) {
  m.innerHTML = '<div class="fr-head"><span class="fr-title">menu</span><div class="fr-btns"><button class="fr-btn" title="close">\u2715</button></div></div>';
  m.querySelector('.fr-btn').onclick = () => toggleEMenu(false);
  // voice first: mic + ears lead the menu in their own section — they matter
  // more than any window, and they wear the SAME glyphs as the floating pair
  const voiceRows = [['mic', 'mic', micGlyph, flipMic], ['ears', 'ear', earGlyph, flipEar], ['VR', 'xr', xrGlyph, flipXr]];
  for (const [nm, key, glyph, flip] of voiceRows) {
    // VR: the row is always LISTED, but greyed with an explainer when no headset
    // can present — and its pin is dead, so an absent glyph cannot be pinned to
    // the rail (R, 09-05 18:22). The HUD itself never shows the visor unsensed.
    const dead = key === 'xr' && !xrGlyphAvailable();
    const row = document.createElement('button');
    row.className = `mrow${dead ? ' dead' : ''}`; row.dataset.row = `glyph:${key}`;
    row.innerHTML = `${glyph(16)}<span class="mname">${nm}</span>`;
    if (dead) { row.disabled = true; row.title = 'no headset sensed — Chrome finds the OpenXR runtime only at browser start (chrome://restart after SteamVR is up)'; }
    else row.onclick = async () => { await flip(); paintEMenu(); };
    const pin = document.createElement('button');
    pin.className = 'mpin'; pin.dataset.pin = `glyph:${key}`; pin.dataset.nm = nm;
    pin.innerHTML = fsvg('push-pin', 13);
    if (dead) { pin.disabled = true; pin.title = 'nothing to pin until a headset is sensed'; }
    else pin.onclick = (e) => { e.stopPropagation(); setGlyphPinned(key, !glyphPinned(key)); paintEMenu(); };
    row.appendChild(pin);
    m.appendChild(row);
  }
  { const s = document.createElement('div'); s.className = 'msep'; m.appendChild(s); }
  for (const entry of dockEntries) {
    const { id, icon, action, gate } = entry;
    if (action) {
      if (gate && !gate()) continue;
      const row = document.createElement('button');
      row.className = 'mrow'; row.dataset.row = id;
      row.innerHTML = `${fsvg(icon, 15) || fsvg('puzzle-piece', 15)}<span class="mname">${id}</span>`;
      row.onclick = () => { action(); paintDock(); paintEMenu(); };
      // a pin, like any window: pinned = the wrench stays on the rail (R, 09-05)
      const pin = document.createElement('button');
      pin.className = 'mpin'; pin.dataset.pin = id;
      pin.innerHTML = fsvg('push-pin', 13);
      pin.onclick = (e) => { e.stopPropagation(); pins.has(id) ? pins.delete(id) : pins.add(id); savePins(); paintDock(); paintEMenu(); };
      row.appendChild(pin);
      m.appendChild(row);
      continue;
    }
    if (!getFrame(id)) continue;   // an entry with no frame behind it (a caller's stale id) gets no row
    const row = document.createElement('button');
    row.className = 'mrow'; row.dataset.row = id;
    row.innerHTML = `${fsvg(icon, 15) || fsvg('puzzle-piece', 15)}<span class="mname">${id}</span>`;
    // click = toggle; the row's brightness IS the open state
    // (one less glyph to reason about)
    row.onclick = () => {
      const f = getFrame(id); if (!f) return;
      f.toggle();
      paintDock(); paintEMenu();
    };
    const pin = document.createElement('button');
    pin.className = 'mpin'; pin.dataset.pin = id;
    pin.innerHTML = fsvg('push-pin', 13);
    pin.onclick = (e) => {
      e.stopPropagation();
      pins.has(id) ? pins.delete(id) : pins.add(id);
      savePins(); paintDock(); paintEMenu();
    };
    row.appendChild(pin);
    m.appendChild(row);
  }
  const sep = document.createElement('div'); sep.className = 'msep'; m.appendChild(sep);
  const lock = document.createElement('button');
  lock.className = 'mrow'; lock.dataset.lock = '';
  lock.onclick = () => { setLocked(!isLocked()); paintEMenu(); };
  m.appendChild(lock);
  const reset = document.createElement('button');
  reset.className = 'mrow';
  reset.innerHTML = `${fsvg('sparkle', 15)}<span class="mname">reset layout</span><span class="mdot"></span>`;
  reset.title = 'put every window back where it started';
  reset.onclick = () => { resetLayout(); paintDock(); };
  m.appendChild(reset);
}

// ============================================================ overlays

const sheet = (node) => node.querySelector('.sheet');
export function openOverlay(node) { node.classList.add('open'); }
export function closeOverlay(node) { node.classList.remove('open'); }
export const isOverlayOpen = () => document.querySelector('.scrim.open') !== null;

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.scrim.open');
  if (open && open.id !== 'door') closeOverlay(open); // the door must be answered
});
for (const s of [el.door, el.help]) {
  s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'door') closeOverlay(s); });
}

// ---- help ------------------------------------------------------------------
// The overlay's CONTENT is a def (defs/ui/_help.json, §R4 defs round two) —
// title, subtitle, the key table, the prose sections. A world can reword its
// own welcome without forking the client. Defs are server-owned, the same
// trust domain as this file itself, so the fragments are trusted markup. The
// "Your layout" section stays code-side: it carries a live button wired to
// resetLayout. SINGLE-SOURCE — no baked-in fallback prose (the fallback would
// be the 120-line mirror this move kills); a world serving no help def gets a
// sheet that says so.

export function buildHelp() {
  const paint = () => defsRegistry().then((reg) => {
    const h = reg.uiHelp;
    const s = sheet(el.help);
    s.innerHTML = `
      <button class="close-x" aria-label="close">✕</button>
      ${!h?.keys ? '<p class="sub">this world serves no help def (defs/ui/_help.json)</p>' : `
      <h1>${h.title}</h1>
      <p class="sub">${h.sub}</p>
      <h2>Keys</h2>
      <dl class="keys">${h.keys.map(([label, k]) => `<dt>${label}</dt><dd>${k}</dd>`).join('')}</dl>
      ${(h.sections ?? []).map((x) => `<h2>${x.h}</h2><p class="sub">${x.html}</p>`).join('')}`}
      <h2>Your layout</h2>
      <p class="sub">Every panel moves and resizes, and where you put it is
        remembered. <kbd>Alt</kbd>+drag moves a panel from anywhere on it. The
        🔓 in the corner locks the layout once you like it.
        <button id="help-reset" style="margin-left:6px">reset layout</button></p>`;
    s.querySelector('.close-x').onclick = () => closeOverlay(el.help);
    s.querySelector('#help-reset').onclick = () => { resetLayout(); closeOverlay(el.help); };
  }).catch((e) => report('help def', e));
  paint();
  bus.on('defs-updated', paint);   // edited prose reaches an open client too
}
export function toggleHelp() {
  el.help.classList.contains('open') ? closeOverlay(el.help) : openOverlay(el.help);
}

// ---- the front door --------------------------------------------------------

export function openDoor({ roster = [], needsKey = false, login = null, onEnter }) {
  const s = sheet(el.door);
  s.innerHTML = `
    <div class="fr-head"><span class="fr-title">step in — <b>${escapeHtml(CONFIG.world)}</b></span></div>
    <div class="door-body">
    ${CONFIG.authed
      ? `<p class="sub">arriving as <b>${escapeHtml(CONFIG.name)}</b> — verified via Discord</p>`
      : `<h2>name</h2><label>
      <input id="d-name" type="text" maxlength="48" spellcheck="false" value="${escapeHtml(CONFIG.name)}" placeholder="how the world will know you"></label>`}
    ${needsKey ? `<h2>door key</h2><label>
      <input id="d-key" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(CONFIG.token)}"
        placeholder="the key from your invite"></label>` : ''}
    ${needsKey && login && !CONFIG.authed ? `<p class="sub" style="margin:4px 0 0">
      no key? <a href="${escapeHtml(login)}">sign in with Discord</a> instead —
      it comes back here with the door open</p>` : ''}
    <h2>avatar</h2>
    <div class="grid dense" id="d-roster"></div>
    <button class="go" id="d-go">enter the world</button>
    <p class="sub" style="margin:12px 0 0; text-align:center">
      press <kbd>?</kbd> any time for the controls</p>
    </div>`;

  let chosen = localStorage.getItem('ew-avatar-name') || 'claude';
  const grid = s.querySelector('#d-roster');
  // the button says what you are about to do: enter as WHO, wearing WHAT
  const goBtn = s.querySelector('#d-go');
  const sayGo = () => {
    const nm = CONFIG.authed ? CONFIG.name : (s.querySelector('#d-name')?.value.trim() || '…');
    goBtn.innerHTML = `enter as <b>${escapeHtml(nm)}</b> · ${escapeHtml(chosen)}`;
  };
  s.querySelector('#d-name')?.addEventListener('input', sayGo);
  const paint = () => {
    sayGo();
    grid.innerHTML = '';
    for (const a of roster) {
      const c = document.createElement('button');
      c.className = `card panel ${a.name === chosen ? 'on' : ''}`;
      // Bodies nobody has worn yet have no portrait — say so with a placeholder
      // rather than an empty box that reads as a broken image.
      c.innerHTML = `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(a.name)}.png">
         <div class="ph">🧍</div><span>${escapeHtml(a.name)}</span>`;
      // a JS listener, not an inline onerror= — inline handlers never ran here,
      // so a body with no portrait showed the browser's broken-image glyph (R, 09-04)
      const img = c.querySelector('img');
      img.addEventListener('error', () => { img.style.display = 'none'; c.querySelector('.ph').style.display = 'grid'; });
      c.onclick = () => { chosen = a.name; paint(); };
      grid.appendChild(c);
    }
  };
  paint();

  const go = () => {
    // A verified identity owns the name — the server would ignore an edit
    // anyway (home-node.md §7), so don't offer one.
    let name = CONFIG.name;
    if (!CONFIG.authed) {
      name = s.querySelector('#d-name').value.trim().slice(0, 48);
      if (!name) { s.querySelector('#d-name').focus(); return; }
      setName(name);
    }
    localStorage.setItem('ew-name-set', '1');
    if (needsKey) setToken(s.querySelector('#d-key').value.trim());
    const pick = roster.find((a) => a.name === chosen);
    if (pick) localStorage.setItem('ew-avatar-name', pick.name);
    closeOverlay(el.door);
    onEnter({ name, avatar: pick?.path, avatarName: pick?.name });
  };
  s.querySelector('#d-go').onclick = go;
  // #d-name doesn't exist for a verified arrival — the name isn't editable.
  s.querySelector('#d-name')?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go();
  });
  s.querySelector('#d-key')?.addEventListener('keydown', (e) => e.stopPropagation());

  openOverlay(el.door);
  setTimeout(() => (s.querySelector('#d-name') ?? s.querySelector('#d-go'))?.focus(), 30);
}

// COMPAT for the stacked review only (part 3 of 4): the entry file main.js still comes from upstream at this rung and
// calls the roster that the people pane replaced. Part 4 brings the new entry and removes these two lines.
export function initRoster() {}
export function toggleRoster() { const f = getFrame('chat'); if (f && !f.visible) f.show(); document.querySelector('.chat-side-tog')?.click(); }
