// build — the human's authoring surface.
//
// Before this, a person could ADD to a world and never move, correct, or
// unmake anything in it: `place` and `remove` were server-allowed and agent-
// reachable, but there was no UI for either, so every misplacement was
// permanent and there was no undo. Agents had a richer verb surface than
// people. That is what this module fixes.
//
// Placement helpers are the drag semantics, per DESIGN.md: the ghost lands ON
// the table rather than beside it, because the collider tops that already
// compute walkable ground are the same data as "what can I put things on".

import { THREE, scene, camera, canvas, CONFIG, report, bus } from './core.js';
import { loadGLB, libLabels, listLibrary } from './assets.js';
import { makeLightGizmo } from './lights.js';
import { entities, entityMeta, comps, findPart } from './world.js';
import { surfaceUnder, reindexCollider } from './colliders.js';
import { heightAt, GRASS_QUALITY, getGrassQuality, setGrassQuality,
  getGrassDensity, getGrassShed } from './terrain.js';
import { sendVerb, sendDrag } from './net.js';
import { myState, mouse, setPointerClaim, setEditingProbe } from './controller.js';
import { makeSection, toast, flashHint, collapseAll, panelFrame } from './ui.js';
import { sceneSelect } from './scenegraph.js';
import { previewSky, skyArgs, WEATHERS, CLOUDS, SKY_WORLDS,
  CLOUD_QUALITY, getCloudQuality, setCloudQuality } from './sky.js';

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _hit = new THREE.Vector3();

// The starter vocabulary. Everything else arrives through the catalog or an
// `asset` verb, so this list is a doorway, not a limit.
const STARTER = [
  ['crate (red)', 'eidoverse/assets/models/crate_large_red.glb'],
  ['crate (blue)', 'eidoverse/assets/models/crate_large_blue.glb'],
  ['palm tree', 'eidoverse/assets/models/palm_date_tree_tropical_deseert_oasis_plant.glb'],
  ['joshua tree', 'eidoverse/assets/models/stylized_yucca_joshua_tree_desert_cactus_plant.glb'],
  ['streetlight', 'eidoverse/assets/models/streetlight_lamp_light_street_blade_runner_cyberpunk.glb'],
  ['deco desk', 'eidoverse/assets/models/scifi_art_deco_office_desk.glb'],
  ['retro computer', 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb'],
  ['barrels', 'eidoverse/assets/models/scifi_barrels_group_of_four.glb'],
];

// ============================================================ state

let ghost = null;         // { obj, lib, yaw, scale } — a thing not yet placed
let selected = null;      // { id, obj, box } — a placed thing under edit
let dragging = null;      // { id, offset, plane } while moving a selection
const undoStack = [];     // inverse entries, newest last

// Editing is a MODE.
//
// It was always-live, on the theory that "select anything, any time" is closer
// to the one-verb-surface ideal. In a world you look around by dragging, that
// theory is wrong: every camera drag that happens to start on an object picks
// it up and moves it, and the world quietly rearranges itself while you are
// just trying to see. Looking is the default; editing is something you say you
// are doing.
let editMode = false;
export const isEditing = () => editMode;

export function setEditMode(on, { quiet = false } = {}) {
  if (editMode === on) return editMode;
  editMode = on;
  document.body.classList.toggle('edit-mode', on);
  if (!on) { cancelGhost(); deselect(); seatArm = null; deselectSeat(); }
  refreshSeatGizmos();   // anchors are visible exactly while you are editing
  // Saying you are building should put the tools in front of you — B is now
  // the mode, so the catalog needs to arrive with it rather than behind a
  // separate keystroke nobody will guess.
  if (on) panelFrame().show();
  if (!quiet) {
    flashHint(on
      ? 'edit mode — click to select · drag to move · <b>build</b> for the catalog · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Esc</kbd> to leave'
      : 'looking again');
  }
  bus.emit('edit-mode', on);
  return editMode;
}
export const toggleEditMode = () => setEditMode(!editMode);

export const hasGhost = () => ghost !== null;
export const hasSelection = () => selected !== null;
setPointerClaim(() => ghost !== null || !!dragging?.armed);
setEditingProbe(() => editMode);

// ============================================================ selection

const outline = new THREE.Box3Helper(new THREE.Box3(), 0x8fe8c8);
outline.visible = false;
outline.userData.noCamCollide = true;
scene.add(outline);

let inspector = null;
function showInspector(id) {
  const meta = entityMeta.get(id) ?? {};
  if (!inspector) {
    inspector = document.createElement('div');
    inspector.className = 'panel';
    inspector.style.cssText = `position:fixed; left:50%; bottom:64px; transform:translateX(-50%);
      z-index:7; padding:9px 13px; font-size:var(--fs-sm); display:flex; gap:14px; align-items:center;`;
    document.body.appendChild(inspector);
  }
  const label = libLabels.get(meta.lib) ?? meta.lib?.split('/').pop()?.replace(/\.glb$/, '') ?? id;
  const locked = isLocked(id);
  inspector.innerHTML =
    `<span><b>${label.slice(0, 34)}</b></span>` +
    `<span style="color:var(--dim)">by ${meta.actor ?? '?'}</span>` +
    (locked
      ? `<span style="color:var(--dim)">🔒 locked — nothing moves or removes it until unchecked</span>`
      : `<span style="color:var(--dim)">drag move · <kbd>Shift</kbd>+drag or <kbd>R</kbd><kbd>F</kbd> up/down · ` +
        `<kbd>Q</kbd><kbd>E</kbd> turn · <kbd>,</kbd><kbd>.</kbd> size · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`) +
    `<label title="nail it down: while locked, nobody's drags, verbs or scripts can move, replace or remove it (server-enforced) — sitting on it and content edits stay open" style="display:flex;gap:4px;align-items:center;cursor:pointer">` +
    `<input type="checkbox" data-bact="lock"${locked ? ' checked' : ''}> 🔒 lock</label>` +
    `<button data-bact="seat" title="declare a sit anchor: click the spot where a sitter goes">+ seat</button>`;
  inspector.querySelector('[data-bact="lock"]').onchange = (ev) => {
    const on = ev.target.checked;
    sendVerb('comp', { id, type: 'lock', data: on ? true : null });
    flashHint(on ? `🔒 <b>${label.slice(0, 34)}</b> locked — nothing moves it until you uncheck` : `🔓 unlocked`);
    // the echo folds the comp; repaint the hint line once it lands
    setTimeout(() => { if (selected?.id === id) showInspector(id); }, 400);
  };
  inspector.querySelector('[data-bact="seat"]').onclick = () => armSeatPlacement(selected?.id ?? id);
  inspector.style.display = 'flex';
}
function hideInspector() { if (inspector) inspector.style.display = 'none'; }

export function select(id) {
  const obj = entities.get(id);
  if (!obj) return;
  selected = { id, obj };
  outline.box.setFromObject(obj);
  outline.visible = true;
  showInspector(id);
  // the scene panel follows the mouse: selecting a thing opens its row —
  // transform fields, semantic editors, comp bag — scrolled into view
  sceneSelect(id);
}
export function deselect() {
  selected = null;
  dragging = null;
  outline.visible = false;
  hideInspector();
}
function refreshOutline() {
  if (selected) outline.box.setFromObject(selected.obj);
}

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

export async function holdGhost(lib, label) {
  setEditMode(true, { quiet: true });   // choosing a thing to place is intent enough
  cancelGhost();
  deselect();
  try {
    let obj;
    if (lib === '@light') {
      obj = makeLightGizmo(0xffd9a0);
      obj.traverse((o) => { if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.7; } });
    } else {
      obj = await loadGLB(lib);
      ghostify(obj);
    }
    ghost = { obj, lib, yaw: 0, scale: 1 };
    scene.add(obj);
    collapseAll();
    flashHint(lib === '@light'
      ? 'placing a <b>light</b> — click to place · <kbd>Esc</kbd> cancel'
      : `placing <b>${label ?? ''}</b> — click to place · <kbd>Q</kbd><kbd>E</kbd> turn · <kbd>,</kbd><kbd>.</kbd> size · <kbd>Esc</kbd> cancel`, 6000);
  } catch (e) { report('ghost', e); }
}

