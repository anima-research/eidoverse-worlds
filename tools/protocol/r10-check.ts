// tools/protocol/r10-check.ts — review round 10 (REVIEW-holes-r10, REVIEW-scars-r10, REVIEW-claims-r10, 2026-10-17): the
// fixes, each row red first (against caab0868) and held by a mutation below.
//   bun tools/protocol/r10-check.ts                 every row
//   bun tools/protocol/r10-check.ts --only M1,A1    just those
//   bun tools/protocol/r10-check.ts --tree <dir>    against another checkout's shared/ + mcpl/ (a mutant)
//   bun tools/protocol/r10-check.ts --mutants       remove each fix in turn (a copy of shared/ and mcpl/): its rows must go
//                                                  red; a no-op control mutation must stay green
// Rows:
//   S   a sit is within reach (holes M1): from afar it is refused (no unlogged teleport past the spawn rule); a seat that
//       wasn't boarded within reach never re-anchors the track; the first step off clears the seat (L5)
//   H   a follow-up restore steps over the follow-up delete it reverses (holes M2): an undo after a delete that dropped a
//       handler gives it back to its author (and every authorship reader agrees); a key re-created by someone else is a new life
//   A   the auditor's stand-ins are valid identities of two shapes (holes M3, L3); an arrival mismatch is `rerun-anon`, never `rerun`
//   F   the authority's consequences are follow-ups (scars M3): resettle is the system's act; a delete's set-down passes no lock
//   U   vacated: sent when a socket goes or is switched off (holes L6); the browser and agent stand at its `at` (claims O1);
//       a follow-up on the seat isn't an edit of the seat's own motion (claims O3)
//   L   lows: undo drops references to things gone since (holes L1); a prototype key isn't a body verb (holes L2)
//   X   the spec says it (holes M4 / scars M1, M2, M5; claims R1–R7)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { TRANSLATOR } from "./import-v1/translate-v1.js";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };

