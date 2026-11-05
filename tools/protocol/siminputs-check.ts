// tools/protocol/siminputs-check.ts — what the sim reads that isn't in the log (shared/protocol/siminputs.js, #260 review #144).
//   I   the guard: the sim's import closure is pinned here, and only a module SIM_INPUTS names may read outside data, so a new
//       outside input (a mesh collider from a GLB, say) can't enter the sim without joining the list the replica waits on
//   G   a client that lacks an input refolds once it lands: the authority reads its heightmap from disk, a client fetches it
//       G1/G2 late at join, G3 control (held from the start), G4 a terrain changed mid-session to one not yet fetched
// usage: bun tools/protocol/siminputs-check.ts
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request } from "../../shared/protocol/authority.js";
import { readLog } from "../../shared/protocol/fold.js";
import { restsOf } from "../../shared/protocol/simlayer.js";
import { makeReplica, clientSnapshotOf } from "../../shared/protocol/replica.js";
import { openLive } from "./labhost.ts";
import { registerGrid, setGridLoader, shapeReady, shapeParams } from "../../shared/terrainshape.js";
import { SIM_INPUTS } from "../../shared/protocol/siminputs.js";
import { ENGINE } from "./common.ts";
import path from "node:path";

const root = scratch("siminputs");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

// ---- I: the guard ----
// every module the sim imports, from its two entries (the engine adapter and the layer beside the fold)
const ENTRIES = ["shared/sim.js", "shared/protocol/simlayer.js"];
const CLOSURE = [
  "shared/eidosim.js", "shared/mover.js", "shared/protocol/features.js", "shared/protocol/fold.js", "shared/protocol/hash.js",
  "shared/protocol/provenance.js", "shared/protocol/round.js", "shared/protocol/shapes.js", "shared/protocol/simlayer.js", "shared/rot.js", "shared/scale3.js",
  "shared/sha256.js", "shared/sim.js", "shared/simmath.js", "shared/terrainmath.js", "shared/terrainshape.js",
];
const OUTSIDE = /export function set\w*(?:Loader|Fetcher|Source)\b|\bfetch\s*\(|readFileSync|readFile\s*\(|XMLHttpRequest|localStorage|indexedDB|\bimport\s*\(/;
const importsOf = (src) => [...src.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']/gm)].map((m) => m[1] ?? m[2]);
function closureOf(entries) {
  const seen = new Set(), todo = [...entries];
  while (todo.length) { const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
    for (const sp of importsOf(fs.readFileSync(ENGINE + f, "utf8"))) seen.has(sp) || todo.push(sp.startsWith(".") ? path.posix.normalize(path.posix.join(path.posix.dirname(f), sp)) : `bare:${sp}`); }
  return [...seen].sort();
}
{
  const got = closureOf(ENTRIES), want = [...CLOSURE].sort();
  ok(JSON.stringify(got) === JSON.stringify(want), "I1 the sim's import closure is the pinned one (a new module joins it here, after asking whether it reads outside the log)",
    { added: got.filter((f) => !want.includes(f)), gone: want.filter((f) => !got.includes(f)) });
  const inputs = new Set(Object.values(SIM_INPUTS).map((i) => i.module));
  const readers = got.filter((f) => !f.startsWith("bare:") && !inputs.has(f) && OUTSIDE.test(fs.readFileSync(ENGINE + f, "utf8")));
  ok(!readers.length, "I2 only a module SIM_INPUTS names reads outside data", readers);   // a named module is exempt whole, not per read site
  ok([...inputs].every((m) => got.includes(m)), "I3 every SIM_INPUTS module is one the sim imports", [...inputs]);
}

// ---- G: a late input ----
// a flat grid 3 m below the noise fallback (amplitude 0 → y = 0), so standing on the wrong ground is plain
const REF = "store/heightmaps/00000000000000c1.json";
const GRID = { w: 2, h: 2, data: new Uint16Array([0, 0, 0, 0]) };
// One process plays both sides. The authority reads REF from its disk (a loader, installed only while it answers);
// the client has it only once its fetch lands. The cache keeps the newest 8 grids, so registering 8 others takes REF
// back off "the client's machine" after every authority call.
const evict = () => { for (let i = 0; i < 8; i++) registerGrid(`store/heightmaps/${(0xd0 + i).toString(16).padStart(16, "0")}.json`, GRID); };
let clientHas = new Set();
const asClient = () => { evict(); for (const r of clientHas) registerGrid(r, GRID); };
const TERRAIN = { kind: "noise", seed: 1, size: 40, amplitude: 0, heightmap: { grid: REF, min: -3, max: -2 } };
const REF2 = "store/heightmaps/00000000000000c2.json";
const TERRAIN2 = { ...TERRAIN, heightmap: { grid: REF2, min: -4, max: -3.5 } };

let N = 0;
function world() {
  const dir = `${root}w${++N}/`; fs.mkdirSync(dir, { recursive: true });
  let now = 1800000000000;
  const w = openLive(dir, `w${N}`, { now: () => ++now, custodyFile: `${root}custody.json`, nameOf: () => null, kindOf: () => "human" });
  const call = (actor, verb, args = {}, step = 100) => { now += step; setGridLoader((ref) => (ref === REF || ref === REF2 ? GRID : null));
    try { return request(w, actor, verb, args); } finally { setGridLoader(null); asClient(); } };
  const L = () => readLog(fs.readFileSync(dir + "world.jsonl"));
  call("rowan", "create-world", { title: "gl" });
  call("rowan", "set", { id: "@world", component: "physics-engine", value: { engine: process.env.PHYS_ENGINE ?? "eidosim@1.0.0" } });
  const t = call("rowan", "set", { id: "@world", component: "terrain", value: TERRAIN });
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
  call("rowan", "move", { to: [0, -3, -0.5] });
  return { w, call, L, t, at: () => now };
}

// one run: join, throw, fold the flight in pieces. late: the grid is missing until part-way through the flight;
// "mid": the client has the join's grid, and the world moves to one it hasn't fetched yet
function run(late) {
  clientHas = new Set(late === true ? [] : [REF]);
  const x = world();
  ok(x.t.ok, `(setup${late ? ", late" : ""}) heightmap terrain is accepted`, x.t.refused);
  const g = x.call("rowan", "grab", { id: "ball" }); ok(g.ok, "(setup) grab", g.refused);
  ok(late !== true || !shapeReady(shapeParams(TERRAIN)), "(setup) the late client has no grid at join");
  const c = makeReplica(); c.adopt(JSON.parse(JSON.stringify({ ...clientSnapshotOf(x.w), you: "vic" })));
  let from = x.L().length;
  if (late === "mid") ok(x.call("rowan", "set", { id: "@world", component: "terrain", value: TERRAIN2 }).ok, "(setup) the world's terrain moves to a new heightmap");
  const th = x.call("rowan", "throw", { id: "ball", v: [0, 1, 2] }, 100); ok(th.ok, "(setup) throw", th.refused);
  for (let i = 0; i < 5; i++) x.call("rowan", "say", { text: `tick ${i}` }, 30);   // still in the air: the sim advances on each entry's ts
  ok(!restsOf(x.L()).length, "(setup) the ball is still flying when the client has folded this far");
  c.ingest(x.L().slice(from), from); from = x.L().length;
  if (late) { clientHas.add(REF); clientHas.add(REF2); asClient(); }   // the fetch lands
  // the browser's drawFlights clones c.sim itself and never calls simAt: settleInputs alone must refold once the grid is here
  const v0 = c.simVersion, settled = late ? (typeof c.settleInputs === "function" && (c.settleInputs(), c.simVersion > v0 && !!c.sim?.sim)) : null;
  const t0 = x.at(); let jl = null; for (let t = 0; t < 200; t++) { const b = c.simAt(t0 + t * 33)?.bodies?.ball; if (b) jl = b; }   // frames, once the grid is here
  x.call("rowan", "wait", {}, 6000);
  c.ingest(x.L().slice(from), from);
  const rest = restsOf(x.L()).at(-1);
  return { c, rest, jl, settled };
}

{
  const { c, rest, jl } = run(false);
  ok(rest && c.sim?.checks?.agree >= 1 && !c.sim.checks.disagree.length, "G3 a client with the grid from the start agrees with the authority (control)", { rest: rest?.at, checks: c.sim?.checks });
  ok(jl?.resting && JSON.stringify(jl.p) === JSON.stringify(rest?.at), "G3 …and rests where the authority does", [jl?.p, rest?.at]);
}
{
  const { c, rest, jl, settled } = run(true);
  ok(settled === true, "G1a settleInputs alone (no simAt: the browser's path) refolds the canonical sim once the grid lands", { settled });
  ok(rest && c.sim?.checks && !c.sim.checks.disagree.length, "G1 a client whose grid arrived late raises no disagreement once it lands", { rest: rest?.at, checks: c.sim?.checks });
  ok(jl?.resting && JSON.stringify(jl.p) === JSON.stringify(rest?.at), "G2 …and its flight rests bit for bit where the authority's does", [jl?.p, rest?.at]);
}

{
  const { c, rest, jl } = run("mid");
  ok(rest && c.sim?.checks && !c.sim.checks.disagree.length, "G4 a terrain changed mid-session to an unfetched heightmap: no disagreement once its grid lands", { rest: rest?.at, checks: c.sim?.checks });
  ok(jl?.resting && JSON.stringify(jl.p) === JSON.stringify(rest?.at), "G4 …and the flight rests where the authority's does", [jl?.p, rest?.at]);
}

console.log(`\n${fail ? `FAIL ${fail}` : "ok"}: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
