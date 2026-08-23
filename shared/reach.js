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
  const aim = mul(to, 1 / d0);

  // ---- the triangle: how far the hand can be, and how bent the elbow is.
  // The triangle closes only for |L1-L2| <= d <= L1+L2; outside it the arm is
  // either straight (too far) or folded as tight as the elbow allows. EPS
  // keeps the law of cosines off its singular ends, where acos loses all its
  // precision.
  const EPS = 1e-6;
  let d = clamp(d0, Math.abs(L1 - L2) + EPS, L1 + L2 - EPS);
  if (d < d0 - 1e-12) bound.push('reach');

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

  // ---- the bend plane, chosen by the pole hint
  let poleDir = o.pole ? norm(sub(o.pole, mul(aim, dot(o.pole, aim)))) : null;
  if (!poleDir) {
    // No usable hint (or one parallel to the aim): fall back to something
    // deterministic and anatomically sane rather than an arbitrary axis.
    const alt = o.fwd ? mul(o.fwd, -1) : [0, -1, 0];
    poleDir = norm(sub(alt, mul(aim, dot(alt, aim))))
      ?? norm(sub([0, -1, 0], mul(aim, dot([0, -1, 0], aim))))
      ?? [0, 0, 1];
  }
  const axis = norm(cross(aim, poleDir));
  if (!axis) return { ok: false, why: 'cannot resolve a bend plane' };

  const alpha = Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1));

  // ---- where the UPPER BONE may point.
  //
  // The cone and the frontal stop are properties of the SHOULDER, so they
  // constrain the upper bone's own direction — not the shoulder-to-target
  // line. Those differ by `alpha`, so clamping the aim (the convenient thing,
  // and what this did first) lets an aim well inside the cone still put the
  // actual arm outside it. Caught by a real rig at 84° behind the body on a
  // limit of 65°; the geometry suite never saw it because it was checking the
  // same wrong vector.
  //
  // Cone and half-space are two constraints whose intersection is not reached
  // by applying either once — each projection can leave the other violated —
  // so alternate them to a fixed point. Both sets are geodesically convex caps
  // here (half-angles under 90°), which is what makes alternating projection
  // converge instead of cycling. It is BOUNDED and then VERIFIED: if a pass
  // limit is hit without feasibility, that gets reported, not hidden.
  let upper = rotateAbout(aim, axis, alpha);
  let hitCone = false, hitBehind = false, hitBody = false;

  // ---- the shoulder's envelope is not a circle.
  //
  // One half-angle for every direction cannot say what a shoulder does: the
  // 85° that correctly stops it folding backwards over the spine also stops
  // the arm crossing the chest, and crossing the chest is most of what arms
  // do socially — folding, hugging, a hand on your own other shoulder. Same
  // shape of problem BEHIND solves for hips, same shape of answer: a second
  // number for one direction. `inward` points at the body's midline, and the
  // allowance opens smoothly with how much adduction the reach is ASKING for,
  // measured before anything is clamped (keying it off the clamped vector is
  // circular — the clamp is what stops the arm pointing inward, so it never
  // opens; that version moved the hand 6mm).
  const wantAdduction = o.inward ? clamp(dot(upper, o.inward), 0, 1) : 0;
  const coneHalfEff = (lim.coneAcross != null && o.inward)
    ? lim.coneHalf + (lim.coneAcross - lim.coneHalf) * wantAdduction
    : lim.coneHalf;

  // ---- and the torso is not a suggestion.
  //
  // Widening the envelope alone just moves the arm INTO the chest, because an
  // adducted upper bone points through the body (measured: clearance fell
  // 831/840 -> 693/840). The elbow swivel cannot rescue that — it moves the
  // elbow around the shoulder-hand axis, and the offending bone IS that axis.
  // So the torso pushes the UPPER BONE, as a projection in the same loop as
  // the joint limits: rotate the bone about the shoulder, just far enough to
  // lift its deepest point out of the capsule. An arm crossing the chest then
  // ends up in FRONT of it because that is where the geometry allows, not
  // because a constant said so.
  const pushOutOfBody = (v) => {
    if (!o.guards?.length) return { v, moved: false };
    const rU = o.rUpper ?? 0;
    let out = v, moved = false;
    for (const g of o.guards) {
      // The UPPER bone only, deliberately. Rotating the shoulder is the sole
      // lever here, and using it to resolve a FOREARM collision swings the
      // whole arm away rather than tucking the forearm: measured on orion,
      // reaching the opposite hip went from a 75mm gap to 512mm with the arm
      // beside the head. The forearm crossing in front of the belly is a real
      // pose that a spine-centred CAPSULE cannot represent — it is isotropic,
      // so a half-width becomes a half-depth and "in front of" reads as
      // "inside". Shrinking the column did not rescue it either. The forearm
      // therefore stays the swivel's business, and the honest fix is a torso
      // shape with a front to it.
      const min = g.r + rU * CONTACT;
      const w = g.warp;
      const elbow = add(root, mul(out, L1));
      const cc = segSegClosest(warpPt(root, w), warpPt(elbow, w), warpPt(g.a, w), warpPt(g.b, w));
      if (cc.d >= min) continue;
      const arm = sub(cc.c1, warpPt(root, w));
      const armLen = len(arm);
      if (armLen < 1e-4) continue;
      // the push direction is discovered in warped space and has to be carried
      // back, or the arm is shoved along an axis the body does not have
      const n = unwarpDir(norm(sub(cc.c1, cc.c2)) ?? [0, 0, 0], w);
      if (!n || !len(n)) continue;            // dead centre: no direction to push
      const ax = norm(cross(sub(elbow, root), n));
      if (!ax) continue;                      // already pushing along the bone
      const theta = Math.min(0.6, (min - cc.d) / Math.max(armLen, 1e-4));
      out = norm(rotateAbout(out, ax, theta)) ?? out;
      moved = true;
    }
    return { v: out, moved };
  };


  if ((o.coneAxis && lim.coneHalf != null) || (o.fwd && lim.behind != null) || o.guards?.length) {
    const minFwd = lim.behind != null ? -Math.sin(lim.behind) : null;
    let feasible = false;
    for (let pass = 0; pass < 24; pass++) {
      let moved = false;
      if (o.coneAxis && lim.coneHalf != null) {
        const c = clampToCone(upper, o.coneAxis, coneHalfEff);
        if (c.clamped) { upper = c.v; moved = true; hitCone = true; }
      }
      if (o.fwd && minFwd != null) {
        const b = clampBehind(upper, o.fwd, minFwd);
        if (b.clamped) { upper = b.v; moved = true; hitBehind = true; }
      }
      const p = pushOutOfBody(upper);
      if (p.moved) { upper = p.v; moved = true; hitBody = true; }
      if (!moved) { feasible = true; break; }
    }
    // Report what is binding AT THE FIXED POINT, not what fired on the way
    // there. Alternating projection can touch the cone in an early pass and
    // then be carried clear of it by the frontal stop — saying "cone" then is
    // a caller reading a limit as active when the arm is nowhere near it, and
    // the whole point of this list is that a caller can trust it enough to
    // fall back on. Measured on a real rig: 'cone' reported at 0.423 against a
    // boundary of 0.087.
    const onBoundary = (v, ref, want) => Math.abs(dot(v, ref) - want) < 1e-6;
    if (hitCone && o.coneAxis && onBoundary(upper, o.coneAxis, Math.cos(coneHalfEff))) bound.push('cone');
    if (hitBehind && o.fwd && onBoundary(upper, o.fwd, minFwd)) bound.push('behind');
    if (hitBody) bound.push('body');
    if (!feasible) bound.push('infeasible');
  }

  // ---- the forearm: aim it at the target from wherever the elbow ended up,
  // then let the hinge have the last word. When nothing above bound, this
  // reproduces the analytic triangle exactly and the hand lands on target.
  const elbow = add(root, mul(upper, L1));
  const toTargetFromElbow = sub(target, elbow);
  let lower = norm(toTargetFromElbow) ?? [...upper];
  const back = mul(upper, -1);
  const inter = Math.acos(clamp(dot(back, lower), -1, 1));   // elbow interior angle
  const wantInter = clamp(inter, Math.PI - maxFlex, Math.PI - minFlex);
  if (Math.abs(wantInter - inter) > 1e-12) {
    if (!bound.includes('hinge')) bound.push('hinge');
    const n = norm(cross(back, lower)) ?? axis;
    lower = rotateAbout(back, n, wantInter);
  }
  const hand = add(elbow, mul(lower, L2));

  const gap = len(sub(target, hand));
  return {
    ok: true, upper, lower, elbow, hand,
    reached: gap <= 1e-4, gap, bound, flex,
  };
}

