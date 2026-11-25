// build — the human's authoring surface: moving, correcting and unmaking things, with undo (the verbs agents always
// had). Placement helpers are the drag semantics (DESIGN.md): the ghost lands ON the table, not beside it.
//
// This file is the gesture CORE: mode, selection, ghost, drag, undo, and the one pointer/key router. The panels live
// beside it (catalog.js, groundpanel.js, skypanel.js, panels.js); seat gestures are handed to socketedit.js.

import { svg as iconSvg } from '../ui/icons.js';
import * as OP from '../../../shared/requests.js';
import { LIGHT_DEFAULTS } from '../../../shared/components.js';
import { THREE, scene, camera, canvas } from '../core.js';
import { bus, report } from '../base.js';
import { loadGLB, libLabels, modelName } from '../assets.js';
import { makeLightGizmo } from '../render/lightgizmo.js';
import { entities, metaOf, bagOf, editHolds } from '../world.js';
import { reindexCollider } from '../colliders.js';
import { heightAt } from '../terrain.js';
import { net, sendDrag } from '../net.js';
import { scaleOf } from '../../../shared/scale3.js';
import { MESH_DEFAULT, ghostMeshSize } from '../meshdefaults.js';
import { engage, release } from './keyhints.js';
import { myState, mouse, setPointerClaim, setBuildingProbe } from '../player/controller.js';
import { flashHint, collapseAll, panelFrame, html, claimStatus, releaseStatus } from '../ui/ui.js';
import { paint, escapeHtml } from '../ui/markup.js';
import { pushHostHook } from '../render/autohooks.js';
import { clickable } from './selectmask.js';
import { outOfMyView } from './myview.js';
import * as Sel from './selection.js';
import * as MM from './multimove.js';   // the rest of the selection follows a mesh drag (R, gym 10-17 21:40)
import { claimEscape } from '../ui/windows.js';
import { isOwner } from '../../../shared/protocol/roles.js';
import { currentTool as structureTool, setTool as setStructureTool } from './structure_ui.js';   // an armed building tool is Esc's first rung
import { state } from '../state.js';   // one rule for who may author (and one name for them), shared with the scene panel
import * as Edits from './writes.js';
import { refreshSocketGizmos, resetSockets, armSocketPlacement, socketArmed, socketSelected,
  cancelSocketArm, deselectSocket, socketMouseDown, socketKeyDown, updateSocketDrag } from './socketedit.js';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

// ============================================================ state

let ghost = null;         // { obj, lib, yaw, scale } — a thing not yet placed
let selected = null;      // { id, obj } — the selection's primary thing, resolved to its object (edit/selection.js is the truth)
let dragging = null;      // { id, armed, before, grab, … } from a press on a thing: a move once armed (DRAG_SLOP)

// Editing is a MODE: in a world you look around by dragging, an always-live editor would move whatever a camera drag
// started on. Looking is the default; editing is something you say you are doing.
let buildMode = false;
export const isBuilding = () => buildMode;
claimEscape(() => (buildMode ? 'edit' : null));   // build mode owns Esc (its own ladder) — the frames' close-all yields

