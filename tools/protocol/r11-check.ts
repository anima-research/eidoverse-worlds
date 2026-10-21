// tools/protocol/r11-check.ts — review round 11 (REVIEW-stern-r11, REVIEW-claims-r11 repo items, 2026-10-17): the
// fixes, each row red first (against 00a5e276) and held by a mutation below.
//   bun tools/protocol/r11-check.ts                 every row
//   bun tools/protocol/r11-check.ts --only C1,X1    just those
//   bun tools/protocol/r11-check.ts --tree <dir>    against another checkout's shared/ + mcpl/ + client/ (a mutant)
//   bun tools/protocol/r11-check.ts --mutants       remove each fix in turn (a copy of the tree): its rows must go red;
//                                                  a no-op control mutation must stay green
// Rows:
//   C   a friend and a delegate can be removed (stern M1): consent {unfriend} / {undelegate}, by the owner only; an unfriend
//       breaks the mutual tier at once (a touch it allowed ends); a migrated delegate (a pre-10-17 friend) is removable
//   X   the spec says it (stern M2): §7's table lists rename-components; §4 says a rename runs at every load, unmarked
//   B   the agent's body (stern L1, L2): declaring stand on a seat says to detach (it never moves you off); a declaration
//       is passed on as sent, never read as a kind
//   R   renames (stern L3): a stored null old field is a removal; renames are admitted per thing
//   D   repo items (claims R1, R3, R4) and the docs pass: the consent code's words, move's name order, attach's dead pose
//       arg and /seatpose gone, replies and help in today's words, the inspector's sockets.<slot>|anim
//   (stern L4, the interrupted in-place swap, is inplace-check IP13: it needs a v1 world and the CLI)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["undelegate removes nobody", "shared/protocol/consent.js", "if (a.undelegate !== undefined) t.delegates = (t.delegates ?? []).filter((x) => x !== a.undelegate);", "", ["C1", "C4"]],
  ["unfriend removes nobody", "shared/protocol/consent.js", "if (a.unfriend !== undefined) t.friends = (t.friends ?? []).filter((x) => x !== a.unfriend);", "", ["C2", "C4"]],
  ["a delegate may remove", "shared/protocol/consent.js", "if (!self && lists) return", "if (false && lists) return", ["C3"]],
  ["an unfriend re-checks only the unfriender", "shared/protocol/authority/bodyconsent.js", ", ...(ex ? revokeAfter(w, ex, beforeEx) : [])]", "]", ["C6"]],
  ["the door doesn't take the words", "shared/protocol/verbspec.js", "unfriend: { type: \"any\"", "unfriendX: { type: \"any\"", ["C2", "C3"]],
  ["the verb reads a removal as a read", "shared/protocol/authority/bodyconsent.js", "\"delegate\", \"unfriend\", \"undelegate\"].some", "\"delegate\"].some", ["C1", "C2"]],
  ["§7 forgets rename-components", "spec/PROTOCOL.md", "\n| components and fields renamed before release (§4), by the explicit `repair` command (never at load) | its own act `rename-components {renamed, why, failed?}` and its change | `system` | the system's capability, per thing | the actor |", "", ["X1"]],
  ["§4 forgets the rename", "spec/PROTOCOL.md", "**A pure rename is the command's second step, idempotent.**", "**A pure rename runs.**", ["X1"]],
  ["a seated declaration says nothing", "mcpl/tools.ts", "and grants nothing${seated}`); }", "and grants nothing`); }", ["B1"]],
  ["a declaration dropped", "mcpl/ping-wire.ts", "const d = typeof declares === \"string\" && declares ? { declares } : {};", "const d = {};", ["B2"]],
  ["a stored null renamed to anim: null", "shared/protocol/shaperepair.js", "else if (p === null) renamed.push({ field: \"pose\", to: null });", "", ["R1"]],
  ["renames all or nothing", "shared/protocol/authority/scriptrun.js", "if (kept.length && !dryRun) { const ids = [...new Set(kept.map((o) => o.id))], comps", "if (kept.length && !dryRun && !rename.failed.length) { const ids = [...new Set(kept.map((o) => o.id))], comps", ["R2"]],
  ["the consent code's old words", "shared/protocol/refusalcodes.js", "(touch, pose, shove, displace…)", "(touch, pose, shove, move…)", ["D1"]],
  ["move's old name order", "AGENTS.md", "a thing by id (its entrance, else beside it), a place's name or label, a thing's label or handle,", "a thing (id, label or handle: its entrance, else beside it), a place's name or label,", ["D2"]],
  ["attach takes pose again", "mcpl/tools.ts", ", action: { type: \"string\" } }, required: [\"to\"] } },", ", action: { type: \"string\" }, pose: { type: \"string\" } }, required: [\"to\"] } },", ["D3"]],
  ["the inspector says |pose", "shared/editschema.js", "k: `${slot}|anim`, label: `${slot} anim`, value: b.pose, def", "k: `${slot}|pose`, label: `${slot} anim`, value: b.pose, def", ["D4"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/r11-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/, mcpl/ (without node_modules) and client/lib/ + client/lib/commands/ copied; the rest linked back
function copyTree(tag: string) { const d = scratch(tag);
  fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true });
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* no node_modules: the import says so */ }
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") fs.symlinkSync(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  for (const k of ["spec", "docs", "AGENTS.md"]) copyTree(path.join(ENGINE, k), path.join(d, k));
  for (const k of fs.readdirSync(ENGINE)) if (!["shared", "mcpl", "client", ".git"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("r11mut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[r11-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const C = await import(TREE + "shared/protocol/consent.js");
const SR = await import(TREE + "shared/protocol/shaperepair.js");
const VS = await import(TREE + "shared/protocol/verbspec.js");
const RC = await import(TREE + "shared/protocol/refusalcodes.js");
if (D.setScriptDuty) D.setScriptDuty({ maxMs: 1e9 });
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("r11");

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
  const name = `r${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}) => { T += 1000; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  const reopen = (presence?: any) => { const p = presence ?? w?.presence; w = openWorld(name, p ?? { bodies: {}, holds: {} }); return w; };
  const append = (lines: any[]) => fs.appendFileSync(path.join(root, "worlds", `${name}.jsonl`), lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { name, call, w: W, reopen, append, entries: () => W().entries };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const readText = (rel: string) => { try { return fs.readFileSync(TREE + rel, "utf8"); } catch { return fs.readFileSync(ENGINE + rel, "utf8"); } };
const section = (md: string, head: RegExp) => { const i = md.search(head); if (i < 0) return ""; const rest = md.slice(i + 1); const j = rest.search(/\n## /); return md.slice(i, j < 0 ? undefined : i + 1 + j); };
const PROTO = () => readText("spec/PROTOCOL.md");
const tableOf = (s: any, who: string) => C.tableOf(s.w().presence, who);

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- C: consent after recut A2 ----------------
  // C1, C2, C3, C6 RETIRED (recut A2, 10-20): they tested delegates and the friends tier, which are gone (house K5).
  { id: "C4", what: "(recut A2) a stored table becomes a switch only ever NARROWER: Normal's closed cells → refuse; an all-open table → accept; pause → refuse; friends and delegates are dropped; per-person answers stay", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.reopen({ bodies: {}, holds: {}, consent: {
        alice: { cells: { strangers: { touch: "everyone" } }, friends: ["carol"] },
        dora: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } }, over: { bob: { touch: { mode: "deny" } } } },
        eve: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } }, paused: true } } });   // only the pause closes eve
      C.migratePresence(s.w().presence); C.migratePresence(s.w().presence);   // idempotent
      const P = s.w().presence.consent;
      return { a: P.alice.switch, d: P.dora.switch, e: P.eve.switch, gone: ["alice", "dora", "eve"].every((k) => !("friends" in P[k]) && !("delegates" in P[k]) && !("cells" in P[k]) && !("preset" in P[k]) && !("paused" in P[k])),
        kept: P.dora.over?.bob?.touch?.mode }; },
    good: (o) => o.a === "refuse" && o.d === "accept" && o.e === "refuse" && o.gone && o.kept === "deny" },
  { id: "C5", what: "(recut A2) said where it's read: the consent verb's doc names the switch and offers no delegate; a retired argument is refused with a pointer", run(s) {
      s.call("olive", "create-world", { title: s.name });
      const doc = VS.VERBSPEC?.consent?.doc ?? ""; const r = s.call("alice", "consent", { delegate: "mallory" });
      return { doc: /switch/.test(doc) && !/delegate/.test(doc), r: show(r) }; },
    good: (o) => o.doc && /^refused shape/.test(o.r) && /switch/.test(o.r) },
  // ---------------- X: the spec says it ----------------
  { id: "X1", what: "(stern M2) §7's table of the authority's consequences lists rename-components ({renamed, why}: the system's act and change); §4 says a pure rename is not marker-gated: the explicit repair command renames what it finds (a load never writes) and writes nothing when there's nothing", run() {
      const md = PROTO(); const s7 = section(md, /\n## 7\. /); const s4 = section(md, /\n## 4\. /);
      return { s7: /\| [^\n]*explicit `repair` command \(never at load\)[^\n]*`rename-components \{renamed, why, failed\?\}`[^\n]*\| `system` \|/.test(s7),
        s4: /\*\*A pure rename is the command's second step, idempotent\.\*\*/.test(s4) && !/at every load/.test(s7) && /`RENAMED_COMPONENTS`/.test(s4) && /`RENAMED_FIELDS`/.test(s4) && /not marker-gated/.test(s4) && /writes nothing\s+when there is nothing to rename/.test(s4) && /admitted per thing/.test(s4) }; },
    good: (o) => o.s7 && o.s4 },
  // ---------------- B: the agent's body ----------------
  { id: "B1", what: "(stern L1) on a seat, anim {bodyMode: stand} never takes you off it (body-mode grants nothing): the reply says you're still attached and to detach; the tool's text says the same", async run() {
      const TL = await import(TREE + "mcpl/tools.ts"); let detached = false, mode: any = null;
      const ag: any = { myOccupancy: { to: "seat1" }, socketName: () => "the bench", anims: [], clip: "sitchair", target: null,
        set bodyMode(m: any) { mode = m; }, get bodyMode() { return mode ?? "stand"; }, bodyModeNow: () => "sit", restClip: () => "sitchair", setOccupant: () => { detached = true; } };
      const r = await TL.HANDLERS.anim(ag, { bodyMode: "stand" }, {}); const txt = r?.content?.[0]?.text ?? "";
      const desc = TL.TOOLS.find((t: any) => t.name === "anim")?.description ?? "";
      return { txt: txt.slice(0, 400), detached, desc: /on a seat, detach/.test(desc) && !/to stand up, declare bodyMode stand, or walk\)/.test(desc) }; },
    good: (o) => /still (attached|on) /.test(o.txt) && /detach/.test(o.txt) && !o.detached && o.desc },
  { id: "B2", what: "(stern L2, §6a rule 3) the agent reads no kind from another's declaration: a ping or a say from someone who declares `ai` carries `declares: \"ai\"` as sent, nobody gets chat:from-agent, and agent.ts compares no declaration to a word", async run() {
      const PW = await import(TREE + "mcpl/ping-wire.ts"); const P = (kind: string) => ({ ts: 1, kind, who: "digi", text: "touches your head_top (left hand)" });
      const a = PW.pingDelivery(P("touch"), "ai"), b = PW.pingDelivery(P("touch"), null);
      const src = readText("mcpl/agent.ts"), net = readText("mcpl/net-server.ts");
      return { a: JSON.stringify(a), b: JSON.stringify(b), cmp: /declares === "agent"/.test(src), isAgent: /isAgent\(/.test(src + net), declOf: /declaresOf\(/.test(net) }; },
    good: (o) => /"declares":"ai"/.test(o.a) && !/from-agent/.test(o.a) && !/declares/.test(o.b) && !/from-agent/.test(o.b) && !o.cmp && !o.isAgent && o.declOf },
  // ---------------- R: renames ----------------
  { id: "R1", what: "(stern L3, p2) renameFields: a stored grabbable.pose (or a station's) null is a removal (no anim: null the schema refuses); a grip's fingers null likewise (no grasp: null)", run() {
      const g = SR.renameFields("grabbable", { pose: null, grips: { h: { pos: [0, 0, 0], fingers: null } } }), st = SR.renameFields("station", { action: "sit", pose: null });
      return { g: JSON.stringify(g.value), gr: g.renamed.length, st: JSON.stringify(st.value), sr: st.renamed.length }; },
    good: (o) => o.g === '{"grips":{"h":{"pos":[0,0,0]}}}' && o.gr === 2 && o.st === '{"action":"sit"}' && o.sr === 1 },
  { id: "R2", what: "(stern L3) renames are admitted per thing: a log holding one station whose old pose the door refuses as anim (\"live\", reserved) and one cup whose grabbable.pose is fine: the cup is renamed at load, the station is named in the act's failed and left as it was", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "create", { id: "cup", model: "book", place: { at: [0, 0] } });
      s.call("olive", "create", { id: "bench", model: "crate", place: { at: [4, 0] } });
      s.call("olive", "create", { components: { parent: { to: "bench" }, transform: { pos: [0, 0.5, 0] }, socket: { name: "bunk" }, station: { action: "lie" } } });
      const L = s.entries(); const wid = L[1]?.world ?? L[0]?.world; const ts = L.at(-1).ts; const n = L.length;
      const E0 = s.w().state().entities; const kid = Object.keys(E0).find((k) => E0[k].c.socket?.name === "bunk");
      const gv = { who: "visitor", pose: "pistol" }, sv = { action: "lie", pose: "live" };
      s.append([{ world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: "cup", component: "grabbable", value: gv } }, ts: ts + 1 },
        { world: wid, kind: "change", actor: "olive", cause: n, verb: "set", body: { id: "cup", comp: "grabbable", value: gv }, ts: ts + 1 },
        { world: wid, kind: "act", actor: "olive", verb: "set", body: { request: { id: kid, component: "station", value: sv } }, ts: ts + 2 },
        { world: wid, kind: "change", actor: "olive", cause: n + 2, verb: "set", body: { id: kid, comp: "station", value: sv }, ts: ts + 2 }]);
      T += 1000; process.env.PROTOCOL_NOW = String(T);
      const w1 = s.reopen(); const out = D.maintain(w1); const w2 = s.reopen(); const E = w2.state().entities;
      const act = w2.entries.findLast((e: any) => e.kind === "act" && e.verb === "rename-components");
      return { g: E.cup?.c.grabbable ?? null, st: E[kid]?.c.station ?? null, failed: act?.body?.failed ?? null, renamed: act?.body?.renamed ?? null, out: JSON.stringify(out).slice(0, 300), status: w2.state().status, kid }; },
    good: (o) => o.status === "ok" && o.g?.anim === "pistol" && !("pose" in o.g) && o.st?.pose === "live" && Array.isArray(o.failed) && o.failed.some((f: any) => f.id === o.kid) && o.renamed?.some((r: any) => r.id === "cup") },
  // ---------------- D: repo items and the docs pass ----------------
  { id: "D1", what: "(claims R1) the consent refusal code's words: a body act (touch, pose, shove, displace…) their table refuses; no `move` class, no edit that would move them (an edit vacates since round 8)", run() {
      const w = RC.REFUSAL_CODES?.consent?.when ?? ""; return { w }; },
    good: (o) => /displace/.test(o.w) && !/\bmove\b/.test(o.w) && !/an edit that would/.test(o.w) },
  { id: "D2", what: "(claims R3) AGENTS.md's move row tries names in the order tools.ts does: a thing by id, a place's name or label, a thing's label or handle, then a person", run() {
      const ag = readText("AGENTS.md"); const row = ag.split("\n").find((l) => l.startsWith("| `move {to")) ?? ""; return { ok: /a thing by id[^|]*, a place's name or label, a thing's label or handle[^|]*, then a person/.test(row) }; },
    good: (o) => o.ok },
  { id: "D3", what: "(claims R4) attach has no `pose` arg (a station's poses menu is reserved: the arg could only be refused); the browser's /seatpose, the same dead menu, is gone with chooseSeatPose", run() {
      const tl = readText("mcpl/tools.ts"); const row = tl.split("\n").find((l) => l.includes('{ name: "attach"')) ?? ""; const reg = readText("client/lib/commands/registry.js"), h = readText("client/lib/commands/handlers.js"), lb = readText("client/lib/localbody.js");
      return { schema: /pose: \{ type/.test(row), handler: /a\.pose != null && body\.poses/.test(tl), seatpose: /seatpose/.test(reg + h), choose: /chooseSeatPose/.test(h + lb) }; },
    good: (o) => !o.schema && !o.handler && !o.seatpose && !o.choose },
  { id: "D4", what: "(docs pass) replies and help in today's words: travel names anims and body-mode (not held pose and posture); ragdoll and live-pose replies name anim; /pushable says everyone (not a stranger); the inspector's sockets.<slot>|anim (|pose still read)", run() {
      const net = readText("mcpl/net-server.ts"), tl = readText("mcpl/tools.ts"), reg = readText("client/lib/commands/registry.js"), es = readText("shared/editschema.js"), ag = readText("AGENTS.md");
      return { net: !/held pose and posture/.test(net), tl: !/a posture, or walking, stands you back up/.test(tl) && !/`pose \{ragdoll\} refused/.test(tl) && !/pose \{clear: true\} drops it/.test(tl) && !/sockets\.<slot>\|pose/.test(tl),
        reg: !/stranger/.test(reg.split("\n").find((l) => l.includes("'pushable'")) ?? ""), es: (es.match(/k: `\$\{slot\}\|anim`/g) ?? []).length === 2 && !/k: `\$\{slot\}\|pose`/.test(es) && /what0 === 'anim' \? 'pose'/.test(es), ag: /sockets\.<slot>\|anim/.test(ag) }; },
    good: (o) => o.net && o.tl && o.reg && o.es && o.ag },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[r11-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
