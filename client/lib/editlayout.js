// editlayout — edit mode as a WORKSPACE (Blender's word): the same frames,
// a different arrangement. Nothing is replaced; frames are docked into
// columns while the mode is on and float again exactly where they were
// when it ends. The shape is the one every shipping editor converged on:
//
//   ∃ mic ear vr │ World Edit View Panels  undo  ▢ ⤢ ─────────── tool name
//   ───────┬─────────────────────────────────────────────────────────────
//   🔧     │ Build|Hierarchy  │  [armed tool strip]        │ Inspector
//   ↖✥↻⤢   │ ───split───      │       viewport             │
//   tools  │ Chat             │                            │
//
// The corner matches the HUD: the ∃ in the top-left, the mic / ear / goggles
// folded to its right exactly as mictoggle.placeMic lays them out beside the
// ∃ everywhere else (grey-on-grey here), then the menus. The rail below holds
// the wrench (the way out — amber, the one amber control on it) and the tools.
// Chat stays: every edit is a logged sentence, so the chat pane is the edit
// history with the people (and agents) in it. Every other window is one
// Panels ▾ click away, never gone.

import { bus } from './base.js';
import { getFrame, allFrames } from './windows.js';
import { setTool, getTool, undo, deselectAll, setEditMode, removeKeyTargets, SPACES, getSpace, setSpace } from './build.js';
import { THREE, scene } from './core.js';
import { svg as iconSvg } from './icons.js';
import { withKeys, KEYHINTS } from './keyhints.js';
import * as Edits from './editwrites.js';
import { structureTools, currentTool as structureTool } from './structure_ui.js';
import { TABS, openingTab, useTab } from './edittabs.js';
import { placeStatusChips } from './statuschips.js';
import { replica } from './net.js';
import { selection } from './editpanels.js';
import { flashHint } from './ui.js';
import { isolating, setIsolate } from './myview.js';

const LS = 'ew-edit-layout';
// the left column's top pane is one frame at a time, picked by tab (edittabs.js TABS): B opens
// on Build the first time, then on whichever tab this viewer used last (design §5)
const DEF = { leftW: 300, rightW: 320, leftSplit: 0.55, leftTab: 'build', rightTab: 'inspector' };
let L = { ...DEF };
try { const stored = JSON.parse(localStorage.getItem(LS) || 'null'); L = { ...DEF, ...(stored ?? {}), leftTab: openingTab(stored) }; } catch { /* defaults */ }
const save = () => { try { localStorage.setItem(LS, JSON.stringify(L)); } catch { /* fine */ } };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const TOOLS = [   // every letter off the walking set: WASD walks here (Maya's W and Blender's S both collide)
  { id: 'select', icon: 'mousePointer2', key: 'Q', title: 'select (Q) — click picks, a drag never moves' },
  { id: 'move', icon: 'move', key: 'G', title: 'move (G) — drag moves; Shift+drag raises · G again or right-click: world / object axes' },
  { id: 'rotate', icon: 'rotateCw', key: 'E', title: 'rotate (E) — drag turns about up · E again or right-click: world / object axes' },
  { id: 'scale', icon: 'scale3d', key: 'R', title: 'scale (R) — drag sizes; the handles stretch one axis' },
  { id: 'pivot', icon: 'locateFixed', key: 'P', title: 'pivot (P) — drag where it turns and scales from; it snaps to the model\'s centre, base, corners and faces. The thing never moves' },
];

const RTABS = [['inspector', 'Inspector'], ['history', 'History']];
let els = null;          // { top, tools, left, right, split, lsplit, rsplit, tabs, rtabs, strip }
let prevChat = null;     // chat's visibility before docking, restored on exit
let prevWorld = null;    // the World panel's, likewise
let on = false;

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

