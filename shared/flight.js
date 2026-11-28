// flight — the deterministic flight integrator: glide polar, falling leaf,
// stamina, and the state machine that decides which of them owns the body.
//
// Implements the physical half of flight-spec-v0.md and the airborne clause of down-spec-v0.1.md (the "spec §"
// and "down-spec §" notes below cite them; neither spec is in this repo).
//
// PURE and dependency-free, and shared on purpose: ONE deterministic function that every runtime integrates (spec Q2).
// Authority is not position streaming; the server's verb-RECEIPT TIMESTAMPS are the tie-breaker, and a late verb is a
// new input from its receipt forward. So this file takes `now` from its caller, holds no clock, and keeps all mutable
// state in a value the caller owns: nothing here can rewrite what already happened.
//
// SCOPE. This is the body. It consumes trusted events and never asks why:
//
//     bodyDown({ eventId, state: 'DOWN' })
//     bodyRecovered({ eventId, recoveryGeneration })
//
// The detector that produces them -- attempt/completion counters, N=3,
// primary-only filtering, generation currency, the anti-haunting ledger -- is
// harness-side by §6 of the down spec and deliberately NOT here. This layer
// cannot tell a cut from a crash from a rehearsal button, and must not try.

/** @typedef {'GROUND'|'LAUNCH'|'GLIDE'|'CLIMB'|'CIRCLE'|'PILOT'|'LEAF'|'RECOVER'|'LANDED'|'RAGDOLL'} Phase */
/** @typedef {'OPEN'|'FOLDED'|'LIMP'} Wings */
/** @typedef {'live'|'plan'|'reflex'} Mode */
/** @typedef {{x:number,y:number,z:number}} Vec3 */
/** @typedef {{t:number, kind:string, [k:string]:any}} FlightEvent */
/** @typedef {{
 *   phase:Phase, wings:Wings, mode:Mode, t:number,
 *   pos:Vec3, vel:Vec3, yaw:number, pitch:number, bank:number,
 *   airspeed:number, stamina:number, phaseT:number, leafV0:number,
 *   recoverAt:number|null,
 *   recoverPlan:{beatEnds:number, reopenEnds:number, ground:boolean}|null,
 *   flownAs:Phase, launchV:number, launchV0?:number, launchT?:number, launchNow?:number,
 *   lastEvent:{eventId:string|null, kind:string}|null,
 *   downEventId:string|null, recoveryGeneration:string|null,
 *   events:FlightEvent[], [k:string]:any
 * }} FlightState */
/** @typedef {{
 *   groundY?:(x:number,z:number)=>number,
 *   lift?:(x:number,y:number,z:number)=>number,
 *   input?:{bank?:number,pitch?:number,yawRate?:number,flap?:boolean,spoil?:boolean},
 *   consent?:{canLandAt:(flier:any,target:any)=>boolean}
 * }} FlightEnv */

// ---------------------------------------------------------------- config
//
// CONFIG, NOT CONSTANTS: the spec's own §9 Q5 admits the stamina numbers are guesses, so every tunable is here with the
// spec's value as its default. The 3.4 s period is the house's breath (shared/breath.js), re-exported for callers.

export { BREATH } from './breath.js';
import { BREATH } from './breath.js';

