// sim2: eidosim2 behind the sim API the protocol's sim layer drives (emptySim, tickOf, simEntry, advanceSim, simSnapshot,
// simPose), replacing the first eidosim (shared/sim.js). R 2026-10-09: "stomp the existing eidosim engine".
//
// What a body is here, and what it isn't yet (the foundation, stage 1): the participation model is the first eidosim's. Only a LAUNCHED
// thing is a moving body; every other modelled thing with a box is a static collider; a body that comes to rest becomes a
// static again and is not woken by a hit. What changed is the law inside a flight: a rigid box with full rotation (q, w),
// oriented-box statics, a height-field ground, contacts solved with Box3D's soft step, swept against statics (CCD).
// Stage 2 (resting dynamic things woken by contact, multi-body rests) needs PHYSICS.md's widened rest rule.
//
// STATE IS PLAIN JSON and is the truth. Readers clone it (restEta), hand it to joiners (simCutOf) and digest it; an
// eidosim2 world is built from it for each advance and written back. Per body the truth is the CENTRE pose (c, q, v, w)
// plus the engine's sleep record; `p` (the entity origin, what readers compare a rest against) is derived from it and never
// read back, so any advance schedule reaching tick T gives the same bits (Covenant IV). No yaw is stored: readers
// derive it from q (a host atan2 inside digested state could differ between runtimes).

import { createWorld, VERSION } from './eidosim2.js';
import { terrainParams, makeHeightField } from './terrainmath.js';
import { sinT, cosT } from './simmath.js';

export const SIM_ID = VERSION;
const MIN_TICK_MS = 16, MAX_TICK_MS = 1000;
const MAX_FLIGHT_TICKS = 20000;   // runaway backstop, as eidosim@0.x: force rest
const SUBSTEPS = 4, DENSITY = 1000, FRICTION = 0.6, GRAVITY = [0, -9.81, 0];
// a sphere's rolling resistance (Box3D's model: the rolling torque is ROLLING × radius × the normal force): with none, a
// thrown ball would roll until the runaway backstop. 0.05 stops a 2 m/s ball in ~6 s (decel μr·g/1.4 = 0.35 m/s²)
const ROLLING = 0.05;
const MAX_SPEED = 20;
// the law caps spin as the authority caps v: a corner may not move faster than MAX_SPEED (|w|·|half| ≤ 20 m/s), else a
// spun throw rolls off at any speed (review of 49d4fb0d #2: w 1000 rad/s sent a crate 330 m at 54 m/s). + − × ÷ √ only.
function spinCap(w, half) {
  const r = Math.sqrt(half[0] * half[0] + half[1] * half[1] + half[2] * half[2]), m = Math.sqrt(w[0] * w[0] + w[1] * w[1] + w[2] * w[2]);
  if (!(r > 0) || m * r <= MAX_SPEED) return w;
  const k = MAX_SPEED / (m * r); return [w[0] * k, w[1] * k, w[2] * k];
}             // m/s: launches are clamped by the authority (ENGINES[].maxSpeed); the sim trusts them

export const emptySim = () => ({ epoch: null, tick: 0, bodies: {}, terrain: null, boxes: {}, statics: {}, e2: null });

export function tickOf(sim, ts) {
  if (!sim.epoch) return 0;
  const t = Math.ceil((ts - sim.epoch.ts) / sim.epoch.tickMs);
  return t > 0 ? t : 0;
}

