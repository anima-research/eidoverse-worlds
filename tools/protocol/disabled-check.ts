// @ts-nocheck
// tools/protocol/disabled-check.ts — a switched-off thing (componentspec `disabled`, R 10-11: "present in the world as
// links, but not downloaded, interoperable, or visible until someone re-enables it"). At the authority: it can't be
// grabbed, punted or used, nor what hangs under it; it has no body in the engine; nothing stands on it; switched back on,
// all of that returns. Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/disabled-check.ts
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold } from "../../shared/protocol/fold.js";
import { ENGINES, simFold } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";
const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) { pass++; console.log("  ✓", name); } else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const root = scratch("disabled"); let T = 1800000000000;
const call = (w, a, v, args = {}) => { T += 1500; process.env.PROTOCOL_NOW = String(T); return request(openWorld(root, w), a, v, args); };
const code = (r) => (r.ok ? "ok" : r.refused?.code);
const st = (W) => fold(openWorld(root, W).entries);
const bodies = (W) => { const w = openWorld(root, W); const sf = simFold(w.entries, w.now()); return Object.keys({ ...(sf?.sim?.bodies ?? {}), ...(sf?.sim?.statics ?? {}) }); };
// a crate `base` at x=0 with a crate `top` placed on it; `door` with a reaction; a loose crate `c` at x=3
const mk = (W) => { call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  call(W, "rowan", "create", { id: "base", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  call(W, "rowan", "create", { id: "top", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { on: "base" } });
  call(W, "rowan", "create", { id: "c", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [3, 0] } }); };

{ const W = "off"; mk(W);
  const t0 = st(W).entities.top.c.parent?.to;
  const s = call(W, "rowan", "set", { id: "base", component: "disabled", value: true });
  ok(s.ok, "D0 an editor switches a thing off (set disabled: true)", { s: code(s), parent: t0 });
  call(W, "vic", "move", { to: [0, 0, -0.8] });
  const g = call(W, "vic", "grab", { id: "base" }), g2 = call(W, "vic", "grab", { id: "top" }), p = call(W, "vic", "punt", { id: "base" });
  ok(code(g) === "disabled" && code(g2) === "disabled" && code(p) === "disabled", "D1 a switched-off thing, and what hangs under it, can't be grabbed or punted", { g: code(g), top: code(g2), punt: code(p), topParent: t0 });
  const b = bodies(W); ok(!b.includes("base") && !b.includes("top") && b.includes("c"), "D2 neither has a body in the engine (the loose crate does)", b);
  call(W, "rowan", "create", { id: "probe", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0.02, 0] } });
  const py = st(W).entities.probe.c.transform.pos[1];
  ok(Math.abs(py) < 1e-6, "D3 a thing placed where it stands lands on the ground: nothing stands on a switched-off thing", { probeY: py });
  const on = call(W, "rowan", "delete", { id: "base", component: "disabled" }); call(W, "rowan", "delete", { id: "probe" });
  call(W, "vic", "move", { to: [0, 0, -0.8] });
  const b2 = bodies(W); const g3 = call(W, "vic", "grab", { id: "top" });
  ok(on.ok && b2.includes("base") && b2.includes("top") && g3.ok, "D4 switched back on (delete disabled): bodies again, and it can be picked up", { on: code(on), b2, g3: code(g3) }); }

{ const W = "use"; call(W, "rowan", "create-world", { title: W }); call(W, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  call(W, "rowan", "create", { id: "lamp", model: "crate", place: { at: [0, 0] } }); call(W, "rowan", "set", { id: "lamp", component: "reactions", value: { toggle: { kind: "set", component: "label", value: "on" } } });
  call(W, "vic", "move", { to: [0, 0, -0.8] }); const u0 = call(W, "vic", "use", { id: "lamp", action: "toggle" });
  call(W, "rowan", "set", { id: "lamp", component: "disabled", value: true }); const u1 = call(W, "vic", "use", { id: "lamp", action: "toggle" });
  ok(u0.ok && code(u1) === "disabled", "D5 …and can't be used (its reactions don't run)", { before: code(u0), after: code(u1), why: u0.refused?.reason }); }

// a held thing and the engine (review of 64d26822/5d5eef5c): only a write that ends the hold brings it back into the engine
const engineHas = (W, id) => { const w = openWorld(root, W); const sf = simFold(w.entries, w.now()); return !!(sf?.sim?.bodies?.[id] || sf?.sim?.statics?.[id]); };
const holds = (W) => Object.keys(openWorld(root, W).presence.holds);
{ const W = "held-physics"; mk(W); call(W, "vic", "move", { to: [0, 0, -0.8] }); const g = call(W, "vic", "grab", { id: "top" });
  call(W, "rowan", "set", { id: "top", component: "physics", value: { kind: "dynamic", who: "visitor", restitution: 0.2 } });
  ok(g.ok && holds(W).includes("top") && !engineHas(W, "top"), "L1 an edit to a held thing's physics leaves it in the hand and out of the engine (no ghost collider)", { held: holds(W), engine: engineHas(W, "top") }); }
{ const W = "held-terrain"; mk(W); call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "top" });
  call(W, "rowan", "set", { id: "@world", component: "terrain", value: { seed: 3, size: 40, amplitude: 0 } });
  ok(holds(W).includes("top") && !engineHas(W, "top"), "L2 a terrain change doesn't seat a held thing in the engine", { held: holds(W), engine: engineHas(W, "top") }); }
{ const W = "held-off"; mk(W); call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "top" });
  call(W, "rowan", "set", { id: "top", component: "disabled", value: true }); const h1 = holds(W);
  call(W, "rowan", "delete", { id: "top", component: "disabled" });
  ok(!h1.includes("top") && engineHas(W, "top"), "L3 switching a held thing off takes it out of the hand; back on, it's in the engine where the record has it", { held: h1, engine: engineHas(W, "top") }); }
{ const W = "held-epoch"; mk(W); call(W, "vic", "move", { to: [0, 0, -0.8] }); call(W, "vic", "grab", { id: "top" });
  call(W, "rowan", "set", { id: "@world", component: "physics-engine", value: { ...ENG, tickMs: 25 } });
  ok(holds(W).includes("top") && !engineHas(W, "top"), "L4 an engine change doesn't seat a held thing either", { held: holds(W), engine: engineHas(W, "top") }); }

console.log(`[disabled-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
