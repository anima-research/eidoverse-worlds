// @ts-nocheck
// tools/protocol/hands-check.ts — what is in a hand, and where a put lands (R's desktop test, 2026-10-10: crates hovering
// after a put, five crates carried at once, a held barrel moved in edit mode and then stuck).
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/hands-check.ts
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold } from "../../shared/protocol/fold.js";
import { ENGINES, simFold } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";
import { labClock } from "./clock.ts";
const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) pass++; else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const root = scratch("hands"); const clock = labClock();
const call = (w, a, v, args = {}) => { clock.advance(1500); return request(openWorld(root, w), a, v, args); };
const pos = (W, id) => fold(openWorld(root, W).entries).entities[id]?.c.transform.pos;
const held = (W) => Object.keys(openWorld(root, W).presence.holds);
const code = (r) => (r.ok ? "ok" : r.refused?.code);
// a (at x=0), b (x=3), c (x=1.5): 0.5 m crates, 0.6 tall, loose; physics on unless asked
const mk = (W, physics = true) => { call(W, "rowan", "create-world", { title: W }); if (physics) call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  for (const [id, x] of [["a", 0], ["b", 3], ["c", 1.5]]) call(W, "rowan", "create", { id, model: "crate", components: { ...(physics ? { physics: { kind: "dynamic", who: "member" } } : { grabbable: { who: "member" } }) }, place: { at: [x, 0] } }); };
const take = (W, id, x) => { call(W, "vic", "move", { to: [x, 0, -0.8] }); return call(W, "vic", "grab", { id }); };

{ const W = "ghost"; mk(W); take(W, "a", 0); take(W, "b", 3); call(W, "vic", "move", { to: [0.4, 0, -0.8] });
  const r = call(W, "vic", "put", { id: "b", at: [0, 0] });
  ok(r.ok && pos(W, "b")[1] === 0, "H1 holding a and b, b put down where a used to stand lands on the FLOOR (a is in my hand, not there)", { r: code(r), b: pos(W, "b") }); }
{ const W = "ghost-hand"; mk(W); take(W, "a", 0); take(W, "b", 3); call(W, "vic", "move", { to: [0, 0, 0] });
  const r = call(W, "vic", "put", { id: "b" });
  ok(r.ok && pos(W, "b")[1] === 0, "H2 …and the same with no `at` (straight down from the hand)", { r: code(r), b: pos(W, "b") }); }
{ const W = "sliver"; mk(W); take(W, "b", 3); call(W, "vic", "move", { to: [1.2, 0, -0.8] }); call(W, "vic", "move", { to: [0.6, 0, -0.7] });
  const r = call(W, "vic", "put", { id: "b", at: [0.48, 0] }); clock.advance(6000);
  const w = openWorld(root, W); const p = simFold(w.entries, w.now())?.sim?.bodies?.b?.p ?? pos(W, "b");
  ok(r.ok && p[1] < 0.45 && held(W).length === 0, "H3 put down with a sliver of it over a neighbour: it does not perch on the neighbour's top (0.6 up) over thin air; physics lets it fall beside", { r: code(r), flying: r.flying, p }); }
{ const W = "sliver-still"; mk(W, false); take(W, "b", 3); call(W, "vic", "move", { to: [1.2, 0, -0.8] }); call(W, "vic", "move", { to: [0.6, 0, -0.7] });
  const r = call(W, "vic", "put", { id: "b", at: [0.48, 0] });
  ok(!r.ok && r.refused.code === "implausible" && held(W).includes("b"), "H4 …with no physics in the world it is refused (it would overlap), and stays in my hand", { r: code(r), held: held(W) }); }
{ const W = "onto"; mk(W); take(W, "b", 3); call(W, "vic", "move", { to: [1.2, 0, -0.8] }); call(W, "vic", "move", { to: [0, 0, -0.8] });
  const r = call(W, "vic", "put", { id: "b", at: [0.05, 0] });
  ok(r.ok && Math.abs(pos(W, "b")[1] - 0.6) < 1e-6, "H5 put down squarely over a crate: it rests on top (the control)", { r: code(r), b: pos(W, "b") }); }
{ const W = "edit"; mk(W); take(W, "a", 0);
  const e = call(W, "rowan", "set", { id: "a", component: "transform", value: { pos: [8, 0, 8] } }); const t = call(W, "vic", "throw", { id: "a", v: [0, 2, 3] });
  ok(e.ok && held(W).length === 0 && code(t) === "not-holding" && pos(W, "a")[0] === 8 && e.notes?.some((n) => n.tookFromHand), "H6 an edit that moves a thing in someone's hand takes it out of the hand (and says so): it is where the edit put it", { e: code(e), notes: e.notes, t: code(t), held: held(W), a: pos(W, "a") }); }
