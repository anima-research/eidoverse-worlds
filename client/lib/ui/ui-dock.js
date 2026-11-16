// ui-dock — the rail: its entries and pins, its edge, its buttons, and registerPanel, the mod seam
// (eido.ui.registerPanel). The ∃ menu reads it; it never imports the menu (bindMenu) or ui.js.
import { bus, report } from '../base.js';
import { makeFrame, getFrame } from './windows.js';
import { fsvg, hasFill, rsvg, hasLine } from './icons.js';
import { paint } from './markup.js';
import { register as registerAction, get as getAction } from './actions.js';
import { openLantern, closeLantern, isLanternOpen, CHORD } from './commandbar.js';
const $ = (id) => document.getElementById(id);
const el = { hud: $('hud'), dock: $('dock') };

// ============================================================ dock
// A closed frame has to be findable again: an icon rides the rail while its window is open or pinned, otherwise it
// hides. Pinning and the layout lock live in the ∃ menu; the rail carries only windows.
// section-head emoji → Phosphor fill glyph (menu chrome never rides emoji: platform glyph gaps are silent).
// The entry id wins over the emoji: the same emoji means different things in different places ('🧱' is
// build's hammer in catalog.js, but the world panel is not a build panel), so no global emoji remap.
const ID_ICON = { world: 'planet' };
export const EMOJI_ICON = {
  '💬': 'chat-circle',
  '👋': 'hand-waving',
  '🐞': 'bug',
  '🧱': 'hammer', '🧍': 'person-arms-spread', '🌿': 'plant', '☀': 'sun', '🔒': 'lock',
  '✨': 'sparkle', '🌳': 'tree', '📜': 'scroll', '🧩': 'puzzle-piece', '🔊': 'speaker-high', '🎨': 'palette', '🖥': 'monitor', '🥽': 'virtual-reality', '🛡': 'shield',
};
const PINS_LS = 'ew-dock-pins';
// last seen gate state per action entry — the auto-pin fires on the EDGE, not
// the level, so a manual unpin is not undone by the next repaint
const gateWas = new Map();
export let pins = new Set();
// every panel starts pinned to the dock; unpinning is the personal choice, not pinning
const DEFAULT_PINS = ['search', 'profile', 'world', 'chat', 'actions', 'debug', 'settings', 'edit'];   // 'edit' too — its ownership gate still decides visibility
// The action bar's id changed once; it keys saved dock pins and frame state (windows.js `ew-frame-<id>`). Carried
// once, before anything reads either key; a state saved under 'actions' wins. The old id is spelled on this one line
// only (names-check E3 allows it).
export const ACTIONBAR_OLD_ID = 'emotes';
export function carryRenamedPanel(from, to, ls = localStorage) {
  try {
    const oldFrame = ls.getItem(`ew-frame-${from}`);
    if (oldFrame != null) { if (ls.getItem(`ew-frame-${to}`) == null) ls.setItem(`ew-frame-${to}`, oldFrame); ls.removeItem(`ew-frame-${from}`); }
    const saved = JSON.parse(ls.getItem(PINS_LS) ?? 'null');
    if (Array.isArray(saved) && saved.includes(from)) ls.setItem(PINS_LS, JSON.stringify([...new Set(saved.map((p) => (p === from ? to : p)))]));
  } catch { /* storage off: nothing saved to carry */ }
}
carryRenamedPanel(ACTIONBAR_OLD_ID, 'actions');
try { pins = new Set(JSON.parse(localStorage.getItem(PINS_LS) ?? JSON.stringify(DEFAULT_PINS))) } catch { pins = new Set(DEFAULT_PINS); }
// the search entry arrived after people had saved their pins: pin it ONCE for them, then their unpin is theirs
try { if (!localStorage.getItem('ew-dock-search-seen')) { localStorage.setItem('ew-dock-search-seen', '1'); pins.add('search'); } } catch {}
export const savePins = () => { try { localStorage.setItem(PINS_LS, JSON.stringify([...pins])) } catch {} };
export let dockEntries = [];

const DOCKPOS_LS = 'ew-dock-pos';
// ---- mod seam: the HUD is a registry, core panels are its built-in entries. A mod calls eido.ui.registerPanel()
// and gets everything the built-ins get (a frame, a menu row, a rail icon, arrange/lock/reset). docs/guide/MODDING-UI.md
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

/** The profile button wears a presence dot in its bottom-right corner. */
bus.on('presence:me', (v) => paintPresence(v));
export function paintPresence(state) {
  const b = el.dock.querySelector('button[data-toggles="profile"]');
  if (!b) return;
  b.dataset.presence = state;
  b.title = `Profile · ${state}`;
}

