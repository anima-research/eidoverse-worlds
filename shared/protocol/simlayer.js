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
// knocked. Its build hash is a pinned constant: tools/protocol/sweep.ts recomputes it from the files and fails if they
// changed without a new build (Covenant II). The first eidosim (eidosim@0.1.0–0.5.0, PROTOCOL_v2 dialect 3) is no longer
// carried at runtime (R 2026-10-09: "stomp the existing eidosim engine"); the old-world importer keeps its own copy, to
// say where old punts came to rest, and writes those rests as plain changes.
import { sha256 } from "./hash.js";
import { fold, opsOf, applyOps, applyInPlace, emptyState, Malformed, PURGED } from "./fold.js";
import { MODELS } from "./labmodels.js";
import * as eidosim from "../sim.js";
import { isBoxShape, shapeError } from "./shapes.js";

// Determinism is per binary (18b), so an engine is named AND hashed. This build carries one:
// sha256(sim.js ‖ NUL ‖ eidosim.js ‖ NUL ‖ simmath.js ‖ NUL ‖ terrainmath.js), first 16 hex.
export const EIDOSIM_BUILD = "be543899cfedf430";
export const EIDOSIM_FILES = ["shared/sim.js", "shared/eidosim.js", "shared/simmath.js", "shared/terrainmath.js"];
export const ENGINES = { [eidosim.SIM_ID]: { build: EIDOSIM_BUILD, module: eidosim, rotates: true, maxSpeed: 20,
  about: "eidosim: rigid boxes and spheres that tumble and roll, soft contacts (after Box3D), swept against what rests, terrain; free dynamic things at rest can be knocked" } };
export const DEFAULT_ENGINE = eidosim.SIM_ID;
export const TICK_MS = eidosim.TICK_MS;
// a sim state advanced by its engine (readers that hold a clone: the replica, the client's flights)
export const advanceSim = (sim, tick) => eidosim.advanceSim(sim, tick);
export const tickOf = (sim, ts) => eidosim.tickOf(sim, ts);
export const carried = (spec) => !!spec && ENGINES[spec.engine]?.build === spec.build;

// P7: what releases a body (or reseats a collider) is WHICH COMPONENT changed, never which verb carried it.
const PHYSICAL = new Set(["transform", "parent", "model", "physics"]);

const yawOf = (q) => (Array.isArray(q) ? 2 * Math.atan2(q[1], q[3]) : 0);
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
function engineEntity(st, id, models = MODELS, fixed = null) {
  const e = st.entities[id]; if (!e || !(models[e.c.model] || engineBox(e.c.physics) || sphereShape(e.c.physics)) || e.c.physics?.kind === "none") return null;
  const t = worldPose(st, id);
  const sh = e.c.physics?.shape;   // a tagged shape rides along (eidosim reads a sphere from it)
  return { pos: t.pos, yaw: yawOf(t.q), q: t.q, lib: e.c.model, scale: t.scale[1], scale3: t.scale, ...(sh && !isBoxShape(sh) ? { shape: sh } : {}),
    ...(e.c.physics?.kind === "dynamic" && !(fixed ?? fixedSet(st)).has(id) ? { kind: "dynamic" } : {}) };
}
function engineViewM(st, models = MODELS) {
  const entities = {}, fixed = fixedSet(st);
  for (const id of Object.keys(st.entities)) { const v = engineEntity(st, id, models, fixed); if (v) entities[id] = v; }
  const terr = st.entities["@world"]?.c.terrain;
  return { entities, terrain: terr ?? { amplitude: 0 } }; // worlds stand on y = 0 unless they declare terrain
}
const catalogueBox = (m) => [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
// a collider's shape is the log's word when stamped there (physics.shape, Covenant III); the catalogue's otherwise
function boxesForM(st, models = MODELS) {
  const out = Object.fromEntries(Object.entries(models).map(([k, m]) => [k, catalogueBox(m)]));
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; if (engineBox(e.c.physics) && typeof e.c.model === "string") out[e.c.model] = e.c.physics.shape; }
  return out;
}
const opsSafe = (e) => { try { return opsOf(e); } catch (x) { if (x instanceof Malformed) return []; throw x; } };
const isEntry = (e) => e && !(e instanceof Malformed) && typeof e === "object";

