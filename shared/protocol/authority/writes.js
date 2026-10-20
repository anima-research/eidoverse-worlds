// shared/protocol/authority/writes.js — the write path: changeEntry (the only code that appends a change entry, and it
// takes only what admit returned), actEntry/actOf, commit (a verb's build, admitted, appended, answered), and the builds
// of the plain writes: create (with createAt and mint), set, delete, turn and place (with resolve), and the thing
// lookups they share (needThing, notAThing, offRefuse, the world's bounds) (refactor split, 2026-10-17; moved from
// authority.js's gate section unchanged). guess is above it, reached through UP.
import { isEntityId, isComponent } from "../fold.js";
import { mintId } from "../ids.js";
import { COMPONENTS, defOf, isNamespaced, materialize } from "../componentspec.js";
import { offChain, carried, ENGINES } from "../simlayer.js";
import { atWrite } from "../assetref.js";
import { r3 } from "../round.js";
import { CTX, UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { modelOf, boxOfM, geomE } from "./catalogue.js";
import { CHANGE, clone, createOps, delOp, followUp, lockedC, nonce16, qr3, scratch, setOp, versionSeq } from "./storage.js";
import { NONE, aabb, ancestors, descendants, hits, localFrom, obbs, qYaw, qinv, qmul, qrot, rectHolds, surfacesOf, worldT, yawQ } from "./math.js";
import { groundReady, hitsIx, near, spatial, spend, supportBelow } from "./spatial.js";
import { isSocketC, socketsOf } from "./sockets.js";
import { madeBy, roleOf } from "./rights.js";
import { inboxPush } from "./bodyconsent.js";
import { buildCreateFrom } from "./blueprints.js";
import { heldEvent } from "./scriptrun.js";
import { clearOccupant, occupantOf, vacateAt, vacateWhy } from "./occupants.js";
import { buildEpoch } from "./physics.js";
import { stampHomes, stampResetHomes } from "./manipulate.js";
import { isLookAt } from "./checks.js";
import { Admitted, admit, rateCheck } from "./gate.js";
import { applyResettle, clearRefsTo, lastTouch, planResettle, resettleEntries, stampMedia, stampModelHash, stampShapes, stripDry, touched, warnOrNot, warnings } from "./followups.js";
import { renameFields } from "../shaperepair.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const guess = (...a) => UP.guess(...a);

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
  const pre = plan.vacate.length ? w.state() : null;   // where each occupant was let go: the seat as it stood before the edit
  const seq = w.append(changeShape(plan, cause, w), CHANGE);
  // the occupants an edit lets go (vacatesFor): presence, after the write has landed, each told in their inbox (with where
  // they stand now: the authority's track of their body starts again there, scars r9 M2)
  for (const u of plan.vacate) if (w.presence.occupants?.[u.who]?.to === u.socket) { const at = vacateAt(w, pre, u.who, u.socket); clearOccupant(w, u.who);
    inboxPush(w.presence, u.who, { type: "vacated", socket: u.socket, ...(u.host ? { host: u.host } : {}), by: plan.who.actor, why: vacateWhy(u), ...(at ? { at } : {}) }); }
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
  // the write's consequences (occupants re-dropped off a host whose shape changed) are planned and admitted HERE, against the
  // state the write leaves, before anything is appended: a refusal refuses the whole request, never half of it (review of
  // PR #260, followups.js:58: a throw after the commit left a saved edit nobody was sent)
  const settle = planResettle(w, actor, plan.ops, st, plan.after);
  const actE = actOf(w, actor, verb, sent, CTX.operator && CTX.operator === actor && !ctx.cap ? { ...(ctx.actExtra ?? {}), operator: true } : ctx.actExtra);   // an operator's repair says so, in the act
  const changeE = changeShape(plan, w.entries.length, w);
  // what a delete woke (buildDelete: things resting on what it removed as well as on their parent) falls from rest after the
  // change, caused by the act; only things the write leaves standing (a later batch op may have removed one)
  const wakes = (ctx.launches ?? []).filter((b) => plan.after.entities[b.id]).map((b) => ({ kind: "sim", actor, cause: w.entries.length, verb: "launch", body: b }));
  // what an engine's start finds in a hand (buildEpoch): lifted out of its world, caused by the act. Each names its holder as
  // actor, as a grab's own lift does, since orphanLifts reads the holder from it
  const lifts = (ctx.lifts ?? []).filter((id) => plan.after.entities[id] && w.presence.holds?.[id]).map((id) => ({ kind: "sim", actor: w.presence.holds[id].by, cause: w.entries.length, verb: "lift", body: { id } }));
  w.fits(actE, changeE, ...resettleEntries(w, settle, w.entries.length), ...wakes, ...lifts); // every line fits, or none is written
  // the budget counts THIS write too, not only what came before it (review 10-14 C0: a 300 KiB batch in an empty window passed a 256 KiB cap)
  if (!ctx.cap || ctx.cap.kind === "reaction" || ctx.cap.kind === "handle") rateCheck(w, actor, "act", JSON.stringify(actE).length + JSON.stringify(changeE).length);
  const act = w.append(actE);
  const seq = changeEntry(w, plan, act);
  const after = w.state();
  applyResettle(w, settle, act, ctx.notes);
  for (const e of wakes) w.append({ ...e, cause: act });
  for (const e of lifts) w.append({ ...e, cause: act });
  // an edit that moves, re-parents or removes a thing in someone's hand takes it out of the hand: it is where the edit
  // put it now. (R, 10-10: moved a held barrel in edit mode; her client let go, the authority didn't, and every throw
  // after was refused from a hand the two no longer agreed on.)
  { let let_go = false;
    for (const o of plan.ops) { const h = w.presence.holds?.[o.id]; if (!h) continue;
      // switching it off takes it out of the hand too (review 5d5eef5c #5): an off thing can't be thrown, so it's set down where
      // the record has it. Keep this rule in step with simlayer's ends() and endsUnder().
      if (o.verb === "delete" ? (o.comp === undefined || o.comp === "transform" || o.comp === "parent") : (o.comp === "transform" || o.comp === "parent" || (o.comp === "disabled" && o.value === true))) {
        delete w.presence.holds[o.id]; let_go = true; heldEvent(w, "release", o.id, { by: h.by, how: "edited", seq: act }); ctx.notes.push({ id: o.id, tookFromHand: h.by, why: "an edit moved it, so it left the hand that held it" }); } }
    // …and switching off (or removing) a thing lets go of whatever is held UNDER it (attack-editor S2-1: a held child of a
    // switched-off parent could be neither put, dropped nor thrown; only its parent's return freed the hand)
    const offed = plan.ops.filter((o) => (o.verb === "set" && o.comp === "disabled" && o.value === true) || (o.verb === "delete" && o.comp === undefined)).map((o) => o.id);
    if (offed.length) for (const [id, h] of Object.entries(w.presence.holds ?? {})) {
      if (!after.entities[id] || !ancestors(after, id).some((p) => offed.includes(p))) continue;
      delete w.presence.holds[id]; let_go = true; heldEvent(w, "release", id, { by: h.by, how: "edited", seq: act }); ctx.notes.push({ id, tookFromHand: h.by, why: "what it hangs under was switched off, so it left the hand that held it" }); }
    if (let_go) w.savePresence(); }
  // a seat gone or switched off lets its occupant go: told in their inbox like any vacate (holes r10 L6), with where the track restarts
  for (const who of Object.keys(w.presence.occupants ?? {})) if (!occupantOf(w, after, who)) { const to = w.presence.occupants[who]?.to; const why = "the socket they occupied was switched off or removed";
    const at = typeof to === "string" && st.entities[to] ? vacateAt(w, st, who, to) : null; clearOccupant(w, who); ctx.notes.push({ who, vacated: true, socket: to, why });
    if (typeof to === "string") inboxPush(w.presence, who, { type: "vacated", socket: to, by: actor, why: `${to}: ${why}`, ...(at ? { at } : {}) }); }
  return { ok: true, seq, head: w.headAt(seq), act, refs: [...ctx.refs].filter((id) => after.entities[id]).map((id) => ({ id, born: after.entities[id].born })),
    after: touched(plan.ops, after), ...(ctx.undid ? { undid: ctx.undid } : {}), ...(ctx.notes.length ? { notes: ctx.notes } : {}), ...warnOrNot(warnings(after, [...ctx.refs])) };
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
  // grabbable.pose / station.pose are anim, a grip's fingers its grasp (R 10-17 15:09/15:11): a write in the old spelling is
  // taken and stored in the new (shaperepair.js renameFields: the load renames a stored one the same way)
  if (comp === "grabbable" || comp === "station") { const r = renameFields(comp, value); if (r.renamed.length) { value = r.value; for (const n of r.renamed) ctx.notes.push({ id, component: comp, ...n, why: "renamed before release (R 10-17): pose is anim, fingers is grasp" }); } }
  // a motion's type bob is oscillate (R 10-17 21:40): the old spelling is taken for one release and stored in the new (the
  // load renames a stored one the same way: renameFields)
  if (comp === "motion" || comp.startsWith("motion:")) { const r = renameFields(comp, value); if (r.renamed.length) { value = r.value; for (const n of r.renamed) ctx.notes.push({ id, component: comp, ...n, why: "renamed before release (R 10-17): a motion's bob is oscillate" }); } }
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
    if (v?.to && !ctx.st.entities[v.to]) refuse("not-found", `no thing called '${v.to}'`, "check the id: didYouMean lists the closest, and look shows what's around you", { didYouMean: guess(v.to, Object.keys(ctx.st.entities)) });
    if (v?.to && (v.to === a.id || ancestors(ctx.st, v.to).includes(a.id))) refuse("loop", `${a.id} can't be inside ${v.to}: that makes a loop`, `choose a parent that isn't ${a.id} or inside it`);
    const wt = worldT(ctx.st, a.id);
    const t = v?.to ? localFrom(ctx.st, v.to, wt) : wt;
    ctx.notes.push({ id: a.id, component: "transform", why: "re-expressed in its new parent's frame so it stays where it is (stamped)" });
    ctx.refs.add(a.id);
    return [setOp(a.id, "parent", resolve(ctx, a.id, "parent", v)), setOp(a.id, "transform", t)];
  }
  if (a.id === "@world" && a.component === "physics-engine") return buildEpoch(ctx, v, a);
  // a field the authority stamps (componentspec `stamped`: the sky's ts, override, a forecast's epoch) is never taken from a
  // writer (shape audit 10-16): the act that owns it stamps it (sky, weather)
  // …except a fork's own copy (CTX.forking), which carries the value its source's act stamped (review of #260, server I36)
  if (!CTX.forking) for (const f of defOf(a.component)?.stamped ?? []) { const path = f.split("."); let x = a.value;
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
  // the resting thing's lock, so nobody pins a thing against deletion by resting something of theirs on it. In a hand or in flight isn't resting
  const sf = ctx.w?.sim?.();
  for (const id of Object.keys(after.entities)) { if (!over.has(id)) continue; const b = aabb(after, id); if (!b || after.entities[id].c.parent) continue;
    if (ctx.w?.presence.holds?.[id] || sf?.launched?.[id]) continue;
    const before = supportBelow(ctx.st, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    if (!gone.has(before.id)) continue;
    const now = supportBelow(after, (b.min[0] + b.max[0]) / 2, (b.min[2] + b.max[2]) / 2, b.min[1], new Set([id]));
    const t = worldT(after, id); ops.push(followUp(setOp(id, "transform", { ...t, pos: [t.pos[0], r3(t.pos[1] - (b.min[1] - now.y)), t.pos[2]] }))); setDown.push({ id, onto: now.id }); ctx.refs.add(id); }
  if (setDown.length) ctx.notes.push({ setDown, why: "they were resting on what you deleted, so they were set down on what's below" });
  // review of PR #260 (writes.js:296), as grab does (R 10-17 20:05, pyr-7 under pyr-9): under a carried engine, a dynamic thing
  // the physics rested on TWO supports is parented to one and resting on the other all the same. Deleting that other one
  // left it asleep in mid-air (the engine wakes a sleeper only when a moving body touches it, never when its support goes).
  // So a dynamic thing parented to something that stays, whose box TOUCHES one of the deleted things' tops (the thin slab
  // just over it), falls from rest: a zero-velocity launch, logged after the change; the engine decides whether the
  // support it keeps still holds it. Held, flying, locked (or under a lock) things stay; so does everything while the
  // ground is still loading (a fall would rest on a guessed height), said so.
  const spec = ctx.st.entities["@world"]?.c["physics-engine"];
  if (spec && carried(spec)) { const wake = [];
    const tops = [...gone].flatMap((g) => ixb.rec.get(g)?.surfs ?? []);
    for (const k of over) { const c = after.entities[k]?.c;
      if (!c || gone.has(k) || !c.parent || c.physics?.kind !== "dynamic" || ctx.w?.presence.holds?.[k] || sf?.launched?.[k] || [k, ...ancestors(after, k)].some((x) => lockedC(after.entities[x]?.c))) continue;
      if (tops.some((s) => hitsIx(ctx.st, { min: [s.min[0], s.y - 0.01, s.min[1]], max: [s.max[0], s.y + 0.03, s.max[1]] }, k, 0))) wake.push(k); }
    if (wake.length && !groundReady(ctx.st)) ctx.notes.push({ kept: wake, why: "they were resting on what you deleted too, but this world's ground is still loading: they are left as they are rather than fall onto a guessed height" });
    else if (wake.length) { const rot = ENGINES[spec.engine]?.rotates;
      (ctx.launches ??= []).push(...wake.map((k) => { const t = worldT(after, k); return { id: k, p: t.pos.slice(), yaw: qYaw(t.q), ...(rot ? { q: t.q.slice() } : {}), v: [0, 0, 0], handled: [ctx.actor] }; }));
      ctx.notes.push({ fell: wake, why: "they were resting on what you deleted as well as on what they hang from; they fall from rest, and physics decides whether what's left holds them" }); } }
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
    const surfs = surfacesOf(st, a.on); if (!st.entities[a.on]) refuse("not-found", `no '${a.on}'`, "check the id: didYouMean lists the closest, and look shows what's around you", { didYouMean: guess(a.on, Object.keys(st.entities)) });
    if (!surfs.length) refuse("no-surface", `${a.on} has no surface to put things on`, `measure {id: '${a.on}'} shows its surfaces`);
    const s = surfs[a.level ?? surfs.length - 1] ?? refuse("no-surface", surfs.length === 1 ? `${a.on} has one level, 0` : `${a.on} has levels 0–${surfs.length - 1}`,
      `level takes ${surfs.length === 1 ? "0" : `0–${surfs.length - 1}`} (measure {id: '${a.on}'} shows each), or leave it out for the top one`);
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
          if (s.rect && !rectHolds(s, x, z, hx, hz)) return;   // off a turned top's own rectangle, though inside the box of its corners
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
    if (!best) { const [hx, hz] = half(yaw); refuse("no-room", `${a.id} (${r3(2 * hx)}×${r3(2 * hz)} m) doesn't fit free on ${a.on}'s level ${s.level} (${s.rect ? `${r3(2 * s.rect.hx)}×${r3(2 * s.rect.hz)} m, turned` : `${r3(s.max[0] - s.min[0])}×${r3(s.max[1] - s.min[1])} m`})${lastBlock ? `; ${lastBlock} is in the way` : ""}`, "try another level, a smaller thing, or move what's there"); }
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
export { actEntry, actOf, boundsOf, buildCreate, buildDelete, buildPlace, buildSet, buildTurn, changeEntry, changeShape, commit, mint, needThing, notAThing, offRefuse, outsideWorld, resolve, serverWritten };
