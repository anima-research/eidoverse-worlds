// tools/protocol/migrate-identities.ts — move an existing engine world from name identities to directory ids (round-2
// review R1), and seal it (R3). For the worlds founded or translated before b1ec40b1; a fresh translation does this
// itself. Run with the world's server STOPPED (it holds the old log in memory).
//   - ONE map from each legacy identity to one id, applied everywhere a person is named: every actor, every
//     roles:/imported-bans: key, a say's `to`, an act's capability.author and sponsor, and every record of the moderator
//     log (world.mod.jsonl: who and actor). A role value's `sub` binds that NAME to its account first, so the person's
//     acts land on the id they sign in as; otherwise a reserved agent name -> agent:<slug>; with --trust-names (a
//     PRIVATE server that runs TRUST_NAMES=1) a bare name -> local:<name>, the account a join there gets; otherwise a
//     legacy identity an operator binds later. An escaped name (x--…) is read back first. The `sub` moves into the
//     directory. The authority's own actors (system, world, sim), script:<entity> actors, ids already minted and a
//     guest's address (addr:…) are left as they are. Act requests (as sent) are left as written.
//   - then the whole log is sealed with this server's keys: a salt on every set and act/say/sim body, {head, sig} on
//     every entry after genesis. Genesis and the world id don't change.
// SAFETY: written only if a gate that reads the two logs side by side (never the map that wrote them) agrees: every
// legacy identity became exactly one id, everyone left alone stayed themselves, nobody is still named by a legacy name,
// each role's account is held by the id its role went to, and the old fold with the role/ban keys renamed as the logs
// show IS the new fold (digest); the reference reader says ok with 0 malformed; chain.py verifies every head. The old
// logs are kept beside them as world.jsonl.before-identities (and world.mod.jsonl.before-identities). A world that
// already has that backup, or names nobody by a legacy name, is refused: a second run would overwrite the only way
// back. The directory learns the new ids before the logs name them. Dry run without --apply.
// usage: bun tools/protocol/migrate-identities.ts [--apply] [--trust-names] <world dir>…
import fs from "node:fs";
import path from "node:path";
import { readLog, fold, digest } from "../../shared/protocol/fold.js";
import { seal } from "../../shared/protocol/authority.js";
import { dec } from "../../shared/protocol/names.js";
import { directoryFor, mintId, type Entry } from "../../server/directory.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { custodyFileIn } from "../../server/keyfiles.ts";
import { agentTokens } from "../../server/auth.ts";
import { ENGINE } from "./common.ts";

