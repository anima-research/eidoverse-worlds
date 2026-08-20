/**
 * Reach-on-real-rigs test — the solver wired to the SHIPPED VRMs, headless.
 *
 *   bun tools/reachrig-test.ts
 *
 * tools/ragdoll-test.ts learned this lesson the expensive way: a synthetic
 * T-pose humanoid passed 18/18 while every real rig in the fleet was broken,
 * because the rigs are the variable the maths is most sensitive to. So the
 * geometry suite (tools/reach-test.ts) isolates the solver, and THIS one runs
 * it on all 14 bodies people actually wear.
 *
 * The check that matters is INDEPENDENT: the solver returns directions, the
 * conversion turns them into bone quaternions, and then forward kinematics
 * rebuilds the hand position FROM THOSE QUATERNIONS. If the rebuilt hand and
 * the requested target disagree, the conversion is wrong — and no amount of
 * the solver agreeing with itself would have told us.
 */

import { rigs } from "./rig-load.mjs";
import { solveTwoBone, chainLocalQuats, qMulq, qRot } from "../shared/reach.js";
import { bodyFrame, limitsFor, coneAxisBody, fromBody, toBody, D2R } from "../shared/joints.js";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};
const V = (p: any) => [p.x, p.y, p.z] as number[];
const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: number[], b: number[]) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: number[], s: number) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
const nrm = (a: number[]) => mul(a, 1 / len(a));
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Rebuild the hand FROM the bone quaternions — the independent witness. */
function forwardK(root: number[], dRestU: number[], dRestL: number[], L1: number, L2: number,
                  q: { upper: number[]; lower: number[] }) {
  const elbow = add(root, mul(qRot(q.upper, dRestU), L1));
  const worldLower = qMulq(q.upper, q.lower);       // parent world ∘ child local
  const hand = add(elbow, mul(qRot(worldLower, dRestL), L2));
  return { elbow, hand };
}

const all = rigs();
const good = all.filter((r: any) => !r.err);
console.log(`\n${good.length} rigs loaded${all.length - good.length ? `, ${all.length - good.length} skipped` : ""}`);

let reachedAll = 0, chainsAll = 0, worstGap = 0, worstLen = 0, worstFK = 0;
const bindingRigs: string[] = [];

for (const rig of good) {
  const P: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(rig.P)) P[k] = V(v);
  const F = bodyFrame(P);
  if (!F) { check(`${rig.name}: has a body frame`, false); continue; }

  for (const side of ["left", "right"] as const) {
    const U = `${side}UpperArm`, M = `${side}LowerArm`, H = `${side}Hand`;
    if (!P[U] || !P[M] || !P[H]) continue;
    chainsAll++;

    const L1 = len(sub(P[M], P[U])), L2 = len(sub(P[H], P[M]));
    const dRestU = nrm(sub(P[M], P[U])), dRestL = nrm(sub(P[H], P[M]));
    const lim = limitsFor(U);
    const coneAxisW = nrm(fromBody(coneAxisBody(toBody(dRestU, F), lim.coneTilt ?? 0), F));

    // A ring of targets around the shoulder at 70% of full extension — all
    // comfortably reachable, so any miss is the conversion's fault.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const dir = nrm(add(add(mul(coneAxisW, 0.6), mul(F.u, Math.sin(a) * 0.5)), mul(F.f, Math.cos(a) * 0.5)));
      const target = add(P[U], mul(dir, (L1 + L2) * 0.7));

      const r: any = solveTwoBone({
        root: P[U], target, L1, L2, pole: sub(P[M], P[U]),
        fwd: F.f, coneAxis: coneAxisW,
        limits: { coneHalf: lim.coneHalf, behind: lim.behind, maxFlex: lim.maxFlex },
      });
      if (!r.ok) { check(`${rig.name} ${side}: solved`, false, r.why); continue; }

      const q = chainLocalQuats(dRestU, dRestL, r.upper, r.lower);
      const fk = forwardK(P[U], dRestU, dRestL, L1, L2, q);

      // 1. the quaternions reproduce the solver's own answer
      worstFK = Math.max(worstFK, len(sub(fk.hand, r.hand)));
      // 2. bones did not stretch under the rotations
      worstLen = Math.max(worstLen, Math.abs(len(sub(fk.elbow, P[U])) - L1),
                                    Math.abs(len(sub(fk.hand, fk.elbow)) - L2));
      // 3. and where a reach was unbound, the hand is ON the target
      if (!r.bound.length) { reachedAll++; worstGap = Math.max(worstGap, len(sub(fk.hand, target))); }
      else if (!bindingRigs.includes(rig.name)) bindingRigs.push(rig.name);
    }
  }
}

