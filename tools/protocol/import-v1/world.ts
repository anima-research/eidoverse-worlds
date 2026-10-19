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
import { seal, maintain } from "../../../shared/protocol/authority.js";
import { openLive } from "../../../server/livehost.ts";
import { ENGINE_CATALOGUE } from "../../../server/modelcatalogue.ts";
import { readLog, fold, digest, keyOk } from "../../../shared/protocol/fold.js";
import { simFold } from "../../../shared/protocol/simlayer.js";
import { translate, TRANSLATOR, DROPPED, deferredFeatures, deferredRefusal } from "./translate-v1.js";
import { sha256 } from "../../../shared/protocol/hash.js";
import { v1FoldBuild } from "./build.ts";
import { contentAddressOf, recordEido, storeNameMatches } from "../../../server/eidoindex.ts";

type Any = any;

/** The approval of a translation, bound to the dry-run report's hash (review of PR #260, Mica, item 6: "owner/operator
 *  countersign"). TWO signatures over the same text, approvalText(world, report): the OWNER's (the founder's own governance
 *  key, the ceremony's: import-v1/README.md) and the OPERATOR's (the host's custody operator key, server/custody.ts
 *  signOperator: the countersignature). Both are checked by world.ts before anything is written and AGAIN here, before the log
 *  is written (approvalProblem): a translation with either missing, not verifying, or over another hash is refused. A world
 *  with no founder key (tier 0 empty) has no owner who can sign: by default that is refused; `owner: null` is admitted only
 *  when `noOwner` carries NO_OWNER verbatim (the CLI's --operator-only-no-owner), and the act records that no owner approved. */
