// seatedit — the seat-anchor authoring grammar (split from build.js, §R4).
//
// Sit anchors (the `sockets` component) get the same editing grammar as
// things: visible in edit mode as gold gizmos, click to select, drag to
// refine, Q/E to face, Del to remove, one undoable log entry per commit.
// Zero server involvement — this is all authoring UI over the comp verb.
//
// build.js stays the gesture ROUTER (one pointer, one key ladder — two
// modules both listening on the canvas would re-fight every contested
// click); this module owns everything after "it was a seat gesture". The
// hooks it needs back from the core (mode, selection, undo, the inspector
// bar) are build.js exports — the modules call across the seam at gesture
// time only, so the import cycle is eval-safe by construction.

import * as OP from '../../shared/protocol/requests.js';
import { sendOps } from './editwrites.js';
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { libLabels } from './assets.js';
import { entities, entityMeta, comps, findPart } from './world.js';
import { mouse } from './controller.js';
import { flashHint, html } from './ui.js';
import { engage, release } from './keyhints.js';
import { setEditMode, isEditing, deselect,
  setInspectorHtml, hideInspector } from './build.js';
import { registerHandler } from './inspect.js';
import { socketQ } from '../../shared/components.js';
import { qMul, qFromYaw, qNorm } from '../../shared/rot.js';

const raycaster = new THREE.Raycaster();

const seatGizmos = new Map();   // "id\x00slot" -> gizmo (child of entity root)
let seatSel = null;             // { id, slot } — the anchor under edit
let seatDrag = null;            // { armed, startX, startY, pending } drag state
let seatArm = null;             // entity id waiting for a placement click

export const seatArmed = () => seatArm !== null;
export const seatSelected = () => seatSel !== null;

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
export function refreshSeatGizmos() {
  for (const [k, g] of seatGizmos) { g.parent?.remove(g); seatGizmos.delete(k); }
  if (!isEditing()) return;
  for (const [id, bag] of comps) {
    if (!bag.sockets) continue;
    const root = entities.get(id);
    if (!root) continue;
    for (const [slot, sock] of Object.entries(bag.sockets)) {
      const g = makeSeatGizmo();
      g.position.set(...(sock.pos ?? [0, 0.5, 0]));
      g.quaternion.fromArray(socketQ(sock));   // the socket's whole rotation
      root.add(g);
      seatGizmos.set(`${id}\x00${slot}`, g);
    }
  }
  if (seatSel && !seatGizmos.has(`${seatSel.id}\x00${seatSel.slot}`)) deselectSeat();
  else refreshSeatHighlight();
}
bus.on('comp', ({ type }) => { if (type === 'sockets') refreshSeatGizmos(); });
bus.on('entity', () => { if (isEditing()) refreshSeatGizmos(); });

function refreshSeatHighlight() {
  for (const [k, g] of seatGizmos) {
    const on = seatSel && k === `${seatSel.id}\x00${seatSel.slot}`;
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
  const [id, slot] = best.split('\x00');
  return { id, slot };
}

export function selectSeat(pick) {
  deselect();                              // a seat and a thing never co-hold the keys
  seatSel = pick;
  refreshSeatHighlight();
  engage('seatTurn');
  const meta = entityMeta.get(pick.id) ?? {};
  const label = libLabels.get(meta.model) ?? meta.model?.split('/').pop()?.replace(/\.glb$/, '') ?? pick.id;
  setInspectorHtml(
    html`<span><b>${pick.slot}</b> anchor on <b>${label.slice(0, 24)}</b></span><span style="color:var(--dim)">drag move · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`);   // one html``: markup + markup would concatenate to a plain (text) string
}
export function deselectSeat() {
  if (seatSel) release();
  seatSel = null; seatDrag = null;
  refreshSeatHighlight();
  hideInspector();
}

/** Leaving edit mode: nothing seat-flavored survives the exit. */
export function resetSeats() {
  seatArm = null;
  deselectSeat();
}

function socketsOf(id) { return structuredClone(comps.get(id)?.sockets ?? {}); }

/** One merged comp entry per gesture, with its inverse on the undo stack —
 *  merged, because comp data replaces wholesale and a naive write would
 *  silently eat every OTHER anchor on the thing. */
export function commitSockets(id, next, describe) {
  sendOps([Object.keys(next).length ? OP.set(id, 'sockets', next) : OP.unset(id, 'sockets')], { what: describe });
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
  flashHint(html`click the spot where a sitter goes — the arrow will face you · <kbd>Esc</kbd> cancels`, 8000);
}

export function cancelSeatArm() {
  if (!seatArm) return false;
  seatArm = null;
  flashHint('seat placement cancelled');
  return true;
}

function placeSeatAt(e) {
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const id = seatArm;
  const root = entities.get(id);
  if (!root) { seatArm = null; return; }
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) { flashHint(html`that missed the thing — click ON it, or <kbd>Esc</kbd>`); return; }
  seatArm = null;
  const { pos, part } = seatFromHit(id, root, hit);
  // face the declarer: you are looking at the seat from where a sitter's
  // knees would point. Q/E refines from there.
  const yaw = +(Math.atan2(camera.position.x - hit.point.x, camera.position.z - hit.point.z) - worldYawOf(root)).toFixed(3);
  const sockets = socketsOf(id);
  let slot = 'seat', n = 2;
  while (sockets[slot]) slot = `seat${n++}`;
  sockets[slot] = { pos, ...(yaw ? { q: qFromYaw(yaw).map((v) => +v.toFixed(6)) } : {}), ...(part ? { part } : {}), body: {} };   // '+ seat' places a seat: a person attaches here
  commitSockets(id, sockets, 'seat anchor');
  selectSeat({ id, slot });      // the comp echo builds the gizmo already selected
  flashHint(html`<b>${slot}</b> declared${part ? ' (rides ' + part + ')' : ''} — drag refines · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> removes`);
}

