// tools/protocol/climb-env-check.ts — collision off (collider.enabled), climb routes (shared/climb.js) and the environment's homes
// (shared/spawn.js arrivals and KillZ, @world.sky.gradient, the directional sun): the door, the shared readers, the authority.
//   bun tools/protocol/climb-env-check.ts                 every case
//   bun tools/protocol/climb-env-check.ts --only K1,K3    just those
//   bun tools/protocol/climb-env-check.ts --tree <dir>    against another checkout's shared/ and server/ (a mutant, or the base)
//   bun tools/protocol/climb-env-check.ts --mutants       remove each rule in turn (a copy of the tree): its cases must go red
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the spatial index keeps a collision-off thing", "protocol/authority/spatial.js", "const unindexed = (st, id) => !!offChain(st, id) || solidOff(st.entities[id]?.c, \"bodies\");", "const unindexed = (st, id) => !!offChain(st, id);", ["K1"]],
  ["the engine keeps a collision-off thing", "protocol/simlayer.js", "|| sphereShape(e.c.physics)) || solidOff(e.c, \"things\")) return null;", "|| sphereShape(e.c.physics))) return null;", ["K1"]],
  ["physics none is still not solid to the engine", "protocol/simlayer.js", "|| sphereShape(e.c.physics)) || solidOff(e.c, \"things\")) return null;", "|| sphereShape(e.c.physics)) || solidOff(e.c, \"things\") || e.c.physics?.kind === \"none\") return null;", ["K3"]],
  ["dynamic + collision off taken", "protocol/authority/checks.js", "if (c.collider?.enabled === false && c.physics?.kind === \"dynamic\") return", "if (false) return", ["K2"]],
  ["climb points unchecked", "protocol/authority/checks.js", "if (comp === \"climb\" && obj && v.points !== undefined && !(", "if (false && !(", ["K4"]],
  ["progress ignores the host's rotation", "climb.js", "const s = v3(pose?.scale) ? pose.scale : [1, 1, 1], r = qRotate(pose?.q ?? [0, 0, 0, 1],", "const s = v3(pose?.scale) ? pose.scale : [1, 1, 1], r = qRotate([0, 0, 0, 1],", ["K5"]],
  ["a vertical route has no facing", "climb.js", "?? [0, 0, 1];", "?? [0, 0, 0];", ["K6"]],
  ["ends not honoured", "climb.js", "if (route.ends !== \"both\" && route.ends !== end) continue;", "", ["K7"]],
  ["spawn yaw unread", "spawn.js", "yaw: Number.isFinite(sp.yaw) ? sp.yaw : 0,", "yaw: 0,", ["K8"]],
  ["visitors may arrive only at @world.spawn", "spawn.js", "return !all.length || all.some(", "return !all.length || all.slice(0, 1).some(", ["K8"]],
  ["riding bodies fall out too", "spawn.js", "return !riding && !!B", "return !!B", ["K9"]],
  ["the fall is the client's word", "protocol/authority/bodyverbs.js", "if (fell && B && !(me && me.at[1] < B.min[1] + TRACK.cap))", "if (false)", ["K13"]],
  ["a fall loses its reason on the record", "protocol/authority/bodyverbs.js", "...(fell ? { reason: FELL } : {})", "", ["K9"]],
  ["a flat terrain is noise to the height law", "terrainmath.js", "if (typeof P.flat === 'number') { const h = P.flat; return () => h; }", "", ["K12"]],
  ["a flat terrain takes noise fields", "protocol/authority/checks.js", "if (extra.length) refuse(", "if (false) refuse(", ["K12"]],
  ["the gradient's bottom isn't the horizon", "zone.js", "bottom: rgb(g.bottom) ? [...g.bottom] : [...g.horizon]", "bottom: rgb(g.bottom) ? [...g.bottom] : [0, 0, 0]", ["K10"]],
  ["CONTROL (no-op: must stay green)", "climb.js", "// shared/climb.js — a climb route", "//  shared/climb.js — a climb route", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/climb-env-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = scratch("kmut"); for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
    const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the rule moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[climb-env-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const imp = async (p: string) => { try { return await import(TREE + p); } catch (e) { return { __missing: String(e?.message ?? e).slice(0, 160) }; } };
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const CL = await imp("shared/climb.js"), SP = await imp("shared/spawn.js"), Z = await import(TREE + "shared/zone.js");
const PC = await imp("server/posecheck.ts");
const ME = await import(ENGINE + "client/lib/motioneval.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("climbenv");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries: F.readLog(readLogBytes(logPath)).map(D.posAt), getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line), presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
function session() {
  const name = `k${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (verb: string, args: any = {}, actor = "olive") => { clock.advance(1000);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  call("create-world", { title: name });
  call("set", { id: "@world", component: "roles:vic", value: { role: "member" } });
  return { call, st: () => Wd().state(), log: () => Wd().entries };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)} | fix: ${String(r?.refused?.fix).slice(0, 140)}`);
const tf = (pos: number[], q = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ pos, q, scale });
const near = (a: number[], b: number[], e = 1e-9) => Array.isArray(a) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < e);
const yawQ = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];

