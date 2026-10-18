// onceanim — the pose packet's `anim` (R 10-17 16:26; spec/PROTOCOL.md pose.anim): the name of an anim the body plays
// ONCE (a gesture, a pose or a clip by name), riding exactly one packet. A receiver plays it over whatever the body holds
// and returns to that; nothing remembers it (a joiner never replays it: server.ts settledPose drops ONCE_KEYS).
// Pure: no imports, no DOM — the browser, the agent and the server read it alike.

/** The packet's pre-release key, still read for one release (minor 0). The one place it is spelled. */
const OLD_KEY = 'emote';
/** Every key a once anim may ride under: today's, then the pre-release one. */
export const ONCE_KEYS = Object.freeze(['anim', OLD_KEY]);
/** The once anim a received sample carries (its own key, else the pre-release one), or null. */
export function onceAnimOf(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const v = sample.anim ?? sample[OLD_KEY];
  return typeof v === 'string' && v ? v : null;
}
/** The sample without its once anim (under either key): what may be remembered. */
export function withoutOnceAnim(sample) {
  const out = { ...sample };
  for (const k of ONCE_KEYS) delete out[k];
  return out;
}
