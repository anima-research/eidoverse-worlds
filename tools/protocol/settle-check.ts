// @ts-nocheck
// tools/protocol/settle-check.ts — what a thing at rest is attached to (settleSim). R's gym, 10-10: a pyramid's top crate
// over the gap between two crates was parented to the crate a row lower (read under its centre), and rode along 0.5 m
// above it when that one was carried.   Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/settle-check.ts
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold } from "../../shared/protocol/fold.js";
import { ENGINES, restsOf } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";
const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) pass++; else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const root = scratch("settle"); let T = 1800000000000;
const call = (W, a, v, args = {}) => { T += 1500; process.env.PROTOCOL_NOW = String(T); return request(openWorld(root, W), a, v, args); };
const st = (W) => fold(openWorld(root, W).entries);
const box = (W, id, pos, scale = [1, 1, 1]) => call(W, "rowan", "create", { id, model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, transform: { pos, q: [0, 0, 0, 1], scale } } });
{ const W = "gap"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  // a low slab under the gap, two crates either side of it, and a crate across the two (the test crate is 0.6 m)
  const made = [box(W, "slab", [0, 0, 0], [0.15, 0.2, 1]), box(W, "l", [-0.36, 0, 0]), box(W, "r", [0.36, 0, 0]), box(W, "top", [0, 0.6, 0])].map((r) => r.ok);
  call(W, "vic", "move", { to: [0, 0, -0.6] }); const p = call(W, "vic", "punt", { id: "top", v: [0, 1.2, 0] });
  T += 6000; call(W, "vic", "look", {}); const s = st(W); const t = s.entities.top.c;
  ok(made.every(Boolean) && p.ok && ["l", "r"].includes(t.parent?.to), "SE1 a crate at rest across two crates is attached to one of them, not to the slab under the gap between them", { made, punt: p.ok ?? p.refused, parent: t.parent, pos: t.transform.pos });
  call(W, "vic", "move", { to: [0, 0, 0.7] }); call(W, "vic", "punt", { id: "slab", v: [0, 0.5, 0.2] }); T += 6000; call(W, "vic", "look", {});
  ok(st(W).entities.slab.c.parent === undefined, "SE2 a thing on the ground stays unattached", st(W).entities.slab.c.parent); }
for (const carries of [false, true]) { const W = carries ? "tray" : "book";
  call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  box(W, "bot", [0, 0, 0]); box(W, "mid", [0, 0.6, 0]); call(W, "rowan", "set", { id: "bot", component: "grabbable", value: carries ? { carries: true } : {} });
  call(W, "vic", "move", { to: [0, 0, -0.7] }); call(W, "vic", "punt", { id: "mid", v: [0, 1, 0] }); T += 6000; call(W, "vic", "look", {});
  const stacked = st(W).entities.mid.c.parent?.to === "bot";
  call(W, "vic", "move", { to: [0, 0, -0.75] }); const g = call(W, "vic", "grab", { id: "bot" }); call(W, "vic", "move", { to: [0, 0, -3] }); T += 6000; call(W, "vic", "look", {});
  const m = st(W).entities.mid.c; const fell = (g.notes ?? []).some((n) => n.fell?.includes("mid"));
  if (!carries) ok(stacked && g.ok && fell && !m.parent && m.transform.pos[1] < 0.05, "SE3 picking up the bottom of a stack takes that one: what the physics stacked on it falls off and lands (a book from a pile)", { stacked, grab: g.ok ?? g.refused, fell, mid: m.transform.pos, parent: m.parent });
  else ok(stacked && g.ok && !fell && m.parent?.to === "bot", "SE4 grabbable.carries ('can carry other entities', a tray): what rests on it comes along", { stacked, grab: g.ok ?? g.refused, fell, parent: m.parent }); }
// R 10-10 evening (the gym log, 04:23Z): she picked up pyr-1; what was on it fell, and the settle parented it straight
// back ONTO pyr-1, still standing in the log where it was picked up. She carried the stack off; thrown, the occupants were
// rigid children of the thrown crate and sank into the ground with it.
{ const W = "held"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  // the gym's shape: 'top' sits across l and r; l is taken; top drops onto r and the floor-high step beside it ('step', as
  // high as l), so its footprint is level with where l still stands in the log
  box(W, "l", [-0.31, 0, 0]); box(W, "r", [0.31, 0, 0]); box(W, "step", [-0.31, 0, 0.61]); box(W, "top", [0, 0.6, 0.3]);
  call(W, "vic", "move", { to: [-0.31, 0, -0.75] }); const g = call(W, "vic", "grab", { id: "l" });
  T += 6000; call(W, "vic", "look", {}); const t = st(W).entities.top.c;
  ok(g.ok && t.parent?.to !== "l", "SE5 what falls off a thing I'm holding never settles back onto it (it still stands in the log where I took it)", { grab: g.ok ?? g.refused, parent: t.parent, pos: t.transform.pos });
  const th = call(W, "vic", "throw", { id: "l", v: [0, 2, 2] }); T += 8000; call(W, "vic", "look", {});
  const s2 = st(W); const lowest = Math.min(...["l", "r", "top"].map((k) => s2.entities[k].c.transform.pos[1]));
  ok(th.ok && lowest > -0.05, "SE5b …and thrown, nothing ends up under the ground", { throw: th.ok ?? th.refused, lowest }); }
