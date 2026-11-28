// reachbone — the frame algebra from a world target to two bone rotations. Kept out of avatar.js so it loads
// headless and tests against the shipped rigs; avatar.js keeps the bookkeeping (weight ramps, bone ownership).

import { THREE } from '../core.js';
import { solveTwoBone, solveTwoBoneClear, penetration, chainLocalQuats, orientPalm,
         qConj, qMulq, qRot } from '../../../shared/reach.js';
import { bodyFrame, limitsFor, coneAxisBody, toBody, fromBody, REACH_CHAINS,
         torsoRadius, boneRadius, GUARD_SEGMENTS } from '../../../shared/joints.js';
import { torsoHalfDepth, derivePalmAnchor } from './landmarks.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _nbW = new THREE.Vector3();

/** The spine column: the guards that are elliptical rather than round. */
const TORSO_COLUMN = new Set(['hips', 'spine', 'chest', 'neck', 'head']);

const dirLen = (u, v) => {
  const w = [v[0] - u[0], v[1] - u[1], v[2] - u[2]];
  const l = Math.hypot(w[0], w[1], w[2]);
  return { l, u: l > 1e-9 ? [w[0] / l, w[1] / l, w[2] / l] : [1, 0, 0] };
};

/** Which way the palm faces at rest, in the avatar root's frame: the palm plane's normal (wrist->middle x
 *  little->index) where the rig has finger bones, else the VRM T-pose convention (palms down). */
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

/** Each chain bone's orientation, and its parent's, in the avatar root's frame with the rig held at rest
 *  (as restBonePositions does: identity every humanoid rotation, look, put it all back). */
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

/** The fixed facts about one chain, measured once from the REST skeleton in the avatar root's local frame (where
 *  shared/reach.js does its algebra); off the live body the limits would depend on the walk cycle's frame. */
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
  // the conversion assumes the lower bone hangs directly off the upper one; refuse rather than draw a wrong arm
  if (nodes.lower.parent !== nodes.upper) return null;

  // rest orientations too, not just positions: rest is not identity on Mixamo-derived rigs (assuming it reaches the mirror image)
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

  // what this limb must not pass through: the ragdoll's thickness model, so a reach and a fall agree
  const torsoR = torsoRadius(P);
  // torsoRadius is a half-WIDTH; as the depth it would read a forearm in front of the belly as inside. Measure the
  // half-depth off the mesh, or (headless) use the ratio real bodies show.
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
    // drop guards already overlapping at rest (a shoulder sits inside the chest capsule on most rigs), as the ragdoll does
    const restPen = penetration(a, b, c, rUpper, rLower, [{ a: P[ga], b: P[gb], r: g.r }]);
    if (restPen > 0) continue;
    guards.push(g);
  }

  const side = spec.root.startsWith('left') ? 'left' : 'right';
  const palmAnchor = spec.end.endsWith('Hand') ? derivePalmAnchor(avatar, side) : null;
  const palmScale = nodes.end.getWorldScale(new THREE.Vector3())
    .divide(avatar.root.getWorldScale(new THREE.Vector3()));
  return {
    palmOffset: palmAnchor?.offset.clone().multiply(palmScale).toArray() ?? null,
    key, spec, nodes, L1: up.l, L2: lo.l, dRestU: up.u, dRestL: lo.u, lim,
    fwd: F.f, up: F.u, right: F.r, rUpper, rLower, guards, restQ, halfDepth,
    palmRest: palmAnchor ? qRot(restQ.qH, palmAnchor.normal.toArray()) : palmRestNormal(P, F, side),
    // toward the midline from THIS shoulder: the rest direction points outward, so the midline is the other way
    inward: (() => { const sg = Math.sign(up.u[0] * F.r[0] + up.u[1] * F.r[1] + up.u[2] * F.r[2]) || 1;
                     return [-sg * F.r[0], -sg * F.r[1], -sg * F.r[2]]; })(),
    coneAxis: fromBody(coneAxisBody(toBody(up.u, F), lim.coneTilt ?? 0), F),
  };
}

/**
 * Solve one chain for a world-space target, at this instant. The shoulder's limits are read live through the
 * bone's parent, which the locomotion clip rotates every frame; the rest frame is only right in T-pose.
 * @param {object} chain from measureChain
 * @param {object} avatar needs .root
 * @param {number[]} targetWorld
 * @param {number[]|null} poleHint previous elbow offset, for continuity
 */
