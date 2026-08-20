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
import { THREE } from './core-stub.mjs';

export const VRM_DIR = fileURLToPath(new URL('../assets/opt/eidoverse/assets/vrms/', import.meta.url));

/** The JSON chunk of a .glb / .vrm. */
export function glbJson(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

/** humanoid bone name -> node index, for VRM 0.x and 1.0 alike. */
export function humanBones(g) {
  const v1 = g.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) return Object.fromEntries(Object.entries(v1).map(([b, v]) => [b, v.node]));
  const v0 = g.extensions?.VRM?.humanoid?.humanBones;
  if (v0) return Object.fromEntries(v0.map((h) => [h.bone, h.node]));
  return null;
}

/** World rest position of any node, by walking the TRS tree. */
export function worldPositions(g) {
  const parent = new Map();
  g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
  const memo = new Map();
  // Full matrices, because SCALE is load-bearing here. Composing only
  // translation and rotation (and reading a matrix node's translation column
  // while dropping its basis) silently drops any scale on an ancestor — and
  // glb2vrm bakes a uniform scale on the Armature to bring a ~1m Tripo export
  // to human height, so mythospaint's armature carries 1.651. The headless
  // skeleton came out 0.86m tall while the browser rendered her at 1.65m.
  // Bone quaternions are scale-free, so limbs still looked right and nothing
  // complained; only the streamed ROOT was in the small frame, which put her
  // ~0.46m — a foot and a half — above the floor for everyone watching.
  const localMatrix = (n) => (n.matrix
    ? new THREE.Matrix4().fromArray(n.matrix)
    : new THREE.Matrix4().compose(
      new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
      new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
      new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
    ));
  const world = (i) => {
    if (memo.has(i)) return memo.get(i);
    const m = localMatrix(g.nodes[i]);
    const p = parent.get(i);
    const out = p === undefined ? m : world(p).clone().multiply(m);
    memo.set(i, out);
    return out;
  };
  return (i) => new THREE.Vector3().setFromMatrixPosition(world(i));
}

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
  try { names = readdirSync(dir).filter((n) => n.endsWith('.vrm')).sort(); }
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
    out.push({ name, P, realParent, boneCount: Object.keys(P).length });
  }
  return out;
}

export function rigs() {
  const out = [];
  for (const f of readdirSync(VRM_DIR).filter((n) => n.endsWith('.vrm')).sort()) {
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
    out.push({ name, P, realParent, boneCount: Object.keys(P).length });
  }
  return out;
}

// The humanoid parent chain the ragdoll's particle model assumes. Rigs that
// carry upperChest/shoulder collapse onto this: goLimp parks those bones at
// rest before the sim starts, which is what makes the span rigid.
export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/** A stand-in Avatar over a rig's rest positions: normalized bone nodes with
 *  identity rotations and local offsets equal to the world rest deltas, which
 *  is exactly what getNormalizedBoneNode hands back on a real VRM.
 *
 *  `stride` fakes having fallen mid-walk by rotating a few bones before the
 *  sim ever sees the skeleton — the case that used to poison the sim's idea of
 *  "rest". restBonePositions() still reports the NEUTRAL pose, as the real
 *  Avatar does, so a test can prove the two are decoupled. */
export function makeAvatar(P, { stride = 0, realParent = null } = {}) {
  const root = new THREE.Object3D();
  const nodes = {};
  // `realParent` builds the rig's ACTUAL humanoid hierarchy — upperChest,
  // shoulders and all — so `d.parent` is the node the shipped rig would give.
  // Without it every rig is tested as though it were one of the simple ones.
  const par = realParent ?? PARENT;
  const order = Object.keys(realParent ? P : PARENT).filter((j) => P[j]);
  const depth = (j) => { let d = 0, k = j; while (par[k]) { k = par[k]; if (++d > 40) break; } return d; };
  order.sort((a, b) => depth(a) - depth(b));
  for (const j of order) {
    const n = new THREE.Object3D();
    n.name = j;
    const p = par[j];
    const base = p && P[p] ? P[p] : new THREE.Vector3(0, 0, 0);
    n.position.copy(P[j]).sub(base);
    ((p && nodes[p]) ? nodes[p] : root).add(n);
    nodes[j] = n;
  }
  root.updateMatrixWorld(true);

  const av = {
    root, nodes, poses: 0, limp: false,
    vrm: { humanoid: {
      humanBones: Object.fromEntries(Object.keys(nodes).map((k) => [k, {}])),
      getNormalizedBoneNode: (j) => nodes[j] ?? null,
    } },
    setPose() { this.poses++; },
    clearPose() {},
    setLimp(on) { this.limp = !!on; },
    restBonePositions() {
      const saved = Object.values(nodes).map((n) => [n, n.quaternion.clone()]);
      for (const [n] of saved) n.quaternion.identity();
      root.updateMatrixWorld(true);
      const out = {};
      for (const [k, n] of Object.entries(nodes)) out[k] = n.getWorldPosition(new THREE.Vector3());
      for (const [n, q] of saved) n.quaternion.copy(q);
      root.updateMatrixWorld(true);
      return out;
    },
  };

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
