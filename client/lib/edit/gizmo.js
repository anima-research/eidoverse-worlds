// gizmo — three's TransformControls on the selected thing, in build mode: the precise version of build.js's drag.
// build.js vetoes its mesh-grab while a handle is hot (setPointerVeto); both commit the same way: ONE request with the
// full pose on release, others watching the drag at pose cadence. A thing whose transform is read-only gets no gizmo.

import { THREE, scene, camera, canvas } from '../core.js';
import { bus } from '../base.js';
import { entities, bagOf } from '../world.js';
import { sendDrag } from '../net.js';
import { registerSystem } from '../render/frameloop.js';
import { sceneSelected } from '../scenegraph.js';
import { getTool, getSpace, isBuilding, refreshOutline, setPointerVeto, setEscapeHook, onDragCancel } from './build.js';
import * as Edits from './writes.js';
import { reindexCollider } from '../colliders.js';
import { engage, release } from './keyhints.js';
import { boxOf } from '../realize/models.js';
import { foldRecord } from './inspect.js';
import { editOps, poseEdits } from '../../../shared/editschema.js';
import * as OP from '../../../shared/requests.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { gripEditing } from './gripedit.js';
import * as MM from './multimove.js';   // the rest of the selection follows the drag (R, gym 10-17 21:40)

const R2D = 180 / Math.PI;
let controls = null;
let helper = null;
let attachedId = null;
let start = null;        // { rec, comps? } at drag start (the components the release's expect names)
let cancelled = false;   // Esc during the drag: the thing goes back, the release writes nothing
let multi = null;        // the other selected things following this drag (edit/multimove.js), or null
let gen = 0;             // this drag's generation (MM.hold): a late refusal of an older one leaves its things to this one
let dragTool = null;     // the tool at the press: a tool key mid-drag changes the next drag, not this one (#352 review, point 4)
let lastSent = 0;
// the pivot (Roblox's PivotOffset): with a `pivot` comp the handles ride a PROXY at the pivot, oriented as the thing,
// and the thing follows it: objWorld = proxy × offset (offset fixed at drag start), so a turn or a size goes about the pivot.
const proxy = new THREE.Object3D(); proxy.name = 'edit-gizmo-pivot';
let viaProxy = false, offset = null;
const _m = new THREE.Matrix4(), _pq = new THREE.Quaternion(), _pp = new THREE.Vector3(), _ps = new THREE.Vector3();
const pivotOf = (id) => { const p = bagOf(id)?.pivot?.pos; return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p : null; };
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
  addEventListener('keydown', (e) => { if (e.key === 'Control') {   // keys: gizmo
    controls.setTranslationSnap(0.1); controls.setRotationSnap(5 / R2D); controls.setScaleSnap(0.1); } });
  addEventListener('keyup', (e) => { if (e.key === 'Control') {   // keys: gizmo
    controls.setTranslationSnap(null); controls.setRotationSnap(null); controls.setScaleSnap(null); } });
  return controls;
}

const MODE = { move: 'translate', rotate: 'rotate', scale: 'scale', pivot: 'translate' };
/** Can this thing take THIS gesture? A thing riding a part socket can't be dragged. A lock doesn't stop the drag: the
 *  release asks the authority, which asks a person who may lift it. */
const editable = MM.takes;   // the gesture test the followers share (edit/multimove.js)

function sync() {
  // a drag in flight keeps its handles even if a lock lands meanwhile: the release asks the authority. Leaving build mode or
  // a selection without its thing first cancels it as Esc does (#352 review 8d7c6b9, points 2, 3)
  if (start) { if (!cancelled && (!isBuilding() || sceneSelected() !== attachedId)) cancelDrag(); return; }
  const id = sceneSelected();
  const want = isBuilding() && !gripEditing() && id && MODE[getTool()] && editable(id, MODE[getTool()]) ? id : null;   // the grip editor's handles replace these
  if (!want) { if (attachedId) { controls?.detach(); attachedId = null; viaProxy = false; } return; }
  const c = ensure();
  const obj = entities.get(want); const piv = pivotOf(want) ?? (getTool() === 'pivot' ? [0, 0, 0] : null);   // the pivot tool starts at the origin when there is none
  if (piv && !controls?.dragging) { if (!proxy.parent) scene.add(proxy); seatProxy(obj, piv); }   // between drags it follows the thing (others move it too)
  if (attachedId !== want || viaProxy !== !!piv) { c.attach(piv ? proxy : obj); attachedId = want; viaProxy = !!piv; }
  const mode = MODE[getTool()];
  if (c.mode !== mode) c.setMode(mode);
  const sp = getSpace(getTool()) === 'object' ? 'local' : 'world';
  if (c.space !== sp) c.setSpace(sp);   // the tool's space (build.js SPACES)
  // every axis: rotate commits q; scale is per axis
  c.showX = true; c.showZ = true; c.showY = true;
}

