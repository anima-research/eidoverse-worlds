// redial — when a page or an agent dials a world again after its socket closed: exponential backoff with full jitter
// (review r4 F5: every page waiting on a full world redialled every 5 s, in step, because the delay was reset when the
// socket OPENED, before the join was answered). One rule for the browser (client/lib/net.js) and the agent
// (mcpl/agent.ts), so a server sees the same schedule from both.
//
// The n-th redial (n from 0) waits a random time in [floor, window_n], window_n = min(ceiling, max(first, floor) × 2^n):
// `floor` is the least the caller will wait (a full world: REDIAL.full, room takes a while to free), the jitter spreads
// pages that loaded together. reset() only on a JOIN the server accepted: a socket that opens and is refused again keeps
// backing off.
export const REDIAL = Object.freeze({ first: 1200, ceiling: 60000, full: 5000 });

export function redialer(R = REDIAL) {
  let n = 0;
  return {
    /** The next wait, ms. `floor`: the least it may be; `rand`: [0, 1) (Math.random). */
    next(floor = 0, rand = Math.random) {
      const lo = Math.min(R.ceiling, Math.max(0, floor)), hi = Math.min(R.ceiling, Math.max(R.first, lo) * 2 ** Math.min(n, 30));
      n++;
      return Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, rand())));
    },
    /** A join was accepted: the next drop starts over. */
    reset() { n = 0; },
    get tries() { return n; },
  };
}
