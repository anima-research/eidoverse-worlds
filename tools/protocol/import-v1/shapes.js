// tools/protocol/import-v1/shapes.js — a v1 value in today's spelling, with the meaning its readers gave it: the shape
// audit's rules (10-16), and a stored socket map lifted into socket children. Their one user is the v1 importer
// (translate-v1.js, and the oracle that mirrors it): a world the server founds is written in today's spelling from its
// first entry, so no runtime reader or command repairs one. Pure: components in, components (or ops) out.
//
// The rules (notes/eidoverse/shape-audit/physics-motion.md §4, §5, §7):
//   motion   a bare motion naming a `part` is that node's motion: motion:<partSlot(part)> {node: part} (a motion already on
//            that node wins); a keyed motion with no node gets its key's tag; amplitude → amp (amp wins); a letter axis →
//            its vector; a pendulum with no period read 3.5 s, with no damp 0, with no maxAmp 1.1 (the old push): written;
//            a whole motion's `pivot` field → the thing's pivot component; a whole PENDULUM with no pivot component swung
//            about [0, 2, 0]: written as its pivot component.
//   collider exact → mesh.   physics  no kind read as dynamic; material → surface; layers, mask, ccd dropped.
// …and the render-media-env family (render-media-env.md §3, §4, §13–§15):
//   light      no decay fell off as three.js decay 1.7: written, and with no intensity 16; day → daytime; shadows dropped
//   model      a content address eido:sha256/<hex> → the library path the host's index names, its hash beside it as
//              model-hash (only with a resolver)
//   @world (repairWorld): the sky's clock/dormantRated → tz, azimuth degrees → radians, weatherSeconds → transition,
//              forecast dwellSec/transitionSec → dwell/transition; terrain colours → ints, the sim's defaults written,
//              terrain.water → water; grass knobs → the flora spelling.
// A particle Essential's name and a grass preset's name are stored as written (R 10-17).
import { grassAtWrite } from "../../../shared/protocol/assetref.js";
import { eidoHex } from "../../../shared/eido.js";
import { COMPONENTS, materialize } from "../../../shared/protocol/componentspec.js";
import { partSlot } from "../../../shared/protocol/names.js";
import { AXES as AXIS_VECTORS } from "../../../shared/axes.js";
import { isSocketC } from "../../../shared/protocol/authority/sockets.js";
import { lifter, isLegacyParent } from "./sockets.js";
import { emptyState, applyInPlace } from "../../../shared/protocol/fold.js";
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** The light rig's falloff before a light said its own (client/lib/lightrig.js, three.js decay). */
export const OLD_LIGHT_DECAY = 1.7;
/** …and its intensity when a light wrote none (lightrig.js requestLight; the registry's default is 25.93 since 10-28). */
export const OLD_LIGHT_INTENSITY = 16;
export { AXIS_VECTORS };
/** The pendulum readings that lived only in the reader (client/lib/motioneval.js, before 10-16). */
// maxAmp 1.1: the old server's push cap (its reactions.ts pendulumImpulse), so a translated swing swings as it did (R 10-27)
export const OLD_READINGS = Object.freeze({ pendulumPeriod: 3.5, pendulumDamp: 0, pendulumMaxAmp: 1.1, wholePendulumPivot: Object.freeze([0, 2, 0]) });
const isMotionKey = (k) => k === "motion" || k.startsWith("motion:");

