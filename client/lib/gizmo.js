// gizmo — three's TransformControls on the selected thing, in edit mode.
//
// The tools column's move / rotate / scale already drive build.js's own drag
// (grab anywhere on the mesh). The gizmo is the precise version of the same
// three gestures: axis handles you can see. It never replaces their drag —
// build.js vetoes its mesh-grab while a handle is hot (setPointerVeto), and
// both commit the same way: ONE `place` carrying the full pose on release,
// an inverse from the fold on the undo stack, others watching the drag at
// pose cadence. Rotate turns about any axis and commits the full orientation
// q (design §5; a pure turn about up on a yaw-only thing stays a yaw); scale
// is uniform (the log has one number).
// Locked or mounted things get no gizmo — the schema says their transform is
// read-only, and a handle you can't drag is a lie.

import { THREE, scene, camera, canvas } from './core.js';
import { bus } from './base.js';
import { entities, comps } from './world.js';
import { sendDrag } from './net.js';
import { registerSystem } from './frame.js';
import { sceneSelected } from './scenegraph.js';
import { getTool, getSpace, isEditing, pushUndo, refreshOutline, setPointerVeto, setEscapeHook } from './build.js';
import * as V4 from './v4edit.js';   // protocol/v4 slice 3b: a v4 world's release is one door request with expect
import { reindexCollider } from './colliders.js';
import { boxOf } from './realize/models.js';
import { foldRecord, inverseOf } from './inspect.js';
import { mayAuthor } from './placer.js';
import { editVerbs, inspectSchema, fieldAt, poseEdits } from '../../shared/editschema.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const R2D = 180 / Math.PI;
let controls = null;
let helper = null;
let attachedId = null;
let start = null;        // { rec, scale, v4? } at drag start (v4: the components the release's expect names)
let cancelled = false;   // v4: Esc during the drag — the thing goes back, and the release writes nothing (§3a)
let lastSent = 0;
// the pivot (research 52, Roblox's PivotOffset): with a `pivot` comp the handles ride a PROXY at the pivot, oriented as
// the thing, and the thing follows the proxy: objWorld = proxy × offset (offset fixed at drag start). A turn or a size
// then goes about the pivot; nothing about the thing's own record changes but its pose.
const proxy = new THREE.Object3D(); proxy.name = 'edit-gizmo-pivot';
let viaProxy = false, offset = null;
const _m = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _ps = new THREE.Vector3();
const pivotOf = (id) => { const p = comps.get(id)?.pivot?.pos; return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p : null; };
/** Put the proxy at obj's pivot in the world, turned as obj is, unscaled. */
function seatProxy(obj, piv) {
  obj.updateWorldMatrix(true, false);
  obj.matrixWorld.decompose(_pp, _pq, _ps);
  proxy.position.copy(new THREE.Vector3(...piv).applyMatrix4(obj.matrixWorld));
  proxy.quaternion.copy(_pq); proxy.scale.set(1, 1, 1);
  proxy.updateMatrixWorld(true);
}

function ensure() {
  if (controls) return controls;
  controls = new TransformControls(camera, canvas);
  controls.size = 0.8;
  helper = controls.getHelper();
  helper.name = 'edit-gizmo';
  scene.add(helper);
  controls.addEventListener('dragging-changed', (e) => (e.value ? beginDrag() : endDrag()));
  controls.addEventListener('objectChange', onChange);
  setPointerVeto(() => !!controls?.axis || !!controls?.dragging);
  // Ctrl held = snapping (Blender's Ctrl, Maya's grid): 10 cm, 5°, 0.1×
  addEventListener('keydown', (e) => { if (e.key === 'Control') { controls.setTranslationSnap(0.1); controls.setRotationSnap(5 / R2D); controls.setScaleSnap(0.1); } });
  addEventListener('keyup', (e) => { if (e.key === 'Control') { controls.setTranslationSnap(null); controls.setRotationSnap(null); controls.setScaleSnap(null); } });
  return controls;
}

const MODE = { move: 'translate', rotate: 'rotate', scale: 'scale', pivot: 'translate' };
/** Can this thing take THIS gesture? The schema decides: a mounted or locked
 *  thing's transform is read-only; a light has no orientation or scale to drag. */
function editable(id, mode) {
  const rec = foldRecord(id); const obj = entities.get(id);
  // v4: a lock doesn't stop the drag; the release asks the door, and a person who may lift it is asked (§5, R's dialog)
  const doorLocks = V4.isV4();
  // a thing riding another: three parents it (realize/models.js), so its position IS the local pose the schema's pos.*
  // edit (→ one mount), the frame the mesh drag already uses. v1 keeps its rule; a part socket (a moving node) stays out.
  const rides = !!rec?.parent;
  if (!rec || !obj || (rides && (!doorLocks || obj.parent !== entities.get(rec.parent.to ?? rec.parent))) || (!doorLocks && comps.get(id)?.lock)) return false;
  const sc = inspectSchema(rec, id, { mayAuthor: mayAuthor(id), doorLocks });   // guarded by someone else → no handles
  const key = mode === 'rotate' ? 'rot.qw' : mode === 'scale' ? 'pos.scale' : 'pos.x';
  const f = fieldAt(sc, key);
  return !!f && !f.disabled;
}

