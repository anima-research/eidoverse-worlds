// eidoverse-worlds sequencer — the heartbeat (overhaul charter §4, phase 1
// slice 3). ONE scheduler for everything that runs on a cadence, in the
// spirit of the client rebuild's organizing principle (TEL0S_NOTES §3: one
// scheduler, no timeout escapes).
//
// Before this module the server kept four naked setIntervals (stage frames,
// behavior tick, lease sweep, seat-store poll), each with its own guard
// idiom and none observable. Now a cadence is a REGISTERED SYSTEM: named,
// error-isolated (house rule 3 — one system's throw costs that system one
// beat, never its neighbors, never the process), and measured (runs, worst
// ms, last error) at GET /tick.
//
// This is the SEAM, not yet the simulation: systems today are sweeps and
// fanouts, so the base interval keeps setInterval's honest wall-clock drift
// and cadences are "at least everyMs apart", exactly the guarantee the four
// intervals gave. When the sim core proper arrives (fixed timestep,
// determinism policy — charter §6 phase 1, tel0s's redo), it lands as a
// system here with an accumulator loop inside; nothing outside this file
// has to learn anything.

export type TickSystem = {
  name: string;
  everyMs: number;
  fn: (now: number) => void;
};

type Stat = { runs: number; lastMs: number; worstMs: number; errors: number; lastError: string | null };
const systems: (TickSystem & { lastRun: number; stat: Stat })[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let baseMs = 0;

/** Register a cadenced system. Order of registration is order of execution
 *  within a beat — keep fast fanouts (frames) first. */
export function registerSystem(sys: TickSystem) {
  systems.push({ ...sys, lastRun: 0,
    stat: { runs: 0, lastMs: 0, worstMs: 0, errors: 0, lastError: null } });
}

/** Start the heartbeat. `base` is the finest cadence any system needs (the
 *  stage-frame FRAME_MS today); coarser systems ride accumulators on it. */
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
        // a system's throw is ITS failure: recorded, logged, contained
        s.stat.errors++;
        s.stat.lastError = String(err);
        console.error(`[tick:${s.name}]`, err);
      }
      const ms = performance.now() - t0;
      s.stat.runs++;
      s.stat.lastMs = ms;
      if (ms > s.stat.worstMs) s.stat.worstMs = ms;
      // an overrun eats the NEXT beat's budget — say so once in a while
      // (every 50th) rather than silently or noisily
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
