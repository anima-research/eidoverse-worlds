// ui — everything that isn't the 3D scene and isn't the chat window.
// Toasts, the loading tray, the HUD, the hint bar, the panel frames and the help overlay. The rail is
// ui-dock.js, the ∃ menu ui-menu.js, the front door ui-door.js; they import this file, it imports only the dock.

import { bus, setErrorSink, report } from '../base.js';
import { fitTabStrip, makeFrame, getFrame, resetLayout, escapeHid } from './windows.js';
import { svg, fsvg, hasFill } from './icons.js';
import { html, paint, lineKey, escapeHtml } from './markup.js';
import { defsRegistry } from '../defs.js';
import { register as registerAction, get as getAction } from './actions.js';
import { setPillQuiet, resetPillPlace } from './commandbar.js';
import { EMOJI_ICON, ensureDockEntry } from './ui-dock.js';
export { html, markup } from './markup.js';

// The load list is injected (main.js), not imported: ui.js is shared with a client that has no renderer.
let loadingItems = () => [];
export function setLoadingItems(fn) { loadingItems = fn; }

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
// One notice per kind of failure, not per thing: fetches that failed with the same status are one toast that counts
// them (each thing's line goes to the console). Dismissing it keeps that kind quiet for the session.
const groups = new Map(), quiet = new Set();
export function errorToast(context, message) {
  const m = /\bfetch (\S+): (\d{3})\b/.exec(String(message));
  if (!m) { toast(`${context}: ${message}`, 'err'); return; }
  const kind = `fetch-${m[2]}`;
  console.warn(`[load] ${context}: ${message}`);
  if (quiet.has(kind)) return;
  const g = groups.get(kind) ?? { things: new Set() }; groups.set(kind, g); g.things.add(String(context));
  const n = g.things.size, why = m[2] === '404' ? 'not on this server' : `the server answered ${m[2]}`;
  const text = `${n} thing${n === 1 ? '' : 's'} couldn't load (${why}) — the list is in the console`;
  const live = g.key && liveToasts.get(g.key);
  if (live) { live.node.firstChild.textContent = text; clearTimeout(live.timer); live.timer = setTimeout(() => dismiss(g.key), 9000); return; }
  toast(text, 'err');
  g.key = `err:${text}`;
  const t = liveToasts.get(g.key); if (t) { const tk = g.key; t.node.onclick = () => { quiet.add(kind); dismiss(tk); }; }
}
setErrorSink(errorToast);

// ============================================================ loading tray

bus.on('loading', () => {
  const items = loadingItems();
  // the raw load list is debug's, not the HUD's: shown only while debug is open
  el.loading.classList.toggle('on', items.length > 0 && !!getFrame('debug')?.visible);
  el.loading.textContent = items.map((l) =>
    l.total ? `⏳ ${l.label} ${Math.min(99, Math.round((l.done / l.total) * 100))}%` : `⏳ ${l.label}…`,
  ).join('\n');
});

// ============================================================ HUD + hints

export function setHud(parts) { el.hud.innerHTML = parts; }