// ---- directions -> bone rotations ------------------------------------------
//
// A VRM's NORMALIZED humanoid rig has every bone's rest rotation identity, so
// in the rest pose every normalized bone's world rotation is identity too.
// That is what makes this conversion three lines instead of a frame algebra:
// the rotation a bone needs IS the rotation taking its rest direction to its
// wanted one, and a child only has to subtract its parent's.
//
// Minimal-arc (setFromUnitVectors) leaves roll about the bone's own axis at
// zero, which is the same swing construction the ragdoll uses, and the right
// default: position IK does not determine twist — a two-bone chain's spare
// degree of freedom is the POLE, and twist belongs to whoever aims the hand.

/** Quaternion (x,y,z,w) taking unit `a` to unit `b`, by the shortest arc. */
export function qFromUnitVectors(a, b) {
  let w = 1 + dot(a, b);
  if (w < 1e-8) {
    // antiparallel: any perpendicular axis is a valid 180° turn
    const alt = Math.abs(a[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const ax = norm(cross(a, alt)) ?? [0, 0, 1];
    return [ax[0], ax[1], ax[2], 0];
  }
  const c = cross(a, b);
  const l = Math.hypot(c[0], c[1], c[2], w) || 1;
  return [c[0] / l, c[1] / l, c[2] / l, w / l];
}

export const qMulq = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

export const qConj = (q) => [-q[0], -q[1], -q[2], q[3]];

/** Rotate a vector by a quaternion. */
export const qRot = (q, v) => {
  const [x, y, z, w] = q;
  const cx = y * v[2] - z * v[1] + w * v[0];
  const cy = z * v[0] - x * v[2] + w * v[1];
  const cz = x * v[1] - y * v[0] + w * v[2];
  return [
    v[0] + 2 * (y * cz - z * cy),
    v[1] + 2 * (z * cx - x * cz),
    v[2] + 2 * (x * cy - y * cx),
  ];
};

/**
 * Local rotations for a two-bone chain, given rest and wanted directions in
 * ONE common frame (the frame in which the rest pose has identity rotations —
 * i.e. the avatar root's local frame, not the world).
 *
 * @returns {{upper: number[], lower: number[]}} local quaternions, ready to
 *          write onto the normalized bone nodes.
 */
export function chainLocalQuats(dRestUpper, dRestLower, dWantUpper, dWantLower, rest = null) {
  // `rest` carries what the rig actually IS at rest, in the avatar root's
  // frame: qU/qL the two bones' rest orientations, qP the parent's. Passing
  // null keeps the old assumption — that rest is identity in root space —
  // which is true on many rigs and false on any Mixamo-derived one, where the
  // whole normalized hierarchy sits 180° from the root. Under that assumption
  // every rest direction is carried by an extra half-turn and the arm reaches
  // the mirror image of where it was sent: orion put its hand 0.35m ABOVE the
  // shoulder for a target 0.38m below it, while the solver's own arithmetic
  // reported a 34mm gap, because the maths was right and the frame was not.
  const qP0 = rest?.qP ?? [0, 0, 0, 1];
  const qU0 = rest?.qU ?? [0, 0, 0, 1];
  const qL0 = rest?.qL ?? [0, 0, 0, 1];
  const qPnow = rest?.qPnow ?? qP0;

  // how far the parent has turned since rest — the only thing that carries a
  // rest-frame direction into the current pose
  const dP = qMulq(qPnow, qConj(qP0));

  // upper: rest direction carried by the parent, then swung onto the target
  const restU = qRot(dP, dRestUpper);
  const U = qMulq(qFromUnitVectors(restU, dWantUpper), qMulq(dP, qU0));

  // lower: hangs off the upper, so its rest is carried by the upper's OWN
  // change since rest, not by the parent's
  const dU = qMulq(U, qConj(qU0));
  const restL = qRot(dU, dRestLower);
  const V = qMulq(qFromUnitVectors(restL, dWantLower), qMulq(dU, qL0));

  return {
    upper: qMulq(qConj(qPnow), U),
    lower: qMulq(qConj(U), V),
    upperFrame: U,
    lowerFrame: V,
  };
}


// ---- not through your own body ---------------------------------------------
//
// A two-bone chain has exactly one degree of freedom left once the hand is
// placed: the SWIVEL of the elbow around the shoulder-hand axis. That is the
// right knob for self-collision, because turning it moves the elbow without
// moving the hand at all — the arm comes out of the torso and still touches
// what it was asked to touch. Pushing the limb out bodily would clear the body
// too, and would break the one promise the reach makes.
//
// Thicknesses come from shared/joints.js, which is the ragdoll's measured
// model: a reach and a fall should disagree about nothing, least of all how
// thick this body is.

/** Squared distance between two segments, by the standard clamped-parameter
 *  method. Degenerate (zero-length) segments fall through to point cases. */
export function segSegClosest(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0; }
  else if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = add(p1, mul(d1, s)), c2 = add(p2, mul(d2, t));
  return { d: len(sub(c1, c2)), c1, c2 };
}

export function segSegDist(p1, q1, p2, q2) {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return len(sub(p1, p2));
  if (a <= 1e-12) { s = 0; t = clamp(f / e, 0, 1); }
  else {
    const c = dot(d1, r);
    if (e <= 1e-12) { t = 0; s = clamp(-c / a, 0, 1); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  return len(sub(add(p1, mul(d1, s)), add(p2, mul(d2, t))));
}

/** How far the solved limb is inside anything it should not be, in metres
 *  summed over every offending pair. Zero means clear. */
// How much of a limb's own thickness may sink into the body before it counts
// as penetrating. NOT 1.
//
// Requiring capsules to be fully separated means the upper arm must stay
// (torsoRadius + armRadius) from the SPINE AXIS — measured at 14-22cm on the
// shipped rigs, which is further than the body is wide. An arm hanging
// naturally against the side is then "penetrating" and gets pushed off, and
// anything that needs contact (a hand on your own hip) cannot be reached:
// measured, the guards alone cost 80-190mm of reach on hip_l, and 228 -> 41mm
// on msaligned. Real arms rest against real bodies.
//
// The artefact worth preventing is the limb passing THROUGH the body — its
// centreline crossing the interior. Its own radius overlapping the surface is
// contact, which is what touching IS. So most of the limb's radius is allowed
// to sink in, and the centreline is what must stay outside.
const CONTACT = 0.25;


// ---- bodies are not round ---------------------------------------------------
//
// A guard may carry a WARP: the body-frame basis it is elliptical in, plus how
// much thinner it is front-to-back than side-to-side. Distances are then
// measured in a space where that ellipse is a circle, which is the whole trick
// — scaling is linear, so segment-segment distance survives it, and the answer
// comes back meaning "is the arm inside the real shape" instead of "is the arm
// inside the cylinder that a half-width implies".
//
// Without it, torsoRadius (0.42x the wider of shoulder or hip span, a
// half-WIDTH) also becomes the half-depth, and a forearm crossing in FRONT of
// the belly reads as buried in it. That is not a tuning error; a capsule has
// no front.
const warpPt = (p, w) => (!w ? p : [
  dot(p, w.r), dot(p, w.u), dot(p, w.f) * w.k,
]);
/** Carry a direction measured in warped space back to the real one. */
const unwarpDir = (n, w) => {
  if (!w) return n;
  const v = [
    n[0] * w.r[0] + n[1] * w.u[0] + (n[2] / w.k) * w.f[0],
    n[0] * w.r[1] + n[1] * w.u[1] + (n[2] / w.k) * w.f[1],
    n[0] * w.r[2] + n[1] * w.u[2] + (n[2] / w.k) * w.f[2],
  ];
  return norm(v) ?? n;
};

export function penetration(root, elbow, hand, rUpper, rLower, guards) {
  let pen = 0;
  for (const g of guards) {
    const w = g.warp;
    const R = warpPt(root, w), E = warpPt(elbow, w), H = warpPt(hand, w);
    const A = warpPt(g.a, w), B = warpPt(g.b, w);
    const min1 = g.r + rUpper * CONTACT, min2 = g.r + rLower * CONTACT;
    const d1 = segSegDist(R, E, A, B);
    if (d1 < min1) pen += min1 - d1;
    const d2 = segSegDist(E, H, A, B);
    if (d2 < min2) pen += min2 - d2;
  }
  return pen;
}

/**
 * Cut the part of a guard that lies within `R` of the target, keeping the rest.
 *
 * You cannot touch a hip without putting your hand inside the hip's own
 * capsule, so something has to give near the target. DROPPING the whole guard
 * was the first answer and it is far too coarse: the torso is one long capsule
 * from hips to chest, a hand reaching the HIP is within R of its lower end, and
 * the entire column would vanish — after which the forearm passed straight
 * through the chest with the solver reporting zero penetration, because by then
 * there was nothing left to report. Measured on orion: forearm 3mm from the
 * spine where 162mm was required, and a clean bill of health.
 *
 * Clipping keeps every part of the body that is not where the hand is going.
 * The excluded span is one contiguous interval (a segment through a sphere),
 * so the remainder is at most two pieces.
 */
export function clipGuardNear(g, target, R) {
  const d = sub(g.b, g.a), m = sub(g.a, target);
  const A = dot(d, d);
  if (A < 1e-12) return segSegDist(target, target, g.a, g.b) < R ? [] : [g];
  const B = 2 * dot(m, d), C = dot(m, m) - R * R;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return [g];                       // never within R: keep whole
  const rt = Math.sqrt(disc);
  const s0 = (-B - rt) / (2 * A), s1 = (-B + rt) / (2 * A);
  const lo = clamp(s0, 0, 1), hi = clamp(s1, 0, 1);
  const out = [];
  if (lo > 1e-3) out.push({ ...g, b: add(g.a, mul(d, lo)) });
  if (hi < 1 - 1e-3) out.push({ ...g, a: add(g.a, mul(d, hi)) });
  return out;
}

const SWIVELS = (() => {
  // ordered by |angle|, so the FIRST clear one is the least departure from the
  // pose the pole hint asked for. Deterministic — every client sweeps the same
  // list in the same order and picks the same arm.
  const out = [0];
  for (let a = 10; a <= 170; a += 10) { out.push(a * Math.PI / 180, -a * Math.PI / 180); }
  return out;
})();

/**
 * Solve, and if the arm comes out inside the body, swivel the elbow until it
 * does not. Falls back to the least-bad swivel rather than refusing, because
 * an arm that is 2cm inside a hip still reads better than an arm that gave up.
 *
 * This is a PURE FUNCTION of (pose, target) — it keeps no memory of what it
 * chose last frame, and that is deliberate. The first version threaded the
 * previous elbow back in as the pole hint, which closed a loop: the solve
 * depended on its own output, the discrete swivel steps gave the loop
 * something to bounce between, and self-touch went into a limit cycle that
 * flipped the elbow on up to 54 frames out of 54. Same input, same arm, every
 * frame, no history — an oscillator needs state, so it does not get any.
 *
 * @param {object} o the same options solveTwoBone takes
 * @param {Array<{a:number[],b:number[],r:number}>} guards live segments to avoid
 */
export function solveTwoBoneClear(o, guards) {
  const rU = o.rUpper ?? 0, rL = o.rLower ?? 0;
  const lim = o.limits ?? {};
  // A pose sitting exactly ON the penetration boundary has its feasibility
  // flicker as the body breathes, and a latch cannot hold what keeps becoming
  // invalid: measured on princess0, the search alternated between a pose that
  // reached the target exactly and one 61mm short, every other frame, because
  // the good one kept crossing zero. A millimetre of tolerance is invisible on
  // screen and turns a knife edge into something a body can rest against.
  const CLEAR = 0.001;

  // Clip each guard where the hand is going, rather than dropping it: the
  // torso is ONE capsule from hips to chest, and deleting it because the
  // target sits inside its lower end leaves nothing to stop the forearm
  // crossing the chest.
  guards = (guards ?? []).flatMap((g) => clipGuardNear(g, o.target, g.r + rL * CONTACT));
  o = { ...o, guards };

  const root = o.root;
  const toTarget = sub(o.target, root);
  const reachDir = norm(toTarget);
  const fullDist = len(toTarget);

  // ---- best pose for ONE target: the least swivel that clears the body.
  // An elbow folds one way. The chord test is a PROXY for that, sound only
  // while the arm is not adducted — reach across your chest and the elbow
  // legitimately sits in front of the chord — so it is gated on how far across
  // the REACH is asking to go, and simply not applied where it cannot speak.
  const sideOf = (res, target) => {
    if (!o.fwd || !lim.hingeDir || !res?.ok) return 1;
    const chord = norm(sub(res.hand, root));
    if (!chord) return 1;
    const e = sub(res.elbow, root);
    const perp = sub(e, mul(chord, dot(e, chord)));
    const pl = len(perp);
    if (pl < 1e-4) return 1;                       // straight arm: no bend to judge
    return dot(mul(perp, 1 / pl), o.fwd) * -Math.sign(lim.hingeDir);
  };

  const bestFor = (target) => {
    const oo = { ...o, target };
    const base = solveTwoBone(oo);
    if (!base.ok) return null;
    const aim = norm(sub(target, root));
    const basePole = o.pole ?? base.elbow;
    const at = (th) => (th === 0 || !aim)
      ? base : solveTwoBone({ ...oo, pole: rotateAbout(basePole, aim, th) });
    const penOf = (res) => (res?.ok && guards.length)
      ? penetration(root, res.elbow, res.hand, rU, rL, guards) : 0;
    const aimDir = aim;
    const adducted = o.inward && aimDir ? Math.max(0, dot(aimDir, o.inward)) : 0;
    const judgeSide = !!(lim.hingeDir && o.fwd) && adducted < 0.35;
    // Two different questions, and they want different answers.
    //
    // ACCEPTING a fresh pose is strict: an elbow on the wrong side of the
    // chord is the artefact this rule exists to prevent, and letting it in
    // "just a little" let 72 of them back through.
    //
    // KEEPING the pose we already have is tolerant: an elbow sitting ON the
    // plane makes a strict boolean flip on noise, which throws away something
    // fine and sends the search elsewhere — chatter by another route. A few
    // degrees the wrong side of the plane is not meaningfully inverted, and
    // allowing it only to an incumbent keeps the latch's grip without opening
    // the door.
    const okSide = (res) => !judgeSide || sideOf(res, target) >= 0;
    const okSideHeld = (res) => !judgeSide || sideOf(res, target) >= -0.08;

    // ---- keep the swivel we had, while it still works.
    //
    // The chosen swivel is one of a discrete set, and penetration hovering
    // around zero at one of them makes the winner alternate frame to frame —
    // measured as an 18-64mm elbow jump on four rigs while the body drifted
    // half a millimetre. A latch on the incumbent removes it without adding
    // feedback: the previous angle is simply tried FIRST and kept if it is
    // still clear, so nothing switches until the pose genuinely stops working.
    if (o.lastSwivel != null) {
      const held = at(o.lastSwivel);
      if (held?.ok && penOf(held) <= CLEAR && okSideHeld(held)) {
        return { res: held, pen: 0, swivel: o.lastSwivel };
      }
    }

    let best = null, fallback = { res: base, pen: penOf(base), swivel: 0 };
    if (fallback.pen <= CLEAR && okSide(base)) return fallback;
    for (const th of SWIVELS) {
      if (th === 0) continue;
      const res = at(th);
      if (!res.ok) continue;
      const pen = penOf(res);
      if (pen <= CLEAR && okSide(res)) return { res, pen: 0, swivel: th };
      // keep the least-bad CORRECT-SIDE option ahead of any inverted one
      const cand = { res, pen, swivel: th };
      if (okSide(res) && (!best || pen < best.pen)) best = cand;
      if (pen < fallback.pen) fallback = cand;
    }
    return best ?? fallback;
  };

  if (o.trace) o.trace.push({ t: 1, pen: null, note: 'full attempt below' });
  const full = bestFor(o.target);
  if (!full) return solveTwoBone(o);
  if (o.trace) o.trace[o.trace.length - 1].pen = +(full.pen * 1000).toFixed(1);
  if (full.pen <= CLEAR) {
    return { ...full.res, swivel: full.swivel, penetration: 0, retreat: 1 };
  }

  // ---- it cannot get there. Find the closest place it CAN reach.
  //
  // Not by giving up, and not by driving the arm through the body to a point
  // it was never going to touch. There is a nearest pose the body allows, and
  // that is the one a person adopts.
  //
  // ⚠ It is NOT on the line to the target, which is what the first two
  // versions of this searched. Traced on orion reaching the far hip, every
  // point along that line penetrates — floor ~65mm — because near the shoulder
  // the line means an arm folded against the chest, and far out it means an
  // arm through the torso. The clear poses are OFF the line: lower, or further
  // round. Searching the line could not find them however cleverly it scanned,
  // which is a lesson about search SPACES rather than about search.
  //
  // So: sample directions in a cone about the target and distances along each,
  // score every feasible one by how close its hand actually lands to what was
  // asked for, and take the best. Cheap probe first (one solve, no swivel
  // sweep), full search only on the handful worth it.
  if (!reachDir || fullDist < 1e-6) {
    return { ...full.res, swivel: full.swivel, penetration: full.pen, retreat: 1 };
  }
  const perp = norm(cross(reachDir, Math.abs(reachDir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]))
    ?? norm(cross(reachDir, [0, 0, 1])) ?? [1, 0, 0];
  const perp2 = norm(cross(reachDir, perp)) ?? [0, 1, 0];
  const DEV = [0, 20, 40, 60].map((deg) => deg * Math.PI / 180);
  const AZ = [0, 60, 120, 180, 240, 300].map((deg) => deg * Math.PI / 180);
  const FRAC = [1, 0.85, 0.7, 0.55, 0.4];

  const cheapPen = (target) => {
    const r = solveTwoBone({ ...o, target });
    if (!r.ok) return null;
    return { r, pen: guards.length ? penetration(root, r.elbow, r.hand, rU, rL, guards) : 0 };
  };

  // ---- stickiness, so a near-tie does not chatter.
  //
  // Two candidates can sit within a hair of each other, and then a body
  // breathing by half a millimetre swaps their rank and the elbow jumps —
  // measured at 18-64mm per frame on four rigs while the input moved 0.5mm.
  //
  // This is a DEADBAND LATCH, not feedback. The earlier oscillator was the
  // solve depending on its own output, which can self-excite; this only lets
  // an incumbent keep its place until a rival is better by a clear margin, and
  // noise below that margin cannot move it either way. Switching requires
  // beating the incumbent by STICK, and switching back requires beating the
  // new one by STICK again, so a small perturbation cannot drive a cycle.
  const STICK = 0.03;                       // metres of "clearly better"
  const prev = o.lastPick ?? null;
  const shortlist = [];
  for (const dev of DEV) {
    for (const az of (dev === 0 ? [0] : AZ)) {
      const axis = norm(add(mul(perp, Math.cos(az)), mul(perp2, Math.sin(az))));
      const dir = axis ? norm(rotateAbout(reachDir, axis, dev)) : reachDir;
      if (!dir) continue;
      for (const f of FRAC) {
        const target = add(root, mul(dir, fullDist * f));
        const c = cheapPen(target);
        if (!c) continue;
        // score by where the HAND lands against what was asked for — the whole
        // point is closeness to the target, not closeness to some proxy
        shortlist.push({ target, miss: len(sub(o.target, c.r.hand)), pen: c.pen });
      }
    }
  }
  shortlist.sort((a, b) => (a.pen > 0) - (b.pen > 0) || a.miss - b.miss);

  let best = null;
  for (const cand of shortlist.slice(0, 6)) {
    const r = bestFor(cand.target);
    if (!r || r.pen > CLEAR) continue;
    const miss = len(sub(o.target, r.res.hand));
    if (!best || miss < best.miss) best = { ...r, miss, pick: cand.target };
  }

  // The incumbent gets a FULL evaluation, outside the shortlist. Scoring it
  // with the cheap probe and then letting it fall out of the top six was the
  // whole failure: a pose that was fine, and that the latch existed to keep,
  // never got asked. It keeps its place unless a rival beats it by STICK.
  if (prev) {
    const r = bestFor(prev);
    if (r && r.pen <= CLEAR) {
      const miss = len(sub(o.target, r.res.hand));
      if (!best || miss <= best.miss + STICK) best = { ...r, miss, pick: prev };
    }
  }
  if (!best) {
    return { ...full.res, swivel: full.swivel, penetration: full.pen, retreat: 1 };
  }
  return {
    ...best.res, swivel: best.swivel, penetration: 0,
    gap: best.miss, pick: best.pick,
    bound: [...(best.res.bound ?? []), 'body'],
  };
}

// ---- and which way the palm faces ------------------------------------------
//
// Position IK says where the hand goes and nothing about how it is turned, so
// a hand arrives at a shoulder with the BACK of it against the skin as often
// as not. Touching is done with the palm.
//
// Most of the correction belongs to the forearm: pronation/supination is the
// joint that turns a palm over, and the ragdoll already measured how far it
// goes (TWIST.lowerArm = 80°). Whatever is left goes to the wrist, clamped,
// because a wrist is not a ball joint and a hand bent past its range reads
// worse than a palm that is merely off-angle.

/** Quaternion from an axis and angle. */
export const qAxisAngle = (axis, ang) => {
  const s = Math.sin(ang / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(ang / 2)];
};

/** Shorten a rotation to at most `maxAng`, keeping its axis. */
export function qClampAngle(q, maxAng) {
  const w = clamp(Math.abs(q[3]), -1, 1);
  const ang = 2 * Math.acos(w);
  if (ang <= maxAng || ang < 1e-6) return q;
  const s = Math.sqrt(Math.max(0, 1 - w * w));
  if (s < 1e-8) return [0, 0, 0, 1];
  const sign = q[3] < 0 ? -1 : 1;
  const axis = [sign * q[0] / s, sign * q[1] / s, sign * q[2] / s];
  return qAxisAngle(axis, maxAng);
}

/**
 * Turn the palm toward `want`, by twisting the forearm and then bending the
 * wrist for the remainder.
 *
 * @param {object} o
 * @param {number[]} o.lowerFrame solved orientation of the forearm
 * @param {number[]} o.dLower     forearm direction (unit), same frame
 * @param {number[]} o.palmRest   palm normal at rest, same frame
 * @param {number[]} o.qL0        forearm rest orientation
 * @param {number[]} o.qH0        hand rest orientation
 * @param {number[]} o.want       desired palm direction (unit)
 * @returns {{lowerFrame: number[], handLocal: number[], residualDeg: number}}
 */
export function orientPalm(o) {
  const relH = qMulq(qConj(o.qL0), o.qH0);          // hand, relative to forearm
  const aPalm = qRot(qConj(o.qH0), o.palmRest);      // palm axis in the hand's own frame
  const twistMax = o.twistMax ?? (80 * Math.PI / 180);
  const wristMax = o.wristMax ?? (50 * Math.PI / 180);

  const axis = norm(o.dLower);
  let lowerFrame = o.lowerFrame;
  let H = qMulq(lowerFrame, relH);
  let palm = qRot(H, aPalm);
  if (!axis) return { lowerFrame, handLocal: relH, residualDeg: 0 };

  // ---- pronation: the component of the correction the forearm can make
  const flat = (v) => norm(sub(v, mul(axis, dot(v, axis))));
  const p0 = flat(palm), p1 = flat(o.want);
  if (p0 && p1) {
    const c = clamp(dot(p0, p1), -1, 1);
    const sgn = Math.sign(dot(cross(p0, p1), axis)) || 1;
    const twist = clamp(sgn * Math.acos(c), -twistMax, twistMax);
    lowerFrame = qMulq(qAxisAngle(axis, twist), lowerFrame);
    H = qMulq(lowerFrame, relH);
    palm = qRot(H, aPalm);
  }

  // ---- the wrist takes what is left, within its range
  const delta = qClampAngle(qFromUnitVectors(palm, o.want), wristMax);
  const H2 = qMulq(delta, H);
  const after = qRot(H2, aPalm);
  const residual = Math.acos(clamp(dot(after, o.want), -1, 1));
  return {
    lowerFrame,
    handLocal: qMulq(qConj(lowerFrame), H2),
    residualDeg: residual * 180 / Math.PI,
  };
}