export function cancelGhost() {
  if (ghost) { scene.remove(ghost.obj); ghost = null; }
}

/** Where the pointer is aiming, snapped onto whatever surface is under it.
 *  Raycasting real entities first is what turns "drops at y=0 beside the
 *  table" into "lands on the table". */
function aimPoint(skipId = null) {
  raycaster.setFromCamera(mouse, camera);
  const targets = [];
  for (const [id, o] of entities) if (o && id !== skipId) targets.push(o);
  const hits = raycaster.intersectObjects(targets, true);
  if (hits.length) {
    const h = hits[0];
    // only treat near-horizontal faces as placement surfaces — a wall should
    // not catch a chair
    const n = h.face?.normal ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
    if (!n || n.y > 0.6) return { point: h.point.clone(), onto: h.object.userData.entityId ?? null };
  }
  if (raycaster.ray.intersectPlane(groundPlane, _hit)) {
    // clamp to placeable range — a ray toward the horizon meets the ground
    // plane hundreds of metres out
    const d = _hit.clone().sub(myState.pos); d.y = 0;
    const MAX = 20;
    if (d.length() > MAX) _hit.copy(myState.pos).addScaledVector(d.normalize(), MAX);
    return { point: new THREE.Vector3(_hit.x, heightAt(_hit.x, _hit.z), _hit.z), onto: null };
  }
  return null;
}

export function updateBuild() {
  updateSeatDrag();
  if (ghost) {
    const aim = aimPoint();
    if (aim) {
      ghost.obj.position.copy(aim.point);
      ghost.obj.rotation.y = ghost.yaw;
      ghost.obj.scale.setScalar(ghost.scale);
    }
  }
  if (dragging?.armed && selected) {
    if (dragging.vertical) {
      // map screen-vertical pixels to world metres at the object's depth, so a
      // drag feels the same whether the thing is near or far
      const fov = camera.fov * Math.PI / 180;
      const pxToWorld = (2 * dragging.depth * Math.tan(fov / 2)) / innerHeight;
      const dy = (dragging.startY - dragging.clientY) * pxToWorld;   // up = raise
      const floor = heightAt(dragging.startPos.x, dragging.startPos.z);
      const y = Math.max(floor, dragging.startPos.y + dy);
      selected.obj.position.set(dragging.startPos.x, y, dragging.startPos.z);
      reindexCollider(selected.id);
      refreshOutline();
      relayDrag();
    } else {
      const aim = aimPoint(selected.id);
      if (aim) {
        // Keep the grab offset. Without it the object teleports so that its
        // ORIGIN sits under the cursor, which is both a jump and usually wrong —
        // you grabbed a crate by its corner, not by its pivot.
        selected.obj.position.copy(aim.point).add(dragging.grab);
        // dropping onto a surface should still rest ON it, not float by the
        // offset you happened to grab at
        if (aim.onto) selected.obj.position.y = aim.point.y;
        reindexCollider(selected.id);
        refreshOutline();
        relayDrag();
      }
    }
  }
}

// relay at pose cadence so others see it move, not teleport
function relayDrag() {
  const now = performance.now();
  if (now - (dragging.lastSent ?? 0) < 66) return;
  dragging.lastSent = now;
  const p = selected.obj.position;
  sendDrag(selected.id, [p.x, p.y, p.z], selected.obj.rotation.y);
}

// remote drags: apply transiently, no log involvement
bus.on('drag', ({ id, pos, yaw }) => {
  const obj = entities.get(id);
  if (!obj) return;
  obj.position.set(...pos);
  if (yaw != null) obj.rotation.y = yaw;
  reindexCollider(id);
});

// ============================================================ commits + undo

function pushUndo(inverse, describe) {
  undoStack.push({ inverse, describe });
  while (undoStack.length > 40) undoStack.shift();
}

function commitSpawn() {
  const p = ghost.obj.position;
  const id = crypto.randomUUID().slice(0, 8);
  if (ghost.lib === '@light') {
    // lift a placed light off the floor a touch so it reads as a hanging bulb
    sendVerb('light', { id, pos: [p.x, p.y + 0.9, p.z], color: 0xffd9a0, intensity: 16, range: 10 });
    pushUndo({ verb: 'remove', args: { id } }, 'light');
    cancelGhost();
    return;
  }
  sendVerb('spawn', {
    id, lib: ghost.lib,
    pos: [p.x, p.y, p.z], yaw: ghost.yaw,
    ...(ghost.scale !== 1 ? { scale: ghost.scale } : {}),
  });
  pushUndo({ verb: 'remove', args: { id } }, 'spawn');
  cancelGhost();
}

