// tools/protocol/zone-water-check.ts — zone + water (on @world or a thing) + water-exclusion: the door's refusals, the bodies
// shared/zone.js reads in world space (priority, pockets, a moving carrier), @world.water as it was, the client's rebuild rule,
// and tools/water/math-test.ts's expectations on bodies built through zone.js.
//   bun tools/protocol/zone-water-check.ts                 every case
//   bun tools/protocol/zone-water-check.ts --only Z1,Z3    just those
//   bun tools/protocol/zone-water-check.ts --tree <dir>    against another checkout's shared/ (a mutant)
//   bun tools/protocol/zone-water-check.ts --mutants       remove each rule in turn (a copy of the tree): its cases must go red;
//                                                         a no-op control must stay green
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

const MUTANTS: [string, string, string, string, string[]][] = [
  ["no zone, no refusal", "protocol/authority/checks.js", "if (c.zone === undefined) return { code: \"needs\"", "if (false) return { code: \"needs\"", ["Z2"]],
  ["global water on a thing", "protocol/authority/checks.js", "const g = globalWater(id, c); if (g) return g;", "", ["Z2g"]],
  ["a zone's geometry", "protocol/authority/checks.js", "if (need && v.global !== true) for (const k of need)", "if (false) for (const k of need)", ["Z2"]],
  ["@world's level is required", "protocol/authority/checks.js", "if (comp === \"water\" && obj && id === \"@world\" && v.level === undefined) refuse(", "if (false) refuse(", ["Z6"]],
  ["priority orders the bodies", "zone.js", "const cmp = (a, b) => a.priority - b.priority ||", "const cmp = (a, b) =>", ["Z3"]],
  ["an exclusion's priority", "water.js", "&& !(w.priority > b.priority);", ";", ["Z4"]],
  ["an exclusion's bodies", "water.js", "(!Array.isArray(b.bodies) || b.bodies.includes(w.id))", "true", ["Z4"]],
  ["the carrier's pose", "zone.js", "const pose = poseOf(id); if (!pose) continue;", "const pose = { pos: c.transform?.pos ?? [0, 0, 0], q: c.transform?.q, scale: c.transform?.scale };", ["Z5"]],
  ["rebuild on every change (the old bug)", "zone.js", "if (ev?.type !== \"change\") return false;", "return true;", ["Z7"]],
  ["a pocket beats @world's level", "zone.js", "&& !volumes.airs.some((a) => inBox(p, a) && excludes(a, AT_WORLD))", "", ["Z4w"]],
  ["ties by id", "zone.js", "|| (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)", "", ["Z3t"]],
  ["attenuation as σ", "zone.js", "return c.map((x) => -Math.log(Math.max(1e-6, Math.min(1, x))) / d);", "return c.map((x) => 1 - x);", ["Z8"]],
  ["the fog's mask is the law", "zone.js", "(excludes(a, w) ? m | (1 << i) : m)", "(m | (1 << i))", ["Z10"]],
  ["the level asks the pockets", "zone.js", "return m.medium === \"air\" ? null : level;", "return level;", ["Z11"]],
  ["CONTROL (no-op: must stay green)", "zone.js", "// the components and change kinds", "//  the components and change kinds", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/zone-water-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = scratch("zmut"); for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
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
  console.log(`[zone-water-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);   // fixture-ids.ts opened ENGINE's seam; a --tree run imports another instance
const F = await import(TREE + "shared/protocol/fold.js");
const Z = await import(TREE + "shared/zone.js");
const W = await import(TREE + "shared/water.js");
const TS = await import(TREE + "shared/terrainshape.js");
const MV = await import(TREE + "shared/mover.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("zone");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
function session() {
  const name = `z${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (verb: string, args: any = {}, actor = "olive") => { clock.advance(1000);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  call("create-world", { title: name });
  return { call, st: () => Wd().state() };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)} | fix: ${String(r?.refused?.fix).slice(0, 120)}`);
const box = (size: number[], extra = {}) => ({ shape: "box", size, ...extra });
const tf = (pos: number[], q = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ pos, q, scale });

let pass = 0, fail = 0;
async function C(id: string, what: string, fn: () => any) {
  if (ONLY && !ONLY.includes(id)) return;
  let r: any; try { r = await fn(); } catch (e) { r = [false, `threw: ${e?.stack ?? e}`]; }
  const [good, info] = Array.isArray(r) ? r : [r, undefined];
  if (good) { pass++; console.log(`ok   ${id} ${what}`); } else { fail++; console.log(`FAIL ${id} ${what}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 900)); }
}

