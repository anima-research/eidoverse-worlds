// The snapshot is a DERIVED CACHE for both folds — when its byte offset is
// not credible, the sequencer must forget the snapshot's SIM too, not only its
// instant state (PR #160 review, B3: a stale epoch and a ghost body rode
// under a full replay of a one-line genesis log).
//
//   bun tools/world-open-test.ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ew-worldopen-"));
process.env.WORLDS_DIR = join(tmp, "worlds");
mkdirSync(process.env.WORLDS_DIR, { recursive: true });
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};
const mkWorld = (name: string, log: object[], snap: object | null) => {
  const d = join(process.env.WORLDS_DIR!, name); mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "log.jsonl"), log.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (snap) writeFileSync(join(d, "snapshot.json"), JSON.stringify(snap));
  return d;
};
const genesis = { seq: 0, ts: 1_760_000_000_000, actor: "world", verb: "genesis", args: { v: 3, dialect: "eidoverse-log" } };
const ghostSim = { epoch: { sim: "eidosim@0.3.0", tickMs: 66, ts: 1_760_000_000_500, seq: 99 }, tick: 5,
  bodies: { ghost: { p: [1, 2, 3], v: [0, 0, 0], yaw: 0, ground: 0, seq: 99, born: 1, resting: true } }, boxes: {}, statics: {} };
const staleState = { entities: {}, terrain: null, grass: null, sky: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {},
  epoch: { sim: "eidosim@0.3.0", tickMs: 66, ts: 1_760_000_000_500, seq: 99 } };

const { World } = await import("../server/world.ts");

console.log("\nopening a world against its snapshot (server/world.ts)");
{ // mismatched offset: another timeline's snapshot
  mkWorld("mismatch", [genesis], { v: 1, seq: 99, bytes: 999999, ts: 1, state: staleState, sim: ghostSim });
  const w: any = new World("mismatch");
  check("an incredible byte offset discards the snapshot's instant state (full replay)", w.snapSeq === -1 && !w.state.epoch);
  check("…AND its sim: no stale epoch, no ghost body", w.sim.epoch === null && Object.keys(w.sim.bodies).length === 0, JSON.stringify(w.sim));
}
{ // truncated log: snapshot claims more bytes than the file has
  mkWorld("truncated", [genesis], { v: 1, seq: 3, bytes: 5000, ts: 1, state: staleState, sim: ghostSim });
  const w: any = new World("truncated");
  check("a snapshot past the end of a truncated log is discarded, sim included", w.snapSeq === -1 && w.sim.epoch === null && !w.state.epoch);
}
{ // a credible snapshot is honoured — the sim rides
  const line = JSON.stringify(genesis) + "\n";
  mkWorld("credible", [genesis], { v: 1, seq: 0, bytes: Buffer.byteLength(line), ts: 1, state: staleState, sim: ghostSim });
  const w: any = new World("credible");
  check("a credible snapshot's sim is adopted (the cut is truth-at-barrier)", w.sim.epoch?.sim === "eidosim@0.3.0" && !!w.sim.bodies.ghost);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