/** No edit mode on a phone (a coarse pointer on a phone-sized screen); tablets, headsets and touch laptops keep it. */
export const editSurface = () => !(globalThis.matchMedia?.('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600);
/** May this client enter edit mode? PERMISSIVE WHEN UNKNOWN: net.myRights is `undefined` until the snapshot or a live
 *  grant, and the authority decides anyway; a build click that vanishes on a slow join is worse than one refused out loud. */
export const mayEdit = () => {
  if (!editSurface()) return false;
  const r = net.myRights; const role = r?.role;
  // the build permission, never a role name
  if (Array.isArray(r?.permissions)) return r.permissions.includes('build');
  return role === undefined || isOwner(r);
};

export function setBuildMode(on, { quiet = false } = {}) {
  // the rights gate, at the one chokepoint every entry funnels through (the wrench, KeyB, holdGhost, armSocketPlacement).
  // ONLY the `on` direction: leaving always works, or a client demoted mid-session is trapped in build mode.
  if (on && !mayEdit()) {
    if (!quiet) flashHint(editSurface() ? 'builder mode needs build rights in this world' : 'builder mode is for a desktop (or tablet); on a phone you can look around and play');
    return buildMode;
  }
  if (buildMode === on) return buildMode;
  buildMode = on;
  document.body.classList.toggle('build-mode', on);
  if (!on) { cancelGhost(); deselect(); resetSockets(); }
  refreshSocketGizmos();   // anchors are visible exactly while you are editing
  if (!quiet) {
    flashHint(on
      ? html`builder mode — <kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>Q</kbd> select · <kbd>F</kbd> find · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>B</kbd> leaves`
      : 'looking again');
  }
  bus.emit('build-mode', on);
  return buildMode;
}
export const toggleBuildMode = () => setBuildMode(!buildMode);

// The TOOL is what a drag does: move, rotate, scale, pivot; select never moves anything. gizmo.js reads the same state.
let tool = 'move';
export const getTool = () => tool;
// transform space per tool: world = the world's axes, object = the thing's own (three's 'local'); scale is always the
// thing's own. Kept per viewer, never logged.
export const SPACES = { move: ['world', 'object'], rotate: ['world', 'object'], scale: ['object'] };
const space = (() => { try { return { move: 'world', rotate: 'world', scale: 'object', ...JSON.parse(localStorage.getItem('ew-tool-space') ?? '{}') }; } catch { return { move: 'world', rotate: 'world', scale: 'object' }; } })();
export const getSpace = (t = tool) => space[t] ?? 'world';
export function setSpace(t, s) {
  if (!SPACES[t]?.includes(s)) return getSpace(t);
  space[t] = s; try { localStorage.setItem('ew-tool-space', JSON.stringify(space)); } catch { /* fine */ }
  bus.emit('tool-space', { tool: t, space: s });
  return s;
}
/** The active tool's key pressed again steps its space (Blender's double-press, one key): G G = move in object axes. */
function cycleSpace(t = tool) {
  const list = SPACES[t]; if (!list || list.length < 2) return getSpace(t);
  return setSpace(t, list[(list.indexOf(getSpace(t)) + 1) % list.length]);
}
export function setTool(t) {
  if (!['select', 'move', 'rotate', 'scale', 'pivot'].includes(t) || t === tool) return tool;
  tool = t;
  bus.emit('tool', tool);
  return tool;
}
export const hasGhost = () => ghost !== null;
export const hasSelection = () => selected !== null;
setPointerClaim(() => ghost !== null || !!dragging?.armed);
// handle sets (gizmo.js, gripedit.js) veto the mesh-grab while one of their handles is hot: a probe, not an import
// (they import us); any one vetoes
const pointerVetoes = [];
const pointerVeto = () => pointerVetoes.some((f) => f());
export function setPointerVeto(fn) { pointerVetoes.push(fn); }
setBuildingProbe(() => buildMode);

// ============================================================ selection

const outline = new THREE.Box3Helper(new THREE.Box3(), 0x8fe8c8);
outline.visible = false;
outline.userData.noCamCollide = true;
scene.add(outline);

// the selection line lives in the one status bar (ui.js claimStatus): a node claimed at priority 4 while something is
// selected, released when nothing is. The lock checkbox rides inside it.
let inspector = null;
function ensureInspector() {
  if (!inspector) { inspector = document.createElement('div'); inspector.className = 'edit-selbar'; }
  return inspector;
}
const showSelbar = () => claimStatus('selection', { priority: 4, node: ensureInspector() });
/** The selection bar as a surface other editors write to (socketedit.js paints its anchor line through this). */
export function setInspectorHtml(line) {   // text, or markup built with html`` (markup.js)
  paint(ensureInspector(), line);
  showSelbar();
}
function showInspector(id) {
  const meta = metaOf(id) ?? {};
  ensureInspector();
  // its NAME first, then the model's library label, its file, its id
  const own = Edits.compsOf(id)?.label;
  const label = (typeof own === 'string' && own) || (meta.model != null ? modelName(meta.model) : id);
  const locked = isLocked(id);
  inspector.innerHTML =
    `<span><b>${escapeHtml(label.slice(0, 34))}</b></span>` +   // a thing's label or model path: world content, text
    (locked
        ? `<span style="color:var(--dim)">locked — only a builder who may lift the lock edits it, until unchecked</span>`
        : `<span style="color:var(--dim)">drag move · <kbd>Shift</kbd>+drag up/down · ` +
          `<kbd>G</kbd> move · <kbd>E</kbd> rotate · <kbd>R</kbd> scale · <kbd>F</kbd> find · <kbd>X</kbd> remove · <kbd>Esc</kbd> done</span>`) +
    `<label title="nail it down: while locked, nobody's drags, edits or scripts change it (server-enforced) — sitting on it and using it (doors, handlers) stay open; a builder who may lift the lock edits through it" style="display:flex;gap:4px;align-items:center;cursor:pointer">` +
    // an icon, never an emoji (emoji belong to the Chat pane and the action bar only)
    `<input type="checkbox" data-bact="lock"${locked ? ' checked' : ''}><span class="sp-ico" aria-hidden="true">${iconSvg(locked ? 'lock' : 'lockOpen', 14)}</span> lock</label>`;
  // no '+ seat' here: a seat is added where components are (Add Component ▸ Sockets)
  inspector.querySelector('[data-bact="lock"]').onchange = (ev) => {
    const on = ev.target.checked;
    Edits.lock(id, on).then(() => { if (selected?.id === id) showInspector(id); });
  };
  showSelbar();
}
export function hideInspector() { releaseStatus('selection'); }

/** The selection's primary thing, when it is a thing. */
const primaryThing = () => { const s = Sel.selection(); return s.kind === 'things' ? s.ids[0] ?? null : null; };
export function select(id) {
  if (!entities.get(id)) return;
  // one store (edit/selection.js); the panels, the gizmo and this file's outline all follow its event
  Sel.set([id]);
  showInspector(id);
}
/** The deliberate deselect (Esc, Edit ▸ deselect): the selection itself. Plain deselect() drops the gesture and the
 *  helper strip and re-reads the selection — undo calls it, and an undo must not throw away the selection you are
 *  working on. */
export function deselectAll() { deselect(); Sel.clear(); }
export function deselect() {
  cancelDrag();
  for (const f of dragCancels) f();   // the gizmo's drag too
  hideInspector();
  followSelection();
}
/** End a drag as Esc does: an armed one puts back all it holds (the samples end), writes nothing, and says so. A deselect, an
 *  undo, leaving build mode or a selection change mid-drag ends it so, then goes ahead (#352 review 8d7c6b9, points 2, 3). */
function cancelDrag() {
  const d = dragging; dragging = null;
  if (!d?.armed) return false;
  MM.revertHeld(d.gen, MM.idsOf(d.id, d.multi)); release();
  flashHint('move cancelled — nothing written');
  return true;
}
const dragCancels = [];
/** Another surface's drag (gizmo.js) ends with this one. */
export function onDragCancel(fn) { dragCancels.push(fn); }
export function refreshOutline() {
  if (selected) outline.box.setFromObject(selected.obj);
}
// ONE selection: edit/selection.js is the truth; `selected` is its primary resolved to an object, re-resolved on its
// event and each edit-mode frame (a model swapped under it, a thing gone), the box re-measured. editHolds keeps the
// residency sweep from demoting what someone is editing (id-based: promotion swaps the object).
function followSelection() {
  // the drag never outlives its captured lead: a selection without it first, or without a follower, cancels it
  if (dragging?.armed) { const s = Sel.selection(); if (s.kind !== 'things' || s.ids[0] !== dragging.id || !MM.idsOf(dragging.id, dragging.multi).every((x) => s.ids.includes(x))) cancelDrag(); }
  const sid = buildMode ? primaryThing() : null; const obj = sid != null ? entities.get(sid) : null;
  if (obj) {
    if (!selected || selected.id !== sid || selected.obj !== obj) { if (selected && selected.id !== sid) editHolds.delete(selected.id); selected = { id: sid, obj }; editHolds.add(sid); }
    obj.updateWorldMatrix(true, true); outline.box.setFromObject(obj); outline.visible = true;
  } else if (selected && !dragging) { editHolds.delete(selected.id); selected = null; outline.visible = false; }
}
bus.on('selection', followSelection);
pushHostHook(followSelection);
/** For probes: what the viewport shows as selected (its outline box). */
export const selectionView = () => ({ id: selected?.id ?? null, visible: !!outline.visible, min: outline.box.min.toArray(), max: outline.box.max.toArray() });
// the echo of a place (ours from the inspector, or anyone's) moves the mesh; the box follows
bus.on('entity', ({ id } = {}) => { if (selected && id === selected.id) refreshOutline(); });

// ============================================================ ghost placement

function ghostify(obj) {
  obj.traverse((o) => {
    if (!o.isMesh) return;
    o.material = o.material.clone();
    o.material.transparent = true;
    o.material.opacity = 0.55;
    o.material.depthWrite = false;
    o.castShadow = false;
  });
  obj.userData.noCamCollide = true;
}

// Create ▸ Box/Sphere/Cylinder/Plane/Capsule: a `mesh` thing, held as a grey ghost standing on the floor (its origin is
// its base centre, as the authority's boxOfM has it). Q/E turn it; ,/. scale it. The lib is '@mesh:<shape>'.
const meshOf = (lib) => (typeof lib === 'string' && lib.startsWith('@mesh:') ? lib.slice(6) : null);
function meshGhost(shape, [x, y, z]) {
  const r = x / 2;
  const geo = shape === 'sphere' ? new THREE.SphereGeometry(r, 24, 12).translate(0, r, 0)
    : shape === 'cylinder' ? new THREE.CylinderGeometry(r, r, y, 24).translate(0, y / 2, 0)
    : shape === 'capsule' ? new THREE.CapsuleGeometry(r, Math.max(0, y - 2 * r), 6, 12).translate(0, Math.max(y, x) / 2, 0)
    : shape === 'plane' ? new THREE.PlaneGeometry(x, z).rotateX(-Math.PI / 2)
    : new THREE.BoxGeometry(x, y, z).translate(0, y / 2, 0);
  const obj = new THREE.Mesh(geo, new THREE.MeshStandardNodeMaterial({ color: 0x9a9a9a, roughness: 0.8, metalness: 0, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
  obj.castShadow = false; obj.userData.noCamCollide = true;
  return obj;
}
// Create ▸ Picture: pick a file (it goes to the store), then a 1 m square plate is in hand (it doesn't follow the
// image). Q/E turn it, ,/. size its width. The lib is '@picture:<src>'.
const pictureOf = (lib) => (typeof lib === 'string' && lib.startsWith('@picture:') ? lib.slice(9) : null);
export async function holdPicture() {
  const { pickPicture } = await import('../realize/pictures.js');
  const src = await pickPicture();
  if (src) await holdGhost(`@picture:${src}`, 'picture');
}
export async function holdGhost(lib, label) {
  setBuildMode(true, { quiet: true });   // choosing a thing to place is intent enough
  cancelGhost();
  deselect();
  try {
    let obj;
    if (lib === '@light') {
      obj = makeLightGizmo(0xffd9a0);
      obj.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.7; } });
    } else if (lib === '@empty') {   // Create ▸ Empty: a bare entity, a parent for others; shown as its axes
      obj = new THREE.AxesHelper(0.5);
    } else if (meshOf(lib)) {
      obj = meshGhost(meshOf(lib), MESH_DEFAULT[meshOf(lib)] ?? [1, 1, 1]);
    } else if (pictureOf(lib)) {   // the picture's own grey plate, standing on its lower edge (pictures.js quadOf)
      obj = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
      obj.userData.noCamCollide = true;
    } else {
      obj = await loadGLB(lib);
      ghostify(obj);
    }
    ghost = { obj, lib, yaw: 0, scale: 1 };
    scene.add(obj);
    collapseAll();
    flashHint(lib === '@light' || lib === '@empty'
      ? html`placing ${lib === '@light' ? html`a <b>light</b>` : html`an <b>empty</b>`} — click to place · <kbd>Esc</kbd> cancel`
      : html`placing <b>${label ?? meshOf(lib) ?? ''}</b> — click to place · <kbd>Q</kbd>/<kbd>E</kbd> turn · <kbd>,</kbd>/<kbd>.</kbd> size · <kbd>Esc</kbd> cancel`, 6000);
    if (lib !== '@light' && lib !== '@empty') engage('ghostKeys');   // the status line keeps the keys while it's in hand
  } catch (e) { report('ghost', e); }
}

export function cancelGhost() {
  if (ghost) { scene.remove(ghost.obj); ghost = null; release(); }
}

// Turn and size the thing in hand before the click: Q / E turn (15°, Shift 1°), , / . size (×1.1, Shift ×1.01), clamped
// as the scale tool clamps. (Not R / T or S / D: R is the scale tool and D walks.)
const GHOST_TURN = Math.PI / 12, GHOST_TURN_FINE = Math.PI / 180, GHOST_SIZE = 1.1, GHOST_SIZE_FINE = 1.01;
/** The thing in hand, for tests and the hint: {yaw, scale, lib} or null. */
export const ghostPose = () => (ghost ? { yaw: ghost.yaw, scale: ghost.scale, lib: ghost.lib } : null);
function ghostKey(e) {
  if (!ghost || ghost.lib === '@light' || ghost.lib === '@empty' || e.ctrlKey || e.metaKey || e.altKey) return false;   // keys: ghostKeys (a light is a point: nothing to turn; Ctrl+Z etc. pass)
  const fine = !!e.shiftKey;   // keys: ghostKeys
  if (e.code === 'KeyQ' || e.code === 'KeyE') ghost.yaw += (e.code === 'KeyQ' ? 1 : -1) * (fine ? GHOST_TURN_FINE : GHOST_TURN);
  else if (e.code === 'Comma' || e.code === 'Period') { const k = fine ? GHOST_SIZE_FINE : GHOST_SIZE; ghost.scale = THREE.MathUtils.clamp(ghost.scale * (e.code === 'Period' ? k : 1 / k), 0.1, 12); }
  else return false;
  ghost.yaw = Math.atan2(Math.sin(ghost.yaw), Math.cos(ghost.yaw));
  flashHint(html`turned <b>${Math.round(ghost.yaw * 180 / Math.PI)}°</b> · size <b>×${ghost.scale.toFixed(2)}</b>`, 1500);
  return true;
}

/** Where the pointer is aiming: the nearest hit on a thing under it, else (none, or that face is steep) the ground. `onto`
 *  is the hit object's own entityId, which a model's meshes don't carry (realize/models.js tags its root), so it is null. */
function aimPoint(skipId = null) {
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const [id, o] of entities) if (o && id !== skipId) targets.push(o);
  let hits = raycaster.intersectObjects(targets, true);
  // a mounted child is drawn INSIDE its parent's object: skip the dragged thing's whole subtree, or it climbs toward the camera
  const skipObj = skipId != null ? entities.get(skipId) : null;
  if (skipObj) hits = hits.filter((h) => { for (let o = h.object; o; o = o.parent) if (o === skipObj) return false; return true; });
  // a thing hidden in MY view still catches what I place: my private view must never shape a shared write
  if (hits.length) {
    const h = hits[0];
    // only near-horizontal faces are placement surfaces: a wall should not catch a chair
    const n = h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    if (!n || n.y > 0.6) return { point: h.point.clone(), onto: h.object.userData.entityId ?? null };
  }
  if (raycaster.ray.intersectPlane(groundPlane, _hit)) {
    // clamp to placeable range: a ray toward the horizon meets the ground plane hundreds of metres out
    const d = _hit.clone().sub(myState.pos); d.y = 0;
    const MAX = 20;
    if (d.length() > MAX) _hit.copy(myState.pos).addScaledVector(d.normalize(), MAX);
    return { point: new THREE.Vector3(_hit.x, heightAt(_hit.x, _hit.z), _hit.z), onto: null };
  }
  return null;
}

export function updateBuild() {
  updateSocketDrag();
  if (ghost) {
    const aim = aimPoint();
    if (aim) {
      ghost.obj.position.copy(aim.point);
      ghost.obj.rotation.y = ghost.yaw;
      ghost.obj.scale.setScalar(ghost.scale);
    }
  }
  if (dragging?.armed && selected) {
    const gesture = dragging.mode;   // the tool at the press: a tool key during the drag changes the next one, not this
    if (gesture === 'rotate') {
      // ~0.7° per px, drag right = clockwise from above: a turn about world UP composed on the full orientation
      _turn.setFromAxisAngle(_up, -(dragging.clientX - dragging.startX) * 0.012);
      selected.obj.quaternion.copy(_turn).multiply(dragging.startQuat);
      reindexCollider(selected.id); refreshOutline(); relayDrag();
    } else if (gesture === 'scale') {
      { const k = Math.exp((dragging.clientX - dragging.startX) * 0.006); const sc = selected.obj.scale.copy(dragging.startScale).multiplyScalar(k); sc.set(...sc.toArray().map((v) => THREE.MathUtils.clamp(v, 0.1, 12))); }   // keeps a stretched thing's proportions
      reindexCollider(selected.id); refreshOutline();
    } else if (dragging.vertical) {
      // screen-vertical pixels → world metres at the object's depth, so a drag feels the same near or far
      const fov = camera.fov * Math.PI / 180;
      const pxToWorld = (2 * dragging.depth * Math.tan(fov / 2)) / innerHeight;
      const dy = (dragging.startY - dragging.clientY) * pxToWorld;   // up = raise
      // no lower than any member's ground, each from its start; in a group, one already below it (the lead too) stays no
      // lower without lifting the lot
      let least = heightAt(dragging.startPos.x, dragging.startPos.z) - dragging.startPos.y;
      if (dragging.multi) least = Math.min(0, least);
      for (const f of dragging.multi?.followers ?? []) { _fp.setFromMatrixPosition(f.world); least = Math.max(least, Math.min(0, heightAt(_fp.x, _fp.z) - _fp.y)); }
      const y = dragging.startPos.y + Math.max(least, dy);
      if (dragging.world) setWorldPosition(selected.obj, _w.set(dragging.startPos.x, y, dragging.startPos.z));
      else selected.obj.position.set(dragging.startPos.x, y, dragging.startPos.z);
      reindexCollider(selected.id);
      refreshOutline();
      relayDrag();
    } else if (dragging.multi) {
      // a group slides in the lead's horizontal plane: one thing's surface under the pointer is not the others'
      raycaster.setFromCamera(mouse, camera);
      if (dragging.plane && raycaster.ray.intersectPlane(dragging.plane.at, _hit)) {
        setWorldPosition(selected.obj, _w.copy(_hit).add(dragging.plane.grab).setY(dragging.startPos.y));
        reindexCollider(selected.id); refreshOutline(); relayDrag();
      }
    } else {
      const aim = aimPoint(selected.id);
      if (aim) {
        // keep the grab offset (you grabbed a crate by its corner, not its pivot); `onto` (rarely set: aimPoint) rests it ON the face
        if (dragging.world) {
          // WORLD points; a mounted child's position is local to its parent, so the target enters that frame last
          _w.copy(aim.point).add(dragging.grab);
          if (aim.onto) _w.y = aim.point.y;
          setWorldPosition(selected.obj, _w);
        } else {
          selected.obj.position.copy(aim.point).add(dragging.grab);
          if (aim.onto) selected.obj.position.y = aim.point.y;
        }
        reindexCollider(selected.id);
        refreshOutline();
        relayDrag();
      }
    }
    if (dragging.multi) MM.apply(dragging.multi, gesture === 'rotate' ? 'rotate' : gesture === 'scale' ? 'scale' : 'move');
  }
}

const _w = new THREE.Vector3(), _fp = new THREE.Vector3();
globalThis.__buildDrag = () => (dragging ? { id: dragging.id, armed: dragging.armed, world: !!dragging.world, tool, follow: dragging.follow, skipped: dragging.skipped } : null);   // harness window (test/protocol/client-check.ts F, build-probe.ts MM)
/** Put an object at a WORLD position, whatever frame it is drawn in (a mounted child sits in its parent's). */
function setWorldPosition(obj, w) {
  const p = obj.parent;
  if (!p) { obj.position.copy(w); return; }
  p.updateWorldMatrix(true, false);
  obj.position.copy(p.worldToLocal(w.clone()));
}

// relay at pose cadence so others see it move, not teleport
function relayDrag() {
  const now = performance.now();
  if (now - (dragging.lastSent ?? 0) < MM.RELAY_MS) return;
  dragging.lastSent = now;
  const p = selected.obj.position; const q = selected.obj.quaternion;
  sendDrag(selected.id, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]);
}