// Fold the whole log: the blind state, plus the sim epoch's live bodies and what came to rest (not yet logged).
// (Engine, slice 2: this is now simFolder fed every valid entry, then viewed at `now` — the same code the server runs
// incrementally, so every suite that calls simFold exercises the incremental path.)
export function simFold(entries, now, opts = {}) {
  const blind = fold(entries); // the strict fold decides which entries count; this layer replays the same ones
  const bad = new Set(blind.diagnostics.filter(([, c]) => c.startsWith("malformed")).map(([q]) => q));
  const f = simFolder(entries, opts);
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
export function simFolder(entries, { models = MODELS, from = null } = {}) {
  const st = from?.st ?? emptyState(); let clock = from?.clock ?? 0;
  const out = { st, spec: from?.spec ?? null, foreign: from?.foreign ?? false, sim: from?.sim ?? null, launched: from?.launched ?? {}, rested: [], checks: { agree: 0, disagree: [] }, restTicks: {} };
  const E = () => eidosim;
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
  const engineView = (s) => engineViewM(s, models), boxesFor = (s) => boxesForM(s, models);
  const feed = (seq) => {
    const e = entries[seq];
    if (typeof e.ts === "number" && e.ts > clock) clock = e.ts;
    if (out.sim) advance(clock);
    if (e.kind === "sim" && e.verb === "digest" && out.sim) { const mine = digestOf(out.sim); if (mine !== e.body.digest) disagree({ seq, logged: e.body.digest, mine }); return; }
    if (e.kind === "change") {
      const ops = opsSafe(e);
      const causeE = entries[e.cause];
      const isRest = isEntry(causeE) && causeE.kind === "sim";
      const wasSpec = JSON.stringify(st.entities["@world"]?.c["physics-engine"] ?? null);
      if (out.sim && isRest) { // L3: a rest. Its cause must be a launch, the body's CURRENT one, and the value must be the engine's
        const ids = [...new Set(ops.map((o) => o.id))];
        const after = applyOps(st, ops);
        if (causeE.verb !== "launch") disagree({ seq, why: `caused by a ${causeE.verb}, which starts no motion` });
        else for (const id of ids) {
          const b = out.sim.bodies[id], l = out.launched[id];
          if (id !== causeE.body.id && !l?.woken) disagree({ seq, id, why: "a rest may only move the bodies its launch set moving" });
          else if (!l || l.seq !== e.cause) disagree({ seq, id, why: "its launch is not this body's current flight (caught, re-thrown or moved since)" });
          else if (!b || !b.resting) disagree({ seq, id, why: "the engine still has it in flight" });
          else { const wp = worldPose(after, id), mine = wp?.pos; if (JSON.stringify(mine) !== JSON.stringify(b.p) || (b.q && JSON.stringify(wp?.q) !== JSON.stringify(b.q))) disagree({ seq, id, logged: mine, engine: b.p, ...(b.q ? { loggedQ: wp?.q, engineQ: b.q } : {}) }); else { out.checks.agree++; out.restTicks[seq] = l.restTick ?? out.sim.tick; } }
        }
      } else if (out.sim) { // a launched body is the engine's until its rest is logged (L6)
        const cut = ops.some((o) => o.id === "@world" && o.comp === "physics-engine"); // an epoch cut may freeze it (P6, force)
        for (const o of ops) { const l = out.launched[o.id]; if (!l) continue; const b = out.sim.bodies[o.id];
          if (b && !b.resting && !cut) disagree({ seq, id: o.id, why: `touches a body in flight (launch ${l.seq}); only its rest may (L6, 33 F1)` });
          else if (PHYSICAL.has(o.comp) && !(e.cause > l.seq)) disagree({ seq, id: o.id, why: `changes a body in flight, but its cause (${e.cause}) is not after the launch (${l.seq})` }); }
      }
      applyInPlace(st, ops, seq);
      const spec = st.entities["@world"]?.c["physics-engine"] ?? null;
      if (JSON.stringify(spec) !== wasSpec) { // an epoch boundary. The authority makes it a real cut: nothing in flight (P6).
        out.spec = spec; out.launched = {}; out.foreign = !!spec && !carried(spec); out.sim = null;
        if (spec && !out.foreign) {
          out.sim = eidosim.emptySim();
          eidosim.simEntry(out.sim, { seq, ts: clock, actor: "system", verb: "epoch", args: { sim: spec.engine, tickMs: spec.tickMs, boxes: boxesFor(st) } }, engineView(st));
        }
        return;
      }
      if (!out.sim) return;
      let relock = false;
      for (const o of ops) { // P7, keyed by component
        if (o.id === "@world") { // the ground itself changed: re-ground, release every body, rebuild colliders (her law)
          if (o.comp === "terrain") { E().simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "terrain", args: st.entities["@world"].c.terrain ?? {} }, engineView(st)); out.launched = {}; }
          continue; }
        const shape = engineBox(st.entities[o.id]?.c.physics), model = st.entities[o.id]?.c.model;
        if (shape && out.sim.boxes && typeof model === "string") out.sim.boxes[model] ??= shape;
        const whole = o.verb === "create" || (o.verb === "delete" && o.comp === undefined);
        if (o.comp === "lock" || o.comp === "parent") relock = true;
        if (!whole && !PHYSICAL.has(o.comp)) continue;
        const ids = [o.id, ...Object.keys(st.entities).filter((k) => isUnder(st, k, o.id))];
        for (const id of ids) {
          // a thing under it that a launch set moving is the engine's until its own rest is LOGGED (L6), flying or come to
          // rest unlogged: its parent's rest or a write to its parent doesn't cancel it (review of 8377ec52 #6)
          if (id !== o.id && out.launched[id] && out.sim.bodies[id]) continue;
          const view = engineView(st); const gone = !view.entities[id];
          E().simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: gone ? "remove" : "place", args: { id } }, view);
          if (out.launched[id]) delete out.launched[id];
        }
      }
      // a lock or a parent changed: what may be knocked changes for the thing, what's under it and what it's under.
      // Re-seat every thing at rest whose knockability no longer matches (review of 8377ec52 #3–#5)
      if (relock) { const view = engineView(st);
        for (const id of Object.keys(out.sim.statics ?? {})) if (!!out.sim.statics[id].dyn !== (view.entities[id]?.kind === "dynamic"))
          E().simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: view.entities[id] ? "place" : "remove", args: { id } }, view); }
    } else if (e.kind === "sim" && out.sim) {
      const a = e.body;
      if (e.verb === "launch" && st.entities[a.id] && Array.isArray(a.p) && Array.isArray(a.v)) {
        const view = engineView(st); const base = view.entities[a.id]; if (!base) return;
        view.entities[a.id] = { ...base, pos: a.p, yaw: typeof a.yaw === "number" ? a.yaw : base.yaw };
        // the launch's stamped state (p, v, q, w) is the body's exactly: the engine flies it from there
        eidosim.simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "launch", args: { id: a.id, p: a.p, v: a.v, q: a.q, w: a.w } }, view);
        out.launched[a.id] = { seq, cause: e.cause, by: e.actor, handled: a.handled ?? [e.actor] };
      } else if ((e.verb === "lift" || e.verb === "catch") && st.entities[a.id]) {
        // picked up (or caught mid-air): it leaves the world's physics — no body, no collider at its old spot — until
        // it's put down (an authored transform reseats it) or thrown (a launch)
        E().simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "remove", args: { id: a.id } }, { entities: {} });
        delete out.launched[a.id];
      }
    }
  };
  const view = (now) => {
    if (now !== undefined) { if (now > clock) clock = now; advance(clock); }
    out.clock = clock;
    out.rested = [];
    if (out.sim) for (const [id, l] of Object.entries(out.launched)) {
      const b = out.sim.bodies[id]; if (b?.resting) out.rested.push({ id, ...l, p: b.p, yaw: b.yaw, ...(b.q ? { q: b.q } : {}), tick: l.restTick ?? out.sim.tick });
    }
    out.rested.sort((x, y) => x.tick - y.tick);
    return out;
  };
  return { feed, view };
}
function isUnder(st, k, id) { let p = st.entities[k]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false; }

