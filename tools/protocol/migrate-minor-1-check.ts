// tools/protocol/migrate-minor-1-check.ts — the migration's fixtures (docs/DESIGN-log-vocabulary.md §5: F13, F15–F20) over
// synthetic minor-0 worlds built here in a scratch dir, plus a third party's recomputation of the id and heads from the
// old bytes, and one source mutant per guard (each must turn its row red).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/migrate-minor-1-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENGINE, scratch } from "./common.ts";
import { readLog, jcs, worldIdOf, fold } from "../../shared/protocol/fold.js";
import { sha256, sha256Bytes, hexBytes } from "../../shared/protocol/hash.js";
import { TABLE } from "../../shared/protocol/vocab-minor-1.js";
import { custodyAt } from "../../server/custody.ts";
import * as M from "./migrate-minor-1.ts";

let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log(`ok   ${name}`); } else { fail++; console.log(`FAIL ${name}${info === undefined ? "" : " — " + JSON.stringify(info).slice(0, 400)}`); } };
const D = scratch("migrate");

// ---------- keys and custody (a scratch keys file in server/custody.ts's layout) ----------
const mk = () => { const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519"); return { pub: "ed25519:" + publicKey.export({ format: "jwk" }).x, priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), key: privateKey }; };
const signWith = (k, msg) => crypto.sign(null, Buffer.from(msg, "utf8"), k.key).toString("base64url");
const SEQ = mk(), OP = mk(), FOUNDER = mk(), STRANGER = mk();
const custodyFile = (seq, op, tag) => { const f = path.join(D, `custody-${tag}.json`); fs.writeFileSync(f, JSON.stringify({ sequencer: { pub: seq.pub, priv: seq.priv }, operator: { pub: op.pub, priv: op.priv }, holders: {} })); return f; };
const CUSTODY = custodyAt(custodyFile(SEQ, OP, "host"));

// ---------- an independent minor-0 chain (spec/conformance/chain.py, written here without the tool) ----------
const commit = (salt, v) => sha256(salt + jcs(v));
const oldSkel = (e) => { const { head, sig, ...s } = e;
  if (["act", "say", "sim"].includes(e.kind)) { const b = e.body; s.body = { commit: Object.keys(b).length === 1 && "commit" in b ? b.commit : commit(b.salt ?? "", Object.fromEntries(Object.entries(b).filter(([k]) => k !== "salt"))) }; }
  else if (e.kind === "change") { const so = (o) => { const { value, salt, commit: c, ...r } = o; return "value" in o || "commit" in o ? { ...r, commit: "commit" in o && !("value" in o) ? o.commit : commit(salt ?? "", value) } : r; };
    s.body = e.verb === "batch" ? { ...e.body, ops: e.body.ops.map((o) => (o.verb === "set" ? so(o) : o)) } : e.verb === "set" ? so(e.body) : e.body; }
  return s; };
const stepHex = (prev, skel) => { const b = new Uint8Array(64); b.set(hexBytes(prev), 0); b.set(hexBytes(sha256(jcs(skel))), 32); return sha256Bytes(b); };
const chain = (entries, skel) => { const h = []; let p = "00".repeat(32); for (const e of entries) h.push((p = stepHex(p, skel(e)))); return h; };
/** Seal a minor-0 log: world on every line after genesis, heads and sequencer sigs; returns {entries, heads, id}. */
const seal = (entries, seqKey = SEQ) => { const id = worldIdOf(entries[0]); const out = entries.map((e, i) => (i ? { world: id, ...e } : e)); const heads = chain(out, oldSkel);
  for (let i = 1; i < out.length; i++) { out[i].head = heads[i]; out[i].sig = signWith(seqKey, `eidoverse-head:${id}:${i}:${heads[i]}`); } return { entries: out, heads, id }; };
const salt = (n) => Buffer.from(String(n).padStart(16, "s")).toString("base64url");
const nonceOf = (tag) => Buffer.from(`nonce-${tag}`.padEnd(16, "!")).toString("base64url");
const genesis = (tag, extra = {}, owners = [[], [OP.pub]]) => ({ kind: "genesis", actor: "system", verb: "genesis", body: { dialect: "eidoverse-log", v: 4, minor: 0, nonce: nonceOf(tag), owners, sequencer: SEQ.pub, rewind_window: 500, ...extra } });
const U = "u-" + "a".repeat(20);
const ID24 = "u-" + "b".repeat(24);
const write = (name, sealed) => { const d = path.join(D, "worlds", name); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, M.LOG), sealed.entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); return { name, dir: d, ...sealed }; };