// remote drags: applied transiently, no log involvement. A live drag is a CLAIM: while samples flow, `by` is editing
// `id` (an amber box, and the Hierarchy says 'editing: <name>'); it lapses on the last sample (`end`) or CLAIM_MS of silence.
const CLAIM_MS = MM.CLAIM_MS;   // one number with the group cap (edit/multimove.js MAX_GROUP)
const claims = new Map();   // id -> { by, at, box }
const claimBox = () => { const b = new THREE.Box3Helper(new THREE.Box3(), 0xe0a33a); b.userData.noCamCollide = true; scene.add(b); return b; };
function endClaim(id) { const c = claims.get(id); if (!c) return; claims.delete(id); c.box.removeFromParent(); bus.emit('claims', claimsNow()); }
/** Probe/Hierarchy surface: who is editing what right now, by id. */
export const claimsNow = () => Object.fromEntries([...claims].map(([id, c]) => [id, c.by]));
setInterval(() => { const now = performance.now(); for (const [id, c] of claims) if (now - c.at > CLAIM_MS) endClaim(id); }, 250);
bus.on('drag', ({ id, pos, yaw, q, scale, by, end }) => {
  const obj = entities.get(id);
  if (!obj) return;
  if (Array.isArray(pos) && pos.length === 3) obj.position.set(...pos);
  if (Array.isArray(scale) && scale.length === 3) obj.scale.set(...scale);   // a scrubbed size, previewed live
  if (Array.isArray(q) && q.length === 4) obj.quaternion.set(q[0], q[1], q[2], q[3]);   // the rotate gizmo's full turn
  else if (yaw != null) obj.rotation.y = yaw;
  reindexCollider(id);
  if (end) { endClaim(id); return; }
  if (typeof by === 'string' && by) { let c = claims.get(id); if (!c) { c = { by, at: 0, box: claimBox() }; claims.set(id, c); c.at = performance.now(); bus.emit('claims', claimsNow()); } c.at = performance.now(); c.by = by; c.box.box.setFromObject(obj); }
});
bus.on('snapshot-adopted', () => { for (const id of [...claims.keys()]) endClaim(id); });

