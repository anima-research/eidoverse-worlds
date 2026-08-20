// shared/reach.js — two-bone inverse kinematics, bounded by the joint limits
// the ragdoll already measures.
//
// Why analytic and not CCD/FABRIK: a shoulder-elbow-hand chain is two links,
// and two links have a closed form. Iterative solvers buy generality this
// chain does not need and pay for it in jitter (they converge differently from
// different starting poses) and in nondeterminism across clients — and in this
// world EVERY client solves the same reach independently, so two clients that
// iterate differently draw two different arms. A closed form is the same
// arm everywhere, every frame, with no starting-state memory.
//
// Why the limits come from ragdoll.js's tables (moved to shared/joints.js):
// an arm that can reach where it could never fall is two different bodies. The
// cone, the frontal-plane stop and the elbow hinge are MEASURED numbers with
// comments explaining what each one cost to find; this module is a consumer of
// them, never a second opinion.
//
// Pure: arrays of numbers in, arrays of numbers out. No three, no scene graph,
// no bone objects — the caller measures the skeleton and converts the answer
// back into rotations, because that conversion is renderer-shaped and this is
// not. (Same split as motioneval.js.)

// ---- the four vector ops this needs ---------------------------------------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : null; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Rodrigues: rotate `v` about unit `axis` by `ang` radians. */
export function rotateAbout(v, axis, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [
    v[0] * c + k[0] * s + axis[0] * d,
    v[1] * c + k[1] * s + axis[1] * d,
    v[2] * c + k[2] * s + axis[2] * d,
  ];
}

/** Turn `v` toward `axis` until it sits inside a cone of half-angle `half`
 *  (radians) about it. Returns v unchanged when it is already inside. */
export function clampToCone(v, axis, half) {
  const c = dot(v, axis);
  const cosHalf = Math.cos(half);
  if (c >= cosHalf) return { v, clamped: false };
  // The rotation plane is the one containing v and axis. Degenerate only when
  // v is exactly antiparallel to the axis, where every plane is equally valid
  // and there is no principled choice — pick one deterministically rather than
  // return NaN, so a body never explodes on a measure-zero input.
  let n = norm(cross(axis, v));
  if (!n) {
    const alt = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    n = norm(cross(axis, alt));
  }
  return { v: rotateAbout(axis, n, half), clamped: true };
}

/** Hold `v` in front of the body's frontal plane: its forward component may
 *  not fall below `minFwd`. Projects onto the plane and renormalizes. */
