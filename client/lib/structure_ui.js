// structure_ui — the griddled-building editor's hosted half.
//
// Thin on purpose. Every edit is a pure function in shared/structure_edit.js,
// so this file only has to answer three questions: which building, where on its
// grid, and which tool. The edit itself, the preview, and the undo entry are
// all the same call — a preview cannot disagree with what commits, because it
// IS what commits, drawn instead of sent.
//
// One component carries a whole building, so an edit re-sends it wholesale, as
// ONE door request with `expect` on the building as this viewer saw it: if
// someone else changed it since, the door refuses (`changed`) rather than one
// edit silently eating the other. Undo is the editor's one undo (Ctrl+Z: the
// door's undo of MY act, v4edit.js), so it always lands on the building that
// act changed, and keeps theirs where someone changed it since. (Review 10-07:
// this file used to keep its own stack and write the popped plan into whatever
// building was current, with expect: false.)

import * as OP from '../../shared/v4/ops.js';
import { sendOps } from './v4edit.js';
import { flashHint } from './ui.js';
import { THREE, canvas, camera, scene } from './core.js';
import { bus, report } from './base.js';
import { state } from './state.js';
import { planStructure, localizePoint, GRID_DEFAULTS } from '../../shared/structure.js';
import { setCutaway } from './realize/structure.js';
import {
  emptyStructure, pickEdge, pickCell, addWall, removeWall, setAperture,
  drawRoom, eraseRoom, setTile, pickWalledEdge,
} from '../../shared/structure_edit.js';

const TOOLS = [   // [key, label, hint, icon] — icons.js glyphs (no emoji: the old 🚪 🪟 were the only colour in the bar)
  ['room', 'room', 'drag a rectangle: floor and walls right round it', 'square'],
  ['wall', 'wall', 'click an edge — or the middle of a cell for a diagonal', 'brickWall'],
  ['door', 'door', 'click a wall', 'doorOpen'],
  ['window', 'window', 'click a wall', 'appWindow'],
  ['floor', 'floor', 'click a cell', 'grid3x3'],
  ['erase', 'erase', 'drag to clear floor; shared walls survive', 'eraser'],
];

let tool = null;
let editing = null;          // entity id being edited
let dragFrom = null;
let dragOn = null;           // the building a room/erase drag started on: the stroke stays on it
let selectedId = null;       // the Hierarchy/inspector selection (sg:selected)
let ghost = null;

/** Every structure entity in the world. */
const buildings = () => Object.entries(state.st.entities ?? {})
  .filter(([, e]) => e?.comp?.structure)
  .map(([id, e]) => ({ id, ent: e, data: e.comp.structure }));

/** The floor plane's height in the building's frame (planStructure's levels[0].y, without planning it: this runs per
 *  building per mousemove). */
const floorOf = (g) => (Number.isFinite(g?.levels?.[0]?.y) ? g.levels[0].y : 0) + (Number.isFinite(g?.slabT) ? g.slabT : GRID_DEFAULTS.slabT);

/** World ray → the grid-local point on a building's floor plane. */
function hitGrid(ev, b) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  // the raycaster reads camera.matrixWorld, which is only refreshed during
  // render — a pick taken in the same tick as a camera move uses the OLD
  // matrix and lands somewhere else entirely
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  const y = (b.ent.pos?.[1] ?? 0) + floorOf(b.data);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, hit)) return null;
  const [lx, , lz] = localizePoint(b.ent, hit.x, hit.y, hit.z);
  return { lx, lz, world: hit };
}

const PAD = 3;                         // cells round a building's footprint that still edit it (room to extend it outwards)
/** Does this grid-local point fall on the building's footprint, PAD cells out? (an empty building: PAD round its anchor) */
function onFootprint(b, at) {
  const t = b.data?.tile ?? GRID_DEFAULTS.tile;
  let x0 = 0, x1 = 1, z0 = 0, z1 = 1;
  for (const [tx, tz] of b.data?.levels?.[0]?.tiles ?? []) { x0 = Math.min(x0, tx); x1 = Math.max(x1, tx + 1); z0 = Math.min(z0, tz); z1 = Math.max(z1, tz + 1); }
  return at.lx >= (x0 - PAD) * t && at.lx <= (x1 + PAD) * t && at.lz >= (z0 - PAD) * t && at.lz <= (z1 + PAD) * t;
}
/** The building to edit, never a guess among many (review 10-07: it used to be the first building in the world):
 *  the selected building; else the one under the pointer (its footprint, PAD cells out; the nearest anchor if two
 *  overlap); else the one last edited here; else the world's only one. Null otherwise: the tool says to select one. */