// ---------- the fixture worlds ----------
// A: custodial default, every old kind, a purge that rewrote three stored lines to commit stubs, a `by` to strip, a checkpoint
function worldA() {
  const e = [genesis("a"),
    { kind: "act", ts: 1001, actor: U, verb: "create-world", body: { request: { title: "A" }, salt: salt(1) } },
    { kind: "change", ts: 1001, actor: U, cause: 1, verb: "batch", body: { ops: [{ verb: "create", id: "chair" }, { verb: "set", id: "chair", comp: "label", value: "x", salt: salt(2) }], followUps: [1] } },
    { kind: "say", ts: 1002, actor: U, by: U, verb: "say", body: { text: "hi", salt: salt(3) } },
    { kind: "sim", ts: 1002, actor: U, cause: 1, verb: "launch", body: { id: "chair", p: [0, 1, 0], v: [0, 0, 0], salt: salt(4) } },
    { kind: "change", ts: 1003, actor: U, cause: 1, verb: "set", body: { id: "chair", comp: "note", value: "secret", salt: salt(5) } },
    { kind: "act", ts: 1004, actor: "bob", verb: "delete", body: { args: ["id"], refused: { code: "locked" }, salt: salt(6) } },
    { kind: "purge", ts: 1005, actor: "system", verb: "purge", body: { values: [{ seq: 5 }, { seq: 2, op: 1 }, { seq: 3 }] } },
    { kind: "sim", ts: 1006, actor: "sim", verb: "checkpoint", body: { at: 7, engine: { engine: "eidosim@1.0.0" }, tick: 1, clock: 0, sim: "d1", state: "blob", salt: salt(8) } }];
  const s = seal(e);   // heads over the unpurged lines; then the stored lines take their commit stubs (the skeleton is unchanged)
  s.entries[5].body = { id: "chair", comp: "note", commit: commit(salt(5), "secret") };
  s.entries[2].body.ops[1] = { verb: "set", id: "chair", comp: "label", commit: commit(salt(2), "x") };
  s.entries[3].body = { commit: commit(salt(3), { text: "hi" }) };
  ok("setup: the purge left the chain as it was", chain(s.entries, oldSkel).join() === s.heads.join());
  return s;
}
const A = write("a", worldA());
const fork = (parent, seq, title, extra = {}) => seal([genesis(title, { parent: { world: parent.id, seq, head: parent.heads[seq] } }),
  { kind: "act", ts: 2001, actor: U, verb: "create-world", body: { request: { title, from: { world: parent.id, head: parent.heads[seq], seq, name: parent.name } }, salt: salt(11) } },
  { kind: "change", ts: 2001, actor: U, cause: 1, verb: "create", body: { id: extra.id ?? "thing" } }]);
const B = write("b", fork(A, 4, "B"));
const C = write("c", fork(B, 2, "C"));
const R = write("r", seal([genesis("r"), { kind: "act", ts: 3001, actor: U, verb: "create-world", body: { request: { title: "R", from: { world: A.id, head: A.heads.at(-1) } }, salt: salt(21) } }]));
const F = write("f", seal([genesis("f", {}, [[FOUNDER.pub], [OP.pub]]), { kind: "say", ts: 4001, actor: U, verb: "say", body: { text: "founded", salt: salt(31) } }]));
const G = write("g", seal([genesis("g"), { kind: "say", ts: 5001, actor: U, verb: "say", body: { text: "x", salt: salt(41) } }, { kind: "say", ts: 5002, actor: U, verb: "say", body: { text: "y", salt: salt(42) } },
  { kind: "sequencer", ts: 5003, actor: "system", verb: "sequencer", body: { key: STRANGER.pub, sigs: [{ key: OP.pub, v: "A".repeat(86) }] } }]));
const Dg = write("d", fork(G, 1, "D"));
const P = write("p", seal([genesis("p"), { kind: "change", ts: 6001, actor: U, cause: 0, verb: "batch", body: { ops: [{ verb: "create", id: "u-" + "c".repeat(26) }, { verb: "create", id: ID24 }] } }]));
const X = write("x", seal([genesis("x", { parent: { world: "sha256:" + "e".repeat(64), seq: 3, head: "f".repeat(64) } }), { kind: "say", ts: 7001, actor: U, verb: "say", body: { text: "orphan", salt: salt(51) } }]));
const K = write("k", (() => { const s = seal([genesis("k"), { kind: "say", ts: 8001, actor: U, verb: "say", body: { text: "k", salt: salt(61) } }]); s.entries[1].head = "0".repeat(64); return s; })());

const run = (inputs, o = {}) => M.planRun(inputs, { custody: CUSTODY, ...o });
const snapshot = (dir) => ({ bytes: fs.readFileSync(path.join(dir, M.LOG)), files: fs.readdirSync(dir).sort().join(",") });
const untouched = (w, before) => fs.readFileSync(path.join(w.dir, M.LOG)).equals(before.bytes) && fs.readdirSync(w.dir).sort().join(",") === before.files;

