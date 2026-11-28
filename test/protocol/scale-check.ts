// test/protocol/scale-check.ts — the authority at scale, and what the 10-06 reviews found there (the 10-06 top-down review
// S0-2, S0-3 and S3's request globals; the 10-06 security review pass 2, H-A and M-C). Every world on a server shares
// ONE thread, and every request goes through shared/protocol/authority.js on it: no request may hold it for long.
//   bun test/protocol/scale-check.ts                 every case
//   bun test/protocol/scale-check.ts --only S2,I1    just those
//   bun test/protocol/scale-check.ts --tree <dir>    run the cases against another checkout (a mutant, a base)
//   bun test/protocol/scale-check.ts --control       the base commit (d374d2ef): every case but the guards must be red there.
//                                               Each case runs in its own process with a time limit: a case the old door
//                                               can't finish in it is red
//   bun test/protocol/scale-check.ts --mutants       remove each new gate in turn (a copy of the tree): its cases must go red;
//                                               a no-op control mutation must stay green
// Cases (worlds open as the server opens them: server/livehost.ts):
//   S   scale: ten requests timed, each the best of up to 5 tries, at 72 (the Commons' size), then their growth at 500 and 2 000: delete (with what rested on
//       it set down), a 3.5 m step of a tracked body, check {}, place on a table scaled 20× (a builder; a visitor is
//       refused), look, create, set, a batch of 50 creates, grab (with what rests on it set down). S4–S6 (listed after
//       R below): look's tree over 2 000 things, rotated furniture at 1 500, a step beside 800 small things
//   Q   the gates in front of the work: a visitor's place on a 1000× table is refused at once; a search that can't end
//       inside the work budget is refused (too-costly); check {} on a heap likewise, while a write into it still lands;
//       reads per connection (server/readmeter.ts); settling orphaned holds at load is bounded
//   C   capacity: @world.capacity.entities (and its default; sockets count like any entity), and guests together
//       (capacity.guestEntities)
//   I   indoors: a refused move is never logged; a house measured from its triangles can be walked into through its door
//       (not through a wall) and things put down inside; a closed box stays solid; real library GLBs
//   R   re-entrancy: a request nested in another (leave → drop, or a host's callback) leaves the outer call's state alone
//   G   guards (green at base too): the index answers what the scans answered; a derived index files what a fresh one does
// @ts-nocheck
import "../harness/fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree, archiveTo, linkInto, readLF } from "../gate/common.ts";
import { suite } from "../gate/suite.ts";