// ============================================================ commits + undo


function commitSpawn() {
  const p = ghost.obj.position;
  const id = '$new';   // the authority mints its id; the reply's ids map says what it became
  // one request: create (a model, a mesh, a picture, a light, an empty)
  let sent;
  if (ghost.lib === '@empty') sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y, p.z] }, components: { label: 'empty' } })], { what: 'place an empty', expect: false });
  else if (meshOf(ghost.lib)) { const shape = meshOf(ghost.lib); const size = ghostMeshSize(shape, ghost.scale);
    sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)] }, components: { mesh: { shape, size }, label: shape } })], { what: `place a ${shape}`, expect: false }); }
  else if (pictureOf(ghost.lib)) sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)] }, components: { picture: { src: pictureOf(ghost.lib), width: +ghost.scale.toFixed(3) }, label: 'picture' } })], { what: 'hang a picture', expect: false });
  else if (ghost.lib === '@light') sent = Edits.sendOps([OP.create(id, { transform: { pos: [p.x, p.y + 0.9, p.z] }, components: { light: { ...LIGHT_DEFAULTS } } })], { what: 'place a light', expect: false });   // a touch off the floor: a hanging bulb
  else sent = Edits.sendOps([OP.create(id, { model: ghost.lib, transform: { pos: [p.x, p.y, p.z], q: [0, Math.sin(ghost.yaw / 2), 0, Math.cos(ghost.yaw / 2)], scale: ghost.scale } })], { what: `place ${libLabels.get(ghost.lib) ?? ghost.lib}`, expect: false });
  // what you just placed is the selection; it arrives a frame or two after the reply
  Promise.resolve(sent).then((r) => {
    if (!r?.ok) return;
    const pick = r.ids?.[id];
    if (pick) selectWhenHere(pick);
  });
  cancelGhost();
}
function selectWhenHere(id, ms = 3000) {
  const t0 = performance.now(), since = Sel.mark();
  const go = () => { if (entities.has(id)) { if (buildMode) Sel.setIfUnchanged(since, [id]); return; } if (performance.now() - t0 < ms) setTimeout(go, 60); };
  go();
}

