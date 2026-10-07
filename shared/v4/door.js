// The v4 door (lab). Every request is resolved here once; the log receives the request as sent (an `act` entry) and
// the plain results it produced (one `state` entry, `cause` = the act's seq). Replay never runs this file.
// PROTOCOL-v4 L7: every state write, from every path (tools, use handlers, undo, put, create-from, rests, the door's
// own follow-ups), is admitted by ONE function, `admit`, keyed on who asks, which components change (old and new),
// locks, where it lands, sanity and rate. Tool checks may only add to it. The only code that appends a state entry is
// `stateEntry`, and it takes only what `admit` returned.
// Ported from the v4 lab (code/v4-lab/door.js @ 11db981). Engine change: storage is injected. The lab's openWorld
// read and wrote files here; that part is server/v4/disk.js now, so this module has no node: imports and no
// process/Date of its own (callers pass the clock). Everything from `w.worldId` down is the lab's code unchanged.
import { bodyOf, socketQ } from "../components.js";
import { checkSockets } from "../sockbody.js";
import { grabOf, checkGrabbable, wantsHome, fitsSocket, socketRadius, pickGrip, offsetOk, describeGrab } from "../grab.js";
import { readLog, fold, opsOf, applyOps, applyInPlace, cloneState, checkEntry, checkIJSON, isEntityId, isComponent, isIdentity, jcs, sha256, worldIdOf, Malformed, PURGED, VERSION } from "./fold.js";
import { MODELS, COMPONENTS, PENDULUM } from "./catalogue.js";
import { validate, toolHelp, TOOLSPEC } from "./toolspec.js";
import { dec } from "./names.js";
import { foldSkyEntry } from "../forecast.js";
import { sha256Bytes, hexBytes } from "./hash.js";
import * as C from "./consent.js";
import * as TR from "./terrain.js";
import * as SR from "./scriptrules.js";
import { simFold, livePoses, digestOf, restEta, ENGINES, carried, worldPose } from "./simlayer.js";

// ---------- the model catalogue (engine, slice 2) ----------
// The lab's door read its own table (./catalogue.js). The engine's models are library paths measured from their GLBs
// (server/v4/catalogue.ts), so the catalogue is injected: io.catalogue = { get(name) → entry | undefined,
// list(query) → [name, entry][] }. An entry is { label, size?, box?, surfaces, solids?, sockets? }:
//   box      [[x,y,z], [x,y,z]] in the model's frame (a GLB's origin is wherever its author put it); absent → the lab's
//            convention, a size-box with the origin at the base centre;
//   surfaces [{y, x?: [min,max], z?: [min,max], inset?}] in the model's frame (measured flat zones carry x/z);
//   size     absent → a model this door can name but not measure (no placement help, no collisions, said so).
// request() sets CAT for the duration of one synchronous call; nothing in the door awaits, so calls can't interleave.
// own keys only: MODELS["constructor"] is Object (the lab door accepted model "constructor"; L1's no-prototype rule)
export const LAB_CATALOGUE = Object.freeze({ get: (n) => (Object.hasOwn(MODELS, n) ? MODELS[n] : undefined), list: (q) => Object.entries(MODELS).filter(([k, m]) => k.includes(q) || m.label.includes(q)) });
let CAT = LAB_CATALOGUE;
let THROUGH = false; // the request's through_lock flag, set by request() for one synchronous call (like CAT)
// is this identity a guest (no account: the door directory's kind "anon")? set by request() from w.kindOf (security review 10-06 H4)
let ISANON = () => false;
// the directory knows this identity (a world opened without a directory, as in the lab, knows everyone)
let KNOWNID = (_id) => true;
const modelOf = (name) => (typeof name === "string" ? CAT.get(name) : undefined);
const geomOf = (name) => { const m = modelOf(name); return m && m.size ? m : undefined; };
const boxOfM = (m) => m.box ?? [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
/** Run fn with world w's catalogue in force (also for callers outside request(), e.g. a server's settle tick). */
export function withCatalogue(w, fn) { const prev = CAT; CAT = w.catalogue ?? LAB_CATALOGUE; try { return fn(); } finally { CAT = prev; } }

// ---------- storage ----------
const STATE = Symbol("admitted state write");
export const posAt = (e, i) => { if (e && typeof e === "object") Object.defineProperty(e, "seq", { value: i, enumerable: false, configurable: true }); return e; };
/**
 * A world over injected storage.
 * @param {{ name: string, entries: any[], getBlob: (h: string) => any, putBlob: (v: any) => string,
 *   writeLine: (line: string) => void, now: () => number,
 *   presence?: { bodies: object, holds: object }, savePresence?: (p: object) => void }} io
 *   entries: what readLog returned for the log so far, each with its seq attached by posAt (unenumerable).
 *   getBlob must verify a blob against its name and throw if it doesn't match (§2.2).
 *   writeLine appends one already-checked line (no trailing LF) to durable storage.
 *   now: the door's clock in ms (§2.1 ts); presence: the unlogged presence plane (P1, P2).
 */
export function worldOf(io) {
  const { name, entries, getBlob, putBlob } = io;
  const w = { name, entries, getBlob, putBlob, exists: entries.length > 0, catalogue: io.catalogue ?? null };
  w.worldId = entries[0] && !(entries[0] instanceof Malformed) ? worldIdOf(entries[0]) : null;
  w.random = io.random ?? null;
  w.kindOf = io.kindOf ?? null; // id → human|agent|anon|legacy (the directory): an anonymous identity gets a smaller budget
  w.nameOf = io.nameOf ?? null; // id → display name (the door's directory, §2.3); null = old escaped ids only
  w.now = io.now;
  // scripts (research 41): the sandbox is injected ({run, checkSyntax, available}: shared/v4/sandbox.js), never imported
  // here (browsers import this file). No sandbox: scripts install, and every activation says "unavailable".
  w.scripts = io.scripts ?? null;
  // who is present beyond the door's own bodies (a server's connected people): () => [{id, at: [x,y,z] | null}]
  w.present = io.present ?? null;
  // the presence plane: bodies and holds. Transient, never logged (P1, P2)
  w.presence = io.presence ?? { bodies: {}, holds: {} };
  w.savePresence = () => io.savePresence?.(w.presence);
  // Governance keys (§2.4) live outside the log. Custody is door practice (§5 identity), injected like storage:
  // io.custody = { sequencer() → "ed25519:…", keyOf(who, make?) → "ed25519:…" | null } (server/v4/disk.ts keeps the keys).
  w.custody = () => io.custody ?? null;
  // §2.1: moderation lives in a SEPARATE moderator log with door enforcement, never in the world log
  w.mod = io.mod ?? [];
  w.appendMod = (e) => { const r = { ts: Math.floor(w.now()), ...e }; w.mod.push(r); io.appendMod?.(r); };
  let cache = null; // the folded state is a view, rebuilt when the log grows (callers never mutate it)
  // incremental when the new lines are plain entries this door wrote (state/act/sim/say): clone + apply their ops, which
  // is what the fold does for them; anything else (a purge, a governance entry, a malformed line) re-folds from scratch
  w.state = () => { if (cache?.n === entries.length) return cache.st;
    const fresh = entries.slice(cache?.n ?? 0);
    if (cache && cache.st.status === "ok" && fresh.every((e) => isE(e) && ["state", "act", "sim", "say"].includes(e.kind))) {
      const st = cloneState(cache.st); fresh.forEach((e, k) => { if (e.kind === "state") applyInPlace(st, opsOf(e), cache.n + k); });
      return (cache = { n: entries.length, st }).st; }
    return (cache = { n: entries.length, st: fold(entries) }).st; };
  // §2.4 chain heads as a view over the log (the lab door doesn't sign them): head(i) = sha256(head(i-1) ‖
  // sha256(JCS(skeleton(i)))), exactly as conformance/chain.py computes them. A version is {seq, head} (§3d M7).
  const heads = [];
  w.headAt = (seq) => { for (let i = heads.length; i <= seq && i < entries.length; i++) { const e = entries[i], prev = i === 0 ? "00".repeat(32) : heads[i - 1];
      heads[i] = isE(e) && prev ? chainStep(prev, e) : null; } return heads[seq] ?? null; };
  // §3d H7: every id this world has ever created (a log view, kept incrementally): an id is never reused
  const ever = { n: 0, ids: new Set() };
  w.everIds = () => { for (; ever.n < entries.length; ever.n++) { const e = entries[ever.n]; if (isE(e) && e.kind === "state") for (const o of opsQuiet(e)) if (o.verb === "create") ever.ids.add(o.id); } return ever.ids; };
  w.sim = () => simFold(entries, w.now());
  w.stateAt = (seq) => fold(entries, { until: seq });
  // The door re-reads every line it writes with the strict reader: it can never write what a reader would refuse.
  // §2.1: ts = the door's admission time, an integer that never decreases along the log (a clock that steps back,
  // an NTP slew or a VM restore, must not make the door write a line every reader refuses)
  w.nextTs = () => { let lastTs = 0; for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastTs = entries[i].ts; break; }
    return Math.max(Math.floor(w.now()), lastTs); };
  // §2.4 the chain: "the door signs at least every write it commits". When custody can sign, every entry after
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
      obj.head = head; obj.sig = io.custody.sign(`eidoverse-v4-head:${w.worldId}:${seq}:${head}`); }
    const line = JSON.stringify(obj);
    const [parsed] = readLog(line); let bad = parsed instanceof Malformed ? parsed : null;
    if (!bad) try { checkEntry(parsed, seq); } catch (x) { bad = x; }
    return { line, parsed, bad };
  };
  // Would these entries, appended in this order, all be lines a reader accepts? Checked BEFORE any is written, so a
  // request is all or nothing (an act is never left without its result, 33 C2). A size or depth cap is a refusal.
  w.fits = (...es) => { for (const [k, e] of es.entries()) { const { bad } = render(e, entries.length + k); if (!bad) continue;
    if (/^cap-/.test(bad.code)) refuse("too-big", `that would be a ${bad.code === "cap-size" ? `${bad.detail}-byte` : "too deeply nested"} ${e.kind} entry; a log line is at most 1 MiB, 64 deep (§2.4)`, "split it into smaller requests, or put big data in a blob and store its hash");
    throw new Error(`door bug: would write a malformed entry (${bad.code} ${bad.detail})`); } };
  w.append = (e, token) => {
    if (e.kind === "state" && token !== STATE) throw new Error("door bug: a state entry must come from stateEntry (L7: one gate)");
    w.fits(e); const { line, parsed, bad } = render(e, entries.length, true); const seq = entries.length;
    if (bad) throw new Error(`door bug: would write a malformed entry (${bad.code} ${bad.detail})`); // e.g. the chain fields tipped it over a cap
    entries.push(posAt(parsed, seq)); Object.defineProperty(parsed, "bytes", { value: line.length, enumerable: false }); io.writeLine(line);
    if (e.kind === "genesis") w.worldId = worldIdOf(parsed);
    w.exists = true; return seq;
  };
  return w;
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
  else if (e.kind === "state") s.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map((o) => (o?.verb === "set" ? skelOp(o) : o)) } : e.verb === "set" ? skelOp(e.body) : e.body;
  return s;
}
const chainStep = (prevHex, e) => { const b = new Uint8Array(64); b.set(hexBytes(prevHex), 0); b.set(hexBytes(sha256(jcs(skeleton(e)))), 32); return sha256Bytes(b); };
/** Seal a whole log the door didn't write line by line (a translation): the same salts and chain points render gives
 *  each line it appends (§2.4; round-2 review R3). entries[0] is genesis (never a chain point: the world id is its
 *  hash); every later entry gets a salt on each set and on its act/say/sim body, then {head, sig}. Returns new objects;
 *  `sign(msg)` is the sequencer key's, `random(n)` optional. */
export function seal(entries, { sign, random } = {}) {
  if (typeof sign !== "function") throw new Error("seal needs the sequencer's sign()");
  const w = { random: random ?? null }; const out = []; let prev = "00".repeat(32); const wid = worldIdOf(entries[0]);
  for (let i = 0; i < entries.length; i++) {
    let e = JSON.parse(JSON.stringify(entries[i])); delete e.head; delete e.sig;
    if (i > 0) {
      if (e.kind === "state") { const salt = (o) => (o?.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o);
        e.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map(salt) } : e.verb === "set" ? salt({ verb: "set", ...e.body }) : e.body;
        if (e.verb === "set") { const { verb: _v, ...b } = e.body; e.body = b; } }
      else if (["act", "say", "sim"].includes(e.kind) && e.body && typeof e.body === "object" && !Array.isArray(e.body) && !("salt" in e.body)) e.body = { ...e.body, salt: nonce16(w) };
    }
    prev = chainStep(prev, e);
    if (i > 0) { e.head = prev; e.sig = sign(`eidoverse-v4-head:${wid}:${i}:${prev}`); }
    out.push(e);
  }
  return out;
}
// §3d M7: expect by version is {seq, head}, never a bare seq. A head this history doesn't have at that seq means the
// version was read on a branch that was rewound (or in another world): refused, never compared by seq alone.
function versionSeq(w, v, what) {
  if (!(v && typeof v === "object" && !Array.isArray(v) && Number.isInteger(v.seq) && typeof v.head === "string" && Object.keys(v).length === 2))
    refuse("shape", `${what} is a version {seq, head}, never a bare seq (§3d M7)`, "inspect {id} → versions gives {seq, head} for each component; a write's result carries its own seq and head");
  if (v.seq < 0 || v.seq >= w.entries.length || w.headAt(v.seq) !== v.head)
    refuse("other-branch", `${what} {seq: ${v.seq}} names a head this world's history doesn't have at that seq: it was read on a branch that was rewound, or elsewhere`, "inspect again and redo the change on what's here");
  return v.seq;
}
const versionOf = (w, seq) => (seq === undefined || seq === null ? null : { seq, head: w.headAt(seq) });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// PROTOCOL-v4 §5 (locks: decided): `lock` is v1's lock with v1's meaning, so an old log's locks carry over untranslated.
// A lock is on when its value is truthy, exactly as v1 read it (`comp.lock`); the door itself only ever writes `true`.
// A purged value is absent(purged), not a lock. The lab's `pinned` and top-level `locked` are retired.
const lockedC = (c) => { const v = c?.lock; return v !== undefined && v !== PURGED && !!v; };
const r3 = (n) => Math.round(n * 1000) / 1000;
const setOp = (id, comp, value) => ({ verb: "set", id, comp, value });
const delOp = (id, comp) => (comp === undefined ? { verb: "delete", id } : { verb: "delete", id, comp });
const createOps = (id, comps) => [{ verb: "create", id }, ...Object.entries(comps).map(([k, v]) => setOp(id, k, v))];
const scratch = (st, ops) => applyOps(st, ops);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thing";

// ---------- math (yaw-only rotation is enough for placement in this lab; q is stored whole) ----------
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const qYaw = (q) => 2 * Math.atan2(q[1], q[3]);
function qmul(a, b) {
  return [a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1], a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
          a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3], a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]];
}
function qrot(q, v) {
  const [x, y, z, w] = q; const [vx, vy, vz] = v;
  const tx = 2*(y*vz - z*vy), ty = 2*(z*vx - x*vz), tz = 2*(x*vy - y*vx);
  return [vx + w*tx + (y*tz - z*ty), vy + w*ty + (z*tx - x*tz), vz + w*tz + (x*ty - y*tx)];
}
const qinv = (q) => [-q[0], -q[1], -q[2], q[3]];

function worldT(st, id, depth = 0) {
  const e = st.entities[id]; if (!e) return null;
  const t = { ...COMPONENTS.transform.defaults, ...(e.c.transform ?? {}) };
  const p = e.c.parent?.to;
  if (!p || depth > 32 || !st.entities[p]) return t;
  const pt = worldT(st, p, depth + 1);
  const off = qrot(pt.q, t.pos.map((v, i) => v * pt.scale[i]));
  return { pos: pt.pos.map((v, i) => v + off[i]), q: qmul(pt.q, t.q), scale: t.scale.map((v, i) => v * pt.scale[i]) };
}
function localFrom(st, parentId, wt) {
  const pt = worldT(st, parentId);
  const d = qrot(qinv(pt.q), wt.pos.map((v, i) => v - pt.pos[i]));
  return { pos: d.map((v, i) => r3(v / pt.scale[i])), q: qmul(qinv(pt.q), wt.q).map(r3), scale: wt.scale.map((v, i) => r3(v / pt.scale[i])) };
}
function aabb(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return null;
  const t = worldT(st, id); const [lo0, hi0] = boxOfM(m);
  const corners = [];
  for (const x of [lo0[0], hi0[0]]) for (const y of [lo0[1], hi0[1]]) for (const z of [lo0[2], hi0[2]]) {
    const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]);
    corners.push(p.map((v, i) => v + t.pos[i]));
  }
  const min = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i])));
  const max = [0, 1, 2].map((i) => Math.max(...corners.map((c) => c[i])));
  return { min, max };
}
function solids(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return [];
  if (!m.solids) { const b = aabb(st, id); return b ? [b] : []; }
  const t = worldT(st, id);
  return m.solids.map(([lo, hi]) => { const cs = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) { const p = qrot(t.q, [x * t.scale[0], y * t.scale[1], z * t.scale[2]]); cs.push(p.map((v, i) => v + t.pos[i])); }
    return { min: [0, 1, 2].map((i) => Math.min(...cs.map((c) => c[i]))), max: [0, 1, 2].map((i) => Math.max(...cs.map((c) => c[i]))) }; });
}
// Oriented boxes + the separating-axis test (F21): world-AABBs of rotated solids fatten into false overlaps.
function obbs(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); if (!m) return [];
  const t = worldT(st, id); const boxes = m.solids ?? [boxOfM(m)];
  const ax = [qrot(t.q, [1, 0, 0]), qrot(t.q, [0, 1, 0]), qrot(t.q, [0, 0, 1])];
  return boxes.map(([lo, hi]) => { const lc = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2 * t.scale[i]);
    const off = qrot(t.q, lc); return { c: t.pos.map((v, i) => v + off[i]), ax, h: [0, 1, 2].map((i) => Math.abs(hi[i] - lo[i]) / 2 * Math.abs(t.scale[i])) }; });
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const crs = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function satDepth(A, B) { // smallest penetration over the 15 axes; <= 0 means separated
  const d = B.c.map((v, i) => v - A.c[i]); let best = Infinity;
  const axes = [...A.ax, ...B.ax]; for (const a of A.ax) for (const b of B.ax) { const c = crs(a, b); const n = Math.hypot(...c); if (n > 1e-6) axes.push(c.map((v) => v / n)); }
  for (const L of axes) { const ra = A.h.reduce((t, h, i) => t + h * Math.abs(dot(A.ax[i], L)), 0), rb = B.h.reduce((t, h, i) => t + h * Math.abs(dot(B.ax[i], L)), 0);
    const p = ra + rb - Math.abs(dot(d, L)); if (p < best) best = p; if (best <= 0) return best; }
  return best;
}
const boxToObb = (b) => ({ c: [0, 1, 2].map((i) => (b.min[i] + b.max[i]) / 2), ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [0, 1, 2].map((i) => (b.max[i] - b.min[i]) / 2) });
const hits = (box, st, id, eps) => { const B = boxToObb(box); return obbs(st, id).some((o) => satDepth(B, o) > eps); };
const overlap = (a, b, eps = 0.01) => [0, 1, 2].every((i) => a.min[i] < b.max[i] - eps && b.min[i] < a.max[i] - eps);
const descendants = (st, id) => Object.keys(st.entities).filter((k) => {
  let p = st.entities[k].c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false;
});
const ancestors = (st, id) => { const out = []; let p = st.entities[id]?.c.parent?.to, n = 0; while (p && n++ < 32) { out.push(p); p = st.entities[p]?.c.parent?.to; } return out; };

function surfacesOf(st, id) {
  const e = st.entities[id]; const m = geomOf(e?.c.model); const b = aabb(st, id); if (!m || !b) return [];
  const t = worldT(st, id);
  return (m.surfaces ?? []).map((s, i) => { const k = s.inset ?? 0;
    if (s.x && s.z) { // a measured zone: its own rectangle, carried into the world (the axis-aligned box of its corners)
      const cs = [[s.x[0], s.z[0]], [s.x[0], s.z[1]], [s.x[1], s.z[0]], [s.x[1], s.z[1]]].map(([x, z]) => { const p = qrot(t.q, [x * t.scale[0], s.y * t.scale[1], z * t.scale[2]]); return [p[0] + t.pos[0], p[2] + t.pos[2]]; });
      return { id, level: i, y: t.pos[1] + s.y * t.scale[1], min: [Math.min(...cs.map((c) => c[0])) + k, Math.min(...cs.map((c) => c[1])) + k], max: [Math.max(...cs.map((c) => c[0])) - k, Math.max(...cs.map((c) => c[1])) - k] }; }
    return { id, level: i, y: t.pos[1] + s.y * t.scale[1], min: [b.min[0] + k, b.min[2] + k], max: [b.max[0] - k, b.max[2] - k] }; });
}
function supportBelow(st, x, z, y, ignore = new Set()) {
  let best = { y: 0, id: "ground" };
  for (const id of Object.keys(st.entities)) {
    if (ignore.has(id)) continue;
    for (const s of surfacesOf(st, id))
      if (x >= s.min[0] && x <= s.max[0] && z >= s.min[1] && z <= s.max[1] && s.y <= y + 0.02 && s.y > best.y) best = { y: s.y, id };
  }
  return best;
}

// Supported anywhere under its footprint (the engine's rule: a box rests on a top its footprint overlaps), not just
// under its centre — so a thing physics left resting is never called floating by the door (playtest 22, F5).
function supportUnder(st, b, ignore) {
  let best = { y: 0, id: "ground" };
  for (const id of Object.keys(st.entities)) { if (ignore.has(id)) continue;
    for (const s of surfacesOf(st, id)) if (b.max[0] > s.min[0] && b.min[0] < s.max[0] && b.max[2] > s.min[1] && b.min[2] < s.max[1] && s.y <= b.min[1] + 0.02 && s.y > best.y) best = { y: s.y, id }; }
  return best;
}

// ---------- rights ----------
const RANK = { none: -1, visitor: 0, builder: 1, owner: 3 };
const ownersOf = (st) => { const c = st.entities?.["@world"]?.c ?? {}; return Object.keys(c).filter((k) => k.startsWith("roles:") && c[k]?.role === "owner"); };
// §2.3: an empty owner list means NOBODY above visitor. A world may declare a default role for strangers
// (`default-role`, what a v1 `roles['*']` becomes); absence means visitor.
function roleOf(st, actor, anon = ISANON(actor)) {
  const c = st.entities?.["@world"]?.c; if (!c) return "none";
  // a guest (no account) is never given the world's default role: it's for people who proved who they are. An owner
  // may still grant a guest a role by its id (H4: an anonymous connection was a builder wherever default-role was)
  // …unless the world opts guests in (`default-role.guests`, R 10-06): explicit, default visitor, never above the default role
  const dr = c["default-role"]; const guestRole = dr?.guests === "builder" && dr?.role === "builder" ? "builder" : "visitor";
  let r = c[`roles:${actor}`]?.role ?? (anon ? guestRole : dr?.role ?? "visitor");
  if (RANK[r] === undefined) r = "visitor";
  return !ownersOf(st).length && RANK[r] > RANK.visitor ? "visitor" : r;
}
/** The role the door gives `actor` in a folded state (a view: what a client should be told it may do here). */
export const roleIn = (st, actor, { anon = false } = {}) => roleOf(st, actor, anon);
const opsQuiet = (e) => { try { return opsOf(e); } catch { return []; } };
// ---------- views over the log: who did what (L2: derived, never stored) ----------
const isBhv = (a) => typeof a === "string" && a.startsWith("bhv:");
export const isBanned = (w, who) => { let b = false; for (const m of w.mod) if (m.who === who && (m.verb === "ban" || m.verb === "unban")) b = m.verb === "ban"; return b; };
// Who a state entry is "by": its cause's actor (the person whose request it was), and whose RIGHTS admitted it. Those
// differ for a `use`: the visitor pulled the lever, but the handler's author's rights made the change, and the act
// records that author (capability.author). Entries with no act for a cause (rests, genesis-era) are their own actor's.
function entryBy(w, e) {
  const c = w.entries[e.cause];
  const by = isE(c) && c.kind === "act" ? c.actor : e.actor;
  // a behaviour's results were admitted with its SPONSOR's rights (L4), which its act names (checkable from sponsorAt)
  return { seq: e.seq, by, rights: (isE(c) && c.kind === "act" && (c.body?.capability?.author || (isBhv(c.actor) && c.body?.sponsor))) || by };
}
// The creator of a thing (comp undefined), or of component `comp` on it, in its CURRENT life: the entry that made it
// present after it was last absent. null if it isn't present now. { seq, by, rights }.
// The state entries that may touch `id`, newest first. A live world (server/v4) keeps an index id → seqs so these
// views cost the thing's own history, not the whole log's; without one (the suites) every entry is a candidate.
function* backward(w, id) {
  if (w.touching) { const a = w.touching(id); for (let k = a.length - 1; k >= 0; k--) yield a[k]; return; }
  for (let i = w.entries.length - 1; i >= 0; i--) yield i;
}
export function creatorOf(w, id, comp) {
  let found = null;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (comp === undefined) { if (o.verb === "create") return entryBy(w, e); if (o.verb === "delete" && o.comp === undefined) return null; continue; }
      if (o.verb === "set" && o.comp === comp) found = e;
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found && entryBy(w, found); } }
  return found && entryBy(w, found);
}
// Who last set (or deleted) component `comp` on a thing: { seq, by, rights, deleted } or null if nobody ever has.
export function lastSetterOf(w, id, comp) {
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id || o.comp !== comp || o.verb === "create") continue;
      return { ...entryBy(w, e), deleted: o.verb === "delete" }; } }
  return null;
}
// Who made a thing: the view inspect shows (no stored `placer`).
const madeBy = (w, id) => creatorOf(w, id)?.by ?? null;

// ---------- the door ----------
class Refusal extends Error { constructor(code, reason, teach, extra = {}) { super(reason); Object.assign(this, { code, reason, teach, ...extra }); } }
const refuse = (code, reason, teach, extra) => { throw new Refusal(code, reason, teach, extra); };
// A person's name as they spell it, for a refusal's words. An actor is an opaque id (u-…); its name lives in the door's
// directory, outside the log (§2.3), injected as io.nameOf and read here for one request at a time (like CAT). An old
// escaped identity (x--416e6e…) still reads back as "Ann". The identity itself rides as a field (`by`) for whoever
// must match it.
let NAMEOF = null;
const said = (id) => NAMEOF?.(String(id)) ?? dec(String(id)) ?? String(id);
// tools that write nothing to the log (the custody guard lets them through: a world you can't sign for can still be read)
const READ_ONLY = new Set(["help", "look", "inspect", "measure", "find", "check", "history", "schema", "scripts"]);
const RESERVED = new Set(["door", "sim", "world"]); // the door's own identities: a request can never be stamped as one

// A request as sent must itself be I-JSON (it is logged as the act). -0 is normalised; non-finite is refused.
function wire(args) {
  const walk = (v) => { if (typeof v === "number" && !Number.isFinite(v)) refuse("shape", `numbers must be finite, got ${v}`, "I-JSON: finite numbers only");
    if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(args); const out = JSON.parse(JSON.stringify(args ?? {}));
  try { checkIJSON(out); } catch (x) { refuse("shape", `the request isn't I-JSON (${x.code})`, "RFC 7493: UTF-8, no duplicate keys, finite numbers, integers within 2^53"); }
  return out;
}

export function request(w, actor, tool, args = {}) {
  const prevCat = CAT, prevThrough = THROUGH, prevName = NAMEOF, prevAnon = ISANON, prevKnown = KNOWNID; CAT = w.catalogue ?? LAB_CATALOGUE; THROUGH = false; NAMEOF = w.nameOf ?? null;
  ISANON = (id) => w.kindOf?.(id) === "anon"; KNOWNID = (id) => id === actor || !w.kindOf || w.kindOf(id) != null;   // the asker is known (a founder names themself)
  // ONE clock per request (§2.1: ts is the door's admission time). A wall clock read twice in one request could put a
  // rest's digest (computed where the engine stood at the first read) under a later ts, across a tick boundary, and every
  // carrier re-folding the log would then call the door's own digest wrong (physlive Q1).
  const clock = w.now; const t0 = clock(); w.now = () => t0;
  try {
    if (!isIdentity(actor) || RESERVED.has(actor)) refuse("identity", `'${actor}' isn't an identity the door can stamp`, "identities are a–z, 0–9 and '-', up to 64 (§2.3); door, sim and world are the door's own");
    const h = TOOLS[tool];
    if (h && !w.exists && !["new", "help"].includes(tool)) refuse("no-world", `there is no world called '${w.name}' yet`, `new {title: '…'} founds it (you become its owner); or pick a world that exists`);
    // §2.4: chain points are signed by the key genesis names (or the latest handoff). A door holding another key would
    // write lines its own verifier calls forged (a moved dir, a lost or swapped custody file): it refuses instead (R5).
    if (h && w.exists && w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer && !READ_ONLY.has(tool))
      refuse("custody", "this door doesn't hold the key that signs this world (its genesis names another sequencer)", "the operator restores the world's custody file, or hands the sequencer over (§2.4 handoff); reads still work");
    if (h && w.exists && w.state().status !== "ok") refuse("unreadable", `this world's log folds to '${w.state().status}'`, "the door won't write to a log its own reader refuses");
    if (!h) refuse("unknown-tool", `there is no '${tool}'`, "help lists every tool", { didYouMean: guess(tool, Object.keys(TOOLS)) });
    if (w.exists && tool !== "help" && isBanned(w, actor)) refuse("banned", `${actor} is banned from this world`, "the moderator log says so; ask a moderator");
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    if (h && w.exists) { settleSim(w); returnDue(w); expireAsks(w); }
    args = wire(args);
    // through_lock (§5) is a flag on any request, not an argument of one tool: checked here, then admit reads it
    // expect (§3a) is the same kind of flag: the values a gesture started from. Checked here, before anything is built
    const { through_lock, expect, ...plain } = args;
    if (through_lock !== undefined && typeof through_lock !== "boolean") refuse("shape", `through_lock is true or false, got ${JSON.stringify(through_lock)}`, "send through_lock: true to act through a lock you may remove");
    THROUGH = through_lock === true;
    const bad = validate(tool, plain); if (bad) { const { code, reason, teach, ...rest } = bad; refuse(code, reason, teach, rest); }
    if (expect !== undefined) expectCheck(w, expect);
    if (tool === "create" && args.place) { const b2 = validate("place", { ...args.place, id: "x" }); if (b2) { const { code, reason, teach, ...rest } = b2; refuse(code, `place: ${reason}`, teach, rest); } }
    const r = h(w, actor, args);
    drainHeld(w);    // grab / release (grabbable): scripts whose scope covers the thing hear who took it, how it was let go
    drainScripts(w); // what the request's own entries trigger (changed:<comp>, say), after them, each its own activation
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; }
    if (r && r.refused && !r.refused.teach) r.refused.teach = toolHelp(tool) ? `help {tool: '${tool}'} shows its arguments with examples` : "help lists every tool";
    return r;
  } catch (e) {
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } // a refusal still updates the door's own ring and throttle (presence, unlogged)
    if (e instanceof Refusal) { logRefusal(w, actor, tool, args, e.code); const { code, reason, teach, ...rest } = e; return { ok: false, refused: { code, reason, teach: teach || (TOOLSPEC[tool] ? `help {tool: '${tool}'} shows its arguments with examples` : "help lists every tool"), ...pick(rest) } }; }
    throw e;
  } finally { CAT = prevCat; THROUGH = prevThrough; NAMEOF = prevName; ISANON = prevAnon; KNOWNID = prevKnown; w.now = clock; }
}
// R7: a refused write is part of the record (what someone TRIED, in true order; §2.1 "the request as sent, plus its
// refusal if refused"): an act whose body is {request, refused: {code}}, the request cut to 2 KiB, inside the actor's
// byte budget. Never logged: reads, dry runs, and the refusals that ARE the budget or the door's own state (rate,
// identity, no-world, custody, unreadable, banned): logging those would be the flood. Past the budget, the door counts
// what it didn't write, and the next refusal it does write says how many (`unrecorded`).
const UNLOGGED = new Set(["rate", "identity", "no-world", "custody", "unreadable", "banned"]);
function logRefusal(w, actor, tool, args, code) {
  try {
    // a tool the door doesn't have is recorded too (an agent's invented tool is part of what it tried), when it's a name
    if (!w.exists || !(TOOLS[tool] || /^[a-z][a-z0-9-]{0,31}$/.test(String(tool))) || READ_ONLY.has(tool) || args?.dry === true || !isIdentity(actor) || RESERVED.has(actor)) return;
    // a step of a body the door already tracks is presence, recorded neither when taken nor when refused (a person's
    // client keeps the track current several times a second; a seated or flying body would write a refusal each time)
    if (tool === "move" && args?.teleport !== true && w.presence.bodies[actor]) return;
    if (code === "rate") { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; } // an attempt all the same: counted, not written
    if (UNLOGGED.has(code)) return;
    let req = stripDry(args ?? {}); try { checkIJSON(req); } catch { req = { unloggable: "not I-JSON" }; } const j = jcs(req);
    const body = { request: j.length > 2048 ? { truncated: true, bytes: j.length } : req, refused: { code } };
    const miss = (w.unrecorded ??= new Map()); const n = miss.get(actor) ?? 0; if (n) body.unrecorded = n;
    try { rateCheck(w, actor, "act", jcs(body).length + 256); } catch (x) { if (x instanceof Refusal) { miss.set(actor, n + 1); return; } throw x; }
    w.append(actEntry(w, actor, tool, body)); miss.delete(actor);
  } catch { /* logging a refusal never fails the request it records */ }
}
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !["message", "stack"].includes(k)));
// §3a: "Release settles as one act with `expect` on the starting values." expect is a list of {id, component, value?}:
// the component must hold exactly that value now (JCS-equal), or be absent when value is left out. Anything else is
// refused as `changed`, naming who changed it, and nothing is written. It is door practice (the act records it, as
// sent); the fold never reads it. A purged value never equals anything.
function expectCheck(w, list) {
  if (!Array.isArray(list) || !list.length || list.length > 256) refuse("shape", "expect is a list of {id, component, value?} (1–256 of them)", "e.g. expect: [{id: 'lamp-1', component: 'transform', value: {pos, q, scale}}]");
  const st = w.state();
  for (const x of list) {
    if (!x || typeof x !== "object" || Array.isArray(x) || typeof x.id !== "string" || typeof x.component !== "string" || Object.keys(x).some((k) => !["id", "component", "value"].includes(k)))
      refuse("shape", `expect entries are {id, component, value?}, got ${JSON.stringify(x)?.slice(0, 80)}`, "leave value out to expect the component to be absent");
    const e = st.entities[x.id]; const has = !!e && x.component in e.c; const cur = has ? e.c[x.component] : undefined;
    const same = "value" in x ? has && cur !== PURGED && jcs(cur) === jcs(x.value) : !has;
    if (same) continue;
    const lt = lastTouch(w, x.id, x.component);
    const why = !e ? `${x.id} is gone` : lt ? `${said(lt.actor)} changed it at ${lt.seq}` : "it isn't what you started from";
    refuse("changed", `${x.id}.${x.component} changed since you started: ${why}`, "look again and redo it (nothing was written); or send it without expect to overwrite what's there",
      { id: x.id, component: x.component, expected: "value" in x ? x.value : null, current: cur === undefined ? null : cur, ...(lt ? { by: lt.actor, at: lt.seq } : {}) });
  }
}
function guess(s, opts) {
  const d = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return m[a.length][b.length]; };
  const toks = (x) => String(x).toLowerCase().split(/[-_\s/:]+/).filter(Boolean);
  const share = (o) => { const a = toks(s), b = toks(o); return a.filter((t) => b.some((u) => u.startsWith(t) || t.startsWith(u))).length; };
  return opts.map((o) => [o, d(String(s), o) - 2 * share(o)]).sort((a, b) => a[1] - b[1]).filter(([o, n]) => n <= 3 || share(o) >= Math.max(1, toks(s).length - 1)).slice(0, 3).map(([o]) => o);
}