// one resolver for the rail AND the VR ring, so frames whose glyph comes from the id/emoji fallbacks get it in VR too
export const iconOf = (e) => e.icon ?? ID_ICON[e.id] ?? EMOJI_ICON[(e.label ?? '').replace(/\uFE0F/g, '')];
/** The rail as DATA, for the VR ring (the radial is the dock rendered radially, same pins). Open ∪ pinned, in dock
 *  order; action entries (the wrench) are not frames and stay out. */
export function dockPins() {
  return dockEntries
    .filter((e) => !e.action && (pins.has(e.id) || !!getFrame(e.id)?.visible))
    .map((e) => ({ id: e.id, icon: iconOf(e), open: !!getFrame(e.id)?.visible }));
}

// how a rail entry reads as a lantern row (the rail itself shows only a glyph)
const PANEL_TITLE = { actions: 'action bar', edit: 'builder mode', debug: 'debug panel' };
const PANEL_WORDS = { world: ['catalog', 'build'], profile: ['avatar', 'presence', 'friends', 'satchel'],
  chat: ['messages', 'log', 'people'], edit: ['build', 'builder', 'edit', 'place'], settings: ['preferences', 'options'] };
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
  if (id === SEARCH_ENTRY.id) b.dataset.lanternToggle = '';   // its click closes an open lantern; the line's blur must not (commandbar.js)
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
  // dynamic, not static: profile/videopanel reach controller.js through xrpanels/mybody, and controller.js imports
  // ui.js, which imports this file: a static edge here closes a loop that reads controller's `pointerClaimed` before
  // initialization.
  // The dock entry is pushed now; the frames land a tick later and the dock repaints so the button shows.
  Promise.all([import('./profile.js'), import('./stylepanel.js'), import('./videopanel.js'), import('./capnotice.js'), import('../edit/dropdown.js')])
    .then(([p, st, v, c, d]) => { p.initProfile(); st.initStylePanel(); v.initVideoPanel(); c.initCapNotice(); d.initDropdowns(); paintDock(); })
    .catch((e) => report('ui panels', e));
  return [{ id: 'profile', icon: 'user-circle' }];
}
// Search & commands: the lantern prompt (Ctrl/Cmd+K), placed between gestures and debug by initDock. An action entry
// (not a frame): it lights while the prompt is open. It registers no lantern row — a row that opens the prompt you are
// typing in would be noise.
export const SEARCH_ENTRY = { id: 'search', icon: 'magnifying-glass', label: 'Search & commands', noAction: true,
  action: () => (isLanternOpen() ? closeLantern() : openLantern()), active: () => isLanternOpen() };
bus.on('lantern', () => paintDock());
// "Chat · Enter": the key is read from actions.js at paint time, so a key table merged in later shows up
const DOCK_NAME = { search: 'Search & commands', edit: 'Builder mode', moderation: 'Moderation', 'world-settings': 'World settings' };
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
  // search goes in before debug, else after gestures, else ahead of the `last` entries (the sort below keeps those last)
  if (!seen.has(SEARCH_ENTRY.id)) {
    const at = dockEntries.findIndex((e) => e.id === 'debug'), after = dockEntries.findIndex((e) => e.id === 'actions');
    dockEntries.splice(at >= 0 ? at : after >= 0 ? after + 1 : dockEntries.length, 0, SEARCH_ENTRY);
  }
  // `last: true` entries (the edit wrench) ALWAYS close the list: edit is a
  // MODE, not a window, and reads as one only when it sits apart at the end.
  // Mods registering later insert ahead of them (addDockButton).
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
      bus.emit('dock-moved');
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
  bus.on('build-mode', () => paintDock());   // the wrench's title follows the mode at once, not on the 2 s poll
  // auto-pin on the grant, only on the closed→open edge, so a manual unpin still wins; the first report is the
  // starting level, not an edge (test/client/dock-test.ts)
  bus.on('your-rights', () => {
    for (const e of dockEntries) {
      if (!e.action || !e.gate) continue;
      const now = !!e.gate(), was = gateWas.get(e.id);
      gateWas.set(e.id, now);
      if (was === undefined) continue;                 // the arrival: a level
      // pin on the grant, unpin on the revoke: pins are one global key (ew-dock-pins), so a leftover would show a
      // dead wrench in every world
      if (was === now) continue;                       // level, not edge
      // save on the edge even when the set looks unchanged: `pins` hydrates from DEFAULT_PINS (which has 'edit')
      // when the key is absent, so a first grant's pin is not yet durable
      if (now) pins.add(e.id); else pins.delete(e.id);
      savePins();
    }
    paintDock();
  });
  setInterval(paintDock, 2000);   // role grants land async; the wrench follows (a timer that never ends, as ui.js's slider sweep)
  menuHooks.init();

}