// ---------- a third party's recomputation from the old bytes and the rename table (never the tool's functions) ----------
const rk = (o, m) => Object.fromEntries(Object.entries(o).map(([k, v]) => [m[k] ?? k, v]));
function recompute(oldBytes, receipt) {
  const old = readLog(oldBytes), T = TABLE, out = [];
  const g = old[0], gb = {}; for (const [k, v] of Object.entries(g.body)) gb[k === "minor" ? "minor" : T.genesis[k] ?? k] = k === "minor" ? T.minor.to : k === "sequencer" ? receipt.newSequencerKey : v;
  gb.provenance = receipt.provenance; if (gb.parent) gb.parent = receipt._parent;   // a fork's parent row comes from the parent's receipt (§6 step 3)
  const ng = Object.fromEntries(Object.entries(g).filter(([k]) => k !== "verb").map(([k, v]) => [k, k === "body" ? gb : v])); out.push(ng);
  const wid = worldIdOf(ng);
  for (let i = 1; i < old.length; i++) { const e = old[i], kind = T.kinds[e.kind], n = {};
    for (const [k, v] of Object.entries(e)) { if (T.envelope.strip.includes(k) || k === "head" || k === "sig") continue;
      if (k === "world") n.world = wid; else if (k === "kind") n.kind = kind;
      else if (k === "verb") { if (T.envelope.verbToOp.includes(kind)) n.op = v; else if (T.envelope.verbKept.includes(kind)) n.verb = v; }
      else if (k === "body" && kind === "change") { const b = rk(v, T.body.change); if (Array.isArray(b.ops)) b.ops = b.ops.map((o) => rk(o, T.body.changeOp)); n.body = b; }
      else if (k === "body" && kind === "request") { const stub = Object.keys(v).length === 1 && "commit" in v; let b = rk(v, { commit: T.body.request.commit }); if (!stub) b = rk(b, "refused" in v ? T.body.request.refused : T.body.request.admitted); if (b.args?.from && receipt._from) b.args = { ...b.args, from: { ...b.args.from, ...receipt._from } }; n.body = b; }
      else if (k === "body" && kind === "physics") n.body = rk(v, { commit: T.body.physics.commit, ...(e.verb === "checkpoint" ? T.body.physics.checkpoint : {}) });
      else if (k === "body" && kind === "say") n.body = rk(v, T.body.say);
      else if (k === "body" && kind === "redaction") n.body = { ...v, values: v.values.map((t) => rk(t, T.body.redaction.target)) };
      else n[k] = v; }
    out.push(n); }
  const newSkel = (e) => { const { head, sig, ...s } = e;
    if (["request", "say", "physics"].includes(e.kind)) { const b = e.body; s.body = { commitment: Object.keys(b).length === 1 && "commitment" in b ? b.commitment : commit(b.salt ?? "", Object.fromEntries(Object.entries(b).filter(([k]) => k !== "salt"))) }; }
    else if (e.kind === "change") { const so = (o) => { const { value, salt, commitment: c, ...r } = o; return "value" in o || "commitment" in o ? { ...r, commitment: "commitment" in o && !("value" in o) ? o.commitment : commit(salt ?? "", value) } : r; };
      s.body = e.op === "batch" ? { ...e.body, ops: e.body.ops.map((o) => (o.op === "set" ? so(o) : o)) } : e.op === "set" ? so(e.body) : e.body; }
    return s; };
  return { entries: out, newWorldId: wid, oldHeads: chain(old, oldSkel), newHeads: chain(out, newSkel) };
}
const merkle = (rows) => { let l = rows.map((r) => sha256(jcs(r))); while (l.length > 1) { const n = []; for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? sha256(l[i] + l[i + 1]) : l[i]); l = n; } return l[0]; };
const stripSigs = (lines) => lines.map((e) => { const { sig, head, ...r } = e; return r; });

