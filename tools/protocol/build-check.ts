// tools/protocol/build-check.ts — ship-list group B (AUDIT-shiplist-blockers-2026-10-07): what a builder makes, through the authority.
//   bun tools/protocol/build-check.ts                 every case
//   bun tools/protocol/build-check.ts --only W1,N1    just those
//   bun tools/protocol/build-check.ts --tree <dir>    the cases against another checkout (the base, a mutant)
//   bun tools/protocol/build-check.ts --base          the base commit (7f1f1934): every case must be red there but the guards (G)
//   bun tools/protocol/build-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red
// Cases (worlds open as the server opens them: server/livehost.ts):
//   W   walls (N2): a `structure` building's walls are solid to the authority (a body's track, an arrival, a teleport), its
//       doorways stay walkable, its floor holds things up, and its placeholder model is no longer an invisible crate
//   N   nested blueprints (N1): a blueprint holding two copies of another places, every time, with fresh ids
//   K   scripts from the editor (item 3): the requests the editor's "new script" sends (shared/protocol/newscript.js: upload,
//       then one batch) run, and the script panel's read (scripts {id}) lists it active
//   (founding a world, item 5, needs a real server: tools/protocol/fork-reset-check.ts FD; the editor's gestures:
//    tools/protocol/build-probe.ts, a real browser)
//   U   blueprint updates (Antra's review of f91840e5): a part reparented upstream is reparented by update (U1); a copy
//       updated to a newer record and re-published keeps its parts' keys, so updating another copy matches part to
//       part — one child, not two (U2)
//   G   guards (green at base too)
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "7f1f1934";
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const ONLY = opt("only")?.split(",") ?? null;

// [name, file, find, replace, cases that must turn red]. Not listed: partKeys' lineage-first order (a defence: it keeps
// a re-published copy's own parts on their keys when a nested part names the same key; the dedupe alone already makes
// N1/N2 place, and G1 holds the re-publish).
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the authority reads a building's walls", "shared/protocol/authority/catalogue.js", "const geomE = (e) => (e?.c.structure !== undefined ? structGeom(e.c.structure) : e?.c.mesh", "const geomE = (e) => (false ? structGeom(e.c.structure) : e?.c.mesh", ["W1", "W2", "W3"]],
  ["a doorway is the absence of a box (every wall edge solid)", "shared/structure.js", "    const ap = level.apertures.get(k);\n    if (!ap) continue;\n    boxes.push(...wallBoxes(edge, ap, g, floorY));", "    const ap = level.apertures.get(k);\n    if (!ap) continue;\n    boxes.push(edgeSpan(edge.axis, (edge.axis === 0 ? edge.z : edge.x) * g.tile, (edge.axis === 0 ? edge.x : edge.z) * g.tile, (edge.axis === 0 ? edge.x + 1 : edge.z + 1) * g.tile, -g.wallT / 2, g.wallT / 2, floorY, floorY + g.wallH, edge.mat, 'wall'));", ["W1", "W2"]],
  ["floors are surfaces", "shared/protocol/authority/catalogue.js", "      surfaces.push({ y, x: [x0, x1], z: [z0, z1] }); floors.push", "      floors.push", ["W3"]],
  ["a key already taken falls back (no twins)", "shared/protocol/authority/blueprints.js", "const k = taken.has(want) ? null : want;", "const k = want;", ["N4"]],
  ["a new script never takes over the thing's own use", "shared/protocol/newscript.js", "  if (!r.use || mine(\"use\")) return \"use\";", "  return \"use\";", ["K2"]],
  ["a use script gets its reaction", "shared/protocol/newscript.js", "...(action ? [set(form.id, \"reactions\"", "...(false ? [set(form.id, \"reactions\"", ["K1", "K2"]],
  ["update merges a part's parent", "shared/protocol/authority/blueprints.js", "const unmerged = new Set([\"copy-of\"]);", "const unmerged = new Set([\"copy-of\", \"parent\"]);", ["U1"]],
  ["a lineage's parts advance with the root", "shared/protocol/authority/blueprints.js", "if (id !== a.copy && T[key] && c?.from === was)", "if (false)", ["U2"]],
  ["an old record's twin keys each get an id", "shared/protocol/authority/blueprints.js", "if (!seen.has(p.key)) { seen.add(p.key); return ids.get(p.key); }", "return ids.get(p.key);", ["N3"]],
];

