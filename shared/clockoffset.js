// The server-to-local clock offset, kept from samples: the one rule for a browser, a lite page and an agent.
// A sample (a message's server `t` less the local time it was handled) undershoots by the message's delay, so the
// estimate is the largest sample, allowed to leak down slowly to follow drift. Rationale and costs:
// docs/research/clock-offset.md.
export const LEAK_MS_PER_S = 2, LEAK_MAX_MS = 100;

/** Fold one sample into the estimate. `prev` is the previous result, or null
 *  before the first sample; `sample` is the message's t less the local time
 *  it was handled; `at` is that local time, in ms on a monotonic clock.
 *  Returns the new estimate, { offset, at }. */
export function foldOffset(prev, sample, at) {
  // a non-finite sample or time (a t of 1e999 parses as Infinity) would
  // stick in the max for the page's life: it isn't a sample
  if (!Number.isFinite(sample) || !Number.isFinite(at)) return prev;
  if (!prev) return { offset: sample, at };
  const leak = Math.min(LEAK_MAX_MS, LEAK_MS_PER_S * Math.max(0, at - prev.at) / 1000);
  return {
    offset: Math.max(prev.offset - leak, sample),
    at: Math.max(prev.at, at),
  };
}