import { CAPACITY, CAPACITY_CEILING } from "../../shared/protocol/authority.js";
import { COMPONENTS } from "../../shared/protocol/componentspec.js";
import { labClock, pinned } from "../gate/clock.ts";
import { LAB_CATALOGUE } from "../harness/labmodels.js";
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "d374d2ef";
// cost is judged machine-free: by how a request GROWS (the same op at a small and a large world, timed seconds apart in this
// process, so the host's speed cancels: at most GROWS× (a write GROWS_OP×), an index regressed to a scan is 5–200×) and by counted work (the
// authority's WORK_METER units, log appends). BOUND_MS only catches a hang. Each op: best of 5
const BOUND_MS = 500, GROWS = 3, FLOOR_MS = 1;
const bound = () => BOUND_MS;

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// [name, file, find, replace, cases that must turn red]: an exact replacement found once (or a list of [find, replace, file?],
// the file when it isn't the row's). Not listed:
// the world-axis reject and the per-cell place-search charge are defences no case can catch; G3 checks they change no answer
const MUTANTS: [string, string, string | [string, string, string?][], string, string[]][] = [
  ["supportBelow asks the index", "shared/protocol/authority/spatial.js", "  for (const id of near(st, [x, -Infinity, z], [x, Infinity, z])) {\n    if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) {\n    if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", ["S2", "S3"]],
  ["supportUnder asks the index", "shared/protocol/authority/spatial.js", "  for (const id of near(st, [b.min[0], -Infinity, b.min[2]], [b.max[0], Infinity, b.max[2]])) { if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", ["S2", "S3"]],
  ["warnings: each thing against what its box meets", "shared/protocol/authority/followups.js", "for (const o of near(st, g.q.min, g.q.max)) { if (fam.has(o)) continue; const go = ix.rec.get(o);", "for (const o of Object.keys(st.entities)) { if (fam.has(o) || !ix.rec.has(o)) continue; const go = ix.rec.get(o);", ["S3", "S5"]],
  ["a step asks the index (the old per-sub-step scan of every thing back)", "shared/protocol/authority/physics.js", [["const swept = near(st, lo, hi);", "const swept = null;"], ["for (const id of cands ?? near(st, box.min, box.max)) {", "for (const id of Object.keys(st.entities)) {"], ["    if (hitsIx(st, box, id, 0.01)) return id; }", "    if (hits(box, st, id, 0.01)) return id; }"], ["import { aabb, descendants, localFrom, worldT } from \"./math.js\";", "import { aabb, descendants, hits, localFrom, worldT } from \"./math.js\";"]], "", ["S3", "S6"]],
  ["delete asks the index (the old set-down scan back: every thing, every support)", "shared/protocol/authority/writes.js", [["for (const id of Object.keys(after.entities)) { if (!over.has(id)) continue; const b = aabb(after, id);", "for (const id of Object.keys(after.entities)) { const b = aabb(after, id);"], ["  for (const id of near(st, [x, -Infinity, z], [x, Infinity, z])) {\n    if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) {\n    if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", "shared/protocol/authority/spatial.js"]], "", ["S2", "S3"]],
  ["grab asks the index (the old scan for what rests on it back)", "shared/protocol/authority/bodyverbs.js", [["if (fam.has(k) || !over.has(k)) return false;", "if (fam.has(k)) return false;"], ["  for (const id of near(st, [b.min[0], -Infinity, b.min[2]], [b.max[0], Infinity, b.max[2]])) { if (ignore.has(id)) continue;\n    for (const s of ix.rec.get(id).surfs)", "  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;\n    for (const s of surfacesOf(st, id))", "shared/protocol/authority/spatial.js"]], "", ["S2", "S3"]],
  ["place: nearest first, stopping when no ring can be nearer", "shared/protocol/authority/writes.js", "            if (lb > best.d) break; }", "            }", ["S1", "S2", "S3", "Q6"]],
  ["place: the one gate before solving", "shared/protocol/authority/writes.js", "if (!a.__made) admit(ctx.w, ctx.st, { actor: ctx.actor }, [setOp(a.id, \"transform\", COMPONENTS.transform.defaults)]);", "", ["Q1"]],
  ["previews and batches copy only what they touch (the deep copy per preview back)", "shared/protocol/authority/storage.js", [["const scratch = (st, ops) => { const s = applyCow(cowState(st), ops);", "const scratch = (st, ops) => { const s = applyInPlace(cloneState(st), ops);"], ["all.push(...ops); st = applyCow(work, ops); forget(st);", "all.push(...ops); st = scratch(st, ops);", "shared/protocol/authority/verbs.js"], ["import { VOLATILE, delOp, nonce16, setOp } from \"./storage.js\";", "import { VOLATILE, delOp, nonce16, setOp, scratch } from \"./storage.js\";", "shared/protocol/authority/verbs.js"]], "", ["S3"]],
  ["place: its family through the index (the walk of every thing's parent chain back)", "shared/protocol/authority/writes.js", "  const fam = familyOf(st, a.id, 32);   // the index", "  const fam = new Set([a.id, ...descendants(st, a.id)]);   // the index", ["S7"]],
  ["returns: the things that return, once per state (the scan of every thing per request back)", "shared/protocol/authority/manipulate.js", "  if (!VOLATILE.has(st.entities)) RETURNERS.set(st.entities, a); return a; };", "  return a; };", ["S7"]],
  ["socket rules: a write that touches no socket asks the state before's socket children", "shared/protocol/authority/gate.js", "socketRules(s, new Set(norm.map((o) => o.id)), st)", "socketRules(s, new Set(norm.map((o) => o.id)))", ["S7"]],
  ["shapes: no preview when no op can stamp one", "shared/protocol/authority/followups.js", "o.comp === \"physics-engine\")) return ops;", "o.comp === \"physics-engine\") && false) return ops;", ["S7"]],
  ["homes: no preview when nothing it weighs wants a home", "shared/protocol/authority/manipulate.js", "o.comp === \"grabbable\")))) return ops;", "o.comp === \"grabbable\"))) && false) return ops;", ["S7"]],
  ["place: a ring's sides bound its distance", "shared/protocol/authority/writes.js", "if (lb > best.d) break; }", "if (lb > best.d + 1e9) break; }", ["Q6"]],
  ["the work budget", "shared/protocol/authority/spatial.js", "if ((CTX.work.left -= n) < 0 || ((CTX.work.k += n) >= 64 && ((CTX.work.k = 0), clockMs() > CTX.work.until))) {", "if (false) {", ["Q2", "Q3"]],
  ["a write's warnings never refuse it", "shared/protocol/authority/followups.js", "if (strict || !(e instanceof Refusal) || e.code !== \"too-costly\") throw e;", "throw e;", ["Q3"]],
  ["look walks the children map", "shared/protocol/authority/reads.js", "for (const k of kids.get(id) ?? []) tree(k, sock ? d : d + 1, n + 1); };", "for (const k of Object.keys(st.entities).filter((x) => st.entities[x].c.parent?.to === id)) tree(k, sock ? d : d + 1, n + 1); };", ["S4"]],
  ["capacity.entities", "shared/protocol/authority/capacity.js", "if (after > before && after > cap.entities) refuse(\"full\"", "if (false) refuse(\"full\"", ["C1", "C2"]],
  ["capacity.guestEntities, all guests together", "shared/protocol/authority/capacity.js", "if (made <= gone || g - gone + made <= cap.guestEntities) return;", "return;", ["C3", "C3b"]],
  ["a refused move is never logged", "shared/protocol/authority.js", [["    if (verb === \"move\") return;", "    if (verb === \"move\" && args?.teleport !== true && w.presence.bodies[actor]) return;"], ["const PRESENCE_VERBS = new Set([\"move\", \"drive\",", "const PRESENCE_VERBS = new Set([\"drive\","]], "", ["I1"]],
  ["solids: an enclosed cell is solid", "server/solids.ts", "const solid = (c: number) => occ[c] === 1 || out[c] === 0;", "const solid = (c: number) => occ[c] === 1;", ["I3"]],
  ["solids: cells merge only where their bounds line up", "server/solids.ts", "while (i1 + 1 < nx && free(i1 + 1, j, k) && same(idx(i1 + 1, j, k), s0, 1) && same(idx(i1 + 1, j, k), s0, 2)) i1++;", "while (i1 + 1 < nx && free(i1 + 1, j, k)) i1++;", ["I2"]],
  ["the catalogue measures solids", "server/modelcatalogue.ts", "...(sum!.solids ? { solids: sum!.solids } : {})", "", ["I4"]],
  ["a nested request keeps the outer call's queues", "shared/protocol/authority.js", "w.changedQ = wq.changedQ; w.sayQ = wq.sayQ; w.heldQ = wq.heldQ; ", "", ["R1"]],
  ["a nested leave keeps the outer leave's flag", "shared/protocol/authority/bodyverbs.js", "w.leaving = wasLeaving ?? null; }", "w.leaving = null; }", ["R2"]],
  ["settling orphans: at most ORPHANS.holders", "shared/protocol/authority/scriptrun.js", "if (holders.length > ORPHANS.holders) {", "if (false) {", ["Q5"]],
  ["reads per connection: how many", "server/readmeter.ts", "if (!timeOnly && a.length >= limits.n) return", "if (false) return", ["Q4"]],
  ["reads per connection: how long", "server/readmeter.ts", "if (ms >= limits.ms) return", "if (false) return", ["Q4"]],
  ["a derived index re-files what rides on a change", "shared/protocol/authority/spatial.js", "for (const k of pk.get(t) ?? []) if (!touched.has(k)) todo.push(k);", "", ["G2"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority.js", "// ---------- the verb table's bodies", "// ----------  the verb table's bodies", []],
];
async function runSelf(tree: string, only: string[] | null, timeoutMs = 0) {
  const args = ["bun", path.join(ENGINE, "test/protocol/scale-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  // a copied tree (a mutant, the base) finds the asset library where this checkout does (config.ts: EIDOVERSE_DIR)
  const lib = process.env.EIDOVERSE_DIR ?? (await import(ENGINE + "server/config.ts")).LIBRARY_DIR;
  const p = Bun.spawn(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", EIDOVERSE_DIR: lib }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false; const t = timeoutMs ? setTimeout(() => { timedOut = true; p.kill(9); }, timeoutMs) : null;
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]); const code = await p.exited; if (t) clearTimeout(t);
  return { code, timedOut, out: out + err };
}
function mutantTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "test", "defs", "client"]) if (fs.existsSync(path.join(ENGINE, sub))) copyTree(path.join(ENGINE, sub), path.join(d, sub));
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  linkInto(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0; const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = mutantTree("smut");
    // a gate in two places is reverted in both (each in its own file, the row's by default)
    const edits: [string, string, string][] = (Array.isArray(find) ? find : [[find, repl]]).map(([a, b, g]) => [g ?? file, a, b]);
    const missing = edits.find(([g, a]) => readLF(path.join(d, g)).split(a).length !== 2);
    if (missing) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${missing[0]} (the gate moved?)`); continue; }
    for (const [g, a, b] of edits) { const h = path.join(d, g); fs.writeFileSync(h, readLF(h).replace(a, () => b)); }
    // a mutant whose cases can't finish in MUTANT_MS is as red as one that fails them
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
// fixture-ids.ts opened the fixture seam on ENGINE's authority; a --tree run (mutants, control) imports another instance
D.fixtureIds?.(true);
const L = await imp1("server/livehost.ts", "server/" + "v4/live.ts");
const SB = await imp1("shared/protocol/sandbox.js", "shared/" + "v4/sandbox.js");
const SOL = await imp1("server/solids.ts", "server/" + "v4/solids.ts").catch(() => null);         // absent at the base commit
const RM = await imp1("server/readmeter.ts", "server/" + "v4/readmeter.ts").catch(() => null);       // absent at the base commit
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("scale");

const clock = labClock(); let N = 0;
function open(name: string, o: any = {}) {
  const dir = path.join(root, "worlds", name); fs.mkdirSync(dir, { recursive: true });
  const w = L.openLive(dir, name, { now: () => pinned(clock.t), scripts: o.scripts ?? null, custodyFile: path.join(root, "custody.json"),
    nameOf: () => null, kindOf: o.kindOf ?? (() => "human"), catalogue: o.catalogue ?? LAB_CATALOGUE });
  if (o.presence) Object.assign(w.presence, o.presence);
  return w;
}
// G3 runs the scenario against its base commit too, which speaks the names before the 10-07 conventional-names pass. Known
// by its layout (the base has no shared/protocol/authority.js), never by being another directory: a mutant is a copy of today's tree
// and speaks today's names (read as "another tree", every case failed in every mutant, so each read as caught)
const AT_BASE = !fs.existsSync(path.join(TREE, "shared/protocol/authority.js"));
// the base rung's name in the tree under test (R 10-21: member; the base commit says visitor): G3 speaks each tree's own word
const BASE_RUNG = AT_BASE ? "visitor" : "member";
const BASE_VERB: Record<string, string> = { "create-world": "new", lint: "check" };
// …and its batch ops were {tool, args}
const baseArgs = (verb: string, args: any) => (verb === "batch" && Array.isArray(args?.requests) ? { ...args, ops: args.requests.map((o: any) => (o && "verb" in o ? (({ verb: v, ...r }) => ({ tool: BASE_VERB[v] ?? v, ...r }))(o) : o)) } : args);
function session(o: any = {}) {
  const name = `w${++N}`; let w = open(name, o);
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { clock.advance(step);
    try { return AT_BASE ? D.request(w, actor, BASE_VERB[verb] ?? verb, baseArgs(verb, args)) : D.request(w, actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: () => w, reopen: (o2: any = {}) => (w = open(name, { ...o, ...o2 })), advance: (ms: number) => { clock.advance(ms); } };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code ?? (r?.crashed ? "CRASH" : r?.ok ? "ok" : "?");
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const SPM: any = await imp1("shared/protocol/authority/spatial.js").catch(() => null);
const METER: { units: number } | undefined = SPM?.WORK_METER; const BUDGET: number = SPM?.WORK_BUDGET?.units ?? Infinity;
const timed = (f: () => any) => { const u0 = METER?.units ?? 0; const t0 = performance.now(); const r = f(); const x = { ms: performance.now() - t0, r, units: (METER?.units ?? 0) - u0 }; return x; };
// best of n: the op itself is given fresh arguments each time by `f(k)`
const best = (n: number, f: (k: number) => any) => { let out: any = null; for (let k = 0; k < n; k++) { const x = timed(() => f(k)); if (!out || x.ms < out.ms) out = x; if (x.ms <= FLOOR_MS) break; } return out; };
const r1 = (x: number) => Math.round(x * 10) / 10;

// owner olive, builder bob, visitor vic; bounds wide enough for 2 000 things 2 m apart
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  s.call("olive", "set", { id: "@world", component: "bounds", value: { min: [-500, 0, -500], max: [500, 50, 500] } });
  for (const [who, role] of [["bob", "builder"], ["vic", "member"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
// n crates on a 2 m grid around the origin, 50 to a batch (20 s apart: past the authority's 10 s rate window)
function fill(s: any, n: number, at = (i: number, side: number) => [(i % side) * 2 - side, 0, Math.floor(i / side) * 2 - side]) {
  const side = Math.ceil(Math.sqrt(n));
  for (let made = 0; made < n;) { const ops = []; for (let k = 0; k < 50 && made < n; k++, made++) ops.push({ verb: "create", args: { id: `c-${made}`, model: "crate", components: { transform: { pos: at(made, side), q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
    const r = s.call("olive", "batch", { requests: ops }, 20000); if (!ok(r)) return r; }
  return { ok: true, side };
}
const T0 = (pos: number[], scale = [1, 1, 1]) => ({ pos, q: [0, 0, 0, 1], scale });

// ---------------- S: every request under BOUND_MS at a world's size ----------------
function scaleCase(n: number) {
  return (s: any) => { cast(s);
    if (n > 1900) s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: 2400 } });
    const f = fill(s, n); if (!ok(f)) return { fill: show(f) };
    const X = f.side * 2 + 40;   // the furniture stands east of the grid
    s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([X, 0, 0], [20, 1, 20]) } });
    s.call("olive", "create", { id: "slab", model: "crate", components: { transform: T0([X, 0.75, 0]) } });   // where a place on `big` wants to go
    for (let k = 0; k < 5; k++) { s.call("olive", "create", { id: `base-${k}`, model: "crate", components: { transform: T0([X - 20 - 2 * k, 0, 30]) } });
      s.call("olive", "create", { id: `top-${k}`, model: "crate", components: { transform: T0([X - 20 - 2 * k, 0.6, 30]) } });
      const tx = X - 20.7 + [-0.7, 0, 0.7, -0.35, 0.35][k], tz = k < 3 ? 40 : 38.8;   // all within reach of one spot
      s.call("olive", "create", { id: `tray-${k}`, model: "crate", components: { transform: T0([tx, 0, tz]), grabbable: { who: "member" } } });
      s.call("olive", "create", { id: `cup-${k}`, model: "book", components: { transform: T0([tx, 0.6, tz]), grabbable: { who: "member" } } }); }
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
    op("batch", (i) => s.call("olive", "batch", { requests: Array.from({ length: 50 }, (_, k) => ({ verb: "create", args: { model: "crate", components: { transform: T0([X - 60 - k, 0, -20 - 4 * i]) } } })) }, 20000));
    s.call("vic", "move", { to: [X - 20.7, 0, 39.4], teleport: true }, 20000);
    // grab a tray WITH its cup on it (so grab's "what rested on it loses support" pass is timed: the cup is set down), walk
    // it (untimed) to its own clear spot and drop it there straight down (timed): the op is grab + drop. Each tray gets its
    // own spot: dropped at vic's feet they stacked until a drop was refused, the tray stayed held, and a later grab met
    // hold-limit (only on a host slow enough to repeat the op: the loop stops at the first try within FLOOR_MS)
    { let bestG: any = null;
      for (let i = 0; i < 5; i++) { const t = `tray-${i}`;
        s.call("vic", "move", { to: [X - 20.7, 0, 39.4], teleport: true }, 20000);
        const g = timed(() => s.call("vic", "grab", { id: t }, 20000));
        const cupY = s.w().state().entities[`cup-${i}`]?.c.transform?.pos?.[1];   // the pass S1 means to time: the cup lost its tray
        if (code(g.r) === "ok" && !(cupY < 0.3)) throw new Error(`setup: cup-${i} didn't come down when ${t} was lifted (y ${cupY})`);
        if (code(g.r) === "ok") for (const to of [[X - 22.2, 0, 39.4], [X - 22.2, 0, 37.4 + i], [X - 23.4, 0, 37.4 + i]]) {   // a teleport can't carry; strides between the trays. (Untimed: a move while carrying is a request S1 does not bound.)
          const walk = s.call("vic", "move", { to }, 20000);
          if (code(g.r) === "ok" && code(walk) !== "ok") throw new Error(`setup: couldn't walk ${t} to ${JSON.stringify(to)}: ${JSON.stringify(walk).slice(0, 200)}`); }
        const d = timed(() => s.call("vic", "drop", { id: t }, 20000));
        if (code(g.r) === "ok" && code(d.r) !== "ok") throw new Error(`setup: ${t} wouldn't go down: ${JSON.stringify(d.r).slice(0, 200)}`);
        const x = { ms: g.ms + d.ms, r: g.r }; if (!bestG || x.ms < bestG.ms) bestG = x; if (x.ms <= FLOOR_MS) break; }
      ms.grab = r1(bestG.ms); codes.grab = code(bestG.r); }
    return { n, ms, codes, things: Object.keys(s.w().state().entities).length - 1, bound: r1(bound()) }; };
}
// each op's time at the large world over its time at the small one (a small time is read as FLOOR_MS: noise, not growth)
const growth = (small: any, large: any, skip: string[] = []) => Object.fromEntries(Object.keys(large).filter((k) => !skip.includes(k))
  .map((k) => [k, r1(large[k] / Math.max(small?.[k] ?? 0, FLOOR_MS))]));