// H6b: a dry run of that edit says so too, and leaves the hand as it is
{ const W = "edit-dry"; mk(W); take(W, "a", 0);
  const e = call(W, "rowan", "set", { id: "a", component: "transform", value: { pos: [8, 0, 8] }, dry: true });
  ok(e.ok && e.dry && held(W).includes("a") && e.notes?.some((n) => n.id === "a" && n.tookFromHand === "vic"), "H6b a dry run of an edit that moves a held thing says it would leave the hand, and leaves it there", { e: code(e), notes: e.notes, held: held(W) }); }
// H6c: …and a dry switch-off of what a held thing hangs under says the held thing would leave the hand, and leaves it there
{ const W = "edit-dry-under"; mk(W); call(W, "rowan", "create", { id: "top", model: "crate", components: { grabbable: { who: "member" } }, place: { on: "b" } });
  call(W, "vic", "move", { to: [3, 0, -0.8] }); const g = call(W, "vic", "grab", { id: "top" });
  const e = call(W, "rowan", "set", { id: "b", component: "disabled", value: true, dry: true });
  ok(g.ok && e.ok && e.dry && held(W).includes("top") && (e.notes ?? []).filter((n) => n.id === "top" && n.tookFromHand === "vic").length === 1,
    "H6c a dry switch-off of what a held thing hangs under says it would leave the hand, once, and leaves it there", { g: code(g), e: code(e), notes: e.notes, held: held(W) }); }
// H6d: an edit that writes a held thing's parent and its transform together takes it out of the hand once
{ const W = "edit-twice"; mk(W); take(W, "a", 0);
  const e = call(W, "rowan", "batch", { ops: [{ verb: "set", args: { id: "a", component: "parent", value: { to: "b" } } },
    { verb: "set", args: { id: "a", component: "transform", value: { pos: [0, 0.6, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }] });
  ok(e.ok && held(W).length === 0 && (e.notes ?? []).filter((n) => n.id === "a" && n.tookFromHand).length === 1,
    "H6d an edit writing a held thing's parent and transform together takes it from the hand once, with one note", { e: code(e), notes: e.notes, held: held(W) }); }
// H6e: removing what a held thing hangs under removes the held thing too, and empties the hand (a hand left holding a thing
// that's gone would count toward what it may hold)
{ const W = "edit-gone-under"; mk(W); call(W, "rowan", "create", { id: "top", model: "crate", components: { grabbable: { who: "member" } }, place: { on: "b" } });
  call(W, "vic", "move", { to: [3, 0, -0.8] }); const g = call(W, "vic", "grab", { id: "top" });
  const e = call(W, "rowan", "delete", { id: "b" }); const gone = !fold(openWorld(root, W).entries).entities.top;
  ok(g.ok && e.ok && gone && !held(W).includes("top") && (e.notes ?? []).filter((n) => n.id === "top" && n.tookFromHand === "vic").length === 1,
    "H6e removing what a held thing hangs under empties the hand that held it, once, and says so", { g: code(g), e: code(e), gone, notes: e.notes, held: held(W) }); }
{ const W = "edit-other"; mk(W); take(W, "a", 0);
  const e = call(W, "rowan", "set", { id: "a", component: "label", value: "A" });
  ok(e.ok && held(W).includes("a"), "H7 …an edit of something else about it (its label) leaves it in the hand", { e: code(e), held: held(W) }); }
{ const W = "two"; mk(W); const r = [take(W, "a", 0), take(W, "b", 3), take(W, "c", 1.5)].map(code);
  const p = call(W, "vic", "put", { id: "b", at: [1.5, -1.4] }); const again = call(W, "vic", "grab", { id: "c" });
  ok(r.join() === "ok,ok,hold-limit" && p.ok && again.ok, "H8 two hands: a third thing is refused (hold-limit) until one is put down", { r, put: code(p), again: code(again) }); }
console.log(`[hands-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
