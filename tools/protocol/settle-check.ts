// @ts-nocheck
// tools/protocol/settle-check.ts — what a thing at rest is attached to (settleSim). R's gym, 10-10: a pyramid's top crate
// over the gap between two crates was parented to the crate a row lower (read under its centre), and rode along 0.5 m
// above it when that one was carried.   Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/settle-check.ts
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { fold } from "../../shared/protocol/fold.js";
import { ENGINES } from "../../shared/protocol/simlayer.js";
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
console.log(`[settle-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
