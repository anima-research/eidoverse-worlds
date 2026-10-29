// tools/protocol/physics-area-check.ts — physics-area {kind: speed, factor} on a zone (R 10-28 item 50; Godot Area3D, Unreal
// Physics Volume): the door, shared/zone.js's reader, the one mover (walk, wade, swim, the 3D stroke) and the authority's track.
//   bun tools/protocol/physics-area-check.ts                 every case
//   bun tools/protocol/physics-area-check.ts --only A1,A3    just those
//   bun tools/protocol/physics-area-check.ts --tree <dir>    against another checkout's shared/ and server/ (a mutant, or the base)
//   bun tools/protocol/physics-area-check.ts --mutants       remove each rule in turn (a copy of the tree): its cases must go red
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
  ["the walk ignores the area", "mover.js", "const k = env.speedAt ? areaFactor(env.speedAt(pos)) : 1;", "const k = 1;", ["A3", "A5"]],
  ["the 3D stroke ignores the area", "mover.js", "* areaFactor(water.factor) *", "*", ["A3"]],
  ["the track never widens", "protocol/authority/bodyverbs.js", "tokensAfter(me.tokens, now - (me.ts ?? now), k)", "tokensAfter(me.tokens, now - (me.ts ?? now))", ["A4", "A5"]],
  ["the track narrows in mud", "mover.js", "k = Math.max(1, areaFactor(factor));", "k = areaFactor(factor);", ["A4"]],
  ["the lowest priority wins", "zone.js", "for (let i = (areas?.length ?? 0) - 1; i >= 0; i--) { const a = areas[i];", "for (let i = 0; i < (areas?.length ?? 0); i++) { const a = areas[i];", ["A2"]],
  ["any zone holds an area", "protocol/authority/checks.js", "if (c[\"physics-area\"] !== undefined && !(c.zone?.shape === \"box\" || c.zone?.global === true)) return", "if (false) return", ["A1"]],
  ["CONTROL (no-op: must stay green)", "zone.js", "// shared/zone.js — a world's", "//  shared/zone.js — a world's", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/physics-area-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = scratch("pamut"); for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
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
  console.log(`[physics-area-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const imp = async (p: string) => { try { return await import(TREE + p); } catch (e) { return { __missing: String(e?.message ?? e).slice(0, 160) }; } };
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const M = await import(TREE + "shared/mover.js");
const Z = await imp("shared/zone.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("parea");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries: F.readLog(readLogBytes(logPath)).map(D.posAt), getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line), presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
const tf = (pos: number[], q = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ pos, q, scale });
// a speed area: a 40 × 4 × 40 m box centred at [0, 1, 0]
const AREA = (factor: number, zone: any = { shape: "box", size: [40, 4, 40] }, pos = [0, 1, 0]) => ({ transform: tf(pos), zone, "physics-area": { kind: "speed", factor } });
function session() {
  const name = `a${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (verb: string, args: any = {}, actor = "olive", ms = 1000) => { clock.advance(ms);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  call("create-world", { title: name });
  call("set", { id: "@world", component: "roles:vic", value: { role: "member" } });
  return { call, st: () => Wd().state(), w: Wd };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;

let pass = 0, fail = 0;
async function C(id: string, what: string, fn: () => any) {
  if (ONLY && !ONLY.includes(id)) return;
  let r: any; try { r = await fn(); } catch (e) { r = [false, `threw: ${e?.stack ?? e}`]; }
  const [good, info] = Array.isArray(r) ? r : [r, undefined];
  if (good) { pass++; console.log(`ok   ${id} ${what}`); } else { fail++; console.log(`FAIL ${id} ${what}`); if (info !== undefined) console.log("     ", JSON.stringify(info).slice(0, 900)); }
}

await C("A1", "the door: physics-area needs a sibling box (or global) zone, kind speed, factor 0.05..10; deleting the zone under one is refused", () => {
  const s = session(); const mk = (id: string, components: any) => s.call("create", { id, components });
  const r: any = { bare: mk("a", { transform: tf([0, 0, 0]), "physics-area": { kind: "speed", factor: 2 } }), ball: mk("b", AREA(2, { shape: "sphere", radius: 3 })),
    kind: mk("c", { ...AREA(2), "physics-area": { kind: "wind" } }), zero: mk("d", AREA(0)), huge: mk("e", AREA(20)),
    box: mk("f", AREA(0.5)), global: mk("g", AREA(1.5, { shape: "box", size: [1, 1, 1], global: true })), plain: mk("h", { ...AREA(1), "physics-area": { kind: "speed" } }) };
  r.unzone = s.call("delete", { id: "f", component: "zone" });
  return [!r.bare.ok && r.bare.refused?.code === "needs" && !r.ball.ok && !r.kind.ok && !r.zero.ok && !r.huge.ok && r.box.ok && r.global.ok && r.plain.ok && !r.unzone.ok,
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

await C("A2", "shared/zone.js: inside a box area its factor, outside 1; the higher priority wins where two overlap; a turned, scaled box is read in its own frame; a global area is everywhere; a switched-off one is nothing", () => {
  if (Z.__missing || !Z.physicsAreasOf) return [false, Z.__missing ?? "no physicsAreasOf"];
  const q45 = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  const st = { entities: {
    mud: { c: AREA(0.5, { shape: "box", size: [10, 4, 10] }) },
    pad: { c: { ...AREA(3, { shape: "box", size: [2, 4, 2], priority: 5 }) } },
    low: { c: { ...AREA(7, { shape: "box", size: [2, 4, 2], priority: -5 }) } },
    turned: { c: { transform: tf([50, 1, 0], q45, [2, 1, 1]), zone: { shape: "box", size: [4, 4, 1] }, "physics-area": { kind: "speed", factor: 2 } } },
    off: { c: { ...AREA(9, { shape: "box", size: [4, 4, 4] }, [100, 1, 0]), disabled: true } } } };
  const A = Z.physicsAreasOf(st), at = (p: number[]) => Z.speedFactorAt(A, p);
  const r = { mud: at([4, 0.5, 4]), pad: at([0, 0.5, 0]), out: at([20, 0.5, 0]), above: at([0, 4, 0]), alongTurned: at([50 + 3 * Math.SQRT1_2, 1, -3 * Math.SQRT1_2]), acrossTurned: at([50 + 3 * Math.SQRT1_2, 1, 3 * Math.SQRT1_2]), off: at([100, 1, 0]),
    global: Z.speedFactorAt(Z.physicsAreasOf({ entities: { g: { c: AREA(1.5, { shape: "box", size: [1, 1, 1], global: true }) } } }), [999, 999, 999]) };
  return [r.mud === 0.5 && r.pad === 3 && r.out === 1 && r.above === 1 && r.alongTurned === 2 && r.acrossTurned === 1 && r.off === 1 && r.global === 1.5, r]; });

await C("A3", "the one mover: a walk, a run, a wade and a swim (the level's stroke) cover factor × their metres where env.speedAt says so; the 3D stroke (stepSwim) eases toward factor × its speed; no area changes nothing", () => {
  const walk = (env: any, extra: any = {}) => M.stepWalk({ pos: [0, 0, 0], dir: [1, 0], dt: 0.5, ...extra }, env).moved;
  const pool = (lvl: number) => ({ floorAt: () => 0, waterAt: () => lvl });
  const x2 = { speedAt: () => 2 }, half = { speedAt: () => 0.5 };
  const r = { walk: [walk({}), walk(x2)], run: [walk({}, { run: true }), walk(x2, { run: true })], wade: [walk(pool(0.85)), walk({ ...pool(0.85), ...half })], swim: [walk(pool(3)), walk({ ...pool(3), ...x2 })] };
  const sw = (factor?: number) => { let v = [0, 0, 0], p = [0, -5, 0]; for (let i = 0; i < 200; i++) { const n = M.stepSwim(p, v, { direction: [1, 0, 0], dive: true }, { speed: 2.4, factor, surfaceAt: () => 0 }, 0.05); p = n.pos; v = n.velocity; } return v[0]; };
  const stroke = [sw(), sw(2), sw(0)];
  return [near(r.walk[1], 2 * r.walk[0]) && near(r.run[1], 2 * r.run[0]) && near(r.wade[1], 0.5 * r.wade[0]) && r.wade[0] < r.walk[0] && near(r.swim[1], 2 * r.swim[0])
    && near(stroke[0], 2.4, 1e-3) && near(stroke[1], 4.8, 1e-3) && near(stroke[2], 2.4, 1e-3), { r, stroke }]; });

await C("A4", "the authority's track: in a ×2 area a body may cover twice the track (an 8 m step after a rest is taken; outside it is refused too-fast); in a ×0.5 area the track doesn't narrow (a 4 m step is taken)", () => {
  const s = session(); s.call("create", { id: "pad", components: AREA(2) });
  const r: any = { in0: s.call("move", { to: [-4, 0, 0] }, "vic") }; r.in8 = s.call("move", { to: [4, 0, 0] }, "vic", 3000);
  const t = session(); t.call("create", { id: "pad", components: AREA(2, { shape: "box", size: [4, 4, 4] }, [-15, 1, 0]) });
  r.out0 = t.call("move", { to: [2, 0, 0] }, "vic"); r.out8 = t.call("move", { to: [10, 0, 0] }, "vic", 3000);
  const u = session(); u.call("create", { id: "mud", components: AREA(0.5) });
  r.mud0 = u.call("move", { to: [-2, 0, 0] }, "vic"); r.mud4 = u.call("move", { to: [2, 0, 0] }, "vic", 3000);
  return [r.in0.ok && r.in8.ok && r.out0.ok && r.out8.refused?.code === "too-fast" && r.mud0.ok && r.mud4.ok, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

await C("A5", "the mover and the authority agree: a run's strides in a ×2.5 area (the shared mover's, 10 m/s, at 10 Hz for 2 s) are every one taken; the same strides outside the area are refused once the track runs dry", () => {
  if (!Z.physicsAreasOf) return [false, "no physicsAreasOf"];
  const s = session(); s.call("create", { id: "jet", components: AREA(2.5, { shape: "box", size: [80, 4, 20] }) });
  const A = Z.physicsAreasOf(s.st()), env = { speedAt: (p: number[]) => Z.speedFactorAt(A, p) };
  let pos = [-10, 0, 0]; const path: number[][] = []; for (let i = 0; i < 20; i++) { pos = M.stepWalk({ pos, dir: [1, 0], dt: 0.1, run: true }, env).pos; path.push(pos); }
  const first = s.call("move", { to: [-10, 0, 0] }, "vic", 2000);
  const inside = path.map((p) => s.call("move", { to: p }, "vic", 100));
  const t = session(); t.call("create", { id: "jet", components: AREA(2.5, { shape: "box", size: [80, 4, 20] }) });
  t.call("move", { to: [-10, 0, 15] }, "vic", 2000); const outside = path.map((p) => t.call("move", { to: [p[0], p[1], p[2] + 15] }, "vic", 100));
  const span = path.at(-1)[0] + 10;
  return [first.ok && near(span, 20, 1e-6) && inside.every((x) => x.ok) && outside.some((x) => x.refused?.code === "too-fast"),
    { span, inside: inside.filter((x) => !x.ok).map(show).slice(0, 3), outside: outside.filter((x) => !x.ok).length }]; });

console.log(`[physics-area-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
