// scratch/atk-phys-cmp.ts — one fixed clock: the checkpoint-booted engine vs a from-genesis fold of the same log. usage: bun scratch/atk-phys-cmp.ts <worldDir>
// @ts-nocheck
import { openLive } from "../server/livehost.ts"; import { digestOf, simFold, restsOf } from "../shared/protocol/simlayer.js";
const dir = process.argv[2]; const T = Date.now();
const a0 = performance.now(); const w = openLive(dir, "gym", { now: () => T }); const A = w.sim(); const openMs = performance.now() - a0;
const b0 = performance.now(); const B = simFold(w.entries, T, { models: {} }); const genMs = performance.now() - b0;
const fly = (v) => Object.values(v.sim.bodies).filter((b) => !b.resting).length;
const diffs = Object.keys(A.sim.bodies).filter((id) => JSON.stringify(A.sim.bodies[id]) !== JSON.stringify(B.sim.bodies[id] ?? null));
console.log(JSON.stringify({ entries: w.entries.length, bootedFrom: w.bootedFrom, tickA: A.sim.tick, tickB: B.sim.tick, digestA: digestOf(A.sim), digestB: digestOf(B.sim), EQUAL: digestOf(A.sim) === digestOf(B.sim), flyingA: fly(A), flyingB: fly(B), bodiesA: Object.keys(A.sim.bodies).length, bodiesB: Object.keys(B.sim.bodies).length, launchedA: Object.keys(A.launched).length, launchedB: Object.keys(B.launched).length, bodyDiffs: diffs.length, sample: diffs.slice(0, 2), openFromCkptMs: +openMs.toFixed(0), fromGenesisMs: +genMs.toFixed(0), restsLogged: restsOf(w.entries).length }));