function build() {
  if (els) return els;
  const top = el('div', 'edit-strip edit-top');
  const tools = el('div', 'edit-strip edit-tools');
  const left = el('div', 'edit-col edit-left');
  const right = el('div', 'edit-col edit-right');
  const lsplit = el('div', 'edit-split edit-split-v');    // left column's right edge
  const rsplit = el('div', 'edit-split edit-split-v');    // right column's left edge
  const split = el('div', 'edit-split edit-split-h');     // between hierarchy and chat
  left.append(split);
  // Build | Hierarchy: two docked frames sharing the column's top pane, picked by tab (the
  // tab strip stands in for their title bars, so the pane reads as ONE panel with two pages)
  const tabs = el('div', 'edit-tabs');
  for (const [id, label] of TABS) {
    const b = el('button', 'edit-tab', label);
    b.dataset.tab = id;
    b.onclick = () => { L = useTab(L, id); save(); apply(); };
    tabs.append(b);
  }
  // Inspector | History: the right column's two pages (research 56: history lives BESIDE the Inspector, not in it)
  const rtabs = el('div', 'edit-tabs edit-rtabs');
  for (const [id, label] of RTABS) {
    const b = el('button', 'edit-tab', label);
    b.dataset.tab = id;
    b.onclick = () => { L = { ...L, rightTab: id }; save(); apply(); };
    rtabs.append(b);
  }
  bus.on('edit-righttab', (id) => { if (RTABS.some(([t]) => t === id)) { L = { ...L, rightTab: id }; save(); apply(); } });
  // the armed building tool, named across the top of the viewport (it disappears with the tool)
  const strip = el('div', 'edit-toolstrip');
  for (const e of [top, tools, left, right, lsplit, rsplit, strip]) { e.hidden = true; document.body.append(e); }
  bus.on('structure-tool', paintStrip);

  // ---- tools column
  for (const t of TOOLS) {
    const b = el('button', 'edit-tool');
    b.innerHTML = iconSvg(t.icon, 16);   // one glyph set (icons.js) — the rail's old ↖ ✥ ↻ ⤢ ⊙ were four fonts' worth of shapes
    if (t.key) b.append(el('kbd', 'edit-tool-key', t.key));   // the letter, so hands learn it
    b.dataset.tool = t.id; b.disabled = !!t.disabled;
    // the tool's hidden keys, in its tooltip (keyhints.js): the gizmo's Ctrl-snap, select's Ctrl/Shift-click, all the letters
    b.title = withKeys(withKeys(t.title, { select: 'selectExtend', move: 'gizmo', rotate: 'gizmo', scale: 'gizmo', pivot: 'gizmo' }[t.id]), 'toolKeys');
    // the select tool also says how the camera moves; the three transform tools say how to reset what they change
    b.title = withKeys(b.title, { select: 'editCamera', move: 'resetTransform', rotate: 'resetTransform', scale: 'resetTransform', pivot: 'resetTransform' }[t.id]);
    b.onclick = () => setTool(t.id);
    // right-click: the tool's spaces (Maya's marking menu, as a plain menu): one click picks, the tool comes with it
    if (SPACES[t.id]?.length > 1) b.oncontextmenu = (e) => {
      e.preventDefault(); closeMenus();
      const pop = el('div', 'edit-menu-pop edit-space-pop');
      for (const sp of SPACES[t.id]) {
        const row = el('button', 'edit-menu-item');
        row.append(el('span', '', `${getSpace(t.id) === sp ? '● ' : '○ '}${sp} axes`));
        row.onclick = () => { pop.remove(); setSpace(t.id, sp); setTool(t.id); };
        pop.append(row);
      }
      const r = b.getBoundingClientRect();
      Object.assign(pop.style, { position: 'fixed', left: `${r.right + 4}px`, top: `${r.top}px`, zIndex: 40 });
      document.body.append(pop);
    };
    tools.append(b);
  }
  bus.on('tool', paintTools);

  // ---- top strip: menus, undo, mode
  const menus = el('div', 'edit-menus');
  menus.append(
    menu('Edit', () => [
      { label: 'undo\tCtrl+Z', run: undo, title: KEYHINTS.undo.before },
      { label: 'redo\tCtrl+Shift+Z', run: () => Edits.redo(), title: KEYHINTS.undo.before },
      { label: 'deselect\tEsc', run: deselectAll },
      { label: 'delete\tDel', run: removeKeyTargets },
      { label: 'leave builder mode\tB', run: () => setEditMode(false) },
    ]),
    menu('View', () => [
      { label: 'reset workspace layout', run: () => { L = { ...DEF }; save(); apply(); } },
      { label: `${getFrame('chat')?.visible ? 'hide' : 'show'} chat`, run: () => { getFrame('chat')?.toggle(); apply(); } },
      { label: `${getFrame('console')?.visible ? 'hide' : 'show'} console (scripts)`, run: () => getFrame('console')?.toggle() },
    ]),
    // every HUD panel, the dock's fallback (R 10-04): the rail folds what doesn't fit under ⋯, this always has them all.
    // A floating frame renders under the columns, so one opened from here comes up over them.
    menu('HUD Panels', () => allFrames().filter((f) => !f.docked && !f.el.classList.contains('edit')).map((f) => ({
      label: `${f.visible ? '● ' : '○ '}${panelName(f.id)}`, run: () => { f.toggle(); if (f.visible) f.el.style.zIndex = '30'; },
    }))),
  );
  const undoBtn = el('button', 'edit-btn'); undoBtn.innerHTML = `${iconSvg('undo2', 14)}<span>undo</span>`; undoBtn.title = 'Ctrl+Z'; undoBtn.onclick = undo;
  // viewport buttons: what the render does, not what the world is
  const view = el('div', 'edit-viewbtns');
  // VIEWPORT menu (R, 10-10: "start a 'viewport options' menu ... isolate selected ... wireframe (probably also
  // 'wireframe on shaded' and 'flat shaded')"). What MY render shows; nothing in the world changes, all of it off on exit.
  const tick = (on) => (on ? '☑ ' : '☐ ');
  const vmenu = menu('Viewport', () => [
    { label: `${tick(isolating())}isolate selected`, title: 'show only what is selected (with what it rides and what rides it), in your view only', run: () => toggleIsolate() },
    { label: `${tick(shade === 'shaded')}shaded`, run: () => setShade('shaded') },
    { label: `${tick(shade === 'wire')}wireframe`, run: () => setShade('wire') },
    { label: `${tick(shade === 'flat')}flat shaded`, title: 'every face lit flat, in one grey: the forms without their textures', run: () => setShade('flat') },
  ]);
  vmenu.dataset.menu = 'viewport';
  const wire = el('button', 'edit-vbtn'); wire.innerHTML = iconSvg('box', 16); wire.title = 'wireframe'; wire.dataset.view = 'wire';
  wire.onclick = () => { setShade(shade === 'wire' ? 'shaded' : 'wire'); };
  shadeBtn = wire;
  const full = el('button', 'edit-vbtn'); full.innerHTML = iconSvg('maximize', 16); full.title = 'full screen (F11 also works)'; full.dataset.view = 'full';
  full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.(); };
  document.addEventListener('fullscreenchange', () => full.classList.toggle('on', !!document.fullscreenElement));
  view.append(vmenu, wire, full);
  const mode = el('span', 'edit-mode-label');
  // the corner: ∃ + mic / ear / goggles. They are fixed elements their own modules place (ui.js's
  // dock, mictoggle.placeMic — which folds them to the ∃'s right, the HUD's own layout); this
  // spacer keeps the bar's menus clear of them, sized to where they actually landed (fitSeat)
  const seat = el('span', 'edit-seat');
  top.append(seat, menus, undoBtn, view, mode);
  bus.on('tool', () => { mode.textContent = getTool(); });
  mode.textContent = getTool();

  // ---- splitters
  dragSplit(lsplit, (dx) => { L.leftW = clamp(L.leftW + dx, 200, innerWidth * 0.45); });
  dragSplit(rsplit, (dx) => { L.rightW = clamp(L.rightW - dx, 220, innerWidth * 0.45); });
  dragSplit(split, (_dx, dy) => { L.leftSplit = clamp(L.leftSplit + dy / left.clientHeight, 0.15, 0.85); });
  addEventListener('resize', () => { if (on) apply(); });

  els = { top, tools, left, right, split, lsplit, rsplit, tabs, rtabs, strip };
  paintTools();
  return els;
}

