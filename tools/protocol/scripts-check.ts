// tools/protocol/scripts-check.ts — scripts (research 41; the lab's 46 B-cases, ported from its toy language to real
// JavaScript in the QuickJS sandbox), through the real authority, plus `use` → script and a timer through a real server.
//   bun tools/protocol/scripts-check.ts                 every case (the server cases start a scratch sequencer)
//   bun tools/protocol/scripts-check.ts --only B2,B5    just those
//   bun tools/protocol/scripts-check.ts --tree <dir>    run the authority cases against another checkout's shared/ (a mutant, a base)
//   bun tools/protocol/scripts-check.ts --control       the base commit (bbc9ac22, before scripts): every server case must FAIL there
//   bun tools/protocol/scripts-check.ts --mutants       remove each gate in turn (a copy of shared/): its cases must go red; a
//                                                 no-op control mutation must stay green
// Cases:
//   B   behaviours on sponsor rights (41 §7, lab 46 B1–B20)        D   determinism and the reader's audit (41 §3.7)
//   R   runaway work: fuel, stack, memory, reads (41 §7 #9)       U   `use` → script: who did what, in the log
//   E   events: say, enter/leave, changed, wake                    P   params (seat poses read param.<name>)
//   C   a script's body effects meet each body's consent (L6)      V   translated v1 behaviours say they need re-installing
//   H   source hygiene and syntax at upload and install            S   the server: no v1 BehaviorHost; timers tick; use → script
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { idAliases } from "./idalias.ts";
const IDS = idAliases();   // the real-server rows: the suite's names ride as placeholders and minted ids (R 10-17)

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "bbc9ac22";

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// Each mutation removes ONE gate from a copy of shared/ and names the cases that must turn red. Applied as an exact text
// replacement; a mutation whose text isn't found is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string[]][] = [
  // [name, file, find, replace, cases]
  ["install: scope within installer's rights", "authority/scripts.js", "if (need) refuse(\"rights\", `${at}'s scope reaches", "if (false) refuse(\"rights\", `${at}'s scope reaches", ["B1"]],
  ["sponsor's role NOW", "authority/scripts.js", "const need = lacks(w, st, cap.sponsor, op,", "const need = null && lacks(w, st, cap.sponsor, op,", ["B2", "B3", "B24"]],
  ["scope narrowing", "authority/scripts.js", "if (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp))", "if (false && (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp)))", ["B4"]],
  ["sponsor = latest write (not creator)", "authority/scripts.js", "const W = scriptWrites(w, id, key);\n  for (let k = 0; k < W.length; k++)", "const W = scriptWrites(w, id, key).slice(-1);\n  for (let k = 0; k < W.length; k++)", ["B18"]],
  ["no-op elision", "authority/scriptrun.js", "const ops = SR.elide(st, res.ops);", "const ops = res.ops;", ["B16", "B5"]],
  ["timers sleep with nobody present", "authority/scriptrun.js", "if (!present && v.always !== true) { rt.sleepingSince ??= now;", "if (false) { rt.sleepingSince ??= now;", ["B5", "E4"]],
  ["world hourly budget", "authority/scriptrun.js", ": B.all + cost > cfg.budget ?", ": false ?", ["B6"]],
  ["sponsor's fair share", "authority/scriptrun.js", ": B.bySponsor + cost > B.share ?", ": false ?", ["B6b"]],
  ["per-script rate", "authority/scriptrun.js", "(B.mine >= cfg.rate ?", "(false ?", ["B6c"]],
  ["script count", "authority/scripts.js", "if (n > cfg.max) refuse(\"too-many\"", "if (false) refuse(\"too-many\"", ["B7"]],
  ["cascade depth", "authority/scriptrun.js", "if (depth > cfg.depth) return out(\"refused\"", "if (false) return out(\"refused\"", ["B8"]],
  ["locks bind scripts", "authority/gate.js", "if (k) lockCheck(w, st, who, role, k, op, at); }", "if (k && !cap) lockCheck(w, st, who, role, k, op, at); }", ["B9"]],
  ["in flight binds scripts", "authority.js", "if (inFlight(op.id)) refuse(\"in-flight\"", "if (inFlight(op.id) && cap?.kind !== \"script\") refuse(\"in-flight\"", ["B10"]],
  ["hygiene at install", "authority/scripts.js", "const dirty = SR.hygiene(blob.text); if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`", "const dirty = null; if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`", ["H2"]],
  ["hygiene at upload", "authority/scriptrun.js", "const dirty = SR.hygiene(a.text); if (dirty) refuse(dirty.code, dirty.reason", "const dirty = null; if (dirty) refuse(dirty.code, dirty.reason", ["H1"]],
  ["scope names checked for typos at install", "authority/scripts.js", "if (near.length) refuse(\"schema\", `${at}.scope.comps:", "if (false) refuse(\"schema\", `${at}.scope.comps:", ["H4"]],
  ["syntax at install", "authority/scripts.js", "const syn = w.scripts?.checkSyntax?.(blob.text); if (syn)", "const syn = null; if (syn)", ["H3"]],
  ["banned → suspended", "authority/scriptrun.js", "if (isBanned(w, sp.sponsor)) return out(\"suspended\"", "if (false) return out(\"suspended\"", ["B15"]],
  ["adopt base", "authority/scriptrun.js", "if (base !== undefined && lt && lt.seq > base) refuse(\"stale\", `${a.id}.${key}", "if (false) refuse(\"stale\", `${a.id}.${key}", ["B14"]],
  ["always needs an owner", "authority/scripts.js", "if (v.always === true && prev?.always !== true && role !== \"owner\")", "if (false)", ["B17"]],
  ["install rank", "authority/scripts.js", "if (!may(st, installer, \"scripts\")) refuse(\"rights\"", "if (false) refuse(\"rights\"", ["B17"]],
  ["timer floor", "authority/scripts.js", "if (v.every !== undefined && !(typeof v.every === \"number\" && v.every >= 5))", "if (false)", ["B17"]],
  ["paused", "authority/scriptrun.js", "if (v.paused === true) { const pb = pausedBy(w, id, key); return out(\"paused\"", "if (false) { const pb = pausedBy(w, id, key); return out(\"paused\"", ["B20", "PA1"]],
  ["run: false", "authority/scriptrun.js", "if (cfg.run === false) return out(\"stopped\"", "if (false) return out(\"stopped\"", ["B20"]],
  ["pause after repeated failures", "authority/scriptrun.js", "if (!dry && (rt.fails ?? 0) >= cfg.fails) return out(\"paused\"", "if (false) return out(\"paused\"", ["B20"]],
  ["say needs scope.say", "authority/scriptrun.js", "if (res.says.length && !v.scope?.say) return mark(\"scope\"", "if (false) return mark(\"scope\"", ["B21"]],
  ["create needs scope.create", "authority/scripts.js", "if (!cap.create) refuse(\"scope\", `${cap.key} doesn't declare create: true`", "if (false) refuse(\"scope\", `${cap.key} doesn't declare create: true`", ["B22"]],
  ["created things stay in the subtree", "authority/gate.js", "if (cap?.kind === \"script\") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some(", "if (false) for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some(", ["B22"]],
  ["a script's body effect meets consent", "authority/scriptrun.js", "const g = bodyGate(w, `script:${id}`, b.to, b.kind, { spec: b.spec, script: key, sponsor: sp.sponsor }); if (!g.ok) return mark(g.code, g.reason);", "const g = { ok: true, consent: \"standing\", deliver: () => {} };", ["C1"]],
  ["the beat drains scripts", "authority/scriptrun.js", "drainAll(w);   // what the beat logged reaches scripts", "/* mutant */   // what the beat logged reaches scripts", ["E6"]],
  ["enter() restores the outer call's queues", "authority.js", "Object.assign(CTX, outer); w.changedQ = wq.changedQ; w.sayQ = wq.sayQ;", "Object.assign(CTX, outer); w.sayQ = wq.sayQ;", ["E5"]],
  ["bodies need scope.bodies", "authority/scriptrun.js", "for (const b of res.bodies) if (!(v.scope?.bodies ?? []).includes(b.kind)) return mark(\"scope\"", "for (const b of res.bodies) if (false) return mark(\"scope\"", ["C2"]],
  ["sponsor-wide body allowance", "authority/bodyconsent.js", "&& C.tableOf(P, to).overrides[`scripts-by:${extra.sponsor}`]?.[cls]) d = C.decide(P, `scripts-by:${extra.sponsor}`, to, cls, now);", "&& false) d = null;", ["C3"]],
  ["frozen clock", "sandbox.js", "FrozenDate.now = () => NOW;", "FrozenDate.now = () => RealDate.now();", ["D2"]],
  ["seeded randomness", "sandbox.js", "Math.random = function random() { return sfc(); };", "", ["D2"]],
  ["presence reads replayed from the act (stand-ins for who)", "sandbox.js", "const ids = x.reads ? (Array.isArray(was?.ids) ? was.ids : standIns(nearAt, was?.n)) : (x.near ? x.near(r) : []);", "const ids = x.near ? x.near(r) : [];", ["D1"]],
  ["a near() read records who (ids)", "sandbox.js", "nearAt++; reads.near.push({ r, n: ids.length }); return ids.slice(); }", "nearAt++; reads.near.push({ r, n: ids.length, ids: ids.slice() }); return ids.slice(); }", ["D4"]],
  ["a name() read records the name", "sandbox.js", "nameAt++; reads.names++; return n; }", "nameAt++; reads.names++; reads.near.push({ r: 0, n: 0, ids: [n] }); return n; }", ["D4"]],
  ["the auditor counts an identity-dependent act verified (or flags it)", "scriptaudit.js", "if (whoReads(b.reads)) { skipped.push(", "if (false) { skipped.push(", ["D4"]],
  ["the auditor checks the read shape", "scriptaudit.js", "if (jcs(readShape(res.reads)) !== jcs(readShape(b.reads))) {", "if (false) {", ["D4"]],
  ["a script's body effect records its consent mode", "authority/scriptrun.js", "bodies: gates.map((g) => ({ kind: g.kind, to: `body:${g.to}` }))", "bodies: gates.map((g) => ({ kind: g.kind, to: `body:${g.to}`, consent: g.consent }))", ["C1"]],
  ["fuel", "sandbox.js", "if (fuel > L.fuel) {", "if (false) {", ["R1"]],
  ["host-call cap", "sandbox.js", "if (++calls > L.calls) {", "if (false) {", ["R4"]],
  ["write cap", "sandbox.js", "if (ops.length >= L.ops) {", "if (false) {", ["R5"]],
  ["params keys have a grammar", "authority/checks.js", "if (bad !== undefined) refuse(\"shape\", `${at}: '${bad}' isn't a name here", "if (false) refuse(\"shape\", `${at}: '${bad}' isn't a name here", ["P2"]],
  ["params holds at most maxKeys", "authority/checks.js", "if (def.maxKeys !== undefined && Object.keys(v).length > def.maxKeys)", "if (false)", ["P2"]],
  ["changed:<comp> cascades", "authority/scriptrun.js", "if (hit) activate(w, id, name, { on: `changed:${hit.comp}`", "if (false) activate(w, id, name, { on: `changed:${hit.comp}`", ["E3", "B8"]],
  ["say events", "authority/scriptrun.js", "activate(w, id, name, { on: \"say\", by: e.actor", "void (w, id, name, { on: \"say\", by: e.actor", ["E1"]],
  ["a script never hears its own say", "authority/scriptrun.js", "if (!(Array.isArray(v.on) && v.on.includes(\"say\")) || e.actor === `script:${id}`) continue;", "if (!(Array.isArray(v.on) && v.on.includes(\"say\"))) continue;", ["E1"]],
  ["use of an imported binding says re-install", "authority/use.js", "if (old || (isE(ce) && ce.kind === \"act\" && ce.verb === \"imported\"))", "if (false)", ["V1"]],
  ["imported behaviours are listed", "authority/scriptrun.js", "...(id && id !== \"@world\" ? {} : { imported: importedBehaviours(w, st) })", "...{}", ["V1"]],
  ["UTC inside the sandbox", "sandbox.js", "P.getTimezoneOffset = function getTimezoneOffset() { return 0; };", "", ["D3"]],
  ["local-time methods are UTC", "sandbox.js", "P[\"get\" + k] = P[\"getUTC\" + k];", "", ["D3"]],
  ["runs per script per minute", "authority/scripts.js", "if (runs >= cfg.runs) return", "if (false) return", ["B23"]],
  ["cpu per sponsor per minute", "authority/scripts.js", "if (ms >= cfg.cpu) return", "if (false) return", ["B23"]],
  ["a guest sponsor is a guest", "authority/gate.js", "const n = needOf(op); const eff = effective(st, holder);", "const n = needOf(op); const eff = effective(st, holder, false);", ["B24"]],
  ["upload rate", "authority/scriptrun.js", "if (U.length >= SR.LIMITS.uploads) refuse(\"rate\", `${said(actor)} has uploaded ${U.length} sources", "if (false) refuse(\"rate\", `${said(actor)} has uploaded ${U.length} sources", ["H5"]],
  ["acts point at a say's text, never copy it", "authority/scriptrun.js", "const recorded = (ev) => { const { text, to, args, ...rest } = ev; return ev.seq !== undefined ? rest : ev; };", "const recorded = (ev) => ev;", ["E1"]],
  ["the auditor reads a say's text from the say", "scriptaudit.js", "event.text = trig.body.text;", "", ["E1"]],
  ["an authority runs activations isolated (in a killable process)", "sandbox.js", "run: (x) => (canIsolate() ? runIsolated(x) : runScript(x))", "run: (x) => runScript(x)", ["I1", "I2"]],
  ["the kill at the deadline", "sandbox.js", "deadline = sentAt + L.wallMs + GRACE,", "deadline = sentAt + L.wallMs + GRACE + 60000,", ["I1"]],
  ["a pause write adopts nothing (sponsor skips it)", "authority.js", "if (k === W.length - 1 || !pauseOnly(W[k].value, W[k + 1].value)) return", "if (true) return", ["PA1"]],
  ["the auditor's sponsor skips pause writes too", "scriptaudit.js", "|| jcs(unp(W[k].value)) !== jcs(unp(W[k + 1].value))) return by(L, W[k].seq);", "|| true) return by(L, W[k].seq);", ["PA1"]],
  ["a pause write skips install checks", "authority/gate.js", "&& !pauseOnly(op.value, prevOf.get(op))) installCheck(", ") installCheck(", ["PA2"]],
  ["the inspector's script permission", "../editschema.js", "ops.push(OP.set(id, `script:${k}`, { paused: bool(raw) }, { merge: true }));", "", ["PA3"]],
  ["status says who paused it", "authority/scriptrun.js", "...(pb ? { pausedBy: pb.by, pausedAt: pb.at, pausedTs: pb.ts } : {}),", "", ["PA1"]],
  ["bounded wait for a warm process", "sandbox.js", "const WARM_MS = 300;", "const WARM_MS = 5000;", ["I3"]],
  ["a pause write is judged against the value just before it", "authority/gate.js", "&& !pauseOnly(op.value, prevOf.get(op))) installCheck(", "&& !pauseOnly(op.value, st.entities[op.id]?.c[op.comp])) installCheck(", ["PA4"]],
  ["dry runs spend the duty", "authority/scriptrun.js", "  { const ms = performance.now() - t0; dutyLog.push({ at: performance.now(), ms, w: w.worldId }); }", "  if (!dry) { const ms = performance.now() - t0; dutyLog.push({ at: performance.now(), ms, w: w.worldId }); }", ["I4"]],
  ["one world gets a share of the duty", "authority/scripts.js", "return Math.min(DUTY.maxMs - all, DUTY.maxMs * DUTY.worldShare - mine); };", "return DUTY.maxMs - all; };", ["I7"]],
  ["admit copies one entity per op, not the world", "authority/gate.js", "    applyCow(s, [op]); norm.push(op);", "    s = applyOps(s, [op]); norm.push(op);", ["I5"]],
  ["elision copies one entity per op, not the world", "scriptrules.js", "out.push(o); try { applyCow(s, [o]); }", "out.push(o); try { JSON.parse(JSON.stringify(s.entities)); applyCow(s, [o]); }", ["I5"]],
  ["read-your-writes without copying the world", "sandbox.js", "const writable = (id) => { if (ov.has(id)) return ov.get(id); const b = base[id]; if (!b) return null; const e = { born: b.born, c: Object.assign(Object.create(null), b.c) }; ov.set(id, e); return e; };", "const writable = (id) => { const b = ov.has(id) ? ov.get(id) : base[id]; if (!b) return null; for (const k of Object.keys(base)) JSON.parse(JSON.stringify(base[k])); const e = { born: b.born, c: Object.assign(Object.create(null), b.c) }; ov.set(id, e); return e; };", ["I5"]],
  // (not a mutation: the check between host answers is defence in depth. A process can't send its next call before its
  // answer arrives, so the authority always finds the pipe empty first and its ordinary deadline check fires: measured, I9)
  ["time spent answering isn't the process's starvation", "sandbox.js", "if (used !== null && own > 0.5 * wall && used < STARVED * own)", "if (used !== null && used < STARVED * wall)", ["I9"]],
  ["a starved process isn't the script's failure", "sandbox.js", "export const STARVED = 0.3;", "export const STARVED = 0;", ["I8"]],
  ["end of file means the process died", "sandbox.js", "if ((n === 0 && c.opened) || c.proc.exitCode !== null", "if (c.proc.exitCode !== null", ["I6"]],
  ["the process's script duty", "authority/scriptrun.js", "if (dutyLeft(w.worldId) <= 0) return out(\"refused\", { code: \"busy\"", "if (false) return out(\"refused\", { code: \"busy\"", ["I2", "I4", "I7"]],
  ["CONTROL (no-op: must stay green)", "authority/scripts.js", "// ---------- behaviours (L4, L7 as revised;", "// ---------- behaviours (L4, L7  as revised;", []],
];
async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/scripts-check.ts"), "--tree", tree, "--no-server", ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyShared(tag: string) { const d = scratch(tag); fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true }); return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = copyShared("mut"); const f = path.join(d, "shared/protocol", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[scripts-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  // the base commit's shared/ (default: the authority before scripts, where every server case must FAIL). --control <commit>
  // runs against a later base (a round's start) and lists what is red there, with --want <ids> naming what must be
  const at = opt("control") && !opt("control")!.startsWith("--") ? opt("control")! : BASE; const want = opt("want")?.split(",") ?? null;
  const d = scratch("ctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${at} shared | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${at}: ${r0.stderr}`); process.exit(1); }
  const r = await runSelf(d, null, ["--expect-absent"]);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const red = lines.filter((l) => l.startsWith("FAIL")).map((l) => l.split(/\s+/)[1]);
  if (want) { const bad = want.filter((x) => !red.includes(x)); console.log(`red at ${at}: ${red.join(",")}`);
    console.log(`[scripts-check --control ${at}] ${bad.length ? `NOT red there: ${bad.join(",")}` : `every one of ${want.join(",")} is red there`}`); process.exit(bad.length ? 1 : 0); }
  const passing = lines.filter((l) => l.startsWith("ok "));
  console.log(lines.map((l) => (l.startsWith("ok ") ? "UNEXPECTED PASS AT BASE " : "red at base: ") + l.slice(0, 140)).join("\n"));
  console.log(`[scripts-check --control] at ${at}: ${lines.length - passing.length} of ${lines.length} cases red, ${passing.length} passed`);
  process.exit(passing.length ? 1 : 0);
}

