// tools/protocol/import-v1/world.ts — translate an OLD (v1) world on disk into a NEW v4 world, once. The operator runs it
// (bun tools/protocol/world.ts translate <v1 world> <new world>); nothing at runtime imports this directory
// (tools/protocol/nov1-check.ts enforces it). The v1 log is read, never written (R9).
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { TRUST_NAMES } from "../../../server/config.ts";
import { directoryFor, mintId, type Entry } from "../../../server/directory.ts";
import { agentTokens, HN_ISS } from "../../../server/auth.ts";
import { custodyAt, modLogAt } from "../../../server/custody.ts";
import { custodyFileIn } from "../../../server/keyfiles.ts";
import { seal, maintain } from "../../../shared/protocol/authority.js";
import { openLive } from "../../../server/livehost.ts";
import { ENGINE_CATALOGUE } from "../../../server/modelcatalogue.ts";
import { readLog, fold, digest, keyOk } from "../../../shared/protocol/fold.js";
import { simFold } from "../../../shared/protocol/simlayer.js";
import { translate, TRANSLATOR, DROPPED, deferredFeatures, deferredRefusal, accountIn, isAccount, isAccountName } from "./translate-v1.js";
import { sha256 } from "../../../shared/protocol/hash.js";
import { v1FoldBuild } from "./build.ts";
import { contentAddressOf, recordEido, storeNameMatches } from "../../../server/eidoindex.ts";

type Any = any;

/** The approval of a translation, bound to the dry-run report's hash (review of PR #260, Mica, item 6: "owner/operator
 *  countersign"; rereview blocker 1). A translation names NO founder and carries NO owner's signature: v1 logs record accounts,
 *  never keys, so nothing can yet bind a key to the old world's owner, and a key the CLI was handed would be the operator's
 *  choice recorded as "the owner approved" (and installed as tier 0). Until something can attest that a key is the v1 owner's
 *  (a home-node attestation, later), the approval is the OPERATOR's countersignature alone (the host's custody operator key,
 *  server/custody.ts signOperator) over approvalText(world, report), with `owner: null` and NO_OWNER recorded verbatim (the
 *  CLI's --operator-only-no-owner). Checked by world.ts before anything is written and AGAIN here, before the log is written
 *  (approvalProblem): an approval carrying an owner's signature, or with the countersignature missing, not verifying, or over
 *  another hash, is refused. */
export type Sig = { key: string; sig: string };
export type Approval = { report: string; owner: null; operator: Sig; noOwner: string };
export const approvalText = (world: string, report: string) => `eidoverse-approve-translation:${world}:${report}`;
/** Why a translation names no founder: the CLI's refusal of --founder-key / --approve-sig and the writer's of a founder key. */
export const NO_FOUNDER = "nothing can yet bind a key to the old world's owner (v1 logs record accounts, not keys), so a translation can't name a founder or carry an owner's signature";
export const NO_OWNER = "no owner approved this translation: nothing can yet bind a key to the old world's owner (v1 logs record accounts, not keys), so no owner was attested and the world's tier 0 is empty; the operator ran it with --operator-only-no-owner, and the operator's countersignature is the only signature";
const ed25519Pub = (key: string) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key.slice(8), "base64url")]), format: "der", type: "spki" });
/** Does `sig` (base64 or base64url) verify over `msg` for the governance key `key`? */
export const verifySig = (key: string, msg: string, sig: string) => { try { return !!key && !!sig && crypto.verify(null, Buffer.from(msg), ed25519Pub(key), Buffer.from(String(sig).replace(/-/g, "+").replace(/_/g, "/"), "base64")); } catch { return false; } };
/** Why this approval can't stand for world `world`, or null when the operator's countersignature verifies over
 *  approvalText(world, report), the owner is null and NO_OWNER is recorded. The one rule for the CLI and the writer. */