const vec3ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const quatOk = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && q.some((x) => x !== 0);
const boxOk = (b) => Array.isArray(b) && b.length === 2 && vec3ok(b[0]) && vec3ok(b[1]) && b[0].every((x, i) => x <= b[1][i]);
const scale3 = (s) => (vec3ok(s) ? s.map((x) => (Math.abs(x) > 0 ? Math.abs(x) : 1)) : Number.isFinite(s) && s !== 0 ? [Math.abs(s), Math.abs(s), Math.abs(s)] : [1, 1, 1]); // a mirror is the same box
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
// a thing's collider: a stamped sphere ({type: 'sphere', radius, pos?}: radius × its largest |scale|, centred at pos in
// its own frame, the origin when absent, as PHYSICS.md §3.1 reads), else its model's box. half is the sphere's bounding
// half extent, so everything that bounds a body by half (spin cap, cull reach) stays conservative for it.
function collider(sim, ent) {
  const sc = scale3(ent.scale3 ?? ent.scale), sh = ent.shape;
  if (sh && sh.type === 'sphere' && Number.isFinite(sh.radius) && sh.radius > 0) {
    const r = sh.radius * Math.max(sc[0], sc[1], sc[2]), at = vec3ok(sh.pos) ? sh.pos : [0, 0, 0];
    return { shape: 'sphere', radius: r, half: [r, r, r], off: [at[0] * sc[0], at[1] * sc[1], at[2] * sc[2]] };
  }
  const box = typeof ent.lib === 'string' ? sim.boxes[ent.lib] : null; if (!box) return null;
  return { shape: 'box', ...geometry(box, sc) };
}
const centreOf = (pos, q, off) => { const r = qrot(q, off); return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]]; };
const originOf = (c, q, off) => { const r = qrot(q, off); return [c[0] - r[0], c[1] - r[1], c[2] - r[2]]; };
// the entity view's rotation: its q when the view carries one, else its yaw (the older view), as a quaternion
const quatOf = (ent) => (quatOk(ent?.q) ? ent.q.slice() : [0, sinT((ent?.yaw ?? 0) / 2), 0, cosT((ent?.yaw ?? 0) / 2)]);

function nextUid(sim) { const u = sim.e2.nextUid; sim.e2.nextUid = u + 1; return u; }
function material(ent) { const m = ent?.material ?? {}; return { friction: Number.isFinite(m.friction) ? m.friction : FRICTION, frictionCombine: typeof m.frictionCombine === 'string' ? m.frictionCombine : 'average' }; }

