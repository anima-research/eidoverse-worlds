// ui — everything that isn't the 3D scene and isn't the chat window.
// Toasts, the loading tray, the HUD, the hint bar, the panel frames, the dock,
// and the two overlays (help, front door).

import { chooseClient } from './litechoice.js';
import { confirmCenter } from './confirmcenter.js';
import { bus, CONFIG, setName, setToken, setErrorSink, report } from './base.js';
import { resizeZoneAt, fitTabStrip } from './frames.js';
import { flipMic, flipEar, micLive, earOn, glyphPinned, setGlyphPinned, micGlyph, earGlyph, xrGlyph, xrGlyphAvailable, xrLive, flipXr } from './mictoggle.js';
import { svg, fsvg, hasFill, rsvg, hasLine } from './icons.js';

// section-head emoji → Phosphor fill glyph (menu chrome never rides emoji —
// the canvas-emoji trap generalizes: platform glyph gaps are silent)
// Upstream labels its dock entries with emoji (main.js: world is '🧱'), and the
// same emoji means different things in different places — '🧱' is genuinely a
// hammer in palette.js's BUILD section. The world panel is NOT a build panel:
// it holds world inventories, public avatars and other non-builder things, and
// the editing affordances fork off elsewhere. A brick was wrong semantically,
// not just visually. So the entry id wins over the emoji: remapping '🧱'
// globally would fix the dock and break build.
const ID_ICON = { world: 'planet' };
const EMOJI_ICON = {
  '💬': 'chat-circle',
  '👋': 'hand-waving',
  '🐞': 'bug',
  '🧱': 'hammer', '🧍': 'person-arms-spread', '🌿': 'plant', '☀': 'sun',
  '✨': 'sparkle', '🌳': 'tree', '📜': 'scroll', '🧩': 'puzzle-piece', '🔊': 'speaker-high', '🎨': 'palette', '🖥': 'monitor', '🥽': 'virtual-reality',
};
// The load list is INJECTED, not imported: assets.js reaches the engine (GLTFLoader),
// and ui.js is shared with a client that has no renderer and therefore never loads an
// asset to list. Default is empty, which is the truth for such a client. main.js wires
// the real one.
let loadingItems = () => [];
export function setLoadingItems(fn) { loadingItems = fn; }
import { makeFrame, getFrame, isLocked, setLocked, resetLayout, escapeHid } from './frames.js';
import { defsRegistry } from './defs.js';
import { register as registerAction, get as getAction } from './actions.js';
import { openLantern, closeLantern, isLanternOpen, CHORD, pillPinned, setPillPinned, setPillQuiet, resetPillPlace } from './lantern.js';

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
  // the raw load list is debug's, not the HUD's (live, 09-05): shown only while debug is open
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
// Esc put every panel away (frames.js): say how to get them back, for a few seconds; when they come back, stop saying it
// …and the lantern's resting line goes away with them and comes back with them (lantern.js setPillQuiet)
bus.on('esc-quiet', (did) => {
  setPillQuiet(did === 'closed');
  if (did === 'closed') flashHint(`<span>${escapeHid() ? 'panels hidden' : 'hidden'} · <kbd>Esc</kbd> to bring back</span>`, 4000);   // one span: the bar is a flex row, which would eat the spaces around the key
  else if (did === 'restored' && el.hint._t && /hidden · Esc to bring back/.test(el.hint.textContent)) endFlash();
});
export function flashHint(html, ms = 2600) {
  el.hint.innerHTML = html;
  el.hint.classList.remove('gone');
  clearTimeout(el.hint._t);
  el.hint._t = setTimeout(endFlash, ms);
}
// a flash is over (its time ran out, or what it said stopped being true): the bar goes back to the ambient offer or away
function endFlash() {
  clearTimeout(el.hint._t);
  el.hint._t = null;
  if (ambientHint) el.hint.innerHTML = ambientHint;
  else el.hint.classList.add('gone');
}

