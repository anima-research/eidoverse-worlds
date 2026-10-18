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
const STEP_SLACK_MS = 50;     // drift between asks a sample may show and still be the same clock (0.6 ms/s over 80 s)
export const localNow = () => performance.timeOrigin + performance.now();
export function noteServerTime(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return;
  const sample = t - localNow();
  clockOffset = clockOffset === null ? sample : clockOffset * 0.92 + sample * 0.08;
  noteServerFloor(t);
}
/** One round trip: t0 when the ask left (localNow), t the authority's clock in the answer, t1 when it came back. */
export function noteRoundTrip(t0, t, t1) {
  if (![t0, t, t1].every((x) => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return;
  const s = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 };
  // Two honest samples of one clock agree within half their round trips summed (queuing can only misplace a sample by
  // its own rtt/2). One that doesn't was taken on a clock that has since STEPPED (a wall-clock resync, a laptop waking:
  // the page's monotonic clock and the authority's wall clock part by the jump): the older ones are retired, or the
  // minimum filter keeps the stale offset for up to RTT_KEEP asks and every flight is drawn behind the sim (10-18).
  rtt = rtt.filter((x) => Math.abs(x.offset - s.offset) <= (x.rtt + s.rtt) / 2 + STEP_SLACK_MS);
  rtt.push(s);
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
// A floor: anything the authority stamped (a log entry's ts, a frame's t) was true on its clock no later than now, so the
// offset is at least t − localNow(). A floor above the estimate by more than its slack means the clock stepped since the
// last round trip: ask again at once (net.js hands askClock in) instead of drawing what the replica already folded seconds
// behind until the next CLOCK_MS ask (10-18: the thrown crate waited in the hand). One ask a second at most.
let doubt = null, doubtAt = -Infinity;
const DOUBT_EVERY_MS = 1000;
export const onClockDoubt = (fn) => { doubt = fn; };
export function noteServerFloor(t) {
  if (typeof t !== 'number' || !Number.isFinite(t) || !rtt.length || !doubt) return;
  const now = localNow(); if (t - now <= bestOffset() + clockRtt() / 2 + STEP_SLACK_MS || now - doubtAt < DOUBT_EVERY_MS) return;
  doubtAt = now; doubt();
}
/** Probe/test surface: the raw best estimate and what is shown. */
export const clockDebug = () => ({ best: bestOffset(), shown: shown?.v ?? null });
/** The smallest recent round trip (ms), or null before the first: how sure the estimate is. */
export const clockRtt = () => (rtt.length ? Math.min(...rtt.map((x) => x.rtt)) : null);