// ---- lock: `comp {id, type: "lock", data: true}` nails a thing down. The
// SERVER is the enforcement (it refuses place/remove/punt/mount/spawn/light
// on a locked id for everyone, locker included); these guards keep the local
// gesture honest — no preview that would have to snap back on refusal, and a
// hint that teaches the unlock instead of a silent dead hand.
function isLocked(id) { return !!comps.get(id)?.lock; }
function lockedHint(id) {
  if (!isLocked(id)) return false;
  flashHint('🔒 <b>locked</b> — uncheck <b>lock</b> in the inspector to move or remove it');
  return true;
}

function commitPlace(before) {
  if (!selected) return;
  if (lockedHint(selected.id)) {
    // the world never moved — put the local preview back where the log says
    const o = selected.obj;
    o.position.set(...before.pos); o.rotation.y = before.yaw; o.scale.setScalar(before.scale);
    reindexCollider(selected.id); refreshOutline();
    return;
  }
  const o = selected.obj;
  sendVerb('place', {
    id: selected.id,
    pos: [o.position.x, o.position.y, o.position.z],
    yaw: o.rotation.y,
    scale: o.scale.x,
  });
  pushUndo({ verb: 'place', args: { id: selected.id, ...before } }, 'move');
}

function snapshotOf(obj) {
  return { pos: [obj.position.x, obj.position.y, obj.position.z], yaw: obj.rotation.y, scale: obj.scale.x };
}

export function undo() {
  const step = undoStack.pop();
  if (!step) { flashHint('nothing to undo'); return; }
  // Undo is inverse ENTRIES — history stays append-only, which is what keeps
  // the log replayable and the world forkable.
  sendVerb(step.inverse.verb, step.inverse.args);
  flashHint(`undid ${step.describe}`);
  deselect();
}

function removeSelected() {
  if (!selected) return;
  if (lockedHint(selected.id)) return;   // an accidental Del is the worst accident
  const meta = entityMeta.get(selected.id) ?? {};
  const snap = snapshotOf(selected.obj);
  sendVerb('remove', { id: selected.id });
  pushUndo({ verb: 'spawn', args: { id: selected.id, lib: meta.lib, ...snap } }, 'removal');
  deselect();
}

// ============================================================ seat anchors
// Sit anchors (the `sockets` component) get the same editing grammar as
// things: visible in edit mode as gold gizmos, click to select, drag to
// refine, Q/E to face, Del to remove, one undoable log entry per commit.
// Zero server involvement — this is all authoring UI over the comp verb.

const seatGizmos = new Map();   // "id slot" -> gizmo (child of entity root)
let seatSel = null;             // { id, slot } — the anchor under edit
let seatDrag = null;            // { armed, startX, startY, pending } drag state
let seatArm = null;             // entity id waiting for a placement click

function makeSeatGizmo() {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xf5c96b, depthTest: false, transparent: true, opacity: 0.9 });
  const seat = new THREE.Mesh(new THREE.OctahedronGeometry(0.07), mat);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.12, 6), mat);
  nose.position.set(0, 0, 0.16);
  nose.rotation.x = Math.PI / 2;              // the arrow is the sit-facing
  g.add(seat, nose);
  // markers are pointed at, never raycast INTO — picking is ray-to-point, so
  // these meshes must not catch the placement/selection rays around them
  g.traverse((o) => { o.raycast = () => {}; o.renderOrder = 9; o.userData.noCamCollide = true; });
  return g;
}

/** Rebuild all markers from the comps map. Parented to the entity ROOT in
 *  model frame — the anchor's rest spot, matching socketWorldPos semantics
 *  (reach never oscillates with a part's motion, neither should the gizmo). */
function refreshSeatGizmos() {
  for (const [k, g] of seatGizmos) { g.parent?.remove(g); seatGizmos.delete(k); }
  if (!editMode) return;
  for (const [id, bag] of comps) {
    if (!bag.sockets) continue;
    const root = entities.get(id);
    if (!root) continue;
    for (const [slot, sock] of Object.entries(bag.sockets)) {
      const g = makeSeatGizmo();
      g.position.set(...(sock.pos ?? [0, 0.5, 0]));
      g.rotation.y = sock.yaw ?? 0;
      root.add(g);
      seatGizmos.set(`${id} ${slot}`, g);
    }
  }
  if (seatSel && !seatGizmos.has(`${seatSel.id} ${seatSel.slot}`)) deselectSeat();
  else refreshSeatHighlight();
}
bus.on('comp', ({ type }) => { if (type === 'sockets') refreshSeatGizmos(); });
bus.on('entity', () => { if (editMode) refreshSeatGizmos(); });

function refreshSeatHighlight() {
  for (const [k, g] of seatGizmos) {
    const on = seatSel && k === `${seatSel.id} ${seatSel.slot}`;
    g.scale.setScalar(on ? 1.6 : 1);
    g.traverse((o) => o.material?.color.setHex(on ? 0x8fe8c8 : 0xf5c96b));
  }
}

/** Ray-to-point picking, the bodydrag-joint trick: a 7cm marker against a
 *  busy mesh is unhittable by triangle raycast and trivially hittable by
 *  distance-to-center. Tolerance grows a little with camera distance. */
const _spV = new THREE.Vector3();
function pickSeat(ray) {
  let best = null, bestD = Infinity;
  for (const [k, g] of seatGizmos) {
    g.getWorldPosition(_spV);
    const tol = Math.min(0.3, 0.06 + camera.position.distanceTo(_spV) * 0.015);
    const d = ray.distanceToPoint(_spV);
    if (d < tol && d < bestD) { bestD = d; best = k; }
  }
  if (!best) return null;
  const [id, slot] = best.split(' ');
  return { id, slot };
}

function selectSeat(pick) {
  deselect();                              // a seat and a thing never co-hold the keys
  seatSel = pick;
  refreshSeatHighlight();
  if (!inspector) showInspector(pick.id);  // ensure the bar exists
  const meta = entityMeta.get(pick.id) ?? {};
  const label = libLabels.get(meta.lib) ?? meta.lib?.split('/').pop()?.replace(/\.glb$/, '') ?? pick.id;
  inspector.innerHTML =
    `<span><b>${pick.slot}</b> anchor on <b>${label.slice(0, 24)}</b></span>` +
    `<span style="color:var(--dim)">drag move · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`;
  inspector.style.display = 'flex';
}
function deselectSeat() {
  seatSel = null; seatDrag = null;
  refreshSeatHighlight();
  hideInspector();
}

function socketsOf(id) { return structuredClone(comps.get(id)?.sockets ?? {}); }

