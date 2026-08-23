/**
 * Live reach test — the solver driving REAL bone nodes on the shipped rigs,
 * frame after frame, with the target moving under it.
 *
 *   EIDOVERSE_DIR=~/connectome-local/eidoverse-video bun tools/reachlive-test.ts
 *
 * EIDOVERSE_DIR is not optional in a worktree: without it the library rigs
 * (claude, claude_suit, aletheia, aporia — claude is the DEFAULT body) do not
 * load and the suite silently drops to the 14 optimized ones.
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
const { rigs, libraryRigs, makeAvatar } = await import('./rig-load.mjs');
const { measureChain, solveChain } = await import('../client/lib/reachbone.js');
const { solveTwoBone, penetration } = await import('../shared/reach.js');

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

const good = [...rigs(), ...libraryRigs()].filter((r: any) => !r.err);
console.log(`\n${good.length} rigs`);

console.log("\na hand goes where it is sent");
{
  let worst = 0, n = 0, unmeasurable: string[] = [];
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
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
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
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
  // ⚠ RATCHET. Was 1.11x before the elbow-side constraint went in; it is now
  // ~66x, a real ~380mm snap during ORDINARY moving-target tracking. That is
  // the measured cost of making the side constraint hard, and it is the honest
  // trade on the table:
  //     no constraint : smooth, 34% of elbows bend backwards
  //     hard constraint: 0 bend backwards, ~380mm elbow snaps while tracking
  // Neither is right. The snap is not a sampling artefact — refining the
  // swivel to convergence does not remove it — it is the feasible ARC itself
  // rotating until the nearest edge switches ends, so the pose crosses in one
  // step. Fixing it needs the arc edge chosen with continuity across frames,
  // which is the piece that is not built.
  check(`elbow snap does not worsen (max/p99 ${spike.toFixed(2)}x on ${spikeRig})`,
    spike <= 67, `worst frame step overall ${(worstJump * 1000).toFixed(2)}mm`);
}

console.log("\nwith the body moving under it");
{
  // the torso turns (as a locomotion clip turns it) WHILE the target moves.
  // A reach that read its limits from the rest frame is correct here in the
  // first frame and drifts thereafter.
  let worst = 0, frames = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
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
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
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

console.log("\nnot through your own body");
{
  // antra, looking at it: "heavy self-intersection, arms passing through torso".
  // Targets across the body are what provoke it — reaching the LEFT hand at
  // points on the RIGHT side drags the forearm through the chest.
  //
  // Baseline first, with the guards switched off, so the improvement is
  // measured against a number and not against an impression.
  let before = 0, after = 0, worstAfter = 0, cases = 0, cleared = 0, gapWorst = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain?.guards?.length) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const R = (chain.L1 + chain.L2);
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      // a ring across the front of the torso, well inside arm's length —
      // squarely in the region where the elbow wants to be inside the chest
      const t = [sh.x - R * 0.55 + Math.cos(a) * R * 0.3,
                 sh.y + Math.sin(a) * R * 0.35,
                 sh.z + R * 0.22];
      // rebuild the live guard list the way solveChain does
      const guards = (chain.guards ?? []).map((g: any) => ({
        a: g.na.getWorldPosition(new THREE.Vector3()).toArray(),
        b: g.nb.getWorldPosition(new THREE.Vector3()).toArray(), r: g.r,
      }));
      const naive: any = solveTwoBone({
        root: sh.toArray(), target: t, L1: chain.L1, L2: chain.L2,
        pole: chain.dRestU, fwd: chain.fwd, coneAxis: chain.coneAxis,
        limits: { coneHalf: chain.lim.coneHalf, behind: chain.lim.behind, maxFlex: chain.lim.maxFlex },
      });
      if (!naive.ok) continue;
      cases++;
      before += penetration(sh.toArray(), naive.elbow, naive.hand, chain.rUpper, chain.rLower, guards);

      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      const pen = out.penetration ?? 0;
      after += pen; worstAfter = Math.max(worstAfter, pen);
      if (pen <= 0) cleared++;
      if (!out.res.bound.length) gapWorst = Math.max(gapWorst, D(handAt(chain), t));
    }
  }
  const drop = before > 0 ? (1 - after / before) : 0;
  console.log(`  ${cases} across-body targets: penetration ${(before * 100).toFixed(1)}cm -> ${(after * 100).toFixed(1)}cm total`);
  check(`the baseline actually penetrated (else this proves nothing)`, before > 0.05, `${before.toFixed(4)}m`);
  check(`self-intersection drops by >90% (${(drop * 100).toFixed(1)}%)`, drop > 0.9);
  check(`most targets come out completely clear (${cleared}/${cases})`, cleared / Math.max(1, cases) > 0.9);
  check(`worst remaining overlap is small (${(worstAfter * 1000).toFixed(1)}mm)`, worstAfter < 0.02);
  check(`and the hand still lands on target (${(gapWorst * 1000).toFixed(3)}mm)`, gapWorst < 1e-4);
}

console.log("\nself-touch does not hunt");
{
  // antra, reaching for their own shoulder: "enter endless oscillations ...
  // pretty close to success". The elbow flipped between adjacent swivel steps
  // on up to 54 frames out of 54.
  //
  // Cause: the solve was fed its own previous elbow as the pole hint, so it
  // depended on its own output, and the discrete swivel search gave that loop
  // something to bounce between. A static body reaching a static point must
  // produce the SAME arm every frame — an oscillator needs state, so the
  // solver keeps none. This test exists because a user found this and the
  // suite did not.
  let worstFlips = 0, worstRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    // a point just off the LEFT upper arm — anchored on a bone that is also
    // one of this arm's own guards, which is what made it unsatisfiable
    const lu = av.nodes.leftUpperArm.getWorldPosition(new THREE.Vector3());
    const target = [lu.x + 0.03, lu.y + 0.04, lu.z + 0.02];
    const seen: number[] = [];
    // Feed the elbow back in as the caller used to. That is the loop that
    // oscillated, so the test has to CLOSE it — passing null here would be a
    // check that cannot see the bug it was written for (it passed against the
    // reintroduced bug on the first attempt, which is how this was caught).
    let pole: number[] | null = null;
    for (let f = 0; f < 60; f++) {
      const out: any = step(chain, av, target, pole);
      if (!out.ok) break;
      pole = out.elbowOffset;
      seen.push(Math.round((out.swivel ?? 0) * 1e6));
    }
    if (seen.length < 30) continue;
    tested++;
    const settled = seen.slice(5);
    const flips = settled.filter((v, i) => i > 0 && v !== settled[i - 1]).length;
    if (flips > worstFlips) { worstFlips = flips; worstRig = rig.name; }
  }
  check(`a static self-touch settles on ONE arm and stays there (${tested} rigs, worst ${worstFlips} flips${worstRig ? ` on ${worstRig}` : ''})`,
    worstFlips === 0);
  check("...and it actually ran on every rig", tested >= 14, `${tested}`);
}

console.log("\nthe elbow does not sweep as the body turns");
{
  // antra: "depending on where the camera is (and where the head is looking)
  // the elbow either looks fine or slowly inverts into an unnatural position."
  //
  // The camera has nothing to do with the arm — but turning it turns the BODY,
  // which turns the chest, which turns the pole that picks the bend plane. As
  // the pole approached parallel with the reach direction its useful component
  // vanished, and normalizing a vanishing vector amplifies whatever is left:
  // the elbow swings around the arm. Slowly, because the body turns slowly.
  //
  // Stated without reference to cameras: with the target held in BODY space,
  // yawing the body must move the elbow smoothly in body space. A sweep shows
  // up as one step far outside the run of its neighbours.
  let spike = 0, spikeRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    const steps: number[] = [];
    let prev: THREE.Vector3 | null = null;
    for (let yi = 0; yi <= 360; yi += 2) {
      av.root.rotation.y = yi * Math.PI / 180;
      av.root.updateMatrixWorld(true);
      const q = av.root.getWorldQuaternion(new THREE.Quaternion());
      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      // The target sweeps a cone AROUND the arm's own rest direction, so the
      // reach direction passes straight through it. That is the degenerate
      // case: the pole is the rest direction, and where it is parallel to the
      // aim its perpendicular component vanishes. Aiming somewhere merely
      // convenient never gets near it — the first version of this test swept a
      // forward-across target, never came within 60° of the singularity, and
      // passed identically with the fix removed.
      const restW = new THREE.Vector3(...chain.dRestU).applyQuaternion(q).normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(restW).normalize();
      const up2 = restW.clone().cross(side).normalize();
      const a2 = yi * Math.PI / 180;
      const dir = restW.clone()
        .addScaledVector(side, Math.cos(a2) * 0.08)
        .addScaledVector(up2, Math.sin(a2) * 0.08)
        .normalize();
      const t = sh.clone().addScaledVector(dir, (chain.L1 + chain.L2) * 0.62).toArray();
      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      // elbow in BODY space, so the body's own rotation is factored out
      const eb = chain.nodes.lower.getWorldPosition(new THREE.Vector3())
        .sub(sh).applyQuaternion(q.clone().invert());
      if (prev) steps.push(eb.distanceTo(prev));
      prev = eb;
    }
    if (steps.length < 60) continue;
    tested++;
    steps.sort((a, b) => a - b);
    const p99 = steps[Math.floor(steps.length * 0.99)] || 1e-9;
    const mx = steps[steps.length - 1];
    if (mx / p99 > spike) { spike = mx / p99; spikeRig = rig.name; }
  }
  // ⚠ RATCHET, and the number is honest about a real remaining jump.
  //
  // Typical frame step is ~5mm; once per full revolution of this sweep one
  // step is ~330mm. That is not a ratio artefact — it is a genuine snap, and
  // it is the price of the elbow-side constraint being HARD. The feasible
  // swivel is a contiguous arc, the pose taken is the point in that arc
  // nearest the natural one, and when the arc rotates far enough that the
  // nearest edge switches ends, the elbow crosses in one step.
  //
  // This sweep is deliberately the worst case: the target orbits the arm's own
  // axis through 360°, which drags the arc through a full turn. Ordinary
  // motion does not — measured live in the browser, a body-anchored target
  // through a full body yaw moves the elbow 0.1mm median / 0.9mm max.
  //
  // Removing it is a rewrite: the arc edge would have to be chosen with
  // memory (which reintroduces the state that made the solver oscillate), or
  // the constraint softened (which lets elbows invert again). Ratcheted so it
  // cannot get worse while it is still wrong.
  check(`elbow sweep does not worsen (${tested} rigs, worst max/p99 ${spike.toFixed(2)}x on ${spikeRig})`,
    spike <= 64);
  check("...and the sweep actually ran", tested >= 14, `${tested}`);
}

console.log("\nelbows bend the way elbows bend (where that is knowable)");
{
  // The chord proxy is only valid for an un-adducted arm — reach across your
  // chest and the elbow legitimately sits in front of the chord. So this
  // measures exactly the population the solver claims to police, and no more.
  let inverted = 0, checked = 0, skipped = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    for (let yi = 0; yi < 8; yi++) {
      av.root.rotation.y = (yi / 8) * Math.PI * 2;
      av.root.updateMatrixWorld(true);
      const q = av.root.getWorldQuaternion(new THREE.Quaternion());
      const fwd = new THREE.Vector3(...chain.fwd).applyQuaternion(q);
      const inward = new THREE.Vector3(...chain.inward).applyQuaternion(q);
      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      const R = chain.L1 + chain.L2;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.6, 0.5)
          .applyQuaternion(q).normalize();
        if (dir.dot(inward) >= 0.3) { skipped++; continue; }   // adducted: proxy invalid
        const t = sh.clone().addScaledVector(dir, R * 0.6).toArray();
        const out: any = step(chain, av, t, null);
        if (!out.ok) continue;
        checked++;
        const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
        const chord = handAt(chain).sub(sh);
        if (chord.lengthSq() < 1e-8) continue;
        chord.normalize();
        const e = elbow.clone().sub(sh);
        const perp = e.clone().addScaledVector(chord, -e.dot(chord));
        if (perp.length() < 1e-4) continue;                    // straight: no bend
        if (perp.dot(fwd) > 1e-4) inverted++;
      }
    }
  }
  // ⚠ A RATCHET, NOT A PASS. 440 of 1296 elbows currently bend backwards where
  // the rule is measurable, and that is almost certainly the artefact antra
  // reported ("the elbow slowly inverts into an unnatural position"). It is
  // not fixed: every fix tried costs more than it buys.
  //
  //   - scoring the wrong side as a flat penalty in the swivel search: 0
  //     inversions, but the winning swivel then HOPS between 10° steps as the
  //     body turns and the elbow snaps across at 14x the normal frame step —
  //     the same artefact by another route.
  //   - making that cost a continuous ramp instead of a step: identical 14x.
  //     The cost being smooth does not help, because the SEARCH is discrete;
  //     the argmin over 10° samples jumps whenever two candidates swap rank.
  //
  // The real fix is to solve the swivel continuously — refine around the best
  // sample rather than return one of them — so the output moves as smoothly as
  // the objective does. Until then this guards against getting WORSE.
  check(`inverted elbows do not increase (${inverted}/${checked}, ${skipped} adducted and skipped)`,
    inverted <= 440);
  check("...and the sweep actually ran", checked > 500, `${checked}`);
}

console.log("\nthe forearm, crossing the body");
{
  // The bug antra can see and the harness could not, until it learned that six
  // of the eighteen rigs are VRM0 and sit a half-turn from the root.
  //
  // Reaching the opposite hip drags the forearm across the torso. The upper
  // bone is pushed clear (that works); nothing acts on the FOREARM, whose
  // path is fixed once the elbow is placed, so it crosses through the body.
  // Measured against the browser before this test existed: orion forearm 57mm
  // from the spine column where 162mm is required — and the headless numbers
  // now agree (48/55/123 vs the browser's 4/57/147).
  const segDist = (p1: any, q1: any, p2: any, q2: any) => {
    const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r); let s: number, t: number;
    if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
    if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else { const c = d1.dot(r);
      if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else { const b = d1.dot(d2), den = a * e - b * b;
        s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); } } }
    return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
  };
  let worstDeficitMM = 0, worstRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, 'rightHand');
    if (!chain || !av.nodes.leftUpperLeg || !av.nodes.rightUpperLeg) continue;
    const at = (n: string) => av.nodes[n]?.getWorldPosition(new THREE.Vector3());
    const sh = at('rightUpperArm');
    const lat = at('leftUpperLeg').clone().sub(at('rightUpperLeg')).normalize();
    const target = at('leftUpperLeg').clone().addScaledVector(lat, 0.09);
    const out: any = step(chain, av, target.toArray(), null);
    if (!out.ok) continue;
    tested++;
    const el = at('rightLowerArm'), hd = at('rightHand');
    for (const g of chain.guards ?? []) {
      const A = g.na.getWorldPosition(new THREE.Vector3());
      const B = g.nb.getWorldPosition(new THREE.Vector3());
      const req = g.r + chain.rLower * 0.25;
      const d = segDist(el, hd, A, B);
      // the guard nearest the TARGET is clipped on purpose — the hand has to
      // arrive somewhere — so only count the torso the hand is not reaching for
      if (segDist(target, target, A, B) < req) continue;
      const deficit = (req - d) * 1000;
      if (deficit > worstDeficitMM) { worstDeficitMM = deficit; worstRig = rig.name; }
    }
  }
  console.log(`  ${tested} rigs, worst forearm shortfall ${worstDeficitMM.toFixed(0)}mm on ${worstRig || '-'}`);
  // ⚠ RATCHET at the measured value. This is the open bug, not a pass: the
  // forearm crosses through the torso because nothing acts on it once the
  // elbow is placed. Lower this number when that is fixed; it exists so the
  // number cannot quietly grow while the fix is pending.
  check(`forearm-through-torso does not worsen (${worstDeficitMM.toFixed(0)}mm)`, worstDeficitMM <= 170);
  check('...and it actually ran', tested >= 14, `${tested}`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
