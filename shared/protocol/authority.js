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
import { MOVER, TRACK, bodyBox, bodyScale, floorStep, sweep, tokensAfter } from "../mover.js";
import { checkSockets, checkSocket, checkStation, inSitReach, SIT_REACH } from "../sockbody.js";
import { DEFAULT_WHO, grabOf, homeOf, checkGrabbable, wantsHome, fitsSocket, socketRadius, pickGrip, offsetOk, describeGrab } from "../grab.js";
import { fold, opsOf, applyOps, cowState, applyCow, checkIJSON, isEntityId, isComponent, isIdentity, jcs, sha256, PURGED, DIALECT, VERSION, keyOk } from "./fold.js";
import { mintId, PERSON_ID, isPlaceholder } from "./ids.js";
import { COMPONENTS, PENDULUM, defOf, registered, baseOf, isNamespaced, materialize, mapRefs, refsOf, refFields, outOfRange, rangeWords, resolveVersioned, statusOf, canonicalName, STATUSES } from "./componentspec.js";
import { validate, verbHelp, VERBSPEC, RESERVED_VERBS } from "./verbspec.js";
import { dec, partSlot } from "./names.js";
import { READ_ONLY, GHOST_OK } from "./verbclasses.js";
import { isRefusalCode } from "./refusalcodes.js";
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
import { instanceProblem, effectFor, effectBlobName, effectProblem, EFFECT_KIND, ESSENTIAL_NAMES, isEssential, LEGACY_FIELDS } from "../particle_effects.js";
import { livePoses, digestOf, restEta, ENGINES, carried, worldPose, TICK_MS, offChain, simCutOf } from "./simlayer.js";
import { shapeRepairOps, shapesMarked, SHAPES_VERSION } from "./shaperepair.js";
import { atWrite } from "./assetref.js";
import { eidoHex } from "../eido.js";
import { trustRefusal } from "../drafts.js";
import { planLaunch } from "./launchplan.js";
import { REACH, HAND_Y, MAX_HELD, KICK, SHOVE, BODY_REACH } from "./physconst.js";
import { reachTo, massOf, shoveCap, feetOn, sweptCovers } from "../shove.js";
import { r3, noNeg0, unNegZero } from "./round.js";
import { shapeError, isBoxShape } from "./shapes.js";
import { CTX, UP } from "./authority/ctx.js";
import { SOCKETS_PER_HOST, isLegacyParent, isSocketC, socketRules, actionRules, socketsOf, allSockets, socketPoint, socketRole, liftOps, legacyHosts, liftHostOps, modelSocketNames } from "./authority/sockets.js";
import { Refusal, refuse, said } from "./authority/refuse.js";
import { LAB_CATALOGUE, modelOf, geomOf, boxOfM, geomE, withCatalogue, meshShape } from "./authority/catalogue.js";
export { LAB_CATALOGUE, withCatalogue, MESH_SIZE, meshSize, meshGeom, meshShape } from "./authority/catalogue.js";
import { readback } from "./authority/storage.js";
import { CHANGE, FOLLOW_UP, IMPORTED_ONLY, VOLATILE, clone, createOps, delOp, followUp, followUpsOf, isE, lockedC, nonce16, opsQuiet, qr3, scratch, setOp, versionOf, versionSeq, LOCK_LEVELS, lockLevel, lockRank } from "./authority/storage.js";
export { posAt, worldOf, seal, LOCK_LEVELS, lockLevel, lockRank, readback } from "./authority/storage.js";
import { NONE, aabb, ancestors, descendants, hits, localFrom, obbs, qYaw, qinv, qmul, qrot, satCost, satDepth, surfacesOf, worldT, yawQ } from "./authority/math.js";
import { SPATIAL, WORK_BUDGET, clockMs, familyOf, groundOf, groundReady, hitsIx, kidsMap, near, spatial, spend, supportBelow, supportUnder } from "./authority/spatial.js";
export { WORK_BUDGET, indexAudit } from "./authority/spatial.js";
import { RANK, RESERVED, backward, banOf, creatorOf, effective, entryBy, ghostOf, inForce, inForceOf, isBanned, isScriptActor, kickOf, lastSetterOf, madeBy, may, modHolder, muteOf, ownersOf, rankOf, roleOf, sanctionsNow, wcOf, whoRank } from "./authority/rights.js";
export { effectiveIn, roleIn, inForceOf, banOf, isBanned, kickOf, muteOf, ghostOf, sanctionsNow, creatorOf, lastSetterOf } from "./authority/rights.js";
import { BODY_VERBS, bodyGate, expireAsks, forgetReaches, inboxPush, shieldOf } from "./authority/bodyconsent.js";
export { reachAdmits, reachLetGo } from "./authority/bodyconsent.js";
import { MOD_VERBS } from "./authority/moderation.js";
import { USE_VERBS, actionsOf, offersFor, pivotOf, reactionCap, toggleOf } from "./authority/use.js";
import { READ_VERBS, buildCreateFrom, buildPublish, buildUpdate, thingSaid } from "./authority/blueprints.js";
import { actIndexOf, buildSculpt, buildSky, buildUndo, buildWeather } from "./authority/undo.js";
export { actIndexFresh, actIndexOf, entityBefore } from "./authority/undo.js";
import { DRY, DUTY, allScripts, budgetOf, dutyLeft, dutyLog, installCheck, logRt, overCpu, particlesCheck, pauseOnly, pausedBy, presentOf, rtKey, rtOf, sampleOf, scopeIds, scriptCeiling, scriptDefaults, scriptDepth, scriptMemo, scriptRights, scriptsCfg, sponsorOf, uploadEffect } from "./authority/scripts.js";
export { DUTY, scriptCeiling, scriptDefaults, setScriptConfig, setScriptDuty, unpaused } from "./authority/scripts.js";
import { SCRIPT_VERBS, activate, drainHeld, drainScripts, heldEvent } from "./authority/scriptrun.js";
export { ORPHANS, liftWorld, presenceEvent, scriptsView, settle, settleOrphans, tick } from "./authority/scriptrun.js";
import { clearSeat, leftSeat, occupiedRefuse, seatOf, setSeat, sitterOn, unseatAt, unseatWhy, unseatsFor } from "./authority/riders.js";
import { arrivalBox, body, buildEpoch, dist, handOf, holdOf, lawOf, pathBlocked, restampEngine, settleSim, shearFree, sizeOf, solidAt } from "./authority/physics.js";
import { fliesIn, flyingWorld, holdHow, homeScale, launch, recentRests, releasePos, returnDue, returnHome, returnPlan, sameHome, secondHand, shaped, shoveGate, snapTarget, stampHomes, stampResetHomes, vec3s } from "./authority/manipulate.js";
import { PHYSICS_VERBS } from "./authority/bodyverbs.js";


// ---------- storage: authority/storage.js ----------
// ---------- math: authority/math.js ----------
// ---------- the spatial index: authority/spatial.js ----------
// ---------- rights, views over the log, sanctions: authority/rights.js ----------
// ---------- the authority ----------
// Refusal / refuse / said: authority/refuse.js
// RESERVED (the authority's own identities): authority/rights.js

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
    const h = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;   // never a prototype key (review r9 L1: `constructor`, `__proto__`)
    if (h && !w.exists && !["create-world", "help"].includes(verb)) refuse("no-world", `there is no world called '${w.name}' yet`, `create-world {title: '…'} founds it (you become its owner); or pick a world that exists`);
    // §2.4: chain points are signed by the key genesis names (or the latest handoff). An authority holding another key would
    // write lines its own verifier calls forged (a moved dir, a lost or swapped custody file): it refuses instead (R5).
    if (h && w.exists && w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer && !READ_ONLY.has(verb))
      refuse("custody", "this server doesn't hold the key that signs this world (its genesis names another sequencer)", "the operator restores the world's custody file, or hands the sequencer over (§13 handoff); reads still work");
    if (h && w.exists && w.state().status !== "ok") refuse("unreadable", `this world's log folds to '${w.state().status}'`, "the authority won't write to a log its own reader refuses");
    if (!h && Object.hasOwn(RESERVED_VERBS, verb)) refuse("reserved", `'${verb}' is a reserved request: ${RESERVED_VERBS[verb].why}`, "help lists every verb");
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
    if (h && w.exists) { CTX.work = { left: Infinity, until: Infinity, k: 0 }; restampEngine(w); settleSim(w); returnDue(w); expireAsks(w); CTX.work = { left: WORK_BUDGET.units, until: clockMs() + WORK_BUDGET.ms, k: 0 }; }
    args = wire(args);
    const minted = h && w.exists ? placeholders(w, verb, args) : null; if (minted) args = minted.args;
    // throughLock (§5) is a flag on any request, not an argument of one verb: checked here, then admit reads it
    // expect (§3a) is the same kind of flag: the values a gesture started from. Checked here, before anything is built
    const { throughLock, expect, ...plain } = args;
    if (throughLock !== undefined && typeof throughLock !== "boolean") refuse("shape", `throughLock is true or false, got ${JSON.stringify(throughLock)}`, "send throughLock: true to act through a lock you may remove");
    CTX.through = throughLock === true;
    const bad = validate(verb, plain); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); }
    if (expect !== undefined) expectCheck(w, expect);
    if (verb === "create" && args.place) { const b2 = validate("place", { ...args.place, id: "x" }); if (b2) { const { code, reason, fix, ...rest } = b2; refuse(code, `place: ${reason}`, fix, rest); } }
    const r = h(w, actor, args);
    if (minted && r && (r.ok || r.dry)) r.ids = minted.ids;   // each placeholder and the id it became (never logged: the act holds the ids)
    drainHeld(w);    // grab / release (grabbable): scripts whose scope covers the thing hear who took it, how it was let go
    drainScripts(w); // what the request's own entries trigger (changed:<comp>, say), after them, each its own activation
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; }
    if (r && r.refused && !r.refused.fix) r.refused.fix = verbHelp(verb) ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb";
    if (r && r.refused) noteCode(r.refused.code);
    return r;
  } catch (e) {
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } // a refusal still updates the authority's own ring and throttle (presence, unlogged)
    if (e instanceof Refusal) { noteCode(e.code); if (!UNLOGGED_REFUSALS.has(e)) logRefusal(w, actor, verb, args, e.code); const { code, reason, fix, ...rest } = e; return { ok: false, refused: { code, reason, fix: fix || (Object.hasOwn(VERBSPEC, verb) ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb"), ...pick(rest) } }; }
    throw e;
  } finally { exit(); }
}
// The refusal-code registry (refusalcodes.js; engine-scars 3.1): a code is one-way (it is written into signed entries), so
// every code a reply carries must be registered. One the registry doesn't have is noted here (never refused: the asker gets
// the refusal as given) and scars-check G1 fails on any it met.
const UNSEEN_CODES = new Set();
const noteCode = (c) => { if (!isRefusalCode(c)) UNSEEN_CODES.add(String(c)); };
/** Refusal codes a reply carried that the registry doesn't list (tests read it; empty when the registry is whole). */
export function unregisteredCodes() { return [...UNSEEN_CODES]; }
// ---- ids: writers never choose them (R 10-17 00:46, STAGING-TODO "ID HARDENING" (2)) ----
// The authority mints every id (shared/protocol/ids.js: 26 base32, no slug). A writer that needs to name a thing it is
// making — to parent something to it, place something on it, point at it — in the same request writes a request-local
// placeholder ('$table', JSON:API's lid) as the create's id and wherever it refers to it; the authority mints an id for
// each before the request is checked, writes the minted id everywhere the placeholder stood, and the reply maps them
// ({ids: {"$table": "<minted>"}}). The act is the request with the minted ids in it: a placeholder never reaches the log.
// A chosen id on a create (create, create {from}, a batch's create) is refused, with the fix. System acts that must
// keep ids (a fork's copy: forkCopy) keep copying them verbatim; so do tests' fixtures, through fixtureIds() (in-process
// only: no request word reaches it, and ids-check G1 holds every runtime file to never calling it).
let FIXTURE_IDS = false;
/** Tests' fixtures seed known ids the way a fork's copy does (in-process only; never called by a runtime file). */
export function fixtureIds(on = true) { FIXTURE_IDS = !!on; }
const UNLOGGED_REFUSALS = new WeakSet();   // a refusal of the placeholder pass names placeholders: the attempt isn't recorded
// keys whose string value names a thing, and keys whose list does: an undefined placeholder there is refused by name
const REF_KEYS = new Set(["id", "to", "on", "beside", "hang", "against", "near", "from", "target", "copy", "facing", "attach"]);
const REF_LISTS = new Set(["targets", "marks", "ids", "refs"]);
function placeholders(w, verb, args) {
  const creates = verb === "create" ? [[null, args]]
    : (verb === "batch" || verb === "fork-copy") && Array.isArray(args?.ops) ? args.ops.map((o, i) => [i, o && o.verb === "create" && o.args && typeof o.args === "object" ? o.args : null]).filter(([, a]) => a) : [];
  const at = (i) => (i === null ? "" : `batch op ${i}: `);
  const no = (reason, fix) => { try { refuse("shape", reason, fix); } catch (e) { UNLOGGED_REFUSALS.add(e); throw e; } };
  const keep = CTX.forking || FIXTURE_IDS; const ids = {};
  const anyPh = creates.some(([, a]) => isPlaceholder(a.id));   // a refusal of a request that holds placeholders isn't recorded (they never reach the log)
  for (const [i, a] of creates) { if (a.id === undefined || a.id === null) continue;
    if (isPlaceholder(a.id)) { if (a.id in ids) no(`${at(i)}the placeholder '${a.id}' is defined twice in one request`, `each placeholder names one new thing: give the other create its own ('${a.id}-2'), and refer to either by its name elsewhere in the request`); ids[a.id] = null; continue; }
    if (!keep) { const word = String(a.id).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40) || "name";
      (anyPh ? no : (r, f) => refuse("shape", r, f))( `${at(i)}a thing's id isn't chosen by the writer: the authority mints it (an id never changes, so it carries no word; what a thing is called is its label)`, `leave id out (the reply's refs name the id it gets), or write '$${word}' as a placeholder: refs to '$${word}' in the same request resolve, and the reply's ids map gives the id it became`); } }
  const st = w.state(); const ever = w.everIds?.() ?? new Set(); const fresh = new Set();
  for (const k of Object.keys(ids)) { let id; do id = mintId(); while (st.entities[id] || ever.has(id) || fresh.has(id)); fresh.add(id); ids[k] = id; }
  const sub = (v, key) => {
    if (typeof v === "string") { if (v in ids && isPlaceholder(v)) return ids[v];
      if (isPlaceholder(v) && REF_KEYS.has(key)) no(`'${v}' isn't defined in this request`, `a placeholder names a thing a create in the same request makes (create {id: '${v}', …}); a thing already here goes by its id (look lists them)`);
      return v; }
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && REF_LISTS.has(key) ? sub(x, "id") : sub(x, key)));
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = sub(x, k); return o; }
    return v; };
  const out = sub(args, null);
  return Object.keys(ids).length ? { args: out, ids } : null;
}

