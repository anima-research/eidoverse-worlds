// seatedit — the seat-anchor authoring grammar (split from build.js, §R4).
//
// Sockets are child entities of their host (PLAN-sockets-entities), shown in build mode as gold gizmos: click to
// select, drag to refine, Q/E to face, Del to remove. Each commit is one write to the socket child itself.
//
// build.js stays the gesture ROUTER (one pointer, one key ladder — two
// modules both listening on the canvas would re-fight every contested
// click); this module owns everything after "it was a seat gesture". The
// hooks it needs back from the core (mode, selection, undo, the inspector
// bar) are build.js exports — the modules call across the seam at gesture
// time only, so the import cycle is eval-safe by construction.

import * as OP from '../../shared/requests.js';
import { sendOps } from './editwrites.js';
import { THREE, camera } from './core.js';
import { bus } from './base.js';
import { modelName } from './assets.js';
import { entities, metaOf, bags, bagOf, parentIdOf, childrenOf, findPart } from './world.js';
import { socketsUnder } from '../../shared/sockbody.js';
import { motionNode } from '../../shared/protocol/names.js';
import { mouse } from './controller.js';
import { flashHint, html } from './ui.js';
import { engage, release } from './keyhints.js';
import { setBuildMode, isBuilding, deselect,
  setInspectorHtml, hideInspector } from './build.js';
import { registerHandler } from './inspect.js';
import { sceneSelect } from './scenegraph.js';
import { qMul, qFromYaw, qNorm } from '../../shared/rot.js';

const raycaster = new THREE.Raycaster();

const seatGizmos = new Map();   // socket child id -> { host, gizmo (child of the host's root) }
let seatSel = null;             // { id: host, sock: socket child id, slot: its name } — the anchor under edit
let seatDrag = null;            // { armed, startX, startY, pending } drag state
let seatArm = null;             // entity id waiting for a placement click

export const socketArmed = () => seatArm !== null;
export const socketSelected = () => seatSel !== null;

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

/** Rebuild all markers from the fold's records. Parented to the entity ROOT in
 *  model frame — the anchor's rest spot, matching socketWorldPos semantics
 *  (reach never oscillates with a part's motion, neither should the gizmo). */
export function refreshSocketGizmos() {
  for (const [k, { g }] of seatGizmos) { g.parent?.remove(g); seatGizmos.delete(k); }
  if (!isBuilding()) return;
  const hosts = new Set();
  for (const [sid, c] of bags()) if (c?.socket && typeof c.socket === 'object') { const h = parentIdOf(sid); if (h != null) hosts.add(h); }
  for (const id of hosts) {
    const root = entities.get(id);
    if (!root) continue;
    for (const x of socketsOf(id)) {
      const t = bagOf(x.id)?.transform ?? {};   // local to the host
      const g = makeSeatGizmo();
      g.position.set(...(Array.isArray(t.pos) ? t.pos : [0, 0, 0]));
      g.quaternion.fromArray(qNorm(t.q) ?? [0, 0, 0, 1]);   // the socket's whole rotation
      root.add(g);
      seatGizmos.set(x.id, { host: id, slot: x.name, g });
    }
  }
  if (seatSel && !seatGizmos.has(seatSel.sock)) deselectSocket();
  else refreshSeatHighlight();
}
bus.on('comp', ({ type }) => { if ((type === 'socket' || type === 'transform') && isBuilding()) refreshSocketGizmos(); });
bus.on('entity', () => { if (isBuilding()) refreshSocketGizmos(); });