export function approvalProblem(world: string, a: Approval | null | undefined): string | null {
  if (!a || typeof a !== "object" || !/^[0-9a-f]{64}$/.test(String(a.report ?? ""))) return "the approval names no report hash (64 hex, as --dry-run prints it)";
  if ((a as any).owner !== null) return `it carries an owner's signature (owner must be null): ${NO_FOUNDER}; translate on the operator's countersignature alone with --no-founder-key --operator-only-no-owner`;
  const text = approvalText(world, a.report);
  if (!a.operator?.key || !a.operator?.sig) return `no operator countersignature: the host's custody operator key must sign "${text}" (world.ts signs it from .custody.json)`;
  if (!keyOk(a.operator.key)) return `the operator's key ${a.operator.key} is not a governance key (ed25519:<base64url of 32 bytes>)`;
  if (!verifySig(a.operator.key, text, a.operator.sig)) return `the operator's countersignature doesn't verify for ${a.operator.key} over "${text}": not this host's countersignature of this report`;
  if (a.noOwner !== NO_OWNER) return `no owner's signature can exist (${NO_FOUNDER}), so a translation runs on the operator's countersignature alone, and only with --operator-only-no-owner, which records that no owner was attested`;
  return null;
}
/** The approval as the CLI builds it: the operator's countersignature (made here, from the host's custody), owner null, NO_OWNER. */
export function makeApproval(world: string, report: string, { operator }: { operator: { key: string; sign: (msg: string) => string } }): Approval {
  return { report, owner: null, operator: { key: operator.key, sig: operator.sign(approvalText(world, report)) }, noOwner: NO_OWNER };
}

