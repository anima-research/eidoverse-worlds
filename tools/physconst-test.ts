// tools/physconst-test.ts — C1 of PLAN-refactor-2026-10-12 (#8 constants, #14 rounding): the client's predicted throw entry
// and the authority's launch entry are the same bytes, and every reach/rounding number both sides use is ONE binding.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/physconst-test.ts
// A  byte-equal launch: for a few releases (a −0 in pos/q/v, the engine's speed cap, a throw with spin and occupants) the
//    entry client/lib/thingphysics.js planRelease predicts equals the body the authority logs: the engine folds the same
//    bits (DESIGN-physics-responsiveness §3). −0 counts: a predicted −0 and a logged 0 are different bytes to a hash.
// B  one binding: the files that used to carry their own copy of a reach or a rounding import shared/protocol/physconst.js
//    or shared/protocol/round.js, and no copy of the literal is back.
// @ts-nocheck
import "./protocol/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { request } from "../shared/protocol/authority.js";
import { openWorld } from "../server/filehost.ts";
import { ENGINES } from "../shared/protocol/simlayer.js";
import { grabOf } from "../shared/grab.js";
import { planLaunch } from "../shared/protocol/launchplan.js";
import { ENGINE, scratch } from "./protocol/common.ts";
import { labClock } from "./protocol/clock.ts";

let fails = 0, passes = 0;
function ok(cond, what, detail) { if (cond) passes++; else { fails++; console.log("FAIL", what, detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ""); } }

// ---------------- A: the predicted entry vs the logged entry ----------------
const root = scratch("physconst");
const clock = labClock();
const at = (ms) => { clock.advance(ms); };
const wire = (x) => JSON.parse(JSON.stringify(x));   // what the authority sees: a request after the socket (I-JSON has no −0)
function call(world, actor, verb, args = {}, step = 100) { at(step); return request(openWorld(root, world), actor, verb, wire(args)); }
const bytes = (x) => JSON.stringify(x, (_k, v) => (Object.is(v, -0) ? "-0" : v));   // −0 visible, so the compare is bit-for-bit
const launches = (world) => openWorld(root, world).entries.filter((e) => e.kind === "sim" && e.verb === "launch");

// the client's prediction, as client/lib/thingphysics.js planRelease builds it from the numbers it has locally (its pos
// and v already rounded to 3 dp, its q from THREE's normalize — any of them may carry a −0 that the wire drops)
const predicted = (id, pos, v, q, w, g, engine) => planLaunch({ id, p: pos, q, v, ...(w ? { w } : {}) }, g, ENGINES[engine]?.maxSpeed, "throw");
const r3 = (n) => Math.round(n * 1000) / 1000;

function playground(name) {
  for (const f of [`${name}.jsonl`, `${name}.presence.json`]) fs.rmSync(`${root}worlds/${f}`, { force: true });
  call(name, "rowan", "create-world", { title: name });
  call(name, "rowan", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
  call(name, "rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "inhabitant", throw: 2 } }, place: { at: [0, 0] } });
  call(name, "rowan", "create", { id: "tray", model: "crate", components: { physics: { kind: "dynamic" }, grabbable: { who: "inhabitant" } }, place: { at: [2, 0] } });
  call(name, "rowan", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "inhabitant" } }, place: { on: "tray" } });
  call(name, "rowan", "move", { to: [0, 0, -0.5] });
  return name;
}
const entryOf = (world) => { const e = launches(world).at(-1).body; return { id: e.id, p: e.p, q: e.q, v: e.v, ...(e.w ? { w: e.w } : {}) }; };
const same = (what, world, pred) => { const got = entryOf(world); const want = { id: pred.id, p: pred.p, q: pred.q, v: pred.v, ...(pred.w ? { w: pred.w } : {}) };
  ok(bytes(got) === bytes(want), `A ${what}: the predicted entry is the logged entry, byte for byte`, { predicted: bytes(want), logged: bytes(got) }); };
const g = (world, id) => grabOf(openWorld(root, world).state().entities[id].c);
const ENG = "eidosim@1.0.0";