// A view over the log alone (no engine): every rest, where it put the body, and what the authority did after it.
export function restsOf(entries) {
  const out = [];
  entries.forEach((e, seq) => {
    if (!isEntry(e) || e.kind !== "change") return; const c = entries[e.cause];
    if (!isEntry(c) || c.kind !== "sim" || c.verb !== "launch") return;
    // PHYSICS §1: a launch's rest covers every body its flight set moving: each transform is one
    const ops = opsSafe(e).filter((o) => o.comp === "transform" && typeof o.id === "string");
    for (const op of ops.length ? ops : [{ id: c.body.id }]) {
      const after = entries.slice(seq + 1).find((x) => isEntry(x) && x.kind === "act" && x.actor === "system" && x.body?.rest === seq && (x.body?.id ?? c.body.id) === op.id);
      out.push({ seq, id: op.id, cause: e.cause, at: op.value?.pos, handled: c.body.handled ?? [c.actor],
        ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) });
    }
  });
  return out;
}

// Where things are right now, for reads: the blind state's word, except bodies the sim owns.
export function livePoses(sf) {
  const out = {};
  if (!sf.sim) return out;
  for (const [id, b] of Object.entries(sf.sim.bodies)) if (!b.resting && sf.launched[id]) out[id] = { pos: b.p.map((n) => Math.round(n * 1000) / 1000), v: b.v.map((n) => Math.round(n * 100) / 100) };
  return out;
}
/** The sim's cut for a joiner (the authority's side of simFolder's opts.from), as plain JSON: where the engine stands at the
 *  view's clock, what is in flight, and the launch entries those flights came from (so a later rest's cause resolves). */
export function simCutOf(sf, entries) {
  const launched = JSON.parse(JSON.stringify(sf.launched ?? {}));
  const launches = {}; for (const l of Object.values(launched)) if (entries[l.seq]) launches[l.seq] = entries[l.seq];
  return { clock: sf.clock ?? 0, spec: sf.spec ?? null, foreign: !!sf.foreign, sim: sf.sim ? JSON.parse(JSON.stringify(sf.sim)) : null, launched, launches };
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
