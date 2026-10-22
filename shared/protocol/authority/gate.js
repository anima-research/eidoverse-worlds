// shared/protocol/authority/gate.js — L7, the one gate: admit (every state write, from every path, is admitted here),
// the rate over everything an actor makes the log hold, locks and lock levels, the rights a write needs (lacks, rights,
// needWords), keyed components and owner seniority, grants and role definitions (refactor split, 2026-10-17; moved from
// authority.js's "L7: the one gate" section unchanged; its value checks are authority/checks.js, capacity
// authority/capacity.js). occupyRights (occupants.js's) and serverWritten (the write path's) are above it, reached through UP.
import { DEFAULT_WHO, grabOf } from "../../grab.js";
import { cowState, applyCow, checkIJSON, isEntityId, isComponent, jcs, utf8Len, PURGED } from "../fold.js";
import { PERSON_ID } from "../ids.js";
import { COMPONENTS, defOf, baseOf, statusOf, canonicalName } from "../componentspec.js";
import * as R from "../roles.js";
const { lockWord } = R;
import { unNegZero } from "../round.js";
import { CTX, UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { FOLLOW_UP, IMPORTED_ONLY, isE, lockedC, opsQuiet } from "./storage.js";
import { ancestors } from "./math.js";
import { socketRules, actionRules, liftOps } from "./sockets.js";
import { RANK, admits, backward, creatorOf, effective, lastSetterOf, lockStrength, may, ownersOf, rankOf, roleOf, wcOf } from "./rights.js";
import { whoWords } from "../roles.js";
import { installCheck, particlesCheck, pauseOnly, pausedBy, scriptRights, sponsorOf } from "./scripts.js";
import { vacateWhy, vacatesFor } from "./occupants.js";
import { capacityCheck } from "./capacity.js";
import { restCheck, valueCheck } from "./checks.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const guess = (...a) => UP.guess(...a);
const occupyRights = (...a) => UP.occupyRights(...a);
const serverWritten = (...a) => UP.serverWritten(...a);

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
const bytesOf = (e) => e.bytes ?? utf8Len(JSON.stringify(e));   // UTF-8 bytes, as the log stores it (storage: bytes)
// FOLLOW_UP / followUp (the authority's own follow-up ops inside a person's write): authority/storage.js
class Admitted { constructor(who, ops, after, notes = [], vacate = [], followUps = []) { this.who = who; this.ops = ops; this.after = after; this.notes = notes; this.vacate = vacate; this.followUps = followUps; Object.freeze(this); } }
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
// A server operator's recorded repair (CTX.operator, authority.js operatorRepair): the door's own components on @world —
// who holds which role, who may come in — pass without the world's rights, keys or grant rule, so an operator can mend a
// world whose owners are gone or locked out. Shape, value, roles and last-owner checks still apply; nothing else is opened.
export const REPAIR_COMP = (c) => c === "access" || c === "default-role" || c === "role-defs" || (typeof c === "string" && c.startsWith("roles:"));
// …the operator's OWN ops only: never a capability (a script or handler a repair sets off runs on its own rights)
const operatorRepairs = (who, op) => !!CTX.operator && CTX.operator === who.actor && !who.cap && op.id === "@world" && REPAIR_COMP(op.comp) && (op.verb === "set" || op.verb === "delete");
function admit(w, st, who, ops) {
  const { actor, cap } = who;
  if (!cap || cap.kind === "reaction" || cap.kind === "handle" || cap.kind === "caption") rateCheck(w, actor);
  // preLifted: commit() lifted them already (so its reference clearing saw the lift's deletes), and passes the lift's notes
  const lifted = who.lifting ? { ops, notes: [] } : who.preLifted ? { ops, notes: who.preLifted } : liftOps(st, ops, w.everIds()); ops = lifted.ops;
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
      const vb = utf8Len(jcs(op.value)); if (vb > 65536) refuse("too-big", `${at} is ${vb} bytes; the authority keeps values under 64 KiB`, "put big data in a blob and store its hash"); }
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
    // (nobody may write it, so who is asking doesn't matter). A carried value (a fork's copy, the command's lift) keeps what it
    // holds: the refusal is about new writes, not about what an older log stored
    // (a lifted name, sockets, is the lift's: a write of it never gets here as itself unless malformed, and then its own
    // check says what is wrong with it in its own words)
    if (op.verb === "set" && statusOf(op.comp) === "reserved" && !defOf(op.comp)?.lifted && !(CTX.forking || who.lifting)) { const b = canonicalName(baseOf(op.comp));
      refuse("reserved", `${at}: '${b}' is a reserved name: it is held for a shape that isn't settled yet, and nothing may write it`, COMPONENTS[b].instead ?? `schema {component: '${b}'} says what it is held for`, { status: "reserved" }); }
    const pause = op.verb === "set" && op.comp.startsWith("script:") && pauseOnly(op.value, s.entities[op.id]?.c[op.comp]);
    if (!fu && !operatorRepairs(who, op)) { rights(w, st, s, who, role, op, at, made, pause);
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
  occupyRights(w, st, s, who, role, norm.filter((o) => !fuOps.has(o)), made);
  const vacate = CTX.forking || who.lifting ? [] : vacatesFor(w, st, who, norm);
  capacityCheck(w, st, s, who, norm);
  for (const op of norm) if (op.verb === "set") valueCheck(s, op, { carry: CTX.forking || !!who.lifting, now: w.now() }); // against the state the whole write leaves (parents may come later in a batch); a fork's copy carries what its parent holds
  { const bad = socketRules(s, new Set(norm.map((o) => o.id))); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); } }
  if (!(CTX.forking || who.lifting)) { const bad = actionRules(s, new Set(norm.map((o) => o.id))); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); } }
  rolesCheck(st, s, norm);
  for (const op of norm) if (op.verb === "set" && op.comp.startsWith("script:") && !pauseOnly(op.value, prevOf.get(op))) installCheck(w, st, s, who, op); // 41 §3.14: at install (not a pause: it needs no source, no scope)
  if (!CTX.forking) for (const op of norm) if (op.verb === "set") particlesCheck(w, op); // a particles value names an effect this world has, with params it declares (shared/particle_effects.js)
  if (cap?.kind === "script") for (const id of cap.made ?? []) if (s.entities[id] && !cap.ids.some((r) => r === id || ancestors(s, id).includes(r)))
    refuse("scope", `${cap.key} may create only inside its subtree; ${id} isn't under ${cap.ids[0]}`, "give it parent {to: <an entity in the scope>} in the same batch");
  if (ownersOf(st).length && !ownersOf(s).length && s.entities["@world"]?.c?.["keep-owner"] !== false) refuse("last-owner", "that would leave this world with no owner", "§7: add the new owner's role first (set {id: '@world', component: 'roles:<them>', value: {role: 'owner'}}), then change yours");
  if (cap?.kind === "rest") restCheck(w, cap, s);
  return new Admitted(who, norm, s, vacate.length ? [...lifted.notes, ...vacate.map((u) => ({ who: u.who, vacated: true, socket: u.socket, why: vacateWhy(u) }))] : lifted.notes, vacate,
    norm.flatMap((o, i) => (fuOps.has(o) ? [i] : [])));
}
// A lock binds everyone, the locker and owners included (§5). `throughLock: true` on the request lets anyone who may
// lift that lock act through it, and the log records only the edit (the act carries the request as sent, flag and all).
// It covers the asker's OWN writes: a capability (a handler's author, a hand, the authority's own follow-ups) never acts
// through a lock. Who may lift it (recut B2, R 10-20): anyone at its setter's rank NOW or above, who may also delete the
// component (L7 rights) — a soft barrier by rank; the padlock asks before it acts.
function lockCheck(w, st, who, role, k, op, at) {
  const strength = lockStrength(w, st, k);
  const below = !who.cap && rankOf(st, who.actor) < strength;
  const mayUnlock = !who.cap && !lacks(w, st, who.actor, { verb: "delete", id: k, comp: "lock" }) && !below;
  if (CTX.through && mayUnlock) return;
  const by = lastSetterOf(w, k, "lock"); const whose = by && !by.deleted ? ` (locked by ${said(by.by)} at ${by.seq})` : "";
  const what = k === op.id ? `${op.id} is locked${whose}, so ${at} can't change` : `${op.id} is attached to ${k}, which is locked${whose}, so ${at} can't change`;
  const fix = CTX.through && who.cap ? `throughLock covers only your own edits, not a handler, a held thing or a script acting for you, so the lock stands for this route; someone who may unlock it can (delete {id: '${k}', component: 'lock'})`
    : below ? `this lock is ${lockWord(strength)} (its setter's rank); you are ${role}`
    : mayUnlock ? `send the same request with throughLock: true, or unlock it first: delete {id: '${k}', component: 'lock'}. A lock stops accidents; history shows who lifted it`
    : `someone who may build here at its setter's rank can unlock it (delete {id: '${k}', component: 'lock'}); you are ${role}`;
  refuse("locked", what, fix, { lock: k, rank: strength, ...(by && !by.deleted ? { by: by.by } : {}), ...(below ? { mayLift: false } : {}) });
}
// A write to a lock itself: setting, re-setting or removing a lock on a locked thing is lifting it, so it needs the
// lock's strength (a re-set by someone lower would otherwise move its setter down: recut B2). A capability is judged by
// its holder (a handler's author, a script's sponsor); the authority's own follow-ups never touch a lock.
function lockLevelCheck(w, st, s, who, op, at) {
  if (op.comp !== "lock" || op.id === "@world") return;
  const { actor, cap } = who; if (cap && cap.kind !== "reaction" && cap.kind !== "script") return;
  const holder = cap?.kind === "reaction" ? cap.author : cap?.kind === "script" ? cap.sponsor : actor;
  const cur = st.entities[op.id]?.c.lock;
  if (cur !== undefined && cur !== PURGED && rankOf(st, holder) < lockStrength(w, st, op.id)) {
    const by = lastSetterOf(w, op.id, "lock"); const strength = lockStrength(w, st, op.id);
    refuse("rank", `${op.id} is locked${by && !by.deleted ? ` by ${said(by.by)}` : ""}: ${lockWord(strength)} may ${op.verb === "delete" ? "unlock" : "change"} it`,
      `ask ${by && !by.deleted ? said(by.by) : "an owner"}`, { lock: op.id, rank: strength, needs: "rank" }); }
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
  if (!cap && op.verb === "set" && !R.isOwner(role) && IMPORTED_ONLY(op.comp)) refuse("imported", `${at} is an imported world's record, carried as it was; it isn't written by hand`, "what it meant lives elsewhere now: lock for a guard, the moderator log for bans (ban/unban), script:<name> for a behaviour");
  // a server-written component (componentspec writtenBy: copy-of): the authority's own verbs write it (a copy, a rebase,
  // a duplicate); no capability (a handler, a script) ever does, and a hand set or create below owner is refused where the
  // request is built (serverWritten, buildSet and buildCreate)
  if (op.verb === "set" && cap && ["reaction", "script"].includes(cap.kind) && defOf(op.comp)?.writtenBy === "server") serverWritten(at);
  if (!cap && op.comp === "captions" && op.verb === "set" && !R.isOwner(role)) refuse("caption-only", `${at} is written by the caption request, one line at a time`, "caption {id, session, n, t0, t1, text, speaker?, title?} (or {id, session, end: true}); who may is the screen's captioners {ids}");
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
  if (cap.kind === "script") {
    // WHO MAY COME IN is changed by the world's owners directly, never by a script (upstream #258): a script closing a
    // world, or timing someone's grant, would skip the door's settle pass (server/access.ts) and leave people inside who
    // may no longer be; and in a world that admits only people listed, a script grants nothing at all (demoting the last
    // listed owner there would leave nobody able to open it). Ordinary role grants stay open to an owner's scripts.
    if (op.id === "@world" && (op.comp === "access" || op.comp === "default-role")) refuse("rights", `a script can't change ${at}: who may come into a world is changed by its owners directly`, "change it yourself: set {id: '@world', component: '" + op.comp + "', value}");
    if (op.id === "@world" && op.comp?.startsWith("roles:") && ((op.verb === "set" && op.value?.until !== undefined) || st.entities["@world"]?.c?.access?.join === "listed"))
      refuse("rights", `a script can't ${op.value?.until !== undefined ? "time a grant" : "grant in a world that admits only people listed"} (${at})`, "who may come into a world is changed by its owners directly");
    return scriptRights(w, st, cap, op, at, made);
  }
  if (!cap.ids.includes(op.id) || !cap.comps.includes(op.comp)) refuse("rights", `${cap.kind === "reaction" ? `the '${cap.action}' handler` : cap.kind} may change only ${cap.comps.join("/")} of ${cap.ids.join(", ")}, not ${op.verb} ${at}`, "a capability is scoped to what it names");
  if (cap.kind === "reaction" && lacks(w, st, cap.author, op, made, { viaCap: true })) refuse("rights", `'${cap.action}' was set up by ${said(cap.author)}, who can't change ${at} any more`, "ask someone with the rights to set the reactions again");
  // a hand's settlement: who may is grabbable.who (grabOf: the one reader, with the physics fallback); a punt is a launch,
  // not a hand, and keeps physics.who (research: "physics.who now means who may punt or push it")
  if (cap.kind === "handle" && cap.via === "punt") { const ph = st.entities[op.id]?.c.physics; const n = ph?.who ?? DEFAULT_WHO;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${op.id} isn't something you can punt`, "");
    if (!admits(st, actor, n)) refuse("rights", `only ${whoWords(n)} may punt ${op.id}; you are ${role}`, "ask the owner to set physics.who"); }
  else if (cap.kind === "handle") { const g = grabOf(st.entities[op.id]?.c);
    if (!g) refuse("not-grabbable", `${op.id} isn't something you can carry`, "");
    if (!admits(st, actor, g.who)) refuse("rights", `only ${whoWords(g.who)} may move ${op.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
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
      if (o.verb === "set" && o.comp === comp && R.isOwner(o.value)) since = i; else return since; } }
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
  if ((def?.rank ?? R.BELOW) >= me.rank) refuse("rank", `${after} stands at or above you (${me.name}); you can only give roles ranked below yours`, "ask an owner", { needs: "rank" });
  // what the person holds afterwards, as effectiveOf reads it (the role's, the default role's own `can` for someone with no
  // entry, their own `can`, closed over): a grantor gives only what they hold themselves
  const give = R.effectiveOf(wc1, target, { anon, owners: true }).permissions;
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
  // change the role an owner gave an inhabitant. A capability never reaches here for roles (lacks: owner).
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
export { Admitted, SAY_MAX, admit, lacks, lockCheck, needWords, rateCheck, spokenOf };
