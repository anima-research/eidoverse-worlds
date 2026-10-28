// v1/v2 → v4 translator (lab). Runs the REAL v1 fold (anima/main shared/fold.js, extracted to legacy/) one entry at a
// time, projects its state into v4 entity/component form, and emits, per old entry:
//   - the old entry as sent: an `act` (verb "imported", body {verb, args, from: old seq}, ts: old ts), or a `say`, and
//   - at most one change entry with the plain results that bring v4 to the same place (cause = that act).
// The output is in the PROTOCOL-v4 §2.4 wire format, and every name and id follows §2.3: an old id or name the
// grammar refuses is mapped by `enc`, here names.js's encRaw (deterministic and injective: a name in the hashed form is
// escaped like any other, and a log holding a lone surrogate, the one pair it maps alike, isn't imported at all). After
// every entry it folds the v4 entry with the v4 fold and checks the projections agree. The original log is never written (R9); the output is a regenerable cache.
// Ported from the v4 lab (code/v4-lab/translate-v1.js @ 11db981). Engine changes: the v1 fold is the engine's own
// ../fold.js (the lab carried an older anima/main copy in legacy/), hashing and hex come from ./hash.js (no node:
// imports; the browser may import this file), and the lab's CLI is tools/protocol/sweep.ts.
import { emptyState as v1Empty, foldEntry } from "./fold.js";
import { emptyState as v4Empty, applyInPlace, opsOf, worldIdOf, DIALECT, VERSION } from "../../../shared/protocol/fold.js";
import { unNegZero } from "../../../shared/protocol/round.js";
// an old log's names are never ids, so a name in the hashed form is escaped too (encRaw; house 6340433633, @19)
import { encRaw as enc, encNameRaw as encName, dec, partSlot, motionType } from "../../../shared/protocol/names.js";
import { qNorm } from "../../../shared/rot.js";
import { sha256 } from "../../../shared/protocol/hash.js";
import { COMPONENTS, registered } from "../../../shared/protocol/componentspec.js";
import { modernize as newParticles, hashSeed } from "../../../shared/particle_effects.js";
import { repairComps, repairWorld, renameFields, SHAPES_VERSION } from "../../../shared/protocol/shaperepair.js";
import * as eidosim from "./eidosim-v1.js";   // HER engine (the first eidosim, dialect 3): what a v1 punt did. Importer-only.
import { ENGINES, DEFAULT_ENGINE } from "../../../shared/protocol/simlayer.js";

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
    const { pos, yaw: yaw0, part, pose, ...rest } = s;
    // v1's renderer turned the seat by `yaw ?? 0` through three.js, which coerces ("1.5" turns it); what can't turn is carried
    const yaw = yaw0 == null ? 0 : Number(yaw0);
    if (!Number.isFinite(yaw)) rest.yaw = yaw0;
    out[slot] = { ...(pos !== undefined ? { pos } : {}), ...(Number.isFinite(yaw) && yaw !== 0 ? { q: yawQ(yaw) } : {}), ...(part !== undefined ? { part } : {}), body: pose !== undefined ? { pose } : {} };
    if (Object.keys(rest).length) left[slot] = rest;
  }
  if (Object.keys(left).length) c[keyed("imported", "sockets")] = left;
  return out;
}
// v1's captions bag held the session's newest lines (`window`) and the playhead (`mediaTime`); v4's holds the current line
// once (componentspec captions). The earlier lines are the log's own caption acts, so the window is derived, not carried.
function newCaptions(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Array.isArray(v.window) || !v.window.length) return v;
  const { window, mediaTime: _m, ...rest } = v;
  return { ...rest, line: window[window.length - 1] };
}
function newStory(v) {
  const out = { ...v };
  if (typeof v.practice === "string" && v.practice.trim()) out.text = (typeof v.text === "string" && v.text ? `${v.text}\n\n` : "") + v.practice.trim();
  if (typeof v.markedEntity === "string" && v.markedEntity) out.marks = [enc(v.markedEntity)];
  return out; // practice, markedEntity and anything else story doesn't define move to imported:story (splitUnknown)
}
// v1's spin took rpm or degPerSec; v4's is degPerSec (rpm × 6, lossless: the renderer read rpm × 6). degPerSec wins
// when both were written, as the renderer had it.
// @14 (R 10-17 21:40): v1's back-and-forth along an axis is written under today's name, oscillate (motionType: its one reading).
function newMotion(m0) {
  if (!m0 || typeof m0 !== "object" || Array.isArray(m0)) return m0;
  const m = motionType(m0) === m0.type ? m0 : { ...m0, type: motionType(m0) };
  if (!("rpm" in m)) return m;
  const { rpm, ...rest } = m;
  if (rest.degPerSec !== undefined) return rest;
  // the renderer's own reading, (rpm ?? 6) * 6 with JS coercion: a numeric string spun; a rate that isn't a number stays
  // in the motion, so splitUnknown carries it in imported:motion (R10)
  const rate = (rpm ?? 6) * 6;
  return Number.isFinite(rate) ? { ...rest, degPerSec: rate } : m;
}
// @12, wave 2 (the shape audit's physics-motion family): what the server's load repairs in a stored v4 world
// (shared/protocol/shaperepair.js), the translation writes already: a bare motion naming a part is motion:<part>,
// amplitude is amp, a letter axis its vector, a pendulum's unwritten period and damp the 3.5 s and 0 the renderer read, a
// whole pendulum with no pivot component swings about the [0, 2, 0] the renderer used (now its pivot component), a
// whole motion's pivot field is the thing's pivot, collider exact is mesh. A parent no longer carries order.
function shapeRepaired(c) {
  return repairComps(c).c;   // a node's motion is motion:<partSlot(name)> {node: name}: its key is already in the §2.3 grammar (review r7 F1)
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

export const TRANSLATOR = "eidoverse/translate-v1@23";
// @23 (R 10-27, audit B2): main's picture {src, part, look?, lit?, flip?} is a material on that node {node, texture,
// description?, lit?} (materialOf), where @22 made it a quad of its own at the thing's origin; flip: true, which the material
// can't say, rides imported:material and is listed. A picture with no part (main drew none) is carried as imported:picture.
// @22 (R 10-27): main's sound look is description (shaperepair renameFields, as the load renames a stored one), where @21 left
// it in imported:sound. Output differs from @21 on any log with a described sound. Both names.
/** The version number in a translator name ("eidoverse/translate-v1@20" → 20), or NaN. Compare numbers, never a regex
 *  of version digits: `@(1[4-9])` quietly stopped matching at @20 and broke four suites (10-22). */
export const translatorVersion = (name) => { const m = /@(\d+)$/.exec(String(name ?? "")); return m ? Number(m[1]) : NaN; };
// @21 (R 10-27): a pendulum with no maxAmp is written maxAmp 1.1, the old server's push cap (shaperepair OLD_READINGS), so a
// translated swing swings as it did when pushed. Output differs from @20 only on such a pendulum.
// @19 (house 6340433633): an old name already in the hashed form h--<61 hex> is escaped like any other name, never kept as
// that id (old logs never held one): a long name and a raw name equal to its hashed form were one thing id (people were
// already two: the directory keys them by name). Also since @18: a motion whose amplitude was null is carried as amp 0, as
// the old reader read it (shaperepair, 5ba2320f), where @18 dropped it. Output differs from @18 only on those two.
// @20 (the house's PR #10 into #260, on top of @19): its own output changed again, so it is a version of its own (two
// translators never share a name):
// a name is joined to an account only where v1's server wrote the pair itself (server/verbs.ts at 306a00b0: a grant's or
// a ban's sub beside its id, a spawn's or a light's placer {id, sub}, a behaviour's bySub, the act's own actor's). Elsewhere
// in an old request's args, inside data a v1 `comp` folded blindly, a name beside an account is data like any other: the
// account becomes its own person's id, and the name beside it is joined to nothing, so no value in the log moves anyone's
// later acts or role to another person. A binding's author is its bySub's person; the v1 fold's author is `by` where the
// request sent one, a name the request chose.
// The translated act's copy of the old genesis carries no account either: a genesis role's sub becomes its person's id, as an
// old request's does (the identities were found from it before: world.ts).
// A component whose name has an account's (`ownerSub`) and whose whole value is an account is one too: it is left out of the
// state, an old comp request's data becomes the person's id, and the writer's check reads both shapes.
// An account is any of the shapes a join wears (server/directory.ts): human:, agent:, aid1:, and a private server's local:.
// A role or ban keyed by an account is that account's person, and an entry keyed by one in a copied value is keyed by their
// id; the pairs main's server wrote (a placer, a behaviour's bySub) join a name to its account before any act is read
// (world.ts), as a grant's do, so a person's acts before them are that one identity too.
// @18 (the house's review of #260, importer items): an approved translation's translation-approved act is written by translate
// itself, so every later change's cause is the act it answers (I1); v1's captions bag (a window of lines) is today's current
// line, the old fold reading its own frozen modules (frozen/, 6dab22f5) (I3); a caption deed is a place in its screen's captioners (I13); a spin's rpm and a
// seat's yaw are read as the renderer coerced them, and what can't be read is carried (I36, I37); an earlier epoch's rest tick
// never dates a later epoch's rest (I14). Output differs from @17 on any log with captions, a caption deed, a non-numeric rpm
// or seat yaw, a physics epoch replaced after a rest, and on every approved translation. Both names.
// @17 (R 10-21): the base rung is inhabitant (v1's visitor is written inhabitant), and there's no rung below it: a person's v1
// spectator or none grant is CARRIED as imported-roles:<id> (never dropped, R10), with no roles:<id>, so they hold the
// world's newcomer role (absent default-role: inhabitant). The door's own words (`*` none/spectator) still become access.
// @16 (review of #260): no account subject is written wherever it sits. A property named `sub` or ending in
// `Sub` whose string has an account's shape is one, at any depth (withoutAccounts, below): in an imported act's args it
// becomes the person's id when a mapper is given and is dropped when none is; in a value it is always dropped. Any other
// string under such a name is ordinary data and stays as it was (a v1 `comp` folded its data blindly). A binding's author is
// found through its account, as the author's grant is, so the two are one identity on every server. Both names.
// @15 (2026-10-18, merging upstream #256, particles v2): v1 gained more than one emitter per thing, `particles:<name>` beside
// `particles` (name: 1–32 of A–Z a–z 0–9 _ -), each lit, retuned and put out on its own. v4 keeps one `particles` per thing
// (several emitters that burn together are one effect document's emitters); an emitter lit and put out on its own is its
// own thing. So a v1 `particles:<name>` on X becomes a child thing of X (parent {to: X}, label <name>, at X's origin) whose
// `particles` is the emitter in today's spelling, its id derived (emitterChildId: the same from every translation), its
// seed the one v1 drew it with (hashSeed(`<X>:particles:<name>:<preset>`), unless it wrote one). Putting it out removes
// the child. A malformed `particles:…` key was never an emitter in v1 either: it is carried as any invented component.
// v2's look and motion knobs (wobble, up, spread, gravity, grow, swirl, twinkle, converge, rotate, color, blending) are
// the old builder's table, which an effect document's modules say in full: they ride in imported:particles (carried,
// not drawn), and v2's `scale` is the instance's scale. Output differs from @14 on any log with a named emitter.
// @14 (R 10-17 21:40): a motion's type is written in today's spelling: v1's back-and-forth along an axis is oscillate (the load
// renames a stored one the same way: shaperepair.js renameFields). Output differs from @13 on any log with that motion. Both names.
// @13 (review r9 claims O3, 2026-10-17): every translation writes the system's repair-shapes act right after `translated`
// (the shape repair's once-per-world marker, review r8 M3), one entry @12 didn't. Its projection is @12's; its log is one
// entry longer. Both names move to @13 (the name says which output you got).
// @12 (2026-10-16, the shape audit's wave 1): no account subject (`sub`) is ever written, mapper or not (PROTOCOL §9.2: no
// person data in values): roles:<id> and imported-bans:<id> lose it, and an imported act's raw v1 args lose it too when no
// identity mapper is given (with one, it becomes the person's id, as before). A dialect-3 epoch her sim refused is carried
// as imported:epoch (was the imported-epoch component). Both names (with and without her sim) move to @12.
// @12, wave 2 (the shape audit's physics-motion family): a stored value's old spelling is written in today's (shapeRepaired,
// below; shared/protocol/shaperepair.js, the same rules the server's first load applies to a stored v4 world), and a
// parent carries no order. Output differs on any log with a motion, a collider or a mount.
// @12, wave 2 (the shape audit's render-media-env family): the same repair's render rules: a light carries decay 1.7 (the
// rig's old falloff) and daytime (was day), no shadows; @world's sky, terrain
// (+ the water component) and grass in today's spelling. Output differs on any log with a light, particles, sky, terrain
// or grass.
// @12 (R 10-17): a model stays its library path, with model-hash sha256:<64 hex> beside it when the caller's resolver knows the
// bytes (was @8's eido:sha256/<64 hex> in its place); a particle Essential keeps its name and a grass preset its name (the
// wave-2 render notes above wrote the address and the strokes). Output differs on any log with a model, particles or grass.
// @12, wave 2 (the shape audit's attach-interact family): a lock is written in its one spelling, {rank: 'builder'} (a v1
// lock: true, and a guard merged into it, were true). Sockets stay the v1 map with each seat's body block: the server's
// lift (authority/sockets.js) makes them socket children with a station at first load, as for any older v4 log.
// @10 (2026-10-08): a dialect-3 log (one with a physics `epoch`, PROTOCOL_v2 §3) is translated with her sim run beside the
// v1 fold (what translate-d3 did on its own, now on this one path with its identities, model hashes, founder key and
// namespace): a punt is a logged launch with its exact stamped state, every rest a logged result the authority's sim layer
// re-checks (design 20, P5/L3), the epoch is @world physics-engine and each collider's stamped box its physics.shape.
// Before this, @9 kept a punt only as an imported act and left the thing where it was punted FROM. A log with no epoch
// that her sim enters translates byte-for-byte as @9 did, so it keeps @9's name: the name says which output you got.
// @11 (2026-10-09, R 04:18: "stomp the existing eidosim engine"): the runtime no longer carries her engine, so her
// flights are no longer replayed by readers. Her sim still runs here, beside the v1 fold, and still says where each punt
// came to rest; but a punt stays its imported act (no v4 launch), each rest is a plain change by `sim` caused by that act
// (no digest), the world's engine is today's eidosim from the epoch on, and (R 2026-10-08) a thing v1 ever punted is a
// `dynamic` collider, every other one `static`. Nothing in the new log asks a reader to fly her engine.
export const TRANSLATOR_SIM = "eidoverse/translate-v1@23";
// @9 (2026-10-07, R's particles ruling): a v1 `particles` bag is today's instance: its preset is the effect, its origin is
// `at`, its seed stays, and its count, size, opacity, speed, lifetime, area, texture and quality are the params of the
// same names every Essential declares (shared/particle_effects.js modernize; instanceOf reads it back exactly). A key
// neither spelling knows rides in imported:particles as before. Output differs from @8 on any log with particles.
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
// Tier 0 of a translated world is EMPTY (#260 rereview, blocker 1): v1 logs record accounts, never keys, so nothing can yet
// bind a key to the old world's owner, and a translation names no founder. The operator (custody) is tier 1. The reserved
// governance draft (§13) must allow ONE attested fill of a translated world's empty tier 0 later, once something (a home-node
// attestation) can vouch that a key is the v1 owner's. A world FOUNDED new (create-world ownerKey) is a different path.
export function translatedGenesis(oldEntries, { key = LAB_DOOR_KEY, operator = key, nonce } = {}) {
  if (!nonce) { const h = sha256(oldEntries.map((e) => JSON.stringify(e)).join("\n")); nonce = b64url(Uint8Array.from(h.slice(0, 32).match(/../g), (x) => parseInt(x, 16))); }
  return { dialect: DIALECT, v: VERSION, minor: 0, nonce, owners: [[], [operator]], sequencer: key };
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
  "roles.<person> spectator / none": "there is no rung below inhabitant (@17, R 10-21): the grant is carried as @world imported-roles:<id> as it was, and the person holds the world's newcomer role; v1's visitor is written inhabitant",
  "roles['*']": "becomes @world `default-role` (the declared role for anyone not named); '*' is not an identity (§2.3); a `*` of none / spectator (upstream world access) becomes @world `access` {join: listed (, watch: anyone)}",
  "comp.guard": "merged into `lock` (PROTOCOL-v4 §5, R 19:58): a truthy guard becomes lock {rank: 'builder'} (@12; was true), which binds everyone (the placer too) and any builder may lift; the guard's authorship protection is dropped by design. stats.guards counts the things this happened to, so the world's owners can be told",
  "roles.<person>.caption": "a v1 caption deed (to caption one thing while it is the incarnation the deed was granted for) becomes the person's place in that thing's captioners {ids}; a deed on a timed grant, or for a thing replaced or gone, stays carried in imported:roles:<id> (captioners has no end)",
  "captions.window / captions.mediaTime": "v1's bag kept the session's newest lines and the playhead; v4's captions holds the current line (the window's last). The earlier lines are the log's own caption acts",
  "comp.door": "renamed `openable` (R 10-07), and a reaction's component 'door' with it: the same value under v4's name (@5)",
  "roles.sub / bans.sub": "an account subject is person data (PROTOCOL §9.2): never written into a value (@12). With an identity mapper it is how the person's id is found (the key); without one it is dropped. A ban's `by`, who banned, stays as v1 kept it, unless it is itself an account: then it is that person's id (@19), or dropped without a mapper",
  "behaviors.authorSub, and any other account in a value": "the binding's author's account (the v1 server's bySub), and any account-shaped sub or *Sub a value carries: never written into a value (@16). With an identity mapper the binding's is how its author's id is found; without one it is dropped. A sub or *Sub that isn't account-shaped is ordinary data and stays, except a grant's or a ban's own top-level sub, the server's stamp of the person's account (roles.sub / bans.sub)",
  "an entry keyed by an account in a value, and a component an account names and fills": "an entry keyed by an account in a value, or a component whose name has an account's (`ownerSub`) and whose whole value is one, is person data (PROTOCOL §9.2): in the state it is dropped with what it held (@19); in a copied request (the translated act's genesis, an old request) an entry keyed by one is keyed by its person's id, and a comp request's data becomes it, each dropped without an identity mapper. A role or ban kept by its account isn't a value: it is kept, keyed by its person's id (with a mapper) or by its account, encoded (without one)",
  "comp['particles:<name>']": "a thing's second (third, …) emitter (upstream #256) becomes a child thing carrying it: parent {to: the thing}, label <name>, its own `particles`, its seed the one v1 drew it with (@15). v4 keeps one particles per thing",
  "particles.wobble / up / spread / gravity / grow / swirl / twinkle / converge / rotate / color / blending": "upstream #256's preset overrides (the old builder's table): carried in imported:particles, not drawn; v4 says that look in an effect document's modules (velocity, forces.gravity, size.curve, color, render.blend, drift, swirl, converge, flicker, rotation). `scale` is the instance's own scale",
  "sound.look": "renamed description (@21, R 10-27): the same words under today's name",
  "picture.flip false": "main's default (the node's own UVs): the material's own reading, so nothing is written (@22)",
  "motion.rpm": "becomes degPerSec = rpm × 6 (@5): the rate the renderer drew, under the authority's one name for it",
  "motion.type": "the back-and-forth along an axis is written oscillate (@14, R 10-17 21:40; shared/protocol/names.js OLD_MOTION_TYPES holds the old word): the same motion under today's name",
  "motion.part": "a bare motion naming a part becomes motion:<slot> {node: <the part's name>} (@12; the slot is shared/protocol/names.js partSlot of the name: the name itself when it is a §2.3 tag, else a sanitized form with 8 hex of its sha256): when the thing already has a motion on that node, that one wins and the bare one is dropped (the renderer drew both on one node, the keyed one last). A keyed motion carries node (its key's tag, the old reading)",
  "a mounted thing's own pos/yaw/q": "v1 keeps a riding thing's pre-mount pose, unused until a dismount; v4's transform IS the pose it rides at (local to its parent: v1's offset, or its socket's pos, and q/yaw). The parent's offset/yaw/q are that transform, not a second copy (L2)",
};
// DEFERRED (review of PR #260, Mica, item 7): features main's merges gave v1 worlds that THIS protocol does not carry yet.
// Each is a component the old renderer read (tools/water/README.md, server/render-scene.ts PASS_THROUGH). The translator
// never carries one of these quietly: a log that uses one is REFUSED at `translate`, naming the feature and where it was
// used (deferredFeatures below), and the dry-run report lists them, so the owner decides with the loss in front of them.
// Main's water volume and air boxes are carried (VOLUMES below), except on @world, which has no frame of its own to hold them.
// Empty since step 3b (the vehicle is carried: CARRIED below); a volume on @world (ON_WORLD) is the one use still refused.
export const DEFERRED = {};
// main #248's climb routes, collision toggle and environment, each to its home (spec/PROTOCOL.md §14; DESIGN.md env-components)
// Still @20: traversal and collision were refused at @20 (no translated log held one), and environment came only with them, in #248's water world
export const CARRIED = {
  traversal: { feature: "climb route", to: "one child per route: climb {points (path), reach (radius), speed} + label (name)" },
  collision: { feature: "collision on/off toggle", to: "collider {enabled}" },
  vehicle: { feature: "vehicle", to: "drive {maxSpeed: speed, turnRate, climbRate: speed} on the host + a helm child (socket at helm, station {action: 'drive', input: {move: 'drive'}, exit}); minY, maxY, probes → imported:vehicle, listed" },
  picture: { feature: "picture on a model's part", to: "material {node: part, texture: src, description: look, lit} (flip: true has no field there: imported:material, listed); with no part: imported:picture, listed" },
  environment: { feature: "environment", to: "spawn → @world.spawn (else a spawn-point thing), bounds → @world.bounds (its min.y lowered to 2 m below a flat floor under it), floor → @world.terrain {kind: 'flat', height} (unless the world has a terrain: then listed, unmapped), sky → @world.sky.gradient + a directional light thing (the sun), particles → a particles {effect: 'dust'} child; the rest imported:environment, listed" },
};
/** main's picture (an image on a named part of its model) → {material, left (imported:material), whole (imported:picture,
 *  when there is no part to put it on: main drew nothing then)}. A flip of false is main's default, the material's own. */
export function materialOf(d) {
  const v = d && typeof d === "object" && !Array.isArray(d) ? d : {};
  if (typeof v.part !== "string" || !v.part.trim()) return { material: null, left: null, whole: d };
  const { part, src, look, flip, ...rest } = v;
  return { material: { ...rest, node: part.trim(), texture: src, ...(look !== undefined ? { description: look } : {}) }, left: flip === undefined || flip === false ? null : { flip }, whole: null };
}
export const climbChildId = (host, i) => `climb-${i}-${sha256(`eido-climb\0${host}\0${i}`).slice(0, 26)}`;
export const helmChildId = (host) => `helm-${sha256(`eido-helm\0${host}`).slice(0, 26)}`;
/** main's vehicle {helm, exit, speed, turnRate, minY?, maxY?, probes} → {drive, helm: [id, components] | null, left (no home: imported:vehicle)}; main's clamps */
export function vehiclePartsOf(host, d) {
  const v = d && typeof d === "object" && !Array.isArray(d) ? d : {}, v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const { helm, exit, speed, turnRate, ...rest } = v, s = clampN(speed, 0.1, 15, 4);
  const drive = { maxSpeed: s, turnRate: clampN(turnRate, 0.1, 2, 0.45), climbRate: s };   // main normalised (0, ½·rise, thrust) × speed: straight up ran at speed
  const kid = v3(helm) ? [helmChildId(host), { transform: ID_POSE([...helm]), parent: { to: host }, socket: { name: "helm" }, label: "helm",
    station: { action: "drive", input: { move: "drive" }, leaveBy: "menu", ...(v3(exit) ? { exit: [...exit] } : {}) } }] : null;   // main left the helm by its E alone: Space rises
  const left = { ...rest, ...(kid ? {} : { helm }), ...(exit !== undefined && !v3(exit) ? { exit } : {}) };
  return { drive, helm: kid, left };
}
export const envChildId = (host, part) => `${part}-${sha256(`eido-environment\0${host}\0${part}`).slice(0, 26)}`;
const clampN = (x, lo, hi, d) => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d);
/** main's traversal {routes} → {children: [[id, components]], left (routes no climb can hold: carried on the host)} */
export function climbPartsOf(host, d) {
  const children = [], left = [];
  (Array.isArray(d?.routes) ? d.routes : []).forEach((r, i) => {
    const pts = r?.path, ok = Array.isArray(pts) && pts.length >= 2 && pts.length <= 16 && pts.every((p) => Array.isArray(p) && p.length === 3 && p.every((x) => Number.isFinite(x) && Math.abs(x) <= 1e4));
    if (!ok) { left.push(r); return; }
    const { name, path, radius, speed, ...rest } = r;
    children.push([climbChildId(host, i), { transform: ID_POSE([0, 0, 0]), parent: { to: host }, label: typeof name === "string" && name ? name.slice(0, 80) : "ladder",
      climb: { points: path.map((p) => [...p]), reach: clampN(radius, 0.3, 3, 1.4), speed: clampN(speed, 0.3, 4, 1.3) }, ...(Object.keys(rest).length ? { [keyed("imported", "climb")]: rest } : {}) }]); });
  return { children, left };
}
// '#rrggbb' (or 0xRRGGBB) sRGB → linear [r, g, b], as three.js's Color reads one
const srgbLin = (c, d) => { const n = typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : Number.isInteger(c) ? c : d;
  return [16, 8, 0].map((k) => { const x = ((n >> k) & 255) / 255; return +(x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).toFixed(6); }); };
