// server/v4/readmeter.ts — reads are rate-limited per connection (security pass 2 H-A).
//
// The door rate-limits what goes INTO the log (writes, per identity). A read writes nothing, so nothing limited it: a
// spectator (no identity, no login) could loop `check {}` and hold the one thread every world shares. Each connection's
// reads (and dry runs, which write nothing either) are metered over a sliding window: how many, and how much of the
// door's time they took. Past either, the read is refused (code rate) before it reaches the door.
// n: what an editor's own panels ask in a burst (each change re-reads the inspector and the history) stays far inside it;
// ms is what protects the thread
export const READ = { n: 300, ms: 1500, window: 10_000 };

/** The door's own time for one request's reply (server/v4/world.ts requestSync sets it; never sent to anyone). */
export const doorTime = new WeakMap<object, number>();

type Mark = { t: number; ms: number };
export function readMeter(limits = READ) {
  const seen = new WeakMap<object, Mark[]>();
  const recent = (who: object, now: number) => { const a = (seen.get(who) ?? []).filter((m) => now - m.t < limits.window); seen.set(who, a); return a; };
  return {
    /** null when this connection may read now, else the refusal to send */
    check(who: object, now: number, { timeOnly = false } = {}) {   // timeOnly: the count was checked as it arrived
      const a = recent(who, now); const ms = a.reduce((s, m) => s + m.ms, 0);
      if (!timeOnly && a.length >= limits.n) return { code: "rate", reason: `this connection has made ${a.length} reads in ${limits.window / 1000} s (at most ${limits.n})`, fix: "slow down: a read answers until something changes (the world's updates arrive on their own)" };
      if (ms >= limits.ms) return { code: "rate", reason: `this connection's ${limits.n === Infinity ? "requests" : "reads"} took ${Math.round(ms)} ms of the server's time in ${limits.window / 1000} s (at most ${limits.ms}; every world shares it)`, fix: "ask about less at once (check {id}, look {limit}), and less often" };
      return null;
    },
    /** count one read as it arrives (a burst is counted before any of it runs); set .ms on the mark when the door answers */
    record(who: object, now: number): Mark { const m = { t: now, ms: 0 }; recent(who, now).push(m); return m; },
  };
}