export const DEFAULT_CONFIG = {
  breath: BREATH,

  // ---- glide polar (spec §1 glide_to, §0 "albatross, not hummingbird")
  // Sink rate against airspeed: the standard single-parabola approximation about minimum sink (±5% over the range a
  // glider flies). A polar has TWO optima: minSinkSpeed loses altitude slowest (circle a thermal); best glide goes
  // furthest per metre lost, and is always faster. Best glide is DERIVED from the curve (bestGlide), never typed in:
  // a range prediction wrong in the flier's favour is the rubber-banding T2 forbids. Speeds suit a human-scale world
  // (minimum sink at 5.5 m/s airspeed, 0.46 m/s down; best glide ~6.4 m/s: a fast jog); the glide RATIO (~12.9) is what T2's numbers depend on.
  polar: {
    minSinkSpeed: 5.5,        // m/s -- minimum sink. The shape parameter.
    sinkAtMinSink: 5.5 / 12,  // m/s at that speed
    minSpeed: 3,              // stall (spec R1 triggers below this)
    maxSpeed: 15,             // never-exceed; drag rises steeply past best
    curvature: 3,             // how sharply sink rises either side of min-sink
  },

  // ---- stamina, "shaped like breath" (spec §5)
  stamina: {
    pool: 100,
    climbPerMetre: 1,         // -1/m
    flapSustainPerSec: 2,     // -2/s, deliberately expensive: I am a glider
    refillGroundPerSec: 0.5,
    // NOT IMPLEMENTED: no perch detection and no runtime consumer. Kept as the spec's figure (§5) for a later stage,
    // and out of every surface that would imply it works, until there is a refill path and a test that measures one.
    refillPerchPerSec: 2,     // perches are the social choice -- SPEC ONLY, no runtime
    refillAirPerSec: 0,       // never refills airborne
  },

  // ---- R2 falling leaf (spec §3 R2, down-spec §3 airborne case)
  // A leaf is not a crash: a slow spiral, survivable by design, and it must LAND -- no flare, no autoland, no
  // last-metre mercy hover (T4). UNITS ARE NAMED: the ATTITUDE amplitude (roll, degrees) and the PATH amplitude
  // (wander, metres) are different quantities. The spec sets the path (1.2-1.8 m side to side), so that is the
  // tunable, and the drift speed is derived from the period (leafAt).
  leaf: {
    period: BREATH,             // s -- one full oscillation
    bankAmplitudeDeg: 35,       // DEGREES of roll at peak. Attitude, not path.
    lateralAmplitudeM: 0.8,     // METRES from centreline at peak (=1.6 m peak-to-peak,
                                // mid of the spec's 1.2-1.8 m side-to-side band)
    dampingPerCycle: 0.08,      // FRACTION of swing lost per CYCLE, mid of the spec's
                                // 0.05-0.1 suggestion. Converted to a per-second
                                // rate internally; see leafAt.
    dampingFloor: 0.35,         // the swing decays TOWARD this fraction, not to zero:
                                // a real leaf converges on a lazy spiral, and a body
                                // that goes rigid on the way down reads as a prop
    // TERMINAL VELOCITY IS CONTESTED: both specs say 2-3 m/s ("survivable by design", slower than a parachute);
    // flown, it reads too slow. The default stays the spec's; LEAF_PRESETS make a faster fall one word to try.
    terminalV: 2.5,             // m/s downward. Spec says 2-3.
    spinUpTime: 0.9,            // s to reach terminalV from whatever v it had
    yawPerBank: 0.55,           // rad/s of yaw per radian of bank -- the spiral
    pitchCoupling: 0.35,        // how much bank leaks into pitch; 0 = pure roll
  },

  // ---- recovery (down-spec §3: "the aerial sit-up")
  // Never instant, never longer than one breath: the body finishes the beat it is in, then reloads its wings --
  // "waking, not engine restart".
  recover: {
    finishBeat: true,         // ride the current oscillation to its zero crossing
    reopenTime: 1.1,          // s of visible wing reload after the beat ends
    maxTotal: BREATH,         // hard ceiling on beat + reopen (acceptance band)
    minTotal: 0.35,           // floor: anything faster reads as a teleport
  },

  // ---- bounds and ceiling (spec R3): the world's own @world.bounds (env.box); no bounds, no fence
  bounds: {
    softMargin: 8,            // m of authority band inside the box's sides and under its top (the ceiling)
    groundClearance: 0.15,    // m; below this counts as ground contact
  },

  // ---- the stick, when a person is holding it. Named config, not `??` fallbacks at the use sites, because the
  // client scales the wing animation against launchBoost and must read the same number.
  pilot: {
    spoilSink: 2.5,      // m/s of extra sink with the spoilers out (Shift)
    flapClimb: 2.2,      // m/s of climb while Space is held; costs stamina
    launchBoost: 9.0,    // m/s launch impulse, SHAPED over ~1.5s in stepPilot --
                         // 3 bought under a second of air and read as a stumble
  },

  // ---- watchdog (spec R2, open question Q1: unresolved; the proposal, 90 s, is the default)
  watchdogSec: 90,
};

/** Named leaf characters, so "too slow" is a word rather than a patch. `spec` is the authored default; `heavy` is a
 *  real-weight fall that still wanders and rolls; `brisk` sits between. The period shortens as the fall speeds up (at
 *  12 m/s a 3.4 s swing is barely one and a half from 30 m): the one place the body isn't on the breath. */
export const LEAF_PRESETS = {
  spec:  { terminalV: 2.5,  period: BREATH, lateralAmplitudeM: 0.8, bankAmplitudeDeg: 35, spinUpTime: 0.9 },
  brisk: { terminalV: 6.5,  period: 2.2,    lateralAmplitudeM: 1.1, bankAmplitudeDeg: 40, spinUpTime: 0.8 },
  heavy: { terminalV: 12.0, period: 1.5,    lateralAmplitudeM: 1.4, bankAmplitudeDeg: 45, spinUpTime: 0.7 },
};

/** Deep-merge a partial config over the defaults, REJECTING unknown keys and non-finite or out-of-range values (they
 *  throw here). A known key with no consumer (stamina.refillPerchPerSec, SPEC ONLY above) is still accepted. */