// ---------- F17 + F13: the custodial family in one run ----------
const before = { a: snapshot(A.dir), b: snapshot(B.dir) };
const OUT1 = path.join(D, "out1"); fs.mkdirSync(OUT1);
const run1 = await run([A, B, C, R]);
ok("F17-1 a custodial-default family (A, its fork B, B's fork C, A's reset successor R) migrates on the operator's authority alone", run1.refused.size === 0 && run1.done.size === 4, [...run1.refused.values()].map((x) => x.message));
M.writeRun(OUT1, run1);
const pa = run1.done.get("a"), pb = run1.done.get("b"), pc = run1.done.get("c"), pr = run1.done.get("r");
const newA = readLog(fs.readFileSync(path.join(OUT1, "a", M.LOG))), ra = JSON.parse(fs.readFileSync(path.join(OUT1, "a", M.RECEIPT), "utf8"));
ok("F17-2 ownerAttested is false and the receipt verifies (operator key in tier 1 of the old genesis, sequencer key the new genesis's)", ra.ownerAttested === false && M.verifyReceipt(ra, A.entries[0], newA[0]).length === 0, M.verifyReceipt(ra, A.entries[0], newA[0]));
ok("F17-3 the old logs are untouched (bytes and directory listing)", untouched(A, before.a) && untouched(B, before.b));
ok("F17-4 every §4.6 field is present", ["oldLogSha256", "newLogSha256", "oldWorldId", "newWorldId", "oldMinor", "newMinor", "deterministic", "vocabulary", "entries", "oldLastHead", "newLastHead", "headMap", "oldStateDigest", "newStateDigest", "digestDelta", "governanceEntries", "translator", "oldSequencerKey", "newSequencerKey", "operatorKey", "operatorSig", "sequencerSig", "ownerAttested", "provenance"].every((k) => k in ra), Object.keys(ra));
ok("F17-5 the new log reads in the new spellings: request/args, argNames, op/cascade, physics, redaction/index, say without verb, commitment stubs, no `by`, checkpoint seq, genesis minor 1 without verb and with rewindWindow + provenance (F-2 shape)",
  newA[1].kind === "request" && "args" in newA[1].body && newA[6].body.argNames?.[0] === "id" && newA[2].op === "batch" && newA[2].body.ops[0].op === "create" && newA[2].body.cascade?.[0] === 1 && "commitment" in newA[2].body.ops[1]
  && newA[4].kind === "physics" && newA[4].verb === "launch" && newA[7].kind === "redaction" && !("verb" in newA[7]) && newA[7].body.values[1].index === 1 && !("verb" in newA[3]) && !("by" in newA[3]) && Object.keys(newA[3].body).join() === "commitment"
  && newA[8].body.seq === 7 && newA[8].body.sim === "d1" && newA[0].body.minor === 1 && !("verb" in newA[0]) && newA[0].body.rewindWindow === 500 && !("rewind_window" in newA[0].body)
  && newA[0].body.provenance?.registry?.id === "registry-pin" && /^git:sha1:[0-9a-f]{40}$/.test(newA[0].body.provenance.writer.sourceRevision) && /^[0-9a-f]{64}$/.test(newA[0].body.provenance.writer.sourceTreeSha256) && typeof newA[0].body.provenance.writer.dirty === "boolean", newA.map((e) => JSON.stringify(e).slice(0, 120)));
ok("F17-6 the redacted world's digests differ by the marker alone (digestDelta: redaction-marker); a world with no redaction says none", ra.digestDelta === "redaction-marker" && ra.oldStateDigest !== ra.newStateDigest && pb.receipt.digestDelta === "none" && pb.receipt.oldStateDigest === pb.receipt.newStateDigest);
ok("F17-7 heads and sigs: every line after genesis carries the new head and a sequencer signature that verifies against the new world id", newA.slice(1).every((e, i) => e.head === pa.newHeads[i + 1] && M.verifies(SEQ.pub, `eidoverse-head:${pa.newWorldId}:${i + 1}:${e.head}`, e.sig)));

// F13 determinism
const run2 = await run([A, B, C, R]);
const same = (x, y) => Buffer.from(x.bytes).equals(Buffer.from(y.bytes));
ok("F13-1 migrated twice, the logs are byte-identical and the receipts identical minus signatures (same salts, nonce, ts, count)", ["a", "b", "c", "r"].every((n) => same(run1.done.get(n), run2.done.get(n)) && run1.done.get(n).message === run2.done.get(n).message));
ok("F13-2 what a pure rename never changes: entry count, every ts, every salt, the nonce", [pa, pb, pc, pr].every((p) => p.entries.length === p.oldEntries.length && p.entries.slice(1).every((e, i) => e.ts === p.oldEntries[i + 1].ts) && JSON.stringify(p.entries).match(/"salt":"[^"]+"/g)?.join() === JSON.stringify(p.oldEntries).match(/"salt":"[^"]+"/g)?.join() && p.entries[0].body.nonce === p.oldEntries[0].body.nonce));
{ const rc = recompute(A.bytes ?? fs.readFileSync(path.join(A.dir, M.LOG)), ra);
  const hm = JSON.parse(fs.readFileSync(path.join(OUT1, "a", M.HEADMAP), "utf8"));
  ok("F13-3 a third party recomputes the new world id and every (seq, oldHead, newHead) row from the old bytes and the rename table; the Merkle root and the head-map file hash match the receipt",
    rc.newWorldId === ra.newWorldId && hm.every(([s, o, n]) => rc.oldHeads[s] === o && rc.newHeads[s] === n) && hm.length === A.entries.length && merkle(hm) === ra.headMap && ra.oldLastHead === rc.oldHeads.at(-1) && ra.newLastHead === rc.newHeads.at(-1) && sha256Bytes(fs.readFileSync(path.join(OUT1, "a", M.HEADMAP))) === ra.headMapSha256,
    { rcId: rc.newWorldId, id: ra.newWorldId });
  ok("F13-4 …and the entries themselves, minus signatures", JSON.stringify(stripSigs(newA)) === JSON.stringify(stripSigs(rc.entries)));
  ok("F13-5 oldLogSha256 / newLogSha256 are the files' bytes", ra.oldLogSha256 === sha256Bytes(fs.readFileSync(path.join(A.dir, M.LOG))) && ra.newLogSha256 === sha256Bytes(fs.readFileSync(path.join(OUT1, "a", M.LOG)))); }

