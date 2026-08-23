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
import { solveTwoBone, solveTwoBoneClear, penetration, chainLocalQuats, orientPalm,
         qConj, qMulq, qRot } from '../../shared/reach.js';
import { bodyFrame, limitsFor, coneAxisBody, toBody, fromBody, REACH_CHAINS,
         torsoRadius, boneRadius, GUARD_SEGMENTS } from '../../shared/joints.js';
import { torsoHalfDepth } from './landmarks.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

/** The spine column: the guards that are elliptical rather than round. */
const TORSO_COLUMN = new Set(['hips', 'spine', 'chest', 'neck', 'head']);

const dirLen = (u, v) => {
  const w = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
  const l = Math.hypot(w[0], w[1], w[2]);
  return { l, u: l > 1e-9 ? [w[0] / l, w[1] / l, w[2] / l] : [1, 0, 0] };
};

/**
 * Which way the palm faces, in the avatar root's frame with the rig at rest.
 *
 * Derived from the finger bones where a rig has them: the palm plane is
 * spanned by wrist->middle and little->index, and its normal is their cross
 * product. Only 8 of the 18 shipped rigs carry fingers, though — claude, the
 * default body, does not — so the rest fall back to the VRM rest convention,
 * a T-pose with the palms facing DOWN.
 *
 * That fallback is not an assumption anyone has to take on trust: on every one
 * of the nine rigs that CAN answer, the derived normal agrees with it to
 * within a hundredth (dot with body-up = 0.99-1.00, across VRM0 and VRM1
 * alike). The convention is checked wherever checking is possible, and used
 * only where it is not.
 */
function palmRestNormal(P, F, side) {
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const n3 = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : null; };
  const hand = P[side + 'Hand'], mid = P[side + 'MiddleProximal'];
  const idx = P[side + 'IndexProximal'], lit = P[side + 'LittleProximal'];
  if (hand && mid && idx && lit) {
    const along = n3(sub3(mid, hand)), across = n3(sub3(idx, lit));
    if (along && across) {
      const back = n3(cross3(along, across));
      // that construction points out the BACK of the hand; the palm is opposite
      if (back) return [-back[0], -back[1], -back[2]];
    }
  }
  return [-F.u[0], -F.u[1], -F.u[2]];
}

/** Each chain bone's orientation, and its parent's, in the avatar root's frame
 *  with the rig held at rest. Measured the same way restBonePositions does:
 *  identity every humanoid rotation, look, put it all back. */
