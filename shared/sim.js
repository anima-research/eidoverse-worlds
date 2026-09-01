// sim — the deterministic sim fold (spec/PROTOCOL_v2.md, dialect 3), as one
// pure module. This is the reference eidosim: fold the sim-scoped entries of
// an epoch through it, advance to a tick, and every conforming
// implementation holds bit-identical state — that is the whole covenant.
//
// Same constraints as everything in shared/ (README.md), tightened to
// Covenant I (owned numerics): ONLY IEEE-754 exact host operations are used
// — + − × ÷, sqrt, comparisons, min/max/abs. No Math.sin/cos/exp/pow (yaw
// goes through simmath's owned sinT/cosT), no Date.now(), no randomness, no
// unordered iteration (bodies/statics are plain objects; insertion order
// follows entry order, which is the log's order). Number→string is
// ECMA-specified shortest-round-trip, so JSON of this state is itself a
// deterministic serialization — digests may be taken over it directly.
//
// This build CARRIES THREE sims (Covenant II — old logs replay under the law
// they were written under, bit for bit):
//
// eidosim@0.1.0 — flat floor: ground = the body's own starting height
//   (right on build pads, wrong on slopes — which a hilly-meadow playtest
//   duly hit: flights landed on an invisible floor at launch altitude,
//   §24t-3). Its advance law below is UNTOUCHED; 0.1.0 epochs in old logs
//   replay to the same bits they always did (replaybench holds the proof).
//
// eidosim@0.2.0 — terrain-aware ground: the sim folds the world's `terrain`
//   entries and grounds every body on shared/terrainmath.js — the toolkit's
//   own height law re-expressed in exact ops (Covenant I; ≥99.8%
//   bit-identical to the mesh the client walks, worst divergence ~1e-15).
//   Grounded bodies are GLUED to the terrain while sliding; a flight meeting
//   rising ground splats to contact. A `terrain` entry under a live epoch
//   re-grounds the world wholesale: every body is released to the instant
//   fold. Worlds with no terrain keep the flat-floor fallback. UNTOUCHED
//   since 0.2.0 shipped: every 0.3 addition below is gated by name.
//
// eidosim@0.3.0 — the world's things are colliders. The sim folds the boxes
//   the SEQUENCER stamps into history (Covenant III: an asset's geometry is
//   not in the log until the sequencer writes it there — ruling tel0s,
//   2026-09-01): `epoch.boxes` — lib → [[min],[max]] for every model standing
//   in the world at the barrier — and `spawn.box` for every model spawned
//   after it. Every fold entity with a known box is a STATIC collider (its
//   yaw-rotated, scaled local box's world AABB); a punted body carries its
//   own. Per tick, for a body in flight: a static whose top the body was
//   above and whose footprint it overlaps is GROUND — land on a crate,
//   slide, rest on it under the same contact law as terrain; a static it
//   meets from the side pushes it out along the shallower horizontal axis
//   and reflects that velocity (a bounce off a wall, RESTITUTION-scaled). A
//   grounded slider that loses its support by more than a step FALLS rather
//   than gluing (no teleport off a crate edge). A body that comes to rest
//   becomes a static again. Scope honestly stated: flying bodies do not
//   collide with each other; a resting body is not woken by being hit; a
//   thing that mounts, rides a motion, or has no box is not a collider.
//
// Shared by all:
//   - one intent: `punt` (dialect-3 form: dir REQUIRED — Covenant III, the
//     entry carries everything; presence never enters the sim);
//   - ballistic integration, semi-implicit Euler at the epoch's fixed tick;
//   - authored word wins: place/spawn/remove/mount/dismount/motion naming a
//     live body releases it to the instant fold (§6 draft ruling);
//   - a foreign epoch (a sim this build does not carry) is honored by
//     REFUSAL: recorded, never recomputed (Covenant II — a wrong answer is
//     worse than no answer; the barrier snapshot is the truth then).
//
// Conformance order (normative for callers): per entry, foldEntry FIRST,
// then simEntry — punts read the instant fold's entity as it stood when the
// intent landed, and a collider change takes effect at ITS entry's tick
// (simEntry advances to it before touching the statics). Advancement is
// per-tick fixed-step, so any advance schedule reaching tick T yields the
// same state: snapshots may cut anywhere.

import { terrainParams, makeHeightField } from './terrainmath.js';
import { sinT, cosT } from './simmath.js';

