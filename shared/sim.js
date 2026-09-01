// sim — the deterministic sim fold (spec/PROTOCOL_v2.md, dialect 3), as one
// pure module. This is the reference eidosim: fold the sim-scoped entries of
// an epoch through it, advance to a tick, and every conforming
// implementation holds bit-identical state — that is the whole covenant.
//
// Same constraints as everything in shared/ (README.md), tightened to
// Covenant I (owned numerics): ONLY IEEE-754 exact host operations are used
// — + − × ÷, sqrt, comparisons. No Math.sin/cos/exp/pow, no Date.now(), no
// randomness, no unordered iteration (bodies is a plain object; insertion
// order follows entry order, which is the log's order). Number→string is
// ECMA-specified shortest-round-trip, so JSON of this state is itself a
// deterministic serialization — digests may be taken over it directly.
//
// This build CARRIES TWO sims (Covenant II — old logs replay under the law
// they were written under, bit for bit):
//
// eidosim@0.1.0 — flat floor: ground = the body's own starting height
//   (right on build pads, wrong on slopes — which a hilly-meadow playtest
//   duly hit: flights landed on an invisible floor at launch altitude,
//   §24t-3). Its advance law below is UNTOUCHED; 0.1.0 epochs in old logs
//   replay to the same bits they always did (replaybench holds the proof).
//
// eidosim@0.2.0 — terrain-aware ground (the epoch bump 0.1.0's header
//   scheduled): the sim folds the world's `terrain` entries and grounds
//   every body on shared/terrainmath.js — the toolkit's own height law
//   re-expressed in exact ops (Covenant I; ≥99.8% bit-identical to the
//   mesh the client walks, worst divergence ~1e-15). Grounded bodies are
//   GLUED to the terrain while sliding (they follow it down and up; no
//   cliff launches in v0.2); a flight meeting rising ground splats to
//   contact. A `terrain` entry under a live 0.2 epoch re-grounds the world
//   wholesale: every body is released to the instant fold (the authored
//   word re-seats). Worlds with no terrain keep the flat-floor fallback.
//
// Shared by both:
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
// intent landed. Advancement is per-tick fixed-step, so any advance schedule
// reaching tick T yields the same state: snapshots may cut anywhere.

import { terrainParams, makeHeightField } from './terrainmath.js';

// What the epoch verb MINTS (new epochs enter this sim)…
export const SIM_ID = 'eidosim@0.2.0';
// …and what this build can still REPLAY (a carried sim is never foreign).
const CARRIED = new Set(['eidosim@0.1.0', SIM_ID]);
const V1 = 'eidosim@0.1.0';

// The physics constants ARE the sim version — editing any of them is an
// epoch bump, never a patch (Covenant II: it rewrites what old logs mean).
const G = 9.8;                  // m/s² downward
const RESTITUTION = 0.45;       // vertical bounce keep
const BOUNCE_FRICTION = 0.75;   // horizontal keep per bounce
const GROUND_FRICTION = 0.85;   // horizontal keep per grounded tick (slide)
const REST_SPEED2 = 0.0225;     // (0.15 m/s)² — below this, grounded: rest
const MAX_POWER = 20;           // m/s launch cap
const MIN_TICK_MS = 16, MAX_TICK_MS = 1000;
const MAX_FLIGHT_TICKS = 20000; // runaway backstop: force rest (~22min @66ms)

/** @typedef {{ p: number[], v: number[], yaw: number, ground: number,
 *              seq: number, born: number, resting: boolean }} SimBody */
/** @typedef {{ epoch: { sim: string, tickMs: number, ts: number, seq: number,
 *                       foreign?: boolean } | null,
 *              tick: number, bodies: Record<string, SimBody>,
 *              terrain?: ReturnType<typeof terrainParams> | null }} SimState */

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

/** Advance every live body to `toTick` by fixed steps. Pure of wall time.
 *  @param {SimState} sim @param {number} toTick */
