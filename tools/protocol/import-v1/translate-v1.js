// v1/v2 → v4 translator (lab). Runs the REAL v1 fold (anima/main shared/fold.js, extracted to legacy/) one entry at a
// time, projects its state into v4 entity/component form, and emits, per old entry:
//   - the old entry as sent: an `act` (verb "imported", body {verb, args, from: old seq}, ts: old ts), or a `say`, and
//   - at most one change entry with the plain results that bring v4 to the same place (cause = that act).
// The output is in the PROTOCOL-v4 §2.4 wire format, and every name and id follows §2.3: an old id or name the
// grammar refuses is mapped by `enc` (injective, deterministic). After every entry it folds the v4 entry with the v4
// fold and checks the projections agree. The original log is never written (R9); the output is a regenerable cache.
// Ported from the v4 lab (code/v4-lab/translate-v1.js @ 11db981). Engine changes: the v1 fold is the engine's own
// ../fold.js (the lab carried an older anima/main copy in legacy/), hashing and hex come from ./hash.js (no node:
// imports; the browser may import this file), and the lab's CLI is tools/protocol/sweep.ts.
import { emptyState as v1Empty, foldEntry } from "./fold.js";
import { emptyState as v4Empty, applyInPlace, opsOf, worldIdOf, DIALECT, VERSION } from "../../../shared/protocol/fold.js";
import { enc, encName, dec } from "../../../shared/protocol/names.js";
import { qNorm } from "../../../shared/rot.js";
import { sha256 } from "../../../shared/protocol/hash.js";
import { COMPONENTS, registered } from "../../../shared/protocol/componentspec.js";

// The engine's translator has its own name (research 35, slice-2 #1): it projects the ENGINE's v1 fold, which differs
// from the lab's older copy on two of 35 logs (tilt-demo's q, 06-components' newer verbs), so the lab's name
// "translate-v1@0.3" would claim output this code didn't make. @1 also differs from the lab in names.js's escape
// (a component name the grammar refuses is always x--, never n-prefixed). The exact v1 fold build is stamped beside
// it when the caller knows it (translate(…, {foldBuild}); build.ts beside this file computes it from the files).
// @2 (slice 3a): a mounted thing comes out in the authority's shape (transform LOCAL to its parent, parent {to, order, slot?}; socket? since @7),
// and v1 `guard` merges into `lock` (PROTOCOL-v4 §5). Output differs from @1 on any log with a mount or a guard.
// v1's only kindless handler, {impulse: x}, added x straight to a pendulum's turn rate (rad/s): that's an angular
// impulse, v4's {kind: "impulse", angular: x} exactly.
// v1 took any key in any component; v4's catalogue components are closed (the authority refuses an unknown key, L7). A
// v1 key the v4 component doesn't define (a lamp's `flicker`) goes to imported:<component> {key: value} beside it: carried,
// never dropped (R10), and the component itself is one the v4 door and every editor take as it is.
// v1 took a CSS hex colour where three.js does ("#fff"); v4's colours are 0xRRGGBB integers. Lossless.
export const hexColor = (x) => { if (typeof x !== "string") return x; const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(x.trim());
  if (!m) return x; const h = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1]; return parseInt(h, 16); };