/** One merged comp entry per gesture, with its inverse on the undo stack —
 *  merged, because comp data replaces wholesale and a naive write would
 *  silently eat every OTHER anchor on the thing. */
function commitSockets(id, next, describe) {
  const before = comps.get(id)?.sockets;
  sendVerb('comp', { id, type: 'sockets', data: Object.keys(next).length ? next : null });
  pushUndo({ verb: 'comp', args: { id, type: 'sockets', data: before ? structuredClone(before) : null } }, describe);
}

const _saM = new THREE.Matrix4();
const _saM2 = new THREE.Matrix4();
const _saQ = new THREE.Quaternion();
const _saV = new THREE.Vector3();
function worldYawOf(root) {
  root.getWorldQuaternion(_saQ);
  _saV.set(0, 0, 1).applyQuaternion(_saQ);
  return Math.atan2(_saV.x, _saV.z);
}

/** The name of the motion-animated part the hit landed in, if any — that is
 *  the `part` that makes an anchor RIDE. Only parts a motion comp actually
 *  names count: naming arbitrary mesh nodes would freeze junk into the log. */
function partUnderHit(id, hitObj) {
  const bag = comps.get(id) ?? {};
  const names = new Set();
  for (const key in bag) {
    if (key.startsWith('motion:')) names.add(key.slice(7));
    else if (key === 'motion' && typeof bag[key]?.part === 'string') names.add(bag[key].part);
  }
  if (!names.size) return null;
  for (let o = hitObj; o && !o.userData.entityId; o = o.parent) if (names.has(o.name)) return o.name;
  return null;
}

/** A click on a plank MID-SWING must not bake the swing's phase into the
 *  anchor: carry the hit point back through the part's displacement to where
 *  it sits at rest (the inverse of mountTransform's ride). */
function unrideHitPoint(root, partName, wp) {
  const part = partName ? findPart(root, partName) : null;
  const b = part?.userData?.mbase;
  if (!part || !part.parent || !b) return wp;
  part.updateWorldMatrix(true, false);
  _saM.compose(_saV.set(...b.pos), _saQ.fromArray(b.quat), part.scale)
    .premultiply(part.parent.matrixWorld);                  // part-at-rest → world
  return wp.applyMatrix4(_saM2.copy(part.matrixWorld).invert()).applyMatrix4(_saM);
}

const round3 = (n) => +n.toFixed(3);
function seatFromHit(id, root, hit) {
  const part = partUnderHit(id, hit.object);
  const wp = unrideHitPoint(root, part, hit.point.clone());
  root.updateWorldMatrix(true, false);
  const mp = wp.applyMatrix4(_saM2.copy(root.matrixWorld).invert());   // world → model frame
  return { pos: [round3(mp.x), round3(mp.y), round3(mp.z)], part };
}

export function armSeatPlacement(id) {
  if (!id || !entities.get(id)) return;
  setEditMode(true, { quiet: true });
  seatArm = id;
  flashHint('click the spot where a sitter goes — the arrow will face you · <kbd>Esc</kbd> cancels', 8000);
}

function placeSeatAt(e) {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const id = seatArm;
  const root = entities.get(id);
  if (!root) { seatArm = null; return; }
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) { flashHint('that missed the thing — click ON it, or <kbd>Esc</kbd>'); return; }
  seatArm = null;
  const { pos, part } = seatFromHit(id, root, hit);
  // face the declarer: you are looking at the seat from where a sitter's
  // knees would point. Q/E refines from there.
  const yaw = +(Math.atan2(camera.position.x - hit.point.x, camera.position.z - hit.point.z) - worldYawOf(root)).toFixed(3);
  const sockets = socketsOf(id);
  let slot = 'seat', n = 2;
  while (sockets[slot]) slot = `seat${n++}`;
  sockets[slot] = { pos, yaw, ...(part ? { part } : {}) };
  commitSockets(id, sockets, 'seat anchor');
  selectSeat({ id, slot });      // the comp echo builds the gizmo already selected
  flashHint(`<b>${slot}</b> declared${part ? ' (rides ' + part + ')' : ''} — drag refines · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> removes`);
}

/** Called each frame from updateBuild while a seat drag is armed: the anchor
 *  slides along ITS OWN entity's surfaces — it cannot fall off the thing. */
function updateSeatDrag() {
  if (!seatDrag?.armed || !seatSel) return;
  raycaster.setFromCamera(mouse, camera);
  const root = entities.get(seatSel.id);
  if (!root) return;
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) return;
  const next = seatFromHit(seatSel.id, root, hit);
  seatDrag.pending = next;
  const g = seatGizmos.get(`${seatSel.id} ${seatSel.slot}`);
  if (g) g.position.set(...next.pos);
}

function commitSeatDrag() {
  if (!seatDrag?.pending || !seatSel) return;
  const sockets = socketsOf(seatSel.id);
  const cur = sockets[seatSel.slot] ?? {};
  sockets[seatSel.slot] = { ...cur, pos: seatDrag.pending.pos,
    ...(seatDrag.pending.part ? { part: seatDrag.pending.part } : {}) };
  if (!seatDrag.pending.part) delete sockets[seatSel.slot].part;
  commitSockets(seatSel.id, sockets, 'seat move');
}

function turnSeat(d) {
  if (!seatSel) return;
  const sockets = socketsOf(seatSel.id);
  const cur = sockets[seatSel.slot];
  if (!cur) return;
  sockets[seatSel.slot] = { ...cur, yaw: +(((cur.yaw ?? 0) + d)).toFixed(3) };
  commitSockets(seatSel.id, sockets, 'seat facing');
}

function removeSeat() {
  if (!seatSel) return;
  const sockets = socketsOf(seatSel.id);
  delete sockets[seatSel.slot];
  commitSockets(seatSel.id, sockets, 'seat removal');
  deselectSeat();
}

