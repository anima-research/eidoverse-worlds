// @ts-nocheck
// tools/protocol/reset-check.ts — a reset button (reactions kind 'reset', the home component). R's ask, 2026-10-10.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/reset-check.ts
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold } from "../../shared/protocol/fold.js";
import { ENGINES, simFold } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";
const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) pass++; else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const root = scratch("reset"); let T = 1800000000000;
const tick = (ms = 1500) => { T += ms; process.env.PROTOCOL_NOW = String(T); };
const call = (w, a, v, args = {}) => { tick(); return request(openWorld(root, w), a, v, args); };
const st = (W) => fold(openWorld(root, W).entries);
const pos = (W, id) => st(W).entities[id]?.c.transform.pos;
const code = (r) => (r.ok ? "ok" : r.refused?.code);
const mk = (W) => { call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  for (const [id, x] of [["a", 0], ["b", 3]]) call(W, "rowan", "create", { id, model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [x, 0] } });
  call(W, "rowan", "create", { id: "dom", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [6, 0] } });
  call(W, "rowan", "create", { id: "btn", model: "crate", place: { at: [0, 4] } }); };
const button = (W, targets, extra = {}) => call(W, "rowan", "set", { id: "btn", component: "reactions", value: { reset: { kind: "reset", targets, ...extra } } });

