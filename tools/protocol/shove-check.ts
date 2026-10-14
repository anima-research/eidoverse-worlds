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
  ["the shove's own gate", "protocol/authority.js", "if (a.shove !== undefined) shoveGate(w, st, me, a, flying, actor);\n    else if", "if (false) shoveGate(w, st, me, a, flying, actor);\n    else if", ["S2", "S3", "S4", "S5", "S6", "S9", "S10", "S15", "S17", "S19"]],
  ["reach to the footprint", "protocol/authority.js", "if (R.d > SHOVE.reach) refuse(\"out-of-reach\"", "if (false) refuse(\"out-of-reach\"", ["S2"]],
  ["the speed cap", "protocol/authority.js", "if (vh > cap + 1e-3 || Math.hypot(vx, vy, vz) > SHOVE.maxV * (1 + SHOVE.lift) + 1e-3) refuse(\"too-fast\"", "if (false) refuse(\"too-fast\"", ["S3"]],
  ["away from the feet", "protocol/authority.js", "if (!dir || vx * dir[0] + vz * dir[1] < 0.5 * vh) refuse(\"wrong-way\"", "if (false) refuse(\"wrong-way\"", ["S4"]],
  ["not underfoot", "protocol/authority.js", "if (b.max[1] <= f[1] + SHOVE.underfoot) refuse(\"underfoot\"", "if (false) refuse(\"underfoot\"", ["S5"]],
  ["not in flight", "protocol/authority.js", "if (flying) refuse(\"in-flight\"", "if (false) refuse(\"in-flight\"", ["S6"]],
  ["along the ground", "protocol/authority.js", "if (vh < 1e-6 || vy < 0 || vy > SHOVE.lift * vh + 1e-9) refuse(\"shape\"", "if (false) refuse(\"shape\"", ["S9"]],
  ["a shove carries v", "protocol/authority.js", "refuse(\"shape\", \"a shove carries v", "(\"shape\", \"a shove carries v", ["S9"]],
  ["occupied: a seat", "protocol/authority.js", "if (who !== actor && s && fam.has(s.to)) return { who, how: \"sits on\" };", "if (false) return { who, how: \"sits on\" };", ["S12", "S21"]],
  ["occupied: the seat is kept", "protocol/authority.js", "if (probe.attach?.to) setSeat(w, actor, probe.attach.to);", "", ["S12", "S21", "S22"]],
  ["occupied: a seat is left by walking off", "protocol/authority.js", "if (Math.hypot(to[0] - p[0], to[2] - p[2]) > 1) clearSeat(w, actor);", "", ["S12", "S21"]],
  ["occupied: one body per socket", "protocol/authority.js", "{ const t = taken(pick); if (t) refuse(\"occupied\"", "{ const t = null; if (t) refuse(\"occupied\"", ["S22"]],
  ["occupied: the free socket is picked", "protocol/authority.js", "ok.find((x) => !taken(x)) ?? ok[0]", "ok[0]", ["S22"]],
  ["occupied: snap passes over a sat-in socket", "protocol/authority.js", "if (sat?.who) { out.notes.push(", "if (false) { out.notes.push(", ["S23"]],
  ["occupied: a thing in a socket", "protocol/authority.js", "const thing = Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === sock); return thing ? { thing } : null; }", "return null; }", ["S24"]],
  ["occupied: a switched-off socket is no seat", "protocol/authority.js", "isSocketC(st.entities[s.to]?.c) && !offChain(st, s.to) ? s : null; }", "isSocketC(st.entities[s.to]?.c) ? s : null; }", ["S22"]],
  ["occupied: standing on it", "protocol/authority.js", "boxes.some((x) => feetOn(x, b.at))) return { who, how: \"is standing on\" };", "false) return { who, how: \"is standing on\" };", ["S13"]],
  ["occupied: the kick asks too", "protocol/authority.js", "    occupiedRefuse(w, st, a.id, actor, \"punted\");\n", "", ["S12", "S13"]],
  ["occupied: the grab asks too", "protocol/authority.js", "    occupiedRefuse(w, st, a.id, actor, \"picked up\");\n", "", ["S12"]],
  ["in-the-way", "protocol/authority.js", "&& sweptCovers(b, a.v, bd.at))", "&& false)", ["S15"]],
  ["reach to the oriented box", "protocol/authority.js", "const ob = obbs(st, a.id);", "const ob = [];", ["S16"]],
  ["by mass", "protocol/authority.js", "if (vh > cap + 1e-3 ||", "if (vh > SHOVE.maxV + 1e-3 ||", ["S17"]],
  ["refused shoves unrecorded", "protocol/authority.js", "if (verb === \"punt\" && args?.shove === true) {", "if (false) {", ["S18"]],
  ["not through a wall", "protocol/authority.js", "if (hit) refuse(\"out-of-reach\", `${hit} is between you", "if (false) refuse(\"out-of-reach\", `${hit} is between you", ["S19"]],
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
      const k = s.call("vic", "punt", { id: "big", power: 2 }); const r = s.call("vic", "punt", { id: "big", v: [-0.4, 0.1, 0], shove: true });
      return { kick: code(k), r: show(r) }; },
    good: (o) => o.kick === "out-of-reach" && o.r === "ok" },
  { id: "S11", what: "something in a hand is refused held", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [3, 3] } });
      s.call("bob", "move", { to: [3, 0, 2.6] }); s.call("bob", "grab", { id: "ball" });
      s.call("vic", "move", { to: [3.2, 0, 2.6] }); const r = s.call("vic", "punt", { id: "ball", v: [0, 0.1, 1], shove: true });
      return { r: code(r) }; },
    good: (o) => o.r === "held" },
  { id: "S12", what: "bob sits on a chair (use sit): vic's shove, kick and grab are refused occupied, and so is a shove of the cart under it; once bob walks off the stool, vic's shove of the cart goes", run(s) { cast(s);
      const seat = { physics: { kind: "dynamic", who: "visitor" }, grabbable: {}, sockets: { seat: { pos: [0, 0.45, 0], body: { action: "sit" } } } };
      s.call("olive", "create", { id: "chair", model: "chair", components: seat, place: { at: [4, 0] } });
      s.call("olive", "create", { id: "cart", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [8, 0] } });
      s.call("olive", "create", { id: "stool", model: "chair", components: seat, place: { on: "cart" } });
      s.call("bob", "move", { to: [4, 0, -0.6] }); const sit = s.call("bob", "use", { id: "chair", action: "sit" });
      s.call("vic", "move", { to: [4, 0, -0.62] });
      const sh = s.call("vic", "punt", { id: "chair", v: [0, 0.2, 1.5], shove: true }), kick = s.call("vic", "punt", { id: "chair", power: 3 }), grab = s.call("vic", "grab", { id: "chair" });
      s.call("bob", "move", { to: [8, 0, -0.6] }, 1000); const sit2 = s.call("bob", "use", { id: "stool", action: "sit" });
      s.call("vic", "move", { to: [8, 0, -0.62], teleport: true }, 4000); const cart = s.call("vic", "punt", { id: "cart", v: [0, 0.1, 0.8], shove: true });
      s.call("bob", "move", { to: [8, 0, -3] }, 1000); const after = s.call("vic", "punt", { id: "cart", v: [0, 0.1, 0.8], shove: true });
      return { sit: !!sit.ok, sit2: !!sit2.ok, sh: code(sh), kick: code(kick), grab: code(grab), cart: code(cart), after: show(after), launches: launches(s) }; },
    good: (o) => o.sit && o.sit2 && o.sh === "occupied" && o.kick === "occupied" && o.grab === "occupied" && o.cart === "occupied" && o.after === "ok" && o.launches === 1 },
  { id: "S13", what: "bob stands on a dynamic deck: vic's shove and kick are refused occupied; once bob steps off, vic's shove goes", run(s) { cast(s);
      s.call("olive", "create", { id: "deck", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, transform: { pos: [8, 0, 0], scale: [3, 0.5, 3] } } });
      s.call("bob", "move", { to: [8, 0.3, 0], teleport: true }); s.call("vic", "move", { to: [8, 0, -1.22] });
      const sh = s.call("vic", "punt", { id: "deck", v: [0, 0.1, 0.5], shove: true }), kick = s.call("vic", "punt", { id: "deck", power: 2 });
      s.call("bob", "move", { to: [8, 0, 3], teleport: true }, 4000); const after = s.call("vic", "punt", { id: "deck", v: [0, 0.1, 0.5], shove: true });
      return { sh: code(sh), kick: code(kick), after: show(after) }; },
    good: (o) => o.sh === "occupied" && o.kick === "occupied" && o.after === "ok" },
  { id: "S14", what: "a body is never a thing: punt {id: <a present identity, its name, body:…>} (shove or kick) is not-found, and the log gains no launch", run(s) { cast(s);
      s.call("bob", "move", { to: [0, 0, 0.62] }); s.call("vic", "move", { to: [0, 0, -0.62] });
      const out = []; for (const id of ["bob", "u-bob", "@bob", "body:bob"]) out.push(code(s.call("vic", "punt", { id, v: [0, 0.2, 1.8], shove: true })), code(s.call("vic", "punt", { id, power: 3 })));
      return { out, launches: launches(s) }; },
    good: (o) => o.out.every((c: string) => c === "not-found") && o.launches === 0 },
  { id: "S15", what: "bob stands 1.2 m beyond the crate: vic's shove toward him is refused in-the-way; the same shove sideways goes", run(s) { cast(s);
      s.call("bob", "move", { to: [0, 0, 1.2] }); s.call("vic", "move", { to: AGAINST });
      const at = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], shove: true });
      s.call("vic", "move", { to: [-0.62, 0, 0], teleport: true }, 4000); const side = s.call("vic", "punt", { id: "crate", v: [1.8, 0.2, 0], shove: true });
      return { at: code(at), side: show(side) }; },
    good: (o) => o.at === "in-the-way" && o.side === "ok" },
  { id: "S16", what: "a plank turned 45°: from its axis-aligned box's empty corner the shove is out-of-reach; against its long face it goes", run(s) { cast(s);
      const h = Math.SQRT1_2; s.call("olive", "create", { id: "plank", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, transform: { pos: [10, 0, 0], q: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], scale: [8, 1, 0.5] } } });
      s.call("vic", "move", { to: [12.05, 0, 2.05] }); const corner = s.call("vic", "punt", { id: "plank", v: [-0.28, 0.05, -0.28], shove: true });
      s.call("vic", "move", { to: [10 + 0.45 * h, 0, 0.45 * h], teleport: true }, 4000); const face = s.call("vic", "punt", { id: "plank", v: [-0.4 * h, 0.05, -0.4 * h], shove: true });
      return { corner: code(corner), face: show(face) }; },
    good: (o) => o.corner === "out-of-reach" && o.face === "ok" },
  { id: "S17", what: "by mass (BODY_MASS 70 kg, elastic): a ball (11 kg) takes 3 m/s, the 216 kg crate is refused at 2.5 m/s and takes 1.9, physics.mass 1000 kg is refused at 1 m/s", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [3, 0] } });
      s.call("olive", "create", { id: "anvil", model: "crate", components: { physics: { kind: "dynamic", who: "visitor", mass: 1000 } }, place: { at: [6, 0] } });
      s.call("vic", "move", { to: AGAINST }); const c25 = s.call("vic", "punt", { id: "crate", v: [0, 0.3, 2.5], shove: true }), c19 = s.call("vic", "punt", { id: "crate", v: [0, 0.3, 1.9], shove: true });
      s.call("vic", "move", { to: [3, 0, -0.44], teleport: true }, 4000); const b3 = s.call("vic", "punt", { id: "ball", v: [0, 0.3, 3], shove: true });
      s.call("vic", "move", { to: [6, 0, -0.62], teleport: true }, 4000); const a1 = s.call("vic", "punt", { id: "anvil", v: [0, 0.1, 1], shove: true });
      return { c25: code(c25), c19: show(c19), b3: show(b3), a1: code(a1) }; },
    good: (o) => o.c25 === "too-fast" && o.c19 === "ok" && o.b3 === "ok" && o.a1 === "too-fast" },
  { id: "S18", what: "a refused shove is never written to the log; the next refusal that is written (a kick) counts it as unrecorded", run(s) { cast(s, { kind: "dynamic", who: "builder" });
      s.call("vic", "move", { to: AGAINST }); const n0 = s.entries().length;
      for (let i = 0; i < 5; i++) s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.5], shove: true }, 500);
      const n1 = s.entries().length; s.call("vic", "punt", { id: "crate", power: 2 }); const n2 = s.entries().length;
      return { shoves: n1 - n0, kick: n2 - n1, unrecorded: s.entries().at(-1)?.body?.unrecorded ?? null }; },
    good: (o) => o.shoves === 0 && o.kick === 1 && o.unrecorded === 5 },
  { id: "S19", what: "not through a wall: a wide crate behind a wall is out of a shove's reach though its near face is within it", run(s) { cast(s);
      s.call("olive", "create", { id: "wall", model: "crate", components: { lock: true, transform: { pos: [5, 0, 0], scale: [0.5, 4, 8] } } });
      s.call("olive", "create", { id: "big", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, transform: { pos: [6.65, 0, 0], scale: [5, 1, 5] } } });
      s.call("vic", "move", { to: [4.4, 0, 0] }); const r = s.call("vic", "punt", { id: "big", v: [0.08, 0.01, 0], shove: true });
      return { r: code(r), reason: r?.refused?.reason }; },
    good: (o) => o.r === "out-of-reach" && /wall/.test(o.reason ?? "") },
  { id: "S20", what: "a socket is part of its host, never a thing: a shove or kick of a chair's seat socket is not-a-thing, naming its host, and the log gains no launch", run(s) { cast(s);
      s.call("olive", "create", { id: "chair", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [4, 0] } });
      s.call("olive", "create", { id: "chair-seat", components: { parent: { to: "chair" }, transform: { pos: [0, 0.45, 0] }, socket: { name: "seat", body: { action: "sit" } } } });
      s.call("vic", "move", { to: [4, 0, -0.6] });
      const sh = s.call("vic", "punt", { id: "chair-seat", v: [0, 0.2, 1.5], shove: true }), kick = s.call("vic", "punt", { id: "chair-seat", power: 3 });
      return { sh: code(sh), kick: code(kick), why: sh?.refused?.reason, launches: launches(s) }; },
    good: (o) => o.sh === "not-a-thing" && o.kick === "not-a-thing" && /chair/.test(o.why ?? "") && o.launches === 0 },
  { id: "S21", what: "S12 on socket children: bob sits on the chair's seat child, and the authority records his seat as {to: <the socket>}; vic's shove, kick and grab of the chair are refused occupied; once bob walks off, the shove goes", run(s) { cast(s);
      s.call("olive", "create", { id: "chair", model: "crate", components: { physics: { kind: "dynamic", who: "visitor" }, grabbable: {} }, place: { at: [4, 0] } });
      s.call("olive", "create", { id: "chair-seat", components: { parent: { to: "chair" }, transform: { pos: [0, 0.45, 0] }, socket: { name: "seat", body: { action: "sit" } } } });
      s.call("bob", "move", { to: [4, 0, -0.6] }); const sit = s.call("bob", "use", { id: "chair", action: "sit" }); const rec = JSON.stringify(s.w().presence.seats?.bob ?? null);
      s.call("vic", "move", { to: [4, 0, -0.62] });
      const sh = s.call("vic", "punt", { id: "chair", v: [0, 0.2, 1.5], shove: true }), kick = s.call("vic", "punt", { id: "chair", power: 3 }), grab = s.call("vic", "grab", { id: "chair" });
      s.call("bob", "move", { to: [4, 0, -4] }, 1000); const after = s.call("vic", "punt", { id: "chair", v: [0, 0.2, 1.5], shove: true });
      return { sit: sit.attach?.to, rec, sh: code(sh), kick: code(kick), grab: code(grab), after: show(after) }; },
    good: (o) => o.sit === "chair-seat" && o.rec === '{"to":"chair-seat"}' && o.sh === "occupied" && o.kick === "occupied" && o.grab === "occupied" && o.after === "ok" },
  { id: "S22", what: "one body per socket: with bob in the sofa's left seat, vic's use takes the free right seat, ann's is refused occupied naming who sits there; a switched-off seat is no seat (bob's is let go)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:ann", value: { role: "visitor" } });
      s.call("olive", "create", { id: "sofa", model: "crate", place: { at: [6, 0] } });
      s.call("olive", "create", { id: "sofa-l", components: { parent: { to: "sofa" }, transform: { pos: [-0.4, 0.5, 0] }, socket: { name: "left", body: { action: "sit" } } } });
      s.call("olive", "create", { id: "sofa-r", components: { parent: { to: "sofa" }, transform: { pos: [0.4, 0.5, 0] }, socket: { name: "right", body: { action: "sit" } } } });
      for (const [who, z] of [["bob", -0.7], ["vic", -0.9], ["ann", -1.1]]) s.call(who as string, "move", { to: [6, 0, z as number] });
      const b = s.call("bob", "use", { id: "sofa", action: "sit" }), v = s.call("vic", "use", { id: "sofa", action: "sit" }), a = s.call("ann", "use", { id: "sofa", action: "sit" }), an = s.call("ann", "use", { id: "sofa", action: "sit", args: { socket: "left" } });
      s.call("olive", "set", { id: "sofa-l", component: "disabled", value: true }); s.call("olive", "delete", { id: "sofa-l", component: "disabled" });
      const again = s.call("ann", "use", { id: "sofa", action: "sit", args: { socket: "left" } });
      return { b: b.attach?.to, v: v.attach?.to, a: [code(a), a.refused?.by ?? a.refused?.reason], an: [code(an), an.refused?.by], again: again.attach?.to ?? code(again) }; },
    good: (o) => o.b === "sofa-l" && o.v === "sofa-r" && o.a[0] === "occupied" && o.an[0] === "occupied" && o.an[1] === "bob" && o.again === "sofa-l" },
  { id: "S23", what: "snap passes over a socket someone sits in: a key let go by a hook bob sits on is set down, and the reply says who sits there", run(s) { cast(s);
      s.call("olive", "create", { id: "post", model: "crate", place: { at: [0, 4] } });
      s.call("olive", "create", { id: "post-hook", components: { parent: { to: "post" }, transform: { pos: [0, 0.8, 0] }, socket: { name: "hook", accepts: ["key"], radius: 0.3, body: { action: "sit" } } } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 4] } });
      s.call("bob", "move", { to: [0, 0, 3.3] }); const sit = s.call("bob", "use", { id: "post" });
      s.call("vic", "move", { to: [0.8, 0, 4.6] }); s.call("vic", "grab", { id: "key" }); const d = s.call("vic", "drop", { id: "key", pos: [0.05, 0.8, 4.05] });
      return { sit: sit.attach?.to, d: show(d), parent: s.w().state().entities.key.c.parent ?? null, why: d.notes?.find((n: any) => n.passedOver)?.why }; },
    good: (o) => o.sit === "post-hook" && o.d === "ok" && o.parent === null && /bob/.test(o.why ?? "") },
  { id: "S24", what: "a thing in a socket occupies it: with a key snapped onto the hook, bob's use of that seat is refused occupied, naming the key", run(s) { cast(s);
      s.call("olive", "create", { id: "post", model: "crate", place: { at: [0, 4] } });
      s.call("olive", "create", { id: "post-hook", components: { parent: { to: "post" }, transform: { pos: [0, 0.8, 0] }, socket: { name: "hook", accepts: ["key"], radius: 0.3, body: { action: "sit" } } } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 4] } });
      s.call("vic", "move", { to: [0.8, 0, 4.6] }); s.call("vic", "grab", { id: "key" }); const d = s.call("vic", "drop", { id: "key", pos: [0.05, 0.8, 4.05] });
      s.call("bob", "move", { to: [0, 0, 3.3] }); const sit = s.call("bob", "use", { id: "post" });
      return { snapped: d.settled?.in, sit: code(sit), thing: sit.refused?.thing }; },
    good: (o) => o.snapped === "post-hook" && o.sit === "occupied" && o.thing === "key" },
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