// ============================================================ pointer

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !editMode) return;  // outside edit mode the canvas is for looking
  if (seatArm) { placeSeatAt(e); e.preventDefault(); return; }
  if (ghost) return;                        // click-to-place handled on click
  // Pick from THIS event's coordinates. Relying on the last mousemove to have
  // left `mouse` in the right place works for a real pointer and fails for
  // anything that presses without moving first — a touch, a synthetic click,
  // a tab that regained focus under the cursor.
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  // seat markers pick FIRST — a gizmo is small and deliberate, and the mesh
  // it floats over would otherwise win every contested click
  const sp = pickSeat(raycaster.ray);
  if (sp) {
    selectSeat(sp);
    seatDrag = { armed: false, startX: e.clientX, startY: e.clientY };
    e.preventDefault();
    return;
  }
  const targets = [];
  for (const o of entities.values()) if (o) targets.push(o);
  const hit = raycaster.intersectObjects(targets, true)[0];
  if (!hit) { if (selected) deselect(); if (seatSel) deselectSeat(); return; }
  if (seatSel) deselectSeat();
  let root = hit.object;
  while (root && !root.userData.entityId) root = root.parent;
  if (!root) return;
  const id = root.userData.entityId;
  select(id);
  // A press is a SELECT. It only becomes a drag once the pointer actually
  // travels — otherwise clicking a thing to look at its label moved it.
  const aim = aimPoint(id);
  dragging = {
    id,
    before: snapshotOf(root),
    lastSent: 0,
    armed: false,
    startX: e.clientX,
    startY: e.clientY,
    clientY: e.clientY,
    // Shift held at grab = a VERTICAL drag: the ground-plane raycast can't
    // express height, so hold Shift and the pointer's up/down maps to world Y
    // with the horizontal position pinned. The standard editor gesture.
    vertical: e.shiftKey,
    startPos: entities.get(id).position.clone(),
    depth: camera.position.distanceTo(entities.get(id).position),
    grab: aim ? entities.get(id).position.clone().sub(aim.point) : new THREE.Vector3(),
  };
  e.preventDefault();
});

// Arm the drag only after a few pixels of travel — the same threshold every
// desktop UI uses to tell a click from a drag.
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (seatDrag && !seatDrag.armed
      && Math.hypot(e.clientX - seatDrag.startX, e.clientY - seatDrag.startY) > DRAG_SLOP) {
    seatDrag.armed = true;
  }
  if (!dragging) return;
  dragging.clientY = e.clientY;                 // vertical drag reads this each frame
  if (!dragging.armed
      && Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) > DRAG_SLOP) {
    // the press selected it; travel is where a move would begin — a locked
    // thing refuses here, before any preview exists to snap back
    if (lockedHint(dragging.id)) { dragging = null; return; }
    dragging.armed = true;
  }
});

addEventListener('mouseup', () => {
  if (seatDrag?.armed) commitSeatDrag();
  seatDrag = null;
  if (dragging?.armed && selected) {
    const moved = dragging.before;
    const o = selected.obj;
    const same = Math.abs(o.position.x - moved.pos[0]) < 0.005
      && Math.abs(o.position.y - moved.pos[1]) < 0.005
      && Math.abs(o.position.z - moved.pos[2]) < 0.005;
    if (!same) commitPlace(moved);          // release commits ONE clean entry
  }
  dragging = null;
});

canvas.addEventListener('click', (e) => {
  if (!ghost || !editMode) return;
  commitSpawn();
  e.preventDefault();
});

// ============================================================ keys

bus.on('key', (e) => {
  if (e.code === 'Escape') {
    if (seatArm) { seatArm = null; flashHint('seat placement cancelled'); }
    else if (ghost) cancelGhost();
    else if (seatSel) deselectSeat();
    else if (selected) deselect();
    else if (editMode) setEditMode(false);
    return;
  }
  // Undo stays available outside edit mode — you may only notice the mistake
  // after you have gone back to looking.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
  if (!editMode) return;

  const turn = (d) => {
    if (ghost) ghost.yaw += d;
    else if (selected) {
      const before = snapshotOf(selected.obj);
      selected.obj.rotation.y += d;
      reindexCollider(selected.id); refreshOutline();
      commitPlace(before);
    }
  };
  const size = (f) => {
    if (ghost) ghost.scale = THREE.MathUtils.clamp(ghost.scale * f, 0.1, 12);
    else if (selected) {
      const before = snapshotOf(selected.obj);
      selected.obj.scale.multiplyScalar(f);
      selected.obj.scale.clampScalar(0.1, 12);
      reindexCollider(selected.id); refreshOutline();
      commitPlace(before);
    }
  };
  // R/F raise/lower — the keyboard counterpart to Shift+drag, for precise
  // heights. Never underground. (R is ragdoll globally, but that is gated to
  // NOT fire while editing, so it is free here.)
  const raise = (dy) => {
    if (ghost) { ghost.obj.position.y = Math.max(0, ghost.obj.position.y + dy); return; }
    if (!selected) return;
    const before = snapshotOf(selected.obj);
    const floor = heightAt(selected.obj.position.x, selected.obj.position.z);
    selected.obj.position.y = Math.max(floor, selected.obj.position.y + dy);
    reindexCollider(selected.id); refreshOutline();
    commitPlace(before);
  };
  // a selected seat anchor holds the editing keys before things do
  if (seatSel) {
    if (e.code === 'KeyQ') turnSeat(e.shiftKey ? 0.02 : Math.PI / 12);
    if (e.code === 'KeyE') turnSeat(e.shiftKey ? -0.02 : -Math.PI / 12);
    if (e.code === 'Delete' || e.code === 'Backspace') removeSeat();
    return;
  }
  // Q/E only steer objects when something is being edited — otherwise they're
  // photo-mode fly keys and must stay free.
  if (ghost || selected) {
    if (e.code === 'KeyQ') turn(e.shiftKey ? 0.02 : Math.PI / 12);
    if (e.code === 'KeyE') turn(e.shiftKey ? -0.02 : -Math.PI / 12);
    if (e.code === 'Comma') size(0.92);
    if (e.code === 'Period') size(1.087);
    if (e.code === 'KeyR') raise(e.shiftKey ? 0.05 : 0.25);
    if (e.code === 'KeyF') raise(e.shiftKey ? -0.05 : -0.25);
  }
  if ((e.code === 'Delete' || e.code === 'Backspace') && selected) removeSelected();
});

// ============================================================ palette UI

let buildSec = null;

export function initPalette() {
  buildSec = makeSection('🧱 build', async (body) => { if (!body.dataset.init) await paintBuild(body); },
    { id: 'build' });
  makeSection('🧍 avatar', paintAvatars, { id: 'avatar' });
  makeSection('🌿 ground', paintGround, { id: 'ground' });
  makeSection('☀ sky', paintSky, { id: 'sky' });
  return { buildSec };
}

// ---- terrain & grass -------------------------------------------------------
// Ground was agent-only (terrain/grass verbs); an empty world had no way for a
// person to grow either. These are AUTHORED (they persist and fold), so —
// unlike the sky tuner's live sliders — each is a deliberate commit on a
// click, which is also why they don't spam the log.

