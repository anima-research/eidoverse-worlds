// The sim layer (design 20, P4–P7): a second fold beside the blind one. It reads the log's change entries (through
// fold.js, untouched) and its `sim` entries (intents that start motion), and runs the engine @world.physics-engine names.
// It never writes the log. Determinism is local: it holds only for a carried engine build, inside one epoch.
//
// PROTOCOL L3: a change entry whose `cause` is a sim entry IS a rest, and its value must equal the engine's. There
// is no annotation to trust: carriers compare the value the fold applies with where the engine has the body.
// Time: the engine's clock is the envelope's `ts` (§2.1: the authority's admission time, the one clock readers trust),
// never running backwards: an entry without one happens at the latest time stated before it.
// The engine is eidosim (shared/sim.js, its adapter, over shared/eidosim.js, its core): rigid bodies that tumble and
// roll, soft contacts after Box3D, swept against what rests, on terrain; things at rest that are dynamic and free can be
// knocked. It is named name@version; a version is carried when this server reproduces its conformance digests
// (spec/conformance/physics/, engine-check), and a change meant to alter results is a new version (Covenant II). The first eidosim (eidosim@0.1.0–0.5.0, PROTOCOL_v2 dialect 3) is no longer
// carried at runtime (R 2026-10-09: "stomp the existing eidosim engine"); the old-world importer keeps its own copy, to
// say where old punts came to rest, and writes those rests as plain changes.
import { sha256 } from "./hash.js";
import { fold, opsOf, applyOps, applyInPlace, emptyState, Malformed, PURGED, purgesIn } from "./fold.js";
import { MODELS } from "./labmodels.js";
import * as eidosim from "../sim.js";
import { isBoxShape, shapeError } from "./shapes.js";
import { r3, r2 } from "./round.js";

// An engine is named by its VERSION (house answer, #260 10-21): a server carries a version when its implementation reproduces
// that version's conformance digests (spec/conformance/physics/, held by engine-check). A change that still reproduces them
// is the same version; a change meant to alter results is a new version with its own digests.
export const ENGINES = { [eidosim.SIM_ID]: { module: eidosim, rotates: true, maxSpeed: 20,
  about: "eidosim: rigid boxes and spheres that tumble and roll, soft contacts (after Box3D), swept against what rests, terrain; free dynamic things at rest can be knocked" } };
export const DEFAULT_ENGINE = eidosim.SIM_ID;
export const TICK_MS = eidosim.TICK_MS;
// a sim state advanced by its engine (readers that hold a clone: the replica, the client's flights)
export const advanceSim = (sim, tick) => eidosim.advanceSim(sim, tick);
export const tickOf = (sim, ts) => eidosim.tickOf(sim, ts);
export const carried = (spec) => !!spec && typeof spec.engine === "string" && Object.hasOwn(ENGINES, spec.engine);   // a version this server reproduces
/** "eidosim@1.0.0" → "eidosim" */
export const engineName = (e) => String(e).split("@")[0];
const semver = (e) => (String(e).split("@")[1] ?? "").split(".").map((x) => Number(x) || 0);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0); return false; };
/** the version of `name` this server would stamp today (its newest carried one), or null when it carries none of that name */
export const stampOf = (name) => Object.keys(ENGINES).filter((k) => engineName(k) === name).reduce((best, k) => (best === null || newer(k, best) ? k : best), null);

// P7: what releases a body (or reseats a collider) is WHICH COMPONENT changed, never which verb carried it.
const PHYSICAL = new Set(["transform", "parent", "model", "mesh", "physics", "disabled"]);
// the writes that end a hold, as the authority's commit() reads them (writes.js): a transform, a parent or a whole delete of the
// thing, or switching it off (disabled set true; setting it false ends nothing). Switching off or deleting a thing also ends the
// holds of whatever hangs under it. Keep these two in step with commit()
const ends = (o) => (o.verb === "delete" ? o.comp === undefined || o.comp === "transform" || o.comp === "parent" : o.comp === "transform" || o.comp === "parent" || (o.comp === "disabled" && o.value === true));
const endsUnder = (o) => (o.verb === "delete" && o.comp === undefined) || (o.verb === "set" && o.comp === "disabled" && o.value === true);