await C("Z1", "a thing with zone {box} + water is a water body; a child with zone + water-exclusion a pocket; a zone of every shape is taken", () => {
  const s = session();
  const r = [s.call("create", { id: "pool", components: { transform: tf([0, -2, 0]), zone: box([10, 4, 10]), water: { kind: "pool", color: 0x2a6070 } } }),
    s.call("create", { id: "pocket", components: { transform: tf([0, 0, 0]), parent: { to: "pool" }, zone: box([2, 2, 2], { priority: 1 }), "water-exclusion": {} } }),
    ...[{ shape: "sphere", radius: 2 }, { shape: "capsule", radius: 0.5, height: 2 }, { shape: "cylinder", radius: 1, height: 3, blend: 2, weight: 0.5 }, { shape: "box", global: true }]
      .map((z, i) => s.call("create", { id: `z${i}`, components: { transform: tf([i, 0, 0]), zone: z } }))].map(show);
  return [r.every((x) => x === "ok"), r]; });

await C("Z2", "the door refuses: water or water-exclusion with no zone (fix: it needs a sibling zone {shape, size}), the zone deleted under one, both on one thing, a non-box zone under water, a box with no size, a sphere with a size, @world-only flow on a thing's [x, y, z] kept, malformed waves", () => {
  const s = session();
  const noZone = s.call("create", { id: "a", components: { transform: tf([0, 0, 0]), water: {} } });
  const noZoneX = s.call("create", { id: "b", components: { transform: tf([0, 0, 0]), "water-exclusion": {} } });
  s.call("create", { id: "c", components: { transform: tf([0, 0, 0]), zone: box([2, 2, 2]), water: {} } });
  const dropZone = s.call("delete", { id: "c", component: "zone" });
  const both = s.call("create", { id: "d", components: { transform: tf([0, 0, 0]), zone: box([2, 2, 2]), water: {}, "water-exclusion": {} } });
  const sphere = s.call("create", { id: "e", components: { transform: tf([0, 0, 0]), zone: { shape: "sphere", radius: 2 }, water: {} } });
  const noSize = s.call("create", { id: "f", components: { transform: tf([0, 0, 0]), zone: { shape: "box" } } });
  const sizedSphere = s.call("create", { id: "g", components: { transform: tf([0, 0, 0]), zone: { shape: "sphere", radius: 1, size: [1, 1, 1] } } });
  const flow3 = s.call("create", { id: "h", components: { transform: tf([0, 0, 0]), zone: box([2, 2, 2]), water: { flow: [0, 0.5, 1] } } });
  const waves = s.call("create", { id: "i", components: { transform: tf([0, 0, 0]), zone: box([2, 2, 2]), water: { waves: [{ amplitude: 1, wavelength: 4, direction: [0, 0] }] } } });
  const onWorld = s.call("set", { id: "@world", component: "zone", value: box([1, 1, 1]) });
  const o = { noZone: show(noZone), noZoneX: show(noZoneX), dropZone: show(dropZone), both: show(both), sphere: show(sphere), noSize: show(noSize), sizedSphere: show(sizedSphere), flow3: show(flow3), waves: show(waves), onWorld: show(onWorld) };
  const fixed = (r: any) => !r.ok && /on a thing needs a sibling zone \{shape, size\}/.test(r.refused?.fix ?? "");
  return [fixed(noZone) && fixed(noZoneX) && fixed(dropZone) && !both.ok && !sphere.ok && /box/.test(sphere.refused?.reason) && !noSize.ok && /needs size/.test(noSize.refused?.reason)
    && !sizedSphere.ok && flow3.ok && !waves.ok && onWorld.refused?.code === "thing-only", o]; });

