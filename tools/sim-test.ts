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

{ // eidosim@0.2.0: terrain-aware ground (§24t-3 — the epoch bump the 0.1
  // header scheduled, unblocked by shared/terrainmath.js)
  const { makeHeightField, terrainParams } = await import("../shared/terrainmath.js");
  const TARGS = { seed: 7, size: 160, segments: 8, amplitude: 2.6, flatRadius: 16 };
  const HILLS: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 5, "terrain", TARGS),                             // authored BEFORE the epoch
    mk(2, 10, "epoch", { sim: SIM_ID, tickMs: 66 }),
    mk(3, 20, "spawn", { id: "barrel", lib: "x.glb", pos: [20, 1.2, 20] }),
    mk(4, 500, "punt", { id: "barrel", dir: [1, 0.9, 0], power: 6 }),
  ];
  const { sim } = fold(HILLS);
  check("a 0.2 epoch adopts the world's standing terrain", !!sim.terrain
    && (sim.terrain as any).seed === 7 && (sim.terrain as any).amplitude === 2.6);
  advanceSim(sim, 600);
  const pose = simPose(sim, "barrel")!;
  const hf = makeHeightField(terrainParams(TARGS));
  check("the flight rests ON THE TERRAIN under it — not at launch altitude",
    pose.resting === true && pose.p[1] === hf(pose.p[0], pose.p[2]),
    `rest y ${pose.p[1]} vs terrain ${hf(pose.p[0], pose.p[2])} (launch was 1.2)`);
  // schedule-independence holds under the terrain law too
  const b2 = fold(HILLS);
  advanceSim(b2.sim, 123); advanceSim(b2.sim, 600);
  check("0.2 schedule-independence (terrain law)", digest(b2.sim) === digest(sim));
  // a terrain entry mid-epoch re-grounds the world: every body released
  const c2 = fold([...HILLS, mk(5, 900, "terrain", { ...TARGS, seed: 8 })]);
  advanceSim(c2.sim, 600);
  check("a terrain entry under a live 0.2 epoch releases every body (the authored word re-seats)",
    Object.keys(c2.sim.bodies).length === 0 && (c2.sim.terrain as any).seed === 8);
  // snapshots carry the terrain law
  check("the sim snapshot carries the terrain params", !!(simSnapshot(sim) as any).terrain);
}

{ // THE 0.1.0 LAW IS CARRIED, PINNED: an old log's epoch replays flat-floor
  // — same bits it always produced — even though this build MINTS 0.2.0.
  const OLD: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 5, "terrain", { seed: 7, size: 160, amplitude: 2.6 }),
    mk(2, 10, "epoch", { sim: "eidosim@0.1.0", tickMs: 66 }),
    mk(3, 20, "spawn", { id: "crate", lib: "x.glb", pos: [20, 1.2, 20] }),
    mk(4, 500, "punt", { id: "crate", dir: [1, 0.6, 0], power: 8 }),
  ];
  const { sim } = fold(OLD);
  check("a 0.1.0 epoch is CARRIED (not foreign)", !sim.epoch!.foreign);
  check("...and ignores terrain (its law is the flat floor, preserved)", sim.terrain === null);
  advanceSim(sim, 600);
  const pose = simPose(sim, "crate")!;
  check("...its flight rests at launch altitude, exactly as 0.1.0 always did",
    pose.resting === true && pose.p[1] === 1.2, String(pose.p[1]));
}