let pass = 0, fail = 0;
async function C(id: string, what: string, fn: () => any) {
  if (ONLY && !ONLY.includes(id)) return;
  let r: any; try { r = await fn(); } catch (e) { r = [false, `threw: ${e?.stack ?? e}`]; }
  const [good, info] = Array.isArray(r) ? r : [r, undefined];
  if (good) { pass++; console.log(`ok   ${id} ${what}`); } else { fail++; console.log(`FAIL ${id} ${what}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 900)); }
}
// a wall across z = 2 between the body and [0, 0, 4]; a walk of 3.6 m through it (one step under the 4 m cap)
const across = (s: any, components: any) => { s.call("create", { id: "gate", model: "wall", components: { transform: tf([0, 0, 2]), ...components } });
  s.call("move", { to: [0, 0, 0.2] }, "vic"); return s.call("move", { to: [0, 0, 3.8] }, "vic"); };

await C("K1", "a kinematic thing with motion and collider {enabled: false}: walk-through for the authority's track, out of its index and the engine's view, and still moving (its motion turns it, its kinematic kept)", () => {
  const s = session(); const spin = { type: "spin", degPerSec: 90 };
  const walk = across(s, { physics: { kind: "kinematic" }, motion: spin, collider: { enabled: false } });
  const st = s.st(), c = st.entities.gate?.c, ev = SL.engineViewM(st, { wall: { size: [4, 2.6, 0.15] } });
  const base = { pos: [0, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, t0 = ME.evalWholeMotion(base, c?.motion, 0), t1 = ME.evalWholeMotion(base, c?.motion, 500);
  return [walk.ok && c?.physics?.kind === "kinematic" && !!c?.motion && !("gate" in ev.entities) && !near(t0.q, t1.q, 1e-6), { walk: show(walk), physics: c?.physics, engine: Object.keys(ev.entities), q0: t0.q, q1: t1.q }]; });

await C("K1s", "a default thing is still solid: the same walk through the same wall is refused (solid), and the engine holds it", () => {
  const s = session(); const walk = across(s, { physics: { kind: "kinematic" }, motion: { type: "spin", degPerSec: 90 } });
  const ev = SL.engineViewM(s.st(), { wall: { size: [4, 2.6, 0.15] } });
  return [walk.refused?.code === "solid" && "gate" in ev.entities, { walk: show(walk), engine: Object.keys(ev.entities) }]; });

await C("K2", "collider {enabled: false} + physics {kind: 'dynamic'} is refused, either order, naming the fix (kinematic, none, or solid again)", () => {
  const s = session();
  const both = s.call("create", { id: "a", model: "crate", components: { transform: tf([3, 0, 0]), physics: { kind: "dynamic" }, collider: { enabled: false } } });
  s.call("create", { id: "b", model: "crate", components: { transform: tf([5, 0, 0]), collider: { enabled: false } } });
  const late = s.call("set", { id: "b", component: "physics", value: { kind: "dynamic" } });
  s.call("create", { id: "c", model: "crate", components: { transform: tf([7, 0, 0]), physics: { kind: "dynamic" } } });
  const off = s.call("set", { id: "c", component: "collider", value: { enabled: false } });
  const kin = s.call("set", { id: "b", component: "physics", value: { kind: "kinematic" } });
  const fixed = (r: any) => !r.ok && /fall forever/.test(r.refused?.reason ?? "") && /kinematic/.test(r.refused?.fix ?? "");
  return [fixed(both) && fixed(late) && fixed(off) && kin.ok, { both: show(both), late: show(late), off: show(off), kin: show(kin) }]; });

await C("K3", "physics {kind: 'none'} is not simulated but still solid: the walk is refused and the engine holds it as a collider (static)", () => {
  const s = session(); const walk = across(s, { physics: { kind: "none" } });
  const ev = SL.engineViewM(s.st(), { wall: { size: [4, 2.6, 0.15] } });
  return [walk.refused?.code === "solid" && "gate" in ev.entities && ev.entities.gate.kind === undefined, { walk: show(walk), engine: ev.entities.gate }]; });

await C("K4", "climb's door: 2–16 points [x, y, z] (one, seventeen, a bad point and a straight-up face refused), reach and speed in range; a good route taken", () => {
  const s = session(); const mk = (id: string, climb: any) => s.call("create", { id, components: { transform: tf([0, 0, 0]), climb } });
  const r = { one: mk("a", { points: [[0, 0, 0]] }), many: mk("b", { points: Array.from({ length: 17 }, (_, i) => [0, i, 0]) }), bad: mk("c", { points: [[0, 0, 0], [0, 1]] }),
    up: mk("d", { points: [[0, 0, 0], [0, 3, 0]], face: [0, 1, 0] }), reach: mk("e", { points: [[0, 0, 0], [0, 3, 0]], reach: 9 }), good: mk("f", { points: [[0, 0, 0.3], [0, 3, 0.3]], reach: 1, speed: 2, face: [0, 0, -1], ends: "start" }) };
  return [!r.one.ok && !r.many.ok && !r.bad.ok && !r.up.ok && !r.reach.ok && r.good.ok, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

await C("K5", "progress → pose through a moving parent: the point at a progress is the host's world pose applied to its local point, and moving or turning the carrier moves it with the same progress", () => {
  if (CL.__missing) return [false, CL.__missing];
  const s = session();
  s.call("create", { id: "boat", components: { transform: tf([10, -2, 5], yawQ(0.7)) } });
  s.call("create", { id: "ladder", components: { transform: tf([1, 0, 0]), parent: { to: "boat" }, climb: { points: [[0, 0, 0], [0, 2, 0], [0, 2, -1]] } } });
  const route = CL.routeOf(s.st().entities.ladder.c.climb), at = (st: any) => CL.climbPose(SL.worldPose(st, "ladder"), route, 2.5).pos;
  const p0 = at(s.st()), local = CL.localAt(route, 2.5);
  const by = SL.worldPose(s.st(), "ladder"), want0 = CL.toWorld(by, local);
  s.call("set", { id: "boat", component: "transform", value: tf([-4, 1, 2], yawQ(-1.2)) });
  const p1 = at(s.st()), b2 = SL.worldPose(s.st(), "boat"), lad = [b2.pos[0] + Math.cos(-1.2), b2.pos[1], b2.pos[2] - Math.sin(-1.2)];
  // the third point by hand: the ladder's origin (the boat's yaw turns its [1, 0, 0]) plus [0, 2, -0.5] turned by -1.2
  const hand = [lad[0] + -0.5 * Math.sin(-1.2), lad[1] + 2, lad[2] + -0.5 * Math.cos(-1.2)];
  return [route.length === 3 && near(local, [0, 2, -0.5]) && near(p0, want0) && near(p1, hand, 1e-9) && !near(p0, p1, 1e-3), { p0, want0, p1, hand }]; });

await C("K6", "a collinear vertical route with no face gives a defined facing: the host's +z (its heading); a sloped one faces along its run; face wins", () => {
  if (CL.__missing) return [false, CL.__missing];
  const pose = { pos: [0, 0, 0], q: yawQ(0.4), scale: [1, 1, 1] };
  const up = CL.climbPose(pose, CL.routeOf({ points: [[0, 0, 0], [0, 1, 0], [0, 3, 0]] }), 1).yaw;
  const run = CL.climbPose(pose, CL.routeOf({ points: [[0, 0, 0], [0, 2, 0], [1, 2, 0]] }), 1).yaw;
  const faced = CL.climbPose(pose, CL.routeOf({ points: [[0, 0, 0], [0, 3, 0]], face: [-1, 5, 0] }), 1).yaw;
  return [Math.abs(up - 0.4) < 1e-9 && Math.abs(run - (0.4 + Math.PI / 2)) < 1e-9 && Math.abs(faced - (0.4 - Math.PI / 2)) < 1e-9, { up, run, faced }]; });

await C("K7", "boarding and stepping: within reach of an allowed end only (ends: start refuses the top), up from the start and down from the end, a step at the route's speed, done at the far end", () => {
  if (CL.__missing) return [false, CL.__missing];
  const pose = { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, both = CL.routeOf({ points: [[0, 0, 0], [0, 3, 0]] }), start = CL.routeOf({ points: [[0, 0, 0], [0, 3, 0]], ends: "start" });
  const top = CL.boardAt(pose, both, [0, 3.5, 0]), bottom = CL.boardAt(pose, both, [0.5, 0, 0.5]), far = CL.boardAt(pose, both, [0, 1.5, 0]), topS = CL.boardAt(pose, start, [0, 3.5, 0]);
  let p = 0, steps = 0, done = false; while (!done && steps < 100) { const r = CL.stepClimb(both, p, 1, 0.1); p = r.progress; done = r.done; steps++; }
  return [top?.dir === -1 && top.progress === 3 && bottom?.dir === 1 && bottom.progress === 0 && far === null && topS === null && done && p === 3 && steps === Math.ceil(3 / (1.3 * 0.1)), { top, bottom, far, topS, steps, p }]; });

await C("K8", "arrivals: @world.spawn's yaw read; with spawn-points, @world.spawn is the default, a team asks its own, none declared → the first by id facing its rotation; a visitor may arrive at any of them, nowhere else", () => {
  if (SP.__missing) return [false, SP.__missing];
  const s = session();
  s.call("set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8], radius: 1, yaw: 1.25 } });
  s.call("create", { id: "red-gate", components: { transform: tf([12, 0, 0], yawQ(-0.5)), "spawn-point": { title: "red", team: "red" } } });
  s.call("create", { id: "blue-gate", components: { transform: tf([-12, 0, 0], yawQ(2)), "spawn-point": { team: "blue" } } });
  const st = s.st(), def = SP.spawnOf(st), red = SP.spawnOf(st, { team: "red" });
  const atRed = s.call("move", { to: [12.5, 0, 0] }, "vic"); s.call("leave", {}, "vic");
  const atNone = s.call("move", { to: [5, 0, 5] }, "vic");
  s.call("delete", { id: "@world", component: "spawn" }); const first = SP.spawnOf(s.st());
  return [def?.id === "@world" && def.yaw === 1.25 && red?.id === "red-gate" && Math.abs(red.yaw - -0.5) < 1e-9 && atRed.ok && atNone.refused?.code === "spawn" && first?.id === "blue-gate" && Math.abs(first.yaw - 2) < 1e-9,
    { def, red, atRed: show(atRed), atNone: show(atNone), first }]; });

await C("K9", "KillZ: below the kill line (KILL_MARGIN under @world.bounds.min.y) a body has fallen (a seated or climbing one, riding, hasn't); move {teleport, reason: 'below-bounds'} to an arrival place is on the record with its reason; elsewhere, without bounds, or without teleport, refused", () => {
  if (SP.__missing) return [false, SP.__missing];
  const s = session();
  s.call("delete", { id: "@world", component: "bounds" });   // the lab's world comes bounded
  const noBounds = s.call("move", { to: [0, 0, 0], teleport: true, reason: "below-bounds" }, "vic");
  s.call("set", { id: "@world", component: "bounds", value: { min: [-50, -10, -50], max: [50, 50, 50] } });
  s.call("set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8] } });
  const st = s.st(); const kz = -10 - SP.KILL_MARGIN; const fell = SP.belowWorld(st, [0, kz - 1, 0]), riding = SP.belowWorld(st, [0, kz - 1, 0], { riding: true }), above = SP.belowWorld(st, [0, kz + 1, 0]);   // the kill line: KILL_MARGIN below the floor
  s.call("set", { id: "@world", component: "terrain", value: { kind: "flat", height: kz - 10 } });   // ground below the bounds: a body can stand where it has fallen
  s.call("move", { to: [0, 0, 8] }, "vic"); let early: any; for (let y = -3.5; y > kz - 4; y -= 3.5) { s.call("move", { to: [0, y, 8] }, "vic"); if (!early && y < -14) early = s.call("move", { to: [0, 0, 8], teleport: true, reason: "below-bounds" }, "vic"); }   // under the floor, above the kill line: not fallen
  const away = s.call("move", { to: [30, 0, 30], teleport: true, reason: "below-bounds" }, "vic");
  const before = s.log().length;
  const back = s.call("move", { to: [0, 0, 8], teleport: true, reason: "below-bounds" }, "vic");
  const acts = s.log().slice(before).filter((e: any) => e.kind === "act" && e.verb === "move");
  const bare = s.call("move", { to: [0, 0, 8], reason: "below-bounds" }, "vic");
  return [fell && !riding && !above && back.ok && acts.length === 1 && acts[0].body?.request?.reason === "below-bounds" && acts[0].body?.request?.teleport === true
    && early?.refused?.code === "doesnt-apply" && noBounds.refused?.code === "out-of-bounds" && away.refused?.code === "spawn" && bare.refused?.code === "shape",
    { fell, riding, above, early: show(early), back: show(back), acts: acts.map((e: any) => e.body), noBounds: show(noBounds), away: show(away), bare: show(bare) }]; });

await C("K10", "@world.sky.gradient {top, horizon, bottom?} (linear 0..1) taken, a bad one refused; lookOf reads it (an absent bottom is the horizon) and the first directional light thing by id as the sun, standing along its +Z", () => {
  const s = session();
  const good = s.call("set", { id: "@world", component: "sky", value: { gradient: { top: [0.03, 0.25, 0.53], horizon: [0.5, 0.7, 0.8] } } });
  const bad = s.call("set", { id: "@world", component: "sky", value: { gradient: { top: "#338ac1", horizon: [0.5, 0.7, 0.8] } } });
  const extra = s.call("set", { id: "@world", component: "sky", value: { gradient: { top: [0, 0, 1], horizon: [1, 1, 1], zenith: [0, 0, 0] } } });
  s.call("create", { id: "z-sun", components: { transform: tf([0, 0, 0]), light: { kind: "directional", intensity: 9 } } });
  s.call("create", { id: "a-sun", components: { transform: tf([0, 0, 0], yawQ(Math.PI / 2)), light: { kind: "directional", color: 0xfff4df, intensity: 3 } } });
  s.call("create", { id: "lamp", components: { transform: tf([0, 0, 0]), light: { kind: "point" } } });
  if (!Z.lookOf) return [false, "zone.js has no lookOf"];
  const st = s.st(), look = Z.lookOf(st, st.entities["@world"].c.sky);
  return [good.ok && !bad.ok && !extra.ok && near(look.gradient?.bottom, [0.5, 0.7, 0.8]) && look.sun?.id === "a-sun" && look.sun.intensity === 3 && near(look.sun.toward, [1, 0, 0], 1e-9),
    { good: show(good), bad: show(bad), extra: show(extra), look }]; });

await C("K11", "a pose's climb {host, progress} rides the wire as sent (rounded to mm); a malformed one costs the field, never the pose", () => {
  if (PC.__missing || CL.__missing) return [false, PC.__missing ?? CL.__missing];
  const ok = PC.sanePose({ p: [0, 1, 0], climb: { host: "ladder", progress: 1.23456 } }), bad = PC.sanePose({ p: [0, 1, 0], climb: { host: "", progress: -1 } }), nan = PC.sanePose({ p: [0, 1, 0], climb: { host: "x", progress: "far" } });
  return [JSON.stringify(ok?.climb) === JSON.stringify({ host: "ladder", progress: 1.235 }) && bad && !("climb" in bad) && nan && !("climb" in nan), { ok, bad, nan }]; });

await C("K12", "floor = terrain: @world.terrain {kind: 'flat', height} is the ground (groundOf, supportBelow, the walker's floor) at its height, below 0 too; noise fields, features or a heightmap on it are refused; no terrain stands at 0", () => {
  const TM = imp("shared/terrainmath.js"), SPx = import(TREE + "shared/protocol/authority/spatial.js");
  return Promise.all([TM, SPx]).then(([tm, sp]) => {
    const s = session();
    const none = sp.groundOf(s.st()).height(3, 4);
    const good = s.call("set", { id: "@world", component: "terrain", value: { kind: "flat", height: -260 } });
    const st = s.st(), t = st.entities["@world"].c.terrain, G = sp.groundOf(st), under = sp.supportBelow(st, 300, -300, -200);
    const law = tm.makeHeightField?.(tm.terrainParams?.(t));
    const feat = s.call("set", { id: "@world", component: "terrain", value: { kind: "flat", height: 0, features: [{ type: "hill", x: 0, z: 0, radius: 4, height: 2 }] } });
    const noisy = s.call("set", { id: "@world", component: "terrain", value: { kind: "flat", height: 0, amplitude: 3 } });
    return [none === 0 && good.ok && JSON.stringify(t) === JSON.stringify({ kind: "flat", height: -260 }) && G.height(300, -300) === -260 && G.height(-9, 77) === -260 && under.id === "ground" && under.y === -260
      && law?.(12, -40) === -260 && !feat.ok && !noisy.ok, { none, good: show(good), t, G: G.height(300, -300), under, law: law?.(12, -40), feat: show(feat), noisy: show(noisy) }]; }); });

await C("K13", "KillZ is the authority's to judge: a below-bounds respawn from a body whose last known position is above @world.bounds.min.y (beyond a step's slack) is refused, saying so; an unplaced body has no position to have fallen from", () => {
  const s = session();
  s.call("set", { id: "@world", component: "bounds", value: { min: [-50, -10, -50], max: [50, 50, 50] } });
  s.call("set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8] } });
  s.call("set", { id: "@world", component: "terrain", value: { kind: "flat", height: -20 } });
  const fresh = s.call("move", { to: [0, 0, 8], teleport: true, reason: "below-bounds" }, "vic");
  s.call("move", { to: [0, 0, 8] }, "vic"); s.call("move", { to: [0, -3, 8] }, "vic");
  const above = s.call("move", { to: [0, 0, 8], teleport: true, reason: "below-bounds" }, "vic");
  return [fresh.refused?.code === "doesnt-apply" && above.refused?.code === "doesnt-apply" && /above|isn't below/.test(above.refused?.reason ?? ""), { fresh: show(fresh), above: show(above) }]; });

console.log(`[climb-env-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
