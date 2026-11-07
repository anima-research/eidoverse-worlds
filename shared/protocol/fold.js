// The fold (PROTOCOL §1 L1, §2.3, §2.4). It knows nothing about any component type: it creates entities,
// replaces component values, deletes components and entities. It reads only the entry: never a blob, never the authority.
// It is total: a malformed entry shapes nothing and is named in diagnostics, never in the world. A version it
// doesn't implement gives "unknown version" and no world.
// Ported from the protocol lab (the protocol lab's fold.js @ 11db981). Engine changes: sha256 comes from ./hash.js (sync, no
// node: imports) so the browser imports this file as-is. Nothing else differs; the conformance suite (Python
// reference reader vs this file) is tools/protocol/compare.ts.
import { sha256 } from "./hash.js";
import { checkRequires, featureDecision, KNOWN_FEATURES } from "./features.js";
import { checkProvenance } from "./provenance.js";

// §2.4: genesis says which log this is and which protocol reads it, in upstream's established shape: {dialect:
// "eidoverse-log", v: N}. v 1–2 was the first world log, 3 the deterministic-sim amendment, 4 this protocol (spec/PROTOCOL.md,
// "Version history"). The number lives there and nowhere else.
export const DIALECT = "eidoverse-log";
export const VERSION = 4;
const MAX_LINE = 1 << 20, MAX_DEPTH = 64, BIG = 2 ** 53;
// §2.1 + §2.4: `ts` is the authority's admission time; `head`/`sig` mark chain points (§2.1 still says `prev`; §2.4 and the reference reader say `head`)
// The KERNEL (trial-kernel, PROTOCOL §4; shared/protocol/kernelspec.js pins these): the envelope, the kinds, the identity
// grammar, the ops, genesis. A change to any of them is refused by the gate unless the same commit carries a translator,
// a changelog line and old-reader/new-reader vectors (tools/protocol/kernel-check.ts)
export const ENVELOPE = new Set(["world", "kind", "ts", "actor", "cause", "op", "verb", "body", "head", "sig"]);
export const KINDS = new Set(["genesis", "change", "request", "physics", "say", "redaction", "governance"]);
// `op` on a change (the storage operation), `verb` on a request or physics entry (what was asked / the engine event), neither elsewhere (D3)
export const WORD_OF = Object.freeze({ change: "op", request: "verb", physics: "verb" });
/** The kinds whose whole body is purgeable (hashed as {commitment} in the chain skeleton, §12). */
export const BODY_KINDS = Object.freeze(["request", "say", "physics"]);
export const IDENT = "[a-z0-9-]{1,64}";
// §2.3: entity ids are minted opaque ids or @world. `body:<identity>` is a reference, never an entity.
export const ENTITY = /^(?:[a-z0-9-]{1,64}|@world)$/;
const DOMAIN = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*/";
export const COMP = new RegExp(`^(?:${DOMAIN})?[a-z][a-z0-9-]*(?:@[1-9][0-9]{0,8})?(?::${IDENT})?$`);
export const isEntityId = (s) => typeof s === "string" && ENTITY.test(s);
export const isComponent = (s) => typeof s === "string" && COMP.test(s);
export const isIdentity = (s) => typeof s === "string" && new RegExp(`^${IDENT}$`).test(s);

export class Malformed { constructor(code, detail = "") { this.code = code; this.detail = String(detail).slice(0, 80); } }
const bad = (code, detail) => { throw new Malformed(code, detail); };
const PARSED = new WeakSet(); // objects this module built from text: already checked value by value

