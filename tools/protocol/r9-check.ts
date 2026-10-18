// tools/protocol/r9-check.ts — review round 9 (REVIEW-holes-r9, REVIEW-scars-r9, REVIEW-claims-r9 O1–O3, 2026-10-17): the
// fixes, each row red first (against bf9bd080) and held by a mutation below.
//   bun tools/protocol/r9-check.ts                 every row
//   bun tools/protocol/r9-check.ts --only H1,M1    just those
//   bun tools/protocol/r9-check.ts --tree <dir>    against another checkout's shared/ + mcpl/ (a mutant)
//   bun tools/protocol/r9-check.ts --mutants       remove each fix in turn (a copy of shared/ and mcpl/): its rows must go
//                                                 red; a no-op control mutation must stay green
// Rows:
//   H   authorship never comes from a follow-up: a reference clear (or its undo) is named in its change entry
//       (`followUps`), and who set up a handler skips it, live and read back from disk; only a recorded follow-up is
//       restored as one by undo (holes L2); the fold takes `followUps` only well formed
//   M   the occupant exemption is the seat's assembly as it was when the occupant sat (a handler added since unseats them)
//   E   a station's leaveBy "script" keeps the occupant's escape (sockbody, the agent's detach {escape})
//   A   the auditor re-runs an arrival with two stand-ins: agreeing re-runs are compared with the log (a forgery is flagged)
//   U   an agent hears `vacated` (its seat cleared, standing where the authority let it go); only for the seat it is on
//   T   leaving a seat restarts the authority's track of the body at the seat (no too-fast after being carried)
//   L   lows: a prototype key as a verb, the founding marker is the first create-world, an unlogged grab records no
//       identity, the translator's name is @13
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["follow-ups not recorded in the entry", "shared/protocol/authority/writes.js", "body: { ops, ...(fu.length ? { followUps: [...fu] } : {}) }", "body: { ops }", ["H1", "H2", "H3", "H4"]],
  ["lastTouch {authored} reads follow-ups as authors", "shared/protocol/authority/followups.js", "if (fu?.has(k)) { if (o.verb === \"set\") { restored = true; continue; } if (o.verb === \"delete\" && restored) { restored = false; continue; } return null; }", "", ["H1", "H2", "H3"]],
  ["undo marks any ref restore as a follow-up", "shared/protocol/authority/undo.js", "if (!goneHere.size || !fuHere.has(o) ||", "if (!goneHere.size ||", ["H5"]],
  ["the fold takes any followUps", "shared/protocol/fold.js", "if (\"followUps\" in body) followUpsCheck(body.followUps, body.ops.length);", "", ["H6"]],
  ["the exemption ignores when the occupant sat", "shared/protocol/authority/occupants.js", "if (own && rootOf(s.to) === own && unchangedSinceSat(s.since)) continue;", "if (own && rootOf(s.to) === own) continue;", ["M1", "M2"]],
  ["no escape from a script seat", "shared/sockbody.js", "if (kind === 'script' || kind === 'escape') return true;", "if (kind === 'script') return true;", ["E1", "E2"]],
  ["the auditor skips every arrival mismatch", "shared/protocol/scriptaudit.js", "if (!agree) { skipped.push(", "if (true) { skipped.push(", ["A1"]],
  ["the agent ignores unseated", "mcpl/agent.ts", "if (vacatedFromMine(m, this.myOccupancy)) {", "if (false) {", ["U1"]],
  ["unseated from any seat", "shared/sockbody.js", "u.socket === mount.to);", "true);", ["U2"]],
  ["no re-anchor on a step off a seat", "shared/protocol/authority/bodyverbs.js", "if (sat && vacateAt(w, st, actor, sat.to)) me = w.presence.bodies[actor];", "", ["T1"]],
  ["no re-anchor on an unseat", "shared/protocol/authority/occupants.js", "w.presence.bodies[who] = { ...b, at, ts: w.pace ? w.pace() : w.now(), tokens: TRACK.cap }; w.presenceDirty = true;", "", ["T1", "T2"]],
  ["a verb read through the prototype", "shared/protocol/authority.js", "const h = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;", "const h = VERBS[verb];", ["L1"]],
  ["every create-world counts as the founding", "shared/protocol/shaperepair.js", "if (e.verb === \"create-world\" && !founded) {", "if (e.verb === \"create-world\") {", ["L2"]],
  ["an unlogged grab records who", "shared/protocol/authority/scriptrun.js", "const anon = ANON_EVENTS.has(ev.on) || (GRIP_EVENTS.has(ev.on) && ev.seq === undefined);", "const anon = ANON_EVENTS.has(ev.on);", ["L3"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/r9-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/ copied, mcpl/ copied without its node_modules (linked back to the real one)
function copyTree(tag: string) { const d = scratch(tag);
  fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true });
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* no node_modules: the import says so */ }
  // everything else the copied files import from the checkout (server/, client/, node_modules…) is the checkout's own
  for (const k of fs.readdirSync(ENGINE)) if (!["shared", "mcpl", ".git"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("r9mut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[r9-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);   // the fixtures below seed the ids they read (ids-check covers the refusal)
const F = await import(TREE + "shared/protocol/fold.js");
const SB = await import(TREE + "shared/protocol/sandbox.js");
const AU = await import(TREE + "shared/protocol/scriptaudit.js");
const SR = await import(TREE + "shared/protocol/shaperepair.js");
const SK = await import(TREE + "shared/sockbody.js");
if (D.setScriptDuty) D.setScriptDuty({ maxMs: 1e9 });
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("r9");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const w = D.worldOf({ name, entries,
    getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: SB.SANDBOX,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
  w.catalogue = D.LAB_CATALOGUE;
  return w;
}
let T = 1800000000000, N = 0;
function session() {
  const name = `r${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const step = () => { T += 1000; process.env.PROTOCOL_NOW = String(T); };
  const call = (actor: string, verb: string, args: any = {}) => { step();
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  // a reload from disk: the log as stored (JSON: no symbol survives), with the presence carried over
  const reopen = () => { const p = w?.presence; w = openWorld(name); if (p) w.presence = p; return w; };
  return { name, call, step, w: W, reopen, entries: () => W().entries };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const comp = (s: any, id: string, c: string) => s.w().state().entities[id]?.c[c];
const roles = (s: any, m: Record<string, string>) => { for (const [who, role] of Object.entries(m)) s.call("olive", "set", { id: "@world", component: `roles:${who}`, value: { role } }); };
const lastUse = (s: any) => s.entries().findLast((e: any) => e.kind === "act" && e.verb === "use");
const SEAT = (extra: any = {}) => ({ sockets: { a: { pos: [0, 0.45, 0], body: { action: "sit", ...extra } } } });
const seated = (s: any, who: string) => !!s.w().presence.occupants?.[who];
const inboxOf = (s: any, who: string) => JSON.stringify(s.w().presence.inbox?.[who] ?? s.w().presence.inboxes?.[who] ?? null);

// the q6 world: builder bob's lever with a set and a reset handler on olive's things; bob demoted
function lever(s: any) {
  s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "visitor" });
  s.call("olive", "create", { id: "x", model: "crate", place: { at: [6, 0] } });
  s.call("olive", "create", { id: "statue", model: "crate", place: { at: [9, 0] }, components: { home: { pos: [20, 0, 0] } } });
  const c = s.call("bob", "create", { id: "lever", model: "crate", components: { reactions: {
    lit: { kind: "set", component: "t/lit", value: { on: true } }, go: { kind: "reset", targets: ["statue", "x"] } } }, place: { at: [0, 0] } });
  roles(s, { bob: "visitor" }); s.call("vic", "move", { to: [0, 0, -1] });
  return c;
}

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- H: authorship never comes from a follow-up ----------------
  { id: "H1", what: "(q6) bob's lever, bob demoted: olive deletes x, which a reset on it named; vic's `use go` is still refused as bob's, the statue stays, and no use act names olive as the author", run(s) {
      const c = lever(s);
      const d = s.call("olive", "delete", { id: "x" });
      const g = s.call("vic", "use", { id: "lever", action: "go" }), l = s.call("vic", "use", { id: "lever", action: "lit" });
      const uses = s.entries().filter((e: any) => e.kind === "act" && e.verb === "use");
      return { c: show(c), d: show(d), cleared: JSON.stringify(d.notes ?? []).includes("lever.reactions.go.targets"), g: show(g), l: show(l), statue: comp(s, "statue", "transform")?.pos,
        olive: uses.some((e: any) => e.body?.capability?.author === "olive") }; },
    good: (o) => o.c === "ok" && o.d === "ok" && o.cleared && /set up by bob/.test(o.g) && /set up by bob/.test(o.l) && JSON.stringify(o.statue) === "[9,0,0]" && !o.olive },
  { id: "H2", what: "…read back from disk (no symbol survives JSON): the delete's change entry names its follow-up (`followUps`), and after a reload vic's use is still bob's", run(s) {
      lever(s); const d = s.call("olive", "delete", { id: "x" });
      const ch = s.entries()[d.seq]; s.reopen();
      const g = s.call("vic", "use", { id: "lever", action: "go" });
      const ops = ch?.body?.ops ?? []; const fu = ch?.body?.followUps ?? [];
      return { d: show(d), verb: ch?.verb, fu, marked: fu.map((k: number) => `${ops[k]?.id}.${ops[k]?.comp}`), own: ops.filter((_: any, k: number) => !fu.includes(k)).map((o: any) => `${o.verb} ${o.id}`), g: show(g) }; },
    good: (o) => o.d === "ok" && o.verb === "batch" && JSON.stringify(o.marked) === '["lever.reactions"]' && o.own.includes("delete x") && /set up by bob/.test(o.g) },
  { id: "H3", what: "the other way: owner olive's door {open: toggle, sweep: reset [builder vic's ball, her statue]}; vic deletes his ball, then is demoted; the door's handlers stay olive's (a visitor still opens it), inspect says the clear was a follow-up", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "builder", wes: "visitor" });
      const b = s.call("vic", "create", { id: "ball", model: "crate", place: { at: [5, 0] } });
      s.call("olive", "create", { id: "statue", model: "crate", place: { at: [9, 0] } });
      const k = s.call("olive", "create", { id: "door", model: "crate", components: { openable: { open: false }, reactions: {
        open: { kind: "toggle", component: "openable", field: "open" }, sweep: { kind: "reset", targets: ["ball", "statue"] } } }, place: { at: [0, 0] } });
      const d = s.call("vic", "delete", { id: "ball" }); roles(s, { vic: "visitor" });
      s.call("wes", "move", { to: [0, 0, -1] }); const u = s.call("wes", "use", { id: "door", action: "open" });
      const t = s.call("olive", "inspect", { id: "door" })?.touched?.reactions;
      return { b: show(b), k: show(k), d: show(d), u: show(u), open: comp(s, "door", "openable")?.open, author: lastUse(s)?.body?.capability?.author, t }; },
    good: (o) => o.b === "ok" && o.k === "ok" && o.d === "ok" && o.u === "ok" && o.open === true && o.author === "olive" && o.t?.followUp === true && o.t?.by === "vic" },
  { id: "H4", what: "olive's undo of that delete puts x back in the reset (the undo's entry names the restore as its follow-up), and the lever is still bob's: vic's use refused", run(s) {
      lever(s); s.call("olive", "delete", { id: "x" });
      const u = s.call("olive", "undo", {}); const ch = s.entries()[u.seq];
      const g = s.call("vic", "use", { id: "lever", action: "go" });
      const ops = ch?.body?.ops ?? [];
      return { u: show(u), targets: comp(s, "lever", "reactions")?.go?.targets, marked: (ch?.body?.followUps ?? []).map((k: number) => `${ops[k]?.id}.${ops[k]?.comp}`), g: show(g) }; },
    good: (o) => o.u === "ok" && JSON.stringify(o.targets) === '["statue","x"]' && JSON.stringify(o.marked) === '["lever.reactions"]' && /set up by bob/.test(o.g) },
  { id: "H5", what: "(q4, holes L2) vic's batch [set rr.look-at {target: z}, delete x] (rr looked at x); the owner locks rr; vic's undo would put x's reference back through the lock: refused (his own write was never a follow-up)", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "builder" });
      s.call("vic", "create", { id: "x", model: "crate", place: { at: [0, 0] } }); s.call("vic", "create", { id: "z", model: "crate", place: { at: [8, 0] } });
      s.call("vic", "create", { id: "rr", model: "crate", components: { "look-at": { target: "x" } }, place: { at: [3, 0] } });
      const b = s.call("vic", "batch", { ops: [{ verb: "set", args: { id: "rr", component: "look-at", value: { target: "z" } } }, { verb: "delete", args: { id: "x" } }] });
      const lk = s.call("olive", "set", { id: "rr", component: "lock", value: { rank: "owner" } });
      const u = s.call("vic", "undo", {});
      return { b: show(b), lk: show(lk), u: show(u), target: comp(s, "rr", "look-at")?.target, x: !!s.w().state().entities.x }; },
    good: (o) => o.b === "ok" && o.lk === "ok" && /locked/.test(o.u) && o.target === "z" && !o.x },
  { id: "H6", what: "the fold takes `followUps` only well formed (non-empty, ascending, in range): anything else makes the entry malformed", run() {
      const ops = [{ verb: "delete", id: "x" }, { verb: "set", id: "y", comp: "label", value: "a" }, { verb: "set", id: "z", comp: "label", value: "b" }];
      const t = (f: any) => { try { F.opsOf({ kind: "change", verb: "batch", body: { ops, ...(f === undefined ? {} : { followUps: f }) } }); return "ok"; } catch (e) { return e?.code ?? String(e); } };
      return { none: t(undefined), good: t([1, 2]), empty: t([]), desc: t([2, 1]), dup: t([1, 1]), out: t([3]), neg: t([-1]), frac: t([1.5]), str: t("1"),
        set: [...F.followUpsOf({ kind: "change", verb: "batch", body: { ops, followUps: [1, 2] } })] }; },
    good: (o) => o.none === "ok" && o.good === "ok" && ["empty", "desc", "dup", "out", "neg", "frac", "str"].every((k) => o[k] === "batch-followups") && JSON.stringify(o.set) === "[1,2]" },
  // ---------------- M: the seat's own motion, as it was when you sat ----------------
  { id: "M1", what: "(q1) vic sits on olive's chair; builder bob adds a `fly` reaction to it, then uses it: it flies, and vic is unseated (told), not carried", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "visitor" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "chair", action: "sit" });
      const add = s.call("bob", "set", { id: "chair", component: "reactions", value: { fly: { kind: "set", component: "transform", value: { pos: [4, 40, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } });
      const after = seated(s, "vic");
      s.call("bob", "move", { to: [4, 0, -1.5] }); const go = s.call("bob", "use", { id: "chair", action: "fly" });
      return { sit: show(sit), add: show(add), after, go: show(go), pos: comp(s, "chair", "transform")?.pos, seated: seated(s, "vic"), note: JSON.stringify(go.notes ?? []).includes("vacated"), inbox: inboxOf(s, "vic").includes("vacated") }; },
    good: (o) => o.sit === "ok" && o.add === "ok" && o.after && o.go === "ok" && o.pos?.[1] === 40 && !o.seated && o.note && o.inbox },
  { id: "M2", what: "…the motion variant: a `spin` handler added after the sit, used: vic unseated; and a motion set up BEFORE the sit (the carousel) still carries", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "visitor", wes: "visitor" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); s.call("vic", "use", { id: "chair", action: "sit" });
      s.call("bob", "set", { id: "chair", component: "reactions", value: { spin: { kind: "set", component: "motion", value: { type: "spin", axis: [0, 1, 0], speed: 500 } } } });
      s.call("bob", "move", { to: [4, 0, -1.5] }); const go = s.call("bob", "use", { id: "chair", action: "spin" });
      const vic = seated(s, "vic");
      s.call("olive", "create", { id: "carousel", model: "chair", components: { ...SEAT(), reactions: { turn: { kind: "set", component: "motion", value: { type: "spin", axis: [0, 1, 0], speed: 30 } } } }, place: { at: [10, 0] } });
      s.call("wes", "move", { to: [10, 0, -0.6] }); const sit = s.call("wes", "use", { id: "carousel", action: "sit" });
      s.call("olive", "move", { to: [10, 0, -1.5] }); const turn = s.call("olive", "use", { id: "carousel", action: "turn" });
      return { go: show(go), vic, sit: show(sit), turn: show(turn), wes: seated(s, "wes") }; },
    good: (o) => o.go === "ok" && !o.vic && o.sit === "ok" && o.turn === "ok" && o.wes },
  // ---------------- E: the escape ----------------
  { id: "E1", what: "a station with leaveBy 'script': moving, jumping and one get-up don't let go, the escape does (and the componentspec help and look's words say so)", run() {
      const b = SK.bodyOf({ action: "sit", leaveBy: "script" });
      return { move: SK.mayLeave(b, "move"), jump: SK.mayLeave(b, "jump"), menu: SK.mayLeave(b, "menu"), escape: SK.mayLeave(b, "escape"), script: SK.mayLeave(b, "script"),
        any: SK.mayLeave(SK.bodyOf({ action: "sit" }), "escape"), hold: SK.ESCAPE_HOLD_S, words: SK.describeBody?.("a", b) ?? "" }; },
    good: (o) => !o.move && !o.jump && !o.menu && o.escape && o.script && o.any && o.hold > 0 && o.hold <= 2 && /hold X/.test(o.words) },
  { id: "E2", what: "an agent on a script seat: detach is refused and names the escape; detach {escape: true} gets it up", async run() {
      const TL = await import(TREE + "mcpl/tools.ts"); const body = SK.bodyOf({ action: "sit", leaveBy: "script" });
      let seat: any = { to: "s1" };
      const ag: any = { get myOccupancy() { return seat; }, mayVacate: (k: string) => SK.mayLeave(body, k), socketName: () => "the cage (a)", setOccupant: (x: any) => { seat = x; } };
      const det = TL.HANDLERS?.detach;
      if (!det) return { noHandler: Object.keys(TL) };
      const a = await det(ag, {}); const still = !!seat; const b = await det(ag, { escape: true });
      return { a: a?.content?.[0]?.text, aErr: !!a?.isError, still, b: b?.content?.[0]?.text, off: seat === null }; },
    good: (o) => o.aErr && /escape: true/.test(o.a) && o.still && o.off },
  // ---------------- A: the auditor's two stand-ins ----------------
  { id: "A1", what: "(q8; r8-check P3) an enter counter whose result doesn't depend on who came: honest log verified; its change entry rewritten (n 999): flagged `rerun`, not skipped", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.call("olive", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
      const u = s.call("olive", "upload", { text: 'world.on("enter", (e) => { const n = (world.get("self", "t/n")?.n ?? 0) + 1; world.set("self", "t/n", { n }); });' });
      const ins = s.call("olive", "set", { id: "door", component: "script:greet", value: { src: u.src, scope: { ids: "self", comps: ["t/n"] }, on: ["enter"] } });
      s.step(); const ran = D.presenceEvent(s.w(), "enter", "u-vicvicvicvicvicvicvi");
      const E = s.entries(); const A0 = AU.auditScripts(E, s.w().getBlob, { run: SB.runScript });
      const L = JSON.parse(JSON.stringify(E)); const ai = L.findLastIndex((e: any) => e.kind === "act" && e.verb === "script");
      const ci = L.findIndex((e: any, i: number) => i > ai && e.kind === "change" && e.cause === ai); L[ci] = JSON.parse(JSON.stringify(L[ci]).replace('"n":1', '"n":999'));
      const A1 = AU.auditScripts(L, s.w().getBlob, { run: SB.runScript });
      return { ins: show(ins), ran: ran?.[0]?.status, honest: { f: A0.flags.length, s: A0.skipped.length, r: A0.reran }, forged: { checks: A1.flags.map((f: any) => f.check), s: A1.skipped.length } }; },
    good: (o) => o.ins === "ok" && o.ran === "ran" && o.honest.f === 0 && o.honest.s === 0 && o.honest.r === 1 && JSON.stringify(o.forged.checks) === '["rerun-anon"]' && o.forged.s === 0 },
  // ---------------- U: the agent hears vacated ----------------
  { id: "U1", what: "(holes M3 / claims O1) an agent seated on S gets `vacated {socket: S, at}`: its seat clears, it stands where the authority let it go, and its inbox says who moved the seat; a message for another seat changes nothing", async run() {
      const { WorldAgent } = await import(TREE + "mcpl/agent.ts");
      const ag = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "Hep", world: "x", avatar: "" });
      ag.setOccupant({ to: "s2" }); ag.bodyInbox([{ type: "vacated", socket: "s1", by: "bob", why: "w" }]); const other = ag.myOccupancy?.to ?? null;
      ag.setOccupant({ to: "s1" }); ag.bodyInbox([{ type: "vacated", socket: "s1", by: "bob", why: "chair.transform was changed by someone else", at: [3, 0.45, 7] }]);
      const said = ag.inbox.map((x: any) => x.text).join(" | ");
      return { other, seat: ag.myOccupancy, mount: ag.mounts.has("Hep"), pos: [ag.pos.x, ag.pos.y, ag.pos.z], said }; },
    good: (o) => o.other === "s2" && o.seat === null && !o.mount && JSON.stringify(o.pos) === "[3,0.45,7]" && /bob moved/.test(o.said) && /standing where it was/.test(o.said) },
  { id: "U2", what: "(holes L4) the client's and agent's one predicate: a `vacated` stands you up only from the socket it names", run() {
      const f = SK.vacatedFromMine;
      return { mine: f?.({ type: "vacated", socket: "s1" }, { to: "s1" }), other: f?.({ type: "vacated", socket: "s1" }, { to: "s2" }), none: f?.({ type: "vacated", socket: "s1" }, null), noSeat: f?.({ type: "vacated" }, { to: "s1" }) }; },
    good: (o) => o.mine === true && o.other === false && o.none === false && o.noSeat === false },
  // ---------------- T: the track after a seat ----------------
  { id: "T1", what: "(scars M2) a world with a spawn: visitor vic rides olive's ferry 15 m (a motion set up before he sat), then steps off it: the step is measured from the seat, not refused too-fast from where he boarded", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "visitor" });
      s.call("olive", "set", { id: "@world", component: "spawn", value: { pos: [4, 0, -0.6] } });
      s.call("olive", "create", { id: "ferry", model: "chair", components: { ...SEAT(), reactions: { cross: { kind: "set", component: "transform", value: { pos: [4, 0, 15], q: [0, 0, 0, 1], scale: [1, 1, 1] } } } }, place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "ferry", action: "sit" });
      s.call("olive", "move", { to: [4, 0, -1.5] }); const go = s.call("olive", "use", { id: "ferry", action: "cross" });
      const rode = seated(s, "vic");
      const step = s.call("vic", "move", { to: [4, 0, 16.3] });
      return { sit: show(sit), go: show(go), rode, step: show(step), seated: seated(s, "vic") }; },
    good: (o) => o.sit === "ok" && o.go === "ok" && o.rode && o.step === "ok" && !o.seated },
  { id: "T2", what: "…and an unseat lets them go at the seat, told where (`at`): bob moves the chair vic sits on 20 m; vic's track is the seat's old pose and his next step from there is fine", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "visitor" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); s.call("vic", "use", { id: "chair", action: "sit" });
      const mv = s.call("bob", "set", { id: "chair", component: "transform", value: { pos: [24, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
      const msg = (s.w().presence.inbox?.vic ?? []).find?.((m: any) => m.type === "vacated");
      const at = s.w().presence.bodies.vic?.at;
      const step = s.call("vic", "move", { to: [at?.[0] ?? 0, 0, (at?.[2] ?? 0) + 0.8] });
      return { mv: show(mv), seated: seated(s, "vic"), at, msgAt: msg?.at ?? null, step: show(step) }; },
    good: (o) => o.mv === "ok" && !o.seated && Array.isArray(o.at) && Math.abs(o.at[0] - 4) < 0.01 && Math.abs(o.at[1] - 0.45) < 0.01 && JSON.stringify(o.msgAt) === JSON.stringify(o.at) && o.step === "ok" },
  // ---------------- L: lows ----------------
  { id: "L1", what: "(q5) a verb named after an Object.prototype key is an unknown verb, never a crash", run(s) {
      s.call("olive", "create-world", { title: s.name });
      const out: any = {}; for (const v of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]) out[v] = show(s.call("olive", v, { x: 1 })); return out; },
    good: (o) => Object.values(o).every((x: any) => /^refused unknown-verb/.test(x)) },
  { id: "L2", what: "(holes L5) only the founding is the founding: a later create-world act (a refused attempt the log keeps) whose body is purged doesn't mark the log", run() {
      const L = [{ kind: "genesis", body: {} }, { kind: "act", actor: "olive", verb: "create-world", body: { title: "t" } }, { kind: "act", actor: "vic", verb: "create-world", body: { commit: "0".repeat(64) } }];
      return { marked: SR.shapesMarked(L, (i: number) => (i === 2 ? null : L[i]?.body)), founding: SR.shapesMarked(L.slice(0, 2), (i: number) => (i === 1 ? null : L[i]?.body)) }; },
    good: (o) => o.marked === false && o.founding === true },
  { id: "L3", what: "(claims O2) an unlogged grab's activation records no identity (no trigger, no event.by; the script still hears `by`)", run(s) {
      const WHO = "u-vicvicvicvicvicvicvi";
      s.call("olive", "create-world", { title: s.name }); roles(s, { [WHO]: "visitor" });
      s.call("olive", "create", { id: "cup", model: "crate", components: { grabbable: { who: "visitor" } }, place: { at: [0, 0] } });
      const u = s.call("olive", "upload", { text: 'world.on("grab", (e) => { world.set("self", "t/g", { heard: typeof e.by === "string" && e.by.length > 0 }); });' });
      const ins = s.call("olive", "set", { id: "cup", component: "script:watch", value: { src: u.src, scope: { ids: "self", comps: ["t/g"] }, on: ["grab"] } });
      s.call(WHO, "move", { to: [0, 0, 0.6] }); const g = s.call(WHO, "grab", { id: "cup" });
      const act = s.entries().findLast((e: any) => e.kind === "act" && e.verb === "script");
      return { ins: show(ins), g: show(g), heard: comp(s, "cup", "t/g")?.heard, logged: !!g.act || !!g.recorded, trigger: act?.body?.trigger ?? null, by: act?.body?.event?.by ?? null }; },
    good: (o) => o.ins === "ok" && o.g === "ok" && o.heard === true && (o.logged || (o.trigger === null && o.by === null)) },
  { id: "L4", what: "(claims O3) the translator that writes the repair-shapes marker is named @13 or later (both names; @14 renamed a motion type)", async run() {
      const f = fs.existsSync(TREE + "tools/protocol/import-v1/translate-v1.js") ? TREE : ENGINE;
      const TV = await import(f + "tools/protocol/import-v1/translate-v1.js"); return { t: TV.TRANSLATOR, s: TV.TRANSLATOR_SIM }; },
    good: (o) => /@(1[3-9]|[2-9]\d)$/.test(o.t) && /@(1[3-9]|[2-9]\d)$/.test(o.s) },
];

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[r9-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
