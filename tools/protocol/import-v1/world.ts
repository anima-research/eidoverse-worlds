// tools/protocol/import-v1/world.ts — translate an OLD (v1) world on disk into a NEW v4 world, once. The operator runs it
// (bun tools/protocol/world.ts translate <v1 world> <new world>); nothing at runtime imports this directory
// (tools/protocol/nov1-check.ts enforces it). The v1 log is read, never written (R9).
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { TRUST_NAMES } from "../../../server/config.ts";
import { directoryFor, mintId, type Entry } from "../../../server/directory.ts";
import { agentTokens } from "../../../server/auth.ts";
import { custodyAt, modLogAt } from "../../../server/custody.ts";
import { custodyFileIn } from "../../../server/keyfiles.ts";
import { seal } from "../../../shared/protocol/authority.js";
import { readLog, fold, digest, keyOk } from "../../../shared/protocol/fold.js";
import { simFold } from "../../../shared/protocol/simlayer.js";
import { translate } from "./translate-v1.js";
import { v1FoldBuild } from "./build.ts";
import { contentAddressOf, recordEido, storeNameMatches } from "../../../server/eidoindex.ts";

type Any = any;

/** Translate a v1 world's log (srcDir/log.jsonl, never written: R9) into a NEW v4 world in destDir. `founderKey`: the
 *  founder's own governance key (ed25519:…), made on their machine, for tier 0 (README.md, "The Commons ceremony"). */
