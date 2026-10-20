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

// A body lying limp has its root a hips-height BELOW the floor it lies on: while it lies in a heap the root follows
// the hips that much lower (client/lib/bodyengine.js _followRoot). Where such a body stands up again, rejoining or
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

// A settled body doesn't move: once its doll is done nothing steps its root (client/lib/localbody.js stepRagdoll). A
// drag, a shove that starts it tumbling again or an unpin does move it, and the floor measured before is then the
// one under where it was, not where it is. So the floor is the body's only while its root is where it measured it:
// a move of more than a millimetre drops the floor, while the same numbers copied back keep it.
const FLOOR_MOVE = 0.001;

/** The floor a settled body measured (client/lib/localbody.js stepRagdoll: `{ y, root }`) while its root is still
 *  where it was measured, else undefined until it settles again and measures afresh. Presence carries `floor` only
 *  then (client/lib/net.js): a stale floor would stand a rejoin on the storey the body was moved off. */
export function floorStillUnder(floor, root) {
  if (!floor || typeof floor.y !== 'number' || !Number.isFinite(floor.y) || !Array.isArray(floor.root)) return undefined;
  const [x, y, z] = floor.root;
  return Math.hypot(root.x - x, root.y - y, root.z - z) <= FLOOR_MOVE ? floor.y : undefined;
}

/** Where a body that lay limp stands up with no avatar to measure it (client/lib/localbody.js getUp): on the floor
 *  it measured while it is still where it measured it, else at its root raised by the reach for its size. */
export function standingYWithoutAvatar(floor, root, scale) {
  return floorStillUnder(floor, root) ?? standingYFromLyingRoot(root.y, { scale });
}