// F11/F15: the two-stage remap, and a child whose parent is nowhere
const newB = pb.entries, newC = pc.entries;
ok("F15-1 the child's parent is rewritten from the parent's receipt: world = parent's newWorldId, seq unchanged, head = the parent's new head at that seq; the grandchild follows", newB[0].body.parent.world === pa.newWorldId && newB[0].body.parent.seq === 4 && newB[0].body.parent.head === pa.newHeads[4] && newC[0].body.parent.world === pb.newWorldId && newC[0].body.parent.head === pb.newHeads[2]);
ok("F15-2 the founding `from` is rewritten through the same map and row (fork: at from.seq; reset: the predecessor's last head)", newB[1].body.args.from.world === pa.newWorldId && newB[1].body.args.from.head === pa.newHeads[4] && newB[1].body.args.from.seq === 4 && pr.entries[1].body.args.from.world === pa.newWorldId && pr.entries[1].body.args.from.head === pa.newHeads.at(-1));
{ const rc = recompute(fs.readFileSync(path.join(B.dir, M.LOG)), { ...pb.receipt, _parent: newB[0].body.parent, _from: { world: pa.newWorldId, head: pa.newHeads[4] } });
  ok("F15-3 a third party, holding the parent's receipt, recomputes the child's new id and heads", rc.newWorldId === pb.newWorldId && rc.newHeads.join() === pb.newHeads.join()); }
ok("F15-4 worldmap.json holds every old → new pair of the run", (() => { const m = JSON.parse(fs.readFileSync(path.join(OUT1, M.WORLDMAP), "utf8")); return [pa, pb, pc, pr].every((p) => m[p.oldWorldId] === p.newWorldId) && Object.keys(m).length === 4; })());
const bx = snapshot(X.dir); const runX = await run([X]);
ok("F15-5 a child whose parent is absent from the run and from any map is refused, loud, naming the child, the parent id and the seq; nothing written", runX.refused.get("x")?.code === "parent-unmapped" && /x:/.test(runX.refused.get("x").message) && runX.refused.get("x").message.includes("sha256:" + "e".repeat(64)) && /seq 3/.test(runX.refused.get("x").message) && runX.done.size === 0 && untouched(X, bx), runX.refused.get("x")?.message);
{ const OUT2 = path.join(D, "out2"); fs.mkdirSync(OUT2); const r2 = await run([B], { map: M.mapFrom(OUT1) });
  ok("F15-6 supplying the parent's receipt (an earlier run's out dir as --map) translates the child alone, to the same id it was minted once", r2.refused.size === 0 && r2.done.get("b").newWorldId === pb.newWorldId && same(r2.done.get("b"), pb));
  const r3 = await run([{ name: "b", dir: path.join(OUT1, "b") }], { map: M.mapFrom(OUT1) });
  ok("F15-7 a world already holding a receipt (or a minor-1 genesis) is refused: never re-id'd by a later run", r3.refused.get("b")?.code === "already-migrated" && r3.done.size === 0, r3.refused.get("b")?.message); }
{ const bad = { ...B, name: "b-badhead" }; const e = JSON.parse(JSON.stringify(B.entries)); e[0].body.parent.head = "9".repeat(64); const s = seal(e); const w = write("b-badhead", s);
  const r = await run([A, w]); ok("F15-8 a child naming a head its parent never had at that seq is refused (the tool holds both logs: §6 step 3b)", r.refused.get("b-badhead")?.code === "parent-head" && r.done.has("a"), r.refused.get("b-badhead")?.message); }