// R7: a refused write is part of the record (what someone TRIED, in true order): an act whose body is {args, refused: {code}}
// inside the actor's byte budget. The engine-scars review (6a, R 10-17 02:45) cut what it keeps to the verb (the act's own
// `verb`), the argument NAMES the verb takes (its VERBSPEC row, plus the flags every request may carry), and the code: never
// a value. A visitor could otherwise write any text into a permanent, signed, forkable record by sending refused requests
// (and a name the verb doesn't take is text too: it is counted as `unknownArgs`, never written). The values go to the
// authority's in-memory ring (refusalRing: never persisted, capped, like the server's world_debug flight recorder).
// Never logged: reads, dry runs, and the refusals that ARE the budget or the authority's own state (rate, identity,
// no-world, custody, unreadable, banned): logging those would be the flood. Past the budget, the authority counts what it
// didn't write, and the next refusal it does write says how many (`unrecorded`).
// "muted": its refusal would put the muted words in the public log (review 10-07)
const UNLOGGED = new Set(["rate", "identity", "no-world", "custody", "unreadable", "banned", "kicked", "ghost", "muted"]);
const UNIVERSAL_ARGS = new Set(["dry", "throughLock", "expect"]);   // flags any request may carry (§3a, §5)
const PRESENCE_VERBS = new Set(["move", "body", "reach", "consent", "inbox", "wait", "leave"]);   // a refusal of these is never logged
const REFUSAL_RING = 200, RING_VALUE_BYTES = 2048;
/** The argument names a refused request is logged with: the verb's own (VERBSPEC), sorted; the rest only counted. */
function argNames(verb, args) {
  const keys = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
  const spec = Object.hasOwn(VERBSPEC, verb) ? VERBSPEC[verb] : null;
  const known = spec ? keys.filter((k) => k in spec.args || UNIVERSAL_ARGS.has(k)) : [];
  return { known: known.sort(), unknown: keys.length - known.length };
}
/** The authority's in-memory ring of refused requests WITH their values (what someone typed): diagnosis, never history.
 *  Not persisted (a reopened world starts empty) and never written to the log. Newest last. */