function setStatic(sim, id, ent) {
  const col = ent ? collider(sim, ent) : null;
  if (!col || !vec3ok(ent.pos)) { delete sim.statics[id]; return; }
  const q = quatOf(ent);
  sim.statics[id] = { uid: sim.statics[id]?.uid ?? nextUid(sim), c: centreOf(ent.pos, q, col.off), q, half: col.half, ...(col.shape === 'sphere' ? { shape: 'sphere', radius: col.radius } : {}),
    ...(ent.kind === 'dynamic' ? { dyn: true, off: col.off } : {}), ...material(ent) };
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
    const col = collider(sim, ent); if (!col) return;
    advanceSim(sim, tickOf(sim, entry.ts));
    const q = quatOk(a.q) ? a.q.slice() : quatOf(ent), { half, off } = col;
    const uid = sim.statics[a.id]?.uid ?? sim.bodies[a.id]?.uid ?? nextUid(sim);
    delete sim.statics[a.id]; delete sim.bodies[a.id];   // re-insert: order follows the last intent, as eidosim@0.x does
    const c = centreOf(a.p, q, off);
    sim.bodies[a.id] = { uid, c, q, v: a.v.slice(), w: spinCap(vec3ok(a.w) ? a.w.slice() : [0, 0, 0], half), half, off, ...(col.shape === 'sphere' ? { shape: 'sphere', radius: col.radius } : {}), ...material(ent),
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
// a static's world box (its centre c, turn q, half extents), for culling
function staticBox(s) {
  const [x, y, z, w] = s.q, h = s.half;
  const m = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  const e = [0, 1, 2].map((k) => Math.abs(m[k][0]) * h[0] + Math.abs(m[k][1]) * h[1] + Math.abs(m[k][2]) * h[2]);
  return [s.c[0] - e[0], s.c[1] - e[1], s.c[2] - e[2], s.c[0] + e[0], s.c[1] + e[1], s.c[2] + e[2]];
}
const SBOX = new WeakMap();   // a static row's world box, cached on the row object (a clone recomputes; rows are never edited in place)
const hits = (a, b) => !(a[0] > b[3] || a[3] < b[0] || a[1] > b[4] || a[4] < b[1] || a[2] > b[5] || a[5] < b[2]);
const CULL_SLACK = 1;   // m beyond a flyer's reach in one tick; a miss is caught after the step and the tick redone whole
// the region a flyer could touch this tick: its box now, grown by how far any point of it can go in dt, plus slack
function reachBox(b, dt, slack) {
  const r = Math.sqrt(b.half[0] * b.half[0] + b.half[1] * b.half[1] + b.half[2] * b.half[2]);
  const sp = Math.sqrt(b.v[0] * b.v[0] + b.v[1] * b.v[1] + b.v[2] * b.v[2]) + Math.sqrt(b.w[0] * b.w[0] + b.w[1] * b.w[1] + b.w[2] * b.w[2]) * r;
  const g = r + (2 * sp + 9.81 * dt) * dt + slack;
  return [b.c[0] - g, b.c[1] - g, b.c[2] - g, b.c[0] + g, b.c[1] + g, b.c[2] + g];
}
function hydrate(sim, keep = null) {
  const rows = [];
  for (const id of Object.keys(sim.statics)) { const s = sim.statics[id]; if (keep && !keep.has(id)) continue;
    // stage 2: a dynamic thing at rest is a SLEEPING body (its own island, tag 's<uid>'; the engine's are 'step:root'),
    // so a flyer that reaches it wakes it the engine's own way; anything else at rest is a static collider
    rows.push({ spec: { uid: s.uid, shape: s.shape ?? 'box', half: s.half, radius: s.radius, ...(s.shape === 'sphere' ? { rollingResistance: ROLLING } : {}), pos: s.c, rot: s.q, ...(s.dyn ? { ccd: true } : { static: true }), friction: s.friction, frictionCombine: s.frictionCombine },
      p: s.c, q: s.q, v: [0, 0, 0], w: [0, 0, 0], awake: false, sleepTime: 0, sleepTag: s.dyn ? `s${s.uid}` : null }); }
  const ids = [];
  for (const id of Object.keys(sim.bodies)) { const b = sim.bodies[id]; if (b.resting) continue; ids.push(id);
    rows.push({ spec: { uid: b.uid, shape: b.shape ?? 'box', half: b.half, radius: b.radius, ...(b.shape === 'sphere' ? { rollingResistance: ROLLING } : {}), pos: b.c, rot: b.q, ccd: true, friction: b.friction, frictionCombine: b.frictionCombine },
      p: b.c, q: b.q, v: b.v, w: b.w, awake: b.awake, sleepTime: b.sleepTime, sleepTag: b.sleepTag }); }
  rows.sort((x, y) => x.spec.uid - y.spec.uid);
  const W = createWorld({ gravity: GRAVITY, substeps: SUBSTEPS, friction: FRICTION, density: DENSITY, ground: groundOf(sim) },
    { stepNo: sim.e2.stepNo, bodies: rows, joints: [], impulses: sim.e2.impulses, manifolds: sim.e2.manifolds, pairs: sim.e2.pairs });
  const index = new Map(W.bodies.map((b, i) => [b.uid, i]));
  return { W, ids, index };
}

export const cullStats = { redo: 0 };   // how often a culled tick was redone whole (tests read it)
export const _cull = { off: false, slack: null };   // tests only: hold every static, or force a cull slack
export function advanceSim(sim, toTick) {
  if (!sim.epoch || sim.epoch.foreign || !sim.e2) { if (toTick > sim.tick) sim.tick = toTick; return sim; }
  const live = () => Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
  if (!live().length) { if (toTick > sim.tick) sim.tick = toTick; return sim; }
  // the live world is exactly what hydrate(sim) would build, so long as nothing rests: a rest turns a body into a
  // static in the JSON, so the world is rebuilt from the JSON before the next tick (else one jump would solve it as
  // the sleeping dynamic body it was, and differ from tick-by-tick; review of 49d4fb0d #1)
  // Each tick the world holds only the statics a flyer could reach in that tick (review of 49d4fb0d #4: hydrating
  // every static cost 20 ms/tick at 3000). Exact by construction: contact pairs are found from the bodies' boxes at
  // the start of the step, and the swept (continuous) test only looks inside each flyer's start→end box; after the
  // step, if any static left out touches a flyer's swept box, the tick is redone with every static.
  const dt = sim.epoch.tickMs / 1000; let W, ids, index;
  const save = () => { const ex = W.exportState(); sim.e2.stepNo = ex.stepNo; sim.e2.impulses = ex.impulses; sim.e2.manifolds = ex.manifolds; sim.e2.pairs = ex.pairs; };
  const sbox = (id) => { const row = sim.statics[id]; let b = SBOX.get(row); if (!b) SBOX.set(row, (b = staticBox(row))); return b; };
  while (sim.tick < toTick) {
    const flyers = Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting).map((id) => sim.bodies[id]);
    const reach = flyers.map((b) => reachBox(b, dt, _cull.slack ?? CULL_SLACK)), keep = new Set();
    // a static named in any kept warm start stays too: the engine keeps a resting pair's impulses only while both of
    // its bodies are in the world, and a rested thing thrown again (same uid) warm-starts from them
    const named = new Set();
    for (const M of [sim.e2.impulses, sim.e2.manifolds, sim.e2.pairs]) for (const [key] of M) { const [i, j] = key.split(":"); named.add(+i); named.add(+j); }
    for (const id of Object.keys(sim.statics)) if (_cull.off || named.has(sim.statics[id].uid) || reach.some((r) => hits(r, sbox(id)))) keep.add(id);
    const before = keep.size < Object.keys(sim.statics).length ? JSON.stringify(sim.e2) : null;
    ({ W, ids, index } = hydrate(sim, keep));
    W.step(dt);
    const woke = [...keep].filter((id) => sim.statics[id].dyn && W.bodies[index.get(sim.statics[id].uid)].awake);
    if (before !== null) {
      const movers = [...ids.map((id) => sim.bodies[id]), ...woke.map((id) => sim.statics[id])];
      const swept = movers.map((b) => { const e = W.bodies[index.get(b.uid)], r = Math.sqrt(b.half[0] ** 2 + b.half[1] ** 2 + b.half[2] ** 2) + 0.05;
        return [Math.min(b.c[0], e.p[0]) - r, Math.min(b.c[1], e.p[1]) - r, Math.min(b.c[2], e.p[2]) - r, Math.max(b.c[0], e.p[0]) + r, Math.max(b.c[1], e.p[1]) + r, Math.max(b.c[2], e.p[2]) + r]; });
      const missed = Object.keys(sim.statics).some((id) => !keep.has(id) && swept.some((s) => hits(s, sbox(id))));
      if (missed) { cullStats.redo++; sim.e2 = JSON.parse(before); ({ W, ids, index } = hydrate(sim)); W.step(dt);
        woke.length = 0; for (const id of Object.keys(sim.statics)) if (sim.statics[id].dyn && W.bodies[index.get(sim.statics[id].uid)].awake) woke.push(id); }
    }
    // woken: it flies now, as part of the latest launch still in the air (engine-defined, PHYSICS §1: a launch's rest
    // covers every body its flight set moving); it rests and is logged under that launch
    const by = Math.max(...flyers.map((b) => b.seq));
    sim.tick++;
    let flying = 0, rested = 0;
    for (const id of ids) {
      const b = sim.bodies[id]; if (b.resting) continue;
      const e = W.bodies[index.get(b.uid)];
      b.c = e.p.slice(); b.q = e.q.slice(); b.v = e.v.slice(); b.w = e.w.slice(); b.awake = e.awake; b.sleepTime = e.sleepTime; b.sleepTag = e.sleepTag ?? null;
      b.p = originOf(b.c, b.q, b.off);
      if (!e.awake || sim.tick - b.born > MAX_FLIGHT_TICKS) { restBody(sim, id, b); rested++; }
      else flying++;
    }
    for (const id of woke) { const s = sim.statics[id], e = W.bodies[index.get(s.uid)];
      delete sim.statics[id];
      sim.bodies[id] = { uid: s.uid, c: e.p.slice(), q: e.q.slice(), v: e.v.slice(), w: e.w.slice(), half: s.half, off: s.off, ...(s.shape === 'sphere' ? { shape: 'sphere', radius: s.radius } : {}),
        friction: s.friction, frictionCombine: s.frictionCombine, p: originOf(e.p, e.q, s.off), resting: false, seq: by, born: sim.tick, awake: true, sleepTime: e.sleepTime, sleepTag: null, woken: true };
      flying++; }
    save();
    if (!flying) break;
  }
  if (toTick > sim.tick) sim.tick = toTick;
  return sim;
}
// at rest it is a static again where it lies (eidosim@0.x's law, stage 1), keeping its uid
function restBody(sim, id, b) {
  // the engine's sleep tag ('step:root') names an island by a body's index in that tick's world, which culling changes;
  // at rest it's a static here and carries no tag (stage 2's sleepers get 's<uid>' when hydrated)
  b.resting = true; b.v = [0, 0, 0]; b.w = [0, 0, 0]; b.awake = false; b.sleepTag = null;
  sim.statics[id] = { uid: b.uid, c: b.c.slice(), q: b.q.slice(), half: b.half, ...(b.shape === 'sphere' ? { shape: 'sphere', radius: b.radius } : {}), dyn: true, off: b.off, friction: b.friction, frictionCombine: b.frictionCombine };
}

export function simPose(sim, id) { const b = sim.bodies[id]; return b ? { p: b.p, q: b.q, resting: b.resting } : null; }
// plain JSON, keys in insertion order (entry order): the snapshot IS the state
export const simSnapshot = (sim) => JSON.parse(JSON.stringify(sim));