// F16: founder-keyed
const bf = snapshot(F.dir); const OUTF = path.join(D, "outf"); fs.mkdirSync(OUTF);
{ const r = await run([F]); ok("F16-1 a founder-keyed world (tier 0 non-empty) with no tier-0 signature is refused before any output; the old world stays as it was", r.refused.get("f")?.code === "owner" && /tier-0/.test(r.refused.get("f").message) && r.done.size === 0 && untouched(F, bf), r.refused.get("f")?.message); }
const dry = await run([F], { dryRun: true });
ok("F16-2 --dry-run yields the receipt message to sign (ownerAttested names the tier-0 key, no signature) and writes nothing", dry.done.get("f")?.message?.includes(`"ownerAttested":{"key":"${FOUNDER.pub}"}`) && fs.readdirSync(OUTF).length === 0 && untouched(F, bf));
{ const r = await run([F], { ownerSigs: { f: { key: FOUNDER.pub, sig: signWith(STRANGER, dry.done.get("f").message) } } }); ok("F16-3 a signature that does not verify is refused", r.refused.get("f")?.code === "owner" && r.done.size === 0); }
{ const r = await run([F], { ownerSigs: { f: { key: STRANGER.pub, sig: signWith(STRANGER, dry.done.get("f").message) } } }); ok("F16-4 a signature by a key outside tier 0 is refused", r.refused.get("f")?.code === "owner" && r.done.size === 0); }
{ const r = await run([F], { ownerSigs: { f: { key: FOUNDER.pub, sig: signWith(FOUNDER, dry.done.get("f").message) } } }); M.writeRun(OUTF, r);
  const rf = JSON.parse(fs.readFileSync(path.join(OUTF, "f", M.RECEIPT), "utf8")), nf = readLog(fs.readFileSync(path.join(OUTF, "f", M.LOG)));
  ok("F16-5 with the tier-0 signature over that exact message the world migrates; ownerAttested is {key, sig} and the receipt verifies", r.done.has("f") && rf.ownerAttested?.key === FOUNDER.pub && M.verifyReceipt(rf, F.entries[0], nf[0]).length === 0, M.verifyReceipt(rf, F.entries[0], nf[0]));
  ok("F16-6 a verifier refuses a founder-keyed receipt whose ownerAttested is false", M.verifyReceipt({ ...rf, ownerAttested: false }, F.entries[0], nf[0]).some((m) => /founder-keyed/.test(m))); }

// F17 mutations on the receipt (verification, not the tool)
{ const nf = newA; const r = JSON.parse(JSON.stringify(ra));
  ok("F17-M1 a receipt with its operator signature by another key fails verification", M.verifyReceipt({ ...r, operatorSig: signWith(STRANGER, M.receiptMessage(r)) }, A.entries[0], nf[0]).some((m) => /operatorSig/.test(m)));
  ok("F17-M2 a receipt naming an operator key outside the old genesis's tiers fails verification", M.verifyReceipt({ ...r, operatorKey: STRANGER.pub }, A.entries[0], nf[0]).some((m) => /tiers/.test(m)));
  ok("F17-M3 a tampered field (newLastHead) breaks both signatures", M.verifyReceipt({ ...r, newLastHead: "0".repeat(64) }, A.entries[0], nf[0]).length >= 2);
  const stranger = custodyAt(custodyFile(SEQ, STRANGER, "stranger")); const rs = await M.planRun([A], { custody: stranger });
  ok("F17-M4 a custody whose operator key is not in the old genesis's tiers is refused by the tool", rs.refused.get("a")?.code === "operator", rs.refused.get("a")?.message); }

// F18: governance
{ const bg = snapshot(G.dir); const r = await run([G, Dg]);
  ok("F18-1 a world holding a governance entry is refused, loud, naming the seq; nothing written", r.refused.get("g")?.code === "governance" && /seq 3/.test(r.refused.get("g").message) && !r.done.has("g") && untouched(G, bg), r.refused.get("g")?.message);
  ok("F18-2 …and its child is refused under F15 (parent unmapped), naming the parent", r.refused.get("d")?.code === "parent-unmapped" && r.refused.get("d").message.includes(G.id), r.refused.get("d")?.message); }

// F19: the u- + 24 collision
{ const bp = snapshot(P.dir); const r = await run([P]);
  ok("F19-1 an entity id wearing u-[a-z2-7]{24} refuses the world, loud, naming the id and the seq; a 26-char u- id beside it was fine", r.refused.get("p")?.code === "collision" && r.refused.get("p").message.includes(ID24) && /seq 1/.test(r.refused.get("p").message) && r.done.size === 0 && untouched(P, bp), r.refused.get("p")?.message); }

// chain
{ const r = await run([K]); ok("K-1 a stored head that is not the chain's is refused: a broken chain is not migrated", r.refused.get("k")?.code === "chain-broken", r.refused.get("k")?.message); }

// F20: the minor-0 reader over the new log
{ const st = fold(newA);
  // DOC GAP (reported): D1 expects `unknown-version`; the base fold checks the envelope before the minor, so a genesis without
  // `verb` (D3) is `no-genesis` → `no-world`. Either way: no world, nothing folded, loud at seq 0. Pinned as observed.
  ok("F20-1 the minor-0 reader (the base fold) refuses the new log before folding anything: entities null, status no-world (not unknown-version: the envelope check meets the dropped genesis verb first)", st.status === "no-world" && st.entities === null && st.diagnostics.some(([s, c]) => s === 0 && c === "no-genesis"), { status: st.status, d: st.diagnostics.slice(0, 3) });
  const back = JSON.parse(JSON.stringify(newA)); back[0].body.minor = 0; back[0].verb = "genesis"; delete back[0].body.rewindWindow; delete back[0].body.provenance; const st0 = fold(back);
  ok("F20-M the genesis is the gate: with minor 0, the verb and the old genesis fields put back, the old reader folds a world (the renamed lines are per-entry malformed, status ok)", st0.status === "ok" && st0.entities !== null, { status: st0.status, d: st0.diagnostics.slice(0, 2) });
  const back1 = JSON.parse(JSON.stringify(back)); back1[0].body.minor = 1; const st1 = fold(back1);
  ok("F20-2 …and the minor alone, with everything else old, is unknown-version with nothing folded (M2)", st1.status === "unknown-version" && st1.entities === null && st1.diagnostics.some(([q, c]) => q === 0 && c === "unknown-minor"), { status: st1.status, d: st1.diagnostics }); }