// ---------------- the authority, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const tryImport = async (p: string) => { try { return await import(p); } catch (e) { if (!argv.includes("--expect-absent")) throw e; return null; } };
const D = await import(TREE + "shared/protocol/authority.js");
const SD = await import(TREE + "shared/protocol/authority/scripts.js");   // the duty log and constants (I7 calibrates from them)
D.fixtureIds?.(true);   // the fixtures below seed the ids they read (R 10-17: a writer never chooses one; ids-check covers the refusal)
const F = await import(TREE + "shared/protocol/fold.js");
const STOR = await import(TREE + "shared/protocol/authority/storage.js");   // CHANGE: B25 stores an old spelling as an old log holds it
const SB = await tryImport(TREE + "shared/protocol/sandbox.js");
const AU = await tryImport(TREE + "shared/protocol/scriptaudit.js");
const ONLY = opt("only")?.split(",") ?? null;
// the edit UI's schema and the view record it reads (shared code: from the same tree as the authority, so a mutant reaches it)
const await_ES = await import(TREE + "shared/editschema.js"), await_RV = await import(TREE + "shared/protocol/view.js");
// the process-wide script duty (DUTY, authority.js) is about real seconds; these cases fire hundreds of activations in a tight
// loop on a simulated clock, so it's opened wide here, and I2 sets it on purpose
const DUTY0 = D.setScriptDuty ? D.setScriptDuty({ maxMs: 1e9 }) : null;
// the warm processes started and SAID ready (the pool's own count), not a fixed 800 ms: on a slow host QuickJS takes longer
// to load, and a case that measures the deadline must start from the state it names ("the pool is warm"). Bounded: 30 s
function warmUp(want = 2, limitMs = 30000) { if (!SB?.warm) return; SB.warm(); const t = performance.now();
  while ((SB.isolationStats?.().warm ?? want) < want && performance.now() - t < limitMs) Bun.sleepSync(20); }
// "unavailable" is the sandbox's own verdict that the HOST starved the run (its process got too little CPU before the
// deadline: not the script's doing, not evidence either way). A case about what a script does asks again, bounded, after
// the pool is warm; it never retries a real verdict (ran, failed, refused)
const UNAVAILABLE_RETRIES = 4;
function useSteady(s: any, actor: string, args: any) { let r: any;
  for (let i = 0; i <= UNAVAILABLE_RETRIES; i++) { r = s.call(actor, "use", args); if (r?.script?.code !== "unavailable") break; warmUp(); Bun.sleepSync(300); }
  return r; }
const root = scratch("scripts");

