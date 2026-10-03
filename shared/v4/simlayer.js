// shared/v4/simlayer.js — ported from the v4 lab (code/v4-lab/simlayer.js). Pure.
// The sim layer (design 20, P4–P7): a second fold beside the blind one. It reads the log's state entries (through
// fold.js, untouched) and its `sim` entries (intents that start motion), and runs the engine @world.sim names.
// It never writes the log: the door appends what it reports (rest results, P5). Determinism is local: it holds only
// for a carried engine build, inside one epoch. A world whose engine isn't carried here is still fully knowable from
// its results; this layer then computes no motion at all (Covenant II: a wrong answer is worse than none).
import { apply, emptyState } from "./fold.js";
import * as eidosim from "../sim.js";
import { sha256hex } from "../components.js";

// Models with no stamped shape aren't colliders here: in the engine, geometry enters the sim only through the log
// (Covenant III), as physics.shape. The lab passed a catalogue; the engine passes nothing.
const MODELS = {};

// Determinism is per binary (18b), so an engine is named AND hashed. This build carries one.
// sha256 of sim.js + simmath.js + terrainmath.js (joined by NUL), first 16 hex. tools/v4-test.ts pins it to the files:
// changing any of them without a new engine name is exactly what Covenant II forbids.
export const EIDOSIM_BUILD = "35c61300f4812699";
const EIDOSIM = EIDOSIM_BUILD;
// one build carries all five laws (her CARRIED set), so all five names resolve to it
export const ENGINES = Object.fromEntries(["0.1.0", "0.2.0", "0.3.0", "0.4.0", "0.5.0"].map((v) => [`eidosim@${v}`,
  { build: EIDOSIM, about: "antra's reference sim (PROTOCOL_v2, dialect 3): ballistic boxes, swept contacts, yaw only", maxSpeed: 20 }]));
export const carried = (spec) => !!spec && ENGINES[spec.engine]?.build === spec.build;

// P7: what releases a body (or reseats a collider) is WHICH COMPONENT changed, never which verb carried it.
const PHYSICAL = new Set(["transform", "parent", "model", "physics"]);

