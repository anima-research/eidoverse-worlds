// interpdelay — how far behind serverNow() a remote body is drawn (remotes.js updateRemotes). A leaf: no THREE, no DOM,
// so test/client/server-clock-test.ts drives it directly.
//
// A sample's stamp is its sender's capture time, so a fixed delay starves on a slow link (every sample newer than the
// render point: the body freezes, then jumps). The delay follows each body's observed lateness like a jitter buffer:
// rises quickly when samples come later, drains slowly when they come sooner, never under 110 ms (one 15 Hz interval
// and a dropped packet's room) nor over the cap.

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
