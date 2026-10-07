// tools/v4/build-check.ts — ship-list group B (AUDIT-shiplist-blockers-2026-10-07): what a builder makes, through the door.
//   bun tools/v4/build-check.ts                 every case
//   bun tools/v4/build-check.ts --only W1,N1    just those
//   bun tools/v4/build-check.ts --tree <dir>    the cases against another checkout (the base, a mutant)
//   bun tools/v4/build-check.ts --base          the base commit (7f1f1934): every case must be red there but the guards (G)
//   bun tools/v4/build-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red
// Cases (worlds open as the server opens them: server/v4/live.ts):
//   W   walls (N2): a `structure` building's walls are solid to the door (a body's track, an arrival, a teleport), its
//       doorways stay walkable, its floor holds things up, and its placeholder model is no longer an invisible crate
//   N   nested blueprints (N1): a blueprint holding two copies of another places, every time, with fresh ids
//   K   scripts from the editor (item 3): the requests the editor's "new script" sends (upload → set script:<name>)
//       run, and the script panel's read (scripts {id}) lists it running
//   F   founding (item 5): a signed-in person founds a world they own (the server's found path), within a per-account
//       cap; a guest never founds; an existing world is never taken over
//   G   guards (green at base too)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "7f1f1934";
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const ONLY = opt("only")?.split(",") ?? null;

// [name, file, find, replace, cases that must turn red]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the door reads a building's walls", "shared/v4/door.js", "const geomE = (e) => (e?.c.structure !== undefined ? structGeom(e.c.structure) : geomOf(e?.c.model));", "const geomE = (e) => geomOf(e?.c.model);", ["W1", "W2", "W3"]],
  ["a doorway is the absence of a box (every wall edge solid)", "shared/structure.js", "    const ap = level.apertures.get(k);\n    if (!ap) continue;\n    boxes.push(...wallBoxes(edge, ap, g, floorY));", "    const ap = level.apertures.get(k);\n    if (!ap) continue;\n    boxes.push(edgeSpan(edge.axis, (edge.axis === 0 ? edge.z : edge.x) * g.tile, (edge.axis === 0 ? edge.x : edge.z) * g.tile, (edge.axis === 0 ? edge.x + 1 : edge.z + 1) * g.tile, -g.wallT / 2, g.wallT / 2, floorY, floorY + g.wallH, edge.mat, 'wall'));", ["W1", "W2"]],
  ["floors are surfaces", "shared/v4/door.js", "      surfaces.push({ y, x: [x0, x1], z: [z0, z1] }); floors.push", "      floors.push", ["W3"]],
];

function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs", "client"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true, filter: (s) => !s.includes("node_modules") });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
const runSelf = (tree: string, only: string[] | null) => { const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/v4/build-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() }; };
if (argv.includes("--mutants")) {
  let bad = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    const d = copyTree("bmut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file}`); continue; }
    fs.writeFileSync(f, src.replace(find, () => repl));
    const r = runSelf(d, cases); const red = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = r.code !== 0 && cases.every((c) => red.includes(c)); if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${red.join(",") || "(none)"} (want ${cases.join(",")})`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[build-check --mutants] ${MUTANTS.length} mutations, ${bad} wrong`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--base")) {
  const d = scratch("bbase"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server tools defs client package.json | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  // the base tree has no build-check: run this file against it
  const r = runSelf(d, ONLY); const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l)); let wrong = 0;
  for (const l of lines) { const id = l.split(/\s+/)[1]; const red = l.startsWith("FAIL"); const right = id.startsWith("G") ? !red : red; if (!right) wrong++;
    console.log(`${right ? (red ? "red at base:   " : "kept at base:  ") : "WRONG AT BASE: "}${l.slice(0, 150)}`); }
  console.log(`[build-check --base] at ${BASE}: ${lines.length} cases, ${wrong} wrong`); process.exit(wrong || !lines.length ? 1 : 0);
}

