// tools/v4/scripts-check.ts — v4 scripts (research 41; the lab's 46 B-cases, ported from its toy language to real
// JavaScript in the QuickJS sandbox), through the real door, plus `use` → script and a timer through a real server.
//   bun tools/v4/scripts-check.ts                 every case (the server cases start a scratch sequencer)
//   bun tools/v4/scripts-check.ts --only B2,B5    just those
//   bun tools/v4/scripts-check.ts --tree <dir>    run the door cases against another checkout's shared/ (a mutant, a base)
//   bun tools/v4/scripts-check.ts --control       the base commit (bbc9ac22, before scripts): every door case must FAIL there
//   bun tools/v4/scripts-check.ts --mutants       remove each gate in turn (a copy of shared/): its cases must go red; a
//                                                 no-op control mutation must stay green
// Cases:
//   B   behaviours on sponsor rights (41 §7, lab 46 B1–B20)        D   determinism and the reader's audit (41 §3.7)
//   R   runaway work: fuel, stack, memory, reads (41 §7 #9)       U   `use` → script: who did what, in the log
//   E   events: say, enter/leave, changed, wake                    P   param.<name> (seat poses read it)
//   C   a script's body effects meet each body's consent (L6)      V   translated v1 behaviours say they need re-installing
//   H   source hygiene and syntax at upload and install            S   the server: no v1 BehaviorHost; timers tick; use → script
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/v4/durable.ts";
import { custodyAt, modLogAt } from "../../server/v4/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "bbc9ac22";

// ---------------- the mutation and control drivers (they re-run this file as child processes) ----------------
// Each mutation removes ONE gate from a copy of shared/ and names the cases that must turn red. Applied as an exact text
// replacement; a mutation whose text isn't found is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string[]][] = [
  // [name, file, find, replace, cases]
  ["install: scope within installer's rights", "door.js", "if (RANK[role] < RANK[need]) refuse(\"rights\", `${at}'s scope reaches", "if (false) refuse(\"rights\", `${at}'s scope reaches", ["B1"]],
  ["sponsor's role NOW", "door.js", "const r = roleOf(st, cap.sponsor);\n  if (RANK[r] < RANK[need])", "const r = \"owner\";\n  if (RANK[r] < RANK[need])", ["B2", "B3", "B24"]],
  ["scope narrowing", "door.js", "if (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp))", "if (false && (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp)))", ["B4"]],
  ["sponsor = latest write (not creator)", "door.js", "const c = lastSetterOf(w, id, key); return c && !c.deleted ? { sponsor: c.rights, sponsorAt: c.seq } : null; };", "const c = creatorOf(w, id, key); return c ? { sponsor: c.rights, sponsorAt: c.seq } : null; };", ["B18"]],
  ["no-op elision", "door.js", "const ops = SR.elide(st, res.ops);", "const ops = res.ops;", ["B16", "B5"]],
  ["timers sleep with nobody present", "door.js", "if (!present && v.always !== true) { rt.sleepingSince ??= now;", "if (false) { rt.sleepingSince ??= now;", ["B5", "E4"]],
  ["world hourly budget", "door.js", ": B.all + cost > cfg.budget ?", ": false ?", ["B6"]],
  ["sponsor's fair share", "door.js", ": B.bySponsor + cost > B.share ?", ": false ?", ["B6b"]],
  ["per-script rate", "door.js", "(B.mine >= cfg.rate ?", "(false ?", ["B6c"]],
  ["script count", "door.js", "if (n > cfg.max) refuse(\"too-many\"", "if (false) refuse(\"too-many\"", ["B7"]],
  ["cascade depth", "door.js", "if (depth > cfg.depth) return out(\"refused\"", "if (false) return out(\"refused\"", ["B8"]],
  ["locks bind scripts", "door.js", "if (k) lockCheck(w, st, who, role, k, op, at); }", "if (k && !cap) lockCheck(w, st, who, role, k, op, at); }", ["B9"]],
  ["in flight binds scripts", "door.js", "if (inFlight(op.id)) refuse(\"in-flight\"", "if (inFlight(op.id) && cap?.kind !== \"script\") refuse(\"in-flight\"", ["B10"]],
  ["hygiene at install", "door.js", "const dirty = SR.hygiene(blob.text); if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`", "const dirty = null; if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`", ["H2"]],
  ["hygiene at upload", "door.js", "const dirty = SR.hygiene(a.text); if (dirty) refuse(dirty.code, dirty.reason", "const dirty = null; if (dirty) refuse(dirty.code, dirty.reason", ["H1"]],
  ["scope names checked for typos at install", "door.js", "if (near.length) refuse(\"schema\", `${at}.scope.comps:", "if (false) refuse(\"schema\", `${at}.scope.comps:", ["H4"]],
  ["syntax at install", "door.js", "const syn = w.scripts?.checkSyntax?.(blob.text); if (syn)", "const syn = null; if (syn)", ["H3"]],
  ["banned → suspended", "door.js", "if (isBanned(w, sp.sponsor)) return out(\"suspended\"", "if (false) return out(\"suspended\"", ["B15"]],
  ["adopt base", "door.js", "if (base !== undefined && lt && lt.seq > base) refuse(\"stale\", `${a.id}.${key}", "if (false) refuse(\"stale\", `${a.id}.${key}", ["B14"]],
  ["always needs an owner", "door.js", "if (v.always === true && prev?.always !== true && RANK[role] < RANK.owner)", "if (false)", ["B17"]],
  ["install rank", "door.js", "if (RANK[role] < RANK[cfg.install]) refuse(\"rights\", `installing a script", "if (false) refuse(\"rights\", `installing a script", ["B17"]],
  ["timer floor", "door.js", "if (v.every !== undefined && !(typeof v.every === \"number\" && v.every >= 5))", "if (false)", ["B17"]],
  ["paused", "door.js", "if (v.paused === true) return out(\"paused\"", "if (false) return out(\"paused\"", ["B20"]],
  ["run: false", "door.js", "if (cfg.run === false) return out(\"stopped\"", "if (false) return out(\"stopped\"", ["B20"]],
  ["pause after repeated failures", "door.js", "if (!dry && (rt.fails ?? 0) >= cfg.fails) return out(\"paused\"", "if (false) return out(\"paused\"", ["B20"]],
  ["say needs scope.say", "door.js", "if (res.says.length && !v.scope?.say) return mark(\"scope\"", "if (false) return mark(\"scope\"", ["B21"]],
  ["create needs scope.create", "door.js", "if (!cap.create) refuse(\"scope\", `${cap.key} doesn't declare create: true`", "if (false) refuse(\"scope\", `${cap.key} doesn't declare create: true`", ["B22"]],
  ["created things stay in the subtree", "door.js", "if (cap?.kind === \"script\") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some(", "if (false) for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some(", ["B22"]],
  ["a script's body effect meets consent", "door.js", "const g = bodyGate(w, `bhv:${id}`, b.to, b.act, { spec: b.spec, script: key, sponsor: sp.sponsor }); if (!g.ok) return mark(g.code, g.reason);", "const g = { ok: true, consent: \"standing\", deliver: () => {} };", ["C1"]],
  ["bodies need scope.bodies", "door.js", "for (const b of res.bodies) if (!(v.scope?.bodies ?? []).includes(b.act)) return mark(\"scope\"", "for (const b of res.bodies) if (false) return mark(\"scope\"", ["C2"]],
  ["sponsor-wide body allowance", "door.js", "&& C.tableOf(P, to).overrides[`bhvs:${extra.sponsor}`]?.[cls]) d = C.decide(P, `bhvs:${extra.sponsor}`, to, cls, now);", "&& false) d = null;", ["C3"]],
  ["frozen clock", "sandbox.js", "FrozenDate.now = () => NOW;", "FrozenDate.now = () => RealDate.now();", ["D2"]],
  ["seeded randomness", "sandbox.js", "Math.random = function random() { return sfc(); };", "", ["D2"]],
  ["names replayed from the act", "sandbox.js", "const n = x.reads ? x.reads.names?.[nameAt]?.name ?? null : (x.name ? x.name(id) ?? null : null);", "const n = x.name ? x.name(id) ?? null : null;", ["M1"]],
  ["presence reads replayed from the act", "sandbox.js", "const ids = x.reads ? x.reads.near?.[nearAt]?.ids ?? [] : (x.near ? x.near(r) : []);", "const ids = x.near ? x.near(r) : [];", ["D1"]],
  ["fuel", "sandbox.js", "if (fuel > L.fuel) {", "if (false) {", ["R1"]],
  ["host-call cap", "sandbox.js", "if (++calls > L.calls) {", "if (false) {", ["R4"]],
  ["write cap", "sandbox.js", "if (ops.length >= L.ops) {", "if (false) {", ["R5"]],
  ["param values are numbers (schema)", "door.js", "if (!isNum(v[k])) refuse(\"shape\", `${at}.${k} is a number (a signal)", "if (false) refuse(\"shape\", `${at}.${k} is a number (a signal)", ["P2"]],
  ["param keys pass the schema", "door.js", "v = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith(\"param.\")));", "", ["P1"]],
  ["changed:<comp> cascades", "door.js", "if (hit) activate(w, id, name, { on: `changed:${hit.comp}`", "if (false) activate(w, id, name, { on: `changed:${hit.comp}`", ["E3", "B8"]],
  ["say events", "door.js", "activate(w, id, name, { on: \"say\", by: e.actor", "void (w, id, name, { on: \"say\", by: e.actor", ["E1"]],
  ["a script never hears its own say", "door.js", "if (!(Array.isArray(v.on) && v.on.includes(\"say\")) || e.actor === `bhv:${id}`) continue;", "if (!(Array.isArray(v.on) && v.on.includes(\"say\"))) continue;", ["E1"]],
  ["use of a v1 binding says re-install", "door.js", "if (v1 || (isE(ce) && ce.kind === \"act\" && ce.verb === \"legacy\"))", "if (false)", ["V1"]],
  ["v1 behaviours are listed", "door.js", "...(id && id !== \"@world\" ? {} : { v1: v1Behaviours(w, st) })", "...{}", ["V1"]],
  ["UTC inside the sandbox", "sandbox.js", "P.getTimezoneOffset = function getTimezoneOffset() { return 0; };", "", ["D3"]],
  ["local-time methods are UTC", "sandbox.js", "P[\"get\" + k] = P[\"getUTC\" + k];", "", ["D3"]],
  ["runs per script per minute", "door.js", "if (runs >= cfg.runs) return", "if (false) return", ["B23"]],
  ["cpu per sponsor per minute", "door.js", "if (ms >= cfg.cpu) return", "if (false) return", ["B23"]],
  ["a guest sponsor is a guest", "door.js", "const r = roleOf(st, cap.sponsor);\n  if (RANK[r] < RANK[need])", "const r = roleOf(st, cap.sponsor, false);\n  if (RANK[r] < RANK[need])", ["B24"]],
  ["upload rate", "door.js", "if (U.length >= SR.LIMITS.uploads) refuse(\"rate\"", "if (false) refuse(\"rate\"", ["H5"]],
  ["acts point at a say's text, never copy it", "door.js", "const recorded = (ev) => { const { text, to, args, ...rest } = ev; return ev.seq !== undefined ? rest : ev; };", "const recorded = (ev) => ev;", ["E1"]],
  ["the auditor reads a say's text from the say", "scriptaudit.js", "event.text = trig.body.text;", "", ["E1"]],
  ["CONTROL (no-op: must stay green)", "door.js", "// ---------- behaviours (L4, L7 as revised;", "// ---------- behaviours (L4, L7  as revised;", []],
];
async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/v4/scripts-check.ts"), "--tree", tree, "--no-server", ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyShared(tag: string) { const d = scratch(tag); fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true }); return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    if (only && !cases.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cases.length)) continue;
    ran++; const d = copyShared("mut"); const f = path.join(d, "shared/v4", file); const src = fs.readFileSync(f, "utf8");
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
  // the base commit's shared/ (the door before scripts): every door case must FAIL there (none can pass by accident)
  const d = scratch("ctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  const r = await runSelf(d, null, ["--expect-absent"]);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const passing = lines.filter((l) => l.startsWith("ok "));
  console.log(lines.map((l) => (l.startsWith("ok ") ? "UNEXPECTED PASS AT BASE " : "red at base: ") + l.slice(0, 140)).join("\n"));
  console.log(`[scripts-check --control] at ${BASE}: ${lines.length - passing.length} of ${lines.length} cases red, ${passing.length} passed`);
  process.exit(passing.length ? 1 : 0);
}

