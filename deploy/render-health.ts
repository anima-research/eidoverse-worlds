// render-health — the verdict render-watchdog.ts passes on a renderer page, apart from the
// devtools plumbing that asks the questions, so it can be tested without a browser
// (tools/render-health-test.ts).
//
// The verdict is the watchdog's whole job, and it has been wrong before. It scraped "NNfps" from
// #hud, and when the client moved fps into the debug panel it read 0 forever: every healthy
// renderer was killed on schedule, for a week, before anyone noticed (docs/INCIDENTS.md,
// 2026-10-24). Each probe below asks the page something that depends on nothing the client
// displays.

export const TIMEOUT = Symbol("timeout");
/** Evaluate an expression in the page (awaiting a promise), or TIMEOUT after `ms`. */
export type Evaluate = (expr: string, ms?: number) => Promise<unknown>;
export type Health = { alive: boolean; healthy: boolean; reason: string; fps?: number };

export const PROBES = {
  /** a trivial eval: an answer at all means the main thread is not hung */
  alive: "1+1",
  /** One second of requestAnimationFrame, counted here rather than read off the page. */
  frames: "new Promise(r=>{let n=0;const t=performance.now();const f=()=>{n++;performance.now()-t<1000?requestAnimationFrame(f):r(n)};requestAnimationFrame(f)})",
  /** joined a world over the full client's net. The lite client has no EW, so it never passes. */
  joined: "!!(window.EW?.net?.joined)",
  /** What /snap does: captureFrame() renders and reads the canvas back as a PNG, and throws on an
   *  empty readback. */
  capture: "import('/lib/capture.js').then(m => m.captureFrame().length).catch(e => 'ERR ' + (e?.message ?? e))",
} as const;

/** Judge a renderer page by asking it four things, in order. Each one gates the next. */
export async function judge(evaluate: Evaluate): Promise<Health> {
  if ((await evaluate(PROBES.alive)) === TIMEOUT) return { alive: true, healthy: false, reason: "main thread hung" };
  const counted = await evaluate(PROBES.frames, 5000);
  const fps = counted === TIMEOUT ? 0 : Number(counted) || 0;
  // Joined comes BEFORE capture. A lite page can still import capture.js and return a frame's
  // worth of bytes (seen on the live roamers, 2026-10-24), so a capture alone does not show a
  // working renderer.
  const joined = (await evaluate(PROBES.joined)) === true;
  if (!joined) return { alive: true, healthy: false, reason: "not joined", fps };
  if (fps <= 0) return { alive: true, healthy: false, reason: "no frames", fps };
  // A pumping frame loop is not a working renderer either. frame.js catches each section's
  // errors and keeps scheduling, so a client whose world pass throws every frame still counts
  // 60/s. The thing /snap needs is the thing /snap does.
  const cap = await evaluate(PROBES.capture, 10000);
  if (cap === TIMEOUT) return { alive: true, healthy: false, reason: "capture timed out", fps };
  if (typeof cap !== "number" || !(cap > 0)) return { alive: true, healthy: false, reason: `capture failed: ${String(cap).slice(0, 120)}`, fps };
  return { alive: true, healthy: true, reason: `fps=${fps} snap=${(cap / 1024).toFixed(0)}KB`, fps };
}

/** One check's effect on the strike count: any unhealthy verdict is a strike, `limit` in a row
 *  restarts, and one healthy check clears them. */
export function tally(strikes: number, h: Health, limit: number): { strikes: number; restart: boolean } {
  if (h.healthy) return { strikes: 0, restart: false };
  const next = strikes + 1;
  return { strikes: next, restart: next >= limit };
}