function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs", "client"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true, filter: (s) => !s.includes("node_modules") });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
const runSelf = (tree: string, only: string[] | null) => { const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/build-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
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

// ---------------- the authority, from a tree ----------------
const D = await import(TREE + "shared/protocol/authority.js");
// fixture-ids.ts opened the fixture seam on ENGINE's authority; a --tree run (mutants, control) imports another instance
D.fixtureIds?.(true);
const L = await import(TREE + "server/livehost.ts");
const SB = await import(TREE + "shared/protocol/sandbox.js");
const NS = await import(TREE + "shared/protocol/newscript.js").catch(() => null);   // absent at the base commit: the editor had no planner
const SE = await import(ENGINE + "shared/structure_edit.js");   // the editor's own planner makes the buildings (pure; this checkout's)
const root = scratch("build");
let T = 1800000000000, N = 0;
function open(name: string, o: any = {}) {
  const dir = path.join(root, "worlds", name); fs.mkdirSync(dir, { recursive: true });
  return L.openLive(dir, name, { now: () => Number(process.env.PROTOCOL_NOW ?? T), scripts: o.scripts ?? null, custodyFile: path.join(root, "custody.json"), nameOf: () => null, kindOf: o.kindOf ?? (() => "human"), catalogue: o.catalogue });
}
function session(o: any = {}) {
  const name = `w${++N}`; const w = open(name, { scripts: SB.SANDBOX, ...o });
  const call = (actor: string, verb: string, args: any = {}, step = 1000) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(w, actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, w: () => w, call };
}
const code = (r: any) => (r?.ok ? "ok" : r?.refused?.code ?? (r?.crashed ? "crashed" : "?"));
const show = (r: any) => (r?.ok ? "ok" : `${r?.refused?.code ?? "?"}: ${r?.refused?.reason ?? r?.crashed ?? ""}`.slice(0, 160));
const T0 = (pos: number[], yaw = 0) => ({ pos, q: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], scale: [1, 1, 1] });
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "bounds", value: { min: [-200, 0, -200], max: [200, 50, 200] } });
  for (const [who, role] of [["bob", "builder"], ["vic", "inhabitant"], ["ann", "inhabitant"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
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
  { id: "W1", what: "a building's walls are solid to the authority: a body walks in through the doorway and not through a wall or a window; it arrives inside the room (where the hidden placeholder sat); a teleport into a wall is refused", run(s) { cast(s);
      const made = s.call("olive", "create", { id: "home", model: PLACEHOLDER, components: { transform: T0([10, 0, 10]), structure: house() } });
      const r: any = { made: show(made) };
      r.arrive = code(s.call("vic", "move", { to: [11.5, 0, 16] }));
      r.door = code(s.call("vic", "move", { to: [11.5, 0, 13] }));           // through the doorway (x 11..12 at z 14)
      r.inside = code(s.call("vic", "move", { to: [12.5, 0, 11.5] }));
      r.anchor = code(s.call("ann", "move", { to: [10.4, 0, 10.4] }));      // the anchor's corner, where the placeholder crate stood
      r.outWall = code(s.call("vic", "move", { to: [12.5, 0, 15.5] }));      // south through the wall at x 12.5 (not the authority)
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
      r.book = s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([12, floorTop, 12]), grabbable: { who: "inhabitant" } } });
      r.bookWarn = (s.call("olive", "lint", { id: "mug" }).warnings ?? []).map((x: any) => `${x.kind}:${x.with ?? x.into ?? x.above ?? ""}`);
      r.placed = s.call("bob", "create", { id: "crate-2", model: "crate", place: { at: [12.5, 12.5] } });
      r.placedY = s.w().state().entities["crate-2"]?.c.transform?.pos?.[1];
      s.call("olive", "create", { id: "stuck", model: "crate", components: { transform: T0([14, floorTop, 12.5]) } });   // in the east wall
      r.stuckWarn = (s.call("olive", "lint", { id: "stuck" }).warnings ?? []).map((x: any) => `${x.kind}:${x.with ?? ""}`);
      r.book = show(r.book); r.placed = show(r.placed);
      return r; },
    good: (o) => o.book === "ok" && o.bookWarn.length === 0 && o.placed === "ok" && Math.abs(o.placedY - 0.1) < 0.011 && o.stuckWarn.includes("overlap:home") },

  // ---------------- N: nested blueprints ----------------
  { id: "N1", what: "publish a leg, copy it twice under a table top, publish the top: every copy of the table places, each part with its own fresh id, the legs riding the top", run(s) { cast(s);
      const r: any = {};
      s.call("bob", "create", { id: "leg", model: "crate", components: { transform: T0([0, 0, 0]), label: "a leg" } });
      const legRec = s.call("bob", "publish", { from: "leg", name: "leg" }); r.legRec = show(legRec);
      const legHash = legRec.notes?.find((n: any) => n.record)?.record;
      s.call("bob", "create", { id: "top", model: "table", components: { transform: T0([5, 0, 5]), label: "a table top" } });
      const l1 = s.call("bob", "create", { from: legHash, at: { pos: [4, 0, 4] } }), l2 = s.call("bob", "create", { from: legHash, at: { pos: [6, 0, 6] } });
      r.copies = [show(l1), show(l2)];
      const ids = Object.keys(s.w().state().entities).filter((k) => s.w().state().entities[k].c["copy-of"]?.from === legHash);
      for (const [k, id] of ids.entries()) s.call("bob", "set", { id, component: "parent", value: { to: "top" } }), s.call("bob", "set", { id, component: "transform", value: T0([k ? 0.5 : -0.5, 0, 0]) });
      const tableRec = s.call("bob", "publish", { from: "top", name: "table" }); r.tableRec = show(tableRec);
      const h = tableRec.notes?.find((n: any) => n.record)?.record; const rec = h ? s.w().getBlob(h) : null;
      r.keys = rec?.parts.map((p: any) => p.key) ?? null;
      r.placed = []; r.parts = [];
      for (let k = 0; k < 3; k++) { const c = s.call("bob", "create", { from: h, at: { pos: [20 + 3 * k, 0, 20] } }); r.placed.push(show(c));
        const st = s.w().state(); const mine = Object.keys(st.entities).filter((x) => st.entities[x].c["copy-of"]?.from === h);
        r.parts.push(mine.length); }
      const st = s.w().state(); const copies = Object.keys(st.entities).filter((x) => st.entities[x].c["copy-of"]?.from === h);
      const roots = copies.filter((x) => !st.entities[x].c.parent); const legsOf = (root: string) => copies.filter((x) => st.entities[x].c.parent?.to === root).length;
      r.legsPerRoot = roots.map(legsOf); r.unique = new Set(copies).size === copies.length;
      return r; },
    good: (o) => o.legRec === "ok" && o.copies.every((x: string) => x === "ok") && o.tableRec === "ok" && Array.isArray(o.keys) && new Set(o.keys).size === o.keys.length && o.keys.length === 3
      && o.placed.every((x: string) => x === "ok") && JSON.stringify(o.parts) === "[3,6,9]" && JSON.stringify(o.legsPerRoot) === "[2,2,2]" && o.unique },
  { id: "N2", what: "a group publish of the two leg copies places, twice", run(s) { cast(s);
      s.call("bob", "create", { id: "leg", model: "crate", components: { transform: T0([0, 0, 0]) } });
      const lh = s.call("bob", "publish", { from: "leg", name: "leg" }).notes?.find((n: any) => n.record)?.record;
      const a = s.call("bob", "create", { from: lh, at: { pos: [4, 0, 4] } }), b = s.call("bob", "create", { from: lh, at: { pos: [6, 0, 4] } });
      const st0 = s.w().state(); const legs = Object.keys(st0.entities).filter((k) => st0.entities[k].c["copy-of"]?.from === lh);
      const g = s.call("bob", "publish", { from: legs, name: "pair" }); const gh = g.notes?.find((n: any) => n.record)?.record;
      const rec = gh ? s.w().getBlob(gh) : null;
      const p1 = s.call("bob", "create", { from: gh, at: { pos: [20, 0, 0] } }), p2 = s.call("bob", "create", { from: gh, at: { pos: [24, 0, 0] } });
      return { made: [show(a), show(b)], group: show(g), keys: rec?.parts.map((p: any) => p.key) ?? null, p1: show(p1), p2: show(p2) }; },
    good: (o) => o.group === "ok" && Array.isArray(o.keys) && new Set(o.keys).size === o.keys.length && o.p1 === "ok" && o.p2 === "ok" },
  { id: "N3", what: "a record published before keys were unique (two parts keyed 'leg') still places, twice, every part with its own id", run(s) { cast(s);
      const t = (x: number) => ({ pos: [x, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] });
      const rec = { name: "table", root: "top", by: "bob", parts: [{ key: "top", components: { transform: t(0), model: "table" } },
        { key: "leg", components: { transform: t(-0.5), model: "crate", parent: { to: "top" } } }, { key: "leg", components: { transform: t(0.5), model: "crate", parent: { to: "top" } } }] };
      const h = s.w().putBlob(rec);
      const lib = s.call("olive", "set", { id: "@world", component: `blueprints:${String(h).replace(/^sha256:/, "")}`, value: { name: "table", parts: 3 } });
      const p1 = s.call("bob", "create", { from: h, at: { pos: [20, 0, 0] } }), p2 = s.call("bob", "create", { from: h, at: { pos: [24, 0, 0] } });
      const st = s.w().state(); const copies = Object.keys(st.entities).filter((x) => st.entities[x].c["copy-of"]?.from === h);
      return { model: show(lib), p1: show(p1), p2: show(p2), n: copies.length, kids: copies.filter((x) => st.entities[x].c.parent).map((x) => st.entities[x].c.parent.to) }; },
    good: (o) => o.model === "ok" && o.p1 === "ok" && o.p2 === "ok" && o.n === 6 && o.kids.length === 4 },
  { id: "N4", what: "a group holding a thing whose id is 'root' (the key a group's own root takes): every part keeps a key of its own, and it places", run(s) { cast(s);
      s.call("bob", "create", { id: "root", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "stool", model: "crate", components: { transform: T0([2, 0, 0]) } });
      const h = s.call("bob", "publish", { from: ["root", "stool"], name: "pair" }).notes?.find((n: any) => n.record)?.record;
      const keys = h ? s.w().getBlob(h).parts.map((p: any) => p.key) : null;
      const placed = s.call("bob", "create", { from: h, at: { pos: [20, 0, 0] } });
      const st = s.w().state(); const copies = Object.keys(st.entities).filter((x) => st.entities[x].c["copy-of"]?.from === h);
      return { keys, placed: show(placed), n: copies.length, occupants: copies.filter((x) => st.entities[x].c.parent).length }; },
    good: (o) => Array.isArray(o.keys) && o.keys.length === 3 && new Set(o.keys).size === 3 && o.placed === "ok" && o.n === 3 && o.occupants === 2 },

  // ---------------- K: a script from the editor ----------------
  // the card's requests (shared/protocol/newscript.js), as client/lib/scriptnew.js sends them: upload, then ONE batch
  { id: "K1", what: "the editor's new use-script: upload → one batch (script:<name> + its reaction) → a visitor's use runs it → scripts {id} lists it active", run(s) { cast(s);
      if (!NS) return { planner: "absent" };
      s.call("olive", "create", { id: "bell", model: "crate", components: { transform: T0([0, 0, 0]), label: "a bell" } });
      const thing = s.w().state().entities.bell.c;
      const plan = NS.planNewScript({ id: "bell", name: "Ring Me!", text: NS.TEMPLATES.use, trigger: "use", comps: NS.TEMPLATE_SCOPE.use.comps, say: NS.TEMPLATE_SCOPE.use.say }, thing);
      if (plan.errors.length) return { errors: plan.errors };
      const up = s.call("olive", plan.upload.verb, plan.upload.args);
      const ops = plan.install(up.src); const inst = s.call("olive", "batch", { ops });
      const acts = s.w().entries.filter((e: any) => e.kind === "act" && e.verb === "batch").length;
      const use = s.call("vic", "use", { id: "bell" });
      const st = s.w().state().entities.bell.c;
      const view = s.call("vic", "scripts", { id: "bell" });
      const said = s.w().entries.filter((e: any) => e.kind === "say").map((e: any) => e.body?.text).at(-1) ?? null;
      return { name: plan.name, action: plan.action, up: show(up), inst: show(inst), acts, use: show(use), ran: use.script?.status ?? null, counter: st["local/counter"] ?? null, said,
        listed: (view.scripts ?? []).map((x: any) => `${x.script}:${x.status}`) }; },
    good: (o) => o.name === "ring-me" && o.action === "use" && o.up === "ok" && o.inst === "ok" && o.acts === 1 && o.use === "ok" && o.counter?.n === 1 && /used me \(1\)/.test(o.said ?? "") && o.listed.includes("script:ring-me:active") },
  { id: "K2", what: "a thing whose use already opens a door keeps its reaction: the new script answers its own action, and a timer script needs every ≥ 5", run(s) { cast(s);
      if (!NS) return { planner: "absent" };
      s.call("olive", "create", { id: "gate", model: "crate", components: { transform: T0([0, 0, 0]), openable: { open: false }, reactions: { use: { kind: "toggle", component: "openable" } } } });
      const thing = s.w().state().entities.gate.c;
      const plan = NS.planNewScript({ id: "gate", name: "chime", text: NS.TEMPLATES.use, trigger: "use", comps: ["t/counter"], say: true }, thing);
      const up = s.call("olive", "upload", plan.upload.args); const inst = s.call("olive", "batch", { ops: plan.install(up.src) });
      const r = s.w().state().entities.gate.c.reactions;
      const chime = s.call("vic", "use", { id: "gate", action: "chime" });
      const bad = NS.planNewScript({ id: "gate", name: "tick", text: NS.TEMPLATES.timer, trigger: "timer", every: 2 }, thing);
      const dup = NS.planNewScript({ id: "gate", name: "chime", text: "x", trigger: "use" }, s.w().state().entities.gate.c);
      return { action: plan.action, inst: show(inst), kept: r?.use?.kind ?? null, chime: show(chime), ran: chime.script?.status ?? null, bad: bad.errors, dup: dup.errors }; },
    good: (o) => o.action === "chime" && o.inst === "ok" && o.kept === "toggle" && o.chime === "ok" && o.bad?.length === 1 && o.dup?.length === 1 },
  { id: "K2b", what: "…and when the script's name is already one of its actions, the new script takes a free one: neither existing reaction is replaced (review of #260)", run(s) { cast(s);
      if (!NS) return { planner: "absent" };
      s.call("olive", "create", { id: "gate2", model: "crate", components: { transform: T0([2, 0, 0]), openable: { open: false }, reactions: { use: { kind: "toggle", component: "openable" }, chime: { kind: "toggle", component: "openable" } } } });
      const plan = NS.planNewScript({ id: "gate2", name: "chime", text: NS.TEMPLATES.use, trigger: "use", comps: ["t/counter"], say: true }, s.w().state().entities.gate2.c);
      const up = s.call("olive", "upload", plan.upload.args); const inst = s.call("olive", "batch", { ops: plan.install(up.src) });
      const r = s.w().state().entities.gate2.c.reactions;
      return { action: plan.action, inst: show(inst), use: r?.use?.kind ?? null, chime: r?.chime?.kind ?? null, mine: r?.[plan.action] ?? null }; },
    good: (o) => o.action === "chime-2" && o.inst === "ok" && o.use === "toggle" && o.chime === "toggle" && o.mine?.kind === "script" && o.mine?.script === "chime" },
  { id: "U1", what: "update {copy, to} carries a reparent: a part moved under another part upstream lands under it here (not 3 m off, under its old parent)", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "shade", model: "book", components: { transform: T0([3, 0, 0]), parent: { to: "lamp" } } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      s.call("bob", "create", { id: "a", from: v1, at: { pos: [5, 0, 5] } }); s.call("bob", "create", { id: "b", from: v1, at: { pos: [9, 0, 5] } });
      const E = () => s.w().state().entities;
      const partOf = (copy: string, key: string) => Object.keys(E()).find((k) => E()[k].c["copy-of"]?.key === key && [copy, ...Object.keys(E()).filter((x) => E()[x].c.parent?.to === copy)].includes(E()[k].c.parent?.to));
      const at = (id: string) => { let p = [0, 0, 0], x: any = id; while (x) { const t = E()[x].c.transform.pos; p = p.map((v, i) => v + t[i]); x = E()[x].c.parent?.to; } return p.map((v) => Math.round(v * 1000) / 1000); };
      // reparenting keeps the bulb where it is: its local becomes [-3, 0.6, 0] under the shade. Without the parent, an update
      // takes that local transform under the copy's root: 3 m short of where the record puts it
      const re = s.call("bob", "set", { id: partOf("a", "bulb"), component: "parent", value: { to: partOf("a", "shade") } });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      const up = s.call("bob", "update", { copy: "b", to: v2 });
      const bb = partOf("b", "bulb");
      return { re: show(re), up: show(up), parent: E()[bb]?.c.parent?.to === partOf("b", "shade") ? "shade" : E()[bb]?.c.parent?.to === "b" ? "root" : E()[bb]?.c.parent?.to ?? null, at: bb ? at(bb) : null, want: [9, 0.6, 5] }; },
    good: (o) => o.re === "ok" && o.up === "ok" && o.parent === "shade" && JSON.stringify(o.at) === JSON.stringify(o.want) },
  { id: "U2", what: "an updated copy re-published keeps its parts' keys (their lineage advanced with the root): updating another customized copy to it leaves one bulb, not two", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      for (const [id, x] of [["a", 5], ["b", 9], ["c", 13]] as const) s.call("bob", "create", { id, from: v1, at: { pos: [x, 0, 5] } });
      const E = () => s.w().state().entities;
      const partOf = (copy: string, key: string) => Object.keys(E()).find((k) => E()[k].c["copy-of"]?.key === key && E()[k].c.parent?.to === copy);
      s.call("bob", "set", { id: "a", component: "label", value: "lamp v2" });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      const ub = s.call("bob", "update", { copy: "b", to: v2 });                       // b: an upgraded copy
      const v3 = s.call("bob", "publish", { from: "b", name: "lamp" }).notes?.find((n: any) => n.record)?.record;   // …re-published
      const keys = s.w().getBlob(v3).parts.map((p: any) => p.key).sort();
      const cb = partOf("c", "bulb"); const cl = s.call("bob", "set", { id: cb, component: "transform", value: T0([0, 0.7, 0]) });   // c: customized (a part the record also says)
      const uc = s.call("bob", "update", { copy: "c", to: v3 });
      const kids = Object.keys(E()).filter((k) => E()[k].c.parent?.to === "c");
      return { cl: show(cl), ub: show(ub), uc: show(uc), keys, kids: kids.length, same: partOf("c", "bulb") === cb, y: E()[cb]?.c.transform?.pos?.[1] ?? null, root: E().c.c.label ?? null }; },
    good: (o) => o.cl === "ok" && o.ub === "ok" && o.uc === "ok" && JSON.stringify(o.keys) === '["bulb","lamp"]' && o.kids === 1 && o.same && o.y === 0.7 && o.root === "lamp v2" },
  { id: "G1", what: "guard: re-publishing an edited copy keeps its parts' keys, so update {copy, to} still merges part by part", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      const a = s.call("bob", "create", { id: "a", from: v1, at: { pos: [5, 0, 5] } }); const b = s.call("bob", "create", { id: "b", from: v1, at: { pos: [9, 0, 5] } });
      // a copy's parts are minted (R 10-17: opaque, no <copy>-<key>): a part is the one carrying its record key under that copy
      const partOf = (copy: string, key: string) => Object.keys(s.w().state().entities).find((k) => s.w().state().entities[k].c["copy-of"]?.key === key && s.w().state().entities[k].c.parent?.to === copy);
      s.call("bob", "set", { id: partOf("a", "bulb"), component: "label", value: "brighter" });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      const keys = s.w().getBlob(v2).parts.map((p: any) => p.key).sort();
      const up = s.call("bob", "update", { copy: "b", to: v2 });
      return { a: show(a), b: show(b), keys, up: show(up), label: s.w().state().entities[partOf("b", "bulb")]?.c.label ?? null, kids: Object.keys(s.w().state().entities).filter((k) => s.w().state().entities[k].c.parent?.to === "b").length }; },
    good: (o) => o.up === "ok" && JSON.stringify(o.keys) === '["bulb","lamp"]' && o.label === "brighter" && o.kids === 1 },
  { id: "U6", what: "update's conflicts refusal names no dry run (a dry update takes the same refusal) and lists each conflict with yours and theirs", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      for (const [id, x] of [["a", 5], ["b", 9]] as const) s.call("bob", "create", { id, from: v1, at: { pos: [x, 0, 5] } });
      const E = () => s.w().state().entities;
      const partOf = (copy: string, key: string) => Object.keys(E()).find((k) => E()[k].c["copy-of"]?.key === key && E()[k].c.parent?.to === copy);
      s.call("bob", "set", { id: partOf("a", "bulb"), component: "label", value: "upstream" });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      s.call("bob", "set", { id: partOf("b", "bulb"), component: "label", value: "mine" });
      const up = s.call("bob", "update", { copy: "b", to: v2 }), dry = s.call("bob", "update", { copy: "b", to: v2, dry: true });
      // …and a resolve that leaves a conflict out names no dry run either: with two conflicts, resolve one
      s.call("bob", "set", { id: partOf("a", "bulb"), component: "transform", value: T0([0, 0.9, 0]) }); const v3 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      s.call("bob", "set", { id: partOf("b", "bulb"), component: "transform", value: T0([0, 0.3, 0]) });
      const two = s.call("bob", "update", { copy: "b", to: v3 }); const k0 = two.refused?.conflicts?.find((c: any) => c.component === "label"); const part = s.call("bob", "update", { copy: "b", to: v3, resolve: k0 ? { [`${k0.id}.label`]: "yours" } : {} });
      return { code: up.refused?.code, fix: up.refused?.fix ?? null, n: up.refused?.conflicts?.length ?? null, dry: dry.refused?.code ?? (dry.ok ? "ok" : null), n2: two.refused?.conflicts?.length ?? null, part: part.refused ?? (part.ok ? "ok" : null) }; },
    good: (o) => o.code === "conflicts" && !/dry/.test(o.fix ?? "") && o.n === 1 && o.dry === "conflicts" && o.n2 === 2 && /leaves out/.test(o.part?.reason ?? "") && !/dry/.test(o.part?.fix ?? "") },
  { id: "U5", what: "publish {from: [one id]} is publish {from: that id}: the same root key and the same parts, descendants included", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const rec = (r: any) => { const h = r.notes?.find((n: any) => n.record)?.record; return h ? s.w().getBlob(h) : r; };
      const one = rec(s.call("bob", "publish", { from: "lamp", name: "lamp" })), list = rec(s.call("bob", "publish", { from: ["lamp"], name: "lamp" }));
      return { root: [one.root, list.root], parts: [one.parts?.map((p: any) => p.key).sort(), list.parts?.map((p: any) => p.key).sort()] }; },
    good: (o) => typeof o.root[0] === "string" && o.root[0] === o.root[1] && JSON.stringify(o.parts[0]) === JSON.stringify(o.parts[1]) && o.parts[0]?.length === 2 },
  { id: "U3", what: "a part the newer version drops is deleted only if this copy left it as it came: a component this copy added keeps it", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]) } });
      s.call("bob", "create", { id: "bulb", model: "book", components: { transform: T0([0, 0.6, 0]), parent: { to: "lamp" } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      for (const [id, x] of [["a", 5], ["b", 9]] as const) s.call("bob", "create", { id, from: v1, at: { pos: [x, 0, 5] } });
      const E = () => s.w().state().entities;
      const partOf = (copy: string, key: string) => Object.keys(E()).find((k) => E()[k].c["copy-of"]?.key === key && E()[k].c.parent?.to === copy);
      const del = s.call("bob", "delete", { id: partOf("a", "bulb") });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      const bb = partOf("b", "bulb"); const add = s.call("bob", "set", { id: bb, component: "label", value: "mine" });
      const up = s.call("bob", "update", { copy: "b", to: v2 });
      return { del: show(del), add: show(add), up: show(up), kept: !!E()[bb], label: E()[bb]?.c.label ?? null }; },
    good: (o) => o.del === "ok" && o.add === "ok" && o.up === "ok" && o.kept && o.label === "mine" },
  { id: "U4", what: "a resolve that names no conflict, a word other than yours/theirs, or leaves a conflict out is refused rather than silently meaning yours (null is no resolve)", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", model: "crate", components: { transform: T0([0, 0, 0]), pivot: { pos: [0, 0, 0] } } });
      const v1 = s.call("bob", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      for (const [id, x] of [["a", 5], ["b", 9]] as const) s.call("bob", "create", { id, from: v1, at: { pos: [x, 0, 5] } });
      s.call("bob", "set", { id: "a", component: "pivot", value: { pos: [0, 1, 0] }, merge: true });
      const v2 = s.call("bob", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
      s.call("bob", "set", { id: "b", component: "pivot", value: { pos: [0, 2, 0] }, merge: true });
      const plain = s.call("bob", "update", { copy: "b", to: v2 });
      const stray = s.call("bob", "update", { copy: "b", to: v2, resolve: { "b.pivot.axis": "theirs" } });
      const word = s.call("bob", "update", { copy: "b", to: v2, resolve: { "b.pivot.pos": "mine" } });
      const none = s.call("bob", "update", { copy: "b", to: v2, resolve: null, dry: true });
      const left = s.call("bob", "update", { copy: "b", to: v2, resolve: {} });
      const good = s.call("bob", "update", { copy: "b", to: v2, resolve: { "b.pivot.pos": "theirs" } });
      return { plain: plain?.refused?.code ?? show(plain), stray: stray?.refused?.code ?? show(stray), word: word?.refused?.code ?? show(word), none: none?.refused?.code ?? show(none), left: left?.refused?.code ?? show(left), good: show(good), i: JSON.stringify(s.w().state().entities.b?.c.pivot?.pos) }; },
    good: (o) => o.plain === "conflicts" && o.stray === "shape" && o.word === "shape" && o.none === "conflicts" && o.left === "shape" && o.good === "ok" && o.i === "[0,1,0]" },
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