// ---------- L7: the one gate ----------
// who = { actor, cap? }. With no cap the asker's own role decides. A cap is a scoped capability the request names:
//   reaction — a `use` exercises a handler; it may change only the component the handler names, on that thing, and
//              only while the handler's author could still change it themselves (the cause chain records both);
//   handle   — a settlement of something you hold (physics.who decides who may), transform/parent of that thing only;
//   rest     — the engine's word on a launched body: transform/parent of that body, and it must equal the engine's;
//   door     — the door's own follow-up to physics (set down what lost its support, attach a rest, return a lost thing);
//   founding — the `new` act's first write to @world, by an owner named in genesis, once.
// What a lock guards (§5, mirroring v1's matrix, tools/locktest.ts): nothing may MOVE, REPLACE or REMOVE a locked thing
// or anything attached to it. Move = transform or parent (v1 place, mount, punt); replace = model (v1 spawn/light onto
// its id); remove = deleting the thing. Everything that doesn't relocate it stays open, as in v1: labels, lights,
// reactions, sockets, `use`, sitting on it, and motion (v1's matrix keeps motion open: "sit / use / motion / other comps
// all stay open while locked"; v4's motions, pendulum/spin/bob, animate a thing in place and never carry it away) and
// physics (setting it moves nothing; picking a locked thing up is refused at grab). The lab's pin also guarded motion
// and physics (research 25d H1 called motion on a pin "a pinned thing now visibly moves"); §5 chose v1's meaning.
const LOCK_GUARDED = new Set(["transform", "parent", "model"]);
// L7 rate (round-2 review R6): per actor, over a 10 s window by the door's clock. Counted in ENTRIES and in BYTES, with
// talk (say) apart from building (acts), so chat can't starve building or the other way round, and one identity can't
// make a world unhostable by bytes (one master file, nothing ever split out of it: 53 MB in one window was possible).
// An identity with no account (io.kindOf → "anon") gets less. A say's text is at most 8 KiB (the Commons' longest real
// line is 4.5 KB). Refused requests are logged (R7) inside the same byte budget.
const RATE = { n: 60, says: 20, ms: 10000, bytes: 256 * 1024, anonBytes: 32 * 1024 };
const SAY_MAX = 8192;
const bytesOf = (e) => e.bytes ?? JSON.stringify(e).length;
class Admitted { constructor(who, ops, after) { this.who = who; this.ops = ops; this.after = after; Object.freeze(this); } }
// L7 rate, per actor, over EVERYTHING the actor makes the log hold (acts and says), by the door's clock. One function:
// admit calls it for state writes, and every word that logs without a state write (say, grab's lift, throw, drop, a
// teleport) calls it before appending. The lab has no agents (`for` is unwritten until keys, L4), so "that actor's
// agents" is the actor alone here. Refusals aren't logged, so they cost the door, not the log (door practice).
function rateCheck(w, actor, kind = "act", extra = 0) {
  if (w.leaving === actor) return; // a disconnect's settlement is the door's duty, not the leaver's request: never rate-refused
  const r = rateOf(w, actor); const cap = w.kindOf?.(actor) === "anon" ? RATE.anonBytes : RATE.bytes;
  if (kind === "say" ? r.says >= RATE.says : r.acts >= RATE.n) refuse("rate", `${said(actor)} has made ${kind === "say" ? r.says : r.acts} ${kind === "say" ? "says" : "entries"} in ${RATE.ms / 1000} s`, "slow down; batch {ops} counts as one");
  if (r.bytes + extra > cap) refuse("rate", `${said(actor)} has written ${Math.round(r.bytes / 1024)} KiB in ${RATE.ms / 1000} s (at most ${cap / 1024} KiB)`, "slow down; big data goes in a blob");
}
// what this actor put in the log over the window: acts, says (counted apart), and all their bytes (incl. results)
function rateOf(w, actor) {
  const now = w.now(); let acts = 0, says = 0, bytes = 0;
  for (let i = w.entries.length - 1; i >= 0; i--) { const e = w.entries[i];
    if (isE(e) && Number.isInteger(e.ts) && now - e.ts > RATE.ms) break; // ts never decreases: everything earlier is older
    if (!isE(e) || e.actor !== actor) continue;
    if (e.kind === "act") acts++; else if (e.kind === "say") says++;
    bytes += bytesOf(e); }
  return { acts, says, bytes };
}
function admit(w, st, who, ops) {
  const { actor, cap } = who;
  if (!cap || cap.kind === "reaction" || cap.kind === "handle") rateCheck(w, actor);
  if (!ops.length) refuse("nothing", "that changes nothing", "");
  const role = roleOf(st, actor);
  const keysMade = new Set(); // keyed components this very write brings into being (their creator is the asker)
  // L6 (33 F1): a launched thing belongs to the engine until it rests. No write may touch it in flight except its rest
  // (cap rest) or the door's own follow-ups; an epoch cut (a write to @world.sim) may freeze it (P6, force).
  const sf = st.entities["@world"]?.c.sim && !(cap && ["rest", "door"].includes(cap.kind)) && !ops.some((o) => o.id === "@world" && o.comp === "sim") ? w.sim() : null;
  const inFlight = (id) => !!(sf?.launched[id] && sf.sim?.bodies[id] && !sf.sim.bodies[id].resting);
  let s = st; const norm = []; const made = new Set(); // a lock guards what happens after it, not the write that creates the thing
  ops.forEach((raw, i) => {
    const { verb, ...rest } = raw; const op = { verb, ...shapeOneOrRefuse(verb, rest, i) };
    if ("value" in op) op.value = unNegZero(op.value); // I-JSON has no -0 (an engine can make one); the same number, written as 0
    const at = `${op.id}${op.comp !== undefined ? "." + op.comp : ""}`;
    if ("value" in op) { try { checkIJSON(op.value); } catch (x) { refuse("shape", `${at}: the value isn't I-JSON (${x.code} ${x.detail})`, "finite numbers, integers within 2^53, no -0"); }
      if (jcs(op.value).length > 65536) refuse("too-big", `${at} is ${jcs(op.value).length} bytes; the door keeps values under 64 KiB`, "put big data in a blob and store its hash"); }
    const e = s.entities[op.id];
    if (verb === "create") { if (e) refuse("exists", `'${op.id}' already exists`, "choose another id, or leave id out and the door mints one");
      // §3d H7: an id is never reused, so a re-created id can't inherit references (parents, portals, old acts) or a sponsorship
      // …except the SAME thing coming back: an undo restoring what its own target deleted (who.restores, set only by
      // buildUndo's whole-thing branch). Its references are its own, so inheriting them is the point (Ctrl+Z after Delete).
      if ((w.everIds().has(op.id) && !who.restores?.has(op.id)) || made.has(op.id)) refuse("reused", `'${op.id}' existed before in this world; an id is never reused`, "choose another id, or leave id out and the door mints a fresh one"); }
    else if (!e) refuse("not-found", `no thing called '${op.id}'`, "look lists what's here", { didYouMean: guess(op.id, Object.keys(s.entities)) });
    else if (op.verb === "delete" && op.comp === undefined && op.id === "@world") refuse("world", "@world can't be deleted", "§2.3: delete or change its components instead (owners only)");
    else if (op.verb === "delete" && op.comp !== undefined && !(op.comp in e.c)) refuse("not-found", `${op.id} has no ${op.comp}`, `it has: ${Object.keys(e.c).join(", ")}`);
    else if (op.verb === "set" && !("value" in op)) refuse("shape", `set ${at} needs a value`, "");
    rights(w, st, s, who, role, op, at);
    keyRights(w, st, s, who, op, at, keysMade);
    seniority(w, st, who, op);
    // §3d H7: deleting an entity is admitted as deleting each of its components, so the creator rule applies per key
    if (op.verb === "delete" && op.comp === undefined && e) for (const c of Object.keys(e.c)) keyRights(w, st, s, who, { verb: "delete", id: op.id, comp: c }, `${op.id}.${c}`, keysMade);
    // §3d M6 (L5): a schemas:<name> value, once set, can't change (a new meaning is a new name). Setting the same value
    // again changes nothing; deleting it is changing it.
    if (op.id === "@world" && op.comp?.startsWith("schemas:") && e && op.comp in e.c && !(op.verb === "set" && jcs(op.value) === jcs(e.c[op.comp])))
      refuse("schema-fixed", `@world.${op.comp} is set; a schema never changes (L5: a name never changes meaning)`, "a new meaning is a new name");
    if (op.comp === "terrain-grid" && Object.keys(e?.c ?? {}).some((k) => k.startsWith("terrain-tile:")) && !(op.verb === "set" && jcs(op.value) === jcs(e.c["terrain-grid"])))
      refuse("grid-fixed", `${op.id}'s terrain-grid is fixed while it has tiles`, "regridding is a new ground entity (40 §6.1)");
    if (inFlight(op.id)) refuse("in-flight", `${op.id} is in flight: the engine has it until it comes to rest`, "wait (or catch it: grab {id}); L6: no write may touch a launched thing before its rest");
    if (op.id === "@world" && op.comp === "lock" && op.verb === "set") refuse("world", "@world can't be locked", "§5: lock the things in it instead");
    // locks: the thing's own lock as of this op; its ancestors' locks as of before this write (what was attached then)
    if (op.verb === "create") made.add(op.id);
    else if (!made.has(op.id) && cap?.kind !== "rest" && (op.comp === undefined || LOCK_GUARDED.has(op.comp) || op.comp.startsWith("terrain-tile:"))) { // a rest is the engine's word on a released thing: locks guard authored writes
      // §5: "a held thing keeps its logged parent, but holding suspends parent constraints until it settles" (answering
      // research 34 #11): a lock set on the table while the cup is in a hand doesn't bind the cup in the hand, so its
      // put or throw settles it. Its OWN lock still binds, and picking it up off a locked thing is refused at grab.
      const held = cap?.kind === "handle" && cap.ids.includes(op.id);
      const own = lockedC(s.entities[op.id]?.c) ? op.id : null; const anc = held ? null : ancestors(st, op.id).find((k) => lockedC(st.entities[k]?.c));
      const k = own ?? anc;
      if (k) lockCheck(w, st, who, role, k, op, at); }
    s = applyOps(s, [op]); norm.push(op);
  });
  for (const op of norm) if (op.verb === "set") valueCheck(s, op); // against the state the whole write leaves (parents may come later in a batch)
  for (const op of norm) if (op.verb === "set" && op.comp.startsWith("script:")) installCheck(w, st, s, who, op); // 41 §3.14: at install
  if (cap?.kind === "script") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some((r) => r === id || ancestors(s, id).includes(r)))
    refuse("scope", `${cap.key} may create only inside its subtree; ${id} isn't under ${cap.ids[0]}`, "give it parent {to: <an entity in the scope>} in the same batch");
  if (ownersOf(st).length && !ownersOf(s).length) refuse("last-owner", "that would leave this world with no owner", "§2.3: add the new owner's role first (set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}), then change yours");
  if (cap?.kind === "rest") restCheck(w, cap, s);
  return new Admitted(who, norm, s);
}
// A lock binds everyone, the locker and owners included (§5). `through_lock: true` on the request lets anyone who may
// remove that lock act through it, and the log records only the edit (the act carries the request as sent, flag and
// all). It covers the asker's OWN writes: a capability (a handler's author, a hand, the door's own follow-ups) never
// acts through a lock. Who may remove a lock is whoever may delete the component: builders and owners (L7 rights).
function lockCheck(w, st, who, role, k, op, at) {
  const mayUnlock = !who.cap && RANK[role] >= RANK[rankNeeded({ id: k, comp: "lock" })];
  if (THROUGH && mayUnlock) return;
  const by = lastSetterOf(w, k, "lock"); const whose = by && !by.deleted ? ` (locked by ${said(by.by)} at ${by.seq})` : "";
  const what = k === op.id ? `${op.id} is locked${whose}, so ${at} can't change` : `${op.id} is attached to ${k}, which is locked${whose}, so ${at} can't change`;
  const teach = THROUGH && who.cap ? "through_lock covers your own edits, not a handler or a held thing; unlock it first"
    : mayUnlock ? `send the same request with through_lock: true, or unlock it first: delete {id: '${k}', component: 'lock'}. A lock stops accidents; any builder may lift it, and history shows who did`
    : `a builder or owner can unlock it (delete {id: '${k}', component: 'lock'}); you are ${role}`;
  refuse("locked", what, teach, { lock: k, ...(by && !by.deleted ? { by: by.by } : {}) });
}
const unNegZero = (v) => (Object.is(v, -0) ? 0 : Array.isArray(v) ? v.map(unNegZero) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNegZero(x)])) : v);
function shapeOneOrRefuse(verb, op, i) {
  if (!["create", "set", "delete"].includes(verb)) refuse("shape", `op ${i}: '${verb}' isn't a state operation`, "create, set and delete (batches are flat)");
  if (!isEntityId(op.id)) refuse("shape", `'${op.id}' isn't an entity id`, "§2.3: a–z, 0–9 and '-', up to 64, or @world", { didYouMean: guess(String(op.id), []) });
  if ((verb === "set" || op.comp !== undefined) && !isComponent(op.comp)) refuse("shape", `'${op.comp}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/ first, @<n> version and :<key> after (ASCII only)", { didYouMean: guess(String(op.comp), Object.keys(COMPONENTS)) });
  const out = { id: op.id }; if (op.comp !== undefined) out.comp = op.comp; if (verb === "set" && "value" in op) out.value = op.value;
  return out;
}
// L7 keys rights on the component, not on the word that carried it. On @world, adding to the shared library is a
// builder's act (publish); everything else there (roles, bounds, physics, the world's name) is the owner's.
const rankNeeded = (op) => (op.id !== "@world" ? "builder" : op.comp?.startsWith("library:") ? "builder" : "owner");
function rights(w, st, s, who, role, op, at) {
  const { actor, cap } = who; const need = rankNeeded(op);
  if (!cap) { if (RANK[role] < RANK[need]) refuse("rights", `changing ${at} needs ${need}; you are ${role}`, `ask the world's owner for ${need} rights (say {text, to: <owner>}); help shows your role`); return; }
  if (cap.kind === "script") return scriptRights(st, cap, op, at, need);
  if (!cap.ids.includes(op.id) || !cap.comps.includes(op.comp)) refuse("rights", `${cap.kind === "reaction" ? `the '${cap.action}' handler` : cap.kind} may change only ${cap.comps.join("/")} of ${cap.ids.join(", ")}, not ${op.verb} ${at}`, "a capability is scoped to what it names");
  if (cap.kind === "reaction" && RANK[roleOf(st, cap.author)] < RANK[need]) refuse("rights", `'${cap.action}' was set up by ${said(cap.author)}, who can't change ${at} any more`, "ask someone with the rights to set the reactions again");
  // a hand's settlement: who may is grabbable.who (grabOf: the one reader, with the physics fallback); a punt is a kick,
  // not a hand, and keeps physics.who (research: "physics.who now means who may punt or push it")
  if (cap.kind === "handle" && cap.via === "punt") { const ph = st.entities[op.id]?.c.physics; const n = ph?.who ?? "builder";
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${op.id} isn't something you can punt`, "");
    if (RANK[role] < RANK[n]) refuse("rights", `only a ${n} may punt ${op.id}; you are ${role}`, "ask the owner to set physics.who"); }
  else if (cap.kind === "handle") { const g = grabOf(st.entities[op.id]?.c);
    if (!g) refuse("not-grabbable", `${op.id} isn't something you can carry`, "");
    if (RANK[role] < RANK[g.who]) refuse("rights", `only a ${g.who} may move ${op.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
  // founding: once, before any state, in a world whose genesis names this door's operator key (founded here)
  if (cap.kind === "founding") { const g = w.entries[0], k = w.custody()?.operator?.();
    if (!k || !g.body.owners?.some((t) => t.includes(k)) || w.entries.some((e) => isE(e) && e.kind === "state")) refuse("rights", "founding writes happen once, in a world this door founded", ""); }
}
// §5 / L7: a KEYED component (`<name>:<key>`, an instance such as library:<hash> or roles:<id>) that exists may be
// changed or deleted only by its creator (creatorOf, a view over the log: whose rights first made this life of the key)
// or by an owner. Making a new key needs only the component's ordinary rank. A capability changes it with the rights it
// carries: a handler with its author's. The door's own scoped follow-ups (rest, door, handle, founding) touch no keys
// that someone else made; founding makes roles:<founder>. A whole-entity delete is NOT gated here (see note 34).
const isKeyed = (comp) => typeof comp === "string" && comp.includes(":");
// §5 (23:40): each keyed name's schema says which kind it is. INSTANCE keys (script:, library:, roles:) carry the creator
// rule; PARTITION keys (terrain-tile:, ground-paint:) are pieces of one shared surface: ordinary rank rules only.
// A keyed name with no schema here is an instance (note 49: the spec doesn't say; this is the safe side).
export const keyKind = (comp) => COMPONENTS[comp.slice(0, comp.indexOf(":"))]?.key ?? "instance";
// H5 (security review 10-06): owners are protected from each other by SENIORITY, as Matrix room v12 protects creators.
// An owner can't change or remove the role of an owner who has been one longer (the founder, whose ownership is in
// genesis or the founding grant, is the most senior and can't be demoted by anyone). Without it, a co-owner — or anyone
// who got owner by mistake — could demote the founder and ban them, and only an operator editing the log could undo it.
const ownerSince = (w, st, x) => (roleOf(st, x, false) === "owner" ? lastSetterOf(w, "@world", `roles:${x}`)?.seq ?? -1 : Infinity);
function seniority(w, st, who, op) {
  if (op.id !== "@world" || !op.comp?.startsWith("roles:") || who.cap) return;
  const target = op.comp.slice(6);
  if (target === who.actor || roleOf(st, target, false) !== "owner") return;
  if (op.verb === "set" && op.value?.role === "owner") return;   // re-affirming an owner takes nothing from them
  if (ownerSince(w, st, target) <= ownerSince(w, st, who.actor))
    refuse("rights", `${said(target)} has been an owner here longer than you; an owner can't demote one more senior`, "ask them; an owner can only change the roles of owners made after them");
}
function keyRights(w, st, s, who, op, at, keysMade) {
  if (!isKeyed(op.comp) || op.verb === "create") return;
  if (keyKind(op.comp) === "partition") return;
  const key = `${op.id}\u0000${op.comp}`;
  const present = s.entities[op.id] && op.comp in s.entities[op.id].c;
  if (!present) { if (op.verb === "set") keysMade.add(key); return; } // a new life of the key: the asker makes it
  if (keysMade.has(key)) return; // made earlier in this same write
  const { actor, cap } = who; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : actor;
  if (RANK[roleOf(st, holder)] >= RANK.owner) return;
  const c = creatorOf(w, op.id, op.comp);
  if (c && c.rights === holder) return;
  refuse("rights", `${at} is ${c ? said(c.rights) : "nobody's on record"}'s${c ? ` (made at ${c.seq})` : ""}; only its creator or an owner may ${op.verb === "delete" ? "delete" : "change"} it`,
    op.comp.startsWith("library:") ? "publish your own version: it gets its own key" : `make your own instance (${op.comp.split(":")[0]}:<another key>), or ask ${c ? said(c.rights) : "an owner"}`);
}
// Sanity and shape of the values the door's own engine reads (what the change IS, not which word carried it).
function valueCheck(s, { id, comp, value: v }) {
  const at = `${id}.${comp}`; const obj = v && typeof v === "object" && !Array.isArray(v);
  // where a component goes (catalogue `on`): world settings on a chair, or a transform on @world, were taken and then
  // meant different things to the door and the renderer (component review T1a/T1b)
  const on = COMPONENTS[comp.split(":")[0]]?.on;
  if (on === "world" && id !== "@world") refuse("world-only", `${comp.split(":")[0]} is a world setting: it goes on @world, not on ${id}`, `set {id: '@world', component: '${comp}', value: …}`);
  if (on === "thing" && id === "@world") refuse("thing-only", `${comp} belongs to a thing; @world is the world itself`, "make a thing (create) and put it there");
  if (comp === "parent" && v?.to === "@world") refuse("thing-only", `@world isn't a thing to be inside: a thing with no parent already sits in the world`, `delete {id: '${id}', component: 'parent'}`);
  if (id === "@world" && comp.startsWith("roles:") && (!isIdentity(comp.slice(6)) || !KNOWNID(comp.slice(6))))
    refuse("shape", `roles:${comp.slice(6)} names no one: a role is given to an identity (u-…), not a typed name`, "who {name} finds a person's identity; then set roles:<identity>", { didYouMean: guess(comp.slice(6), Object.keys(s.entities["@world"]?.c ?? {}).filter((k) => k.startsWith("roles:")).map((k) => k.slice(6))) });
  if (comp === "particles" && obj) {
    if (v.texture !== undefined && !(typeof v.texture === "string" && /^eidoverse\/assets\/particle_textures\/[\w.-]+\.png$/.test(v.texture)))
      refuse("shape", `${at}.texture must be a .png in eidoverse/assets/particle_textures/`, "e.g. 'eidoverse/assets/particle_textures/flame.png'");
    if (Array.isArray(v.area) && !(v.area.length === 3 && v.area.every((n) => typeof n === "number" && n >= 0 && n <= 8)))
      refuse("bounds", `${at}.area as [x, y, z] needs three numbers, each 0–8 (m)`, "or one number for a round area");
    if (v.area !== undefined && !Array.isArray(v.area) && typeof v.area !== "number") refuse("shape", `${at}.area is a number or [x, y, z]`, ""); }
  const nums = (a, n, lim = 1e5) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Math.abs(x) <= lim);
  // H5: everyone-is-owner would let any stranger remove the real owners; the default role tops out at builder
  if (id === "@world" && comp === "default-role" && !["visitor", "builder", "none"].includes(v?.role))
    refuse("shape", `${at}.role must be visitor, builder or none (got ${JSON.stringify(v?.role)})`, "an owner is named by identity: set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}");
  if (id === "@world" && comp === "default-role" && v?.guests !== undefined && !(v.guests === "visitor" || (v.guests === "builder" && v.role === "builder")))
    refuse("shape", `${at}.guests must be visitor, or builder when role is builder (guests never get more than everyone else; got ${JSON.stringify(v.guests)} with role ${JSON.stringify(v.role)})`, "to let people without an account build here: {role: 'builder', guests: 'builder'}");
  if (id === "@world" && comp.startsWith("roles:") && !["owner", "builder", "visitor", "none"].includes(v?.role))
    refuse("shape", `${at}.role must be owner, builder, visitor or none (got ${JSON.stringify(v?.role)})`, "");
  if (comp === "transform") { if (!obj || !nums(v.pos, 3) || !nums(v.q, 4, 1.0001) || !nums(v.scale, 3, 1e3) || Object.keys(v).some((k) => !["pos", "q", "scale"].includes(k)))
    refuse("shape", `${at} must be {pos: [x,y,z], q: [x,y,z,w], scale: [x,y,z]}, finite and within bounds`, "pos within ±100 km, q a rotation, scale within ±1000"); 
    // a rotation is a unit quaternion (the renderer normalizes; the door's own maths uses q as written), and a scale of
    // 0 makes every child's transform divide by zero (review T0e)
    if (Math.hypot(...v.q) < 1e-6) refuse("shape", `${at}.q is all zeros, which isn't a rotation`, "no rotation is [0, 0, 0, 1]");
    if (v.scale.some((x) => Math.abs(x) < 1e-4)) refuse("shape", `${at}.scale has a 0 in it; a thing can't be flat to nothing`, "to hide something, delete it or give it a tiny scale like 0.01"); }
  if (comp === "bounds") { if (!obj || !nums(v.min, 3) || !nums(v.max, 3) || Object.keys(v).some((k) => !["min", "max"].includes(k)) || v.min.some((x, i) => x > v.max[i]))
    refuse("shape", `${at} must be {min: [x,y,z], max: [x,y,z]} with min ≤ max on every axis`, "e.g. {min: [-20, 0, -20], max: [20, 12, 20]}"); }
  if (comp === "parent") { if (!obj || typeof v.to !== "string") refuse("shape", `${at} must be {to: <id>}`, "");
    if (!s.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(s.entities)) });
    if (v.to === id || ancestors(s, v.to).includes(id) || ancestors(s, id).length >= 32) refuse("loop", `${id} can't be inside ${v.to}: that makes a loop`, ""); }
  if (comp === "model" && !modelOf(v)) refuse("shape", `no model called '${v}'`, "find {kind: 'model', query} lists models", { didYouMean: guess(String(v), CAT.list(String(v).split("/").pop().replace(/\.[a-z0-9]+$/i, "").slice(0, 12)).map(([k]) => k).slice(0, 200)) });
  if (comp === "pivot" && (!obj || !nums(v.pos, 3, 1e4) || Object.keys(v).some((k) => k !== "pos"))) refuse("shape", `${at} must be {pos: [x,y,z]} in its own frame (metres, before scale)`, "e.g. {pos: [0, 0.5, 0]}; delete it to turn about the origin again");
  if (comp === "lock" && v !== true) refuse("shape", `${at} is true while locked; to unlock, delete it`, `delete {id: '${id}', component: 'lock'}`);
  if (comp === "motion" && obj && "pivot" in v) refuse("derived", `${at}.pivot is derived from what it hangs from; it isn't stored`, "L2: no stored derived values; inspect shows the pivot as a view");
  if (comp === "reactions") { if (!obj) refuse("shape", `${at} must be {<action>: handler}`, "");
    const kinds = Object.keys(COMPONENTS.reactions.handlers);
    for (const [act, h] of Object.entries(v)) { if (!kinds.includes(h?.kind)) refuse("shape", `reactions.${act}: no handler kind '${h?.kind}'`, `handler kinds: ${kinds.join(", ")}`, { didYouMean: guess(String(h?.kind), kinds) });
      if (h.component !== undefined && !isComponent(h.component)) refuse("shape", `reactions.${act}.component '${h.component}' isn't a component name`, "§2.3");
      if (h.kind === "set" && !isComponent(h.component)) refuse("shape", `reactions.${act} (set) needs a component`, "e.g. {kind: 'set', component: 'door', field: 'locked', value: true}");
      for (const f of ["field", "unless"]) if (h[f] !== undefined && typeof h[f] !== "string") refuse("shape", `reactions.${act}.${f} is a field name (a string)`, "");
      if (h.kind === "script" && !(typeof h.script === "string" && isComponent(`script:${h.script}`))) refuse("shape", `reactions.${act} (script) names the script: {kind: 'script', script: '<name>'} for the script:<name> on this thing`, "e.g. {ring: {kind: 'script', script: 'bell'}}");
      handlerCheck(at, act, h); } }
  if (comp.startsWith("roles:") && (!obj || RANK[v.role] === undefined)) refuse("shape", `${at} must be {role: owner|builder|visitor|none}`, "");
  for (const [f, allowed] of Object.entries(COMPONENTS[comp]?.enums ?? {})) if (obj && v[f] !== undefined && !allowed.includes(v[f])) refuse("shape", `${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`, `schema {component: '${comp}'}`);
  schemaCheck(at, comp, v);
  if (comp === "terrain-grid") { const ok = v.spacing > 0 && Number.isInteger(v.tile) && v.tile >= 1 && v.tile <= 64 && Array.isArray(v.extent) && v.extent.length === 2 && v.extent.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)
      && Array.isArray(v.origin) && v.origin.length === 2 && v.origin.every(isNum) && (v.limits === undefined || (Number.isInteger(v.limits.raise) && Number.isInteger(v.limits.lower) && v.limits.raise >= 0 && v.limits.lower >= 0));
    if (!ok) refuse("shape", `${at} must be {spacing > 0, tile 1–64, origin [x, z], extent [nx, nz], limits? {raise, lower} (mm)}`, COMPONENTS["terrain-grid"].help); }
  if (comp.startsWith("terrain-tile:")) { const g = s.entities[id]?.c["terrain-grid"]; const ij = TR.parseKey(comp);
    if (!g) refuse("no-grid", `${id} has no terrain-grid`, "set terrain-grid on the ground first");
    if (!ij || ij[0] >= g.extent[0] || ij[1] >= g.extent[1]) refuse("shape", `${comp} isn't a tile of ${id}'s ${g.extent.join("×")} grid`, "keys are <i>-<j>, counted from the grid origin");
    if (!Array.isArray(v.mm) || v.mm.length !== g.tile ** 2 || !v.mm.every(Number.isInteger)) refuse("shape", `${at}.mm must be ${g.tile ** 2} integers (millimetres)`, "");
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity;
    if (v.mm.some((n) => n < lo || n > hi)) refuse("bounds", `${at} goes outside the grid's limits (−${g.limits.lower} … +${g.limits.raise} mm)`, "terrain-grid.limits (SL's raise/lower)"); }
}
// L7 (21:45, research 40 T10): values are checked against their schema at admit. A KNOWN name with an unknown key is
// refused with a "did you mean": Under the Eves sent terrain {amp: 0}, the engine reads `amplitude`, and the flat world
// got 3 m hills. Unknown NAMES are still kept (L5): this binds only names the catalogue defines.
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const TYPES = { number: isNum, int: Number.isInteger, string: (x) => typeof x === "string", bool: (x) => typeof x === "boolean", any: () => true,
  vec3: (x) => Array.isArray(x) && x.length === 3 && x.every(isNum),
  axis: (x) => (Array.isArray(x) && x.length === 3 && x.every(isNum)) || x === "x" || x === "y" || x === "z", // the text-tier shorthand the renderer reads (motioneval.js)
  array: Array.isArray, object: (x) => x && typeof x === "object" && !Array.isArray(x) };
// "did you mean" for a field name: a prefix either way (amp → amplitude) beats a short edit distance (amp → w)
function guessKey(k, allowed) {
  const lev = (a, b) => { const m = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) m[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) m[i][j] = Math.min(m[i-1][j] + 1, m[i][j-1] + 1, m[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)); return m[a.length][b.length]; };
  const x = k.toLowerCase();
  return allowed.map((a) => { const y = a.toLowerCase(); const pre = Math.min(x.length, y.length) >= 2 && (y.startsWith(x) || x.startsWith(y));
    return [a, pre ? Math.abs(y.length - x.length) / 100 : lev(x, y)]; })
    .filter(([a, d]) => d < 1 || d <= Math.max(1, Math.floor(Math.max(k.length, a.length) / 3))).sort((p, q) => p[1] - q[1]).slice(0, 3).map(([a]) => a);
}
function unknownKeys(at, v, allowed, what) {
  for (const k of Object.keys(v)) if (!allowed.includes(k)) { const dym = guessKey(k, allowed);
    refuse("schema", `${at}: unknown key '${k}'${dym.length ? `; did you mean '${dym[0]}'?` : ""}`, `${what} takes: ${allowed.join(", ")}`, { didYouMean: dym }); }
}
// edit distance (a near-miss of a registered component name is a typo, R8)
function lev(a, b) { const d = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let prev = d[0]; d[0] = i; for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
  return d[b.length]; }
// the registered names one letter-slip from an unregistered bare one (round-2 R8): a typo, refused at admit
const nearMiss = (name) => Object.keys(COMPONENTS).filter((k) => k !== name && Math.abs(k.length - name.length) <= 2 && lev(k, name) <= (k.length > 4 ? 2 : 1));
/** Why the catalogue would refuse this value (its shape only: no state, no rights), or null. For tools that ask
 *  whether a translated world is one the door takes as it is (sweep). */
