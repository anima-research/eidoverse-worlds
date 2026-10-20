// shared/protocol/authority/followups.js — the authority's own consequences of a write, and the readers that know them:
// occupants resettled when a host's shape changes, the stamps a write gets (physics shapes, media, model hashes), the
// references a deletion clears (refComps, holdsRefs, withoutRefs, clearRefsTo), who last touched what (lastTouch, which
// reads follow-ups as no author's), touchedOf, historyDiff, and the physical warnings and dangling references a write or
// lint reports (refactor split, 2026-10-17; moved from authority.js's gate section unchanged). admit, changeEntry and
// the world's bounds are above it, reached through UP.
import { PURGED } from "../fold.js";
import { baseOf, mapRefs, refsOf, refFields } from "../componentspec.js";
import { mediaTier, tierWords } from "../../mediasrc.js";
import { ENGINES, carried } from "../simlayer.js";
import { eidoHex } from "../../eido.js";
import { r3 } from "../round.js";
import { CTX, UP } from "./ctx.js";
import { Refusal, said } from "./refuse.js";
import { geomOf, boxOfM, geomE, meshShape } from "./catalogue.js";
import { delOp, followUp, followUpsOf, isE, lockedC, opsQuiet, qr3, scratch, setOp } from "./storage.js";
import { aabb, ancestors, descendants, localFrom, qYaw, satCost, satDepth, worldT } from "./math.js";
import { familyOf, groundOf, groundReady, near, spatial, spend, supportBelow, supportUnder } from "./spatial.js";
import { backward, entryBy } from "./rights.js";
import { admit } from "./gate.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const boundsOf = (...a) => UP.boundsOf(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const outsideWorld = (...a) => UP.outsideWorld(...a);