await C("Z2g", "world-wide water is @world's: a thing whose zone is global and carries water is refused with the fix that says so; a global zone alone is taken", () => {
  const s = session();
  const r = s.call("create", { id: "sea", components: { transform: tf([0, 0, 0]), zone: { shape: "box", global: true }, water: {} } });
  const alone = s.call("create", { id: "everywhere", components: { transform: tf([0, 0, 0]), zone: { shape: "box", global: true } } });
  return [!r.ok && r.refused?.fix?.startsWith("world-wide water goes on @world: set {id:'@world', component:'water'") && alone.ok, { r: show(r), alone: show(alone) }]; });

await C("Z3", "priority orders overlapping bodies: the higher wins whatever the ids; equal priority, the later id; the list runs lowest first", () => {
  const s = session();
  s.call("create", { id: "a-high", components: { transform: tf([0, -5, 0]), zone: box([10, 10, 10], { priority: 5 }), water: { kind: "lake" } } });
  s.call("create", { id: "b-low", components: { transform: tf([0, -5, 0]), zone: box([10, 10, 10]), water: { kind: "pool" } } });
  s.call("create", { id: "c-tie", components: { transform: tf([20, -5, 0]), zone: box([10, 10, 10]), water: {} } });
  s.call("create", { id: "d-tie", components: { transform: tf([20, -5, 0]), zone: box([10, 10, 10]), water: {} } });
  const z = Z.zonesOf(s.st()), v = Z.waterVolumes(z);
  const at = W.mediumAt([0, -5, 0], v.waters, v.airs)?.id, tie = W.mediumAt([20, -5, 0], v.waters, v.airs)?.id;
  const order = z.bodies.map((b) => b.id);
  return [at === "a-high" && tie === "d-tie" && order.indexOf("a-high") > order.indexOf("b-low"), { at, tie, order }]; });

await C("Z3t", "a tie is never undefined: equal priority goes by entity id order (the later id wins), whatever order the things were made in", () => {
  const s = session();
  for (const id of ["m-tie", "c-tie", "x-tie", "a-tie"]) s.call("create", { id, components: { transform: tf([0, -5, 0]), zone: box([10, 10, 10], { priority: 3 }), water: {} } });
  const z = Z.zonesOf(s.st()), v = Z.waterVolumes(z), m = Z.mediumOf([0, -5, 0], z);
  return [m.body === "x-tie" && W.mediumAt([0, -5, 0], v.waters, v.airs)?.id === "x-tie" && z.bodies.map((b) => b.id).join() === "a-tie,c-tie,m-tie,x-tie", { m, order: z.bodies.map((b) => b.id) }]; });

await C("Z4w", "an exclusion beats @world's level too: a pocket below sea level is dry, the sea beside it wet; a pocket naming only a thing body leaves the sea wet", () => {
  const s = session();
  s.call("set", { id: "@world", component: "water", value: { level: 0, flow: [0.5, 0] } });
  s.call("create", { id: "hull", components: { transform: tf([0, -6, 0]), zone: box([4, 4, 4]), "water-exclusion": {} } });
  s.call("create", { id: "picky", components: { transform: tf([20, -6, 0]), zone: box([4, 4, 4], { priority: 5 }), "water-exclusion": { bodies: ["somewhere"] } } });
  const z = Z.zonesOf(s.st());
  const o = { hull: Z.mediumOf([0, -6, 0], z), sea: Z.mediumOf([6, -6, 0], z), picky: Z.mediumOf([20, -6, 0], z), above: Z.mediumOf([6, 1, 0], z) };
  return [o.hull.medium === "air" && o.hull.body === null && o.sea.medium === "water" && o.sea.body === "@world" && o.sea.level === 0 && JSON.stringify(o.sea.flow) === "[0.5,0,0]"
    && o.picky.body === "@world" && o.above.medium === "air", o]; });

