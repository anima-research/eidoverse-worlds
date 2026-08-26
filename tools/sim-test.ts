// The deterministic sim fold, held to PROTOCOL_v2's covenants in a vacuum:
//   bun tools/sim-test.ts
//
// SELF-AGREEMENT — two independent folds of the same entries are
// bit-identical; SCHEDULE-INDEPENDENCE — advancing in one jump equals
// advancing tick by tick (snapshots may cut anywhere); QUANTIZATION — the
// Covenant-IV ceil rule; TOTALITY — malformed intents shape nothing;
// RELEASE — the authored word wins; REFUSAL — a foreign epoch is recorded,
// never recomputed.

import { emptySim, simEntry, advanceSim, tickOf, simPose, simSnapshot, SIM_ID } from "../shared/sim.js";
import { foldEntry, emptyState, type LogEntry } from "../shared/fold.js";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};
const digest = (sim: any) => JSON.stringify(simSnapshot(sim));

const T0 = 1_700_000_000_000;
const mk = (seq: number, dtMs: number, verb: string, args: Record<string, unknown>): LogEntry =>
  ({ seq, ts: T0 + dtMs, actor: "t", verb, args });

const SCRIPT: LogEntry[] = [
  mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
  mk(1, 10, "epoch", { sim: SIM_ID, tickMs: 66 }),
  mk(2, 20, "spawn", { id: "crate", lib: "x.glb", pos: [1, 0.5, 2] }),
  mk(3, 500, "punt", { id: "crate", dir: [1, 0.6, 0.2], power: 8 }),
];
function fold(entries: LogEntry[]) {
  const st = emptyState(), sim = emptySim();
  for (const e of entries) { foldEntry(st, e); simEntry(sim, e, st); }
  return { st, sim };
}

console.log("\nthe sim fold (shared/sim.js) — " + SIM_ID);

{ // quantization
  const { sim } = fold(SCRIPT.slice(0, 2));
  check("epoch anchors tick 0 at its own ts", tickOf(sim, T0 + 10) === 0);
  check("ceil quantization: first boundary at-or-after ts",
    tickOf(sim, T0 + 11) === 1 && tickOf(sim, T0 + 76) === 1 && tickOf(sim, T0 + 77) === 2,
    `${tickOf(sim, T0 + 11)} ${tickOf(sim, T0 + 76)} ${tickOf(sim, T0 + 77)}`);
}

{ // flight → rest, self-agreement, schedule-independence
  const a = fold(SCRIPT), b = fold(SCRIPT);
  advanceSim(a.sim, 600);
  for (let t = 1; t <= 600; t++) advanceSim(b.sim, t);   // many small advances
  check("self-agreement: independent folds advance bit-identically",
    digest(a.sim) === digest(b.sim));
  const pose = simPose(a.sim, "crate")!;
  check("the flight comes to REST", pose.resting === true);
  check("rest lands on the body's own ground plane", pose.p[1] === 0.5, String(pose.p[1]));
  check("the crate traveled downrange", pose.p[0] > 1.5, String(pose.p[0]));
  const c = fold(SCRIPT);
  advanceSim(c.sim, 300); advanceSim(c.sim, 600);        // a snapshot-shaped cut
  check("schedule-independence: any advance path reaching T agrees",
    digest(c.sim) === digest(a.sim));
}

{ // totality + v1 preservation
  const noEpoch = fold([SCRIPT[0], SCRIPT[2], SCRIPT[3]]);
  check("pre-epoch punt keeps v1 semantics (sim untouched)",
    Object.keys(noEpoch.sim.bodies).length === 0 && noEpoch.sim.epoch === null);
  const bad = fold([...SCRIPT.slice(0, 3),
    mk(3, 500, "punt", { id: "crate", power: 8 }),                    // no dir: inert
    mk(4, 510, "punt", { id: "ghost", dir: [1, 0, 0] }),              // no entity: inert
    mk(5, 520, "punt", { id: "crate", dir: [0, 0, 0] }),              // zero vector: inert
    mk(6, 530, "epoch", { sim: SIM_ID, tickMs: 4 }),                  // tick too fine: inert
  ]);
  check("malformed intents shape nothing (folding is total)",
    Object.keys(bad.sim.bodies).length === 0 && bad.sim.epoch!.tickMs === 66);
  const clamped = fold([...SCRIPT.slice(0, 3), mk(3, 500, "punt", { id: "crate", dir: [1, 0, 0], power: 9999 })]);
  check("power is clamped, not honored", Math.abs(clamped.sim.bodies.crate.v[0]) <= 20);
}

{ // release: the authored word wins
  const rel = fold([...SCRIPT, mk(4, 700, "place", { id: "crate", pos: [9, 9, 9] })]);
  advanceSim(rel.sim, 600);
  check("a place releases the body to the instant fold",
    simPose(rel.sim, "crate") === null && rel.st.entities.crate.pos[0] === 9);
  const re = fold([...SCRIPT, mk(4, 700, "punt", { id: "crate", dir: [-1, 0.5, 0], power: 8 })]);
  advanceSim(re.sim, 600);
  check("a re-punt kicks the FLYING body onward (continuity, not reset)",
    simPose(re.sim, "crate") !== null && re.sim.bodies.crate.seq === 4);
}

{ // foreign epoch: refusal, never recomputation
  const f = fold([SCRIPT[0], mk(1, 10, "epoch", { sim: "futuresim@9.9.9", tickMs: 66 }), SCRIPT[2], SCRIPT[3]]);
  advanceSim(f.sim, 600);
  check("a foreign sim is recorded and refused",
    f.sim.epoch!.foreign === true && Object.keys(f.sim.bodies).length === 0);
}

console.log(`\n${fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