// ---- lock: the `lock` component (writes.js lock) nails a thing down; the authority enforces it for everyone
function isLocked(id) { return !!bagOf(id)?.lock; }
function commitPlace(before, multi = null, gen = 0) {
  if (!selected) return;
  const o = selected.obj;
  // the drag was presence; the release is ONE request (the whole transform, local for a child), expecting where it started —
  // every follower's transform in the same batch: one act, one Ctrl+Z, one lock question for the lot
  const id = selected.id;
  const tf = (x, ob) => OP.setTransform(state.st.entities?.[x] ?? {}, x, { pos: [ob.position.x, ob.position.y, ob.position.z], q: ob.quaternion.toArray(), scale: scaleOf(ob) });
  const more = MM.ops(multi, (x, ob) => ({ ops: [tf(x, ob)] }));
  // a follower gone since the drag began: the lot goes back and nothing is written, as the gizmo's release does (bot #352 `1`)
  if (more.errors.length) { MM.revertHeld(gen, MM.idsOf(id, multi)); flashHint(more.errors.join(' · '), 5000); return; }
  const n = 1 + (multi?.followers.length ?? 0);
  Edits.sendOps([tf(id, o), ...more.ops],
    { what: n > 1 ? `move ${n} things` : `move ${id}`, base: { ...(before.comps ? { [id]: before.comps } : {}), ...more.base }, revert: () => MM.revertHeld(gen, MM.idsOf(id, multi)) });
}

