// tools/protocol/sim2-check.ts — the eidosim2 adapter (shared/sim2.js) keeps the sim API's laws.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/sim2-check.ts
// S1 (Covenant IV): any advance schedule reaching tick T gives the same bits: one jump, tick by tick, split, and
//    with a JSON clone between ticks. Review 49d4fb0d #1: a body resting mid-call stayed dynamic in the live world.
import * as S from "../../shared/sim2.js";
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
  const ents = { a: { pos: [0, 0, 0], yaw: 0, lib: "crate", scale: 1 }, b: { pos: [3, 0, 0], yaw: 0, lib: "crate", scale: 1 } };
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
  const ents = { a: { pos: [0, 0, 0], yaw: 0, lib: "crate", scale: 1 } };
  const sim = mk(ents, [{ id: "a", p: [0, 0.6, 0], v: [0, 0, 0], w: [1000, 0, 0] }]); const b = sim.bodies.a;
  const rim = Math.hypot(...b.w) * Math.hypot(...b.half);
  ok(rim <= 20 + 1e-9 && rim > 19.9, "S2 a 1000 rad/s throw is held to a 20 m/s rim speed", { w: b.w, rim });
  let top = 0, k = 0; for (; k < 3000 && !sim.bodies.a.resting; k++) { S.advanceSim(sim, sim.tick + 1); top = Math.max(top, Math.hypot(...sim.bodies.a.v)); }
  ok(top <= 20 && Math.hypot(sim.bodies.a.p[0], sim.bodies.a.p[2]) < 60, "S2 …and it can't roll off past the speed cap", { top, at: sim.bodies.a.p, tick: k });
  const slow = mk(ents, [{ id: "a", p: [0, 0.6, 0], v: [0, 0, 0], w: [0, 6, 0] }]);
  ok(J(slow.bodies.a.w) === J([0, 6, 0]), "S2 a gentle spin is kept as sent", slow.bodies.a.w);
}
{ // S3: a mirrored thing is the same box (review #5): scale [-2,1,1] collides as [2,1,1]
  const a = mk({ m: { pos: [0, 0, 0], yaw: 0, lib: "crate", scale: 1, scale3: [-2, 1, 1] } }, [{ id: "m", p: [0, 1, 0], v: [0, 0, 0] }]);
  const b = mk({ m: { pos: [0, 0, 0], yaw: 0, lib: "crate", scale: 1, scale3: [2, 1, 1] } }, [{ id: "m", p: [0, 1, 0], v: [0, 0, 0] }]);
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
      for (let i = 0; i < ns; i++) ents["s" + i] = { pos: [rnd() * 2 * R - R, rnd() < 0.2 ? rnd() * 1.5 : 0, rnd() * 2 * R - R], yaw: rnd() * 6.28, lib: ["crate", "crate", "plank", "slab"][Math.floor(rnd() * 4)], scale: 1 };
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
console.log(`sim2-check: ${pass} passed, ${fail} failed`); if (fail) process.exit(1);