for (const verb of ["throw", "drop"]) { const W = `ride-${verb}`; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  box(W, "bot", [0, 0, 0]); box(W, "mid", [0, 0.6, 0]); call(W, "rowan", "set", { id: "bot", component: "grabbable", value: { carries: true } });
  call(W, "vic", "move", { to: [0, 0, -0.7] }); call(W, "vic", "punt", { id: "mid", v: [0, 1, 0] }); T += 6000; call(W, "vic", "look", {});
  const stacked = st(W).entities.mid.c.parent?.to === "bot";
  call(W, "vic", "move", { to: [0, 0, -0.75] }); const g = call(W, "vic", "grab", { id: "bot" });
  const r = call(W, "vic", verb, verb === "throw" ? { id: "bot", v: [0, 2, 3] } : { id: "bot" }); T += 8000; call(W, "vic", "look", {});
  const s3 = st(W), m = s3.entities.mid.c, b = s3.entities.bot.c;
  ok(stacked && g.ok && r.ok && (r.notes ?? []).some((n) => n.flying?.includes("mid")) && m.transform.pos[1] > -0.05 && b.transform.pos[1] > -0.05,
    `SE6 ${verb === "throw" ? "a thrown" : "a dropped"} tray's load flies with it as its own body and lands on (not under) the ground`, { stacked, grab: g.ok ?? g.refused, r, mid: m.transform.pos, midParent: m.parent, bot: b.transform.pos }); }
// R 10-10 22:22: a thrown tray's load starts to come apart as it leaves the hand (spin + flick), not only on impact
{ const W = "spray"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  box(W, "tray", [0, 0, 0], [1.5, 0.3, 1.5]); box(W, "a", [-0.3, 0.2, 0], [0.4, 0.4, 0.4]); box(W, "b", [0.3, 0.2, 0], [0.4, 0.4, 0.4]); call(W, "rowan", "set", { id: "tray", component: "grabbable", value: { carries: true } });
  call(W, "vic", "move", { to: [0, 0, -0.9] }); for (const k of ["a", "b"]) call(W, "vic", "punt", { id: k, v: [0, 0.5, 0] }); T += 6000; call(W, "vic", "look", {});
  const on = ["a", "b"].every((k) => st(W).entities[k].c.parent?.to === "tray");
  call(W, "vic", "move", { to: [0, 0, -0.9] }); const g = call(W, "vic", "grab", { id: "tray" });
  const n0 = openWorld(root, W).entries.length; const th = call(W, "vic", "throw", { id: "tray", v: [0, 3, 4], w: [3.2, 0, 0] });
  const L = openWorld(root, W).entries.slice(n0).filter((e) => e.kind === "sim" && e.verb === "launch"); const vOf = (id) => L.find((e) => e.body.id === id)?.body.v;
  const d = (x, y) => x && y ? Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) : 0;
  ok(on && g.ok && th.ok && d(vOf("a"), vOf("tray")) > 0.05 && d(vOf("b"), vOf("tray")) > 0.05 && d(vOf("a"), vOf("b")) > 0.05,
    "SE7 thrown with spin, each occupant leaves with its own velocity (the tray's at its spot, and a flick), so the load fans out from the hand", { on, grab: g.ok ?? g.refused, throw: th.ok ?? th.refused, v: { tray: vOf("tray"), a: vOf("a"), b: vOf("b") } });
}
// R 10-11 23:36/23:47: a domino that came to rest on a FALLEN domino was parented under it — a child of a rotated,
// non-uniformly scaled parent is sheared ("splortched"). A rest never parents under a non-uniform host unless the child
// sits square on its axes.
{ const W = "shear"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "open", build: "visitor" } });
  const h = Math.sin(Math.PI / 12), c = Math.cos(Math.PI / 12);   // a wide flat slab turned 30° about up, static
  call(W, "rowan", "create", { id: "slab", model: "crate", components: { physics: { kind: "static" }, transform: { pos: [0, 0, 0], q: [0, h, 0, c], scale: [2, 0.3, 1] } } });
  box(W, "chip", [0, 1.2, 0], [0.3, 0.3, 0.3]); call(W, "vic", "move", { to: [0, 0, -1.2] }); call(W, "vic", "punt", { id: "chip", v: [0, 0.3, 0] }); T += 6000; call(W, "vic", "look", {});
  const chip = st(W).entities.chip.c; const q = chip.transform.q ?? [0, 0, 0, 1];
  ok(chip.transform.pos[1] > 0.1 && !chip.parent, "SE8 a thing that settles on a turned, non-uniformly scaled slab is NOT its child (it would be sheared); it rests on it all the same", { parent: chip.parent ?? null, pos: chip.transform.pos, q }); }