export function advanceSim(sim, toTick) {
  if (!sim.epoch || sim.epoch.foreign) { sim.tick = toTick > sim.tick ? toTick : sim.tick; return sim; }
  const dt = sim.epoch.tickMs / 1000;
  const v2 = sim.epoch.sim !== V1;
  const hf = v2 && sim.terrain ? heightFieldOf(sim) : null;
  while (sim.tick < toTick) {
    sim.tick++;
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      if (b.resting) continue;
      b.v[1] = b.v[1] - G * dt;
      b.p[0] = b.p[0] + b.v[0] * dt;
      b.p[1] = b.p[1] + b.v[1] * dt;
      b.p[2] = b.p[2] + b.v[2] * dt;
      // the floor under the body THIS tick: the terrain law (0.2 epochs with
      // a terrain), else the flat launch-height floor (0.1 law, and 0.2's
      // fallback for terrainless worlds)
      const g = hf ? hf(b.p[0], b.p[2]) : b.ground;
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
        // 0.2 only: flying INTO rising ground (a hillside) splats to
        // contact; a grounded slider (v[1] === 0) is GLUED to the terrain,
        // following it down and up rather than launching off every bump
        b.p[1] = g;
        b.v[1] = 0;
      } else if (v2 && b.v[1] === 0) {
        b.p[1] = g;
      }
      if (b.p[1] === g && b.v[1] === 0) {
        // grounded: slide out under friction, then rest
        b.v[0] = b.v[0] * GROUND_FRICTION;
        b.v[2] = b.v[2] * GROUND_FRICTION;
        if (b.v[0] * b.v[0] + b.v[2] * b.v[2] < REST_SPEED2) {
          b.v[0] = 0; b.v[2] = 0; b.resting = true;
        }
      }
      if (!b.resting && sim.tick - b.born > MAX_FLIGHT_TICKS) {
        b.v[0] = 0; b.v[1] = 0; b.v[2] = 0;
        b.p[1] = hf ? hf(b.p[0], b.p[2]) : b.ground;
        b.resting = true;
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

const vec3ok = (a) => Array.isArray(a) && a.length === 3
  && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);

/** The verbs whose authoring RELEASES a body — the instant fold's word wins
 *  over recomputation from the moment someone re-authors the entity. */
const RELEASERS = new Set(['place', 'spawn', 'remove', 'mount', 'dismount', 'motion']);

/** Fold one entry into the sim. Total, like the instant fold: nothing here
 *  may throw, and a malformed intent shapes nothing. Call AFTER foldEntry.
 *  @param {SimState} sim
 *  @param {{ seq: number, ts: number, actor: string, verb: string,
 *            args: Record<string, unknown> }} entry
 *  @param {{ entities: Record<string, { pos: number[], yaw?: number }> }} st
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
    // 0.2 epochs adopt the world's standing terrain (the instant fold's
    // word, already folded through this entry); 0.1 epochs keep their flat
    // law — sim.terrain stays null so the old advance path cannot see it.
    sim.terrain = simName !== V1 && CARRIED.has(simName) && /** @type {any} */(st)?.terrain
      ? terrainParams(/** @type {any} */(st).terrain) : null;
    return;
  }
  if (!sim.epoch || sim.epoch.foreign) return;   // pre-epoch logs keep v1 semantics whole
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
    const k = power / len;
    delete sim.bodies[a.id];                     // re-insert: body order follows LAST intent
    sim.bodies[a.id] = { p, v: [a.dir[0] * k, a.dir[1] * k, a.dir[2] * k],
      yaw: typeof ent.yaw === 'number' ? ent.yaw : 0, ground,
      seq: entry.seq, born: sim.tick, resting: false };
    return;
  }
  if (RELEASERS.has(entry.verb) && a?.id != null && sim.bodies[a.id]) {
    delete sim.bodies[a.id];
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
 *  order, which the fold makes deterministic. `terrain` rides so a restored
 *  snapshot grounds exactly as the live fold did. */
export const simSnapshot = (sim) => ({ epoch: sim.epoch, tick: sim.tick, bodies: sim.bodies,
  ...(sim.terrain ? { terrain: sim.terrain } : {}) });