export function schemaRefusal(comp, v) { try { schemaCheck(comp, comp, v); return null; } catch (e) { if (e instanceof Refusal) return `${e.code}: ${e.reason}`; throw e; } }
function schemaCheck(at, comp, v) {
  const name = comp.split(":")[0], def = COMPONENTS[name];
  // `param.<name>`: a number a script writes into a component for something else to read (seat poses that blend by
  // signals). Any object component may carry them at its top level; the rest of the value is checked as usual.
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith("param."))) {
    for (const k of Object.keys(v)) if (k.startsWith("param.")) {
      if (!SR.isParamKey(k)) refuse("shape", `${at}: '${k}' isn't a parameter name`, "param.<name>: a letter, then letters, digits, _ or -, up to 32 (e.g. param.lean)");
      if (!isNum(v[k])) refuse("shape", `${at}.${k} is a number (a signal), got ${JSON.stringify(v[k]).slice(0, 40)}`, "a script writes it with world.param(id, component, name, number)"); }
    v = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("param.")));
  }
  // round-2 R8: an unregistered bare name is a world's own invention (heart, inscription…) and is admitted, unless
  // it's a near-miss of a registered name: that's a typo (ligth, transform@2), and it would be a new name forever (L5)
  if (name === "placer") refuse("derived", `${at}: who made a thing is a view over the log (L2), never stored`, "inspect {id} → derived.madeBy");
  if (!def) { if (!name.includes("/")) { const near = nearMiss(name);
      if (near.length) refuse("schema", `${at}: '${name}' isn't a component; did you mean '${near[0]}'?`, `${near[0]}: ${COMPONENTS[near[0]].help ?? ""}. A component of your own needs a name that isn't one letter-slip from a registered one (or a domain prefix, e.g. 'my.place/${name}')`, { didYouMean: near }); }
    return; }
  // a keyed name written bare, or an unkeyed one written keyed (terrain:base {amp}, light:main {...}), dodged every check
  if (def.keyed !== "optional" && !!def.keyed !== comp.includes(":")) refuse("shape", def.keyed ? `${at}: ${name} is keyed (${name}:<key>)` : `${at}: ${name} isn't keyed; write '${name}', not '${comp}'`, def.help ?? "");
  if (def.type && !TYPES[def.type](v)) refuse("shape", `${at} must be a ${def.type}, got ${JSON.stringify(v).slice(0, 40)}`, def.help ?? "");
  // a socket's whole shape (shared/sockbody.js: closed keys, ranges, enums, one driver per thing), in its own words
  if (name === "sockets") { const bad = checkSockets(v, at); if (bad) refuse(bad.code, bad.reason, bad.teach || COMPONENTS.sockets.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  // what a hand may do with it (shared/grab.js: closed keys, ranges, enums, grips), in its own words
  if (name === "grabbable") { const bad = checkGrabbable(v, at); if (bad) refuse(bad.code, bad.reason, bad.teach || COMPONENTS.grabbable.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (def.map) { if (!(v && typeof v === "object" && !Array.isArray(v)) || Object.values(v).some((x) => !TYPES[def.map](x))) refuse("shape", `${at} must be {<name>: ${def.map}}`, def.help ?? ""); }
  if (!def.fields) return;
  const fields = Object.keys(def.fields);
  if (!(v && typeof v === "object" && !Array.isArray(v))) refuse("shape", `${at} must be an object {${fields.join(", ")}}`, def.help);
  unknownKeys(at, v, fields, name);
  const kind = v.kind ?? def.defaultKind; // v1 terrain never named its kind: it is noise
  if (def.byKind) { if (!def.byKind[kind]) refuse("schema", `${at}.kind must be one of ${Object.keys(def.byKind).join(" | ")}, got ${JSON.stringify(v.kind)}`, def.help, { didYouMean: guess(String(v.kind), Object.keys(def.byKind)) });
    unknownKeys(at, v, def.byKind[kind], `${name} {kind: '${kind}'}`); }
  for (const [k, t] of Object.entries(def.fields)) if (v[k] !== undefined && !TYPES[t](v[k])) refuse("shape", `${at}.${k} must be ${t}, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
  for (const [k, r] of Object.entries(def.ranges ?? {})) { const x = v[k]; if (x === undefined) continue;
    const bad = (r.min !== undefined && x < r.min) || (r.gt !== undefined && x <= r.gt) || (r.max !== undefined && x > r.max);
    if (bad) refuse("bounds", `${at}.${k} is ${x}; it must be ${[r.gt !== undefined ? `> ${r.gt}` : r.min !== undefined ? `≥ ${r.min}` : "", r.max !== undefined ? `≤ ${+r.max.toFixed(4)}` : ""].filter(Boolean).join(" and ")}`, def.help); }
  if (name === "script" && v.scope) unknownKeys(`${at}.scope`, v.scope, Object.keys(def.scopeFields), "a script's scope");
}
function handlerCheck(at, act, h) {
  const R = COMPONENTS.reactions; const allowed = [...Object.keys(R.common), ...Object.keys(R.handlers[h.kind]?.args ?? {})];
  unknownKeys(`${at}.${act}`, h, [...new Set(allowed)], `a '${h.kind}' handler`);
}
// L3: a rest must equal the engine's value. The gate asks the engine itself, not the caller.
function restCheck(w, cap, after) {
  const sf = w.sim(); const id = cap.ids[0]; const b = sf.sim?.bodies[id];
  if (!b || !b.resting || sf.launched[id]?.seq !== cap.launch) refuse("not-at-rest", `the engine doesn't have ${id} at rest from launch ${cap.launch}`, "");
  if (JSON.stringify(worldPose(after, id).pos) !== JSON.stringify(b.p)) refuse("not-the-engine's", `${id} would rest at ${JSON.stringify(worldPose(after, id).pos)}; the engine has it at ${JSON.stringify(b.p)}`, "");
}
function stateShape(plan, cause, w) {
  // §2.4: in a chained log every set carries a salt (base64url, 16 random bytes), so a purged value's commit can't be
  // brute-forced from a guess. Added here, before fits() measures the entry. The fold ignores it.
  const ops = plan.ops.map((o) => (o.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o)); const one = ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } };
  return { kind: "state", actor: plan.who.actor, cause, ...one };
}
function stateEntry(w, plan, cause) {
  if (!(plan instanceof Admitted)) throw new Error("door bug: a state write that admit() didn't produce (L7)");
  const seq = w.append(stateShape(plan, cause, w), STATE);
  (w.changedQ ??= []).push(seq); // `changed:<comp>` events, drained after the request (scripts, below)
  return seq;
}
const actEntry = (w, actor, tool, body) => ({ kind: "act", actor, verb: tool, body });
const actOf = (w, actor, tool, args, extra) => actEntry(w, actor, tool, { request: stripDry(args), ...(extra ?? {}) });

// A write: build ops against the folded state, admit them, then append the act and its one state entry.
function commit(w, actor, tool, args, build) {
  mintW = w;
  const sent = clone(args); // L4: the act is the request AS SENT (builders may annotate their own copy)
  const st = w.state();
  const ctx = { st, actor, w, notes: [], refs: new Set() };
  const ops = stampHomes(ctx, stampShapes(ctx, build(ctx)));
  const plan = admit(w, st, { actor, cap: ctx.cap, restores: ctx.restores }, ops);
  if (args.dry) return { ok: true, dry: true, would: plan.ops, notes: ctx.notes, ...warnOrNot(warnings(plan.after, [...ctx.refs])) };
  const actE = actOf(w, actor, tool, sent, ctx.actExtra);
  w.fits(actE, stateShape(plan, w.entries.length, w)); // both lines fit, or neither is written
  const act = w.append(actE);
  const seq = stateEntry(w, plan, act);
  const after = w.state();
  return { ok: true, seq, head: w.headAt(seq), act, refs: [...ctx.refs].filter((id) => after.entities[id]).map((id) => ({ id, born: after.entities[id].born })),
    after: touched(plan.ops, after), ...(ctx.undid ? { undid: ctx.undid } : {}), ...(ctx.notes.length ? { notes: ctx.notes } : {}), ...warnOrNot(warnings(after, [...ctx.refs])) };
}
// P7 + Covenant III: a thing is in the sim by its `physics` component, and its geometry enters the sim only through the
// log, as physics.shape: the DOOR's measurement of its model (model-local box [[min], [max]]), never the asker's word.
// The live server folds the sim with no catalogue of its own (live.ts: simModels {}), so a thing with no stamped shape
// is no body at all: thrown, it never flew and never rested (found 10-06: every throw on a running server did nothing).
// Stamped on every write of the asker's own (a capability's writes are scoped to what they name and are left alone):
//   - a physics value written (create or set): its shape is the door's, whatever was sent;
//   - a model changed on a thing with physics: re-measured;
//   - a modelled thing made while the world runs physics, and every standing thing when physics is turned on (or its
//     engine changed): physics {kind: 'static', shape} unless it has physics already (translate-d3 writes the same).
const r4 = (n) => Math.round(n * 1e4) / 1e4;
const shapeFor = (model) => { const m = geomOf(model); return m ? boxOfM(m).map((c) => c.map(r4)) : null; };
function stampShapes(ctx, ops) {
  if (ctx.cap || !ops.length) return ops;
  const after = scratch(ctx.st, ops); const simOn = !!after.entities["@world"]?.c.sim;
  const ids = new Set();
  for (const o of ops) if (o.verb === "set" && (o.comp === "physics" || o.comp === "model")) ids.add(o.id);
  if (simOn) for (const o of ops) if (o.verb === "create") ids.add(o.id);
  if (ops.some((o) => o.id === "@world" && o.comp === "sim" && o.verb === "set") && simOn) for (const id of Object.keys(after.entities)) ids.add(id);
  ids.delete("@world");
  const out = ops.slice(); const stamped = [];
  for (const id of ids) {
    const e = after.entities[id]; if (!e) continue;
    const ph = e.c.physics; const want = typeof e.c.model === "string" ? shapeFor(e.c.model) : null;
    let next;
    if (ph === undefined || ph === null) { if (!simOn || !want) continue; next = { kind: "static", shape: want }; }
    else if (typeof ph !== "object" || Array.isArray(ph)) continue; // valueCheck refuses it
    else { if (JSON.stringify(ph.shape ?? null) === JSON.stringify(want)) continue;
      next = { ...ph }; if (want) next.shape = want; else delete next.shape;
      if (ph.shape !== undefined && ops.some((o) => o.verb === "set" && o.comp === "physics" && o.id === id && o.value?.shape !== undefined))
        ctx.notes.push({ id, component: "physics", field: "shape", why: "stamped by the door: a shape is its measurement of the model (Covenant III), never the asker's" }); }
    const k = out.findIndex((o) => o.verb === "set" && o.comp === "physics" && o.id === id);
    if (k >= 0) out[k] = setOp(id, "physics", next); else { out.push(setOp(id, "physics", next)); stamped.push(id); }
  }
  if (stamped.length) ctx.notes.push({ component: "physics", stamped: stamped.length <= 12 ? stamped : stamped.length, why: "this world runs physics: things with a model are colliders, with the door's measured shape" });
  return out;
}
function touched(ops, st) {
  const out = {};
  for (const o of ops) { const e = st.entities[o.id]; out[o.id] ??= {};
    if (!e) { out[o.id] = null; continue; }
    if (o.verb === "create") Object.assign(out[o.id], e.c);
    else if (o.comp !== undefined) out[o.id][o.comp] = e.c[o.comp] ?? null; else out[o.id] = null; }
  return out;
}
const stripDry = ({ dry, ...rest }) => rest;
const warnOrNot = (ws) => (ws.length ? { warnings: ws } : {});

function lastTouch(w, id, comp) {
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    for (const o of opsQuiet(e)) { if (o.id !== id) continue;
      if (o.verb === "create" || o.comp === comp || (o.verb === "delete" && o.comp === undefined)) return { seq: i, actor: e.actor }; } }
  return null;
}
// who last changed each component, within a horizon of this thing's own recent entries (R 10-04: "only the most recent
// x log steps… after that a deep search"). Past the horizon it says so ({beyond}) — never "default" or "never changed".
export const TOUCH_HORIZON = 200;
function touchedOf(w, id, comps, horizon = TOUCH_HORIZON) {
  const out = {}; const want = new Set(comps); let seen = 0, oldest = null;
  for (const i of backward(w, id)) { if (!want.size || seen >= horizon) break; const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
    seen++; oldest = i;
    for (const o of opsQuiet(e)) { if (o.id !== id) continue;
      const hit = o.verb === "create" ? [...want] : want.has(o.comp) ? [o.comp] : [];
      for (const c of hit) { out[c] = { seq: i, by: e.actor, who: said(e.actor), ts: e.ts, ...(o.verb === "create" ? { created: true } : {}) }; want.delete(c); } } }
  for (const c of want) out[c] = { beyond: oldest ?? 0 };   // not found in the window: "unchanged since before #N"
  return out;
}
const opsTouching = (e, id) => opsQuiet(e).filter((o) => o.id === id);

function needThing(ctx, id) {
  const e = ctx.st.entities[id];
  if (!e) refuse("not-found", `no thing called '${id}'`, "look lists what's here", { didYouMean: guess(String(id), Object.keys(ctx.st.entities)) });
  const by = id === "@world" ? null : madeBy(ctx.w, id);
  if (by && by !== ctx.actor && !ctx.__owned?.has(id)) { (ctx.__owned ??= new Set()).add(id); ctx.notes.push({ id, madeBy: by, why: `this is ${said(by)}'s; your change is attributed to you and shows in their "changes to my things"` }); }
  return e;
}

// Resolve a component value fully (R7): defaults written out, conveniences converted, stamps applied. Shape and rights
// are admit's; this only turns what was asked into a plain value.
// @world.bounds as the readers use it: a malformed one already in a log (written before the door checked it) is
// treated as no bounds, never a crash in every create's reply (review T0d)
const boundsOf = (st) => { const B = st.entities["@world"]?.c.bounds; const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && v3(B.min) && v3(B.max) ? B : null; };
function resolve(ctx, id, comp, value, prev) {
  const def = COMPONENTS[comp];
  if (comp === "transform") {
    const v = { ...COMPONENTS.transform.defaults, ...(prev ?? {}), ...(value ?? {}) };
    if (value && "yaw" in value) { v.q = yawQ(value.yaw).map((n) => r3(n)); delete v.yaw; ctx.notes.push({ id, component: "transform", field: "yaw", sent: value.yaw, kept: v.q, why: "yaw is a convenience; the log stores q" }); }
    if (typeof v.scale === "number") v.scale = [v.scale, v.scale, v.scale];
    for (const k of ["pos", "q", "scale"]) if (!Array.isArray(v[k]) || v[k].some((n) => !Number.isFinite(n))) refuse("shape", `transform.${k} must be numbers`, "pos [x,y,z], q [x,y,z,w], scale [x,y,z] or a number");
    v.pos = v.pos.map(r3);
    // stored as a unit quaternion: a rounded yaw or a hand-typed [0,0,0,0.5] otherwise disagrees with the renderer
    // (a zero q stays as sent, for schemaCheck to refuse)
    const n = Math.hypot(...v.q); if (v.q.length === 4 && n > 1e-6 && Math.abs(n - 1) > 1e-9) v.q = v.q.map((x) => x / n);
    return v;
  }
  if (!COMPONENTS[comp] && !comp.includes(":")) ctx.notes.push({ id, component: comp, why: `'${comp}' isn't a component this world's engine knows: it is kept (and will be preserved), but nothing will draw or run it`, didYouMean: guess(comp, Object.keys(COMPONENTS)) });
  if (comp === "motion" && value && typeof value === "object") { const v = { ...(value.type === "pendulum" ? PENDULUM : {}), ...value }; delete v.pivot;
    if (v.t0 === undefined) { v.t0 = ctx.w.now(); ctx.notes.push({ id, component: "motion", field: "t0", kept: v.t0, why: "stamped by the door" }); } return v; }
  // a part's motion (motion:<part>) runs on the same clock: without a stamp every client started it from its own first
  // look and disagreed on its phase (a swing's seat, locked to that phase, pumped out of step on every screen)
  if (comp.startsWith("motion:") && value && typeof value === "object" && !Array.isArray(value) && value.t0 === undefined) {
    const v = { ...value, t0: ctx.w.now() }; ctx.notes.push({ id, component: comp, field: "t0", kept: v.t0, why: "stamped by the door" }); return v; }
  if (def?.defaults && value && typeof value === "object" && !Array.isArray(value)) {
    const filled = Object.keys(def.defaults).filter((k) => !(k in value));
    if (filled.length) ctx.notes.push({ id, component: comp, filled, why: "defaults written out so the engine can't change them later" });
    return { ...def.defaults, ...value };
  }
  return value;
}
function merge7396(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = merge7396(out[k], v); }
  return out;
}
let mintN = 0;
// a fresh id: never one this world has had (§3d H7), nor one already used in this request
let mintW = null;
function mint(st, base) { base = slug(base); let n = Object.keys(st.entities).length + (++mintN); const ever = mintW?.everIds() ?? new Set();
  while (st.entities[`${base}-${n}`] || ever.has(`${base}-${n}`)) n++; return `${base}-${n}`; }

function buildCreate(ctx, a) {
  if (a.from) return buildCreateFrom(ctx, a);
  const comps = { ...(a.components ?? {}) };
  if (a.model) comps.model = a.model;
  const id = a.id ?? mint(ctx.st, comps.model ?? "thing");
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§2.3: a–z, 0–9 and '-', up to 64; or leave id out and the door mints one");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id, or leave id out and the server mints one");
  for (const k of Object.keys(comps)) if (!isComponent(k)) refuse("shape", `'${k}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key>", { didYouMean: guess(k, Object.keys(COMPONENTS)) });
  const out = {};
  for (const [k, v] of Object.entries(comps)) out[k] = resolve(ctx, id, k, v);
  if (!out.transform) out.transform = resolve(ctx, id, "transform", {});
  ctx.refs.add(id); // who made it is the create entry's actor: a view, never a stored `placer` (L2)
  const made = createOps(id, out);
  if (!a.place) return made;
  const placed = buildPlace({ ...ctx, st: scratch(ctx.st, made) }, { ...a.place, id });
  return [...made.filter((o) => !(o.verb === "set" && (o.comp === "transform" || o.comp === "parent"))), ...placed.filter((o) => o.verb === "set")];
}

function buildSet(ctx, a) {
  const e = needThing(ctx, a.id);
  if (!isComponent(a.component)) refuse("shape", `'${a.component}' isn't a component name`, "§2.3: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key> (ASCII only)", { didYouMean: guess(String(a.component), Object.keys(COMPONENTS)) });
  const lt = lastTouch(ctx.w, a.id, a.component); const base = a.base === undefined ? undefined : versionSeq(ctx.w, a.base, "base");
  if (base !== undefined && lt && lt.seq > base) refuse("stale", `${a.id}.${a.component} changed since version ${base}: ${said(lt.actor)} set it at ${lt.seq}`, a.merge ? `inspect {id: '${a.id}'} for the current value and its new version, then re-send with that base` : `inspect {id: '${a.id}'} for the current value and version, then decide; or merge: true to change only your fields`, { current: e.c[a.component] ?? null, version: lt.seq, by: lt.actor });
  if (a.base === undefined && !a.merge && lt && lt.actor !== ctx.actor && a.component in e.c) ctx.notes.push({ id: a.id, component: a.component, overwrote: { by: lt.actor, seq: lt.seq }, why: "you replaced someone else's value without a base version; send base (from inspect) to be refused instead if it changed" });
  let v = a.merge ? merge7396(e.c[a.component], a.value) : a.value;
  if (a.component === "parent") {
    if (v?.to && !ctx.st.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(ctx.st.entities)) });
    if (v?.to && (v.to === a.id || ancestors(ctx.st, v.to).includes(a.id))) refuse("loop", `${a.id} can't be inside ${v.to}: that makes a loop`, "");
    const wt = worldT(ctx.st, a.id);
    const t = v?.to ? localFrom(ctx.st, v.to, wt) : wt;
    ctx.notes.push({ id: a.id, component: "transform", why: "re-expressed in its new parent's frame so it stays where it is (stamped)" });
    ctx.refs.add(a.id);
    return [setOp(a.id, "parent", resolve(ctx, a.id, "parent", v)), setOp(a.id, "transform", t)];
  }
  if (a.id === "@world" && a.component === "sim") return buildEpoch(ctx, v, a);
  v = resolve(ctx, a.id, a.component, v);
  ctx.refs.add(a.id);
  return [setOp(a.id, a.component, v)];
}

function buildDelete(ctx, a) {
  const e = needThing(ctx, a.id);
  if (a.id === "@world" && a.component === "sim") return buildEpoch(ctx, null, a);
  if (a.component !== undefined) {
    if (a.component === "parent" && e.c.parent) {
      const wt = worldT(ctx.st, a.id); ctx.refs.add(a.id);
      return [delOp(a.id, "parent"), setOp(a.id, "transform", { ...wt, pos: wt.pos.map(r3) })];
    }
    if (!(a.component in e.c)) refuse("not-found", `${a.id} has no ${a.component}`, `it has: ${Object.keys(e.c).join(", ")}`);
    ctx.refs.add(a.id);
    return [delOp(a.id, a.component)];
  }
  const kids = descendants(ctx.st, a.id);
  if (kids.length) ctx.notes.push({ id: a.id, why: `its ${kids.length} children went with it: ${kids.join(", ")}` });
  const gone = new Set([a.id, ...kids]); const ops = [...kids.reverse(), a.id].map((id) => delOp(id));
  const after = scratch(ctx.st, ops); const setDown = [];
  for (const id of Object.keys(after.entities)) { const b = aabb(after, id); if (!b || after.entities[id].c.parent) continue;
    const before = supportBelow(ctx.st, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    if (!gone.has(before.id)) continue;
    const now = supportBelow(after, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    const t = worldT(after, id); ops.push(setOp(id, "transform", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] })); setDown.push({ id, onto: now.id }); ctx.refs.add(id); }
  if (setDown.length) ctx.notes.push({ setDown, why: "they were resting on what you deleted, so they were set down on what's below" });
  return ops;
}

// turn {id, axis, deg, space?, about?}: the gizmo's rotate, for agents (agent lab, Juniper #3: no tool could say "about
// its own long axis"). space: 'object' (its own axes, the default) | 'parent' | 'world'. about: 'pivot' (default when it
// has one: the pivot stays put and the thing swings round it, research 52) | 'origin'. The log gets a plain transform.
function buildTurn(ctx, a) {
  const e = needThing(ctx, a.id); const st = ctx.st;
  const AX = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const ax0 = typeof a.axis === "string" ? AX[a.axis] : Array.isArray(a.axis) && a.axis.length === 3 && a.axis.every((v) => typeof v === "number" && Number.isFinite(v)) ? a.axis : null;
  const len = ax0 ? Math.hypot(...ax0) : 0;
  if (!ax0 || len < 1e-9) refuse("shape", `axis is 'x', 'y', 'z' or [x, y, z] (not zero)`, "e.g. turn {id, axis: 'x', deg: 30}");
  if (typeof a.deg !== "number" || !Number.isFinite(a.deg)) refuse("shape", "deg is a number of degrees", "e.g. deg: 90 (positive = counter-clockwise looking down the axis)");
  const space = a.space ?? "object";
  if (!["object", "parent", "world"].includes(space)) refuse("shape", `space is 'object', 'parent' or 'world'`, "object = its own axes (the default), parent = its parent's (the world's for a root), world = the world's");
  const t = { ...COMPONENTS.transform.defaults, ...(e.c.transform ?? {}) };
  let ax = ax0.map((v) => v / len);
  if (space === "world" && e.c.parent?.to && st.entities[e.c.parent.to]) ax = qrot(qinv(worldT(st, e.c.parent.to).q), ax);   // into the parent's frame
  const h = (a.deg * Math.PI / 180) / 2; const R = [ax[0] * Math.sin(h), ax[1] * Math.sin(h), ax[2] * Math.sin(h), Math.cos(h)];
  const q2 = space === "object" ? qmul(t.q, R) : qmul(R, t.q);
  const piv = Array.isArray(e.c.pivot?.pos) ? e.c.pivot.pos : null;
  const about = a.about ?? (piv ? "pivot" : "origin");
  if (!["pivot", "origin"].includes(about)) refuse("shape", "about is 'pivot' or 'origin'", "");
  if (about === "pivot" && !piv) refuse("shape", `${a.id} has no pivot`, `add one first: set {id: '${a.id}', component: 'pivot', value: {pos: [x, y, z]}}`);
  let pos = t.pos;
  if (about === "pivot") { const sp = piv.map((v, i) => v * t.scale[i]); const P = qrot(t.q, sp).map((v, i) => v + t.pos[i]); const off = qrot(q2, sp); pos = P.map((v, i) => v - off[i]); }
  ctx.refs.add(a.id);
  return [setOp(a.id, "transform", { pos: pos.map((v) => Math.round(v * 1e4) / 1e4), q: q2.map((v) => Math.round(v * 1e9) / 1e9), scale: t.scale })];
}

// Relational placement (A1): the door solves; the log gets a plain transform.
function buildPlace(ctx, a) {
  const e = needThing(ctx, a.id);
  const m = geomOf(e.c.model); if (!m) refuse("shape", modelOf(e.c.model) ? `${a.id}'s model hasn't been measured here, so it has no size to place` : `${a.id} has no model, so it has no size to place`, "set its transform directly");
  const st = ctx.st, cur = worldT(st, a.id), scale = cur.scale;
  const fam = new Set([a.id, ...descendants(st, a.id)]);
  let yaw = a.yaw ?? qYaw(cur.q);
  // lying: rest on the largest face. The door owns the tilt and where the origin ends up (W6).
  let tilt = [0, 0, 0, 1];
  if (a.lying) { const d = m.size.map((v, i) => v * scale[i]); const k = d.indexOf(Math.min(...d)); const r = Math.SQRT1_2;
    tilt = k === 2 ? [r, 0, 0, r] : k === 0 ? [0, 0, r, r] : tilt; }
  const [mlo, mhi] = boxOfM(m); const lc = []; for (const x of [mlo[0], mhi[0]]) for (const y of [mlo[1], mhi[1]]) for (const z of [mlo[2], mhi[2]]) lc.push(qrot(tilt, [x * scale[0], y * scale[1], z * scale[2]]));
  const lo = [0, 1, 2].map((i) => Math.min(...lc.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...lc.map((c) => c[i])));
  const S = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], C = [(hi[0] + lo[0]) / 2, 0, (hi[2] + lo[2]) / 2];
  const half = (y) => { const c = Math.abs(Math.cos(y)), s = Math.abs(Math.sin(y)); const hx = S[0] / 2, hz = S[2] / 2; return [c * hx + s * hz, s * hx + c * hz]; };
  const free = (x, y, z, yw, ignore) => { const [hx, hz] = half(yw); const box = { min: [x - hx, y, z - hz], max: [x + hx, y + S[1], z + hz] };
    for (const id of Object.keys(st.entities)) { if (fam.has(id) || ignore.has(id)) continue; if (hits(box, st, id, 0.01)) return id; } return null; };
  const relaxed = []; let pos, support;
  // a TARGET is aimed at by its bounds centre, never its origin: a library model's origin is wherever its author left it
  // (agent lab, 10-04: "near the desk, facing it" aimed at an origin 2.46 m off the desk and faced air; a swing hung from
  // a frame's corner). An unmeasured thing falls back to its origin.
  const centreOf = (id) => { const b = aabb(st, id); if (b) return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]; return worldT(st, id)?.pos; };
  const faceYaw = (p) => { if (!a.facing) return yaw; const tgt = Array.isArray(a.facing) ? [a.facing[0], 0, a.facing[1]] : centreOf(a.facing);
    if (!tgt) refuse("not-found", `can't face '${a.facing}': facing takes a thing's id or an [x, z] point, not a direction word`, "e.g. facing: 'door-1', or facing: [0, -5] to face north-ish (−z)", { didYouMean: guess(String(a.facing), Object.keys(st.entities)) }); const d = [tgt[0] - p[0], tgt[2] - p[2]]; return Math.atan2(d[0], d[1]) + (a.away ? Math.PI : 0); };
  if (a.on) {
    const surfs = surfacesOf(st, a.on); if (!st.entities[a.on]) refuse("not-found", `no '${a.on}'`, "", { didYouMean: guess(a.on, Object.keys(st.entities)) });
    if (!surfs.length) refuse("no-surface", `${a.on} has no surface to put things on`, `measure {id: '${a.on}'} shows its surfaces`);
    const s = surfs[a.level ?? surfs.length - 1] ?? refuse("no-surface", `${a.on} has levels 0–${surfs.length - 1}`, "");
    const want = a.offset ? [(s.min[0] + s.max[0]) / 2 + a.offset[0], (s.min[1] + s.max[1]) / 2 + a.offset[1]] : [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2];
    let best = null, lastBlock = null;
    for (let pass = 0; pass < 2; pass++) {
      const [hx, hz] = half(yaw);
      for (let x = s.min[0] + hx; x <= s.max[0] - hx + 1e-9; x += 0.025) for (let z = s.min[1] + hz; z <= s.max[1] - hz + 1e-9; z += 0.025) {
        const d = Math.hypot(x - want[0], z - want[1]); if (best && d >= best.d) continue;
        const bl = free(x, s.y, z, yaw, new Set()); if (!bl) best = { x, z, d }; else lastBlock = bl;
      }
      if (!best) break; if (a.facing && pass === 0) { yaw = faceYaw([best.x, 0, best.z]); best = null; } else break;
    }
    if (!best) { const [hx, hz] = half(yaw); refuse("no-room", `${a.id} (${r3(2 * hx)}×${r3(2 * hz)} m) doesn't fit free on ${a.on}'s level ${s.level} (${r3(s.max[0] - s.min[0])}×${r3(s.max[1] - s.min[1])} m)${lastBlock ? `; ${lastBlock} is in the way` : ""}`, "try another level, a smaller thing, or move what's there"); }
    if (best.d > 0.01) relaxed.push(`moved ${r3(best.d)} m from where you asked to stay clear and fully supported`);
    pos = [best.x, s.y, best.z]; support = a.on; if (a.attach === undefined) a.attach = true; // things rest on what supports them
  } else if (a.hang) {
    const ft = worldT(st, a.hang), fb = aabb(st, a.hang); if (!fb) refuse("not-found", `no solid '${a.hang}'`, "", { didYouMean: guess(a.hang, Object.keys(st.entities)) });
    yaw = qYaw(ft.q); const right = qrot(ft.q, [1, 0, 0]); const along = a.along ?? 0; const h = a.height ?? 0.5;
    if (h + m.size[1] * scale[1] > fb.max[1]) refuse("no-room", `${a.id} can't hang ${h} m up from ${a.hang}: its top is at ${r3(fb.max[1])} m`, "use a lower height");
    const fc = centreOf(a.hang); pos = [fc[0] + right[0] * along, h, fc[2] + right[2] * along]; support = a.hang; a.attach = true;
    { const [hx, hz] = half(yaw); const box = { min: [pos[0] - hx, h, pos[2] - hz], max: [pos[0] + hx, h + S[1], pos[2] + hz] };
      if (hits(box, st, a.hang, 0.01)) refuse("inside", `hanging there would put ${a.id} inside ${a.hang}'s solid parts`, `${a.hang} isn't something to hang from at that spot; hang from a frame or beam (find {query: 'frame'}), or use along to move clear`); }
  } else if (a.beside) {
    const nb = aabb(st, a.beside); const nt = worldT(st, a.beside); if (!nb) refuse("not-found", `no solid '${a.beside}'`, "", { didYouMean: guess(a.beside, Object.keys(st.entities)) });
    yaw = qYaw(nt.q); const right = qrot(nt.q, [1, 0, 0]), fwd = qrot(nt.q, [0, 0, 1]); const dir = a.side === "left" ? -1 : 1;
    const nm = geomOf(st.entities[a.beside].c.model);
    const nh = nm.size[0] * nt.scale[0] / 2, mh = m.size[0] * scale[0] / 2, gap = a.gap ?? 0.005;
    const flush = ((m.size[2] * scale[2]) - (nm.size[2] * nt.scale[2])) / 2; // backs line up, as furniture does against a wall
    let k = nh + mh + gap, p, blocker = null;
    const ncx = (nb.min[0] + nb.max[0]) / 2, ncz = (nb.min[2] + nb.max[2]) / 2;
    for (let tries = 0; tries < 40; tries++, k += 0.02) { p = [ncx + right[0] * k * dir + fwd[0] * flush, nt.pos[1], ncz + right[2] * k * dir + fwd[2] * flush];
      blocker = free(p[0], p[1], p[2], yaw, new Set()); if (!blocker) break; p = null; }
    if (!p) refuse("no-room", `${a.id} won't fit ${a.side ?? "right"} of ${a.beside}: it would overlap ${blocker}`, "try the other side, or move " + blocker);
    if (k > nh + mh + gap + 1e-6) relaxed.push(`shifted ${r3(k - nh - mh - gap)} m further to clear something`);
    pos = p; support = supportBelow(st, p[0], p[2], p[1] + 0.01, fam).id; if (a.attach === undefined) a.attach = true;
    const sb = supportBelow(st, p[0], p[2], p[1] + 0.01, fam); if (Math.abs(sb.y - p[1]) > 0.02) refuse("unsupported", `there's nothing to stand on ${a.side ?? "right"} of ${a.beside}`, "try the other side, or 'on' with an offset");
  } else if (a.against) {
    const b = aabb(st, a.against); if (!b) refuse("not-found", `no solid '${a.against}'`, "look lists what's here", { didYouMean: guess(a.against, Object.keys(st.entities)) });
    const thinX = b.max[0] - b.min[0] < b.max[2] - b.min[2];
    const c = [(b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2];
    const side = a.side ?? (thinX ? Math.sign(cur.pos[0] - c[0]) || 1 : Math.sign(cur.pos[2] - c[1]) || 1);
    yaw = thinX ? (side > 0 ? Math.PI / 2 : -Math.PI / 2) : (side > 0 ? 0 : Math.PI);
    const [hx, hz] = half(yaw); const gap = a.gap ?? 0.01; const along = a.along ?? 0;
    pos = thinX ? [side > 0 ? b.max[0] + hx + gap : b.min[0] - hx - gap, 0, c[1] + along] : [c[0] + along, 0, side > 0 ? b.max[2] + hz + gap : b.min[2] - hz - gap];
    if (a.height !== undefined) { // wall-mounted: at that height, riding the wall
      if (a.height + m.size[1] * scale[1] > b.max[1]) refuse("no-room", `${a.id} at ${a.height} m would stick out above ${a.against} (top ${r3(b.max[1])} m)`, "use a lower height");
      pos[1] = a.height; support = a.against; if (a.attach === undefined) a.attach = true; a.__mounted = true; }
    if (a.facing) relaxed.push("'facing' ignored: against a wall, a thing faces away from it");
  } else if (a.near) {
    const t = worldT(st, a.near); const b = aabb(st, a.near); if (!t) refuse("not-found", `no '${a.near}'`, "");
    const gap = a.gap ?? 0.3; let ok = null;
    for (let i = 0; i < 16 && !ok; i++) { const ang = (a.side ?? 0) + i * Math.PI / 8 * (i % 2 ? 1 : -1) * Math.ceil(i / 2) / Math.max(1, i);
      const R = (b ? Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]) / 2 : 0) + Math.max(...half(yaw)) + gap;
      const tc = b ? [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2] : t.pos;
      const p = [tc[0] + Math.sin(ang) * R, 0, tc[2] + Math.cos(ang) * R]; const yw = a.facing ? faceYaw(p) : yaw;
      const level = (b ? b.min[1] : t.pos[1]) + 0.02; // "near X" = on the same support as X, never on top of other furniture
      if (!free(p[0], supportBelow(st, p[0], p[2], level, fam).y, p[2], yw, new Set())) { ok = p; yaw = yw; } }
    if (!ok) refuse("no-room", `no free spot within ${gap} m of ${a.near}`, "try a larger gap");
    pos = ok; a.__level = (b ? b.min[1] : t.pos[1]) + 0.02;
  } else if (a.at) {
    pos = [a.at[0], 0, a.at[1]];
  } else refuse("shape", "place needs one of: on, against, near, at", "e.g. place {id, on: 'table-1'} or {id, near: 'bed-2', facing: 'door-1'}");
  if (!a.on && !a.beside && !a.hang && !a.__mounted) { if (a.facing && !a.against) yaw = faceYaw(pos); const sup = supportBelow(st, pos[0], pos[2], a.__level ?? a.at?.[2] ?? 10, fam); pos[1] = sup.y; support = sup.id;
    const hit = free(pos[0], pos[1], pos[2], yaw, new Set()); if (hit) relaxed.push(`overlaps ${hit}: nothing nearer was free`); }
  const off = qrot(yawQ(yaw), C); const restsAt = pos[1];
  const wt = { pos: [pos[0] - off[0], pos[1] - lo[1], pos[2] - off[2]].map(r3), q: qmul(yawQ(yaw), tilt).map(r3), scale };
  const ops = [];
  if (a.attach && support !== "ground") {
    ops.push(setOp(a.id, "parent", { to: support, order: "a0" }));
    const s2 = scratch(st, [setOp(a.id, "parent", { to: support })]);
    ops.push(setOp(a.id, "transform", localFrom(s2, support, wt)));
  } else {
    if (e.c.parent) ops.push(delOp(a.id, "parent"));
    ops.push(setOp(a.id, "transform", wt));
  }
  // a hung thing swings from where its ropes would tie: the UNDERSIDE of the member right above it (agent lab round 2,
  // Rowan: the swing's pivot was the frame's top), stored as its pivot component, which the door's pivot, inspect, the
  // renderer and the agent's look all read (research 52). A pivot someone already set is left alone.
  if (a.hang && !e.c.pivot) {
    const tie = obbs(st, a.hang).map((o) => { const ext = [0, 1, 2].map((i) => o.ax.reduce((acc, axv, j) => acc + Math.abs(axv[i]) * o.h[j], 0)); return { min: o.c.map((v, i) => v - ext[i]), max: o.c.map((v, i) => v + ext[i]) }; })
      .filter((b) => pos[0] >= b.min[0] - 1e-6 && pos[0] <= b.max[0] + 1e-6 && pos[2] >= b.min[2] - 1e-6 && pos[2] <= b.max[2] + 1e-6 && b.min[1] >= pos[1] + S[1] - 1e-6)
      .reduce((best, b) => (best === null || b.min[1] < best ? b.min[1] : best), null);
    if (tie !== null) {
      const d = qrot(qinv(wt.q), [pos[0] - wt.pos[0], tie - wt.pos[1], pos[2] - wt.pos[2]]);
      ops.push(setOp(a.id, "pivot", { pos: d.map((v, i) => r3(v / (scale[i] || 1))) }));
      ctx.notes.push({ id: a.id, hinge: { y: r3(tie), why: `it swings from the underside of ${a.hang} right above it (its pivot)` } });
    }
  }
  ctx.notes.push({ id: a.id, placed: { pos: wt.pos, restsAt: r3(restsAt), ...(a.lying ? { lying: true } : {}), yawDeg: r3(yaw * 180 / Math.PI), on: support, ridesWith: a.attach && support !== "ground" ? support : null }, ...(relaxed.length ? { relaxed } : {}) });
  ctx.refs.add(a.id);
  return ops;
}

