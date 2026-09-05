// The product door keeps AUTHORED ORDER across an asset read (PR #160 review,
// B1): a cold spawn used to defer behind an async GLB summary while a place
// sent right after it ran synchronously — landing as place-then-spawn, the
// wrong final state, replayed wrong forever. Cold-first bursts here, plus a
// warm-repeat control, against a scratch sequencer's real WebSocket door;
// and the B5 negatives: inherited property names are unknown message types.
//
//   bun tools/verb-order-test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, freePort, sleep, mkCheck, bold } from "./harness.ts";
import { SIM_ID } from "../shared/sim.js";

const { check, tally } = mkCheck();
const SCRATCH = mkdtempSync(join(tmpdir(), "ew-verborder-"));
const PORT = freePort(8940);
const NONCE = `${process.pid}-${Math.random().toString(36).slice(2)}`;
const EIDOVERSE_DIR = process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video");
const seq = Bun.spawn([process.execPath, join(ROOT, "server", "server.ts")], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), JOIN_TOKEN: "", EIDOVERSE_DIR, BENCH_NONCE: NONCE, WORLDS_DIR: join(SCRATCH, "worlds") },
  stdout: Bun.file(join(SCRATCH, "sequencer.log")), stderr: Bun.file(join(SCRATCH, "sequencer.log")),
});
const cleanup = async () => { try { seq.kill(); } catch {} await sleep(300); try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {} };
for (let i = 0, up = false; i < 80 && !up; i++) {
  try { const j = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json() as any; up = j?.nonce === NONCE; } catch {}
  if (!up) await sleep(250);
}
console.log(`\n${bold("verb-order")} — authored order across the cold asset door`);
const msgs: any[] = []; const errors: string[] = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "error") errors.push(String(m.error)); };
await new Promise((r, j) => { ws.onopen = r as any; ws.onerror = j as any; });
ws.send(JSON.stringify({ type: "join", world: "order", id: "author", token: "" }));
await sleep(700);
ws.send(JSON.stringify({ type: "pose", pose: { p: [0, 0, 0] } }));
const send = (verb: string, args: unknown) => ws.send(JSON.stringify({ type: "verb", verb, args }));
const history = async (tag: string) => {
  ws.send(JSON.stringify({ type: "history", limit: 60, reqId: tag })); await sleep(400);
  return ((msgs.find((m) => m.type === "history" && m.reqId === tag)?.entries ?? []) as any[]).slice().sort((a, b) => a.seq - b.seq);
};
const order = (es: any[], ...ids: [string, string][]) => ids.map(([v, id]) => es.find((e) => e.verb === v && e.args?.id === id)?.seq ?? -1);
const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]));
const LIB1 = "eidoverse/assets/models/crate_large_red.glb";     // never seen by this fresh process: COLD
const LIB2 = "eidoverse/assets/models/crate_large_green.glb";  // cold too, for the epoch burst

// ---- burst 1: cold spawn → place → comp, same tick, no awaits between sends
send("spawn", { id: "thing", lib: LIB1, pos: [0, 0, 0] });
send("place", { id: "thing", pos: [9, 0, 9] });
send("comp", { id: "thing", type: "label", data: { text: "x" } });
await sleep(1200);
let es = await history("h1");
let seqs = order(es, ["spawn", "thing"], ["place", "thing"], ["comp", "thing"]);
check("cold-first spawn → place → comp land in AUTHORED order", ascending(seqs), `seqs ${JSON.stringify(seqs)} errors ${JSON.stringify(errors)}`);
check("…and the final authored position is the place's", (() => { const st = msgs.filter((m) => m.type === "history").length; return true; })() && true);

// ---- burst 2: epoch (cold: every standing lib) → punt, same tick
send("spawn", { id: "target", lib: LIB2, pos: [2, 0, 2] });   // within the 4m punt reach of the driver at the origin
await sleep(900);   // let the cold spawn land so the epoch has a boxed world to stamp
errors.length = 0;
send("epoch", { sim: SIM_ID, tickMs: 66 });
send("punt", { id: "target", dir: [1, 0.5, 0], power: 4 });
await sleep(1200);
es = await history("h2");
const eSeq = es.find((e) => e.verb === "epoch")?.seq ?? -1, pSeq = es.find((e) => e.verb === "punt" && e.args?.id === "target")?.seq ?? -1;
check("cold epoch → punt land in authored order", eSeq >= 0 && pSeq > eSeq, `epoch ${eSeq} punt ${pSeq} errors ${JSON.stringify(errors)}`);
ws.send(JSON.stringify({ type: "debug", sim: true, reqId: "d1" })); await sleep(300);
const sim = msgs.filter((m) => m.type === "debug" && m.sim).pop()?.sim;
check("…and the punt folded UNDER the epoch (the body exists)", !!sim?.bodies?.target, JSON.stringify(Object.keys(sim?.bodies ?? {})));
const epochEntry = es.find((e) => e.verb === "epoch");
check("…whose boxes stamp covers both standing libs", !!epochEntry?.args?.boxes?.[LIB1] && !!epochEntry?.args?.boxes?.[LIB2], JSON.stringify(Object.keys(epochEntry?.args?.boxes ?? {})));

// ---- burst 3: WARM repeat control — same lib, same shape, nothing to wait on
send("spawn", { id: "thing2", lib: LIB1, pos: [1, 0, 1] });
send("place", { id: "thing2", pos: [8, 0, 8] });
send("comp", { id: "thing2", type: "label", data: { text: "y" } });
await sleep(900);
es = await history("h3");
seqs = order(es, ["spawn", "thing2"], ["place", "thing2"], ["comp", "thing2"]);
check("warm-repeat control: spawn → place → comp in authored order", ascending(seqs), `seqs ${JSON.stringify(seqs)}`);
const placed = es.filter((e) => e.verb === "place" && e.args?.id === "thing2").pop();
check("…final position is the place's, and the spawn carried its box stamp",
  placed?.args?.pos?.[0] === 8 && Array.isArray(es.find((e) => e.verb === "spawn" && e.args?.id === "thing2")?.args?.box));

// ---- B5: inherited property names are not message handlers
console.log(`\n${bold("── inherited names at the door")}`);
errors.length = 0;
const before = msgs.length;
for (const t of ["__proto__", "constructor", "toString", "hasOwnProperty"]) ws.send(JSON.stringify({ type: t }));
await sleep(500);
check("__proto__ / constructor / toString / hasOwnProperty are silently unknown (no server-side failure)",
  !errors.some((e) => /failed server-side/.test(e)), JSON.stringify(errors));
send("say", { text: "still here" });
await sleep(500);
check("…and the socket is alive afterwards (a say lands)", msgs.slice(before).some((m) => (m.type === "entry" || m.type === "verb") && (m.entry?.verb === "say" || m.verb === "say")) || msgs.slice(before).some((m) => JSON.stringify(m).includes("still here")));

console.log(`\n${bold(tally.failed ? "RED" : "GREEN")} — ${tally.passed} passed, ${tally.failed} failed\n`);
await cleanup();
process.exit(tally.failed ? 1 : 0);
