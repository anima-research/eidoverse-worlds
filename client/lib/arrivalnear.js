// arrivalnear — the arrival hold's rules (arrivalhold.js), kept free of the
// page so test/client/arrival-hold-test.ts can run them: which placed models are
// still on their way, and which of those are near a body.

import { solidOff } from '../../shared/protocol/simlayer.js';
import { qNorm, qFromYaw, qRotate } from '../../shared/rot.js';
import { scale3 } from '../../shared/scale3.js';

/** How near the circle around a model's footprint has to come to the body to matter (m, across the ground). */
export const NEAR = 16;

/** A tracked model's arrival: is more of it still coming here? A stand-in's
 *  load in flight is, a retry included, and so is a realized model whose
 *  promote tail, which fits its collider, is still queued. A stand-in (a bare
 *  reservation, null, or a placeholder) is while the realizer will or may load
 *  it: as models.js modelArriving says, within its residency radius or of a
 *  size the geom has yet to give, and not waiting out a failed load's back-off.
 *  A model realized and fitted has arrived, collider or not (decorative, a
 *  structure's walls, mounted cargo, a reduced tier), and stays arrived while
 *  it fetches another tier: its collider stands meanwhile. So has an id the
 *  realizer holds nothing for (undefined).
 *  t: the realizer's tracked entry ({ kind, loading? }); obj: what it holds for
 *  the id (realize/models.js `entities`); tailPending, resident, backingOff:
 *  its answers for the id (models.js modelArriving). */
export function stillArriving(t, obj, { tailPending = false, resident = false, backingOff = false } = {}) {
  if (!t || t.kind !== 'model') return false;
  if (tailPending) return true;
  const standIn = obj === null || Boolean(obj?.userData?.placeholder);
  if (t.loading) return standIn;   // over a realized model, a load is a re-tier: its collider stands meanwhile
  return standIn && resident && !backingOff;
}

/** A placed value as the realizer renders it: three.js takes a numeric string
 *  as its number. Absent or empty is NaN. */
const num = (v) => (v == null || v === '' ? NaN : Number(v));

/** Where a placed model stands on the ground: its footprint's centre (x, z)
 *  and the radius r of the circle around it, from the server's geom bbox
 *  ({ center, size }, model-local) placed at its WORLD pose ({ pos, q or yaw,
 *  scale: one number or [x, y, z] }; for a parented model, its chain folded:
 *  shared/hierarchy.js worldPose, as the renderer places it). The circle holds
 *  every corner of the box as turned, so a tilted model's height counts too.
 *  Until the geom has said the model's size, or while its place isn't a
 *  number, r is Infinity: a model that can't be ruled out is near. */
export function footprintOf(pose, geom) {
  const [px, , pz] = Array.isArray(pose?.pos) ? pose.pos.map(num) : [NaN, NaN, NaN];
  const b = geom?.bbox;
  if (!Number.isFinite(px) || !Number.isFinite(pz) || !Array.isArray(b?.size)) return { x: px, z: pz, r: Infinity };
  const yw = num(pose.yaw);
  const q = qNorm(pose.q) ?? qFromYaw(Number.isFinite(yw) ? yw : 0);
  const s = scale3(pose.scale).map((v) => (num(v) > 0 ? num(v) : 1));
  const size = [0, 1, 2].map((i) => num(b.size[i]) || 0);
  const c = Array.isArray(b.center) ? [0, 1, 2].map((i) => num(b.center[i]) || 0) : [0, size[1] / 2, 0];   // realize/models.js libBox's default
  // the box's centre and corners scaled, then turned, as three.js renders it (scale, then rotation)
  const at = (v) => qRotate(q, [v[0] * s[0], v[1] * s[1], v[2] * s[2]]);
  const o = at(c);
  let r = 0;
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const k = at([c[0] + sx * size[0] / 2, c[1] + sy * size[1] / 2, c[2] + sz * size[2] / 2]);
    r = Math.max(r, Math.hypot(k[0] - o[0], k[2] - o[2]));
  }
  return { x: px + o[0], z: pz + o[2], r };
}

/** The solid placed models still on their way whose footprint's circle comes
 *  within NEAR of (x, z). Lights and collision off (collider.enabled: false) never will be solid.
 *  arriving(id) and footprint(id, ent) are the realizer's (realize/models.js
 *  modelArriving, modelFootprint). With `first`, stops at the first. */
export function arrivingNear(x, z, entities, arriving, footprint, first = false) {
  const ids = [];
  for (const [id, e] of Object.entries(entities ?? {})) {
    // a model's path is `model` (a light has none); collision off is collider.enabled / blocks (simlayer.js solidOff)
    if (!e || !e.model || solidOff(e, 'bodies') || !Array.isArray(e.pos) || !arriving(id)) continue;
    const f = footprint(id, e);
    if (Math.hypot(f.x - x, f.z - z) > NEAR + f.r) continue;
    ids.push(id);
    if (first) break;
  }
  return ids;
}
