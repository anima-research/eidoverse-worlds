// tools/protocol/world.ts — found a world, or translate an old (v1) world once, in place or into a new name.
//
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts found <name> --owner <your id> [--title "…"]
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <v1 world> [<new name>] --dry-run (--founder-key <ed25519:…> | --no-founder-key)
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <v1 world> [<new name>] --founder-key <ed25519:…> --approved <report hash> --approve-sig <sig>
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <v1 world> [<new name>] --no-founder-key --approved <report hash> --operator-only-no-owner
//                                                                                      (no founder key = no owner can sign: refused unless this flag says so; the act records that no owner approved)
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts rollback <world> [--discard-changes]       (undo an in-place translation: the old files back, everything it made removed)
//   bun tools/protocol/world.ts owner-key <ed25519:…> <signature>      (the ceremony's check: import-v1/README.md)
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts info <name>
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts repair <name> [--dry-run] [--by <who asked>]     maintenance: lift-sockets, rename-components, repair-shapes (PROTOCOL §4), each recorded
//   WORLDS_DIR=<dir> bun tools/protocol/world.ts repair <name> --rollback [--force]               the pre-repair log put back, byte-identical
//
// The server never makes a world by itself (it serves only worlds in this protocol, and refuses a directory holding only an old log). A directory is a world because it holds world.jsonl
// whose line 0 is a genesis saying {dialect, v: 4}, and only this tool writes one (shell access to the host, like every other operator
// act on world files). `found` runs the authority's own `new` request, so genesis names the owner and the founding act
// writes @world (about, bounds, roles:<owner>) through admit. --owner is the name you join with; it is stamped through
// names.js exactly as the live authority stamps you, so you are the owner when you arrive.
// `translate` reads <v1 world>/log.jsonl, never writes it (R9: the original is kept), runs the importer
// (tools/protocol/import-v1/: 0 divergences required), re-reads the output with the strict reader, and only then writes
// <new name>/world.jsonl. The old directory stays on disk as it was; the server doesn't serve it.
// `translate <v1 world>` alone (R 10-17: "links keep working") translates IN PLACE: into a temporary sibling first, then
// verified (the importer's checks, the result opened as the server opens it, and, where the old server left a
// snapshot.json, the snapshot oracle's agreement with the old engine), and only then swapped in under the original name,
// with the old log kept beside it as log.original.jsonl (snapshot.json → snapshot.original.json): renamed, never
// rewritten. On any failure the original is left as it was, the temporary directory is removed, and it says why. If the
// process itself dies mid-swap (no rollback runs), the next `translate <world>` sees the half-swapped directory and finishes
// the swap (renames and moves only), saying so.
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { WORLDS_DIR } from "../../server/config.ts";
import { directoryFor } from "../../server/directory.ts";
import { foundWorld, isWorldSaved } from "../../server/worldlog.ts";
import { translateV1World, reportV1World, approvalText, approvalProblem, makeApproval, verifySig, type Approval } from "./import-v1/world.ts";
import { contentAddressOf } from "../../server/eidoindex.ts";
import { custodyAt } from "../../server/custody.ts";
import { custodyFileIn } from "../../server/keyfiles.ts";
import { TRANSLATOR } from "./import-v1/translate-v1.js";
import { openLive, isWorldDir } from "../../server/livehost.ts";
import { digest, keyOk } from "../../shared/protocol/fold.js";
import { maintain } from "../../shared/protocol/authority.js";
import { ENGINE_CATALOGUE } from "../../server/modelcatalogue.ts";
import { backupBeforeRepair, sealBackup, dropBackup, rollbackRepair } from "../../server/repairfiles.ts";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k: string) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : undefined; };
const NAME = /^[a-z0-9_-]{1,64}$/i;
const die = (m: string) => { console.error(m); process.exit(1); };

/** An in-place translation keeps the old world's files beside the new one under these names (never written, never deleted). */
const ORIGINAL = { log: "log.original.jsonl", snapshot: "snapshot.original.json", poses: "poses.original.json" } as const;
// the old log's size and sha256 as the translation read it, kept in the temporary sibling (never moved into the world): the
// swap, and the recovery of an interrupted swap, refuse when the old log no longer holds exactly those bytes (review of
// PR #260, world.ts:99: an old server still writing during the conversion would have had its later edits dropped)
const SOURCE = ".source.json";
// …and the identities the translation minted, written to the shared directory only once the swap has succeeded (a failed
// attempt leaves none behind: review of PR #260, import-v1/world.ts:86), or by the recovery that finishes an interrupted one
const IDENTITIES = ".identities.json";
const putIdentities = (planned: Record<string, any>) => { const dir = directoryFor(WORLDS_DIR);
  const fresh = Object.fromEntries(Object.entries(planned).filter(([id]) => !dir.entry(id)));   // a recovery after they landed adds nothing twice
  if (Object.keys(fresh).length) dir.put(fresh); return Object.keys(fresh).length; };
