// shared/protocol/shaperepair.js — a value stored before the shape audit's wave 2 (physics-motion, 10-16), in today's
// spelling, with the meaning its readers gave it. Pure: a thing's components in, the repaired components out. Three
// callers, one rule set: the server's first load of a stored world (authority.js liftWorld: one system act,
// `repair-shapes`), translate-v1@12's projection (so a translated world needs no repair), and the old-world oracle's
// mirror of the load. A second run finds nothing to do.
//
// The rules (notes/eidoverse/shape-audit/physics-motion.md §4, §5, §7):
//   motion   a bare motion naming a `part` is that part's motion: motion:<part> (an existing motion:<part> wins);
//            amplitude → amp (amp wins); a letter axis (x, y, z, -x, -y, -z) → its vector;
//            a pendulum with no period read 3.5 s and with no damp 0 (motioneval.js): written down;
//            a whole motion's `pivot` field → the thing's pivot component (when it has none);
//            a whole PENDULUM with no pivot component swung about [0, 2, 0] (motioneval.js, before 10-16): that point is
//            written as its pivot component, because a whole thing now turns about its origin when it has none.
//   collider exact → mesh (one vocabulary with shapes.js, KHR, Unity, Godot).
//   physics  no kind read as the old materialized default, dynamic; material → surface (renamed); layers, mask, ccd
//            (cut, never read) are dropped.
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const AXIS_VECTORS = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], "-x": [-1, 0, 0], "-y": [0, -1, 0], "-z": [0, 0, -1] });
/** The pendulum readings that lived only in the reader (client/lib/motioneval.js, before 10-16). */
export const OLD_READINGS = Object.freeze({ pendulumPeriod: 3.5, pendulumDamp: 0, wholePendulumPivot: Object.freeze([0, 2, 0]) });
const isMotionKey = (k) => k === "motion" || k.startsWith("motion:");

/** One motion value in today's spelling (or the same object when nothing changes). */
export function repairMotion(m) {
  if (!bag(m)) return m;
  let out = m; const edit = () => (out === m ? (out = { ...m }) : out);
  if ("amplitude" in out) { edit(); if (out.amp === undefined && typeof out.amplitude === "number") out.amp = out.amplitude; delete out.amplitude; }
  if (typeof out.axis === "string" && AXIS_VECTORS[out.axis.toLowerCase()]) { edit(); out.axis = AXIS_VECTORS[out.axis.toLowerCase()].slice(); }
  if (out.type === "pendulum") {
    if (out.period === undefined) { edit(); out.period = OLD_READINGS.pendulumPeriod; }
    if (out.damp === undefined) { edit(); out.damp = OLD_READINGS.pendulumDamp; }
  }
  return out;
}

/** A thing's components repaired: {c (a new object when anything changed, else the same), set: [keys written], del: [keys
 *  removed]}. Only this family's names are touched; everything else is passed through as it is. */
export function repairComps(c0) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  const drop = (k) => { delete c[k]; del.add(k); set.delete(k); };
  // a bare motion naming a part is that part's motion
  if (bag(c.motion) && typeof c.motion.part === "string" && c.motion.part) {
    const { part, ...rest } = c.motion; const key = `motion:${part}`;
    if (!bag(c[key])) put(key, rest);
    drop("motion");
  } else if (bag(c.motion) && "part" in c.motion) { const { part: _p, ...rest } = c.motion; put("motion", rest); }   // a part that names nothing
  for (const k of Object.keys(c)) if (isMotionKey(k) && bag(c[k])) { const r = repairMotion(c[k]); if (r !== c[k]) put(k, r); }
  // a whole motion's hinge is the thing's pivot component
  if (bag(c.motion) && "pivot" in c.motion) {
    const { pivot, ...rest } = c.motion; put("motion", rest);
    if (!bag(c.pivot) && Array.isArray(pivot) && pivot.length === 3 && pivot.every(Number.isFinite)) put("pivot", { pos: pivot.slice() });
  }
  if (bag(c.motion) && c.motion.type === "pendulum" && !bag(c.pivot)) put("pivot", { pos: OLD_READINGS.wholePendulumPivot.slice() });
  if (bag(c.collider) && c.collider.shape === "exact") put("collider", { ...c.collider, shape: "mesh" });
  if (bag(c.physics)) { let p = c.physics; const edit = () => (p === c.physics ? (p = { ...c.physics }) : p);
    if (p.kind === undefined) { edit(); p.kind = "dynamic"; }
    if ("material" in p) { edit(); if (p.surface === undefined) p.surface = p.material; delete p.material; }
    for (const k of ["layers", "mask", "ccd"]) if (k in p) { edit(); delete p[k]; }
    if (p !== c.physics) put("physics", p); }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}

/** The ops that repair a folded state (every thing; @world holds none of these names): [{verb: "set"|"delete", id, comp,
 *  value?}], in id order. [] when nothing needs it. */
export function shapeRepairOps(st, purged = null) {
  const ops = [];
  for (const id of Object.keys(st?.entities ?? {}).sort()) { if (id === "@world") continue;
    const c0 = st.entities[id].c; if (purged && Object.values(c0).some((v) => v === purged)) continue;   // a purged value is no one's to rewrite
    const { c, set, del } = repairComps(c0);
    for (const k of del) ops.push({ verb: "delete", id, comp: k });
    for (const k of set) ops.push({ verb: "set", id, comp: k, value: c[k] }); }
  return ops;
}