/** A v1 log's lines, parsed: the entries, and how many lines didn't parse (dropped, and said so in the report and result). */
function readOld(srcBytes: Buffer) {
  let unparsed = 0;
  const old = srcBytes.toString("utf8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { unparsed++; return []; } });
  return { old, unparsed };
}

/** The identity mapper a translation runs with: who(name, {sub, lowered}) → the v4 identity. A person with an account is
 *  that account; a person without one is their EXACT name, as v1 kept roles and acts. `lowered`: the name is one the v1
 *  fold lowercased (a ban's key), so it stands for the one name in this log that lowercases to it, when exactly one does.
 *  `mint` false (the dry run): reads what `dir` already knows and derives a stable id for the rest, writing nothing, so
 *  the report counts exactly what the real run renames and nothing in it varies. */
function identityMapper(old: Any[], dir: ReturnType<typeof directoryFor> | null, { mint = true }: { mint?: boolean } = {}) {
  const planned: Record<string, Entry> = {}; const memo = new Map<string, string>();
  const agents = agentTokens();
  const nameKey = (n: string) => `name:${n}`;
  // every name this log gives a person (actors, grants, bans, genesis roles, a say's addressee), and every account it
  // gives one (a sub, a placer's, a bySub): what a lowered ban key may mean, an account's case included
  const names = new Set<string>();
  for (const e of old) { const a = e?.args ?? {};
    if (typeof e?.actor === "string") names.add(e.actor);
    if ((e?.verb === "grant" || e?.verb === "ban") && typeof a.id === "string") names.add(a.id);
    if (e?.verb === "say" && typeof a.to === "string") names.add(a.to);
    for (const s of [a.sub, a.placer?.sub, a.bySub]) if (isAccount(s)) names.add(s);
    if (e?.verb === "genesis") for (const [k, v] of Object.entries<Any>(a.roles ?? {})) if (k !== "*") { names.add(k); if (isAccount(v?.sub)) names.add(v.sub); } }
  const unlowered = (k: string) => { const c = [...names].filter((n) => n.toLowerCase() === k); return c.length === 1 ? c[0] : k; };
  // a v1 agent's sub is its home-node subject (agent:<name>@<domain>); a live join from this host's home node wears the
  // enrolment that lists it, else aid1:<iss>:<sub> (server.ts join), so its grants and bans land on that same account
  const liveAccount = (sub: string) => (/^agent:/.test(sub) && !/^agent:token:/.test(sub) ? (agents.bySub.has(sub) ? `agent:token:${agents.bySub.get(sub)!.toLowerCase()}` : `aid1:${HN_ISS}:${sub}`) : sub);
  const stable = (key: string) => "u-" + [...crypto.createHash("sha256").update(`eido-dry-run\0${key}`).digest()].slice(0, 20).map((b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");
  const who = (name0: string, { sub, lowered = false }: { sub?: string; lowered?: boolean } = {}) => {
    const name = lowered && sub === undefined ? unlowered(name0) : name0;
    // no account in the log: an agent's reserved name is its account; on a TRUST_NAMES (private) server a bare name is
    // local:<name>, as a join there is; anywhere else it's an imported identity an operator binds (directory.bind)
    const acct = sub !== undefined ? liveAccount(sub) : (isAccountName(name) ? liveAccount(name) : agents.names.has(name.toLowerCase()) ? `agent:token:${name.toLowerCase()}` : TRUST_NAMES ? `local:${name.toLowerCase()}` : undefined);
    const display = isAccountName(name) || name === sub ? null : name;   // a role keyed by its account, or an account alone, has no name of its own
    const key = acct ?? nameKey(name);
    // named without an account: whoever this log already knows by exactly that name (a grant's sub, the pre-index below) first
    let id = (sub === undefined && display !== null ? memo.get(nameKey(display)) : undefined) ?? memo.get(key) ?? (acct && dir ? dir.idOfSub(acct) : null) ?? null;
    if (!id) { id = mint ? mintId() : stable(key); planned[id] = { name: display || "someone", subs: acct ? [acct] : [], kind: acct ? "account" : "imported", since: Date.now() }; }
    if (display && planned[id]?.name === "someone") planned[id].name = display;   // a later mention brings the name
    memo.set(key, id); if (display !== null) memo.set(nameKey(display), id); return id; };
  // every name that ever had an account in this log (a grant with a sub, genesis roles), first: a person's acts may come
  // before the grant that names their account, and must land on the same id. (v1 can't tell two people who shared a
  // name apart in their acts; the last account seen for a name wins, and translate reports how many.)
  // The other pairs v1's server wrote itself count too (server/verbs.ts at 306a00b0): a ban's {id, sub}, a spawn's or a
  // light's placer {id, sub}, and a behaviour's bySub, which is its own actor's account.
  for (const e of old) { const a = e?.args ?? {};
    if ((e?.verb === "grant" || e?.verb === "ban") && typeof a.id === "string" && typeof a.sub === "string") who(a.id, { sub: a.sub });
    if (e?.verb === "genesis") for (const [k, v] of Object.entries<Any>(a.roles ?? {})) if (k !== "*" && typeof v?.sub === "string") who(k, { sub: v.sub });
    if ((e?.verb === "spawn" || e?.verb === "light") && typeof a.placer?.id === "string" && isAccount(a.placer.sub)) who(a.placer.id, { sub: a.placer.sub });
    if (e?.verb === "behavior" && typeof e.actor === "string" && !["door", "world", "sim"].includes(e.actor) && !/^bhv:/i.test(e.actor) && isAccount(a.bySub)) who(e.actor, { sub: a.bySub }); }
  return { who, planned, idOfName: (n: string) => memo.get(nameKey(n)) };
}

const hostContent = (p: string) => { const h = contentAddressOf(p); return h ? `sha256:${h}` : null; };
/** The dry-run report: everything the translation would do that an owner should see before it does, and nothing that varies
 *  between runs (no minted identities, no nonce, no signatures), so its hash is the same for the same old log and the same tool
 *  build. `deferred` (features v4 doesn't carry yet) non-empty means the translation is REFUSED. The writer builds the same
 *  report from its own run and refuses an approval of any other hash. */
function reportOf(srcBytes: Buffer, world: string, unparsed: number, deferred: Any[], r: Any, outLength = r.out.length) {
  const report = {
    v: 1, world,
    // Mica, #260 (10-17): "Worlds using alpha should know they accepted translation churn." In the report, so the hash that is
    // approved covers it (PROTOCOL.md, the trial-period paragraph).
    trial: "This protocol is in a trial period (about a year): later versions may translate this world again, and stored data may change shape between them (PROTOCOL.md, start). Approving this report accepts that.",
    source: { file: "log.jsonl", size: srcBytes.length, sha256: crypto.createHash("sha256").update(srcBytes).digest("hex"), unparsedLines: unparsed },
    translator: TRANSLATOR, fold: v1FoldBuild(), founderKey: null,   // a translation names no founder (NO_FOUNDER): tier 0 empty
    entries: { old: r.stats.in, new: outLength, change: r.stats.change, divergences: r.stats.divergences },
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
export function reportV1World(srcDir: string, { name, content }: { name?: string; content?: (p: string) => string | null } = {}) {
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  const srcBytes = fs.readFileSync(src);
  const { old, unparsed } = readOld(srcBytes);
  const world = name ?? path.basename(srcDir);
  // the pure translation (no directory, no custody key: the conformance key, no nonce), with the real run's identity
  // mapping minting nothing and its model hashes (this host's bytes, recording nothing): the same stats the real one has
  const r = translate(old, { foldBuild: v1FoldBuild(), namespace: world, who: identityMapper(old, directoryFor(path.dirname(path.resolve(srcDir))), { mint: false }).who, content: content ?? hostContent });
  return reportOf(srcBytes, world, unparsed, deferredFeatures(old), r);
}

/** Translate a v1 world's log (srcDir/log.jsonl, never written: R9) into a NEW v4 world in destDir, with tier 0 of its
 *  genesis EMPTY: a translation names no founder (NO_FOUNDER), and a `founderKey` handed here is refused. `name`: the world's name, when destDir's own name isn't it (an in-place translation writes into a temporary sibling
 *  first: world.ts translate <world>); the world's own inventions are namespaced by it. `deferIdentities`: don't write the
 *  planned identities to the shared directory; return them (`planned`) for the caller to write once the world is really
 *  in place (an in-place translation writes into a temporary sibling that may still be thrown away: review of PR #260,
 *  import-v1/world.ts:86 — a failed attempt left its minted identities behind, and every retry minted more). */
export function translateV1World(srcDir: string, destDir: string, { founderKey, name, deferIdentities = false, approval }: { founderKey?: unknown; name?: string; deferIdentities?: boolean; approval?: Approval } = {}) {
  if (founderKey !== undefined) throw new Error(`a translation takes no founder key: ${NO_FOUNDER}. Nothing written`);
  const src = path.join(srcDir, "log.jsonl");
  if (!fs.existsSync(src)) throw new Error(`${src}: no v1 log`);
  if (fs.existsSync(path.join(destDir, "world.jsonl")) || fs.existsSync(path.join(destDir, "log.jsonl"))) throw new Error(`${destDir} already holds a world`);
  const srcBytes = fs.readFileSync(src);
  const world = name ?? path.basename(destDir);
  const { old, unparsed } = readOld(srcBytes);
  // features v4 doesn't carry yet are never dropped quietly (DEFERRED): the log is refused, naming each use
  const deferred = deferredFeatures(old);
  if (deferred.length) throw new Error(deferredRefusal(deferred, `"${world}"`)!);
  // the approval is checked before anything is translated: its countersignature here, its report hash after the run
  if (approval) { const bad = approvalProblem(world, approval);
    if (bad) throw new Error(`the approval is refused: ${bad}. Nothing written`); }
  // the bytes this translation is OF: an in-place translation checks the old log still holds exactly these before it swaps
  // (world.ts translateInPlace; review of PR #260, world.ts:99 — a server still writing to it would lose those edits)
  const source = { size: srcBytes.length, sha256: crypto.createHash("sha256").update(srcBytes).digest("hex"), unparsedLines: unparsed };
  // A dialect-3 log (one with a physics `epoch`, PROTOCOL_v2 §3) gets its outcomes from her sim: translate-v1@11 runs it
  // beside the v1 fold and writes each rest as a plain change by `sim` (no launch, no digest: nothing asks a reader to fly
  // her engine), and below, the sealed text is read by the live host's sim layer before anything is written. (Until 2026-10-08 such a log was
  // refused here: the importer compared only against the instant fold and left every punted thing where it started.)
  // the sequencer key is this server's (the custody file every world in this worlds dir shares, server/custody.ts)
  // identities (round-2 review R1): every v1 person becomes an opaque id in the authority directory; an account seen in the
  // log (a role's sub, an agent's reserved name) keeps the id it already wears here. Planned in memory, written to the
  // directory only after the log is — and, translating in place (deferIdentities), only once the swap has succeeded
  // (world.ts): a failed translation leaves no identities behind.
  const dir = directoryFor(path.dirname(destDir));
  const { who, planned, idOfName } = identityMapper(old, dir);
  const cust = custodyAt(custodyFileIn(path.dirname(destDir)));
  // a model's bytes (R 10-17: the path is the reference; this is model-hash beside it): the original bytes on this host, hashed;
  // recorded so this server answers /eido/sha256/<hex> for them
  const addressed = new Map<string, string>();
  const content = (p: string) => { const h = contentAddressOf(p); if (!h) return null; addressed.set(h, p); if (!storeNameMatches(p)) renamedBlobs.push(p); return `sha256:${h}`; };
  const renamedBlobs: string[] = [];   // store blobs whose bytes no longer hash to their name: hashed by what's here
  // the approval (the operator's countersignature; no owner attested), bound to the dry-run report's hash, rides in the
  // world's own log right after the system's repair-shapes act, written by translate itself so every later cause counts it:
  // provenance a reader can check against `reportV1World` of log.original.jsonl. The fold never reads acts (PROTOCOL §1), so
  // this changes no state; a translation nothing approved carries none (the pure callers: sweep, oracle)
  const approved = approval ? { report: approval.report, approval: { over: approvalText(world, approval.report), owner: null, operator: { key: approval.operator.key, sig: approval.operator.sig }, noOwner: NO_OWNER } } : undefined;
  const r = translate(old, { foldBuild: v1FoldBuild(), key: cust.sequencer(), operator: cust.operator(), nonce: crypto.randomBytes(16).toString("base64url"), who, namespace: world, content, ...(approved ? { approved } : {}) });
  if (r.stats.divergences) throw new Error(`translation diverged ${r.stats.divergences}× (first ${JSON.stringify(r.stats.firstDivergence)}): nothing written`);
  // the approval is of the report of THESE bytes, translated as this run translated them (the dry run's numbers are this run's)
  if (approval) { const now = reportOf(srcBytes, world, unparsed, deferred, r, r.out.length - 1).hash;
    if (now !== approval.report) throw new Error(`the approval is refused: it approves report ${approval.report}, but the report of the log being translated hashes to ${now} (the old log or the tool changed since the dry run). Nothing written`); }
  // salted and signed like every line the authority writes (§2.4; round-2 review R3): a translated world is a chained log
  const text = seal(r.out, { sign: (m: string) => cust.sign(m) }).map((e: Any) => JSON.stringify(e)).join("\n") + "\n";
  // the strict reader must accept every line, and fold to the translator's own final state, before the file exists
  const back = fold(readLog(text));
  const malformed = back.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed"));
  if (back.status !== "ok" || malformed.length) throw new Error(`the translated log doesn't read back clean (${back.status}, ${malformed.length} malformed: ${JSON.stringify(malformed.slice(0, 3))}): nothing written`);
  // and it carries no account subject anywhere (PROTOCOL §9.2; translate-v1 @16): the translator drops or maps every one whose
  // shape it knows, and a log that still holds one, from a shape it missed, is refused here rather than written for good
  { const acct = accountIn(readLog(text)); if (acct) throw new Error(`the translated log would carry an account subject at seq ${acct.seq}: ${acct.path} (PROTOCOL §9.2: no account subjects in values): nothing written`); }
  // a physics-era world (translate-v1@11): her sim's outcomes are plain logged writes, so nothing in the text may ask a
  // reader to fly an engine (no launch, no digest), and the live host's sim layer (livehost.ts: no catalogue of its own)
  // must read the whole history without one disagreement
  let sim: Any = null;
  if (r.stats.launches !== undefined) {
    const lines = readLog(text); const end = lines.reduce((m: number, e: Any) => (Number.isFinite(e?.ts) && e.ts > m ? e.ts : m), 0);
    const sf = simFold(lines, end, { models: {} });
    const flown = lines.filter((e: Any) => e?.kind === "sim").length;
    if (flown || sf.checks.disagree.length) throw new Error(`the translated world asks a reader to fly (${flown} sim entries) or its sim layer disagrees (${JSON.stringify(sf.checks.disagree.slice(0, 3))}): nothing written`);
    sim = { launches: r.stats.launches, rests: r.stats.rests, agree: sf.checks.agree, engine: back.entities?.["@world"]?.c?.["physics-engine"] ?? null };
  }
  const madeDir = !fs.existsSync(destDir);
  fs.mkdirSync(destDir, { recursive: true });
  const tmp = path.join(destDir, "world.jsonl.tmp");
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, path.join(destDir, "world.jsonl"));
  // from here a failure puts destDir back as it found it (a file this call made is removed, one it changed gets its bytes
  // back), so a rerun isn't refused as "already holds a world"; the shared directory is written last, once nothing can fail
  const touched: Touched = [{ file: path.join(destDir, "world.jsonl"), before: null }];
  try {
    // lead's ruling 10-18: a LOAD never writes, so the translation runs the maintenance command on its own output here: the
    // v1 sockets maps become socket children (lift-sockets, the system's act with by: "translate"); the renames and the shape
    // repair are already in the projection and write nothing. A translated world therefore needs no step when it is served.
    const live = openLive(destDir, world, { catalogue: ENGINE_CATALOGUE, scripts: null });
    const m: Any = maintain(live, { by: "translate" });
    if (m.refused) throw new Error(`the translated world could not be lifted: ${m.refused.code}: ${m.refused.reason}`);
    const maintenance = { lifted: m.steps.lift.made.length, liftFailed: m.steps.lift.failed, renamed: m.steps.rename.renamed.length, repaired: m.repaired.length, entries: live.entries.length };
    if (maintenance.liftFailed.length) throw new Error(`the translated world's seats could not all be lifted: ${JSON.stringify(maintenance.liftFailed).slice(0, 300)}`);
    // v1 bans are the moderator's record in v4 (the authority reads bans only from world.mod.jsonl): file each one there, or a
    // translated world quietly unbans everyone (component review, world-settings #3)
    const banned = Object.entries<Any>(back.entities?.["@world"]?.c ?? {}).filter(([k]) => k.startsWith("imported-bans:"));
    if (banned.length) { const modFile = path.join(destDir, "world.mod.jsonl"); touched.push({ file: modFile, before: fs.existsSync(modFile) ? fs.readFileSync(modFile) : null }); const ml = modLogAt(modFile);
      for (const [k, v] of banned) ml.appendMod({ ts: Number.isInteger(v?.ts) ? v.ts : Date.now(), actor: "system", verb: "ban", who: k.slice("imported-bans:".length), ...(v?.reason ? { reason: String(v.reason) } : {}), translated: true }); }
    // where each person last stood: the old world remembered it by display name; the server remembers it by identity (a
    // name is anyone's to wear), so each name this log knows as one person carries over under that person's id
    const places = carryPoses(srcDir, destDir, idOfName, touched);
    // the model index is a cache of library bytes (what is recorded stays true); the identities go in last
    for (const [h, p] of addressed) recordEido(h, p);
    if (!deferIdentities) dir.put(planned);
    // the approval act (translation-approved, bound to the dry-run report) sits right after the translation's marker, BEFORE the
    // content it approves; the maintenance acts (lift-sockets by: "translate") come at the tail, derived from that approved content
    return { source, unparsed, planned, identities: Object.keys(planned).length, renamedBlobs, addressed: [...addressed.keys()], stats: r.stats, entries: live.entries.length, worldId: back.worldId, digest: digest(live.state()), maintenance, ...places, ...(sim ? { sim } : {}) };
  } catch (x) {
    const undone: string[] = [];
    for (const { file, before } of [...touched].reverse()) try { if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before); undone.push(path.basename(file)); } catch { /* named below as not undone */ }
    if (madeDir) try { if (!fs.readdirSync(destDir).length) fs.rmdirSync(destDir); } catch { /* not empty, or gone */ }
    const left = touched.map((t) => path.basename(t.file)).filter((f) => !undone.includes(f));
    throw new Error(`${(x as Error)?.message ?? x}. Nothing written (${undone.join(", ")} put back as they were${left.length ? `; NOT put back: ${left.join(", ")}` : ""})`);
  }
}

/** The old world's remembered places (poses.json, by display name) under each person's id: {poses: how many carried,
 *  posesDropped: names this log never knew as one person, posesUnread?: why the file couldn't be read or written}. */
type Touched = { file: string; before: Buffer | null }[];   // a file this call wrote, and its bytes before (null: it made it)
function carryPoses(srcDir: string, destDir: string, idOfName: (n: string) => string | undefined, touched: Touched) {
  const oldPoses = path.join(srcDir, "poses.json");
  if (!fs.existsSync(oldPoses)) return { poses: 0, posesDropped: 0 };
  let P: Any;
  try { P = JSON.parse(fs.readFileSync(oldPoses, "utf8")); } catch (x) { return { poses: 0, posesDropped: 0, posesUnread: `poses.json couldn't be read: ${(x as Error).message}` }; }
  const out: Record<string, unknown> = {}; let dropped = 0;
  for (const [n, pose] of Object.entries<Any>(P && typeof P === "object" ? P : {})) { const id = idOfName(n); if (id && pose) out[id] = pose; else dropped++; }
  const n = Object.keys(out).length;
  if (!n) return { poses: 0, posesDropped: dropped };
  const to = path.join(destDir, "poses.json");
  try { const before = fs.existsSync(to) ? fs.readFileSync(to) : null; fs.writeFileSync(to, JSON.stringify(out)); touched.push({ file: to, before }); } catch (x) { return { poses: 0, posesDropped: dropped, posesUnread: `poses.json couldn't be written: ${(x as Error).message}` }; }
  return { poses: n, posesDropped: dropped };
}
