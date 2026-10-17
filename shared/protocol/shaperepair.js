// shared/protocol/shaperepair.js — a value stored before the shape audit's wave 2 (physics-motion, 10-16), in today's
// spelling, with the meaning its readers gave it. Pure: a thing's components in, the repaired components out. Three
// callers, one rule set: the server's first load of a stored world (authority.js liftWorld: one system act,
// `repair-shapes`, ONCE per world: shapesMarked below), translate-v1@12's projection (so a translated world needs no
// repair, and is marked), and the old-world oracle's mirror of the load. The rules that read an absent field may only
// ever see values stored before the audit: that is the marker's job, not these functions' (review r7 F2).
//
// The rules (notes/eidoverse/shape-audit/physics-motion.md §4, §5, §7):
//   motion   a bare motion naming a `part` is that node's motion: motion:<partSlot(part)> {node: part} (a motion already on
//            that node wins); a keyed motion with no node gets its key's tag (the node's name, before the node was data);
//            amplitude → amp (amp wins); a letter axis (x, y, z, -x, -y, -z) → its vector;
//            a pendulum with no period read 3.5 s and with no damp 0 (motioneval.js): written down;
//            a whole motion's `pivot` field → the thing's pivot component (when it has none);
//            a whole PENDULUM with no pivot component swung about [0, 2, 0] (motioneval.js, before 10-16): that point is
//            written as its pivot component, because a whole thing now turns about its origin when it has none.
//   collider exact → mesh (one vocabulary with shapes.js, KHR, Unity, Godot).
//   physics  no kind read as the old materialized default, dynamic; material → surface (renamed); layers, mask, ccd
//            (cut, never read) are dropped.
// …and the render-media-env family (render-media-env.md §3, §4, §13–§15), the same callers:
//   light      no decay fell off as the rig's three.js decay 1.7: written (a NEW light's default is 2); day → daytime
//              (true dim, false full); shadows (read by nothing) dropped
//   model      (R 10-17, v2) a content address eido:sha256/<hex> (translate-v1@8–@11 wrote them) → the library path this
//              host's index names for it, with the address's hash beside it as model-hash sha256:<hex>; only with a resolver
//              (the load passes the catalogue's pathOf: host-local, which is fine for a logged act every replica folds as
//              written); an address no file here names is kept, and still loads
//   @world (repairWorld):
//   sky        clock 'real' + dormantRated {hours, rate, ts} → tz, with hours/rate/ts the parked clock (it is the fallback
//              now); another clock → no tz; azimuth degrees → radians;
//              weatherSeconds → transition; forecast dwellSec/transitionSec → dwell/transition; sun, fill, world (never
//              stored on Burrow) dropped
//   terrain    layer colours "#rrggbb" → ints; the sim's defaults (terrainmath.js) written where absent; terrain.water →
//              the water component (its colour an int)
//   grass      the first protocol's makeGrass knobs → the flora spelling (mapGrassArgs, the reader's own mapping); a preset
//              is kept by its name, as the door keeps one (R 10-17; Fable #4)
// A particle Essential's name and a grass preset's name are stored as written (R 10-17): nothing rewrites them to an address.
import { grassAtWrite } from "./assetref.js";
import { eidoHex } from "../eido.js";
import { COMPONENTS } from "./componentspec.js";
import { partSlot } from "./names.js";
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** The light rig's falloff before a light said its own (client/lib/lightrig.js, three.js decay). */
export const OLD_LIGHT_DECAY = 1.7;
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
 *  removed]}. Only this family's names are touched; everything else is passed through as it is. `pathOf(address)` → the
 *  library path an old content address names on this host, or null (absent: models are left as they are). */