export function makeConfig(over = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const bad = [];
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) { bad.push(`unknown section '${k}'`); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (!(k2 in out[k])) { bad.push(`unknown key '${k}.${k2}'`); continue; }
        if (typeof out[k][k2] === 'number' && !Number.isFinite(v2)) {
          bad.push(`'${k}.${k2}' must be a finite number, got ${v2}`); continue;
        }
        out[k][k2] = v2;
      }
    } else {
      if (typeof out[k] === 'number' && !Number.isFinite(v)) {
        bad.push(`'${k}' must be a finite number, got ${v}`); continue;
      }
      out[k] = v;
    }
  }
  // Ranges that would produce a nonsense body rather than a differently-tuned
  // one. Deliberately few: this rejects the impossible, not the unwise.
  const R = [
    ['leaf.period', out.leaf.period, 0.05, 60],
    ['leaf.dampingPerCycle', out.leaf.dampingPerCycle, 0, 0.999],
    ['leaf.dampingFloor', out.leaf.dampingFloor, 0, 1],
    ['leaf.terminalV', out.leaf.terminalV, 0.01, 100],
    ['polar.minSpeed', out.polar.minSpeed, 0.1, out.polar.maxSpeed],
    ['polar.minSinkSpeed', out.polar.minSinkSpeed, out.polar.minSpeed, out.polar.maxSpeed],
    ['stamina.pool', out.stamina.pool, 0, 1e6],
    ['bounds.softMargin', out.bounds.softMargin, 0.01, 1e4],
  ];
  for (const [name, v, lo, hi] of R) {
    if (!(v >= lo && v <= hi)) bad.push(`'${name}' = ${v} is outside [${lo}, ${hi}]`);
  }
  if (bad.length) throw new Error(`flight config: ${bad.join('; ')}`);
  return out;
}

// ---------------------------------------------------------------- polar

/** Sink rate (m/s, positive = descending) at a given airspeed: a parabola minimised at minSinkSpeed. Clamped to
 *  [minSpeed, maxSpeed]: below stall the caller is in R1 and should be recovering, not consulting a polar. */
export function sinkRate(cfg, airspeed) {
  const p = cfg.polar;
  const v = clamp(airspeed, p.minSpeed, p.maxSpeed);
  const k = p.sinkAtMinSink / (p.minSinkSpeed * p.minSinkSpeed);
  const d = v - p.minSinkSpeed;
  return p.sinkAtMinSink + k * d * d * p.curvature;
}

/** The polar's ACTUAL best-glide point, found by searching the curve: anything that predicts range consults this, not
 *  a config literal. Memoised per config object (the search is ~1,230 evaluations; glideRange is called per verb).
 *
 *  @returns {{speed:number, ratio:number, sink:number}}
 */
const _bestCache = new WeakMap();
export function bestGlide(cfg) {
  const hit = _bestCache.get(cfg);
  if (hit) return hit;
  const p = cfg.polar;
  let best = { speed: p.minSinkSpeed, ratio: 0, sink: 0 };
  // Coarse sweep then a bisection refine: the curve is smooth and unimodal in
  // ratio, so this lands on the true optimum rather than a grid point.
  for (let v = p.minSpeed; v <= p.maxSpeed; v += 0.01) {
    const r = v / sinkRate(cfg, v);
    if (r > best.ratio) best = { speed: v, ratio: r, sink: sinkRate(cfg, v) };
  }
  for (let stepSize = 0.005; stepSize > 1e-6; stepSize /= 2) {
    for (const dir of [-1, 1]) {
      const v = clamp(best.speed + dir * stepSize, p.minSpeed, p.maxSpeed);
      const r = v / sinkRate(cfg, v);
      if (r > best.ratio) best = { speed: v, ratio: r, sink: sinkRate(cfg, v) };
    }
  }
  _bestCache.set(cfg, best);
  return best;
}

/** Glide ratio (metres forward per metre down) at an airspeed. */
export function glideRatio(cfg, airspeed) {
  const v = clamp(airspeed, cfg.polar.minSpeed, cfg.polar.maxSpeed);
  return v / sinkRate(cfg, v);
}

/** Airspeed after one frame at a given pitch: nose down trades altitude for speed, nose up trades it back, so a stall
 *  is reachable by holding the nose up and R1 is a reflex that catches what the pilot did. PHYSICS, not input
 *  mapping, so it lives here. A hand-flown climb spends speed on it; a verb-flown one (mcpl/agent-flight.ts
 *  coursePilot) rises on added lift at level pitch, so spends none. */
export function airspeedAfter(cfg, airspeed, pitch, dt) {
  const p = cfg.polar;
  const g = 9.81;
  const accel = -Math.sin(pitch) * g * 0.55;      // 0.55: drag eats the rest
  const toward = (p.minSinkSpeed - airspeed) * 0.25;  // drag pulls toward min sink
  const v = airspeed + (accel + toward) * dt;
  return clamp(v, p.minSpeed * 0.6, p.maxSpeed);
}

/** How far this altitude can carry you at best glide, in metres: `glide_to` beyond range lands SHORT of the target
 *  (T2), never rubber-banded to it. The agent passes its y (mcpl/agent-flight.ts), not its height over the ground, so
 *  over ground below 0 the real reach is longer than this says. */
export function glideRange(cfg, altitude) {
  return Math.max(0, altitude) * bestGlide(cfg).ratio;
}