console.log(`\n${chainsAll} arm chains, ${reachedAll} unbound reaches measured`);
check("forward kinematics agrees with the solver (<1µm)", worstFK < 1e-6, `worst ${(worstFK * 1e6).toFixed(3)}µm`);
check("no bone stretches under the produced rotations (<1µm)", worstLen < 1e-6, `worst ${(worstLen * 1e6).toFixed(3)}µm`);
check("an unbound reach puts the hand ON the target (<0.1mm)", worstGap < 1e-4, `worst ${(worstGap * 1000).toFixed(4)}mm`);
check("every rig produced reachable targets", reachedAll > 0);

console.log("\njoint limits actually bind on real rigs");
{
  // straight back and up behind the head: must be refused by cone or frontal stop
  let bound = 0, total = 0;
  for (const rig of good) {
    const P: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(rig.P)) P[k] = V(v);
    const F = bodyFrame(P); if (!F) continue;
    const U = "leftUpperArm", M = "leftLowerArm", H = "leftHand";
    if (!P[U] || !P[M] || !P[H]) continue;
    total++;
    const L1 = len(sub(P[M], P[U])), L2 = len(sub(P[H], P[M]));
    const lim = limitsFor(U);
    const dRestU = nrm(sub(P[M], P[U]));
    const coneAxisW = nrm(fromBody(coneAxisBody(toBody(dRestU, F), lim.coneTilt ?? 0), F));
    // 95% of full extension: at 80% the elbow bends and the upper bone stays
    // legitimately inside the stop (you CAN reach behind your back), so that
    // would be testing nothing. Near full extension the arm straightens and
    // the shoulder must take the whole angle.
    const target = add(P[U], mul(nrm(mul(F.f, -1)), (L1 + L2) * 0.95));
    const r: any = solveTwoBone({
      root: P[U], target, L1, L2, pole: sub(P[M], P[U]), fwd: F.f, coneAxis: coneAxisW,
      limits: { coneHalf: lim.coneHalf, behind: lim.behind, maxFlex: lim.maxFlex },
    });
    if (r.ok && r.bound.length) bound++;
  }
  check(`reaching straight out the back is limited on every rig (${bound}/${total})`, bound === total && total > 0);
}
{
  // and the frontal-plane stop is REAL: no solved hand may sit further behind
  // the body than 65°, on any rig, for any target
  let worstFwd = 1, worstCone = 1;
  for (const rig of good) {
    const P: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(rig.P)) P[k] = V(v);
    const F = bodyFrame(P); if (!F) continue;
    const U = "leftUpperArm", M = "leftLowerArm", H = "leftHand";
    if (!P[U] || !P[M] || !P[H]) continue;
    const L1 = len(sub(P[M], P[U])), L2 = len(sub(P[H], P[M]));
    const lim = limitsFor(U);
    const dRestU = nrm(sub(P[M], P[U]));
    const coneAxisW = nrm(fromBody(coneAxisBody(toBody(dRestU, F), lim.coneTilt ?? 0), F));
    let seed = 99;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 400; i++) {
      const t = add(P[U], [(rnd() - 0.5) * 2, (rnd() - 0.5) * 2, (rnd() - 0.5) * 2]);
      const r: any = solveTwoBone({
        root: P[U], target: t, L1, L2, pole: sub(P[M], P[U]), fwd: F.f, coneAxis: coneAxisW,
        limits: { coneHalf: lim.coneHalf, behind: lim.behind, maxFlex: lim.maxFlex },
      });
      if (!r.ok) continue;
      worstFwd = Math.min(worstFwd, dot(r.upper, F.f));
      worstCone = Math.min(worstCone, dot(r.upper, coneAxisW));
    }
  }
  check("no reach ever puts the UPPER BONE further back than the 65° stop",
    worstFwd >= -Math.sin(65 * D2R) - 1e-6, `worst forward component ${worstFwd.toFixed(6)}`);
  check("no reach ever leaves the shoulder cone", worstCone >= Math.cos(85 * D2R) - 1e-6,
    `worst cone dot ${worstCone.toFixed(6)}`);
}