const yawOf = (q) => (Array.isArray(q) ? 2 * Math.atan2(q[1], q[3]) : 0);
// A thing's world pose, composed down its parent chain. The protocol's rule is glTF's (PROTOCOL §9.3): local = T · R · S,
// world = parent's world × local. This returns a TRS, not a matrix, so it is EXACT for the position (parent pos + R·(S·pos))
// and exact for q and scale whenever every ancestor's scale is uniform; under a non-uniformly scaled ancestor a rotated
// child's true world transform shears (no TRS holds it), and here its q is the plain product and its scale the
// component-wise product (Unity's lossyScale reading). The stored data had 0 such cases at the shape audit (10-16).
// TODO(shape audit 10-16): return the composed matrix (or flag the sheared case) if a reader ever needs the exact one.
export function worldPose(st, id, depth = 0) {
  const e = st.entities[id]; if (!e) return null;
  const t = e.c.transform ?? {}; const pos = t.pos ?? [0, 0, 0], q = t.q ?? [0, 0, 0, 1], sc = t.scale ?? [1, 1, 1];
  const p = e.c.parent?.to;
  if (!p || depth > 32 || !st.entities[p]) return { pos, q, scale: sc };
  const pt = worldPose(st, p, depth + 1); const [x, y, z, w] = pt.q; const v = pos.map((n, i) => n * pt.scale[i]);
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  const r = [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
  const [a, b, c, d] = pt.q, [e2, f, g, h] = q;
  return { pos: pt.pos.map((n, i) => n + r[i]), q: [d*e2+a*h+b*g-c*f, d*f-a*g+b*h+c*e2, d*g+a*f-b*e2+c*h, d*h-a*e2-b*f-c*g], scale: sc.map((n, i) => n * pt.scale[i]) };
}
// eidosim carries boxes only (PHYSICS.md §3.1): a stamped physics.shape is its collider when it's a bare box; any other
// shape is no body to it (rather than a tagged object misread as [[min], [max]]). An engine that carries spheres reads them.
export const engineBox = (ph) => (isBoxShape(ph?.shape) ? ph.shape : null);
// eidosim keys its boxes by model name (sim.boxes[lib]); a model-less thing with a stamped box (a `mesh`) is keyed by the
// box itself, so two meshes of one size share an entry and a resize is a new key. A tagged cylinder has no box here: no body
const meshKey = (ph) => { const b = engineBox(ph); return b ? `mesh:${b[0].join(",")}|${b[1].join(",")}` : undefined; };
export const libOf = (e) => (typeof e?.c.model === "string" ? e.c.model : e?.c.mesh !== undefined ? meshKey(e.c.physics) : undefined);
// The engine sees the world through its own entity view: one entry per modelled thing (its "lib" is its model).
const lockedC = (c) => { const v = c?.lock; return v !== undefined && v !== PURGED && !!v; };   // as authority.lockedC
const sphereShape = (ph) => ph?.shape?.type === "sphere" && !shapeError(ph.shape);
// what a flying thing may knock (engines that collide moving bodies with resting ones): a dynamic thing that no hand rule
// holds fixed — not locked, under nothing locked, and holding nothing locked (a hand can't take those either:
// authority grab/punt/lift check the same three). Everything else at rest is a collider.
function fixedSet(st) {
  const fixed = new Set(), up = (k) => st.entities[k]?.c.parent?.to;
  for (const id of Object.keys(st.entities)) { if (!lockedC(st.entities[id].c)) continue;
    fixed.add(id); for (let p = up(id), n = 0; p && n++ < 32; p = up(p)) fixed.add(p); }   // locked, and all it sits under
  for (const id of Object.keys(st.entities)) for (let p = up(id), n = 0; p && n++ < 32; p = up(p)) if (lockedC(st.entities[p]?.c)) { fixed.add(id); break; }   // under a lock
  return fixed;
}
// switched off (componentspec disabled), itself or anything it hangs under: no body, no collider
export function offChain(st, id) { for (let k = id, n = 0; k && n < 33; k = st.entities[k]?.c.parent?.to, n++) if (st.entities[k]?.c.disabled === true) return k; return null; }
// a purged physical value is no body: the strict fold holds PURGED there, and this layer follows it (review of #260)
const purgedPhysical = (c) => [...PHYSICAL].some((k) => c[k] === PURGED);
// a place the record lost: a transform or parent purged, or stripped to its commit with no purge naming it (§12), on the
// thing or on anything it hangs from. Its pose is unknown (§1), so nothing derives a place or a scale from it: it has no
// body here, and the authority's sweeps (a return, an orphaned lift's settling) leave it where the record lost it
export function lostPlace(st, id) {
  for (let k = id, n = 0; k && n < 33; n++) { const c = st.entities[k]?.c; if (!c) return false;
    if (c.transform === PURGED || c.parent === PURGED) return true; k = c.parent?.to; }
  return false;
}
function engineEntity(st, id, models = MODELS, fixed = null) {
  const e = st.entities[id]; if (!e || purgedPhysical(e.c) || lostPlace(st, id) || !(models[e.c.model] || engineBox(e.c.physics) || sphereShape(e.c.physics)) || e.c.physics?.kind === "none") return null;
  if (offChain(st, id)) return null;
  const t = worldPose(st, id);
  const sh = e.c.physics?.shape;   // a tagged shape rides along (eidosim reads a sphere from it)
  return { pos: t.pos, yaw: yawOf(t.q), q: t.q, model: libOf(e), scale: t.scale[1], scale3: t.scale, ...(sh && !isBoxShape(sh) ? { shape: sh } : {}),
    ...(e.c.physics?.kind === "dynamic" && !(fixed ?? fixedSet(st)).has(id) ? { kind: "dynamic" } : {}) };
}
export function engineViewM(st, models = MODELS) {
  const entities = {}, fixed = fixedSet(st);
  for (const id of Object.keys(st.entities)) { const v = engineEntity(st, id, models, fixed); if (v) entities[id] = v; }
  const terr = st.entities["@world"]?.c.terrain;
  return { entities, terrain: terr ?? { amplitude: 0 } }; // worlds stand on y = 0 unless they declare terrain
}
const catalogueBox = (m) => [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
// a collider's shape is the log's word when stamped there (physics.shape, Covenant III); the catalogue's otherwise
function boxesForM(st, models = MODELS) {
  const out = Object.fromEntries(Object.entries(models).map(([k, m]) => [k, catalogueBox(m)]));
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; const lib = libOf(e); if (engineBox(e.c.physics) && typeof lib === "string") out[lib] = e.c.physics.shape; }
  return out;
}
const opsSafe = (e) => { try { return opsOf(e); } catch (x) { if (x instanceof Malformed) return []; throw x; } };
const isEntry = (e) => e && !(e instanceof Malformed) && typeof e === "object";
// A sim (or act) entry's body as a replay may read it, or null when a purge took it whole (§12): the purge names it, or the
// body on disk is already its {commit} stub. Null is unknown, as in the authority's readback: never a value to compare with.
const isCommitStub = (b) => !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "commit" || k === "salt");
const bodyIn = (entries, purged, seq) => { const e = entries[seq]; if (!isEntry(e) || !e.body || typeof e.body !== "object") return null;
  return purged?.has(`${seq}:-`) || isCommitStub(e.body) ? null : e.body; };

