// The heartbeat's contract, in a vacuum:  bun test/server/tick-test.ts
//
// Three properties the sequencer now stands on (server/tick.ts):
//   CADENCE   — a system runs at most once per everyMs, riding the base beat;
//   ISOLATION — a throwing system costs itself the beat, never its
//               neighbors, never the process (house rule 3);
//   GAUGES    — runs/errors/worst-ms are recorded and readable (GET /tick
//               serves exactly tickStats()).

import { registerSystem, startTick, tickStats, beat } from "../../server/tick.ts";
import { until } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";

const S = suite("tick");
const check = (name: string, ok: unknown, extra?: unknown) => S.check(name, ok, extra);

let fast = 0, slow = 0, after = 0;
registerSystem({ name: "fast", everyMs: 20, fn: () => { fast++; } });
registerSystem({ name: "bomb", everyMs: 20, fn: () => { throw new Error("boom"); } });
registerSystem({ name: "after-bomb", everyMs: 20, fn: () => { after++; } });
registerSystem({ name: "slow", everyMs: 150, fn: () => { slow++; } });
// 400 ms of heartbeat on a virtual clock: twenty 20 ms beats, so every count below is exact
const T0 = 1_000_000;
for (let k = 1; k <= 20; k++) beat(T0 + 20 * k);
const st = tickStats();
const by = Object.fromEntries(st.systems.map((s) => [s.name, s]));

console.log("\nthe heartbeat (server/tick.ts)");
check("base cadence runs the fast system on every beat", fast === 20, `fast=${fast} in 20 beats`);
check("coarse cadence rides the accumulator: at least 150 ms apart (beats 1, 9 and 17)", slow === 3, `slow=${slow} in 400ms at 150ms`);
check("a throwing system never stops its neighbors", after === fast,
  `after-bomb=${after} vs fast=${fast}`);
check("the throw is recorded, not swallowed", by.bomb.errors === 20 && by.bomb.lastError!.includes("boom"),
  JSON.stringify(by.bomb));
check("healthy systems carry no lastError", by.fast.lastError === null);
check("gauges measure", by.fast.runs === fast && by.fast.worstMs >= 0, JSON.stringify(by.fast));
startTick(20);
check("startTick drives the beat on its interval", await until("a real beat runs the fast system", () => fast > 20, { ms: 2000 }));
check("double start refuses", (() => { try { startTick(20); return false; } catch { return true; } })());

S.done();
