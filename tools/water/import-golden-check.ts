// tools/water/import-golden-check.ts — upstream's public #248 world (world-data/water/manifest.json) through tools/water/import.ts
// --dry: the zone / water / water-exclusion things it asks for, their parents and priorities, the features it holds back (none now)
// its vehicle (drive + a helm), climb routes, collision toggle and environment as mapped, the batch taken by a real authority, and shared/zone.js mediumOf on the result agreeing
// with main's own mediumAt (main's shared/water.js at MAIN, from git) on main's reading of the same records.
//   bun tools/water/import-golden-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { ENGINE, scratch } from "../protocol/common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "../protocol/clock.ts";

const MAIN = "ccd5c53fa";   // upstream main (#281's merge): its shared/water.js is the reference reader
let pass = 0, fail = 0;
const C = (id, what, good, info) => { if (good) { pass++; console.log(`ok   ${id} ${what}`); } else { fail++; console.log(`FAIL ${id} ${what}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 900)); } };

const manifestPath = path.join(ENGINE, "world-data/water/manifest.json"), manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const run = Bun.spawnSync(["bun", path.join(ENGINE, "tools/water/import.ts"), manifestPath, "--dry"], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
let dry = null; try { dry = JSON.parse(run.stdout.toString()); } catch {}
C("G0", "import.ts --dry prints its requests (exit 0)", run.exitCode === 0 && dry?.requests?.length === 1, { code: run.exitCode, err: run.stderr.toString().slice(-400) });
if (!dry) { console.log(`[import-golden-check] ${pass} passed, ${fail} failed`); process.exit(1); }

const ops = dry.requests[0].args.ops, creates = ops.filter((o) => o.verb === "create").map((o) => o.args);
const bodies = creates.filter((a) => a.components.water), pockets = creates.filter((a) => a.components["water-exclusion"]);
const by = (host) => pockets.filter((a) => a.components.parent?.to === `$${host}`);
const b = bodies[0]?.components;
C("G1", "one water body: a child of water-terrain at main's centre, zone {box, 2000 × 250 × 2000} at priority 0, σ as attenuation, main's four waves; main's swim speed 2.4 is the stroke here, so no drag is written (translate-v1@31)",
  bodies.length === 1 && b.parent?.to === "$water-terrain" && JSON.stringify(b.transform.pos) === "[0,-125,0]" && JSON.stringify(b.zone) === JSON.stringify({ shape: "box", size: [2000, 250, 2000] })
  && b.water.attenuationDistance === 1 && b.water.attenuationColor.every((c, i) => Math.abs(-Math.log(c) - [0.1, 0.036, 0.018][i]) < 1e-15) && b.water.waves.length === 4 && b["imported:water"] === undefined && b["physics-area"] === undefined && b.water.drag === undefined, b);
const main = Object.fromEntries(manifest.verbs.filter((v) => v.verb === "comp" && v.args.type === "air").map((v) => [v.args.id, v.args.data.boxes]));
const sameBoxes = (host) => by(host).length === main[host].length && by(host).every((a, i) => JSON.stringify(a.components.zone.size) === JSON.stringify(main[host][i].size) && JSON.stringify(a.components.transform.pos) === JSON.stringify(main[host][i].center));
C("G2", "fifteen pockets, one per main air box: 8 under water-habitat, 7 under water-submarine, each zone {box, main's size} + water-exclusion {} at main's centre, priority 1 (above the body's 0)",
  pockets.length === 15 && sameBoxes("water-habitat") && sameBoxes("water-submarine") && pockets.every((a) => a.components.zone.priority === 1 && JSON.stringify(a.components["water-exclusion"]) === "{}"),
  pockets.map((a) => [a.components.parent?.to, a.components.zone]));
const banned = creates.filter((a) => Object.keys(a.components).some((k) => /(^|\/)(traversal|vehicle|collision|air|environment)(:|$)/.test(k)));
C("G3", "nothing held back: no use is deferred; no `air`, `traversal`, `vehicle`, `collision` or `environment` component goes out; the volumes, the three climb routes, the vehicle, the collision toggle and the environment (and its bounds lowered under the floor) are listed as mapped",
  JSON.stringify(dry.deferred) === "[]" && banned.length === 0
  && JSON.stringify(dry.mapped.map((m) => [m.component, m.id, m.into.length])) === JSON.stringify([["water", "water-terrain", 1], ["air", "water-habitat", 8], ["air", "water-submarine", 7],
    ["traversal", "water-habitat", 1], ["traversal", "water-platform", 1], ["collision", "water-scenery", 1], ["traversal", "water-submarine", 1], ["vehicle", "water-submarine", 4], ["environment", "water-terrain", 6], ["environment", "water-terrain", 1]]), { deferred: dry.deferred, banned: banned.map((a) => a.id), mapped: dry.mapped });
const climbs = creates.filter((a) => a.components.climb), mainRoute = (host) => manifest.verbs.find((v) => v.verb === "comp" && v.args.type === "traversal" && v.args.id === host)?.args.data.routes[0];
C("G3c", "each of main's three routes is a climb child of its host: main's path as points, radius as reach, speed, name as label; the scenery's collision toggle is collider {enabled: false}, its spawn collide exact as shape mesh (translate-v1@24, SWEEP-3)",
  climbs.length === 3 && ["water-habitat", "water-submarine", "water-platform"].every((h) => { const a = climbs.find((x) => x.components.parent?.to === `$${h}`), m = mainRoute(h);
    return a && JSON.stringify(a.components.climb) === JSON.stringify({ points: m.path, reach: m.radius, speed: m.speed }) && a.components.label === m.name; })
  && JSON.stringify(creates.find((a) => a.id === "$water-scenery")?.components.collider) === JSON.stringify({ shape: "mesh", enabled: false }), climbs);
const envMain = manifest.verbs.find((v) => v.verb === "comp" && v.args.type === "environment").args.data, setOf = (k) => ops.find((o) => o.verb === "set" && o.args.id === "@world" && o.args.component === k)?.args.value;
C("G3e", "main's environment: @world.spawn and bounds as main's (min.y 2 m under the floor when the floor lies below it: #248), @world.sky.gradient, @world.terrain flat at main's floor (no floor thing), a directional sun and a dust child; ambient and the particles' count and range (clamped) listed as unmapped; vehicle probes listed with what becomes of them (FATES; minY/maxY and water speed are mapped since translate-v1@29, R 10-28 item 50)",
  JSON.stringify(setOf("spawn")) === JSON.stringify({ pos: envMain.spawn }) && JSON.stringify(setOf("bounds")) === JSON.stringify({ min: [envMain.bounds.min[0], Math.min(envMain.bounds.min[1], envMain.floor - 2), envMain.bounds.min[2]], max: envMain.bounds.max }) && !!setOf("sky")?.gradient
  && JSON.stringify(setOf("terrain")) === JSON.stringify({ kind: "flat", height: envMain.floor }) && !creates.some((a) => a.components.hidden === true && a.components.mesh?.shape === "box" && !a.components.collider?.blocks) && creates.some((a) => a.components.light?.kind === "directional") && creates.some((a) => a.components.particles?.effect === "dust" && a.components.parent?.to === "$water-terrain")
  && JSON.stringify(dry.unmapped.map(({ becomes, ...u }) => u)) === JSON.stringify([{ component: "environment", id: "water-terrain", fields: ["sky.ambient", "particles.count, particles.range"], as: "water-terrain imported:environment" },
    { component: "vehicle", id: "water-submarine", fields: ["probes"], as: "water-submarine imported:vehicle" }])
  && dry.unmapped[0].becomes === undefined && /retired: the authority's hull sweep/.test(dry.unmapped[1].becomes?.probes) && dry.unmapped[1].becomes?.minY === undefined,
  { unmapped: dry.unmapped, sets: ops.filter((o) => o.verb === "set").map((o) => o.args.component) });

// the batch through a real authority (a scratch world): placeholders minted, every op taken
const D = await import(ENGINE + "shared/protocol/authority.js"), F = await import(ENGINE + "shared/protocol/fold.js"), Z = await import(ENGINE + "shared/zone.js");
const root = scratch("water-golden"), clock = labClock();
function openWorld(name) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const blobPath = (h) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries: F.readLog(readLogBytes(logPath)).map(D.posAt), getBlob: (h) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; }, now: () => pinned(), writeLine: (line) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null, custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const w = openWorld("water"); const call = (verb, args) => { clock.advance(1000); return D.request(w, "olive", verb, args); };
call("create-world", { title: "water" });
// the models as --apply sends them: the library path each upload became (here a stock model; the bundle's GLBs aren't in the repo)
const CRATE = "crate", swap = (v) => (typeof v === "string" && /^store\/models\//.test(v) ? CRATE : Array.isArray(v) ? v.map(swap) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
const r = call("batch", swap(dry.requests[0].args));
const st = w.state(), id = (name) => r.ids?.[`$${name}`];
C("G4", "a real authority takes the whole batch: every create and set, its placeholders minted, each pocket and the body under its minted host",
  r.ok && Object.keys(r.ids ?? {}).length === creates.length && st.entities[id(bodies[0].id.slice(1))]?.c.parent?.to === id("water-terrain") && by("water-submarine").every((a) => st.entities[id(a.id.slice(1))]?.c.parent?.to === id("water-submarine")),
  { refused: r.refused, ids: Object.keys(r.ids ?? {}).length });
{ const DRV = await import(ENGINE + "shared/drive.js"), sub = id("water-submarine"), helm = DRV.helmOf?.(st, sub), m = manifest.verbs.find((v) => v.verb === "comp" && v.args.type === "vehicle").args.data;
  C("G4v", "main's vehicle drives here: the authority took drive on the submarine (maxSpeed main's speed, climbRate the same) and its helm child where main's helm was, exit as main's",
    !!helm && JSON.stringify(DRV.driveOf(st.entities[sub]?.c)) === JSON.stringify({ maxSpeed: m.speed, turnRate: m.turnRate, climbRate: m.speed, response: 1 / 1.5, throttle: false })
    && JSON.stringify(st.entities[helm].c.transform.pos) === JSON.stringify(m.helm) && JSON.stringify(st.entities[helm].c.station.exit) === JSON.stringify(m.exit), { helm, drive: st.entities[sub]?.c.drive }); }
{ const SPX = await import(ENGINE + "shared/protocol/authority/spatial.js"), G = SPX.groundOf(st), down: any[] = [];
  const tp = call("move", { to: [300, -240, -300], teleport: true }); for (let y = -243.5; y > -260; y -= 3.5) down.push(call("move", { to: [300, y, -300] }));
  down.push(call("move", { to: [300, -260, -300] })); const under = SPX.supportBelow(w.state(), 300, -300, -250);
  C("G4f", "the floor is the ground: a swimmer descends far below y 0 toward main's floor and stands on it at its height (groundOf and supportBelow at -260, the authority's walk taking every step down)",
    G.height(300, -300) === envMain.floor && G.height(-29, 89) === envMain.floor && tp.ok && down.every((x) => x.ok) && under.id === "ground" && under.y === envMain.floor && w.presence.bodies.olive?.at?.[1] === envMain.floor,
    { G: G.height(300, -300), tp: tp.refused, down: down.filter((x) => !x.ok).map((x) => x.refused), under, at: w.presence.bodies.olive?.at }); }

// main's vehicle band (vehicles.js: minY/maxY clamp the hull) is two hidden walls only hulls meet (translate-v1@29, R 10-28 item 50)
{ const m = manifest.verbs.find((v) => v.verb === "comp" && v.args.type === "vehicle").args.data, sub = id("water-submarine");
  const walls = creates.filter((a) => JSON.stringify(a.components.collider?.blocks) === '["hulls"]'), at = (a) => a.components.transform;
  const floor = walls.find((a) => /minY/.test(a.components.label)), ceil = walls.find((a) => /maxY/.test(a.components.label));
  const top = (a) => at(a).pos[1] + a.components.mesh.size[1] * at(a).scale[1];
  const shape = walls.length === 2 && walls.every((a) => a.components.hidden === true && !a.components.parent) && top(floor) === m.minY && at(ceil).pos[1] === m.maxY;
  // a real hull at the band's edges: the authority's sweep stops it at each wall (the stock model's box stands on its origin)
  const s0 = w.state(), t0 = s0.entities[sub].c.transform, H = (await import(ENGINE + "shared/protocol/authority/math.js")).aabb(s0, sub);
  const rise = t0.pos[1] - H.min[1], tall = H.max[1] - H.min[1], drive = (y) => { clock.advance(1000); return D.request(w, "olive", "drive", { id: sub, pos: [t0.pos[0], y, t0.pos[2]], q: t0.q }); };
  const lowY = m.minY + rise + 1, highY = m.maxY - tall + rise - 1;
  const SL = await import(ENGINE + "shared/protocol/simlayer.js"), steps: any = {};
  const board = (y, k) => { steps[`off${k}`] = call("move", { to: [t0.pos[0] + 20, y, t0.pos[2]], teleport: true }); steps[`set${k}`] = call("set", { id: sub, component: "transform", value: { ...t0, pos: [t0.pos[0], y, t0.pos[2]] } });
    const hp = SL.worldPose(w.state(), DRV0.helmOf(w.state(), sub)).pos; steps[`go${k}`] = call("move", { to: [hp[0] + 1, hp[1], hp[2]], teleport: true }); steps[`use${k}`] = call("use", { id: sub, action: "drive" }); };
  const DRV0 = await import(ENGINE + "shared/drive.js");
  board(lowY, "Low"); steps.down = drive(lowY - 0.8); steps.under = drive(lowY - 2);
  steps.offMid = call("move", { to: [t0.pos[0] + 20, lowY, t0.pos[2]], teleport: true }); clock.advance(5000); D.drives?.(w);   // the low lease ends (heartbeat lost)
  board(highY, "High"); steps.up = drive(highY + 0.8); steps.over = drive(highY + 2);
  const said = Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v.ok ? "ok" : `${v.refused?.code}: ${v.refused?.blocker ?? ""} ${String(v.refused?.reason).slice(0, 100)}`]));
  C("G4w", "main's minY/maxY are a floor wall (its top at minY) and a ceiling wall (its bottom at maxY), hidden and only hulls meet them; driven at the band's edge, the hull stops at each (refused solid naming the wall), short of it is taken",
    shape && steps.useLow.ok && steps.useHigh.ok && steps.down.ok && steps.under.refused?.code === "solid" && steps.under.refused.blocker === id(floor.id.slice(1)) && steps.up.ok && steps.over.refused?.code === "solid" && steps.over.refused.blocker === id(ceil.id.slice(1)),
    { shape, walls: walls.map((a) => [a.components.label, at(a)]), said, H, rise }); }
// with the hull measured (the host's catalogue: translate's boxOf), the walls are set off by its reach, so the ORIGIN keeps main's band exactly
{ const TV1 = await import(ENGINE + "tools/protocol/import-v1/translate-v1.js"), m = manifest.verbs.find((v) => v.verb === "comp" && v.args.type === "vehicle").args.data;
  const MATH = await import(ENGINE + "shared/protocol/authority/math.js");
  const band = (q) => { const o = openWorld(`water-o${q[0] ? "f" : "u"}`), go = (verb, args) => { clock.advance(1000); return D.request(o, "olive", verb, args); };
    go("create-world", { title: "o" }); const pos = [26, -100, 60];
    go("set", { id: "@world", component: "terrain", value: { kind: "flat", height: -300 } }); go("set", { id: "@world", component: "bounds", value: { min: [-100, -290, -100], max: [100, 50, 150] } });
    const made = go("batch", { ops: [{ verb: "create", args: { id: "$sub", components: { transform: { pos, q, scale: [1, 1, 1] }, model: CRATE, drive: { maxSpeed: 4, turnRate: 0.4, climbRate: 4 } } } },
      { verb: "create", args: { id: "$helm", components: { transform: { pos: [0, 0.3, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, parent: { to: "$sub" }, socket: { name: "helm" }, station: { action: "drive", input: { move: "drive" } } } } }] });
    if (!made.ok) return { hull: null, said: { made: `${made.refused?.code}: ${made.refused?.reason}` }, good: false };
    const sub = made.ids.$sub, helm = made.ids.$helm;
    const H = MATH.aabb(o.state(), sub), hull = TV1.hullExtentOf([H.min.map((v, i) => v - pos[i]), H.max.map((v, i) => v - pos[i])]);
    const walls = go("batch", { ops: TV1.vehiclePartsOf("sub", m, hull).walls.map(([, c], k) => ({ verb: "create", args: { id: `$w${k}`, components: c } })) });
    const drive = (y) => { clock.advance(1000); return D.request(o, "olive", "drive", { id: sub, pos: [pos[0], y, pos[2]], q }); }, at = (y) => go("set", { id: sub, component: "transform", value: { pos: [pos[0], y, pos[2]], q, scale: [1, 1, 1] } });
    const leave = () => { go("move", { to: [pos[0] + 30, -100, pos[2]], teleport: true }); clock.advance(5000); D.drives?.(o); };
    const board = () => { const hp = (SLw.worldPose(o.state(), helm)).pos; go("move", { to: [hp[0] + 1, hp[1], hp[2]], teleport: true }); return go("use", { id: sub, action: "drive" }); };
    const r = { walls }; at(m.minY + 0.5); r.useLow = board(); r.toMin = drive(m.minY + 0.1); r.belowMin = drive(m.minY - 0.4); leave();
    at(m.maxY - 0.5); r.useHigh = board(); r.toMax = drive(m.maxY - 0.1); r.aboveMax = drive(m.maxY + 0.4);
    return { hull, said: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.ok ? "ok" : `${v.refused?.code} ${v.refused?.blocker ?? ""}`])), good: r.useLow.ok && r.toMin.ok && r.belowMin.refused?.code === "solid" && r.useHigh.ok && r.toMax.ok && r.aboveMax.refused?.code === "solid" }; };
  const SLw = await import(ENGINE + "shared/protocol/simlayer.js");
  const up = band([0, 0, 0, 1]), flip = band([1, 0, 0, 0]);   // upright: the box reaches above the origin; upside down: below it
  C("G4o", "with the hull measured, the origin keeps main's band exactly: driven to 0.1 m inside minY and maxY it is taken, 0.4 m past either it is refused solid, upright (the box above its origin) and upside down (below)",
    up.good && flip.good && up.hull?.above > 0.3 && flip.hull?.below > 0.3, { up, flip }); }
// main's shared/water.js, written and imported ONCE (two copies of the same source: macOS bun failed to resolve the second, CI 10-29)
let mainWaterP: Promise<any> | undefined;
const mainWater = () => mainWaterP ??= (async () => { const ref = path.join(root, "main-water.js"), g = spawnSync("git", ["-C", ENGINE, "show", `${MAIN}:shared/water.js`], { encoding: "utf8" });
  if (g.status !== 0) { C("G5", `main's shared/water.js at ${MAIN} (git show)`, false, g.stderr); console.log(`[import-golden-check] ${pass} passed, ${fail} failed`); process.exit(1); }
  fs.writeFileSync(ref, g.stdout); return import(ref); })();
// main's swim speed: a stroke in the volume (zone.js, the area's factor, the mover) is main's swimStep at that speed, for main's 2.4 and another
{ const TV1 = await import(ENGINE + "tools/protocol/import-v1/translate-v1.js"), WJ = await import(ENGINE + "shared/water.js"), Mw = await mainWater();
  const stroke = (step, water, input) => { let p = [0, -50, 0], v = [0, 0, 0]; for (let i = 0; i < 400; i++) { const n = step(p, v, input, water, 0.05, 0); p = n.pos; v = n.velocity; } return Math.hypot(...v); };
  const vol = Z.waterVolumes(Z.zonesOf(st)).waters[0];
  const rows = [2.4, 1.2, 6].map((speed) => { const drag = speed === 2.4 ? vol.drag : TV1.waterOfOld({ center: [0, 0, 0], size: [9, 9, 9], speed }).water.drag;
    return { speed, drag, ours: stroke(WJ.swimStep, { ...vol, drag }, { direction: [1, 0, 0], dive: true }), main: stroke(Mw.swimStep, Mw.waterParams({ speed }), { direction: [1, 0, 0], dive: true }) }; });
  C("G4s", "main's water.speed is the swim speed here: the volume's stroke against the water's drag (the translator's, 5 × 2.4 / speed) is main's swimStep at that speed (2.4 with no drag written, 1.2 and 6), walkers untouched",
    rows.every((r) => Math.abs(r.ours - r.main) < 1e-9 && Math.abs(r.main - r.speed) < 1e-3), rows); }
// main's reading of the same records (its client's watervolumes: entity matrix × comp centre; air box = matrix × (centre, q))
const M = await mainWater();
const { qRotate, qConj, qMul, qFromYaw } = await import(ENGINE + "shared/rot.js");
const ents = {}; for (const v of manifest.verbs) if (v.verb === "spawn") ents[v.args.id] = { pos: v.args.pos, q: qFromYaw(v.args.yaw ?? 0), comp: {} }; else if (v.verb === "comp") ents[v.args.id].comp[v.args.type] = v.args.data;
const upWaters = [], upAirs = [];
for (const eid of Object.keys(ents).sort((a, b) => a.localeCompare(b))) { const e = ents[eid];
  if (e.comp.water) { const p = M.waterParams(e.comp.water), c = qRotate(e.q, p.center); p.center = c.map((x, i) => x + e.pos[i]); p.top = p.center[1] + p.size[1] / 2; p.bottom = p.center[1] - p.size[1] / 2; upWaters.push(p); }
  for (const bx of e.comp.air?.boxes ?? []) { const q = qMul(e.q, bx.q ?? [0, 0, 0, 1]), c = qRotate(e.q, M.vector(bx.center)).map((x, i) => x + e.pos[i]);
    upAirs.push({ size: M.vector(bx.size, [1, 1, 1]).map((x) => Math.max(0.001, Math.abs(x))), toLocal: (p) => qRotate(qConj(q), [p[0] - c[0], p[1] - c[1], p[2] - c[2]]) }); } }
const zones = Z.zonesOf(st), vol = Z.waterVolumes(zones);
const world = (host, local) => { const e = ents[host]; return qRotate(e.q, local).map((x, i) => x + e.pos[i]); };
const NAMED = { "open water": [0, -50, 0], "deep, by the floor": [300, -240, -300], "inside the habitat's main room": world("water-habitat", [0, 1.45, 0]), "the habitat's end lock": world("water-habitat", [0, 1.5, 5.55]),
  "just outside the habitat's wall": world("water-habitat", [3.2, 1.45, 0]), "the submarine's aisle": world("water-submarine", [0, -1.0, -10]), "the submarine's bow chamber": world("water-submarine", [0, 0, -19.6]),
  "beside the submarine": world("water-submarine", [4, 0, -10]), "above the surface": [0, 2, 0], "just under the surface": [10, -1, 10], "below the body's bottom": [0, -260, 0], "beyond its edge": [1200, -10, 0] };
const WANT = { "open water": true, "deep, by the floor": true, "inside the habitat's main room": false, "the habitat's end lock": false, "just outside the habitat's wall": true, "the submarine's aisle": false,
  "the submarine's bow chamber": false, "beside the submarine": true, "above the surface": false, "just under the surface": true, "below the body's bottom": false, "beyond its edge": false };
const got = Object.fromEntries(Object.entries(NAMED).map(([k, p]) => [k, { ours: Z.mediumOf(p, zones, { volumes: vol }).medium === "water", main: M.mediumAt(p, upWaters, upAirs) !== null }]));
C("G5", "mediumOf at the named points (open water, inside a dry room, the submarine's aisle, above the surface, below the body, beyond it) is main's mediumAt there, and what the place is",
  Object.entries(got).every(([k, v]) => v.ours === v.main && v.main === WANT[k]), got);
// mechanically: a seeded scatter around the habitat, the submarine and the surface, at two wave times
let seed = 1234567; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const around = (c, h) => c.map((x, i) => x + (rnd() * 2 - 1) * h[i]);
let n = 0, diff = [], wet = 0, pocketed = 0;
for (const t of [0, 7.3]) for (let i = 0; i < 4000; i++) {
  const p = i % 3 === 0 ? around(world("water-habitat", [0, 2, 0]), [5, 4, 7]) : i % 3 === 1 ? around(world("water-submarine", [0, 0, -9]), [4, 3, 12]) : around([0, 0, 0], [900, 1.2, 900]);
  const ours = Z.mediumOf(p, zones, { time: t, volumes: vol }).medium === "water", theirs = M.mediumAt(p, upWaters, upAirs, t) !== null; n++;
  wet += ours; pocketed += !ours && p[1] < -2 && upAirs.some((a) => M.inBox(p, a));
  if (ours !== theirs) diff.push({ p, t, ours, theirs });
}
C("G6", `${n} seeded points around the habitat, the submarine and the waves (t 0 and 7.3 s): mediumOf and main's mediumAt agree on every one`, diff.length === 0 && wet > 1000 && pocketed > 500, { count: diff.length, first: diff.slice(0, 3), wet, pocketed });
// G7: the same world as upstream main itself saved it (tools/protocol/fixtures/water-old-v1: main's server, the manifest's verbs,
// its own snapshot.json) agrees with the old engine under the translator's last check, the one an upgrade must pass
{ const fx = path.join(ENGINE, "tools/protocol/fixtures/water-old-v1"), dir = fs.mkdtempSync(path.join(os.tmpdir(), "water-old-"));
  fs.cpSync(fx, path.join(dir, "water-old"), { recursive: true });
  const o = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/import-v1/snapshot-oracle.ts")], { cwd: ENGINE, env: { ...process.env, ORACLE_WORLDS: dir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const out = o.stdout.toString() + o.stderr.toString(), line = out.split("\n").find((l) => /water-old/.test(l) && /(FAIL|agree|OK|ok)/.test(l)) ?? "";
  C("G7", "main's own saved water world (log + snapshot.json) translates with no unexplained difference from the old engine", /-- water-old\b[^\n]*— (ok|agrees|0 unexplained)/i.test(out) || (o.exitCode === 0 && !/FAIL water-old/.test(out)), { exit: o.exitCode, line, tail: out.split("\n").filter((l) => /DIFF|FAIL/.test(l)).slice(0, 4) }); }
console.log(`[import-golden-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
