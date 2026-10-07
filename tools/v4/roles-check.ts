// tools/v4/roles-check.ts — roles, switches and moderation through the real door (RESEARCH-roles-moderation-2026-10-06;
// PLAN decisions 10-06: the Sanctioned Society — ranked membership only, banned and ghost as states outside it).
//   bun tools/v4/roles-check.ts                 every case
//   bun tools/v4/roles-check.ts --only R1,S2    just those
//   bun tools/v4/roles-check.ts --tree <dir>    against another checkout's shared/ (a mutant, a base)
//   bun tools/v4/roles-check.ts --control       the base commit (6c4eb3c8, before roles): every case must be red there
//                                               except the K cases (today's behaviour, kept: green at base too)
//   bun tools/v4/roles-check.ts --mutants       remove each gate in turn (a copy of the tree): its named cases must go
//                                               red; a no-op control mutation must stay green
// Cases:
//   K   kept: what the door did before, unchanged (green at base AND now)
//   R   S1 ranks, definitions, the effective set
//   S   S2 thing and world writes go through switches
//   M   S3 moderation tools: warn, mute, unmute, kick, ban, unban, the grant rule, script pauses, modlog/bans
//   G   ghost: the unranked state outside society (a sanction, or chosen)
//   T   S5 translation: v1 gen/fly → can
//   P   S6 the person menu (personActions, pure)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/v4/durable.ts";
import { custodyAt, modLogAt } from "../../server/v4/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "6c4eb3c8";