export function refusalRing(w) { return (w.refusals ?? []).slice(); }
function ringRefusal(w, actor, verb, args, code) {
  let v; try { v = jcs(stripDry(args ?? {})); } catch { v = "(not I-JSON)"; }
  const rec = { ts: Math.floor(w.now()), actor, verb: String(verb).slice(0, 64), code, args: v.length > RING_VALUE_BYTES ? `${v.slice(0, RING_VALUE_BYTES)}… (${v.length} bytes)` : v };
  const ring = (w.refusals ??= []);
  ring.push(rec); if (ring.length > REFUSAL_RING) ring.splice(0, ring.length - REFUSAL_RING);
}
function logRefusal(w, actor, verb, args, code) {
  try {
    if (w.exists) ringRefusal(w, actor, verb, args, code);
    // a verb the authority doesn't have is recorded too (an agent's invented verb is part of what it tried), when it's a name
    if (!w.exists || !(Object.hasOwn(VERBS, verb) || /^[a-z][a-z0-9-]{0,31}$/.test(String(verb))) || READ_ONLY.has(verb) || args?.dry === true || !isIdentity(actor) || RESERVED.has(actor)) return;
    // a body's track is presence: a refused move (a step, an arrival or a teleport) is never recorded. A person's client
    // keeps the track current several times a second and answers a refused step with a teleport; a person indoors, flying
    // or seated wrote a permanent, broadcast refusal every few seconds (review 10-06 S0-3). An ACCEPTED teleport is an act.
    if (verb === "move") return;
    // …and so is everything else a body does or says about itself (scars r8 M3): a refused touch, pose or reach, a refused
    // consent write, an inbox or wait. Consent is presence, never appended: "A tried to touch B, was refused, kept trying"
    // written into a signed, forkable log is exactly what consent.js promises never happens
    if (PRESENCE_VERBS.has(verb)) return;
    if (code === "rate") { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; } // an attempt all the same: counted, not written
    // a refused shove is a walk that met something, not a request anyone made in words (review 10-12 S2-4): counted, not written
    if (verb === "punt" && args?.shove === true) { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; }
    if (UNLOGGED.has(code)) return;
    const names = argNames(verb, args);
    const body = { args: names.known, refused: { code } }; if (names.unknown) body.unknownArgs = names.unknown;
    // a verb the authority doesn't have is recorded as `unknown-verb`: its name is the visitor's text (32 characters of it,
    // in a permanent, forkable record), so it goes to the ring only, as argument values do (scars r8 M3)
    const asVerb = Object.hasOwn(VERBS, verb) || Object.hasOwn(RESERVED_VERBS, verb) ? verb : "unknown-verb";
    const miss = (w.unrecorded ??= new Map()); const n = miss.get(actor) ?? 0; if (n) body.unrecorded = n;
    try { rateCheck(w, actor, "act", jcs(body).length + 256); } catch (x) { if (x instanceof Refusal) { miss.set(actor, n + 1); return; } throw x; }
    w.append(actEntry(w, actor, asVerb, body)); miss.delete(actor);
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
    // The refusal says THAT it changed, never WHAT it is now: expect is checked before the handler, so before
    // admit/rights/lacks/lockCheck, and a dry request is never logged (logRefusal) — a value echoed here would be
    // readable by anyone, about any component of anything, without a trace (review 10-13, attack-check H5a).
    // `expected` was the asker's own input, so it told them nothing either. The client needs only the signal:
    // editwrites.js reverts and shows the reason; nothing reads a value back.
    refuse("changed", `${x.id}.${x.component} changed since you started: ${why}`, "look again and redo it (nothing was written); or send it without expect to overwrite what's there",
      { id: x.id, component: x.component, ...(lt ? { by: lt.actor, at: lt.seq } : {}) });
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
// FOLLOW_UP / followUp (the authority's own follow-up ops inside a person's write): authority/storage.js
class Admitted { constructor(who, ops, after, notes = [], unseat = [], followUps = []) { this.who = who; this.ops = ops; this.after = after; this.notes = notes; this.unseat = unseat; this.followUps = followUps; Object.freeze(this); } }
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
  const fuOps = new Set(); // the authority's follow-ups in this write (FOLLOW_UP): admitted without the asker's rights
  ops.forEach((raw, i) => {
    const { verb, ...rest } = raw; const op = { verb, ...shapeOneOrRefuse(verb, rest, i) };
    const fu = raw[FOLLOW_UP] === true; if (fu) fuOps.add(op);
    if ("value" in op) op.value = unNegZero(op.value); // I-JSON has no -0 (an engine can make one); the same number, written as 0
    // parent.order is gone (shape audit 10-16): whatever path a parent value takes to the door (a request, a copy of a stored
    // one, the lift), the order it carries is dropped here, never written again
    if (op.verb === "set" && op.comp === "parent" && op.value && typeof op.value === "object" && !Array.isArray(op.value) && "order" in op.value) { const { order: _o, ...rest } = op.value; op.value = rest; }
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
    // a reserved name (componentspec STATUSES) is held, never written: one refusal for every reserved name, before rights
    // (nobody may write it, so who is asking doesn't matter). A carried value (a fork's copy, the load's lift) keeps what it
    // holds: the refusal is about new writes, not about what an older log stored
    // (a lifted name, sockets, is the lift's: a write of it never gets here as itself unless malformed, and then its own
    // check says what is wrong with it in its own words)
    if (op.verb === "set" && statusOf(op.comp) === "reserved" && !defOf(op.comp)?.lifted && !(CTX.forking || who.lifting)) { const b = canonicalName(baseOf(op.comp));
      refuse("reserved", `${at}: '${b}' is a reserved name: it is held for a shape that isn't settled yet, and nothing may write it`, COMPONENTS[b].instead ?? `schema {component: '${b}'} says what it is held for`, { status: "reserved" }); }
    const pause = op.verb === "set" && op.comp.startsWith("script:") && pauseOnly(op.value, s.entities[op.id]?.c[op.comp]);
    if (!fu) { rights(w, st, s, who, role, op, at, made, pause);
      keyRights(w, st, s, who, op, at, keysMade, pause);
      seniority(w, st, who, op); }
    // §3d H7: deleting an entity is admitted as deleting each of its components, so the creator rule applies per key
    if (op.verb === "delete" && op.comp === undefined && e) for (const c of Object.keys(e.c)) keyRights(w, st, s, who, { verb: "delete", id: op.id, comp: c }, `${op.id}.${c}`, keysMade);
    // §3d M6 (L5): a schemas:<name> value, once set, can't change (a new meaning is a new name). Setting the same value
    // again changes nothing; deleting it is changing it.
    if (op.id === "@world" && op.comp?.startsWith("schemas:") && e && op.comp in e.c && !(op.verb === "set" && jcs(op.value) === jcs(e.c[op.comp])))
      refuse("schema-fixed", `@world.${op.comp} is set; a schema never changes (§4: a name never changes meaning)`, "a new meaning is a new name");
    if (op.comp === "terrain-grid" && Object.keys(e?.c ?? {}).some((k) => k.startsWith("terrain-tile:")) && !(op.verb === "set" && jcs(op.value) === jcs(e.c["terrain-grid"])))
      refuse("grid-fixed", `${op.id}'s terrain-grid is fixed while it has tiles`, "regridding is a new ground entity");
    if (inFlight(op.id) && !fu) refuse("in-flight", `${op.id} is in flight: the engine has it until it comes to rest`, "wait (or catch it: grab {id}); no write may touch a launched thing before its rest");
    if (op.id === "@world" && op.comp === "lock" && op.verb === "set") refuse("world", "@world can't be locked", "§7: lock the things in it instead");
    if (!fu) lockLevelCheck(w, st, s, who, op, at);
    // locks: the thing's own lock as of this op; its ancestors' locks as of before this write (what was attached then)
    if (op.verb === "create") made.add(op.id);
    // a lock covers EVERYTHING on the thing and on what hangs under it (R 10-11 16:21, Second Life's Locked): every component
    // set, added or removed, not only where it stands (review 10-11 C-S1-1: a builder could switch off, hide or un-physics an
    // owner-locked thing). Open still: USE (a reaction's own writes), the engine's rest, the authority's follow-ups, and the
    // thing's own lock (lockLevelCheck says who may lift it).
    else if (!fu && !made.has(op.id) && !["rest", "system"].includes(cap?.kind) && !(op.comp === "lock" && lockedC(s.entities[op.id]?.c))
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
  seatRights(w, st, s, who, role, norm.filter((o) => !fuOps.has(o)), made);
  const unseat = CTX.forking || who.lifting ? [] : unseatsFor(w, st, who, norm);
  capacityCheck(w, st, s, who, norm);
  for (const op of norm) if (op.verb === "set") valueCheck(s, op, { carry: CTX.forking || !!who.lifting }); // against the state the whole write leaves (parents may come later in a batch); a fork's copy carries what its parent holds
  { const bad = socketRules(s, new Set(norm.map((o) => o.id))); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); } }
  if (!(CTX.forking || who.lifting)) { const bad = actionRules(s, new Set(norm.map((o) => o.id))); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); } }
  rolesCheck(st, s, norm);
  for (const op of norm) if (op.verb === "set" && op.comp.startsWith("script:") && !pauseOnly(op.value, prevOf.get(op))) installCheck(w, st, s, who, op); // 41 §3.14: at install (not a pause: it needs no source, no scope)
  if (!CTX.forking) for (const op of norm) if (op.verb === "set") particlesCheck(w, op); // a particles value names an effect this world has, with params it declares (shared/particle_effects.js)
  if (cap?.kind === "script") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some((r) => r === id || ancestors(s, id).includes(r)))
    refuse("scope", `${cap.key} may create only inside its subtree; ${id} isn't under ${cap.ids[0]}`, "give it parent {to: <an entity in the scope>} in the same batch");
  if (ownersOf(st).length && !ownersOf(s).length) refuse("last-owner", "that would leave this world with no owner", "§7: add the new owner's role first (set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}), then change yours");
  if (cap?.kind === "rest") restCheck(w, cap, s);
  return new Admitted(who, norm, s, unseat.length ? [...lifted.notes, ...unseat.map((u) => ({ who: u.who, unseated: true, seat: u.seat, why: unseatWhy(u) }))] : lifted.notes, unseat,
    norm.flatMap((o, i) => (fuOps.has(o) ? [i] : [])));
}
// A socket is part of its host (review 10-12 S1-1): before the cut a seat was the host's own `sockets` component, so
// adding one to someone else's thing needed editOthers on it and an owner-level lock refused it. Now it's a child entity,
// and a create needs only build, and a lock check reads the op's own id. So a socket JOINING a host (made under it,
// re-parented onto it, or a thing under it made a socket) needs the host's rights (as `set <host>.sockets`), and every
// write touching a socket child (those, and any set or delete on one) meets the locks over its host's chain, the host it
// had and the host it ends on.
// The legacy map's lifted creates are in `norm`, so both spellings meet the same rule. A host made in this same write is
// the asker's own. The authority's follow-ups (rest, system: the load's lift) and a hand carry no seat edits.
function seatRights(w, st, s, who, role, norm, made) {
  const cap = who.cap; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : who.actor;
  const hosts = new Map(); const joins = new Set();
  for (const op of norm) { const was = st.entities[op.id]?.c, now = s.entities[op.id]?.c;
    const h0 = isSocketC(was) ? was.parent?.to : null, h1 = isSocketC(now) ? now.parent?.to : null;
    for (const h of [h0, h1]) if (h && !hosts.has(h)) hosts.set(h, op);
    if (h1 && h1 !== h0) joins.add(h1); }
  for (const [h, op] of hosts) { if (made.has(h) || !st.entities[h]) continue;
    const at = h + "'s sockets (" + op.verb + " " + op.id + (op.comp !== undefined ? "." + op.comp : "") + ")"; const as = { verb: "set", id: h, comp: "sockets" };
    // a socket joining h (made, re-parented onto it, or a thing made one) needs h's rights; an edit of a socket already
    // on h is judged on the socket's own rights in rights() (its creator, or the builder the load's lift names: RL4)
    const n = joins.has(h) ? lacks(w, st, holder, as, made, { viaCap: !!cap }) : null;
    const whose = cap ? " (" + said(holder) + "'s, whose rights this write carries)" : "; you are " + role;
    if (n) refuse("rights", "a socket is part of its host, so " + op.id + " is an edit of " + at + ": that needs " + needWords(n) + whose, "ask " + h + "'s builder or an owner; a socket on a thing of your own needs nothing more", { needs: n, host: h });
    const k = lockedC(st.entities[h]?.c) ? h : ancestors(st, h).find((x) => lockedC(st.entities[x]?.c));
    if (k) lockCheck(w, st, who, role, k, { ...as, id: op.id }, at); }
}
// How much a world holds (review 10-06 S0-2, security pass 2; ONE budget since R 10-15 22:48): at most
// @world.capacity.entities entities, every one but @world, sockets included (a socket is a child entity); and the world's
// account-less people TOGETHER at most capacity.guestEntities standing entities they made: a guest is a fresh identity
// per connection, so no per-identity budget stopped one from filling a world. Only a write that adds entities is refused
// (full); deleting, and every other change, stay open at the cap. capacity.avatar isn't enforced (no avatar trees yet).
// CAPACITY is this server's default for each absent field, and CAPACITY_CEILING the most an owner may set: server policy
// (PROTOCOL §9.2), reported by schema, never pinned in the registry. entities 10 000 is what scale-check C2 fills under
// budget; 50 000 is the owner's ceiling, not measured.
export const CAPACITY = { entities: 10000, guestEntities: 500, avatar: 2000 };
export const CAPACITY_CEILING = { entities: 50000, guestEntities: 50000, avatar: 5000 };
const capacityOf = (st) => { const ok = (x) => Number.isInteger(x) && x >= 0;
  // read through the registry's one versioned-name reader (§4); with no capacity@n registered it is plain `capacity`
  const { name, value: v } = resolveVersioned(st.entities["@world"]?.c, "capacity"); const D = CAPACITY;
  return { ...Object.fromEntries(Object.keys(D).map((k) => [k, ok(v?.[k]) ? v[k] : D[k]])), name }; };   // name: the registry key the world is read under, for refusals to cite
