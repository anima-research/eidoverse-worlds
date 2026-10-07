// Dialect-3 (physics) → v4 translator (lab). The old world is her instant fold COMPOSED with her sim (PROTOCOL_v2,
// conformance order: foldEntry, then simEntry). v4 holds the same world differently (design 20): a punt becomes a
// logged launch with its exact stamped state; every rest becomes a logged result (P5). After every old entry this
// checks, bit for bit: (1) the composed old world against the v4 blind fold, (2) every body in flight against the
// v4 sim layer. The original log is never written; the output is a regenerable cache.
// Ported from the v4 lab (code/v4-lab/translate-d3.js @ 11db981). Engine changes: the v1 fold and the sim are the
// engine's own ../fold.js and ../sim.js; the lab's CLI (her four goldens) is a check in tools/v4/run.ts.
import { emptyState as v1Empty, foldEntry } from "./fold.js";
import * as eidosim from "../../../shared/sim.js";
import { applyInPlace, opsOf, emptyState as v4Empty, worldIdOf, VERSION } from "../../../shared/v4/fold.js";
import { project, enc, actorOf, diff, changeBody, unNegZero, translatedGenesis } from "./translate-v1.js";
import { simFold, digestOf, ENGINES } from "../../../shared/v4/simlayer.js";

export const TRANSLATOR = "translate-d3@0.2";
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

// What the old world MEANS in v4 terms: her projection, plus where her sim has put things to rest, plus the epoch
// as @world.sim and each collider's stamped box as physics.shape.
function composed(st, sim, recorded) {
  const out = project(st);
  const w = out["@world"] ?? (out["@world"] = {});
  delete w["imported-epoch"];
  if (st.epoch) w.sim = { engine: st.epoch.sim, build: ENGINES[st.epoch.sim]?.build ?? null, tickMs: st.epoch.tickMs };
  if (!Object.keys(w).length) delete out["@world"];
  // v4 holds the last LOGGED rest pose until her law releases the body (resting or flying again, it's the log's word)
  for (const [id, p] of recorded) if (sim.bodies[id] && out[enc(id)]) out[enc(id)].transform = { ...out[enc(id)].transform, pos: p.slice() };
  if (sim.boxes) for (const [id, c] of Object.entries(out)) if (typeof c.model === "string" && sim.boxes[c.model]) c.physics = { shape: sim.boxes[c.model] };
  return out;
}