// Physical checks on every write (A2).
function warnings(st, ids) {
  const out = []; const all = Object.keys(st.entities);
  const B = boundsOf(st);
  for (const id of ids) {
    const b = aabb(st, id); if (!b) continue;
    const fam = new Set([id, ...descendants(st, id)]); // a parent is NOT exempt: a bell inside its lamp pole is still inside it
    const mine = obbs(st, id);
    for (const o of all) { if (fam.has(o)) continue;
      const pair = mine.flatMap((a) => obbs(st, o).map((sb) => satDepth(a, sb)).filter((p) => p > 0.02));
      if (pair.length && !out.some((x) => x.kind === "overlap" && x.id === o && x.with === id)) out.push({ id, kind: "overlap", with: o, by: r3(Math.max(...pair)) }); }
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const sup = supportBelow(st, cx, cz, b.min[1], new Set([id, ...descendants(st, id)]));
    const hungFrom = ancestors(st, id).find((p) => { const pb = aabb(st, p); return pb && pb.max[1] > b.max[1]; });
    if (!hungFrom && sup.y - b.min[1] > 0.005 && sup.y - b.min[1] < 0.3) out.push({ id, kind: "sunk", depth: r3(sup.y - b.min[1]), into: sup.id });
    const mounted = ancestors(st, id).some((p) => { const pb = aabb(st, p); return pb && pb.min[1] <= b.min[1] && pb.max[1] >= b.max[1]; });
    const under = supportUnder(st, b, new Set([id, ...descendants(st, id)]));
    if (b.min[1] - under.y > 0.03 && !hungFrom && !mounted) out.push({ id, kind: "floating", gap: r3(b.min[1] - under.y), above: under.id });
    if (B && (b.min[0] < B.min[0] || b.max[0] > B.max[0] || b.min[2] < B.min[2] || b.max[2] > B.max[2])) out.push({ id, kind: "out-of-bounds", bounds: B });
  }
  return out;
}

// ---------- use (interaction) ----------
// A pendulum's pivot is a view: derived from what it hangs from, every time it's read (L2: never stored).
function pivotOf(st, id) {
  const pv = st.entities[id]?.c.pivot?.pos; if (Array.isArray(pv) && pv.length === 3) return pv.slice();   // the stored hinge (research 52)
  const t = worldT(st, id); const p = st.entities[id]?.c.parent?.to; const pb = p && aabb(st, p);
  return pb && pb.max[1] > t.pos[1] ? [0, r3((pb.max[1] - t.pos[1]) / t.scale[1]), 0] : null;
}
// L7: a `use` exercises a capability the handler holds. It is scoped to the component the handler names, and good
// only while the handler's author (whoever last set `reactions`) could still make that change themselves.
function reactionCap(ctx, id, comp, action) {
  const lt = lastTouch(ctx.w, id, "reactions"); if (!lt) refuse("no-handler", `nobody set up '${action}' on ${id}`, "");
  ctx.actExtra = { capability: { reaction: action, author: lt.actor, grantedAt: lt.seq } };
  ctx.cap = { kind: "reaction", ids: [id], comps: [comp], author: lt.actor, action };
}
function buildUse(ctx, a) {
  const e = ctx.st.entities[a.id]; if (!e) refuse("not-found", `no '${a.id}'`, "", { didYouMean: guess(a.id, Object.keys(ctx.st.entities)) });
  const offers = actionsOf(ctx.st, a.id);
  const action = a.action ?? offers[0];
  if (!offers.includes(action)) refuse("no-action", `${a.id} doesn't '${action}'`, `it offers: ${offers.join(", ") || "nothing"}`, { didYouMean: guess(action, offers) });
  const socks = bodySockets(ctx.st, a.id).filter((x) => x.body.action === action);
  if (socks.length && !e.c.reactions?.[action]) {
    const may = (x) => !x.body.who || RANK[roleOf(ctx.st, ctx.actor)] >= RANK[x.body.who];
    const slot = a.args?.slot;
    if (slot != null) { const named = socks.find((x) => x.slot === slot);
      if (!named) refuse("no-action", `${a.id} has no '${action}' socket called '${slot}'`, `its ${action} sockets: ${socks.map((x) => x.slot).join(", ")}`, { didYouMean: guess(String(slot), socks.map((x) => x.slot)) });
      if (!may(named)) refuse("rights", `only a ${named.body.who} may ${action} ${a.id} (${slot})`, "ask someone who can"); }
    const ok = socks.filter(may);
    if (!ok.length) refuse("rights", `only a ${socks[0].body.who} may ${action} ${a.id}`, "ask someone who can");
    const pick = slot != null ? ok.find((x) => x.slot === slot) : ok[0];
    // attaching is presence (your frames say where you're attached; nothing is recorded), so the door only answers: where,
    // and what the body does there (the socket's body block read with its defaults: shared/sockbody.js bodyOf)
    const { clip, ...body } = pick.body;
    return { presence: true, attach: { to: a.id, slot: pick.slot, ...body }, note: `you ${action} on ${a.id} (${pick.slot}): presence — your frames carry it; nothing recorded${body.leaveBy === "script" ? " (this seat lets you go only when a script does)" : ""}` };
  }
  const h = e.c.reactions?.[action];
  if (h?.who && RANK[roleOf(ctx.st, ctx.actor)] < RANK[h.who]) refuse("rights", `only a ${h.who} may ${action} ${a.id}`, "ask someone who can");
  if (h?.kind === "script") return { script: h.script, action }; // TOOLS.use logs the visitor's act, then activates it
  if (h?.kind === "impulse") {
    if (e.c.motion && e.c.motion.type !== "pendulum") refuse("no-body", `${a.id} moves by '${e.c.motion.type}', which a push doesn't change`, "an impulse swings a pendulum (motion {type: 'pendulum'})");
    const mo = { ...(e.c.motion?.type === "pendulum" ? e.c.motion : PENDULUM) }; delete mo.pivot;
    if (!pivotOf(ctx.st, a.id)) refuse("no-pivot", `${a.id} swings but hangs from nothing above it`, `hang it first: place {id: '${a.id}', hang: <frame>}`);
    const raw = a.args?.impulse ?? qrot(worldT(ctx.st, a.id).q, [0, 0, h.strength ?? 0.5]);
    const fwd = qrot(worldT(ctx.st, a.id).q, [0, 0, 1]); const along = raw[0] * fwd[0] + raw[1] * fwd[1] + raw[2] * fwd[2];
    const mag = Math.hypot(...raw);
    if (mag > 0 && Math.abs(along) < 0.3 * mag) refuse("sideways", `${a.id} swings front-to-back; that push is mostly sideways`, `push along its front ${JSON.stringify(fwd.map(r3))} (or the opposite)`);
    // v1's pendulumImpulse (server/reactions.ts on main): read angle and velocity AT the push instant, add the push,
    // re-express as (amp, phase, t0). No snap at the push; with the motion builds, against it damps. The client's
    // pendulumTheta (client/lib/motioneval.js) evaluates the result: keep the two in sync (review 10-06 #5).
    const now = ctx.w.now(), w0 = (2 * Math.PI) / (mo.period ?? 3.5), damp = mo.damp ?? 0;
    const t = mo.t0 != null ? Math.max(0, (now - mo.t0) / 1000) : 0;
    const a0 = (mo.amp ?? 0) * Math.exp(-damp * t), ph = w0 * t + (mo.phase ?? 0);
    // Δω = Δv / L: the push's speed at the thing's centre over its distance from the hinge (world metres)
    const pv = pivotOf(ctx.st, a.id), sc = worldT(ctx.st, a.id).scale;
    const L = Math.max(0.2, Math.hypot(pv[0] * sc[0], pv[1] * sc[1], pv[2] * sc[2]));
    const dw = a.args?.impulse == null && typeof h.angular === "number" ? h.angular : along / L;
    const th = a0 * Math.cos(ph), vel = -a0 * w0 * Math.sin(ph) + dw;
    const amp = Math.min(mo.maxAmp ?? 0.9, Math.hypot(th, vel / w0)), phase = Math.atan2(-(vel / w0), th);
    reactionCap(ctx, a.id, "motion", action);
    ctx.refs.add(a.id); return [setOp(a.id, "motion", { ...mo, amp: r3(amp), phase: r3(phase), t0: now })];
  }
  // §5: a thing's gameplay state lives inside its own component (a door is `door: {open, locked}`), never as a top-level
  // name beside the edit `lock`. A handler names its component and, for an object component, the field it changes.
  if (h?.kind === "set") { const comp = h.component; reactionCap(ctx, a.id, comp, action); ctx.refs.add(a.id);
    return [setOp(a.id, comp, h.field === undefined ? h.value : { ...objOf(e.c[comp]), [h.field]: h.value })]; }
  if (h?.kind === "toggle") {
    const { comp, field } = toggleOf(h); ctx.refs.add(a.id);
    if (barredBy(e, h)) refuse("barred", `${a.id} is ${h.unless}`, h.teach ?? `someone allowed to may 'use' it with another action first`);
    reactionCap(ctx, a.id, comp, action);
    return [setOp(a.id, comp, field === undefined ? !e.c[comp] : { ...objOf(e.c[comp]), [field]: !objOf(e.c[comp])[field] })];
  }
  refuse("no-handler", `${a.id} declares '${action}' but its handler kind isn't one this engine runs`, `handler kinds: ${Object.keys(COMPONENTS.reactions.handlers).join(", ")} (schema {component: 'reactions'})`);
}
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && v !== PURGED ? v : {});
// toggle's defaults: the door's own `open` (component `door`, field `open`); a named component with no field toggles
// the whole value (a plain boolean component). `unless` names a field of the same component that, when true, bars it.
const toggleOf = (h) => { const comp = h.component ?? "door"; return { comp, field: h.field ?? (h.component === undefined ? "open" : undefined) }; };
const barredBy = (e, h) => !!h?.unless && objOf(e.c[toggleOf(h).comp])[h.unless] === true;
// the sockets a person can attach to: the thing's own, else its model's
const bodySockets = (st, id) => { const e = st.entities[id]; const S = e?.c.sockets ?? modelOf(e?.c.model)?.sockets ?? {};
  return Object.entries(S).map(([slot, s]) => ({ slot, body: bodyOf(s) })).filter((x) => x.body); };
function actionsOf(st, id) {
  const e = st.entities[id];
  return [...new Set([...Object.keys(e?.c.reactions ?? {}), ...bodySockets(st, id).map((x) => x.body.action)])];
}
function offersFor(st, id, actor) {
  const e = st.entities[id]; const can = [], notForYou = [];
  for (const act of actionsOf(st, id)) { const h = e.c.reactions?.[act];
    if (h?.who && RANK[roleOf(st, actor)] < RANK[h.who]) notForYou.push({ action: act, why: `needs ${h.who}` });
    else if (h?.kind === "toggle" && barredBy(e, h)) notForYou.push({ action: act, why: `it is ${h.unless}` });
    else can.push(act); }
  return { canDo: can, ...(notForYou.length ? { notForYou } : {}) };
}

// ---------- behaviours (L4, L7 as revised; research 41; the lab's slice, code/v4-lab/door.js @ 2300bae, on a real sandbox) ----------
// A script is a keyed component `script:<name>` naming a source blob ({lang: "js", api, text}, by its sha256 name) and a
// declared SCOPE. Its sponsor is whose rights admitted the LATEST write to that key in its current life (§5 "Two views"):
// a view, never a stored field. Every activation is a fresh admission with capability {kind: "script"}: the sponsor's
// rights NOW, narrowed to the scope. The visitor who triggers it adds nothing. An activation that changes something is
// ONE act (actor bhv:<id>, verb script, naming script, src, sponsor, sponsorAt, on, trigger, event, head, seed, depth,
// reads) plus ONE all-or-nothing batch caused by it, plus its says. Replay never runs code: the fold reads the batch.
// Stated rule (§3d): no-op writes in a script batch are dropped (SR.elide, shared with the auditor). Door practice: timers
// sleep in an empty world unless `always`; a per-script rate, a per-sponsor fair share of a per-world hourly budget, a
// cascade depth, and a pause after repeated failures.
const SCRIPTS = { install: "builder", max: 12, budget: 600, rate: 6, depth: 8, fails: 5, run: true, cpu: SR.LIMITS.cpu, runs: SR.LIMITS.runs };
const scriptsCfg = (st) => { const c = st.entities["@world"]?.c.scripts; return { ...SCRIPTS, ...(c && typeof c === "object" && !Array.isArray(c) && c !== PURGED ? c : {}) }; };
const BODY_EFFECTS = ["shove", "pose"];
const SCRIPT_EVENTS = ["use", "say", "enter", "leave", "grab", "release"];
const scopeIds = (st, id, ids) => (ids === "self" ? [id] : ids === "subtree" ? [id, ...descendants(st, id)] : Array.isArray(ids) ? ids.map((x) => (x === "self" ? id : x)) : []);
const inComps = (comps, c) => typeof c === "string" && comps.some((p) => p === c || (p.endsWith(":*") && c.startsWith(p.slice(0, -1))));
const sampleOf = (p) => (p.endsWith(":*") ? p.slice(0, -1) + "x" : p);
function scriptRights(st, cap, op, at, need) {
  if (op.verb === "create") { if (!cap.create) refuse("scope", `${cap.key} doesn't declare create: true`, "its scope is data: what it may touch is fixed at install"); (cap.made ??= new Set()).add(op.id); }
  else { const mine = cap.ids.includes(op.id) || cap.made?.has(op.id);
    if (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp)) || (op.comp === undefined && !cap.made?.has(op.id)))
      refuse("scope", `${cap.key} on ${cap.id} may change only ${cap.comps.join("/") || "nothing"} of ${cap.ids.join(", ") || "nothing"}, not ${op.verb} ${at}`, "a script acts only inside the scope it declared at install (41 §3.5)"); }
  const r = roleOf(st, cap.sponsor);
  if (RANK[r] < RANK[need]) refuse("rights", `${cap.key}'s sponsor ${said(cap.sponsor)} can't change ${at} any more (${r} now; it needs ${need})`, "dormant: a behaviour has its sponsor's rights now, never more (L4). An owner may adopt it: adopt {id, script}");
}
// At install (any set of script:<name>), by whoever's rights carry the write: the install rank, a scope within those
// rights NOW (a builder can't install a script that writes roles:*: promotion by proxy), a clean source that parses, the
// timer floor, `always` only by an owner, the world's script count.
function installCheck(w, st, s, who, op) {
  const { actor, cap } = who; const installer = cap?.kind === "script" ? cap.sponsor : cap?.kind === "reaction" ? cap.author : actor;
  const role = roleOf(st, installer), cfg = scriptsCfg(st), v = op.value, at = `${op.id}.${op.comp}`;
  if (RANK[role] < RANK[cfg.install]) refuse("rights", `installing a script here needs ${cfg.install}; ${said(installer)} is ${role}`, "@world.scripts.install says who may (the owner sets it)");
  if (typeof v.src !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.src)) refuse("shape", `${at}.src must be a blob name sha256:<64 hex>`, "upload {text} stores the source and returns its name");
  let blob = null; try { blob = w.getBlob(v.src); } catch { /* missing or doesn't match its name: refused below */ }
  if (!blob) refuse("not-found", `${at}.src: no blob ${v.src} here`, "upload {text} first");
  if (blob.lang !== SR.LANG || typeof blob.text !== "string") refuse("shape", `${at}.src isn't JavaScript source ({lang: '${SR.LANG}', text})`, "upload {text}");
  const dirty = SR.hygiene(blob.text); if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`, "refused at install (41 §3.12): reviewers must see what runs");
  const syn = w.scripts?.checkSyntax?.(blob.text); if (syn) refuse("syntax", `${at}: ${syn.why}`, "docs/SCRIPTS-v4.md shows the API; scripts {id, script, test: {on: 'use'}} runs it dry");
  const sc = v.scope; if (!sc || typeof sc !== "object" || Array.isArray(sc)) refuse("shape", `${at} needs a scope {ids, comps}`, COMPONENTS.script.help);
  if (!(sc.ids === "self" || sc.ids === "subtree" || (Array.isArray(sc.ids) && sc.ids.length <= 32 && sc.ids.every((x) => x === "self" || isEntityId(x)))))
    refuse("shape", `${at}.scope.ids must be 'self', 'subtree' or up to 32 ids`, COMPONENTS.script.help);
  if (!Array.isArray(sc.comps) || sc.comps.length > 16 || !sc.comps.every((c) => typeof c === "string" && isComponent(sampleOf(c)))) refuse("shape", `${at}.scope.comps must be up to 16 component names ('name:*' for keyed)`, COMPONENTS.script.help);
  if (sc.bodies !== undefined && (!Array.isArray(sc.bodies) || sc.bodies.some((b) => !BODY_EFFECTS.includes(b)))) refuse("shape", `${at}.scope.bodies may name ${BODY_EFFECTS.join(", ")}`, "each lands only where that body's consent allows it (L6)");
  if (sc.launch) refuse("shape", `${at}.scope.launch: scripts can't launch sim bodies yet`, "leave launch out");
  if (sc.create && sc.ids !== "subtree") refuse("scope", `${at}: create needs ids: 'subtree' (what it makes must hang under it)`, "");
  // a scope that names a typo of a registered component could never write it (admit refuses the name): say so now
  for (const c of sc.comps) { const n = sampleOf(c).split(":")[0]; const near = !COMPONENTS[n] && !n.includes("/") ? nearMiss(n) : [];
    if (near.length) refuse("schema", `${at}.scope.comps: '${n}' isn't a component; did you mean '${near[0]}'?`, `a component of your own needs a name that isn't one letter-slip from a registered one (or a domain prefix, e.g. 'my.place/${n}')`, { didYouMean: near }); }
  for (const id of scopeIds(s, op.id, sc.ids)) for (const c of sc.comps) { const need = rankNeeded({ id, comp: sampleOf(c) });
    if (RANK[role] < RANK[need]) refuse("rights", `${at}'s scope reaches ${id}.${c}, which needs ${need}; ${said(installer)} is ${role}`, "a script can never do more than its installer could do directly (41 §3.3): narrow the scope, or ask an owner to install or adopt it"); }
  const on = v.on ?? [];
  if (!Array.isArray(on) || on.some((e) => typeof e !== "string" || !(SCRIPT_EVENTS.includes(e) || (e.startsWith("changed:") && isComponent(e.slice(8))))))
    refuse("shape", `${at}.on lists ${SCRIPT_EVENTS.join(", ")} and changed:<comp>`, "timers come from every (they deliver tick, and wake after sleeping)");
  if (v.every !== undefined && !(typeof v.every === "number" && v.every >= 5)) refuse("shape", `${at}.every is ${v.every} s; the floor is 5 s`, "sub-second behaviour belongs in client presence or the engine (41 §3.8); motion is a function of time");
  if (v.knobs !== undefined && jcs(v.knobs).length > 4096) refuse("too-big", `${at}.knobs is ${jcs(v.knobs).length} bytes; at most 4 KiB`, "big data goes in a blob");
  const prev = st.entities[op.id]?.c[op.comp];
  if (v.always === true && prev?.always !== true && RANK[role] < RANK.owner) refuse("rights", `${at}.always (run with nobody present) needs an owner`, "it costs the host while nobody benefits (41 §3.8)");
  if (prev === undefined) { const n = allScripts(s).length;
    if (n > cfg.max) refuse("too-many", `this world would have ${n} scripts; it allows ${cfg.max}`, "@world.scripts.max (owner)"); }
}
const rtKey = (id, name) => `${id}|${name}`;
const rtOf = (w, id, name) => ((w.presence.scripts ??= {})[rtKey(id, name)] ??= { console: [] });
const logRt = (w, rt, line) => { rt.console.push({ ts: Math.floor(w.now()), ...line }); if (rt.console.length > 20) rt.console.shift(); w.presenceDirty = true; };
// how many behaviour acts sit in the cause chain behind entry `seq` (41 §3.9: a reader computes it from the log)
function bhvDepth(w, seq) { let n = 0, e = w.entries[seq], guard = 0;
  while (isE(e) && isBhv(e.actor) && guard++ < 1000) { if (e.kind === "act") n++; e = w.entries[e.cause]; } return n; }
// §5 "Two views" (H3): the sponsor is whose rights admitted the LATEST write to the script: key in its current life
const sponsorOf = (w, id, key) => { if (!creatorOf(w, id, key)) return null; const c = lastSetterOf(w, id, key); return c && !c.deleted ? { sponsor: c.rights, sponsorAt: c.seq } : null; };
// who is here: the door's own bodies plus whoever the host says is connected (a server's people), id → position | null
function presentOf(w) { const out = new Map();
  for (const [id, b] of Object.entries(w.presence.bodies ?? {})) out.set(id, Array.isArray(b?.at) ? b.at : null);
  for (const p of w.present?.() ?? []) if (p && typeof p.id === "string" && !out.has(p.id)) out.set(p.id, Array.isArray(p.at) && p.at.length === 3 && p.at.every(Number.isFinite) ? p.at : null);
  return out; }
const scriptMemo = new WeakMap();
function allScripts(st) { let out = scriptMemo.get(st); if (out) return out; out = [];
  for (const [id, e] of Object.entries(st.entities)) for (const [k, v] of Object.entries(e.c)) if (k.startsWith("script:") && v && typeof v === "object" && !Array.isArray(v) && v !== PURGED) out.push({ id, name: k.slice(7), v });
  scriptMemo.set(st, out); return out; }
// budgets (door practice, stated in @world.scripts; §3d M3): per script per minute; per world per hour; each sponsor a fair
// share of the world's hour, so one builder's chatty scripts can't starve everyone else's (and spreading a script over
// many things or hashes gains nothing: the share is keyed on the sponsor)
function budgetOf(w, st, now, id, key, sponsor, cfg) {
  let mine = 0, all = 0, bySp = 0;
  const sponsors = new Set(allScripts(st).map((x) => sponsorOf(w, x.id, `script:${x.name}`)?.sponsor).filter(Boolean));
  for (let i = w.entries.length - 1; i >= 0; i--) { const e = w.entries[i]; if (!isE(e)) continue; if (Number.isInteger(e.ts) && now - e.ts > 3600000) break;
    if (!isBhv(e.actor)) continue; all++;
    const a = e.kind === "act" ? e : w.entries[e.cause];
    if (isE(a) && a.kind === "act" && a.body?.sponsor === sponsor) bySp++;
    if (e.kind === "act" && e.actor === `bhv:${id}` && e.body?.script === key && now - e.ts <= 60000) mine++; }
  return { mine, all, bySponsor: bySp, sponsors: sponsors.size, share: Math.floor(cfg.budget / Math.max(1, sponsors.size)) };
}
// door practice: what the door spends, logged or not (presence, never the log): an activation that writes nothing still ran
function overCpu(w, now, id, key, sponsor, cfg) {
  const R = (w.presence.scriptRuns ?? []).filter((r) => now - r.ts < 60000); w.presence.scriptRuns = R;
  const runs = R.filter((r) => r.id === id && r.key === key).length; if (runs >= cfg.runs) return `${key} ran ${runs} times in the last minute; at most ${cfg.runs} (@world.scripts.runs)`;
  const ms = R.filter((r) => r.sponsor === sponsor).reduce((t, r) => t + r.ms, 0); if (ms >= cfg.cpu) return `${said(sponsor)}'s scripts used ${ms} ms of the door's time in the last minute; at most ${cfg.cpu} (@world.scripts.cpu)`;
  const all = R.reduce((t, r) => t + r.ms, 0); if (all >= cfg.cpu * 3) return `this world's scripts used ${all} ms of the door's time in the last minute; at most ${cfg.cpu * 3}`;
  return null;
}
// what an act records of its event: everything but what its trigger already holds (a say's text and `to`, a use's args),
// so purging that say or that request purges it everywhere (an auditor reads it from the trigger: scriptaudit.js)
const recorded = (ev) => { const { text, to, args, ...rest } = ev; return ev.seq !== undefined ? rest : ev; };
const overBudget = (B, cfg, key, sponsor, cost) => (B.mine >= cfg.rate ? `${key} logged ${B.mine} activations in the last minute; the rate is ${cfg.rate}`
  : B.all + cost > cfg.budget ? `this world's scripts wrote ${B.all} entries in the last hour; the budget is ${cfg.budget} (@world.scripts.budget)`
  : B.bySponsor + cost > B.share ? `${said(sponsor)}'s scripts wrote ${B.bySponsor} entries in the last hour; each of the ${B.sponsors} sponsors here gets ${B.share} of the world's ${cfg.budget}` : null);