// how many entities a guest's rights made still stand (a log view, kept incrementally like everIds)
function guestMade(w, st) {
  const G = (w.__guests ??= { n: 0, ids: new Set() });
  for (; G.n < w.entries.length; G.n++) { const e = w.entries[G.n]; if (!isE(e) || e.kind !== "change") continue; let by = null;
    for (const o of opsQuiet(e)) { if (o.verb === "create") { by ??= entryBy(w, e).rights; if (CTX.isAnon(by)) G.ids.add(o.id); } else if (o.verb === "delete" && o.comp === undefined) G.ids.delete(o.id); } }
  let n = 0; for (const id of G.ids) if (st.entities[id]) n++; return n;
}
const entityCount = (st) => Object.keys(st.entities).length - (st.entities["@world"] ? 1 : 0);
function capacityCheck(w, st, s, who, norm) {
  if (who.lifting) return;   // the load's lift carries what the log already holds (sockets in the old spelling): never refused
  const made = norm.filter((o) => o.verb === "create" && s.entities[o.id]).length;
  // the hosts that sockets join in this write (made, re-parented onto one, or a thing made one): one holds at most SOCKETS_PER_HOST
  const joined = new Set();
  for (const id of new Set(norm.map((o) => o.id))) { const now = s.entities[id]?.c, was = st.entities[id]?.c;
    const h = isSocketC(now) ? now.parent?.to : null; if (h && (!isSocketC(was) || was.parent?.to !== h)) joined.add(h); }
  if (!made && !joined.size) return;
  const cap = capacityOf(s);
  if (made) { const before = entityCount(st), after = entityCount(s);
    if (after > before && after > cap.entities) refuse("full", `this world holds ${before} entities and its limit is ${cap.entities} (@world.${cap.name}.entities): ${after - before} more won't fit (every entity counts, sockets too)`, `delete something first; the world's owner may raise it: set {id: '@world', component: '${cap.name}', value: {entities: <n>}} (at most ${CAPACITY_CEILING.entities} on this server)`, { limit: cap.entities, entities: before }); }
  if (joined.size) { const per = new Map([...joined].map((h) => [h, [0, 0]]));
    for (const e of Object.values(s.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[1]++; }
    for (const e of Object.values(st.entities)) { const h = isSocketC(e.c) ? e.c.parent?.to : null; if (per.has(h)) per.get(h)[0]++; }
    for (const [h, [before, after]] of per) if (after > before && after > SOCKETS_PER_HOST) refuse("full", `${h} has ${before} sockets, and one thing holds at most ${SOCKETS_PER_HOST}: ${after - before} more won't fit`, "a thing with that many seats is several things: split it, or delete some of its sockets", { limit: SOCKETS_PER_HOST, sockets: before, host: h }); }
  if (!made) return;
  const holder = who.cap?.kind === "reaction" ? who.cap.author : who.cap?.kind === "script" ? who.cap.sponsor : who.actor;
  if (!CTX.isAnon(holder)) return;
  const g = guestMade(w, st);
  if (g + made > cap.guestEntities) refuse("full", `account-less people (guests) together have ${g} entities standing here, and this world lets them have ${cap.guestEntities} (@world.${cap.name}.guestEntities), all of them together`, `sign in to build more, or ask the world's owner to raise it: set {id: '@world', component: '${cap.name}', value: {guestEntities: <n>}} (at most ${CAPACITY_CEILING.guestEntities} on this server)`, { limit: cap.guestEntities, entities: g });
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
const WORLD_LOOK = new Set(["about", "sky", "terrain", "terrain-grid", "grass", "water", "bounds", "spawn"]);
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
  // an imported world's records (its old bindings, unmapped fields incl. a sim epoch, bans) are carried, never
  // written by a request: nothing reads them as live (bans are the moderator log's; scripts are script:<name>; a guard
  // merged into lock). An owner may (a copy of the world, a repair); deleting one is an ordinary edit.
  if (!cap && op.verb === "set" && role !== "owner" && IMPORTED_ONLY(op.comp)) refuse("imported", `${at} is an imported world's record, carried as it was; it isn't written by hand`, "what it meant lives elsewhere now: lock for a guard, the moderator log for bans (ban/unban), script:<name> for a behaviour");
  // a server-written component (componentspec writtenBy: copy-of): the authority's own verbs write it (a copy, a rebase,
  // a duplicate); no capability (a handler, a script) ever does, and a hand set or create below owner is refused where the
  // request is built (serverWritten, buildSet and buildCreate)
  if (op.verb === "set" && cap && ["reaction", "script"].includes(cap.kind) && defOf(op.comp)?.writtenBy === "server") serverWritten(at);
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
  refuse("rights", `${at} is ${c?.rights ? said(c.rights) : "nobody's on record"}'s${c ? ` (made at ${c.seq})` : ""}; only its creator or an owner may ${op.verb === "delete" ? "delete" : "change"} it`,
    op.comp.startsWith("blueprints:") ? "publish your own version: it gets its own key" : `make your own instance (${op.comp.split(":")[0]}:<another key>), or ask ${c?.rights ? said(c.rights) : "an owner"}`);
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
    for (const k of Object.keys(v)) if (!["role", "can", "note"].includes(k)) refuse("schema", `${at}: unknown key '${k}'`, "roles:<id> is {role, can?, note?}", { didYouMean: guessKey(k, ["role", "can", "note"]) });
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
  // policy numbers (PROTOCOL §9.2): an owner sets each at or below this server's ceiling, which is policy, not a registry range
  if (id === "@world" && obj && !carry && (comp === "capacity" || comp === "script-settings")) { const top = comp === "capacity" ? CAPACITY_CEILING : scriptCeiling();
    for (const [k, n] of Object.entries(top)) if (Number.isFinite(v[k]) && v[k] > n) refuse("bounds", `${at}.${k} is ${v[k]}; this server allows at most ${n}`, `set it at ${n} or below (schema reports this server's defaults and ceilings)`, { ceiling: n }); }
  if (id === "@world" && comp === "access" && obj && v.soft !== undefined && v.max !== undefined && v.soft > v.max) refuse("bounds", `${at}.soft (${v.soft}) can't be above max (${v.max})`, "soft is the recommended capacity; max is the hard one");
  // a who names a role this world has (a custom role too); a typo would open or close it to the wrong people
  // a carried value (a fork's copy, the load's lift) keeps the who it was written with, even a role deleted since: the lift
  // re-spells what the log holds and judges nothing new (review 10-12 S2-3); an unknown who reads as the strictest
  const whoOk = (x, where) => { if (!carry && x !== undefined && (x === "none" || !R.roleDef(wcS, x))) refuse("shape", `${where}.who must be a role here (${roleIds().join(", ")}; got ${JSON.stringify(x)})`, "who may: a role name; anyone ranked at or above it may", { didYouMean: guess(String(x), roleIds()) }); };
  if (comp === "physics" && obj) whoOk(v.who, at);
  if (comp === "grabbable" && obj) whoOk(v.who, at);
  if (comp === "reactions" && obj) for (const [act, h] of Object.entries(v)) if (h && typeof h === "object") whoOk(h.who, `${at}.${act}`);
  if (comp === "sockets" && obj) for (const [slot, sk] of Object.entries(v)) if (sk?.body && typeof sk.body === "object") whoOk(sk.body.who, `${at}.${slot}.body`);
  if (comp === "station" && obj) whoOk(v.who, at);
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
    if (v.to === id || ancestors(s, v.to).includes(id)) refuse("loop", `${id} can't be inside ${v.to}: that makes a loop`, "");
    // A chain 32 deep is a LIMIT, not a loop, and saying "loop" sent people hunting a cycle that isn't there
    // (the walk in `ancestors` stops at 32, so this is where the engine stops following a parent chain).
    if (ancestors(s, id).length >= 32) refuse("deep", `${id} is already 32 deep; a parent chain stops there`, "attach it higher up, or flatten part of the chain", { depth: ancestors(s, id).length }); }
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
  // one hinge per thing (shape audit 10-16): a whole thing turns about its pivot component; motion:<part>.pivot is a part's
  // a node of its model moves as motion:<slot> {node: <the file's name>} (review r7, R 10-16: a part's name is data, never
  // part of a key); a whole thing's motion moves the whole thing
  if (comp === "motion" && obj && "node" in v && !carry) refuse("shape", `${at}.node: a whole thing's motion moves the whole thing; a node of its model moves as its own component`, `set {id: '${id}', component: 'motion:${partSlot(typeof v.node === "string" && v.node ? v.node : "part")}', value: {node: ${JSON.stringify(typeof v.node === "string" ? v.node : "<node>")}, type, …}}`);
  if (comp.startsWith("motion:") && obj && "node" in v && !(typeof v.node === "string" && v.node.length >= 1 && v.node.length <= 256)) refuse("shape", `${at}.node is the name of a node in its model, as the file spells it (1–256 characters)`, "measure {id} lists its model's parts");
  if (comp === "motion" && obj && "pivot" in v && !carry) refuse("derived", `${at}.pivot: a whole thing's motion turns about its pivot component, not a field of the motion`, `set {id: '${id}', component: 'pivot', value: {pos: [x, y, z]}} (its own frame); a part's motion (motion:<part>) takes pivot`);
  if (comp === "home") { const okQ = (q) => nums(q, 4, 2) && Math.abs(Math.hypot(...q) - 1) < 1e-3;
    // one spelling (shape audit 10-16): scale is [x, y, z] (a number is taken at write and stored as one; an older stored
    // number is carried by a fork or a lift), parent is {to}
    const okScale = (sc) => (nums(sc, 3) && sc.every((x) => x > 0)) || (carry && typeof sc === "number" && sc > 0);
    if (!obj || !nums(v.pos, 3) || (v.q !== undefined && !okQ(v.q)) || (v.scale !== undefined && !okScale(v.scale)) || Object.keys(v).some((k) => !["pos", "q", "scale", "parent"].includes(k)) || (v.parent !== undefined && !(v.parent && typeof v.parent === "object" && typeof v.parent.to === "string" && Object.keys(v.parent).every((k) => k === "to"))))
      refuse("shape", `${at} is {pos: [x, y, z], q?: [x, y, z, w], scale?: [x, y, z], parent?: {to}}`, "e.g. {pos: [0, 0, 2]}"); }
  if (comp === "reactions") { if (!obj) refuse("shape", `${at} must be {<action>: handler}`, "");
    const kinds = Object.keys(COMPONENTS.reactions.handlers), held = COMPONENTS.reactions.reservedKinds;
    for (const [act, h] of Object.entries(v)) { if (!carry && Object.hasOwn(held, h?.kind)) refuse("reserved", `reactions.${act}: the handler kind '${h.kind}' is reserved: ${held[h.kind]}`, `handler kinds: ${kinds.join(", ")}; a script handler computes anything else`, { status: "reserved" });
      if (!kinds.includes(h?.kind) && !(carry && Object.hasOwn(held, h?.kind))) refuse("shape", `reactions.${act}: no handler kind '${h?.kind}'`, `handler kinds: ${kinds.join(", ")}`, { didYouMean: guess(String(h?.kind), kinds) });
      if (h.component !== undefined && !isComponent(h.component)) refuse("shape", `reactions.${act}.component '${h.component}' isn't a component name`, "§3.1");
      if (h.kind === "set" && !isComponent(h.component)) refuse("shape", `reactions.${act} (set) needs a component`, "e.g. {kind: 'set', component: 'openable', field: 'locked', value: true}");
      for (const f of ["field", "unless"]) if (h[f] !== undefined && typeof h[f] !== "string") refuse("shape", `reactions.${act}.${f} is a field name (a string)`, "");
      if (h.kind === "reset" && !(Array.isArray(h.targets) && h.targets.length >= 1 && h.targets.length <= 64 && h.targets.every((t) => typeof t === "string")))
        refuse("shape", `reactions.${act} (reset) names what it sends home: targets [1 to 64 ids]`, "e.g. {reset: {kind: 'reset', targets: ['ball-0', 'ball-1']}}");
      if (h.kind === "reset") { const gone = h.targets.filter((t) => !s.entities[t]); if (gone.length) refuse("not-found", `reactions.${act} (reset) names ${gone.join(", ")}, which ${gone.length > 1 ? "aren't" : "isn't"} here`, "", { didYouMean: guess(gone[0], Object.keys(s.entities)) }); }
      if (h.kind === "script" && !(typeof h.script === "string" && isComponent(`script:${h.script}`))) refuse("shape", `reactions.${act} (script) names the script: {kind: 'script', script: '<name>'} for the script:<name> on this thing`, "e.g. {ring: {kind: 'script', script: 'bell'}}");
      handlerCheck(at, act, h); effectCheck(s, id, act, h); } }
  mediaCheck(s, id, comp, v, at, obj);
  // a held kind (componentspec reservedKinds: terrain's raster, shape audit 10-16) is refused as reserved, in its own words
  if (comp === "terrain" && obj && !carry && Object.hasOwn(COMPONENTS.terrain.reservedKinds, v.kind)) refuse("reserved", `${at}.kind '${v.kind}' is reserved: ${COMPONENTS.terrain.reservedKinds[v.kind]}`, "terrain {kind: 'noise', seed, size, amplitude, …}; an image as the base is heightmap {grid, min, max}", { status: "reserved" });
  // the first protocol's particles bag (preset, origin, count…): its fields left the registry (shape audit 10-16), so say today's
  // spelling in particlesCheck's own words before the schema calls them unknown keys
  if (baseOf(comp) === "particles" && obj && !carry && LEGACY_FIELDS.some((k) => k in v)) refuse("shape", `${at}: ${instanceProblem(v, null)}`, `PROTOCOL §4 (effects are documents): {effect: '${ESSENTIAL_NAMES[0]}'} or an uploaded effect's address; schema {component: 'particles'} lists the Essentials and their params`);
  if (comp === "water" && obj && v.flow !== undefined && !(Array.isArray(v.flow) && v.flow.length === 2 && v.flow.every(isNum) && v.flow.every((x) => Math.abs(x) <= 100))) refuse("shape", `${at}.flow is a current [x, z] in metres a second, each within ±100`, COMPONENTS.water.help);
  for (const [f, allowed] of Object.entries(COMPONENTS[comp.split(":")[0]]?.enums ?? {})) if (obj && v[f] !== undefined && !allowed.includes(v[f])) refuse("shape", `${comp}.${f} must be one of ${allowed.join(" | ")}, got ${JSON.stringify(v[f])}`, `schema {component: '${comp}'}`);
  schemaCheck(at, comp, v, { carry });
  // physics.material (a surface's name) is renamed physics.surface and reserved with surfaces (shape audit 10-16): the
  // check that it names one of this world's surfaces returns when the field opens
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
    // radians (shape audit 10-16; PROTOCOL §9.2): the limits are [min, max] from rest
    for (const f of ["yaw", "pitch"]) if (v[f] !== undefined) { const lim = f === "yaw" ? Math.PI : Math.PI / 2;
      if (!(Array.isArray(v[f]) && v[f].length === 2 && v[f].every((x) => isNum(x) && Math.abs(x) <= lim + 1e-12) && v[f][0] <= v[f][1])) refuse("bounds", `${at}.${f} is [min, max] radians from rest, each within ±${f === "yaw" ? "π" : "π/2"}, min ≤ max`, `e.g. ${f}: [-0.785, 0.785] (±45°)`); }
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
  sha256: (x) => typeof x === "string" && /^sha256:[0-9a-f]{64}$/.test(x),   // a content hash (model-hash; the one spelling, as copy-of.from's)
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
// upstream #237/#242's shaped terrain and water, bounded at the door (review 10-15 #5): the readers (shared/terrainshape.js)
// clamp features and water but pass a heightmap's min/max through raw, so one write of ±1e308 made every client's,
// agent's and the sim's ground NaN. A world's ground is everyone's: the same ±500 m as amplitude, min below max.
const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/, FEATURE_TYPES = ["hill", "ridge", "flatten"], HEX = /^#[0-9a-f]{6}$/i;
const fin = (x) => typeof x === "number" && Number.isFinite(x);
function terrainShapeCheck(at, v, def) {
  if (Array.isArray(v.features)) v.features.forEach((f, i) => {
    const here = `${at}.features[${i}]`;
    if (!f || typeof f !== "object" || !FEATURE_TYPES.includes(f.type)) refuse("shape", `${here} must be {type: hill | ridge | flatten, …}`, def.help);
    const pts = f.type === "ridge" ? ["x1", "z1", "x2", "z2"] : ["x", "z"];
    for (const k of [...pts, "radius", "height", ...(f.edge !== undefined ? ["edge"] : [])]) if (!fin(f[k])) refuse("shape", `${here}.${k} must be a finite number`, def.help);
    if (!(f.radius > 0.05 && f.radius <= 2000)) refuse("bounds", `${here}.radius is ${f.radius}; it must be 0.05 < radius ≤ 2000 (m)`, def.help);
    if (Math.abs(f.height) > 500) refuse("bounds", `${here}.height is ${f.height}; it must be within ±500 (m)`, def.help);
    for (const k of pts) if (Math.abs(f[k]) > 100000) refuse("bounds", `${here}.${k} is ${f[k]}; it must be within ±100000 (m)`, def.help); });
  const h = v.heightmap;
  if (h != null) {
    if (typeof h !== "object" || Array.isArray(h)) refuse("shape", `${at}.heightmap must be {grid, min, max} or null`, def.help);
    if (typeof h.grid !== "string" || !GRID_REF.test(h.grid)) refuse("shape", `${at}.heightmap.grid must be store/heightmaps/<16 hex>.json (POST /upload?as=heightmap)`, def.help);
    for (const k of ["min", "max"]) if (h[k] !== undefined && !fin(h[k])) refuse("shape", `${at}.heightmap.${k} must be a finite number`, def.help);
    const min = h.min ?? 0, max = h.max ?? 10;
    if (Math.abs(min) > 500 || Math.abs(max) > 500) refuse("bounds", `${at}.heightmap min/max are ${min}/${max}; each must be within ±500 (m), the ground every client builds`, def.help);
    if (!(min < max)) refuse("bounds", `${at}.heightmap.min (${min}) must be below max (${max})`, def.help);
  }
  // its colour layers (shape audit 10-16): [{color: 0xRRGGBB, repeat > 0}], at most 8 (the registry's maxItems). Water is its
  // own component now (componentspec water: its level, opacity and kind are the registry's ranges and enum)
  if (Array.isArray(v.layers)) v.layers.forEach((l, i) => { const here = `${at}.layers[${i}]`;
    if (!l || typeof l !== "object" || Array.isArray(l) || Object.keys(l).some((k) => k !== "color" && k !== "repeat")) refuse("shape", `${here} must be {color?: 0xRRGGBB, repeat?: tiles across its size}`, def.help);
    if (l.color !== undefined && !(Number.isInteger(l.color) && l.color >= 0 && l.color <= 0xffffff)) refuse("shape", `${here}.color is an int 0xRRGGBB (sRGB)`, def.help);
    if (l.repeat !== undefined && !(fin(l.repeat) && l.repeat > 0 && l.repeat <= 4096)) refuse("bounds", `${here}.repeat is how many times it tiles across the ground, 0 < repeat ≤ 4096`, def.help); });
}
// where a cut field went (componentspec `dropped`), for the refusal's fix
const DROPPED_FIX = {
  "motion.amplitude": "amp is the one spelling: {type: 'pendulum', amp: 0.3}",
  "motion.part": "a node of its model moves as its own component: set {id, component: 'motion:<slot>', value: {node: <the node's name, as its file spells it>, type, …}} (<slot>: any short tag [a-z0-9-]; the editors use the node's name, or a sanitized form of it)",
  "physics.material": "physics.surface names a surface:<name> (reserved until an engine reads surfaces)",
  "physics.layers": "collision filters come back as named groups; leave it out",
  "physics.mask": "collision filters come back as named groups; leave it out",
  "physics.ccd": "eidosim sweeps every body; leave it out",
  "parent.order": "leave it out: siblings have no stored order",
  "light.shadows": "leave it out: no light here casts its own shadows yet (important claims a light slot)",
  "picture.part": "a picture is a quad of its own; texturing a node of a model is the material component's (reserved: not written yet)",
  "picture.flip": "a part's upside-down UVs are the material component's (reserved), with part",
  "terrain.water": "set {id: '@world', component: 'water', value: {level, color?, opacity?, kind?, flow?}}",
  "sky.clock": "a tz present is the wall clock: {tz: 'Europe/Paris'} (the sky act still takes clock: 'real')",
  "sky.weatherSeconds": "transition (seconds) is the one spelling",
};
const DROPPED_DYM = { "motion.amplitude": ["amp"], "physics.material": ["surface"], "light.day": ["daytime"], "sky.weatherSeconds": ["transition"], "sky.clock": ["tz"], "terrain.water": ["water"] };
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
  // what a body does at a socket (shape audit 10-16): the core, closed; the reserved keys refused as reserved
  if (name === "station") { const bad = checkStation(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.station.help, { ...(bad.didYouMean ? { didYouMean: bad.didYouMean } : {}), ...(bad.code === "reserved" ? { status: "reserved" } : {}) }); }
  // a place entry is closed (shape audit 10-16): {at} | {min, max}, + label; null hides a model's own
  if (name === "places" && !carry && v && typeof v === "object" && !Array.isArray(v)) for (const [k, p] of Object.entries(v)) { if (p === null) continue; const pat = `${at}.${k}`;
    if (!(p && typeof p === "object" && !Array.isArray(p))) refuse("shape", `${pat} must be {at: [x, y, z]} or {min: [x, y, z], max: [x, y, z]} (+ label), or null`, def.help);
    unknownKeys(pat, p, ["at", "min", "max", "label"], "a place");
    const v3 = (x) => Array.isArray(x) && x.length === 3 && x.every((n) => isNum(n) && Math.abs(n) <= 1e5);
    if (p.at !== undefined ? (!v3(p.at) || p.min !== undefined || p.max !== undefined) : !(v3(p.min) && v3(p.max))) refuse("shape", `${pat} is a spot {at: [x, y, z]} or a room {min: [x, y, z], max: [x, y, z]}, in the thing's own frame (metres)`, def.help);
    if (p.label !== undefined && !(typeof p.label === "string" && graphemes(p.label) <= 80)) refuse("bounds", `${pat}.label is a string of at most 80 characters`, def.help);
    if (typeof p.label === "string") { const bad = cleanText(p.label, { lines: false }); if (bad) refuse("shape", `${pat}.label ${bad.why}`, bad.fix); } }
  // what a hand may do with it (shared/grab.js: closed keys, ranges, enums, grips), in its own words
  if (name === "grabbable") { const bad = checkGrabbable(v, at); if (bad) refuse(bad.code, bad.reason, bad.fix || COMPONENTS.grabbable.help, bad.didYouMean ? { didYouMean: bad.didYouMean } : undefined); }
  if (def.map) { if (!(v && typeof v === "object" && !Array.isArray(v)) || Object.values(v).some((x) => !TYPES[def.map](x))) refuse("shape", `${at} must be {<name>: ${def.map}}`, def.help ?? "");
    // a keyed map's grammar and size (params: shape audit 10-16): its keys are names, and there are at most maxKeys of them
    if (def.keyPattern) { const re = new RegExp(def.keyPattern); const bad = Object.keys(v).find((k) => !re.test(k)); if (bad !== undefined) refuse("shape", `${at}: '${bad}' isn't a name here (${def.keyPattern})`, def.help ?? ""); }
    if (def.maxKeys !== undefined && Object.keys(v).length > def.maxKeys) refuse("bounds", `${at} has ${Object.keys(v).length} entries; at most ${def.maxKeys}`, def.help ?? ""); }
  if (!def.fields) return;
  if (name === "lock" && v === true) return;   // a plain lock is true (builder level); its {rank} form is checked as an object below
  const fields = Object.keys(def.fields);
  if (!(v && typeof v === "object" && !Array.isArray(v))) refuse("shape", `${at} must be an object {${fields.join(", ")}}`, def.help);
  // shape audit 10-16: a reserved field (physics' unread properties) is refused in its own words, and a field the alpha cut
  // (motion.amplitude, motion.part, physics.layers…) says where it went. A carried value (a fork's copy, the load's lift)
  // keeps what it was written with
  if (!carry) { const held = def.reservedFields?.find((k) => k in v);
    if (held !== undefined && name !== "grabbable" && name !== "station") refuse("reserved", `${at}.${held} is a reserved field: no engine here reads it yet, so nothing may write it (the name and its meaning are held: schema {component: '${name}'})`, def.help, { status: "reserved" });
    const gone = Object.keys(def.dropped ?? {}).find((k) => k in v);
    if (gone !== undefined) refuse("schema", `${at}.${gone} is gone: ${def.dropped[gone]}`, DROPPED_FIX[`${name}.${gone}`] ?? def.help, DROPPED_DYM[`${name}.${gone}`] ? { didYouMean: DROPPED_DYM[`${name}.${gone}`] } : undefined); }
  unknownKeys(at, v, carry ? [...fields, ...(def.reservedFields ?? []), ...Object.keys(def.dropped ?? {})] : fields, name);
  const kind = v.kind ?? def.defaultKind; // an imported world's terrain never named its kind: it is noise
  if (def.byKind) { if (!def.byKind[kind]) refuse("schema", `${at}.kind must be one of ${Object.keys(def.byKind).join(" | ")}, got ${JSON.stringify(v.kind)}`, def.help, { didYouMean: guess(String(v.kind), Object.keys(def.byKind)) });
    unknownKeys(at, v, def.byKind[kind], `${name} {kind: '${kind}'}`); }
  for (const [k, t] of Object.entries(def.fields)) if (v[k] !== undefined && !(v[k] === null && def.nullable?.includes(k)) && !TYPES[t](v[k])) refuse("shape", `${at}.${k} must be ${t}, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
  for (const k of def.required ?? []) if (v[k] === undefined) refuse("schema", `${at} needs ${k}`, def.help);
  // a field's grammar narrows its pinned type (physics.shape is `any` in every value ever stored): spec/PHYSICS.md §3.1
  for (const [k, g] of Object.entries(def.grammar ?? {})) if (v[k] !== undefined && g === "sha256" && !(typeof v[k] === "string" && /^sha256:[0-9a-f]{64}$/.test(v[k])))
    refuse("shape", `${at}.${k} must be a content hash sha256:<64 hex>, got ${JSON.stringify(v[k]).slice(0, 40)}`, def.help);
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
  if (name === "terrain") terrainShapeCheck(at, v, def);
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
  const R = COMPONENTS.reactions; if (!R.handlers[h.kind]) return;   // a carried reserved kind keeps what it held
  const allowed = [...Object.keys(R.common), ...Object.keys(R.handlers[h.kind]?.args ?? {})];
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
  // the authority's follow-ups are named in the entry itself (review r9 H1 / scars M3): `followUps` lists their indices, so any
  // reader of the log alone (purged values or not, this code version or another) can tell them from the asker's own ops,
  // and authorship (lastTouch {authored}, creatorOf, lastSetterOf, a script's sponsor) skips them. Always a batch then.
  const ops = plan.ops.map((o) => (o.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o));
  const fu = plan.followUps ?? [];
  const one = ops.length === 1 && !fu.length ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops, ...(fu.length ? { followUps: [...fu] } : {}) } };
  return { kind: "change", actor: plan.who.actor, cause, ...one };
}
function changeEntry(w, plan, cause) {
  if (!(plan instanceof Admitted)) throw new Error("authority bug: a state write that admit() didn't produce (§7)");
  const pre = plan.unseat.length ? w.state() : null;   // where each rider was let go: the seat as it stood before the edit
  const seq = w.append(changeShape(plan, cause, w), CHANGE);
  // the riders an edit lets go (unseatsFor): presence, after the write has landed, each told in their inbox (with where
  // they stand now: the authority's track of their body starts again there, scars r9 M2)
  for (const u of plan.unseat) if (w.presence.seats?.[u.who]?.to === u.seat) { const at = unseatAt(w, pre, u.who, u.seat); clearSeat(w, u.who);
    inboxPush(w.presence, u.who, { type: "unseated", seat: u.seat, ...(u.host ? { host: u.host } : {}), by: plan.who.actor, why: unseatWhy(u), ...(at ? { at } : {}) }); }
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
  const ops = stampModelHash(ctx, stampMedia(ctx, stampResetHomes(ctx, stampHomes(ctx, stampShapes(ctx, build(ctx))))));
  // whatever removes a thing (delete, a batch's delete, an undo of its create) clears the references to it in the same act
  if (ops.some((o) => o.verb === "delete" && o.comp === undefined)) { const after = scratch(st, ops); const gone = new Set(ops.filter((o) => o.verb === "delete" && o.comp === undefined && !after.entities[o.id]).map((o) => o.id));
    if (gone.size) ops.push(...clearRefsTo({ ...ctx, st: after }, gone)); }
  const plan = admit(w, st, { actor, cap: ctx.cap, restores: ctx.restores }, ops); ctx.notes.push(...plan.notes);
  if (args.dry) return { ok: true, dry: true, would: plan.ops, notes: ctx.notes, ...warnOrNot(warnings(plan.after, [...ctx.refs])) };
  const actE = actOf(w, actor, verb, sent, ctx.actExtra);
  const changeE = changeShape(plan, w.entries.length, w);
  w.fits(actE, changeE); // both lines fit, or neither is written
  // the budget counts THIS write too, not only what came before it (review 10-14 C0: a 300 KiB batch in an empty window passed a 256 KiB cap)
  if (!ctx.cap || ctx.cap.kind === "reaction" || ctx.cap.kind === "handle") rateCheck(w, actor, "act", JSON.stringify(actE).length + JSON.stringify(changeE).length);
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
  // a seat gone or switched off lets its rider go: told in their inbox like any unseat (holes r10 L6), with where the track restarts
  for (const who of Object.keys(w.presence.seats ?? {})) if (!seatOf(w, after, who)) { const to = w.presence.seats[who]?.to; const why = "the socket they sat on was switched off or removed";
    const at = typeof to === "string" && st.entities[to] ? unseatAt(w, st, who, to) : null; clearSeat(w, who); ctx.notes.push({ who, unseated: true, why });
    if (typeof to === "string") inboxPush(w.presence, who, { type: "unseated", seat: to, by: actor, why: `${to}: ${why}`, ...(at ? { at } : {}) }); }
  return { ok: true, seq, head: w.headAt(seq), act, refs: [...ctx.refs].filter((id) => after.entities[id]).map((id) => ({ id, born: after.entities[id].born })),
    after: touched(plan.ops, after), ...(ctx.undid ? { undid: ctx.undid } : {}), ...(ctx.notes.length ? { notes: ctx.notes } : {}), ...warnOrNot(warnings(after, [...ctx.refs])) };
}
// review S2.4 (R 10-12): a geometry write moves a thing's top (a mesh resized, a model swapped, its scale changed), and what the
// physics had stacked on it (its dynamic children, attached by their rest) kept their local pose: floating over a shrunk
// plinth, or scaled with a model's new size. They are re-dropped: under a carried engine a zero-velocity launch from where
// each stands (the engine logs where it lands, as a grab's fallen dependents are); with no engine, set straight down onto
// what is under them. A held, locked or already flying child is left alone. A move or a turn is not a geometry write: the
// stack rides along, as it always did.
// The authority's consequence, not the asker's write (scars r10 M3): written by `system` under its own act, `resettle {hosts,
// riders}`, caused by the asker's act (as settle and return-lost are), so the entry never says the asker moved someone else's things.
function resettleRiders(w, asker, ops, before, after0, cause, notes) { let after = after0; const actor = "system"; let act = null;
  const own = (riders) => (act ??= w.append({ kind: "act", actor, verb: "resettle", cause, body: { hosts: [...hosts], riders, asked: asker } }));
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
  // the ground still loading: a fall would rest on a guessed height (review r4 F2) — they are left as they are on the host
  // (its local pose kept: a rescaled host carries them with it, r5 F6), said so
  if (!groundReady(after)) { notes.push({ kept: riders, why: "they were resting on a thing whose shape changed, but this world's ground is still loading: they are left as they are on it (a rescaled host carries them with it) rather than fall onto a guessed height" }); return; }
  if (spec && carried(spec)) {
    const flying = new Set(Object.keys(w.sim?.()?.launched ?? {}));
    const dropped = riders.filter((k) => !flying.has(k));
    // out from under the host first, standing where it stood in the world: its rest re-attaches it to whatever it lands on
    // with a fresh local pose (a rest keeps a child's recorded scale, and that scale was compensation for the OLD host size)
    // (as it stood BEFORE the write: a model host's new scale had already carried the child's world pose and size with it)
    if (dropped.length) { const free = dropped.flatMap((k) => { const t = worldT(before, k); return [delOp(k, "parent"), setOp(k, "transform", { pos: t.pos.map(r3), q: qr3(t.q), scale: t.scale.map(r3) })]; });
      const plan = admit(w, after, { actor, cap: { kind: "system", ids: dropped, comps: ["transform", "parent"] } }, free); changeEntry(w, plan, own(dropped)); after = w.state(); }
    for (const k of dropped) { const t = worldT(before, k);
      w.append({ kind: "sim", actor, cause: own(dropped), verb: "launch", body: { id: k, p: t.pos.slice(), yaw: qYaw(t.q), ...(ENGINES[spec.engine]?.rotates ? { q: t.q.slice() } : {}), v: [0, 0, 0], handled: [asker] } }); }
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
  changeEntry(w, plan, own([...new Set(setOps.map((o) => o.id))]));
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
  // a thing that moves by its motion or opens is a KINEMATIC collider (PHYSICS §3.3; shape audit 10-16): the stamp says so
  // (eidosim carries kinematic as static, so behaviour is unchanged; the record no longer says "never moves")
  for (const o of ops) if (o.verb === "set" && o.comp && (o.comp === "motion" || o.comp.startsWith("motion:") || o.comp === "openable")) ids.add(o.id);
  const moves = (id) => { for (let k = id, n = 0; k && n < 33; k = after.entities[k]?.c.parent?.to, n++) { const c = after.entities[k]?.c; if (!c) break;
    if (c.openable !== undefined || Object.keys(c).some((x) => x === "motion" || x.startsWith("motion:"))) return true; } return false; };
  if (simOn) for (const o of ops) if (o.verb === "create") ids.add(o.id);
  if (ops.some((o) => o.id === "@world" && o.comp === "physics-engine" && o.verb === "set") && simOn) for (const id of Object.keys(after.entities)) ids.add(id);
  ids.delete("@world");
  const out = ops.slice(); const stamped = [], unstamped = [], rounded = [];
  for (const id of ids) {
    const e = after.entities[id]; if (!e) continue;
    const ph = e.c.physics; const want = typeof e.c.model === "string" ? shapeFor(e.c.model, e.c.collider?.shape) : e.c.mesh !== undefined ? meshShape(e.c.mesh) : null;
    let next;
    if (ph === undefined || ph === null) { if (!simOn || !want) continue; next = { kind: moves(id) ? "kinematic" : "static", shape: want }; }
    else if (typeof ph !== "object" || Array.isArray(ph)) continue; // valueCheck refuses it
    else if (ph.kind === "static" && moves(id) && !ops.some((o) => o.verb === "set" && o.comp === "physics" && o.id === id)) next = { ...ph, kind: "kinematic", ...(want ? { shape: want } : {}) };   // it started moving
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
// R 10-17: a model is its library path; what its bytes were rides beside it as model-hash (sha256:<64 hex>), stamped by the
// authority when its catalogue already knows the hash (server/modelcatalogue.ts measures it off the request path: warm, before
// the authority sees the request) and never computed here. A model it can't hash carries none: the old one named other bytes,
// so a change of model drops it. A capability (a handler, a script) never sets a server-written component, so under one the
// stale hash is only dropped. A content address written as the model (one stored before 10-17) is its own hash.
const hashOfModel = (m) => { if (typeof m !== "string") return null; const a = eidoHex(m); if (a) return `sha256:${a}`;
  let h = null; try { h = CTX.cat.get(m)?.sha256; } catch { h = null; } return typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? `sha256:${h}` : null; };
function stampModelHash(ctx, ops) {
  const ids = new Set(); for (const o of ops) if ((o.verb === "set" || o.verb === "delete") && o.comp === "model") ids.add(o.id);
  // a fork's copy carries what its parent holds (review r8 H2): a hash measured since, or none, is the parent's to stamp
  if (!ids.size || CTX.forking) return ops;
  const after = scratch(ctx.st, ops); const out = ops.slice();
  for (const id of ids) {
    const e = after.entities[id]; if (!e) continue;   // the thing itself is gone
    const was = ctx.st.entities[id]?.c.model, now = e.c.model; if (now === was) continue;
    const want = ctx.cap ? null : hashOfModel(now), have = e.c["model-hash"];
    if (want) { if (have !== want) { const k = out.findIndex((o) => o.verb === "set" && o.comp === "model-hash" && o.id === id); if (k >= 0) out[k] = setOp(id, "model-hash", want); else out.push(setOp(id, "model-hash", want)); } }
    else if (have !== undefined && !ops.some((o) => o.id === id && o.comp === "model-hash")) out.push(delOp(id, "model-hash"));
  }
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

// authored: who AUTHORED its current value (a handler's author, review r9 H1): the authority's follow-ups (a reference cleared
// because what it named was deleted, or put back by that delete's undo; the entry's own `followUps`) are skipped, so an owner's
// cleanup never re-authors a demoted builder's handlers with the owner's rights, nor a visitor's delete an owner's. A follow-up
// that removed the component leaves no author (null). Without it: the last write of any kind (a version, a conflict check).
function lastTouch(w, id, comp, { editsOnly = false, authored = false } = {}) {
  let restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    if (editsOnly && w.entries[e.cause]?.body?.capability) continue;   // a use's own write (a toggle flipped it): not an author
    const ops = opsQuiet(e), fu = authored ? followUpsOf(e) : null;
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "create" || o.comp === comp || (o.verb === "delete" && o.comp === undefined)) {
        // a follow-up set put a value back (an undo's restore, review r10 M2): it also steps over the follow-up delete it reverses
        if (fu?.has(k)) { if (o.verb === "set") { restored = true; continue; } if (o.verb === "delete" && restored) { restored = false; continue; } return null; }
        return { seq: i, actor: e.actor }; } } }
  return null;
}
// who last changed each component, within a horizon of this thing's own recent entries (R 10-04: "only the most recent
// x log steps… after that a deep search"). Past the horizon it says so ({beyond}) — never "default" or "never changed".
export const TOUCH_HORIZON = 200;
function touchedOf(w, id, comps, horizon = TOUCH_HORIZON) {
  const out = {}; const want = new Set(comps); let seen = 0, oldest = null;
  for (const i of backward(w, id)) { if (!want.size || seen >= horizon) break; const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    seen++; oldest = i; const fu = followUpsOf(e);
    opsQuiet(e).forEach((o, k) => { if (o.id !== id) return;
      const hit = o.verb === "create" ? [...want] : want.has(o.comp) ? [o.comp] : [];
      // a follow-up (a reference cleared by a delete, review r9 H1) says so: `by` caused it, but didn't author the value
      for (const c of hit) { out[c] = { seq: i, by: e.actor, who: said(e.actor), ts: e.ts, ...(o.verb === "create" ? { created: true } : {}), ...(fu.has(k) ? { followUp: true } : {}) }; want.delete(c); } }); }
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
const MOTION_AXES = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], "-x": [-1, 0, 0], "-y": [0, -1, 0], "-z": [0, 0, -1] };   // motioneval.js AXES
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
  // one spelling per meaning (shape audit 10-16): what a write may say the short way is stored the one way
  if (comp === "lock" && value === true) { ctx.notes.push({ id, component: "lock", sent: true, kept: { rank: "builder" }, why: "a lock is {rank}; true is the builder level" }); value = { rank: "builder" }; }
  if (comp === "home" && value && typeof value === "object" && !Array.isArray(value) && typeof value.scale === "number") value = { ...value, scale: [value.scale, value.scale, value.scale] };
  // a reference is stored as written (R 10-17: a model's library path, an Essential's name, a grass preset's name;
  // shared/protocol/assetref.js): grass's first-protocol knobs are mapped to the flora spelling, and a preset is checked
  if (comp === "grass") { let r;
    try { r = atWrite(comp, value); } catch (x) { refuse("shape", `${id}.${comp}: ${String(x?.message ?? x).replace(/^\[flora\] /, "")}`, COMPONENTS.grass.help); }
    for (const n of r.notes) ctx.notes.push({ id, component: comp, ...n }); value = r.value; }
  // a light's day (a double negative) is daytime (shape audit 10-16): true = dim, false = full
  if (comp === "light" && value && typeof value === "object" && !Array.isArray(value) && typeof value.day === "boolean") { const { day, ...rest } = value;
    value = { ...rest, daytime: rest.daytime ?? (day ? "dim" : "full") }; ctx.notes.push({ id, component: comp, field: "day", sent: day, kept: value.daytime, why: "a light's day is daytime: dim | full" }); }
  // a terrain layer's colour is an int, as every colour (shape audit 10-16): "#rrggbb" is taken
  if (comp === "terrain" && value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.layers) && value.layers.some((l) => typeof l?.color === "string" && /^#[0-9a-f]{6}$/i.test(l.color)))
    value = { ...value, layers: value.layers.map((l) => (typeof l?.color === "string" && /^#[0-9a-f]{6}$/i.test(l.color) ? { ...l, color: parseInt(l.color.slice(1), 16) } : l)) };
  // a sky written by hand is stamped like the sky act's: ts is the instant its hours held (the stamped fields are refused in buildSet)
  if (comp === "sky" && value && typeof value === "object" && !Array.isArray(value) && value.ts === undefined) value = { ...value, ts: Math.floor(ctx.w.now()) };
  if (isLookAt(comp) && value && typeof value === "object" && !Array.isArray(value)) { const AXV = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };   // the letters the door takes (tools/lookat-forward-check: no negative letter)
    for (const f of ["forward", "up"]) if (typeof value[f] === "string" && AXV[value[f]]) value = { ...value, [f]: AXV[value[f]].slice() }; }
  // every parameter written down (PROTOCOL §4): the definition's defaults and per-kind rules (componentspec materialize)
  const filled = (v, list) => { if (list.length) ctx.notes.push({ id, component: comp, filled: list, why: "defaults written out so the engine can't change them later" }); return v; };
  // an axis is a vector (PROTOCOL §9.2): the letters the readers take are stored as their vectors
  if ((comp === "motion" || comp.startsWith("motion:")) && value && typeof value === "object" && !Array.isArray(value) && typeof value.axis === "string" && MOTION_AXES[value.axis.toLowerCase()]) {
    ctx.notes.push({ id, component: comp, field: "axis", sent: value.axis, kept: MOTION_AXES[value.axis.toLowerCase()], why: "an axis is stored as a vector" }); value = { ...value, axis: MOTION_AXES[value.axis.toLowerCase()].slice() }; }
  if (comp === "collider" && value && typeof value === "object" && !Array.isArray(value) && value.shape === "exact") { ctx.notes.push({ id, component: comp, field: "shape", sent: "exact", kept: "mesh", why: "mesh is the word for its triangles" }); value = { ...value, shape: "mesh" }; }
  if (comp === "parent" && value && typeof value === "object" && !Array.isArray(value) && "order" in value) { const { order, ...rest } = value; ctx.notes.push({ id, component: comp, field: "order", sent: order, why: "siblings have no stored order: dropped" }); value = rest; }
  if (comp === "motion" && value && typeof value === "object") { const m = materialize("motion", value); const v = filled(m.value, m.filled);
    if (v.t0 === undefined) { v.t0 = ctx.w.now(); ctx.notes.push({ id, component: "motion", field: "t0", kept: v.t0, why: "stamped by the authority" }); } return v; }
  // a part's motion (motion:<part>) runs on the same clock: without a stamp every client started it from its own first
  // look and disagreed on its phase (a swing's seat, locked to that phase, pumped out of step on every screen)
  if (comp.startsWith("motion:") && value && typeof value === "object" && !Array.isArray(value)) {
    // the node it moves is data in the value; a write that leaves it out names the node its key's tag spells (the reading
    // before 10-16), written down
    if (!(typeof value.node === "string" && value.node)) { value = { ...value, node: comp.slice(7) }; ctx.notes.push({ id, component: comp, field: "node", kept: value.node, why: "the node it moves, written down (absent, its key's tag)" }); }
    const m = materialize("motion", value); const v = filled(m.value, m.filled);
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
// a fresh id: never one this world has had (§3d H7), nor one already used in this request (`also`)
// review 10-07 H5: 26 base32 (shared/protocol/ids.js), never <slug>-<count>, which two forks minted alike; R 10-17: no slug
// at all (a word in an id goes stale; the label is the name)
function mint(st, also = null) { const ever = CTX.mintW?.everIds() ?? new Set(); let id;
  do id = mintId(); while (st.entities[id] || ever.has(id) || also?.has(id)); return id; }

// create {at} without from (holes review 10-15 M1: it was never read, and the thing landed at the origin with ok):
// [x, z] is on the ground there (place {at}: returned, for buildCreate to place); [x, y, z] is its origin exactly; {pos?,
// yaw|q?, scale?} replaces those fields of its transform, as with from (resolve turns a yaw into q, as place does).
// Anything else is a shape refusal, and so is at with place: one way of saying where.
const AT_FIX = "at: [x, z] on the ground, [x, y, z] exactly, or {pos: [x, y, z], yaw} (or q); or place {…} instead";
function createAt(a, comps) {
  const at = a.at; if (at === undefined) return null;
  if (a.place) refuse("shape", "create takes at or place, not both", AT_FIX);
  const nums = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
  if (nums(at, 2)) return [at[0], at[1]];
  if (nums(at, 3)) { comps.transform = { ...(comps.transform ?? {}), pos: [...at] }; return null; }
  const keys = at && typeof at === "object" && !Array.isArray(at) ? Object.keys(at) : null;
  if (!keys?.length || keys.some((k) => !["pos", "yaw", "q", "scale"].includes(k)) || (at.pos !== undefined && !nums(at.pos, 3))
    || (at.yaw !== undefined && !Number.isFinite(at.yaw)) || (at.yaw !== undefined && at.q !== undefined))
    refuse("shape", `create's at is a point or {pos, yaw}: got ${JSON.stringify(at).slice(0, 80)}`, AT_FIX);
  comps.transform = { ...(comps.transform ?? {}), ...at }; return null;
}
function buildCreate(ctx, a) {
  if (a.from) return buildCreateFrom(ctx, a);
  const comps = { ...(a.components ?? {}) };
  if (a.model) comps.model = a.model;
  const placeAt = createAt(a, comps);
  const id = a.id ?? mint(ctx.st);   // a placeholder's minted id (request()), a fork's copied one, or minted here
  if (!isEntityId(id) || id === "@world") refuse("shape", `'${id}' isn't an id you can make`, "§3.1: a–z, 0–9 and '-', up to 64; leave id out and the authority mints one");
  if (ctx.st.entities[id]) refuse("exists", `'${id}' already exists`, "leave id out and the authority mints one");
  for (const k of Object.keys(comps)) if (!isComponent(k)) refuse("shape", `'${k}' isn't a component name`, "§3.1: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key>", { didYouMean: guess(k, Object.keys(COMPONENTS)) });
  for (const k of Object.keys(comps)) handWrite(ctx, id, k);
  const out = {};
  for (const [k, v] of Object.entries(comps)) out[k] = resolve(ctx, id, k, v);
  if (!out.transform) out.transform = resolve(ctx, id, "transform", {});
  ctx.refs.add(id); // who made it is the create entry's actor: a view, never a stored `placer` (L2)
  const made = createOps(id, out);
  const place = placeAt ? { at: placeAt } : a.place;
  if (!place) return made;
  admit(ctx.w, ctx.st, { actor: ctx.actor }, made);   // the one gate before place solves (security pass 2 H-A); again on the whole write after
  const placed = buildPlace({ ...ctx, st: scratch(ctx.st, made) }, { ...place, id, __made: true });
  return [...made.filter((o) => !(o.verb === "set" && (o.comp === "transform" || o.comp === "parent"))), ...placed.filter((o) => o.verb === "set")];
}

// a server-written component (componentspec writtenBy) named in a request by hand, below owner
const serverWritten = (at) => refuse("server-written", `${at} is written by the server (on a copy of a blueprint, a duplicate or a rebase), not by hand`, "create {from: <blueprint hash or a thing's id>} makes a copy that carries it; rebase moves a copy to a newer record");
const handWrite = (ctx, id, comp) => { if (defOf(comp)?.writtenBy === "server" && roleOf(ctx.st, ctx.actor) !== "owner") serverWritten(`${id}.${comp}`); };
function buildSet(ctx, a) {
  const e = needThing(ctx, a.id); handWrite(ctx, a.id, a.component);
  if (!isComponent(a.component)) refuse("shape", `'${a.component}' isn't a component name`, "§3.1: [a-z][a-z0-9-]*, optionally <domain>/, @<n> and :<key> (ASCII only)", { didYouMean: guess(String(a.component), Object.keys(COMPONENTS)) });
  const lt = lastTouch(ctx.w, a.id, a.component); const base = a.base === undefined ? undefined : versionSeq(ctx.w, a.base, "base");
  // No `current` here, for the same reason as expect's (attack-check H5a/H5c): buildSet runs inside commit's
  // build(ctx) BEFORE admit, so before rights/lacks/lockCheck, and a dry request is never logged — a value echoed
  // here is a direct read of any component of anything, through a lock, by anyone, with no trace. The fix line
  // already sends them to `inspect`, which is rights-checked. `version`/`by` stay: history is READ_ONLY + GHOST_OK,
  // so who-touched-what-when is public already.
  if (base !== undefined && lt && lt.seq > base) refuse("stale", `${a.id}.${a.component} changed since version ${base}: ${said(lt.actor)} set it at ${lt.seq}`, a.merge ? `inspect {id: '${a.id}'} for the current value and its new version, then re-send with that base` : `inspect {id: '${a.id}'} for the current value and version, then decide; or merge: true to change only your fields`, { version: lt.seq, by: lt.actor });
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
  // a field the authority stamps (componentspec `stamped`: the sky's ts, override, a forecast's epoch) is never taken from a
  // writer (shape audit 10-16): the act that owns it stamps it (sky, weather)
  for (const f of defOf(a.component)?.stamped ?? []) { const path = f.split("."); let x = a.value;
    for (const k of path) x = x && typeof x === "object" && !Array.isArray(x) ? x[k] : undefined;
    if (x !== undefined) refuse("stamped", `${a.id}.${a.component}.${f} is stamped by the authority, never written`, a.component === "sky" ? "leave it out: the sky act stamps ts and a forecast's epoch, the weather act an override (sky {…} / weather {weather})" : "leave it out"); }
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
  const gone = new Set([a.id, ...kids]); const ops = [...kids.reverse(), a.id].map((id) => delOp(id));   // references to them are cleared by commit (clearRefsTo)
  const after = scratch(ctx.st, ops); const setDown = [];
  // only what stands over a surface of what's gone can have rested on it (the index: its neighbours, never the world)
  const ixb = spatial(ctx.st); const over = new Set();
  for (const g of gone) for (const s of ixb.rec.get(g)?.surfs ?? []) for (const id of near(ctx.st, [s.min[0], s.y - 0.02, s.min[1]], [s.max[0], Infinity, s.max[1]])) over.add(id);
  // the set-down is the authority's consequence of the delete, so a follow-up (scars r10 M3): admitted without the deleter's rights or
  // the rider's lock, so nobody pins a thing against deletion by resting something of theirs on it. In a hand or in flight isn't resting
  const sf = ctx.w?.sim?.();
  for (const id of Object.keys(after.entities)) { if (!over.has(id)) continue; const b = aabb(after, id); if (!b || after.entities[id].c.parent) continue;
    if (ctx.w?.presence.holds?.[id] || sf?.launched?.[id]) continue;
    const before = supportBelow(ctx.st, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    if (!gone.has(before.id)) continue;
    const now = supportBelow(after, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    const t = worldT(after, id); ops.push(followUp(setOp(id, "transform", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] }))); setDown.push({ id, onto: now.id }); ctx.refs.add(id); }
  if (setDown.length) ctx.notes.push({ setDown, why: "they were resting on what you deleted, so they were set down on what's below" });
  return ops;
}

// R 10-17 (ID HARDENING (4)): a thing's deletion nulls the typed references to it (and to the children that go with it) in
// the same act, as Unity, Unreal and Resonite do — a reference never outlives what it names. A list loses the entry; a single
// reference's field goes, and with it a value that can't stand without it (look-at's target: the look-at goes); a reset
// left with no targets is dropped from the reactions (it can't send nothing home); a home's parent goes (home under the
// root). Parent links need nothing here: the children went with it. The reply's note lists every reference cleared.
const refComps = new Map();   // component name → does it hold references (the registry's typed fields)
const holdsRefs = (k) => { let v = refComps.get(k); if (v === undefined) { v = refFields(k).length > 0; refComps.set(k, v); } return v; };
// v with its references to `gone` nulled, and what can't stand without them dropped; undefined when the whole value goes
function withoutRefs(id, k, v, gone, cleared = [], dropped = []) {
  const r = mapRefs(k, v, (x, at) => { if (!gone.has(x)) return x; cleared.push({ from: `${id}.${at.replace(/^[^.]*/, k)}`, was: x }); return null; });
  let nv = r.value;
  if (nv !== undefined && baseOf(k) === "reactions") { nv = { ...nv };
    for (const [act, hd] of Object.entries(nv)) if (hd && typeof hd === "object" && Array.isArray(hd.targets) && !hd.targets.length) { delete nv[act]; dropped.push(`${id}.${k}.${act}`); } }
  if (nv !== undefined && baseOf(k) === "home" && nv.parent && typeof nv.parent === "object" && nv.parent.to === undefined) { const { parent, ...rest } = nv; nv = rest; }
  if (nv === undefined || (baseOf(k) === "reactions" && !Object.keys(nv).length)) { dropped.push(`${id}.${k}`); return undefined; }
  return nv;
}
function clearRefsTo(ctx, gone) {
  const ops = [], cleared = [], dropped = [];
  for (const [id, e] of Object.entries(ctx.st.entities)) { if (gone.has(id)) continue;
    // a script's scope is left alone (review r8 H1): a scope id that names nothing reaches nothing (scopeIds), an id is never
    // reused (§3d H7), and a write to script:<name> would re-sponsor it to the deleter (sponsorOf: the latest non-pause write)
    for (const [k, v] of Object.entries(e.c)) { if (k === "parent" || baseOf(k) === "script" || baseOf(k) === "parent" || !holdsRefs(k) || v === PURGED) continue;
      if (!refsOf(k, v).some((r) => gone.has(r.id))) continue;
      const nv = withoutRefs(id, k, v, gone, cleared, dropped);
      if (nv === undefined) ops.push(followUp(delOp(id, k)));
      else ops.push(followUp(setOp(id, k, nv)));
      ctx.refs.add(id); } }
  if (cleared.length) ctx.notes.push({ cleared, ...(dropped.length ? { removed: dropped } : {}), why: `references to what you deleted were cleared in the same act${dropped.length ? " (a value that can't stand without its reference, or a reset left with nothing to send home, went with it)" : ""}` });
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
    ops.push(setOp(a.id, "parent", { to: support }));
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
// a stored reference that names nothing (R 10-17 ID HARDENING (4)): a write can't make one (every ref is checked) and a delete
// clears them, but an old log, an import or a merge can hold one. lint says where it is and what it names.
function danglingRefs(st, ids) {
  const out = [];
  for (const id of ids) { const e = st.entities[id]; if (!e) continue;
    for (const [k, v] of Object.entries(e.c)) { if (v === PURGED || !holdsRefs(k)) continue;
      for (const r of refsOf(k, v)) if (!st.entities[r.id]) out.push({ id, kind: "dangling", at: `${id}.${r.path.replace(/^[^.[]*/, k)}`, names: r.id, fix: `nothing here is called '${r.id}': point it at something that is, or clear it` }); } }
  return out;
}
function warnings(st, ids, strict = false) {
  const out = []; const ix = spatial(st); const pairs = new Map();   // id → the things it was already said to overlap
  // the ground still loading (r3 F3): no sunk/floating advice; a strict check (a put's claim) has nothing to judge it on and
  // is refused ground-loading below, never waved through (r4 F3)
  const B = boundsOf(st), ground = groundReady(st); let k = 0; const was = CTX.work.what;
  CTX.work.what = ids.length === 1 ? `checking ${ids[0]}` : `checking ${ids.length} things`;
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
    if (!ground) { if (strict) groundOf(st).height(cx, cz);   // refuses ground-loading, in the ground's own words
      if (B && (outsideWorld(B, b.min) || outsideWorld(B, b.max))) out.push({ id, kind: "out-of-bounds", bounds: B }); continue; }
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

// ---------- use (interaction): authority/use.js ----------
// ---------- behaviours (L4, L7 as revised; research 41; the lab's slice, the protocol lab's authority.js @ 2300bae, on a real sandbox) ----------
// A script is a keyed component `script:<name>` naming a source blob ({lang: "js", api, text}, by its sha256 name) and a
// declared SCOPE. Its sponsor is whose rights admitted the LATEST write to that key in its current life (§5 "Two views"):
// a view, never a stored field. Every activation is a fresh admission with capability {kind: "script"}: the sponsor's
// rights NOW, narrowed to the scope. The visitor who triggers it adds nothing. An activation that changes something is
// ---------- behaviours, standing: authority/scripts.js ----------
// ---------- behaviours, running: authority/scriptrun.js ----------

// ---------- the act index, undo: authority/undo.js ----------
// ---------- blueprints, reads: authority/blueprints.js ----------
// ---------- physics (design 20): authority/physics.js ----------
// ---------- riders: authority/riders.js ----------
// ---------- the verbs a body performs: authority/bodyverbs.js ----------
// ---------- what a body does to a loose thing: authority/manipulate.js ----------
// ---------- body consent: authority/bodyconsent.js ----------
// ---------- acting on a person: authority/moderation.js ----------
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
    // born in today's spelling (shapes: the shape repair's version): the load's repair never runs on this world (liftWorld)
    changeEntry(w, plan, w.append(actOf(w, actor, "create-world", a, { shapes: SHAPES_VERSION })));
    // …and the marker itself is the system's repair-shapes act beside it (review r8 M3): read by verb and actor only, which
    // a purge never reaches (the founding's body holds the title, the first thing an owner might purge)
    w.append(actEntry(w, "system", "repair-shapes", { v: SHAPES_VERSION, ids: [], founding: true }));
    return { ok: true, world: w.name, you: "owner", ...(a.ownerKey ? {} : { governance: "tier 0 is empty: this server's operator key is the world's top governance key (PROTOCOL §13). Founding with ownerKey (your own ed25519 key) puts you there instead; tier 0 can't be filled later" }) };
  },
  ...READ_VERBS,
  // particles names an effect: its schema also lists the Essentials and each one's params (the knobs an instance sets), so
  // an agent can write one without a second question; effect {name} returns a whole document
  // every definition carries its status (trial | reserved | stable); statuses says what each means
  // and server: this server's policy numbers (PROTOCOL §9.2): the default an absent field means today, and the ceiling an owner may set
  schema(w, actor, a) { return { ok: true, components: a.component ? { [a.component]: COMPONENTS[a.component] } : COMPONENTS, statuses: STATUSES,
    server: { defaults: { capacity: { ...CAPACITY }, "script-settings": scriptDefaults() }, ceilings: { capacity: { ...CAPACITY_CEILING }, "script-settings": scriptCeiling() } },
    ...(a.component === "particles" ? { effects: Object.fromEntries(ESSENTIAL_NAMES.map((k) => { const d = effectFor(k); return [k, { reads: d.reads, params: Object.fromEntries(Object.entries(d.params ?? {}).map(([n, p]) => [n, { type: p.type, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.values ? { values: p.values } : {}), ...(p.help ? { help: p.help } : {}) }])) }]; })) } : {}) }; },
  create: (w, actor, a) => commit(w, actor, "create", a, (ctx) => buildCreate(ctx, a)),
  set: (w, actor, a) => commit(w, actor, "set", a, (ctx) => buildSet(ctx, a)),
  delete: (w, actor, a) => commit(w, actor, "delete", a, (ctx) => buildDelete(ctx, a)),
  place: (w, actor, a) => commit(w, actor, "place", a, (ctx) => buildPlace(ctx, a)),
  turn: (w, actor, a) => commit(w, actor, "turn", a, (ctx) => buildTurn(ctx, a)),
  publish: (w, actor, a) => commit(w, actor, "publish", a, (ctx) => buildPublish(ctx, a, w)),
  update: (w, actor, a) => commit(w, actor, "update", a, (ctx) => buildUpdate(ctx, a, w)),
  ...USE_VERBS,
  ...MOD_VERBS,
  say(w, actor, a) { if (!a.text) refuse("shape", "say needs text", "");
    // a chat mute refuses every say: a say with `to` is still a public line in the log (review 10-07). Asking a moderator
    // why goes as a WHISPER (point-to-point, never logged; the server lets a muted person whisper moderators only)
    { const m = muteOf(w, actor, "chat"); if (m)
      refuse("muted", `you're muted in this world's chat${m.until !== undefined ? ` until ${new Date(m.until).toISOString()}` : ""}${m.reason ? ` (${m.reason})` : ""}`, "you may still whisper to a moderator (/w <name>)", { until: m.until ?? null }); }
    if (typeof a.text !== "string" || a.text.length > SAY_MAX) refuse("too-big", `a say is at most ${SAY_MAX} characters (this one is ${String(a.text).length})`, "split it, or put a long text in a blob");
    if (a.to !== undefined && (typeof a.to !== "string" || a.to.length > 64)) refuse("shape", "say.to names one person: a string of at most 64 characters", "say {text, to: '<identity>'}");
    const body = { text: a.text, ...(a.to ? { to: a.to } : {}), ...spokenOf(a, w.now()) };
    rateCheck(w, actor, "say", JSON.stringify(body).length); const seq = w.append({ kind: "say", actor, verb: "say", body }); (w.sayQ ??= []).push(seq); return { ok: true, seq }; }, // w.append refuses too-big before writing
  undo: (w, actor, a) => commit(w, actor, "undo", a, (ctx) => buildUndo(ctx, a, w)),
  // ---- captions: one line of what a screen said (a captioner bot, live subtitles). Rights live on the SCREEN: its
  // `captioners {ids}` names who may caption it (anyone who may edit the screen may too); nobody else, and no `set` by
  // hand, writes `captions`. The rules are shared/captions.js's: a session, a strictly rising n within it, a leg
  // generation (the server stamps `gen` from the connection: a superseded captioner can't write over its successor),
  // and `end` to clear the screen. The bag keeps the newest lines (CAPTIONS_MAX_LINES). ----
  caption: (w, actor, a) => commit(w, actor, "caption", a, (ctx) => {
    const n = normalizeCaptionArgs(a); if (!n.ok) refuse("shape", n.why, "caption {id, session, n, t0, t1, text, speaker?, title?} | {id, session, end: true}");
    const id = n.args.id; const e = ctx.st.entities[id]; if (!e) refuse("not-found", `nothing here called ${id}`, "look lists what's here");
    const args = { ...n.args, gen: Number.isSafeInteger(a.gen) && a.gen >= 0 ? a.gen : 0 };
    const why = captionRefusal(e.c.captions, args); if (why) refuse("caption", why, "a resend of a line already written is refused: read that as its receipt");
    ctx.cap = { kind: "caption", ids: [id], comps: ["captions"] };
    const next = foldCaption(e.c.captions, args);
    return [next ? setOp(id, "captions", next) : delOp(id, "captions")];
  }),
  ...SCRIPT_VERBS,
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
/** Every verb the authority answers (VERBSPEC must have a row for each: scars-check's verb-row check). */
export const VERB_NAMES = Object.freeze(Object.keys(VERBS));
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
// the leaves reach the layers above them through UP (authority/ctx.js): bound here, once every module has loaded
Object.assign(UP, { actEntry, actOf, activate, admit, body, boundsOf, changeEntry, changeShape, commit, danglingRefs, dist, enter, guess, handOf, historyDiff, holdsRefs, homeScale, isNum, lacks, lastTouch, mint, nearMiss, needThing, needWords, notAThing, offRefuse, opsTouching, outsideWorld, rateCheck, request, resolve, restampEngine, returnDue, returnHome, returnPlan, sameHome, seatOf, setSeat, settleSim, sitterOn, touchedOf, unknownKeys, vec3s, warnings, withoutRefs });