const TEMP_ONLY = new Set([SOURCE, IDENTITIES]);
// what the in-place swap did, kept in the world's directory for `rollback` (review of PR #260, Mica, item 6: "keeping
// log.original.jsonl is preservation, not a tested rollback"): every file it renamed, every file it made (with the bytes it
// made them with), the identities it minted, the report hash and approval it was bound to. Written into the temporary
// sibling before the swap, so the swap (and the recovery of an interrupted one) moves it in like any translated file.
const MANIFEST = "translation.json";
const APPROVAL_TEXT = "approval";
const hostContent = (p: string) => { const h = contentAddressOf(p); return h ? `sha256:${h}` : null; };
/** The dry-run report of an old world as it stands now, hashed (import-v1/world.ts reportV1World). */
const reportNow = (D: string, name: string, founderKey: string | undefined) => reportV1World(D, { founderKey, name, content: hostContent });
/** The approval of THIS translation, or a refusal (PROTOCOL §14; review of PR #260, Mica, item 6: owner/operator COUNTERSIGN).
 *  Bound to the dry-run report's hash: the report is recomputed from the old log as it stands and must hash to what was approved
 *  (else it changed since the owner read it: refused, both hashes named). Two signatures over approvalText(world, hash): the
 *  OWNER's (the founder key, --approve-sig, made on the founder's machine) and the OPERATOR's countersignature (this host's custody
 *  operator key, signed here: whoever runs this tool on the host IS the operator). Both must verify, and both are recorded in the
 *  translation-approved act and translation.json. A world with no founder key has no owner who can sign: REFUSED unless
 *  --operator-only-no-owner, which translates on the operator's signature alone and records that no owner approved.
 *  A report that refuses (deferred features) can't be approved at all. */
function approvalFor(D: string, name: string, founderKey: string | undefined): Approval {
  const approved = flag("approved"), sig = flag("approve-sig"), noOwner = rest.includes("--operator-only-no-owner");
  if (!approved) die(`translating "${name}" needs the owner's approval of its dry-run report first, countersigned by the operator:
  1. bun tools/protocol/world.ts translate ${name} --dry-run ${founderKey ? `--founder-key ${founderKey}` : "--no-founder-key"}   (writes nothing; prints the report and its hash)
`
    + `  2. read it: what is dropped by design, what would be refused, how many entries, guards, models
`
    + (founderKey ? `  3. the founder signs it on their own machine: printf '%s' '${approvalText(name, "<hash>")}' > msg.txt; openssl pkeyutl -sign -inkey eidoverse-owner.pem -rawin -in msg.txt | base64 | tr -d '\n'
  4. translate ${name} --founder-key ${founderKey} --approved <hash> --approve-sig <signature>   (this host's custody operator key countersigns the same text; both signatures are recorded)`
      : `  3. translate ${name} --no-founder-key --approved <hash> --operator-only-no-owner   (no founder key: NO owner can sign, so this is refused unless you say --operator-only-no-owner; the act then records that no owner approved, and the operator's countersignature is the only signature)`)
    + `
Nothing was changed.`);
  if (!/^[0-9a-f]{64}$/.test(approved!)) die(`--approved ${approved}: not a report hash (64 hex, as --dry-run prints it). Nothing was changed.`);
  const { report, hash } = reportNow(D, name, founderKey);
  if (report.refused) die(`${report.refused}
(The approval of ${approved} can't override this: a refusal is not a loss to approve.)`);
  if (hash !== approved) die(`the dry-run report of "${name}" is not the one that was approved: approved ${approved}, but the report of log.jsonl as it stands now hashes to ${hash} `
    + `(${report.source.size} bytes, sha256 ${report.source.sha256.slice(0, 16)}…; translator ${report.translator}, fold ${report.fold}${founderKey ? `, founder key ${founderKey}` : ", no founder key"}). `
    + `The old log, the tool, or the founder key changed since it was read. Run --dry-run again, read the new report, and approve THAT hash. If log.jsonl is still being written to (an old server running), stop it first. Nothing was changed.`);
  const text = approvalText(name, approved!);
  if (founderKey) {
    if (noOwner) die(`--operator-only-no-owner is for a world with no founder key; "${name}" is founded with ${founderKey}, whose holder must sign. Nothing was changed.`);
    if (!sig) die(`--founder-key ${founderKey} needs the founder's signature of the approval: --approve-sig <signature over "${text}">. Nothing was changed.`);
    if (!verifySig(founderKey, text, sig)) die(`the approval signature doesn't verify for ${founderKey} over "${text}": not this founder's approval of this report. Nothing was changed.`);
  } else {
    if (sig) die(`--approve-sig needs --founder-key: whose signature would it be? Nothing was changed.`);
    if (!noOwner) die(`"${name}" has no founder key (tier 0 empty), so no owner can sign this approval, and a translation needs the owner's signature AND the operator's countersignature over the same report. `
      + `To translate on the operator's signature alone, knowing that no owner approved, say so: translate ${name} --no-founder-key --approved ${approved} --operator-only-no-owner. The act will record that no owner approved. Nothing was changed.`);
  }
  // the operator's countersignature: this host's custody operator key signs the same text (never the sequencer key)
  const cust = custodyAt(custodyFileIn(WORLDS_DIR));
  const approval = makeApproval(name, approved!, { founderKey, ownerSig: sig, operator: { key: cust.operator(), sign: (m) => cust.signOperator(m) }, operatorOnlyNoOwner: noOwner });
  const bad = approvalProblem(name, approval); if (bad) die(`the approval is refused: ${bad}. Nothing was changed.`);
  return approval;
}
/** How a translation says who approved: both signatures, or the operator alone with no owner (said plainly). */
const approvalWords = (a: Approval) => a.owner ? `approved by the owner (${a.owner.key}, signature verified) and countersigned by the operator (${a.operator.key}, signature verified)`
  : `approved by the operator alone (${a.operator.key}, signature verified): NO OWNER approved — the world has no founder key, and --operator-only-no-owner was given; the act records this`;