const hexInt = (c, d) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? parseInt(c.slice(1), 16) : Number.isInteger(c) ? c : d);
// the rotation taking +Z to unit d (the sun stands along its light's +Z: it shines along its -Z)
function qZTo(d) { const n = Math.hypot(...d); if (!(n > 0)) return [0, 0, 0, 1]; const [x, y, z] = d.map((v) => v / n);
  if (z < -1 + 1e-9) return [0, 1, 0, 0]; const w = 1 + z, q = [-y, x, 0, w], m = Math.hypot(...q); return q.map((v) => +(v / m).toFixed(9)); }
/** main's environment {floor, spawn, bounds, sky, particles, …} on `host` → {world: {spawn?, bounds?, sky?, terrain?}, things, left (no home:
 *  imported:environment), fields (what went where, for the report)}. `has`: what @world already holds (spawn, bounds, terrain). Main's own
 *  readings (watervolumes.js) are the defaults: a sky lights a sun at [0.4, 0.8, 0.2], #fff4df, 3. */
export function environmentPartsOf(host, env, has = {}) {
  const world = {}, things = [], left = {}, fields = [];
  const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  const { floor, spawn, bounds, sky, particles, ...rest } = env && typeof env === "object" && !Array.isArray(env) ? env : {};
  const B = bounds && v3(bounds.min) && v3(bounds.max) && [0, 1, 2].every((i) => bounds.min[i] < bounds.max[i]) ? bounds : null;
  if (B && !has.bounds) { world.bounds = { min: [...B.min], max: [...B.max] }; fields.push(["bounds", "@world.bounds"]); } else if (bounds !== undefined) { left.bounds = bounds; fields.push(["bounds", null]); }
  if (v3(spawn) && !has.spawn) { world.spawn = { pos: [...spawn] }; fields.push(["spawn", "@world.spawn"]); }
  else if (v3(spawn)) { const id = envChildId(host, "spawn"); things.push([id, { transform: ID_POSE([...spawn]), label: "arrival", "spawn-point": {} }]); fields.push(["spawn", id]); }
  else if (spawn !== undefined) { left.spawn = spawn; fields.push(["spawn", null]); }
  // the floor is the ground: a flat terrain at its height; a world that already has a terrain keeps it, the floor listed as the conflict
  if (Number.isFinite(floor) && !has.terrain) { world.terrain = { kind: "flat", height: Math.min(1e4, Math.max(-1e4, floor)) }; fields.push(["floor", "@world.terrain"]); }
  else if (floor !== undefined) { left.floor = floor; fields.push([Number.isFinite(floor) ? "floor (the world already has a terrain)" : "floor", null]); }
  if (sky && typeof sky === "object" && !Array.isArray(sky)) { const { horizon, zenith, sunColor, sunIntensity, sunDirection, ...skyRest } = sky;
    world.sky = { gradient: { top: srgbLin(zenith, 0x3686b8), horizon: srgbLin(horizon, 0xb8d4e0) } }; fields.push(["sky.horizon, sky.zenith", "@world.sky.gradient"]);
    const id = envChildId(host, "sun"), dir = v3(sunDirection) && Math.hypot(...sunDirection) > 0 ? sunDirection : [0.4, 0.8, 0.2];
    things.push([id, { transform: ID_POSE([0, 0, 0], qZTo(dir)), label: "sun", light: { kind: "directional", color: hexInt(sunColor, 0xfff4df), intensity: Number.isFinite(sunIntensity) ? Math.max(0, sunIntensity) : 3, decay: 2, daytime: "full" } }]);
    fields.push(["sky.sunColor, sky.sunIntensity, sky.sunDirection", id]);
    if (Object.keys(skyRest).length) { left.sky = skyRest; fields.push([Object.keys(skyRest).map((k) => `sky.${k}`).join(", "), null]); } }
  else if (sky !== undefined) { left.sky = sky; fields.push(["sky", null]); }
  if (particles && typeof particles === "object" && !Array.isArray(particles)) { const id = envChildId(host, "particles"), p = particles;
    const count = clampN(Math.floor(p.count), 1, 600, 600), size = clampN(p.size, 0.005, 4, 0.018), area = clampN(p.range, 0, 8, 8);
    things.push([id, { transform: ID_POSE([0, 0, 0]), parent: { to: host }, label: "particles", particles: { effect: "dust", params: { count, size, area } } }]); fields.push(["particles", id]);
    const kept = { count: p.count === count, size: p.size === size, range: p.range === area };   // a clamped value, or one the effect has no knob for, rides along
    const lost = Object.fromEntries(Object.entries(p).filter(([k]) => !kept[k]));
    if (Object.keys(lost).length) { left.particles = lost; fields.push([Object.keys(lost).map((k) => `particles.${k}`).join(", "), null]); } }
  else if (particles !== undefined) { left.particles = particles; fields.push(["particles", null]); }
  if (Object.keys(rest).length) { Object.assign(left, rest); fields.push([Object.keys(rest).join(", "), null]); }
  return { world, things, left, fields };
}
/** Every environment in a v1 state, in id order, as project() places it: [{id (as written), host, parts}]. The first one's spawn
 *  and bounds go to @world; a later one's spawn is a spawn-point and its bounds ride imported:environment. */
