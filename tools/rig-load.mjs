// Load the SHIPPED VRM rigs headless, for anything that needs to test or
// measure against real skeletons rather than an idealised one.
//
// This exists because for a long time nothing did. ragdoll-test.ts and
// rag-param-study.mjs both drove a synthetic T-pose humanoid — "the invariants
// under test live in the particle sim, not in any particular VRM" — and the
// suite was green while every real rig in the fleet was broken. The rigs are
// the variable: heights run 0.63m to 1.53m, rests run T-pose to A-pose, and
// the fleet splits into 19-21 bone rigs and 50-54 bone ones that carry an
// upperChest and shoulders between the chest and the arm.
//
// No renderer and no textures are involved: the GLB's JSON chunk carries the
// node tree and the humanoid map, and world rest positions are all a skeleton
// test needs. VRM's normalized bone nodes share those positions by definition.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../client/node_modules/three/build/three.module.js';
import { glbJson, humanBones, isVrm0, PARENT, rigMath } from '../shared/rig.js';
export { glbJson, humanBones, isVrm0, PARENT } from '../shared/rig.js';
const { worldPositions, makeAvatar: makeRuntimeAvatar } = rigMath(THREE);
export { worldPositions };

export const VRM_DIR = fileURLToPath(new URL('../assets/opt/eidoverse/assets/vrms/', import.meta.url));

/** Every shipped rig, as { name, P } where P maps humanoid bone -> world rest
 *  position. Rigs without a humanoid extension or without hips are skipped
 *  loudly rather than silently. */
/** The rigs the WORLD offers that assets/opt does not hold.
 *
 *  The optimized store and the avatar roster are not the same set: the world
 *  serves claude, claude_suit, aletheia and aporia straight from the library,
 *  and claude is the DEFAULT body. Every suite here ran on the 14 optimized
 *  rigs and none of them on the body most people are actually wearing, which
 *  is how a cross-body reach shipped looking wrong on it. Opt-in so the
 *  ragdoll's measured baseline is not silently re-based; the reach suites take
 *  it. Returns [] if the library is not on disk.
 */
export function libraryRigs(dir = process.env.EIDOVERSE_DIR
  ? `${process.env.EIDOVERSE_DIR}/eidoverse/assets/vrms/`
  : fileURLToPath(new URL('../../eidoverse-video/eidoverse/assets/vrms/', import.meta.url))) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.vrm') && !n.endsWith('.ktx2.vrm')).sort(); }
  catch { return []; }
  const out = [];
  for (const f of names) {
    const name = f.replace('.vrm', '');
    let g, bones, wp;
    try { g = glbJson(readFileSync(dir + f)); bones = humanBones(g); wp = worldPositions(g); }
    catch (e) { out.push({ name, err: e.message }); continue; }
    if (!bones) { out.push({ name, err: 'no humanoid extension' }); continue; }
    const P = {};
    for (const [b, n] of Object.entries(bones)) if (g.nodes[n]) P[b] = wp(n);
    if (!P.hips) { out.push({ name, err: 'no hips bone' }); continue; }
    const nodeOf = new Map(Object.entries(bones).map(([b, n]) => [n, b]));
    const up = new Map();
    g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => up.set(c, i)));
    const realParent = {};
    for (const [b, n] of Object.entries(bones)) {
      let a = up.get(n);
      while (a !== undefined && !nodeOf.has(a)) a = up.get(a);
      realParent[b] = a === undefined ? null : nodeOf.get(a);
    }
    out.push({ name, P, realParent, vrm0: isVrm0(g), boneCount: Object.keys(P).length });
  }
  return out;
}

export function rigs() {
  const out = [];
  for (const f of readdirSync(VRM_DIR).filter((n) => n.endsWith('.vrm') && !n.endsWith('.ktx2.vrm')).sort()) {
    const name = f.replace('.vrm', '');
    let g, bones, wp;
    try { g = glbJson(readFileSync(VRM_DIR + f)); bones = humanBones(g); wp = worldPositions(g); }
    catch (e) { out.push({ name, err: e.message }); continue; }
    if (!bones) { out.push({ name, err: 'no humanoid extension' }); continue; }
    const P = {};
    for (const [b, n] of Object.entries(bones)) if (g.nodes[n]) P[b] = wp(n);
    if (!P.hips) { out.push({ name, err: 'no hips bone' }); continue; }
    // The REAL parent chain, as the VRM has it: each humanoid bone's nearest
    // humanoid ANCESTOR. On 6 of the 14 shipped rigs that is not the simplified
    // chain — leftUpperArm hangs off leftShoulder, which hangs off upperChest —
    // and the ragdoll's `d.parent` is whatever the rig really says, so a
    // harness that assumes the simple chain is testing a skeleton nobody ships.
    const nodeOf = new Map(Object.entries(bones).map(([b, n]) => [n, b]));
    const up = new Map();
    g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => up.set(c, i)));
    const realParent = {};
    for (const [b, n] of Object.entries(bones)) {
      let a = up.get(n);
      while (a !== undefined && !nodeOf.has(a)) a = up.get(a);
      realParent[b] = a === undefined ? null : nodeOf.get(a);
    }
    out.push({ name, P, realParent, vrm0: isVrm0(g), boneCount: Object.keys(P).length });
  }
  return out;
}

