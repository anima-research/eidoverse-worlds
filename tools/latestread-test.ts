// latestread-test — the panels' paced re-read (client/lib/edit/latestread.js): one read in flight per key, the newest wish
// wins, never closer than the gap, and a failed read doesn't wedge the key.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/latestread-test.ts
import { latestRead } from "../client/lib/edit/latestread.js";

let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info?: unknown) => { if (ok) pass++; else fail++; console.log(`${ok ? "ok  " : "FAIL"} ${n}${ok ? "" : "  " + JSON.stringify(info)}`); };

// a hand-driven clock and timer queue, so the test says exactly what ran when
let t = 0; let timers: { at: number; f: () => void }[] = [];
const later = (f: () => void, ms: number) => { timers.push({ at: t + ms, f }); return timers.length; };
const tick = async (to: number) => { while (true) { timers.sort((a, b) => a.at - b.at); const n = timers[0]; if (!n || n.at > to) break; timers.shift(); t = n.at; n.f(); await flush(); } t = to; await flush(); };
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const reset = () => { t = 0; timers = []; };

// a read the test answers by hand
const reads: { key: string; tag: string; answer: () => void; refuse: () => void }[] = [];
const read = (key: string, tag: string) => () => new Promise<void>((ok, no) => { reads.push({ key, tag, answer: ok, refuse: () => no(new Error("refused")) }); });

{ reset(); reads.length = 0; const paced = latestRead(250, () => t, later);
  paced("a", read("a", "1"));
  for (let i = 2; i <= 30; i++) paced("a", read("a", String(i)));   // thirty changes while the first read is out
  await flush();
  check("L1 thirty asks while one read is in flight start ONE read", reads.length === 1 && reads[0].tag === "1", reads.map((r) => r.tag));
  reads[0].answer(); await flush(); await tick(250);
  check("L2 when it answers, only the NEWEST wish runs (not the 28 between), and not before the gap", reads.length === 2 && reads[1].tag === "30", reads.map((r) => r.tag));
  reads[1].answer(); await tick(10_000);
  check("L3 nothing more runs once the newest has been read", reads.length === 2, reads.map((r) => r.tag)); }

{ reset(); reads.length = 0; const paced = latestRead(250, () => t, later);
  paced("a", read("a", "1")); reads[0].answer(); await flush();
  await tick(100); paced("a", read("a", "2")); await flush();
  check("L4 an ask 100 ms after a read began waits for the 250 ms gap", reads.length === 1, reads.map((r) => r.tag));
  await tick(249); check("L4 …still waiting at 249 ms", reads.length === 1);
  await tick(250); check("L4 …and runs at 250 ms", reads.length === 2 && reads[1].tag === "2", reads.map((r) => r.tag)); }

{ reset(); reads.length = 0; const paced = latestRead(250, () => t, later);
  paced("a", read("a", "1")); paced("b", read("b", "1")); await flush();
  check("L5 different keys don't wait on each other", reads.length === 2 && reads.map((r) => r.key).join() === "a,b", reads.map((r) => r.key)); }

{ reset(); reads.length = 0; const paced = latestRead(250, () => t, later);
  paced("a", read("a", "1")); paced("a", read("a", "2")); await flush();
  reads[0].refuse(); await tick(250);
  check("L6 a refused read doesn't wedge the key: the waiting wish still runs", reads.length === 2 && reads[1].tag === "2", reads.map((r) => r.tag));
  let threw = 0; paced("c", () => { threw++; throw new Error("sync"); }); paced("c", read("c", "after")); await tick(1000);
  check("L6 …nor does a read that throws before it starts", threw === 1 && reads.at(-1)?.tag === "after", { threw, last: reads.at(-1)?.tag }); }

{ reset(); reads.length = 0; const paced = latestRead(250, () => t, later);
  paced("a", read("a", "slow")); await flush(); await tick(2000);   // a slow read: still out well past the gap
  paced("a", read("a", "2")); paced("a", read("a", "3")); await flush();
  check("L7 past the gap, a read still in flight still holds the key: nothing new starts", reads.length === 1, reads.map((r) => r.tag));
  reads[0].answer(); await tick(2001);
  check("L7 …and when it answers the newest runs at once (the gap has passed)", reads.length === 2 && reads[1].tag === "3", reads.map((r) => r.tag)); }

console.log(`[latestread-test] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