// What the epoch verb MINTS (new epochs enter this sim)…
export const SIM_ID = 'eidosim@0.3.0';
// …and what this build can still REPLAY (a carried sim is never foreign).
const V1 = 'eidosim@0.1.0';
const V2 = 'eidosim@0.2.0';
const CARRIED = new Set([V1, V2, SIM_ID]);

// The physics constants ARE the sim version — editing any of them is an
// epoch bump, never a patch (Covenant II: it rewrites what old logs mean).
const G = 9.8;                  // m/s² downward
const RESTITUTION = 0.45;       // bounce keep — vertical off ground, horizontal off a wall (0.3)
const BOUNCE_FRICTION = 0.75;   // tangential keep per bounce
const GROUND_FRICTION = 0.85;   // horizontal keep per grounded tick (slide)
const REST_SPEED2 = 0.0225;     // (0.15 m/s)² — below this, grounded: rest
const MAX_POWER = 20;           // m/s launch cap
const MIN_TICK_MS = 16, MAX_TICK_MS = 1000;
const MAX_FLIGHT_TICKS = 20000; // runaway backstop: force rest (~22min @66ms)
const STEP_DOWN = 0.3;          // 0.3: a glued slider follows ground down at most this far per tick; beyond it, it falls

/** @typedef {{ p: number[], v: number[], yaw: number, ground: number,
 *              seq: number, born: number, resting: boolean,
 *              box?: number[][] | null, scale?: number,
 *              ext?: { cx: number, cz: number, hx: number, hz: number, y0: number, y1: number } | null,
 *              on?: string | null }} SimBody */
/** @typedef {{ epoch: { sim: string, tickMs: number, ts: number, seq: number,
 *                       foreign?: boolean } | null,
 *              tick: number, bodies: Record<string, SimBody>,
 *              terrain?: ReturnType<typeof terrainParams> | null,
 *              boxes?: Record<string, number[][]>,
 *              statics?: Record<string, { aabb: number[][] }> }} SimState */

/** @returns {SimState} */
export const emptySim = () => ({ epoch: null, tick: 0, bodies: {}, terrain: null });

/** The Covenant-IV quantization: the first tick boundary at or after ts.
 *  @param {SimState} sim @param {number} ts */
export function tickOf(sim, ts) {
  if (!sim.epoch) return 0;
  const raw = (ts - sim.epoch.ts) / sim.epoch.tickMs;
  const t = Math.ceil(raw);
  return t > 0 ? t : 0;
}

// ---- 0.3 geometry: boxes, extents, world AABBs ------------------------------

const vec3ok = (a) => Array.isArray(a) && a.length === 3
  && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
/** A stamped box: [[minx,miny,minz],[maxx,maxy,maxz]], min ≤ max per axis. */
const boxOk = (b) => Array.isArray(b) && b.length === 2 && vec3ok(b[0]) && vec3ok(b[1])
  && b[0][0] <= b[1][0] && b[0][1] <= b[1][1] && b[0][2] <= b[1][2];

/** The body-frame extents of a scaled, yaw-rotated local box: horizontal
 *  center offset (cx, cz) and half-extents (hx, hz) of its world AABB, and
 *  the bottom/top offsets (y0, y1) from the entity origin. Yaw through the
 *  owned kernel — the first shipped use of simmath (Covenant I). */
function extentsOf(box, scale, yaw) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const cx = (box[0][0] + box[1][0]) * 0.5 * s, cz = (box[0][2] + box[1][2]) * 0.5 * s;
  const hx = (box[1][0] - box[0][0]) * 0.5 * s, hz = (box[1][2] - box[0][2]) * 0.5 * s;
  const c = cosT(yaw), sn = sinT(yaw);
  const ac = Math.abs(c), as = Math.abs(sn);
  return { cx: cx * c + cz * sn, cz: -cx * sn + cz * c,
    hx: hx * ac + hz * as, hz: hx * as + hz * ac, y0: box[0][1] * s, y1: box[1][1] * s };
}
const aabbAt = (p, e) => [[p[0] + e.cx - e.hx, p[1] + e.y0, p[2] + e.cz - e.hz],
  [p[0] + e.cx + e.hx, p[1] + e.y1, p[2] + e.cz + e.hz]];

/** (0.3) Make the fold entity `id` a static collider from its lib's box —
 *  or drop it, if its lib has none. */