// One activation. ev = {on, by?, seq?, cause?, dry?, …the event's own fields}. Returns what happened; a refused or failed
// activation logs NOTHING (its reason goes to the script's console ring and the status view).
function activate(w, id, name, ev) {
  const st = w.state(), key = `script:${name}`, v = st.entities[id]?.c[key], cfg = scriptsCfg(st);
  const { cause, dry, ...event } = ev;
  const rt = dry ? { console: [] } : rtOf(w, id, name);
  const out = (status, extra = {}) => { if (!dry) { const { logs, ...line } = extra; logRt(w, rt, { on: ev.on, status, ...line, ...(logs ? { logs } : {}) }); rt.status = status; }
    return { script: key, id, status, ...extra }; };
  if (!v || typeof v !== "object" || v === PURGED) return out("not-installed");
  if (v.paused === true) return out("paused", { why: "paused: true (set by its sponsor or an owner)" });
  if (cfg.run === false) return out("stopped", { why: "@world.scripts.run is false (the owner's kill switch)" });
  const sp = sponsorOf(w, id, key); if (!sp) return out("not-installed");
  if (isBanned(w, sp.sponsor)) return out("suspended", { why: `suspended: sponsor ${said(sp.sponsor)} is banned (moderator log); nothing ran` });
  const ver = lastTouch(w, id, key)?.seq; if (!dry && rt.ver !== ver) { rt.ver = ver; rt.fails = 0; } // a re-set (a fix) clears the failure count
  if (!dry && (rt.fails ?? 0) >= cfg.fails) return out("paused", { why: `paused after ${rt.fails} failed activations in a row; set it again (a fix, or the same value) to retry` });
  const depth = 1 + (cause !== undefined ? bhvDepth(w, cause) : 0);
  if (depth > cfg.depth) return out("refused", { code: "depth", why: `cascade depth ${depth} > ${cfg.depth}` });
  if (!w.scripts) return out("unavailable", { why: "this door has no script sandbox" });
  let blob = null; try { blob = w.getBlob(v.src); } catch { /* below */ }
  const fail = (code, why, logs) => { if (!dry && code !== "unavailable") rt.fails = (rt.fails ?? 0) + 1; return out(code === "unavailable" ? "unavailable" : "failed", { code, why, ...(logs?.length ? { logs } : {}), ...(dry ? {} : { fails: rt.fails }) }); };
  if (!blob || blob.lang !== SR.LANG || typeof blob.text !== "string") return fail("source", `${id}.${key}.src: no ${SR.LANG} source ${v.src} here`);
  const actSeq = w.entries.length, seed = SR.seedOf(w.worldId, actSeq, `${id}/${key}`), now = w.nextTs(); // the clock is frozen at the act's own ts
  if (!dry) { const why = overCpu(w, now, id, key, sp.sponsor, cfg); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const B = budgetOf(w, st, now, id, key, sp.sponsor, cfg); // spent already: refused before it costs the door a run
  { const why = overBudget(B, cfg, key, sp.sponsor, 1); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const here = presentOf(w), me = worldT(st, id)?.pos ?? [0, 0, 0];
  const t0 = performance.now();
  const res = w.scripts.run({ text: blob.text, self: id, key, event, knobs: v.knobs ?? {}, now, seed, st,
    near: (r) => [...here].filter(([, at]) => at && dist(at, me) <= r).map(([k]) => k).sort(), count: () => here.size,
    name: (who) => (typeof who === "string" && (isIdentity(who) || isBhv(who)) ? NAMEOF?.(who) ?? dec(who) ?? null : null) });
  if (!dry) ((w.presence.scriptRuns ??= []).push({ ts: now, id, key, sponsor: sp.sponsor, ms: Math.round(performance.now() - t0) }), w.presenceDirty = true);
  if (!res.ok) return fail(res.code, res.why, res.logs);
  const logs = res.logs.length ? { logs: res.logs } : {};
  const ops = SR.elide(st, res.ops);
  if (!ops.length && !res.says.length && !res.bodies.length) { if (!dry) rt.fails = 0; return out("nothing", { why: res.ran ? "nothing changed: no entry" : `it has no handler for '${ev.on}'`, ...logs }); }
  const cap = { kind: "script", key, id, sponsor: sp.sponsor, ids: scopeIds(st, id, v.scope?.ids), comps: v.scope?.comps ?? [], create: !!v.scope?.create };
  const mark = (code, why) => out("refused", { code, why, sponsor: sp.sponsor, ...logs });
  if (res.says.length && !v.scope?.say) return mark("scope", `${key} doesn't declare say: true`);
  for (const b of res.bodies) if (!(v.scope?.bodies ?? []).includes(b.act)) return mark("scope", `${key} doesn't declare bodies: ['${b.act}']`);
  { const why = overBudget(B, cfg, key, sp.sponsor, 1 + (ops.length ? 1 : 0) + res.says.length); if (why) return mark("budget", why); } // what it would actually write
  let plan = null;
  if (ops.length) try { plan = admit(w, st, { actor: `bhv:${id}`, cap }, ops); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
  if (dry) return { script: key, id, status: "would-run", would: plan?.ops ?? [], says: res.says, bodies: res.bodies, sponsor: sp.sponsor, fuel: res.fuel, note: "dry: nothing was written; body effects still meet each body's consent when it runs", ...logs };
  const gates = [];
  for (const b of res.bodies) { const g = bodyGate(w, `bhv:${id}`, b.to, b.act, { spec: b.spec, script: key, sponsor: sp.sponsor }); if (!g.ok) return mark(g.code, g.reason); gates.push({ ...b, consent: g.consent, deliver: g.deliver }); }
  const actE = { kind: "act", actor: `bhv:${id}`, verb: "script", ...(cause !== undefined ? { cause } : {}),
    body: { script: key, src: v.src, sponsor: sp.sponsor, sponsorAt: sp.sponsorAt, on: ev.on, ...(ev.by ? { trigger: { actor: ev.by, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) } } : {}),
      event: recorded(event), head: actSeq - 1, seed, depth, engine: SR.ENGINE, api: SR.API, ...(res.reads ? { reads: res.reads } : {}),
      ...(gates.length ? { bodies: gates.map((g) => ({ act: g.act, to: `body:${g.to}`, consent: g.consent })) } : {}) } };
  const sayE = (t, c) => ({ kind: "say", actor: `bhv:${id}`, cause: c, verb: "say", body: { text: t } });
  let act, state = null;
  w.pinTs = now;
  try {
    try { w.fits(actE, ...(plan ? [stateShape(plan, actSeq, w)] : []), ...res.says.map((t) => sayE(t, actSeq))); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
    act = w.append(actE); if (plan) state = stateEntry(w, plan, act);
    for (const t of res.says) (w.sayQ ??= []).push(w.append(sayE(t, act)));
  } finally { w.pinTs = null; }
  for (const g of gates) g.deliver();
  rt.fails = 0; return out("ran", { act, ...(state !== null ? { state } : {}), ops: ops.length, sponsor: sp.sponsor, ...logs });
}
function withDoor(w, fn) {
  const prevCat = CAT, prevName = NAMEOF, prevAnon = ISANON, prevThrough = THROUGH, prevKnown = KNOWNID; CAT = w.catalogue ?? LAB_CATALOGUE; NAMEOF = w.nameOf ?? null; THROUGH = false;
  ISANON = (id) => w.kindOf?.(id) === "anon"; KNOWNID = (id) => !w.kindOf || w.kindOf(id) != null;
  try { return fn(); } finally { CAT = prevCat; NAMEOF = prevName; ISANON = prevAnon; KNOWNID = prevKnown; THROUGH = prevThrough; if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } }
}
/**
 * Timers (door practice): a due script with nobody present sleeps unless `always`; on its first due tick after someone
 * arrives it gets ONE `wake {slept}`, never a burst. Several missed periods while awake coalesce into one tick. A timer
 * act's cause is the entry that made its sponsor (its latest install). Then the cascades it set off. A host calls this on
 * its own clock (server/v4: once a second); it never runs inside a request.
 */
export function tick(w) {
  if (!w.exists || w.state().status !== "ok") return [];
  return withDoor(w, () => {
    w.changedQ = []; w.sayQ = [];
    const now = w.now(), present = presentOf(w).size > 0, ran = [];
    for (const { id, name, v } of allScripts(w.state())) { if (!(typeof v.every === "number" && v.every >= 5)) continue; const rt = rtOf(w, id, name);
      if (rt.next === undefined) { rt.next = now + v.every * 1000; w.presenceDirty = true; continue; }
      if (now < rt.next) continue;
      rt.next = now + v.every * 1000; w.presenceDirty = true;
      if (!present && v.always !== true) { rt.sleepingSince ??= now; rt.status = "asleep"; continue; }
      const slept = rt.sleepingSince !== undefined ? Math.round((now - rt.sleepingSince) / 1000) : null; delete rt.sleepingSince;
      const sp = sponsorOf(w, id, `script:${name}`);
      ran.push(activate(w, id, name, { on: slept !== null ? "wake" : "tick", ...(slept !== null ? { slept } : {}), ...(sp ? { cause: sp.sponsorAt } : {}) }));
    }
    drainScripts(w);
    return ran;
  });
}
/** A world opened after its host stopped without settling presence (a crash, a SIGKILL: no leave ran). Holds are
 *  presence. A host that persists presence (server/v4/disk.ts) still has the hold, with no one connected to let go: it's
 *  settled as `leave` settles it (a drop as the holder, which its grabbable may send home, into a socket or straight
 *  down; a drop the door refuses becomes its return-held). A host that keeps presence in memory (server/v4/live.ts)
 *  has lost the hold, but in a world that runs physics the grab's `lift` took the thing out of the engine and nothing
 *  put it back: it would stay a ghost (no body, no collider) until someone moved it. That is settled by the door as
 *  leave's refusal is: a return-held act (cause: the lift) writing where the log last had it, which seats it in the
 *  engine again, or, for a grabbable that returns, a return-home. `present` = identities connected now (none, at
 *  load). Returns what it settled. */
export function settleOrphans(w, present = []) {
  if (!w.exists || w.state().status !== "ok") return [];
  const here = new Set(present); const out = [];
  for (const who of [...new Set(Object.values(w.presence.holds ?? {}).map((h) => h.by))]) if (!here.has(who)) {
    const r = request(w, who, "leave", {}); out.push({ holder: who, left: r.ok, dropped: r.dropped ?? [] });
    // a holder the door won't take requests from now (banned since): the hold just ends (presence), and what the log
    // lifted is settled below by the door, as leave's own refusal is (review 10-06)
    if (!r.ok) { for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === who) delete w.presence.holds[id]; delete w.presence.bodies[who]; } }
  withDoor(w, () => {
    const st = w.state(); if (!st.entities["@world"]?.c.sim) return;
    for (const [id, lift] of orphanLifts(w)) {
      if (w.presence.holds[id] || !st.entities[id]) continue;
      const g = grabOf(st.entities[id].c);
      if (g?.release === "return" && g.home) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq); out.push({ id, returned: "home" }); continue; } }
      const t = w.state().entities[id].c.transform; if (!t) continue;
      let plan; try { plan = admit(w, w.state(), { actor: "door", cap: { kind: "door", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]); } catch (x) { if (!(x instanceof Refusal)) throw x; continue; }
      stateEntry(w, plan, w.append({ kind: "act", actor: "door", verb: "return-held", cause: lift.seq, body: { id, holder: lift.by, why: "orphaned: its holder's hold ended without a settlement (the host stopped)" } }));
      out.push({ id, returned: "where the log had it" });
    }
  });
  if (out.length) w.savePresence();
  return out;
}
// Things the log has lifted out of the engine (a grab's lift, a catch) with nothing after that puts them back: no launch,
// no write to where they are or what they are, no epoch cut (a new epoch builds its bodies from the whole state).
function orphanLifts(w) {
  const lifted = new Map();
  w.entries.forEach((e, seq) => {
    if (!isE(e)) return;
    if (e.kind === "sim" && (e.verb === "lift" || e.verb === "catch") && e.body?.id) lifted.set(e.body.id, { seq, by: e.actor });
    else if (e.kind === "sim" && e.verb === "launch") lifted.delete(e.body?.id);
    else if (e.kind === "state") for (const o of opsQuiet(e)) {
      if (o.id === "@world" && o.comp === "sim") { lifted.clear(); continue; }
      if (o.verb === "create" || (o.verb === "delete" && o.comp === undefined) || ["transform", "parent", "model", "physics"].includes(o.comp)) lifted.delete(o.id); }
  });
  return lifted;
}
/** Someone arrived or left (presence, told by the host): scripts that list `enter` / `leave` hear it, with `by`. The act's
 *  cause is the entry that made the script's sponsor (an arrival isn't logged on every path). */
export function presenceEvent(w, kind, who) {
  if (!w.exists || w.state().status !== "ok" || !["enter", "leave"].includes(kind) || !isIdentity(who)) return [];
  return withDoor(w, () => {
    w.changedQ = []; w.sayQ = []; const ran = [];
    for (const { id, name, v } of allScripts(w.state())) if (Array.isArray(v.on) && v.on.includes(kind)) { const sp = sponsorOf(w, id, `script:${name}`);
      ran.push(activate(w, id, name, { on: kind, by: who, ...(sp ? { cause: sp.sponsorAt } : {}) })); }
    drainScripts(w);
    return ran;
  });
}
// grab and release (grabbable; research grab §3): every script whose scope covers the thing and lists the event hears
// it, once. A grab is presence (unlogged unless the sim had to be told): its activation's cause is the grab's own act
// when there is one, else the entry that made the script's sponsor, as enter/leave. A release is the settlement, which
// is logged: its act is the cause. Fields: by, id, hand, grip? (grab); by, id, how (put | drop | throw | stay | return |
// snap), slot? and to? (release), seq (the act) when logged.
const heldEvent = (w, kind, id, ev) => { (w.heldQ ??= []).push({ kind, id, ev }); };
function drainHeld(w) {
  let guard = 0;
  while (w.heldQ?.length && guard++ < 64) { const { kind, id, ev } = w.heldQ.shift(); const st = w.state();
    for (const { id: sid, name, v } of allScripts(st)) {
      if (!(Array.isArray(v.on) && v.on.includes(kind)) || !scopeIds(st, sid, v.scope?.ids).includes(id)) continue;
      const sp = sponsorOf(w, sid, `script:${name}`);
      activate(w, sid, name, { on: kind, id, ...ev, ...(ev.seq !== undefined ? { cause: ev.seq } : sp ? { cause: sp.sponsorAt } : {}) }); } }
  if (w.heldQ) w.heldQ.length = 0;
}
// What a request's (or an activation's) entries set off: `changed:<comp>` for a state entry that changes <comp> on an id
// in the script's scope; `say` for a say entry. One activation per (script, triggering entry); a script never hears its own.
function drainScripts(w) {
  let guard = 0;
  while ((w.changedQ?.length || w.sayQ?.length) && guard++ < 1000) {
    const st = w.state(); const scripts = allScripts(st);
    if (w.changedQ?.length) { const seq = w.changedQ.shift(); const e = w.entries[seq]; if (!isE(e)) continue;
      const watching = scripts.filter((x) => Array.isArray(x.v.on) && x.v.on.some((o) => o.startsWith("changed:"))); if (!watching.length) continue;
      const changed = opsQuiet(e).filter((o) => o.comp !== undefined);
      for (const { id, name, v } of watching) { if (e.actor === `bhv:${id}`) continue;
        const ids = scopeIds(st, id, v.scope?.ids); const hit = changed.find((o) => ids.includes(o.id) && v.on.includes(`changed:${o.comp}`));
        if (hit) activate(w, id, name, { on: `changed:${hit.comp}`, id: hit.id, comp: hit.comp, by: (isE(w.entries[e.cause]) ? w.entries[e.cause].actor : null) ?? e.actor, seq, cause: seq }); }
      continue; }
    const seq = w.sayQ.shift(); const e = w.entries[seq]; if (!isE(e) || e.kind !== "say") continue;
    for (const { id, name, v } of scripts) { if (!(Array.isArray(v.on) && v.on.includes("say")) || e.actor === `bhv:${id}`) continue;
      activate(w, id, name, { on: "say", by: e.actor, text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: e.body.to } : {}), seq, cause: seq }); }
  }
  if (w.changedQ) w.changedQ.length = 0; if (w.sayQ) w.sayQ.length = 0;
}
// The status view (41 §3.4): suspended / paused / stopped / unavailable / dormant (and why, since when) / asleep / active.
// A view, never logged.
function scriptStatus(w, st, id, name, v) {
  const key = `script:${name}`, sp = sponsorOf(w, id, key), rt = w.presence.scripts?.[rtKey(id, name)], cfg = scriptsCfg(st);
  let src = null; try { src = w.getBlob(v.src); } catch { /* missing: said below */ }
  const base = { id, script: key, src: v.src, sponsor: sp?.sponsor ?? null, sponsorAt: sp?.sponsorAt ?? null, on: v.on ?? [], ...(v.every ? { every: v.every, always: !!v.always } : {}), scope: v.scope,
    ...(src?.text && SR.looksMinified(src.text) ? { note: "the source looks minified: hard to review" } : {}), last: rt?.console?.slice(-3) ?? [] };
  if (sp && isBanned(w, sp.sponsor)) return { ...base, status: "suspended", why: `sponsor ${said(sp.sponsor)} is banned` };
  if (v.paused === true) return { ...base, status: "paused", why: "paused: true" };
  if (cfg.run === false) return { ...base, status: "stopped", why: "@world.scripts.run is false" };
  if (!src) return { ...base, status: "failed", why: `its source ${v.src} isn't here` };
  if (!w.scripts) return { ...base, status: "unavailable", why: "this door has no script sandbox" };
  if (rt?.fails >= cfg.fails && rt.ver === lastTouch(w, id, key)?.seq) return { ...base, status: "paused", why: `${rt.fails} failed activations in a row; set it again to retry` };
  const role = roleOf(st, sp?.sponsor); const lost = [];
  for (const x of scopeIds(st, id, v.scope?.ids)) for (const c of v.scope?.comps ?? []) { const need = rankNeeded({ id: x, comp: sampleOf(c) }); if (RANK[role] < RANK[need]) lost.push(`${x}.${c}`); }
  if (lost.length) { const since = lastSetterOf(w, "@world", `roles:${sp.sponsor}`);
    return { ...base, status: "dormant", why: `dormant: sponsor ${said(sp.sponsor)} (${role} now${since ? `, since seq ${since.seq}` : ""}) can no longer change ${lost.join(", ")}`, adopt: `an owner may: adopt {id: '${id}', script: '${name}'}` }; }
  return { ...base, status: rt?.status === "asleep" ? "asleep" : "active" };
}
function scriptsOf(w, st, id) {
  return { scripts: allScripts(st).filter((x) => !id || x.id === id).map((x) => scriptStatus(w, st, x.id, x.name, x.v)),
    ...(id && id !== "@world" ? {} : { v1: v1Behaviours(w, st) }), config: scriptsCfg(st), sandbox: w.scripts ? (w.scripts.available?.() === true ? SR.ENGINE : `unavailable: ${w.scripts.available?.()}`) : "none" };
}
/** The status view for a host's own readers (a server's debug panel): what `scripts {id?}` answers, without a request. */
export function scriptsView(w, id) { if (!w.exists || w.state().status !== "ok") return { scripts: [], v1: [] }; return withDoor(w, () => scriptsOf(w, w.state(), id)); }
// a translated v1 world carries its bindings as @world behavior:<name> (v1's shape, kept as a record). v4 never runs them.
const V1_WHY = "a v1 behaviour, carried by translation. v4 doesn't run v1 source: it was written for v1's API (world.emit, world.kv) with its author's rights and no declared scope. Re-install it as script:<name> on the thing it belongs to: rewrite the source for the v4 API (docs/SCRIPTS-v4.md), upload {text}, then set script:<name> {src, scope, on}";
function v1Behaviours(w, st) {
  return Object.entries(st.entities["@world"]?.c ?? {}).filter(([k]) => k.startsWith("behavior:")).map(([k, b]) => ({ id: "@world", behavior: k,
    attach: b?.attach ?? null, src: b?.src ?? null, author: b?.author ?? null, status: "needs-reinstall", why: V1_WHY }));
}

// ---------- the act index (slice 3a): undo and wait without scanning the log ----------
// A view over the log (L2), built once per world object and advanced per appended entry, so a live world (server/v4,
// where `w` lives as long as the world is open) pays for each entry once. A purge is retroactive (L1), so a purge entry
// throws the index away and rebuilds it, as live.ts refolds the state. What it holds:
//   actsOf    actor → their act seqs, in order          resultOf  act seq → the first state entry it caused
//   undone    act seqs some `undo` act names (body.undoes)
//   purged    seqs whose act/say/sim BODY is purged; purgedOps `${seq}:${op|-}` → a purged set value (as the fold keys it)
//   states    every state seq, in order                 touch     id → the state seqs that touch it, in order
//   rests     state seqs that are rests (caused by a sim launch); restAfter: rest seq → the door's follow-up act
//   lastAct   the latest act that isn't an undo or the door's (for "the latest change was X's")
// A world object over a log that is re-read per request (the suites' disk worlds) rebuilds it per request, as before.
function freshIndex() {
  return { n: 0, actsOf: new Map(), resultOf: new Map(), undone: new Set(), purged: new Set(), purgedOps: new Map(), states: [], touch: new Map(),
    rests: [], restAfter: new Map(), lastAct: null };
}
function purgeTargets(E, x) { // the fold's own reading of purge entries (fold.js purgesOf), kept for views
  x.pt = E.length; // purges below this seq are already in purged/purgedOps
  E.forEach((e, pseq) => { if (!isE(e) || x.bad.has(pseq) || e.kind !== "purge" || !Array.isArray(e.body?.values)) return;
    for (const t of e.body.values) { if (!t || typeof t !== "object" || Array.isArray(t) || !Object.keys(t).every((k) => k === "seq" || k === "op")) continue;
      if (!Number.isInteger(t.seq) || t.seq <= 0 || t.seq >= pseq || (t.op !== undefined && !(Number.isInteger(t.op) && t.op >= 0))) continue;
      const tgt = E[t.seq]; if (!isE(tgt) || x.bad.has(t.seq) || tgt.kind === "purge") continue;
      if (t.op === undefined && ["act", "say", "sim"].includes(tgt.kind)) x.purged.add(t.seq);
      x.purgedOps.set(`${t.seq}:${t.op ?? "-"}`, pseq); } });
}
function indexEntry(x, E, i) {
  const e = E[i]; if (!isE(e) || x.bad.has(i)) return; // what the fold refuses (malformed) shapes no view either
  if (e.kind === "act") { let a = x.actsOf.get(e.actor); if (!a) x.actsOf.set(e.actor, (a = [])); a.push(i);
    const b = x.purged.has(i) ? null : e.body;
    if (e.verb === "undo" && b && b.undoes !== undefined) x.undone.add(b.undoes);
    if (e.verb === "undo" && b && Array.isArray(b.rollback?.acts)) for (const q of b.rollback.acts) x.undone.add(q);
    if (e.verb !== "undo" && e.actor !== "door") x.lastAct = i;
    if (e.actor === "door" && b && Number.isInteger(b.rest) && !x.restAfter.has(b.rest)) x.restAfter.set(b.rest, i); }
  if (e.kind === "state") { x.states.push(i);
    if (Number.isInteger(e.cause) && !x.resultOf.has(e.cause)) x.resultOf.set(e.cause, i);
    for (const id of new Set(opsQuiet(e).map((o) => o.id))) { let a = x.touch.get(id); if (!a) x.touch.set(id, (a = [])); a.push(i); }
    const c = E[e.cause]; if (isE(c) && c.kind === "sim" && c.verb === "launch") x.rests.push(i); }
}
// The entries the fold calls malformed (it shapes nothing with them). The door never writes one; an old or hand-made
// log may hold some, and they're known when the index is built (the door re-reads every line it appends).
const malformedSeqs = (st) => new Set((st?.diagnostics ?? []).filter(([, c]) => String(c).startsWith("malformed")).map(([q]) => q));
/** The act index for a world, advanced to the log's end (rebuilt from scratch when a purge arrives). */
export function actIndexOf(w) {
  const E = w.entries; let x = w.__actIndex;
  const fresh = () => { const y = freshIndex(); y.entries = E; y.bad = malformedSeqs(w.state ? w.state() : fold(E)); purgeTargets(E, y); return (w.__actIndex = y); };
  if (!x || x.entries !== E || x.n > E.length) x = fresh();
  for (; x.n < E.length; x.n++) {
    if (x.n >= x.pt && isE(E[x.n]) && E[x.n].kind === "purge") { const n = x.n; x = fresh(); for (; x.n < n; x.n++) indexEntry(x, E, x.n); } // retroactive (L1): start over
    indexEntry(x, E, x.n); }
  return x;
}
/** The same index built from nothing over `entries` (the reference the incremental one must equal). */
export function actIndexFresh(entries) { return actIndexOf({ entries }); }
const firstAfter = (a, seq) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= seq) lo = m + 1; else hi = m; } return lo; };
/** A thing as it was just before entry `seq` (= fold(entries, {until: seq - 1}).entities[id]), from its own history
 *  through the index, never the whole log. Purged values are PURGED at every point in time, as the fold has them. */
export function entityBefore(w, id, seq, x = actIndexOf(w)) {
  let ent = id === "@world" ? { born: 0, c: Object.create(null) } : undefined; // @world is live from genesis (§2.3)
  const E = w.entries; const hist = x.touch.get(id) ?? [];
  for (let k = 0; k < hist.length && hist[k] < seq; k++) { const i = hist[k]; const e = E[i]; const ops = opsQuiet(e); const batch = e.verb === "batch";
    ops.forEach((o, j) => { if (o.id !== id) return;
      if (o.verb === "create") { if (!ent) ent = { born: i, c: Object.create(null) }; return; }
      if (!ent) return;
      if (o.verb === "set") { if (x.purgedOps.has(`${i}:${batch ? j : "-"}`)) ent.c[o.comp] = PURGED; else if ("value" in o) ent.c[o.comp] = clone(o.value); return; }
      if (o.comp === undefined) { if (id !== "@world") ent = undefined; return; }
      delete ent.c[o.comp]; }); }
  return ent;
}

