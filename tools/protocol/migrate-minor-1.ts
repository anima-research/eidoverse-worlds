// tools/protocol/migrate-minor-1.ts — the minor-0 → minor-1 migration: a deterministic pure rename of a stored world log
// (docs/DESIGN-log-vocabulary.md §4.6, §6, D8–D12). Same salts, nonce, ts, entry count and seq; the world id and every
// head are recomputed; the old log is never touched; a receipt and a head map are written beside the new log.
//   bun tools/protocol/migrate-minor-1.ts --out <dir> --custody <keys.json> [--map <earlier run's out dir>] [--dry-run]
//        [--owner-key <world>=<ed25519:…>] [--owner-sig <world>=<ed25519:…>:<base64url sig>] <world dir>…
// A founder-keyed world (tier 0 non-empty) writes nothing without a tier-0 signature over the receipt message that
// --dry-run prints (D12). The only reader of minor 0 is this tool (D1).
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE } from "./common.ts";
import { readLog, jcs, Malformed, MINORS, worldIdOf, fold, digest } from "../../shared/protocol/fold.js";
import { skeleton } from "../../shared/protocol/authority/storage.js";
import { provenanceAt } from "../../server/provenance.ts";
import { sha256, sha256Bytes, hexBytes } from "../../shared/protocol/hash.js";
import { TABLE, TABLE_SHA256, VOCAB_VERSION, MINOR, KINDS, ENVELOPE, BODY, GENESIS, VIEW_MARKER } from "../../shared/protocol/vocab-minor-1.js";
import { custodyAt } from "../../server/custody.ts";

export const IDENTITY = "eidoverse/migrate-minor-1@1";
export const RECEIPT = "migration-receipt.json", HEADMAP = "migration-headmap.json", WORLDMAP = "worldmap.json", LOG = "world.jsonl";
const ZERO = "00".repeat(32), PERSON24 = /^u-[a-z2-7]{24}$/;
const PURGEABLE_OLD = new Set(["act", "say", "sim"]);

export class Refused extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const refuse = (code, msg) => { throw new Refused(code, msg); };

// ---------- the two chains (§0): the old spelling's skeleton is this tool's own (minor 0 is read nowhere else); the new one is the live writer's ----------
const commitOf = (o) => ("commit" in o && !("value" in o) ? o.commit : sha256((o.salt ?? "") + jcs(o.value)));
const skelOp = (o) => { const { value, salt, commit: c, ...rest } = o; return "value" in o || "commit" in o ? { ...rest, commit: commitOf(o) } : rest; };
const bodyCommit = (b) => { const ks = Object.keys(b); if (ks.length === 1 && ks[0] === "commit") return b.commit; const { salt, ...rest } = b; return sha256((salt ?? "") + jcs(rest)); };
export const oldSkeleton = (e) => {
  const { head, sig, ...s } = e;
  if (PURGEABLE_OLD.has(e.kind)) s.body = { commit: bodyCommit(e.body) };
  else if (e.kind === "change") s.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map((o) => (o?.verb === "set" ? skelOp(o) : o)) } : e.verb === "set" ? skelOp(e.body) : e.body;
  return s;
};
export const newSkeleton = skeleton;
const step = (prevHex, skel) => { const b = new Uint8Array(64); b.set(hexBytes(prevHex), 0); b.set(hexBytes(sha256(jcs(skel))), 32); return sha256Bytes(b); };
/** Every head of a log, seq 0 included (the genesis head is computed, never stored: storage.js lowHeads). */
export const headsOf = (entries, skeleton) => { const out = []; let prev = ZERO; for (const e of entries) out.push((prev = step(prev, skeleton(e)))); return out; };

