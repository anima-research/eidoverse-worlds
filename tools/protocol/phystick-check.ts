// tools/protocol/phystick-check.ts — the engine's heartbeat (DESIGN-physics-responsiveness §1; STRIKES PH-S1-2).
// Before: the sim advanced and rests were logged INSIDE whoever's request came next (503 ms for the first `wait` after a
// 40-crate knock, then 145–341 ms each), and rests never logged without a request. Now server.ts calls settle(w) on its
// own beat. usage: bun tools/protocol/phystick-check.ts   (NO_TICK=1 runs the old shape: every check below goes red)
//   T1  rests log with nobody asking: after the throw only settle() passes run; every launched body rests on the record
//   T2  a request during the cascade is cheap: max `wait` under the beat is a fraction of the request-path figure
//   T3  bounded passes: one pass advances at most maxTicks engine ticks, a stall catches up over later passes, and the
//       result is bit-identical to advancing straight (Covenant IV: advancement is schedule-independent)
// @ts-nocheck
import fs from "node:fs";
import { request, settle } from "../../shared/protocol/authority.js";
import { openLive } from "../../server/livehost.ts";
import { restsOf, digestOf } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";

const root = scratch("phystick"); let fails = 0, passes = 0;
const ok = (c, what, d) => { if (c) passes++; else { fails++; console.log("FAIL", what, d !== undefined ? JSON.stringify(d).slice(0, 300) : ""); } };
const NO_TICK = process.env.NO_TICK === "1";
const TICK = 33;
function world(name, N) {
  const dir = `${root}${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  let T = 1800000000000; const now = () => T;
  const w = openLive(dir, name, { now });
  const call = (actor, verb, args = {}, step = 100) => { T += step; return request(w, actor, verb, args); };
  call("rowan", "create-world", { title: name });
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0", tickMs: TICK } });
  for (let i = 0; i < N; i++) call("rowan", "create", { id: `cr-${i}`, model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 3] } });
  call("rowan", "create", { id: "ball", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call("rowan", "move", { to: [0, 0, -0.5] }); call("rowan", "grab", { id: "ball" });
  const beat = (ms, maxTicks) => { T += ms; return NO_TICK ? 0 : settle(w, maxTicks ? { maxTicks } : {}); };
  return { w, call, beat, now };
}

// T1: throw, then only beats (no request at all) until the beat writes nothing for 2 s; every launched body has a rest
{
  const { w, call, beat } = world("t1", 12);
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T1 throw");
  let wrote = 0; const flying = () => Object.values(w.simPeek().sim?.bodies ?? {}).some((b) => !b.resting);
  for (let k = 0; k < 1800; k++) { wrote += beat(TICK); if (k > 2 && !flying() && w.simPeek().rested.length === 0) break; }
  const R = restsOf(w.entries); const launched = Object.keys(w.sim().launched);
  ok(wrote > 0 && R.length > 0, "T1 rests were logged by the beat alone", { wrote, rests: R.length });
  ok(launched.every((id) => R.some((r) => r.id === id)), "T1 every launched body rests on the record", { launched, rested: R.map((r) => r.id) });
}

// T2: during a 40-crate cascade the beat runs between requests; a `wait` request must not carry the settling
{
  const { w, call, beat } = world("t2", 40);
  ok(call("rowan", "throw", { id: "ball", v: [0, 1, 12] }).ok, "T2 throw");
  const times = [];
  for (let s = 0; s < 40; s++) { for (let b = 0; b < 30; b++) beat(TICK); const a = performance.now(); const r = call("rowan", "wait", {}, 0); times.push(performance.now() - a); if (!Object.keys(r.inFlight ?? {}).length && s > 2) break; }
  const max = Math.max(...times);
  ok(max < 60, "T2 the slowest request under the beat is under 60 ms", { max: +max.toFixed(0), times: times.map((t) => +t.toFixed(0)) });
}

// T3: bounded passes. The same world advanced (a) straight to now and (b) by passes of maxTicks=3 after a 20-tick stall:
// the engine states agree bit for bit, and one bounded pass never moved more than 3 ticks.
{
  const A = world("t3a", 6), B = world("t3b", 6);
  A.call("rowan", "throw", { id: "ball", v: [0, 1, 12] }); B.call("rowan", "throw", { id: "ball", v: [0, 1, 12] });
  const stall = 20 * TICK;
  A.beat(stall, 1e6); const da = digestOf(A.w.simPeek().sim), ta = A.w.simPeek().sim.tick;
  const t0 = B.w.simPeek().sim.tick; B.beat(stall, 3); const t1 = B.w.simPeek().sim.tick;
  ok(!NO_TICK && t1 - t0 <= 3, "T3 one bounded pass advances at most maxTicks", { t0, t1 });
  for (let k = 0; k < 20; k++) B.beat(0, 3);
  const pb = B.w.simPeek(); ok(pb.sim.tick === ta && digestOf(pb.sim) === da, "T3 catching up by bounded passes is bit-identical to advancing straight", { ta, tb: pb.sim.tick, da, db: digestOf(pb.sim) });
}
console.log(`phystick: ${passes} ok, ${fails} failed${NO_TICK ? " (NO_TICK: the old shape)" : ""}`);
process.exit(fails ? 1 : 0);