export function environmentPlan(st) {
  const out = [], has = { terrain: st?.terrain != null };
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const env = st.entities[id]?.comp?.environment; if (env == null) continue;
    const parts = environmentPartsOf(enc(id), env, { ...has }); if (parts.world.spawn) has.spawn = true; if (parts.world.bounds) has.bounds = true; if (parts.world.terrain) has.terrain = true;
    out.push({ id, host: enc(id), parts }); }
  // a flat ground below the bounds' floor would count everyone standing on it as fallen (#248): bounds.min.y goes 2 m under it
  const b = out.find((x) => x.parts.world.bounds), t = out.find((x) => x.parts.world.terrain);
  const ground = t ? t.parts.world.terrain.height : st?.terrain?.kind === "flat" && Number.isFinite(st.terrain.height) ? st.terrain.height : undefined;
  if (b && Number.isFinite(ground) && ground < b.parts.world.bounds.min[1]) { const was = b.parts.world.bounds.min[1]; b.parts.world.bounds.min[1] = ground - 2; b.parts.lowered = { was, now: ground - 2 }; }
  return out;
}
const VOLUME_FIELDS = ["center", "size", "absorption", "scatter", "waves"];
const ON_WORLD = { water: { feature: "water volume on @world", since: "main #248 (Unreal native client) / #254" }, air: { feature: "air box on @world", since: "main #248" } };
// main #248's water volume and air boxes as zone + water / water-exclusion things (spec/PROTOCOL.md §14; tools/water/requests.js too)
export const VOLUMES = {
  water: { feature: "water volume", to: "zone {shape: 'box', size} + water, on the thing (no model or light, centred) or a child at its centre" },
  air:   { feature: "air box (dry interior)", to: "one child per box: zone {shape: 'box', size, priority: 1} + water-exclusion {}, its centre and q its transform" },
};
export const AIR_PRIORITY = 1;
export const waterChildId = (host) => `water-${sha256(`eido-water\0${host}`).slice(0, 26)}`;
export const airChildId = (host, i) => `air-${i}-${sha256(`eido-air\0${host}\0${i}`).slice(0, 26)}`;
const vec3 = (v, d) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? [...v] : [...d]);
const ID_POSE = (pos, q = [0, 0, 0, 1]) => ({ pos, q, scale: [1, 1, 1] });
/** main's water {center, size, absorption?, scatter?, …} → {center, zone, water} (sizes as main's waterParams reads them) */
export function waterOfOld(d) {
  const { center, size, absorption, scatter, ...rest } = d;
  const water = { ...rest };
  if (Array.isArray(absorption)) { water.attenuationColor = vec3(absorption, [0.16, 0.055, 0.025]).map((x) => Math.exp(-Math.max(0, x))); water.attenuationDistance = 1; }
  if (Array.isArray(scatter)) water.scatterColor = vec3(scatter, [0.015, 0.12, 0.18]).map((x) => Math.max(0, x));
  return { center: vec3(center, [0, 0, 0]), zone: { shape: "box", size: vec3(size, [200, 200, 200]).map((x) => Math.max(0.01, Math.min(1e4, Math.abs(x)))) }, water };
}
/** One old thing's water / air as [id, components] parts: `own` is merged into the thing's components, `children` are new
 *  things under it. `c` is the thing's components so far (its model, light). */