function target(ev = null) {
  const all = buildings();
  const sel = all.find((b) => b.id === selectedId); if (sel) return sel;
  if (ev) {
    let best = null, bd = Infinity;
    for (const b of all) { const at = hitGrid(ev, b); if (!at || !onFootprint(b, at)) continue;
      const p = b.ent.pos ?? [0, 0, 0]; const d = Math.hypot(at.world.x - p[0], at.world.z - p[2]); if (d < bd) { bd = d; best = b; } }
    if (best) return best;
  }
  return all.find((b) => b.id === editing) ?? (all.length === 1 ? all[0] : null);
}

/** Run a tool. `commit` false draws the ghost instead of sending. */
function apply(b, at, commit, upTo = null) {
  const g = b.data;
  const cell = pickCell(g, at.lx, at.lz);
  let next = null;
  switch (tool) {
    case 'room': next = drawRoom(g, upTo ?? cell, cell); break;
    case 'erase': next = eraseRoom(g, upTo ?? cell, cell); break;
    case 'floor': next = setTile(g, cell); break;
    case 'wall': {
      const e = pickEdge(g, at.lx, at.lz);
      next = e ? addWall(g, e) : null; break;
    }
    case 'door':
    case 'window': {
      // the nearest edge that EXISTS, not the nearest edge — see pickWalledEdge
      const e = pickWalledEdge(g, at.lx, at.lz);
      next = e ? setAperture(g, e, tool) : null; break;
    }
    default: return;
  }
  if (!next) return;
  if (commit) {
    editing = b.id;
    // expect: the building as this viewer saw it (sendOps reads it from the fold); one act, so one Ctrl+Z
    sendOps([OP.set(b.id, 'structure', next)], { what: `the building ${b.id}` });
    setTimeout(refreshGrid, 60);       // the lattice follows the footprint out
  } else {
    showGhost(b, next);
  }
}

/** Preview by drawing the RESULT — the same function that would commit. */
function showGhost(b, next) {
  clearGhost();
  try {
    const plan = planStructure(next);
    const geoms = [];
    for (const sw of plan.levels[0]?.sweeps ?? []) {
      if (!sw.positions.length) continue;
      const g2 = new THREE.BufferGeometry();
      g2.setAttribute('position', new THREE.Float32BufferAttribute(sw.positions, 3));
      g2.setIndex(sw.indices);
      geoms.push(g2);
    }
    if (!geoms.length) return;
    ghost = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({
      color: 0x66ddff, transparent: true, opacity: 0.28,
      depthWrite: false, side: THREE.DoubleSide,
    });
    for (const g2 of geoms) ghost.add(new THREE.Mesh(g2, mat));
    ghost.position.set(...(b.ent.pos ?? [0, 0, 0]));
    ghost.rotation.y = b.ent.yaw ?? 0;
    scene.add(ghost);
  } catch (e) { report('structure ghost', e); }
}

function clearGhost() {
  if (!ghost) return;
  scene.remove(ghost);
  for (const m of ghost.children) m.geometry?.dispose();
  ghost.children[0]?.material?.dispose();
  ghost = null;
}

/** The point a new building starts under: the event's, when it is ON the world (a click in the
 *  viewport), else the lower middle of the visible viewport — a button in a docked panel is not a place
 *  in the world (the edit workspace's columns publish the viewport's edges as CSS vars). */
function aimPoint(ev) {
  if (ev && typeof document !== 'undefined' && document.elementFromPoint?.(ev.clientX, ev.clientY) === canvas) return ev;
  const cs = getComputedStyle(document.body);
  const left = parseFloat(cs.getPropertyValue('--edit-left-edge')) || 0;
  const right = document.body.classList.contains('edit-workspace') ? (parseFloat(cs.getPropertyValue('--edit-right-w')) || 0) : 0;
  // lower middle: the ground is below the horizon (the old floating bar sat low in the view too)
  return { clientX: left + (innerWidth - left - right) / 2, clientY: 40 + (innerHeight - 40) * 0.7 };
}