const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
/** `--dry-run`: the report and its hash, printed; nothing written. Exit 1 when the translation would be refused. */
function dryRun(D: string, name: string, founderKey: string | undefined) {
  const { report, hash } = reportNow(D, name, founderKey);
  console.log(`dry-run report of "${name}" (nothing was written):`); console.log(JSON.stringify(report, null, 1));
  console.log(`trial period: ${report.trial}`);
  console.log(`report-hash ${hash}`);
  if (report.refused) { console.error(report.refused); process.exit(1); }
  console.log(`to translate: approve exactly this report. ${founderKey ? `The founder signs "${approvalText(name, hash)}" with their key and you run: translate ${name} --founder-key ${founderKey} --approved ${hash} --approve-sig <signature>   (this host's operator key countersigns the same text)`
    : `translate ${name} --no-founder-key --approved ${hash} --operator-only-no-owner   (no founder key: no owner can sign, so this is refused without the flag; with it, the act records that no owner approved, and the operator's countersignature is the only signature)`}`);
}
const sourceOf = (f: string) => { const b = fs.readFileSync(f); return { size: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex") }; };
const sourceChanged = (f: string, was: { size: number; sha256: string }) => { const now = sourceOf(f); return now.size !== was.size || now.sha256 !== was.sha256 ? now : null; };
const stillWriting = (f: string, was: { size: number }, now: { size: number }) => `${f} changed while it was being translated (${was.size} bytes when it was read, ${now.size} now): something — an old server — is still writing to it, and the translation would leave out what it wrote. Stop the old server, then translate again.`;

/** What a translation says about itself (both forms). */
function report(src: string, dest: string, r: ReturnType<typeof translateV1World>) {
  console.log(`translated "${src}" (${r.stats.in} old entries) → world "${dest}" (${r.entries} entries, ${r.stats.change} change, `
    + `0 divergences, ${r.stats.renamed} actor names escaped, ${r.stats.tsClamped ?? 0} ts clamped); digest ${r.digest}`);
  if (r.renamedBlobs?.length) console.log(`NOTE: ${r.renamedBlobs.length} store blob(s) no longer hash to their names (rewritten after upload); their addresses are of the bytes this host has: ${r.renamedBlobs.join(", ")}`);
  if (r.stats.modelsHashed !== undefined) console.log(`models: kept as library paths; ${r.stats.modelsHashed} with model-hash (sha256:…) beside them${r.stats.modelsUnhashed.length ? `; ${r.stats.modelsUnhashed.length} without (no bytes on this host): ${r.stats.modelsUnhashed.join(", ")}` : ""}`);
  if (r.sim) console.log(`physics: ${r.sim.engine?.engine ?? "the epoch was left"} — ${r.sim.launches} punt(s) became launches, ${r.sim.rests} rest(s) logged where her sim rests them; the authority's sim layer re-checked ${r.sim.agree}/${r.sim.rests}`);
  // PROTOCOL §5: v1 `guard` merges into `lock`, which drops its authorship protection by design. Say so, so the
  // world's owners can be told what changed (and which entities to look at).
  if (r.stats.guards) console.log(`NOTE for the owners: ${r.stats.guards} guarded entities in the v1 world became locked (${r.stats.guardsLive} still guarded at the end). `
    + `Now a lock binds everyone, the placer too, and any builder may lift it; the guard's "only the placer or an owner may change it" is gone (§5).`);
}

/** `translate <world>`: the world keeps its name (links to it keep working). Translated into a temporary sibling, verified,
 *  and only then swapped in: world.jsonl lands in the world's directory in one rename (from then on it is a world), and the
 *  old files are renamed beside it (log.jsonl → log.original.jsonl, snapshot.json → snapshot.original.json, poses.json →
 *  poses.original.json): the same files, never rewritten. Any failure before or during the swap puts back whatever moved,
 *  removes the temporary directory and says why. */
function translateInPlace(name: string, founderKey: string | undefined, approval: Approval) {
  const D = path.join(WORLDS_DIR, name), log = path.join(D, "log.jsonl");
  if (!fs.existsSync(log)) die(`"${name}" holds no old log (${log}): there's nothing to translate here. Nothing was changed.`);
  const fail = (why: string, T?: string): never => {
    if (T) fs.rmSync(T, { recursive: true, force: true });
    die(`${why}\nNothing was moved: "${name}" is exactly as it was (its log.jsonl untouched), and nothing was left behind.`);
    throw 0; };
  // where the old files go must be free, and so must the names the new world's files take
  const taken = [...Object.values(ORIGINAL), "world.jsonl", "world.mod.jsonl", MANIFEST].filter((f) => fs.existsSync(path.join(D, f)));
  if (taken.length) fail(`can't translate "${name}" in place: ${taken.join(", ")} already exist(s) in ${D}, where the translation would put its own.`);
  const before = fs.statSync(log);
  // 1. the old engine's own fold, if the world kept one (snapshot.json): the translator must agree with it
  //    (import-v1/snapshot-oracle.ts, in its own scratch: it writes nothing here)
  let oracleSaid = "no snapshot.json here, so nothing to compare with the old engine";
  if (fs.existsSync(path.join(D, "snapshot.json"))) {
    const o = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "import-v1", "snapshot-oracle.ts"), D], { env: { ...process.env, ORACLE_SUMMARY: "1" } });
    const out = o.stdout.toString() + o.stderr.toString();
    const line = out.split("\n").find((l) => l.startsWith("oracle-summary "));
    let w: any = null; try { w = JSON.parse(line!.slice("oracle-summary ".length))[0]; } catch { /* no summary: the oracle failed to run */ }
    if (!w) fail(`the snapshot check (import-v1/snapshot-oracle.ts) didn't run to the end:\n${out.slice(-2000)}`);
    if (w.error || (!w.skipped && !w.agree)) fail(`the translation doesn't agree with the old engine's own snapshot.json (snapshot-oracle: ${w.error ?? `${w.unexplained} unexplained difference(s)`}):\n${out.split("\n").filter((l) => /DIFF|FAIL|missing|extra/.test(l)).slice(0, 30).join("\n")}`);
    oracleSaid = w.skipped ? `snapshot.json NOT compared: ${w.skipped}` : `snapshot.json agrees: the translation folds to the old engine's own state (${w.entities[1]} entities, ${w.seats} seat(s); snapshot-oracle)`;
  }
  // 2. translate into a temporary sibling (a name the server never serves: it isn't a world name); the importer's own
  //    checks (0 divergences, projection equality, strict read-back) run before it writes anything
  const T = path.join(WORLDS_DIR, `.translating-${name}-${crypto.randomBytes(4).toString("hex")}`);
  let r: ReturnType<typeof translateV1World>;
  try { r = translateV1World(D, T, { founderKey, name, deferIdentities: true, approval }); } catch (x) { fail(`the translation failed: ${(x as Error).message}`, T); throw 0; }
  // 3. the result, opened as the server opens it: a world, folding to the importer's digest
  try { const live = openLive(T, name); const st = live.state();
    if (!isWorldDir(T) || st.status !== "ok" || digest(st) !== r.digest) throw new Error(`opened as the server opens it: ${isWorldDir(T) ? "" : "not a world, "}status ${st.status}, digest ${digest(st)} (the importer said ${r.digest})`); }
  catch (x) { fail(`the translated world didn't verify: ${(x as Error).message}`, T); }
  // 3b. the old log still holds exactly the bytes that were translated (recorded in the temporary sibling, for a recovery too)
  fs.writeFileSync(path.join(T, SOURCE), JSON.stringify(r!.source)); fs.writeFileSync(path.join(T, IDENTITIES), JSON.stringify(r!.planned));
  { const now = sourceChanged(log, r!.source); if (now) fail(stillWriting(log, r!.source, now), T); }
  // 4. the swap. world.jsonl first: one rename makes the directory a world (the old log beside it is ignored from then on)
  const steps: [string, string][] = [[path.join(T, "world.jsonl"), path.join(D, "world.jsonl")], [log, path.join(D, ORIGINAL.log)]];
  if (fs.existsSync(path.join(D, "snapshot.json"))) steps.push([path.join(D, "snapshot.json"), path.join(D, ORIGINAL.snapshot)]);
  if (fs.existsSync(path.join(D, "poses.json"))) steps.push([path.join(D, "poses.json"), path.join(D, ORIGINAL.poses)]);
  // the manifest for `rollback`, written into T first so it moves in with the rest (and with a recovery): what moved, what was
  // made (the bytes as made: a rollback refuses to delete a file the server has written to since, unless told to), who was minted
  const made = fs.readdirSync(T).filter((f) => !TEMP_ONLY.has(f));
  // what the old world's directory held before the swap (r14 M3, 10-18): anything else found there at rollback time — a
  // world.mod.jsonl the server made at its first ban, a repair-backups/ — is the server's, made since: history with nowhere to go
  const present = fs.readdirSync(D);
  fs.writeFileSync(path.join(T, MANIFEST), JSON.stringify({ v: 2, world: name, at: Date.now(), translator: TRANSLATOR, report: approval.report, approval, present,
    source: r!.source, renamed: steps.slice(1).map(([a, b]) => [path.basename(a), path.basename(b)]), made: Object.fromEntries([...made, MANIFEST].map((f) => [f, f === MANIFEST ? null : sha(path.join(T, f))])),
    identities: r!.planned, eido: r!.addressed,
    note: "written by tools/protocol/world.ts translate (in place); read by `rollback <world>`, which puts the renamed files back, removes the made ones and forgets the identities. The content-address index (OPT_DIR/eido-index.json) is a cache of library bytes, not world state: a rollback leaves it." }, null, 1));
  for (const f of fs.readdirSync(T)) if (f !== "world.jsonl" && !TEMP_ONLY.has(f)) steps.push([path.join(T, f), path.join(D, f)]);
  const done: [string, string][] = [];
  const fault = Number(process.env.WORLD_TS_FAULT_AT_STEP ?? NaN);   // tests only: fail as if step k's rename had (tools/protocol/inplace-check.ts)
  const death = Number(process.env.WORLD_TS_DIE_AT_STEP ?? NaN);      // tests only: the process dies after k renames, no rollback (IP13)
  const touch = Number(process.env.WORLD_TS_TOUCH_SOURCE_AT_STEP ?? NaN);   // tests only: a writer appends to the old log after k renames (inplace-check IP14)
  try { for (const [a, b] of steps) { if (done.length === death) process.exit(9); if (done.length === fault) throw new Error(`(injected) step ${done.length} failed`);
      if (done.length === touch) fs.appendFileSync(fs.existsSync(log) ? log : path.join(D, ORIGINAL.log), '{"seq":999,"ts":1,"actor":"late","verb":"say","args":{"text":"written during the swap"}}\n');
      if (fs.existsSync(b)) throw new Error(`${b} appeared during the swap`); fs.renameSync(a, b); done.push([a, b]); }
    // …and once more after the last rename (the same file, renamed beside the world): a write that slipped in mid-swap undoes it
    { const now = sourceChanged(path.join(D, ORIGINAL.log), r!.source); if (now) throw new Error(stillWriting(path.join(D, ORIGINAL.log), r!.source, now)); }
    // the swap has succeeded: only now do its identities join the shared directory (a refusal here, an account taken since,
    // undoes the swap like any other failure)
    if (Number(process.env.WORLD_TS_FAULT_AT_STEP ?? NaN) === steps.length) throw new Error(`(injected) step ${steps.length} failed`);
    putIdentities(r!.planned); }
  catch (x) {
    const stuck: string[] = [];
    for (const [a, b] of done.reverse()) { try { fs.renameSync(b, a); } catch (y) { stuck.push(`${b} (should be ${a}: ${(y as Error).message})`); } }
    if (stuck.length) die(`the swap failed (${(x as Error).message}) and these couldn't be put back; move them by hand:\n  ${stuck.join("\n  ")}\nThe translated files are in ${T}.`);
    fail(`the swap failed: ${(x as Error).message}; everything that had moved was put back.`, T);
  }
  fs.rmSync(T, { recursive: true, force: true });
  const after = fs.statSync(path.join(D, ORIGINAL.log));
  report(name, name, r!);
  console.log(oracleSaid);
  console.log(`in place: "${name}" keeps its name, so links to it keep working. The old log is kept beside it as ${ORIGINAL.log} — the same file, renamed, never written `
    + `(${after.size} bytes, mtime unchanged: ${before.mtimeMs === after.mtimeMs && before.size === after.size && before.ino === after.ino})`
    + `${fs.existsSync(path.join(D, ORIGINAL.snapshot)) ? `, and the old snapshot as ${ORIGINAL.snapshot}` : ""}; ${r!.poses} remembered place(s) carried over by identity`);
  console.log(`approval: report ${approval.report} ${approvalWords(approval)}, recorded in world.jsonl as the system's translation-approved act. `
    + `${MANIFEST} records what the swap did; \`rollback ${name}\` undoes it.`);
}

