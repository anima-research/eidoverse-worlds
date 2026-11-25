// presencewire — the small fields on the pose packet beyond the pose itself: presence (present / away / busy), voice
// state, body size, sample time, and the reserved state-sync sample (refused for now: below). The rest is relayed as sent (server/posecheck.ts
// normalises the voice and body fields) and remembered for late joiners with the settled pose, except the voice state
// and the sample's t/seq (server.ts settledPose drops mic/hear/t/seq). Shared by client and server.
export const PRESENCE_STATES = ['present', 'away', 'busy'];

export function presenceWire(state) {
  return PRESENCE_STATES.includes(state) ? { presence: state } : {};
}

export function applyPresenceWire(target, sample) {
  if (!target || !sample || !PRESENCE_STATES.includes(sample.presence)) return false;
  target.presence = sample.presence;
  return true;
}

// Voice state: `mic` (this body's microphone is live), `hear` (it is receiving voices and not hushed). Optional
// booleans: absent means UNKNOWN, never "can't hear you".
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

// Body size and nameplate lift: `scale` (the wearer's size multiplier), `plateY` (metres the nameplate hangs above the
// crown). Sent only when not the default, so ABSENCE MEANS DEFAULT (1 and 0); every receiver clamps.
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

// ---- one time base (spec/PHYSICS.md §5.1) ----
// A presence sample may carry `t`, its CAPTURE time on the authority's clock, and `seq`, the sender's sample count.
// Absent, a receiver draws the sample at its frame's t. A capture time counts only when sane against the carrying frame
// (not after it, not older than SAMPLE_STALE_MS).
export const SAMPLE_STALE_MS = 1000;
export function sampleTime(pose, frameT) {
  const t = pose?.t;
  return typeof t === 'number' && Number.isFinite(t) && typeof frameT === 'number' && t <= frameT && t >= frameT - SAMPLE_STALE_MS ? t : frameT;
}

// ---- the state-sync lane's sample (spec/PHYSICS.md §4.3) ----
// What a live simulation authority streams for a THING it simulates (never a body). Reserved: the server refuses it
// until live authority exists. Absolute and latest-wins (no deltas). Rest is never a sample: it is a logged settlement.
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
  if (typeof x.by !== 'string' || !/^u-[a-z2-7]{20}(?:[a-z2-7]{4})?$/.test(x.by)) return 'by is the identity simulating it (u- + 20 or 24 letters)';
  if (!counter(x.aseq) || !counter(x.oseq)) return 'aseq and oseq are whole numbers ≥ 0 (32-bit, wrapping)';
  if (!finN(x.t)) return 't is the capture time on the authority\'s clock (ms)';
  if (!vecN(x.p, 3) || !vecN(x.v, 3) || !vecN(x.w, 3)) return 'p, v and w are [x, y, z]: m, m/s and rad/s in the world frame';
  if (!vecN(x.q, 4) || Math.abs(Math.hypot(...x.q) - 1) > 1e-3) return 'q is a unit quaternion [x, y, z, w]';
  if (typeof x.sleep !== 'boolean') return 'sleep is true or false';
  return null;
}

// A body lying limp has its root a hips-height BELOW the floor it lies on: while it lies in a heap the root follows
// the hips that much lower (client/lib/ragdoll/bodyengine.js _followRoot). Where such a body stands up again, rejoining or
// remembered by the server (server/server.ts settledPose): on the floor it measured under its hips (presence
// `floor`, client/lib/getup.js), or, with none, at its root raised by how far a root can lie below its floor for a
// body of its size (presence `scale`) — at or just above that floor, to settle down onto. Rigs lie from about
// 0.55 m to 1.1 m below at scale 1, so the reach takes the deepest. The reach has one limit: unless the body is pinned or
// floating, the root never rises above where its tumble began (_followRoot keeps the lower of the two), so a body knocked UP onto a higher floor
// lies further below it, and without a measured floor it wakes below that floor. The measured floor reads the hips
// and has no such limit.
export const ROOT_BELOW_FLOOR = 1.1;
export function standingYFromLyingRoot(rootY, { floor, scale } = {}) {
  if (typeof floor === 'number' && Number.isFinite(floor)) return floor;
  return rootY + ROOT_BELOW_FLOOR * (typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1);
}

// A settled body doesn't move: once its doll is done nothing steps its root (client/lib/player/localbody.js stepRagdoll). A
// drag, a shove that starts it tumbling again or an unpin does move it, and the floor measured before is then the
// one under where it was, not where it is. So the floor is the body's only while its root is where it measured it:
// a move of more than a millimetre drops the floor, while the same numbers copied back keep it.
const FLOOR_MOVE = 0.001;

/** The floor a settled body measured (client/lib/player/localbody.js stepRagdoll: `{ y, root }`) while its root is still
 *  where it was measured, else undefined until it settles again and measures afresh. Presence carries `floor` only
 *  then (client/lib/net.js): a stale floor would stand a rejoin on the storey the body was moved off. */
export function floorStillUnder(floor, root) {
  if (!floor || typeof floor.y !== 'number' || !Number.isFinite(floor.y) || !Array.isArray(floor.root)) return undefined;
  const [x, y, z] = floor.root;
  return Math.hypot(root.x - x, root.y - y, root.z - z) <= FLOOR_MOVE ? floor.y : undefined;
}

/** Where a body that lay limp stands up with no avatar to measure it (client/lib/player/localbody.js getUp): on the floor
 *  it measured while it is still where it measured it, else at its root raised by the reach for its size. */
export function standingYWithoutAvatar(floor, root, scale) {
  return floorStillUnder(floor, root) ?? standingYFromLyingRoot(root.y, { scale });
}