// a world on disk over THIS tree's door (as server/filehost.ts does with the checkout's)
function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: o.scripts === undefined ? SB?.SANDBOX ?? null : o.scripts, present: o.present, nameOf: o.nameOf, kindOf: o.kindOf,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session(o: any = {}) {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name, o));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, advance: (ms: number) => { T += ms; process.env.PROTOCOL_NOW = String(T); }, tick: () => (D.tick ? D.tick(W()) : null),
    logPath: path.join(root, "worlds", `${name}.jsonl`), entries: () => W().entries };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 100)}`);
const st = (s: any, r: any) => (r?.script ? `${r.script.status}${r.script.code ? ` ${r.script.code}` : ""}` : show(r));
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
const kinds = (L: any[]) => L.reduce((m: any, e: any) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
const isScriptActor = (a: any) => typeof a === "string" && a.startsWith("script:");
const ZERO = "sha256:" + "0".repeat(64);
// owner olive (the founder), builders bob and ann, visitor vic
function cast(s: any, extra: [string, string][] = []) {
  s.call("olive", "create-world", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["ann", "builder"], ["vic", "visitor"], ...extra]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
function install(s: any, who: string, id: string, name: string, text: string, value: any) {
  const u = s.call(who, "upload", { text }); const src = u.src ?? ZERO;
  return { u, src, r: s.call(who, "set", { id, component: `script:${name}`, value: { src, ...value } }) };
}
const BELL = `// the bell: counts its rings and says who rang it
world.on("use", (e) => {
  const rung = (world.get("self", "t/bell")?.rung ?? 0) + 1;
  world.set("self", "t/bell", { rung });
  world.say("the bell tolls for " + e.by + " (" + rung + ")");
});
`;
function bell(s: any, who: string) { s.call(who, "create", { id: "bell1", model: "bell", place: { at: [0, 0] } });
  const r = install(s, who, "bell1", "bell", BELL, { scope: { ids: "self", comps: ["t/bell"], say: true }, on: ["use"] });
  s.call(who, "set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "bell" } } }); return r; }
const NAMES: Record<string, string> = { vic: "Vic" }; // a stand-in for the authority's directory (M1)
const onUse = (body: string) => `world.on("use", (e) => {\n${body}\n});\n`;
const HEAVY = onUse(`for (let i = 0; i < 31; i++) world.set("self", "t/n", i); world.get("self"); world.set("self", "t/m", world.ids().length); world.children("box");`);

// E5's stand-in for the sandbox: a host whose script callback re-enters the authority with a request of its own (the shape
// enter() guards: a nested call must not reset the outer call's queues under it)
const HOSTCB: any = { w: null, nested: null, checkSyntax: () => null,
  run({ self, key, event }: any) {
    const ops = key === "script:hear" ? ((HOSTCB.nested = D.request(HOSTCB.w, "bob", "set", { id: "lamp", component: "t/n", value: 1 })), [{ verb: "set", id: self, comp: "t/released", value: { by: event.by } }])
      : key === "script:glow" ? [{ verb: "set", id: self, comp: "t/moved", value: true }] : [];
    return { ok: true, ran: true, ops, says: [], bodies: [], reads: null, logs: [], fuel: 0 }; } };
type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean; server?: boolean; opts?: any };
const cases: Case[] = [
  // ---------------- B: behaviours on sponsor rights ----------------
  { id: "B1", what: "41 #1 proxy promotion: a builder installs a script whose scope is @world × roles:* (refused at install: wider than the installer's rights)", run(s) { cast(s);
      s.call("bob", "create", { id: "kiosk", model: "crate", place: { at: [0, 0] } });
      const { r } = install(s, "bob", "kiosk", "promo", onUse(`world.set("@world", "roles:bob", { role: "owner" });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      return { install: r, stored: !!comp(s, "kiosk", "script:promo") }; },
    good: (o) => code(o.install) === "rights" && /roles:\*/.test(o.install.refused.reason) && !o.stored },
  { id: "B2", what: "41 #2 demotion: the sponsor is demoted; the next use's write is refused, the player's use still logs, the status says dormant and why", run(s) { cast(s);
      const { u } = bell(s, "bob"); const first = useSteady(s, "vic", { id: "bell1", action: "ring" });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } }); let n0 = s.entries().length;
      let after: any; for (let a = 0; a <= UNAVAILABLE_RETRIES; a++) { n0 = s.entries().length; after = s.call("vic", "use", { id: "bell1", action: "ring" }); if (after?.script?.code !== "unavailable") break; warmUp(); }   // what the last use logged
      const sv = s.call("olive", "scripts", {}).scripts?.[0];
      return { u: show(u), first: st(s, first), after: st(s, after), newKinds: kinds(s.entries().slice(n0)), status: sv?.status, why: sv?.why }; },
    good: (o) => o.first === "ran" && o.after === "refused rights" && JSON.stringify(o.newKinds) === '{"act":1}' && o.status === "dormant" && /sponsor bob \(player now.*bell1\.t\/bell/.test(o.why) },
  { id: "B3", what: "41 #3 confused deputy: an OWNER uses a script installed by bob (owner then, builder now) that writes roles:mal; the trigger adds no rights", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
      s.call("bob", "create", { id: "kiosk", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "kiosk", "promo", onUse(`world.set("@world", "roles:mal", { role: "builder" });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      install(s, "bob", "kiosk", "hello", onUse(`world.set("self", "t/greeting", e.by);`), { scope: { ids: "self", comps: ["t/greeting"] }, on: ["use"] });
      s.call("bob", "set", { id: "kiosk", component: "reactions", value: { promote: { kind: "script", script: "promo" }, hello: { kind: "script", script: "hello" } } });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
      const promote = s.call("olive", "use", { id: "kiosk", action: "promote" }), hello = s.call("olive", "use", { id: "kiosk", action: "hello" });
      const act = s.entries().find((e: any) => e.actor === "script:kiosk" && e.kind === "act");
      return { promote: promote.script ? `${promote.script.status} ${promote.script.code}: ${promote.script.why}` : show(promote), mal: comp(s, "@world", "roles:mal") ?? null, hello: hello.script?.status, trigger: act?.body?.trigger?.actor, sponsor: act?.body?.sponsor }; },
    good: (o) => /^refused rights: script:promo's sponsor bob can't change @world\.roles:mal/.test(o.promote) && o.mal === null && o.hello === "ran" && o.trigger === "olive" && o.sponsor === "bob" },
  { id: "BA", what: "upstream #258 in our terms: an OWNER's script can't change who may come in (@world.access, default-role) or time a grant; an ordinary grant by it still lands", run(s) { cast(s);
      s.call("olive", "create", { id: "kiosk", model: "crate", place: { at: [0, 0] } });
      install(s, "olive", "kiosk", "close", onUse(`world.set("@world", "access", { join: "listed" });`), { scope: { ids: ["@world"], comps: ["access"] }, on: ["use"] });
      install(s, "olive", "kiosk", "timed", onUse(`world.set("@world", "roles:mal", { role: "visitor", until: 9e15 });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      install(s, "olive", "kiosk", "grant", onUse(`world.set("@world", "roles:mal", { role: "builder" });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      s.call("olive", "set", { id: "kiosk", component: "reactions", value: { close: { kind: "script", script: "close" }, timed: { kind: "script", script: "timed" }, grant: { kind: "script", script: "grant" } } });
      const close = s.call("vic", "use", { id: "kiosk", action: "close" }), timed = s.call("vic", "use", { id: "kiosk", action: "timed" });
      const access = comp(s, "@world", "access") ?? null, timedRole = comp(s, "@world", "roles:mal") ?? null;
      const grant = s.call("vic", "use", { id: "kiosk", action: "grant" });
      return { close: close.script ? `${close.script.status} ${close.script.code}: ${close.script.why}` : show(close), timed: timed.script ? `${timed.script.status} ${timed.script.code}` : show(timed),
        access, timedRole, grant: st(s, grant), mal: comp(s, "@world", "roles:mal")?.role ?? null }; },
    good: (o) => /^refused rights: .*who may come into a world/.test(o.close) && o.timed === "refused rights" && o.access === null && o.timedRole === null && o.grant === "ran" && o.mal === "builder" },
  { id: "B4", what: "41 #5 half an activation: the third of three writes is outside the scope; nothing lands (v1 committed two)", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "three", onUse(`world.set("self", "t/a", 1); world.set("self", "t/b", 2); world.set("self", "t/c", 3);`), { scope: { ids: "self", comps: ["t/a", "t/b"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "three" } } }); const n0 = s.entries().length;
      const r = s.call("vic", "use", { id: "box", action: "go" }); const c = s.w().state().entities.box.c;
      return { r: st(s, r), a: c.a ?? null, b: c.b ?? null, scripted: s.entries().slice(n0).filter((e: any) => isScriptActor(e.actor)).length }; },
    good: (o) => o.r === "refused scope" && o.a === null && o.b === null && o.scripted === 0 },
  { id: "B5", what: "41 #6 the heart: a 5 s timer re-asserting one light, 2 h simulated, nobody present: 0 entries, asleep; `always` and already lit: still 0 (elided)", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      const LIT = { kind: "point", color: 16711680, intensity: 1, range: 6, decay: 2 };   // shadows was cut (shape audit 10-16)
      s.call("bob", "create", { id: "lamp", components: { label: "lamp", transform: { pos: [0, 0, 0] } } }); s.call("olive", "create", { id: "lamp2", components: { label: "lamp2", light: LIT, transform: { pos: [2, 0, 0] } } });
      const HEART = `world.on("tick", () => world.set("self", "light", ${JSON.stringify(LIT)}));\nworld.on("wake", () => world.set("self", "light", ${JSON.stringify(LIT)}));\n`;
      install(s, "bob", "lamp", "heart", HEART, { scope: { ids: "self", comps: ["light"] }, every: 5 });
      const always = install(s, "olive", "lamp2", "heart", HEART, { scope: { ids: "self", comps: ["light"] }, every: 5, always: true }).r;
      const n0 = s.entries().length; let nothing = 0;
      const other: string[] = [];
      for (let i = 0; i < 2 * 720; i++) { s.advance(5000); for (const x of s.tick() ?? []) { if (x.status === "nothing" || (x.status === "unavailable" && /too busy/.test(x.why))) nothing++; else other.push(`#${i} ${x.id} ${x.status} ${x.code ?? ""} ${x.why ?? ""}`.slice(0, 120)); } }
      const sv = s.call("olive", "scripts", {}).scripts;
      return { always: show(always), entries2h: s.entries().slice(n0).filter((e: any) => isScriptActor(e.actor)).length, alwaysRanElided: nothing, other, status: sv.map((x: any) => `${x.id}:${x.status}`) }; },
    good: (o) => o.always === "ok" && o.entries2h === 0 && o.alwaysRanElided === 2 * 720 - 1 && o.status.includes("lamp:asleep") && o.status.includes("lamp2:active") },
  { id: "B6", what: "…the heart with a CHANGING value and `always`: the world's hourly budget (set to 60) caps what scripts write each hour", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { budget: 60 } });
      s.call("olive", "create", { id: "heart", model: "bell", place: { at: [0, 0] } });
      const BEAT = (c: string) => `world.on("tick", () => world.set("self", "${c}", { n: (world.get("self", "${c}")?.n ?? 0) + 1 }));\n`;
      install(s, "olive", "heart", "beat", BEAT("t/beat"), { scope: { ids: "self", comps: ["t/beat"] }, every: 30, always: true });
      install(s, "olive", "heart", "beat2", BEAT("t/beat2"), { scope: { ids: "self", comps: ["t/beat2"] }, every: 30, always: true });
      const t0 = T; const why = new Set();
      for (let i = 0; i < 2 * 120; i++) { s.advance(30000); for (const r of s.tick() ?? []) if (r.code === "budget") why.add(/world's scripts/.test(r.why) ? "world" : /sponsors here/.test(r.why) ? "sponsor" : "script"); }
      const hours = [0, 0]; for (const e of s.entries()) if (isScriptActor(e.actor) && e.ts > t0) hours[Math.min(1, Math.floor((e.ts - t0) / 3600000))]++;
      return { hours, why: [...why].sort() }; },
    good: (o) => o.hours.every((n: number) => n > 50 && n <= 60) && o.why.includes("world") },
  { id: "B6d", what: "an owner's budget above this server's ceiling is capped, and the world's budget refusal says so with both numbers", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      // the owner sets 60 under the server's ceiling; then the operator lowers the ceiling to 30 (a write above it is refused)
      const set = s.call("olive", "set", { id: "@world", component: "script-settings", value: { budget: 60 } });
      const was = D.setScriptConfig({ budget: 30 });
      try {
        s.call("olive", "create", { id: "heart2", model: "bell", place: { at: [0, 0] } });
        const BEAT = (c: string) => `world.on("tick", () => world.set("self", "${c}", { n: (world.get("self", "${c}")?.n ?? 0) + 1 }));\n`;
        install(s, "olive", "heart2", "beat", BEAT("t/beat"), { scope: { ids: "self", comps: ["t/beat"] }, every: 30, always: true });
        install(s, "olive", "heart2", "beat2", BEAT("t/beat2"), { scope: { ids: "self", comps: ["t/beat2"] }, every: 30, always: true });
        let why = null; for (let i = 0; i < 120 && !why; i++) { s.advance(30000); for (const r of s.tick() ?? []) if (r.code === "budget" && /world's scripts/.test(r.why)) why = r.why; }
        return { set: set?.ok === true, why };
      } finally { D.setScriptConfig(was); } },
    good: (o) => o.set && /budget is 30/.test(o.why ?? "") && /asks 60/.test(o.why ?? "") && /caps it/.test(o.why ?? "") },
  { id: "B6e", what: "…with no owner value, a ceiling lowered below the server's default is the plain budget, and the refusal names no owner's value", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      const set = { ok: true };   // the owner sets nothing: the default (600) stands, then the operator lowers the ceiling to 30
      const was = D.setScriptConfig({ budget: 30 });
      try {
        s.call("olive", "create", { id: "heart3", model: "bell", place: { at: [0, 0] } });
        const BEAT = (c: string) => `world.on("tick", () => world.set("self", "${c}", { n: (world.get("self", "${c}")?.n ?? 0) + 1 }));\n`;
        install(s, "olive", "heart3", "beat", BEAT("t/beat"), { scope: { ids: "self", comps: ["t/beat"] }, every: 30, always: true });
        install(s, "olive", "heart3", "beat2", BEAT("t/beat2"), { scope: { ids: "self", comps: ["t/beat2"] }, every: 30, always: true });
        let why = null; for (let i = 0; i < 120 && !why; i++) { s.advance(30000); for (const r of s.tick() ?? []) if (r.code === "budget" && /world's scripts/.test(r.why)) why = r.why; }
        return { set: set?.ok === true, why };
      } finally { D.setScriptConfig(was); } },
    good: (o) => o.set && /budget is 30/.test(o.why ?? "") && !/asks/.test(o.why ?? "") },
  { id: "B6b", what: "§3d M3: each sponsor gets a fair share of the world's hour: bob's chatty timer can't starve olive's script", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { budget: 40 } });
      s.call("olive", "create", { id: "a", model: "crate", place: { at: [0, 0] } }); s.call("bob", "create", { id: "b", model: "crate", place: { at: [2, 0] } });
      const BEAT = `world.on("tick", () => world.set("self", "t/n", (world.get("self", "t/n") ?? 0) + 1));\n`;
      s.call("vic", "move", { to: [0, 0, 3] }); // someone is here, so timers run
      install(s, "bob", "b", "chatty", BEAT, { scope: { ids: "self", comps: ["t/n"] }, every: 5 });
      install(s, "olive", "a", "kind", onUse(`world.set("self", "t/n", (world.get("self", "t/n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("olive", "set", { id: "a", component: "reactions", value: { poke: { kind: "script", script: "kind" } } });
      for (let i = 0; i < 60; i++) { s.advance(5000); s.tick(); } // bob's timer has 5 minutes (two sponsors: 20 entries each of 40)
      const pokes = []; for (let i = 0; i < 3; i++) pokes.push(st(s, s.call("vic", "use", { id: "a", action: "poke" }, 20000)));
      const L = s.entries(); const by = (sp: string) => L.filter((e: any) => isScriptActor(e.actor) && (e.kind === "act" ? e.body?.sponsor : L[e.cause]?.body?.sponsor) === sp).length;
      return { bob: by("bob"), olive: by("olive"), pokes }; },
    good: (o) => o.bob === 20 && o.pokes.every((p: string) => p === "ran") && o.olive === 6 },
  { id: "B6c", what: "the per-script rate: 6 logged activations a minute per script, then refused (budget) until the minute passes", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "inc", onUse(`world.set("self", "t/n", (world.get("self", "t/n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { inc: { kind: "script", script: "inc" } } });
      const rs = []; for (let i = 0; i < 8; i++) rs.push(st(s, s.call("vic", "use", { id: "box", action: "inc" }, 1000)));
      s.advance(61000); rs.push(st(s, s.call("vic", "use", { id: "box", action: "inc" })));
      return { rs, n: comp(s, "box", "t/n") }; },
    good: (o) => JSON.stringify(o.rs) === JSON.stringify(["ran", "ran", "ran", "ran", "ran", "ran", "refused budget", "refused budget", "ran"]) && o.n === 7 },
  { id: "B7", what: "41 #7 grey goo: each use makes a child carrying the same script; the world's script count (12) stops it", run(s) { cast(s);
      s.call("bob", "create", { id: "root", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "root", "goo", onUse(`world.create({ model: "ball", parent: { to: world.self }, "script:goo": world.get("self", "script:goo"), reactions: world.get("self", "reactions") });`),
        { scope: { ids: "subtree", comps: ["model", "parent", "reactions", "script:*"], create: true }, on: ["use"] });
      s.call("bob", "set", { id: "root", component: "reactions", value: { grow: { kind: "script", script: "goo" } } });
      let at = "root", last = null;
      for (let i = 0; i < 20; i++) { last = s.call("vic", "use", { id: at, action: "grow" }, 1000); if (last.script?.status !== "ran") break;
        at = s.entries()[last.script.state].body.ops.find((o: any) => o.verb === "create").id; }
      return { scripts: s.call("olive", "scripts", {}).scripts?.length ?? 0, stoppedBy: st(s, last) }; },
    good: (o) => o.scripts === 12 && o.stoppedBy === "refused too-many" },
  { id: "B8", what: "41 #8 cascade ping-pong: two scripts each write what the other watches; it stops at depth 8, and a reader recomputes the depth", run(s) { cast(s);
      s.call("bob", "create", { id: "ea", model: "crate", place: { at: [0, 0] } }); s.call("bob", "create", { id: "eb", model: "crate", place: { at: [2, 0] } });
      install(s, "bob", "ea", "ping", `world.on("changed:t/pong", () => world.set("self", "t/ping", (world.get("eb", "t/pong") ?? 0) + 1));\n`, { scope: { ids: ["self", "eb"], comps: ["t/ping"] }, on: ["changed:t/pong"] });
      install(s, "bob", "eb", "pong", `world.on("changed:t/ping", () => world.set("self", "t/pong", (world.get("ea", "t/ping") ?? 0) + 1));\n`, { scope: { ids: ["self", "ea"], comps: ["t/pong"] }, on: ["changed:t/ping"] });
      const kick = s.call("bob", "set", { id: "eb", component: "t/pong", value: 0 });
      const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null; const sv = s.call("olive", "scripts", {}).scripts ?? [];
      return { kick: show(kick), scriptActs: s.entries().filter((e: any) => isScriptActor(e.actor) && e.kind === "act").length, readerMaxDepth: A?.maxDepth, flags: A?.flags.length, reran: A?.reran,
        ninth: sv.flatMap((x: any) => x.last).find((l: any) => l.code === "depth")?.why ?? null }; },
    good: (o) => o.scriptActs === 8 && o.readerMaxDepth === 8 && o.flags === 0 && o.reran === 8 && /depth 9 > 8/.test(o.ninth) },
  { id: "B9", what: "41 #11 lock: a script on a locked statue tries to move it (a capability never acts through a lock)", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "statue", "nudge", onUse(`world.set("self", "transform", { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] });`), { scope: { ids: "self", comps: ["transform"] }, on: ["use"] });
      s.call("bob", "set", { id: "statue", component: "reactions", value: { nudge: { kind: "script", script: "nudge" } } }); s.call("bob", "set", { id: "statue", component: "lock", value: true });
      const r = s.call("vic", "use", { id: "statue", action: "nudge" });
      return { r: st(s, r), pos: JSON.stringify(comp(s, "statue", "transform")?.pos) }; },
    good: (o) => o.r === "refused locked" && o.pos === "[0,0,0]" },
  { id: "B10", what: "41 #12 in flight: a lever's script writes the transform of a ball the engine is carrying", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("bob", "create", { id: "lever", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "lever", "yank", onUse(`world.set("ball", "transform", { pos: [5, 0, 5], q: [0, 0, 0, 1], scale: [1, 1, 1] });`), { scope: { ids: ["ball"], comps: ["transform"] }, on: ["use"] });
      s.call("bob", "set", { id: "lever", component: "reactions", value: { yank: { kind: "script", script: "yank" } } });
      const mv = s.call("vic", "move", { to: [0, 0, 0.3] }), gr = s.call("vic", "grab", { id: "ball" }), th = s.call("vic", "throw", { id: "ball", v: [0, 6, 0] });
      const r = s.call("ann", "use", { id: "lever", action: "yank" }, 200); s.call("olive", "wait", {}, 6000);
      return { setup: [show(mv), show(gr), show(th)], r: st(s, r), ball: JSON.stringify(comp(s, "ball", "transform")?.pos) }; },
    good: (o) => o.setup.every((x: string) => x === "ok") && o.r === "refused in-flight" && o.ball !== "[5,0,5]" },
  { id: "B14", what: "41 #18 + recovery: a dormant script is adopted by an owner (explicit, logged); two racing owners: one wins by base; a builder can't", run(s) { cast(s, [["ann", "owner"], ["dan", "builder"]]);
      bell(s, "bob"); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      const dormant = s.call("olive", "scripts", {}).scripts?.[0]?.status; const base = s.call("olive", "inspect", { id: "bell1" }).versions?.["script:bell"];
      const dan = s.call("dan", "adopt", { id: "bell1", script: "bell" }), olive = s.call("olive", "adopt", { id: "bell1", script: "bell", base }), ann = s.call("ann", "adopt", { id: "bell1", script: "bell", base });
      const sv = s.call("olive", "scripts", {}).scripts?.[0]; const ring = s.call("vic", "use", { id: "bell1", action: "ring" });
      const act = s.entries().find((e: any) => e.kind === "act" && e.verb === "adopt" && e.body?.adopts); // (dan's refused try is logged too, R7)
      return { dormant, dan: code(dan), olive: show(olive), ann: code(ann), now: `${sv?.status} ${sv?.sponsor}`, ring: ring.script ? `${ring.script.status} ${ring.script.sponsor}` : show(ring), logged: act ? `${act.actor} was ${act.body.adopts?.was}` : null }; },
    good: (o) => o.dormant === "dormant" && o.dan === "rights" && o.olive === "ok" && o.ann === "stale" && o.now === "active olive" && o.ring === "ran olive" && o.logged === "olive was bob" },
  { id: "B15", what: "a banned sponsor's scripts are suspended (nothing runs); the ban lives in the moderator log, not the world log", run(s) { cast(s);
      bell(s, "bob"); const ban = s.call("olive", "ban", { who: "bob" }); const n0 = s.entries().length;
      const r = s.call("vic", "use", { id: "bell1", action: "ring" }); const sv = s.call("olive", "scripts", {}).scripts?.[0];
      return { ban: show(ban), r: st(s, r), why: sv?.why, status: sv?.status, newKinds: kinds(s.entries().slice(n0)), worldLogHasBan: s.entries().some((e: any) => JSON.stringify(e).includes('"ban"')),
        modLog: s.w().mod.some((m: any) => m.verb === "ban" && m.who === "bob") }; },
    good: (o) => o.r === "suspended" && o.status === "suspended" && /banned/.test(o.why) && JSON.stringify(o.newKinds) === '{"act":1}' && !o.worldLogHasBan && o.modLog },
  { id: "B16", what: "no-op elision (a stated rule for script batches, §3d): a use that re-sets the same value logs the visitor's act and nothing else", run(s) { cast(s);
      s.call("bob", "create", { id: "lamp", components: { label: "lamp", transform: { pos: [0, 0, 0] } } });
      install(s, "bob", "lamp", "on", onUse(`world.set("self", "light", { kind: "point", color: 1, intensity: 1, range: 6, decay: 2 });`), { scope: { ids: "self", comps: ["light"] }, on: ["use"] });
      s.call("bob", "set", { id: "lamp", component: "reactions", value: { on: { kind: "script", script: "on" } } });
      const n0 = s.entries().length; const a = s.call("vic", "use", { id: "lamp", action: "on" }); const n1 = s.entries().length; const b = s.call("vic", "use", { id: "lamp", action: "on" });
      return { first: a.script?.status, second: b.script?.status, firstKinds: kinds(s.entries().slice(n0, n1)), secondKinds: kinds(s.entries().slice(n1)) }; },
    good: (o) => o.first === "ran" && o.second === "nothing" && JSON.stringify(o.firstKinds) === '{"act":2,"change":1}' && JSON.stringify(o.secondKinds) === '{"act":1}' },
  { id: "B17", what: "install rules: a builder's `always`, a 1 s timer, a visitor's install, and a builder's install after the owner turns off the builder role's scripts permission (role-defs; script-settings.install is gone)", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } }); const t = onUse(`world.set("self", "t/a", 1);`);
      const always = install(s, "bob", "box", "a", t, { scope: { ids: "self", comps: ["t/a"] }, every: 5, always: true }).r;
      const fast = install(s, "bob", "box", "b", t, { scope: { ids: "self", comps: ["t/a"] }, every: 1 }).r;
      const src = install(s, "bob", "box", "ok", t, { scope: { ids: "self", comps: ["t/a"] }, on: ["use"] }).src;
      const vic = s.call("vic", "set", { id: "box", component: "script:c", value: { src, scope: { ids: "self", comps: ["t/a"] } } });
      const gone = s.call("olive", "set", { id: "@world", component: "script-settings", value: { install: "owner" } });
      s.call("olive", "set", { id: "@world", component: "role-defs", value: { builder: { can: { scripts: false } } } });
      const raised = install(s, "bob", "box", "d", t, { scope: { ids: "self", comps: ["t/a"] }, on: ["use"] }).r;
      return { always, fast, vic, raised, gone }; },
    good: (o) => code(o.always) === "rights" && /always/.test(o.always.refused.reason) && code(o.fast) === "bounds" && /every is 1; it must be ≥ 5/.test(o.fast.refused.reason) && code(o.vic) === "rights" && code(o.raised) === "rights" && /scripts permission/.test(o.raised.refused.reason) && code(o.gone) === "schema" },
  { id: "B18", what: "sponsor = the latest write that changes more than `paused` (§5 Two views; R on F4): an owner who EDITS bob's script (its knobs) answers for it; bob is demoted; it runs on olive's rights", run(s) { cast(s);
      bell(s, "bob"); const v = comp(s, "bell1", "script:bell");
      s.call("olive", "set", { id: "bell1", component: "script:bell", value: { ...v, knobs: { tone: "low" } } });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      const r = s.call("vic", "use", { id: "bell1", action: "ring" }); const sv = s.call("olive", "scripts", {}).scripts?.[0];
      return { r: st(s, r), sponsor: sv?.sponsor, status: sv?.status }; },
    good: (o) => o.r === "ran" && o.sponsor === "olive" && o.status === "active" },
  { id: "PA1", what: "R on F4: pausing adopts nothing. bob's script, bob demoted (dormant); an owner pauses and resumes it: the sponsor stays bob, it stays dormant, and the status says who paused it and when (from the log, never stored)", run(s) { cast(s);
      bell(s, "bob"); s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      const p = s.call("olive", "set", { id: "bell1", component: "script:bell", value: { paused: true }, merge: true });
      const paused = s.call("olive", "scripts", {}).scripts?.[0]; const use1 = s.call("vic", "use", { id: "bell1", action: "ring" });
      const value = comp(s, "bell1", "script:bell");
      s.call("olive", "set", { id: "bell1", component: "script:bell", value: { paused: false }, merge: true });
      const after = s.call("olive", "scripts", {}).scripts?.[0]; const use2 = s.call("vic", "use", { id: "bell1", action: "ring" });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } }); const use3 = s.call("vic", "use", { id: "bell1", action: "ring" });
      const act3 = s.entries()[use3.script?.act];
      const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null;
      return { p: show(p), pausedStatus: paused?.status, pausedBy: paused?.pausedBy, pausedAt: Number.isInteger(paused?.pausedAt), why: paused?.why, use1: st(s, use1),
        stored: Object.keys(value ?? {}).sort().join(","), sponsor: after?.sponsor, status: after?.status, use2: st(s, use2), use3: st(s, use3), act3Sponsor: act3?.body?.sponsor, auditFlags: A?.flags.map((f: any) => f.check) ?? null }; },
    good: (o) => o.p === "ok" && o.pausedStatus === "paused" && o.pausedBy === "olive" && o.pausedAt && /paused by olive at seq \d+/.test(o.why) && o.use1 === "paused"
      && o.stored === "on,paused,scope,src" && o.sponsor === "bob" && o.status === "dormant" && o.use2 === "refused rights" && o.use3 === "ran" && o.act3Sponsor === "bob" && JSON.stringify(o.auditFlags) === "[]" },
  { id: "PA4", what: "review r2 #3: only a write that changes nothing but `paused` (against the value just before it, in the same write) skips install checks: adopt, [delete, set] and [set, set] are installs", run(s) { cast(s);
      bell(s, "bob"); const v = comp(s, "bell1", "script:bell");
      const wide = { ...v, scope: { ids: ["self", "@world"], comps: ["t/bell", "script-settings"], say: true } };
      const owner = s.call("olive", "set", { id: "bell1", component: "script:bell", value: wide }); // an owner may widen it: now olive's
      const adopt = s.call("bob", "adopt", { id: "bell1", script: "bell" });
      const reset = s.call("bob", "batch", { ops: [{ verb: "delete", args: { id: "bell1", component: "script:bell" } }, { verb: "set", args: { id: "bell1", component: "script:bell", value: wide } }] });
      const twice = s.call("bob", "batch", { ops: [{ verb: "set", args: { id: "bell1", component: "script:bell", value: v } }, { verb: "set", args: { id: "bell1", component: "script:bell", value: wide } }] });
      const pause = s.call("bob", "set", { id: "bell1", component: "script:bell", value: { paused: true }, merge: true }); // a pause is still his to flip (creator)
      return { owner: show(owner), adopt: code(adopt), reset: code(reset), twice: code(twice), pause: show(pause), sponsor: s.call("olive", "scripts", {}).scripts?.[0]?.sponsor }; },
    good: (o) => o.owner === "ok" && o.adopt === "rights" && o.reset === "rights" && o.twice === "rights" && o.pause === "ok" && o.sponsor === "olive" },
  { id: "PA3", what: "the edit UI's permission: the inspector (shared/editschema.js, the same schema the VR quad and agents' edit use) shows each script as a card with a 'paused' check; flipping it plans one merged {paused} set, which the authority takes from an owner, and the sponsor stays", run(s) { cast(s);
      bell(s, "bob");
      const ES = await_ES; const RV = await_RV;
      const ent = () => RV.viewOf("bell1", s.w().state().entities.bell1.c);
      const sch = ES.inspectSchema(ent(), "bell1"); const sec = sch.sections?.list?.find((x: any) => x.key === "script:bell");
      const field = sch.groups.find((g: any) => g.group === "script")?.fields?.find((f: any) => f.k === "bell");
      const plan = ES.editOps(ent(), "bell1", { "script.bell": true });
      const r = plan.ops.length === 1 ? s.call("olive", plan.ops[0].verb, plan.ops[0].args) : null;
      const sv = s.call("olive", "scripts", {}).scripts?.[0];
      const after = ES.inspectSchema(ent(), "bell1").groups.find((g: any) => g.group === "script")?.fields?.[0]?.value;
      const back = ES.editOps(ent(), "bell1", { "script.bell": false }); const r2 = s.call("olive", back.ops[0].verb, back.ops[0].args);
      return { title: sec?.title, rows: sec?.fields, field: field ? `${field.t} ${field.label} ${field.value}` : null, op: plan.ops[0], errors: plan.errors, r: show(r), status: sv?.status, sponsor: sv?.sponsor, pausedBy: sv?.pausedBy, after, r2: show(r2),
        resumed: s.call("olive", "scripts", {}).scripts?.[0]?.status }; },
    good: (o) => o.title === "Script · bell" && o.rows?.[0] === "script.bell" && o.field === "check paused false" && JSON.stringify(o.op?.args) === '{"id":"bell1","component":"script:bell","value":{"paused":true},"merge":true}'
      && o.r === "ok" && o.status === "paused" && o.sponsor === "bob" && o.pausedBy === "olive" && o.after === true && o.r2 === "ok" && o.resumed === "active" },
  { id: "PA2", what: "pausing needs no knowledge of the script: {paused: true} with merge stops it even when its source is gone (no install checks for a pause); a non-creator builder still can't, an owner can", run(s) { cast(s);
      bell(s, "bob"); const src = comp(s, "bell1", "script:bell").src;
      fs.rmSync(path.join(root, "store", `${src.replace(/[^a-z0-9]/g, "-")}.json`)); // the source blob is gone
      const ann = s.call("ann", "set", { id: "bell1", component: "script:bell", value: { paused: true }, merge: true });
      const olive = s.call("olive", "set", { id: "bell1", component: "script:bell", value: { paused: true }, merge: true });
      const knobs = s.call("olive", "set", { id: "bell1", component: "script:bell", value: { knobs: { x: 1 } }, merge: true }); // a real edit is an install: refused, the source is missing
      return { ann: code(ann), olive: show(olive), knobs: code(knobs), status: s.call("olive", "scripts", {}).scripts?.[0]?.status }; },
    good: (o) => o.ann === "rights" && o.olive === "ok" && o.knobs === "not-found" && o.status === "paused" },
  { id: "B19", what: "replay never runs code: the fold alone (no door, no sandbox, no blobs) gives the authority's world after script activations", run(s) { cast(s);
      bell(s, "bob"); for (let i = 0; i < 3; i++) s.call("vic", "use", { id: "bell1", action: "ring" });
      const f = F.fold(F.readLog(fs.readFileSync(s.logPath))); const foldSrc = fs.readFileSync(TREE + "shared/protocol/fold.js", "utf8");
      return { same: F.digest(f) === F.digest(s.w().state()), rung: f.entities.bell1?.c["t/bell"]?.rung, foldImportsVm: /sandbox|scriptaudit|quickjs/.test(foldSrc) }; },
    good: (o) => o.same && o.rung === 3 && !o.foldImportsVm },
  { id: "B20", what: "kill permissions: paused: true and @world.script-settings.run: false stop it; runaway work dies by fuel; 5 failures in a row pause it until it is set again", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "tick", onUse(`world.set("self", "t/n", (world.get("self", "t/n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      install(s, "bob", "box", "spin", onUse(`while (true) {}`), { scope: { ids: "self", comps: ["t/m"] }, on: ["use"] });
      install(s, "bob", "box", "oops", onUse(`throw new Error("bad input");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { tick: { kind: "script", script: "tick" }, spin: { kind: "script", script: "spin" }, oops: { kind: "script", script: "oops" } } });
      const v = comp(s, "box", "script:tick"); s.call("olive", "set", { id: "box", component: "script:tick", value: { ...v, paused: true } });
      const paused = s.call("vic", "use", { id: "box", action: "tick" }).script?.status; s.call("olive", "set", { id: "box", component: "script:tick", value: { ...v, paused: false } });
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { run: false } }); const stopped = s.call("vic", "use", { id: "box", action: "tick" }).script?.status;
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { run: true } }); const runs = s.call("vic", "use", { id: "box", action: "tick" }).script?.status;
      const spin = s.call("vic", "use", { id: "box", action: "spin" }).script;
      const fails = Array.from({ length: 6 }, () => s.call("vic", "use", { id: "box", action: "oops" }, 11000).script?.status);
      const sv = (s.call("olive", "scripts", {}).scripts ?? []).find((x: any) => x.script === "script:oops");
      const fv = comp(s, "box", "script:oops"); s.call("bob", "set", { id: "box", component: "script:oops", value: { ...fv, knobs: { fixed: 1 } } });
      const afterFix = s.call("vic", "use", { id: "box", action: "oops" }).script?.status;
      return { paused, stopped, runs, spin: spin ? `${spin.status} ${spin.code}` : null, fails, status: sv?.status, afterFix, n: comp(s, "box", "t/n") ?? null }; },
    good: (o) => o.paused === "paused" && o.stopped === "stopped" && o.runs === "ran" && o.spin === "failed fuel" && JSON.stringify(o.fails) === '["failed","failed","failed","failed","failed","paused"]' && o.status === "paused" && o.afterFix === "failed" && o.n === 1 },
  { id: "B21", what: "say needs scope.say: a script without it that says something is refused whole (its write too)", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "talk", onUse(`world.set("self", "t/a", 1); world.say("hello");`), { scope: { ids: "self", comps: ["t/a"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "talk" } } });
      const r = s.call("vic", "use", { id: "box", action: "go" }); return { r: st(s, r), a: comp(s, "box", "t/a") ?? null, says: s.entries().filter((e: any) => e.kind === "say").length }; },
    good: (o) => o.r === "refused scope" && o.a === null && o.says === 0 },
  { id: "B22", what: "create needs scope.create, and what it creates must hang inside its subtree", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "mk", onUse(`world.create({ model: "ball", parent: { to: world.self } });`), { scope: { ids: "subtree", comps: ["model", "parent"] }, on: ["use"] });
      install(s, "bob", "box", "out", onUse(`world.create({ model: "ball" });`), { scope: { ids: "subtree", comps: ["model", "parent"], create: true }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { mk: { kind: "script", script: "mk" }, out: { kind: "script", script: "out" } } });
      const mk = s.call("vic", "use", { id: "box", action: "mk" }), out = s.call("vic", "use", { id: "box", action: "out" });
      return { mk: st(s, mk), out: st(s, out), things: Object.keys(s.w().state().entities).length }; },
    good: (o) => o.mk === "refused scope" && o.out === "refused scope" && o.things === 2 },
  // ---------------- D: determinism and the reader's audit ----------------
  { id: "D1", what: "41 #14/#15: a reader re-runs every activation from what its act records (head, event, ts, seed, presence reads) and gets the logged batch; a forged sponsor and an altered op are flagged", run(s) { cast(s);
      s.call("bob", "create", { id: "dice", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "dice", "roll", onUse(`world.set("self", "t/face", { n: Math.floor(Math.random() * 6), near: world.near(3).length, here: world.count(), at: Date.now(), by: e.by });`), { scope: { ids: "self", comps: ["t/face"] }, on: ["use"] });
      s.call("bob", "set", { id: "dice", component: "reactions", value: { roll: { kind: "script", script: "roll" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); for (let i = 0; i < 3; i++) s.call("vic", "use", { id: "dice", action: "roll" });
      s.call("vic", "move", { to: [0, 0, 5] }); s.call("vic", "use", { id: "dice", action: "roll" }, 2000); // walked away: the 4th roll's near is []
      if (!AU) return { absent: true };
      const L0 = s.entries(), get = s.w().getBlob, run = SB.runScript;
      const honest = AU.auditScripts(L0, get, { run });
      const copy = () => F.readLog(Buffer.from(L0.map((e: any) => JSON.stringify(e)).join("\n") + "\n"));
      const k = L0.findIndex((e: any) => isScriptActor(e.actor) && e.kind === "act"); const forged = copy(); forged[k].body.sponsor = "olive";
      const j = L0.findLastIndex((e: any) => isScriptActor(e.actor) && e.kind === "change"); const tampered = copy(); tampered[j].body.value.n = (tampered[j].body.value.n + 1) % 6;
      const lost = copy(); for (const e of lost) if (isScriptActor(e.actor) && e.kind === "act") delete e.body.reads; // without the recorded reads the re-run asks reads the act doesn't record
      return { acts: honest.acts, reran: honest.reran, honestFlags: honest.flags, reads: L0.filter((e: any) => isScriptActor(e.actor) && e.kind === "act").map((e: any) => JSON.stringify(e.body.reads?.near?.[0] ?? "?")),
        forged: AU.auditScripts(forged, get, { run }).flags.map((x: any) => x.check), tampered: AU.auditScripts(tampered, get, { run }).flags.map((x: any) => `${x.seq}:${x.check}`), lost: AU.auditScripts(lost, get, { run }).flags.map((x: any) => x.check) }; },
    good: (o) => o.acts === 4 && o.reran === 4 && o.honestFlags.length === 0 && JSON.stringify(o.reads) === JSON.stringify(['{"r":3,"n":1}', '{"r":3,"n":1}', '{"r":3,"n":1}', '{"r":3,"n":0}']) && o.forged.includes("sponsor") && o.tampered.some((x: string) => /:rerun$/.test(x)) && o.lost.includes("reads") },
  { id: "D4", what: "consent gaps 6b: a script's act records what its presence reads asked and how many came back, never who (no ids, no names); an act whose result names who was near is SKIPPED by the auditor (said why), never verified or flagged; a forged read shape is flagged", run(s) { cast(s);
      s.call("bob", "create", { id: "sign", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "sign", "roll", onUse(`const who = world.near(3); world.set("self", "t/seen", { who, name: world.name(e.by), n: who.length });`), { scope: { ids: "self", comps: ["t/seen"] }, on: ["use"] });
      install(s, "bob", "sign", "count", onUse(`world.set("self", "t/count", { n: world.near(3).length });`), { scope: { ids: "self", comps: ["t/count"] }, on: ["use"] });
      s.call("bob", "set", { id: "sign", component: "reactions", value: { roll: { kind: "script", script: "roll" }, count: { kind: "script", script: "count" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); const r1 = s.call("vic", "use", { id: "sign", action: "roll" }); const r2 = s.call("vic", "use", { id: "sign", action: "count" });
      const acts = s.entries().filter((e: any) => isScriptActor(e.actor) && e.kind === "act");
      if (!AU) return { absent: true };
      const L0 = s.entries(), get = s.w().getBlob, run = SB.runScript; const A = AU.auditScripts(L0, get, { run });
      const copy = () => F.readLog(Buffer.from(L0.map((e: any) => JSON.stringify(e)).join("\n") + "\n"));
      const forged = copy(); const k = forged.findLastIndex((e: any) => isScriptActor(e.actor) && e.kind === "act"); forged[k].body.reads.near[0].r = 9;
      return { r1: st(s, r1), r2: st(s, r2), reads: acts.map((e: any) => e.body.reads), actText: JSON.stringify(acts), seen: s.w().state().entities.sign.c["t/seen"],
        reran: A.reran, skipped: A.skipped?.map((x: any) => x.why) ?? null, flags: A.flags.map((x: any) => x.check), forged: AU.auditScripts(forged, get, { run }).flags.map((x: any) => x.check) }; },
    opts: { nameOf: (id: string) => NAMES[id] ?? null },
    good: (o) => o.r1 === "ran" && o.r2 === "ran" && JSON.stringify(o.reads) === JSON.stringify([{ near: [{ r: 3, n: 1 }], names: 1 }, { near: [{ r: 3, n: 1 }] }])
      && !/Vic/.test(o.actText) && o.seen?.name === "Vic"
      && o.reran === 1 && o.skipped?.length === 1 && /who was near/.test(o.skipped[0]) && o.flags.length === 0 && o.forged.includes("reads") },
  { id: "D2", what: "41 §3.7: an activation's clock is frozen at its act's ts, and Math.random is seeded from its act: the same seed gives the same numbers, another seed others", run(s) { cast(s);
      if (!SB) return { absent: true };
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "clock", onUse(`const t0 = Date.now(); let x = 0; for (let i = 0; i < 2e5; i++) x += i; world.set("self", "t/t", { now: Date.now(), same: Date.now() === t0 && new Date().getTime() === t0 && world.now === t0, r: [Math.random(), Math.random()] });`), { scope: { ids: "self", comps: ["t/t"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "clock" } } });
      const r1 = useSteady(s, "vic", { id: "box", action: "go" }); const t1 = comp(s, "box", "t/t"); const act1 = s.entries()[r1.script?.act];
      const r2 = useSteady(s, "vic", { id: "box", action: "go" }); const t2 = comp(s, "box", "t/t");
      // the re-run is about determinism, not time: a slow host gets the whole 30 s to replay it (wallMs is only the backstop)
      const again = SB.runScript({ text: s.w().getBlob(act1.body.src).text, self: "box", key: "script:clock", event: act1.body.event, now: act1.ts, seed: act1.body.seed, st: F.fold(s.entries(), { until: act1.body.head }), limits: { wallMs: 30000 } });
      return { nowIsTs: t1?.now === act1?.ts, same: t1?.same, r1: t1?.r, r2: t2?.r, rerun: again.ops?.[0]?.value?.r }; },
    good: (o) => o.nowIsTs && o.same === true && JSON.stringify(o.r1) === JSON.stringify(o.rerun) && JSON.stringify(o.r1) !== JSON.stringify(o.r2) },
  { id: "D3", what: "the sandbox's time zone is UTC wherever the authority runs: local-time methods, parsing and Date() agree under TZ=UTC and TZ=Asia/Tokyo", run() {
      if (!SB) return { absent: true };
      const f = path.join(root, "tz-probe.ts");
      fs.writeFileSync(f, `import { runScript } from ${JSON.stringify(TREE + "shared/protocol/sandbox.js")};
const r = runScript({ self: "b", key: "script:x", now: 1800000000000, seed: "ab".repeat(32), st: { entities: { b: { born: 1, c: {} } } }, event: { on: "use" },
  text: 'world.on("use", () => { const d = new Date(); world.set("self", "t/t", [d.getHours(), d.getTimezoneOffset(), String(d), Date(), new Date(2020, 0, 1).getTime(), Date.parse("2020-01-01T00:00"), new Date("2020-01-01 12:30").getTime(), d.toLocaleString(), d.toTimeString()]); })' });
console.log(JSON.stringify(r.ops?.[0]?.value ?? r));\n`);
      const out = (tz: string) => Bun.spawnSync(["bun", f], { env: { ...process.env, TZ: tz, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }).stdout.toString().trim();
      return { utc: out("UTC"), tokyo: out("Asia/Tokyo") }; },
    good: (o) => o.utc.startsWith("[8,0,") && o.utc === o.tokyo },
  { id: "B23", what: "the authority's own cost is metered, written or not: a script whose runs write nothing is held to `runs` a minute (the server's configuration, and its refusal says so), and a sponsor to `cpu` ms of sandbox time (the owner tightens it in script-settings)", run(s) { cast(s);
      s.call("bob", "create", { id: "ear", model: "crate", place: { at: [0, 0] } }); s.call("ann", "create", { id: "mill", model: "crate", place: { at: [2, 0] } });
      install(s, "bob", "ear", "idle", `world.on("say", () => {});\n`, { scope: { ids: "self", comps: ["t/n"] }, on: ["say"] });
      install(s, "ann", "mill", "grind", `world.on("say", () => { let x = 0; for (let i = 0; i < 1e5; i++) x += Math.sqrt(i); });\n`, { scope: { ids: "self", comps: ["t/n"] }, on: ["say"] });
      const last = (id: string) => s.call("olive", "scripts", {}).scripts.find((x: any) => x.id === id).last.at(-1);
      // phase 1: runs (the server's: an operator's setScriptConfig; cpu at its default is out of the way of an idle script)
      const was = D.setScriptConfig({ runs: 5 });
      const ear: string[] = []; for (let i = 0; i < 8; i++) { s.call("vic", "say", { text: `hi ${i}` }, 600); ear.push(last("ear")?.status); }
      const earWhy = last("ear")?.why;
      // phase 2: cpu (runs out of the way), a minute later
      s.advance(61000); D.setScriptConfig({ runs: 600 }); s.call("olive", "set", { id: "@world", component: "script-settings", value: { cpu: 25 } });   // ≈10–16 ms a run quiet (isolated or not), ≈30–45 loaded: either way the cap binds before the sixth
      const mill: string[] = []; for (let i = 0; i < 6; i++) { s.call("vic", "say", { text: `ho ${i}` }, 600); mill.push(last("mill")?.status); }
      D.setScriptConfig(was);
      return { ear, earWhy, mill, why: last("mill")?.why, millMs: (s.w().presence.scriptRuns ?? []).filter((x: any) => x.sponsor === "ann").map((x: any) => x.ms) }; },
    good: (o) => JSON.stringify(o.ear) === '["nothing","nothing","nothing","nothing","nothing","refused","refused","refused"]' && /ran 5 times/.test(o.earWhy)
      && /this server's limit/.test(o.earWhy) && !/script-settings/.test(o.earWhy)   // review of #260: runs is the server's, so the refusal names no owner field
      && o.mill[0] === "nothing" && o.mill.at(-1) === "refused" && /ann's scripts used \d+ ms of the authority's time/.test(o.why) },
  { id: "B24", what: "a guest sponsor's rights are a guest's: once the owner removes the role it was given, its script is dormant, even where strangers default to builder", opts: { kindOf: (id: string) => (id === "gus" ? "anon" : "human") },
    run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder" } });
      s.call("olive", "set", { id: "@world", component: "roles:gus", value: { role: "builder" } });
      s.call("gus", "create", { id: "gbox", model: "crate", place: { at: [0, 0] } });
      install(s, "gus", "gbox", "g", onUse(`world.set("self", "t/n", 1);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("gus", "set", { id: "gbox", component: "reactions", value: { go: { kind: "script", script: "g" } } });
      s.call("olive", "delete", { id: "@world", component: "roles:gus" });
      const direct = s.call("gus", "set", { id: "gbox", component: "label", value: "x" }); const r = s.call("vic", "use", { id: "gbox", action: "go" });
      return { direct: code(direct), r: st(s, r), status: s.call("olive", "scripts", { id: "gbox" }).scripts?.[0]?.status }; },
    good: (o) => o.direct === "rights" && o.r === "refused rights" && o.status === "dormant" },
  { id: "B25", what: "a world whose stored values wait for the maintenance command refuses every write until it runs: a timer's and an arrival's activations too, not only requests", run(s) { cast(s);
      if (!D.tick || !D.presenceEvent) return { absent: true };
      const BEAT = `world.on("tick", () => world.set("self", "t/n", { n: (world.get("self", "t/n")?.n ?? 0) + 1 }));\nworld.on("enter", () => world.set("self", "t/n", { n: (world.get("self", "t/n")?.n ?? 0) + 1 }));\n`;
      s.call("olive", "create", { id: "clock", model: "crate", place: { at: [0, 0] } });
      install(s, "olive", "clock", "beat", BEAT, { scope: { ids: "self", comps: ["t/n"] }, every: 5, always: true, on: ["enter"] });
      // a value stored in an old spelling no reader serves (a grabbable's pose: grab.js reads anim), as an old log holds it
      s.call("olive", "create", { id: "cup", model: "crate", place: { at: [2, 0] } });
      const w = s.w(); T += 100; process.env.PROTOCOL_NOW = String(T);
      const a = w.append({ kind: "act", actor: "olive", verb: "set", body: { request: { id: "cup", component: "grabbable" } } });
      w.append({ kind: "change", actor: "olive", cause: a, verb: "set", body: { id: "cup", comp: "grabbable", value: { pose: "pistol" } } }, STOR.CHANGE);
      const blocking = D.maintenanceNeeds(w).blocking;
      const req = s.call("olive", "set", { id: "clock", component: "label", value: "x" }), n0 = s.entries().length;   // (its refusal is on the record)
      const ticks: string[] = []; for (let i = 0; i < 3; i++) { s.advance(5000); for (const x of s.tick() ?? []) ticks.push(`${x.status}${x.code ? ` ${x.code}` : ""}`); }
      T += 100; process.env.PROTOCOL_NOW = String(T); const enter = D.presenceEvent(s.w(), "enter", "vic").map((x: any) => `${x.status}${x.code ? ` ${x.code}` : ""}`);
      const written = s.entries().slice(n0).map((e: any) => `${e.kind}:${e.verb}:${e.actor}`), n = comp(s, "clock", "t/n") ?? null;
      D.maintain(s.w(), { by: "olive" }); const after: string[] = [];   // once the command has run, the timer writes again
      for (let i = 0; i < 2; i++) { s.advance(5000); for (const x of s.tick() ?? []) after.push(x.status); }
      return { blocking, req: code(req), ticks, enter, written, n, after, nAfter: comp(s, "clock", "t/n")?.n ?? null }; },
    good: (o) => o.blocking.includes("rename-components") && o.req === "repair-needed" && o.ticks.length >= 2 && o.ticks.every((t: string) => t === "refused repair-needed")
      && JSON.stringify(o.enter) === '["refused repair-needed"]' && o.written.length === 0 && o.n === null && o.after.includes("ran") && o.nAfter >= 1 },
  { id: "B26", what: "…and a log changed outside the purge rule (record-altered) stops them the same way: a timer's and an arrival's activations write nothing", run(s) { cast(s);
      if (!D.tick || !D.presenceEvent) return { absent: true };
      const BEAT = `world.on("tick", () => world.set("self", "t/n", { n: (world.get("self", "t/n")?.n ?? 0) + 1 }));\nworld.on("enter", () => world.set("self", "t/n", { n: (world.get("self", "t/n")?.n ?? 0) + 1 }));\n`;
      s.call("olive", "create", { id: "clock", model: "crate", place: { at: [0, 0] } });
      install(s, "olive", "clock", "beat", BEAT, { scope: { ids: "self", comps: ["t/n"] }, every: 5, always: true, on: ["enter"] });
      s.call("olive", "create", { id: "cup", model: "crate", place: { at: [2, 0] } }); s.call("olive", "set", { id: "cup", component: "label", value: "cup" });
      // strip the label's value to a commit, with no purge: as a copy of the log changed by hand would hold it
      const lines = fs.readFileSync(s.logPath, "utf8").split("\n"); const k = lines.findLastIndex((l) => l.includes('"label"') && l.includes('"kind":"change"'));
      const e = JSON.parse(lines[k]); const { value: _v, salt: _s, ...rest } = e.body; e.body = { ...rest, commit: "0".repeat(64) }; lines[k] = JSON.stringify(e); fs.writeFileSync(s.logPath, lines.join("\n"));
      const w = openWorld(s.name); const req = (() => { T += 100; process.env.PROTOCOL_NOW = String(T); return D.request(w, "olive", "set", { id: "clock", component: "label", value: "x" }); })();
      const n0 = w.entries.length, ticks: string[] = [];
      for (let i = 0; i < 3; i++) { T += 5000; process.env.PROTOCOL_NOW = String(T); for (const x of D.tick(w) ?? []) ticks.push(`${x.status}${x.code ? ` ${x.code}` : ""}`); }
      T += 100; process.env.PROTOCOL_NOW = String(T); const enter = D.presenceEvent(w, "enter", "vic").map((x: any) => `${x.status}${x.code ? ` ${x.code}` : ""}`);
      return { req: code(req), ticks, enter, written: w.entries.slice(n0).map((x: any) => `${x.kind}:${x.verb}:${x.actor}`) }; },
    good: (o) => o.req === "record-altered" && o.ticks.length >= 2 && o.ticks.every((t: string) => t === "refused record-altered") && JSON.stringify(o.enter) === '["refused record-altered"]' && o.written.length === 0 },
  // ---------------- R: runaway work ----------------
  ...[["R1", "while (true) {}", "fuel"], ["R2", "function f() { return f(); } f();", "stack"], ["R3", `let s = "x"; for (;;) s += s;`, "memory"],
      ["R4", `for (let i = 0; i < 1000; i++) world.get("self");`, "calls"], ["R5", `for (let i = 0; i < 40; i++) world.set("self", "t/n", i);`, "too-big"], ["R6", "this is not javascript", "syntax"]].map(([id, body, want]) => ({
    id, what: `41 #9 runaway: ${body.slice(0, 40)} → ${want}; it writes nothing and the next activation still runs`, run(s: any) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const src = s.w().putBlob({ lang: "js", api: 1, text: `world.on("use", (e) => { if (e.args?.ok) { world.set("self", "t/n", 1); return; } ${body} });\n` });
      const inst = s.call("bob", "set", { id: "box", component: "script:x", value: { src, scope: { ids: "self", comps: ["t/n"] }, on: ["use"] } });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "x" } } }); const n0 = s.entries().length;
      const r = s.call("vic", "use", { id: "box", action: "go" }); const scripted = s.entries().slice(n0).filter((e: any) => isScriptActor(e.actor)).length;
      const next = s.call("vic", "use", { id: "box", action: "go", args: { ok: true } });
      return { inst: show(inst), r: st(s, r), scripted, next: st(s, next) }; },
    good: (o: any) => (want === "syntax" ? o.inst.startsWith("refused syntax") : o.r === `failed ${want}` && o.scripted === 0 && o.next === "ran") })),
  // ---------------- I: isolation (a killable sandbox process per activation's VM side) ----------------
  { id: "I1", what: "isolation: a script stuck in a slow native builtin (indexOf on crafted text, a huge BigInt power, out of memory inside Array.fill) is stopped at its deadline and its process killed; the authority is back within it, another world answers at once, and the run is counted against its sponsor",
    run(s) { cast(s); const s2 = session(); cast(s2); s2.call("olive", "create", { id: "cup", model: "crate", place: { at: [0, 0] } });
      if (!SB?.isolationStats) return { absent: true };
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const HOSTILE = { idx: `const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b");`, pow: `(7n ** 300000n).toString().length;`, fill: `let a = []; for (;;) a.push(new Array(1e5).fill(1));` };
      for (const [k, body] of Object.entries(HOSTILE)) install(s, "bob", "box", k, onUse(body), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: Object.fromEntries(Object.keys(HOSTILE).map((k) => [k, { kind: "script", script: k }])) });
      warmUp(); // warm processes, as an authority with scripts has at load
      const k0 = SB.isolationStats().kills; const runs: any[] = [], starved: any[] = [];
      // spaced as the process's script duty spaces them in a door (I2 tests the duty): a killed process's spare is warm again
      // a run the host starved (unavailable) is stopped at the same deadline but says nothing about the builtin: asked again
      // (bounded), and every attempt must still be back within the deadline with the other world answering at once
      for (const k of Object.keys(HOSTILE)) for (let a = 0; a <= UNAVAILABLE_RETRIES; a++) { Bun.sleepSync(800); warmUp(); const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: k }); const ms = performance.now() - t0;
        const t1 = performance.now(); const other = s2.call("olive", "inspect", { id: "cup" }); const otherMs = performance.now() - t1;
        const run = { k, r: st(s, r), why: r.script?.why, ms: Math.round(ms), other: other.ok, otherMs: Math.round(otherMs) };
        if (run.r === "unavailable unavailable" && a < UNAVAILABLE_RETRIES) { starved.push(run); continue; } runs.push(run); break; }
      const counted = (s.w().presence.scriptRuns ?? []).filter((x: any) => x.sponsor === "bob").map((x: any) => x.ms);
      s.advance(61000);   // a fresh minute of the sponsor's CPU: three ~500 ms kills sit at its edge (on a loaded host, past it: refused budget)
      const after = useSteady(s, "vic", { id: "box", action: "idx" }); // the 4th failure in a row is still counted, never a hang (a starved run isn't a failure: asked again)
      const brief = (x: any) => ({ k: x.k, r: x.r, ms: x.ms, other: x.other, otherMs: x.otherMs, killed: /killed/.test(x.why ?? "") });
      return { fails: s.w().presence.scripts?.["box|idx"]?.fails, kills: SB.isolationStats().kills - k0, counted, after: st(s, after), starved: starved.map(brief), runs: runs.map(brief) }; },
    good: (o) => o.runs.every((x: any) => x.r === "failed time" && x.killed && x.ms < 700 && x.other && x.otherMs < 150) && o.starved.every((x: any) => x.ms < 700 && x.other && x.otherMs < 150)
      && o.kills >= 3 && o.counted.length >= 3 && o.counted.every((ms: number) => ms >= 250) && o.fails === 2 },
  { id: "I3", what: "isolation, back to back (duty opened, no spacing): kills faster than spares can start; each activation still returns within the warm-process wait + the deadline (300 + 500 ms), as time or unavailable, never longer", run(s) { cast(s);
      if (!SB?.isolationStats) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "idx", onUse(`const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { idx: { kind: "script", script: "idx" } } });
      process.env.EIDO_SANDBOX_TEST_DELAY = "3000"; // the spares started from here on are slow to start (a loaded host)
      const runs: string[] = []; let worst = 0;
      const each: number[] = [];
      for (let i = 0; i < 6; i++) { const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: "idx" }, 11000); const ms = performance.now() - t0; each.push(Math.round(ms)); worst = Math.max(worst, ms); runs.push(st(s, r)); }
      delete process.env.EIDO_SANDBOX_TEST_DELAY; Bun.sleepSync(3300); // let the slow spares finish starting before the next case
      return { runs, worst: Math.round(worst), each }; },
    good: (o) => o.worst < 300 + 500 + 200 && o.runs.every((x: string) => ["failed time", "unavailable unavailable", "paused", "refused budget"].includes(x)) && o.runs.includes("failed time") && o.runs.includes("unavailable unavailable") },
  { id: "I4", what: "review r2 #1: dry runs spend the authority's thread too: a visitor's 12 back-to-back dry uses of a hostile script are held to the duty and a dry-run rate (they used to run unmetered, 6 s)", run(s) { cast(s);
      if (!D.setScriptDuty) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "idx", onUse(`const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { idx: { kind: "script", script: "idx" } } });
      D.setScriptDuty({ maxMs: DUTY0.maxMs }); const t0 = performance.now(); const rs: string[] = [];
      for (let i = 0; i < 12; i++) { const r = s.call("vic", "use", { id: "box", action: "idx", dry: true }, 50); rs.push(`${r.script?.status} ${r.script?.code}`); }
      const ms = performance.now() - t0; D.setScriptDuty({ maxMs: 1e9 });
      return { ms: Math.round(ms), rs }; },
    good: (o) => o.ms < DUTY0.maxMs + 500 + 400 && o.rs.some((x: string) => /refused (busy|rate)/.test(x)) },
  { id: "I5", what: "review r2 #2: the authority's own work in a host call stays small: on a big world (1500 things with 300-number arrays), 32 writes then a read cost no whole-world copies", run(s) { cast(s);
      const big = Array.from({ length: 300 }, (_, i) => i);
      // a batch the authority finds too costly for one request (its time cap is real time: a slow host reaches it sooner) is
      // sent again as two halves; the setup only needs the 1500 things
      const refusedBatches: string[] = [];
      const put = (ops: any[]) => { const rb = s.call("olive", "batch", { ops }, 11000);
        if (!rb?.ok && rb?.refused?.code === "too-costly" && ops.length > 1) { refusedBatches.push(`split ${ops.length}`); put(ops.slice(0, ops.length >> 1)); put(ops.slice(ops.length >> 1)); }
        else if (!rb?.ok) refusedBatches.push(show(rb)); };
      for (let b = 0; b < 15; b++) put(Array.from({ length: 100 }, (_, i) => ({ verb: "create", args: { id: `t${b}-${i}`, components: { "t/data": { xs: big } } } }))); // each batch alone in the 10 s byte window: the charge is PRE-paid since C0 (10-15), so 6 s steps held two batches and tripped the cap
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "heavy", HEAVY, { scope: { ids: "self", comps: ["t/n", "t/m"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "heavy" } } });
      // the same script on an empty world, on this host, now: what the run costs without any world to copy. A whole-world
      // copy per write (the mutants below) costs ~32 copies of 1500 x 300 numbers, far past both bounds
      const s0 = session(); cast(s0); s0.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s0, "bob", "box", "heavy", HEAVY, { scope: { ids: "self", comps: ["t/n", "t/m"] }, on: ["use"] });
      s0.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "heavy" } } });
      warmUp(); const b0 = performance.now(); const r0 = useSteady(s0, "vic", { id: "box", action: "go" }); const ms0 = performance.now() - b0;
      warmUp(); const t0 = performance.now(); const r = useSteady(s, "vic", { id: "box", action: "go" }); const ms = performance.now() - t0;
      return { r: st(s, r), r0: st(s0, r0), ms: Math.round(ms), ms0: Math.round(ms0), m: comp(s, "box", "t/m"), things: Object.keys(s.w().state().entities).length, refusedBatches }; },
    good: (o) => o.r === "ran" && o.r0 === "ran" && o.ms < Math.max(400, 2 * o.ms0 + 150) && o.m === 1000 && o.things > 1500 },
  { id: "I6", what: "review r2 #4: a sandbox process that dies mid-run is noticed at once (end of file on its pipe), not at the deadline, even before it's reaped", run(s) { cast(s);
      if (!SB?.isolationStats) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "long", onUse(`const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "long" } } });
      const pid = SB.isolationStats().next; if (!pid) return { pid: null };
      Bun.spawn(["sh", "-c", `sleep 0.12; kill -9 ${pid}`]); // someone else kills it (an OOM killer, an operator)
      const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: "go" }); const ms = performance.now() - t0;
      return { r: st(s, r), why: r.script?.why, ms: Math.round(ms) }; },
    good: (o) => o.r === "failed sandbox" && /died/.test(o.why) && o.ms < 400 },
  { id: "I7", what: "review r2 (design note): fairness between worlds: one world's storm of short activations stops at its share of the authority's second, so another world's script still runs in that second", run(s) { cast(s, [["cat", "builder"]]); const s2 = session(); cast(s2);
      if (!D.setScriptDuty) return { absent: true };
      warmUp();
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { max: 40 } });
      for (let i = 0; i < 30; i++) { const who = ["bob", "cat", "ann"][i % 3]; s.call(who, "create", { id: `ear${i}`, model: "crate", place: { at: [i % 10 - 5, Math.floor(i / 10)] } });
        install(s, who, `ear${i}`, "grind", `world.on("say", () => { let x = 0; for (let k = 0; k < 1e5; k++) x += Math.sqrt(k); });\n`, { scope: { ids: "self", comps: ["t/n"] }, on: ["say"] }); }
      s2.call("olive", "create", { id: "cup", model: "crate", place: { at: [0, 0] } });
      install(s2, "olive", "cup", "go", onUse(`world.set("self", "t/n", 1);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s2.call("olive", "set", { id: "cup", component: "reactions", value: { go: { kind: "script", script: "go" } } });
      // calibrated, not guessed (Mica r3 on 0ff8bcad: on a fast host 30 fixed-size activations never filled a world's
      // share, {"ranA":30,"busyA":0}, so the row couldn't tell fair from unfair). World A's own storm runs once with the
      // duty wide open; the median activation cost HERE sizes the budget so A's share holds about four, on any host.
      D.setScriptDuty({ maxMs: 1e9 }); s.call("vic", "say", { text: "grind" });
      const costs = SD.dutyLog.map((d: any) => d.ms).sort((x: number, y: number) => x - y);
      if (costs.length < 20) return { calibration: `only ${costs.length} of 30 activations measured` };
      const cost = costs[costs.length >> 1], maxMs = (4 * cost) / SD.DUTY.worldShare;
      s.advance(61000); Bun.sleepSync(1100);
      D.setScriptDuty({ maxMs });
      s.call("vic", "say", { text: "grind" });
      const A = s.call("olive", "scripts", {}).scripts.map((x: any) => x.last.at(-1)?.status);
      const B = st(s2, s2.call("olive", "use", { id: "cup", action: "go" }));
      D.setScriptDuty({ maxMs: 1e9 });
      return { cost: +cost.toFixed(2), maxMs: +maxMs.toFixed(1), ranA: A.filter((x: string) => x === "nothing").length, busyA: A.filter((x: string) => x === "refused").length, B }; },
    good: (o) => o.ranA >= 1 && o.ranA <= 12 && o.busyA >= 18 && o.B === "ran" },
  { id: "I8", what: "a process the host never got round to running (stopped here: SIGSTOP, as an overloaded machine would starve it) is still stopped at the deadline, but it reads 'the host was too busy' (unavailable) and isn't the script's failure", run(s) { cast(s);
      if (!SB?.isolationStats) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "calm", onUse(`let x = 0; for (let k = 0; k < 2e4; k++) x += k; world.set("self", "t/n", x);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "calm" } } });
      const pid = SB.isolationStats().next; if (!pid) return { pid: null };
      Bun.spawn(["sh", "-c", `kill -STOP ${pid}`]); Bun.sleepSync(100);
      const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: "go" }); const ms = performance.now() - t0;
      const next = s.call("vic", "use", { id: "box", action: "go" }, 2000);
      return { r: st(s, r), why: r.script?.why, ms: Math.round(ms), fails: s.w().presence.scripts?.["box|calm"]?.fails ?? 0, next: st(s, next) }; },
    good: (o) => o.r === "unavailable unavailable" && /too busy/.test(o.why) && o.ms < 700 && o.fails === 0 && o.next === "ran" },
  { id: "I8n", what: "review #260 rereview (macOS red): the same starved process on a host with no /proc (macOS, Windows: no CPU reading) still reads 'too busy', from the job never being taken (`go`), while a script that took its job and stuck in a slow builtin is still its own failure (`time`); a process the host never got round to running (stopped here: SIGSTOP, as an overloaded machine would starve it) is still stopped at the deadline, but it reads 'the host was too busy' (unavailable) and isn't the script's failure", run(s) { cast(s); process.env.EIDO_SANDBOX_CPU = "none"; try {
      if (!SB?.isolationStats) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "calm", onUse(`let x = 0; for (let k = 0; k < 2e4; k++) x += k; world.set("self", "t/n", x);`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "calm" } } });
      const pid = SB.isolationStats().next; if (!pid) return { pid: null };
      Bun.spawn(["sh", "-c", `kill -STOP ${pid}`]); Bun.sleepSync(100);
      const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: "go" }); const ms = performance.now() - t0;
      const next = s.call("vic", "use", { id: "box", action: "go" }, 2000);
      s.call("bob", "create", { id: "spin", model: "crate", place: { at: [2, 0] } });
      install(s, "bob", "spin", "loop", onUse(`const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "spin", component: "reactions", value: { go: { kind: "script", script: "loop" } } });
      Bun.sleepSync(800); warmUp(); // a fresh warm process (the starved one was killed), as I1 spaces its runs
      const busy = st(s, s.call("vic", "use", { id: "spin", action: "go" }));
      return { r: st(s, r), why: r.script?.why, ms: Math.round(ms), fails: s.w().presence.scripts?.["box|calm"]?.fails ?? 0, next: st(s, next), busy };  } finally { delete process.env.EIDO_SANDBOX_CPU; } },
    good: (o) => o.r === "unavailable unavailable" && /too busy/.test(o.why) && o.ms < 700 && o.fails === 0 && o.next === "ran" && o.busy === "failed time" },
  { id: "I9", what: "re-review: reads that keep the AUTHORITY busy (a slow answer, 64 times) can't outlast the deadline (it's checked between answers too) and count as the script's own time, never as a starved host", opts: { nameOf: (id: string) => { const t = performance.now(); while (performance.now() - t < 30) { /* a slow directory */ } return id; } },
    run(s) { cast(s);
      if (!SB?.isolationStats) return { absent: true };
      warmUp();
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "ask", onUse(`for (let i = 0; i < 64; i++) world.name("vic");`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "ask" } } });
      const t0 = performance.now(); const r = s.call("vic", "use", { id: "box", action: "go" }); const ms = performance.now() - t0;
      return { r: st(s, r), why: r.script?.why, ms: Math.round(ms), fails: s.w().presence.scripts?.["box|ask"]?.fails ?? 0 }; },
    good: (o) => o.r === "failed time" && o.ms < 650 && o.fails === 1 },
  { id: "I2", what: "isolation, a whole request: one say wakes 12 hostile listeners; the authority's script time is capped per second for the process (DUTY), so the request returns within about DUTY + one deadline, the rest are refused busy (not failures), and another world answers at once",
    run(s) { cast(s, [["cat", "builder"]]); const s2 = session(); cast(s2); s2.call("olive", "create", { id: "cup", model: "crate", place: { at: [0, 0] } });
      if (!D.setScriptDuty) return { absent: true };
      warmUp(); D.setScriptDuty({ maxMs: DUTY0.maxMs, windowMs: DUTY0.windowMs });
      for (let i = 0; i < 12; i++) { const who = i % 2 ? "bob" : "cat"; s.call(who, "create", { id: `ear${i}`, model: "crate", place: { at: [i - 6, 2] } });
        install(s, who, `ear${i}`, "spin", `world.on("say", () => { const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b"); });\n`, { scope: { ids: "self", comps: ["t/n"] }, on: ["say"] }); }
      s.advance(61000); s.call("olive", "look", {}); // fresh minute; the pool is warm
      const t0 = performance.now(); const r = s.call("vic", "say", { text: "hello" }); const ms = performance.now() - t0;
      const t1 = performance.now(); const other = s2.call("olive", "inspect", { id: "cup" }); const otherMs = performance.now() - t1;
      const st0 = s.call("olive", "scripts", {}).scripts.map((x: any) => `${x.last.at(-1)?.status} ${x.last.at(-1)?.code}`);
      D.setScriptDuty({ maxMs: 1e9 });
      return { said: r.ok, ms: Math.round(ms), other: other.ok, otherMs: Math.round(otherMs), killed: st0.filter((x: string) => x === "failed time").length, busy: st0.filter((x: string) => x === "refused busy").length }; },
    good: (o) => o.said && o.ms < DUTY0.maxMs + 500 + 300 && o.other && o.otherMs < 150 && o.killed >= 1 && o.busy >= 6 },
  // ---------------- U: use → script ----------------
  { id: "U1", what: "use → script: the visitor's use is their act (with `runs`); the script act's cause is that use, its trigger the visitor, its sponsor bob; the batch's cause is the bhv act; the say too", run(s) { cast(s);
      bell(s, "bob"); const r = s.call("vic", "use", { id: "bell1", action: "ring" }); const L = s.entries();
      const use = L[r.act], act = L[r.script?.act], state = L[r.script?.state], say = L.find((e: any) => e.kind === "say" && e.cause === r.script?.act);
      return { use: [use?.actor, use?.verb, use?.body?.runs], act: [act?.actor, act?.verb, act?.cause === r.act, act?.body?.trigger?.actor, act?.body?.sponsor, act?.body?.on, act?.body?.depth],
        state: [state?.actor, state?.cause === r.script?.act, state?.body?.value?.rung], say: say?.body?.text, tsPinned: act?.ts === state?.ts }; },
    good: (o) => JSON.stringify(o.use) === '["vic","use","script:bell"]' && JSON.stringify(o.act) === '["script:bell1","script",true,"vic","bob","use",1]' && JSON.stringify(o.state) === '["script:bell1",true,1]' && o.say === "the bell tolls for vic (1)" && o.tsPinned },
  { id: "U2", what: "use → script, dry: the visitor sees what it WOULD write; nothing is logged (41 §3.12's dry run, also `scripts {test}`)", run(s) { cast(s);
      bell(s, "bob"); const n0 = s.entries().length;
      const d = s.call("vic", "use", { id: "bell1", action: "ring", dry: true }); const t = s.call("bob", "scripts", { id: "bell1", script: "bell", test: { on: "use" } });
      const vt = s.call("vic", "scripts", { id: "bell1", script: "bell", test: { on: "use" } });
      return { d: d.script?.status, would: d.script?.would?.[0]?.value?.rung, says: t.test?.says?.[0], vt: code(vt), wrote: s.entries().length - n0 }; },
    good: (o) => o.d === "would-run" && o.would === 1 && o.says === "the bell tolls for bob (1)" && o.vt === "rights" && o.wrote === 0 },
  { id: "U2b", what: "a dry run is charged to whoever asks for it (review of #260, protocol core I57): a test event's own `by` changes what the script hears, not whose dry-run allowance it spends", run(s) { cast(s);
      bell(s, "bob"); const rs: string[] = [];
      for (let i = 0; i < 12; i++) { const t = s.call("bob", "scripts", { id: "bell1", script: "bell", test: { on: "use", by: `guest${i}` } }); rs.push(`${t.test?.status} ${t.test?.code ?? ""}`.trim()); }
      const heard = s.call("ann", "scripts", { id: "bell1", script: "bell", test: { on: "use", by: "vic" } });
      return { rs, ann: heard.test?.status, says: heard.test?.says?.[0] }; },
    good: (o) => o.rs.slice(0, 10).every((x: string) => x === "would-run") && o.rs.slice(10).every((x: string) => x === "refused rate") && o.ann === "would-run" && o.says === "the bell tolls for vic (1)" },
  { id: "U2c", what: "a sandbox that's here but whose runtime didn't load: each script's status says unavailable, as the sandbox line does (review of #260, protocol core I59)",
    opts: { scripts: SB?.SANDBOX ? { ...SB.SANDBOX, available: () => "its runtime didn't load (a test's stand-in)" } : null }, run(s) { cast(s);
      if (!SB?.SANDBOX) return { absent: true };
      bell(s, "bob"); const v = s.call("olive", "scripts", {}); const one = v.scripts?.find((x: any) => x.id === "bell1");
      return { status: one?.status, why: one?.why, sandbox: v.sandbox }; },
    good: (o) => o.status === "unavailable" && /runtime didn't load/.test(o.why ?? "") && /^unavailable: /.test(o.sandbox ?? "") },
  // ---------------- E: events ----------------
  { id: "E1", what: "say events: a script that lists `say` hears a visitor's say (and never its own)", run(s) { cast(s);
      s.call("bob", "create", { id: "parrot", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "parrot", "echo", `world.on("say", (e) => { world.set("self", "t/heard", { by: e.by, text: e.text, n: (world.get("self", "t/heard")?.n ?? 0) + 1 }); world.say("squawk: " + e.text); });\n`, { scope: { ids: "self", comps: ["t/heard"], say: true }, on: ["say"] });
      s.call("vic", "say", { text: "!hello" });
      const act = s.entries().find((e: any) => e.actor === "script:parrot" && e.kind === "act"); const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null;
      return { heard: comp(s, "parrot", "t/heard"), squawks: s.entries().filter((e: any) => e.kind === "say" && e.actor === "script:parrot").map((e: any) => e.body.text),
        copied: JSON.stringify(act?.body?.event ?? {}).includes("!hello"), audit: A ? `${A.reran}/${A.acts} ${A.flags.map((f: any) => f.check).join(",")}` : null }; },
    good: (o) => o.heard?.by === "vic" && o.heard?.text === "!hello" && o.heard?.n === 1 && JSON.stringify(o.squawks) === '["squawk: !hello"]' && o.copied === false && o.audit === "1/1 " },
  { id: "E2", what: "enter / leave: the host says who arrived or left; scripts that list them hear it, by identity (presence, told by the host)", run(s) { cast(s);
      if (!D.presenceEvent) return { absent: true };
      s.call("bob", "create", { id: "door1", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "door1", "greet", `world.on("enter", (e) => world.set("self", "t/last", "hello " + e.by));\nworld.on("leave", (e) => world.set("self", "t/last", "bye " + e.by));\n`, { scope: { ids: "self", comps: ["t/last"] }, on: ["enter", "leave"] });
      T += 100; process.env.PROTOCOL_NOW = String(T); const a = D.presenceEvent(s.w(), "enter", "vic").map((x: any) => x.status); const after1 = comp(s, "door1", "t/last");
      T += 100; process.env.PROTOCOL_NOW = String(T); D.presenceEvent(s.w(), "leave", "vic"); const after2 = comp(s, "door1", "t/last");
      return { a, after1, after2 }; },
    good: (o) => JSON.stringify(o.a) === '["ran"]' && o.after1 === "hello vic" && o.after2 === "bye vic" },
  { id: "E3", what: "changed:<comp>: a lever's door opening lights the path (a cascade across scripts, one activation per triggering entry)", run(s) { cast(s);
      s.call("bob", "create", { id: "gate", model: "door", components: { openable: { open: false } }, place: { at: [0, 0] } });
      s.call("bob", "set", { id: "gate", component: "reactions", value: { open: { kind: "toggle", component: "openable", field: "open" } } });
      s.call("bob", "create", { id: "path", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "path", "lights", `world.on("changed:openable", (e) => world.set("self", "t/glow", world.get("gate", "openable").open === true));\n`, { scope: { ids: ["self", "gate"], comps: ["t/glow"] }, on: ["changed:openable"] });
      s.call("vic", "use", { id: "gate", action: "open" }); const lit1 = comp(s, "path", "t/glow");
      s.call("vic", "use", { id: "gate", action: "open" }); const lit2 = comp(s, "path", "t/glow");
      const act = s.entries().findLast((e: any) => e.actor === "script:path" && e.kind === "act");
      return { lit1, lit2, on: act?.body?.on, by: act?.body?.trigger?.actor, comp: act?.body?.event?.comp }; },
    good: (o) => o.lit1 === true && o.lit2 === false && o.on === "changed:openable" && o.by === "vic" && o.comp === "openable" },
  { id: "E4", what: "sleep and wake: nobody here → the timer sleeps (0 entries); someone arrives → ONE wake {slept}, then ticks; never a burst", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("bob", "create", { id: "clock", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "clock", "chime", `world.on("tick", () => world.set("self", "t/n", (world.get("self", "t/n") ?? 0) + 1));\nworld.on("wake", (e) => world.set("self", "t/woke", e.slept));\n`, { scope: { ids: "self", comps: ["t/n", "t/woke"] }, every: 10 });
      const n0 = s.entries().length; for (let i = 0; i < 360; i++) { s.advance(10000); s.tick(); } const asleep = s.entries().slice(n0).length;
      s.call("vic", "move", { to: [0, 0, 2] }); const evs: string[] = [];
      for (let i = 0; i < 3; i++) { s.advance(10000); for (const r of s.tick()) evs.push(r.status); }
      return { asleep, evs, woke: comp(s, "clock", "t/woke"), n: comp(s, "clock", "t/n") }; },
    good: (o) => o.asleep === 0 && JSON.stringify(o.evs) === '["ran","ran","ran"]' && o.woke >= 3590 && o.woke <= 3610 && o.n === 2 },
  { id: "E5", what: "re-entrancy: a host callback inside an activation sends a nested request; the outer request's queues come back after it, so the second script still hears the outer entry (enter() restores the whole per-call state)", opts: { scripts: HOSTCB },
    run(s) { cast(s); HOSTCB.w = s.w(); HOSTCB.nested = null;
      s.call("bob", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("bob", "create", { id: "lamp", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "ball", "hear", "// host callback\n", { scope: { ids: "self", comps: ["t/released"] }, on: ["release"] });
      install(s, "bob", "ball", "glow", "// host callback\n", { scope: { ids: "self", comps: ["t/moved"] }, on: ["changed:transform"] });
      const mv = s.call("vic", "move", { to: [0, 0, 0.3] }), gr = s.call("vic", "grab", { id: "ball" }), dr = s.call("vic", "drop", { id: "ball" });
      return { setup: [show(mv), show(gr), show(dr)], nested: show(HOSTCB.nested), lamp: comp(s, "lamp", "t/n"), released: comp(s, "ball", "t/released"), moved: comp(s, "ball", "t/moved") }; },
    good: (o) => o.setup.every((x: string) => x === "ok") && o.nested === "ok" && o.lamp === 1 && o.released?.by === "vic" && o.moved === true },
  { id: "E6", what: "the beat reaches scripts: a rest the heartbeat logs (settle, no request) fires changed:transform (second review 10-11 S2-2)", run(s) { cast(s);
      if (!D.settle) return { absent: true };
      s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "ball", model: "ball", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [0, 0] } });
      s.call("bob", "create", { id: "mat", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "mat", "land", `world.on("changed:transform", (e) => world.set("self", "t/landed", { id: e.id, by: e.by }));\n`, { scope: { ids: ["self", "ball"], comps: ["t/landed"] }, on: ["changed:transform"] });
      const mv = s.call("vic", "move", { to: [0, 0, 0.3] }), gr = s.call("vic", "grab", { id: "ball" }), th = s.call("vic", "throw", { id: "ball", v: [0, 6, 0] });
      const n0 = s.entries().length; let beats = 0, wrote = 0;
      for (let k = 0; k < 200 && !wrote; k++) { s.advance(66); wrote = D.settle(s.w()); beats++; }
      const rest = s.entries().slice(n0).find((e: any) => e.kind === "change" && e.actor === "sim");
      return { setup: [show(mv), show(gr), show(th)], beats, wrote, rest: !!rest, landed: comp(s, "mat", "t/landed") }; },
    good: (o) => o.setup.every((x: string) => x === "ok") && o.wrote > 0 && o.rest && o.landed?.id === "ball" && o.landed?.by === "vic" },
  // ---------------- P: params (the one signal store; shape audit 10-16) ----------------
  { id: "P1", what: "world.param(id, name, n) writes params.<name> (merged into what's there; a seat pose reads it as param.<name>); a param.<name> key in any other component is refused like any unknown key", run(s) { cast(s);
      s.call("bob", "create", { id: "swing", components: { label: "swing", transform: { pos: [0, 0, 0] } } });   // a light is its own thing (one place per thing, 10-11): no model here
      s.call("bob", "set", { id: "swing", component: "light", value: { kind: "point", intensity: 1 } });
      s.call("bob", "set", { id: "swing", component: "params", value: { tilt: 2 } });
      install(s, "bob", "swing", "pump", onUse(`world.param("self", "lean", 0.25); world.param("self", "push", -1);`), { scope: { ids: "self", comps: ["params"] }, on: ["use"] });
      s.call("bob", "set", { id: "swing", component: "reactions", value: { pump: { kind: "script", script: "pump" } } });
      const r = s.call("vic", "use", { id: "swing", action: "pump" });
      const back = s.call("bob", "set", { id: "swing", component: "light", value: { kind: "point", intensity: 2, "param.lean": 1 } });
      return { r: st(s, r), params: comp(s, "swing", "params"), light: comp(s, "swing", "light"), back: code(back) }; },
    good: (o) => o.r === "ran" && JSON.stringify(o.params) === '{"tilt":2,"lean":0.25,"push":-1}' && o.light?.intensity === 1 && !("param.lean" in (o.light ?? {})) && o.back === "schema" },
  { id: "P2", what: "params are named numbers, at most 64: a string value, a bad name and a 65th key are refused; world.param with a string throws in the script", run(s) { cast(s);
      s.call("bob", "create", { id: "seatl", components: { label: "seat light", transform: { pos: [1, 0, 0] } } });
      const str = s.call("bob", "set", { id: "seatl", component: "params", value: { lean: "far" } });
      const name = s.call("bob", "set", { id: "seatl", component: "params", value: { "9lives": 1 } });
      const many = s.call("bob", "set", { id: "seatl", component: "params", value: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, i])) });
      const full = s.call("bob", "set", { id: "seatl", component: "params", value: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`p${i}`, i])) });
      install(s, "bob", "seatl", "p", onUse(`world.param("self", "lean", "far");`), { scope: { ids: "self", comps: ["params"] }, on: ["use"] });
      s.call("bob", "set", { id: "seatl", component: "reactions", value: { p: { kind: "script", script: "p" } } });
      return { str: code(str), name: code(name), many: code(many), full: ok(full) ? "ok" : code(full), script: st(s, s.call("vic", "use", { id: "seatl", action: "p" })) }; },
    good: (o) => o.str === "shape" && o.name === "shape" && o.many === "bounds" && o.full === "ok" && o.script === "failed thrown" },
  // ---------------- C: body effects meet consent ----------------
  { id: "C1", what: "41 #13 / §3d M4: a script `shove`s a visitor whose table says no (a behaviour is a stranger): refused where it lands, nothing logged; once vic allows it by name, it lands; the act records what and on whom, never which consent let it (consent gaps 6c: a per-person allow is presence)", run(s) { cast(s);
      s.call("bob", "create", { id: "trap", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "trap", "spring", onUse(`world.shove(e.by);`), { scope: { ids: "self", comps: [], bodies: ["shove"] }, on: ["use"] });
      s.call("bob", "set", { id: "trap", component: "reactions", value: { step: { kind: "script", script: "spring" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { switch: "refuse" }); const n0 = s.entries().length;
      const r1 = s.call("vic", "use", { id: "trap", action: "step" }); const scripted1 = s.entries().slice(n0).filter((e: any) => isScriptActor(e.actor)).length;
      s.call("vic", "consent", { allow: "script:trap", class: "shove" }); const r2 = s.call("vic", "use", { id: "trap", action: "step" });
      const act = s.entries().findLast((e: any) => e.actor === "script:trap" && e.kind === "act");
      return { r1: st(s, r1), scripted1, r2: st(s, r2), recorded: act?.body?.bodies, tumble: !!s.w().presence.bodies.vic?.tumble }; },
    good: (o) => o.r1 === "refused consent" && o.scripted1 === 0 && o.r2 === "ran" && JSON.stringify(o.recorded) === '[{"kind":"shove","to":"body:vic"}]' && o.tumble },
  { id: "C2", what: "bodies need scope.bodies: a script that shoves without declaring it is refused (scope), whatever the target allows", run(s) { cast(s);
      s.call("bob", "create", { id: "trap", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "trap", "spring", onUse(`world.shove(e.by);`), { scope: { ids: "self", comps: [] }, on: ["use"] });
      s.call("bob", "set", { id: "trap", component: "reactions", value: { step: { kind: "script", script: "spring" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { switch: "accept" });
      return { r: st(s, s.call("vic", "use", { id: "trap", action: "step" })) }; },
    good: (o) => o.r === "refused scope" },
  { id: "C3", what: "§3d M4: a person may allow a sponsor's behaviours by name (scripts-by:<sponsor>): every one of bob's scripts may then pose them; ann's still may not", run(s) { cast(s);
      for (const [who, id] of [["bob", "pad1"], ["bob", "pad2"], ["ann", "pad3"]]) { s.call(who, "create", { id, model: "crate", place: { at: [0, 0] } });
        install(s, who, id, "p", onUse(`world.pose(e.by, { clip: "wave" });`), { scope: { ids: "self", comps: [], bodies: ["pose"] }, on: ["use"] });
        s.call(who, "set", { id, component: "reactions", value: { go: { kind: "script", script: "p" } } }); }
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { switch: "refuse" }); s.call("vic", "consent", { allow: "scripts-by:bob", class: "pose" });
      return { rs: ["pad1", "pad2", "pad3"].map((id) => st(s, s.call("vic", "use", { id, action: "go" }))) }; },
    good: (o) => JSON.stringify(o.rs) === '["ran","ran","refused consent"]' },
  { id: "B20b", what: "a script that throws a falsy value (0, \"\", null, undefined, false) fails, and the writes it made first are not kept", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const vals = ["0", '""', "null", "undefined", "false"];
      vals.forEach((x, i) => install(s, "bob", "box", `f${i}`, onUse(`world.set("self", "t/n", ${i + 1}); throw ${x};`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] }));
      s.call("bob", "set", { id: "box", component: "reactions", value: Object.fromEntries(vals.map((_, i) => [`f${i}`, { kind: "script", script: `f${i}` }])) });
      const out = vals.map((_, i) => { const r = s.call("vic", "use", { id: "box", action: `f${i}` }); return { st: r.script?.status ?? st(s, r), n: comp(s, "box", "t/n") ?? null }; });
      return { out }; },
    good: (o) => o.out.every((x: any) => x.st !== "ran" && x.n === null) },
  { id: "B20c", what: "getYear and setYear are UTC too, like every other local-time method: an activation reads the same year on any host's time zone", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "yr", onUse(`const d = new Date(Date.UTC(2025, 11, 31, 23, 30)); const y = d.getYear(); d.setYear(99); world.set("self", "t/n", { y, set: d.toISOString() });`), { scope: { ids: "self", comps: ["t/n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { yr: { kind: "script", script: "yr" } } });
      const r = s.call("vic", "use", { id: "box", action: "yr" }); return { st: r.script?.status ?? st(s, r), n: comp(s, "box", "t/n") ?? null, tz: process.env.TZ ?? null }; },
    good: (o) => o.st === "ran" && o.n?.y === 125 && o.n?.set === "1999-12-31T23:30:00.000Z" },
  { id: "C3b", what: "§3d M4: a pose a sponsor-wide allowance let in stands when the person changes some other part of their table", run(s) { cast(s);
      s.call("bob", "create", { id: "pad1", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "pad1", "p", onUse(`world.pose(e.by, { clip: "wave" });`), { scope: { ids: "self", comps: [], bodies: ["pose"] }, on: ["use"] });
      s.call("bob", "set", { id: "pad1", component: "reactions", value: { go: { kind: "script", script: "p" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { switch: "refuse" }); s.call("vic", "consent", { allow: "scripts-by:bob", class: "pose" });
      const r = st(s, s.call("vic", "use", { id: "pad1", action: "go" })); const posed = !!s.w().presence.bodies.vic?.pose;
      s.call("vic", "consent", { switch: "refuse" });
      return { r, posed, after: !!s.w().presence.bodies.vic?.pose }; },
    good: (o) => o.r === "ran" && o.posed && o.after },
  { id: "C4", what: "an expired allowance for one behaviour no longer masks its sponsor's: the sponsor-wide allowance applies once it has run out", run(s) { cast(s);
      s.call("bob", "create", { id: "pad1", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "pad1", "p", onUse(`world.pose(e.by, { clip: "wave" });`), { scope: { ids: "self", comps: [], bodies: ["pose"] }, on: ["use"] });
      s.call("bob", "set", { id: "pad1", component: "reactions", value: { go: { kind: "script", script: "p" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { switch: "refuse" });
      s.call("vic", "consent", { allow: "scripts-by:bob", class: "pose" });
      const one = s.call("vic", "consent", { allow: "script:pad1", class: "pose", for: 60000 });
      const during = st(s, s.call("vic", "use", { id: "pad1", action: "go" }));
      s.advance(5 * 60000);
      return { one: one?.ok, during, after: st(s, s.call("vic", "use", { id: "pad1", action: "go" })) }; },
    good: (o) => o.one === true && o.during === "ran" && o.after === "ran" },
  { id: "Q1", what: "reinstalling a script whose value was purged counts against the world's script limit, as a new one does", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "script-settings", value: { max: 1 } });
      for (const id of ["qa", "qb"]) s.call("bob", "create", { id, model: "crate", place: { at: [0, 0] } });
      const first = install(s, "bob", "qa", "p", onUse(`world.say("a");`), { scope: { ids: "self", comps: [] }, on: ["use"] }).r;
      const at = s.entries().findLastIndex((e: any) => e?.kind === "change" && JSON.stringify(e.body ?? {}).includes('"script:p"'));
      s.w().append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: at }] } });
      const other = install(s, "bob", "qb", "p", onUse(`world.say("b");`), { scope: { ids: "self", comps: [] }, on: ["use"] }).r;
      const again = install(s, "bob", "qa", "p", onUse(`world.say("a2");`), { scope: { ids: "self", comps: [] }, on: ["use"] }).r;
      return { first: st(s, first), other: st(s, other), again: again?.ok ? "ok" : again?.refused?.code }; },
    good: (o) => o.other === "ok" && o.again === "too-many" },
  { id: "Q2", what: "a script whose value stands but whose install act was purged says why it doesn't run in the status view (its activation gives the same why)", run(s) { cast(s);
      s.call("bob", "create", { id: "qc", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "qc", "p", onUse(`world.say("c");`), { scope: { ids: "self", comps: [] }, on: ["use"] });
      const act = s.entries().findLastIndex((e: any) => e?.kind === "act" && e.verb === "set" && JSON.stringify(e.body ?? {}).includes('"script:p"'));
      s.w().append({ kind: "purge", actor: "system", verb: "purge", body: { values: [{ seq: act }] } });
      const v = s.call("olive", "scripts", { id: "qc" }); const view = (v?.scripts ?? []).find((x: any) => x.script === "script:p");
      return { act, view: view?.status, why: view?.why ?? null }; },
    good: (o) => o.act > 0 && o.view === "not-installed" && /answers for it/.test(o.why ?? "") },
  // ---------------- M: v1 parity: the v1 SDK's three examples (sdk/examples), ported to this API ----------------
  { id: "M1", what: "v1 parity: bellkeeper (use → a pendulum motion + say), greeter (enter → say, a count), lighthouse (a timer that speaks only if someone's here), ported", run(s) { cast(s);
      if (!D.presenceEvent) return { absent: true };
      // bellkeeper: kv → a component in scope; emit('motion') → set motion (pivot is its own component now); emit('say') → say
      s.call("bob", "create", { id: "bell1", model: "bell", components: { pivot: { pos: [0, 1.6, 0] } }, place: { at: [0, 0] } });
      install(s, "bob", "bell1", "keeper", `world.on("use", (e) => {
  if (e.action !== "ring") return;
  const rings = (world.get("self", "t/bellkeeper")?.rings ?? 0) + 1;
  world.set("self", "t/bellkeeper", { rings });
  world.set("self", "motion", { type: "pendulum", axis: [0, 0, 1], amp: 0.5, phase: 0, damp: 0.25, period: world.knobs.period ?? 2.2, t0: Date.now() });
  world.say((world.knobs.note ?? "the bell tolls") + " (" + rings + ") — rung by " + e.by);
});
`, { scope: { ids: "self", comps: ["t/bellkeeper", "motion"], say: true }, on: ["use"], knobs: { period: 2.2, note: "the bell tolls" } });
      s.call("bob", "set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "keeper" } } });
      const ring = s.call("vic", "use", { id: "bell1", action: "ring" });
      // greeter: world-level in v1; now a script lives on a thing (a sign), and hears every arrival
      s.call("bob", "create", { id: "sign", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "sign", "greeter", `world.on("enter", (e) => {
  const met = (world.get("self", "t/greeter")?.met ?? 0) + 1;
  world.set("self", "t/greeter", { met });
  world.say((world.knobs.greeting ?? "welcome") + ", " + (world.name(e.by) ?? e.by) + " — you are visitor #" + met);
});
`, { scope: { ids: "self", comps: ["t/greeter"], say: true }, on: ["enter"], knobs: { greeting: "welcome to the meadow" } });
      T += 100; process.env.PROTOCOL_NOW = String(T); D.presenceEvent(s.w(), "enter", "vic");
      // lighthouse: world.every(60) → every: 60 in the component; people() → world.count()
      s.call("bob", "create", { id: "lamp1", model: "floor-lamp", place: { at: [-3, 0] } });
      install(s, "bob", "lamp1", "keeper", `world.on("tick", () => {
  const n = (world.get("self", "t/lighthouse")?.sweeps ?? 0) + 1;
  world.set("self", "t/lighthouse", { sweeps: n });
  const here = world.count();
  if (here > 0) world.say((world.knobs.text ?? "all clear") + " — sweep " + n + ", " + here + " soul(s) in view");
});
`, { scope: { ids: "self", comps: ["t/lighthouse"], say: true }, every: 60, knobs: { text: "all clear" } });
      s.call("vic", "move", { to: [0, 0, 2] });
      for (let i = 0; i < 3; i++) { s.advance(60000); s.tick(); }
      const says = s.entries().filter((e: any) => e.kind === "say" && isScriptActor(e.actor)).map((e: any) => e.body.text);
      NAMES.vic = "Vee"; // a rename in the directory afterwards: the act recorded no name, so the greeter's act can't be re-run to its say (skipped, said why)
      const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null;
      return { ring: st(s, ring), motion: comp(s, "bell1", "motion")?.type, rings: comp(s, "bell1", "t/bellkeeper")?.rings, met: comp(s, "sign", "t/greeter")?.met, sweeps: comp(s, "lamp1", "t/lighthouse")?.sweeps, says,
        audit: A ? `${A.reran}/${A.acts} ${A.flags.map((f: any) => f.check).join(",")}` : null, skipped: A?.skipped?.length ?? null }; },
    opts: { nameOf: (id: string) => NAMES[id] ?? null },
    good: (o) => o.ring === "ran" && o.motion === "pendulum" && o.rings === 1 && o.met === 1 && o.sweeps === 2 && o.audit === "3/4 " && o.skipped === 1
      && o.says.includes("the bell tolls (1) — rung by vic") && o.says.includes("welcome to the meadow, Vic — you are visitor #1") && o.says.includes("all clear — sweep 2, 1 soul(s) in view") },
  // ---------------- V: translated v1 behaviours ----------------
  { id: "V1", what: "a translated v1 world's imported-behavior:<name> (a v1 binding) never runs; the status view says plainly it needs re-installing as script:<name>", run(s) { cast(s);
      const set = s.call("olive", "set", { id: "@world", component: "imported-behavior:greeter", value: { src: "store/scripts/0123456789abcdef.js", attach: "bell1", knobs: {}, author: "olive", ts: 1 } });
      s.call("olive", "create", { id: "bell1", model: "bell", components: { reactions: { ring: { kind: "script", script: "greeter" } } }, place: { at: [0, 0] } });
      const use = s.call("vic", "use", { id: "bell1", action: "ring" });
      const v = s.call("olive", "scripts", {}); return { set: show(set), imported: v.imported, use: code(use), fix: use.refused?.fix }; },
    good: (o) => o.set === "ok" && o.imported?.[0]?.status === "needs-reinstall" && /re-install it as script:<name>/i.test(o.imported?.[0]?.why) && o.imported?.[0]?.attach === "bell1"
      && o.use === "no-runtime" && /re-install it as script:greeter/.test(o.fix) },
  // ---------------- H: hygiene and syntax ----------------
  { id: "H1", what: "41 #16 Trojan Source at upload: U+202E inside a comment; code at column 4,000; a BOM; a zero-width space", run(s) { cast(s);
      const up = (t: string) => code(s.call("bob", "upload", { text: t }));
      return { bidi: up(`// harmless ‮ ;)"neewteb"\nworld.on("use", () => {});`), wide: up(`world.on("use", () => {});${" ".repeat(4000)}world.set("self","t/a",1)`), bom: up(`﻿world.on("use", () => {});`), zw: up(`world.on("use", () => { const a​ = 1; });`) }; },
    good: (o) => o.bidi === "trojan-source" && o.wide === "long-line" && o.bom === "source-bom" && o.zw === "trojan-source" },
  { id: "H2", what: "…and at install (what binds): a blob put without upload's check is still refused when set as a script", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const src = s.w().putBlob({ lang: "js", api: 1, text: `// harmless ‮ ;)\nworld.on("use", () => {});` });
      const r = s.call("bob", "set", { id: "box", component: "script:a", value: { src, scope: { ids: "self", comps: ["t/a"] }, on: ["use"] } });
      return { r: code(r), why: r.refused?.reason }; },
    good: (o) => o.r === "trojan-source" && /U\+202E/.test(o.why) },
  { id: "H4", what: "a scope naming a typo of a registered component (lit → light) is refused at install, not at every run", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const r = install(s, "bob", "box", "a", onUse(`world.set("self", "lit", true);`), { scope: { ids: "self", comps: ["lit"] }, on: ["use"] }).r;
      const own = install(s, "bob", "box", "b", onUse(`world.set("self", "t/glow", true);`), { scope: { ids: "self", comps: ["t/glow", "my.place/lit"] }, on: ["use"] }).r;
      return { r: code(r), dym: r.refused?.didYouMean?.[0], own: show(own) }; },
    good: (o) => o.r === "schema" && o.dym === "light" && o.own === "ok" },
  { id: "H5", what: "uploads are rate-limited (20 a person a minute: a blob costs storage and a parse, and logs nothing)", run(s) { cast(s);
      const rs = []; for (let i = 0; i < 22; i++) rs.push(code(s.call("bob", "upload", { text: `world.on("use", () => {}); // ${i}` }, 10)) ?? "ok");
      s.advance(61000); rs.push(code(s.call("bob", "upload", { text: "// later" })) ?? "ok");
      return { rs }; },
    good: (o) => o.rs.slice(0, 20).every((x: string) => x === "ok") && o.rs[20] === "rate" && o.rs[21] === "rate" && o.rs[22] === "ok" },
  { id: "H3", what: "source that doesn't parse is refused at upload and at install, with the line", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const u = s.call("bob", "upload", { text: "world.on('use', () => {\n  world.set('self', 't/a' 1);\n});" });
      const src = s.w().putBlob({ lang: "js", api: 1, text: "world.on('use', () => {\n  world.set('self', 't/a' 1);\n});" });
      const r = s.call("bob", "set", { id: "box", component: "script:a", value: { src, scope: { ids: "self", comps: ["t/a"] }, on: ["use"] } });
      return { u: code(u), r: code(r), why: r.refused?.reason }; },
    good: (o) => o.u === "syntax" && o.r === "syntax" && /line 2/.test(o.why) },
];

// ---------------- S: the real server ----------------
const serverCases: Case[] = [{ id: "S1", server: true, what: "the server: a world builds no v1 BehaviorHost; `use` → script over a WebSocket; a timer fires on the server's own tick; enter reaches scripts; the debug roster lists the authority's view", run: async () => {
  const W4 = path.join(root, "srv"); fs.mkdirSync(W4, { recursive: true });
  const env = { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W4, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "" };
  const f = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", "chimes", "--owner", "Ann"], { cwd: ENGINE, env });
  if (f.exitCode !== 0) return { found: f.stderr.toString() };
  let port = 0; for (let p = 9300; p < 9500; p++) { if (p === 8968 || p === 8970) continue; try { const t = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); t.stop(true); port = p; break; } catch { /* taken */ } }
  const logf = path.join(root, "srv.log");
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: { ...env, PORT: String(port) }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false; for (let i = 0; i < 100 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* not yet */ } }
    if (!up) return { up: false, err: fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-600) : "" };
    const client = async (name: string) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = []; const waiters = new Map(); let n = 0;
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") { const fn = waiters.get(m.id); if (fn) { waiters.delete(m.id); fn(m.reply); } } };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ type: "join", world: "chimes", id: name, avatar: "", replica: true }));
      for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
      return { ws, msgs, you: msgs.find((m) => m.type === "snapshot")?.cut?.you, req: (verb: string, args: any = {}) => new Promise<any>((res) => { const rid = `${name}-${++n}`; waiters.set(rid, (r: any) => res(IDS.back(r))); ws.send(JSON.stringify({ type: "request", id: rid, verb, args: IDS.out(verb, args) })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 8000); }),
        send: (m: any) => ws.send(JSON.stringify(m)) }; };
    const ann = await client("Ann");
    const mk = await ann.req("create", { id: "bell1" });
    const up1 = await ann.req("upload", { text: BELL });
    const inst = await ann.req("set", { id: "bell1", component: "script:bell", value: { src: up1.src, scope: { ids: "self", comps: ["t/bell"], say: true }, on: ["use"] } });
    await ann.req("set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "bell" } } });
    const up2 = await ann.req("upload", { text: `world.on("tick", () => world.set("self", "t/beats", (world.get("self", "t/beats") ?? 0) + 1));\nworld.on("enter", (e) => world.set("self", "t/hello", e.by));\n` });
    const clock = await ann.req("set", { id: "bell1", component: "script:clock", value: { src: up2.src, scope: { ids: "self", comps: ["t/beats", "t/hello"] }, on: ["enter"], every: 5 } });
    let bob = await client("Bob"); await sleep(300);
    // "busy" is the authority's fairness answer (its script duty: 500 ms of each real second, 300 for one world), not this
    // path failing: on a slow or loaded host the enter script's first run can spend this world's share, so the use waits
    // for the next second and asks again (nothing was written by the refused one, so rung stays exact)
    let ring: any, ringBusy = 0;
    for (;;) { ring = await bob.req("use", { id: "bell1", action: "ring" }); if (ring.script?.code !== "busy" || ringBusy >= 10) break; ringBusy++; await sleep(1100); }
    const B1 = IDS.of("bell1");   // the id the authority minted for the suite's bell1 (R 10-17)
    const readWorld = () => { const L = F.readLog(fs.readFileSync(path.join(W4, "chimes", "world.jsonl"))); const st = F.fold(L).entities[B1]?.c ?? {};
      return { L, st0: st, tickActs: L.filter((e: any) => e.kind === "act" && e.actor === `script:${B1}` && e.body?.on === "tick").length }; };
    // two 5 s periods on the server's 1 s clock (the first only arms the timer): at least 11.5 s, then up to 30 s more on a
    // slow host; an enter refused busy is asked again by joining again (each join is an enter)
    let w: any, waited = 0, rejoined = 0; await sleep(11500);
    for (;;) { w = readWorld(); if ((w.tickActs >= 1 && w.st0["t/beats"] >= 1 && w.st0["t/hello"] === bob.you) || waited >= 30000) break;
      if (w.st0["t/hello"] !== bob.you && waited && waited % 10000 === 0 && rejoined < 2) { const seen = bob.msgs; bob.ws.close(); await sleep(300); bob = await client("Bob"); bob.msgs.unshift(...seen); rejoined++; }
      await sleep(1000); waited += 1000; }
    const { L, st0, tickActs } = w;
    const dbg = await new Promise<any>((res) => { const on = (ev: any) => { const m = JSON.parse(String(ev.data)); if (m.type === "debug" && m.reqId === "d1") { ann.ws.removeEventListener("message", on); res(m); } };
      ann.ws.addEventListener("message", on); ann.send({ type: "debug", scripts: true, reqId: "d1" }); setTimeout(() => res(null), 3000); });
    const srvLog = fs.readFileSync(logf, "utf8") + (fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8") : "");
    ann.ws.close(); bob.ws.close();
    return { mk: mk.ok, inst: show(inst), clock: show(clock), ring: ring.script?.status, ringBusy, waited, rejoined, ringWhy: ring.script?.status === "ran" ? undefined : `${ring.script?.code}: ${ring.script?.why ?? show(ring)}`.slice(0, 160), rung: st0["t/bell"]?.rung, tickActs, beats: st0["t/beats"], hello: st0["t/hello"] === bob.you,
      sawScript: bob.msgs.some((m) => m.type === "log" && m.entries.some((e: any) => e.actor === `script:${B1}` && e.body?.on === "tick")),
      roster: dbg?.events?.map((e: any) => `${String(e.id).replace(B1, "bell1")}:${e.status}`), v1Host: /\[behaviors\]|behavior tick/.test(srvLog), malformed: F.fold(L).diagnostics.filter(([, c]: any) => String(c).startsWith("malformed")).length };
  } finally { proc.kill(); }
}, good: (o) => o.mk && o.inst === "ok" && o.clock === "ok" && o.ring === "ran" && o.rung === 1 && o.tickActs >= 1 && o.beats >= 1 && o.hello && o.sawScript
  && o.roster?.includes("bell1/bell:active") && o.roster?.includes("bell1/clock:active") && !o.v1Host && o.malformed === 0 }];

serverCases.push({ id: "S2", server: true, what: "the server: while a hostile script (indexOf on crafted text) runs in one world, another world's requests keep answering within the deadline; each hostile run is stopped and shows as a failure (time) against its script",
  run: async () => {
    const W4 = path.join(root, "srv2"); fs.mkdirSync(W4, { recursive: true });
    const env = { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W4, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "",
      ...(opt("sandbox") ? { EIDO_SANDBOX: opt("sandbox") } : {}) };
    for (const wn of ["alpha", "beta"]) { const f = Bun.spawnSync(["bun", "tools/protocol/world.ts", "found", wn, "--owner", "Ann"], { cwd: ENGINE, env }); if (f.exitCode !== 0) return { found: f.stderr.toString() }; }
    let port = 0; for (let p = 9500; p < 9700; p++) { try { const t = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); t.stop(true); port = p; break; } catch { /* taken */ } }
    const logf = path.join(root, "srv2.log");
    const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: { ...env, PORT: String(port) }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      let up = false; for (let i = 0; i < 100 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* not yet */ } }
      if (!up) return { up: false };
      const client = async (world: string, name: string) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = []; const waiters = new Map(); let n = 0;
        ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") { const fn = waiters.get(m.id); if (fn) { waiters.delete(m.id); fn(m.reply); } } };
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.send(JSON.stringify({ type: "join", world, id: name, avatar: "", replica: true }));
        for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
        return { ws, req: (verb: string, args: any = {}) => new Promise<any>((res) => { const rid = `${name}-${++n}`; waiters.set(rid, (r: any) => res(IDS.back(r))); ws.send(JSON.stringify({ type: "request", id: rid, verb, args: IDS.out(verb, args) })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 30000); }) }; };
      const ann = await client("alpha", "Ann"), bea = await client("beta", "Bea");
      await ann.req("create", { id: "box" });
      const u = await ann.req("upload", { text: `world.on("use", () => { const n = 8e4; const t = "a".repeat(2 * n); t.indexOf("a".repeat(n) + "b"); });\n` });
      const inst = await ann.req("set", { id: "box", component: "script:spin", value: { src: u.src, scope: { ids: "self", comps: ["t/n"] }, on: ["use"] } });
      await ann.req("set", { id: "box", component: "reactions", value: { spin: { kind: "script", script: "spin" } } });
      await sleep(800); // the world now holds a script: its sandbox processes warm
      const rounds = [];
      // three rounds the script really ran in (a round the host starved says "unavailable": stopped at the same deadline,
      // but no verdict on the script, so it doesn't count toward the three; at most 8 rounds in all)
      for (let i = 0; i < 8 && rounds.filter((r: any) => r.code !== "unavailable").length < 3; i++) {
        const t0 = performance.now(); let done: any = null; const p = ann.req("use", { id: "box", action: "spin" }).then((r) => { done = { r, ms: performance.now() - t0 }; });
        const lat: number[] = []; while (!done && performance.now() - t0 < 20000) { const t1 = performance.now(); await bea.req("look", {}); lat.push(performance.now() - t1); await sleep(20); }
        await p; rounds.push({ status: done.r.script?.status, code: done.r.script?.code, ms: Math.round(done.ms), maxOther: Math.round(Math.max(...lat)), looks: lat.length });
        await sleep(1100); // a new second of script duty
      }
      const sv = await ann.req("scripts", { id: "box" });
      ann.ws.close(); bea.ws.close();
      return { inst: show(inst), rounds, status: sv.scripts?.[0]?.status, last: sv.scripts?.[0]?.last?.at(-1)?.code };
    } finally { proc.kill(); }
  }, good: (o) => o.inst === "ok" && o.rounds.filter((r: any) => r.code !== "unavailable").length === 3 && o.rounds.every((r: any) => (r.code === "unavailable" || (r.status === "failed" && r.code === "time")) && r.ms < 800 && r.maxOther < 800) && o.last === "time" });