/** `rollback <world>`: undo an in-place translation from its manifest. The kept originals go back under their names
 *  (renames: the same files), everything the translation made is removed, the identities it minted are forgotten (those still
 *  exactly as it wrote them), and the manifest itself goes last. A made file the server has written to since (world.jsonl grew,
 *  bans were filed) is refused unless --discard-changes: that history has nowhere to go. Stop the server first: one still
 *  serving the world holds it in memory and would write the translated files back. */
function rollback(name: string) {
  const D = path.join(WORLDS_DIR, name), mf = path.join(D, MANIFEST);
  if (!fs.existsSync(mf)) die(`"${name}" holds no ${MANIFEST}: it wasn't translated in place by this tool (or the manifest is gone), so there is nothing here to roll back. Nothing was changed.`
    + (fs.existsSync(path.join(D, ORIGINAL.log)) ? ` (${ORIGINAL.log} is there: an older translation kept it, without a manifest; put it back by hand: rename it to log.jsonl and remove world.jsonl.)` : ""));
  let m: any; try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (x) { die(`${mf} doesn't parse: ${(x as Error).message}. Nothing was changed.`); }
  const discard = rest.includes("--discard-changes");
  // every renamed original must still be there, exactly as recorded for the log; every made file either as made or discarded knowingly
  const missing = m.renamed.filter(([, b]: string[]) => !fs.existsSync(path.join(D, b))).map(([, b]: string[]) => b);
  if (missing.length) die(`can't roll back "${name}": the kept original(s) ${missing.join(", ")} are gone from ${D}. Nothing was changed.`);
  // a name the original goes back to must be free, unless it's one the translation made (removed first, below: the new poses.json)
  const back = m.renamed.filter(([a]: string[]) => fs.existsSync(path.join(D, a)) && !(a in m.made)).map(([a]: string[]) => a);
  if (back.length) die(`can't roll back "${name}": ${back.join(", ")} already exist(s) in ${D}, where the original(s) would go back. Nothing was changed.`);
  const origNow = sourceChanged(path.join(D, ORIGINAL.log), m.source);
  if (origNow) die(`can't roll back "${name}": ${ORIGINAL.log} no longer holds the bytes that were translated (${m.source.size} bytes then, ${origNow.size} now): it was written to, and the original is lost. Nothing was changed.`);
  const changed = Object.entries<string | null>(m.made).filter(([f, h]) => h && fs.existsSync(path.join(D, f)) && sha(path.join(D, f)) !== h).map(([f]) => f);
  // files the server made since the translation (r14 M3): not made by it, not renamed by it, not there before it. The moderator
  // log (bans, mutes, kicks: PROTOCOL §2.1) is the usual one; a repair's backups another. They are history too.
  const known = new Set([...Object.keys(m.made), ...m.renamed.flat(), ...(m.present ?? []), MANIFEST]);
  const since = fs.readdirSync(D).filter((f) => !known.has(f));
  if ((changed.length || since.length) && !discard) die(`can't roll back "${name}" without losing history: ${[...changed.map((f) => `${f} changed since the translation made it`), ...since.map((f) => `${f} was made since the translation${f === "world.mod.jsonl" ? " (the moderator log: bans, mutes, kicks were filed)" : ""}`)].join("; ")} `
    + `(the server has written to the translated world: acts, places, bans). Rolling back deletes that; if that is what you want, say so: rollback ${name} --discard-changes. Nothing was changed.`);
  const did: string[] = [];
  for (const f of Object.keys(m.made)) if (f !== MANIFEST && fs.existsSync(path.join(D, f))) { fs.rmSync(path.join(D, f)); did.push(`removed ${f}${changed.includes(f) ? " (its changes since the translation discarded)" : ""}`); }
  for (const f of since) { fs.rmSync(path.join(D, f), { recursive: true, force: true }); did.push(`removed ${f} (made by the server since the translation; discarded)`); }
  for (const [a, b] of m.renamed) { fs.renameSync(path.join(D, b), path.join(D, a)); did.push(`${b} → ${a}`); }
  const ids = directoryFor(WORLDS_DIR).forgetPlanned(m.identities ?? {});
  if (ids.removed.length) did.push(`forgot ${ids.removed.length} identit${ids.removed.length === 1 ? "y" : "ies"} the translation minted`);
  if (ids.kept.length) did.push(`kept ${ids.kept.length} identit${ids.kept.length === 1 ? "y" : "ies"} the translation minted but someone has bound or renamed since (${ids.kept.join(", ")})`);
  fs.rmSync(mf); did.push(`removed ${MANIFEST}`);
  console.log(`rolled back the translation of "${name}" (report ${m.report}, ${m.approval?.owner ? "approved by the owner and countersigned by the operator" : m.approval?.operator ? "approved by the operator alone, no owner" : `approved by the ${m.approval?.by ?? "unknown"}`}): ${did.join("; ")}. "${name}" is the old-format world it was, byte for byte (the same files, renamed back). `
    + `The content-address index (eido-index.json) is a cache of library bytes, not of this world, and was left. If a server was serving "${name}", restart it.`);
}