function setStatic(sim, id, ent) {
  if (!sim.statics) return;
  const box = ent && typeof ent.lib === 'string' ? sim.boxes?.[ent.lib] : null;
  if (!box || !vec3ok(ent.pos)) { delete sim.statics[id]; return; }
  const e = extentsOf(box, ent.scale, typeof ent.yaw === 'number' ? ent.yaw : 0);
  sim.statics[id] = { aabb: aabbAt(ent.pos, e) };
}
/** (0.3) A body at rest is a static again, at its own word. */
function restStatic(sim, id, b) {
  if (!sim.statics || !b.ext) return;
  sim.statics[id] = { aabb: aabbAt(b.p, b.ext) };
}

/** Advance every live body to `toTick` by fixed steps. Pure of wall time.
 *  @param {SimState} sim @param {number} toTick */
export function advanceSim(sim, toTick) {
  if (!sim.epoch || sim.epoch.foreign) { sim.tick = toTick > sim.tick ? toTick : sim.tick; return sim; }
  const dt = sim.epoch.tickMs / 1000;
  const v2 = sim.epoch.sim !== V1;
  const v3 = sim.epoch.sim === SIM_ID;
  const hf = v2 && sim.terrain ? heightFieldOf(sim) : null;
  while (sim.tick < toTick) {
    sim.tick++;
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      if (b.resting) continue;
      const prevBottom = b.ext ? b.p[1] + b.ext.y0 : b.p[1];
      b.v[1] = b.v[1] - G * dt;
      b.p[0] = b.p[0] + b.v[0] * dt;
      b.p[1] = b.p[1] + b.v[1] * dt;
      b.p[2] = b.p[2] + b.v[2] * dt;
      // the floor under the body THIS tick: the terrain law (0.2+ epochs with
      // a terrain), else the flat launch-height floor (0.1 law, and the
      // fallback for terrainless worlds)
      let g = hf ? hf(b.p[0], b.p[2]) : b.ground;
      if (v3 && b.ext && sim.statics) {
        // 0.3: the world's things. Statics in insertion order (the log's).
        let on = null;
        let bb = aabbAt(b.p, b.ext);
        for (const sid in sim.statics) {
          if (sid === id) continue;
          const s = sim.statics[sid].aabb;
          if (bb[1][0] <= s[0][0] || bb[0][0] >= s[1][0] || bb[1][2] <= s[0][2] || bb[0][2] >= s[1][2]) continue;
          if (prevBottom >= s[1][1]) {
            // it was above this thing's top: the top is ground for it
            const gs = s[1][1] - b.ext.y0;
            if (gs > g) { g = gs; on = sid; }
          } else if (bb[1][1] > s[0][1] && bb[0][1] < s[1][1]) {
            // it met a side: push out along the shallower horizontal
            // overlap and reflect that velocity — a wall bounce
            const px = Math.min(bb[1][0] - s[0][0], s[1][0] - bb[0][0]);
            const pz = Math.min(bb[1][2] - s[0][2], s[1][2] - bb[0][2]);
            if (px <= pz) {
              const toward = (b.p[0] + b.ext.cx) < (s[0][0] + s[1][0]) * 0.5;
              b.p[0] = b.p[0] + (toward ? -px : px);
              b.v[0] = -b.v[0] * RESTITUTION;
              b.v[2] = b.v[2] * BOUNCE_FRICTION;
            } else {
              const toward = (b.p[2] + b.ext.cz) < (s[0][2] + s[1][2]) * 0.5;
              b.p[2] = b.p[2] + (toward ? -pz : pz);
              b.v[2] = -b.v[2] * RESTITUTION;
              b.v[0] = b.v[0] * BOUNCE_FRICTION;
            }
            bb = aabbAt(b.p, b.ext);
          }
        }
        b.on = on;
      }
      if (b.p[1] < g && b.v[1] < 0) {
        b.p[1] = g;
        // an impact slower than two gravity-ticks is not a bounce — it is
        // resting CONTACT (the terminal micro-bounce would otherwise feed
        // v[1] from gravity forever and rest could never be reached)
        if (-b.v[1] > 2 * G * dt) {
          b.v[1] = -b.v[1] * RESTITUTION;
          b.v[0] = b.v[0] * BOUNCE_FRICTION;
          b.v[2] = b.v[2] * BOUNCE_FRICTION;
        } else {
          b.v[1] = 0;
        }
      } else if (v2 && b.p[1] <= g && b.v[1] >= 0) {
        // 0.2+: flying INTO rising ground (a hillside) splats to contact;
        // a grounded slider (v[1] === 0) is GLUED to the terrain, following
        // it down and up rather than launching off every bump
        b.p[1] = g;
        b.v[1] = 0;
      } else if (v2 && b.v[1] === 0) {
        // 0.3 only: a step down is followed; a drop (the crate edge) is a
        // fall — gravity takes the next tick. 0.2 glues unconditionally.
        if (!v3 || b.p[1] - g <= STEP_DOWN) b.p[1] = g;
      }
      if (b.p[1] === g && b.v[1] === 0) {
        // grounded: slide out under friction, then rest
        b.v[0] = b.v[0] * GROUND_FRICTION;
        b.v[2] = b.v[2] * GROUND_FRICTION;
        if (b.v[0] * b.v[0] + b.v[2] * b.v[2] < REST_SPEED2) {
          b.v[0] = 0; b.v[2] = 0; b.resting = true;
          if (v3) restStatic(sim, id, b);
        }
      }
      if (!b.resting && sim.tick - b.born > MAX_FLIGHT_TICKS) {
        b.v[0] = 0; b.v[1] = 0; b.v[2] = 0;
        b.p[1] = hf ? hf(b.p[0], b.p[2]) : b.ground;
        b.resting = true;
        if (v3) restStatic(sim, id, b);
      }
    }
  }
  return sim;
}