/** The corner spacer: as wide as the ∃ and whichever voice / VR glyphs are pinned, wherever
 *  placeMic put them. Re-measured on every layout pass and on a slow tick (a glyph pinned or a
 *  headset found later moves them; neither module tells us). */
function fitSeat() {
  if (!els || !on) return;
  const seat = els.top.firstElementChild;
  const bar = els.top.getBoundingClientRect();
  let right = bar.left;
  for (const sel of ['#hud', '#micbtn', '#earbtn', '#xrbtn']) {
    const e = document.querySelector(sel);
    if (!e || getComputedStyle(e).display === 'none') continue;
    const r = e.getBoundingClientRect();
    if (r.width && r.bottom <= bar.bottom + 1 && r.top >= bar.top - 1) right = Math.max(right, r.right);
  }
  const padL = parseFloat(getComputedStyle(els.top).paddingLeft) || 0;
  const w = `${Math.max(0, Math.round(right - bar.left - padL + 6))}px`;
  if (seat.style.width !== w) seat.style.width = w;
}

/** The viewport strip: which building tool is armed, its hint (structure_ui's TOOLS), and the way out. */
function paintStrip() {
  if (!els) return;
  const t = structureTool();
  const info = t ? structureTools().find((x) => x.k === t) : null;
  els.strip.hidden = !(on && info);
  if (!info) return;
  els.strip.innerHTML = '';
  const name = el('span', 'edit-toolstrip-name');
  name.innerHTML = iconSvg(info.icon, 14);
  name.append(el('span', '', info.label));
  els.strip.append(name, el('span', 'edit-toolstrip-hint', info.hint), el('span', 'edit-toolstrip-esc'));
  els.strip.lastChild.append(el('kbd', '', 'Esc'), document.createTextNode(' to drop'));
}