/** An in-place swap the process didn't live to finish (review r11 L4): world.jsonl landed (the directory is a world) but
 *  the old files weren't all renamed beside it, or the translated files weren't all moved in. Seen by what's left: the
 *  old log.jsonl still beside world.jsonl, or the temporary sibling (`.translating-<name>-*`) whose world.jsonl has gone.
 *  Null when the directory is a whole translated world (or never was a swap). */
function interruptedSwap(name: string): { D: string; temps: string[]; oldLog: boolean } | null {
  const D = path.join(WORLDS_DIR, name);
  if (!fs.existsSync(path.join(D, "world.jsonl"))) return null;
  const temps = fs.readdirSync(WORLDS_DIR).filter((f) => f.startsWith(`.translating-${name}-`) && /^[0-9a-f]{8}$/.test(f.slice(`.translating-${name}-`.length))
    && !fs.existsSync(path.join(WORLDS_DIR, f, "world.jsonl"))).map((f) => path.join(WORLDS_DIR, f));
  const oldLog = fs.existsSync(path.join(D, "log.jsonl")) && !fs.existsSync(path.join(D, ORIGINAL.log));
  return temps.length || oldLog ? { D, temps, oldLog } : null;
}
/** Finish an interrupted swap, in the swap's own order: the old files renamed beside the world (log.jsonl →
 *  log.original.jsonl, snapshot.json → snapshot.original.json, poses.json → poses.original.json: renames, never writes),
 *  then the rest of the translated files moved in from the temporary sibling, which is then removed. Nothing is deleted
 *  or overwritten: a name already taken on both sides is left where it is and said. */