// ---------- source mutants: one per guard, each must turn its row red ----------
const SRC = fs.readFileSync(ENGINE + "tools/protocol/migrate-minor-1.ts", "utf8");
let mi = 0;
async function mutant(find, repl) {
  const n = SRC.split(find).length - 1; if (n !== 1) { ok(`mutant setup: find text occurs once (${n})`, false, find.slice(0, 80)); return null; }
  const text = SRC.replace(find, repl).replace(/from "\.\.\/\.\.\//g, `from "${ENGINE}`).replace(/from "\.\/common\.ts"/g, `from "${ENGINE}tools/protocol/common.ts"`).replace(/import\("\.\.\/\.\.\//g, `import("${ENGINE}`);
  const f = path.join(D, `mutant-${mi++}.ts`); fs.writeFileSync(f, text); return await import(f);
}
const mrun = (m, inputs, o = {}) => m.planRun(inputs, { custody: CUSTODY, ...o });
{ const m = await mutant('if (gov.length) refuse("governance"', 'if (false) refuse("governance"'); const r = m && await mrun(m, [G]);
  ok("F18-R without the governance guard the tool migrates a governance-bearing world (row F18-1 red)", r && r.done.has("g")); }
{ const m = await mutant('if (!ownerSig && !now.dryRun) refuse("owner"', 'if (false) refuse("owner"'); const r = m && await mrun(m, [F]);
  ok("F16-R without the founder guard the tool emits a founder-keyed world unsigned (row F16-1 red); the verifier still refuses its receipt", r && r.done.has("f") && M.verifyReceipt(r.done.get("f").receipt, F.entries[0], r.done.get("f").entries[0]).some((x) => /founder-keyed/.test(x))); }
{ const m = await mutant('if (isObj(g.body.parent)) { const { world, seq, head } = g.body.parent;', 'if (false) { const { world, seq, head } = g.body.parent;'); const r = m && await mrun(m, [X]);
  ok("F15-R1 a tool that skips the parent remap migrates the orphan with a dangling old parent (row F15-5 red)", r && r.done.has("x") && r.done.get("x").entries[0].body.parent.world.startsWith("sha256:eeee")); }
{ const m = await mutant('return { world: p.newWorldId, head: p.newHeads[at], parent: p, seq: at };', 'return { world: p.newWorldId, head: p.heads[at], parent: p, seq: at };'); const r = m && await mrun(m, [A, B]);
  ok("F15-R2 a remap by world id only (the old head kept, F11's mutation) is caught by the 3b check: the child is refused", r && r.refused.get("b")?.code === "parent-head" && /rewritten parent.head/.test(r.refused.get("b").message), r?.refused.get("b")?.message); }
{ const m = await mutant('if (newG.body.parent.head !== want) refuse("parent-head"', 'if (false) refuse("parent-head"'); const m2 = m && fs.readFileSync(path.join(D, `mutant-${mi - 1}.ts`), "utf8").replace("head: p.newHeads[at], parent: p, seq: at", "head: p.heads[at], parent: p, seq: at");
  const f = path.join(D, `mutant-${mi++}.ts`); fs.writeFileSync(f, m2); const mm = await import(f); const r = await mrun(mm, [A, B]);
  ok("F15-R3 with both the remap and the 3b check gone the child is written with its parent's OLD head, which the third party's recomputation of the parent's new chain refutes (row F15-1 red)", r.done.has("b") && r.done.get("b").entries[0].body.parent.head !== r.done.get("a").newHeads[4] && r.done.get("b").entries[0].body.parent.head === A.heads[4]); }
{ const m = await mutant('if (isObj(o) && PERSON24.test(o.id)) refuse("collision"', 'if (false) refuse("collision"'); const r = m && await mrun(m, [P]);
  ok("F19-R without the collision scan the 24-shape id passes through silently (row F19-1 red)", r && r.done.has("p")); }
{ const m = await mutant('if (receiptExists || g.body.minor !== MINOR.from) refuse("already-migrated"', 'if (false) refuse("already-migrated"'); const r = m && await mrun(m, [{ name: "b", dir: path.join(OUT1, "b") }], { map: M.mapFrom(OUT1) });
  ok("F15-R4 without the once-only guard a migrated child is re-id'd by a later run (row F15-7 red)", r && (r.done.has("b") || r.refused.get("b")?.code !== "already-migrated"), r?.refused.get("b")?.message); }
{ const m = await mutant('if (typeof old[i].head === "string" && old[i].head !== oldHeads[i]) refuse("chain-broken"', 'if (false) refuse("chain-broken"'); const r = m && await mrun(m, [K]);
  ok("K-R without the chain check a broken chain migrates (row K-1 red)", r && r.done.has("k")); }
const PHYS = 'if (kind === "physics") return renameKeys(b, { ...(e.verb === "checkpoint" ? BODY.physics.checkpoint : {}), commit: BODY.physics.commit });';
{ const m = await mutant(PHYS, 'if (kind === "physics") { const { salt: _s, ...r } = renameKeys(b, { commit: BODY.physics.commit }); return r; }'); const r = m && await mrun(m, [A]);
  ok("F13-R1 a rename that drops a salt is refused by the tool's own determinism guard", r && r.refused.get("a")?.code === "determinism" && /salt/.test(r.refused.get("a").message), r?.refused.get("a")?.message); }
{ const m = await mutant('const s0 = salts(old), s1 = salts(out); if (s0.length !== s1.length || s0.some((s, i) => s !== s1[i])) refuse("determinism"', 'if (false) refuse("determinism"');
  const text = fs.readFileSync(path.join(D, `mutant-${mi - 1}.ts`), "utf8").replace(PHYS, 'if (kind === "physics") { const r = renameKeys(b, { commit: BODY.physics.commit }); if (typeof r.salt === "string") r.salt = "re-salted-re-salted"; return r; }');
  const f = path.join(D, `mutant-${mi++}.ts`); fs.writeFileSync(f, text); const mm = await import(f); const r = await mrun(mm, [A]);
  const rc = r.done.has("a") && recompute(fs.readFileSync(path.join(A.dir, M.LOG)), r.done.get("a").receipt);
  ok("F13-R2 with the guard gone and a set re-salted, the third party's recomputation from the old bytes no longer matches the receipt's head map (row F13-3 red)", rc && rc.newHeads.join() !== r.done.get("a").newHeads.join() && r.done.get("a").entries[4].body.salt !== A.entries[4].body.salt); }
{ const m = await mutant('for (let i = 1; i < old.length; i++) if (out[i].ts !== old[i].ts) refuse("determinism"', 'for (let i = 1; i < old.length; i++) if (false) refuse("determinism"');
  const text = fs.readFileSync(path.join(D, `mutant-${mi - 1}.ts`), "utf8").replace("const out = [newG];", "const out = [newG]; const stamp = Date.now();").replace("out.push(e);\n  }", "e.ts = stamp + i; out.push(e);\n  }");
  const f = path.join(D, `mutant-${mi++}.ts`); fs.writeFileSync(f, text); const mm = await import(f); const r = await mrun(mm, [A]);
  ok("F13-R3 a tool that stamps ts (guard gone) fails F13-2's ts comparison", r.done.has("a") && r.done.get("a").entries[1].ts !== A.entries[1].ts); }
{ const m = await mutant("if (founderKeyed && ownerSig) { if (!verifies(ownerSig.key, msg, ownerSig.sig)) refuse(\"owner\"", "if (founderKeyed && ownerSig) { if (false) refuse(\"owner\"");
  const r = m && await mrun(m, [F], { ownerSigs: { f: { key: FOUNDER.pub, sig: signWith(STRANGER, dry.done.get("f").message) } } });
  ok("F16-R2 without the signature check a forged tier-0 signature is written; the verifier refuses the receipt (row F16-3 red)", r && r.done.has("f") && M.verifyReceipt(r.done.get("f").receipt, F.entries[0], r.done.get("f").entries[0]).some((x) => /founder-keyed/.test(x))); }

// the CLI, end to end, over the same inputs
{ const OUT3 = path.join(D, "out3"); const { spawnSync } = await import("node:child_process");
  const r = spawnSync(process.execPath, ["tools/protocol/migrate-minor-1.ts", "--out", OUT3, "--custody", path.join(D, "custody-host.json"), A.dir, B.dir, X.dir], { cwd: ENGINE, encoding: "utf8", env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  ok("CLI-1 the command migrates the mappable worlds, prints the refusal for the orphan, exits 1 because one was refused, and its bytes equal the in-process run's", r.status === 1 && /REFUSED x:/.test(r.stdout) && /migrated a:/.test(r.stdout) && fs.readFileSync(path.join(OUT3, "a", M.LOG)).equals(fs.readFileSync(path.join(OUT1, "a", M.LOG))) && !fs.existsSync(path.join(OUT3, "x")), { status: r.status, out: r.stdout.slice(0, 300), err: r.stderr.slice(0, 300) }); }

console.log(`[migrate-minor-1-check] ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