function restOrientations(avatar, nodes) {
  const h = avatar?.vrm?.humanoid;
  if (!h) return null;
  const saved = [];
  for (const name of Object.keys(h.humanBones ?? {})) {
    const n = h.getNormalizedBoneNode(name);
    if (n) { saved.push([n, n.quaternion.clone()]); n.quaternion.identity(); }
  }
  avatar.root.updateMatrixWorld(true);
  const inv = avatar.root.getWorldQuaternion(_q).clone().invert();
  const rel = (node) => node.getWorldQuaternion(_q2).premultiply(inv).toArray();
  const out = {
    qU: rel(nodes.upper),
    qL: rel(nodes.lower),
    qH: rel(nodes.end),
    qP: rel(nodes.upper.parent),
  };
  for (const [n, q] of saved) n.quaternion.copy(q);
  avatar.root.updateMatrixWorld(true);
  return out;
}

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

  // The bones' REST ORIENTATIONS in the root's frame, not just their rest
  // positions. Assuming rest is identity here is true on many rigs and false
  // on any Mixamo-derived one (orion's normalized hierarchy sits 180° from
  // the root), and the failure is silent: the solver's own arithmetic stays
  // self-consistent while the actual arm reaches the mirror image.
  const restQ = restOrientations(avatar, nodes);
  const restW = avatar.restBonePositions();
  if (!restW || !restQ) return null;
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
  // How much thinner this body is front-to-back than side-to-side, MEASURED
  // off its own mesh rather than assumed. torsoRadius is a half-width; using
  // it as the half-depth too is what makes a forearm crossing in front of the
  // belly read as inside it. Falls back to round if the mesh cannot answer —
  // no worse than before, and it says so by simply not warping.
  // Measured off the mesh where there IS one. A headless stand-in has no mesh,
  // and falling back to "round" there makes the harness strictly harsher than
  // the browser — every folded pose reads as penetrating and a search for a
  // clear one finds nothing, which is not a fact about the body but about the
  // test rig. The fallback is the ratio the real bodies actually show
  // (claude 111/150 = 0.74, orion 115/150 = 0.77).
  const DEPTH_RATIO_FALLBACK = 0.75;
  const measured = torsoHalfDepth(avatar);
  const halfDepth = (measured && measured > 1e-3) ? measured : torsoR * DEPTH_RATIO_FALLBACK;
  const warpK = halfDepth > 1e-3 ? Math.max(1, torsoR / halfDepth) : null;
  const rUpper = boneRadius(spec.root, torsoR);
  const rLower = boneRadius(spec.mid, torsoR);
  const own = new Set([spec.root, spec.mid, spec.end]);
  const guards = [];
  for (const [ga, gb] of GUARD_SEGMENTS) {
    if (own.has(ga) || own.has(gb)) continue;          // a limb cannot hit itself
    const na = h.getNormalizedBoneNode(ga), nb = h.getNormalizedBoneNode(gb);
    if (!na || !nb || !P[ga] || !P[gb]) continue;
    const torsoCol = TORSO_COLUMN.has(ga) && TORSO_COLUMN.has(gb);
    const g = { na, nb, r: (boneRadius(ga, torsoR) + boneRadius(gb, torsoR)) / 2,
                ...(torsoCol && warpK ? { warpK } : {}) };
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
    fwd: F.f, up: F.u, right: F.r, rUpper, rLower, guards, restQ, halfDepth,
    palmRest: palmRestNormal(P, F, spec.root.startsWith('left') ? 'left' : 'right'),
    // toward the body's midline from THIS shoulder: the rest direction points
    // laterally outward, so the midline is the other way along the body's
    // lateral axis
    inward: (() => { const sg = Math.sign(up.u[0] * F.r[0] + up.u[1] * F.r[1] + up.u[2] * F.r[2]) || 1;
                     return [-sg * F.r[0], -sg * F.r[1], -sg * F.r[2]]; })(),
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
export function solveChain(chain, avatar, targetWorld, poleHint = null, opts = {}) {
  const palmWant = opts.palm ?? null;
  const root = avatar.root;
  const qRootInv = qConj(root.getWorldQuaternion(_q).toArray());
  const target = root.worldToLocal(_v.set(targetWorld[0], targetWorld[1], targetWorld[2])).toArray();
  const shoulder = root.worldToLocal(chain.nodes.upper.getWorldPosition(_v2)).toArray();
  const qParentNow = qMulq(qRootInv, chain.nodes.upper.parent.getWorldQuaternion(_q2).toArray());
  // Everything measured at rest is carried into the current pose by how far
  // the parent has TURNED since rest — not by the parent's absolute
  // orientation, which is only the same thing when rest happens to be identity.
  const qParent = qMulq(qParentNow, qConj(chain.restQ.qP));

  // guards, live and in the same frame the solve happens in — the torso moves
  const guards = [];
  for (const g of chain.guards ?? []) {
    guards.push({
      a: root.worldToLocal(g.na.getWorldPosition(_v3)).toArray(),
      b: root.worldToLocal(g.nb.getWorldPosition(_v4)).toArray(),
      r: g.r,
      ...(g.warpK ? { warp: {
        r: qRot(qParent, chain.right), u: qRot(qParent, chain.up), f: qRot(qParent, chain.fwd),
        k: g.warpK,
      } } : {}),
    });
  }

  const res = solveTwoBoneClear({
    trace: opts.trace,
    lastPick: opts.lastPick ?? null,
    lastSwivel: opts.lastSwivel ?? null,
    root: shoulder, target, L1: chain.L1, L2: chain.L2,
    rUpper: chain.rUpper, rLower: chain.rLower,
    // The rest direction carried by the parent — a pure function of the
    // current pose. NOT last frame's elbow: threading that back in made the
    // solve depend on its own output and self-touch oscillated (see
    // solveTwoBoneClear). poleHint is accepted and ignored for callers that
    // still pass it.
    pole: qRot(qParent, chain.dRestU),
    fwd: qRot(qParent, chain.fwd),
    coneAxis: qRot(qParent, chain.coneAxis),
    inward: qRot(qParent, chain.inward),
    limits: { coneHalf: chain.lim.coneHalf, coneAcross: chain.lim.coneAcross,
              behind: chain.lim.behind, maxFlex: chain.lim.maxFlex,
              hingeDir: chain.lim.hingeDir },
  }, guards);
  if (!res.ok) return { ok: false, why: res.why };

  const q = chainLocalQuats(chain.dRestU, chain.dRestL, res.upper, res.lower,
    { ...chain.restQ, qPnow: qParentNow });

  // ---- and turn the palm to face what is being touched.
  //
  // Only when the caller says which way; a reach with no surface to meet has
  // no business inventing a wrist angle, and would only fight the clip.
  let lower = q.lower, hand = null, palmResidual = null;
  if (palmWant) {
    const op = orientPalm({
      lowerFrame: q.lowerFrame, dLower: res.lower, palmRest: chain.palmRest,
      qL0: chain.restQ.qL, qH0: chain.restQ.qH,
      // ⚠ INTO THE ROOT'S FRAME. Everything else here — the bones' rest
      // orientations, palmRest, the solved directions — lives in the avatar
      // root's local frame, while a surface normal arrives from the world. The
      // two agree exactly when the body's yaw is zero and drift apart as it
      // turns, which is why this looked perfect in every measurement taken on
      // a body facing down +Z and put the BACK of the hand on the hip as soon
      // as anyone turned around. The position was being converted two lines
      // up; the direction was not.
      want: qRot(qRootInv, palmWant.dir), twistMax: chain.lim.foreTwistMax,
    });
    lower = qMulq(qConj(q.upperFrame), op.lowerFrame);
    hand = op.handLocal;
    palmResidual = op.residualDeg;
  }
  return {
    ok: true, res, upper: q.upper, lower, hand, palmResidual, pick: res.pick ?? null,
    swivelUsed: res.swivel ?? 0,
    swivel: res.swivel ?? 0, penetration: res.penetration ?? 0,
    elbowOffset: [res.elbow[0] - shoulder[0], res.elbow[1] - shoulder[1], res.elbow[2] - shoulder[2]],
  };
}