// ---------- the rename (D3), key order kept so the output bytes are a function of the input bytes ----------
const renameKeys = (o, map) => { const out = {}; for (const k of Object.keys(o)) out[map[k] ?? k] = o[k]; return out; };
const isObj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
export function renameEntry(e, seq) {
  for (const k of ENVELOPE.refuse) if (k in e) refuse("envelope", `seq ${seq} carries '${k}', which no writer ever wrote (D4): not a migration`);
  const kind = KINDS[e.kind]; if (!kind) refuse("kind", `seq ${seq}: unknown kind ${JSON.stringify(e.kind)}`);
  const out = {};
  for (const k of Object.keys(e)) {
    if (ENVELOPE.strip.includes(k)) continue;
    if (k === "kind") { out.kind = kind; continue; }
    if (k === "verb") { if (ENVELOPE.verbToOp.includes(kind)) out.op = e.verb; else if (ENVELOPE.verbKept.includes(kind)) out.verb = e.verb; continue; }
    if (k === "body") { out.body = renameBody(kind, e, seq); continue; }
    out[k] = e[k];
  }
  return out;
}
function renameBody(kind, e, seq) {
  const b = e.body; if (!isObj(b)) return b;
  if (kind === "change") {
    const top = renameKeys(b, BODY.change);
    if (e.verb === "batch" && Array.isArray(top.ops)) top.ops = top.ops.map((o) => (isObj(o) ? renameKeys(o, BODY.changeOp) : o));
    return top;
  }
  if (kind === "request") { const stub = Object.keys(b).length === 1 && "commit" in b; return renameKeys(b, stub ? { commit: BODY.request.commit } : { ...("refused" in b ? BODY.request.refused : BODY.request.admitted), ...(e.verb === "script" ? BODY.request.script : {}), commit: BODY.request.commit }); }
  if (kind === "physics") return renameKeys(b, { ...(e.verb === "checkpoint" ? BODY.physics.checkpoint : {}), commit: BODY.physics.commit });
  if (kind === "say") return renameKeys(b, BODY.say);
  if (kind === "redaction") return { ...b, ...(Array.isArray(b.values) ? { values: b.values.map((t) => (isObj(t) ? renameKeys(t, BODY.redaction.target) : t)) } : {}) };
  return b;
}
function renameGenesis(g, provenance, sequencer) {
  const body = {};
  for (const k of Object.keys(g.body)) { if (k === "minor") body.minor = MINOR.to; else if (k === "sequencer") body.sequencer = sequencer; else body[GENESIS[k] ?? k] = g.body[k]; }
  body.provenance = provenance;
  const out = {}; for (const k of Object.keys(g)) { if (k === "verb") continue; out[k] = k === "body" ? body : g[k]; }
  return out;
}

// ---------- founding provenance (F-2): this tool's own, from the tree it runs ----------
export function provenanceOf() {
  const provenance = provenanceAt(ENGINE, "migrate-minor-1", "1.0.0");
  return { commit: provenance.writer.sourceRevision.replace(/^git:sha(?:1|256):/, ""), provenance };
}

// ---------- the minor-0 reader (D1, M2): the old fold's snapshot, or the live fold while it still knows minor 0 ----------
export async function oldFold() {
  const snap = path.join(ENGINE, "spec/kernel-vectors/minor-1/old-fold.js");
  if (fs.existsSync(snap)) return await import(snap);
  if (MINORS.has(0)) return await import("../../shared/protocol/fold.js");
  throw new Error("no minor-0 reader: spec/kernel-vectors/minor-1/old-fold.js is missing and the live fold no longer knows minor 0");
}

// ---------- keys ----------
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
export const verifies = (key, msg, sig) => { try { return crypto.verify(null, Buffer.from(msg, "utf8"), crypto.createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(key.slice(8), "base64url")]), format: "der", type: "spki" }), Buffer.from(sig, "base64url")); } catch { return false; } };
/** The receipt message every signature covers: the receipt minus the three signatures, JCS. */
export const receiptMessage = (r) => { const { operatorSig, sequencerSig, ...m } = r; if (isObj(m.ownerAttested)) m.ownerAttested = { key: m.ownerAttested.key }; return jcs(m); };
/** Merkle root over ordered (seq, oldHead, newHead) rows: leaf = sha256(jcs([seq, old, new])), node = sha256(left ‖ right as hex text), an unpaired node carries up. */
export function merkleRoot(rows) {
  let level = rows.map((r) => sha256(jcs(r))); if (!level.length) return sha256("");
  while (level.length > 1) { const next = []; for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? sha256(level[i] + level[i + 1]) : level[i]); level = next; }
  return level[0];
}

