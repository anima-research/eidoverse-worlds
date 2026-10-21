// shared/protocol/authority/physics.js — physics (design 20), the engine and the body: settleSim (the rests a request
// logs), restampEngine, buildEpoch, a body's track and hand, what is solid, ground steps and blocked paths, a body's
// size and law (refactor split, 2026-10-17; moved from authority.js's "physics" section unchanged; who rides what is
// authority/occupants.js, what a body does to a loose thing authority/manipulate.js, the verbs a body performs
// authority/bodyverbs.js). The gate and manipulate's returnPlan are above it, reached through UP.
import { MOVER, bodyBox, bodyScale, floorStep, sweep } from "../../mover.js";
import { COMPONENTS } from "../componentspec.js";
import { livePoses, digestOf, restEta, ENGINES, carried, TICK_MS, engineName, stampOf } from "../simlayer.js";
import { HAND_Y } from "../physconst.js";
import { r3, noNeg0 } from "../round.js";
import { qFromYaw, qMul } from "../../rot.js";
import { UP } from "./ctx.js";
import { Refusal, refuse, said } from "./refuse.js";
import { readback, delOp, isE, opsQuiet, scratch, setOp } from "./storage.js";
import { aabb, descendants, localFrom, worldT } from "./math.js";
import { groundOf, groundReady, hitsIx, near, spatial, spend, supportBelow, supportUnder } from "./spatial.js";
// the layers above this one (a leaf may not import them: authority-layers-check), reached through UP (ctx.js), which
// authority.js binds at load
const actEntry = (...a) => UP.actEntry(...a);
const admit = (...a) => UP.admit(...a);
const boundsOf = (...a) => UP.boundsOf(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const guess = (...a) => UP.guess(...a);
const outsideWorld = (...a) => UP.outsideWorld(...a);
const returnPlan = (...a) => UP.returnPlan(...a);
const unknownKeys = (...a) => UP.unknownKeys(...a);

// ---------- physics (design 20) ----------
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const gripPoint = (me) => [me.at[0], me.at[1] + HAND_Y, me.at[2]]; // reach is measured from the hand, not the feet
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
      if (!groundReady(st2)) continue;   // the ground still loading (r3 F3): no rest-attach judged on a guessed height
      const sup = bx ? supportUnder(st2, bx, fam) : supportBelow(st2, r.p[0], r.p[2], r.p[1] + 0.02, fam);
      if (sup.id === "ground" || (bx && sup.y < bx.min[1] - 0.03)) continue;
      // never under a support whose scale isn't uniform (a domino: a crate at [1, 2, 0.2]): a child of a rotated, non-uniformly
      // scaled parent is SHEARED by the composition (R 10-11 23:36: a crate "splortched" after a domino fell with it on top)
      const wt = worldT(st2, r.id); const s3 = scratch(st2, [setOp(r.id, "parent", { to: sup.id })]); const lt = localFrom(s3, sup.id, wt);
      if (!shearFree(worldT(st2, sup.id).scale, lt.q)) continue;
      const attach = [setOp(r.id, "parent", { to: sup.id }), setOp(r.id, "transform", lt)];
      const p3 = admit(w, st2, { actor: "system", cap: { kind: "system", ids: [r.id], comps: ["transform", "parent"] } }, attach);
      changeEntry(w, p3, w.append(actEntry(w, "system", "settle", { id: r.id, onto: sup.id, rest })));
    }
  }
}
// A deploy changes the versions a server carries (REVIEW-design-2026-10-15 "Deploying switches physics off"): a world the old
// server stamped names a version this one may not carry, carried() calls it foreign, and nothing would fly until an owner
// rewrote physics-engine. The authority restamps it itself, as system, at the first act or heartbeat after load, when all
// of these hold:
//   - this server carries an engine of that NAME, under another version (stampOf: the one it would stamp today);
//   - that version was STAMPED (no version typed: by an authority, or by this restamp), never named by the owner: a
//     version the owner chose is the owner's word (phys-check pc-k, R5), and stays foreign;
//   - nothing is held in presence right now (a hand lets go soon; the cut tries again at the next act). A flight does NOT
//     hold it back (house answer, #260 10-21): this server can't compute it, so the cut ends it where the fold has it, and
//     the act names what it ended. The log is read from the epoch's start for those: a launch whose body has no rest under
//     it is in flight; a purged launch (readback null) is a flight whose body is unknown, counted, not named.
// Otherwise it does nothing and the world stays foreign (the owner can still restamp by hand, force: true). Checked once
// per world object and spec (a heartbeat doesn't re-read the log), except while a hold is what blocks it.
const restampTried = new WeakMap();
function restampEngine(w) {
  const st = w.state(); const spec = st.entities["@world"]?.c["physics-engine"]; const today = spec && typeof spec.engine === "string" ? stampOf(engineName(spec.engine)) : null;
  if (!today || carried(spec)) return;   // an engine of a name this server doesn't carry is never restamped: there's nothing to cut to
  const key = JSON.stringify(spec); if (restampTried.get(w) === key) return;
  if (w.custody?.()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return;   // a server that can't sign for the world doesn't write to it
  if (Object.keys(w.presence?.holds ?? {}).length) return;   // held right now: try again at the next act
  restampTried.set(w, key);
  // Named by the owner? Each change's cause act carries the request as sent (L4). A later merge of tickMs types no engine,
  // and leaves the named one in place (review r2 F7). A fork-copy is inherited, not chosen (review r2 F4: forkWorld's copy
  // carries the source's stamped value), and system acts (restamps) never name.
  // the engine word a request typed for physics-engine, or undefined when it typed none (a merge of tickMs alone)
  const word = (v) => { if (!v || typeof v !== "object") return undefined; if (Array.isArray(v)) { for (const x of v) { const r = word(x); if (r !== undefined) return r; } return undefined; }
    if (v.component === "physics-engine" && typeof v.value?.engine === "string") return v.value.engine;
    for (const x of Object.values(v)) { const r = word(x); if (r !== undefined) return r; } return undefined; };
  // READBACK: the cause act's request is read back; a purged one (readback null) is an UNKNOWN chooser, and unknown means
  // the owner may have chosen it: never restamped (engine-scars 4/6c: a purge made an owner's choice look stamped)
  // → "named" (the owner's word), "stamped" (an authority's), or "skip" (this change didn't touch the engine: look further back)
  const chose = (e) => { const c = E[e.cause]; if (!(isE(c) && c.kind === "act") || c.actor === "system" || c.verb === "fork-copy") return "stamped";
    const b = readback(w, e.cause); if (b === null) return "named";
    const t = word(b.request); return t === undefined ? "skip" : t.includes("@") ? "named" : "stamped"; };
  // Walking back from the newest physics-engine change, the first whose act typed an engine decides: a version typed is the
  // owner's, the engine alone is stamped (10-21: compared VALUES ended the walk when a stamp equalled an earlier named
  // version — R7c — and the stamp read as the owner's). A delete ends it: the epoch before is another world's physics.
  const E = w.entries; let from = -1;
  for (let s = E.length - 1; s >= 0; s--) { const e = E[s]; if (!(isE(e) && e.kind === "change")) continue;
    const o = opsQuiet(e).filter((x) => x.id === "@world" && x.comp === "physics-engine").at(-1); if (!o) continue;
    if (from < 0) from = s;
    if (o.verb !== "set") break;
    const c = chose(e); if (c === "named") return; if (c === "stamped") break; }
  if (from < 0) return;
  // what the cut ends (house answer, #260 10-21): this server can't compute the old version's flights, so a cut that waited
  // for their rests would never come. Each flight is ended by the cut itself, left where the fold has it (the fold never
  // moved it: only a rest would), and named in the act; that's the cut's change, not a rest. A lift on the record outlives
  // an epoch (the sim layer keeps it), so it doesn't hold the cut back either. Only a hold in presence does, below.
  const out = new Map();   // id → the launch seq it flies under, or "held"
  let unknownFlights = 0;
  for (let s = from + 1; s < E.length; s++) { const e = E[s]; if (!isE(e)) continue;
    if (e.kind === "sim") { const b = readback(w, s); if (b === null && ["launch", "lift", "catch"].includes(e.verb)) { if (e.verb === "launch") unknownFlights++; continue; }   // READBACK: a purged flight names no body: unknown, so counted as ended by the cut
      if (b?.id) { if (e.verb === "launch") out.set(b.id, s); else if (e.verb === "lift" || e.verb === "catch") out.set(b.id, "held"); } continue; }
    if (e.kind !== "change") continue;
    const c = E[e.cause]; const rest = isE(c) && c.kind === "sim" && c.verb === "launch";
    for (const o of opsQuiet(e)) { const f = out.get(o.id); if (f === undefined) continue;
      if (rest ? f === e.cause : (f === "held" && (o.verb === "create" || ["transform", "parent"].includes(o.comp) || (o.comp === "disabled" && o.verb === "set" && o.value === true)))) out.delete(o.id);
      else if (o.verb === "delete" && o.comp === undefined) out.delete(o.id); } }
  const ended = [...out].filter(([, f]) => f !== "held").map(([id]) => id).sort();
  const next = { engine: today, ...(spec.tickMs !== undefined ? { tickMs: spec.tickMs } : {}) };   // declared fields only: an older value's build goes
  let plan; try { plan = admit(w, st, { actor: "system", cap: { kind: "system", ids: ["@world"], comps: ["physics-engine"] } }, [setOp("@world", "physics-engine", next)]); }
  catch (x) { if (!(x instanceof Refusal)) throw x; return; }
  changeEntry(w, plan, w.append(actEntry(w, "system", "restamp-engine", { id: "@world", component: "physics-engine", from: spec.engine, to: next.engine,
    ...(ended.length ? { ended } : {}), ...(unknownFlights ? { endedUnknown: unknownFlights } : {}),
    why: ended.length || unknownFlights ? `engine ${spec.engine} → ${next.engine}: restamped by the server; ${ended.length + unknownFlights} flight(s) it can't compute ended by the cut, where the log has them`
      : `engine ${spec.engine} → ${next.engine}: restamped by the server; bodies at rest` })));
}
// P6: an engine change is a real cut. At rest the cut is free (the log already holds every result); in flight it waits.
function buildEpoch(ctx, v, a) {
  const sf = ctx.w.sim(); const live = [...new Set([...Object.keys(livePoses(sf)), ...sf.rested.map((r) => r.id)])]; // at rest but not on the record counts (33 F2): P6's "free" needs every result logged
  if (live.length && !a.force) refuse("busy", `${live.length} thing(s) are still in flight or not yet on the record (${live.join(", ")}); all at rest in about ${r3((restEta(sf) ?? 0) / 1000)} s`, "try again then, or force: true to freeze them where they are now (they'll be logged there)");
  // a rigid engine's origin only means something with its own q. The pose is the engine's WORLD pose, so a logged parent goes,
  // as an ordinary rest drops it (settleSim's opsFor): kept, its offset would be applied again (Antra's review of f91840e5: x 10 → 20)
  const ops = live.flatMap((id) => { const b = sf.sim.bodies[id]; return [...(sf.st.entities[id]?.c.parent ? [delOp(id, "parent")] : []), setOp(id, "transform", { ...worldT(sf.st, id), pos: b.p.slice(), ...(b.q ? { q: b.q.slice() } : {}) })]; });
  for (const id of live) ctx.refs.add(id);
  if (live.length) ctx.notes.push({ frozen: live, why: "forced cut: stopped mid-air and logged where they were" });
  if (v === null) return [...ops, delOp("@world", "physics-engine")];
  if (!v || typeof v.engine !== "string") refuse("shape", "sim needs {engine, tickMs?}", `engines this server carries: ${Object.keys(ENGINES).join(", ")}`);
  unknownKeys("@world.physics-engine", v, Object.keys(COMPONENTS["physics-engine"].fields), "physics-engine"); // the authority builds the value from these keys: a typo would vanish silently
  // a version named is the owner's word; no version named, the authority stamps the one it carries (house answer, #260 10-21)
  const versioned = v.engine.includes("@"), stamp = stampOf(engineName(v.engine));
  const spec = { engine: versioned ? v.engine : stamp, tickMs: Number.isInteger(v.tickMs) ? v.tickMs : COMPONENTS["physics-engine"].defaults.tickMs };   // the registry's default (shape audit 10-16)
  if (!stamp) refuse("unknown-engine", `this server carries no engine named '${engineName(v.engine)}'`, `it carries: ${Object.keys(ENGINES).join(", ")}`, { didYouMean: guess(v.engine, Object.keys(ENGINES)) });
  // the engine never starts an epoch outside its tick range, so a throw would be logged and then fly nowhere, forever
  // (review of b398d7e3 #3)
  if (v.tickMs !== undefined && !(Number.isInteger(v.tickMs) && v.tickMs >= TICK_MS.min && v.tickMs <= TICK_MS.max))
    refuse("bounds", `tickMs is ${JSON.stringify(v.tickMs)}; the engine steps at a whole number of ms from ${TICK_MS.min} to ${TICK_MS.max}`, `leave it out for ${COMPONENTS["physics-engine"].defaults.tickMs} (30 steps a second), or e.g. tickMs: 16`);
  if (!versioned) ctx.notes.push({ component: "physics-engine", field: "engine", kept: spec.engine, why: "stamped: no version named, so the authority names the one it carries (a version is what its conformance digests say it computes)" });
  if (!carried(spec)) ctx.notes.push({ component: "physics-engine", why: `${spec.engine} isn't carried here (this server carries ${stamp}): nothing will be thrown in this world until a server that carries it runs it, or an owner sets one this server carries` });
  // what is in a hand as the engine starts stays out of its world. A grab without a carried engine logged no lift, and holds are
  // presence, which no reader replays: so the epoch write logs one lift per such thing (commit appends them after the change),
  // and every reader folds the same engine world from the log alone. Older logs without these stay as they are.
  else ctx.lifts = Object.keys(ctx.w.presence.holds ?? {}).filter((id) => ctx.st.entities[id] && !sf.lifted.has(id)).sort();
  ctx.refs.add("@world");
  return [...ops, setOp("@world", "physics-engine", spec)];
}
function body(w, actor) {
  const b = w.presence.bodies[actor];
  if (!b) refuse("not-here", "your body isn't in the world yet", "move {to: [x, y, z]} puts it somewhere (bodies are presence: never logged)");
  return b;
}
// R 10-17 20:54 (the gym): "the crates always spin around to orient the same way no matter how I put them down". A carried
// thing turns with its holder's body (every client draws it so: thingphysics placeHeld), and the hold kept only its world
// rotation as taken, so a put landed it at that, and it spun back on release. The hold now also keeps the holder's facing
// as taken; what it is let go at is that rotation turned about up by as far as the body has turned since (yaw only: its
// tilt is as it was). The facing is what the server relays of the body's pose (its root's yaw about +y, as every client
// draws it): presence, the same number everyone's drawn carry turns by. Unknown (no relayed pose): as taken, as before.
function facingOf(w, actor) { for (const p of w.present?.() ?? []) if (p && p.id === actor && Number.isFinite(p.yaw)) return p.yaw; return null; }
/** A held thing's world rotation now: as it was taken, turned about up by how far its holder has turned since. */
function heldQ(w, h) { const y = facingOf(w, h.by); const q = h.pose?.q;
  if (!Number.isFinite(h.facing) || y === null || !Array.isArray(q)) return q;
  return qMul(qFromYaw(y - h.facing), q).map((n) => noNeg0(Math.round(n * 1e6) / 1e6)); }
function gripOf(w, actor, id) {
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
// The numbers and the body's box are the MOVER's (shared/mover.js): the one walker the agent and the client step with,
// so a step the mover takes is one this track accepts, and this track's refusal is the mover's own answer.
// both ask the spatial index: only what the body's box (or the whole step's swept box) meets is tested (review 10-06 S0-2)
function solidAt(w, st, p, except = new Set(), cands = null, box = bodyBox(p)) {
  const held = w.presence.holds; const ix = cands && spatial(st);
  if (cands) spend(1 + (cands.length >> 3));   // a sub-step filters the step's candidates by box first
  for (const id of cands ?? near(st, box.min, box.max)) { if (id === "@world" || Object.hasOwn(held, id) || except.has(id) || openNow(st, id)) continue;
    if (cands) { const q = ix.rec.get(id).q; if (q.min[0] > box.max[0] || q.max[0] < box.min[0] || q.min[1] > box.max[1] || q.max[1] < box.min[1] || q.min[2] > box.max[2] || q.max[2] < box.min[2]) continue; }
    if (hitsIx(st, box, id, 0.01)) return id; }
  return null;
}
// an open openable (a whole door, not a cabinet's part) is out of the way: the fix above says "through a door someone
// opens", and every browser's collider follows the drawn leaf (client/lib/openable.js reindexes it at rest)
const openNow = (st, id) => { const o = st.entities[id]?.c.openable; return !!o && typeof o === "object" && o.open === true && !o.part; };
// THE GROUND under a body (owner 10-15 22:34; holes review H2). In a world with terrain (and water), each point of a step is
// judged with the MOVER's floor law (shared/mover.js floorStep: the walker's own), on the ground the walker walks on: the
// terrain heightfield, and any placed top the body could step (or haul out) onto from where it is. The law says where the
// feet end up, whether the water's rule holds (then the box is the swimmer's: bodyBox with the level), and refuses a floor
// that is a wall from here (a terrain bank too high above the water, a cliff). A move is longer than a stride (an agent asks
// for 2 m at once), so its points are judged as a chain of sub-strides, each from the last; and a body that swam earlier in
// the move may also be judged from where it last swam (one stride from there to here, the mover's haul-out), so a sweep
// point that lands part-way up a rim doesn't refuse what the walker's stride over it accepts. A flat world (no terrain
// component) skips all of this: its ground is y 0 and dry, as before.
// The sub-strides are at least MOVER.track.sweep (5 cm) apart in the ground plane (the sweep's own points are closer
// where y changes: its spacing is 3-D): the floor law is a stride's law, and a chain of millimetre steps would walk up
// any wall the ground draws as steep-but-continuous (the terrain law's flatten edge is 1 cm wide, not 0).
function bodyAt(st, p) {   // where a body claimed at p stands: {y (feet), ground}
  const g = supportBelow(st, p[0], p[2], p[1]).y; return { y: Math.max(p[1], g), ground: g };
}
// THE BODY'S OWN SIZE (holes r3 F2): the mover judges water by the body's stature and a ledge by its scale, so the authority
// judges each body with the height and scale it sends with its moves (kept on its presence record; absent, the mover's
// 1.7 m at scale 1). Bounded as the walker bounds them: scale 0.5-2 (mover.js bodyScale, the size slider's range), height
// 0.5-4 m (the browser's avatar.js bodyHeight and the agent's rigbones bodyHeightFor: measured at the body's size, so the
// height bound is already on the product; the slider couples nothing further — a 0.25 m avatar at scale 2 is 0.5 m).
// A claim buys only what that range of honest bodies may do: a step up to 1.6 m and a haul-out up to 1 m above the water (scale 2; its box then starts 1.6 m up and is 3.4 m tall and 0.8 m wide), a box 0.85 m tall and 0.2 m wide (0.5;
// its step 0.4 m), and in water, swimming or wading where a body 0.5-4 m tall would.
const BODY_H = Object.freeze({ min: 0.5, max: 4 });
function sizeOf(a, prev) {
  const out = { ...(prev ?? {}) };
  for (const k of ["height", "scale"]) if (a[k] !== undefined && !(typeof a[k] === "number" && Number.isFinite(a[k]) && a[k] > 0))
    refuse("shape", `move's ${k} is a positive number (${k === "height" ? "your body's standing height in metres, 0.5-4" : "your body's size, 0.5-2"})`, "send the number your walker uses, or leave it out");
  if (a.height !== undefined) out.height = Math.min(BODY_H.max, Math.max(BODY_H.min, a.height));
  if (a.scale !== undefined) { const sc = bodyScale(a.scale); if (sc === 1) delete out.scale; else out.scale = sc; }
  return Object.keys(out).length ? out : undefined;
}
// the walker's own arguments for this body: floorStep's {height, scale}, bodyBox's scale
const lawOf = (size) => ({ height: size?.height, scale: bodyScale(size?.scale) });
function groundSteps(st, from, pts, size) {
  const G = groundOf(st); if (!G.terrain) return null;
  const { height, scale: s } = lawOf(size), lv = G.level, reachW = lv != null ? lv + MOVER.swim.climb * s : -Infinity;
  const step = (o) => floorStep({ ...o, height, scale: s });
  const b0 = bodyAt(st, from); const r0 = step({ y: b0.y, ground0: b0.ground, level0: lv, f: b0.ground, level1: lv });
  let cur = { y: b0.y, ground: b0.ground }, lastSwim = r0.stance?.swimming ? cur : null;
  const out = [{ p: from, box: bodyBox([from[0], Math.max(from[1], r0.swim ? from[1] : b0.y), from[2]], s, r0.swim ? lv : null) }];
  let judged = from, swimNow = r0.swim;
  for (let k = 0; k < pts.length; k++) { const p = pts[k];
    if (k < pts.length - 1 && Math.hypot(p[0] - judged[0], p[2] - judged[2]) < MOVER.track.sweep - 1e-9) {   // within this sub-stride: as judged
      out.push({ p, box: bodyBox([p[0], Math.max(p[1], cur.y), p[2]], s, swimNow ? lv : null) }); continue; }
    judged = p;
    const reach = Math.max(cur.y + MOVER.body.step * s, lastSwim ? reachW : -Infinity);
    const f = supportBelow(st, p[0], p[2], reach).y;
    let r = step({ y: cur.y, ground0: cur.ground, level0: lv, f, level1: lv });
    if (r.blocked && lastSwim) { const r2 = step({ y: lastSwim.y, ground0: lastSwim.ground, level0: lv, f, level1: lv }); if (!r2.blocked) r = r2; }
    if (r.blocked) return { blocked: { at: p, top: r.blocked.top, from: cur.y, swim: !!lastSwim && r.swim }, out };
    // the box: the swimmer's while the water's rule holds; else the body's own, at its claim (an upstairs the law can't see)
    // or the floor the law put it on, whichever is higher (a claim below the floor is inside it: the agent's permit sends
    // the bed's height for a body that hauled out onto a dock)
    out.push({ p, box: bodyBox([p[0], Math.max(p[1], r.y), p[2]], s, r.swim ? lv : null) });
    cur = { y: r.y, ground: f }; swimNow = r.swim; if (r.stance?.swimming) lastSwim = cur;
  }
  return { blocked: null, out };
}
function pathBlocked(w, st, from, to, size) {
  const pts = sweep(from, to); const law = groundSteps(st, from, pts, size), s = lawOf(size).scale;
  if (law?.blocked) { const L = law.blocked;
    return { ground: true, reason: L.swim ? `the bank at [${L.at.map(r3).join(", ")}] stands ${r3(L.top - groundOf(st).level)} m above the water: higher than a swimmer can haul out (${r3(MOVER.swim.climb * s)} m)`
      : `the ground at [${L.at.map(r3).join(", ")}] rises ${r3(L.top - L.from)} m from where you stand: a ledge higher than a step (${r3(MOVER.body.step * s)} m)` }; }
  const boxes = law ? law.out.map((x) => x.box) : [bodyBox(from, s), ...pts.map((p) => bodyBox(p, s))];
  const already = new Set(); const b0 = boxes[0]; // a body already inside something may walk out of it
  for (const id of near(st, b0.min, b0.max)) if (hitsIx(st, b0, id, 0.01)) already.add(id);
  const lo = [0, 1, 2].map((i) => Math.min(...boxes.map((b) => b.min[i]))), hi = [0, 1, 2].map((i) => Math.max(...boxes.map((b) => b.max[i])));
  const swept = near(st, lo, hi);
  for (let k = 0; k < pts.length; k++) { const hit = solidAt(w, st, pts[k], already, swept, boxes[k + 1]); if (hit) return hit; }
  return null;
}
// the box of a body arriving at p (a teleport): the swimmer's when the water's rule holds there
function arrivalBox(st, p, size) {
  const { height, scale } = lawOf(size), G = groundOf(st); if (!G.terrain || G.level == null) return bodyBox(p, scale);
  const b = bodyAt(st, p); const r = floorStep({ y: b.y, ground0: b.ground, level0: G.level, f: b.ground, level1: G.level, height, scale });
  return bodyBox(p, scale, r.swim ? G.level : null);
}
export { arrivalBox, body, buildEpoch, dist, facingOf, gripPoint, gripOf, heldQ, lawOf, pathBlocked, restampEngine, settleSim, shearFree, sizeOf, solidAt };
