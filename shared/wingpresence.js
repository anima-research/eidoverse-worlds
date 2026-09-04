// wingpresence — one semantic body field on the existing presence plane.
//
// The wire carries intent (folded/open), never rig-specific quaternions. Each
// renderer applies that intent through its own authored wing rig. Presence is
// lossy but the newest pose is remembered for reconnect/late join, exactly like
// position, clip and held pose.

/** The field every body owner emits. Always present so an unfold cannot be
 * mistaken for packet omission. */
export function wingFoldPresence(folded) {
  return { wingsFolded: folded === true };
}

/** Apply a received semantic fold to one rendered body. Unknown/legacy samples
 * abstain rather than inventing a posture. */
export function applyWingFoldPresence(avatar, sample) {
  if (!avatar || !sample || typeof sample.wingsFolded !== 'boolean') return false;
  avatar.wingsFolded = sample.wingsFolded;
  return true;
}

/** The body owner's half of the same contract. Kept pure enough to exercise
 * outside a browser: striking a posture updates both what the wire reads and
 * what the local rig renders, in one operation. */
export function applyOwnedWingFold(state, avatar, folded) {
  const value = folded === true;
  if (state) state.wingsFolded = value;
  if (avatar) avatar.wingsFolded = value;
  return value;
}
