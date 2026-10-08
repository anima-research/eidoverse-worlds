// tools/protocol/scale-check.ts — the authority at scale, and what the 10-06 reviews found there (the 10-06 top-down review
// S0-2, S0-3 and S3's request globals; the 10-06 security review pass 2, H-A and M-C). Every world on a server shares
// ONE thread, and every request goes through shared/protocol/authority.js on it: no request may hold it for long.
//   bun tools/protocol/scale-check.ts                 every case
//   bun tools/protocol/scale-check.ts --only S2,I1    just those
//   bun tools/protocol/scale-check.ts --tree <dir>    run the cases against another checkout (a mutant, a base)
//   bun tools/protocol/scale-check.ts --control       the base commit (d374d2ef): every case but the guards must be red there.
//                                               Each case runs in its own process with a time limit: a case the old door
//                                               can't finish in it is red
//   bun tools/protocol/scale-check.ts --mutants       remove each new gate in turn (a copy of the tree): its cases must go red;
//                                               a no-op control mutation must stay green
// Cases (worlds open as the server opens them: server/livehost.ts):
//   S   scale: every request under BOUND_MS at 72 (the Commons' size), 500 and 2 000 things: delete (with what rested on
//       it set down), a 3.5 m step of a tracked body, check {}, place on a table scaled 20× (a builder; a visitor is
//       refused), look, create, set, a batch of 50 creates, grab (with what rests on it set down)
//   Q   the gates in front of the work: a visitor's place on a 1000× table is refused at once; a search that can't end
//       inside the work budget is refused (too-costly); check {} on a heap likewise, while a write into it still lands;
//       reads per connection (server/readmeter.ts); settling orphaned holds at load is bounded
//   C   capacity: @world.capacity.things (and its default), and guests together (capacity.guestThings)
//   I   indoors: a refused move is never logged; a house measured from its triangles can be walked into through its door
//       (not through a wall) and things put down inside; a closed box stays solid; real library GLBs
//   R   re-entrancy: a request nested in another (leave → drop, or a host's callback) leaves the outer call's state alone
//   G   guards (green at base too): the index answers what the scans answered; a derived index files what a fresh one does
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "d374d2ef";
// The bound: 50 ms per request on this laptop at rest (the review's target). A host busy with other work runs everything
// slower, the authority included, so the bound is scaled by how much slower a fixed piece of door-shaped work runs right now
// than at rest (CAL_REF_MS, its median at rest here), at most 4×: an authority that grows with the world's size misses it by
// ten to a thousand times (--control). Each op is timed best of 5. The factor is printed with each timing case.
const BOUND_MS = 50, CAL_REF_MS = 5;
function calibrate() { const one = () => { const t0 = performance.now(); const m = new Map(); let acc = 0;
    for (let i = 0; i < 20000; i++) { const a = [i % 7, i % 11, i % 13].map((v) => v * 1.5); m.set(i, a); acc += Math.hypot(a[0], a[1], a[2]); if (i % 50 === 0) acc += JSON.stringify(a).length; }
    for (let i = 0; i < 20000; i++) acc += m.get(i)[1]; return acc > 0 ? performance.now() - t0 : 0; };
  const xs = Array.from({ length: 15 }, one).sort((a, b) => a - b); return Math.min(4, Math.max(1, xs[7] / CAL_REF_MS)); }