export type Sig = { key: string; sig: string };
export type Approval = { report: string; owner: Sig | null; operator: Sig; noOwner?: string };
export const approvalText = (world: string, report: string) => `eidoverse-approve-translation:${world}:${report}`;
export const NO_OWNER = "no owner approved this translation: the world has no founder key (tier 0 empty), so no owner's signature exists; the operator ran it with --operator-only-no-owner, and the operator's countersignature is the only signature";
const ed25519Pub = (key: string) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.slice(8), "base64url")]), format: "der", type: "spki" });
/** Does `sig` (base64 or base64url) verify over `msg` for the governance key `key`? */
export const verifySig = (key: string, msg: string, sig: string) => { try { return !!key && !!sig && crypto.verify(null, Buffer.from(msg), ed25519Pub(key), Buffer.from(String(sig).replace(/-/g, "+").replace(/_/g, "/"), "base64")); } catch { return false; } };
const b64url = (sig: string) => sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Why this approval can't stand for world `world`, or null when both signatures verify over approvalText(world, report)
 *  (or the owner's absence is declared with NO_OWNER). The one rule for the CLI and the writer. */
export function approvalProblem(world: string, a: Approval | null | undefined): string | null {
  if (!a || typeof a !== "object" || !/^[0-9a-f]{64}$/.test(String(a.report ?? ""))) return "the approval names no report hash (64 hex, as --dry-run prints it)";
  const text = approvalText(world, a.report);
  if (!a.operator?.key || !a.operator?.sig) return `no operator countersignature: the host's custody operator key must sign "${text}" too (world.ts signs it from .custody.json)`;
  if (!keyOk(a.operator.key)) return `the operator's key ${a.operator.key} is not a governance key (ed25519:<base64url of 32 bytes>)`;
  if (!verifySig(a.operator.key, text, a.operator.sig)) return `the operator's countersignature doesn't verify for ${a.operator.key} over "${text}": not this host's countersignature of this report`;
  if (a.owner) {
    if (!a.owner.key || !a.owner.sig) return `the owner's approval names ${a.owner.key ? "no signature" : "no key"}`;
    if (!keyOk(a.owner.key)) return `the owner's key ${a.owner.key} is not a governance key (ed25519:<base64url of 32 bytes>)`;
    if (!verifySig(a.owner.key, text, a.owner.sig)) return `the owner's approval signature doesn't verify for ${a.owner.key} over "${text}": not this founder's approval of this report`;
    return null;
  }
  if (a.noOwner !== NO_OWNER) return `no owner's signature: a translation needs the owner's signature AND the operator's countersignature over the same report; a world with no founder key translates only with --operator-only-no-owner, which records that no owner approved`;
  return null;
}
/** The approval as the CLI builds it: the owner's signature (checked), the operator's countersignature (made here, from the
 *  host's custody), or, with no founder key and the flag, the operator alone with NO_OWNER recorded. */
export function makeApproval(world: string, report: string, { founderKey, ownerSig, operator, operatorOnlyNoOwner = false }: { founderKey?: string; ownerSig?: string; operator: { key: string; sign: (msg: string) => string }; operatorOnlyNoOwner?: boolean }): Approval {
  const text = approvalText(world, report);
  const op = { key: operator.key, sig: operator.sign(text) };
  if (founderKey) return { report, owner: { key: founderKey, sig: b64url(ownerSig ?? "") }, operator: op };
  return { report, owner: null, operator: op, ...(operatorOnlyNoOwner ? { noOwner: NO_OWNER } : {}) };
}

/** The dry-run report: everything the translation would do that an owner should see before it does, and nothing that varies
 *  between runs (no minted identities, no nonce, no signatures), so its hash is the same for the same old log, the same tool
 *  build and the same founder key. `deferred` (features v4 doesn't carry yet) non-empty means the translation is REFUSED. */
export function reportV1World(srcDir: string, { founderKey, name, content }: { founderKey?: string; name?: string; content?: (p: string) => string | null } = {}) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  const srcBytes = fs.readFileSync(src);
  const old = srcBytes.toString("utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const world = name ?? path.basename(srcDir);
  const deferred = deferredFeatures(old);
  // the pure translation (no directory, no custody key: the conformance key, no nonce): the same stats the real one has
  const r = translate(old, { foldBuild: v1FoldBuild(), namespace: world, ...(content ? { content } : {}), ...(founderKey ? { founder: founderKey } : {}) });
  const report = {
    v: 1, world,
    // Mica, #260 (10-17): "Worlds using alpha should know they accepted translation churn." In the report, so the hash the
    // owner signs covers it (PROTOCOL.md, the trial-period paragraph).
    trial: "This protocol is in a trial period (about a year): later versions may translate this world again, and stored data may change shape between them (PROTOCOL.md, start). Approving this report accepts that.",
    source: { file: "log.jsonl", size: srcBytes.length, sha256: crypto.createHash("sha256").update(srcBytes).digest("hex") },
    translator: TRANSLATOR, fold: v1FoldBuild(), founderKey: founderKey ?? null,
    entries: { old: r.stats.in, new: r.out.length, change: r.stats.change, divergences: r.stats.divergences },
    actorsRenamed: r.stats.renamed, tsClamped: r.stats.tsClamped ?? 0,
    guards: { becameLocks: r.stats.guards, stillGuardedAtEnd: r.stats.guardsLive },
    ...(r.stats.launches !== undefined ? { physics: { launches: r.stats.launches, rests: r.stats.rests } } : {}),
    ...(r.stats.modelsHashed !== undefined ? { models: { hashed: r.stats.modelsHashed, unhashed: r.stats.modelsUnhashed } } : {}),
    dropped: DROPPED,            // what every translation drops or renames BY DESIGN (the translator's own table)
    deferred,                    // uses of features v4 doesn't carry yet: any → refused
    refused: deferred.length ? deferredRefusal(deferred, `"${world}"`) : null,
  };
  return { report, hash: sha256(JSON.stringify(report)) };
}

/** Translate a v1 world's log (srcDir/log.jsonl, never written: R9) into a NEW v4 world in destDir. `founderKey`: the
 *  founder's own governance key (ed25519:…), made on their machine, for tier 0 (README.md, "The Commons ceremony").
 *  `name`: the world's name, when destDir's own name isn't it (an in-place translation writes into a temporary sibling
 *  first: world.ts translate <world>); the world's own inventions are namespaced by it. `deferIdentities`: don't write the
 *  planned identities to the shared directory; return them (`planned`) for the caller to write once the world is really
 *  in place (an in-place translation writes into a temporary sibling that may still be thrown away: review of PR #260,
 *  import-v1/world.ts:86 — a failed attempt left its minted identities behind, and every retry minted more). */
export function translateV1World(srcDir: string, destDir: string, { founderKey, name, deferIdentities = false, approval }: { founderKey?: string; name?: string; deferIdentities?: boolean; approval?: Approval } = {}) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  if (fs.existsSync(path.join(destDir, "world.jsonl")) || fs.existsSync(path.join(destDir, "log.jsonl"))) throw new Error(`${destDir} already holds a world`);
  const srcBytes = fs.readFileSync(src);
  // features v4 doesn't carry yet are never dropped quietly (DEFERRED): the log is refused, naming each use
  { const uses = deferredFeatures(srcBytes.toString("utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }));
    if (uses.length) throw new Error(deferredRefusal(uses, `"${name ?? path.basename(destDir)}"`)!); }
  // the bytes this translation is OF: an in-place translation checks the old log still holds exactly these before it swaps
  // (world.ts translateInPlace; review of PR #260, world.ts:99 — a server still writing to it would lose those edits)
  const source = { size: srcBytes.length, sha256: crypto.createHash("sha256").update(srcBytes).digest("hex") };
  const old = srcBytes.toString("utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  // A dialect-3 log (one with a physics `epoch`, PROTOCOL_v2 §3) gets its outcomes from her sim: translate-v1@11 runs it
  // beside the v1 fold and writes each rest as a plain change by `sim` (no launch, no digest: nothing asks a reader to fly
  // her engine), and below, the sealed text is read by the live host's sim layer before anything is written. (Until 2026-10-08 such a log was
  // refused here: the importer compared only against the instant fold and left every punted thing where it started.)
  // the sequencer key is this server's (the custody file every world in this worlds dir shares, server/custody.ts)
  // identities (round-2 review R1): every v1 person becomes an opaque id in the authority directory; an account seen in the
  // log (a role's sub, an agent's reserved name) keeps the id it already wears here. Planned in memory, written to the
  // directory only after the log is — and, translating in place (deferIdentities), only once the swap has succeeded
  // (world.ts): a failed translation leaves no identities behind.
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
    if (!id) { id = mintId(); planned[id] = { name: display ?? "someone", subs: acct ? [acct] : [], kind: acct ? "account" : "imported", since: Date.now() }; }
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
  const r = translate(old, { foldBuild: v1FoldBuild(), key: cust.sequencer(), operator: cust.operator(), nonce: crypto.randomBytes(16).toString("base64url"), who, namespace: name ?? path.basename(destDir), content, ...(founderKey ? { founder: founderKey } : {}) });
  if (r.stats.divergences) throw new Error(`translation diverged ${r.stats.divergences}× (first ${JSON.stringify(r.stats.firstDivergence)}): nothing written`);
  // the owner's approval, bound to the dry-run report's hash, rides in the world's own log right after the system's
  // repair-shapes act (index 2): provenance a reader can check against `reportV1World` of log.original.jsonl. The fold never
  // reads acts (PROTOCOL §1), so this changes no state; a translation nothing approved carries none (the pure callers: sweep, oracle)
  if (approval) { const world = name ?? path.basename(destDir); const bad = approvalProblem(world, approval);
    if (bad) throw new Error(`the approval is refused: ${bad}. Nothing written`);
    if (approval.owner && founderKey && approval.owner.key !== founderKey) throw new Error(`the approval is refused: the owner's key ${approval.owner.key} is not the founder key ${founderKey} the world is founded with. Nothing written`);
    const at = r.out.findIndex((e: Any) => e.kind === "act" && e.verb === "repair-shapes") + 1;
    r.out.splice(at || 3, 0, { world: r.out[1].world, kind: "act", actor: "system", verb: "translation-approved", ts: r.out[1].ts ?? 0,
      body: { report: approval.report, approval: { over: approvalText(world, approval.report), owner: approval.owner ? { key: approval.owner.key, sig: approval.owner.sig } : null, operator: { key: approval.operator.key, sig: approval.operator.sig },
        ...(approval.owner ? {} : { noOwner: NO_OWNER }) } } }); }
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
  // lead's ruling 10-18: a LOAD never writes, so the translation runs the maintenance command on its own output here: the
  // v1 sockets maps become socket children (lift-sockets, the system's act with by: "translate"); the renames and the shape
  // repair are already in the projection and write nothing. A translated world therefore needs no step when it is served.
  const live = openLive(destDir, name ?? path.basename(destDir), { catalogue: ENGINE_CATALOGUE, scripts: null });
  const m: Any = maintain(live, { by: "translate" });
  if (m.refused) throw new Error(`the translated world could not be lifted: ${m.refused.code}: ${m.refused.reason}`);
  const maintenance = { lifted: m.steps.lift.made.length, liftFailed: m.steps.lift.failed, renamed: m.steps.rename.renamed.length, repaired: m.repaired.length, entries: live.entries.length };
  if (maintenance.liftFailed.length) throw new Error(`the translated world's seats could not all be lifted: ${JSON.stringify(maintenance.liftFailed).slice(0, 300)}`);
  if (!deferIdentities) dir.put(planned);
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
  // the approval act (translation-approved, bound to the dry-run report) sits right after the translation's marker, BEFORE the
  // content it approves; the maintenance acts (lift-sockets by: "translate") come at the tail, derived from that approved content
  return { source, planned, identities: Object.keys(planned).length, renamedBlobs, addressed: [...addressed.keys()], stats: r.stats, entries: live.entries.length, worldId: back.worldId, digest: digest(live.state()), maintenance, poses, ...(sim ? { sim } : {}) };
}

