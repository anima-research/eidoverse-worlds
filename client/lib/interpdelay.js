// interpdelay — how far behind serverNow() a remote body is drawn (remotes.js updateRemotes). A leaf: no THREE, no DOM,
// so tools/server-clock-test.ts drives it directly.
//
// A fixed 110 ms starved the buffer on a slow link (house review of #260, client/lib I46): a sample's stamp is its
// sender's capture time (or the frame's server stamp), so on a link where samples arrive 300 ms after it every sample
// was newer than the render point and the body froze at its newest pose, then jumped. The delay follows each body's
// observed lateness the way a jitter buffer does: it rises quickly when samples come later, drains slowly when they
// come sooner, and never goes under the old 110 ms (one 15 Hz interval and a dropped packet's room) nor over the cap.

/** the floor: one frame of slack at 15 Hz is 66 ms; 110 gives room for one dropped packet without a visible stall */
export const INTERP_MS = 110;
/** the most a body is drawn behind: past this, lag reads worse than a hitch */
export const INTERP_MAX_MS = 600;
const SEND_MS = 66;                   // one send interval at 15 Hz: the room past the lateness itself
const RISE = 0.25, FALL = 0.02;       // per sample: ~1/4 s to catch a slower link at 15 Hz, several seconds to trust a faster one

/** One sample's lateness (ms between its stamp and its arrival, on serverNow()) folded into a body's estimate (null: none yet). */
export function noteLateness(est, lateMs) {
  if (!Number.isFinite(lateMs)) return est;
  const l = Math.min(Math.max(0, lateMs), INTERP_MAX_MS);
  if (est == null) return l;
  return est + (l - est) * (l > est ? RISE : FALL);
}
/** The delay to draw a body at, from its estimate. */
export const interpDelay = (est) => (est == null ? INTERP_MS : Math.min(INTERP_MAX_MS, Math.max(INTERP_MS, est + SEND_MS)));