export function repairComps(c0, { pathOf = null } = {}) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  const drop = (k) => { delete c[k]; del.add(k); set.delete(k); };
  // a keyed motion stored before the node was data: its key's tag was the node's name (motion.js read key.slice(7))
  for (const k of Object.keys(c)) if (k.startsWith("motion:") && bag(c[k]) && !(typeof c[k].node === "string" && c[k].node)) put(k, { ...c[k], node: k.slice(7) });
  // a bare motion naming a part is that node's motion: motion:<slot> {node: <the file's name, as it was>}. The slot is a
  // pure function of the name (partSlot), so every server writes the same key; a motion already on that node wins
  if (bag(c.motion) && typeof c.motion.part === "string" && c.motion.part) {
    const { part, ...rest } = c.motion; const key = `motion:${partSlot(part)}`;
    const onIt = Object.keys(c).some((k) => k.startsWith("motion:") && bag(c[k]) && c[k].node === part);
    if (!onIt && !bag(c[key])) put(key, { ...rest, node: part });
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
  if (bag(c.light)) { let L = c.light; const edit = () => (L === c.light ? (L = { ...c.light }) : L);
    if (L.decay === undefined) { edit(); L.decay = OLD_LIGHT_DECAY; }
    if ("day" in L) { edit(); if (L.daytime === undefined && typeof L.day === "boolean") L.daytime = L.day ? "dim" : "full"; delete L.day; }
    if (L.daytime === undefined) { edit(); L.daytime = "dim"; }
    if ("shadows" in L) { edit(); delete L.shadows; }
    if (L !== c.light) put("light", L); }
  // a model stored as its content address gets its library path back (R 10-17), the address kept beside it as its hash
  const hex = typeof pathOf === "function" ? eidoHex(c.model) : null;
  if (hex) { let p = null; try { p = pathOf(c.model); } catch { p = null; }
    if (typeof p === "string" && p && !eidoHex(p)) { put("model", p); if (c["model-hash"] === undefined) put("model-hash", `sha256:${hex}`); } }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}

const HEXC = /^#[0-9a-f]{6}$/i;
const hexInt = (x) => (typeof x === "string" && HEXC.test(x) ? parseInt(x.slice(1), 16) : x);
/** One stored sky in today's spelling (or the same object). */
export function repairSky(sky) {
  if (!bag(sky)) return sky;
  let out = sky; const edit = () => (out === sky ? (out = { ...sky }) : out);
  if ("clock" in out || "dormantRated" in out) { edit();
    if (out.clock === "real") { if (typeof out.tz !== "string" || !out.tz) out.tz = "America/Los_Angeles";
      const d = out.dormantRated; if (bag(d)) { if (Number.isFinite(d.hours)) out.hours = d.hours; if (Number.isFinite(d.rate)) out.rate = d.rate; if (Number.isFinite(d.ts)) out.ts = d.ts; } }
    else delete out.tz;   // a clock other than real: the rated clock governs
    delete out.clock; delete out.dormantRated; }
  // a tz with no clock is today's spelling (it governs). The audit's pre-#65 case (a tz that meant nothing without clock) is
  // indistinguishable from it, and no stored sky on Burrow held one (all 16 tz values sat beside clock: 'real'): kept
  // degrees → radians, once (the load's marker makes it once: liftWorld). A turn more than a full one is the same bearing
  // (400° is 40°), so it lands inside the registry's ±2π instead of refusing the world's whole repair (review r7 F5)
  if (typeof out.azimuth === "number" && Number.isFinite(out.azimuth)) { edit(); out.azimuth = (out.azimuth % 360) * Math.PI / 180; }
  // weatherSeconds → transition; a value today's range can't hold (0, or more than 600 s) is dropped: absent, the
  // renderer's own ease (review r7 F5)
  if ("weatherSeconds" in out) { edit(); const ws = out.weatherSeconds; if (out.transition === undefined && Number.isFinite(ws) && ws > 0 && ws <= 600) out.transition = ws; delete out.weatherSeconds; }
  if (bag(out.forecast) && ("dwellSec" in out.forecast || "transitionSec" in out.forecast)) { edit(); const f = { ...out.forecast };
    if ("dwellSec" in f) { if (f.dwell === undefined) f.dwell = f.dwellSec; delete f.dwellSec; }
    if ("transitionSec" in f) { if (f.transition === undefined) f.transition = f.transitionSec; delete f.transitionSec; }
    out.forecast = f; }
  for (const k of ["sun", "fill", "world"]) if (k in out) { edit(); delete out[k]; }
  return out;
}
/** @world's components repaired: {c, set, del}, as repairComps. Only the world's look is touched. NOT idempotent on a sky:
 *  its azimuth is converted from degrees every time it is handed one. Each caller hands it a stored value once: the
 *  load's repair runs once per world (liftWorld: the log's marker, shapesMarked), translate-v1@12 once per translation
 *  (and its output carries the marker), the oracle once per projection. */