/** Start a new building where the pointer is (or, from a panel, on the ground in view). */
export function newBuilding(ev) {
  const at = aimPoint(ev);
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((at.clientX - r.left) / r.width) * 2 - 1,
    -((at.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
  const id = `house-${Math.floor(hit.x)}_${Math.floor(hit.z)}`;
  sendOps([OP.create(id, { model: 'eidoverse/assets/models/crate_large_red.glb', transform: { pos: [Math.round(hit.x), 0, Math.round(hit.z)] },
    components: { structure: emptyStructure() } })], { what: 'a new building', expect: false });
  editing = id; selectedId = id;   // the new building is the one the tools edit now (until something else is selected)
  setTimeout(refreshGrid, 120);
}

// ---- pointer ----------------------------------------------------------------
// mousedown, not pointerdown: build.js reads canvas picking off mouse events and
// synthetic PointerEvents never reach it (a lesson already paid for once).

function onDown(ev) {
  if (!active || !tool || ev.button !== 0) return;
  const b = target(ev);
  if (!b) { if (buildings().length) { ev.preventDefault(); ev.stopPropagation(); flashHint('which building? select it first (Hierarchy, or click it), or click on its floor', 4000); } return; }
  const at = hitGrid(ev, b);
  if (!at) return;
  ev.preventDefault(); ev.stopPropagation();
  if (tool === 'room' || tool === 'erase') { dragFrom = pickCell(b.data, at.lx, at.lz); dragOn = b.id; return; }
  apply(b, at, true);
}

/** The building a live room/erase stroke is on (it started there), else the one this pointer would edit. */
const strokeTarget = (ev) => (dragOn ? buildings().find((b) => b.id === dragOn) ?? null : target(ev));

function onMove(ev) {
  if (!active || !tool) return;
  const b = strokeTarget(ev);
  if (!b) { clearGhost(); return; }
  const at = hitGrid(ev, b);
  if (!at) { clearGhost(); return; }
  apply(b, at, false, dragFrom);
}

function onUp(ev) {
  if (!active || !tool || !dragFrom) return;
  const b = strokeTarget(ev);
  const at = b && hitGrid(ev, b);
  if (b && at) apply(b, at, true, dragFrom);
  dragFrom = null; dragOn = null;
  clearGhost();
}

/** Which tool is live, for tests and for anything that wants to drive it. */
export const currentTool = () => tool;
/** The tools as data — the Create panel's tiles and the viewport strip read these (no second list). */
export const structureTools = () => TOOLS.map(([k, label, hint, icon]) => ({ k, label, hint, icon }));
export function setTool(t) {
  tool = TOOLS.some(([k]) => k === t) ? t : null;
  if (!tool) { dragFrom = null; dragOn = null; clearGhost(); }
  bus.emit('structure-tool', { tool });
  return tool;
}

// ---- the grid overlay -------------------------------------------------------
// You cannot snap to something you cannot see. The overlay draws the lattice a
// click will actually land on, in the building's own frame — which is also the
// only honest way to show a grid that may be rotated or diagonal to the world.

let gridHelp = null;

function refreshGrid() {
  if (gridHelp) { scene.remove(gridHelp); gridHelp.geometry.dispose(); gridHelp.material.dispose(); gridHelp = null; }
  const b = target();
  if (!active || !b) return;
  const g = b.data ?? {};
  const t = g.tile ?? GRID_DEFAULTS.tile;
  const lv = g.levels?.[0] ?? {};
  let x0 = 0, x1 = 1, z0 = 0, z1 = 1;
  for (const [tx, tz] of lv.tiles ?? []) {
    x0 = Math.min(x0, tx); x1 = Math.max(x1, tx + 1);
    z0 = Math.min(z0, tz); z1 = Math.max(z1, tz + 1);
  }
  x0 -= PAD; z0 -= PAD; x1 += PAD; z1 += PAD;
  const pts = [];
  const y = floorOf(g) + 0.012;
  for (let x = x0; x <= x1; x++) pts.push(x * t, y, z0 * t, x * t, y, z1 * t);
  for (let z = z0; z <= z1; z++) pts.push(x0 * t, y, z * t, x1 * t, y, z * t);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  gridHelp = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: 0x4fb3d9, transparent: true, opacity: 0.22, depthWrite: false,
  }));
  gridHelp.position.set(...(b.ent.pos ?? [0, 0, 0]));
  gridHelp.rotation.y = b.ent.yaw ?? 0;
  scene.add(gridHelp);
}

let active = false;

/** Build mode owns the structure tools: they arrive with it and leave with it,
 *  rather than floating over a world nobody is editing. Their buttons live in
 *  the edit workspace's Create panel (the viewport stays clean). */
export function setStructureMode(on) {
  if (active === on) return active;
  active = !!on;
  if (!active) { setTool(null); clearGhost(); }
  setCutaway(active);
  refreshGrid();
  return active;
}
export const isStructureMode = () => active;

export function initStructureUI() {
  canvas.addEventListener('mousedown', onDown, true);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  bus.on('world-reset', () => { editing = null; selectedId = null; clearGhost(); refreshGrid(); });
  // the selected building is the one the tools edit (and its lattice is the one drawn)
  bus.on('sg:selected', (id) => { selectedId = id ?? null; if (active) refreshGrid(); });
  // the mode arrives and leaves with eidoverse's own build mode — B, or Esc
  bus.on('edit-mode', (on) => setStructureMode(on));
  // a building appearing or changing under us moves the lattice with it
  bus.on('entity', (ev) => { if (active && ev?.kind !== 'collider') refreshGrid(); });

  // The tools' DOM is the Create panel (editpanels.js, docked beside the Hierarchy) and the viewport's
  // armed-tool strip (editlayout.js): both read structureTools(), arm with setTool, undo with undo().
  return true;
}

export function disposeStructureUI() {
  canvas.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  clearGhost();
}