{ // eidosim@0.3.0: the world's things are colliders (§24t-8 — boxes the
  // sequencer stamps into history; Covenant III)
  const CRATE = [[-0.5, 0, -0.5], [0.5, 1, 0.5]];
  const WALLBOX = [[-0.25, 0, -2], [0.25, 2, 2]];
  const BOXES = { "crate.glb": CRATE, "wall.glb": WALLBOX };
  const WALL: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 5, "spawn", { id: "wall", lib: "wall.glb", pos: [4, 0, 0] }),          // standing BEFORE the epoch
    mk(2, 10, "epoch", { sim: SIM_ID, tickMs: 66, boxes: BOXES }),
    mk(3, 20, "spawn", { id: "crate", lib: "crate.glb", pos: [0, 0, 0] }),
    mk(4, 30, "spawn", { id: "ghost", lib: "nobox.glb", pos: [2, 0, 0] }),       // no box: not a collider
    mk(5, 500, "punt", { id: "crate", dir: [1, 0.3, 0], power: 8 }),
  ];
  const { sim } = fold(WALL);
  check("a colliding epoch (0.3+) adopts the stamped boxes and makes every covered standing entity a static",
    !!sim.boxes && Object.keys(sim.boxes).length === 2
      && !!sim.statics && "wall" in sim.statics && !("ghost" in sim.statics) && !("crate" in sim.statics),
    JSON.stringify(Object.keys(sim.statics ?? {})));
  advanceSim(sim, 600);
  const pose = simPose(sim, "crate")!;
  check("a flight into a wall BOUNCES back and rests on the near side",
    pose.resting === true && pose.p[0] + 0.5 <= 3.75 + 1e-9 && pose.p[0] > 0,
    `rest x ${pose.p[0]} (wall face at 3.75)`);
  check("…and the resting crate is a static again", "crate" in sim.statics!);
  const b2 = fold(WALL);
  advanceSim(b2.sim, 123); advanceSim(b2.sim, 600);
  check("schedule-independence (collision law)", digest(b2.sim) === digest(sim));
  // a collider change mid-flight takes effect at ITS tick, whatever the
  // advance schedule: live (advance, fold, advance) ≡ replay (fold all, advance)
  const MOVE = [...WALL, mk(6, 560, "place", { id: "wall", pos: [2.2, 0, 0] })];
  const live = fold(WALL);
  advanceSim(live.sim, tickOf(live.sim, T0 + 540));
  foldEntry(live.st, MOVE[6]); simEntry(live.sim, MOVE[6], live.st);
  advanceSim(live.sim, 600);
  const replay = fold(MOVE); advanceSim(replay.sim, 600);
  check("a place moving a static mid-flight lands at its entry's tick — live fold ≡ replay",
    digest(live.sim) === digest(replay.sim));
  check("…and the moved wall was met where it now stands",
    replay.sim.bodies.crate.p[0] + 0.5 <= 1.95 + 1e-9, String(replay.sim.bodies.crate.p[0]));
  // landing ON a thing: its top is ground, and the body says what it stands on
  const STACK: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 10, "epoch", { sim: SIM_ID, tickMs: 66, boxes: { "crate.glb": CRATE, "deck.glb": [[-3, 0, -1], [3, 1, 1]] } }),
    mk(2, 20, "spawn", { id: "deck", lib: "deck.glb", pos: [5, 0, 0] }),
    mk(3, 30, "spawn", { id: "crate", lib: "crate.glb", pos: [0, 0, 0] }),
    mk(4, 500, "punt", { id: "crate", dir: [1, 1, 0], power: 8 }),
  ];
  const s2 = fold(STACK); advanceSim(s2.sim, 900);
  const onDeck = s2.sim.bodies.crate;
  check("a flight landing on a deck RESTS ON IT (its top is ground) and names its support",
    onDeck.resting === true && onDeck.p[1] === 1 && onDeck.on === "deck" && onDeck.p[0] > 2 && onDeck.p[0] < 8,
    `y ${onDeck.p[1]} on ${onDeck.on} x ${onDeck.p[0]}`);
  // a spawn under the epoch carries the sequencer's stamp → a static
  const s3 = fold([...WALL, mk(6, 700, "spawn", { id: "new", lib: "new.glb", pos: [9, 0, 9], box: CRATE })]);
  check("a spawn's stamped box makes the new thing a static", "new" in s3.sim.statics! && !!s3.sim.boxes!["new.glb"]);
  check("the sim snapshot carries boxes and statics", !!(simSnapshot(s3.sim) as any).boxes && !!(simSnapshot(s3.sim) as any).statics);
  // THE 0.2.0 LAW IS CARRIED, PINNED: the same wall under a 0.2.0 epoch is air
  const OLD2 = WALL.map((e) => e.seq === 2 ? mk(2, 10, "epoch", { sim: "eidosim@0.2.0", tickMs: 66, boxes: BOXES }) : e);
  const o2 = fold(OLD2); advanceSim(o2.sim, 600);
  check("a 0.2.0 epoch ignores boxes (no statics; the JSON it always had)",
    !o2.sim.epoch!.foreign && o2.sim.boxes === undefined && o2.sim.statics === undefined
      && !("on" in o2.sim.bodies.crate) && !("box" in o2.sim.bodies.crate));
  check("…and its flight passes THROUGH the wall, exactly as 0.2.0 always did",
    o2.sim.bodies.crate.resting === true && o2.sim.bodies.crate.p[0] > 4.5, String(o2.sim.bodies.crate.p[0]));
}

