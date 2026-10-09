// sim2: eidosim2 behind the sim API the protocol's sim layer drives (emptySim, tickOf, simEntry, advanceSim, simSnapshot,
// simPose), replacing eidosim v1 (shared/sim.js). R 2026-10-09: "stomp the existing eidosim engine".
//
// What a body is here, and what it isn't yet (the foundation, stage 1): the participation model is v1's. Only a LAUNCHED
// thing is a moving body; every other modelled thing with a box is a static collider; a body that comes to rest becomes a
// static again and is not woken by a hit. What changed is the law inside a flight: a rigid box with full rotation (q, w),
// oriented-box statics, a height-field ground, contacts solved with Box3D's soft step, swept against statics (CCD).
// Stage 2 (resting dynamic things woken by contact, multi-body rests) needs PHYSICS.md's widened rest rule.
//
// STATE IS PLAIN JSON and is the truth. Readers clone it (restEta), hand it to joiners (simCutOf) and digest it; an
// eidosim2 world is built from it for each advance and written back. Per body the truth is the CENTRE pose (c, q, v, w)
// plus the engine's sleep record; `p` (the entity origin, what readers compare a rest against) is derived from it and never
// read back, so any advance schedule reaching tick T gives the same bits (v1's Covenant IV). No yaw is stored: readers
// derive it from q (a host atan2 inside digested state could differ between runtimes).

import { createWorld, VERSION } from './eidosim2.js';
import { terrainParams, makeHeightField } from './terrainmath.js';
import { sinT, cosT } from './simmath.js';

export const SIM_ID = VERSION;
const MIN_TICK_MS = 16, MAX_TICK_MS = 1000;
const MAX_FLIGHT_TICKS = 20000;   // runaway backstop, as v1: force rest
const SUBSTEPS = 4, DENSITY = 1000, FRICTION = 0.6, GRAVITY = [0, -9.81, 0];
const MAX_SPEED = 20;             // m/s: launches are clamped by the authority (ENGINES[].maxSpeed); the sim trusts them

export const emptySim = () => ({ epoch: null, tick: 0, bodies: {}, terrain: null, boxes: {}, statics: {}, e2: null });

export function tickOf(sim, ts) {
  if (!sim.epoch) return 0;
  const t = Math.ceil((ts - sim.epoch.ts) / sim.epoch.tickMs);
  return t > 0 ? t : 0;
}

const vec3ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const quatOk = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && q.some((x) => x !== 0);
const boxOk = (b) => Array.isArray(b) && b.length === 2 && vec3ok(b[0]) && vec3ok(b[1]) && b[0].every((x, i) => x <= b[1][i]);
const scale3 = (s) => (vec3ok(s) ? s.map((x) => (x > 0 ? x : 1)) : Number.isFinite(s) && s > 0 ? [s, s, s] : [1, 1, 1]);
const qrot = (q, v) => {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]), ty = 2 * (q[2] * v[0] - q[0] * v[2]), tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [v[0] + q[3] * tx + (q[1] * tz - q[2] * ty), v[1] + q[3] * ty + (q[2] * tx - q[0] * tz), v[2] + q[3] * tz + (q[0] * ty - q[1] * tx)];
};
// a lib's box [[min],[max]] in the entity's frame, scaled: its half extents and the centre's offset from the origin
function geometry(box, scale) {
  const half = [0, 1, 2].map((k) => (box[1][k] - box[0][k]) * 0.5 * scale[k]);
  const off = [0, 1, 2].map((k) => (box[0][k] + box[1][k]) * 0.5 * scale[k]);
  // a box with no extent on an axis is given a sliver (a 2 cm-thick sign is still a thing you can hit)
  return { half: half.map((h) => (h > 0.005 ? h : 0.005)), off };
}
const centreOf = (pos, q, off) => { const r = qrot(q, off); return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]]; };
const originOf = (c, q, off) => { const r = qrot(q, off); return [c[0] - r[0], c[1] - r[1], c[2] - r[2]]; };
// the entity view's rotation: its q when the view carries one, else its yaw (v1's view), as a quaternion
const quatOf = (ent) => (quatOk(ent?.q) ? ent.q.slice() : [0, sinT((ent?.yaw ?? 0) / 2), 0, cosT((ent?.yaw ?? 0) / 2)]);

