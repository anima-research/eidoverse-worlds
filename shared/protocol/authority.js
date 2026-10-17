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
import { checkSockets, checkSocket, checkStation, inSitReach, OCCUPY_REACH } from "../sockbody.js";
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
import { clearOccupant, leftOccupied, occupiedRefuse, occupantOf, occupyRights, setOccupant, occupantOn, vacateAt, vacateWhy, vacatesFor } from "./authority/occupants.js";
import { arrivalBox, body, buildEpoch, dist, gripPoint, gripOf, lawOf, pathBlocked, restampEngine, settleSim, shearFree, sizeOf, solidAt } from "./authority/physics.js";
import { fliesIn, flyingWorld, gripHow, homeScale, launch, recentRests, releasePos, returnDue, returnHome, returnPlan, sameHome, secondGrip, shaped, shoveGate, snapTarget, stampHomes, stampResetHomes, vec3s } from "./authority/manipulate.js";
import { EMBODIED_VERBS } from "./authority/bodyverbs.js";
import { CAPACITY, CAPACITY_CEILING, capacityCheck } from "./authority/capacity.js";
export { CAPACITY, CAPACITY_CEILING } from "./authority/capacity.js";
import { isLookAt, isNum, nearMiss, restCheck, unknownKeys, valueCheck } from "./authority/checks.js";
export { schemaRefusal } from "./authority/checks.js";
import { Admitted, SAY_MAX, admit, lacks, lockCheck, needWords, rateCheck, spokenOf } from "./authority/gate.js";
export { keyKind, seniorOwnerOf } from "./authority/gate.js";
import { clearRefsTo, danglingRefs, historyDiff, holdsRefs, lastTouch, opsTouching, resettleRiders, stampMedia, stampModelHash, stampShapes, stripDry, touched, touchedOf, warnOrNot, warnings, withoutRefs } from "./authority/followups.js";
export { TOUCH_HORIZON } from "./authority/followups.js";
import { actEntry, actOf, boundsOf, buildCreate, buildDelete, buildPlace, buildSet, buildTurn, changeEntry, changeShape, commit, mint, needThing, notAThing, offRefuse, outsideWorld, resolve, serverWritten } from "./authority/writes.js";
import { BATCH_VERBS, FOUNDING_VERBS, SAY_VERBS, SCHEMA_VERBS, WRITE_VERBS } from "./authority/verbs.js";


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

// ---------- L7, the one gate: authority/gate.js ----------
// ---------- occupyRights (a socket joining a host): authority/occupants.js ----------
// ---------- how much a world holds: authority/capacity.js ----------
// ---------- the gate's value checks: authority/checks.js ----------
// ---------- the write path: authority/writes.js ----------
// ---------- follow-ups, reference clears, history readers: authority/followups.js ----------


// ---------- use (interaction): authority/use.js ----------
// ---------- behaviours, standing: authority/scripts.js ----------
// ---------- behaviours, running: authority/scriptrun.js ----------

// ---------- the act index, undo: authority/undo.js ----------
// ---------- blueprints, reads: authority/blueprints.js ----------
// ---------- physics (design 20): authority/physics.js ----------
// ---------- riders: authority/occupants.js ----------
// ---------- the verbs a body performs: authority/bodyverbs.js ----------
// ---------- what a body does to a loose thing: authority/manipulate.js ----------
// ---------- body consent: authority/bodyconsent.js ----------
// ---------- acting on a person: authority/moderation.js ----------
// ---------- the verb table's bodies: authority/verbs.js ----------
const VERBS = {
  ...EMBODIED_VERBS,
  ...BODY_VERBS,
  ...FOUNDING_VERBS,
  ...READ_VERBS,
  ...SCHEMA_VERBS,
  ...WRITE_VERBS,
  ...USE_VERBS,
  ...MOD_VERBS,
  ...SAY_VERBS,
  ...SCRIPT_VERBS,
  ...BATCH_VERBS,
};
/** The fork's copy acts (server/worldlog.ts copyInto): the batch request, logged as verb fork-copy. */
/** Every verb the authority answers (VERBSPEC must have a row for each: scars-check's verb-row check). */
export const VERB_NAMES = Object.freeze(Object.keys(VERBS));
export function forkCopy(w, actor, args) { CTX.forking = true; try { return request(w, actor, "fork-copy", args); } finally { CTX.forking = false; } }
// the leaves reach the layers above them through UP (authority/ctx.js): bound here, once every module has loaded
Object.assign(UP, { actEntry, actOf, activate, admit, body, boundsOf, changeEntry, changeShape, commit, danglingRefs, dist, enter, guess, gripPoint, historyDiff, holdsRefs, homeScale, isNum, lacks, lastTouch, lockCheck, mint, nearMiss, needThing, needWords, notAThing, offRefuse, opsTouching, outsideWorld, rateCheck, request, resolve, restampEngine, returnDue, returnHome, returnPlan, sameHome, occupantOf, occupyRights, serverWritten, setOccupant, settleSim, occupantOn, touchedOf, unknownKeys, vec3s, warnings, withoutRefs });