// A tint is a ground palette: the terrain layer colour, plus the createFlora
// seasonal colour each blade species takes (GRASS_COLORS name). The two grass
// keys differ because the sheets are authored in different hues — the meadow
// sheet is already green so it keeps its own art (null), while bunch grass
// ships a straw recolor and can only be brought back to green by the `green`
// recolor (a multiplier cannot survive a species' own recolor).
const GROUND_TINTS = {
  meadow: { layer: '#4a5d33', grass: null,          tufts: 'green' },
  arid:   { layer: '#7a6b48', grass: 'straw',       tufts: 'straw' },
  tundra: { layer: '#5a6b6b', grass: 'gray-green',  tufts: 'gray-green' },
};
const TERRAIN_SHAPES = { flat: 0.2, hills: 2.6, rugged: 6.0 };
// blade length drives the wind response too (lawns are stiff, tallgrass sways)
const GRASS_HEIGHT = { lawn: 0.15, meadow: 0.42, tall: 0.7 };
const GRASS_DENSITY = {
  sparse: 0.5,
  normal: 1,
  lush:   1.4,   // kept modest — blades are fill-rate
};

function paintGround(body) {
  if (body.dataset.init) return;
  body.dataset.init = '1';
  body.innerHTML = '';
  const st = { tint: 'meadow', shape: 'hills', seed: 7, density: 'normal', grass: false, plant: 'meadow', height: 'meadow' };

  const row = (label, node) => {
    const r = document.createElement('div');
    r.className = 'row';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = label;
    r.append(nm, node); body.appendChild(r); return r;
  };
  const btnRow = (...btns) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px;';
    btns.forEach((b) => { b.style.flex = '1 0 auto'; wrap.appendChild(b); });
    return wrap;
  };
  const mkBtn = (text, on) => { const b = document.createElement('button'); b.textContent = text; b.onclick = on; return b; };

  const growTerrain = () => sendVerb('terrain', {
    seed: st.seed, size: 160, segments: 200, amplitude: TERRAIN_SHAPES[st.shape], flatRadius: 16,
    layers: [{ color: GROUND_TINTS[st.tint].layer, repeat: 16 }],
  });
  // what "grow" plants — every option is one bag on the singleton grass verb
  const PLANTINGS = {
    meadow: () => {
      const args = { species: 'grass', width: 90, depth: 80, center: [0, 0],
        height: GRASS_HEIGHT[st.height] };
      if (GROUND_TINTS[st.tint].grass) args.color = GROUND_TINTS[st.tint].grass;
      return args;
    },
    tufts: () => {
      // bunch grass — a blade grass like the meadow, so it takes the same
      // length and seasonal-colour dials
      const args = { species: 'galleta_dry', width: 80, depth: 70, center: [0, 0],
        height: GRASS_HEIGHT[st.height] };
      if (GROUND_TINTS[st.tint].tufts) args.color = GROUND_TINTS[st.tint].tufts;
      return args;
    },
    'mojave desert': () => ({ preset: 'mojave', width: 90, depth: 80, center: [0, 0] }),
    'corn field': () => ({ species: 'corn', width: 40, depth: 30, center: [0, 0],
      rows: { spacing: 0.9, plant: 0.26 }, corn: { peelChance: 0.25 } }),
  };
  const growGrass = () => {
    st.grass = true;
    sendVerb('grass', { ...PLANTINGS[st.plant](), density: GRASS_DENSITY[st.density] });
  };

  // terrain shape
  body.appendChild(btnRow(...Object.keys(TERRAIN_SHAPES).map((k) =>
    mkBtn(k, () => { st.shape = k; growTerrain(); flashHint(`terrain: ${k}`); }))));
  body.appendChild(btnRow(mkBtn('↻ reshuffle', () => { st.seed = Math.floor(Math.random() * 9999); growTerrain(); })));

  // what to plant
  const plantSel = document.createElement('select');
  plantSel.style.cssText = 'font:11px var(--font); background:rgba(4,14,20,.9); color:var(--fg); border:1px solid var(--edge); border-radius:5px; padding:5px;';
  for (const k of Object.keys(PLANTINGS)) plantSel.appendChild(new Option(k, k));
  plantSel.value = st.plant;
  plantSel.onchange = () => {
    st.plant = plantSel.value;
    syncPlantControls();
    if (st.grass) growGrass();
  };
  row('plant', plantSel);

  // blade length — a BLADE-grass control. Structural species (shrubs, yucca,
  // corn) carry their own size, and the engine ignores `height` for them, so
  // the row hides rather than sitting there as a dial that does nothing.
  const BLADE_PLANTINGS = new Set(['meadow', 'tufts']);
  const hSel = document.createElement('select');
  hSel.style.cssText = 'font:11px var(--font); background:rgba(4,14,20,.9); color:var(--fg); border:1px solid var(--edge); border-radius:5px; padding:5px;';
  for (const k of Object.keys(GRASS_HEIGHT)) hSel.appendChild(new Option(k, k));
  hSel.value = st.height;
  hSel.onchange = () => { st.height = hSel.value; if (st.grass && BLADE_PLANTINGS.has(st.plant)) growGrass(); };
  const hRow = row('height', hSel);
  syncPlantControls();

  function syncPlantControls() {
    hRow.style.display = BLADE_PLANTINGS.has(st.plant) ? '' : 'none';
  }

  // grass
  const dens = document.createElement('select');
  dens.style.cssText = 'font:11px var(--font); background:rgba(4,14,20,.9); color:var(--fg); border:1px solid var(--edge); border-radius:5px; padding:5px;';
  for (const k of Object.keys(GRASS_DENSITY)) dens.appendChild(new Option(k, k));
  dens.value = st.density;
  dens.onchange = () => { st.density = dens.value; if (st.grass) growGrass(); };
  row('grass', dens);
  body.appendChild(btnRow(
    mkBtn('🌱 grow', () => { growGrass(); flashHint(`${st.plant} growing`); }),
    mkBtn('mow', () => { st.grass = false; sendVerb('grass', { clear: true }); flashHint('field cleared'); }),
  ));

  // tint drives both terrain layer and grass colour
  const tint = document.createElement('select');
  tint.style.cssText = dens.style.cssText;
  for (const k of Object.keys(GROUND_TINTS)) tint.appendChild(new Option(k, k));
  tint.value = st.tint;
  tint.onchange = () => { st.tint = tint.value; growTerrain(); if (st.grass) growGrass(); };
  row('tint', tint);
}

