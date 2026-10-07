// tools/v4/modserver-mutants.ts — the server half of roles + moderation (research roles S4; PLAN ghost), proven by
// mutation: each server-side gate is removed in a copy of the tree, identity-check runs there, and the RS case that
// names the gate must go red (the rest must stay green: a mutant that breaks everything proves nothing). A no-op
// control must leave every case green. Not covered here: releasing a gone person's SFU mute (server.ts sanctionSweep)
// matters only while OTHER people's real voice legs keep the world's SFU state alive; these sockets hold no WebRTC leg.   usage: bun tools/v4/modserver-mutants.ts [--only <substring>]
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";

const M: [string, string, string, string, string[]][] = [
  ["your-rights from the door", "server/server.ts", "const e = w.v4.rightsOf(c.v4id); const g =", "const e = { role: w.v4.roleOf(c.v4id), name: \"\", rank: 0, switches: [] as string[] }; const g =", ["RS1"]],
  ["voice-moderate names a present identity", "server/server.ts", "const target = typeof msg.v4id === \"string\" ? msg.v4id : [...w.clients].find((t) => t.id === String(msg.id ?? \"\") && (t.surface ?? \"world\") === \"world\" && !t.spectator)?.v4id;", "const target = String(msg.id ?? \"\");", ["RS2"]],
  ["a ghost is deafened at the SFU", "server/server.ts", "try { setSfuDeafened(w.name, c.id, ghost); }", "try { void 0; }", ["RS4"]],
  ["a voice mute is applied at the SFU", "server/server.ts", "try { setSfuModeratorMute(w.name, c.id, voice); }", "try { void 0; }", ["RS2"]],
  ["a voice mute is re-applied on join", "server/server.ts", "if (w.v4) sanctionSweep(w);   // a voice mute in force is re-applied on join", "if (false) sanctionSweep(w);   // a voice mute in force is re-applied on join", ["RS2"]],
  ["a kick's cooldown at join", "server/server.ts", "      if (k) { const mins = Math.max(1,", "      if (false) { const mins = Math.max(1,", ["RS3"]],
  ["a ghost's frames are withheld", "server/server.ts", "poses: Object.fromEntries(hidden?.size ? [...w.dirty].filter(([id]) => !hidden.has(id)) : w.dirty)", "poses: Object.fromEntries(w.dirty)", ["RS4"]],
  ["a ghost leaves others' view", "server/server.ts", "if (ghost) { for (const t of w.clients) if (t !== c) { try { t.ws.send(JSON.stringify({ type: \"leave\", id: c.id })); } catch { /* gone */ } } w.scripts.onPresence(\"leave\", c.id, c.v4id); }", "if (ghost) { }", ["RS4"]],
  ["a ghost reads no chat (the log)", "server/world.ts", "c.ws.send(c.v4id && (S[c.v4id] as any)?.ghost ? g : d);", "c.ws.send(d);", ["RS4"]],
  ["a ghost reads no chat (the window)", "server/server.ts", "state: w.isGhost(c) ? { recentChat: [], chatTotal: 0 } :", "state: false ? { recentChat: [], chatTotal: 0 } :", ["RS4"]],
  ["a ghost isn't listed to joiners", "server/server.ts", "filter(o => o !== c && !o.spectator && !w.isGhost(o))", "filter(o => o !== c && !o.spectator)", ["RS4"]],
  ["a warning reaches its person", "server/v4/messages.ts", "const notice = tool === \"warn\" ?", "const notice = false ?", ["RS5"]],
  ["mod-state badges", "server/server.ts", "if (w.modStateKey !== key) {", "if (false) {", ["RS5"]],
  ["access: listed", "server/server.ts", "acc.join === \"listed\" && !w.v4.listedHere(c.v4id)", "false", ["RS6"]],
  ["access: the moderator bypass", "server/server.ts", "if (acc && !accessBypass(w, c.v4id)) {", "if (acc) {", ["RS6"]],
  // the independent review (10-07)
  ["whispers: a muted person reaches only moderators", "server/messages.ts", "if (!mod) { ws.send(JSON.stringify({ type: \"error\", error: `you're muted", "if (false) { ws.send(JSON.stringify({ type: \"error\", error: `you're muted", ["RS8"]],
  ["whispers: never to a ghost", "server/messages.ts", "&& !(v4 && c.world.isGhost(o)));", ");", ["RS8"]],
  ["whispers: never from a ghost", "server/messages.ts", "if (v4.ghostHere(c.v4id) || v4.rightsOf(c.v4id).role === \"none\") {", "if (false) {", ["RS8"]],
  ["a ghost's history message is empty", "server/messages.ts", "if (c.world.v4 && c.world.isGhost(c)) { ws.send(JSON.stringify({ type: \"history\"", "if (false) { ws.send(JSON.stringify({ type: \"history\"", ["RS9"]],
  ["presence messages from a ghost are dropped", "server/server.ts", "if (h && !gagged(c, String(msg.type)))", "if (h)", ["RS9"]],
  ["the ban list is for moderation holders", "server/messages.ts", "if (!e || !(e.role === \"owner\" ||", "if (false && !(e.role === \"owner\" ||", ["RS9"]],
  ["a guest's kick names its address", "server/v4/messages.ts", "          if (t.anonymous && t.addr) {", "          if (false) {", ["RS9"]],
  ["reset is the most senior owner's", "server/v4/messages.ts", "if (w.v4.seniorOwner() !== actorOf(c)) return err(", "if (false) return err(", ["RS7"]],
  ["forks are rate-limited", "server/v4/messages.ts", "if (now - last < FORK_GAP_MS) return err(", "if (false) return err(", ["RS7"]],
  // a guest's mute and ghost by address; minimum account age (R 10-07)
  ["a guest's sanction is carried to the next guest at join", "server/server.ts", "for (const s of addrSanctionsFor(w.name, c.addr)) {", "for (const s of [] as any[]) {", ["GG1", "GG3"]],
  ["a guest's mute or ghost is filed against the address", "server/v4/messages.ts", "for (const addr of addrs) fileAddrSanction(", "for (const addr of [] as string[]) fileAddrSanction(", ["GG1", "GG3", "GG5"]],
  ["the voice control's mute files it too", "server/server.ts", "guestSanctionByAddress(w, v4ActorOf(c), c.id, muted ?", "void (w, v4ActorOf(c), c.id, muted ?", ["GG5"]],
  ["unmute / unghost lift the address record", "server/v4/messages.ts", "if (verb.startsWith(\"un\")) { liftAddrSanction(kind, w.name, who, addrs[0]); return; }", "if (verb.startsWith(\"un\")) { return; }", ["GG2", "GG4"]],
  ["access: minimum account age", "server/server.ts", "accountAgeRefusal({ world: w.name, minDays: acc.minAccountDays,", "accountAgeRefusal({ world: w.name, minDays: 0 && acc.minAccountDays,", ["AG3", "AG4"]],
  ["minAccountDays: a guest is refused", "server/v4/accountage.ts", "if (anonymous || !account) return rule;", "if (false) return rule;", ["AG2", "AG4"]],
  ["minAccountDays: agents are exempt", "server/v4/accountage.ts", "if (/^(agent:|aid1:|local:)/.test(account)) return null;", "", ["AG2", "AG4"]],
  ["minAccountDays: 0–365", "shared/v4/catalogue.js", "minAccountDays: { min: 0, max: 365 }", "minAccountDays: { min: -9999 }", ["AG5"]],
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
  const r = Bun.spawnSync(["bun", path.join(d, "tools/v4/identity-check.ts")], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  const out = r.stdout.toString() + r.stderr.toString();
  const reds = [...new Set([...out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]))];
  // the named cases must go red; others may too (a gate can be covered twice), and are printed so a mutant that breaks
  // everything shows as one
  const good = want.length ? want.every((c) => reds.includes(c)) : r.exitCode === 0;
  if (!good) bad++;
  console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${reds.join(",") || "(none)"} (want ${want.join(",") || "none"})`);
}
console.log(`[modserver-mutants] ${bad} wrong`); process.exit(bad ? 1 : 0);
