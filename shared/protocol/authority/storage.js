// shared/protocol/authority/storage.js — a world over injected storage, the chain, ops and previews (refactor C11,
// 2026-10-12; moved from authority.js's "storage" section unchanged). A leaf below math and the spatial index (qr3 is the
// rotation a log takes; scratch is the preview the index files). Two lines ride along from elsewhere because this is where
// they are read: VOLATILE (the spatial section's "indexed whole" mark, which scratch propagates) and opsQuiet (the rights
// section's quiet opsOf, which worldOf's presence fold uses).
import { readLog, fold, opsOf, followUpsOf, applyInPlace, cloneState, cowState, applyCow, checkEntry, jcs, sha256, worldIdOf, Malformed, PURGED } from "../fold.js";
import { sha256Bytes, hexBytes } from "../hash.js";
import * as R from "../roles.js";
import { simFold } from "../simlayer.js";
import { r3 } from "../round.js";
import { refuse } from "./refuse.js";
// a state that is changed in place after it's read (a batch's working copy, and previews of it): indexed whole, never
// derived from or kept as the last (a derivation compares entity objects, which such a state changes under them)
const VOLATILE = new WeakSet();
const CHANGE = Symbol("admitted change write");
export const posAt = (e, i) => { if (e && typeof e === "object") Object.defineProperty(e, "seq", { value: i, enumerable: false, configurable: true }); return e; };
/**
 * A world over injected storage.
 * @param {{ name: string, entries: any[], getBlob: (h: string) => any, putBlob: (v: any) => string,
 *   writeLine: (line: string) => void, now: () => number,
 *   presence?: { bodies: object, holds: object }, savePresence?: (p: object) => void }} io
 *   entries: what readLog returned for the log so far, each with its seq attached by posAt (unenumerable).
 *   getBlob must verify a blob against its name and throw if it doesn't match (§2.2).
 *   writeLine appends one already-checked line (no trailing LF) to durable storage.
 *   now: the authority's clock in ms (§2.1 ts); pace (optional): a monotonic ms clock the speed track measures elapsed
 *   time by (a stepped-back wall clock holds `now` still); presence: the unlogged presence plane (P1, P2).
 */