export function translate(old) {
  const st = v1Empty(), sim = eidosim.emptySim(), out = [], recorded = new Map(); // id → last logged rest pose
  const stats = { in: old.length, out: 0, launches: 0, rests: 0, worldDivergences: 0, flightDivergences: 0, first: null, visible: [] };
  const v4 = v4Empty(); let world = null, lastAt = old[0]?.ts ?? 0;
  const push = (e) => { if (e.kind !== "genesis") e = { world, ...e }; const seq = out.length; out.push(e); if (typeof e.ts === "number") lastAt = e.ts;
    if (e.kind === "genesis") world = worldIdOf(e); if (e.kind === "change") applyInPlace(v4, opsOf(e), seq); return seq; };
  const g = old[0]?.verb === "genesis" ? old[0].args : {};
  push({ kind: "genesis", actor: "system", verb: "genesis", ts: old[0]?.ts ?? 0, body: translatedGenesis(old) }); // §2.4 + §3d (translate-v1.js)
  push({ kind: "act", actor: "system", verb: "translated", ts: old[0]?.ts ?? 0, body: { from: unNegZero({ ...g, translator: TRANSLATOR }) } });
  let prev = composed(st, sim, recorded);
  const launchSeq = {}; const restLogged = new Set(); // bodies whose CURRENT flight's rest is logged
  const restTicks = {};
  const stepTo = (tick) => { // single steps while anything flies, so each rest's real tick is known
    while (sim.epoch && !sim.epoch.foreign && sim.tick < tick) {
      const flying = Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
      if (!flying.length) { eidosim.advanceSim(sim, tick); break; }
      eidosim.advanceSim(sim, sim.tick + 1);
      for (const id of flying) if (sim.bodies[id]?.resting) restTicks[id] = sim.tick;
    }
  };
  const logRests = (ts) => { // P5: one result per body that came to rest, in the order they stopped
    const fresh = Object.keys(sim.bodies).filter((id) => sim.bodies[id].resting && launchSeq[id] !== undefined && !restLogged.has(id))
      .sort((a, b) => restTicks[a] - restTicks[b]);
    for (const id of fresh) {
      // L3: the engine digest is its own sim entry; the rest is a plain change entry caused by the launch
      push({ kind: "sim", actor: "sim", ts, cause: launchSeq[id], verb: "digest", body: { digest: (() => { const sf = simFold(out, ts); return sf.sim ? digestOf(sf.sim) : null; })() } });
      recorded.set(id, sim.bodies[id].p.slice()); restLogged.add(id);
      const now = composed(st, sim, recorded); const ops = diff(prev, now); prev = now;
      push({ kind: "change", actor: "sim", ts, cause: launchSeq[id], ...changeBody(unNegZero(ops)) });
      stats.rests++;
    }
  };
  const check = (old) => {
    if (canon(Object.fromEntries(Object.entries(v4.entities).map(([id, e]) => [id, e.c]))) !== canon(prev)) {
      stats.worldDivergences++; stats.first ??= { oldSeq: old.seq, verb: old.verb, kind: "world" }; }
    const sf = simFold(out, old.ts);
    for (const [id, b] of Object.entries(sim.bodies)) if (!b.resting) {
      const mine = sf.sim?.bodies[enc(id)];
      if (!mine || !eq(mine.p, b.p) || !eq(mine.v, b.v)) { stats.flightDivergences++; stats.first ??= { oldSeq: old.seq, verb: old.verb, kind: "flight", id, theirs: b.p, mine: mine?.p }; }
    }
  };
  for (const e of old) {
    if (e.verb === "genesis") continue;
    if (sim.epoch) { stepTo(eidosim.tickOf(sim, e.ts)); logRests(e.ts); }
    const wasBody = sim.bodies[e.args?.id];
    foldEntry(st, e); eidosim.simEntry(sim, e, st);
    const tl = push({ kind: "act", actor: actorOf(e.actor ?? "door"), ts: e.ts, verb: "imported", body: unNegZero({ verb: e.verb, args: clone(e.args) ?? null, from: e.seq ?? null }) });
    const b = sim.bodies[e.args?.id];
    if (e.verb === "punt" && b && b.seq === e.seq) { // her punt started (or kicked) a body: a launch with its exact state
      launchSeq[e.args.id] = push({ kind: "sim", actor: actorOf(e.actor ?? "door"), ts: e.ts, cause: tl, verb: "launch", body: unNegZero({ id: enc(e.args.id), p: b.p.slice(), yaw: b.yaw, v: b.v.slice() }) });
      restLogged.delete(e.args.id); stats.launches++;
    }
    for (const id of [...recorded.keys(), ...Object.keys(launchSeq)]) if (!sim.bodies[id]) { recorded.delete(id); restLogged.delete(id); delete launchSeq[id]; } // released by her law
    const now = composed(st, sim, recorded); const ops = diff(prev, now);
    if (ops.length) {
      push({ kind: "change", actor: actorOf(e.actor ?? "door"), ts: e.ts, cause: tl, ...changeBody(unNegZero(ops)) });
      const moved = ops.filter((o) => o.comp === "transform" && e.verb === "terrain");
      if (moved.length) stats.visible.push({ oldSeq: e.seq, verb: e.verb, said: moved.map((o) => `${o.id} → ${JSON.stringify(o.value.pos)}`) });
    }
    prev = now;
    check(e);
  }
  // settle, as her replaybench does: far past the last entry, then log what came to rest
  if (sim.epoch && !sim.epoch.foreign) {
    const lastTs = lastAt; let k = sim.tick;
    stepTo(k + 100000);
    const tsAt = (tick) => sim.epoch.ts + tick * sim.epoch.tickMs;
    const end = Math.max(lastTs, ...Object.values(restTicks).map(tsAt));
    logRests(end);
  }
  stats.out = out.length;
  return { out, stats, theirs: sim };
}