// The compiled height function for a sim's terrain params — cached by the
// PARAMS OBJECT's identity (a new terrain entry installs a new object), and
// deliberately outside the sim state: SimState stays plain JSON (snapshots
// serialize it directly), and any consumer holding an equal state compiles
// an identical field.
const _fields = new WeakMap();
function heightFieldOf(sim) {
  let f = _fields.get(sim.terrain);
  if (!f) { f = makeHeightField(sim.terrain); _fields.set(sim.terrain, f); }
  return f;
}

/** The verbs whose authoring RELEASES a body — the instant fold's word wins
 *  over recomputation from the moment someone re-authors the entity. */
const RELEASERS = new Set(['place', 'spawn', 'remove', 'mount', 'dismount', 'motion']);
/** (0.3) …and of those, the ones after which the entity stands still where
 *  the fold says (a collider again) vs. moves in ways the sim cannot follow. */
const RESEATERS = new Set(['place', 'spawn', 'dismount']);

/** Fold one entry into the sim. Total, like the instant fold: nothing here
 *  may throw, and a malformed intent shapes nothing. Call AFTER foldEntry.
 *  @param {SimState} sim
 *  @param {{ seq: number, ts: number, actor: string, verb: string,
 *            args: Record<string, unknown> }} entry
 *  @param {{ entities: Record<string, { pos: number[], yaw?: number, lib?: string, scale?: number }> }} st
 *    the instant fold, already folded through this entry */
