// multimove — the rest of the selection follows the thing being dragged (R, gym 10-17 21:40: "shift-selecting entities in
// the hierarchy and moving them in the viewport still only moves the primary selected object instead of all of them").
//
// Unity / Godot / Blender: drag one handle and EVERY selected thing moves by the same delta. Here the dragged thing (the
// gizmo's, or the mesh you grabbed) is the LEAD; each other selected thing is a FOLLOWER, and on release the lead's write
// and the followers' go out as ONE request (a batch): one act, one Ctrl+Z, one lock question for the lot.
//
// The convention for a turn or a size is the multi-selection Inspector's (editpanels multiFields: typing a channel sets
// it on EACH thing, in its own frame): each follower turns or sizes about ITS OWN pivot (its `pivot` comp; else its
// origin) — Unity's Pivot mode, Blender's Individual Origins. A move is the lead's world delta, added to each.
//   rotate, world axes: each follower turns by the lead's world turn Δ about its own pivot point
//   rotate, own axes:   each turns by the lead's LOCAL turn, about its own axes
//   scale:              each follower's scale × the lead's per-axis ratio, in its own axes, about its own pivot
// A follower whose parent (anywhere up its chain) is also selected rides that parent and is left out: never moved twice.
// So is an ancestor of the lead (the lead moves as dragged). Things are drawn in three's tree as they ride (realize/
// models.js), so ancestry is read off the objects.
import { THREE } from '../core.js';
import { entities, bagOf } from '../world.js';
import { sendDrag } from '../net.js';
import { reindexCollider } from '../colliders.js';
import * as Sel from './selection.js';
import * as Edits from './writes.js';

const idOf = (o) => o?.userData?.entityId ?? null;
/** Is any of `obj`'s ancestors one of `set`'s things? */
function underAny(obj, set) { for (let o = obj?.parent; o; o = o.parent) { const id = idOf(o); if (id != null && set.has(id)) return true; } return false; }
const pivotOf = (id) => { const p = bagOf(id)?.pivot?.pos; return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p : [0, 0, 0]; };

/** The selected things that follow `leadId`: every other live selected thing, minus those riding a selected thing, minus
 *  the lead's own ancestors. `ok(id)` may refuse one (a gesture it can't take): it is skipped, and named in `.skipped`. */
export function followersOf(leadId, ok = () => true) {
  const s = Sel.selection();
  if (s.kind !== 'things' || !s.ids.includes(leadId) || s.ids.length < 2) return { ids: [], skipped: [] };
  const live = s.ids.filter((id) => entities.get(id));
  const set = new Set(live);
  const lead = entities.get(leadId);
  const ids = [], skipped = [];
  for (const id of live) {
    if (id === leadId) continue;
    const o = entities.get(id);
    if (underAny(o, set)) continue;                                   // it rides a selected thing: that one carries it
    let anc = false; for (let p = lead?.parent; p; p = p.parent) if (p === o) anc = true;
    if (anc) continue;                                                // the lead rides IT
    if (!ok(id)) { skipped.push(id); continue; }
    ids.push(id);
  }
  return { ids, skipped };
}

const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Take the start: the lead's world turn and local scale, each follower's world matrix and pivot. */
export function begin(leadId, ids) {
  const lead = entities.get(leadId); if (!lead || !ids.length) return null;
  lead.updateWorldMatrix(true, false);
  lead.matrixWorld.decompose(_p, _q, _s);
  const st = { leadId, leadPos: _p.clone(), leadQ: _q.clone(), leadScale: lead.scale.clone(), lastSent: 0, followers: [] };
  for (const id of ids) {
    const o = entities.get(id); if (!o) continue;
    o.updateWorldMatrix(true, false);
    st.followers.push({ id, world: o.matrixWorld.clone(), pivot: new THREE.Vector3(...pivotOf(id)), q: o.getWorldQuaternion(new THREE.Quaternion()), comps: Edits.compsOf(id) });
  }
  return st.followers.length ? st : null;
}

