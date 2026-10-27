// shared/protocol/authority/bodyverbs.js — the verbs a body performs (move, grab, put, throw, drop, punt, leave, wait) as
// EMBODIED_VERBS, which authority.js spreads into VERBS first (refactor split, 2026-10-17; moved from authority.js's
// "physics" section unchanged). They stand on physics.js, occupants.js and manipulate.js; the gate is above them, through UP.
import { TRACK, tokensAfter } from "../../mover.js";
import { atASpawn, spawnsOf, FELL } from "../../spawn.js";
import { DEFAULT_WHO, grabOf, offsetOk } from "../../grab.js";
import { livePoses, ENGINES, carried } from "../simlayer.js";
import { REACH, HAND_Y, MAX_HELD, KICK } from "../physconst.js";
import { r3, noNeg0 } from "../round.js";
import { unitTransform } from "../componentspec.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { delOp, lockedC, scratch, setOp } from "./storage.js";
import { aabb, ancestors, descendants, localFrom, qYaw, worldT } from "./math.js";
import { familyOf, groundOf, groundReady, hitsIx, near, spatial, supportBelow, supportUnder } from "./spatial.js";
import { admits, lastSetterOf, lockStrength, may, roleOf } from "./rights.js";
import { whoWords } from "../roles.js";
import { BODY_VERBS, forgetReaches } from "./bodyconsent.js";
import { thingSaid } from "./blueprints.js";
import { heldEvent } from "./scriptrun.js";
import { clearOccupant, leftOccupied, occupiedRefuse, occupantOf, vacateAt } from "./occupants.js";
import { arrivalBox, body, dist, facingOf, gripPoint, gripOf, heldQ, pathBlocked, refuseForeign, shearFree, sizeOf, solidAt } from "./physics.js";
import { fliesIn, flyingWorld, gripHow, launch, recentRests, releasePos, returnHome, returnPlan, secondGrip, shaped, shoveGate, snapTarget } from "./manipulate.js";
import * as R from "../roles.js";
// who may lift the lock that stops a grab or a punt, as the gate's own lock refusals say it (gate.js lockCheck): a lock at
// owner level is an owner's or its locker's to lift, never any builder's (review of #260, protocol core I73)
const unlockFix = (w, st, k) => { const by = lastSetterOf(w, k, "lock");
  return `${R.lockWord(lockStrength(w, st, k))}${by && !by.deleted ? ` (it was locked by ${said(by.by)})` : ""} can unlock it first: delete {id: '${k}', component: 'lock'}`; };
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const actEntry = (...a) => UP.actEntry(...a);
const actOf = (...a) => UP.actOf(...a);
const admit = (...a) => UP.admit(...a);
const boundsOf = (...a) => UP.boundsOf(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const guess = (...a) => UP.guess(...a);
const notAThing = (...a) => UP.notAThing(...a);
const offRefuse = (...a) => UP.offRefuse(...a);
const outsideWorld = (...a) => UP.outsideWorld(...a);
const rateCheck = (...a) => UP.rateCheck(...a);
const request = (...a) => UP.request(...a);
const warnings = (...a) => UP.warnings(...a);

// review 10-07 M3: hand acts (grab, put, drop, throw, punt) record the request about the THING (and who handled it), never
// the body's position or hand: the put's change carries where the thing went, a launch's sim entry where it left from
// and how fast (what the engine needs, PHYSICS §4). The gate's view of the body stays presence.
const EMBODIED_VERBS = {
  move(w, actor, a) {
    if (!Array.isArray(a.to) || a.to.length !== 3 || a.to.some((n) => !Number.isFinite(n))) refuse("shape", "move needs to: [x, y, z]", "");
    const st = w.state(); const B = boundsOf(st);
    if (B && outsideWorld(B, a.to)) refuse("out-of-bounds", `[${a.to.join(", ")}] is outside this world (x ${B.min[0]}…${B.max[0]}, up to y ${B.max[1]}, z ${B.min[2]}…${B.max[2]})`, "pick a spot inside the bounds");
    let me = w.presence.bodies[actor]; const to = a.to.slice();
    // the speed track's clock is elapsed time (w.pace: a host's monotonic clock), never the log's: a wall clock stepped back
    // (NTP, a VM's host sync) holds the log's clock still — it never goes backwards — and the bucket would refill nothing
    // until the wall caught up, refusing a plain run too-fast (gate 18 navgrid/places). A host without one paces by w.now
    const now = w.pace ? w.pace() : w.now();
    const size = sizeOf(a, me?.size);   // this body's height and scale: what it sends now, else what it sent last
    // a KillZ respawn (shared/spawn.js): a teleport whose reason is on the record, to an arrival place, never from a seat
    const fell = a.reason !== undefined;
    if (fell && (a.reason !== FELL || a.teleport !== true)) refuse("shape", `move's reason is '${FELL}', with teleport: true (a body that fell below the world's bounds, sent back to an arrival place)`, `move {to: <a spawn>, teleport: true, reason: '${FELL}'}`);
    if (fell && !B) refuse("out-of-bounds", "this world has no bounds to fall out of", "teleport without a reason");
    if (fell && occupantOf(w, st, actor)) refuse("doesnt-apply", "a seated body rides its seat: it doesn't fall out of the world", "stand up first");
    if (fell && !atASpawn(st, to)) refuse("spawn", `a body that fell is sent back to an arrival place: [${to.join(", ")}] isn't within one`, `arrive at one of: ${spawnsOf(st).map((s) => `[${s.pos.join(", ")}] (${s.id})`).join("; ") || "(none)"}`);
    if (!me || a.teleport === true) { // a teleport (arriving is one): an act, so the track's reset is on the record
      const mine = Object.entries(w.presence.holds).filter(([, h]) => h.by === actor).map(([id]) => id);
      if (mine.length) refuse("holding", `you're holding ${mine.join(", ")}; a teleport can't carry things`, "put it down (or walk it there) first", { at: me?.at });
      const inSolid = solidAt(w, st, to, new Set(), null, arrivalBox(st, to, size)); if (inSolid) refuse("solid", `[${to.join(", ")}] is inside ${inSolid}`, "arrive somewhere a body fits", { at: me?.at });
      // a visitor arrives at an arrival place: @world.spawn or a spawn-point (shared/spawn.js)
      if (!may(st, actor, "build") && !atASpawn(st, to)) { const all = spawnsOf(st);
        refuse("spawn", `this world's arrivals are within ${all.map((s) => `${s.radius} m of [${s.pos.join(", ")}]`).join(" or ")}`, "arrive there, then walk", { at: me?.at }); }
      rateCheck(w, actor);
      // review 10-07 M3: a body's whereabouts are presence. An ARRIVAL writes nothing to the log (that a person was here
      // at a time is not history the world needs). A TELEPORT while present is an act, because it resets the speed
      // track: who did it and when is on the record; never where from, where to, or what kind of client they are
      const act = me || fell ? w.append(actOf(w, actor, "move", { teleport: true, ...(fell ? { reason: FELL } : {}) })) : undefined;   // a fall is on the record even as an arrival
      w.presence.bodies[actor] = { at: to, ts: now, tokens: TRACK.cap, ...(size ? { size } : {}) }; leftOccupied(w, st, actor, to); w.savePresence();
      return { ok: true, at: to, ...(act !== undefined ? { recorded: true, act } : {}) };
    }
    // still seated in the authority's view: a seated client sends no steps, so this is their first step off the seat (a
    // person's stand-up is presence, never a request): it is measured from the seat, not from where they boarded (r9 M2)
    // the first step is the stand-up (holes r10 L5): the seat clears now, wherever the step goes
    { const sat = occupantOf(w, st, actor); if (sat && vacateAt(w, st, actor, sat.to)) me = w.presence.bodies[actor]; if (w.presence.occupants?.[actor]) clearOccupant(w, actor); }
    const d = dist(me.at, to); const tokens = tokensAfter(me.tokens, now - (me.ts ?? now));
    if (d > tokens + 1e-9) refuse("too-fast", `that's ${r3(d)} m; right now your body can cover ${r3(tokens)} m (${TRACK.speed} m/s, ${TRACK.cap} m at most in one go)`, "walk there in steps, or move {to, teleport: true} (an act on the record; not while holding anything)", { at: me.at });
    const block = pathBlocked(w, st, me.at, to, size);
    if (block?.ground) refuse("solid", block.reason, "walk around it: a gentler slope, or out of the water where the bank is lower", { at: me.at, blocker: "ground" });
    if (block) refuse("solid", `${thingSaid(st, block)} is in the way`, "walk around it (or through a door someone opens)", { at: me.at, blocker: block });
    const prev = me.at; w.presence.bodies[actor] = { ...me, at: to, ts: now, tokens: tokens - d }; if (size) w.presence.bodies[actor].size = size; else delete w.presence.bodies[actor].size; leftOccupied(w, st, actor, to);
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
    if (held?.by === actor) return secondGrip(w, actor, a, held, e);
    // grabOf (shared/grab.js) is the one reader: grabbable, or a dynamic thing's physics.who (the migration fallback)
    const g = grabOf(e.c);
    if (!g) refuse("not-grabbable", `${a.id} isn't something you can pick up`, `a builder can make it so: set {id: '${a.id}', component: 'grabbable', value: {}} (anyone may; {who: 'builder'} for builders only)`);
    if (!g.enabled) refuse("not-grabbable", `${a.id} can't be picked up now (its grabbable.enabled is false)`, "a builder can turn it back on: set {id, component: 'grabbable', value: {…, enabled: true}}");
    const need = g.who; const role = roleOf(st, actor); if (!admits(st, actor, need)) refuse("rights", `only ${whoWords(need)} may pick up ${a.id}`, `ask someone who can, or ask the owner to set ${g.source}.who: 'inhabitant'`);
    if (held && !g.steal && !R.isOwner(role)) refuse("held", `${said(held.by)} is holding ${a.id}, and it can't be taken from a hand (grabbable.steal is false)`, "wait till they let go (an owner may take it)");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be picked up`, unlockFix(w, st, k), { lock: k });
    occupiedRefuse(w, st, a.id, actor, "picked up");
    // two things at once (R, 10-10, an avatar walking about with five crates: "maybe two, since VR players can pick up two
    // things"; a number, not a claim about hands: "avatars can have more (or none!)")
    { const mine = Object.keys(w.presence.holds).filter((k) => k !== a.id && w.presence.holds[k].by === actor);
      if (mine.length >= MAX_HELD) refuse("hold-limit", `you are already holding ${mine.length} things (${mine.join(", ")}), and ${MAX_HELD} is the most you can carry here`, `put one down first: put {id: '${mine.at(-1)}'}`); }
    const live = livePoses(sf)[a.id]; const t = worldT(st, a.id); const eb = sf.launched[a.id] ? sf.sim?.bodies[a.id] : null;
    const here = held ? held.pose.pos : live ? live.pos : eb ? eb.p : t.pos; // where it IS: someone's hand, the air, the engine (rested, not yet logged: second review S2-1), or the log
    // range (grabbable): from the hand; past arm's reach the authority grants it as a pull (the thing flies to the hand: a
    // presence ease on every client), never a hold at a distance (the reach check is the anti-cheat)
    // reach is to the NEAREST POINT of its box when it stands in the world, not to its origin (a barrel's origin is at its
    // base: standing against it is in reach; R 10-11 23:27). In a hand or in the air: to where it is.
    const hp = gripPoint(me), bx = !held && !live && !eb ? aabb(st, a.id) : null;
    const reachPt = bx ? [0, 1, 2].map((i) => Math.min(bx.max[i], Math.max(bx.min[i], hp[i]))) : here;
    const d = dist(hp, reachPt); if (d > g.range) refuse("out-of-reach", `${a.id} is ${r3(d)} m from you; you can reach ${g.range} m`, `move {to: [${r3(here[0])}, ${me.at[1]}, ${r3(here[2])}]} (your feet stay on the floor; your hand reaches ${HAND_Y} m up) first`);
    const how = gripHow(a, g); // which hand, by which grip or offset: refused before anything is written
    const prev = w.presence.holds[a.id]; const notes = [];
    if (d > REACH) notes.push({ id: a.id, pulled: r3(d), why: `it was ${r3(d)} m away; its grabbable.range lets it fly to your hand` });
    if (prev && prev.by !== actor) notes.push({ id: a.id, takenFrom: prev.by, why: "the latest grab wins; they were told" });
    // what rested on it (and isn't its child, which rides along) loses its support (playtest 22, F3)
    const fam = new Set([a.id, ...descendants(st, a.id)]);
    const over = new Set(); if (!live) for (const s of spatial(st).rec.get(a.id)?.surfs ?? []) for (const k of near(st, [s.min[0], s.y - 0.02, s.min[1]], [s.max[0], Infinity, s.max[1]])) over.add(k);   // only what stands over its surfaces (the index)
    const dependents = live ? [] : Object.keys(st.entities).filter((k) => { if (fam.has(k) || !over.has(k)) return false; const b = aabb(st, k);
      return b && !st.entities[k].c.parent && supportUnder(st, b, familyOf(st, k)).id === a.id; });
    // R 10-17 20:05 (the gym, pyr-7 under pyr-9): a thing the physics rested on TWO supports is parented to one of them (its
    // settle picks one), and resting on the other all the same. Taken out from under it, that other support left it standing
    // in mid-air: it is neither this thing's descendant nor unparented, and the engine wakes a sleeper only when a moving
    // body touches it (PHYSICS "Waking and knocking"), never when what it rests on leaves. So under a carried engine, a
    // dynamic thing parented elsewhere that TOUCHES one of its tops (its oriented box meets the thin slab just over that top)
    // loses its support too, and falls from rest; the engine decides whether the support it keeps still holds it. A thing a
    // hand rule fixes (locked, or under a lock) or someone holds is no sleeper (simlayer fixedSet) and stays.
    // the world HAS an engine (carried here or not): what would fall is the same set either way; an uncarried one refuses it below
    const physW = !!st.entities["@world"]?.c["physics-engine"];
    if (physW && !live) for (const k of over) { const c = st.entities[k]?.c;
      if (!c || fam.has(k) || dependents.includes(k) || !c.parent || c.physics?.kind !== "dynamic" || w.presence.holds[k] || [k, ...ancestors(st, k)].some((x) => lockedC(st.entities[x]?.c))) continue;
      if ((spatial(st).rec.get(a.id)?.surfs ?? []).some((s) => hitsIx(st, { min: [s.min[0], s.y - 0.01, s.min[1]], max: [s.max[0], s.y + 0.03, s.max[1]] }, k, 0))) dependents.push(k); }
    // R 10-10: what the physics stacked on it (a dynamic child, its rest attached it) does NOT come along unless it carries
    // ('can carry other entities', a tray): picking up the bottom crate of a stack takes that crate; the rest fall and
    // tumble. A builder's attachment (a child that isn't dynamic) still rides.
    if (physW && !live && !g.carries) for (const k of descendants(st, a.id)) if (st.entities[k]?.c.physics?.kind === "dynamic" && !dependents.includes(k)) dependents.push(k);
    for (const k of dependents) { const gk = grabOf(st.entities[k].c);
      const lockK = [k, ...ancestors(st, k)].find((x) => lockedC(st.entities[x]?.c)); if (lockK) refuse("locked", `${k} rests on ${a.id}, and ${lockK === k ? "it" : lockK} is locked, so picking ${a.id} up would move it`, `take ${k} off first, or unlock ${lockK} (delete {id: '${lockK}', component: 'lock'})`, { lock: lockK });
      if (!may(st, actor, "editOthers") && !(gk && gk.enabled && admits(st, actor, gk.who))) refuse("rights", `${k} rests on ${a.id}, and you can't move ${k}`, "picking it up would move what's on it; ask someone who can to take it off first"); }
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
      const ops = carriedUp.flatMap(({ k, lt }) => [setOp(k, "parent", { to: a.id }), setOp(k, "transform", lt)]);
      carriedUp = carriedUp.map((x) => x.k);
      if (ops.length) plan = admit(w, st, { actor, cap: { kind: "system", ids: carriedUp, comps: ["transform", "parent"] } }, ops);
      dependents.length = 0;
    }
    if (dependents.length && spec && !carried(spec)) refuseForeign(spec, `picking that up would set ${dependents.join(", ")} falling (they rest on it)`);
    if (dependents.length && !spec) {   // no physics in this world: what rested on it is set down on what's below (a settlement, no engine)
      const ops = dependents.map((k) => { const b = aabb(st, k); const below = supportUnder(st, b, new Set([k, ...fam, ...descendants(st, k)])); const tk = worldT(st, k);
        return setOp(k, "transform", { ...tk, pos: [tk.pos[0], r3(tk.pos[1] - (b.min[1] - below.y)), tk.pos[2]] }); });
      plan = admit(w, st, { actor, cap: { kind: "system", ids: dependents, comps: ["transform"] } }, ops);
    }
    // what would fall is launched from rest by the engine, and with the ground still loading it would come to rest on a
    // guessed height (review r5 F2, as flyingWorld refuses a throw): refused before anything is written
    if (dependents.length && spec && carried(spec) && !groundReady(st)) groundOf(st).height(0, 0);   // refuses ground-loading, in the ground's own words
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
    const hand = gripPoint(me); // in your hand now (a VR client would send the hand's pose)
    // as it's turned now: caught mid-air, the sim's; taken from another hand, as that hand turned it; else the log's. With the
    // holder's facing as taken, so it keeps its turn relative to the body (heldQ)
    const facing = facingOf(w, actor);
    const q0 = (live && sf.sim.bodies[a.id]?.q) ? sf.sim.bodies[a.id].q.slice() : prev ? heldQ(w, prev) : t.q;
    w.presence.holds[a.id] = { by: actor, since: w.now(), pose: { pos: hand, q: q0, scale: t.scale }, ...(facing !== null ? { facing } : {}), handled, ...how };
    w.savePresence();
    heldEvent(w, "grab", a.id, { by: actor, hand: how.hand, ...(how.grip ? { grip: how.grip } : {}), ...(act !== null ? { seq: act } : {}) });
    return { ok: true, recorded: act !== null, holding: a.id, inHandAt: hand.map(r3), ...how, ...(notes.length ? { notes } : {}) };
  },
  // P3: putting something down is a settlement: a claim the authority checks like any write, then logs as a plain result.
  // grabbable says where it goes (research §3): home (release: return), into a socket that accepts it (fits), where
  // the hand let go (release: stay), or straight down onto what's below (drop, the default).
  put(w, actor, a, how = "put") {
    const me = body(w, actor); const h = gripOf(w, actor, a.id);
    const st = w.state(); occupiedRefuse(w, st, a.id, actor, "set down"); const t = worldT(st, a.id); const g = grabOf(st.entities[a.id].c);
    const facts = () => ({ handled: h.handled });
    // review 10-06: the claim is checked before anything acts on it: a pos is [x, y, z] within reach (a far or malformed
    // pos snapped into a socket across the world), and the holder's rank NOW still covers carrying it (the return and the
    // snap are the holder's settlements too, as a plain put is)
    if (a.pos !== undefined) { if (!Array.isArray(a.pos) || a.pos.length !== 3 || a.pos.some((n) => !Number.isFinite(n))) refuse("shape", "put takes pos: [x, y, z] (or nothing: straight down)", "");
      const d0 = dist(gripPoint(me), a.pos); if (d0 > REACH) refuse("out-of-reach", `that's ${r3(d0)} m from you; you can reach ${REACH} m`, "move closer first"); }
    { const role = roleOf(st, actor); if (g && !admits(st, actor, g.who)) refuse("rights", `only ${whoWords(g.who)} may move ${a.id} by hand; you are ${role}`, `ask the owner to set ${g.source}.who`); }
    // home: the holder's act, then the authority's return (its own act, caused by the release)
    if (g?.release === "return" && g.home) {
      const ret = returnPlan(w, st, a.id, g);
      // the return is the authority's act, but the put is the holder's settlement: what binds their plain put (the thing's
      // own lock) binds this one too, so the same ops are admitted as the holder's first
      if (ret.plan) admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ret.plan.ops);
      if (ret.plan) { rateCheck(w, actor); const act = w.append(actOf(w, actor, "put", a, { ...facts(), release: "return" }));
        const back = returnHome(w, a.id, ret.plan, act); delete w.presence.holds[a.id]; w.savePresence(); heldEvent(w, "release", a.id, { by: actor, how: "return", seq: act });
        return { ok: true, act, seq: back.seq, settled: { id: a.id, home: g.home }, handled: h.handled, release: "return", notes: [{ id: a.id, why: "its grabbable.release is return: it went home" }] }; }
    }
    // a socket that accepts it, within that socket's radius of where it's let go (Resonite Snapper, XRI Socket)
    const snap = snapTarget(st, a.id, g, a.pos ?? h.pose.pos, w);
    if (snap.to) { const x = snap.to;
      // it sits at the socket's own pose (identity under it); its size in the world is kept
      const hs = worldT(st, x.id).scale; const scale = t.scale.map((v, i) => r3(v / hs[i]));
      const ops = [setOp(a.id, "parent", { to: x.id }), setOp(a.id, "transform", { pos: [0, 0, 0], q: [0, 0, 0, 1], scale })];
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
    const d = dist(gripPoint(me), pos); if (d > REACH) refuse("out-of-reach", `that's ${r3(d)} m from you; you can reach ${REACH} m`, "move closer first");
    const q = a.q ?? heldQ(w, h); const value = unitTransform({ pos, q, scale: t.scale });   // turned with the body as it was carried (heldQ)
    const ops = [...(st.entities[a.id].c.parent ? [delOp(a.id, "parent")] : []), setOp(a.id, "transform", value)];
    // the one gate first (your role and its locks NOW, not when you picked it up), then the physical claim on top
    const plan = admit(w, st, { actor, cap: { kind: "handle", ids: [a.id], comps: ["transform", "parent"] } }, ops);
    const bad = warnings(plan.after, [a.id], true).filter((x) => !(stay && (x.kind === "floating" || x.kind === "sunk")))
      .filter((x) => !(x.with && w.presence.holds[x.with]));   // not "inside" a thing that is in someone's hand (the log has it where it was picked up)
    // set down where it doesn't fit (against a neighbour, on a ledge): in a world that runs physics a loose thing is let
    // go there instead, from the hand's height, and physics finds where it rests. Only for the plain put (no pos claimed).
    if (bad.length && a.pos === undefined && !stay && fliesIn(st, a.id)) return EMBODIED_VERBS.drop(w, actor, { id: a.id, pos: [pos[0], r3(h.pose.pos[1]), pos[2]] });
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
      const r = EMBODIED_VERBS.drop(w, actor, { id: a.id, ...(a.pos !== undefined ? { pos: a.pos } : {}) }, "throw");
      return r.ok && why ? { ...r, notes: [...(r.notes ?? []), { id: a.id, thrown: "set down", why }] } : r;
    }
    return launch(w, actor, a, "throw", g);
  },
  drop(w, actor, a, how = "drop") {
    if (a.hand !== undefined) { const h = gripOf(w, actor, a.id); if (!["left", "right"].includes(a.hand)) refuse("shape", "hand is left or right", "");
      if (h.second && (a.hand === h.second.hand || a.hand === h.hand)) { // one hand of two lets go: the other keeps it (presence, unlogged)
        if (a.hand === h.hand) { h.hand = h.second.hand; delete h.offset; if (h.second.grip) h.grip = h.second.grip; else delete h.grip; }
        delete h.second; w.savePresence(); return { ok: true, recorded: false, holding: a.id, hand: h.hand, note: `your ${a.hand} hand let go; your ${h.hand} hand still holds it` }; }
      if (a.hand !== h.hand) refuse("not-holding", `your ${a.hand} hand isn't holding ${a.id} (your ${h.hand} hand is)`, `drop {id: '${a.id}'} lets go`); }
    const st = w.state(); const g = grabOf(st.entities[a.id]?.c);
    // what doesn't fly is set down from where the hand let go; so is what goes home, into a socket, or stays
    const sets = !fliesIn(st, a.id) || g?.release === "return" || g?.release === "stay" || (g && w.presence.holds[a.id]?.by === actor && snapTarget(st, a.id, g, a.pos ?? w.presence.holds[a.id].pose.pos).to);
    if (sets) {
      if (a.pos !== undefined) { const me = body(w, actor); const h = gripOf(w, actor, a.id); h.pose.pos = releasePos(me, a.pos); }
      return EMBODIED_VERBS.put(w, actor, { id: a.id }, how); }
    return launch(w, actor, { ...a, v: [0, 0, 0] }, "drop", g);
  },
  // a punt (/punt, an agent's punt request), as a sim intent (design 20, P4: "punt is a sim intent
  // too"). A thing low beside the body (or in the air beside it: a volley) is launched with v, or with power along the line
  // from where the body stands through it, lifted (physobj's 0.9 ratio: a knee-high hop at power 4). Its gates are grab's:
  // dynamic, physics.who, its locks and its ancestors', and nobody's hand. A thing in flight is caught and re-launched (logged).
  // `contact: true` is a moving body's push (shoveGate); `shove: true` is its old spelling, taken at the door and recorded
  // as `contact` (R 10-17 14:34: one word, `shove`, stays for knocking a BODY over). Both at once is no request.
  punt(w, actor, a) {
    if (a.shove !== undefined) { if (a.contact !== undefined) refuse("shape", "contact, or its old spelling shove: not both", "send contact: true");
      a = { ...a, contact: a.shove }; delete a.shove; }
    const me = body(w, actor); const st = w.state(); const e = st.entities[a.id];
    if (!e) refuse("not-found", `no '${a.id}'`, "look lists what's here", { didYouMean: guess(a.id, Object.keys(st.entities)) });
    notAThing(st, a.id, "punted"); offRefuse(st, a.id, "punted");
    const spec = flyingWorld(st);
    const ph = e.c.physics;
    if (ph?.kind !== "dynamic") refuse("not-dynamic", `${a.id} isn't something you can punt`, `a builder can make it so: set {id: '${a.id}', component: 'physics', value: {kind: 'dynamic'}}`);
    const need = ph.who ?? DEFAULT_WHO; if (!admits(st, actor, need)) refuse("rights", `only ${whoWords(need)} may punt ${a.id}`, "ask the owner to set physics.who: 'inhabitant'");
    for (const k of [a.id, ...ancestors(st, a.id)]) if (lockedC(st.entities[k]?.c)) refuse("locked", `${k === a.id ? `${a.id} is locked` : `${a.id} is attached to ${k}, which is locked`}, so it can't be punted`, unlockFix(w, st, k), { lock: k });
    const held = w.presence.holds[a.id]; if (held) refuse("held", `${said(held.by)} is holding ${a.id}`, "grab it to take it (the latest grab wins), or wait till they let go");
    occupiedRefuse(w, st, a.id, actor, "punted");
    shaped(e, a.id, st.entities["@world"]?.c["physics-engine"] ?? null);
    if (a.v !== undefined && a.power !== undefined) refuse("shape", "punt takes v or power, not both", "v: [x, y, z] in m/s, or power (m/s) along the line from where you stand through it");
    const sf = w.sim(); const b = sf.sim?.bodies[a.id]; const flying = !!(sf.launched[a.id] && b && !b.resting);
    const t = worldT(st, a.id); const here = flying ? b.p : t.pos;
    const dx = here[0] - me.at[0], dz = here[2] - me.at[2], dh = Math.hypot(dx, dz), dy = here[1] - me.at[1];
    if (a.contact !== undefined) shoveGate(w, st, me, a, flying, actor);
    else if (dh > KICK.reach || dy < KICK.below || dy > KICK.above) refuse("out-of-reach", `${a.id} is ${r3(dh)} m from where you stand${dy > KICK.above ? `, ${r3(dy)} m up` : ""}; a punt reaches ${KICK.reach} m`, `move {to: [${r3(here[0] - (dh > 1e-6 ? dx / dh : 0) * 0.5)}, ${me.at[1]}, ${r3(here[2] - (dh > 1e-6 ? dz / dh : 1) * 0.5)}]} first`);
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
    delete w.presence.bodies[actor]; forgetReaches(w.presence, actor); clearOccupant(w, actor); w.savePresence();   // F3 (b): a yes ends when either person leaves
    return { ok: true, left: true, dropped: out.map(({ id, r }) => ({ id, ok: r.ok, ...(r.refused ? { refused: r.refused.reason } : {}) })) };
  },
  wait(w) {
    const sf = w.sim(); const now = w.now();
    const rests = recentRests(w, now).map((r) => {
      const par = sf.st.entities[r.id]?.c.parent?.to;
      return { id: r.id, at: r.at.map(r3), ...(r.lost ? { lost: r.lost === "home" ? "landed outside the world; it's back at its home" : "landed outside the world; it's back where it was picked up" } : { on: par ?? "ground" }), secondsAgo: Math.round((now - r.when) / 1000) }; });
    const stuck = sf.rested.map((r) => ({ id: r.id, launch: r.seq, at: r.p.map(r3), why: (w.unsettled ?? []).find((u) => u.id === r.id)?.reason ?? "not yet logged" }));
    return { ok: true, inFlight: livePoses(sf), ...(rests.length ? { cameToRest: rests } : {}), ...(stuck.length ? { unsettled: stuck } : {}) };
  },
};
export { EMBODIED_VERBS };