// Fold the whole log: the blind state, plus the sim epoch's live bodies and what came to rest (not yet logged).
// (Engine, slice 2: this is now simFolder fed every valid entry, then viewed at `now` — the same code the server runs
// incrementally, so every suite that calls simFold exercises the incremental path.)
export function simFold(entries, now, opts = {}) {
  const blind = fold(entries); // the strict fold decides which entries count; this layer replays the same ones
  const bad = new Set(blind.diagnostics.filter(([, c]) => c.startsWith("malformed")).map(([q]) => q));
  const f = simFolder(entries, { ...opts, purged: purgesIn(entries) });   // a purge is retroactive (L1): the replay writes PURGED where the fold does
  if (blind.status === "ok") for (let s = 0; s < entries.length; s++) if (isEntry(entries[s]) && !bad.has(s)) f.feed(s);
  return f.view(now);
}
// The sim layer as a running fold (engine, slice 2; the lab re-folded the whole log on every call, O(n) per request).
// feed(seq) takes the next VALID entry (the caller decides validity: the strict fold on load, the authority's own re-read
// on append), in log order; view(now) advances the engine to `now` and returns what simFold returned. `now` must not
// run backwards relative to later entries' ts (the server's clock is monotonic and every ts it writes is ≥ it), so
// advancing early for a read and then folding a later entry is the same as folding it first: advancement is
// schedule-independent. opts.models: the catalogue whose models count as colliders (default the lab's; the server
// passes {} so geometry enters the sim only through the log's physics.shape, Covenant III).
// opts.from: start from a cut instead of the empty world ({st, clock, spec, foreign, sim, launched}, simCutOf's shape):
// a joining client can't refold the whole log, so it adopts the authority's sim where the authority's clock stood, then feeds
// every later entry (their ts are never earlier than that clock). Advancement is schedule-independent, so this is exact.
// opts.purged: the log's purges (purgesIn), so a replay writes PURGED where the strict fold does; a live host that sees a new purge
// builds a fresh folder with them (a purge is retroactive), rather than feeding it.
export function simFolder(entries, { models = MODELS, from = null, purged = null } = {}) {
  const st = from?.st ?? emptyState(); let clock = from?.clock ?? 0;
  const out = { st, spec: from?.spec ?? null, foreign: from?.foreign ?? false, sim: from?.sim ?? null, launched: from?.launched ?? {}, lifted: new Set(from?.lifted ?? []), rested: [], checks: { agree: 0, disagree: [] }, restTicks: {} };
  const E = () => eidosim;
  // every engine write counts (out.rev): a client re-copies its presentation sim only when this moved, not on every entry
  // (STRIKES PH-S2: ~100 JSON copies of the whole sim during a cascade, one per chat line too)
  out.rev = from?.rev ?? 0; const SE = (...args) => { out.rev++; return eidosim.simEntry(...args); };
  const tickOf = (ts) => (out.sim ? E().tickOf(out.sim, ts) : 0);
  const advance = (ts) => {
    if (!out.sim) return;
    // step while anything flies, so each body's real rest tick is known (advanceSim jumps once all are at rest)
    const target = tickOf(ts);
    while (out.sim.tick < target) {
      const flying = Object.keys(out.sim.bodies).filter((id) => !out.sim.bodies[id].resting);
      if (!flying.length) { E().advanceSim(out.sim, target); break; }
      E().advanceSim(out.sim, out.sim.tick + 1);
      for (const id of flying) if (out.sim.bodies[id]?.resting && out.launched[id]) out.launched[id].restTick ??= out.sim.tick;
      for (const [id, l] of Object.entries(out.launched)) if (l.restTick !== undefined && out.sim.bodies[id] && !out.sim.bodies[id].resting) delete l.restTick;   // woken again before its rest was logged (review #9)
      // a body a flight woke is that launch's to rest (PHYSICS §1): it rests and is logged under the launch the engine names
      for (const [id, b] of Object.entries(out.sim.bodies)) if (b.woken && !b.resting && out.launched[id]?.seq !== b.seq) {
        const src = Object.values(out.launched).find((l) => l.seq === b.seq);
        out.launched[id] = { seq: b.seq, cause: src?.cause, by: src?.by, handled: src?.handled ?? [], woken: true };
      }
    }
  };
  const disagree = (x) => out.checks.disagree.push(x);
  const unknownFlights = new Set(); let unknownHold = false;   // purged launches whose rest isn't logged yet; a purged lift or catch this epoch
  // a thing in someone's hand is nowhere in the engine's world: no rebuild (terrain, epoch, relock) may seat it (review 64d26822 #3)
  const engineView = (s) => { const v = engineViewM(s, models); for (const id of out.lifted) delete v.entities[id]; return v; }, boxesFor = (s) => boxesForM(s, models);
  const feed = (seq) => {
    const e = entries[seq];
    if (typeof e.ts === "number" && e.ts > clock) clock = e.ts;
    if (out.sim) advance(clock);
    if (e.kind === "sim" && e.verb === "digest" && out.sim) { const b = bodyIn(entries, purged, seq); if (!b || unknownFlights.size || unknownHold) return;   // purged, or the engine's world unknown here: nothing to compare
      const mine = digestOf(out.sim); if (mine !== b.digest) disagree({ seq, logged: b.digest, mine }); return; }
    if (e.kind === "change") {
      const ops = opsSafe(e);
      const causeE = entries[e.cause];
      const isRest = isEntry(causeE) && causeE.kind === "sim" && !!bodyIn(entries, purged, e.cause);   // a purged launch's rest can't be checked: unknown
      unknownFlights.delete(e.cause);   // its rest is on the record: the engines agree again from here
      const wasSpec = JSON.stringify(st.entities["@world"]?.c["physics-engine"] ?? null);
      if (out.sim && isRest) { // L3: a rest. Its cause must be a launch, the body's CURRENT one, and the value must be the engine's
        const ids = [...new Set(ops.map((o) => o.id))];
        const after = applyOps(st, ops), B = boundsIn(st);
        if (causeE.verb !== "launch") disagree({ seq, why: `caused by a ${causeE.verb}, which starts no motion` });
        else for (const id of ids) {
          const b = out.sim.bodies[id], l = out.launched[id];
          if (id !== causeE.body.id && !l?.woken) disagree({ seq, id, why: "a rest may only move the bodies its launch set moving" });
          else if (!l || l.seq !== e.cause) disagree({ seq, id, why: "its launch is not this body's current flight (caught, re-thrown or moved since)" });
          // a body still flying past the world's edge is lost there: its rest is where it crossed (view(), restCheck's `lost`)
          else if (!b || (!b.resting && !(B && outside(B, b.p)))) disagree({ seq, id, why: "the engine still has it in flight" });
          else { const wp = worldPose(after, id), mine = wp?.pos; if (JSON.stringify(mine) !== JSON.stringify(b.p) || (b.q && JSON.stringify(wp?.q) !== JSON.stringify(b.q))) disagree({ seq, id, logged: mine, engine: b.p, ...(b.q ? { loggedQ: wp?.q, engineQ: b.q } : {}) }); else { out.checks.agree++; out.restTicks[seq] = l.restTick ?? out.sim.tick; } }
        }
      } else if (out.sim) { // a launched body is the engine's until its rest is logged (L6)
        const cut = ops.some((o) => o.id === "@world" && o.comp === "physics-engine"); // an epoch cut may freeze it (P6, force)
        for (const o of ops) { const l = out.launched[o.id]; if (!l) continue; const b = out.sim.bodies[o.id];
          if (b && !b.resting && !cut) disagree({ seq, id: o.id, why: `touches a body in flight (launch ${l.seq}); only its rest may (L6, 33 F1)` });
          else if (PHYSICAL.has(o.comp) && !(e.cause > l.seq)) disagree({ seq, id: o.id, why: `changes a body in flight, but its cause (${e.cause}) is not after the launch (${l.seq})` }); }
      }
      applyInPlace(st, ops, seq, purged, e.verb === "batch");
      const spec = st.entities["@world"]?.c["physics-engine"] ?? null;
      if (JSON.stringify(spec) !== wasSpec) { // an epoch boundary. The authority makes it a real cut: nothing in flight (P6).
        out.spec = spec; out.launched = {}; out.foreign = !!spec && !carried(spec); out.sim = null; out.rev++; unknownFlights.clear(); unknownHold = false;   // a cut: nothing in flight   // a lift outlives an epoch (authority orphanLifts says the same); the view keeps it out
        if (spec && !out.foreign) {
          out.sim = eidosim.emptySim();
          SE(out.sim, { seq, ts: clock, actor: "system", verb: "epoch", args: { sim: spec.engine, tickMs: spec.tickMs, boxes: boxesFor(st) } }, engineView(st));
        }
        return;
      }
      // a hold ends on the record whatever the engine is doing (physics off included): the hand lets go of the thing, and of
      // what hangs under a thing switched off or deleted (the authority's commit() lets those go too)
      for (const o of ops) if (o.id !== "@world") {
        if (out.lifted.has(o.id) && ends(o)) out.lifted.delete(o.id);
        if (endsUnder(o)) for (const k of [...out.lifted]) if (isUnder(st, k, o.id) || !st.entities[k]) out.lifted.delete(k);
      }
      if (!out.sim) return;
      let relock = false;
      for (const o of ops) { // P7, keyed by component
        if (o.id === "@world") { // the ground itself changed: re-ground, release every body, rebuild colliders (her law)
          if (o.comp === "terrain") { SE(out.sim, { seq, ts: clock, actor: e.actor, verb: "terrain", args: st.entities["@world"].c.terrain ?? { amplitude: 0 } }, engineView(st)); out.launched = {}; }   // removed: flat y = 0, as at boot (line 80), never the toolkit's default hills
          continue; }
        const shape = engineBox(st.entities[o.id]?.c.physics), model = libOf(st.entities[o.id]);
        if (shape && out.sim.boxes && typeof model === "string") out.sim.boxes[model] ??= shape;
        const whole = o.verb === "create" || (o.verb === "delete" && o.comp === undefined);
        if (o.comp === "lock" || o.comp === "parent" || whole) relock = true;   // a thing made or deleted changes what's under a lock
        if (!whole && !PHYSICAL.has(o.comp)) continue;
        // a write that ends a hold (the authority's commit(): transform, parent, disabled, or the whole thing) puts it back in the
        // world; any other physical write to a held thing (its physics, its model) leaves it in the hand (review 64d26822 #1–#2)
        if (out.lifted.has(o.id)) continue;   // still in the hand: a hold's end was read above
        const ids = [o.id, ...Object.keys(st.entities).filter((k) => isUnder(st, k, o.id))];
        const view = engineView(st);   // one view per op (review 10-14 C4: it was rebuilt per affected id — 51 views for a shelf of 50)
        for (const id of ids) {
          // in someone's hand (lifted or caught, not yet put down or thrown): its record still stands where it was taken, under
          // whatever it rested on, and a move of that thing must not put a body back there (R 10-11: a crate she caught was
          // re-placed under the crate below it, rested there, and she held a thing that lay on the floor)
          if (id !== o.id && out.lifted.has(id)) continue;
          // a thing under it that a launch set moving is the engine's until its own rest is LOGGED (L6), flying or come to
          // rest unlogged: its parent's rest or a write to its parent doesn't cancel it (review of 8377ec52 #6)
          if (id !== o.id && out.launched[id] && out.sim.bodies[id]) continue;
          const gone = !view.entities[id];
          SE(out.sim, { seq, ts: clock, actor: e.actor, verb: gone ? "remove" : "place", args: { id } }, view);
          if (out.launched[id]) delete out.launched[id];
        }
      }
      // a lock or a parent changed: what may be knocked changes for the thing, what's under it and what it's under.
      // Re-seat every thing at rest whose knockability no longer matches (review of 8377ec52 #3–#5)
      if (relock) { const view = engineView(st);
        for (const id of Object.keys(out.sim.statics ?? {})) if (!!out.sim.statics[id].dyn !== (view.entities[id]?.kind === "dynamic"))
          SE(out.sim, { seq, ts: clock, actor: e.actor, verb: view.entities[id] ? "place" : "remove", args: { id } }, view); }
    } else if (e.kind === "sim" && out.sim) {
      // purged whole: the engine can't fly or lift what it can't read, so until that flight's rest (a lift or catch: until the next
      // cut) the engine that read it and this one may differ, and a digest logged meanwhile is unknown here, as readback reads it
      const a = bodyIn(entries, purged, seq); if (!a) { if (e.verb === "launch") unknownFlights.add(seq); else if (e.verb === "lift" || e.verb === "catch") unknownHold = true; return; }
      if (e.verb === "launch" && st.entities[a.id] && Array.isArray(a.p) && Array.isArray(a.v)) {
        out.lifted.delete(a.id);   // thrown or dropped: out of the hand, into the engine (before the view, which hides lifted things)
        const view = engineView(st); const base = view.entities[a.id]; if (!base) return;
        view.entities[a.id] = { ...base, pos: a.p, yaw: typeof a.yaw === "number" ? a.yaw : base.yaw };
        // the launch's stamped state (p, v, q, w) is the body's exactly: the engine flies it from there
        SE(out.sim, { seq, ts: clock, actor: e.actor, verb: "launch", args: { id: a.id, p: a.p, v: a.v, q: a.q, w: a.w } }, view);
        out.launched[a.id] = { seq, cause: e.cause, by: e.actor, handled: a.handled ?? [e.actor] };
      } else if ((e.verb === "lift" || e.verb === "catch") && st.entities[a.id]) {
        // picked up (or caught mid-air): it leaves the world's physics — no body, no collider at its old spot — until
        // it's put down (an authored transform reseats it) or thrown (a launch)
        SE(out.sim, { seq, ts: clock, actor: e.actor, verb: "remove", args: { id: a.id } }, { entities: {} });
        delete out.launched[a.id];
        out.lifted.add(a.id);
      }
    }
  };
  const view = (now) => {
    if (now !== undefined) { if (now > clock) clock = now; advance(clock); }
    out.clock = clock;
    out.rested = [];
    // a flying body that has crossed the world's edge is lost THERE: it rests on the record where it is now, and the
    // authority sends it home (attack-physics P1: a ball flew 300 m out for a minute, untouchable, simulated every pass)
    const B = boundsIn(st);
    if (out.sim) for (const [id, l] of Object.entries(out.launched)) {
      const b = out.sim.bodies[id]; if (!b) continue;
      if (b.resting) out.rested.push({ id, ...l, p: b.p, yaw: b.yaw, ...(b.q ? { q: b.q } : {}), tick: l.restTick ?? out.sim.tick });
      else if (B && outside(B, b.p)) out.rested.push({ id, ...l, p: b.p, yaw: b.yaw, ...(b.q ? { q: b.q } : {}), tick: out.sim.tick, lost: true });
    }
    out.rested.sort((x, y) => x.tick - y.tick);
    return out;
  };
  // the clock a pass bounded to `maxTicks` engine ticks may reach (DESIGN-physics-responsiveness §1): a stall catches up over
  // several passes, never by a longer step (Covenant I/IV: the bits are the law's). null: no engine, nothing to bound.
  const capTs = (maxTicks) => { if (!out.sim) return null;
    // nothing in flight: advancing is one jump, so no bound (bounded, a heartbeat slower than maxTicks ticks fell behind for good)
    if (!Object.values(out.sim.bodies).some((b) => !b.resting)) return null;
    return out.sim.epoch.ts + (out.sim.tick + maxTicks) * out.sim.epoch.tickMs; };
  return { feed, view, capTs };
}
function isUnder(st, k, id) { let p = st.entities[k]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false; }

