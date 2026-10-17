// tools/protocol/names-check.ts — names carry no body plan and set no kind against another (R 10-17 14:34–14:41, protocol
// minor 0, unreleased). Each row red first (against BASE: `--control` extracts it and runs every row there) and held by a
// mutation below; G rows are guards (green at base by design: what must NOT change).
//   bun tools/protocol/names-check.ts                 every row
//   bun tools/protocol/names-check.ts --only P1,C2    just those
//   bun tools/protocol/names-check.ts --tree <dir>    against another checkout (a mutant, or the base)
//   bun tools/protocol/names-check.ts --mutants       remove each fix in turn (a copy of shared/, server/, mcpl/, client/lib,
//                                                     spec/, docs/, AGENTS.md): its rows must go red; a no-op control stays green
//   bun tools/protocol/names-check.ts --control       every non-guard row must be red at BASE
// Rows:
//   N   refusal codes: hold-limit, beneath, not-pushable (were hands-full, underfoot, no-body); the old words map, never given
//   P   punt keeps its name; its flag is contact: true (shove: true taken at the door, recorded as contact); docs say no kick/feet
//   T   @world trusted-components (was trusted): the registry, the door, the load's rename (every load, idempotent), drafts.js
//   C   consent: tiers everyone/friends, cells allow/ask/deny, class displace, delegates apart from friends; old words on the
//       wire; a presence file and a browser's saved table in the old shape are rewritten
//   W   people: /worlds is one list with a declared word as a tag; no "(agent)"; the browser shows the declared word only;
//       no text sets humans against agents
//   O   leftover seat words → the occupy family (agent, client modules, socketRole, user-visible strings)
//   S   stale agent-visible addresses: light.daytime, sky.tz, the measure tool's socket child
//   A   grabbable.anim / station.anim (an open name of a pose or a clip; unknown → the body's default), grasp, anim-pose
//       reserved; old spellings taken at the door and renamed at load; wings-folded is a named pose; pose/animate by name
//   U   the action bar (UI ids and strings; was the emote bar)
//   X   the version history records it
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const BASE = "a6d05a6b";
const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["hold-limit is hands-full again", "shared/protocol/authority/bodyverbs.js", "refuse(\"hold-limit\",", "refuse(\"hands-full\",", ["N1", "N2"]],
  ["beneath is underfoot again", "shared/protocol/authority/manipulate.js", "refuse(\"beneath\",", "refuse(\"underfoot\",", ["N2"]],
  ["no old-word map", "shared/protocol/refusalcodes.js", "export const RENAMED_CODES = Object.freeze({ \"hands-full\": \"hold-limit\", \"underfoot\": \"beneath\", \"no-body\": \"not-pushable\" });", "export const RENAMED_CODES = Object.freeze({});", ["N3"]],
  ["the door records shove", "shared/protocol/authority/bodyverbs.js", "a = { ...a, contact: a.shove }; delete a.shove; }", "a = { ...a, contact: a.shove }; }", ["P2"]],
  ["no old spelling at the door", "shared/protocol/verbspec.js", ", shove: { type: \"bool\", doc: \"old spelling of contact (recorded as contact)\" }", "", ["P2"]],
  ["both spellings at once taken", "shared/protocol/authority/bodyverbs.js", "if (a.contact !== undefined) refuse(\"shape\", \"contact, or its old spelling shove: not both\", \"send contact: true\");", "", ["P3"]],
  ["the punt doc kicks again", "shared/protocol/verbspec.js", "send a loose thing beside your body (low by it", "kick a thing at your feet (low by it", ["P4"]],
  ["the browser sends shove", "client/lib/thingphysics.js", "sendRequest('punt', { id, v, contact: true });", "sendRequest('punt', { id, v, shove: true });", ["P5"]],
  ["the registry says trusted", "shared/protocol/componentspec.js", "  \"trusted-components\": { on: \"world\",", "  trusted: { on: \"world\",", ["T1"]],
  ["no rename at load", "shared/protocol/shaperepair.js", "export const RENAMED_COMPONENTS = Object.freeze({ \"@world\": Object.freeze({ trusted: \"trusted-components\" }) });", "export const RENAMED_COMPONENTS = Object.freeze({});", ["T2"]],
  ["drafts reads only the new key", "shared/drafts.js", "(worldC?.[TRUSTED] ?? worldC?.[OLD_TRUSTED])?.components", "worldC?.[TRUSTED]?.components", ["T3"]],
  ["the old tier is the tier", "shared/protocol/consent.js", "export const TIERS = [\"everyone\", \"friends\"];", "export const TIERS = [\"strangers\", \"friends\"];", ["C1", "C2"]],
  ["no old words on the wire", "shared/protocol/consent.js", "const tierOf = (t) => (Object.hasOwn(LEGACY_TIER, t) ? LEGACY_TIER[t] : t);", "const tierOf = (t) => t;", ["C2"]],
  ["drag is move again", "shared/protocol/consent.js", "drag: \"displace\", occupy: \"displace\", carry: \"displace\"", "drag: \"move\", occupy: \"displace\", carry: \"displace\"", ["C1"]],
  ["a friend may close the table", "shared/protocol/consent.js", "!(t.delegates ?? []).includes(actor)", "!(t.friends ?? []).includes(actor)", ["C3"]],
  ["the old list isn't the delegates", "shared/protocol/consent.js", "if (Array.isArray(t.friends) && !Array.isArray(t.delegates)) t.delegates = t.friends.slice(); }", "}", ["C4"]],
  ["no presence migration at load", "shared/protocol/authority/storage.js", "if (migratePresence(w.presence)) w.presenceDirty = true;", "", ["C5"]],
  ["the reply says strangers", "shared/protocol/authority/bodyconsent.js", "table: { preset: t.preset, everyone: t.everyone,", "table: { preset: t.preset, strangers: t.everyone,", ["C6"]],
  ["the browser keeps the old words", "client/lib/consent.js", "if (old) lsSet(KEY, JSON.stringify(t));", "", ["C7"]],
  ["/worlds sorts by kind", "server/routes.ts", "people: present.map((c) => ({ id: c.id, ...(c.declares ? { declares: c.declares } : {}) })),", "people: present.filter((c) => c.declares !== \"agent\").map((c) => c.id), agents: present.filter((c) => c.declares === \"agent\").map((c) => c.id),", ["W1"]],
  ["the tool says (agent)", "mcpl/tools.ts", "p.declares ? `${p.id} (${p.declares})` : p.id", "p.declares === \"agent\" ? `${p.id} (agent)` : p.id", ["W2"]],
  ["the plate says agent", "client/lib/platecard.js", "const where = [typeof r.declares === 'string' && r.declares ? r.declares : null,", "const where = [r.agent ? 'agent' : null,", ["W3"]],
  ["humans have an emote bar", "mcpl/tools.ts", "the same one-shots everyone has on the emote bar", "the same one-shots humans have on their emote bar", ["W4"]],
  ["the agent's seat again", "mcpl/agent.ts", "mayVacate(kind: \"move\"", "mayLeaveSeat(kind: \"move\"", ["O1"]],
  ["socketRole says seat", "shared/protocol/authority/sockets.js", "(bag(c?.station) ? \"station\" :", "(bag(c?.station) ? \"seat\" :", ["O2"]],
  ["the toast says seat", "client/lib/localbody.js", "moved what you were occupying, so you stood up", "moved the seat you were on, so you stood up", ["O3"]],
  ["light.noon again", "shared/protocol/descriptors.js", "daytime: { k: 'daytime', param: 'burnsAtNoon'", "daytime: { k: 'noon', param: 'burnsAtNoon'", ["S1"]],
  ["sky.clock again", "shared/worldentity.js", "    { t: 'text', k: 'tz', label: 'timezone', value: real ? (s.tz ?? DEFAULT_TZ) : '', ...ro,", "    { t: 'enum', k: 'clock', label: 'clock', value: real ? 'real' : 'authored', def: 'authored', options: [{ v: 'authored', label: 'authored' }, { v: 'real', label: 'real time' }] },\n    { t: 'text', k: 'tz', label: 'timezone', value: real ? (s.tz ?? DEFAULT_TZ) : '', ...ro,", ["S2"]],
  ["measure teaches set sockets", "mcpl/tools.ts", "a socket is a child entity, made with create {components: {parent: {to: id}", "act {verb: 'set', args: {id, component: 'sockets', value: {seat: {pos: [cx, y, cz], body: {pose: 'sitchair'}}}}} — or create {components: {parent: {to: id}", ["S3"]],
  ["the history forgets", "spec/PROTOCOL.md", "the refusal codes `hold-limit`, `beneath`, `not-pushable`", "the refusal codes", ["X1"]],
  ["the registry keeps pose", "shared/protocol/componentspec.js", "hold: \"string\", anim: \"string\", grips:", "hold: \"string\", pose: \"string\", grips:", ["A1"]],
  ["no door translation", "shared/protocol/authority/writes.js", "if (comp === \"grabbable\" || comp === \"station\") { const r = renameFields(comp, value);", "if (false) { const r = renameFields(comp, value);", ["A2"]],
  ["two-hand is a name", "shared/protocol/shaperepair.js", "if (comp === \"grabbable\" && p === \"two-hand\") {", "if (false) {", ["A2"]],
  ["an unknown name is refused", "shared/grab.js", "if (v.anim !== undefined && !(typeof v.anim === 'string' && ANIM_RE.test(v.anim)))", "if (v.anim !== undefined && !HOLD_POSES.includes(v.anim))", ["A3"]],
  ["an unknown name is held as written", "shared/grab.js", "if (g?.anim && ARMS[g.anim] && g.anim !== BOTH_HANDS) return g.anim;", "if (g?.anim) return g.anim;", ["A3"]],
  ["no field renames at load", "shared/protocol/shaperepair.js", "export const RENAMED_FIELDS = Object.freeze({ grabbable: Object.freeze({ pose: \"anim\", \"grips.*.fingers\": \"grasp\" }), station: Object.freeze({ pose: \"anim\" }) });", "export const RENAMED_FIELDS = Object.freeze({});", ["A2", "A4"]],
  ["the lift keeps pose", "shared/protocol/authority/sockets.js", "const b = \"pose\" in b0 && !(\"anim\" in b0) ? (({ pose, ...r }) => ({ ...r, anim: pose }))(b0) : b0;", "const b = b0;", ["A5"]],
  ["the wire says wingsFolded", "shared/wingpresence.js", "return { poses: folded === true ? [WINGS_FOLDED] : [] };", "return { wingsFolded: folded === true };", ["A6"]],
  ["the old flag isn't read", "shared/wingpresence.js", "return typeof sample.wingsFolded === 'boolean' ? sample.wingsFolded : null;", "return null;", ["A6"]],
  ["the fence drops poses", "server/posecheck.ts", "if (\"poses\" in p) { const c = cleanPoses(p.poses); if (c) p.poses = c; else delete p.poses; }", "delete p.poses;", ["A6"]],
  ["pose takes no name", "mcpl/tools.ts", "properties: { name: { type: \"string\", description: \"a pose by name (\\\"wings-folded\\\"), instead of bones\" }, bones:", "properties: { bones:", ["A7"]],
  ["anim-pose not reserved", "shared/protocol/componentspec.js", "  \"anim-pose\": \"a pose: one frame", "  \"x-anim-pose\": \"a pose: one frame", ["A1"]],
  ["the frame is emotes again", "client/lib/windows.js", "  actions:  { x: 'center'", "  emotes:   { x: 'center'", ["U1"]],
  ["the lite row is lite-emotes", "client/lib/emotebar_lite.js", "row.className = 'lite-actions';", "row.className = 'lite-emotes';", ["U1"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/consent.js", "// Ported from the protocol lab (2026-10-05);", "//  Ported from the protocol lab (2026-10-05);", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/names-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/, server/, spec/, docs/, mcpl/ (without node_modules), client/lib and AGENTS.md copied; the rest linked back
function copyTree(tag: string) { const d = scratch(tag);
  for (const k of ["shared", "server", "spec", "docs"]) fs.cpSync(path.join(ENGINE, k), path.join(d, k), { recursive: true });
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* none */ }
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") fs.symlinkSync(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  fs.copyFileSync(path.join(ENGINE, "AGENTS.md"), path.join(d, "AGENTS.md"));
  for (const k of fs.readdirSync(ENGINE)) if (![".git", "worlds", "store"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("namesmut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[names-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  const d = scratch("namesctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server mcpl client spec docs AGENTS.md | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* none */ }
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const guard = (l: string) => /^(ok|FAIL)\s+G\d/.test(l);
  const wrong = lines.filter((l) => (l.startsWith("ok ") && !guard(l)) || (l.startsWith("FAIL") && guard(l)));
  console.log(lines.map((l) => `${wrong.includes(l) ? "WRONG AT BASE:       " : "as expected at base: "}${l.slice(0, 150)}`).join("\n"));
  console.log(`[names-check --control] at ${BASE}: ${lines.length} rows, ${wrong.length} wrong (every row red there but the guards, which stay green)`);
  process.exit(wrong.length ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const ONLY = opt("only")?.split(",") ?? null;
const want = (id: string) => !ONLY || ONLY.includes(id);
const readText = (rel: string) => { try { return fs.readFileSync(TREE + rel, "utf8"); } catch { return ""; } };
const exists = (rel: string) => fs.existsSync(TREE + rel);
const root = scratch("names");
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const VS = await import(TREE + "shared/protocol/verbspec.js");
const RC = await import(TREE + "shared/protocol/refusalcodes.js");
const C = await import(TREE + "shared/protocol/consent.js");
const CS = await import(TREE + "shared/protocol/componentspec.js");
const SL = await import(TREE + "shared/protocol/simlayer.js");
const ENG = { engine: Object.keys(SL.ENGINES).find((k: string) => k.startsWith("eidosim@")) };

function openWorld(name: string, presence: any = { bodies: {}, holds: {} }) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  w.catalogue = D.LAB_CATALOGUE;
  return w;
}
let T = 1800000000000, N = 0;
function session() {
  const name = `n${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 1000) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: Wd, entries: () => Wd().entries, reopen: (presence?: any) => (w = openWorld(name, presence)) };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const code = (r: any) => (r?.ok ? "ok" : r?.refused?.code ?? (r?.crashed ? "CRASH" : "?"));
// owner olive, visitor vic; a world running eidosim; loose crates anyone may punt or pick up
function cast(s: any) {
  s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "visitor" } });
  s.call("olive", "set", { id: "@world", component: "physics-engine", value: ENG });
  for (const [id, x] of [["crate", 0], ["b", 3], ["c", 1.5]]) s.call("olive", "create", { id, model: "crate", components: { physics: { kind: "dynamic", who: "visitor" } }, place: { at: [x, 0] } });
}
const AGAINST = [0, 0, -0.62];   // vic against the crate's -z face (0.3 m half-width + a 0.32 m body)
const lastAct = (s: any, verb: string, actor: string) => s.entries().findLast((e: any) => e.kind === "act" && e.verb === verb && e.actor === actor) ?? null;
const authoritySrc = () => [readText("shared/protocol/authority.js"), ...fs.readdirSync(TREE + "shared/protocol/authority").map((f: string) => readText(`shared/protocol/authority/${f}`))].join("\n");

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- N: refusal codes ----------------
  { id: "N1", what: "(R 14:34) a grab past MAX_HELD is refused hold-limit (never hands-full)", run(s) { cast(s);
      const take = (id: string, x: number) => { s.call("vic", "move", { to: [x, 0, -0.8] }); return code(s.call("vic", "grab", { id })); };
      return { r: [take("crate", 0), take("b", 3), take("c", 1.5)] }; },
    good: (o) => o.r.join() === "ok,ok,hold-limit" },
  { id: "N2", what: "…the registry holds hold-limit, beneath and not-pushable and none of the old three; the authority refuses with the new words only", run() {
      const src = authoritySrc();
      return { has: ["hold-limit", "beneath", "not-pushable"].every((c) => RC.isRefusalCode(c)), old: ["hands-full", "underfoot", "no-body"].filter((c) => RC.isRefusalCode(c)),
        gives: ["hold-limit", "beneath", "not-pushable"].every((c) => src.includes(`refuse("${c}"`)), givesOld: ["hands-full", "underfoot", "no-body"].filter((c) => src.includes(`refuse("${c}"`)) }; },
    good: (o) => o.has && !o.old.length && o.gives && !o.givesOld.length },
  { id: "N3", what: "…a reader maps an older log's word through RENAMED_CODES / canonicalCode", run() {
      return { map: RC.RENAMED_CODES ?? null, c: ["hands-full", "underfoot", "no-body", "rights"].map((x) => RC.canonicalCode?.(x) ?? null) }; },
    good: (o) => JSON.stringify(o.c) === '["hold-limit","beneath","not-pushable","rights"]' },
  { id: "G1", what: "(guard) the fold reads a log whose refused act carries an old code: status ok, the act kept as written", run(s) {
      s.call("olive", "create-world", { title: s.name }); const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world;
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), JSON.stringify({ world: wid, kind: "act", actor: "olive", verb: "grab", body: { args: ["id"], refused: { code: "hands-full" } }, ts: L.at(-1).ts + 1 }) + "\n");
      const w = s.reopen(); const st = w.state(); return { status: st.status, kept: w.entries.at(-1)?.body?.refused?.code ?? null }; },
    good: (o) => o.status === "ok" && o.kept === "hands-full" },
  // ---------------- P: punt {contact} ----------------
  { id: "P1", what: "(R 14:34) punt {contact: true} from a body against the crate is admitted, and the act records contact: true", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], contact: true });
      return { r: show(r), req: lastAct(s, "punt", "vic")?.body?.request ?? null }; },
    good: (o) => o.r === "ok" && o.req?.contact === true && !("shove" in o.req) },
  { id: "P2", what: "…its old spelling shove: true is taken at the door and recorded as contact (no shove in the act); help lists contact", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], shove: true });
      return { r: show(r), req: lastAct(s, "punt", "vic")?.body?.request ?? null, args: Object.keys(VS.VERBSPEC.punt.args) }; },
    good: (o) => o.r === "ok" && o.req?.contact === true && !("shove" in o.req) && o.args.includes("contact") },
  { id: "P3", what: "…both spellings at once is a shape refusal (and a refused contact push stays unrecorded)", run(s) { cast(s);
      s.call("vic", "move", { to: AGAINST }); const n = s.entries().length; const r = s.call("vic", "punt", { id: "crate", v: [0, 0.2, 1.8], contact: true, shove: true });
      return { r: show(r), logged: s.entries().length - n }; },
    good: (o) => /^refused shape/.test(o.r) && o.logged === 0 },
  { id: "P4", what: "…punt's words carry no feet and no kick: the verbspec row, the act tool's punt line, AGENTS.md", run() {
      const d = JSON.stringify(VS.VERBSPEC.punt), t = readText("mcpl/tools.ts"), a = readText("AGENTS.md");
      const punt = (t.match(/punt \{id, power\?\|v\?\} \([^)]*\)/) ?? [""])[0], ag = (a.match(/`punt \{id, power\? \| v\?\}`[^.]*\./) ?? [""])[0];
      return { d: /kick|feet/i.test(d), punt, ag: ag.slice(0, 160), t: /kick a thing at your feet/.test(t), a: /kicks a thing at your feet/.test(a) }; },
    good: (o) => !o.d && !!o.punt && !/kick|feet/.test(o.punt) && !!o.ag && !/kick a|feet/.test(o.ag) && !o.t && !o.a },
  { id: "P5", what: "…the browser and the agent send contact (never shove: true)", run() {
      const tp = readText("client/lib/thingphysics.js"), ag = readText("mcpl/agent.ts");
      return { tp: /sendRequest\('punt', \{ id, v, contact: true \}\)/.test(tp) && !/shove: true \}\)/.test(tp), ag: /request\("punt", \{ id, v, contact: true \}\)/.test(ag) && !/"punt", \{ id, v, shove: true/.test(ag) }; },
    good: (o) => o.tp && o.ag },
  // ---------------- T: trusted-components ----------------
  { id: "T1", what: "(R 14:34) @world trusted-components {components} is the owner's; @world trusted is no registered name any more (refused)", run(s) {
      s.call("olive", "create-world", { title: s.name }); const v = { components: ["hesperus/material"] };
      const a = s.call("olive", "set", { id: "@world", component: "trusted-components", value: v }), b = s.call("olive", "set", { id: "@world", component: "trusted", value: v });
      return { a: show(a), b: show(b), reg: Object.hasOwn(CS.COMPONENTS, "trusted-components"), old: Object.hasOwn(CS.COMPONENTS, "trusted"), c: s.w().state().entities["@world"].c["trusted-components"] ?? null }; },
    good: (o) => o.a === "ok" && /^refused/.test(o.b) && o.reg && !o.old && JSON.stringify(o.c) === '{"components":["hesperus/material"]}' },
  { id: "T2", what: "…a world whose log holds @world trusted is renamed at load (the system's rename-components act, the value kept, the old key gone); the next load writes nothing", run(s) {
      s.call("olive", "create-world", { title: s.name }); const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const v = { components: ["hesperus/material"] };
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), [{ world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "@world", component: "trusted", value: v } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "@world", comp: "trusted", value: v }, ts: ts + 1 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); const before = Object.keys(w1.state().entities["@world"].c); const out = D.liftWorld(w1);
      const w2 = s.reopen(); const c = w2.state().entities["@world"].c; const acts = w2.entries.filter((e: any) => e.kind === "act" && e.verb === "rename-components" && e.actor === "system");
      const k = w2.entries.length; D.liftWorld(w2); const again = s.reopen().entries.length - k;
      return { before, out: JSON.stringify(out).slice(0, 300), keys: Object.keys(c), val: c["trusted-components"] ?? null, acts: acts.length, body: acts[0]?.body ?? null, again, status: w2.state().status }; },
    good: (o) => o.before.includes("trusted") && !o.keys.includes("trusted") && JSON.stringify(o.val) === '{"components":["hesperus/material"]}' && o.acts === 1 && o.body?.renamed?.[0]?.to === "trusted-components" && o.again === 0 && o.status === "ok" },
  { id: "T3", what: "…drafts.js: TRUSTED is trusted-components and trustedOf reads a world not yet reloaded (the old key) too", async run() {
      const DR = await import(TREE + "shared/drafts.js");
      return { k: DR.TRUSTED, nw: DR.trustedOf({ "trusted-components": { components: ["a/b"] } }), old: DR.trustedOf({ trusted: { components: ["a/c"] } }) }; },
    good: (o) => o.k === "trusted-components" && JSON.stringify(o.nw) === '["a/b"]' && JSON.stringify(o.old) === '["a/c"]' },
  // ---------------- C: consent ----------------
  { id: "C1", what: "(R 14:41) the table's words: tiers everyone/friends, cells allow/ask/deny, class displace (no move), drag/occupy/carry → displace; every preset in those words", run() {
      const words = (p: any) => Object.keys(p).sort().join() === "everyone,friends" && Object.values(p).every((row: any) => Object.keys(row).every((c) => C.CLASSES.includes(c)) && Object.values(row).every((m) => ["allow", "ask", "deny"].includes(m as string)));
      return { tiers: C.TIERS ?? null, modes: C.MODES ?? null, cls: C.CLASSES, kinds: [C.KIND_CLASS.drag, C.KIND_CLASS.occupy, C.KIND_CLASS.carry], presets: Object.values(C.PRESETS).every(words) }; },
    good: (o) => JSON.stringify(o.tiers) === '["everyone","friends"]' && JSON.stringify(o.modes) === '["allow","ask","deny"]' && o.cls.includes("displace") && !o.cls.includes("move") && o.kinds.every((k: string) => k === "displace") && o.presets },
  { id: "C2", what: "…set {tier: everyone, mode: allow} is stored and read back; the old words (strangers, everyone|nobody, move) are still taken and stored in today's", run() {
      const P: any = {}; const now = 1e12;
      const a = C.setConsent(P, "u-a", { set: { class: "touch", tier: "everyone", mode: "allow" } }, now);
      const b = C.setConsent(P, "u-a", { set: { class: "move", tier: "strangers", mode: "nobody" } }, now);
      const c = C.setConsent(P, "u-a", { set: { class: "pose", tier: "friends", mode: "everyone" } }, now);
      return { ok: [a.ok, b.ok, c.ok], cells: JSON.parse(JSON.stringify(P.consent["u-a"].cells)), d: C.decide(P, "u-b", "u-a", "touch", now).mode, d2: C.decide(P, "u-b", "u-a", "displace", now).mode }; },
    good: (o) => o.ok.every(Boolean) && o.cells.everyone?.touch === "allow" && o.cells.everyone?.displace === "deny" && o.cells.friends?.pose === "allow" && !o.cells.strangers && o.d === "allow" && o.d2 === "deny" },
  { id: "C3", what: "…delegates apart from friends: a friend (mutual) gets the friends tier but can't close the table; a delegate closes it and never opens it", run() {
      const P: any = {}; const now = 1e12;
      C.setConsent(P, "u-a", { friend: "u-f" }, now); C.setConsent(P, "u-f", { friend: "u-a" }, now); C.setConsent(P, "u-a", { delegate: "u-d" }, now);
      const tier = C.decide(P, "u-f", "u-a", "touch", now).tier;
      const fClose = C.setConsent(P, "u-f", { of: "u-a", pause: true }, now), dOpen = C.setConsent(P, "u-d", { of: "u-a", preset: "open" }, now), dClose = C.setConsent(P, "u-d", { of: "u-a", pause: true }, now);
      const t = C.tableOf(P, "u-a");
      return { tier, fClose: fClose.ok, dOpen: dOpen.ok, dClose: dClose.ok, paused: t.paused, delegates: t.delegates, friends: t.friendsList, vs: Object.keys(VS.VERBSPEC.consent.args) }; },
    good: (o) => o.tier === "friends" && o.fClose === false && o.dOpen === false && o.dClose === true && o.paused && JSON.stringify(o.delegates) === '["u-d"]' && JSON.stringify(o.friends) === '["u-f"]' && o.vs.includes("delegate") },
  { id: "C4", what: "…migratePresence rewrites a table in the old shape (strangers/everyone/nobody/move) and makes the old friends list the delegates too; marked once, so a delegates list emptied since stays empty", run() {
      const P: any = { consent: { "u-a": { preset: "normal", cells: { strangers: { move: "everyone", touch: "nobody" }, friends: { shove: "nobody" } }, friends: ["u-f"], over: { "u-x": { move: { mode: "deny" } } } } } };
      const n = C.migratePresence?.(P); const t = JSON.parse(JSON.stringify(P.consent["u-a"]));
      P.consent["u-a"].delegates = []; C.migratePresence?.(P);
      return { n, t, again: P.consent["u-a"].delegates, mark: P.consentShape }; },
    good: (o) => o.n === 1 && o.t.cells.everyone?.displace === "allow" && o.t.cells.everyone?.touch === "deny" && o.t.cells.friends?.shove === "deny" && !o.t.cells.strangers && JSON.stringify(o.t.friends) === '["u-f"]' && JSON.stringify(o.t.delegates) === '["u-f"]' && o.t.over["u-x"]?.displace?.mode === "deny" && !o.t.over["u-x"].move && JSON.stringify(o.again) === "[]" && o.mark === 2 },
  { id: "C5", what: "…the authority's load (worldOf) reads a presence file in the old shape and holds today's", run(s) {
      s.call("olive", "create-world", { title: s.name });
      const w = s.reopen({ bodies: {}, holds: {}, consent: { "u-a": { cells: { strangers: { pose: "everyone" } }, friends: ["u-f"] } } });
      const t = C.tableOf(w.presence, "u-a"); return { pose: t.everyone?.pose ?? null, delegates: t.delegates ?? null, raw: JSON.stringify(w.presence.consent["u-a"]) }; },
    good: (o) => o.pose === "allow" && JSON.stringify(o.delegates) === '["u-f"]' && !/strangers/.test(o.raw) },
  { id: "C6", what: "…consent {} answers in today's words: table.everyone, friends, friendsList, delegates (no strangers, no trusted); look's own shield says everyone", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "move", { to: [0, 0, 0] });
      const r = s.call("olive", "consent", {}); const l = s.call("olive", "look", {});
      return { keys: Object.keys(r.table ?? {}), lk: JSON.stringify(l).match(/"shield":\{[^}]*\{[^}]*\}/)?.[0] ?? JSON.stringify(l).slice(0, 200) }; },
    good: (o) => ["everyone", "friends", "friendsList", "delegates"].every((k) => o.keys.includes(k)) && !o.keys.includes("strangers") && !o.keys.includes("trusted") && /"everyone":/.test(o.lk) && !/strangers/.test(o.lk) },
  { id: "C7", what: "…a browser's saved table in the old words (ew-consent) is read as today's and saved back; cells, presets and the switches speak allow/deny", async run() {
      const store: Record<string, string> = { "ew-consent": JSON.stringify({ strangers: { move: "everyone", pose: "nobody" }, friends: { touch: "nobody" } }) };
      globalThis.localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } } as any;
      const CC = await import(TREE + "client/lib/consent.js");
      return { t: CC.table(), saved: JSON.parse(store["ew-consent"]), push: CC.pushable(), tiers: CC.TIERS }; },
    good: (o) => o.t.everyone?.displace === "allow" && o.t.everyone?.pose === "deny" && o.t.friends?.touch === "deny" && !o.t.strangers && o.saved.everyone?.displace === "allow" && !o.saved.strangers && JSON.stringify(o.tiers) === '["everyone","friends"]' },
  // ---------------- W: people ----------------
  { id: "W1", what: "(R 14:41) /worlds answers ONE people list of {id, declares?} (no agents list)", run() {
      const src = readText("server/routes.ts"); const h = src.slice(src.indexOf('u.pathname === "/worlds"'), src.indexOf('u.pathname === "/worlds"') + 2000);
      return { one: /people: present\.map\(\(c\) => \(\{ id: c\.id, \.\.\.\(c\.declares \? \{ declares: c\.declares \} : \{\}\) \}\)\)/.test(h), agents: /agents:/.test(h) }; },
    good: (o) => o.one && !o.agents },
  { id: "W2", what: "…the worlds tool shows each id with its declared word, if any: no \"(agent)\" suffix, no agents list read", run() {
      const t = readText("mcpl/tools.ts"); return { suffix: /\(agent\)`/.test(t), agentsRead: /w\.agents/.test(t), tag: /p\.declares \? `\$\{p\.id\} \(\$\{p\.declares\}\)` : p\.id/.test(t) }; },
    good: (o) => !o.suffix && !o.agentsRead && o.tag },
  { id: "W3", what: "…the browser keeps the declared word as said (no agent boolean) and its nameplate card and chat line show that word only", run() {
      const net = readText("client/lib/net.js"), rem = readText("client/lib/remotes.js"), pc = readText("client/lib/platecard.js"), ch = readText("client/lib/chat.js"), ix = readText("client/index.html");
      return { net: (net.match(/declares: (msg|p)\.declares \?\? null/g) ?? []).length, rem: /declares: meta\.declares \?\? null/.test(rem) && !/agent: !!meta\.agent/.test(rem),
        pc: /r\.declares : null/.test(pc) && !/r\.agent \? 'agent'/.test(pc), ch: /w\.dataset\.declares = declared/.test(ch) && !/\?\.agent\)/.test(ch), css: /\.who\[data-declares\]::after/.test(ix) && !/\.line\.agent/.test(ix) }; },
    good: (o) => o.net === 2 && o.rem && o.pc && o.ch && o.css },
  { id: "W4", what: "…no text sets humans against agents: the emote tool, the sound and picture alt notes, refusal.js, grab.js, sockbody.js, browservoice.js", run() {
      const t = readText("mcpl/tools.ts"), so = readText("shared/sound.js"), pi = readText("shared/picture.js"), rf = readText("shared/protocol/refusal.js"), gr = readText("shared/grab.js"), sb = readText("shared/sockbody.js"), bv = readText("client/lib/browservoice.js");
      return { emote: /one-shots humans have/.test(t), alt: /agents and people who can/.test(so + pi), rf: /shown to humans|for agents and people|by agents' tools/.test(rf), alike: /for people and agents alike/.test(gr + sb), bv: /a human and an\s*\/\/\s*agent|a human and an agent/.test(bv), same: /the same for people and agents/.test(t) }; },
    good: (o) => !o.emote && !o.alt && !o.rf && !o.alike && !o.bv && !o.same },
  // ---------------- O: the occupy family ----------------
  { id: "O1", what: "(R 14:41) the agent and the client speak the occupy family: no seatOf/seatName/mySeat/mayLeaveSeat/mySeatBody in agent.ts, no setSeatHook/inSitReach anywhere, seats.js/seatedit.js/seatbody.js renamed", run() {
      const ag = readText("mcpl/agent.ts"), tl = readText("mcpl/tools.ts"), ctl = readText("client/lib/controller.js"), sk = readText("shared/sockbody.js"), cu = readText("client/lib/clickuse.js");
      return { ag: /\b(seatOf|seatName|mySeat|mayLeaveSeat|mySeatBody)\b/.test(ag + tl), hooks: /\bsetSeatHook\b/.test(ctl) || /\binSitReach\b/.test(sk) || /\bseatOf\b/.test(cu),
        files: ["client/lib/seats.js", "client/lib/seatedit.js", "client/lib/seatbody.js"].filter(exists), now: ["client/lib/occupants.js", "client/lib/socketedit.js", "client/lib/occupybody.js"].every(exists) }; },
    good: (o) => !o.ag && !o.hooks && !o.files.length && o.now },
  { id: "O2", what: "…a socket with a station is a `station` (socketRole): inspect lists a host's sockets as station | snap | attach", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.call("olive", "create", { id: "sofa", model: "crate", place: { at: [3, 0] } });
      s.call("olive", "create", { id: "sofa-l", components: { parent: { to: "sofa" }, transform: { pos: [0, 0.45, 0] }, socket: { name: "left" }, station: { action: "sit" } } });
      const r = s.call("olive", "inspect", { id: "sofa" }); const SK = { a: readText("shared/sockbody.js") };
      return { r: show(r), as: (r.sockets ?? []).map((x: any) => x.as), sk: /isObj\(c\?\.station\) \? 'station'/.test(SK.a) }; },
    good: (o) => o.r === "ok" && JSON.stringify(o.as) === '["station"]' && o.sk },
  { id: "O3", what: "…the user-visible words: the editor's tool tile reads 'station', the toast says 'moved what you were occupying', '+ socket here'", run() {
      const ep = readText("client/lib/editpanels.js"), lb = readText("client/lib/localbody.js"), es = readText("shared/editschema.js");
      return { tile: /label: 'station', icon: 'armchair'/.test(ep), toast: /moved what you were occupying/.test(lb) && !/moved the seat you were on/.test(lb), add: /'\+ socket here'/.test(es) && !/'\+ seat here'/.test(es) }; },
    good: (o) => o.tile && o.toast && o.add },
  // ---------------- S: stale agent-visible addresses ----------------
  { id: "S1", what: "(R 14:41) a light's burns-at-noon is addressed light.daytime (never light.noon): the card's row and an edit through it", async run() {
      const ES = await import(TREE + "shared/editschema.js");
      const lamp = { model: "lamp", pos: [0, 0, 0], light: { color: 1, intensity: 16 } };
      const sch = ES.inspectSchema?.(lamp, "lamp", { materials: [] }); const g = (sch?.groups ?? []).find((x: any) => x.group === "light");
      const e = ES.editOps?.(lamp, "lamp", { "light.daytime": true }); const old = ES.editOps?.(lamp, "lamp", { "light.noon": true });
      const flat = (ops: any[]) => ops.flatMap((o: any) => (o.verb === "batch" ? o.args.ops : [o]));
      return { keys: (g?.fields ?? []).map((f: any) => f.k), w: JSON.stringify(flat(e?.ops ?? [])), oldErr: old?.errors ?? [] }; },
    good: (o) => o.keys.includes("daytime") && !o.keys.includes("noon") && /"daytime":"full"/.test(o.w) && o.oldErr.length > 0 },
  { id: "S2", what: "…the world's Sky card has sky.tz (empty: the authored clock) and no sky.clock; an edit of sky.clock is no field", async run() {
      const WE = await import(TREE + "shared/worldentity.js");
      const st = { entities: { "@world": { c: { sky: { hours: 12, rate: 0 } } } } };
      const sch = WE.worldSchema?.(st, { now: 0 }); const g = (sch?.groups ?? []).find((x: any) => x.group === "sky");
      const e = WE.worldEditOps?.(st, { "sky.clock": "real" }, { now: 0 }); const t = WE.worldEditOps?.(st, { "sky.tz": "Europe/Paris" }, { now: 0 });
      return { keys: (g?.fields ?? []).map((f: any) => f.k), err: e?.errors ?? [], tz: JSON.stringify(t?.ops ?? []) }; },
    good: (o) => o.keys.includes("tz") && !o.keys.includes("clock") && o.err.length > 0 && /"tz":"Europe\/Paris"/.test(o.tz) && !/"clock"/.test(o.tz) },
  { id: "S3", what: "…the measure tool teaches a socket child (create {components: {parent, transform, socket, station}}), never set sockets; the inspect tool lists light.daytime and sky.tz", run() {
      const t = readText("mcpl/tools.ts"); const at = (n: string) => { const i = t.indexOf(`name: "${n}", description: "`); return i < 0 ? "" : t.slice(i, t.indexOf("inputSchema", i)); }; const m = at("measure"), i = at("inspect");
      return { m: /create \{components: \{parent: \{to: id\}, transform: \{pos: \[cx, y, cz\]\}, socket: \{name: 'seat'\}, station: \{anim: 'sitchair'\}\}\}/.test(m), old: /component: 'sockets'/.test(m), i: /light\.daytime/.test(i) && /sky\.tz/.test(i) && !/light\.noon|sky\.clock/.test(i) }; },
    good: (o) => o.m && !o.old && o.i },
  // ---------------- A: anim (R 10-17 15:09/15:11) ----------------
  { id: "A1", what: "(R 15:09/15:11) the registry: grabbable.anim and station.anim (no pose, no closed enum), a grip's grasp, anim-pose reserved beside anim-clip", run() {
      const G = CS.COMPONENTS.grabbable, S = CS.COMPONENTS.station; const GR = readText("shared/grab.js");
      return { g: Object.keys(G.fields), genum: G.enums?.pose ?? null, s: Object.keys(S.fields), ap: CS.COMPONENTS["anim-pose"]?.status ?? null, ac: CS.COMPONENTS["anim-clip"]?.status ?? null, grasp: /GRIP_KEYS = \['pos', 'q', 'hand', 'role', 'grasp', 'part'\]/.test(GR) }; },
    good: (o) => o.g.includes("anim") && !o.g.includes("pose") && o.genum === null && o.s.includes("anim") && !o.s.includes("pose") && o.ap === "reserved" && o.ac === "reserved" && o.grasp },
  { id: "A2", what: "…a write in the old spelling is taken and stored in the new, with a note: grabbable {pose: torch, grips.fingers} → {anim: torch, grips.grasp}; pose two-hand → twoHanded: true; station {pose} → anim", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } }); s.call("olive", "create", { id: "rod", model: "book", place: { at: [2, 0] } });
      const a = s.call("olive", "set", { id: "cup", component: "grabbable", value: { pose: "torch", grips: { h: { pos: [0, 0.1, 0], fingers: "pinch" } } } });
      const b = s.call("olive", "set", { id: "rod", component: "grabbable", value: { pose: "two-hand" } });
      s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      const c = s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie", pose: "lie" } } });
      const E = s.w().state().entities; const kid = Object.keys(E).find((k) => E[k].c.socket?.name === "bunk");
      return { a: show(a), b: show(b), c: show(c), cup: E.cup?.c.grabbable ?? null, rod: E.rod?.c.grabbable ?? null, st: kid ? E[kid].c.station : null, notes: JSON.stringify(a.notes ?? []) }; },
    good: (o) => o.a === "ok" && o.b === "ok" && o.c === "ok" && o.cup?.anim === "torch" && !("pose" in o.cup) && o.cup?.grips?.h?.grasp === "pinch" && !("fingers" in o.cup.grips.h)
      && o.rod?.twoHanded === true && !("pose" in o.rod) && !("anim" in o.rod) && o.st?.anim === "lie" && !("pose" in o.st) && /renamed before release/.test(o.notes) },
  { id: "A3", what: "…anim is an OPEN name: one the body doesn't know is admitted and held as the body's default (by size), never refused; a built-in one (torch) is held as named", async run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      const r = s.call("olive", "set", { id: "cup", component: "grabbable", value: { anim: "juggle-overhand" } });
      const GB = await import(TREE + "shared/grab.js"); const g = GB.grabOf(s.w().state().entities.cup?.c ?? {});
      return { r: show(r), held: GB.holdPoseOf(g, [0.2, 0.2, 0.2]), big: GB.holdPoseOf(g, [1, 1, 1]), torch: GB.holdPoseOf(GB.grabOf({ grabbable: { anim: "torch" } }), [0.2, 0.2, 0.2]), two: GB.holdPoseOf(GB.grabOf({ grabbable: { twoHanded: true } }), [0.2, 0.2, 0.2]), named: GB.HOLD_POSES ?? null }; },
    good: (o) => o.r === "ok" && o.held === "hand" && o.big === "carry" && o.torch === "torch" && o.two === "both-hands" && JSON.stringify(o.named) === '["hand","carry","torch","pistol","shoulder"]' },
  { id: "A4", what: "…a log holding grabbable.pose / a grip's fingers / station.pose is renamed at load (rename-components, every load, idempotent): anim, grasp, twoHanded", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie" } } });
      const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const E0 = s.w().state().entities; const kid = Object.keys(E0).find((k) => E0[k].c.socket?.name === "bunk");
      const gv = { who: "visitor", pose: "pistol", grips: { h: { pos: [0, 0.1, 0], fingers: "point" } } }, sv = { action: "lie", anchor: "root", pose: "lie" };
      fs.appendFileSync(path.join(root, "worlds", `${s.name}.jsonl`), [
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "cup", component: "grabbable", value: gv } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "cup", comp: "grabbable", value: gv }, ts: ts + 1 },
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: kid, component: "station", value: sv } }, ts: ts + 2 },
        { world: wid, kind: "change", actor: "olive", cause: n + 2, verb: "set", body: { id: kid, comp: "station", value: sv }, ts: ts + 2 }].map((e) => JSON.stringify(e)).join("\n") + "\n");
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); D.liftWorld(w1); const w2 = s.reopen(); const E = w2.state().entities;
      const k = w2.entries.length; D.liftWorld(w2); const again = s.reopen().entries.length - k;
      const act = w2.entries.findLast((e: any) => e.kind === "act" && e.verb === "rename-components");
      return { g: E.cup?.c.grabbable ?? null, st: E[kid]?.c.station ?? null, again, renamed: act?.body?.renamed ?? null, status: w2.state().status }; },
    good: (o) => o.status === "ok" && o.g?.anim === "pistol" && !("pose" in o.g) && o.g?.grips?.h?.grasp === "point" && !("fingers" in o.g.grips.h) && o.st?.anim === "lie" && !("pose" in o.st) && o.again === 0 && Array.isArray(o.renamed) && o.renamed.some((r: any) => r.component === "station") },
  { id: "A5", what: "…the legacy sockets map's body block keeps pose: the lift makes it station.anim, and the map's readers get body.pose back (slotOf)", async run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      const r = s.call("olive", "set", { id: "bench", component: "sockets", value: { bunk: { pos: [0, 0.5, 0], body: { action: "lie", pose: "lie" } } } });
      const E = s.w().state().entities; const kid = Object.keys(E).find((k) => E[k].c.socket?.name === "bunk");
      const SK = await import(TREE + "shared/sockbody.js"); const slot = kid ? SK.slotOf(E[kid].c.socket, E[kid].c.transform, E[kid].c.station) : null;
      return { r: show(r), st: kid ? E[kid].c.station : null, body: slot?.body ?? null, b: SK.bodyOf?.(kid ? E[kid].c.station : null)?.clip ?? null }; },
    good: (o) => o.r === "ok" && o.st?.anim === "lie" && !("pose" in o.st) && o.body?.pose === "lie" && !("anim" in o.body) && o.b === "lie" },
  { id: "A6", what: "(R 15:09) folded wings are the named pose wings-folded on the wire (poses: [names]; [] holds none); an older sample's wingsFolded still reads; the server's fence keeps a clean poses list", async run() {
      const WP = await import(TREE + "shared/wingpresence.js"); const PC = await import(TREE + "server/posecheck.ts");
      const keep = PC.sanePose({ p: [0, 0, 0], poses: ["wings-folded"] }), bad = PC.sanePose({ p: [0, 0, 0], poses: [1, 2] });
      return { on: JSON.stringify(WP.wingFoldPresence(true)), off: JSON.stringify(WP.wingFoldPresence(false)), old: [WP.foldedIn?.({ wingsFolded: true }), WP.foldedIn?.({ wingsFolded: false }), WP.foldedIn?.({})],
        keep: JSON.stringify(keep?.poses ?? null), bad: bad ? "poses" in bad : "dropped" }; },
    good: (o) => o.on === '{"poses":["wings-folded"]}' && o.off === '{"poses":[]}' && JSON.stringify(o.old) === "[true,false,null]" && o.keep === '["wings-folded"]' && o.bad === false },
  { id: "A7", what: "…the agent's pose takes a name (wings-folded) or bones; animate takes a name or tracks, looped: true to loop (loop its old spelling); neither requires the inline keys", run() {
      const t = readText("mcpl/tools.ts"); const at = (n: string) => { const i = t.indexOf(`name: "${n}", description: "`); return i < 0 ? "" : t.slice(i, t.indexOf("\n", i)); };
      const p = at("pose"), a = at("animate");
      return { pname: /properties: \{ name: \{ type: "string"/.test(p), aname: /properties: \{ name: \{ type: "string"/.test(a), looped: /looped: \{ type: "boolean"/.test(a), req: /required: \["dur", "tracks"\]/.test(a), handler: /if \(n === WINGS_FOLDED\) return text\(await ag\.foldWings\(true\)\)/.test(t) }; },
    good: (o) => o.pname && o.aname && o.looped && !o.req && o.handler },
  // ---------------- U: the action bar ----------------
  { id: "U1", what: "(R 15:18, the UI half) the emote bar is the action bar: its frame id, the lite client's ids and classes, its titles and strings say action", run() {
      const wn = readText("client/lib/windows.js"), eb = readText("client/lib/emotebar.js"), el = readText("client/lib/emotebar_lite.js"), ix = readText("client/index.html"), ui = readText("client/lib/ui.js"), lt = readText("client/lite.js");
      return { layout: /^  actions:  \{ x: 'center'/m.test(wn) && !/^  emotes:/m.test(wn), frame: /makeFrame\('actions'/.test(eb) && /title: 'action bar'/.test(eb), lite: /lite-actions/.test(el) && !/lite-emote/.test(el + ix + lt),
        title: /actions: 'action bar'/.test(ui) && !/'emote bar'/.test(ui), strings: !/chat, emotes/.test(lt + ui) }; },
    good: (o) => o.layout && o.frame && o.lite && o.title && o.strings },
  // ---------------- X: the record ----------------
  { id: "X1", what: "the version history records the renames at minor 0, and the spec body speaks the new words (§5 consent, §7a rule 4)", run() {
      const md = readText("spec/PROTOCOL.md"); const vh = md.slice(md.indexOf("## Version history")); const body = md.slice(0, md.indexOf("## Version history"));
      return { vh: ["`hold-limit`", "`contact`", "`trusted-components`", "`rename-components`", "`displace`", "`delegates`", "`grabbable.anim`", "`grasp`", "`anim-pose`", "`wings-folded`"].every((w) => vh.includes(w)),
        body: /`allow`, `ask`, or `deny`/.test(body) && /\(`everyone` \/ `friends`\), `allow` \| `ask` \| `deny`/.test(body) && !/everyone, ask, or nobody/.test(body) && !/\(strangers \/ friends\)/.test(body) }; },
    good: (o) => o.vh && o.body },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (!want(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[names-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
