// flight — the deterministic flight integrator: glide polar, falling leaf,
// stamina, and the state machine that decides which of them owns the body.
//
// Implements the physical half of flight-spec-v0.md (SHA-256
// 641da611754c7097142e16b355a6dd79b4d431646e0c1d890759884f86fbe805) and the
// airborne clause of down-spec-v0.1.md v0.1.1 (SHA-256
// 71e4fff28fbc6145f452df9a8b7a03b3fbbcd0bf9eba471f207edbd3435c0a91).
// Author of both, and acceptance authority: Mythos.
//
// PURE and dependency-free, and here rather than in server/ or client/ for the
// reason the directory exists: the spec's Q2 asks whether the glide polar is
// authoritative server-side or cosmetic client-side, and the answer ruled by
// the author is neither-and-both — ONE deterministic function that every
// runtime integrates. Authority is not position streaming; authority is the
// server's verb-RECEIPT TIMESTAMPS being the tie-breaker. A late verb is a new
// input from its receipt forward. The trajectory before it is already true and
// stays true.
//
// That is the anti-haunting clause wearing aerodynamics, and it is why this
// file takes `now` from its caller, holds no clock, and keeps every piece of
// mutable state in a value the caller owns: nothing here can rewrite what
// already happened, because nothing here remembers it.
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
// CONFIG, NOT CONSTANTS -- Mica's word, and the spec's own §9 Q5 admits the
// stamina numbers are guesses. Everything a reviewer might want to tune is
// here with the spec's value as its DEFAULT, so tuning is a diff to a config
// literal and never a hunt through the integrator.
//
// The 3.4s period is not a tunable in the same sense as the rest. It is the
// house's breath -- wing idle, stamina tick, and the leaf oscillation all beat
// on it (spec §5, §2, T8) -- so it appears once, here, and everything that
// needs a period reads it rather than restating it.

export const BREATH = 3.4;              // seconds. The period. See spec T8.