const _up = new THREE.Vector3(0, 1, 0), _turn = new THREE.Quaternion(), _q = new THREE.Quaternion();
function snapshotOf(obj) {
  return { pos: [obj.position.x, obj.position.y, obj.position.z], yaw: new THREE.Euler().setFromQuaternion(obj.quaternion, 'YXZ').y, q: obj.quaternion.toArray(), scale: scaleOf(obj) };
}

export function undo() {
  // the authority's undo {act} of MY last act (it refuses what others changed since)
  deselect(); return Edits.undo();
}

// panels.js installs its remover here (it can't be imported: panels.js imports us): Del acts on every selected thing
let removeHook = null;
export function setRemoveHook(fn) { removeHook = fn; }
/** What the keys act on: the selection's primary thing. */
const keyTarget = () => primaryThing();
/** Edit ▸ delete: the same act as the Del key. */
export function removeKeyTargets() { if (keyTarget()) removeTargets(); }
function removeTargets() {
  if (removeHook) { if (removeHook()) deselect(); return; }
  removeSelected();
}

function removeSelected() {
  if (!selected) return;
  Edits.del([selected.id]); deselect();   // a locked thing: the authority asks ("This is locked. Delete anyway?")
}

// ============================================================ pointer

let barePress = null;
addEventListener('mouseup', (e) => {
  const p = barePress; barePress = null;
  if (!p || !buildMode || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
  // a click on empty space clears THE selection (the Hierarchy's too), not only the viewport's pick
  deselectAll(); if (socketSelected()) deselectSocket();
});
// BOX SELECT: Shift-drag on bare space draws a box and ADDS every thing whose centre lands inside it (hidden ones,
// and layers switched off for clicks, aren't caught). A plain bare drag still orbits.
let marquee = null; const _mc = new THREE.Vector3(), _mb = new THREE.Box3();
function marqueeMove(e) { if (!marquee) return; const x0 = Math.min(marquee.x, e.clientX), y0 = Math.min(marquee.y, e.clientY);
  Object.assign(marquee.el.style, { left: `${x0}px`, top: `${y0}px`, width: `${Math.abs(e.clientX - marquee.x)}px`, height: `${Math.abs(e.clientY - marquee.y)}px`, display: 'block' }); }
function marqueeEnd(e) { const m = marquee; marquee = null; if (!m) return; m.el.remove(); removeEventListener('mousemove', marqueeMove); removeEventListener('mouseup', marqueeEnd);
  if (Math.hypot(e.clientX - m.x, e.clientY - m.y) < 5) return;
  const x0 = Math.min(m.x, e.clientX), x1 = Math.max(m.x, e.clientX), y0 = Math.min(m.y, e.clientY), y1 = Math.max(m.y, e.clientY); const ids = [];
  const W = state.st?.entities ?? {};
  for (const [id, o] of entities) { if (!o || !o.visible || outOfMyView(o) || !clickable(W, id)) continue; _mb.setFromObject(o); if (_mb.isEmpty()) continue;
    _mb.getCenter(_mc).project(camera); if (_mc.z > 1) continue;
    const sx = (_mc.x + 1) / 2 * innerWidth, sy = (1 - _mc.y) / 2 * innerHeight; if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) ids.push(id); }
  if (ids.length) bus.emit('edit-select-add', ids); }

/** The nearest hit under a viewport point (NDC) on a thing MY selection layers let me click (selectmask.js; the floor is
 *  'environment', off at first) and that is in my view (a thing hidden with the eye is not drawn, so not clicked). */