export function toggleBuildMenu() { buildSec?.toggle(); }

// ---- models ----------------------------------------------------------------

async function paintBuild(body) {
  body.dataset.init = '1';
  body.innerHTML = '';

  // primitives that aren't library models — a light is the first
  const prim = document.createElement('button');
  prim.textContent = '💡 add light';
  prim.title = 'place a light source';
  prim.onclick = () => holdGhost('@light', 'light');
  body.appendChild(prim);

  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'search the library…';
  search.addEventListener('keydown', (e) => e.stopPropagation()); // typing ≠ walking
  body.appendChild(search);

  const grid = document.createElement('div');
  grid.className = 'grid';
  body.appendChild(grid);

  const paint = (items) => {
    grid.innerHTML = '';
    for (const it of items) {
      libLabels.set(it.path, it.name);
      const card = document.createElement('button');
      card.className = 'card panel';
      const img = it.preview
        ? `<img alt="" loading="lazy" src="/library/${it.preview}" onerror="this.style.visibility='hidden'">`
        : '<div style="width:100%;aspect-ratio:1"></div>';
      card.innerHTML = `${img}<span>${it.name}</span>`;
      card.onclick = () => holdGhost(it.path, it.name);
      grid.appendChild(card);
    }
    if (!items.length) grid.innerHTML = '<div style="color:var(--dim);font-size:11px">nothing matched</div>';
  };

  // The catalog agents already had (mcpl list_library), now served to people —
  // with the _preview.jpg Skye ships beside every model, so it's a real
  // catalog instead of a list of filenames.
  const starter = () => STARTER.map(([name, path]) =>
    ({ name, path, preview: path.replace(/\.glb$/, '_preview.jpg') }));

  let timer = null;
  const run = async (q) => {
    // An empty box shows the curated starters, not an alphabetical dump of the
    // whole library — otherwise opening the panel greets you with four
    // varieties of apocalyptic rubble.
    if (!q) { paint(starter()); return; }
    try {
      const r = await fetch(`/library-models?q=${encodeURIComponent(q)}`);
      paint(await r.json());
    } catch (e) { report('catalog', e); }
  };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => run(search.value.trim()), 160); };

  paint(starter());
}

// Assets uploaded into the world join the palette live, for everyone.
bus.on('asset', ({ name, path }) => {
  libLabels.set(path, name);
  toast(`${name} joined the world's palette`, 'info');
});

// ---- avatars ---------------------------------------------------------------

let onSwitchAvatar = null;
export function wireAvatarSwitch(fn) { onSwitchAvatar = fn; }
let myAvatarPath = '';
export function setMyAvatarPath(p) { myAvatarPath = p; }

async function paintAvatars(body) {
  const list = await fetch('/avatars').then((r) => r.json()).catch(() => []);
  body.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid';
  for (const { name, path } of list) {
    const card = document.createElement('button');
    card.className = `card panel ${path === myAvatarPath ? 'on' : ''}`;
    card.innerHTML =
      `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(name)}.png"
         onerror="this.parentNode.querySelector('.ph').style.display='flex';this.style.display='none'">
       <div class="ph" style="display:none;width:100%;aspect-ratio:1;align-items:center;
         justify-content:center;background:rgba(0,0,0,.3);border-radius:4px;font-size:18px">🧍</div>
       <span>${name}</span>`;
    card.onclick = () => onSwitchAvatar?.(path, name);
    grid.appendChild(card);
  }
  body.appendChild(grid);
}

// ---- sky + weather ---------------------------------------------------------

const SLIDERS = [
  ['hours', 'time', 0, 24, 0.1, 12],
  ['rate', 'rate', 0, 48, 0.5, 0],
  ['azimuth', 'azim', 0, 360, 5, 180],
  ['sun', 'sun', 0, 2.5, 0.05, 1],
  ['ambient', 'ambnt', 0, 2.5, 0.05, 1],
  ['fill', 'fill', 0, 2.5, 0.05, 1],
  ['exposure', 'expos', 0.3, 1.8, 0.05, 1],
  ['fog', 'fog', 0, 3, 0.05, 1],
];
// Named times beat eight raw sliders for the 95% case — you want "golden", not
// hours=17.4, exposure=0.86.
const PRESETS = {
  dawn: { hours: 6.4, clouds: 'stratus' },
  noon: { hours: 12, clouds: 'cumulus' },
  golden: { hours: 17.6, clouds: 'cumulus' },
  dusk: { hours: 19.4, clouds: 'cirrus' },
  night: { hours: 0.5, clouds: 'clear' },
};