// ---------------- the door, from a tree ----------------
const D = await import(TREE + "shared/v4/door.js");
const L = await import(TREE + "server/v4/live.ts");
const SE = await import(ENGINE + "shared/structure_edit.js");   // the editor's own planner makes the buildings (pure; this checkout's)
const root = scratch("build");
let T = 1800000000000, N = 0;
function open(name: string, o: any = {}) {
  const dir = path.join(root, "worlds", name); fs.mkdirSync(dir, { recursive: true });
  return L.openLive(dir, name, { now: () => Number(process.env.V4_NOW ?? T), scripts: o.scripts ?? null, custodyFile: path.join(root, "custody.json"), nameOf: () => null, kindOf: o.kindOf ?? (() => "human"), catalogue: o.catalogue });
}
function session(o: any = {}) {
  const name = `w${++N}`; const w = open(name, o);
  const call = (actor: string, tool: string, args: any = {}, step = 1000) => { T += step; process.env.V4_NOW = String(T);
    try { return D.request(w, actor, tool, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, w: () => w, call };
}
const code = (r: any) => (r?.ok ? "ok" : r?.refused?.code ?? (r?.crashed ? "crashed" : "?"));
const show = (r: any) => (r?.ok ? "ok" : `${r?.refused?.code ?? "?"}: ${r?.refused?.reason ?? r?.crashed ?? ""}`.slice(0, 160));
const T0 = (pos: number[], yaw = 0) => ({ pos, q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [1, 1, 1] });
function cast(s: any) {
  s.call("olive", "new", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "bounds", value: { min: [-200, 0, -200], max: [200, 50, 200] } });
  for (const [who, role] of [["bob", "builder"], ["vic", "visitor"], ["ann", "visitor"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
// a 4 × 4 room (cells 0..3), a door in its south wall (the edge z = 4, x 1..2) and a window in its east wall (x = 4, z 1..2),
// made by the editor's own planner (shared/structure_edit.js), as the Room / Door / Window tools make one
function house() {
  let g = SE.emptyStructure(); g = SE.drawRoom(g, { x: 0, z: 0 }, { x: 3, z: 3 });
  g = SE.setAperture(g, { axis: 0, x: 1, z: 4 }, "door"); g = SE.setAperture(g, { axis: 1, x: 4, z: 1 }, "window");
  return g;
}
const PLACEHOLDER = "crate";   // the editor's new building rides a crate model (structure_ui newBuilding); the lab's crate is measured

const cases: { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean }[] = [
  // ---------------- W: walls ----------------
  { id: "W1", what: "a building's walls are solid to the door: a body walks in through the doorway and not through a wall or a window; it arrives inside the room (where the hidden placeholder sat); a teleport into a wall is refused", run(s) { cast(s);
      const made = s.call("olive", "create", { id: "home", model: PLACEHOLDER, components: { transform: T0([10, 0, 10]), structure: house() } });
      const r: any = { made: show(made) };
      r.arrive = code(s.call("vic", "move", { to: [11.5, 0, 16] }));
      r.door = code(s.call("vic", "move", { to: [11.5, 0, 13] }));           // through the doorway (x 11..12 at z 14)
      r.inside = code(s.call("vic", "move", { to: [12.5, 0, 11.5] }));
      r.anchor = code(s.call("ann", "move", { to: [10.4, 0, 10.4] }));      // the anchor's corner, where the placeholder crate stood
      r.outWall = code(s.call("vic", "move", { to: [12.5, 0, 15.5] }));      // south through the wall at x 12.5 (not the door)
      r.arrive2 = code(s.call("bob", "move", { to: [16, 0, 11.5] }));
      r.window = code(s.call("bob", "move", { to: [12.5, 0, 11.5] }));       // west through the east window (x 14, z 11..12)
      r.tpWall = code(s.call("olive", "move", { to: [14, 0, 13] }));         // an arrival inside the east wall
      return r; },
    good: (o) => o.made === "ok" && o.arrive === "ok" && o.door === "ok" && o.inside === "ok" && o.anchor === "ok" && o.outWall === "solid" && o.arrive2 === "ok" && o.window === "solid" && o.tpWall === "solid" },
  { id: "W2", what: "a building turned 90°: its doorway and walls turn with it, as the browser's colliders turn (shared/structure.js localizePoint)", run(s) { cast(s);
      s.call("olive", "create", { id: "turned", model: PLACEHOLDER, components: { transform: T0([30, 0, 10], Math.PI / 2), structure: house() } });
      // local (x, z) → world (30 + z, 10 − x): the south door edge (z = 4, x 1..2) is at world x = 34, z 8..9
      const r: any = {};
      r.arrive = code(s.call("vic", "move", { to: [36, 0, 8.5] }));
      r.door = code(s.call("vic", "move", { to: [32.5, 0, 8.5] }));
      r.arrive2 = code(s.call("bob", "move", { to: [36, 0, 7.5] }));
      r.wall = code(s.call("bob", "move", { to: [32.5, 0, 7.5] }));
      return r; },
    good: (o) => o.arrive === "ok" && o.door === "ok" && o.arrive2 === "ok" && o.wall === "solid" },
  { id: "W3", what: "things in a building: a book put on its floor rests there with no warning; one made inside a wall is warned as overlapping the building", run(s) { cast(s);
      s.call("olive", "create", { id: "home", model: PLACEHOLDER, components: { transform: T0([10, 0, 10]), structure: house() } });
      const floorTop = 0.1;   // GRID_DEFAULTS.slabT: the floor's top
      const r: any = {};
      r.book = s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([12, floorTop, 12]), grabbable: { who: "visitor" } } });
      r.bookWarn = (s.call("olive", "check", { id: "mug" }).warnings ?? []).map((x: any) => `${x.kind}:${x.with ?? x.into ?? x.above ?? ""}`);
      r.placed = s.call("bob", "create", { id: "crate-2", model: "crate", place: { at: [12.5, 12.5] } });
      r.placedY = s.w().state().entities["crate-2"]?.c.transform?.pos?.[1];
      s.call("olive", "create", { id: "stuck", model: "crate", components: { transform: T0([14, floorTop, 12.5]) } });   // in the east wall
      r.stuckWarn = (s.call("olive", "check", { id: "stuck" }).warnings ?? []).map((x: any) => `${x.kind}:${x.with ?? ""}`);
      r.book = show(r.book); r.placed = show(r.placed);
      return r; },
    good: (o) => o.book === "ok" && o.bookWarn.length === 0 && o.placed === "ok" && Math.abs(o.placedY - 0.1) < 0.011 && o.stuckWarn.includes("overlap:home") },

];

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false;
  try { o = c.run(session()); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 900)}`}`);
}
console.log(`[build-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
