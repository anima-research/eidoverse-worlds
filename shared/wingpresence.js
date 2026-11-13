// wingpresence — the folded-wing posture on the existing presence plane, as a NAMED POSE.
//
// R 10-17 15:09: a pose is one frame (only the bones it names), held by name; folded wings are just the pose
// "wings-folded". The pose packet carries `poses: [names]`, the named poses this body holds (one frame each; each
// renderer resolves a name through its own rig: "wings-folded" through the worn rig's own fold path, never
// rig-specific quaternions on the wire). Presence is lossy but the newest pose is remembered for reconnect/late join,
// exactly like position, clip and held pose. The packet's old boolean `wingsFolded` (before 10-17) is still READ, as
// the same pose; nothing writes it.

export const WINGS_FOLDED = 'wings-folded';
/** A pose name on the wire: the animation library's and the rigs' grammar (shared/grab.js ANIM_RE). */
export const POSE_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
export const MAX_NAMED_POSES = 16;

/** The field every body owner emits. Always present (an empty list holds nothing) so an unfold cannot be mistaken
 * for packet omission. */
export function wingFoldPresence(folded) {
  return { poses: folded === true ? [WINGS_FOLDED] : [] };
}

/** Does this sample say the wings are folded? true / false, or null when it says nothing (an older or partial sample
 * abstains rather than inventing a posture). Reads `poses` and, from a sample written before 10-17, `wingsFolded`. */
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

/** The body owner's half of the same contract. Kept pure enough to exercise outside a browser: striking a posture
 * updates both what the wire reads and what the local rig renders, in one operation. (`wingsFolded` on the state and
 * the avatar is the owner's own internal flag; the wire carries the named pose.) */
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
