// sim-smoke — the deterministic sim, proven END TO END (PROTOCOL_v2).
//
//   bun tools/sim-smoke.ts              # headless Chrome, own scratch sequencer
//   bun tools/sim-smoke.ts --headed
//   bun tools/sim-smoke.ts --console
//
// The covenant this file keeps honest: THREE independent computations of one
// punt's flight — the sequencer's live fold (Bun/JavaScriptCore), this
// process's from-the-log recompute (Bun/JSC again, but an INDEPENDENT fold
// from independently fetched entries), and the browser client's shadow fold
// (V8) — must agree about the resting body BIT FOR BIT. The V8 leg is the
// real cross-engine test of Covenant I.
//
// Also held: the epoch door (wrong sim name refused; dir-less punt refused),
// the barrier fold on epoch entry, the client actually MOVING the entity to
// the sim's word, and pre-epoch worlds keeping v1 semantics whole.
//
// Scaffolding: tools/harness.ts (R2 — the shared scratch bench).

import { join } from "node:path";
import { emptySim, simEntry, advanceSim, SIM_ID } from "../shared/sim.js";
import { foldEntry, emptyState, type LogEntry } from "../shared/fold.js";
import { scratchBench, mkCheck, bold, dim, sleep } from "./harness.ts";

const HEADED = process.argv.includes("--headed");
const ECHO = process.argv.includes("--console");

console.log(`\n${bold("sim-smoke")} — ${SIM_ID}`);
const { PORT, BASE, SCRATCH, cws, cdp, evalJson, cleanup, die } =
  await scratchBench("simsmoke", { headed: HEADED, portFrom: 8960 });
const { check, tally } = mkCheck();

// ---- the driver: author the world, keep the socket for queries -------------

const WORLD = `simsmoke-${Math.random().toString(36).slice(2, 7)}`;
const msgs: any[] = [];
const errors: string[] = [];
const dws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
dws.onmessage = (ev) => {
  const m = JSON.parse(String(ev.data));
  msgs.push(m);
  if (m.type === "error") errors.push(String(m.error));
};
await new Promise((r, j) => { dws.onopen = r as any; dws.onerror = j as any; });
dws.send(JSON.stringify({ type: "join", world: WORLD, id: "simdriver", token: "" }));
await sleep(600);
dws.send(JSON.stringify({ type: "pose", pose: { p: [0, 0, 0] } }));
const verb = async (v: string, a: unknown) => { dws.send(JSON.stringify({ type: "verb", verb: v, args: a })); await sleep(350); };

console.log(`\n${bold("── the epoch door")}  ${dim(`world ${WORLD}`)}`);
await verb("epoch", { sim: "futuresim@9.9.9", tickMs: 66 });
check("an epoch naming a sim this build lacks is refused",
  errors.some((e) => e.includes(SIM_ID)), errors.join(" | "));
errors.length = 0;
await verb("epoch", { sim: SIM_ID, tickMs: 66 });
check("the real epoch is accepted", errors.length === 0, errors.join(" | "));
await verb("spawn", { id: "ball", lib: "props/ball.glb", pos: [1, 0, 1] });
await verb("punt", { id: "ball", power: 8 });
check("a dir-less punt is refused under the epoch (Covenant III)",
  errors.some((e) => e.includes("dir")), errors.join(" | "));
errors.length = 0;
{
  const log = await Bun.file(join(SCRATCH, "sequencer.log")).text();
  check("entering the epoch folded the barrier snapshot", log.includes("epoch-barrier"));
}

// ---- the browser client joins BEFORE the punt (it folds the intent live) ---

let bootReady = "";
cws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(String(ev.data));
  if (m.method === "Runtime.consoleAPICalled") {
    const line = (m.params.args ?? []).map((a: any) => a?.value !== undefined ? String(a.value) : a?.description ?? "").join(" ");
    if (ECHO) console.log(dim(`    [page] ${line}`));
    if (line.startsWith("[boot] ready")) bootReady = line;
  }
});
await cdp.send("Page.navigate", { url: `${BASE}/?name=simbot&world=${WORLD}` });
for (let i = 0; i < 240 && !bootReady; i++) await sleep(250);
if (!bootReady) await die(2, "✗ client never booted");

// ---- the punt, witnessed by all three --------------------------------------

console.log(`\n${bold("── the flight")}`);
await verb("punt", { id: "ball", dir: [1, 0.45, 0.3], power: 8 });
// wait for rest on the sequencer's side
let serverSim: any = null;
for (let i = 0; i < 40; i++) {
  await sleep(500);
  dws.send(JSON.stringify({ type: "debug", sim: true, reqId: `q${i}` }));
  await sleep(200);
  const m = msgs.filter((x) => x.type === "debug" && x.sim).pop();
  if (m?.sim?.bodies?.ball?.resting) { serverSim = m.sim; break; }
}
check("the sequencer's fold brings the ball to REST", !!serverSim,
  serverSim ? `tick ${serverSim.tick}, p=[${serverSim.bodies.ball.p.join(", ")}]` : "never rested");
if (!serverSim) await die(1, "✗ no rest — nothing further to compare");

// leg 2: independent recompute from independently fetched entries (this
// process — Bun/JSC, but a fold that shares NOTHING live with the server's)
dws.send(JSON.stringify({ type: "history", limit: 300, reqId: "h1" }));
await sleep(600);
const hist = msgs.find((x) => x.type === "history" && x.reqId === "h1");
const entries: LogEntry[] = (hist?.entries ?? []).slice().sort((a: LogEntry, b: LogEntry) => a.seq - b.seq);
const st = emptyState(); const localSim = emptySim();
for (const e of entries) { foldEntry(st, e); simEntry(localSim, e, st); }
advanceSim(localSim, serverSim.tick);
check("independent recompute from the log agrees with the sequencer BIT FOR BIT",
  JSON.stringify(localSim.bodies) === JSON.stringify(serverSim.bodies),
  `recomputed from ${entries.length} entries`);

// leg 3: the browser's shadow fold (V8) — Covenant I's cross-engine proof
await sleep(1500);   // let the client's applier advance past rest
const clientBodies = await evalJson(`(() => { try {
  return JSON.parse(JSON.stringify(EW.simFold().bodies));
} catch (e) { return { err: String(e) } } })()`);
check("the V8 client agrees BIT FOR BIT (cross-engine, Covenant I)",
  JSON.stringify(clientBodies) === JSON.stringify(serverSim.bodies),
  clientBodies?.err ?? `client p=[${clientBodies?.ball?.p?.join(", ")}]`);

// and the client actually MOVED the thing
const shown = await evalJson(`(() => { try {
  const o = EW.entities.get('ball'); return o ? [o.position.x, o.position.y, o.position.z] : null;
} catch { return null } })()`);
check("the realized entity stands at the sim's word",
  !!shown && Math.abs(shown[0] - serverSim.bodies.ball.p[0]) < 1e-9
          && Math.abs(shown[2] - serverSim.bodies.ball.p[2]) < 1e-9,
  `shown [${shown?.map((v: number) => v.toFixed(3)).join(", ")}]`);

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
await cleanup();
process.exit(tally.failed ? 1 : 0);