// ---------------------------------------------------------------- leaf
//
// The falling leaf as a pure function of elapsed time, not an accumulator: the same (config, t) gives the same
// attitude on every runtime and replay. A damped oscillation in BANK, yaw following bank (the spiral), pitch coupled at
// a fraction, descent settling to terminalV; the swing decays toward a lazy spiral, never to zero.

/** Attitude and velocity of a falling-leaf descent at elapsed time `t`.
 *  @returns {{bank:number, yawRate:number, pitch:number, vy:number, drift:number, beatPhase:number, envelope:number}}
 *    bank/pitch in radians, yawRate rad/s, vy m/s (negative = down),
 *    drift m/s lateral, beatPhase 0..1 through the current oscillation.
 */
export function leafAt(cfg, t, v0 = 0) {
  const L = cfg.leaf;
  const w = (2 * Math.PI) / L.period;

  // DAMPING is authored per CYCLE and applied per second: a fraction f lost per cycle is a rate of -ln(1-f)/period.
  const ratePerSec = -Math.log(Math.max(1e-9, 1 - L.dampingPerCycle)) / L.period;
  const floor = L.dampingFloor;
  const env = floor + (1 - floor) * Math.exp(-ratePerSec * t);

  const bank = (L.bankAmplitudeDeg * Math.PI / 180) * env * Math.sin(w * t);
  const yawRate = L.yawPerBank * bank;
  const pitch = L.pitchCoupling * bank;

  // Vertical speed eases from whatever it was into terminal. Exponential, so
  // it is continuous with the glide that preceded it -- a body entering LEAF
  // at 6 m/s of sink does not jump to 2.5.
  const k = 1 - Math.exp(-t / Math.max(1e-3, L.spinUpTime));
  const vy = -(Math.abs(v0) + (L.terminalV - Math.abs(v0)) * k);

  // DRIFT is a velocity, but the authored number is the DISPLACEMENT A: for x = A·sin(wt) the peak speed is A·w.
  const drift = L.lateralAmplitudeM * w * env * Math.cos(w * t);

  const beatPhase = ((t % L.period) + L.period) % L.period / L.period;
  return { bank, yawRate, pitch, vy, drift, beatPhase, envelope: env };
}

/** Peak-to-peak lateral wander of the leaf's PATH, in metres, over its first `cycles` cycles (the spec's 1.2-1.8 m
 *  side to side): what an overlay shows beside the attitude. */