// ---------- strict I-JSON (RFC 7493) ----------
export function parseLine(text) {
  if (text.length && text.charCodeAt(0) === 0xfeff) bad("ijson-bom");
  let i = 0;
  const ws = () => { while (i < text.length) { const c = text[i]; if (c === " " || c === "\t" || c === "\n" || c === "\r") i++; else break; } };
  const value = (depth) => {
    if (depth > MAX_DEPTH) bad("cap-depth", String(MAX_DEPTH));
    ws(); const c = text[i];
    if (c === "{") {
      i++; const o = Object.create(null); ws();
      if (text[i] === "}") { i++; return mark(o); }
      for (;;) {
        ws(); if (text[i] !== '"') bad("json-syntax", `key at ${i}`);
        const k = string();
        if (Object.prototype.hasOwnProperty.call(o, k)) bad("ijson-dupkey", JSON.stringify(k));
        ws(); if (text[i++] !== ":") bad("json-syntax", `: at ${i - 1}`);
        o[k] = value(depth + 1); ws();
        const d = text[i++]; if (d === "}") return mark(o); if (d !== ",") bad("json-syntax", `, or } at ${i - 1}`);
      }
    }
    if (c === "[") {
      i++; const a = []; ws();
      if (text[i] === "]") { i++; return mark(a); }
      for (;;) { a.push(value(depth + 1)); ws(); const d = text[i++]; if (d === "]") return mark(a); if (d !== ",") bad("json-syntax", `, or ] at ${i - 1}`); }
    }
    if (c === '"') return string();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    for (const k of ["NaN", "Infinity", "-Infinity"]) if (text.startsWith(k, i)) bad("ijson-nonfinite", k);
    NUM.lastIndex = i; const m = NUM.exec(text);
    if (!m) bad("json-syntax", `value at ${i}`);
    i += m[0].length; const s = m[0];
    if (m[1] === undefined && m[2] === undefined) { // an integer lexeme must be exactly a binary64 (§1 L1)
      const n = BigInt(s); if (n === 0n && s[0] === "-") bad("ijson-negzero", s);
      const f = Number(s); if (!Number.isFinite(f)) bad("ijson-nonfinite", s.slice(0, 40));
      if (BigInt(f) !== n) bad("ijson-bigint", s.slice(0, 40));
      return f;
    }
    const n = Number(s); if (!Number.isFinite(n)) bad("ijson-nonfinite", s.slice(0, 40));
    if (Object.is(n, -0)) bad("ijson-negzero", s.slice(0, 40));
    return n;
  };
  const string = () => {
    i++; let out = "";
    for (;;) {
      if (i >= text.length) bad("json-syntax", "unterminated string");
      const c = text.charCodeAt(i++);
      if (c === 0x22) break;
      if (c < 0x20) bad("json-syntax", "control character in string");
      if (c !== 0x5c) { PLAIN.lastIndex = i; const run = PLAIN.exec(text)[0]; out += String.fromCharCode(c) + run; i += run.length; continue; }
      const e = text[i++];
      const simple = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[e];
      if (simple !== undefined) { out += simple; continue; }
      if (e !== "u" || !/^[0-9a-fA-F]{4}$/.test(text.slice(i, i + 4))) bad("json-syntax", "bad escape");
      out += String.fromCharCode(parseInt(text.slice(i, i + 4), 16)); i += 4;
    }
    checkString(out); return out;
  };
  const v = value(0); ws();
  if (i !== text.length) bad("json-syntax", `trailing data at ${i}`);
  return v;
}
const NUM = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y, PLAIN = /[^"\\\x00-\x1f]*/y;
const mark = (o) => (PARSED.add(o), o);
function checkString(s) {
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k); let cp = c;
    if (c >= 0xd800 && c <= 0xdbff) { const d = s.charCodeAt(k + 1); if (!(d >= 0xdc00 && d <= 0xdfff)) bad("ijson-surrogate", c.toString(16)); cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); k++; }
    else if (c >= 0xdc00 && c <= 0xdfff) bad("ijson-surrogate", c.toString(16));
    if ((cp >= 0xfdd0 && cp <= 0xfdef) || (cp & 0xfffe) === 0xfffe) bad("ijson-noncharacter", cp.toString(16));
  }
}
// The same rules for a value that was built in memory rather than parsed (an authority's own entry, a test's tamper).
// A number of 2^53 or more that every JSON writer (and JCS) spells as an integer lexeme NOT equal to it is refused too:
// the next read would find it malformed (§1). Below 1e21 that's most of them; 2^53, 2^54 and other exact spellings pass.
function checkValue(v, depth = 0) {
  if (depth > MAX_DEPTH) bad("cap-depth", String(MAX_DEPTH));
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) bad("ijson-nonfinite", String(v)); if (Object.is(v, -0)) bad("ijson-negzero", "-0");
    // what the reader will see is the writer's spelling: an integer lexeme (no '.', no exponent) must name this number
    // exactly (§1). 2^65 is written 36893488147419103000, which is not 2^65: refused here, as the reader would refuse it
    if (Number.isInteger(v) && Math.abs(v) >= BIG) { const s = String(v); if (/^-?[0-9]+$/.test(s) && BigInt(s) !== BigInt(v)) bad("ijson-bigint", s.slice(0, 40)); }
    return; }
  if (typeof v === "string") return checkString(v);
  if (PARSED.has(v)) return;
  if (Array.isArray(v)) { for (const x of v) checkValue(x, depth + 1); return; }
  if (typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    for (const k of Object.keys(v)) { checkString(k); checkValue(v[k], depth + 1); } return; }
  bad("not-json", typeof v);
}