// ---------------- run ----------------
let pass = 0, fail = 0, na = 0;
// The I rows test isolation itself (a killed process, the deadline held against a native builtin). A host without it
// (Windows: shared/protocol/sandbox.js fifoOk) runs scripts in-process, where those guarantees are the documented gap, so
// they print n/a with the reason. I0 keeps that from hiding a regression: isolation must be on everywhere else.
const { SANDBOX: SBX } = await import("../../shared/protocol/sandbox.js");
const isolating = !!SBX.isolated(), mustIsolate = process.platform !== "win32" && process.env.EIDO_SANDBOX !== "inprocess";
{ const good = isolating || !mustIsolate; if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} I0   isolation is on on every host but Windows (here: ${process.platform}, isolated ${isolating})`); }
const all = [...cases, ...(argv.includes("--no-server") ? [] : serverCases)];
for (const c of all) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  if (!isolating && (/^I\d/.test(c.id) || c.id === "S2")) { na++; console.log(`n/a  ${c.id.padEnd(4)} ${c.what}\n       not applicable: this host runs scripts in-process (no isolation on ${process.platform})`); continue; }
  let o: any, good = false;
  try { o = c.server ? await c.run(null) : c.run(session(c.opts)); good = !!c.good(o) && !o?.absent; } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 700)}`}`);
}
console.log(`[scripts-check] ${pass} passed, ${fail} failed${na ? `, ${na} not applicable (no isolation here)` : ""}`);
process.exit(fail ? 1 : 0);
