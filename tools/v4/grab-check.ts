// tools/v4/grab-check.ts — the `grabbable` component (research RESEARCH-grab-2026-10-06; shared/grab.js) through the
// real door: what a hand may pick up, how it holds it, where it goes when let go, and what using it while held does.
//   bun tools/v4/grab-check.ts                 every case
//   bun tools/v4/grab-check.ts --only G2,G4    just those
//   bun tools/v4/grab-check.ts --tree <dir>    run the cases against another checkout's shared/ (a mutant, a base)
//   bun tools/v4/grab-check.ts --control       the base commit (7a3d8435, before grabbable): every NEW case must be red
//                                              there and every MIGRATION case green (today's behaviour, kept)
//   bun tools/v4/grab-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red; a
//                                              no-op control mutation must stay green. The migration mutant (no physics
//                                              fallback) also runs phys-check and physlive-check in the copy: they must
//                                              go red, which proves they test what the fallback keeps.
// Cases:
//   G   the gate (slice 1): grabOf with the migration fallback; enabled, who, steal, range; a throw with no sim is a drop
//   M   migration: what a dynamic thing with no grabbable did before, unchanged
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/v4/durable.ts";
import { custodyAt, modLogAt } from "../../server/v4/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "7a3d8435";

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// [name, file (under shared/), find, replace, cases that must turn red]. Applied as an exact text replacement; a mutation
// whose text isn't found exactly once is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the physics fallback (migration)", "grab.js", "if (v === undefined && isObj(c.physics) && c.physics.kind === 'dynamic') return", "if (false) return", ["M1", "M2", "M3"]],
  ["grab reads grabOf (a static grabbable is carried)", "v4/door.js", "const g = grabOf(e.c);\n    if (!g) refuse(\"not-grabbable\"", "const g = e.c.physics?.kind === \"dynamic\" ? grabOf(e.c) : null;\n    if (!g) refuse(\"not-grabbable\"", ["G2", "G3"]],
  ["the hand's settlement reads grabOf", "v4/door.js", "else if (cap.kind === \"handle\") { const g = grabOf(st.entities[op.id]?.c);", "else if (cap.kind === \"handle\") { const g = st.entities[op.id]?.c.physics?.kind === \"dynamic\" ? grabOf(st.entities[op.id]?.c) : null;", ["G2", "G3"]],
  ["enabled", "v4/door.js", "if (!g.enabled) refuse(\"not-grabbable\"", "if (false) refuse(\"not-grabbable\"", ["G5"]],
  ["who", "v4/door.js", "const need = g.who; const role = roleOf(st, actor); if (RANK[role] < RANK[need])", "const need = g.who; const role = roleOf(st, actor); if (false)", ["G6", "M2"]],
  ["punt keeps physics.who (a kick-only ball is still punted)", "v4/door.js", "if (cap.kind === \"handle\" && cap.via === \"punt\") {", "if (false) {", ["G5"]],
  ["steal", "v4/door.js", "if (held && !g.steal && RANK[role] < RANK.owner)", "if (false)", ["G7"]],
  ["steal: owners may", "v4/door.js", "if (held && !g.steal && RANK[role] < RANK.owner)", "if (held && !g.steal)", ["G7"]],
  ["range", "v4/door.js", "if (d > g.range) refuse(\"out-of-reach\"", "if (d > REACH) refuse(\"out-of-reach\"", ["G8"]],
  ["a throw with no sim is a drop", "v4/door.js", "if (!fliesIn(w.state(), a.id)) {\n      if (!Array.isArray(a.v)", "if (false) {\n      if (!Array.isArray(a.v)", ["G4"]],
  ["only a dynamic thing in a sim world flies", "v4/door.js", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c.sim && st.entities[id]?.c.physics?.kind === \"dynamic\";", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c.sim;", ["G3"]],
  ["the shape check", "v4/door.js", "if (name === \"grabbable\") { const bad = checkGrabbable(v, at);", "if (false) { const bad = checkGrabbable(v, at);", ["G9"]],
  ["CONTROL (no-op: must stay green)", "grab.js", "// ---------------------------------------------------------------- reading", "// ----------------------------------------------------------------  reading", []],
];
async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/v4/grab-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// the mutant tree: shared/, server/, tools/ and defs/ (so the other suites run in it too), node_modules linked
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = copyTree("gmut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    let good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    let others = "";
    if (cases.includes("M1")) { // the migration proof: the suites that test physics today go red without the fallback
      const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
      const reds = ["phys-check.ts", "physlive-check.ts"].map((s) => { const x = Bun.spawnSync(["bun", path.join(d, "tools/v4", s)], { cwd: d, env });
        const out = x.stdout.toString() + x.stderr.toString(); return { s, code: x.exitCode, fails: (out.match(/^\s*FAIL\b/gm) ?? []).length }; });
      others = ` · ${reds.map((x) => `${x.s}: exit ${x.code}, ${x.fails} FAIL`).join(", ")}`;
      if (reds.some((x) => x.code === 0 || x.fails === 0)) good = false;
    }
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}${others}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[grab-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  // the base commit's shared/ (the door before grabbable): every NEW case must be red there, every M case green
  const d = scratch("gctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  const r = await runSelf(d, null, ["--expect-absent"]);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const wrong = lines.filter((l) => { const id = l.slice(5).trim().split(/\s/)[0]; const mig = id.startsWith("M"); return mig ? l.startsWith("FAIL") : l.startsWith("ok "); });
  console.log(lines.map((l) => { const id = l.slice(5).trim().split(/\s/)[0]; const mig = id.startsWith("M");
    return `${(mig ? l.startsWith("ok ") : l.startsWith("FAIL")) ? (mig ? "kept at base:  " : "red at base:   ") : "WRONG AT BASE: "}${l.slice(0, 130)}`; }).join("\n"));
  console.log(`[grab-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (new cases must be red there, migration cases green)`);
  process.exit(wrong.length ? 1 : 0);
}

// ---------------- the door, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/v4/door.js");
const F = await import(TREE + "shared/v4/fold.js");
const SL = await import(TREE + "shared/v4/simlayer.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("grab");

function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.V4_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: o.scripts ?? null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session(o: any = {}) {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name, o));
  const call = (actor: string, tool: string, args: any = {}, step = 100) => { T += step; process.env.V4_NOW = String(T);
    try { return D.request(W(), actor, tool, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  // walk the door's track there: steps of at most 3.5 m, a second apart (a first move is an arrival)
  const walk = (actor: string, to: number[]) => { for (let i = 0; i < 40; i++) { const at = W().presence.bodies[actor]?.at; if (!at) return call(actor, "move", { to });
    const d = Math.hypot(to[0] - at[0], to[2] - at[2]); if (d < 1e-9) return { ok: true }; const k = Math.min(1, 3.5 / d);
    const r = call(actor, "move", { to: [at[0] + (to[0] - at[0]) * k, to[1], at[2] + (to[2] - at[2]) * k] }, 1000); if (!r.ok) return r; } };
  return { name, call, walk, w: W, advance: (ms: number) => { T += ms; process.env.V4_NOW = String(T); }, entries: () => W().entries };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 120)}`);
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
const tf = (s: any, id: string) => s.w().state().entities[id]?.c.transform;
const held = (s: any, id: string) => s.w().presence.holds[id] ?? null;
const ENG = { engine: "eidosim@0.5.0" };
// owner olive (the founder), builder bob, visitors vic and ann
function cast(s: any, sim = false) {
  s.call("olive", "new", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "visitor"], ["ann", "visitor"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
  if (sim) s.call("olive", "set", { id: "@world", component: "sim", value: ENG });
}
const tail = (s: any, n: number) => s.entries().slice(-n).map((e: any) => `${e.kind}:${e.verb}`);
const since = (s: any, n0: number) => s.entries().slice(n0).map((e: any) => `${e.kind}:${e.verb}`);
const carrier = (s: any) => { const v = SL.simFold(s.entries(), T + 1e9); /* the door here folds with the lab catalogue (worldOf: no simModels), so the carrier does too */ return { agree: v.checks.agree, disagree: v.checks.disagree.length }; };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- M: migration (green at base AND now) ----------------
  { id: "M1", what: "a dynamic thing with no grabbable is picked up by physics.who, carried, put down and thrown, as before", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const g = s.call("vic", "grab", { id: "ball" }), p = s.call("vic", "put", { id: "ball" });
      const g2 = s.call("vic", "grab", { id: "ball" }), t = s.call("vic", "throw", { id: "ball", v: [0, 2, 2] });
      s.call("vic", "wait", {}, 8000);
      return { g: show(g), inHand: g.inHandAt, p: show(p), g2: show(g2), t: show(t), flying: t.flying, carrier: carrier(s) }; },
    good: (o) => o.g === "ok" && o.inHand?.[1] === 1.1 && o.p === "ok" && o.g2 === "ok" && o.t === "ok" && o.flying === "ball" && o.carrier.agree >= 1 && !o.carrier.disagree },
  { id: "M2", what: "…and a dynamic crate with no physics.who is a builder's: a visitor is refused, a builder may", run(s) { cast(s);
      s.call("olive", "create", { id: "crate", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.6] }); s.call("bob", "move", { to: [0.4, 0, 0.6] });
      return { vic: code(s.call("vic", "grab", { id: "crate" })), bob: show(s.call("bob", "grab", { id: "crate" })) }; },
    good: (o) => o.vic === "rights" && o.bob === "ok" },
  { id: "M3", what: "…and the latest grab wins (taken from a holder, who is told)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [0.4, 0, 0.5] });
      s.call("vic", "grab", { id: "ball" }); const a = s.call("ann", "grab", { id: "ball" });
      return { a: show(a), by: held(s, "ball")?.by, taken: a.notes?.some((n: any) => n.takenFrom === "vic") }; },
    good: (o) => o.a === "ok" && o.by === "ann" && o.taken },

  // ---------------- G: the gate ----------------
  { id: "G1", what: "grabbable is a component the door knows: its own entry in schema, its shape checked", run(s) { cast(s);
      const sch = s.call("olive", "schema", { component: "grabbable" }).components?.grabbable;
      return { help: sch?.help ?? null, on: sch?.on }; },
    good: (o) => /carryable/.test(o.help ?? "") && o.on === "thing" },
  { id: "G2", what: "a thing with grabbable and no physics (a lantern) is picked up, carried and put down in a world with no physics", run(s) { cast(s);
      s.call("olive", "create", { id: "lantern", model: "table-lamp", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const g = s.call("vic", "grab", { id: "lantern" }); const w1 = s.call("vic", "move", { to: [0, 0, 2.5] }, 1000);
      const p = s.call("vic", "put", { id: "lantern" });
      return { g: show(g), carrying: w1.carrying, p: show(p), at: tf(s, "lantern")?.pos, held: held(s, "lantern") }; },
    good: (o) => o.g === "ok" && o.carrying?.includes("lantern") && o.p === "ok" && Math.abs(o.at[2] - 2.5) < 1e-6 && o.at[1] === 0 && o.held === null },
  { id: "G3", what: "…and in a world that runs physics: the grab lifts it out of the engine, a drop sets it down (it isn't dynamic, so it doesn't fly), a carrier agrees", run(s) { cast(s, true);
      s.call("olive", "create", { id: "lantern", model: "table-lamp", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const n0 = s.entries().length;
      const g = s.call("vic", "grab", { id: "lantern" }); const lift = since(s, n0);
      s.call("vic", "move", { to: [0, 0, 2] }, 1000); const n1 = s.entries().length;
      const d = s.call("vic", "drop", { id: "lantern" }); const after = since(s, n1);
      return { g: show(g), lift, d: show(d), after, at: tf(s, "lantern")?.pos, launches: s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch").length, carrier: carrier(s) }; },
    good: (o) => o.g === "ok" && o.lift.includes("sim:lift") && o.d === "ok" && JSON.stringify(o.after) === '["act:put","state:set"]' && o.at[1] === 0 && o.launches === 0 && !o.carrier.disagree },
  { id: "G4", what: "a throw in a world with no physics is a drop that says so (a VR hand lets go with its velocity; it was refused and stuck in the hand)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" });
      const t = s.call("vic", "throw", { id: "ball", v: [0, 1.5, 3], pos: [0, 1.1, 0.7] });
      return { t: show(t), note: t.notes?.find((n: any) => n.thrown)?.why ?? null, held: held(s, "ball"), at: tf(s, "ball")?.pos }; },
    good: (o) => o.t === "ok" && /doesn't run physics/.test(o.note ?? "") && o.held === null && o.at?.[1] === 0 && Math.abs(o.at[2] - 0.7) < 1e-6 },
  { id: "G5", what: "nothing to grab: a plain thing is refused not-grabbable; grabbable {enabled: false} makes a dynamic ball kick-only (punt still works)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "rock", model: "crate", place: { at: [3, 3] } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" }, grabbable: { enabled: false } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, -0.5] }); s.call("olive", "move", { to: [3, 0, 2.5] }); const plain = s.call("olive", "grab", { id: "rock" });
      return { plain: code(plain), g: show(s.call("vic", "grab", { id: "ball" })), p: show(s.call("vic", "punt", { id: "ball", power: 3 })) }; },
    good: (o) => o.plain === "not-grabbable" && o.g.startsWith("refused not-grabbable") && o.p === "ok" },
  { id: "G6", what: "who: grabbable.who wins over physics.who for the hand; a punt still asks physics.who", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: {} }, place: { at: [0.5, 0] } });
      s.call("vic", "move", { to: [0, 0, -0.5] });
      const punt = s.call("vic", "punt", { id: "ball", power: 3 }); const g = s.call("vic", "grab", { id: "ball" }); s.call("vic", "put", { id: "ball" });
      const k = s.call("vic", "grab", { id: "key" });
      return { punt: code(punt), g: show(g), key: code(k) }; },
    good: (o) => o.punt === "rights" && o.g === "ok" && o.key === "rights" },
  { id: "G7", what: "steal: false: nobody takes it from a holder's hand (refused 'held'); an owner may", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "visitor", steal: false } }, place: { at: [0, 0] } });
      for (const [p, x] of [["vic", 0], ["ann", 0.4], ["olive", -0.4]]) s.call(p, "move", { to: [x, 0, 0.5] });
      s.call("vic", "grab", { id: "flag" }); const a = s.call("ann", "grab", { id: "flag" }); const o = s.call("olive", "grab", { id: "flag" });
      return { ann: code(a), olive: show(o), by: held(s, "flag")?.by }; },
    good: (o) => o.ann === "held" && o.olive === "ok" && o.by === "olive" },
  { id: "G8", what: "range: 0.4 m means close; 4 m reaches past an arm (granted as a pull, said so)", run(s) { cast(s);
      s.call("olive", "create", { id: "near", model: "book", components: { grabbable: { who: "visitor", range: 0.4 } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "far", model: "book", components: { grabbable: { who: "visitor", range: 4 } }, place: { at: [0, 3.2] } });
      s.call("vic", "move", { to: [0, 0, 0.8] });
      const n = s.call("vic", "grab", { id: "near" }); const f = s.call("vic", "grab", { id: "far" });
      return { near: code(n), far: show(f), pulled: f.notes?.some((x: any) => x.pulled) }; },
    good: (o) => o.near === "out-of-reach" && o.far === "ok" && o.pulled },
  { id: "G9", what: "its shape is checked: an unknown key is refused with a did-you-mean; a grip without pos, a bad enum and an out-of-range throw too", run(s) { cast(s);
      s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      const set = (v: any) => s.call("olive", "set", { id: "cup", component: "grabbable", value: v });
      const typo = set({ realease: "stay" }); const grip = set({ grips: { handle: { q: [0, 0, 0, 1] } } }); const en = set({ release: "fly" }); const th = set({ throw: 9 });
      const good = set({ who: "visitor", grips: { handle: { pos: [0, 0.1, 0], hand: "right", fingers: "pinch" } }, fits: ["cup"], use: { down: "sip" } });
      return { typo: code(typo), dym: typo.refused?.didYouMean, grip: code(grip), en: code(en), th: code(th), good: show(good) }; },
    good: (o) => o.typo === "schema" && o.dym?.[0] === "release" && o.grip === "shape" && o.en === "shape" && o.th === "bounds" && o.good === "ok" },
];

// ---------------- run ----------------
let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false;
  try { o = c.run(session()); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 700)}`}`);
}
console.log(`[grab-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