export const checkIJSON = (v) => checkValue(v, 0);

// A log is UTF-8 JSONL; a line's 0-based position is its seq. Returns one item per line: an object or a Malformed.
export function readLog(bytes) {
  if (typeof bytes === "string") bytes = new TextEncoder().encode(bytes);
  const lines = []; let start = 0;
  for (let k = 0; k <= bytes.length; k++) if (k === bytes.length || bytes[k] === 0x0a) { lines.push(bytes.subarray(start, k)); start = k + 1; }
  if (lines.length && lines.at(-1).length === 0) lines.pop();
  const dec = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  return lines.map((raw) => {
    try {
      if (raw.length > MAX_LINE) bad("cap-size", String(raw.length));
      let text; try { text = dec.decode(raw); } catch (e) { bad("ijson-utf8", e.message); }
      return parseLine(text);
    } catch (e) { if (e instanceof Malformed) return e; if (e instanceof RangeError) return new Malformed("cap-depth", "parser recursion"); throw e; }
  });
}

// ---------- JCS (RFC 8785) and the digest (§2.4) ----------
export function jcs(v) {
  if (v === null || typeof v === "boolean") return String(v);
  if (typeof v === "number") return Object.is(v, -0) ? "0" : String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jcs).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + jcs(v[k])).join(",") + "}";
}
/** A string's length in UTF-8 bytes, what a log line, a blob or the wire holds (a JavaScript string's length counts UTF-16
 *  units: a two-byte character is one of them, a four-byte one two). A lone surrogate counts the three bytes of the U+FFFD
 *  an encoder writes for it. Every byte limit counts this. */
export function utf8Len(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
    else n += 3; }
  return n;
}
export { sha256 };
export const worldIdOf = (genesis) => "sha256:" + sha256(jcs(genesis));
export const REDACTED = Object.freeze({ redacted: true });
/** A redacted value, whichever way it reached the reader: the fold's own sentinel, or its JSON form `{redacted: true}` in a
 *  snapshot or view (which loses the identity). */
export const isRedacted = (v) => v === REDACTED || (!!v && typeof v === "object" && v.redacted === true && Object.keys(v).length === 1);
export function canonicalView(st) {
  const out = Object.create(null);
  for (const id of Object.keys(st.entities)) { const c = st.entities[id].c, v = Object.create(null);
    for (const k of Object.keys(c)) v[k] = c[k] === REDACTED ? { redacted: true } : { v: c[k] }; out[id] = v; }
  return out;
}
export const digest = (st) => sha256(jcs(canonicalView(st)));