function sync() {
  // v4: a drag in flight keeps its handles even if a lock lands meanwhile — the release asks the door, which says so
  // (and offers to move it anyway); detaching mid-drag left the preview stranded with nothing sent
  if (V4.isV4() && start) return;
  const id = sceneSelected();
  // scenegraph's selection is THE selection (a tree click never sets build.js's viewport `selected`)
  const want = isEditing() && id && MODE[getTool()] && editable(id, MODE[getTool()]) ? id : null;
  if (!want) { if (attachedId) { controls?.detach(); attachedId = null; viaProxy = false; } return; }
  const c = ensure();
  const obj = entities.get(want); const piv = pivotOf(want) ?? (getTool() === 'pivot' ? [0, 0, 0] : null);   // the pivot tool starts at the origin when there is none
  if (piv && !controls?.dragging) { if (!proxy.parent) scene.add(proxy); seatProxy(obj, piv); }   // between drags it follows the thing (others move it too)
  if (attachedId !== want || viaProxy !== !!piv) { c.attach(piv ? proxy : obj); attachedId = want; viaProxy = !!piv; }
  const mode = MODE[getTool()];
  if (c.mode !== mode) c.setMode(mode);
  const sp = getSpace(getTool()) === 'object' ? 'local' : 'world';
  if (c.space !== sp) c.setSpace(sp);   // the tool's space (build.js SPACES)
  // every axis: rotate commits q; scale is per axis in a v4 world, uniform in v1 (onChange)
  c.showX = true; c.showZ = true; c.showY = true;
}