export function volumePartsOf(host, comp, c) {
  const own = {}, children = [];
  const w = comp?.water;
  if (w && typeof w === "object" && !Array.isArray(w)) {
    const m = waterOfOld(w);
    if (c.model === undefined && c.light === undefined && m.center.every((x) => x === 0)) Object.assign(own, { zone: m.zone, water: m.water });
    else children.push([waterChildId(host), { transform: ID_POSE(m.center), parent: { to: host }, label: "water", zone: m.zone, water: m.water }]);
  }
  const boxes = Array.isArray(comp?.air?.boxes) ? comp.air.boxes : [];
  boxes.forEach((b, i) => { if (!b || typeof b !== "object" || Array.isArray(b)) return;
    children.push([airChildId(host, i), { transform: ID_POSE(vec3(b.center, [0, 0, 0]), qNorm(b.q) ?? [0, 0, 0, 1]), parent: { to: host }, label: `dry box ${i + 1}`,
      zone: { shape: "box", size: vec3(b.size, [1, 1, 1]).map((x) => Math.max(0.001, Math.min(1e4, Math.abs(x)))), priority: AIR_PRIORITY }, "water-exclusion": {} }]); });
  return { own, children };
}
/** The water volumes and air boxes a v1 state holds, as the report lists them: [{component, feature, id (as written), into (ids)}] */
export function volumeMappings(st) {
  const out = [];
  for (const [id, e] of Object.entries(st?.entities ?? {})) for (const k of ["water", "air"]) {
    if (e?.comp?.[k] == null) continue;
    const c = { ...(e.lib !== undefined ? { model: e.lib } : {}), ...(e.kind === "light" ? { light: {} } : {}) };
    const { own, children } = volumePartsOf(enc(id), { [k]: e.comp[k] }, c);
    out.push({ component: k, feature: VOLUMES[k].feature, id, into: [...(Object.keys(own).length ? [enc(id)] : []), ...children.map(([cid]) => cid)] });
  }
  return out;
}
/** main #248's climb routes, collision toggles and environments a v1 state holds, as the report lists them: [{component, feature, id, into}] */
export function carriedMappings(st) {
  const out = [], env = new Map(environmentPlan(st).map((x) => [x.id, x.parts]));
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const comp = st.entities[id]?.comp ?? {};
    if (comp.traversal != null) out.push({ component: "traversal", feature: CARRIED.traversal.feature, id, into: climbPartsOf(enc(id), comp.traversal).children.map(([cid]) => cid) });
    if (comp.vehicle != null) { const v = vehiclePartsOf(enc(id), comp.vehicle); out.push({ component: "vehicle", feature: CARRIED.vehicle.feature, id, into: [enc(id), ...(v.helm ? [v.helm[0]] : [])] }); }
    if (comp.collision != null) out.push({ component: "collision", feature: CARRIED.collision.feature, id, into: comp.collision?.enabled === false ? [enc(id)] : [] });
    if (comp.picture != null && materialOf(comp.picture).material) out.push({ component: "picture", feature: CARRIED.picture.feature, id, into: [enc(id)] });
    if (env.has(id)) out.push({ component: "environment", feature: CARRIED.environment.feature, id, into: [...new Set(env.get(id).fields.map(([, to]) => to).filter(Boolean))] });
    if (env.get(id)?.lowered) out.push({ component: "environment", feature: "bounds.min.y lowered to 2 m below the floor (the floor lay below the bounds)", id, into: ["@world.bounds"], ...env.get(id).lowered }); }
  return out;
}
/** What of them has no home here, carried as imported:<component> on its thing: [{component, id, fields, as}] */
export function unmappedOf(st) {
  const out = [];
  for (const { id, host, parts } of environmentPlan(st)) { const f = parts.fields.filter(([, to]) => to === null).map(([k]) => k); if (f.length) out.push({ component: "environment", id, fields: f, as: `${host} imported:environment` }); }
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const comp = st.entities[id]?.comp ?? {};
    if (comp.traversal != null) { const n = climbPartsOf(enc(id), comp.traversal).left.length; if (n || !Array.isArray(comp.traversal?.routes)) out.push({ component: "traversal", id, fields: n ? [`${n} route(s) no climb holds (2–16 points)`] : ["routes"], as: `${enc(id)} imported:traversal` }); }
    if (comp.vehicle != null) { const f = Object.keys(vehiclePartsOf(enc(id), comp.vehicle).left); if (f.length) out.push({ component: "vehicle", id, fields: f, as: `${enc(id)} imported:vehicle` }); }
    if (comp.collision != null && typeof comp.collision === "object") { const f = Object.keys(comp.collision).filter((k) => k !== "enabled"); if (f.length) out.push({ component: "collision", id, fields: f, as: `${enc(id)} imported:collision` }); }
    if (comp.picture != null) { const m = materialOf(comp.picture);
      if (m.left) out.push({ component: "picture", id, fields: Object.keys(m.left), as: `${enc(id)} imported:material`, why: "upside-down UVs: the material has no field for a texture transform yet (glTF's KHR_texture_transform)" });
      if (m.whole != null) out.push({ component: "picture", id, fields: ["part"], as: `${enc(id)} imported:picture`, why: "no part to put it on: main drew nothing" }); } }
  return out;
}
/** Every use in a v1 log of a feature v4 doesn't carry yet that still stands at its end: [{component, feature, id, seq,
 *  actor, ts}], in log order. A `comp` that removes one (data null), or a `remove` of its thing, ends the uses before it,
 *  so removing it on the old server (the refusal's remedy) clears the refusal. Empty for every old world on Burrow and every
 *  fixture (checked 2026-10-18). */