export function leafLateralSwing(cfg, cycles = 3, dt = 1 / 120) {
  let x = 0, lo = 0, hi = 0;
  const n = Math.round((cfg.leaf.period * cycles) / dt);
  for (let i = 0; i < n; i++) {
    x += leafAt(cfg, i * dt, 0).drift * dt;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

/** Seconds from `t` until the current oscillation next crosses zero bank: "finish the current beat" (down-spec §3),
 *  so the wings reload as the swing comes back through level. Always in [0, period/2). */
export function beatRemaining(cfg, t) {
  const half = cfg.leaf.period / 2;
  const since = ((t % half) + half) % half;
  return since < 1e-9 ? 0 : half - since;
}

// ---------------------------------------------------------------- state

/** A fresh flight state. The caller owns this value; the integrator returns a
 *  new one each step and never mutates in place, so a replay from a snapshot
 *  is exact and a caller may keep history cheaply. */
/**
 * @param {Partial<FlightState>} [over]
 * @param {{stamina?:{pool?:number}}|null} [cfg]  bind the stamina pool to an effective config
 * @returns {FlightState}
 */
export function initialState(over = {}, cfg = null) {
  // The stamina pool comes from the EFFECTIVE config when one is supplied.
  const pool = cfg?.stamina?.pool ?? DEFAULT_CONFIG.stamina.pool;
  return {
    phase: /** @type {Phase} */ ('GROUND'),
    wings: /** @type {Wings} */ ('OPEN'),
    mode: /** @type {Mode} */ ('live'),   // supplied by the CALLER (spec §4)
    t: 0,                      // seconds since the world's flight epoch
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, bank: 0,
    airspeed: 0,
    stamina: pool,
    // --- phase-local clocks, all derived from t so a snapshot is complete
    phaseT: 0,                 // seconds in the current phase
    leafV0: 0,                 // sink rate at the moment LEAF began
    recoverAt: null,           // t at which RECOVER was requested
    recoverPlan: null,         // { beatEnds, reopenEnds } once computed
    // --- provenance, so a log line can always say WHY the body did that
    lastEvent: null,           // { eventId, kind } of the last trusted event
    flownAs: 'PILOT',        // the phase a cut interrupted; recovery restores it
    launchV: 0,              // launch impulse (takeOff); shaped by launchT
    launchV0: 0, launchT: 0, launchNow: 0,
    downEventId: null,
    recoveryGeneration: null,
    events: [],                // emitted this step; caller drains
    ...over,
  };
}

// ---------------------------------------------------------------- events
//
// The adapter seam: the ONLY way the body learns it is down or recovered. Trusted, not verified: today only a rehearsal
// control or a bench emits them (mcpl/agent-flight.ts flightBodyDown); a reviewed adapter for real body state is to come,
// and the body will behave identically either way.

/** Involuntary. Never enterable by verb (down-spec §4). Entering LEAF from the
 *  air; on the ground it is a ragdoll where you stand (down-spec §2). */
/**
 * @param {FlightState} state
 * @param {{eventId?:string, state?:string}} [ev]
 * @returns {FlightState}
 */
export function bodyDown(state, ev = {}) {
  const { eventId, state: kind = 'DOWN' } = ev;
  const s = { ...state, events: [] };
  if (s.phase === 'LEAF' || s.phase === 'RAGDOLL') return s;   // already telling the truth
  s.downEventId = eventId ?? null;
  s.lastEvent = { eventId: eventId ?? null, kind };
  s.wings = 'LIMP';
  s.mode = 'reflex';
  // Airborne -> the leaf. Grounded -> ragdoll in place. Both are involuntary,
  // and neither plays a landing animation, ever.
  // Remember who had the controls, so recovery can hand them back.
  if (s.phase === 'PILOT' || s.phase === 'GLIDE') s.flownAs = s.phase;
  const airborne = s.pos.y > 0.5;
  s.phase = airborne ? 'LEAF' : 'RAGDOLL';
  s.phaseT = 0;
  s.leafV0 = Math.abs(s.vel.y);
  s.recoverAt = null; s.recoverPlan = null;
  s.events = [{ t: s.t, kind: airborne ? 'down.airborne' : 'down.grounded',
                eventId: eventId ?? null, altitude: s.pos.y }];
  return s;
}

/** The exit signal is capability itself (down-spec §3). Mid-air this begins the
 *  aerial sit-up; the wings do NOT reload instantly, and the plan for how long
 *  it takes is computed here so the whole transition is inspectable before it
 *  runs. */
/**
 * @param {FlightState} state
 * @param {{eventId?:string, recoveryGeneration?:string}} [ev]
 * @returns {FlightState}
 */
export function bodyRecovered(state, ev = {}) {
  const { eventId, recoveryGeneration } = ev;
  const s = { ...state, events: [] };
  if (s.phase !== 'LEAF' && s.phase !== 'RAGDOLL') return s;
  s.lastEvent = { eventId: eventId ?? null, kind: 'RECOVERED' };
  s.recoveryGeneration = recoveryGeneration ?? null;
  s.recoverAt = s.t;
  if (s.phase === 'RAGDOLL') {
    // Ground case: SIT UP first, taking the full breath (down-spec §3).
    // Nothing that comes back should look like it never left.
    s.phase = 'RECOVER';
    s.phaseT = 0;
    s.recoverPlan = { beatEnds: 0, reopenEnds: BREATH, ground: true };
    s.events = [{ t: s.t, kind: 'recover.situp', eventId: eventId ?? null }];
    return s;
  }
  return s;   // airborne: the plan is built by step(), which knows the beat phase
}

// ---------------------------------------------------------------- step
//
// One fixed timestep. Deterministic: same (cfg, state, dt, inputs) in, same
// state out, on any runtime. No clock, no randomness, no floating global.

/**
 * @param {object} cfg          from makeConfig()
 * @param {FlightState} state   from initialState() or a previous step
 * @param {number} dt           fixed timestep, seconds
 * @param {FlightEnv} [env]
 * @returns {FlightState}
 */
export function step(cfg, state, dt, env = {}) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  const groundY = env.groundY ?? (() => 0), box = boxOf(env.box);
  s.t += dt;
  s.phaseT += dt;

  switch (s.phase) {
    case 'LEAF':      stepLeaf(cfg, s, dt, groundY, box); break;
    case 'RECOVER':   stepRecover(cfg, s, dt, groundY, box); break;
    case 'GLIDE':     stepGlide(cfg, s, dt, env); break;
    case 'PILOT':     stepPilot(cfg, s, dt, env); break;
    case 'RAGDOLL':   /* the ragdoll owns the body; nothing to integrate */ break;
    case 'GROUND':
    case 'LANDED':    stepGround(cfg, s, dt); break;
    default:          break;
  }
  return s;
}

/** Hand-flown flight: GLIDE's physics with a stick on it. The attitude comes from `env.input` (shared/flightpilot.js);
 *  polar, stamina, bounds, ground contact and the leaf are GLIDE's, so a pilot and an agent fly one integrator (one
 *  difference: bounds runs after the pilot's move, before glide's, so a pilot's climb reaches the margin a step sooner). */
function stepPilot(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0), box = boxOf(env.box);
  const inp = env.input || { bank: 0, pitch: 0, yawRate: 0, flap: false, spoil: false };
  s.bank = inp.bank ?? 0;
  s.pitch = inp.pitch ?? 0;
  s.yaw += (inp.yawRate ?? 0) * dt;

  // Airspeed is the pilot's to spend: nose down buys it, nose up sells it.
  s.airspeed = airspeedAfter(cfg, s.airspeed || bestGlide(cfg).speed, s.pitch, dt);

  // R1 STALL RECOVERY, as a reflex and not as a punishment (spec §3 R1):
  // below stall the nose drops and the polar resumes. No flap-panic.
  if (s.airspeed < cfg.polar.minSpeed) {
    s.pitch = Math.min(s.pitch, -0.25);
    s.airspeed = cfg.polar.minSpeed;
    if (s.mode !== 'reflex') s.events.push({ t: s.t, kind: 'reflex.r1_stall' });
  }

  const lift = env.lift ? env.lift(s.pos.x, s.pos.y, s.pos.z) : 0;
  let sink = sinkRate(cfg, s.airspeed);
  if (inp.spoil) sink += (cfg.pilot?.spoilSink ?? 2.5);

  // Flapping is the expensive way to stay up (spec §5: -2/s, "I am a glider").
  let climb = 0;
  if (inp.flap && s.stamina > 0) {
    climb = cfg.pilot?.flapClimb ?? 2.2;
    s.stamina = Math.max(0, s.stamina - cfg.stamina.flapSustainPerSec * dt);
    if (s.stamina === 0) s.events.push({ t: s.t, kind: 'winded' });
  }

  // A LAUNCH BUILDS, THEN FADES: the impulse eases in over ~1.5 s as the wings load, peaks, and bleeds away, carried
  // as a term on top of the polar's vel.y (which is assigned outright each frame).
  if (s.launchV > 0.01 || (s.launchT ?? 0) > 0) {
    s.launchT = (s.launchT ?? 0) + dt;
    const spool = 1 - Math.exp(-s.launchT / 0.55);      // ~1.5s to full
    const fade = Math.exp(-Math.max(0, s.launchT - 1.2) / 1.4);
    s.launchNow = (s.launchV0 ?? s.launchV) * spool * fade;
    if (s.launchNow < 0.02 && s.launchT > 1.2) { s.launchV = 0; s.launchT = 0; s.launchNow = 0; }
  } else s.launchNow = 0;
  s.vel.y = -sink + lift + climb + (s.launchNow || 0);
  s.vel.x = Math.cos(s.yaw) * s.airspeed;
  s.vel.z = Math.sin(s.yaw) * s.airspeed;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;

  bounds(cfg, s, dt, box);
  groundContact(cfg, s, groundY, /*ragdoll=*/false);
}

