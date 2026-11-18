// serverclock — the authority's clock as this client estimates it: the one place a client reads "now" for anything the
// authority stamped (motion t0, sound t0, a seat's pose time, a flight's tick). spec/PHYSICS.md §5.1.
//
// Two estimates, best first:
//   a round trip   clock {t0} → {t0, t}: offset = t − (t0 + t1) / 2; the smallest round trip of the last few wins
//                  (NTP's minimum filter). noteRoundTrip.
//   a message's t  one-way, so late by its delay; kept by shared/clockoffset.js's rule and used only until a round
//                  trip lands. noteServerTime.
import { foldOffset } from '../../shared/clockoffset.js';
let oneWay = null;            // from one-way samples: shared/clockoffset.js foldOffset's { offset, at }
let rtt = [];                 // [{rtt, offset}] most recent round trips
const RTT_KEEP = 8;
const STEP_SLACK_MS = 50;     // drift between asks a sample may show and still be the same clock (0.6 ms/s over 80 s)
export const localNow = () => performance.timeOrigin + performance.now();
/** One one-way sample. `at` is the performance.now() when `t`'s message event ran, for a message that waited to be
 *  handled (the early socket's drain, net.js connect()); otherwise now. */
export function noteServerTime(t, at = performance.now()) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return;
  oneWay = foldOffset(oneWay, t - performance.timeOrigin - at, at);
  noteServerFloor(t);
}
/** One round trip: t0 when the ask left (localNow), t the authority's clock in the answer, t1 when it came back. */
export function noteRoundTrip(t0, t, t1) {
  if (![t0, t, t1].every((x) => typeof x === 'number' && Number.isFinite(x)) || t1 < t0) return;
  const s = { rtt: t1 - t0, offset: t - (t0 + t1) / 2 };
  // Two samples of one clock agree within half their round trips summed; one that doesn't means the clock stepped
  // (a resync, a laptop waking): retire the older samples, or the minimum filter keeps the stale offset for RTT_KEEP asks.
  rtt = rtt.filter((x) => Math.abs(x.offset - s.offset) <= (x.rtt + s.rtt) / 2 + STEP_SLACK_MS);
  rtt.push(s);
  if (rtt.length > RTT_KEEP) rtt.shift();
}
const bestOffset = () => (rtt.length ? rtt.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset : oneWay?.offset ?? 0);
// The offset the screen uses slews toward the best estimate (5% of elapsed time: a 100 ms correction takes 2 s) instead
// of stepping, which moved every flight by the delta in one frame. A correction over SLEW_SNAP_MS is a resync, taken at once.
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
/** A time `ms` from now on the authority's clock, in whole milliseconds: what a written time (a timed grant's until) must
 *  be, since the authority refuses a fraction (Number.isSafeInteger) and serverNow() carries performance.now()'s. */
export const serverUntil = (ms) => Math.round(serverNow() + ms);
// A floor: anything the authority stamped was true on its clock no later than now, so the offset is at least
// t − localNow(). A floor above the estimate by more than its slack means the clock stepped: ask again at once
// (net.js hands askClock in via onClockDoubt), at most once a second.
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