await C("Z9", "the one reader: {medium, level, flow, body, priority}; a thing body above the sea decides there (the sea is lowest), its flow turned into the world by its own rotation, and it inherits nothing from @world's", () => {
  const s = session();
  s.call("set", { id: "@world", component: "water", value: { level: 0, flow: [9, 0], kind: "ocean" } });
  s.call("create", { id: "river", components: { transform: tf([0, -1, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]), zone: box([10, 4, 10], { blend: 3, weight: 0.2 }), water: { level: 1.5, flow: [1, 0] } } });
  const m = Z.mediumOf([1, -1, 1], Z.zonesOf(s.st()));
  const near = (a: number[], b: number[]) => Array.isArray(a) && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  return [JSON.stringify(Object.keys(m)) === JSON.stringify(["medium", "level", "flow", "body", "priority"]) && m.medium === "water" && m.body === "river" && m.priority === 0 && m.level === 0.5 && near(m.flow, [0, 0, -1]), m]; });

await C("Z4", "an exclusion inside a body makes mediumAt dry (and cuts waterPath); one below the body's priority, or naming another body, leaves it wet", () => {
  const s = session();
  s.call("create", { id: "tank", components: { transform: tf([0, -10, 0]), zone: box([100, 20, 100], { priority: 2 }), water: {} } });
  s.call("create", { id: "room", components: { transform: tf([0, -5, 0]), zone: box([4, 4, 4], { priority: 2 }), "water-exclusion": {} } });
  s.call("create", { id: "weak", components: { transform: tf([20, -5, 0]), zone: box([4, 4, 4], { priority: 1 }), "water-exclusion": {} } });
  s.call("create", { id: "other", components: { transform: tf([-20, -5, 0]), zone: box([4, 4, 4], { priority: 9 }), "water-exclusion": { bodies: ["nothing-here"] } } });
  const v = Z.waterVolumes(Z.zonesOf(s.st())), tank = v.waters.find((w) => w.id === "tank");
  const o = { room: W.mediumAt([0, -5, 0], v.waters, v.airs)?.id ?? null, beside: W.mediumAt([4, -5, 0], v.waters, v.airs)?.id ?? null,
    weak: W.mediumAt([20, -5, 0], v.waters, v.airs)?.id ?? null, other: W.mediumAt([-20, -5, 0], v.waters, v.airs)?.id ?? null,
    path: W.waterPath([-10, -5, 0], [10, -5, 0], tank, v.airs) };
  return [o.room === null && o.beside === "tank" && o.weak === "tank" && o.other === "tank" && o.path === 16, o]; });

await C("Z5", "a moving parent carries both: its body and the pocket under it move with it (world space through the parent chain), the old spot goes dry", () => {
  const s = session();
  s.call("create", { id: "sub", components: { transform: tf([0, 0, 0]) } });
  s.call("create", { id: "ballast", components: { transform: tf([0, -3, 0]), parent: { to: "sub" }, zone: box([6, 4, 6]), water: {} } });
  s.call("create", { id: "cabin", components: { transform: tf([0, -3, 0]), parent: { to: "sub" }, zone: box([2, 2, 2], { priority: 1 }), "water-exclusion": {} } });
  const before = Z.waterVolumes(Z.zonesOf(s.st()));
  const moved = s.call("set", { id: "sub", component: "transform", value: tf([50, -10, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]) });
  const z = Z.zonesOf(s.st()), v = Z.waterVolumes(z);
  const o = { moved: show(moved), body: z.bodies.find((b) => b.id === "ballast")?.center, cabin: z.exclusions.find((x) => x.id === "cabin")?.center,
    wetBeside: W.mediumAt([52, -13, 0], v.waters, v.airs)?.id ?? null, dryCabin: W.mediumAt([50, -13, 0], v.waters, v.airs)?.id ?? null,
    oldWet: W.mediumAt([2, -3, 0], before.waters, before.airs)?.id ?? null, oldNow: W.mediumAt([2, -3, 0], v.waters, v.airs)?.id ?? null };
  const near = (a: number[], b: number[]) => a && a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
  return [moved.ok && near(o.body, [50, -13, 0]) && near(o.cabin, [50, -13, 0]) && o.wetBeside === "ballast" && o.dryCabin === null && o.oldWet === "ballast" && o.oldNow === null, o]; });