const yawOf = (q) => (Array.isArray(q) ? 2 * Math.atan2(q[1], q[3]) : 0);
function worldPose(st, id, depth = 0) {
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
// The engine sees the world through a v1-shaped view: one entry per modelled thing (its "lib" is its model).
function v1Entity(st, id) {
  const e = st.entities[id]; if (!e || !(MODELS[e.c.model] || e.c.physics?.shape) || e.c.physics?.kind === "none") return null;
  const t = worldPose(st, id);
  return { pos: t.pos, yaw: yawOf(t.q), lib: e.c.model, scale: t.scale[1] };
}
function v1View(st) {
  const entities = {};
  for (const id of Object.keys(st.entities)) { const v = v1Entity(st, id); if (v) entities[id] = v; }
  const terr = st.entities["@world"]?.c.terrain;
  return { entities, terrain: terr ?? { amplitude: 0 } }; // v4 worlds stand on y = 0 unless they declare terrain
}
const catalogueBox = (m) => [[-m.size[0] / 2, 0, -m.size[2] / 2], [m.size[0] / 2, m.size[1], m.size[2] / 2]];
// a collider's shape is the log's word when stamped there (physics.shape, Covenant III); the catalogue's otherwise
function boxesFor(st) {
  const out = Object.fromEntries(Object.entries(MODELS).map(([k, m]) => [k, catalogueBox(m)]));
  for (const e of Object.values(st.entities)) if (e.c.physics?.shape && typeof e.c.model === "string") out[e.c.model] = e.c.physics.shape;
  return out;
}
const touchedOps = (e) => (e.verb === "batch" ? (e.args?.ops ?? []) : [{ verb: e.verb, args: e.args ?? {} }]);

// Fold the whole log: the blind state, plus the sim epoch's live bodies and what came to rest (not yet logged).
export function simFold(entries, getBlob, now) {
  const st = emptyState();
  const out = { st, spec: null, foreign: false, sim: null, launched: {}, rested: [], checks: { agree: 0, disagree: [] } };
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
  for (const e of entries) {
    if (out.sim) advance(e.ts);
    const said = e.kind === "state" && e.args?.sim?.digest;
    if (said && out.sim) { const mine = digestOf(out.sim); if (mine === said) out.checks.agree++; else out.checks.disagree.push({ seq: e.seq, logged: said, mine }); }
    if (e.kind === "state" && e.args?.sim?.rest && out.sim) { // and the resting place itself
      const r = e.args.sim; const b = out.sim.bodies[r.id];
      if (!b || !b.resting || JSON.stringify(r.at) !== JSON.stringify(b.p)) out.checks.disagree.push({ seq: e.seq, id: r.id, logged: r.at, mine: b ? (b.resting ? b.p : "still flying") : "not in the sim" }); }
    const wasSpec = JSON.stringify(st.entities["@world"]?.c.sim ?? null);
    apply(st, e, getBlob);
    if (e.kind === "state") {
      const spec = st.entities["@world"]?.c.sim ?? null;
      if (JSON.stringify(spec) !== wasSpec) { // an epoch boundary. The door makes it a real cut: nothing in flight (P6).
        out.spec = spec; out.launched = {}; out.foreign = !!spec && !carried(spec); out.sim = null;
        if (spec && !out.foreign) {
          out.sim = eidosim.emptySim();
          eidosim.simEntry(out.sim, { seq: e.seq, ts: e.ts, actor: "door", verb: "epoch", args: { sim: spec.engine, tickMs: spec.tickMs, boxes: boxesFor(st) } }, v1View(st));
        }
        continue;
      }
      if (!out.sim) continue;
      for (const o of touchedOps(e)) { // P7, keyed by component
        const a = o.args ?? {}; if (typeof a.id !== "string") continue;
        if (a.id === "@world") { // the ground itself changed: re-ground, release every body, rebuild colliders (her law)
          if (a.component === "terrain") eidosim.simEntry(out.sim, { seq: e.seq, ts: e.ts, actor: e.actor, verb: "terrain", args: st.entities["@world"].c.terrain ?? {} }, v1View(st));
          if (a.component === "terrain") out.launched = {};
          continue; }
        const shape = st.entities[a.id]?.c.physics?.shape, model = st.entities[a.id]?.c.model;
        if (shape && out.sim.boxes && typeof model === "string") out.sim.boxes[model] ??= shape;
        const whole = o.verb === "create" || (o.verb === "delete" && !a.component);
        if (!whole && !PHYSICAL.has(a.component)) continue;
        const ids = [a.id, ...Object.keys(st.entities).filter((k) => isUnder(st, k, a.id))];
        for (const id of ids) {
          const view = v1View(st); const gone = !view.entities[id];
          eidosim.simEntry(out.sim, { seq: e.seq, ts: e.ts, actor: e.actor, verb: gone ? "remove" : "place", args: { id } }, view);
          if (out.launched[id]) delete out.launched[id];
        }
      }
    } else if (e.kind === "sim" && out.sim) {
      const a = e.args ?? {};
      if (e.verb === "launch" && st.entities[a.id] && Array.isArray(a.p) && Array.isArray(a.v)) {
        const view = v1View(st); const base = view.entities[a.id]; if (!base) continue;
        view.entities[a.id] = { ...base, pos: a.p, yaw: typeof a.yaw === "number" ? a.yaw : base.yaw };
        // her punt makes the body (order, statics, box); then the launch's stamped state is set EXACTLY — through
        // dir/power it would be renormalised, which can move it by an ulp, and dialect 3 has no zero-power "let go"
        eidosim.simEntry(out.sim, { seq: e.seq, ts: e.ts, actor: e.actor, verb: "punt", args: { id: a.id, dir: [0, -1, 0], power: 1 } }, view);
        const b = out.sim.bodies[a.id]; if (b) { b.p = a.p.slice(); b.v = a.v.slice(); }
        out.launched[a.id] = { seq: e.seq, cause: e.cause, by: e.actor, handled: a.handled ?? [e.actor] };
      } else if (e.verb === "catch" && out.sim.bodies[a.id]) {
        // caught mid-air: the sim lets go (a static leaves with it); presence owns it until it's put or thrown
        eidosim.simEntry(out.sim, { seq: e.seq, ts: e.ts, actor: e.actor, verb: "remove", args: { id: a.id } }, { entities: {} });
        delete out.launched[a.id];
      }
    }
  }
  if (now !== undefined) advance(now);
  if (out.sim) for (const [id, l] of Object.entries(out.launched)) {
    const b = out.sim.bodies[id]; if (b?.resting) out.rested.push({ id, ...l, p: b.p, yaw: b.yaw, tick: l.restTick ?? out.sim.tick });
  }
  return out;
}
function isUnder(st, k, id) { let p = st.entities[k]?.c.parent?.to, n = 0; while (p && n++ < 32) { if (p === id) return true; p = st.entities[p]?.c.parent?.to; } return false; }

// Where things are right now, for reads: the blind state's word, except bodies the sim owns.
export function livePoses(sf) {
  const out = {};
  if (!sf.sim) return out;
  for (const [id, b] of Object.entries(sf.sim.bodies)) if (!b.resting && sf.launched[id]) out[id] = { pos: b.p.map((n) => Math.round(n * 1000) / 1000), v: b.v.map((n) => Math.round(n * 100) / 100) };
  return out;
}
export const digestOf = (sim) => sha256hex(JSON.stringify(eidosim.simSnapshot(sim))).slice(0, 16);
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