export const DEFAULT_CONFIG = {
  breath: BREATH,

  // ---- glide polar (spec §1 glide_to, §0 "albatross, not hummingbird")
  // Sink rate as a function of airspeed: a parabola about minimum sink, which
  // is the standard single-parabola approximation and honest to about +/-5%
  // over the range a glider actually flies.
  //
  // A polar has TWO optima and they are not the same speed. minSinkSpeed is
  // where you lose altitude slowest (circle a thermal here); bestGlideSpeed is
  // where you go furthest per metre lost (cross country here), and it is
  // always faster, because ratio is v/sink and the numerator keeps growing
  // after the denominator bottoms out.
  //
  // The first cut called minimum-sink "bestSpeed" and published its ratio as
  // "bestGlideRatio", so glideRange() under-predicted: the implemented curve
  // actually reaches 12.93 at 12.70 m/s, i.e. 388 m from 30 m and not the 360
  // the receipt claimed. A range prediction that is wrong in the FLIER'S
  // FAVOUR is the exact rubber-banding T2 exists to forbid, so the names now
  // say which optimum they mean and the glide numbers are DERIVED from the
  // curve by search rather than asserted next to it.
  polar: {
    minSinkSpeed: 11,         // m/s -- minimum sink. The shape parameter.
    sinkAtMinSink: 11 / 12,   // m/s at that speed
    minSpeed: 6,              // stall (spec R1 triggers below this)
    maxSpeed: 30,             // never-exceed; drag rises steeply past best
    curvature: 3,             // how sharply sink rises either side of min-sink
  },

  // ---- stamina, "shaped like breath" (spec §5)
  stamina: {
    pool: 100,
    climbPerMetre: 1,         // -1/m
    flapSustainPerSec: 2,     // -2/s, deliberately expensive: I am a glider
    refillGroundPerSec: 0.5,
    refillPerchPerSec: 2,     // perches are the social choice
    refillAirPerSec: 0,       // never refills airborne
  },

  // ---- R2 falling leaf (spec §3 R2, down-spec §3 airborne case)
  // The whole configurable block Mica named. A leaf is not a crash: it is a
  // slow spiral, survivable by design, and it must LAND -- no flare, no
  // autoland, no last-metre mercy hover (T4 is "the spec's soul").
  // UNITS ARE NAMED, because two different "amplitudes" live here and mica
  // caught me conflating them. A leaf has an ATTITUDE amplitude (how far it
  // rolls, degrees) and a PATH amplitude (how far it wanders, metres), and
  // they are not each other: the path amplitude depends on the roll AND the
  // period AND the terminal speed, so quoting one as if it were the other is
  // how a config gets tuned in the wrong direction.
  //
  // Mythos specified the PATH: 1.2-1.8 m side to side. So that is the
  // tunable, in metres, and the drift SPEED needed to achieve it is derived
  // from the period rather than typed in -- which also means changing the
  // period keeps the wander where he asked for it instead of silently
  // rescaling it.
  leaf: {
    period: BREATH,             // s -- one full oscillation
    bankAmplitudeDeg: 35,       // DEGREES of roll at peak. Attitude, not path.
    lateralAmplitudeM: 0.8,     // METRES from centreline at peak (=1.6 m peak-to-peak,
                                // mid of Mythos's 1.2-1.8 m side-to-side band)
    dampingPerCycle: 0.08,      // FRACTION of swing lost per CYCLE, mid of his
                                // 0.05-0.1 suggestion. Converted to a per-second
                                // rate internally; see leafAt.
    dampingFloor: 0.35,         // the swing decays TOWARD this fraction, not to zero:
                                // a real leaf converges on a lazy spiral, and a body
                                // that goes rigid on the way down reads as a prop
    terminalV: 2.5,             // m/s downward. Spec says 2-3.
    spinUpTime: 0.9,            // s to reach terminalV from whatever v it had
    yawPerBank: 0.55,           // rad/s of yaw per radian of bank -- the spiral
    pitchCoupling: 0.35,        // how much bank leaks into pitch; 0 = pure roll
  },

  // ---- recovery (down-spec §3: "the aerial sit-up")
  // The acceptance band is Mythos's, verbatim: the transition must not be
  // instant, and must not exceed one breath. So the body finishes the beat it
  // is in and then reloads its wings -- "waking, not engine restart".
  recover: {
    finishBeat: true,         // ride the current oscillation to its zero crossing
    reopenTime: 1.1,          // s of visible wing reload after the beat ends
    maxTotal: BREATH,         // hard ceiling on beat + reopen (acceptance band)
    minTotal: 0.35,           // floor: anything faster reads as a teleport
  },

  // ---- bounds and ceiling (spec R3)
  bounds: {
    ceiling: 60,              // m; soft -- banks you back, never a wall-slam
    softMargin: 8,            // m of authority band below the ceiling
    radius: 80,               // m from origin; terrain is ~160m square
    groundClearance: 0.15,    // m; below this counts as ground contact
  },

  // ---- watchdog (spec R2, open question Q1)
  // Q1 is explicitly unresolved in the spec ("proposal: 90s ... tie to existing
  // presence heartbeat?"). It is config with the proposal as default, and the
  // open question is reported rather than silently decided.
  watchdogSec: 90,
};

/** Deep-merge a partial config over the defaults, REJECTING anything it does
 *  not consume.
 *
 *  A silent merge is worse than no merge once there is a config editor: the
 *  first cut happily kept `leaf.damping` -- a key renamed to `dampingPerCycle`
 *  and consumed by nothing -- so the editor would have reported an edit applied
 *  while the physics ignored it, and a tuning session would have chased a
 *  number that did nothing. Unknown keys, non-finite values and out-of-range
 *  values all throw here, at the moment the config is built, rather than
 *  becoming a mystery in a clip.
 */
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
    ['bounds.softMargin', out.bounds.softMargin, 0.01, out.bounds.ceiling],
  ];
  for (const [name, v, lo, hi] of R) {
    if (!(v >= lo && v <= hi)) bad.push(`'${name}' = ${v} is outside [${lo}, ${hi}]`);
  }
  if (bad.length) throw new Error(`flight config: ${bad.join('; ')}`);
  // sinkAtBest is derived; recompute unless the caller overrode it explicitly.
  return out;
}

// ---------------------------------------------------------------- polar

/** Sink rate (m/s, positive = descending) at a given airspeed.
 *
 *  Parabolic about best glide: sink is minimised at bestSpeed and rises
 *  quadratically either side. Below stall the number is meaningless -- the
 *  caller is in R1 territory and should be recovering, not consulting a polar
 *  -- so it is clamped rather than extrapolated into fantasy.
 */