await C("Z6", "@world.water is as it was: stored as sent, read by terrainshape's waterParams as before, one global body zonesOf leaves out of the volumes; a level is still required there, and its flow is still [x, z]", () => {
  const s = session();
  const value = { level: 1.5, color: 0x1d5a6e, opacity: 0.8, kind: "ocean", flow: [0.2, 0] };
  const r = s.call("set", { id: "@world", component: "water", value });
  const stored = s.st().entities["@world"].c.water; const z = Z.zonesOf(s.st());
  const noLevel = s.call("set", { id: "@world", component: "water", value: { color: 0x1d5a6e } });
  const flow3 = s.call("set", { id: "@world", component: "water", value: { level: 1, flow: [0, 0, 1] } });
  const o = { r: show(r), stored, read: TS.waterParams({ water: stored }), bodies: z.bodies.map((b) => `${b.id}:${b.global}:${b.top}`), volumes: Z.waterVolumes(z).waters.length, noLevel: show(noLevel), flow3: show(flow3) };
  return [r.ok && JSON.stringify(stored) === JSON.stringify(value) && JSON.stringify(o.read) === JSON.stringify({ level: 1.5, color: "#1d5a6e", opacity: 0.8 })
    && o.bodies.join() === "@world:true:1.5" && o.volumes === 0 && !noLevel.ok && /needs level/.test(noLevel.refused?.reason) && !flow3.ok, o]; });

await C("Z7", "the client rebuilds only on what the bodies read: a zone/water/water-exclusion change, a holder's or its carrier's pose or parent, @world.water, a reset; never an unrelated thing, a holder's label, or the sky", () => {
  const ents = { fresh: { zone: box([1, 1, 1]), water: {} }, pool: { zone: box([1, 1, 1]), water: {}, parent: { to: "boat" } }, boat: {}, chair: {}, room: { zone: box([1, 1, 1]), "water-exclusion": {} } };
  const owners = new Set(["pool", "room"]);
  const T = (ev: any) => Z.zoneChangeTouches(ev, ents, owners);
  const yes = [{ type: "reset" }, { type: "hydrated" }, { type: "world", key: "water" }, { type: "change", id: "pool", what: "comp", comp: "water" }, { type: "change", id: "fresh", what: "comp", comp: "zone" },
    { type: "change", id: "boat", what: "pose" }, { type: "change", id: "pool", what: "parent" }, { type: "change", id: "room", what: "gone" }, { type: "change", id: "pool", what: "comp", comp: "water-exclusion" }];
  const no = [{ type: "change", id: "chair", what: "pose" }, { type: "change", id: "chair", what: "comp", comp: "label" }, { type: "change", id: "pool", what: "comp", comp: "label" },
    { type: "world", key: "sky" }, { type: "change", id: "chair", what: "born" }];
  return [yes.every(T) && !no.some(T), { yes: yes.map(T), no: no.map(T) }]; });

await C("Z8", "attenuation converts to upstream's σ per metre exactly (σ = −ln(c) / d, KHR_materials_volume); scatterColor rides as the scatter; absent, waterParams' own", () => {
  const s = session();
  s.call("create", { id: "clear", components: { transform: tf([0, -2, 0]), zone: box([4, 4, 4]), water: { attenuationColor: [Math.exp(-0.16 * 10), Math.exp(-0.055 * 10), Math.exp(-0.025 * 10)], attenuationDistance: 10, scatterColor: [0.1, 0.2, 0.3] } } });
  s.call("create", { id: "plain", components: { transform: tf([10, -2, 0]), zone: box([4, 4, 4]), water: {} } });
  const v = Z.waterVolumes(Z.zonesOf(s.st())); const c = v.waters.find((w) => w.id === "clear"), p = v.waters.find((w) => w.id === "plain");
  const near = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-12);
  return [near(c.absorption, [0.16, 0.055, 0.025]) && near(c.scatter, [0.1, 0.2, 0.3]) && JSON.stringify(p.absorption) === JSON.stringify(W.waterParams({}).absorption), { clear: c.absorption, plain: p.absorption }]; });

