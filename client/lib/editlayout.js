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
import { getFrame, allFrames } from './frames.js';
import { setTool, getTool, undo, deselectAll, setEditMode, removeKeyTargets } from './build.js';
import { panelFrame } from './ui.js';
import { THREE, scene } from './core.js';
import { svg as iconSvg } from './icons.js';
import { structureTools, currentTool as structureTool } from './structure_ui.js';
import { TABS, openingTab, useTab } from './edittabs.js';

const LS = 'ew-edit-layout';
// the left column's top pane is one frame at a time, picked by tab (edittabs.js TABS): B opens
// on Build the first time, then on whichever tab this viewer used last (design §5)
const DEF = { leftW: 300, rightW: 320, leftSplit: 0.55, leftTab: 'build' };
let L = { ...DEF };
try { const stored = JSON.parse(localStorage.getItem(LS) || 'null'); L = { ...DEF, ...(stored ?? {}), leftTab: openingTab(stored) }; } catch { /* defaults */ }
const save = () => { try { localStorage.setItem(LS, JSON.stringify(L)); } catch { /* fine */ } };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const TOOLS = [   // every letter off the walking set: WASD walks here (Maya's W and Blender's S both collide)
  { id: 'select', icon: 'mousePointer2', key: 'Q', title: 'select (Q) — click picks, a drag never moves' },
  { id: 'move', icon: 'move', key: 'G', title: 'move (G) — drag moves; Shift+drag raises' },
  { id: 'rotate', icon: 'rotateCw', key: 'E', title: 'rotate (E) — drag turns about up' },
  { id: 'scale', icon: 'scale3d', key: 'R', title: 'scale (R) — drag sizes, uniform' },
  { id: 'pivot', icon: 'locateFixed', key: '', title: 'pivot — later, with rot/scale[] in the protocol', disabled: true },
];

let els = null;          // { top, tools, left, right, split, lsplit, rsplit, tabs, strip }
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
  // the armed building tool, named across the top of the viewport (it disappears with the tool)
  const strip = el('div', 'edit-toolstrip');
  for (const e of [top, tools, left, right, lsplit, rsplit, strip]) { e.hidden = true; document.body.append(e); }
  bus.on('structure-tool', paintStrip);

  // ---- tools column
  for (const t of TOOLS) {
    const b = el('button', 'edit-tool');
    b.innerHTML = iconSvg(t.icon, 16);   // one glyph set (icons.js) — the rail's old ↖ ✥ ↻ ⤢ ⊙ were four fonts' worth of shapes
    if (t.key) b.append(el('kbd', 'edit-tool-key', t.key));   // the letter, so hands learn it
    b.dataset.tool = t.id; b.title = t.title; b.disabled = !!t.disabled;
    b.onclick = () => setTool(t.id);
    tools.append(b);
  }
  bus.on('tool', paintTools);

  // ---- top strip: menus, undo, mode
  const menus = el('div', 'edit-menus');
  menus.append(
    menu('World', () => [
      { label: 'world panel (ground · sky · build)…', run: () => { const w = panelFrame(); w.show(); w.el.style.zIndex = '30'; } },
    ]),
    menu('Edit', () => [
      { label: 'undo\tCtrl+Z', run: undo },
      { label: 'deselect\tEsc', run: deselectAll },
      { label: 'delete\tDel', run: removeKeyTargets },
      { label: 'leave edit mode', run: () => setEditMode(false) },
    ]),
    menu('View', () => [
      { label: 'reset workspace layout', run: () => { L = { ...DEF }; save(); apply(); } },
      { label: `${getFrame('chat')?.visible ? 'hide' : 'show'} chat`, run: () => { getFrame('chat')?.toggle(); apply(); } },
      { label: `${getFrame('console')?.visible ? 'hide' : 'show'} console (scripts)`, run: () => getFrame('console')?.toggle() },
    ]),
    menu('Panels', () => allFrames().filter((f) => !f.docked).map((f) => ({
      label: `${f.visible ? '● ' : '○ '}${f.id}`, run: () => f.toggle(),
    }))),
  );
  const undoBtn = el('button', 'edit-btn'); undoBtn.innerHTML = `${iconSvg('undo2', 14)}<span>undo</span>`; undoBtn.title = 'Ctrl+Z'; undoBtn.onclick = undo;
  // viewport buttons: what the render does, not what the world is
  const view = el('div', 'edit-viewbtns');
  const wire = el('button', 'edit-vbtn'); wire.innerHTML = iconSvg('box', 16); wire.title = 'wireframe'; wire.dataset.view = 'wire';
  wire.onclick = () => { setWireframe(!wireOn); wire.classList.toggle('on', wireOn); };
  const full = el('button', 'edit-vbtn'); full.innerHTML = iconSvg('maximize', 16); full.title = 'full screen (F11 also works)'; full.dataset.view = 'full';
  full.onclick = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.(); };
  document.addEventListener('fullscreenchange', () => full.classList.toggle('on', !!document.fullscreenElement));
  view.append(wire, full);
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

  els = { top, tools, left, right, split, lsplit, rsplit, tabs, strip };
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