// Test-only perturbation: start the production rig partway through a stride.
export function makeAvatar(P, { stride = 0, ...options } = {}) {
  const av = makeRuntimeAvatar(P, options);
  const { root, nodes } = av;
  if (stride) {
    // A plausible mid-walk frame: thighs split, one knee up, arms counterswung.
    //
    // About the RIG'S OWN axes, not the world's. 6 of the 14 shipped rigs
    // (meebit, orion, shino, victoria, vroid_fem, vroid_masc) carry
    // leftUpperArm on -X — they face -Z, the VRM 0.x convention, which the
    // raw GLB read here does not normalise away. Rotating those about world X
    // bent the knee FORWARD: not a mid-walk pose but a hyperextension no leg
    // can reach, so a solver with real limits was correct to fight it and a
    // fixture that produced it was testing an impossible body. Derived per
    // rig, the pose is the same walk on every skeleton.
    const up = (P.neck ?? P.chest ?? P.spine).clone().sub(P.hips).normalize();
    const lat = (P.leftUpperArm && P.rightUpperArm)
      ? P.leftUpperArm.clone().sub(P.rightUpperArm)
      : new THREE.Vector3(1, 0, 0);
    lat.addScaledVector(up, -lat.dot(up));
    if (lat.lengthSq() < 1e-9) lat.set(1, 0, 0);
    lat.normalize();
    const fwd = new THREE.Vector3().crossVectors(lat, up).normalize();
    const rot = (j, ax, deg) => nodes[j]?.quaternion.setFromAxisAngle(ax, deg * stride * Math.PI / 180);
    rot('leftUpperLeg', lat, -35); rot('rightUpperLeg', lat, 30); rot('leftLowerLeg', lat, 45);
    rot('leftUpperArm', fwd, -25); rot('rightUpperArm', fwd, 25); rot('spine', lat, 8);
    root.updateMatrixWorld(true);
  }
  return av;
}

// ---- geometry helpers shared by the measuring tools -----------------------

/** The lean goLimp actually passes: you fall the way you are facing, harder
 *  the faster you were moving. Tests must use this, or they measure a path
 *  production never takes — which is exactly how the old parameter study came
 *  to be tuned against launch impulses nothing ever sent. */
export function toppleLean(yaw = 0, speed = 0) {
  return new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw))
    .multiplyScalar(0.9 + Math.min(1.2, speed * 0.35));
}

/** Worst speed any foot reaches AFTER the body has come down — the "legs kick
 *  out from under it" measurement. Excludes the fall itself. */
export function footKick(Ragdoll, av, rest, lean, { maxSteps = 900 } = {}) {
  const rd = new Ragdoll(av, lean, rest);
  let steps = 0, landed = 0, peak = 0;
  while (!rd.done && steps < maxSteps) {
    rd.step(1 / 60); steps++;
    if (!landed && rd.p.hips.y < 0.12) landed = steps;
    if (landed && steps > landed + 6) {
      peak = Math.max(peak,
        rd.p.leftFoot.distanceTo(rd.pre.leftFoot) * 60,
        rd.p.rightFoot.distanceTo(rd.pre.rightFoot) * 60);
    }
  }
  return { rd, steps, peak };
}

/** Closest distance between two segments. */
export function segDist(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a < 1e-9 && e < 1e-9) return r.length();
  if (a < 1e-9) { s = 0; t = Math.min(1, Math.max(0, f / e)); }
  else {
    const c = d1.dot(r);
    if (e < 1e-9) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-9 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  return p1.clone().addScaledVector(d1, s).sub(p2.clone().addScaledVector(d2, t)).length();
}

/** Worst shaft-vs-shaft interpenetration among a ragdoll's own bone capsules,
 *  as a fraction of the separation those capsules should have kept. This is
 *  what colliding joint SPHERES could never see. Pairs that already overlap in
 *  the rest pose are excluded, exactly as the solver excludes them — a chest
 *  capsule genuinely does overlap a neck capsule on every real body. */
export function worstOverlap(rd) {
  let worst = 0, name = '';
  for (const { A, B, min } of rd.pairs) {
    const d = segDist(rd.p[A.a], rd.p[A.b], rd.p[B.a], rd.p[B.b]);
    const pen = (min - d) / min;
    if (pen > worst) { worst = pen; name = `${A.b}~${B.b}`; }
  }
  return { frac: worst, name };
}

/** Run a tumble to completion (or a step cap) and hand back the sim. `Ragdoll`
 *  is passed in rather than imported: importing it needs the core.js stub
 *  plugin registered first, which only the entry script can do. */
export function tumble(Ragdoll, av, rest, impulse, { dt = 1 / 60, maxSteps = 3000 } = {}) {
  const rd = new Ragdoll(av, impulse, rest);
  let steps = 0;
  while (!rd.done && steps < maxSteps) { rd.step(typeof dt === 'function' ? dt(steps) : dt); steps++; }
  return { rd, steps };
}