function splitUnknown(c) {
  if (c.light && typeof c.light === "object" && "color" in c.light) c.light = { ...c.light, color: hexColor(c.light.color) };
  if (c.light && typeof c.light === "object" && !Array.isArray(c.light) && "keep" in c.light) { const { keep, ...l } = c.light; c.light = { ...l, important: keep }; } // @7: v1's keep is light.important
  for (const [k, v] of Object.entries(c)) {
    const name = k.split(":")[0], def = COMPONENTS[name];
    if (!def?.fields || name === "imported" || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const extra = Object.keys(v).filter((f) => !(f in def.fields));
    if (!extra.length) continue;
    const lk = keyed("imported", dec(k));
    if (lk in c) continue;   // a v1 top-level field of the same name already holds that slot: leave the component whole
    const keep = { ...v }, left = {};
    for (const f of extra) { left[f] = v[f]; delete keep[f]; }
    c[k] = keep; c[lk] = left;
  }
}
// every v1 socket was a seat: {pos, yaw?, pose?, part?} → {pos, q?, part?, body: {pose?}} (a person attaches by
// using it). A v1 socket key v4 doesn't define rides in imported:sockets {<slot>: {key: value}}.
function newSockets(S, c) {
  if (!S || typeof S !== "object" || Array.isArray(S)) return S;
  const out = {}, left = {};
  for (const [slot, s] of Object.entries(S)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) { out[slot] = s; continue; }
    const { pos, yaw, part, pose, ...rest } = s;
    out[slot] = { ...(pos !== undefined ? { pos } : {}), ...(Number.isFinite(yaw) && yaw !== 0 ? { q: yawQ(yaw) } : {}), ...(part !== undefined ? { part } : {}), body: pose !== undefined ? { pose } : {} };
    if (Object.keys(rest).length) left[slot] = rest;
  }
  if (Object.keys(left).length) c[keyed("imported", "sockets")] = left;
  return out;
}
function newStory(v) {
  const out = { ...v };
  if (typeof v.practice === "string" && v.practice.trim()) out.text = (typeof v.text === "string" && v.text ? `${v.text}\n\n` : "") + v.practice.trim();
  if (typeof v.markedEntity === "string" && v.markedEntity) out.marks = [enc(v.markedEntity)];
  return out; // practice, markedEntity and anything else story doesn't define move to imported:story (splitUnknown)
}
// v1's spin took rpm or degPerSec; v4's is degPerSec (rpm × 6, lossless: the renderer read rpm × 6). degPerSec wins
// when both were written, as the renderer had it.
function newMotion(m) {
  if (!m || typeof m !== "object" || Array.isArray(m) || !("rpm" in m)) return m;
  const { rpm, ...rest } = m;
  return rest.degPerSec !== undefined || typeof rpm !== "number" ? rest : { ...rest, degPerSec: rpm * 6 };
}
function newReactions(rx) {
  if (!rx || typeof rx !== "object") return rx;
  const out = {};
  for (const [k, h] of Object.entries(rx)) {
    if (h && typeof h === "object" && h.kind == null && typeof h.impulse === "number") {
      const { impulse, ...rest } = h;
      out[k] = { ...rest, kind: "impulse", angular: impulse };
    } else if (h && typeof h === "object" && h.component === "door") out[k] = { ...h, component: "openable" };
    else out[k] = h;
  }
  return out;
}

