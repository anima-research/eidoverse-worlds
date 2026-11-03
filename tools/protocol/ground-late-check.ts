// tools/protocol/ground-late-check.ts — a joiner whose heightmap grid arrives late (#260 review #144).
// The authority reads its grid from disk; a client fetches it, so for the first moments its sim stands on the noise fallback.
// When the grid lands the client's sim is rebuilt from its join cut and its entries since, so it agrees with the authority.
//   G1  the late joiner's canonical fold raises no disagreement with the authority's digest and rest
//   G2  …and its presentation flight rests bit for bit where the authority logs the rest
//   G3  a client that had the grid from the start agrees too (control)
//   G4  a terrain changed mid-session to a heightmap this client hasn't fetched yet: the same, from the change on
// usage: bun tools/protocol/ground-late-check.ts
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request } from "../../shared/protocol/authority.js";
import { readLog } from "../../shared/protocol/fold.js";
import { restsOf } from "../../shared/protocol/simlayer.js";
import { makeReplica, clientCutOf } from "../../shared/protocol/replica.js";
import { openLive } from "../../server/livehost.ts";
import { registerGrid, setGridLoader, shapeReady, shapeParams } from "../../shared/terrainshape.js";

const root = scratch("groundlate");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };

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
  const c = makeReplica(); c.adopt(JSON.parse(JSON.stringify({ ...clientCutOf(x.w), you: "vic" })));
  let from = x.L().length;
  if (late === "mid") ok(x.call("rowan", "set", { id: "@world", component: "terrain", value: TERRAIN2 }).ok, "(setup) the world's terrain moves to a new heightmap");
  const th = x.call("rowan", "throw", { id: "ball", v: [0, 1, 2] }, 100); ok(th.ok, "(setup) throw", th.refused);
  for (let i = 0; i < 5; i++) x.call("rowan", "say", { text: `tick ${i}` }, 30);   // still in the air: the sim advances on each entry's ts
  ok(!restsOf(x.L()).length, "(setup) the ball is still flying when the client has folded this far");
  c.ingest(x.L().slice(from), from); from = x.L().length;
  if (late) { clientHas.add(REF); clientHas.add(REF2); asClient(); }   // the fetch lands
  const t0 = x.at(); let jl = null; for (let t = 0; t < 200; t++) { const b = c.simAt(t0 + t * 33)?.bodies?.ball; if (b) jl = b; }   // frames, once the grid is here
  x.call("rowan", "wait", {}, 6000);
  c.ingest(x.L().slice(from), from);
  const rest = restsOf(x.L()).at(-1);
  return { c, rest, jl };
}

{
  const { c, rest, jl } = run(false);
  ok(rest && c.sim?.checks?.agree >= 1 && !c.sim.checks.disagree.length, "G3 a client with the grid from the start agrees with the authority (control)", { rest: rest?.at, checks: c.sim?.checks });
  ok(jl?.resting && JSON.stringify(jl.p) === JSON.stringify(rest?.at), "G3 …and rests where the authority does", [jl?.p, rest?.at]);
}
{
  const { c, rest, jl } = run(true);
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