export function repairWorld(c0) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  if (bag(c.sky)) { const sky = withSkyDefaults(repairSky(c.sky)); if (JSON.stringify(sky) !== JSON.stringify(c.sky)) put("sky", sky); }   // the old readers' readings of absence ARE the registry's defaults (hours 12, azimuth 180° = π, …)
  if (bag(c.terrain)) { let t = c.terrain; const edit = () => (t === c.terrain ? (t = { ...c.terrain }) : t);
    if (Array.isArray(t.layers) && t.layers.some((l) => bag(l) && typeof l.color === "string" && HEXC.test(l.color))) { edit(); t.layers = t.layers.map((l) => (bag(l) ? { ...l, color: hexInt(l.color) } : l)); }
    if (t.kind === undefined || t.kind === "noise") for (const [k, v] of Object.entries(COMPONENTS.terrain.defaults)) if (t[k] === undefined) { edit(); t[k] = v; }
    if ("water" in t) { edit(); const w = t.water; delete t.water;
      if (bag(w) && !bag(c.water)) put("water", Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === "color" ? hexInt(v) : v]))); }
    if (t !== c.terrain) put("terrain", t); }
  if (bag(c.grass)) { let g = c.grass; try { g = grassAtWrite(c.grass).value; } catch { g = c.grass; }   // an unknown preset stays as it was (its readers say so)
    if (g !== c.grass) put("grass", g); }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}
const withSkyDefaults = (sky) => { const out = { ...sky }; for (const [k, v] of Object.entries(COMPONENTS.sky.defaults)) if (out[k] === undefined) out[k] = v; return out; };

/** The shape repair's version: carried by its act (repair-shapes {v}) and by a founding (create-world {shapes}). 2 (R 10-17):
 *  an old content address → its library path, and names (an Essential's, a grass preset's) kept rather than resolved. A log
 *  marked by any version is not repaired again: version 1 was only ever written by this branch's test and scratch worlds, and their
 *  addresses still load (the index) or read as "thing". */
export const SHAPES_VERSION = 2;
/** Has this log been through the shape repair already, or been written in today's spelling from its start? True when it
 *  holds the repair's own act (any version: the first one, before 10-16's review, repaired everything before it or
 *  nothing), a founding stamped with `shapes` (a world founded since), or a translation by translate-v1@12 or later (which
 *  writes the repaired spelling). A pure view over the log, so every replica and every server answers the same. */
// Review r8 M3: the marker is the system's repair-shapes act, read by verb and actor only (they stay in a purged entry's
// skeleton). A founding writes one beside it, and translate-v1 one beside its `translated`. The two older markers (a
// founding's `shapes`, a translation's translator) are read through `bodyOf`: the authority passes readback, so a purged
// body is unknown, and unknown is MARKED. Never re-running a one-way rewrite on values written in today's spelling is the safe
// side; the cost is a world founded before 10-16 whose founding was purged before its first load here, which keeps its old
// values unrepaired (their readers' defaults) rather than having today's values rewritten as if old.
export function shapesMarked(entries, bodyOf = (i) => entries?.[i]?.body ?? null) {
  const L = entries ?? []; let founded = false;
  for (let i = 0; i < L.length; i++) { const e = L[i];
    if (!e || e.kind !== "act") continue;
    if (e.verb === "repair-shapes" && e.actor === "system") return true;
    // only the founding counts (review r9 L5): the first create-world act. A later one is a refused attempt the log keeps (a
    // visitor's create-world on a world that exists), whose purge must never read as "marked"
    if (e.verb === "create-world" && !founded) { founded = true; const b = bodyOf(i); if (b === null) return true; if (b && typeof b === "object" && Number.isInteger(b.shapes)) return true; }
    if (e.verb === "translated" && e.actor === "system") { const b = bodyOf(i); if (b === null) return true; const m = /@(\d+)$/.exec(String(b?.from?.translator ?? "")); if (m && +m[1] >= 12) return true; } }
  return false;
}

/** The ops that repair a folded state (every thing, and @world's look): [{verb: "set"|"delete", id, comp, value?}], in
 *  id order. [] when nothing needs it. */
export function shapeRepairOps(st, purged = null, { pathOf = null } = {}) {
  const ops = [];
  for (const id of Object.keys(st?.entities ?? {}).sort()) {
    const c0 = st.entities[id].c; if (purged && Object.values(c0).some((v) => v === purged)) continue;   // a purged value is no one's to rewrite
    const { c, set, del } = id === "@world" ? repairWorld(c0) : repairComps(c0, { pathOf });
    for (const k of del) ops.push({ verb: "delete", id, comp: k });
    for (const k of set) ops.push({ verb: "set", id, comp: k, value: c[k] }); }
  return ops;
}