// ---------------- the door, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const tryImport = async (p: string) => { try { return await import(p); } catch (e) { if (!argv.includes("--expect-absent")) throw e; return null; } };
const D = await import(TREE + "shared/v4/door.js");
const F = await import(TREE + "shared/v4/fold.js");
const SB = await tryImport(TREE + "shared/v4/sandbox.js");
const AU = await tryImport(TREE + "shared/v4/scriptaudit.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("scripts");

// a world on disk over THIS tree's door (as server/v4/disk.ts does with the checkout's)
function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.V4_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: o.scripts === undefined ? SB?.SANDBOX ?? null : o.scripts, present: o.present, nameOf: o.nameOf, kindOf: o.kindOf,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session(o: any = {}) {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name, o));
  const call = (actor: string, tool: string, args: any = {}, step = 100) => { T += step; process.env.V4_NOW = String(T);
    try { return D.request(W(), actor, tool, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, advance: (ms: number) => { T += ms; process.env.V4_NOW = String(T); }, tick: () => (D.tick ? D.tick(W()) : null),
    logPath: path.join(root, "worlds", `${name}.jsonl`), entries: () => W().entries };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 100)}`);
const st = (s: any, r: any) => (r?.script ? `${r.script.status}${r.script.code ? ` ${r.script.code}` : ""}` : show(r));
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
const kinds = (L: any[]) => L.reduce((m: any, e: any) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
const isBhv = (a: any) => typeof a === "string" && a.startsWith("bhv:");
const ZERO = "sha256:" + "0".repeat(64);
// owner olive (the founder), builders bob and ann, visitor vic
function cast(s: any, extra: [string, string][] = []) {
  s.call("olive", "new", { title: s.name });
  for (const [who, role] of [["bob", "builder"], ["ann", "builder"], ["vic", "visitor"], ...extra]) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } });
}
function install(s: any, who: string, id: string, name: string, text: string, value: any) {
  const u = s.call(who, "upload", { text }); const src = u.src ?? ZERO;
  return { u, src, r: s.call(who, "set", { id, component: `script:${name}`, value: { src, ...value } }) };
}
const BELL = `// the bell: counts its rings and says who rang it
world.on("use", (e) => {
  const rung = (world.get("self", "bell")?.rung ?? 0) + 1;
  world.set("self", "bell", { rung });
  world.say("the bell tolls for " + e.by + " (" + rung + ")");
});
`;
function bell(s: any, who: string) { s.call(who, "create", { id: "bell1", model: "bell", place: { at: [0, 0] } });
  const r = install(s, who, "bell1", "bell", BELL, { scope: { ids: "self", comps: ["bell"], say: true }, on: ["use"] });
  s.call(who, "set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "bell" } } }); return r; }
const NAMES: Record<string, string> = { vic: "Vic" }; // a stand-in for the door's directory (M1)
const onUse = (body: string) => `world.on("use", (e) => {\n${body}\n});\n`;

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean; server?: boolean; opts?: any };
const cases: Case[] = [
  // ---------------- B: behaviours on sponsor rights ----------------
  { id: "B1", what: "41 #1 proxy promotion: a builder installs a script whose scope is @world × roles:* (refused at install: wider than the installer's rights)", run(s) { cast(s);
      s.call("bob", "create", { id: "kiosk", model: "crate", place: { at: [0, 0] } });
      const { r } = install(s, "bob", "kiosk", "promo", onUse(`world.set("@world", "roles:bob", { role: "owner" });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      return { install: r, stored: !!comp(s, "kiosk", "script:promo") }; },
    good: (o) => code(o.install) === "rights" && /roles:\*/.test(o.install.refused.reason) && !o.stored },
  { id: "B2", what: "41 #2 demotion: the sponsor is demoted; the next use's write is refused, the visitor's use still logs, the status says dormant and why", run(s) { cast(s);
      const { u } = bell(s, "bob"); const first = s.call("vic", "use", { id: "bell1", action: "ring" });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } }); const n0 = s.entries().length;
      const after = s.call("vic", "use", { id: "bell1", action: "ring" }); const sv = s.call("olive", "scripts", {}).scripts?.[0];
      return { u: show(u), first: st(s, first), after: st(s, after), newKinds: kinds(s.entries().slice(n0)), status: sv?.status, why: sv?.why }; },
    good: (o) => o.first === "ran" && o.after === "refused rights" && JSON.stringify(o.newKinds) === '{"act":1}' && o.status === "dormant" && /sponsor bob \(visitor now.*bell1\.bell/.test(o.why) },
  { id: "B3", what: "41 #3 confused deputy: an OWNER uses a script installed by bob (owner then, builder now) that writes roles:mal; the trigger adds no rights", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "owner" } });
      s.call("bob", "create", { id: "kiosk", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "kiosk", "promo", onUse(`world.set("@world", "roles:mal", { role: "builder" });`), { scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] });
      install(s, "bob", "kiosk", "hello", onUse(`world.set("self", "greeting", e.by);`), { scope: { ids: "self", comps: ["greeting"] }, on: ["use"] });
      s.call("bob", "set", { id: "kiosk", component: "reactions", value: { promote: { kind: "script", script: "promo" }, hello: { kind: "script", script: "hello" } } });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "builder" } });
      const promote = s.call("olive", "use", { id: "kiosk", action: "promote" }), hello = s.call("olive", "use", { id: "kiosk", action: "hello" });
      const act = s.entries().find((e: any) => e.actor === "bhv:kiosk" && e.kind === "act");
      return { promote: promote.script ? `${promote.script.status} ${promote.script.code}: ${promote.script.why}` : show(promote), mal: comp(s, "@world", "roles:mal") ?? null, hello: hello.script?.status, trigger: act?.body?.trigger?.actor, sponsor: act?.body?.sponsor }; },
    good: (o) => /^refused rights: script:promo's sponsor bob can't change @world\.roles:mal/.test(o.promote) && o.mal === null && o.hello === "ran" && o.trigger === "olive" && o.sponsor === "bob" },
  { id: "B4", what: "41 #5 half an activation: the third of three writes is outside the scope; nothing lands (v1 committed two)", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "three", onUse(`world.set("self", "a", 1); world.set("self", "b", 2); world.set("self", "c", 3);`), { scope: { ids: "self", comps: ["a", "b"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "three" } } }); const n0 = s.entries().length;
      const r = s.call("vic", "use", { id: "box", action: "go" }); const c = s.w().state().entities.box.c;
      return { r: st(s, r), a: c.a ?? null, b: c.b ?? null, bhv: s.entries().slice(n0).filter((e: any) => isBhv(e.actor)).length }; },
    good: (o) => o.r === "refused scope" && o.a === null && o.b === null && o.bhv === 0 },
  { id: "B5", what: "41 #6 the heart: a 5 s timer re-asserting one light, 2 h simulated, nobody present: 0 entries, asleep; `always` and already lit: still 0 (elided)", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      const LIT = { kind: "point", color: 16711680, intensity: 1, range: 6, shadows: false };
      s.call("bob", "create", { id: "lamp", model: "table-lamp", place: { at: [0, 0] } }); s.call("olive", "create", { id: "lamp2", model: "table-lamp", components: { light: LIT }, place: { at: [2, 0] } });
      const HEART = `world.on("tick", () => world.set("self", "light", ${JSON.stringify(LIT)}));\nworld.on("wake", () => world.set("self", "light", ${JSON.stringify(LIT)}));\n`;
      install(s, "bob", "lamp", "heart", HEART, { scope: { ids: "self", comps: ["light"] }, every: 5 });
      const always = install(s, "olive", "lamp2", "heart", HEART, { scope: { ids: "self", comps: ["light"] }, every: 5, always: true }).r;
      const n0 = s.entries().length; let nothing = 0;
      for (let i = 0; i < 2 * 720; i++) { s.advance(5000); nothing += (s.tick() ?? []).filter((x: any) => x.status === "nothing").length; }
      const sv = s.call("olive", "scripts", {}).scripts;
      return { always: show(always), entries2h: s.entries().slice(n0).filter((e: any) => isBhv(e.actor)).length, alwaysRanElided: nothing, status: sv.map((x: any) => `${x.id}:${x.status}`) }; },
    good: (o) => o.always === "ok" && o.entries2h === 0 && o.alwaysRanElided === 2 * 720 - 1 && o.status.includes("lamp:asleep") && o.status.includes("lamp2:active") },
  { id: "B6", what: "…the heart with a CHANGING value and `always`: the world's hourly budget (set to 60) caps what scripts write each hour", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("olive", "set", { id: "@world", component: "scripts", value: { budget: 60 } });
      s.call("olive", "create", { id: "heart", model: "bell", place: { at: [0, 0] } });
      const BEAT = (c: string) => `world.on("tick", () => world.set("self", "${c}", { n: (world.get("self", "${c}")?.n ?? 0) + 1 }));\n`;
      install(s, "olive", "heart", "beat", BEAT("beat"), { scope: { ids: "self", comps: ["beat"] }, every: 30, always: true });
      install(s, "olive", "heart", "beat2", BEAT("beat2"), { scope: { ids: "self", comps: ["beat2"] }, every: 30, always: true });
      const t0 = T; const why = new Set();
      for (let i = 0; i < 2 * 120; i++) { s.advance(30000); for (const r of s.tick() ?? []) if (r.code === "budget") why.add(/world's scripts/.test(r.why) ? "world" : /sponsors here/.test(r.why) ? "sponsor" : "script"); }
      const hours = [0, 0]; for (const e of s.entries()) if (isBhv(e.actor) && e.ts > t0) hours[Math.min(1, Math.floor((e.ts - t0) / 3600000))]++;
      return { hours, why: [...why].sort() }; },
    good: (o) => o.hours.every((n: number) => n > 50 && n <= 60) && o.why.includes("world") },
  { id: "B6b", what: "§3d M3: each sponsor gets a fair share of the world's hour: bob's chatty timer can't starve olive's script", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("olive", "set", { id: "@world", component: "scripts", value: { budget: 40 } });
      s.call("olive", "create", { id: "a", model: "crate", place: { at: [0, 0] } }); s.call("bob", "create", { id: "b", model: "crate", place: { at: [2, 0] } });
      const BEAT = `world.on("tick", () => world.set("self", "n", (world.get("self", "n") ?? 0) + 1));\n`;
      s.call("vic", "move", { to: [0, 0, 3] }); // someone is here, so timers run
      install(s, "bob", "b", "chatty", BEAT, { scope: { ids: "self", comps: ["n"] }, every: 5 });
      install(s, "olive", "a", "kind", onUse(`world.set("self", "n", (world.get("self", "n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["n"] }, on: ["use"] });
      s.call("olive", "set", { id: "a", component: "reactions", value: { poke: { kind: "script", script: "kind" } } });
      for (let i = 0; i < 60; i++) { s.advance(5000); s.tick(); } // bob's timer has 5 minutes (two sponsors: 20 entries each of 40)
      const pokes = []; for (let i = 0; i < 3; i++) pokes.push(st(s, s.call("vic", "use", { id: "a", action: "poke" }, 20000)));
      const L = s.entries(); const by = (sp: string) => L.filter((e: any) => isBhv(e.actor) && (e.kind === "act" ? e.body?.sponsor : L[e.cause]?.body?.sponsor) === sp).length;
      return { bob: by("bob"), olive: by("olive"), pokes }; },
    good: (o) => o.bob === 20 && o.pokes.every((p: string) => p === "ran") && o.olive === 6 },
  { id: "B6c", what: "the per-script rate: 6 logged activations a minute per script, then refused (budget) until the minute passes", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "inc", onUse(`world.set("self", "n", (world.get("self", "n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { inc: { kind: "script", script: "inc" } } });
      const rs = []; for (let i = 0; i < 8; i++) rs.push(st(s, s.call("vic", "use", { id: "box", action: "inc" }, 1000)));
      s.advance(61000); rs.push(st(s, s.call("vic", "use", { id: "box", action: "inc" })));
      return { rs, n: comp(s, "box", "n") }; },
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
      install(s, "bob", "ea", "ping", `world.on("changed:pong", () => world.set("self", "ping", (world.get("eb", "pong") ?? 0) + 1));\n`, { scope: { ids: ["self", "eb"], comps: ["ping"] }, on: ["changed:pong"] });
      install(s, "bob", "eb", "pong", `world.on("changed:ping", () => world.set("self", "pong", (world.get("ea", "ping") ?? 0) + 1));\n`, { scope: { ids: ["self", "ea"], comps: ["pong"] }, on: ["changed:ping"] });
      const kick = s.call("bob", "set", { id: "eb", component: "pong", value: 0 });
      const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null; const sv = s.call("olive", "scripts", {}).scripts ?? [];
      return { kick: show(kick), bhvActs: s.entries().filter((e: any) => isBhv(e.actor) && e.kind === "act").length, readerMaxDepth: A?.maxDepth, flags: A?.flags.length, reran: A?.reran,
        ninth: sv.flatMap((x: any) => x.last).find((l: any) => l.code === "depth")?.why ?? null }; },
    good: (o) => o.bhvActs === 8 && o.readerMaxDepth === 8 && o.flags === 0 && o.reran === 8 && /depth 9 > 8/.test(o.ninth) },
  { id: "B9", what: "41 #11 lock: a script on a locked statue tries to move it (a capability never acts through a lock)", run(s) { cast(s);
      s.call("bob", "create", { id: "statue", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "statue", "nudge", onUse(`world.set("self", "transform", { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] });`), { scope: { ids: "self", comps: ["transform"] }, on: ["use"] });
      s.call("bob", "set", { id: "statue", component: "reactions", value: { nudge: { kind: "script", script: "nudge" } } }); s.call("bob", "set", { id: "statue", component: "lock", value: true });
      const r = s.call("vic", "use", { id: "statue", action: "nudge" });
      return { r: st(s, r), pos: JSON.stringify(comp(s, "statue", "transform")?.pos) }; },
    good: (o) => o.r === "refused locked" && o.pos === "[0,0,0]" },
  { id: "B10", what: "41 #12 in flight: a lever's script writes the transform of a ball the engine is carrying", run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "sim", value: { engine: "eidosim@0.5.0" } });
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
      s.call("bob", "create", { id: "lamp", model: "table-lamp", place: { at: [0, 0] } });
      install(s, "bob", "lamp", "on", onUse(`world.set("self", "light", { kind: "point", color: 1, intensity: 1, range: 6, shadows: false });`), { scope: { ids: "self", comps: ["light"] }, on: ["use"] });
      s.call("bob", "set", { id: "lamp", component: "reactions", value: { on: { kind: "script", script: "on" } } });
      const n0 = s.entries().length; const a = s.call("vic", "use", { id: "lamp", action: "on" }); const n1 = s.entries().length; const b = s.call("vic", "use", { id: "lamp", action: "on" });
      return { first: a.script?.status, second: b.script?.status, firstKinds: kinds(s.entries().slice(n0, n1)), secondKinds: kinds(s.entries().slice(n1)) }; },
    good: (o) => o.first === "ran" && o.second === "nothing" && JSON.stringify(o.firstKinds) === '{"act":2,"state":1}' && JSON.stringify(o.secondKinds) === '{"act":1}' },
  { id: "B17", what: "install rules: a builder's `always`, a 1 s timer, a visitor's install, and a builder's install after the owner raises it to owner", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } }); const t = onUse(`world.set("self", "a", 1);`);
      const always = install(s, "bob", "box", "a", t, { scope: { ids: "self", comps: ["a"] }, every: 5, always: true }).r;
      const fast = install(s, "bob", "box", "b", t, { scope: { ids: "self", comps: ["a"] }, every: 1 }).r;
      const src = install(s, "bob", "box", "ok", t, { scope: { ids: "self", comps: ["a"] }, on: ["use"] }).src;
      const vic = s.call("vic", "set", { id: "box", component: "script:c", value: { src, scope: { ids: "self", comps: ["a"] } } });
      s.call("olive", "set", { id: "@world", component: "scripts", value: { install: "owner" } });
      const raised = install(s, "bob", "box", "d", t, { scope: { ids: "self", comps: ["a"] }, on: ["use"] }).r;
      return { always, fast, vic, raised }; },
    good: (o) => code(o.always) === "rights" && /always/.test(o.always.refused.reason) && code(o.fast) === "shape" && /floor is 5/.test(o.fast.refused.reason) && code(o.vic) === "rights" && code(o.raised) === "rights" && /needs owner/.test(o.raised.refused.reason) },
  { id: "B18", what: "sponsor = the LATEST write (§5 Two views): an owner tidies bob's script (pauses, unpauses); bob is demoted; it runs on olive's rights", run(s) { cast(s);
      bell(s, "bob"); const v = comp(s, "bell1", "script:bell");
      s.call("olive", "set", { id: "bell1", component: "script:bell", value: { ...v, paused: true } }); s.call("olive", "set", { id: "bell1", component: "script:bell", value: { ...v, paused: false } });
      s.call("olive", "set", { id: "@world", component: "roles:bob", value: { role: "visitor" } });
      const r = s.call("vic", "use", { id: "bell1", action: "ring" }); const sv = s.call("olive", "scripts", {}).scripts?.[0];
      return { r: st(s, r), sponsor: sv?.sponsor, status: sv?.status }; },
    good: (o) => o.r === "ran" && o.sponsor === "olive" && o.status === "active" },
  { id: "B19", what: "replay never runs code: the fold alone (no door, no sandbox, no blobs) gives the door's world after script activations", run(s) { cast(s);
      bell(s, "bob"); for (let i = 0; i < 3; i++) s.call("vic", "use", { id: "bell1", action: "ring" });
      const f = F.fold(F.readLog(fs.readFileSync(s.logPath))); const foldSrc = fs.readFileSync(TREE + "shared/v4/fold.js", "utf8");
      return { same: F.digest(f) === F.digest(s.w().state()), rung: f.entities.bell1?.c.bell?.rung, foldImportsVm: /sandbox|scriptaudit|quickjs/.test(foldSrc) }; },
    good: (o) => o.same && o.rung === 3 && !o.foldImportsVm },
  { id: "B20", what: "kill switches: paused: true and @world.scripts.run: false stop it; runaway work dies by fuel; 5 failures in a row pause it until it is set again", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "tick", onUse(`world.set("self", "n", (world.get("self", "n") ?? 0) + 1);`), { scope: { ids: "self", comps: ["n"] }, on: ["use"] });
      install(s, "bob", "box", "spin", onUse(`while (true) {}`), { scope: { ids: "self", comps: ["m"] }, on: ["use"] });
      install(s, "bob", "box", "oops", onUse(`throw new Error("bad input");`), { scope: { ids: "self", comps: ["n"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { tick: { kind: "script", script: "tick" }, spin: { kind: "script", script: "spin" }, oops: { kind: "script", script: "oops" } } });
      const v = comp(s, "box", "script:tick"); s.call("olive", "set", { id: "box", component: "script:tick", value: { ...v, paused: true } });
      const paused = s.call("vic", "use", { id: "box", action: "tick" }).script?.status; s.call("olive", "set", { id: "box", component: "script:tick", value: { ...v, paused: false } });
      s.call("olive", "set", { id: "@world", component: "scripts", value: { run: false } }); const stopped = s.call("vic", "use", { id: "box", action: "tick" }).script?.status;
      s.call("olive", "set", { id: "@world", component: "scripts", value: { run: true } }); const runs = s.call("vic", "use", { id: "box", action: "tick" }).script?.status;
      const spin = s.call("vic", "use", { id: "box", action: "spin" }).script;
      const fails = Array.from({ length: 6 }, () => s.call("vic", "use", { id: "box", action: "oops" }, 11000).script?.status);
      const sv = (s.call("olive", "scripts", {}).scripts ?? []).find((x: any) => x.script === "script:oops");
      const fv = comp(s, "box", "script:oops"); s.call("bob", "set", { id: "box", component: "script:oops", value: { ...fv, knobs: { fixed: 1 } } });
      const afterFix = s.call("vic", "use", { id: "box", action: "oops" }).script?.status;
      return { paused, stopped, runs, spin: spin ? `${spin.status} ${spin.code}` : null, fails, status: sv?.status, afterFix, n: comp(s, "box", "n") ?? null }; },
    good: (o) => o.paused === "paused" && o.stopped === "stopped" && o.runs === "ran" && o.spin === "failed fuel" && JSON.stringify(o.fails) === '["failed","failed","failed","failed","failed","paused"]' && o.status === "paused" && o.afterFix === "failed" && o.n === 1 },
  { id: "B21", what: "say needs scope.say: a script without it that says something is refused whole (its write too)", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "talk", onUse(`world.set("self", "a", 1); world.say("hello");`), { scope: { ids: "self", comps: ["a"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "talk" } } });
      const r = s.call("vic", "use", { id: "box", action: "go" }); return { r: st(s, r), a: comp(s, "box", "a") ?? null, says: s.entries().filter((e: any) => e.kind === "say").length }; },
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
      install(s, "bob", "dice", "roll", onUse(`world.set("self", "face", { n: Math.floor(Math.random() * 6), near: world.near(3), here: world.count(), at: Date.now(), by: e.by });`), { scope: { ids: "self", comps: ["face"] }, on: ["use"] });
      s.call("bob", "set", { id: "dice", component: "reactions", value: { roll: { kind: "script", script: "roll" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); for (let i = 0; i < 3; i++) s.call("vic", "use", { id: "dice", action: "roll" });
      s.call("vic", "move", { to: [0, 0, 5] }); s.call("vic", "use", { id: "dice", action: "roll" }, 2000); // walked away: the 4th roll's near is []
      if (!AU) return { absent: true };
      const L0 = s.entries(), get = s.w().getBlob, run = SB.runScript;
      const honest = AU.auditScripts(L0, get, { run });
      const copy = () => F.readLog(Buffer.from(L0.map((e: any) => JSON.stringify(e)).join("\n") + "\n"));
      const k = L0.findIndex((e: any) => isBhv(e.actor) && e.kind === "act"); const forged = copy(); forged[k].body.sponsor = "olive";
      const j = L0.findLastIndex((e: any) => isBhv(e.actor) && e.kind === "state"); const tampered = copy(); tampered[j].body.value.n = (tampered[j].body.value.n + 1) % 6;
      const lost = copy(); for (const e of lost) if (isBhv(e.actor) && e.kind === "act") delete e.body.reads; // without the recorded reads the re-run can't agree
      return { acts: honest.acts, reran: honest.reran, honestFlags: honest.flags, reads: L0.filter((e: any) => isBhv(e.actor) && e.kind === "act").map((e: any) => e.body.reads?.near?.[0]?.ids?.join(",") ?? "?"),
        forged: AU.auditScripts(forged, get, { run }).flags.map((x: any) => x.check), tampered: AU.auditScripts(tampered, get, { run }).flags.map((x: any) => `${x.seq}:${x.check}`), lost: AU.auditScripts(lost, get, { run }).flags.map((x: any) => x.check) }; },
    good: (o) => o.acts === 4 && o.reran === 4 && o.honestFlags.length === 0 && JSON.stringify(o.reads) === '["vic","vic","vic",""]' && o.forged.includes("sponsor") && o.tampered.some((x: string) => /:rerun$/.test(x)) && o.lost.includes("rerun") },
  { id: "D2", what: "41 §3.7: an activation's clock is frozen at its act's ts, and Math.random is seeded from its act: the same seed gives the same numbers, another seed others", run(s) { cast(s);
      if (!SB) return { absent: true };
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "box", "clock", onUse(`const t0 = Date.now(); let x = 0; for (let i = 0; i < 2e5; i++) x += i; world.set("self", "t", { now: Date.now(), same: Date.now() === t0 && new Date().getTime() === t0 && world.now === t0, r: [Math.random(), Math.random()] });`), { scope: { ids: "self", comps: ["t"] }, on: ["use"] });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "clock" } } });
      const r1 = s.call("vic", "use", { id: "box", action: "go" }); const t1 = comp(s, "box", "t"); const act1 = s.entries()[r1.script?.act];
      const r2 = s.call("vic", "use", { id: "box", action: "go" }); const t2 = comp(s, "box", "t");
      const again = SB.runScript({ text: s.w().getBlob(act1.body.src).text, self: "box", key: "script:clock", event: act1.body.event, now: act1.ts, seed: act1.body.seed, st: F.fold(s.entries(), { until: act1.body.head }) });
      return { nowIsTs: t1?.now === act1?.ts, same: t1?.same, r1: t1?.r, r2: t2?.r, rerun: again.ops?.[0]?.value?.r }; },
    good: (o) => o.nowIsTs && o.same === true && JSON.stringify(o.r1) === JSON.stringify(o.rerun) && JSON.stringify(o.r1) !== JSON.stringify(o.r2) },
  { id: "D3", what: "the sandbox's time zone is UTC wherever the door runs: local-time methods, parsing and Date() agree under TZ=UTC and TZ=Asia/Tokyo", run() {
      if (!SB) return { absent: true };
      const f = path.join(root, "tz-probe.ts");
      fs.writeFileSync(f, `import { runScript } from ${JSON.stringify(TREE + "shared/v4/sandbox.js")};
const r = runScript({ self: "b", key: "script:x", now: 1800000000000, seed: "ab".repeat(32), st: { entities: { b: { born: 1, c: {} } } }, event: { on: "use" },
  text: 'world.on("use", () => { const d = new Date(); world.set("self", "t", [d.getHours(), d.getTimezoneOffset(), String(d), Date(), new Date(2020, 0, 1).getTime(), Date.parse("2020-01-01T00:00"), new Date("2020-01-01 12:30").getTime(), d.toLocaleString(), d.toTimeString()]); })' });
console.log(JSON.stringify(r.ops?.[0]?.value ?? r));\n`);
      const out = (tz: string) => Bun.spawnSync(["bun", f], { env: { ...process.env, TZ: tz, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } }).stdout.toString().trim();
      return { utc: out("UTC"), tokyo: out("Asia/Tokyo") }; },
    good: (o) => o.utc.startsWith("[8,0,") && o.utc === o.tokyo },
  { id: "B23", what: "the door's own cost is metered, written or not: a script whose runs write nothing is held to `runs` a minute, and a sponsor to `cpu` ms of sandbox time", run(s) { cast(s);
      s.call("bob", "create", { id: "ear", model: "crate", place: { at: [0, 0] } }); s.call("ann", "create", { id: "mill", model: "crate", place: { at: [2, 0] } });
      install(s, "bob", "ear", "idle", `world.on("say", () => {});\n`, { scope: { ids: "self", comps: ["n"] }, on: ["say"] });
      install(s, "ann", "mill", "grind", `world.on("say", () => { let x = 0; for (let i = 0; i < 1e5; i++) x += Math.sqrt(i); });\n`, { scope: { ids: "self", comps: ["n"] }, on: ["say"] });
      const last = (id: string) => s.call("olive", "scripts", {}).scripts.find((x: any) => x.id === id).last.at(-1);
      // phase 1: runs (cpu out of the way)
      s.call("olive", "set", { id: "@world", component: "scripts", value: { runs: 5, cpu: 60000 } });
      const ear: string[] = []; for (let i = 0; i < 8; i++) { s.call("vic", "say", { text: `hi ${i}` }, 600); ear.push(last("ear")?.status); }
      const earWhy = last("ear")?.why;
      // phase 2: cpu (runs out of the way), a minute later
      s.advance(61000); s.call("olive", "set", { id: "@world", component: "scripts", value: { runs: 600, cpu: 25 } });   // ≈10 ms a run on a quiet host, ≈30–45 loaded: either way the cap binds before the sixth
      const mill: string[] = []; for (let i = 0; i < 6; i++) { s.call("vic", "say", { text: `ho ${i}` }, 600); mill.push(last("mill")?.status); }
      return { ear, earWhy, mill, why: last("mill")?.why }; },
    good: (o) => JSON.stringify(o.ear) === '["nothing","nothing","nothing","nothing","nothing","refused","refused","refused"]' && /ran 5 times/.test(o.earWhy)
      && o.mill[0] === "nothing" && o.mill.at(-1) === "refused" && /ann's scripts used \d+ ms of the door's time/.test(o.why) },
  { id: "B24", what: "a guest sponsor's rights are a guest's: once the owner removes the role it was given, its script is dormant, even where strangers default to builder", opts: { kindOf: (id: string) => (id === "gus" ? "anon" : "human") },
    run(s) { cast(s);
      s.call("olive", "set", { id: "@world", component: "default-role", value: { role: "builder" } });
      s.call("olive", "set", { id: "@world", component: "roles:gus", value: { role: "builder" } });
      s.call("gus", "create", { id: "gbox", model: "crate", place: { at: [0, 0] } });
      install(s, "gus", "gbox", "g", onUse(`world.set("self", "n", 1);`), { scope: { ids: "self", comps: ["n"] }, on: ["use"] });
      s.call("gus", "set", { id: "gbox", component: "reactions", value: { go: { kind: "script", script: "g" } } });
      s.call("olive", "delete", { id: "@world", component: "roles:gus" });
      const direct = s.call("gus", "set", { id: "gbox", component: "label", value: "x" }); const r = s.call("vic", "use", { id: "gbox", action: "go" });
      return { direct: code(direct), r: st(s, r), status: s.call("olive", "scripts", { id: "gbox" }).scripts?.[0]?.status }; },
    good: (o) => o.direct === "rights" && o.r === "refused rights" && o.status === "dormant" },
  // ---------------- R: runaway work ----------------
  ...[["R1", "while (true) {}", "fuel"], ["R2", "function f() { return f(); } f();", "stack"], ["R3", `let s = "x"; for (;;) s += s;`, "memory"],
      ["R4", `for (let i = 0; i < 1000; i++) world.get("self");`, "calls"], ["R5", `for (let i = 0; i < 40; i++) world.set("self", "n", i);`, "too-big"], ["R6", "this is not javascript", "syntax"]].map(([id, body, want]) => ({
    id, what: `41 #9 runaway: ${body.slice(0, 40)} → ${want}; it writes nothing and the next activation still runs`, run(s: any) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const src = s.w().putBlob({ lang: "js", api: 1, text: `world.on("use", (e) => { if (e.args?.ok) { world.set("self", "n", 1); return; } ${body} });\n` });
      const inst = s.call("bob", "set", { id: "box", component: "script:x", value: { src, scope: { ids: "self", comps: ["n"] }, on: ["use"] } });
      s.call("bob", "set", { id: "box", component: "reactions", value: { go: { kind: "script", script: "x" } } }); const n0 = s.entries().length;
      const r = s.call("vic", "use", { id: "box", action: "go" }); const bhv = s.entries().slice(n0).filter((e: any) => isBhv(e.actor)).length;
      const next = s.call("vic", "use", { id: "box", action: "go", args: { ok: true } });
      return { inst: show(inst), r: st(s, r), bhv, next: st(s, next) }; },
    good: (o: any) => (want === "syntax" ? o.inst.startsWith("refused syntax") : o.r === `failed ${want}` && o.bhv === 0 && o.next === "ran") })),
  // ---------------- U: use → script ----------------
  { id: "U1", what: "use → script: the visitor's use is their act (with `runs`); the bhv act's cause is that use, its trigger the visitor, its sponsor bob; the batch's cause is the bhv act; the say too", run(s) { cast(s);
      bell(s, "bob"); const r = s.call("vic", "use", { id: "bell1", action: "ring" }); const L = s.entries();
      const use = L[r.act], act = L[r.script?.act], state = L[r.script?.state], say = L.find((e: any) => e.kind === "say" && e.cause === r.script?.act);
      return { use: [use?.actor, use?.verb, use?.body?.runs], act: [act?.actor, act?.verb, act?.cause === r.act, act?.body?.trigger?.actor, act?.body?.sponsor, act?.body?.on, act?.body?.depth],
        state: [state?.actor, state?.cause === r.script?.act, state?.body?.value?.rung], say: say?.body?.text, tsPinned: act?.ts === state?.ts }; },
    good: (o) => JSON.stringify(o.use) === '["vic","use","script:bell"]' && JSON.stringify(o.act) === '["bhv:bell1","script",true,"vic","bob","use",1]' && JSON.stringify(o.state) === '["bhv:bell1",true,1]' && o.say === "the bell tolls for vic (1)" && o.tsPinned },
  { id: "U2", what: "use → script, dry: the visitor sees what it WOULD write; nothing is logged (41 §3.12's dry run, also `scripts {test}`)", run(s) { cast(s);
      bell(s, "bob"); const n0 = s.entries().length;
      const d = s.call("vic", "use", { id: "bell1", action: "ring", dry: true }); const t = s.call("bob", "scripts", { id: "bell1", script: "bell", test: { on: "use" } });
      const vt = s.call("vic", "scripts", { id: "bell1", script: "bell", test: { on: "use" } });
      return { d: d.script?.status, would: d.script?.would?.[0]?.value?.rung, says: t.test?.says?.[0], vt: code(vt), wrote: s.entries().length - n0 }; },
    good: (o) => o.d === "would-run" && o.would === 1 && o.says === "the bell tolls for bob (1)" && o.vt === "rights" && o.wrote === 0 },
  // ---------------- E: events ----------------
  { id: "E1", what: "say events: a script that lists `say` hears a visitor's say (and never its own)", run(s) { cast(s);
      s.call("bob", "create", { id: "parrot", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "parrot", "echo", `world.on("say", (e) => { world.set("self", "heard", { by: e.by, text: e.text, n: (world.get("self", "heard")?.n ?? 0) + 1 }); world.say("squawk: " + e.text); });\n`, { scope: { ids: "self", comps: ["heard"], say: true }, on: ["say"] });
      s.call("vic", "say", { text: "!hello" });
      const act = s.entries().find((e: any) => e.actor === "bhv:parrot" && e.kind === "act"); const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null;
      return { heard: comp(s, "parrot", "heard"), squawks: s.entries().filter((e: any) => e.kind === "say" && e.actor === "bhv:parrot").map((e: any) => e.body.text),
        copied: JSON.stringify(act?.body?.event ?? {}).includes("!hello"), audit: A ? `${A.reran}/${A.acts} ${A.flags.map((f: any) => f.check).join(",")}` : null }; },
    good: (o) => o.heard?.by === "vic" && o.heard?.text === "!hello" && o.heard?.n === 1 && JSON.stringify(o.squawks) === '["squawk: !hello"]' && o.copied === false && o.audit === "1/1 " },
  { id: "E2", what: "enter / leave: the host says who arrived or left; scripts that list them hear it, by identity (presence, told by the host)", run(s) { cast(s);
      if (!D.presenceEvent) return { absent: true };
      s.call("bob", "create", { id: "door1", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "door1", "greet", `world.on("enter", (e) => world.set("self", "last", "hello " + e.by));\nworld.on("leave", (e) => world.set("self", "last", "bye " + e.by));\n`, { scope: { ids: "self", comps: ["last"] }, on: ["enter", "leave"] });
      T += 100; process.env.V4_NOW = String(T); const a = D.presenceEvent(s.w(), "enter", "vic").map((x: any) => x.status); const after1 = comp(s, "door1", "last");
      T += 100; process.env.V4_NOW = String(T); D.presenceEvent(s.w(), "leave", "vic"); const after2 = comp(s, "door1", "last");
      return { a, after1, after2 }; },
    good: (o) => JSON.stringify(o.a) === '["ran"]' && o.after1 === "hello vic" && o.after2 === "bye vic" },
  { id: "E3", what: "changed:<comp>: a lever's door opening lights the path (a cascade across scripts, one activation per triggering entry)", run(s) { cast(s);
      s.call("bob", "create", { id: "gate", model: "door", components: { door: { open: false } }, place: { at: [0, 0] } });
      s.call("bob", "set", { id: "gate", component: "reactions", value: { open: { kind: "toggle", component: "door", field: "open" } } });
      s.call("bob", "create", { id: "path", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "path", "lights", `world.on("changed:door", (e) => world.set("self", "glow", world.get("gate", "door").open === true));\n`, { scope: { ids: ["self", "gate"], comps: ["glow"] }, on: ["changed:door"] });
      s.call("vic", "use", { id: "gate", action: "open" }); const lit1 = comp(s, "path", "glow");
      s.call("vic", "use", { id: "gate", action: "open" }); const lit2 = comp(s, "path", "glow");
      const act = s.entries().findLast((e: any) => e.actor === "bhv:path" && e.kind === "act");
      return { lit1, lit2, on: act?.body?.on, by: act?.body?.trigger?.actor, comp: act?.body?.event?.comp }; },
    good: (o) => o.lit1 === true && o.lit2 === false && o.on === "changed:door" && o.by === "vic" && o.comp === "door" },
  { id: "E4", what: "sleep and wake: nobody here → the timer sleeps (0 entries); someone arrives → ONE wake {slept}, then ticks; never a burst", run(s) { cast(s);
      if (!D.tick) return { absent: true };
      s.call("bob", "create", { id: "clock", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "clock", "chime", `world.on("tick", () => world.set("self", "n", (world.get("self", "n") ?? 0) + 1));\nworld.on("wake", (e) => world.set("self", "woke", e.slept));\n`, { scope: { ids: "self", comps: ["n", "woke"] }, every: 10 });
      const n0 = s.entries().length; for (let i = 0; i < 360; i++) { s.advance(10000); s.tick(); } const asleep = s.entries().slice(n0).length;
      s.call("vic", "move", { to: [0, 0, 2] }); const evs: string[] = [];
      for (let i = 0; i < 3; i++) { s.advance(10000); for (const r of s.tick()) evs.push(r.status); }
      return { asleep, evs, woke: comp(s, "clock", "woke"), n: comp(s, "clock", "n") }; },
    good: (o) => o.asleep === 0 && JSON.stringify(o.evs) === '["ran","ran","ran"]' && o.woke >= 3590 && o.woke <= 3610 && o.n === 2 },
  // ---------------- P: param.<name> ----------------
  { id: "P1", what: "param.<name>: a script writes a signal into a component's data (a seat pose reads it); the schema keeps the rest of the value checked", run(s) { cast(s);
      s.call("bob", "create", { id: "swing", model: "swing-seat", place: { at: [0, 0] } });
      s.call("bob", "set", { id: "swing", component: "light", value: { kind: "point", intensity: 1 } });
      install(s, "bob", "swing", "pump", onUse(`world.param("self", "light", "lean", 0.25); world.param("self", "pose", "lean", -1);`), { scope: { ids: "self", comps: ["light", "pose"] }, on: ["use"] });
      s.call("bob", "set", { id: "swing", component: "reactions", value: { pump: { kind: "script", script: "pump" } } });
      const r = s.call("vic", "use", { id: "swing", action: "pump" });
      const typo = s.call("bob", "set", { id: "swing", component: "light", value: { kind: "point", intensty: 2, "param.lean": 1 } });
      return { r: st(s, r), light: comp(s, "swing", "light"), pose: comp(s, "swing", "pose"), typo: code(typo) }; },
    good: (o) => o.r === "ran" && o.light?.["param.lean"] === 0.25 && o.light?.intensity === 1 && o.pose?.["param.lean"] === -1 && o.typo === "schema" },
  { id: "P2", what: "param values are numbers: a direct set of param.lean = 'far' is refused, as is a bad parameter name, and world.param('x', 'on') throws in the script", run(s) { cast(s);
      s.call("bob", "create", { id: "seat", model: "crate", place: { at: [0, 0] } });
      const str = s.call("bob", "set", { id: "seat", component: "light", value: { kind: "point", "param.lean": "far" } });
      const name = s.call("bob", "set", { id: "seat", component: "light", value: { kind: "point", "param.9": 1 } });
      install(s, "bob", "seat", "p", onUse(`world.param("self", "light", "lean", "far");`), { scope: { ids: "self", comps: ["light"] }, on: ["use"] });
      s.call("bob", "set", { id: "seat", component: "reactions", value: { p: { kind: "script", script: "p" } } });
      return { str: code(str), name: code(name), script: st(s, s.call("vic", "use", { id: "seat", action: "p" })) }; },
    good: (o) => o.str === "shape" && o.name === "shape" && o.script === "failed thrown" },
  // ---------------- C: body effects meet consent ----------------
  { id: "C1", what: "41 #13 / §3d M4: a script `shove`s a visitor whose table says no (a behaviour is a stranger): refused where it lands, nothing logged; once vic allows it by name, it lands and the act records the consent used", run(s) { cast(s);
      s.call("bob", "create", { id: "trap", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "trap", "spring", onUse(`world.shove(e.by);`), { scope: { ids: "self", comps: [], bodies: ["shove"] }, on: ["use"] });
      s.call("bob", "set", { id: "trap", component: "reactions", value: { step: { kind: "script", script: "spring" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); const n0 = s.entries().length;
      const r1 = s.call("vic", "use", { id: "trap", action: "step" }); const bhv1 = s.entries().slice(n0).filter((e: any) => isBhv(e.actor)).length;
      s.call("vic", "consent", { allow: "bhv:trap", class: "shove" }); const r2 = s.call("vic", "use", { id: "trap", action: "step" });
      const act = s.entries().findLast((e: any) => e.actor === "bhv:trap" && e.kind === "act");
      return { r1: st(s, r1), bhv1, r2: st(s, r2), recorded: act?.body?.bodies, tumble: !!s.w().presence.bodies.vic?.tumble }; },
    good: (o) => o.r1 === "refused consent" && o.bhv1 === 0 && o.r2 === "ran" && JSON.stringify(o.recorded) === '[{"act":"shove","to":"body:vic","consent":"allowed"}]' && o.tumble },
  { id: "C2", what: "bodies need scope.bodies: a script that shoves without declaring it is refused (scope), whatever the target allows", run(s) { cast(s);
      s.call("bob", "create", { id: "trap", model: "crate", place: { at: [0, 0] } });
      install(s, "bob", "trap", "spring", onUse(`world.shove(e.by);`), { scope: { ids: "self", comps: [] }, on: ["use"] });
      s.call("bob", "set", { id: "trap", component: "reactions", value: { step: { kind: "script", script: "spring" } } });
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { preset: "performer" });
      return { r: st(s, s.call("vic", "use", { id: "trap", action: "step" })) }; },
    good: (o) => o.r === "refused scope" },
  { id: "C3", what: "§3d M4: a person may allow a sponsor's behaviours by name (bhvs:<sponsor>): every one of bob's scripts may then pose them; ann's still may not", run(s) { cast(s);
      for (const [who, id] of [["bob", "pad1"], ["bob", "pad2"], ["ann", "pad3"]]) { s.call(who, "create", { id, model: "crate", place: { at: [0, 0] } });
        install(s, who, id, "p", onUse(`world.pose(e.by, { clip: "wave" });`), { scope: { ids: "self", comps: [], bodies: ["pose"] }, on: ["use"] });
        s.call(who, "set", { id, component: "reactions", value: { go: { kind: "script", script: "p" } } }); }
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("vic", "consent", { allow: "bhvs:bob", class: "pose" });
      return { rs: ["pad1", "pad2", "pad3"].map((id) => st(s, s.call("vic", "use", { id, action: "go" }))) }; },
    good: (o) => JSON.stringify(o.rs) === '["ran","ran","refused consent"]' },
  // ---------------- M: v1 parity: the v1 SDK's three examples (sdk/examples), ported to this API ----------------
  { id: "M1", what: "v1 parity: bellkeeper (use → a pendulum motion + say), greeter (enter → say, a count), lighthouse (a timer that speaks only if someone's here), ported", run(s) { cast(s);
      if (!D.presenceEvent) return { absent: true };
      // bellkeeper: kv → a component in scope; emit('motion') → set motion (pivot is its own component in v4); emit('say') → say
      s.call("bob", "create", { id: "bell1", model: "bell", components: { pivot: { pos: [0, 1.6, 0] } }, place: { at: [0, 0] } });
      install(s, "bob", "bell1", "keeper", `world.on("use", (e) => {
  if (e.action !== "ring") return;
  const rings = (world.get("self", "bellkeeper")?.rings ?? 0) + 1;
  world.set("self", "bellkeeper", { rings });
  world.set("self", "motion", { type: "pendulum", axis: [0, 0, 1], amp: 0.5, phase: 0, damp: 0.25, period: world.knobs.period ?? 2.2, t0: Date.now() });
  world.say((world.knobs.note ?? "the bell tolls") + " (" + rings + ") — rung by " + e.by);
});
`, { scope: { ids: "self", comps: ["bellkeeper", "motion"], say: true }, on: ["use"], knobs: { period: 2.2, note: "the bell tolls" } });
      s.call("bob", "set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "keeper" } } });
      const ring = s.call("vic", "use", { id: "bell1", action: "ring" });
      // greeter: world-level in v1; in v4 a script lives on a thing (a sign), and hears every arrival
      s.call("bob", "create", { id: "sign", model: "crate", place: { at: [3, 0] } });
      install(s, "bob", "sign", "greeter", `world.on("enter", (e) => {
  const met = (world.get("self", "greeter")?.met ?? 0) + 1;
  world.set("self", "greeter", { met });
  world.say((world.knobs.greeting ?? "welcome") + ", " + (world.name(e.by) ?? e.by) + " — you are visitor #" + met);
});
`, { scope: { ids: "self", comps: ["greeter"], say: true }, on: ["enter"], knobs: { greeting: "welcome to the meadow" } });
      T += 100; process.env.V4_NOW = String(T); D.presenceEvent(s.w(), "enter", "vic");
      // lighthouse: world.every(60) → every: 60 in the component; people() → world.count()
      s.call("bob", "create", { id: "lamp1", model: "floor-lamp", place: { at: [-3, 0] } });
      install(s, "bob", "lamp1", "keeper", `world.on("tick", () => {
  const n = (world.get("self", "lighthouse")?.sweeps ?? 0) + 1;
  world.set("self", "lighthouse", { sweeps: n });
  const here = world.count();
  if (here > 0) world.say((world.knobs.text ?? "all clear") + " — sweep " + n + ", " + here + " soul(s) in view");
});
`, { scope: { ids: "self", comps: ["lighthouse"], say: true }, every: 60, knobs: { text: "all clear" } });
      s.call("vic", "move", { to: [0, 0, 2] });
      for (let i = 0; i < 3; i++) { s.advance(60000); s.tick(); }
      const says = s.entries().filter((e: any) => e.kind === "say" && isBhv(e.actor)).map((e: any) => e.body.text);
      NAMES.vic = "Vee"; // a rename in the directory afterwards: the audit replays the name the act recorded
      const A = AU ? AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript }) : null;
      return { ring: st(s, ring), motion: comp(s, "bell1", "motion")?.type, rings: comp(s, "bell1", "bellkeeper")?.rings, met: comp(s, "sign", "greeter")?.met, sweeps: comp(s, "lamp1", "lighthouse")?.sweeps, says,
        audit: A ? `${A.reran}/${A.acts} ${A.flags.map((f: any) => f.check).join(",")}` : null }; },
    opts: { nameOf: (id: string) => NAMES[id] ?? null },
    good: (o) => o.ring === "ran" && o.motion === "pendulum" && o.rings === 1 && o.met === 1 && o.sweeps === 2 && o.audit === "4/4 "
      && o.says.includes("the bell tolls (1) — rung by vic") && o.says.includes("welcome to the meadow, Vic — you are visitor #1") && o.says.includes("all clear — sweep 2, 1 soul(s) in view") },
  // ---------------- V: translated v1 behaviours ----------------
  { id: "V1", what: "a translated v1 world's behavior:<name> (a v1 binding) never runs; the status view says plainly it needs re-installing as script:<name>", run(s) { cast(s);
      const set = s.call("olive", "set", { id: "@world", component: "behavior:greeter", value: { src: "store/scripts/0123456789abcdef.js", attach: "bell1", knobs: {}, author: "olive", ts: 1 } });
      s.call("olive", "create", { id: "bell1", model: "bell", components: { reactions: { ring: { kind: "script", script: "greeter" } } }, place: { at: [0, 0] } });
      const use = s.call("vic", "use", { id: "bell1", action: "ring" });
      const v = s.call("olive", "scripts", {}); return { set: show(set), v1: v.v1, use: code(use), teach: use.refused?.teach }; },
    good: (o) => o.set === "ok" && o.v1?.[0]?.status === "needs-reinstall" && /re-install it as script:<name>/i.test(o.v1?.[0]?.why) && o.v1?.[0]?.attach === "bell1"
      && o.use === "no-runtime" && /re-install it as script:greeter/.test(o.teach) },
  // ---------------- H: hygiene and syntax ----------------
  { id: "H1", what: "41 #16 Trojan Source at upload: U+202E inside a comment; code at column 4,000; a BOM; a zero-width space", run(s) { cast(s);
      const up = (t: string) => code(s.call("bob", "upload", { text: t }));
      return { bidi: up(`// harmless ‮ ;)"neewteb"\nworld.on("use", () => {});`), wide: up(`world.on("use", () => {});${" ".repeat(4000)}world.set("self","a",1)`), bom: up(`﻿world.on("use", () => {});`), zw: up(`world.on("use", () => { const a​ = 1; });`) }; },
    good: (o) => o.bidi === "trojan-source" && o.wide === "long-line" && o.bom === "source-bom" && o.zw === "trojan-source" },
  { id: "H2", what: "…and at install (what binds): a blob put without upload's check is still refused when set as a script", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const src = s.w().putBlob({ lang: "js", api: 1, text: `// harmless ‮ ;)\nworld.on("use", () => {});` });
      const r = s.call("bob", "set", { id: "box", component: "script:a", value: { src, scope: { ids: "self", comps: ["a"] }, on: ["use"] } });
      return { r: code(r), why: r.refused?.reason }; },
    good: (o) => o.r === "trojan-source" && /U\+202E/.test(o.why) },
  { id: "H4", what: "a scope naming a typo of a registered component (lit → light) is refused at install, not at every run", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const r = install(s, "bob", "box", "a", onUse(`world.set("self", "lit", true);`), { scope: { ids: "self", comps: ["lit"] }, on: ["use"] }).r;
      const own = install(s, "bob", "box", "b", onUse(`world.set("self", "glow", true);`), { scope: { ids: "self", comps: ["glow", "my.place/lit"] }, on: ["use"] }).r;
      return { r: code(r), dym: r.refused?.didYouMean?.[0], own: show(own) }; },
    good: (o) => o.r === "schema" && o.dym === "light" && o.own === "ok" },
  { id: "H5", what: "uploads are rate-limited (20 a person a minute: a blob costs storage and a parse, and logs nothing)", run(s) { cast(s);
      const rs = []; for (let i = 0; i < 22; i++) rs.push(code(s.call("bob", "upload", { text: `world.on("use", () => {}); // ${i}` }, 10)) ?? "ok");
      s.advance(61000); rs.push(code(s.call("bob", "upload", { text: "// later" })) ?? "ok");
      return { rs }; },
    good: (o) => o.rs.slice(0, 20).every((x: string) => x === "ok") && o.rs[20] === "rate" && o.rs[21] === "rate" && o.rs[22] === "ok" },
  { id: "H3", what: "source that doesn't parse is refused at upload and at install, with the line", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const u = s.call("bob", "upload", { text: "world.on('use', () => {\n  world.set('self', 'a' 1);\n});" });
      const src = s.w().putBlob({ lang: "js", api: 1, text: "world.on('use', () => {\n  world.set('self', 'a' 1);\n});" });
      const r = s.call("bob", "set", { id: "box", component: "script:a", value: { src, scope: { ids: "self", comps: ["a"] }, on: ["use"] } });
      return { u: code(u), r: code(r), why: r.refused?.reason }; },
    good: (o) => o.u === "syntax" && o.r === "syntax" && /line 2/.test(o.why) },
];

// ---------------- S: the real server ----------------
const serverCases: Case[] = [{ id: "S1", server: true, what: "the server: a v4 world builds no v1 BehaviorHost; `use` → script over a WebSocket; a timer fires on the server's own tick; enter reaches scripts; the debug roster lists the door's view", run: async () => {
  const W4 = path.join(root, "srv"); fs.mkdirSync(W4, { recursive: true });
  const env = { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: W4, OPT_DIR: path.join(root, "opt"), SKIP_OPT_SWEEP: "1", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", JOIN_TOKEN: "", WORLD_ADMIN: "", EIDO_FLIGHT_REHEARSAL: "" };
  const f = Bun.spawnSync(["bun", "tools/v4/world.ts", "found", "chimes", "--owner", "Ann"], { cwd: ENGINE, env });
  if (f.exitCode !== 0) return { found: f.stderr.toString() };
  let port = 0; for (let p = 9300; p < 9500; p++) { if (p === 8968 || p === 8970) continue; try { const t = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); t.stop(true); port = p; break; } catch { /* taken */ } }
  const logf = path.join(root, "srv.log");
  const proc = Bun.spawn(["bun", "server/server.ts"], { cwd: ENGINE, env: { ...env, PORT: String(port) }, stdout: Bun.file(logf), stderr: Bun.file(logf + ".err") });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  try {
    let up = false; for (let i = 0; i < 100 && !up; i++) { await sleep(150); try { up = (await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* not yet */ } }
    if (!up) return { up: false, err: fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-600) : "" };
    const client = async (name: string) => { const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); const msgs: any[] = []; const waiters = new Map(); let n = 0;
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "v4-result") { const fn = waiters.get(m.id); if (fn) { waiters.delete(m.id); fn(m.reply); } } };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
      ws.send(JSON.stringify({ type: "join", world: "chimes", id: name, avatar: "", v4fold: true }));
      for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
      return { ws, msgs, you: msgs.find((m) => m.type === "snapshot")?.v4?.you, req: (tool: string, args: any = {}) => new Promise<any>((res) => { const rid = `${name}-${++n}`; waiters.set(rid, res); ws.send(JSON.stringify({ type: "v4", id: rid, tool, args })); setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 8000); }),
        send: (m: any) => ws.send(JSON.stringify(m)) }; };
    const ann = await client("Ann");
    const mk = await ann.req("create", { id: "bell1" });
    const up1 = await ann.req("upload", { text: BELL });
    const inst = await ann.req("set", { id: "bell1", component: "script:bell", value: { src: up1.src, scope: { ids: "self", comps: ["bell"], say: true }, on: ["use"] } });
    await ann.req("set", { id: "bell1", component: "reactions", value: { ring: { kind: "script", script: "bell" } } });
    const up2 = await ann.req("upload", { text: `world.on("tick", () => world.set("self", "beats", (world.get("self", "beats") ?? 0) + 1));\nworld.on("enter", (e) => world.set("self", "hello", e.by));\n` });
    const clock = await ann.req("set", { id: "bell1", component: "script:clock", value: { src: up2.src, scope: { ids: "self", comps: ["beats", "hello"] }, on: ["enter"], every: 5 } });
    const bob = await client("Bob"); await sleep(300);
    const ring = await bob.req("use", { id: "bell1", action: "ring" });
    await sleep(11500); // two 5 s periods on the server's 1 s clock (the first only arms the timer)
    const L = F.readLog(fs.readFileSync(path.join(W4, "chimes", "v4.jsonl")));
    const st0 = F.fold(L).entities.bell1?.c ?? {};
    const tickActs = L.filter((e: any) => e.kind === "act" && e.actor === "bhv:bell1" && e.body?.on === "tick").length;
    const dbg = await new Promise<any>((res) => { const on = (ev: any) => { const m = JSON.parse(String(ev.data)); if (m.type === "debug" && m.reqId === "d1") { ann.ws.removeEventListener("message", on); res(m); } };
      ann.ws.addEventListener("message", on); ann.send({ type: "debug", behaviors: true, reqId: "d1" }); setTimeout(() => res(null), 3000); });
    const srvLog = fs.readFileSync(logf, "utf8") + (fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8") : "");
    ann.ws.close(); bob.ws.close();
    return { mk: mk.ok, inst: show(inst), clock: show(clock), ring: ring.script?.status, rung: st0.bell?.rung, tickActs, beats: st0.beats, hello: st0.hello === bob.you,
      sawBhv: bob.msgs.some((m) => m.type === "v4-log" && m.entries.some((e: any) => e.actor === "bhv:bell1" && e.body?.on === "tick")),
      roster: dbg?.events?.map((e: any) => `${e.id}:${e.status}`), v1Host: /\[behaviors\]|behavior tick/.test(srvLog), malformed: F.fold(L).diagnostics.filter(([, c]: any) => String(c).startsWith("malformed")).length };
  } finally { proc.kill(); }
}, good: (o) => o.mk && o.inst === "ok" && o.clock === "ok" && o.ring === "ran" && o.rung === 1 && o.tickActs >= 1 && o.beats >= 1 && o.hello && o.sawBhv
  && o.roster?.includes("bell1/bell:active") && o.roster?.includes("bell1/clock:active") && !o.v1Host && o.malformed === 0 }];

// ---------------- run ----------------
let pass = 0, fail = 0;
const all = [...cases, ...(argv.includes("--no-server") ? [] : serverCases)];
for (const c of all) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false;
  try { o = c.server ? await c.run(null) : c.run(session(c.opts)); good = !!c.good(o) && !o?.absent; } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${JSON.stringify(o).slice(0, 700)}`}`);
}
console.log(`[scripts-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