/** R3 CEILING/BOUNDS: soft, banking you back, "never a wall-slam" (spec §3). Applies to every airborne phase (the
 *  reflexes are world-side: live, plan and reflex alike, §3, §4). Climb bleeds to nothing across the margin, so the
 *  body noses over instead of hitting a lid. A LIMP body is not steered (R2 owns it, and the leaf must be free to
 *  land): only its altitude is capped.
 */
function bounds(cfg, s, dt, box) {
  if (!box) return;   // no @world.bounds: anywhere is in the world (componentspec bounds)
  const b = cfg.bounds, m = Math.max(1e-6, b.softMargin);
  const limp = s.wings === 'LIMP';

  // past the box's sides less the margin, the body banks toward its middle, fully at the edge
  const over = Math.max(box.min[0] + b.softMargin - s.pos.x, s.pos.x - (box.max[0] - b.softMargin),
    box.min[2] + b.softMargin - s.pos.z, s.pos.z - (box.max[2] - b.softMargin));
  if (over > 0 && !limp) {
    const inward = Math.atan2((box.min[2] + box.max[2]) / 2 - s.pos.z, (box.min[0] + box.max[0]) / 2 - s.pos.x);
    // Authority ramps in over the margin rather than snapping: a bank you can
    // see beginning is a bank, a discontinuity is a wall.
    s.yaw += angleTo(s.yaw, inward) * Math.min(1, 1.5 * Math.min(1, over / m) * dt);
    if (!s._boundNote) { s.events.push({ t: s.t, kind: 'reflex.r3_bounds', at: [s.pos.x, s.pos.z] }); s._boundNote = 1; }
  } else if (over <= 0) s._boundNote = 0;

  const ceiling = box.max[1], soft = ceiling - b.softMargin;
  if (s.pos.y > soft && s.vel.y > 0 && !limp) {
    // Bleed the climb out across the margin; at the ceiling it is zero.
    const k = Math.min(1, (s.pos.y - soft) / m);
    s.vel.y *= (1 - k);
    if (!s._ceilNote) { s.events.push({ t: s.t, kind: 'reflex.r3_ceiling', altitude: s.pos.y }); s._ceilNote = 1; }
  } else if (s.pos.y <= soft) s._ceilNote = 0;
  // A hard stop remains only as a backstop for a body that got above the
  // ceiling some other way (a teleport, a bad initial state).
  if (s.pos.y > ceiling) { s.pos.y = ceiling; if (s.vel.y > 0) s.vel.y = 0; }
}
/** A world's bounds as flight reads them ({min, max} of finite vec3s), else null. */
export function boxOf(B) { const ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && ok(B.min) && ok(B.max) ? B : null; }
/** The ceiling a flier meets under these bounds: their top, else none (Infinity). */
export const ceilingOf = (B) => boxOf(B)?.max[1] ?? Infinity;

