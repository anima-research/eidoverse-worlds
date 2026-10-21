// tools/protocol/eidosim-check.ts — eidosim's adapter (shared/sim.js over shared/eidosim.js) keeps the sim API's laws.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/eidosim-check.ts
// S1 (Covenant IV): any advance schedule reaching tick T gives the same bits: one jump, tick by tick, split, and
//    with a JSON clone between ticks. Review 49d4fb0d #1: a body resting mid-call stayed dynamic in the live world.
import * as S from "../../shared/sim.js";
import { restsOf, ENGINES } from "../../shared/protocol/simlayer.js";
import { makeReplica } from "../../shared/protocol/replica.js";
let pass = 0, fail = 0;
const ok = (c: boolean, name: string, info?: unknown) => { if (c) pass++; else { fail++; console.log("FAIL", name, info === undefined ? "" : JSON.stringify(info)); } };
const J = (x: unknown) => JSON.stringify(x), clone = (x: any) => JSON.parse(J(x));
const BOX = [[-0.25, 0, -0.25], [0.25, 0.5, 0.25]], PLANK = [[-1, 0, -0.1], [1, 0.1, 0.1]];
function mk(ents: any, launches: any[], terrain: any = { amplitude: 0 }) {
  const sim: any = S.emptySim(); const view = { entities: ents, terrain };
  S.simEntry(sim, { seq: 0, ts: 0, verb: "epoch", args: { sim: S.SIM_ID, tickMs: 33, boxes: { crate: BOX, plank: PLANK } } }, view);
  launches.forEach((l, i) => S.simEntry(sim, { seq: 1 + i, ts: 0, verb: "launch", args: l }, view));
  return sim;
}
const schedules = (mkf: () => any, T: number) => {
  const j = mkf(); S.advanceSim(j, T);
  const t = mkf(); for (let k = t.tick + 1; k <= T; k++) S.advanceSim(t, k);
  let c = mkf(); for (let k = c.tick + 1; k <= T; k++) { c = clone(c); S.advanceSim(c, k); }
  const s = mkf(); for (const k of [7, 31, 32, 90, T]) if (k <= T) S.advanceSim(s, k);
  return [j, t, c, s].map((x) => J(S.simSnapshot(x)));
};
{ // the reviewer's case: a rests at tick 24 while b still flies toward it
  const ents = { a: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1 }, b: { pos: [3, 0, 0], yaw: 0, model: "crate", scale: 1 } };
  const L = [{ id: "a", p: [0, 0.3, 0], v: [0, 0, 0] }, { id: "b", p: [-3, 0.3, 0], v: [2.2, 6, 0.01], w: [0.5, 1, 2] }];
  for (const T of [36, 120, 200]) { const [j, t, c, s] = schedules(() => mk(ents, L), T);
    ok(j === t && t === c && c === s, `S1 one rests while another flies: every schedule agrees at tick ${T}`, { jumpEqTicks: j === t, cloneEqTicks: c === t, splitEqTicks: s === t }); }
}
{ // a seeded fuzz of mixed flights over noisy ground
  let seed = 5; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0, runs = 0;
  for (let n = 0; n < 40; n++) {
    const k = 2 + Math.floor(rnd() * 3), ents: any = {}, L: any[] = [];
    for (let i = 0; i < k; i++) { const lib = rnd() < 0.3 ? "plank" : "crate", p = [rnd() * 3 - 1.5, 0, rnd() * 3 - 1.5];
      ents["t" + i] = { pos: p, yaw: 0, lib, scale: 1 };
      L.push({ id: "t" + i, p: [p[0], 0.2 + rnd() * 2, p[2]], v: [rnd() * 6 - 3, rnd() * 4, rnd() * 6 - 3], w: [rnd() * 6 - 3, rnd() * 6 - 3, rnd() * 6 - 3] }); }
    const [j, t, c, s] = schedules(() => mk(ents, L, { amplitude: 0.3, seed: n }), 150); runs++;
    if (!(j === t && t === c && c === s)) bad++;
  }
  ok(bad === 0, `S1 fuzz: ${runs} multi-body flights, every schedule agrees`, { bad });
}
{ // S2: spin is capped by the law, like v (review #2): a corner never moves faster than 20 m/s at launch
  const ents = { a: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1 } };
  const sim = mk(ents, [{ id: "a", p: [0, 0.6, 0], v: [0, 0, 0], w: [1000, 0, 0] }]); const b = sim.bodies.a;
  const rim = Math.hypot(...b.w) * Math.hypot(...b.half);
  ok(rim <= 20 + 1e-9 && rim > 19.9, "S2 a 1000 rad/s throw is held to a 20 m/s rim speed", { w: b.w, rim });
  let top = 0, k = 0; for (; k < 3000 && !sim.bodies.a.resting; k++) { S.advanceSim(sim, sim.tick + 1); top = Math.max(top, Math.hypot(...sim.bodies.a.v)); }
  ok(top <= 20 && Math.hypot(sim.bodies.a.p[0], sim.bodies.a.p[2]) < 60, "S2 …and it can't roll off past the speed cap", { top, at: sim.bodies.a.p, tick: k });
  const slow = mk(ents, [{ id: "a", p: [0, 0.6, 0], v: [0, 0, 0], w: [0, 6, 0] }]);
  ok(J(slow.bodies.a.w) === J([0, 6, 0]), "S2 a gentle spin is kept as sent", slow.bodies.a.w);
}
{ // S3: a mirrored thing is the same box (review #5): scale [-2,1,1] collides as [2,1,1]
  const a = mk({ m: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, scale3: [-2, 1, 1] } }, [{ id: "m", p: [0, 1, 0], v: [0, 0, 0] }]);
  const b = mk({ m: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, scale3: [2, 1, 1] } }, [{ id: "m", p: [0, 1, 0], v: [0, 0, 0] }]);
  ok(J(a.bodies.m.half) === J(b.bodies.m.half) && a.bodies.m.half[0] === 0.5, "S3 negative scale sizes the collider by its magnitude", { mirrored: a.bodies.m.half, plain: b.bodies.m.half });
}
{ // S4: culling statics a flyer can't reach is exact (review #4): bit-identical to a world holding every static, every
  // tick; and the safety net binds (a reach box that keeps nothing is redone whole, and still exact)
  const SLAB = [[-3, 0, -3], [3, 0.2, 3]];
  const mk2 = (ents: any, L: any[], terrain: any) => { const sim: any = S.emptySim(), view = { entities: ents, terrain };
    S.simEntry(sim, { seq: 0, ts: 0, verb: "epoch", args: { sim: S.SIM_ID, tickMs: 33, boxes: { crate: BOX, plank: PLANK, slab: SLAB } } }, view);
    L.forEach((l, i) => S.simEntry(sim, { seq: 1 + i, ts: 0, verb: "launch", args: l }, view)); return sim; };
  let seed = 11; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const run = (opt: any) => { let bad = 0; seed = 11;
    for (let n = 0; n < 12; n++) { const ents: any = {}, L: any[] = [], ns = 20 + Math.floor(rnd() * 150), R = 2 + rnd() * 10;
      for (let i = 0; i < ns; i++) ents["s" + i] = { pos: [rnd() * 2 * R - R, rnd() < 0.2 ? rnd() * 1.5 : 0, rnd() * 2 * R - R], yaw: rnd() * 6.28, model: ["crate", "crate", "plank", "slab"][Math.floor(rnd() * 4)], scale: 1 };
      const k = 1 + Math.floor(rnd() * 4);
      for (let i = 0; i < k; i++) { const p = ents["s" + i].pos; L.push({ id: "s" + i, p: [p[0], 0.5 + rnd() * 3, p[2]], v: [rnd() * 16 - 8, rnd() * 8, rnd() * 16 - 8], w: [rnd() * 8 - 4, rnd() * 8 - 4, rnd() * 8 - 4] }); }
      const terr = rnd() < 0.5 ? { amplitude: 0 } : { amplitude: 0.4, seed: n };
      const a = mk2(ents, L, terr), b = mk2(ents, L, terr);
      for (let t = a.tick + 1; t <= 300; t++) { S._cull.off = true; S.advanceSim(a, t); S._cull.off = false; S._cull.slack = opt.slack; S.advanceSim(b, t); S._cull.slack = null;
        if (J(S.simSnapshot(a)) !== J(S.simSnapshot(b))) { bad++; break; } } }
    return bad; };
  const r0 = S.cullStats.redo, bad = run({ slack: null });
  ok(bad === 0, "S4 culled statics: every tick bit-identical to the whole world (12 scenes, up to 170 statics, 1–4 flyers)", { bad });
  const r1 = S.cullStats.redo, starved = run({ slack: -1000 });
  ok(starved === 0 && S.cullStats.redo > r1, "S4 …and a cull that keeps nothing is caught after the step and redone whole", { bad: starved, redos: S.cullStats.redo - r1 });
}
{ // S5: a stamped sphere is a sphere (it rolls), not its model's box. Bars set before the first run.
  const SPH = { type: "sphere", radius: 0.2, pos: [0, 0.2, 0] };
  const flat = mk({ b: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, shape: SPH } }, [{ id: "b", p: [0, 0.5, 0], v: [0, 0, 0] }]);
  for (let k = 0; k < 400 && !flat.bodies.b.resting; k++) S.advanceSim(flat, flat.tick + 1);
  ok(flat.bodies.b.resting && flat.bodies.b.shape === "sphere" && Math.abs(flat.bodies.b.c[1] - 0.2) < 0.006, "S5a a dropped sphere rests with its centre at its radius", { c: flat.bodies.b.c, shape: flat.bodies.b.shape });
  // launched sliding at v0 with no spin on flat ground: friction spins it up until it rolls, at 5/7·v0 with w·r = v.
  // the same thing as a box just stops (μg ≈ 5.9 m/s², from 3 m/s in ~0.5 s)
  const slide = (shape: any, T: number) => { const sim = mk({ b: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, ...(shape ? { shape } : {}) } },
      [{ id: "b", p: [0, 0.001, 0], v: [3, 0, 0] }]); S.advanceSim(sim, T);
    const b = sim.bodies.b; return { v: b.v[0], w: b.w[2], resting: b.resting, x: b.c[0] }; };
  const r = slide(SPH, 5);   // ~0.17 s: rolling by then; rolling resistance slows it after
  ok(Math.abs(r.v - 3 * 5 / 7) / (3 * 5 / 7) < 0.05 && Math.abs(Math.abs(r.w) * 0.2 - Math.abs(r.v)) / Math.abs(r.v) < 0.05,
    "S5b a sphere launched sliding settles to rolling: v = 5/7·v0 and w·r = v (each within 5%)", { ...r, want: 3 * 5 / 7 });
  const bx = slide(null, 30);
  ok(Math.abs(bx.v) < 0.05 && bx.x < 1, "S5c the same thing as a box slides to a stop", bx);
  // ...and then it slows by its rolling resistance (0.05: μr·g/1.4 = 0.350 m/s²) and comes to rest, rather than rolling
  // until the runaway backstop holds the world in flight
  { const s5 = mk({ b: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, shape: SPH } }, [{ id: "b", p: [0, 0.001, 0], v: [3, 0, 0] }]);
    S.advanceSim(s5, 30); const v30 = s5.bodies.b.v[0]; S.advanceSim(s5, 60); const a = (v30 - s5.bodies.b.v[0]) / (30 * 0.033);
    let k = 60; while (!s5.bodies.b.resting && k < 1000) S.advanceSim(s5, ++k);
    ok(Math.abs(a - 0.05 * 9.81 / 1.4) / (0.05 * 9.81 / 1.4) < 0.1 && s5.bodies.b.resting && k * 0.033 < 15,
      "S5e a rolling ball slows by its rolling resistance and comes to rest", { decel: a, restsAfter_s: k * 0.033, at: s5.bodies.b.c }); }
  const ents = { a: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, shape: SPH }, c: { pos: [1, 0, 0], yaw: 0, model: "crate", scale: 1 } };
  const L = [{ id: "a", p: [-2, 1, 0], v: [3, 2, 0], w: [0, 0, -4] }];
  for (const T of [40, 120]) { const [j, t, c, s2] = schedules(() => mk(ents, L), T);
    ok(j === t && t === c && c === s2, `S5d spheres: every schedule agrees at tick ${T}`); }
}
{ // S6 (audit FIX-1, PHYSICS §1): a launch's rest covers every body its flight set moving: restsOf reads each transform
  const L: any[] = [
    { kind: "sim", actor: "ann", verb: "launch", body: { id: "a", p: [0, 1, 0], v: [1, 0, 0], handled: ["ann"] } },
    { kind: "change", actor: "sim", cause: 0, verb: "batch", body: { ops: [
      { verb: "set", id: "a", comp: "transform", value: { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } },
      { verb: "set", id: "b", comp: "transform", value: { pos: [2, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } }] } },
    { kind: "act", actor: "system", verb: "settle", body: { id: "b", onto: "deck", rest: 1 } },
  ];
  const r = restsOf(L);
  ok(r.length === 2 && r[0].id === "a" && r[1].id === "b" && J(r[1].at) === J([2, 0, 0]) && r[1].onto === "deck" && !r[0].onto,
    "S6 a rest that moved two bodies is two rests, each with its own settle", r);
  const one = restsOf([L[0], { kind: "change", actor: "sim", cause: 0, verb: "set", body: { id: "a", comp: "transform", value: { pos: [1, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] } } }]);
  ok(one.length === 1 && one[0].id === "a" && J(one[0].at) === J([1, 0, 0]), "S6 …and the one-body rest every older log holds reads as before", one);
}
{ // S7 (audit FIX-2): a joiner decides for itself whether it carries the cut's engine build
  const name = Object.keys(ENGINES).find((k) => k.startsWith("eidosim@"))!;
  const rep: any = makeReplica();
  rep.adopt({ state: {}, head: 0, sim: { spec: { engine: `${name.split("@")[0]}@0.0.1`, tickMs: 33 }, foreign: false, sim: { bogus: true }, clock: 0, launches: {}, launched: {} } });
  ok(rep.sim?.foreign === true && !rep.sim?.sim?.bogus, "S7 a cut naming a version this reader doesn't carry is foreign here, whatever the sender said", { foreign: rep.sim?.foreign });
  const rep2: any = makeReplica();   // review of 8377ec52 #10: a carried build but no engine state in the cut can't fly here either
  rep2.adopt({ state: {}, head: 0, sim: { spec: { engine: name, tickMs: 33 }, foreign: true, sim: null, clock: 0, launches: {}, launched: {} } });
  ok(rep2.sim?.foreign === true, "S7 …and a cut of a carried version with no engine state is foreign too (a mid-epoch sim only starts from a cut)", { foreign: rep2.sim?.foreign });
}
{ // S8 stage 2: what flies knocks what rests. A dynamic thing at rest is a sleeping body the engine wakes on contact; it
  // flies under the launch that woke it and rests as that launch's. A static-kind one is a collider and never moves.
  const sc = (kind: any) => ({ a: { pos: [2, 0, 0], yaw: 0, model: "crate", scale: 1, ...(kind ? { kind } : {}) }, b: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, kind: "dynamic" } });
  const L = [{ id: "b", p: [-1, 0.6, 0], v: [6, 1, 0] }];   // mk numbers launches seq 1..
  const run = (kind: any) => { const s2: any = mk(sc(kind), L); let woke: any = null;
    for (let t = 1; t <= 600; t++) { S.advanceSim(s2, t); if (!woke && s2.bodies.a && !s2.bodies.a.resting) woke = { t, seq: s2.bodies.a.seq };
      if (Object.values(s2.bodies).every((x: any) => x.resting)) break; } return { s2, woke }; };
  { const { s2, woke } = run("dynamic"); const a = s2.bodies.a;
    ok(!!woke && woke.seq === 1 && a?.resting && Math.hypot(a.c[0] - 2, a.c[2]) > 0.1, "S8 a thrown crate knocks a dynamic crate: it moves and rests, under the throw's launch", { woke, at: a?.c }); }
  { const { s2 } = run(undefined); ok(!s2.bodies.a && J(s2.statics.a.c) === J([2, 0.25, 0]), "S8 …a thing that isn't dynamic is a collider: it doesn't move", { c: s2.statics.a?.c }); }
  let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let bad = 0, sched = 0, knocked = 0;
  for (let n = 0; n < 8; n++) { const ents: any = {}, Ls: any[] = [], ns = 10 + Math.floor(rnd() * 50), R = 2 + rnd() * 4;
    for (let i = 0; i < ns; i++) ents["s" + i] = { pos: [rnd() * 2 * R - R, 0, rnd() * 2 * R - R], yaw: rnd() * 6.28, model: "crate", scale: 1, ...(rnd() < 0.7 ? { kind: "dynamic" } : {}) };
    for (const [k, y] of [["st1", 0], ["st2", 0.5], ["st3", 1]] as const) ents[k] = { pos: [0, y, 0], yaw: 0, model: "crate", scale: 1, kind: "dynamic" };
    for (let i = 0; i < 2; i++) { const p = ents["s" + i].pos; Ls.push({ id: "s" + i, p: [p[0], 1, p[2]], v: [-p[0] * 2 + rnd() - 0.5, 2, -p[2] * 2 + rnd() - 0.5], w: [rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2] }); }
    const a = mk(ents, Ls), b = mk(ents, Ls); let div = false;
    for (let t = 1; t <= 200; t++) { S._cull.off = true; S.advanceSim(a, t); S._cull.off = false; S.advanceSim(b, t); if (!div && J(S.simSnapshot(a)) !== J(S.simSnapshot(b))) { bad++; div = true; } }
    if (Object.values(b.bodies).some((x: any) => x.woken)) knocked++;
    const j = mk(ents, Ls); S.advanceSim(j, 200); if (J(S.simSnapshot(j)) !== J(S.simSnapshot(b))) sched++; }
  ok(bad === 0 && sched === 0 && knocked >= 6, "S8 crate fields: culled = whole world every tick, one jump = ticks, and things get knocked", { bad, sched, knocked, of: 8 });
}
{ // S9 (review of 8377ec52 #7): a woken thing is the launch's that reached it, not the newest launch anywhere
  const ents: any = { vase: { pos: [2, 0, 0], yaw: 0, model: "crate", scale: 1, kind: "dynamic" }, a: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: 1, kind: "dynamic" }, c: { pos: [0, 0, 40], yaw: 0, model: "crate", scale: 1, kind: "dynamic" } };
  const sim: any = mk(ents, [{ id: "a", p: [-1, 0.6, 0], v: [6, 1, 0] }, { id: "c", p: [0, 3, 40], v: [0, 4, 0] }]);   // seq 1: at the vase; seq 2: 40 m away
  let seqAt = -1; for (let t = 1; t <= 60 && seqAt < 0; t++) { S.advanceSim(sim, t); if (sim.bodies.vase && !sim.bodies.vase.resting) seqAt = sim.bodies.vase.seq; }
  ok(seqAt === 1, "S9 a crate knocked by A's throw is A's (launch 1), not C's toss 40 m away (2)", { seqAt }); }
{ // S10 (#8): a scaled sphere sits on the ground (its centre scales with its radius)
  const SPH = { type: "sphere", radius: 0.11, pos: [0, 0.11, 0] }, ys: number[] = [];
  for (const sc of [[1, 1, 1], [3, 1, 1], [1, 3, 1]]) { const sim: any = S.emptySim(), view = { entities: { b: { pos: [0, 0, 0], yaw: 0, model: "crate", scale: sc[1], scale3: sc, shape: SPH, kind: "dynamic" } }, terrain: { amplitude: 0 } };
    S.simEntry(sim, { seq: 0, ts: 0, verb: "epoch", args: { sim: S.SIM_ID, tickMs: 33, boxes: { crate: BOX } } }, view);
    S.simEntry(sim, { seq: 1, ts: 0, verb: "launch", args: { id: "b", p: [0, 0, 0], v: [0, 0, 0] } }, view);
    let k = 0; while (!sim.bodies.b.resting && k < 500) S.advanceSim(sim, ++k); ys.push(sim.bodies.b.p[1]); }
  ok(ys.every((y) => Math.abs(y) < 0.006), "S10 a sphere at scale 1, [3,1,1] and [1,3,1] rests with its bottom on the ground", ys); }
{ // S11 (#2): a fast ball doesn't pass through a resting knockable wall
  const THIN = [[-0.05, 0, -1], [0.05, 1, 1]];
  const run = (kind: any) => { const sim: any = S.emptySim(), view = { entities: { wall: { pos: [0, 0, 0], yaw: 0, model: "thin", scale: 1, ...(kind ? { kind } : {}) }, ball: { pos: [-3, 0, 0], yaw: 0, model: "crate", scale: 1, shape: { type: "sphere", radius: 0.1, pos: [0, 0.1, 0] } } }, terrain: { amplitude: 0 } };
    S.simEntry(sim, { seq: 0, ts: 0, verb: "epoch", args: { sim: S.SIM_ID, tickMs: 33, boxes: { thin: THIN, crate: BOX } } }, view);
    S.simEntry(sim, { seq: 5, ts: 0, verb: "launch", args: { id: "ball", p: [-3, 0.4, 0], v: [20, 0, 0] } }, view);
    for (let k = 1; k <= 15; k++) S.advanceSim(sim, k); return sim; };
  const st = run(null), dy = run("dynamic");
  ok(st.bodies.ball.p[0] < 0 && dy.bodies.ball.p[0] < 0.5 && !!dy.bodies.wall, "S11 a 20 m/s ball stops at a 10 cm wall, static or knockable (and knocks the knockable one)", { static: st.bodies.ball.p[0], dynamic: dy.bodies.ball.p[0], wallMoved: !!dy.bodies.wall }); }
{ // S11 (Covenant IV, review physics.md #11b): a CASCADE advanced with a JSON round trip between every tick equals the
  // straight advance, and no state number is ever -0 (JSON drops the sign: a -0 would diverge on the first round trip).
  const ents: any = {}; for (let i = 0; i < 24; i++) ents["d" + i] = { pos: [i * 0.7, 0, 0], yaw: 0, model: "crate", scale: 1, kind: "dynamic" };
  const Ls = [{ id: "d0", p: [-1, 0.6, 0], v: [7, 1.5, 0], w: [0, 0, -3] }];
  const a = mk(ents, Ls), b = mk(ents, Ls); let diverged = -1, negZero = 0, woken = 0;
  const scan = (x: any) => { if (typeof x === "number") { if (Object.is(x, -0)) negZero++; } else if (x && typeof x === "object") for (const v of Object.values(x)) scan(v); };
  let rt: any = b;
  for (let t = 1; t <= 400; t++) { S.advanceSim(a, t); rt = clone(rt); S.advanceSim(rt, t); scan(a);
    if (diverged < 0 && J(S.simSnapshot(a)) !== J(S.simSnapshot(rt))) diverged = t; }
  woken = Object.values(a.bodies).filter((x: any) => x.woken).length;
  ok(diverged < 0 && negZero === 0 && woken >= 4, "S11 a cascade with a JSON round trip every tick equals the straight advance, and never holds a -0", { diverged, negZero, woken });
}
console.log(`eidosim-check: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