// ---------- one world ----------
const salts = (entries) => { const out = []; const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (isObj(v)) { if (typeof v.salt === "string") out.push(v.salt); for (const k of Object.keys(v)) walk(v[k]); } }; entries.forEach(walk); return out; };
const tier0 = (g) => g.body.owners?.[0] ?? [];
const inTiers = (g, key, from = 1) => (g.body.owners ?? []).slice(from).some((t) => t.includes(key));

/** Plan one world's migration in memory. `parents` resolves an old world id to {newWorldId, heads(old), newHeads, entries}. Throws Refused. */
export async function planWorld({ name, bytes, parents, custody, ownerSig, ownerKey, provenance, commit, receiptExists, now }) {
  const old = readLog(bytes);
  old.forEach((e, i) => { if (e instanceof Malformed) refuse("malformed", `${name}: seq ${i} is malformed (${e.code}): not a migration`); });
  const g = old[0];
  if (!g || g.kind !== "genesis" || !isObj(g.body)) refuse("no-genesis", `${name}: entry 0 is not a genesis`);
  if (receiptExists || g.body.minor !== MINOR.from) refuse("already-migrated", `${name}: ${receiptExists ? "holds a migration receipt" : `genesis minor is ${JSON.stringify(g.body.minor)}, not ${MINOR.from}`}: a world is translated once, never re-id'd (D9)`);
  const gov = old.map((e, i) => (e.kind === "sequencer" ? i : -1)).filter((i) => i >= 0);
  if (gov.length) refuse("governance", `${name}: holds a governance entry at seq ${gov.join(", ")}: its id is frozen for good (D11); refused, nothing written`);
  for (let i = 1; i < old.length; i++) { const e = old[i]; if (e.kind !== "change") continue;
    const ops = e.verb === "batch" ? e.body.ops ?? [] : [e.body];
    for (const o of ops) if (isObj(o) && PERSON24.test(o.id)) refuse("collision", `${name}: entity id ${o.id} at seq ${i} wears the reserved person shape u-[a-z2-7]{24} (P3): resolve by hand, refused`); }
  const oldHeads = headsOf(old, oldSkeleton);
  for (let i = 1; i < old.length; i++) if (typeof old[i].head === "string" && old[i].head !== oldHeads[i]) refuse("chain-broken", `${name}: the stored head at seq ${i} is not the chain's: not a migration`);
  // authority (D12)
  const operatorKey = custody.operator(), sequencerKey = custody.sequencer();
  if (!inTiers(g, operatorKey)) refuse("operator", `${name}: this custody's operator key is not in the old genesis's tiers above tier 0: not this host's world to migrate`);
  const founderKeyed = tier0(g).length > 0;
  if (founderKeyed) { const k = ownerSig?.key ?? ownerKey ?? tier0(g)[0]; if (!tier0(g).includes(k)) refuse("owner", `${name}: ${k} is not a tier-0 key of the old genesis`);
    if (!ownerSig && !now.dryRun) refuse("owner", `${name}: founder-keyed (tier 0 holds ${tier0(g).length} key(s)); a tier-0 signature over the receipt message is required before any output (D12): --dry-run prints the message, nothing written`); }
  // fork parent (§6 steps 2–4) and founding provenance (3a), through one map
  const oldWorldId = worldIdOf(g);
  const rowOf = (what, wid, seq, oldHead) => {
    const p = parents(wid);
    if (!p) refuse("parent-unmapped", `${name}: its ${what} names world ${wid} at seq ${seq ?? "last"}, which is not in this run and in no supplied map: refused until the parent's receipt is supplied (§6 step 4)`);
    const at = seq ?? p.entries.length - 1;
    if (!(at < p.entries.length)) refuse("parent-seq", `${name}: its ${what} names seq ${at} of ${wid}, which has ${p.entries.length} entries`);
    if (oldHead !== undefined && p.heads[at] !== oldHead) refuse("parent-head", `${name}: its ${what} names head ${oldHead} at seq ${at} of ${wid}, whose head there is ${p.heads[at]}`);
    return { world: p.newWorldId, head: p.newHeads[at], parent: p, seq: at };
  };
  let newG = renameGenesis(g, provenance, sequencerKey), parentRow = null;
  if (isObj(g.body.parent)) { const { world, seq, head } = g.body.parent; parentRow = rowOf("genesis parent", world, seq, head); newG.body.parent = { world: parentRow.world, seq, head: parentRow.head }; }
  const out = [newG];
  for (let i = 1; i < old.length; i++) {
    const e = renameEntry(old[i], i);
    if (e.kind === "request" && isObj(e.body.args?.from) && typeof e.body.args.from.world === "string") { const f = e.body.args.from; const r = rowOf(`founding 'from' at seq ${i}`, f.world, f.seq, f.head); e.body = { ...e.body, args: { ...e.body.args, from: { ...f, world: r.world, head: r.head } } }; }
    out.push(e);
  }
  const newWorldId = worldIdOf(newG);
  for (let i = 1; i < out.length; i++) out[i].world = newWorldId;
  const newHeads = headsOf(out, newSkeleton);
  for (let i = 1; i < out.length; i++) { out[i].head = newHeads[i]; out[i].sig = custody.sign(`eidoverse-head:${newWorldId}:${i}:${newHeads[i]}`); }
  // 3b: the head written for a parent equals the parent's new chain at that seq, recomputed from the parent's new entries, never read off its map
  if (parentRow) { const want = headsOf(parentRow.parent.entries.slice(0, parentRow.seq + 1), newSkeleton)[parentRow.seq]; if (newG.body.parent.head !== want) refuse("parent-head", `${name}: the rewritten parent.head ${newG.body.parent.head} is not the parent's new head ${want} at seq ${parentRow.seq}`); }
  // determinism (B1): what a pure rename may never change
  if (out.length !== old.length) refuse("determinism", `${name}: entry count changed`);
  for (let i = 1; i < old.length; i++) if (out[i].ts !== old[i].ts) refuse("determinism", `${name}: ts changed at seq ${i}`);
  if (newG.body.nonce !== g.body.nonce) refuse("determinism", `${name}: nonce changed`);
  const s0 = salts(old), s1 = salts(out); if (s0.length !== s1.length || s0.some((s, i) => s !== s1[i])) refuse("determinism", `${name}: a salt was added, dropped or changed`);
  // state digests under the minor-0 reader; the new digest differs only by the view marker (§4.6)
  const F = await oldFold(); const st = F.fold(old);
  if (st.status !== "ok") refuse("old-reader", `${name}: the minor-0 reader gives status ${st.status}: not a migration`);
  const view = F.canonicalView(st); let redactions = 0;
  for (const id of Object.keys(view)) for (const c of Object.keys(view[id])) if (view[id][c].purged === true) { view[id][c] = { [VIEW_MARKER.purged]: true }; redactions++; }
  const oldStateDigest = F.digest(st), newStateDigest = sha256(jcs(view));
  // the live minor-1 reader folds the output to that digest, or it is no migration
  const nst = fold(out); if (nst.status !== "ok" || digest(nst) !== newStateDigest) refuse("new-reader", `${name}: the minor-1 reader gives ${nst.status === "ok" ? `digest ${digest(nst)}, not the renamed view's ${newStateDigest}` : `status ${nst.status}`}: not a migration`);
  const lines = out.map((e) => JSON.stringify(e)).join("\n") + "\n", newBytes = new TextEncoder().encode(lines);
  const headMap = out.map((_, i) => [i, oldHeads[i], newHeads[i]]), headMapBytes = new TextEncoder().encode(JSON.stringify(headMap) + "\n");
  const receipt = {
    oldLogSha256: sha256Bytes(bytes), newLogSha256: sha256Bytes(newBytes), oldWorldId, newWorldId, oldMinor: MINOR.from, newMinor: MINOR.to,
    deterministic: true, vocabulary: `${VOCAB_VERSION}@${commit}`, vocabularySha256: TABLE_SHA256, entries: out.length,
    oldLastHead: oldHeads.at(-1), newLastHead: newHeads.at(-1), headMap: merkleRoot(headMap), headMapSha256: sha256Bytes(headMapBytes),
    oldStateDigest, newStateDigest, digestDelta: redactions ? "redaction-marker" : "none", governanceEntries: 0,
    translator: { commit, identity: IDENTITY }, provenance, oldSequencerKey: g.body.sequencer, newSequencerKey: sequencerKey,
    operatorKey, ownerAttested: founderKeyed ? { key: ownerSig?.key ?? ownerKey ?? tier0(g)[0] } : false,
  };
  const msg = receiptMessage(receipt);
  if (founderKeyed && ownerSig) { if (!verifies(ownerSig.key, msg, ownerSig.sig)) refuse("owner", `${name}: the tier-0 signature does not verify over the receipt message (sign exactly what --dry-run prints)`); receipt.ownerAttested = { key: ownerSig.key, sig: ownerSig.sig }; }
  receipt.operatorSig = custody.signOperator(msg); receipt.sequencerSig = custody.sign(msg);
  return { name, entries: out, bytes: newBytes, headMap, headMapBytes, receipt, message: msg, oldWorldId, newWorldId, heads: oldHeads, newHeads, oldEntries: old };
}

/** What a verifier checks on a receipt beside its old and new genesis: [] when it verifies, else the reasons. */
export function verifyReceipt(r, oldG, newG) {
  const bad = []; const msg = receiptMessage(r);
  if (r.oldWorldId !== worldIdOf(oldG)) bad.push("oldWorldId is not the old genesis's hash");
  if (r.newWorldId !== worldIdOf(newG)) bad.push("newWorldId is not the new genesis's hash");
  if (r.deterministic !== true || r.governanceEntries !== 0 || r.oldMinor !== MINOR.from || r.newMinor !== MINOR.to) bad.push("a fixed field is off (deterministic, governanceEntries, minors)");
  if (r.vocabularySha256 !== TABLE_SHA256) bad.push("vocabularySha256 is not this rename table's");
  if (!inTiers(oldG, r.operatorKey)) bad.push("operatorKey is not in the old genesis's tiers above tier 0");
  if (!verifies(r.operatorKey, msg, r.operatorSig)) bad.push("operatorSig does not verify");
  if (r.newSequencerKey !== newG.body.sequencer || !verifies(r.newSequencerKey, msg, r.sequencerSig)) bad.push("sequencerSig is not the new genesis sequencer's");
  const t0 = tier0(oldG);
  if (t0.length) { if (!isObj(r.ownerAttested) || !t0.includes(r.ownerAttested.key) || !verifies(r.ownerAttested.key, msg, r.ownerAttested.sig)) bad.push("founder-keyed: ownerAttested must be a verifying tier-0 signature (D12)"); }
  else if (r.ownerAttested !== false && !(isObj(r.ownerAttested) && verifies(r.ownerAttested.key, msg, r.ownerAttested.sig))) bad.push("ownerAttested is neither false nor a verifying signature");
  return bad;
}

// ---------- a run over many worlds: parents before children, one map ----------
const depthOrder = (worlds) => { const byId = new Map(worlds.map((w) => [w.oldWorldId, w])); const depth = (w, seen = new Set()) => { const p = w.parentId && byId.get(w.parentId); return p && !seen.has(w.oldWorldId) ? 1 + depth(p, seen.add(w.oldWorldId)) : 0; }; return [...worlds].sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name)); };
/** Read an earlier run's out dir as parent rows (old world id → row). */
export function mapFrom(dir) {
  const rows = new Map(); if (!dir || !fs.existsSync(path.join(dir, WORLDMAP))) return rows;
  for (const n of fs.readdirSync(dir)) { const d = path.join(dir, n); if (!fs.existsSync(path.join(d, RECEIPT))) continue;
    const receipt = JSON.parse(fs.readFileSync(path.join(d, RECEIPT), "utf8")), hm = JSON.parse(fs.readFileSync(path.join(d, HEADMAP), "utf8")), entries = readLog(fs.readFileSync(path.join(d, LOG)));
    rows.set(receipt.oldWorldId, { newWorldId: receipt.newWorldId, heads: hm.map((r) => r[1]), newHeads: hm.map((r) => r[2]), entries }); }
  return rows;
}
/** Migrate `inputs` [{name, dir}] in memory; returns {done: Map name→plan, refused: Map name→Refused}. Writes nothing. */
export async function planRun(inputs, { custody, map = new Map(), ownerSigs = {}, ownerKeys = {}, dryRun = false }) {
  const { commit, provenance } = provenanceOf();
  const worlds = inputs.map(({ name, dir }) => { const bytes = fs.readFileSync(path.join(dir, LOG)); const g = readLog(bytes)[0]; return { name, dir, bytes, oldWorldId: isObj(g) && g.kind === "genesis" ? worldIdOf(g) : null, parentId: isObj(g?.body?.parent) ? g.body.parent.world : null, receiptExists: fs.existsSync(path.join(dir, RECEIPT)) }; });
  const done = new Map(), refused = new Map(), rows = new Map(map);
  for (const w of depthOrder(worlds)) {
    try { const p = await planWorld({ ...w, parents: (id) => rows.get(id), custody, ownerSig: ownerSigs[w.name], ownerKey: ownerKeys[w.name], provenance, commit, now: { dryRun } });
      done.set(w.name, p); rows.set(p.oldWorldId, { newWorldId: p.newWorldId, heads: p.heads, newHeads: p.newHeads, entries: p.entries }); }
    catch (x) { if (!(x instanceof Refused)) throw x; refused.set(w.name, x); }
  }
  return { done, refused, worldmap: Object.fromEntries([...rows].map(([o, r]) => [o, r.newWorldId])) };
}
/** Write a run's outputs under `out`: <name>/world.jsonl, receipt, head map; worldmap.json. The inputs are never touched. */
export function writeRun(out, run) {
  for (const p of run.done.values()) { const d = path.join(out, p.name); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, LOG), p.bytes); fs.writeFileSync(path.join(d, HEADMAP), p.headMapBytes); fs.writeFileSync(path.join(d, RECEIPT), JSON.stringify(p.receipt, null, 1) + "\n"); }
  fs.writeFileSync(path.join(out, WORLDMAP), JSON.stringify(run.worldmap, null, 1) + "\n");
}

