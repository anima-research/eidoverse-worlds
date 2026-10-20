// arrivalnear — the arrival hold's rules (arrivalhold.js), kept free of the
// page so tools/arrival-hold-test.ts can run them: which placed models are
// still on their way, and which of those are near a body.

/** How near the circle around a model's footprint has to come to the body to matter (m, across the ground). */
export const NEAR = 16;

/** A tracked model's arrival: is more of it still coming here? A load in
 *  flight is, a retry included, and so is a realized model whose promote tail,
 *  which fits its collider, is still queued. A stand-in (a bare reservation,
 *  null, or a placeholder) is while the realizer will load it: within its
 *  residency radius, and not waiting out a failed load's back-off. A model
 *  realized and fitted has arrived, collider or not (decorative, a structure's
 *  walls, mounted cargo, a reduced tier): nothing more of it is coming. So has
 *  an id the realizer holds nothing for (undefined).
 *  t: the realizer's tracked entry ({ kind, loading? }); obj: what it holds for
 *  the id (realize/models.js `entities`); tailPending, resident, backingOff:
 *  its answers for the id (models.js modelArriving). */
export function stillArriving(t, obj, { tailPending = false, resident = false, backingOff = false } = {}) {
  if (!t || t.kind !== 'model') return false;
  if (t.loading || tailPending) return true;
  const standIn = obj === null || Boolean(obj?.userData?.placeholder);
  return standIn && resident && !backingOff;
}

/** A placed value as the realizer renders it: three.js takes a numeric string
 *  as its number. Absent or empty is NaN. */
const num = (v) => (v == null || v === '' ? NaN : Number(v));

/** Where a placed model stands on the ground: its footprint's centre (x, z)
 *  and the radius r of the circle around it, from the server's geom bbox
 *  ({ center, size }, model-local) placed as the entity is (pos, yaw, scale).
 *  Until the geom has said the model's size, or while its place isn't a
 *  number, r is Infinity: a model that can't be ruled out is near. */
export function footprintOf(ent, geom) {
  const sc = num(ent?.scale), s = sc > 0 ? sc : 1;
  const yw = num(ent?.yaw), yaw = Number.isFinite(yw) ? yw : 0;
  const [px, , pz] = Array.isArray(ent?.pos) ? ent.pos.map(num) : [NaN, NaN, NaN];
  const b = geom?.bbox;
  if (!Number.isFinite(px) || !Number.isFinite(pz) || !Array.isArray(b?.size)) return { x: px, z: pz, r: Infinity };
  const [cx = 0, , cz = 0] = Array.isArray(b.center) ? b.center : [];
  // the bbox centre turned as the model is (three.js rotation.y) and scaled
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  return {
    x: px + (cx * c + cz * sn) * s,
    z: pz + (-cx * sn + cz * c) * s,
    r: (Math.hypot(b.size[0] ?? 0, b.size[2] ?? 0) / 2) * s,
  };
}

/** The solid placed models still on their way whose footprint's circle comes
 *  within NEAR of (x, z). Lights and `collide: "none"` never will be solid.
 *  arriving(id) and footprint(id, ent) are the realizer's (realize/models.js
 *  modelArriving, modelFootprint). With `first`, stops at the first. */
export function arrivingNear(x, z, entities, arriving, footprint, first = false) {
  const ids = [];
  for (const [id, e] of Object.entries(entities ?? {})) {
    if (!e || !e.lib || e.lib === '(light)' || e.collide === 'none' || !Array.isArray(e.pos) || !arriving(id)) continue;
    const f = footprint(id, e);
    if (Math.hypot(f.x - x, f.z - z) > NEAR + f.r) continue;
    ids.push(id);
    if (first) break;
  }
  return ids;
}
