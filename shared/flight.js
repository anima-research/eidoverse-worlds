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

/** @typedef {'GROUND'|'LAUNCH'|'GLIDE'|'CLIMB'|'CIRCLE'|'LEAF'|'RECOVER'|'LANDED'|'RAGDOLL'} Phase */
/** @typedef {'OPEN'|'FOLDED'|'LIMP'} Wings */
/** @typedef {'live'|'plan'|'reflex'} Mode */

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
  // A polar is sink rate as a function of airspeed. Two numbers describe the
  // useful part of it: the best glide ratio and the speed it happens at.
  // Everything else is a parabola through them, which is the standard
  // single-parabola approximation and is honest to about +/-5% over the range
  // a glider actually flies.
  polar: {
    bestGlideRatio: 12,       // metres forward per metre down, at bestSpeed
    bestSpeed: 11,            // m/s airspeed at which that ratio holds
    minSpeed: 6,              // stall (spec R1 triggers below this)
    maxSpeed: 30,             // never-exceed; drag rises steeply past best
    sinkAtBest: 11 / 12,      // m/s, derived: bestSpeed / bestGlideRatio
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
  leaf: {
    period: BREATH,           // s, the oscillation
    amplitudeDeg: 35,         // peak bank angle of the oscillation
    damping: 0.12,            // per second, how fast the swing decays toward terminal
    terminalV: 2.5,           // m/s downward, spec says 2-3
    spinUpTime: 0.9,          // s to reach terminalV from whatever v it had
    yawPerBank: 0.55,         // yaw rate (rad/s) per radian of bank -- the spiral
    pitchCoupling: 0.35,      // how much bank leaks into pitch; 0 = pure roll
    lateralDrift: 1.6,        // m/s at peak bank -- how far the leaf wanders
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

/** Deep-merge a partial config over the defaults. Config, not constants -- a
 *  caller overriding `leaf.damping` must not lose `leaf.period`. */
export function makeConfig(over = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
      Object.assign(out[k], v);
    } else out[k] = v;
  }
  // sinkAtBest is derived; recompute unless the caller overrode it explicitly.
  if (!(over.polar && 'sinkAtBest' in over.polar)) {
    out.polar.sinkAtBest = out.polar.bestSpeed / out.polar.bestGlideRatio;
  }
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
  const k = p.sinkAtBest / (p.bestSpeed * p.bestSpeed);   // curvature
  const d = v - p.bestSpeed;
  return p.sinkAtBest + k * d * d * 3;
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
  const toward = (p.bestSpeed - airspeed) * 0.25; // drag pulls toward best glide
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
  return Math.max(0, altitude) * cfg.polar.bestGlideRatio;
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
 *  @returns {{bank:number, yawRate:number, pitch:number, vy:number, drift:number, beatPhase:number}}
 *    bank/pitch in radians, yawRate rad/s, vy m/s (negative = down),
 *    drift m/s lateral, beatPhase 0..1 through the current oscillation.
 */
export function leafAt(cfg, t, v0 = 0) {
  const L = cfg.leaf;
  const w = (2 * Math.PI) / L.period;
  // Envelope decays toward a floor rather than to zero: the leaf converges on
  // a lazy spiral, it does not go rigid.
  const env = 0.35 + 0.65 * Math.exp(-L.damping * t);
  const bank = (L.amplitudeDeg * Math.PI / 180) * env * Math.sin(w * t);
  const yawRate = L.yawPerBank * bank;
  const pitch = L.pitchCoupling * bank;
  // Vertical speed eases from whatever it was into terminal. Exponential, so
  // it is continuous with the glide that preceded it -- a body entering LEAF
  // at 6 m/s of sink does not jump to 2.5.
  const k = 1 - Math.exp(-t / Math.max(1e-3, L.spinUpTime));
  const vy = -(Math.abs(v0) + (L.terminalV - Math.abs(v0)) * k);
  const drift = L.lateralDrift * Math.sin(w * t);
  const beatPhase = ((t % L.period) + L.period) % L.period / L.period;
  return { bank, yawRate, pitch, vy, drift, beatPhase };
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
export function initialState(over = {}) {
  return {
    phase: /** @type {Phase} */ ('GROUND'),
    wings: /** @type {Wings} */ ('OPEN'),
    mode: /** @type {Mode} */ ('live'),   // supplied by the CALLER (spec §4)
    t: 0,                      // seconds since the world's flight epoch
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, bank: 0,
    airspeed: 0,
    stamina: DEFAULT_CONFIG.stamina.pool,
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
export function bodyDown(state, { eventId, state: kind = 'DOWN' } = {}) {
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
export function bodyRecovered(state, { eventId, recoveryGeneration } = {}) {
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
 * @param {object} cfg      from makeConfig()
 * @param {object} state    from initialState() or a previous step
 * @param {number} dt       fixed timestep, seconds
 * @param {object} [env]    { groundY(x,z), lift(x,y,z), consent }
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
  s.airspeed = airspeedAfter(cfg, s.airspeed || cfg.polar.bestSpeed, s.pitch, dt);

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

/** R3 CEILING/BOUNDS: soft, banking you back, "never a wall-slam" (spec §3). */
function bounds(cfg, s, dt) {
  const b = cfg.bounds;
  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > b.radius) {
    // Turn toward the origin rather than stopping: a wall you can feel is a
    // wall, and the spec forbids one.
    const inward = Math.atan2(-s.pos.z, -s.pos.x);
    s.yaw += angleTo(s.yaw, inward) * Math.min(1, 1.5 * dt);
    if (!s._boundNote) { s.events.push({ t: s.t, kind: 'reflex.r3_bounds' }); s._boundNote = 1; }
  } else s._boundNote = 0;
  if (s.pos.y > b.ceiling) {
    s.pos.y = b.ceiling;
    if (s.vel.y > 0) s.vel.y = 0;
    s.events.push({ t: s.t, kind: 'reflex.r3_ceiling', altitude: s.pos.y });
  }
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
  // The drift is lateral to the current heading, which is what makes the
  // descent a spiral rather than a slide.
  s.vel.x = Math.cos(s.yaw) * a.drift;
  s.vel.z = Math.sin(s.yaw) * a.drift;
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
    s.airspeed = Math.max(cfg.polar.minSpeed, cfg.polar.bestSpeed * 0.8);
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
  const sink = sinkRate(cfg, s.airspeed || cfg.polar.bestSpeed);
  s.vel.y = -sink + lift;
  s.vel.x = Math.cos(s.yaw) * (s.airspeed || cfg.polar.bestSpeed);
  s.vel.z = Math.sin(s.yaw) * (s.airspeed || cfg.polar.bestSpeed);
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
  s.pos.y = gy;
  s.vel = { x: 0, y: 0, z: 0 };
  if (ragdoll) {
    s.phase = 'RAGDOLL'; s.wings = 'LIMP'; s.mode = 'reflex';
    s.events.push({ t: s.t, kind: 'ground.ragdoll', impactV: s.leafV0,
                    eventId: s.downEventId });
  } else {
    s.phase = 'LANDED'; s.mode = 'live';
    s.events.push({ t: s.t, kind: 'ground.landed' });
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
