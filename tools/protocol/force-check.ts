// tools/protocol/force-check.ts — a blast at the authority (R 10-28, item 4: /boom restored): force {at, radius, power} shoves
// each body in radius through its own consent (bodyGate) and punts each loose thing outward through the punt's gates.
//   bun tools/protocol/force-check.ts                 every case
//   bun tools/protocol/force-check.ts --only F1,F3    just those
//   bun tools/protocol/force-check.ts --tree <dir>    against another checkout's shared/ (a mutant, a base)
//   bun tools/protocol/force-check.ts --control       the base commit (b89e1d518, force removed): every case must be red there
//   bun tools/protocol/force-check.ts --mutants       remove each rule in turn (a copy of the tree): its cases must go red
// The rim is held twice (falloff's null past it, and the breeze floor BLAST.min under a negative mag), so no one mutant reaches it.
// @ts-nocheck
import "./fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree, archiveTo, linkInto } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "b89e1d518";

const MUTANTS: [string, string, string, string, string[]][] = [
  ["builders and up", "protocol/authority/bodyverbs.js", "if (!admits(st, actor, \"builder\")) refuse(\"rights\", `only ${whoWords(\"builder\")} may set off a blast", "if (false) refuse(\"rights\", `only ${whoWords(\"builder\")} may set off a blast", ["F2"]],
  ["each body's own consent", "protocol/authority/bodyverbs.js", "bodyGate(w, actor, who, \"shove\",", "bodyGate(w, who, who, \"shove\",", ["F7"]],
  ["the lean points away", "protocol/authority/bodyverbs.js", "lean: [noNeg0(r3(f.n[0] * m))", "lean: [noNeg0(r3(-f.n[0] * m))", ["F7"]],
  ["the punt starts at the blast", "protocol/authority/bodyverbs.js", "{ from: a.at, act: actOnce }", "{ from: [0, 0, 0], act: actOnce }", ["F1"]],
  ["a blast needs no kick's reach", "protocol/authority/bodyverbs.js", "else if (!blast && (dh > KICK.reach", "else if ((dh > KICK.reach", ["F5"]],
  ["linear falloff", "blast.js", "mag: power * (1 - d / radius)", "mag: power", ["F5"]],
  ["the bounds", "blast.js", "Math.min(b.max, Math.max(b.min, n))", "n", ["F4"]],
  ["the target is told once a minute per asker", "protocol/authority/bodyconsent.js", "if (n[key] > now - C.TRIED_NOTE_MS) return false;", "if (false) return false;", ["F10"]],
  ["CONTROL (no-op: must stay green)", "blast.js", "// shared/blast.js — the", "//  shared/blast.js — the", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/force-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function mutantTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
  linkInto(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = mutantTree("fmut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file}`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[force-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  const d = scratch("fctl"); const r0 = archiveTo(ENGINE, BASE, ["shared", "server"], d);
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  linkInto(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const wrong = lines.filter((l) => l.startsWith("ok "));
  console.log(lines.map((l) => `${l.startsWith("FAIL") ? "as expected at base: " : "WRONG AT BASE:       "}${l.slice(0, 140)}`).join("\n"));
  console.log(`[force-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (every case must be red there)`);
  process.exit(wrong.length || !lines.length ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("force");

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
  const name = `f${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { clock.advance(step);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, entries: () => W().entries };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 120)}`);
const launchesOf = (s: any) => s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch");
const shovesIn = (s: any, who: string) => (s.call(who, "inbox").messages ?? []).filter((m: any) => m.type === "body" && m.kind === "shove");
// owner olive, builder bob, inhabitant vic; a world running eidosim; a crate (0.6 m) at the origin anyone may punt
function cast(s: any, { physics = true } = {}) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "inhabitant"], ["ida", "inhabitant"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
  if (physics) s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: process.env.PHYS_ENGINE ?? "eidosim@1.0.0" } });
  s.call("olive", "create", { id: "crate", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, 0] } });
}

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  { id: "F1", what: "a builder's blast 1 m off the crate's -x side punts it outward (+x, lifted) as one force act, the launch caused by it", run(s) { cast(s);
      const n0 = s.entries().length; const r = s.call("bob", "force", { at: [-1, 0, 0] });
      const acts = s.entries().slice(n0).filter((e: any) => e.kind === "act"); const l = launchesOf(s)[0];
      return { r: show(r), punted: r.punted, acts: acts.map((e: any) => e.body?.verb ?? e.verb), act: r.act, cause: l?.cause, v: l?.body?.v }; },
    good: (o) => o.r === "ok" && o.punted?.length === 1 && o.acts.length === 1 && o.cause === o.act && o.v?.[0] > 1 && o.v?.[1] > 0.5 && Math.abs(o.v?.[2]) < 1e-6 },
  { id: "F2", what: "an inhabitant's blast is refused rights, and nothing flies", run(s) { cast(s);
      const r = s.call("vic", "force", { at: [-1, 0, 0] }); return { r: code(r), launches: launchesOf(s).length }; },
    good: (o) => o.r === "rights" && o.launches === 0 },
  { id: "F3", what: "force needs at: [x, y, z] (missing, or two numbers, is refused, never a crash)", run(s) { cast(s);
      return { none: code(s.call("bob", "force", {})), two: code(s.call("bob", "force", { at: [1, 2] })) }; },
    good: (o) => o.none === "missing-arg" && o.two === "shape" },
  { id: "F4", what: "radius and power are held to 0.5–30 m and 0.2–12 m/s, with a note saying so", run(s) { cast(s);
      const r = s.call("bob", "force", { at: [-1, 0, 0], radius: 100, power: 50 }); const lo = s.call("bob", "force", { at: [-50, 0, 0], radius: 0.01, power: 0.01 }, 2000);
      return { r: show(r), radius: r.radius, power: r.power, notes: (r.notes ?? []).map((n: any) => n.field), lo: [lo.radius, lo.power] }; },
    good: (o) => o.r === "ok" && o.radius === 30 && o.power === 12 && o.notes.includes("radius") && o.notes.includes("power") && o.lo[0] === 0.5 && o.lo[1] === 0.2 },
  { id: "F5", what: "linear falloff to the rim: a crate 3 m out (past a kick's reach) goes slower than one 1 m out, as power × (1 − d/r); one past the rim stays", run(s) { cast(s);
      s.call("olive", "create", { id: "far", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [2, 0] } });
      s.call("olive", "create", { id: "out", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [5, 0] } });
      const r = s.call("bob", "force", { at: [-1, 0, 0], radius: 4, power: 4 });
      const sp = (id: string) => { const p = (r.punted ?? []).find((x: any) => x.id === id); return p ? Math.hypot(...p.v) : null; };
      return { r: show(r), near: sp("crate"), far: sp("far"), out: sp("out") }; },
    good: (o) => o.r === "ok" && Math.abs(o.near - 3) < 0.01 && Math.abs(o.far - 1) < 0.01 && o.out === null },
  { id: "F6", what: "the punt's own gates: a locked crate and one in a hand are left be (named in skipped), the rest still fly", run(s) { cast(s);
      s.call("olive", "create", { id: "lk", model: "crate", components: { physics: { kind: "dynamic", who: "inhabitant" }, lock: true }, place: { at: [0, 1.5] } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "inhabitant" } }, place: { at: [0, -1.5] } });
      s.call("vic", "move", { to: [0.5, 0, -1.5] }); const g = s.call("vic", "grab", { id: "ball" });
      const r = s.call("bob", "force", { at: [-1, 0, 0] });
      return { g: show(g), r: show(r), punted: (r.punted ?? []).map((x: any) => x.id), skipped: r.skipped ?? [] }; },
    good: (o) => o.g === "ok" && o.r === "ok" && o.punted.join() === "crate" && o.skipped.some((x: any) => x.id === "lk" && x.code === "locked") && o.skipped.some((x: any) => x.id === "ball" && x.code === "held") },
  { id: "F7", what: "bodies: vic (move gate on, the default) is shoved away from the blast; ida (move off) is not, and is only counted; a body past the rim hears nothing", run(s) { cast(s, { physics: false });
      s.call("vic", "move", { to: [1, 0, 0] }); s.call("ida", "move", { to: [-1, 0, 0.5] }); const c = s.call("ida", "consent", { move: false });
      s.call("bob", "move", { to: [0, 0, 6] });
      const r = s.call("bob", "force", { at: [0, 0, 0], radius: 4, power: 3 });
      const v = shovesIn(s, "vic"), i = shovesIn(s, "ida"), b = shovesIn(s, "bob");
      return { c: show(c), r: show(r), bodies: r.bodies, vic: v.map((m: any) => m.spec?.lean), ida: i.length, bob: b.length }; },
    good: (o) => o.c === "ok" && o.r === "ok" && o.vic.length === 1 && o.vic[0]?.[0] > 2 && Math.abs(o.vic[0][2]) < 1e-9 && o.ida === 0 && o.bob === 0 && JSON.stringify(o.bodies) === '{"shoved":1,"refused":1}' },
  { id: "F8", what: "a world without physics: bodies are still shoved, things stay put (a note says why); standing at your own blast knocks you over too", run(s) { cast(s, { physics: false });
      s.call("bob", "move", { to: [0.5, 0, 0.5] }); const n0 = s.entries().length;
      const r = s.call("bob", "force", { at: [0.5, 0, 0.5] });
      return { r: show(r), punted: r.punted?.length, notes: JSON.stringify(r.notes ?? []), me: shovesIn(s, "bob").length, launches: launchesOf(s).length, added: s.entries().length - n0 }; },
    good: (o) => o.r === "ok" && o.punted === 0 && /no physics/.test(o.notes) && o.me === 1 && o.launches === 0 && o.added === 1 },
  { id: "F9", what: "who was shoved never reaches the log: the act holds the request, not the bodies", run(s) { cast(s, { physics: false });
      s.call("vic", "move", { to: [1, 0, 0] }); const n0 = s.entries().length; s.call("bob", "force", { at: [0, 0, 0] });
      const added = s.entries().slice(n0); return { n: added.length, at: added[0]?.body?.request?.at, refused: added[0]?.body?.refused, text: JSON.stringify(added) }; },
    good: (o) => o.n === 1 && !o.refused && JSON.stringify(o.at) === "[0,0,0]" && !/vic/.test(o.text) && /"force"/.test(o.text) },
  { id: "F10", what: "a refused body hears body-refused {from, class shove, gate move} once per asker per TRIED_NOTE_MS, however many blasts land meanwhile", run(s) { cast(s, { physics: false });
      s.call("ida", "move", { to: [1, 0, 0] }); s.call("ida", "consent", { move: false }); s.call("bob", "move", { to: [0, 0, 6] });
      for (let k = 0; k < 3; k++) s.call("bob", "force", { at: [0, 0, 0] }, 1000);
      const tried = () => (s.call("ida", "inbox").messages ?? []).filter((m: any) => m.type === "body-refused" && m.from === "bob");
      const first = tried(); s.call("bob", "force", { at: [0, 0, 0] }, 61000); const later = tried();
      return { first: first.map((m: any) => `${m.class}/${m.gate}`), later: later.length }; },
    good: (o) => o.first.join() === "shove/move" && o.later === 1 },
];
let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 300) }; }
  let good = false; try { good = !o.threw && c.good(o); } catch { good = false; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id} ${c.what}${good ? "" : `\n      ${JSON.stringify(o)}`}`);
}
console.log(`[force-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