export function deferredFeatures(oldEntries) {
  const standing = new Map();   // `${id}\0${type}` → the uses since it was last removed
  oldEntries.forEach((e, k) => {
    if (e?.verb === "remove" && e.args?.id != null) { const pre = `${String(e.args.id)}\0`; for (const key of [...standing.keys()]) if (key.startsWith(pre)) standing.delete(key); return; }
    if (e?.verb !== "comp" || typeof e.args?.type !== "string") return;
    const t = e.args.type, d = e.args.data;
    const onWorld = e.args.id === "@world" && Object.hasOwn(ON_WORLD, t);
    if (!Object.hasOwn(DEFERRED, t) && !onWorld) return;
    const key = `${String(e.args.id)}\0${t}`;
    if (d == null) { standing.delete(key); return; }
    if (t === "water" && onWorld && !(d && typeof d === "object" && VOLUME_FIELDS.some((f) => f in d))) { standing.delete(key); return; }   // the world's water level: carried
    const uses = standing.get(key) ?? []; standing.set(key, uses);
    uses.push({ component: t, feature: (onWorld ? ON_WORLD : DEFERRED)[t].feature, id: String(e.args.id), seq: Number.isInteger(e.seq) ? e.seq : k, actor: String(e.actor ?? "?"), ...(Number.isInteger(e.ts) ? { ts: e.ts } : {}), at: k });
  });
  return [...standing.values()].flat().sort((x, y) => x.at - y.at).map(({ at: _a, ...u }) => u);
}
/** The refusal, in words: which feature, on what, by whom, when (seq). One line per use; null when nothing is deferred. */
export function deferredRefusal(uses, world = "this world") {
  if (!uses.length) return null;
  const kinds = [...new Set(uses.map((u) => u.feature))];
  return `can't translate ${world}: it uses ${uses.length} thing(s) this protocol does not carry yet — ${kinds.join(", ")} — and translating would drop them silently. `
    + `Nothing was written. Where:\n` + uses.map((u) => `  seq ${u.seq}: ${u.feature} (\`${u.component}\` component) on "${u.id}", set by ${u.actor}${u.ts ? ` at ${new Date(u.ts).toISOString()}` : ""}`).join("\n")
    + `\nThese came from main's merges (${[...new Set(uses.map((u) => (DEFERRED[u.component] ?? ON_WORLD[u.component]).since))].join("; ")}) and are deferred in this protocol. Either wait for the protocol to carry them, or remove them from the old world first (the old server's \`comp\` with data null) and translate again.`;
}

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
// Without one (the pure tests, the sweep), names are escaped as before; `sub` never stays in a value (@12).
// v1's own system actors (v1 vocabulary: the v1 server wrote "door"); in v4 the authority's own acts are actor `system`
const SYSTEM = new Set(["door", "world", "sim"]);
// @16: an account subject is a property named `sub` or ending in `Sub` whose string has an account's shape (isAccount, which
// world.ts's identity mapper reads too). Main's server stamped three into its log (server/verbs.ts at 306a00b0): a grant's or
// ban's sub, a creation's placer {id, sub}, a binding's bySub (the v1 fold's authorSub). The shape, not the name alone: v1's
// `comp` folded any data, so `sub` can be a sign's subtitle, and shared/particle_effects.js reserves `sub` as an effect's
// emitter field. Whose account it is: the account's own (@19); the name beside it is joined to it only where main's server
// wrote the pair (translate's noAcct), never from a value.
export const isAccount = (s) => typeof s === "string" && /^(human|agent|aid1|local):/.test(s);
/** A NAME that is an account (a role or a ban keyed by it, an actor that is one): every shape but local:, which a private
 *  server gives a bare name in a sub position only, so a person may well be called `local:ann` and isn't an account. */
export const isAccountName = (s) => typeof s === "string" && /^(human|agent|aid1):/.test(s);
const ACCOUNT_KEY = /^sub$|Sub$/;
/** Whether a component's name has an account's, read as written under its namespace and its escape (`imported/x--…`):
 *  the one reading the scrub and the writer's check share. */
const accountNamed = (n) => typeof n === "string" && ACCOUNT_KEY.test(dec(n.slice(n.lastIndexOf("/") + 1)) ?? n);
/** `v` with every account subject in it, at any depth, replaced by what `map(sub)` gives, or dropped where that's undefined
 *  (the default). The same object when nothing in it is an account (the projection's values can be the old fold's own). */
export function withoutAccounts(v, map = () => undefined) {
  if (Array.isArray(v)) { let out = null; v.forEach((x, i) => { const y = withoutAccounts(x, map); if (y !== x) (out ??= v.slice())[i] = y; }); return out ?? v; }
  if (!v || typeof v !== "object") return v;
  let out = null;
  for (const [k, x] of Object.entries(v)) {
    if (ACCOUNT_KEY.test(k) && isAccount(x)) {
      out ??= { ...v }; const to = map(x);
      if (to === undefined) delete out[k]; else out[k] = to; continue; }
    // a map keyed by an account (a genesis role, a ban, as v1 could key them): the entry under its person's id, or dropped
    if (isAccountName(k)) { out ??= { ...v }; delete out[k]; const to = map(k); if (to !== undefined && !Object.hasOwn(out, to)) out[to] = withoutAccounts(x, map); continue; }
    const y = withoutAccounts(x, map); if (y !== x) (out ??= { ...v })[k] = y;
  }
  return out ?? v;
}
/** The first account subject a log still carries, as {seq, path}, or null: the writer's check before anything is written
 *  (world.ts translateV1World). It reads what the scrub reads: a property named as above holding an account-shaped string;
 *  a key that is one; an id naming a person that is one (an old grant's, ban's or unban's, or a spawn's or light's
 *  placer's), and an imported ban's `by` that is one; and a component so named whose value is one (a change's op {comp, value}, an old comp request's {type,
 *  data}). Elsewhere an `id`, like any key not named as above, holds data. */
