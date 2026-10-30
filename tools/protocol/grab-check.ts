// tools/protocol/grab-check.ts — the `grabbable` component (research RESEARCH-grab-2026-10-06; shared/grab.js) through the
// real door: what a hand may pick up, how it holds it, where it goes when let go, and what using it while held does.
//   bun tools/protocol/grab-check.ts                 every case
//   bun tools/protocol/grab-check.ts --only G2,G4    just those
//   bun tools/protocol/grab-check.ts --tree <dir>    run the cases against another checkout's shared/ (a mutant, a base)
//   bun tools/protocol/grab-check.ts --control       the base commit (7a3d8435, before grabbable): every NEW case must be red
//                                              there and every MIGRATION case green (today's behaviour, kept)
//   bun tools/protocol/grab-check.ts --mutants       remove each gate in turn (a copy of the tree): its cases must go red; a
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
//   U   use while held (down/up, each one act), the grab and release script events, the presence tier (pose.use)
//   I   the inspector's Grabbable card: Add Component writes the defaults out of the data; the card's edits are checked
//   A   what an agent reads: look, inspect and help
//   F   the independent review's findings (10-06), each red before its fix
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import { ENGINES } from "../../shared/protocol/simlayer.js";
import path from "node:path";
import { ENGINE, scratch, copyTree, archiveTo } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "7a3d8435";

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// [name, file (under shared/), find, replace, cases that must turn red]. Applied as an exact text replacement; a mutation
// whose text isn't found exactly once is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string, string[]][] = [
  ["the physics fallback (migration)", "grab.js", "if (v === undefined && isObj(c.physics) && c.physics.kind === 'dynamic') return", "if (false) return", ["M1", "M2", "M3"]],
  ["grab reads grabOf (a static grabbable is carried)", "protocol/authority/bodyverbs.js", "const g = grabOf(e.c);\n    if (!g) refuse(\"not-grabbable\"", "const g = e.c.physics?.kind === \"dynamic\" ? grabOf(e.c) : null;\n    if (!g) refuse(\"not-grabbable\"", ["G2", "G3"]],
  ["the hand's settlement reads grabOf", "protocol/authority/gate.js", "else if (cap.kind === \"handle\") { const g = grabOf(st.entities[op.id]?.c);", "else if (cap.kind === \"handle\") { const g = st.entities[op.id]?.c.physics?.kind === \"dynamic\" ? grabOf(st.entities[op.id]?.c) : null;", ["G2", "G3"]],
  ["enabled", "protocol/authority/bodyverbs.js", "if (!g.enabled) refuse(\"not-grabbable\"", "if (false) refuse(\"not-grabbable\"", ["G5"]],
  ["who", "protocol/authority/bodyverbs.js", "const need = g.who; const role = roleOf(st, actor); if (rankOf(st, actor) < whoRank(st, need))", "const need = g.who; const role = roleOf(st, actor); if (false)", ["G6"]],
  ["punt keeps physics.who (a kick-only ball is still punted)", "protocol/authority/gate.js", "if (cap.kind === \"handle\" && cap.via === \"punt\") {", "if (false) {", ["G6"]],
  ["steal", "protocol/authority/bodyverbs.js", "if (held && !g.steal && role !== \"owner\")", "if (false)", ["G7"]],
  ["steal: owners may", "protocol/authority/bodyverbs.js", "if (held && !g.steal && role !== \"owner\")", "if (held && !g.steal)", ["G7"]],
  ["range", "protocol/authority/bodyverbs.js", "if (d > g.range) refuse(\"out-of-reach\"", "if (d > REACH) refuse(\"out-of-reach\"", ["G8"]],
  ["a throw with no sim is a drop", "protocol/authority/bodyverbs.js", "const why = !fliesIn(w.state(), a.id) ?", "const why = false ?", ["G4"]],
  ["only a dynamic thing in a sim world flies", "protocol/authority/manipulate.js", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c[\"physics-engine\"] && st.entities[id]?.c.physics?.kind === \"dynamic\";", "const fliesIn = (st, id) => !!st.entities[\"@world\"]?.c[\"physics-engine\"];", ["G3"]],
  ["the shape check", "protocol/authority/checks.js", "if (name === \"grabbable\") { const bad = checkGrabbable(v, at);", "if (false) { const bad = checkGrabbable(v, at);", ["G9"]],
  ["the throw multiplier", "protocol/launchplan.js", "if (g && typeof g.throw === \"number\" && g.throw !== 1 && verb === \"throw\") {", "if (false) {", ["R1"]],
  ["throw: 0 only drops", "protocol/authority/bodyverbs.js", ": g?.throw === 0 ? `${a.id} can't be thrown", ": false ? `${a.id} can't be thrown", ["R1"]],
  ["stay: a put with no pos stays at the hand", "protocol/authority/bodyverbs.js", "if (pos === undefined && stay) pos = h.pose.pos.map(r3);", "", ["R2"]],
  ["stay: never called floating", "protocol/authority/bodyverbs.js", ".filter((x) => !(stay && (x.kind === \"floating\" || x.kind === \"sunk\")))", ".filter(() => true)", ["R2"]],
  ["release: return goes home at once", "protocol/authority/bodyverbs.js", "if (g?.release === \"return\" && g.home) {\n      const ret = returnPlan(w, st, a.id, g);", "if (false) {\n      const ret = returnPlan(w, st, a.id, g);", ["R3"]],
  ["a returning drop doesn't fly", "protocol/authority/bodyverbs.js", "const sets = !fliesIn(st, a.id) || g?.release === \"return\" ||", "const sets = !fliesIn(st, a.id) ||", ["R3"]],
  ["a returning throw doesn't fly", "protocol/authority/bodyverbs.js", ": g?.release === \"return\" ? null : undefined;", ": undefined;", ["R3"]],
  ["home is stamped", "protocol/authority/manipulate.js", "if (!h || (born && !sameHome(after, id, h))) home = homeHere(after, id);", "if (false) home = homeHere(after, id);", ["R3", "R4"]],
  ["home follows an edit that moves it from home", "protocol/authority/manipulate.js", "else if (!setsH && was && sameHome(ctx.st, id, was) && !sameHome(after, id, was)) home = homeHere(after, id);", "", ["R4"]],
  ["returnAfter runs at each request", "protocol/authority.js", "settleSim(w); returnDue(w); CTX.work", "settleSim(w); CTX.work", ["R4"]],
  ["returnAfter: not while held", "protocol/authority/manipulate.js", "if (!g?.home || w.presence.holds[id]) continue;", "if (!g?.home) continue;", ["R4"]],
  ["returnAfter: only a hand or physics moving it counts", "protocol/authority/manipulate.js", "const byManipulation = (c.kind === \"act\" && (MANIPULATE_VERBS.has(c.verb)", "const byManipulation = true || (c.kind === \"act\" && (MANIPULATE_VERBS.has(c.verb)", ["R4"]],
  ["returnAfter: the time", "protocol/authority/manipulate.js", "now - r.ts < g.returnAfter * 1000 ||", "", ["R4"]],
  ["snapping", "protocol/authority.js", "const snap = snapTarget(st, a.id, g, a.pos ?? h.pose.pos);", "const snap = { to: null, notes: [] };", ["R5", "R5s", "R6", "R7", "R9"]],
  ["snapping: within the radius", "protocol/authority/manipulate.js", "if (d > socketRadius(sk)) continue;", "", ["R5", "R5s"]],
  ["snapping: fits meets accepts", "protocol/authority/manipulate.js", "if (!fitsSocket(g, sk)) continue;", "", ["R6"]],
  ["snapping: an occupied socket is passed over", "protocol/authority/manipulate.js", "if (Object.entries(st.entities).some(([k, y]) => k !== id && y.c.parent?.to === x.id)) {", "if (false) {", ["R6"]],
  ["snapping: a locked host is passed over", "protocol/authority/manipulate.js", "if (lk) { out.notes.push({ passedOver: where, why: `${lk} is locked` }); continue; }", "", ["R6"]],
  ["snapping: a drop in a physics world snaps instead of flying", "protocol/authority/bodyverbs.js", "|| (g && w.presence.holds[a.id]?.by === actor && snapTarget(st, a.id, g, a.pos ?? w.presence.holds[a.id].pose.pos).to);", ";", ["R9"]],
  ["sockets.accepts/radius are checked", "sockbody.js", "if ((r = checkAccepts(sk, sat))) return r;", "", ["R8"]],
  ["the hold record keeps hand and grip or offset", "protocol/authority/bodyverbs.js", "scale: t.scale }, handled, ...how };", "scale: t.scale }, handled };", ["H1", "H4"]],
  ["a named grip must exist", "protocol/authority/manipulate.js", "if (!g.grips[a.grip]) refuse(\"no-grip\", `it has no grip called '${a.grip}'`, `its grips: ${names.join(\", \")}`", "if (false) refuse(\"no-grip\", `it has no grip called '${a.grip}'`, `its grips: ${names.join(\", \")}`", ["H2"]],
  ["a named grip must suit the hand", "protocol/authority/manipulate.js", "if (a.grip !== undefined && !pickGrip(g, hand, { named: a.grip })) refuse(\"wrong-hand\"", "if (false) refuse(\"wrong-hand\"", ["H2"]],
  ["a hand takes a grip that suits it", "protocol/authority/manipulate.js", "const grip = a.grip ?? pickGrip(g, hand);", "const grip = a.grip;", ["H2", "H3", "H4"]],
  ["an offset is kept", "protocol/authority/manipulate.js", "return { hand, ...(a.offset ? { offset:", "return { hand, ...(false ? { offset:", ["H3"]],
  ["an offset is checked", "protocol/authority/bodyverbs.js", "if (a.offset !== undefined && !offsetOk(a.offset)) refuse(", "if (false) refuse(", ["H3"]],
  ["twoHanded takes a second hand", "protocol/authority/manipulate.js", "if (g.twoHanded) {\n    if (a.grip", "if (false) {\n    if (a.grip", ["H4"]],
  ["one hand of two lets go", "protocol/authority/bodyverbs.js", "if (h.second && (a.hand === h.second.hand || a.hand === h.hand)) {", "if (false) {", ["H4"]],
  ["a second hand takes a secondary grip", "grab.js", "const exact = all.find(([, x]) => x.role === role && x.hand === hand) ?? all.find(([, x]) => x.role === role);", "const exact = null;", ["H4"]],
  ["every client is told the hand", "grab.js", "...(h.hand ? { hand: h.hand } : {}),", "", ["H1", "H4"]],
  ["orphans: a hold whose holder isn't here is settled", "protocol/authority/scriptrun.js", ".filter((who) => !here.has(who));", ".filter(() => false);", ["O1"]],
  ["orphans: the log's lift is settled", "protocol/authority/scriptrun.js", "for (const [id, lift] of orphanLifts(w)) {", "for (const [id, lift] of []) {", ["O2", "O3d"]],
  ["orphans: a lift is settled once", "protocol/authority/scriptrun.js", "for (const o of ops) { if (o.verb === \"create\" || ends(o)) lifted.delete(o.id);", "for (const o of ops) { if (false) lifted.delete(o.id);", ["O2"]],
  ["orphans: a hold ends under a thing switched off", "protocol/authority/scriptrun.js", "if (endsUnder(o)) for (const k of [...lifted.keys()]) if (under(k, o.id)) lifted.delete(k); }", "}", ["O3", "O3b", "O3c"]],
  ["orphans: a returning thing goes home", "protocol/authority/scriptrun.js", "if (g?.release === \"return\" && g.home) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq);", "if (false) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq);", ["O2", "O3d"]],
  ["orphans: a holder who's here keeps it", "protocol/authority/scriptrun.js", "if (w.presence.holds[id] || !st.entities[id] || lostPlace(st, id)) continue;", "if (!st.entities[id] || lostPlace(st, id)) continue;", ["O2"]],
  ["use while held fires grabbable.use", "protocol/authority/use.js", "if (a.action === undefined && g?.use) { const action", "if (false) { const action", ["U1"]],
  ["use while held: up fires the up", "protocol/authority/use.js", "const action = phase === \"up\" ? g.use.up : g.use.down;", "const action = g.use.down;", ["U1"]],
  ["held: true needs a hold", "protocol/authority/use.js", "if (a.args?.held === true && !holding) refuse(", "if (false) refuse(", ["U1"]],
  ["a held use's script event says held, hand, phase", "protocol/authority/use.js", ", ...(held ?? {}) };", " };", ["U2"]],
  ["grab and release are script events", "protocol/authority.js", "const SCRIPT_EVENTS = [\"use\", \"say\", \"enter\", \"leave\", \"grab\", \"release\"];", "const SCRIPT_EVENTS = [\"use\", \"say\", \"enter\", \"leave\"];", ["U3", "U4"]],
  ["grab and release reach scripts", "protocol/authority/scriptrun.js", "for (let k = 0; k < 8; k++) { drainHeld(w); drainScripts(w);", "for (let k = 0; k < 8; k++) { drainScripts(w);", ["U3", "U4"]],
  ["only scripts whose scope covers the thing", "protocol/authority/scriptrun.js", "if (!(Array.isArray(v.on) && v.on.includes(kind)) || !scopeIds(st, sid, v.scope?.ids).includes(id)) continue;", "if (!(Array.isArray(v.on) && v.on.includes(kind))) continue;", ["U3"]],
  ["a release says how", "protocol/authority/bodyverbs.js", "heldEvent(w, \"release\", a.id, { by: actor, how: stay ? \"stay\" : how, seq: act });", "heldEvent(w, \"release\", a.id, { by: actor, how: \"put\", seq: act });", ["U3"]],
  ["a throw's release says throw", "protocol/authority/manipulate.js", "heldEvent(w, \"release\", a.id, { by: actor, how: verb, seq: act });", "heldEvent(w, \"release\", a.id, { by: actor, how: \"drop\", seq: act });", ["U4"]],
  ["the inspector adds grabbable with its defaults spelled out", "editschema.js", "const spec = Object.fromEntries(Object.entries(GRAB_DEFAULTS).filter(", "const spec = {} ?? Object.fromEntries(Object.entries(GRAB_DEFAULTS).filter(", ["I1"]],
  ["the card's edits are checked as the authority checks them", "editschema.js", "const bad = checkGrabbable(next);\n      if (bad)", "const bad = null;\n      if (bad)", ["I2"]],
  ["look says what a hand may do with it", "protocol/authority/blueprints.js", "    ...(g ? { grab: describeGrab(g, typeof name === \"string\" ? name : id) } : {}),", "", ["A1"]],
  ["review: a put's pos is reach-checked before it snaps", "protocol/authority/bodyverbs.js", "const d0 = dist(gripPoint(me), a.pos); if (d0 > REACH) refuse(", "const d0 = 0; if (d0 > REACH) refuse(", ["F1"]],
  ["review: a refused orphan's hold still ends", "protocol/authority/scriptrun.js", "if (!r.ok) { for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === who) delete w.presence.holds[id];", "if (false) { for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === who) delete w.presence.holds[id];", ["F2b"]],
  ["review: the up from whoever pressed down", "protocol/authority/use.js", "const lateUp = a.args?.phase === \"up\" && P[a.id]?.by === actor && hold?.by !== actor;", "const lateUp = false;", ["F3"]],
  ["review: a copy goes home where it was made", "protocol/authority/manipulate.js", "(born && !sameHome(after, id, h))", "false", ["F4"]],
  ["review: the holder's rank before a return", "protocol/authority/bodyverbs.js", "if (g && rankOf(st, actor) < whoRank(st, g.who)) refuse(\"rights\"", "if (false) refuse(\"rights\"", ["F5"]],
  ["review: a handover drops the old hand's offset", "protocol/authority/bodyverbs.js", "h.hand = h.second.hand; delete h.offset;", "h.hand = h.second.hand;", ["F6"]],
  ["review: what rests on it must be enabled", "protocol/authority/bodyverbs.js", "!(gk && gk.enabled && rankOf(st, actor) >= whoRank(st, gk.who))", "!(gk && rankOf(st, actor) >= whoRank(st, gk.who))", ["F6"]],
  ["the inspector's JSON hatch is checked too", "editschema.js", "if (k === 'grabbable' && data != null) { const bad = checkGrabbable(data);", "if (false) { const bad = checkGrabbable(data);", ["I3"]],
  ["putyaw: a put lands as carried (turned with the body), not as taken", "protocol/authority/bodyverbs.js", "const q = a.q ?? heldQ(w, h);", "const q = a.q ?? h.pose.q;", ["Y1"]],
  ["putyaw: the hold keeps the holder's facing as taken", "protocol/authority/bodyverbs.js", "...(facing !== null ? { facing } : {}), handled", "handled", ["Y1", "Y2", "Y3"]],
  ["putyaw: a drop's launch starts as carried", "protocol/authority/manipulate.js", "else h.pose.q = heldQ(w, h);", "else;", ["Y2"]],
  ["putyaw: a taker's hold starts as the giver's hand turned it", "protocol/authority/bodyverbs.js", ": prev ? heldQ(w, prev) : t.q;", ": t.q;", ["Y3"]],
  ["putyaw: a launch re-bases the hold's facing (a refused one isn't turned twice)", "protocol/authority/manipulate.js", "{ const f = facingOf(w, actor); if (f !== null) h.facing = f; else delete h.facing; }", "", ["Y4"]],
  ["CONTROL (no-op: must stay green)", "grab.js", "// ---------------------------------------------------------------- reading", "// ----------------------------------------------------------------  reading", []],
];
async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/grab-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// the mutant tree: shared/, server/, tools/ and defs/ (so the other suites run in it too), node_modules linked
function mutantTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs"]) if (fs.existsSync(path.join(ENGINE, sub))) copyTree(path.join(ENGINE, sub), path.join(d, sub));
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = mutantTree("gmut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    let good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    let others = "";
    if (cases.includes("M1")) { // the migration proof: the suites that test physics today go red without the fallback
      const env = { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" };
      const reds = ["phys-check.ts", "physlive-check.ts"].map((s) => { const x = Bun.spawnSync(["bun", path.join(d, "tools/protocol", s)], { cwd: d, env });
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
  // the base commit's shared/ (the authority before grabbable): every NEW case must be red there, every M case green
  const d = scratch("gctl"); const r0 = archiveTo(ENGINE, BASE, ["shared", "server/posecheck.ts"], d);
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  const r = await runSelf(d, null, ["--expect-absent"]);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const wrong = lines.filter((l) => { const id = l.slice(5).trim().split(/\s/)[0]; const mig = id.startsWith("M"); return mig ? l.startsWith("FAIL") : l.startsWith("ok "); });
  console.log(lines.map((l) => { const id = l.slice(5).trim().split(/\s/)[0]; const mig = id.startsWith("M");
    return `${(mig ? l.startsWith("ok ") : l.startsWith("FAIL")) ? (mig ? "kept at base:  " : "red at base:   ") : "WRONG AT BASE: "}${l.slice(0, 130)}`; }).join("\n"));
  console.log(`[grab-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (new cases must be red there, migration cases green)`);
  process.exit(wrong.length ? 1 : 0);
}

// ---------------- the authority, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
// fixture-ids.ts opened the fixture seam on ENGINE's authority; a --tree run (mutants, control) imports another instance
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const { KILL_MARGIN = 0 } = await import(TREE + "shared/protocol/physconst.js");
const G = await import(TREE + "shared/grab.js").catch(() => ({}));   // absent at the base commit (--control)
const SB = await import(TREE + "shared/protocol/sandbox.js");
const ST = await import(TREE + "shared/protocol/authority/storage.js");
const ES = await import(TREE + "shared/editschema.js");
const PC = await import(TREE + "server/posecheck.ts").catch(() => import(ENGINE + "server/posecheck.ts"));
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("grab");

function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line),
    presence: o.presence ?? { bodies: {}, holds: {} }, savePresence: () => {}, scripts: o.scripts ?? null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
const ZERO = "sha256:" + "0".repeat(64);
function install(s: any, who: string, id: string, name: string, text: string, value: any) {
  const u = s.call(who, "upload", { text }); return s.call(who, "set", { id, component: `script:${name}`, value: { src: u.src ?? ZERO, ...value } }); }
function session(o: any = {}) {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name, o));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { clock.advance(step);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  // walk the authority's track there: steps of at most 3.5 m, a second apart (a first move is an arrival)
  const walk = (actor: string, to: number[]) => { for (let i = 0; i < 40; i++) { const at = W().presence.bodies[actor]?.at; if (!at) return call(actor, "move", { to });
    const d = Math.hypot(to[0] - at[0], to[2] - at[2]); if (d < 1e-9) return { ok: true }; const k = Math.min(1, 3.5 / d);
    const r = call(actor, "move", { to: [at[0] + (to[0] - at[0]) * k, to[1], at[2] + (to[2] - at[2]) * k] }, 1000); if (!r.ok) return r; } };
  // a restart: the same log, a new door; presence as the host kept it (a copy: persisted, as server/filehost.ts; fresh: in memory, as livehost.ts)
  const reopen = (presence: any) => { w = openWorld(name, { ...o, presence: JSON.parse(JSON.stringify(presence ?? { bodies: {}, holds: {} })) }); return w; };
  return { name, call, walk, reopen, w: W, advance: (ms: number) => { clock.advance(ms); }, entries: () => W().entries };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 120)}`);
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
// the socket a thing sits in, by name, and its host: a socket child's (parent {to: <socket>}) since the cut, or the old parent {to, socket}
const slotOf = (s: any, id: string) => { const p = comp(s, id, "parent"); if (!p) return null; const sk = s.w().state().entities[p.to]?.c.socket; return sk ? sk.name : p.socket ?? null; };
const hostOf = (s: any, id: string) => { const p = comp(s, id, "parent"); if (!p) return null; const e = s.w().state().entities[p.to]; return e?.c.socket ? e.c.parent?.to : p.to; };
const tf = (s: any, id: string) => s.w().state().entities[id]?.c.transform;
const held = (s: any, id: string) => s.w().presence.holds[id] ?? null;
const ENG = { engine: process.env.PHYS_ENGINE ?? "eidosim@1.0.0" };
// owner olive (the founder), builder bob, visitors vic and ann
function cast(s: any, sim = false) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["vic", "member"], ["ann", "member"]]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
  if (sim) s.call("olive", "set", { id: "@world", component: "physics-engine", value: ENG });
}
const tail = (s: any, n: number) => s.entries().slice(-n).map((e: any) => `${e.kind}:${e.verb}`);
// strip the last logged value of id's comp to its commit, with no purge: as a copy of the log changed by hand would hold it
// (the commit is the value's own, so every head still verifies); the session reopens to read it. → the line's seq
const stripLast = (s: any, id: string, comp: string) => {
  const file = path.join(root, "worlds", `${s.name}.jsonl`); const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let k = lines.length - 1; k > 0; k--) { if (!lines[k]) continue; const e = JSON.parse(lines[k]); if (e.kind !== "change") continue;
    const ops = e.verb === "batch" ? e.body.ops : [e.body]; const o = ops.find((x: any) => x.verb !== "delete" && x.id === id && x.comp === comp && "value" in x) ?? (e.verb === "set" && e.body.id === id && e.body.comp === comp && "value" in e.body ? e.body : null);
    if (!o) continue; const c = ST.opCommit(o); delete o.value; delete o.salt; o.commit = c; lines[k] = JSON.stringify(e); fs.writeFileSync(file, lines.join("\n")); return k; }
  return -1; };
const since = (s: any, n0: number) => s.entries().slice(n0).map((e: any) => `${e.kind}:${e.verb}`);
const carrier = (s: any) => { const v = SL.simFold(s.entries(), clock.t + 1e9); /* the authority here folds with the lab catalogue (worldOf: no simModels), so the carrier does too */ return { agree: v.checks.agree, disagree: v.checks.disagree.length }; };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- M: migration (green at base AND now) ----------------
  { id: "M1", what: "a dynamic thing with no grabbable is picked up by physics.who, carried, put down and thrown, as before", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const g = s.call("vic", "grab", { id: "ball" }), p = s.call("vic", "put", { id: "ball" });
      const g2 = s.call("vic", "grab", { id: "ball" }), t = s.call("vic", "throw", { id: "ball", v: [0, 2, 2] });
      s.call("vic", "wait", {}, 8000);
      return { g: show(g), inHand: g.inHandAt, p: show(p), g2: show(g2), t: show(t), flying: t.flying, carrier: carrier(s) }; },
    good: (o) => o.g === "ok" && o.inHand?.[1] === 1.1 && o.p === "ok" && o.g2 === "ok" && o.t === "ok" && o.flying === "ball" && o.carrier.agree >= 1 && !o.carrier.disagree },
  { id: "M2", what: "…and a dynamic crate with no physics.who is anyone's (R 10-07: visitors grab and throw by default): a visitor may", run(s) { cast(s);
      s.call("olive", "create", { id: "crate", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.6] }); s.call("bob", "move", { to: [0.4, 0, 0.6] });
      return { vic: show(s.call("vic", "grab", { id: "crate" })) }; },
    good: (o) => o.vic === "ok" },
  { id: "M3", what: "…and the latest grab wins (taken from a holder, who is told)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [0.4, 0, 0.5] });
      s.call("vic", "grab", { id: "ball" }); const a = s.call("ann", "grab", { id: "ball" });
      return { a: show(a), by: held(s, "ball")?.by, taken: a.notes?.some((n: any) => n.takenFrom === "vic") }; },
    good: (o) => o.a === "ok" && o.by === "ann" && o.taken },

  // ---------------- G: the gate ----------------
  { id: "G1", what: "grabbable is a component the authority knows: its own entry in schema, its shape checked", run(s) { cast(s);
      const sch = s.call("olive", "schema", { component: "grabbable" }).components?.grabbable;
      return { help: sch?.help ?? null, on: sch?.on }; },
    good: (o) => /carryable/.test(o.help ?? "") && o.on === "thing" },
  { id: "G2", what: "a thing with grabbable and no physics (a lantern) is picked up, carried and put down in a world with no physics", run(s) { cast(s);
      s.call("olive", "create", { id: "lantern", model: "table-lamp", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const g = s.call("vic", "grab", { id: "lantern" }); const w1 = s.call("vic", "move", { to: [0, 0, 2.5] }, 1000);
      const p = s.call("vic", "put", { id: "lantern" });
      return { g: show(g), carrying: w1.carrying, p: show(p), at: tf(s, "lantern")?.pos, held: held(s, "lantern") }; },
    good: (o) => o.g === "ok" && o.carrying?.includes("lantern") && o.p === "ok" && Math.abs(o.at[2] - 2.5) < 1e-6 && o.at[1] === 0 && o.held === null },
  // R 10-17 20:54 (the gym): "Any reason why the crates always spin around to orient the same way no matter how I put them
  // down?" A carried thing turns with its holder (every client draws it so); a put lands it as carried. The facing is the
  // relayed pose's yaw (w.present, as server/world.ts gives it); qYaw of the landed rotation is the turn about up.
  { id: "Y1", what: "a put lands a carried thing turned by as far as its holder turned while carrying it (yaw only), not back as it was taken", run(s) { cast(s);
      const Q = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)].map((n) => +n.toFixed(6));
      s.call("olive", "create", { id: "box1", model: "book", components: { grabbable: { who: "member" }, transform: { pos: [0, 0, 0], q: Q(0.3), scale: [1, 1, 1] } } });
      let face = 0.25; s.w().present = () => [{ id: "vic", at: null, yaw: face }];
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "box1" });
      face = 0.25 + Math.PI / 2; s.call("vic", "move", { to: [0, 0, 1.5] }, 1000);   // turned a quarter left, and walked
      const p = s.call("vic", "put", { id: "box1" }); const q = tf(s, "box1")?.q;
      return { g: show(g), p: show(p), q, yaw: q ? +(2 * Math.atan2(q[1], q[3])).toFixed(4) : null, tilt: q ? +Math.hypot(q[0], q[2]).toFixed(6) : null }; },
    good: (o) => o.g === "ok" && o.p === "ok" && Math.abs(o.yaw - (0.3 + Math.PI / 2)) < 1e-3 && o.tilt < 1e-5 },
  { id: "Y2", what: "…and a drop in a world that runs physics launches it as carried (the launch's yaw), not as taken", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      let face = 0; s.w().present = () => [{ id: "vic", at: null, yaw: face }];
      s.call("vic", "move", { to: [0, 0, 0.5] }); const y0 = (() => { const q = tf(s, "ball").q; return 2 * Math.atan2(q[1], q[3]); })();
      const g = s.call("vic", "grab", { id: "ball" }); face = -1; const n0 = s.entries().length;
      const d = s.call("vic", "drop", { id: "ball" }); const L = s.entries().slice(n0).find((e: any) => e.kind === "sim" && e.verb === "launch")?.body;
      return { g: show(g), d: show(d), y0: +y0.toFixed(4), yaw: L ? +L.yaw.toFixed(4) : null }; },
    good: (o) => o.g === "ok" && o.d === "ok" && o.yaw !== null && Math.abs(o.yaw - (o.y0 - 1)) < 1e-3 },
  { id: "Y3", what: "…and taken from one hand into another, it starts as the first hand had turned it (the taker's put turns by the taker's turn only)", run(s) { cast(s);
      const faces: any = { vic: 0, ann: 2 };
      s.call("olive", "create", { id: "box1", model: "book", components: { grabbable: { who: "member", steal: true }, transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
      s.w().present = () => Object.entries(faces).map(([id, yaw]) => ({ id, at: null, yaw }));
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [0.4, 0, 0.5] });
      s.call("vic", "grab", { id: "box1" }); faces.vic = 0.5;            // vic turns half a radian with it
      const a = s.call("ann", "grab", { id: "box1" }); faces.ann = 2.25;  // ann takes it, and turns a quarter radian
      const p = s.call("ann", "put", { id: "box1" }); const q = tf(s, "box1")?.q;
      return { a: show(a), p: show(p), yaw: q ? +(2 * Math.atan2(q[1], q[3])).toFixed(4) : null }; },
    good: (o) => o.a === "ok" && o.p === "ok" && Math.abs(o.yaw - 0.75) < 1e-3 },
  { id: "Y4", what: "…and a launch refused after it turned the hold (a let-go point out of reach) leaves it turned once: the put after it isn't turned twice", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      let face = 0; s.w().present = () => [{ id: "vic", at: null, yaw: face }];
      s.call("vic", "move", { to: [0, 0, 0.5] }); const y0 = (() => { const q = tf(s, "ball").q; return 2 * Math.atan2(q[1], q[3]); })();
      s.call("vic", "grab", { id: "ball" }); face = 0.7;
      const t = s.call("vic", "throw", { id: "ball", v: [0, 1, 1], pos: [9, 1, 9] });
      const p = s.call("vic", "put", { id: "ball" }); const q = tf(s, "ball")?.q;
      return { t: code(t), p: show(p), y0: +y0.toFixed(4), yaw: q ? +(2 * Math.atan2(q[1], q[3])).toFixed(4) : null }; },
    good: (o) => o.t === "out-of-reach" && o.p === "ok" && Math.abs(o.yaw - (o.y0 + 0.7)) < 1e-3 },
  { id: "M4", what: "…and with no relayed pose to turn by (no facing known), a put lands it as it was taken, as before", run(s) { cast(s);
      const Q = (y: number) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)].map((n) => +n.toFixed(6));
      s.call("olive", "create", { id: "box1", model: "book", components: { grabbable: { who: "member" }, transform: { pos: [0, 0, 0], q: Q(0.3), scale: [1, 1, 1] } } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "box1" }); const p = s.call("vic", "put", { id: "box1" }); const q = tf(s, "box1")?.q;
      return { p: show(p), yaw: q ? +(2 * Math.atan2(q[1], q[3])).toFixed(4) : null }; },
    good: (o) => o.p === "ok" && Math.abs(o.yaw - 0.3) < 1e-3 },
  { id: "G3", what: "…and in a world that runs physics: the grab lifts it out of the engine, a drop sets it down (it isn't dynamic, so it doesn't fly), a carrier agrees", run(s) { cast(s, true);
      s.call("olive", "create", { id: "lantern", model: "table-lamp", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const n0 = s.entries().length;
      const g = s.call("vic", "grab", { id: "lantern" }); const lift = since(s, n0);
      s.call("vic", "move", { to: [0, 0, 2] }, 1000); const n1 = s.entries().length;
      const d = s.call("vic", "drop", { id: "lantern" }); const after = since(s, n1);
      return { g: show(g), lift, d: show(d), after, at: tf(s, "lantern")?.pos, launches: s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch").length, carrier: carrier(s) }; },
    good: (o) => o.g === "ok" && o.lift.includes("sim:lift") && o.d === "ok" && JSON.stringify(o.after) === '["act:put","change:set"]' && o.at[1] === 0 && o.launches === 0 && !o.carrier.disagree },
  { id: "G4", what: "a throw in a world with no physics is a drop that says so (a VR hand lets go with its velocity; it was refused and stuck in the hand)", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" });
      const t = s.call("vic", "throw", { id: "ball", v: [0, 1.5, 3], pos: [0, 1.1, 0.7] });
      return { t: show(t), note: t.notes?.find((n: any) => n.thrown)?.why ?? null, held: held(s, "ball"), at: tf(s, "ball")?.pos }; },
    good: (o) => o.t === "ok" && /doesn't run physics/.test(o.note ?? "") && o.held === null && o.at?.[1] === 0 && Math.abs(o.at[2] - 0.7) < 1e-6 },
  { id: "G5", what: "nothing to grab: a plain thing is refused not-grabbable; grabbable {enabled: false} makes a dynamic ball kick-only (punt still works)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "rock", model: "crate", place: { at: [3, 3] } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" }, grabbable: { enabled: false } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, -0.5] }); s.call("olive", "move", { to: [3, 0, 2.5] }); const plain = s.call("olive", "grab", { id: "rock" });
      return { plain: code(plain), g: show(s.call("vic", "grab", { id: "ball" })), p: show(s.call("vic", "punt", { id: "ball", power: 3 })) }; },
    good: (o) => o.plain === "not-grabbable" && o.g.startsWith("refused not-grabbable") && o.p === "ok" },
  { id: "G6", what: "who: grabbable.who wins over physics.who for the hand; a punt still asks physics.who", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "builder" }, grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "builder" } }, place: { at: [0.5, 0] } });
      s.call("vic", "move", { to: [0, 0, -0.5] });
      const punt = s.call("vic", "punt", { id: "ball", power: 3 }); const g = s.call("vic", "grab", { id: "ball" }); s.call("vic", "put", { id: "ball" });
      const k = s.call("vic", "grab", { id: "key" });
      // and the other way round: anyone may kick it, only a builder carry it. The punt's admission must read physics.who,
      // not fall through to the hand's settlement (grabbable.who): with the punt branch gone the kick is refused (F4 10-12)
      s.call("olive", "create", { id: "kickball", model: "ball", components: { physics: { kind: "dynamic", who: "member" }, grabbable: { who: "builder" } }, place: { at: [-1, 0] } });
      s.call("vic", "move", { to: [-1, 0, -0.5] });
      const kick = s.call("vic", "punt", { id: "kickball", power: 3 }); const carry = s.call("vic", "grab", { id: "kickball" });
      return { punt: code(punt), g: show(g), key: code(k), kick: show(kick), carry: code(carry) }; },
    good: (o) => o.punt === "rights" && o.g === "ok" && o.key === "rights" && o.kick === "ok" && o.carry === "rights" },
  { id: "G7", what: "steal: false: nobody takes it from a holder's hand (refused 'held'); an owner may", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member", steal: false } }, place: { at: [0, 0] } });
      for (const [p, x] of [["vic", 0], ["ann", 0.4], ["olive", -0.4]]) s.call(p, "move", { to: [x, 0, 0.5] });
      s.call("vic", "grab", { id: "flag" }); const a = s.call("ann", "grab", { id: "flag" }); const o = s.call("olive", "grab", { id: "flag" });
      return { ann: code(a), olive: show(o), by: held(s, "flag")?.by }; },
    good: (o) => o.ann === "held" && o.olive === "ok" && o.by === "olive" },
  { id: "G8", what: "range: 0.4 m means close; 4 m reaches past an arm (granted as a pull, said so)", run(s) { cast(s);
      s.call("olive", "create", { id: "near", model: "book", components: { grabbable: { who: "member", range: 0.4 } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "far", model: "book", components: { grabbable: { who: "member", range: 4 } }, place: { at: [0, 3.2] } });
      s.call("vic", "move", { to: [0, 0, 0.8] });
      const n = s.call("vic", "grab", { id: "near" }); const f = s.call("vic", "grab", { id: "far" });
      return { near: code(n), far: show(f), pulled: f.notes?.some((x: any) => x.pulled) }; },
    good: (o) => o.near === "out-of-reach" && o.far === "ok" && o.pulled },
  { id: "G9", what: "its shape is checked: an unknown key is refused with a did-you-mean; a grip without pos, a bad enum and an out-of-range throw too", run(s) { cast(s);
      s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      const set = (v: any) => s.call("olive", "set", { id: "cup", component: "grabbable", value: v });
      const typo = set({ realease: "stay" }); const grip = set({ grips: { handle: { q: [0, 0, 0, 1] } } }); const en = set({ release: "fly" }); const th = set({ throw: 9 });
      const good = set({ who: "member", grips: { handle: { pos: [0, 0.1, 0], hand: "right", grasp: "pinch" } }, fits: ["cup"], use: { down: "sip" } });
      return { typo: code(typo), dym: typo.refused?.didYouMean, grip: code(grip), en: code(en), th: code(th), good: show(good) }; },
    good: (o) => o.typo === "schema" && o.dym?.[0] === "release" && o.grip === "shape" && o.en === "shape" && o.th === "bounds" && o.good === "ok" },
  // ---------------- R: release modes (slice 2) ----------------
  { id: "R1", what: "throw: grabbable.throw scales the launch velocity (said in a note); throw: 0 lets go instead (a drop: it falls)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "dart", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", throw: 2 } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "anvil", model: "ball", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", throw: 0 } }, place: { at: [0.4, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "dart" });
      const t = s.call("vic", "throw", { id: "dart", v: [0, 1, 1.5] }); const L = s.entries().filter((e: any) => e.kind === "sim" && e.verb === "launch").at(-1);
      const act = s.entries().filter((e: any) => e.kind === "act" && e.verb === "throw").at(-1);
      s.call("vic", "wait", {}, 8000); s.call("vic", "grab", { id: "anvil" }); const n0 = s.entries().length;
      const t0 = s.call("vic", "throw", { id: "anvil", v: [0, 1, 3] });
      return { t: show(t), v: L?.body?.v, sent: act?.body?.request?.v, note: t.notes?.some((n: any) => /grabbable\.throw/.test(n.why)), t0: show(t0), after: since(s, n0), v0: s.entries().at(-1)?.body?.v, why: t0.notes?.find((n: any) => n.thrown)?.why, carrier: carrier(s) }; },
    good: (o) => o.t === "ok" && JSON.stringify(o.v) === "[0,2,3]" && JSON.stringify(o.sent) === "[0,1,1.5]" && o.note && o.t0 === "ok" && JSON.stringify(o.after) === '["act:drop","sim:launch"]' && JSON.stringify(o.v0) === "[0,0,0]" && /can't be thrown/.test(o.why ?? "") && !o.carrier.disagree },
  { id: "R2", what: "release: stay hangs where the hand lets go: a put with no pos isn't set down, a floating put isn't refused; a plain thing still is", run(s) { cast(s);
      s.call("olive", "create", { id: "balloon", model: "ball", components: { grabbable: { who: "member", release: "stay" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "rock", model: "ball", components: { grabbable: { who: "member" } }, place: { at: [0.4, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      s.call("vic", "grab", { id: "balloon" }); const p = s.call("vic", "put", { id: "balloon" }); const at1 = tf(s, "balloon").pos;
      s.call("vic", "grab", { id: "balloon" }); const p2 = s.call("vic", "put", { id: "balloon", pos: [0, 0.8, 1] });
      s.call("vic", "grab", { id: "rock" }); const r = s.call("vic", "put", { id: "rock", pos: [0.4, 0.8, 1] });
      return { p: show(p), at1, p2: show(p2), at2: tf(s, "balloon").pos, rock: code(r) }; },
    good: (o) => o.p === "ok" && o.at1[1] === 1.1 && o.p2 === "ok" && o.at2[1] === 0.8 && o.rock === "implausible" },
  { id: "R3", what: "release: return: let go, it goes home at once (the holder's act, then the authority's return-home caused by it); its home was stamped at create", run(s) { cast(s, true);
      const c = s.call("olive", "create", { id: "torch", model: "table-lamp", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { at: [0, 0] } });
      const home = comp(s, "torch", "home");   // the one home (shape audit 10-16: grabbable.home is gone)
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "torch" }); s.call("vic", "move", { to: [0, 0, 3] }, 1000);
      const n0 = s.entries().length; const d = s.call("vic", "drop", { id: "torch" }); const L = s.entries(); const after = since(s, n0);
      const ret = L.slice(n0).find((e: any) => e.kind === "act" && e.verb === "return-home");
      const at = tf(s, "torch").pos; s.call("vic", "move", { to: [0, 0, 0.5] }, 1000); s.call("vic", "grab", { id: "torch" }); const n1 = s.entries().length;
      const t = s.call("vic", "throw", { id: "torch", v: [0, 2, 3] });
      return { home, stampNote: c.notes?.some((n: any) => n.component === "home"), d: show(d), after, cause: ret ? L[ret.cause]?.verb : null, at, held: held(s, "torch"), t: show(t), thrown: since(s, n1), carrier: carrier(s) }; },
    good: (o) => JSON.stringify(o.home?.pos) === "[0,0,0]" && o.stampNote && o.d === "ok" && JSON.stringify(o.after) === '["act:put","act:return-home","change:set"]' && o.cause === "put" && JSON.stringify(o.at) === "[0,0,0]" && o.held === null && o.t === "ok" && JSON.stringify(o.thrown) === '["act:put","act:return-home","change:set"]' && !o.carrier.disagree },
  { id: "R4", what: "returnAfter: unheld that long after a hand moved it, the next request sends it home, once; not while held; an edit's move doesn't count", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "member", returnAfter: 30 } }, place: { at: [0, 0] } });
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
      const home2 = comp(s, "ball", "home")?.pos;
      // …and with a home set elsewhere (a builder may), the edit that left it away from home still isn't a release
      s.call("olive", "set", { id: "ball", component: "home", value: { pos: [0, 0, 0], q: [0, 0, 0, 1] } });
      s.advance(60000); const n3 = s.entries().length; s.call("vic", "look", {});
      return { early, back, first, again, whileHeld, home2, afterEdit: since(s, n3), at: tf(s, "ball").pos }; },
    good: (o) => o.early[2] > 2 && JSON.stringify(o.back) === "[0,0,0]" && JSON.stringify(o.first) === '["act:return-home","change:set"]' && !o.again.length && !o.whileHeld.length && JSON.stringify(o.home2) === "[2,0,2]" && !o.afterEdit.length && JSON.stringify(o.at) === "[2,0,2]" },
  { id: "R5", what: "fits + sockets.accepts: let go within the socket's radius, it snaps in (parent {to, socket}, the socket's pose); undo takes it back out", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "member", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("bob", "move", { to: [0.8, 0, 0.6] }); s.call("bob", "grab", { id: "key" });
      const far = s.call("bob", "drop", { id: "key", pos: [0.65, 0.8, 0.1] }); const farPar = comp(s, "key", "parent") ?? null; s.call("bob", "grab", { id: "key" }); const n0 = s.entries().length;
      const d = s.call("bob", "drop", { id: "key", pos: [0.1, 0.75, 0.05] }); const slot = slotOf(s, "key"), host = hostOf(s, "key"); const t = tf(s, "key");
      /* a builder's own put (a visitor's put is a settlement their rank can't undo) */ const u = s.call("bob", "undo", {}); const after = { parent: comp(s, "key", "parent") ?? null, pos: tf(s, "key").pos };
      return { far: show(far), farPar, d: show(d), snapped: d.notes?.some((n: any) => n.snapped), slot, host, t, act: since(s, n0), u: show(u), after }; },
    good: (o) => o.far === "ok" && o.farPar === null && o.d === "ok" && o.snapped && o.host === "rack" && o.slot === "hook" && JSON.stringify(o.t.pos) === "[0,0,0]" && o.u === "ok" && o.after.parent === null && JSON.stringify(o.after.pos) === "[0.65,0,0.1]" },
  { id: "R5s", what: "a socket child: a key let go within its radius snaps in with parent {to: <the socket>} and an identity transform; settled says in: <the socket>", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "rack-hook", components: { parent: { to: "rack" }, transform: { pos: [0, 0.8, 0], q: [0, 0.7071068, 0, 0.7071068] }, socket: { name: "hook", accepts: ["key"], radius: 0.3 } } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "member", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("bob", "move", { to: [0.8, 0, 0.6] }); s.call("bob", "grab", { id: "key" });
      const far = s.call("bob", "drop", { id: "key", pos: [0.65, 0.8, 0.1] }); const farPar = comp(s, "key", "parent") ?? null; s.call("bob", "grab", { id: "key" });
      const d = s.call("bob", "drop", { id: "key", pos: [0.1, 0.75, 0.05] });
      const W = s.w().state(); const wp = SL.worldPose(W, "key");
      return { far: show(far), farPar, d: show(d), settled: d.settled, par: comp(s, "key", "parent"), t: tf(s, "key"), at: wp?.pos, snapped: d.notes?.find((n: any) => n.snapped)?.snapped }; },
    good: (o) => o.far === "ok" && o.farPar === null && o.d === "ok" && o.par?.to === "rack-hook" && !("socket" in (o.par ?? {})) && JSON.stringify(o.t.pos) === "[0,0,0]" && JSON.stringify(o.t.q) === "[0,0,0,1]" && o.settled?.in === "rack-hook" && !("socket" in (o.settled ?? {}))
      && o.snapped?.to === "rack-hook" && Math.abs(o.at[1] - 0.8) < 1e-9 && Math.abs(o.at[0]) < 1e-9 },
  { id: "R6", what: "…an occupied socket, one on a locked thing and a key that doesn't fit are passed over (it's set down, and the reply says why)", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "safe", model: "crate", components: { lock: true, sockets: { slot: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [3, 0] } });
      for (const [id, x, fits] of [["k1", 1, ["key"]], ["k2", 1.2, ["key"]], ["coin", 1.4, ["coin"]], ["k3", 2.2, ["key"]]]) s.call("olive", "create", { id, model: "book", components: { grabbable: { who: "member", fits } }, place: { at: [x, 0] } });
      s.call("vic", "move", { to: [0.8, 0, 0.6] });
      const go = (id: string, pos: number[]) => { s.call("vic", "grab", { id }); return s.call("vic", "drop", { id, pos }); };
      const c = go("coin", [-0.2, 0.8, -0.15]); const a = go("k1", [0, 0.8, 0.1]); const b = go("k2", [0, 0.8, 0.1]);   // the coin first: the hook is free when it doesn't fit
      s.call("vic", "move", { to: [2.4, 0, 0.6] }, 1000); const d = go("k3", [3, 0.8, 0.1]);
      return { a: slotOf(s, "k1"), b: [show(b), comp(s, "k2", "parent") ?? null, b.notes?.find((n: any) => n.passedOver)?.why], c: [show(c), comp(s, "coin", "parent") ?? null], d: [show(d), comp(s, "k3", "parent") ?? null, d.notes?.find((n: any) => n.passedOver)?.why] }; },
    good: (o) => o.a === "hook" && o.b[0] === "ok" && o.b[1] === null && /already sits/.test(o.b[2] ?? "") && o.c[0] === "ok" && o.c[1] === null && o.d[0] === "ok" && o.d[1] === null && /locked/.test(o.d[2] ?? "") },
  { id: "R7", what: "taken back out of its socket, it's an ordinary grab, and the put that follows deletes the parent", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"] } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "member", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("vic", "move", { to: [0.5, 0, 0.6] }); s.call("vic", "grab", { id: "key" }); s.call("vic", "drop", { id: "key", pos: [0, 0.8, 0.05] });
      const inIt = slotOf(s, "key"); const g = s.call("vic", "grab", { id: "key" }); s.call("vic", "move", { to: [0.5, 0, 2] }, 1000); const p = s.call("vic", "put", { id: "key" });
      return { inIt, g: show(g), p: show(p), parent: comp(s, "key", "parent") ?? null }; },
    good: (o) => o.inIt === "hook" && o.g === "ok" && o.p === "ok" && o.parent === null },
  { id: "R9", what: "in a world that runs physics, a dynamic key dropped near its hook snaps in (no flight); dropped away from it, it falls (a launch)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", fits: ["key"] } }, place: { at: [1, 0] } });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); s.call("vic", "grab", { id: "key" }); const n0 = s.entries().length;
      const d = s.call("vic", "drop", { id: "key", pos: [0.1, 0.8, 0.1] }); const near = since(s, n0); const par = slotOf(s, "key");
      s.call("vic", "grab", { id: "key" }); const n1 = s.entries().length; const f = s.call("vic", "drop", { id: "key", pos: [0.9, 1, 0.9] }); s.call("vic", "wait", {}, 6000);
      return { d: show(d), near, par, f: show(f), far: since(s, n1).slice(0, 2), carrier: carrier(s) }; },
    good: (o) => o.d === "ok" && JSON.stringify(o.near) === '["act:put","change:batch"]' && o.par === "hook" && o.f === "ok" && JSON.stringify(o.far) === '["act:drop","sim:launch"]' && !o.carrier.disagree },
  { id: "R8", what: "sockets.accepts/radius are checked: radius 5 and an empty accepts are refused", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", place: { at: [0, 0] } });
      const a = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: ["key"], radius: 5 } } });
      const b = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: [] } } });
      const c = s.call("olive", "set", { id: "rack", component: "sockets", value: { hook: { pos: [0, 1, 0], accepts: ["key"], radius: 0.2 } } });
      return { a: code(a), b: code(b), c: show(c) }; },
    good: (o) => o.a === "shape" && o.b === "shape" && o.c === "ok" },
  // ---------------- H: the hold record (slice 3) ----------------
  { id: "H1", what: "the hold record says which hand (default right; grab {hand: 'left'}); holdWire is what every client is told", run(s) { cast(s);
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "mug", model: "book", components: { grabbable: { who: "member" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const a = s.call("vic", "grab", { id: "cup" }); const b = s.call("vic", "grab", { id: "mug", hand: "left" }); const bad = s.call("vic", "grab", { id: "cup", hand: "up" });
      return { a: a.hand, b: b.hand, rec: G.holdWire?.(held(s, "mug")), bad: code(bad), logged: s.entries().filter((e: any) => e.kind === "act" && e.verb === "grab" && !e.body?.refused).length }; },
    good: (o) => o.a === "right" && o.b === "left" && JSON.stringify(o.rec) === '{"by":"vic","hand":"left"}' && o.bad === "shape" && o.logged === 0 },
  { id: "H2", what: "grips: a hand takes the first grip that suits it; a named grip must exist (did you mean) and suit the hand; a thing with none has no grip to name", run(s) { cast(s);
      s.call("olive", "create", { id: "sword", model: "book", components: { grabbable: { who: "member", grips: { hilt: { pos: [0, 0.05, 0], hand: "right", grasp: "fist" }, offhand: { pos: [0, 0.15, 0], hand: "left" } } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "member" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const r = s.call("vic", "grab", { id: "sword" }); s.call("vic", "put", { id: "sword" });
      const l = s.call("vic", "grab", { id: "sword", hand: "left" }); s.call("vic", "put", { id: "sword" });
      const typo = s.call("vic", "grab", { id: "sword", grip: "hlt" }); const wrong = s.call("vic", "grab", { id: "sword", grip: "hilt", hand: "left" });
      const named = s.call("vic", "grab", { id: "sword", grip: "offhand" }); s.call("vic", "put", { id: "sword" });
      const none = s.call("vic", "grab", { id: "cup", grip: "hilt" });
      return { r: [r.hand, r.grip], l: [l.hand, l.grip], typo: [code(typo), typo.refused?.didYouMean], wrong: code(wrong), named: [named.hand, named.grip], none: code(none) }; },
    good: (o) => JSON.stringify(o.r) === '["right","hilt"]' && JSON.stringify(o.l) === '["left","offhand"]' && o.typo[0] === "no-grip" && o.typo[1]?.[0] === "hilt" && o.wrong === "wrong-hand" && JSON.stringify(o.named) === '["left","offhand"]' && o.none === "no-grip" },
  { id: "H3", what: "offset: with no grips, a hand sends where it took hold and the record keeps it; with grips the grip wins; a malformed one is refused", run(s) { cast(s);
      s.call("olive", "create", { id: "rock", model: "book", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "axe", model: "book", components: { grabbable: { who: "member", grips: { haft: { pos: [0, 0.1, 0] } } } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] });
      const OFF = { pos: [0.01, -0.02, 0.05], q: [0, 0, 0, 1] };
      const bad = s.call("vic", "grab", { id: "rock", offset: { pos: [0, 0, 9], q: [0, 0, 0, 1] } });
      const a = s.call("vic", "grab", { id: "rock", offset: OFF }); const b = s.call("vic", "grab", { id: "axe", hand: "left", offset: OFF });
      return { bad: code(bad), a: a.offset, rec: held(s, "rock")?.offset, b: [b.grip, b.offset ?? null] }; },
    good: (o) => o.bad === "shape" && JSON.stringify(o.a?.pos) === "[0.01,-0.02,0.05]" && JSON.stringify(o.rec?.q) === "[0,0,0,1]" && o.b[0] === "haft" && o.b[1] === null },
  { id: "H4", what: "a second hand: twoHanded takes it in both (secondary grip); one hand letting go leaves it in the other; not twoHanded, the other hand swaps", run(s) { cast(s);
      s.call("olive", "create", { id: "rifle", model: "book", components: { grabbable: { who: "member", twoHanded: true, grips: { stock: { pos: [0, 0, 0], hand: "right" }, fore: { pos: [0, 0.15, 0], role: "secondary" } } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { grabbable: { who: "member" } }, place: { at: [0.3, 0] } });
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
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "balloon", model: "ball", components: { grabbable: { who: "member", release: "stay" } }, place: { at: [0.3, 0] } });
      s.call("olive", "create", { id: "torch", model: "book", components: { grabbable: { who: "member", release: "return" } }, place: { at: [-0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); for (const id of ["ball", "balloon", "torch"]) s.call("vic", "grab", { id }); s.call("vic", "move", { to: [0, 0, 2] }, 1000);
      const w2 = s.reopen(s.w().presence); const n0 = s.entries().length; clock.advance(100);
      const r = D.settleOrphans?.(w2, []);
      return { r: r?.length, holds: Object.keys(w2.presence.holds), body: !!w2.presence.bodies.vic, after: since(s, n0), by: s.entries().slice(n0).filter((e: any) => e.kind === "act").map((e: any) => e.actor),
        ball: tf(s, "ball").pos, balloon: tf(s, "balloon").pos, torch: tf(s, "torch").pos }; },
    good: (o) => o.r >= 1 && !o.holds.length && !o.body && o.by.includes("vic") && o.ball[1] === 0 && Math.abs(o.ball[2] - 2) < 1e-6 && o.balloon[1] === 1.1 && JSON.stringify(o.torch) === "[-0.3,0,0]" },
  { id: "O2", what: "presence kept in memory: in a physics world the log's lift is settled at load (door return-held, cause the lift; a return goes home), once, and a carrier agrees", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "torch", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { at: [0.3, 0] } });
      s.call("olive", "create", { id: "kept", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [-0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [-0.3, 0, 0.5] });
      s.call("vic", "grab", { id: "ball" }); s.call("vic", "grab", { id: "torch" }); s.call("ann", "grab", { id: "kept" }); s.call("vic", "move", { to: [0, 0, 2] }, 1000);
      const annHold = s.w().presence.holds.kept;
      const w2 = s.reopen({ bodies: {}, holds: { kept: annHold } }); const n0 = s.entries().length; clock.advance(100);
      D.settleOrphans?.(w2, ["ann"]); const L = s.entries(); const acts = L.slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.actor}:${e.verb}:${e.body?.id}:${L[e.cause]?.verb ?? "-"}`);
      const n1 = s.entries().length; D.settleOrphans?.(w2, ["ann"]);
      return { acts, again: s.entries().length - n1, kept: !!w2.presence.holds.kept, ball: tf(s, "ball").pos, carrier: carrier(s) }; },
    good: (o) => JSON.stringify(o.acts.sort()) === JSON.stringify(["system:return-held:ball:lift", "system:return-home:torch:lift"]) && o.again === 0 && o.kept && JSON.stringify(o.ball) === "[0,0,0]" && !o.carrier.disagree },
  // ---------------- RA: a log changed outside the purge rule (review of #260): the system's own sweeps still run, but
  // a thing whose value the record lost is skipped, never moved from a place or scale derived from nothing ----------------
  { id: "RA2", what: "a stripped transform: returnAfter's sweep leaves the thing where the record lost it", run(s) { cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "member", returnAfter: 30 } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("vic", "move", { to: [0, 0, 3] }, 1000); s.call("vic", "put", { id: "ball" });
      const k = stripLast(s, "ball", "transform"); const w2 = s.reopen(s.w().presence);
      s.advance(40000); const n0 = s.entries().length; D.settle?.(w2); const look = s.call("vic", "look", {});
      return { k, lost: tf(s, "ball") === F.PURGED, after: since(s, n0), look: show(look), diag: w2.state().diagnostics.some((d: any) => d[0] === k && d[1] === "commit-unpurged") }; },
    good: (o) => o.k > 0 && o.diag && o.lost && !o.after.includes("act:return-home") && o.look === "ok" },
  { id: "RA3", what: "a stripped transform: settling an orphaned lift at load leaves the thing where the record lost it", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "torch", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("vic", "grab", { id: "torch" }); s.call("vic", "move", { to: [0, 0, 2] }, 1000);
      const kb = stripLast(s, "ball", "transform"), kt = stripLast(s, "torch", "transform");
      const w2 = s.reopen({ bodies: {}, holds: {} }); const n0 = s.entries().length; clock.advance(100);
      D.settleOrphans?.(w2, []); const L = s.entries(); const acts = L.slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      return { kb, kt, acts, ball: tf(s, "ball") === F.PURGED, torch: tf(s, "torch") === F.PURGED }; },
    good: (o) => o.kb > 0 && o.kt > 0 && !o.acts.length && o.ball && o.torch },
  { id: "RA4", what: "a stripped transform on a parent: the engine gives its child no body (its world pose would compose from nothing)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "shelf", model: "table", place: { at: [2, 2] } });
      s.call("olive", "create", { id: "box", model: "crate", components: { physics: { kind: "dynamic" } }, place: { at: [-2, -2] } });
      s.call("olive", "set", { id: "box", component: "parent", value: { to: "shelf" } });
      const before = !!SL.engineViewM(s.w().state()).entities.box;
      const k = stripLast(s, "shelf", "transform"); const w2 = s.reopen(s.w().presence); const v = SL.engineViewM(w2.state()).entities;
      return { k, before, shelf: !!v.shelf, box: !!v.box }; },
    good: (o) => o.k > 0 && o.before && !o.shelf && !o.box },
  { id: "O3", what: "a hold that ended when the thing it hangs from was switched off isn't settled again at load: no return for it after a restart", run(s) { cast(s, true);
      s.call("olive", "create", { id: "tray", model: "table", place: { at: [0, 1] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { parent: { to: "tray" }, physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { on: "tray" } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "cup" });
      const off = s.call("olive", "set", { id: "tray", component: "disabled", value: true }); const ended = !s.w().presence.holds.cup;
      const on = s.call("olive", "set", { id: "tray", component: "disabled", value: false });
      const w2 = s.reopen({ bodies: {}, holds: {} }); const n0 = s.entries().length; clock.advance(100);
      const lift = s.entries().some((e: any) => e.kind === "sim" && e.verb === "lift" && e.body?.id === "cup");
      D.settleOrphans(w2, []); const acts = s.entries().slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      return { g: show(g), off: show(off), on: show(on), ended, lift, acts }; },
    good: (o) => o.g === "ok" && o.off === "ok" && o.on === "ok" && o.ended && o.lift && !o.acts.length },
  { id: "O3b", what: "…and so does one ended when a thing it came to hang from later, through a batch that re-hangs its holder's tray, was switched off", run(s) { cast(s, true);
      s.call("olive", "create", { id: "shelf", model: "table", place: { at: [3, 1] } });
      s.call("olive", "create", { id: "tray", model: "table", place: { at: [0, 1] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { parent: { to: "tray" }, physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { on: "tray" } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "cup" });
      // one batch: the tray comes to hang from the shelf, and the shelf is switched off (read after the whole entry)
      const b = s.call("olive", "batch", { ops: [{ verb: "set", args: { id: "tray", component: "parent", value: { to: "shelf" } } }, { verb: "set", args: { id: "shelf", component: "disabled", value: true } }] });
      const ended = !s.w().presence.holds.cup; const on = s.call("olive", "set", { id: "shelf", component: "disabled", value: false });
      const w2 = s.reopen({ bodies: {}, holds: {} }); const n0 = s.entries().length; clock.advance(100);
      const lift = s.entries().some((e: any) => e.kind === "sim" && e.verb === "lift" && e.body?.id === "cup");
      D.settleOrphans(w2, []); const acts = s.entries().slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      return { g: show(g), b: show(b), on: show(on), ended, lift, acts }; },
    good: (o) => o.g === "ok" && o.b === "ok" && o.on === "ok" && o.ended && o.lift && !o.acts.length },
  { id: "O3c", what: "…whichever order the batch writes them in: the shelf switched off first, then the tray re-hung under it", run(s) { cast(s, true);
      s.call("olive", "create", { id: "shelf", model: "table", place: { at: [3, 1] } });
      s.call("olive", "create", { id: "tray", model: "table", place: { at: [0, 1] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { parent: { to: "tray" }, physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { on: "tray" } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "cup" });
      const b = s.call("olive", "batch", { ops: [{ verb: "set", args: { id: "shelf", component: "disabled", value: true } }, { verb: "set", args: { id: "tray", component: "parent", value: { to: "shelf" } } }] });
      const ended = !s.w().presence.holds.cup; const on = s.call("olive", "set", { id: "shelf", component: "disabled", value: false });
      const w2 = s.reopen({ bodies: {}, holds: {} }); const n0 = s.entries().length; clock.advance(100);
      const lift = s.entries().some((e: any) => e.kind === "sim" && e.verb === "lift" && e.body?.id === "cup");
      D.settleOrphans(w2, []); const acts = s.entries().slice(n0).filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      return { g: show(g), b: show(b), on: show(on), ended, lift, acts }; },
    good: (o) => o.g === "ok" && o.b === "ok" && o.on === "ok" && o.ended && o.lift && !o.acts.length },
  { id: "O3d", what: "…while a hold the log hasn't ended is settled at load: the returning cup goes home, and its change ends the lift, so the next load settles nothing", run(s) { cast(s, true);
      s.call("olive", "create", { id: "tray", model: "table", place: { at: [0, 1] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { parent: { to: "tray" }, physics: { kind: "dynamic" }, grabbable: { who: "member", release: "return" } }, place: { on: "tray" } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "cup" });
      const w2 = s.reopen({ bodies: {}, holds: {} }); const n0 = s.entries().length; clock.advance(100);
      const lift = s.entries().some((e: any) => e.kind === "sim" && e.verb === "lift" && e.body?.id === "cup");
      D.settleOrphans(w2, []); const after = s.entries().slice(n0), acts = after.filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      // the settlement's change ends the lift on the record: it writes where the cup is, so a second load settles nothing
      const ends = after.some((e: any) => e.kind === "change" && (e.verb === "batch" ? e.body?.ops ?? [] : [e.body]).some((o: any) => o?.id === "cup" && (o.comp === "transform" || o.comp === "parent")));
      const w3 = s.reopen({ bodies: {}, holds: {} }); const n1 = s.entries().length; clock.advance(100);
      D.settleOrphans(w3, []); const again = s.entries().slice(n1).filter((e: any) => e.kind === "act").map((e: any) => `${e.verb}:${e.body?.id}`);
      return { g: show(g), lift, acts, ends, again }; },
    good: (o) => o.g === "ok" && o.lift && o.acts.includes("return-home:cup") && o.ends && !o.again.length },
  { id: "O5", what: "a hold a world's load settles is a release its watching scripts hear (review 1.10): the orphan's return-held says how: return, caused by that act", run(s) { cast(s, true);
      s.call("olive", "create", { id: "flag", model: "book", components: { physics: { kind: "dynamic" }, grabbable: { who: "member" } }, place: { at: [1, 0] } });
      const h = install(s, "olive", "flag", "hear", `world.on("release", (e) => world.set("self", "t/how", e.how));\n`, { scope: { ids: "self", comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); const g = s.call("vic", "grab", { id: "flag" });
      const w2 = s.reopen({ bodies: {}, holds: {} }); clock.advance(100); D.settleOrphans(w2, []);
      const ran = s.entries().filter((e: any) => e.kind === "act" && e.verb === "script" && e.body?.on === "release"), back = s.entries().findLastIndex((e: any) => e.kind === "act" && e.verb === "return-held");
      return { h: show(h), g: show(g), how: comp(s, "flag", "t/how") ?? null, cause: ran.at(-1)?.cause ?? null, back }; },
    good: (o) => o.h === "ok" && o.g === "ok" && o.how === "return" && o.back > 0 && o.cause === o.back },
  { id: "O5b", what: "…and a hold that just ends at load (past the holders' cap) is heard as how: drop", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member" } }, place: { at: [1, 0] } });
      const h = install(s, "olive", "flag", "hear", `world.on("release", (e) => world.set("self", "t/how", e.how));\n`, { scope: { ids: "self", comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); const g = s.call("vic", "grab", { id: "flag" });
      const P = JSON.parse(JSON.stringify(s.w().presence)), mine = P.holds.flag;
      P.holds = { ...Object.fromEntries(Array.from({ length: D.ORPHANS.holders }, (_, i) => [`gone${i}`, { ...mine, by: `h${i}` }])), flag: mine };   // vic is the 17th holder
      const w2 = s.reopen(P); clock.advance(100); const r = D.settleOrphans(w2, []);
      return { h: show(h), g: show(g), deferred: r.some((x: any) => x.deferred === 1), held: w2.presence.holds.flag ?? null, how: comp(s, "flag", "t/how") ?? null }; },
    good: (o) => o.h === "ok" && o.g === "ok" && o.deferred && o.held === null && o.how === "drop" },
  // ---------------- U: use while held, and the grab / release events (slice 5) ----------------
  { id: "U1", what: "use while held: the holder's use with no action fires grabbable.use's down, with phase up its up (each one act, the act saying held/hand/phase); held: true from someone not holding is refused", run(s) { cast(s);
      s.call("olive", "create", { id: "torch", model: "table-lamp", components: { grabbable: { who: "member", use: { down: "on", up: "off" } },
        reactions: { on: { kind: "set", component: "t/burning", value: true }, off: { kind: "set", component: "t/burning", value: false }, poke: { kind: "set", component: "t/poked", value: true } } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [0.4, 0, 0.5] });
      const before = s.call("vic", "use", { id: "torch" }); const litBefore = comp(s, "torch", "t/burning") ?? null;   // not holding: several actions → it asks which (Commons audit CP3), nothing fires
      s.call("olive", "set", { id: "torch", component: "t/burning", value: false });
      s.call("vic", "grab", { id: "torch" }); const n0 = s.entries().length;
      const d = s.call("vic", "use", { id: "torch", args: { phase: "down" } }); const lit1 = comp(s, "torch", "t/burning");
      const actD = s.entries().slice(n0).find((e: any) => e.kind === "act" && e.verb === "use");
      const u = s.call("vic", "use", { id: "torch", args: { phase: "up" } }); const lit2 = comp(s, "torch", "t/burning");
      const named = s.call("vic", "use", { id: "torch", action: "poke" });
      const thief = s.call("ann", "use", { id: "torch", args: { held: true } });
      return { before: show(before), litBefore, d: show(d), lit1, held: actD?.body?.held, action: actD?.body?.action, sent: actD?.body?.request, u: show(u), lit2, named: [show(named), comp(s, "torch", "t/poked")], thief: code(thief) }; },
    good: (o) => /^refused no-action: torch offers \d+ things to do/.test(o.before) && o.litBefore === null && o.d === "ok" && o.lit1 === true && JSON.stringify(o.held) === '{"held":true,"hand":"right","phase":"down"}' && o.action === "on" && JSON.stringify(o.sent) === '{"id":"torch","args":{"phase":"down"}}'
      && o.u === "ok" && o.lit2 === false && o.named[0] === "ok" && o.named[1] === true && o.thief === "not-holding" },
  { id: "U2", what: "…a script reached by that use hears held, hand and phase (and its act records them: an auditor re-runs it)", run(s) { cast(s);
      s.call("olive", "create", { id: "hose", model: "table-lamp", components: { grabbable: { who: "member", use: { down: "spray", up: "spray" } } }, place: { at: [0, 0] } });
      const r = install(s, "olive", "hose", "spray", `world.on("use", (e) => world.set("self", "t/flow", { on: e.phase === "down", hand: e.hand, held: e.held }));\n`, { scope: { ids: "self", comps: ["t/flow"] }, on: ["use"] });
      s.call("olive", "set", { id: "hose", component: "reactions", value: { spray: { kind: "script", script: "spray" } } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "hose", hand: "left" });
      const d = s.call("vic", "use", { id: "hose", args: { phase: "down" } }); const f1 = comp(s, "hose", "t/flow");
      const u = s.call("vic", "use", { id: "hose", args: { phase: "up" } }); const f2 = comp(s, "hose", "t/flow");
      const sact = s.entries().filter((e: any) => e.kind === "act" && e.verb === "script").at(-1);
      return { r: show(r), d: d.script?.status, f1, u: u.script?.status, f2, ev: sact?.body?.event }; },
    good: (o) => o.r === "ok" && o.d === "ran" && JSON.stringify(o.f1) === '{"on":true,"hand":"left","held":true}' && o.u === "ran" && o.f2?.on === false && o.ev?.phase === "up" && o.ev?.hand === "left" },
  { id: "U3", what: "grab and release are script events: a script whose scope covers the thing hears who took it (hand) and how it was let go (drop, snap with its socket); a script that doesn't cover it hears nothing", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["flag"], radius: 0.3 } } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member", fits: ["flag"] } }, place: { at: [1, 0] } });
      s.call("olive", "create", { id: "bystander", model: "book", place: { at: [3, 3] } });
      const LOG = `world.on("grab", (e) => world.set("self", "t/log", [...(world.get("self", "t/log") ?? []), "grab " + e.by + " " + e.hand]));\nworld.on("release", (e) => world.set("self", "t/log", [...(world.get("self", "t/log") ?? []), "release " + e.how + (e.socket ? " " + e.to + "/" + e.socket : "")]));\n`;
      const r1 = install(s, "olive", "flag", "watch", LOG, { scope: { ids: "self", comps: ["t/log"] }, on: ["grab", "release"] });
      const r2 = install(s, "olive", "bystander", "watch", LOG, { scope: { ids: "self", comps: ["t/log"] }, on: ["grab", "release"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] });
      s.call("vic", "grab", { id: "flag" }); s.call("vic", "drop", { id: "flag", pos: [0.9, 1, 0.6] });
      s.call("vic", "grab", { id: "flag", hand: "left" }); s.call("vic", "drop", { id: "flag", pos: [0.05, 0.8, 0.05] });
      const acts = s.entries().filter((e: any) => e.kind === "act" && e.actor === "script:flag").map((e: any) => [e.body.on, s.entries()[e.cause]?.verb ?? s.entries()[e.cause]?.kind]);
      return { r: [show(r1), show(r2)], log: comp(s, "flag", "t/log"), bystander: comp(s, "bystander", "t/log") ?? null, acts }; },
    good: (o) => o.r.every((x: string) => x === "ok") && JSON.stringify(o.log) === '["grab vic right","release drop","grab vic left","release snap rack/hook"]' && o.bystander === null
      && JSON.stringify(o.acts.map((x: any) => x[0])) === '["grab","release","grab","release"]' && o.acts[1][1] === "put" && o.acts[0][1] !== "put" },
  { id: "U4", what: "…in a physics world a throw's release says throw, caused by the throw act; install refuses an event that doesn't exist", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "board", model: "book", place: { at: [3, 3] } });   // (a thrown ball is the engine's: L6, no write touches it in flight)
      install(s, "olive", "ball", "watch", `world.on("release", (e) => world.set("board", "t/how", e.how));\n`, { scope: { ids: ["self", "board"], comps: ["t/how"] }, on: ["release"] });
      const bad = install(s, "olive", "ball", "bad", `world.on("grabbed", () => {});\n`, { scope: { ids: "self", comps: ["t/x"] }, on: ["grabbed"] });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("vic", "throw", { id: "ball", v: [0, 2, 2] });
      const sact = s.entries().filter((e: any) => e.kind === "act" && e.actor === "script:ball").at(-1);
      return { how: comp(s, "board", "t/how"), cause: s.entries()[sact?.cause]?.verb, bad: code(bad) }; },
    good: (o) => o.how === "throw" && o.cause === "throw" && o.bad === "shape" },
  { id: "U3b", what: "a hold that ends with no settlement of the holder's is a release too (review of #260): a fall out of the world says fell, caused by the fall's act, with or without physics; a leave whose drop is refused, with no engine, says left and, like a departure, records no identity", run(s) {
      const fall = (sim: boolean) => { const t = session({ scripts: SB.SANDBOX }); cast(t, sim);
        t.call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -10, -50], max: [50, 50, 50] } });
        t.call("olive", "set", { id: "@world", component: "spawn", value: { pos: [0, 0, 8] } });
        t.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 8.5] } });
        t.call("olive", "create", { id: "board", model: "book", place: { at: [3, 3] } });
        install(t, "olive", "ball", "watch", `world.on("release", (e) => world.set("board", "t/how", e.how));\n`, { scope: { ids: ["self", "board"], comps: ["t/how"] }, on: ["release"] });
        t.call("vic", "move", { to: [0, 0, 8] }); const grab = t.call("vic", "grab", { id: "ball" });
        const kz = -10 - KILL_MARGIN;
        t.call("olive", "set", { id: "@world", component: "terrain", value: { kind: "flat", height: kz - 10 } });
        for (let y = -3.5; y > kz - 4; y -= 3.5) t.call("vic", "move", { to: [0, y, 8] }, 1000);
        const back = t.call("vic", "move", { to: [0, 0, 8], teleport: true, reason: "below-bounds" }, 1000);
        const sact = t.entries().filter((e: any) => e.kind === "act" && e.actor === "script:ball").at(-1);
        return { grab: show(grab), back: show(back), how: comp(t, "board", "t/how") ?? null, cause: sact ? t.entries()[sact.cause]?.verb ?? t.entries()[sact.cause]?.kind : null, trigger: sact?.body?.trigger?.actor ?? null }; };
      const plain = fall(false), sim = fall(true);
      cast(s);
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "board", model: "book", place: { at: [3, 3] } });
      install(s, "olive", "ball", "watch", `world.on("release", (e) => world.set("board", "t/how", e.how));\n`, { scope: { ids: ["self", "board"], comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const grab = s.call("vic", "grab", { id: "ball" });
      const lock = s.call("olive", "set", { id: "ball", component: "lock", value: true });
      const left = s.call("vic", "leave", {});
      const lact = s.entries().filter((e: any) => e.kind === "act" && e.actor === "script:ball").at(-1);
      return { plain, sim, left: { grab: show(grab), lock: show(lock), leave: show(left), holds: Object.keys(s.w().presence.holds), how: comp(s, "board", "t/how") ?? null,
        trigger: lact?.body?.trigger ?? null, by: lact?.body?.event?.by ?? null } }; },
    good: (o) => o.plain.grab === "ok" && o.plain.back === "ok" && o.plain.how === "fell" && o.plain.cause === "move" && o.plain.trigger === "vic"
      && o.sim.grab === "ok" && o.sim.back === "ok" && o.sim.how === "fell" && o.sim.cause === "move" && o.sim.trigger === "vic"
      && o.left.grab === "ok" && o.left.lock === "ok" && !o.left.holds.length && o.left.how === "left" && o.left.trigger === null && o.left.by === null },
  { id: "U3c", what: "…in a world running physics, a leave whose drop is refused says left too, caused by the authority's return-held act, which names the holder, so its activation keeps the trigger and by (review of #260)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "board", model: "book", place: { at: [3, 3] } });
      install(s, "olive", "ball", "watch", `world.on("release", (e) => world.set("board", "t/how", e.how));\n`, { scope: { ids: ["self", "board"], comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const grab = s.call("vic", "grab", { id: "ball" });
      const lock = s.call("olive", "set", { id: "ball", component: "lock", value: true });
      const left = s.call("vic", "leave", {});
      const lact = s.entries().filter((e: any) => e.kind === "act" && e.actor === "script:ball").at(-1);
      const ret = s.entries().filter((e: any) => e.kind === "act" && e.verb === "return-held").map((e: any) => e.body);
      return { grab: show(grab), lock: show(lock), leave: show(left), holds: Object.keys(s.w().presence.holds), how: comp(s, "board", "t/how") ?? null,
        cause: lact ? s.entries()[lact.cause]?.verb ?? null : null, trigger: lact?.body?.trigger?.actor ?? null, by: lact?.body?.event?.by ?? null, ret }; },
    good: (o) => o.grab === "ok" && o.lock === "ok" && o.leave === "ok" && !o.holds.length && o.how === "left" && o.cause === "return-held" && o.trigger === "vic" && o.by === "vic"
      && o.ret.length === 1 && o.ret[0].holder === "vic" && o.ret[0].why === "locked" },
  { id: "U6", what: "a refused throw leaves the hold where it was: its release point isn't written before the throw is admitted", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "ball" });
      const lock = s.call("olive", "set", { id: "ball", component: "lock", value: true });
      const before = JSON.stringify(s.w().presence.holds?.ball?.pose?.pos ?? null);
      const t = s.call("vic", "throw", { id: "ball", v: [0, 2, 2], pos: [0.3, 1.2, 0.9] });
      return { g: show(g), lock: show(lock), t: code(t) ?? show(t), before, after: JSON.stringify(s.w().presence.holds?.ball?.pose?.pos ?? null) }; },
    good: (o) => o.g === "ok" && o.lock === "ok" && o.t === "locked" && o.before !== "null" && o.after === o.before },
  { id: "U7", what: "a return its plan refuses (here, its home parent now rides inside it: a loop) is told to the operator once per thing and release, not at every request", run(s) { cast(s);
      s.call("olive", "create", { id: "tbl", model: "crate", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { grabbable: { who: "member", returnAfter: 30 } }, place: { at: [1, 0] } });
      const hs = s.call("olive", "set", { id: "ball", component: "home", value: { pos: [0, 0.6, 0], q: [0, 0, 0, 1], parent: { to: "tbl" } } });
      s.call("vic", "move", { to: [1, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("vic", "move", { to: [0, 0, 3] }, 1000);
      s.call("vic", "put", { id: "ball" }); const loop = s.call("olive", "set", { id: "tbl", component: "parent", value: { to: "ball" } });
      const warns: string[] = []; const ow = console.warn; console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
      try { s.advance(40000); for (let i = 0; i < 4; i++) { s.call("vic", "look", {}); s.advance(5000); } } finally { console.warn = ow; }
      const mine = warns.filter((w) => /ball is due to go home/.test(w));
      return { hs: show(hs), loop: show(loop), n: mine.length, line: mine[0] ?? null }; },
    good: (o) => o.hs === "ok" && o.loop === "ok" && o.n === 1 && /refused/.test(o.line ?? "") },
  { id: "U8", what: "a script that moves a thing in someone's hand takes it out of the hand, as an edit does: the authority no longer holds what the engine let go", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member" } }, place: { at: [1, 0] } });
      const r = install(s, "olive", "flag", "away", `world.on("grab", () => world.set("self", "transform", { pos: [4, 0, 4], q: [0, 0, 0, 1], scale: [1, 1, 1] }));\n`, { scope: { ids: "self", comps: ["transform"] }, on: ["grab"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); const g = s.call("vic", "grab", { id: "flag" });
      const moved = s.entries().some((e: any) => e.kind === "change" && e.actor === "script:flag" && e.body?.comp === "transform");
      const drop = s.call("vic", "drop", { id: "flag", pos: [0.9, 1, 0.6] });
      return { r: show(r), g: show(g), moved, held: s.w().presence.holds?.flag ?? null, pos: s.w().state().entities.flag?.c.transform?.pos, drop: show(drop) }; },
    good: (o) => o.r === "ok" && o.g === "ok" && o.moved && o.held === null && JSON.stringify(o.pos) === "[4,0,4]" && /^refused /.test(o.drop) },
  { id: "U8b", what: "…and so does a timer script's move, whose release the thing's scripts hear (how: edited), as they hear a request's", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member" } }, place: { at: [1, 0] } });
      const r = install(s, "olive", "flag", "away", `world.on("tick", () => world.set("self", "transform", { pos: [4, 0, 4], q: [0, 0, 0, 1], scale: [1, 1, 1] }));\n`, { scope: { ids: "self", comps: ["transform"] }, every: 5, always: true });
      const h = install(s, "olive", "flag", "hear", `world.on("release", (e) => world.set("self", "t/how", e.how));\n`, { scope: { ids: "self", comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); const g = s.call("vic", "grab", { id: "flag" });
      const ticks: string[] = []; for (let i = 0; i < 2; i++) { s.advance(5000); for (const x of D.tick(s.w()) ?? []) ticks.push(x.status); }
      return { r: show(r), h: show(h), g: show(g), ticks, held: s.w().presence.holds?.flag ?? null, how: s.w().state().entities.flag?.c["t/how"] ?? null }; },
    good: (o) => o.r === "ok" && o.h === "ok" && o.g === "ok" && o.ticks.includes("ran") && o.held === null && o.how === "edited" },
  { id: "U8c", what: "…and so does a changed: script's move during a request (set off by another thing's change), whose release the thing's scripts hear too", run(s) { cast(s);
      s.call("olive", "create", { id: "flag", model: "book", components: { grabbable: { who: "member" } }, place: { at: [1, 0] } });
      s.call("olive", "create", { id: "sign", model: "book", place: { at: [3, 3] } });
      const r = install(s, "olive", "sign", "away", `world.on("changed:label", () => world.set("flag", "transform", { pos: [4, 0, 4], q: [0, 0, 0, 1], scale: [1, 1, 1] }));\n`, { scope: { ids: ["self", "flag"], comps: ["transform"] }, on: ["changed:label"] });
      const h = install(s, "olive", "flag", "hear", `world.on("release", (e) => world.set("self", "t/how", e.how));\n`, { scope: { ids: "self", comps: ["t/how"] }, on: ["release"] });
      s.call("vic", "move", { to: [0.8, 0, 0.6] }); const g = s.call("vic", "grab", { id: "flag" });
      const l = s.call("olive", "set", { id: "sign", component: "label", value: "go" });
      return { r: show(r), h: show(h), g: show(g), l: show(l), held: s.w().presence.holds?.flag ?? null, pos: s.w().state().entities.flag?.c.transform?.pos, how: s.w().state().entities.flag?.c["t/how"] ?? null }; },
    good: (o) => o.r === "ok" && o.h === "ok" && o.g === "ok" && o.l === "ok" && o.held === null && JSON.stringify(o.pos) === "[4,0,4]" && o.how === "edited" },
  { id: "U9", what: "a returning thing's own lock binds its put as it binds a plain one: locked while held, the put is refused, it doesn't go home, and the hand keeps it", run(s) { cast(s);
      s.call("olive", "create", { id: "torch", model: "book", components: { grabbable: { who: "member", release: "return" } }, place: { at: [0.3, 0] } });
      s.call("vic", "move", { to: [0.3, 0, 0.6] }); const g = s.call("vic", "grab", { id: "torch" });
      const lock = s.call("olive", "set", { id: "torch", component: "lock", value: true });
      const n0 = s.entries().length; const p = s.call("vic", "put", { id: "torch" });
      const home = s.entries().slice(n0).some((e: any) => e.kind === "act" && e.verb === "return-home");
      // …as a plain put of a thing locked while held is (the control)
      s.call("olive", "create", { id: "book2", model: "book", components: { grabbable: { who: "member" } }, place: { at: [-0.3, 0] } });
      s.call("vic", "grab", { id: "book2", hand: "left" }); s.call("olive", "set", { id: "book2", component: "lock", value: true });
      const plain = s.call("vic", "put", { id: "book2" });
      return { g: show(g), lock: show(lock), p: code(p) ?? show(p), home, held: s.w().presence.holds?.torch?.by ?? null, plain: code(plain) ?? show(plain) }; },
    good: (o) => o.g === "ok" && o.lock === "ok" && o.p === "locked" && !o.home && o.held === "vic" && o.plain === "locked" },
  { id: "U10", what: "a grab or punt a lock stops says who may lift that lock (review of #260, protocol core I73): an owner's lock says owners only and names its locker, and a builder's names the Builder role and up (recut B2: strength = the setter's rank)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "tome", model: "book", components: { grabbable: { who: "member" }, physics: { kind: "dynamic" } }, place: { at: [0.3, 0] } });
      s.call("olive", "set", { id: "tome", component: "lock", value: true });
      s.call("bob", "move", { to: [0.3, 0, 0.6] }); const g = s.call("bob", "grab", { id: "tome" }), p = s.call("bob", "punt", { id: "tome", power: 2 });
      s.call("bob", "create", { id: "slate", model: "book", components: { grabbable: { who: "member" } }, place: { at: [-0.3, 0] } });
      s.call("bob", "set", { id: "slate", component: "lock", value: true });
      s.call("vic", "move", { to: [-0.3, 0, 0.6] }); const v = s.call("vic", "grab", { id: "slate" });
      return { g: [code(g), g.refused?.fix], p: [code(p), p.refused?.fix], v: [code(v), v.refused?.fix] }; },
    good: (o) => o.g[0] === "locked" && /^owners only \(it was locked by .*olive.*\) can unlock it first/.test(o.g[1] ?? "") && !/builder/.test(o.g[1] ?? "")
      && o.p[0] === "locked" && /^owners only \(it was locked by .*olive.*\) can unlock it first/.test(o.p[1] ?? "")
      && o.v[0] === "locked" && /^Builder and up \(it was locked by .*bob.*\) can unlock it first/.test(o.v[1] ?? "") },
  { id: "U11", what: "a thing that goes home keeps its size: an explicit home.scale is the scale it goes home at, and without one its size in the world is kept (homeScale), not its local scale copied into another frame", run(s) { cast(s);
      // an explicit home.scale
      s.call("olive", "create", { id: "book", model: "book", components: { grabbable: { who: "member", release: "return" } }, place: { at: [0.3, 0] } });
      s.call("olive", "set", { id: "book", component: "home", value: { pos: [0.3, 0, 0], q: [0, 0, 0, 1], scale: [2, 2, 2] } });
      s.call("vic", "move", { to: [0.3, 0, 0.6] }); const g1 = s.call("vic", "grab", { id: "book" }); const p1 = s.call("vic", "put", { id: "book" });
      const sc1 = s.w().state().entities.book?.c.transform?.scale;
      // no home.scale: it hangs under a thing at twice the size (local 1, world 2), and goes home to the world root
      s.call("olive", "create", { id: "big", model: "crate", components: { transform: { pos: [3, 0, 0], q: [0, 0, 0, 1], scale: [2, 2, 2] } } });
      s.call("olive", "create", { id: "cup", model: "book", components: { parent: { to: "big" }, transform: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, grabbable: { who: "member", release: "return", range: 5 } } });
      s.call("olive", "set", { id: "cup", component: "home", value: { pos: [3, 0, 2], q: [0, 0, 0, 1] } });
      s.call("vic", "move", { to: [3, 0, 0.6] }); const g2 = s.call("vic", "grab", { id: "cup" }); const p2 = s.call("vic", "put", { id: "cup" });
      const c2 = s.w().state().entities.cup?.c;
      // no home.scale, two ancestors and a home parent of its own: local 1.5 under shelf (2) under hall (2) is 6 in the
      // world, and under a tray at 3 that's a local 2
      s.call("olive", "create", { id: "hall", model: "crate", components: { transform: { pos: [6, 0, 0], q: [0, 0, 0, 1], scale: [2, 2, 2] } } });
      s.call("olive", "create", { id: "shelf", model: "crate", components: { parent: { to: "hall" }, transform: { pos: [0, 0.5, 0], q: [0, 0, 0, 1], scale: [2, 2, 2] } } });
      s.call("olive", "create", { id: "mug", model: "book", components: { parent: { to: "shelf" }, transform: { pos: [0, 0.3, 0], q: [0, 0, 0, 1], scale: [1.5, 1.5, 1.5] }, grabbable: { who: "member", release: "return", range: 9 } } });
      s.call("olive", "create", { id: "tray", model: "crate", components: { transform: { pos: [6, 0, 3], q: [0, 0, 0, 1], scale: [3, 3, 3] } } });
      s.call("olive", "set", { id: "mug", component: "home", value: { pos: [0, 0.2, 0], q: [0, 0, 0, 1], parent: { to: "tray" } } });
      s.call("vic", "move", { to: [6, 0, 0.6] }); const g3 = s.call("vic", "grab", { id: "mug" }); const p3 = s.call("vic", "put", { id: "mug" });
      const c3 = s.w().state().entities.mug?.c;
      return { g1: show(g1), p1: show(p1), sc1, g2: show(g2), p2: show(p2), parent2: c2?.parent ?? null, sc2: c2?.transform?.scale,
        g3: show(g3), p3: show(p3), parent3: c3?.parent?.to ?? null, sc3: c3?.transform?.scale }; },
    good: (o) => o.g1 === "ok" && o.p1 === "ok" && JSON.stringify(o.sc1) === "[2,2,2]" && o.g2 === "ok" && o.p2 === "ok" && o.parent2 === null && JSON.stringify(o.sc2) === "[2,2,2]"
      && o.g3 === "ok" && o.p3 === "ok" && o.parent3 === "tray" && JSON.stringify(o.sc3) === "[2,2,2]" },
  { id: "U11b", what: "a timed return of a thing already standing at its home's pose still takes its home scale (the check that it's home compares the scale too)", run(s) { cast(s);
      s.call("olive", "create", { id: "die", model: "book", components: { grabbable: { who: "member", returnAfter: 30 } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); const g = s.call("vic", "grab", { id: "die" }); const p = s.call("vic", "put", { id: "die" });
      // its home is where it now stands (parent and all), at twice its size
      const t = tf(s, "die"), on = s.w().state().entities.die?.c.parent;
      s.call("olive", "set", { id: "die", component: "home", value: { pos: t.pos, q: t.q, ...(on ? { parent: { to: on.to } } : {}), scale: [2, 2, 2] } });
      s.advance(35000); s.call("vic", "look", {});
      const h = comp(s, "die", "home");
      return { g: show(g), p: show(p), home: h?.scale ?? null, sc: tf(s, "die").scale }; },
    good: (o) => o.g === "ok" && o.p === "ok" && JSON.stringify(o.home) === "[2,2,2]" && JSON.stringify(o.sc) === "[2,2,2]" },
  { id: "U11c", what: "a home's own scale survives the stamping of homes: a builder rescaling a thing that stands at its home, and a create at its home's pose, keep the scale the home names", run(s) { cast(s);
      s.call("olive", "create", { id: "die", model: "book", components: { grabbable: { who: "member", returnAfter: 30 } }, place: { at: [0, 0] } });
      const t = tf(s, "die"), on = s.w().state().entities.die?.c.parent;
      s.call("olive", "set", { id: "die", component: "home", value: { pos: t.pos, q: t.q, ...(on ? { parent: { to: on.to } } : {}), scale: [2, 2, 2] } });
      s.call("olive", "set", { id: "die", component: "transform", value: { pos: t.pos, q: t.q, scale: [2, 2, 2] } });
      const r = s.call("olive", "set", { id: "die", component: "transform", value: { pos: t.pos, q: t.q, scale: [3, 3, 3] } });
      const c = s.call("olive", "create", { id: "box", model: "book", components: { grabbable: { who: "member", returnAfter: 30 },
        transform: { pos: [2, 0, 2], q: [0, 0, 0, 1], scale: [1, 1, 1] }, home: { pos: [2, 0, 2], q: [0, 0, 0, 1], scale: [2, 2, 2] } } });
      return { r: show(r), rescaled: comp(s, "die", "home")?.scale ?? null, c: show(c), created: comp(s, "box", "home")?.scale ?? null }; },
    good: (o) => o.r === "ok" && JSON.stringify(o.rescaled) === "[2,2,2]" && o.c === "ok" && JSON.stringify(o.created) === "[2,2,2]" },
  { id: "U5", what: "the presence tier: a pose carries use {id, hand} while a holder presses (every receiver draws the thing's fx); a malformed use costs only that field", run(s) {
      const a = PC.sanePose({ p: [0, 0, 0], use: { id: "hose", hand: "left" } }); const b = PC.sanePose({ p: [0, 0, 0], use: { id: "hose", n: 3 } }); const c = PC.sanePose({ p: [0, 0, 0], use: "hose" });
      return { a: a?.use ?? null, b: b ? ("use" in b ? b.use : "dropped") : null, c: c ? ("use" in c ? c.use : "dropped") : null }; },
    good: (o) => JSON.stringify(o.a) === '{"id":"hose","hand":"left"}' && o.b === "dropped" && o.c === "dropped" },
  // ---------------- I: the inspector's Grabbable card (shared/editschema.js, shared/components.js) ----------------
  { id: "I1", what: "Add Component › Grabbable writes the component with its defaults spelled out from shared/grab.js (the data), and the authority takes that value as it is", run(s) { cast(s);
      const ent = { model: "book", pos: [0, 0, 0] };
      const add = ES.inspectSchema(ent, "b1").sections.add.find((a: any) => a.name === "Grabbable");
      const r = ES.addOps(ent, "b1", "Grabbable");
      s.call("olive", "create", { id: "b1", model: "book", place: { at: [0, 0] } });
      const put = r.ops[0] ? s.call("olive", r.ops[0].verb, r.ops[0].args) : null;   // the op as the panel sends it
      return { offered: !!add && !add.blocked, ops: r.ops, errors: r.errors, put: show(put), stored: comp(s, "b1", "grabbable") }; },
    good: (o) => o.offered && o.ops.length === 1 && JSON.stringify(o.ops[0].args?.value) === JSON.stringify({ enabled: true, who: "member", steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 }) && o.put === "ok" && o.stored?.who === "member" },
  { id: "I2", what: "its card edits the common fields (who, let go, fits, use down / up) into one value, and refuses what the authority would (a malformed use)", run(s) {
      const ent = { model: "book", pos: [0, 0, 0], grabbable: { who: "builder" } };
      const sch = ES.inspectSchema(ent, "b1"); const card = sch.sections.list.find((x: any) => x.type === "Grabbable");
      const ok1 = ES.editOps(ent, "b1", { "grabbable.who": "member", "grabbable.release": "stay", "grabbable.fits": "key, hook", "grabbable.use": "fire / cease", "grabbable.anim": "torch" });
      const bad = ES.editOps(ent, "b1", { "grabbable.use": "not an action!" });
      return { card: card?.fields ?? null, value: ok1.ops.find((o: any) => o.args?.component === "grabbable")?.args?.value ?? ok1.ops, errors: ok1.errors, bad: bad.errors }; },
    good: (o) => Array.isArray(o.card) && o.card.includes("grabbable.who") && o.card.includes("grabbable.release") && !o.errors.length
      && JSON.stringify(o.value) === JSON.stringify({ who: "member", release: "stay", fits: ["key", "hook"], use: { down: "fire", up: "cease" }, anim: "torch" }) && /grabbable\.use: .*names a reactions action/.test(o.bad.join(" ")) },
  { id: "I3", what: "…its JSON hatch reaches grips (and is refused, like the authority, when a grip has no pos)", run(s) {
      const ent = { model: "book", pos: [0, 0, 0], grabbable: { who: "builder" } };
      const hatch = ES.inspectSchema(ent, "b1").groups.find((g: any) => g.group === "grabbable")?.fields.find((f: any) => f.t === "json")?.commit;
      const good = ES.editOps(ent, "b1", { "comp.grabbable": JSON.stringify({ who: "member", grips: { h: { pos: [0, 0.1, 0] } } }) });
      const bad = ES.editOps(ent, "b1", { "comp.grabbable": JSON.stringify({ grips: { h: {} } }) });
      return { hatch, good: good.ops[0]?.args?.value?.grips, bad: bad.errors }; },
    good: (o) => o.hatch === "comp.grabbable" && JSON.stringify(o.good) === '{"h":{"pos":[0,0.1,0]}}' && /grips\.h\.pos/.test(o.bad.join(" ")) },
  // ---------------- A: what an agent reads ----------------
  { id: "A1", what: "look and inspect say what a hand may do with a thing (and in which hand it's held); help names the hand and grip arguments", run(s) { cast(s);
      s.call("olive", "create", { id: "lantern", model: "table-lamp", components: { grabbable: { who: "member", use: { down: "light" }, release: "return", prompt: "Take the lantern" } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [2, 2] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "lantern", hand: "left" });
      const lk = s.call("vic", "look", {}).things ?? []; const ins = s.call("vic", "inspect", { id: "lantern" }); const help = s.call("vic", "help", { verb: "grab" });
      return { lantern: lk.find((t: any) => t.id === "lantern")?.grab ?? null, ball: lk.find((t: any) => t.id === "ball")?.grab ?? null, heldIn: ins.heldIn, args: Object.keys(help.args ?? {}) }; },
    good: (o) => /^Take the lantern \(anyone may pick it up;.*use while held: light;.*goes home when let go\)$/.test(o.lantern ?? "") && /^pick up .*anyone may pick it up/.test(o.ball ?? "") && o.heldIn === "left" && ["hand", "grip", "offset"].every((k) => o.args.includes(k)) },
  // ---------------- F: the independent review's findings (each red before its fix) ----------------
  { id: "F1", what: "a put's pos is checked (shape, reach) before snapping: a far or malformed pos never snaps into a socket across the world", run(s) { cast(s);
      s.call("olive", "create", { id: "rack", model: "crate", components: { sockets: { hook: { pos: [0, 0.8, 0], accepts: ["key"], radius: 0.3 } } }, place: { at: [20, 20] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "member", fits: ["key"] } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "key" });
      const far = s.call("vic", "put", { id: "key", pos: [20, 0.8, 20] }); const bad = s.call("vic", "put", { id: "key", pos: ["x"] });
      return { far: code(far), bad: code(bad), parent: comp(s, "key", "parent") ?? null }; },
    good: (o) => o.far === "out-of-reach" && o.bad === "shape" && o.parent === null },
  { id: "F2", what: "an orphaned hold of a holder banned since is still settled at load (the hold ends; in a physics world the lift is settled too)", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" }); s.call("olive", "ban", { who: "vic" });
      const w2 = s.reopen(s.w().presence); clock.advance(100); D.settleOrphans?.(w2, []);
      const acts = s.entries().filter((e: any) => e.kind === "act" && e.actor === "system").map((e: any) => e.verb);
      return { holds: Object.keys(w2.presence.holds), acts, carrier: carrier(s) }; },
    good: (o) => !o.holds.length && o.acts.includes("return-held") && !o.carrier.disagree },
  // F5 (10-12): leave passes a banned holder (request() lets leave through), so F2 never reaches the refused-leave branch.
  // A leave IS refused for a holder the authority can't stamp (a presence file from before today's identity rule, or
  // hand-edited): that hold must still end, or it pins the thing to nobody forever.
  { id: "F2b", what: "an orphaned hold whose holder the authority refuses a leave for (not a stampable identity) still ends at load", run(s) { cast(s, true);
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "member" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "ball" });
      const pres = JSON.parse(JSON.stringify(s.w().presence)); pres.holds.ball.by = "Vic Old!"; pres.bodies["Vic Old!"] = pres.bodies.vic; delete pres.bodies.vic;
      const w2 = s.reopen(pres); clock.advance(100); const out = D.settleOrphans?.(w2, []);
      return { holds: Object.keys(w2.presence.holds), body: !!w2.presence.bodies["Vic Old!"], left: out?.find((x: any) => x.holder === "Vic Old!")?.left, carrier: carrier(s) }; },
    good: (o) => !o.holds.length && !o.body && o.left === false && !o.carrier.disagree },
  { id: "F3", what: "use.up from whoever pressed down is taken after the thing left their hand (taken by someone else): the hose turns off", run(s) { cast(s);
      s.call("olive", "create", { id: "hose", model: "table-lamp", components: { grabbable: { who: "member", use: { down: "on", up: "off" } },
        reactions: { on: { kind: "set", component: "t/burning", value: true }, off: { kind: "set", component: "t/burning", value: false } } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("ann", "move", { to: [0.3, 0, 0.5] });
      s.call("vic", "grab", { id: "hose" }); s.call("vic", "use", { id: "hose", args: { held: true, phase: "down" } }); const on = comp(s, "hose", "t/burning");
      s.call("ann", "grab", { id: "hose" }); const up = s.call("vic", "use", { id: "hose", args: { held: true, phase: "up" } });
      const again = s.call("vic", "use", { id: "hose", args: { held: true, phase: "up" } });
      return { on, up: show(up), off: comp(s, "hose", "t/burning"), again: code(again) }; },
    good: (o) => o.on === true && o.up === "ok" && o.off === false && o.again === "not-holding" },
  { id: "F9", what: "a thing that CARRIES (a tray) takes what rests over it along as its children when picked up; nothing falls (R 10-11 23:19)", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: Object.keys(ENGINES).find((k) => k.startsWith("eidosim@")) } });
      s.call("olive", "create", { id: "tray9", model: "crate", components: { grabbable: { who: "member", carries: true }, physics: { kind: "dynamic", who: "member" } }, place: { at: [4, 4] } });
      const top = s.call("olive", "lint", { id: "tray9" }); const box = top.box ?? top.bounds; const y = (box?.max?.[1] ?? 1) + 0.001;
      s.call("olive", "create", { id: "cup9", model: "book", components: { physics: { kind: "dynamic", who: "member" }, transform: { pos: [4, y, 4], q: [0, 0, 0, 1], scale: [1, 1, 1] } } });
      const before = comp(s, "cup9", "parent")?.to ?? null;
      s.call("vic", "move", { to: [4, 0, 4.6] }); const g = s.call("vic", "grab", { id: "tray9" });
      const launched = s.w().entries.filter((e) => e.kind === "sim" && e.verb === "launch" && e.body?.id === "cup9").length;
      return { before, g: show(g), carried: g.notes?.find((n) => n.carried)?.carried ?? null, parent: comp(s, "cup9", "parent")?.to ?? null, launched }; },
    good: (o) => o.before === null && o.g === "ok" && Array.isArray(o.carried) && o.carried.includes("cup9") && o.parent === "tray9" && o.launched === 0 },
  { id: "F10", what: "reach is to the nearest point of a thing's box, not its origin: standing against a big crate is in reach (R 10-11 23:27, a barrel)", run(s) { cast(s);
      s.call("olive", "create", { id: "big", model: "crate", components: { grabbable: { who: "member" }, transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [4, 4, 4] } } });
      const m = s.call("olive", "measure", { id: "big" }); const b = m.bounds; if (!b) return { measure: show(m), keys: Object.keys(m) };
      const x = b.max[0] + 0.35, cy = (b.min[1] + b.max[1]) / 2;   // 35 cm from its face; the origin is further than the hand reaches
      s.call("vic", "move", { to: [x, 0, 0] }); const g = s.call("vic", "grab", { id: "big" });
      const originDist = Math.hypot(x - 0, 1 - 0, 0);
      return { g: show(g), why: g.refused?.reason, originDist: +originDist.toFixed(2), half: +((b.max[0] - b.min[0]) / 2).toFixed(2), cy }; },
    good: (o) => o.g === "ok" && o.originDist > 1.5 },
  { id: "F4", what: "a copy of a returning thing goes home to where the copy stands, not to the original's home", run(s) { cast(s);
      s.call("olive", "create", { id: "torch", model: "book", components: { grabbable: { who: "member", release: "return" } }, place: { at: [0, 0] } });
      const c = s.call("olive", "create", { from: "torch", id: "torch-2", at: { pos: [5, 0, 5] } });
      return { c: show(c), home: comp(s, "torch-2", "home")?.pos, at: tf(s, "torch-2")?.pos }; },
    good: (o) => o.c === "ok" && JSON.stringify(o.home) === JSON.stringify(o.at) },
  { id: "F5", what: "a returning put is the holder's act under their rank NOW (demoted below grabbable.who: refused, like any put)", run(s) { cast(s);
      s.call("olive", "create", { id: "torch", model: "book", components: { grabbable: { who: "member", release: "return" } }, place: { at: [0, 0] } });
      s.call("vic", "move", { to: [0, 0, 0.5] }); s.call("vic", "grab", { id: "torch" });
      s.call("olive", "set", { id: "torch", component: "grabbable", value: { ...comp(s, "torch", "grabbable"), who: "owner" } });
      return { put: code(s.call("vic", "put", { id: "torch" })) }; },
    good: (o) => o.put === "rights" },
  { id: "F6", what: "one hand of two letting go hands it to the other without the first hand's offset; picking a thing up off what rests on it respects that thing's enabled", run(s) { cast(s);
      s.call("olive", "create", { id: "log", model: "book", components: { grabbable: { who: "member", twoHanded: true } }, place: { at: [0, 0] } });
      s.call("olive", "create", { id: "tray", model: "crate", components: { grabbable: { who: "member" } }, place: { at: [2, 0] } });
      s.call("olive", "create", { id: "cup", model: "book", components: { transform: { pos: [2, 0.6, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, grabbable: { who: "member", enabled: false } } });   // resting on it, not its child
      s.call("vic", "move", { to: [0, 0, 0.5] });
      s.call("vic", "grab", { id: "log", hand: "right", offset: { pos: [0.1, 0, 0], q: [0, 0, 0, 1] } }); s.call("vic", "grab", { id: "log", hand: "left" });
      s.call("vic", "drop", { id: "log", hand: "right" }); const rec = G.holdWire?.(held(s, "log"));
      s.call("vic", "move", { to: [1.5, 0, 0.5] }, 1000); const tray = s.call("vic", "grab", { id: "tray" });
      return { rec, tray: code(tray) }; },
    good: (o) => o.rec?.hand === "left" && !o.rec?.offset && o.tray === "rights" },
  { id: "F7", what: "the refusals' fixes work as written: following not-grabbable's and rights' suggested grabbable value lets a member pick the thing up", run(s) { cast(s);
      // the value a fix suggests, read from its words (`value: {…}` or `.who: '<role>'`)
      const valueOf = (fix: string) => { const m = /value: (\{[^}]*\})/.exec(fix ?? ""); if (m) try { return JSON.parse(m[1].replace(/'/g, '"').replace(/(\w+):/g, '"$1":')); } catch { return null; }
        const w = /\.who: '(\w+)'/.exec(fix ?? ""); return w ? { who: w[1] } : null; };
      s.call("olive", "create", { id: "rock", model: "crate", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "builder" } }, place: { at: [1, 0] } });
      s.call("vic", "move", { to: [0.5, 0, 0.5] });
      const r1 = s.call("vic", "grab", { id: "rock" }), v1 = valueOf(r1?.refused?.fix), set1 = s.call("olive", "set", { id: "rock", component: "grabbable", value: v1 });
      const g1 = s.call("vic", "grab", { id: "rock" }); s.call("vic", "put", { id: "rock" });
      const r2 = s.call("vic", "grab", { id: "key" }), v2 = valueOf(r2?.refused?.fix), set2 = s.call("olive", "set", { id: "key", component: "grabbable", value: v2 });
      const g2 = s.call("vic", "grab", { id: "key" });
      return { r1: code(r1), v1, set1: show(set1), g1: show(g1), r2: code(r2), v2, set2: show(set2), g2: show(g2) }; },
    good: (o) => o.r1 === "not-grabbable" && o.set1 === "ok" && o.g1 === "ok" && o.r2 === "rights" && o.set2 === "ok" && o.g2 === "ok" },
];

// ---------------- run ----------------
let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false;
  try { o = c.run(session({ scripts: SB.SANDBOX })); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 700)}`}`);
}
console.log(`[grab-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