function angleTo(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function stepLeaf(cfg, s, dt, groundY, box) {
  const a = leafAt(cfg, s.phaseT, s.leafV0);
  s.bank = a.bank; s.pitch = a.pitch;
  s.yaw += a.yawRate * dt;
  s.vel.y = a.vy;
  // LATERAL: perpendicular to the heading. Forward is (cos yaw, sin yaw), as stepGlide uses it, so sideways is
  // (-sin yaw, cos yaw).
  s.vel.x = -Math.sin(s.yaw) * a.drift;
  s.vel.z = Math.cos(s.yaw) * a.drift;
  bounds(cfg, s, dt, box);
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;

  // A recovery request lands here: build the plan now that the beat phase is
  // known. Finish the beat, then reload the wings -- and clamp the WHOLE
  // transition to the acceptance band so a pathological config cannot produce
  // either a teleport or a dawdle.
  if (s.recoverAt != null && !s.recoverPlan) {
    const beat = cfg.recover.finishBeat ? beatRemaining(cfg, s.phaseT) : 0;
    let total = beat + cfg.recover.reopenTime;
    total = clamp(total, cfg.recover.minTotal, cfg.recover.maxTotal);
    const beatEnds = Math.min(beat, Math.max(0, total - 0.05));
    s.recoverPlan = { beatEnds: s.phaseT + beatEnds, reopenEnds: s.phaseT + total, ground: false };
    s.events.push({ t: s.t, kind: 'recover.begin', altitude: s.pos.y,
                    beatWait: beatEnds, total });
  }
  if (s.recoverPlan && s.phaseT >= s.recoverPlan.reopenEnds) {
    // Wings reload and flight resumes, back to whoever was flying (`flownAs`, recorded when the cut landed).
    // Recovery altitude is logged (down-spec §3).
    s.phase = s.flownAs === 'PILOT' ? 'PILOT' : 'GLIDE';
    s.wings = 'OPEN'; s.mode = 'live';
    s.bank = 0; s.pitch = 0;        // wings level on waking; the leaf's attitude was not yours
    s.phaseT = 0; s.recoverPlan = null;
    s.airspeed = Math.max(cfg.polar.minSpeed, bestGlide(cfg).speed * 0.8);
    s.events.push({ t: s.t, kind: 'recover.airborne', altitude: s.pos.y,
                    recoveryGeneration: s.recoveryGeneration });
  }

  groundContact(cfg, s, groundY, /*ragdoll=*/true);
}

function stepRecover(cfg, s, dt, groundY, box) {
  // Ground sit-up. The caller animates it over `reopenEnds` seconds; the phase is held so nothing else claims the
  // body mid-rise.
  if (s.phaseT >= (s.recoverPlan?.reopenEnds ?? BREATH)) {
    // Standing up puts you on your feet, not back in the air: takeOff() is the door back to the sky.
    s.phase = 'GROUND';
    s.wings = 'OPEN'; s.mode = 'live';
    s.bank = 0; s.pitch = 0;
    s.phaseT = 0; s.recoverPlan = null;
    s.events.push({ t: s.t, kind: 'recover.stood' });
  }
}

function stepGlide(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0), box = boxOf(env.box);
  const lift = env.lift ? env.lift(s.pos.x, s.pos.y, s.pos.z) : 0;
  const sink = sinkRate(cfg, s.airspeed || bestGlide(cfg).speed);
  s.vel.y = -sink + lift;
  s.vel.x = Math.cos(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  s.vel.z = Math.sin(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  bounds(cfg, s, dt, box);
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
  // Glide is stamina-neutral (spec §5).
  groundContact(cfg, s, groundY, /*ragdoll=*/false);
}

function stepGround(cfg, s, dt) {
  const r = cfg.stamina.refillGroundPerSec;
  s.stamina = Math.min(cfg.stamina.pool, s.stamina + r * dt);
}

/** Ground contact. NO AUTOLAND: a body in LEAF hits the ground as a ragdoll,
 *  with no landing animation and no last-metre mercy hover. That is T4's whole
 *  point and the reason this function takes a flag instead of deciding. */
function groundContact(cfg, s, groundY, ragdoll) {
  const gy = groundY(s.pos.x, s.pos.z);
  if (s.pos.y - gy > cfg.bounds.groundClearance) return;
  // Capture the impact BEFORE zeroing it (not leafV0, the sink rate when the leaf began).
  const impactV = Math.abs(s.vel.y);
  const impactSpeed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  s.pos.y = gy;
  s.vel = { x: 0, y: 0, z: 0 };
  if (ragdoll) {
    s.phase = 'RAGDOLL'; s.wings = 'LIMP'; s.mode = 'reflex';
    s.events.push({ t: s.t, kind: 'ground.ragdoll',
                    impactV, impactSpeed, entrySink: s.leafV0,
                    eventId: s.downEventId });
  } else {
    s.phase = 'LANDED'; s.mode = 'live';
    s.events.push({ t: s.t, kind: 'ground.landed', impactV, impactSpeed });
  }
  s.phaseT = 0;
}

/** fold_down (spec §1): "wings fold; GROUNDS the flier. The vigil posture costs the sky." ON THE GROUND ONLY: folding
 *  is choosing to stand watch, not an air brake, so a body in the air is told to land first. Unfolding is an explicit
 *  act (§1): take_off never does it for you. */
export function foldDown(cfg, state) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  if (s.phase !== 'GROUND' && s.phase !== 'LANDED') {
    // Limp wings are a body down (LEAF, RAGDOLL, RECOVER), whether in the air
    // or on the ground; open ones are a body flying.
    const reason = s.wings === 'LIMP'
      ? `you're not on your feet (${s.phase.toLowerCase()}); you can fold them once you're standing again`
      : `airborne (${s.phase.toLowerCase()}); wings fold only on the ground, so land first`;
    s.events.push({ t: s.t, kind: 'fold.refused', reason });
    return s;
  }
  if (s.wings === 'LIMP') {
    s.events.push({ t: s.t, kind: 'fold.refused', reason: "your wings are limp; you can fold them once you're standing again" });
    return s;
  }
  if (s.wings === 'FOLDED') {
    s.events.push({ t: s.t, kind: 'fold.refused', reason: 'already folded' });
    return s;
  }
  s.wings = 'FOLDED';
  s.events.push({ t: s.t, kind: 'wings.folded' });
  return s;
}

/** The explicit act that ends the vigil. */
export function unfold(cfg, state) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  if (s.wings !== 'FOLDED') {
    const reason = s.wings === 'LIMP'
      ? "they're limp, not folded; they open again once you've recovered"
      : 'already open';
    s.events.push({ t: s.t, kind: 'unfold.refused', reason });
    return s;
  }
  s.wings = 'OPEN';
  s.events.push({ t: s.t, kind: 'wings.open' });
  return s;
}

