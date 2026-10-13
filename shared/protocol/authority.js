// The authority (from the protocol lab's authority). Every request is resolved here once; the log receives the request as sent (an `act` entry) and
// the plain results it produced (one `state` entry, `cause` = the act's seq). Replay never runs this file.
// PROTOCOL L7: every state write, from every path (requests, use handlers, undo, put, create-from, rests, the authority's
// own follow-ups), is admitted by ONE function, `admit`, keyed on who asks, which components change (old and new),
// locks, where it lands, sanity and rate. Tool checks may only add to it. The only code that appends a change entry is
// `changeEntry`, and it takes only what `admit` returned.
// Ported from the protocol lab (the protocol lab's authority.js @ 11db981). Engine change: storage is injected. The lab's openWorld
// read and wrote files here; that part is server/disk.js now, so this module has no node: imports and no
// process/Date of its own (callers pass the clock). Everything from `w.worldId` down is the lab's code unchanged.
import { bodyOf, socketQ, ONE_PLACE } from "../components.js";
import { checkSockets, checkSocket } from "../sockbody.js";
import { DEFAULT_WHO, grabOf, checkGrabbable, wantsHome, fitsSocket, socketRadius, pickGrip, offsetOk, describeGrab } from "../grab.js";
import { fold, opsOf, applyOps, cowState, applyCow, checkIJSON, isEntityId, isComponent, isIdentity, jcs, sha256, PURGED, DIALECT, VERSION, keyOk } from "./fold.js";
import { mintId, PERSON_ID } from "./ids.js";
import { COMPONENTS, PENDULUM, defOf, registered, baseOf, isNamespaced, materialize, mapRefs, outOfRange, rangeWords } from "./componentspec.js";
import { validate, verbHelp, VERBSPEC } from "./verbspec.js";
import { dec } from "./names.js";
import { READ_ONLY, GHOST_OK } from "./verbclasses.js";
import { foldSkyEntry } from "../forecast.js";
import { normalizeCaptionArgs, captionRefusal, foldCaption } from "../captions.js";
import * as C from "./consent.js";
import * as TR from "./sculpt.js";
import * as SR from "./scriptrules.js";
import * as R from "./roles.js";
import { graphemes, cleanText } from "../text.js";
import { mediaTier, tierWords } from "../mediasrc.js";
import { saysOf } from "../says.js";
import { readOut } from "../a11y.js";
import { instanceProblem, effectFor, effectBlobName, effectProblem, EFFECT_KIND, ESSENTIAL_NAMES } from "../particle_effects.js";
import { livePoses, digestOf, restEta, ENGINES, carried, worldPose, TICK_MS, offChain, simCutOf } from "./simlayer.js";
import { trustRefusal } from "../drafts.js";
import { planLaunch } from "./launchplan.js";
import { REACH, HAND_Y, MAX_HELD, KICK, SHOVE, BODY_REACH } from "./physconst.js";
import { reachTo, massOf, shoveCap, feetOn, sweptCovers } from "../shove.js";
import { r3, noNeg0, unNegZero } from "./round.js";
import { shapeError, isBoxShape } from "./shapes.js";
import { CTX } from "./authority/ctx.js";
import { isSocketC, socketRules, socketsOf, allSockets, socketPoint, socketRole, liftOps, legacyHosts, liftHostOps, modelSocketNames } from "./authority/sockets.js";
import { Refusal, refuse, said } from "./authority/refuse.js";
import { LAB_CATALOGUE, modelOf, geomOf, boxOfM, geomE, withCatalogue, meshShape } from "./authority/catalogue.js";
export { LAB_CATALOGUE, withCatalogue, MESH_SIZE, meshSize, meshGeom, meshShape } from "./authority/catalogue.js";
import { CHANGE, IMPORTED_ONLY, VOLATILE, clone, createOps, delOp, isE, lockedC, nonce16, opsQuiet, qr3, scratch, setOp, slug, versionOf, versionSeq, LOCK_LEVELS, lockLevel, lockRank } from "./authority/storage.js";
export { posAt, worldOf, seal, LOCK_LEVELS, lockLevel, lockRank } from "./authority/storage.js";
import { NONE, aabb, ancestors, descendants, hits, localFrom, obbs, qYaw, qinv, qmul, qrot, satCost, satDepth, surfacesOf, worldT, yawQ } from "./authority/math.js";
import { SPATIAL, WORK_BUDGET, clockMs, familyOf, hitsIx, kidsMap, near, spatial, spend, supportBelow, supportUnder } from "./authority/spatial.js";
export { WORK_BUDGET, indexAudit } from "./authority/spatial.js";
import { RANK, backward, banOf, creatorOf, effective, entryBy, ghostOf, inForce, inForceOf, isBanned, isScriptActor, kickOf, lastSetterOf, madeBy, may, modHolder, muteOf, ownersOf, rankOf, roleOf, sanctionsNow, wcOf, whoRank } from "./authority/rights.js";
export { effectiveIn, roleIn, inForceOf, banOf, isBanned, kickOf, muteOf, ghostOf, sanctionsNow, creatorOf, lastSetterOf } from "./authority/rights.js";


// ---------- storage: authority/storage.js ----------
// ---------- math: authority/math.js ----------
// ---------- the spatial index: authority/spatial.js ----------
// ---------- rights, views over the log, sanctions: authority/rights.js ----------
// ---------- the authority ----------
// Refusal / refuse / said: authority/refuse.js
const RESERVED = new Set(["system", "sim", "world"]); // the authority's own identities: a request can never be stamped as one

// A request as sent must itself be I-JSON (it is logged as the act). -0 is normalised; non-finite is refused.
function wire(args) {
  const walk = (v) => { if (typeof v === "number" && !Number.isFinite(v)) refuse("shape", `numbers must be finite, got ${v}`, "I-JSON: finite numbers only");
    if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(args); const out = JSON.parse(JSON.stringify(args ?? {}));
  try { checkIJSON(out); } catch (x) { refuse("shape", `the request isn't I-JSON (${x.code})`, "RFC 7493: UTF-8, no duplicate keys, finite numbers, integers within 2^53"); }
  return out;
}

// The authority's per-call state: CTX (authority/ctx.js: the catalogue, throughLock, nameOf, isAnon, knownId, the mint's world,
// the work budget, forking) and the world's per-call queues and clock. ONE save/restore for every entry point (request, withAuthority):
// review 10-06 S3 found two hand-written copies that already disagreed, and a nested call (leave → request(drop), or a
// host callback re-entering the authority) reset the outer call's queues under it. enter() saves everything, sets this call's,
// and returns the restore; `actor` is the asker a request names (the directory may not know a founder yet), null for
// the authority's own work.
function enter(w, actor) {
  const outer = { ...CTX }, wq = { changedQ: w.changedQ, sayQ: w.sayQ, heldQ: w.heldQ, now: w.now, pinTs: w.pinTs };
  CTX.cat = w.catalogue ?? LAB_CATALOGUE; CTX.through = false; CTX.nameOf = w.nameOf ?? null; CTX.mintW = w; CTX.work = { left: WORK_BUDGET.units, until: clockMs() + WORK_BUDGET.ms, k: 0 };
  CTX.isAnon = (id) => w.kindOf?.(id) === "anon"; CTX.knownId = (id) => (actor != null && id === actor) || !w.kindOf || w.kindOf(id) != null;   // the asker is known (a founder names themself)
  return () => { Object.assign(CTX, outer); w.changedQ = wq.changedQ; w.sayQ = wq.sayQ; w.heldQ = wq.heldQ; w.now = wq.now; w.pinTs = wq.pinTs; };
}
export function request(w, actor, verb, args = {}) {
  const exit = enter(w, actor);
  // ONE clock per request (§2.1: ts is the authority's admission time). A wall clock read twice in one request could put a
  // rest's digest (computed where the engine stood at the first read) under a later ts, across a tick boundary, and every
  // carrier re-folding the log would then call the authority's own digest wrong (physlive Q1).
  const clock = w.now; const t0 = clock(); w.now = () => t0;
  try {
    if (!isIdentity(actor) || RESERVED.has(actor)) refuse("identity", `'${actor}' isn't an identity the authority can stamp`, "identities are a–z, 0–9 and '-', up to 64 (§3.1); system, sim and world are the authority's own");
    const h = VERBS[verb];
    if (h && !w.exists && !["create-world", "help"].includes(verb)) refuse("no-world", `there is no world called '${w.name}' yet`, `create-world {title: '…'} founds it (you become its owner); or pick a world that exists`);
    // §2.4: chain points are signed by the key genesis names (or the latest handoff). An authority holding another key would
    // write lines its own verifier calls forged (a moved dir, a lost or swapped custody file): it refuses instead (R5).
    if (h && w.exists && w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer && !READ_ONLY.has(verb))
      refuse("custody", "this server doesn't hold the key that signs this world (its genesis names another sequencer)", "the operator restores the world's custody file, or hands the sequencer over (§13 handoff); reads still work");
    if (h && w.exists && w.state().status !== "ok") refuse("unreadable", `this world's log folds to '${w.state().status}'`, "the authority won't write to a log its own reader refuses");
    if (!h) refuse("unknown-verb", `there is no '${verb}'`, "help lists every verb", { didYouMean: guess(verb, Object.keys(VERBS)) });
    // `leave` passes: it settles their own presence (the server sends it when it removes them; review 10-07: a kicked
    // body and what it held were never released)
    if (w.exists && verb !== "help" && verb !== "leave" && isBanned(w, actor)) refuse("banned", `${actor} is banned from this world`, "the moderator log says so; ask a moderator");
    if (w.exists && verb !== "help" && verb !== "leave" && kickOf(w, actor)) refuse("kicked", `${said(actor)} was removed from this world and may come back in ${Math.ceil((kickOf(w, actor).until - w.now()) / 60000)} min`, "wait; the moderator log says who and why");
    // ghost (PLAN 10-06): in the world, outside society. A ghost may look, walk and leave; never interact or talk.
    // legacy role `none` (a demotion below visitor): outside membership, it holds no permission and no voice; it may look,
    // walk and leave, as a ghost may (top-down review 10-06: none passed say and a reaction's use)
    if (w.exists && !GHOST_OK.has(verb) && verb !== "ghost" && w.state().entities?.["@world"] && roleOf(w.state(), actor) === "none")
      refuse("rights", `${said(actor)} has no role here (none: below visitor), so can't ${verb}`, "an owner or a grantRoles holder can give a role", { needs: "a role" });
    // ghost: only the chosen mode's own toggle (ghost {on}) passes; ghost {who} is a sanction, an act on someone
    if (w.exists && (!GHOST_OK.has(verb) || (verb === "ghost" && args?.who !== undefined && args.who !== actor)) && ghostOf(w, actor)) { const g = ghostOf(w, actor);
      refuse("ghost", g.chosen ? `you're a ghost here (you chose it): ghosts don't interact or talk` : `you're a ghost here${g.until ? ` until ${new Date(g.until).toISOString()}` : ""}: ghosts don't interact or talk`, g.chosen ? "ghost {on: false} brings you back" : "a moderator ranked at or above whoever did it can bring you back"); }
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    // the authority's own follow-ups (rests, returns) are its duty, never the asker's budget: the budget starts after them.
    // They have no budget of their own: they are bounded by the engine (settleSim takes at most 64 rests a request) and by
    // the returns that are due (each one a thing someone let go of that long ago)
    if (h && w.exists) { CTX.work = { left: Infinity, until: Infinity, k: 0 }; settleSim(w); returnDue(w); expireAsks(w); CTX.work = { left: WORK_BUDGET.units, until: clockMs() + WORK_BUDGET.ms, k: 0 }; }
    args = wire(args);
    // throughLock (§5) is a flag on any request, not an argument of one verb: checked here, then admit reads it
    // expect (§3a) is the same kind of flag: the values a gesture started from. Checked here, before anything is built
    const { throughLock, expect, ...plain } = args;
    if (throughLock !== undefined && typeof throughLock !== "boolean") refuse("shape", `throughLock is true or false, got ${JSON.stringify(throughLock)}`, "send throughLock: true to act through a lock you may remove");
    CTX.through = throughLock === true;
    const bad = validate(verb, plain); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); }
    if (expect !== undefined) expectCheck(w, expect);
    if (verb === "create" && args.place) { const b2 = validate("place", { ...args.place, id: "x" }); if (b2) { const { code, reason, fix, ...rest } = b2; refuse(code, `place: ${reason}`, fix, rest); } }
    const r = h(w, actor, args);
    drainHeld(w);    // grab / release (grabbable): scripts whose scope covers the thing hear who took it, how it was let go
    drainScripts(w); // what the request's own entries trigger (changed:<comp>, say), after them, each its own activation
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; }
    if (r && r.refused && !r.refused.fix) r.refused.fix = verbHelp(verb) ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb";
    return r;
  } catch (e) {
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } // a refusal still updates the authority's own ring and throttle (presence, unlogged)
    if (e instanceof Refusal) { logRefusal(w, actor, verb, args, e.code); const { code, reason, fix, ...rest } = e; return { ok: false, refused: { code, reason, fix: fix || (VERBSPEC[verb] ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb"), ...pick(rest) } }; }
    throw e;
  } finally { exit(); }
}
// R7: a refused write is part of the record (what someone TRIED, in true order; §2.1 "the request as sent, plus its
// refusal if refused"): an act whose body is {request, refused: {code}}, the request cut to 2 KiB, inside the actor's
// byte budget. Never logged: reads, dry runs, and the refusals that ARE the budget or the authority's own state (rate,
// identity, no-world, custody, unreadable, banned): logging those would be the flood. Past the budget, the authority counts
// what it didn't write, and the next refusal it does write says how many (`unrecorded`).
// "muted": its refusal would put the muted words in the public log (review 10-07)
const UNLOGGED = new Set(["rate", "identity", "no-world", "custody", "unreadable", "banned", "kicked", "ghost", "muted"]);
function logRefusal(w, actor, verb, args, code) {
  try {
    // a verb the authority doesn't have is recorded too (an agent's invented verb is part of what it tried), when it's a name
    if (!w.exists || !(VERBS[verb] || /^[a-z][a-z0-9-]{0,31}$/.test(String(verb))) || READ_ONLY.has(verb) || args?.dry === true || !isIdentity(actor) || RESERVED.has(actor)) return;
    // a body's track is presence: a refused move (a step, an arrival or a teleport) is never recorded. A person's client
    // keeps the track current several times a second and answers a refused step with a teleport; a person indoors, flying
    // or seated wrote a permanent, broadcast refusal every few seconds (review 10-06 S0-3). An ACCEPTED teleport is an act.
    if (verb === "move") return;
    if (code === "rate") { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; } // an attempt all the same: counted, not written
    // a refused shove is a walk that met something, not a request anyone made in words (review 10-12 S2-4): counted, not written
    if (verb === "punt" && args?.shove === true) { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; }
    if (UNLOGGED.has(code)) return;
    let req = stripDry(args ?? {}); try { checkIJSON(req); } catch { req = { unloggable: "not I-JSON" }; } const j = jcs(req);
    const body = { request: j.length > 2048 ? { truncated: true, bytes: j.length } : req, refused: { code } };
    const miss = (w.unrecorded ??= new Map()); const n = miss.get(actor) ?? 0; if (n) body.unrecorded = n;
    try { rateCheck(w, actor, "act", jcs(body).length + 256); } catch (x) { if (x instanceof Refusal) { miss.set(actor, n + 1); return; } throw x; }
    w.append(actEntry(w, actor, verb, body)); miss.delete(actor);
  } catch { /* logging a refusal never fails the request it records */ }
}
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !["message", "stack"].includes(k)));
// §3a: "Release settles as one act with `expect` on the starting values." expect is a list of {id, component, value?}:
// the component must hold exactly that value now (JCS-equal), or be absent when value is left out. Anything else is
// refused as `changed`, naming who changed it, and nothing is written. It is authority practice (the act records it, as
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
//   system   — the authority's own follow-up to physics (set down what lost its support, attach a rest, return a lost thing);
//   founding — the `new` act's first write to @world, by an owner named in genesis, once.
// What a lock guards (§5; R 10-11 16:21, Second Life's Locked): EVERYTHING on the locked thing and on anything attached to
// it — every component set, added or removed, its place, its parent, its model, its removal — until the lock is lifted
// (throughLock: a request by someone who may lift it acts through it). The first protocol's matrix left labels, lights,
// motion, physics and reactions open; review 10-11 C-S1-1 showed what that let a builder do to an owner-locked piece
// (switch it off, hide it, take its physics away). USE stays open: a lock stops authoring, not using, so a handler's own
// writes may change a locked thing's state (a door's openable, a label) but never move, re-parent, swap or remove it.
const RELOCATES = new Set(["transform", "parent", "model"]);   // what even USE may not change on a locked thing (a lock covers everything else for authoring)
// L7 rate (round-2 review R6): per actor, over a 10 s window by the authority's clock. Counted in ENTRIES and in BYTES, with
// talk (say) apart from building (acts), so chat can't starve building or the other way round, and one identity can't
// make a world unhostable by bytes (one master file, nothing ever split out of it: 53 MB in one window was possible).
// An identity with no account (io.kindOf → "anon") gets less. A say's text is at most 8 KiB (the Commons' longest real
// line is 4.5 KB). Refused requests are logged (R7) inside the same byte budget.
// The spoken-say trio (from the first protocol's say, kept by the Commons audit, agents #4): display metadata for a voice
// that already performed as captions. Only inside the protocol (spoken: true and a non-negative safe-integer utt); t0 is
// a reorder key on every client, so it's clamped to a bounded utterance window ending now. Anything else: all three
// dropped, and the say is an ordinary say.
const MAX_UTTER_MS = 300_000;
function spokenOf(a, now) {
  if (a.spoken !== true || !Number.isSafeInteger(a.utt) || a.utt < 0) return {};
  return { spoken: true, utt: a.utt, ...(typeof a.t0 === "number" && Number.isFinite(a.t0) ? { t0: Math.round(Math.min(now, Math.max(now - MAX_UTTER_MS, a.t0))) } : {}) };
}
const RATE = { n: 60, says: 20, ms: 10000, bytes: 256 * 1024, anonBytes: 32 * 1024 };
const SAY_MAX = 8192;
const bytesOf = (e) => e.bytes ?? JSON.stringify(e).length;
class Admitted { constructor(who, ops, after, notes = []) { this.who = who; this.ops = ops; this.after = after; this.notes = notes; Object.freeze(this); } }
// L7 rate, per actor, over EVERYTHING the actor makes the log hold (acts and says), by the authority's clock. One function:
// admit calls it for state writes, and every word that logs without a state write (say, grab's lift, throw, drop, a
// teleport) calls it before appending. The lab has no agents (`for` is unwritten until keys, L4), so "that actor's
// agents" is the actor alone here. Refusals aren't logged, so they cost the authority, not the log (authority practice).
function rateCheck(w, actor, kind = "act", extra = 0) {
  if (w.leaving === actor) return; // a disconnect's settlement is the authority's duty, not the leaver's request: never rate-refused
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
  const lifted = who.lifting ? { ops, notes: [] } : liftOps(st, ops, w.everIds()); ops = lifted.ops;
  if (!ops.length) refuse("nothing", "that changes nothing", "");
  const role = roleOf(st, actor);
  const keysMade = new Set(); // keyed components this very write brings into being (their creator is the asker)
  // L6 (33 F1): a launched thing belongs to the engine until it rests. No write may touch it in flight except its rest
  // (cap rest) or the authority's own follow-ups; an epoch cut (a write to @world.physics-engine) may freeze it (P6, force).
  const sf = st.entities["@world"]?.c["physics-engine"] && !(cap && ["rest", "system"].includes(cap.kind)) && !ops.some((o) => o.id === "@world" && o.comp === "physics-engine") ? w.sim() : null;
  const inFlight = (id) => !!(sf?.launched[id] && sf.sim?.bodies[id] && !sf.sim.bodies[id].resting);
  let s = cowState(st); const norm = []; const made = new Set(); // a lock guards what happens after it, not the write that creates the thing
  const prevOf = new Map(); // script: sets → the key's value just before that op, within this write
  ops.forEach((raw, i) => {
    const { verb, ...rest } = raw; const op = { verb, ...shapeOneOrRefuse(verb, rest, i) };
    if ("value" in op) op.value = unNegZero(op.value); // I-JSON has no -0 (an engine can make one); the same number, written as 0
    const at = `${op.id}${op.comp !== undefined ? "." + op.comp : ""}`;
    if ("value" in op) { try { checkIJSON(op.value); } catch (x) { refuse("shape", `${at}: the value isn't I-JSON (${x.code} ${x.detail})`, "finite numbers, integers within 2^53, no -0"); }
      if (jcs(op.value).length > 65536) refuse("too-big", `${at} is ${jcs(op.value).length} bytes; the authority keeps values under 64 KiB`, "put big data in a blob and store its hash"); }
    const e = s.entities[op.id];
    if (verb === "create") { if (e) refuse("exists", `'${op.id}' already exists`, "choose another id, or leave id out and the authority mints one");
      if (PERSON_ID.test(op.id)) refuse("shape", `'${op.id}' is shaped like a person's identity (u- + 20 letters): a thing can't wear one, or a reference to it could mean either`, "choose another id, or leave id out and the authority mints one");
      // §3d H7: an id is never reused, so a re-created id can't inherit references (parents, portals, old acts) or a sponsorship
      // …except the SAME thing coming back: an undo restoring what its own target deleted (who.restores, set only by
      // buildUndo's whole-thing branch). Its references are its own, so inheriting them is the point (Ctrl+Z after Delete).
      if ((w.everIds().has(op.id) && !who.restores?.has(op.id)) || made.has(op.id)) refuse("reused", `'${op.id}' existed before in this world; an id is never reused`, "choose another id, or leave id out and the authority mints a fresh one"); }
    else if (!e) refuse("not-found", `no thing called '${op.id}'`, "look lists what's here", { didYouMean: guess(op.id, Object.keys(s.entities)) });
    else if (op.verb === "delete" && op.comp === undefined && op.id === "@world") refuse("world", "@world can't be deleted", "§2: delete or change its components instead (owners only)");
    else if (op.verb === "delete" && op.comp !== undefined && !(op.comp in e.c)) refuse("not-found", `${op.id} has no ${op.comp}`, `it has: ${Object.keys(e.c).join(", ")}`);
    else if (op.verb === "set" && !("value" in op)) refuse("shape", `set ${at} needs a value`, "");
    const pause = op.verb === "set" && op.comp.startsWith("script:") && pauseOnly(op.value, s.entities[op.id]?.c[op.comp]);
    rights(w, st, s, who, role, op, at, made, pause);
    keyRights(w, st, s, who, op, at, keysMade, pause);
    seniority(w, st, who, op);
    // §3d H7: deleting an entity is admitted as deleting each of its components, so the creator rule applies per key
    if (op.verb === "delete" && op.comp === undefined && e) for (const c of Object.keys(e.c)) keyRights(w, st, s, who, { verb: "delete", id: op.id, comp: c }, `${op.id}.${c}`, keysMade);
    // §3d M6 (L5): a schemas:<name> value, once set, can't change (a new meaning is a new name). Setting the same value
    // again changes nothing; deleting it is changing it.
    if (op.id === "@world" && op.comp?.startsWith("schemas:") && e && op.comp in e.c && !(op.verb === "set" && jcs(op.value) === jcs(e.c[op.comp])))
      refuse("schema-fixed", `@world.${op.comp} is set; a schema never changes (§4: a name never changes meaning)`, "a new meaning is a new name");
    if (op.comp === "terrain-grid" && Object.keys(e?.c ?? {}).some((k) => k.startsWith("terrain-tile:")) && !(op.verb === "set" && jcs(op.value) === jcs(e.c["terrain-grid"])))
      refuse("grid-fixed", `${op.id}'s terrain-grid is fixed while it has tiles`, "regridding is a new ground entity");
    if (inFlight(op.id)) refuse("in-flight", `${op.id} is in flight: the engine has it until it comes to rest`, "wait (or catch it: grab {id}); no write may touch a launched thing before its rest");
    if (op.id === "@world" && op.comp === "lock" && op.verb === "set") refuse("world", "@world can't be locked", "§7: lock the things in it instead");
    lockLevelCheck(w, st, s, who, op, at);
    // locks: the thing's own lock as of this op; its ancestors' locks as of before this write (what was attached then)
    if (op.verb === "create") made.add(op.id);
    // a lock covers EVERYTHING on the thing and on what hangs under it (R 10-11 16:21, Second Life's Locked): every component
    // set, added or removed, not only where it stands (review 10-11 C-S1-1: a builder could switch off, hide or un-physics an
    // owner-locked thing). Open still: USE (a reaction's own writes), the engine's rest, the authority's follow-ups, and the
    // thing's own lock (lockLevelCheck says who may lift it).
    else if (!made.has(op.id) && !["rest", "system"].includes(cap?.kind) && !(op.comp === "lock" && lockedC(s.entities[op.id]?.c))
      && (cap?.kind !== "reaction" || op.comp === undefined || RELOCATES.has(op.comp))) {   // use stays open, but no handler moves, re-parents, swaps or removes a locked thing
      // §5: "a held thing keeps its logged parent, but holding suspends parent constraints until it settles" (answering
      // research 34 #11): a lock set on the table while the cup is in a hand doesn't bind the cup in the hand, so its
      // put or throw settles it. Its OWN lock still binds, and picking it up off a locked thing is refused at grab.
      const held = cap?.kind === "handle" && cap.ids.includes(op.id);
      const own = lockedC(s.entities[op.id]?.c) ? op.id : null; const anc = held ? null : ancestors(st, op.id).find((k) => lockedC(st.entities[k]?.c));
      const k = own ?? anc;
      if (k) lockCheck(w, st, who, role, k, op, at); }
    if (op.verb === "set" && op.comp.startsWith("script:")) prevOf.set(op, s.entities[op.id]?.c[op.comp]); // the value just before it
    applyCow(s, [op]); norm.push(op); // one entity copied per op it touches, not the world (s is this write's own copy)
  });
  capacityCheck(w, st, s, who, norm);
  for (const op of norm) if (op.verb === "set") valueCheck(s, op, { carry: CTX.forking }); // against the state the whole write leaves (parents may come later in a batch); a fork's copy carries what its parent holds
  { const bad = socketRules(s, new Set(norm.map((o) => o.id))); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); } }
  rolesCheck(st, s, norm);
  for (const op of norm) if (op.verb === "set" && op.comp.startsWith("script:") && !pauseOnly(op.value, prevOf.get(op))) installCheck(w, st, s, who, op); // 41 §3.14: at install (not a pause: it needs no source, no scope)
  if (!CTX.forking) for (const op of norm) if (op.verb === "set") particlesCheck(w, op); // a particles value names an effect this world has, with params it declares (shared/particle_effects.js)
  if (cap?.kind === "script") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some((r) => r === id || ancestors(s, id).includes(r)))
    refuse("scope", `${cap.key} may create only inside its subtree; ${id} isn't under ${cap.ids[0]}`, "give it parent {to: <an entity in the scope>} in the same batch");
  if (ownersOf(st).length && !ownersOf(s).length) refuse("last-owner", "that would leave this world with no owner", "§7: add the new owner's role first (set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}), then change yours");
  if (cap?.kind === "rest") restCheck(w, cap, s);
  return new Admitted(who, norm, s, lifted.notes);
}
// How much a world holds (review 10-06 S0-2, security pass 2): at most @world.capacity.things things (default 2 000: the
// size tools/protocol/scale-check.ts holds every request under 50 ms at, and already past what a standalone headset's browser
// draws at frame rate; an owner may raise it to 5 000), and the world's guests TOGETHER at most capacity.guestThings standing
// things they made (default 200): a guest is a fresh identity per connection, so no per-identity budget stopped one from
// filling a world. Only a write that adds things is refused (full); deleting, and every other change, stay open at the cap.
export const CAPACITY = { things: 2000, guestThings: 200 };
const capacityOf = (st) => { const v = st.entities["@world"]?.c.capacity; const ok = (x) => Number.isInteger(x) && x >= 0;
  return { things: ok(v?.things) ? v.things : CAPACITY.things, guestThings: ok(v?.guestThings) ? v.guestThings : CAPACITY.guestThings }; };
// the things standing that a guest's rights made (a log view, kept incrementally like everIds)
function guestMade(w, st) {
  const G = (w.__guests ??= { n: 0, ids: new Set() });
  for (; G.n < w.entries.length; G.n++) { const e = w.entries[G.n]; if (!isE(e) || e.kind !== "change") continue; let by = null;
    for (const o of opsQuiet(e)) { if (o.verb === "create") { by ??= entryBy(w, e).rights; if (CTX.isAnon(by)) G.ids.add(o.id); } else if (o.verb === "delete" && o.comp === undefined) G.ids.delete(o.id); } }
  let n = 0; for (const id of G.ids) if (st.entities[id] && !isSocketC(st.entities[id].c)) n++; return n;
}
// a socket is a part of its host, not a thing of its own: it never counts (R 10-12 20:44)
const thingCount = (st) => { let n = 0; for (const id in st.entities) if (id !== "@world" && !isSocketC(st.entities[id].c)) n++; return n; };
function capacityCheck(w, st, s, who, norm) {
  const made = norm.filter((o) => o.verb === "create" && s.entities[o.id] && !isSocketC(s.entities[o.id].c)).length; if (!made) return;
  const cap = capacityOf(s); const before = thingCount(st), after = thingCount(s);
  if (after > before && after > cap.things) refuse("full", `this world holds ${before} things and its limit is ${cap.things} (@world.capacity.things): ${after - before} more won't fit`, `delete something first; the world's owner may raise it: set {id: '@world', component: 'capacity', value: {things: <n>}} (at most ${COMPONENTS.capacity.ranges.things.max})`, { limit: cap.things, things: before });
  const holder = who.cap?.kind === "reaction" ? who.cap.author : who.cap?.kind === "script" ? who.cap.sponsor : who.actor;
  if (!CTX.isAnon(holder)) return;
  const g = guestMade(w, st);
  if (g + made > cap.guestThings) refuse("full", `guests (people without an account) have ${g} things standing here, and this world lets guests have ${cap.guestThings} (@world.capacity.guestThings), all of them together`, "sign in to build more, or ask the world's owner to raise capacity.guestThings", { limit: cap.guestThings, things: g });
}
// A lock binds everyone, the locker and owners included (§5). `throughLock: true` on the request lets anyone who may
// remove that lock act through it, and the log records only the edit (the act carries the request as sent, flag and
// all). It covers the asker's OWN writes: a capability (a handler's author, a hand, the authority's own follow-ups) never
// acts through a lock. Who may remove a lock is whoever may delete the component: builders and owners (L7 rights).
function lockCheck(w, st, who, role, k, op, at) {
  const level = lockLevel(st.entities[k]?.c.lock);
  const below = !who.cap && !mayLiftLock(w, st, who.actor, k);   // a level above you, and not yours
  const mayUnlock = !who.cap && !lacks(w, st, who.actor, { verb: "delete", id: k, comp: "lock" }) && !below;
  if (CTX.through && mayUnlock) return;
  const by = lastSetterOf(w, k, "lock"); const whose = by && !by.deleted ? ` (locked by ${said(by.by)} at ${by.seq})` : "";
  const lv = level === "builder" ? "" : ` at ${level} level`;
  const what = k === op.id ? `${op.id} is locked${lv}${whose}, so ${at} can't change` : `${op.id} is attached to ${k}, which is locked${lv}${whose}, so ${at} can't change`;
  const fix = CTX.through && who.cap ? "throughLock covers your own edits, not a handler or a held thing; unlock it first"
    : below ? `only ${level === "owner" ? "an owner" : `a ${level} or above`}${by && !by.deleted ? `, or ${said(by.by)} who locked it,` : ""} may unlock it or act through it; you are ${role}`
    : mayUnlock ? `send the same request with throughLock: true, or unlock it first: delete {id: '${k}', component: 'lock'}. A lock stops accidents; any builder may lift a builder-level lock, and history shows who did`
    : `a builder or owner can unlock it (delete {id: '${k}', component: 'lock'}); you are ${role}`;
  refuse("locked", what, fix, { lock: k, rank: level, ...(by && !by.deleted ? { by: by.by } : {}), ...(below ? { mayLift: false } : {}) });
}
/** May `holder` lift k's lock (or act through it)? At its level or above, or whoever set it (R, 10-07: "whoever locked it,
 *  or anyone at the lock's rank"). Rights to delete the component are checked apart (L7: lacks). */
function mayLiftLock(w, st, holder, k) {
  if (rankOf(st, holder) >= lockRank(st.entities[k]?.c.lock)) return true;
  const by = lastSetterOf(w, k, "lock"); return !!by && !by.deleted && by.rights === holder;
}
// A write to a lock itself: changing or removing a lock is lifting it (its level or its locker), and nobody sets one above
// their own rank. A capability is judged by its holder (a handler's author, a script's sponsor); the authority's own
// follow-ups never touch a lock.
function lockLevelCheck(w, st, s, who, op, at) {
  if (op.comp !== "lock" || op.id === "@world") return;
  const { actor, cap } = who; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : actor;
  const cur = st.entities[op.id]?.c.lock;
  if (cur !== undefined && cur !== PURGED && !(op.verb === "set" && jcs(op.value) === jcs(cur)) && !mayLiftLock(w, st, holder, op.id)) {
    const by = lastSetterOf(w, op.id, "lock"); const level = lockLevel(cur);
    refuse("rank", `${op.id} is locked at ${level} level${by && !by.deleted ? ` by ${said(by.by)}` : ""}; only ${level === "owner" ? "an owner" : `a ${level} or above`} or whoever locked it may ${op.verb === "delete" ? "unlock" : "change"} it`,
      `ask ${by && !by.deleted ? said(by.by) : "an owner"}`, { lock: op.id, rank: level, needs: "rank" }); }
  if (op.verb === "set" && rankOf(st, holder) < lockRank(op.value))
    refuse("rank", `${at}: a lock at ${lockLevel(op.value)} level is above your rank (${roleOf(st, holder)})`, "lock at your own level or below: true (builder) or {rank: 'builder'}", { needs: "rank" });
}
function shapeOneOrRefuse(verb, op, i) {
  if (!["create", "set", "delete"].includes(verb)) refuse("shape", `op ${i}: '${verb}' isn't a state operation`, "create, set and delete (batches are flat)");
  if (!isEntityId(op.id)) refuse("shape", `'${op.id}' isn't an entity id`, "§3.1: a–z, 0–9 and '-', up to 64, or @world", { didYouMean: guess(String(op.id), []) });
  if ((verb === "set" || op.comp !== undefined) && !isComponent(op.comp)) refuse("shape", `'${op.comp}' isn't a component name`, "§3.1: [a-z][a-z0-9-]*, optionally <domain>/ first, @<n> version and :<key> after (ASCII only)", { didYouMean: guess(String(op.comp), Object.keys(COMPONENTS)) });
  const out = { id: op.id }; if (op.comp !== undefined) out.comp = op.comp; if (verb === "set" && "value" in op) out.value = op.value;
  return out;
}
// L7 keys rights on the component, not on the word that carried it (research roles §server rules 2). What a write
// needs is a SWITCH (roles.js), never a rank:
//   a thing          build when you make it or made it; editOthers when someone else made it
//   @world.blueprints:*  build (publish);  @world.assets:*  generate (where the old `asset` spend gate landed)
//   the world's look  editWorld: about, sky (and weather), terrain, terrain-grid, terrain-tile:*, grass, terrain-paint:*,
//                     bounds, spawn (EDIT_WORLD_PERMISSION; off = owner)
//   @world.roles:*    the grant rule (grantCheck): an owner, or grantRoles below your rank with only permissions you hold
//   the rest of @world (role-defs, default-role, access, physics-engine, script-settings, schemas, imported records…): owner, never a permission
const WORLD_LOOK = new Set(["about", "sky", "terrain", "terrain-grid", "grass", "bounds", "spawn"]);
const needOf = (op) => {
  if (op.id !== "@world") return "thing";
  const base = String(op.comp ?? "").split(":")[0];
  if (base === "blueprints") return "build";
  if (base === "assets") return "generate";
  if (R.EDIT_WORLD_PERMISSION && (WORLD_LOOK.has(base) || base === "terrain-tile" || base === "terrain-paint")) return "editWorld";
  if (base === "roles") return "grant";
  return "owner";
};
/** What `holder` lacks to make this op, or null if they may: "owner", or the permission name. `made` = ids this write
 *  creates. A capability's holder (a handler's author, a script's sponsor) is judged by the same rule; for them a
 *  roles:* write needs owner (a script never grants). */
function lacks(w, st, holder, op, made, { viaCap = false } = {}) {
  if (roleOf(st, holder) === "owner") return null;
  const n = needOf(op); const eff = effective(st, holder);
  if (n === "owner" || (n === "grant" && viaCap)) return "owner";
  if (n === "grant") return eff.can.grantRoles ? null : "grantRoles";
  if (n !== "thing") return eff.can[n] ? null : n;
  if (!eff.can.build) return "build";
  if (eff.can.editOthers || op.verb === "create" || made?.has(op.id)) return null;
  const c = creatorOf(w, op.id); return c && c.rights === holder ? null : "editOthers";
}
// the words a refusal uses for what was missing (kept "needs owner" / "needs builder" where those were the words)
const needWords = (n) => (n === "owner" ? "owner" : n === "build" ? "builder" : n === "grantRoles" ? "owner or grantRoles" : `the ${n} permission`);
function rights(w, st, s, who, role, op, at, made, pause) {
  const { actor, cap } = who;
  // a screen's captions are written by the caption request only (its session, order and generation rules), never set by
  // hand; an owner may still set them whole (a copy of the world, a repair) and anyone who may edit the screen may
  // delete them (CAPTIONS below)
  // an imported world's records (its old bindings, unmapped fields, bans, sim epoch, the old guard) are carried, never
  // written by a request: nothing reads them as live (bans are the moderator log's; scripts are script:<name>; a guard
  // merged into lock). An owner may (a copy of the world, a repair); deleting one is an ordinary edit.
  if (!cap && op.verb === "set" && role !== "owner" && IMPORTED_ONLY(op.comp)) refuse("imported", `${at} is an imported world's record, carried as it was; it isn't written by hand`, "what it meant lives elsewhere now: lock for a guard, the moderator log for bans (ban/unban), script:<name> for a behaviour");
  if (!cap && op.comp === "captions" && op.verb === "set" && role !== "owner") refuse("caption-only", `${at} is written by the caption request, one line at a time`, "caption {id, session, n, t0, t1, text, speaker?, title?} (or {id, session, end: true}); who may is the screen's captioners {ids}");
  if (cap?.kind === "caption") { if (!cap.ids.includes(op.id) || op.comp !== "captions") refuse("rights", `a caption writes only ${cap.ids.join(", ")}'s captions`, "");
    const ids = st.entities[op.id]?.c.captioners?.ids;
    if (!(Array.isArray(ids) && ids.includes(actor)) && lacks(w, st, actor, op, made)) refuse("rights", `${said(actor)} isn't one of ${op.id}'s captioners`, `whoever may edit ${op.id} names its captioners: set {id: '${op.id}', component: 'captioners', value: {ids: [<identity>]}}`);
    return; }
  if (!cap) {
    // a pause write (only `paused` changes) by a pauseScripts holder needs no edit rights on the thing: keyRights judges it
    if (pause && may(st, actor, "pauseScripts")) return;
    const n = lacks(w, st, actor, op, made); if (!n) { if (needOf(op) === "grant") grantCheck(w, st, s, actor, op, at); return; }
    refuse("rights", `changing ${at} needs ${needWords(n)}; you are ${role}`, n === "owner" ? "ask the world's owner (say {text, to: <owner>}); help shows your role and permissions" : `ask a moderator or an owner for ${n}; help shows your role and permissions`, { needs: n });
  }
  if (cap.kind === "script") return scriptRights(w, st, cap, op, at, made);
  if (!cap.ids.includes(op.id) || !cap.comps.includes(op.comp)) refuse("rights", `${cap.kind === "reaction" ? `the '${cap.action}' handler` : cap.kind} may change only ${cap.comps.join("/")} of ${cap.ids.join(", ")}, not ${op.verb} ${at}`, "a capability is scoped to what it names");
  if (cap.kind === "reaction" && lacks(w, st, cap.author, op, made, { viaCap: true })) refuse("rights", `'${cap.action}' was set up by ${said(cap.author)}, who can't change ${at} any more`, "ask someone with the rights to set the reactions again");
  // a hand's settlement: who may is grabbable.who (grabOf: the one reader, with the physics fallback); a punt is a kick,
  // not a hand, and keeps physics.who (research: "physics.who now means who may punt or push it")
  if (cap.kind === "handle" && cap.via === "punt") { const ph = st.entities[op.id]?.c.physics; const n = ph?.who ?? DEFAULT_WHO;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${op.id} isn't something you can punt`, "");
    if (rankOf(st, actor) < whoRank(st, n)) refuse("rights", `only a ${n} may punt ${op.id}; you are ${role}`, "ask the owner to set physics.who"); }
  else if (cap.kind === "handle") { const g = grabOf(st.entities[op.id]?.c);
    if (!g) refuse("not-grabbable", `${op.id} isn't something you can carry`, "");
    if (rankOf(st, actor) < whoRank(st, g.who)) refuse("rights", `only a ${g.who} may move ${op.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
  // founding: once, before any state, in a world whose genesis names this server's operator key (founded here)
  if (cap.kind === "founding") { const g = w.entries[0], k = w.custody()?.operator?.();
    if (!k || !g.body.owners?.some((t) => t.includes(k)) || w.entries.some((e) => isE(e) && e.kind === "change")) refuse("rights", "founding writes happen once, in a world this server founded", ""); }
}
// §5 / L7: a KEYED component (`<name>:<key>`, an instance such as blueprints:<hash> or roles:<id>) that exists may be
// changed or deleted only by its creator (creatorOf, a view over the log: whose rights first made this life of the key)
// or by an owner. Making a new key needs only the component's ordinary rank. A capability changes it with the rights it
// carries: a handler with its author's. The authority's own scoped follow-ups (rest, system, handle, founding) touch no keys
// that someone else made; founding makes roles:<founder>. A whole-entity delete is NOT gated here (see note 34).
const isKeyed = (comp) => typeof comp === "string" && comp.includes(":");
// §5 (23:40): each keyed name's schema says which kind it is. INSTANCE keys (script:, blueprints:, roles:) carry the creator
// rule; PARTITION keys (terrain-tile:, terrain-paint:) are pieces of one shared surface: ordinary rank rules only.
// A keyed name with no schema here is an instance (note 49: the spec doesn't say; this is the safe side).
export const keyKind = (comp) => COMPONENTS[comp.slice(0, comp.indexOf(":"))]?.key ?? "instance";
// H5 (security review 10-06): owners are protected from each other by SENIORITY, as Matrix room v12 protects creators.
// An owner can't change or remove the role of an owner who has been one longer (the founder, whose ownership is in
// genesis or the founding grant, is the most senior and can't be demoted by anyone). Without it, a co-owner — or anyone
// who got owner by mistake — could demote the founder and ban them, and only an operator editing the log could undo it.
// Seniority is the START of an owner's current unbroken run as owner: the earliest write to roles:<x> after which every
// write kept it owner (the founding grant is the earliest of all). It read the LAST write, so a junior owner who
// "re-affirmed" the founder ({role: owner}) reset the founder's seniority to now, then demoted and banned them
// (top-down review 10-06, S0-1). Writes that keep someone owner never move their seniority.
function ownerSince(w, st, x) {
  if (roleOf(st, x, false) !== "owner") return Infinity;
  const comp = `roles:${x}`; let since = -1;
  for (const i of backward(w, "@world")) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== "@world" || (o.comp !== undefined && o.comp !== comp)) continue;
      if (o.verb === "set" && o.comp === comp && o.value?.role === "owner") since = i; else return since; } }
  return since;
}
/** The most senior owner here (the start of the longest unbroken run as owner; the founder unless they left it), or null. */
export function seniorOwnerOf(w) { const st = w.state(); let best = null, at = Infinity;
  for (const k of ownersOf(st)) { const x = k.slice(6), t = ownerSince(w, st, x); if (t < at) { at = t; best = x; } } return best; }
function seniority(w, st, who, op) {
  if (op.id !== "@world" || !op.comp?.startsWith("roles:")) return;
  // a capability acts with its holder's rights, seniority included (review 10-07: a junior owner's reaction demoted the
  // founder); the authority's own scoped follow-ups (rest, system, handle, founding) never write a role
  const cap = who.cap; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : who.actor;
  const target = op.comp.slice(6);
  if (target === holder || roleOf(st, target, false) !== "owner") return;
  // a write that keeps them owner is still a write to a more senior owner's entry: refused like any other (it used to
  // pass as a "re-affirm", and reset their seniority: S0-1). Your own entry, and juniors', remain yours to write.
  if (ownerSince(w, st, target) <= ownerSince(w, st, holder))
    refuse("rights", `${said(target)} has been an owner here longer than you; an owner can't demote one more senior`, "ask them; an owner can only change the roles of owners made after them");
}
// The grant rule (research §3, server rule 5): a roles:<id> write by someone who isn't an owner needs grantRoles, and
//   the person must rank below you, before AND after; the role you give must rank below yours; that role's permissions,
//   and any `can: true` (or legacy gen: true), must be permissions you hold. Ownership stays an owner's (seniority).
function grantCheck(w, st, s, actor, op, at) {
  if (roleOf(st, actor) === "owner") return;
  const me = effective(st, actor); const target = op.comp.slice(6); const anon = CTX.isAnon(target);
  if (target === actor) refuse("rights", "you can't change your own role", "ask someone ranked above you");
  const before = roleOf(st, target, anon);
  if (rankOf(st, target, anon) >= me.rank) refuse("rank", `${said(target)} is ${R.roleDef(wcOf(st), before)?.name ?? before}, not ranked below you (${me.name}); you can only change the roles of people below you`, "ask someone ranked above them", { needs: "rank" });
  const wc1 = { ...(wcOf(s) ?? {}) }; if (op.verb === "delete") delete wc1[op.comp]; else wc1[op.comp] = op.value;
  const after = R.roleIdOf(wc1, target, { anon, owners: true }); const def = R.roleDef(wc1, after);
  if ((def?.rank ?? RANK.none) >= me.rank) refuse("rank", `${after} stands at or above you (${me.name}); you can only give roles ranked below yours`, "ask an owner", { needs: "rank" });
  const extra = op.verb === "set" ? Object.entries(op.value?.can ?? {}).filter(([, x]) => x === true).map(([k]) => k) : [];
  const give = [...R.PERMISSION_NAMES.filter((k) => def?.can?.[k]), ...extra];
  const missing = give.find((k) => !me.can[k]);
  if (missing) refuse("rights", `giving ${missing} needs you to hold ${missing} yourself; you don't`, "you can only give permissions you hold (ask an owner)", { needs: missing });
}
function keyRights(w, st, s, who, op, at, keysMade, pause = false) {
  if (!isKeyed(op.comp) || op.verb === "create") return;
  if (keyKind(op.comp) === "partition") return;
  const key = `${op.id}\u0000${op.comp}`;
  const present = s.entities[op.id] && op.comp in s.entities[op.id].c;
  if (!present) { if (op.verb === "set") keysMade.add(key); return; } // a new life of the key: the asker makes it
  if (keysMade.has(key)) return; // made earlier in this same write
  const { actor, cap } = who; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : actor;
  // roles:<id> is changed under the grant rule (grantCheck: rank and permissions), not its creator's: a moderator may
  // change the role an owner gave a visitor. A capability never reaches here for roles (lacks: owner).
  if (!cap && op.comp.startsWith("roles:")) return;
  // research §6 (scripts): a pause made by someone who outranks you can be lifted only by them, or at their rank or above
  if (pause && op.value?.paused !== true && s.entities[op.id]?.c[op.comp]?.paused === true) {
    const pb = pausedBy(w, op.id, op.comp);
    if (pb && pb.by !== holder && rankOf(st, holder) < rankOf(st, pb.by))
      refuse("rank", `${op.id}.${op.comp} was paused by ${said(pb.by)} (${roleOf(st, pb.by)}), who ranks above you; only they, or someone at their rank or above, may resume it`, `ask ${said(pb.by)} or an owner`, { pausedBy: pb.by }); }
  if (roleOf(st, holder) === "owner") return;
  const c = creatorOf(w, op.id, op.comp);
  if (c && c.rights === holder) return;
  // pauseScripts: pause or resume a script whose SPONSOR ranks below you (the sponsor is unchanged: a pause adopts nothing)
  if (pause && !cap && may(st, holder, "pauseScripts")) { const sp = sponsorOf(w, op.id, op.comp);
    if (sp && rankOf(st, sp.sponsor) < rankOf(st, holder)) return;
    refuse("rank", `${op.id}.${op.comp}'s sponsor ${sp ? said(sp.sponsor) : "(nobody)"} doesn't rank below you; pauseScripts reaches scripts whose sponsor ranks below you`, "ask someone ranked above them", { needs: "rank" }); }
  refuse("rights", `${at} is ${c ? said(c.rights) : "nobody's on record"}'s${c ? ` (made at ${c.seq})` : ""}; only its creator or an owner may ${op.verb === "delete" ? "delete" : "change"} it`,
    op.comp.startsWith("blueprints:") ? "publish your own version: it gets its own key" : `make your own instance (${op.comp.split(":")[0]}:<another key>), or ask ${c ? said(c.rights) : "an owner"}`);
}
// @world.role-defs as a whole (research §component shapes): checked against the state the write leaves, so a batch
// that moves people off a role and deletes it lands as one act; a custom role somebody still holds can't vanish.
function rolesCheck(st, s, ops) {
  if (!ops.some((o) => o.id === "@world" && o.comp === "role-defs")) return;
  const wc0 = st.entities["@world"]?.c ?? {}, wc1 = s.entities["@world"]?.c ?? {};
  const held = (rid) => Object.keys(wc1).filter((k) => k.startsWith("roles:") && wc1[k]?.role === rid).length + (wc1["default-role"]?.role === rid || wc1["default-role"]?.guests === rid ? 1 : 0);
  const v = wc1["role-defs"] === undefined ? {} : wc1["role-defs"];
  const bad = R.checkRoleDefs(v, R.defsOf(wc0), held);
  if (bad) refuse(bad.code, `@world.role-defs: ${bad.reason}`, bad.fix, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined);
  // who fields that name a removed custom role read as owner (whoRank): nothing opens; nothing else to check here
}
// Sanity and shape of the values the authority's own engine reads (what the change IS, not which word carried it).
function valueCheck(s, { id, comp, value: v }, { carry = false } = {}) {
  const at = `${id}.${comp}`; const obj = v && typeof v === "object" && !Array.isArray(v);
  // where a component goes (catalogue `on`): world settings on a chair, or a transform on @world, were taken and then
  // meant different things to the authority and the renderer (component review T1a/T1b)
  const on = defOf(comp)?.on;
  if (on === "world" && id !== "@world") refuse("world-only", `${comp.split(":")[0]} is a world setting: it goes on @world, not on ${id}`, `set {id: '@world', component: '${comp}', value: …}`);
  if (on === "thing" && id === "@world") refuse("thing-only", `${comp} belongs to a thing; @world is the world itself`, "make a thing (create) and put it there");
  if (comp === "parent" && v?.to === "@world") refuse("thing-only", `@world isn't a thing to be inside: a thing with no parent already sits in the world`, `delete {id: '${id}', component: 'parent'}`);
  // one place per thing (R 10-11 00:37; the answer: anything that needs its own place goes on a child): a light and a model
  // never share an entity, so a light's pose is its own and the editor's gizmo moves one thing. Existing logs keep folding
  // (the fold never refuses); the importer splits them; a carried value (an import) passes.
  // a mesh is a body of its own, as a model is: never beside a model or a light on one thing. The words are shared with the
  // Inspector (components.js ONE_PLACE), so a refusal reads the same from either
  if (!carry && (comp === "light" || comp === "model" || comp === "mesh")) { const c = s.entities[id]?.c ?? {};
    for (const has of ["model", "light", "mesh"]) if (has !== comp && c[has] !== undefined) refuse("one-place", ONE_PLACE.reason(id, has, comp), ONE_PLACE.fix(id, has, comp)); }
  if (id === "@world" && comp.startsWith("roles:") && (!isIdentity(comp.slice(6)) || !CTX.knownId(comp.slice(6))))
    refuse("shape", `roles:${comp.slice(6)} names no one: a role is given to an identity (u-…), not a typed name`, "who {name} finds a person's identity; then set roles:<identity>", { didYouMean: guess(comp.slice(6), Object.keys(s.entities["@world"]?.c ?? {}).filter((k) => k.startsWith("roles:")).map((k) => k.slice(6))) });
  const nums = (a, n, lim = 1e5) => Array.isArray(a) && a.length === n && a.every((x) => typeof x === "number" && Math.abs(x) <= lim);
  // H5: everyone-is-owner would let any stranger remove the real owners: the default role is any role but owner (R 10-06;
  // research §4); `none` (legacy: below visitor) is still read and written, as existing worlds carry it
  const wcS = s.entities["@world"]?.c ?? {}; const roleIds = () => R.rolesOf(wcS).map((r) => r.id);
  if (id === "@world" && comp === "default-role" && (v?.role === "owner" || (v?.role !== "none" && !R.roleDef(wcS, v?.role))))
    refuse("shape", `${at}.role must be a role here other than owner (${roleIds().filter((x) => x !== "owner").join(", ")}; got ${JSON.stringify(v?.role)})`, "an owner is named by identity: set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}");
  if (id === "@world" && comp === "default-role" && v?.guests !== undefined && (v.guests === "owner" || !R.roleDef(wcS, v.guests) || (R.GUESTS_AT_MOST_DEFAULT && R.rankOfRole(wcS, v.guests) > R.rankOfRole(wcS, v.role))))
    refuse("shape", `${at}.guests must be a role here at or below role (guests never get more than everyone else; got ${JSON.stringify(v.guests)} with role ${JSON.stringify(v.role)})`, "to let people without an account build here: {role: 'builder', guests: 'builder'}");
  if (id === "@world" && comp.startsWith("roles:") && (!obj || (v.role !== "none" && !R.roleDef(wcS, v.role))))
    refuse("shape", `${at}.role must be a role here (${roleIds().join(", ")}; got ${JSON.stringify(v?.role)})`, "role-defs (the owner) defines custom roles", { didYouMean: guess(String(v?.role), roleIds()) });
  if (id === "@world" && comp.startsWith("roles:") && obj) {
    for (const k of Object.keys(v)) if (!["role", "can", "note", "sub"].includes(k)) refuse("schema", `${at}: unknown key '${k}'`, "roles:<id> is {role, can?, note?}", { didYouMean: guessKey(k, ["role", "can", "note"]) });
    if (v.note !== undefined && !(typeof v.note === "string" && v.note.length <= 80)) refuse("shape", `${at}.note is up to 80 characters`, "");
    if (v.can !== undefined) { const bad = R.checkCan(v.can, at); if (bad) refuse(bad.code, bad.reason, bad.fix, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined);
      // dependencies are checked on the EFFECTIVE set at write (research §3): editOthers on without build is refused
      if (v.role !== "owner" && v.role !== "none") { const br = R.brokenNeed({ ...R.roleDef(wcS, v.role).can, ...v.can });
        if (br) refuse("needs", `${at}: ${br[0]} needs ${br[1]}, which would be off`, `give ${br[1]} too (can: {${br[1]}: true}), or leave ${br[0]} off`); } } }
  // default-role.can: permissions on top of the default role for everyone who holds it that way (what an imported world's
  // grant to everyone, roles['*'].gen in its old log, becomes: can.generate). The same closed list and dependencies as roles:<id>.can
  if (id === "@world" && comp === "default-role" && obj && v.can !== undefined) { const bad = R.checkCan(v.can, at); if (bad) refuse(bad.code, bad.reason, bad.fix, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined);
    if (R.roleDef(wcS, v.role)) { const br = R.brokenNeed({ ...R.roleDef(wcS, v.role).can, ...v.can }); if (br) refuse("needs", `${at}: ${br[0]} needs ${br[1]}, which would be off`, `give ${br[1]} too (can: {${br[1]}: true}), or leave ${br[0]} off`); } }
  if (id === "@world" && comp === "trusted") { const bad = trustRefusal(v); if (bad) refuse("shape", `${at}: ${bad}`, "set {id: '@world', component: 'trusted', value: {components: ['<handle>/<name>', …]}} (the drafts this world trusts; delete the component to trust none)"); }
  if (id === "@world" && comp === "access" && obj && v.soft !== undefined && v.max !== undefined && v.soft > v.max) refuse("bounds", `${at}.soft (${v.soft}) can't be above max (${v.max})`, "soft is the recommended capacity; max is the hard one");
  // a who names a role this world has (a custom role too); a typo would open or close it to the wrong people
  const whoOk = (x, where) => { if (x !== undefined && (x === "none" || !R.roleDef(wcS, x))) refuse("shape", `${where}.who must be a role here (${roleIds().join(", ")}; got ${JSON.stringify(x)})`, "who may: a role name; anyone ranked at or above it may", { didYouMean: guess(String(x), roleIds()) }); };
  if (comp === "physics" && obj) whoOk(v.who, at);
  if (comp === "grabbable" && obj) whoOk(v.who, at);
  if (comp === "reactions" && obj) for (const [act, h] of Object.entries(v)) if (h && typeof h === "object") whoOk(h.who, `${at}.${act}`);
  if (comp === "sockets" && obj) for (const [slot, sk] of Object.entries(v)) if (sk?.body && typeof sk.body === "object") whoOk(sk.body.who, `${at}.${slot}.body`);
  if (comp === "socket" && obj && v.body && typeof v.body === "object") whoOk(v.body.who, `${at}.body`);
  if (comp === "transform") { if (!obj || !nums(v.pos, 3) || !nums(v.q, 4, 1.0001) || !nums(v.scale, 3, 1e3) || Object.keys(v).some((k) => !["pos", "q", "scale"].includes(k)))
    refuse("shape", `${at} must be {pos: [x,y,z], q: [x,y,z,w], scale: [x,y,z]}, finite and within bounds`, "pos within ±100 km, q a rotation, scale within ±1000"); 
    // a rotation is a unit quaternion (the renderer normalizes; the authority's own maths uses q as written), and a scale of
    // 0 makes every child's transform divide by zero (review T0e)
    if (Math.hypot(...v.q) < 1e-6) refuse("shape", `${at}.q is all zeros, which isn't a rotation`, "no rotation is [0, 0, 0, 1]");
    if (v.scale.some((x) => Math.abs(x) < 1e-4)) refuse("shape", `${at}.scale has a 0 in it; a thing can't be flat to nothing`, "to hide something, delete it or give it a tiny scale like 0.01"); }
  if (comp === "bounds") { if (!obj || !nums(v.min, 3) || !nums(v.max, 3) || Object.keys(v).some((k) => !["min", "max"].includes(k)) || v.min.some((x, i) => x >= v.max[i]))
    refuse("shape", `${at} must be {min: [x,y,z], max: [x,y,z]} with min < max on every axis (a box with room inside)`, "e.g. {min: [-20, 0, -20], max: [20, 12, 20]}"); }
  if (comp === "parent") { if (!obj || typeof v.to !== "string") refuse("shape", `${at} must be {to: <id>}`, "");
    if (v.socket !== undefined) refuse("legacy", `${at}.socket is the old spelling: a socket is a child entity now`, `parent {to: <the socket's id>} (inspect {id: '${v.to}'} lists its sockets)`);
    if (!s.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "", { didYouMean: guess(v.to, Object.keys(s.entities)) });
    if (v.to === id || ancestors(s, v.to).includes(id) || ancestors(s, id).length >= 32) refuse("loop", `${id} can't be inside ${v.to}: that makes a loop`, ""); }
  if (comp === "model" && !modelOf(v)) refuse("shape", `no model called '${v}'`, "find {kind: 'model', query} lists models", { didYouMean: guess(String(v), CTX.cat.list(String(v).split("/").pop().replace(/\.[a-z0-9]+$/i, "").slice(0, 12)).map(([k]) => k).slice(0, 200)) });
  if (comp === "pivot" && (!obj || !nums(v.pos, 3, 1e4) || Object.keys(v).some((k) => k !== "pos"))) refuse("shape", `${at} must be {pos: [x,y,z]} in its own frame (metres, before scale)`, "e.g. {pos: [0, 0.5, 0]}; delete it to turn about the origin again");
  if (comp === "lock" && v !== true && !(obj && Object.keys(v).length === 1 && LOCK_LEVELS.includes(v.rank)))
    refuse("shape", `${at} is true (a builder-level lock) or {rank: 'builder' | 'moderator' | 'owner'}; to unlock, delete it`, `delete {id: '${id}', component: 'lock'}`);
  if (comp === "openable" && obj) {
    if (v.angle !== undefined && v.slide !== undefined) refuse("shape", `${at} turns (angle) or slides (slide), not both`, "give one: angle (rad) to swing about its pivot, or slide [x, y, z] (m) to slide");
    if (v.slide !== undefined && !nums(v.slide, 3, 10)) refuse("bounds", `${at}.slide is [x, y, z] in metres, each within 10`, "e.g. [0.9, 0, 0]: a sliding door moves its own width sideways"); }
  if ((comp === "motion" || comp.startsWith("motion:")) && obj) {
    if ("rpm" in v) refuse("schema", `${at}.rpm: a spin's rate is degPerSec here (degrees a second; rpm × 6)`, `e.g. {type: 'spin', degPerSec: ${Number.isFinite(v.rpm) ? +(v.rpm * 6).toFixed(4) : 36}}, or period (seconds a turn)`, { didYouMean: ["degPerSec"] });
    if ((v.type === "spin" || v.type === "orbit") && v.degPerSec !== undefined && v.period !== undefined) refuse("shape", `${at} gives its speed twice (degPerSec and period)`, "give one: degPerSec (degrees a second) or period (seconds a turn)");
    if (v.type === "path" && v.speed !== undefined && v.duration !== undefined) refuse("shape", `${at} gives its speed twice (speed and duration)`, "give one: speed (m/s) or duration (s from the first point to the last)");
    if (v.type === "path" && !(Array.isArray(v.points) && v.points.length >= 2 && v.points.length <= 64 && v.points.every((p) => nums(p, 3, 1e4))))
      refuse("shape", `${at}.points must be 2 to 64 points [x, y, z] (metres, in its parent's frame)`, "e.g. {type: 'path', points: [[0, 0, 0], [0, 0, 4]], speed: 1}"); }
  if (comp === "motion" && obj && "pivot" in v) refuse("derived", `${at}.pivot is derived from what it hangs from; it isn't stored`, "§0 rule 2: no stored derived values; inspect shows the pivot as a view");
  if (comp === "home") { const okQ = (q) => nums(q, 4, 2) && Math.abs(Math.hypot(...q) - 1) < 1e-3;
    if (!obj || !nums(v.pos, 3) || (v.q !== undefined && !okQ(v.q)) || (v.scale !== undefined && !(typeof v.scale === "number" ? v.scale > 0 : nums(v.scale, 3) && v.scale.every((x) => x > 0))) || Object.keys(v).some((k) => !["pos", "q", "scale", "parent"].includes(k)) || (v.parent !== undefined && !(v.parent && typeof v.parent.to === "string" && Object.keys(v.parent).every((k) => k === "to" || k === "socket"))))
      refuse("shape", `${at} is {pos: [x, y, z], q?: [x, y, z, w], scale?, parent?: {to, socket?}}`, "e.g. {pos: [0, 0, 2]}"); }
  if (comp === "reactions") { if (!obj) refuse("shape", `${at} must be {<action>: handler}`, "");
    const kinds = Object.keys(COMPONENTS.reactions.handlers);
    for (const [act, h] of Object.entries(v)) { if (!kinds.includes(h?.kind)) refuse("shape", `reactions.${act}: no handler kind '${h?.kind}'`, `handler kinds: ${kinds.join(", ")}`, { didYouMean: guess(String(h?.kind), kinds) });
      if (h.component !== undefined && !isComponent(h.component)) refuse("shape", `reactions.${act}.component '${h.component}' isn't a component name`, "§3.1");
      if (h.kind === "set" && !isComponent(h.component)) refuse("shape", `reactions.${act} (set) needs a component`, "e.g. {kind: 'set', component: 'openable', field: 'locked', value: true}");
      for (const f of ["field", "unless"]) if (h[f] !== undefined && typeof h[f] !== "string") refuse("shape", `reactions.${act}.${f} is a field name (a string)`, "");
      if (h.kind === "reset" && !(Array.isArray(h.targets) && h.targets.length >= 1 && h.targets.length <= 64 && h.targets.every((t) => typeof t === "string")))
        refuse("shape", `reactions.${act} (reset) names what it sends home: targets [1 to 64 ids]`, "e.g. {reset: {kind: 'reset', targets: ['ball-0', 'ball-1']}}");
      if (h.kind === "reset") { const gone = h.targets.filter((t) => !s.entities[t]); if (gone.length) refuse("not-found", `reactions.${act} (reset) names ${gone.join(", ")}, which ${gone.length > 1 ? "aren't" : "isn't"} here`, "", { didYouMean: guess(gone[0], Object.keys(s.entities)) }); }
      if (h.kind === "script" && !(typeof h.script === "string" && isComponent(`script:${h.script}`))) refuse("shape", `reactions.${act} (script) names the script: {kind: 'script', script: '<name>'} for the script:<name> on this thing`, "e.g. {ring: {kind: 'script', script: 'bell'}}");
      handlerCheck(at, act, h); effectCheck(s, id, act, h); } }
  mediaCheck(s, id, comp, v, at, obj);
  for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(":")[0]]?.enums ?? {})) if (obj && v[f] !== undefined && !allowed.includes(v[f])) refuse("shape", `${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`, `schema {component: '${comp}'}`);
  schemaCheck(at, comp, v, { carry });
  // spec/PHYSICS.md §3.3: joint:<name> is reserved until the world's engine carries joints (ENGINES[…].joints); stored
  // now it would be a value nothing honours, and the first engine to read it would inherit whatever builders guessed
  if (baseOf(comp) === "joint" && !ENGINES[s.entities["@world"]?.c["physics-engine"]?.engine]?.joints)
    refuse("unsupported", `${at}: this world's engine doesn't carry joints (none this server carries does yet), so a joint would do nothing`, "joint:<name> is reserved (PHYSICS §3.3). parent {to} attaches rigidly; openable animates a door, lid or gate; motion swings a pendulum");
  // §3.2: a material names one of this world's surfaces
  if (comp === "physics" && obj && typeof v.material === "string" && !carry && !s.entities["@world"]?.c[`surface:${v.material}`]) { const have = Object.keys(s.entities["@world"]?.c ?? {}).filter((k) => k.startsWith("surface:")).map((k) => k.slice(8));
    refuse("not-found", `${at}.material: this world has no surface '${v.material}'${have.length ? ` (it has ${have.join(", ")})` : " (it has none)"}`, "the owner adds one: set {id: '@world', component: 'surface:<name>', value: {friction, restitution, density}}", { didYouMean: guess(v.material, have) }); }
  if (comp === "terrain-grid") { const ok = v.spacing > 0 && Number.isInteger(v.tile) && v.tile >= 1 && v.tile <= 64 && Array.isArray(v.extent) && v.extent.length === 2 && v.extent.every((n) => Number.isInteger(n) && n >= 1 && n <= 4096)
      && Array.isArray(v.origin) && v.origin.length === 2 && v.origin.every(isNum) && (v.limits === undefined || (Number.isInteger(v.limits.raise) && Number.isInteger(v.limits.lower) && v.limits.raise >= 0 && v.limits.lower >= 0));
    if (!ok) refuse("shape", `${at} must be {spacing > 0, tile 1–64, origin [x, z], extent [nx, nz], limits? {raise, lower} (mm)}`, COMPONENTS["terrain-grid"].help); }
  if (comp.startsWith("terrain-tile:")) { const g = s.entities[id]?.c["terrain-grid"]; const ij = TR.parseKey(comp);
    if (!g) refuse("no-grid", `${id} has no terrain-grid`, "set terrain-grid on the ground first");
    if (!ij || ij[0] >= g.extent[0] || ij[1] >= g.extent[1]) refuse("shape", `${comp} isn't a tile of ${id}'s ${g.extent.join("×")} grid`, "keys are <i>-<j>, counted from the grid origin");
    if (!Array.isArray(v.mm) || v.mm.length !== g.tile ** 2 || !v.mm.every(Number.isInteger)) refuse("shape", `${at}.mm must be ${g.tile ** 2} integers (millimetres)`, "");
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity;
    if (v.mm.some((n) => n < lo || n > hi)) refuse("bounds", `${at} goes outside the grid's limits (−${g.limits.lower} … +${g.limits.raise} mm)`, "terrain-grid.limits (SL's raise/lower)"); }
  // well-shaped and still here: the translator didn't see it (the door stores no old spelling)
  if (comp === "sockets") refuse("legacy", `${at} is the old spelling: each socket is a child entity now`, "create {components: {parent: {to: <host>}, transform: {pos}, socket: {name, …}}}");
}
// batch 2 (10-07): pictures, sounds, stories, signs and look-at, beyond their catalogue shape
const LOOK_WORDS = ["@viewer", "@nearest"];
const ROTATING = new Set(["pendulum", "spin"]);
const isLookAt = (k) => k === "look-at" || k.startsWith("look-at:");
const nodeOf = (k, v) => (k.includes(":") ? k.slice(k.indexOf(":") + 1) : k === "motion" && typeof v?.part === "string" ? v.part : null);   // null = the whole thing
function mediaCheck(s, id, comp, v, at, obj) {
  // where a picture's or a sound's bytes may come from (shared/mediasrc.js): this server's store, or an https link to a
  // public host. Who may FETCH a link is each viewer's browser's question (clientMayFetch); the authority refuses what nobody may
  if ((comp === "picture" || comp === "sound") && obj && v.src !== undefined) { const t = mediaTier(v.src, comp === "picture" ? "image" : "audio");
    if (t.tier === "bad") refuse("shape", `${at}.src: ${t.why}`, t.fix); }
  if (comp === "sound" && obj && isNum(v.near) && isNum(v.radius) && v.near > v.radius) refuse("bounds", `${at}.near (${v.near}) is past radius (${v.radius})`, "near is where it's at full volume; radius is where it goes silent");
  if (comp === "story" && obj && Array.isArray(v.marks)) { const seen = new Set();
    for (const m of v.marks) { if (typeof m !== "string") refuse("shape", `${at}.marks holds thing ids (strings)`, "");
      if (m === id) refuse("loop", `${id}'s story can't mark ${id} itself`, "marks names other things: what this one commemorates");
      if (seen.has(m)) refuse("shape", `${at}.marks names ${m} twice`, ""); seen.add(m);
      if (!s.entities[m] || m === "@world") refuse("not-found", `${at}.marks: no thing called '${m}'`, "look lists what's here", { didYouMean: guess(m, Object.keys(s.entities).filter((k) => k !== "@world")) }); } }
  if (comp === "text" && obj && typeof v.text === "string" && v.text.split("\n").length > 16) refuse("bounds", `${at}.text is ${v.text.split("\n").length} lines; a sign holds at most 16`, "a longer text is a story (Inspect reads it), or several signs");
  if (isLookAt(comp) && obj) {
    const T = v.target;
    if (typeof T === "string" && T.startsWith("@") && !LOOK_WORDS.includes(T)) refuse("shape", `${at}.target '${T}' isn't one of ${LOOK_WORDS.join(", ")}`, "@viewer: each viewer's own eyes; @nearest: whoever is nearest; or a thing's id, or a person's identity (u-…)", { didYouMean: guess(T, LOOK_WORDS) });
    else if (typeof T === "string" && T.startsWith("@")) { /* @viewer, @nearest */ }
    else if (typeof T === "string" && /^u-/.test(T)) { if (!isIdentity(T)) refuse("shape", `${at}.target '${T}' isn't an identity`, "who {name} finds a person's identity"); }
    else if (typeof T === "string") { if (!s.entities[T] || T === "@world") refuse("not-found", `${at}.target: no thing called '${T}'`, "look lists what's here", { didYouMean: guess(T, Object.keys(s.entities).filter((k) => k !== "@world")) });
      if (T === id || ancestors(s, T).includes(id)) refuse("loop", `${id} can't turn to face ${T === id ? "itself" : `${T}, which rides it`}`, "pick a thing outside it"); }
    for (const f of ["yaw", "pitch"]) if (v[f] !== undefined) { const lim = f === "yaw" ? 180 : 90;
      if (!(Array.isArray(v[f]) && v[f].length === 2 && v[f].every((x) => isNum(x) && Math.abs(x) <= lim) && v[f][0] <= v[f][1])) refuse("bounds", `${at}.${f} is [min, max] degrees from rest, each within ±${lim}, min ≤ max`, `e.g. ${f}: [-45, 45]`); }
    if (Array.isArray(v.offset) && v.offset.some((x) => Math.abs(x) > 50)) refuse("bounds", `${at}.offset is within ±50 m on each axis`, "");
    for (const f of ["forward", "up"]) if (typeof v[f] === "string" && !["x", "y", "z"].includes(v[f])) refuse("shape", `${at}.${f} is an axis: x|y|z or [x, y, z] (a negative one is a vector: [0, 0, -1])`, ""); }
  // one driver per node (a socket's "one drive per thing", catalogue sockets): a node turned by a rotating motion can't
  // also turn to face something, and a dynamic thing's rotation is the sim's
  if ((isLookAt(comp) || comp === "motion" || comp.startsWith("motion:")) && obj) {
    const e = s.entities[id]; const node = nodeOf(comp, v);
    if (isLookAt(comp) && e?.c.physics?.kind === "dynamic") refuse("conflict", `${id} is dynamic: physics turns it, so it can't also turn to face something`, "make it static (physics {kind: 'static'}), or put look-at on a part");
    const mine = isLookAt(comp) ? (k, x) => (k === "motion" || k.startsWith("motion:")) && ROTATING.has(x?.type) : (k) => isLookAt(k);
    if (!isLookAt(comp) && !ROTATING.has(v.type)) return;
    for (const [k, x] of Object.entries(e?.c ?? {})) if (k !== comp && mine(k, x) && nodeOf(k, x) === node)
      refuse("conflict", `${node ? `${id}'s ${node}` : id} already turns by ${isLookAt(k) ? k : `${x.type} (${k})`}; one thing turns a node at a time`, `remove ${k} first, or put ${comp.split(":")[0]} on another part`); }
}
// L7 (21:45, research 40 T10): values are checked against their schema at admit. A KNOWN name with an unknown key is
// refused with a "did you mean": Under the Eves sent terrain {amp: 0}, the engine reads `amplitude`, and the flat world
// got 3 m hills. Unknown NAMES are still kept (L5): this binds only names the catalogue defines.
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const TYPES = { number: isNum, int: Number.isInteger, string: (x) => typeof x === "string", bool: (x) => typeof x === "boolean", any: () => true,
  vec3: (x) => Array.isArray(x) && x.length === 3 && x.every(isNum),
  axis: (x) => (Array.isArray(x) && x.length === 3 && x.every(isNum)) || x === "x" || x === "y" || x === "z", // the text-tier shorthand the renderer reads (motioneval.js)
  array: Array.isArray, object: (x) => x && typeof x === "object" && !Array.isArray(x),
  // references (componentspec REF_TYPES): ids of things, identities of people, or @words where a field takes them
  ref: (x) => isEntityId(x), refs: (x) => Array.isArray(x) && x.every((y) => isEntityId(y)), person: (x) => isIdentity(x), people: (x) => Array.isArray(x) && x.every((y) => isIdentity(y)),
  target: (x) => typeof x === "string" && (isEntityId(x) || /^@[a-z]+$/.test(x)), scope: (x) => x === "self" || x === "subtree" || (Array.isArray(x) && x.every((y) => y === "self" || isEntityId(y))) };
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
 *  whether a translated world is one the authority takes as it is (sweep). */
export function schemaRefusal(comp, v) { try { schemaCheck(comp, comp, v);
    // the enums too (valueCheck's): a translated motion {type: 'path'} passed this and was refused at the first edit
    const ob = v && typeof v === "object" && !Array.isArray(v);
    for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(":")[0]]?.enums ?? {})) if (ob && v[f] !== undefined && !allowed.includes(v[f])) return `shape: ${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`;
    return null; } catch (e) { if (e instanceof Refusal) return `${e.code}: ${e.reason}`; throw e; } }
function schemaCheck(at, comp, v, { carry = false } = {}) {
  const base = baseOf(comp), name = registered(base) ?? base, def = COMPONENTS[name];
  // `param.<name>`: a number a script writes into a component for something else to read (seat poses that blend by
  // signals). Any object component may carry them at its top level; the rest of the value is checked as usual.
  if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => k.startsWith("param."))) {
    for (const k of Object.keys(v)) if (k.startsWith("param.")) {
      if (!SR.isParamKey(k)) refuse("shape", `${at}: '${k}' isn't a parameter name`, "param.<name>: a letter, then letters, digits, _ or -, up to 32 (e.g. param.lean)");
      if (!isNum(v[k])) refuse("shape", `${at}.${k} is a number (a signal), got ${JSON.stringify(v[k]).slice(0, 40)}`, "a script writes it with world.param(id, component, name, number)"); }
    v = Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("param.")));
  }
  // PROTOCOL §4 (review 10-07 H1, R's ruling): a bare name is the registry's. An unregistered one is refused: a typo of
  // a registered name says "did you mean"; a versioned one (light@2) says a new meaning is registered first; anything
  // else is someone's own component, which carries a namespace (example.org/heart). Before this they were admitted, and
  // the registry later promoting the same word (story) would have reread every old value in the new meaning.
  // `carry`: a fork's copy of what its parent already holds (an old world's bare invention travels as it was).
  if (name === "door") refuse("schema", `${at}: the opening behaviour is called 'openable' (R 10-07: chests, gates, lids and hatches open too)`, "openable {open: false, locked?, angle?, slide?, time?}; schema {component: 'openable'} says the rest", { didYouMean: ["openable"] });
  if (name === "placer") refuse("derived", `${at}: who made a thing is a view over the log (§0 rule 2), never stored`, "inspect {id} → derived.madeBy");
  if (!def) { if (isNamespaced(base) || carry) return;   // someone's own: kept, replayed, shown honestly (must-ignore)
    const ver = /^(.*)@[1-9][0-9]*$/.exec(name);
    if (ver && COMPONENTS[ver[1]]) refuse("schema", `${at}: '${name}' isn't registered yet: a changed meaning of '${ver[1]}' is a new name, registered (saying what it supersedes) before anyone writes it`, `use '${ver[1]}' as it is defined (schema {component: '${ver[1]}'}), or propose ${name} for the registry (shared/protocol/componentspec.js); a meaning of your own goes under your namespace: 'example.org/${name}'`, { didYouMean: [ver[1]] });
    const near = nearMiss(name);
    if (near.length) refuse("schema", `${at}: '${name}' isn't a component; did you mean '${near[0]}'?`, `${near[0]}: ${COMPONENTS[near[0]].help ?? ""}. A component of your own carries a namespace (e.g. 'example.org/${name}')`, { didYouMean: near });
    refuse("schema", `${at}: '${name}' isn't a registered component; bare names belong to the registry (PROTOCOL §4)`, `a component of your own carries a namespace: '<your domain or handle>/${name}', e.g. 'example.org/${name}'. It's kept and shown as it is; schema lists the registered ones`, { didYouMean: [`example.org/${name}`] });
  }
  // a keyed name written bare, or an unkeyed one written keyed (terrain:base {amp}, light:main {...}), dodged every check
  if (def.keyed !== "optional" && !!def.keyed !== comp.includes(":")) refuse("shape", def.keyed ? `${at}: ${name} is keyed (${name}:<key>)` : `${at}: ${name} isn't keyed; write '${name}', not '${comp}'`, def.help ?? "");
  if (def.type && !TYPES[def.type](v)) refuse("shape", `${at} must be a ${def.type}, got ${JSON.stringify(v).slice(0, 40)}`, def.help ?? "");
  // a whole-value string (description): its length in graphemes and the words-everyone-reads check, as a field's
  if (def.type === "string" && typeof v === "string") {
    if (def.maxLen !== undefined && graphemes(v) > def.maxLen) refuse("bounds", `${at} is ${graphemes(v).toLocaleString("en")} characters; it must be ≤ ${def.maxLen}`, def.help ?? "");
    if (def.cleanAs) { const bad = cleanText(v, { lines: def.cleanAs === "lines" }); if (bad) refuse("shape", `${at} ${bad.why}`, bad.fix); } }
  // a socket's whole shape (shared/sockbody.js: closed keys, ranges, enums, one driver per thing), in its own words
  if (name === "sockets") { const bad = checkSockets(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.sockets.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (name === "socket") { const bad = checkSocket(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.socket.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  // what a hand may do with it (shared/grab.js: closed keys, ranges, enums, grips), in its own words
  if (name === "grabbable") { const bad = checkGrabbable(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.grabbable.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (def.map) { if (!(v && typeof v === "object" && !Array.isArray(v)) || Object.values(v).some((x) => !TYPES[def.map](x))) refuse("shape", `${at} must be {<name>: ${def.map}}`, def.help ?? ""); }
  if (!def.fields) return;
  if (name === "lock" && v === true) return;   // a plain lock is true (builder level); its {rank} form is checked as an object below
  const fields = Object.keys(def.fields);
  if (!(v && typeof v === "object" && !Array.isArray(v))) refuse("shape", `${at} must be an object {${fields.join(", ")}}`, def.help);
  unknownKeys(at, v, fields, name);
  const kind = v.kind ?? def.defaultKind; // an imported world's terrain never named its kind: it is noise
  if (def.byKind) { if (!def.byKind[kind]) refuse("schema", `${at}.kind must be one of ${Object.keys(def.byKind).join(" | ")}, got ${JSON.stringify(v.kind)}`, def.help, { didYouMean: guess(String(v.kind), Object.keys(def.byKind)) });
    unknownKeys(at, v, def.byKind[kind], `${name} {kind: '${kind}'}`); }
  for (const [k, t] of Object.entries(def.fields)) if (v[k] !== undefined && !TYPES[t](v[k])) refuse("shape", `${at}.${k} must be ${t}, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
  for (const k of def.required ?? []) if (v[k] === undefined) refuse("schema", `${at} needs ${k}`, def.help);
  // a field's grammar narrows its pinned type (physics.shape is `any` in every value ever stored): spec/PHYSICS.md §3.1
  for (const [k, g] of Object.entries(def.grammar ?? {})) if (v[k] !== undefined && g === "shape") { const why = shapeError(v[k]);
    if (why) refuse("shape", `${at}.${k}: ${why}`, "PHYSICS §3.1: a box [[min], [max]] or {type: sphere|capsule|cylinder|box|convex|mesh|compound, …}; the authority stamps it from the model"); }
  for (const [k, r] of Object.entries(def.ranges ?? {})) { const x = v[k]; if (x === undefined) continue;
    // batch 2: a length cap on text (counted in graphemes, as a reader counts: a ZWJ family is 1) and a count cap on lists
    if (r.maxLen !== undefined || r.maxItems !== undefined) { const n = typeof x === "string" ? graphemes(x) : Array.isArray(x) ? x.length : 0;
      const cap = typeof x === "string" ? r.maxLen : r.maxItems;
      if (cap !== undefined && n > cap) refuse("bounds", `${at}.${k} is ${n.toLocaleString("en")} ${typeof x === "string" ? "characters" : "items"}; it must be ≤ ${cap}`, def.help);
      continue; }
    // a vector's range holds for each element (mesh.size)
    const bad = Array.isArray(x) ? x.some((n) => typeof n === "number" && outOfRange(r, n)) : outOfRange(r, x);
    if (bad) refuse("bounds", `${at}.${k} is ${JSON.stringify(x)}; ${Array.isArray(x) ? "each" : "it"} must be ${rangeWords(r)}`, def.help); }
  if (name === "script" && v.scope) unknownKeys(`${at}.scope`, v.scope, Object.keys(def.scopeFields), "a script's scope");
  // batch 2: words everyone reads are checked once, here (shared/text.js): no direction overrides, no hidden controls, no zalgo
  for (const [k, how] of Object.entries(def.clean ?? {})) if (typeof v[k] === "string") { const bad = cleanText(v[k], { lines: how === "lines" });
    if (bad) refuse("shape", `${at}.${k} ${bad.why}`, bad.fix); }
}
// N5 (review 10-07): a handler is checked when it's WRITTEN, not when the first visitor uses it. What it would write is
// checked now as the authority would check that write (a light's intensity 'bright' was taken, and the visitor got "must be
// number"); a field it changes must be inside a component the thing has (a toggle on a plain crate wrote an invisible
// openable); toggle flips true/false fields; an impulse swings a pendulum. Rights stay a use-time question (reactionCap).
function effectCheck(s, id, act, h) {
  const c = s.entities[id]?.c ?? {}; const isObj = (x) => x && typeof x === "object" && !Array.isArray(x) && x !== PURGED;
  const where = `reactions.${act}`;
  const would = (comp, value) => { try { valueCheck(s, { id, comp, value }); }
    catch (e) { if (!(e instanceof Refusal)) throw e; refuse(e.code, `${where} would set ${id}.${comp} to something the authority refuses: ${e.reason}`, e.fix, e.didYouMean ? { didYouMean: e.didYouMean } : undefined); } };
  if (h.kind === "impulse" && c.motion && c.motion.type !== "pendulum") refuse("shape", `${where} pushes a swing, and ${id} moves by '${c.motion.type}'`, "an impulse swings a pendulum (motion {type: 'pendulum'}); use set or toggle for anything else");
  if (h.kind !== "set" && h.kind !== "toggle") return;
  const { comp, field } = h.kind === "toggle" ? toggleOf(h) : { comp: h.component, field: h.field };
  if (field !== undefined && !isObj(c[comp])) refuse("no-target", `${where} changes ${comp}.${field}, and ${id} has no ${comp}`,
    comp === "openable" && h.component === undefined ? "make it openable first (openable {open: false}), or name the component and field to flip" : `give it ${comp} first (in the same batch is fine)`);
  const ftype = COMPONENTS[comp.split(":")[0]]?.fields?.[field];
  if (h.kind === "toggle" && field !== undefined && ftype && ftype !== "bool" && ftype !== "any") refuse("shape", `${where} flips ${comp}.${field}, which is a ${ftype}; a toggle flips true/false`, "use a set handler to give it a value");
  if (h.kind === "toggle") { if (field === undefined) would(comp, !c[comp]); else { would(comp, { ...c[comp], [field]: true }); would(comp, { ...c[comp], [field]: false }); } }
  else would(comp, field === undefined ? h.value : { ...c[comp], [field]: h.value });
}
function handlerCheck(at, act, h) {
  const R = COMPONENTS.reactions; const allowed = [...Object.keys(R.common), ...Object.keys(R.handlers[h.kind]?.args ?? {})];
  unknownKeys(`${at}.${act}`, h, [...new Set(allowed)], `a '${h.kind}' handler`);
}
// L3: a rest must equal the engine's value. The gate asks the engine itself, not the caller.
function restCheck(w, cap, after) {
  const sf = w.sim();
  for (const id of cap.ids) { const b = sf.sim?.bodies[id];   // every body the rest names (one change may rest a launch's whole batch)
    const lost = sf.rested.some((r) => r.id === id && r.seq === cap.launch && r.lost);   // crossed the edge in flight: rests on the record where it is
    if (!lost && (!b || !b.resting || sf.launched[id]?.seq !== cap.launch)) refuse("not-at-rest", `the engine doesn't have ${id} at rest from launch ${cap.launch}`, "");
    if (JSON.stringify(worldPose(after, id).pos) !== JSON.stringify(b.p)) refuse("not-the-engine's", `${id} would rest at ${JSON.stringify(worldPose(after, id).pos)}; the engine has it at ${JSON.stringify(b.p)}`, "");
    if (b.q && JSON.stringify(worldPose(after, id).q) !== JSON.stringify(b.q)) refuse("not-the-engine's", `${id} would rest turned ${JSON.stringify(worldPose(after, id).q)}; the engine has it at ${JSON.stringify(b.q)}`, ""); }
}
function changeShape(plan, cause, w) {
  // §2.4: in a chained log every set carries a salt (base64url, 16 random bytes), so a purged value's commit can't be
  // brute-forced from a guess. Added here, before fits() measures the entry. The fold ignores it.
  const ops = plan.ops.map((o) => (o.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o)); const one = ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } };
  return { kind: "change", actor: plan.who.actor, cause, ...one };
}
function changeEntry(w, plan, cause) {
  if (!(plan instanceof Admitted)) throw new Error("authority bug: a state write that admit() didn't produce (§7)");
  const seq = w.append(changeShape(plan, cause, w), CHANGE);
  (w.changedQ ??= []).push(seq); // `changed:<comp>` events, drained after the request (scripts, below)
  return seq;
}
const actEntry = (w, actor, verb, body) => ({ kind: "act", actor, verb, body });
const actOf = (w, actor, verb, args, extra) => actEntry(w, actor, verb, { request: stripDry(args), ...(extra ?? {}) });

// A write: build ops against the folded state, admit them, then append the act and its one change entry.
function commit(w, actor, verb, args, build) {
  CTX.mintW = w;
  const sent = clone(args); // L4: the act is the request AS SENT (builders may annotate their own copy)
  const st = w.state();
  const ctx = { st, actor, w, notes: [], refs: new Set() };
  const ops = stampMedia(ctx, stampResetHomes(ctx, stampHomes(ctx, stampShapes(ctx, build(ctx)))));
  const plan = admit(w, st, { actor, cap: ctx.cap, restores: ctx.restores }, ops); ctx.notes.push(...plan.notes);
  if (args.dry) return { ok: true, dry: true, would: plan.ops, notes: ctx.notes, ...warnOrNot(warnings(plan.after, [...ctx.refs])) };
  const actE = actOf(w, actor, verb, sent, ctx.actExtra);
  w.fits(actE, changeShape(plan, w.entries.length, w)); // both lines fit, or neither is written
  const act = w.append(actE);
  const seq = changeEntry(w, plan, act);
  const after = w.state();
  resettleRiders(w, actor, plan.ops, st, after, act, ctx.notes);
  // an edit that moves, re-parents or removes a thing in someone's hand takes it out of the hand: it is where the edit
  // put it now. (R, 10-10: moved a held barrel in edit mode; her client let go, the authority didn't, and every throw
  // after was refused from a hand the two no longer agreed on.)
  { let let_go = false;
    for (const o of plan.ops) { const h = w.presence.holds?.[o.id]; if (!h) continue;
      // switching it off takes it out of the hand too (review 5d5eef5c #5): an off thing can't be thrown, so it's set down where
      // the record has it. Keep this set in step with simlayer's RELEASES.
      if (o.verb === "delete" ? (o.comp === undefined || o.comp === "transform" || o.comp === "parent") : (o.comp === "transform" || o.comp === "parent" || (o.comp === "disabled" && o.value === true))) {
        delete w.presence.holds[o.id]; let_go = true; heldEvent(w, "release", o.id, { by: h.by, how: "edited", seq: act }); ctx.notes.push({ id: o.id, tookFromHand: h.by, why: "an edit moved it, so it left the hand that held it" }); } }
    // …and switching off (or removing) a thing lets go of whatever is held UNDER it (attack-editor S2-1: a held child of a
    // switched-off parent could be neither put, dropped nor thrown; only its parent's return freed the hand)
    const offed = plan.ops.filter((o) => (o.verb === "set" && o.comp === "disabled" && o.value === true) || (o.verb === "delete" && o.comp === undefined)).map((o) => o.id);
    if (offed.length) for (const [id, h] of Object.entries(w.presence.holds ?? {})) {
      if (!after.entities[id] || !ancestors(after, id).some((p) => offed.includes(p))) continue;
      delete w.presence.holds[id]; let_go = true; heldEvent(w, "release", id, { by: h.by, how: "edited", seq: act }); ctx.notes.push({ id, tookFromHand: h.by, why: "what it hangs under was switched off, so it left the hand that held it" }); }
    if (let_go) w.savePresence(); }
  for (const who of Object.keys(w.presence.seats ?? {})) if (!seatOf(w, after, who)) { clearSeat(w, who); ctx.notes.push({ who, unseated: true, why: "the socket they sat on was switched off or removed" }); }
  return { ok: true, seq, head: w.headAt(seq), act, refs: [...ctx.refs].filter((id) => after.entities[id]).map((id) => ({ id, born: after.entities[id].born })),
    after: touched(plan.ops, after), ...(ctx.undid ? { undid: ctx.undid } : {}), ...(ctx.notes.length ? { notes: ctx.notes } : {}), ...warnOrNot(warnings(after, [...ctx.refs])) };
}
// review S2.4 (R 10-12): a geometry write moves a thing's top (a mesh resized, a model swapped, its scale changed), and what the
// physics had stacked on it (its dynamic children, attached by their rest) kept their local pose: floating over a shrunk
// plinth, or scaled with a model's new size. They are re-dropped: under a carried engine a zero-velocity launch from where
// each stands (the engine logs where it lands, as a grab's fallen dependents are); with no engine, set straight down onto
// what is under them. A held, locked or already flying child is left alone. A move or a turn is not a geometry write: the
// stack rides along, as it always did.
function resettleRiders(w, actor, ops, before, after0, act, notes) { let after = after0;
  // what a host's top depends on: its geometry (a mesh's size, a model's measured box, or none) and its scale. A write that
  // leaves these as they were (the same value re-asserted, a move, a turn) re-drops nothing (review r2 S2.1); a delete of the
  // geometry is a change like any other (r2 S2.3)
  const geomKey = (st, id) => { const e = st.entities[id]; const m = e ? geomE(e) : null; return JSON.stringify([m ? boxOfM(m) : null, e?.c.transform?.scale ?? [1, 1, 1]]); };
  const hosts = new Set(ops.filter((o) => (o.verb === "set" || o.verb === "delete") && before.entities[o.id] && after.entities[o.id] && (o.comp === "mesh" || o.comp === "model" || o.comp === "transform") && geomKey(before, o.id) !== geomKey(after, o.id)).map((o) => o.id));
  if (!hosts.size) return;
  // a child on a SOCKET is the socket's child, which has no top: never a rider (r2 S2.2: a cup on its perch was torn off and dropped)
  const riders = Object.keys(after.entities).filter((k) => { const c = after.entities[k].c;
    return hosts.has(c.parent?.to) && c.physics?.kind === "dynamic" && !lockedC(c) && !w.presence.holds[k] && !w.presence.holds[c.parent.to] && !after.entities[k].c.disabled && aabb(after, k); });
  if (!riders.length) return;
  const spec = after.entities["@world"]?.c["physics-engine"];
  if (spec && carried(spec)) {
    const flying = new Set(Object.keys(w.sim?.()?.launched ?? {}));
    const dropped = riders.filter((k) => !flying.has(k));
    // out from under the host first, standing where it stood in the world: its rest re-attaches it to whatever it lands on
    // with a fresh local pose (a rest keeps a child's recorded scale, and that scale was compensation for the OLD host size)
    // (as it stood BEFORE the write: a model host's new scale had already carried the child's world pose and size with it)
    if (dropped.length) { const free = dropped.flatMap((k) => { const t = worldT(before, k); return [delOp(k, "parent"), setOp(k, "transform", { pos: t.pos.map(r3), q: qr3(t.q), scale: t.scale.map(r3) })]; });
      changeEntry(w, admit(w, after, { actor, cap: { kind: "system", ids: dropped, comps: ["transform", "parent"] } }, free), act); after = w.state(); }
    for (const k of dropped) { const t = worldT(before, k);
      w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: k, p: t.pos.slice(), yaw: qYaw(t.q), ...(ENGINES[spec.engine]?.rotates ? { q: t.q.slice() } : {}), v: [0, 0, 0], handled: [actor] } }); }
    if (dropped.length) notes.push({ fell: dropped, why: "they were resting on a thing whose shape changed; they fall to its new top (physics will log where they land)" });
    return;
  }
  // no engine: set each rider down from ABOVE the host's new top (a grown host would otherwise bury it: supportUnder only
  // counts faces at or below where the rider stands; r2 S1.1). A host that lost its body frees its riders to the world
  const setOps = riders.flatMap((k) => { const host = after.entities[k].c.parent.to; const b = aabb(after, k); const hb = aabb(after, host); const wt = worldT(after, k);
    const lift = hb ? Math.max(0, hb.max[1] - b.min[1]) : 0; const probe = { min: [b.min[0], b.min[1] + lift, b.min[2]], max: [b.max[0], b.max[1] + lift, b.max[2]] };
    const below = supportUnder(after, probe, new Set([k, ...descendants(after, k)])); const wpos = [wt.pos[0], r3(wt.pos[1] - (b.min[1] - below.y)), wt.pos[2]];
    if (!hb) return [delOp(k, "parent"), setOp(k, "transform", { pos: wpos, q: qr3(wt.q), scale: wt.scale.map(r3) })];
    const lt = localFrom(after, host, { ...wt, pos: wpos });
    const v = { ...after.entities[k].c.transform, pos: lt.pos }; return JSON.stringify(v) === JSON.stringify(after.entities[k].c.transform) ? [] : [setOp(k, "transform", v)]; });
  if (!setOps.length) return;
  const plan = admit(w, after, { actor, cap: { kind: "system", ids: riders, comps: ["transform", "parent"] } }, setOps);
  changeEntry(w, plan, act);
  notes.push({ setDown: [...new Set(setOps.map((o) => o.id))], why: "they were resting on a thing whose shape changed; with no physics running they were set straight down onto what is under them now" });
}
// P7 + Covenant III: a thing is in the sim by its `physics` component, and its geometry enters the sim only through the
// log, as physics.shape: the AUTHORITY's measurement of its model (model-local box [[min], [max]]), never the asker's word.
// The live server folds the sim with no catalogue of its own (livehost.ts: simModels {}), so a thing with no stamped shape
// is no body at all: thrown, it never flew and never rested (found 10-06: every throw on a running server did nothing).
// Stamped on every write of the asker's own (a capability's writes are scoped to what they name and are left alone):
//   - a physics value written (create or set): its shape is the authority's, whatever was sent;
//   - a model changed on a thing with physics: re-measured;
//   - a modelled thing made while the world runs physics, and every standing thing when physics is turned on (or its
//     engine changed): physics {kind: 'static', shape} unless it has physics already (translate-d3 writes the same).
const r4 = (n) => Math.round(n * 1e4) / 1e4;
// the authority's measurement of a model as a collider. A sphere is asked for with collider.shape "sphere" (PHYSICS §3.1:
// the request vocabulary; the stamp is the tagged shape): fitted to the measured box, centred on it, radius its largest
// half extent (a ball's box is a cube, so this is the ball)
const shapeFor = (model, req) => { const m = geomOf(model); if (!m) return null; const b = boxOfM(m);
  if (req === "sphere") return { type: "sphere", radius: r4(Math.max(...[0, 1, 2].map((k) => (b[1][k] - b[0][k]) / 2))), pos: [0, 1, 2].map((k) => r4((b[0][k] + b[1][k]) / 2)) };
  return b.map((c) => c.map(r4)); };
function stampShapes(ctx, ops) {
  if (ctx.cap || !ops.length) return ops;
  const after = scratch(ctx.st, ops); const simOn = !!after.entities["@world"]?.c["physics-engine"];
  const ids = new Set();
  for (const o of ops) if ((o.verb === "set" || o.verb === "delete") && o.comp && (o.comp === "physics" || o.comp === "model" || o.comp === "collider" || o.comp === "mesh")) ids.add(o.id);
  if (simOn) for (const o of ops) if (o.verb === "create") ids.add(o.id);
  if (ops.some((o) => o.id === "@world" && o.comp === "physics-engine" && o.verb === "set") && simOn) for (const id of Object.keys(after.entities)) ids.add(id);
  ids.delete("@world");
  const out = ops.slice(); const stamped = [], unstamped = [], rounded = [];
  for (const id of ids) {
    const e = after.entities[id]; if (!e) continue;
    const ph = e.c.physics; const want = typeof e.c.model === "string" ? shapeFor(e.c.model, e.c.collider?.shape) : e.c.mesh !== undefined ? meshShape(e.c.mesh) : null;
    let next;
    if (ph === undefined || ph === null) { if (!simOn || !want) continue; next = { kind: "static", shape: want }; }
    else if (typeof ph !== "object" || Array.isArray(ph)) continue; // valueCheck refuses it
    else { if (JSON.stringify(ph.shape ?? null) === JSON.stringify(want)) continue;
      next = { ...ph }; if (want) next.shape = want; else delete next.shape;
      if (ph.shape !== undefined && ops.some((o) => o.verb === "set" && o.comp === "physics" && o.id === id && o.value?.shape !== undefined))
        ctx.notes.push({ id, component: "physics", field: "shape", why: "stamped by the authority: a shape is its measurement of the model (Covenant III), never the asker's" }); }
    const k = out.findIndex((o) => o.verb === "set" && o.comp === "physics" && o.id === id);
    if (k >= 0) out[k] = setOp(id, "physics", next); else { out.push(setOp(id, "physics", next)); if (next.shape) stamped.push(id); else unstamped.push(id); }
    if (want && (e.c.mesh?.shape === "cylinder" || e.c.mesh?.shape === "capsule")) rounded.push(id);
  }
  if (stamped.length) ctx.notes.push({ component: "physics", stamped: stamped.length <= 12 ? stamped : stamped.length, why: "this world runs physics: things with a model or a mesh are colliders, with the authority's measured shape" });
  if (unstamped.length) ctx.notes.push({ component: "physics", unstamped: unstamped.length <= 12 ? unstamped : unstamped.length, why: "its body is gone, so its measured shape is gone with it: it is no collider now" });
  if (rounded.length) ctx.notes.push({ component: "physics", field: "shape", ids: rounded.length <= 12 ? rounded : rounded.length, why: "a cylinder or a capsule is stamped as its bounding BOX: no carried engine reads a cylinder, so it collides, stacks and measures as a box" });
  return out;
}
// batch 2: a sound starts on the authority's clock. When a write leaves a sound playing and it wasn't before (no sound, paused,
// another file) or the request named no t0, the authority sets t0 = now and says so: a reaction, a script, an agent and the
// editor all start it in step, and no client invents its own clock (as motion.t0). A pause keeps t0; a resume restarts.
// And a link's reach is said once, when it's written: who will hear or see it (shared/mediasrc.js).
function stampMedia(ctx, ops) {
  if (!ops.some((o) => o.verb === "set" && (o.comp === "sound" || o.comp === "picture"))) return ops;
  return ops.map((o) => {
    if (o.verb !== "set" || !(o.comp === "sound" || o.comp === "picture") || !o.value || typeof o.value !== "object" || Array.isArray(o.value)) return o;
    const v = o.value; const prev = ctx.st.entities[o.id]?.c[o.comp];
    if (typeof v.src === "string" && /^https:/i.test(v.src) && (!prev || prev.src !== v.src)) { const t = mediaTier(v.src, o.comp === "picture" ? "image" : "audio");
      if (t.tier === "host" || t.tier === "link") ctx.notes.push({ id: o.id, component: o.comp, field: "src", reach: t.tier === "host" ? "everyone" : "opted-in", why: tierWords(t, o.comp === "picture" ? "image" : "audio") }); }
    if (o.comp !== "sound" || v.playing === false) return o;
    const p = prev && typeof prev === "object" && !Array.isArray(prev) ? prev : null;
    if (p && p.playing !== false && p.src === v.src && v.t0 !== undefined) return o;
    const t0 = ctx.w.now(); ctx.notes.push({ id: o.id, component: "sound", field: "t0", kept: t0, why: "stamped by the authority: it starts now, for everyone at once" });
    return { ...o, value: { ...v, t0 } };
  });
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

function lastTouch(w, id, comp, { editsOnly = false } = {}) {
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    if (editsOnly && w.entries[e.cause]?.body?.capability) continue;   // a use's own write (a toggle flipped it): not an author
    for (const o of opsQuiet(e)) { if (o.id !== id) continue;
      if (o.verb === "create" || o.comp === comp || (o.verb === "delete" && o.comp === undefined)) return { seq: i, actor: e.actor }; } }
  return null;
}
// who last changed each component, within a horizon of this thing's own recent entries (R 10-04: "only the most recent
// x log steps… after that a deep search"). Past the horizon it says so ({beyond}) — never "default" or "never changed".
export const TOUCH_HORIZON = 200;
function touchedOf(w, id, comps, horizon = TOUCH_HORIZON) {
  const out = {}; const want = new Set(comps); let seen = 0, oldest = null;
  for (const i of backward(w, id)) { if (!want.size || seen >= horizon) break; const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    seen++; oldest = i;
    for (const o of opsQuiet(e)) { if (o.id !== id) continue;
      const hit = o.verb === "create" ? [...want] : want.has(o.comp) ? [o.comp] : [];
      for (const c of hit) { out[c] = { seq: i, by: e.actor, who: said(e.actor), ts: e.ts, ...(o.verb === "create" ? { created: true } : {}) }; want.delete(c); } } }
  for (const c of want) out[c] = { beyond: oldest ?? 0 };   // not found in the window: "unchanged since before #N"
  return out;
}
const opsTouching = (e, id) => opsQuiet(e).filter((o) => o.id === id);
// What one change did to a thing, in a few words a person can read (R 10-10 23:55: "Is there a reason the history isn't more
// explicit? ... does the World log actually not know what I set at any of these logged spots?" It does: every entry
// carries the whole new value). Per component: the fields that differ from its previous value, 'a → b'.
function historyDiff(w, id, at, ops) {
  const out = {};
  const prevOf = (comp) => { for (const j of backward(w, id)) { if (j >= at) continue; const e = w.entries[j]; if (!isE(e) || e.kind !== "change") continue;
    const os = opsTouching(e, id); for (let k = os.length - 1; k >= 0; k--) { const o = os[k]; if (o.verb === "set" && o.comp === comp) return o.value; if (o.verb === "delete" && (o.comp === comp || o.comp === undefined)) return undefined; if (o.verb === "create") return undefined; } }
    return undefined; };
  const word = (v) => v === undefined ? "none" : v === true ? "on" : v === false ? "off" : typeof v === "number" ? String(+v.toPrecision(4)) : typeof v === "string" ? JSON.stringify(v.length > 24 ? v.slice(0, 23) + "…" : v)
    : Array.isArray(v) && v.length <= 4 && v.every((n) => typeof n === "number") ? `(${v.map((n) => +n.toPrecision(3)).join(", ")})` : Array.isArray(v) ? `[${v.length}]` : "{…}";
  for (const o of ops) {
    if (!o.comp || (o.verb !== "set" && o.verb !== "delete")) continue;
    const was = prevOf(o.comp), now = o.verb === "delete" ? undefined : o.value; const bits = [];
    if (was && now && typeof was === "object" && typeof now === "object" && !Array.isArray(was) && !Array.isArray(now)) {
      for (const k of new Set([...Object.keys(was), ...Object.keys(now)])) if (JSON.stringify(was[k]) !== JSON.stringify(now[k])) bits.push(`${k} ${word(was[k])} → ${word(now[k])}`);
    } else if (JSON.stringify(was) !== JSON.stringify(now)) bits.push(was === undefined ? `set ${word(now)}` : now === undefined ? `removed (was ${word(was)})` : `${word(was)} → ${word(now)}`);
    if (bits.length) out[o.comp] = bits.slice(0, 4).join(", ") + (bits.length > 4 ? ` (+${bits.length - 4})` : "");
  }
  return Object.keys(out).length ? out : null;
}

// a switched-off thing (componentspec disabled, itself or what it hangs under) can't be handled: it's a link in the record
function offRefuse(st, id, what) { const k = offChain(st, id); if (k) refuse("disabled", k === id ? `${id} is switched off, so it can't be ${what}` : `${id} hangs under ${k}, which is switched off, so it can't be ${what}`, `an editor switches it back on: delete {id: '${k}', component: 'disabled'}`); }
// a socket is part of its host, never a thing a hand or a foot moves on its own
function notAThing(st, id, what) { const c = st.entities[id]?.c;
  if (isSocketC(c)) refuse("not-a-thing", `${id} is a socket on ${c.parent?.to}, so it can't be ${what}`, `use {id: '${id}'} to sit or attach there, or let go of a thing that fits near it to snap it in`); }
function needThing(ctx, id) {
  const e = ctx.st.entities[id];
  if (!e) refuse("not-found", `no thing called '${id}'`, "look lists what's here", { didYouMean: guess(String(id), Object.keys(ctx.st.entities)) });
  const by = id === "@world" ? null : madeBy(ctx.w, id);
  if (by && by !== ctx.actor && !ctx.__owned?.has(id)) { (ctx.__owned ??= new Set()).add(id); ctx.notes.push({ id, madeBy: by, why: `this is ${said(by)}'s; your change is attributed to you and shows in their "changes to my things"` }); }
  return e;
}

// Resolve a component value fully (R7): defaults written out, conveniences converted, stamps applied. Shape and rights
// are admit's; this only turns what was asked into a plain value.
// @world.bounds as the readers use it: a malformed one already in a log (written before the authority checked it) is
// treated as no bounds, never a crash in every create's reply (review T0d)
// x, z and the sky; the floor is the terrain's (bounds.min[1] sits above the default heightfield)
const outsideWorld = (B, p) => p[0] < B.min[0] || p[0] > B.max[0] || p[2] < B.min[2] || p[2] > B.max[2] || p[1] > B.max[1];
const boundsOf = (st) => { const B = st.entities["@world"]?.c.bounds; const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && v3(B.min) && v3(B.max) ? B : null; };
function resolve(ctx, id, comp, value, prev) {
  const def = !comp.includes(":") || comp.startsWith("look-at:") ? defOf(comp) : undefined;   // an alias has its registered name's defaults; a part's look-at the whole one's
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
  if (!defOf(comp) && isNamespaced(comp)) ctx.notes.push({ id, component: comp, why: `'${comp}' is a namespaced component this world's engine doesn't know: it is kept (and will be preserved), but nothing here will draw or run it` });
  // every parameter written down (PROTOCOL §4): the definition's defaults and per-kind rules (componentspec materialize)
  const filled = (v, list) => { if (list.length) ctx.notes.push({ id, component: comp, filled: list, why: "defaults written out so the engine can't change them later" }); return v; };
  if (comp === "motion" && value && typeof value === "object") { const m = materialize("motion", value); const v = filled(m.value, m.filled); delete v.pivot;
    if (v.t0 === undefined) { v.t0 = ctx.w.now(); ctx.notes.push({ id, component: "motion", field: "t0", kept: v.t0, why: "stamped by the authority" }); } return v; }
  // a part's motion (motion:<part>) runs on the same clock: without a stamp every client started it from its own first
  // look and disagreed on its phase (a swing's seat, locked to that phase, pumped out of step on every screen)
  if (comp.startsWith("motion:") && value && typeof value === "object" && !Array.isArray(value)) { const m = materialize("motion", value); const v = filled(m.value, m.filled);
    if (v.t0 === undefined) { v.t0 = ctx.w.now(); ctx.notes.push({ id, component: comp, field: "t0", kept: v.t0, why: "stamped by the authority" }); } return v; }
  if (def && value && typeof value === "object" && !Array.isArray(value)) { const m = materialize(comp, value); return filled(m.value, m.filled); }
  return value;
}
function merge7396(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = merge7396(out[k], v); }
  return out;
}
// a fresh id: never one this world has had (§3d H7), nor one already used in this request
// review 10-07 H5: <slug>-<26 base32> (shared/protocol/ids.js), never <slug>-<count>, which two forks minted alike
function mint(st, base) { const ever = CTX.mintW?.everIds() ?? new Set(); let id;
  do id = mintId(slug(base)); while (st.entities[id] || ever.has(id)); return id; }

function buildCreate(ctx, a) {
  if (a.from) return buildCreateFrom(ctx, a);
  const comps = { ...(a.components ?? {}) };
  if (a.model) comps.model = a.model;
  const id = a.id ?? mint(ctx.st, comps.model ?? "thing");
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; or leave id out and the authority mints one");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id, or leave id out and the server mints one");
  for (const k of Object.keys(comps)) if (!isComponent(k)) refuse("shape", `'${k}' isn't a component name`, "§3.1: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key>", { didYouMean: guess(k, Object.keys(COMPONENTS)) });
  const out = {};
  for (const [k, v] of Object.entries(comps)) out[k] = resolve(ctx, id, k, v);
  if (!out.transform) out.transform = resolve(ctx, id, "transform", {});
  ctx.refs.add(id); // who made it is the create entry's actor: a view, never a stored `placer` (L2)
  const made = createOps(id, out);
  if (!a.place) return made;
  admit(ctx.w, ctx.st, { actor: ctx.actor }, made);   // the one gate before place solves (security pass 2 H-A); again on the whole write after
  const placed = buildPlace({ ...ctx, st: scratch(ctx.st, made) }, { ...a.place, id, __made: true });
  return [...made.filter((o) => !(o.verb === "set" && (o.comp === "transform" || o.comp === "parent"))), ...placed.filter((o) => o.verb === "set")];
}

function buildSet(ctx, a) {
  const e = needThing(ctx, a.id);
  if (!isComponent(a.component)) refuse("shape", `'${a.component}' isn't a component name`, "§3.1: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key> (ASCII only)", { didYouMean: guess(String(a.component), Object.keys(COMPONENTS)) });
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
  if (a.id === "@world" && a.component === "physics-engine") return buildEpoch(ctx, v, a);
  v = resolve(ctx, a.id, a.component, v);
  ctx.refs.add(a.id);
  return [setOp(a.id, a.component, v)];
}

function buildDelete(ctx, a) {
  const e = needThing(ctx, a.id);
  if (a.id === "@world" && a.component === "physics-engine") return buildEpoch(ctx, null, a);
  if (a.component !== undefined) {
    if (a.component === "parent" && e.c.parent) {
      const wt = worldT(ctx.st, a.id); ctx.refs.add(a.id);
      return [delOp(a.id, "parent"), setOp(a.id, "transform", { ...wt, pos: wt.pos.map(r3) })];
    }
    // the old spelling's `delete sockets` still means "its sockets" (the door deletes its socket children)
    if (!(a.component in e.c) && !(a.component === "sockets" && socketsOf(ctx.st, a.id).some((x) => x.id))) refuse("not-found", `${a.id} has no ${a.component}`, `it has: ${Object.keys(e.c).join(", ")}`);
    ctx.refs.add(a.id);
    return [delOp(a.id, a.component)];
  }
  const kids = descendants(ctx.st, a.id);
  if (kids.length) ctx.notes.push({ id: a.id, why: `its ${kids.length} children went with it: ${kids.join(", ")}` });
  const gone = new Set([a.id, ...kids]); const ops = [...kids.reverse(), a.id].map((id) => delOp(id));
  const after = scratch(ctx.st, ops); const setDown = [];
  // only what stands over a surface of what's gone can have rested on it (the index: its neighbours, never the world)
  const ixb = spatial(ctx.st); const over = new Set();
  for (const g of gone) for (const s of ixb.rec.get(g)?.surfs ?? []) for (const id of near(ctx.st, [s.min[0], s.y - 0.02, s.min[1]], [s.max[0], Infinity, s.max[1]])) over.add(id);
  for (const id of Object.keys(after.entities)) { if (!over.has(id)) continue; const b = aabb(after, id); if (!b || after.entities[id].c.parent) continue;
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

// Relational placement (A1): the authority solves; the log gets a plain transform.
function buildPlace(ctx, a) {
  const e = needThing(ctx, a.id);
  const m = geomE(e); if (!m) refuse("shape", modelOf(e.c.model) ? `${a.id}'s model hasn't been measured here, so it has no size to place` : `${a.id} has no model or mesh, so it has no size to place`, "set its transform directly");
  // the one gate before any solving (security pass 2 H-A: a visitor's place on a table scaled 1000× ran the whole search,
  // seconds of every world's thread, and was refused only after): admit a move of this thing as it stands — rights,
  // locks, flight and rate, the checks the placed result meets — so a refusal costs nothing. admit runs again on the result.
  if (!a.__made) admit(ctx.w, ctx.st, { actor: ctx.actor }, [setOp(a.id, "transform", COMPONENTS.transform.defaults)]);   // (the value is a stand-in: these checks don't read it)
  const st = ctx.st, cur = worldT(st, a.id), scale = cur.scale;
  const fam = new Set([a.id, ...descendants(st, a.id)]);
  let yaw = a.yaw ?? qYaw(cur.q);
  // lying: rest on the largest face. The authority owns the tilt and where the origin ends up (W6).
  let tilt = [0, 0, 0, 1];
  if (a.lying) { const d = m.size.map((v, i) => v * scale[i]); const k = d.indexOf(Math.min(...d)); const r = Math.SQRT1_2;
    tilt = k === 2 ? [r, 0, 0, r] : k === 0 ? [0, 0, r, r] : tilt; }
  const [mlo, mhi] = boxOfM(m); const lc = []; for (const x of [mlo[0], mhi[0]]) for (const y of [mlo[1], mhi[1]]) for (const z of [mlo[2], mhi[2]]) lc.push(qrot(tilt, [x * scale[0], y * scale[1], z * scale[2]]));
  const lo = [0, 1, 2].map((i) => Math.min(...lc.map((c) => c[i]))), hi = [0, 1, 2].map((i) => Math.max(...lc.map((c) => c[i])));
  const S = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], C = [(hi[0] + lo[0]) / 2, 0, (hi[2] + lo[2]) / 2];
  const half = (y) => { const c = Math.abs(Math.cos(y)), s = Math.abs(Math.sin(y)); const hx = S[0] / 2, hz = S[2] / 2; return [c * hx + s * hz, s * hx + c * hz]; };
  // `local`: what meets the whole region a search tests (its key order kept), so each spot filters that instead of asking
  // a search reuses one box and its oriented twin (the same numbers boxToObb gives), so a spot costs no allocations
  const QB = { min: [0, 0, 0], max: [0, 0, 0] }, QO = { c: [0, 0, 0], ax: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], h: [0, 0, 0] };
  const free = (x, y, z, yw, ignore, local = null) => { const [hx, hz] = half(yw);
    const box = local ? QB : { min: [0, 0, 0], max: [0, 0, 0] }; box.min[0] = x - hx; box.min[1] = y; box.min[2] = z - hz; box.max[0] = x + hx; box.max[1] = y + S[1]; box.max[2] = z + hz;
    const B = local ? QO : null; if (B) for (let i = 0; i < 3; i++) { B.c[i] = (box.min[i] + box.max[i]) / 2; B.h[i] = (box.max[i] - box.min[i]) / 2; }
    const ix = local && spatial(st);
    for (const id of local ?? near(st, box.min, box.max)) { if (fam.has(id) || ignore.has(id)) continue;
      if (local) { const q = ix.rec.get(id).q; if (q.min[0] > box.max[0] || q.max[0] < box.min[0] || q.min[1] > box.max[1] || q.max[1] < box.min[1] || q.min[2] > box.max[2] || q.max[2] < box.min[2]) continue; spend(1); }
      if (B ? hitsIx(st, box, id, 0.01, B) : hitsIx(st, box, id, 0.01)) return id; } return null; };
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
    let best = null, lastBlock = null; const whatWas = CTX.work.what;
    for (let pass = 0; pass < 2; pass++) {
      const [hx, hz] = half(yaw);
      // the 2.5 cm grid as ever (positions by the same running sum), searched nearest-first: ring by ring out from the
      // cell nearest `want`, stopping once no further ring can hold a nearer cell. The answer is the full scan's (the
      // nearest free cell, ties to the earlier in its x-then-z order); the work is the cells near the answer, not the
      // surface's (security pass 2 H-A: a table scaled 20× searched 600 000 cells, each against every thing). Past the
      // work budget it's refused (too-costly), never minutes of every world's thread.
      if ((s.max[0] - s.min[0]) / 0.025 > 2e5 || (s.max[1] - s.min[1]) / 0.025 > 2e5) spend(Infinity, `finding room for ${a.id} on ${a.on} (${r3(s.max[0] - s.min[0])}×${r3(s.max[1] - s.min[1])} m at 2.5 cm)`);
      const xs = [], zs = []; for (let x = s.min[0] + hx; x <= s.max[0] - hx + 1e-9; x += 0.025) xs.push(x); for (let z = s.min[1] + hz; z <= s.max[1] - hz + 1e-9; z += 0.025) zs.push(z);
      const nx = xs.length, nz = zs.length; let lastIdx = -1;
      const nearestIx = (arr, v) => { let lo = 0, hi = arr.length - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; } return lo > 0 && Math.abs(arr[lo - 1] - v) <= Math.abs(arr[lo] - v) ? lo - 1 : lo; };
      if (nx && nz) { const ci = nearestIx(xs, want[0]), ck = nearestIx(zs, want[1]);
        CTX.work.what = `finding room for ${a.id} on ${a.on}`;
        const region = near(st, [s.min[0], s.y, s.min[1]], [s.max[0], s.y + S[1], s.max[1]]); const local = region.length <= 32 ? region : null;
        const cell = (i, k) => { spend(1); const x = xs[i], z = zs[k], d = Math.hypot(x - want[0], z - want[1]), idx = i * nz + k;   // every cell visited is work
          if (best && (d > best.d || (d === best.d && idx > best.idx))) return;
          spend(4); const bl = free(x, s.y, z, yaw, NONE, local); if (!bl) best = { x, z, d, idx }; else if (idx > lastIdx) { lastIdx = idx; lastBlock = bl; } };
        // the nearest any cell of a ring's side (columns i0..i1 of a row, or rows k0..k1 of a column) can be to `want`:
        // a ring's cells are never nearer than its sides' clamp, and no ring is nearer than the one inside it (each of
        // its cells has a neighbour a step toward the centre cell that is at least as near), so the search ends at the
        // first ring whose sides are all further than the best found
        const side = (i0, i1, k0, k1) => Math.hypot(Math.min(Math.max(want[0], xs[i0]), xs[i1]) - want[0], Math.min(Math.max(want[1], zs[k0]), zs[k1]) - want[1]);
        for (let r = 0, R = Math.max(ci, nx - 1 - ci, ck, nz - 1 - ck); r <= R; r++) {
          const i0 = Math.max(0, ci - r), i1 = Math.min(nx - 1, ci + r), k0 = Math.max(0, ck - r), k1 = Math.min(nz - 1, ck + r);
          if (best) { let lb = Infinity;
            for (const k of [ck - r, ck + r]) if (k >= 0 && k < nz) lb = Math.min(lb, side(i0, i1, k, k));
            for (const i of [ci - r, ci + r]) if (i >= 0 && i < nx) lb = Math.min(lb, side(i, i, k0, k1));
            if (lb > best.d) break; }
          if (r === 0) { cell(ci, ck); continue; }
          for (const k of [ck - r, ck + r]) if (k >= 0 && k < nz) for (let i = i0; i <= i1; i++) cell(i, k);
          for (const i of [ci - r, ci + r]) if (i >= 0 && i < nx) for (let k = Math.max(0, ck - r + 1); k <= Math.min(nz - 1, ck + r - 1); k++) cell(i, k); } }
      if (!best) break; if (a.facing && pass === 0) { yaw = faceYaw([best.x, 0, best.z]); best = null; } else break;
    }
    CTX.work.what = whatWas;
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
    const nm = geomE(st.entities[a.beside]);
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
  const wt = { pos: [pos[0] - off[0], pos[1] - lo[1], pos[2] - off[2]].map(r3), q: qr3(qmul(yawQ(yaw), tilt)), scale };
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
  // Rowan: the swing's pivot was the frame's top), stored as its pivot component, which the authority's pivot, inspect, the
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
// The pairs come from the spatial index (each thing against what its box meets, never against the world), and the work
// is counted: `strict` (check, a put's claim) is refused past the budget; a write's own advisory warnings, computed
// after it's written, end with an `unchecked` entry instead (a write is never refused after it lands).
function warnings(st, ids, strict = false) {
  const out = []; const ix = spatial(st); const pairs = new Map();   // id → the things it was already said to overlap
  const B = boundsOf(st); let k = 0; const was = CTX.work.what; CTX.work.what = ids.length === 1 ? `checking ${ids[0]}` : `checking ${ids.length} things`;
  try {
  for (; k < ids.length; k++) { const id = ids[k];
    const g = ix.rec.get(id); const b = g?.box; if (!b) continue;
    const fam = familyOf(st, id); // a parent is NOT exempt: a bell inside its lamp pole is still inside it
    const mine = g.obbs;
    for (const o of near(st, g.q.min, g.q.max)) { if (fam.has(o)) continue; const go = ix.rec.get(o);
      let deepest = -Infinity;   // the deepest of this pair's box overlaps past 2 cm (none: -Infinity)
      for (let i = 0; i < mine.length; i++) for (let j = 0; j < go.obbs.length; j++) { const x = g.ext[i], y = go.ext[j]; spend(1);
        if (x.min[0] > y.max[0] || x.max[0] < y.min[0] || x.min[1] > y.max[1] || x.max[1] < y.min[1] || x.min[2] > y.max[2] || x.max[2] < y.min[2]) continue;
        spend(satCost(mine[i], go.obbs[j])); const p = satDepth(mine[i], go.obbs[j]); if (p > 0.02 && p > deepest) deepest = p; }
      if (deepest > -Infinity && !pairs.get(o)?.has(id)) { spend(10); out.push({ id, kind: "overlap", with: o, by: r3(deepest) }); let m = pairs.get(id); if (!m) pairs.set(id, (m = new Set())); m.add(o); } }
    const cx = (b.min[0] + b.max[0]) / 2, cz = (b.min[2] + b.max[2]) / 2;
    const sup = supportBelow(st, cx, cz, b.min[1], fam);
    const hungFrom = ancestors(st, id).find((p) => { const pb = ix.rec.get(p)?.box; return pb && pb.max[1] > b.max[1]; });
    if (!hungFrom && sup.y - b.min[1] > 0.005 && sup.y - b.min[1] < 0.3) out.push({ id, kind: "sunk", depth: r3(sup.y - b.min[1]), into: sup.id });
    const mounted = ancestors(st, id).some((p) => { const pb = ix.rec.get(p)?.box; return pb && pb.min[1] <= b.min[1] && pb.max[1] >= b.max[1]; });
    const under = supportUnder(st, b, fam);
    if (b.min[1] - under.y > 0.03 && !hungFrom && !mounted) out.push({ id, kind: "floating", gap: r3(b.min[1] - under.y), above: under.id });
    if (B && (outsideWorld(B, b.min) || outsideWorld(B, b.max))) out.push({ id, kind: "out-of-bounds", bounds: B });
  }
  } catch (e) {
    if (strict || !(e instanceof Refusal) || e.code !== "too-costly") throw e;
    out.push({ kind: "unchecked", things: ids.length - k, why: "checking the rest would take more of the authority's time than one request may have; lint {id} checks one thing" });
  } finally { CTX.work.what = was; }
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
  const implicit = !ctx.st.entities[id]?.c.reactions?.[action] && action === "open" && implicitOpens(ctx.st.entities[id]);
  const lt = lastTouch(ctx.w, id, implicit ? "openable" : "reactions", { editsOnly: implicit }); if (!lt) refuse("no-handler", `nobody set up '${action}' on ${id}`, "");
  ctx.actExtra = { capability: { reaction: action, author: lt.actor, grantedAt: lt.seq } };
  ctx.cap = { kind: "reaction", ids: [id], comps: [comp], author: lt.actor, action };
}
function buildUse(ctx, a) {
  const e = ctx.st.entities[a.id]; if (!e) refuse("not-found", `no '${a.id}'`, "", { didYouMean: guess(a.id, Object.keys(ctx.st.entities)) });
  offRefuse(ctx.st, a.id, "used");
  const offers = actionsOf(ctx.st, a.id);
  // no action named (Commons audit: "doesn't 'undefined'"): the thing's one action, or say what it offers
  // "one action" means one this asker may do: an owner-only lock beside an open-to-all door isn't a choice for a visitor
  if (a.action == null && !offers.length) refuse("no-action", `${a.id} has nothing to use: it offers no actions`, "inspect shows what a thing offers; a builder gives it reactions, or a seat (a socket with a body block)");
  const mine = a.action == null ? offersFor(ctx.st, a.id, ctx.actor).canDo : offers;
  if (a.action == null && mine.length > 1) refuse("no-action", `${a.id} offers ${mine.length} things to do: say which`, `it offers: ${mine.join(", ")} (use {id: '${a.id}', action: '${mine[0]}'})`, { offers: mine });
  const action = a.action ?? mine[0] ?? offers[0];   // none you may do: the first, so the refusal says why
  if (!offers.includes(action)) refuse("no-action", `${a.id} doesn't '${action}'`, `it offers: ${offers.join(", ") || "nothing"}`, { didYouMean: guess(action, offers) });
  const socks = bodySockets(ctx.st, a.id).filter((x) => x.body.action === action);
  if (socks.length && !e.c.reactions?.[action]) {
    const may = (x) => !x.body.who || rankOf(ctx.st, ctx.actor) >= whoRank(ctx.st, x.body.who);
    const socket = a.args?.socket;
    if (socket != null) { const named = socks.find((x) => x.slot === socket);
      if (!named) refuse("no-action", `${a.id} has no '${action}' socket called '${socket}'`, `its ${action} sockets: ${socks.map((x) => x.slot).join(", ")}`, { didYouMean: guess(String(socket), socks.map((x) => x.slot)) });
      if (!may(named)) refuse("rights", `only a ${named.body.who} may ${action} ${a.id} (${socket})`, "ask someone who can"); }
    const ok = socks.filter(may);
    if (!ok.length) refuse("rights", `only a ${socks[0].body.who} may ${action} ${a.id}`, "ask someone who can");
    const taken = (x) => (ctx.w ? sitterOn(ctx.w, ctx.st, x.id, ctx.actor) : null);
    const pick = socket != null ? ok.find((x) => x.slot === socket) : ok.find((x) => !taken(x)) ?? ok[0];
    { const t = taken(pick); if (t) refuse("occupied", `${t.who ? said(t.who) : t.thing} ${t.who ? "sits" : "is"} in ${pick.host}'s ${pick.slot}${socket == null && ok.length > 1 ? `, and its other ${action} sockets are taken too` : ""}`, "one body per socket: wait till it's free, or pick another (args: {socket})", t.who ? { by: t.who } : { thing: t.thing }); }
    // attaching is presence (your frames say where you're attached; nothing is recorded), so the authority only answers: where,
    // and what the body does there (the socket's body block read with its defaults: shared/sockbody.js bodyOf)
    const { clip, ...body } = pick.body;
    return { presence: true, attach: { to: pick.id, host: pick.host, socket: pick.slot, ...body }, note: `you ${action} on ${pick.host} (${pick.slot}): presence — your frames carry it; nothing recorded${body.leaveBy === "script" ? " (this seat lets you go only when a script does)" : ""}` };
  }
  const h = handlerOf(e, action);
  if (h?.who && rankOf(ctx.st, ctx.actor) < whoRank(ctx.st, h.who)) refuse("rights", `only a ${h.who} may ${action} ${a.id}`, "ask someone who can");
  if (h?.kind === "script") return { script: h.script, action }; // VERBS.use logs the visitor's act, then activates it
  if (h?.kind === "reset") {
    reactionCap(ctx, a.id, "transform", action); ctx.refs.add(a.id);
    const ops = [], sent = [], skipped = [];
    for (const t of h.targets) { const te = ctx.st.entities[t];
      if (!te) { skipped.push({ id: t, why: "it isn't here any more" }); continue; }
      const home = te.c.home ?? grabOf(te.c)?.home;
      if (!home) { skipped.push({ id: t, why: "it has no home" }); continue; }
      if ([t, ...ancestors(ctx.st, t)].some((k) => lockedC(ctx.st.entities[k]?.c))) { skipped.push({ id: t, why: "it is locked" }); continue; }
      const hp = home.parent; if (hp && !ctx.st.entities[hp.to]) { skipped.push({ id: t, why: `its home parent ${hp.to} is gone` }); continue; }
      // a launched thing is the engine's until it rests (no write may touch it: inFlight in admit); for now a reset skips it and says so
      { const sf = ctx.w.sim(), b = sf.sim?.bodies[t]; if (sf.launched[t] && b && !b.resting) { skipped.push({ id: t, why: "it is in flight; press again once it lands" }); continue; } }
      if (sameHome(ctx.st, t, home) && !ctx.w.presence.holds[t] && vec3s(te.c.transform?.scale).every((x, i) => Math.abs(x - homeScale(ctx.st, t, home)[i]) < 1e-4)) continue;   // home already (and its size), in no hand
      ops.push(...(hp ? [setOp(t, "parent", { order: "a0", ...hp })] : te.c.parent ? [delOp(t, "parent")] : []),
        setOp(t, "transform", { pos: home.pos.slice(), q: (home.q ?? [0, 0, 0, 1]).slice(), scale: homeScale(ctx.st, t, home) }));
      sent.push(t); ctx.refs.add(t); }
    ctx.cap = { ...ctx.cap, ids: [a.id, ...sent], comps: ["transform", "parent"] };
    if (skipped.length) ctx.notes.push(...skipped.map((x) => ({ ...x, reset: "skipped" })));
    if (!ops.length) refuse("nothing-to-reset", `everything is already home${skipped.length ? `; skipped: ${skipped.map((x) => `${x.id} (${x.why})`).join(", ")}` : ""}`, "");
    return ops;
  }
  if (h?.kind === "impulse") {
    if (e.c.motion && e.c.motion.type !== "pendulum") refuse("no-body", `${a.id} moves by '${e.c.motion.type}', which a push doesn't change`, "an impulse swings a pendulum (motion {type: 'pendulum'})");
    const mo = { ...(e.c.motion?.type === "pendulum" ? e.c.motion : PENDULUM) }; delete mo.pivot;
    if (!pivotOf(ctx.st, a.id)) refuse("no-pivot", `${a.id} swings but hangs from nothing above it`, `hang it first: place {id: '${a.id}', hang: <frame>}`);
    const raw = a.args?.impulse ?? qrot(worldT(ctx.st, a.id).q, [0, 0, h.strength ?? 0.5]);
    const fwd = qrot(worldT(ctx.st, a.id).q, [0, 0, 1]); const along = raw[0] * fwd[0] + raw[1] * fwd[1] + raw[2] * fwd[2];
    const mag = Math.hypot(...raw);
    if (mag > 0 && Math.abs(along) < 0.3 * mag) refuse("sideways", `${a.id} swings front-to-back; that push is mostly sideways`, `push along its front ${JSON.stringify(fwd.map(r3))} (or the opposite)`);
    // the first protocol's pendulum impulse: read angle and velocity AT the push instant, add the push,
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
  // §5: a thing's gameplay state lives inside its own component (a door is `openable: {open, locked}`), never as a top-level
  // name beside the edit `lock`. A handler names its component and, for an object component, the field it changes.
  // a handler that changes a field inside a component needs that component (it was there when the handler was written;
  // someone has removed it since): say so, rather than write a component nothing draws (review 10-07: a toggle on a crate
  // wrote an invisible door {open: true})
  if ((h?.kind === "set" && h.field !== undefined) || (h?.kind === "toggle" && toggleOf(h).field !== undefined)) { const comp = h.kind === "set" ? h.component : toggleOf(h).comp;
    if (!(e.c[comp] && typeof e.c[comp] === "object" && !Array.isArray(e.c[comp]))) refuse("no-handler", `${a.id} has no ${comp} any more, so '${action}' has nothing to change`, "someone who may edit it can add it back, or set its reactions again"); }
  if (h?.kind === "set") { const comp = h.component; reactionCap(ctx, a.id, comp, action); ctx.refs.add(a.id);
    return [setOp(a.id, comp, h.field === undefined ? h.value : { ...objOf(e.c[comp]), [h.field]: h.value })]; }
  // batch 2: play the thing's sound again from the top (a doorbell), playing or not; stampMedia sets t0 = now
  if (h?.kind === "play") { const cur = e.c.sound;
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) refuse("no-sound", `${a.id} has no sound to play`, `give it one: set {id: '${a.id}', component: 'sound', value: {src}}`);
    reactionCap(ctx, a.id, "sound", action); ctx.refs.add(a.id);
    const { t0, ...rest } = cur; return [setOp(a.id, "sound", { ...rest, playing: true })]; }
  if (h?.kind === "toggle") {
    const { comp, field } = toggleOf(h); ctx.refs.add(a.id);
    if (barredBy(e, h)) refuse("barred", `${a.id} is ${h.unless}`, h.fix ?? `someone allowed to may 'use' it with another action first`);
    reactionCap(ctx, a.id, comp, action);
    return [setOp(a.id, comp, field === undefined ? !e.c[comp] : { ...objOf(e.c[comp]), [field]: !objOf(e.c[comp])[field] })];
  }
  refuse("no-handler", `${a.id} declares '${action}' but its handler kind isn't one this engine runs`, `handler kinds: ${Object.keys(COMPONENTS.reactions.handlers).join(", ")} (schema {component: 'reactions'})`);
}
const objOf = (v) => (v && typeof v === "object" && !Array.isArray(v) && v !== PURGED ? v : {});
// toggle's defaults: an openable's `open` (component `openable`, field `open`); a named component with no field toggles
// the whole value (a plain boolean component). `unless` names a field of the same component that, when true, bars it.
const toggleOf = (h) => { const comp = h.component ?? "openable"; return { comp, field: h.field ?? (comp === "openable" ? "open" : undefined) }; };   // toggling an openable opens/closes it, named or not (10-07 merge)
const barredBy = (e, h) => !!h?.unless && objOf(e.c[toggleOf(h).comp])[h.unless] === true;
// the sockets a person can attach to: a host's (socketsOf), or a socket's own when it is the one asked
const bodySockets = (st, id) => { const e = st.entities[id]; const host = isSocketC(e?.c) ? e.c.parent?.to : id;
  return socketsOf(st, host).filter((x) => host === id || x.id === id).map((x) => ({ ...x, slot: x.name, body: bodyOf(x.sock) })).filter((x) => x.body); };
// an openable thing with nothing that opens it offers 'open' on its own: the implicit toggle of openable.open (R 10-11
// 23:17: the gym door had only `openable`; clicking it did nothing, and inspect said "nothing here opens it")
const IMPLICIT_OPEN = Object.freeze({ kind: "toggle", component: "openable", field: "open" });
function implicitOpens(e) { return !!(e?.c.openable && typeof e.c.openable === "object") && !Object.values(e.c.reactions ?? {}).some((h) => h?.kind === "toggle" && (h.component ?? "openable") === "openable"); }
function handlerOf(e, action) { return e?.c.reactions?.[action] ?? (action === "open" && implicitOpens(e) ? IMPLICIT_OPEN : undefined); }
function actionsOf(st, id) {
  const e = st.entities[id];
  return [...new Set([...Object.keys(e?.c.reactions ?? {}), ...(implicitOpens(e) ? ["open"] : []), ...bodySockets(st, id).map((x) => x.body.action)])];
}
function offersFor(st, id, actor) {
  const e = st.entities[id]; const can = [], notForYou = [];
  for (const act of actionsOf(st, id)) { const h = handlerOf(e, act);
    if (h?.who && rankOf(st, actor) < whoRank(st, h.who)) notForYou.push({ action: act, why: `needs ${h.who}` });
    else if (h?.kind === "toggle" && barredBy(e, h)) notForYou.push({ action: act, why: `it is ${h.unless}` });
    else can.push(act); }
  return { canDo: can, ...(notForYou.length ? { notForYou } : {}) };
}

// ---------- behaviours (L4, L7 as revised; research 41; the lab's slice, the protocol lab's authority.js @ 2300bae, on a real sandbox) ----------
// A script is a keyed component `script:<name>` naming a source blob ({lang: "js", api, text}, by its sha256 name) and a
// declared SCOPE. Its sponsor is whose rights admitted the LATEST write to that key in its current life (§5 "Two views"):
// a view, never a stored field. Every activation is a fresh admission with capability {kind: "script"}: the sponsor's
// rights NOW, narrowed to the scope. The visitor who triggers it adds nothing. An activation that changes something is
// ONE act (actor script:<id>, verb script, naming script, src, sponsor, sponsorAt, on, trigger, event, head, seed, depth,
// reads) plus ONE all-or-nothing batch caused by it, plus its says. Replay never runs code: the fold reads the batch.
// Stated rule (§3d): no-op writes in a script batch are dropped (SR.elide, shared with the auditor). Authority practice: timers
// sleep in an empty world unless `always`; a per-script rate, a per-sponsor fair share of a per-world hourly budget, a
// cascade depth, and a pause after repeated failures.
const SCRIPTS = { install: "builder", max: 12, budget: 600, rate: 6, depth: 8, fails: 5, run: true, cpu: SR.LIMITS.cpu, runs: SR.LIMITS.runs };
export const SCRIPT_DEFAULTS = Object.freeze({ ...SCRIPTS });   // what script-settings' registered defaults must equal (pretrans D6)
const scriptsCfg = (st) => { const c = st.entities["@world"]?.c["script-settings"]; return { ...SCRIPTS, ...(c && typeof c === "object" && !Array.isArray(c) && c !== PURGED ? c : {}) }; };
const BODY_EFFECTS = ["shove", "pose"];
const SCRIPT_EVENTS = ["use", "say", "enter", "leave", "grab", "release"];
const scopeIds = (st, id, ids) => (ids === "self" ? [id] : ids === "subtree" ? [id, ...descendants(st, id)] : Array.isArray(ids) ? ids.map((x) => (x === "self" ? id : x)) : []);
const inComps = (comps, c) => typeof c === "string" && comps.some((p) => p === c || (p.endsWith(":*") && c.startsWith(p.slice(0, -1))));
const sampleOf = (p) => (p.endsWith(":*") ? p.slice(0, -1) + "x" : p);
function scriptRights(w, st, cap, op, at, made) {
  if (op.verb === "create") { if (!cap.create) refuse("scope", `${cap.key} doesn't declare create: true`, "its scope is data: what it may touch is fixed at install"); (cap.made ??= new Set()).add(op.id); }
  else { const mine = cap.ids.includes(op.id) || cap.made?.has(op.id);
    if (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp)) || (op.comp === undefined && !cap.made?.has(op.id)))
      refuse("scope", `${cap.key} on ${cap.id} may change only ${cap.comps.join("/") || "nothing"} of ${cap.ids.join(", ") || "nothing"}, not ${op.verb} ${at}`, "a script acts only inside the scope it declared at install"); }
  const r = roleOf(st, cap.sponsor); const need = lacks(w, st, cap.sponsor, op, new Set([...(made ?? []), ...(cap.made ?? [])]), { viaCap: true });
  if (need) refuse("rights", `${cap.key}'s sponsor ${said(cap.sponsor)} can't change ${at} any more (${r} now; it needs ${needWords(need)})`, "dormant: a behaviour has its sponsor's rights now, never more (§8). An owner may adopt it: adopt {id, script}");
}
// At install (any set of script:<name>), by whoever's rights carry the write: the install rank, a scope within those
// rights NOW (a builder can't install a script that writes roles:*: promotion by proxy), a clean source that parses, the
// timer floor, `always` only by an owner, the world's script count.
// R 10-07 (particles): the instance names an effect (an Essential, or a document stored in this world's blobs), and its
// params are ones that document declares, within their bounds, with the effect still within EFFECT_LIMITS once they're
// applied. The first protocol's flat bag is read in older values (PROTOCOL §4: a stored value is read forever) and never
// taken in a write: its spelling would be a second way to say one thing. A held thing's fx carries a particles value too.
function particlesCheck(w, op) {
  const one = (v, at) => { if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const b = effectBlobName(v.effect); let doc = null;
    if (b) { try { doc = w.getBlob(b); } catch { /* not stored here: said below */ }
      if (doc && (doc.kind !== EFFECT_KIND || effectProblem(doc))) refuse("shape", `${at}.effect: ${b} isn't a particle effect this protocol runs (${doc.kind !== EFFECT_KIND ? "not a particle-effect document" : effectProblem(doc)})`, "upload {effect: {kind: 'particle-effect', v: 1, emitters: [...]}} stores one and says why it can't"); }
    else doc = effectFor(v.effect);
    const bad = instanceProblem(v, doc);
    if (bad) refuse(b && !doc ? "not-found" : /^params\.[\w-]+ is (a number|\[x, y, z\])/.test(bad) || /out of bounds/.test(bad) ? "bounds" : "shape", `${at}: ${bad}`, `PROTOCOL §4 (effects are documents): {effect: '${ESSENTIAL_NAMES[0]}'} or an uploaded effect's address; schema {component: 'particles'} lists the Essentials and their params`,
      b && !doc ? undefined : { didYouMean: typeof v.effect === "string" && !b ? guess(v.effect, ESSENTIAL_NAMES) : [] }); };
  if (baseOf(op.comp) === "particles") one(op.value, `${op.id}.${op.comp}`);
  if (baseOf(op.comp) === "grabbable" && op.value?.fx?.particles) one(op.value.fx.particles, `${op.id}.${op.comp}.fx.particles`);
}
// upload {effect}: a particle effect document, stored by its content (a blob, §9: not world state, so not logged), checked
// whole first (shared/particle_effects.js effectProblem: shape and every bound). Building rights: it is something to build
// with, and naming it in a particles value is the write that's logged.
function uploadEffect(w, actor, a) {
  if (!may(w.state(), actor, "build")) refuse("rights", `storing a particle effect needs build; you are ${roleOf(w.state(), actor)}`, "ask the world's owner", { needs: "build" });
  { const now = w.now(), U = ((w.presence.uploads ??= {})[actor] ??= []).filter((t) => now - t < 60000); w.presence.uploads[actor] = U; // presence: never logged
    if (U.length >= SR.LIMITS.uploads) refuse("rate", `${said(actor)} has uploaded ${U.length} documents in the last minute; at most ${SR.LIMITS.uploads}`, "slow down");
    U.push(now); w.presenceDirty = true; }
  const bad = effectProblem(a.effect);
  if (bad) refuse("shape", `effect: ${bad}`, "PROTOCOL §4 (effects are documents): {kind: 'particle-effect', v: 1, emitters: [{spawn: {amount, lifetime}, …}], params?}; effect {name: 'fire'} shows an Essential's");
  if (a.dry) return { ok: true, dry: true, note: "a particle effect this protocol runs; nothing stored" };
  const h = w.putBlob(a.effect);
  return { ok: true, effect: h, next: `set {id, component: 'particles', value: {effect: '${h}'}}` };
}
function installCheck(w, st, s, who, op) {
  const { actor, cap } = who; const installer = cap?.kind === "script" ? cap.sponsor : cap?.kind === "reaction" ? cap.author : actor;
  const role = roleOf(st, installer), cfg = scriptsCfg(st), v = op.value, at = `${op.id}.${op.comp}`;
  // research S2: the `scripts` permission is the install gate; @world.script-settings.install: 'owner' reads as the built-in roles'
  // scripts permission off until an owner edits that role (roles.js roleDef)
  if (!may(st, installer, "scripts")) refuse("rights", `installing a script here needs ${cfg.install === "owner" ? "owner (@world.script-settings.install)" : "the scripts permission"}; ${said(installer)} is ${role}`, "@world.script-settings.install and the role's scripts permission say who may (the owner sets them)", { needs: "scripts" });
  if (typeof v.src !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.src)) refuse("shape", `${at}.src must be a blob name sha256:<64 hex>`, "upload {text} stores the source and returns its name");
  let blob = null; try { blob = w.getBlob(v.src); } catch { /* missing or doesn't match its name: refused below */ }
  if (!blob) refuse("not-found", `${at}.src: no blob ${v.src} here`, "upload {text} first");
  if (blob.lang !== SR.LANG || typeof blob.text !== "string") refuse("shape", `${at}.src isn't JavaScript source ({lang: '${SR.LANG}', text})`, "upload {text}");
  const dirty = SR.hygiene(blob.text); if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`, "refused at install: reviewers must see what runs");
  w.scripts?.warm?.(); // a world that gets a script gets warm sandbox processes (a no-op once they're up)
  const syn = w.scripts?.checkSyntax?.(blob.text); if (syn) refuse("syntax", `${at}: ${syn.why}`, "docs/SCRIPTS.md shows the API; scripts {id, script, test: {on: 'use'}} runs it dry");
  const sc = v.scope; if (!sc || typeof sc !== "object" || Array.isArray(sc)) refuse("shape", `${at} needs a scope {ids, comps}`, COMPONENTS.script.help);
  if (!(sc.ids === "self" || sc.ids === "subtree" || (Array.isArray(sc.ids) && sc.ids.length <= 32 && sc.ids.every((x) => x === "self" || isEntityId(x)))))
    refuse("shape", `${at}.scope.ids must be 'self', 'subtree' or up to 32 ids`, COMPONENTS.script.help);
  if (!Array.isArray(sc.comps) || sc.comps.length > 16 || !sc.comps.every((c) => typeof c === "string" && isComponent(sampleOf(c)))) refuse("shape", `${at}.scope.comps must be up to 16 component names ('name:*' for keyed)`, COMPONENTS.script.help);
  if (sc.bodies !== undefined && (!Array.isArray(sc.bodies) || sc.bodies.some((b) => !BODY_EFFECTS.includes(b)))) refuse("shape", `${at}.scope.bodies may name ${BODY_EFFECTS.join(", ")}`, "each lands only where that body's consent allows it (§5)");
  if (sc.launch) refuse("shape", `${at}.scope.launch: scripts can't launch sim bodies yet`, "leave launch out");
  if (sc.create && sc.ids !== "subtree") refuse("scope", `${at}: create needs ids: 'subtree' (what it makes must hang under it)`, "");
  // a scope that names a typo of a registered component could never write it (admit refuses the name): say so now
  for (const c of sc.comps) { const n = sampleOf(c).split(":")[0]; const near = !registered(n) && !n.includes("/") ? nearMiss(n) : [];
    if (near.length) refuse("schema", `${at}.scope.comps: '${n}' isn't a component; did you mean '${near[0]}'?`, `a component of your own carries a namespace (e.g. 'example.org/${n}')`, { didYouMean: near });
    // PROTOCOL §4: a script may only ever write what the authority takes, so a bare name nobody registered is refused here,
    // at install, rather than at every activation
    if (!registered(n) && !n.includes("/")) refuse("schema", `${at}.scope.comps: '${n}' isn't a registered component; bare names belong to the registry (PROTOCOL §4)`, `a component of your own carries a namespace: 'example.org/${n}'`, { didYouMean: [`example.org/${n}`] }); }
  for (const id of scopeIds(s, op.id, sc.ids)) for (const c of sc.comps) { const need = lacks(w, st, installer, { verb: "set", id, comp: sampleOf(c) }, new Set(s.entities[id] && !st.entities[id] ? [id] : []), { viaCap: true });
    if (need) refuse("rights", `${at}'s scope reaches ${id}.${c}, which needs ${needWords(need)}; ${said(installer)} is ${role}`, "a script can never do more than its installer could do directly: narrow the scope, or ask an owner to install or adopt it"); }
  const on = v.on ?? [];
  if (!Array.isArray(on) || on.some((e) => typeof e !== "string" || !(SCRIPT_EVENTS.includes(e) || (e.startsWith("changed:") && isComponent(e.slice(8))))))
    refuse("shape", `${at}.on lists ${SCRIPT_EVENTS.join(", ")} and changed:<comp>`, "timers come from every (they deliver tick, and wake after sleeping)");
  if (v.every !== undefined && !(typeof v.every === "number" && v.every >= 5)) refuse("shape", `${at}.every is ${v.every} s; the floor is 5 s`, "sub-second behaviour belongs in client presence or the engine; motion is a function of time");
  if (v.knobs !== undefined && jcs(v.knobs).length > 4096) refuse("too-big", `${at}.knobs is ${jcs(v.knobs).length} bytes; at most 4 KiB`, "big data goes in a blob");
  const prev = st.entities[op.id]?.c[op.comp];
  if (v.always === true && prev?.always !== true && role !== "owner") refuse("rights", `${at}.always (run with nobody present) needs an owner`, "it costs the host while nobody benefits");
  if (prev === undefined) { const n = allScripts(s).length;
    if (n > cfg.max) refuse("too-many", `this world would have ${n} scripts; it allows ${cfg.max}`, "@world.script-settings.max (owner)"); }
}
const rtKey = (id, name) => `${id}|${name}`;
const rtOf = (w, id, name) => ((w.presence.scripts ??= {})[rtKey(id, name)] ??= { console: [] });
const logRt = (w, rt, line) => { rt.console.push({ ts: Math.floor(w.now()), ...line }); if (rt.console.length > 20) rt.console.shift(); w.presenceDirty = true; };
// how many behaviour acts sit in the cause chain behind entry `seq` (41 §3.9: a reader computes it from the log)
function scriptDepth(w, seq) { let n = 0, e = w.entries[seq], guard = 0;
  while (isE(e) && isScriptActor(e.actor) && guard++ < 1000) { if (e.kind === "act") n++; e = w.entries[e.cause]; } return n; }
// The writes to a script: key in its current life, newest first: [{e, value}] (value undefined if purged)
function scriptWrites(w, id, key) {
  const out = [];
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue; const ops = opsQuiet(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && o.comp === key) out.push({ e, value: o.value });
      else if (o.verb === "create" || (o.verb === "delete" && (o.comp === key || o.comp === undefined))) return out; } }
  return out;
}
// `paused` is a permission, not the script: a write that changes only it (pause, resume) is a "pause write"
export const unpaused = (v) => { if (!v || typeof v !== "object" || Array.isArray(v)) return v; const { paused, ...rest } = v; return rest; };
const pauseOnly = (v, prev) => v !== undefined && prev !== undefined && jcs(unpaused(v)) === jcs(unpaused(prev));
// §5 "Two views" (H3), with R's decision on lab 49 F4 (2026-10-06): the sponsor is whose rights admitted the latest write
// to the script: key in its current life THAT CHANGED MORE THAN `paused`. Pausing or resuming adopts nothing: an owner
// who pauses a builder's script stops it, and the builder still answers for it (an explicit adopt is how to take it on).
function sponsorOf(w, id, key) {
  if (!creatorOf(w, id, key)) return null;
  const W = scriptWrites(w, id, key);
  for (let k = 0; k < W.length; k++) if (k === W.length - 1 || !pauseOnly(W[k].value, W[k + 1].value)) return { sponsor: entryBy(w, W[k].e).rights, sponsorAt: W[k].e.seq };
  return null;
}
// who paused it: the write that turned `paused` on, in the run of writes since (a view: never a name in the value)
function pausedBy(w, id, key) {
  const W = scriptWrites(w, id, key); let at = null;
  for (const x of W) { if (x.value?.paused !== true) break; at = x; }
  if (!at) return null; const c = w.entries[at.e.cause]; const by = isE(c) && c.kind === "act" ? c.actor : at.e.actor;
  return { by, at: at.e.seq, ts: at.e.ts };
}
// who is here: the authority's own bodies plus whoever the host says is connected (a server's people), id → position | null
function presentOf(w) { const out = new Map();
  for (const [id, b] of Object.entries(w.presence.bodies ?? {})) out.set(id, Array.isArray(b?.at) ? b.at : null);
  for (const p of w.present?.() ?? []) if (p && typeof p.id === "string" && !out.has(p.id)) out.set(p.id, Array.isArray(p.at) && p.at.length === 3 && p.at.every(Number.isFinite) ? p.at : null);
  return out; }
const scriptMemo = new WeakMap();
// per state, from each entity's own list (cached on its entity object: a write's next state re-reads only what it touched;
// review 10-06 S0-2, every write re-scanned every component of every thing)
const scriptsOfEnt = new WeakMap();
function allScripts(st) { let out = scriptMemo.get(st); if (out) return out; out = []; const vol = VOLATILE.has(st.entities);
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; let mine = vol ? null : scriptsOfEnt.get(e);
    if (!mine || mine.id !== id) { mine = { id, list: [] }; for (const k of Object.keys(e.c)) { const v = e.c[k]; if (k.startsWith("script:") && v && typeof v === "object" && !Array.isArray(v) && v !== PURGED) mine.list.push({ id, name: k.slice(7), v }); } if (!vol) scriptsOfEnt.set(e, mine); }
    for (const x of mine.list) out.push(x); }
  scriptMemo.set(st, out); return out; }
// budgets (authority practice, stated in @world.script-settings; §3d M3): per script per minute; per world per hour; each sponsor a fair
// share of the world's hour, so one builder's chatty scripts can't starve everyone else's (and spreading a script over
// many things or hashes gains nothing: the share is keyed on the sponsor)
function budgetOf(w, st, now, id, key, sponsor, cfg) {
  let mine = 0, all = 0, bySp = 0;
  const sponsors = new Set(allScripts(st).map((x) => sponsorOf(w, x.id, `script:${x.name}`)?.sponsor).filter(Boolean));
  for (let i = w.entries.length - 1; i >= 0; i--) { const e = w.entries[i]; if (!isE(e)) continue; if (Number.isInteger(e.ts) && now - e.ts > 3600000) break;
    if (!isScriptActor(e.actor)) continue; all++;
    const a = e.kind === "act" ? e : w.entries[e.cause];
    if (isE(a) && a.kind === "act" && a.body?.sponsor === sponsor) bySp++;
    if (e.kind === "act" && e.actor === `script:${id}` && e.body?.script === key && now - e.ts <= 60000) mine++; }
  return { mine, all, bySponsor: bySp, sponsors: sponsors.size, share: Math.floor(cfg.budget / Math.max(1, sponsors.size)) };
}
// The authority's thread is shared by every world in this process, so script time is capped for the PROCESS, not only per
// world or sponsor: in any rolling second, activations may use at most DUTY.maxMs of it. Past that they're refused
// ("busy", never the script's failure). With the sandbox's per-activation deadline (wallMs + GRACE), no request, tick or
// chain of cascades can hold the thread longer than about DUTY.maxMs + one deadline (I2).
export const DUTY = { windowMs: 1000, maxMs: 500, worldShare: 0.6 }; // one world gets at most worldShare of it (fairness between worlds)
/** A host sets the process's script duty (a big server may give scripts more of each second; a test that fires a thousand
 *  activations in a tight loop opens it wide). Returns the previous setting. */
export function setScriptDuty({ windowMs = DUTY.windowMs, maxMs = DUTY.maxMs, worldShare = DUTY.worldShare } = {}) { const was = { ...DUTY }; Object.assign(DUTY, { windowMs, maxMs, worldShare }); dutyLog.length = 0; return was; }
const dutyLog = [];
// what's left of the duty for world `wid`: the process's, and that world's share of it
const dutyLeft = (wid) => { const t = performance.now(); while (dutyLog.length && t - dutyLog[0].at > DUTY.windowMs) dutyLog.shift();
  const all = dutyLog.reduce((n, d) => n + d.ms, 0), mine = dutyLog.reduce((n, d) => n + (d.w === wid ? d.ms : 0), 0);
  return Math.min(DUTY.maxMs - all, DUTY.maxMs * DUTY.worldShare - mine); };
const DRY = { n: 10, ms: 60000 }; // dry runs (use {dry}, scripts {test}) per person per minute: they run code and log nothing
// authority practice: what the authority spends, logged or not (presence, never the log): an activation that writes nothing still ran
function overCpu(w, now, id, key, sponsor, cfg) {
  const R = (w.presence.scriptRuns ?? []).filter((r) => now - r.ts < 60000); w.presence.scriptRuns = R;
  const runs = R.filter((r) => r.id === id && r.key === key).length; if (runs >= cfg.runs) return `${key} ran ${runs} times in the last minute; at most ${cfg.runs} (@world.script-settings.runs)`;
  const ms = R.filter((r) => r.sponsor === sponsor).reduce((t, r) => t + r.ms, 0); if (ms >= cfg.cpu) return `${said(sponsor)}'s scripts used ${ms} ms of the authority's time in the last minute; at most ${cfg.cpu} (@world.script-settings.cpu)`;
  const all = R.reduce((t, r) => t + r.ms, 0); if (all >= cfg.cpu * 3) return `this world's scripts used ${all} ms of the authority's time in the last minute; at most ${cfg.cpu * 3}`;
  return null;
}
// what an act records of its event: everything but what its trigger already holds (a say's text and `to`, a use's args),
// so purging that say or that request purges it everywhere (an auditor reads it from the trigger: scriptaudit.js)
const recorded = (ev) => { const { text, to, args, ...rest } = ev; return ev.seq !== undefined ? rest : ev; };
const overBudget = (B, cfg, key, sponsor, cost) => (B.mine >= cfg.rate ? `${key} logged ${B.mine} activations in the last minute; the rate is ${cfg.rate}`
  : B.all + cost > cfg.budget ? `this world's scripts wrote ${B.all} entries in the last hour; the budget is ${cfg.budget} (@world.script-settings.budget)`
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
  if (v.paused === true) { const pb = pausedBy(w, id, key); return out("paused", { why: pb ? `paused by ${said(pb.by)} at seq ${pb.at}` : "paused: true" }); }
  if (cfg.run === false) return out("stopped", { why: "@world.script-settings.run is false (the owner's kill permission)" });
  const sp = sponsorOf(w, id, key); if (!sp) return out("not-installed");
  if (isBanned(w, sp.sponsor)) return out("suspended", { why: `suspended: sponsor ${said(sp.sponsor)} is banned (moderator log); nothing ran` });
  const ver = lastTouch(w, id, key)?.seq; if (!dry && rt.ver !== ver) { rt.ver = ver; rt.fails = 0; } // a re-set (a fix) clears the failure count
  if (!dry && (rt.fails ?? 0) >= cfg.fails) return out("paused", { why: `paused after ${rt.fails} failed activations in a row; set it again (a fix, or the same value) to retry` });
  const depth = 1 + (cause !== undefined ? scriptDepth(w, cause) : 0);
  if (depth > cfg.depth) return out("refused", { code: "depth", why: `cascade depth ${depth} > ${cfg.depth}` });
  if (!w.scripts) return out("unavailable", { why: "this server has no script sandbox" });
  let blob = null; try { blob = w.getBlob(v.src); } catch { /* below */ }
  const fail = (code, why, logs) => { if (!dry && code !== "unavailable") rt.fails = (rt.fails ?? 0) + 1; return out(code === "unavailable" ? "unavailable" : "failed", { code, why, ...(logs?.length ? { logs } : {}), ...(dry ? {} : { fails: rt.fails }) }); };
  if (!blob || blob.lang !== SR.LANG || typeof blob.text !== "string") return fail("source", `${id}.${key}.src: no ${SR.LANG} source ${v.src} here`);
  const actSeq = w.entries.length, seed = SR.seedOf(w.worldId, actSeq, `${id}/${key}`), now = w.nextTs(); // the clock is frozen at the act's own ts
  if (!dry) { const why = overCpu(w, now, id, key, sp.sponsor, cfg); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const B = budgetOf(w, st, now, id, key, sp.sponsor, cfg); // spent already: refused before it costs the authority a run
  { const why = overBudget(B, cfg, key, sp.sponsor, 1); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const here = presentOf(w), me = worldT(st, id)?.pos ?? [0, 0, 0];
  if (dutyLeft(w.worldId) <= 0) return out("refused", { code: "busy", why: `the authority's scripts have used their share of the last second (${DUTY.maxMs} ms for every world here, ${Math.round(DUTY.maxMs * DUTY.worldShare)} for one); it runs again when there's time`, sponsor: sp.sponsor });
  if (dry) { const now0 = w.now(), who = ev.by ?? "?"; const D0 = ((w.presence.dryRuns ??= {})[who] ??= []).filter((t) => now0 - t < DRY.ms); w.presence.dryRuns[who] = D0;
    if (D0.length >= DRY.n) return out("refused", { code: "rate", why: `${said(who)} has asked for ${D0.length} dry runs in the last minute; at most ${DRY.n}` });
    D0.push(now0); w.presenceDirty = true; }
  const t0 = performance.now();
  const res = w.scripts.run({ text: blob.text, self: id, key, event, knobs: v.knobs ?? {}, now, seed, st,
    near: (r) => [...here].filter(([, at]) => at && dist(at, me) <= r).map(([k]) => k).sort(), count: () => here.size,
    name: (who) => (typeof who === "string" && (isIdentity(who) || isScriptActor(who)) ? CTX.nameOf?.(who) ?? dec(who) ?? null : null) });
  { const ms = performance.now() - t0; dutyLog.push({ at: performance.now(), ms, w: w.worldId }); } // dry runs spend the thread too
  if (!dry) { const ms = performance.now() - t0;
    (w.presence.scriptRuns ??= []).push({ ts: now, id, key, sponsor: sp.sponsor, ms: Math.round(ms) }); w.presenceDirty = true; }
  if (!res.ok) return fail(res.code, res.why, res.logs);
  const logs = res.logs.length ? { logs: res.logs } : {};
  const ops = SR.elide(st, res.ops);
  if (!ops.length && !res.says.length && !res.bodies.length) { if (!dry) rt.fails = 0; return out("nothing", { why: res.ran ? "nothing changed: no entry" : `it has no handler for '${ev.on}'`, ...logs }); }
  const cap = { kind: "script", key, id, sponsor: sp.sponsor, ids: scopeIds(st, id, v.scope?.ids), comps: v.scope?.comps ?? [], create: !!v.scope?.create };
  const mark = (code, why) => out("refused", { code, why, sponsor: sp.sponsor, ...logs });
  if (res.says.length && !v.scope?.say) return mark("scope", `${key} doesn't declare say: true`);
  for (const b of res.bodies) if (!(v.scope?.bodies ?? []).includes(b.kind)) return mark("scope", `${key} doesn't declare bodies: ['${b.kind}']`);
  { const why = overBudget(B, cfg, key, sp.sponsor, 1 + (ops.length ? 1 : 0) + res.says.length); if (why) return mark("budget", why); } // what it would actually write
  let plan = null;
  if (ops.length) try { plan = admit(w, st, { actor: `script:${id}`, cap }, ops); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
  if (dry) return { script: key, id, status: "would-run", would: plan?.ops ?? [], says: res.says, bodies: res.bodies, sponsor: sp.sponsor, fuel: res.fuel, note: "dry: nothing was written; body effects still meet each body's consent when it runs", ...logs };
  const gates = [];
  for (const b of res.bodies) { const g = bodyGate(w, `script:${id}`, b.to, b.kind, { spec: b.spec, script: key, sponsor: sp.sponsor }); if (!g.ok) return mark(g.code, g.reason); gates.push({ ...b, consent: g.consent, deliver: g.deliver }); }
  const actE = { kind: "act", actor: `script:${id}`, verb: "script", ...(cause !== undefined ? { cause } : {}),
    body: { script: key, src: v.src, sponsor: sp.sponsor, sponsorAt: sp.sponsorAt, on: ev.on, ...(ev.by ? { trigger: { actor: ev.by, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) } } : {}),
      event: recorded(event), head: actSeq - 1, seed, depth, engine: SR.ENGINE, api: SR.API, ...(res.reads ? { reads: res.reads } : {}),
      ...(gates.length ? { bodies: gates.map((g) => ({ kind: g.kind, to: `body:${g.to}`, consent: g.consent })) } : {}) } };
  const sayE = (t, c) => ({ kind: "say", actor: `script:${id}`, cause: c, verb: "say", body: { text: t } });
  let act, state = null;
  w.pinTs = now;
  try {
    try { w.fits(actE, ...(plan ? [changeShape(plan, actSeq, w)] : []), ...res.says.map((t) => sayE(t, actSeq))); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
    act = w.append(actE); if (plan) state = changeEntry(w, plan, act);
    for (const t of res.says) (w.sayQ ??= []).push(w.append(sayE(t, act)));
  } finally { w.pinTs = null; }
  for (const g of gates) g.deliver();
  rt.fails = 0; return out("ran", { act, ...(state !== null ? { state } : {}), ops: ops.length, sponsor: sp.sponsor, ...logs });
}
function withAuthority(w, fn) {
  const exit = enter(w, null);
  try { return fn(); } finally { exit(); if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } }
}
/**
 * Timers (authority practice): a due script with nobody present sleeps unless `always`; on its first due tick after someone
 * arrives it gets ONE `wake {slept}`, never a burst. Several missed periods while awake coalesce into one tick. A timer
 * act's cause is the entry that made its sponsor (its latest install). Then the cascades it set off. A host calls this on
 * its own clock (server: once a second); it never runs inside a request.
 */
/**
 * The engine's heartbeat (DESIGN-physics-responsiveness §1). Advances the sim toward the authority's clock, at most `maxTicks`
 * engine ticks a pass (a stall catches up over several passes, never by a longer step: the bits stay the law's), and logs
 * what came to rest, returns what is due back, expires asks. A host calls this at tick cadence; a request still settles
 * first (the fallback for a host without a heartbeat) and finds nothing left to do. Returns how many entries it wrote.
 */
export function settle(w, { maxTicks = 8 } = {}) {
  if (!w.exists || w.state().status !== "ok") return 0;
  return withAuthority(w, () => {
    const clock = w.now; const t0 = clock(); const cap = w.simCapTs?.(maxTicks); const t = cap !== null && cap !== undefined && cap < t0 ? cap : t0;
    w.now = () => t;   // one clock for the pass, as a request has (physlive Q1): a rest's digest and its ts agree
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    const n0 = w.entries.length;
    CTX.work = { left: Infinity, until: Infinity, k: 0 };
    settleSim(w); returnDue(w); expireAsks(w); checkpointSim(w);
    drainScripts(w); drainHeld(w);   // what the beat logged reaches scripts, as a request's entries do (second review S2-2)
    return w.entries.length - n0;
  });
}
// A checkpoint is a persisted joiner cut (DESIGN-physics-responsiveness §2; STRIKES PH-S1-1: boot re-simulated every flight
// the world ever had, 6.5 s for the gym's 94 launches and growing). At a quiet moment (nothing in flight, nothing waiting to
// be logged) after launches have happened, the authority writes one `sim:checkpoint` entry whose body names a blob holding
// the sim cut exactly as a joiner gets it (simCutOf), with the cut's engine and digest beside it. A host that carries the
// engine opens the world from the last valid checkpoint and feeds only the entries after it; any other reader folds past
// an unknown sim verb unchanged. The fold itself is never checkpointed: it is cheap and always exact from genesis.
const CHECKPOINT_QUIET_MS = 20000;
function checkpointSim(w) {
  if (typeof w.putBlob !== "function" || !w.state().entities["@world"]?.c["physics-engine"]) return;
  // incremental (second review S2-3: a whole-log scan every beat until the first checkpoint): what's been counted stays counted
  const E = w.entries; const k = (w.ckptScan ??= { to: -1, launches: 0, newest: -Infinity });
  for (let s = k.to + 1; s < E.length; s++) { const e = E[s]; k.to = s; if (!e || typeof e !== "object" || e.kind !== "sim") continue;
    if (e.verb === "checkpoint") { k.launches = 0; k.newest = -Infinity; } else if (e.verb === "launch") { k.launches++; if (e.ts > k.newest) k.newest = e.ts; } }
  if (!k.launches || w.now() - k.newest < CHECKPOINT_QUIET_MS) return;
  const sf = w.sim(); if (!sf.sim || sf.foreign || Object.keys(livePoses(sf)).length || sf.rested.length || (w.unsettled?.length ?? 0)) return;
  // the cut rides as a JSON string: the blob store canonicalises objects (sorted keys), and the engine's object order is the
  // law's (statics and bodies tie by insertion order), so a re-keyed cut would be a different sim
  const cut = simCutOf(sf, E);
  const state = w.putBlob({ cutJson: JSON.stringify(cut) });
  w.append({ kind: "sim", actor: "sim", verb: "checkpoint", body: { at: E.length - 1, engine: { engine: sf.spec.engine, build: sf.spec.build }, tick: sf.sim.tick, clock: sf.clock, sim: digestOf(sf.sim), state } });
}
export function tick(w) {
  if (!w.exists || w.state().status !== "ok") return [];
  return withAuthority(w, () => {
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
 *  presence. A host that persists presence (server/filehost.ts) still has the hold, with no one connected to let go: it's
 *  settled as `leave` settles it (a drop as the holder, which its grabbable may send home, into a socket or straight
 *  down; a drop the authority refuses becomes its return-held). A host that keeps presence in memory (server/livehost.ts)
 *  has lost the hold, but in a world that runs physics the grab's `lift` took the thing out of the engine and nothing
 *  put it back: it would stay a ghost (no body, no collider) until someone moved it. That is settled by the authority as
 *  leave's refusal is: a return-held act (cause: the lift) writing where the log last had it, which seats it in the
 *  engine again, or, for a grabbable that returns, a return-home. `present` = identities connected now (none, at
 *  load). Returns what it settled. */
// Bounded (security pass 2 M-C): it runs at world load on the thread every world shares, so at most ORPHANS.holders
// holders are settled as leave settles them and ORPHANS.lifts lifts returned; any holds past that simply end (presence),
// and what the log still has lifted is settled at the next load. The result says how many waited ({deferred}).
export const ORPHANS = { holders: 16, lifts: 64 };
export function settleOrphans(w, present = []) {
  if (!w.exists || w.state().status !== "ok") return [];
  const here = new Set(present); const out = [];
  const holders = [...new Set(Object.values(w.presence.holds ?? {}).map((h) => h?.by))].filter((who) => !here.has(who));
  if (holders.length > ORPHANS.holders) { const late = new Set(holders.slice(ORPHANS.holders));
    for (const [id, h] of Object.entries(w.presence.holds)) if (late.has(h?.by)) delete w.presence.holds[id];
    for (const who of late) delete w.presence.bodies[who];
    out.push({ deferred: late.size, why: `more than ${ORPHANS.holders} holders at once: their holds ended; what the log still has lifted settles at the next load` }); }
  for (const who of holders.slice(0, ORPHANS.holders)) {
    const r = request(w, who, "leave", {}); out.push({ holder: who, left: r.ok, dropped: r.dropped ?? [] });
    // a holder the authority won't take requests from now (banned since): the hold just ends (presence), and what the log
    // lifted is settled below by the authority, as leave's own refusal is (review 10-06)
    if (!r.ok) { for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === who) delete w.presence.holds[id]; delete w.presence.bodies[who]; } }
  withAuthority(w, () => {
    const st = w.state(); if (!st.entities["@world"]?.c["physics-engine"]) return;
    let settled = 0, waiting = 0;
    for (const [id, lift] of orphanLifts(w)) {
      if (w.presence.holds[id] || !st.entities[id]) continue;
      if (settled++ >= ORPHANS.lifts) { waiting++; continue; }
      const g = grabOf(st.entities[id].c);
      if (g?.release === "return" && g.home) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq); out.push({ id, returned: "home" }); continue; } }
      const t = w.state().entities[id].c.transform; if (!t) continue;
      let plan; try { plan = admit(w, w.state(), { actor: "system", cap: { kind: "system", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]); } catch (x) { if (!(x instanceof Refusal)) throw x; continue; }
      changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "return-held", cause: lift.seq, body: { id, holder: lift.by, why: "orphaned: its holder's hold ended without a settlement (the host stopped)" } }));
      out.push({ id, returned: "where the log had it" });
    }
    if (waiting) out.push({ deferred: waiting, why: `more than ${ORPHANS.lifts} lifted things at once: the rest settle at the next load` });
  });
  if (out.length) w.savePresence();
  return out;
}
/** A world stored before sockets were entities, lifted at its first load: per host, one system act (lift-sockets: the
 *  children it made, what it moved, and whose rights authored the sockets, so their builder still edits them) and its
 *  change. Not bounded like ORPHANS (a half-lifted world would need both readers), and not undoable (a system act). A
 *  second load finds nothing to lift. A server that can't sign for the world doesn't write to it, as request won't. */
export function liftWorld(w) {
  if (!w.exists || w.state().status !== "ok") return [];
  if (w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return [{ skipped: "custody", why: "this server doesn't hold the key that signs this world" }];
  return withAuthority(w, () => { const out = [];
    for (const h of legacyHosts(w.state(), w.everIds())) {
      const st = w.state(); if (!st.entities[h]) continue;
      const { ops, made, moved } = liftHostOps(st, w.everIds(), h); if (!ops.length) continue;
      const author = (lastSetterOf(w, h, "sockets") ?? lastSetterOf(w, h, "model") ?? creatorOf(w, h))?.rights ?? null;
      const ids = [...new Set(ops.map((o) => o.id))], comps = [...new Set(ops.map((o) => o.comp))];
      const plan = admit(w, st, { actor: "system", cap: { kind: "system", ids, comps }, lifting: true }, ops);
      changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "lift-sockets", body: { id: h, made, moved, ...(author ? { capability: { author } } : {}) } }));
      out.push({ host: h, made, moved }); }
    return out; });
}
// Things the log has lifted out of the engine (a grab's lift, a catch) with nothing after that puts them back: no launch,
// no write to where they are or what they are, no epoch cut (a new epoch builds its bodies from the whole state).
function orphanLifts(w) {
  const lifted = new Map();
  w.entries.forEach((e, seq) => {
    if (!isE(e)) return;
    if (e.kind === "sim" && (e.verb === "lift" || e.verb === "catch") && e.body?.id) lifted.set(e.body.id, { seq, by: e.actor });
    else if (e.kind === "sim" && e.verb === "launch") lifted.delete(e.body?.id);
    else if (e.kind === "change") for (const o of opsQuiet(e)) {
      // the same lifecycle as the engine's (simlayer RELEASES): what ends a hold is a write that moves it, re-parents it,
      // switches it off or removes it; an engine change or an edit to its physics or model leaves it in the hand
      // (review of 64d26822: the two disagreed, and a held thing came back into the engine as a ghost collider)
      if (o.verb === "create" || (o.verb === "delete" && o.comp === undefined) || ["transform", "parent"].includes(o.comp) || (o.comp === "disabled" && o.verb === "set" && o.value === true)) lifted.delete(o.id); }
  });
  return lifted;
}
/** Someone arrived or left (presence, told by the host): scripts that list `enter` / `leave` hear it, with `by`. The act's
 *  cause is the entry that made the script's sponsor (an arrival isn't logged on every path). */
export function presenceEvent(w, kind, who) {
  if (!w.exists || w.state().status !== "ok" || !["enter", "leave"].includes(kind) || !isIdentity(who)) return [];
  return withAuthority(w, () => {
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
// snap), socket? and to? (release), seq (the act) when logged.
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
// What a request's (or an activation's) entries set off: `changed:<comp>` for a change entry that changes <comp> on an id
// in the script's scope; `say` for a say entry. One activation per (script, triggering entry); a script never hears its own.
function drainScripts(w) {
  let guard = 0;
  while ((w.changedQ?.length || w.sayQ?.length) && guard++ < 1000) {
    const st = w.state(); const scripts = allScripts(st);
    if (w.changedQ?.length) { const seq = w.changedQ.shift(); const e = w.entries[seq]; if (!isE(e)) continue;
      const watching = scripts.filter((x) => Array.isArray(x.v.on) && x.v.on.some((o) => o.startsWith("changed:"))); if (!watching.length) continue;
      const changed = opsQuiet(e).filter((o) => o.comp !== undefined);
      for (const { id, name, v } of watching) { if (e.actor === `script:${id}`) continue;
        const ids = scopeIds(st, id, v.scope?.ids); const hit = changed.find((o) => ids.includes(o.id) && v.on.includes(`changed:${o.comp}`));
        if (hit) activate(w, id, name, { on: `changed:${hit.comp}`, id: hit.id, comp: hit.comp, by: (isE(w.entries[e.cause]) ? w.entries[e.cause].actor : null) ?? e.actor, seq, cause: seq }); }
      continue; }
    const seq = w.sayQ.shift(); const e = w.entries[seq]; if (!isE(e) || e.kind !== "say") continue;
    for (const { id, name, v } of scripts) { if (!(Array.isArray(v.on) && v.on.includes("say")) || e.actor === `script:${id}`) continue;
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
  if (v.paused === true) { const pb = pausedBy(w, id, key);
    return { ...base, status: "paused", why: pb ? `paused by ${said(pb.by)} at seq ${pb.at}` : "paused: true", ...(pb ? { pausedBy: pb.by, pausedAt: pb.at, pausedTs: pb.ts } : {}),
      resume: `set {id: '${id}', component: '${key}', value: {paused: false}, merge: true}` }; }
  if (cfg.run === false) return { ...base, status: "stopped", why: "@world.script-settings.run is false" };
  if (!src) return { ...base, status: "failed", why: `its source ${v.src} isn't here` };
  if (!w.scripts) return { ...base, status: "unavailable", why: "this server has no script sandbox" };
  if (rt?.fails >= cfg.fails && rt.ver === lastTouch(w, id, key)?.seq) return { ...base, status: "paused", why: `${rt.fails} failed activations in a row; set it again to retry` };
  const role = roleOf(st, sp?.sponsor); const lost = [];
  for (const x of scopeIds(st, id, v.scope?.ids)) for (const c of v.scope?.comps ?? []) { if (sp?.sponsor && lacks(w, st, sp.sponsor, { verb: "set", id: x, comp: sampleOf(c) }, null, { viaCap: true })) lost.push(`${x}.${c}`); }
  if (lost.length) { const since = lastSetterOf(w, "@world", `roles:${sp.sponsor}`);
    return { ...base, status: "dormant", why: `dormant: sponsor ${said(sp.sponsor)} (${role} now${since ? `, since seq ${since.seq}` : ""}) can no longer change ${lost.join(", ")}`, adopt: `an owner may: adopt {id: '${id}', script: '${name}'}` }; }
  return { ...base, status: rt?.status === "asleep" ? "asleep" : "active" };
}
function scriptsOf(w, st, id) {
  return { scripts: allScripts(st).filter((x) => !id || x.id === id).map((x) => scriptStatus(w, st, x.id, x.name, x.v)),
    ...(id && id !== "@world" ? {} : { imported: importedBehaviours(w, st) }), config: scriptsCfg(st), sandbox: w.scripts ? (w.scripts.available?.() === true ? SR.ENGINE : `unavailable: ${w.scripts.available?.()}`) : "none" };
}
/** The status view for a host's own readers (a server's debug panel): what `scripts {id?}` answers, without a request. */
export function scriptsView(w, id) { if (!w.exists || w.state().status !== "ok") return { scripts: [], imported: [] }; return withAuthority(w, () => scriptsOf(w, w.state(), id)); }
// an imported world carries its old bindings as @world imported-behavior:<name> (their old shape, kept as a record). The authority never runs them.
const IMPORTED_WHY = "an imported behaviour, carried by translation from the world's old log. It doesn't run here: it was written for the old script API (world.emit, world.kv) with its author's rights and no declared scope. Re-install it as script:<name> on the thing it belongs to: rewrite the source for today's script API (docs/SCRIPTS.md), upload {text}, then set script:<name> {src, scope, on}";
function importedBehaviours(w, st) {
  return Object.entries(st.entities["@world"]?.c ?? {}).filter(([k]) => k.startsWith("imported-behavior:")).map(([k, b]) => ({ id: "@world", behavior: k,
    attach: b?.attach ?? null, src: b?.src ?? null, author: b?.author ?? null, status: "needs-reinstall", why: IMPORTED_WHY }));
}

// ---------- the act index (slice 3a): undo and wait without scanning the log ----------
// A view over the log (L2), built once per world object and advanced per appended entry, so a live world (server,
// where `w` lives as long as the world is open) pays for each entry once. A purge is retroactive (L1), so a purge entry
// throws the index away and rebuilds it, as livehost.ts refolds the state. What it holds:
//   actsOf    actor → their act seqs, in order          resultOf  act seq → the first change entry it caused
//   undone    act seqs some `undo` act names (body.undoes)
//   purged    seqs whose act/say/sim BODY is purged; purgedOps `${seq}:${op|-}` → a purged set value (as the fold keys it)
//   changes   every change seq, in order                touch     id → the change seqs that touch it, in order
//   rests     change seqs that are rests (caused by a sim launch); restAfter: rest seq → the authority's follow-up act
//   lastAct   the latest act that isn't an undo or the authority's (for "the latest change was X's")
// A world object over a log that is re-read per request (the suites' disk worlds) rebuilds it per request, as before.
function freshIndex() {
  return { n: 0, actsOf: new Map(), resultOf: new Map(), undone: new Set(), purged: new Set(), purgedOps: new Map(), changes: [], touch: new Map(),
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
    if (e.verb !== "undo" && e.actor !== "system") x.lastAct = i;
    if (e.actor === "system" && b && Number.isInteger(b.rest) && !x.restAfter.has(b.rest)) x.restAfter.set(b.rest, i); }
  if (e.kind === "change") { x.changes.push(i);
    // what the sim writes (a rest) is physics, never an act's undoable result: live, a rest is caused by a launch entry;
    // in an imported world (translate-v1@11) by the old punt's act, which must not make it undoable (review of b398d7e3 #2)
    if (Number.isInteger(e.cause) && e.actor !== "sim" && !x.resultOf.has(e.cause)) x.resultOf.set(e.cause, i);
    for (const id of new Set(opsQuiet(e).map((o) => o.id))) { let a = x.touch.get(id); if (!a) x.touch.set(id, (a = [])); a.push(i); }
    const c = E[e.cause]; if (isE(c) && c.kind === "sim" && c.verb === "launch") x.rests.push(i); }
}
// The entries the fold calls malformed (it shapes nothing with them). The authority never writes one; an old or hand-made
// log may hold some, and they're known when the index is built (the authority re-reads every line it appends).
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
  const out = clone(foldSkyEntry(prev, { verb, args: a, ts: Math.floor(now), seq: 0, actor: "system" }));
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
  // what others wrote since: a thing's own later history (touch), and, for the spatial check, every change entry since
  // the result (bounded by what happened after the act, never the log before it)
  // later work by anyone but the act's own author stands; the load-time lift isn't work (it respells, and its old values
  // are translated again on the way back in)
  const others = (i) => E[i].actor !== target.actor && E[E[i].cause]?.verb !== "lift-sockets";
  const touchedBy = (id, comp) => { const h = X.touch.get(id) ?? []; for (let k = firstAfter(h, res.seq); k < h.length; k++) { const e = E[h[k]]; if (!others(h[k])) continue;
    for (const o of opsQuiet(e)) if (o.id === id && (comp === undefined || o.comp === comp || o.comp === undefined || o.verb === "create")) return e.actor; } return null; };
  const later = X.changes.slice(firstAfter(X.changes, res.seq)).filter(others).map((i) => E[i]);
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
    if (o.verb === "create") { if (now.entities[id]) { const kidsOf = (p) => Object.keys(now.entities).filter((k) => now.entities[k].c.parent?.to === p && !madeHere.has(k));
        // its sockets are its parts (a lift made them): they go with it, and what others put in them is let go like the rest
        const parts = kidsOf(id).filter((k) => isSocketC(now.entities[k].c)); const kids = [...kidsOf(id).filter((k) => !parts.includes(k)), ...parts.flatMap(kidsOf)];
        groups.push([...kids.flatMap((k) => [setOp(k, "transform", worldT(now, k)), delOp(k, "parent")]), ...parts.map((k) => delOp(k)), delOp(id)]); kids.forEach((k) => ctx.refs.add(k)); } }
    else if (whole) { const old = before(id); if (old && !now.entities[id]) (ctx.restores ??= new Set()).add(id), groups.push(createOps(id, Object.fromEntries(Object.entries(old.c).filter(([, v]) => v !== PURGED)))); }
    else { const old = before(id)?.c[comp];
      if (old === PURGED) { skipped.push({ id, component: comp, why: "its old value was purged" }); continue; }
      // (sockets: a host's socket children stand for the map it held before the cut; their delete is translated at the door)
      if (old === undefined) { if (now.entities[id] && (comp in now.entities[id].c || (comp === "sockets" && socketsOf(now, id).some((x) => x.id)))) groups.push([delOp(id, comp)]); }
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
    const acts = (X.actsOf.get(a.actor) ?? []).filter((q) => q >= from && X.resultOf.has(q) && !X.undone.has(q) && !["create-world", "undo", "throw", "drop", "leave"].includes(E[q].verb)).reverse();
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
    if (RESERVED.has(e.actor)) refuse("rank", `act ${seq} was the authority's own, not a person's`, "undo takes back people's acts");
    // research S2: undoing another person's act needs editOthers, and still goes only along rank (custom roles included)
    const me = rankOf(ctx.st, ctx.actor), them = rankOf(ctx.st, e.actor), eo = may(ctx.st, ctx.actor, "editOthers");
    if (!eo || me < them) refuse("rank", `act ${seq} was ${said(e.actor)}'s; ${!eo ? "undoing someone else's work needs builder (editOthers)" : `they're ${roleOf(ctx.st, e.actor)}, above you`}`, "revert goes along rank, never upward: ask an owner");
    return e; };
  const target = a.act !== undefined ? (mine.includes(a.act) ? E[a.act] : othersAct(a.act))
    : a.label ? pick((q) => bodyOf(q)?.request?.label === a.label && !X.undone.has(q) && X.resultOf.has(q))
    : pick((q) => E[q].verb !== "create-world" && depthOf(q) % 2 === 0 && !X.undone.has(q) && X.resultOf.has(q));
  if (!target) { const last = X.lastAct === null ? null : E[X.lastAct];
    refuse("nothing", "nothing of yours to undo" + (last && last.actor !== ctx.actor ? ` (the latest change was ${said(last.actor)}'s; undo only reverts your own)` : ""), "history shows who did what; to change someone else's work, edit it (they'll see it)"); }
  if (target.verb === "create-world") refuse("founding", "founding a world can't be undone", "§2: @world can't be deleted or undone as a whole; to hand it over, give the new owner their role first");
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
  if (target.actor !== ctx.actor && roleOf(ctx.st, ctx.actor) !== "owner") {
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
    const r = w.entries.find((x) => isE(x) && x.kind === "change" && x.cause === e.seq); if (r && opsQuiet(r).some((o) => mine.has(`${o.id}|${o.comp}`))) return null; }
  for (const o of opsOf(res)) { const g = ctx.st.entities[o.id]?.c["terrain-grid"]; if (!g || !o.comp?.startsWith("terrain-tile:") || o.verb !== "set") return null;
    const zeros = () => new Array(g.tile ** 2).fill(0); const b = before.entities[o.id]?.c[o.comp]?.mm ?? zeros(), a = o.value.mm, h = ctx.st.entities[o.id]?.c[o.comp]?.mm ?? zeros();
    const lo = -(g.limits?.lower ?? Infinity), hi = g.limits?.raise ?? Infinity; const v = h.map((x, k) => x - (a[k] - b[k]));
    if (v.some((x) => x < lo || x > hi)) return null;
    if (v.some((x, k) => x !== h[k])) ops.push(setOp(o.id, o.comp, { mm: v })); ctx.refs.add(o.id); }
  if (!ops.length) refuse("nothing", "undoing that stroke changes nothing now", "");
  return ops;
}
// `sculpt`: one act per stroke, applied by the authority to the tiles AT HEAD (never the client's copy), writing only the
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
  if (bytes > 1000000) refuse("too-big", `that stroke rewrites ${writes.size} tiles (about ${bytes} bytes); a log line is at most 1 MiB, and a stroke is one entry`, "use the base (terrain) or import a raster for big changes; or use a smaller brush");
  ctx.actExtra = { tiles: writes.size, ...(clamped ? { clamped: true } : {}) }; ctx.refs.add(a.on);
  return [...writes].map(([c, mm]) => setOp(a.on, c, { mm }));
}
// ---------- blueprints ----------
const BLUEPRINTS = "blueprints:";
const blueprintKey = (h) => `${BLUEPRINTS}${String(h).replace(/^sha256:/, "")}`;
const isPublished = (st, h) => !!st.entities["@world"]?.c[blueprintKey(h)];
// References across a copy (review 10-07 H5; RESEARCH-event-wiring §4.3): every typed reference in a components map (its
// parent excepted: copies place parents themselves) through f(id, path) → new id | null (drop) | the same id (keep).
// Returns the components with dropped references removed (a value whose required reference went is removed whole).
function rebindAll(c, f) {
  for (const k of Object.keys(c)) { if (k === "parent" || k === "copy-of") continue;
    const r = mapRefs(k, c[k], (x, at) => f(x, at, k)); if (r.value === undefined) delete c[k]; else c[k] = r.value; }
  return c;
}
// publish: a reference inside what's published becomes that part's key; one outside is refused (a raw id from this world
// means nothing, or something else, wherever the record lands) unless unwire: true, which drops it and says so
function publishLinks(ctx, a, inside, keyOf, partsOf) {
  const outside = [], unwired = [];
  const parts = partsOf((id, c) => rebindAll(c, (x, at) => { if (inside.has(x)) return keyOf(x); if (a.unwire) { unwired.push({ from: `${id}.${at}`, to: x }); return null; } outside.push({ from: `${id}.${at}`, to: x }); return x; }));
  if (outside.length) refuse("outside-link", `${outside.length} link(s) point outside what you're publishing: ${outside.slice(0, 6).map((o) => `${o.from} → ${o.to}`).join(", ")}`,
    "publish those things too (from: [them, …]), or send unwire: true to publish without those links (each is dropped and listed)", { links: outside });
  if (unwired.length) ctx.notes.push({ unwired, why: "these links pointed outside what you published: dropped from the record (unwire: true)" });
  return parts;
}
function buildPublish(ctx, a, w) {
  const roots = Array.isArray(a.from) ? a.from : [a.from];
  for (const r of roots) if (!ctx.st.entities[r]) refuse("not-found", `no '${r}'`, "look lists what's here", { didYouMean: guess(r, Object.keys(ctx.st.entities)) });
  if (roots.length > 1) return publishGroup(ctx, a, w, roots);
  const ids = [a.from, ...descendants(ctx.st, a.from)];
  const keyOf = partKeys(ctx.st, ids, ctx.st.entities[a.from].c["copy-of"]?.from);
  const parts = publishLinks(ctx, a, new Set(ids), keyOf, (fix) => ids.map((id) => { const c = clone(ctx.st.entities[id].c); delete c["copy-of"];
    if (id === a.from) { delete c.parent; c.transform = { ...c.transform, pos: [0, 0, 0] }; }
    else if (c.parent) c.parent = { ...c.parent, to: keyOf(c.parent.to) };
    return { key: keyOf(id), components: fix(id, c) }; }));
  const record = { name: a.name ?? a.from, root: keyOf(a.from), parts, by: ctx.actor };
  const hash = w.putBlob(record);
  ctx.notes.push({ record: hash, parts: parts.length });
  ctx.refs.add("@world");
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
function publishGroup(ctx, a, w, roots) {
  // a group of siblings: the record gets a root part at their footprint centre on the ground; the world is untouched
  const all = [...new Set(roots.flatMap((r) => [r, ...descendants(ctx.st, r)]))];
  // re-publishing a group copy's members (siblings under one copy) keeps their keys, as a single publish does
  const up = roots.map((r) => ctx.st.entities[r].c.parent?.to); const lineage = up[0] && up.every((p) => p === up[0]) ? ctx.st.entities[up[0]]?.c["copy-of"]?.from : undefined;
  const keyOf = partKeys(ctx.st, all, lineage, ["root"]);
  const ws = roots.map((r) => worldT(ctx.st, r).pos); const cx = ws.reduce((t, p) => t + p[0], 0) / ws.length, cz = ws.reduce((t, p) => t + p[2], 0) / ws.length;
  const parts = [{ key: "root", components: { transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, label: a.name } },
    ...publishLinks(ctx, a, new Set(all), keyOf, (fix) => all.map((id) => { const c = clone(ctx.st.entities[id].c); delete c["copy-of"];
      if (roots.includes(id)) { const t = worldT(ctx.st, id); c.transform = { ...t, pos: [r3(t.pos[0] - cx), r3(t.pos[1]), r3(t.pos[2] - cz)] }; c.parent = { to: "root", order: "a0" }; }
      else c.parent = { ...c.parent, to: keyOf(c.parent.to) };
      return { key: keyOf(id), components: fix(id, c) }; }))];
  const record = { name: a.name ?? "group", root: "root", parts, by: ctx.actor };
  const hash = w.putBlob(record); ctx.notes.push({ record: hash, parts: parts.length, roots: roots.length }); ctx.refs.add("@world");
  return [setOp("@world", blueprintKey(hash), { name: record.name, parts: parts.length })]; // who published it is a view (creatorOf), never stored (L2)
}
// A record's part keys, unique within it (review 10-07 N1: a table holding two copies of a published leg got the keys
// [top, leg, leg], and no copy of it could ever be placed). A part keeps the key it was copied as (blueprint.key) only
// when it comes from the same record as what's being published (`lineage`: re-publishing an edited copy, so update {copy,
// to} still matches part to part); a part nested from another record (a leg inside the table) is keyed by its id. Those
// come first, so a nested part never takes a key the lineage needs; a key already taken falls back to the id, then to the
// id with a number. Returns id → key.
function partKeys(st, ids, lineage, reserved = []) {
  const taken = new Set(reserved); const out = new Map();
  const own = (id) => { const b = st.entities[id].c["copy-of"]; return lineage !== undefined && b?.from === lineage && typeof b.key === "string" ? b.key : null; };
  for (const pass of [true, false]) for (const id of ids) { if (out.has(id) || !!own(id) !== pass) continue;
    const want = own(id) ?? id; const k = taken.has(want) ? null : want;
    let key = k ?? (taken.has(id) ? null : id); for (let n = 2; key === null; n++) if (!taken.has(`${id}-${n}`)) key = `${id}-${n}`;
    taken.add(key); out.set(id, key); }
  return (id) => out.get(id) ?? id;
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
  const root = ctx.st.entities[a.copy]; if (!root?.c["copy-of"]) refuse("not-a-copy", `${a.copy} isn't a blueprint copy`, "");
  let base, theirs; try { base = w.getBlob(root.c["copy-of"].from); theirs = w.getBlob(a.to); } catch { refuse("not-found", "unknown record", "find {kind: 'blueprint'}"); }
  if (!isPublished(ctx.st, a.to)) refuse("not-published", `${a.to} isn't one of this world's blueprints`, "");
  const have = new Map(); for (const id of [a.copy, ...descendants(ctx.st, a.copy)]) { const k = ctx.st.entities[id].c["copy-of"]?.key; if (k !== undefined && !have.has(k)) have.set(k, id); }
  const fresh = partIds(ctx.st, a.copy, base.root, theirs.parts.map((p) => p.key).filter((k) => !have.has(k)));
  const idOf = (key) => (key === base.root ? a.copy : have.get(key) ?? fresh.get(key));
  // references are merged as values in this world's ids: a part key → its id here (an unknown key is unbound, as on copy)
  const inIds = (c) => rebindAll(clone(c), (x) => idOf(x) ?? null);
  const B = Object.fromEntries(base.parts.map((p) => [p.key, inIds(p.components)])), T = Object.fromEntries(theirs.parts.map((p) => [p.key, inIds(p.components)]));
  const eq = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const ops = [], conflicts = [], kept = [], orphaned = [];
  const skipComp = new Set(["copy-of", "parent"]);
  for (const key of new Set([...Object.keys(B), ...Object.keys(T)])) {
    const id = idOf(key), mineE = ctx.st.entities[id];
    if (!B[key]) { const c = clone(T[key]); if (c.parent) c.parent = { ...c.parent, to: idOf(c.parent.to) }; c["copy-of"] = { from: a.to, key };
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
  ops.push(setOp(a.copy, "copy-of", { ...root.c["copy-of"], from: a.to }));
  if (orphaned.length) ctx.notes.push({ orphaned, why: "gone upstream but you changed them here: kept, still yours" });
  if (kept.length) ctx.notes.push({ keptYours: kept });
  for (const o of ops) ctx.refs.add(o.id);
  return ops;
}
// L1: a copy is expanded by the authority into an explicit batch. The fold never reads the record.
function buildCreateFrom(ctx, a) {
  if (typeof a.from === "string" && !a.from.startsWith("sha256:")) return buildDuplicate(ctx, a);
  const w = ctx.w; let rec;
  try { rec = w.getBlob(a.from); } catch { refuse("not-found", `no blueprint ${a.from}`, "find {kind: 'blueprint'} lists this world's blueprints"); }
  if (!isPublished(ctx.st, a.from)) refuse("not-published", `${a.from} isn't one of this world's blueprints`, "publish it here first");
  const id = a.id ?? mint(ctx.st, rec.name);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; or leave id out");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(ctx.st, id, rec.root, rec.parts.map((p) => p.key));
  // a record published before part keys were unique (N1) may name a key twice: each later twin gets an id of its own
  // (a part that names a twin as its parent rides the first; there's no telling which was meant)
  const seen = new Set(), used = new Set([...ids.values()]); const idAt = rec.parts.map((p) => { if (!seen.has(p.key)) { seen.add(p.key); return ids.get(p.key); }
    let n = 2, x; do x = `${ids.get(p.key)}`.slice(0, 60) + `-${n++}`; while (used.has(x) || ctx.st.entities[x]); used.add(x); return x; });
  const ops = [], unbound = [];
  for (const [i, p] of rec.parts.entries()) { const c = clone(p.components);
    if (p.key === rec.root && i === rec.parts.findIndex((q) => q.key === rec.root)) c.transform = resolve(ctx, id, "transform", { ...c.transform, ...(a.at ?? {}) });
    if (c.parent) c.parent = { ...c.parent, to: ids.get(c.parent.to) };
    // a reference to a part key is that part's new id; anything else (a record published before references were typed,
    // naming a raw id of the world it came from) is unbound here, and said: it would mean something else in this world
    rebindAll(c, (x, at) => { if (ids.has(x)) return ids.get(x); unbound.push({ from: `${idAt[i]}.${at}`, was: x }); return null; });
    c["copy-of"] = { from: a.from, key: p.key };
    ops.push(...createOps(idAt[i], c)); ctx.refs.add(idAt[i]); }
  if (unbound.length) ctx.notes.push({ unbound, why: "the record named things that aren't parts of it: those links aren't wired in the copy (set them again)" });
  return ops;
}

// Duplicate (slice 3b; PARITY (b)3): create {from: <a live thing's id>} copies it and everything attached to it, as one
// explicit batch (L1: the fold sees plain creates). The copy keeps the source's parent (a sibling of it), so its
// transform stays local to that parent; `at` replaces fields of the root's transform (local to that parent too), and
// without it the copy sits 0.5 m along x from the source. `lock` isn't copied: a copy is something you're about to
// move. Who made the copy is the create entry's actor (a view, L2).
function buildDuplicate(ctx, a) {
  const st = ctx.st, src = a.from;
  if (src === "@world" || !st.entities[src]) refuse("not-found", `no thing called '${src}' to copy`, "from takes a blueprint hash (sha256:…) or the id of a thing here", { didYouMean: guess(String(src), Object.keys(st.entities)) });
  const all = [src, ...descendants(st, src)];
  const sc = st.entities[src].c;
  const id = a.id ?? mint(st, typeof sc.label === "string" ? sc.label : typeof sc.model === "string" ? sc.model.split("/").pop().replace(/\.[a-z0-9]+$/i, "") : src);
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; or leave id out");
  if (st.entities[id]) refuse("exists", `'${id}' already exists`, "choose another id for the copy");
  const ids = partIds(st, id, src, all);
  const ops = []; let locks = 0; const keptLinks = [];
  for (const sid of all) { const orig = st.entities[sid].c; const c = clone(orig);
    if ("lock" in c) { delete c.lock; locks++; }
    for (const k of Object.keys(orig)) if (orig[k] === PURGED) delete c[k]; // a purged value can't be copied
    if (c.parent && typeof c.parent.to === "string") c.parent = { ...c.parent, to: ids.get(c.parent.to) ?? c.parent.to };
    // every typed reference to something copied now points at its twin (a lamp that looks at its own switch looks at the
    // copy's switch; a script's scope drives the copy, never the original); one to something else is kept, and listed
    rebindAll(c, (x, at) => { if (ids.has(x)) return ids.get(x); keptLinks.push({ from: `${ids.get(sid)}.${at}`, to: x, why: `${x} wasn't copied` }); return x; });
    if (sid === src) { const t = { ...COMPONENTS.transform.defaults, ...(c.transform ?? {}) };
      c.transform = resolve(ctx, id, "transform", a.at ?? { pos: [t.pos[0] + 0.5, t.pos[1], t.pos[2]] }, t); }
    ops.push(...createOps(ids.get(sid), c)); ctx.refs.add(ids.get(sid)); }
  ctx.notes.push({ copied: src, as: id, parts: all.length, ...(locks ? { why: "a lock isn't copied: the copy is free to move" } : {}), ...(keptLinks.length ? { keptLinks } : {}) });
  return ops;
}

// ---------- reads ----------
// R 10-07: a thing reads like an accessibility tree (PROTOCOL §4): its name, its description (alt text; a look clips it,
// inspect has it whole), then what it can do and its state, generated from its components by shared/a11y.js, the reading
// mcpl's look and the inspector share
function describe(st, id, live = {}, holds = {}, { full = false } = {}) {
  const e = st.entities[id]; const t = worldT(st, id); const g = grabOf(e.c); const name = e.c.label ?? modelOf(e.c.model)?.label ?? e.c.model ?? id;
  const ax = readOut(e.c, { name, heldBy: holds[id] ? said(holds[id].by) : null });
  const desc = ax.description == null ? null : full || graphemes(ax.description) <= 200 ? ax.description : `${[...ax.description].slice(0, 200).join("")}… (inspect for all)`;
  return { id, name, ...(desc ? { description: desc } : {}), ...(ax.can.length ? { can: ax.can } : {}), ...(ax.state.length ? { state: ax.state } : {}), at: t.pos.map((n) => Math.round(n * 100) / 100),
    ...(live[id] ? { moving: live[id] } : {}), ...(holds[id] ? { heldBy: holds[id].by, heldAt: holds[id].pose.pos.map((n) => Math.round(n * 100) / 100), ...(holds[id].hand ? { heldIn: holds[id].hand } : {}) } : {}),
    ...(g ? { grab: describeGrab(g, typeof name === "string" ? name : id) } : {}),
    ...(actionsOf(st, id).length ? { actions: actionsOf(st, id) } : {}), ...socketsLine(st, id), ...(e.c.parent ? { in: e.c.parent.to } : {}), ...(lockedC(e.c) ? { lock: e.c.lock === true ? true : { rank: lockLevel(e.c.lock) } } : {}), ...(e.c.openable && typeof e.c.openable === "object" ? { openable: e.c.openable } : {}),
    ...sayOf(st, e.c) };
}
const socketsLine = (st, id) => { const socks = socketsOf(st, id).filter((x) => x.id); return socks.length ? { sockets: socks.map((x) => ({ id: x.id, name: x.name, as: socketRole(st.entities[x.id].c) })) } : {}; };
// batch 2: what its words and media say (shared/says.js, the same lines mcpl's look prints); things it names by their names
const sayOf = (st, c) => { const lines = saysOf(c, { nameOf: (x) => (st.entities[x] ? st.entities[x].c.label ?? modelOf(st.entities[x].c.model)?.label ?? x : said(x)), now: CTX.mintW?.now?.() ?? null });
  return lines.length ? { says: lines } : {}; };

// ---------- physics (design 20) ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const handOf = (me) => [me.at[0], me.at[1] + HAND_Y, me.at[2]]; // reach is measured from the hand, not the feet
// P5 + L3: the sequencer logs where unheld motion came to rest. The rest is the engine's value and nothing else: its
// cause is the launch, it goes through admit like every write, and admit checks it against the engine. The engine
// digest is its own `sim` entry. Whatever the authority then does about it (attach it to what it rests on, return a thing
// that left the world) is a SEPARATE entry caused by a system act, so a rest and a correction never look alike.
const REST_COALESCE_TICKS = 15;   // ~0.5 s at 33 ms: PHYSICS §4.4's settlement window
// a child of a NON-UNIFORMLY scaled parent is sheared unless its local rotation keeps the parent's axes (a crate on a flat
// tray sits square: fine; a tumbled crate that rested on a fallen domino: "splortched", R 10-11 23:36)
const uniformScale = (sc) => Math.max(...sc) - Math.min(...sc) <= 0.01 * Math.max(...sc);
const axisAligned = (q) => { const [x, y, z, w] = q; const ax = [[1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)], [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)]];
  return ax.every((v) => v.some((c) => Math.abs(c) > 0.995)); };
const shearFree = (parentScale, localQ) => uniformScale(parentScale) || axisAligned(localQ);
function settleSim(w) {
  const skip = new Set(); w.unsettled = [];
  if (!w.state().entities["@world"]?.c["physics-engine"]) return; // no engine: nothing in flight (an epoch cut logs every rest first, P6)
  let digested = false;
  for (let guard = 0; guard < 64; guard++) {
    // the lowest first (R 10-10 23:23, the gym log): pyr-9 settled onto pyr-6, and then pyr-6's own rest in the same view
    // moved pyr-6 and dragged pyr-9, now its child, 19 cm into pyr-7. A support rests before what it carries.
    const sf = w.sim(); let due = sf.rested.filter((x) => !skip.has(`${x.id}@${x.seq}`)).sort((a, b) => a.p[1] - b.p[1]); if (!due.length) return;
    // a launch's rests are logged together: when its last body rests, or when its oldest unlogged rest is REST_COALESCE_TICKS
    // old (a cascade rests one crate at a time over seconds; a heartbeat pass would otherwise log one body per beat, which is
    // what one-digest-one-change per body cost). The rest tick is the engine's either way; only the entry's ts is later.
    const ready = (seq) => { const mine = due.filter((x) => x.seq === seq); const flying = Object.entries(sf.launched).some(([id, l]) => l.seq === seq && sf.sim.bodies[id] && !sf.sim.bodies[id].resting);
      return !flying || mine.some((x) => x.lost) || Math.min(...mine.map((x) => x.tick)) <= sf.sim.tick - REST_COALESCE_TICKS; };
    due = due.filter((x) => ready(x.seq)); if (!due.length) return;
    // one change per launch per pass, every body that launch set moving in it (PHYSICS §1 already reads a rest so; STRIKES
    // PH-S2-5: one digest + one change per body was 1.16 KB and 2.4 entries per rested body), and one digest per pass: every
    // rest in a pass is at the same clock. A batch one body spoils falls back to one rest at a time (its refusal names it).
    const batch = due.filter((x) => x.seq === due[0].seq);
    const st = w.state();
    const opsFor = (r) => { const t = worldT(st, r.id); return [...(st.entities[r.id].c.parent ? [delOp(r.id, "parent")] : []), setOp(r.id, "transform", { pos: r.p.slice(), q: r.q ? r.q.slice() : t.q, scale: t.scale })]; };
    let plan = null, group = batch;
    try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: batch.map((r) => r.id), comps: ["transform", "parent"], launch: batch[0].seq } }, batch.flatMap(opsFor)); }
    catch (e) { if (!(e instanceof Refusal)) throw e;
      if (batch.length === 1) { w.unsettled.push({ id: batch[0].id, launch: batch[0].seq, refused: e.code, reason: e.reason }); skip.add(`${batch[0].id}@${batch[0].seq}`); continue; } // 33 F2: on
      group = [batch[0]];
      try { plan = admit(w, st, { actor: "sim", cap: { kind: "rest", ids: [batch[0].id], comps: ["transform", "parent"], launch: batch[0].seq } }, opsFor(batch[0])); }
      catch (e2) { if (!(e2 instanceof Refusal)) throw e2; w.unsettled.push({ id: batch[0].id, launch: batch[0].seq, refused: e2.code, reason: e2.reason }); skip.add(`${batch[0].id}@${batch[0].seq}`); continue; } }
    if (!digested) { w.append({ kind: "sim", actor: "sim", cause: group[0].seq, verb: "digest", body: { digest: digestOf(sf.sim) } }); digested = true; }
    const rest = changeEntry(w, plan, group[0].seq);
    for (const r of group) {
      const st2 = w.state(); const B = boundsOf(st2);
      if (B && outsideWorld(B, r.p)) {
        // it landed outside the world: lost. The authority sends it home when it has one (R 10-11 00:07: "ball rolled out
        // of world bounds and now I can't touch it"), else back to where it was picked up, as its own act.
        const old = st.entities[r.id].c; const hm = old.home;
        const viaHome = hm && Array.isArray(hm.pos) && hm.pos.length === 3 && Array.isArray(hm.q) && hm.q.length === 4 ? returnPlan(w, st2, r.id, { home: hm }) : null;
        if (viaHome?.plan) { changeEntry(w, viaHome.plan, w.append(actEntry(w, "system", "return-lost", { id: r.id, rest, home: true }))); continue; }
        const back = [setOp(r.id, "transform", old.transform), ...(old.parent ? [setOp(r.id, "parent", old.parent)] : [])];
        const p2 = admit(w, st2, { actor: "system", cap: { kind: "system", ids: [r.id], comps: ["transform", "parent"] } }, back);
        changeEntry(w, p2, w.append(actEntry(w, "system", "return-lost", { id: r.id, rest })));
        continue;
      }
      // it rests ON something: name that as its parent, as place does, so it rides with it (the relation is the authority's word)
      // ON = what its footprint touches (R 10-10: a pyramid's top crate sits over the gap between two crates; read under its
      // centre, the gap led down to the crate a row lower, and the top crate was parented 0.5 m above it: carry that one
      // and it rode along in mid-air). Nothing within 3 cm under its footprint: not parented.
      // and never onto a HELD thing (R 10-10 evening): a held thing still stands in the log where it was picked up, so the
      // crates that fell off it settled back onto it and were carried off in her hands
      const fam = new Set([r.id, ...descendants(st2, r.id)]); const bx = aabb(st2, r.id);
      for (const k of Object.keys(w.presence.holds)) if (st2.entities[k]) for (const d of [k, ...descendants(st2, k)]) fam.add(d);
      const sup = bx ? supportUnder(st2, bx, fam) : supportBelow(st2, r.p[0], r.p[2], r.p[1] + 0.02, fam);
      if (sup.id === "ground" || (bx && sup.y < bx.min[1] - 0.03)) continue;
      // never under a support whose scale isn't uniform (a domino: a crate at [1, 2, 0.2]): a child of a rotated, non-uniformly
      // scaled parent is SHEARED by the composition (R 10-11 23:36: a crate "splortched" after a domino fell with it on top)
      const wt = worldT(st2, r.id); const s3 = scratch(st2, [setOp(r.id, "parent", { to: sup.id })]); const lt = localFrom(s3, sup.id, wt);
      if (!shearFree(worldT(st2, sup.id).scale, lt.q)) continue;
      const attach = [setOp(r.id, "parent", { to: sup.id, order: "a0" }), setOp(r.id, "transform", lt)];
      const p3 = admit(w, st2, { actor: "system", cap: { kind: "system", ids: [r.id], comps: ["transform", "parent"] } }, attach);
      changeEntry(w, p3, w.append(actEntry(w, "system", "settle", { id: r.id, onto: sup.id, rest })));
    }
  }
}
// P6: an engine change is a real cut. At rest the cut is free (the log already holds every result); in flight it waits.
function buildEpoch(ctx, v, a) {
  const sf = ctx.w.sim(); const live = [...new Set([...Object.keys(livePoses(sf)), ...sf.rested.map((r) => r.id)])]; // at rest but not on the record counts (33 F2): P6's "free" needs every result logged
  if (live.length && !a.force) refuse("busy", `${live.length} thing(s) are still in flight or not yet on the record (${live.join(", ")}); all at rest in about ${r3((restEta(sf) ?? 0) / 1000)} s`, "try again then, or force: true to freeze them where they are now (they'll be logged there)");
  const ops = live.map((id) => { const b = sf.sim.bodies[id]; return setOp(id, "transform", { ...worldT(sf.st, id), pos: b.p.slice(), ...(b.q ? { q: b.q.slice() } : {}) }); }); // a rigid engine's origin only means something with its own q
  for (const id of live) ctx.refs.add(id);
  if (live.length) ctx.notes.push({ frozen: live, why: "forced cut: stopped mid-air and logged where they were" });
  if (v === null) return [...ops, delOp("@world", "physics-engine")];
  if (!v || typeof v.engine !== "string") refuse("shape", "sim needs {engine, tickMs?}", `engines this server carries: ${Object.keys(ENGINES).join(", ")}`);
  unknownKeys("@world.physics-engine", v, Object.keys(COMPONENTS["physics-engine"].fields), "physics-engine"); // the authority builds the value from these keys: a typo would vanish silently
  const known = ENGINES[v.engine];
  const spec = { engine: v.engine, build: v.build ?? known?.build ?? null, tickMs: Number.isInteger(v.tickMs) ? v.tickMs : 33 };
  if (!known) refuse("unknown-engine", `this server doesn't carry '${v.engine}'`, `it carries: ${Object.keys(ENGINES).join(", ")}`, { didYouMean: guess(v.engine, Object.keys(ENGINES)) });
  // the engine never starts an epoch outside its tick range, so a throw would be logged and then fly nowhere, forever
  // (review of b398d7e3 #3)
  if (v.tickMs !== undefined && !(Number.isInteger(v.tickMs) && v.tickMs >= TICK_MS.min && v.tickMs <= TICK_MS.max))
    refuse("bounds", `tickMs is ${JSON.stringify(v.tickMs)}; the engine steps at a whole number of ms from ${TICK_MS.min} to ${TICK_MS.max}`, "leave it out for 33 (30 steps a second), or e.g. tickMs: 16");
  if (v.build === undefined) ctx.notes.push({ component: "physics-engine", field: "build", kept: spec.build, why: "stamped: determinism belongs to one exact build, so the epoch names it" });
  if (!carried(spec)) ctx.notes.push({ component: "physics-engine", why: "that build isn't carried here: nothing will be thrown in this world until a server that carries it runs it" });
  ctx.refs.add("@world");
  return [...ops, setOp("@world", "physics-engine", spec)];
}
function body(w, actor) {
  const b = w.presence.bodies[actor];
  if (!b) refuse("not-here", "your body isn't in the world yet", "move {to: [x, y, z]} puts it somewhere (bodies are presence: never logged)");
  return b;
}
function holdOf(w, actor, id) {
  const h = w.presence.holds[id];
  // gone first: a delete now releases the hold itself (9d7bc99b), so a put of a deleted thing found no hold and said
  // 'not-holding' when the truth is that the thing is gone (attack-check L1low)
  if (!w.state().entities[id]) { if (h) { delete w.presence.holds[id]; w.savePresence(); } refuse("gone", h?.by === actor || !h ? `${id} isn't here any more (it was deleted)` : `${id} was deleted`, "your hand is empty now"); }
  if (!h || h.by !== actor) refuse("not-holding", `you aren't holding ${id}${h ? ` (${said(h.by)} is)` : ""}`, `grab {id: '${id}'} first`);
  return h;
}
// L6 / 25d M3: the authority's own plausibility TRACK of each body (presence: unlogged). A body is where the authority last
// ACCEPTED it, never where a client last claimed. Walking spends a token bucket (SPEED m/s sustained, CAP m of
// burst) and may not enter a solid a body can't step over; a refused step leaves the body where it was (reverted for
// its sender, visibly). Arriving, or `teleport: true`, is a teleport: an ACT on the record (it resets the track), refused
// while holding anything, refused inside a solid, and (for visitors) refused away from @world.spawn when the world
// declares one. Every settlement (grab, put, throw) measures reach from the track and records the presence it used.
const TRACK = { speed: 6, cap: 4, step: 0.8, radius: 0.2, height: 1.7, spawnR: 2 };
function bodyBox(p) { return { min: [p[0] - TRACK.radius, p[1] + TRACK.step, p[2] - TRACK.radius], max: [p[0] + TRACK.radius, p[1] + TRACK.height, p[2] + TRACK.radius] }; }
// both ask the spatial index: only what the body's box (or the whole step's swept box) meets is tested (review 10-06 S0-2)
function solidAt(w, st, p, except = new Set(), cands = null) {
  const box = bodyBox(p); const held = w.presence.holds; const ix = cands && spatial(st);
  if (cands) spend(1 + (cands.length >> 3));   // a sub-step filters the step's candidates by box first
  for (const id of cands ?? near(st, box.min, box.max)) { if (id === "@world" || Object.hasOwn(held, id) || except.has(id) || openNow(st, id)) continue;
    if (cands) { const q = ix.rec.get(id).q; if (q.min[0] > box.max[0] || q.max[0] < box.min[0] || q.min[1] > box.max[1] || q.max[1] < box.min[1] || q.min[2] > box.max[2] || q.max[2] < box.min[2]) continue; }
    if (hitsIx(st, box, id, 0.01)) return id; }
  return null;
}
// an open openable (a whole door, not a cabinet's part) is out of the way: the fix above says "through a door someone
// opens", and every browser's collider follows the drawn leaf (client/lib/openable.js reindexes it at rest)
const openNow = (st, id) => { const o = st.entities[id]?.c.openable; return !!o && typeof o === "object" && o.open === true && !o.part; };
function pathBlocked(w, st, from, to) {
  const already = new Set(); const b0 = bodyBox(from); // a body already inside something may walk out of it
  for (const id of near(st, b0.min, b0.max)) if (hitsIx(st, b0, id, 0.01)) already.add(id);
  const b1 = bodyBox(to); const swept = near(st, b0.min.map((v, i) => Math.min(v, b1.min[i])), b0.max.map((v, i) => Math.max(v, b1.max[i])));
  const n = Math.max(1, Math.ceil(dist(from, to) / 0.05));
  for (let k = 1; k <= n; k++) { const p = from.map((v, i) => v + (to[i] - v) * k / n); const hit = solidAt(w, st, p, already, swept); if (hit) return hit; }
  return null;
}
// A body that walks more than a metre from its seat has stood up (a seated client sends no steps; standing, it walks)
// Who sits where (presence, never logged: review 10-12 S1-1): {to: <socket id>}. A seat whose socket is gone or switched
// off is no seat (its occupant was let go by every client), so a reader never sees one.
function seatOf(w, st, who) { const s = w.presence.seats?.[who];
  return s && typeof s.to === "string" && isSocketC(st.entities[s.to]?.c) && !offChain(st, s.to) ? s : null; }
const setSeat = (w, who, to) => { (w.presence.seats ??= {})[who] = { to }; w.presenceDirty = true; };
const clearSeat = (w, who) => { if (w.presence.seats?.[who]) { delete w.presence.seats[who]; w.presenceDirty = true; } };
// another present body seated on this socket (one body per socket: VRChat Station, Roblox Seat), or the thing sitting in it
function sitterOn(w, st, sock, actor) {
  for (const who of Object.keys(w.presence.seats ?? {})) if (who !== actor && w.presence.bodies[who] && seatOf(w, st, who)?.to === sock) return { who };
  const thing = Object.keys(st.entities).find((k) => st.entities[k].c.parent?.to === sock); return thing ? { thing } : null; }
function leftSeat(w, st, actor, to) {
  const s = seatOf(w, st, actor); if (!s) return clearSeat(w, actor);
  const p = worldT(st, s.to).pos;
  if (Math.hypot(to[0] - p[0], to[2] - p[2]) > 1) clearSeat(w, actor);
}
// Who a hand or a foot acting on `id` would move with it: another present body seated on it or on anything riding it, or
// standing on it or on anything riding it (review 10-12 S1-1/S1-2: a kick, a shove, a grab or a throw went round body
// consent through the chair). Bodies are presence and never things, so this is the only way one is moved by moving a thing.
function occupant(w, st, id, actor) {
  const fam = new Set([id, ...descendants(st, id)]);
  for (const who of Object.keys(w.presence.seats ?? {})) { const s = seatOf(w, st, who); if (who !== actor && s && fam.has(s.to)) return { who, how: "sits on" }; }
  const boxes = [...fam].map((k) => aabb(st, k)).filter(Boolean);
  for (const [who, b] of Object.entries(w.presence.bodies)) if (who !== actor && Array.isArray(b?.at) && boxes.some((x) => feetOn(x, b.at))) return { who, how: "is standing on" };
  return null;
}
function occupiedRefuse(w, st, id, actor, what) {
  const o = occupant(w, st, id, actor);
  if (o) refuse("occupied", `${said(o.who)} ${o.how} ${id} (or something on it), so it can't be ${what}`, "wait till they get up or step off", { by: o.who });
}
// review 10-07 M3: hand acts (grab, put, drop, throw, punt) record the request about the THING (and who handled it), never
// the body's position or hand: the put's change carries where the thing went, a launch's sim entry where it left from
// and how fast (what the engine needs, PHYSICS §4). The gate's view of the body stays presence.
const PHYSICS_VERBS = {
  move(w, actor, a) {
    if (!Array.isArray(a.to) || a.to.length !== 3 || a.to.some((n) => !Number.isFinite(n))) refuse("shape", "move needs to: [x, y, z]", "");
    const st = w.state(); const B = boundsOf(st);
    if (B && outsideWorld(B, a.to)) refuse("out-of-bounds", `[${a.to.join(", ")}] is outside this world (x ${B.min[0]}…${B.max[0]}, up to y ${B.max[1]}, z ${B.min[2]}…${B.max[2]})`, "pick a spot inside the bounds");
    const me = w.presence.bodies[actor]; const now = w.now(); const to = a.to.slice();
    if (!me || a.teleport === true) { // a teleport (arriving is one): an act, so the track's reset is on the record
      const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
      if (mine.length) refuse("holding", `you're holding ${mine.join(", ")}; a teleport can't carry things`, "put it down (or walk it there) first", { at: me?.at });
      const inSolid = solidAt(w, st, to); if (inSolid) refuse("solid", `[${to.join(", ")}] is inside ${inSolid}`, "arrive somewhere a body fits", { at: me?.at });
      const sp = st.entities["@world"]?.c.spawn;
      if (sp && Array.isArray(sp.pos) && !may(st, actor, "build") && dist(sp.pos, to) > (sp.radius ?? TRACK.spawnR))
        refuse("spawn", `this world's arrivals are within ${sp.radius ?? TRACK.spawnR} m of [${sp.pos.join(", ")}]`, "arrive there, then walk", { at: me?.at });
      rateCheck(w, actor);
      // review 10-07 M3: a body's whereabouts are presence. An ARRIVAL writes nothing to the log (that a person was here
      // at a time is not history the world needs). A TELEPORT while present is an act, because it resets the speed
      // track: who did it and when is on the record; never where from, where to, or what kind of client they are
      const act = me ? w.append(actOf(w, actor, "move", { teleport: true })) : undefined;
      w.presence.bodies[actor] = { at: to, ts: now, tokens: TRACK.cap, ...(a.client ? { client: String(a.client) } : {}) }; leftSeat(w, st, actor, to); w.savePresence();
      return { ok: true, at: to, ...(act !== undefined ? { recorded: true, act } : {}) };
    }
    const d = dist(me.at, to); const tokens = Math.min(TRACK.cap, (me.tokens ?? TRACK.cap) + TRACK.speed * Math.max(0, now - (me.ts ?? now)) / 1000);
    if (d > tokens + 1e-9) refuse("too-fast", `that's ${r3(d)} m; right now your body can cover ${r3(tokens)} m (${TRACK.speed} m/s, ${TRACK.cap} m at most in one go)`, "walk there in steps, or move {to, teleport: true} (an act on the record; not while holding anything)", { at: me.at });
    const block = pathBlocked(w, st, me.at, to);
    if (block) refuse("solid", `${block} is in the way`, "walk around it (or through a door someone opens)", { at: me.at, blocker: block });
    const prev = me.at; w.presence.bodies[actor] = { ...me, at: to, ts: now, tokens: tokens - d }; leftSeat(w, st, actor, to);
    const carrying = [];
    for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === actor) { h.pose.pos = h.pose.pos.map((n, i) => n + to[i] - prev[i]); carrying.push(id); }
    w.savePresence();
    return { ok: true, recorded: false, at: to, ...(carrying.length ? { carrying } : {}) };
  },
  grab(w, actor, a) {
    if (typeof a.id === "string" && a.id.startsWith("body:")) return BODY_VERBS.body(w, actor, { to: a.id, kind: "drag" }); // a body is presence, never an entity (§2.3)
    const me = body(w, actor); const sf = w.sim(); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    notAThing(st, a.id, "picked up"); offRefuse(st, a.id, "picked up");
    const held = w.presence.holds[a.id];
    if (a.hand !== undefined && !["left", "right"].includes(a.hand)) refuse("shape", "hand is left or right", "");
    if (a.offset !== undefined && !offsetOk(a.offset)) refuse("shape", "offset is {pos: [x, y, z] (within 2 m), q: [x, y, z, w]}: where it sits in your hand", "a VR hand sends where it took hold");
    if (held?.by === actor) return secondHand(w, actor, a, held, e);
    // grabOf (shared/grab.js) is the one reader: grabbable, or a dynamic thing's physics.who (the migration fallback)
    const g = grabOf(e.c);
    if (!g) refuse("not-grabbable", `${a.id} isn't something you can pick up`, `a builder can make it so: set {id: '${a.id}', component: 'grabbable', value: {who: 'visitor'}} (anyone may; {} for builders only)`);
    if (!g.enabled) refuse("not-grabbable", `${a.id} can't be picked up now (its grabbable.enabled is false)`, "a builder can turn it back on: set {id, component: 'grabbable', value: {…, enabled: true}}");
    const need = g.who; const role = roleOf(st, actor); if (rankOf(st, actor) < whoRank(st, need)) refuse("rights", `only a ${need} may pick up ${a.id}`, `ask someone who can, or ask the owner to set ${g.source}.who: 'visitor'`);
    if (held && !g.steal && role !== "owner") refuse("held", `${said(held.by)} is holding ${a.id}, and it can't be taken from a hand (grabbable.steal is false)`, "wait till they let go (an owner may take it)");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be picked up`, `a builder or owner can unlock it first: delete {id: '${k}', component: 'lock'}`, { lock: k });
    occupiedRefuse(w, st, a.id, actor, "picked up");
    // two things at once (R, 10-10, an avatar walking about with five crates: "maybe two, since VR players can pick up two
    // things"; a number, not a claim about hands: "avatars can have more (or none!)")
    { const mine = Object.keys(w.presence.holds).filter((k) => k !== a.id && w.presence.holds[k].by === actor);
      if (mine.length >= MAX_HELD) refuse("hands-full", `you are already holding ${mine.length} things (${mine.join(", ")}), and ${MAX_HELD} is the most you can carry here`, `put one down first: put {id: '${mine.at(-1)}'}`); }
    const live = livePoses(sf)[a.id]; const t = worldT(st, a.id); const eb = sf.launched[a.id] ? sf.sim?.bodies[a.id] : null;
    const here = held ? held.pose.pos : live ? live.pos : eb ? eb.p : t.pos; // where it IS: someone's hand, the air, the engine (rested, not yet logged: second review S2-1), or the log
    // range (grabbable): from the hand; past arm's reach the authority grants it as a pull (the thing flies to the hand: a
    // presence ease on every client), never a hold at a distance (the reach check is the anti-cheat)
    // reach is to the NEAREST POINT of its box when it stands in the world, not to its origin (a barrel's origin is at its
    // base: standing against it is in reach; R 10-11 23:27). In a hand or in the air: to where it is.
    const hp = handOf(me), bx = !held && !live && !eb ? aabb(st, a.id) : null;
    const reachPt = bx ? [0, 1, 2].map((i) => Math.min(bx.max[i], Math.max(bx.min[i], hp[i]))) : here;
    const d = dist(hp, reachPt); if (d > g.range) refuse("out-of-reach", `${a.id} is ${r3(d)} m from you; you can reach ${g.range} m`, `move {to: [${r3(here[0])}, ${me.at[1]}, ${r3(here[2])}]} (your feet stay on the floor; your hand reaches ${HAND_Y} m up) first`);
    const how = holdHow(a, g); // which hand, by which grip or offset: refused before anything is written
    const prev = w.presence.holds[a.id]; const notes = [];
    if (d > REACH) notes.push({ id: a.id, pulled: r3(d), why: `it was ${r3(d)} m away; its grabbable.range lets it fly to your hand` });
    if (prev && prev.by !== actor) notes.push({ id: a.id, takenFrom: prev.by, why: "the latest grab wins; they were told" });
    // what rested on it (and isn't its child, which rides along) loses its support (playtest 22, F3)
    const fam = new Set([a.id, ...descendants(st, a.id)]);
    const over = new Set(); if (!live) for (const s of spatial(st).rec.get(a.id)?.surfs ?? []) for (const k of near(st, [s.min[0], s.y - 0.02, s.min[1]], [s.max[0], Infinity, s.max[1]])) over.add(k);   // only what stands over its surfaces (the index)
    const dependents = live ? [] : Object.keys(st.entities).filter((k) => { if (fam.has(k) || !over.has(k)) return false; const b = aabb(st, k);
      return b && !st.entities[k].c.parent && supportUnder(st, b, familyOf(st, k)).id === a.id; });
    // R 10-10: what the physics stacked on it (a dynamic child, its rest attached it) does NOT come along unless it carries
    // ('can carry other entities', a tray): picking up the bottom crate of a stack takes that crate; the rest fall and
    // tumble. A builder's attachment (a child that isn't dynamic) still rides.
    const physW = !!(st.entities["@world"]?.c["physics-engine"] && carried(st.entities["@world"].c["physics-engine"]));
    if (physW && !live && !g.carries) for (const k of descendants(st, a.id)) if (st.entities[k]?.c.physics?.kind === "dynamic" && !dependents.includes(k)) dependents.push(k);
    for (const k of dependents) { const gk = grabOf(st.entities[k].c);
      const lockK = [k, ...ancestors(st, k)].find((x) => lockedC(st.entities[x]?.c)); if (lockK) refuse("locked", `${k} rests on ${a.id}, and ${lockK === k ? "it" : lockK} is locked, so picking ${a.id} up would move it`, `take ${k} off first, or unlock ${lockK} (delete {id: '${lockK}', component: 'lock'})`, { lock: lockK });
      if (!may(st, actor, "editOthers") && !(gk && gk.enabled && rankOf(st, actor) >= whoRank(st, gk.who))) refuse("rights", `${k} rests on ${a.id}, and you can't move ${k}`, "picking it up would move what's on it; ask someone who can to take it off first"); }
    const spec = st.entities["@world"]?.c["physics-engine"];
    // without physics, dependents are set straight down: a write, so it is admitted first (all or nothing)
    let plan = null;
    // it CARRIES (grabbable.carries, a tray): what rests over it rides along as its children from now on, so it comes up
    // in the hand and flies with a throw (R 10-11 23:19: "I picked up the tray but all the other entities on it fell
    // straight through it even though 'can carry other entities' was checked"); nothing is launched
    let carriedUp = [];
    if (g.carries && dependents.length) {
      const ps = worldT(st, a.id).scale;
      carriedUp = dependents.filter((k) => !w.presence.holds[k]).map((k) => { const wt = worldT(st, k); const s3 = scratch(st, [setOp(k, "parent", { to: a.id })]); return { k, lt: localFrom(s3, a.id, wt) }; })
        .filter((x) => shearFree(ps, x.lt.q));
      const ops = carriedUp.flatMap(({ k, lt }) => [setOp(k, "parent", { to: a.id, order: "a0" }), setOp(k, "transform", lt)]);
      carriedUp = carriedUp.map((x) => x.k);
      if (ops.length) plan = admit(w, st, { actor, cap: { kind: "system", ids: carriedUp, comps: ["transform", "parent"] } }, ops);
      dependents.length = 0;
    }
    if (dependents.length && !(spec && carried(spec))) {
      const ops = dependents.map((k) => { const b = aabb(st, k); const below = supportUnder(st, b, new Set([k, ...fam, ...descendants(st, k)])); const tk = worldT(st, k);
        return setOp(k, "transform", { ...tk, pos: [tk.pos[0], r3(tk.pos[1] - (b.min[1] - below.y)), tk.pos[2]] }); });
      plan = admit(w, st, { actor, cap: { kind: "system", ids: dependents, comps: ["transform"] } }, ops);
    }
    // picking a thing up takes it out of the world's physics (no collider left at its old spot), and that changes the
    // sim, so it goes through the log (Covenant III: presence never feeds the sim otherwise)
    let act = null;
    if ((spec && carried(spec)) || dependents.length || carriedUp.length) rateCheck(w, actor); // this grab will be logged
    const actOnce = () => (act ??= w.append(actOf(w, actor, "grab", a)));
    if (carriedUp.length && plan) { changeEntry(w, plan, actOnce()); notes.push({ carried: carriedUp, why: `they were resting on ${a.id}, which carries: they ride along as its children now` }); }
    if (spec && carried(spec)) { w.append({ kind: "sim", actor, cause: actOnce(), verb: live ? "catch" : "lift", body: { id: a.id } });
      if (live) notes.push({ id: a.id, why: "caught it in the air (logged: the sim had it)" }); }
    if (dependents.length) {
      if (spec && carried(spec)) {
        for (const k of dependents) w.append({ kind: "sim", actor, cause: actOnce(), verb: "launch", body: { id: k, p: worldT(st, k).pos.slice(), yaw: qYaw(worldT(st, k).q), ...(ENGINES[st.entities["@world"]?.c["physics-engine"]?.engine]?.rotates ? { q: worldT(st, k).q.slice() } : {}), v: [0, 0, 0], handled: [actor] } });
        notes.push({ fell: dependents, why: `they were resting on ${a.id}; picking it up let them fall (physics will log where they land)` });
      } else {
        changeEntry(w, plan, actOnce());
        notes.push({ setDown: dependents, why: `they were resting on ${a.id}; with no physics running they were set straight down` });
      }
    }
    const handled = [...new Set([...(prev?.handled ?? []), actor])];
    const hand = handOf(me); // in your hand now (a VR client would send the hand's pose)
    w.presence.holds[a.id] = { by: actor, since: w.now(), pose: { pos: hand, q: (live && sf.sim.bodies[a.id]?.q) ? sf.sim.bodies[a.id].q.slice() : t.q, scale: t.scale }, handled, ...how }; // caught mid-air: as it's turned now
    w.savePresence();
    heldEvent(w, "grab", a.id, { by: actor, hand: how.hand, ...(how.grip ? { grip: how.grip } : {}), ...(act !== null ? { seq: act } : {}) });
    return { ok: true, recorded: act !== null, holding: a.id, inHandAt: hand.map(r3), ...how, ...(notes.length ? { notes } : {}) };
  },
  // P3: putting something down is a settlement: a claim the authority checks like any write, then logs as a plain result.
  // grabbable says where it goes (research §3): home (release: return), into a socket that accepts it (fits), where
  // the hand let go (release: stay), or straight down onto what's below (drop, the default).
  put(w, actor, a, how = "put") {
    const me = body(w, actor); const h = holdOf(w, actor, a.id);
    const st = w.state(); occupiedRefuse(w, st, a.id, actor, "set down"); const t = worldT(st, a.id); const g = grabOf(st.entities[a.id].c);
    const facts = () => ({ handled: h.handled });
    // review 10-06: the claim is checked before anything acts on it: a pos is [x, y, z] within reach (a far or malformed
    // pos snapped into a socket across the world), and the holder's rank NOW still covers carrying it (the return and the
    // snap are the holder's settlements too, as a plain put is)
    if (a.pos !== undefined) { if (!Array.isArray(a.pos) || a.pos.length !== 3 || a.pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
      const d0 = dist(handOf(me), a.pos); if (d0 > REACH) refuse("out-of-reach", `that's ${r3(d0)} m from you; you can reach ${REACH} m`, "move closer first"); }
    { const role = roleOf(st, actor); if (g && rankOf(st, actor) < whoRank(st, g.who)) refuse("rights", `only a ${g.who} may move ${a.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
    // home: the holder's act, then the authority's return (its own act, caused by the release)
    if (g?.release === "return" && g.home) {
      const ret = returnPlan(w, st, a.id, g);
      if (ret.plan) { rateCheck(w, actor); const act = w.append(actOf(w, actor, "put", a, { ...facts(), release: "return" }));
        const back = returnHome(w, a.id, ret.plan, act); delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: "return", seq: act });
        return { ok: true, act, seq: back.seq, settled: { id: a.id, home: g.home }, handled: h.handled, release: "return", notes: [{ id: a.id, why: "its grabbable.release is return: it went home" }] }; }
    }
    // a socket that accepts it, within that socket's radius of where it's let go (Resonite Snapper, XRI Socket)
    const snap = snapTarget(st, a.id, g, a.pos ?? h.pose.pos, w);
    if (snap.to) { const x = snap.to;
      // it sits at the socket's own pose (identity under it); its size in the world is kept
      const hs = worldT(st, x.id).scale; const scale = t.scale.map((v, i) => r3(v / hs[i]));
      const ops = [setOp(a.id, "parent", { to: x.id, order: "a0" }), setOp(a.id, "transform", { pos: [0, 0, 0], q: [0, 0, 0, 1], scale })];
      const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
      const act = w.append(actOf(w, actor, "put", a, { ...facts(), release: "snap", socket: x.where }));
      const seq = changeEntry(w, plan, act); delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: "snap", to: x.host, socket: x.name, in: x.id, seq: act });
      return { ok: true, seq, act, settled: { id: a.id, in: x.id }, handled: h.handled, release: "snap", notes: [{ id: a.id, snapped: x.where, why: `it fits ${x.host}'s ${x.name} socket (accepts ${x.sock.accepts.join(", ")})` }, ...snap.notes] };
    }
    // stay: where the hand let go (a put with no pos), and never called floating (the builder said it hangs there)
    const stay = g?.release === "stay";
    let pos = a.pos;
    if (pos === undefined && stay) pos = h.pose.pos.map(r3);
    if (a.at !== undefined && (!Array.isArray(a.at) || a.at.length !== 2 || a.at.some((n) => !Number.isFinite(n)))) refuse("shape", "put takes at: [x, z] (set it down there, on whatever is below)", "");
    if (pos === undefined) { // no pose given: onto what's below, the authority resolves the height. Where: `at` (the
      // holder says where on the floor, e.g. in front of their feet: the hand is INSIDE the body's footprint, and a big
      // thing set down there shoved the body aside, R 10-10), else straight down from the hand.
      // Its BOTTOM rests on the support, not its origin: a ball's origin is its centre, and one put down by its origin
      // sat half in the floor (R's gym, 10-10). The bottom is the thing's own box under its origin, as it last stood.
      // What it lands on is what is under its CENTRE (a thing resting by a sliver of its footprint on a neighbour hung in
      // the air beside it), and never a thing in someone's hand: a held thing is still in the log where it was picked
      // up, and crates put down there floated on nothing (R's gym, 10-10; the second was so before `at` existed).
      const fam = new Set([a.id, ...descendants(st, a.id)]); const x = a.at ? a.at[0] : h.pose.pos[0], z = a.at ? a.at[1] : h.pose.pos[2];
      for (const k of Object.keys(w.presence.holds)) if (st.entities[k]) for (const d of [k, ...descendants(st, k)]) fam.add(d);
      const q = spatial(st).rec.get(a.id)?.q; const under = q ? Math.max(0, t.pos[1] - q.min[1]) : 0;
      const sup = supportBelow(st, x, z, h.pose.pos[1], fam);
      pos = [r3(x), r3(sup.y + under), r3(z)]; }
    if (!Array.isArray(pos) || pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
    const d = dist(handOf(me), pos); if (d > REACH) refuse("out-of-reach", `that's ${r3(d)} m from you; you can reach ${REACH} m`, "move closer first");
    const q = a.q ?? h.pose.q; const value = { pos, q, scale: t.scale };
    const ops = [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", value)];
    // the one gate first (your role and its locks NOW, not when you picked it up), then the physical claim on top
    const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
    const bad = warnings(plan.after, [a.id], true).filter((x) => !(stay && (x.kind === "floating" || x.kind === "sunk")))
      .filter((x) => !(x.with && w.presence.holds[x.with]));   // not "inside" a thing that is in someone's hand (the log has it where it was picked up)
    // set down where it doesn't fit (against a neighbour, on a ledge): in a world that runs physics a loose thing is let
    // go there instead, from the hand's height, and physics finds where it rests. Only for the plain put (no pos claimed).
    if (bad.length && a.pos === undefined && !stay && fliesIn(st, a.id)) return PHYSICS_VERBS.drop(w, actor, { id: a.id, pos: [pos[0], r3(h.pose.pos[1]), pos[2]] });
    if (bad.length) refuse("implausible", `physics wouldn't leave ${a.id} there: ${bad.map((b) => b.kind + (b.with ? ` ${b.with}` : b.above ? ` above ${b.above}` : b.into ? ` into ${b.into}` : "")).join("; ")}`, "a settlement is a claim the authority checks; put it where it would really rest, or leave pos out to set it straight down", { problems: bad });
    const act = w.append(actOf(w, actor, "put", a, { ...facts(), ...(stay ? { release: "stay" } : {}) }));
    const seq = changeEntry(w, plan, act);
    delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: stay ? "stay" : how, seq: act });
    return { ok: true, seq, act, settled: { id: a.id, pos }, handled: h.handled, ...(stay ? { release: "stay" } : {}), ...(snap.notes.length ? { notes: snap.notes } : {}) };
  },
  // research §Decisions 1: what flies is a dynamic thing in a world that runs physics. Anything else let go is set
  // straight down, and a throw of it is a drop that says so: a VR hand lets go with its velocity whatever the world is
  // (thingphysics.release sends throw when the hand moves), and refusing it left the thing stuck in the hand.
  // grabbable.throw scales the velocity (0: it can only be dropped); release: return sends it home instead of flying.
  throw(w, actor, a) {
    if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "throw needs v: [x, y, z] in m/s", "e.g. v: [0, 3, 4] tosses it up and forward (+z)");
    notAThing(w.state(), a.id, "thrown");
    const g = grabOf(w.state().entities[a.id]?.c);
    const why = !fliesIn(w.state(), a.id) ? (w.state().entities["@world"]?.c["physics-engine"] ? `${a.id} isn't physics {kind: 'dynamic'}, so it doesn't fly: it was set down` : "this world doesn't run physics, so it was set down")
      : g?.throw === 0 ? `${a.id} can't be thrown (its grabbable.throw is 0): it was let go` : g?.release === "return" ? null : undefined;
    if (why !== undefined) {
      const r = PHYSICS_VERBS.drop(w, actor, { id: a.id, ...(a.pos !== undefined ? { pos: a.pos } : {}) }, "throw");
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
      return PHYSICS_VERBS.put(w, actor, { id: a.id }, how); }
    return launch(w, actor, { ...a, v: [0, 0, 0] }, "drop", g);
  },
  // a kick (/punt, an agent's punt request), as a sim intent (design 20, P4: "punt is a sim intent
  // too"). A thing at your feet (or in the air beside you: a volley) is launched with v, or with power along the line from
  // your feet through it, lifted (physobj's 0.9 ratio: a knee-high hop at power 4). Its gates are grab's: dynamic,
  // physics.who, its locks and its ancestors', and nobody's hand. A thing in flight is caught and re-launched (logged).
  punt(w, actor, a) {
    const me = body(w, actor); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    notAThing(st, a.id, "punted"); offRefuse(st, a.id, "punted");
    const spec = flyingWorld(st);
    const ph = e.c.physics;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${a.id} isn't something you can punt`, `a builder can make it so: set {id: '${a.id}', component: 'physics', value: {kind: 'dynamic'}}`);
    const need = ph.who ?? DEFAULT_WHO; if (rankOf(st, actor) < whoRank(st, need)) refuse("rights", `only a ${need} may punt ${a.id}`, "ask the owner to set physics.who: 'visitor'");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be punted`, `a builder or owner can unlock it first: delete {id: '${k}', component: 'lock'}`, { lock: k });
    const held = w.presence.holds[a.id]; if (held) refuse("held", `${said(held.by)} is holding ${a.id}`, "grab it to take it (the latest grab wins), or wait till they let go");
    occupiedRefuse(w, st, a.id, actor, "punted");
    shaped(e, a.id, st.entities["@world"]?.c["physics-engine"] ?? null);
    if (a.v !== undefined && a.power !== undefined) refuse("shape", "punt takes v or power, not both", "v: [x, y, z] in m/s, or power (m/s) along the line from your feet through it");
    const sf = w.sim(); const b = sf.sim?.bodies[a.id]; const flying = !!(sf.launched[a.id] && b && !b.resting);
    const t = worldT(st, a.id); const here = flying ? b.p : t.pos;
    const dx = here[0] - me.at[0], dz = here[2] - me.at[2], dh = Math.hypot(dx, dz), dy = here[1] - me.at[1];
    if (a.shove !== undefined) shoveGate(w, st, me, a, flying, actor);
    else if (dh > KICK.reach || dy < KICK.below || dy > KICK.above) refuse("out-of-reach", `${a.id} is ${r3(dh)} m from your feet${dy > KICK.above ? `, ${r3(dy)} m up` : ""}; a punt reaches ${KICK.reach} m`, `move {to: [${r3(here[0] - (dh > 1e-6 ? dx / dh : 0) * 0.5)}, ${me.at[1]}, ${r3(here[2] - (dh > 1e-6 ? dz / dh : 1) * 0.5)}]} first`);
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
    const act = w.append(actOf(w, actor, "punt", a, { ...(flying ? { volley: true } : {}) }));
    if (flying) w.append({ kind: "sim", actor, cause: act, verb: "catch", body: { id: a.id } });
    const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: here.map(noNeg0), yaw: flying && !b.q ? noNeg0(b.yaw) : qYaw(flying ? b.q : t.q), ...(ENGINES[sf.spec.engine]?.rotates ? { q: (flying ? b.q : t.q).slice(), ...(flying ? { w: b.w.slice() } : {}) } : {}), v: v.map(noNeg0), handled: [actor] } });
    return { ok: true, seq, act, flying: a.id, from: here.map(r3), v: v.map(r3), ...(flying ? { volley: true } : {}), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
  },
  // a holder who leaves: what they held is dropped (into the sim if there is one), attributed to them (orphans, 18a)
  leave(w, actor) {
    const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
    const wasLeaving = w.leaving; w.leaving = actor; let out; try { out = mine.map((id) => ({ id, r: request(w, actor, "drop", { id }) })); } finally { w.leaving = wasLeaving ?? null; }   // a nested request (enter() keeps the outer call's state)
    // L6: a disconnect settles at the last ACCEPTED state. A drop the gate refused (demoted, locked) leaves the thing
    // where the log last had it; if picking it up took it out of the engine, the authority puts it back there, as its own act.
    for (const { id, r } of out) if (!r.ok && w.presence.holds[id]?.by === actor) { delete w.presence.holds[id];
      const st = w.state(); if (st.entities[id] && st.entities["@world"]?.c["physics-engine"]) { const t = st.entities[id].c.transform;
        if (t) { const p = admit(w, st, { actor: "system", cap: { kind: "system", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]);
          changeEntry(w, p, w.append(actEntry(w, "system", "return-held", { id, holder: actor, why: r.refused?.code }))); } } }
    delete w.presence.bodies[actor]; clearSeat(w, actor); w.savePresence();
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
    // PHYSICS §1: a launch's rest covers every body its flight set moving; each transform in it is one body's rest
    const c = E[e.cause]; const ops = opsQuiet(e).filter((o) => o.comp === "transform" && typeof o.id === "string" && o.value?.pos);
    const ai = X.restAfter.get(seq); const after = ai === undefined ? null : E[ai];
    for (const op of ops.reverse()) out.push({ seq, id: op.id, cause: e.cause, at: op.value.pos, handled: c.body.handled ?? [c.actor], when,
      ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) }); }
  return out.reverse();
}
// the punt's reach, from the feet: a thing at your feet, or in the air beside you (a volley)
// A shove (shared/shove.js: a walking body ran into it) is a punt with its own gate, in place of the kick's reach: a thing at
// rest, from a body standing against its footprint (SHOVE.reach from the feet, measured to its box, not its origin: a wide
// crate's middle is far from the side you walk into), neither under the feet nor over the head, pushed away from the feet
// along the ground at a walk's speed. Everything else is the punt's: physics.who, locks, a hand on it, the engine's cap.
function shoveGate(w, st, me, a, flying, actor) {
  if (a.shove !== true) refuse("shape", "shove is true or left out", "");
  if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "a shove carries v: [x, y, z] in m/s (never power)", "e.g. punt {id, v: [1.5, 0.2, 0], shove: true}");
  if (flying) refuse("in-flight", `${a.id} is already moving; a shove pushes what stands still`, "walk into it again once it comes to rest");
  const [vx, vy, vz] = a.v, vh = Math.hypot(vx, vz), m = massOf(st, a.id), cap = shoveCap(m);
  if (vh > cap + 1e-3 || Math.hypot(vx, vy, vz) > SHOVE.maxV * (1 + SHOVE.lift) + 1e-3) refuse("too-fast", `a shove is a walking body's push: ${r3(vh)} m/s is more than a body passes to ${a.id} (${r3(m)} kg: at most ${r3(cap)} m/s)`, `at most ${r3(cap)} m/s; a kick (punt without shove) goes harder`);
  if (vh < 1e-6 || vy < 0 || vy > SHOVE.lift * vh + 1e-9) refuse("shape", `a shove pushes along the ground: its v rises at most ${SHOVE.lift} × its speed along the ground, and never falls`, "e.g. v: [1.5, 0.2, 0]");
  const f = me.at, b = aabb(st, a.id) ?? { min: worldT(st, a.id).pos, max: worldT(st, a.id).pos };
  if (b.max[1] <= f[1] + SHOVE.underfoot) refuse("underfoot", `${a.id} is under your feet; a body walks over it, it doesn't shove it`, "step off it, or punt it (no shove)");
  if (b.min[1] >= f[1] + SHOVE.above) refuse("out-of-reach", `${a.id} is over your head (${r3(b.min[1] - f[1])} m up); a shove is from a body against it`, "");
  // to its ORIENTED box (review 10-12 S2-2: a rotated plank's axis-aligned box reached metres past the plank)
  const ob = obbs(st, a.id); const R = ob.length ? reachTo(ob, f) : { d: 0, n: null, c: b.min.map((x, i) => (x + b.max[i]) / 2) };
  if (R.d > SHOVE.reach) refuse("out-of-reach", `${a.id} is ${r3(R.d)} m from your feet; a shove comes from a body against it (${SHOVE.reach} m)`, "walk up to it first");
  const dir = R.n ?? (() => { const cx = R.c[0] - f[0], cz = R.c[2] - f[2], l = Math.hypot(cx, cz); return l > 1e-6 ? [cx / l, cz / l] : null; })();
  if (!dir || vx * dir[0] + vz * dir[1] < 0.5 * vh) refuse("wrong-way", `that doesn't push ${a.id} away from your feet; a shove pushes it within 60° of straight away`, "");
  // not through a wall: the body's way to the point it touches is clear of anything solid but the thing and what rides it
  if (R.d > 0.05 && R.n) { const fam = new Set([a.id, ...descendants(st, a.id)]); const L = Math.max(0, R.d - 0.2), n = Math.ceil(L / 0.05);
    for (let k = 1; k <= n; k++) { const p = [f[0] + R.n[0] * L * k / n, f[1], f[2] + R.n[1] * L * k / n]; const hit = solidAt(w, st, p, fam);
      if (hit) refuse("out-of-reach", `${hit} is between you and ${a.id}`, "walk round to it"); } }
  // never into someone: what it slides through until friction stops it is clear of every other body (S2-1)
  for (const [who, bd] of Object.entries(w.presence.bodies)) if (who !== actor && Array.isArray(bd?.at) && sweptCovers(b, a.v, bd.at))
    refuse("in-the-way", `${said(who)} is where ${a.id} would slide`, "push it another way, or wait till they move", { by: who });
}
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
const fliesIn = (st, id) => !!st.entities["@world"]?.c["physics-engine"] && st.entities[id]?.c.physics?.kind === "dynamic";
// The socket a released thing snaps into (research §3, Resonite Snapper with XRI's radius): the nearest socket, on
// anything but itself or what it carries, whose `accepts` shares a keyword with its grabbable.fits and whose world point
// is within the socket's radius of where it's let go. A socket something already sits in, or one on a locked thing, is
// passed over (and said so). Its transform becomes the socket's pose in the host's frame (a child's transform is
// local to its parent; the slot names which socket it's in).
function snapTarget(st, id, g, p, w = null) {
  const out = { to: null, notes: [] }; if (!g?.fits?.length || !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) return out;
  const fam = new Set([id, ...descendants(st, id)]);
  for (const x of allSockets(st)) {
    const at = x.id;   // a switched-off host (or socket) has nothing to snap into (review 5d5eef5c #7)
    if (x.host === "@world" || fam.has(x.host) || fam.has(at) || offChain(st, at)) continue;
    const sk = x.sock;
    if (!fitsSocket(g, sk)) continue;
    const d = dist(socketPoint(st, x), p); if (d > socketRadius(sk)) continue;
    const where = { to: x.id };
    if (Object.entries(st.entities).some(([k, y]) => k !== id && y.c.parent?.to === x.id)) { out.notes.push({ passedOver: where, why: "something already sits in that socket" }); continue; }
    const sat = w ? sitterOn(w, st, x.id, null) : null; if (sat?.who) { out.notes.push({ passedOver: where, why: `${said(sat.who)} sits in that socket` }); continue; }
    const lk = [at, ...ancestors(st, at)].find((k) => lockedC(st.entities[k]?.c)); if (lk) { out.notes.push({ passedOver: where, why: `${lk} is locked` }); continue; }
    if (!out.to || d < out.to.d) out.to = { ...x, d, where };
  }
  return out;
}
// Home (research §3): where a returning thing goes. A system act (actor system, verb return-home) whose cause is the
// release, then its change entry: the home transform (and the parent it had), with its scale kept. Refused (a lock, a home
// parent that's gone) means it stays where it is.
function returnPlan(w, st, id, g) {
  const e = st.entities[id]; const hp = g.home.parent;
  if (hp && !st.entities[hp.to]) return { plan: null, why: `its home parent ${hp.to} is gone` };
  const ops = [...(hp ? [setOp(id, "parent", { order: "a0", ...hp })] : e.c.parent ? [delOp(id, "parent")] : []), setOp(id, "transform", { pos: g.home.pos.slice(), q: g.home.q.slice(), scale: (e.c.transform?.scale ?? [1, 1, 1]).slice() })];
  try { return { plan: admit(w, st, { actor: "system", cap: { kind: "system", ids: [id], comps: ["transform", "parent"] } }, ops) }; }
  catch (x) { if (!(x instanceof Refusal)) throw x; return { plan: null, why: x.reason }; }
}
function returnHome(w, id, plan, cause) {
  const act = w.append({ kind: "act", actor: "system", verb: "return-home", ...(cause !== undefined ? { cause } : {}), body: { id } });
  return { act, seq: changeEntry(w, plan, act) };
}
// What moved a thing last, when it was a hand or physics (a settlement, a punt, a rest, the authority's follow-up to one):
// the entry and the release that caused it. An edit, a script or a return isn't one (they don't send it home).
const HAND_VERBS = new Set(["put", "drop", "throw", "punt", "leave"]), SYSTEM_AFTER = new Set(["settle", "return-lost", "return-held"]);
function lastRelease(w, id) {
  const lt = lastTouch(w, id, "transform"); if (!lt) return null;
  const se = w.entries[lt.seq]; const c = w.entries[se?.cause]; if (!isE(c)) return null;
  const byHand = (c.kind === "act" && (HAND_VERBS.has(c.verb) && !RESERVED.has(c.actor) || (c.actor === "system" && SYSTEM_AFTER.has(c.verb)))) || (c.kind === "sim" && c.verb === "launch");
  return byHand ? { seq: lt.seq, ts: se.ts, release: c.kind === "sim" ? c.cause : se.cause } : null;
}
const sameHome = (st, id, home) => { const e = st.entities[id]; const t = e?.c.transform; if (!t || !home) return false;
  const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-3);
  return near(t.pos, home.pos) && near(t.q, home.q) && (e.c.parent?.to ?? null) === (home.parent?.to ?? null); };
// returnAfter (research §3): at the first request after a thing has been unheld that long since a hand or physics last
// moved it, the authority sends it home: the same kind of lazy write as a rest. Once: the return is the last thing that
// moved it, and a return isn't a release.
function returnDue(w) {
  const st = w.state(); const now = w.now(); let sf = null;
  for (const [id, e] of Object.entries(st.entities)) {
    const v = e.c.grabbable; if (!v || typeof v !== "object" || !(v.returnAfter > 0)) continue;
    const g = grabOf(e.c); if (!g?.home || w.presence.holds[id]) continue;
    if (st.entities["@world"]?.c["physics-engine"]) { sf ??= w.sim(); if (sf.launched[id]) continue; }   // in flight, or its rest isn't logged yet
    const r = lastRelease(w, id); if (!r || now - r.ts < g.returnAfter * 1000 || sameHome(st, id, g.home)) continue;
    const { plan } = returnPlan(w, w.state(), id, g); if (plan) returnHome(w, id, plan, r.release);
  }
}
// A home is stamped when a grabbable that returns is written without one (its transform and parent then), and an edit
// that moves a thing whose home was where it stood carries the home with it (a builder moving the key moves its hook…
// home). A builder may set home outright; one that isn't where the thing stands is left alone.
// the scale a thing goes home at, in its home parent's frame (R 10-10: a settled crate is parented to the one under it
// at a local scale of 1; sent home unparented with that 1, it came back four times its size). Its size in the world is
// kept: its scale times every ancestor's now, divided by the home parent chain's.
const vec3s = (v) => (typeof v === "number" ? [v, v, v] : Array.isArray(v) && v.length === 3 ? v : [1, 1, 1]);
const chainScale = (st, id) => { let k = [1, 1, 1], p = id, n = 0; while (p && n++ < 33) { const c = st.entities[p]?.c; if (!c) break; const sc = vec3s(c.transform?.scale); k = k.map((x, i) => x * sc[i]); p = c.parent?.to; } return k; };
const homeScale = (st, id, home) => { if (home.scale !== undefined) return vec3s(home.scale).slice();
  const world = chainScale(st, id), under = home.parent?.to ? chainScale(st, home.parent.to) : [1, 1, 1];
  return world.map((x, i) => +(x / (under[i] || 1)).toFixed(6)); };
const homeHere = (st, id) => { const c = st.entities[id]?.c ?? {}; const t = { ...COMPONENTS.transform.defaults, ...(c.transform ?? {}) };
  return { pos: t.pos.slice(), q: t.q.slice(), ...(c.parent?.to ? { parent: { to: c.parent.to } } : {}) }; };
// a reset handler being written: each target with no home of its own gets one where it stands now (it can be moved with
// "set home here", i.e. a write of home). Not under a capability: a script or reaction writes only what it names.
function stampResetHomes(ctx, ops) {
  if (ctx.cap || !ops.length) return ops;
  const resets = ops.filter((o) => o.verb === "set" && o.comp === "reactions" && o.value && typeof o.value === "object").flatMap((o) => Object.values(o.value).filter((h) => h?.kind === "reset"));
  if (!resets.length) return ops;
  const after = scratch(ctx.st, ops); const out = ops.slice(); const done = new Set();
  for (const t of resets.flatMap((h) => h.targets ?? [])) { const c = after.entities[t]?.c; if (!c || done.has(t)) continue; done.add(t);
    if (c.home || grabOf(c)?.home || ops.some((o) => o.id === t && o.comp === "home")) continue;
    const home = homeHere(after, t); out.push(setOp(t, "home", home)); ctx.notes.push({ id: t, component: "home", kept: home, why: "stamped for the reset that names it: where it stands now" }); }
  return out;
}
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
  const spec = st.entities["@world"]?.c["physics-engine"];
  if (!spec) refuse("no-physics", "this world has no physics running, so nothing flies", "put it down instead (put {id}); the owner can turn physics on: set {id: '@world', component: 'physics-engine', value: {engine: 'eidosim@1.0.0'}}");
  if (!carried(spec)) refuse("foreign-engine", `this world runs ${spec.engine} (build ${spec.build}), which this server doesn't carry`,
    `put it down instead; the owner can move the world to an engine this server carries: set {id: '@world', component: 'physics-engine', value: {engine: '${Object.keys(ENGINES)[0]}'}}`);
  return spec;
}
// a thing with no stamped shape is no body in the engine (stampShapes): launched, it would never fly or rest
function shaped(e, id, spec = null) {
  // a rotating engine finds a thing's collider through its model (the epoch's boxes): with no model it would fly nothing
  // and never rest (review of 49d4fb0d #6). Today the shape check below refuses it anyway (a modelless thing keeps no
  // measured shape; phys-check D6); this holds if a shape can ever be set without a model
  const bodied = typeof e.c.model === "string" || e.c.mesh !== undefined;
  if (spec && ENGINES[spec.engine]?.rotates && !bodied) refuse("no-shape", `${id} has no model or mesh, so ${spec.engine} has no collider to fly`, "put it down instead (put {id}); give it a model first");
  if (spec && ENGINES[spec.engine]?.rotates && e.c.physics?.shape?.type === "sphere" && !shapeError(e.c.physics.shape)) return;   // a rigid engine flies a sphere
  if (!isBoxShape(e.c.physics?.shape)) refuse("no-shape", `${id} has no measured shape${bodied ? "" : " (it has no model or mesh)"}, so physics can't fly it`, bodied ? `put it down instead; a builder can re-set its physics (set {id: '${id}', component: 'physics', value: {kind: 'dynamic'}}) and the authority measures it` : "put it down instead; give it a model first");
}
// where the hand lets go (a VR hand, or the desktop hand the person sees): within reach of the authority's track of the body
function releasePos(me, pos) {
  if (!Array.isArray(pos) || pos.length !== 3 || pos.some((n) => !Number.isFinite(n))) refuse("shape", "pos is [x, y, z]: where your hand lets go", "");
  const d = dist(handOf(me), pos); if (d > REACH) refuse("out-of-reach", `[${pos.map(r3).join(", ")}] is ${r3(d)} m from your hand as the authority tracks your body; you can reach ${REACH} m`, "move first, or leave pos out");
  return pos.map(noNeg0);
}
function launch(w, actor, a, verb, g = null) {
  const me = body(w, actor); const h = holdOf(w, actor, a.id); occupiedRefuse(w, w.state(), a.id, actor, verb === "drop" ? "dropped" : "thrown");
  const spec = flyingWorld(w.state());
  shaped(w.state().entities[a.id], a.id, spec);
  if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "throw needs v: [x, y, z] in m/s", "e.g. v: [0, 3, 4] tosses it up and forward (+z)");
  // PHYSICS.md §4.2: spin is w, [x, y, z] rad/s in the world frame, everywhere; t is the capture time on the authority's
  // clock. The act keeps the request as sent; the launch carries w for engines that spin things (eidosim does, with its
  // spin cap). t is never a sim input: a launch takes effect at its own entry's tick (Covenant IV)
  if (a.w !== undefined && !(Array.isArray(a.w) && a.w.length === 3 && a.w.every((n) => Number.isFinite(n) && Math.abs(n) <= 1000))) refuse("shape", "w is [x, y, z]: spin in rad/s about world axes (each within ±1000)", "e.g. w: [0, 6.28, 0] turns once a second about up");
  if (a.t !== undefined && !Number.isFinite(a.t)) refuse("shape", "t is a time on the authority's clock (ms)", "leave it out if you don't know it");
  // q as let go (PHYSICS §4.2): the launch carries it, so a client that predicts its own throw folds the same inputs
  // bit for bit (DESIGN-physics-responsiveness §3). A unit quaternion, else refused.
  if (a.q !== undefined) { if (!(Array.isArray(a.q) && a.q.length === 4 && a.q.every(Number.isFinite) && Math.abs(Math.hypot(...a.q) - 1) < 1e-3)) refuse("shape", "q is the thing's orientation as let go: a unit quaternion [x, y, z, w]", "leave it out to use the hold's");
    h.pose.q = a.q.map(noNeg0); }
  if (a.pos !== undefined) h.pose.pos = releasePos(me, a.pos);
  // L7 (33 F3): a launch writes no state now, but it decides a write (its rest). Admit the write it releases, as put
  // does: your role and its locks NOW, rate. The plan is a check only; the rest will be the engine's value.
  { const st = w.state(); const t = worldT(st, a.id);
    admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: h.pose.pos.map(r3), q: t.q, scale: t.scale })]); }
  // one function with the predicting client (launchplan.js): the body it folds is this body, bit for bit
  const L = planLaunch({ id: a.id, p: h.pose.pos, q: h.pose.q, v: a.v, ...(a.w !== undefined ? { w: a.w } : {}) }, g, ENGINES[spec.engine].maxSpeed, verb); const { v, notes } = L;
  const act = w.append(actOf(w, actor, verb, a, { handled: h.handled }));
  const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: L.p, yaw: qYaw(h.pose.q), ...(ENGINES[spec.engine].rotates ? { q: L.q } : {}), v, ...(a.w !== undefined ? { w: L.w } : {}), handled: h.handled } });
  // R 10-10 evening: what rides on it (a tray's load, or a stack settled onto it) flies too, from where the hand has it,
  // with the same velocity. Left as children they were carried rigidly by the thrown crate and sank with it into the ground.
  const riders = []; { const st = w.state(); const t = worldT(st, a.id);
    const at = scratch(st, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: h.pose.pos.slice(), q: h.pose.q ?? t.q, scale: t.scale })]);
    // each rider leaves with the tray's velocity at ITS spot (v + w × r: the rim of a tumbling tray moves faster than its
    // middle), plus a small scatter (6% of the speed per axis) for the flick. The scatter is a hash of the act and the id,
    // and the launch carries the result, so every client folds the same spray (R 10-10: "start to fly apart as soon as
    // they're launched from your hand").
    const sp = Math.hypot(...v), wv = Array.isArray(a.w) ? a.w : [0, 0, 0], o = h.pose.pos;
    const jit = (k, i) => { let x = 2166136261; for (const ch of `${act}:${k}:${i}`) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return ((x >>> 0) / 4294967295) * 2 - 1; };
    for (const k of descendants(st, a.id)) { if (st.entities[k]?.c.physics?.kind !== "dynamic" || w.presence.holds[k]) continue; const tk = worldT(at, k);
      const r = [0, 1, 2].map((i) => tk.pos[i] - o[i]); const wr = [wv[1] * r[2] - wv[2] * r[1], wv[2] * r[0] - wv[0] * r[2], wv[0] * r[1] - wv[1] * r[0]];
      let vk = [0, 1, 2].map((i) => v[i] + wr[i] + jit(k, i) * 0.06 * sp); const sk = Math.hypot(...vk), max = ENGINES[spec.engine].maxSpeed;
      if (sk > max) vk = vk.map((n) => n * max / sk); vk = vk.map((n) => noNeg0(r3(n)));
      w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: k, p: tk.pos.map(noNeg0), yaw: qYaw(tk.q), ...(ENGINES[spec.engine].rotates ? { q: tk.q.slice() } : {}), v: vk, ...(a.w !== undefined ? { w: a.w.slice() } : {}), handled: h.handled } });
      riders.push(k); } }
  if (riders.length) notes.push({ flying: riders, why: `they were riding on ${a.id}; they fly with it` });
  delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: verb, seq: act });
  return { ok: true, seq, act, flying: a.id, from: h.pose.pos.map(r3), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
}
// ---------- body consent (L6 as revised 21:45; research 42). Presence only: none of this is ever appended. ----------
// The authority keeps every body's table (consent.js) beside `bodies` and `holds`, refuses BEFORE delivery, and keeps an
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
    (P.throttle ??= {})[`${from}:${cls}`] = now + 600000; w.appendMod({ actor: "system", verb: "auto-cooldown", who: from, class: cls, minutes: 10, why: `${mine.length} refusals of ${cls} from ${new Set(mine.map((r) => r.to)).size} people in 5 min` }); } }
// The gate for every act on another body. extra: { cls?, spec?, why?, script?, sponsor? }.
function bodyGate(w, from, to, kind, extra = {}) {
  const P = w.presence, now = w.now(); to = bodyRef(to); const cls = extra.cls ?? C.KIND_CLASS[kind];
  if (!cls) return { ok: false, code: "shape", reason: `no body kind '${kind}'`, fix: Object.keys(C.KIND_CLASS).join(", ") };
  if (!P.bodies[to]) return { ok: false, code: "not-here", reason: `${to} isn't here` };
  if (from === to) return { ok: true, consent: "self", deliver: () => deliver(w, from, to, kind, cls, extra, "self") };
  const result = (verdict, r) => { ringPush(P, { ts: now, from, to, cls, verdict }); w.presenceDirty = true; return r; };
  if (P.throttle?.[`${from}:${cls}`] > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${from} is on a cool-down for ${cls} after repeated refusals (moderator log)`, fix: "ask people first; this lifts by itself" });
  let d = C.decide(P, from, to, cls, now);
  if (isScriptActor(from) && extra.sponsor && !C.tableOf(P, to).overrides[from]?.[cls] && C.tableOf(P, to).overrides[`scripts-by:${extra.sponsor}`]?.[cls]) d = C.decide(P, `scripts-by:${extra.sponsor}`, to, cls, now);
  if (d.mode === "nobody") { noteRefusal(w, from, to, cls, now); return result("refused", { ok: false, code: "consent", class: cls, reason: d.why, fix: `${to} isn't taking ${cls} from you; their shield says so (look)` }); }
  if (d.mode === "ask") {
    if (isScriptActor(from)) return result("refused", { ok: false, code: "consent", class: cls, reason: `${to}'s ${cls} is 'ask'; a behaviour can't wait for an answer`, fix: `${to} may allow ${from} by name` });
    const key = `${from}>${to}:${cls}`; if (P.cool?.[key]?.until > now) return result("refused", { ok: false, code: "cool-down", class: cls, reason: `${to} said no (or didn't answer); you may ask again in ${Math.ceil((P.cool[key].until - now) / 60000)} min`, fix: "the wait doubles each time" });
    if (Object.values(P.asks ?? {}).some((k) => k.from === from && k.to === to)) return result("refused", { ok: false, code: "pending", class: cls, reason: `you already have an ask waiting with ${to}`, fix: "one at a time" });
    if (Object.values(P.asked ?? {}).filter((t) => t.from === from && now - t.ts < 60000).length >= 2) return result("refused", { ok: false, code: "rate", class: cls, reason: "at most 2 asks a minute", fix: "" });
    const id = `ask-${now}-${Object.keys(P.asks ?? {}).length}`; (P.asks ??= {})[id] = { id, from, to, kind, cls, spec: extra.spec ?? null, why: extra.why ?? null, expires: now + C.ASK_MS };
    (P.asked ??= {})[id] = { from, ts: now };
    inboxPush(P, to, { type: "body-ask", ask: { id, from, kind, summary: `${from} asks to ${kind}${extra.spec?.point ? ` (${extra.spec.point})` : ""}`, why: extra.why ?? null, expires: now + C.ASK_MS } });
    return result("asked", { ok: true, asked: true, ask: id }); }
  return { ok: true, consent: d.standing === "allow" ? "allowed" : "standing", deliver: () => { ringPush(P, { ts: now, from, to, cls, verdict: "allowed" }); deliver(w, from, to, kind, cls, extra, "standing"); } };
}
function deliver(w, from, to, kind, cls, extra, consent) {
  const P = w.presence, b = P.bodies[to];
  if (cls === "pose") { b.pose = extra.spec ?? {}; b.poseBy = from; }
  if (cls === "move") b.draggedBy = from;
  if (cls === "shove") b.tumble = { by: from, ts: w.now() };
  if (cls === "touch" || cls === "intimate") (P.reaches ??= {})[from] = { to, cls, point: extra.spec?.point ?? null };
  inboxPush(P, to, { type: "body", from, kind, cls, consent, ...(extra.spec ? { spec: extra.spec } : {}) }); w.presenceDirty = true;
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
const BODY_VERBS = {
  // L6: the person's own table. `of: <who>` acts on someone else's: closing only, and only if they named you trusted.
  consent(w, actor, a) { const P = w.presence, now = w.now(); expireAsks(w);
    if (a.answer !== undefined) { const k = P.asks?.[a.answer]; if (!k || k.to !== actor) refuse("not-found", `no ask '${a.answer}' waiting for you`, "consent {} lists them");
      delete P.asks[a.answer];
      if (a.yes === true) { if (a.for) C.setConsent(P, actor, { allow: k.from, class: k.cls, for: a.for }, now);
        deliver(w, k.from, actor, k.kind, k.cls, { spec: k.spec }, "asked"); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "allowed (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: true, applied: true }); }
      else { coolDown(P, k, now); ringPush(P, { ts: now, from: k.from, to: actor, cls: k.cls, verdict: "refused (asked)" }); inboxPush(P, k.from, { type: "body-reply", ask: k.id, ok: false, why: `${actor} said no` }); }
      w.presenceDirty = true; return { ok: true, answered: a.answer, yes: a.yes === true }; }
    const changing = ["preset", "set", "allow", "deny", "pause", "friend"].some((k) => a[k] !== undefined);
    if (changing) { const r = C.setConsent(P, actor, a, now); if (!r.ok) refuse(r.code, r.reason, r.fix ?? "anyone you trust may close your shield; only you may open it (§5)");
      const ended = revokeAfter(w, r.target); w.presenceDirty = true; return { ok: true, recorded: false, of: r.target, ...(ended.length ? { ended } : {}), table: C.tableOf(P, r.target) }; }
    const t = C.tableOf(P, actor);
    return { ok: true, table: { preset: t.preset, strangers: t.strangers, friends: t.friends, paused: t.paused, trusted: t.friendsList }, asks: Object.values(P.asks ?? {}).filter((k) => k.to === actor),
      attempts: (P.ring ?? []).filter((r) => r.to === actor).slice(-10) }; },
  // one shape for every act on a body (42 §4.4): pose, anim, shove, drag. Waits for nothing in the lab; says what happened.
  body(w, actor, a) { const me = body(w, actor); const to = bodyRef(a.to); expireAsks(w);
    if (!["pose", "anim", "shove", "drag", "seat", "carry"].includes(a.kind)) refuse("shape", `no body kind '${a.kind}'`, "body {to, kind: pose|anim|shove|drag|seat|carry}");
    const t = w.presence.bodies[to]; if (t && ["shove", "drag", "carry"].includes(a.kind) && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer");
    const g = bodyGate(w, actor, to, a.kind, { spec: a.spec, why: a.why });
    if (!g.ok) refuse(g.code, g.reason, g.fix, { class: g.class });
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false, note: `${to} was asked; no answer in 20 s is no` };
    g.deliver(); return { ok: true, outcome: "allowed", delivered: true, consent: g.consent, recorded: false }; },
  // touch is judged by where the hand IS (42 P8): a named point, or a bare world point at someone's body
  reach(w, actor, a) { const me = body(w, actor); const P = w.presence; let to, cls, point = a.point ?? null; expireAsks(w);
    if (Array.isArray(a.at)) { if (a.at.length !== 3 || a.at.some((n) => !Number.isFinite(n))) refuse("shape", "at: [x, y, z]", "");
      for (const [k, b] of Object.entries(P.bodies)) { if (k === actor) continue; const c = C.pointClass(b.at, a.at); if (c) { to = k; cls = c; break; } }
      if (dist(handOf(me), a.at) > REACH) refuse("out-of-reach", `that point is ${r3(dist(handOf(me), a.at))} m from your hand`, "walk closer");
      if (!to) { (P.reaches ??= {})[actor] = { at: a.at.slice() }; w.presenceDirty = true; return { ok: true, touching: null, recorded: false }; } }
    else { to = bodyRef(a.who); if (!to || !point) refuse("shape", "reach {who, point} or {at: [x, y, z]}", "points: " + [...C.SOCIAL_POINTS, ...C.INTIMATE_POINTS].join(", "));
      cls = C.INTIMATE_POINTS.has(point) ? "intimate" : C.SOCIAL_POINTS.has(point) ? "touch" : refuse("shape", `no point '${point}'`, [...C.SOCIAL_POINTS, ...C.INTIMATE_POINTS].join(", "));
      const t = P.bodies[to]; if (t && dist(me.at, t.at) > BODY_REACH) refuse("out-of-reach", `${to} is ${r3(dist(me.at, t.at))} m away`, "walk closer"); }
    delete P.reaches?.[actor];
    const g = bodyGate(w, actor, to, "touch", { cls, spec: { point, ...(a.at ? { at: a.at } : {}) }, why: a.why });
    if (!g.ok) { w.presenceDirty = true; refuse(g.code, g.reason, g.fix, { class: g.class, stripped: true }); }
    if (g.asked) return { ok: true, outcome: "asked", ask: g.ask, delivered: false };
    g.deliver(); return { ok: true, outcome: "allowed", touching: to, class: cls, recorded: false }; },
  inbox(w, actor) { const P = w.presence; expireAsks(w); const m = P.inbox?.[actor] ?? []; if (P.inbox) delete P.inbox[actor]; w.presenceDirty = true; return { ok: true, messages: m }; },
};
// ---------- acting on a person (research roles §6) ----------
const WARN_OR_MOD = (st, who) => modHolder(st, who) || roleOf(st, who) === "owner";
const reasonOf = (a) => (typeof a.reason === "string" && a.reason.trim() ? { reason: a.reason.slice(0, R.REASON_MAX) } : {});
/** A duration in minutes → until (the authority's ms). Capped below owner at `cap` (an owner may go past it only when ownerCap is false). */
function minutesUntil(w, actor, minutes, { cap, what, required = false, ownerCap = false }) {
  if (minutes === undefined) { if (required) refuse("shape", `${what} needs minutes (how long)`, `e.g. minutes: 5, 60 or 1440 (at most ${cap})`); return undefined; }
  if (!(typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0)) refuse("shape", `${what}: minutes is a number above 0`, "");
  if (minutes > cap && (ownerCap || roleOf(w.state(), actor) !== "owner")) refuse("bounds", `${what} lasts at most ${cap} minutes${ownerCap ? "" : " (owners may go longer)"}`, `minutes: ${cap} or less`);
  return Math.floor(w.now() + minutes * 60000);
}
/** The rule every person-act shares: the switch (one of `powers`), an identity, someone ranked strictly below you.
 *  Returns {target: {role, rank}} for the reply. `noOwner`: this act refuses owners outright, with today's words. */
function personAct(w, actor, a, verb, powers, { noOwner } = {}) {
  const st = w.state();
  if (!isIdentity(a.who)) refuse("shape", `${verb} {who}: an identity (u-…); whois {name} finds it`, "", {});
  const me = effective(st, actor);
  if (!powers.some((k) => me.can[k])) refuse("rights", `${verb === "ban" ? "banning" : verb === "kick" ? "kicking" : verb === "ghost" ? "ghosting someone" : verb === "warn" ? "warning someone" : "muting someone"} needs ${powers.length > 1 ? `one of ${powers.join(", ")}` : powers[0]}; you are ${me.role}`, "ask a moderator or an owner", { needs: powers.join("|") });
  if (a.who === actor) refuse("rank", `you can't ${verb} yourself`, "");
  const them = roleOf(st, a.who, CTX.isAnon(a.who));
  if (noOwner && them === "owner") refuse("rights", `${said(a.who)} is an owner here; an owner can't be ${noOwner}`, "an owner made after them can be demoted first (roles:<them>); then act");
  const tr = rankOf(st, a.who, CTX.isAnon(a.who));
  if (tr >= me.rank) refuse("rank", `${said(a.who)} is ${R.roleDef(wcOf(st), them)?.name ?? them}; you (${me.name}) can't act on equal or higher ranks`, "ask someone ranked above them", { needs: "rank" });
  if (a.reason !== undefined && (typeof a.reason !== "string" || a.reason.length > R.REASON_MAX)) refuse("shape", `reason is text, up to ${R.REASON_MAX} characters`, "");
  return { target: { role: them, rank: tr } };
}
/** Lifting a sanction (unban, unmute, unghost): the permission, and the record's rule: an owner, its author, or someone
 *  who outranks its author (strict: unban, unmute) or stands at their rank or above (ghost: "lifted only at that rank or higher"). */
function personLift(w, actor, a, verb, recs, { strict, power = verb }) {
  const st = w.state(); if (!isIdentity(a.who)) refuse("shape", `un${verb} {who}`, "");
  if (!may(st, actor, power) && roleOf(st, actor) !== "owner") refuse("rights", `lifting a ${verb} needs ${power}; you are ${roleOf(st, actor)}`, "ask a moderator or an owner", { needs: power });
  if (a.who === actor) refuse("rank", `you can't lift a ${verb} on yourself`, "ask someone ranked above whoever made it");   // review 10-07
  // a lift ends every record of its kind in force, so it must be allowed over each one (stacked sanctions: review 10-07)
  for (const rec of (Array.isArray(recs) ? recs : recs ? [recs] : [])) {
  if (roleOf(st, actor) === "owner" || rec.actor === actor) continue;
  const mine = rankOf(st, actor), theirs = rankOf(st, rec.actor);
  if (strict ? mine <= theirs : mine < theirs) refuse("rank", `${said(rec.actor)} (${roleOf(st, rec.actor)}) made this ${verb}; only they, an owner${strict ? ", or someone who outranks them" : ", or someone at their rank or above"} may lift it`, `ask ${said(rec.actor)} or an owner`, { by: rec.actor });
  }
}
const VERBS = {
  ...PHYSICS_VERBS,
  ...BODY_VERBS,
  "create-world"(w, actor, a) {
    if (w.exists) refuse("exists", `world '${w.name}' exists`, "you're in it already: look shows what's here; help shows your role");
    if (a.dry) return { ok: true, dry: true, would: { found: w.name, you: "owner", title: a.title ?? w.name } };
    // a fork or a reset names the world it came from; that's provenance in the founding act, so its shape is checked
    // a FORK names its parent with the seq it was copied at ({world, seq, head}): that's genesis.parent, part of the new
    // world's id, the merge base a later merge folds from (PROTOCOL §13; review 10-07 H5). A reset names its predecessor
    // without a seq: provenance in the founding act only (it copies nothing, so it has no merge base)
    if (a.from !== undefined) { const f = a.from, hex = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
      if (!f || typeof f !== "object" || !(typeof f.world === "string" && /^sha256:[0-9a-f]{64}$/.test(f.world)) || !hex(f.head) || (f.name !== undefined && typeof f.name !== "string") || (f.seq !== undefined && !(Number.isInteger(f.seq) && f.seq >= 0)) || Object.keys(f).some((k) => !["world", "head", "name", "seq"].includes(k)))
        refuse("shape", "create-world {from} names the world it came from: {world: sha256:<64 hex>, head: <64 hex>, seq? (a fork: the seq it was copied at), name?}", ""); }
    // genesis seeds no state (§13): it names the governance keys. The founding act then writes @world, once.
    // {dialect, v, minor, nonce (16 random bytes), owners: tiers of keys, sequencer}. Tier 0 is the founder's OWN key when
    // they bring one (ownerKey: made on their machine; this server never holds its private half); the operator's custody
    // key is tier 1. Without one tier 0 stays empty, and under §13's add-key rule (GOV-5) it can never be filled later:
    // the operator is then the world's top governance key. rewind_window is left at its default (1000 change entries).
    if (a.ownerKey !== undefined && !keyOk(a.ownerKey)) refuse("shape", "ownerKey is your own governance key: ed25519:<base64url of 32 bytes> (PROTOCOL §13)", "make one on your own machine (openssl genpkey -algorithm ed25519; PROTOCOL §13, \"Whose key is tier 0\"); or leave ownerKey out");
    const cu = w.custody(); if (!cu) throw new Error("authority bug: founding needs io.custody (the sequencer and founder keys, §13)");
    if (a.ownerKey !== undefined && (a.ownerKey === cu.operator() || a.ownerKey === cu.sequencer())) refuse("shape", "ownerKey must be your own key, not this server's", "");
    w.append({ kind: "genesis", actor: "system", verb: "genesis", body: { dialect: DIALECT, v: VERSION, minor: 0, nonce: nonce16(w), owners: [a.ownerKey ? [a.ownerKey] : [], [cu.operator()]], sequencer: cu.sequencer(),
      ...(a.from?.seq !== undefined ? { parent: { world: a.from.world, seq: a.from.seq, head: a.from.head } } : {}) } });
    const ops = [setOp("@world", "about", { name: a.title ?? w.name, text: a.text ?? "" }), setOp("@world", "bounds", { min: [-20, 0, -20], max: [20, 12, 20] }),
      setOp("@world", `roles:${actor}`, { role: "owner" })];
    const plan = admit(w, w.state(), { actor, cap: { kind: "founding", ids: ["@world"], comps: ops.map((o) => o.comp) } }, ops);
    changeEntry(w, plan, w.append(actOf(w, actor, "create-world", a)));
    return { ok: true, world: w.name, you: "owner", ...(a.ownerKey ? {} : { governance: "tier 0 is empty: this server's operator key is the world's top governance key (PROTOCOL §13). Founding with ownerKey (your own ed25519 key) puts you there instead; tier 0 can't be filled later" }) };
  },
  help(w, actor, a) {
    if (a?.verb) return verbHelp(a.verb) ? { ok: true, ...verbHelp(a.verb) } : { ok: false, refused: { code: "no-detail", reason: `no detailed help for '${a.verb}' yet`, fix: `detailed: ${Object.keys(VERBSPEC).join(", ")}` } };
    const st = w.exists ? w.state() : null; const role = st ? roleOf(st, actor) : "none"; const eff = st ? effective(st, actor) : null;
    return { ok: true, world: st?.entities?.["@world"]?.c.about, you: { id: actor, role, ...(eff ? { rank: eff.rank, permissions: eff.permissions } : {}) },
      verbs: { read: ["look", "inspect {id}", "measure {id}", "find {kind: 'model'|'blueprint', query?}", "lint {id?}", "history {id?, limit?, before?, after?, verbs?}", "schema {component?}"],
        world: ["create-world {title, text?} — found this world if it doesn't exist (you become its owner)"],
        write: ["create {id?, model?, components?} | {from: <blueprint hash | a thing to duplicate>, id?, at?}", "set {id, component, value, merge?}", "delete {id} | {id, component}",
          "place {id, on|beside|hang|against|near|at, facing?, height?, along?, level?, offset?, side?, gap?, attach?}", "turn {id, axis, deg, space?: object|parent|world, about?: pivot|origin}", "batch {ops: [{verb, args}…], label?}", "use {id, action?, args?}", "say {text, to?}",
          "undo {label?|act?}: a bare undo takes back your latest change (a redo first); the reply names what it undid", "publish {from, name}", "update {copy, to, resolve?}"],
        people: ["warn {who, reason}", "mute {who, minutes, channels?: ['voice','chat'], reason?} / unmute {who}", "kick {who, minutes?, reason?} (default 10, ≤ 60)", "ban {who, days?, reason?} (≤ 30 days below owner; owners: leave days out for until lifted) / unban {who}",
          "ghost {on} (you: unseen, no interaction or chat) | ghost {who, minutes, reason?} / unghost {who}", "modlog {who?, before?, limit?}", "bans {}", "who may: your permissions (you.permissions); act only on ranks below yours"],
        scripts: ["upload {text} → src (JavaScript; docs/SCRIPTS.md)", "set {id, component: 'script:<name>', value: {src, scope, on, every?, knobs?}}", "scripts {id?} — what runs here and why not", "scripts {id, script, test: {on: 'use'}} — a dry run", "adopt {id, script, base?} — become a dormant script's sponsor"],
        body: ["move {to: [x, y, z]}", "grab {id, hand?, grip?}", "put {id, pos?}", "throw {id, v: [x, y, z], pos?}", "drop {id, pos?, hand?}", "use {id} while holding it: its grabbable.use (args {phase: 'up'} for the release)", "punt {id, power? | v?}", "leave", "wait"],
        physics: "the world runs physics when @world has a physics-engine component: set {id: '@world', component: 'physics-engine', value: {engine: 'eidosim@1.0.0'}} (owner). A thing can be picked up when it has a grabbable component (schema {component: 'grabbable'}: who may, grips, where it goes when let go, use while held), or physics {kind: 'dynamic', who?}. Grabbable makes it carryable; physics makes it fall", every_write: "may add dry: true to preview, expect: [{id, component, value?}] to be refused (code changed) if any of those isn't what you started from, and throughLock: true to act through a lock you may remove (§7: a lock stops accidents and binds everyone, its locker included)", details: "help {verb: 'place'} (or create, set, delete, use, grab, put, throw, punt) shows every argument with its type and an example" },
      world: st?.entities?.["@world"]?.c.about ?? { name: w.name } };
  },
  look(w, actor, a) {
    const st = w.state(); const ids = Object.keys(st.entities).filter((k) => k !== "@world" && !st.entities[k].c.parent);
    const lim = a.limit ?? 40;
    const live = livePoses(w.sim());
    // the tree in the same order as ever, through the index's children map; only what's shown is described (review 10-06:
    // a child scan per node and a description of every thing made look O(N²) on a big world)
    // a socket is listed with its host (describe's sockets), not as a thing; what sits in it shows at its place
    const kids = kidsMap(st); const order = []; const tree = (id, d, n = 0) => { if (n > 64) return; const sock = isSocketC(st.entities[id]?.c); if (!sock) order.push([id, d]); for (const k of kids.get(id) ?? []) tree(k, sock ? d : d + 1, n + 1); };
    ids.forEach((id) => tree(id, 0));
    const all = order.slice(0, lim).map(([id, d]) => ({ ...describe(st, id, live, w.presence.holds), depth: d })); const total = order.length;
    // a ghost's body is unseen by everyone else (review 10-07)
    const P = w.presence; const bodies = Object.entries(P.bodies).filter(([id]) => id === actor || !ghostOf(w, id)).map(([id, b]) => ({ id, at: b.at, shield: shieldOf(P, id),
      ...(b.poseBy ? { posedBy: b.poseBy } : {}), ...(b.draggedBy ? { draggedBy: b.draggedBy } : {}), touchedBy: Object.entries(P.reaches ?? {}).filter(([, r]) => r.to === id).map(([k]) => k) }));
    return { ok: true, things: all.slice(0, lim), ...(total > lim ? { truncated: true, total } : {}), bodies };
  },
  inspect(w, actor, a) {
    const st = w.state(); const e = st.entities[a.id];
    if (!e) return { ok: false, refused: { code: "not-found", reason: `no '${a.id}'`, didYouMean: guess(String(a.id), Object.keys(st.entities)) } };
    const piv = e.c.motion?.type === "pendulum" ? pivotOf(st, a.id) : undefined;
    return { ok: true, ...describe(st, a.id, livePoses(w.sim()), w.presence.holds, { full: true }), born: e.born, components: e.c, versions: Object.fromEntries(Object.keys(e.c).map((k) => [k, versionOf(w, lastTouch(w, a.id, k)?.seq)])), touched: touchedOf(w, a.id, Object.keys(e.c)), world: worldT(st, a.id),
      derived: { madeBy: madeBy(w, a.id), ...(piv !== undefined ? { pivot: piv } : {}), ...(modelOf(e.c.model)?.credits ? { asset: modelOf(e.c.model).credits } : {}) },
      children: Object.keys(st.entities).filter((k) => st.entities[k].c.parent?.to === a.id), ...offersFor(st, a.id, actor), yourRole: roleOf(st, actor) };
  },
  measure(w, actor, a) {
    const st = w.state(); const b = aabb(st, a.id); if (!b) return { ok: false, refused: { code: "no-model", reason: `${a.id} has no model or mesh to measure` } };
    const t = worldT(st, a.id);
    return { ok: true, id: a.id, bounds: { min: b.min.map(r3), max: b.max.map(r3) }, size: b.max.map((v, i) => r3(v - b.min[i])),
      front: qrot(t.q, [0, 0, 1]).map(r3), surfaces: surfacesOf(st, a.id).map((s) => ({ level: s.level, y: r3(s.y), size: [r3(s.max[0] - s.min[0]), r3(s.max[1] - s.min[1])] })) };
  },
  find(w, actor, a) {
    const q = (a.query ?? "").toLowerCase();
    if (a.kind === "blueprint") { const lib = w.state().entities["@world"]?.c ?? {};
      return { ok: true, blueprints: Object.entries(lib).filter(([k]) => k.startsWith(BLUEPRINTS)).map(([k, v]) => ({ hash: `sha256:${k.slice(BLUEPRINTS.length)}`, ...v, by: creatorOf(w, "@world", k)?.rights ?? null })).filter((b) => String(b.name ?? "").toLowerCase().includes(q)) }; }
    return { ok: true, models: CTX.cat.list(q).slice(0, 50).map(([k, m]) => ({ model: k, ...(m.size ? { size: m.size } : { size: null, note: "not measured here" }), about: m.label, surfaces: (m.surfaces ?? []).map((s) => s.y), ...(modelSocketNames(m) ? { seats: modelSocketNames(m) } : {}) })) };
  },
  lint(w, actor, a) { const st = w.state(); return { ok: true, warnings: warnings(st, a.id ? [a.id] : Object.keys(st.entities), true) }; },
  history(w, actor, a) {
    // one thing's history, newest first, paged backwards (R 10-04: recent by default, deeper on request): before = the seq
    // to continue from (the reply's `next`), limit = how many acts per page
    if (a.id != null) {
      if (a.verbs !== undefined || a.after !== undefined) refuse("shape", "one thing's history pages back with before only", "leave id out to filter the whole log by verbs, or page it with after");
      const id = String(a.id); const lim = Math.max(1, Math.min(50, a.limit ?? 5)); const before = a.before ?? Infinity; const out = [];
      let next = null;
      for (const i of backward(w, id)) { if (i >= before) continue; const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
        const ops = opsTouching(e, id); if (!ops.length) continue;
        if (out.length === lim) { next = out.at(-1).seq; break; }
        const act = Number.isInteger(e.cause) ? w.entries[e.cause] : null;
        // an imported act reads as what it was (spawn, place, comp), never "imported" (batch 2: Credits in History)
        out.push({ seq: i, by: e.actor, who: said(e.actor), ts: e.ts, verb: (isE(act) && act.kind === "act" ? (act.verb === "imported" && typeof act.body?.verb === "string" ? act.body.verb : act.verb) : null) ?? ops[0].verb,
          changed: [...new Set(ops.map((o) => o.verb === "create" ? "(created)" : o.verb === "delete" && o.comp === undefined ? "(deleted)" : o.comp))],
          ...(() => { const d = historyDiff(w, id, i, ops); return d ? { diff: d } : {}; })(),
          ...(isE(act) && act.body?.undoes !== undefined ? { undoes: act.body.undoes } : {}), ...(Number.isInteger(e.cause) ? { act: e.cause } : {}) }); }
      return { ok: true, id, entries: out, ...(next !== null ? { next, more: "send the same with before: next for older" } : {}) };
    }
    // the whole world's log, a page at a time (Commons audit, agents #3: `verbs` and `before` reached nobody). verbs
    // matches an entry's verb or kind, and an imported act's original verb (its body names it); before/after page by seq
    if (a.verbs !== undefined && !(Array.isArray(a.verbs) && a.verbs.length <= 32 && a.verbs.every((v) => typeof v === "string"))) refuse("shape", "verbs is a list of verb names (at most 32)", "e.g. history {verbs: ['set', 'use']} — an imported entry matches its original verb too ('comp', 'mount')");
    if (a.before !== undefined && a.after !== undefined) refuse("shape", "page one way: before or after, not both", "before: older than that seq (the reply's next); after: newer than it");
    const lim = Math.max(1, Math.min(200, a.limit ?? 12)); const vs = a.verbs?.length ? new Set(a.verbs) : null;   // [] = no filter
    const ghost = !!ghostOf(w, actor); // a ghost can't read chat (PLAN 10-06): says leave the page
    const match0 = (e) => !vs || !isE(e) ? !vs : vs.has(e.verb) || vs.has(e.kind) || (e.verb === "imported" && vs.has(e.body?.verb));
    const match = (e) => match0(e) && !(ghost && isE(e) && e.kind === "say");
    const row = (e, seq) => isE(e) ? { seq, actor: e.actor, ts: e.ts, kind: e.kind, verb: e.verb, ...(e.cause !== undefined ? { cause: e.cause } : {}), body: e.kind === "act" || e.kind === "say" ? e.body : JSON.stringify(e.body).slice(0, 160) } : { seq, malformed: e.code };
    const out = []; let more = false;
    if (a.after !== undefined) { for (let i = Math.max(0, a.after + 1); i < w.entries.length; i++) { if (!match(w.entries[i])) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } }
    else { for (let i = Math.min(w.entries.length, a.before ?? Infinity) - 1; i >= 0; i--) { if (!match(w.entries[i])) continue; if (out.length === lim) { more = true; break; } out.push(row(w.entries[i], i)); } out.reverse(); }
    return { ok: true, entries: out, ...(more ? a.after !== undefined ? { next: out.at(-1).seq, more: "send after: next for newer" } : { next: out[0].seq, more: "send before: next for older" } : {}) }; },
  // particles names an effect: its schema also lists the Essentials and each one's params (the knobs an instance sets), so
  // an agent can write one without a second question; effect {name} returns a whole document
  schema(w, actor, a) { return { ok: true, components: a.component ? { [a.component]: COMPONENTS[a.component] } : COMPONENTS,
    ...(a.component === "particles" ? { effects: Object.fromEntries(ESSENTIAL_NAMES.map((k) => { const d = effectFor(k); return [k, { reads: d.reads, params: Object.fromEntries(Object.entries(d.params ?? {}).map(([n, p]) => [n, { type: p.type, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.values ? { values: p.values } : {}), ...(p.help ? { help: p.help } : {}) }])) }]; })) } : {}) }; },
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
    if (probe.presence) {
      // a seat is presence (nothing recorded), but the authority keeps who sits where: a thing someone sits on, or anything
      // carrying it, isn't kicked, shoved, grabbed or thrown out from under them (occupant)
      if (probe.attach?.to) setSeat(w, actor, probe.attach.to);
      return { ok: true, recorded: false, ...(probe.attach ? { attach: probe.attach } : {}), note: probe.note };   // attach: where your frames now say you are
    }
    if (probe.script) { // L7 (41 §3.6): the visitor's use is ITS act, on its own rate; the behaviour runs with its sponsor's rights
      const key = `script:${probe.script}`; const v = w.state().entities[a.id].c[key];
      if (!v || typeof v !== "object") { const wc = w.state().entities["@world"]?.c ?? {};
        // an imported world: the reaction names an old binding (@world imported-behavior:<name>), which the authority never runs
        // (a binding there, or the handler itself written by the translation: its cause is an `imported` act)
        const old = Object.entries(wc).find(([k, b]) => k.startsWith("imported-behavior:") && (k === `imported-behavior:${probe.script}` || b?.attach === a.id));
        const lt = lastTouch(w, a.id, "reactions"); const ce = lt ? w.entries[w.entries[lt.seq]?.cause] : null;
        if (old || (isE(ce) && ce.kind === "act" && ce.verb === "imported"))
          refuse("no-runtime", `${a.id}'s '${probe.action}' runs the imported behaviour '${old ? old[0].slice("imported-behavior:".length) : probe.script}', carried by translation; the authority doesn't run the old script API`, `re-install it as script:${probe.script} on ${a.id} (docs/SCRIPTS.md); scripts lists imported behaviours as needs-reinstall`);
        refuse("no-handler", `${a.id}'s '${probe.action}' runs ${key}, which isn't installed on it`, "scripts {id} lists what runs here"); }
      const ev = { on: "use", action: probe.action, ...(a.args !== undefined ? { args: a.args } : {}), ...(held ?? {}) };
      if (a.dry) return { ok: true, dry: true, script: activate(w, a.id, probe.script, { ...ev, by: actor, dry: true }) };
      rateCheck(w, actor); const act = w.append(actOf(w, actor, "use", sent, { runs: key, ...(held ? { held, action: probe.action } : {}) }));
      return { ok: true, act, recorded: true, ...(held ? { held } : {}), script: activate(w, a.id, probe.script, { ...ev, by: actor, seq: act, cause: act }) };
    }
    return commit(w, actor, "use", sent, (ctx) => { const ops = buildUse(ctx, a); if (held) ctx.actExtra = { ...(ctx.actExtra ?? {}), held, action: a.action }; return ops; });
  },
  // moderation (§2.1): a separate log, enforced by the authority; never a world entry. Research roles §5–6: every act on a
  // person needs its permission and a target ranked strictly below you (never yourself, never your equal, never an owner);
  // its duration is capped below owner; its record names identities. Expiry is the authority's clock (sanction views above).
  warn: (w, actor, a) => { const t = personAct(w, actor, a, "warn", R.WARN_POWERS);
    if (typeof a.reason !== "string" || !a.reason.trim()) refuse("shape", "warn {who, reason}: a warning says why", "e.g. warn {who, reason: 'please keep it friendly'}");
    w.appendMod({ actor, verb: "warn", who: a.who, reason: a.reason.slice(0, R.REASON_MAX) }); return { ok: true, warned: a.who, ...t, logged: "moderator log" }; },
  mute: (w, actor, a) => { const t = personAct(w, actor, a, "mute", ["mute"]);
    const ch = a.channels ?? ["voice", "chat"];
    if (!Array.isArray(ch) || !ch.length || ch.some((c) => c !== "voice" && c !== "chat") || new Set(ch).size !== ch.length) refuse("shape", "mute.channels is ['voice'], ['chat'] or both", "leave it out for both");
    const until = minutesUntil(w, actor, a.minutes, { cap: R.MUTE_MAX_MIN, what: "a mute", required: true });
    w.appendMod({ actor, verb: "mute", who: a.who, channels: ch, until, ...reasonOf(a) }); return { ok: true, muted: a.who, channels: ch, until, ...t, logged: "moderator log" }; },
  unmute: (w, actor, a) => { personLift(w, actor, a, "mute", inForceOf(w, a.who, "mute"), { strict: true });
    w.appendMod({ actor, verb: "unmute", who: a.who }); return { ok: true, unmuted: a.who }; },
  // a kick removes a live session now (the authority's server does the removing on this reply); they may come back after
  // `minutes` (default 10, at most 60: VRChat's kick is a one-hour bar)
  kick: (w, actor, a) => { const t = personAct(w, actor, a, "kick", ["kick"], { noOwner: "kicked" });
    const until = minutesUntil(w, actor, a.minutes ?? R.KICK_DEFAULT_MIN, { cap: R.KICK_MAX_MIN, what: "a kick's cooldown", ownerCap: true });
    w.appendMod({ actor, verb: "kick", who: a.who, until, ...reasonOf(a) }); return { ok: true, kicked: a.who, until, ...t, logged: "moderator log" }; },
  ban: (w, actor, a) => { const t = personAct(w, actor, a, "ban", ["ban"], { noOwner: "banned" });
    const owner = roleOf(w.state(), actor) === "owner";
    if (a.days === undefined && !owner) refuse("rights", `a ban with no end needs an owner; you may ban for up to ${R.MOD_BAN_MAX_DAYS} days`, `ban {who, days: 1|7|${R.MOD_BAN_MAX_DAYS}, reason}`, { needs: "owner" });
    if (a.days !== undefined && !(typeof a.days === "number" && a.days > 0 && a.days <= 3650)) refuse("shape", "ban.days is a number of days (more than 0)", "leave it out (owners) for a ban until lifted");
    if (a.days !== undefined && a.days > R.MOD_BAN_MAX_DAYS && !owner) refuse("rights", `a ban longer than ${R.MOD_BAN_MAX_DAYS} days needs an owner`, `ban for ${R.MOD_BAN_MAX_DAYS} days or less, or ask an owner`, { needs: "owner" });
    const until = a.days === undefined ? undefined : Math.floor(w.now() + a.days * 86400000);
    w.appendMod({ actor, verb: "ban", who: a.who, ...(until !== undefined ? { until } : {}), ...reasonOf(a) }); return { ok: true, banned: a.who, ...(until !== undefined ? { until } : { until: null }), ...t, logged: "moderator log" }; },
  unban: (w, actor, a) => { if (!isIdentity(a.who)) refuse("shape", "unban {who}", "");
    personLift(w, actor, a, "ban", [...inForceOf(w, a.who, "ban"), ...inForceOf(w, a.who, "kick")], { strict: true });
    w.appendMod({ actor, verb: "unban", who: a.who }); return { ok: true, unbanned: a.who }; },
  // ghost (PLAN 10-06): `ghost {on}` with no who is the mode you choose (presence: never logged; spectate);
  // `ghost {who, minutes?, reason}` is a sanction (kick holders, on a rank below; capped like a mute below owner)
  ghost: (w, actor, a) => {
    if (a.who === undefined || a.who === actor) { if (typeof a.on !== "boolean") refuse("shape", "ghost {on: true|false}: become a ghost here (unseen; you can't interact or talk), or come back", "or ghost {who, minutes, reason} to ghost someone (kick holders)");
      if (!a.on && inForceOf(w, actor, "ghost").length) refuse("ghost", "you were made a ghost by a moderator; that isn't yours to end", "a moderator ranked at or above them can bring you back");
      const G = (w.presence.ghosts ??= {}); if (a.on) G[actor] = { ts: Math.floor(w.now()) }; else delete G[actor]; w.presenceDirty = true;
      return { ok: true, ghost: a.on, chosen: true, recorded: false }; }
    const t = personAct(w, actor, a, "ghost", ["kick"], { noOwner: "made a ghost" });
    const owner = roleOf(w.state(), actor) === "owner";
    const until = a.minutes === undefined && owner ? undefined : minutesUntil(w, actor, a.minutes, { cap: R.MUTE_MAX_MIN, what: "a ghost sanction", required: true });
    w.appendMod({ actor, verb: "ghost", who: a.who, ...(until !== undefined ? { until } : {}), ...reasonOf(a) }); return { ok: true, ghosted: a.who, until: until ?? null, ...t, logged: "moderator log" }; },
  unghost: (w, actor, a) => {
    personLift(w, actor, a, "ghost", inForceOf(w, a.who, "ghost"), { strict: false, power: "kick" });
    w.appendMod({ actor, verb: "unghost", who: a.who }); return { ok: true, unghosted: a.who }; },
  // the moderation log (research: read by anyone holding a moderation power): newest first, merged with role changes
  // from the world log (roles:* writes, read-only) and the authority's automatic cool-downs
  modlog: (w, actor, a) => { const st = w.state(); if (!modHolder(st, actor) && roleOf(st, actor) !== "owner") refuse("rights", "the moderation log is for people who hold a moderation power (mute, kick, ban or pauseScripts)", "ask a moderator", { needs: "mute|kick|ban|pauseScripts" });
    const lim = Math.max(1, Math.min(200, a.limit ?? 50)); const before = a.before ?? Infinity;
    const rows = w.mod.map((m, i) => ({ ...m, at: i, src: "mod" }));
    for (let i = 0; i < w.entries.length; i++) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
      for (const o of opsQuiet(e)) if (o.id === "@world" && String(o.comp ?? "").startsWith("roles:")) rows.push({ ts: e.ts, actor: entryBy(w, e).by, verb: "role", who: o.comp.slice(6), role: o.verb === "delete" ? null : o.value?.role ?? null, ...(o.value?.can ? { can: o.value.can } : {}), seq: i, src: "log" }); }
    const out = rows.filter((r) => (a.who === undefined || r.who === a.who) && r.ts < before).sort((x, y) => y.ts - x.ts || (y.at ?? y.seq) - (x.at ?? x.seq)).slice(0, lim)
      .map((r) => ({ ...r, by: said(r.actor), name: typeof r.who === "string" ? said(r.who) : undefined, ...(r.until !== undefined ? { inForce: r.until > w.now() } : {}) }));
    return { ok: true, records: out, ...(out.length === lim ? { next: out.at(-1).ts, more: "send before: next for older" } : {}) }; },
  bans: (w, actor) => { const st = w.state(); if (!modHolder(st, actor) && roleOf(st, actor) !== "owner") refuse("rights", "the ban list is for people who hold a moderation power", "ask a moderator", { needs: "mute|kick|ban|pauseScripts" });
    const byName = (m) => (m && m.actor ? { ...m, by: said(m.actor) } : m);   // the author by name: the asker's page may not know an absent moderator
    const now = Object.entries(sanctionsNow(w)).map(([who, x]) => ({ who, name: said(who), role: roleOf(st, who), ...Object.fromEntries(Object.entries(x).map(([k, m]) => [k, byName(m)])) }));
    const ended = []; const seen = new Set(); for (let i = w.mod.length - 1; i >= 0; i--) { const m = w.mod[i]; if (m.verb !== "ban" || seen.has(m.who)) continue; seen.add(m.who); if (!banOf(w, m.who)) ended.push({ ...byName(m), name: said(m.who) }); }
    return { ok: true, now, ended: ended.slice(0, 100) }; },
  say(w, actor, a) { if (!a.text) refuse("shape", "say needs text", "");
    // a chat mute refuses every say: a say with `to` is still a public line in the log (review 10-07). Asking a moderator
    // why goes as a WHISPER (point-to-point, never logged; the server lets a muted person whisper moderators only)
    { const m = muteOf(w, actor, "chat"); if (m)
      refuse("muted", `you're muted in this world's chat${m.until !== undefined ? ` until ${new Date(m.until).toISOString()}` : ""}${m.reason ? ` (${m.reason})` : ""}`, "you may still whisper to a moderator (/w <name>)", { until: m.until ?? null }); }
    if (typeof a.text !== "string" || a.text.length > SAY_MAX) refuse("too-big", `a say is at most ${SAY_MAX} characters (this one is ${String(a.text).length})`, "split it, or put a long text in a blob");
    rateCheck(w, actor, "say", a.text.length); const seq = w.append({ kind: "say", actor, verb: "say", body: { text: a.text, ...(a.to ? { to: a.to } : {}), ...spokenOf(a, w.now()) } }); (w.sayQ ??= []).push(seq); return { ok: true, seq }; }, // w.append refuses too-big before writing
  undo: (w, actor, a) => commit(w, actor, "undo", a, (ctx) => buildUndo(ctx, a, w)),
  // ---- captions: one line of what a screen said (a captioner bot, live subtitles). Rights live on the SCREEN: its
  // `captioners {ids}` names who may caption it (anyone who may edit the screen may too); nobody else, and no `set` by
  // hand, writes `captions`. The rules are shared/captions.js's: a session, a strictly rising n within it, a leg
  // generation (the server stamps `gen` from the connection: a superseded captioner can't write over its successor),
  // and `end` to clear the screen. The bag keeps the newest lines (CAPTIONS_MAX_LINES). ----
  caption: (w, actor, a) => commit(w, actor, "caption", a, (ctx) => {
    const n = normalizeCaptionArgs(a); if (!n.ok) refuse("shape", n.why, "caption {id, session, n, t0, t1, text, speaker?, title?} | {id, session, end: true}");
    const id = n.args.id; const e = ctx.st.entities[id]; if (!e) refuse("no-such", `nothing here called ${id}`, "look lists what's here");
    const args = { ...n.args, gen: Number.isSafeInteger(a.gen) && a.gen >= 0 ? a.gen : 0 };
    const why = captionRefusal(e.c.captions, args); if (why) refuse("caption", why, "a resend of a line already written is refused: read that as its receipt");
    ctx.cap = { kind: "caption", ids: [id], comps: ["captions"] };
    const next = foldCaption(e.c.captions, args);
    return [next ? setOp(id, "captions", next) : delOp(id, "captions")];
  }),
  // ---- scripts (research 41) ----
  // a script's source is a blob (§2.2): stored once by its hash; not world state, so not logged. Hygiene and syntax are
  // checked here (to teach early) and again at install (what binds).
  upload(w, actor, a) {
    if (a.effect !== undefined) return uploadEffect(w, actor, a);
    if (!may(w.state(), actor, "scripts")) refuse("rights", `uploading a script needs ${scriptsCfg(w.state()).install === "owner" ? "owner" : "the scripts permission"}; you are ${roleOf(w.state(), actor)}`, "ask the world's owner", { needs: "scripts" });
    if (typeof a.text !== "string") refuse("shape", "upload {text}: the script's JavaScript source", "docs/SCRIPTS.md");
    { const now = w.now(), U = ((w.presence.uploads ??= {})[actor] ??= []).filter((t) => now - t < 60000); w.presence.uploads[actor] = U; // presence: never logged
      if (U.length >= SR.LIMITS.uploads) refuse("rate", `${said(actor)} has uploaded ${U.length} sources in the last minute; at most ${SR.LIMITS.uploads}`, "slow down");
      U.push(now); w.presenceDirty = true; }
    const dirty = SR.hygiene(a.text); if (dirty) refuse(dirty.code, dirty.reason, "refused: reviewers must see what runs");
    const syn = w.scripts?.checkSyntax?.(a.text); if (syn) refuse("syntax", syn.why, "docs/SCRIPTS.md shows the API");
    if (a.dry) return { ok: true, dry: true, note: "it parses and is clean; nothing stored" };
    return { ok: true, src: w.putBlob({ lang: SR.LANG, api: SR.API, text: a.text }), next: "set {id, component: 'script:<name>', value: {src, scope: {ids: 'self', comps: [...]}, on: ['use']}}" };
  },
  // a particle effect document by name (an Essential's, or one stored here): what a renderer draws and an agent reads
  // to know an effect's modules and params. Unlogged; anyone here may read it (it's what every visitor's machine runs)
  effect(w, actor, a) {
    if (typeof a.name !== "string") refuse("shape", "effect {name}: an Essentials name or a stored effect's address (sha256:<64 hex>)", `the Essentials: ${ESSENTIAL_NAMES.join(", ")}`);
    const b = effectBlobName(a.name); let doc = null;
    if (b) { try { doc = w.getBlob(b); } catch { /* below */ } } else doc = effectFor(a.name);
    if (!doc || doc.kind !== EFFECT_KIND) refuse("not-found", `no particle effect ${a.name} here`, `the Essentials: ${ESSENTIAL_NAMES.join(", ")}; upload {effect: {…}} stores one`, b ? undefined : { didYouMean: guess(a.name, ESSENTIAL_NAMES) });
    return { ok: true, name: a.name, effect: doc }; },
  // 41 §3.4: recovery is an explicit, logged adopt: a NEW life of the key (delete + set, one batch), so the adopter becomes
  // its creator and sponsor. §5's key rule decides who may (its creator or an owner); install checks apply with the
  // adopter's rights. `base` (the version inspect gives) makes two racing adopters one winner.
  adopt: (w, actor, a) => commit(w, actor, "adopt", a, (ctx) => { const e = needThing(ctx, a.id); const key = `script:${a.script}`; const v = e.c[key];
    if (!v || typeof v !== "object") refuse("not-found", `${a.id} has no ${key}`, "scripts lists them");
    const lt = lastTouch(w, a.id, key); const base = a.base === undefined ? undefined : versionSeq(w, a.base, "base");
    if (base !== undefined && lt && lt.seq > base) refuse("stale", `${a.id}.${key} changed since version ${base}: ${said(lt.actor)} at ${lt.seq}`, "scripts shows who sponsors it now");
    const was = sponsorOf(w, a.id, key); ctx.actExtra = { adopts: { script: key, was: was?.sponsor ?? null, wasAt: was?.sponsorAt ?? null } }; ctx.refs.add(a.id);
    return [delOp(a.id, key), setOp(a.id, key, v)]; }),
  // the status view (unlogged): every script here, its sponsor and why it does or doesn't run; imported behaviours
  // that need re-installing. With {id, script, test: {on, …}}: a dry run: what it WOULD write, refused or not.
  scripts(w, actor, a) { const st = w.state();
    if (a.test !== undefined) {
      if (!may(st, actor, "build")) refuse("rights", "a dry run needs builder (it spends the authority's time)", "");
      if (!a.test || typeof a.test !== "object" || typeof a.test.on !== "string") refuse("shape", "test is an event {on: 'use'|'tick'|'wake'|'say'|'enter'|'leave'|'changed:<comp>', …}", "e.g. scripts {id: 'bell1', script: 'bell', test: {on: 'use', action: 'ring'}}");
      if (!st.entities[a.id]?.c[`script:${a.script}`]) refuse("not-found", `${a.id} has no script:${a.script}`, "scripts lists them");
      const { cause: _c, dry: _d, ...ev } = a.test; // a test event is the event's own fields; never a cause (depth) of its own
      return { ok: true, dry: true, test: activate(w, a.id, a.script, { by: actor, ...ev, dry: true }) }; }
    return { ok: true, ...scriptsOf(w, st, a.id) }; },
  // the sky panel's two verbs, with the first protocol's meaning (shared/forecast.js foldSkyEntry):
  // `sky` replaces the sky, stamped with the AUTHORITY's clock (hours advance from it); `weather` merges onto the standing
  // sky. The old fold also echoed who and at which seq into the value: derived (the log says so), so never stored here (R8).
  sky: (w, actor, a) => commit(w, actor, "sky", a, (ctx) => buildSky(ctx, a, w)),
  weather: (w, actor, a) => commit(w, actor, "weather", a, (ctx) => buildWeather(ctx, a, w)),
  sculpt: (w, actor, a) => commit(w, actor, "sculpt", a, (ctx) => buildSculpt(ctx, a)),
  batch(w, actor, a) { return commit(w, actor, "batch", a, (ctx) => buildBatch(ctx, a, w)); },
  // a fork's copy of its parent (server/worldlog.ts forkWorld): an ordinary batch through the same gate, logged under its
  // own verb so a reader tells inherited things from births (PROTOCOL §13; review 10-07 H5), and carrying what the parent
  // already holds as it is (an old world's bare invention). Only forkCopy() below reaches it: no request word does.
  "fork-copy"(w, actor, a) {
    if (!CTX.forking) refuse("rights", "fork-copy is the server's own copy of a world into its fork; it isn't a request", "fork a world with the fork request (an owner of the source)");
    return commit(w, actor, "fork-copy", a, (ctx) => buildBatch(ctx, a, w));
  },
};
/** The fork's copy acts (server/worldlog.ts copyInto): the batch request, logged as verb fork-copy. */
export function forkCopy(w, actor, args) { CTX.forking = true; try { return request(w, actor, "fork-copy", args); } finally { CTX.forking = false; } }
function buildBatch(ctx, a, w) { {
      // the next op sees this one's result: ONE working copy for the whole batch, copied per entity as ops touch it (a
      // copy of the world per op made a batch cost its length times the world's size: review 10-06 S0-2). Every view
      // cached on that copy is dropped after each op; per-thing geometry checks what it read (geoOf)
      const all = []; let st = ctx.st; let work = null;
      const forget = (x) => { SPATIAL.delete(x); scriptMemo.delete(x); };
      (a.ops ?? []).forEach((o, i) => {
        if (clockMs() > CTX.work.until) spend(Infinity, `a batch of ${a.ops.length} ops`, "split it into smaller batches");   // the clock backstop
        // sky/weather are sets on @world.sky with the old merge meaning, so they batch like any set (one act, one undo)
        const B = { create: buildCreate, set: buildSet, delete: buildDelete, place: buildPlace,
          sky: (c, x) => buildSky(c, x, w), weather: (c, x) => buildWeather(c, x, w) }[o.verb];
        if (!B) refuse("shape", `batch op ${i}: '${o.verb}' can't go in a batch`, "batch takes create, set, delete, place, sky, weather");
        const sub = { ...ctx, st };
        let ops; try { ops = B(sub, o.args ?? {}); } catch (e) { if (e instanceof Refusal) { e.op = i; } throw e; }
        if (!work) { work = cowState(ctx.st); VOLATILE.add(work.entities); }
        all.push(...ops); st = applyCow(work, ops); forget(st); sub.refs.forEach((r) => ctx.refs.add(r));
        if (sub.cap) ctx.cap = sub.cap;
      });
      return all;
} }