if (import.meta.main) {
  const a = process.argv.slice(2), opt = { dirs: [], ownerSigs: {}, ownerKeys: {} };
  for (let i = 0; i < a.length; i++) { const k = a[i], v = a[i + 1];
    if (k === "--out") { opt.out = v; i++; } else if (k === "--custody") { opt.custody = v; i++; } else if (k === "--map") { opt.map = v; i++; } else if (k === "--dry-run") opt.dryRun = true;
    else if (k === "--owner-sig") { const m = /^([^=]+)=(ed25519:[^:]+):(.+)$/.exec(v); if (!m) { console.log("--owner-sig <world>=<ed25519:key>:<base64url sig>"); process.exit(2); } opt.ownerSigs[m[1]] = { key: m[2], sig: m[3] }; i++; }
    else if (k === "--owner-key") { const m = /^([^=]+)=(ed25519:.+)$/.exec(v); if (!m) { console.log("--owner-key <world>=<ed25519:key>"); process.exit(2); } opt.ownerKeys[m[1]] = m[2]; i++; }
    else opt.dirs.push(k); }
  if (!opt.custody || !opt.dirs.length || (!opt.out && !opt.dryRun)) { console.log("usage: migrate-minor-1.ts --out <dir> --custody <keys.json> [--map <dir>] [--dry-run] [--owner-key w=k] [--owner-sig w=k:sig] <world dir>…"); process.exit(2); }
  const run = await planRun(opt.dirs.map((d) => ({ name: path.basename(path.resolve(d)), dir: d })), { custody: custodyAt(opt.custody), map: mapFrom(opt.map), ownerSigs: opt.ownerSigs, ownerKeys: opt.ownerKeys, dryRun: !!opt.dryRun });
  for (const [n, x] of run.refused) console.log(`REFUSED ${n}: ${x.message}`);
  if (opt.dryRun) { for (const p of run.done.values()) console.log(`DRY ${p.name} ${p.oldWorldId} -> ${p.newWorldId}\n  sign this message with a tier-0 key, then pass --owner-sig ${p.name}=<key>:<sig>\n  ${p.message}`); }
  else { fs.mkdirSync(opt.out, { recursive: true }); writeRun(opt.out, run); for (const p of run.done.values()) console.log(`migrated ${p.name}: ${p.oldWorldId} -> ${p.newWorldId} (${p.entries.length} entries, ${p.receipt.digestDelta})`); }
  process.exit(run.refused.size ? 1 : 0);
}
