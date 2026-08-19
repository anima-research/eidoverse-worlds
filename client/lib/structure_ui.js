// structure_ui — the griddled-building editor's hosted half.
//
// Thin on purpose. Every edit is a pure function in shared/structure_edit.js,
// so this file only has to answer three questions: which building, where on its
// grid, and which tool. The edit itself, the preview, and the undo entry are
// all the same call — a preview cannot disagree with what commits, because it
// IS what commits, drawn instead of sent.
//
// One `comp` carries a whole building, so an edit re-emits it wholesale. That
// is what makes undo "keep the previous value" (no inverse operations to get
// wrong) and it is also why LAST WRITE WINS: two people editing one building
// will silently lose an edit rather than corrupt it. Worth knowing before
// anyone builds together.

import { THREE, canvas, camera, scene, bus, report } from './core.js';
import { sendVerb } from './net.js';
import { state } from './state.js';
import { planStructure, localizePoint } from '../../shared/structure.js';
import {
  emptyStructure, pickEdge, pickCell, addWall, removeWall, setAperture,
  drawRoom, eraseRoom, setTile, pickWalledEdge,
} from '../../shared/structure_edit.js';

const TOOLS = [
  ['room', '▭ room', 'drag a rectangle: floor and walls right round it'],
  ['wall', '│ wall', 'click an edge — or the middle of a cell for a diagonal'],
  ['door', '🚪 door', 'click a wall'],
  ['window', '🪟 window', 'click a wall'],
  ['floor', '▦ floor', 'click a cell'],
  ['erase', '⌫ erase', 'drag to clear floor; shared walls survive'],
];

let tool = null;
let editing = null;          // entity id being edited
let dragFrom = null;
const undoStack = [];
let ghost = null;

/** Every structure entity in the world. */
const buildings = () => Object.entries(state.st.entities ?? {})
  .filter(([, e]) => e?.comp?.structure)
  .map(([id, e]) => ({ id, ent: e, data: e.comp.structure }));

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
  const plan = planStructure(b.data);
  const y = (b.ent.pos?.[1] ?? 0) + (plan.levels[0]?.y ?? 0);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(plane, hit)) return null;
  const [lx, , lz] = localizePoint(b.ent, hit.x, hit.y, hit.z);
  return { lx, lz, world: hit, plan };
}

/** The building to edit: the one being edited, else the only one, else null. */
function target() {
  const all = buildings();
  return all.find((b) => b.id === editing) ?? (all.length === 1 ? all[0] : all[0] ?? null);
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
    undoStack.push(JSON.parse(JSON.stringify(g)));
    if (undoStack.length > 40) undoStack.shift();
    sendVerb('comp', { id: b.id, type: 'structure', data: next });
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

export function undo() {
  const b = target();
  const prev = undoStack.pop();
  if (!b || !prev) return false;
  sendVerb('comp', { id: b.id, type: 'structure', data: prev });
  return true;
}

/** Start a new building where the pointer is. */
function newBuilding(ev) {
  const r = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1);
  const ray = new THREE.Raycaster();
  camera.updateMatrixWorld();
  ray.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit)) return;
  const id = `house-${Math.floor(hit.x)}_${Math.floor(hit.z)}`;
  sendVerb('spawn', { id, lib: 'eidoverse/assets/models/crate_large_red.glb',
    pos: [Math.round(hit.x), 0, Math.round(hit.z)], yaw: 0 });
  sendVerb('comp', { id, type: 'structure', data: emptyStructure() });
  editing = id;
}

// ---- pointer ----------------------------------------------------------------
// mousedown, not pointerdown: build.js reads canvas picking off mouse events and
// synthetic PointerEvents never reach it (a lesson already paid for once).

function onDown(ev) {
  if (!tool || ev.button !== 0) return;
  const b = target();
  if (!b) return;
  const at = hitGrid(ev, b);
  if (!at) return;
  ev.preventDefault(); ev.stopPropagation();
  if (tool === 'room' || tool === 'erase') { dragFrom = pickCell(b.data, at.lx, at.lz); return; }
  apply(b, at, true);
}

function onMove(ev) {
  if (!tool) return;
  const b = target();
  if (!b) return;
  const at = hitGrid(ev, b);
  if (!at) { clearGhost(); return; }
  apply(b, at, false, dragFrom);
}

function onUp(ev) {
  if (!tool || !dragFrom) return;
  const b = target();
  const at = b && hitGrid(ev, b);
  if (b && at) apply(b, at, true, dragFrom);
  dragFrom = null;
  clearGhost();
}

/** Which tool is live, for tests and for anything that wants to drive it. */
export const currentTool = () => tool;
export function setTool(t) {
  tool = TOOLS.some(([k]) => k === t) ? t : null;
  if (!tool) { dragFrom = null; clearGhost(); }
  bus.emit('structure-tool', { tool });
  return tool;
}

let bar = null;
export function initStructureUI() {
  canvas.addEventListener('mousedown', onDown, true);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  bus.on('world-reset', () => { undoStack.length = 0; editing = null; clearGhost(); });

  bar = document.createElement('div');
  bar.id = 'structbar';
  bar.style.cssText = 'position:fixed;left:12px;bottom:64px;z-index:40;display:flex;'
    + 'gap:4px;flex-wrap:wrap;max-width:320px;font:12px ui-monospace,monospace';
  const mk = (label, title, fn) => {
    const btn = document.createElement('button');
    btn.textContent = label; btn.title = title;
    btn.style.cssText = 'padding:4px 8px;border-radius:6px;border:1px solid #2c3a44;'
      + 'background:#111a20;color:#cfe3ee;cursor:pointer';
    btn.onclick = (e) => { e.stopPropagation(); fn(e, btn); paint(); };
    bar.appendChild(btn);
    return btn;
  };
  const btns = TOOLS.map(([k, label, title]) =>
    [k, mk(label, title, () => setTool(tool === k ? null : k))]);
  mk('+ new', 'start a new building under the pointer', (e) => newBuilding(e));
  mk('↶ undo', 'undo the last edit', () => undo());
  const paint = () => {
    for (const [k, btn] of btns) {
      btn.style.background = tool === k ? '#1d4a5c' : '#111a20';
      btn.style.borderColor = tool === k ? '#4fb3d9' : '#2c3a44';
    }
  };
  document.body.appendChild(bar);
  paint();
  return true;
}

export function disposeStructureUI() {
  canvas.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('mousemove', onMove);
  window.removeEventListener('mouseup', onUp);
  clearGhost();
  bar?.remove(); bar = null;
}
