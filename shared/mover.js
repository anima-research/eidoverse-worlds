// mover — ONE locomotion integrator for every body, in every runtime.
//
// Walking used to be written three times: the agent's stride (mcpl/agent.ts), the human client's stride
// (client/lib/controller.js + colliders.js + bodyscale.js) and the authority's plausibility track
// (shared/protocol/authority.js TRACK). Three copies of "how fast, how wide, how high a step" drift — a 3 cm
// disagreement between two of them turned a test red (10-13) — and a wall one walker could step over was solid to
// another. This file is the one place they all read, on the model of shared/flight.js: PURE, no THREE, no DOM,
// no clock; every piece of state is a value the caller owns, and everything a world could disagree about comes in
// as `env` callbacks.
//
// THE AUTHORITY ASKS THE MOVER WHERE A BODY MAY GO; the agent and the client STEP with it. The authority's
// refusal of a step (too fast, into a solid, up a ledge) is therefore the mover's own answer about the same
// input, and a step the mover accepts here is one the authority accepts there, to the millimetre.
//
// MODES. A body has one mover and the mover has modes. `walk` is implemented here; `fly` is shared/flight.js's
// integrator (already one function for every runtime) and joins this table when its state moves in; `swim` and
// `drive` are names reserved so they can join without renaming anything. A mode owns the body's position while it
// lasts: stepping in a mode a body isn't in is a no-op with a reason, never a teleport.
//
// Style, as flight.js: config with the spec's numbers as DEFAULTS (tuning is a diff to a literal, never a hunt
// through the integrator), typedefs, pure functions that take the config first.

/** @typedef {[number, number, number]} P3 */
/** @typedef {{min:P3, max:P3}} Box */
/** @typedef {'walk'|'fly'|'swim'|'drive'} Mode */
/** @typedef {{
 *   floorAt?:(x:number, z:number, y:number)=>number,   // the floor under (x, z) for a body whose feet are at y; NaN/undefined = unknown (keep y)
 *   blocked?:(box:Box, step:{from:P3, to:P3})=>any,    // truthy (an id, say) when a body in `box` would be inside something solid
 * }} MoverEnv */
/** @typedef {{pos:P3, moved:number, blocked:null|{by:any, top?:number}}} StepResult */

// ---------------------------------------------------------------- config
export const MOVER = Object.freeze({
  /** every mode this file knows; only `walk` steps here today (see MODES) */
  modes: Object.freeze(["walk", "fly", "swim", "drive"]),
  walk: Object.freeze({
    speed: 1.55,   // m/s, a walk (the agent's WALK; the client's W; the VR stick at half deflection)
    run: 4.0,      // m/s, a run (Shift; run: true; full stick)
    creep: 0.55,   // m/s, the client's Alt: a slow walk for placing a chair exactly
    ease: 10,      // 1/s: a client's speed eases toward its target at this rate (easeSpeed); an agent snaps
  }),
  body: Object.freeze({
    radius: 0.2,   // m, half the body's width: the walking capsule, the authority's box
    height: 1.7,   // m, the body's height over its feet
    step: 0.8,     // m, the highest ledge a body walks onto without a mantle; the authority's box starts here
  }),
  track: Object.freeze({
    speed: 6,      // m/s the authority lets a tracked body sustain (a run with latency to spare)
    cap: 4,        // m it may cover in one step (the burst a token bucket holds)
    spawnR: 2,     // m a visitor may arrive from @world.spawn when the world declares one
    sweep: 0.05,   // m between the points at which a step is tested for solids
  }),
  arrive: Object.freeze({
    tolerance: 0.01,   // m: this close to the target is arrived (short positioning moves are honoured)
    max: 0.4,          // m: the widest tolerance a caller may ask for
  }),
});
/** The modes that step here. `fly` is shared/flight.js's integrator until its state moves in. */
export const MODES = Object.freeze(["walk"]);

/** The authority's name for the body's track numbers. The same numbers as MOVER (one source), under the names
 *  authority.js and its reviews use: TRACK.speed, cap, step, radius, height, spawnR. */
export const TRACK = Object.freeze({
  speed: MOVER.track.speed, cap: MOVER.track.cap, spawnR: MOVER.track.spawnR,
  step: MOVER.body.step, radius: MOVER.body.radius, height: MOVER.body.height,
});

// ---------------------------------------------------------------- the body
/** A size multiplier's clamp, as shared/presencewire.js keeps it (0.5–2; a non-number is 1). Re-stated here rather
 *  than imported so this file stays leaf-level, as flight.js is. */
const scaleOf = (u) => (typeof u === "number" && Number.isFinite(u) ? Math.min(2, Math.max(0.5, u)) : 1);

/** Walking speed for the flags a caller holds: run outranks creep; the stride grows with the body. */
export function walkSpeed({ run = false, creep = false, scale = 1 } = {}) {
  const w = MOVER.walk;
  return (run ? w.run : creep ? w.creep : w.speed) * scaleOf(scale);
}

/** The VR stick's speed: half deflection is a walk, full is a run, ramping between (owner, 09-06). */
export function stickSpeed(mag, scale = 1) {
  const m = Math.min(1, Math.max(0, mag)), w = MOVER.walk;
  return (m <= 0.5 ? w.speed * (m / 0.5) : w.speed + (w.run - w.speed) * ((m - 0.5) / 0.5)) * scaleOf(scale);
}

/** A client's speed easing toward `target` over `dt` (the walk→idle coast and the start-up ramp). */
export function easeSpeed(prev, target, dt) {
  const k = 1 - Math.exp(-MOVER.walk.ease * dt);
  const v = prev + (target - prev) * k;
  return v < 0.02 ? 0 : v;
}