export function sinkRate(cfg, airspeed) {
  const p = cfg.polar;
  const v = clamp(airspeed, p.minSpeed, p.maxSpeed);
  const k = p.sinkAtMinSink / (p.minSinkSpeed * p.minSinkSpeed);
  const d = v - p.minSinkSpeed;
  return p.sinkAtMinSink + k * d * d * p.curvature;
}

/** The polar's ACTUAL best-glide point, found by searching the curve rather
 *  than asserted beside it.
 *
 *  Derived, because a published optimum that disagrees with the implemented
 *  curve is how T2's receipt came to claim 360 m for a glide the physics flies
 *  to 388 m. Anything that predicts range must consult this, not a config
 *  literal. Memoised per config object -- the search is ~2400 evaluations and
 *  glideRange() is called per verb, not per frame.
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

/** Airspeed after one frame at a given pitch.
 *
 *  Nose down trades altitude for speed; nose up trades it back. This is the
 *  exchange a glider pilot actually has, and the reason a stall is reachable by
 *  holding the nose up rather than by a hidden rule -- R1 is then a reflex that
 *  catches a thing the pilot did, not a scripted event.
 *
 *  Lives here rather than in flightpilot.js because it is PHYSICS, not input
 *  mapping: a verb-flown climb spends speed on the same curve a hand-flown one
 *  does. (It briefly lived over there, and the integrator called a function it
 *  had never imported -- which the module graph happily loaded and only failed
 *  at the first step. Hence the pilot smoke test.)
 */
export function airspeedAfter(cfg, airspeed, pitch, dt) {
  const p = cfg.polar;
  const g = 9.81;
  const accel = -Math.sin(pitch) * g * 0.55;      // 0.55: drag eats the rest
  const toward = (p.minSinkSpeed - airspeed) * 0.25;  // drag pulls toward min sink
  const v = airspeed + (accel + toward) * dt;
  return clamp(v, p.minSpeed * 0.6, p.maxSpeed);
}

/** How far this altitude can carry you at best glide, in metres.
 *
 *  This is the function that makes spec T2 honest: `glide_to` beyond range
 *  must land SHORT at the polar-predicted point, not rubber-band to the
 *  target. A caller that wants to know before committing asks here.
 */
export function glideRange(cfg, altitude) {
  return Math.max(0, altitude) * bestGlide(cfg).ratio;
}

// ---------------------------------------------------------------- leaf
//
// The falling leaf, as a pure function of elapsed time. Not an accumulator:
// given the same (config, t) it returns the same attitude on every runtime and
// every replay, which is what lets two independent simulations agree without
// exchanging a byte.
//
// Shape: a damped oscillation in BANK, with yaw following bank (the spiral),
// pitch coupled at a fraction, and descent settling to terminalV. The damping
// decays the SWING toward a steady spiral -- a real leaf does not oscillate
// forever, it converges on a lazy circle -- but never to zero, because a body
// that stops moving on the way down reads as a prop.

/** Attitude and velocity of a falling-leaf descent at elapsed time `t`.
 *  @returns {{bank:number, yawRate:number, pitch:number, vy:number, drift:number, beatPhase:number, envelope:number}}
 *    bank/pitch in radians, yawRate rad/s, vy m/s (negative = down),
 *    drift m/s lateral, beatPhase 0..1 through the current oscillation.
 */
export function leafAt(cfg, t, v0 = 0) {
  const L = cfg.leaf;
  const w = (2 * Math.PI) / L.period;

  // DAMPING is authored per CYCLE (Mythos's units) and applied per second, so
  // the number in the config means what he said it means whatever the period
  // is. A fraction f lost per cycle is a rate of -ln(1-f)/period.
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

  // DRIFT is a velocity, but the thing authored is the DISPLACEMENT. For
  // x(t) = A*sin(wt) the velocity is A*w*cos(wt), so the peak speed needed to
  // wander A metres in a period of `period` is A*w -- derived, not typed, so
  // retuning the period does not silently rescale the wander.
  const drift = L.lateralAmplitudeM * w * env * Math.cos(w * t);

  const beatPhase = ((t % L.period) + L.period) % L.period / L.period;
  return { bank, yawRate, pitch, vy, drift, beatPhase, envelope: env };
}