export function simEntry(sim, entry, st) {
  const a = /** @type {any} */ (entry.args);
  if (entry.verb === 'epoch') {
    const simName = typeof a?.sim === 'string' ? a.sim : null;
    const tickMs = a?.tickMs;
    if (!simName || !Number.isInteger(tickMs) || tickMs < MIN_TICK_MS || tickMs > MAX_TICK_MS) return;
    // A new epoch REPLACES — bodies of the old epoch are released to
    // wherever the last snapshot barrier (or the sequencer's epoch-release
    // places) left them; the barrier fold around the entry is what makes
    // this safe (PROTOCOL_v2 §3).
    sim.epoch = { sim: simName, tickMs, ts: entry.ts, seq: entry.seq,
      ...(CARRIED.has(simName) ? {} : { foreign: true }) };
    sim.tick = 0;
    sim.bodies = {};
    // 0.2+ epochs adopt the world's standing terrain (the instant fold's
    // word, already folded through this entry); 0.1 epochs keep their flat
    // law — sim.terrain stays null so the old advance path cannot see it.
    sim.terrain = simName !== V1 && CARRIED.has(simName) && /** @type {any} */(st)?.terrain
      ? terrainParams(/** @type {any} */(st).terrain) : null;
    // 0.3 epochs adopt the sequencer's word on the world's geometry: the
    // stamped lib → box table, and every standing entity it covers becomes
    // a static. Older laws never see these fields (their JSON is unchanged).
    if (simName === SIM_ID) {
      sim.boxes = {};
      const bx = a.boxes;
      if (bx && typeof bx === 'object' && !Array.isArray(bx)) {
        for (const lib in bx) if (boxOk(bx[lib])) sim.boxes[lib] = bx[lib];
      }
      sim.statics = {};
      const ents = st?.entities ?? {};
      for (const id in ents) setStatic(sim, id, ents[id]);
    } else {
      delete sim.boxes; delete sim.statics;
    }
    return;
  }
  if (!sim.epoch || sim.epoch.foreign) return;   // pre-epoch logs keep v1 semantics whole
  const v3 = sim.epoch.sim === SIM_ID;
  if (entry.verb === 'terrain' && sim.epoch.sim !== V1) {
    // the ground moved wholesale: adopt the new law and release EVERY body
    // to the instant fold — the authored word re-seats entities on the new
    // terrain (the client already re-seats ground-level things on a
    // terrain landing; the sim must not keep flying over a floor that no
    // longer exists)
    advanceSim(sim, tickOf(sim, entry.ts));
    sim.terrain = terrainParams(a ?? {});
    sim.bodies = {};
    return;
  }
  if (entry.verb === 'punt') {
    if (!a?.id || !vec3ok(a.dir)) return;        // dialect-3 punt carries its vector or is inert
    const ent = st.entities[a.id];
    if (!ent || !vec3ok(ent.pos)) return;
    const len2 = a.dir[0] * a.dir[0] + a.dir[1] * a.dir[1] + a.dir[2] * a.dir[2];
    if (!(len2 > 0)) return;
    const len = Math.sqrt(len2);
    let power = Number.isFinite(a.power) ? a.power : 6;
    if (power <= 0) return;
    if (power > MAX_POWER) power = MAX_POWER;
    advanceSim(sim, tickOf(sim, entry.ts));
    const prior = sim.bodies[a.id];              // re-punting a flying body kicks it mid-air
    const p = prior ? prior.p : [ent.pos[0], ent.pos[1], ent.pos[2]];
    const ground = prior ? prior.ground : ent.pos[1];
    const yaw = typeof ent.yaw === 'number' ? ent.yaw : 0;
    const k = power / len;
    delete sim.bodies[a.id];                     // re-insert: body order follows LAST intent
    const body = { p, v: [a.dir[0] * k, a.dir[1] * k, a.dir[2] * k],
      yaw, ground, seq: entry.seq, born: sim.tick, resting: false };
    if (v3) {
      // 0.3: the body carries its own box (its lib's stamped one) and is no
      // longer a static — it is the thing that moves now
      const box = typeof ent.lib === 'string' ? sim.boxes?.[ent.lib] ?? null : null;
      const scale = Number.isFinite(ent.scale) && ent.scale > 0 ? ent.scale : 1;
      Object.assign(body, { box, scale, ext: box ? extentsOf(box, scale, yaw) : null, on: null });
      if (sim.statics) delete sim.statics[a.id];
    }
    sim.bodies[a.id] = body;
    return;
  }
  if (v3 && entry.verb === 'spawn' && a?.id && typeof a.lib === 'string' && boxOk(a.box)) {
    // the sequencer's stamp for a model this epoch had not seen
    sim.boxes[a.lib] = a.box;
  }
  if (RELEASERS.has(entry.verb) && a?.id != null) {
    if (v3 && sim.statics) {
      // a collider change takes effect at ITS entry's tick — advance first,
      // so any schedule reaching a later tick agrees (Covenant IV)
      advanceSim(sim, tickOf(sim, entry.ts));
      if (RESEATERS.has(entry.verb)) setStatic(sim, a.id, st.entities[a.id]);
      else delete sim.statics[a.id];
    }
    if (sim.bodies[a.id]) delete sim.bodies[a.id];
  }
}

/** The composition read: where the sim says this entity is, or null if the
 *  instant fold owns it. @param {SimState} sim @param {string} id */
export function simPose(sim, id) {
  const b = sim.bodies[id];
  return b ? { p: b.p, yaw: b.yaw, resting: b.resting } : null;
}

/** Deterministic serialization for digests and wire — plain JSON is exact
 *  (ECMA number formatting is shortest-round-trip), keys in insertion
 *  order, which the fold makes deterministic. `terrain`, `boxes` and
 *  `statics` ride so a restored snapshot grounds and collides exactly as the
 *  live fold did; older laws carry none of them, so their JSON is unchanged. */
export const simSnapshot = (sim) => ({ epoch: sim.epoch, tick: sim.tick, bodies: sim.bodies,
  ...(sim.terrain ? { terrain: sim.terrain } : {}),
  ...(sim.boxes ? { boxes: sim.boxes } : {}),
  ...(sim.statics ? { statics: sim.statics } : {}) });