export function worldOf(io) {
  const { name, entries, getBlob, putBlob } = io;
  const w = { name, entries, getBlob, putBlob, exists: entries.length > 0, catalogue: io.catalogue ?? null };
  w.worldId = entries[0] && !(entries[0] instanceof Malformed) ? worldIdOf(entries[0]) : null;
  w.random = io.random ?? null;
  w.kindOf = io.kindOf ?? null; // id → account|anon|imported (the directory: about the account, never what holds it, §6a); only "anon" is read (a guest gets a smaller budget)
  w.nameOf = io.nameOf ?? null; // id → display name (the authority's directory, §2.3); null = old escaped ids only
  w.now = io.now;
  // presence pacing (the speed track): a clock of elapsed ms that no wall-clock step moves; null = pace by w.now
  w.pace = io.pace ?? null;
  // scripts (research 41): the sandbox is injected ({run, checkSyntax, available}: shared/protocol/sandbox.js), never imported
  // here (browsers import this file). No sandbox: scripts install, and every activation says "unavailable".
  w.scripts = io.scripts ?? null;
  // who is present beyond the authority's own bodies (a server's connected people): () => [{id, at: [x,y,z] | null}]
  w.present = io.present ?? null;
  // the presence plane: bodies and holds. Transient, never logged (P1, P2)
  w.presence = io.presence ?? { bodies: {}, holds: {} };
  w.savePresence = () => io.savePresence?.(w.presence);
  // Governance keys (§2.4) live outside the log. Custody is authority practice (§5 identity), injected like storage:
  // io.custody = { sequencer() → "ed25519:…", keyOf(who, make?) → "ed25519:…" | null } (server/filehost.ts keeps the keys).
  w.custody = () => io.custody ?? null;
  // §2.1: moderation lives in a SEPARATE moderator log with the authority's enforcement, never in the world log
  w.mod = io.mod ?? [];
  w.appendMod = (e) => { const r = { ts: Math.floor(w.now()), ...e }; w.mod.push(r); io.appendMod?.(r); };
  let cache = null; // the folded state is a view, rebuilt when the log grows (callers never mutate it)
  // incremental when the new lines are plain entries this server wrote (state/act/sim/say): clone + apply their ops, which
  // is what the fold does for them; anything else (a purge, a governance entry, a malformed line) re-folds from scratch
  w.state = () => { if (cache?.n === entries.length) return cache.st;
    const fresh = entries.slice(cache?.n ?? 0);
    if (cache && cache.st.status === "ok" && fresh.every((e) => isE(e) && ["change", "act", "sim", "say"].includes(e.kind))) {
      const st = cloneState(cache.st); fresh.forEach((e, k) => { if (e.kind === "change") applyInPlace(st, opsOf(e), cache.n + k); });
      return (cache = { n: entries.length, st }).st; }
    return (cache = { n: entries.length, st: fold(entries) }).st; };
  // §2.4 chain heads as a view over the log (the lab authority doesn't sign them): head(i) = sha256(head(i-1) ‖
  // sha256(JCS(skeleton(i)))), exactly as conformance/chain.py computes them. A version is {seq, head} (§3d M7).
  const heads = [];
  w.headAt = (seq) => { for (let i = heads.length; i <= seq && i < entries.length; i++) { const e = entries[i], prev = i === 0 ? "00".repeat(32) : heads[i - 1];
      heads[i] = isE(e) && prev ? chainStep(prev, e) : null; } return heads[seq] ?? null; };
  // §3d H7: every id this world has ever created (a log view, kept incrementally): an id is never reused
  const ever = { n: 0, ids: new Set() };
  w.everIds = () => { for (; ever.n < entries.length; ever.n++) { const e = entries[ever.n]; if (isE(e) && e.kind === "change") for (const o of opsQuiet(e)) if (o.verb === "create") ever.ids.add(o.id); } return ever.ids; };
  w.sim = () => simFold(entries, w.now());
  w.stateAt = (seq) => fold(entries, { until: seq });
  // The authority re-reads every line it writes with the strict reader: it can never write what a reader would refuse.
  // §2.1: ts = the authority's admission time, an integer that never decreases along the log (a clock that steps back,
  // an NTP slew or a VM restore, must not make the authority write a line every reader refuses)
  w.nextTs = () => { let lastTs = 0; for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastTs = entries[i].ts; break; }
    return Math.max(Math.floor(w.now()), lastTs); };
  // §2.4 the chain: "the authority signs at least every write it commits". When custody can sign, every entry after
  // genesis is a chain point {head, sig} (genesis can't be: the world id is the hash of genesis itself). head(i) is
  // over the skeleton, which leaves head/sig out, so headAt reads a signed log and an unsigned one alike.
  const render = (e, seq, chained = false) => {
    const obj = { ...(e.kind === "genesis" ? {} : { world: w.worldId }), ...e, ts: w.pinTs ?? w.nextTs() };
    // §2.4: the chain commits an act/say/sim body as sha256(body.salt ‖ JCS(rest)). Unsalted, a purged chat line (most of
    // the personal data a world holds) can be recovered by guessing it against the commit. So in a chained log every such
    // body carries 16 random bytes (round-2 review R3). Readers take bodies by field, so the salt is invisible to them.
    if (io.custody?.sign && ["act", "say", "sim"].includes(e.kind) && obj.body && typeof obj.body === "object" && !Array.isArray(obj.body) && !("salt" in obj.body))
      obj.body = { ...obj.body, salt: nonce16(w) };
    if (chained && e.kind !== "genesis" && io.custody?.sign && w.worldId) {
      const head = chainStep(seq === 0 ? "00".repeat(32) : w.headAt(seq - 1), obj);
      obj.head = head; obj.sig = io.custody.sign(`eidoverse-head:${w.worldId}:${seq}:${head}`); }
    const line = JSON.stringify(obj);
    const [parsed] = readLog(line); let bad = parsed instanceof Malformed ? parsed : null;
    if (!bad) try { checkEntry(parsed, seq); } catch (x) { bad = x; }
    return { line, parsed, bad };
  };
  // Would these entries, appended in this order, all be lines a reader accepts? Checked BEFORE any is written, so a
  // request is all or nothing (an act is never left without its result, 33 C2). A size or depth cap is a refusal.
  w.fits = (...es) => { for (const [k, e] of es.entries()) { const { bad } = render(e, entries.length + k); if (!bad) continue;
    if (/^cap-/.test(bad.code)) refuse("too-big", `that would be a ${bad.code === "cap-size" ? `${bad.detail}-byte` : "too deeply nested"} ${e.kind} entry; a log line is at most 1 MiB, 64 deep (§1)`, "split it into smaller requests, or put big data in a blob and store its hash");
    throw new Error(`authority bug: would write a malformed entry (${bad.code} ${bad.detail})`); } };
  w.append = (e, token) => {
    if (e.kind === "change" && token !== CHANGE) throw new Error("authority bug: a change entry must come from changeEntry (§7: one gate)");
    w.fits(e); const { line, parsed, bad } = render(e, entries.length, true); const seq = entries.length;
    if (bad) throw new Error(`authority bug: would write a malformed entry (${bad.code} ${bad.detail})`); // e.g. the chain fields tipped it over a cap
    entries.push(posAt(parsed, seq)); Object.defineProperty(parsed, "bytes", { value: line.length, enumerable: false }); io.writeLine(line);
    if (e.kind === "genesis") w.worldId = worldIdOf(parsed);
    w.exists = true; return seq;
  };
  return w;
}
// READBACK (verbclasses.js; engine-scars 4/6c, R 10-17 02:45): the act fields the authority reads back for meaning (an
// undo's chain, a use's capability, a script's sponsor, a sculpt's brush, the request that named an engine build…). §12
// lets the WHOLE body of an act, say or sim entry be purged, so every such read goes through readback(): the body, or
// null when it is purged — named by a purge entry later in the log (the authority's in-memory entry still holds it), or
// already rewritten to its {commit} stub on disk. Null is UNKNOWN, and each reader says what unknown means for it (never
// "the default": a purged cause act must not make an owner's chosen build look stamped, or a handler's write the visitor's).
const purgeIx = new WeakMap();   // entries array → {n, seqs}: purge targets whose whole body is gone, kept incrementally
export function purgedSeqs(w) {
  const E = w.entries; let c = purgeIx.get(E); if (!c) purgeIx.set(E, (c = { n: 0, seqs: new Set() }));
  for (; c.n < E.length; c.n++) { const e = E[c.n];
    if (isE(e) && e.kind === "purge" && Array.isArray(e.body?.values)) for (const t of e.body.values) if (t && typeof t === "object" && Number.isInteger(t.seq) && t.seq < c.n && t.op === undefined) c.seqs.add(t.seq); }
  return c.seqs;
}
const isCommitStub = (b) => !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "commit" || k === "salt");
/** An old entry's body as the authority may read it back, or null when it is purged (unknown). */
export function readback(w, seq) {
  const e = w.entries[seq]; if (!isE(e) || !e.body || typeof e.body !== "object") return null;
  if (!["act", "say", "sim"].includes(e.kind)) return e.body;   // a change's ops and genesis are never purged whole
  if (purgedSeqs(w).has(seq)) return null;
  return isCommitStub(e.body) ? null : e.body;
}
// 16 random bytes as base64url (a genesis nonce, a set's salt). io.random(n) → Uint8Array may be injected (a test that
// compares two runs byte for byte seeds both alike); otherwise Web Crypto, in bun and browsers alike.
const nonce16 = (w) => { const b = w?.random ? w.random(16) : globalThis.crypto.getRandomValues(new Uint8Array(16)); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const isE = (e) => e && !(e instanceof Malformed) && typeof e === "object";
// §2.4 "The chain": the skeleton keeps each set's value and salt only as commit = sha256(salt ‖ JCS(value)), and an
// act/say/sim body only as {commit}; a body or op already {commit} is purged and stays as it is.
const opCommit = (o) => ("commit" in o && !("value" in o) ? o.commit : sha256((o.salt ?? "") + jcs(o.value)));
const skelOp = (o) => { const { value, salt, commit, ...rest } = o; return "value" in o || "commit" in o ? { ...rest, commit: opCommit(o) } : rest; };
const bodyCommit = (b) => { const ks = Object.keys(b); if (ks.length === 1 && ks[0] === "commit") return b.commit; const { salt, ...rest } = b; return sha256((salt ?? "") + jcs(rest)); };
function skeleton(e) {
  const { head, sig, ...s } = e;
  if (["act", "say", "sim"].includes(e.kind)) s.body = { commit: bodyCommit(e.body) };
  else if (e.kind === "change") s.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map((o) => (o?.verb === "set" ? skelOp(o) : o)) } : e.verb === "set" ? skelOp(e.body) : e.body;
  return s;
}
const chainStep = (prevHex, e) => { const b = new Uint8Array(64); b.set(hexBytes(prevHex), 0); b.set(hexBytes(sha256(jcs(skeleton(e)))), 32); return sha256Bytes(b); };
/** Seal a whole log the authority didn't write line by line (a translation): the same salts and chain points render gives
 *  each line it appends (§2.4; round-2 review R3). entries[0] is genesis (never a chain point: the world id is its
 *  hash); every later entry gets a salt on each set and on its act/say/sim body, then {head, sig}. Returns new objects;
 *  `sign(msg)` is the sequencer key's, `random(n)` optional. */