let LOAD = 1; const bound = () => BOUND_MS * LOAD;

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// [name, file (under the tree), find, replace, cases that must turn red]: an exact replacement found exactly once.
// (find may instead be a list of [find, replace] pairs: one gate written in two places.) Not listed, because no case can
// catch them by design: the exact world-axis reject before the 15-axis test and the charge for every cell a place search
// visits are defences (the first proven to give satDepth's own answer, the second a bound the exact ring stop already
// keeps); G3 and the reviewers' differential runs check they change no answer.
const MUTANTS: [string, string, string | [string, string][], string, string[]][] = [
  ["supportBelow asks the index", "shared/protocol/authority.js", "  for (const id of near(st, [x, -Infinity, z], [x, Infinity, z])) {\n    if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) {\n    if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", ["S2", "S3"]],
  ["supportUnder asks the index", "shared/protocol/authority.js", "  for (const id of near(st, [b.min[0], -Infinity, b.min[2]], [b.max[0], Infinity, b.max[2]])) { if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", ["S2", "S3"]],
  ["warnings: each thing against what its box meets", "shared/protocol/authority.js", "for (const o of near(st, g.q.min, g.q.max)) { if (fam.has(o)) continue; const go = ix.rec.get(o);", "for (const o of Object.keys(st.entities)) { if (fam.has(o) || !ix.rec.has(o)) continue; const go = ix.rec.get(o);", ["S3", "S5"]],
  ["a step asks the index (the old per-sub-step scan of every thing back)", "shared/protocol/authority.js", "function solidAt(w, st, p, except = new Set(), cands = null) {\n  const box = bodyBox(p); const held = w.presence.holds; const ix = cands && spatial(st);\n  if (cands) spend(1 + (cands.length >> 3));   // a sub-step filters the step's candidates by box first\n  for (const id of cands ?? near(st, box.min, box.max)) { if (id === \"@world\" || Object.hasOwn(held, id) || except.has(id)) continue;\n    if (cands) { const q = ix.rec.get(id).q; if (q.min[0] > box.max[0] || q.max[0] < box.min[0] || q.min[1] > box.max[1] || q.max[1] < box.min[1] || q.min[2] > box.max[2] || q.max[2] < box.min[2]) continue; }\n    if (hitsIx(st, box, id, 0.01)) return id; }\n  return null;\n}\nfunction pathBlocked(w, st, from, to) {\n  const already = new Set(); const b0 = bodyBox(from); // a body already inside something may walk out of it\n  for (const id of near(st, b0.min, b0.max)) if (hitsIx(st, b0, id, 0.01)) already.add(id);\n  const b1 = bodyBox(to); const swept = near(st, b0.min.map((v, i) => Math.min(v, b1.min[i])), b0.max.map((v, i) => Math.max(v, b1.max[i])));\n  const n = Math.max(1, Math.ceil(dist(from, to) / 0.05));\n  for (let k = 1; k <= n; k++) { const p = from.map((v, i) => v + (to[i] - v) * k / n); const hit = solidAt(w, st, p, already, swept); if (hit) return hit; }\n  return null;\n}\n", "function solidAt(w, st, p, except = new Set()) {\n  const box = bodyBox(p); const held = new Set(Object.keys(w.presence.holds));\n  for (const id of Object.keys(st.entities)) { if (id === \"@world\" || held.has(id) || except.has(id) || !geomOf(st.entities[id].c.model)) continue; if (hits(box, st, id, 0.01)) return id; }\n  return null;\n}\nfunction pathBlocked(w, st, from, to) {\n  const already = new Set(); const b0 = bodyBox(from); // a body already inside something may walk out of it\n  for (const id of Object.keys(st.entities)) if (geomOf(st.entities[id].c.model) && hits(b0, st, id, 0.01)) already.add(id);\n  const n = Math.max(1, Math.ceil(dist(from, to) / 0.05));\n  for (let k = 1; k <= n; k++) { const p = from.map((v, i) => v + (to[i] - v) * k / n); const hit = solidAt(w, st, p, already); if (hit) return hit; }\n  return null;\n}\n", ["S3", "S6"]],
  ["delete asks the index (the old set-down scan back: every thing, every support)", "shared/protocol/authority.js", [["for (const id of Object.keys(after.entities)) { if (!over.has(id)) continue; const b = aabb(after, id);", "for (const id of Object.keys(after.entities)) { const b = aabb(after, id);"], ["function supportBelow(st, x, z, y, ignore = new Set()) {\n  let best = { y: 0, id: \"ground\" };\n  const ix = spatial(st);\n  for (const id of near(st, [x, -Infinity, z], [x, Infinity, z])) {\n    if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)\n      if (x >= s.min[0] && x <= s.max[0] && z >= s.min[1] && z <= s.max[1] && s.y <= y + 0.02 && s.y > best.y) best = { y: s.y, id };\n  }\n  return best;\n}\n\n", "function supportBelow(st, x, z, y, ignore = new Set()) {\n  let best = { y: 0, id: \"ground\" };\n  for (const id of Object.keys(st.entities)) {\n    if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))\n      if (x >= s.min[0] && x <= s.max[0] && z >= s.min[1] && z <= s.max[1] && s.y <= y + 0.02 && s.y > best.y) best = { y: s.y, id };\n  }\n  return best;\n}\n\n"]], "", ["S2", "S3"]],
  ["grab asks the index (the old scan for what rests on it back)", "shared/protocol/authority.js", [["if (fam.has(k) || !over.has(k)) return false;", "if (fam.has(k)) return false;"], ["function supportUnder(st, b, ignore) {\n  let best = { y: 0, id: \"ground\" };\n  const ix = spatial(st);\n  for (const id of near(st, [b.min[0], -Infinity, b.min[2]], [b.max[0], Infinity, b.max[2]])) { if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs) if (b.max[0] > s.min[0] && b.min[0] < s.max[0] && b.max[2] > s.min[1] && b.min[2] < s.max[1] && s.y <= b.min[1] + 0.02 && s.y > best.y) best = { y: s.y, id }; }\n  return best;\n}\n\n", "function supportUnder(st, b, ignore) {\n  let best = { y: 0, id: \"ground\" };\n  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id)) if (b.max[0] > s.min[0] && b.min[0] < s.max[0] && b.max[2] > s.min[1] && b.min[2] < s.max[1] && s.y <= b.min[1] + 0.02 && s.y > best.y) best = { y: s.y, id }; }\n  return best;\n}\n\n"]], "", ["S2", "S3"]],
  ["place: nearest first, stopping when no ring can be nearer", "shared/protocol/authority.js", "            if (lb > best.d) break; }", "            }", ["S1", "S2", "S3", "Q6"]],
  ["place: the one gate before solving", "shared/protocol/authority.js", "if (!a.__made) admit(ctx.w, ctx.st, { actor: ctx.actor }, [setOp(a.id, \"transform\", COMPONENTS.transform.defaults)]);", "", ["Q1"]],
  ["previews and batches copy only what they touch (the deep copy per preview back)", "shared/protocol/authority.js", [["const scratch = (st, ops) => { const s = applyCow(cowState(st), ops);", "const scratch = (st, ops) => { const s = applyOps(st, ops);"], ["all.push(...ops); st = applyCow(work, ops); forget(st);", "all.push(...ops); st = scratch(st, ops);"]], "", ["S3"]],
  ["place: a ring's sides bound its distance", "shared/protocol/authority.js", "if (lb > best.d) break; }", "if (lb > best.d + 1e9) break; }", ["Q6"]],
  ["the work budget", "shared/protocol/authority.js", "if ((WORK.left -= n) < 0 || ((WORK.k += n) >= 64 && ((WORK.k = 0), clockMs() > WORK.until))) {", "if (false) {", ["Q2", "Q3"]],
  ["a write's warnings never refuse it", "shared/protocol/authority.js", "if (strict || !(e instanceof Refusal) || e.code !== \"too-costly\") throw e;", "throw e;", ["Q3"]],
  ["look walks the children map", "shared/protocol/authority.js", "for (const k of kids.get(id) ?? []) tree(k, d + 1, n + 1); };", "for (const k of Object.keys(st.entities).filter((x) => st.entities[x].c.parent?.to === id)) tree(k, d + 1, n + 1); };", ["S4"]],
  ["capacity.things", "shared/protocol/authority.js", "if (after > before && after > cap.things) refuse(\"full\"", "if (false) refuse(\"full\"", ["C1", "C2"]],
  ["capacity.guestThings, all guests together", "shared/protocol/authority.js", "if (g + made > cap.guestThings) refuse(\"full\"", "if (false) refuse(\"full\"", ["C3"]],
  ["a refused move is never logged", "shared/protocol/authority.js", "    if (verb === \"move\") return;", "    if (verb === \"move\" && args?.teleport !== true && w.presence.bodies[actor]) return;", ["I1"]],
  ["solids: an enclosed cell is solid", "server/solids.ts", "const solid = (c: number) => occ[c] === 1 || out[c] === 0;", "const solid = (c: number) => occ[c] === 1;", ["I3"]],
  ["solids: cells merge only where their bounds line up", "server/solids.ts", "while (i1 + 1 < nx && free(i1 + 1, j, k) && same(idx(i1 + 1, j, k), s0, 1) && same(idx(i1 + 1, j, k), s0, 2)) i1++;", "while (i1 + 1 < nx && free(i1 + 1, j, k)) i1++;", ["I2"]],
  ["the catalogue measures solids", "server/modelcatalogue.ts", "...(sum!.solids ? { solids: sum!.solids } : {})", "", ["I4"]],
  ["a nested request keeps the outer call's queues", "shared/protocol/authority.js", "w.changedQ = saved.changedQ; w.sayQ = saved.sayQ; w.heldQ = saved.heldQ;", "", ["R1"]],
  ["a nested leave keeps the outer leave's flag", "shared/protocol/authority.js", "w.leaving = wasLeaving ?? null; }", "w.leaving = null; }", ["R2"]],
  ["settling orphans: at most ORPHANS.holders", "shared/protocol/authority.js", "if (holders.length > ORPHANS.holders) {", "if (false) {", ["Q5"]],
  ["reads per connection: how many", "server/readmeter.ts", "if (!timeOnly && a.length >= limits.n) return", "if (false) return", ["Q4"]],
  ["reads per connection: how long", "server/readmeter.ts", "if (ms >= limits.ms) return", "if (false) return", ["Q4"]],
  ["a derived index re-files what rides on a change", "shared/protocol/authority.js", "for (const k of pk.get(t) ?? []) if (!touched.has(k)) todo.push(k);", "", ["G2"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority.js", "// ---------- the spatial index", "// ----------  the spatial index", []],
];
async function runSelf(tree: string, only: string[] | null, timeoutMs = 0) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/scale-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  // a copied tree (a mutant, the base) finds the asset library where this checkout does (config.ts: EIDOVERSE_DIR)
  const lib = process.env.EIDOVERSE_DIR ?? (await import(ENGINE + "server/config.ts")).LIBRARY_DIR;
  const p = Bun.spawn(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", EIDOVERSE_DIR: lib }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false; const t = timeoutMs ? setTimeout(() => { timedOut = true; p.kill(9); }, timeoutMs) : null;
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); const code = await p.exited; if (t) clearTimeout(t);
  return { code, timedOut, out: out + err };
}
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs", "client"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0; const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = copyTree("smut"); const f = path.join(d, file); let src = fs.readFileSync(f, "utf8");
    const pairs: [string, string][] = Array.isArray(find) ? find : [[find, repl]];   // a gate in two places is reverted in both
    const missing = pairs.find(([a]) => src.split(a).length !== 2);
    if (missing) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    for (const [a, b] of pairs) src = src.replace(a, () => b);
    fs.writeFileSync(f, src);
    // a mutant whose cases can't finish in MUTANT_MS is as red as one that fails them (the bound is 50 ms a request)
    const r = await runSelf(d, cases.length ? cases : null, Number(process.env.MUTANT_MS ?? 240000));
    const redIds = r.timedOut ? cases : [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? (r.timedOut || r.code !== 0) && cases.every((c) => redIds.includes(c)) : r.code === 0 && !r.timedOut;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${r.timedOut ? "(timed out)" : redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[scale-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
// ---------------- the authority, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
// the first path that loads: today's name, then the base commit's (before the 10-07 names pass)
const imp1 = async (...ps: string[]) => { let err: unknown; for (const p of ps) { try { return await import(TREE + p); } catch (e) { err = e; } } throw err; };
const D = await imp1("shared/protocol/authority.js", "shared/" + "v4/door.js");   // (split: the base's path, not a stale one)
const L = await imp1("server/livehost.ts", "server/" + "v4/live.ts");
const SB = await imp1("shared/protocol/sandbox.js", "shared/" + "v4/sandbox.js");
const SOL = await imp1("server/solids.ts", "server/" + "v4/solids.ts").catch(() => null);         // absent at the base commit
const RM = await imp1("server/readmeter.ts", "server/" + "v4/readmeter.ts").catch(() => null);       // absent at the base commit
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("scale");

let T = 1800000000000, N = 0;
function open(name: string, o: any = {}) {
  const dir = path.join(root, "worlds", name); fs.mkdirSync(dir, { recursive: true });
  const w = L.openLive(dir, name, { now: () => Number(process.env.PROTOCOL_NOW ?? T), scripts: o.scripts ?? null, custodyFile: path.join(root, "custody.json"),
    nameOf: () => null, kindOf: o.kindOf ?? (() => "human"), catalogue: o.catalogue });
  if (o.presence) Object.assign(w.presence, o.presence);
  return w;
}
// G3 runs the scenario against its base commit too, which speaks the names before the 10-07 conventional-names pass
const AT_BASE = path.resolve(TREE) !== path.resolve(ENGINE);
const BASE_VERB: Record<string, string> = { "create-world": "new", lint: "check" };
// …and its batch ops were {tool, args}
const baseArgs = (verb: string, args: any) => (verb === "batch" && Array.isArray(args?.ops) ? { ...args, ops: args.ops.map((o: any) => (o && "verb" in o ? (({ verb: v, ...r }) => ({ tool: BASE_VERB[v] ?? v, ...r }))(o) : o)) } : args);
function session(o: any = {}) {
  const name = `w${++N}`; let w = open(name, o);
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return AT_BASE ? D.request(w, actor, BASE_VERB[verb] ?? verb, baseArgs(verb, args)) : D.request(w, actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: () => w, reopen: (o2: any = {}) => (w = open(name, { ...o, ...o2 })), advance: (ms: number) => { T += ms; process.env.PROTOCOL_NOW = String(T); } };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code ?? (r?.crashed ? "CRASH" : r?.ok ? "ok" : "?");
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const timed = (f: () => any) => { const t0 = performance.now(); const r = f(); return { ms: performance.now() - t0, r }; };
// best of n: the op itself is given fresh arguments each time by `f(k)`
const best = (n: number, f: (k: number) => any) => { let out: any = null; for (let k = 0; k < n; k++) { const x = timed(() => f(k)); if (!out || x.ms < out.ms) out = x; if (x.ms <= bound()) break; } return out; };
const r1 = (x: number) => Math.round(x * 10) / 10;

// owner olive, builder bob, visitor vic; bounds wide enough for 2 000 things 2 m apart
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "bounds", value: { min: [-500, 0, -500], max: [500, 50, 500] } });
  for (const [who, role] of [["bob", "builder"], ["vic", "visitor"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
// n crates on a 2 m grid around the origin, 50 to a batch (20 s apart: the authority's rate window)
function fill(s: any, n: number, at = (i: number, side: number) => [(i % side) * 2 - side, 0, Math.floor(i / side) * 2 - side]) {
  const side = Math.ceil(Math.sqrt(n));
  for (let made = 0; made < n;) { const ops = []; for (let k = 0; k < 50 && made < n; k++, made++) ops.push({ verb: "create", args: { id: `c-${made}`, model: "crate", components: { transform: { pos: at(made, side), q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
    const r = s.call("olive", "batch", { ops }, 20000); if (!ok(r)) return r; }
  return { ok: true, side };
}
const T0 = (pos: number[], scale = [1, 1, 1]) => ({ pos, q: [0, 0, 0, 1], scale });

// ---------------- S: every request under BOUND_MS at a world's size ----------------
function scaleCase(n: number) {
  return (s: any) => { cast(s);
    if (n > 1900) s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 2400 } });
    const f = fill(s, n); if (!ok(f)) return { fill: show(f) };
    const X = f.side * 2 + 40;   // the furniture stands east of the grid
    s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([X, 0, 0], [20, 1, 20]) } });
    s.call("olive", "create", { id: "slab", model: "crate", components: { transform: T0([X, 0.75, 0]) } });   // where a place on `big` wants to go
    for (let k = 0; k < 5; k++) { s.call("olive", "create", { id: `base-${k}`, model: "crate", components: { transform: T0([X - 20 - 2 * k, 0, 30]) } });
      s.call("olive", "create", { id: `top-${k}`, model: "crate", components: { transform: T0([X - 20 - 2 * k, 0.6, 30]) } });
      const tx = X - 20.7 + [-0.7, 0, 0.7, -0.35, 0.35][k], tz = k < 3 ? 40 : 38.8;   // all within reach of one spot
      s.call("olive", "create", { id: `tray-${k}`, model: "crate", components: { transform: T0([tx, 0, tz]), grabbable: { who: "visitor" } } });
      s.call("olive", "create", { id: `cup-${k}`, model: "book", components: { transform: T0([tx, 0.6, tz]), grabbable: { who: "visitor" } } }); }
    s.call("vic", "move", { to: [0.9, 0, 0.9] });
    const ms: any = {}, codes: any = {};
    const op = (k: string, f: (i: number) => any) => { const x = best(5, f); ms[k] = r1(x.ms); codes[k] = code(x.r); };
    op("delete", (i) => s.call("olive", "delete", { id: `base-${i}` }));
    op("step", (i) => { const at = s.w().presence.bodies.vic.at; return s.call("vic", "move", { to: [at[0], 0, at[2] < 2 ? 4.4 : 0.9] }, 1000); });
    op("check", () => s.call("vic", "lint", {}));
    op("place", (i) => s.call("bob", "place", { id: `c-${7 + i}`, on: "big", dry: true }));
    op("placeVisitor", () => s.call("vic", "place", { id: "c-7", on: "big" }));
    op("look", () => s.call("vic", "look", {}));
    op("create", () => s.call("olive", "create", { model: "crate", components: { transform: T0([X - 40, 0, -20]) } }, 20000));
    op("set", (i) => s.call("olive", "set", { id: `c-${20 + i}`, component: "label", value: "x" }, 20000));
    op("batch", (i) => s.call("olive", "batch", { ops: Array.from({ length: 50 }, (_, k) => ({ verb: "create", args: { model: "crate", components: { transform: T0([X - 60 - k, 0, -20 - 4 * i]) } } })) }, 20000));
    s.call("vic", "move", { to: [X - 20.7, 0, 39.4], teleport: true }, 20000);
    op("grab", (i) => { const r = s.call("vic", "grab", { id: `tray-${i}` }, 20000); s.call("vic", "drop", { id: `tray-${i}` }); return r; });
    return { n, ms, codes, things: Object.keys(s.w().state().entities).length - 1, load: r1(LOAD), bound: r1(bound()) }; };
}
const scaleGood = (o: any) => !!o.ms && Object.values(o.ms).every((v: any) => v <= o.bound)
  && JSON.stringify(o.codes) === JSON.stringify({ delete: "ok", step: "ok", check: "ok", place: "ok", placeVisitor: "rights", look: "ok", create: "ok", set: "ok", batch: "ok", grab: "ok" });

// a synthetic building, as triangles: a 6 × 3 m house (floor 0.1 m, walls 0.15 m) with a 1 m doorway in its +z wall
function boxTris(lo: number[], hi: number[], out: number[]) {
  const c = (x: number, y: number, z: number) => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
  for (const [a, b, d, e] of [[c(0,0,0),c(1,0,0),c(1,1,0),c(0,1,0)],[c(0,0,1),c(1,0,1),c(1,1,1),c(0,1,1)],[c(0,0,0),c(0,1,0),c(0,1,1),c(0,0,1)],[c(1,0,0),c(1,1,0),c(1,1,1),c(1,0,1)],[c(0,0,0),c(1,0,0),c(1,0,1),c(0,0,1)],[c(0,1,0),c(1,1,0),c(1,1,1),c(0,1,1)]])
    out.push(...a, ...b, ...d, ...a, ...d, ...e);
}
function houseEntry() {
  const s: number[] = [];
  boxTris([-3, 0, -3], [3, 0.1, 3], s); boxTris([-3, 0, -3], [3, 3, -2.85], s); boxTris([-3, 0, -3], [-2.85, 3, 3], s); boxTris([2.85, 0, -3], [3, 3, 3], s);
  boxTris([-3, 0, 2.85], [-0.5, 3, 3], s); boxTris([0.5, 0, 2.85], [3, 3, 3], s); boxTris([-0.5, 2.1, 2.85], [0.5, 3, 3], s); boxTris([-3, 3, -3], [3, 3.1, 3], s);
  const solids = SOL?.solidsFromTriangles(new Float32Array(s), [-3, 0, -3], [3, 3.1, 3]) ?? undefined;   // the engine's measurement (base: none, the box stands)
  return { label: "house", size: [6, 3.1, 6], box: [[-3, 0, -3], [3, 3.1, 3]], surfaces: [{ y: 0.1, x: [-2.85, 2.85], z: [-2.85, 2.85] }, { y: 3.1, x: [-3, 3], z: [-3, 3] }], ...(solids ? { solids } : {}) };
}
function closedEntry() {
  const s: number[] = []; boxTris([-1.5, 0, -1.5], [1.5, 3, 1.5], s);
  const solids = SOL?.solidsFromTriangles(new Float32Array(s), [-1.5, 0, -1.5], [1.5, 3, 1.5]) ?? undefined;
  return { label: "closed box", size: [3, 3, 3], box: [[-1.5, 0, -1.5], [1.5, 3, 1.5]], surfaces: [{ y: 3, x: [-1.5, 1.5], z: [-1.5, 1.5] }], ...(solids ? { solids } : {}) };
}
const withLab = (extra: any) => { const lab = D.LAB_CATALOGUE; return { get: (n: string) => (Object.hasOwn(extra, n) ? extra[n] : lab.get(n)), list: (q: string) => lab.list(q) }; };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean; o?: any };
const cases: Case[] = [
  { id: "S1", what: `at 72 things (the Commons' size) every request takes under ${BOUND_MS} ms`, run: scaleCase(72), good: scaleGood },
  { id: "S2", what: `at 500 things every request takes under ${BOUND_MS} ms`, run: scaleCase(500), good: scaleGood },
  { id: "S3", what: `at 2 000 things every request takes under ${BOUND_MS} ms`, run: scaleCase(2000), good: scaleGood },

  // ---------------- Q: the gates in front of the work ----------------
  { id: "Q1", what: "a visitor's place onto a table scaled 1000× is refused (rights) before any search, and still recorded as an attempt", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "lid", model: "crate", components: { transform: T0([0, 0.75, 0], [1000, 1, 1000]) } });   // nothing on it is free
      s.call("olive", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, 600]) } });
      const n0 = s.w().entries.length; const x = timed(() => s.call("vic", "place", { id: "mug", on: "big" }));
      return { code: code(x.r), ms: r1(x.ms), bound: r1(bound()), logged: s.w().entries.slice(n0).filter((e: any) => e.kind === "act" && e.body?.refused?.code === "rights").length }; },
    good: (o) => o.code === "rights" && o.ms <= o.bound && o.logged === 1 },
  { id: "Q2", what: "a builder's place onto a 1000× table with nothing free on it ends inside the work budget: refused too-costly, saying why", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "lid", model: "crate", components: { transform: T0([0, 0.75, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, 600]) } });
      const dry = best(5, () => s.call("bob", "place", { id: "mug", on: "big", dry: true })); const real = best(5, () => s.call("bob", "place", { id: "mug", on: "big" }));
      return { dry: code(dry.r), dryMs: r1(dry.ms), real: code(real.r), realMs: r1(real.ms), bound: r1(bound()), why: real.r?.refused?.reason }; },
    good: (o) => o.dry === "too-costly" && o.real === "too-costly" && o.dryMs <= o.bound && o.realMs <= o.bound && /shared by every world/.test(o.why ?? "") },
  { id: "Q3", what: "check {} on a heap of 700 things in one spot is refused too-costly inside the budget; a batch of 120 creates into the heap still lands, its warnings saying what went unchecked", run(s) { cast(s);
      fill(s, 700, () => [0, 0, 0]);
      const c = best(5, () => s.call("vic", "lint", {})); const one = best(5, () => s.call("vic", "lint", { id: "c-3" }));
      const mk = best(3, (i) => s.call("olive", "batch", { ops: Array.from({ length: 120 }, (_, k) => ({ verb: "create", args: { id: `more-${i}-${k}`, model: "crate", components: { transform: T0([0, 0, 0]) } } })) }, 20000));
      return { check: code(c.r), ms: r1(c.ms), one: code(one.r), oneMs: r1(one.ms), batch: code(mk.r), batchMs: r1(mk.ms), bound: r1(bound()), made: !!s.w().state().entities["more-0-119"],
        unchecked: mk.r?.warnings?.find((x: any) => x.kind === "unchecked")?.things ?? 0 }; },
    good: (o) => o.check === "too-costly" && o.ms <= o.bound && o.one === "ok" && o.oneMs <= o.bound && o.batch === "ok" && o.made && o.unchecked > 0 && o.batchMs <= 2 * o.bound },
  { id: "Q4", what: "reads are metered per connection (server/readmeter.ts): 300 in 10 s, or 1.5 s of the authority's time, then refused (rate) until the window moves", run() {
      if (!RM) return { missing: true };
      const m = RM.readMeter(); const a = {}, b = {}; let t = 1000; const out: any = {};
      for (let i = 0; i < RM.READ.n; i++) { if (m.check(a, t)) return { refusedEarly: i }; m.record(a, t); }
      out.sixtyFirst = m.check(a, t)?.code ?? "ok"; out.later = m.check(a, t + 10_001)?.code ?? "ok";
      const k = m.record(b, t); k.ms = 1600; out.slow = m.check(b, t + 1)?.code ?? "ok"; out.other = m.check({}, t)?.code ?? "ok";
      return out; },
    good: (o) => o.sixtyFirst === "rate" && o.later === "ok" && o.slow === "rate" && o.other === "ok" },
  { id: "Q5", what: "settling orphaned holds at load is bounded: 400 holders left by a crash end quickly, the first ones settled as leave settles them, the rest said to wait", run(s) { cast(s);
      const holds: any = {}, bodies: any = {};
      for (let made = 0; made < 400;) { const ops = []; for (let k = 0; k < 50; k++, made++) ops.push({ verb: "create", args: { id: `g-${made}`, model: "book", components: { transform: T0([made % 20, 0, Math.floor(made / 20)]), grabbable: { who: "visitor" } } } });
        s.call("olive", "batch", { ops }, 20000); }
      for (let i = 0; i < 400; i++) { holds[`g-${i}`] = { by: `h-${i}`, since: T, pose: { pos: [i % 20, 1.1, Math.floor(i / 20)], q: [0, 0, 0, 1], scale: [1, 1, 1] }, handled: [`h-${i}`] }; bodies[`h-${i}`] = { at: [i % 20, 0, Math.floor(i / 20)], ts: T, tokens: 4 }; }
      s.call("olive", "look", {}, 20000);
      const w = s.reopen({ presence: { holds, bodies } });
      const x = timed(() => D.settleOrphans(w, []));
      return { ms: r1(x.ms), bound: r1(8 * bound()), settled: x.r.filter((r: any) => r.holder).length, deferred: x.r.find((r: any) => r.deferred)?.deferred ?? 0, holdsLeft: Object.keys(w.presence.holds).length }; },
    good: (o) => o.ms <= o.bound && o.settled > 0 && o.settled <= 16 && o.deferred === 400 - o.settled && o.holdsLeft === 0 },

  { id: "Q6", what: "place {on, offset} far off a 1000× table, or onto one whose middle is taken, ends quickly and answers as the full search would (the nearest free spot)", run(s) { cast(s);
      s.call("bob", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("bob", "create", { id: "slab", model: "crate", components: { transform: T0([0, 0.75, 0], [4, 1, 4]) } });
      s.call("bob", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, -3000]) } });
      const far = timed(() => s.call("bob", "place", { id: "mug", on: "big", offset: [1000, 0], attach: false, dry: true }));
      const mid = timed(() => s.call("bob", "place", { id: "mug", on: "big", attach: false, dry: true }));
      const at = (r: any) => r?.would?.find((o: any) => o.comp === "transform")?.value?.pos;
      return { far: code(far.r), farMs: r1(far.ms), farAt: at(far.r), mid: code(mid.r), midMs: r1(mid.ms), midAt: at(mid.r), bound: r1(bound()) }; },
    good: (o) => o.far === "ok" && o.mid === "ok" && o.farMs <= o.bound && o.midMs <= o.bound && Math.abs(o.farAt?.[0] - 599.7) < 0.01 && Math.abs(o.farAt?.[2]) < 0.01 && Math.abs(Math.abs(o.midAt?.[0]) - 1.5) < 0.01 && Math.abs(o.midAt?.[2]) < 0.01 },   // the nearest free spots: the edge toward the offset; beside the slab (which side: G3 compares with the full scan)
  // ---------------- C: capacity ----------------
  { id: "C1", what: "a world at capacity.things refuses what would add (full), a batch that would cross it whole; a delete frees room; other changes stay open", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 10 } });
      const made = []; for (let i = 0; i < 10; i++) made.push(code(s.call("bob", "create", { id: `t-${i}`, model: "crate", components: { transform: T0([i, 0, 0]) } }, 2000)));
      const over = s.call("bob", "create", { id: "t-10", model: "crate" }, 2000);
      const set = s.call("bob", "set", { id: "t-1", component: "label", value: "still open" }, 2000);
      s.call("bob", "delete", { id: "t-0" }, 2000);
      const batch = s.call("bob", "batch", { ops: [{ verb: "create", args: { id: "t-11", model: "crate" } }, { verb: "create", args: { id: "t-12", model: "crate" } }] }, 2000);
      const one = s.call("bob", "create", { id: "t-13", model: "crate", components: { transform: T0([0, 0, 3]) } }, 2000);
      return { made: [...new Set(made)], over: code(over), why: over.refused?.reason, set: code(set), batch: code(batch), one: code(one), things: Object.keys(s.w().state().entities).length - 1 }; },
    good: (o) => JSON.stringify(o.made) === '["ok"]' && o.over === "full" && /limit is 10/.test(o.why ?? "") && o.set === "ok" && o.batch === "full" && o.one === "ok" && o.things === 10 },
  { id: "C2", what: "unset, a world holds 2 000 things (the default); the owner may raise it, never past 5 000", run(s) { cast(s);
      const f = fill(s, 2000); const over = s.call("bob", "create", { id: "x", model: "crate" }, 20000);
      const raise = s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 2100 } }, 20000);
      const now = s.call("bob", "create", { id: "y", model: "crate", components: { transform: T0([400, 0, 400]) } }, 20000);
      const tooHigh = s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 6000 } }, 20000);
      const builder = s.call("bob", "set", { id: "@world", component: "capacity", value: { things: 3000 } }, 20000);
      return { fill: show(f), over: code(over), raise: code(raise), now: code(now), tooHigh: code(tooHigh), builder: code(builder) }; },
    good: (o) => o.fill === "ok" && o.over === "full" && o.raise === "ok" && o.now === "ok" && o.tooHigh === "bounds" && o.builder === "rights" },
  { id: "C3", what: "guests together have at most capacity.guestThings things standing (a fresh guest identity per connection gets no fresh share); an account still builds; a guest's delete frees room", run(s) {
      const sess = session({ kindOf: (id: string) => (id.startsWith("g") ? "anon" : "human") }); s = sess;
      s.call("olive", "create-world", { title: "guests" });
      s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
      s.call("olive", "set", { id: "@world", component: "capacity", value: { guestThings: 5 } });
      const r = [];
      for (const [who, n] of [["g1", 3], ["g2", 2]]) for (let i = 0; i < n; i++) r.push(code(s.call(who, "create", { id: `${who}-${i}`, model: "crate", components: { transform: T0([i, 0, who === "g1" ? 0 : 2]) } }, 2000)));
      const g3 = s.call("g3", "create", { id: "g3-0", model: "crate" }, 2000);
      const acct = s.call("bob", "create", { id: "bob-0", model: "crate", components: { transform: T0([5, 0, 5]) } }, 2000);
      const del = s.call("g1", "delete", { id: "g1-0" }, 2000);
      const g3b = s.call("g3", "create", { id: "g3-1", model: "crate", components: { transform: T0([8, 0, 8]) } }, 2000);
      return { r: [...new Set(r)], g3: code(g3), why: g3.refused?.reason, acct: code(acct), del: code(del), g3b: code(g3b) }; },
    good: (o) => JSON.stringify(o.r) === '["ok"]' && o.g3 === "full" && /guests/.test(o.why ?? "") && o.acct === "ok" && o.del === "ok" && o.g3b === "ok" },

  // ---------------- I: indoors ----------------
  { id: "I1", what: "a refused move is never logged: a refused step, a refused arrival (spawn) and a refused teleport (into a solid) add nothing to the log", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8], radius: 2 } });
      s.call("olive", "create", { id: "wall", model: "wall", components: { transform: T0([0, 0, 4]) } });
      const n0 = s.w().entries.length;
      const arrive = s.call("vic", "move", { to: [0, 0, -6] });
      const n1 = s.w().entries.length; s.call("vic", "move", { to: [0, 0, 8] }); const n2 = s.w().entries.length;
      const step = s.call("vic", "move", { to: [0, 0, 5] }, 1000); const step2 = s.call("vic", "move", { to: [0, 0, 3] }, 1000);
      const tp = s.call("bob", "move", { to: [0, 0, 4] }); const tp2 = s.call("vic", "move", { to: [0, 0, 4], teleport: true }, 4000);
      return { arrive: code(arrive), step: [code(step), code(step2)], tp: code(tp), tp2: code(tp2), refusedLogged: n1 - n0, arrivalLogged: n2 - n1, afterArrival: s.w().entries.length - n2 }; },
    good: (o) => o.arrive === "spawn" && o.step.includes("solid") && o.tp === "solid" && o.tp2 === "solid" && o.refusedLogged === 0 && o.arrivalLogged === 0 && o.afterArrival === 0 },   // review 10-07 M3: an accepted arrival is presence too (it was one act)
  { id: "I2", what: "a house measured from its triangles: a body walks in through the doorway (not through a wall), arrives inside, and a thing is put down on its floor", run(s) {
      s = session({ catalogue: withLab({ house: houseEntry() }) }); cast(s);
      s.call("olive", "create", { id: "home", model: "house", components: { transform: T0([0, 0, 0]) } });
      s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([1, 0.1, 1]), grabbable: { who: "visitor" } } });
      const r: any = {};
      r.arrive = code(s.call("vic", "move", { to: [0, 0, 5] }));
      r.door = code(s.call("vic", "move", { to: [0, 0.1, 1.6] }, 1000)); r.inside = code(s.call("vic", "move", { to: [1.5, 0.1, 0.5] }, 1000));
      r.wall = code(s.call("vic", "move", { to: [4.2, 0, 0.5] }, 1000));
      r.grab = code(s.call("vic", "grab", { id: "mug" }, 1000)); r.put = show(s.call("vic", "put", { id: "mug", pos: [1.6, 0.1, 1.2] }, 1000));
      r.tp = code(s.call("bob", "move", { to: [-1.5, 0.1, -1.5] })); r.inWall = code(s.call("ann", "move", { to: [3, 0, 0] }));
      r.check = s.call("olive", "lint", { id: "mug" }).warnings?.map((x: any) => x.kind) ?? null;
      return r; },
    good: (o) => o.arrive === "ok" && o.door === "ok" && o.inside === "ok" && o.wall === "solid" && o.grab === "ok" && o.put === "ok" && o.tp === "ok" && o.inWall === "solid" && JSON.stringify(o.check) === "[]" },
  { id: "I3", what: "a closed box measured the same way stays solid through and through: no arriving inside it, no walking into it", run(s) {
      s = session({ catalogue: withLab({ box: closedEntry() }) }); cast(s);
      s.call("olive", "create", { id: "box", model: "box", components: { transform: T0([0, 0, 0]) } });
      const small: number[] = []; boxTris([-0.5, 0, -0.5], [0.5, 1.6, 0.5], small);   // a cabinet: no room for a body inside, so it keeps its box
      return { cabinet: SOL ? SOL.solidsFromTriangles(new Float32Array(small), [-0.5, 0, -0.5], [0.5, 1.6, 0.5]) : "absent", solids: closedEntry().solids?.length ?? 0, tp: code(s.call("vic", "move", { to: [0, 0, 0] })), arrive: code(s.call("bob", "move", { to: [0, 0, 3] })), walk: code(s.call("bob", "move", { to: [0, 0, 0.5] }, 1000)) }; },
    good: (o) => o.cabinet === null && o.solids > 1 && o.tp === "solid" && o.arrive === "ok" && o.walk === "solid" },
  { id: "I4", what: "real library GLBs through the engine's catalogue: the watchtower's open interior can be arrived in but not walked out of through its wall; the shipping container is solid", async: true, run: null as any, good: (o) => (o.skipped === true && !argv.includes("--tree")) || (o.inTower === "ok" && o.outWall === "solid" && o.container === "solid" && o.solids > 1) },

  // ---------------- R: re-entrancy ----------------
  { id: "R1", what: "a request nested in another (a host callback re-entering the authority with a leave, whose drops are requests too) leaves the outer call's queued events alone: the outer put's changed: event is still queued after it, and its release event too", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "visitor" } });
      s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([0, 0, 0]), grabbable: { who: "visitor" } } });
      s.call("olive", "create", { id: "ball", model: "book", components: { transform: T0([3, 0, 0]), grabbable: { who: "visitor" } } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [3, 0, 0.5] });
      s.call("vic", "grab", { id: "mug" }); s.call("ann", "grab", { id: "ball" });
      const w = s.w(); const save = w.savePresence; let nested: any = null, fired = false; const seen: any = {};
      // during vic's put: after its change entry is queued, before the request drains its queues
      w.savePresence = () => { save(); if (!fired && w.presence.holds.mug === undefined && w.changedQ?.length) { fired = true;
        seen.before = [...w.changedQ]; nested = D.request(w, "ann", "leave", {}); seen.after = [...(w.changedQ ?? [])]; } };
      const put = s.call("vic", "put", { id: "mug", pos: [0.3, 0, 0.3] }); w.savePresence = save;
      return { put: show(put), nested: show(nested), annLeft: !w.presence.bodies.ann, before: seen.before, after: seen.after }; },
    good: (o) => o.put === "ok" && o.nested === "ok" && o.annLeft && o.before?.length === 1 && JSON.stringify(o.after) === JSON.stringify(o.before) },
  { id: "R2", what: "…and a leave nested in another leave (a host callback during its drops) doesn't end the outer leave's settlement: its later drops are still never rate-refused", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "visitor" } });
      for (let k = 0; k < 3; k++) s.call("olive", "create", { id: `b-${k}`, model: "book", components: { transform: T0([0.2 * k, 0, 0]), grabbable: { who: "visitor", ...(k < 2 ? { release: "return" } : {}) } } });   // two go home: the third lands alone
      s.call("olive", "create", { id: "ball", model: "book", components: { transform: T0([3, 0, 0]), grabbable: { who: "visitor" } } });
      s.call("ann", "move", { to: [3, 0, 0.5] }); s.call("ann", "grab", { id: "ball" });
      for (let i = 0; i < 64; i++) s.call("vic", "move", { to: [0, 0, 0.5 + (i % 2) * 0.1], teleport: true }, 10);   // vic's budget for this window is spent (each an act)
      for (let k = 0; k < 3; k++) s.call("vic", "grab", { id: `b-${k}` }, 10);
      const w = s.w(); const save = w.savePresence; let nested: any = null;
      let fired = false; w.savePresence = () => { save(); if (!fired && w.leaving === "vic") { fired = true; nested = D.request(w, "ann", "leave", {}); } };
      const r = s.call("vic", "leave", {}, 10); w.savePresence = save;
      return { nested: show(nested), dropped: r.dropped?.map((d: any) => d.ok), why: r.dropped?.map((d: any) => d.refused ?? null), held: Object.keys(w.presence.holds) }; },
    good: (o) => o.nested === "ok" && JSON.stringify(o.dropped) === "[true,true,true]" && o.held.length === 0 },

  // ---------------- G: guards ----------------
  { id: "S5", what: `rotated furniture at 1 500 things (300 desks turned 30°, four books on each): check {}, look, and placing a book on a turned desk with a box in its middle each take under ${BOUND_MS} ms`, run(s) { cast(s);
      const yq = (deg: number) => [0, Math.sin(deg * Math.PI / 360), 0, Math.cos(deg * Math.PI / 360)];
      for (let d = 0; d < 300;) { const ops = []; for (let k = 0; k < 10; k++, d++) { const x = (d % 20) * 3 - 30, z = Math.floor(d / 20) * 3 - 22;
          ops.push({ verb: "create", args: { id: `desk-${d}`, model: "table", components: { transform: { pos: [x, 0, z], q: yq(30), scale: [1.5, 1, 1.5] } } } });
          for (let b = 0; b < 4; b++) ops.push({ verb: "create", args: { id: `bk-${d}-${b}`, model: "book", components: { transform: { pos: [x + (b - 1.5) * 0.25, 0.75, z], q: yq(30), scale: [1, 1, 1] } } } }); }
        const r = s.call("olive", "batch", { ops }, 20000); if (!ok(r)) return { fill: show(r) }; }
      s.call("olive", "create", { id: "pile", model: "crate", components: { transform: { pos: [-30, 0.75, -22], q: yq(30), scale: [1.2, 0.3, 1.2] } } }, 20000);
      s.call("olive", "create", { id: "cup", model: "book", components: { transform: T0([40, 0, 40]) } }, 20000);
      const ms: any = {}, codes: any = {};
      const op = (k: string, f: (i: number) => any) => { const x = best(5, f); ms[k] = r1(x.ms); codes[k] = code(x.r); };
      op("check", () => s.call("vic", "lint", {})); op("look", () => s.call("vic", "look", {}));
      op("place", () => s.call("bob", "place", { id: "cup", on: "desk-0", dry: true }));
      return { ms, codes, bound: r1(bound()) }; },
    good: (o) => !!o.ms && Object.values(o.ms).every((v: any) => v <= o.bound) && JSON.stringify(o.codes) === '{"check":"ok","look":"ok","place":"ok"}' },
  { id: "S6", what: `a 4 m step beside 800 small things at body height (books on shelves) takes under ${BOUND_MS} ms, and one into them is refused (solid) as fast`, run(s) { cast(s);
      for (let made = 0; made < 800;) { const ops = []; for (let k = 0; k < 50 && made < 800; k++, made++) ops.push({ verb: "create", args: { id: `b-${made}`, model: "book", components: { transform: T0([2.2 + (made % 10) * 0.06, 0.9 + (Math.floor(made / 100) % 8) * 0.1, 2.2 + (Math.floor(made / 10) % 10) * 0.06]) } } });
        const r = s.call("olive", "batch", { ops }, 20000); if (!ok(r)) return { fill: show(r) }; }
      s.call("vic", "move", { to: [0, 0, 2.8] }, 5000);
      const past = best(5, (i) => s.call("vic", "move", { to: i % 2 ? [0, 0, 2.8] : [2.8, 0, 0] }, 2000));
      s.call("vic", "move", { to: [0, 0, 2.8], teleport: true }, 5000);
      const into = best(5, () => s.call("vic", "move", { to: [2.5, 0, 2.5] }, 2000));
      return { ms: { past: r1(past.ms), into: r1(into.ms) }, past: code(past.r), into: code(into.r), bound: r1(bound()) }; },
    good: (o) => o.past === "ok" && o.into === "solid" && o.ms.past <= o.bound && o.ms.into <= o.bound },
  { id: "S4", what: `look over 2 000 things: the first 40 in the tree's order and the total, in under ${BOUND_MS} ms`, run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 2400 } });
      fill(s, 2000); for (let k = 0; k < 3; k++) s.call("olive", "create", { id: `kid-${k}`, model: "book", components: { parent: { to: "c-0" }, transform: T0([0, 0.6, 0]) } });
      const x = best(5, () => s.call("vic", "look", {}));
      return { ms: r1(x.ms), bound: r1(bound()), n: x.r.things?.length, total: x.r.total, first: x.r.things?.slice(0, 5).map((t: any) => `${t.id}@${t.depth}`) }; },
    good: (o) => o.ms <= o.bound && o.n === 40 && o.total === 2003 && JSON.stringify(o.first) === '["c-0@0","kid-0@1","kid-1@1","kid-2@1","c-1@0"]' },
  { id: "G2", what: "the index a state's queries use (derived from the last one, write by write) files exactly what a fresh build files, through moves, re-parenting, deletes of parents, creates and undo", run(s) { cast(s);
      if (!D.indexAudit) return { skipped: "no audit at this tree" };
      fill(s, 60); const bad: any[] = []; let rnd = 7; const rand = (n: number) => ((rnd = (rnd * 16807) % 2147483647) % n);
      for (let i = 0; i < 160; i++) { const k = rand(6), a = `c-${rand(60)}`, b = `c-${rand(60)}`;
        if (k === 0) s.call("olive", "set", { id: a, component: "transform", value: T0([rand(40) - 20, rand(3), rand(40) - 20]) });
        else if (k === 1 && a !== b) s.call("olive", "set", { id: a, component: "parent", value: { to: b } });
        else if (k === 2) s.call("olive", "delete", { id: a, component: "parent" });
        else if (k === 3) s.call("olive", "delete", { id: a });
        else if (k === 4) s.call("olive", "undo", {});
        else s.call("olive", "create", { model: "crate", components: { transform: T0([rand(40) - 20, 0, rand(40) - 20]) } });
        s.call("vic", "lint", { id: a });   // a read of this state: its index is derived (or built) now
        const d = D.indexAudit(s.w()); if (d.length) { bad.push([i, k, d]); if (bad.length > 3) break; } }
      return { bad }; },
    good: (o) => o.skipped || o.bad.length === 0 },
  { id: "G3", what: `the index answers what the scans answered: one scenario of 150 things (placing on, near, beside, against, hanging; checks; a delete that sets things down; walking into furniture; carrying), every reply equal at this tree and at ${BASE}`, run: null as any,
    good: (o) => o.same === true && o.replies > 60 },
];