console.log("\nwith the torso turned (the walking case)");
{
  // The chest is rotated by the clip every frame. A conversion that assumes
  // the arm's parent is at rest is correct in T-pose and wrong the moment the
  // body turns — so drive the parent with real rotations and demand the hand
  // still lands on target, rebuilt by FK through parent ∘ local.
  let worstGap2 = 0, worstLen2 = 0, worstFrame = 0, n = 0;
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const randQuat = () => {
    const u1 = rnd(), u2 = rnd(), u3 = rnd();
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(2 * Math.PI * u2), a * Math.cos(2 * Math.PI * u2),
            b * Math.sin(2 * Math.PI * u3), b * Math.cos(2 * Math.PI * u3)];
  };
  for (const rig of good) {
    const P: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(rig.P)) P[k] = V(v);
    const F = bodyFrame(P); if (!F) continue;
    const U = "leftUpperArm", M = "leftLowerArm", H = "leftHand";
    if (!P[U] || !P[M] || !P[H]) continue;
    const L1 = len(sub(P[M], P[U])), L2 = len(sub(P[H], P[M]));
    const dRestU = nrm(sub(P[M], P[U])), dRestL = nrm(sub(P[H], P[M]));

    for (let i = 0; i < 40; i++) {
      const qParent = randQuat();
      // everything the shoulder's limits are stated against is carried by the
      // parent too — the cone turns with the torso
      const dRestU_live = qRot(qParent, dRestU);
      const fwdLive = qRot(qParent, F.f);
      const lim = limitsFor(U);
      const coneLive = nrm(qRot(qParent, fromBody(coneAxisBody(toBody(dRestU, F), lim.coneTilt ?? 0), F)));
      // a target comfortably inside the reachable set, in front of the cone
      const target = add(P[U], mul(coneLive, (L1 + L2) * 0.7));

      const r: any = solveTwoBone({
        root: P[U], target, L1, L2, pole: dRestU_live, fwd: fwdLive, coneAxis: coneLive,
        limits: { coneHalf: lim.coneHalf, behind: lim.behind, maxFlex: lim.maxFlex },
      });
      if (!r.ok) continue;
      const q: any = chainLocalQuats(dRestU, dRestL, r.upper, r.lower, qParent);

      // rebuild the bone orientations the way a scene graph would: parent ∘ local
      const upperFrame = qMulq(qParent, q.upper);
      const lowerFrame = qMulq(upperFrame, q.lower);
      worstFrame = Math.max(worstFrame,
        len(sub(qRot(upperFrame, dRestU), qRot(q.upperFrame, dRestU))),
        len(sub(qRot(lowerFrame, dRestL), qRot(q.lowerFrame, dRestL))));

      const elbow = add(P[U], mul(qRot(upperFrame, dRestU), L1));
      const hand = add(elbow, mul(qRot(lowerFrame, dRestL), L2));
      worstLen2 = Math.max(worstLen2, Math.abs(len(sub(elbow, P[U])) - L1), Math.abs(len(sub(hand, elbow)) - L2));
      if (!r.bound.length) { worstGap2 = Math.max(worstGap2, len(sub(hand, target))); n++; }
    }
  }
  check(`parent ∘ local reproduces the solved frames (${n} unbound reaches)`, worstFrame < 1e-6,
    `worst ${(worstFrame * 1e6).toFixed(3)}µm`);
  check("bones keep their length through a turned torso", worstLen2 < 1e-6, `worst ${(worstLen2 * 1e6).toFixed(3)}µm`);
  check("the hand still lands ON the target with the torso turned", worstGap2 < 1e-4,
    `worst ${(worstGap2 * 1000).toFixed(4)}mm`);
  check("...and unbound reaches actually occurred", n > 0);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