// [name, file (under shared/), find, replace, cases that must turn red]. Applied as an exact text replacement; a mutation
// whose text isn't found exactly once is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string, string[]][] = [
  // S1
  ["role-defs: unknown switch", "v4/roles.js", "if (!Object.hasOwn(SWITCHES, k)) { const dym = guessSwitch(k); return bad(\"schema\"", "if (false) { const dym = guessSwitch(k); return bad(\"schema\"", ["R1"]],
  ["role-defs: dependencies", "v4/roles.js", "const br = brokenNeed(full); if (br) return bad(", "const br = null; if (br) return bad(", ["R2"]],
  ["role-defs: unique ranks", "v4/roles.js", "if (ranks.has(r)) return bad(", "if (false) return bad(", ["R3"]],
  ["role-defs: no custom role at a built-in's rank", "v4/roles.js", "if ([RANK.builder, RANK.moderator].includes(d.rank)) return bad(", "if (false) return bad(", ["R3"]],
  ["role-defs: no owner key", "v4/roles.js", "if (id === \"owner\") return bad(\"shape\", \"role-defs can't define owner", "if (false) return bad(\"shape\", \"role-defs can't define owner", ["R4"]],
  ["role-defs: custom ranks 1–254", "v4/roles.js", "d.rank < 1 || d.rank > 254)", "d.rank < 1)", ["R4"]],
  ["role-defs: built-in ranks are fixed", "v4/roles.js", "if (d.rank !== undefined && d.rank !== BUILTIN[id].rank) return bad(\"rank\"", "if (false) return bad(\"rank\"", ["R4"]],
  ["custom roles resolve to their rank", "v4/roles.js", "if (!d || !CUSTOM_ID.test(id) || !Number.isInteger(d.rank)) return null;", "return null;", ["R5", "R6", "S2", "S4"]],
  ["none holds nothing at -1", "v4/roles.js", "if (id === \"none\") return { id, name: \"No role\", rank: RANK.none,", "if (id === \"none\") return { id, name: \"No role\", rank: 0,", ["R5"]],
  ["default-role: never owner", "v4/door.js", "if (id === \"@world\" && comp === \"default-role\" && (v?.role === \"owner\" ||", "if (id === \"@world\" && comp === \"default-role\" && (false ||", ["R6", "K2"]],
  ["guests: at most the default role (write)", "v4/door.js", "(R.GUESTS_AT_MOST_DEFAULT && R.rankOfRole(wcS, v.guests) > R.rankOfRole(wcS, v.role))", "false", ["R6"]],
  ["per-person can applies", "v4/roles.js", "if (isObj(entry?.can)) Object.assign(can, pickSwitches(entry.can));", "", ["R7", "S1", "S3"]],
  ["per-person can: names checked", "v4/door.js", "const bad = R.checkCan(v.can, at); if (bad) refuse(", "const bad = null; if (bad) refuse(", ["R7"]],
  ["per-person can: dependencies at write", "v4/door.js", "if (br) refuse(\"needs\", `${at}: ${br[0]} needs ${br[1]}, which would be off`", "if (false) refuse(\"needs\", `${at}: ${br[0]} needs ${br[1]}, which would be off`", ["R7"]],
  ["a held custom role can't vanish", "v4/door.js", "  rolesCheck(st, s, norm);", "", ["R1", "R2", "R3", "R4", "R8"]],
  ["held roles: counted", "v4/roles.js", "const n = held(id);\n    if (n > 0) return bad(\"held\"", "const n = 0;\n    if (n > 0) return bad(\"held\"", ["R8"]],
  ["role-defs edits built-ins", "v4/roles.js", "const b = BUILTIN[id]; const can = { ...b.can, ...(isObj(d?.can) ? pickSwitches(d.can) : {}) };", "const b = BUILTIN[id]; const can = { ...b.can };", ["R9"]],
  ["role-defs is owner-only", "v4/door.js", "  if (base === \"roles\") return \"grant\";\n  return \"owner\";", "  if (base === \"roles\") return \"grant\";\n  return \"build\";", ["K3", "S2"]],
  // S2
  ["editOthers on things others made", "v4/door.js", "const c = creatorOf(w, op.id); return c && c.rights === holder ? null : \"editOthers\";", "return null;", ["S1"]],
  ["editWorld covers the world's look", "v4/door.js", "if (R.EDIT_WORLD_SWITCH && (WORLD_LOOK.has(base) ||", "if (false && (WORLD_LOOK.has(base) ||", ["S2"]],
  ["scripts switch gates install", "v4/door.js", "if (!may(st, installer, \"scripts\")) refuse(\"rights\"", "if (false) refuse(\"rights\"", ["S3"]],
  ["scripts switch gates upload", "v4/door.js", "if (!may(w.state(), actor, \"scripts\")) refuse(\"rights\", `uploading", "if (false) refuse(\"rights\", `uploading", ["S3"]],
  ["who reads custom ranks", "v4/door.js", "const whoRank = (st, name) => R.roleDef(wcOf(st), name)?.rank ?? RANK.owner;", "const whoRank = (st, name) => ({ visitor: 0, builder: 100, moderator: 200, owner: 255 })[name] ?? 0;", ["S4"]],
  ["a who names a role here", "v4/door.js", "if (comp === \"grabbable\" && obj) whoOk(v.who, at);", "", ["S4"]],
  ["undo along rank", "v4/door.js", "if (!eo || me < them) refuse(\"rank\"", "if (!eo) refuse(\"rank\"", ["S5"]],
  ["generate gates the palette", "v4/door.js", "  if (base === \"palette\") return \"generate\";", "  if (base === \"palette\") return \"build\";", ["S6"]],
  ["default-role gen opens generate to strangers", "v4/roles.js", "if (!entry && !opts.anon && dr?.gen === true) can.generate = true;", "", ["S6"]],
  ["a lock is lifted only by who may edit it", "v4/door.js", "const mayUnlock = !who.cap && !lacks(w, st, who.actor, { verb: \"delete\", id: k, comp: \"lock\" });", "const mayUnlock = !who.cap;", ["S7"]],
  ["CONTROL (no-op: must stay green)", "v4/roles.js", "// ---------------- the other caps (research §5) ----------------", "// ---------------- the other caps (research §5)  ----------------", []],
];

