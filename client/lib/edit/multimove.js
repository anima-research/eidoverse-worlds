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
// A follower whose parent (anywhere up its chain) also moves rides that parent and is left out: never moved twice.
// So is an ancestor of the lead (the lead moves as dragged). Things are drawn in three's tree as they ride (realize/
// models.js), so ancestry is read off the objects.
import { THREE } from '../core.js';
import { entities, bagOf } from '../world.js';
import { sendDrag } from '../net.js';
import { reindexCollider } from '../colliders.js';
import * as Sel from './selection.js';
import * as Edits from './writes.js';
import { foldRecord } from './inspect.js';
import { inspectSchema, fieldAt } from '../../../shared/editschema.js';

const idOf = (o) => o?.userData?.entityId ?? null;
/** Is any of `obj`'s ancestors one of `set`'s things? */
function underAny(obj, set) { for (let o = obj?.parent; o; o = o.parent) { const id = idOf(o); if (id != null && set.has(id)) return true; } return false; }
const pivotOf = (id) => { const p = bagOf(id)?.pivot?.pos; return Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p : [0, 0, 0]; };

/** The selected things that follow `leadId`: every other live selected thing, minus those riding a thing that moves (the
 *  lead or a follower), minus the lead's own ancestors. `ok(id)` may refuse one (a gesture it can't take): it is skipped,
 *  and named in `.skipped`. Ancestors are decided first, so a thing under one that stays put follows on its own. */
export function followersOf(leadId, ok = () => true) {
  const s = Sel.selection();
  if (s.kind !== 'things' || !s.ids.includes(leadId) || s.ids.length < 2) return { ids: [], skipped: [] };
  const depth = (o) => { let d = 0; for (let p = o?.parent; p; p = p.parent) d++; return d; };
  const live = s.ids.filter((id) => id !== leadId && entities.get(id)).sort((x, y) => depth(entities.get(x)) - depth(entities.get(y)));
  const moves = new Set([leadId]);
  const lead = entities.get(leadId);
  const ids = [], skipped = [];
  for (const id of live) {
    const o = entities.get(id);
    if (underAny(o, moves)) continue;                                 // it rides a thing that moves: that one carries it
    let anc = false; for (let p = lead?.parent; p; p = p.parent) if (p === o) anc = true;
    if (anc) continue;                                                // the lead rides IT
    if (!ok(id)) { skipped.push(id); continue; }
    ids.push(id); moves.add(id);
  }
  return { ids, skipped };
}

/** Can `id` take this gesture (mode: 'move' | 'translate' | 'rotate' | 'scale')? The gizmo's attach test and both
 *  surfaces' follower filter. A parented thing: three parents it (realize/models.js), so its position IS the local
 *  transform pos.* edits; a thing riding a part socket (a moving node) stays out. */
export function takes(id, mode) {
  const rec = foldRecord(id); const obj = entities.get(id);
  const rides = !!rec?.parent;
  if (!rec || !obj || (rides && obj.parent !== entities.get(rec.parent.to ?? rec.parent))) return false;
  const f = fieldAt(inspectSchema(rec, id), mode === 'rotate' ? 'rot.qw' : mode === 'scale' ? 'pos.scale' : 'pos.x');
  return !!f && !f.disabled;
}
/** The hint for followers `takes` left out. */
export function skippedHint(n, mode) {
  const verb = mode === 'rotate' ? 'turn' : mode === 'scale' ? 'size' : 'move';
  return `${n} selected ${n === 1 ? "thing can't" : "things can't"} ${verb} this way — left where ${n === 1 ? 'it is' : 'they are'}`;
}

export const RELAY_PER_TICK = 1, RELAY_MS = 66;   // at 15 Hz: lead + pose + 1 follower ≈ 45 msg/s, under server/config.ts MSG_RATE (60)
export const CLAIM_MS = 1500;   // a live drag's claim lapses after this much silence (build.js claims)
// The most things one drag moves: 1 + CLAIM_MS / RELAY_MS × RELAY_PER_TICK = 23, so every follower is relayed before its claim
// lapses; END_BUDGET (every follower) closes all their claims at release, a burst well under the relay's 120 (#352 review, point 1)
export const MAX_GROUP = 1 + Math.floor(CLAIM_MS / RELAY_MS) * RELAY_PER_TICK, END_BUDGET = MAX_GROUP - 1;
/** Why a drag of `n` things (over MAX_GROUP) didn't start. */
export const tooManyHint = (n) => `${n} things selected — a drag moves at most ${MAX_GROUP} at once, so everyone watching sees each one move. Nothing moved`;
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4();

/** Take the start: the lead's world turn and local scale, each follower's world matrix and pivot. */
export function begin(leadId, ids) {
  const lead = entities.get(leadId); if (!lead || !ids.length) return null;
  lead.updateWorldMatrix(true, false);
  lead.matrixWorld.decompose(_p, _q, _s);
  const st = { leadId, leadPos: _p.clone(), leadQ: _q.clone(), leadScale: lead.scale.clone(), lastSent: 0, cursor: 0, followers: [] };
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
  const now = performance.now(); const relay = now - st.lastSent >= RELAY_MS; if (relay) st.lastSent = now;
  // followers share a relay budget: the server allows ~60 messages/s per connection, and a refused release snaps the
  // whole move back, so RELAY_PER_TICK followers' samples a tick (one), round-robin (the lead and the pose take the rest)
  const sendNow = new Set();
  if (relay) for (let k = 0; k < Math.min(RELAY_PER_TICK, st.followers.length); k++) sendNow.add((st.cursor++) % st.followers.length);
  for (const [i, f] of st.followers.entries()) {
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
    if (sendNow.has(i)) { const p = o.position, q = o.quaternion; sendDrag(f.id, [p.x, p.y, p.z], new THREE.Euler().setFromQuaternion(q, 'YXZ').y, [q.x, q.y, q.z, q.w]); }
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

// Each gesture's generation. A refusal or a cancelled lock question can answer after a newer gesture took some of the same
// things: it puts back only those no newer gesture has taken since (#352 review 8d7c6b9, point 5).
let gen = 0; const heldBy = new Map();   // id → the generation of the newest gesture that moved it
/** A gesture arms on these things (the lead and its followers): returns its generation. */
export function hold(ids) { const g = ++gen; for (const id of ids) heldBy.set(id, g); return g; }
/** Put back what gesture `g` still holds (each as revertPose does); a thing a newer gesture took stays that one's. */
export function revertHeld(g, ids) { for (const id of ids) if (heldBy.get(id) === g) Edits.revertPose(id); }
/** The ids a gesture holds: its lead and its followers. */
export const idsOf = (leadId, st) => [leadId, ...(st?.followers ?? []).map((f) => f.id)];
/** The last pose sample, so others drop the claim at once: for every follower (END_BUDGET covers a MAX_GROUP drag). Send
 *  it AFTER the release request, so the request never waits behind them. */
export function end(st) {
  for (const f of (st?.followers ?? []).slice(0, END_BUDGET)) { const o = entities.get(f.id); if (o) sendDrag(f.id, o.position.toArray(), new THREE.Euler().setFromQuaternion(o.quaternion, 'YXZ').y, o.quaternion.toArray(), { end: true }); }
}