export function seal(entries, { sign, random } = {}) {
  if (typeof sign !== "function") throw new Error("seal needs the sequencer's sign()");
  const w = { random: random ?? null }; const out = []; let prev = "00".repeat(32); const wid = worldIdOf(entries[0]);
  for (let i = 0; i < entries.length; i++) {
    let e = JSON.parse(JSON.stringify(entries[i])); delete e.head; delete e.sig;
    if (i > 0) {
      if (e.kind === "change") { const salt = (o) => (o?.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o);
        e.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map(salt) } : e.verb === "set" ? salt({ verb: "set", ...e.body }) : e.body;
        if (e.verb === "set") { const { verb: _v, ...b } = e.body; e.body = b; } }
      else if (["act", "say", "sim"].includes(e.kind) && e.body && typeof e.body === "object" && !Array.isArray(e.body) && !("salt" in e.body)) e.body = { ...e.body, salt: nonce16(w) };
    }
    prev = chainStep(prev, e);
    if (i > 0) { e.head = prev; e.sig = sign(`eidoverse-head:${wid}:${i}:${prev}`); }
    out.push(e);
  }
  return out;
}
// §3d M7: expect by version is {seq, head}, never a bare seq. A head this history doesn't have at that seq means the
// version was read on a branch that was rewound (or in another world): refused, never compared by seq alone.
function versionSeq(w, v, what) {
  if (!(v && typeof v === "object" && !Array.isArray(v) && Number.isInteger(v.seq) && typeof v.head === "string" && Object.keys(v).length === 2))
    refuse("shape", `${what} is a version {seq, head}, never a bare seq`, "inspect {id} → versions gives {seq, head} for each component; a write's result carries its own seq and head");
  if (v.seq < 0 || v.seq >= w.entries.length || w.headAt(v.seq) !== v.head)
    refuse("other-branch", `${what} {seq: ${v.seq}} names a head this world's history doesn't have at that seq: it was read on a branch that was rewound, or elsewhere`, "inspect again and redo the change on what's here");
  return v.seq;
}
const versionOf = (w, seq) => (seq === undefined || seq === null ? null : { seq, head: w.headAt(seq) });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// PROTOCOL §5 (locks: decided): `lock` keeps the first protocol's meaning, so an imported log's locks carry over
// untranslated. A lock is on when its value is truthy; the authority itself only ever writes `true`.
// A purged value is absent(purged), not a lock. The lab's `pinned` and top-level `locked` are retired.
const lockedC = (c) => { const v = c?.lock; return v !== undefined && v !== PURGED && !!v; };
// lock levels live beside the rank ladder they index (roles.js); re-exported for the door's readers
export { LOCK_LEVELS, lockLevel, lockRank } from "../roles.js";
const { LOCK_LEVELS, lockLevel, lockRank } = R;
// a rotation written to the log: rounded like a position, then made unit again (0.707 per axis is not a unit quaternion,
// and a reader composing it through a parent drifts off unit: review of b398d7e3 #1)
const qr3 = (q) => { const r = q.map(r3); const n = Math.hypot(r[0], r[1], r[2], r[3]); return n > 0 ? r.map((v) => v / n) : [0, 0, 0, 1]; };
const setOp = (id, comp, value) => ({ verb: "set", id, comp, value });
const IMPORTED_ONLY = (comp) => typeof comp === "string" && /^imported(?:-(?:behavior|bans))?(?::|$)/.test(comp);   // imported-epoch is imported:epoch (10-16); imported-guard was never registered
const delOp = (id, comp) => (comp === undefined ? { verb: "delete", id } : { verb: "delete", id, comp });
const createOps = (id, comps) => [{ verb: "create", id }, ...Object.entries(comps).map(([k, v]) => setOp(id, k, v))];
// a preview of ops on st: copy-on-write (the same state applyOps gives, sharing every entity the ops don't touch; values
// are never mutated in place, as a live world's states already share them). A deep copy per preview made a batch of 50
// creates copy a 2 000-thing world 100 times (review 10-06 S0-2).
const scratch = (st, ops) => { const s = applyCow(cowState(st), ops); if (VOLATILE.has(st.entities)) VOLATILE.add(s.entities); return s; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thing";

const opsQuiet = (e) => { try { return opsOf(e); } catch { return []; } };
// (refactor split, 2026-10-17: moved here from authority.js's gate section, beside CHANGE: the gate admits these ops, the
// write path and undo mark them, and a leaf can't reach the gate)
// The authority's own follow-up ops inside a person's write (review r8 M1 / scars M5): clearing the references to what a
// delete removed, and an undo putting back the references that delete cleared. Marked on the op object (a request's JSON
// can't carry a symbol), and admitted like the authority's other follow-ups (rest, system): no rights, key, seniority,
// lock or in-flight check, and no capability scope, so a third party's keyed reference or lock can't veto your delete or
// your undo, and a script deleting what it made isn't refused for a reference outside its scope. Shape and value checks
// still apply. Unity, Unreal and Resonite null such references at read time, attributed to nobody; this is the same rule
// written eagerly (ids are never reused, so it is tidiness, never a resurrection guard).
const FOLLOW_UP = Symbol("follow-up");
const followUp = (o) => { o[FOLLOW_UP] = true; return o; };
export { followUpsOf };
export { CHANGE, FOLLOW_UP, IMPORTED_ONLY, VOLATILE, bodyCommit, chainStep, clone, createOps, delOp, followUp, isE, lockedC, nonce16, opCommit, opsQuiet, qr3, scratch, setOp, skelOp, skeleton, slug, versionOf, versionSeq };
