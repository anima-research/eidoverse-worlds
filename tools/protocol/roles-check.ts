// tools/protocol/roles-check.ts — roles, permissions and moderation through the real authority (RESEARCH-roles-moderation-2026-10-06;
// PLAN decisions 10-06: the Sanctioned Society — ranked membership only, banned and ghost as states outside it).
//   bun tools/protocol/roles-check.ts                 every case
//   bun tools/protocol/roles-check.ts --only R1,S2    just those
//   bun tools/protocol/roles-check.ts --tree <dir>    against another checkout's shared/ (a mutant, a base)
//   bun tools/protocol/roles-check.ts --control       the base commit (6c4eb3c8, before roles): every case must be red there
//                                               except the K cases (today's behaviour, kept: green at base too)
//   bun tools/protocol/roles-check.ts --mutants       remove each gate in turn (a copy of the tree): its named cases must go
//                                               red; a no-op control mutation must stay green
// Cases:
//   K   kept: what the authority did before, unchanged (green at base AND now)
//   R   S1 ranks, definitions, the effective set
//   S   S2 thing and world writes go through permissions
//   M   S3 moderation tools: warn, mute, unmute, kick, ban, unban, the grant rule, script pauses, modlog/bans
//   G   ghost: the unranked state outside society (a sanction, or chosen)
//   T   S5 translation: v1 gen/fly → can
//   P   S6 the person menu (personActions, pure)
// @ts-nocheck
import "./fixture-ids.ts";   // fixtures seed the ids they read (R 10-17: writers never choose ids)
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "./common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const BASE = "6c4eb3c8";