// ---------- undo (by act; the inverse goes through admit like any write: rank and locks NOW) ----------
function skyValue(prev, verb, args, now) {
  if (!args || typeof args !== "object" || Array.isArray(args)) refuse("shape", `${verb} takes the sky's fields {hours, rate, weather, clouds…}`, "");
  const { dry, ...a } = args;
  const out = clone(foldSkyEntry(prev, { verb, args: a, ts: Math.floor(now), seq: 0, actor: "door" }));
  delete out.seq; delete out.by;
  for (const k of ["forecast", "override"]) if (out[k] && typeof out[k] === "object") { delete out[k].seq; delete out[k].by; }
  return out;
}
function buildSky(ctx, a, w) { return [setOp("@world", "sky", skyValue(null, "sky", a, w.now()))]; }
function buildWeather(ctx, a, w) { return [setOp("@world", "sky", skyValue(ctx.st.entities["@world"]?.c.sky ?? null, "weather", a, w.now()))]; }
function buildUndo(ctx, a, w) {
  const X = actIndexOf(w); const E = w.entries;
  const mine = X.actsOf.get(ctx.actor) ?? [];
  const bodyOf = (seq) => (X.purged.has(seq) ? null : E[seq].body); // a purged act's request can't be read, or matched by label
  const result = (seq) => { const r = X.resultOf.get(seq); return r === undefined ? undefined : E[r]; };
  // the inverse of one act against `now`: what to write, and what to leave because someone changed it since. A function
  // so an owner's rollback can run it over many acts in a row, each against what the previous inverses left
  const inverseOf = (target, res, now) => {
  const beforeOf = new Map(); const before = (id) => { if (!beforeOf.has(id)) beforeOf.set(id, entityBefore(w, id, target.seq, X)); return beforeOf.get(id); };
  const flat = opsOf(res);
  // what others wrote since: a thing's own later history (touch), and, for the spatial check, every state entry since
  // the result (bounded by what happened after the act, never the log before it)
  const others = (i) => E[i].actor !== target.actor; // later work by anyone but the act's own author stands
  const touchedBy = (id, comp) => { const h = X.touch.get(id) ?? []; for (let k = firstAfter(h, res.seq); k < h.length; k++) { const e = E[h[k]]; if (!others(h[k])) continue;
    for (const o of opsQuiet(e)) if (o.id === id && (comp === undefined || o.comp === comp || o.comp === undefined || o.verb === "create")) return e.actor; } return null; };
  const later = X.states.slice(firstAfter(X.states, res.seq)).filter(others).map((i) => E[i]);
  const groups = [], skipped = [];
  const keys = new Map();
  const madeHere = new Set(flat.filter((o) => o.verb === "create").map((o) => o.id)); // undone as one unit: the whole thing goes
  for (const o of flat) { if (madeHere.has(o.id) && o.verb !== "create") continue;
    const k = o.id + "|" + (o.verb === "set" || (o.verb === "delete" && o.comp !== undefined) ? o.comp : "*"); if (!keys.has(k)) keys.set(k, o); }
  for (const [, o] of [...keys].reverse()) {
    const { id, comp } = o; const whole = o.verb === "create" || (o.verb === "delete" && comp === undefined);
    const by = touchedBy(id, whole ? undefined : comp);
    if (by) { skipped.push({ id, component: comp, why: `${said(by)} changed it since`, by }); continue; }
    // undoing a create: what others hung on it since is THEIR work. It stays, let go where it is (round-1 F3), never
    // deleted with it and never left pointing at a thing that's gone
    if (o.verb === "create") { if (now.entities[id]) { const kids = Object.keys(now.entities).filter((k) => now.entities[k].c.parent?.to === id && !madeHere.has(k));
        groups.push([...kids.flatMap((k) => [setOp(k, "transform", worldT(now, k)), delOp(k, "parent")]), delOp(id)]); kids.forEach((k) => ctx.refs.add(k)); } }
    else if (whole) { const old = before(id); if (old && !now.entities[id]) (ctx.restores ??= new Set()).add(id), groups.push(createOps(id, Object.fromEntries(Object.entries(old.c).filter(([, v]) => v !== PURGED)))); }
    else { const old = before(id)?.c[comp];
      if (old === PURGED) { skipped.push({ id, component: comp, why: "its old value was purged" }); continue; }
      if (old === undefined) { if (now.entities[id] && comp in now.entities[id].c) groups.push([delOp(id, comp)]); }
      else if (now.entities[id]) groups.push([setOp(id, comp, old)]); }
    ctx.refs.add(id);
  }
  // an undo must not land my old state on someone else's later work (spatial conflict, not just same-component)
  const othersSince = new Set(later.flatMap((e) => opsQuiet(e).map((o) => o.id)));
  for (let i = groups.length - 1; i >= 0; i--) { const g = groups[i]; const o = g.at(-1);
    if (!(g[0].verb === "create" || (o.verb === "set" && ["transform", "parent"].includes(o.comp)))) continue;
    const trial = scratch(now, g); const mine = obbs(trial, o.id);
    const hit = [...othersSince].find((x) => x !== o.id && trial.entities[x] && obbs(trial, x).some((sb) => mine.some((ma) => satDepth(ma, sb) > 0.02)));
    if (hit) { const who = later.find((e) => opsQuiet(e).some((q) => q.id === hit))?.actor;
      skipped.push({ id: o.id, component: o.comp, why: `putting it back would land it on ${hit}, which ${said(who)} has placed since`, by: who }); groups.splice(i, 1); } }
  return { groups, skipped }; };
  const pick = (pred) => { for (let k = mine.length - 1; k >= 0; k--) if (pred(mine[k])) return E[mine[k]]; return undefined; };
  // an undo's depth along its `undoes` chain: 0 = an ordinary act, 1 = an undo of one, 2 = a redo (an undo of an undo)…
  // A bare undo takes back my latest live act of EVEN depth: an ordinary act or a redo. Skipping only plain undos keeps
  // Ctrl+Z walking back, while a redo is undone first (agent lab round 2, Hazel: a bare undo after a redo reached past
  // it into older work).
  const depthOf = (seq) => { let d = 0, q = seq; while (q !== undefined && E[q]?.verb === "undo" && d < 64) { d++; q = E[q].body?.undoes; } return d; };
  const undoneBy = (seq) => { for (let k = mine.length - 1; k >= 0; k--) if (E[mine[k]].verb === "undo" && E[mine[k]].body?.undoes === seq) return mine[k]; return undefined; };
  // an owner's rollback (round-2 R11, CoreProtect's rollback by player and time): undo {actor, since} takes back every
  // act that person made since a version, newest first, each inverse against what the previous ones left; later work by
  // anyone else still stands. It says how many acts it would take back, and above 20 it needs confirm: true.
  if (a.actor !== undefined || a.since !== undefined) {
    if (roleOf(ctx.st, ctx.actor) !== "owner") refuse("rights", "rolling back someone's work needs owner", "undo {act} takes back one act, along rank");
    if (!isIdentity(a.actor) || RESERVED.has(a.actor)) refuse("shape", "rollback is undo {actor, since}: actor is a person's identity", "history shows who did what");
    const from = versionSeq(w, a.since, "since");
    const acts = (X.actsOf.get(a.actor) ?? []).filter((q) => q >= from && X.resultOf.has(q) && !X.undone.has(q) && !["new", "undo", "throw", "drop", "leave"].includes(E[q].verb)).reverse();
    if (!acts.length) refuse("nothing", `${said(a.actor)} has made no change since act ${from} that's still in force`, "");
    if (acts.length > 20 && a.confirm !== true && a.dry !== true) refuse("confirm", `that rolls back ${acts.length} acts by ${said(a.actor)} since act ${from}`, "dry: true lists them; confirm: true does it", { acts: acts.length });
    let st = ctx.st; const all = []; const skippedAll = [], done = [];
    for (const q of acts) { const { groups, skipped } = inverseOf(E[q], result(q), st); const ops = groups.flat();
      skippedAll.push(...skipped); if (ops.length) { all.push(...ops); st = scratch(st, ops); done.push(q); } }
    if (!all.length) refuse("conflict", `everything ${said(a.actor)} did since then has been changed by others since`, "their later work stands");
    if (skippedAll.length) ctx.notes.push({ skipped: skippedAll });
    ctx.actExtra = { rollback: { actor: a.actor, since: from, acts: done } };
    ctx.undid = { kind: "rollback", acts: done.length, of: said(a.actor) };
    return all; }
  // F2 (decided 10-05): revert goes along rank, never upward. Someone else's act may be undone by a builder (a builder's
  // or a visitor's) or an owner (anyone's, owners included: round-2 R11, owners revert owners). Roles as they are NOW.
  const othersAct = (seq) => { const e = E[seq]; if (!(isE(e) && e.kind === "act")) return undefined;
    if (RESERVED.has(e.actor)) refuse("rank", `act ${seq} was the door's own, not a person's`, "undo takes back people's acts");
    const me = RANK[roleOf(ctx.st, ctx.actor)], them = RANK[roleOf(ctx.st, e.actor)];
    if (me < RANK.builder || me < them) refuse("rank", `act ${seq} was ${said(e.actor)}'s; ${me < RANK.builder ? "undoing someone else's work needs builder" : `they're ${roleOf(ctx.st, e.actor)}, above you`}`, "revert goes along rank, never upward: ask an owner");
    return e; };
  const target = a.act !== undefined ? (mine.includes(a.act) ? E[a.act] : othersAct(a.act))
    : a.label ? pick((q) => bodyOf(q)?.request?.label === a.label && !X.undone.has(q) && X.resultOf.has(q))
    : pick((q) => E[q].verb !== "new" && depthOf(q) % 2 === 0 && !X.undone.has(q) && X.resultOf.has(q));
  if (!target) { const last = X.lastAct === null ? null : E[X.lastAct];
    refuse("nothing", "nothing of yours to undo" + (last && last.actor !== ctx.actor ? ` (the latest change was ${said(last.actor)}'s; undo only reverts your own)` : ""), "history shows who did what; to change someone else's work, edit it (they'll see it)"); }
  if (target.verb === "new") refuse("founding", "founding a world can't be undone", "§2.3: @world can't be deleted or undone as a whole; to hand it over, give the new owner their role first");
  if (X.undone.has(target.seq)) { let head = target.seq; const chain = []; for (let i = 0; i < 64; i++) { const u = undoneBy(head); if (u === undefined) break; chain.push(u); head = u; }
    const live = head !== target.seq && depthOf(head) % 2 === 0 ? head : null;
    refuse("nothing", `act ${target.seq} was already undone${chain.length ? ` (by ${chain.map((c) => `${depthOf(c) % 2 ? "undo" : "redo"} ${c}`).join(", then ")})` : ""}`,
      live !== null ? `it's back in force through redo ${live}: undo {act: ${live}} (or a bare undo) takes it back` : "a bare undo takes back your latest change; history shows the chain"); }
  if (["throw", "drop", "leave"].includes(target.verb)) refuse("physical", `that was a ${target.verb}: what it changed is where things came to rest, which physics decided`, "put it back yourself: grab it, then put {id, pos}");
  const res = result(target.seq); if (!res) refuse("nothing", "that act changed nothing", "");
  if (target.verb === "sculpt" && TR.ADDITIVE.has(target.body.request?.brush) && !target.body.clamped) { const inv = sculptInverse(w, ctx, target, res); if (inv) { ctx.actExtra = { undoes: target.seq, inverse: true }; return inv; } }
  const { groups, skipped } = inverseOf(target, res, ctx.st);
  if (!groups.length) refuse("conflict", "everything that act touched has been changed by someone else since", "their later change stands (undo never writes over it); if you still want yours, make the change again yourself, and history shows who did what", { skipped });
  if (skipped.length) ctx.notes.push({ skipped });
  // round-2 R11: a brake on revert wars (Wikipedia's 3RR): reverting someone else's work on a thing that has already been
  // reverted across people twice within the hour is refused below owner rank: that's a dispute, and owners settle it
  if (target.actor !== ctx.actor && RANK[roleOf(ctx.st, ctx.actor)] < RANK.owner) {
    const mine2 = new Set(groups.flat().map((o) => o.id)); const t0 = w.now() - 3600000; let n = 0;
    for (let i = E.length - 1; i >= 0; i--) { const e = E[i]; if (!isE(e)) continue; if (Number.isInteger(e.ts) && e.ts < t0) break;
      if (e.kind !== "act" || e.verb !== "undo" || !Number.isInteger(e.body?.undoes) || E[e.body.undoes]?.actor === e.actor) continue;
      const r = result(i); if (r && opsQuiet(r).some((o) => mine2.has(o.id))) n++; }
    if (n >= 2) refuse("revert-war", `${[...mine2].join(", ")} has been reverted across people ${n} times in the last hour`, "that's a disagreement, not a fix: ask an owner (owners may still revert), or talk it out"); }
  ctx.actExtra = { undoes: target.seq };
  // round-2 R11: undoing my own `use` is admitted under the same reaction capability the use was (a visitor may open
  // a door through its handler, so they may close it again by undo), asked for again NOW: no handler, no undo
  const ureq = bodyOf(target.seq)?.request;
  if (target.verb === "use" && target.actor === ctx.actor && target.body?.capability?.reaction && ureq?.id && ctx.st.entities[ureq.id]?.c.reactions?.[target.body.capability.reaction]) {
    const comps = [...new Set(groups.flat().map((o) => o.comp).filter(Boolean))];
    if (groups.flat().every((o) => o.id === ureq.id && o.comp !== undefined)) { reactionCap(ctx, ureq.id, comps[0], target.body.capability.reaction); ctx.cap.comps = comps;
      ctx.actExtra = { undoes: target.seq, capability: ctx.actExtra.capability }; } }
  // say what came back: which act, what it was, and whether this undoes it or redoes it (Hazel: the reply named nothing)
  const req = bodyOf(target.seq)?.request ?? {}; const dz = depthOf(target.seq);
  const base = dz ? (() => { let q = target.seq; for (let i = 0; i < dz; i++) q = E[q].body?.undoes; return E[q]; })() : target;
  const breq = base ? (bodyOf(base.seq)?.request ?? {}) : req;
  const what = `${base?.verb ?? target.verb}${breq.id ? ` ${breq.id}` : ""}${breq.component ? ` ${breq.component}` : ""}${breq.label ? ` "${breq.label}"` : ""}`;
  ctx.undid = { act: target.seq, kind: dz % 2 ? "redo" : "undo", what, ...(dz ? { of: base?.seq } : {}) };
  return groups.flat();
}

// §3b / 40 §6.2: undo of an additive stroke writes head − (after − before) per touched sample, so strokes made since
// survive. If that would cross the grid's limits (clamping), it is not exact: fall back to restore-before (refused if
// changed since). Returns null to fall back.
function sculptInverse(w, ctx, target, res) {
  const before = w.stateAt(target.seq - 1), ops = [];
  // a LATER stroke that clamped on these tiles makes the inverse inexact too (40 says "at either time"; this is a third)
  const mine = new Set(opsOf(res).map((o) => `${o.id}|${o.comp}`));
  for (const e of w.entries) if (isE(e) && e.kind === "act" && e.verb === "sculpt" && e.seq > target.seq && e.body?.clamped) {
    const r = w.entries.find((x) => isE(x) && x.kind === "state" && x.cause === e.seq); if (r && opsQuiet(r).some((o) => mine.has(`${o.id}|${o.comp}`))) return null; }
  for (const o of opsOf(res)) { const g = ctx.st.entities[o.id]?.c["terrain-grid"]; if (!g || !o.comp?.startsWith("terrain-tile:") || o.verb !== "set") return null;
    const zeros = () => new Array(g.tile ** 2).fill(0); const b = before.entities[o.id]?.c[o.comp]?.mm ?? zeros(), a = o.value.mm, h = ctx.st.entities[o.id]?.c[o.comp]?.mm ?? zeros();
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity; const v = h.map((x, k) => x - (a[k] - b[k]));
    if (v.some((x) => x < lo || x > hi)) return null;
    if (v.some((x, k) => x !== h[k])) ops.push(setOp(o.id, o.comp, { mm: v })); ctx.refs.add(o.id); }
  if (!ops.length) refuse("nothing", "undoing that stroke changes nothing now", "");
  return ops;
}
// `sculpt`: one act per stroke, applied by the door to the tiles AT HEAD (never the client's copy), writing only the
// touched tiles, whole. Additive brushes commute; smooth reads its neighbours at head and may carry expect {id,
// component, at} (expect by version) to be refused instead of re-applied.
function buildSculpt(ctx, a) {
  const e = needThing(ctx, a.on); const g = e.c["terrain-grid"];
  if (!g) refuse("no-grid", `${a.on} has no terrain-grid`, "set {id, component: 'terrain-grid', value: {spacing: 0.5, tile: 32, origin: [x, z], extent: [nx, nz], limits: {raise, lower}}}");
  if (!TR.BRUSHES.includes(a.brush)) refuse("shape", `no brush '${a.brush}'`, TR.BRUSHES.join(", "), { didYouMean: guess(String(a.brush), TR.BRUSHES) });
  if (!Array.isArray(a.path) || !a.path.length || a.path.length > 256 || !a.path.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) refuse("shape", "path: [[x, z], …] (1–256 points)", "");
  if (!(a.radius > 0 && a.radius <= 64) || (TR.ADDITIVE.has(a.brush) && !(Number.isInteger(a.strength) && a.strength > 0 && a.strength <= 100000))) refuse("shape", "radius (m, ≤ 64) and strength (whole mm, > 0)", "");
  for (const x of a.expect ?? []) { const lt = lastTouch(ctx.w, x.id, x.component); const at = versionSeq(ctx.w, x.at, `expect ${x.id}.${x.component} at`);
    if (lt && lt.seq > at) refuse("stale", `${x.id}.${x.component} changed since ${at}: ${lt.actor} at ${lt.seq}`, "look again, then stroke (or send it without expect to apply at head)", { version: versionOf(ctx.w, lt.seq) }); }
  const tiles = new Map(Object.entries(e.c).filter(([k]) => k.startsWith("terrain-tile:")).map(([k, v]) => [k, v.mm]));
  const { writes, clamped } = TR.applyStroke(g, tiles, a);
  if (!writes.size) refuse("nothing", "the brush touches no sample of the grid", "check the path against terrain-grid.origin and extent");
  const bytes = [...writes.values()].reduce((t, mm) => t + jcs(mm).length + 60, 0);
  if (bytes > 1000000) refuse("too-big", `that stroke rewrites ${writes.size} tiles (about ${bytes} bytes); a log line is at most 1 MiB, and a stroke is one entry (§3b)`, "use the base (terrain) or import a raster for big changes; or use a smaller brush");
  ctx.actExtra = { tiles: writes.size, ...(clamped ? { clamped: true } : {}) }; ctx.refs.add(a.on);
  return [...writes].map(([c, mm]) => setOp(a.on, c, { mm }));
}
// ---------- blueprints ----------
const libKey = (h) => `library:${String(h).replace(/^sha256:/, "")}`;
const inLibrary = (st, h) => !!st.entities["@world"]?.c[libKey(h)];
function buildPublish(ctx, a, w) {
  const roots = Array.isArray(a.from) ? a.from : [a.from];
  for (const r of roots) if (!ctx.st.entities[r]) refuse("not-found", `no '${r}'`, "look lists what's here", { didYouMean: guess(r, Object.keys(ctx.st.entities)) });
  if (roots.length > 1) return publishGroup(ctx, a, w, roots);
  const ids = [a.from, ...descendants(ctx.st, a.from)];
  const keyOf = (id) => ctx.st.entities[id].c.blueprint?.key ?? id;
  const parts = ids.map((id) => { const c = clone(ctx.st.entities[id].c); delete c.blueprint;
    if (id === a.from) { delete c.parent; c.transform = { ...c.transform, pos: [0, 0, 0] }; }
    else if (c.parent) c.parent = { ...c.parent, to: keyOf(c.parent.to) };
    return { key: keyOf(id), components: c }; });
  const record = { name: a.name ?? a.from, root: keyOf(a.from), parts, by: ctx.actor };
  const hash = w.putBlob(record);
  ctx.notes.push({ record: hash, parts: parts.length });
  ctx.refs.add("@world");
  return [setOp("@world", libKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
function publishGroup(ctx, a, w, roots) {
  // a group of siblings: the record gets a root part at their footprint centre on the ground; the world is untouched
  const keyOf = (id) => ctx.st.entities[id].c.blueprint?.key ?? id;
  const ws = roots.map((r) => worldT(ctx.st, r).pos); const cx = ws.reduce((t, p) => t + p[0], 0) / ws.length, cz = ws.reduce((t, p) => t + p[2], 0) / ws.length;
  const all = [...new Set(roots.flatMap((r) => [r, ...descendants(ctx.st, r)]))];
  const parts = [{ key: "root", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: a.name } },
    ...all.map((id) => { const c = clone(ctx.st.entities[id].c); delete c.blueprint;
      if (roots.includes(id)) { const t = worldT(ctx.st, id); c.transform = { ...t, pos: [r3(t.pos[0] - cx), r3(t.pos[1]), r3(t.pos[2] - cz)] }; c.parent = { to: "root", order: "a0" }; }
      else c.parent = { ...c.parent, to: keyOf(c.parent.to) };
      return { key: keyOf(id), components: c }; })];
  const record = { name: a.name ?? "group", root: "root", parts, by: ctx.actor };
  const hash = w.putBlob(record); ctx.notes.push({ record: hash, parts: parts.length, roots: roots.length }); ctx.refs.add("@world");
  return [setOp("@world", libKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
// Ids for a copy's parts: minted, so they follow §2.3; which part is which lives in each part's blueprint.key.
function partIds(st, copy, rootKey, keys) {
  const map = new Map([[rootKey, copy]]); const used = new Set(Object.keys(st.entities)); used.add(copy);
  for (const k of keys) { if (map.has(k)) continue; let id = `${copy}-${slug(k)}`.slice(0, 64); let n = 2;
    while (used.has(id) || !isEntityId(id)) id = `${copy}-${slug(k)}`.slice(0, 60) + `-${n++}`; used.add(id); map.set(k, id); }
  return map;
}
// Offer a newer record to a copy: per-part, per-component, per-FIELD three-way merge (R13). base = the copy's record,
// mine = the copy now, theirs = the new record. Recorded as plain results; never re-derived on replay.
function buildUpdate(ctx, a, w) {
  const root = ctx.st.entities[a.copy]; if (!root?.c.blueprint) refuse("not-a-copy", `${a.copy} isn't a blueprint copy`, "");
  let base, theirs; try { base = w.getBlob(root.c.blueprint.from); theirs = w.getBlob(a.to); } catch { refuse("not-found", "unknown record", "find {kind: 'blueprint'}"); }
  if (!inLibrary(ctx.st, a.to)) refuse("not-in-library", `${a.to} isn't in this world's library`, "");
  const have = new Map(); for (const id of [a.copy, ...descendants(ctx.st, a.copy)]) { const k = ctx.st.entities[id].c.blueprint?.key; if (k !== undefined && !have.has(k)) have.set(k, id); }
  const fresh = partIds(ctx.st, a.copy, base.root, theirs.parts.map((p) => p.key).filter((k) => !have.has(k)));
  const idOf = (key) => (key === base.root ? a.copy : have.get(key) ?? fresh.get(key));
  const B = Object.fromEntries(base.parts.map((p) => [p.key, p.components])), T = Object.fromEntries(theirs.parts.map((p) => [p.key, p.components]));
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ops = [], conflicts = [], kept = [], orphaned = [];
  const skipComp = new Set(["blueprint", "parent"]);
  for (const key of new Set([...Object.keys(B), ...Object.keys(T)])) {
    const id = idOf(key), mineE = ctx.st.entities[id];
    if (!B[key]) { const c = clone(T[key]); if (c.parent) c.parent = { ...c.parent, to: idOf(c.parent.to) }; c.blueprint = { from: a.to, key };
      ops.push(...createOps(id, c)); continue; }
    if (!T[key]) { if (mineE && Object.keys(B[key]).every((k) => skipComp.has(k) || eq(B[key][k], mineE.c[k]))) ops.push(delOp(id)); else if (mineE) orphaned.push(id); continue; }
    if (!mineE) { kept.push({ id, why: "you deleted it in this copy" }); continue; }
    for (const comp of new Set([...Object.keys(B[key]), ...Object.keys(T[key])])) {
      if (skipComp.has(comp) || (key === base.root && comp === "transform")) continue;
      const b = B[key][comp], t = T[key][comp], m = mineE.c[comp];
      if (eq(b, t)) continue; // nothing new upstream
      if (eq(m, b)) { ops.push(t === undefined ? delOp(id, comp) : setOp(id, comp, t)); continue; }
      if (eq(m, t)) continue;
      const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
      if (isObj(b) && isObj(t) && isObj(m)) { // field level
        const out = clone(m); const clash = [];
        for (const f of new Set([...Object.keys(b), ...Object.keys(t)])) { if (eq(b[f], t[f])) continue; if (eq(m[f], b[f])) { if (t[f] === undefined) delete out[f]; else out[f] = clone(t[f]); } else if (!eq(m[f], t[f])) clash.push(f); }
        if (clash.length) conflicts.push({ id, component: comp, fields: clash, yours: Object.fromEntries(clash.map((f) => [f, m[f]])), theirs: Object.fromEntries(clash.map((f) => [f, t[f]])) });
        if (!eq(out, m)) ops.push(setOp(id, comp, out)); else if (!clash.length) kept.push({ id, component: comp });
      } else conflicts.push({ id, component: comp, yours: m, theirs: t });
    }
  }
  if (conflicts.length && !a.resolve) refuse("conflicts", `${conflicts.length} part(s) changed both here and upstream`, "re-send with resolve: {\"<id>.<component>.<field>\": \"yours\"|\"theirs\"} or dry: true to see the merge", { conflicts });
  for (const c of conflicts) { const id = c.id; for (const f of c.fields ?? [null]) { const choice = a.resolve?.[f ? `${id}.${c.component}.${f}` : `${id}.${c.component}`] ?? "yours";
      if (choice === "theirs") { const cur = ops.findLast((o) => o.id === id && o.comp === c.component)?.value ?? clone(ctx.st.entities[id].c[c.component]);
        const v = f ? { ...cur, [f]: c.theirs[f] } : c.theirs; ops.push(setOp(id, c.component, v)); } } }
  ops.push(setOp(a.copy, "blueprint", { ...root.c.blueprint, from: a.to }));
  if (orphaned.length) ctx.notes.push({ orphaned, why: "gone upstream but you changed them here: kept, still yours" });
  if (kept.length) ctx.notes.push({ keptYours: kept });
  for (const o of ops) ctx.refs.add(o.id);
  return ops;
}
// L1: a copy is expanded by the door into an explicit batch. The fold never reads the record.
function buildCreateFrom(ctx, a) {
  if (typeof a.from === "string" && !a.from.startsWith("sha256:")) return buildDuplicate(ctx, a);
  const w = ctx.w; let rec;
  try { rec = w.getBlob(a.from); } catch { refuse("not-found", `no blueprint ${a.from}`, "find {kind: 'blueprint'} lists this world's library"); }
  if (!inLibrary(ctx.st, a.from)) refuse("not-in-library", `${a.from} isn't in this world's library`, "publish it here first");
  const id = a.id ?? mint(ctx.st, rec.name);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§2.3: a–z, 0–9 and '-', up to 64; or leave id out");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(ctx.st, id, rec.root, rec.parts.map((p) => p.key));
  const ops = [];
  for (const p of rec.parts) { const c = clone(p.components);
    if (p.key === rec.root) c.transform = resolve(ctx, id, "transform", { ...c.transform, ...(a.at ?? {}) });
    if (c.parent) c.parent = { ...c.parent, to: ids.get(c.parent.to) };
    c.blueprint = { from: a.from, key: p.key };
    ops.push(...createOps(ids.get(p.key), c)); ctx.refs.add(ids.get(p.key)); }
  return ops;
}

// Duplicate (slice 3b; PARITY (b)3): create {from: <a live thing's id>} copies it and everything attached to it, as one
// explicit batch (L1: the fold sees plain creates). The copy keeps the source's parent (a sibling of it), so its
// transform stays local to that parent; `at` replaces fields of the root's transform (local to that parent too), and
// without it the copy sits 0.5 m along x from the source, as v1's duplicate did. `lock` isn't copied (v1 didn't
// either: a copy is something you're about to move). Who made the copy is the create entry's actor (a view, L2).
function buildDuplicate(ctx, a) {
  const st = ctx.st, src = a.from;
  if (src === "@world" || !st.entities[src]) refuse("not-found", `no thing called '${src}' to copy`, "from takes a blueprint hash (sha256:…) or the id of a thing here", { didYouMean: guess(String(src), Object.keys(st.entities)) });
  const all = [src, ...descendants(st, src)];
  const sc = st.entities[src].c;
  const id = a.id ?? mint(st, typeof sc.label === "string" ? sc.label : typeof sc.model === "string" ? sc.model.split("/").pop().replace(/\.[a-z0-9]+$/i, "") : src);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§2.3: a–z, 0–9 and '-', up to 64; or leave id out");
  if (st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(st, id, src, all);
  const ops = []; let locks = 0;
  for (const sid of all) { const orig = st.entities[sid].c; const c = clone(orig);
    if ("lock" in c) { delete c.lock; locks++; }
    for (const k of Object.keys(orig)) if (orig[k] === PURGED) delete c[k]; // a purged value can't be copied
    if (c.parent && typeof c.parent.to === "string") c.parent = { ...c.parent, to: ids.get(c.parent.to) ?? c.parent.to };
    if (sid === src) { const t = { ...COMPONENTS.transform.defaults, ...(c.transform ?? {}) };
      c.transform = resolve(ctx, id, "transform", a.at ?? { pos: [t.pos[0] + 0.5, t.pos[1], t.pos[2]] }, t); }
    ops.push(...createOps(ids.get(sid), c)); ctx.refs.add(ids.get(sid)); }
  ctx.notes.push({ copied: src, as: id, parts: all.length, ...(locks ? { why: "a lock isn't copied: the copy is free to move" } : {}) });
  return ops;
}

// ---------- reads ----------
function describe(st, id, live = {}, holds = {}) {
  const e = st.entities[id]; const t = worldT(st, id); const g = grabOf(e.c); const name = e.c.label ?? modelOf(e.c.model)?.label ?? e.c.model ?? id;
  return { id, name, at: t.pos.map((n) => Math.round(n * 100) / 100),
    ...(live[id] ? { moving: live[id] } : {}), ...(holds[id] ? { heldBy: holds[id].by, heldAt: holds[id].pose.pos.map((n) => Math.round(n * 100) / 100), ...(holds[id].hand ? { heldIn: holds[id].hand } : {}) } : {}),
    ...(g ? { grab: describeGrab(g, typeof name === "string" ? name : id) } : {}),
    ...(actionsOf(st, id).length ? { actions: actionsOf(st, id) } : {}), ...(e.c.parent ? { in: e.c.parent.to } : {}), ...(lockedC(e.c) ? { lock: true } : {}), ...(e.c.door && typeof e.c.door === "object" ? { door: e.c.door } : {}) };
}

// ---------- physics (design 20) ----------
const REACH = 1.5;   // m from your body: arm plus a step
const HAND_Y = 1.1; // where a held thing sits above your feet
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const handOf = (me) => [me.at[0], me.at[1] + HAND_Y, me.at[2]]; // reach is measured from the hand, not the feet
// P5 + L3: the sequencer logs where unheld motion came to rest. The rest is the engine's value and nothing else: its
// cause is the launch, it goes through admit like every write, and admit checks it against the engine. The engine
// digest is its own `sim` entry. Whatever the door then does about it (attach it to what it rests on, return a thing
// that left the world) is a SEPARATE entry caused by a door act, so a rest and a correction never look alike.
function settleSim(w) {
  const skip = new Set(); w.unsettled = [];
  if (!w.state().entities["@world"]?.c.sim) return; // no engine: nothing in flight (an epoch cut logs every rest first, P6)
  for (let guard = 0; guard < 64; guard++) {
    const sf = w.sim(); const r = sf.rested.find((x) => !skip.has(`${x.id}@${x.seq}`)); if (!r) return;
    const st = w.state(); const t = worldT(st, r.id);
    const ops = [...(st.entities[r.id].c.parent ? [delOp(r.id, "parent")] : []), setOp(r.id, "transform", { pos: r.p.slice(), q: t.q, scale: t.scale })];
    let plan; try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: [r.id], comps: ["transform", "parent"], launch: r.seq } }, ops); }
    catch (e) { if (!(e instanceof Refusal)) throw e; w.unsettled.push({ id: r.id, launch: r.seq, refused: e.code, reason: e.reason }); skip.add(`${r.id}@${r.seq}`); continue; } // 33 F2: one refused rest must never stall every later one
    w.append({ kind: "sim", actor: "sim", cause: r.seq, verb: "digest", body: { digest: digestOf(sf.sim) } });
    const rest = stateEntry(w, plan, r.seq);
    const st2 = w.state(); const B = boundsOf(st2);
    if (B && (r.p[0] < B.min[0] || r.p[0] > B.max[0] || r.p[2] < B.min[2] || r.p[2] > B.max[2])) {
      // it landed outside the world: lost. The door returns it to where it was picked up, as its own act.
      const old = st.entities[r.id].c; const back = [setOp(r.id, "transform", old.transform), ...(old.parent ? [setOp(r.id, "parent", old.parent)] : [])];
      const p2 = admit(w, st2, { actor: "door", cap: { kind: "door", ids: [r.id], comps: ["transform", "parent"] } }, back);
      stateEntry(w, p2, w.append(actEntry(w, "door", "return-lost", { id: r.id, rest })));
      continue;
    }
    // it rests ON something: name that as its parent, as place does, so it rides with it (the relation is the door's word)
    const fam = new Set([r.id, ...descendants(st2, r.id)]); const sup = supportBelow(st2, r.p[0], r.p[2], r.p[1] + 0.02, fam);
    if (sup.id === "ground") continue;
    const wt = worldT(st2, r.id); const s3 = scratch(st2, [setOp(r.id, "parent", { to: sup.id })]);
    const attach = [setOp(r.id, "parent", { to: sup.id, order: "a0" }), setOp(r.id, "transform", localFrom(s3, sup.id, wt))];
    const p3 = admit(w, st2, { actor: "door", cap: { kind: "door", ids: [r.id], comps: ["transform", "parent"] } }, attach);
    stateEntry(w, p3, w.append(actEntry(w, "door", "settle", { id: r.id, onto: sup.id, rest })));
  }
}
// P6: an engine change is a real cut. At rest the cut is free (the log already holds every result); in flight it waits.
function buildEpoch(ctx, v, a) {
  const sf = ctx.w.sim(); const live = [...new Set([...Object.keys(livePoses(sf)), ...sf.rested.map((r) => r.id)])]; // at rest but not on the record counts (33 F2): P6's "free" needs every result logged
  if (live.length && !a.force) refuse("busy", `${live.length} thing(s) are still in flight or not yet on the record (${live.join(", ")}); all at rest in about ${r3((restEta(sf) ?? 0) / 1000)} s`, "try again then, or force: true to freeze them where they are now (they'll be logged there)");
  const ops = live.map((id) => setOp(id, "transform", { ...worldT(sf.st, id), pos: sf.sim.bodies[id].p.slice() }));
  for (const id of live) ctx.refs.add(id);
  if (live.length) ctx.notes.push({ frozen: live, why: "forced cut: stopped mid-air and logged where they were" });
  if (v === null) return [...ops, delOp("@world", "sim")];
  if (!v || typeof v.engine !== "string") refuse("shape", "sim needs {engine, tickMs?}", `engines this server carries: ${Object.keys(ENGINES).join(", ")}`);
  unknownKeys("@world.sim", v, Object.keys(COMPONENTS.sim.fields), "sim"); // the door builds the value from these keys: a typo would vanish silently
  const known = ENGINES[v.engine];
  const spec = { engine: v.engine, build: v.build ?? known?.build ?? null, tickMs: Number.isInteger(v.tickMs) ? v.tickMs : 33 };
  if (!known) refuse("unknown-engine", `this server doesn't carry '${v.engine}'`, `it carries: ${Object.keys(ENGINES).join(", ")}`, { didYouMean: guess(v.engine, Object.keys(ENGINES)) });
  if (v.build === undefined) ctx.notes.push({ component: "sim", field: "build", kept: spec.build, why: "stamped: determinism belongs to one exact build, so the epoch names it" });
  if (!carried(spec)) ctx.notes.push({ component: "sim", why: "that build isn't carried here: nothing will be thrown in this world until a server that carries it runs it" });
  ctx.refs.add("@world");
  return [...ops, setOp("@world", "sim", spec)];
}
function body(w, actor) {
  const b = w.presence.bodies[actor];
  if (!b) refuse("not-here", "your body isn't in the world yet", "move {to: [x, y, z]} puts it somewhere (bodies are presence: never logged)");
  return b;
}
function holdOf(w, actor, id) {
  const h = w.presence.holds[id];
  if (!h || h.by !== actor) refuse("not-holding", `you aren't holding ${id}${h ? ` (${said(h.by)} is)` : ""}`, `grab {id: '${id}'} first`);
  if (!w.state().entities[id]) { delete w.presence.holds[id]; w.savePresence(); refuse("gone", `${id} was deleted while you held it`, "your hand is empty now"); }
  return h;
}
// L6 / 25d M3: the door's own plausibility TRACK of each body (presence: unlogged). A body is where the door last
// ACCEPTED it, never where a client last claimed. Walking spends a token bucket (SPEED m/s sustained, CAP m of
// burst) and may not enter a solid a body can't step over; a refused step leaves the body where it was (reverted for
// its sender, visibly). Arriving, or `teleport: true`, is a teleport: an ACT on the record (it resets the track), refused
// while holding anything, refused inside a solid, and (for visitors) refused away from @world.spawn when the world
// declares one. Every settlement (grab, put, throw) measures reach from the track and records the presence it used.
const TRACK = { speed: 6, cap: 4, step: 0.8, radius: 0.2, height: 1.7, spawnR: 2 };
function bodyBox(p) { return { min: [p[0] - TRACK.radius, p[1] + TRACK.step, p[2] - TRACK.radius], max: [p[0] + TRACK.radius, p[1] + TRACK.height, p[2] + TRACK.radius] }; }
function solidAt(w, st, p, except = new Set()) {
  const box = bodyBox(p); const held = new Set(Object.keys(w.presence.holds));
  for (const id of Object.keys(st.entities)) { if (id === "@world" || held.has(id) || except.has(id) || !geomOf(st.entities[id].c.model)) continue; if (hits(box, st, id, 0.01)) return id; }
  return null;
}
function pathBlocked(w, st, from, to) {
  const already = new Set(); const b0 = bodyBox(from); // a body already inside something may walk out of it
  for (const id of Object.keys(st.entities)) if (geomOf(st.entities[id].c.model) && hits(b0, st, id, 0.01)) already.add(id);
  const n = Math.max(1, Math.ceil(dist(from, to) / 0.05));
  for (let k = 1; k <= n; k++) { const p = from.map((v, i) => v + (to[i] - v) * k / n); const hit = solidAt(w, st, p, already); if (hit) return hit; }
  return null;
}
const presenceFacts = (me) => ({ at: me.at.slice(), hand: handOf(me).map(r3), trackTs: me.ts });
const PHYSICS_TOOLS = {
  move(w, actor, a) {
    if (!Array.isArray(a.to) || a.to.length !== 3 || a.to.some((n) => !Number.isFinite(n))) refuse("shape", "move needs to: [x, y, z]", "");
    const st = w.state(); const B = boundsOf(st);
    if (B && (a.to[0] < B.min[0] || a.to[0] > B.max[0] || a.to[2] < B.min[2] || a.to[2] > B.max[2])) refuse("out-of-bounds", `[${a.to.join(", ")}] is outside this world (x ${B.min[0]}…${B.max[0]}, z ${B.min[2]}…${B.max[2]})`, "pick a spot inside the bounds");
    const me = w.presence.bodies[actor]; const now = w.now(); const to = a.to.slice();
    if (!me || a.teleport === true) { // a teleport (arriving is one): an act, so the track's reset is on the record
      const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
      if (mine.length) refuse("holding", `you're holding ${mine.join(", ")}; a teleport can't carry things`, "put it down (or walk it there) first", { at: me?.at });
      const inSolid = solidAt(w, st, to); if (inSolid) refuse("solid", `[${to.join(", ")}] is inside ${inSolid}`, "arrive somewhere a body fits", { at: me?.at });
      const sp = st.entities["@world"]?.c.spawn;
      if (sp && Array.isArray(sp.pos) && RANK[roleOf(st, actor)] < RANK.builder && dist(sp.pos, to) > (sp.radius ?? TRACK.spawnR))
        refuse("spawn", `this world's arrivals are within ${sp.radius ?? TRACK.spawnR} m of [${sp.pos.join(", ")}]`, "arrive there, then walk", { at: me?.at });
      rateCheck(w, actor);
      const act = w.append(actOf(w, actor, "move", a, { presence: { from: me?.at ?? null, to, arrival: !me } }));
      w.presence.bodies[actor] = { at: to, ts: now, tokens: TRACK.cap, ...(a.client ? { client: String(a.client) } : {}) }; w.savePresence();
      return { ok: true, recorded: true, act, at: to };
    }
    const d = dist(me.at, to); const tokens = Math.min(TRACK.cap, (me.tokens ?? TRACK.cap) + TRACK.speed * Math.max(0, now - (me.ts ?? now)) / 1000);
    if (d > tokens + 1e-9) refuse("too-fast", `that's ${r3(d)} m; right now your body can cover ${r3(tokens)} m (${TRACK.speed} m/s, ${TRACK.cap} m at most in one go)`, "walk there in steps, or move {to, teleport: true} (an act on the record; not while holding anything)", { at: me.at });
    const block = pathBlocked(w, st, me.at, to);
    if (block) refuse("solid", `${block} is in the way`, "walk around it (or through a door someone opens)", { at: me.at });
    const prev = me.at; w.presence.bodies[actor] = { ...me, at: to, ts: now, tokens: tokens - d };
    const carrying = [];
    for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === actor) { h.pose.pos = h.pose.pos.map((n, i) => n + to[i] - prev[i]); carrying.push(id); }
    w.savePresence();
    return { ok: true, recorded: false, at: to, ...(carrying.length ? { carrying } : {}) };
  },
  grab(w, actor, a) {
    if (typeof a.id === "string" && a.id.startsWith("body:")) return BODY_TOOLS.body(w, actor, { to: a.id, act: "drag" }); // a body is presence, never an entity (§2.3)
    const me = body(w, actor); const sf = w.sim(); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    const held = w.presence.holds[a.id];
    if (a.hand !== undefined && !["left", "right"].includes(a.hand)) refuse("shape", "hand is left or right", "");
    if (a.offset !== undefined && !offsetOk(a.offset)) refuse("shape", "offset is {pos: [x, y, z] (within 2 m), q: [x, y, z, w]}: where it sits in your hand", "a VR hand sends where it took hold");
    if (held?.by === actor) return secondHand(w, actor, a, held, e);
    // grabOf (shared/grab.js) is the one reader: grabbable, or a dynamic thing's physics.who (the migration fallback)
    const g = grabOf(e.c);
    if (!g) refuse("not-grabbable", `${a.id} isn't something you can pick up`, `a builder can make it so: set {id: '${a.id}', component: 'grabbable', value: {who: 'visitor'}} (anyone may; {} for builders only)`);
    if (!g.enabled) refuse("not-grabbable", `${a.id} can't be picked up now (its grabbable.enabled is false)`, "a builder can turn it back on: set {id, component: 'grabbable', value: {…, enabled: true}}");
    const need = g.who; const role = roleOf(st, actor); if (RANK[role] < RANK[need]) refuse("rights", `only a ${need} may pick up ${a.id}`, `ask someone who can, or ask the owner to set ${g.source}.who: 'visitor'`);
    if (held && !g.steal && RANK[role] < RANK.owner) refuse("held", `${said(held.by)} is holding ${a.id}, and it can't be taken from a hand (grabbable.steal is false)`, "wait till they let go (an owner may take it)");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be picked up`, `a builder or owner can unlock it first: delete {id: '${k}', component: 'lock'}`, { lock: k });
    const live = livePoses(sf)[a.id]; const t = worldT(st, a.id); const here = held ? held.pose.pos : live ? live.pos : t.pos; // where it IS: someone's hand, the air, or the log
    // range (grabbable): from the hand; past arm's reach the door grants it as a pull (the thing flies to the hand: a
    // presence ease on every client), never a hold at a distance (the reach check is the anti-cheat)
    const d = dist(handOf(me), here); if (d > g.range) refuse("out-of-reach", `${a.id} is ${r3(d)} m from you; you can reach ${g.range} m`, `move {to: [${r3(here[0])}, ${me.at[1]}, ${r3(here[2])}]} (your feet stay on the floor; your hand reaches ${HAND_Y} m up) first`);
    const how = holdHow(a, g); // which hand, by which grip or offset: refused before anything is written
    const prev = w.presence.holds[a.id]; const notes = [];
    if (d > REACH) notes.push({ id: a.id, pulled: r3(d), why: `it was ${r3(d)} m away; its grabbable.range lets it fly to your hand` });
    if (prev && prev.by !== actor) notes.push({ id: a.id, takenFrom: prev.by, why: "the latest grab wins; they were told" });
    // what rested on it (and isn't its child, which rides along) loses its support (playtest 22, F3)
    const fam = new Set([a.id, ...descendants(st, a.id)]);
    const dependents = live ? [] : Object.keys(st.entities).filter((k) => { if (fam.has(k)) return false; const b = aabb(st, k);
      return b && !st.entities[k].c.parent && supportUnder(st, b, new Set([k, ...descendants(st, k)])).id === a.id; });
    for (const k of dependents) { const gk = grabOf(st.entities[k].c);
      const lockK = [k, ...ancestors(st, k)].find((x) => lockedC(st.entities[x]?.c)); if (lockK) refuse("locked", `${k} rests on ${a.id}, and ${lockK === k ? "it" : lockK} is locked, so picking ${a.id} up would move it`, `take ${k} off first, or unlock ${lockK} (delete {id: '${lockK}', component: 'lock'})`, { lock: lockK });
      if (RANK[role] < RANK.builder && !(gk && gk.enabled && RANK[role] >= RANK[gk.who])) refuse("rights", `${k} rests on ${a.id}, and you can't move ${k}`, "picking it up would move what's on it; ask someone who can to take it off first"); }
    const spec = st.entities["@world"]?.c.sim;
    // without physics, dependents are set straight down: a write, so it is admitted first (all or nothing)
    let plan = null;
    if (dependents.length && !(spec && carried(spec))) {
      const ops = dependents.map((k) => { const b = aabb(st, k); const below = supportUnder(st, b, new Set([k, ...fam, ...descendants(st, k)])); const tk = worldT(st, k);
        return setOp(k, "transform", { ...tk, pos: [tk.pos[0], r3(tk.pos[1] - (b.min[1] - below.y)), tk.pos[2]] }); });
      plan = admit(w, st, { actor, cap: { kind: "door", ids: dependents, comps: ["transform"] } }, ops);
    }
    // picking a thing up takes it out of the world's physics (no collider left at its old spot), and that changes the
    // sim, so it goes through the log (Covenant III: presence never feeds the sim otherwise)
    let act = null;
    if ((spec && carried(spec)) || dependents.length) rateCheck(w, actor); // this grab will be logged
    const actOnce = () => (act ??= w.append(actOf(w, actor, "grab", a, { presence: presenceFacts(me) })));
    if (spec && carried(spec)) { w.append({ kind: "sim", actor, cause: actOnce(), verb: live ? "catch" : "lift", body: { id: a.id } });
      if (live) notes.push({ id: a.id, why: "caught it in the air (logged: the sim had it)" }); }
    if (dependents.length) {
      if (spec && carried(spec)) {
        for (const k of dependents) w.append({ kind: "sim", actor, cause: actOnce(), verb: "launch", body: { id: k, p: worldT(st, k).pos.slice(), yaw: qYaw(worldT(st, k).q), v: [0, 0, 0], handled: [actor] } });
        notes.push({ fell: dependents, why: `they were resting on ${a.id}; picking it up let them fall (physics will log where they land)` });
      } else {
        stateEntry(w, plan, actOnce());
        notes.push({ setDown: dependents, why: `they were resting on ${a.id}; with no physics running they were set straight down` });
      }
    }
    const handled = [...new Set([...(prev?.handled ?? []), actor])];
    const hand = handOf(me); // in your hand now (a VR client would send the hand's pose)
    w.presence.holds[a.id] = { by: actor, since: w.now(), pose: { pos: hand, q: t.q, scale: t.scale }, handled, ...how };
    w.savePresence();
    heldEvent(w, "grab", a.id, { by: actor, hand: how.hand, ...(how.grip ? { grip: how.grip } : {}), ...(act !== null ? { seq: act } : {}) });
    return { ok: true, recorded: act !== null, holding: a.id, inHandAt: hand.map(r3), ...how, ...(notes.length ? { notes } : {}) };
  },
  // P3: putting something down is a settlement: a claim the door checks like any write, then logs as a plain result.
  // grabbable says where it goes (research §3): home (release: return), into a socket that accepts it (fits), where
  // the hand let go (release: stay), or straight down onto what's below (drop, the default).
  put(w, actor, a, how = "put") {
    const me = body(w, actor); const h = holdOf(w, actor, a.id);
    const st = w.state(); const t = worldT(st, a.id); const g = grabOf(st.entities[a.id].c);
    const facts = () => ({ handled: h.handled, presence: { ...presenceFacts(me), held: h.pose.pos.map(r3) } });
    // review 10-06: the claim is checked before anything acts on it: a pos is [x, y, z] within reach (a far or malformed
    // pos snapped into a socket across the world), and the holder's rank NOW still covers carrying it (the return and the
    // snap are the holder's settlements too, as a plain put is)
    if (a.pos !== undefined) { if (!Array.isArray(a.pos) || a.pos.length !== 3 || a.pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
      const d0 = dist(handOf(me), a.pos); if (d0 > REACH) refuse("out-of-reach", `that's ${r3(d0)} m from you; you can reach ${REACH} m`, "move closer first"); }
    { const role = roleOf(st, actor); if (g && RANK[role] < RANK[g.who]) refuse("rights", `only a ${g.who} may move ${a.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
    // home: the holder's act, then the door's return (its own act, caused by the release)
    if (g?.release === "return" && g.home) {
      const ret = returnPlan(w, st, a.id, g);
      if (ret.plan) { rateCheck(w, actor); const act = w.append(actOf(w, actor, "put", a, { ...facts(), release: "return" }));
        const back = returnHome(w, a.id, ret.plan, act); delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: "return", seq: act });
        return { ok: true, act, seq: back.seq, settled: { id: a.id, home: g.home }, handled: h.handled, release: "return", notes: [{ id: a.id, why: "its grabbable.release is return: it went home" }] }; }
    }
    // a socket that accepts it, within that socket's radius of where it's let go (Resonite Snapper, XRI Socket)
    const snap = snapTarget(st, a.id, g, a.pos ?? h.pose.pos);
    if (snap.to) {
      const hs = worldT(st, snap.to.to).scale;
      const ops = [setOp(a.id, "parent", { to: snap.to.to, slot: snap.to.slot, order: "a0" }), setOp(a.id, "transform", { pos: snap.to.sock.pos.slice(), q: socketQ(snap.to.sock).map(r3), scale: t.scale.map((v, i) => r3(v / hs[i])) })];
      const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
      const act = w.append(actOf(w, actor, "put", a, { ...facts(), release: "snap", slot: { to: snap.to.to, slot: snap.to.slot } }));
      const seq = stateEntry(w, plan, act); delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: "snap", to: snap.to.to, slot: snap.to.slot, seq: act });
      return { ok: true, seq, act, settled: { id: a.id, in: snap.to.to, slot: snap.to.slot }, handled: h.handled, release: "snap", notes: [{ id: a.id, snapped: { to: snap.to.to, slot: snap.to.slot }, why: `it fits ${snap.to.to}'s ${snap.to.slot} socket (accepts ${snap.to.sock.accepts.join(", ")})` }, ...snap.notes] };
    }
    // stay: where the hand let go (a put with no pos), and never called floating (the builder said it hangs there)
    const stay = g?.release === "stay";
    let pos = a.pos;
    if (pos === undefined && stay) pos = h.pose.pos.map(r3);
    if (pos === undefined) { // no pose given: straight down from where it's held, onto what's below (the door resolves)
      const fam = new Set([a.id, ...descendants(st, a.id)]); const sup = supportBelow(st, h.pose.pos[0], h.pose.pos[2], h.pose.pos[1], fam);
      pos = [r3(h.pose.pos[0]), sup.y, r3(h.pose.pos[2])]; }
    if (!Array.isArray(pos) || pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
    const d = dist(handOf(me), pos); if (d > REACH) refuse("out-of-reach", `that's ${r3(d)} m from you; you can reach ${REACH} m`, "move closer first");
    const q = a.q ?? h.pose.q; const value = { pos, q, scale: t.scale };
    const ops = [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", value)];
    // the one gate first (your role and its locks NOW, not when you picked it up), then the physical claim on top
    const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
    const bad = warnings(plan.after, [a.id]).filter((x) => !(stay && (x.kind === "floating" || x.kind === "sunk")));
    if (bad.length) refuse("implausible", `physics wouldn't leave ${a.id} there: ${bad.map((b) => b.kind + (b.with ? ` ${b.with}` : b.above ? ` above ${b.above}` : b.into ? ` into ${b.into}` : "")).join("; ")}`, "a settlement is a claim the door checks; put it where it would really rest, or leave pos out to set it straight down", { problems: bad });
    const act = w.append(actOf(w, actor, "put", a, { ...facts(), ...(stay ? { release: "stay" } : {}) }));
    const seq = stateEntry(w, plan, act);
    delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: stay ? "stay" : how, seq: act });
    return { ok: true, seq, act, settled: { id: a.id, pos }, handled: h.handled, ...(stay ? { release: "stay" } : {}), ...(snap.notes.length ? { notes: snap.notes } : {}) };
  },
  // research §Decisions 1: what flies is a dynamic thing in a world that runs physics. Anything else let go is set
  // straight down, and a throw of it is a drop that says so: a VR hand lets go with its velocity whatever the world is
  // (v4phys.release sends throw when the hand moves), and refusing it left the thing stuck in the hand.
  // grabbable.throw scales the velocity (0: it can only be dropped); release: return sends it home instead of flying.
  throw(w, actor, a) {
    if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "throw needs v: [x, y, z] in m/s", "e.g. v: [0, 3, 4] tosses it up and forward (+z)");
    const g = grabOf(w.state().entities[a.id]?.c);
    const why = !fliesIn(w.state(), a.id) ? (w.state().entities["@world"]?.c.sim ? `${a.id} isn't physics {kind: 'dynamic'}, so it doesn't fly: it was set down` : "this world doesn't run physics, so it was set down")
      : g?.throw === 0 ? `${a.id} can't be thrown (its grabbable.throw is 0): it was let go` : g?.release === "return" ? null : undefined;
    if (why !== undefined) {
      const r = PHYSICS_TOOLS.drop(w, actor, { id: a.id, ...(a.pos !== undefined ? { pos: a.pos } : {}) }, "throw");
      return r.ok && why ? { ...r, notes: [...(r.notes ?? []), { id: a.id, thrown: "set down", why }] } : r;
    }
    return launch(w, actor, a, "throw", g);
  },
  drop(w, actor, a, how = "drop") {
    if (a.hand !== undefined) { const h = holdOf(w, actor, a.id); if (!["left", "right"].includes(a.hand)) refuse("shape", "hand is left or right", "");
      if (h.second && (a.hand === h.second.hand || a.hand === h.hand)) { // one hand of two lets go: the other keeps it (presence, unlogged)
        if (a.hand === h.hand) { h.hand = h.second.hand; delete h.offset; if (h.second.grip) h.grip = h.second.grip; else delete h.grip; }
        delete h.second; w.savePresence(); return { ok: true, recorded: false, holding: a.id, hand: h.hand, note: `your ${a.hand} hand let go; your ${h.hand} hand still holds it` }; }
      if (a.hand !== h.hand) refuse("not-holding", `your ${a.hand} hand isn't holding ${a.id} (your ${h.hand} hand is)`, `drop {id: '${a.id}'} lets go`); }
    const st = w.state(); const g = grabOf(st.entities[a.id]?.c);
    // what doesn't fly is set down from where the hand let go; so is what goes home, into a socket, or stays
    const sets = !fliesIn(st, a.id) || g?.release === "return" || g?.release === "stay" || (g && w.presence.holds[a.id]?.by === actor && snapTarget(st, a.id, g, a.pos ?? w.presence.holds[a.id].pose.pos).to);
    if (sets) {
      if (a.pos !== undefined) { const me = body(w, actor); const h = holdOf(w, actor, a.id); h.pose.pos = releasePos(me, a.pos); }
      return PHYSICS_TOOLS.put(w, actor, { id: a.id }, how); }
    return launch(w, actor, { ...a, v: [0, 0, 0] }, "drop", g);
  },
  // the kick physobj offered (/punt, an agent's world_verb punt), as a sim intent (design 20, P4: "punt is a sim intent
  // too"). A thing at your feet (or in the air beside you: a volley) is launched with v, or with power along the line from
  // your feet through it, lifted (physobj's 0.9 ratio: a knee-high hop at power 4). Its gates are grab's: dynamic,
  // physics.who, its locks and its ancestors', and nobody's hand. A thing in flight is caught and re-launched (logged).
  punt(w, actor, a) {
    const me = body(w, actor); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    const spec = flyingWorld(st);
    const ph = e.c.physics;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${a.id} isn't something you can punt`, `a builder can make it so: set {id: '${a.id}', component: 'physics', value: {kind: 'dynamic'}}`);
    const need = ph.who ?? "builder"; if (RANK[roleOf(st, actor)] < RANK[need]) refuse("rights", `only a ${need} may punt ${a.id}`, "ask the owner to set physics.who: 'visitor'");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be punted`, `a builder or owner can unlock it first: delete {id: '${k}', component: 'lock'}`, { lock: k });
    const held = w.presence.holds[a.id]; if (held) refuse("held", `${said(held.by)} is holding ${a.id}`, "grab it to take it (the latest grab wins), or wait till they let go");
    shaped(e, a.id);
    if (a.v !== undefined && a.power !== undefined) refuse("shape", "punt takes v or power, not both", "v: [x, y, z] in m/s, or power (m/s) along the line from your feet through it");
    const sf = w.sim(); const b = sf.sim?.bodies[a.id]; const flying = !!(sf.launched[a.id] && b && !b.resting);
    const t = worldT(st, a.id); const here = flying ? b.p : t.pos;
    const dx = here[0] - me.at[0], dz = here[2] - me.at[2], dh = Math.hypot(dx, dz), dy = here[1] - me.at[1];
    if (dh > KICK.reach || dy < KICK.below || dy > KICK.above) refuse("out-of-reach", `${a.id} is ${r3(dh)} m from your feet${dy > KICK.above ? `, ${r3(dy)} m up` : ""}; a punt reaches ${KICK.reach} m`, `move {to: [${r3(here[0] - (dh > 1e-6 ? dx / dh : 0) * 0.5)}, ${me.at[1]}, ${r3(here[2] - (dh > 1e-6 ? dz / dh : 1) * 0.5)}]} first`);
    let v;
    if (a.v !== undefined) { if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "punt's v is [x, y, z] in m/s", "e.g. v: [0, 2, 4]"); v = a.v.slice(); }
    else { const p = a.power ?? 4; if (!Number.isFinite(p) || p <= 0) refuse("shape", "power is a speed in m/s, above 0", "e.g. power: 4 (a hop), 10 (hard)");
      const fx = dh > 1e-6 ? dx / dh : 0, fz = dh > 1e-6 ? dz / dh : 1; const n = Math.hypot(fx, KICK.lift, fz); v = [fx / n * p, KICK.lift / n * p, fz / n * p]; }
    const notes = []; const max = ENGINES[spec.engine].maxSpeed; const sp = Math.hypot(...v);
    if (sp > max) { const sent = v; v = v.map((n) => n * max / sp); notes.push({ field: "v", sent, kept: v.map(r3), why: `capped at ${max} m/s` }); }
    // L7 (33 F3): the write it decides (its rest), admitted now as a launch's is: rights, locks, rate. A thing in the air
    // is the engine's (L6: no write may touch it in flight), so for a volley the gates above are the whole check.
    if (!flying) admit(w, st, { actor, cap: { kind: "handle", via: "punt", ids: [a.id], comps: ["transform", "parent"] } }, [...(e.c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: t.pos.map(r3), q: t.q, scale: t.scale })]);
    else rateCheck(w, actor);
    const act = w.append(actOf(w, actor, "punt", a, { presence: presenceFacts(me), ...(flying ? { volley: true } : {}) }));
    if (flying) w.append({ kind: "sim", actor, cause: act, verb: "catch", body: { id: a.id } });
    const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: here.map(noNeg0), yaw: flying ? noNeg0(b.yaw) : qYaw(t.q), v: v.map(noNeg0), handled: [actor] } });
    return { ok: true, seq, act, flying: a.id, from: here.map(r3), v: v.map(r3), ...(flying ? { volley: true } : {}), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
  },
  // a holder who leaves: what they held is dropped (into the sim if there is one), attributed to them (orphans, 18a)
  leave(w, actor) {
    const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
    w.leaving = actor; let out; try { out = mine.map((id) => ({ id, r: request(w, actor, "drop", { id }) })); } finally { w.leaving = null; }
    // L6: a disconnect settles at the last ACCEPTED state. A drop the gate refused (demoted, locked) leaves the thing
    // where the log last had it; if picking it up took it out of the engine, the door puts it back there, as its own act.
    for (const { id, r } of out) if (!r.ok && w.presence.holds[id]?.by === actor) { delete w.presence.holds[id];
      const st = w.state(); if (st.entities[id] && st.entities["@world"]?.c.sim) { const t = st.entities[id].c.transform;
        if (t) { const p = admit(w, st, { actor: "door", cap: { kind: "door", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]);
          stateEntry(w, p, w.append(actEntry(w, "door", "return-held", { id, holder: actor, why: r.refused?.code }))); } } }
    delete w.presence.bodies[actor]; w.savePresence();
    return { ok: true, left: true, dropped: out.map(({ id, r }) => ({ id, ok: r.ok, ...(r.refused ? { refused: r.refused.reason } : {}) })) };
  },
  wait(w) {
    const sf = w.sim(); const now = w.now();
    const rests = recentRests(w, now).map((r) => {
      const par = sf.st.entities[r.id]?.c.parent?.to;
      return { id: r.id, at: r.at.map(r3), ...(r.lost ? { lost: "landed outside the world; it's back where it was picked up" } : { on: par ?? "ground" }), secondsAgo: Math.round((now - r.when) / 1000) }; });
    const stuck = sf.rested.map((r) => ({ id: r.id, launch: r.seq, at: r.p.map(r3), why: (w.unsettled ?? []).find((u) => u.id === r.id)?.reason ?? "not yet logged" }));
    return { ok: true, inFlight: livePoses(sf), ...(rests.length ? { cameToRest: rests } : {}), ...(stuck.length ? { unsettled: stuck } : {}) };
  },
};
// The rests of the last minute, at most 8, oldest first: what restsOf(w.entries) gives filtered to that window, read
// from the act index's rest list backwards (ts never decreases along the log, so the window is a suffix).
function recentRests(w, now) {
  const X = actIndexOf(w); const E = w.entries; const out = [];
  for (let k = X.rests.length - 1; k >= 0 && out.length < 8; k--) { const seq = X.rests[k]; const e = E[seq]; const when = e.ts ?? 0;
    if (!(now - when < 60000)) break;
    const c = E[e.cause]; const op = opsQuiet(e).find((o) => o.comp === "transform" && o.id === c.body.id);
    const ai = X.restAfter.get(seq); const after = ai === undefined ? null : E[ai];
    out.push({ seq, id: c.body.id, cause: e.cause, at: op?.value?.pos, handled: c.body.handled ?? [c.actor], when,
      ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) }); }
  return out.reverse();
}
// the punt's reach, from the feet: a thing at your feet, or in the air beside you (a volley)
const KICK = { reach: 1.6, below: -0.5, above: 2.0, lift: 0.9 };
const noNeg0 = (n) => (n === 0 ? 0 : n); // I-JSON has no -0; an engine can make one (the same number, written as 0)
// The hold record (research §3, presence): which hand, and by which grip (snapped to it: VRChat ExactGrip, Unity Attach
// Transform) or at which offset (held where it was grabbed: Unreal Free, Unity dynamic attach). A thing with grips is held
// by one; a named grip must exist and suit the hand. Every client derives where it's drawn from the holder's hand bone and
// this record: nothing streams, nothing is logged.
function holdHow(a, g) {
  const names = Object.keys(g.grips);
  if (a.grip !== undefined) {
    if (!names.length) refuse("no-grip", `it has no grips (grabbable.grips); it's held where you take it`, "leave grip out");
    if (!g.grips[a.grip]) refuse("no-grip", `it has no grip called '${a.grip}'`, `its grips: ${names.join(", ")}`, { didYouMean: guess(String(a.grip), names) });
  }
  const hand = a.hand ?? (a.grip !== undefined && g.grips[a.grip].hand !== "either" ? g.grips[a.grip].hand : "right");
  if (a.grip !== undefined && !pickGrip(g, hand, { named: a.grip })) refuse("wrong-hand", `the ${a.grip} grip is for a ${g.grips[a.grip].hand} hand, not your ${hand}`, `grab {id, grip: '${a.grip}', hand: '${g.grips[a.grip].hand}'}`);
  const grip = a.grip ?? pickGrip(g, hand);
  if (grip) return { hand, grip };
  return { hand, ...(a.offset ? { offset: { pos: a.offset.pos.map(r3), q: a.offset.q.map((n) => Math.round(n * 1e6) / 1e6) } } : {}) };
}
// Grabbing what you already hold with your OTHER hand: a two-handed thing takes it in both (the second hand on a
// secondary grip steers it: Godot SECOND, Unity Multiple); anything else swaps hands (Godot SWAP). The same hand, or no
// hand named, is a no-op, as before.
function secondHand(w, actor, a, h, e) {
  const g = grabOf(e.c); const hand = a.hand;
  if (!g || hand === undefined || hand === h.hand || hand === h.second?.hand) return { ok: true, recorded: false, holding: a.id, inHandAt: h.pose.pos.map(r3), hand: h.hand, note: "you're already holding it" };
  if (g.twoHanded) {
    if (a.grip !== undefined && !g.grips[a.grip]) refuse("no-grip", `it has no grip called '${a.grip}'`, `its grips: ${Object.keys(g.grips).join(", ") || "none"}`, { didYouMean: guess(String(a.grip), Object.keys(g.grips)) });
    const grip = a.grip ?? pickGrip(g, hand, { role: "secondary" });
    h.second = { hand, ...(grip ? { grip } : {}) }; w.savePresence();
    return { ok: true, recorded: false, holding: a.id, hand: h.hand, second: h.second, note: "in both hands: the second steers it" };
  }
  const how = holdHow(a, g); delete h.grip; delete h.offset; delete h.second; Object.assign(h, how); w.savePresence();
  return { ok: true, recorded: false, holding: a.id, ...how, note: `moved to your ${hand} hand` };
}
// a release flies (a sim launch) only for a dynamic thing in a world that runs physics; anything else is set down
const fliesIn = (st, id) => !!st.entities["@world"]?.c.sim && st.entities[id]?.c.physics?.kind === "dynamic";
// The socket a released thing snaps into (research §3, Resonite Snapper with XRI's radius): the nearest socket, on
// anything but itself or what it carries, whose `accepts` shares a keyword with its grabbable.fits and whose world point
// is within the socket's radius of where it's let go. A socket something already sits in, or one on a locked thing, is
// passed over (and said so). Its transform becomes the socket's pose in the host's frame (a v4 child's transform is
// local to its parent; the slot names which socket it's in).
function snapTarget(st, id, g, p) {
  const out = { to: null, notes: [] }; if (!g?.fits?.length || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return out;
  const fam = new Set([id, ...descendants(st, id)]);
  for (const [hid, he] of Object.entries(st.entities)) {
    if (hid === "@world" || fam.has(hid)) continue;
    const socks = he.c.sockets ?? modelOf(he.c.model)?.sockets; if (!socks || typeof socks !== "object") continue;
    for (const [slot, sk] of Object.entries(socks)) {
      if (!fitsSocket(g, sk) || !Array.isArray(sk.pos)) continue;
      const ht = worldT(st, hid); const off = qrot(ht.q, sk.pos.map((v, i) => v * ht.scale[i])); const sp = ht.pos.map((v, i) => v + off[i]);
      const d = dist(sp, p); if (d > socketRadius(sk)) continue;
      if (Object.entries(st.entities).some(([k, x]) => k !== id && x.c.parent?.to === hid && x.c.parent?.slot === slot)) { out.notes.push({ passedOver: { to: hid, slot }, why: "something already sits in that socket" }); continue; }
      const lk = [hid, ...ancestors(st, hid)].find((k) => lockedC(st.entities[k]?.c)); if (lk) { out.notes.push({ passedOver: { to: hid, slot }, why: `${lk} is locked` }); continue; }
      if (!out.to || d < out.to.d) out.to = { to: hid, slot, d, sock: sk };
    }
  }
  return out;
}
// Home (research §3): where a returning thing goes. A door act (actor door, verb return-home) whose cause is the
// release, then its state entry: the home transform (and the parent it had), with its scale kept. Refused (a lock, a home
// parent that's gone) means it stays where it is.
function returnPlan(w, st, id, g) {
  const e = st.entities[id]; const hp = g.home.parent;
  if (hp && !st.entities[hp.to]) return { plan: null, why: `its home parent ${hp.to} is gone` };
  const ops = [...(hp ? [setOp(id, "parent", { order: "a0", ...hp })] : e.c.parent ? [delOp(id, "parent")] : []), setOp(id, "transform", { pos: g.home.pos.slice(), q: g.home.q.slice(), scale: (e.c.transform?.scale ?? [1, 1, 1]).slice() })];
  try { return { plan: admit(w, st, { actor: "door", cap: { kind: "door", ids: [id], comps: ["transform", "parent"] } }, ops) }; }
  catch (x) { if (!(x instanceof Refusal)) throw x; return { plan: null, why: x.reason }; }
}
function returnHome(w, id, plan, cause) {
  const act = w.append({ kind: "act", actor: "door", verb: "return-home", ...(cause !== undefined ? { cause } : {}), body: { id } });
  return { act, seq: stateEntry(w, plan, act) };
}
// What moved a thing last, when it was a hand or physics (a settlement, a punt, a rest, the door's follow-up to one):
// the entry and the release that caused it. An edit, a script or a return isn't one (they don't send it home).
const HAND_VERBS = new Set(["put", "drop", "throw", "punt", "leave"]), DOOR_AFTER = new Set(["settle", "return-lost", "return-held"]);
function lastRelease(w, id) {
  const lt = lastTouch(w, id, "transform"); if (!lt) return null;
  const se = w.entries[lt.seq]; const c = w.entries[se?.cause]; if (!isE(c)) return null;
  const byHand = (c.kind === "act" && (HAND_VERBS.has(c.verb) && !RESERVED.has(c.actor) || (c.actor === "door" && DOOR_AFTER.has(c.verb)))) || (c.kind === "sim" && c.verb === "launch");
  return byHand ? { seq: lt.seq, ts: se.ts, release: c.kind === "sim" ? c.cause : se.cause } : null;
}
const sameHome = (st, id, home) => { const e = st.entities[id]; const t = e?.c.transform; if (!t || !home) return false;
  const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-3);
  return near(t.pos, home.pos) && near(t.q, home.q) && (e.c.parent?.to ?? null) === (home.parent?.to ?? null) && (e.c.parent?.slot ?? null) === (home.parent?.slot ?? null); };
// returnAfter (research §3): at the first request after a thing has been unheld that long since a hand or physics last
// moved it, the door sends it home: the same kind of lazy write as a rest. Once: the return is the last thing that
// moved it, and a return isn't a release.
function returnDue(w) {
  const st = w.state(); const now = w.now(); let sf = null;
  for (const [id, e] of Object.entries(st.entities)) {
    const v = e.c.grabbable; if (!v || typeof v !== "object" || !(v.returnAfter > 0)) continue;
    const g = grabOf(e.c); if (!g?.home || w.presence.holds[id]) continue;
    if (st.entities["@world"]?.c.sim) { sf ??= w.sim(); if (sf.launched[id]) continue; }   // in flight, or its rest isn't logged yet
    const r = lastRelease(w, id); if (!r || now - r.ts < g.returnAfter * 1000 || sameHome(st, id, g.home)) continue;
    const { plan } = returnPlan(w, w.state(), id, g); if (plan) returnHome(w, id, plan, r.release);
  }
}
// A home is stamped when a grabbable that returns is written without one (its transform and parent then), and an edit
// that moves a thing whose home was where it stood carries the home with it (a builder moving the key moves its hook…
// home). A builder may set home outright; one that isn't where the thing stands is left alone.
const homeHere = (st, id) => { const c = st.entities[id]?.c ?? {}; const t = { ...COMPONENTS.transform.defaults, ...(c.transform ?? {}) };
  return { pos: t.pos.slice(), q: t.q.slice(), ...(c.parent?.to ? { parent: { to: c.parent.to, ...(c.parent.slot ? { slot: c.parent.slot } : {}) } } : {}) }; };
function stampHomes(ctx, ops) {
  if (ctx.cap || !ops.length) return ops;
  const after = scratch(ctx.st, ops); const out = ops.slice();
  const ids = new Set(ops.filter((o) => o.verb === "create" || (o.verb === "set" && ["grabbable", "transform", "parent"].includes(o.comp)) || (o.verb === "delete" && o.comp === "parent")).map((o) => o.id));
  for (const id of ids) {
    const v = after.entities[id]?.c.grabbable; if (!wantsHome(v)) continue;
    const setsG = ops.some((o) => o.verb === "set" && o.comp === "grabbable" && o.id === id);
    let home = null;
    const born = ops.some((o) => o.verb === "create" && o.id === id);   // a copy or an instance goes home to where it was made, not to its source's home (review 10-06)
    if (v.home === undefined || (born && !sameHome(after, id, v.home))) home = homeHere(after, id);
    else if (!setsG && ctx.st.entities[id] && sameHome(ctx.st, id, v.home) && !sameHome(after, id, v.home)) home = homeHere(after, id);
    if (!home) continue;
    const k = out.findIndex((o) => o.verb === "set" && o.comp === "grabbable" && o.id === id); const val = { ...v, home };
    if (k >= 0) out[k] = setOp(id, "grabbable", val); else out.push(setOp(id, "grabbable", val));
    ctx.notes.push({ id, component: "grabbable", field: "home", kept: home, why: v.home === undefined ? "stamped: where it goes home to (its transform now)" : "moved with it: its home was where it stood" });
  }
  return out;
}
function flyingWorld(st) {
  const spec = st.entities["@world"]?.c.sim;
  if (!spec) refuse("no-physics", "this world has no physics running, so nothing flies", "put it down instead (put {id}); the owner can turn physics on: set {id: '@world', component: 'sim', value: {engine: 'eidosim@0.5.0'}}");
  if (!carried(spec)) refuse("foreign-engine", `this world runs ${spec.engine} (build ${spec.build}), which this server doesn't carry`, "put it down instead");
  return spec;
}
// a thing with no stamped shape is no body in the engine (stampShapes): launched, it would never fly or rest
function shaped(e, id) {
  if (!Array.isArray(e.c.physics?.shape)) refuse("no-shape", `${id} has no measured shape${typeof e.c.model === "string" ? "" : " (it has no model)"}, so physics can't fly it`, typeof e.c.model === "string" ? `put it down instead; a builder can re-set its physics (set {id: '${id}', component: 'physics', value: {kind: 'dynamic'}}) and the door measures it` : "put it down instead; give it a model first");
}
// where the hand lets go (a VR hand, or the desktop hand the person sees): within reach of the door's track of the body
function releasePos(me, pos) {
  if (!Array.isArray(pos) || pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) refuse("shape", "pos is [x, y, z]: where your hand lets go", "");
  const d = dist(handOf(me), pos); if (d > REACH) refuse("out-of-reach", `[${pos.map(r3).join(", ")}] is ${r3(d)} m from your hand as the door tracks your body; you can reach ${REACH} m`, "move first, or leave pos out");
  return pos.map(noNeg0);
}
function launch(w, actor, a, tool, g = null) {
  const me = body(w, actor); const h = holdOf(w, actor, a.id);
  const spec = flyingWorld(w.state());
  shaped(w.state().entities[a.id], a.id);
  if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "throw needs v: [x, y, z] in m/s", "e.g. v: [0, 3, 4] tosses it up and forward (+z)");
  if (a.pos !== undefined) h.pose.pos = releasePos(me, a.pos);
  // L7 (33 F3): a launch writes no state now, but it decides a write (its rest). Admit the write it releases, as put
  // does: your role and its locks NOW, rate. The plan is a check only; the rest will be the engine's value.
  { const st = w.state(); const t = worldT(st, a.id);
    admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: h.pose.pos.map(r3), q: t.q, scale: t.scale })]); }
  const notes = []; let v = a.v;
  if (g && g.throw !== 1 && tool === "throw") { v = v.map((n) => n * g.throw); notes.push({ field: "v", sent: a.v, kept: v.map(r3), why: `×${g.throw} (its grabbable.throw)` }); }
  const sp = Math.hypot(...v), max = ENGINES[spec.engine].maxSpeed;
  if (sp > max) { const was = v; v = v.map((n) => n * max / sp); notes.push({ field: "v", sent: was, kept: v.map(r3), why: `capped at ${max} m/s` }); }
  const act = w.append(actOf(w, actor, tool, a, { handled: h.handled, presence: presenceFacts(me) }));
  const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: h.pose.pos.slice(), yaw: qYaw(h.pose.q), v, handled: h.handled } });
  delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: tool, seq: act });
  return { ok: true, seq, act, flying: a.id, from: h.pose.pos.map(r3), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
}
// ---------- body consent (L6 as revised 21:45; research 42). Presence only: none of this is ever appended. ----------
// The door keeps every body's table (consent.js) beside `bodies` and `holds`, refuses BEFORE delivery, and keeps an
// unlogged attempt ring. Delivery in the lab is the target's `inbox` (a stand-in for the relay to its client).
const ringPush = (P, r) => { (P.ring ??= []).push(r); if (P.ring.length > 200) P.ring.shift(); };
const inboxPush = (P, who, m) => { ((P.inbox ??= {})[who] ??= []).push(m); };
const bodyRef = (x) => (typeof x === "string" ? x.replace(/^body:/, "") : x);
function expireAsks(w) { const P = w.presence, now = w.now();
  for (const [id, k] of Object.entries(P.asks ?? {})) if (k.expires <= now) { delete P.asks[id]; coolDown(P, k, now); inboxPush(P, k.from, { type: "body-reply", ask: id, ok: false, why: "no answer in 20 s: silence is no" }); w.presenceDirty = true; } }