// The hint bar shows TEXT unless it is handed markup built with html`` (markup.js): a plain string — a person's name, a
// thing's label, an error from anywhere — is shown as the characters it is, never parsed (security pass 3, H1).
// ============================================================ ONE status bar
// #hintbar is the one bar at the lantern's spot, and everything CLAIMS it with a priority:
//   1 attn      a refusal (attention colour, copy pill, holds while pointed at)
//   2 keys      the engaged gesture's keys (keyhints `during`)
//   3 flash     a moment's notice ("panels hidden · Tab", "locked", the authority's warnings on my own edit)
//   4 selection build mode's selection line (name · keys · lock)
//   5 ambient   the standing offer from the world ("X — sit")
// The lowest number live shows; when it ends, the next live one shows (no stacking, no gaps). The lantern pill is the
// resting content: it yields while any claim shows and comes back when none does. Content: text (shown as the
// characters it is — security pass 3, H1), markup built with html``, or a node (the selection line, with its checkbox).
const claims = new Map();   // id → { id, priority, content, node, tone, hold, ttl, timer }
let hovering = false;
const winner = () => { let w = null; for (const c of claims.values()) if (!w || c.priority < w.priority) w = c; return w; };
export function claimStatus(id, { priority = 3, content = null, node = null, tone = null, ttl = null, hold = false } = {}) {
  const old = claims.get(id); if (old?.timer) clearTimeout(old.timer);
  const c = { id, priority, content, node, tone, hold, ttl, timer: null };
  const arm = (ms) => { c.timer = setTimeout(() => { if (claims.get(id) !== c) return;
    if (c.hold && hovering && winner() === c) { arm(1500); return; }   // pointed at: it stays until the pointer leaves
    claims.delete(id); showStatus(); }, ms); };
  if (ttl) arm(ttl);
  claims.set(id, c); showStatus();
}
export function releaseStatus(id) { const c = claims.get(id); if (!c) return; if (c.timer) clearTimeout(c.timer); claims.delete(id); showStatus(); }
export const statusShown = () => winner()?.id ?? null;
const pillYield = (on) => document.getElementById('lantern-pill')?.classList.toggle('yield', on);
function addCopy(h) {
  // a refusal can be copied: its text is selectable, a copy button sits at its end, and pointing at it holds it on screen
  const b = document.createElement('button'); b.type = 'button'; b.className = 'hint-copy'; b.title = 'copy this message'; b.textContent = '⧉';
  b.onclick = (e) => { e.stopPropagation(); const t = [...h.childNodes].filter((n) => n !== b).map((n) => n.textContent).join('').trim();
    navigator.clipboard?.writeText(t).then(() => { b.textContent = '✓'; }, () => { b.textContent = 'select it to copy'; }); };
  h.append(b);   // at the end of the words; an attn bar wraps, so a long reason never cuts it off
}
function showStatus() {
  const c = winner(), h = el.hint;
  h.classList.toggle('attn', c?.tone === 'attn');
  h.classList.toggle('has-node', !!c?.node);
  if (!c) { h.classList.add('gone'); h._t = null; delete h.dataset.keyhint; pillYield(false); return; }
  if (c.node) h.replaceChildren(c.node); else { paint(h, c.content); if (c.tone === 'attn') addCopy(h); }
  if (c.id === 'keys') h.dataset.keyhint = '1'; else delete h.dataset.keyhint;
  h._t = c.id === 'flash' || c.id === 'hint' ? (c.timer ?? -1) : null;   // "a flash owns the bar": readers of _t keep working
  h.classList.remove('gone'); pillYield(true);
}

export function setHint(line, { sticky = false } = {}) { claimStatus('hint', { priority: 3, content: line, ttl: sticky ? null : 30000 }); }

// The ambient hint is what the bar shows when nothing louder is happening —
// a standing offer from the world ("X — sit"), set and cleared by proximity.
let ambientHint = null;
export function setAmbientHint(line) {
  if (lineKey(line) === lineKey(ambientHint)) return;
  ambientHint = line;
  if (ambientHint) claimStatus('ambient', { priority: 5, content: ambientHint }); else releaseStatus('ambient');
}
// Tab put every panel away (windows.js): say how to get them back, for a few seconds; when they come back, stop saying it
// …and the lantern's resting line goes away with them and comes back with them (commandbar.js setPillQuiet)
bus.on('esc-quiet', (did) => {
  setPillQuiet(did === 'closed');
  if (did === 'closed') flashHint(html`<span>${escapeHid() ? 'panels hidden' : 'hidden'} · <kbd>Tab</kbd> to bring back</span>`, 4000);   // one span: the bar is a flex row, which would eat the space
  else if (did === 'restored' && statusShown() === 'flash' && /hidden · Tab to bring back/.test(el.hint.textContent)) endFlash();
});
/** Borrow the bar for a moment. `line` is text unless built with html`` (markup.js). tone 'attn': something you asked for
 *  didn't happen, and why, every time you ask — it outranks everything and holds while pointed at. */
export function flashHint(line, ms = 2600, tone = null) {
  // the bar's order: attn 1 · keys 2 · flash 2.5 · warn/hint 3. A flash beats the authority's warning on the same
  // reply but never the engaged gesture's keys
  claimStatus('flash', { priority: tone === 'attn' ? 1 : 2.5, content: line, tone, ttl: ms, hold: tone === 'attn' });
}
function endFlash() { releaseStatus('flash'); }
el.hint.onpointerenter = () => { hovering = true; };
el.hint.onpointerleave = () => { hovering = false; };
// the engaged gesture's keys (keyhints.js engage/release): what the keys do RIGHT NOW, while the hand is on something
bus.on('keyhint', (h) => {
  if (h) claimStatus('keys', { priority: 2, content: html`<span>${h}</span>` }); else releaseStatus('keys');
});

// ============================================================ cursors
// The loupe cursor is inked with --fg, baked into --cur-loupe because CSS url() cursors can't read custom
// properties (index.html holds the rule and the native fallback); rebuilt when --fg changes.

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
// buildCursors is a no-op unless --fg actually changed, so our own
// --cur-loupe write can't feed the observer back into itself
new MutationObserver(buildCursors)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// ============================================================ slider fill
// WebKit custom tracks have no progress fill, so every .row range carries a --p custom property the track gradient
// reads (index.html). Painted on input, and swept every 200 ms because panels also set .value from code.