// wireframe = one override material on the scene; the renderer draws every
// mesh with it and nothing in the world is touched. Off on exit.
let wireOn = false;
let wireMat = null;
function setWireframe(v) {
  wireOn = !!v;
  if (wireOn) {
    wireMat ??= new THREE.MeshBasicNodeMaterial({ color: 0xbfc4cc, wireframe: true, toneMapped: false });
    scene.overrideMaterial = wireMat;
  } else if (scene.overrideMaterial === wireMat) scene.overrideMaterial = null;
}

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
      row.onclick = () => { closeMenus(); it.run(); };
      pop.append(row);
    }
    pop.hidden = false;
  };
  wrap.append(b, pop);
  return wrap;
}
function closeMenus() { for (const p of document.querySelectorAll('.edit-menu-pop')) p.hidden = true; }
addEventListener('pointerdown', (e) => { if (!(e.target instanceof Element && e.target.closest('.edit-menu'))) closeMenus(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); }, true);

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

/** Lay the columns out from L; called on enter, on every splitter move, on resize. */
function apply() {
  if (!els || !on) return;
  const { top, tools, left, right, split, lsplit, rsplit, tabs, strip } = els;
  const TOP = 40, RAIL = 48;
  // the bar runs the full width: the ∃ sits in its left end (the corner) with the mic / ear /
  // goggles beside it, as on the HUD (R, 09-30). The rail starts under it: the wrench, then the
  // tools — no gaps between bar, rail and columns (R, 09-13).
  top.style.cssText = `left:0; right:0; top:0; height:${TOP}px`;
  tools.style.cssText = `left:0; top:${TOP}px; bottom:0; width:${RAIL}px; padding-top:46px`;
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
  const { top, tools, left, right, lsplit, rsplit, tabs } = build();
  on = true;
  for (const e of [top, tools, left, right, lsplit, rsplit]) e.hidden = false;
  document.body.classList.add('edit-workspace');
  dispatchEvent(new CustomEvent('dockmoved'));   // the ∃ just moved into the corner: re-seat its glyphs now (mictoggle.placeMic listens)
  const bd = getFrame('build'), h = getFrame('hierarchy'), i = getFrame('inspector'), c = getFrame('chat');
  bd?.dock(left); h?.dock(left);
  left.prepend(tabs, ...[bd?.el, h?.el].filter(Boolean));   // tabs, then both pages, above the splitter
  i?.dock(right);
  if (c) { prevChat = c.visible; c.dock(left); if (!c.visible) c.show(); }
  // floating frames render UNDER the columns; the World panel build.js opens
  // on entry sits at the right edge, exactly where the Inspector now is.
  // Park it; World ▾ brings it back, and exit restores it.
  const w = getFrame('world');
  prevWorld = !!w?.visible;
  if (w?.visible) w.hide();
  apply();
  // the glyphs re-seat on the next frame (mictoggle hears edit-mode too); measure once they have
  requestAnimationFrame(() => requestAnimationFrame(fitSeat));
  clearInterval(seatTimer); seatTimer = setInterval(fitSeat, 1000);
}
function exit() {
  if (!els || !on) return;
  on = false;
  clearInterval(seatTimer); seatTimer = 0;
  const { top, tools, left, right, lsplit, rsplit, strip } = els;
  for (const e of [top, tools, left, right, lsplit, rsplit, strip]) e.hidden = true;
  document.body.classList.remove('edit-workspace');
  dispatchEvent(new CustomEvent('dockmoved'));   // …and back beside the HUD's ∃
  setWireframe(false);
  if (els.top.querySelector('.edit-vbtn[data-view="wire"]')) els.top.querySelector('.edit-vbtn[data-view="wire"]').classList.remove('on');
  const c = getFrame('chat');
  for (const f of [getFrame('build'), getFrame('hierarchy'), getFrame('inspector'), c]) { if (f) { f.el.style.flex = ''; f.undock(); } }
  if (c && prevChat != null) c[prevChat ? 'show' : 'hide']();   // exactly as it was before the workspace
  if (prevWorld) getFrame('world')?.show();
  prevChat = prevWorld = null;
  closeMenus();
}

export function initEditLayout() {
  bus.on('edit-mode', (v) => (v ? enter() : exit()));
  // tool hotkeys live in build.js's key router (Blender's G/R/S/Q/F/X)
  return { apply, isOn: () => on };
}

/** harness window */
export const editLayoutDebug = () => ({ on, layout: { ...L }, tool: getTool(), tab: els?.left.dataset.tab ?? null,
  docked: allFrames().filter((f) => f.docked).map((f) => f.id) });