function refreshSeatHighlight() {
  for (const [k, { g }] of seatGizmos) {
    const on = seatSel && k === seatSel.sock;
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
  for (const [k, { g }] of seatGizmos) {
    g.getWorldPosition(_spV);
    const tol = Math.min(0.3, 0.06 + camera.position.distanceTo(_spV) * 0.015);
    const d = ray.distanceToPoint(_spV);
    if (d < tol && d < bestD) { bestD = d; best = k; }
  }
  if (!best) return null;
  const { host, slot } = seatGizmos.get(best);
  return { id: host, sock: best, slot };
}

export function selectSocket(pick) {
  deselect();                              // a seat and a thing never co-hold the keys
  seatSel = pick;
  refreshSeatHighlight();
  engage('seatTurn');
  const meta = metaOf(pick.id) ?? {};
  const label = meta.model != null ? modelName(meta.model) : pick.id;
  setInspectorHtml(
    html`<span><b>${pick.slot}</b> anchor on <b>${label.slice(0, 24)}</b></span><span style="color:var(--dim)">drag move · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> remove · <kbd>Esc</kbd> done</span>`);   // one html``: markup + markup would concatenate to a plain (text) string
}
export function deselectSocket() {
  if (seatSel) release();
  seatSel = null; seatDrag = null;
  refreshSeatHighlight();
  hideInspector();
}

/** Leaving build mode: nothing seat-flavored survives the exit. */
export function resetSockets() {
  seatArm = null;
  deselectSocket();
}

/** A host's socket children, switched-off ones included: [{id, name, sock, station}]. */
const socketsOf = (id) => socketsUnder(String(id), childrenOf, bagOf, { all: true });
/** A socket child's new pose (local to its host): one write of its whole transform. */
const poseOps = (sid, pos, q) => [OP.set(sid, 'transform', { pos, q, scale: [1, 1, 1] })];

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
  const bag = bagOf(id) ?? {};
  const names = new Set();
  for (const key in bag) {
    const n = (key === 'motion' || key.startsWith('motion:')) ? motionNode(key, bag[key]) : null;   // the node it moves (its value's `node`)
    if (n) names.add(n);
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

export function armSocketPlacement(id) {
  if (!id || !entities.get(id)) return;
  setBuildMode(true, { quiet: true });
  seatArm = id;
  flashHint(html`click the spot where the occupant goes — the arrow will face you · <kbd>Esc</kbd> cancels`, 8000);
}

export function cancelSocketArm() {
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
  // face the declarer: you are looking at the seat from where an occupant's
  // knees would point. Q/E refines from there.
  const yaw = +(Math.atan2(camera.position.x - hit.point.x, camera.position.z - hit.point.z) - worldYawOf(root)).toFixed(3);
  const names = new Set(socketsOf(id).map((x) => x.name));
  let slot = 'seat', n = 2;
  while (names.has(slot)) slot = `seat${n++}`;
  // '+ seat' places a seat: a socket child with a station (a person attaches here)
  sendOps([OP.addSocket(id, { name: slot, ...(part ? { part } : {}) }, { id: '$seat', pos, q: qFromYaw(yaw).map((v) => +v.toFixed(6)), station: { action: 'sit' } })], { what: 'seat anchor' })
    ?.then?.((r) => { const sid = r?.ids?.$seat; if (sid) { refreshSocketGizmos(); if (seatGizmos.has(sid)) selectSocket({ id, sock: sid, slot }); } });
  flashHint(html`<b>${slot}</b> declared${part ? ' (rides ' + part + ')' : ''} — drag refines · <kbd>Q</kbd><kbd>E</kbd> face · <kbd>Del</kbd> removes`);
}

/** The core's mousedown hands seat gestures here FIRST — a gizmo is small
 *  and deliberate, and the mesh it floats over would otherwise win every
 *  contested click. Returns true when the press was a seat gesture. */
export function socketMouseDown(e) {
  if (seatArm) { placeSeatAt(e); return true; }
  mouse.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(mouse, camera);
  const sp = pickSeat(raycaster.ray);
  if (!sp) return false;
  selectSocket(sp);
  seatDrag = { armed: false, startX: e.clientX, startY: e.clientY };
  return true;
}

/** A selected seat anchor holds the editing keys before things do. Returns
 *  true whenever a seat is selected — matching the old ladder, where seat
 *  selection consumed the whole key set. */
export function socketKeyDown(e) {
  if (!seatSel) return false;
  if (e.code === 'KeyQ') turnSeat(e.shiftKey ? 0.02 : Math.PI / 12);   // keys: seatTurn
  if (e.code === 'KeyE') turnSeat(e.shiftKey ? -0.02 : -Math.PI / 12);   // keys: seatTurn
  if (e.code === 'Delete' || e.code === 'Backspace') removeSeat();
  return true;
}

/** Called each frame from updateBuild while a seat drag is armed: the anchor
 *  slides along ITS OWN entity's surfaces — it cannot fall off the thing. */
export function updateSocketDrag() {
  if (!seatDrag?.armed || !seatSel) return;
  raycaster.setFromCamera(mouse, camera);
  const root = entities.get(seatSel.id);
  if (!root) return;
  const hit = raycaster.intersectObject(root, true)[0];
  if (!hit) return;
  const next = seatFromHit(seatSel.id, root, hit);
  seatDrag.pending = next;
  const g = seatGizmos.get(seatSel.sock)?.g;
  if (g) g.position.set(...next.pos);
}

function commitSeatDrag() {
  if (!seatDrag?.pending || !seatSel) return;
  const c = bagOf(seatSel.sock); if (!c?.socket) return;
  const { part, ...sock } = c.socket; const p = seatDrag.pending.part;
  sendOps([...poseOps(seatSel.sock, seatDrag.pending.pos, qNorm(c.transform?.q) ?? [0, 0, 0, 1]),
    ...((p ?? null) !== (part ?? null) ? [OP.set(seatSel.sock, 'socket', { ...sock, ...(p ? { part: p } : {}) })] : [])], { what: 'seat move' });
}

function turnSeat(d) {
  if (!seatSel) return;
  const t = bagOf(seatSel.sock)?.transform; if (!t) return;
  // turn about the socket's OWN up (a tilted socket turns in its tilt)
  sendOps(poseOps(seatSel.sock, Array.isArray(t.pos) ? t.pos : [0, 0, 0], qNorm(qMul(qNorm(t.q) ?? [0, 0, 0, 1], qFromYaw(d))).map((v) => +v.toFixed(6))), { what: 'seat facing' });
}

function removeSeat() {
  if (!seatSel) return;
  sendOps([OP.remove(seatSel.sock)], { what: 'seat removal' });
  deselectSocket();
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


// ---- the inspector's sockets GESTURES --------------------------------
// The card is shared/editschema.js's: '+ socket here' arms the click-to-place, a row click selects that socket child.
// Components ▸ + seat…: the first seat in ONE step (before, a sockets comp had to exist first)
registerHandler('comp', (id, _obj, k, _v, opts) => { if (k !== 'add:seat' || opts?.live) return false; armSocketPlacement(id); return true; });
registerHandler('sockets', (id, _obj, k, value) => {
  if (k === 'add') { armSocketPlacement(id); return true; }
  if (k === 'slots') { sceneSelect(value); return true; }
  if (k === 'del') { if (seatSel?.sock === value) deselectSocket(); return false; }
  return false;
});
