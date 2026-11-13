// tools/protocol/r11-check.ts — review round 11 (REVIEW-stern-r11, REVIEW-claims-r11 repo items, 2026-10-17): the
// fixes, each row red first (against 00a5e276) and most held by a mutation below (C5 has none).
//   bun tools/protocol/r11-check.ts                 every row
//   bun tools/protocol/r11-check.ts --only C4,X1    just those
//   bun tools/protocol/r11-check.ts --tree <dir>    against another checkout's shared/ + mcpl/ + client/ (a mutant)
//   bun tools/protocol/r11-check.ts --mutants       remove each fix in turn (a copy of the tree): its rows must go red;
//                                                  a no-op control mutation must stay green
// Rows:
//   C   consent after recut A2: a stored table narrows to two gates (C4); the verb's doc names them and a retired argument
//       (friend, delegate…) is refused with a pointer (C5). C1/C2/C3/C6 retired with the tier they tested
//   B   the agent's body (stern L1, L2): declaring stand on a seat says to detach (it never moves you off); a declaration
//       is passed on as sent, never read as a kind
//   R   renames (stern L3): a stored null old field is a removal; renames are admitted per thing
//   D   repo items (claims R1, R3, R4) and the docs pass: the consent code's words, move's name order, attach's dead pose
//       arg and /seatpose gone, replies and help in today's words; a removed
//       command (/ghost, /unghost) answers why
//   (stern L4, the interrupted in-place swap, is inplace-check IP13: it needs a v1 world and the CLI)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree, linkInto, readLF } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "./clock.ts";
import { LAB_CATALOGUE, MODELS as LAB_MODELS } from "./labmodels.js";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  // C1–C3, C6's mutants RETIRED with their rows (recut A2; #260 390); C4 is held by this one
  ["a stored pause doesn't close the gates", "shared/protocol/consent.js", "if (sw === \"refuse\" || sw === \"ask\") { t.move = false; t.touch = false; }", "if (sw === \"refuse\" || sw === \"ask\") { t.move = true; t.touch = true; }", ["C4"]],
  ["a seated declaration says nothing", "mcpl/tools.ts", "and grants nothing${seated}`); }", "and grants nothing`); }", ["B1"]],
  ["a declaration dropped", "mcpl/ping-wire.ts", "const d = typeof declares === \"string\" && declares ? { declares } : {};", "const d = {};", ["B2"]],
  ["the consent code's old words", "shared/protocol/refusalcodes.js", "(touch, pose, shove, displace…)", "(touch, pose, shove, move…)", ["D1"]],
  ["move's old name order", "AGENTS.md", "a thing by id (its entrance, else beside it), a place's name or label, a thing's label or handle,", "a thing (id, label or handle: its entrance, else beside it), a place's name or label,", ["D2"]],
  ["attach takes pose again", "mcpl/tools.ts", ", action: { type: \"string\" } }, required: [\"to\"] } },", ", action: { type: \"string\" }, pose: { type: \"string\" } }, required: [\"to\"] } },", ["D3"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/r11-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/, mcpl/ (without node_modules) and client/lib/ + client/lib/commands/ copied; the rest linked back
function mutantTree(tag: string) { const d = scratch(tag);
  fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true });
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { linkInto(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* no node_modules: the import says so */ }
  fs.mkdirSync(path.join(d, "client"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") linkInto(path.join(ENGINE, "client", k), path.join(d, "client", k));
  fs.cpSync(path.join(ENGINE, "client", "lib"), path.join(d, "client", "lib"), { recursive: true });
  for (const k of ["spec", "docs", "AGENTS.md"]) copyTree(path.join(ENGINE, k), path.join(d, k));
  for (const k of fs.readdirSync(ENGINE)) if (!["shared", "mcpl", "client", ".git"].includes(k) && !fs.existsSync(path.join(d, k))) try { linkInto(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = mutantTree("r11mut"); const f = path.join(d, file); const src = readLF(f);
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
const SR = await import(ENGINE + "tools/protocol/import-v1/shapes.js");
const VS = await import(TREE + "shared/protocol/verbspec.js");
const RC = await import(TREE + "shared/protocol/refusalcodes.js");
if (D.setScriptDuty) D.setScriptDuty({ maxMs: 1e9 });
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("r11");

function openWorld(name: string, presence: any = { bodies: {}, holds: {} }) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ catalogue: LAB_CATALOGUE, simModels: LAB_MODELS, name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line),
    presence, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  w.catalogue = LAB_CATALOGUE;
  return w;
}
const clock = labClock(); let N = 0;
function session() {
  const name = `r${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}) => { clock.advance(1000);
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
  { id: "C4", what: "(recut A2; R 10-28) a stored table becomes gates only ever NARROWER: Normal's closed cells → both off; an all-open table → move on, touch its default; pause → both off; friends and delegates are dropped; a per-person no is a block", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.reopen({ bodies: {}, holds: {}, consent: {
        alice: { cells: { strangers: { touch: "everyone" } }, friends: ["carol"] },
        dora: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } }, over: { bob: { touch: { mode: "deny" } } } },
        eve: { preset: "open", cells: { everyone: { pose: "allow", shove: "allow", displace: "allow", touch: "allow", intimate: "allow" } }, paused: true } } });   // only the pause closes eve
      C.migratePresence(s.w().presence); C.migratePresence(s.w().presence);   // idempotent
      const P = s.w().presence.consent;
      const g = (k: string) => `${P[k].move}/${P[k].touch}`;
      return { a: g("alice"), d: g("dora"), e: g("eve"), gone: ["alice", "dora", "eve"].every((k) => ["friends", "delegates", "cells", "preset", "paused", "switch", "over"].every((x) => !(x in P[k]))),
        kept: C.tableOf(s.w().presence, "dora").block }; },
    good: (o) => o.a === "false/false" && o.d === "true/undefined" && o.e === "false/false" && o.gone && JSON.stringify(o.kept) === '["bob"]' },
  { id: "C5", what: "(R 10-28) said where it's read: the consent verb's doc names the gates and lists and offers no delegate, switch or ask; a retired argument is refused with a pointer", run(s) {
      s.call("olive", "create-world", { title: s.name });
      const doc = VS.VERBSPEC?.consent?.doc ?? ""; const r = s.call("alice", "consent", { delegate: "mallory" }); const r2 = s.call("alice", "consent", { switch: "ask" });
      return { doc: /move and touch/.test(doc) && /allow, block and unlist/.test(doc) && !/delegate|switch|asks? /.test(doc), r: show(r), r2: show(r2) }; },
    good: (o) => o.doc && [o.r, o.r2].every((x) => /^refused shape/.test(x) && /two gates/.test(x)) },
  // ---------------- X: the spec says it ----------------
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
  { id: "D4", what: "(docs pass) replies and help in today's words: travel names anims and body-mode (not held pose and posture); ragdoll and live-pose replies name anim; /pushable says everyone (not a stranger); no sockets.<slot>|pose", run() {
      const net = readText("mcpl/net-server.ts"), tl = readText("mcpl/tools.ts"), reg = readText("client/lib/commands/registry.js"), ag = readText("AGENTS.md");
      return { net: !/held pose and posture/.test(net), tl: !/a posture, or walking, stands you back up/.test(tl) && !/`pose \{ragdoll\} refused/.test(tl) && !/pose \{clear: true\} drops it/.test(tl) && !/sockets\.<slot>\|pose/.test(tl),
        reg: !/stranger/.test(reg.split("\n").find((l) => l.includes("'pushable'")) ?? ""), ag: !/sockets\.<slot>\|pose/.test(ag) }; },
    good: (o) => o.net && o.tl && o.reg && o.ag },
  { id: "D5", what: "a removed command answers why, as /w does: /ghost and /unghost resolve to an unlisted row that says ghost was removed, and chat answers it locally (not 'unknown command')", async run() {
      const reg = await import(TREE + "client/lib/commands/registry.js"); const chat = readText("client/lib/chat.js");
      const rows = ["ghost", "unghost"].map((c) => reg.resolveCommand?.(c) ?? null);
      return { rows: rows.map((r) => r && { name: r.name, listed: r.listed, help: r.help }), local: /\n  ghost\(\) \{ logChat\('\*', 'ghost was removed/.test(chat) }; },
    good: (o) => o.rows.every((r: any) => r && r.name === "ghost" && r.listed === false && /ghost was removed/.test(r.help)) && o.local },
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