// [name, file (under shared/), find, replace, cases that must turn red]. Applied as an exact text replacement; a mutation
// whose text isn't found exactly once is itself a failure (the gate moved: update the list).
const MUTANTS: [string, string, string, string, string[]][] = [
  // S1
  ["role-defs: unknown permission", "protocol/roles.js", "if (!Object.hasOwn(PERMISSIONS, k)) { const dym = guessSwitch(k); return bad(\"schema\"", "if (false) { const dym = guessSwitch(k); return bad(\"schema\"", ["R1"]],
  ["role-defs: dependencies", "protocol/roles.js", "const br = brokenNeed(full); if (br) return bad(", "const br = null; if (br) return bad(", ["R2"]],
  ["role-defs: unique ranks", "protocol/roles.js", "if (ranks.has(r)) return bad(", "if (false) return bad(", ["R3"]],
  ["role-defs: no custom role at a built-in's rank", "protocol/roles.js", "if ([RANK.builder, RANK.moderator].includes(d.rank)) return bad(", "if (false) return bad(", ["R3"]],
  ["role-defs: no owner key", "protocol/roles.js", "if (id === \"owner\") return bad(\"shape\", \"role-defs can't define owner", "if (false) return bad(\"shape\", \"role-defs can't define owner", ["R4"]],
  ["role-defs: custom ranks 1–254", "protocol/roles.js", "if (!Number.isInteger(d.rank) || d.rank < 1 || d.rank > 254) return bad(\"rank\"", "if (!Number.isInteger(d.rank) || d.rank < 1) return bad(\"rank\"", ["R4"]],
  ["role-defs: built-in ranks are fixed", "protocol/roles.js", "if (d.rank !== undefined && d.rank !== BUILTIN[id].rank) return bad(\"rank\"", "if (false) return bad(\"rank\"", ["R4"]],
  ["custom roles resolve to their rank", "protocol/roles.js", "if (!d || !CUSTOM_ID.test(id) || !Number.isInteger(d.rank) || d.rank < 1 || d.rank > 254) return null;", "return null;", ["R5", "R6", "S2", "S4"]],
  ["none holds nothing at -1", "protocol/roles.js", "if (id === \"none\") return { id, name: \"No role\", rank: RANK.none,", "if (id === \"none\") return { id, name: \"No role\", rank: 0,", ["R5"]],
  ["default-role: never owner", "protocol/authority/checks.js", "if (id === \"@world\" && comp === \"default-role\" && (v?.role === \"owner\" ||", "if (id === \"@world\" && comp === \"default-role\" && (false ||", ["R6", "K2"]],
  ["guests: at most the default role (write)", "protocol/authority/checks.js", "(R.GUESTS_AT_MOST_DEFAULT && R.rankOfRole(wcS, v.guests) > R.rankOfRole(wcS, v.role))", "false", ["R6"]],
  ["per-person can applies", "protocol/roles.js", "if (isObj(entry?.can)) Object.assign(can, pickPermissions(entry.can));", "", ["R7", "S1", "S3"]],
  ["per-person can: names checked", "protocol/authority/checks.js", "const bad = R.checkCan(v.can, at); if (bad) refuse(", "const bad = null; if (bad) refuse(", ["R7"]],
  ["per-person can: dependencies at write", "protocol/authority/checks.js", "if (br) refuse(\"needs\", `${at}: ${br[0]} needs ${br[1]}, which would be off`", "if (false) refuse(\"needs\", `${at}: ${br[0]} needs ${br[1]}, which would be off`", ["R7"]],
  ["a held custom role can't vanish", "protocol/authority/gate.js", "  rolesCheck(st, s, norm);", "", ["R1", "R2", "R3", "R4", "R8"]],
  ["held roles: counted", "protocol/roles.js", "const n = held(id);\n    if (n > 0) return bad(\"held\"", "const n = 0;\n    if (n > 0) return bad(\"held\"", ["R8"]],
  ["role-defs edits built-ins", "protocol/roles.js", "const b = BUILTIN[id]; const can = { ...b.can, ...(isObj(d?.can) ? pickPermissions(d.can) : {}) };", "const b = BUILTIN[id]; const can = { ...b.can };", ["R9"]],
  ["role-defs is owner-only", "protocol/authority/gate.js", "  if (base === \"roles\") return \"grant\";\n  return \"owner\";", "  if (base === \"roles\") return \"grant\";\n  return \"build\";", ["K3", "S2"]],
  // S2
  ["editOthers on things others made", "protocol/authority/gate.js", "const c = creatorOf(w, op.id); return c && c.rights === holder ? null : \"editOthers\";", "return null;", ["S1"]],
  ["editWorld covers the world's look", "protocol/authority/gate.js", "if (R.EDIT_WORLD_PERMISSION && (WORLD_LOOK.has(base) ||", "if (false && (WORLD_LOOK.has(base) ||", ["S2"]],
  ["scripts permission gates install", "protocol/authority/scripts.js", "if (!may(st, installer, \"scripts\")) refuse(\"rights\"", "if (false) refuse(\"rights\"", ["S3"]],
  ["scripts permission gates upload", "protocol/authority/scriptrun.js", "if (!may(w.state(), actor, \"scripts\")) refuse(\"rights\", `uploading", "if (false) refuse(\"rights\", `uploading", ["S3"]],
  ["who reads custom ranks", "protocol/authority.js", "const whoRank = (st, name) => R.roleDef(wcOf(st), name)?.rank ?? RANK.owner;", "const whoRank = (st, name) => ({ visitor: 0, builder: 100, moderator: 200, owner: 255 })[name] ?? 0;", ["S4"]],
  ["a who names a role here", "protocol/authority/checks.js", "if (comp === \"grabbable\" && obj) whoOk(v.who, at);", "", ["S4"]],
  ["undo along rank", "protocol/authority/undo.js", "if (!eo || me < them) refuse(\"rank\"", "if (!eo) refuse(\"rank\"", ["S5"]],
  ["generate gates the world's assets", "protocol/authority/gate.js", "  if (base === \"assets\") return \"generate\";", "  if (base === \"assets\") return \"build\";", ["S6"]],
  ["default-role can opens generate to strangers", "protocol/roles.js", "if (!entry && !opts.anon && isObj(dr?.can)) Object.assign(can, pickPermissions(dr.can));", "", ["S6"]],
  ["a lock is lifted only by who may edit it", "protocol/authority.js", "const mayUnlock = !who.cap && !lacks(w, st, who.actor, { verb: \"delete\", id: k, comp: \"lock\" });", "const mayUnlock = !who.cap;", ["S7"]],
  // S3
  ["person acts need their permission", "protocol/authority/moderation.js", "if (!powers.some((k) => me.can[k])) refuse(\"rights\"", "if (false) refuse(\"rights\"", ["M1", "M4", "M5", "M9"]],
  ["person acts only below you", "protocol/authority/moderation.js", "if (tr >= me.rank) refuse(\"rank\"", "if (false) refuse(\"rank\"", ["M1"]],
  ["owners can't be banned or kicked", "protocol/authority/moderation.js", "if (noOwner && them === \"owner\") refuse(", "if (false) refuse(", ["M1"]],
  ["a ban with no end is an owner's", "protocol/authority/moderation.js", "if (a.days === undefined && !owner) refuse(", "if (false) refuse(", ["M1"]],
  ["the moderator ban cap", "protocol/authority/moderation.js", "if (a.days !== undefined && a.days > R.MOD_BAN_MAX_DAYS && !owner) refuse(", "if (false) refuse(", ["M1"]],
  ["bans end by the clock", "protocol/authority.js", "const inForce = (w, m) => !!m && (m.until === undefined || m.until > w.now());", "const inForce = (w, m) => !!m;", ["M2", "M3", "G2"]],
  // the independent review (10-07)
  ["the strongest sanction in force wins", "protocol/authority.js", "const strongest = (a) => a.reduce(", "const strongest = (a) => a.slice(-1)[0] ?? null; const _s = (a) => a.reduce(", ["V1"]],
  ["a mute's channels are the union", "protocol/authority.js", "const channels = [...new Set(a.flatMap((m) => m.channels ?? [\"voice\", \"chat\"]))];", "const channels = strongest(a).channels ?? [\"voice\", \"chat\"];", ["V1b"]],
  ["a lift needs rights over every record", "protocol/authority/moderation.js", "for (const rec of (Array.isArray(recs) ? recs : recs ? [recs] : [])) {", "for (const rec of (Array.isArray(recs) ? recs.slice(-1) : recs ? [recs] : [])) {", ["V2"]],
  ["nobody lifts their own", "protocol/authority/moderation.js", "if (a.who === actor) refuse(\"rank\", `you can't lift a ${verb} on yourself`", "if (false) refuse(\"rank\", `you can't lift a ${verb} on yourself`", ["V5"]],
  ["ghost {who} is not the chosen mode", "protocol/authority.js", "|| (verb === \"ghost\" && args?.who !== undefined && args.who !== actor)", "", ["V4"]],
  ["leave passes the kick gate", "protocol/authority.js", "if (w.exists && tool !== \"help\" && tool !== \"leave\" && kickOf(w, actor))", "if (w.exists && tool !== \"help\" && kickOf(w, actor))", ["K5"]],
  ["a muted refusal isn't logged", "protocol/authority.js", "\"kicked\", \"ghost\", \"muted\"]);", "\"kicked\", \"ghost\"]);", ["V7"]],
  ["look hides a ghost", "protocol/authority/blueprints.js", ".filter(([id]) => id === actor || !ghostOf(w, id))", "", ["V8"]],
  ["custom ranks are range-checked on read", "protocol/roles.js", "|| d.rank < 1 || d.rank > 254) return null;", ") return null;", ["V9"]],
  ["seniority binds a capability's holder", "protocol/authority.js", "const cap = who.cap; if (cap && cap.kind !== \"reaction\" && cap.kind !== \"script\") return;", "const cap = who.cap; if (cap) return;", ["V10"]],
  ["a banned person is refused", "protocol/authority.js", "if (w.exists && tool !== \"help\" && tool !== \"leave\" && isBanned(w, actor)) refuse(\"banned\"", "if (false) refuse(\"banned\"", ["M2"]],
  ["chat mute refuses say", "protocol/authority/verbs.js", "{ const m = muteOf(w, actor, \"chat\"); if (m)", "{ const m = null; if (m)", ["M3", "V3"]],
  ["mute channels", "protocol/authority.js", "  if (channel && !channels.includes(channel)) return null;", "", ["M3"]],
  ["mute cap", "protocol/authority/moderation.js", "if (minutes > cap && (ownerCap ||", "if (false && (ownerCap ||", ["M4", "M5"]],
  ["a kick's cooldown", "protocol/authority.js", "if (w.exists && tool !== \"help\" && tool !== \"leave\" && kickOf(w, actor)) refuse(\"kicked\"", "if (false) refuse(\"kicked\"", ["M5"]],
  ["lifting goes by the record's author", "protocol/authority/moderation.js", "if (strict ? mine <= theirs : mine < theirs) refuse(\"rank\"", "if (false) refuse(\"rank\"", ["M6", "G2"]],
  ["lifting needs the permission", "protocol/authority/moderation.js", "if (!may(st, actor, power) && roleOf(st, actor) !== \"owner\") refuse(\"rights\", `lifting a", "if (false) refuse(\"rights\", `lifting a", ["M6"]],
  ["grant: grantRoles", "protocol/authority/gate.js", "if (n === \"grant\") return eff.can.grantRoles ? null : \"grantRoles\";", "if (n === \"grant\") return null;", ["M7"]],
  ["grant: the target ranks below you", "protocol/authority/gate.js", "if (rankOf(st, target, anon) >= me.rank) refuse(\"rank\"", "if (false) refuse(\"rank\"", ["M7"]],
  ["grant: the role you give ranks below you", "protocol/authority/gate.js", "if ((def?.rank ?? RANK.none) >= me.rank) refuse(\"rank\"", "if (false) refuse(\"rank\"", ["M7"]],
  ["grant: only permissions you hold", "protocol/authority/gate.js", "if (missing) refuse(\"rights\", `giving ${missing}", "if (false) refuse(\"rights\", `giving ${missing}", ["M7"]],
  ["grant: never your own role", "protocol/authority/gate.js", "if (target === actor) refuse(\"rights\", \"you can't change your own role\"", "if (false) refuse(\"rights\", \"you can't change your own role\"", ["M7"]],
  ["pauseScripts reaches sponsors below you", "protocol/authority/gate.js", "if (sp && rankOf(st, sp.sponsor) < rankOf(st, holder)) return;", "if (sp) return;", ["M11"]],
  ["pauseScripts needs no edit rights on the thing", "protocol/authority/gate.js", "if (pause && may(st, actor, \"pauseScripts\")) return;", "", ["M11"]],
  ["a higher pause holds", "protocol/authority/gate.js", "if (pb && pb.by !== holder && rankOf(st, holder) < rankOf(st, pb.by))", "if (false)", ["M8"]],
  ["pauseScripts is a way in", "protocol/authority/gate.js", "if (pause && !cap && may(st, holder, \"pauseScripts\")) { const sp = sponsorOf(w, op.id, op.comp);", "if (false) { const sp = sponsorOf(w, op.id, op.comp);", ["M8"]],
  ["warn needs a reason", "protocol/authority/moderation.js", "if (typeof a.reason !== \"string\" || !a.reason.trim()) refuse(\"shape\", \"warn {who, reason}", "if (false) refuse(\"shape\", \"warn {who, reason}", ["M9"]],
  ["modlog merges role changes", "protocol/authority/moderation.js", "for (const o of opsQuiet(e)) if (o.id === \"@world\" && String(o.comp ?? \"\").startsWith(\"roles:\")) rows.push(", "for (const o of []) rows.push(", ["M9"]],
  ["modlog is for moderation powers", "protocol/authority/moderation.js", "modlog: (w, actor, a) => { const st = w.state(); if (!modHolder(st, actor) && roleOf(st, actor) !== \"owner\") refuse(", "modlog: (w, actor, a) => { const st = w.state(); if (false) refuse(", ["M9"]],
  ["guests rank by their guest role", "protocol/roles.js", "let r = isObj(wc[`roles:${id}`]) ? wc[`roles:${id}`].role : anon ? guestRoleOf(wc) : base;", "let r = isObj(wc[`roles:${id}`]) ? wc[`roles:${id}`].role : anon ? \"visitor\" : base;", ["M10", "R6"]],
  // ghost
  ["a ghost can't interact or talk", "protocol/authority.js", "args.who !== actor)) && ghostOf(w, actor)) {", "args.who !== actor)) && false) {", ["G1", "G3"]],
  ["a ghost can't read chat", "protocol/authority/blueprints.js", "const match = (e) => match0(e) && !(ghost && isE(e) && e.kind === \"say\");", "const match = (e) => match0(e);", ["G1"]],
  ["a ghost may look and walk", "protocol/authority.js", "const GHOST_OK = new Set([\"help\", \"look\",", "const GHOST_OK = new Set([\"help\",", ["G1"]],
  ["a sanction isn't the ghost's to end", "protocol/authority/moderation.js", "if (!a.on && inForceOf(w, actor, \"ghost\").length) refuse(\"ghost\"", "if (false) refuse(\"ghost\"", ["G2"]],
  ["the chosen mode", "protocol/authority/moderation.js", "const G = (w.presence.ghosts ??= {}); if (a.on) G[actor] = { ts: Math.floor(w.now()) }; else delete G[actor];", "const G = {};", ["G3"]],
  // S5, S6
  ["translation: v1 fly/gen → can.fly/can.generate", "../tools/protocol/import-v1/translate-v1.js", "return Object.keys(can).length ? { ...rest, can } : rest; };", "return v; };", ["T1"]],
  ["the menu: only below you", "protocol/roles.js", "const below = them.rank < me.rank;", "const below = them.rank <= me.rank;", ["P3"]],
  ["the menu: acts follow permissions", "protocol/roles.js", "if (has(\"ban\")) out.push({ id: \"ban\", label: \"Ban…\" });", "out.push({ id: \"ban\", label: \"Ban…\" });", ["P1"]],
  ["the menu: unmute when muted", "protocol/roles.js", "out.push(state.muted ? { id: \"unmute\", label: \"Unmute\" } : { id: \"mute\", label: \"Mute…\" });", "out.push({ id: \"mute\", label: \"Mute…\" });", ["P2"]],
  ["badges: guests are guests", "protocol/roles.js", "if (p.anon) return { text: \"guest\", tone: \"guest\" };", "", ["P4"]],
  // the review's findings
  ["seniority: the start of the unbroken run", "protocol/authority/gate.js", "if (o.verb === \"set\" && o.comp === comp && o.value?.role === \"owner\") since = i; else return since; } }", "if (o.verb === \"set\" && o.comp === comp && o.value?.role === \"owner\") return i; else return since; } }", ["F5"]],
  ["seniority: no re-affirm of a senior owner", "protocol/authority/gate.js", "  if (ownerSince(w, st, target) <= ownerSince(w, st, holder))", "  if (op.value?.role === \"owner\") return;\n  if (ownerSince(w, st, target) <= ownerSince(w, st, holder))", ["F1"]],
  ["none holds no voice and no hands", "protocol/authority.js", "&& w.state().entities?.[\"@world\"] && roleOf(w.state(), actor) === \"none\")", "&& false)", ["F3"]],
  ["CONTROL (no-op: must stay green)", "protocol/roles.js", "// ---------------- the other caps (research §5) ----------------", "// ---------------- the other caps (research §5)  ----------------", []],
];

