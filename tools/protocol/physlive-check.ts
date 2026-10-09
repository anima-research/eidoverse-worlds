// tools/protocol/physlive-check.ts — physics as the RUNNING server holds it, and as a client folds it (design 20 on the client).
// phys-check.ts runs the authority over the lab catalogue's colliders (simFold's default MODELS); the live server passes
// simModels {} (geometry enters the sim only through the log, Covenant III), so a suite that only ever ran the lab
// configuration never saw what a real world does. usage: bun tools/protocol/physlive-check.ts
//   S   shapes: the authority stamps physics.shape (its own measurement) so a thrown thing flies in a live world; statics too
//   K   punt: the kick that physobj offered, as a door tool (reach, rights, locks, in the air, no physics)
//   R   release pose: throw/drop take the hand's pos (what a VR or desktop hand holds), checked for reach
//   Q   one clock per request: a rest's digest agrees with any carrier re-folding the log, even when the wall clock moves
//   F   the client's fold (shared/protocol/replica.js): adopt a cut (mid-flight too), fold the authority's entries, and its own
//       presentation flight comes to rest bit for bit where the authority logs the rest
// @ts-nocheck
import fs from "node:fs";
import { scratch } from "./common.ts";
import { request } from "../../shared/protocol/authority.js";
import { readLog, fold, opsOf } from "../../shared/protocol/fold.js";
import { simFold, restsOf } from "../../shared/protocol/simlayer.js";
import { makeReplica } from "../../shared/protocol/replica.js";
import { openLive } from "../../server/livehost.ts";
import { clientCutOf } from "../../shared/protocol/replica.js";

const root = scratch("physlive");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const code = (r: any) => r?.refused?.code;
let N = 0;
/** A live world (server/livehost.ts) as the server opens it: no simModels, so the lab catalogue's colliders don't count.
 *  clock: "pinned" moves only when the test steps it; "ticking" also advances 1 ms on every read (a real wall clock). */
