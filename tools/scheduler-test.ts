// client/lib/scheduler.js — the one loader (TEL0S_NOTES §11.3), tested
// headless: pumping rides queueMicrotask, so Bun drives it without a
// renderer.
//
//   bun tools/scheduler-test.ts
//
// The load-bearing claims: band priority decides dequeue order (FIFO
// within a band); function priorities are re-read at dequeue; a re-
// scheduled key keeps ONE job and orphans no caller's await; owners
// cancel queued and running work; onIdle observes a band draining and
// never needs a timeout.

import { schedule, cancelOwner, pending, onIdle, laneStats, P } from "../client/lib/scheduler.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
/** A job whose completion the test holds. */
const gate = () => { let open: () => void; const p = new Promise<void>((r) => { open = r; }); return { open: open!, p }; };

console.log(`\nscheduler.js — the one loader\n`);

// 1. priority order across bands, FIFO within one
{
  const order: string[] = [];
  const g1 = gate(), g2 = gate();
  // fill the cpu lane (max 2) so everything else must queue
  schedule({ key: "block1", lane: "cpu", priority: P.BODY_SELF, run: () => g1.p });
  schedule({ key: "block2", lane: "cpu", priority: P.BODY_SELF, run: () => g2.p });
  await tick();
  schedule({ key: "far", lane: "cpu", priority: P.FAR, run: async () => { order.push("far"); } });
  schedule({ key: "near-a", lane: "cpu", priority: P.NEAR, run: async () => { order.push("near-a"); } });
  schedule({ key: "body", lane: "cpu", priority: P.BODY, run: async () => { order.push("body"); } });
  schedule({ key: "near-b", lane: "cpu", priority: P.NEAR, run: async () => { order.push("near-b"); } });
  g1.open(); g2.open();
  await tick(); await tick(); await tick();
  check("bands dequeue high-to-low, FIFO within a band",
    order.join(",") === "body,near-a,near-b,far", order.join(","));
}

// 2. function priority re-read at dequeue
{
  const order: string[] = [];
  const g = gate();
  let hot = false;
  schedule({ key: "blockA", lane: "cpu", priority: P.BODY_SELF, run: () => g.p });
  schedule({ key: "blockB", lane: "cpu", priority: P.BODY_SELF, run: () => g.p });
  await tick();
  schedule({ key: "steady", lane: "cpu", priority: P.NEAR, run: async () => { order.push("steady"); } });
  schedule({ key: "walker", lane: "cpu", priority: () => (hot ? P.BODY : P.COSMETIC), run: async () => { order.push("walker"); } });
  hot = true;                     // the camera moved before the lane freed
  g.open();
  await tick(); await tick(); await tick();
  check("function priority is re-evaluated at dequeue",
    order.join(",") === "walker,steady", order.join(","));
}

// 3. re-scheduling a queued key: one run (the newer), both awaits settle
{
  const g = gate();
  let runs = 0;
  schedule({ key: "blockC", lane: "cpu", priority: P.BODY_SELF, run: () => g.p });
  schedule({ key: "blockD", lane: "cpu", priority: P.BODY_SELF, run: () => g.p });
  await tick();
  const h1 = schedule({ key: "dup", lane: "cpu", priority: P.FAR, run: async () => { runs++; return "old"; } });
  const h2 = schedule({ key: "dup", lane: "cpu", priority: P.COSMETIC, run: async () => { runs++; return "new"; } });
  g.open();
  const [v1, v2] = await Promise.all([h1.done, h2.done]);
  check("deduped key runs once, newer run wins", runs === 1 && v1 === "new" && v2 === "new", `runs=${runs} v1=${v1} v2=${v2}`);
}

// 4. cancelOwner: queued jobs reject, running jobs see their signal
{
  const g = gate();
  let sawAbort = false;
  schedule({ key: "victim-running", owner: "entity:x", lane: "cpu", priority: P.BODY_SELF,
    run: (signal: AbortSignal) => new Promise<void>((res) => {
      signal.addEventListener("abort", () => { sawAbort = true; res(); });
      g.p.then(res);
    }) });
  await tick();
  const q = schedule({ key: "victim-queued", owner: "entity:x", lane: "cpu", priority: P.FAR, run: async () => {} });
  let queuedRejected = false;
  q.done.catch(() => { queuedRejected = true; });
  cancelOwner("entity:x");
  g.open();
  await tick(); await tick();
  check("cancelOwner rejects queued work", queuedRejected);
  check("cancelOwner aborts running work's signal", sawAbort);
}

// 5. onIdle observes a band, indifferent to lower bands still queued
{
  const g = gate();
  let idleAt = -1;
  let cosmeticsDone = false;
  schedule({ key: "important", lane: "gpu", priority: P.BODY, run: () => g.p });
  schedule({ key: "cosmetic", lane: "gpu", priority: P.COSMETIC, run: async () => { await new Promise((r) => setTimeout(r, 20)); cosmeticsDone = true; } });
  await tick();
  onIdle(() => { idleAt = pending(P.BODY); }, P.BODY);
  g.open();
  await tick(); await tick();
  check("onIdle(band) fires when the band drains", idleAt === 0);
  check("…without waiting for lower bands", !cosmeticsDone || pending() === 0);
  await new Promise((r) => setTimeout(r, 30));   // drain the cosmetic straggler
}

// 6. lanes are independent and capped
{
  const gates = [gate(), gate(), gate()];
  for (let i = 0; i < 3; i++) schedule({ key: `cap${i}`, lane: "net", priority: P.NEAR, run: () => gates[i].p });
  await tick();
  const s = laneStats();
  check("net lane runs up to its cap", s.net.running === 3 && s.net.queued === 0, JSON.stringify(s.net));
  gates.forEach((g) => g.open());
  await tick(); await tick();
  check("drained clean", pending() === 0, String(pending()));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