if (argv.includes("--control")) {
  // the base commit's tree: every case but the guards (G) must be red there; each case alone, with a time limit
  const d = scratch("sctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server tools defs client package.json | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const ids = cases.map((c) => c.id).filter((id) => !opt("only") || opt("only")!.split(",").includes(id)); let wrong = 0;
  for (const id of ids) {
    const t0 = performance.now(); const r = await runSelf(d, [id], Number(process.env.CONTROL_MS ?? 120000)); const s = ((performance.now() - t0) / 1000).toFixed(1);
    const red = r.timedOut || r.code !== 0; const guard = id.startsWith("G"); const right = guard ? !red : red; if (!right) wrong++;
    const line = r.out.split("\n").find((l) => /^(ok|FAIL) /.test(l)) ?? "";
    console.log(`${right ? (guard ? "kept at base:  " : "red at base:   ") : "WRONG AT BASE: "}${id.padEnd(4)} ${r.timedOut ? `timed out after ${s} s` : `${s} s`}  ${line.slice(0, 110)}${red && !r.timedOut ? `\n                 ${(r.out.split("\n").find((l) => /^\s+\{/.test(l)) ?? r.out.split("\n").filter(Boolean).at(-1) ?? "").trim().slice(0, 240)}` : ""}`);
  }
  console.log(`[scale-check --control] at ${BASE}: ${ids.length} cases, ${wrong} wrong (each must be red there, the guards green)`);
  process.exit(wrong ? 1 : 0);
}

// I4 needs the engine's catalogue (it measures GLBs asynchronously): run before the synchronous cases
// the G3 scenario: every reply, with what differs between runs by design (chain heads, salts) left out
function scenario() {
  // (and log positions: a refused move is no longer recorded, so the seqs after one shift by design)
  const s = session(); const out: any[] = []; const strip = (r: any) => JSON.parse(JSON.stringify(r ?? null, (k, v) => (["head", "seq", "act", "born", "cause", "recorded"].includes(k) ? undefined : v)));   // recorded: an arrival isn't logged now (review 10-07 M3)
  const c = (who: string, verb: string, args: any = {}, step = 200) => { const r = s.call(who, verb, args, step); out.push([who, verb, strip(r)]); return r; };
  cast(s); c("olive", "set", { id: "@world", component: "roles:ann", value: { role: "builder" } });
  fill(s, 100, (i) => [(i % 10) * 2.5 - 12, 0, Math.floor(i / 10) * 2.5 - 12]);
  for (let i = 0; i < 100; i += 7) c("olive", "set", { id: `c-${i}`, component: "transform", value: { pos: [(i % 10) * 2.5 - 12, 0, Math.floor(i / 10) * 2.5 - 12], q: [0, Math.sin(i / 10), 0, Math.cos(i / 10)], scale: [1, 1 + (i % 3) * 0.5, 1] } }, 2000);
  for (let k = 0; k < 6; k++) c("olive", "create", { id: `t-${k}`, model: "table", place: { at: [20 + 3 * k, 5] } }, 2000);
  c("olive", "create", { id: "shelf-1", model: "shelf", place: { at: [20, -5] } }, 2000); c("olive", "create", { id: "frame", model: "swing-frame", place: { at: [28, -5] } }, 2000);
  c("olive", "create", { id: "w-1", model: "wall", components: { transform: T0([24, 0, 12]) } }, 2000);
  for (let k = 0; k < 12; k++) c("ann", "create", { id: `cr-${k}`, model: "crate", place: { on: `t-${k % 6}`, ...(k >= 6 ? { offset: [0.3, 0.1] } : {}) } }, 2000);
  for (let k = 0; k < 6; k++) c("ann", "create", { id: `bk-${k}`, model: "book", place: { on: "shelf-1", level: k % 4 } }, 2000);
  c("ann", "create", { id: "seat", model: "crate", place: { hang: "frame", height: 0.5 } }, 2000);
  c("ann", "create", { id: "ch-1", model: "chair", place: { near: "t-2", facing: "t-2" } }, 2000); c("ann", "create", { id: "ch-2", model: "chair", place: { beside: "t-3", side: "left" } }, 2000);
  c("ann", "create", { id: "lamp", model: "floor-lamp", place: { against: "w-1" } }, 2000);
  c("ann", "place", { id: "cr-0", on: "t-1", facing: "ch-1" }, 2000); c("ann", "place", { id: "c-3", near: "c-4" }, 2000); c("ann", "place", { id: "c-5", at: [30, 9] }, 2000);
  c("ann", "create", { id: "big", model: "crate", components: { transform: T0([-12, 0, -12], [3, 1, 3]) } }, 2000);
  c("vic", "lint", {}); c("vic", "lint", { id: "c-14" }); c("vic", "lint", { id: "big" }); c("vic", "look", { limit: 300 }); c("vic", "measure", { id: "t-2" });
  c("olive", "delete", { id: "t-1" }, 2000); c("olive", "delete", { id: "t-4", dry: true }); c("olive", "delete", { id: "shelf-1" }, 2000);
  // written out whole (PROTOCOL §4: the authority now writes a grabbable's defaults into it; the base tree didn't), so both trees reply alike
  c("olive", "create", { id: "mug", model: "book", components: { grabbable: { who: "visitor", enabled: true, steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 } }, place: { on: "t-5" } }, 2000);
  c("vic", "move", { to: [35, 0, 9] }); for (const p of [[33, 0, 7], [31, 0, 6], [29, 0, 5.5], [26, 0, 5], [24.6, 0, 12], [24, 0, 11]]) c("vic", "move", { to: p }, 1000);
  c("vic", "move", { to: [35, 0, 5.4], teleport: true }, 4000); c("vic", "grab", { id: "mug" }, 1000); c("vic", "put", { id: "mug", pos: [35, 0.75, 5.3] }, 1000);
  c("vic", "grab", { id: "mug" }, 1000); c("vic", "put", { id: "mug" }, 1000); c("vic", "move", { to: [21, 0, 4.4], teleport: true }, 4000); c("vic", "grab", { id: "cr-1" }, 1000);
  c("vic", "lint", {}); c("vic", "look", { limit: 300 });
  // a table scaled 12× with a slab in its middle: the nearest free spot, with and without offsets (one far off it)
  c("ann", "create", { id: "wide", model: "table", components: { transform: T0([60, 0, 60], [12, 1, 12]) } }, 2000); c("ann", "create", { id: "slab", model: "crate", components: { transform: T0([60, 0.75, 60], [4, 1, 4]) } }, 2000);
  for (const off of [undefined, [1000, 0], [0.3, -0.7], [-2, 2]]) c("ann", "place", { id: "c-50", on: "wide", ...(off ? { offset: off } : {}), dry: true });
  c("ann", "place", { id: "c-50", on: "wide", facing: "slab" }, 2000);
  return out;
}
async function realGlbs() {
  const C = await import(TREE + "server/modelcatalogue.ts"); const { LIBRARY_DIR } = await import(TREE + "server/config.ts");
  const tower = "eidoverse/assets/models/scifi_perimeter_watchtower_standalone_or_with_wall_middle_four_way.glb", box = "eidoverse/assets/models/scifi_cyberpunk_intermodal_shipping_container_crate_blue.glb";
  if (!fs.existsSync(path.join(LIBRARY_DIR, tower)) || !fs.existsSync(path.join(LIBRARY_DIR, box))) return { skipped: true, why: `the library isn't on this host (${LIBRARY_DIR})` };
  await C.warm([tower, box]);
  const te = C.ENGINE_CATALOGUE.get(tower), be = C.ENGINE_CATALOGUE.get(box);
  const s = session({ catalogue: C.ENGINE_CATALOGUE }); cast(s);
  s.call("olive", "create", { id: "tower", model: tower, components: { transform: T0([0, 0, 0]) } });
  s.call("olive", "create", { id: "container", model: box, components: { transform: T0([30, 0, 0]) } });
  const c = [(te.box[0][0] + te.box[1][0]) / 2, te.box[0][1], (te.box[0][2] + te.box[1][2]) / 2];   // the tower's middle, on the ground
  const bc = [30 + (be.box[0][0] + be.box[1][0]) / 2, 0, (be.box[0][2] + be.box[1][2]) / 2];
  const inTower = code(s.call("vic", "move", { to: [c[0], 0, c[2]] }));
  const outWall = code(s.call("vic", "move", { to: [c[0] + 3.4, 0, c[2]] }, 1000));
  const container = code(s.call("bob", "move", { to: bc }));
  return { solids: te.solids?.length ?? 0, inTower, outWall, container };
}

// reply keys the names pass renamed (PROPOSAL-conventional-names-2026-10-07): base spelling → today's
const RENAMED_KEYS: Record<string, string> = { teach: "fix", touchI: "intimate" };
async function sameAsBase() {
  const d = scratch("sbase"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server package.json | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) return { error: String(r0.stderr) }; fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const run = (tree: string) => { const r = Bun.spawnSync(["bun", path.join(ENGINE, "tools/protocol/scale-check.ts"), "--tree", tree, "--scenario"], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    const t = r.stdout.toString(); try { return JSON.parse(t); } catch { return { bad: (t + r.stderr.toString()).slice(-400) }; } };
  const a = run(TREE), b0 = run(d); if (!Array.isArray(a) || !Array.isArray(b0)) return { a: a?.bad ?? "ok", b: b0?.bad ?? "ok" };
  // the base speaks the names before the 10-07 conventional-names pass: its replies' keys are read in today's names
  const b = JSON.parse(JSON.stringify(b0), function (k, v) { if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [Object.hasOwn(RENAMED_KEYS, key) ? RENAMED_KEYS[key] : key, x])); });
  // R 10-07: look and inspect read a thing as its name, description, what it can do and its state (shared/a11y.js): those
  // fields are additions the base never wrote, generated from components it also had. Compared without them, on both sides
  const noA11y = (x: any) => JSON.stringify(x, (k, v) => (k === "can" || k === "state" || k === "description" ? undefined : v));
  const diff = a.findIndex((x: any, i: number) => noA11y(x) !== noA11y(b[i]));
  return { same: diff < 0 && a.length === b.length, replies: a.length, ...(diff >= 0 ? { at: diff, here: JSON.stringify(a[diff]).slice(0, 300), base: JSON.stringify(b[diff]).slice(0, 300) } : {}) };
}
if (argv.includes("--scenario")) { console.log(JSON.stringify(scenario())); process.exit(0); }

// ---------------- run ----------------
let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false; LOAD = calibrate();
  try { o = c.id === "I4" ? await realGlbs() : c.id === "G3" ? await sameAsBase() : c.run(session()); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 900)}`}`);
  if (good && o?.ms !== undefined) console.log(`       ${JSON.stringify(o.ms)} (bound ${o.bound} ms: load ×${r1(LOAD)})`);
}
console.log(`[scale-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