// R 10-12 (primitives): a mesh thing is a body to eidosim like a modelled one. A dynamic mesh box dropped from a height
// falls and rests on the floor; a crate thrown onto a static mesh box rests on it and is parented to it
{ const W = "mesh"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  call(W, "rowan", "create", { id: "fall", components: { mesh: { shape: "box", size: [0.5, 0.5, 0.5] }, physics: { kind: "dynamic", who: "visitor" }, transform: { pos: [4, 0, 4] } } });
  call(W, "vic", "move", { to: [4, 0, 3.3] }); const p = call(W, "vic", "punt", { id: "fall", v: [0, 2, 0] }); T += 8000; call(W, "vic", "look", {});
  const f = st(W).entities.fall.c; const rested = restsOf(openWorld(root, W).entries).some((x) => x.id === "fall");
  ok(p.ok && rested && Math.abs(f.transform.pos[1]) < 0.02 && !f.parent, "SE9 a dynamic mesh box punted up has a body: it flies, comes back down and its rest is logged on the floor", { punt: p.ok ?? p.refused, rested, pos: f.transform.pos, parent: f.parent ?? null });
  call(W, "rowan", "create", { id: "plinth", components: { mesh: { shape: "box", size: [1.5, 0.8, 1.5] }, transform: { pos: [0, 0, 0] } } });
  box(W, "crate", [0, 1.0, 0]);
  call(W, "vic", "move", { to: [2, 0, 1] }); const mv = call(W, "vic", "move", { to: [0, 0, -1.2] }); const q = call(W, "vic", "punt", { id: "crate", v: [0, 0.5, 0] }); T += 8000; call(W, "vic", "look", {});
  const c = st(W).entities.crate.c;
  ok(q.ok && c.parent?.to === "plinth" && Math.abs(c.transform.pos[1] - 0.8) < 0.05, "SE10 a crate dropped onto a static mesh box rests on its top (y = 0.8) and is its child: the mesh is a collider", { mv: mv.ok ? true : mv.refused, punt: q.ok ? true : q.refused, pos: c.transform.pos, parent: c.parent ?? null });
  // review S1.1: a mesh cylinder was a collider to the authority and nothing to eidosim (a tagged cylinder has no box); a crate fell through it
  call(W, "rowan", "create", { id: "drum", components: { mesh: { shape: "cylinder", size: [1.5, 0.8, 1.5] }, transform: { pos: [6, 0, -6] } } });
  box(W, "crate2", [6, 1.0, -6]);
  call(W, "vic", "move", { to: [3, 0, -3] }); call(W, "vic", "move", { to: [5, 0, -6] }); call(W, "vic", "move", { to: [6, 0, -7.2] }); const q2 = call(W, "vic", "punt", { id: "crate2", v: [0, 0.5, 0] }); T += 8000; call(W, "vic", "look", {});
  const c2 = st(W).entities.crate2.c;
  ok(q2.ok && c2.parent?.to === "drum" && Math.abs(c2.transform.pos[1] - 0.8) < 0.05, "SE11 a crate dropped onto a static mesh CYLINDER rests on its top (y = 0.8) and is its child: the engine has a body for it", { punt: q2.ok ? true : q2.refused, pos: c2.transform.pos, parent: c2.parent ?? null });
  // review S2.4: a resized plinth re-drops what the physics stacked on it (a shrunk mesh left the crate floating 0.5 m up)
  const sh = call(W, "rowan", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.3, 1.5] } }); T += 8000; call(W, "vic", "look", {});
  const c3 = st(W).entities.crate.c; const wy = (c3.parent?.to === "plinth" ? c3.transform.pos[1] : c3.transform.pos[1]);
  ok(sh.ok && (sh.notes ?? []).some((n) => n.fell?.includes("crate")) && Math.abs(wy - 0.3) < 0.05, "SE12 shrinking the mesh plinth under a resting crate re-drops it: it lands on the new top (y = 0.3), the reply says it fell", { set: sh.ok ? sh.notes : sh.refused, pos: c3.transform.pos, parent: c3.parent ?? null });
  // the same family for a model plinth: its scale shrinks, the child crate is re-dropped instead of riding the scale (sheared)
  call(W, "rowan", "create", { id: "mp", model: "crate", components: { physics: { kind: "static" }, transform: { pos: [-6, 0, 6], q: [0, 0, 0, 1], scale: [2.5, 1.3333, 2.5] } } });
  box(W, "crate3", [-6, 1.0, 6]);
  const walk = []; for (const to of [[3, 0, -5], [2, 0, -2], [2, 0, 1.5], [-1, 0, 3], [-4, 0, 4], [-6, 0, 4.8]]) walk.push(call(W, "vic", "move", { to }).refused ?? "ok"); const q3 = call(W, "vic", "punt", { id: "crate3", v: [0, 0.5, 0] }); T += 8000; call(W, "vic", "look", {});
  const on = st(W).entities.crate3.c.parent?.to === "mp";
  const sc = call(W, "rowan", "set", { id: "mp", component: "transform", value: { pos: [-6, 0, 6], q: [0, 0, 0, 1], scale: [2.5, 0.5, 2.5] } }); T += 8000; call(W, "vic", "look", {});
  const c4 = st(W).entities.crate3.c; const w4 = c4.parent?.to === "mp" ? c4.transform.pos[1] * 0.5 : c4.transform.pos[1];
  const ws = c4.parent?.to === "mp" ? (c4.transform.scale ?? [1, 1, 1]).map((v, i) => v * [2.5, 0.5, 2.5][i]) : (c4.transform.scale ?? [1, 1, 1]);
  // r2 S2.1/S2.2/S2.3 under an engine: a no-op write re-drops nothing; a socketed child rides its socket; a deleted body frees the occupants
  call(W, "rowan", "set", { id: "plinth", component: "sockets", value: { perch: { pos: [0.5, 0.3, 0.5] } } });
  call(W, "rowan", "create", { id: "cup", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" }, parent: { to: "plinth", socket: "perch" }, transform: { pos: [0, 0, 0] } } });
  const n1 = openWorld(root, W).entries.length; const same = call(W, "rowan", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.3, 1.5] } }); T += 8000; call(W, "vic", "look", {});
  ok(same.ok && openWorld(root, W).entries.length - n1 === 2 && !(same.notes ?? []).some((n) => n.fell), "SE14 re-asserting the plinth's mesh value re-drops nothing: 2 rows, no fell note (r2 S2.1)", { rows: openWorld(root, W).entries.length - n1, notes: same.notes });
  const grow = call(W, "rowan", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.5, 1.5] } }); T += 8000; call(W, "vic", "look", {});
  const cup = st(W).entities.cup.c;
  ok(grow.ok && (grow.notes ?? []).some((n) => n.fell?.includes("crate")) && !(grow.notes ?? []).some((n) => n.fell?.includes("cup")) && st(W).entities[cup.parent?.to]?.c.socket?.name === "perch" && st(W).entities[cup.parent.to].c.parent?.to === "plinth", "SE15 the crate re-drops on a resize, the cup on the perch socket stays on it (r2 S2.2; the perch is the plinth's socket child since the cut)", { notes: grow.notes, cup: cup.parent });
  call(W, "rowan", "delete", { id: "cup" });   // (the engine stands a socketed child at its host's origin: pre-existing, simlayer worldPose reads no sockets; out of the crate's way)
  const del = call(W, "rowan", "delete", { id: "plinth", component: "mesh" }); T += 8000; call(W, "vic", "look", {});
  const c5 = st(W).entities.crate.c;
  ok(del.ok && (del.notes ?? []).some((n) => n.fell?.includes("crate")) && !(del.notes ?? []).some((n) => n.stamped) && !c5.parent && c5.transform.pos[1] < 0.05, "SE16 deleting the plinth's mesh re-drops the crate (it lands on the floor, unparented); the reply says unstamped, not stamped (r2 S2.3)", { notes: del.notes, pos: c5.transform.pos, parent: c5.parent ?? null });
  ok(q3.ok && on && sc.ok && (sc.notes ?? []).some((n) => n.fell?.includes("crate3")) && Math.abs(w4 - 0.3) < 0.05 && ws.every((v) => Math.abs(v - 1) < 1e-3), "SE13 shrinking a MODEL plinth's scale under a resting crate re-drops it too (its own scale stays 1, it is not sheared): lands at world y = 0.3", { walk, punt: q3.ok ? true : q3.refused, on, set: sc.ok ? sc.notes : sc.refused, pos: c4.transform.pos, worldScale: ws, parent: c4.parent ?? null }); }

console.log(`[settle-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