{ // A1 a −0 in every field a release carries: the client rounds its own numbers (r3(−0) is −0), THREE normalizes a q
  const W = playground("pc-a1");
  ok(call(W, "rowan", "grab", { id: "ball" }).ok, "A1 grab");
  const pos = [-0, 1.1, 0.5].map(r3), v = [-0, 2, 3].map(r3), q = [-0, 0, -0, 1];
  const t = call(W, "rowan", "throw", { id: "ball", v, pos, q });
  ok(t.ok, "A1 throw accepted", t.refused ?? t);
  same("−0 in pos, q and v", W, predicted("ball", pos, v, q, null, g(W, "ball"), ENG));
}
{ // A2 the engine's speed cap and the grabbable's throw multiplier, with a spin
  const W = playground("pc-a2");
  ok(call(W, "rowan", "grab", { id: "ball" }).ok, "A2 grab");
  const pos = [0.1, 1.2, 0.4].map(r3), v = [3.333, 12.345, 9.876].map(r3), q = [0, 0.7071068, 0, 0.7071068], w = [0, -0, 6.28].map(r3);
  const t = call(W, "rowan", "throw", { id: "ball", v, pos, q, w });
  ok(t.ok, "A2 throw accepted", t.refused ?? t);
  ok(Math.hypot(...entryOf(W).v) <= ENGINES[ENG].maxSpeed + 1e-9, "A2 the logged speed is capped", entryOf(W).v);
  same("speed cap ×2 throw, spin", W, predicted("ball", pos, v, q, w, g(W, "ball"), ENG));
}
{ // A3 a thrown tray with an occupant: the tray's entry is still the prediction; the occupant's velocity (the authority's alone:
  // the client predicts only the thing in its hand) is the same bits a carrier reads back from the log
  const W = playground("pc-a3");
  call(W, "rowan", "move", { to: [2, 0, -0.5] });
  const gr = call(W, "rowan", "grab", { id: "tray" }); ok(gr.ok, "A3 grab the tray", gr.refused ?? gr);
  const pos = [2, 1.1, 0.3].map(r3), v = [-0, 1.5, 2.5].map(r3), q = [0, 0, 0, 1], w = [0, 0, 3].map(r3);
  const t = call(W, "rowan", "throw", { id: "tray", v, pos, q, w });
  ok(t.ok, "A3 throw accepted", t.refused ?? t);
  const L = launches(W); const tray = L.findLast((e) => e.body.id === "tray"), cup = L.findLast((e) => e.body.id === "cup");
  ok(!!tray && !!cup && cup.cause === tray.cause, "A3 the occupant flies under the same act", L.map((e) => [e.body.id, e.cause]));
  const tb = { id: tray.body.id, p: tray.body.p, q: tray.body.q, v: tray.body.v, w: tray.body.w }; const pr = predicted("tray", pos, v, q, w, g(W, "tray"), ENG);
  ok(bytes(tb) === bytes({ id: pr.id, p: pr.p, q: pr.q, v: pr.v, w: pr.w }), "A3 the tray's entry is the prediction", { predicted: bytes(pr), logged: bytes(tb) });
  ok(bytes(cup.body.v) === bytes(wire(cup.body.v)) && bytes(cup.body.p) === bytes(wire(cup.body.p)), "A3 the occupant's p and v are the bits a reader of the log folds (no −0, 3 dp)", { v: bytes(cup.body.v), p: bytes(cup.body.p) });
}

