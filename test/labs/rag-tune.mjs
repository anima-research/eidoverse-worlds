// Sweep the verlet ragdoll's TUNING (ragdoll.js) against the rigs assets/opt holds (rig-load.mjs rigs()). The library's
// own rigs, the default claude body among them, are left out (libraryRigs() is opt-in there). Verlet is the fallback
// while Ammo warms or if it fails (bodysim.js); the default Bullet engine (ammodoll.js) is not measured here.
//
//   bun test/labs/rag-tune.mjs           # the candidate grid
//   bun test/labs/rag-tune.mjs current   # just the checked-in defaults
//   bun test/labs/rag-tune.mjs rigs      # per-rig breakdown — use this when
//                                    # adding an avatar to the fleet
//
// Replaces rag-param-study.mjs, which swept one synthetic T-pose skeleton
// against impulses production never sends, and had to be hand-edited to change
// a parameter. Every number here is measured on the real rigs, on the path
// goLimp actually takes.
//
// What each column means:
//   settled  how many rigs reached a natural capture instead of the deadline
//   steps    mean frames to settle (lower is a body that stops looking busy)
//   ovlp     worst bone-shaft interpenetration, % of the separation owed
//   strch    worst bone-length error at capture, %
//   resid    worst leftover speed at capture, m/s
//   drift    how far apart 30fps and 120fps land the same fall, metres —
//            the framerate-independence check, and the reason for FIXED_DT

import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('../stubs/core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { stubResolve(b, /^(\.\.?\/)+core\.js$/, () => ({ path: STUB })); } });
const { THREE } = await import('../stubs/core-stub.mjs');
const { Ragdoll, TUNING } = await import('../../client/lib/ragdoll/ragdoll.js');
const { rigs, makeAvatar, worstOverlap, toppleLean } = await import('../../tools/assets/rig-load.mjs');

const FLEET = rigs().filter((r) => !r.err);
const BASE = { ...TUNING };

function run(rig, { dt = 1 / 60, stride = 0, maxSteps = 1200 } = {}) {
  const av = makeAvatar(rig.P, { stride });
  const rest = av.restBonePositions();
  const rd = new Ragdoll(av, toppleLean(), rest);
  let steps = 0;
  while (!rd.done && steps < maxSteps) {
    rd.step(typeof dt === 'function' ? dt(steps) : dt);
    steps++;
  }
  const stretch = Math.max(...rd.links.map((l) =>
    Math.abs(rd.p[l.a].distanceTo(rd.p[l.b]) - l.len) / l.len));
  return { rd, steps, stretch, ovlp: worstOverlap(rd).frac, hips: rd.p.hips.clone() };
}

function evaluate(cfg) {
  // a key TUNING doesn't have would sweep nothing and print four labels over one solver
  const unknown = Object.keys(cfg).filter((k) => !(k in BASE));
  if (unknown.length) throw new Error(`rag-tune: TUNING has no ${unknown.join(', ')}`);
  Object.assign(TUNING, BASE, cfg);
  const deadline = TUNING.DEADLINE * 60;
  let settled = 0, sumSteps = 0, ovlp = 0, strch = 0, resid = 0, drift = 0, threw = 0;
  for (const rig of FLEET) {
    try {
      const a = run(rig);
      if (a.steps < deadline - 2) { settled++; sumSteps += a.steps; }
      ovlp = Math.max(ovlp, a.ovlp);
      strch = Math.max(strch, a.stretch);
      resid = Math.max(resid, a.rd.maxV);
      // same fall, three clocks: a fixed step should put it in the same place
      const slow = run(rig, { dt: 1 / 30 });
      const fast = run(rig, { dt: 1 / 120 });
      drift = Math.max(drift, slow.hips.distanceTo(fast.hips));
    } catch (e) { threw++; }
  }
  return {
    settled, threw,
    steps: settled ? Math.round(sumSteps / settled) : 0,
    ovlp: ovlp * 100, strch: strch * 100, resid, drift,
  };
}

const GRID = process.argv.includes('current') ? [{ label: 'checked-in', cfg: {} }] : [
  { label: 'sub 1 iter 3', cfg: { SUBSTEPS: 1, ITER: 3 } },
  { label: 'sub 2 iter 2', cfg: { SUBSTEPS: 2, ITER: 2 } },
  { label: 'sub 2 iter 3', cfg: { SUBSTEPS: 2, ITER: 3 } },
  { label: 'sub 3 iter 3', cfg: { SUBSTEPS: 3, ITER: 3 } },
];

const pad = (s, n) => String(s).padEnd(n);
const num = (x, n, d = 1) => x.toFixed(d).padStart(n);

// Per-rig, at the checked-in defaults. What to look at when a new avatar joins
// the fleet: the rigs disagree about everything the solver measures off them,
// and a body that will not settle usually says so here first.
if (process.argv.includes('rigs')) {
  console.log(pad('rig', 16), 'bones  height  settle    ovlp%  strch%    resid');
  for (const rig of FLEET) {
    const r = run(rig);
    console.log(
      pad(rig.name, 16), String(rig.boneCount).padStart(5),
      num(rig.P.head?.y ?? NaN, 8, 2),
      `${r.steps}${r.steps >= TUNING.DEADLINE * 60 - 2 ? '!' : ' '}`.padStart(8),
      num(r.ovlp * 100, 8), num(r.stretch * 100, 7), num(r.rd.maxV, 9, 4),
      rig.P.upperChest ? '  upperChest' : '');
  }
  console.log('\n! = hit the deadline instead of settling naturally');
  process.exit(0);
}

console.log(`fleet: ${FLEET.length} rigs, verlet, goLimp's path (no impulse)\n`);
console.log(pad('config', 30), 'settled  steps   ovlp%  strch%   resid   drift');
for (const { label, cfg } of GRID) {
  const r = evaluate(cfg);
  console.log(pad(label, 30),
    `${r.settled}/${FLEET.length}`.padStart(7), num(r.steps, 7, 0),
    num(r.ovlp, 7), num(r.strch, 7), num(r.resid, 7, 3), num(r.drift, 7, 3),
    r.threw ? `  ${r.threw} THREW` : '');
}
Object.assign(TUNING, BASE);
