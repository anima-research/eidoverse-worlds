// shared/protocol/authority/manipulate.js — what a body does to a loose thing beyond the verbs themselves: the shove's own
// gate, how a thing is held, the second hand, snap targets, returns home (after a release, by the system), homes stamped
// and scaled, and a launch into the engine (refactor split, 2026-10-17; moved from authority.js's "physics" section
// unchanged). The gate is above it, reached through UP.
import { MOVER, bodyBox } from "../../mover.js";
import { grabOf, homeOf, wantsHome, fitsSocket, socketRadius, pickGrip } from "../../grab.js";
import { COMPONENTS } from "../componentspec.js";
import { ENGINES, carried, lostPlace, offChain } from "../simlayer.js";
import { planLaunch } from "../launchplan.js";
import { REACH, SHOVE } from "../physconst.js";
import { reachTo, massOf, shoveCap, sweptCovers } from "../../shove.js";
import { r3, noNeg0 } from "../round.js";
import { shapeError, isBoxShape } from "../shapes.js";
import { UP } from "./ctx.js";
import { Refusal, refuse, said } from "./refuse.js";
import { readback, delOp, holdsCustody, isE, lockedC, opsQuiet, scratch, setOp } from "./storage.js";
import { aabb, ancestors, descendants, obbs, qYaw, worldT } from "./math.js";
import { groundOf, groundReady } from "./spatial.js";
import { allSockets, socketPoint } from "./sockets.js";
import { RESERVED } from "./rights.js";
import { actIndexOf } from "./undo.js";
import { heldEvent } from "./scriptrun.js";
import { occupiedRefuse, occupantOn } from "./occupants.js";
import { body, dist, facingOf, gripPoint, gripOf, heldQ, lawOf, solidAt } from "./physics.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const actOf = (...a) => UP.actOf(...a);
const admit = (...a) => UP.admit(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const guess = (...a) => UP.guess(...a);
const lastTouch = (...a) => UP.lastTouch(...a);

// The rests of the last minute, at most 8, oldest first: what restsOf(w.entries) gives filtered to that window, read
// from the act index's rest list backwards (ts never decreases along the log, so the window is a suffix).
function recentRests(w, now) {
  const X = actIndexOf(w); const E = w.entries; const out = [];
  for (let k = X.rests.length - 1; k >= 0 && out.length < 8; k--) { const seq = X.rests[k]; const e = E[seq]; const when = e.ts ?? 0;
    if (!(now - when < 60000)) break;
    // PHYSICS §1: a launch's rest covers every body its flight set moving; each transform in it is one body's rest
    const c = E[e.cause]; const ops = opsQuiet(e).filter((o) => o.comp === "transform" && typeof o.id === "string" && o.value?.pos);
    for (const op of ops.reverse()) { const ai = X.restAfter.get(`${seq}:${op.id}`); const after = ai === undefined ? null : E[ai];
      out.push({ seq, id: op.id, cause: e.cause, at: op.value.pos, handled: readback(w, e.cause)?.handled ?? [c.actor], when,
        ...(after?.verb === "return-lost" ? { lost: readback(w, ai)?.home === true ? "home" : "picked-up" } : {}), ...(after?.verb === "settle" ? { onto: readback(w, ai)?.onto } : {}) }); } }
  return out.reverse();
}
// the punt's reach, from where the body stands: a thing low beside it, or in the air beside it (a volley)
// A contact push (punt {contact: true}; shared/shove.js: a moving body ran into it) is a punt with its own gate, in place of
// the punt's reach: a thing at rest, from a body standing against its footprint (SHOVE.reach from the body's origin, measured
// to its box, not its origin: a wide crate's middle is far from the side you move into), neither beneath the body nor over
// it, pushed away from the body along the ground at a walk's speed. Everything else is the punt's: physics.who, locks, a
// hand on it, the engine's cap.
function shoveGate(w, st, me, a, flying, actor) {
  if (a.contact !== true) refuse("shape", "contact is true or left out", "");
  if (!Array.isArray(a.v) || a.v.length !== 3 || a.v.some((n) => !Number.isFinite(n))) refuse("shape", "a contact push carries v: [x, y, z] in m/s (never power)", "e.g. punt {id, v: [1.5, 0.2, 0], contact: true}");
  if (flying) refuse("in-flight", `${a.id} is already moving; a contact push moves what stands still`, "walk into it again once it comes to rest");
  const [vx, vy, vz] = a.v, vh = Math.hypot(vx, vz), m = massOf(st, a.id), cap = shoveCap(m);
  if (vh > cap + 1e-3 || Math.hypot(vx, vy, vz) > SHOVE.maxV * (1 + SHOVE.lift) + 1e-3) refuse("too-fast", `a contact push is a moving body's push: ${r3(vh)} m/s is more than a body passes to ${a.id} (${r3(m)} kg: at most ${r3(cap)} m/s)`, `at most ${r3(cap)} m/s; a punt without contact goes harder`);
  if (vh < 1e-6 || vy < 0 || vy > SHOVE.lift * vh + 1e-9) refuse("shape", `a contact push moves it along the ground: its v rises at most ${SHOVE.lift} × its speed along the ground, and never falls`, "e.g. v: [1.5, 0.2, 0]");
  const f = me.at, b = aabb(st, a.id) ?? { min: worldT(st, a.id).pos, max: worldT(st, a.id).pos };
  if (b.max[1] <= f[1] + SHOVE.beneath) refuse("beneath", `${a.id} is beneath you; a body moves over it, it doesn't push it`, "move off it, or punt it (without contact)");
  if (b.min[1] >= f[1] + SHOVE.above) refuse("out-of-reach", `${a.id} is above you (${r3(b.min[1] - f[1])} m up); a contact push is from a body against it`, "stand where you can reach it, or punt it (without contact)");
  // to its ORIENTED box (review 10-12 S2-2: a rotated plank's axis-aligned box reached metres past the plank)
  const ob = obbs(st, a.id); const R = ob.length ? reachTo(ob, f) : { d: 0, n: null, c: b.min.map((x, i) => (x + b.max[i]) / 2) };
  if (R.d > SHOVE.reach) refuse("out-of-reach", `${a.id} is ${r3(R.d)} m from you; a contact push comes from a body against it (${SHOVE.reach} m)`, "move up to it first");
  const dir = R.n ?? (() => { const cx = R.c[0] - f[0], cz = R.c[2] - f[2], l = Math.hypot(cx, cz); return l > 1e-6 ? [cx / l, cz / l] : null; })();
  if (!dir || vx * dir[0] + vz * dir[1] < 0.5 * vh) refuse("wrong-way", `that doesn't push ${a.id} away from your body; a contact push sends it within 60° of straight away`, `aim v away from your body, within 60° of the line from you to ${a.id}`);
  // not through a wall: the body's way to the point it touches is clear of anything solid but the thing and what rides it,
  // judged with this body's own box (its kept size, as its walk is: review r4 F7). SHOVE.reach is already the largest
  // body's radius plus the track's lag, so it stays one number.
  if (R.d > 0.05 && R.n) { const fam = new Set([a.id, ...descendants(st, a.id)]); const s = lawOf(me.size).scale;
    const L = Math.max(0, R.d - MOVER.body.radius * s), n = Math.ceil(L / 0.05);
    for (let k = 1; k <= n; k++) { const p = [f[0] + R.n[0] * L * k / n, f[1], f[2] + R.n[1] * L * k / n]; const hit = solidAt(w, st, p, fam, null, bodyBox(p, s));
      if (hit) refuse("out-of-reach", `${hit} is between you and ${a.id}`, "walk round to it"); } }
  // never into someone: what it slides through until friction stops it is clear of every other body (S2-1)
  for (const [who, bd] of Object.entries(w.presence.bodies)) if (who !== actor && Array.isArray(bd?.at) && sweptCovers(b, a.v, bd.at))
    refuse("in-the-way", `${said(who)} is where ${a.id} would slide`, "push it another way, or wait till they move", { by: who });
}
// The hold record (research §3, presence): which hand, and by which grip (snapped to it: VRChat ExactGrip, Unity Attach
// Transform) or at which offset (held where it was grabbed: Unreal Free, Unity dynamic attach). A thing with grips is held
// by one; a named grip must exist and suit the hand. Every client derives where it's drawn from the holder's hand bone and
// this record: nothing streams, nothing is logged.
function gripHow(a, g) {
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
function secondGrip(w, actor, a, h, e) {
  const g = grabOf(e.c); const hand = a.hand;
  if (!g || hand === undefined || hand === h.hand || hand === h.second?.hand) return { ok: true, recorded: false, holding: a.id, inHandAt: h.pose.pos.map(r3), hand: h.hand, note: "you're already holding it" };
  if (g.twoHanded) {
    if (a.grip !== undefined && !g.grips[a.grip]) refuse("no-grip", `it has no grip called '${a.grip}'`, `its grips: ${Object.keys(g.grips).join(", ") || "none"}`, { didYouMean: guess(String(a.grip), Object.keys(g.grips)) });
    const grip = a.grip ?? pickGrip(g, hand, { role: "secondary" });
    h.second = { hand, ...(grip ? { grip } : {}) }; w.savePresence();
    return { ok: true, recorded: false, holding: a.id, hand: h.hand, second: h.second, note: "in both hands: the second steers it" };
  }
  const how = gripHow(a, g); delete h.grip; delete h.offset; delete h.second; Object.assign(h, how); w.savePresence();
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
    const sat = w ? occupantOn(w, st, x.id, null) : null; if (sat?.who) { out.notes.push({ passedOver: where, why: `${said(sat.who)} sits in that socket` }); continue; }
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
  const ops = [...(hp ? [setOp(id, "parent", { ...hp })] : e.c.parent ? [delOp(id, "parent")] : []), setOp(id, "transform", { pos: g.home.pos.slice(), q: g.home.q.slice(), scale: (e.c.transform?.scale ?? [1, 1, 1]).slice() })];
  try { return { plan: admit(w, st, { actor: "system", cap: { kind: "system", ids: [id], comps: ["transform", "parent"] } }, ops) }; }
  catch (x) { if (!(x instanceof Refusal)) throw x; return { plan: null, why: x.reason }; }
}
function returnHome(w, id, plan, cause) {
  const act = w.append({ kind: "act", actor: "system", verb: "return-home", ...(cause !== undefined ? { cause } : {}), body: { id } });
  return { act, seq: changeEntry(w, plan, act) };
}
// What moved a thing last, when it was a hand or physics (a settlement, a punt, a rest, the authority's follow-up to one):
// the entry and the release that caused it. An edit, a script or a return isn't one (they don't send it home).
const MANIPULATE_VERBS = new Set(["put", "drop", "throw", "punt", "leave"]), SYSTEM_AFTER = new Set(["settle", "return-lost", "return-held"]);
function lastRelease(w, id) {
  const lt = lastTouch(w, id, "transform"); if (!lt) return null;
  const se = w.entries[lt.seq]; const c = w.entries[se?.cause]; if (!isE(c)) return null;
  const byManipulation = (c.kind === "act" && (MANIPULATE_VERBS.has(c.verb) && !RESERVED.has(c.actor) || (c.actor === "system" && SYSTEM_AFTER.has(c.verb)))) || (c.kind === "sim" && c.verb === "launch");
  return byManipulation ? { seq: lt.seq, ts: se.ts, release: c.kind === "sim" ? c.cause : se.cause } : null;
}
const sameHome = (st, id, home) => { const e = st.entities[id]; const t = e?.c.transform; if (!t || !home) return false;
  const near = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-3);
  return near(t.pos, home.pos) && near(t.q, home.q) && (e.c.parent?.to ?? null) === (home.parent?.to ?? null); };
// returnAfter (research §3): at the first request after a thing has been unheld that long since a hand or physics last
// moved it, the authority sends it home: the same kind of lazy write as a rest. Once: the return is the last thing that
// moved it, and a return isn't a release.
function returnDue(w) {
  if (!holdsCustody(w)) return;   // a server that can't sign for the world doesn't write to it: its reads still work
  const st = w.state(); const now = w.now(); let sf = null; let warned = w.returnWarned;
  if (warned) for (const id of warned.keys()) if (!st.entities[id]) warned.delete(id);   // forget things that are gone
  for (const [id, e] of Object.entries(st.entities)) {
    const v = e.c.grabbable; if (!v || typeof v !== "object" || !(v.returnAfter > 0)) continue;
    const g = grabOf(e.c); if (!g?.home || w.presence.holds[id] || lostPlace(st, id)) continue;   // where it is now is unknown: it stays
    if (st.entities["@world"]?.c["physics-engine"]) { sf ??= w.sim(); if (sf.launched[id]) continue; }   // in flight, or its rest isn't logged yet
    const r = lastRelease(w, id); if (!r || now - r.ts < g.returnAfter * 1000 || sameHome(st, id, g.home)) continue;
    const { plan, why } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, r.release); warned?.delete(id); continue; }
    // refused (as when its home parent now sits inside it): it stays, and is tried again at every request, so the operator is told
    // once per thing and release, with the reason
    if ((warned ??= (w.returnWarned ??= new Map())).get(id) !== r.seq) { warned.set(id, r.seq);
      console.warn(`[authority] ${id} is due to go home (let go at seq ${r.release}) but its return is refused: ${why}; it stays where it is`); }
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
    if (c.home || ops.some((o) => o.id === t && o.comp === "home")) continue;
    const home = homeHere(after, t); out.push(setOp(t, "home", home)); ctx.notes.push({ id: t, component: "home", kept: home, why: "stamped for the reset that names it: where it stands now" }); }
  return out;
}
// a returning grabbable's home is its home component (shape audit 10-16: grabbable.home is gone)
function stampHomes(ctx, ops) {
  if (ctx.cap || !ops.length) return ops;
  const after = scratch(ctx.st, ops); const out = ops.slice();
  const ids = new Set(ops.filter((o) => o.verb === "create" || (o.verb === "set" && ["grabbable", "transform", "parent"].includes(o.comp)) || (o.verb === "delete" && o.comp === "parent")).map((o) => o.id));
  for (const id of ids) {
    const v = after.entities[id]?.c.grabbable; if (!wantsHome(v)) continue;
    const setsH = ops.some((o) => o.comp === "home" && o.id === id);
    const h = homeOf(after.entities[id].c.home), was = homeOf(ctx.st.entities[id]?.c.home);
    let home = null;
    const born = ops.some((o) => o.verb === "create" && o.id === id);   // a copy or an instance goes home to where it was made, not to its source's home (review 10-06)
    if (!h || (born && !sameHome(after, id, h))) home = homeHere(after, id);
    else if (!setsH && was && sameHome(ctx.st, id, was) && !sameHome(after, id, was)) home = homeHere(after, id);
    if (!home) continue;
    const k = out.findIndex((o) => o.verb === "set" && o.comp === "home" && o.id === id);
    if (k >= 0) out[k] = setOp(id, "home", home); else out.push(setOp(id, "home", home));
    ctx.notes.push({ id, component: "home", kept: home, why: !h ? "stamped: where it goes home to (its transform now)" : "moved with it: its home was where it stood" });
  }
  return out;
}
function flyingWorld(st) {
  const spec = st.entities["@world"]?.c["physics-engine"];
  if (!spec) refuse("no-physics", "this world has no physics running, so nothing flies", "put it down instead (put {id}); the owner can turn physics on: set {id: '@world', component: 'physics-engine', value: {engine: 'eidosim@1.0.0'}}");
  if (!carried(spec)) refuse("foreign-engine", `this world runs ${spec.engine}, which this server doesn't carry`,
    `put it down instead; the owner can move the world to an engine this server carries: set {id: '@world', component: 'physics-engine', value: {engine: '${Object.keys(ENGINES)[0]}'}}`);
  // the ground still loading (a heightmap whose grid isn't here): the engine would land it on the noise law's ground, and
  // its rest is logged for good (review r4 F2). Nothing flies until the ground is here: a throw, a drop, a punt, a shove.
  if (!groundReady(st)) groundOf(st).height(0, 0);   // refuses ground-loading, in the ground's own words
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
  const d = dist(gripPoint(me), pos); if (d > REACH) refuse("out-of-reach", `[${pos.map(r3).join(", ")}] is ${r3(d)} m from your hand as the authority tracks your body; you can reach ${REACH} m`, "move first, or leave pos out");
  return pos.map(noNeg0);
}
function launch(w, actor, a, verb, g = null) {
  const me = body(w, actor); const h = gripOf(w, actor, a.id); occupiedRefuse(w, w.state(), a.id, actor, verb === "drop" ? "dropped" : "thrown");
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
  else h.pose.q = heldQ(w, h);   // let go as it was carried: turned with the body since it was taken (R 10-17 20:54)
  // the rotation is now as of this facing (a refused launch leaves a hold that a later put must not turn twice)
  { const f = facingOf(w, actor); if (f !== null) h.facing = f; else delete h.facing; }
  // the release point is judged before it is written: a refused launch leaves the hold where every client draws it
  const relPos = a.pos !== undefined ? releasePos(me, a.pos) : h.pose.pos;
  // L7 (33 F3): a launch writes no state now, but it decides a write (its rest). Admit the write it releases, as put
  // does: your role and its locks NOW, rate. The plan is a check only; the rest will be the engine's value.
  { const st = w.state(); const t = worldT(st, a.id);
    admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: relPos.map(r3), q: t.q, scale: t.scale })]); }
  // one function with the predicting client (launchplan.js): the body it folds is this body, bit for bit
  const L = planLaunch({ id: a.id, p: relPos, q: h.pose.q, v: a.v, ...(a.w !== undefined ? { w: a.w } : {}) }, g, ENGINES[spec.engine].maxSpeed, verb); const { v, notes } = L;
  h.pose.pos = relPos;   // admitted and planned: the hold now releases from here
  const act = w.append(actOf(w, actor, verb, a, { handled: h.handled }));
  const seq = w.append({ kind: "sim", actor, cause: act, verb: "launch", body: { id: a.id, p: L.p, yaw: qYaw(h.pose.q), ...(ENGINES[spec.engine].rotates ? { q: L.q } : {}), v, ...(a.w !== undefined ? { w: L.w } : {}), handled: h.handled } });
  // R 10-10 evening: what rests on it (a tray's load, or a stack settled onto it) flies too, from where the hand has it,
  // with the same velocity. Left as children they were carried rigidly by the thrown crate and sank with it into the ground.
  const occupants = []; { const st = w.state(); const t = worldT(st, a.id);
    const at = scratch(st, [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", { pos: h.pose.pos.slice(), q: h.pose.q ?? t.q, scale: t.scale })]);
    // each occupant leaves with the tray's velocity at ITS spot (v + w × r: the rim of a tumbling tray moves faster than its
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
      occupants.push(k); } }
  if (occupants.length) notes.push({ flying: occupants, why: `they were resting on ${a.id}; they fly with it` });
  delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: verb, seq: act });
  return { ok: true, seq, act, flying: a.id, from: h.pose.pos.map(r3), ...(notes.length ? { notes } : {}), next: "wait (or any request) logs where it comes to rest" };
}
export { fliesIn, flyingWorld, gripHow, homeScale, launch, recentRests, releasePos, returnDue, returnHome, returnPlan, sameHome, secondGrip, shaped, shoveGate, snapTarget, stampHomes, stampResetHomes, vec3s };