// ============================================================ cursors
// The loupe cursor is inked with --fg (white — live 09-04: 'non-accent for now'). CSS url() cursors can't read
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
 *  reset showed stale fills for up to a second (live, 09-04: 'half the sliders
 *  highlight oddly' after Reset Hair). */
export function paintRangesIn(root = document) {
  for (const i of root.querySelectorAll('input[type=range]')) paintRange(i);
}
setInterval(() => paintRangesIn(document), 200);   // module-scope timer: a node-side importer of ui.js needs an explicit process.exit

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
// ancestors with their own title= while a DESCENDANT holds the tip: their titles are borrowed too, or the browser
// paints the ancestor's NATIVE tooltip beside ours (owner, 09-24: a Build card's name over its ↻ chip's hint)
let tipAnc = [];

function tipHide() {
  clearTimeout(tipTimer); tipTimer = null;
  if (tipHost) { if (tipHost._tip) tipHost.setAttribute('title', tipHost._tip); tipHost._tip = null; tipHost = null; }
  for (const [el, t] of tipAnc) el.setAttribute('title', t);
  tipAnc = [];
  tip.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const host = e.target.closest?.('[title]');
  if (!host || host === tipHost) return;
  tipHide();
  const text = host.getAttribute('title');
  if (!text) return;
  tipHost = host; host._tip = text; host.removeAttribute('title');
  for (let a = host.parentElement?.closest('[title]'); a; a = a.parentElement?.closest('[title]')) {
    tipAnc.push([a, a.getAttribute('title')]); a.removeAttribute('title');
  }
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
    // a VERTICAL rail's buttons say it beside the rail, out over the world — under the button it covered the next one
    const edge = host.closest?.('#dock')?.dataset.edge;
    if (edge === 'left' || edge === 'right') {
      y = Math.round(r.top + r.height / 2 - th / 2);
      x = Math.round(edge === 'left' ? r.right + 10 : r.left - tw - 10);
    }
    // a WATERFALL row (the ∃ menu and its flyout) says it beside the menus, level with the row — under the row it
    // covered the very rows you were moving to (owner, 10-01). Past the rightmost open menu, so a flyout stays clear;
    // the left side if the right has no room.
    if (host.closest?.('#emenu, #emenu-sub')) {
      const menus = ['#emenu', '#emenu-sub'].map((q) => document.querySelector(q)).filter((m) => m && !m.hidden && getComputedStyle(m).display !== 'none')   /* not offsetParent: it is null for any fixed element */.map((m) => m.getBoundingClientRect());
      const right = Math.max(...menus.map((m) => m.right)), left = Math.min(...menus.map((m) => m.left));
      y = Math.round(Math.max(4, Math.min(r.top + r.height / 2 - th / 2, innerHeight - th - 4)));
      x = right + 10 + tw <= innerWidth - 4 ? Math.round(right + 10) : Math.round(left - tw - 10);
    }
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

// World and Settings hold their sections as TABS (owner, 09-29: the A-kit mockup's tabs, not the accordion):
// a strip on top, one pane below. The strip is the profile's own recipe (.pf-tabs/.pf-tab — one tab
// mechanism in this client, not three), and it tightens as the frame narrows: full labels → the chosen
// tab alone keeps its label → icons only → the strip scrolls. Every tab keeps its name as a tooltip.
function tabbedFrame(id, opts) {
  const f = makeFrame(id, opts);
  f.body.classList.add('tabbed');
  const strip = document.createElement('div');
  strip.className = 'pf-tabs sec-tabs'; strip.setAttribute('role', 'tablist');
  const stack = document.createElement('div');
  stack.className = 'stack';
  f.body.append(strip, stack);
  f.stack = stack; f.strip = strip; f.sections = [];
  // how much label the strip can afford, re-decided whenever it or its tabs change size
  const fitStrip = () => fitTabStrip(strip);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitStrip).observe(strip);
  f.fitStrip = fitStrip;
  // A frame never shows an empty pane: shown with no tab chosen, it opens the one last chosen here, else the first.
  const LS = `ew-tab-${id}`;
  f.ensureTab = () => {
    if (!f.visible || f.sections.some((x) => x.isOpen) || !f.sections.length) return;
    let want = null; try { want = localStorage.getItem(LS); } catch {}
    const pick = f.sections.find((x) => x.key === want) ?? f.sections[0];
    pick.toggle(true).catch((e) => report(pick.key, e));
  };
  f.rememberTab = (key) => { try { localStorage.setItem(LS, key); } catch {} };
  f.onShow(() => { f.ensureTab(); fitStrip(); });   // every way back on screen, the viewport restore included
  return f;
}

let worldFrame = null;
export function panelFrame() {
  if (!worldFrame) {
    worldFrame = tabbedFrame('world', {
      title: 'world', x: -10, y: 52, w: 280, h: 320, minW: 200,   // 280: eight tabs with the chosen one's name (the A-kit mockup's column)
    });
  }
  return worldFrame;
}

// engine settings — machine-noun home (video, sound, controls). First tenant:
// the audio panel, moved out of the world menu. Same tabbed shape.
let settingsFrameApi = null;
export function settingsFrame() {
  if (!settingsFrameApi) {
    settingsFrameApi = tabbedFrame('settings', {
      title: 'settings', x: -10, y: 384, w: 280, h: 280, minW: 210, hidden: true,   // right column, UNDER world (52+320+12)
    });
    // the frame registers its own dock entry (its tabs live INSIDE it, so nothing else can open it);
    // a caller that already listed 'settings' wins, and a frame born after initDock still gets its button
    if (!dockEntries.some((e) => e.id === 'settings')) { const entry = { id: 'settings', icon: 'gear-six' }; dockEntries.push(entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
  }
  return settingsFrameApi;
}

/** A section of the world (or settings) frame: a TAB in its strip and a pane under it. onOpen is
 *  awaited each time the tab is chosen, so rosters and catalogs re-fetch instead of going stale.
 *  The api is the accordion's: `box` (#sec-<id>, the pane, .open while chosen) holds `body`; `head`
 *  is the tab button (#sec-<id>-tab); toggle(true) chooses it, toggle(false) folds the pane away,
 *  toggle() flips. */
export function makeSection(title, onOpen, { id = '', host: hostName = 'world' } = {}) {
  const hostFrame = hostName === 'settings' ? settingsFrame() : panelFrame();
  const box = document.createElement('div');
  box.className = 'sec';
  box.setAttribute('role', 'tabpanel');
  if (id) box.id = `sec-${id}`;
  const head = document.createElement('button');
  head.className = 'pf-tab head';
  head.setAttribute('role', 'tab');
  if (id) head.id = `sec-${id}-tab`;
  const m = title.match(/^(\S+)\s+(.*)$/);
  const glyph = m && EMOJI_ICON[m[1].replace(/️/g, '')];
  if (glyph && hasFill(glyph)) head.innerHTML = `${fsvg(glyph, 15)}<span>${m[2]}</span>`;
  else head.textContent = title;
  const label = /^[\p{L}\p{N}]/u.test(title) ? title : title.replace(/^\S+\s+/, '');   // "☀ sky" → "sky"
  head.title = label;
  head.setAttribute('aria-selected', 'false');
  head.setAttribute('aria-expanded', 'false');   // kept for anything reading the accordion's attribute
  const body = document.createElement('div');
  body.className = 'body';

  const select = (on) => {
    box.classList.toggle('open', on); head.classList.toggle('on', on);
    head.setAttribute('aria-selected', String(on)); head.setAttribute('aria-expanded', String(on));
  };
  const api = {
    box, head, body, key: id || label,
    get isOpen() { return box.classList.contains('open'); },
    async toggle(force) {
      const open = force ?? !api.isOpen;   // a tab click passes true: it CHOOSES, never folds
      if (open) {
        for (const o of hostFrame.sections) if (o !== api && o.isOpen) o.toggle(false);
        select(true);
        hostFrame.rememberTab(api.key);
        hostFrame.show();   // shows and raises; its ensureTab finds this tab open and leaves it be
        hostFrame.stack.scrollTop = 0;
        hostFrame.fitStrip();
        { const st = hostFrame.strip, l = head.offsetLeft - st.offsetLeft, r = l + head.offsetWidth;   // a scrolled strip brings its chosen tab into view
          if (l < st.scrollLeft) st.scrollLeft = l; else if (r > st.scrollLeft + st.clientWidth) st.scrollLeft = r - st.clientWidth; }
        await onOpen?.(body);
      } else select(false);
    },
    /** take the tab and its pane out (a mod switched off) */
    remove() {
      const i = hostFrame.sections.indexOf(api); if (i >= 0) hostFrame.sections.splice(i, 1);
      head.remove(); box.remove(); unregisterSelf();
      if (api.isOpen) { select(false); hostFrame.ensureTab(); }
      hostFrame.fitStrip();
    },
  };
  head.onclick = () => api.toggle(true).catch((e) => report(title, e));
  box.append(body);
  hostFrame.strip.appendChild(head);
  hostFrame.stack.appendChild(box);
  hostFrame.sections.push(api);
  hostFrame.fitStrip();
  // a frame already on screen (restored open) gets its tab once this tick's registrations are in
  if (!hostFrame._tabQueued) { hostFrame._tabQueued = true; setTimeout(() => { hostFrame._tabQueued = false; hostFrame.ensureTab(); }, 0); }
  // the lantern finds a section by its own name ("sky", "audio"): open the panel AND the tab.
  // A mod's section may share a built-in's label; a second id keeps it from merging into
  // (and, on remove, deleting) the built-in's row.
  let actionId = `section:${hostName}:${label}`;
  for (let n = 2; getAction(actionId); n++) actionId = `section:${hostName}:${label}#${n}`;
  const unregisterSelf = registerAction({
    id: actionId, title: label, group: hostName, keywords: [hostName],
    icon: glyph ?? undefined, detail: `open the ${label} tab`,
    run: () => api.toggle(true).catch((e) => report(title, e)),
  });
  return api;
}

/** Fold every open pane away (placing a ghost wants the view): the strips stay, no tab chosen. */
export function collapseAll() {
  for (const f of [worldFrame, settingsFrameApi]) for (const x of f?.sections ?? []) if (x.isOpen) x.toggle(false);
}

// ============================================================ who's here

// (the roster frame is gone — 'present' lives in Chat's side pane)
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
// last seen gate state per action entry — the auto-pin fires on the EDGE, not
// the level, so a manual unpin is not undone by the next repaint
const gateWas = new Map();
let pins = new Set();
// every panel starts pinned to the dock; unpinning is the personal choice, not pinning (live, 09-06 23:34)
const DEFAULT_PINS = ['search', 'profile', 'world', 'chat', 'emotes', 'debug', 'settings', 'edit'];   // 'edit' too (live 09-07 10:55) — its ownership gate still decides visibility
try { pins = new Set(JSON.parse(localStorage.getItem(PINS_LS) ?? JSON.stringify(DEFAULT_PINS))) } catch { pins = new Set(DEFAULT_PINS); }
// the search entry arrived after people had saved their pins: pin it ONCE for them, then their unpin is theirs
try { if (!localStorage.getItem('ew-dock-search-seen')) { localStorage.setItem('ew-dock-search-seen', '1'); pins.add('search'); } } catch {}
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

/** The rail as DATA, for the VR ring (live, 09-04 22:02: the radial IS the dock
 *  rendered radially — same pins). Open ∪ pinned, in dock order; action
 *  entries (the wrench) are not frames and stay out. */
/** The profile button wears a presence dot in its bottom-right corner. */
bus.on('presence:me', (v) => paintPresence(v));
export function paintPresence(state) {
  const b = el.dock.querySelector('button[data-toggles="profile"]');
  if (!b) return;
  b.dataset.presence = state;
  b.title = `Profile · ${state}`;
}

// one resolver for the rail AND the VR ring: the ring read only entry.icon, so frames whose glyph comes from the
// id/emoji fallbacks (debug, world, chat) drew blank discs in VR (the owner's headset pass, 09-27)
const iconOf = (e) => e.icon ?? ID_ICON[e.id] ?? EMOJI_ICON[(e.label ?? '').replace(/\uFE0F/g, '')];
export function dockPins() {
  return dockEntries
    .filter((e) => !e.action && (pins.has(e.id) || !!getFrame(e.id)?.visible))
    .map((e) => ({ id: e.id, icon: iconOf(e), open: !!getFrame(e.id)?.visible }));
}

// how a rail entry reads as a lantern row (the rail itself shows only a glyph)
const PANEL_TITLE = { emotes: 'emote bar', edit: 'edit mode', debug: 'debug panel' };
const PANEL_WORDS = { world: ['catalog', 'build'], profile: ['avatar', 'presence', 'friends', 'satchel'],
  chat: ['messages', 'log', 'people'], edit: ['build', 'place'], settings: ['preferences', 'options'] };
function addDockButton(entry) {
  const { id, label, action } = entry;
  const icon = iconOf(entry);   // upstream main.js still labels the rail with emoji; chrome never rides emoji
  const b = document.createElement('button');
  // both weights ride the button; CSS shows the LINE glyph at rest and the
  // FILL glyph while the window is open (the .on class) — a glyph swap, not
  // a color change, is what makes inactive read as inactive
  if (icon && hasFill(icon)) b.innerHTML = (hasLine(icon) ? rsvg(icon, 21) : '') + fsvg(icon, 21);   // +25% glyph, same 34px button
  else b.textContent = label ?? id;
  b.title = dockTitle(entry);
  b.onclick = () => {
    if (action) { action(); paintDock(); return; }
    const f = getFrame(id);
    if (!f) return;
    f.toggle();
    paintDock();
  };
  b.dataset.toggles = id;   // NOT data-frame — that belongs to the window itself
  if (id === SEARCH_ENTRY.id) b.dataset.lanternToggle = '';   // its click closes an open lantern; the line's blur must not (lantern.js)
  // the same act, findable by name in the lantern; a key table may merge its key in (main.js)
  if (!entry.noAction) registerAction({
    id: `panel:${id}`, title: PANEL_TITLE[id] ?? id, group: 'panels', icon, detail: 'open / close the panel',
    keywords: [id, 'panel', ...(PANEL_WORDS[id] ?? [])],
    when: action && entry.gate ? entry.gate : undefined,
    run: () => b.onclick(),
  });
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
// Search & commands: the lantern prompt (Ctrl/Cmd+K). Between emotes and debug (owner, 10-01: "Search almost feels like
// a less-standard feature") — initDock places it. An action entry (not a frame): it lights while the prompt is open.
// It registers no lantern row — a row that opens the prompt you are typing in would be noise.
const SEARCH_ENTRY = { id: 'search', icon: 'magnifying-glass', label: 'Search & commands', noAction: true,
  action: () => (isLanternOpen() ? closeLantern() : openLantern()), active: () => isLanternOpen() };
addEventListener('lantern', () => paintDock());
// every rail button's tooltip: its name, and its key where the action registry knows one ("Chat · Enter",
// "Debug · F3") — read from actions.js at paint time, so a key table merged in later (main.js) shows up
const DOCK_NAME = { search: 'Search & commands' };
function dockTitle(entry, suffix = '') {
  const name = DOCK_NAME[entry.id] ?? (entry.id.charAt(0).toUpperCase() + entry.id.slice(1));
  const key = entry.id === 'search' ? CHORD : getAction(`panel:${entry.id}`)?.key;
  return `${name}${key ? ` · ${key}` : ''}${suffix}`;
}
export function initDock(entries) {
  const lead = initPanels();
  // built-ins lead; a mod registered before boot keeps its entry, once
  const seen = new Set();
  dockEntries = [...lead, ...entries, ...dockEntries].filter((e) => !seen.has(e.id) && seen.add(e.id));
  // search goes in before debug, else after emotes, else ahead of the `last` entries (the sort below keeps those last)
  if (!seen.has(SEARCH_ENTRY.id)) {
    const at = dockEntries.findIndex((e) => e.id === 'debug'), after = dockEntries.findIndex((e) => e.id === 'emotes');
    dockEntries.splice(at >= 0 ? at : after >= 0 ? after + 1 : dockEntries.length, 0, SEARCH_ENTRY);
  }
  // `last: true` entries (the edit wrench) ALWAYS close the list: edit is a
  // MODE, not a window, and it reads as one only when it sits apart at the end
  // (live, 09-05). Mods registering later insert ahead of them (addDockButton).
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
  // AUTO-PIN ON THE GRANT, and only on the transition. R asked for the wrench
  // to "activate and pin to the dock automatically when you do get it", with a
  // manual unpin still winning — so this fires on closed->open, never on every
  // repaint, or the next paint would undo her unpin. A builder who was ALREADY
  // a builder at boot is not pinned over their own earlier choice; only an
  // actual grant counts. The gate is closed for everyone at initDock (rights
  // ride the snapshot, which lands later), so the FIRST report is the level we
  // start from, not an edge — read at initDock, every reload re-pinned a
  // builder's unpinned wrench (measured 10-01; tools/dock-boot-test.ts).
  bus.on('your-rights', () => {
    for (const e of dockEntries) {
      if (!e.action || !e.gate) continue;
      const now = !!e.gate(), was = gateWas.get(e.id);
      gateWas.set(e.id, now);
      if (was === undefined) continue;                 // the arrival: a level
      // BOTH VERBS. R asked to "gray out AND UNPIN ... when you don't have
      // builder status, and it activates and pins to the dock automatically
      // when you do get it" — I quoted that sentence in the comment above and
      // shipped only the pin half (round 5). Pins are ONE GLOBAL key
      // (ew-dock-pins), not per-world, so a single grant anywhere welded a
      // dead wrench to the rail in every world after it.
      if (was === now) continue;                       // level, not edge
      // SAVE ON THE EDGE, not only when the set changes. `pins` hydrates from
      // DEFAULT_PINS when the key is absent (:313), and 'edit' is in that list
      // — so on a FIRST grant `pins.has('edit')` was already true, savePins()
      // was skipped, and nothing was written. The rail looked right but the pin
      // only became durable after a revoke->regrant happened to stamp the key.
      // The edge is exactly the moment this becomes the user's state; persist
      // it. (round 6, measured: LS stayed null across boot and first grant.)
      if (now) pins.add(e.id); else pins.delete(e.id);
      savePins();
    }
    paintDock();
  });
  setInterval(paintDock, 2000);   // role grants land async; the wrench follows (module-scope timer, as above)
  initEMenu();

}

// ---- the rail lives flat on an edge. {edge, along} persisted;
// left/right = vertical (∃ on top), top/bottom = horizontal (∃ leftmost).

// The touch controls own the bottom corners: #stick is left:18 bottom:18 at
// 116px square (so it reserves the bottom 134px on the left), and #touchbtns
// sits bottom-right. A LEFT rail runs straight down into the stick — and the
// clamp in applyDockEdge cannot save it: at 844x390 the rail is taller than
// the column above the stick, so `along` pins to its minimum and the rail
// spans the joystick regardless. That is the whole reason to move: not
// "landscape" as such, but that the rail no longer clears the thumb.
//
// Derived from what the rail actually carries rather than a breakpoint, the
// fitsDefaults() idiom: it stays true if pins are added or removed.
const STICK_RESERVE = 134 + 8;          // #stick (bottom:18 + 116) + breathing room
const DOCK_SLOT = 34 + 2;               // button + gap (index.html #dock)
function railHeight() {
  const slots = 1 + [...new Set([...pins, ...dockEntries.map((e) => e.id)])].length;   // ∃ + every rail icon
  return slots * DOCK_SLOT + 8;         // + the rail's own padding
}
/** A vertical rail needs the column ABOVE the joystick; when it cannot have it,
 *  the top edge is the only one clear of both thumbs. */
export function dockEdgeFitsLeft() {
  if (!document.body.classList.contains('touch')) return true;   // no thumbs, no conflict
  return railHeight() <= innerHeight - STICK_RESERVE;
}
function loadDockEdge() {
  // A deliberate drag always wins — ew-dock-pos is NOT cleared by the layout
  // purge, and it should not be: where you put the rail is your decision.
  try { const p = JSON.parse(localStorage.getItem(DOCKPOS_LS) || 'null'); if (p?.edge) return p; } catch {}
  return dockEdgeFitsLeft() ? { edge: 'left', along: 10 } : { edge: 'top', along: 10 };
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
  // coords on a 125% display) rasterizes every glyph on it soft (live, 09-04)
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
// write a title only when it changes: the tooltip chip borrows the attribute while hovered, and a rewrite every 2 s
// would re-arm the native one (the MutationObserver above routes a real change into the borrow)
function setTitle(b, t) { if ((b._tip ?? b.getAttribute('title')) !== t) b.setAttribute('title', t); }
function paintDock() {
  // the rail never hides — it carries the ∃, which is always visible
  for (const b of el.dock.querySelectorAll('button[data-toggles]')) {
    const id = b.dataset.toggles;
    const entry = dockEntries.find((x) => x.id === id);
    if (entry?.action) {                          // action buttons (edit wrench)
      // GREY, NOT GONE. Hiding a gated action teaches nobody the affordance
      // exists — which is exactly how the wrench went missing for days without
      // either of us noticing. R, 2026-09-11: "gray out and unpin the Edit
      // dock button when you don't have builder status, and it activates and
      // pins to the dock automatically when you do get it."
      const open = entry.gate ? !!entry.gate() : true;
      b.classList.toggle('dead', !open);
      b.disabled = !open;
      setTitle(b, dockTitle(entry, open ? '' : ' — needs build rights in this world'));
      b.hidden = !entry.active?.() && !pins.has(id);
      // never `on` AND `dead`: .on's brand ink and edge-bar come later in the
      // sheet at equal specificity, so the pair rendered as "active but
      // broken" — 42% opacity in full brand colour. (round 5)
      b.classList.toggle('on', open && !!entry.active?.());
      continue;
    }
    const open = !!getFrame(id)?.visible;
    if (entry && id !== 'profile') setTitle(b, dockTitle(entry));   // profile's carries its presence (paintPresence)
    b.classList.toggle('on', open);
    b.hidden = !open && !pins.has(id) && !entry?.always;
  }
  paintEMenu();
}

// ---- the ∃ menu: a File-style waterfall (owner, 10-01) -------------------
// "turning the E-menu into a traditional drop down waterfall menu, kind of like a traditional File menu, pop out to
// the right of E/dock, over the mic/headphones/vr visor icons." Top level: Save world · Load world · Panels ▸ ·
// Log in · Help · Keys · About ▸. Settings and Profile stay on the rail ("I don't want to bury it"). Panels ▸ holds
// what the old menu was: HUD layout mode (the old click-∃ arranging, now a switch of its own), the pins, the lock
// and reset layout. An item never dismisses the menu unless it takes you to another window (help, a login page);
// the menu goes on mouse-away (desktop), a press outside it, and Esc — touch and VR have no hover.
// Alt = the universal window-manager "grab anywhere" chord; show the hand
// so the convention teaches itself.
addEventListener('keydown', (e) => { if (e.key === 'Alt') document.body.classList.add('altgrab'); });
addEventListener('keyup', (e) => { if (e.key === 'Alt') document.body.classList.remove('altgrab'); });
addEventListener('blur', () => document.body.classList.remove('altgrab'));

// What the menu needs to know that ui.js cannot import (net.js is above this rung): INJECTED by main.js, like the
// load list. Defaults are the truth for a client with no server: no build rights, no sign-in.
let menuSrc = { buildRights: () => false, loginUrl: () => null };
export function setMenuSources(src) { menuSrc = { ...menuSrc, ...src }; if (!emenuEl()?.hidden) paintEMenu(); }

// Save and load are honest stubs: the server has no save points to make or restore (grep, 10-01: a world IS its
// append-only log, so every change is already kept; /fork copies a whole world under a new name, owner-only).
const NEEDS_RIGHTS = 'needs build rights in this world';
const SAVE_WHY = 'not yet — this world already keeps every change as it happens (its log); save points need server support. /fork <name> copies the whole world today (owner)';
const LOAD_WHY = 'not yet — restoring a saved world needs server support; a copy made with /fork is its own world (?world=<name>)';
const NO_LOGIN = 'this server has no sign-in — it admits by door key';
const AWAY_MS = 450;   // mouse-away grace: crossing the gap to a flyout, or a wobble off the edge, does not shut the menu

const emenuEl = () => document.getElementById('emenu');
const subEl = () => document.getElementById('emenu-sub');
let subFor = null;     // which top-level row the open flyout belongs to ('panels' | 'about'), null = none
let subCloseT = null;
let layoutBar = null;

// ---- HUD layout mode: the old click-∃ behaviour, now its own switch. Frames show their title tabs and rims, the rail
// its grip, the lantern's resting line goes grabbable (index.html body.arranging). It ends on Esc, on a press out in
// the world, or on its own switch; never because the menu closed.
export const isLayoutMode = () => document.body.classList.contains('arranging');
export function setLayoutMode(on) {
  document.body.classList.toggle('arranging', !!on);
  paintLayoutBar();
  paintEMenu();
}
function paintLayoutBar() {
  if (!layoutBar) return;
  layoutBar.hidden = !isLayoutMode();
  if (!layoutBar.hidden) anchorBeside(layoutBar);
}

function initEMenu() {
  el.hud.onclick = () => toggleEMenu();
  const m = emenuEl();
  let s = subEl();
  if (!s) { s = document.createElement('div'); s.id = 'emenu-sub'; s.className = 'panel'; s.hidden = true; m.after(s); }
  s.addEventListener('pointerenter', () => clearTimeout(subCloseT));
  for (const box of [m, s]) {
    box.setAttribute('role', 'menu');
    // a pin is bookkeeping: it never takes focus, so an open lantern keeps its line and stays open
    box.addEventListener('mousedown', (e) => { if (e.target.closest?.('.mpin')) e.preventDefault(); });
  }
  layoutBar = document.createElement('div');
  layoutBar.id = 'layoutbar'; layoutBar.className = 'panel'; layoutBar.hidden = true;
  layoutBar.innerHTML = `${fsvg('arrows-out-cardinal', 14)}<span>HUD layout — drag panels, the rail's grip, the resting line</span><kbd>Esc</kbd><button class="lb-done">done</button>`;
  layoutBar.querySelector('.lb-done').onclick = () => setLayoutMode(false);
  document.body.appendChild(layoutBar);
  addEventListener('resize', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });
  addEventListener('dockmoved', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });

  // Esc: the deepest level first — the flyout, then the menu, then HUD layout mode (frames.js yields Esc to all
  // three: escapeIsClaimed sees the open menu and body.arranging)
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!m.hidden) { if (subFor) closeSub(); else toggleEMenu(false); }
    else if (isLayoutMode()) setLayoutMode(false);
  });
  addEventListener('pointerdown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // a press outside the menu (and outside the ∃, which toggles it by its own click) dismisses it — tap-outside
    if (!m.hidden && !t?.closest('#emenu, #emenu-sub, #hud')) toggleEMenu(false);
    // HUD layout mode survives presses on ANY chrome (panels, headers, the rail, the menu, the resting line) — it ends
    // out in the world (canvas/body)
    if (isLayoutMode() && !el.hud.contains(t)) {
      const inChrome = (t && t.closest('#emenu, #emenu-sub, #layoutbar, .frame, #dock, .panel, .hud-pop, #micbtn, #earbtn, #xrbtn, #hudstatus'))
        || resizeZoneAt(e.clientX, e.clientY);   // the grab band hangs 6px outside frames
      if (!inChrome) setLayoutMode(false);
    }
  }, true);
  // mouse-away (desktop only: a pen or a finger has no hover to leave with)
  let away = null;
  const arm = () => { if (!away) away = setTimeout(() => { away = null; toggleEMenu(false); }, AWAY_MS); };
  const disarm = () => { clearTimeout(away); away = null; };
  document.addEventListener('pointermove', (e) => {
    if (m.hidden || e.pointerType !== 'mouse') return;
    if (e.target instanceof Element && e.target.closest('#emenu, #emenu-sub, #hud')) disarm(); else arm();
  }, true);
  document.addEventListener('pointerout', (e) => { if (!m.hidden && e.pointerType === 'mouse' && !e.relatedTarget) arm(); }, true);   // left the window
  m.addEventListener('pointerenter', disarm);

  // the same acts, findable by name in the lantern ("save", "layout mode")
  registerAction({ id: 'menu:save', title: 'save world', group: 'world', icon: 'floppy-disk', keywords: ['save', 'snapshot', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? SAVE_WHY : `save world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:load', title: 'load world', group: 'world', icon: 'folder-open', keywords: ['load', 'open', 'restore', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? LOAD_WHY : `load world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:layout', title: 'HUD layout mode', group: 'panels', icon: 'arrows-out-cardinal',
    keywords: ['layout', 'arrange', 'move', 'hud', 'panels', 'drag'], detail: 'move panels, the rail and the resting line',
    run: () => setLayoutMode(!isLayoutMode()) });
  registerAction({ id: 'menu:reset-layout', title: 'reset layout', group: 'panels', icon: 'sparkle', keywords: ['layout', 'reset', 'default', 'panels'],
    detail: 'every window back where it started', run: () => { resetHudLayout(); paintDock(); } });
  registerAction({ id: 'menu:lock', title: 'lock / unlock the layout', group: 'panels', icon: 'lock', keywords: ['layout', 'lock', 'unlock', 'panels'],
    run: () => { setLocked(!isLocked()); paintEMenu(); } });
  registerAction({ id: 'menu:keys', title: 'keys', group: 'view', icon: 'keyboard', keywords: ['keys', 'controls', 'shortcuts', 'bindings'],
    detail: 'the key table', run: () => openKeys() });
  registerAction({ id: 'menu:about', title: 'about this build', group: 'view', icon: 'info', keywords: ['about', 'version', 'build', 'sha'],
    run: () => buildInfo().then((v) => toast(`eidoverse-worlds · ${v.lines.join(' · ')}`, 'info', 9000)) });
  registerAction({ id: 'menu:login', title: 'log in / log out', group: 'view', keywords: ['login', 'logout', 'sign in', 'sign out', 'account', 'discord'],
    run: () => { const it = loginItem(); if (it.dead) toast(it.dead, 'info'); else it.run(); } });
}