/** Peak-to-peak lateral wander of the leaf's PATH, in metres, over its first
 *  `cycles` cycles -- the quantity Mythos specified (1.2-1.8 m side to side)
 *  and the one an overlay should show next to the attitude, so the two
 *  amplitudes can never be read as each other again. */
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

/** Seconds from `t` until the current oscillation next crosses zero bank.
 *
 *  This is what "finish the current beat" means in down-spec §3 -- the aerial
 *  sit-up waits for the swing to come back through level before the wings
 *  reload, so the recovery reads as waking rather than as a switch being
 *  thrown. Always in [0, period/2).
 */
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
  // Without this, makeConfig({stamina:{pool:42}}) produced a body that started
  // at 100 unless every caller remembered to override it by hand -- a default
  // that silently disagreed with the config it was built beside.
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
    downEventId: null,
    recoveryGeneration: null,
    events: [],                // emitted this step; caller drains
    ...over,
  };
}

// ---------------------------------------------------------------- events
//
// The adapter seam, exactly as Mica specified it. These are the ONLY way the
// body learns it is down or recovered. They are trusted: this layer does not
// and cannot verify them, which is the point -- the local HUD emits them for
// rehearsal, and a separately reviewed Connectome adapter will emit them for
// real, and the body behaves identically either way.

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
  const groundY = env.groundY ?? (() => 0);
  s.t += dt;
  s.phaseT += dt;

  switch (s.phase) {
    case 'LEAF':      stepLeaf(cfg, s, dt, groundY); break;
    case 'RECOVER':   stepRecover(cfg, s, dt, groundY); break;
    case 'GLIDE':     stepGlide(cfg, s, dt, env); break;
    case 'PILOT':     stepPilot(cfg, s, dt, env); break;
    case 'RAGDOLL':   /* the ragdoll owns the body; nothing to integrate */ break;
    case 'GROUND':
    case 'LANDED':    stepGround(cfg, s, dt); break;
    default:          break;
  }
  return s;
}

/** Hand-flown flight. The same physics as GLIDE with a stick on it: the
 *  attitude comes from `env.input` (see shared/flightpilot.js) instead of from
 *  a verb's autopilot, and everything downstream -- polar, stamina, bounds,
 *  ground contact, and the leaf if a cut arrives -- is identical.
 *
 *  That identity is the point. A pilot and an agent fly the same integrator, so
 *  what a human learns on the stick is true of what Mythos will fly, and the
 *  bench is not proving something about a bench. */
function stepPilot(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0);
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

  s.vel.y = -sink + lift + climb;
  s.vel.x = Math.cos(s.yaw) * s.airspeed;
  s.vel.z = Math.sin(s.yaw) * s.airspeed;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;

  bounds(cfg, s, dt);
  groundContact(cfg, s, groundY, /*ragdoll=*/false);
}

/** R3 CEILING/BOUNDS: soft, banking you back, "never a wall-slam" (spec §3).
 *
 *  AUTHORITATIVE FOR EVERY AIRBORNE PHASE. The first cut called this only from
 *  stepPilot, so a GLIDE in lift sailed through the 60 m ceiling to 75.8 m with
 *  no event at all -- the reflex constitution is world-side and applies to
 *  live, plan and reflex alike (§3, §4), and a ceiling only a human can feel is
 *  not a ceiling.
 *
 *  SOFT, also per the spec. The ceiling was a hard position clamp with a
 *  velocity zero, which is exactly the wall-slam R3 forbids; it now bleeds
 *  climb rate to nothing across a margin, so the body noses over instead of
 *  hitting a lid. A LIMP body is not steered -- reflexes may not fly a body
 *  whose wings are out (R2 owns it, and the leaf must be free to land) -- so
 *  altitude is capped for it without any pretence of authority.
 */