// shading = one override material on the scene; the renderer draws every mesh with it and nothing in the world is
// touched. 'shaded' is the world as it is.
let shade = 'shaded', shadeBtn = null;
const shadeMats = {};
function setShade(v) {
  const was = shadeMats[shade];
  shade = ['wire', 'flat'].includes(v) ? v : 'shaded';
  if (shade === 'wire') shadeMats.wire ??= new THREE.MeshBasicNodeMaterial({ color: 0xbfc4cc, wireframe: true, toneMapped: false });
  if (shade === 'flat') shadeMats.flat ??= new THREE.MeshStandardNodeMaterial({ color: 0xb9bdc4, roughness: 0.85, metalness: 0, flatShading: true });
  if (shade !== 'shaded') scene.overrideMaterial = shadeMats[shade];
  else if (!scene.overrideMaterial || scene.overrideMaterial === was) scene.overrideMaterial = null;
  shadeBtn?.classList.toggle('on', shade === 'wire');
}
function toggleIsolate() {
  const all = Object.keys(replica.st?.entities ?? {}), parentOf = (id) => replica.st?.entities?.[id]?.c?.parent?.to ?? null;
  if (isolating()) { setIsolate(null, parentOf, all); flashHint('isolate off: everything is shown again', 2000); return; }
  const ids = selection();
  if (!ids.length) { flashHint('select something first, then Viewport ▸ isolate selected', 3000); return; }
  const n = setIsolate(ids, parentOf, all);
  flashHint(`isolated: ${n} thing${n === 1 ? '' : 's'} shown, in your view only — Viewport ▸ isolate selected again shows the rest`, 4000);
}