function beginDrag() {
  if (!attachedId) return;
  if (viaProxy) { const obj = entities.get(attachedId); obj.updateWorldMatrix(true, false); proxy.updateMatrixWorld(true); offset = proxy.matrixWorld.clone().invert().multiply(obj.matrixWorld); }
  const rec = foldRecord(attachedId);
  start = rec ? { rec: JSON.parse(JSON.stringify(rec)), scale: entities.get(attachedId).scale.x, ...(V4.isV4() ? { v4: V4.compsOf(attachedId) } : {}) } : null;
  cancelled = false;
}
function onChange() {
  const obj = attachedId && entities.get(attachedId); if (!obj) return;
  if (cancelled) { bus.emit('pose-revert', { id: attachedId }); return; }   // Esc held it where the log has it
  if (getTool() === 'pivot') { refreshOutline(); return; }   // the pivot tool moves the pivot only: the thing stays
  if (viaProxy && offset) {   // the thing follows the proxy: world = proxy × offset, then into its parent's frame
    proxy.updateMatrixWorld(true);
    _m.multiplyMatrices(proxy.matrixWorld, offset);
    if (obj.parent) { obj.parent.updateWorldMatrix(true, false); _m.premultiply(obj.parent.matrixWorld.clone().invert()); }
    _m.decompose(obj.position, obj.quaternion, obj.scale);
  }
  if (controls.mode === 'scale' && start && !V4.isV4()) {   // v1: one number; a v4 transform scales per axis (R 10-04)
    // whichever handle moved, the thing scales uniformly by that ratio
    const ax = (controls.axis ?? 'X')[0].toLowerCase();
    const k = ['x', 'y', 'z'].includes(ax) ? obj.scale[ax] / start.scale : obj.scale.x / start.scale;
    obj.scale.setScalar(THREE.MathUtils.clamp(start.scale * k, 0.1, 12));
  }
  reindexCollider(attachedId); refreshOutline();
  const now = performance.now();
  if (now - lastSent >= 66) {
    lastSent = now; const p = obj.position; const q = obj.quaternion;
    // yaw for older peers (the heading), q for everyone who reads it
    sendDrag(attachedId, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]);
  }
}
// the pivot tool's release: where the proxy ended, in the thing's own frame (before scale), snapped to the nearest
// hotspot of the model's box within 15 cm (centre, base, top, the 6 face centres, the 8 corners); one pivot write
function hotspots(box) {
  const [lo, hi] = box; const mid = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2); const out = [['centre', mid]];
  for (let i = 0; i < 3; i++) for (const [w, v] of [['min', lo[i]], ['max', hi[i]]]) { const p = [...mid]; p[i] = v; out.push([i === 1 ? (w === 'min' ? 'base' : 'top') : `${'xyz'[i]} ${w === 'min' ? '−' : '+'} face`, p]); }
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) out.push(['corner', [x, y, z]]);
  return out;
}
function endPivotDrag() {
  const id = attachedId; const obj = id && entities.get(id); start = null;
  if (cancelled) { cancelled = false; return; }
  if (!obj) return;
  obj.updateWorldMatrix(true, false);
  let p = proxy.position.clone().applyMatrix4(obj.matrixWorld.clone().invert()).toArray().map((v) => Math.round(v * 1e4) / 1e4);
  const box = boxOf(id); let snapped = null;
  if (box) { const s = obj.getWorldScale(new THREE.Vector3()); let best = null;
    for (const [name, h] of hotspots(box)) { const d = Math.hypot(...h.map((v, i) => (v - p[i]) * [s.x, s.y, s.z][i])); if (d < 0.15 && (!best || d < best.d)) best = { name, h, d }; }
    if (best) { p = best.h.map((v) => Math.round(v * 1e4) / 1e4); snapped = best.name; } }
  const data = p.every((v) => v === 0) ? null : { pos: p };   // back at the origin = no pivot
  const verbs = [{ verb: 'comp', args: { id, type: 'pivot', data } }];
  if (V4.isV4()) V4.sendVerbsV4(verbs, { what: `pivot of ${id}`, expect: false });
  else { pushUndo({ verb: 'comp', args: { id, type: 'pivot', data: comps.get(id)?.pivot ?? null } }, `pivot of ${id}`); import('./net.js').then((m) => m.sendVerb('comp', verbs[0].args)); }
  import('./ui.js').then((m) => m.flashHint(snapped ? `pivot → <b>${snapped}</b>` : data ? 'pivot moved — the thing stays where it is' : 'pivot back at the origin', 2200));
  bus.emit('pivot-set', { id, pos: p, snapped });
}
function endDrag() {
  if (getTool() === 'pivot') { endPivotDrag(); return; }
  if (cancelled) { cancelled = false; start = null; return; }
  const id = attachedId; const obj = id && entities.get(id);
  if (!obj || !start?.rec) { start = null; return; }
  const rec = foldRecord(id) ?? start.rec;
  // only the fields this gesture moved and this thing HAS (shared/editschema.js
  // poseEdits) — editVerbs coalesces them into one place carrying the full pose
  const mode = { translate: 'move', rotate: 'rotate', scale: 'scale' }[controls.mode];
  const o = obj.quaternion;
  const pose = { pos: obj.position.toArray(), q: [o.x, o.y, o.z, o.w], scale: V4.isV4() ? obj.scale.toArray() : obj.scale.x };
  // about a pivot, a turn or a size ALSO moves the origin (it swings round the pivot): send the position with it
  const set = viaProxy && mode !== 'move' ? { ...poseEdits(rec, id, 'move', pose), ...poseEdits(rec, id, mode, pose) } : poseEdits(rec, id, mode, pose);
  const { verbs, errors } = editVerbs(rec, id, set, V4.isV4() ? { doorLocks: true } : undefined);   // v4: the door asks about locks
  if (errors.length || !verbs.length) { start = null; return; }
  if (V4.isV4()) {   // presence until now; the release is ONE request, expecting where the drag started
    const what = `${controls.mode === 'translate' ? 'move' : controls.mode === 'rotate' ? 'turn' : 'size'} ${id}`;
    const base = start.v4 ? { [id]: start.v4 } : null; start = null;
    bus.emit('gizmo-v4', { id, verbs });
    V4.sendVerbsV4(verbs, { what, base, revert: () => V4.revertPose(id) });
    return;
  }
  for (const v of verbs) {
    const inv = inverseOf(v, start.rec, id);
    if (inv) pushUndo(inv, `${controls.mode === 'translate' ? 'moving' : controls.mode === 'rotate' ? 'turning' : 'sizing'} ${id}`);
    bus.emit('gizmo-commit', v);
  }
  start = null;
}
/** The commit itself rides one seam so the bench can watch it; net.js speaks the wire. */
bus.on('gizmo-commit', (v) => import('./net.js').then((m) => m.sendVerb(v.verb, v.args)));

/** Esc mid-drag (v4 only; a v1 world's Esc is unchanged): cancel the gesture. */
function cancelDrag() {
  if (!V4.isV4() || !start || !attachedId) return false;
  cancelled = true; V4.revertPose(attachedId); refreshOutline();
  import('./ui.js').then((m) => m.flashHint('cancelled — nothing written'));
  return true;
}

export function initGizmo() {
  setEscapeHook(cancelDrag);
  registerSystem('gizmo', sync, { every: 4 });   // selection/tool/lock changes are rare; a few frames' lag is invisible
  bus.on('tool', sync); bus.on('tool-space', sync); bus.on('sg:selected', sync); bus.on('edit-mode', sync); bus.on('comp', sync);
  globalThis.__gizmo = () => ({ attached: attachedId, viaProxy, proxyPos: proxy.position.toArray(), mode: controls?.mode ?? null, showX: controls?.showX, showZ: controls?.showZ, controls });   // harness window
}