function coolDown(P, k, now) { const key = `${k.from}>${k.to}:${k.cls}`; const n = (P.cool?.[key]?.n ?? 0) + 1; (P.cool ??= {})[key] = { n, until: now + C.COOL_MS * 2 ** (n - 1) }; }
// 42 §4.13 item 4: five refusals of one class from three distinct targets in 5 min puts the actor on a 10-minute
// cool-down for that class, world-wide, written as an automatic action in the MODERATOR log. Never a ban.
function noteRefusal(w, from, to, cls, now) { const P = w.presence; (P.refusals ??= []).push({ ts: now, from, to, cls }); P.refusals = P.refusals.filter((r) => now - r.ts < 300000);
  const mine = P.refusals.filter((r) => r.from === from && r.cls === cls);
  if (mine.length >= 5 && new Set(mine.map((r) => r.to)).size >= 3 && !(P.throttle?.[`${from}:${cls}`] > now)) {
    (P.throttle ??= {})[`${from}:${cls}`] = now + 600000; w.appendMod({ actor: "door", verb: "auto-cooldown", who: from, class: cls, minutes: 10, why: `${mine.length} refusals of ${cls} from ${new Set(mine.map((r) => r.to)).size} people in 5 min` }); } }
// The gate for every act on another body. extra: { cls?, spec?, why?, script?, sponsor? }.
function bodyGate(w, from, to, act, extra = {}) {
  const P = w.presence, now = w.now(); to = bodyRef(to); const cls = extra.cls ?? C.ACT_CLASS[act];
  if (!cls) return { ok: false, code: "shape", reason: `no body act '${act}'`, teach: Object.keys(C.ACT_CLASS).join(", ") };
  if (!P.bodies[to]) return { ok: false, code: "not-here", reason: `${to} isn't here` };
  if (from === to) return { ok: true, consent: "self", deliver: () => deliver(w, from, to, act, cls, extra, "self") };
  const result = (verdict, r) => { ringPush(P, { ts: now, from, to, cls, verdict }); w.presenceDirty = true; return r; };
  if (P.throttle?.[`${from}:${cls}`] > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, teach: "ask people first; this lifts by itself" });
  let d = C.decide(P, from, to, cls, now);
  if (isBhv(from) && extra.sponsor && !C.tableOf(P, to).overrides[from]?.[cls] && C.tableOf(P, to).overrides[`bhvs:${extra.sponsor}`]?.[cls]) d = C.decide(P, `bhvs:${extra.sponsor}`, to, cls, now);
  if (d.mode === "nobody") { noteRefusal(w, from, to, cls, now); return result("refused", { ok: false, code: "consent", class: cls, reason: d.why, teach: `${to} isn't taking ${cls} from you; their shield says so (look)` }); }
  if (d.mode === "ask") {
    if (isBhv(from)) return result("refused", { ok: false, code: "consent", class: cls, reason: `${to}'s ${cls} is 'ask'; a behaviour can't wait for an answer`, teach: `${to} may allow ${from} by name` });
    const key = `${from}>${to}:${cls}`; if (P.cool?.[key]?.until > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${to} said no (or didn't answer); you may ask again in ${Math.ceil((P.cool[key].until - now) / 60000)} min`, teach: "the wait doubles each time" });
    if (Object.values(P.asks ?? {}).some((k) => k.from === from && k.to === to)) return result("refused", { ok: false, code: "pending", class: cls, reason: `you already have an ask waiting with ${to}`, teach: "one at a time" });
    if (Object.values(P.asked ?? {}).filter((t) => t.from === from && now - t.ts < 60000).length >= 2) return result("refused", { ok: false, code: "rate", class: cls, reason: "at most 2 asks a minute", teach: "" });
    const id = `ask-${now}-${Object.keys(P.asks ?? {}).length}`; (P.asks ??= {})[id] = { id, from, to, act, cls, spec: extra.spec ?? null, why: extra.why ?? null, expires: now + C.ASK_MS };
    (P.asked ??= {})[id] = { from, ts: now };
    inboxPush(P, to, { type: "body-ask", ask: { id, from, act, summary: `${from} asks to ${act}${extra.spec?.point ? ` (${extra.spec.point})` : ""}`, why: extra.why ?? null, expires: now + C.ASK_MS } });
    return result("asked", { ok: true, asked: true, ask: id }); }
  return { ok: true, consent: d.standing === "allow" ? "allowed" : "standing", deliver: () => { ringPush(P, { ts: now, from, to, cls, verdict: "allowed" }); deliver(w, from, to, act, cls, extra, "standing"); } };
}
function deliver(w, from, to, act, cls, extra, consent) {
  const P = w.presence, b = P.bodies[to];
  if (cls === "pose") { b.pose = extra.spec ?? {}; b.poseBy = from; }
  if (cls === "move") b.draggedBy = from;
  if (cls === "shove") b.tumble = { by: from, ts: w.now() };
  if (cls === "touch" || cls === "touchI") (P.reaches ??= {})[from] = { to, cls, point: extra.spec?.point ?? null };
  inboxPush(P, to, { type: "body", from, act, cls, consent, ...(extra.spec ? { spec: extra.spec } : {}) }); w.presenceDirty = true;
}
// After any change to `to`'s table: whatever someone is doing to them that the table now says nobody to ends NOW, and the
// actor hears body-revoked once (42 §4.6). An act granted by an ask outlives a later 'ask' cell; only 'nobody' ends it.
function revokeAfter(w, to) { const P = w.presence, b = P.bodies[to], now = w.now(); if (!b) return [];
  const ended = []; const end = (actor, cls, clear) => { if (C.decide(P, actor, to, cls, now).mode !== "nobody") return; clear(); ended.push({ actor, class: cls }); inboxPush(P, actor, { type: "body-revoked", by: to, class: cls }); };
  if (b.poseBy) end(b.poseBy, "pose", () => { delete b.pose; delete b.poseBy; });
  if (b.draggedBy) end(b.draggedBy, "move", () => { delete b.draggedBy; });
  for (const [actor, r] of Object.entries(P.reaches ?? {})) if (r.to === to) end(actor, r.cls, () => delete P.reaches[actor]);
  w.presenceDirty = true; return ended; }
const shieldOf = (P, who) => { const t = C.tableOf(P, who); return { preset: t.preset, strangers: Object.fromEntries(C.ENFORCED.map((c) => [c, t.strangers[c]])), ...(t.paused ? { paused: true } : {}) }; };
const BODY_TOOLS = {
  // L6: the person's own table. `of: <who>` acts on someone else's: closing only, and only if they named you trusted.
  consent(w, actor, a) { const P = w.presence, now = w.now(); expireAsks(w);
    if (a.answer !== undefined) { const k = P.asks?.[a.answer]; if (!k || k.to !== actor) refuse("not-found", `no ask '${a.answer}' waiting for you`, "consent {} lists them");
      delete P.asks[a.answer];
      if (a.yes === true) { if (a.for) C.setConsent(P, actor, { allow: k.from, class: k.cls, for: a.for }, now);
        deliver(w, k.from, actor, k.act, k.cls, { spec: k.spec }, "asked"); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "allowed (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: true, applied: true }); }
      else { coolDown(P, k, now); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "refused (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: false, why: `${actor} said no` }); }
      w.presenceDirty = true; return { ok: true, answered: a.answer, yes: a.yes === true }; }
    const changing = ["preset", "set", "allow", "deny", "pause", "friend"].some((k) => a[k] !== undefined);
    if (changing) { const r = C.setConsent(P, actor, a, now); if (!r.ok) refuse(r.code, r.reason, r.teach ?? "anyone you trust may close your shield; only you may open it (L6)");
      const ended = revokeAfter(w, r.target); w.presenceDirty = true; return { ok: true, recorded: false, of: r.target, ...(ended.length ? { ended } : {}), table: C.tableOf(P, r.target) }; }
    const t = C.tableOf(P, actor);
    return { ok: true, table: { preset: t.preset, strangers: t.strangers, friends: t.friends, paused: t.paused, trusted: t.friendsList }, asks: Object.values(P.asks ?? {}).filter((k) => k.to === actor),
      attempts: (P.ring ?? []).filter((r) => r.to === actor).slice(-10) }; },
  // one shape for every act on a body (42 §4.4): pose, anim, shove, drag. Waits for nothing in the lab; says what happened.
  body(w, actor, a) { const me = body(w, actor); const to = bodyRef(a.to); expireAsks(w);
    if (!["pose", "anim", "shove", "drag", "seat", "carry"].includes(a.act)) refuse("shape", `no body act '${a.act}'`, "pose, anim, shove, drag, seat, carry");
    const t = w.presence.bodies[to]; if (t && ["shove", "drag", "carry"].includes(a.act) && dist(me.at, t.at) > REACH + 0.5) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer");
    const g = bodyGate(w, actor, to, a.act, { spec: a.spec, why: a.why });
    if (!g.ok) refuse(g.code, g.reason, g.teach, { class: g.class });
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false, note: `${to} was asked; no answer in 20 s is no` };
    g.deliver(); return { ok: true, outcome: "allowed", delivered: true, consent: g.consent, recorded: false }; },
  // touch is judged by where the hand IS (42 P8): a named point, or a bare world point at someone's body
  reach(w, actor, a) { const me = body(w, actor); const P = w.presence; let to, cls, point = a.point ?? null; expireAsks(w);
    if (Array.isArray(a.at)) { if (a.at.length !== 3 || a.at.some((n) => !Number.isFinite(n))) refuse("shape", "at: [x, y, z]", "");
      for (const [k, b] of Object.entries(P.bodies)) { if (k === actor) continue; const c = C.pointClass(b.at, a.at); if (c) { to = k; cls = c; break; } }
      if (dist(handOf(me), a.at) > REACH) refuse("out-of-reach", `that point is ${r3(dist(handOf(me), a.at))} m from your hand`, "walk closer");
      if (!to) { (P.reaches ??= {})[actor] = { at: a.at.slice() }; w.presenceDirty = true; return { ok: true, touching: null, recorded: false }; } }
    else { to = bodyRef(a.who); if (!to || !point) refuse("shape", "reach {who, point} or {at: [x, y, z]}", "points: " + [...C.SOCIAL_POINTS, ...C.INTIMATE_POINTS].join(", "));
      cls = C.INTIMATE_POINTS.has(point) ? "touchI" : C.SOCIAL_POINTS.has(point) ? "touch" : refuse("shape", `no point '${point}'`, [...C.SOCIAL_POINTS, ...C.INTIMATE_POINTS].join(", "));
      const t = P.bodies[to]; if (t && dist(me.at, t.at) > REACH + 0.5) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer"); }
    delete P.reaches?.[actor];
    const g = bodyGate(w, actor, to, "touch", { cls, spec: { point, ...(a.at ? { at: a.at } : {}) }, why: a.why });
    if (!g.ok) { w.presenceDirty = true; refuse(g.code, g.reason, g.teach, { class: g.class, stripped: true }); }
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false };
    g.deliver(); return { ok: true, outcome: "allowed", touching: to, class: cls, recorded: false }; },
  inbox(w, actor) { const P = w.presence; expireAsks(w); const m = P.inbox?.[actor] ?? []; if (P.inbox) delete P.inbox[actor]; w.presenceDirty = true; return { ok: true, messages: m }; },
};
const TOOLS = {
  ...PHYSICS_TOOLS,
  ...BODY_TOOLS,
  new(w, actor, a) {
    if (w.exists) refuse("exists", `world '${w.name}' exists`, "you're in it already: look shows what's here; help shows your role");
    if (a.dry) return { ok: true, dry: true, would: { found: w.name, you: "owner", title: a.title ?? w.name } };
    // a fork or a reset names the world it came from; that's provenance in the founding act, so its shape is checked
    if (a.from !== undefined) { const f = a.from, hex = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
      if (!f || typeof f !== "object" || !(typeof f.world === "string" && /^sha256:[0-9a-f]{64}$/.test(f.world)) || !hex(f.head) || (f.name !== undefined && typeof f.name !== "string") || Object.keys(f).some((k) => !["world", "head", "name"].includes(k)))
        refuse("shape", "new {from} names the world it came from: {world: sha256:<64 hex>, head: <64 hex>, name?}", ""); }
    // genesis seeds no state (§2.4): it names the governance keys. The founding act then writes @world, once.
    // §2.4 + §3d: {version, minor, nonce (16 random bytes), owners: tiers of keys, sequencer}. The founder's key (held
    // here in custody) is tier 0; rewind_window is left at its default (1000 state entries).
    const cu = w.custody(); if (!cu) throw new Error("door bug: founding needs io.custody (the sequencer and founder keys, §2.4)");
    w.append({ kind: "genesis", actor: "door", verb: "genesis", body: { version: VERSION, minor: 0, nonce: nonce16(w), owners: [[], [cu.operator()]], sequencer: cu.sequencer() } });
    const ops = [setOp("@world", "about", { name: a.title ?? w.name, text: a.text ?? "" }), setOp("@world", "bounds", { min: [-20, 0, -20], max: [20, 12, 20] }),
      setOp("@world", `roles:${actor}`, { role: "owner" })];
    const plan = admit(w, w.state(), { actor, cap: { kind: "founding", ids: ["@world"], comps: ops.map((o) => o.comp) } }, ops);
    stateEntry(w, plan, w.append(actOf(w, actor, "new", a)));
    return { ok: true, world: w.name, you: "owner" };
  },
  help(w, actor, a) {
    if (a?.tool) return toolHelp(a.tool) ? { ok: true, ...toolHelp(a.tool) } : { ok: false, refused: { code: "no-detail", reason: `no detailed help for '${a.tool}' yet`, teach: `detailed: ${Object.keys(TOOLSPEC).join(", ")}` } };
    const st = w.exists ? w.state() : null; const role = st ? roleOf(st, actor) : "none";
    return { ok: true, world: st?.entities?.["@world"]?.c.about, you: { id: actor, role },
      tools: { read: ["look", "inspect {id}", "measure {id}", "find {kind: 'model'|'blueprint', query?}", "check {id?}", "history {id?, limit?, before?}", "schema {component?}"],
        world: ["new {title, text?} — found this world if it doesn't exist (you become its owner)"],
        write: ["create {id?, model?, components?} | {from: <blueprint hash | a thing to duplicate>, id?, at?}", "set {id, component, value, merge?}", "delete {id} | {id, component}",
          "place {id, on|beside|hang|against|near|at, facing?, height?, along?, level?, offset?, side?, gap?, attach?}", "turn {id, axis, deg, space?: object|parent|world, about?: pivot|origin}", "batch {ops: [{tool, args}…], label?}", "use {id, action?, args?}", "say {text, to?}",
          "undo {label?|act?}: a bare undo takes back your latest change (a redo first); the reply names what it undid", "publish {from, name}", "update {copy, to, resolve?}"],
        scripts: ["upload {text} → src (JavaScript; docs/SCRIPTS-v4.md)", "set {id, component: 'script:<name>', value: {src, scope, on, every?, knobs?}}", "scripts {id?} — what runs here and why not", "scripts {id, script, test: {on: 'use'}} — a dry run", "adopt {id, script, base?} — become a dormant script's sponsor"],
        body: ["move {to: [x, y, z]}", "grab {id, hand?, grip?}", "put {id, pos?}", "throw {id, v: [x, y, z], pos?}", "drop {id, pos?, hand?}", "use {id} while holding it: its grabbable.use (args {phase: 'up'} for the release)", "punt {id, power? | v?}", "leave", "wait"],
        physics: "the world runs physics when @world has a sim component: set {id: '@world', component: 'sim', value: {engine: 'eidosim@0.5.0'}} (owner). A thing can be picked up when it has a grabbable component (schema {component: 'grabbable'}: who may, grips, where it goes when let go, use while held), or physics {kind: 'dynamic', who?}. Grabbable makes it carryable; physics makes it fall", every_write: "may add dry: true to preview, expect: [{id, component, value?}] to be refused (code changed) if any of those isn't what you started from, and through_lock: true to act through a lock you may remove (§5: a lock stops accidents and binds everyone, its locker included)", details: "help {tool: 'place'} (or create, set, delete, use, grab, put, throw, punt) shows every argument with its type and an example" },
      world: st?.entities?.["@world"]?.c.about ?? { name: w.name } };
  },
  look(w, actor, a) {
    const st = w.state(); const ids = Object.keys(st.entities).filter((k) => k !== "@world" && !st.entities[k].c.parent);
    const lim = a.limit ?? 40;
    const live = livePoses(w.sim());
    const tree = (id, d) => [{ ...describe(st, id, live, w.presence.holds), depth: d }, ...Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === id).flatMap((k) => tree(k, d + 1))];
    const all = ids.flatMap((id) => tree(id, 0));
    const P = w.presence; const bodies = Object.entries(P.bodies).map(([id, b]) => ({ id, at: b.at, shield: shieldOf(P, id),
      ...(b.poseBy ? { posedBy: b.poseBy } : {}), ...(b.draggedBy ? { draggedBy: b.draggedBy } : {}), touchedBy: Object.entries(P.reaches ?? {}).filter(([, r]) => r.to === id).map(([k]) => k) }));
    return { ok: true, things: all.slice(0, lim), ...(all.length > lim ? { truncated: true, total: all.length } : {}), bodies };
  },
  inspect(w, actor, a) {
    const st = w.state(); const e = st.entities[a.id];
    if (!e) return { ok: false, refused: { code: "not-found", reason: `no '${a.id}'`, didYouMean: guess(String(a.id), Object.keys(st.entities)) } };
    const piv = e.c.motion?.type === "pendulum" ? pivotOf(st, a.id) : undefined;
    return { ok: true, ...describe(st, a.id, livePoses(w.sim()), w.presence.holds), born: e.born, components: e.c, versions: Object.fromEntries(Object.keys(e.c).map((k) => [k, versionOf(w, lastTouch(w, a.id, k)?.seq)])), touched: touchedOf(w, a.id, Object.keys(e.c)), world: worldT(st, a.id),
      derived: { madeBy: madeBy(w, a.id), ...(piv !== undefined ? { pivot: piv } : {}) },
      children: Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === a.id), ...offersFor(st, a.id, actor), yourRole: roleOf(st, actor) };
  },
  measure(w, actor, a) {
    const st = w.state(); const b = aabb(st, a.id); if (!b) return { ok: false, refused: { code: "no-model", reason: `${a.id} has no model to measure` } };
    const t = worldT(st, a.id);
    return { ok: true, id: a.id, bounds: { min: b.min.map(r3), max: b.max.map(r3) }, size: b.max.map((v, i) => r3(v - b.min[i])),
      front: qrot(t.q, [0, 0, 1]).map(r3), surfaces: surfacesOf(st, a.id).map((s) => ({ level: s.level, y: r3(s.y), size: [r3(s.max[0] - s.min[0]), r3(s.max[1] - s.min[1])] })) };
  },
  find(w, actor, a) {
    const q = (a.query ?? "").toLowerCase();
    if (a.kind === "blueprint") { const lib = w.state().entities["@world"]?.c ?? {};
      return { ok: true, blueprints: Object.entries(lib).filter(([k]) => k.startsWith("library:")).map(([k, v]) => ({ hash: `sha256:${k.slice(8)}`, ...v, by: creatorOf(w, "@world", k)?.rights ?? null })).filter((b) => String(b.name ?? "").toLowerCase().includes(q)) }; }
    return { ok: true, models: CAT.list(q).slice(0, 50).map(([k, m]) => ({ model: k, ...(m.size ? { size: m.size } : { size: null, note: "not measured here" }), about: m.label, surfaces: (m.surfaces ?? []).map((s) => s.y), ...(m.sockets ? { seats: Object.keys(m.sockets) } : {}) })) };
  },
  check(w, actor, a) { const st = w.state(); return { ok: true, warnings: warnings(st, a.id ? [a.id] : Object.keys(st.entities)) }; },
  history(w, actor, a) {
    // one thing's history, newest first, paged backwards (R 10-04: recent by default, deeper on request): before = the seq
    // to continue from (the reply's `next`), limit = how many acts per page
    if (a.id != null) {
      const id = String(a.id); const lim = Math.max(1, Math.min(50, a.limit ?? 5)); const before = a.before ?? Infinity; const out = [];
      let next = null;
      for (const i of backward(w, id)) { if (i >= before) continue; const e = w.entries[i]; if (!isE(e) || e.kind !== "state") continue;
        const ops = opsTouching(e, id); if (!ops.length) continue;
        if (out.length === lim) { next = out.at(-1).seq; break; }
        const act = Number.isInteger(e.cause) ? w.entries[e.cause] : null;
        out.push({ seq: i, by: e.actor, who: said(e.actor), ts: e.ts, verb: (isE(act) && act.kind === "act" ? act.verb : null) ?? ops[0].verb,
          changed: [...new Set(ops.map((o) => o.verb === "create" ? "(created)" : o.verb === "delete" && o.comp === undefined ? "(deleted)" : o.comp))],
          ...(isE(act) && act.body?.undoes !== undefined ? { undoes: act.body.undoes } : {}), ...(Number.isInteger(e.cause) ? { act: e.cause } : {}) }); }
      return { ok: true, id, entries: out, ...(next !== null ? { next, more: "send the same with before: next for older" } : {}) };
    }
    const from = Math.max(0, w.entries.length - (a.limit ?? 12)); return { ok: true, entries: w.entries.slice(from).map((e, k) => [e, from + k]).map(([e, seq]) => isE(e) ? { seq, actor: e.actor, ts: e.ts, kind: e.kind, verb: e.verb, ...(e.cause !== undefined ? { cause: e.cause } : {}), body: e.kind === "act" ? e.body : JSON.stringify(e.body).slice(0, 160) } : { seq, malformed: e.code }) }; },
  schema(w, actor, a) { return { ok: true, components: a.component ? { [a.component]: COMPONENTS[a.component] } : COMPONENTS }; },
  create: (w, actor, a) => commit(w, actor, "create", a, (ctx) => buildCreate(ctx, a)),
  set: (w, actor, a) => commit(w, actor, "set", a, (ctx) => buildSet(ctx, a)),
  delete: (w, actor, a) => commit(w, actor, "delete", a, (ctx) => buildDelete(ctx, a)),
  place: (w, actor, a) => commit(w, actor, "place", a, (ctx) => buildPlace(ctx, a)),
  turn: (w, actor, a) => commit(w, actor, "turn", a, (ctx) => buildTurn(ctx, a)),
  publish: (w, actor, a) => commit(w, actor, "publish", a, (ctx) => buildPublish(ctx, a, w)),
  update: (w, actor, a) => commit(w, actor, "update", a, (ctx) => buildUpdate(ctx, a, w)),
  use(w, actor, a) {
    // use while held (grabbable.use; research grab §3): the holder's use with no action fires the thing's own: its down,
    // or its up with args.phase 'up' (a hose turns on, then off: each one act). The request is logged as sent; the act
    // and the script's event say it was held, in which hand, and which phase. Rapid or continuous effects while pressed
    // (a muzzle flash, a spray) are presence, never a stream of acts: grabbable.fx, drawn by every client.
    const hold = w.presence.holds[a.id]; let held = null; const sent = a;
    // review 10-06: the up of a press is taken from whoever pressed down, even when the thing has left their hand since
    // (taken by someone, dropped with the button still down): a hose that was turned on gets turned off. Once.
    const P = (w.presence.pressed ??= {}); const lateUp = a.args?.phase === "up" && P[a.id]?.by === actor && hold?.by !== actor;
    const holding = hold?.by === actor || lateUp;
    if (a.args?.held === true && !holding) refuse("not-holding", `you aren't holding ${a.id}`, `grab {id: '${a.id}'} first, or leave held out`);
    if (holding) {
      const g = grabOf(w.state().entities[a.id]?.c); const phase = a.args?.phase === "up" ? "up" : "down";
      held = { held: true, hand: (lateUp ? P[a.id].hand : hold.hand) ?? "right", phase };
      if (phase === "down") P[a.id] = { by: actor, hand: held.hand }; else delete P[a.id]; w.presenceDirty = true;
      if (a.action === undefined && g?.use) { const action = phase === "up" ? g.use.up : g.use.down;
        if (!action) return { ok: true, recorded: false, held, note: `${a.id} does nothing on use ${phase} (its grabbable.use names no ${phase})` };
        a = { ...a, action }; }
    }
    const probe = buildUse({ st: w.state(), actor, w, notes: [], refs: new Set() }, a);
    if (probe.presence) return { ok: true, recorded: false, ...(probe.attach ? { attach: probe.attach } : {}), note: probe.note };   // attach: where your frames now say you are
    if (probe.script) { // L7 (41 §3.6): the visitor's use is ITS act, on its own rate; the behaviour runs with its sponsor's rights
      const key = `script:${probe.script}`; const v = w.state().entities[a.id].c[key];
      if (!v || typeof v !== "object") { const wc = w.state().entities["@world"]?.c ?? {};
        // a translated v1 world: the reaction names a v1 binding (@world behavior:<name>), which v4 never runs
        // (a binding there, or the handler itself written by the translation: its cause is a `legacy` act)
        const v1 = Object.entries(wc).find(([k, b]) => k.startsWith("behavior:") && (k === `behavior:${probe.script}` || b?.attach === a.id));
        const lt = lastTouch(w, a.id, "reactions"); const ce = lt ? w.entries[w.entries[lt.seq]?.cause] : null;
        if (v1 || (isE(ce) && ce.kind === "act" && ce.verb === "legacy"))
          refuse("no-runtime", `${a.id}'s '${probe.action}' runs the v1 behaviour '${v1 ? v1[0].slice(9) : probe.script}', carried by translation; v4 doesn't run v1 source`, `re-install it as script:${probe.script} on ${a.id} (docs/SCRIPTS-v4.md); scripts lists v1 behaviours as needs-reinstall`);
        refuse("no-handler", `${a.id}'s '${probe.action}' runs ${key}, which isn't installed on it`, "scripts {id} lists what runs here"); }
      const ev = { on: "use", action: probe.action, ...(a.args !== undefined ? { args: a.args } : {}), ...(held ?? {}) };
      if (a.dry) return { ok: true, dry: true, script: activate(w, a.id, probe.script, { ...ev, by: actor, dry: true }) };
      rateCheck(w, actor); const act = w.append(actOf(w, actor, "use", sent, { runs: key, ...(held ? { held, action: probe.action } : {}) }));
      return { ok: true, act, recorded: true, ...(held ? { held } : {}), script: activate(w, a.id, probe.script, { ...ev, by: actor, seq: act, cause: act }) };
    }
    return commit(w, actor, "use", sent, (ctx) => { const ops = buildUse(ctx, a); if (held) ctx.actExtra = { ...(ctx.actExtra ?? {}), held, action: a.action }; return ops; });
  },
  // moderation (§2.1): a separate log, enforced by the door; never a world entry
  ban(w, actor, a) { if (roleOf(w.state(), actor) !== "owner") refuse("rights", "banning needs owner", ""); if (!isIdentity(a.who)) refuse("shape", "ban {who}", "");
    if (roleOf(w.state(), a.who, false) === "owner") refuse("rights", `${said(a.who)} is an owner here; an owner can't be banned`, "an owner made after them can be demoted first (roles:<them>); then ban");
    w.appendMod({ actor, verb: "ban", who: a.who, ...(a.reason ? { reason: a.reason } : {}) }); return { ok: true, banned: a.who, logged: "moderator log" }; },
  // a kick removes a live session now (the door's server does the removing on this reply); they may come back
  kick(w, actor, a) { if (roleOf(w.state(), actor) !== "owner") refuse("rights", "kicking needs owner", ""); if (!isIdentity(a.who)) refuse("shape", "kick {who}", "");
    if (roleOf(w.state(), a.who, false) === "owner") refuse("rights", `${said(a.who)} is an owner here; an owner can't be kicked`, "");
    w.appendMod({ actor, verb: "kick", who: a.who, ...(a.reason ? { reason: a.reason } : {}) }); return { ok: true, kicked: a.who, logged: "moderator log" }; },
  unban(w, actor, a) { if (roleOf(w.state(), actor) !== "owner") refuse("rights", "unbanning needs owner", "");
    w.appendMod({ actor, verb: "unban", who: a.who }); return { ok: true, unbanned: a.who }; },
  say(w, actor, a) { if (!a.text) refuse("shape", "say needs text", "");
    if (typeof a.text !== "string" || a.text.length > SAY_MAX) refuse("too-big", `a say is at most ${SAY_MAX} characters (this one is ${String(a.text).length})`, "split it, or put a long text in a blob");
    rateCheck(w, actor, "say", a.text.length); const seq = w.append({ kind: "say", actor, verb: "say", body: { text: a.text, ...(a.to ? { to: a.to } : {}) } }); (w.sayQ ??= []).push(seq); return { ok: true, seq }; }, // w.append refuses too-big before writing
  undo: (w, actor, a) => commit(w, actor, "undo", a, (ctx) => buildUndo(ctx, a, w)),
  // ---- scripts (research 41) ----
  // a script's source is a blob (§2.2): stored once by its hash; not world state, so not logged. Hygiene and syntax are
  // checked here (to teach early) and again at install (what binds).
  upload(w, actor, a) {
    if (RANK[roleOf(w.state(), actor)] < RANK[scriptsCfg(w.state()).install]) refuse("rights", `uploading a script needs ${scriptsCfg(w.state()).install}; you are ${roleOf(w.state(), actor)}`, "ask the world's owner");
    if (typeof a.text !== "string") refuse("shape", "upload {text}: the script's JavaScript source", "docs/SCRIPTS-v4.md");
    { const now = w.now(), U = ((w.presence.uploads ??= {})[actor] ??= []).filter((t) => now - t < 60000); w.presence.uploads[actor] = U; // presence: never logged
      if (U.length >= SR.LIMITS.uploads) refuse("rate", `${said(actor)} has uploaded ${U.length} sources in the last minute; at most ${SR.LIMITS.uploads}`, "slow down");
      U.push(now); w.presenceDirty = true; }
    const dirty = SR.hygiene(a.text); if (dirty) refuse(dirty.code, dirty.reason, "refused (41 §3.12): reviewers must see what runs");
    const syn = w.scripts?.checkSyntax?.(a.text); if (syn) refuse("syntax", syn.why, "docs/SCRIPTS-v4.md shows the API");
    if (a.dry) return { ok: true, dry: true, note: "it parses and is clean; nothing stored" };
    return { ok: true, src: w.putBlob({ lang: SR.LANG, api: SR.API, text: a.text }), next: "set {id, component: 'script:<name>', value: {src, scope: {ids: 'self', comps: [...]}, on: ['use']}}" };
  },
  // 41 §3.4: recovery is an explicit, logged adopt: a NEW life of the key (delete + set, one batch), so the adopter becomes
  // its creator and sponsor. §5's key rule decides who may (its creator or an owner); install checks apply with the
  // adopter's rights. `base` (the version inspect gives) makes two racing adopters one winner.
  adopt: (w, actor, a) => commit(w, actor, "adopt", a, (ctx) => { const e = needThing(ctx, a.id); const key = `script:${a.script}`; const v = e.c[key];
    if (!v || typeof v !== "object") refuse("not-found", `${a.id} has no ${key}`, "scripts lists them");
    const lt = lastTouch(w, a.id, key); const base = a.base === undefined ? undefined : versionSeq(w, a.base, "base");
    if (base !== undefined && lt && lt.seq > base) refuse("stale", `${a.id}.${key} changed since version ${base}: ${said(lt.actor)} at ${lt.seq}`, "scripts shows who sponsors it now");
    const was = sponsorOf(w, a.id, key); ctx.actExtra = { adopts: { script: key, was: was?.sponsor ?? null, wasAt: was?.sponsorAt ?? null } }; ctx.refs.add(a.id);
    return [delOp(a.id, key), setOp(a.id, key, v)]; }),
  // the status view (unlogged): every script here, its sponsor and why it does or doesn't run; translated v1 behaviours
  // that need re-installing. With {id, script, test: {on, …}}: a dry run (41 §3.12): what it WOULD write, refused or not.
  scripts(w, actor, a) { const st = w.state();
    if (a.test !== undefined) {
      if (RANK[roleOf(st, actor)] < RANK.builder) refuse("rights", "a dry run needs builder (it spends the door's time)", "");
      if (!a.test || typeof a.test !== "object" || typeof a.test.on !== "string") refuse("shape", "test is an event {on: 'use'|'tick'|'wake'|'say'|'enter'|'leave'|'changed:<comp>', …}", "e.g. scripts {id: 'bell1', script: 'bell', test: {on: 'use', action: 'ring'}}");
      if (!st.entities[a.id]?.c[`script:${a.script}`]) refuse("not-found", `${a.id} has no script:${a.script}`, "scripts lists them");
      const { cause: _c, dry: _d, ...ev } = a.test; // a test event is the event's own fields; never a cause (depth) of its own
      return { ok: true, dry: true, test: activate(w, a.id, a.script, { by: actor, ...ev, dry: true }) }; }
    return { ok: true, ...scriptsOf(w, st, a.id) }; },
  // the sky panel's two verbs, with v1's own meaning (shared/forecast.js foldSkyEntry, the same function v1's fold ran):
  // `sky` replaces the sky, stamped with the DOOR's clock (hours advance from it); `weather` merges onto the standing
  // sky. v1 also echoed who and at which seq into the value: derived (the log says so), so never stored here (R8).
  sky: (w, actor, a) => commit(w, actor, "sky", a, (ctx) => buildSky(ctx, a, w)),
  weather: (w, actor, a) => commit(w, actor, "weather", a, (ctx) => buildWeather(ctx, a, w)),
  sculpt: (w, actor, a) => commit(w, actor, "sculpt", a, (ctx) => buildSculpt(ctx, a)),
  batch(w, actor, a) {
    return commit(w, actor, "batch", a, (ctx) => {
      const all = []; let st = ctx.st;
      (a.ops ?? []).forEach((o, i) => {
        // sky/weather are sets on @world.sky with v1's merge meaning, so they batch like any set (one act, one undo)
        const B = { create: buildCreate, set: buildSet, delete: buildDelete, place: buildPlace,
          sky: (c, x) => buildSky(c, x, w), weather: (c, x) => buildWeather(c, x, w) }[o.tool];
        if (!B) refuse("shape", `batch op ${i}: '${o.tool}' can't go in a batch`, "batch takes create, set, delete, place, sky, weather");
        const sub = { ...ctx, st };
        let ops; try { ops = B(sub, o.args ?? {}); } catch (e) { if (e instanceof Refusal) { e.op = i; } throw e; }
        all.push(...ops); st = scratch(st, ops); sub.refs.forEach((r) => ctx.refs.add(r));
        if (sub.cap) ctx.cap = sub.cap;
      });
      return all;
    });
  },
};
