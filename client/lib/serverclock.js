// serverclock — the server's clock, as this client estimates it: the ONE place a client reads "now" for anything the
// authority stamped (motion t0, sound t0, a seat's pose time, a flight's tick). The server's clock is the AUTHORITY's
// (spec/PHYSICS.md §5.1): the same now() that stamps entries' ts, never raw wall time, so a world whose log runs ahead of
// wall time is drawn at the right tick.
//
// Two estimates, best first:
//   a round trip   clock {t0} → {t0, t}: offset = t − (t0 + t1) / 2, the sample with the smallest round trip of the last
//                  few wins (NTP's minimum filter: queuing only ever adds delay). noteRoundTrip.
//   a frame's t    one-way, so late by the delay plus up to a frame's batching; used only until a round trip lands.
// Its own module (it was remotes.js's) so a small realizer (sounds.js) can read it without pulling the body code in.
let clockOffset = null;       // from frames (one-way)
let rtt = [];                 // [{rtt, offset}] most recent round trips
const RTT_KEEP = 8;
export const localNow = () => performance.timeOrigin + performance.now();
export function noteServerTime(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return;
  const sample = t - localNow();
  clockOffset = clockOffset === null ? sample : clockOffset * 0.92 + sample * 0.08;
}
/** One round trip: t0 when the ask left (localNow), t the authority's clock in the answer, t1 when it came back. */
export function noteRoundTrip(t0, t, t1) {
  if (![t0, t, t1].every((x) => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return;
  rtt.push({ rtt: t1 - t0, offset: t - (t0 + t1) / 2 });
  if (rtt.length > RTT_KEEP) rtt.shift();
}
const bestOffset = () => (rtt.length ? rtt.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset : clockOffset ?? 0);
// The offset the screen uses slews toward the best estimate (5% of elapsed time, so a 100 ms correction takes 2 s) instead
// of stepping to each new minimum-RTT sample: a step moved every flight by the delta in one frame (STRIKES PH-S2 'display
// clock jumps', R's 'steppy'). A correction over SLEW_SNAP_MS is a real resync and is taken at once.
const SLEW_RATE = 0.05, SLEW_SNAP_MS = 500;
let shown = null;   // { v: offset shown, at: localNow of the last read }
function shownOffset() {
  const best = bestOffset(), now = localNow();
  if (shown === null || Math.abs(best - shown.v) > SLEW_SNAP_MS) { shown = { v: best, at: now }; return best; }
  const step = Math.max(0, now - shown.at) * SLEW_RATE; shown.at = now;
  const d = best - shown.v; shown.v += Math.abs(d) <= step ? d : Math.sign(d) * step;
  return shown.v;
}
export const serverNow = () => localNow() + shownOffset();
/** Probe/test surface: the raw best estimate and what is shown. */
export const clockDebug = () => ({ best: bestOffset(), shown: shown?.v ?? null });
/** The smallest recent round trip (ms), or null before the first: how sure the estimate is. */
export const clockRtt = () => (rtt.length ? Math.min(...rtt.map((x) => x.rtt)) : null);
