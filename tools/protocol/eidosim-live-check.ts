// @ts-nocheck
// tools/protocol/eidosim-live-check.ts — eidosim at the authority: who may be knocked, knocked children, and spheres on the
// live host (no lab catalogue). Review of 8377ec52 #1 #3 #4 #5 #6. Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/eidosim-live-check.ts
import fs from "node:fs";
import { request } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { openLive } from "../../server/livehost.ts";
import { fold, readLog } from "../../shared/protocol/fold.js";
import { simFold, restsOf, worldPose, ENGINES } from "../../shared/protocol/simlayer.js";
import { scratch } from "./common.ts";
const ENG = { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) };
let pass = 0, fail = 0;
const ok = (c, name, info) => { if (c) pass++; else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const root = scratch("eidosim-live");
let T = 1800000000000; const at = (ms) => { T += ms; process.env.PROTOCOL_NOW = String(T); };
const call = (w, a, v, args = {}, step = 100) => { at(step); return request(openWorld(root, w), a, v, args); };
const log = (w) => openWorld(root, w).entries;
const view = (w) => { const x = openWorld(root, w); return simFold(x.entries, x.now()); };
const J = JSON.stringify, pos = (W, id) => fold(log(W)).entities[id]?.c.transform.pos, wpos = (W, id) => worldPose(fold(log(W)), id)?.pos;
function pg(name) {
  call(name, "rowan", "create-world", { title: name });
  call(name, "rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  call(name, "rowan", "set", { id: "@world", component: "access", value: { join: "anyone" } });
  call(name, "rowan", "create", { id: "crate-1", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [2, 0] } });
  call(name, "rowan", "create", { id: "tgt", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 2.2] } });
  return name;
}
function shoot(W, who = "vic", v = [0, -1, 6]) {   // a visitor throws crate-1 at tgt
  call(W, who, "move", { to: [2, 0, -0.5] }); const g = call(W, who, "grab", { id: "crate-1" });
  call(W, who, "move", { to: [0, 0, 0.4] }); const t = call(W, who, "throw", { id: "crate-1", v });
  call(W, who, "wait", {}, 20000); return g.ok && t.ok;
}
{ const W = pg("k0"); const p0 = pos(W, "tgt"); const s = shoot(W);
  ok(s && J(pos(W, "tgt")) !== J(p0), "K0 control: a visitor's throw knocks an unlocked dynamic crate", { s, before: p0, after: pos(W, "tgt") }); }
{ const W = pg("k1"); call(W, "rowan", "set", { id: "tgt", component: "lock", value: true }); const p0 = pos(W, "tgt"); const s = shoot(W);
  ok(s && J(pos(W, "tgt")) === J(p0) && !restsOf(log(W)).some((r) => r.id === "tgt"), "K1 locked AFTER it was placed: not knocked", { s, before: p0, after: pos(W, "tgt") }); }
{ const W = pg("k1u"); call(W, "rowan", "set", { id: "tgt", component: "lock", value: true }); call(W, "rowan", "delete", { id: "tgt", component: "lock" });
  const p0 = pos(W, "tgt"); const s = shoot(W);
  ok(s && J(pos(W, "tgt")) !== J(p0), "K1 …and unlocked again: knockable again", { s, before: p0, after: pos(W, "tgt") }); }
{ const W = pg("k2"); call(W, "rowan", "create", { id: "shelf", model: "crate", components: { lock: true }, place: { at: [3, 2.2] } });
  call(W, "rowan", "set", { id: "tgt", component: "parent", value: { to: "shelf" } }); const p0 = pos(W, "tgt"); const s = shoot(W); const e = fold(log(W)).entities.tgt;
  ok(s && e.c.parent?.to === "shelf" && J(e.c.transform.pos) === J(p0), "K2 under a locked thing: not knocked", { s, parent: e.c.parent, before: p0, after: e.c.transform.pos }); }
{ const W = pg("k3"); call(W, "rowan", "create", { id: "vase", model: "crate", components: { lock: true, parent: { to: "tgt" }, transform: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } } });
  const v0 = wpos(W, "vase"), p0 = pos(W, "tgt"); const s = shoot(W);
  ok(s && J(wpos(W, "vase")) === J(v0) && J(pos(W, "tgt")) === J(p0), "K3 carrying something locked: not knocked (as a hand can't lift it)", { s, vase: [v0, wpos(W, "vase")], tgt: [p0, pos(W, "tgt")] }); }
{ const W = pg("k4"); call(W, "rowan", "create", { id: "top", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, parent: { to: "tgt" }, transform: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [0.5, 0.5, 0.5] } } });
  const t0 = wpos(W, "top"); const s = shoot(W, "vic", [0, -1, 8]); const L = log(W), v = view(W), R = restsOf(L);
  const rt = R.find((r) => r.id === "top"), rg = R.find((r) => r.id === "tgt");
  ok(s && !!rt && !!rg && rt.cause === rg.cause && v.checks.agree >= 3 && !v.checks.disagree.length && J(wpos(W, "top")) !== J(t0),
    "K4 a knocked thing carrying a knocked thing: each rests on the record under the throw, and a carrier agrees", { s, rests: R.map((r) => [r.id, r.cause]), checks: v.checks, top: [t0, wpos(W, "top")] }); }
{ // K5 the live host (no lab catalogue): a sphere exists for the engine, flies and rests
  const dir = root + "live/"; fs.mkdirSync(dir, { recursive: true }); let now = 1800000000000;
  const w = openLive(dir, "lv", { now: () => now, custodyFile: root + "custody.json", nameOf: () => null, kindOf: () => "human" });
  const c = (a, v, args = {}, step = 100) => { now += step; return request(w, a, v, args); };
  c("rowan", "create-world", { title: "lv" }); c("rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  c("rowan", "create", { id: "rb", model: "ball", components: { collider: { shape: "sphere" }, physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
  c("rowan", "move", { to: [0, 0, -0.5] }); const g = c("rowan", "grab", { id: "rb" }), t = c("rowan", "throw", { id: "rb", v: [0, 1, 3] });
  const flying = !!w.sim().sim.bodies.rb; c("rowan", "wait", {}, 15000);
  const R = restsOf(readLog(fs.readFileSync(dir + "world.jsonl"))), p = w.state().entities.rb.c.transform.pos;
  ok(g.ok && t.ok && flying && R.some((r) => r.id === "rb") && p[2] > 1, "K5 live host: a sphere is a body, flies, and its rest is logged", { g: g.ok, t: t.ok, flying, rests: R.map((r) => r.id), pos: p }); }
// K6 (review of b398d7e3 #1): a tumbling engine lays things on their sides, so a surface is read from the full rotation:
// a lamp placed on a crate resting on its side stands on its true top (yaw-only reading floated it half a crate higher),
// and what the authority writes composes to a unit rotation
{ const { worldPose: wp } = await import("../../shared/protocol/simlayer.js");
  const qr = (q, v) => { const [x, y, z, w] = q; const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
    return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)]; };
  const root2 = fs.mkdtempSync(root + "/side-") + "/"; let now = 1800000000000; const dir = root2 + "w/"; fs.mkdirSync(dir);
  const w = openLive(dir, "w", { now: () => now, custodyFile: root2 + "custody.json", nameOf: () => null, kindOf: () => "human" });
  const c = (a, v, args = {}, step = 100) => { now += step; return request(w, a, v, args); };
  c("rowan", "create-world", { title: "side" }); c("rowan", "set", { id: "@world", component: "physics-engine", value: ENG });
  c("rowan", "create", { id: "cr", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
  c("rowan", "create", { id: "lamp", model: "table-lamp", place: { at: [5, 5] } }); c("rowan", "move", { to: [0, 0, -0.6] });
  let side = null;
  for (const spin of [[0, 0, 9], [0, 0, 6], [7, 0, 0], [0, 0, 12]]) {
    c("rowan", "grab", { id: "cr" }); c("rowan", "throw", { id: "cr", v: [0, 2, 2], w: spin }); c("rowan", "wait", {}, 20000);
    const t = w.state().entities.cr.c.transform; if (Math.abs(qr(t.q, [0, 1, 0])[1]) < 0.5) { side = t; break; }
    c("rowan", "move", { to: [t.pos[0], 0, t.pos[2] - 0.6] }); }
  if (!side) ok(false, "K6 setup: a thrown crate came to rest on its side", null);
  else { const p = c("rowan", "place", { id: "lamp", on: "cr" }); const st = w.state(); const L = wp(st, "lamp");
    const top = side.pos[1] + qr(side.q, [0, 0.3, 0])[1] + 0.3;   // the 0.6 m lab crate: its centre, then half a side up
    ok(p.ok && Math.abs(L.pos[1] - top) < 0.02 && Math.abs(Math.hypot(...L.q) - 1) < 1e-9,
      "K6 a lamp placed on a crate lying on its side stands on its true top, with a unit rotation", { placed: p.ok ?? p.refused, lampY: L.pos[1], top, qn: Math.hypot(...L.q) }); } }
// K7 (review r5): an empty UPRIGHT surface list (a door, a wall) says nothing about lying: laid flat, its top face is a
// surface, as the walker has it; a round thing (a ball) offers none in any pose
{ const root3 = fs.mkdtempSync(root + "/flat-") + "/"; let now = 1800000000000; const dir = root3 + "w/"; fs.mkdirSync(dir);
  const w = openLive(dir, "w", { now: () => now, custodyFile: root3 + "custody.json", nameOf: () => null, kindOf: () => "human" });
  const c = (a, v, args = {}, step = 100) => { now += step; return request(w, a, v, args); };
  c("rowan", "create-world", { title: "flat" }); c("rowan", "move", { to: [0, 0, 6] });
  const made = ["door", "wall"].map((m, i) => c("rowan", "create", { id: m, model: m, place: { at: [i * 5, 0], lying: true } }).ok);
  c("rowan", "create", { id: "bell", model: "bell", place: { at: [9, 9] } });
  const onDoor = c("rowan", "place", { id: "bell", on: "door" }), onWall = c("rowan", "place", { id: "bell", on: "wall" });
  c("rowan", "create", { id: "ball", model: "ball", components: { transform: { pos: [-5, 0, 0], q: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } } });
  const ballS = c("rowan", "measure", { id: "ball" }).surfaces;
  ok(made.every(Boolean) && onDoor.ok && onWall.ok && Array.isArray(ballS) && ballS.length === 0,
    "K7 a door or a wall laid flat has its top as a surface (a bell goes on it); a ball on its side still offers none", { made, door: onDoor.ok ?? onDoor.refused, wall: onWall.ok ?? onWall.refused, ball: ballS }); }
// K8, K9 (review r6): a socket's rotation is written unit (it was rounded only: 0.707); a thing laid down offers its
// levels bottom to top with no face buried under its own parts, so the default (the last) is its top and has room
{ const root4 = fs.mkdtempSync(root + "/r6-") + "/"; let now = 1800000000000; const dir = root4 + "w/"; fs.mkdirSync(dir);
  const w = openLive(dir, "w", { now: () => now, custodyFile: root4 + "custody.json", nameOf: () => null, kindOf: () => "human" });
  const c = (a, v, args = {}, step = 1000) => { now += step; return request(w, a, v, args); };
  c("rowan", "create-world", { title: "r6" });
  c("rowan", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], q: [0, Math.SQRT1_2, 0, Math.SQRT1_2], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
  c("rowan", "create", { id: "key", model: "book", components: { grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 0] } });
  c("rowan", "move", { to: [0.8, 0, 0.6] }); c("rowan", "grab", { id: "key" }); const d = c("rowan", "drop", { id: "key", pos: [0.1, 0.75, 0.05] });
  const kq = w.state().entities.key?.c.transform?.q; const kp = w.state().entities.key?.c.parent?.to;
  ok(d.ok && kp === "rack" && Array.isArray(kq) && Math.abs(Math.hypot(...kq) - 1) < 1e-12, "K8 a thing snapped into a turned socket is written with a unit rotation", { ok: d.ok ?? d.refused, parent: kp, q: kq, n: kq && Math.hypot(...kq) });
  c("rowan", "move", { to: [0, 0, 12] });
  // the shelf on clear ground (review r7: K8's crate was under it, and the default passed by a float tie-break)
  c("rowan", "create", { id: "sh", model: "shelf", place: { at: [-6, 0], lying: true } }); c("rowan", "create", { id: "fr", model: "swing-frame", place: { at: [6, 0], lying: true } });
  c("rowan", "create", { id: "bl", model: "ball", place: { at: [9, 9] } });
  const lv = (id: string) => c("rowan", "measure", { id }).surfaces ?? [];
  const shOn = w.state().entities.sh?.c.parent?.to ?? null;   // must be on the ground, not on something
  const asc = (L: any[]) => L.every((x, i) => i === 0 || x.y >= L[i - 1].y);
  const top = (id: string) => Math.max(...lv(id).map((x: any) => x.y));
  const onSh = c("rowan", "place", { id: "bl", on: "sh", dry: true }), onFr = c("rowan", "place", { id: "bl", on: "fr", dry: true });
  const shL = lv("sh"), frL = lv("fr");
  // (a lying A-frame's faces are all 10 cm beams: no room for a 22 cm ball, refused honestly, at its top level)
  ok(!shOn && onSh.ok && onFr.refused?.code === "no-room" && new RegExp(`level ${frL.length - 1} `).test(onFr.refused.reason) && asc(shL) && asc(frL) && shL.length > 0 && Math.abs(shL.at(-1).y - top("sh")) < 1e-9 && Math.abs(frL.at(-1).y - top("fr")) < 1e-9,
    "K9 a shelf or a swing-frame laid down lists its levels bottom to top, no face buried under its own parts; the default is its top (the shelf's takes a ball; the frame's beam honestly has no room)",
    { sh: onSh.ok ?? onSh.refused?.reason, fr: onFr.ok ?? onFr.refused?.reason, shY: shL.map((x: any) => x.y), frY: frL.map((x: any) => x.y) }); }
console.log(`eidosim-live-check: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
