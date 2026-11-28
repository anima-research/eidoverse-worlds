// wingpresence — folded wings as a NAMED POSE on the presence packet: `poses: [names]`, each resolved by the receiving
// rig (never rig-specific quaternions on the wire). The old boolean `wingsFolded` is still read, never written.

export const WINGS_FOLDED = 'wings-folded';
/** A pose name on the wire: the animation library's and the rigs' grammar (shared/grab.js ANIM_RE). */
export const POSE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const MAX_NAMED_POSES = 16;

/** The field every body owner emits; always present so an unfold can't be mistaken for omission. */
export function wingFoldPresence(folded) {
  return { poses: folded === true ? [WINGS_FOLDED] : [] };
}

/** Does this sample say the wings are folded? true / false, or null when it says nothing (an older or partial sample
 * abstains rather than inventing a posture). Reads `poses` and, from an older sample, `wingsFolded`. */
export function foldedIn(sample) {
  if (!sample || typeof sample !== 'object') return null;
  if (Array.isArray(sample.poses)) return sample.poses.includes(WINGS_FOLDED);
  return typeof sample.wingsFolded === 'boolean' ? sample.wingsFolded : null;
}

/** Apply a received fold to one rendered body. Unknown samples abstain. */
export function applyWingFoldPresence(avatar, sample) {
  const f = foldedIn(sample);
  if (!avatar || f === null) return false;
  avatar.wingsFolded = f;
  return true;
}

/** The owner's half: one call sets the local flag the wire reads from and the one the rig renders. */
export function applyOwnedWingFold(state, avatar, folded) {
  const value = folded === true;
  if (state) state.wingsFolded = value;
  if (avatar) avatar.wingsFolded = value;
  return value;
}

/** A received `poses` list, cleaned (the server's fence and every receiver): names only, at most MAX_NAMED_POSES,
 * each once; anything else is no list (the field is dropped, never the whole packet). */
export function cleanPoses(v) {
  if (!Array.isArray(v) || v.length > MAX_NAMED_POSES || !v.every((x) => typeof x === 'string' && POSE_NAME_RE.test(x))) return undefined;
  return [...new Set(v)];
}
