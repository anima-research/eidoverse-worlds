// The sim layer (design 20, P4–P7): a second fold beside the blind one. It reads the log's change entries (through
// fold.js, untouched) and its `sim` entries (intents that start motion), and runs the engine @world.physics-engine names.
// It never writes the log. Determinism is local: it holds only for a carried engine build, inside one epoch.
//
// PROTOCOL L3: a change entry whose `cause` is a sim entry IS a rest, and its value must equal the engine's. There
// is no annotation to trust: carriers compare the value the fold applies with where the engine has the body.
// Time: the engine's clock is the envelope's `ts` (§2.1: the authority's admission time, the one clock readers trust),
// never running backwards: an entry without one happens at the latest time stated before it.
// Ported from the protocol lab (the protocol lab's simlayer.js @ 11db981). Engine changes: no node: imports (the browser imports
// this file); the engine is ../sim.js (byte-identical to the lab's legacy/shared/sim.js), and its build hash is a
// pinned constant instead of a read of the files at import time — tools/protocol/run.ts recomputes it from the files and
// fails if they changed without a new engine name (Covenant II).
import { sha256 } from "./hash.js";
import { fold, opsOf, applyOps, applyInPlace, emptyState, Malformed } from "./fold.js";
import { MODELS } from "./labmodels.js";
import * as eidosim from "../sim.js";
import { isBoxShape } from "./shapes.js";

// Determinism is per binary (18b), so an engine is named AND hashed. This build carries one:
// sha256(sim.js ‖ NUL ‖ simmath.js ‖ NUL ‖ terrainmath.js), first 16 hex.
export const EIDOSIM_BUILD = "35c61300f4812699";
export const EIDOSIM_FILES = ["shared/sim.js", "shared/simmath.js", "shared/terrainmath.js"];
const EIDOSIM = EIDOSIM_BUILD;
// one build carries all five laws (her CARRIED set), so all five names resolve to it
export const ENGINES = Object.fromEntries(["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"].map((v) => [`eidosim@${v}`,
  { build: EIDOSIM, about: "antra's reference sim (PROTOCOL_v2, dialect 3): ballistic boxes, swept contacts, yaw only", maxSpeed: 20 }]));
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
function engineEntity(st, id, models = MODELS) {
  const e = st.entities[id]; if (!e || !(models[e.c.model] || engineBox(e.c.physics)) || e.c.physics?.kind === "none") return null;
  const t = worldPose(st, id);
  return { pos: t.pos, yaw: yawOf(t.q), lib: e.c.model, scale: t.scale[1] };
}
function engineViewM(st, models = MODELS) {
  const entities = {};
  for (const id of Object.keys(st.entities)) { const v = engineEntity(st, id, models); if (v) entities[id] = v; }
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
  const tickOf = (ts) => (out.sim ? eidosim.tickOf(out.sim, ts) : 0);
  const advance = (ts) => {
    if (!out.sim) return;
    // step while anything flies, so each body's real rest tick is known (advanceSim jumps once all are at rest)
    const target = tickOf(ts);
    while (out.sim.tick < target) {
      const flying = Object.keys(out.sim.bodies).filter((id) => !out.sim.bodies[id].resting);
      if (!flying.length) { eidosim.advanceSim(out.sim, target); break; }
      eidosim.advanceSim(out.sim, out.sim.tick + 1);
      for (const id of flying) if (out.sim.bodies[id]?.resting && out.launched[id]) out.launched[id].restTick ??= out.sim.tick;
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
          if (id !== causeE.body.id) disagree({ seq, id, why: "a rest may only move the body its launch threw" });
          else if (!l || l.seq !== e.cause) disagree({ seq, id, why: "its launch is not this body's current flight (caught, re-thrown or moved since)" });
          else if (!b || !b.resting) disagree({ seq, id, why: "the engine still has it in flight" });
          else { const mine = worldPose(after, id)?.pos; if (JSON.stringify(mine) !== JSON.stringify(b.p)) disagree({ seq, id, logged: mine, engine: b.p }); else { out.checks.agree++; out.restTicks[seq] = l.restTick ?? out.sim.tick; } }
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
      for (const o of ops) { // P7, keyed by component
        if (o.id === "@world") { // the ground itself changed: re-ground, release every body, rebuild colliders (her law)
          if (o.comp === "terrain") { eidosim.simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "terrain", args: st.entities["@world"].c.terrain ?? {} }, engineView(st)); out.launched = {}; }
          continue; }
        const shape = engineBox(st.entities[o.id]?.c.physics), model = st.entities[o.id]?.c.model;
        if (shape && out.sim.boxes && typeof model === "string") out.sim.boxes[model] ??= shape;
        const whole = o.verb === "create" || (o.verb === "delete" && o.comp === undefined);
        if (!whole && !PHYSICAL.has(o.comp)) continue;
        const ids = [o.id, ...Object.keys(st.entities).filter((k) => isUnder(st, k, o.id))];
        for (const id of ids) {
          const view = engineView(st); const gone = !view.entities[id];
          eidosim.simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: gone ? "remove" : "place", args: { id } }, view);
          if (out.launched[id]) delete out.launched[id];
        }
      }
    } else if (e.kind === "sim" && out.sim) {
      const a = e.body;
      if (e.verb === "launch" && st.entities[a.id] && Array.isArray(a.p) && Array.isArray(a.v)) {
        const view = engineView(st); const base = view.entities[a.id]; if (!base) return;
        view.entities[a.id] = { ...base, pos: a.p, yaw: typeof a.yaw === "number" ? a.yaw : base.yaw };
        // her punt makes the body (order, statics, box); then the launch's stamped state is set EXACTLY — through
        // dir/power it would be renormalised, which can move it by an ulp, and dialect 3 has no zero-power "let go"
        eidosim.simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "punt", args: { id: a.id, dir: [0, -1, 0], power: 1 } }, view);
        const b = out.sim.bodies[a.id]; if (b) { b.p = a.p.slice(); b.v = a.v.slice(); }
        out.launched[a.id] = { seq, cause: e.cause, by: e.actor, handled: a.handled ?? [e.actor] };
      } else if ((e.verb === "lift" || e.verb === "catch") && st.entities[a.id]) {
        // picked up (or caught mid-air): it leaves the world's physics — no body, no collider at its old spot — until
        // it's put down (an authored transform reseats it) or thrown (a launch)
        eidosim.simEntry(out.sim, { seq, ts: clock, actor: e.actor, verb: "remove", args: { id: a.id } }, { entities: {} });
        delete out.launched[a.id];
      }
    }
  };
  const view = (now) => {
    if (now !== undefined) { if (now > clock) clock = now; advance(clock); }
    out.clock = clock;
    out.rested = [];
    if (out.sim) for (const [id, l] of Object.entries(out.launched)) {
      const b = out.sim.bodies[id]; if (b?.resting) out.rested.push({ id, ...l, p: b.p, yaw: b.yaw, tick: l.restTick ?? out.sim.tick });
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
    const op = opsSafe(e).find((o) => o.comp === "transform" && o.id === c.body.id);
    const after = entries.slice(seq + 1).find((x) => isEntry(x) && x.kind === "act" && x.actor === "system" && x.body?.rest === seq);
    out.push({ seq, id: c.body.id, cause: e.cause, at: op?.value?.pos, handled: c.body.handled ?? [c.actor],
      ...(after?.verb === "return-lost" ? { lost: true } : {}), ...(after?.verb === "settle" ? { onto: after.body.onto } : {}) });
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