function finishSwap(name: string, at: { D: string; temps: string[]; oldLog: boolean }) {
  const { D, temps } = at;
  if (temps.length > 1) die(`the in-place translation of "${name}" was interrupted, and more than one temporary directory is left (${temps.join(", ")}): `
    + `move the translated files from the one whose files match ${D}/world.jsonl by hand, and remove the others. log.jsonl, if it's still in ${D}, is the untouched original: rename it to ${ORIGINAL.log}.`);
  // the old log must still be the bytes the interrupted translation read (its temporary sibling recorded them): else an old
  // server wrote to it meanwhile, and finishing would drop those edits. Nothing is moved then.
  if (temps.length && fs.existsSync(path.join(temps[0], SOURCE))) {
    const was = JSON.parse(fs.readFileSync(path.join(temps[0], SOURCE), "utf8"));
    const orig = fs.existsSync(path.join(D, "log.jsonl")) ? path.join(D, "log.jsonl") : path.join(D, ORIGINAL.log);
    const now = fs.existsSync(orig) ? sourceChanged(orig, was) : null;
    if (now) die(`the in-place translation of "${name}" was interrupted, and ${stillWriting(orig, was, now)} Nothing was moved: remove ${D}/world.jsonl and ${temps[0]} (the interrupted translation), then translate again.`);
  }
  const did: string[] = [], stuck: string[] = [];
  const mv = (a: string, b: string) => { if (!fs.existsSync(a)) return; if (fs.existsSync(b)) { stuck.push(`${a} (${b} is already there)`); return; } fs.renameSync(a, b); did.push(`${path.relative(WORLDS_DIR, a)} → ${path.relative(WORLDS_DIR, b)}`); };
  mv(path.join(D, "log.jsonl"), path.join(D, ORIGINAL.log));
  // the old snapshot and poses go only while the swap is visibly unfinished (a temporary directory left): once it's done,
  // a poses.json beside the world is the world's own
  if (temps.length || at.oldLog) { mv(path.join(D, "snapshot.json"), path.join(D, ORIGINAL.snapshot));
    if (fs.existsSync(path.join(D, "poses.json")) && !fs.existsSync(path.join(D, ORIGINAL.poses)) && (!temps.length || fs.existsSync(path.join(temps[0], "poses.json")))) mv(path.join(D, "poses.json"), path.join(D, ORIGINAL.poses)); }
  for (const T of temps) { fs.rmSync(path.join(T, SOURCE), { force: true });
    if (fs.existsSync(path.join(T, IDENTITIES))) { const n = putIdentities(JSON.parse(fs.readFileSync(path.join(T, IDENTITIES), "utf8"))); fs.rmSync(path.join(T, IDENTITIES)); if (n) did.push(`${n} identit${n === 1 ? "y" : "ies"} added to the directory`); }
    for (const f of fs.readdirSync(T)) mv(path.join(T, f), path.join(D, f));
    if (!fs.readdirSync(T).length) { fs.rmSync(T, { recursive: true, force: true }); did.push(`removed ${path.relative(WORLDS_DIR, T)}`); } }
  if (stuck.length) die(`the in-place translation of "${name}" was interrupted; finishing it moved ${did.length ? did.join(", ") : "nothing"}, but these are in the way; move them by hand:\n  ${stuck.join("\n  ")}\n`
    + `${ORIGINAL.log} (or log.jsonl) is the untouched original either way.`);
  console.log(`the in-place translation of "${name}" was interrupted after world.jsonl landed (the process stopped mid-swap); finished it now: ${did.join(", ") || "nothing left to move"}. `
    + `${ORIGINAL.log} is the untouched original log, renamed, never written. "${name}" is a translated world.`);
}