export function solveChain(chain, avatar, targetWorld, poleHint = null, opts = {}) {
  if (!opts.palm || !chain.palmOffset) return solveWristChain(chain, avatar, targetWorld, poleHint, opts);
  const target = avatar.root.worldToLocal(new THREE.Vector3(...targetWorld));
  let wrist = target.clone(), best = null;
  // wrist orientation changes the palm offset: re-solve a bounded number of times from the same target (no drift)
  for (let i = 0; i < 5; i++) {
    const world = avatar.root.localToWorld(wrist.clone()).toArray();
    const out = solveWristChain(chain, avatar, world, poleHint, opts);
    if (!out.ok) return best ?? out;
    const offset = new THREE.Vector3(...qRot(out.handFrame, chain.palmOffset));
    const contact = new THREE.Vector3(...out.res.hand).add(offset);
    const gap = avatar.root.localToWorld(contact.clone()).distanceTo(new THREE.Vector3(...targetWorld));
    out.res = { ...out.res, gap };
    out.contact = contact.toArray();
    if (!best || gap < best.res.gap) best = out;
    if (gap < 0.001) break;
    wrist.lerp(target.clone().sub(offset), 0.6);
  }
  return best;
}

function solveWristChain(chain, avatar, targetWorld, poleHint = null, opts = {}) {
  const palmWant = opts.palm ?? null;
  const root = avatar.root;
  const qRootInv = qConj(root.getWorldQuaternion(_q).toArray());
  const target = root.worldToLocal(_v.set(targetWorld[0], targetWorld[1], targetWorld[2])).toArray();
  const shoulder = root.worldToLocal(chain.nodes.upper.getWorldPosition(_v2)).toArray();
  const qParentNow = qMulq(qRootInv, chain.nodes.upper.parent.getWorldQuaternion(_q2).toArray());
  // rest measurements are carried by how far the parent has TURNED since rest, not its absolute orientation
  const qParent = qMulq(qParentNow, qConj(chain.restQ.qP));

  // guards, live and in the same frame the solve happens in — the torso moves
  const guards = [];
  for (const g of chain.guards ?? []) {
    guards.push({
      a: root.worldToLocal(g.na.getWorldPosition(_v3)).toArray(),
      b: root.worldToLocal(g.nb.getWorldPosition(_nbW)).toArray(),
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
    lastElbow: poleHint, lastGap: opts.lastGap,
    root: shoulder, target, L1: chain.L1, L2: chain.L2,
    rUpper: chain.rUpper, rLower: chain.rLower,
    // pole: the rest direction carried by the parent (never last frame's elbow: the solve fed on its own output),
    // or the caller's hint (a socket's reach.hint) seen from the shoulder
    pole: (() => { const hw = opts.hintWorld; if (!hw) return qRot(qParent, chain.dRestU);
      const h = root.worldToLocal(_v3.set(hw[0], hw[1], hw[2])).toArray(); const d = [h[0] - shoulder[0], h[1] - shoulder[1], h[2] - shoulder[2]];
      const n = Math.hypot(...d); return n > 1e-6 ? d.map((x) => x / n) : qRot(qParent, chain.dRestU); })(),
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

  // palm: face what is being touched, only when the caller says which way (otherwise it would fight the clip)
  let lower = q.lower, hand = null, handFrame = null, palmResidual = null, palmTwist = null;
  if (palmWant) {
    const op = orientPalm({
      lowerFrame: q.lowerFrame, dLower: res.lower, palmRest: chain.palmRest,
      qL0: chain.restQ.qL, qH0: chain.restQ.qH,
      // world normal into the root's frame, like everything else here
      want: qRot(qRootInv, palmWant.dir), twistMax: chain.lim.foreTwistMax,
      lastTwist: opts.lastTwist, lastWrist: opts.lastWrist, dt: opts.dt,
    });
    lower = qMulq(qConj(q.upperFrame), op.lowerFrame);
    hand = op.handLocal;
    handFrame = qMulq(op.lowerFrame, hand);
    palmResidual = op.residualDeg;
    palmTwist = op.twist;
  }
  return {
    ok: true, res, upper: q.upper, lower, hand, handFrame, palmResidual, palmTwist, pick: res.pick ?? null,
    swivelUsed: res.swivel ?? 0,
    swivel: res.swivel ?? 0, penetration: res.penetration ?? 0,
    elbowOffset: [res.elbow[0] - shoulder[0], res.elbow[1] - shoulder[1], res.elbow[2] - shoulder[2]],
  };
}