export function clampBehind(v, fwd, minFwd) {
  const f = dot(v, fwd);
  if (f >= minFwd) return { v, clamped: false };
  let planar = norm(sub(v, mul(fwd, f)));
  if (!planar) {
    // v is exactly ANTIPARALLEL to forward — straight out the back. There is
    // no planar component to keep, so every direction around the axis is
    // equally correct; pick one deterministically. Returning `fwd` here (the
    // obvious-looking fallback) is the one indefensible answer: it snaps a
    // limb reaching backwards to pointing fully FORWARDS, a 180° flip in one
    // frame. A fuzz over random targets never finds this — exact antiparallel
    // has measure zero — so it has to be reasoned about, not sampled.
    const alt = Math.abs(fwd[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    planar = norm(sub(alt, mul(fwd, dot(alt, fwd))));
    if (!planar) return { v, clamped: false };
  }
  const s = Math.sqrt(Math.max(0, 1 - minFwd * minFwd));
  return { v: add(mul(fwd, minFwd), mul(planar, s)), clamped: true };
}

/**
 * Solve a two-bone chain so the end effector reaches `target` as nearly as the
 * joints allow.
 *
 * Everything is world-space. Lengths come from the REST skeleton, never the
 * live one — the ragdoll learned that the hard way: measured against a moving
 * body, the same avatar gets different limits depending on which frame of the
 * walk cycle you asked on.
 *
 * @param {object} o
 * @param {number[]} o.root    shoulder (or hip) world position
 * @param {number[]} o.target  where the hand (or foot) is wanted
 * @param {number} o.L1        rest length root->mid
 * @param {number} o.L2        rest length mid->end
 * @param {number[]} o.pole    world-space hint for which way the elbow points
 * @param {number[]} [o.fwd]   body forward axis, for the frontal-plane stop
 * @param {number[]} [o.coneAxis] cone axis in WORLD space (already lifted out
 *        of body-frame coords by the caller — see joints.js coneAxisWorld)
 * @param {object} [o.limits]  { coneHalf, behind, maxFlex, minFlex } radians
 * @returns {{ok: true, upper: number[], lower: number[], elbow: number[],
 *            hand: number[], reached: boolean, gap: number,
 *            bound: string[], flex: number}
 *          | {ok: false, why: string}}
 */
export function solveTwoBone(o) {
  const { root, target, L1, L2 } = o;
  if (!(L1 > 1e-6) || !(L2 > 1e-6)) return { ok: false, why: 'bone lengths must be positive' };
  const to = sub(target, root);
  const d0 = len(to);
  if (d0 < 1e-6) return { ok: false, why: 'target sits on the joint itself' };

  const lim = o.limits ?? {};
  const bound = [];
  let aim = mul(to, 1 / d0);

  // ---- where the limb may POINT (cone about its rest direction, then the
  // frontal-plane stop). Applied cone-behind-cone: the frontal clamp can push
  // a direction back out of the cone, and one re-pass returns it without the
  // open-ended loop an iterative solver would need. If it is still outside
  // after that, say so rather than pretend.
  const applyCone = () => {
    if (o.coneAxis && lim.coneHalf != null) {
      const r = clampToCone(aim, o.coneAxis, lim.coneHalf);
      aim = r.v;
      return r.clamped;
    }
    return false;
  };
  if (applyCone()) bound.push('cone');
  if (o.fwd && lim.behind != null) {
    const r = clampBehind(aim, o.fwd, -Math.sin(lim.behind));
    aim = r.v;
    if (r.clamped) {
      bound.push('behind');
      if (applyCone() && !bound.includes('cone')) bound.push('cone');
    }
  }

  // ---- how far along that direction the hand can get.
  // The triangle closes only for |L1-L2| <= d <= L1+L2; outside it the arm is
  // either straight (too far) or folded as tight as the elbow allows (too
  // near). EPS keeps the law of cosines off its singular ends, where acos
  // loses all its precision.
  const EPS = 1e-6;
  let d = clamp(d0, Math.abs(L1 - L2) + EPS, L1 + L2 - EPS);
  if (d < d0) bound.push('reach');

  // elbow interior angle, then the fold as a joint sees it
  let interior = Math.acos(clamp((L1 * L1 + L2 * L2 - d * d) / (2 * L1 * L2), -1, 1));
  let flex = Math.PI - interior;
  const maxFlex = lim.maxFlex ?? Math.PI;
  const minFlex = lim.minFlex ?? 0;
  if (flex > maxFlex || flex < minFlex) {
    flex = clamp(flex, minFlex, maxFlex);
    bound.push('hinge');
    // A clamped elbow CHANGES how far the hand can be from the shoulder, so
    // the triangle has to be rebuilt from the angle rather than the distance.
    // Skipping this is the classic two-bone bug: the elbow obeys its limit and
    // the hand teleports to the target anyway, stretching the forearm.
    interior = Math.PI - flex;
    d = Math.sqrt(Math.max(EPS, L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(interior)));
  }

  // ---- the plane the arm bends in, chosen by the pole hint
  let poleDir = o.pole ? norm(sub(o.pole, mul(aim, dot(o.pole, aim)))) : null;
  if (!poleDir) {
    // No usable hint (or a hint parallel to the aim): fall back to something
    // deterministic and anatomically sane rather than an arbitrary axis.
    const alt = o.fwd ? mul(o.fwd, -1) : [0, -1, 0];
    poleDir = norm(sub(alt, mul(aim, dot(alt, aim))))
      ?? norm(sub([0, -1, 0], mul(aim, dot([0, -1, 0], aim))))
      ?? [0, 0, 1];
  }
  const axis = norm(cross(aim, poleDir));
  if (!axis) return { ok: false, why: 'cannot resolve a bend plane' };

  // shoulder angle between the upper bone and the root->hand line
  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));

  const upper = rotateAbout(aim, axis, alpha);
  const elbow = add(root, mul(upper, L1));
  const hand = add(root, mul(aim, d));
  const lower = norm(sub(hand, elbow)) ?? [...upper];

  const gap = len(sub(target, hand));
  return {
    ok: true, upper, lower, elbow, hand,
    reached: gap <= 1e-4, gap, bound, flex,
  };
}