// A view over the log alone (no engine): every rest, where it put the body, and what the authority did after it.
// @world.bounds as a reader uses it: malformed = none (the authority's boundsOf, kept apart so this file imports nothing of it)
const outside = (B, p) => p[0] < B.min[0] || p[0] > B.max[0] || p[2] < B.min[2] || p[2] > B.max[2] || p[1] > B.max[1];   // x, z and the sky; the floor is the terrain's
const boundsIn = (st) => { const B = st.entities["@world"]?.c.bounds; const v3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
  return B && v3(B.min) && v3(B.max) ? B : null; };
export function restsOf(entries) {
  const out = []; const purged = purgesIn(entries);
  entries.forEach((e, seq) => {
    if (!isEntry(e) || e.kind !== "change") return; const c = entries[e.cause];
    if (!isEntry(c) || c.kind !== "sim" || c.verb !== "launch") return; const cb = bodyIn(entries, purged, e.cause);
    // PHYSICS §1: a launch's rest covers every body its flight set moving: each transform is one
    const ops = opsSafe(e).filter((o) => o.comp === "transform" && typeof o.id === "string");
    for (const op of ops.length ? ops : cb ? [{ id: cb.id }] : []) {
      const after = entries.slice(seq + 1).find((x) => isEntry(x) && x.kind === "act" && x.actor === "system" && x.body?.rest === seq && (x.body?.id ?? cb?.id) === op.id);
      out.push({ seq, id: op.id, cause: e.cause, at: op.value?.pos, handled: cb?.handled ?? [c.actor],
        ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) });
    }
  });
  return out;
}