// ---------- envelope and state bodies ----------
export function checkEntry(e, seq) {
  if (e === null || typeof e !== "object" || Array.isArray(e)) bad("not-object");
  if (Object.prototype.propertyIsEnumerable.call(e, "seq")) bad("seq-field"); // L1: the position is the seq (a reader may attach it, unenumerable, in memory)
  const extra = Object.keys(e).filter((k) => !ENVELOPE.has(k)); if (extra.length) bad("unknown-field", extra.sort().join(","));
  if (!KINDS.has(e.kind)) bad("kind", JSON.stringify(e.kind));
  for (const f of ["kind", "actor"]) if (typeof e[f] !== "string") bad("envelope", `${f} missing or not a string`);
  const word = WORD_OF[e.kind]; for (const f of ["op", "verb"]) { if (f === word) { if (typeof e[f] !== "string") bad("envelope", `${f} missing or not a string`); } else if (f in e) bad("envelope", `${f} not allowed on ${e.kind}`); }
  if (e.kind !== "genesis" && typeof e.world !== "string") bad("envelope", "world");
  if (e.body === null || typeof e.body !== "object" || Array.isArray(e.body)) bad("envelope", "body not an object");
  if (e.kind === "change" || "cause" in e) { const c = e.cause; if (!(Number.isInteger(c) && c >= 0 && c < seq)) bad("cause", JSON.stringify(c)); }
  if (!PARSED.has(e)) for (const k of Object.keys(e)) checkValue(e[k], 1);
}
export const OP_FIELDS = { create: ["id"], delete: ["id", "comp"], set: ["id", "comp", "value", "salt", "commitment"] };
export const BATCH_FIELDS = ["ops", "cascade"]; // `commitment` replaces value+salt once redacted
// A change entry as a flat list of ops. Any shape or grammar error anywhere makes the whole entry malformed.
export function opsOf(e) {
  const { op: verb, body } = e;
  if (verb === "batch") {
    const extra = Object.keys(body).filter((k) => !BATCH_FIELDS.includes(k)); if (extra.length) bad("batch-field", extra.join(","));
    if (!Array.isArray(body.ops)) bad("batch-ops");
    if ("cascade" in body) cascadeCheck(body.cascade, body.ops.length);
    return body.ops.map((o, i) => {
      if (o === null || typeof o !== "object" || Array.isArray(o)) bad("batch-op", String(i));
      if (o.op === "batch") bad("nested-batch", `op ${i}`); // L1: a batch never contains a batch
      return shapeOne(o.op, o, true, `op ${i}`);
    });
  }
  return [shapeOne(verb, body, false, "")];
}
// `cascade` (review r9 H1 / scars M3): the indices of the ops in this batch that the AUTHORITY wrote as a consequence of the
// asker's own ops (clearing the references to a thing the batch deleted; an undo putting such a reference back). The fold
// applies them like any op; readers that derive authorship from the log (who set up a handler, who created a key) skip
// them, so a follow-up never makes the asker the author of someone else's value. Strictly ascending, in range, non-empty.
function cascadeCheck(f, n) {
  if (!Array.isArray(f) || !f.length) bad("batch-cascade", "not a non-empty array");
  f.forEach((k, i) => { if (!Number.isInteger(k) || k < 0 || k >= n || (i > 0 && k <= f[i - 1])) bad("batch-cascade", JSON.stringify(k)); });
}
/** The set of op indices a change entry marks as the authority's cascade (empty for anything else). */
export function cascadeOf(e) {
  const f = e?.kind === "change" && e.op === "batch" ? e.body?.cascade : undefined;
  return new Set(Array.isArray(f) ? f.filter(Number.isInteger) : []);
}
export function shapeOne(verb, b, inner, where) {
  const allowed = Object.hasOwn(OP_FIELDS, verb) ? OP_FIELDS[verb] : null; if (!allowed) bad("op", `${where} ${JSON.stringify(verb)}`);   // never an inherited name (`constructor`): review of #260, I118
  const extra = Object.keys(b).filter((k) => !(inner && k === "op") && !allowed.includes(k));
  if (extra.length) bad("op-field", `${where} ${extra.sort().join(",")}`);
  if (!isEntityId(b.id)) bad("entity-id", `${where} ${JSON.stringify(b.id)}`);
  if ((verb === "set" || "comp" in b) && !isComponent(b.comp)) bad("comp-name", `${where} ${JSON.stringify(b.comp)}`);
  const op = { op: verb, id: b.id }; if (b.comp !== undefined) op.comp = b.comp;
  if (verb === "set" && "value" in b) op.value = b.value; // only an ABSENT value is "no value"; null is a value
  // a value stripped to its commitment (§12: a redaction's work): marked, out of sight of JSON and spreads, for unnamedStubs and applyInPlace
  else if (verb === "set" && "commitment" in b) Object.defineProperty(op, "stripped", { value: true });
  return op;
}