export function toggleEMenu(force) {
  const m = emenuEl();
  const open = force ?? m.hidden;
  if (!open) { closeSub(); m.hidden = true; return; }
  m.hidden = false;
  paintEMenu();
  anchorBeside(m);
}
// Beside the ∃, on the side away from the rail's edge: to the right of a left rail (over the mic/ear/visor glyphs),
// left of a right one, under a top rail, over a bottom one. Clamped to the viewport. Never remembered: a dropdown
// hangs from what opened it.
function anchorBeside(node) {
  const h = el.hud.getBoundingClientRect();
  const edge = el.dock.dataset.edge || 'left';
  node.style.left = node.style.top = '0px'; node.style.right = node.style.bottom = 'auto';
  const r = node.getBoundingClientRect();
  let x = h.right + 6, y = h.top;
  if (edge === 'right') x = h.left - 6 - r.width;
  else if (edge === 'top') { x = h.left; y = h.bottom + 6; }
  else if (edge === 'bottom') { x = h.left; y = h.top - 6 - r.height; }
  node.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - r.width - 4, x)))}px`;
  node.style.top = `${Math.round(Math.max(4, Math.min(innerHeight - r.height - 4, y)))}px`;
}

// ---- the flyout: one at a time, beside its row
function openSub(id) {
  clearTimeout(subCloseT);
  const s = subEl();
  if (subFor !== id) {
    subFor = id;
    delete s.dataset.key;
    s.innerHTML = '';
    if (id === 'about') buildAbout(s); else buildPanels(s);
  }
  s.hidden = false;
  paintEMenu();
  placeSub();
}
function closeSub() {
  clearTimeout(subCloseT);
  const s = subEl();
  if (!s) return;
  subFor = null; s.hidden = true; s.innerHTML = ''; delete s.dataset.key;
  for (const r of emenuEl().querySelectorAll('.mrow.subopen')) r.classList.remove('subopen');
}
function placeSub() {
  const s = subEl(), m = emenuEl();
  if (!s || s.hidden || !subFor) return;
  const row = m.querySelector(`.mrow[data-item="${subFor}"]`);
  if (!row) return;
  const mr = m.getBoundingClientRect(), rr = row.getBoundingClientRect();
  s.style.left = s.style.top = '0px'; s.style.maxHeight = '';
  const r = s.getBoundingClientRect();
  // away from the rail: right of the menu, unless the rail is on the right; the other side when that one has no room
  const right = mr.right + 2, left = mr.left - 2 - r.width;
  const fitsR = right + r.width <= innerWidth - 4, fitsL = left >= 4;
  let x, y;
  if (fitsR || fitsL) {
    x = (el.dock.dataset.edge === 'right' ? fitsL || !fitsR : !fitsR) ? left : right;
    y = Math.max(4, Math.min(innerHeight - r.height - 4, rr.top - 6));   // its first row level with its parent row
  } else {
    // a phone: no room on either side — it hangs off its row, indented, so the row that opened it stays in view, on
    // whichever side has more screen (a rail docked low leaves little below), and scrolls inside exactly what is
    // left there: never a floor taller than the room, which pushed the last rows off-screen (review of #212)
    x = Math.max(4, Math.min(innerWidth - r.width - 4, mr.left + 16));
    const below = innerHeight - rr.bottom - 6, above = rr.top - 6;
    const h = Math.min(r.height, Math.max(below, above));
    y = below >= Math.min(r.height, 120) || below >= above ? rr.bottom + 2 : rr.top - 2 - h;
    s.style.maxHeight = `${Math.max(0, Math.round(h))}px`;
  }
  s.style.left = `${Math.round(x)}px`; s.style.top = `${Math.round(y)}px`;
}

// ---- rows
const fsvgOr = (name, size, fallback = 'puzzle-piece') => fsvg(name, size) || fsvg(fallback, size);
/** a top-level item: { id, icon, label, key?, detail?, sub?, dead?, away?, run? } */
function topRow(it) {
  const row = document.createElement('button');
  row.className = `mrow${it.dead ? ' dead soft' : ''}${it.sub ? ' hassub' : ''}`;
  row.dataset.item = it.id;
  row.setAttribute('role', 'menuitem');
  const tail = it.sub ? `<span class="mcaret">${fsvg('caret-right', 10)}</span>`
    : it.key ? `<kbd class="mkey">${escapeHtml(it.key)}</kbd>` : it.tag ? `<span class="mtag">${escapeHtml(it.tag)}</span>` : '';
  row.innerHTML = `${fsvgOr(it.icon, 15)}<span class="mname">${escapeHtml(it.label)}${it.detail ? ` <em class="mdetail">${escapeHtml(it.detail)}</em>` : ''}</span>${tail}`;
  if (it.dead) {
    // listed, not offered — and it SAYS why on a press too (a finger or a laser has no hover for the tooltip)
    row.setAttribute('aria-disabled', 'true');
    row.title = `${it.label} — ${it.dead}`;
    row.onclick = () => { closeSub(); toast(`${it.label} — ${it.dead}`, 'info', 9000); };
  } else if (it.sub) {
    row.setAttribute('aria-haspopup', 'menu');
    row.onclick = () => openSub(it.id);   // opens, never toggles shut: a hover may have opened it a moment ago
    let t = null;
    row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clearTimeout(t); t = setTimeout(() => openSub(it.id), 110); } });
    row.addEventListener('pointerleave', () => clearTimeout(t));
  } else {
    if (it.title) row.title = it.title;
    row.onclick = () => { closeSub(); it.run(); if (it.away) toggleEMenu(false); else paintEMenu(); };
  }
  // hovering a plain row shuts another row's flyout — after a beat, which the flyout cancels when the pointer reaches it
  // (the way there can graze the row below)
  if (!it.sub) row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && subFor) { clearTimeout(subCloseT); subCloseT = setTimeout(closeSub, 250); } });
  return row;
}
function loginItem() {
  if (CONFIG.authed) return { id: 'login', icon: 'sign-out', label: 'Log out', detail: CONFIG.name, away: true, run: logOut };
  const url = menuSrc.loginUrl?.();
  if (url) return { id: 'login', icon: 'sign-in', label: 'Log in', detail: 'with Discord', away: true, run: () => { location.href = url; } };
  return { id: 'login', icon: 'sign-in', label: 'Log in', dead: NO_LOGIN };
}
async function logOut() {
  if (!confirm(`Log out of ${location.host}? You will leave "${CONFIG.world}".`)) return;
  try { await fetch('/logout', { credentials: 'same-origin' }); } catch { /* the reload below still drops the session's page */ }
  // net.js bounces a browser that USED to be signed in straight back through the login (silent while Discord still
  // authorizes) — forget that, or logging out would log you back in
  try { localStorage.removeItem('ew-authed'); } catch { /* private mode */ }
  location.reload();
}
function topItems() {
  const rights = !!menuSrc.buildRights?.();
  return [
    { id: 'save', icon: 'floppy-disk', label: 'Save world', dead: rights ? SAVE_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    { id: 'load', icon: 'folder-open', label: 'Load world', dead: rights ? LOAD_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    'sep',
    { id: 'panels', icon: 'layout', label: 'Panels', sub: true },
    // the way down to the light version, asked first (owner, 10-01); back up is the ∃ there
    { id: 'lite', icon: 'chat-circle', label: 'Lite client', title: "the lite client: chat, emotes and who's here, with no 3D world", run: () => confirmCenter({
      title: 'Switch to the lite client?',
      body: "Chat, emotes and who's here, with no 3D world. Useful on a slow or struggling machine. Click the \u2203 logo there to come back.",
      ok: 'Switch', cancel: 'Stay in 3D',
    }).then((yes) => { if (yes) chooseClient(true); }) },
    'sep',
    loginItem(),
    { id: 'help', icon: 'question', label: 'Help', key: 'H', away: true, run: () => toggleHelp() },
    { id: 'keys', icon: 'keyboard', label: 'Keys', away: true, run: () => openKeys() },
    { id: 'about', icon: 'info', label: 'About', sub: true },
  ];
}
const sep = () => { const s = document.createElement('div'); s.className = 'msep'; s.setAttribute('role', 'separator'); return s; };
function buildTop(m) {
  m.innerHTML = '';
  for (const it of topItems()) m.appendChild(it === 'sep' ? sep() : topRow(it));
}
const topKey = () => `${!!menuSrc.buildRights?.()}|${CONFIG.authed ? 'out' : menuSrc.loginUrl?.() ? 'in' : 'none'}`;

// Keys: the help sheet's key table (defs/ui/_help.json), opened at that table
function openKeys() {
  openOverlay(el.help);
  const h = [...el.help.querySelectorAll('h2')].find((x) => /^keys$/i.test(x.textContent.trim()));
  h?.scrollIntoView({ block: 'start' });
}
// About: what /version says this build is
let versionAsk = null;
function buildInfo() {
  versionAsk ??= fetch('/version', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
    const sha = `${String(v.sha ?? '').slice(0, 7) || 'unknown'}${v.dirty === true ? ' +dirty' : ''}`;
    const when = (t) => (t && t !== 'unknown' ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');
    return { sha, lines: [`build ${sha}`, `code from ${when(v.commitTime)}`, `server up since ${when(v.startedAt)}`] };
  }).catch(() => { versionAsk = null; return { sha: 'unknown', lines: ['build unknown — /version did not answer'] }; });
  return versionAsk;
}
function buildAbout(s) {
  s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div><div class="minfo dim">asking the server…</div>`;
  buildInfo().then((v) => {
    if (subFor !== 'about') return;
    s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div>${v.lines.map((l) => `<div class="minfo">${escapeHtml(l)}</div>`).join('')}`;
    placeSub();
  });
}

const emenuKey = () => dockEntries.filter((e) => !e.action || !e.gate || e.gate()).map((e) => e.id).join('|');
function paintEMenu() {
  const m = emenuEl();
  if (!m || m.hidden) return;
  if (m.dataset.key !== topKey()) { const keep = subFor; buildTop(m); m.dataset.key = topKey(); if (keep) m.querySelector(`.mrow[data-item="${keep}"]`)?.classList.add('subopen'); }
  for (const r of m.querySelectorAll('.mrow[data-item]')) r.classList.toggle('subopen', r.dataset.item === subFor);
  const s = subEl();
  if (!s || s.hidden || subFor !== 'panels') return;
  // rows are built once per entry-set; the 2s sweep only moves their state
  const key = emenuKey();
  if (s.dataset.key !== key) { buildPanels(s); s.dataset.key = key; placeSub(); }
  s.querySelector('.mrow[data-layout]')?.classList.toggle('open', isLayoutMode());
  s.querySelector('.mrow[data-layout]')?.setAttribute('aria-checked', String(isLayoutMode()));
  for (const row of s.querySelectorAll('.mrow[data-row]')) {
    const id = row.dataset.row;
    const entry = dockEntries.find((x) => x.id === id);
    const on = id === 'glyph:mic' ? micLive() : id === 'glyph:ear' ? earOn() : id === 'lantern' ? isLanternOpen()
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
  for (const pin of s.querySelectorAll('.mpin[data-pin]')) {
    const id = pin.dataset.pin;
    const on = id.startsWith('glyph:') ? glyphPinned(id.slice(6)) : id === 'lantern' ? pillPinned() : pins.has(id);
    pin.classList.toggle('on', on);
    pin.setAttribute('aria-pressed', String(on));
    if (pin.disabled) continue;
    pin.title = id === 'lantern'
      ? (on ? `hide the resting line — ${CHORD} and the rail's search still open the lighthouse` : 'rest the line bottom-centre again')
      : id.startsWith('glyph:')
      ? (on ? `detach ${pin.dataset.nm} from the rail` : `attach ${pin.dataset.nm} to the rail`)
      : (on ? 'unpin from rail' : 'pin to rail');
  }
  const lock = s.querySelector('.mrow[data-lock]');
  const lockHtml = `${fsvg(isLocked() ? 'lock' : 'lock-open', 15)}<span class="mname">${isLocked() ? 'layout locked' : 'layout unlocked'}</span>`;
  if (lock && lock.dataset.lock !== String(isLocked())) { lock.dataset.lock = String(isLocked()); lock.innerHTML = lockHtml; }
  lock?.classList.toggle('open', isLocked());
}
/** Every window back where it started, and the lantern's resting line too (it is not a frame, but it moves in
 *  HUD layout mode). The rail's own edge is NOT reset — where you put the rail is your decision (loadDockEdge). */