function live(clock = "pinned") {
  const dir = `${root}w${++N}/`; fs.mkdirSync(dir, { recursive: true });
  let now = 1800000000000;
  const w = openLive(dir, `w${N}`, { now: () => (clock === "ticking" ? ++now : now), custodyFile: `${root}custody.json`, nameOf: () => null, kindOf: () => "human" });   // lab names are known people (roles:<key> asks the directory)
  const call = (actor, verb, args = {}, step = 100) => { now += step; return request(w, actor, verb, args); };
  const L = () => readLog(fs.readFileSync(dir + "world.jsonl"));
  // walk there the way the authority tracks a body: steps of at most 3.5 m, a second apart
  const walk = (actor, to) => { for (let i = 0; i < 40; i++) { const at = w.presence.bodies[actor]?.at; if (!at) return call(actor, "move", { to });
    const d = Math.hypot(to[0] - at[0], to[2] - at[2]); if (d < 1e-9) return { ok: true }; const k = Math.min(1, 3.5 / d);
    const r = call(actor, "move", { to: [at[0] + (to[0] - at[0]) * k, to[1], at[2] + (to[2] - at[2]) * k] }, 1000); if (!r.ok) return r; } };
  return { w, call, L, walk, at: () => now, step: (ms) => { now += ms; } };
}
const ENG = { engine: process.env.PHYS_ENGINE ?? "eidosim@0.5.0" };
const near = (a, b, e = 1e-9) => Array.isArray(a) && Array.isArray(b) && a.every((x, i) => Math.abs(x - b[i]) <= e);
function playground(clock = "pinned") {
  const x = live(clock); const { call } = x;
  call("rowan", "create-world", { title: "pg" });
  call("rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  call("rowan", "create", { id: "table-1", model: "table", place: { at: [0, 4] } });
  call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call("rowan", "move", { to: [0, 0, -0.5] });
  return x;
}

// ---- S: shapes ----
{
  const { call, w, L } = playground();
  const ph = w.state().entities.ball.c.physics;
  ok(Array.isArray(ph?.shape) && ph.shape.length === 2 && ph.kind === "dynamic", "S1 a dynamic thing gets the authority's measured shape", ph);
  const tb = w.state().entities["table-1"].c.physics;
  ok(tb?.kind === "static" && Array.isArray(tb.shape), "S2 a thing made in a world that runs physics is a static collider (shape stamped)", tb);
  ok(call("rowan", "grab", { id: "ball" }).ok && call("rowan", "throw", { id: "ball", v: [0, 2, 3] }).ok, "S3 grab and throw accepted");
  const mid = call("rowan", "look", {}, 300).things?.find((t) => t.id === "ball");
  ok(mid?.moving, "S4 mid-flight a read shows it moving (it flies in a live world)", mid);
  call("rowan", "wait", {}, 6000);
  const r = restsOf(L());
  ok(r.length === 1 && r[0].at[2] > 1 && r[0].at[2] < 4, "S5 the rest is logged, short of the table, on the ground", r);
  const v = simFold(L(), Date.now() + 1e9, { models: {} });
  ok(v.checks.agree >= 1 && !v.checks.disagree.length, "S6 a carrier (no catalogue, the log's shapes only) agrees with the rest", v.checks);
  // a model change re-stamps; physics written without a model has no shape (and a throw of it says why instead of silently not flying)
  call("rowan", "create", { id: "crate-9", model: "crate", components: { physics: { kind: "dynamic", shape: [[0, 0, 0], [9, 9, 9]] } }, place: { at: [3, 0] } });
  const c9 = w.state().entities["crate-9"].c.physics;
  ok(c9.shape && c9.shape[1][0] !== 9, "S7 a shape sent by the asker is replaced by the authority's measurement (Covenant III)", c9);
  const before = JSON.stringify(c9.shape);
  call("rowan", "set", { id: "crate-9", component: "model", value: "ball" });
  ok(JSON.stringify(w.state().entities["crate-9"].c.physics.shape) !== before, "S8 changing its model re-stamps its shape", w.state().entities["crate-9"].c.physics);
  call("rowan", "create", { id: "blob", components: { physics: { kind: "dynamic" } }, place: undefined });
  call("rowan", "move", { to: [0, 0, 0.6] });
  const gb = call("rowan", "grab", { id: "blob" });
  const tb2 = gb.ok ? call("rowan", "throw", { id: "blob", v: [0, 1, 1] }) : gb;
  ok(code(tb2) === "no-shape", "S9 throwing a thing with no measured shape is refused with a reason (it would never fly)", tb2);
  // a world that turns physics on stamps what was standing there before
  const y = live(); y.call("rowan", "create-world", { title: "late" });
  y.call("rowan", "create", { id: "crate-1", model: "crate", place: { at: [3, 3] } });
  y.call("rowan", "create", { id: "wall-1", model: "wall", place: { at: [0, 2] } });
  y.call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  y.call("rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  const st = y.w.state().entities;
  ok(st["crate-1"].c.physics?.kind === "static" && st["crate-1"].c.physics.shape && st.ball.c.physics.shape, "S10 turning physics on stamps every standing thing (statics static)", [st["crate-1"].c.physics, st.ball.c.physics]);
  // a static is a collider: thrown at the wall, the ball bounces back (doesn't pass through to the far side)
  y.call("rowan", "move", { to: [0, 0, -0.5] }); y.call("rowan", "grab", { id: "ball" });
  y.call("rowan", "throw", { id: "ball", v: [0, 0.5, 8] }); y.call("rowan", "wait", {}, 8000);
  const rb = restsOf(y.L()).at(-1);
  ok(rb && rb.at[2] < 2, "S11 a thrown ball meets the static wall (it doesn't pass through it)", rb);
}

// ---- K: punt ----
{
  const { call, w, L, walk } = playground();
  call("vic", "move", { to: [0, 0, -3] });
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
  ok(code(call("rowan", "punt", { id: "table-1" })) === "not-dynamic", "K1 a static thing can't be punted");
  ok(code(call("vic", "punt", { id: "ball" })) === "out-of-reach", "K2 punting needs the thing at your feet");
  const p = call("rowan", "punt", { id: "ball", power: 4 });
  ok(p.ok && p.flying === "ball", "K3 a punt launches the thing", p);
  const launch = L().filter((e) => e?.kind === "sim" && e.verb === "launch").at(-1);
  ok(launch && launch.body.v[2] > 0 && launch.body.v[1] > 0 && Math.abs(Math.hypot(...launch.body.v) - 4) < 1e-9, "K4 …through the thing from where you stand, with lift, at the power asked", launch?.body);
  ok(L().some((e) => e?.kind === "act" && e.verb === "punt"), "K5 the punt is an act on the record");
  const mid = call("rowan", "look", {}, 200).things?.find((t) => t.id === "ball");
  ok(mid?.moving, "K6 it flies", mid);
  // a volley: punting it again in the air re-launches from where it is now (the catch is logged)
  call("rowan", "move", { to: mid.moving.pos.map((n, i) => (i === 1 ? 0 : n)) });
  const v2 = call("rowan", "punt", { id: "ball", v: [0, 3, -2] }, 10);
  ok(v2.ok, "K7 a thing in the air can be punted again (a volley)", v2);
  const tail = L().slice(-3).map((e) => [e.kind, e.verb]);
  ok(JSON.stringify(tail) === JSON.stringify([["act", "punt"], ["sim", "catch"], ["sim", "launch"]]), "K8 …logged as a catch and a new launch", tail);
  call("rowan", "wait", {}, 8000);
  const v = simFold(L(), Date.now() + 1e9, { models: {} });
  ok(restsOf(L()).length === 1 && v.checks.agree === 1 && !v.checks.disagree.length, "K9 one rest (the volley's), and a carrier agrees", [restsOf(L()), v.checks]);
  // rights and locks, as grab's
  call("rowan", "set", { id: "ball", component: "physics", value: { kind: "dynamic", who: "builder" } });
  const at = w.state().entities.ball.c.transform.pos;
  walk("vic", [at[0], 0, at[2] - 0.5]);
  ok(code(call("vic", "punt", { id: "ball" })) === "rights", "K10 physics.who binds a punt like a grab");
  call("rowan", "set", { id: "ball", component: "lock", value: true });
  walk("rowan", [at[0], 0, at[2] - 0.5]);
  ok(code(call("rowan", "punt", { id: "ball" })) === "locked", "K11 a locked thing can't be punted");
  call("rowan", "delete", { id: "ball", component: "lock" });
  ok(code(call("rowan", "punt", { id: "ball", v: [0, 0, 99], power: 2 })) === "shape", "K12 v or power, not both");
  const capped = call("rowan", "punt", { id: "ball", v: [0, 0, 99] });
  ok(capped.ok && capped.notes?.some((n) => n.field === "v"), "K13 a punt is capped at the engine's top speed, and says so", capped);
  // someone else's hand: a held thing isn't punted out of it
  call("rowan", "wait", {}, 9000);
  const b2 = w.state().entities.ball.c.transform.pos; walk("rowan", [b2[0], 0, b2[2] - 0.5]);
  const g14 = call("rowan", "grab", { id: "ball" }); ok(g14.ok, "K14 rowan holds it", g14);
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "builder" } });
  walk("vic", [b2[0], 0, b2[2] - 0.6]);
  ok(code(call("vic", "punt", { id: "ball" })) === "held", "K15 a held thing can't be punted out of someone's hand (grab it: latest grab wins)");
  // the gates hold in the air too (a volley skips the write check a resting punt gets: L6, nothing writes in flight)
  call("rowan", "put", { id: "ball" }, 100);
  const b3 = w.state().entities.ball.c.transform.pos;
  walk("rowan", [b3[0], 0, b3[2] - 0.4]); walk("vic", [b3[0] + 0.4, 0, b3[2]]);
  call("rowan", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
  ok(call("rowan", "punt", { id: "ball", v: [0, 3, 0] }).ok, "K16 rowan pops it straight up");
  ok(code(call("vic", "punt", { id: "ball" }, 20)) === "rights", "K17 a visitor can't volley a builder's ball in the air either (physics.who)");
  // a lock on what it rests on binds a punt, as it binds a grab
  call("rowan", "create", { id: "tb2", model: "table", place: { at: [6, 6] } });
  call("rowan", "create", { id: "b2", model: "ball", components: { physics: { kind: "dynamic" } }, place: { on: "tb2" } });
  call("rowan", "set", { id: "tb2", component: "lock", value: true });
  walk("rowan", [6, 0, 5.5]);
  ok(code(call("rowan", "punt", { id: "b2" })) === "locked", "K18 a thing resting on (attached to) a locked thing can't be punted off it");
  // no physics: refused with the reason
  const z = live(); z.call("rowan", "create-world", { title: "still" });
  z.call("rowan", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  z.call("rowan", "move", { to: [0, 0, -0.5] });
  ok(code(z.call("rowan", "punt", { id: "ball" })) === "no-physics", "K19 with no physics running, a punt is refused (nothing flies)");
}

// ---- R: release pose ----
{
  const { call, L } = playground();
  call("rowan", "grab", { id: "ball" });
  ok(code(call("rowan", "throw", { id: "ball", v: [0, 1, 1], pos: [0, 1.1, 5] })) === "out-of-reach", "R1 a release pose beyond your reach is refused");
  const t = call("rowan", "throw", { id: "ball", v: [0, 1, 1], pos: [0.3, 1.3, -0.2] });
  const launch = L().filter((e) => e?.kind === "sim" && e.verb === "launch").at(-1);
  ok(t.ok && JSON.stringify(launch.body.p) === JSON.stringify([0.3, 1.3, -0.2]), "R2 a throw launches from the hand's pos as sent", [t, launch?.body.p]);
  call("rowan", "wait", {}, 6000);
  call("rowan", "move", { to: restsOf(L()).at(-1).at.map((n, i) => (i === 1 ? 0 : i === 2 ? n - 0.5 : n)) }, 2000);
  call("rowan", "grab", { id: "ball" });
  const d = call("rowan", "drop", { id: "ball", pos: [0.2, 1.0, restsOf(L()).at(-1).at[2] - 0.3] });
  const l2 = L().filter((e) => e?.kind === "sim" && e.verb === "launch").at(-1);
  ok(d.ok && l2.body.p[1] === 1.0 && l2.body.v.every((n) => n === 0), "R3 drop takes a pos too", [d, l2?.body]);
}

// ---- W: a tracked body's steps are presence, refused or not ----
{
  const { call, L } = playground();
  call("rowan", "create", { id: "wall-w", model: "wall", place: { at: [0, 1.5] } });
  const n0 = L().length;
  { const r = call("rowan", "move", { to: [0, 0, 10] }); ok(code(r) === "too-fast", "W1 a step too far is refused", r); }
  { const r = call("rowan", "move", { to: [0, 0, 3] }); ok(code(r) === "solid", "W2 a step through the table is refused", r); }
  ok(L().length === n0, "W3 …and neither refusal is written to the log (a person's client sends steps several times a second)", L().slice(n0).map((e) => [e.kind, e.verb, e.body?.refused]));
  const x = live(); x.call("rowan", "create-world", { title: "w" }); x.call("rowan", "create", { id: "wall", model: "wall", place: { at: [0, 0] } });
  const n1 = x.L().length;
  ok(code(x.call("rowan", "move", { to: [0, 0, 0] })) === "solid" && x.L().length === n1, "W4 a refused ARRIVAL isn't on the record either (a body's track is presence; review 10-06 S0-3)", x.L().slice(n1).map((e) => [e.kind, e.verb]));
}

// ---- Q: one clock per request ----
{
  const { call, L } = playground("ticking");
  call("rowan", "grab", { id: "ball" }); call("rowan", "throw", { id: "ball", v: [0.4, 2.5, 3] });
  for (let i = 0; i < 40; i++) call("rowan", "look", {}, 97);
  const v = simFold(L(), Date.now() + 1e9, { models: {} });
  ok(restsOf(L()).length === 1 && !v.checks.disagree.length && v.checks.agree === 1, "Q1 with a wall clock that moves during a request, a carrier re-folding the log agrees with the authority's digest and rest", v.checks);
  const LL = L(); const one = LL.map((e, i) => [e, i]).filter(([e]) => e?.kind === "sim" && e.verb === "digest").map(([e, i]) => [e.ts, LL[i + 1]?.ts]);
  ok(one.every(([a, b]) => a === b), "Q2 a digest and its rest carry one timestamp (the request's)", one);
}

// ---- F: the client's fold ----
{
  // a world, a cut taken mid-flight (as the server's clientCut would be), then the authority's later entries folded in
  const { call, w, L, at } = playground("ticking");
  call("rowan", "grab", { id: "ball" }); call("rowan", "throw", { id: "ball", v: [0.3, 3, 2.5] });
  const pre = call("rowan", "look", {}, 120);
  const cut = clientCutOf(w);
  ok(cut.sim && cut.sim.launched?.ball && Object.keys(cut.sim.launches ?? {}).length === 1, "F1 a mid-flight cut carries the sim's state and the launch in flight", cut.sim && { launched: cut.sim.launched, launches: cut.launches });
  const c = makeReplica(); c.adopt(JSON.parse(JSON.stringify({ ...cut, you: "vic" }))); // as it crosses the wire
  // a second client that joined before the throw (it folds the launch itself)
  const x = playground("ticking"); x.call("rowan", "grab", { id: "ball" });
  const early = makeReplica(); early.adopt(JSON.parse(JSON.stringify({ ...clientCutOf(x.w), you: "vic" })));
  const from = x.L().length; x.call("rowan", "throw", { id: "ball", v: [0.3, 3, 2.5] }, 100);
  early.ingest(x.L().slice(from), from);
  // presentation: each client advances its OWN copy of the sim to a display time, never its canonical fold
  const flown = []; let last = null;
  for (let t = 0; t < 120; t++) { const p = early.simAt?.(x.at() + t * 33); const b = p?.bodies?.ball; if (b) { flown.push(b.p.slice()); last = b; } }
  ok(flown.length > 10 && new Set(flown.map((q) => q.join())).size > 5, "F2 the client's presentation flies the thing (its position changes frame to frame)", flown.slice(0, 4));
  ok(last?.resting, "F3 …and it comes to rest", last);
  const from2 = x.L().length; x.call("rowan", "wait", {}, 6000); early.ingest(x.L().slice(from2), from2);
  const restX = restsOf(x.L()).at(-1);
  ok(restX && JSON.stringify(last.p) === JSON.stringify(restX.at), "F4 the client's flight rests bit for bit where the authority logs the rest", [last?.p, restX?.at]);
  ok(early.sim?.checks?.agree === 1 && !early.sim.checks.disagree.length, "F5 the client's canonical fold agrees with the authority's digest and rest (L3)", early.sim?.checks);
  // the mid-flight joiner
  const from3 = L().length - 0; const before = L().length;
  call("rowan", "wait", {}, 6000);
  const rest = restsOf(L()).at(-1);
  let jl = null; for (let t = 0; t < 400; t++) { const b = c.simAt?.(at() - 6000 + t * 33)?.bodies?.ball; if (b) jl = b; }
  ok(jl?.resting && JSON.stringify(jl.p) === JSON.stringify(rest?.at), "F6 a client that joined mid-flight flies the rest of it and rests bit for bit where the authority does", [jl?.p, rest?.at]);
  c.ingest(L().slice(before), before);
  ok(c.sim?.checks && !c.sim.checks.disagree.length, "F7 …and its canonical fold (from the cut) raises no disagreement", c.sim?.checks);
  ok(JSON.stringify(c.st?.entities?.ball?.c.transform.pos) === JSON.stringify(rest?.at), "F8 …and its state holds the logged rest", c.st.entities.ball.c.transform);
  // the display clock never feeds the canonical fold: asking for a far-future frame doesn't change what a later entry does
  const y = playground("pinned"); y.call("rowan", "grab", { id: "ball" });
  const cl = makeReplica(); cl.adopt(JSON.parse(JSON.stringify({ ...clientCutOf(y.w), you: "vic" })));
  cl.simAt?.(y.at() + 60000); // a client whose clock runs a minute fast
  const f4 = y.L().length; y.call("rowan", "throw", { id: "ball", v: [0, 2, 2] }); y.call("rowan", "wait", {}, 6000); cl.ingest(y.L().slice(f4), f4);
  ok(cl.sim?.checks?.agree === 1 && !cl.sim.checks.disagree.length, "F9 a client with a fast clock still agrees (presentation never advances the canonical fold)", cl.sim.checks);
}

console.log(`\n${fail ? `FAIL ${fail}` : "ok"}: ${pass} passed${fail ? `, ${fail} failed` : ""}`);
process.exit(fail ? 1 : 0);