/** Give a frame born after boot its rail button, once; an entry already listed wins (settingsFrame's own). */
export function ensureDockEntry(entry) {
  if (!dockEntries.some((e) => e.id === entry.id)) { dockEntries.push(entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
}
// the ∃ menu builds and repaints through these hooks, which it fills itself (bindMenu), so the dock never calls into it
let menuHooks = { init() {}, paint() {} };
export function bindMenu(hooks) { menuHooks = hooks; }
/** Add (on) or remove (off) a dock entry after boot: the Moderation entry follows your switches (your-rights). */
export function setDockEntry(entry, on) {
  const has = dockEntries.some((e) => e.id === entry.id);
  // pinOnce: pinned the first time this person sees the entry (as the search entry was), then their unpin is theirs
  if (on && entry.pinOnce) { try { const k = `ew-dock-${entry.id}-seen`; if (!localStorage.getItem(k)) { localStorage.setItem(k, '1'); pins.add(entry.id); savePins(); } } catch {} }
  if (on && !has) { const at = dockEntries.findIndex((e) => e.last); dockEntries.splice(at < 0 ? dockEntries.length : at, 0, entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
  else if (!on && has) { dockEntries = dockEntries.filter((e) => e.id !== entry.id); el?.dock?.querySelector(`button[data-toggles="${entry.id}"]`)?.remove(); getFrame(entry.id)?.hide?.(); paintDock(); }
}

// ---- the rail lives flat on an edge. {edge, along} persisted;
// left/right = vertical (∃ on top), top/bottom = horizontal (∃ leftmost).

// The touch controls own the bottom corners (#stick bottom-left, #touchbtns bottom-right). A left rail taller than
// the column above the stick moves to the top edge instead. Derived from what the rail carries, not a breakpoint.
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
  // a deliberate drag always wins: ew-dock-pos is not cleared by the layout purge
  try { const p = JSON.parse(localStorage.getItem(DOCKPOS_LS) || 'null'); if (p?.edge) return p; } catch {}
  return dockEdgeFitsLeft() ? { edge: 'left', along: 10 } : { edge: 'top', along: 10 };
}
function applyDockEdge({ edge, along }) {
  el.dock.dataset.edge = edge;   // CSS welds the rail to this side; mic/ear read it too
  const d = el.dock;
  const horiz = edge === 'top' || edge === 'bottom';
  d.classList.toggle('horizontal', horiz);
  // 'auto', not '': on '' the stylesheet's top/left return and stretch the rail
  d.style.left = d.style.right = d.style.top = d.style.bottom = 'auto';
  const r = d.getBoundingClientRect();
  const max = horiz ? innerWidth - r.width - 4 : innerHeight - r.height - 4;
  // whole pixels: a fractional offset on a blur layer rasterizes every glyph soft
  const a = Math.round(Math.max(4, Math.min(max, along)));
  if (edge === 'left') { d.style.left = '0'; d.style.top = `${a}px`; }
  if (edge === 'right') { d.style.right = '0'; d.style.top = `${a}px`; }
  if (edge === 'top') { d.style.top = '0'; d.style.left = `${a}px`; }
  if (edge === 'bottom') { d.style.bottom = '0'; d.style.left = `${a}px`; }
  // no resize dispatch here: the window-resize listener calls this function, so it would recurse. mic/ear re-anchor
  // via mictoggle's own observer.
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
// would re-arm the native one (ui.js's tooltip MutationObserver routes a real change into the borrow)
function setTitle(b, t) { if ((b._tip ?? b.getAttribute('title')) !== t) b.setAttribute('title', t); }
export function paintDock() {
  // the rail never hides — it carries the ∃, which is always visible
  for (const b of el.dock.querySelectorAll('button[data-toggles]')) {
    const id = b.dataset.toggles;
    const entry = dockEntries.find((x) => x.id === id);
    if (entry?.action) {                          // action buttons (edit wrench)
      // GREY, NOT GONE: hiding a gated action teaches nobody the affordance exists.
      const open = entry.gate ? !!entry.gate() : true;
      b.classList.toggle('dead', !open);
      b.disabled = !open;
      // an entry may title itself by state (the wrench: "leave build mode (B)" while it is the way out);
      // otherwise the dock's own name · key. setTitle: write only on change (the tooltip chip borrows it)
      setTitle(b, open ? (entry.title?.(!!entry.active?.()) ?? dockTitle(entry))
        : dockTitle(entry, entry.deadWhy?.() ?? ' — needs build rights in this world'));
      b.hidden = !entry.active?.() && !pins.has(id);
      // never `on` AND `dead`: .on's brand ink and edge-bar come later in the
      // sheet at equal specificity, so the pair would render as "active but broken"
      b.classList.toggle('on', open && !!entry.active?.());
      continue;
    }
    const open = !!getFrame(id)?.visible;
    if (entry && id !== 'profile') setTitle(b, dockTitle(entry));   // profile's carries its presence (paintPresence)
    b.classList.toggle('on', open);
    b.hidden = !open && !pins.has(id) && !entry?.always;
  }
  menuHooks.paint();
}
