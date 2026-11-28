// onceanim — the pose packet's `anim` (spec/PROTOCOL.md pose.anim): an anim the body plays ONCE, riding exactly one
// packet. Nothing remembers it: server/server.ts settledPose drops ONCE_KEYS, so a joiner never replays it.

/** The key a once anim rides under. */
export const ONCE_KEYS = Object.freeze(['anim']);
/** The once anim a received sample carries, or null. */
export function onceAnimOf(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const v = sample.anim;
  return typeof v === 'string' && v ? v : null;
}
/** The sample without its once anim: what may be remembered. */
export function withoutOnceAnim(sample) {
  const out = { ...sample };
  for (const k of ONCE_KEYS) delete out[k];
  return out;
}