{ // LEAVING an epoch (ruling 2026-09-01): an explicit `sim: null`, never a toggle
  const EXIT: LogEntry[] = [...SCRIPT,
    mk(4, 700, "place", { id: "crate", pos: [3, 0.5, 3], via: "epoch-release" }),   // the sequencer's release
    mk(5, 701, "epoch", { sim: null })];
  const { sim } = fold(EXIT);
  check("an explicit `sim: null` epoch ENDS the sim epoch (no bodies, no law, no boxes)",
    sim.epoch === null && Object.keys(sim.bodies).length === 0 && sim.terrain === null
      && sim.boxes === undefined && sim.statics === undefined);
  const after = fold([...EXIT, mk(6, 800, "punt", { id: "crate", dir: [1, 0.5, 0], power: 8 })]);
  check("…and a later punt keeps v1 semantics (the sim folds nothing)",
    after.sim.epoch === null && Object.keys(after.sim.bodies).length === 0);
  const back = fold([...EXIT, mk(6, 900, "epoch", { sim: SIM_ID, tickMs: 66 }),
    mk(7, 950, "punt", { id: "crate", dir: [1, 0.5, 0], power: 8 })]);
  advanceSim(back.sim, 600);
  check("…and the world can re-enter an epoch afterwards",
    back.sim.epoch?.sim === SIM_ID && back.sim.bodies.crate?.resting === true);
  const noop = fold([SCRIPT[0], mk(1, 10, "epoch", { sim: null })]);
  check("leaving with no epoch to leave is inert (totality)", noop.sim.epoch === null && noop.sim.tick === 0);
  const missing = fold([...SCRIPT, mk(4, 700, "epoch", {})]);
  check("an epoch entry with no `sim` at all is NOT an exit — inert, as ever", missing.sim.epoch?.sim === SIM_ID
    && Object.keys(missing.sim.bodies).length === 1);
}

{ // PR #160 review — B2: a terrain change rebuilds the statics from the fold
  const CRATE = [[-0.5, 0, -0.5], [0.5, 1, 0.5]];
  const S: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 10, "epoch", { sim: SIM_ID, tickMs: 66, boxes: { "crate.glb": CRATE } }),
    mk(2, 20, "spawn", { id: "crate", lib: "crate.glb", pos: [10, 0, 0] }),
    mk(3, 500, "punt", { id: "crate", dir: [1, 0.3, 0], power: 8 }),
  ];
  const a = fold(S); advanceSim(a.sim, 600);
  const restX = a.sim.bodies.crate.p[0];
  check("setup: the punted crate rested away from its authored spot and became a static there",
    a.sim.bodies.crate.resting === true && restX > 12 && a.sim.statics!.crate.aabb[0][0] > 11.5, String(restX));
  const t = fold([...S, mk(4, 9000, "terrain", { seed: 3, size: 160, amplitude: 1 })]);
  check("a terrain change under a live epoch releases the body AND rebuilds its static at the FOLD's word",
    Object.keys(t.sim.bodies).length === 0 && !!t.sim.statics!.crate
      && t.sim.statics!.crate.aabb[0][0] === 9.5 && t.sim.statics!.crate.aabb[1][0] === 10.5,
    JSON.stringify(t.sim.statics!.crate));
  check("…and no ghost static survives into the snapshot",
    JSON.stringify(simSnapshot(t.sim)).indexOf(String(restX).slice(0, 6)) === -1);
  // a light reusing the id replaces the thing wholesale: no body, no static
  const l = fold([...S, mk(4, 9000, "light", { id: "crate", pos: [1, 2, 1], color: 0xffffff, intensity: 1 })]);
  check("a light reusing an entity id releases the body and drops its static",
    !l.sim.bodies.crate && !l.sim.statics!.crate);
}

{ // PR #160 review — the resting fast-path: a long gap is a jump, and bit-identical to stepping
  const CRATE = [[-0.5, 0, -0.5], [0.5, 1, 0.5]];
  const S: LogEntry[] = [mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 10, "epoch", { sim: SIM_ID, tickMs: 66, boxes: { "c.glb": CRATE } })];
  let seq = 2;
  for (let i = 0; i < 200; i++) S.push(mk(seq++, 20 + i, "spawn", { id: `c${i}`, lib: "c.glb", pos: [i * 2, 0, 0] }));
  for (let i = 0; i < 200; i++) S.push(mk(seq++, 500 + i, "punt", { id: `c${i}`, dir: [0, 1, 0.2], power: 3 }));
  const a = fold(S); advanceSim(a.sim, 400);          // everything rests inside 400 ticks
  check("setup: 200 bodies at rest", Object.values(a.sim.bodies).every((b: any) => b.resting));
  const b = fold(S); advanceSim(b.sim, 400);
  const t0 = performance.now();
  advanceSim(a.sim, 400 + 30 * 24 * 3600 * 1000 / 66);   // thirty days of ticks
  const ms = performance.now() - t0;
  check(`a 30-day gap over 200 resting bodies is a jump (${ms.toFixed(1)}ms, was seconds)`, ms < 100);
  for (let t = 401; t <= 700; t++) advanceSim(b.sim, t);
  check("…and the jump is bit-identical to stepping (bodies unchanged, tick advanced)",
    JSON.stringify(a.sim.bodies) === JSON.stringify(b.sim.bodies) && a.sim.tick > b.sim.tick);
}

