// server/readmeter.ts — reads (and dry runs) are rate-limited per connection, by count and by the authority's time they took,
// over a sliding window; the authority only limits writes, and a spectator looping reads would otherwise hold the one thread
// every world shares. EIDO_METER_SCALE (default 1) multiplies the time limit only, for a slower host such as Windows CI.
import { envNumber } from "./limits.ts";
export const METER_SCALE = envNumber("EIDO_METER_SCALE", 1, (n) => n >= 1);
export const READ = { n: 300, ms: 1500 * METER_SCALE, window: 10_000 };

/** The authority's own time for one request's reply (server/worldlog.ts requestSync sets it; never sent to anyone). */
export const authorityTime = new WeakMap<object, number>();

type Mark = { t: number; ms: number };
/** A read's mark: counted at arrival (t); setting .ms when the authority answers moves t to then, so a read that ran
 *  past the window is charged at completion, never expired before its cost lands. */
class ReadMark implements Mark { t: number; #ms = 0; constructor(t: number, private readonly clock: () => number) { this.t = t; }
  get ms() { return this.#ms; } set ms(v: number) { this.#ms = v; this.t = this.clock(); } }
export function readMeter(limits = READ, clock: () => number = Date.now) {
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
    /** count one read as it arrives (a burst is counted before any of it runs); set .ms on the mark when the authority answers */
    record(who: object, now: number): Mark { const m = new ReadMark(now, clock); recent(who, now).push(m); return m; },
  };
}