function beginDrag() {
  if (!attachedId) return;
  engage('gizmo');
  if (viaProxy) { const obj = entities.get(attachedId); obj.updateWorldMatrix(true, false); proxy.updateMatrixWorld(true); offset = proxy.matrixWorld.clone().invert().multiply(obj.matrixWorld); }
  const rec = foldRecord(attachedId);
  start = rec ? { rec: JSON.parse(JSON.stringify(rec)), comps: Edits.compsOf(attachedId) } : null;
  cancelled = false;
  dragTool = getTool();
  // every other selected thing moves with it (the pivot tool moves one thing's pivot: never a group's). One that can't take
  // this gesture (a part socket's occupant) stays put, and the hint says so
  multi = null;
  if (start && dragTool !== 'pivot') {
    const f = MM.followersOf(attachedId, (id) => editable(id, controls.mode));
    // over the cap the drag doesn't start: held where the log has it (as Esc holds it), nothing written
    if (1 + f.ids.length > MM.MAX_GROUP) { cancelled = true; import('../ui/ui.js').then((m) => m.flashHint(MM.tooManyHint(1 + f.ids.length), 6000)); return; }
    multi = MM.begin(attachedId, f.ids);
    gen = MM.hold(MM.idsOf(attachedId, multi));
    if (f.skipped.length) import('../ui/ui.js').then((m) => m.flashHint(MM.skippedHint(f.skipped.length, controls.mode), 3500));
  }
}
const gizmoGesture = () => ({ translate: 'move', rotate: 'rotate', scale: 'scale' }[controls?.mode] ?? 'move');
function onChange() {
  const obj = attachedId && entities.get(attachedId); if (!obj) return;
  if (cancelled) { bus.emit('pose-revert', { id: attachedId }); for (const f of multi?.followers ?? []) bus.emit('pose-revert', { id: f.id }); return; }   // Esc held it where the log has it
  if (dragTool === 'pivot') { refreshOutline(); return; }   // the pivot tool moves the pivot only: the thing stays
  if (viaProxy && offset) {   // the thing follows the proxy: world = proxy × offset, then into its parent's frame
    proxy.updateMatrixWorld(true);
    _m.multiplyMatrices(proxy.matrixWorld, offset);
    if (obj.parent) { obj.parent.updateWorldMatrix(true, false); _m.premultiply(obj.parent.matrixWorld.clone().invert()); }
    _m.decompose(obj.position, obj.quaternion, obj.scale);
  }
  reindexCollider(attachedId); refreshOutline();
  if (multi) MM.apply(multi, gizmoGesture(), controls.space === 'local' ? 'local' : 'world');
  const now = performance.now();
  if (now - lastSent >= 66) {
    lastSent = now; const p = obj.position; const q = obj.quaternion;
    // yaw for older peers (the heading), q for everyone who reads it
    sendDrag(attachedId, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]);
  }
}
// the pivot tool's release: where the proxy ended, in the thing's own frame (before scale), snapped to the nearest
// hotspot of the model's box within 15 cm (centre, the 6 face centres with base and top among them, the 8 corners);
// one pivot write
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
  Edits.sendOps([data ? OP.set(id, 'pivot', data) : OP.unset(id, 'pivot')], { what: `pivot of ${id}`, expect: false });
  import('../ui/ui.js').then((m) => m.flashHint(snapped ? m.html`pivot → <b>${snapped}</b>` : data ? 'pivot moved — the thing stays where it is' : 'pivot back at the origin', 2200));
  bus.emit('pivot-set', { id, pos: p, snapped });
}
function endDrag() {
  release();
  const m = multi; multi = null;
  if (dragTool === 'pivot') { endPivotDrag(); return; }   // a pivot drag (it has no followers); a switch to pivot mid-drag is not one
  if (cancelled) { cancelled = false; start = null; MM.end(m); return; }
  const id = attachedId; const obj = id && entities.get(id);
  if (!obj || !start?.rec) { start = null; MM.revert(m); MM.end(m); return; }
  const rec = foldRecord(id) ?? start.rec;
  // only the fields this gesture moved and this thing HAS (shared/editschema.js poseEdits); editOps makes them one transform
  const mode = { translate: 'move', rotate: 'rotate', scale: 'scale' }[controls.mode];
  const o = obj.quaternion;
  const pose = { pos: obj.position.toArray(), q: [o.x, o.y, o.z, o.w], scale: obj.scale.toArray() };
  // about a pivot, a turn or a size ALSO moves the origin (it swings round the pivot): send the position with it
  const set = viaProxy && mode !== 'move' ? { ...poseEdits(rec, id, 'move', pose), ...poseEdits(rec, id, mode, pose) } : poseEdits(rec, id, mode, pose);
  const { ops, errors } = editOps(rec, id, set);   // the authority asks about locks
  if (errors.length || !ops.length) { start = null; MM.revert(m); MM.end(m); return; }
  // the followers' writes ride the same request: each one's own fields (a turn about its pivot moves its origin too)
  const more = MM.ops(m, (fid) => { const fr = foldRecord(fid); if (!fr) return null;
    const o2 = entities.get(fid).quaternion; const fp = { pos: entities.get(fid).position.toArray(), q: [o2.x, o2.y, o2.z, o2.w], scale: entities.get(fid).scale.toArray() };
    return editOps(fr, fid, mode === 'move' ? poseEdits(fr, fid, 'move', fp) : { ...poseEdits(fr, fid, 'move', fp), ...poseEdits(fr, fid, mode, fp) }); });
  if (more.errors.length) { start = null; MM.revert(m); MM.end(m); Edits.revertPose(id); import('../ui/ui.js').then((u) => u.flashHint(more.errors.join(' · '), 5000)); return; }
  const all = [...ops, ...more.ops];
  // the drag was presence; the release is ONE request (one act, one Ctrl+Z, one lock question for the lot), expecting where the drag started
  const n = 1 + (m?.followers.length ?? 0);
  const what = `${controls.mode === 'translate' ? 'move' : controls.mode === 'rotate' ? 'turn' : 'size'} ${n > 1 ? `${n} things` : id}`;
  const base = start.comps || Object.keys(more.base).length ? { ...(start.comps ? { [id]: start.comps } : {}), ...more.base } : null; start = null;
  bus.emit('gizmo-release', { id, ops: all, ids: [id, ...(m?.followers.map((f) => f.id) ?? [])] });
  const g = gen; Edits.sendOps(all, { what, base, revert: () => MM.revertHeld(g, MM.idsOf(id, m)) });
  MM.end(m);   // after the request, so it never queues behind the followers' last samples
}

/** Esc mid-drag: cancel the gesture (nothing is written; the thing goes back). */
function cancelDrag() {
  if (!start || !attachedId) return false;
  cancelled = true; Edits.revertPose(attachedId); MM.revert(multi); refreshOutline();
  import('../ui/ui.js').then((m) => m.flashHint('cancelled — nothing written'));
  return true;
}

export function initGizmo() {
  setEscapeHook(cancelDrag);
  onDragCancel(() => { if (!cancelled) cancelDrag(); });   // a deselect or an undo mid-drag (build.js deselect)
  registerSystem('gizmo', sync, { every: 4 });   // selection/tool/lock changes are rare; a few frames' lag is invisible
  bus.on('tool', sync); bus.on('tool-space', sync); bus.on('selection', sync); bus.on('build-mode', sync); bus.on('comp', sync); bus.on('grip-edit', sync);
  globalThis.__gizmo = () => ({ attached: attachedId, viaProxy, proxyPos: proxy.position.toArray(), mode: controls?.mode ?? null, showX: controls?.showX, showZ: controls?.showZ, controls });   // harness window
}