// Where things are right now, for reads: the blind state's word, except bodies the sim owns.
export function livePoses(sf) {
  const out = {};
  if (!sf.sim) return out;
  for (const [id, b] of Object.entries(sf.sim.bodies)) if (!b.resting && sf.launched[id]) out[id] = { pos: b.p.map(r3), v: b.v.map(r2) };
  return out;
}
/** Where the engine has each body it owns (launched, its rest not logged yet): {pos, v} while it flies, {pos, resting: true} once
 *  it has stopped but its rest isn't on the record yet (a launch's rests are logged together). livePoses stays the flying ones. */
export function enginePoses(sf) {
  const out = {};
  if (!sf.sim) return out;
  for (const [id, b] of Object.entries(sf.sim.bodies)) if (sf.launched[id]) out[id] = b.resting ? { pos: b.p.map(r3), resting: true } : { pos: b.p.map(r3), v: b.v.map(r2) };
  return out;
}
/** The sim's cut for a joiner (the authority's side of simFolder's opts.from), as plain JSON: where the engine stands at the
 *  view's clock, what is in flight, and the launch entries those flights came from (so a later rest's cause resolves). */
export function simCutOf(sf, entries) {
  const launched = JSON.parse(JSON.stringify(sf.launched ?? {}));
  const launches = {}; for (const l of Object.values(launched)) if (entries[l.seq]) launches[l.seq] = entries[l.seq];
  return { clock: sf.clock ?? 0, spec: sf.spec ?? null, foreign: !!sf.foreign, sim: sf.sim ? JSON.parse(JSON.stringify(sf.sim)) : null, launched, launches, lifted: [...(sf.lifted ?? [])].sort() };
}
export const digestOf = (sim) => sha256(JSON.stringify(eidosim.simSnapshot(sim))).slice(0, 16);
// A cut, in our own format: the engine state as plain JSON, restorable. (For eidosim the format IS its snapshot.)
export const snapshotOf = (sim) => JSON.parse(JSON.stringify(eidosim.simSnapshot(sim)));
// Predict when everything now in flight will be at rest (a carrier can look ahead; a barrier waits for it).
export function restEta(sf) {
  if (!sf.sim) return null;
  const s = JSON.parse(JSON.stringify(sf.sim)); const live = () => Object.values(s.bodies).filter((b) => !b.resting).length;
  if (!live()) return 0;
  const t0 = s.tick; let k = t0;
  while (live() && k < t0 + 20000) { k++; eidosim.advanceSim(s, k); }
  return (k - t0) * sf.spec.tickMs;
}