{ const W = "stamp"; mk(W); const r = button(W, ["a", "b", "dom"]); const s = st(W);
  ok(r.ok && ["a", "b", "dom"].every((id) => JSON.stringify(s.entities[id].c.home?.pos) === JSON.stringify(s.entities[id].c.transform.pos)), "RS1 writing a reset handler stamps a home on each target that has none, where it stands", { r: code(r), homes: ["a", "b", "dom"].map((id) => s.entities[id].c.home) }); }
{ const W = "bad"; mk(W); const r1 = button(W, ["a", "nope"]), r2 = button(W, []), r3 = button(W, "a");
  ok(code(r1) === "not-found" && code(r2) === "shape" && code(r3) === "shape", "RS2 a reset naming a missing thing, none, or not a list is refused when written", [code(r1), code(r2), code(r3)]); }
{ const W = "use"; mk(W); button(W, ["a", "b", "dom"]);
  call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "a" }); call(W, "vic", "move", { to: [2, 0, -2] }); call(W, "vic", "put", { id: "a", at: [2, -2.6] });
  call(W, "rowan", "set", { id: "b", component: "transform", value: { pos: [9, 0, 9] } });
  call(W, "vic", "move", { to: [0, 0, 3.2] }); const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(r.ok && JSON.stringify(pos(W, "a")) === "[0,0,0]" && JSON.stringify(pos(W, "b")) === "[3,0,0]", "RS3 a VISITOR presses it: everything moved goes home (one put by a hand, one moved by an edit)", { r: code(r), why: r.refused?.reason, a: pos(W, "a"), b: pos(W, "b") }); }
{ const W = "held"; mk(W); button(W, ["a", "b"]); call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "a" }); call(W, "vic", "move", { to: [2, 0, 2.5] });
  const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(r.ok && !openWorld(root, W).presence.holds.a && JSON.stringify(pos(W, "a")) === "[0,0,0]", "RS4 a thing in someone's hand leaves the hand and goes home", { r: code(r), why: r.refused?.reason, held: Object.keys(openWorld(root, W).presence.holds), a: pos(W, "a") }); }
{ const W = "flying"; mk(W); button(W, ["a", "b"]); call(W, "rowan", "set", { id: "b", component: "transform", value: { pos: [9, 0, 9] } });
  call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "a" }); call(W, "vic", "throw", { id: "a", v: [0, 6, 4] });
  tick(300); const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(r.ok && JSON.stringify(pos(W, "b")) === "[3,0,0]" && r.notes?.some((n) => n.id === "a" && /in flight/.test(n.why)), "RS5 a thing in flight is skipped and named (the engine has it till it lands); the rest still go home", { r: code(r), why: r.refused?.reason, notes: r.notes, b: pos(W, "b") });
  tick(6000); const again = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(again.ok && JSON.stringify(pos(W, "a")) === "[0,0,0]", "RS5b …pressed again after it lands, it goes home", { r: code(again), why: again.refused?.reason, a: pos(W, "a") }); }
{ const W = "skip"; mk(W); button(W, ["a", "b"]); call(W, "rowan", "set", { id: "b", component: "transform", value: { pos: [9, 0, 9] } }); call(W, "rowan", "set", { id: "b", component: "lock", value: true });
  call(W, "rowan", "set", { id: "a", component: "transform", value: { pos: [4, 0, 4] } }); const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(r.ok && JSON.stringify(pos(W, "a")) === "[0,0,0]" && JSON.stringify(pos(W, "b")) === "[9,0,9]" && r.notes?.some((n) => n.id === "b" && n.reset === "skipped"), "RS6 a locked target is skipped and named; the rest still go home", { r: code(r), notes: r.notes, a: pos(W, "a"), b: pos(W, "b") }); }
{ const W = "home"; mk(W); button(W, ["a"]); call(W, "rowan", "set", { id: "a", component: "home", value: { pos: [1, 0, 5] } }); call(W, "rowan", "set", { id: "a", component: "transform", value: { pos: [7, 0, 7] } });
  const r = call(W, "vic", "use", { id: "btn", action: "reset" }); const bad = call(W, "rowan", "set", { id: "a", component: "home", value: { pos: [1, 0] } });
  ok(r.ok && JSON.stringify(pos(W, "a")) === "[1,0,5]" && code(bad) === "shape", "RS7 'set home here' is a write of home; a malformed home is refused", { r: code(r), a: pos(W, "a"), bad: code(bad) }); }
{ const W = "noop"; mk(W); button(W, ["a"]); const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(code(r) === "nothing-to-reset", "RS8 pressed with everything already home: says so (no empty change)", { r: code(r), why: r.refused?.reason });
  ok(r.refused?.reason === "everything is already home (its 1 target)" && r.refused?.fix === "there is nothing to send home: pressing again won't change that until one of them is moved", "RS8b …naming what it checked, and that pressing again won't change it", { why: r.refused?.reason, fix: r.refused?.fix }); }
{ const W = "noop2"; mk(W); button(W, ["a", "b"]); const r = call(W, "vic", "use", { id: "btn", action: "reset" });
  ok(code(r) === "nothing-to-reset" && r.refused?.reason === "everything is already home (all 2 targets)", "RS8c …and counts them when there are several", { r: code(r), why: r.refused?.reason }); }
{ const W = "scale"; mk(W); call(W, "rowan", "set", { id: "a", component: "transform", value: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [0.25, 0.25, 0.25] } }); button(W, ["a", "b"]);
  // the shape a settle leaves (R's gym, 10-10): b rests on a, parented to it at a local scale of 1 (0.25 in the world)
  call(W, "rowan", "set", { id: "b", component: "parent", value: { to: "a", order: "a0" } }); call(W, "rowan", "set", { id: "b", component: "transform", value: { pos: [0.5, 4, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  call(W, "rowan", "set", { id: "b", component: "home", value: { pos: [3, 0, 0], q: [0, 0, 0, 1] } });
  const r = call(W, "vic", "use", { id: "btn", action: "reset" }); const b = st(W).entities.b.c;
  ok(r.ok && !b.parent && JSON.stringify(b.transform.scale) === "[0.25,0.25,0.25]" && JSON.stringify(b.transform.pos) === "[3,0,0]", "RS9 a thing settled onto another (parented at a local scale of 1) goes home unparented at its size in the world, not 4x", { r: code(r), why: r.refused?.reason, b: b.transform, parent: b.parent }); }
// review of #260: pressed when every target is skipped, it doesn't say everything is home
{ const W = "allskip"; mk(W); button(W, ["b"]); call(W, "rowan", "set", { id: "b", component: "transform", value: { pos: [9, 0, 9] } }); call(W, "rowan", "set", { id: "b", component: "lock", value: true });
  const r = call(W, "vic", "use", { id: "btn", action: "reset" }); const why = String(r.refused?.reason);
  ok(code(r) === "nothing-to-reset" && !/already home/.test(why) && /b \(it is locked\)/.test(why) && !!r.refused?.fix, "RS10 every target skipped: says nothing was reset and why, not that everything is home, with a fix", { r: code(r), why, fix: r.refused?.fix }); }
// review of #260: a stored reset that names no targets (written before the gate checked it, or carried by a copy) says so
{ const W = "notargets"; mk(W); button(W, ["a"]);
  const file = `${root}worlds/${W}.jsonl`; const lines = fs.readFileSync(file, "utf8").split("\n");
  const k = lines.findLastIndex((l) => l.includes('"kind":"change"') && l.includes('"reactions"')); const e = JSON.parse(lines[k]);
  const op = [e.body, ...(e.body.ops ?? [])].find((o) => o.comp === "reactions" && o.value?.reset); op.value.reset.targets = [];
  lines[k] = JSON.stringify(e); fs.writeFileSync(file, lines.join("\n"));
  const r = call(W, "vic", "use", { id: "btn", action: "reset" }); const why = String(r.refused?.reason);
  ok(code(r) === "nothing-to-reset" && why === "btn's 'reset' names no targets, so there is nothing to send home" && r.refused?.fix === "someone who may edit it can give it targets (set its reactions); pressing again won't change that", "RS11 a reset naming no targets says so, not that everything is home, and that pressing again won't change it", { r: code(r), why, fix: r.refused?.fix }); }
console.log(`[reset-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