if (cmd === "found") {
  const name = rest[0], owner = flag("owner");
  if (!name || !NAME.test(name) || !owner) die("usage: found <name> --owner <your id> [--title …]");
  const r = foundWorld(path.join(WORLDS_DIR, name), name, owner!, flag("title"));
  console.log(`founded world "${name}" in ${WORLDS_DIR}: world id ${r.worldId}, owner ${r.owner}, ${r.entries} entries`);
} else if (cmd === "owner-key") {
  // the ceremony's check (import-v1/README.md): the founder signed "eidoverse-owner-key:<their key>" with the key's
  // private half, on their own machine. A key that verifies is theirs and is spelled right; genesis holds it forever.
  const [key, sig] = rest;
  if (!key || !sig) die("usage: owner-key <ed25519:…> <signature, base64 or base64url>");
  if (!keyOk(key)) die(`${key}: not a governance key (ed25519:<base64url of 32 bytes>, PROTOCOL §13)`);
  const raw = Buffer.from(key.slice(8), "base64url");
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]), format: "der", type: "spki" });
  const msg = `eidoverse-owner-key:${key}`;
  let good = false; try { good = crypto.verify(null, Buffer.from(msg), pub, Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64")); } catch { good = false; }
  if (!good) die(`the signature doesn't verify for ${key} over "${msg}": nothing is wrong with the world, but this key can't be used until it does`);
  console.log(`ok: ${key} signed "${msg}". Use it: bun tools/protocol/world.ts translate <world> --founder-key ${key}`);
} else if (cmd === "translate") {
  // the words that aren't flags: `translate <world>` (in place) or `translate <old world> <new name>`
  const VALUED = new Set(["--founder-key", "--approved", "--approve-sig"]);   // --operator-only-no-owner, --no-founder-key, --dry-run take no value
  const words = rest.filter((w, i) => !w.startsWith("--") && !VALUED.has(rest[i - 1]));
  const USAGE = "usage: translate <world> [<new name>] --dry-run (--founder-key <ed25519:…> | --no-founder-key)   (the report and its hash; nothing written)\n"
    + "       translate <world> (--founder-key <ed25519:…> --approved <hash> --approve-sig <sig> | --no-founder-key --approved <hash> --operator-only-no-owner)   (in place: it keeps its name; the old log stays beside it as log.original.jsonl; the host's operator key countersigns)\n"
    + "       translate <old world> <new name> (the same approval flags)   (into a new name; the old directory is left as it was)";
  if (!words.length || words.length > 2 || !words.every((w) => NAME.test(w))) die(USAGE);
  const [src, dest] = words;
  { const half = isWorldSaved(src) ? interruptedSwap(src) : null; if (half) { finishSwap(src, half); process.exit(0); } }
  if (isWorldSaved(src)) die(fs.existsSync(path.join(WORLDS_DIR, src, ORIGINAL.log))
    ? `"${src}" is already translated: it's a world in this protocol, and its original old log is kept beside it as ${ORIGINAL.log}. Nothing was changed.`
    : `"${src}" is already a world in this protocol: there's nothing to translate. Nothing was changed.`);
  // the governance draft's GOV-5 (reserved in §13; on the wishlist): nobody can add a key to an empty tier 0 later, so the founder's key goes in now or never
  const founderKey = flag("founder-key");
  if (!founderKey && !rest.includes("--no-founder-key")) die("translate needs the founder's own governance key for tier 0: --founder-key <ed25519:…> (made on their machine and checked with owner-key; import-v1/README.md, \"The Commons ceremony\"). "
    + "--no-founder-key founds it with tier 0 empty, which the governance draft (reserved, §13) never lets anyone fill later");
  const srcDir = path.join(WORLDS_DIR, src);
  if (!fs.existsSync(path.join(srcDir, "log.jsonl"))) die(`"${src}" holds no old log (${path.join(srcDir, "log.jsonl")}): there's nothing to translate here. Nothing was changed.`);
  if (rest.includes("--dry-run")) { dryRun(srcDir, dest ?? src, founderKey); process.exit(0); }
  const approval = approvalFor(srcDir, dest ?? src, founderKey);
  if (dest === undefined) translateInPlace(src, founderKey, approval);
  else {
    const before = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
    const r = translateV1World(path.join(WORLDS_DIR, src), path.join(WORLDS_DIR, dest), { founderKey, approval });
    const after = fs.statSync(path.join(WORLDS_DIR, src, "log.jsonl"));
    report(src, dest, r);
    console.log(`approval: report ${approval.report} ${approvalWords(approval)}, recorded in ${dest}/world.jsonl as the system's translation-approved act`);
    console.log(`the old log was read, not written: ${before.size} bytes, mtime unchanged: ${before.mtimeMs === after.mtimeMs}; ${r.poses} remembered place(s) carried over by identity`);
  }
} else if (cmd === "rollback") {
  const name = rest[0]; if (!name || !NAME.test(name)) die("usage: rollback <world> [--discard-changes]");
  rollback(name);
} else if (cmd === "info") {
  const name = rest[0]; if (!name || !NAME.test(name)) die("usage: info <name>");
  if (!isWorldSaved(name)) die(`${name} is not a world (no world.jsonl with a genesis)`);
  const w = openLive(path.join(WORLDS_DIR, name), name);
  const st = w.state();
  console.log(JSON.stringify({ name, worldId: w.worldId, entries: w.entries.length, status: st.status,
    entities: Object.keys(st.entities).length - 1, entitiesNote: "not counting @world, the world's own entity",
    roles: Object.fromEntries(Object.entries(st.entities["@world"].c).filter(([k]) => k.startsWith("roles:"))), digest: digest(st) }, null, 1));
} else if (cmd === "repair") {
  // reviewer item 9 + lead's ruling (10-18): a load never writes; the three stored-value rewrites are ONE maintenance command. Stop the server that serves the world
  // first (two writers of one log). Recorded: the system's repair-shapes act carries command and --by (PROTOCOL §4); its
  // rollback is the file's: the pre-repair log is kept under <world>/repair-backups/<stamp>/ and --rollback puts it back
  // byte-identical (server/repairfiles.ts), refusing when the log has grown since (unless --force).
  const name = rest[0]; if (!name || !NAME.test(name)) die("usage: repair <name> [--dry-run] [--by <id>] | repair <name> --rollback [--force]");
  if (!isWorldSaved(name)) die(`${name} is not a world (no world.jsonl with a genesis)`);
  const dir = path.join(WORLDS_DIR, name);
  if (rest.includes("--rollback")) {
    const r = rollbackRepair(dir, { force: rest.includes("--force") });
    if (!r.ok) die(`rollback refused: ${r.why}`);
    console.log(`restored ${path.join(dir, "world.jsonl")} from ${r.backup}: ${r.restored.size} bytes, sha256 ${r.restored.sha256} (byte-identical to the pre-repair log; ${r.dropped} bytes written by the repair and since are gone)`);
  } else {
    const w = openLive(dir, name, { catalogue: ENGINE_CATALOGUE, scripts: null });
    const by = flag("by") ?? null, dryRun = rest.includes("--dry-run");
    const say = (r: any) => { const L = r.steps.lift, R = r.steps.rename, P = r.steps.repair;
      console.log(`  lift-sockets:      ${L.made.length} host(s)${L.made.length ? ` (${L.made.map((m: any) => m.host).join(", ")})` : ""}, ${L.failed.length} refused${L.failed.length ? ` ${JSON.stringify(L.failed).slice(0, 300)}` : ""}`);
      console.log(`  rename-components: ${R.renamed.length} rename(s)${R.renamed.length ? ` (${R.renamed.map((x: any) => `${x.id}.${x.from ?? x.component}`).slice(0, 12).join(", ")})` : ""}, ${R.failed.length} refused${R.failed.length ? ` ${JSON.stringify(R.failed).slice(0, 300)}` : ""}`);
      console.log(`  repair-shapes:     ${P.marked ? "already marked (nothing to repair)" : `${P.repaired.length} entity(ies)${P.repaired.length ? ` (${P.repaired.slice(0, 20).join(", ")}${P.repaired.length > 20 ? ", …" : ""})` : ""}, ${P.failed.length} refused${P.failed.length ? ` ${JSON.stringify(P.failed).slice(0, 300)}` : ""}`}`); };
    if (dryRun) { const r = maintain(w, { by, dryRun: true }) as any;
      if (r.refused) die(`repair refused: ${r.refused.code}: ${r.refused.reason}`);
      console.log(`dry run of ${name} (nothing written): lift-sockets, rename-components, repair-shapes`); say(r); process.exit(0); }
    const backup = backupBeforeRepair(dir, { by });
    const n0 = w.entries.length; let r: any;
    try { r = maintain(w, { by }); }
    catch (e) {   // r14 H1 (10-18): a throw from a durable write is AMBIGUOUS (the line's disk state is unknown), never "repaired" and never silently dropped
      if (w.entries.length > n0) sealBackup(backup); else dropBackup(backup);
      die(`repair of ${name} ended AMBIGUOUS: ${(e as Error).message}\n${w.wedged?.log ? `storage failed while writing line ${w.wedgedAt ?? w.entries.length}: whether it is on disk is unknown; the world refuses writes until it is reopened from disk. ` : ""}`
        + `${w.entries.length > n0 ? `${w.entries.length - n0} line(s) of the repair reached the log before it; the pre-repair log is kept at ${backup} (repair ${name} --rollback puts it back)` : "nothing of the repair reached the log (no backup kept)"}`); }
    if (r.refused) { dropBackup(backup); die(`repair refused: ${r.refused.code}: ${r.refused.reason}`); }
    if (w.entries.length === n0) { dropBackup(backup); console.log(`${name} needs nothing: already lifted, renamed and marked; nothing written (no backup kept)`); say(r); process.exit(0); }
    const m = sealBackup(backup);
    console.log(`repaired ${name}: ${w.entries.length - n0} entr(y|ies) appended${by ? `, by ${by}` : ""}`); say(r);
    console.log(`pre-repair log kept: ${backup} (${m.before.size} bytes, sha256 ${m.before.sha256}); to undo: bun tools/protocol/world.ts repair ${name} --rollback`);
  }
} else die("usage: found <name> --owner <id> [--title …] | translate <world> [<new name>] --dry-run … | translate <world> [<new name>] (--founder-key <key> --approved <hash> --approve-sig <sig> | --no-founder-key --approved <hash> --operator-only-no-owner) | rollback <world> [--discard-changes] | owner-key <key> <sig> | info <name>   | repair <name> [--dry-run] [--by <id>] | repair <name> --rollback [--force]   (WORLDS_DIR=<dir>)");
