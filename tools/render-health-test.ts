// render-health-test — the watchdog's verdict on a renderer page, without a browser.
//
//   bun tools/render-health-test.ts
//
// deploy/render-health.ts judge() asks the page four things (alive, frames, joined, capture).
// Here a fake page answers them. Every outcome is pinned, along with the two pages that fooled the
// watchdog before: a healthy full client whose #hud shows no fps (it read 0 and was killed every two
// minutes), and a lite client, which has no EW but can still hand back a frame's worth of bytes from
// capture.js (seen live on the roamers, 2026-10-24).

import { judge, tally, PROBES, TIMEOUT, type Evaluate } from "../deploy/render-health.ts";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
}

type Page = { alive?: unknown; frames?: unknown; joined?: unknown; capture?: unknown; hud?: unknown };
/** A page that answers the four probes as given (by exact expression), records what was asked,
 *  and answers anything else, such as an old #hud scrape, with `hud`. */
function page(p: Page) {
  const asked: string[] = [];
  const evaluate: Evaluate = async (expr) => {
    const name = (Object.keys(PROBES) as (keyof typeof PROBES)[]).find((k) => PROBES[k] === expr);
    asked.push(name ?? expr);
    if (!name) return p.hud ?? 0;
    return p[name];
  };
  return { evaluate, asked };
}
const healthy: Page = { alive: 2, frames: 60, joined: true, capture: 113686 };

console.log("verdicts");
{
  const pg = page(healthy);
  const h = await judge(pg.evaluate);
  check("a joined, drawing page that captures is healthy", h.healthy && h.alive && h.fps === 60 && h.reason === "fps=60 snap=111KB", JSON.stringify(h));
  check("…asked alive, frames, joined, capture, in that order, and nothing else", pg.asked.join() === "alive,frames,joined,capture", pg.asked.join());
}
{
  // the incident: the client stopped showing NNfps in #hud; the old probe read 0 and struck a healthy page out
  const h = await judge(page({ ...healthy, hud: "" }).evaluate);
  check("a healthy page whose #hud shows no fps is still healthy (the probe reads nothing off the page)", h.healthy, JSON.stringify(h));
}
{
  const pg = page({ alive: TIMEOUT });
  const h = await judge(pg.evaluate);
  check("no answer to a trivial eval: main thread hung", !h.healthy && h.reason === "main thread hung" && pg.asked.join() === "alive", JSON.stringify(h));
}
{
  // the lite client: no EW, so never joined, though capture.js still returns bytes
  const pg = page({ alive: 2, frames: 62, joined: false, capture: 113686 });
  const h = await judge(pg.evaluate);
  check("a lite page (no EW) is not joined, though its capture returns bytes", !h.healthy && h.reason === "not joined", JSON.stringify(h));
  check("…and capture is never asked of it", !pg.asked.includes("capture"), pg.asked.join());
}
check("joined must be exactly true (a truthy string is not)", !(await judge(page({ ...healthy, joined: "true" }).evaluate)).healthy);
{
  const h = await judge(page({ ...healthy, frames: TIMEOUT }).evaluate);
  check("frames that never come back count as 0: no frames", !h.healthy && h.reason === "no frames" && h.fps === 0, JSON.stringify(h));
  const z = await judge(page({ ...healthy, frames: 0 }).evaluate);
  check("a loop that drew nothing in a second: no frames", !z.healthy && z.reason === "no frames", JSON.stringify(z));
  const nan = await judge(page({ ...healthy, frames: "lots" }).evaluate);
  check("a frame count that is not a number counts as 0", !nan.healthy && nan.fps === 0, JSON.stringify(nan));
}
{
  const h = await judge(page({ ...healthy, capture: TIMEOUT }).evaluate);
  check("a capture that does not return: capture timed out", !h.healthy && h.reason === "capture timed out" && h.fps === 60, JSON.stringify(h));
  const e = await judge(page({ ...healthy, capture: "ERR empty readback" }).evaluate);
  check("a capture that throws: capture failed, with the page's words", !e.healthy && e.reason === "capture failed: ERR empty readback", JSON.stringify(e));
  const u = await judge(page({ ...healthy, capture: undefined }).evaluate);
  check("a capture with no answer at all: capture failed", !u.healthy && u.reason.startsWith("capture failed"), JSON.stringify(u));
  const zero = await judge(page({ ...healthy, capture: 0 }).evaluate);
  check("a capture of zero bytes: capture failed", !zero.healthy && zero.reason.startsWith("capture failed"), JSON.stringify(zero));
}

console.log("strikes");
{
  const bad = { alive: true, healthy: false, reason: "capture timed out" };
  const good = { alive: true, healthy: true, reason: "fps=60 snap=111KB" };
  let s = 0; const seen: boolean[] = [];
  for (let i = 0; i < 3; i++) { const t = tally(s, bad, 3); s = t.strikes; seen.push(t.restart); }
  check("a capture timeout is a strike, and three in a row restart", s === 3 && seen.join() === "false,false,true", `${s} ${seen}`);
  const failed = { alive: true, healthy: false, reason: "capture failed: ERR x" };
  check("a capture failure is a strike", tally(0, failed, 3).strikes === 1);
  check("one healthy check clears the strikes", tally(2, good, 3).strikes === 0 && !tally(2, good, 3).restart);
  check("STRIKES=1 restarts on the first bad check", tally(0, bad, 1).restart);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