export const TRANSLATOR = "eidoverse/translate-v1@8";
// @7 (2026-10-07, the conventional-names pass, R's approved table): the output speaks the renamed protocol. A result entry
// is kind `change` (was `state`); the translating door's own entries are actor `system` (was `door`), and so is a v1 entry
// whose actor was v1's "door". Everything carried only from translation is one `imported` family: the act verb `imported`
// (was `legacy`), imported:<k> (was legacy:<k>), imported-behavior:<k> (was behavior:<k>), imported-bans:<id> (was
// bans:<id>), imported-epoch (was @world epoch). A v1 `gen` grant is can.generate (roles:<id> and default-role alike; the
// door no longer reads `gen`). A light's `keep` is `important`; a palette entry is assets:<k> (was palette:<k>); a dialect-3 epoch's engine is @world physics-engine (was sim). A mount's parent names its socket as `socket` (v1's `slot`). Output differs from @6 on every log.
// @6 (2026-10-07): the two @5s merged (batch 2 and ship-list group A each bumped @4 → @5 in parallel branches).
// @5 (2026-10-07, batch 2): `story` is a component now ({title, text, marks?}). A v1 story's `practice` (Mica's marker
// tree: "One tree, renewing, not accumulating…") becomes a paragraph of its text, and `markedEntity` its marks: the
// words people read stay on the label. Both are also carried in legacy:story beside it (with plantedBy, assetAuthor:
// who planted it is the log's create; who made the model is the library's credits), so nothing is lost (R10).
// @5 (2026-10-07, ship list): a v1 `door` component is v4's `openable` (R 10-07: the behaviour's name, not the asset's), and
// a reaction naming component 'door' names 'openable'; a spin's `rpm` is degPerSec (rpm × 6), the rate the authority takes. Orbit
// center/face/period and path points/speed/duration/loop are the authority's own motion fields now, so they stay in the
// motion (they were parked in legacy:motion, which nothing reads). Output differs from @4 on any log with these.
// @4 (2026-10-06, roles S5): a v1 `fly: true` grant becomes roles:<id>.can.fly (it fell into legacy:roles:<id> before).
// @3 (2026-10-05, review F1): genesis on §2.4 + §3d, as the lab's translator writes it. A v1 world has no keys: the
// translating door's key is the sequencer and the only governance key, in tier 1 (the custodial default: tier 0
// empty, the operator the real owner). The nonce is the first 16 bytes of sha256 of the source log's lines, so
// translation stays a pure function. translatedFrom can't ride in genesis (a known minor's fields are exact): it is
// the `translated` act right after it. v1's owners are @world roles (from its grants), as before.
export const LAB_DOOR_KEY = "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic"; // the conformance suite's fixed sequencer key
const b64url = (bytes) => { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
// A real authority passes its own keys and a random nonce (round-2 review R4): the operator's governance key in tier 1,
// never the sequencer's, and a nonce that makes two translations of one log two worlds. Without them (the pure tests)
// the nonce is derived from the source and one fixed key stands in for both.
// The founder's own key (review 10-07 H4, R's ruling): tier 0 is the world's founder, from a key made on their own machine;
// the operator (custody) stays tier 1. Under §13's add-key rule (GOV-5) an empty tier 0 can never be filled later, so a
// translation that leaves it empty does so knowingly (tools/protocol/world.ts translate --no-founder-key).
export function translatedGenesis(oldEntries, { key = LAB_DOOR_KEY, operator = key, nonce, founder } = {}) {
  if (!nonce) { const h = sha256(oldEntries.map((e) => JSON.stringify(e)).join("\n")); nonce = b64url(Uint8Array.from(h.slice(0, 32).match(/../g), (x) => parseInt(x, 16))); }
  if (founder !== undefined && (founder === key || founder === operator)) throw new Error("the founder's key must be their own: not this server's sequencer or operator key");
  return { dialect: DIALECT, v: VERSION, minor: 0, nonce, owners: [founder ? [founder] : [], [operator]], sequencer: key };
}
export { enc, encName, dec };
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// §2.3 grammar for old names: names.js (one encoding, shared with the live authority).
const keyed = (prefix, k) => `${prefix}:${enc(k)}`;

// The projection: what the old fold's state MEANS, in v4 terms. Every deliberate difference is named in DROPPED.
const ENTITY_SKIP = new Set(["actor", "ts", "born"]); // provenance lives in the entry envelope in v4; born is per-log
export const DROPPED = {
  "entity.actor / entity.ts": "last writer and time: in v4 these are the entry envelope's actor and the act's at, not state",
  "entity.born": "incarnation seq: re-derived from the v4 log (the translated create's seq)",
  "mounts": "bodies sitting: presence in v4, never history (00:50 ruling 1); their old entries survive as acts",
  "recentChat / chatTotal": "the chat window: a reader of `say` entries does this in v4, not world state",
  "placer": "who placed it: a view over the log in v4 (L2: no stored derived values); the old value survives in the old entry",
  "roles['*']": "becomes @world `default-role` (the declared role for anyone not named); '*' is not an identity (§2.3)",
  "comp.guard": "merged into `lock` (PROTOCOL-v4 §5, R 19:58): a truthy guard becomes lock: true, which binds everyone (the placer too) and any builder may lift; the guard's authorship protection is dropped by design. stats.guards counts the things this happened to, so the world's owners can be told",
  "comp.door": "renamed `openable` (R 10-07), and a reaction's component 'door' with it: the same value under v4's name (@5)",
  "motion.rpm": "becomes degPerSec = rpm × 6 (@5): the rate the renderer drew, under the authority's one name for it",
  "a mounted thing's own pos/yaw/q": "v1 keeps a riding thing's pre-mount pose, unused until a dismount; v4's transform IS the pose it rides at (local to its parent: v1's offset, or its socket's pos, and q/yaw). The parent's offset/yaw/q are that transform, not a second copy (L2)",
};
// v1's mount, read the way the renderer realizes it (shared/hierarchy.js localOf, written independently here): a
// riding thing sits at parent.offset, else its socket's pos, else the carrier's origin; turned by parent.q, else
// parent.yaw, else the socket's yaw. Only while its carrier exists: a thing whose carrier is gone stays where its own
// pose puts it (as v1 draws it), and the authority reads a parent that names nothing the same way (worldT).
const fin = (n) => { n = Number(n); return Number.isFinite(n) ? n : 0; };
function rideOf(st, e) {
  const rel = e.parent; if (!rel || typeof rel !== "object" || typeof rel.to !== "string" || !Object.hasOwn(st.entities ?? {}, rel.to)) return null;
  const socks = st.entities[rel.to]?.comp?.sockets; const s0 = rel.slot && socks && typeof socks === "object" && Object.hasOwn(socks, rel.slot) ? socks[rel.slot] : null;
  const sock = s0 && typeof s0 === "object" ? s0 : null;
  const pos = (Array.isArray(rel.offset) ? rel.offset : Array.isArray(sock?.pos) ? sock.pos : [0, 0, 0]).map(fin);
  const q = qNorm(rel.q) ?? yawQ(fin(rel.yaw ?? sock?.yaw ?? 0));
  return { pos, q };
}
const PARENT_POSE = new Set(["offset", "yaw", "q"]);
// who(name, {sub}) → the v4 identity for a v1 person (round-2 review R1): the server passes the authority directory's
// mapping, so actors and role/ban keys become opaque ids and the account (`sub`) leaves the log for the directory.
// Without one (the pure tests, the sweep), names are escaped as before and `sub` stays in the value.
// v1's own system actors (v1 vocabulary: the v1 server wrote "door"); in v4 the authority's own acts are actor `system`
const SYSTEM = new Set(["door", "world", "sim"]);
/** a v1 actor name → the v4 actor, by grammar only (no directory): v1's "door" is v4's `system`, anything else enc() */
export const actorOf = (a) => (a === "door" ? "system" : enc(a));
const asSub = (k) => (typeof k === "string" && /^(human|agent):/.test(k) ? k : undefined);
// @8 (2026-10-07, review H1 + R's ruling): bare names are the registry's, and the authority refuses an unregistered one. A
// v1 world's own inventions (a `heart` comp nobody registered) come across under a namespace, `<namespace>/heart` (the
// translated world's name; "imported" when the caller gives none), so the registry can promote the word later without
// rereading this world's values in a new meaning. Registered names, and the imported family, stay as they were.
export const NAMESPACE = "imported";
/** A world's name as a §3.1 namespace (lowercase letters, digits, '-', '.'), or the default. */
export const namespaceOf = (name) => { const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/\.{2,}/g, "."); return /^[a-z0-9]/.test(s) ? s.slice(0, 63).replace(/[-.]+$/, "") : NAMESPACE; };
function namespaceUnknown(c, ns) {
  for (const k of Object.keys(c)) { const base = k.split(":")[0];
    if (base.includes("/") || registered(base)) continue;
    const to = `${ns}/${k}`; if (to in c) continue;   // never overwrite (a world that already used both spellings keeps the bare one)
    c[to] = c[k]; delete c[k]; }
}
// @8 (review 10-07 H3, R's ruling): a model is named by its content address, eido:sha256/<64 hex> (spec/EIDO-URIS.md), when
// the caller can say what the bytes are (`content(path)` → the address, or null): a host path would bake this host's library
// layout into the permanent history and into every fork. A path the resolver can't place stays as it was (and is listed);
// the imported act keeps the path as it was written either way.
export function project(st, seen = null, who = null, ns = NAMESPACE, content = null) {
  const out = {};
  const person = (k, v) => (who && !SYSTEM.has(k) ? who(k, { sub: (v && typeof v === "object" && typeof v.sub === "string" ? v.sub : undefined) ?? asSub(k) }) : enc(k));
  const unsub = (v) => { if (!who || !v || typeof v !== "object" || !("sub" in v)) return v; const { sub, ...rest } = v; return rest; };
  for (const [id, e] of Object.entries(st.entities ?? {})) {
    const c = {};
    const t = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yawQ(e.yaw ?? 0), scale: typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
    const ride = rideOf(st, e); if (ride) { t.pos = ride.pos; t.q = ride.q; }
    c.transform = t;
    if (e.lib !== undefined) c.model = content && typeof e.lib === "string" ? content(e.lib) ?? e.lib : e.lib;
    if (e.kind === "light") c.light = Object.fromEntries(["color", "intensity", "range", "keep", "day"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    for (const [k, v] of Object.entries(e.comp ?? {})) if (k !== "guard") c[encName(k === "door" && !e.comp.openable ? "openable" : k)] = k === "reactions" ? newReactions(v) : k === "sockets" ? newSockets(v, c) : k === "motion" || k.startsWith("motion:") ? newMotion(v) : v;
    if (e.comp?.guard && !e.comp.lock) { c.lock = true; seen?.guards.add(id); } // §5: guard merges into lock
    if (c.story && typeof c.story === "object" && !Array.isArray(c.story)) c.story = newStory(c.story); // @5: a marker's words, in story's shape
    if (e.parent) c.parent = typeof e.parent.to === "string"
      ? { to: enc(e.parent.to), order: "a0", ...Object.fromEntries(Object.entries(e.parent).filter(([k]) => k !== "to" && !PARENT_POSE.has(k)).map(([k, v]) => [k === "slot" ? "socket" : k, v])) }   // v1's slot is v4's socket (@7)
      : e.parent; // not a v1 mount (the v1 fold writes `to` as a string): carried as it is
    for (const [k, v] of Object.entries(e)) {
      if (["pos", "yaw", "q", "scale", "lib", "kind", "color", "intensity", "range", "keep", "day", "comp", "parent", "placer"].includes(k) || ENTITY_SKIP.has(k)) continue;
      c[keyed("imported", k)] = v; // anything the mapping doesn't know is carried, never dropped (R10)
    }
    out[enc(id)] = c;
  }
  const w = {};
  for (const k of ["sky", "terrain", "grass"]) if (st[k] != null) w[k] = st[k];
  if (st.epoch != null) w["imported-epoch"] = st.epoch; // v1 dialect 3's physics epoch: a record, never read live
  // round-2 R8: v1 echoed into the sky value who set it (`by`, a display name) and at which seq: derived, and a person's
  // name inside a value. Dropped; the log says who set the sky (History, inspect's touched).
  if (w.sky && typeof w.sky === "object") { const { seq, by, ...sky } = w.sky;
    if (sky.forecast && typeof sky.forecast === "object") { const { seq: _s, by: _b, ...fc } = sky.forecast; sky.forecast = fc; }
    w.sky = sky; }
  for (const a of st.assets ?? []) w[keyed("assets", typeof a === "string" ? a : a.path ?? JSON.stringify(a))] = typeof a === "string" ? {} : a;
  // research roles §translation: v1's `fly` and `gen` grants are the fly and generate switches, can.fly / can.generate
  // (@7: gen had stayed as written, read by the authority as generate); `caption` stays in imported until screens carry captioners
  const toCan = (v) => { if (!v || typeof v !== "object" || !("fly" in v || "gen" in v)) return v; const { fly, gen, ...rest } = v;
    const can = { ...(rest.can ?? {}), ...(fly === true ? { fly: true } : {}), ...(gen === true ? { generate: true } : {}) };
    return Object.keys(can).length ? { ...rest, can } : rest; };
  for (const [k, v] of Object.entries(st.roles ?? {})) if (k === "*") w["default-role"] = toCan(v); else w[`roles:${person(k, v)}`] = toCan(unsub(v));
  for (const [k, v] of Object.entries(st.bans ?? {})) w[`imported-bans:${person(k, v)}`] = unsub(v);
  // a binding's author is a person: their identity, not their name (R1), when a who() mapper is given
  for (const [k, v] of Object.entries(st.behaviors ?? {})) w[keyed("imported-behavior", k)] = who && v && typeof v.author === "string" && !SYSTEM.has(v.author) ? { ...v, author: who(v.author, {}) } : v;
  const known = new Set(["entities", "sky", "terrain", "grass", "epoch", "assets", "roles", "bans", "behaviors", "mounts", "recentChat", "chatTotal"]);
  for (const [k, v] of Object.entries(st)) if (!known.has(k) && v != null) w[keyed("imported", k)] = v;
  out["@world"] = w; // @world is live from genesis (§2.3)
  for (const c of Object.values(out)) { splitUnknown(c); namespaceUnknown(c, ns); }
  return clone(out); // a copy: the old fold mutates some records in place (bstate), and aliasing would hide the change
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diff(prev, now) {
  const ops = [];
  for (const id of Object.keys(prev)) if (!(id in now)) ops.push({ verb: "delete", id });
  for (const [id, comps] of Object.entries(now)) {
    if (!(id in prev)) { ops.push({ verb: "create", id }); for (const [k, v] of Object.entries(comps)) ops.push({ verb: "set", id, comp: k, value: clone(v) }); continue; }
    for (const k of Object.keys(prev[id])) if (!(k in comps)) ops.push({ verb: "delete", id, comp: k });
    for (const [k, v] of Object.entries(comps)) if (!eq(prev[id][k], v)) ops.push({ verb: "set", id, comp: k, value: clone(v) });
  }
  return ops;
}
export const v4project = (s) => Object.fromEntries(Object.keys(s.entities).map((id) => [id, { ...s.entities[id].c }]));
export const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
// one entry in the §2.4 envelope; the authority's re-read discipline applies: what we emit must parse back unchanged
export const changeBody = (ops) => (ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } });
// I-JSON has no -0; an old log may hold one (the same number, written as 0)
export const unNegZero = (v) => (Object.is(v, -0) ? 0 : Array.isArray(v) ? v.map(unNegZero) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unNegZero(x)])) : v);