{ // PR #160 review — B4: eidosim@0.4.0 sweeps; eidosim@0.3.0 is carried, tunnelling and all
  const THIN = [[-0.1, 0, -0.1], [0.1, 0.2, 0.1]];
  const WALL = [[-0.05, 0, -2], [0.05, 2, 2]];
  const story = (sim: string, tickMs: number, body = THIN, wall = WALL): LogEntry[] => [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 10, "epoch", { sim, tickMs, boxes: { "b.glb": body, "w.glb": wall } }),
    // the wall stands BETWEEN two of 0.3's endpoints (1.31m apart at this
    // speed and tick): 3.94 → 5.25 straddles 4.55…4.65 with no overlap at
    // either end — the reviewer's discriminator, not a lucky straddle
    mk(2, 20, "spawn", { id: "wall", lib: "w.glb", pos: [4.6, 0, 0] }),
    mk(3, 30, "spawn", { id: "b", lib: "b.glb", pos: [0, 0, 0] }),
    mk(4, 500, "punt", { id: "b", dir: [1, 0.1, 0], power: 20 }),
  ];
  const v4 = fold(story(SIM_ID, 66)); advanceSim(v4.sim, 2000);
  check("0.4: a 0.2m body at 20 m/s meets a 0.1m wall (66ms tick) and rests on the near side",
    v4.sim.bodies.b.resting === true && v4.sim.bodies.b.p[0] + 0.1 <= 4.55 + 1e-9,
    `rest x ${v4.sim.bodies.b.p[0]}`);
  const coarse = fold(story(SIM_ID, 250, [[-0.5, 0, -0.5], [0.5, 1, 0.5]], [[-0.25, 0, -2], [0.25, 2, 2]])); advanceSim(coarse.sim, 2000);
  check("0.4: a 1m body at 20 m/s on a 250ms tick still meets a 0.5m wall",
    coarse.sim.bodies.b.resting === true && coarse.sim.bodies.b.p[0] + 0.5 <= 4.35 + 1e-9, `rest x ${coarse.sim.bodies.b.p[0]}`);
  const v3 = fold(story("eidosim@0.3.0", 66)); advanceSim(v3.sim, 2000);
  check("0.3.0 is CARRIED (not foreign) and still tunnels that wall — its law, pinned",
    !v3.sim.epoch!.foreign && v3.sim.bodies.b.resting === true && v3.sim.bodies.b.p[0] > 5, `rest x ${v3.sim.bodies.b.p[0]}`);
  // the sweep lands on tops too, and schedule-independence holds
  const DECK = [[-3, 0, -1], [3, 1, 1]];
  const land: LogEntry[] = [
    mk(0, 0, "genesis", { v: 3, dialect: "eidoverse-log" }),
    mk(1, 10, "epoch", { sim: SIM_ID, tickMs: 66, boxes: { "c.glb": [[-0.5, 0, -0.5], [0.5, 1, 0.5]], "d.glb": DECK } }),
    mk(2, 20, "spawn", { id: "deck", lib: "d.glb", pos: [5, 0, 0] }),
    mk(3, 30, "spawn", { id: "c", lib: "c.glb", pos: [0, 0, 0] }),
    mk(4, 500, "punt", { id: "c", dir: [1, 1, 0], power: 8 }),
  ];
  const l1 = fold(land); advanceSim(l1.sim, 900);
  const l2 = fold(land); for (let t = 1; t <= 900; t++) advanceSim(l2.sim, t);
  check("0.4: a flight landing on a deck rests ON it and names it",
    l1.sim.bodies.c.resting === true && l1.sim.bodies.c.p[1] === 1 && l1.sim.bodies.c.on === "deck", `y ${l1.sim.bodies.c.p[1]} on ${l1.sim.bodies.c.on}`);
  check("0.4 schedule-independence (swept law)", digest(l1.sim) === digest(l2.sim));
}

console.log(`\n${fail ? "\x1b[31mRED\x1b[0m" : "\x1b[32mGREEN\x1b[0m"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