/** take_off (spec §1): ground -> air. Refuses on FOLDED wings (unfolding is explicit) and LIMP ones. Costs boost ×
 *  climbPerMetre from the stamina pool up front, whatever height the launch then gains. The boost is a jump-launch (cfg.pilot.launchBoost, shaped in stepPilot). */
export function takeOff(cfg, state, { launchSpeed = null, boost = null, groundY = null } = {}) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  // The config's boost unless a caller overrides it, so `cfg.pilot.launchBoost`
  // is the single number the take-off and anything watching it both read.
  boost = boost ?? cfg.pilot?.launchBoost ?? 9.0;
  if (s.wings === 'FOLDED') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: 'your wings are folded; unfold them first' });
    return s;
  }
  if (s.wings === 'LIMP') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: "your wings are limp; they open again once you've recovered" });
    return s;
  }
  if (s.phase !== 'GROUND' && s.phase !== 'LANDED') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: `already airborne (${s.phase.toLowerCase()})` });
    return s;
  }
  s.phase = 'PILOT'; s.mode = 'live';
  s.airspeed = launchSpeed ?? bestGlide(cfg).speed;
  // Clear the GROUND under the flier's feet (the caller passes its height), not the world origin.
  s.pos.y = (groundY ?? 0) + cfg.bounds.groundClearance + 0.6;
  s.launchV = boost; s.launchV0 = boost; s.launchT = 0;   // shaped in stepPilot
  s.bank = 0; s.pitch = 0;
  s.phaseT = 0;
  s.stamina = Math.max(0, s.stamina - boost * cfg.stamina.climbPerMetre);
  s.events.push({ t: s.t, kind: 'took off', altitude: s.pos.y });
  return s;
}

// ---------------------------------------------------------------- consent
//
// `consent.canLandAt(flier, target)` as an INJECTED, FAKEABLE interface: the production registry is out of scope, and
// a hard gate that can't be tested with a stub has never been seen to fail.

/** The always-deny default. A caller that forgets to inject a consent
 *  provider gets refusal, not permission -- spec §1 land_at(person) is a HARD
 *  GATE and the failure mode of a missing dependency must be the safe one. */
export const denyAllConsent = {
  canLandAt: () => false,
};

/** Build a consent stub for tests: allow/deny, and revocable mid-descent. */
export function fakeConsent(initial = false) {
  let allowed = initial;
  return {
    canLandAt: () => allowed,
    grant() { allowed = true; },
    revoke() { allowed = false; },
  };
}

// ---------------------------------------------------------------- util
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