function nextUid(sim) { const u = sim.e2.nextUid; sim.e2.nextUid = u + 1; return u; }
function material(ent) { const m = ent?.material ?? {}; return { friction: Number.isFinite(m.friction) ? m.friction : FRICTION, frictionCombine: typeof m.frictionCombine === 'string' ? m.frictionCombine : 'average' }; }

function setStatic(sim, id, ent) {
  const box = ent && typeof ent.lib === 'string' ? sim.boxes[ent.lib] : null;
  if (!box || !vec3ok(ent.pos)) { delete sim.statics[id]; return; }
  const q = quatOf(ent), { half, off } = geometry(box, scale3(ent.scale3 ?? ent.scale));
  sim.statics[id] = { uid: sim.statics[id]?.uid ?? nextUid(sim), c: centreOf(ent.pos, q, off), q, half, ...material(ent) };
}

export function simEntry(sim, entry, st) {
  const a = entry.args ?? {};
  if (entry.verb === 'epoch') {
    if (a.sim === null) { Object.assign(sim, emptySim()); return; }
    if (typeof a.sim !== 'string' || !Number.isInteger(a.tickMs) || a.tickMs < MIN_TICK_MS || a.tickMs > MAX_TICK_MS) return;
    Object.assign(sim, emptySim());
    sim.epoch = { sim: a.sim, tickMs: a.tickMs, ts: entry.ts, seq: entry.seq, ...(a.sim === SIM_ID ? {} : { foreign: true }) };
    if (sim.epoch.foreign) return;
    sim.e2 = { nextUid: 0, stepNo: 0, impulses: [], manifolds: [], pairs: [] };
    sim.terrain = st?.terrain ? terrainParams(st.terrain) : null;
    if (a.boxes && typeof a.boxes === 'object') for (const lib of Object.keys(a.boxes)) if (boxOk(a.boxes[lib])) sim.boxes[lib] = a.boxes[lib];
    for (const id of Object.keys(st?.entities ?? {})) setStatic(sim, id, st.entities[id]);
    return;
  }
  if (!sim.epoch || sim.epoch.foreign) return;
  if (entry.verb === 'terrain') {
    advanceSim(sim, tickOf(sim, entry.ts));
    sim.terrain = terrainParams(a);
    sim.bodies = {}; sim.statics = {};
    for (const id of Object.keys(st?.entities ?? {})) setStatic(sim, id, st.entities[id]);
    return;
  }
  if (entry.verb === 'launch') {   // {id, p (origin), v, q?, w?}: the thing leaves the statics and flies from exactly this state
    const ent = st?.entities?.[a.id]; if (!ent || !vec3ok(a.p) || !vec3ok(a.v)) return;
    const box = typeof ent.lib === 'string' ? sim.boxes[ent.lib] : null; if (!box) return;
    advanceSim(sim, tickOf(sim, entry.ts));
    const q = quatOk(a.q) ? a.q.slice() : quatOf(ent), { half, off } = geometry(box, scale3(ent.scale3 ?? ent.scale));
    const uid = sim.statics[a.id]?.uid ?? sim.bodies[a.id]?.uid ?? nextUid(sim);
    delete sim.statics[a.id]; delete sim.bodies[a.id];   // re-insert: order follows the last intent, as v1
    const c = centreOf(a.p, q, off);
    sim.bodies[a.id] = { uid, c, q, v: a.v.slice(), w: vec3ok(a.w) ? a.w.slice() : [0, 0, 0], half, off, ...material(ent),
      p: a.p.slice(), resting: false, seq: entry.seq, born: sim.tick, awake: true, sleepTime: 0, sleepTag: null };
    return;
  }
  if (entry.verb === 'spawn' && typeof a.lib === 'string' && boxOk(a.box)) sim.boxes[a.lib] = a.box;
  if (RELEASERS.has(entry.verb) && a.id != null) {
    advanceSim(sim, tickOf(sim, entry.ts));
    delete sim.bodies[a.id];
    if (RESEATERS.has(entry.verb)) setStatic(sim, a.id, st?.entities?.[a.id]); else delete sim.statics[a.id];
  }
}
const RELEASERS = new Set(['place', 'spawn', 'remove', 'mount', 'dismount', 'motion', 'light']);
const RESEATERS = new Set(['place', 'spawn', 'dismount', 'light']);

