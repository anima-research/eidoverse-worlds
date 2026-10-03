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