export function translateV1World(srcDir: string, destDir: string, { founderKey }: { founderKey?: string } = {}) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  if (fs.existsSync(path.join(destDir, "world.jsonl")) || fs.existsSync(path.join(destDir, "log.jsonl"))) throw new Error(`${destDir} already holds a world`);
  const old = fs.readFileSync(src, "utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  // A dialect-3 log (one with a physics `epoch`, PROTOCOL_v2 §3) gets its outcomes from her sim: translate-v1@11 runs it
  // beside the v1 fold and writes each rest as a plain change by `sim` (no launch, no digest: nothing asks a reader to fly
  // her engine), and below, the sealed text is read by the live host's sim layer before anything is written. (Until 2026-10-08 such a log was
  // refused here: the importer compared only against the instant fold and left every punted thing where it started.)
  // the sequencer key is this server's (the custody file every world in this worlds dir shares, server/custody.ts)
  // identities (round-2 review R1): every v1 person becomes an opaque id in the authority directory; an account seen in the
  // log (a role's sub, an agent's reserved name) keeps the id it already wears here. Planned in memory, written to the
  // directory only after the log is: a failed translation leaves no identities behind.
  const dir = directoryFor(path.dirname(destDir)); const planned: Record<string, Entry> = {}; const memo = new Map<string, string>();
  const agents = agentTokens().names;
  const isAcct = (k: string) => /^(human|agent|aid1):/.test(k);
  const who = (name: string, { sub }: { sub?: string } = {}) => {
    // no account in the log: an agent's reserved name is its account; on a TRUST_NAMES (private) server a bare name is
    // local:<name>, as a join there is; anywhere else it's an imported identity an operator binds (directory.bind)
    const acct = sub ?? (isAcct(name) ? name : agents.has(name.toLowerCase()) ? `agent:token:${name.toLowerCase()}` : TRUST_NAMES ? `local:${name.toLowerCase()}` : undefined);
    const display = isAcct(name) ? null : name;   // a role keyed by its account has no name of its own
    const key = acct ?? `name:${name}`;
    let id = memo.get(key) ?? (acct ? dir.idOfSub(acct) : null) ?? null;   // the same person they are everywhere on this server
    if (!id) { id = mintId(); planned[id] = { name: display ?? "someone", subs: acct ? [acct] : [], kind: acct ? (/^(agent|aid1):/.test(acct) ? "agent" : "human") : "imported", since: Date.now() }; }
    if (display && planned[id]?.name === "someone") planned[id].name = display;   // a later mention brings the name
    memo.set(key, id); if (display) memo.set(`name:${display}`, id); return id; };
  // every name that ever had an account in this log (a grant with a sub, genesis roles), first: a person's acts may come
  // before the grant that names their account, and must land on the same id. (v1 can't tell two people who shared a
  // name apart in their acts; the last account seen for a name wins, and translate reports how many.)
  for (const e of old) { const a = e?.args ?? {};
    if (e?.verb === "grant" && typeof a.id === "string" && typeof a.sub === "string") who(a.id, { sub: a.sub });
    if (e?.verb === "genesis") for (const [k, v] of Object.entries<Any>(a.roles ?? {})) if (k !== "*" && typeof v?.sub === "string") who(k, { sub: v.sub }); }
  const cust = custodyAt(custodyFileIn(path.dirname(destDir)));
  // a model's bytes (R 10-17: the path is the reference; this is model-hash beside it): the original bytes on this host, hashed;
  // recorded so this server answers /eido/sha256/<hex> for them
  const addressed = new Map<string, string>();
  const content = (p: string) => { const h = contentAddressOf(p); if (!h) return null; addressed.set(h, p); if (!storeNameMatches(p)) renamedBlobs.push(p); return `sha256:${h}`; };
  const renamedBlobs: string[] = [];   // store blobs whose bytes no longer hash to their name: hashed by what's here
  if (founderKey !== undefined && !keyOk(founderKey)) throw new Error(`${founderKey}: not a governance key (ed25519:<base64url of 32 bytes>, PROTOCOL §13)`);
  const r = translate(old, { foldBuild: v1FoldBuild(), key: cust.sequencer(), operator: cust.operator(), nonce: crypto.randomBytes(16).toString("base64url"), who, namespace: path.basename(destDir), content, ...(founderKey ? { founder: founderKey } : {}) });
  if (r.stats.divergences) throw new Error(`translation diverged ${r.stats.divergences}× (first ${JSON.stringify(r.stats.firstDivergence)}): nothing written`);
  // salted and signed like every line the authority writes (§2.4; round-2 review R3): a translated world is a chained log
  const text = seal(r.out, { sign: (m: string) => cust.sign(m) }).map((e: Any) => JSON.stringify(e)).join("\n") + "\n";
  // the strict reader must accept every line, and fold to the translator's own final state, before the file exists
  const back = fold(readLog(text));
  const malformed = back.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed"));
  if (back.status !== "ok" || malformed.length) throw new Error(`the translated log doesn't read back clean (${back.status}, ${malformed.length} malformed: ${JSON.stringify(malformed.slice(0, 3))}): nothing written`);
  // a physics-era world (translate-v1@11): her sim's outcomes are plain logged writes, so nothing in the text may ask a
  // reader to fly an engine (no launch, no digest), and the live host's sim layer (livehost.ts: no catalogue of its own)
  // must read the whole history without one disagreement
  let sim: Any = null;
  if (r.stats.launches !== undefined) {
    const lines = readLog(text); const sf = simFold(lines, Math.max(0, ...lines.map((e: Any) => (Number.isFinite(e?.ts) ? e.ts : 0))), { models: {} });
    const flown = lines.filter((e: Any) => e?.kind === "sim").length;
    if (flown || sf.checks.disagree.length) throw new Error(`the translated world asks a reader to fly (${flown} sim entries) or its sim layer disagrees (${JSON.stringify(sf.checks.disagree.slice(0, 3))}): nothing written`);
    sim = { launches: r.stats.launches, rests: r.stats.rests, agree: sf.checks.agree, engine: back.entities?.["@world"]?.c?.["physics-engine"] ?? null };
  }
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destDir, "world.jsonl.tmp");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(destDir, "world.jsonl"));
  dir.put(planned);
  for (const [h, p] of addressed) recordEido(h, p);
  // v1 bans are the moderator's record in v4 (the authority reads bans only from world.mod.jsonl): file each one there, or a
  // translated world quietly unbans everyone (component review, world-settings #3)
  const banned = Object.entries<Any>(back.entities?.["@world"]?.c ?? {}).filter(([k]) => k.startsWith("imported-bans:"));
  if (banned.length) { const m = modLogAt(path.join(destDir, "world.mod.jsonl"));
    for (const [k, v] of banned) m.appendMod({ ts: Number.isInteger(v?.ts) ? v.ts : Date.now(), actor: "system", verb: "ban", who: k.slice("imported-bans:".length), ...(v?.reason ? { reason: String(v.reason) } : {}), translated: true }); }
  // where each person last stood: the old world remembered it by display name; the server remembers it by identity (a
  // name is anyone's to wear), so each name this log knows as one person carries over under that person's id
  let poses = 0;
  const oldPoses = path.join(srcDir, "poses.json");
  if (fs.existsSync(oldPoses)) { try { const P = JSON.parse(fs.readFileSync(oldPoses, "utf8")); const out: Record<string, unknown> = {};
    for (const [name, pose] of Object.entries<Any>(P ?? {})) { const id = memo.get(`name:${name}`); if (id && pose) { out[id] = pose; poses++; } }
    if (poses) fs.writeFileSync(path.join(destDir, "poses.json"), JSON.stringify(out)); } catch { /* an unreadable poses file: nobody's place is remembered */ } }
  return { identities: Object.keys(planned).length, renamedBlobs, stats: r.stats, entries: r.out.length, worldId: back.worldId, digest: digest(back), poses, ...(sim ? { sim } : {}) };
}