// a write (and grab+drop, two of them) pays the log append and index refile, visible on a fast disk (CI 2.5–4.5×); scan mutants 43–383×
const GROWS_OP: Record<string, number> = { delete: 10, create: 10, set: 10, grab: 10 };
const grewOk = (g: any) => !!g && Object.entries(g).every(([k, v]: [string, any]) => v <= (GROWS_OP[k] ?? GROWS));
// the small world and the large one are built and timed in turn, ROUNDS times, each op's best kept: a busy host then slows
// both sides alike, where one after the other a burst lands on only one of them
const ROUNDS = 3;
const paired = (small: () => any, large: () => any) => { let sm: any = null, lg: any = null;
  const keep = (a: any, b: any) => (!a?.ms ? b : !b?.ms ? a : { ...b, ms: Object.fromEntries(Object.keys(b.ms).map((k) => [k, Math.min(a.ms[k] ?? Infinity, b.ms[k])])) });
  for (let r = 0; r < ROUNDS; r++) { sm = keep(sm, small()); lg = keep(lg, large()); if (!lg?.ms || !sm?.ms) break; }
  return { small: sm, large: lg }; };
// the same world built at n and at 72 things: check {} reads every thing by design (bounded by the work budget, Q3), so it isn't held to growth
const scaleGrows = (n: number) => (s: any) => { let first = true;
  const { small, large: o } = paired(() => scaleCase(72)(session()), () => scaleCase(n)(first ? ((first = false), s) : session()));
  if (!o?.ms || !small?.ms) return { ...o, small, grew: null };   // no baseline measured: growth unknown, which fails the row
  return { ...o, small: small.ms, grew: growth(small.ms, o.ms, ["check"]) }; };