// review S2.4 (R 10-12): a geometry write moves a thing's top (a mesh resized, a model swapped, its scale changed), and what the
// physics had stacked on it (its dynamic children, attached by their rest) kept their local pose: floating over a shrunk
// plinth, or scaled with a model's new size. They are re-dropped: under a carried engine a zero-velocity launch from where
// each stands (the engine logs where it lands, as a grab's fallen dependents are); with no engine, set straight down onto
// what is under them. A held, locked or already flying child is left alone. A move or a turn is not a geometry write: the
// stack rides along, as it always did.
// The authority's consequence, not the asker's write (scars r10 M3): written by `system` under its own act, `resettle {hosts,
// occupants}`, caused by the asker's act (as settle and return-lost are), so the entry never says the asker moved someone else's things.
// Planned BEFORE the asker's write commits (review of PR #260, followups.js:58): every consequence is computed and admitted
// against the state the write will leave (the asker's admitted preview), so a refusal refuses the whole request with nothing
// written; after the commit, applyResettle only appends what was planned and can't refuse. A child the same write creates
// has no pose before it: it is read from the new state (it was there before only if the old state has it).
function planResettle(w, asker, ops, before, after0) { let after = after0; const actor = "system";
  // what a host's top depends on: its geometry (a mesh's size, a model's measured box, or none) and its scale. A write that
  // leaves these as they were (the same value re-asserted, a move, a turn) re-drops nothing (review r2 S2.1); a delete of the
  // geometry is a change like any other (r2 S2.3)
  const geomKey = (st, id) => { const e = st.entities[id]; const m = e ? geomE(e) : null; return JSON.stringify([m ? boxOfM(m) : null, e?.c.transform?.scale ?? [1, 1, 1]]); };
  const hosts = new Set(ops.filter((o) => (o.verb === "set" || o.verb === "delete") && before.entities[o.id] && after.entities[o.id] && (o.comp === "mesh" || o.comp === "model" || o.comp === "transform") && geomKey(before, o.id) !== geomKey(after, o.id)).map((o) => o.id));
  if (!hosts.size) return null;
  // a child on a SOCKET is the socket's child, which has no top: never an occupant (r2 S2.2: a cup on its perch was torn off and dropped)
  const occupants = Object.keys(after.entities).filter((k) => { const c = after.entities[k].c;
    return hosts.has(c.parent?.to) && c.physics?.kind === "dynamic" && !lockedC(c) && !w.presence.holds[k] && !w.presence.holds[c.parent.to] && !after.entities[k].c.disabled && aabb(after, k); });
  if (!occupants.length) return null;
  const spec = after.entities["@world"]?.c["physics-engine"];
  // the ground still loading: a fall would rest on a guessed height (review r4 F2) — they are left as they are on the host
  // (its local pose kept: a rescaled host carries them with it, r5 F6), said so
  if (!groundReady(after)) return { actor, asker, hosts, occupants: [], admitted: null, launches: [], note: { kept: occupants, why: "they were resting on a thing whose shape changed, but this world's ground is still loading: they are left as they are on it (a rescaled host carries them with it) rather than fall onto a guessed height. Nothing sets them down once it has loaded: a later change to the host's shape does, or moving them" } };
  if (spec && carried(spec)) {
    const flying = new Set(Object.keys(w.sim?.()?.launched ?? {}));
    const dropped = occupants.filter((k) => !flying.has(k));
    if (!dropped.length) return null;
    // out from under the host first, standing where it stood in the world: its rest re-attaches it to whatever it lands on
    // with a fresh local pose (a rest keeps a child's recorded scale, and that scale was compensation for the OLD host size)
    // (as it stood BEFORE the write: a model host's new scale had already carried the child's world pose and size with it;
    // a child this write creates stands where the write puts it)
    const was = (k) => (before.entities[k] ? worldT(before, k) : null) ?? worldT(after, k);
    const free = dropped.flatMap((k) => { const t = was(k); return [delOp(k, "parent"), setOp(k, "transform", { pos: t.pos.map(r3), q: qr3(t.q), scale: t.scale.map(r3) })]; });
    const admitted = admit(w, after, { actor, cap: { kind: "system", ids: dropped, comps: ["transform", "parent"] } }, free);
    const launches = dropped.map((k) => { const t = was(k); return { id: k, p: t.pos.slice(), yaw: qYaw(t.q), ...(ENGINES[spec.engine]?.rotates ? { q: t.q.slice() } : {}), v: [0, 0, 0], handled: [asker] }; });
    return { actor, asker, hosts, occupants: dropped, admitted, launches, note: { fell: dropped, why: "they were resting on a thing whose shape changed; they fall to its new top (physics will log where they land)" } };
  }
  // no engine: set each occupant down from ABOVE the host's new top (a grown host would otherwise bury it: supportUnder only
  // counts faces at or below where the occupant stands; r2 S1.1). A host that lost its body frees its occupants to the world
  const setOps = occupants.flatMap((k) => { const host = after.entities[k].c.parent.to; const b = aabb(after, k); const hb = aabb(after, host); const wt = worldT(after, k);
    const lift = hb ? Math.max(0, hb.max[1] - b.min[1]) : 0; const probe = { min: [b.min[0], b.min[1] + lift, b.min[2]], max: [b.max[0], b.max[1] + lift, b.max[2]] };
    const below = supportUnder(after, probe, new Set([k, ...descendants(after, k)])); const wpos = [wt.pos[0], r3(wt.pos[1] - (b.min[1] - below.y)), wt.pos[2]];
    if (!hb) return [delOp(k, "parent"), setOp(k, "transform", { pos: wpos, q: qr3(wt.q), scale: wt.scale.map(r3) })];
    const lt = localFrom(after, host, { ...wt, pos: wpos });
    const v = { ...after.entities[k].c.transform, pos: lt.pos }; return JSON.stringify(v) === JSON.stringify(after.entities[k].c.transform) ? [] : [setOp(k, "transform", v)]; });
  if (!setOps.length) return null;
  const admitted = admit(w, after, { actor, cap: { kind: "system", ids: occupants, comps: ["transform", "parent"] } }, setOps);
  const moved = [...new Set(setOps.map((o) => o.id))];
  return { actor, asker, hosts, occupants: moved, admitted, launches: [], note: { setDown: moved, why: "they were resting on a thing whose shape changed; with no physics running they were set straight down onto what is under them now" } };
}
// the entries a plan will append, in order, for w.fits() before the asker's write commits (askerAct: where the asker's act
// will stand; its change follows it, then the resettle act, whose own change and launches name it)
function resettleEntries(w, plan, askerAct) {
  if (!plan || (!plan.admitted && !plan.launches.length)) return [];
  const own = askerAct + 2;
  const act = { kind: "act", actor: plan.actor, verb: "resettle", cause: askerAct, body: { hosts: [...plan.hosts], occupants: plan.occupants, asked: plan.asker } };
  return [act, ...(plan.admitted ? [UP.changeShape(plan.admitted, own, w)] : []), ...plan.launches.map((b) => ({ kind: "sim", actor: plan.actor, cause: own, verb: "launch", body: b }))];
}
// …and after it: append exactly what was planned and admitted (no check here can refuse)
function applyResettle(w, plan, cause, notes) {
  if (!plan) return;
  if (plan.admitted || plan.launches.length) {
    const act = w.append({ kind: "act", actor: plan.actor, verb: "resettle", cause, body: { hosts: [...plan.hosts], occupants: plan.occupants, asked: plan.asker } });
    if (plan.admitted) changeEntry(w, plan.admitted, act);
    for (const b of plan.launches) w.append({ kind: "sim", actor: plan.actor, cause: act, verb: "launch", body: b });
  }
  notes.push(plan.note);
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
    // every physics set for it in the batch gets the measured value: the last is the one the fold keeps, and an earlier one
    // replaced alone left a later set's shape (the asker's) standing
    let found = false; out.forEach((o, k) => { if (o.verb === "set" && o.comp === "physics" && o.id === id) { out[k] = setOp(id, "physics", next); found = true; } });
    if (!found) { out.push(setOp(id, "physics", next)); if (next.shape) stamped.push(id); else unstamped.push(id); }
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
        // authored: whose rights wrote it (a handler's author, a script's sponsor), not who invoked it: a handler that writes
        // its own thing's reactions installs its author's handler, never the invoker's (null when a purge erased whose)
        return { seq: i, actor: authored ? entryBy(w, e).rights : e.actor }; } } }
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
export { applyResettle, clearRefsTo, danglingRefs, historyDiff, holdsRefs, lastTouch, opsTouching, planResettle, resettleEntries, stampMedia, stampModelHash, stampShapes, stripDry, touched, touchedOf, warnOrNot, warnings, withoutRefs };