/** One motion value in today's spelling (or the same object when nothing changes). */
export function repairMotion(m) {
  if (!bag(m)) return m;
  let out = m; const edit = () => (out === m ? (out = { ...m }) : out);
  // amp as the old reader read it, Number(m.amp ?? m.amplitude): a numeric string was that number, null was 0, and an amp
  // of null gave way to the amplitude (house 6340433633: null was dropped, and the motion took today's default)
  if ("amplitude" in out) { edit(); const v = Number(out.amplitude); if (out.amp == null && Number.isFinite(v)) out.amp = v; delete out.amplitude; }
  if (typeof out.axis === "string" && AXIS_VECTORS[out.axis.toLowerCase()]) { edit(); out.axis = AXIS_VECTORS[out.axis.toLowerCase()].slice(); }
  if (out.type === "pendulum") {
    if (out.period === undefined) { edit(); out.period = OLD_READINGS.pendulumPeriod; }
    if (out.damp === undefined) { edit(); out.damp = OLD_READINGS.pendulumDamp; }
    if (out.maxAmp === undefined) { edit(); out.maxAmp = OLD_READINGS.pendulumMaxAmp; }
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
    if (L.decay === undefined) { edit(); L.decay = OLD_LIGHT_DECAY; if (L.intensity === undefined) L.intensity = OLD_LIGHT_INTENSITY; }
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
  // degrees → radians, once (a translation reads each stored sky once). A turn more than a full one is the same bearing
  // (400° is 40°), so it lands inside the registry's ±2π instead of refusing the world's whole repair (review r7 F5)
  if (typeof out.azimuth === "number" && Number.isFinite(out.azimuth)) { edit(); out.azimuth = (out.azimuth % 360) * Math.PI / 180; }
  // weatherSeconds → transition; a value today's range can't hold (0, or more than 600 s) is dropped: absent, the
  // renderer's own ease (review r7 F5)
  if ("weatherSeconds" in out) { edit(); const ws = out.weatherSeconds; if (out.transition === undefined && Number.isFinite(ws) && ws > 0 && ws <= 600) out.transition = ws; delete out.weatherSeconds; }
  if (bag(out.forecast) && ("dwellSec" in out.forecast || "transitionSec" in out.forecast)) { edit(); const f = { ...out.forecast };
    if ("dwellSec" in f) { if (f.dwell === undefined) f.dwell = f.dwellSec; delete f.dwellSec; }
    if ("transitionSec" in f) { if (f.transition === undefined) f.transition = f.transitionSec; delete f.transitionSec; }
    out.forecast = f; }
  for (const k of ["world"]) if (k in out) { edit(); delete out[k]; }
  return out;
}
/** @world's components repaired: {c, set, del}, as repairComps. Only the world's look is touched. NOT idempotent on a sky:
 *  its azimuth is converted from degrees every time it is handed one, so a translation hands it a stored value once. */
export function repairWorld(c0) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  if (bag(c.sky)) { const sky = withSkyDefaults(repairSky(c.sky)); if (JSON.stringify(sky) !== JSON.stringify(c.sky)) put("sky", sky); }   // the old readers' readings of absence ARE the registry's defaults (hours 12, azimuth 180° = π, …)
  if (bag(c.terrain)) { let t = c.terrain; const edit = () => (t === c.terrain ? (t = { ...c.terrain }) : t);
    if (Array.isArray(t.layers) && t.layers.some((l) => bag(l) && typeof l.color === "string" && HEXC.test(l.color))) { edit(); t.layers = t.layers.map((l) => (bag(l) ? { ...l, color: hexInt(l.color) } : l)); }
    if (t.kind === undefined || t.kind === "noise") for (const [k, v] of Object.entries(materialize("terrain", { kind: "noise" }).value)) if (t[k] === undefined) { edit(); t[k] = v; }
    if ("water" in t) { edit(); const w = t.water; delete t.water;
      if (bag(w) && !bag(c.water)) put("water", Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === "color" ? hexInt(v) : v]))); }
    if (t !== c.terrain) put("terrain", t); }
  if (bag(c.grass)) { let g = c.grass; try { g = grassAtWrite(c.grass).value; } catch { g = c.grass; }   // an unknown preset stays as it was (its readers say so)
    if (g !== c.grass) put("grass", g); }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}
const withSkyDefaults = (sky) => { const out = { ...sky }; for (const [k, v] of Object.entries(COMPONENTS.sky.defaults)) if (out[k] === undefined) out[k] = v; return out; };

// ---------- a stored socket map, and a parent or home naming a slot, as socket children (PLAN-sockets-entities) ----------
const legacyHome = (v) => bag(v) && isLegacyParent(v.parent);
/** The hosts a projection holds in the first spelling of attachment points, in id order: one that stores a `sockets` map;
 *  one a parent or a home names a slot of; one whose socket child still holds a body block. */
export function legacyHosts(st) {
  const hosts = new Set();
  for (const [k, e] of Object.entries(st.entities)) { const c = e.c;
    if (bag(c.sockets)) hosts.add(k);
    if (isLegacyParent(c.parent) && st.entities[c.parent.to]) hosts.add(c.parent.to);
    if (legacyHome(c.home) && st.entities[c.home.parent.to]) hosts.add(c.home.parent.to);
    if (isSocketC(c) && c.socket.body !== undefined && st.entities[c.parent?.to]) hosts.add(c.parent.to); }
  return [...hosts].sort();
}
/** One host's lift: {ops, made: {slot: child id}, moved: [ids]}: its map's slots made socket children (each body block a
 *  station), what sat at a slot moved into its child where it was. `ever`: every id the world made (never reused). */