/** Move the followers by what the lead has done since begin. mode: 'move' | 'rotate' | 'scale'; space: 'world' | 'local'
 *  (a turn's axes). Presence only: others see it at pose cadence. */
export function apply(st, mode, space = 'world') {
  const lead = st && entities.get(st.leadId); if (!lead) return;
  lead.updateWorldMatrix(true, false);
  lead.matrixWorld.decompose(_p, _q, _s);
  const dPos = _p.clone().sub(st.leadPos);
  const dWorld = _q.clone().multiply(st.leadQ.clone().invert());            // the lead's world turn
  const dLocal = st.leadQ.clone().invert().multiply(_q);                    // …in its own axes
  const ratio = new THREE.Vector3(lead.scale.x / (st.leadScale.x || 1), lead.scale.y / (st.leadScale.y || 1), lead.scale.z / (st.leadScale.z || 1));
  const now = performance.now(); const relay = now - st.lastSent >= 66; if (relay) st.lastSent = now;
  for (const f of st.followers) {
    const o = entities.get(f.id); if (!o) continue;
    const W = f.world.clone();
    const toPiv = new THREE.Matrix4().makeTranslation(f.pivot.x, f.pivot.y, f.pivot.z), fromPiv = new THREE.Matrix4().makeTranslation(-f.pivot.x, -f.pivot.y, -f.pivot.z);
    if (mode === 'move') W.premultiply(_m.makeTranslation(dPos.x, dPos.y, dPos.z));
    else if (mode === 'rotate') {
      // a world turn about the follower's pivot point P (its pivot through its start matrix); own axes: the lead's local
      // turn carried into the follower's frame, q Δl q⁻¹ (in world terms, so a stretched thing never shears)
      const dq = space === 'local' ? f.q.clone().multiply(dLocal).multiply(f.q.clone().invert()) : dWorld;
      const P = f.pivot.clone().applyMatrix4(f.world);
      W.premultiply(new THREE.Matrix4().makeTranslation(P.x, P.y, P.z).multiply(_m.makeRotationFromQuaternion(dq)).multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z)));
    } else if (mode === 'scale') W.multiply(toPiv.clone().multiply(_m.makeScale(ratio.x, ratio.y, ratio.z)).multiply(fromPiv));
    if (o.parent) { o.parent.updateWorldMatrix(true, false); W.premultiply(_m.copy(o.parent.matrixWorld).invert()); }
    W.decompose(o.position, o.quaternion, o.scale);
    o.updateMatrixWorld(true);
    reindexCollider(f.id);
    if (relay) { const p = o.position, q = o.quaternion; sendDrag(f.id, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]); }
  }
}

/** The followers' writes, by `opsFor(id, obj)` (each surface's own: the gizmo's poseEdits, the mesh drag's setTransform).
 *  Returns { ops, base, errors } — base: id → its components at the start, for the release's expect. */
export function ops(st, opsFor) {
  const out = { ops: [], base: {}, errors: [] };
  for (const f of st?.followers ?? []) {
    const o = entities.get(f.id); if (!o) continue;
    const r = opsFor(f.id, o) ?? { ops: [] };
    out.errors.push(...(r.errors ?? []));
    if (r.ops?.length) { out.ops.push(...r.ops); if (f.comps) out.base[f.id] = f.comps; }
  }
  return out;
}

/** Put every follower back where the log has it (Esc, a refusal, a cancelled lock question). */
export function revert(st) { for (const f of st?.followers ?? []) Edits.revertPose(f.id); }
/** The last pose sample, so others drop the claim at once. */
export function end(st) {
  for (const f of st?.followers ?? []) { const o = entities.get(f.id); if (o) sendDrag(f.id, o.position.toArray(), new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y, o.quaternion.toArray(), { end: true }); }
}