// ---------- genesis (§2.4; §3d C1, H5, H6) ----------
// body {dialect: "eidoverse-log", v: 4, nonce, rewindWindow?, parent?, owners: [[<key>…], …], quorum?, sequencer, requires?, provenance?}. A malformed
// genesis means "no world"; an unknown v means "unknown version". A new feature is declared in `requires`, never by a
// version bump; the fields are exact (a typo such as `rewind_n` is not a default).
export const GENESIS_FIELDS = new Set(["dialect", "v", "nonce", "rewindWindow", "parent", "owners", "quorum", "sequencer", "requires", "provenance"]);
// canonical unpadded base64url (one spelling per byte string), or null
export function b64uDecode(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  // no Buffer here: the browser folds too. Decode, then re-encode: a non-canonical spelling (stray low bits) differs.
  let bin; try { bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4)); } catch { return null; }
  const raw = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return b64uEncode(raw) === s ? raw : null;
}
const b64uEncode = (bytes) => { let t = ""; for (const x of bytes) t += String.fromCharCode(x); return btoa(t).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const hexOf = (bytes) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");
// §2.4 Keys, registration: ed25519:<base64url 32 bytes>, not small-order in any sign-bit encoding, y < p
const SMALL_Y = new Set(["0100000000000000000000000000000000000000000000000000000000000000", "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "0000000000000000000000000000000000000000000000000000000000000000", "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05"]);
const P25519 = 2n ** 255n - 19n;
export function keyOk(k) {
  if (typeof k !== "string" || !k.startsWith("ed25519:")) return false;
  const raw = b64uDecode(k.slice(8)); if (!raw || raw.length !== 32) return false;
  const y = Uint8Array.from(raw); y[31] &= 0x7f;
  return !SMALL_Y.has(hexOf(y)) && BigInt("0x" + hexOf(Uint8Array.from(y).reverse())) < P25519;
}
const nat = (v, lo = 0) => Number.isInteger(v) && v >= lo;
// null if well formed; else throws Malformed (the fields are exact: a stray one, `minor` included, is malformed)
export function checkGenesis(b) {
  const extra = Object.keys(b).filter((k) => !GENESIS_FIELDS.has(k)); if (extra.length) bad("genesis-field", extra.sort().join(","));
  const n = b64uDecode(b.nonce); if (!n || n.length < 16) bad("genesis-nonce", JSON.stringify(b.nonce) ?? "missing");
  if (!Array.isArray(b.owners) || !b.owners.every(Array.isArray)) bad("genesis-owners", "owners is a list of tiers, each a list of keys");
  const seen = new Set();
  for (const t of b.owners) for (const k of t) { if (!keyOk(k)) bad("genesis-key", JSON.stringify(k)); if (seen.has(k)) bad("genesis-owners", "a key in two places: " + k); seen.add(k); }
  if (!("sequencer" in b)) bad("genesis-sequencer", "missing");
  if (!keyOk(b.sequencer)) bad("genesis-key", JSON.stringify(b.sequencer));
  if ("quorum" in b && !(Array.isArray(b.quorum) && b.quorum.length === b.owners.length && b.quorum.every((x) => nat(x, 1)))) bad("genesis-quorum", JSON.stringify(b.quorum));
  if ("rewindWindow" in b && !nat(b.rewindWindow)) bad("genesis-window", JSON.stringify(b.rewindWindow));
  if ("parent" in b) { const p = b.parent, hex = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
    if (!(p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).sort().join() === "head,seq,world" && typeof p.world === "string" && p.world.startsWith("sha256:") && hex(p.world.slice(7)) && nat(p.seq) && hex(p.head)))
      bad("genesis-parent", JSON.stringify(p)); }
  const r = checkRequires(b.requires); if (r) bad("genesis-requires", r.detail);   // §F F-1: what a reader must implement to read this world
  if ("provenance" in b) { const p = checkProvenance(b.provenance); if (p) bad("genesis-provenance", p.code); }   // §F F-2: who wrote it
  return null;
}

// ---------- the fold ----------
export function emptyState() {
  const entities = Object.create(null); entities["@world"] = { born: 0, c: Object.create(null) }; // live from genesis
  return { status: "ok", v: VERSION, worldId: null, entities, diagnostics: [] };
}
// entries: what readLog returned, or entry objects. `until`: fold only change entries with seq <= until (redactions from
// the whole log still apply: a redacted value is absent at every point in time).
export function fold(entries, { until = Infinity } = {}) {
  const st = emptyState(); const d = (seq, code, detail = "") => st.diagnostics.push([seq, code, detail]);
  const ok = checkedEntries(entries, d);
  const g = ok[0];
  if (!g || g.kind !== "genesis") { d(0, "no-genesis", g ? `entry 0 kind=${g.kind}` : "entry 0 missing or malformed"); return { ...st, status: "no-world", entities: null }; }
  if (g.body.dialect !== DIALECT || g.body.v !== VERSION) { d(0, "unknown-version", JSON.stringify(g.body.dialect === DIALECT ? g.body.v : g.body.dialect) ?? "missing"); return { ...st, status: "unknown-version", entities: null, v: g.body.v }; }
  try { checkGenesis(g.body); }
  catch (x) { if (!(x instanceof Malformed)) throw x; d(0, "malformed:" + x.code, x.detail); return { ...st, status: "no-world", entities: null }; }
  st.worldId = worldIdOf(g);
  settledEntries(ok, st.worldId, d);
  // §F F-1: a feature this reader doesn't implement, declared anywhere, means no world (never a partial fold)
  const fd = featureDecision(ok, KNOWN_FEATURES);
  if (fd.malformed) d(fd.malformed.seq, "malformed:" + fd.malformed.code, fd.malformed.detail);
  if (fd.unsupported) { d(fd.unsupported.seq, "unsupported-feature", fd.unsupported.ids.join(",")); return { ...st, status: "unsupported-feature", entities: null }; }
  const redacted = unnamedStubs(ok, redactionsOf(ok, d), d);
  for (let seq = 1; seq < ok.length && seq <= until; seq++) {
    const e = ok[seq]; if (!e || e.kind !== "change") continue;
    let ops; try { ops = opsOf(e); } catch (x) { if (x instanceof Malformed) { d(seq, "malformed:" + x.code, x.detail); continue; } throw x; }
    ops.forEach((op, i) => applyOp(st, seq, op, redacted.get(`${seq}:${e.op === "batch" ? i : "-"}`), d));
  }
  return st;
}
// the set op a redaction target names, if it sets a roles: value (§3d M11). A target that isn't a set stays the fold's
// ordinary "redaction-target-not-a-value" diagnostic.
function governanceTarget(e, op) {
  if (!e || e.kind !== "change" || !e.body || typeof e.body !== "object") return false;
  const o = e.op === "batch" ? (Array.isArray(e.body.ops) && Number.isInteger(op) ? e.body.ops[op] : null) : op === undefined ? { op: e.op, ...e.body } : null;
  return !!o && typeof o === "object" && o.op === "set" && typeof o.comp === "string" && o.comp.startsWith("roles:");
}
// The entries the fold reads, in two steps either side of its genesis checks (so its diagnostics keep their order): each line
// checked alone, then, after genesis, a later genesis, another world's id and a bad ts nulled. acceptedEntries (redactionsIn, operator-bind) reads a
// log through the same two, so the redactions a replay applies and the authors a bind counts are exactly the fold's.
function checkedEntries(entries, d) {
  return entries.map((e, seq) => {
    if (e instanceof Malformed) { d(seq, "malformed:" + e.code, e.detail); return null; }
    try { checkEntry(e, seq); return e; } catch (x) { if (x instanceof Malformed) { d(seq, "malformed:" + x.code, x.detail); return null; } throw x; }
  });
}
function settledEntries(ok, worldId, d) {
  for (let seq = 1; seq < ok.length; seq++) { const e = ok[seq]; if (!e) continue;
    if (e.kind === "genesis") { d(seq, "malformed:genesis-not-first"); ok[seq] = null; continue; }
    if (e.world !== worldId) { d(seq, "malformed:world-mismatch", String(e.world)); ok[seq] = null; } }   // §2: another world's entry shapes nothing (tel0s D2, 11-06)
  // §2.1: ts is an integer (ms) ≥ 0, required on every entry after genesis, never decreasing. A missing, fractional
  // or decreasing ts makes that entry malformed (it shapes nothing and does not move the clock on).
  let lastTs = null;
  for (let seq = 1; seq < ok.length; seq++) { const e = ok[seq]; if (!e) continue; const t = e.ts;
    if (!(Number.isInteger(t) && t >= 0)) { d(seq, "malformed:ts", JSON.stringify(t) ?? "missing"); ok[seq] = null; continue; }
    if (lastTs !== null && t < lastTs) { d(seq, "malformed:ts-decreasing", `${t} < ${lastTs}`); ok[seq] = null; continue; }
    lastTs = t; }
  return ok;
}
// §12: a set written as {commitment} with no value is a redaction's work. One no redaction names (none does, or the one naming it
// is one the fold refuses, as any aimed at a roles: value) was changed outside the one rule that changes the record. It folds
// as absent(redacted), unknown as every reader takes a redacted value (§1), never as the value before it, and the diagnostic
// says so (commitment-unredacted: the line still shapes, so not malformed:). Said, not enforced: writes go on (house markup, #260 10-20).
function unnamedStubs(ok, redacted, d) {
  ok.forEach((e, seq) => { if (!e || e.kind !== "change") return;
    let ops; try { ops = opsOf(e); } catch (x) { if (x instanceof Malformed) return; throw x; }
    ops.forEach((op, i) => { if (!op.stripped) return;
      const k = `${seq}:${e.op === "batch" ? i : "-"}`; if (redacted.has(k)) return;
      redacted.set(k, 0); d(seq, "commitment-unredacted", `${op.id}.${op.comp}`); }); });
  return redacted;
}
function redactionsOf(ok, d) {
  const out = new Map();
  ok.forEach((e, pseq) => {
    if (!e || e.kind !== "redaction") return;
    const vals = e.body.values; if (!Array.isArray(vals)) { d(pseq, "redaction-ignored", "body.values not a list"); return; }
    for (const t of vals) {
      const okT = t && typeof t === "object" && !Array.isArray(t) && Object.keys(t).every((k) => k === "seq" || k === "index")
        && Number.isInteger(t.seq) && (t.index === undefined || (Number.isInteger(t.index) && t.index >= 0));
      if (!okT) { d(pseq, "redaction-target-bad", jcs(t).slice(0, 60)); continue; }
      if (t.seq >= pseq || t.seq <= 0) { d(pseq, "redaction-target-range", String(t.seq)); continue; }
      if (ok[t.seq]?.kind === "redaction") { d(pseq, "redaction-of-redaction-refused", String(t.seq)); continue; }
      // §3d M11: a redaction never targets roles: (governance values are reversed by requests, never erased)
      if (governanceTarget(ok[t.seq], t.index)) { d(pseq, "redaction-target-governance", `seq ${t.seq}${t.index === undefined ? "" : ` index ${t.index}`}`); continue; }
      out.set(`${t.seq}:${t.index ?? "-"}`, pseq); d(pseq, "redaction", `seq ${t.seq}${t.index === undefined ? "" : ` index ${t.index}`}`);
    }
  });
  return out;
}
// REDACTED is kept as itself: wireState and the digest tell a redacted value from a value by identity (review of #260, I117)
const clone = (v) => (v === null || typeof v !== "object" || v === REDACTED ? v : JSON.parse(JSON.stringify(v)));
function applyOp(st, seq, op, redactedBy, d) {
  const w = st.entities, { op: verb, id, comp } = op;
  if (redactedBy !== undefined && verb !== "set") d(seq, "redaction-target-not-a-value", id);
  if (verb === "create") { if (w[id]) d(seq, "noop:create-live", id); else w[id] = { born: seq, c: Object.create(null) }; return; }
  const ent = w[id]; if (!ent) { d(seq, `noop:${verb}-missing-entity`, id); return; }
  if (verb === "set") {
    if (redactedBy !== undefined) { ent.c[comp] = REDACTED; return; }
    if (!("value" in op)) { d(seq, "noop:set-no-value", `${id}.${comp}`); return; }
    ent.c[comp] = clone(op.value); return;
  }
  if (comp === undefined) { if (id === "@world") { d(seq, "noop:delete-@world"); return; } delete w[id]; return; }
  if (comp in ent.c) delete ent.c[comp]; else d(seq, "noop:delete-missing-comp", `${id}.${comp}`);
}

// A copy of a folded state that keeps null prototypes (so an id like "constructor" stays an ordinary key).
export function cloneState(st) {
  const entities = Object.create(null);
  for (const id of Object.keys(st.entities)) { const c = Object.create(null); const e = st.entities[id];
    for (const k of Object.keys(e.c)) c[k] = clone(e.c[k]); entities[id] = { born: e.born, c }; }
  return { ...st, entities, diagnostics: [...st.diagnostics] };
}
// Apply ops to a state copy, as a fold of one more change entry would (the authority's preview of a write). A replay of a
// logged entry passes its seq, the log's redactions and whether it is a batch, as applyInPlace takes them
export const applyOps = (st, ops, seq = Infinity, redacted = null, batch = false) => applyInPlace(cloneState(st), ops, seq, redacted, batch);
// A working copy for applying ops one at a time (the authority's admit, script elision): it shares every entity with `st`
// until an op touches it, then copies that one entity (its component map; values are never mutated in place, a set
// replaces one). The same states as applyOps op by op, without a deep copy of the whole world per op.
const COW = new WeakMap(); // a working copy → the ids it has copied already
export function cowState(st) { const s = { ...st, entities: Object.assign(Object.create(null), st.entities), diagnostics: [...st.diagnostics] }; COW.set(s, new Set()); return s; }
export function applyCow(s, ops, seq = Infinity) {
  let mine = COW.get(s); if (!mine) COW.set(s, (mine = new Set()));
  for (const o of ops) { const id = o?.id; const e = typeof id === "string" ? s.entities[id] : undefined;
    if (e && !mine.has(id)) { s.entities[id] = { born: e.born, c: Object.assign(Object.create(null), e.c) }; mine.add(id); }
    applyInPlace(s, [o], seq); }
  return s;
}
// redacted (optional): the log's redactions, as redactionsIn gives them, and batch: whether the entry is a batch (a redaction names a
// batch's op by index): a reader replaying a log a redaction has touched writes REDACTED where the strict fold does
export function applyInPlace(s, ops, seq = Infinity, redacted = null, batch = false) {
  const d = (q, code, detail = "") => s.diagnostics.push([q, code, detail]);
  // a value stripped to its commitment is a redaction's work, and a caller with no redaction map naming it (the authority's own
  // appends, a live replica) can't read it: the line throws Malformed before any of its ops is applied, and the whole
  // log is read instead (the authority's state re-folds it, whose unnamedStubs reads the line as unknown; a replica's
  // redaction resyncs it)
  const shaped = ops.map((o, i) => { const op = shapeOne(o.op, o, true, "system"), by = redacted?.get(`${seq}:${batch ? i : "-"}`);
    if ((o?.stripped || op.stripped) && by === undefined) bad("commitment-unredacted", `${op.id}.${op.comp}`);
    return [op, by]; });
  for (const [op, by] of shaped) applyOp(s, seq, op, by, d);
  return s;
}
/** every redaction in a log, as the strict fold reads them: `${seq}:${op index, or - for a whole entry}` → the redaction's seq.
 *  The one parser of redaction targets: every other reader derives from this (hygiene-check redaction-parse).
 *  `stubs: false` leaves out the values stripped with no redaction naming them (keyed → 0 otherwise). */
export function redactionsIn(entries, { stubs = true } = {}) {
  const none = () => {}, settled = acceptedEntries(entries), named = redactionsOf(settled, none);
  return stubs ? unnamedStubs(settled, named, none) : named;
}
/** the seqs whose whole request, say or physics body a redaction names (§12), from redactionsIn's map */
export function redactedBodies(entries, red = redactionsIn(entries, { stubs: false })) {
  const out = new Set();
  for (const k of red.keys()) { const [s, i] = k.split(":"); const e = entries[+s];
    if (i === "-" && ["request", "say", "physics"].includes(e?.kind)) out.add(+s); }
  return out;
}
/** the entries the strict fold accepts, by seq (null where it rejects one); none where it reads no world (#260 Stella 10-30).
 *  `ops`: also null a change whose ops the fold skips as malformed (a bind's authors; redactionsIn keeps the fold's own input). */
export function acceptedEntries(entries, { ops = false } = {}) {
  const none = () => {}; const ok = checkedEntries(entries, none); const g = ok[0];
  if (!g || g.kind !== "genesis" || g.body.dialect !== DIALECT || g.body.v !== VERSION) return [];   // the fold reads no world here
  try { checkGenesis(g.body); } catch (x) { if (x instanceof Malformed) return []; throw x; }
  const settled = settledEntries(ok, worldIdOf(g), none);
  if (featureDecision(settled, KNOWN_FEATURES).unsupported) return [];
  if (ops) for (let seq = 1; seq < settled.length; seq++) { const e = settled[seq]; if (e?.kind !== "change") continue;
    try { opsOf(e); } catch (x) { if (x instanceof Malformed) settled[seq] = null; else throw x; } }
  return settled;
}
