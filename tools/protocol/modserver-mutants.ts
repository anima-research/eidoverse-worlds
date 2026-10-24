// tools/protocol/modserver-mutants.ts — the server half of roles + moderation (research roles S4), proven by
// mutation: each server-side gate is removed in a copy of the tree, identity-check runs there, and the RS case that
// names the gate must go red (the rest must stay green: a mutant that breaks everything proves nothing). A no-op
// control must leave every case green. Not covered here: releasing a gone person's SFU mute (server.ts sanctionSweep)
// matters only while OTHER people's real voice legs keep the world's SFU state alive; these sockets hold no WebRTC leg.   usage: bun tools/protocol/modserver-mutants.ts [--only <substring>]
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const M: [string, string, string, string, string[]][] = [
  ["your-rights from the authority", "server/server.ts", "const e = w.log.rightsOf(c.actorId); const m =", "const e = { role: w.log.roleOf(c.actorId), name: \"\", rank: 0, permissions: [] as string[] }; const m =", ["RS1"]],
  ["voice-moderate names a present identity", "server/server.ts", "const target = typeof msg.actorId === \"string\" ? msg.actorId : [...w.clients].find((t) => t.id === String(msg.id ?? \"\") && (t.surface ?? \"world\") === \"world\" && !t.spectator)?.actorId;", "const target = String(msg.id ?? \"\");", ["RS2"]],
  ["a voice mute is applied at the SFU", "server/server.ts", "try { setSfuModeratorMute(w.name, c.id, voice); }", "try { void 0; }", ["RS2"]],
  ["a voice mute is re-applied on join", "server/server.ts", "if (w.log) sanctionSweep(w);   // a voice mute in force is re-applied on join", "if (false) sanctionSweep(w);   // a voice mute in force is re-applied on join", ["RS2"]],
  ["a kick's cooldown at join", "server/server.ts", "      if (k) { const mins = Math.max(1,", "      if (false) { const mins = Math.max(1,", ["RS3"]],
  ["no backscroll on join", "server/server.ts", "state: { recentChat: [], chatTotal:", "state: { recentChat: w.state.recentChat ?? [], chatTotal:", ["RS10"]],
  ["a warning reaches its person", "server/requestwire.ts", "const notice = tool === \"warn\" ?", "const notice = false ?", ["RS5"]],
  ["mod-state badges", "server/server.ts", "if (w.modStateKey !== key) {", "if (false) {", ["RS5"]],
  ["access: listed", "server/server.ts", "acc.join === \"listed\" && !w.log.listedHere(c.actorId)", "false", ["RS6"]],
  ["access: the moderator bypass", "server/server.ts", "if (acc && !accessBypass(w, c.actorId)) {", "if (acc) {", ["RS6"]],
  // the independent review (10-07)
  // whisper removed (R 10-18): the door's refusal and the authority's
  ["the removed whisper message says so", "server/messages.ts", "refused: { code: \"removed\",", "refused: { code: \"unknown\",", ["RS8"]],
  ["a whisper request is refused as removed", "shared/protocol/authority.js", "if (!h && Object.hasOwn(REMOVED_VERBS, verb)) refuse(\"removed\"", "if (false) refuse(\"removed\"", ["RS8"]],
  // speech is arrival-only (R 10-18)
  ["the history message has an arrival floor", "server/messages.ts", "floor: c.world.sayFloorFor(c),", "floor: null,", ["RS10"]],
  ["the authority's history has an arrival floor", "shared/protocol/authority/blueprints.js", "const floor = typeof w.sayFloor === \"function\" ? w.sayFloor(actor) : null;", "const floor = null;", ["RS10"]],
  ["a moderator is not an admin", "server/world.ts", "isAdmin(c: Client): boolean { return isOperator(c.account) || (!!c.actorId && this.log.may(c.actorId, \"readChat\")); }", "isAdmin(c: Client): boolean { return isOperator(c.account) || (!!c.actorId && [\"owner\", \"moderator\"].includes(this.log.roleOf(c.actorId))); }", ["RS10", "RS10b"]],
  ["an owner reads the master log", "server/world.ts", "if (this.isAdmin(c)) return null; if (Number.isInteger", "if (false) return null; if (Number.isInteger", ["RS10"]],
  // RETIRED 10-20: "presence messages from a role-less (none) person are dropped" — RS9's ghost half tested it; no row does now (BUG-HUNT gap)
  ["the ban list is for moderation holders", "server/messages.ts", "if (!e || !(isOwner(e) ||", "if (false && !(isOwner(e) ||", ["RS9"]],
  ["a guest's kick names its address", "server/requestwire.ts", "          if (t.anonymous && t.addr) {", "          if (false) {", ["RS9"]],
  ["reset is the most senior owner's", "server/requestwire.ts", "if (w.log.seniorOwner() !== actorOf(c)) return err(", "if (false) return err(", ["RS7"]],
  ["forks are rate-limited", "server/requestwire.ts", "if (now - last < FORK_GAP_MS) return err(", "if (false) return err(", ["RS7"]],
  // a guest's mute by address; minimum account age (R 10-07)
  ["a guest's sanction is carried to the next guest at join", "server/server.ts", "for (const s of addrSanctionsFor(w.name, c.addr)) {", "for (const s of [] as any[]) {", ["GG1", "GG5"]],
  ["a guest's mute is filed against the address", "server/requestwire.ts", "for (const addr of addrs) fileAddrSanction(", "for (const addr of [] as string[]) fileAddrSanction(", ["GG1", "GG5"]],
  ["the voice control's mute files it too", "server/server.ts", "guestSanctionByAddress(w, actorIdOf(c), c.id, muted ?", "void (w, actorIdOf(c), c.id, muted ?", ["GG5"]],
  ["unmute lifts the address record", "server/requestwire.ts", "if (verb.startsWith(\"un\")) { liftAddrSanction(kind, w.name, who, addrs[0]); return; }", "if (verb.startsWith(\"un\")) { return; }", ["GG2", "GG5"]],
  ["access: minimum account age", "server/server.ts", "accountAgeRefusal({ world: w.name, minDays: acc.minAccountDays,", "accountAgeRefusal({ world: w.name, minDays: 0 && acc.minAccountDays,", ["AG3", "AG4"]],
  ["minAccountDays: a guest is refused", "server/accountage.ts", "if (anonymous || !account) return rule;", "if (false) return rule;", ["AG2", "AG4"]],
  ["minAccountDays: agents are exempt", "server/accountage.ts", "if (/^(agent:|aid1:|local:)/.test(account)) return null;", "", ["AG2", "AG4"]],
  ["minAccountDays: 0–365", "shared/protocol/componentspec.js", "minAccountDays: { min: 0, max: 365 }", "minAccountDays: { min: -9999 }", ["AG5"]],
  ["CONTROL (no-op)", "server/server.ts", "/** Does this identity hold a power that lets it in past access rules", "/** Does this identity hold  a power that lets it in past access rules", []],
];
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
let bad = 0;
for (const [name, file, find, repl, want] of M) {
  if (only && !name.includes(only)) continue;
  const d = scratch("msmut");
  for (const sub of ["shared", "server", "tools", "defs", "client", "mcpl", "assets"]) if (fs.existsSync(path.join(ENGINE, sub)))
    fs.cpSync(path.join(ENGINE, sub), path.join(d, sub), { recursive: true, filter: (p) => !p.includes("node_modules") });
  for (const f of ["package.json", "tsconfig.json", "bunfig.toml"]) if (fs.existsSync(path.join(ENGINE, f))) fs.copyFileSync(path.join(ENGINE, f), path.join(d, f));
  fs.symlinkSync(fs.realpathSync(path.join(ENGINE, "node_modules")), path.join(d, "node_modules"));
  const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
  if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': text not found exactly once in ${file}`); continue; }
  fs.writeFileSync(f, src.replace(find, repl));
  const r = Bun.spawnSync(["bun", path.join(d, "tools/protocol/identity-check.ts")], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const out = r.stdout.toString() + r.stderr.toString();
  const reds = [...new Set([...out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]))];
  // the named cases must go red; others may too (a gate can be covered twice), and are printed so a mutant that breaks
  // everything shows as one
  const good = want.length ? want.every((c) => reds.includes(c)) : r.exitCode === 0;
  if (!good) bad++;
  console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${reds.join(",") || "(none)"} (want ${want.join(",") || "none"})`);
}
console.log(`[modserver-mutants] ${bad} wrong`); process.exit(bad ? 1 : 0);