const PANEL_NAMES = { world: 'World (catalog · ground · sky)', profile: 'Profile', emotes: 'Emotes', debug: 'Debug', settings: 'Settings', console: 'Console (scripts)', chat: 'Chat' };
const panelName = (id) => PANEL_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

function menu(label, items) {
  const wrap = el('span', 'edit-menu');
  const b = el('button', 'edit-btn', `${label} ▾`);
  const pop = el('div', 'edit-menu-pop'); pop.hidden = true;
  b.onclick = (e) => {
    e.stopPropagation();
    const open = pop.hidden;
    closeMenus();
    if (!open) return;
    pop.innerHTML = '';
    for (const it of items()) {
      const row = el('button', 'edit-menu-item');
      const [txt, key] = it.label.split('\t');
      row.append(el('span', '', txt)); if (key) row.append(el('kbd', '', key));
      if (it.title) row.title = it.title;
      row.onclick = () => { closeMenus(); it.run(); };
      pop.append(row);
    }
    pop.hidden = false;
  };
  wrap.append(b, pop);
  return wrap;
}
function closeMenus() { for (const p of document.querySelectorAll('.edit-menu-pop')) p.hidden = true; for (const p of document.querySelectorAll('.edit-space-pop')) p.remove(); }
addEventListener('pointerdown', (e) => { if (!(e.target instanceof Element && e.target.closest('.edit-menu, .edit-space-pop'))) closeMenus(); }, true);
// Esc with a menu open closes the menu and goes no further: it used to also reach build.js's Esc ladder, which left
// builder mode (open Edit ▾, change your mind, Esc: out of the editor)
const menuOpen = () => [...document.querySelectorAll('.edit-menu-pop')].some((p) => !p.hidden) || !!document.querySelector('.edit-space-pop');
addEventListener('keydown', (e) => { if (e.key !== 'Escape' || !menuOpen()) return; closeMenus(); e.preventDefault(); e.stopImmediatePropagation(); }, true);

function dragSplit(handle, onDelta) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    let lx = e.clientX, ly = e.clientY;
    try { handle.setPointerCapture(e.pointerId); } catch { /* fine */ }
    const move = (ev) => { onDelta(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; apply(); };
    const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); save(); };
    handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up);
  });
}

function paintTools() {
  if (!els) return;
  for (const b of els.tools.querySelectorAll('.edit-tool')) b.classList.toggle('on', b.dataset.tool === getTool());
}

/** The dock in builder mode (R, 10-10: "a collapsible dock in Edit mode with a special '...' icon that you could click
 *  to expand into the full dock, and click again to shrink to just E and the wrench"). Folded (the default): the ∃,
 *  the ⋯ and the wrench. Open: every pinned panel button; if the column would still push the tools off the screen
 *  (a 1366×768 laptop leaves ~650 px) the trailing ones stay hidden, and HUD Panels ▾ in the bar has them all.
 *  Returns the dock's bottom edge. */
