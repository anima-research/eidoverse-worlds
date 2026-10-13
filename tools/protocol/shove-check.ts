// tools/protocol/shove-check.ts — body shove at the authority: a punt {shove: true} that a walking body sends when it walks
// into a loose thing (shared/shove.js), through the real door. The shove has its own gate (shoveGate in authority.js) in place
// of the kick's reach; every other gate is the punt's.
//   bun tools/protocol/shove-check.ts                 every case
//   bun tools/protocol/shove-check.ts --only S1,S3    just those
//   bun tools/protocol/shove-check.ts --tree <dir>    against another checkout's shared/ (a mutant, a base)
//   bun tools/protocol/shove-check.ts --control       the base commit (e2238c07, before shove): every case must be red there
//   bun tools/protocol/shove-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red; a
//                                                    no-op control mutation must stay green
// S7 (rights) and S8 (locks) are the punt's own gates, held twice (at the punt and again where its rest is admitted), so no
// single mutation reaches them; grab-check G6 and eidosim-live pin those.
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "e2238c07";

const MUTANTS: [string, string, string, string, string[]][] = [
  ["the shove's own gate", "protocol/authority.js", "if (a.shove !== undefined) shoveGate(st, me, a, flying);\n    else if", "if (false) shoveGate(st, me, a, flying);\n    else if", ["S2", "S3", "S4", "S5", "S6", "S9", "S10"]],
  ["reach to the footprint", "protocol/authority.js", "if (d > SHOVE.reach) refuse(\"out-of-reach\"", "if (false) refuse(\"out-of-reach\"", ["S2"]],
  ["the speed cap", "protocol/authority.js", "if (sp > SHOVE.maxV) refuse(\"too-fast\"", "if (false) refuse(\"too-fast\"", ["S3"]],
  ["away from the feet", "protocol/authority.js", "if (mx * vx + mz * vz <= 0) refuse(\"wrong-way\"", "if (false) refuse(\"wrong-way\"", ["S4"]],
  ["not underfoot", "protocol/authority.js", "if (b.max[1] <= f[1] + SHOVE.underfoot) refuse(\"underfoot\"", "if (false) refuse(\"underfoot\"", ["S5"]],
  ["not in flight", "protocol/authority.js", "if (flying) refuse(\"in-flight\"", "if (false) refuse(\"in-flight\"", ["S6"]],
  ["along the ground", "protocol/authority.js", "if (vh < 1e-6 || vy < 0 || vy > SHOVE.lift * vh + 1e-9) refuse(\"shape\"", "if (false) refuse(\"shape\"", ["S9"]],
  ["a shove carries v", "protocol/authority.js", "refuse(\"shape\", \"a shove carries v", "(\"shape\", \"a shove carries v", ["S9"]],
  ["CONTROL (no-op: must stay green)", "protocol/physconst.js", "// a shove: a punt {shove: true}", "//  a shove: a punt {shove: true}", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/shove-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server"]) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true });
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("smut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[shove-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  const d = scratch("sctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const wrong = lines.filter((l) => l.startsWith("ok ") && !/^ok\s+S0\b/.test(l));
  console.log(lines.map((l) => `${l.startsWith("FAIL") || /^ok\s+S0\b/.test(l) ? "as expected at base: " : "WRONG AT BASE:       "}${l.slice(0, 140)}`).join("\n"));
  console.log(`[shove-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (S0 is the kick, kept; every shove case must be red there)`);
  process.exit(wrong.length ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
const F = await import(TREE + "shared/protocol/fold.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("shove");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `s${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, entries: () => W().entries };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 120)}`);
const launches = (s: any) => s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch").length;
// owner olive, builder bob, visitor vic; a world running eidosim; a crate (0.6 m) at the origin anyone may punt
function cast(s: any, phys: any = { kind: "dynamic", who: "visitor" }) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "visitor"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
  s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: process.env.PHYS_ENGINE ?? "eidosim@1.0.0" } });
  s.call("olive", "create", { id: "crate", model: "crate", components: { physics: phys }, place: { at: [0, 0] } });
}
// vic standing against the crate's -z face (0.3 m half-width + a 0.32 m body)
const AGAINST = [0, 0, -0.62];

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  { id: "S0", what: "(the kick, unchanged) a punt with no shove from the same spot is a kick", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", power: 3 });
      return { r: show(r), launches: launches(s) }; },
    good: (o) => o.r === "ok" && o.launches === 1 },
  { id: "S1", what: "a body against the crate shoves it away at a walk's speed: one punt, one launch, the act says shove", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const n0 = s.entries().length;
      const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], shove: true });
      const act = s.entries().slice(n0).find((e: any) => e.kind === "act" && e.verb === "punt");
      s.call("vic", "wait", {}, 6000); const at = s.w().state().entities.crate.c.transform.pos;
      return { r: show(r), v: r.v, launches: launches(s), shove: act?.body?.shove ?? act?.args?.shove ?? JSON.stringify(act?.body ?? null), at }; },
    good: (o) => o.r === "ok" && o.launches === 1 && JSON.stringify(o.v) === "[0,0.2,1.8]" && (o.shove === true || /"shove":true/.test(String(o.shove))) && o.at[2] > 0.05 },
  { id: "S2", what: "from a body out of range (1.2 m off its side: a kick's reach, not a shove's) it is refused out-of-reach", run(s) { cast(s);
      s.call("vic", "move", { to: [0, 0, -1.5] }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true });
      const k = s.call("vic", "punt", { id: "crate", power: 2 });
      return { r: code(r), launches: launches(s), kick: show(k) }; },
    good: (o) => o.r === "out-of-reach" && o.kick === "ok" && o.launches === 1 },
  { id: "S3", what: "too fast for a walk (8 m/s) is refused too-fast, not capped", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.5, 8], shove: true });
      return { r: code(r), launches: launches(s) }; },
    good: (o) => o.r === "too-fast" && o.launches === 0 },
  { id: "S4", what: "toward the body (pulled, not pushed) is refused wrong-way", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, -1.5], shove: true });
      return { r: code(r), launches: launches(s) }; },
    good: (o) => o.r === "wrong-way" && o.launches === 0 },
  { id: "S5", what: "what is under the feet (a dynamic rug) is refused underfoot", run(s) { cast(s);
      s.call("olive", "create", { id: "rug", model: "rug", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [3, 0] } });
      s.call("vic", "move", { to: [3, 0, 0.2] }); const r = s.call("vic", "punt", { id: "rug", v: [0, 0, 1.5], shove: true });
      return { r: code(r), launches: launches(s) }; },
    good: (o) => o.r === "underfoot" && o.launches === 0 },
  { id: "S6", what: "a thing already in flight is refused in-flight (a kick would volley it)", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); s.call("vic", "punt", { id: "crate", v: [0, 3, 0.5] }, 10);
      const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true }, 10);
      return { r: code(r), launches: launches(s) }; },
    good: (o) => o.r === "in-flight" && o.launches === 1 },
  { id: "S7", what: "physics.who builder: a visitor's shove is refused rights, a builder's goes", run(s) { cast(s, { kind: "dynamic", who: "builder" });
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true });
      s.call("vic", "move", { to: [4, 0, 4] }, 1000); s.call("bob", "move", { to: AGAINST }); const b = s.call("bob", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true });
      return { r: code(r), b: show(b) }; },
    good: (o) => o.r === "rights" && o.b === "ok" },
  { id: "S8", what: "a locked crate is refused locked", run(s) { cast(s);
      s.call("olive", "set", { id: "crate", component: "lock", value: true });
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true });
      return { r: code(r), launches: launches(s) }; },
    good: (o) => o.r === "locked" && o.launches === 0 },
  { id: "S9", what: "a shove's shape: power instead of v, or v pointing down, is refused shape", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST });
      const p = s.call("vic", "punt", { id: "crate", power: 2, shove: true }); const d = s.call("vic", "punt", { id: "crate", v: [0, -0.5, 1.5], shove: true });
      const up = s.call("vic", "punt", { id: "crate", v: [0, 1.5, 1.5], shove: true });
      return { p: code(p), d: code(d), up: code(up), launches: launches(s) }; },
    good: (o) => o.p === "shape" && o.d === "shape" && o.up === "shape" && o.launches === 0 },
  { id: "S10", what: "a long crate is shoved from its end though its origin is past a kick's reach (measured to the box)", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, transform: { pos: [6, 0, 0], scale: [5, 1, 1] } } });
      s.call("vic", "move", { to: [7.85, 0, 0] });
      const k = s.call("vic", "punt", { id: "big", power: 2 }); const r = s.call("vic", "punt", { id: "big", v: [-1.5, 0.2, 0], shove: true });
      return { kick: code(k), r: show(r) }; },
    good: (o) => o.kick === "out-of-reach" && o.r === "ok" },
  { id: "S11", what: "something in a hand is refused held", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [3, 3] } });
      s.call("bob", "move", { to: [3, 0, 2.6] }); s.call("bob", "grab", { id: "ball" });
      s.call("vic", "move", { to: [3.2, 0, 2.6] }); const r = s.call("vic", "punt", { id: "ball", v: [0, 0.1, 1], shove: true });
      return { r: code(r) }; },
    good: (o) => o.r === "held" },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 300) }; }
  let good = false; try { good = !o.threw && c.good(o); } catch { good = false; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id} ${c.what}${good ? "" : `\n      ${JSON.stringify(o)}`}`);
}
console.log(`[shove-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