/** The body as an axis-aligned box over its feet at p: from `step` up (a ledge below that is walked onto, not hit) to
 *  its height, `radius` either side. The authority tests this box against the world's solids. */
export function bodyBox(p, scale = 1) {
  const s = scaleOf(scale), r = MOVER.body.radius * s;
  return { min: [p[0] - r, p[1] + MOVER.body.step * s, p[2] - r], max: [p[0] + r, p[1] + MOVER.body.height * s, p[2] + r] };
}
/** The body's capsule for a client's collider pass: radius and height for its size. */
export function capsule(scale = 1) {
  const s = scaleOf(scale);
  return { r: MOVER.body.radius * s, tall: MOVER.body.height * s, step: MOVER.body.step * s };
}

/** The floor rule, one line, every caller: a floor at `top` is walked onto when it is no more than a step above the
 *  feet at y (any floor below is stepped down onto). */
export const floorOk = (y, top, scale = 1) => top <= y + MOVER.body.step * scaleOf(scale) + 1e-9;

/** A ledge a body can climb onto with a mantle (the client's jump-at-a-wall): above a step, up to its height. */
export const canMantle = (reach, scale = 1) => { const s = scaleOf(scale); return reach > MOVER.body.step * s && reach <= MOVER.body.height * s; };

// ---------------------------------------------------------------- arrival
/** This close to the target (in the ground plane) is arrived. */
export function arrived(pos, target, tolerance = MOVER.arrive.tolerance) {
  return Math.hypot(target[0] - pos[0], target[1] - pos[2]) <= tolerance;
}
/** A caller's tolerance is a finite number from 0 to the mover's max; anything else is refused (null). */
export function toleranceOf(t) {
  if (t === undefined || t === null) return MOVER.arrive.tolerance;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= MOVER.arrive.max ? t : null;
}

// ---------------------------------------------------------------- the track (the authority's bucket)
/** The metres a tracked body may cover now: its bucket refilled at the track's speed since its last accepted step,
 *  never over the cap. `prev` is the tokens it had (absent = full); `elapsedMs` since then. */
export function tokensAfter(prev, elapsedMs) {
  const t = MOVER.track;
  return Math.min(t.cap, (typeof prev === "number" ? prev : t.cap) + t.speed * Math.max(0, elapsedMs) / 1000);
}
/** The points at which a step from `from` to `to` is tested for solids: every `sweep` metres, ending at `to`
 *  (never `from`: a body already inside something may walk out of it). */
export function sweep(from, to, spacing = MOVER.track.sweep) {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / spacing));
  const out = [];
  for (let k = 1; k <= n; k++) out.push(from.map((v, i) => v + (to[i] - v) * k / n));
  return out;
}

// ---------------------------------------------------------------- stepping
/** One stride of a walk. `dir` is a ground-plane direction [dx, dz] (any length; zero = stand); `gain` scales the
 *  stride (a client's eased speed as a fraction of the mover's — 1 = a full stride; an agent's tick is 1); `cap` is
 *  the most this step may cover (the distance left to a target, the authority's permit). The floor under the new
 *  spot comes from env.floorAt (absent: y is kept); a floor more than a step up is a wall and the body stays put;
 *  env.blocked (absent: nothing blocks) is asked with the body's box at the new spot and refuses the step.
 *  → {pos, moved, blocked}. Never mutates its inputs. */
export function stepWalk({ pos, dir, dt, run = false, creep = false, scale = 1, gain = 1, cap = Infinity, mode = "walk" }, env = {}) {
  const here = [pos[0], pos[1], pos[2]];
  if (mode !== "walk") return { pos: here, moved: 0, blocked: { by: `mode:${mode}` } };
  const len = Math.hypot(dir[0], dir[1]);
  if (!(len > 0) || !(dt > 0) || !(gain > 0)) return { pos: here, moved: 0, blocked: null };
  const d = Math.min(cap, walkSpeed({ run, creep, scale }) * gain * dt);
  if (!(d > 0)) return { pos: here, moved: 0, blocked: null };
  const nx = pos[0] + (dir[0] / len) * d, nz = pos[2] + (dir[1] / len) * d;
  let ny = pos[1];
  if (env.floorAt) {
    const f = env.floorAt(nx, nz, pos[1]);
    if (Number.isFinite(f)) { if (!floorOk(pos[1], f, scale)) return { pos: here, moved: 0, blocked: { by: "ledge", top: f } }; ny = f; }
  }
  const to = [nx, ny, nz];
  if (env.blocked) { const hit = env.blocked(bodyBox(to, scale), { from: here, to }); if (hit) return { pos: here, moved: 0, blocked: { by: hit } }; }
  return { pos: to, moved: d, blocked: null };
}

/** A stride toward a target [x, z]: arrives (no move) within `tolerance`, else steps at most the distance left (and
 *  `room`, a permit's cap). → {pos, arrived, moved, yaw, blocked}; yaw is atan2(dx, dz), the renderers' heading. */
export function walkToward({ pos, target, dt, run = false, scale = 1, tolerance = MOVER.arrive.tolerance, room = Infinity, gain = 1 }, env = {}) {
  const dx = target[0] - pos[0], dz = target[1] - pos[2], dist = Math.hypot(dx, dz);
  const yaw = dist > 0 ? Math.atan2(dx, dz) : null;
  if (dist <= tolerance) return { pos: [pos[0], pos[1], pos[2]], arrived: true, moved: 0, yaw, blocked: null };
  const r = stepWalk({ pos, dir: [dx, dz], dt, run, scale, gain, cap: Math.min(dist, room) }, env);
  return { ...r, arrived: false, yaw };
}
