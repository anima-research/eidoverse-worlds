/**
 * Live reach test — the solver driving REAL bone nodes on the shipped rigs,
 * frame after frame, with the target moving under it.
 *
 *   bun tools/reachlive-test.ts
 *
 * tools/reach-test.ts checks the geometry and tools/reachrig-test.ts checks
 * the conversion against rig data. Neither writes a bone. This one does: it
 * puts the produced quaternions onto a real three.js hierarchy built from each
 * shipped rig, calls updateMatrixWorld the way a frame would, and then asks
 * the HAND NODE where it ended up. That is the only question that matters, and
 * it is the one a scene graph can answer and arithmetic cannot.
 */

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

const { THREE } = await import('./core-stub.mjs');
const { rigs, makeAvatar } = await import('./rig-load.mjs');
const { measureChain, solveChain } = await import('../client/lib/reachbone.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

/** One frame: solve, write the two bones, refresh the graph. */
function step(chain: any, av: any, target: number[], pole: number[] | null) {
  const out: any = solveChain(chain, av, target, pole);
  if (!out.ok) return out;
  chain.nodes.upper.quaternion.set(out.upper[0], out.upper[1], out.upper[2], out.upper[3]);
  chain.nodes.lower.quaternion.set(out.lower[0], out.lower[1], out.lower[2], out.lower[3]);
  av.root.updateMatrixWorld(true);
  return out;
}
const handAt = (chain: any) => chain.nodes.end.getWorldPosition(new THREE.Vector3());
const D = (a: any, b: number[]) => a.distanceTo(new THREE.Vector3(b[0], b[1], b[2]));

const good = rigs().filter((r: any) => !r.err);
console.log(`\n${good.length} rigs`);

console.log("\na hand goes where it is sent");
{
  let worst = 0, n = 0, unmeasurable: string[] = [];
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) { unmeasurable.push(rig.name); continue; }
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const reach = (chain.L1 + chain.L2) * 0.7;
    for (const dir of [[0, 0, 1], [0.6, 0.3, 0.7], [0.3, -0.7, 0.6]]) {
      const l = Math.hypot(...dir);
      const t = [sh.x + dir[0] / l * reach, sh.y + dir[1] / l * reach, sh.z + dir[2] / l * reach];
      const out: any = step(chain, av, t, null);
      if (!out.ok || out.res.bound.length) continue;
      worst = Math.max(worst, D(handAt(chain), t)); n++;
    }
  }
  check(`every rig's chain is measurable${unmeasurable.length ? ` (${unmeasurable.join(", ")} not)` : ""}`,
    unmeasurable.length === 0);
  check(`the HAND NODE lands on the target (${n} reaches, <0.1mm)`, worst < 1e-4, `worst ${(worst * 1000).toFixed(4)}mm`);
}