// ---------------- B: one binding ----------------
const src = (f) => fs.readFileSync(path.join(ENGINE, f), "utf8");
const NO = [ // [file, the import it must carry, the literal patterns that must not be back]
  ["shared/protocol/authority.js", /from "\.\/physconst\.js"/, [/\bREACH\s*=\s*[\d.]/, /\bHAND_Y\s*=\s*[\d.]/, /\bMAX_HELD\s*=\s*\d/, /\bKICK\s*=\s*\{/]],
  ["shared/protocol/authority.js", /from "\.\/round\.js"/, [/\bconst r3\s*=/, /\bnoNeg0\s*=\s*\(/, /\bunNegZero\s*=\s*\(/]],
  ["client/lib/thingphysics.js", /from '\.\.\/\.\.\/shared\/protocol\/physconst\.js'/, [/\bREACH\s*=\s*[\d.]/, /\bHAND_Y\s*=\s*[\d.]/, /\bKICK\s*=\s*\{/]],
  ["client/lib/thingphysics.js", /from '\.\.\/\.\.\/shared\/protocol\/round\.js'/, [/\bconst r3\s*=/]],
  ["client/lib/thingphysics.js", /planLaunch\(/, [/planVelocity\(/]],
  ["client/lib/useprompt.js", /from '\.\.\/\.\.\/shared\/protocol\/physconst\.js'/, [/\bUSE_REACH\s*=\s*[\d.]/]],
  ["client/lib/commands/handlers.js", /from '\.\.\/\.\.\/\.\.\/shared\/protocol\/physconst\.js'/, [/\bREACH\s*=\s*[\d.]/]],
  ["server/messages.ts", /from "\.\.\/shared\/protocol\/physconst\.js"/, [/\bBODY_RANGE[^=\n]*=\s*\{/]],
  ["shared/grab.js", /from '\.\/protocol\/physconst\.js'/, [/\bHAND_REACH\s*=\s*[\d.]/]],
  ["shared/protocol/launchplan.js", /from "\.\/round\.js"/, [/\bconst r3\s*=/]],
  ["shared/protocol/simlayer.js", /from "\.\/round\.js"/, [/Math\.round\(n \* 1000\) \/ 1000/, /Math\.round\(n \* 100\) \/ 100/]],
  ["shared/hierarchy.js", /from '\.\/protocol\/round\.js'/, [/\bconst r3\s*=/, /\bconst r9\s*=/, /toFixed\(4\)/]],
  ["tools/protocol/import-v1/translate-v1.js", /from "\.\.\/\.\.\/\.\.\/shared\/protocol\/round\.js"/, [/\bunNegZero\s*=\s*\(/]],
  ["mcpl/agent.ts", /from "\.\.\/shared\/protocol\/round\.js"/, [/\bconst r3\s*=/]],
  ["server/modelcatalogue.ts", /from "\.\.\/shared\/protocol\/round\.js"/, [/\bconst r3\s*=/]],
];
for (const [f, imp, lits] of NO) {
  const s = src(f);
  ok(imp.test(s), `B ${f} imports the shared binding (${imp})`);
  for (const re of lits) ok(!re.test(s), `B ${f} carries no copy of ${re}`, s.match(re)?.[0]);
}
{ // the shared values are the ones the design states, and the layered shove reaches stay distinct on purpose
  const P = await import("../shared/protocol/physconst.js"), R = await import("../shared/protocol/round.js");
  ok(P.REACH === 1.5 && P.HAND_Y === 1.1 && P.MAX_HELD === 2 && P.USE_REACH === 2.5, "B physconst values", P);
  ok(P.BODY_REACH === P.REACH + 0.5 && P.SHOVE_REACH === 2.5 && P.BODY_RANGE === null && P.bodyRangeOf?.({ range: 4 }) === 4 && P.bodyRangeOf?.(undefined) === null && P.bodyRangeOf?.({ range: -1 }) === null,
    "B shove reach: the authority's 2.0 and the client's 2.5, each named; the server's range is none unless a world sets body-default.range (R 10-28)", P);
  ok(P.KICK.reach === 1.6 && P.KICK.below === -0.5 && P.KICK.above === 2.0 && P.KICK.lift === 0.9, "B KICK", P.KICK);
  ok(Object.is(R.r3(1.0005), 1.001) && Object.is(R.r3(-0), -0) && Object.is(R.noNeg0(-0), 0) && Object.is(R.noNeg0(-1), -1) && R.r2(1.234) === 1.23, "B round.js helpers", R);
  ok(bytes(R.unNegZero({ a: [-0, { b: -0 }], c: -0 })) === bytes({ a: [0, { b: 0 }], c: 0 }), "B unNegZero scrubs nested", R.unNegZero({ a: [-0] }));
}

console.log(`physconst-test: ${passes} ok, ${fails} FAIL`);
process.exit(fails ? 1 : 0);