export function liftHostOps(st, ever, h) {
  const L = lifter(st, ever); const c = L.s.entities[h].c; L.stored(true);   // what a log holds is re-spelled, not judged anew
  const made = bag(c.sockets) ? L.liftStored(h) : L.liftHost(h, {}, { stored: false });
  L.liftBodies(h);
  const mine = new Set([h, ...Object.values(made)]);
  return { ops: L.out, made, moved: [...new Set(L.out.map((o) => o.id).filter((id) => !mine.has(id)))] };
}
/** A projection ({id: components}) with every host lifted, in legacyHosts' order: what the translation's tail lifts make of
 *  it. `ever`: the ids its log made before the lifts. */
export function liftProjection(P, ever0) {
  const st = emptyState(); delete st.entities["@world"]; const ever = new Set(ever0);
  for (const [id, c] of Object.entries(P)) st.entities[id] = { born: 0, c: Object.assign(Object.create(null), JSON.parse(JSON.stringify(c))) };
  const hosts = legacyHosts(st);
  for (const h of hosts) { if (!st.entities[h]) continue; const { ops } = liftHostOps(st, ever, h); for (const o of ops) if (o.op === "create") ever.add(o.id); applyInPlace(st, ops, 1); }
  return { lifted: Object.fromEntries(Object.entries(st.entities).map(([id, e]) => [id, JSON.parse(JSON.stringify(e.c))])), hosts };
}

/** Fields renamed before release (R 10-17 15:09/15:11): grabbable.pose and station.pose → anim (an open name of a pose or a
 *  clip; grabbable's 'two-hand' → twoHanded: true), a grip's fingers → grasp; a motion's type bob → oscillate; a picture's and
 *  a sound's alt or look → description (R 10-27). The door refuses the old spellings; the v1 translator writes the new. Idempotent; a value already spelled today is returned as the same
 *  object; an old field stored as null is removed, never renamed to a null. {value, renamed: [{field, from?, to}]} */
export const RENAMED_FIELDS = Object.freeze({ grabbable: Object.freeze({ pose: "anim", "grips.*.fingers": "grasp" }), station: Object.freeze({ pose: "anim" }),
  motion: Object.freeze({ "type=bob": "type=oscillate" }), picture: Object.freeze({ alt: "description", look: "description" }), sound: Object.freeze({ alt: "description", look: "description" }) });
/** A v1 motion's type in today's word (R 10-17 21:40: the back-and-forth along an axis is oscillate; v1 said bob). */
export const motionType = (m) => (m?.type === "bob" ? "oscillate" : m?.type);
/** The RENAMED_FIELDS entry a component key reads by: a part's motion (motion:<slot>) is a motion. */
export const renamedFieldsKey = (comp) => (typeof comp === "string" && comp.startsWith("motion:") ? "motion" : comp);
const fbag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export function renameFields(comp0, v) {
  const comp = renamedFieldsKey(comp0);
  if (!fbag(v) || !Object.hasOwn(RENAMED_FIELDS, comp)) return { value: v, renamed: [] };
  if (comp === "motion") { const t = motionType(v); return t === v.type ? { value: v, renamed: [] } : { value: { ...v, type: t }, renamed: [{ field: "type", from: v.type, to: t }] }; }
  let out = v; const renamed = []; const edit = () => (out === v ? (out = { ...v }) : out);
  if (comp === "picture" || comp === "sound") for (const f of ["alt", "look"]) if (f in out) { edit(); const a = out[f]; delete out[f];
    if (a !== null && out.description === undefined) out.description = a; renamed.push({ field: f, to: a === null ? null : "description" }); }
  if ("pose" in out) { edit(); const p = out.pose; delete out.pose;
    if (comp === "grabbable" && p === "two-hand") { if (out.twoHanded === undefined) out.twoHanded = true; renamed.push({ field: "pose", from: p, to: { twoHanded: out.twoHanded } }); }
    else if (p === null) renamed.push({ field: "pose", to: null });   // a stored null is a removal (anim is never null)
    else { if (out.anim === undefined) out.anim = p; renamed.push({ field: "pose", to: "anim" }); } }
  if (comp === "grabbable" && fbag(out.grips) && Object.values(out.grips).some((g) => fbag(g) && "fingers" in g)) { edit();
    out.grips = Object.fromEntries(Object.entries(out.grips).map(([k, g]) => { if (!fbag(g) || !("fingers" in g)) return [k, g];
      const { fingers, ...r } = g; renamed.push({ field: `grips.${k}.fingers`, to: fingers === null ? null : "grasp" });
      return [k, { ...r, ...(r.grasp === undefined && fingers !== null ? { grasp: fingers } : {}) }]; })); }
  return { value: out, renamed };
}
