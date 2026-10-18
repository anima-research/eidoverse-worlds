// tools/protocol/r8-check.ts — review round 8 (REVIEW-holes-r8-2026-10-17, REVIEW-scars-r8-2026-10-17): the fixes the
// scars suite doesn't hold. Every row was red first.
//   bun tools/protocol/r8-check.ts                 every row
//   bun tools/protocol/r8-check.ts --only H1,R2    just those
//   bun tools/protocol/r8-check.ts --tree <dir>    against another checkout's shared/ (a mutant)
//   bun tools/protocol/r8-check.ts --mutants       remove each fix in turn (a copy of shared/): its rows must go red; a
//                                                 no-op control mutation must stay green
// Rows:
//   H   a delete never re-sponsors a script (a scope id that names nothing reaches nothing); a fork carries what its
//       parent holds (no model-hash stamped into the copy)
//   R   reference clearing is the authority's follow-up: a third party's keyed ref or lock can't veto your delete, your
//       undo of a create, or your undo of that delete
//   M   the shape repair's once-per-world marker is the system's own repair-shapes act (verb + actor), written at founding:
//       a purged founding act doesn't re-run the repair
//   P   an enter/leave activation records no identity (the script still hears `by`), and the auditor doesn't flag it
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under shared/, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["a delete clears script scopes again", "protocol/authority/followups.js", "baseOf(k) === \"script\" || ", "", ["H1"]],
  ["a fork's copy stamps model-hash", "protocol/authority/followups.js", "if (!ids.size || CTX.forking) return ops;", "if (!ids.size) return ops;", ["H2"]],
  ["ref clears admitted on the deleter's rights", "protocol/authority/gate.js", "const fu = raw[FOLLOW_UP] === true;", "const fu = false;", ["R1", "R2", "R3", "R4"]],
  ["undo's ref restores on the undoer's rights", "protocol/authority/undo.js", "const g = setOp(id, comp, nv); g[FOLLOW_UP] = true;", "const g = setOp(id, comp, nv);", ["R4"]],
  ["no repair marker at founding", "protocol/authority/verbs.js", "w.append(actEntry(w, \"system\", \"repair-shapes\", { v: SHAPES_VERSION, ids: [], founding: true }));", "", ["M1"]],
  ["the founding's marker read bare", "protocol/shaperepair.js", "if (e.verb === \"create-world\" && !founded) { founded = true; const b = bodyOf(i);", "if (e.verb === \"create-world\" && !founded) { founded = true; const b = e.body;", ["M2"]],
  ["the repair command reads the marker without readback", "protocol/authority/scriptrun.js", "if (shapesMarked(w.entries, (q) => readback(w, q))) return { marked: true, repaired: [], failed: [] };", "if (shapesMarked(w.entries)) return { marked: true, repaired: [], failed: [] };", ["M2"]],
  ["enter records who", "protocol/authority/scriptrun.js", "const anon = ANON_EVENTS.has(ev.on) || (GRIP_EVENTS.has(ev.on) && ev.seq === undefined);", "const anon = false;", ["P1", "P2"]],
  ["the auditor re-runs an arrival with no one", "protocol/scriptaudit.js", "if (anonWho) event.by = ARRIVAL_STAND_IN;", "", ["P1"]],
  ["the auditor flags an arrival it can't re-run", "protocol/scriptaudit.js", "    if (anonWho) { const r2 =", "    if (false) { const r2 =", ["P2"]],
  ["CONTROL (no-op: must stay green)", "protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/r8-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyShared(tag: string) { const d = scratch(tag); fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true }); return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyShared("r8mut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[r8-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);   // the fixtures below seed the ids they read (ids-check covers the refusal)
const F = await import(TREE + "shared/protocol/fold.js");
const SB = await import(TREE + "shared/protocol/sandbox.js");
const AU = await import(TREE + "shared/protocol/scriptaudit.js");
const SR = await import(TREE + "shared/protocol/shaperepair.js");
const VC = await import(TREE + "shared/protocol/verbclasses.js");
if (D.setScriptDuty) D.setScriptDuty({ maxMs: 1e9 });
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("r8");

function openWorld(name: string, catalogue?: any) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: SB.SANDBOX,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  if (catalogue) w.catalogue = catalogue;
  return w;
}
let T = 1800000000000, N = 0;
function session(catalogue?: any) {
  const name = `r${++N}`; let w: any = null; const W = () => (w ??= openWorld(name, catalogue));
  const step = () => { T += 1000; process.env.PROTOCOL_NOW = String(T); };
  const call = (actor: string, verb: string, args: any = {}) => { step();
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, step, w: W, reopen: () => { w = openWorld(name, catalogue); return w; }, entries: () => W().entries };
}
const code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
// owner olive, builders bob and vic
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name });
  for (const who of ["bob", "vic"]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role: "builder" } });
}
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
const STUB = { commit: "0".repeat(64) };

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean; cat?: any };
const H = "ab".repeat(32);
let hashed = false;
const CAT = { get: (n: any) => (typeof n === "string" && n ? { label: n, surfaces: [], ...(hashed ? { sha256: H } : {}) } : undefined), list: () => [] };
const cases: Case[] = [
  // ---------------- H ----------------
  { id: "H1", what: "the owner deletes a thing a builder's script names in its scope: the script stays the builder's (sponsor, value, status), nothing is written to it", run(s) { cast(s);
      s.call("bob", "create", { id: "h", model: "crate", place: { at: [0, 0] } });
      s.call("bob", "create", { id: "j", model: "crate", place: { at: [2, 0] } });
      const u = s.call("bob", "upload", { text: 'world.on("use", () => { world.set("self", "label", "x"); });' });
      const ins = s.call("bob", "set", { id: "h", component: "script:s", value: { src: u.src, scope: { ids: ["h", "j"], comps: ["label"] }, on: ["use"] } });
      const before = JSON.stringify(comp(s, "h", "script:s"));
      const del = s.call("olive", "delete", { id: "j" });
      const sv = (s.call("olive", "scripts", { id: "h" }).scripts ?? []).find((x: any) => x.script === "script:s");
      return { ins: show(ins), del: show(del), same: JSON.stringify(comp(s, "h", "script:s")) === before, sponsor: sv?.sponsor, status: sv?.status,
        touched: JSON.stringify(del.notes ?? []).includes("script:s") }; },
    good: (o) => o.ins === "ok" && o.del === "ok" && o.same && o.sponsor === "bob" && !o.touched },
  { id: "H2", what: "a fork's copy of a thing whose model the catalogue has since measured carries what the parent holds (no model-hash stamped): the fork succeeds and the copy equals the source", cat: CAT, run(s) {
      hashed = false; cast(s);
      const c = s.call("olive", "create", { id: "crow", model: "lib/crow.glb", components: { transform: { pos: [0, 0, 0] } } });
      const src = s.w().state().entities.crow.c;
      hashed = true;
      const B = session(CAT); B.call("olive", "create-world", { title: "fork" }); B.step();
      const { model, lock, ...comps } = src;
      let r; try { r = D.forkCopy(B.w(), "olive", { ops: [{ verb: "create", args: { id: "crow", model, components: comps } }], throughLock: true }); } catch (e) { r = { crashed: String(e) }; }
      const got = B.w().state().entities.crow?.c; hashed = false;
      return { c: show(c), r: show(r), hadHash: "model-hash" in src, same: JSON.stringify(src) === JSON.stringify(got) }; },
    good: (o) => o.c === "ok" && o.r === "ok" && !o.hadHash && o.same },
  // ---------------- R ----------------
  { id: "R1", what: "vic's keyed look-at:eye aims at bob's door: bob's delete goes through, and vic's look-at is cleared (noted)", run(s) { cast(s);
      s.call("bob", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
      const l = s.call("vic", "create", { id: "lever", model: "crate", components: { "look-at:eye": { target: "door" } }, place: { at: [3, 0] } });
      const d = s.call("bob", "delete", { id: "door" });
      return { l: show(l), d: show(d), eye: comp(s, "lever", "look-at:eye") ?? null, noted: JSON.stringify(d.notes ?? []).includes("lever") }; },
    good: (o) => o.l === "ok" && o.d === "ok" && o.eye === null && o.noted },
  { id: "R2", what: "vic's lever is locked and looks at bob's door2: bob's delete goes through (a lock on the referrer isn't a veto)", run(s) { cast(s);
      s.call("bob", "create", { id: "door2", model: "crate", place: { at: [6, 0] } });
      s.call("vic", "create", { id: "lever2", model: "crate", components: { "look-at": { target: "door2" } }, place: { at: [9, 0] } });
      const lk = s.call("vic", "set", { id: "lever2", component: "lock", value: { rank: "builder" } });
      const d = s.call("bob", "delete", { id: "door2" });
      return { lk: show(lk), d: show(d), look: comp(s, "lever2", "look-at") ?? null, lock: !!comp(s, "lever2", "lock") }; },
    good: (o) => o.lk === "ok" && o.d === "ok" && o.look === null && o.lock },
  { id: "R3", what: "bob creates a box, vic aims a keyed look-at at it: bob's bare undo (of his create) goes through", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [12, 0] } });
      s.call("vic", "create", { id: "eye2", model: "crate", components: { "look-at:k": { target: "box" } }, place: { at: [14, 0] } });
      const u = s.call("bob", "undo", {});
      return { u: show(u), box: !!s.w().state().entities.box, k: comp(s, "eye2", "look-at:k") ?? null }; },
    good: (o) => o.u === "ok" && !o.box && o.k === null },
  { id: "R4", what: "…and bob's undo of his delete of door2 (vic's locked lever looked at it) brings the door back and its reference with it", run(s) { cast(s);
      s.call("bob", "create", { id: "door2", model: "crate", place: { at: [6, 0] } });
      s.call("vic", "create", { id: "lever2", model: "crate", components: { "look-at": { target: "door2" } }, place: { at: [9, 0] } });
      s.call("vic", "set", { id: "lever2", component: "lock", value: { rank: "builder" } });
      const d = s.call("bob", "delete", { id: "door2" });
      const u = s.call("bob", "undo", {});
      return { d: show(d), u: show(u), door: !!s.w().state().entities.door2, look: comp(s, "lever2", "look-at")?.target ?? null }; },
    good: (o) => o.d === "ok" && o.u === "ok" && o.door && o.look === "door2" },
  // ---------------- M ----------------
  { id: "M1", what: "a founding writes the system's repair-shapes act beside it (the marker is that act: verb + actor), and READBACK lists the founding's marker", run(s) { cast(s);
      const L = s.entries(); const i = L.findIndex((e: any) => e.kind === "act" && e.verb === "create-world");
      const j = L.findIndex((e: any) => e.kind === "act" && e.verb === "repair-shapes" && e.actor === "system");
      return { i, j, row: !!VC.READBACK?.["act:create-world"] }; },
    good: (o) => o.i > 0 && o.j > o.i && o.row },
  { id: "M2", what: "a world founded today with a pendulum (no pivot) and a sky azimuth; its founding act's body purged (the stored stub): a reload's lift writes nothing, the values stay as they were", run(s) { cast(s);
      s.call("olive", "create", { id: "swing", model: "crate", components: { transform: { pos: [0, 0, 0] } } });
      const m = s.call("olive", "set", { id: "swing", component: "motion", value: { type: "pendulum", amp: 0.3 } });
      const k = s.call("olive", "sky", { azimuth: Math.PI / 2 });
      const az0 = comp(s, "@world", "sky")?.azimuth, mo0 = JSON.stringify(comp(s, "swing", "motion"));
      const w = s.reopen(); const i = w.entries.findIndex((e: any) => e.kind === "act" && e.verb === "create-world"); w.entries[i].body = { ...STUB };
      // a log whose marker is ONLY the founding (one founded before the marker act existed): its marker act read as some other
      // act (in memory), so the stub alone decides, and a purged founding is unknown, which is marked
      const j = w.entries.findIndex((e: any) => e.kind === "act" && e.verb === "repair-shapes"); if (j >= 0) w.entries[j] = { ...w.entries[j], verb: "x-not-a-marker" };
      const old = w.entries;
      const n = w.entries.length; s.step(); D.liftWorld(w); const out = D.repairShapes(w);   // item 9 (10-18): the load never repairs; the command reads the marker through readback
      return { m: show(m), k: show(k), n, after: w.entries.length, az: comp(s, "@world", "sky")?.azimuth, az0, mo: JSON.stringify(comp(s, "swing", "motion")), mo0, out,
        markedOld: SR.shapesMarked(old, (q: number) => (q === i ? null : old[q]?.body)) }; },
    good: (o) => o.m === "ok" && o.k === "ok" && o.after === o.n && o.az === o.az0 && o.mo === o.mo0 && o.markedOld === true },
  { id: "M3", what: "a translation carries the marker from its start: the system's repair-shapes act beside `translated`; with the translated act's body purged (unknown) the log still reads marked", async run() {
      const TV = await import(ENGINE + "tools/protocol/import-v1/translate-v1.js");
      const old = [{ seq: 0, ts: 1, actor: "world", verb: "genesis", args: { v: 2, dialect: "eidoverse-log", roles: { Marigold: { role: "owner" } } } },
        { seq: 1, ts: 2, actor: "Marigold", verb: "spawn", args: { id: "lamp_1", lib: "a.glb", pos: [1, 0, 1] } }];
      const r = TV.translate(old, {}); const L = r.out;
      const t = L.findIndex((e: any) => e.verb === "translated"), m = L.findIndex((e: any) => e.verb === "repair-shapes" && e.actor === "system");
      const stub = L.map((e: any, i: number) => (i === t ? { ...e, body: { ...STUB } } : e));
      return { t, m, marked: SR.shapesMarked(stub, (q: number) => (q === t ? null : stub[q]?.body)), noMarker: SR.shapesMarked(stub.filter((_: any, i: number) => i !== m)) }; },
    good: (o) => o.t === 1 && o.m === 2 && o.marked && o.noMarker === false },
  // ---------------- P ----------------
  { id: "P1", what: "an enter script runs on arrival and hears `by`, but the act names nobody: the identity is nowhere in the log; the auditor verifies it with a stand-in arrival (its result doesn't depend on who)", run(s) { cast(s);
      const WHO = "u-vicvicvicvicvicvicvi";
      s.call("olive", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
      const u = s.call("olive", "upload", { text: 'world.on("enter", (e) => { const n = (world.get("self", "t/n")?.n ?? 0) + 1; world.set("self", "t/n", { n, heard: typeof e.by === "string" && e.by.length > 0 }); });' });
      const ins = s.call("olive", "set", { id: "door", component: "script:greet", value: { src: u.src, scope: { ids: "self", comps: ["t/n"] }, on: ["enter"] } });
      s.step(); const ran = D.presenceEvent(s.w(), "enter", WHO);
      const A = AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript });
      return { ins: show(ins), ran: ran?.[0]?.status, n: comp(s, "door", "t/n"), inLog: JSON.stringify(s.entries()).includes(WHO), flags: A.flags, skipped: A.skipped.length, reran: A.reran }; },
    good: (o) => o.ins === "ok" && o.ran === "ran" && o.n?.n === 1 && o.n?.heard === true && !o.inLog && !o.flags.length && o.skipped === 0 && o.reran === 1 },
  { id: "P2", what: "…an enter script that writes who came (its own write, in its own scope) is the script's doing: the auditor lists it skipped (depends on who arrived), never flagged or verified", run(s) { cast(s);
      const WHO = "u-bobbobbobbobbobbobbo";
      s.call("olive", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
      const u = s.call("olive", "upload", { text: 'world.on("enter", (e) => { world.set("self", "t/last", { who: e.by }); });' });
      const ins = s.call("olive", "set", { id: "door", component: "script:guest", value: { src: u.src, scope: { ids: "self", comps: ["t/last"] }, on: ["enter"] } });
      s.step(); const ran = D.presenceEvent(s.w(), "enter", WHO);
      const act = s.entries().findLast((e: any) => e.kind === "act" && e.verb === "script");
      const A = AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript });
      return { ins: show(ins), ran: ran?.[0]?.status, actNames: JSON.stringify(act?.body ?? {}).includes(WHO), flags: A.flags, skipped: A.skipped.map((x: any) => x.why) }; },
    good: (o) => o.ins === "ok" && o.ran === "ran" && !o.actNames && !o.flags.length && o.skipped.length === 1 && /who arrived/.test(o.skipped[0]) },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = await c.run(session(c.cat)); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[r8-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