const TOOLS_H = () => TOOLS.length * 36 + 16;
let dockOpen = false;
try { dockOpen = localStorage.getItem('ew.edit.dock') === 'open'; } catch { /* no storage: folded */ }
function fitDock(TOP) {
  const dock = document.getElementById('dock'); if (!dock) return TOP;
  const wrench = dock.querySelector('button[data-toggles="edit"]');
  let more = dock.querySelector('.dock-more');
  if (!more) {
    more = document.createElement('button'); more.className = 'dock-more'; more.textContent = '⋯';
    more.onclick = (e) => { e.stopPropagation(); dockOpen = !dockOpen; try { localStorage.setItem('ew.edit.dock', dockOpen ? 'open' : 'folded'); } catch { /* no storage */ } apply(); };
    dock.insertBefore(more, wrench ?? dock.querySelector('.dock-grip'));
  }
  for (const b of dock.querySelectorAll('.edit-overflow')) b.classList.remove('edit-overflow');
  const panelBtns = [...dock.querySelectorAll('button[data-toggles]')].filter((b) => !b.hidden && b !== wrench);
  more.hidden = !panelBtns.length;
  more.classList.toggle('on', dockOpen);
  more.setAttribute('aria-expanded', String(dockOpen));
  const bottom = () => dock.getBoundingClientRect().bottom;
  if (!dockOpen) { for (const b of panelBtns) b.classList.add('edit-overflow'); more.title = `show the ${panelBtns.length} panel buttons`; return bottom(); }
  const limit = innerHeight - TOOLS_H();
  for (let i = panelBtns.length - 1; i >= 0 && bottom() > limit; i--) panelBtns[i].classList.add('edit-overflow');
  const folded = dock.querySelectorAll('.edit-overflow').length;
  more.title = folded ? `fold the panel buttons away (${folded} didn't fit: HUD Panels ▾ in the bar has them)` : 'fold the panel buttons away';
  return bottom();
}
function unfitDock() {
  const dock = document.getElementById('dock');
  dock?.querySelector('.dock-more')?.remove();
  for (const b of document.querySelectorAll('#dock .edit-overflow')) b.classList.remove('edit-overflow');
}

/** Lay the columns out from L; called on enter, on every splitter move, on resize. */
function apply() {
  if (!els || !on) return;
  const { top, tools, left, right, split, lsplit, rsplit, tabs, rtabs, strip } = els;
  const rtab = RTABS.some(([id]) => id === L.rightTab) && getFrame(L.rightTab) ? L.rightTab : 'inspector';
  right.dataset.tab = rtab;
  for (const b of rtabs.children) b.classList.toggle('on', b.dataset.tab === rtab);
  for (const [id] of RTABS) { const f = getFrame(id); if (f) f.el.style.flex = id === rtab ? '1 1 0' : ''; }
  const TOP = 40, RAIL = 48;
  // the bar runs the full width: the ∃ sits in its left end (the corner) with the mic / ear /
  // goggles beside it, as on the HUD (R, 09-30). The rail starts under it: the wrench, then the
  // tools — no gaps between bar, rail and columns (R, 09-13).
  top.style.cssText = `left:0; right:0; top:0; height:${TOP}px`;
  // the tools start under the dock, which now carries every panel button: fold what doesn't fit first, then measure
  const dockBottom = fitDock(TOP);
  tools.style.cssText = `left:0; top:${TOP}px; bottom:0; width:${RAIL}px; padding-top:${Math.max(46, Math.round(dockBottom - TOP + 8))}px`;
  strip.style.cssText = `left:${RAIL + Math.round(L.leftW)}px; right:${Math.round(L.rightW)}px; top:${TOP}px`;
  const leftW = Math.round(L.leftW), rightW = Math.round(L.rightW);
  left.style.cssText = `left:${RAIL}px; top:${TOP}px; bottom:0; width:${leftW}px`;
  right.style.cssText = `right:0; top:${TOP}px; bottom:0; width:${rightW}px`;
  lsplit.style.cssText = `left:${RAIL + leftW - 3}px; top:${TOP}px; bottom:0`;
  rsplit.style.cssText = `right:${rightW - 3}px; top:${TOP}px; bottom:0`;
  // fixed chrome that predates the columns (structure bar, toasts, hint bar)
  // reads the viewport's edges from these instead of the window's
  document.body.style.setProperty('--edit-left-edge', `${RAIL + leftW}px`);
  document.body.style.setProperty('--edit-right-w', `${rightW}px`);
  const chat = getFrame('chat');
  const chatOn = !!chat?.visible;
  // the top pane (tabs + the picked frame) takes leftSplit of the column when chat shows, all of it otherwise
  const tab = TABS.some(([id]) => id === L.leftTab) && getFrame(L.leftTab) ? L.leftTab : 'build';
  left.dataset.tab = tab;
  for (const b of tabs.children) b.classList.toggle('on', b.dataset.tab === tab);
  const hh = (chatOn ? Math.round(left.clientHeight * L.leftSplit) : left.clientHeight) - tabs.offsetHeight;
  for (const [id] of TABS) { const f = getFrame(id); if (f) f.el.style.flex = id === tab ? `0 0 ${Math.max(0, hh)}px` : ''; }
  split.hidden = !chatOn;
  if (chat) chat.el.style.flex = '1 1 0';
  fitSeat();
  paintStrip();
}

