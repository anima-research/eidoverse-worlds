// tools/protocol/wait.ts — how a suite waits for the system to catch up: on the thing itself, never on the clock.
//
// A fixed sleep says "by now it will have happened". On a slow CI runner it hasn't, and the suite fails on a fact that
// would have been true a moment later (RS3, buildcheck-route, AS9, party M2, client GR1 on 10-21/22). So:
//   until(what, probe)     — poll `probe` until it returns something truthy, and return that; past the deadline, throw
//                            naming `what` and the last thing the probe said. The deadline stretches with the gate's
//                            PROTOCOL_TIMEOUT_SCALE, which run.ts passes to every suite.
//   tryUntil(what, probe)  — the same, but resolves `undefined` instead of throwing, for a row that checks the outcome.
//   pause(why, ms)         — the one sanctioned fixed wait, for when the passing of time IS the thing under test (a
//                            refractory window, "nothing arrives within 1 s"). `why` is required, so a reader can tell it
//                            from a sleep standing in for a condition. It is never scaled: stretching it changes the test.
// hygiene-check counts every other fixed wait in the gate's suites against a baseline that may only go down.

export const WAIT_SCALE = (() => { const n = Number(process.env.PROTOCOL_TIMEOUT_SCALE ?? 1); return Number.isFinite(n) && n > 0 ? n : 1; })();

export class WaitTimeout extends Error {
  constructor(public what: string, public ms: number, public last: unknown) {
    super(`never became true within ${ms} ms: ${what}${last === undefined ? "" : ` (last: ${show(last)})`}`);
  }
}

function show(v: unknown): string {
  if (v instanceof Error) return `threw ${v.message}`;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + "…" : s; } catch { return String(v); }
}

const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `probe` is truthy; resolve with its value. A probe that throws counts as "not yet" (its error is kept for
 *  the message). Polls quickly at first, then backs off to `step` ms. */
export async function until<T>(what: string, probe: () => T | Promise<T>, opts: { ms?: number; step?: number } = {}): Promise<NonNullable<T>> {
  const ms = Math.round((opts.ms ?? 10_000) * WAIT_SCALE), step = opts.step ?? 100, end = Date.now() + ms;
  let last: unknown, gap = Math.min(10, step);
  for (;;) {
    try { const v = await probe(); if (v) return v as NonNullable<T>; last = v; } catch (e) { last = e; }
    if (Date.now() >= end) throw new WaitTimeout(what, ms, last);
    await tick(gap); gap = Math.min(step, gap * 2);
  }
}

/** `until`, resolving `undefined` at the deadline instead of throwing. */
export async function tryUntil<T>(what: string, probe: () => T | Promise<T>, opts: { ms?: number; step?: number } = {}): Promise<NonNullable<T> | undefined> {
  try { return await until(what, probe, opts); } catch (e) { if (e instanceof WaitTimeout) return undefined; throw e; }
}

/** A fixed wait where elapsed time is itself what's tested. Not scaled. */
export function pause(why: string, ms: number): Promise<void> {
  if (!why) throw new Error("pause() needs a reason: if you're waiting for something to happen, use until()");
  return tick(ms);
}

/** A browser probe's waiter: `waitFor(expr, ms?)` is true once `evaluate(expr)` is truthy in the page, false at the
 *  deadline (scaled like `until`). One line per probe — `const waitFor = pageWaiter(evalJson)` — instead of its own loop. */
export function pageWaiter(evaluate: (expr: string) => unknown, defaultMs = 8000) {
  return async (expr: string, ms = defaultMs): Promise<boolean> => (await tryUntil(expr, () => evaluate(expr), { ms })) !== undefined;
}