await C("Z10", "the GPU fog's uniforms are the law's: each pocket's mask clears @world's level and exactly the bodies at or below its priority (only its bodies when named), slot for slot as excludes() says; the shader reads that mask", () => {
  const s = session();
  s.call("set", { id: "@world", component: "water", value: { level: 0 } });
  s.call("create", { id: "low", components: { transform: tf([0, -5, 0]), zone: box([20, 10, 20]), water: {} } });
  s.call("create", { id: "high", components: { transform: tf([0, -5, 0]), zone: box([20, 10, 20], { priority: 5 }), water: {} } });
  s.call("create", { id: "mid", components: { transform: tf([0, -5, 0]), zone: box([2, 2, 2], { priority: 2 }), "water-exclusion": {} } });
  s.call("create", { id: "named", components: { transform: tf([5, -5, 0]), zone: box([2, 2, 2], { priority: 9 }), "water-exclusion": { bodies: ["high"] } } });
  s.call("create", { id: "sealevel", components: { transform: tf([-5, -5, 0]), zone: box([2, 2, 2], { priority: 9 }), "water-exclusion": { bodies: ["@world"] } } });
  const z = Z.zonesOf(s.st()), v = Z.waterVolumes(z), f = Z.fogSlots(v), lim = Z.fogSlots(v, { maxWater: 1 });
  const law = (slots: any) => slots.airs.map((a: any) => [{ id: "@world", priority: -Infinity }, ...slots.waters].reduce((m: number, w: any, i: number) => (W.excludes(a, w) ? m | (1 << i) : m), 0));
  const src = fs.readFileSync(path.join(ENGINE, "client/lib/watervolumes.js"), "utf8");
  const reads = ["const fogFn", "export const dryAt", "const particleAlpha"].every((k) => { const i = src.indexOf(k); return i >= 0 && /clears\(/.test(src.slice(i, src.indexOf("\n});", i))); });
  const o = { airs: f.airs.map((a: any) => a.id), masks: f.masks, law: law(f), lim: { waters: lim.waters.map((w: any) => w.id), masks: lim.masks }, writes: /fogSlots\(/.test(src) && /dryExtent\.array\[i\]\.set\([^)]*mask/.test(src), reads };
  return [o.airs.join() === "mid,named,sealevel" && o.masks.join() === "3,4,1" && o.law.join() === o.masks.join() && o.lim.waters.join() === "high" && o.lim.masks.join() === "1,2,1" && o.writes && o.reads, o]; });

await C("Z11", "the client's level asks mediumOf: worldLevelAt is null in a pocket below sea level (a pocket naming only a thing body leaves it), the level beside it, above it and in a world with no pockets (unchanged)", () => {
  const s = session();
  s.call("set", { id: "@world", component: "water", value: { level: 0 } });
  const none = Z.zonesOf(s.st());
  s.call("create", { id: "room", components: { transform: tf([0, -6, 0]), zone: box([4, 4, 4]), "water-exclusion": {} } });
  s.call("create", { id: "picky", components: { transform: tf([20, -6, 0]), zone: box([4, 4, 4], { priority: 5 }), "water-exclusion": { bodies: ["somewhere"] } } });
  const z = Z.zonesOf(s.st()), L = (p: number[], zz = z) => Z.worldLevelAt(p, zz, 0);
  const o = { room: L([0, -7.5, 0]), beside: L([6, -7.5, 0]), above: L([0, 3, 0]), picky: L([20, -7.5, 0]), none: [L([0, -7.5, 0], none), L([0, 3, 0], none)], noLevel: Z.worldLevelAt([0, -7.5, 0], z, null) };
  return [o.room === null && o.beside === 0 && o.above === 0 && o.picky === 0 && o.none.join() === "0,0" && o.noLevel === null, o]; });

// tools/water/math-test.ts's expectations, on bodies and pockets built through zone.js (a thing's zone, not a hand-made box)
await C("ZM", "math-test on zone-built bodies: wet/dry boundaries, a pocket, path lengths (nested, overlapping, rotated pockets), ascent to the float, diving, a half-size body, waves", () => {
  const s = session(); const FLOAT = MV.floatDepth(MV.MOVER.body.height); const bad: string[] = [];
  const eq = (k: string, a: any, b: any) => { if (a !== b) bad.push(`${k}: ${a} != ${b}`); }, ok = (k: string, c: boolean) => { if (!c) bad.push(k); };
  s.call("create", { id: "sea", components: { transform: tf([0, -10, 0]), zone: box([100, 20, 100]), water: {} } });
  s.call("create", { id: "box1", components: { transform: tf([0, -5, 0]), zone: box([4, 4, 4]), "water-exclusion": {} } });
  const v = Z.waterVolumes(Z.zonesOf(s.st())), water = v.waters[0], [b1] = v.airs;
  eq("above", W.mediumAt([0, 2, 0], [water], []), null); eq("outside", W.mediumAt([70, -5, 0], [water], []), null);
  eq("in the pocket", W.mediumAt([0, -5, 0], [water], [b1]), null); eq("beside it", W.mediumAt([4, -5, 0], [water], [b1]), water);
  eq("through twice", W.waterPath([-10, -5, 0], [10, -5, 0], water, [b1, b1]), 16); eq("inside", W.waterPath([0, -5, 0], [1, -5, 0], water, [b1]), 0);
  eq("down through the top", W.waterPath([0, 10, 0], [0, -10, 0], water, []), 10); eq("zero length", W.waterPath([0, -5, 0], [0, -5, 0], water, []), 0);
  s.call("create", { id: "box2", components: { transform: tf([2, -5, 0]), zone: box([4, 4, 4]), "water-exclusion": {} } });
  s.call("create", { id: "box3", components: { transform: tf([0, -5, 0]), zone: box([2, 2, 2]), "water-exclusion": {} } });
  s.call("create", { id: "turned", components: { transform: tf([0, -5, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]), zone: box([8, 2, 2]), "water-exclusion": {} } });
  const air = (id: string) => Z.waterVolumes(Z.zonesOf(s.st())).airs.find((a) => a.id === id);
  ok("overlapping", Math.abs(W.waterPath([-10, -5, 0], [10, -5, 0], water, [b1, air("box2")]) - 14) < 1e-9);
  eq("nested", W.waterPath([-10, -5, 0], [10, -5, 0], water, [b1, air("box3")]), 16);
  eq("rotated: dry along its long side", W.mediumAt([0, -5, 3], [water], [air("turned")]), null);
  ok("rotated: path", Math.abs(W.waterPath([-10, -5, 0], [10, -5, 0], water, [air("turned")]) - 18) < 1e-9);
  let st = { pos: [0, -4, 0], velocity: [0, 0, 0] } as any;
  for (let i = 0; i < 300; i++) st = W.swimStep(st.pos, st.velocity, { direction: [0, 1, 0], rise: true }, water, 1 / 60, i / 60);
  eq("surfaced", st.mode, "surface"); ok("floats at the mover's depth", Math.abs(st.pos[1] + FLOAT) < 1e-8);
  for (let i = 0; i < 60; i++) st = W.swimStep(st.pos, st.velocity, { direction: [0, -1, 0], dive: true }, water, 1 / 60, i / 60);
  ok("dived", st.pos[1] < -2); eq("swimming", st.mode, "swim");
  let half = { pos: [0, -4, 0], velocity: [0, 0, 0] } as any;
  for (let i = 0; i < 300; i++) half = W.swimStep(half.pos, half.velocity, { direction: [0, 1, 0], rise: true, stature: 0.5 }, water, 1 / 60, i / 60);
  eq("half surfaced", half.mode, "surface"); ok("half floats half as deep", Math.abs(half.pos[1] + FLOAT / 2) < 1e-8);
  s.call("set", { id: "sea", component: "water", value: { waves: [{ amplitude: 0.4, wavelength: 10, direction: [1, 0], phase: Math.PI / 2 }] } });
  const wavy = Z.waterVolumes(Z.zonesOf(s.st())).waters[0];
  ok("a wave crest", Math.abs(W.waveHeight(wavy, 0, 0, 0) - 0.4) < 1e-10);
  ok("the body's box spans its zone", water.top === 0 && water.bottom === -20);
  return [!bad.length, bad]; });

console.log(`[zone-water-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