async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/v4/roles-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs"]) if (fs.existsSync(path.join(ENGINE, sub))) fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  return d;
}

if (argv.includes("--mutants")) {
  let bad = 0, ran = 0; const only = opt("only")?.split(",") ?? null;
  for (const [name, file, find, repl, cs] of MUTANTS) {
    if (only && !cs.some((c) => only.includes(c)) && !(only.includes("CONTROL") && !cs.length)) continue;
    ran++; const d = copyTree("rmut"); const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the gate moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cs.length ? cs : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cs.length ? r.code !== 0 && cs.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cs.length ? `red: ${redIds.join(",") || "(none)"} (want ${cs.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-8).join("\n"));
  }
  console.log(`[roles-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
if (argv.includes("--control")) {
  // the base commit's shared/ (the door before roles): every case must be red there except K (kept: green there too)
  const d = scratch("rctl"); const r0 = Bun.spawnSync(["sh", "-c", `git archive ${BASE} shared server | tar -x -C ${d}`], { cwd: ENGINE });
  if (r0.exitCode !== 0) { console.log(`FAIL can't extract ${BASE}: ${r0.stderr}`); process.exit(1); }
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const r = await runSelf(d, null);
  const lines = r.out.split("\n").filter((l) => /^(ok|FAIL) /.test(l));
  const kept = (l: string) => l.slice(5).trim().startsWith("K");
  const wrong = lines.filter((l) => (kept(l) ? l.startsWith("FAIL") : l.startsWith("ok ")));
  console.log(lines.map((l) => `${(kept(l) ? l.startsWith("ok ") : l.startsWith("FAIL")) ? (kept(l) ? "kept at base:  " : "red at base:   ") : "WRONG AT BASE: "}${l.slice(0, 130)}`).join("\n"));
  console.log(`[roles-check --control] at ${BASE}: ${lines.length} cases, ${wrong.length} wrong (new cases must be red there, K cases green)`);
  process.exit(wrong.length ? 1 : 0);
}

// ---------------- the door, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/v4/door.js");
const F = await import(TREE + "shared/v4/fold.js");
const RL = await import(TREE + "shared/v4/roles.js").catch(() => ({}));   // absent at the base commit (--control)
const TV1 = await import(TREE + "shared/v4/translate-v1.js").catch(() => ({}));
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("roles");

function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.V4_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    kindOf: (id: string) => (id.startsWith("guest") ? "anon" : "human"),
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, tool: string, args: any = {}, step = 100) => { T += step; process.env.V4_NOW = String(T);
    try { return D.request(W(), actor, tool, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, advance: (ms: number) => { T += ms; process.env.V4_NOW = String(T); }, entries: () => W().entries, now: () => T };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const set = (s: any, who: string, comp: string, value: any, id = "@world") => s.call(who, "set", { id, component: comp, value });
const role = (s: any, who: string, value: any) => set(s, "olive", `roles:${who}`, value);
const eff = (s: any, who: string) => D.effectiveIn ? D.effectiveIn(s.w().state(), who, { anon: who.startsWith("guest") }) : null;
const MIN = 60_000, DAY = 86_400_000;
// owner olive (the founder); moderator mo; builders bob and bea; visitors vic and ann; crew (custom, 150) cy
function cast(s: any, { crew = false } = {}) {
  s.call("olive", "new", { title: s.name });
  if (crew) set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { build: true, editOthers: true, editWorld: true } } });
  for (const [who, r] of [["mo", "moderator"], ["bob", "builder"], ["bea", "builder"], ["vic", "visitor"], ["ann", "visitor"], ...(crew ? [["cy", "crew"]] : [])]) role(s, who, { role: r });
}

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- K: kept (green at base AND now) ----------------
  { id: "K1", what: "kept: a builder changes anyone's thing; a visitor changes nothing; only an owner sets the sky or roles", run(s) {
      s.call("olive", "new", { title: s.name }); role(s, "bob", { role: "builder" }); role(s, "vic", { role: "visitor" });
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      return { bob: show(set(s, "bob", "label", "b", "crate")), vic: code(set(s, "vic", "label", "v", "crate")), bobSky: code(s.call("bob", "sky", { hours: 3 })),
        bobRole: code(role({ call: (_o: string, t: string, a: any) => s.call("bob", t, a) }, "vic", { role: "builder" })) }; },
    good: (o) => o.bob === "ok" && o.vic === "rights" && o.bobSky === "rights" && o.bobRole === "rights" },
  { id: "K2", what: "kept: the legacy role none is written and read below visitor; default-role owner is refused (H5)", run(s) {
      s.call("olive", "new", { title: s.name }); const n = role(s, "vic", { role: "none" });
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      return { n: show(n), vic: code(set(s, "vic", "label", "v", "crate")), own: code(set(s, "olive", "default-role", { role: "owner" })) }; },
    good: (o) => o.n === "ok" && o.vic === "rights" && o.own === "shape" },

  // ---------------- R: S1 ranks, definitions, the effective set ----------------
  { id: "R1", what: "role-defs: an unknown switch is refused with did-you-mean (biuld → build)", run(s) { cast(s);
      const r = set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { biuld: true } } }); return { c: code(r), dym: r.refused?.didYouMean }; },
    good: (o) => o.c === "schema" && o.dym?.[0] === "build" },
  { id: "R2", what: "role-defs: editOthers without build is refused, naming the missing switch", run(s) { cast(s);
      const r = set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { editOthers: true } } }); return { c: code(r), why: r.refused?.reason }; },
    good: (o) => o.c === "needs" && /editOthers needs build/.test(o.why) },
  { id: "R3", what: "role-defs: two roles at one rank are refused; so is a custom role at builder's 100", run(s) { cast(s);
      return { two: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150 }, deck: { name: "Deck", rank: 150 } })), at100: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 100 } })) }; },
    good: (o) => o.two === "rank" && o.at100 === "rank" },
  { id: "R4", what: "role-defs: an owner key, rank 255, and a built-in's rank change are refused", run(s) { cast(s);
      return { own: code(set(s, "olive", "role-defs", { owner: { name: "Boss", rank: 255 } })), r255: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 255 } })),
        bld: code(set(s, "olive", "role-defs", { builder: { rank: 120 } })) }; },
    good: (o) => o.own === "shape" && o.r255 === "rank" && o.bld === "rank" },
  { id: "R5", what: "a crew holder stands at 150 with crew's switches; a moderator at 200; a visitor at 0; none at -1 with nothing", run(s) { cast(s, { crew: true }); role(s, "nn", { role: "none" });
      const e = (x: string) => { const v = eff(s, x); return v && { role: v.role, rank: v.rank, sw: v.switches }; };
      return { cy: e("cy"), mo: e("mo"), vic: e("vic"), nn: e("nn") }; },
    good: (o) => o.cy?.rank === 150 && o.cy.sw.includes("editWorld") && !o.cy.sw.includes("mute") && o.mo?.rank === 200 && ["mute", "kick", "ban", "grantRoles", "pauseScripts"].every((k) => o.mo.sw.includes(k))
      && o.vic?.rank === 0 && o.vic.sw.length === 0 && o.nn?.rank === -1 && o.nn.sw.length === 0 },
  { id: "R6", what: "default-role may name a custom role (crew) but never owner; guests stay at or below it", run(s) { cast(s, { crew: true });
      return { crew: show(set(s, "olive", "default-role", { role: "crew" })), own: code(set(s, "olive", "default-role", { role: "owner" })),
        up: code(set(s, "olive", "default-role", { role: "builder", guests: "moderator" })), ok: show(set(s, "olive", "default-role", { role: "moderator", guests: "builder" })),
        guest: eff(s, "guest-1")?.role, stranger: eff(s, "zed")?.role }; },
    good: (o) => o.crew === "ok" && o.own === "shape" && o.up === "shape" && o.ok === "ok" && o.guest === "builder" && o.stranger === "moderator" },
  { id: "R7", what: "per-person can: exceptions both ways, refused with did-you-mean, and checked for dependencies at write", run(s) { cast(s);
      const up = role(s, "vic", { role: "visitor", can: { fly: true } }), down = role(s, "mo", { role: "moderator", can: { ban: false } });
      const typo = role(s, "ann", { role: "visitor", can: { flie: true } }), dep = role(s, "ann", { role: "visitor", can: { editOthers: true } });
      return { up: show(up), vic: eff(s, "vic")?.switches, down: show(down), mo: eff(s, "mo")?.switches, typo: code(typo), dym: typo.refused?.didYouMean, dep: code(dep) }; },
    good: (o) => o.up === "ok" && o.vic?.includes("fly") && o.down === "ok" && !o.mo?.includes("ban") && o.mo?.includes("kick") && o.typo === "schema" && o.dym?.[0] === "fly" && o.dep === "needs" },
  { id: "R8", what: "a custom role somebody holds can't be deleted (refused with the count); moving them off and deleting it in one batch lands", run(s) { cast(s, { crew: true });
      const del = set(s, "olive", "role-defs", {});
      const mv = s.call("olive", "batch", { ops: [{ tool: "set", args: { id: "@world", component: "roles:cy", value: { role: "builder" } } }, { tool: "set", args: { id: "@world", component: "role-defs", value: {} } }] });
      return { del: code(del), why: del.refused?.reason, mv: show(mv), cy: eff(s, "cy")?.role }; },
    good: (o) => o.del === "held" && /1 person holds crew/.test(o.why) && o.mv === "ok" && o.cy === "builder" },
  { id: "R9", what: "role-defs edits a built-in's switches: builders lose editOthers world-wide; renaming keeps the rank", run(s) { cast(s);
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      const r = set(s, "olive", "role-defs", { builder: { name: "Maker", can: { editOthers: false } } });
      return { r: show(r), bob: code(set(s, "bob", "label", "x", "crate")), rank: eff(s, "bob")?.rank, name: eff(s, "bob")?.name }; },
    good: (o) => o.r === "ok" && o.bob === "rights" && o.rank === 100 && o.name === "Maker" },
  { id: "K3", what: "kept: role-defs is owner-only (a moderator can't define roles)", run(s) { cast(s);
      return { mo: code(set(s, "mo", "role-defs", { crew: { name: "Crew", rank: 150 } })) }; },
    good: (o) => o.mo === "rights" },

  // ---------------- S: S2 writes go through switches ----------------
  { id: "S1", what: "editOthers: a builder without it changes their own crate and is refused on someone else's (needs editOthers)", run(s) { cast(s);
      role(s, "bob", { role: "builder", can: { editOthers: false } });
      s.call("bob", "create", { id: "mine", model: "crate", place: { at: [0, 0] } }); s.call("bea", "create", { id: "hers", model: "crate", place: { at: [2, 0] } });
      const a = set(s, "bob", "label", "b", "mine"), b = set(s, "bob", "label", "b", "hers");
      return { mine: show(a), hers: code(b), needs: b.refused?.needs }; },
    good: (o) => o.mine === "ok" && o.hers === "rights" && o.needs === "editOthers" },
  { id: "S2", what: "editWorld: a crew member sets sky and about, but not roles:*, access or sim", run(s) { cast(s, { crew: true });
      return { sky: show(s.call("cy", "sky", { hours: 9 })), about: show(set(s, "cy", "about", { name: "x", text: "y" })), roles: code(set(s, "cy", "roles:vic", { role: "builder" })),
        access: code(set(s, "cy", "access", { join: "anyone" })), sim: code(set(s, "cy", "sim", { engine: "eidosim@0.5.0" })), bob: code(s.call("bob", "sky", { hours: 3 })) }; },
    good: (o) => o.sky === "ok" && o.about === "ok" && o.roles === "rights" && o.access === "rights" && o.sim === "rights" && o.bob === "rights" },
  { id: "S3", what: "scripts: can.scripts false refuses a builder's upload and install", run(s) { cast(s);
      role(s, "bob", { role: "builder", can: { scripts: false } });
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const up = s.call("bob", "upload", { text: "export default (world) => {}" });
      const ins = set(s, "bob", "script:a", { src: "sha256:" + "0".repeat(64), scope: { ids: "self", comps: ["label"] }, on: ["use"] }, "box");
      return { up: code(up), ins: code(ins), needs: ins.refused?.needs }; },
    good: (o) => o.up === "rights" && o.ins === "rights" && o.needs === "scripts" },
  { id: "S4", what: "who fields name custom roles: grabbable.who crew admits a crew member and refuses a visitor; a who that names no role is refused", run(s) { cast(s, { crew: true });
      s.call("olive", "create", { id: "key", model: "book", components: { grabbable: { who: "crew" } }, place: { at: [0, 0] } });
      s.call("cy", "move", { to: [0, 0, 0.5] }); s.call("vic", "move", { to: [0.3, 0, 0.5] });
      const v = s.call("vic", "grab", { id: "key" }), c = s.call("cy", "grab", { id: "key" });
      const bad = s.call("olive", "create", { id: "k2", model: "book", components: { grabbable: { who: "crewe" } }, place: { at: [3, 0] } });
      return { vic: code(v), cy: show(c), bad: code(bad) }; },
    good: (o) => o.vic === "rights" && o.cy === "ok" && o.bad === "shape" },
  { id: "S5", what: "undo goes along rank: a builder can't undo a moderator's act; a moderator can undo a builder's", run(s) { cast(s);
      const a = s.call("mo", "create", { id: "m1", model: "crate", place: { at: [0, 0] } }); const b = s.call("bob", "create", { id: "b1", model: "crate", place: { at: [3, 0] } });
      return { bob: code(s.call("bob", "undo", { act: a.act ?? a.seq })), mo: show(s.call("mo", "undo", { act: b.act ?? b.seq })) }; },
    good: (o) => o.bob === "rank" && o.mo === "ok" },
  { id: "S6", what: "generate is checked: a builder can't add to the palette; with can.generate they can; default-role gen opens it to strangers, not guests", run(s) { cast(s);
      const pal = (who: string, k: string) => set(s, who, `palette:${k}`, { name: k, path: `store/${k}.glb` });
      const b0 = pal("bob", "a"); role(s, "bob", { role: "builder", can: { generate: true } }); const b1 = pal("bob", "b");
      set(s, "olive", "default-role", { role: "builder", gen: true, guests: "builder" });
      return { b0: code(b0), b1: show(b1), zed: show(pal("zed", "c")), guest: code(pal("guest-2", "d")) }; },
    good: (o) => o.b0 === "rights" && o.b1 === "ok" && o.zed === "ok" && o.guest === "rights" },
  { id: "S7", what: "a lock: acting through it needs the rights to lift it; bob's own cup on bea's locked table moves through_lock only while bob holds editOthers", run(s) { cast(s);
      s.call("bea", "create", { id: "table", model: "table", place: { at: [0, 0] } }); set(s, "bea", "lock", true, "table");
      s.call("bob", "create", { id: "cup", model: "book", place: { on: "table" } });
      const a = s.call("bob", "place", { id: "cup", on: "table", offset: [0.2, 0], through_lock: true });
      role(s, "bob", { role: "builder", can: { editOthers: false } });
      const b = s.call("bob", "place", { id: "cup", on: "table", offset: [-0.2, 0], through_lock: true });
      return { a: show(a), b: code(b), parent: s.w().state().entities.cup?.c.parent?.to }; },
    good: (o) => o.parent === "table" && o.a === "ok" && o.b === "locked" },
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
console.log(`[roles-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