let seatTimer = 0;
function enter() {
  const { top, tools, left, right, lsplit, rsplit, tabs, rtabs } = build();
  on = true;
  for (const e of [top, tools, left, right, lsplit, rsplit]) e.hidden = false;
  document.body.classList.add('edit-workspace');
  dispatchEvent(new CustomEvent('dockmoved'));   // the ∃ just moved into the corner: re-seat its glyphs now (mictoggle.placeMic listens)
  const bd = getFrame('build'), h = getFrame('hierarchy'), i = getFrame('inspector'), c = getFrame('chat');
  bd?.dock(left); h?.dock(left);
  left.prepend(tabs, ...[bd?.el, h?.el].filter(Boolean));   // tabs, then both pages, above the splitter
  const hs = getFrame('history');
  i?.dock(right); hs?.dock(right);
  right.prepend(rtabs, ...[i?.el, hs?.el].filter(Boolean));   // tabs, then both pages
  if (c) { prevChat = c.visible; c.dock(left); if (!c.visible) c.show(); }
  // floating frames render UNDER the columns; the World panel build.js opens
  // on entry sits at the right edge, exactly where the Inspector now is.
  // Park it; World ▾ brings it back, and exit restores it.
  const w = getFrame('world');
  prevWorld = !!w?.visible;
  if (w?.visible) w.hide();
  apply();
  // the glyphs re-seat on the next frame (mictoggle hears edit-mode too); measure once they have
  requestAnimationFrame(() => requestAnimationFrame(() => { fitSeat(); placeStatusChips(); }));   // the chips continue past the menus (B1)
  clearInterval(seatTimer); seatTimer = setInterval(() => { fitSeat(); apply(); }, 1000);
}
function exit() {
  if (!els || !on) return;
  on = false;
  clearInterval(seatTimer); seatTimer = 0;
  const { top, tools, left, right, lsplit, rsplit, strip } = els;
  for (const e of [top, tools, left, right, lsplit, rsplit, strip]) e.hidden = true;
  document.body.classList.remove('edit-workspace');
  unfitDock();
  dispatchEvent(new CustomEvent('dockmoved'));   // …and back beside the HUD's ∃
  setShade('shaded');
  if (isolating()) setIsolate(null, (id) => replica.st?.entities?.[id]?.c?.parent?.to ?? null, Object.keys(replica.st?.entities ?? {}));   // the view is whole again outside edit mode
  const c = getFrame('chat');
  for (const f of [getFrame('build'), getFrame('hierarchy'), getFrame('inspector'), getFrame('history'), c]) { if (f) { f.el.style.flex = ''; f.undock(); } }
  if (c && prevChat != null) c[prevChat ? 'show' : 'hide']();   // exactly as it was before the workspace
  if (prevWorld) getFrame('world')?.show();
  prevChat = prevWorld = null;
  closeMenus();
  placeStatusChips();   // back beside the HUD's ∃
}

export function initEditLayout() {
  bus.on('edit-mode', (v) => (v ? enter() : exit()));
  // tool hotkeys live in build.js's key router (Blender's G/R/S/Q/F/X)
  return { apply, isOn: () => on };
}

/** harness window */
export const editLayoutDebug = () => ({ on, layout: { ...L }, tool: getTool(), tab: els?.left.dataset.tab ?? null,
  docked: allFrames().filter((f) => f.docked).map((f) => f.id) });