function pickHit(nx, ny) {
  mouse.set(nx, ny);
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const o of entities.values()) if (o) targets.push(o);
  const W = state.st?.entities ?? {};   // the editor's world view (lib, comp, parent), as panels.js reads it
  return raycaster.intersectObjects(targets, true).find((h) => { let r = h.object; while (r && !r.userData.entityId) r = r.parent; return r && clickable(W, r.userData.entityId) && !outOfMyView(h.object); }) ?? null;
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !buildMode) return;  // outside build mode the canvas is for looking
  if (e.altKey) return;   // Alt+drag is the camera's (controller.js: orbit / pan / dolly)   // keys: editCamera
  // an armed seat placement outranks everything, the ghost included
  if (socketArmed()) { socketMouseDown(e); e.preventDefault(); return; }
  if (ghost) return;                        // click-to-place handled on click
  // seat gizmos pick next: the mesh a marker floats over would otherwise win every contested click
  if (socketMouseDown(e)) { e.preventDefault(); return; }
  if (pointerVeto()) return;                // a gizmo handle under the pointer owns this press
  // pick from THIS event's coordinates: a press without a move first (a touch, a synthetic click) leaves `mouse` stale
  const hit = pickHit((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  // a press on nothing: a DRAG from here orbits the camera; only a click that didn't travel deselects
  if (!hit && e.shiftKey) { const d = document.createElement('div');   // keys: selectExtend
    d.className = 'edit-marquee'; d.style.display = 'none'; document.body.append(d);
    marquee = { x: e.clientX, y: e.clientY, el: d }; addEventListener('mousemove', marqueeMove); addEventListener('mouseup', marqueeEnd); e.preventDefault(); return; }
  if (!hit) { barePress = { x: e.clientX, y: e.clientY }; bus.emit('edit-bare-press'); return; }
  if (socketSelected()) deselectSocket();
  let root = hit.object;
  while (root && !root.userData.entityId) root = root.parent;
  if (!root) return;
  const id = root.userData.entityId;
  // Ctrl-click EXTENDS the selection (panels.js); no drag starts from an extend
  if (e.ctrlKey || e.metaKey) { bus.emit('edit-extend', id); e.preventDefault(); return; }   // keys: selectExtend
  // Shift: a click adds it to (or takes it from) the selection, as in the tree; a Shift press that TRAVELS is
  // still the vertical drag, so the thing is selected only once it starts to move
  const shiftPick = e.shiftKey && !!primaryThing() && primaryThing() !== id;   // keys: selectExtend
  // a press on a thing that is already one of SEVERAL selected keeps them all (Unity, Blender: grab one, the lot moves): it
  // leads, so it goes first; a click that never travels still selects just it (on release)
  const s0 = Sel.selection();
  const keepMany = !shiftPick && s0.kind === 'things' && s0.ids.length > 1 && s0.ids.includes(id);
  if (keepMany) { Sel.set([id, ...s0.ids.filter((x) => x !== id)], 'things', Sel.active()); showInspector(id); }
  else if (!shiftPick) select(id);
  // the things that will move with it (none under the pivot tool, whose mesh drag drags one thing, never a group)
  const many = s0.kind === 'things' && s0.ids.length > 1 && s0.ids.includes(id) ? s0.ids : null;
  const fol = many && tool !== 'pivot' ? MM.followersOf(id, (x) => MM.takes(x, tool)) : { ids: [], skipped: [] };
  // a press is a SELECT; it becomes a drag once the pointer travels (DRAG_SLOP)
  const aim = aimPoint(id);
  // the drag reckons in WORLD space (a mounted child's object position is in its parent's frame)
  const world = true;
  const at = root.getWorldPosition(new THREE.Vector3());
  dragging = {
    id,
    world,
    // the components this gesture starts from: the release's `expect`
    before: { ...snapshotOf(root), comps: Edits.compsOf(id) },
    lastSent: 0,
    armed: false,
    startX: e.clientX,
    startY: e.clientY,
    clientY: e.clientY,
    // Shift held at grab = a VERTICAL drag: the pointer's up/down maps to world Y, horizontal position pinned
    vertical: e.shiftKey,   // keys: meshMove
    shiftPick,
    keepMany,
    // a Shift-travel on one of several selected things is a vertical drag of the lot, led by it (a Shift click still toggles it)
    many,
    follow: fol.ids, skipped: fol.skipped.length,
    multi: null,   // edit/multimove.js: the followers' start, once it arms
    clientX: e.clientX,
    startYaw: root.rotation.y,
    startQuat: root.quaternion.clone(),
    startScale: root.scale.clone(),
    startPos: at,
    depth: camera.position.distanceTo(at),
    grab: aim ? at.clone().sub(aim.point) : new THREE.Vector3(),
    plane: fol.ids.length ? planeGrab(at) : null,   // a group's drag is planar (updateBuild)
    mode: tool,     // the gesture, fixed here with the followers it picked
  };
  e.preventDefault();
});

/** The horizontal plane through `at` and the offset from where the pointer's ray meets it, or null (a ray along it or
 *  pointing away from it). */
function planeGrab(at) {
  raycaster.setFromCamera(mouse, camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -at.y);
  return raycaster.ray.intersectPlane(plane, _hit) ? { at: plane, grab: at.clone().sub(_hit).setY(0) } : null;
}

