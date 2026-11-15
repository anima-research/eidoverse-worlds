// The server's heartbeat (docs/design/OVERHAUL-CHARTER.md §4): one scheduler for the cadenced systems (the screenshot
// sweep, server.ts, and worldindex.ts's sweep keep their own timers). Each system is
// named, error-isolated (a throw costs it one beat) and measured at GET /tick. Cadences are "at least everyMs apart", not a fixed timestep.

export type TickSystem = {
  name: string;
  everyMs: number;
  fn: (now: number) => void;
};

type Stat = { runs: number; lastMs: number; worstMs: number; errors: number; lastError: string | null };
const systems: (TickSystem & { lastRun: number; stat: Stat })[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let baseMs = 0;

/** Register a cadenced system. Registration order is execution order within a beat: fast fanouts (frames) first. */
export function registerSystem(sys: TickSystem) {
  systems.push({ ...sys, lastRun: 0,
    stat: { runs: 0, lastMs: 0, worstMs: 0, errors: 0, lastError: null } });
}

/** Start the heartbeat. `base` is the finest cadence any system needs; coarser ones ride on it. */
export function startTick(base: number) {
  if (timer) throw new Error("tick already started");
  baseMs = base;
  timer = setInterval(() => {
    const now = Date.now();
    for (const s of systems) {
      if (now - s.lastRun < s.everyMs) continue;
      s.lastRun = now;
      const t0 = performance.now();
      try {
        s.fn(now);
        s.stat.lastError = null;
      } catch (err) {
        s.stat.errors++;
        s.stat.lastError = String(err);
        console.error(`[tick:${s.name}]`, err);
      }
      const ms = performance.now() - t0;
      s.stat.runs++;
      s.stat.lastMs = ms;
      if (ms > s.stat.worstMs) s.stat.worstMs = ms;
      // an overrun eats the next beat's budget: say so every 50th run
      if (ms > s.everyMs && s.stat.runs % 50 === 1) {
        console.warn(`[tick:${s.name}] ran ${ms.toFixed(1)}ms against a ${s.everyMs}ms cadence`);
      }
    }
  }, base);
}

/** The observability surface behind GET /tick. */
export function tickStats() {
  return {
    baseMs,
    systems: systems.map((s) => ({ name: s.name, everyMs: s.everyMs, ...s.stat,
      lastMs: Number(s.stat.lastMs.toFixed(2)), worstMs: Number(s.stat.worstMs.toFixed(2)) })),
  };
}