function paintRange(i) {
  const min = +i.min || 0, max = +i.max || 100;
  i.style.setProperty('--p', `${(((+i.value || 0) - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=range]')) paintRange(e.target);
}, true);
/** Repaint every slider fill under `root` NOW — call after setting .value from
 *  code (a reset, a sync), rather than waiting for the sweep below. */
export function paintRangesIn(root = document) {
  for (const i of root.querySelectorAll('input[type=range]')) paintRange(i);
}
setInterval(() => paintRangesIn(document), 200);   // module-scope timer: a node-side importer of ui.js needs an explicit process.exit

// ============================================================ tooltips
// Every hover hint is a native title= attribute, which browsers paint in OS chrome no token can reach. One delegated
// chip: on hover we borrow the title (removing the attribute suppresses the native one), show the house version, and
// hand it back on leave. New code keeps writing title= and inherits this.

const tip = document.createElement('div');
tip.id = 'tipchip';
document.body.appendChild(tip);
let tipTimer = null, tipHost = null;
// ancestors with their own title= while a DESCENDANT holds the tip: their titles are borrowed too, or the browser
// paints the ancestor's NATIVE tooltip beside ours
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
    // a WATERFALL row (the ∃ menu and its flyout) says it beside the menus, level with the row, so it never covers the
    // rows you are moving to. Past the rightmost open menu, so a flyout stays clear; the left side if the right has no room.
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

// World and Settings hold their sections as TABS:
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
    ensureDockEntry({ id: 'settings', icon: 'gear-six' });
  }
  return settingsFrameApi;
}

/** A section of the world (or settings) frame: a TAB in its strip and a pane under it. onOpen is
 *  awaited each time the tab is chosen, so rosters and catalogs re-fetch instead of going stale.
 *  The api is the accordion's: `box` (#sec-<id>, the pane, .open while chosen) holds `body`; `head`
 *  is the tab button (#sec-<id>-tab); toggle(true) chooses it, toggle(false) folds the pane away,
 *  toggle() flips. */
// Moderation and World Settings: tabbed frames like settings, each with its own dock entry. Moderation's entry
// exists only while you hold a moderation power (setDockEntry); World Settings is everyone's (owners edit).
let moderationFrameApi = null, worldSettingsFrameApi = null;
export function moderationFrame() {
  if (!moderationFrameApi) moderationFrameApi = tabbedFrame('moderation', { title: 'moderation', x: 70, y: 60, w: 360, h: 360, minW: 240, hidden: true });
  return moderationFrameApi;
}
export function worldSettingsFrame() {
  if (!worldSettingsFrameApi) worldSettingsFrameApi = tabbedFrame('world-settings', { title: 'world settings', x: 90, y: 80, w: Math.min(600, innerWidth - 24), h: 440, minW: 260, hidden: true });   // wide enough for the four built-in roles' columns
  return worldSettingsFrameApi;
}
const HOSTS = { settings: () => settingsFrame(), moderation: () => moderationFrame(), 'world-settings': () => worldSettingsFrame() };
export function makeSection(title, onOpen, { id = '', host: hostName = 'world' } = {}) {
  const hostFrame = (HOSTS[hostName] ?? panelFrame)();
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
export { escapeHtml };   // markup.js's: the one escaper (kudzu C1)

// ============================================================ overlays

export const sheet = (node) => node.querySelector('.sheet');
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

/** Every window back where it started, and the lantern's resting line too (it is not a frame, but it moves in
 *  HUD layout mode). The rail's own edge is NOT reset — where you put the rail is your decision (loadDockEdge). */
export function resetHudLayout() { resetLayout(); resetPillPlace(); }

// ---- help ------------------------------------------------------------------
// The overlay's content is a def (defs/ui/_help.json): title, subtitle, the key table, the prose sections, so a world
// can reword its welcome without forking the client. Defs are server-owned, so the fragments are trusted markup.
// "Your layout" stays code-side (a live button wired to resetLayout). No baked-in fallback prose.

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

// Tab: the people pane (the chat frame's side pane replaced the old roster)
export function togglePeopleHere() {
  const f = getFrame('chat'); const wasVisible = !!f?.visible; if (f && !wasVisible) f.show();
  // ask the frame for the nodes chat.js built rather than finding them by class: .chat-cols and .chat-side-tog are
  // public class contract (docs/guide/MODDING-UI.md §3), so a mod may mount markup carrying them in this body
  const cols = f?.sidePane?.('cols');
  const closed = cols?.classList.contains('side-closed');
  // Tab opens: only a closed pane needs the toggler (clicking an open one would close it)
  if (closed) f.sidePane('tog')?.click();
}
