// reachbone — the frame algebra between a target in the world and two bone
// rotations. Split out of avatar.js so it can be TESTED: avatar.js's import
// cone reaches the whole client (assets, voice, renderer) and will not load
// headless, and geometry that cannot be run against the shipped rigs is
// geometry nobody has checked.
//
// What stays in avatar.js is the bookkeeping — weight ramps, compose guards,
// which layer owns which bone — because that is structurally the same as the
// held-pose path already there. What lives here is the part that can be
// silently, plausibly wrong.

import { THREE } from './core.js';
import { solveTwoBone, solveTwoBoneClear, penetration, chainLocalQuats, qConj, qMulq, qRot } from '../../shared/reach.js';
import { bodyFrame, limitsFor, coneAxisBody, toBody, fromBody, REACH_CHAINS,
         torsoRadius, boneRadius, GUARD_SEGMENTS } from '../../shared/joints.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

const dirLen = (u, v) => {
  const w = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
  const l = Math.hypot(w[0], w[1], w[2]);
  return { l, u: l > 1e-9 ? [w[0] / l, w[1] / l, w[2] / l] : [1, 0, 0] };
};

/**
 * The fixed facts about one chain, measured once, in the avatar ROOT's local
 * frame — the frame in which the rest pose has identity rotations, which is
 * where shared/reach.js does its algebra.
 *
 * Measured from the REST skeleton, never the live one. The ragdoll learned
 * this the expensive way: measured against a moving body, the same avatar gets
 * different limits depending which frame of the walk cycle you asked on.
 */
export function measureChain(avatar, key) {
  const spec = REACH_CHAINS[key];
  const h = avatar?.vrm?.humanoid;
  if (!spec || !h) return null;
  const nodes = {
    upper: h.getNormalizedBoneNode(spec.root),
    lower: h.getNormalizedBoneNode(spec.mid),
    end: h.getNormalizedBoneNode(spec.end),
  };
  if (!nodes.upper || !nodes.lower || !nodes.end) return null;
  // The conversion assumes the lower bone hangs directly off the upper one, so
  // that its local rotation is exactly what is left after the upper's. On a
  // normalized VRM rig that holds; refuse loudly rather than draw a wrong arm
  // if some rig ever says otherwise.
  if (nodes.lower.parent !== nodes.upper) return null;

  const restW = avatar.restBonePositions();
  if (!restW) return null;
  const P = {};
  for (const [n, v] of Object.entries(restW)) P[n] = avatar.root.worldToLocal(v.clone()).toArray();
  const F = bodyFrame(P);
  const a = P[spec.root], b = P[spec.mid], c = P[spec.end];
  if (!F || !a || !b || !c) return null;

  const up = dirLen(a, b), lo = dirLen(b, c);
  if (!(up.l > 1e-5) || !(lo.l > 1e-5)) return null;
  const lim = limitsFor(spec.root);

  // ---- what this limb must not pass through.
  //
  // Thicknesses are the ragdoll's measured model (torso radius from the wider
  // of shoulder/hip span, anatomical fractions per bone), so a reach and a
  // fall agree about how thick this body is.
  const torsoR = torsoRadius(P);
  const rUpper = boneRadius(spec.root, torsoR);
  const rLower = boneRadius(spec.mid, torsoR);
  const own = new Set([spec.root, spec.mid, spec.end]);
  const guards = [];
  for (const [ga, gb] of GUARD_SEGMENTS) {
    if (own.has(ga) || own.has(gb)) continue;          // a limb cannot hit itself
    const na = h.getNormalizedBoneNode(ga), nb = h.getNormalizedBoneNode(gb);
    if (!na || !nb || !P[ga] || !P[gb]) continue;
    const g = { na, nb, r: (boneRadius(ga, torsoR) + boneRadius(gb, torsoR)) / 2 };
    // Drop anything already overlapping at REST. A shoulder sits inside the
    // chest capsule on most rigs; guarding against it would report the arm as
    // permanently stuck in the body and swivel forever chasing a clearance
    // that never existed. Same rule the ragdoll applies when building pairs.
    const restPen = penetration(a, b, c, rUpper, rLower, [{ a: P[ga], b: P[gb], r: g.r }]);
    if (restPen > 0) continue;
    guards.push(g);
  }

  return {
    key, spec, nodes, L1: up.l, L2: lo.l, dRestU: up.u, dRestL: lo.u, lim,
    fwd: F.f, rUpper, rLower, guards,
    coneAxis: fromBody(coneAxisBody(toBody(up.u, F), lim.coneTilt ?? 0), F),
  };
}

/**
 * Solve one chain for a world-space target, at this instant.
 *
 * Everything the shoulder's limits are stated against is carried by the bone's
 * PARENT, which the locomotion clip rotates every frame — so the cone, the
 * frontal plane and the rest direction are all read live through it. A version
 * that used the rest frame instead is correct in T-pose and drifts as soon as
 * the torso turns.
 *
 * @param {object} chain from measureChain
 * @param {object} avatar needs .root
 * @param {number[]} targetWorld
 * @param {number[]|null} poleHint previous elbow offset, for continuity
 */
export function solveChain(chain, avatar, targetWorld, poleHint = null) {
  const root = avatar.root;
  const qRootInv = qConj(root.getWorldQuaternion(_q).toArray());
  const target = root.worldToLocal(_v.set(targetWorld[0], targetWorld[1], targetWorld[2])).toArray();
  const shoulder = root.worldToLocal(chain.nodes.upper.getWorldPosition(_v2)).toArray();
  const qParent = qMulq(qRootInv, chain.nodes.upper.parent.getWorldQuaternion(_q2).toArray());

  // guards, live and in the same frame the solve happens in — the torso moves
  const guards = [];
  for (const g of chain.guards ?? []) {
    guards.push({
      a: root.worldToLocal(g.na.getWorldPosition(_v3)).toArray(),
      b: root.worldToLocal(g.nb.getWorldPosition(_v4)).toArray(),
      r: g.r,
    });
  }

  const res = solveTwoBoneClear({
    root: shoulder, target, L1: chain.L1, L2: chain.L2,
    rUpper: chain.rUpper, rLower: chain.rLower,
    // last frame's elbow keeps the bend plane continuous, so a target swinging
    // past the shoulder does not flip the elbow inside out mid-reach
    pole: poleHint ?? qRot(qParent, chain.dRestU),
    fwd: qRot(qParent, chain.fwd),
    coneAxis: qRot(qParent, chain.coneAxis),
    limits: { coneHalf: chain.lim.coneHalf, behind: chain.lim.behind, maxFlex: chain.lim.maxFlex },
  }, guards);
  if (!res.ok) return { ok: false, why: res.why };

  const q = chainLocalQuats(chain.dRestU, chain.dRestL, res.upper, res.lower, qParent);
  return {
    ok: true, res, upper: q.upper, lower: q.lower,
    swivel: res.swivel ?? 0, penetration: res.penetration ?? 0,
    elbowOffset: [res.elbow[0] - shoulder[0], res.elbow[1] - shoulder[1], res.elbow[2] - shoulder[2]],
  };
}
