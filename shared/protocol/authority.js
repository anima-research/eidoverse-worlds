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
import { CAPACITY, CAPACITY_CEILING, capacityCheck } from "./authority/capacity.js";
export { CAPACITY, CAPACITY_CEILING } from "./authority/capacity.js";
import { isLookAt, isNum, nearMiss, restCheck, unknownKeys, valueCheck } from "./authority/checks.js";
export { schemaRefusal } from "./authority/checks.js";
import { Admitted, SAY_MAX, admit, lacks, lockCheck, needWords, rateCheck, spokenOf } from "./authority/gate.js";
export { keyKind, seniorOwnerOf } from "./authority/gate.js";


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
// ---------- how much a world holds: authority/capacity.js ----------
// ---------- the gate's value checks: authority/checks.js ----------
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
Object.assign(UP, { actEntry, actOf, activate, admit, body, boundsOf, changeEntry, changeShape, commit, danglingRefs, dist, enter, guess, handOf, historyDiff, holdsRefs, homeScale, isNum, lacks, lastTouch, mint, nearMiss, needThing, needWords, notAThing, offRefuse, opsTouching, outsideWorld, rateCheck, request, resolve, restampEngine, returnDue, returnHome, returnPlan, sameHome, seatOf, seatRights, serverWritten, setSeat, settleSim, sitterOn, touchedOf, unknownKeys, vec3s, warnings, withoutRefs });