export function translate(oldEntries, { onDivergence, foldBuild, key, operator, nonce, who, founder, namespace, content } = {}) {
  const ns = namespace === undefined ? NAMESPACE : namespaceOf(namespace);
  const seenModels = new Map();   // path → its address (or null): each path resolved once, and counted
  const addr = content ? (p) => { if (!seenModels.has(p)) seenModels.set(p, content(p) ?? null); return seenModels.get(p); } : null;
  const v1 = v1Empty(); const v4 = v4Empty(); const out = [];
  const stats = { in: oldEntries.length, out: 0, change: 0, verbs: {}, ops: 0, divergences: 0, firstDivergence: null, renamed: 0, guards: 0, guardsLive: 0 };
  const seen = { guards: new Set() }; // ids whose v1 guard became a lock at some point (§5: their owners should be told)
  let world = null;
  let lastTs = -Infinity; // §2.1: ts never decreases. v1 voice says carry speech time, which can run behind; clamp,
  // and stats.tsClamped counts them (the original ts stays in the source log, which is never overwritten, R9)
  const push = (e) => { if (e.kind !== "genesis") e = { world, ...e };
    if (Number.isInteger(e.ts)) { if (e.ts < lastTs) { e.ts = lastTs; stats.tsClamped = (stats.tsClamped ?? 0) + 1; } lastTs = e.ts; }
    const seq = out.length; out.push(e);
    if (e.kind === "genesis") world = worldIdOf(e); if (e.kind === "change") applyInPlace(v4, opsOf(e), seq); return seq; };
  const genesis = oldEntries[0]?.verb === "genesis" ? oldEntries[0].args : { v: 1, dialect: "eidoverse-log", implicit: true };
  const t0 = Number.isInteger(oldEntries[0]?.ts) ? { ts: oldEntries[0].ts } : {};
  push({ kind: "genesis", actor: "system", verb: "genesis", ...t0, body: translatedGenesis(oldEntries, { ...(key ? { key } : {}), ...(operator ? { operator } : {}), ...(nonce ? { nonce } : {}), ...(founder ? { founder } : {}) }) });
  push({ kind: "act", actor: "system", verb: "translated", ts: t0.ts ?? 0, body: { from: unNegZero({ ...genesis, translator: TRANSLATOR, ...(foldBuild ? { fold: foldBuild } : {}) }) } });
  // an old request as sent keeps its words, but never an account (a grant's sub): that becomes the person's id (R1)
  const noAcct = (a) => (who && a && typeof a === "object" && typeof a.sub === "string" ? { ...a, sub: who(typeof a.id === "string" ? a.id : a.sub, { sub: a.sub }) } : a);
  let prev = project(v1, seen, who, ns, addr);
  for (const e of oldEntries) {
    if (e.verb === "genesis") continue;
    stats.verbs[e.verb] = (stats.verbs[e.verb] ?? 0) + 1;
    foldEntry(v1, e);
    const now = project(v1, seen, who, ns, addr);
    const actor = who && !SYSTEM.has(e.actor ?? "door") ? who(String(e.actor), {}) : actorOf(e.actor ?? "door"); if (actor !== e.actor) stats.renamed++;
    const ts = Number.isInteger(e.ts) ? e.ts : undefined; // §2.1: the authority's admission time, carried from the old entry
    const tl = push({ ...(e.verb === "say" ? { kind: "say", actor, verb: "say", body: unNegZero(((b) => (who && typeof b.to === "string" && !SYSTEM.has(b.to) ? { ...b, to: who(b.to, {}) } : b))(clone(e.args) ?? {})) }
      : { kind: "act", actor, verb: "imported", body: unNegZero({ verb: e.verb, args: noAcct(clone(e.args) ?? null), from: e.seq ?? null }) }), ...(ts !== undefined ? { ts } : {}) });
    const ops = diff(prev, now);
    if (ops.length) { push({ kind: "change", actor, cause: tl, ...changeBody(unNegZero(ops)), ...(ts !== undefined ? { ts } : {}) }); stats.change++; stats.ops += ops.length; }
    if (canon(v4project(v4)) !== canon(now)) { stats.divergences++; if (!stats.firstDivergence) { stats.firstDivergence = { oldSeq: e.seq, verb: e.verb }; onDivergence?.(e, now, v4project(v4)); } }
    prev = now;
  }
  stats.out = out.length;
  if (addr) { stats.modelsRewritten = [...seenModels.values()].filter(Boolean).length; stats.modelsKept = [...seenModels].filter(([, a]) => !a).map(([p]) => p); }
  stats.guards = seen.guards.size; stats.guardsLive = Object.values(v1.entities ?? {}).filter((e) => e?.comp?.guard && !e.comp.lock).length;
  return { out, stats, final: { v1: project(v1, null, who, ns, addr), translated: v4project(v4) } };
}