function paintSky(body) {
  if (body.dataset.init) { syncSky(body); return; }
  body.dataset.init = '1';
  body.innerHTML = '';
  const inputs = {};
  const commit = document.createElement('button');

  // Everything in this panel PREVIEWS. Only the commit button writes to the
  // world.
  //
  // Presets and dropdowns used to send a verb on every click while the sliders
  // only previewed — so idly exploring the sky wrote 53 permanent entries into
  // one world's log, every one of which replays for every future joiner. The
  // log is history; trying things out is not.
  const local = {};
  const preview = (patch) => {
    Object.assign(local, patch);
    previewSky({ ...gather() }).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };

  const gather = () => {
    // `local` carries the NON-slider knobs (clouds/weather/world/colors). The
    // sliders own their own keys and must WIN over local — otherwise a preset
    // that stashed a slider key (hours) into local would shadow the time slider
    // for the rest of the session: moving it wrote a.hours, but the stale
    // local.hours overrode it, so lighting stopped changing after you pressed
    // dusk (or any preset). Apply local first, then let the sliders assert.
    const a = { ...skyArgs(), ...local };
    for (const [key, , , , , dflt] of SLIDERS) {
      const v = Number(inputs[key].value);
      if (key === 'hours' || key === 'azimuth' || v !== dflt) a[key] = v;
    }
    return a;
  };

  const mkRow = (label, node) => {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm'; nm.textContent = label;
    row.append(nm, node);
    return row;
  };

  // presets
  const presetWrap = document.createElement('div');
  presetWrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; margin-bottom:4px;';
  for (const [name, vals] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.textContent = name;
    b.style.flex = '1 0 auto';
    b.onclick = () => {
      inputs.hours.value = vals.hours;
      if (vals.clouds) cl.value = vals.clouds;
      inputs.hours.dispatchEvent(new Event('input'));   // previews via the slider path
      preview({ ...vals });
    };
    presetWrap.appendChild(b);
  }
  body.appendChild(presetWrap);

  // weather — a first-class verb, not a slider
  const wx = document.createElement('select');
  wx.style.cssText = 'font:11px var(--font); background:rgba(4,14,20,.9); color:var(--fg); border:1px solid var(--edge); border-radius:5px; padding:5px;';
  for (const w of WEATHERS) wx.appendChild(new Option(w, w));
  wx.onchange = () => preview({ weather: wx.value, weatherSeconds: 12 });
  body.appendChild(mkRow('wx', wx));

  const cl = document.createElement('select');
  cl.style.cssText = wx.style.cssText;
  for (const c of CLOUDS) cl.appendChild(new Option(c, c));
  cl.value = 'cumulus';
  cl.onchange = () => preview({ clouds: cl.value });
  body.appendChild(mkRow('cloud', cl));

  const wl = document.createElement('select');
  wl.style.cssText = wx.style.cssText;
  for (const w of SKY_WORLDS) wl.appendChild(new Option(w, w));
  wl.onchange = () => preview({ world: wl.value });
  body.appendChild(mkRow('world', wl));

  // Cloud budget is YOURS, not the world's — it never becomes a verb. The
  // volumetric march is the most expensive thing the client draws and its cost
  // is per-fragment, so a big high-refresh display pays several times what a
  // small window does for the same sky.
  const cq = document.createElement('select');
  cq.style.cssText = wx.style.cssText;
  for (const q of CLOUD_QUALITY) cq.appendChild(new Option(q, q));
  cq.value = getCloudQuality();
  cq.onchange = () => { setCloudQuality(cq.value); flashHint(`clouds: ${cq.value} (yours only)`); };
  const cqRow = mkRow('clouds⚙', cq);
  cqRow.title = 'local performance setting — not shared with the world';
  body.appendChild(cqRow);

  // The meadow budget is likewise YOURS (#60) — a persisted cap on how much
  // of the field this machine draws. Species/seed/extent stay world state;
  // the auto governor may thin below the cap under load, never above it.
  const gq = document.createElement('select');
  gq.style.cssText = wx.style.cssText;
  for (const q of GRASS_QUALITY) gq.appendChild(new Option(q, q));
  const gqRow = mkRow('grass⚙', gq);
  const syncGrassRow = () => {
    gq.value = getGrassQuality();
    const eff = getGrassDensity();
    gqRow.title = getGrassShed() < 1 && gq.value !== 'off'
      ? `local performance setting — auto governor thinned this session to ×${eff}`
      : 'local performance setting — not shared with the world';
  };
  gq.onchange = () => {
    setGrassQuality(gq.value);
    syncGrassRow();
    flashHint(`grass: ${gq.value} (yours only)`);
  };
  syncGrassRow();
  body.appendChild(gqRow);

  for (const [key, label, min, max, step, dflt] of SLIDERS) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step; input.value = dflt;
    const val = document.createElement('span');
    val.className = 'v';
    val.textContent = dflt;
    input.oninput = () => {
      val.textContent = input.value;
      previewSky(gather()).catch((e) => report('sky preview', e));
      commit.classList.add('dirty');
    };
    inputs[key] = input;
    const row = mkRow(label, input);
    row.appendChild(val);
    body.appendChild(row);
  }

  // The sun can follow a REAL clock: `clock: real` makes the world's hour BE
  // the named timezone's wall hour (DST included, hoursAt owns the formula)
  // and the time slider yields. World policy like everything else here — it
  // previews live and commits with ✓. Clearing stashes undefined so the JSON
  // the verb carries simply drops the keys (a null would linger in the fold).
  const ck = document.createElement('select');
  ck.appendChild(new Option('authored (slider)', ''));
  ck.appendChild(new Option('real time — Los Angeles', 'real'));
  const syncClockUi = () => { inputs.hours.disabled = ck.value === 'real'; };
  ck.value = skyArgs().clock === 'real' ? 'real' : '';
  ck.onchange = () => {
    if (ck.value === 'real') { local.clock = 'real'; local.tz = 'America/Los_Angeles'; }
    else { local.clock = undefined; local.tz = undefined; }
    syncClockUi();
    previewSky(gather()).catch((e) => report('sky preview', e));
    commit.classList.add('dirty');
  };
  syncClockUi();
  const ckRow = mkRow('clock', ck);
  ckRow.title = 'real time: the sun tracks the actual LA clock — noon is noon';
  body.appendChild(ckRow);

  commit.textContent = '✓ log to world';
  commit.title = 'share this sky with everyone, permanently';
  commit.onclick = () => {
    sendVerb('sky', gather());
    commit.classList.remove('dirty');
    commit.textContent = '✓ logged';
    setTimeout(() => { commit.textContent = '✓ log to world'; }, 1200);
  };
  body.appendChild(commit);

  body._sync = () => {
    const a = skyArgs();
    for (const [key, , , , , dflt] of SLIDERS) {
      inputs[key].value = a[key] ?? dflt;
      inputs[key].parentNode.querySelector('.v').textContent = inputs[key].value;
    }
    if (a.weather) wx.value = a.weather;
    if (a.clouds) cl.value = a.clouds;
    if (a.world) wl.value = a.world;
    ck.value = a.clock === 'real' ? 'real' : '';
    syncClockUi();
    syncGrassRow();
  };
  body._sync();
}
function syncSky(body) { body._sync?.(); }

// ============================================================ upload

addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const isVrm = /\.vrm$/i.test(file.name);
  if (!/\.(glb|vrm)$/i.test(file.name)) {
    toast(`can't ingest ${file.name} — .glb and .vrm only`, 'warn');
    return;
  }
  toast(`uploading ${file.name} (${(file.size / 1e6).toFixed(1)}MB)…`, 'info');
  try {
    const q = new URLSearchParams();
    if (isVrm) { q.set('as', 'avatar'); q.set('name', file.name); }
    if (CONFIG.token) q.set('token', CONFIG.token);
    const r = await fetch(`/upload${q.size ? `?${q}` : ''}`, { method: 'POST', body: file });
    if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
    const { path, name } = await r.json();
    if (isVrm) {
      toast(`avatar "${name}" is on the roster — pick it in the avatar panel`, 'info', 9000);
    } else {
      const label = file.name.replace(/\.glb$/i, '');
      sendVerb('asset', { name: label, path });  // world vocabulary grows for everyone
      await holdGhost(path, label);
    }
  } catch (err) { report(`upload ${file.name}`, err); }
});