/** The core's mousedown hands seat gestures here FIRST — a gizmo is small
 *  and deliberate, and the mesh it floats over would otherwise win every
 *  contested click. Returns true when the press was a seat gesture. */
export function seatMouseDown(e) {
  if (seatArm) { placeSeatAt(e); return true; }
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const sp = pickSeat(raycaster.ray);
  if (!sp) return false;
  selectSeat(sp);
  seatDrag = { armed: false, startX: e.clientX, startY: e.clientY };
  return true;
}

/** A selected seat anchor holds the editing keys before things do. Returns
 *  true whenever a seat is selected — matching the old ladder, where seat
 *  selection consumed the whole key set. */
export function seatKeyDown(e) {
  if (!seatSel) return false;
  if (e.code === 'KeyQ') turnSeat(e.shiftKey ? 0.02 : Math.PI / 12);   // keys: seatTurn
  if (e.code === 'KeyE') turnSeat(e.shiftKey ? -0.02 : -Math.PI / 12);   // keys: seatTurn
  if (e.code === 'Delete' || e.code === 'Backspace') removeSeat();
  return true;
}

/** Called each frame from updateBuild while a seat drag is armed: the anchor
 *  slides along ITS OWN entity's surfaces — it cannot fall off the thing. */
export function updateSeatDrag() {
  if (!seatDrag?.armed || !seatSel) return;
  raycaster.setFromCamera(mouse, camera);
  const root = entities.get(seatSel.id);
  if (!root) return;
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) return;
  const next = seatFromHit(seatSel.id, root, hit);
  seatDrag.pending = next;
  const g = seatGizmos.get(`${seatSel.id}\x00${seatSel.slot}`);
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
  // turn about the socket's OWN up (a tilted socket turns in its tilt)
  const { yaw: _y, ...rest } = cur;
  sockets[seatSel.slot] = { ...rest, q: qNorm(qMul(socketQ(cur), qFromYaw(d))).map((v) => +v.toFixed(6)) };
  commitSockets(seatSel.id, sockets, 'seat facing');
}

function removeSeat() {
  if (!seatSel) return;
  const sockets = socketsOf(seatSel.id);
  delete sockets[seatSel.slot];
  commitSockets(seatSel.id, sockets, 'seat removal');
  deselectSeat();
}

// The seat drag's own arm/commit listeners — the same DRAG_SLOP threshold
// every desktop UI uses to tell a click from a drag. These fire beside the
// core's listeners and touch only seat state, so order between the two
// modules' handlers does not matter.
const DRAG_SLOP = 4;
addEventListener('mousemove', (e) => {
  if (seatDrag && !seatDrag.armed
      && Math.hypot(e.clientX - seatDrag.startX, e.clientY - seatDrag.startY) > DRAG_SLOP) {
    seatDrag.armed = true;
  }
});
addEventListener('mouseup', () => {
  if (seatDrag?.armed) commitSeatDrag();
  seatDrag = null;
});


// ---- the inspector's sockets GESTURES + preview --------------------------------
// The fields are declared in shared/editschema.js. What only this module can
// add: '+ seat here' arms the click-to-place, a row click selects the gizmo,
// a live drag on a slot's channels moves the gizmo before the merged comp
// commits (the shared path merges and pushes the undo).
// Components ▸ + seat…: the first seat in ONE step (before, a sockets comp had to exist first)
registerHandler('comp', (id, _obj, k, _v, opts) => { if (k !== 'add:seat' || opts?.live) return false; armSeatPlacement(id); return true; });
registerHandler('sockets', (id, obj, k, value, opts) => {
  if (k === 'add') { armSeatPlacement(id); return true; }
  if (k === 'slots') { if (entities.get(id)) selectSeat({ id, slot: value }); return true; }
  if (k === 'del') { if (seatSel?.id === id && seatSel.slot === value) deselectSeat(); return false; }
  if (!opts?.live) return false;
  const [slot, what, idx] = k.split('|');
  const g = seatGizmos.get(`${id}\x00${slot}`);
  if (!g) return true;
  if (what === 'pos') { const p = g.position.toArray(); p[+idx] = +value; g.position.set(...p); }
  else if (what === 'rot') { g.rotation.reorder('YXZ'); g.rotation[['x', 'y', 'z'][+idx]] = +value; }   // the inspector's heading/pitch/roll (Euler YXZ)
  return true;
});