async function runSelf(tree: string, only: string[] | null, extra: string[] = []) {
  const args = ["bun", path.join(ENGINE, "tools/protocol/roles-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : []), ...extra];
  const r = Bun.spawnSync(args, { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
function copyTree(tag: string) {
  const d = scratch(tag);
  for (const sub of ["shared", "server", "tools", "defs"]) if (fs.existsSync(path.join(ENGINE, sub))) copyTree(path.join(ENGINE, sub), path.join(d, sub));
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
  // the base commit's shared/ (the authority before roles): every case must be red there except K (kept: green there too)
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

// ---------------- the authority, from a tree (this checkout unless --tree) ----------------
const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const D = await import(TREE + "shared/protocol/authority.js");
const F = await import(TREE + "shared/protocol/fold.js");
const RL = await import(TREE + "shared/protocol/roles.js").catch(() => ({}));   // absent at the base commit (--control)
const TV1 = await import(TREE + "tools/protocol/import-v1/translate-v1.js").catch(() => import(TREE + "shared/protocol/translate-v1.js")).catch(() => ({}));   // moved to tools/protocol/import-v1 on staging (the no-v1 pass)
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("roles");

function openWorld(name: string, o: any = {}) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const entries = F.readLog(readLogBytes(logPath)).map(D.posAt);
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ name, entries,
    getBlob: (h: string) => { const s = fs.readFileSync(blobPath(h), "utf8"); if (`sha256:${F.sha256(s)}` !== h) throw new Error("blob mismatch"); return JSON.parse(s); },
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => Number(process.env.PROTOCOL_NOW), writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    kindOf: (id: string) => (id.startsWith("guest") ? "anon" : "human"),
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
let T = 1800000000000, N = 0;
function session() {
  const name = `w${++N}`; let w: any = null; const W = () => (w ??= openWorld(name));
  const call = (actor: string, verb: string, args: any = {}, step = 100) => { T += step; process.env.PROTOCOL_NOW = String(T);
    try { return D.request(W(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  return { name, call, w: W, advance: (ms: number) => { T += ms; process.env.PROTOCOL_NOW = String(T); }, entries: () => W().entries, now: () => T };
}
const ok = (r: any) => r?.ok === true, code = (r: any) => r?.refused?.code;
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `refused ${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 140)}`);
const set = (s: any, who: string, comp: string, value: any, id = "@world") => s.call(who, "set", { id, component: comp, value });
const role = (s: any, who: string, value: any) => set(s, "olive", `roles:${who}`, value);
const eff = (s: any, who: string) => D.effectiveIn ? D.effectiveIn(s.w().state(), who, { anon: who.startsWith("guest") }) : null;
const MIN = 60_000, DAY = 86_400_000;
// owner olive (the founder); moderator mo; builders bob and bea; visitors vic and ann; crew (custom, 150) cy
function cast(s: any, { crew = false } = {}) {
  s.call("olive", "create-world", { title: s.name });
  if (crew) set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { build: true, editOthers: true, editWorld: true } } });
  for (const [who, r] of [["mo", "moderator"], ["bob", "builder"], ["bea", "builder"], ["vic", "visitor"], ["ann", "visitor"], ...(crew ? [["cy", "crew"]] : [])]) role(s, who, { role: r });
}

type Case = { id: string; what: string; run: (s: any) => any; good: (o: any) => boolean };
const cases: Case[] = [
  // ---------------- K: kept (green at base AND now) ----------------
  { id: "K1", what: "kept: a builder changes anyone's thing; a visitor changes nothing; only an owner sets the sky or roles", run(s) {
      s.call("olive", "create-world", { title: s.name }); role(s, "bob", { role: "builder" }); role(s, "vic", { role: "visitor" });
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      return { bob: show(set(s, "bob", "label", "b", "crate")), vic: code(set(s, "vic", "label", "v", "crate")), bobSky: code(s.call("bob", "sky", { hours: 3 })),
        bobRole: code(role({ call: (_o: string, t: string, a: any) => s.call("bob", t, a) }, "vic", { role: "builder" })) }; },
    good: (o) => o.bob === "ok" && o.vic === "rights" && o.bobSky === "rights" && o.bobRole === "rights" },
  { id: "K2", what: "kept: the legacy role none is written and read below visitor; default-role owner is refused (H5)", run(s) {
      s.call("olive", "create-world", { title: s.name }); const n = role(s, "vic", { role: "none" });
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      return { n: show(n), vic: code(set(s, "vic", "label", "v", "crate")), own: code(set(s, "olive", "default-role", { role: "owner" })) }; },
    good: (o) => o.n === "ok" && o.vic === "rights" && o.own === "shape" },

  // ---------------- R: S1 ranks, definitions, the effective set ----------------
  { id: "R1", what: "role-defs: an unknown permission is refused with did-you-mean (biuld → build)", run(s) { cast(s);
      const r = set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { biuld: true } } }); return { c: code(r), dym: r.refused?.didYouMean }; },
    good: (o) => o.c === "schema" && o.dym?.[0] === "build" },
  { id: "R2", what: "role-defs: editOthers without build is refused, naming the missing permission", run(s) { cast(s);
      const r = set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150, can: { editOthers: true } } }); return { c: code(r), why: r.refused?.reason }; },
    good: (o) => o.c === "needs" && /editOthers needs build/.test(o.why) },
  { id: "R3", what: "role-defs: two roles at one rank are refused; so is a custom role at builder's 100", run(s) { cast(s);
      return { two: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 150 }, deck: { name: "Deck", rank: 150 } })), at100: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 100 } })) }; },
    good: (o) => o.two === "rank" && o.at100 === "rank" },
  { id: "R4", what: "role-defs: an owner key, rank 255, and a built-in's rank change are refused", run(s) { cast(s);
      return { own: code(set(s, "olive", "role-defs", { owner: { name: "Boss", rank: 255 } })), r255: code(set(s, "olive", "role-defs", { crew: { name: "Crew", rank: 255 } })),
        bld: code(set(s, "olive", "role-defs", { builder: { rank: 120 } })) }; },
    good: (o) => o.own === "shape" && o.r255 === "rank" && o.bld === "rank" },
  { id: "R5", what: "a crew holder stands at 150 with crew's permissions; a moderator at 200; a visitor at 0; none at -1 with nothing", run(s) { cast(s, { crew: true }); role(s, "nn", { role: "none" });
      const e = (x: string) => { const v = eff(s, x); return v && { role: v.role, rank: v.rank, sw: v.permissions }; };
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
      return { up: show(up), vic: eff(s, "vic")?.permissions, down: show(down), mo: eff(s, "mo")?.permissions, typo: code(typo), dym: typo.refused?.didYouMean, dep: code(dep) }; },
    good: (o) => o.up === "ok" && o.vic?.includes("fly") && o.down === "ok" && !o.mo?.includes("ban") && o.mo?.includes("kick") && o.typo === "schema" && o.dym?.[0] === "fly" && o.dep === "needs" },
  { id: "R8", what: "a custom role somebody holds can't be deleted (refused with the count); moving them off and deleting it in one batch lands", run(s) { cast(s, { crew: true });
      const del = set(s, "olive", "role-defs", {});
      const mv = s.call("olive", "batch", { ops: [{ verb: "set", args: { id: "@world", component: "roles:cy", value: { role: "builder" } } }, { verb: "set", args: { id: "@world", component: "role-defs", value: {} } }] });
      return { del: code(del), why: del.refused?.reason, mv: show(mv), cy: eff(s, "cy")?.role }; },
    good: (o) => o.del === "held" && /1 person holds crew/.test(o.why) && o.mv === "ok" && o.cy === "builder" },
  { id: "R9", what: "role-defs edits a built-in's permissions: builders lose editOthers world-wide; renaming keeps the rank", run(s) { cast(s);
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } });
      const r = set(s, "olive", "role-defs", { builder: { name: "Maker", can: { editOthers: false } } });
      return { r: show(r), bob: code(set(s, "bob", "label", "x", "crate")), rank: eff(s, "bob")?.rank, name: eff(s, "bob")?.name }; },
    good: (o) => o.r === "ok" && o.bob === "rights" && o.rank === 100 && o.name === "Maker" },
  { id: "K3", what: "kept: role-defs is owner-only (a moderator can't define roles)", run(s) { cast(s);
      return { mo: code(set(s, "mo", "role-defs", { crew: { name: "Crew", rank: 150 } })) }; },
    good: (o) => o.mo === "rights" },

  // ---------------- S: S2 writes go through permissions ----------------
  { id: "S1", what: "editOthers: a builder without it changes their own crate and is refused on someone else's (needs editOthers)", run(s) { cast(s);
      role(s, "bob", { role: "builder", can: { editOthers: false } });
      s.call("bob", "create", { id: "mine", model: "crate", place: { at: [0, 0] } }); s.call("bea", "create", { id: "hers", model: "crate", place: { at: [2, 0] } });
      const a = set(s, "bob", "label", "b", "mine"), b = set(s, "bob", "label", "b", "hers");
      return { mine: show(a), hers: code(b), needs: b.refused?.needs }; },
    good: (o) => o.mine === "ok" && o.hers === "rights" && o.needs === "editOthers" },
  { id: "S2", what: "editWorld: a crew member sets sky and about, but not roles:*, access or sim", run(s) { cast(s, { crew: true });
      return { sky: show(s.call("cy", "sky", { hours: 9 })), about: show(set(s, "cy", "about", { name: "x", text: "y" })), roles: code(set(s, "cy", "roles:vic", { role: "builder" })),
        access: code(set(s, "cy", "access", { join: "anyone" })), sim: code(set(s, "cy", "sim", { engine: "eidosim@1.0.0" })), bob: code(s.call("bob", "sky", { hours: 3 })) }; },
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
  { id: "S6", what: "generate is checked: a builder can't add to the world's assets; with can.generate they can; default-role can.generate opens it to strangers, not guests", run(s) { cast(s);
      const pal = (who: string, k: string) => set(s, who, `assets:${k}`, { name: k, path: `store/${k}.glb` });
      const b0 = pal("bob", "a"); role(s, "bob", { role: "builder", can: { generate: true } }); const b1 = pal("bob", "b");
      set(s, "olive", "default-role", { role: "builder", can: { generate: true }, guests: "builder" });
      return { b0: code(b0), b1: show(b1), zed: show(pal("zed", "c")), guest: code(pal("guest-2", "d")) }; },
    good: (o) => o.b0 === "rights" && o.b1 === "ok" && o.zed === "ok" && o.guest === "rights" },
  { id: "S7", what: "a lock: acting through it needs the rights to lift it; bob's own cup on bea's locked table moves throughLock only while bob holds editOthers", run(s) { cast(s);
      s.call("bea", "create", { id: "table", model: "table", place: { at: [0, 0] } }); set(s, "bea", "lock", true, "table");
      s.call("bob", "create", { id: "cup", model: "book", place: { on: "table" } });
      const a = s.call("bob", "place", { id: "cup", on: "table", offset: [0.2, 0], throughLock: true });
      role(s, "bob", { role: "builder", can: { editOthers: false } });
      const b = s.call("bob", "place", { id: "cup", on: "table", offset: [-0.2, 0], throughLock: true });
      return { a: show(a), b: code(b), parent: s.w().state().entities.cup?.c.parent?.to }; },
    good: (o) => o.parent === "table" && o.a === "ok" && o.b === "locked" },

  // ---------------- M: S3 moderation tools ----------------
  { id: "M1", what: "ban: a moderator bans a visitor for 7 days; banning a moderator, an owner, themself, or a visitor for 31 days is refused", run(s) { cast(s);
      role(s, "mo2", { role: "moderator" });
      return { vic: show(s.call("mo", "ban", { who: "vic", days: 7, reason: "spam" })), self: code(s.call("mo", "ban", { who: "mo", days: 1 })), mo2: code(s.call("mo", "ban", { who: "mo2", days: 1 })),
        own: code(s.call("mo", "ban", { who: "olive", days: 1 })), long: code(s.call("mo", "ban", { who: "ann", days: 31 })), forever: code(s.call("mo", "ban", { who: "ann" })),
        bob: code(s.call("bob", "ban", { who: "vic", days: 1 })) }; },
    good: (o) => o.vic === "ok" && o.self === "rank" && o.mo2 === "rank" && o.own === "rights" && o.long === "rights" && o.forever === "rights" && o.bob === "rights" },
  { id: "M2", what: "ban: an owner bans with no end; a timed ban ends by the authority's clock (no record written when it ends)", run(s) { cast(s);
      const a = s.call("olive", "ban", { who: "ann" }); const b = s.call("mo", "ban", { who: "vic", days: 1 }); const n = s.w().mod.length;
      const during = { ann: D.isBanned(s.w(), "ann"), vic: D.isBanned(s.w(), "vic"), vicCall: code(s.call("vic", "look")) };
      s.advance(DAY + MIN);
      return { a: show(a), b: show(b), during, after: { ann: D.isBanned(s.w(), "ann"), vic: D.isBanned(s.w(), "vic"), vicCall: show(s.call("vic", "look")) }, written: s.w().mod.length - n }; },
    good: (o) => o.a === "ok" && o.b === "ok" && o.during.ann && o.during.vic && o.during.vicCall === "banned" && o.after.ann && !o.after.vic && o.after.vicCall === "ok" && o.written === 0 },
  { id: "M3", what: "mute: a chat-muted person's say is refused with its until, a say `to` a moderator too (public: V3); a voice mute leaves chat; it ends by the clock", run(s) { cast(s);
      const m = s.call("mo", "mute", { who: "vic", minutes: 5, channels: ["chat"], reason: "flood" });
      const say = s.call("vic", "say", { text: "hi" }), wh = s.call("vic", "say", { text: "why?", to: "mo" }), toBob = s.call("vic", "say", { text: "psst", to: "bob" });
      const voiceOnly = s.call("mo", "mute", { who: "ann", minutes: 5, channels: ["voice"] }); const annSay = s.call("ann", "say", { text: "still here" });
      s.advance(6 * MIN); const later = s.call("vic", "say", { text: "back" });
      return { m: show(m), say: code(say), until: say.refused?.until, wh: show(wh), toBob: code(toBob), voiceOnly: show(voiceOnly), annSay: show(annSay), voiceMuted: !!D.muteOf?.(s.w(), "ann", "voice"), later: show(later) }; },
    good: (o) => o.m === "ok" && o.say === "muted" && typeof o.until === "number" && /^refused muted/.test(o.wh) && o.toBob === "muted" && o.voiceOnly === "ok" && o.annSay === "ok" && o.voiceMuted === false && o.later === "ok" },
  { id: "M4", what: "mute caps: 7 days at most below owner; minutes is required; a builder has no mute", run(s) { cast(s);
      return { long: code(s.call("mo", "mute", { who: "vic", minutes: 7 * 1440 + 1 })), none: code(s.call("mo", "mute", { who: "vic" })), bob: code(s.call("bob", "mute", { who: "vic", minutes: 5 })),
        weekOk: show(s.call("mo", "mute", { who: "vic", minutes: 7 * 1440 })) }; },
    good: (o) => o.long === "bounds" && (o.none === "missing-arg" || o.none === "shape") && o.bob === "rights" && o.weekOk === "ok" },
  { id: "M5", what: "kick: a builder kicking is refused (needs kick); a moderator's kick bars rejoin for 10 minutes by default, 60 at most", run(s) { cast(s);
      const b = s.call("bob", "kick", { who: "vic" }), k = s.call("mo", "kick", { who: "vic", reason: "rude" }), long = s.call("mo", "kick", { who: "ann", minutes: 61 });
      const barred = code(s.call("vic", "look")); const until = D.kickOf?.(s.w(), "vic")?.until;
      s.advance(10 * MIN + 1000);
      return { b: code(b), needs: b.refused?.needs, k: show(k), long: code(long), barred, mins: until && Math.round((until - k.until) / MIN), after: show(s.call("vic", "look")) }; },
    good: (o) => o.b === "rights" && o.needs === "kick" && o.k === "ok" && o.long === "bounds" && o.barred === "kicked" && o.after === "ok" },
  { id: "M6", what: "unban: a moderator can't lift an owner's ban; the owner can; a moderator lifts their own", run(s) { cast(s);
      s.call("olive", "ban", { who: "ann" }); s.call("mo", "ban", { who: "vic", days: 3 });
      return { moOwner: code(s.call("mo", "unban", { who: "ann" })), moOwn: show(s.call("mo", "unban", { who: "vic" })), owner: show(s.call("olive", "unban", { who: "ann" })), bob: code(s.call("bob", "unban", { who: "ann" })) }; },
    good: (o) => o.moOwner === "rank" && o.moOwn === "ok" && o.owner === "ok" && o.bob === "rights" },
  { id: "M7", what: "the grant rule: a moderator gives builder; giving crew (it carries editWorld, which moderators lack), moderator or owner, can.generate, or changing a peer's or their own role is refused", run(s) { cast(s, { crew: true });
      return { builder: show(set(s, "mo", "roles:vic", { role: "builder" })), crew: code(set(s, "mo", "roles:ann", { role: "crew" })),
        mod: code(set(s, "mo", "roles:ann", { role: "moderator" })), own: code(set(s, "mo", "roles:ann", { role: "owner" })),
        gen: code(set(s, "mo", "roles:bob", { role: "builder", can: { generate: true } })), peer: code(set(s, "mo", "roles:mo2", { role: "visitor" }) && set(s, "olive", "roles:mo2", { role: "moderator" }) && set(s, "mo", "roles:mo2", { role: "visitor" })),
        self: code(set(s, "mo", "roles:mo", { role: "builder" })), bob: code(set(s, "bob", "roles:vic", { role: "visitor" })) }; },
    good: (o) => o.builder === "ok" && o.crew === "rights" && o.mod === "rank" && o.own === "rank" && o.gen === "rights" && o.peer === "rank" && o.self === "rights" && o.bob === "rights" },
  { id: "M8", what: "script pauses: a moderator pauses a builder's script (the sponsor is unchanged); a pause by an owner can't be resumed by the moderator or the builder", run(s) { cast(s);
      s.call("bob", "create", { id: "box", model: "crate", place: { at: [0, 0] } });
      const up = s.call("bob", "upload", { text: "export default (world, e) => { world.set('self', 'label', 'x'); }" });
      const ins = set(s, "bob", "script:a", { src: up.src, scope: { ids: "self", comps: ["label"] }, on: ["use"] }, "box");
      const v = () => s.w().state().entities.box.c["script:a"];
      const p1 = s.call("mo", "set", { id: "box", component: "script:a", value: { ...v(), paused: true } });
      const sp1 = s.call("olive", "scripts", { id: "box" }).scripts?.[0]?.sponsor ?? s.call("olive", "scripts", { id: "box" });
      const r1 = s.call("mo", "set", { id: "box", component: "script:a", value: { ...v(), paused: false } });
      const p2 = s.call("olive", "set", { id: "box", component: "script:a", value: { ...v(), paused: true } });
      const r2 = s.call("mo", "set", { id: "box", component: "script:a", value: { ...v(), paused: false } }), r3 = s.call("bob", "set", { id: "box", component: "script:a", value: { ...v(), paused: false } });
      const vicP = s.call("vic", "set", { id: "box", component: "script:a", value: { ...v(), paused: true } });
      return { up: show(up), ins: show(ins), p1: show(p1), sponsor: JSON.stringify(sp1).includes("bob"), r1: show(r1), p2: show(p2), r2: code(r2), r3: code(r3), vicP: code(vicP) }; },
    good: (o) => o.ins === "ok" && o.p1 === "ok" && o.sponsor && o.r1 === "ok" && o.p2 === "ok" && o.r2 === "rank" && o.r3 === "rank" && o.vicP === "rights" },
  { id: "M9", what: "warn needs a moderation power and a reason; modlog lists newest first with role changes merged in; bans lists what's in force", run(s) { cast(s);
      const w0 = s.call("bob", "warn", { who: "vic", reason: "x" }), w1 = s.call("mo", "warn", { who: "vic", reason: "be kind" }), w2 = s.call("mo", "warn", { who: "vic", reason: "  " });
      s.call("mo", "mute", { who: "ann", minutes: 30 }); s.call("mo", "ban", { who: "vic", days: 2 });
      const log = s.call("mo", "modlog", {}), bob = s.call("bob", "modlog", {}), bans = s.call("mo", "bans", {});
      return { w0: code(w0), w1: show(w1), w2: code(w2), first: log.records?.[0]?.verb, verbs: log.records?.map((r: any) => r.verb), bob: code(bob),
        now: bans.now?.map((x: any) => [x.who, Object.keys(x).filter((k) => ["ban", "mute", "kick", "ghost"].includes(k))]).sort() }; },
    good: (o) => o.w0 === "rights" && o.w1 === "ok" && (o.w2 === "missing-arg" || o.w2 === "shape") && o.first === "ban" && o.verbs?.includes("warn") && o.verbs?.includes("role") && o.bob === "rights"
      && JSON.stringify(o.now) === JSON.stringify([["ann", ["mute"]], ["vic", ["ban"]]]) },
  { id: "M10", what: "a guest's rank comes from the guests role: a moderator may act on a guest builder; a builder default doesn't make guests outrank anyone", run(s) { cast(s);
      set(s, "olive", "default-role", { role: "builder", guests: "builder" });
      return { mute: show(s.call("mo", "mute", { who: "guest-9", minutes: 5 })), rank: eff(s, "guest-9")?.rank, bob: code(s.call("bob", "kick", { who: "guest-9" })) }; },
    good: (o) => o.mute === "ok" && o.rank === 100 && o.bob === "rights" },

  { id: "M11", what: "pauseScripts alone (a warden at 150 with nothing else) pauses a builder's script, not an owner's", run(s) { cast(s);
      set(s, "olive", "role-defs", { warden: { name: "Warden", rank: 150, can: { pauseScripts: true } } }); role(s, "wa", { role: "warden" });
      const inst = (who: string, id: string) => { s.call(who, "create", { id, model: "crate", place: { at: [id === "b" ? 0 : 3, 0] } });
        const up = s.call(who, "upload", { text: "export default (world, e) => { world.set('self', 'label', 'x'); }" });
        set(s, who, "script:a", { src: up.src, scope: { ids: "self", comps: ["label"] }, on: ["use"] }, id); };
      inst("bob", "b"); inst("olive", "o");
      const pause = (id: string) => s.call("wa", "set", { id, component: "script:a", value: { ...s.w().state().entities[id].c["script:a"], paused: true } });
      return { b: show(pause("b")), o: code(pause("o")), label: code(s.call("wa", "set", { id: "b", component: "label", value: "x" })) }; },
    good: (o) => o.b === "ok" && o.o === "rank" && o.label === "rights" },
  // ---------------- G: ghost (outside society) ----------------
  { id: "G1", what: "ghost as a sanction: a moderator ghosts a visitor; the ghost can look and walk, can't build, use or say; history hides says from them", run(s) { cast(s);
      s.call("olive", "create", { id: "crate", model: "crate", place: { at: [0, 0] } }); s.call("bob", "say", { text: "secret plans" });
      role(s, "vic", { role: "builder" }); const g = s.call("mo", "ghost", { who: "vic", minutes: 30, reason: "trolling" });
      const look = s.call("vic", "look"), mv = s.call("vic", "move", { to: [1, 0, 1] }), lab = s.call("vic", "set", { id: "crate", component: "label", value: "x" }), say = s.call("vic", "say", { text: "hi" });
      const hist = s.call("vic", "history", { limit: 50 }); const sees = (hist.entries ?? []).some((e: any) => e.kind === "say");
      const bobHist = s.call("bob", "history", { limit: 50 }); const bobSees = (bobHist.entries ?? []).some((e: any) => e.kind === "say");
      return { g: show(g), look: show(look), mv: show(mv), lab: code(lab), say: code(say), sees, bobSees }; },
    good: (o) => o.g === "ok" && o.look === "ok" && o.mv === "ok" && o.lab === "ghost" && o.say === "ghost" && !o.sees && o.bobSees },
  { id: "G2", what: "ghost rank rules: only a rank above the target ghosts; a sanction is lifted at its author's rank or higher (not by the ghost themself), and ends by the clock", run(s) { cast(s, { crew: true });
      const bobG = s.call("bob", "ghost", { who: "vic", minutes: 5 }), moMo = s.call("mo", "ghost", { who: "olive", minutes: 5 });
      s.call("olive", "ghost", { who: "ann", minutes: 60 }); const moLift = s.call("mo", "unghost", { who: "ann" }), self = s.call("ann", "ghost", { on: false });
      s.call("mo", "ghost", { who: "vic", minutes: 5 }); const moLift2 = show(s.call("mo", "unghost", { who: "vic" }));
      s.call("mo", "ghost", { who: "bea", minutes: 5 }); s.advance(6 * MIN); const bea = show(s.call("bea", "say", { text: "back" }));
      return { bobG: code(bobG), moMo: code(moMo), moLift: code(moLift), self: code(self), moLift2, bea, ownerLift: show(s.call("olive", "unghost", { who: "ann" })) }; },
    good: (o) => o.bobG === "rights" && (o.moMo === "rights" || o.moMo === "rank") && o.moLift === "rank" && o.self === "ghost" && o.moLift2 === "ok" && o.bea === "ok" && o.ownerLift === "ok" },
  { id: "G3", what: "ghost as a chosen mode: anyone may ghost themself and come back; it is never logged; while a ghost they can't talk", run(s) { cast(s);
      const n0 = s.w().mod.length, e0 = s.entries().length; const on = s.call("vic", "ghost", { on: true }); const say = s.call("vic", "say", { text: "boo" });
      const off = s.call("vic", "ghost", { on: false }); const say2 = s.call("vic", "say", { text: "hello" });
      return { on: show(on), say: code(say), off: show(off), say2: show(say2), mod: s.w().mod.length - n0, logged: s.entries().slice(e0).filter((e: any) => e.verb === "ghost").length }; },
    good: (o) => o.on === "ok" && o.say === "ghost" && o.off === "ok" && o.say2 === "ok" && o.mod === 0 && o.logged === 0 },

  // ---------------- T: S5 translation ----------------
  { id: "T1", what: "translation: a v1 {builder, fly, gen} grant becomes roles:<id> {role, can: {fly, generate}}, and the effective set holds fly and generate", run() {
      const w = TV1.project({ roles: { olive: { role: "owner" }, alice: { role: "builder", fly: true, gen: true }, bo: { role: "visitor", fly: false } } });
      const key = Object.keys(w["@world"]).find((k) => k.startsWith("roles:") && k.includes("alice")); const id = key?.slice(6); const bo = Object.keys(w["@world"]).find((k) => k.includes("bo") && k.startsWith("roles:"));
      return { v: w["@world"][key], bo: w["@world"][bo], imported: Object.keys(w["@world"]).filter((k) => k.startsWith("imported:roles")), sw: RL.effectiveOf?.(w["@world"], id)?.permissions, tag: TV1.TRANSLATOR }; },
    good: (o) => o.v?.role === "builder" && o.v.can?.fly === true && o.v.can?.generate === true && !("gen" in o.v) && !("fly" in o.v) && !("fly" in (o.bo ?? {})) && o.imported.length === 0 && o.sw?.includes("fly") && o.sw?.includes("generate") && o.tag?.startsWith("eidoverse/translate-v1@") && +o.tag.split("@")[1] >= 7 },   // @4 brought fly → can.fly, @7 gen → can.generate
  { id: "T2", what: "the Commons (its v1 governance lines, the repo fixture or V1_COMMONS=<a v1 Commons log>, translated here): a stranger is still a builder and now builds and generates by its default-role can.generate; a guest is a visitor", run() {
      // PROTOCOL_COMMONS: an already-translated world log; else the v1 Commons translated in process (R 10-07: the Commons is
      // re-translated from its latest v1 log at merge time, so a saved translation would only test an older importer)
      // With neither, the repo's own fixture: the Commons' governance lines alone (its founder's grant, a builder's, and
      // the `*` gen grant), so the row always runs; the real log is an optional, louder test (V1_COMMONS=<its log.jsonl>).
      const commonsLog = process.env.PROTOCOL_COMMONS, v1f = process.env.V1_COMMONS ?? path.resolve(ENGINE, "tools/protocol/fixtures/v1-commons-shape.jsonl");
      if (!commonsLog && !fs.existsSync(v1f)) throw new Error(`T2: no Commons log at ${v1f} (V1_COMMONS)`);
      const st = commonsLog ? F.fold(F.readLog(fs.readFileSync(commonsLog)))
        : F.fold(TV1.translate(fs.readFileSync(v1f, "utf8").split("\n").filter((l: string) => l.trim()).map((l: string) => JSON.parse(l))).out);
      const e = D.effectiveIn?.(st, "u-aaaaaaaaaaaaaaaaaaaa"), g = D.effectiveIn?.(st, "u-bbbbbbbbbbbbbbbbbbbb", { anon: true });
      return { role: D.roleIn(st, "u-aaaaaaaaaaaaaaaaaaaa"), sw: e?.permissions, guest: g?.role }; },
    good: (o) => (o.role === "builder" && ["build", "editOthers", "scripts", "generate"].every((k) => o.sw?.includes(k)) && o.guest === "visitor") },

  // ---------------- P: S6 the person menu (pure) ----------------
  { id: "P1", what: "personActions: a visitor sees only Mention (a public @name; Message opened a DM tab until whisper was removed, R 10-18), for anyone", run() { const A = RL.personActions;
      const vis = { id: "v", rank: 0, permissions: [] }; return { a: A?.(vis, { id: "b", rank: 100, role: "builder" }).map((x: any) => x.id), b: A?.(vis, { id: "n", rank: -1, role: "none" }).map((x: any) => x.id) }; },
    good: (o) => JSON.stringify(o.a) === '["mention"]' && JSON.stringify(o.b) === '["mention"]' },
  { id: "P2", what: "personActions: a moderator acting on a builder gets warn, mute, kick, ghost, ban, role and history", run() {
      const mo = { id: "m", rank: 200, permissions: RL.BUILTIN?.moderator ? RL.PERMISSION_NAMES.filter((k: string) => RL.BUILTIN.moderator.can[k]) : [] };
      return { ids: RL.personActions?.(mo, { id: "b", rank: 100, role: "builder" }).map((x: any) => x.id), muted: RL.personActions?.(mo, { id: "b", rank: 100 }, { muted: true }).map((x: any) => x.id) }; },
    good: (o) => JSON.stringify(o.ids) === '["mention","warn","mute","kick","ghost","ban","role","history"]' && o.muted?.includes("unmute") && !o.muted?.includes("mute") },
  { id: "P3", what: "personActions: a moderator acting on a moderator gets no acts, and one dim line saying rank is why", run() {
      const mo = { id: "m", rank: 200, permissions: ["mute", "kick", "ban", "grantRoles"] };
      return RL.personActions?.(mo, { id: "m2", rank: 200, role: "moderator", name: "Moderator" }); },
    good: (o) => Array.isArray(o) && o.map((x: any) => x.id).join() === "mention,rank-line,history" && /moderator; you can't act on equal or higher ranks/.test(o[1].label) && o[1].dim },
  { id: "P4", what: "badges: none for a visitor, 'guest' for someone without an account, the role's name otherwise", run() { const B = RL.badgeOf;
      return { v: B?.({ role: "visitor" }), g: B?.({ role: "builder", anon: true }), o: B?.({ role: "owner", name: "Owner" }), c: B?.({ role: "crew", name: "Crew" }) }; },
    good: (o) => o.v === null && o.g?.text === "guest" && o.o?.text === "owner" && o.o.tone === "owner" && o.c?.text === "crew" && o.c.tone === "role" },

  // ---------------- F: the top-down review's findings (10-06), each red before its fix ----------------
  { id: "F1", what: "a junior owner can't re-affirm the founder to reset their seniority, then demote and ban them (review S0-1)", run(s) { cast(s);
      role(s, "jun", { role: "owner" });
      const reaff = set(s, "jun", "roles:olive", { role: "owner" }), demote = set(s, "jun", "roles:olive", { role: "visitor" }), ban = s.call("jun", "ban", { who: "olive" });
      const self = set(s, "jun", "roles:jun", { role: "owner", note: "me" }), down = set(s, "olive", "roles:jun", { role: "builder" });
      return { reaff: code(reaff), demote: code(demote), ban: code(ban), olive: eff(s, "olive")?.role, self: show(self), down: show(down) }; },
    good: (o) => o.reaff === "rights" && o.demote === "rights" && o.ban === "rights" && o.olive === "owner" && o.self === "ok" && o.down === "ok" },
  { id: "K4", what: "kept: seniority is the start of an owner's unbroken run: an owner demoted and made owner again is junior from then", run(s) { cast(s);
      role(s, "a1", { role: "owner" }); role(s, "a2", { role: "owner" });   // a1 senior to a2
      set(s, "olive", "roles:a1", { role: "builder" }); set(s, "olive", "roles:a1", { role: "owner" });   // a1's run restarts: now junior to a2
      return { a2demotesA1: show(set(s, "a2", "roles:a1", { role: "builder" })), a1demotesA2: code(set(s, "a1", "roles:a2", { role: "builder" })) }; },
    good: (o) => o.a2demotesA1 === "ok" || o.a1demotesA2 === "rights" },
  { id: "F3", what: "role none is below every member: it can't say, use a thing or build (review: none passed say and reaction use)", run(s) { cast(s);
      s.call("olive", "create", { id: "lamp", model: "table-lamp", components: { reactions: { on: { kind: "toggle", component: "t/light-on" } } }, place: { at: [0, 0] } });
      role(s, "nn", { role: "none" });
      return { say: code(s.call("nn", "say", { text: "hi" })), use: code(s.call("nn", "use", { id: "lamp", action: "on" })), look: show(s.call("nn", "look")), vicSay: show(s.call("vic", "say", { text: "hi" })), vicUse: show(s.call("vic", "use", { id: "lamp", action: "on" })) }; },
    good: (o) => o.say === "rights" && o.use === "rights" && o.look === "ok" && o.vicSay === "ok" && o.vicUse === "ok" },
  { id: "F4", what: "an owner in a fresh world generates (the world's assets) and flies; fly can be granted per person (review: gen/fly came from v1 by name)", run(s) { cast(s);
      return { pal: show(set(s, "olive", "assets:a", { name: "a", path: "store/a.glb" })), fly: eff(s, "olive")?.permissions.includes("fly"), give: show(role(s, "vic", { role: "visitor", can: { fly: true } })), vic: eff(s, "vic")?.permissions }; },
    good: (o) => o.pal === "ok" && o.fly === true && o.give === "ok" && o.vic?.includes("fly") },
  { id: "F5", what: "the founder editing their own entry (a note) doesn't make them junior: a co-owner still can't demote them", run(s) { cast(s);
      role(s, "jun", { role: "owner" }); const note = set(s, "olive", "roles:olive", { role: "owner", note: "founder" });
      return { note: show(note), demote: code(set(s, "jun", "roles:olive", { role: "visitor" })), olive: eff(s, "olive")?.role }; },
    good: (o) => o.note === "ok" && o.demote === "rights" && o.olive === "owner" },

  // ---------------- V: the independent review's findings (10-07), each red before its fix ----------------
  { id: "V1", what: "a weaker sanction never cancels a stronger one: a moderator's 0.0001-day ban, 1-minute voice mute, short ghost or kick under an owner's leaves the owner's in force", run(s) { cast(s);
      role(s, "ann2", { role: "visitor" }); role(s, "gh", { role: "visitor" }); role(s, "kk", { role: "visitor" });
      s.call("olive", "ban", { who: "vic" }); const b = s.call("mo", "ban", { who: "vic", days: 0.0001 });
      s.call("olive", "mute", { who: "ann", minutes: 10080 }); const m = s.call("mo", "mute", { who: "ann", minutes: 1, channels: ["voice"] });
      s.call("olive", "ghost", { who: "gh" }); s.call("mo", "ghost", { who: "gh", minutes: 0.01 });
      s.call("olive", "kick", { who: "kk", minutes: 60 }); s.call("mo", "kick", { who: "kk", minutes: 0.01 });
      const now0 = s.now(); const banUntil = D.banOf(s.w(), "vic")?.until ?? "never", kickLeft = (D.kickOf(s.w(), "kk")?.until ?? 0) - now0;   // while both are in force: the strongest is read
      s.advance(20_000);
      return { b: show(b), m: show(m), banUntil, kickLeft, banned: D.isBanned(s.w(), "vic"), annSay: code(s.call("ann", "say", { text: "hi" })), ghost: !!D.ghostOf(s.w(), "gh"), kicked: !!D.kickOf(s.w(), "kk") }; },
    good: (o) => o.banUntil === "never" && o.kickLeft > 50 * MIN && o.banned && o.annSay === "muted" && o.ghost && o.kicked },
  { id: "V1b", what: "a mute's channels are the union of every mute in force: a longer voice-only mute over a shorter chat mute keeps chat muted", run(s) { cast(s);
      s.call("olive", "mute", { who: "vic", minutes: 10, channels: ["chat"] }); s.call("mo", "mute", { who: "vic", minutes: 60, channels: ["voice"] });
      return { say: code(s.call("vic", "say", { text: "hi" })), ch: D.muteOf(s.w(), "vic")?.channels }; },
    good: (o) => o.say === "muted" && o.ch?.includes("chat") && o.ch?.includes("voice") },
  { id: "V2", what: "lifting needs the rights over every sanction in force: a moderator's unmute can't lift an owner's mute stacked under their own", run(s) { cast(s);
      s.call("olive", "mute", { who: "vic", minutes: 600 }); s.call("mo", "mute", { who: "vic", minutes: 5 });
      return { un: code(s.call("mo", "unmute", { who: "vic" })), still: !!D.muteOf(s.w(), "vic") }; },
    good: (o) => o.un === "rank" && o.still },
  { id: "V3", what: "a chat mute refuses every server say, `to` included (a door say with `to` is public, in the log); there is no private channel to ask on (whisper was removed, R 10-18)", run(s) { cast(s);
      s.call("mo", "mute", { who: "vic", minutes: 5, channels: ["chat"] });
      return { to: code(s.call("vic", "say", { text: "why?", to: "mo" })) }; },
    good: (o) => o.to === "muted" },
  { id: "V4", what: "a ghost can't sanction anyone (ghost {who} is not the chosen mode); a ghost may still end a ghost they chose", run(s) { cast(s);
      s.call("olive", "ghost", { who: "mo", minutes: 60 }); const g = s.call("mo", "ghost", { who: "vic", minutes: 60 });
      s.call("bob", "ghost", { on: true }); const back = s.call("bob", "ghost", { on: false });
      return { g: code(g), back: show(back) }; },
    good: (o) => o.g === "ghost" && o.back === "ok" },
  { id: "V5", what: "nobody lifts their own sanction (a muted builder holding mute can't unmute themself)", run(s) { cast(s);
      role(s, "bob", { role: "builder", can: { mute: true } }); s.call("mo", "mute", { who: "bob", minutes: 60 }); role(s, "mo", { role: "visitor" });
      return { self: code(s.call("bob", "unmute", { who: "bob" })), still: !!D.muteOf(s.w(), "bob") }; },
    good: (o) => o.self === "rank" && o.still },
  { id: "K5", what: "kept: a kicked or banned person's leave still settles (the server's departure sends it): their body is gone from presence", run(s) { cast(s);
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("mo", "kick", { who: "vic" });
      const l = s.call("vic", "leave"); return { l: show(l), body: !!s.w().presence.bodies.vic }; },
    good: (o) => o.l === "ok" && !o.body },
  { id: "V7", what: "a muted person's refused say isn't written to the public log (it would carry the text)", run(s) { cast(s);
      s.call("mo", "mute", { who: "vic", minutes: 5, channels: ["chat"] }); const n0 = s.entries().length; s.call("vic", "say", { text: "secret words" });
      return { leaked: JSON.stringify(s.entries().slice(n0)).includes("secret words") }; },
    good: (o) => o.leaked === false },
  { id: "V8", what: "look doesn't list a ghost's body to anyone else (unseen); the ghost still sees their own", run(s) { cast(s);
      s.call("vic", "move", { to: [0, 0, 1] }); s.call("bob", "move", { to: [1, 0, 1] }); s.call("vic", "ghost", { on: true });
      return { bob: (s.call("bob", "look").bodies ?? []).map((b: any) => b.id), vic: (s.call("vic", "look").bodies ?? []).map((b: any) => b.id) }; },
    good: (o) => !o.bob.includes("vic") && o.bob.includes("bob") && o.vic.includes("vic") },
  { id: "V9", what: "a custom role's rank is range-checked when read: a rank written around the authority (300) never reads above the owner", run() {
      return { r: RL.roleDef ? RL.roleDef({ "role-defs": { boss: { name: "Boss", rank: 300 } } }, "boss") : "no roles.js" }; },
    good: (o) => o.r === null },
  { id: "V10", what: "a junior owner's script can't write a senior owner's role (seniority binds a capability by its holder)", run(s) { cast(s);
      role(s, "jun", { role: "owner" });
      const up = s.call("jun", "upload", { text: "export default (world, e) => { world.set('@world', 'roles:olive', { role: 'visitor' }); }" });
      const ins = s.call("jun", "set", { id: "@world", component: "script:coup", value: { src: up.src, scope: { ids: ["@world"], comps: ["roles:*"] }, on: ["use"] } });
      s.call("jun", "set", { id: "@world", component: "reactions", value: { coup: { kind: "set", component: "roles:olive", value: { role: "visitor" } } } });
      const use = s.call("vic", "use", { id: "@world", action: "coup" });
      return { use: code(use) ?? show(use), olive: eff(s, "olive")?.role }; },
    good: (o) => o.olive === "owner" },
  { id: "V11", what: "an exception is cleared by sending it as null in a merge (what the Exceptions form sends); the others stay", run(s) { cast(s);
      role(s, "bob", { role: "builder", can: { fly: true, generate: true }, note: "keep me" });
      const r = s.call("olive", "set", { id: "@world", component: "roles:bob", value: { can: { generate: true, fly: null } }, merge: true });
      const v = s.w().state().entities["@world"].c["roles:bob"]; return { r: show(r), can: v?.can, note: v?.note, sw: eff(s, "bob")?.permissions }; },
    good: (o) => o.r === "ok" && JSON.stringify(o.can) === '{"generate":true}' && o.note === "keep me" && !o.sw?.includes("fly") && o.sw?.includes("generate") }
];

// ---------------- run ----------------
let pass = 0, fail = 0;
for (const c of cases) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let o: any, good = false;
  try { o = c.run(session()); good = !!c.good(o); } catch (e: any) { o = { threw: `${e?.constructor?.name}: ${e?.message}`.slice(0, 300) }; }
  if (good) pass++; else fail++;
  console.log(`${good ? "ok  " : "FAIL"} ${c.id.padEnd(4)} ${c.what}${good && !argv.includes("--verbose") ? "" : `\n       ${String(JSON.stringify(o)).slice(0, 700)}`}`);
}
console.log(`[roles-check] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
