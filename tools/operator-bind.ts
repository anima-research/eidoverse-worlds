// tools/operator-bind.ts — `operator-repair.ts bind`: the host's operator lets an account wear an imported identity (a
// main-era name with no account yet), so whoever signs in with it holds that identity's roles. docs/TRANSLATING-OLD-WORLDS.md.
// The account goes in the directory only (server/directory.ts bind), never in a log; world.mod.jsonl records that it was bound.
import fs from "node:fs";
import path from "node:path";
import { directoryFor, foldName, isMinted, accountTag, ACCOUNT_SHAPE } from "../server/directory.ts";
import { modLogAt } from "../server/custody.ts";
import { isWorldDir } from "../server/livehost.ts";
import { readLog, fold } from "../shared/protocol/fold.js";

/** An account as a join wears it (ACCOUNT_SHAPE, with something after the prefix, no spaces). */
const WELL_FORMED = /^(human:[a-z0-9_-]+:|agent:token:|aid1:\S+:|local:)\S+$/i;
const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
type Out = { ok: true; id: string; name: string; account: string; logged: string } | { ok: false; refused: string };

/** The identities with a record of their own in world `dir`: an entry they wrote, a role they hold, a ban or mute on them.
 *  A third party's mention (a recipient of someone else's speech) is not theirs (#260 Stella q3). */
function ownIn(dir: string): Set<string> {
  const out = new Set<string>(), mine = (id: unknown) => { if (typeof id === "string" && isMinted(id)) out.add(id); };
  const lines = (f: string) => { const p = path.join(dir, f); return fs.existsSync(p) ? fs.readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }) : []; };
  for (const e of lines("world.jsonl")) mine(e?.actor);
  for (const m of lines("world.mod.jsonl")) { mine(m?.actor); if (m?.verb === "ban" || m?.verb === "mute") mine(m.who); }
  const wc = fold(readLog(fs.readFileSync(path.join(dir, "world.jsonl")))).entities?.["@world"]?.c ?? {};
  for (const k of Object.keys(wc)) if (k.startsWith("roles:")) mine(k.slice(6));
  return out;
}

export function bindIdentity(worldsDir: string, world: string, who: string, account: string, { by = "the host's operator" }: { by?: string } = {}): Out {
  const no = (refused: string): Out => ({ ok: false, refused });
  if (!NAME.test(world ?? "")) return no(`"${String(world).slice(0, 64)}" isn't a world name`);
  const wd = path.join(worldsDir, world);
  if (!isWorldDir(wd)) return no(`there is no world "${world}" in ${worldsDir} (an old-format world is upgraded first: docs/TRANSLATING-OLD-WORLDS.md)`);
  if (!ACCOUNT_SHAPE.test(account ?? "") || !WELL_FORMED.test(account)) return no(`"${String(account).slice(0, 80)}" isn't an account: human:<provider>:<id>, agent:token:<id>, aid1:<iss>:<sub> or local:<name> (the "sub" /whoami shows)`);
  const dir = directoryFor(worldsDir); const named = ownIn(wd);
  const ids = isMinted(who) ? (named.has(who) ? [who] : []) : [...named].filter((id) => { const n = dir.nameOf(id); return n != null && foldName(n) === foldName(who); });
  if (!ids.length) return no(`nobody called "${who.slice(0, 64)}" has a record of their own in "${world}" (an entry they wrote, a role, a ban or mute)`);
  const imported = ids.filter((id) => dir.entry(id)?.kind === "imported");
  if (!imported.length) return no(`${ids.map((id) => `${dir.nameOf(id)} (${id})`).join(", ")} in "${world}" ${ids.length > 1 ? "aren't" : "isn't"} an imported identity (${ids.map((id) => dir.entry(id)?.kind ?? "unknown").join(", ")}): only a name with no account yet is bound; to move a role between people, operator-repair set/delete`);
  if (imported.length > 1) return no(`${imported.length} imported identities in "${world}" are called "${who}" (${imported.join(", ")}): name one by its id`);
  const id = imported[0], name = dir.nameOf(id) ?? id;
  const worn = dir.idOfSub(account);
  if (worn && worn !== id) return no(`that account already wears ${dir.nameOf(worn) ?? "an identity"} (${worn}) on this server: it can't be two people. To give them ${name}'s roles instead, operator-repair set/delete (docs/TRANSLATING-OLD-WORLDS.md)`);
  dir.bind(id, account);
  modLogAt(path.join(wd, "world.mod.jsonl")).appendMod({ ts: Date.now(), actor: "system", verb: "bind", who: id, by: String(by).slice(0, 64), operator: true });
  return { ok: true, id, name, account: `${account.split(":").slice(0, 2).join(":")}:… (tag ${accountTag(account)})`, logged: "world.mod.jsonl" };
}

/** the CLI: bind <world> <identity-or-name> <account> [--by <who>] → exit 0 when bound */
export function bindCli(argv: string[], worldsDir: string): number {
  const i = argv.indexOf("--by"); const by = i >= 0 ? argv[i + 1] : undefined; const words = i < 0 ? argv : argv.filter((_, k) => k !== i && k !== i + 1);
  const [world, who, account] = words;
  if (!world || !who || !account || words.length !== 3) { console.error("usage: WORLDS_DIR=<dir> bun tools/operator-repair.ts bind <world> <identity-or-name> <account> [--by <who asked>]"); return 2; }
  const r = bindIdentity(worldsDir, world, who, account, by ? { by } : {});
  if (!r.ok) { console.error(`refused: ${r.refused}. Nothing was changed.`); return 1; }
  console.log(`bound ${r.name} (${r.id}) in "${world}" to ${r.account}: whoever signs in with that account is ${r.name} now, with their roles. Recorded in ${r.logged} as an operator repair.`);
  return 0;
}