const apply = process.argv.includes("--apply"), trust = process.argv.includes("--trust-names");
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SYSTEM = new Set(["system", "world", "sim"]);
const isMinted = (s: string) => /^u-[a-z2-7]{20}$/.test(s);
// who is left as they are: not a person this migration names
const keeps = (s: string) => SYSTEM.has(s) || isMinted(s) || s.startsWith("script:") || s.startsWith("addr:");
const PERSON_KEY = /^(roles|imported-bans):(.+)$/;
const agents = agentTokens().names;
const PY = process.env.PYTHON || "python3";
const out: Record<string, unknown>[] = [];
for (const dir of dirs) {
  const f = path.join(dir, "world.jsonl"), mf = path.join(dir, "world.mod.jsonl");
  const backups = [f, mf].map((x) => x + ".before-identities");
  if (backups.some((b) => fs.existsSync(b))) { out.push({ dir, skipped: `a migration's backup is already here (${backups.filter((b) => fs.existsSync(b)).map((b) => path.basename(b)).join(", ")}): this world was migrated. A second run would overwrite the only way back; to run it again, restore the backup by hand first` }); continue; }
  const raw = fs.readFileSync(f);
  const old = readLog(raw); const oldSt = fold(old);
  if (oldSt.status !== "ok") { out.push({ dir, skipped: `folds to ${oldSt.status}` }); continue; }
  const oldMod: any[] = modLogAt(mf).mod;
  const worlds = path.dirname(path.resolve(dir));
  const directory = directoryFor(worlds); const cust = custodyAt(custodyFileIn(worlds));
  if (cust.sequencer() !== old[0].body.sequencer) { out.push({ dir, skipped: "this worlds dir's custody doesn't hold the world's sequencer key" }); continue; }
  // the accounts a role value names, by the person's NAME (a later value wins; the world's final roles last)
  const acctOf = new Map<string, string>();
  const noteSub = (comp: unknown, v: any) => { const m = /^roles:(.+)$/.exec(typeof comp === "string" ? comp : ""); if (m && typeof v?.sub === "string") acctOf.set(dec(m[1]) ?? m[1], v.sub); };
  for (const e of old.slice(1) as any[]) if (e?.kind === "change") for (const o of e.verb === "batch" ? e.body?.ops ?? [] : [{ ...e.body }]) if (o?.id === "@world") noteSub(o.comp, o.value);
  for (const [c, v] of Object.entries<any>(oldSt.entities["@world"]?.c ?? {})) noteSub(c, v);
  const planned: Record<string, Entry> = {}; const memo = new Map<string, string>(); let renamed = 0;
  const who = (k: string): string => {
    if (keeps(k)) return k;
    renamed++;
    const name = dec(k) ?? k;
    const acct = acctOf.get(name) ?? (agents.has(name.toLowerCase()) ? `agent:token:${name.toLowerCase()}` : trust ? `local:${name.toLowerCase()}` : undefined);
    const key = acct ?? `name:${name}`; let id = memo.get(key) ?? (acct ? directory.idOfSub(acct) : null);
    if (!id) { id = mintId(); planned[id] = { name, subs: acct ? [acct] : [], kind: acct ? "account" : "imported", since: Date.now() }; }
    memo.set(key, id); return id; };
  const keyOf = (comp: string) => { const m = PERSON_KEY.exec(comp ?? ""); return m ? `${m[1]}:${who(m[2])}` : comp; };
  const valOf = (comp: string, v: any) => (PERSON_KEY.test(comp ?? "") && v && typeof v === "object" && "sub" in v ? (({ sub, ...r }) => r)(v) : v);
  const op = (o: any) => ({ ...o, ...(o.comp !== undefined ? { comp: keyOf(o.comp) } : {}), ...("value" in o ? { value: valOf(o.comp, o.value) } : {}) });
  const next = old.map((e0: any, i: number) => { const e = JSON.parse(JSON.stringify(e0)); if (i === 0) return e; delete e.head; delete e.sig;
    if (typeof e.actor === "string") e.actor = who(e.actor);
    if (e.kind === "change") e.body = e.verb === "batch" ? { ...e.body, ops: e.body.ops.map(op) } : (({ verb, ...b }) => b)(op({ verb: e.verb, ...e.body }));
    if (e.kind === "say" && typeof e.body?.to === "string") e.body.to = who(e.body.to);
    if (e.kind === "act" && typeof e.body?.capability?.author === "string") e.body.capability.author = who(e.body.capability.author);
    if (e.kind === "act" && typeof e.body?.sponsor === "string") e.body.sponsor = who(e.body.sponsor);
    if (e.kind === "act" || e.kind === "say" || e.kind === "sim") delete e.body?.salt;   // re-salted by seal
    return e; });
  const nextMod = oldMod.map((m) => ({ ...m, ...(typeof m.who === "string" ? { who: who(m.who) } : {}), ...(typeof m.actor === "string" ? { actor: who(m.actor) } : {}) }));
  if (!renamed) { out.push({ dir, skipped: "nobody here is named by a legacy identity: already in directory ids, nothing to migrate" }); continue; }
  const sealed = seal(next, { sign: (m: string) => cust.sign(m) });
  const text = sealed.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
  const newSt = fold(readLog(text));
  // ---- the gate: the old and new logs read side by side, never through who()/keyOf (nor keeps: its own list) ----
  const leftAlone = (s: string) => /^(system|world|sim)$|^u-[a-z2-7]{20}$|^script:|^addr:/.test(s);
  const pairs = new Map<string, string>(); const problems: string[] = [];
  const pair = (a: unknown, b: unknown, where: string) => { if (typeof a !== "string") return; if (typeof b !== "string") { problems.push(`${where}: ${a} became ${JSON.stringify(b)}`); return; }
    const was = pairs.get(a); if (was !== undefined && was !== b) problems.push(`${a} became two ids (${was}, ${b}) (${where})`); else pairs.set(a, b); };
  const opsOf = (e: any) => (e?.kind !== "change" ? [] : e.verb === "batch" ? e.body?.ops ?? [] : [e.body]);
  for (let i = 1; i < old.length; i++) { const a: any = old[i], b: any = sealed[i];
    pair(a.actor, b.actor, `entry ${i} actor`);
    if (a.kind === "say") pair(a.body?.to, b.body?.to, `entry ${i} say.to`);
    if (a.kind === "act") { pair(a.body?.capability?.author, b.body?.capability?.author, `entry ${i} capability.author`); pair(a.body?.sponsor, b.body?.sponsor, `entry ${i} sponsor`); }
    const ao = opsOf(a), bo = opsOf(b);
    ao.forEach((o: any, j: number) => { const ma = PERSON_KEY.exec(o?.comp ?? ""); if (!ma) return; const mb = PERSON_KEY.exec(bo[j]?.comp ?? "");
      if (!mb || mb[1] !== ma[1]) problems.push(`entry ${i} op ${j}: ${o.comp} became ${bo[j]?.comp}`); else pair(ma[2], mb[2], `entry ${i} ${ma[1]}: key`); }); }
  oldMod.forEach((m, k) => { pair(m.who, nextMod[k].who, `moderator record ${k} who`); pair(m.actor, nextMod[k].actor, `moderator record ${k} actor`); });
  for (const [a, b] of pairs) {
    if (leftAlone(a) && a !== b) problems.push(`${a} should have been left as it was but became ${b}`);
    if (!leftAlone(a) && !/^u-[a-z2-7]{20}$/.test(b)) problems.push(`${a} is still named by a legacy identity (${b})`); }
  // a role's account is held by the id its role went to (the id the person signs in as holds their role)
  for (const [c, v] of Object.entries<any>(oldSt.entities["@world"]?.c ?? {})) { const m = /^roles:(.+)$/.exec(c); if (!m || typeof v?.sub !== "string") continue;
    const id = pairs.get(m[1]); const holds = id && (planned[id]?.subs.includes(v.sub) || directory.idOfSub(v.sub) === id);
    if (!holds) problems.push(`roles:${m[1]}'s account ${v.sub} isn't held by its new id ${id}`); }
  const want = JSON.parse(JSON.stringify(oldSt)); const w = want.entities["@world"];
  if (w) w.c = Object.fromEntries(Object.entries<any>(w.c).map(([c, v]) => { const m = PERSON_KEY.exec(c); return m ? [`${m[1]}:${pairs.get(m[2]) ?? m[2]}`, PERSON_KEY.test(c) && v && typeof v === "object" && "sub" in v ? (({ sub, ...r }) => r)(v) : v] : [c, v]; }));
  const tmp = f + ".id-tmp", mtmp = mf + ".id-tmp"; fs.writeFileSync(tmp, text);
  if (nextMod.length) fs.writeFileSync(mtmp, nextMod.map((m) => JSON.stringify(m)).join("\n") + "\n");
  const py = (args: string[]) => { try { return JSON.parse(Bun.spawnSync([PY, "-B", ...args]).stdout.toString()); } catch { return {}; } };
  const rd = py([path.join(ENGINE, "spec/conformance/reader.py"), tmp, "--json"]), ch = py([path.join(ENGINE, "spec/conformance/chain.py"), "verify", tmp]);
  const malformed = (rd.diagnostics ?? []).filter((d: any) => String(d?.[1] ?? "").startsWith("malformed")).length;
  // (a JSON copy loses the fold's PURGED sentinel, so a world with purges is refused here rather than misjudged)
  const purged = old.some((e: any) => e?.kind === "purge");
  const same = !purged && !problems.length && newSt.status === "ok" && digest(newSt) === digest(want);
  const good = same && rd.status === "ok" && !malformed && ch.status === "ok" && ch.unsigned_tail === 0;
  if (good && apply) {
    // the backups first (never over an existing one), then the directory: the ids exist before any log names them
    fs.copyFileSync(f, backups[0], fs.constants.COPYFILE_EXCL);
    if (nextMod.length) fs.copyFileSync(mf, backups[1], fs.constants.COPYFILE_EXCL);
    directory.put(planned);
    if (process.env.MIGRATE_IDENTITIES_DIE_BEFORE_LOGS) process.exit(9);   // tests only: a crash between the directory and the logs (migrate-identities-check MI6)
    if (nextMod.length) fs.renameSync(mtmp, mf);
    fs.renameSync(tmp, f);
  } else { fs.rmSync(tmp, { force: true }); fs.rmSync(mtmp, { force: true }); }
  out.push({ dir, entries: old.length, moderation: oldMod.length, identities: Object.keys(planned).length, same, problems: problems.slice(0, 8), reader: rd.status, malformed, chain: ch.status, written: good && apply,
    people: Object.values(planned).map((p) => `${p.name}${p.subs.length ? ` (${p.subs[0].split(":")[0]})` : " (legacy)"}`) });
}
for (const o of out) console.log(JSON.stringify(o));
process.exit(out.every((o: any) => o.skipped || o.written || (!apply && o.same)) ? 0 : 1);
