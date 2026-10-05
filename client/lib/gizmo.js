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

const MODE = { move: 'translate', rotate: 'rotate', scale: 'scale' };
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
  if (!want) { if (attachedId) { controls?.detach(); attachedId = null; } return; }
  const c = ensure();
  if (attachedId !== want) { c.attach(entities.get(want)); attachedId = want; }
  const mode = MODE[getTool()];
  if (c.mode !== mode) c.setMode(mode);
  const sp = getSpace(getTool()) === 'object' ? 'local' : 'world';
  if (c.space !== sp) c.setSpace(sp);   // the tool's space (build.js SPACES)
  // every axis: rotate commits q; scale is per axis in a v4 world, uniform in v1 (onChange)
  c.showX = true; c.showZ = true; c.showY = true;
}

function beginDrag() {
  if (!attachedId) return;
  const rec = foldRecord(attachedId);
  start = rec ? { rec: JSON.parse(JSON.stringify(rec)), scale: entities.get(attachedId).scale.x, ...(V4.isV4() ? { v4: V4.compsOf(attachedId) } : {}) } : null;
  cancelled = false;
}
function onChange() {
  const obj = attachedId && entities.get(attachedId); if (!obj) return;
  if (cancelled) { bus.emit('pose-revert', { id: attachedId }); return; }   // Esc held it where the log has it
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
function endDrag() {
  if (cancelled) { cancelled = false; start = null; return; }
  const id = attachedId; const obj = id && entities.get(id);
  if (!obj || !start?.rec) { start = null; return; }
  const rec = foldRecord(id) ?? start.rec;
  // only the fields this gesture moved and this thing HAS (shared/editschema.js
  // poseEdits) — editVerbs coalesces them into one place carrying the full pose
  const mode = { translate: 'move', rotate: 'rotate', scale: 'scale' }[controls.mode];
  const o = obj.quaternion;
  const set = poseEdits(rec, id, mode, { pos: obj.position.toArray(), q: [o.x, o.y, o.z, o.w], scale: V4.isV4() ? obj.scale.toArray() : obj.scale.x });
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
  globalThis.__gizmo = () => ({ attached: attachedId, mode: controls?.mode ?? null, showX: controls?.showX, showZ: controls?.showZ, controls });   // harness window
}
