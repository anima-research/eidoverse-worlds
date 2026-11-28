// Load the shipped VRM rigs headless, so skeleton tests measure real rigs rather than an idealised T-pose humanoid
// (heights run 0.63–1.53 m, rests T- to A-pose, 19–21 vs 50–54 bones with upperChest and shoulders).
// No renderer: the GLB's JSON chunk carries the node tree and the humanoid map, and world rest positions are all a
// skeleton test needs.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from '../../client/node_modules/three/build/three.module.js';
import { glbJson, humanBones, isVrm0, PARENT, rigMath } from '../../shared/rig.js';
export { glbJson, humanBones, isVrm0, PARENT } from '../../shared/rig.js';
const { worldPositions, makeAvatar: makeRuntimeAvatar } = rigMath(THREE);
export { worldPositions };

export const VRM_DIR = fileURLToPath(new URL('../../assets/opt/eidoverse/assets/vrms/', import.meta.url));

/** The rigs the world's library serves straight (claude, the DEFAULT body, among them). A rig assets/opt also holds
 *  is listed here too, so [...rigs(), ...libraryRigs()] names it twice. Opt-in, so the ragdoll's measured baseline
 *  is not silently re-based; the reach suites take it. [] when the library is not on disk. */
export function libraryRigs(dir = process.env.EIDOVERSE_DIR
  ? `${process.env.EIDOVERSE_DIR}/eidoverse/assets/vrms/`
  : fileURLToPath(new URL('../../../eidoverse-video/eidoverse/assets/vrms/', import.meta.url))) {
  let names = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith('.vrm') && !n.endsWith('.ktx2.vrm')).sort(); }
  catch { return []; }
  const out = [];
  for (const f of names) {
    const name = f.replace('.vrm', '');
    let g;
    try { g = glbJson(readFileSync(dir + f)); } catch (e) { out.push({ name, err: e.message }); continue; }
    out.push(rigFromGltf(name, g));
  }
  return out;
}

/** One rig from a glTF JSON (a VRM's JSON chunk, or a skeleton fixture written by test/fixtures/rig-fixture.mjs). */
export function rigFromGltf(name, g) {
  let bones, wp;
  try { bones = humanBones(g); wp = worldPositions(g); } catch (e) { return { name, err: e.message }; }
  if (!bones) return { name, err: 'no humanoid extension' };
  const P = {};
  for (const [b, n] of Object.entries(bones)) if (g.nodes[n]) P[b] = wp(n);
  if (!P.hips) return { name, err: 'no hips bone' };
  const nodeOf = new Map(Object.entries(bones).map(([b, n]) => [n, b]));
  const up = new Map();
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => up.set(c, i)));
  const realParent = {};
  for (const [b, n] of Object.entries(bones)) {
    let a = up.get(n);
    while (a !== undefined && !nodeOf.has(a)) a = up.get(a);
    realParent[b] = a === undefined ? null : nodeOf.get(a);
  }
  return { name, P, realParent, vrm0: isVrm0(g), boneCount: Object.keys(P).length };
}

/** A rig's skeleton as the repo carries it (test/fixtures/<name>-rig.json), for a suite that must run without the
 *  avatar library on disk. Throws when there is no such fixture: a missing fixture is a broken checkout, not a skip. */
export function fixtureRig(name) {
  const g = JSON.parse(readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}-rig.json`, import.meta.url)), 'utf8'));
  return { ...rigFromGltf(name, g), fixture: true };
}

/** Every shipped rig, as { name, P } where P maps humanoid bone -> world rest
 *  position. A rig without a humanoid extension or without hips is returned
 *  as { name, err }, never dropped silently. */
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
    // the real parent chain: each humanoid bone's nearest humanoid ANCESTOR (on 6 of 14 shipped rigs leftUpperArm hangs
    // off leftShoulder, off upperChest), because the ragdoll's `d.parent` is whatever the rig says
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
    // a plausible mid-walk frame, about the RIG'S own axes: 6 of the 14 shipped rigs face -Z (VRM 0.x), and rotating
    // those about world X bent the knee forward into a pose no leg can reach
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

/** The lean goLimp actually passes: you fall the way you are facing, harder the faster you were moving. Tests must use
 *  this or they measure a path production never takes. */
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

/** Worst shaft-vs-shaft interpenetration among a ragdoll's own bone capsules, as a fraction of the separation they
 *  should have kept. Pairs that overlap in the rest pose are excluded, as the solver excludes them. */
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