console.log("\nand it KEEPS going where it is sent (the moving target)");
{
  // the whole point of re-solving per frame: a target that moves is tracked,
  // not snapped to once
  let worst = 0, frames = 0, worstJump = 0, spike = 0, spikeRig = '';
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const reach = (chain.L1 + chain.L2) * 0.65;
    let pole: number[] | null = null;
    let prevElbow: THREE.Vector3 | null = null;
    const jumps: number[] = [];
    for (let f = 0; f < 240; f++) {
      // a point orbiting in front of the shoulder, one full turn over 4s
      const a = (f / 240) * Math.PI * 2;
      const t = [sh.x + Math.sin(a) * reach * 0.55, sh.y + Math.cos(a) * reach * 0.55, sh.z + reach * 0.75];
      const out: any = step(chain, av, t, pole);
      if (!out.ok) continue;
      pole = out.elbowOffset;
      if (!out.res.bound.length) { worst = Math.max(worst, D(handAt(chain), t)); frames++; }
      const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
      if (prevElbow) jumps.push(elbow.distanceTo(prevElbow));
      prevElbow = elbow;
    }
    // Per RIG, not pooled: pooling makes one body's legitimately fast region
    // an outlier against a percentile set by the other thirteen. Bodies differ
    // in proportion, so each is its own population.
    jumps.sort((a, b) => a - b);
    const p99r = jumps[Math.floor(jumps.length * 0.99)] || 1e-9;
    const mx = jumps[jumps.length - 1];
    worstJump = Math.max(worstJump, mx);
    if (mx / p99r > spike) { spike = mx / p99r; spikeRig = rig.name; }
  }
  check(`the hand stays on a moving target every frame (${frames} frames, <0.1mm)`, worst < 1e-4,
    `worst ${(worst * 1000).toFixed(4)}mm`);
  // Continuity, stated as the absence of a DISCONTINUITY rather than as a
  // speed limit.
  //
  // Honest scope: this proves the solver is SMOOTH, which is the property you
  // can see. It does NOT prove the pole hint earns its keep — mutation-tested
  // by feeding `null` every frame instead, and the result was just as smooth
  // (1.02x). The fallback pole is deterministic and continuous across the
  // reachable set; its one singularity is a target exactly along -forward,
  // which the frontal stop already refuses. The hint is kept because it costs
  // nothing and guards that case, not because anything here demonstrates it. The elbow legitimately swings fast when the arm is near full
  // extension — its position on the circle round the shoulder-hand axis is
  // ill-conditioned there, and on some rigs that reaches 5x the median frame
  // step. What a lost bend plane looks like is different in kind: one isolated
  // frame far outside the run of its neighbours. So compare the worst step to
  // the 99th percentile, which is what an absolute threshold would have hidden
  // (and would have been measuring my choice of orbit speed, not the solver).
  check(`the elbow never SNAPS: worst per-rig step is no outlier (max/p99 ${spike.toFixed(2)}x on ${spikeRig})`,
    spike < 2, `worst frame step overall ${(worstJump * 1000).toFixed(2)}mm`);
}

console.log("\nwith the body moving under it");
{
  // the torso turns (as a locomotion clip turns it) WHILE the target moves.
  // A reach that read its limits from the rest frame is correct here in the
  // first frame and drifts thereafter.
  let worst = 0, frames = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const chest = av.nodes.chest ?? av.nodes.spine;
    if (!chest) continue;
    let pole: number[] | null = null;
    for (let f = 0; f < 120; f++) {
      // drive the parent chain the way a clip would, and swing the whole body
      chest.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(f / 12) * 0.5);
      av.root.rotation.y = f / 40;
      av.root.position.set(Math.sin(f / 30) * 2, 0, Math.cos(f / 30) * 2);
      av.root.updateMatrixWorld(true);

      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(av.root.getWorldQuaternion(new THREE.Quaternion()));
      const reach = (chain.L1 + chain.L2) * 0.6;
      const t = [sh.x + fwd.x * reach, sh.y + reach * 0.2, sh.z + fwd.z * reach];
      const out: any = step(chain, av, t, pole);
      if (!out.ok) continue;
      pole = out.elbowOffset;
      if (!out.res.bound.length) { worst = Math.max(worst, D(handAt(chain), t)); frames++; }
    }
  }
  check(`the hand tracks while the torso turns and the body walks (${frames} frames, <0.1mm)`,
    worst < 1e-4, `worst ${(worst * 1000).toFixed(4)}mm`);
  check("...and that actually exercised the moving case", frames > 500, `${frames} frames`);
}

console.log("\nthe limits hold on live bones");
{
  let violations = 0, tested = 0, reported = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    let seed = 5;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 200; i++) {
      const t = [sh.x + (rnd() - 0.5) * 1.5, sh.y + (rnd() - 0.5) * 1.5, sh.z + (rnd() - 0.5) * 1.5];
      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      tested++;
      if (out.res.bound.length) reported++;
      // the invariant a scene graph can check: the bones never grow
      const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
      const hand = handAt(chain);
      const shoulder = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      if (Math.abs(shoulder.distanceTo(elbow) - chain.L1) > 1e-5) violations++;
      if (Math.abs(elbow.distanceTo(hand) - chain.L2) > 1e-5) violations++;
    }
  }
  check(`no bone ever changes length on a live rig (${tested} solves)`, violations === 0, `${violations}`);
  check(`out-of-range targets are reported, not faked (${reported} bound)`, reported > 0);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
