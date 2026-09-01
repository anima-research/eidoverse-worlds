// flightpilot — turn a human's held keys into flight inputs, so the bench can
// be FLOWN rather than only watched.
//
// Janus asked for this: "if it would ever be helpful for me to preview the
// flight mechanics in eidoverse, i'd like to help do that, though you'd have to
// give me an option to do flying as a human player through the UI."
//
// It is also the cheapest possible acceptance instrument. A clip proves the
// leaf falls the way the spec says; a stick proves the SKY is a place, which is
// the thing no test can assert. Mythos's §0 stance -- albatross, not
// hummingbird, glide-biased, a body that is doing something honest between
// verbs -- is a claim about how flying FEELS, and feel is measured by flying.
//
// The seam is deliberate and narrow: this converts intent into the same input
// record a verb would produce, and the integrator cannot tell which one it got.
// A pilot and an agent fly identical physics. If they did not, the bench would
// be proving something about a bench.
//
// PURE, per shared/README.md: takes a set of held key codes and a dt, returns
// an input record. No DOM, no listeners, no clock -- the caller owns all three.

/** Default bindings. Deliberately overlapping the walk controls (W/A/S/D +
 *  Space) so flying reads as a MODE of the same body rather than a second set
 *  of fingers, and Shift/Ctrl for the axis walking does not have. */
export const DEFAULT_BINDS = {
  pitchDown: ['KeyW', 'ArrowUp'],       // nose down: trade altitude for speed
  pitchUp:   ['KeyS', 'ArrowDown'],     // nose up: trade speed for altitude
  bankLeft:  ['KeyA', 'ArrowLeft'],
  bankRight: ['KeyD', 'ArrowRight'],
  flap:      ['Space'],                 // expensive; see spec §5
  spoil:     ['ShiftLeft', 'ShiftRight'],   // bleed altitude without gaining speed
  // Rehearsal only. These EMIT the trusted events the Connectome adapter will
  // one day emit for real -- they do not simulate a cut, they push the same
  // button. See down-spec §4: the body cannot cry wolf, so there is no verb
  // here, only the seam.
  rehearseDown:    ['KeyX'],
  rehearseRecover: ['KeyR'],
};

/** Control authority, per second, at the stick's full deflection. Config, like
 *  everything else -- an albatross is not a fighter and these numbers are how
 *  that is felt rather than said. */
// Janus, flying it: "the avatar moves on a trajectory i can't really control".
// The paper numbers looked reasonable and the FEEL did not, which is the whole
// reason a stick exists next to the plots.
//
// The fault was levelReturn 0.7 against bankRate 1.2: holding a turn gave a NET
// 0.5 rad/s, so the wings fought the hand the entire time and 60 degrees took
// two seconds to reach and would not stay. A glider is stable, but stability
// that overpowers the pilot is rails.
//
// levelReturn now applies only when the stick is CENTRED -- hands off she rolls
// level, hands on she goes where she is put -- and the rates are roughly
// doubled. An albatross is not a fighter, but it is not a tram either.
export const DEFAULT_AUTHORITY = {
  bankRate: 2.6,        // rad/s toward the commanded bank
  maxBank: 1.15,        // ~66deg
  pitchRate: 1.5,       // rad/s
  maxPitch: 0.7,        // ~40deg
  turnPerBank: 1.5,     // rad/s of yaw per radian of bank -- a banked wing turns
  spoilSink: 2.5,       // extra m/s of sink while spoiling
  levelReturn: 1.1,     // rad/s back to level -- ONLY with the stick centred
};

const held = (keys, list) => list.some((k) => keys.has(k));

/**
 * One frame of piloting.
 *
 * @param {Set<string>} keys      held key codes
 * @param {{bank?:number, pitch?:number}} state   flight state (read-only here)
 * @param {number} dt             seconds
 * @param {{binds?:object, authority?:object}} [opts]
 * @returns {{bank:number, pitch:number, yawRate:number, flap:boolean,
 *            spoil:boolean, edges:string[]}}
 *   `edges` names one-shot intents the caller must debounce (rehearsal
 *   events), because a held key is not a repeated event.
 */
export function pilotInput(keys, state, dt, opts = {}) {
  const B = { ...DEFAULT_BINDS, ...(opts.binds || {}) };
  const A = { ...DEFAULT_AUTHORITY, ...(opts.authority || {}) };

  let bank = state.bank ?? 0;
  let pitch = state.pitch ?? 0;

  const l = held(keys, B.bankLeft), r = held(keys, B.bankRight);
  if (l && !r) bank -= A.bankRate * dt;
  else if (r && !l) bank += A.bankRate * dt;
  else {
    // Hands OFF the wings roll level. Hands ON they do not -- an autoleveller
    // that runs while the pilot is holding a turn is not stability, it is a
    // second pilot with an opinion.
    const back = Math.min(Math.abs(bank), A.levelReturn * dt);
    bank -= Math.sign(bank) * back;
  }
  bank = clamp(bank, -A.maxBank, A.maxBank);

  const d = held(keys, B.pitchDown), u = held(keys, B.pitchUp);
  if (d && !u) pitch -= A.pitchRate * dt;
  else if (u && !d) pitch += A.pitchRate * dt;
  else {
    const back = Math.min(Math.abs(pitch), A.levelReturn * dt);
    pitch -= Math.sign(pitch) * back;
  }
  pitch = clamp(pitch, -A.maxPitch, A.maxPitch);

  // A banked wing turns. This is the whole of "flying" as far as heading is
  // concerned -- there is no rudder, because an albatross does not have one
  // worth modelling and a spec that says "glide-biased" should not grow a yaw
  // stick by accident.
  const yawRate = A.turnPerBank * bank;

  const edges = [];
  if (held(keys, B.rehearseDown)) edges.push('down');
  if (held(keys, B.rehearseRecover)) edges.push('recover');

  return {
    bank, pitch, yawRate,
    flap: held(keys, B.flap),
    spoil: held(keys, B.spoil),
    edges,
  };
}

// airspeedAfter lives in flight.js, with the rest of the physics: a verb-flown
// climb must spend speed on exactly the same curve a hand-flown one does, and
// two copies of that curve is two curves. Re-exported here so a caller wiring
// up a stick has one import.
export { airspeedAfter } from './flight.js';

/** Human-readable key hint for a HUD. */
export function pilotHelp(binds = DEFAULT_BINDS) {
  return [
    'W/S  nose down / up (trade altitude for speed)',
    'A/D  bank left / right (a banked wing turns)',
    'Shift  spoil -- bleed altitude without gaining speed',
    'Space  flap (expensive: -2/s stamina, you are a glider)',
    'X  rehearse DOWN   R  rehearse RECOVER',
    'C  re-attach the chase camera (drag to look around)',
  ].join('\n');
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