export function resetHudLayout() { resetLayout(); resetPillPlace(); }
// THE LANTERN'S RESTING LINE (owner, 10-01: "add it as a pin feature for the reverse-E menu (might need its own logo to
// differentiate)"). A group of its own between the voice rows and the windows ("It's not *quite* a conventional panel
// so it can't get docked"): the row opens the lantern, and its pin keeps the pill bottom-centre (lantern.js
// setPillPinned — its own key, ew-lantern-pinned, like the glyphs'). Unpinned, the lantern is still one chord away.
const LANTERN_GLYPH = 'lighthouse';   // the owner's pick (10-01); its own glyph, so it reads apart from the search glass
function pinButton(id, onclick) {
  const pin = document.createElement('button');
  pin.className = 'mpin'; pin.dataset.pin = id;
  pin.innerHTML = fsvg('push-pin', 13);
  if (onclick) pin.onclick = (e) => { e.stopPropagation(); onclick(); paintDock(); paintEMenu(); };
  return pin;
}
function lanternRow() {
  const row = document.createElement('button');
  row.className = 'mrow'; row.dataset.row = 'lantern'; row.dataset.lanternToggle = '';
  row.innerHTML = `${fsvg(LANTERN_GLYPH, 15)}<span class="mname">lighthouse</span>`;
  row.title = `the lighthouse — type or say anything (${CHORD}). Its pin keeps the resting line bottom-centre; unpinned, ${CHORD} and the rail's search still open it`;
  row.onclick = () => { isLanternOpen() ? closeLantern() : openLantern(); paintEMenu(); };
  row.appendChild(pinButton('lantern', () => setPillPinned(!pillPinned())));
  return row;
}
// Panels ▸ — the old ∃ menu, whole: layout mode, the voice glyphs, the lantern, every window, the lock and the reset.
// A row toggles its thing (a window opening beside the HUD is not "another window" — the menu stays); its pin is
// whether that thing rides the rail.
function buildPanels(s) {
  s.innerHTML = '';
  const lay = document.createElement('button');
  lay.className = 'mrow'; lay.dataset.layout = ''; lay.setAttribute('role', 'menuitemcheckbox');
  lay.innerHTML = `${fsvg('arrows-out-cardinal', 15)}<span class="mname">HUD layout mode</span>`;
  lay.title = 'move panels, the rail (its grip) and the lighthouse\'s resting line — Esc or a click out in the world ends it';
  lay.onclick = () => setLayoutMode(!isLayoutMode());
  s.appendChild(lay);
  s.appendChild(sep());
  // voice first: mic + headphones lead in their own section — they matter more than any window, and they wear the SAME
  // glyphs as the floating pair
  const voiceRows = [['mic', 'mic', micGlyph, flipMic], ['headphones', 'ear', earGlyph, flipEar], ['VR', 'xr', xrGlyph, flipXr]];
  for (const [nm, key, glyph, flip] of voiceRows) {
    // VR: the row is always LISTED, but greyed with an explainer when no headset
    // can present — and its pin is dead, so an absent glyph cannot be pinned to
    // the rail (live, 09-05 18:22). The HUD itself never shows the visor unsensed.
    const dead = key === 'xr' && !xrGlyphAvailable();
    const row = document.createElement('button');
    row.className = `mrow${dead ? ' dead' : ''}`; row.dataset.row = `glyph:${key}`;
    row.innerHTML = `${glyph(16)}<span class="mname">${nm}</span>`;
    if (dead) { row.disabled = true; row.title = 'no headset sensed — Chrome finds the OpenXR runtime only at browser start (chrome://restart after SteamVR is up)'; }
    else row.onclick = async () => { if (key === 'xr') toggleEMenu(false); await flip(); paintEMenu(); };   // entering VR is another window
    const pin = pinButton(`glyph:${key}`, dead ? null : () => setGlyphPinned(key, !glyphPinned(key)));
    pin.dataset.nm = nm;
    if (dead) { pin.disabled = true; pin.title = 'nothing to pin until a headset is sensed'; }
    row.appendChild(pin);
    s.appendChild(row);
  }
  s.appendChild(sep());
  s.appendChild(lanternRow());
  s.appendChild(sep());
  // ORDER AT PAINT TIME, not at registration. initDock sorts `last` to the end
  // once, but registerPanel PUSHES later mods onto dockEntries after that sort
  // has already run — so the rail stayed correct (addDockButton inserts before
  // the first [data-last] button) while this menu drifted.
  // R, 2026-09-11: "it should always be at the bottom of both until further notice."
  const ordered = [...dockEntries].sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  const flipPin = (id) => () => { pins.has(id) ? pins.delete(id) : pins.add(id); savePins(); };
  for (const entry of ordered) {
    const { id, action, gate } = entry;
    const icon = iconOf(entry);
    if (action) {
      // ALWAYS a row, gated or not. R, 2026-09-11: "It SHOULD be in the
      // reverse-E menu regardless." A dead row is the menu's existing
      // vocabulary for "listed, not offered".
      const open = gate ? !!gate() : true;
      const row = document.createElement('button');
      row.className = `mrow${open ? '' : ' dead'}`; row.dataset.row = id;
      if (id === SEARCH_ENTRY.id) row.dataset.lanternToggle = '';
      row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
      if (!open) { row.disabled = true; row.title = `${id} — needs build rights in this world`; }
      else row.onclick = () => { action(); paintDock(); paintEMenu(); };
      // a pin, like any window: pinned = the wrench stays on the rail (live, 09-05). Dead row, dead pin: the CSS
      // `pointer-events: none` only stops a hover; a programmatic or assistive activation still fired the handler
      // and pinned a rail icon that is dead on arrival. (round 5)
      const pin = pinButton(id, open ? flipPin(id) : null);
      if (!open) { pin.disabled = true; pin.title = 'nothing to pin until you have build rights'; }
      row.appendChild(pin);
      s.appendChild(row);
      continue;
    }
    if (!getFrame(id)) continue;   // an entry with no frame behind it (a caller's stale id) gets no row
    const row = document.createElement('button');
    row.className = 'mrow'; row.dataset.row = id;
    row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
    // click = toggle; the row's brightness IS the open state
    row.onclick = () => { const f = getFrame(id); if (!f) return; f.toggle(); paintDock(); paintEMenu(); };
    row.appendChild(pinButton(id, flipPin(id)));
    s.appendChild(row);
  }
  s.appendChild(sep());
  const lock = document.createElement('button');
  lock.className = 'mrow'; lock.dataset.lock = '';
  lock.onclick = () => { setLocked(!isLocked()); paintEMenu(); };
  s.appendChild(lock);
  const reset = document.createElement('button');
  reset.className = 'mrow'; reset.dataset.reset = '';
  reset.innerHTML = `${fsvg('sparkle', 15)}<span class="mname">reset layout</span>`;
  reset.title = 'put every window back where it started, and the lighthouse\'s resting line';
  reset.onclick = () => { resetHudLayout(); paintDock(); paintEMenu(); };
  s.appendChild(reset);
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
    s.querySelector('#help-reset').onclick = () => { resetHudLayout(); closeOverlay(el.help); };
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
      // so a body with no portrait showed the browser's broken-image glyph (live, 09-04)
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

// Tab: the people pane (the chat frame's side pane replaced the old roster)
export function togglePeopleHere() {
  const f = getFrame('chat'); const wasVisible = !!f?.visible; if (f && !wasVisible) f.show();
  // ASK the frame for the nodes chat.js built; do NOT re-derive them by class.
  // .chat-cols and .chat-side-tog are part of the PUBLIC class contract
  // (docs/MODDING-UI.md §3) and a local mod is a TRUSTED mod — an in-page ES
  // module handed makeFrame (mods.js:5,88) — so it can legitimately mount
  // markup carrying them into this very body. A class lookup
  // then picks by depth AND order: `:scope >` bounds the first but not the
  // second, and a PREPENDED .chat-cols is a direct child that wins. chat.js
  // captured these nodes as it wrote them and hangs the accessor on the frame,
  // which both files already hold via getFrame('chat'): no import edge, and
  // nothing to steal.
  const cols = f?.sidePane?.('cols');
  const closed = cols?.classList.contains('side-closed');
  // Tab OPENS (defs/ui/_help.json): only a closed pane needs the toggler.
  // A hidden frame whose pane is already open needs nothing but the show()
  // above — clicking there would close the pane Tab was asked to open.
  if (closed) f.sidePane('tog')?.click();
}