function bounds(cfg, s, dt) {
  const b = cfg.bounds;
  const limp = s.wings === 'LIMP';

  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > b.radius && !limp) {
    const inward = Math.atan2(-s.pos.z, -s.pos.x);
    // Authority ramps in over the margin rather than snapping: a bank you can
    // see beginning is a bank, a discontinuity is a wall.
    const over = Math.min(1, (r - b.radius) / Math.max(1e-6, b.softMargin));
    s.yaw += angleTo(s.yaw, inward) * Math.min(1, 1.5 * over * dt);
    if (!s._boundNote) { s.events.push({ t: s.t, kind: 'reflex.r3_bounds', radius: r }); s._boundNote = 1; }
  } else if (r <= b.radius) s._boundNote = 0;

  const soft = b.ceiling - b.softMargin;
  if (s.pos.y > soft && s.vel.y > 0 && !limp) {
    // Bleed the climb out across the margin; at the ceiling it is zero.
    const k = Math.min(1, (s.pos.y - soft) / Math.max(1e-6, b.softMargin));
    s.vel.y *= (1 - k);
    if (!s._ceilNote) { s.events.push({ t: s.t, kind: 'reflex.r3_ceiling', altitude: s.pos.y }); s._ceilNote = 1; }
  } else if (s.pos.y <= soft) s._ceilNote = 0;
  // A hard stop remains only as a backstop for a body that got above the
  // ceiling some other way (a teleport, a bad initial state).
  if (s.pos.y > b.ceiling) { s.pos.y = b.ceiling; if (s.vel.y > 0) s.vel.y = 0; }
}

function angleTo(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function stepLeaf(cfg, s, dt, groundY) {
  const a = leafAt(cfg, s.phaseT, s.leafV0);
  s.bank = a.bank; s.pitch = a.pitch;
  s.yaw += a.yawRate * dt;
  s.vel.y = a.vy;
  // LATERAL means perpendicular to the heading. Forward is (cos yaw, sin yaw)
  // -- as stepGlide uses it -- so sideways is (-sin yaw, cos yaw), and the
  // first cut used the FORWARD vector here: at yaw=0 the leaf slid along +x,
  // the forward axis, while the config called the number lateral and the
  // test integrated an ideal 1-D scalar that could never see the difference.
  // A leaf that wanders forwards is a glide with the wings off.
  s.vel.x = -Math.sin(s.yaw) * a.drift;
  s.vel.z = Math.cos(s.yaw) * a.drift;
  bounds(cfg, s, dt);
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
    // Wings reload; glide resumes. Recovery altitude is logged (down-spec §3).
    s.phase = 'GLIDE'; s.wings = 'OPEN'; s.mode = 'live';
    s.phaseT = 0; s.recoverPlan = null;
    s.airspeed = Math.max(cfg.polar.minSpeed, bestGlide(cfg).speed * 0.8);
    s.events.push({ t: s.t, kind: 'recover.airborne', altitude: s.pos.y,
                    recoveryGeneration: s.recoveryGeneration });
  }

  groundContact(cfg, s, groundY, /*ragdoll=*/true);
}

function stepRecover(cfg, s, dt, groundY) {
  // Ground sit-up. The body is not driven here -- the caller animates a sit-up
  // over `reopenEnds` seconds -- but the phase is held so nothing else claims
  // the body mid-rise, and so onlookers see the honest middle state.
  if (s.phaseT >= (s.recoverPlan?.reopenEnds ?? BREATH)) {
    s.phase = 'GROUND'; s.wings = 'OPEN'; s.mode = 'live';
    s.phaseT = 0; s.recoverPlan = null;
    s.events.push({ t: s.t, kind: 'recover.stood' });
  }
}

function stepGlide(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0);
  const lift = env.lift ? env.lift(s.pos.x, s.pos.y, s.pos.z) : 0;
  const sink = sinkRate(cfg, s.airspeed || bestGlide(cfg).speed);
  s.vel.y = -sink + lift;
  s.vel.x = Math.cos(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  s.vel.z = Math.sin(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  bounds(cfg, s, dt);
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
  // Capture the impact BEFORE zeroing it. The first cut reported `leafV0` --
  // the sink rate when the leaf BEGAN -- which is a different number and, from
  // a glide entered at zero, was literally 0.00 m/s on a body that hit the
  // ground at 2.5. A receipt that reports the wrong quantity is worse than one
  // that reports nothing, because it will be believed.
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

// ---------------------------------------------------------------- consent
//
// `consent.canLandAt(flier, target)` as an INJECTED, FAKEABLE interface --
// Mica's requirement, and the right shape regardless: the production registry
// is explicitly out of scope, and a hard gate that cannot be tested with a
// stub is a hard gate nobody has ever seen fail.

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
