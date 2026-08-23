// The heartbeat's contract, in a vacuum:  bun tools/tick-test.ts
//
// Three properties the sequencer now stands on (server/tick.ts):
//   CADENCE   — a system runs at most once per everyMs, riding the base beat;
//   ISOLATION — a throwing system costs itself the beat, never its
//               neighbors, never the process (house rule 3);
//   GAUGES    — runs/errors/worst-ms are recorded and readable (GET /tick
//               serves exactly tickStats()).

import { registerSystem, startTick, tickStats } from "../server/tick.ts";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fast = 0, slow = 0, after = 0;
registerSystem({ name: "fast", everyMs: 20, fn: () => { fast++; } });
registerSystem({ name: "bomb", everyMs: 20, fn: () => { throw new Error("boom"); } });
registerSystem({ name: "after-bomb", everyMs: 20, fn: () => { after++; } });
registerSystem({ name: "slow", everyMs: 150, fn: () => { slow++; } });
startTick(20);

await sleep(400);
const st = tickStats();
const by = Object.fromEntries(st.systems.map((s) => [s.name, s]));

console.log("\nthe heartbeat (server/tick.ts)");
check("base cadence runs the fast system repeatedly", fast >= 10, `fast=${fast}`);
check("coarse cadence rides the accumulator", slow >= 2 && slow <= 4, `slow=${slow} in 400ms at 150ms`);
check("a throwing system never stops its neighbors", after === fast,
  `after-bomb=${after} vs fast=${fast}`);
check("the throw is recorded, not swallowed", by.bomb.errors >= 10 && by.bomb.lastError!.includes("boom"),
  JSON.stringify(by.bomb));
check("healthy systems carry no lastError", by.fast.lastError === null);
check("gauges measure", by.fast.runs === fast && by.fast.worstMs >= 0, JSON.stringify(by.fast));
check("double start refuses", (() => { try { startTick(20); return false; } catch { return true; } })());

console.log(`\n${fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
