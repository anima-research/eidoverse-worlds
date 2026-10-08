// Presence (present / away / busy) on the embodied plane, the same way the
// wing fold rides: one small field on the pose packet, no new message type,
// relayed by the server as sent (its fence, server/posecheck.ts, normalises only
// the voice and body fields below) and remembered for late joiners with the
// rest of the settled pose (a tester, 09-05: "broadcast that state so the Who panel
// can show it"). Shared by client and server so both agree on the vocabulary.
export const PRESENCE_STATES = ['present', 'away', 'busy'];

export function presenceWire(state) {
  return PRESENCE_STATES.includes(state) ? { presence: state } : {};
}

export function applyPresenceWire(target, sample) {
  if (!target || !sample || !PRESENCE_STATES.includes(sample.presence)) return false;
  target.presence = sample.presence;
  return true;
}

// Voice state on the same packet (2026-09-30; the hover card, agents' look): `mic` — this body's microphone is
// live (the HUD mic glyph's own reading); `hear` — it is hearing voices (the headphones glyph: receiving AND not hushed).
// Additive and optional like `presence`: a client that predates it sends neither, and a receiver then knows NOTHING
// (undefined) rather than assuming "can't hear you". Booleans only; anything else is dropped.
export function voiceWire(v) {
  const o = {};
  if (typeof v?.mic === 'boolean') o.mic = v.mic;
  if (typeof v?.hear === 'boolean') o.hear = v.hear;
  return o;
}

export function applyVoiceWire(target, sample) {
  if (!target || !sample) return false;
  let did = false;
  if (typeof sample.mic === 'boolean') { target.mic = sample.mic; did = true; }
  if (typeof sample.hear === 'boolean') { target.hear = sample.hear; did = true; }
  return did;
}

// This body's size and nameplate lift (2026-09-30, Profile › Avatar "this body"): `scale` — the wearer's chosen size
// multiplier (Basis/VRChat semantics: the body, its eyes, stride and collider grow together); `plateY` — metres the
// nameplate hangs above the measured crown, at the body's authored size (it grows with the body). Both are sent only
// when they differ from the default, so ABSENCE MEANS DEFAULT (1 and 0): a client that predates this sends neither and
// its body is exactly what it always was; a sender resetting to default simply stops sending. Never trust the wire —
// every receiver clamps (scale 0.5–2, plateY −0.3…+0.8 m) and anything non-finite reads as the default.
export const BODY_SCALE_MIN = 0.5, BODY_SCALE_MAX = 2;
export const PLATE_Y_MIN = -0.3, PLATE_Y_MAX = 0.8;
const clampTo = (v, lo, hi, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
export const clampBodyScale = (v) => clampTo(v, BODY_SCALE_MIN, BODY_SCALE_MAX, 1);
export const clampPlateY = (v) => clampTo(v, PLATE_Y_MIN, PLATE_Y_MAX, 0);

export function bodyWire(b) {
  const o = {};
  const s = Math.round(clampBodyScale(b?.scale) * 100) / 100;      // 1% steps: what the slider offers
  const y = Math.round(clampPlateY(b?.plateY) * 100) / 100;        // 1 cm
  if (s !== 1) o.scale = s;
  if (y !== 0) o.plateY = y;
  return o;
}

/** Writes { scale, plateY } onto target from one pose sample — always both, absence = default. Returns true when
 *  either changed (so a receiver can skip the re-apply). */
export function applyBodyWire(target, sample) {
  if (!target || !sample) return false;
  const s = clampBodyScale(sample.scale), y = clampPlateY(sample.plateY);
  const did = target.scale !== s || target.plateY !== y;
  target.scale = s; target.plateY = y;
  return did;
}

// ---- one time base (spec/PHYSICS.md §5.1; research physics-seeds 10-07, seed 5) ----
// Every presence sample may carry `t`, the moment it was CAPTURED, on the authority's clock (the clock that stamps
// entries' ts and frames' t; a client converts with serverNow), and `seq`, the sender's own count of samples. Both are
// optional and additive: absent, a receiver draws the sample at its frame's t, as it always did. Never trust the wire: a
// capture time is used only when it is sane against the frame that carried it (not after it, not older than STALE_MS).
export const SAMPLE_STALE_MS = 1000;
export function sampleTime(pose, frameT) {
  const t = pose?.t;
  return typeof t === 'number' && Number.isFinite(t) && typeof frameT === 'number' && t <= frameT && t >= frameT - SAMPLE_STALE_MS ? t : frameT;
}

// ---- the state-sync lane's sample (spec/PHYSICS.md §4.3; seed 6) ----
// The shape a live simulation authority streams for a THING it simulates (a held, touched or thrown-and-not-yet-rested
// object; never a body). Reserved: the server checks it and refuses it until live authority exists. Absolute,
// self-contained and latest-wins (no deltas against unacknowledged state), so it can move from the WebSocket to
// unreliable datagrams without changing meaning. Rest is never a sample: it is a reliable settlement, logged.
//   id     the thing                         by     the identity simulating it (u-…)
//   aseq   authority sequence (touch, rest)  oseq   ownership sequence (grab); oseq beats aseq (Fiedler 2018)
//   t      capture time, authority's clock   p      position, world frame, m      q   orientation, unit quaternion
//   v      linear velocity, m/s, world       w      angular velocity, rad/s, world frame              sleep  at rest
export const STATE_SAMPLE_KEYS = ['id', 'by', 'aseq', 'oseq', 't', 'p', 'q', 'v', 'w', 'sleep'];
const finN = (x) => typeof x === 'number' && Number.isFinite(x);
const vecN = (a, n) => Array.isArray(a) && a.length === n && a.every(finN);
const counter = (x) => Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
/** Why `x` isn't a state sample (a sentence), or null when it is one. */
export function stateSampleError(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'a state sample is an object {' + STATE_SAMPLE_KEYS.join(', ') + '}';
  for (const k of Object.keys(x)) if (!STATE_SAMPLE_KEYS.includes(k)) return `a state sample has no '${k}' (it is {${STATE_SAMPLE_KEYS.join(', ')}})`;
  for (const k of STATE_SAMPLE_KEYS) if (x[k] === undefined) return `a state sample needs ${k} (every sample is absolute and self-contained)`;
  if (typeof x.id !== 'string' || !x.id || x.id.length > 64) return 'id is the thing\'s id';
  if (typeof x.by !== 'string' || !/^u-[a-z2-7]{20}$/.test(x.by)) return 'by is the identity simulating it (u- + 20 letters)';
  if (!counter(x.aseq) || !counter(x.oseq)) return 'aseq and oseq are whole numbers ≥ 0 (32-bit, wrapping)';
  if (!finN(x.t)) return 't is the capture time on the authority\'s clock (ms)';
  if (!vecN(x.p, 3) || !vecN(x.v, 3) || !vecN(x.w, 3)) return 'p, v and w are [x, y, z]: m, m/s and rad/s in the world frame';
  if (!vecN(x.q, 4) || Math.abs(Math.hypot(...x.q) - 1) > 1e-3) return 'q is a unit quaternion [x, y, z, w]';
  if (typeof x.sleep !== 'boolean') return 'sleep is true or false';
  return null;
}
