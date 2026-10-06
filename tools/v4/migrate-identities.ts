// tools/v4/migrate-identities.ts — move an existing engine v4 world from name identities to directory ids (round-2
// review R1), and seal it (R3). For the worlds founded or translated before b1ec40b1; a fresh translation does this
// itself. Run with the world's server STOPPED (it holds the old log in memory).
//   - every actor and every roles:/bans: key that names a person becomes an opaque id from the door directory
//     (<worlds dir>/.v4-directory.json). The account: a reserved agent name -> agent:<slug>; with --trust-names (a
//     PRIVATE server that runs TRUST_NAMES=1) a bare name -> local:<name>, the account a join there gets; otherwise a
//     legacy identity an operator binds later. An escaped name (x--…) is read back first. A `sub` in a role value
//     moves into the directory. A say's `to` follows its person. Act bodies (requests as sent) are left as written.
//   - then the whole log is sealed with this door's keys: a salt on every set and act/say/sim body, {head, sig} on
//     every entry after genesis. Genesis and the world id don't change.
// SAFETY: written only if the fold of the new log equals the fold of the old one with the same role/ban keys renamed
// (digest), the reference reader says ok with 0 malformed, and chain.py verifies every head. The old log is kept
// beside it as v4.jsonl.before-identities. Dry run without --apply.
// usage: bun tools/v4/migrate-identities.ts [--apply] [--trust-names] <world dir>…
import fs from "node:fs";
import path from "node:path";
import { readLog, fold, digest } from "../../shared/v4/fold.js";
import { seal } from "../../shared/v4/door.js";
import { dec } from "../../shared/v4/names.js";
import { directoryFor, mintId, type Entry } from "../../server/v4/directory.ts";
import { custodyAt } from "../../server/v4/custody.ts";
import { agentTokens } from "../../server/auth.ts";
import { ENGINE } from "./common.ts";

const apply = process.argv.includes("--apply"), trust = process.argv.includes("--trust-names");
const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const SYSTEM = new Set(["door", "world", "sim"]);
const isMinted = (s: string) => /^u-[a-z2-7]{20}$/.test(s);
const agents = agentTokens().names;
const out: Record<string, unknown>[] = [];
for (const dir of dirs) {
  const f = path.join(dir, "v4.jsonl"); const raw = fs.readFileSync(f);
  const old = readLog(raw); const oldSt = fold(old);
  if (oldSt.status !== "ok") { out.push({ dir, skipped: `folds to ${oldSt.status}` }); continue; }
  const worlds = path.dirname(path.resolve(dir));
  const directory = directoryFor(worlds); const cust = custodyAt(path.join(worlds, ".v4-custody.json"));
  if (cust.sequencer() !== old[0].body.sequencer) { out.push({ dir, skipped: "this worlds dir's custody doesn't hold the world's sequencer key" }); continue; }
  const planned: Record<string, Entry> = {}; const memo = new Map<string, string>();
  const who = (k: string, sub?: string): string => {
    if (SYSTEM.has(k) || isMinted(k)) return k;
    const name = dec(k) ?? k;
    const acct = sub ?? (agents.has(name.toLowerCase()) ? `agent:token:${name.toLowerCase()}` : trust ? `local:${name.toLowerCase()}` : undefined);
    const key = acct ?? `name:${name}`; let id = memo.get(key) ?? (acct ? directory.idOfSub(acct) : null);
    if (!id) { id = mintId(); planned[id] = { name, subs: acct ? [acct] : [], kind: acct?.startsWith("agent:") ? "agent" : acct ? "human" : "legacy", since: Date.now() }; }
    memo.set(key, id); return id; };
  // role values may carry a sub: that person's account, first, so their acts land on the same id
  for (const [c, v] of Object.entries<any>(oldSt.entities["@world"]?.c ?? {})) if (c.startsWith("roles:") && typeof v?.sub === "string") who(c.slice(6), v.sub);
  const keyOf = (comp: string) => { const m = /^(roles|bans):(.+)$/.exec(comp ?? ""); return m ? `${m[1]}:${who(m[2])}` : comp; };
  const valOf = (comp: string, v: any) => (/^(roles|bans):/.test(comp ?? "") && v && typeof v === "object" && "sub" in v ? (({ sub, ...r }) => r)(v) : v);
  const op = (o: any) => ({ ...o, ...(o.comp !== undefined ? { comp: keyOf(o.comp) } : {}), ...("value" in o ? { value: valOf(o.comp, o.value) } : {}) });
  const next = old.map((e0: any, i: number) => { const e = JSON.parse(JSON.stringify(e0)); if (i === 0) return e; delete e.head; delete e.sig;
    if (typeof e.actor === "string") e.actor = who(e.actor);
    if (e.kind === "state") e.body = e.verb === "batch" ? { ...e.body, ops: e.body.ops.map(op) } : (({ verb, ...b }) => b)(op({ verb: e.verb, ...e.body }));
    if (e.kind === "say" && typeof e.body?.to === "string") e.body.to = who(e.body.to);
    if (e.kind === "act" || e.kind === "say" || e.kind === "sim") delete e.body?.salt;   // re-salted by seal
    return e; });
  const sealed = seal(next, { sign: (m: string) => cust.sign(m) });
  const text = sealed.map((e: any) => JSON.stringify(e)).join("\n") + "\n";
  // the gate: the old fold with the same keys renamed IS the new fold
  const want = JSON.parse(JSON.stringify(oldSt)); const w = want.entities["@world"];
  if (w) w.c = Object.fromEntries(Object.entries<any>(w.c).map(([c, v]) => [keyOf(c), valOf(c, v)]));
  const newSt = fold(readLog(text));
  const tmp = f + ".id-tmp"; fs.writeFileSync(tmp, text);
  const py = (args: string[]) => { try { return JSON.parse(Bun.spawnSync(["python3", "-B", ...args]).stdout.toString()); } catch { return {}; } };
  const rd = py([path.join(ENGINE, "spec/v4/conformance/v4read.py"), tmp, "--json"]), ch = py([path.join(ENGINE, "spec/v4/conformance/chain.py"), "verify", tmp]);
  // (a JSON copy loses the fold's PURGED sentinel, so a world with purges is refused here rather than misjudged)
  const purged = old.some((e: any) => e?.kind === "purge");
  const same = !purged && newSt.status === "ok" && digest(newSt) === digest(want);
  const good = same && rd.status === "ok" && ch.status === "ok" && ch.unsigned_tail === 0;
  if (good && apply) { fs.copyFileSync(f, f + ".before-identities"); fs.renameSync(tmp, f); directory.put(planned); } else fs.rmSync(tmp, { force: true });
  out.push({ dir, entries: old.length, identities: Object.keys(planned).length, same, reader: rd.status, chain: ch.status, written: good && apply,
    people: Object.values(planned).map((p) => `${p.name}${p.subs.length ? ` (${p.subs[0].split(":")[0]})` : " (legacy)"}`) });
}
for (const o of out) console.log(JSON.stringify(o));
process.exit(out.every((o: any) => o.skipped || o.written || (!apply && o.same)) ? 0 : 1);
