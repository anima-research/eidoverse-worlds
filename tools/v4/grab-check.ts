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
//   R   release modes (slice 2): the throw multiplier, stay, return home (now, and after returnAfter), snapping into a
//       socket that accepts it
//   H   the hold record (slice 3): hand, grip or offset, a second hand; what every client is told
//   O   a host that stopped while someone held a thing: settled at load as leave settles it
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
  ["a throw with no sim is a drop", "v4/door.js", "const why = !fliesIn(w.state(), a.id) ?", "const why = false ?", ["G4"]],
  ["only a dynamic thing in a sim world flies", "v4/door.js", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c.sim && st.entities[id]?.c.physics?.kind === \"dynamic\";", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c.sim;", ["G3"]],
  ["the shape check", "v4/door.js", "if (name === \"grabbable\") { const bad = checkGrabbable(v, at);", "if (false) { const bad = checkGrabbable(v, at);", ["G9"]],
  ["the throw multiplier", "v4/door.js", "if (g && g.throw !== 1 && tool === \"throw\") {", "if (false) {", ["R1"]],
  ["throw: 0 only drops", "v4/door.js", ": g?.throw === 0 ? `${a.id} can't be thrown", ": false ? `${a.id} can't be thrown", ["R1"]],
  ["stay: a put with no pos stays at the hand", "v4/door.js", "if (pos === undefined && stay) pos = h.pose.pos.map(r3);", "", ["R2"]],
  ["stay: never called floating", "v4/door.js", ".filter((x) => !(stay && (x.kind === \"floating\" || x.kind === \"sunk\")))", ".filter(() => true)", ["R2"]],
  ["release: return goes home at once", "v4/door.js", "if (g?.release === \"return\" && g.home) {", "if (false) {", ["R3"]],
  ["a returning drop doesn't fly", "v4/door.js", "const sets = !fliesIn(st, a.id) || g?.release === \"return\" ||", "const sets = !fliesIn(st, a.id) ||", ["R3"]],
  ["a returning throw doesn't fly", "v4/door.js", ": g?.release === \"return\" ? null : undefined;", ": undefined;", ["R3"]],
  ["home is stamped", "v4/door.js", "if (v.home === undefined) home = homeHere(after, id);", "if (false) home = homeHere(after, id);", ["R3", "R4"]],
  ["home follows an edit that moves it from home", "v4/door.js", "else if (!setsG && ctx.st.entities[id] && sameHome(ctx.st, id, v.home) && !sameHome(after, id, v.home)) home = homeHere(after, id);", "", ["R4"]],
  ["returnAfter runs at each request", "v4/door.js", "settleSim(w); returnDue(w); expireAsks(w);", "settleSim(w); expireAsks(w);", ["R4"]],
  ["returnAfter: not while held", "v4/door.js", "if (!g?.home || w.presence.holds[id]) continue;", "if (!g?.home) continue;", ["R4"]],
  ["returnAfter: only a hand or physics moving it counts", "v4/door.js", "const byHand = (c.kind === \"act\" && (HAND_VERBS.has(c.verb)", "const byHand = true || (c.kind === \"act\" && (HAND_VERBS.has(c.verb)", ["R4"]],
  ["returnAfter: the time", "v4/door.js", "now - r.ts < g.returnAfter * 1000 ||", "", ["R4"]],
  ["snapping", "v4/door.js", "const snap = snapTarget(st, a.id, g, a.pos ?? h.pose.pos);", "const snap = { to: null, notes: [] };", ["R5", "R6", "R7", "R9"]],
  ["snapping: within the radius", "v4/door.js", "if (d > socketRadius(sk)) continue;", "", ["R5"]],
  ["snapping: fits meets accepts", "v4/door.js", "if (!fitsSocket(g, sk) || !Array.isArray(sk.pos)) continue;", "if (!Array.isArray(sk.pos)) continue;", ["R6"]],
  ["snapping: an occupied socket is passed over", "v4/door.js", "if (Object.entries(st.entities).some(([k, x]) => k !== id && x.c.parent?.to === hid && x.c.parent?.slot === slot)) {", "if (false) {", ["R6"]],
  ["snapping: a locked host is passed over", "v4/door.js", "if (lk) { out.notes.push({ passedOver: { to: hid, slot }, why: `${lk} is locked` }); continue; }", "", ["R6"]],
  ["snapping: a drop in a physics world snaps instead of flying", "v4/door.js", "|| (g && w.presence.holds[a.id]?.by === actor && snapTarget(st, a.id, g, a.pos ?? w.presence.holds[a.id].pose.pos).to);", ";", ["R9"]],
  ["sockets.accepts/radius are checked", "sockbody.js", "if ((r = checkAccepts(sk, sat))) return r;", "", ["R8"]],
  ["the hold record keeps hand and grip or offset", "v4/door.js", "pose: { pos: hand, q: t.q, scale: t.scale }, handled, ...how };", "pose: { pos: hand, q: t.q, scale: t.scale }, handled };", ["H1", "H4"]],
  ["a named grip must exist", "v4/door.js", "if (!g.grips[a.grip]) refuse(\"no-grip\", `it has no grip called '${a.grip}'`, `its grips: ${names.join(\", \")}`", "if (false) refuse(\"no-grip\", `it has no grip called '${a.grip}'`, `its grips: ${names.join(\", \")}`", ["H2"]],
  ["a named grip must suit the hand", "v4/door.js", "if (a.grip !== undefined && !pickGrip(g, hand, { named: a.grip })) refuse(\"wrong-hand\"", "if (false) refuse(\"wrong-hand\"", ["H2"]],
  ["a hand takes a grip that suits it", "v4/door.js", "const grip = a.grip ?? pickGrip(g, hand);", "const grip = a.grip;", ["H2", "H3", "H4"]],
  ["an offset is kept", "v4/door.js", "return { hand, ...(a.offset ? { offset:", "return { hand, ...(false ? { offset:", ["H3"]],
  ["an offset is checked", "v4/door.js", "if (a.offset !== undefined && !offsetOk(a.offset)) refuse(", "if (false) refuse(", ["H3"]],
  ["twoHanded takes a second hand", "v4/door.js", "if (g.twoHanded) {\n    if (a.grip", "if (false) {\n    if (a.grip", ["H4"]],
  ["one hand of two lets go", "v4/door.js", "if (h.second && (a.hand === h.second.hand || a.hand === h.hand)) {", "if (false) {", ["H4"]],
  ["a second hand takes a secondary grip", "grab.js", "const exact = all.find(([, x]) => x.role === role && x.hand === hand) ?? all.find(([, x]) => x.role === role);", "const exact = null;", ["H4"]],
  ["every client is told the hand", "grab.js", "...(h.hand ? { hand: h.hand } : {}),", "", ["H1", "H4"]],
  ["orphans: a hold whose holder isn't here is settled", "v4/door.js", "for (const who of [...new Set(Object.values(w.presence.holds ?? {}).map((h) => h.by))]) if (!here.has(who)) {", "for (const who of []) if (!here.has(who)) {", ["O1"]],
  ["orphans: the log's lift is settled", "v4/door.js", "for (const [id, lift] of orphanLifts(w)) {", "for (const [id, lift] of []) {", ["O2"]],
  ["orphans: a lift is settled once", "v4/door.js", "if (o.verb === \"create\" || (o.verb === \"delete\" && o.comp === undefined) || [\"transform\", \"parent\", \"model\", \"physics\"].includes(o.comp)) lifted.delete(o.id); }", "}", ["O2"]],
  ["orphans: a returning thing goes home", "v4/door.js", "if (g?.release === \"return\" && g.home) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq);", "if (false) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq);", ["O2"]],
  ["orphans: a holder who's here keeps it", "v4/door.js", "if (w.presence.holds[id] || !st.entities[id]) continue;", "if (!st.entities[id]) continue;", ["O2"]],
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
const G = await import(TREE + "shared/grab.js").catch(() => ({}));   // absent at the base commit (--control)
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
    presence: o.presence ?? { bodies: {}, holds: {} }, savePresence: () => {}, scripts: o.scripts ?? null,
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
  // a restart: the same log, a new door; presence as the host kept it (a copy: persisted, as server/v4/disk.ts; fresh: in memory, as live.ts)
  const reopen = (presence: any) => { w = openWorld(name, { ...o, presence: JSON.parse(JSON.stringify(presence ?? { bodies: {}, holds: {} })) }); return w; };
  return { name, call, walk, reopen, w: W, advance: (ms: number) => { T += ms; process.env.V4_NOW = String(T); }, entries: () => W().entries };
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
  // ---------------- R: release modes (slice 2) ----------------
  { id: "R1", what: "throw: grabbable.throw scales the launch velocity (said in a note); throw: 0 lets go instead (a drop: it falls)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "dart", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", throw: 2 } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "anvil", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", throw: 0 } }, place: { at: [0.4, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "dart" });
      const t = s.call("vic", "throw", { id: "dart", v: [0, 1, 1.5] }); const L = s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch").at(-1);
      const act = s.entries().filter((e: any) => e.kind === "act" && e.verb === "throw").at(-1);
      s.call("vic", "wait", {}, 8000); s.call("vic", "grab", { id: "anvil" }); const n0 = s.entries().length;
      const t0 = s.call("vic", "throw", { id: "anvil", v: [0, 1, 3] });
      return { t: show(t), v: L?.body?.v, sent: act?.body?.request?.v, note: t.notes?.some((n: any) => /grabbable\.throw/.test(n.why)), t0: show(t0), after: since(s, n0), v0: s.entries().at(-1)?.body?.v, why: t0.notes?.find((n: any) => n.thrown)?.why, carrier: carrier(s) }; },
    good: (o) => o.t === "ok" && JSON.stringify(o.v) === "[0,2,3]" && JSON.stringify(o.sent) === "[0,1,1.5]" && o.note && o.t0 === "ok" && JSON.stringify(o.after) === '["act:drop","sim:launch"]' && JSON.stringify(o.v0) === "[0,0,0]" && /can't be thrown/.test(o.why ?? "") && !o.carrier.disagree },
  { id: "R2", what: "release: stay hangs where the hand lets go: a put with no pos isn't set down, a floating put isn't refused; a plain thing still is", run(s) { cast(s);
      s.call("olive", "create", { id: "balloon", model: "ball", components: { grabbable: { who: "visitor", release: "stay" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "rock", model: "ball", components: { grabbable: { who: "visitor" } }, place: { at: [0.4, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      s.call("vic", "grab", { id: "balloon" }); const p = s.call("vic", "put", { id: "balloon" }); const at1 = tf(s, "balloon").pos;
      s.call("vic", "grab", { id: "balloon" }); const p2 = s.call("vic", "put", { id: "balloon", pos: [0, 0.8, 1] });
      s.call("vic", "grab", { id: "rock" }); const r = s.call("vic", "put", { id: "rock", pos: [0.4, 0.8, 1] });
      return { p: show(p), at1, p2: show(p2), at2: tf(s, "balloon").pos, rock: code(r) }; },
    good: (o) => o.p === "ok" && o.at1[1] === 1.1 && o.p2 === "ok" && o.at2[1] === 0.8 && o.rock === "implausible" },
  { id: "R3", what: "release: return: let go, it goes home at once (the holder's act, then the door's return-home caused by it); its home was stamped at create", run(s) { cast(s, true);
      const c = s.call("olive", "create", { id: "torch", model: "table-lamp", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", release: "return" } }, place: { at: [0, 0] } });
      const home = comp(s, "torch", "grabbable")?.home;
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "torch" }); s.call("vic", "move", { to: [0, 0, 3] }, 1000);
      const n0 = s.entries().length; const d = s.call("vic", "drop", { id: "torch" }); const L = s.entries(); const after = since(s, n0);
      const ret = L.slice(n0).find((e: any) => e.kind === "act" && e.verb === "return-home");
      const at = tf(s, "torch").pos; s.call("vic", "move", { to: [0, 0, 0.5] }, 1000); s.call("vic", "grab", { id: "torch" }); const n1 = s.entries().length;
      const t = s.call("vic", "throw", { id: "torch", v: [0, 2, 3] });
      return { home, stampNote: c.notes?.some((n: any) => n.field === "home"), d: show(d), after, cause: ret ? L[ret.cause]?.verb : null, at, held: held(s, "torch"), t: show(t), thrown: since(s, n1), carrier: carrier(s) }; },
    good: (o) => JSON.stringify(o.home?.pos) === "[0,0,0]" && o.stampNote && o.d === "ok" && JSON.stringify(o.after) === '["act:put","act:return-home","state:set"]' && o.cause === "put" && JSON.stringify(o.at) === "[0,0,0]" && o.held === null && o.t === "ok" && JSON.stringify(o.thrown) === '["act:put","act:return-home","state:set"]' && !o.carrier.disagree },
  { id: "R4", what: "returnAfter: unheld that long after a hand moved it, the next request sends it home, once; not while held; an edit's move doesn't count", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "visitor", returnAfter: 30 } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("vic", "move", { to: [0, 0, 3] }, 1000);
      s.call("vic", "put", { id: "ball" }); s.advance(20000); s.call("vic", "look", {});
      const early = tf(s, "ball").pos;
      s.advance(15000); const n0 = s.entries().length; s.call("vic", "look", {}); const back = tf(s, "ball").pos; const first = since(s, n0);
      s.advance(60000); const n1 = s.entries().length; s.call("vic", "look", {}); const again = since(s, n1);
      // held past the time: no return while held
      s.call("vic", "move", { to: [0, 0, 0.5] }, 1000); s.call("vic", "grab", { id: "ball" }); s.call("vic", "move", { to: [0, 0, 2] }, 1000); s.call("vic", "put", { id: "ball" }); s.call("vic", "grab", { id: "ball" });
      s.advance(60000); const n2 = s.entries().length; s.call("vic", "look", {}); const whileHeld = since(s, n2);
      s.call("vic", "put", { id: "ball" });
      // a builder's edit moves it: its home follows it (it was home), and no return follows
      s.advance(40000); s.call("vic", "look", {});
      s.call("olive", "set", { id: "ball", component: "transform", value: { pos: [2, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
      const home2 = comp(s, "ball", "grabbable").home?.pos;
      // …and with a home set elsewhere (a builder may), the edit that left it away from home still isn't a release
      s.call("olive", "set", { id: "ball", component: "grabbable", value: { ...comp(s, "ball", "grabbable"), home: { pos: [0, 0, 0], q: [0, 0, 0, 1] } } });
      s.advance(60000); const n3 = s.entries().length; s.call("vic", "look", {});
      return { early, back, first, again, whileHeld, home2, afterEdit: since(s, n3), at: tf(s, "ball").pos }; },
    good: (o) => o.early[2] > 2 && JSON.stringify(o.back) === "[0,0,0]" && JSON.stringify(o.first) === '["act:return-home","state:set"]' && !o.again.length && !o.whileHeld.length && JSON.stringify(o.home2) === "[2,0,2]" && !o.afterEdit.length && JSON.stringify(o.at) === "[2,0,2]" },
  { id: "R5", what: "fits + sockets.accepts: let go within the socket's radius, it snaps in (parent {to, slot}, the socket's pose); undo takes it back out", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("bob", "move", { to: [0.8, 0, 0.6] }); s.call("bob", "grab", { id: "key" });
      const far = s.call("bob", "drop", { id: "key", pos: [0.65, 0.8, 0.1] }); const farPar = comp(s, "key", "parent") ?? null; s.call("bob", "grab", { id: "key" }); const n0 = s.entries().length;
      const d = s.call("bob", "drop", { id: "key", pos: [0.1, 0.75, 0.05] }); const par = comp(s, "key", "parent"); const t = tf(s, "key");
      /* a builder's own put (a visitor's put is a settlement their rank can't undo) */ const u = s.call("bob", "undo", {}); const after = { parent: comp(s, "key", "parent") ?? null, pos: tf(s, "key").pos };
      return { far: show(far), farPar, d: show(d), snapped: d.notes?.some((n: any) => n.snapped), par, t, act: since(s, n0), u: show(u), after }; },
    good: (o) => o.far === "ok" && o.farPar === null && o.d === "ok" && o.snapped && o.par?.to === "rack" && o.par?.slot === "hook" && JSON.stringify(o.t.pos) === "[0,0.8,0]" && o.u === "ok" && o.after.parent === null && JSON.stringify(o.after.pos) === "[0.65,0,0.1]" },
  { id: "R6", what: "…an occupied socket, one on a locked thing and a key that doesn't fit are passed over (it's set down, and the reply says why)", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "safe", model: "crate", components: { lock: true, sockets: { slot: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [3, 0] } });
      for (const [id, x, fits] of [["k1", 1, ["key"]], ["k2", 1.2, ["key"]], ["coin", 1.4, ["coin"]], ["k3", 2.2, ["key"]]]) s.call("olive", "create", { id, model: "book", components: { grabbable: { who: "visitor", fits } }, place: { at: [x, 0] } });
      s.call("vic", "move", { to: [0.8, 0, 0.6] });
      const go = (id: string, pos: number[]) => { s.call("vic", "grab", { id }); return s.call("vic", "drop", { id, pos }); };
      const c = go("coin", [-0.2, 0.8, -0.15]); const a = go("k1", [0, 0.8, 0.1]); const b = go("k2", [0, 0.8, 0.1]);   // the coin first: the hook is free when it doesn't fit
      s.call("vic", "move", { to: [2.4, 0, 0.6] }, 1000); const d = go("k3", [3, 0.8, 0.1]);
      return { a: comp(s, "k1", "parent")?.slot ?? null, b: [show(b), comp(s, "k2", "parent") ?? null, b.notes?.find((n: any) => n.passedOver)?.why], c: [show(c), comp(s, "coin", "parent") ?? null], d: [show(d), comp(s, "k3", "parent") ?? null, d.notes?.find((n: any) => n.passedOver)?.why] }; },
    good: (o) => o.a === "hook" && o.b[0] === "ok" && o.b[1] === null && /already sits/.test(o.b[2] ?? "") && o.c[0] === "ok" && o.c[1] === null && o.d[0] === "ok" && o.d[1] === null && /locked/.test(o.d[2] ?? "") },
  { id: "R7", what: "taken back out of its socket, it's an ordinary grab, and the put that follows deletes the parent", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"] } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("vic", "move", { to: [0.5, 0, 0.6] }); s.call("vic", "grab", { id: "key" }); s.call("vic", "drop", { id: "key", pos: [0, 0.8, 0.05] });
      const inIt = comp(s, "key", "parent")?.slot; const g = s.call("vic", "grab", { id: "key" }); s.call("vic", "move", { to: [0.5, 0, 2] }, 1000); const p = s.call("vic", "put", { id: "key" });
      return { inIt, g: show(g), p: show(p), parent: comp(s, "key", "parent") ?? null }; },
    good: (o) => o.inIt === "hook" && o.g === "ok" && o.p === "ok" && o.parent === null },
  { id: "R9", what: "in a world that runs physics, a dynamic key dropped near its hook snaps in (no flight); dropped away from it, it falls (a launch)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); s.call("vic", "grab", { id: "key" }); const n0 = s.entries().length;
      const d = s.call("vic", "drop", { id: "key", pos: [0.1, 0.8, 0.1] }); const near = since(s, n0); const par = comp(s, "key", "parent");
      s.call("vic", "grab", { id: "key" }); const n1 = s.entries().length; const f = s.call("vic", "drop", { id: "key", pos: [0.9, 1, 0.9] }); s.call("vic", "wait", {}, 6000);
      return { d: show(d), near, par: par?.slot, f: show(f), far: since(s, n1).slice(0, 2), carrier: carrier(s) }; },
    good: (o) => o.d === "ok" && JSON.stringify(o.near) === '["act:put","state:batch"]' && o.par === "hook" && o.f === "ok" && JSON.stringify(o.far) === '["act:drop","sim:launch"]' && !o.carrier.disagree },
  { id: "R8", what: "sockets.accepts/radius are checked: radius 5 and an empty accepts are refused", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", place: { at: [0, 0] } });
      const a = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: ["key"], radius: 5 } } });
      const b = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: [] } } });
      const c = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: ["key"], radius: 0.2 } } });
      return { a: code(a), b: code(b), c: show(c) }; },
    good: (o) => o.a === "shape" && o.b === "shape" && o.c === "ok" },
  // ---------------- H: the hold record (slice 3) ----------------
  { id: "H1", what: "the hold record says which hand (default right; grab {hand: 'left'}); holdWire is what every client is told", run(s) { cast(s);
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "mug", model: "book", components: { grabbable: { who: "visitor" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const a = s.call("vic", "grab", { id: "cup" }); const b = s.call("vic", "grab", { id: "mug", hand: "left" }); const bad = s.call("vic", "grab", { id: "cup", hand: "up" });
      return { a: a.hand, b: b.hand, rec: G.holdWire?.(held(s, "mug")), bad: code(bad), logged: s.entries().filter((e: any) => e.kind === "act" && e.verb === "grab" && !e.body?.refused).length }; },
    good: (o) => o.a === "right" && o.b === "left" && JSON.stringify(o.rec) === '{"by":"vic","hand":"left"}' && o.bad === "shape" && o.logged === 0 },
  { id: "H2", what: "grips: a hand takes the first grip that suits it; a named grip must exist (did you mean) and suit the hand; a thing with none has no grip to name", run(s) { cast(s);
      s.call("olive", "create", { id: "sword", model: "book", components: { grabbable: { who: "visitor", grips: { hilt: { pos: [0, 0.05, 0], hand: "right", fingers: "fist" }, offhand: { pos: [0, 0.15, 0], hand: "left" } } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "visitor" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const r = s.call("vic", "grab", { id: "sword" }); s.call("vic", "put", { id: "sword" });
      const l = s.call("vic", "grab", { id: "sword", hand: "left" }); s.call("vic", "put", { id: "sword" });
      const typo = s.call("vic", "grab", { id: "sword", grip: "hlt" }); const wrong = s.call("vic", "grab", { id: "sword", grip: "hilt", hand: "left" });
      const named = s.call("vic", "grab", { id: "sword", grip: "offhand" }); s.call("vic", "put", { id: "sword" });
      const none = s.call("vic", "grab", { id: "cup", grip: "hilt" });
      return { r: [r.hand, r.grip], l: [l.hand, l.grip], typo: [code(typo), typo.refused?.didYouMean], wrong: code(wrong), named: [named.hand, named.grip], none: code(none) }; },
    good: (o) => JSON.stringify(o.r) === '["right","hilt"]' && JSON.stringify(o.l) === '["left","offhand"]' && o.typo[0] === "no-grip" && o.typo[1]?.[0] === "hilt" && o.wrong === "wrong-hand" && JSON.stringify(o.named) === '["left","offhand"]' && o.none === "no-grip" },
  { id: "H3", what: "offset: with no grips, a hand sends where it took hold and the record keeps it; with grips the grip wins; a malformed one is refused", run(s) { cast(s);
      s.call("olive", "create", { id: "rock", model: "book", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "axe", model: "book", components: { grabbable: { who: "visitor", grips: { haft: { pos: [0, 0.1, 0] } } } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const OFF = { pos: [0.01, -0.02, 0.05], q: [0, 0, 0, 1] };
      const bad = s.call("vic", "grab", { id: "rock", offset: { pos: [0, 0, 9], q: [0, 0, 0, 1] } });
      const a = s.call("vic", "grab", { id: "rock", offset: OFF }); const b = s.call("vic", "grab", { id: "axe", hand: "left", offset: OFF });
      return { bad: code(bad), a: a.offset, rec: held(s, "rock")?.offset, b: [b.grip, b.offset ?? null] }; },
    good: (o) => o.bad === "shape" && JSON.stringify(o.a?.pos) === "[0.01,-0.02,0.05]" && JSON.stringify(o.rec?.q) === "[0,0,0,1]" && o.b[0] === "haft" && o.b[1] === null },
  { id: "H4", what: "a second hand: twoHanded takes it in both (secondary grip); one hand letting go leaves it in the other; not twoHanded, the other hand swaps", run(s) { cast(s);
      s.call("olive", "create", { id: "rifle", model: "book", components: { grabbable: { who: "visitor", twoHanded: true, grips: { stock: { pos: [0, 0, 0], hand: "right" }, fore: { pos: [0, 0.15, 0], role: "secondary" } } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "visitor" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const n0 = s.entries().length;
      s.call("vic", "grab", { id: "rifle" }); const two = s.call("vic", "grab", { id: "rifle", hand: "left" }); const both = JSON.stringify(G.holdWire?.(held(s, "rifle")));
      const one = s.call("vic", "drop", { id: "rifle", hand: "left" }); const after1 = JSON.stringify(G.holdWire?.(held(s, "rifle")));
      s.call("vic", "grab", { id: "rifle", hand: "left" }); const prim = s.call("vic", "drop", { id: "rifle", hand: "right" }); const after2 = JSON.stringify(G.holdWire?.(held(s, "rifle")));
      s.call("vic", "grab", { id: "cup" }); const sw = s.call("vic", "grab", { id: "cup", hand: "left" });
      return { two: show(two), both, one: [show(one), one.recorded], after1, prim: show(prim), after2, sw: sw.hand, cup: held(s, "cup")?.hand, logged: since(s, n0) }; },
    good: (o) => o.two === "ok" && o.both === '{"by":"vic","hand":"right","grip":"stock","second":{"hand":"left","grip":"fore"}}' && o.one[0] === "ok" && o.one[1] === false
      && o.after1 === '{"by":"vic","hand":"right","grip":"stock"}' && o.prim === "ok" && o.after2 === '{"by":"vic","hand":"left","grip":"fore"}' && o.sw === "left" && o.cup === "left" && !o.logged.length },
  // ---------------- O: orphaned holds after the host stopped (R 10-06: a server killed while someone holds a thing) ----------------
  { id: "O1", what: "presence kept on disk: a hold whose holder isn't here at load is settled as leave settles it (a drop as the holder: set down; a stay stays; a return goes home)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "balloon", model: "ball", components: { grabbable: { who: "visitor", release: "stay" } }, place: { at: [0.3, 0] } });
      s.call("olive", "create", { id: "torch", model: "book", components: { grabbable: { who: "visitor", release: "return" } }, place: { at: [-0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); for (const id of ["ball", "balloon", "torch"]) s.call("vic", "grab", { id }); s.call("vic", "move", { to: [0, 0, 2] }, 1000);
      const w2 = s.reopen(s.w().presence); const n0 = s.entries().length; T += 100; process.env.V4_NOW = String(T);
      const r = D.settleOrphans?.(w2, []);
      return { r: r?.length, holds: Object.keys(w2.presence.holds), body: !!w2.presence.bodies.vic, after: since(s, n0), by: s.entries().slice(n0).filter((e: any) => e.kind === "act").map((e: any) => e.actor),
        ball: tf(s, "ball").pos, balloon: tf(s, "balloon").pos, torch: tf(s, "torch").pos }; },
    good: (o) => o.r >= 1 && !o.holds.length && !o.body && o.by.includes("vic") && o.ball[1] === 0 && Math.abs(o.ball[2] - 2) < 1e-6 && o.balloon[1] === 1.1 && JSON.stringify(o.torch) === "[-0.3,0,0]" },
  { id: "O2", what: "presence kept in memory: in a physics world the log's lift is settled at load (door return-held, cause the lift; a return goes home), once, and a carrier agrees", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "torch", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "visitor", release: "return" } }, place: { at: [0.3, 0] } });
      s.call("olive", "create", { id: "kept", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [-0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [-0.3, 0, 0.5] });
      s.call("vic", "grab", { id: "ball" }); s.call("vic", "grab", { id: "torch" }); s.call("ann", "grab", { id: "kept" }); s.call("vic", "move", { to: [0, 0, 2] }, 1000);
      const annHold = s.w().presence.holds.kept;
      const w2 = s.reopen({ bodies: {}, holds: { kept: annHold } }); const n0 = s.entries().length; T += 100; process.env.V4_NOW = String(T);
      D.settleOrphans?.(w2, ["ann"]); const L = s.entries(); const acts = L.slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.actor}:${e.verb}:${e.body?.id}:${L[e.cause]?.verb ?? "-"}`);
      const n1 = s.entries().length; D.settleOrphans?.(w2, ["ann"]);
      return { acts, again: s.entries().length - n1, kept: !!w2.presence.holds.kept, ball: tf(s, "ball").pos, carrier: carrier(s) }; },
    good: (o) => JSON.stringify(o.acts.sort()) === JSON.stringify(["door:return-held:ball:lift", "door:return-home:torch:lift"]) && o.again === 0 && o.kept && JSON.stringify(o.ball) === "[0,0,0]" && !o.carrier.disagree },
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