export function accountIn(entries) {
  const named = (v) => [["comp", "value"], ["component", "value"], ["type", "data"]].find(([n, x]) => accountNamed(v[n]) && isAccount(v[x]));
  // an id is an account where it names a person, as the scrub (noAcct) maps one; and an imported ban's `by` (project's unby)
  const banBy = (v) => { const c = v.comp ?? v.component; return typeof c === "string" && c.startsWith("imported-bans:") && v.value && typeof v.value === "object" && isAccountName(v.value.by); };
  const person = (v) => (banBy(v) ? "value.by" : !v.args || typeof v.args !== "object" ? null : PERSON_REQUESTS.has(v.verb) && isAccountName(v.args.id) ? "args.id"
    : (v.verb === "spawn" || v.verb === "light") && v.args.placer && typeof v.args.placer === "object" && isAccountName(v.args.placer.id) ? "args.placer.id" : null);
  const find = (v, path) => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const f = find(v[i], `${path}[${i}]`); if (f) return f; } return null; }
    if (!v || typeof v !== "object") return null;
    const n = named(v); if (n) return path ? `${path}.${n[1]}` : n[1];
    const pn = person(v); if (pn) return path ? `${path}.${pn}` : pn;
    for (const [k, x] of Object.entries(v)) { const p = path ? `${path}.${k}` : k;
      if ((ACCOUNT_KEY.test(k) && isAccount(x)) || isAccountName(k)) return p; const f = find(x, p); if (f) return f; }
    return null; };
  for (const [i, e] of entries.entries()) { const p = find(e, ""); if (p) return { seq: Number.isInteger(e?.seq) ? e.seq : i, path: p }; }
  return null;
}
/** a v1 actor name → the v4 actor, by grammar only (no directory): v1's "door" is v4's `system`, anything else enc() */
export const actorOf = (a) => (a === "door" ? "system" : enc(a));
const asSub = (k) => (isAccountName(k) ? k : undefined);   // a role or ban keyed by its account (@19)
const PERSON_REQUESTS = new Set(["grant", "ban", "unban"]);   // the old requests whose id names a person
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
// @12 (R 10-17, binding: "definitely serve path again alongside hash"; this replaces @8's address): a model is its LIBRARY
// PATH, as v1 wrote it (the portable reference: the world loads anywhere the library exists). When the caller can say what
// the bytes are (`content(path)` → sha256:<64 hex>, or null) the hash rides beside it as model-hash; a path it can't hash
// carries none (and is listed). The imported act keeps the path as it was written either way.
const hashOf = (a) => { if (typeof a !== "string") return null; const m = /^(?:sha256:|eido:sha256\/)([0-9a-f]{64})$/.exec(a); return m ? `sha256:${m[1]}` : null; };
// upstream #256's emitter name, and the id of the child thing a named emitter becomes (@15): readable (its name first), the
// same from every translation of the same world, never a person's id
const EMITTER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const emitterChildId = (host, name) => `${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "emitter"}-${sha256(`eido-emitter\0${host}\0${name}`).slice(0, 26)}`;
export function project(st, seen = null, who = null, ns = NAMESPACE, content = null) {
  const out = {};
  // a key the v1 fold lowercased (a ban's) isn't an account as written: who() restores its case first, then reads it
  const person = (k, v, lowered = false) => (who && !SYSTEM.has(k) ? who(k, { sub: (v && typeof v === "object" && typeof v.sub === "string" ? v.sub : undefined) ?? (lowered ? undefined : asSub(k)), ...(lowered ? { lowered } : {}) }) : enc(k));
  const unsub = (v) => { if (!v || typeof v !== "object" || Array.isArray(v) || !("sub" in v)) return v; const { sub, ...rest } = v; return rest; };   // @12: always
  for (const [id, e] of Object.entries(st.entities ?? {})) {
    const c = {};
    const t = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yawQ(e.yaw ?? 0), scale: typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
    const ride = rideOf(st, e); if (ride) { t.pos = ride.pos; t.q = ride.q; }
    c.transform = t;
    if (e.lib !== undefined) { c.model = e.lib; const h = content && typeof e.lib === "string" ? hashOf(content(e.lib)) : null; if (h) c["model-hash"] = h; }
    if (e.kind === "light") c.light = Object.fromEntries(["color", "intensity", "range", "keep", "day"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    const emitters = [];   // v1 particles:<name> (upstream #256): each becomes a child thing (@15)
    const volumes = {};    // main #248's water volume / air boxes (VOLUMES)
    const carried = {};    // main #248's climb routes, collision toggle, environment (CARRIED)
    for (const [k, v] of Object.entries(e.comp ?? {})) if (k !== "guard") {
      if (accountNamed(k) && isAccount(v)) continue;   // a component whose name has an account's, holding one (@19)
      if (k.startsWith("particles:") && EMITTER_NAME.test(k.slice(10))) { if (v != null) emitters.push([k.slice(10), v]); continue; }
      if ((k === "water" || k === "air") && v != null) { volumes[k] = v; continue; }   // main #248's: zone things (VOLUMES)
      if ((k === "traversal" || k === "collision" || k === "environment" || k === "vehicle") && v != null) { carried[k] = v; continue; }   // main #248's (CARRIED)
      if (k === "picture" && v != null) { const m = materialOf(v); if (m.material) c.material = m.material; if (m.left) c[keyed("imported", "material")] = m.left; if (m.whole != null) c[keyed("imported", "picture")] = m.whole; continue; }   // @22 (CARRIED)
      // a node's motion (v1 motion:<node name>): the name is data, motion:<partSlot(name)> {node: name} (@12, review r7 F1)
      if (k.startsWith("motion:") && v && typeof v === "object" && !Array.isArray(v)) { const node = k.slice(7); c[`motion:${partSlot(node)}`] = { ...newMotion(v), node: typeof v.node === "string" && v.node ? v.node : node }; continue; }
      c[encName(k === "door" && !e.comp.openable ? "openable" : k)] = k === "reactions" ? newReactions(v) : k === "sockets" ? newSockets(v, c) : k === "motion" ? newMotion(v) : k === "particles" ? newParticles(v) : k === "captions" ? newCaptions(v) : k === "sound" ? renameFields("sound", v).value : v; }
    if (e.comp?.guard && !e.comp.lock) { c.lock = true; seen?.guards.add(id); } // §5: guard merges into lock
    if (c.lock === true) c.lock = { rank: "builder" };   // @12: the one spelling (a v1 lock and a guard were builder-level)
    if (c.story && typeof c.story === "object" && !Array.isArray(c.story)) c.story = newStory(c.story); // @5: a marker's words, in story's shape
    if (e.parent) c.parent = typeof e.parent.to === "string"
      ? { to: enc(e.parent.to), ...Object.fromEntries(Object.entries(e.parent).filter(([k]) => k !== "to" && !PARENT_POSE.has(k)).map(([k, v]) => [k === "slot" ? "socket" : k, v])) }   // v1's slot is v4's socket (@7)
      : e.parent; // not a v1 mount (the v1 fold writes `to` as a string): carried as it is
    for (const [k, v] of Object.entries(e)) {
      if (["pos", "yaw", "q", "scale", "lib", "kind", "color", "intensity", "range", "keep", "day", "comp", "parent", "placer"].includes(k) || ENTITY_SKIP.has(k)) continue;
      c[keyed("imported", k)] = v; // anything the mapping doesn't know is carried, never dropped (R10)
    }
    const vol = volumePartsOf(enc(id), volumes, c); Object.assign(c, vol.own);
    // collision off is collider {enabled: false}; anything else it said rides imported:collision
    if (carried.collision && typeof carried.collision === "object") { const { enabled, ...rest } = carried.collision;
      if (enabled === false) c.collider = { ...(c.collider && typeof c.collider === "object" ? c.collider : {}), enabled: false };
      if (Object.keys(rest).length || (enabled !== undefined && typeof enabled !== "boolean")) c[keyed("imported", "collision")] = carried.collision; }
    else if (carried.collision !== undefined) c[keyed("imported", "collision")] = carried.collision;
    const climbs = carried.traversal !== undefined ? climbPartsOf(enc(id), carried.traversal) : { children: [], left: [] };
    if (climbs.left.length || (carried.traversal !== undefined && !Array.isArray(carried.traversal?.routes))) c[keyed("imported", "traversal")] = climbs.left.length ? { routes: climbs.left } : carried.traversal;
    const veh = carried.vehicle !== undefined ? vehiclePartsOf(enc(id), carried.vehicle) : null;
    if (veh) { c.drive = veh.drive; if (Object.keys(veh.left).length) c[keyed("imported", "vehicle")] = veh.left; }
    out[enc(id)] = shapeRepaired(c);
    for (const [cid, cc] of [...vol.children, ...climbs.children, ...(veh?.helm ? [veh.helm] : [])]) out[cid] = shapeRepaired(cc);
    for (const [name, v] of emitters) {
      const seeded = v && typeof v === "object" && !Array.isArray(v) && !Number.isFinite(v.seed) ? { ...v, seed: hashSeed(`${id}:particles:${name}:${v.preset ?? ""}`) } : v;
      out[emitterChildId(enc(id), name)] = shapeRepaired({ transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, parent: { to: enc(id) }, label: name, particles: newParticles(seeded) });
    }
  }
  const w = {};
  for (const k of ["sky", "terrain", "grass"]) if (st[k] != null) w[k] = st[k];
  // v1 dialect 3's physics epoch is carried like any field the mapping doesn't know: imported:epoch (@12; was imported-epoch)
  // round-2 R8: v1 echoed into the sky value who set it (`by`, a display name) and at which seq: derived, and a person's
  // name inside a value. Dropped; the log says who set the sky (History, inspect's touched).
  if (w.sky && typeof w.sky === "object") { const { seq, by, ...sky } = w.sky;
    if (sky.forecast && typeof sky.forecast === "object") { const { seq: _s, by: _b, ...fc } = sky.forecast; sky.forecast = fc; }
    w.sky = sky; }
  for (const a of st.assets ?? []) w[keyed("assets", typeof a === "string" ? a : a.path ?? JSON.stringify(a))] = typeof a === "string" ? {} : a;
  // research roles §translation: v1's `fly` and `gen` grants are the fly and generate switches, can.fly / can.generate
  // (@7: gen had stayed as written, read by the authority as generate); a `caption` deed is a place in its screen's captioners (below)
  const toCan = (v) => { if (!v || typeof v !== "object" || !("fly" in v || "gen" in v)) return v; const { fly, gen, ...rest } = v;
    const can = { ...(rest.can ?? {}), ...(fly === true ? { fly: true } : {}), ...(gen === true ? { generate: true } : {}) };
    return Object.keys(can).length ? { ...rest, can } : rest; };
  // upstream #258's world access rode the same map: `*` none = members only, `*` spectator = watch only. Here entry is
  // @world.access (shared/protocol/access.js); a person's own none / spectator is a record that lists no one (role none:
  // in, they watch only where the world lets everyone watch). A timed grant keeps its `until` (the load's sweep ends one
  // already past).
  const DOOR_OF = { none: { join: "listed" }, spectator: { join: "listed", watch: "anyone" } };
  for (const [k, v] of Object.entries(st.roles ?? {})) {
    if (k === "*") { if (DOOR_OF[v?.role]) { w.access = { ...DOOR_OF[v.role] }; const { role: _r, until: _u, ...rest } = toCan(v); if (Object.keys(rest).length) w["default-role"] = { role: "inhabitant", ...rest }; } else { const { until: _u, ...dr } = toCan(v) ?? {}; w["default-role"] = dr.role === "visitor" ? { ...dr, role: "inhabitant" } : dr; } }
    else { let r = toCan(unsub(v)); const id = person(k, v);
      // a caption deed (v1: to caption one thing, while it is the incarnation the deed was granted for) is a place in that
      // screen's captioners; a timed one stays carried, since captioners has no end
      const deed = r && typeof r === "object" ? r.caption : null, host = deed && typeof deed === "object" && typeof deed.id === "string" && Object.hasOwn(st.entities ?? {}, deed.id) ? st.entities[deed.id] : null;
      const screen = host && (deed.born == null || host.born === deed.born) && r.until == null ? out[enc(deed.id)] : null;
      if (screen && (screen.captioners === undefined || Array.isArray(screen.captioners?.ids))) {
        const ids = screen.captioners?.ids ?? []; screen.captioners = { ids: ids.includes(id) ? ids : [...ids, id] };
        const { caption: _c, ...rest } = r; r = rest; }
      if (r && (r.role === "spectator" || r.role === "none")) w[`imported-roles:${id}`] = r;   // no rung below inhabitant (@17): carried, not granted
      else w[`roles:${id}`] = r && r.role === "visitor" ? { ...r, role: "inhabitant" } : r; }
  }
  // the v1 fold lowercased a ban's key. Its `by` is who banned, the act's actor as v1 kept it: a name stays as it was, and
  // one that is itself an account is that person's id, as their acts' actor is (dropped without a mapper)
  const unby = (v) => (!v || typeof v !== "object" || Array.isArray(v) || !isAccountName(v.by) ? v
    : who ? { ...v, by: who(v.by, {}) } : (({ by: _b, ...rest }) => rest)(v));
  for (const [k, v] of Object.entries(st.bans ?? {})) w[`imported-bans:${person(k, v, true)}`] = unby(unsub(v));
  // a binding's author is a person: their identity, not their name (R1), when a who() mapper is given
  // …and through the account the v1 server stamped on the binding (authorSub, @16), as the author's grant is found, so the
  // two are one identity on every server; the account itself is dropped with every other one below
  // …the account's own person (@19): v1's author is `by` where a request sent one, which a request could name anyone in, so
  // the name is joined to the account only through the act itself, a behaviour's actor and its bySub (noAcct, below)
  for (const [k, v] of Object.entries(st.behaviors ?? {})) { const sub = isAccount(v?.authorSub) ? v.authorSub : undefined;
    w[keyed("imported-behavior", k)] = who && v && sub ? { ...v, author: who(sub, { sub }) }   // the stamp first: `by` can't make it the system's
      : who && v && typeof v.author === "string" && !SYSTEM.has(v.author) ? { ...v, author: who(v.author, {}) } : v; }
  const known = new Set(["entities", "sky", "terrain", "grass", "assets", "roles", "bans", "behaviors", "mounts", "recentChat", "chatTotal"]);
  for (const [k, v] of Object.entries(st)) if (!known.has(k) && v != null) w[keyed("imported", k)] = v;
  // main #248's environment: its world fields, its things, and what has no home on its host (environmentPlan)
  for (const { host, parts } of environmentPlan(st)) {
    if (parts.world.spawn) w.spawn = parts.world.spawn; if (parts.world.bounds) w.bounds = parts.world.bounds; if (parts.world.terrain) w.terrain = parts.world.terrain;
    if (parts.world.sky) w.sky = { ...(w.sky && typeof w.sky === "object" ? w.sky : {}), ...parts.world.sky };
    for (const [cid, cc] of parts.things) out[cid] = shapeRepaired(cc);
    if (Object.keys(parts.left).length && out[host]) out[host][keyed("imported", "environment")] = parts.left; }
  // @12, wave 2 (render-media-env): the world's look in today's spelling, as the load repairs a stored one (repairWorld: the sky's
  // clock as tz, radians, transition; the terrain's int colours and the sim's defaults, its water as the water component;
  // grass in the flora spelling, a preset kept by its name)
  out["@world"] = repairWorld(w).c; // @world is live from genesis (§2.3)
  // no account subject in any value, wherever the v1 fold kept it (@16: a binding's authorSub, or anything carried as it was)
  for (const c of Object.values(out)) for (const [k, v] of Object.entries(c)) { const x = withoutAccounts(v); if (x !== v) c[k] = x; }
  for (const c of Object.values(out)) { splitUnknown(c); namespaceUnknown(c, ns); }
  return clone(out); // a copy: the old fold mutates some records in place (bstate), and aliasing would hide the change
}

// Dialect 3 (@10): what the old world MEANS while her sim runs is her instant fold COMPOSED with her sim (PROTOCOL_v2,
// conformance order: foldEntry, then simEntry). On top of project(): the epoch is @world physics-engine (not the
// imported:epoch record); a body whose rest is logged stands at that logged pose until her law releases it (v4 holds the
// last LOGGED rest, P5: resting or flying again, it's the log's word); and a thing whose v1 lib has a stamped box carries
// it as physics.shape (Covenant III: geometry enters the sim only through the log). Keyed by the v1 lib, not the model
// value, which may be a content address by now. With no epoch ever entered this returns project()'s value untouched.
function physical(st, sim, recorded, out, dynamic = () => false) {
  if (!st.epoch && !recorded.size && !sim.boxes) return out;
  const w = out["@world"];
  // what her sim made of the epoch (review of b398d7e3 #3): her own law (carried) → today's eidosim runs from here on;
  // an engine she didn't carry (foreign: nothing flew) → that name, with no build, so nothing flies here either; an
  // epoch her sim refused (a bad tickMs: it never started) → no physics, only the imported record
  if (sim.epoch && !sim.epoch.foreign) { delete w[keyed("imported", "epoch")]; w["physics-engine"] = { engine: DEFAULT_ENGINE, build: ENGINES[DEFAULT_ENGINE].build, tickMs: sim.epoch.tickMs }; }   // HER tick (a later epoch she refused doesn't replace it; review r4 #3)
  else if (sim.epoch?.foreign) { delete w[keyed("imported", "epoch")]; w["physics-engine"] = { engine: sim.epoch.sim, build: null, tickMs: sim.epoch.tickMs }; }
  for (const [id, p] of recorded) { const c = out[enc(id)]; if (sim.bodies[id] && c) c.transform = { ...c.transform, pos: p.slice() }; }
  if (sim.boxes) for (const [id, e] of Object.entries(st.entities ?? {})) { const c = out[enc(id)]; if (c && typeof e?.lib === "string" && sim.boxes[e.lib]) c.physics = { kind: dynamic(id) ? "dynamic" : "static", shape: clone(sim.boxes[e.lib]) }; }
  return out;
}
/** Which thing an id names, as the v1 fold tells them apart (fold.js bornOf): a spawn it accepts (an id, and a lib that's
 *  absent or real) is a NEW thing when the id was free (never spawned, or removed) or held a different lib or a light; a
 *  same-lib re-spawn is the same thing. `of(id)` is the id's life count. R 2026-10-08's "punted → dynamic" is per thing. */
export function lifeTracker() {
  // an id is a property key to the v1 fold (st.entities[a.id]): 7 and "7" name one thing
  const lib = new Map(), n = new Map();
  return { of: (id) => n.get(String(id)) ?? 0, step(e) { const raw = e?.args?.id;
    if (e?.verb === "remove") { lib.delete(String(raw)); return; }   // the fold deletes entities[a.id] whatever a.id is (null → "null")
    if (raw == null) return; const id = String(raw);
    if (!raw) return;   // spawn and light ignore a falsy id (fold.js: !a?.id), as remove does not
    else if (e.verb === "light") lib.set(id, "\0light");
    else if (e.verb === "spawn" && id && !(e.args.lib != null && !e.args.lib)) { const l = e.args.lib ?? null;
      if (!lib.has(id) || lib.get(id) !== l) n.set(id, (n.get(id) ?? 0) + 1); lib.set(id, l); } } };
}
/** The things (`id#life`) a v1 log ever punts: R 2026-10-08, these come across `dynamic`, every other collider `static`. */
export function puntedLives(entries) {
  const t = lifeTracker(), out = new Set();
  for (const e of entries) { t.step(e); const id = e?.args?.id; if (e?.verb === "punt" && id != null) out.add(`${String(id)}#${t.of(id)}`); }
  return out;
}
/** Whether a v1 log enters a physics epoch (the v1 fold's own test: a sim name and an integer tick). */
export const hasEpoch = (oldEntries) => oldEntries.some((e) => e?.verb === "epoch" && typeof e.args?.sim === "string" && Number.isInteger(e.args?.tickMs));

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
export { unNegZero };

export function translate(oldEntries, { onDivergence, foldBuild, key, operator, nonce, who, founder, namespace, content, approved } = {}) {
  if (founder !== undefined) throw new Error("a translation names no founder: nothing can yet bind a key to the old world's owner (v1 logs record accounts, not keys); tier 0 stays empty");
  const ns = namespace === undefined ? NAMESPACE : namespaceOf(namespace);
  const seenModels = new Map();   // path → its hash (or null): each path hashed once, and counted
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
  push({ kind: "genesis", actor: "system", verb: "genesis", ...t0, body: translatedGenesis(oldEntries, { ...(key ? { key } : {}), ...(operator ? { operator } : {}), ...(nonce ? { nonce } : {}) }) });
  const physics = hasEpoch(oldEntries);
  // @19: the name beside an account is joined to it only where v1's server wrote both (a grant's or ban's id and sub, a
  // spawn's or light's placer, a behaviour's bySub with the act's actor); any other account is its own person's alone
  const mapAcct = who ? (sub) => who(sub, { sub }) : undefined;
  // the old genesis as it was, but never an account (@19): a genesis role's sub becomes its person's id, as in an old request
  push({ kind: "act", actor: "system", verb: "translated", ts: t0.ts ?? 0, body: { from: unNegZero(withoutAccounts({ ...genesis, translator: physics ? TRANSLATOR_SIM : TRANSLATOR, ...(foldBuild ? { fold: foldBuild } : {}) }, mapAcct)) } });
  // the translation writes the repaired spelling, so its log carries the load's once-per-world marker from the start: the
  // system's repair-shapes act, read by verb and actor only (review r8 M3: the translated act's body is purgeable)
  push({ kind: "act", actor: "system", verb: "repair-shapes", ts: t0.ts ?? 0, body: { v: SHAPES_VERSION, ids: [], translated: true } });
  // the operator's approval of this translation (import-v1/world.ts), written here, before any cause is taken
  if (approved) push({ kind: "act", actor: "system", verb: "translation-approved", ts: t0.ts ?? 0, body: approved });
  // an old request as sent keeps its words, but never an account: a grant's or a ban's top-level sub, whatever its shape, as
  // @12 had it (main's server wrote it, always an account); another request's top-level sub, and below the top level any
  // sub or *Sub, when it is account-shaped (@16: a placer's, a binding's bySub). With a mapper it becomes the person's id
  // (R1); without one it is dropped, so the imported act never re-leaks what the values no longer hold. A sub that isn't
  // account-shaped, on any request but a grant or a ban, is ordinary data and stays
  const noAcct = (e, a) => { let x = a;
    if (x && typeof x === "object" && !Array.isArray(x)) {
      // a top-level sub: a grant's or a ban's is the server's own stamp, beside the id it names, read as the person's account
      // whatever its shape; any other request's is an account alone, joined to no name, or, not being one, ordinary data
      // that stays (DROPPED)
      const pair = (e.verb === "grant" || e.verb === "ban") && typeof x.sub === "string";
      if ("sub" in x && (e.verb === "grant" || e.verb === "ban" || isAccount(x.sub))) {
        // the pair is one person: an id that is itself an account names them too
        if (who && pair) { const id = who(typeof x.id === "string" ? x.id : x.sub, { sub: x.sub }); x = { ...x, sub: id, ...(isAccountName(x.id) ? { id } : {}) }; }
        else if (who && isAccount(x.sub)) x = { ...x, sub: who(x.sub, { sub: x.sub }) };
        else { const { sub: _s, ...rest } = x; x = rest; } }
      // a person named by their account (a grant, ban or unban keyed by it): their id, as a role or ban keyed by it is. v1
      // matched a ban's and an unban's id in any case, so theirs is the account whatever its case in the log (world.ts)
      if (PERSON_REQUESTS.has(e.verb) && isAccountName(x.id) && !(who && pair)) {
        if (!who) { const { id: _i, ...rest } = x; x = rest; }
        else x = { ...x, id: e.verb === "grant" ? who(x.id, { sub: x.id }) : who(x.id.toLowerCase(), { lowered: true }) }; }
      // a placer is the person the server stamped, {id: their name, sub: their account}: both are that person's id, and a
      // name that is itself an account is theirs too (dropped without a mapper)
      const p = x.placer;
      if ((e.verb === "spawn" || e.verb === "light") && p && typeof p === "object" && !Array.isArray(p)) {
        if (who && isAccount(p.sub)) { const id = who(typeof p.id === "string" ? p.id : p.sub, { sub: p.sub }); x = { ...x, placer: { ...p, sub: id, ...(isAccountName(p.id) ? { id } : {}) } }; }
        else if (isAccountName(p.id)) { const { id: _i, ...q } = p; x = { ...x, placer: who ? { ...q, id: who(p.id, {}) } : q }; } }
      // a v1 comp's data is the component's value: under a name that has an account's, an account is one (@19)
      if (e.verb === "comp" && accountNamed(x.type) && isAccount(x.data)) {
        if (who) x = { ...x, data: who(x.data, { sub: x.data }) }; else { const { data: _d, ...rest } = x; x = rest; } }
      if (who && e.verb === "behavior" && isAccount(x.bySub))
        x = { ...x, bySub: who(typeof e.actor === "string" && !SYSTEM.has(e.actor) && !/^bhv:/i.test(e.actor) ? e.actor : x.bySub, { sub: x.bySub }) }; }
    return withoutAccounts(x, mapAcct); };
  const actorFor = (a) => (who && !SYSTEM.has(a ?? "door") ? who(String(a), {}) : actorOf(a ?? "door"));
  // ---- dialect 3 (@10): her sim beside the v1 fold. Inert until an epoch: simEntry ignores everything before one, and
  // physical() returns project() as it is, so a log without one translates exactly as @9 did.
  const sim = eidosim.emptySim();
  const recorded = new Map();     // v1 id → its last LOGGED rest pose (held until her law releases the body)
  const launchSeq = {};           // v1 id → the seq of the launch its current flight came from
  const restLogged = new Set();   // bodies whose CURRENT flight's rest is logged
  const restTicks = {};           // v1 id → the tick it came to rest
  // R 2026-10-08: a thing the v1 log ever punts is a dynamic collider, every other one static. Known up front, so the
  // kind is right from the moment its collider appears (no static → dynamic flip at the punt, which an undo of the
  // punt's act would then take back), and per incarnation: an id spawned again is a new thing (review of b398d7e3 #2, #4)
  const lives = puntedLives(oldEntries); const lifeNow = lifeTracker(); const dynamic = (id) => lives.has(`${id}#${lifeNow.of(id)}`);
  if (physics) Object.assign(stats, { launches: 0, rests: 0, worldDivergences: 0 });
  const diverged = (kind, e, extra) => { stats.divergences++; if (physics) stats[kind]++;
    if (!stats.firstDivergence) { stats.firstDivergence = { oldSeq: e?.seq ?? null, verb: e?.verb ?? null, ...(physics ? { kind } : {}), ...extra }; } };
  const view = () => physical(v1, sim, recorded, project(v1, seen, who, ns, addr), dynamic);
  const stepTo = (tick) => { // single steps while anything flies, so each rest's real tick is known
    while (sim.epoch && !sim.epoch.foreign && sim.tick < tick) {
      const flying = Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
      if (!flying.length) { eidosim.advanceSim(sim, tick); break; }
      eidosim.advanceSim(sim, sim.tick + 1);
      for (const id of flying) if (sim.bodies[id]?.resting) restTicks[id] = sim.tick;
    }
  };
  let prev = view();
  const clock = () => (Number.isFinite(lastTs) ? lastTs : 0);   // the latest ts written (push clamps to it)
  const logRests = (ts) => { // P5: one result per body that came to rest, in the order they stopped
    const fresh = Object.keys(sim.bodies).filter((id) => sim.bodies[id].resting && launchSeq[id] !== undefined && !restLogged.has(id))
      .sort((a, b) => restTicks[a] - restTicks[b]);
    for (const id of fresh) {
      // her sim's rest: a plain change by `sim`, caused by the punt's imported act (@11: no launch, no digest)
      recorded.set(id, sim.bodies[id].p.slice()); restLogged.add(id);
      const now = view(); const ops = diff(prev, now); prev = now;
      push({ kind: "change", actor: "sim", ts, cause: launchSeq[id], ...changeBody(unNegZero(ops)) }); stats.change++; stats.ops += ops.length;
      stats.rests++;
    }
  };
  for (const e of oldEntries) {
    if (e.verb === "genesis") continue;
    stats.verbs[e.verb] = (stats.verbs[e.verb] ?? 0) + 1;
    const ts = Number.isInteger(e.ts) ? e.ts : undefined; // §2.1: the authority's admission time, carried from the old entry
    if (sim.epoch && ts !== undefined) { stepTo(eidosim.tickOf(sim, ts)); logRests(Math.max(ts, clock())); }
    foldEntry(v1, e); eidosim.simEntry(sim, e, v1);
    lifeNow.step(e);
    const actor = actorFor(e.actor); if (actor !== e.actor) stats.renamed++;
    const tl = push({ ...(e.verb === "say" ? { kind: "say", actor, verb: "say", body: unNegZero(((b) => (who && typeof b.to === "string" && !SYSTEM.has(b.to) ? { ...b, to: who(b.to, {}) } : b))(clone(e.args) ?? {})) }
      : { kind: "act", actor, verb: "imported", body: unNegZero({ verb: e.verb, args: noAcct(e, clone(e.args) ?? null), from: e.seq ?? null }) }), ...(ts !== undefined ? { ts } : {}) });
    const b = sim.bodies[e.args?.id];
    if (e.verb === "punt" && b && b.seq === e.seq) { // her punt started (or kicked) a body: its rest will be caused by this act
      launchSeq[e.args.id] = tl;
      restLogged.delete(e.args.id); stats.launches++;
    }
    for (const id of [...recorded.keys(), ...Object.keys(launchSeq), ...Object.keys(restTicks)]) if (!sim.bodies[id]) { recorded.delete(id); restLogged.delete(id); delete launchSeq[id]; delete restTicks[id]; } // released by her law (or a new epoch)
    const now = view();
    const ops = diff(prev, now);
    if (ops.length) { push({ kind: "change", actor, cause: tl, ...changeBody(unNegZero(ops)), ...(ts !== undefined ? { ts } : {}) }); stats.change++; stats.ops += ops.length; }
    if (canon(v4project(v4)) !== canon(now)) { diverged("worldDivergences", e); if (stats.divergences === 1) onDivergence?.(e, now, v4project(v4)); }
    prev = now;
  }
  // settle, as her replaybench does: far past the last entry, then log what came to rest
  if (sim.epoch && !sim.epoch.foreign) {
    stepTo(sim.tick + 100000);
    const tsAt = (tick) => sim.epoch.ts + tick * sim.epoch.tickMs;
    logRests(Object.values(restTicks).reduce((m, t) => Math.max(m, tsAt(t)), clock()));
  }
  stats.out = out.length;
  if (addr) { stats.modelsHashed = [...seenModels.values()].filter(Boolean).length; stats.modelsUnhashed = [...seenModels].filter(([, a]) => !a).map(([p]) => p); }
  const mapped = [...volumeMappings(v1), ...carriedMappings(v1)]; if (mapped.length) stats.mapped = mapped;   // main's volumes, climb routes, collision, environment (VOLUMES, CARRIED)
  const unmapped = unmappedOf(v1); if (unmapped.length) stats.unmapped = unmapped;   // …and what of them has no home (imported:<component>), never silent
  stats.guards = seen.guards.size; stats.guardsLive = Object.values(v1.entities ?? {}).filter((e) => e?.comp?.guard && !e.comp.lock).length;
  return { out, stats, final: { v1: physical(v1, sim, recorded, project(v1, null, who, ns, addr), dynamic), translated: v4project(v4) }, ...(physics ? { theirs: sim } : {}) };
}