// arm the drag only after a few pixels of travel (click vs drag)
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  dragging.clientY = e.clientY;                 // vertical drag reads this each frame
  dragging.clientX = e.clientX;                 // rotate/scale tools read this one
  if (dragging.mode === 'select') return;       // a press under select picks, travel never moves
  if (!dragging.armed
      && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > DRAG_SLOP) {
    // the press selected it; travel is where a move begins, unless the group is over the cap: then nothing moves
    if (1 + dragging.follow.length > MM.MAX_GROUP) { flashHint(MM.tooManyHint(1 + dragging.follow.length), 6000); dragging = null; return; }
    dragging.armed = true;
    if (dragging.shiftPick) {
      if (dragging.many) { Sel.set([dragging.id, ...dragging.many.filter((x) => x !== dragging.id)], 'things', Sel.active()); showInspector(dragging.id); }
      else select(dragging.id);
      dragging.shiftPick = false;
    }
    // the press's thing must still be the selected one: a selection changed under a press not yet armed (a reply selecting what
    // it placed, the Hierarchy) drops the press, as a change mid-drag cancels the drag; nothing has moved yet (bot #352 `4`)
    if (selected?.id !== dragging.id) { dragging = null; return; }
    dragging.multi = MM.begin(dragging.id, dragging.follow);
    dragging.gen = MM.hold(MM.idsOf(dragging.id, dragging.multi));   // a late refusal of an older drag leaves these to this one
    if (dragging.skipped) flashHint(MM.skippedHint(dragging.skipped, dragging.mode), 3500);
    engage('meshMove');
  }
});

addEventListener('mouseup', () => {
  if (dragging && !dragging.armed && dragging.shiftPick) bus.emit('edit-extend', dragging.id);
  if (dragging && !dragging.armed && dragging.keepMany) select(dragging.id);   // a click, not a drag: just it
  if (dragging?.armed) release();
  if (dragging?.armed && selected) {
    const moved = dragging.before;
    const o = selected.obj;
    const same = Math.abs(o.position.x - moved.pos[0]) < 0.005
      && Math.abs(o.position.y - moved.pos[1]) < 0.005
      && Math.abs(o.position.z - moved.pos[2]) < 0.005
      && o.quaternion.angleTo(_q.fromArray(moved.q)) < 1e-4
      && JSON.stringify(scaleOf(o)) === JSON.stringify(moved.scale);
    if (!same) commitPlace(moved, dragging.multi, dragging.gen);   // release commits ONE clean entry (the followers in it)
    // nothing to write, but this drag took its things from any older gesture's refusal still in flight: it puts them back
    // where the log has them, as that refusal would have (a follower nudged under 5 mm with them) (#352 review, Fable)
    else MM.revertHeld(dragging.gen, MM.idsOf(dragging.id, dragging.multi));
  }
  // the last sample says so: others drop the claim at once rather than after CLAIM_MS (a group's: MM.end, the lead's with it)
  if (dragging?.multi) MM.end(dragging.multi);
  else if (dragging?.armed) { const o = entities.get(dragging.id); if (o) sendDrag(dragging.id, o.position.toArray(), new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y, o.quaternion.toArray(), { end: true }); }
  dragging = null;
});

canvas.addEventListener('click', (e) => {
  if (!ghost || !buildMode) return;
  commitSpawn();
  e.preventDefault();
});

// ============================================================ keys

// Esc hooks (gizmo.js, gripedit.js): tried newest first; the first that takes it ends it
const escapeHooks = [];
const escapeHook = () => escapeHooks.some((f) => f());
export function setEscapeHook(fn) { escapeHooks.unshift(fn); }
bus.on('key', (e) => {
  if (e.code === 'Escape') {
    // Esc during a drag cancels it and writes nothing; the thing goes back to where the log has it
    if (dragging?.armed && cancelDrag()) return;
    if (escapeHook()) return;
    if (structureTool()) setStructureTool(null);   // an armed building tool drops first (the viewport strip says "Esc to drop")
    else if (cancelSocketArm()) { /* an armed placement is the most transient state */ }
    else if (ghost) cancelGhost();
    else if (socketSelected()) deselectSocket();
    else if (primaryThing()) deselectAll();
    else if (buildMode) setBuildMode(false);
    return;
  }
  // undo stays available outside build mode; redo is Ctrl+Shift+Z or Ctrl+Y
  if ((e.ctrlKey || e.metaKey) && ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY')) {   // keys: undo
    e.preventDefault?.(); Edits.redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }   // keys: undo
  if (!buildMode) return;

  // reset the selection's transform (panels.js resetTransform): the tools' own letters with Alt, and Ctrl+G for all
  // three. Checked first: socketKeyDown below takes every key while a seat is selected.
  if (e.altKey && !e.ctrlKey && !e.metaKey && ['KeyG', 'KeyE', 'KeyR'].includes(e.code)) { e.preventDefault(); bus.emit('edit-reset', { KeyG: 'pos', KeyE: 'rot', KeyR: 'scale' }[e.code]); return; }   // keys: resetTransform
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyG') { e.preventDefault(); bus.emit('edit-reset', 'all'); return; }   // keys: resetTransform
  // the thing in hand holds Q / E and , / . before the tools do (they'd switch tool mid-aim)
  if (ghostKey(e)) return;
  // a selected seat anchor holds the editing keys before things do
  if (socketKeyDown(e)) return;
  // tool keys, every one OFF the walking set (WASD walks): Q select, G move, E rotate, R scale, P pivot, F find, X removes
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {   // keys: toolKeys
    const t = { KeyQ: 'select', KeyG: 'move', KeyE: 'rotate', KeyR: 'scale', KeyP: 'pivot' }[e.code];   // P: the pivot (Maya's D; D walks here)
    if (t) {   // the active tool's key again steps its space (G G: move in the thing's own axes), saying so
      if (t === getTool() && SPACES[t]?.length > 1) { const s = cycleSpace(t); flashHint(html`${t} in <b>${s}</b> axes · ${{ move: 'G', rotate: 'E' }[t]} again to switch`, 2200); return; }
      setTool(t); return;
    }
    if (e.code === 'KeyF' && keyTarget()) { bus.emit('edit-find', keyTarget()); return; }
    if (e.code === 'KeyX' && keyTarget()) { removeTargets(); return; }
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && keyTarget()) { e.preventDefault?.(); removeTargets(); }
});