// [name, file under the tree, find, replace, rows]
// [name, file under the tree, find, replace, rows]
const MUTANTS: [string, string, string, string, string[]][] = [
  ["a sit from anywhere", "shared/protocol/authority/use.js", "if (!inOccupyReach(from, sp, OCCUPY_REACH.lag)) refuse(", "if (false) refuse(", ["S1"]],
  ["every seat re-anchors", "shared/protocol/authority/occupants.js", "|| w.presence.occupants?.[who]?.near !== true) return null;", ") return null;", ["S2"]],
  ["the first step keeps the seat", "shared/protocol/authority/bodyverbs.js", "if (w.presence.occupants?.[actor]) clearOccupant(w, actor); }", "}", ["S3"]],
  ["lastTouch: a restore doesn't step over its delete", "shared/protocol/authority/followups.js", "if (o.verb === \"delete\" && restored) { restored = false; continue; } return null; }", "return null; }", ["H1"]],
  ["creatorOf: a restore doesn't step over its delete", "shared/protocol/authority/rights.js", "if (o.verb === \"delete\" && fu.has(k) && restored && comp !== undefined", "if (false && comp !== undefined", ["H2"]],
  ["lastSetterOf: a restore doesn't step over its delete", "shared/protocol/authority/rights.js", "if (restored) { restored = false; continue; } }   // r9 H1, r10 M2", "}", ["H2"]],
  ["creatorAt: a restore doesn't step over its delete", "shared/protocol/scriptaudit.js", "if (o.verb === \"delete\" && fu.has(k) && restored && (o.comp === comp || o.comp === undefined)) { restored = false; continue; }   // reversed", "if (false) { continue; }   // reversed", ["H2"]],
  ["sponsorAt: a restore doesn't step over its delete", "shared/protocol/scriptaudit.js", "{ restored = false; continue; }   // r10 M2", "{ restored = false; }   // r10 M2", ["H2"]],
  ["the stand tile held does nothing", "client/lib/localbody.js", "if ((keys.has('KeyX') || escapeTile) && !mayLeave(body, 'menu'))", "if (keys.has('KeyX') && !mayLeave(body, 'menu'))", ["E1"]],
  ["creatorOf merges a new life", "shared/protocol/authority/rights.js", "if (o.verb === \"set\" && o.comp === comp) restored = false;", "", ["H3"]],
  ["the second stand-in is minted-shaped", "shared/protocol/scriptaudit.js", "export const ARRIVAL_STAND_IN_2 = \"zq-stand-in\";", "export const ARRIVAL_STAND_IN_2 = \"u-\" + \"b\".repeat(20);", ["A1", "A2"]],
  ["an arrival mismatch is a forgery", "shared/protocol/scriptaudit.js", "if (anonWho) { flags.push({ seq, check: \"rerun-anon\"", "if (false) { flags.push({ seq, check: \"rerun-anon\"", ["A3"]],
  ["resettle under the asker", "shared/protocol/authority/followups.js", "let after = after0; const actor = \"system\";", "let after = after0; const actor = asker;", ["F1"]],
  ["a created child's pose is read from before the write", "shared/protocol/authority/followups.js", "const was = (k) => (before.entities[k] ? worldT(before, k) : null) ?? worldT(after, k);", "const was = (k) => worldT(before, k);", ["F3"]],
  ["the set-down is the deleter's write", "shared/protocol/authority/writes.js", "ops.push(followUp(setOp(id, \"transform\", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] })));", "ops.push(setOp(id, \"transform\", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] }));", ["F2"]],
  ["no vacated when a socket goes", "shared/protocol/authority/writes.js", "if (typeof to === \"string\") inboxPush(w.presence, who, { type: \"vacated\"", "if (false) inboxPush(w.presence, who, { type: \"vacated\"", ["U1"]],
  ["the browser ignores vacated.at", "client/lib/localbody.js", "dismountMe('script', vacatedAt(u))", "dismountMe('script')", ["U2"]],
  ["the exemption counts follow-ups as edits", "shared/protocol/authority/occupants.js", "(lastTouch(w, from, key, { authored: true })?.seq ?? Infinity) < since", "(lastTouch(w, from, key)?.seq ?? Infinity) < since", ["U3"]],
  ["undo restores references to things gone since", "shared/protocol/authority/undo.js", "const nv = since.size ? withoutRefs(id, comp, old, since) : old;", "const nv = old;", ["L1"]],
  ["a body verb read through the prototype", "mcpl/tools.ts", "if (Object.hasOwn(BODY_VERBS, verb)) return", "if (BODY_VERBS[verb]) return", ["L2"]],
  ["CONTROL (no-op: must stay green)", "shared/protocol/authority/gate.js", "// ---------- L7: the one gate ----------", "// ---------- L7:  the one gate ----------", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/r10-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
// a mutant tree: shared/ copied, mcpl/ copied without its node_modules (linked back to the real one)
function copyTree(tag: string) { const d = scratch(tag);
  fs.cpSync(path.join(ENGINE, "shared"), path.join(d, "shared"), { recursive: true });
  // client/: every entry linked back, except lib/localbody.js, copied (a mutant edits it; U2 reads it as text)
  fs.mkdirSync(path.join(d, "client", "lib"), { recursive: true });
  for (const k of fs.readdirSync(path.join(ENGINE, "client"))) if (k !== "lib") fs.symlinkSync(path.join(ENGINE, "client", k), path.join(d, "client", k));
  for (const k of fs.readdirSync(path.join(ENGINE, "client", "lib"))) if (k !== "localbody.js") fs.symlinkSync(path.join(ENGINE, "client", "lib", k), path.join(d, "client", "lib", k));
  fs.cpSync(path.join(ENGINE, "client", "lib", "localbody.js"), path.join(d, "client", "lib", "localbody.js"));
  fs.cpSync(path.join(ENGINE, "mcpl"), path.join(d, "mcpl"), { recursive: true, filter: (src) => !src.includes(`${path.sep}node_modules`) });
  try { fs.symlinkSync(path.join(ENGINE, "mcpl", "node_modules"), path.join(d, "mcpl", "node_modules")); } catch { /* no node_modules: the import says so */ }
  // everything else the copied files import from the checkout (server/, client/, node_modules…) is the checkout's own
  for (const k of fs.readdirSync(ENGINE)) if (!["shared", "mcpl", "client", ".git"].includes(k) && !fs.existsSync(path.join(d, k))) try { fs.symlinkSync(path.join(ENGINE, k), path.join(d, k)); } catch { /* best effort */ }
  return d; }
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = copyTree("r10mut"); const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[r10-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
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
const root = scratch("r10");

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

const RT = await import(TREE + "shared/protocol/authority/rights.js");
const FU = (s: any, seq: number) => { const ch = s.entries()[seq]; const ops = ch?.body?.ops ?? []; return (ch?.body?.followUps ?? []).map((k: number) => `${ops[k]?.verb} ${ops[k]?.id}.${ops[k]?.comp ?? "*"}`); };
const readText = (rel: string) => { try { return fs.readFileSync(TREE + rel, "utf8"); } catch { return fs.readFileSync(ENGINE + rel, "utf8"); } };
const section = (md: string, head: RegExp) => { const i = md.search(head); if (i < 0) return ""; const rest = md.slice(i + 1); const j = rest.search(/\n## /); return md.slice(i, j < 0 ? undefined : i + 1 + j); };

// builder bob's lever whose reset names only x; the deleter deletes x (the handler goes, a follow-up delete) and undoes it
function leverUndo(s: any, who: string) {
  s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "inhabitant" });
  s.call("bob", "create", { id: "x", model: "crate", place: { at: [6, 0] } });
  const c = s.call("bob", "create", { id: "lever", model: "crate", components: { reactions: { go: { kind: "reset", targets: ["x"] } } }, place: { at: [0, 0] } });
  s.call("bob", "set", { id: "x", component: "transform", value: { pos: [7, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
  s.call("vic", "move", { to: [0, 0, -1] });
  const d = s.call(who, "delete", { id: "x" }); const dropped = comp(s, "lever", "reactions") === undefined;
  const un = s.call(who, "undo", {});
  return { c: show(c), d: show(d), dropped, un: show(un), undoFU: FU(s, un.seq), restored: JSON.stringify(comp(s, "lever", "reactions")) };
}

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- S: a sit is within reach ----------------
  { id: "S1", what: "(holes M1, p3) a world with a spawn at [-18,0,0]: visitor vic, refused a teleport to olive's chair at [17,0], is refused `use sit` from 35 m too (out-of-reach), stays tracked at the spawn, and his step to the chair is too-fast; only refusals logged. Within reach the sit is fine", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "inhabitant" });
      s.call("olive", "set", { id: "@world", component: "spawn", value: { pos: [-18, 0, 0] } });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [17, 0] } });
      s.call("olive", "create", { id: "stool", model: "chair", components: SEAT(), place: { at: [-15, 0] } });
      s.call("vic", "move", { to: [-18, 0, 0] });
      const tp = s.call("vic", "move", { to: [17, 0, -0.6], teleport: true });
      const n0 = s.entries().length;
      const sit = s.call("vic", "use", { id: "chair", action: "sit" });
      const m1 = s.call("vic", "move", { to: [17, 0, -0.6] });
      const at = s.w().presence.bodies.vic?.at; const logged = s.entries().slice(n0).map((e: any) => `${e.kind} ${e.verb}${e.body?.refused ? " refused" : ""}`);
      const near = s.call("vic", "use", { id: "stool", action: "sit" });
      return { tp: show(tp), sit: show(sit), m1: show(m1), at, logged, near: show(near), seat: s.w().presence.occupants?.vic ?? null }; },
    good: (o) => /^refused spawn/.test(o.tp) && /^refused out-of-reach/.test(o.sit) && /^refused too-fast/.test(o.m1) && JSON.stringify(o.at) === "[-18,0,0]" && o.logged.every((x: string) => / refused$/.test(x)) && o.near === "ok" && o.seat?.near === true },
  { id: "S2", what: "(holes M1 b) a seat not boarded within reach (no `near`: a presence file from before r10, or a body not tracked when it sat) never re-anchors the track: the step off is measured from where the body was", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "inhabitant", bob: "builder" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [20, 0] } });
      s.call("vic", "move", { to: [0, 0, 0] });
      s.w().presence.occupants = { vic: { to: Object.keys(s.w().state().entities).find((k) => s.w().state().entities[k].c.parent?.to === "chair"), since: s.entries().length } };
      const m = s.call("vic", "move", { to: [20, 0, -0.6] });
      // …and an edit unseating such an occupant leaves the track where it was (no `at`)
      s.w().presence.occupants = { vic: { to: Object.keys(s.w().state().entities).find((k) => s.w().state().entities[k].c.parent?.to === "chair"), since: s.entries().length } };
      const mv = s.call("bob", "set", { id: "chair", component: "transform", value: { pos: [24, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } });
      const msg = (s.w().presence.inbox?.vic ?? []).find?.((x: any) => x.type === "vacated");
      return { m: show(m), mv: show(mv), at: s.w().presence.bodies.vic?.at, msgAt: msg?.at ?? null, told: !!msg }; },
    good: (o) => /^refused too-fast/.test(o.m) && o.mv === "ok" && JSON.stringify(o.at) === "[0,0,0]" && o.msgAt === null && o.told },
  { id: "S3", what: "(holes L5) the first step off a seat is the stand-up: under a metre from the seat clears it (not only past 1 m)", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "inhabitant" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "chair", action: "sit" });
      const was = seated(s, "vic"); const step = s.call("vic", "move", { to: [4.5, 0, -0.6] });
      return { sit: show(sit), was, step: show(step), seated: seated(s, "vic") }; },
    good: (o) => o.sit === "ok" && o.was && o.step === "ok" && !o.seated },
  // ---------------- H: a follow-up restore keeps the author ----------------
  { id: "H1", what: "(holes M2, p1) the delete dropped bob's only handler (a follow-up delete); the same person's undo puts it back (a follow-up set): vic's use runs bob's handler again, live and after a reload, for the owner's and for bob's own delete and undo", run() {
      const out: any = {};
      for (const who of ["olive", "bob"]) { const s = session(); const o: any = leverUndo(s, who);
        o.u1 = show(s.call("vic", "use", { id: "lever", action: "go" })); o.author = lastUse(s)?.body?.capability?.author ?? null;
        s.reopen(); o.u2 = show(s.call("vic", "use", { id: "lever", action: "go" })); out[who] = o; }
      return out; },
    good: (o) => ["olive", "bob"].every((k) => o[k].c === "ok" && o[k].d === "ok" && o[k].dropped && o[k].un === "ok" && JSON.stringify(o[k].undoFU) === '["set lever.reactions"]' && o[k].u1 === "ok" && o[k].author === "bob" && /^ok$|nothing-to-reset/.test(o[k].u2)) },
  { id: "H2", what: "…every authorship reader agrees: creatorOf and lastSetterOf name bob (not the deleter, not nobody), the auditor's creatorAt and sponsorAt too; and demoted, bob's restored handler is refused as bob's (the owner's undo never raised it)", run() {
      const s = session(); const o: any = leverUndo(s, "olive"); const w = s.w(); const L = s.entries();
      o.creator = RT.creatorOf(w, "lever", "reactions")?.by ?? null; o.setter = RT.lastSetterOf(w, "lever", "reactions"); o.at = AU.creatorAt(L, "lever", "reactions", L.length - 1)?.rights ?? null;
      // a script key the same way (the sponsor view): olive's delete of x drops nothing on a script (r8 H1), so drive the readers with a hand-made log
      const mk = (ops: any, actor: string, fu?: number[]) => ({ kind: "change", actor, verb: "batch", body: { ops, ...(fu ? { followUps: fu } : {}) } });
      const H: any[] = [{ kind: "genesis", body: {} }, { kind: "act", actor: "bob", verb: "set", body: {} }, { ...mk([{ verb: "set", id: "d", comp: "script:a", value: { src: "s" } }], "bob"), cause: 1 },
        { kind: "act", actor: "olive", verb: "delete", body: {} }, { ...mk([{ verb: "delete", id: "x" }, { verb: "delete", id: "d", comp: "script:a" }], "olive", [1]), cause: 3 },
        { kind: "act", actor: "olive", verb: "undo", body: {} }, { ...mk([{ verb: "create", id: "x" }, { verb: "set", id: "d", comp: "script:a", value: { src: "s" } }], "olive", [1]), cause: 5 }];
      o.sponsor = AU.sponsorAt(H, "d", "script:a", H.length - 1)?.rights ?? null; o.hCreator = AU.creatorAt(H, "d", "script:a", H.length - 1)?.rights ?? null;
      roles(s, { bob: "inhabitant" }); o.demoted = show(s.call("vic", "use", { id: "lever", action: "go" }));
      return o; },
    good: (o) => o.un === "ok" && o.creator === "bob" && o.setter?.by === "bob" && o.setter?.deleted === false && o.at === "bob" && o.sponsor === "bob" && o.hCreator === "bob" && /set up by bob/.test(o.demoted) },
  { id: "H3", what: "…but a key's new life isn't merged with its old: after the follow-up delete, builder wes writes lever.reactions anew; its creator and author are wes", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", wes: "builder", vic: "inhabitant" });
      s.call("bob", "create", { id: "x", model: "crate", place: { at: [6, 0] } });
      s.call("bob", "create", { id: "lever", model: "crate", components: { reactions: { go: { kind: "reset", targets: ["x"] } } }, place: { at: [0, 0] } });
      s.call("olive", "delete", { id: "x" });
      const nw = s.call("wes", "set", { id: "lever", component: "reactions", value: { lit: { kind: "set", component: "t/lit", value: { on: true } } } });
      // a follow-up set on the new life (hand-made: a clear of a reference wes's handler doesn't hold can't happen, so mark one)
      const w = s.w(); const L = s.entries();
      return { nw: show(nw), creator: RT.creatorOf(w, "lever", "reactions")?.by ?? null, at: AU.creatorAt(L, "lever", "reactions", L.length - 1)?.rights ?? null,
        hand: (() => { const mk = (ops: any, actor: string, fu?: number[]) => ({ kind: "change", actor, verb: "batch", body: { ops, ...(fu ? { followUps: fu } : {}) } });
          const W2: any = { entries: [{ kind: "genesis", body: {} }, { kind: "act", actor: "bob", verb: "set", body: {} }, { ...mk([{ verb: "set", id: "l", comp: "reactions", value: 1 }], "bob"), cause: 1 },
            { kind: "act", actor: "olive", verb: "delete", body: {} }, { ...mk([{ verb: "delete", id: "x" }, { verb: "delete", id: "l", comp: "reactions" }], "olive", [1]), cause: 3 },
            { kind: "act", actor: "wes", verb: "set", body: {} }, { ...mk([{ verb: "set", id: "l", comp: "reactions", value: 2 }], "wes"), cause: 5 },
            { kind: "act", actor: "olive", verb: "undo", body: {} }, { ...mk([{ verb: "set", id: "l", comp: "reactions", value: 2 }], "olive", [0]), cause: 7 }], presence: {} };
          return { creator: RT.creatorOf(W2, "l", "reactions")?.by ?? null, at: AU.creatorAt(W2.entries, "l", "reactions", W2.entries.length - 1)?.rights ?? null }; })() }; },
    good: (o) => o.nw === "ok" && o.creator === "wes" && o.at === "wes" && o.hand.creator === "wes" && o.hand.at === "wes" },
  // ---------------- A: the auditor's stand-ins ----------------
  { id: "A1", what: "(holes M3, p4) a door's enter script counts minted ids (u-…) and notes other shapes: an identity of another shape arrives (honest log) — no `rerun` flag (verified or listed as not re-runnable); a minted id arriving verifies clean", run() {
      const out: any = {};
      for (const who of ["u-vicvicvicvicvicvicvi", "hesperus"]) { const s = session(); s.call("olive", "create-world", { title: s.name });
        s.call("olive", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
        const u = s.call("olive", "upload", { text: 'world.on("enter", (e) => { if (String(e.by).startsWith("u-")) { const n = (world.get("self", "t/n")?.n ?? 0) + 1; world.set("self", "t/n", { n }); } else world.set("self", "t/agents", { seen: true }); });' });
        const ins = s.call("olive", "set", { id: "door", component: "script:greet", value: { src: u.src, scope: { ids: "self", comps: ["t/n", "t/agents"] }, on: ["enter"] } });
        s.step(); const ran = D.presenceEvent(s.w(), "enter", who);
        const A = AU.auditScripts(s.entries(), s.w().getBlob, { run: SB.runScript });
        out[who] = { ins: show(ins), ran: ran?.[0]?.status, flags: A.flags.map((f: any) => f.check), skipped: A.skipped.length, reran: A.reran }; }
      return out; },
    good: (o) => o.hesperus.ins === "ok" && o.hesperus.ran === "ran" && o.hesperus.flags.length === 0 && o.hesperus.skipped + o.hesperus.reran === 1 && o["u-vicvicvicvicvicvicvi"].flags.length === 0 && o["u-vicvicvicvicvicvicvi"].reran === 1 },
  { id: "A2", what: "(holes L3) both stand-ins are valid identities (§3.1), nobody's, of different shapes: one minted-shaped (u- and 20 lowercase), one of another valid shape (no u-)", run() {
      return { a: AU.ARRIVAL_STAND_IN, b: AU.ARRIVAL_STAND_IN_2, va: F.isIdentity(AU.ARRIVAL_STAND_IN ?? ""), vb: F.isIdentity(AU.ARRIVAL_STAND_IN_2 ?? "") }; },
    good: (o) => o.va && o.vb && /^u-[a-z0-9]{20}$/.test(o.a) && !/^u-/.test(o.b) && o.b === o.b.toLowerCase() },
  { id: "A3", what: "(holes M3) an enter counter (no identity in its result), its change entry rewritten: flagged `rerun-anon` (a mismatch the re-run can't attribute), never plain `rerun`", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.call("olive", "create", { id: "door", model: "crate", place: { at: [0, 0] } });
      const u = s.call("olive", "upload", { text: 'world.on("enter", (e) => { const n = (world.get("self", "t/n")?.n ?? 0) + 1; world.set("self", "t/n", { n }); });' });
      s.call("olive", "set", { id: "door", component: "script:greet", value: { src: u.src, scope: { ids: "self", comps: ["t/n"] }, on: ["enter"] } });
      s.step(); D.presenceEvent(s.w(), "enter", "u-vicvicvicvicvicvicvi");
      const L = JSON.parse(JSON.stringify(s.entries())); const ai = L.findLastIndex((e: any) => e.kind === "act" && e.verb === "script");
      const ci = L.findIndex((e: any, i: number) => i > ai && e.kind === "change" && e.cause === ai); L[ci] = JSON.parse(JSON.stringify(L[ci]).replace('"n":1', '"n":999'));
      const A = AU.auditScripts(L, s.w().getBlob, { run: SB.runScript });
      return { checks: A.flags.map((f: any) => f.check), s: A.skipped.length }; },
    good: (o) => JSON.stringify(o.checks) === '["rerun-anon"]' && o.s === 0 },
  // ---------------- F: the authority's consequences are follow-ups ----------------
  { id: "F1", what: "(scars M3) a builder resizes a plinth (no engine) with vic's crate resting on it: the crate's set-down is written by `system` under its own `resettle` act (caused by the builder's), never as the builder", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { bob: "builder", vic: "builder" });
      s.call("bob", "create", { id: "plinth", components: { mesh: { shape: "box", size: [1.5, 0.8, 1.5] }, transform: { pos: [0, 0, 0] } } });
      const c = s.call("vic", "create", { id: "crate", model: "crate", components: { physics: { kind: "dynamic" } }, place: { on: "plinth" } });
      const r = s.call("bob", "set", { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.3, 1.5] } });
      const E = s.entries(); const ch = E.findLast((e: any) => e.kind === "change" && (e.body?.ops ?? [e.body]).some?.((o: any) => o?.id === "crate"));
      const cause = ch ? E[ch.cause] : null;
      return { c: show(c), r: show(r), parent: comp(s, "crate", "parent")?.to, actor: ch?.actor ?? null, causeVerb: cause?.verb ?? null, causeActor: cause?.actor ?? null, askerAct: cause ? E[cause.cause]?.actor : null, set: JSON.stringify(r.notes ?? []).includes("setDown") }; },
    good: (o) => o.c === "ok" && o.r === "ok" && o.parent === "plinth" && o.set && o.actor === "system" && o.causeVerb === "resettle" && o.causeActor === "system" && o.askerAct === "bob" },
  { id: "F3", what: "(review of PR #260, followups.js:58) under a running engine, ONE batch resizes a plinth and creates a dynamic crate on it: the request lands whole (no throw after the commit), the crate is re-dropped from where the write put it (the system's resettle, its launch from the crate's new pose)", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "plinth", components: { mesh: { shape: "box", size: [1.5, 0.8, 1.5] }, transform: { pos: [0, 0, 0] } } });
      const n0 = s.entries().length;
      const r = s.call("olive", "batch", { ops: [{ verb: "set", args: { id: "plinth", component: "mesh", value: { shape: "box", size: [1.5, 0.3, 1.5] } } },
        { verb: "create", args: { id: "crate", components: { mesh: { shape: "box", size: [0.4, 0.4, 0.4] }, physics: { kind: "dynamic" }, parent: { to: "plinth" }, transform: { pos: [0, 0.6, 0] } } } }] });
      const E = s.entries().slice(n0); const rs = E.find((e: any) => e.kind === "act" && e.verb === "resettle"); const ln = E.find((e: any) => e.kind === "sim" && e.verb === "launch" && e.body?.id === "crate");
      return { r: show(r), resettle: rs?.body?.occupants ?? null, launchY: ln?.body?.p?.[1] ?? null, crate: !!comp(s, "crate", "physics") }; },
    good: (o) => o.r === "ok" && JSON.stringify(o.resettle) === '["crate"]' && typeof o.launchY === "number" && o.crate },
  { id: "F4", what: "(review of PR #260, followups.js:58) a resettle the gate would refuse (the speck freed from its scaled host would stand at world scale 1800, past the stored ±1000) refuses the asker's write whole: nothing is written, the host keeps its scale", run(s) {
      s.call("olive", "create-world", { title: s.name }); s.call("olive", "set", { id: "@world", component: "physics-engine", value: { engine: "eidosim@1.0.0" } });
      s.call("olive", "create", { id: "big", components: { mesh: { shape: "box", size: [1, 0.5, 1] }, transform: { pos: [0, 0, 0], scale: [100, 100, 100] } } });
      const c = s.call("olive", "create", { id: "speck", components: { mesh: { shape: "box", size: [0.05, 0.05, 0.05] }, physics: { kind: "dynamic" }, parent: { to: "big" }, transform: { pos: [0, 0.6, 0], scale: [20, 20, 20] } } });
      const n0 = s.entries().length;
      const r = s.call("olive", "set", { id: "big", component: "transform", value: { pos: [0, 0, 0], scale: [90, 90, 90] } });
      return { c: show(c), r: show(r), refused: r?.refused?.code ?? null, wrote: s.entries().length - n0, scale: comp(s, "big", "transform")?.scale?.[0] }; },
    good: (o) => o.c === "ok" && o.refused !== null && !String(o.r).startsWith("CRASH") && o.wrote <= 1 && o.scale === 100 },
  { id: "F2", what: "(scars M3) builder vic deletes his crate with owner olive's locked vase resting on it (unparented): the delete lands, the vase is set down as the authority's follow-up (named in followUps), and the vase stays olive's", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "builder" });
      s.call("vic", "create", { id: "crate", components: { mesh: { shape: "box", size: [1, 1, 1] }, transform: { pos: [3, 0, 0] } } });
      const v = s.call("olive", "create", { id: "vase", components: { mesh: { shape: "box", size: [0.3, 0.4, 0.3] }, transform: { pos: [3, 1, 0] }, lock: true } });
      const d = s.call("vic", "delete", { id: "crate" });
      return { v: show(v), d: show(d), y: comp(s, "vase", "transform")?.pos?.[1], fu: d.ok ? FU(s, d.seq) : null, lock: comp(s, "vase", "lock"), creator: RT.creatorOf(s.w(), "vase")?.by ?? null }; },
    good: (o) => o.v === "ok" && o.d === "ok" && Math.abs(o.y) < 1e-6 && JSON.stringify(o.fu) === '["set vase.transform"]' && o.lock === true && o.creator === "olive" },
  // ---------------- U: vacated ----------------
  { id: "U1", what: "(holes L6) olive removes the seat vic sits on: vic gets `vacated {socket, at}` in his inbox (as for an edit), and his track restarts at the seat", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "inhabitant" });
      s.call("olive", "create", { id: "chair", model: "chair", components: SEAT(), place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); s.call("vic", "use", { id: "chair", action: "sit" });
      const sock = s.w().presence.occupants?.vic?.to;
      const del = s.call("olive", "delete", { id: sock });
      const msg = (s.w().presence.inbox?.vic ?? []).find?.((m: any) => m.type === "vacated");
      return { del: show(del), seated: seated(s, "vic"), seat: msg?.socket ?? null, sock, at: msg?.at ?? null, track: s.w().presence.bodies.vic?.at, by: msg?.by ?? null }; },
    good: (o) => o.del === "ok" && !o.seated && o.seat === o.sock && Array.isArray(o.at) && JSON.stringify(o.at) === JSON.stringify(o.track) && Math.abs(o.at[0] - 4) < 0.01 && o.by === "olive" },
  { id: "U2", what: "(claims O1) the browser and the agent stand where the authority let them go: one reader (sockbody vacatedAt) of `vacated.at`; the browser's dismount takes it", run() {
      const f = SK.vacatedAt; const src = readText("client/lib/localbody.js"); const agent = readText("mcpl/agent.ts");
      return { good: f?.({ at: [1, 2, 3] }), bad: f?.({ at: [1, NaN, 3] }), none: f?.({}), short: f?.({ at: [1, 2] }),
        browser: /dismountMe\('script', vacatedAt\(u\)\)/.test(src) && /if \(at\) off\.set\(at\[0\], at\[1\], at\[2\]\)/.test(src), agent: /vacatedAt\(m\)/.test(agent) }; },
    good: (o) => JSON.stringify(o.good) === "[1,2,3]" && o.bad === null && o.none === null && o.short === null && o.browser && o.agent },
  { id: "U3", what: "(claims O3) vic rides olive's carousel (set up before he sat); a thing its other handler named is deleted (a follow-up clear on the carousel's reactions); the carousel's turn still carries him", run(s) {
      s.call("olive", "create-world", { title: s.name }); roles(s, { vic: "inhabitant" });
      s.call("olive", "create", { id: "x", model: "crate", place: { at: [9, 0] }, components: { home: { pos: [9, 0, 0] } } });
      s.call("olive", "create", { id: "carousel", model: "chair", components: { ...SEAT(), reactions: { turn: { kind: "set", component: "motion", value: { type: "spin", axis: [0, 1, 0], speed: 30 } }, sweep: { kind: "reset", targets: ["x"] } } }, place: { at: [4, 0] } });
      s.call("vic", "move", { to: [4, 0, -0.6] }); const sit = s.call("vic", "use", { id: "carousel", action: "sit" });
      const d = s.call("olive", "delete", { id: "x" });
      s.call("olive", "move", { to: [4, 0, -1.5] }); const turn = s.call("olive", "use", { id: "carousel", action: "turn" });
      return { sit: show(sit), d: show(d), cleared: comp(s, "carousel", "reactions")?.sweep === undefined, turn: show(turn), seated: seated(s, "vic") }; },
    good: (o) => o.sit === "ok" && o.d === "ok" && o.cleared && o.turn === "ok" && o.seated },
  { id: "E1", what: "(claims R6) the stand tile pressed and held escapes a script seat, as X held does (touch and phone parity): the tile says so on pointer down and up, and the per-frame escape reads it", run() {
      const lb = readText("client/lib/localbody.js"), eb = readText("client/lib/actionbar.js");
      return { emits: /k === 'stand'\) \{ b\.onpointerdown = \(\) => bus\.emit\('escape-hold', true\); b\.onpointerup = b\.onpointerleave = b\.onpointercancel = \(\) => bus\.emit\('escape-hold', false\)/.test(eb),
        hears: /bus\.on\('escape-hold', \(on\) => \{ escapeTile = !!on; \}\)/.test(lb), reads: /\(keys\.has\('KeyX'\) \|\| escapeTile\) && !mayLeave\(body, 'menu'\)/.test(lb), hold: SK.ESCAPE_HOLD_S }; },
    good: (o) => o.emits && o.hears && o.reads && o.hold === 1.5 },
  // ---------------- L: lows ----------------
  { id: "L1", what: "(holes L1, p5) olive deletes x, then y (both in the lever's reset), then undoes the first: x is back in the reset, y's reference stays cleared (said), not the whole undo refused", run(s) {
      s.call("olive", "create-world", { title: s.name });
      s.call("olive", "create", { id: "x", model: "crate", place: { at: [6, 0] } }); s.call("olive", "create", { id: "y", model: "crate", place: { at: [9, 0] } });
      s.call("olive", "create", { id: "lever", model: "crate", components: { reactions: { go: { kind: "reset", targets: ["x", "y"] } } }, place: { at: [0, 0] } });
      const d1 = s.call("olive", "delete", { id: "x" }); const d2 = s.call("olive", "delete", { id: "y" });
      const u = s.call("olive", "undo", { act: d1.act });
      return { d1: show(d1), d2: show(d2), u: show(u), x: !!s.w().state().entities.x, targets: comp(s, "lever", "reactions")?.go?.targets, kept: JSON.stringify(u.notes ?? []).includes('"kept":["y"]') }; },
    good: (o) => o.d1 === "ok" && o.d2 === "ok" && o.u === "ok" && o.x && JSON.stringify(o.targets) === '["x"]' && o.kept },
  { id: "L2", what: "(holes L2) act {verb: 'constructor' | 'toString' | 'hasOwnProperty'} is never answered from Object.prototype as a body verb: it goes to the authority (an unknown verb), not back as the agent object", async run() {
      const TL = await import(TREE + "mcpl/tools.ts"); const asked: string[] = [];
      const ag: any = new Proxy({ request: async (v: string) => { asked.push(v); return { ok: false, refused: { code: "unknown-verb", reason: `no verb '${v}'` } }; } }, { get: (t, k) => (k in t ? t[k] : k === "then" ? undefined : () => ({})) });
      const out: any = {}; for (const v of ["constructor", "toString", "hasOwnProperty"]) { let r: any; try { r = await TL.HANDLERS.act(ag, { verb: v, args: {} }, {}); } catch (e) { r = { threw: String(e).slice(0, 80) }; } out[v] = r?.content?.[0]?.text ?? (r?.threw ?? typeof r); }
      return { out, asked }; },
    good: (o) => ["constructor", "toString", "hasOwnProperty"].every((v) => o.asked.includes(v) && typeof o.out[v] === "string" && /unknown-verb|no verb/.test(o.out[v])) },
];
const PROTO = () => readText("spec/PROTOCOL.md");
cases.push(
  { id: "X1", what: "(holes M4 = scars M1; claims R1) PROTOCOL §3's batch row names followUps with its well-formedness (non-empty, strictly ascending integers, in range, else the entry is malformed) and its invariant (no asker's rights or locks; folded like any op; authorship skips it; a restore steps over its delete; a verifier re-runs the gate on unmarked ops only); §10 and the version history say minor 0 gained it before release", run() {
      const md = PROTO(); const s3 = section(md, /\n## 3\. /); const s10 = section(md, /\n## 10\. /); const vh = md.slice(md.indexOf("## Version history"));
      return { row: /\| `batch` \| `\{ops: \[[^`]*\], followUps\?: \[i, …\]\}`/.test(s3), shape: /non-empty, strictly ascending list of integer indices/.test(s3) && /`batch-followups`/.test(s3) && /whole entry\*\* malformed/.test(s3),
        inv: /without the asker's rights or locks/.test(s3) && /applies them like\s+any op/.test(s3) && /\*\*authorship\*\*/.test(s3) && /steps over\s+the marked `delete` it reverses/.test(s3) && /\*\*unmarked ops\s+only\*\*/.test(s3) && /remaps `followUps`/.test(s3),
        minor: /`followUps` \(§3\) was added to this protocol \*\*at minor 0\*\*/.test(s10) && /minor 0 gained the batch body's `followUps`/.test(vh) }; },
    good: (o) => o.row && o.shape && o.inv && o.minor },
  { id: "X2", what: "(scars M3; claims R2, R3) §7: the gate's follow-up exception (named in followUps), and one table of the authority's consequences (clears and set-down: followUps; resettle: the system's own act; stamps: the asker's); §4's deletion names the clears and sets down what rested", run() {
      const md = PROTO(); const s7 = section(md, /\n## 7\. /); const s4 = section(md, /\n## 4\. /);
      return { gate: /except that the\s+authority's own follow-ups inside a write pass it without the asker's rights, locks, keys or in-flight\s+check/.test(s7),
        table: /\| a deletion's reference clears[^\n]*`followUps` \|/.test(s7) && /\| a deletion's set-down[^\n]*`followUps` \|/.test(s7) && /\| occupants set down or dropped[^\n]*`resettle \{hosts, occupants, asked\}`[^\n]*\| `system` \|/.test(s7) && /\| stamps on what the asker is writing[^\n]*\| the asker \|/.test(s7),
        del: /The change entry names them \(`followUps`, §3\)/.test(s4) && /set\s+down onto what is below, as a follow-up/.test(s4) && s4.includes(`${TRANSLATOR.split("/").pop()}\`, §14)`) }; },
    good: (o) => o.gate && o.table && o.del },
  { id: "X3", what: "(scars M2, M5) Body ownership: arrival is presence (the world's log records nothing about a body; the hash reaches the moderator log only when someone acts); B2 runs in admit on every op, follow-ups and system writes included, references nulled at read time; B5 doesn't end on leaving; `arrive` stays reserved", run() {
      const md = PROTO(); const b = fs.readFileSync(new URL("../../docs/AVATAR-DIRECTION.md", import.meta.url), "utf8");   // the guard rails are direction now (house markup D, #260 10-20)
      return { b6: !/records only `arrive/.test(md) && /\*\*The world's log\s+records nothing about a body\*\*/.test(b) && /\*\*moderator log\*\* only when someone acts about it: a report,\s+a kick, a ban, or an arrival refused by `avatar-deny`/.test(b),
        b2: /\*\*B2\. One predicate, in `admit`, on every op\.\*\*/.test(b) && /follow-ups and system\s+writes/.test(b) && /\*\*at read time\*\*/.test(b) && !/top of `lacks\(\)`/.test(b),
        b5: !/when the grantee leaves the\s+world unless/.test(b) && /It does \*\*not\*\* end when the\s+grantee leaves/.test(b), reserved: /the request\s+`arrive`/.test(md) }; },
    good: (o) => o.b6 && o.b2 && o.b5 && o.reserved },
  { id: "X4", what: "(claims R4–R7, R9) §8: unlogged grabs carry no identity (releases do), two stand-ins of two shapes, rerun-anon; §5: vacated {socket, by, why, at}, a sit within reach, the stand tile held; COMPONENT-LADDER @12 and later; SCRIPTS and AGENTS say the escape, the seat's own motion as when you sat, and where an agent stands", run() {
      const md = PROTO(); const s8 = section(md, /\n## 8\. /); const s5 = section(md, /\n## 5\. /);
      const lad = readText("docs/COMPONENT-LADDER.md"), sc = readText("docs/SCRIPTS.md"), ag = readText("AGENTS.md");
      return { s8: /a grab that isn't itself logged, records no trigger actor/.test(s8) && /a release\s+always has its own act/.test(s8) && (() => { const au = fs.readFileSync(new URL("../../docs/SCRIPTS.md", import.meta.url), "utf8"); return /second stand-in of another shape/.test(au) && /flagged `rerun-anon`/.test(au); })() && /An auditor's re-run of a script is a\s+check, never the record/.test(s8),   // the auditor's procedure is docs since the house's view (#260 10-20)
        s5: /`vacated \{socket, by,\s+why, at\}`/.test(s5) && /\(`out-of-reach`\)/.test(s5) && /the stand tile pressed\s+and held/.test(fs.readFileSync(new URL("../../docs/SEATS.md", import.meta.url), "utf8")),   // the binding is the client's since the house's view (#260 10-20)
        lad: /translate-v1@12 and later/.test(lad), sc: /pressing and holding the stand tile/.test(sc) && /`rerun-anon`/.test(sc),
        ag: /`detach \{escape\?\}`/.test(ag) && /as it was when they sat, carries its occupants/.test(ag) && /where you were let go; you stand\s+there/.test(ag) }; },
    good: (o) => o.s8 && o.s5 && o.lad && o.sc && o.ag },
  { id: "X5", what: "(claims O4) agenttools-check's rows have one id each: the alias rows are AT9, the consent rows AT7", run() {
      const t = readText("tools/protocol/agenttools-check.ts"); const at7 = [...t.matchAll(/"AT7[a-z]? /g)].length; const alias = /"AT9 walk_to/.test(t) && !/"AT7 walk_to/.test(t);
      return { at7, alias }; },
    good: (o) => o.alias && o.at7 === 3 },
);

let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any; try { o = await c.run(session()); } catch (e) { o = { threw: String(e?.stack ?? e).slice(0, 600) }; }
  let good = false; try { good = !o?.threw && !!c.good(o); } catch { good = false; }
  if (good) { pass++; console.log(`ok   ${c.id} ${c.what}`); }
  else { fail++; console.log(`FAIL ${c.id} ${c.what}\n     ${JSON.stringify(o)?.slice(0, 900)}`); }
}
console.log(`[r10-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
