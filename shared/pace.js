// pace — send a run of verbs without outrunning the door's rate limit.
//
// The sequencer allows VERB_RATE (12) verbs per 4 s per connection and DROPS
// the rest with "slow down" (server/verbs.ts runVerb). One gesture that is
// many verbs — placing a copy of a blueprint (a spawn, a mount and a few comps
// per part), undoing it, removing many things — would lose its tail. So such a
// run is QUEUED and drained at most `limit` sends per `windowMs`, counted over
// a sliding window of every verb this connection sent (the direct ones too),
// which is stricter than the door's fixed window; the margin (10 in 4.4 s
// against 12 in 4 s) absorbs network jitter bunching arrivals together.
//
// Order is kept: while a run is draining, a single verb sent the ordinary way
// joins the back of the queue instead of jumping ahead of it (an undo issued
// mid-placement then removes what the placement has finished placing).
//
// Pure: the clock, the timer and the send are injected, so a test can drive it
// against a model of the door (tools/blueprint-test.ts) and the browser
// (client/lib/net.js) and the agent (mcpl/tools.ts) share it.

export const PACE = Object.freeze({ LIMIT: 10, WINDOW_MS: 4400 });

/** A pacer around `send(verb, args)`.
 *  - `direct(verb, args)`  send now (counted), or queue behind a draining run
 *  - `run(list)`           queue [{verb, args}, …] and drain within budget
 *  - `pending()`           how many verbs wait
 *  - `eta()`               ms until the queue is expected to drain (0 = empty)
 *  - `set({limit, windowMs})` retune (a bench, or a door that says its rate) */
export function makePacer({ send, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), limit = PACE.LIMIT, windowMs = PACE.WINDOW_MS } = {}) {
  const sent = [];      // times of recent sends, oldest first
  const queue = [];
  let timer = null;
  const prune = (t) => { while (sent.length && t - sent[0] >= windowMs) sent.shift(); };
  const fire = (v) => { sent.push(now()); send(v.verb, v.args); };
  const drain = () => {
    timer = null;
    const t = now();
    prune(t);
    while (queue.length && sent.length < limit) fire(queue.shift());
    if (queue.length) timer = schedule(drain, Math.max(1, sent[0] + windowMs - now() + 5));
  };
  return {
    direct(verb, args) {
      if (queue.length) { queue.push({ verb, args }); return false; }
      fire({ verb, args });
      return true;
    },
    run(list) {
      for (const v of list ?? []) queue.push(v);
      if (!timer) drain();
      return queue.length;
    },
    pending: () => queue.length,
    eta() {
      if (!queue.length) return 0;
      const windows = Math.ceil(queue.length / limit);
      return windows * windowMs;
    },
    set(o = {}) {
      if (Number.isFinite(o.limit) && o.limit >= 1) limit = o.limit;
      if (Number.isFinite(o.windowMs) && o.windowMs >= 0) windowMs = o.windowMs;
    },
  };
}