// height fields are compiled once per params object (outside the state: the state stays plain JSON)
const fields = new WeakMap();
function groundOf(sim) {
  if (!sim.terrain) return { height: () => 0 };
  let f = fields.get(sim.terrain); if (!f) { f = makeHeightField(sim.terrain); fields.set(sim.terrain, f); }
  return { height: f };
}

// Build the eidosim2 world from the state: statics and flying bodies in uid order (so the engine's pair order is the
// uid order, the same in every runtime and across any rebuild).
function hydrate(sim) {
  const rows = [];
  for (const id of Object.keys(sim.statics)) { const s = sim.statics[id];
    rows.push({ spec: { uid: s.uid, shape: 'box', half: s.half, pos: s.c, rot: s.q, static: true, friction: s.friction, frictionCombine: s.frictionCombine },
      p: s.c, q: s.q, v: [0, 0, 0], w: [0, 0, 0], awake: false, sleepTime: 0, sleepTag: null }); }
  const ids = [];
  for (const id of Object.keys(sim.bodies)) { const b = sim.bodies[id]; if (b.resting) continue; ids.push(id);
    rows.push({ spec: { uid: b.uid, shape: 'box', half: b.half, pos: b.c, rot: b.q, ccd: true, friction: b.friction, frictionCombine: b.frictionCombine },
      p: b.c, q: b.q, v: b.v, w: b.w, awake: b.awake, sleepTime: b.sleepTime, sleepTag: b.sleepTag }); }
  rows.sort((x, y) => x.spec.uid - y.spec.uid);
  const W = createWorld({ gravity: GRAVITY, substeps: SUBSTEPS, friction: FRICTION, density: DENSITY, ground: groundOf(sim) },
    { stepNo: sim.e2.stepNo, bodies: rows, joints: [], impulses: sim.e2.impulses, manifolds: sim.e2.manifolds, pairs: sim.e2.pairs });
  const index = new Map(W.bodies.map((b, i) => [b.uid, i]));
  return { W, ids, index };
}

export function advanceSim(sim, toTick) {
  if (!sim.epoch || sim.epoch.foreign || !sim.e2) { if (toTick > sim.tick) sim.tick = toTick; return sim; }
  const live = () => Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
  if (!live().length) { if (toTick > sim.tick) sim.tick = toTick; return sim; }
  const { W, ids, index } = hydrate(sim), dt = sim.epoch.tickMs / 1000;
  while (sim.tick < toTick) {
    W.step(dt); sim.tick++;
    let flying = 0;
    for (const id of ids) {
      const b = sim.bodies[id]; if (b.resting) continue;
      const e = W.bodies[index.get(b.uid)];
      b.c = e.p.slice(); b.q = e.q.slice(); b.v = e.v.slice(); b.w = e.w.slice(); b.awake = e.awake; b.sleepTime = e.sleepTime; b.sleepTag = e.sleepTag ?? null;
      b.p = originOf(b.c, b.q, b.off);
      if (!e.awake || sim.tick - b.born > MAX_FLIGHT_TICKS) restBody(sim, id, b);
      else flying++;
    }
    if (!flying) break;
  }
  const ex = W.exportState();
  sim.e2.stepNo = ex.stepNo; sim.e2.impulses = ex.impulses; sim.e2.manifolds = ex.manifolds; sim.e2.pairs = ex.pairs;
  if (toTick > sim.tick) sim.tick = toTick;
  return sim;
}
// at rest it is a static again where it lies (v1's law, stage 1), keeping its uid
function restBody(sim, id, b) {
  b.resting = true; b.v = [0, 0, 0]; b.w = [0, 0, 0]; b.awake = false;
  sim.statics[id] = { uid: b.uid, c: b.c.slice(), q: b.q.slice(), half: b.half, friction: b.friction, frictionCombine: b.frictionCombine };
}

export function simPose(sim, id) { const b = sim.bodies[id]; return b ? { p: b.p, q: b.q, resting: b.resting } : null; }
// plain JSON, keys in insertion order (entry order): the snapshot IS the state
export const simSnapshot = (sim) => JSON.parse(JSON.stringify(sim));