const scaleGood = (o: any) => !!o.ms && Object.values(o.ms).every((v: any) => v <= o.bound) && (o.grew === undefined || (o.grew !== null && grewOk(o.grew)))
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
const withLab = (extra: any) => { const lab = LAB_CATALOGUE; return { get: (n: string) => (Object.hasOwn(extra, n) ? extra[n] : lab.get(n)), list: (q: string) => lab.list(q) }; };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean; o?: any };
const cases: Case[] = [
  { id: "S1", what: `at 72 things (the Commons' size) each of the ten timed requests takes under ${BOUND_MS} ms (best of 5)`, run: scaleCase(72), good: scaleGood },
  { id: "S2", what: `at 500 things every request costs at most ${GROWS}× what it does at 72 (delete, create, set, grab ${GROWS_OP.delete}×; check {} aside)`, run: scaleGrows(500), good: scaleGood },
  { id: "S3", what: `at 2 000 things every request costs at most ${GROWS}× what it does at 72 (delete, create, set, grab ${GROWS_OP.delete}×; check {} aside)`, run: scaleGrows(2000), good: scaleGood },

  // ---------------- Q: the gates in front of the work ----------------
  { id: "Q1", what: "a visitor's place onto a table scaled 1000× is refused (rights) before any search, and still recorded as an attempt", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "lid", model: "crate", components: { transform: T0([0, 0.75, 0], [1000, 1, 1000]) } });   // nothing on it is free
      s.call("olive", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, 600]) } });
      const n0 = s.w().entries.length; const x = timed(() => s.call("vic", "place", { id: "mug", on: "big" }));
      return { code: code(x.r), ms: r1(x.ms), units: x.units, bound: r1(bound()), logged: s.w().entries.slice(n0).filter((e: any) => e.kind === "request" && e.body?.refused?.code === "rights").length }; },
    good: (o) => o.code === "rights" && o.units === 0 && o.ms <= o.bound && o.logged === 1 },
  { id: "Q2", what: "a builder's place onto a 1000× table with nothing free on it ends inside the work budget: refused too-costly, saying why", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "lid", model: "crate", components: { transform: T0([0, 0.75, 0], [1000, 1, 1000]) } });
      s.call("olive", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, 600]) } });
      const dry = best(5, () => s.call("bob", "place", { id: "mug", on: "big", dry: true })); const real = best(5, () => s.call("bob", "place", { id: "mug", on: "big" }));
      return { dry: code(dry.r), dryMs: r1(dry.ms), dryUnits: dry.units, real: code(real.r), realMs: r1(real.ms), realUnits: real.units, budget: BUDGET, bound: r1(bound()), why: real.r?.refused?.reason }; },
    good: (o) => o.dry === "too-costly" && o.real === "too-costly" && o.dryUnits >= o.budget && o.realUnits >= o.budget && o.dryUnits <= o.budget + 1000 && o.dryMs <= o.bound && o.realMs <= o.bound && /shared by every world/.test(o.why ?? "") },
  { id: "Q2b", what: "a place onto a top past the 2.5 cm grid's reach (10 000×) is refused too-costly at once, and the work meter stays a count after it (spend(Infinity))", run(s) { cast(s);
      s.call("olive", "create", { id: "plinth", model: "crate", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      const mk = s.call("olive", "create", { id: "vast", model: "table", components: { transform: T0([0, 1, 0], [10, 1, 10]), parent: { to: "plinth" } } });   // a scale's bound is 1000: 10× on a 1000× parent
      s.call("olive", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, 6000]) } });
      const x = timed(() => s.call("bob", "place", { id: "mug", on: "vast" })); const after = timed(() => s.call("vic", "lint", { id: "mug" }));
      return { made: show(mk), code: code(x.r), why: x.r?.refused?.reason, after: after.units, meter: METER?.units }; },
    good: (o) => o.made === "ok" && o.code === "too-costly" && /^finding room for mug on vast/.test(o.why ?? "") && Number.isFinite(o.after) && Number.isFinite(o.meter) },
  { id: "Q3", what: "check {} on a heap of 700 things in one spot is refused too-costly inside the budget, saying what it was checking; a batch of 120 creates into the heap still lands, its warnings saying what went unchecked", run(s) { cast(s);
      fill(s, 700, () => [0, 0, 0]);
      const c = best(5, () => s.call("vic", "lint", {})); const one = best(5, () => s.call("vic", "lint", { id: "c-3" }));
      const mk = best(3, (i) => s.call("olive", "batch", { requests: Array.from({ length: 120 }, (_, k) => ({ verb: "create", args: { id: `more-${i}-${k}`, model: "crate", components: { transform: T0([0, 0, 0]) } } })) }, 20000));
      return { check: code(c.r), ms: r1(c.ms), units: c.units, budget: BUDGET, one: code(one.r), oneMs: r1(one.ms), batch: code(mk.r), batchMs: r1(mk.ms), bound: r1(bound()), made: !!s.w().state().entities["more-0-119"],
        unchecked: mk.r?.warnings?.find((x: any) => x.kind === "unchecked")?.things ?? 0, why: c.r?.refused?.reason }; },
    // the refusal names what it was checking
    good: (o) => o.check === "too-costly" && o.units >= o.budget && o.units <= o.budget + 1000 && /^checking \d+ things would take more of the authority's time/.test(o.why ?? "") && o.ms <= o.bound && o.one === "ok" && o.oneMs <= o.bound && o.batch === "ok" && o.made && o.unchecked > 0 && o.batchMs <= 2 * o.bound },
  { id: "Q4", what: "reads are metered per connection (server/readmeter.ts): 300 in 10 s, or 1.5 s of the authority's time, then refused (rate) until the window moves", run() {
      if (!RM) return { missing: true };
      const m = RM.readMeter(); const a = {}, b = {}; let t = 1000; const out: any = {};
      for (let i = 0; i < RM.READ.n; i++) { if (m.check(a, t)) return { refusedEarly: i }; m.record(a, t); }
      out.overCap = m.check(a, t)?.code ?? "ok"; out.later = m.check(a, t + 10_001)?.code ?? "ok";
      const k = m.record(b, t); k.ms = RM.READ.ms + 100; out.slow = m.check(b, t + 1)?.code ?? "ok"; out.other = m.check({}, t)?.code ?? "ok";
      return out; },
    good: (o) => o.overCap === "rate" && o.later === "ok" && o.slow === "rate" && o.other === "ok" },
  { id: "Q4b", what: "a read's time is charged when the authority answers: a read that ran past the window is still on the meter then, not expired before its cost landed", run() {
      if (!RM) return { missing: true };
      let clock = 1000; const m = RM.readMeter(RM.READ, () => clock); const a = {};
      const k = m.record(a, clock); clock += RM.READ.window + 1000; k.ms = RM.READ.ms + 100;   // answered 11 s after it arrived
      return { then: m.check(a, clock + 1)?.code ?? "ok", gone: m.check(a, clock + RM.READ.window + 1)?.code ?? "ok" }; },
    good: (o) => o.then === "rate" && o.gone === "ok" },
  { id: "Q5", what: "settling orphaned holds at load is bounded: 400 holders left by a crash end quickly, the first ≤16 settled, the rest said to wait (counts and time only; how each is put down is grab-check's)", run(s) { cast(s);
      const holds: any = {}, bodies: any = {};
      for (let made = 0; made < 400;) { const ops = []; for (let k = 0; k < 50; k++, made++) ops.push({ verb: "create", args: { id: `g-${made}`, model: "book", components: { transform: T0([made % 20, 0, Math.floor(made / 20)]), grabbable: { who: "member" } } } });
        s.call("olive", "batch", { requests: ops }, 20000); }
      for (let i = 0; i < 400; i++) { holds[`g-${i}`] = { by: `h-${i}`, since: clock.t, pose: { pos: [i % 20, 1.1, Math.floor(i / 20)], q: [0, 0, 0, 1], scale: [1, 1, 1] }, handled: [`h-${i}`] }; bodies[`h-${i}`] = { at: [i % 20, 0, Math.floor(i / 20)], ts: clock.t, tokens: 4 }; }
      s.call("olive", "look", {}, 20000);
      let w: any = null;   // best of 3 fresh loads, as best() does for the other rows: one slow scheduler slice isn't the bound
      let appends = 0;
      const x = best(3, () => { w = s.reopen({ presence: structuredClone({ holds, bodies }) }); appends = 0; const append = w.append.bind(w); w.append = (...a: any[]) => (appends++, append(...a)); try { return D.settleOrphans(w, []); } finally { w.append = append; } });
      return { ms: r1(x.ms), appends, bound: r1(8 * bound()), settled: x.r.filter((r: any) => r.holder).length, deferred: x.r.find((r: any) => r.deferred)?.deferred ?? 0, holdsLeft: Object.keys(w.presence.holds).length }; },
    good: (o) => o.ms <= o.bound && o.settled > 0 && o.settled <= 16 && o.appends <= 2 * o.settled + 2 && o.deferred === 400 - o.settled && o.holdsLeft === 0 },

  { id: "Q6", what: "place {on, offset} far off a 1000× table, or onto one whose middle is taken, ends quickly and answers as the full search would (the nearest free spot)", run(s) { cast(s);
      s.call("bob", "create", { id: "big", model: "table", components: { transform: T0([0, 0, 0], [1000, 1, 1000]) } });
      s.call("bob", "create", { id: "slab", model: "crate", components: { transform: T0([0, 0.75, 0], [4, 1, 4]) } });
      s.call("bob", "create", { id: "mug", model: "crate", components: { transform: T0([2, 0, -3000]) } });
      const far = timed(() => s.call("bob", "place", { id: "mug", on: "big", offset: [1000, 0], attach: false, dry: true }));
      const mid = timed(() => s.call("bob", "place", { id: "mug", on: "big", attach: false, dry: true }));
      const at = (r: any) => r?.would?.find((o: any) => o.comp === "transform")?.value?.pos;
      return { far: code(far.r), farMs: r1(far.ms), farUnits: far.units, farAt: at(far.r), mid: code(mid.r), midMs: r1(mid.ms), midUnits: mid.units, midAt: at(mid.r), budget: BUDGET, bound: r1(bound()) }; },
    good: (o) => o.far === "ok" && o.mid === "ok" && o.farUnits < 1000 && o.midUnits < o.budget / 2 && o.farMs <= o.bound && o.midMs <= o.bound && Math.abs(o.farAt?.[0] - 599.7) < 0.01 && Math.abs(o.farAt?.[2]) < 0.01 && Math.abs(Math.abs(o.midAt?.[0]) - 1.5) < 0.01 && Math.abs(o.midAt?.[2]) < 0.01 },   // the nearest free spots: the edge toward the offset; beside the slab (which side: G3 compares with the full scan)
  // ---------------- C: capacity ----------------
  { id: "C1", what: "a world at capacity.entities refuses what would add (full), a new socket the same as a new thing, a batch that would cross it whole; a delete frees room; other changes stay open", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: 10 } });
      const made = []; for (let i = 0; i < 9; i++) made.push(code(s.call("bob", "create", { id: `t-${i}`, model: "crate", components: { transform: T0([i, 0, 0]) } }, 2000)));
      made.push(code(s.call("bob", "create", { id: "t-1-seat", components: { parent: { to: "t-1" }, socket: { name: "seat" } } }, 2000)));   // the 10th entity is a socket
      const over = s.call("bob", "create", { id: "t-10", model: "crate" }, 2000);
      const sock = s.call("bob", "create", { id: "t-2-seat", components: { parent: { to: "t-2" }, socket: { name: "seat" } } }, 2000);
      const set = s.call("bob", "set", { id: "t-1", component: "label", value: "still open" }, 2000);
      s.call("bob", "delete", { id: "t-0" }, 2000);
      const batch = s.call("bob", "batch", { requests: [{ verb: "create", args: { id: "t-11", model: "crate" } }, { verb: "create", args: { id: "t-12", model: "crate" } }] }, 2000);
      const one = s.call("bob", "create", { id: "t-13", model: "crate", components: { transform: T0([0, 0, 3]) } }, 2000);
      return { made: [...new Set(made)], over: code(over), why: `${over.refused?.reason} | ${over.refused?.fix}`, sock: code(sock), sockWhy: sock.refused?.reason, set: code(set), batch: code(batch), one: code(one), entities: Object.keys(s.w().state().entities).length - 1 }; },
    good: (o) => JSON.stringify(o.made) === '["ok"]' && o.over === "full" && /holds 10 entities and its limit is 10 \(@world\.capacity\.entities\)/.test(o.why) && /value: \{entities: <n>\}/.test(o.why) && o.sock === "full" && /@world\.capacity\.entities/.test(o.sockWhy ?? "") && o.set === "ok" && o.batch === "full" && o.one === "ok" && o.entities === 10 },
  { id: "C2", what: `unset, a fresh world holds ${CAPACITY.entities} entities (this server's default, R 10-14); the owner may raise it, never past this server's ceiling`, run(s) { cast(s);
      const MAX = CAPACITY_CEILING.entities;
      const f = fill(s, CAPACITY.entities); const over = s.call("bob", "create", { id: "x", model: "crate" }, 20000);
      const raise = s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: CAPACITY.entities + 100 } }, 20000);
      const now = s.call("bob", "create", { id: "y", model: "crate", components: { transform: T0([400, 0, 400]) } }, 20000);
      const tooHigh = s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: MAX + 1000 } }, 20000);
      const builder = s.call("bob", "set", { id: "@world", component: "capacity", value: { entities: CAPACITY.entities + 1000 } }, 20000);
      return { def: CAPACITY.entities, max: MAX, fill: show(f), over: code(over), raise: code(raise), now: code(now), tooHigh: code(tooHigh), builder: code(builder) }; },
    good: (o) => o.def === 10000 && o.max === 50000 && o.fill === "ok" && o.over === "full" && o.raise === "ok" && o.now === "ok" && o.tooHigh === "bounds" && o.builder === "rights" },
  { id: "C2a", what: `capacity has three fields, entities, guestEntities and avatar (R 10-15: things, guestThings, sockets and guestSockets are gone); capacity.avatar (the largest entity tree one worn avatar may be) reads ${CAPACITY.avatar} unset (this server's default); the owner sets it within 1–5000 (the registry's floor, the server's ceiling) and only that field is stored; 0 and 5001 are refused (bounds); a builder may not; a gone field is refused; each field's docs say PER WHAT first (R 10-15)`, run(s) { cast(s);
      const cap = () => s.w().state().entities["@world"]?.c.capacity;
      const def = CAPACITY.avatar, rng = { ...COMPONENTS.capacity.ranges.avatar, max: CAPACITY_CEILING.avatar }, unset = cap()?.avatar ?? null;
      const set = s.call("olive", "set", { id: "@world", component: "capacity", value: { avatar: 3000 } }, 20000); const after = cap();
      const low = s.call("olive", "set", { id: "@world", component: "capacity", value: { avatar: 0 } }, 20000);
      const high = s.call("olive", "set", { id: "@world", component: "capacity", value: { avatar: 5001 } }, 20000);
      const builder = s.call("bob", "set", { id: "@world", component: "capacity", value: { avatar: 4000 } }, 20000);
      const gone = s.call("olive", "set", { id: "@world", component: "capacity", value: { things: 5 } }, 20000);
      const D = COMPONENTS.capacity.docs ?? {}, H = COMPONENTS.capacity.help ?? "";
      return { per: [/^the whole world's entities/.test(D.entities ?? ""), /^all account-less people's entities together/.test(D.guestEntities ?? ""), /^one worn avatar's/.test(D.avatar ?? ""), /not enforced/.test(D.avatar ?? ""), /not enforced/.test(H), /sockets included/.test(D.entities ?? "")], fields: Object.keys(COMPONENTS.capacity.fields), cap: Object.keys(CAPACITY), def, rng, unset, set: code(set), avatar: after?.avatar, entities: after?.entities, guestEntities: after?.guestEntities, low: code(low), high: code(high), builder: code(builder), gone: code(gone), kept: cap()?.avatar, stored: Object.keys(cap() ?? {}).sort() }; },
    good: (o) => o.per.every(Boolean) && JSON.stringify(o.fields) === '["entities","guestEntities","avatar"]' && JSON.stringify(o.cap) === JSON.stringify(o.fields) && o.def === CAPACITY.avatar && o.def === 2000 && o.rng?.min === 1 && o.rng?.max === 5000 && o.unset === null && o.set === "ok" && o.avatar === 3000 && o.entities === undefined && o.guestEntities === undefined
      && o.low === "bounds" && o.high === "bounds" && o.builder === "rights" && o.gone !== "ok" && o.kept === 3000 && JSON.stringify(o.stored) === '["avatar"]' && !COMPONENTS.capacity.defaults },
  { id: "C3b", what: "the guest refusal names the component and key the world reads (@world.capacity.guestEntities) and says it is all account-less people's entities together, so an owner can follow it (review 10-14 C6/M9)", run(s) {
      const sess = session({ kindOf: (id: string) => (id.startsWith("g") ? "anon" : "human") }); s = sess;
      s.call("olive", "create-world", { title: "guests2" });
      s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
      // nothing written: the guests meet the default (capacity.guestEntities), and the refusal names the key the world reads
      const made = []; for (let i = 0; i < CAPACITY.guestEntities; i++) made.push(code(s.call("g1", "create", { id: `g1-${i}`, model: "crate", components: { transform: T0([i % 50, 0, Math.floor(i / 50) * 2]) } }, 2000)));
      const r = s.call("g1", "create", { id: "g1-x", model: "crate" }, 2000);
      return { def: CAPACITY.guestEntities, made: [...new Set(made)], code: code(r), text: `${r?.refused?.reason} | ${r?.refused?.fix}` }; },
    good: (o) => o.def === 500 && JSON.stringify(o.made) === '["ok"]' && o.code === "full" && new RegExp(`have ${CAPACITY.guestEntities} entities standing here, and this world lets them have ${CAPACITY.guestEntities} \\(@world\\.capacity\\.guestEntities\\), all of them together`).test(o.text) && /value: \{guestEntities: <n>\}/.test(o.text) && !/capacity@/.test(o.text) },
  { id: "C3", what: "guests together have at most capacity.guestEntities entities standing, sockets included (a fresh guest identity per connection gets no fresh share); an account still builds; a guest's delete frees room", run(s) {
      const sess = session({ kindOf: (id: string) => (id.startsWith("g") ? "anon" : "human") }); s = sess;
      s.call("olive", "create-world", { title: "guests" });
      s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder", guests: "builder" } });
      s.call("olive", "set", { id: "@world", component: "capacity", value: { guestEntities: 5 } });
      const r = [];
      for (const [who, n] of [["g1", 3], ["g2", 1]]) for (let i = 0; i < n; i++) r.push(code(s.call(who, "create", { id: `${who}-${i}`, model: "crate", components: { transform: T0([i, 0, who === "g1" ? 0 : 2]) } }, 2000)));
      r.push(code(s.call("g2", "create", { id: "g2-0-seat", components: { parent: { to: "g2-0" }, socket: { name: "seat" } } }, 2000)));   // the pool's 5th is a socket
      const g3 = s.call("g3", "create", { id: "g3-0", model: "crate" }, 2000);
      const g2s = s.call("g2", "create", { id: "g2-0-arm", components: { parent: { to: "g2-0" }, socket: { name: "arm" } } }, 2000);
      const acct = s.call("bob", "create", { id: "bob-0", model: "crate", components: { transform: T0([5, 0, 5]) } }, 2000);
      const del = s.call("g1", "delete", { id: "g1-0" }, 2000);
      const g3b = s.call("g3", "create", { id: "g3-1", model: "crate", components: { transform: T0([8, 0, 8]) } }, 2000);
      return { r: [...new Set(r)], g3: code(g3), why: g3.refused?.reason, g2s: code(g2s), acct: code(acct), del: code(del), g3b: code(g3b) }; },
    good: (o) => JSON.stringify(o.r) === '["ok"]' && o.g3 === "full" && /account-less people/.test(o.why ?? "") && o.g2s === "full" && o.acct === "ok" && o.del === "ok" && o.g3b === "ok" },

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
      s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([1, 0.1, 1]), grabbable: { who: "member" } } });
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
  { id: "R1", what: "a request nested in another (a host callback re-entering the authority with a leave, whose drops are requests too) leaves the outer call's queued events alone: the outer put's changed: event is still queued after it (changedQ only; the release queue isn't read)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "member" } });
      s.call("olive", "create", { id: "mug", model: "book", components: { transform: T0([0, 0, 0]), grabbable: { who: "member" } } });
      s.call("olive", "create", { id: "ball", model: "book", components: { transform: T0([3, 0, 0]), grabbable: { who: "member" } } });
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
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "member" } });
      for (let k = 0; k < 2; k++) s.call("olive", "create", { id: `b-${k}`, model: "book", components: { transform: T0([0.2 * k, 0, 0]), grabbable: { who: "member", ...(k < 1 ? { release: "return" } : {}) } } });   // one goes home: the second lands alone (two hands: MAX_HELD)
      s.call("olive", "create", { id: "ball", model: "book", components: { transform: T0([3, 0, 0]), grabbable: { who: "member" } } });
      s.call("ann", "move", { to: [3, 0, 0.5] }); s.call("ann", "grab", { id: "ball" });
      for (let i = 0; i < 64; i++) s.call("vic", "move", { to: [0, 0, 0.5 + (i % 2) * 0.1], teleport: true }, 10);   // vic's budget for this window is spent (each an act)
      for (let k = 0; k < 2; k++) s.call("vic", "grab", { id: `b-${k}` }, 10);
      const w = s.w(); const save = w.savePresence; let nested: any = null;
      let fired = false; w.savePresence = () => { save(); if (!fired && w.leaving === "vic") { fired = true; nested = D.request(w, "ann", "leave", {}); } };
      const r = s.call("vic", "leave", {}, 10); w.savePresence = save;
      return { nested: show(nested), dropped: r.dropped?.map((d: any) => d.ok), why: r.dropped?.map((d: any) => d.refused ?? null), held: Object.keys(w.presence.holds) }; },
    good: (o) => o.nested === "ok" && JSON.stringify(o.dropped) === "[true,true]" && o.held.length === 0 },

  // ---------------- more S (S5, S6, S4: red at base like the rest), then G: guards ----------------
  { id: "S5", what: `rotated furniture at 1 500 things (300 desks turned 30°, four books on each): look, and placing a book on a turned desk with a box in its middle, each cost at most ${GROWS}× what they do with 20 desks; check {} is held only to the backstop`, run(s) {
      const at = (s: any, desks: number) => { cast(s);
      const yq = (deg: number) => [0, Math.sin(deg * Math.PI / 360), 0, Math.cos(deg * Math.PI / 360)];
      for (let d = 0; d < desks;) { const ops = []; for (let k = 0; k < 10; k++, d++) { const x = (d % 20) * 3 - 30, z = Math.floor(d / 20) * 3 - 22;
          ops.push({ verb: "create", args: { id: `desk-${d}`, model: "table", components: { transform: { pos: [x, 0, z], q: yq(30), scale: [1.5, 1, 1.5] } } } });
          for (let b = 0; b < 4; b++) ops.push({ verb: "create", args: { id: `bk-${d}-${b}`, model: "book", components: { transform: { pos: [x + (b - 1.5) * 0.25, 0.75, z], q: yq(30), scale: [1, 1, 1] } } } }); }
        const r = s.call("olive", "batch", { requests: ops }, 20000); if (!ok(r)) return { fill: show(r) }; }
      s.call("olive", "create", { id: "pile", model: "crate", components: { transform: { pos: [-30, 0.75, -22], q: yq(30), scale: [1.2, 0.3, 1.2] } } }, 20000);
      s.call("olive", "create", { id: "cup", model: "book", components: { transform: T0([40, 0, 40]) } }, 20000);
      const ms: any = {}, codes: any = {};
      const op = (k: string, f: (i: number) => any) => { const x = best(5, f); ms[k] = r1(x.ms); codes[k] = code(x.r); };
      op("check", () => s.call("vic", "lint", {})); op("look", () => s.call("vic", "look", {}));
      op("place", () => s.call("bob", "place", { id: "cup", on: "desk-0", dry: true }));
      return { ms, codes }; };
      let first = true; const { small: sm, large: o } = paired(() => at(session(), 20), () => at(first ? ((first = false), s) : session(), 300));
      const small = sm; if (!o?.ms || !small?.ms) return { ...o, small };
      return { ...o, small: small.ms, grew: growth(small.ms, o.ms, ["check"]), bound: r1(bound()) }; },
    good: (o) => !!o.ms && Object.values(o.ms).every((v: any) => v <= o.bound) && grewOk(o.grew) && JSON.stringify(o.codes) === '{"check":"ok","look":"ok","place":"ok"}' },
  { id: "S6", what: `a 4 m step beside 800 small things at body height (books on shelves) costs at most ${GROWS}× as much with 4 000 more things far off (the index, not a scan of the world), and one into them is refused (solid) alike`, run(s) {
      const at = (s: any, far: number) => { cast(s); const N = 800;
      if (far) { s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: N + far + 100 } });
        for (let k = 0; k < far;) { const ops = []; for (let q = 0; q < 50 && k < far; q++, k++) ops.push({ verb: "create", args: { id: `far-${k}`, model: "crate", components: { transform: T0([300 + (k % 60) * 3, 0, 250 + Math.floor(k / 60) * 3]) } } });
          const r = s.call("olive", "batch", { requests: ops }, 20000); if (!ok(r)) return { fill: show(r) }; } }
      for (let made = 0; made < N;) { const ops = []; for (let k = 0; k < 50 && made < N; k++, made++) ops.push({ verb: "create", args: { id: `b-${made}`, model: "book", components: { transform: T0([2.2 + (made % 10) * 0.06, 0.9 + (Math.floor(made / 100) % 8) * 0.1, 2.2 + (Math.floor(made / 10) % 10) * 0.06]) } } });
        const r = s.call("olive", "batch", { requests: ops }, 20000); if (!ok(r)) return { fill: show(r) }; }
      s.call("vic", "move", { to: [0, 0, 2.8] }, 5000);
      const past = best(5, (i) => s.call("vic", "move", { to: i % 2 ? [0, 0, 2.8] : [2.8, 0, 0] }, 2000));
      s.call("vic", "move", { to: [0, 0, 2.8], teleport: true }, 5000);
      const into = best(5, () => s.call("vic", "move", { to: [2.5, 0, 2.5] }, 2000));
      return { ms: { past: r1(past.ms), into: r1(into.ms) }, past: code(past.r), into: code(into.r) }; };
      let first = true; const { small: sm, large: o } = paired(() => at(session(), 0), () => at(first ? ((first = false), s) : session(), 4000));
      const small = sm; if (!o?.ms || !small?.ms) return { ...o, small };
      return { ...o, small: small.ms, grew: growth(small.ms, o.ms), bound: r1(bound()) }; },
    good: (o) => o.past === "ok" && o.into === "solid" && o.ms.past <= o.bound && o.ms.into <= o.bound && grewOk(o.grew) },
  { id: "S4", what: `look over 2 000 things: the first 40 in the tree's order and the total, at most ${GROWS}× what look costs over 72`, run(s) {
      const at = (s: any, n: number) => { cast(s); s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: 2400 } });
        fill(s, n); for (let k = 0; k < 3; k++) s.call("olive", "create", { id: `kid-${k}`, model: "book", components: { parent: { to: "c-0" }, transform: T0([0, 0.6, 0]) } });
        const x = best(5, () => s.call("vic", "look", {})); return { ms: { look: r1(x.ms) }, r: x.r }; };
      let first = true; const { small, large } = paired(() => at(session(), 72), () => at(first ? ((first = false), s) : session(), 2000)); const x = { ms: large.ms.look, r: large.r };
      return { ms: r1(x.ms), grew: growth(small.ms, large.ms), bound: r1(bound()), n: x.r.things?.length, total: x.r.total, first: x.r.things?.slice(0, 40).map((t: any) => `${t.id}@${t.depth}`) }; },
    good: (o) => o.ms <= o.bound && grewOk(o.grew) && o.n === 40 && o.total === 2003 && JSON.stringify(o.first) === JSON.stringify(["c-0@0", "kid-0@1", "kid-1@1", "kid-2@1", ...Array.from({ length: 36 }, (_, i) => `c-${i + 1}@0`)]) },
  // S7 counts what S2/S3 time: S3's place grew 0.8 → 1.8 ms from 72 to 2 000 things (CI 3.2–3.4×, over GROWS) through whole-world
  // passes a place onto one known table never needed. A pass here is one Object.keys/values/entries of the whole world (the
  // result at least as long as the world), a copy one Object.assign from a source that large (fold.js cowState): machine-free.
  // Left: the derived index's walk of the keys (deriveIx), its children map (rebuilt: the place re-parents the crate), admit's
  // working copies; and planResettle's occupant scan (re-parenting re-expresses the crate's local scale, which geomKey reads as
  // a reshape)
  { id: "S7", what: "a dry place onto one known table at 2 000 things reads the whole world at most 3 times (the derived index, its children map, the reshape's occupant scan) and copies it at most 3 (admit's two working copies, the search's preview); main read it 7 times (also the return-home scan, two socket-rule child maps, place's descendants) and copied it 5 (also shapes' and homes' previews, made when no op could stamp anything)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "capacity", value: { entities: 2400 } });
      const f = fill(s, 2000); if (!ok(f)) return { fill: show(f) };
      const X = f.side * 2 + 40;
      s.call("olive", "create", { id: "big", model: "table", components: { transform: T0([X, 0, 0], [20, 1, 20]) } });
      s.call("olive", "create", { id: "slab", model: "crate", components: { transform: T0([X, 0.75, 0]) } });
      s.call("bob", "place", { id: "c-6", on: "big", dry: true });   // warm: the first request builds this state's index whole
      const n = Object.keys(s.w().state().entities).length; const passes: string[] = [];
      const orig = { keys: Object.keys, values: Object.values, entries: Object.entries, assign: Object.assign }; const copies: string[] = [];
      const at = () => new Error().stack?.split("\n")[3]?.trim().replace(/\(.*\//, "(");
      const wrap = (k: "keys" | "values" | "entries") => function (o: any) { const r = (orig[k] as any)(o); if (r.length >= n) passes.push(`${k} ${at()}`); return r; };
      // a copy of the world: an Object.assign from a source as large as it (fold.js cowState's entities)
      const assign = function (t: any, ...src: any[]) { if (src.some((x) => x && typeof x === "object" && orig.keys(x).length >= n)) copies.push(new Error().stack?.split("\n")[3]?.trim().replace(/\(.*\//, "(") ?? ""); return orig.assign(t, ...src); };
      let r: any; try { Object.keys = wrap("keys"); Object.values = wrap("values") as any; Object.entries = wrap("entries") as any; Object.assign = assign as any;
        r = s.call("bob", "place", { id: "c-7", on: "big", dry: true }); } finally { orig.assign(Object, orig); }
      return { code: code(r), n, passes: passes.length, copies: copies.length, where: passes, copied: copies }; },
    good: (o) => o.code === "ok" && o.n >= 2000 && o.passes <= 3 && o.copies <= 3 },
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
  const d = scratch("sctl"); const r0 = archiveTo(ENGINE, BASE, ["shared", "server", "tools", "defs", "client", "package.json"], d);
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  linkInto(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
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

// I4's run is realGlbs() below (the engine's catalogue measures GLBs asynchronously): the run loop awaits it in its turn
// the G3 scenario: every reply, with what differs between runs by design (chain heads, salts) left out; and the
// viewer's own consent shield, whose shape recut A2 changed on purpose (a switch, not a preset): G3 is about the index
function scenario() {
  // (and log positions: a refused move is no longer recorded, so the seqs after one shift by design)
  const s = session(); const out: any[] = []; const strip = (r: any) => JSON.parse(JSON.stringify(r ?? null, (k, v) => (["head", "seq", "act", "born", "cause", "recorded", "blocker", "shield"].includes(k) ? undefined : v)));   // recorded: an arrival isn't logged now (review 10-07 M3); blocker: a solid move refusal names what is in the way (body shove, 10-12), additive
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
  c("olive", "create", { id: "mug", model: "book", components: { grabbable: { who: BASE_RUNG, enabled: true, steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 } }, place: { on: "t-5" } }, 2000);
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
const RENAMED_KEYS: Record<string, string> = { teach: "fix", touchI: "intimate", verb: "op" };   // verb → op: a dry run's would ops, minor 1 (D3); the base wrote verb
async function sameAsBase() {
  const d = scratch("sbase"); const r0 = archiveTo(ENGINE, BASE, ["shared", "server", "package.json"], d);
  if (r0.exitCode !== 0) return { error: String(r0.stderr) }; linkInto(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const run = (tree: string) => { const r = Bun.spawnSync(["bun", path.join(ENGINE, "test/protocol/scale-check.ts"), "--tree", tree, "--scenario"], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    const t = r.stdout.toString(); try { return JSON.parse(t); } catch { return { bad: (t + r.stderr.toString()).slice(-400) }; } };
  const a = run(TREE), b0 = run(d); if (!Array.isArray(a) || !Array.isArray(b0)) return { a: a?.bad ?? "ok", b: b0?.bad ?? "ok" };
  // the base speaks the names before the 10-07 conventional-names pass: its replies' keys are read in today's names
  // R 10-21: the base commit's word for the base rung (visitor) is the rung this tree calls member
  const b = JSON.parse(JSON.stringify(b0), function (k, v) {   // (a shield never reaches here: strip drops it on both sides)
    if ((k === "who" || k === "role") && v === "visitor") return "member";
    if (!v || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([key, x]) => [Object.hasOwn(RENAMED_KEYS, key) ? RENAMED_KEYS[key] : key, x])); });
  // R 10-07: look and inspect read a thing as its name, description, what it can do and its state (shared/a11y.js): those
  // fields are additions the base never wrote, generated from components it also had. Compared without them, on both sides
  // 2026-10-09 (review of b398d7e3): a rotation the authority writes is made unit after rounding (the base wrote 0.707 per
  // axis, which isn't): compared as the rotation it means, normalised then rounded, on both sides
  const unitQ = (v: any) => { const n = Math.hypot(...v); return v.map((x: number) => Math.round((x / n) * 1e6) / 1e6); };
  // the rotations this tree WROTE: a transform's q (in after / would), not a value a request carried and a reply echoes
  const qs: number[][] = []; JSON.stringify(a, (k, v) => { if (k === "transform" && v && Array.isArray(v.q) && v.q.length === 4) qs.push(v.q);
    if (v && v.comp === "transform" && Array.isArray(v.value?.q) && v.value.q.length === 4) qs.push(v.value.q); return v; });   // after.<id>.transform, and a dry run's would op
  if (!qs.length) return { same: false, replies: a.length, why: "no written rotation to check (the scan would be vacuous)" };
  const notUnit = qs.find((q) => Math.abs(Math.hypot(...q) - 1) > 1e-9);   // ours must BE unit, not merely compare as one
  if (notUnit) return { same: false, replies: a.length, notUnit };
  // a refusal's code and its fix's shape are the contract; the metres inside its prose measure where a body ended up
  // ('mug is 6.316 m from you' here, 6.349 at the base). Prose (reason, fix) is compared with every number blanked.
  // Sockets are child entities now: a create that lands a model with sockets also mints the socket children, and `after`
  // carries them; the base minted none. Compared without any `after` entry that IS a socket (it has a `socket`
  // component): the host's own entry still has to match the base's exactly.
  const noA11y = (x: any) => JSON.stringify(x, (k, v) => (k === "can" || k === "state" || k === "description" || k === "sockets" || (k === "order" && v === "a0") ? undefined   // parent.order: cut by the shape audit 10-16 (nothing read it)
      // `sockets` on a look row: the children, listed (same addition)
    : k === "after" && v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, e]: any) => !(e && typeof e === "object" && "socket" in e)))
    : k === "notes" && Array.isArray(v) ? v.filter((e: any) => !(e && typeof e === "object" && "legacy" in e))   // the note saying it minted them
    : k === "q" && Array.isArray(v) && v.length === 4 && v.every(Number.isFinite) ? unitQ(v)
    : (k === "reason" || k === "fix") && typeof v === "string" ? v.replace(/-?\d+(\.\d+)?/g, "#") : v));
  const diff = a.findIndex((x: any, i: number) => noA11y(x) !== noA11y(b[i]));
  if (diff >= 0) { if (process.env.G3_DUMP) { fs.writeFileSync(process.env.G3_DUMP + ".here.json", noA11y(a[diff])); fs.writeFileSync(process.env.G3_DUMP + ".base.json", noA11y(b[diff])); } return { same: false, replies: a.length, at: diff, here: noA11y(a[diff]).slice(0, 300), base: noA11y(b[diff]).slice(0, 300) }; }
  return { same: diff < 0 && a.length === b.length, replies: a.length, ...(diff >= 0 ? { at: diff, here: JSON.stringify(a[diff]).slice(0, 300), base: JSON.stringify(b[diff]).slice(0, 300) } : {}) };
}
if (argv.includes("--scenario")) {
  // G3 compares answers, not host speed: lift the clock backstop (the base has none), keep the deterministic work count
  const SP = await imp1("shared/protocol/authority/spatial.js").catch(() => null); if (SP?.WORK_BUDGET) SP.WORK_BUDGET.ms = Infinity;
  console.log(JSON.stringify(scenario())); process.exit(0); }

// ---------------- run ----------------
// a row's timings: `ms` (a number or a map of them) and any `<name>Ms`. Red only on timing = it passes with them all at zero
const isTime = (k: string) => k === "ms" || k.endsWith("Ms") || k === "grew";
const zeroTimes = (o: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, !isTime(k) ? v : typeof v === "number" ? 0 :
  v && typeof v === "object" ? Object.fromEntries(Object.keys(v).map((n) => [n, 0])) : v]));
const slowest = (o: any) => Math.max(...Object.entries(o).filter(([k]) => isTime(k) && k !== "grew").flatMap(([, v]) => typeof v === "number" ? [v] : Object.values(v ?? {}) as number[]));
const timingOnly = (c: any, o: any) => !!o && typeof o.bound === "number" && Object.keys(o).some(isTime) && !c.good(o) && (() => { try { return !!c.good(zeroTimes(o)); } catch { return false; } })();
const SUITE = suite("scale-check", { cap: 900 });
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false; const slow: number[] = [];
  // a row red ONLY on its wall-clock bound is measured again, up to 3 attempts in all (Bazel's flaky_test_attempts); a
  // pass on a later attempt prints FLAKY with the slow timings, and a row whose behaviour is wrong is never retried
  for (let attempt = 1; attempt <= 3; attempt++) {
    good = false;
    try { o = c.id === "I4" ? await realGlbs() : c.id === "G3" ? await sameAsBase() : c.run(session()); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
    if (good || !timingOnly(c, o)) break;
    slow.push(slowest(o)); }
  SUITE.ok(good, `${c.id.padEnd(4)} ${c.what}${slow.length ? ` (${good ? "FLAKY" : "over the bound every time"}: ${slow.length} over-bound attempt(s): ${slow.map((m) => `${m} ms`).join(", ")})` : ""}`, o);
  if (good && o?.ms !== undefined) console.log(`       ${JSON.stringify(o.ms)}${o.grew ? ` grew ${JSON.stringify(o.grew)}` : ""} (backstop ${o.bound} ms)`);
}
SUITE.done();
