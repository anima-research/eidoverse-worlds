// joints — what a humanoid joint may do, as measured.
//
// One table, two consumers: the ragdoll (client/lib/ragdoll/ragdoll.js) clamps to it while tumbling, the IK (shared/reach.js)
// while reaching, so an arm can't REACH where it could never FALL. Tuned against the shipped rigs
// (test/client/ragdoll-test.ts). Angles are DEGREES here; consumers convert.

// BEHIND — how far a limb may point behind the body's frontal plane: a one-sided limit the circular CONE can't express
// (a hip swings far forward, barely back, moderately out to the side).
export const BEHIND = [
  ['leftUpperLeg', 'leftLowerLeg', 30],
  ['rightUpperLeg', 'rightLowerLeg', 30],
  ['leftUpperArm', 'leftLowerArm', 65],       // a shoulder does reach back
  ['rightUpperArm', 'rightLowerArm', 65],
];

// CONE — the limb's direction relative to the BODY (not its parent link), so one limit means the same on a T-pose rig and
// an A-pose one. `tilt` leans the cone axis forward (a thigh swings far forward, barely back).
export const CONE = [
  // bone           child            half°  tilt° (toward body forward)   across° (arms only: toward the midline; see ACROSS; reach only)
  ['leftUpperArm',  'leftLowerArm',   85,    0,   135],
  ['rightUpperArm', 'rightLowerArm',  85,    0,   135],
  ['leftUpperLeg',  'leftLowerLeg',   55,   25],
  ['rightUpperLeg', 'rightLowerLeg',  55,   25],
];

// TWIST — a bone's roll about its own length, kept as state (the particle sim gives directions, never roll), measured
// against the PARENT so it doesn't drift as a world reference would. The value is the hard stop in degrees; the pelvis
// isn't here because its "twist" is the body's own roll.
export const TWIST = {
  spine: 25, chest: 25, neck: 45,
  leftUpperArm: 75, rightUpperArm: 75,
  leftLowerArm: 80, rightLowerArm: 80,     // pronation/supination
  leftUpperLeg: 40, rightUpperLeg: 40,
  leftLowerLeg: 25, rightLowerLeg: 25,
};
// Which bone each one twists AGAINST (chains are walked parents-first, so the parent's frame is resolved first).
export const TWIST_PARENT = {
  spine: 'hips', chest: 'spine', neck: 'chest',
  leftUpperArm: 'chest', rightUpperArm: 'chest',
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftUpperLeg: 'hips', rightUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
};

// HINGE — a knee bends backward, an elbow forward, neither sideways. `dir` is which way it folds along the body's forward
// axis (the ragdoll's _frame supplies the handedness). `sideways` is slop, not a range: the smallest values the rigs stay stable at.
export const HINGE = [
  // a               b                 c            dir  maxFlex°  sideways°
  ['leftUpperArm',  'leftLowerArm',  'leftHand',    +1,   145,      12],
  ['rightUpperArm', 'rightLowerArm', 'rightHand',   +1,   145,      12],
  ['leftUpperLeg',  'leftLowerLeg',  'leftFoot',    -1,   150,       6],
  ['rightUpperLeg', 'rightLowerLeg', 'rightFoot',   -1,   150,       6],
];

/** Radians. */
export const D2R = Math.PI / 180;

/**
 * The cone axis for one bone, in BODY-FRAME coordinates: the bone's own rest direction, leaned `tilt` degrees toward
 * forward (centred on where THIS rig's limb rests, so T-pose and A-pose rigs read the same limit).
 *
 * @param {number[]} restDirBody bone->child rest direction, already expressed
 *        in body-frame coordinates [right, up, forward]
 * @param {number} tiltDeg lean toward forward, degrees
 * @returns {number[]} unit axis in body-frame coordinates
 */
export function coneAxisBody(restDirBody, tiltDeg) {
  const a = [...restDirBody];
  if (tiltDeg) {
    // the forward component perpendicular to the axis: a pure rotation in the sagittal plane, not a shortening
    const f = [-a[2] * a[0], -a[2] * a[1], 1 - a[2] * a[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl > 1e-4) {
      const t = Math.tan(tiltDeg * D2R) / fl;
      a[0] += f[0] * t; a[1] += f[1] * t; a[2] += f[2] * t;
    }
  }
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** The limits for one bone, gathered from the tables above into the shape
 *  shared/reach.js wants. Angles come out in RADIANS. */
export function limitsFor(bone) {
  const cone = CONE.find((c) => c[0] === bone);
  const behind = BEHIND.find((b) => b[0] === bone);
  const hinge = HINGE.find((h) => h[0] === bone);
  return {
    ...(cone ? { coneHalf: cone[2] * D2R, coneTilt: cone[3],
                 ...(cone[4] != null ? { coneAcross: cone[4] * D2R } : {}) } : {}),
    ...(behind ? { behind: behind[2] * D2R } : {}),
    ...(hinge ? { maxFlex: hinge[4] * D2R, hingeDir: hinge[3], hingeSide: hinge[5] * D2R } : {}),
    ...(TWIST[bone] != null ? { twistMax: TWIST[bone] * D2R } : {}),
    // the forearm's roll turns the palm, so a chain rooted at the upper arm needs its CHILD's twist limit too
    ...(hinge && TWIST[hinge[1]] != null ? { foreTwistMax: TWIST[hinge[1]] * D2R } : {}),
    ...(TWIST_PARENT[bone] ? { twistParent: TWIST_PARENT[bone] } : {}),
  };
}

/** The two-bone chains a reach can drive, root -> mid -> end. */
export const REACH_CHAINS = {
  leftHand:  { root: 'leftUpperArm',  mid: 'leftLowerArm',  end: 'leftHand' },
  rightHand: { root: 'rightUpperArm', mid: 'rightLowerArm', end: 'rightHand' },
  leftFoot:  { root: 'leftUpperLeg',  mid: 'leftLowerLeg',  end: 'leftFoot' },
  rightFoot: { root: 'rightUpperLeg', mid: 'rightLowerLeg', end: 'rightFoot' },
};

/**
 * The body's own axes from rest bone positions: right (the pelvis bar), up (hips to head), forward (their cross), right
 * re-orthogonalized. The same construction as the ragdoll's `_frame`, minus its degenerate-fold handling (a rest pose is never degenerate).
 *
 * @param {Record<string, number[]>} P bone -> [x,y,z]
 * @returns {{r: number[], u: number[], f: number[]}|null}
 */
export function bodyFrame(P) {
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [
    a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-5 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

  let r = (P.leftUpperLeg && P.rightUpperLeg) ? norm(sub(P.leftUpperLeg, P.rightUpperLeg))
        : (P.leftUpperArm && P.rightUpperArm) ? norm(sub(P.leftUpperArm, P.rightUpperArm)) : null;
  let u = (P.head && P.hips) ? norm(sub(P.head, P.hips))
        : (P.chest && P.hips) ? norm(sub(P.chest, P.hips)) : null;
  r ??= [1, 0, 0];
  u ??= [0, 1, 0];
  const f = norm(cross(r, u));
  if (!f) return null;
  const r2 = norm(cross(u, f)) ?? r;
  return { r: r2, u, f };
}

/** A world-space direction, expressed in body-frame coordinates. */
export const toBody = (v, F) => [
  v[0] * F.r[0] + v[1] * F.r[1] + v[2] * F.r[2],
  v[0] * F.u[0] + v[1] * F.u[1] + v[2] * F.u[2],
  v[0] * F.f[0] + v[1] * F.f[1] + v[2] * F.f[2],
];

/** ...and back out again. */
export const fromBody = (b, F) => [
  b[0] * F.r[0] + b[1] * F.u[0] + b[2] * F.f[0],
  b[0] * F.r[1] + b[1] * F.u[1] + b[2] * F.f[1],
  b[0] * F.r[2] + b[1] * F.u[2] + b[2] * F.f[2],
];

// Self-collision radii as fractions of the torso radius (torsoRadius, measured from the body, so this scales to any avatar).
export const RADIUS_FRAC = {
  hips: 1.0, spine: 0.95, chest: 1.0, neck: 0.5, head: 0.75,
  leftUpperArm: 0.5, rightUpperArm: 0.5, leftLowerArm: 0.35, rightLowerArm: 0.35,
  leftHand: 0.3, rightHand: 0.3,
  leftUpperLeg: 0.55, rightUpperLeg: 0.55, leftLowerLeg: 0.4, rightLowerLeg: 0.4,
  leftFoot: 0.35, rightFoot: 0.35,
};


/**
 * A body's torso half-thickness, measured (the same derivation the ragdoll uses): 0.42 × the wider of the shoulder or
 * hip span, or a fraction of the spine if the limbs are missing; clamped to 5..25 cm.
 *
 * @param {Record<string, number[]>} P rest bone positions
 */
export function torsoRadius(P) {
  const d = (a, b) => (P[a] && P[b]
    ? Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]) : 0);
  const shoulderW = d('leftUpperArm', 'rightUpperArm');
  const hipW = d('leftUpperLeg', 'rightUpperLeg');
  const spineLen = d('hips', 'head') || 0.5;
  return Math.min(0.25, Math.max(0.05, (Math.max(shoulderW, hipW) * 0.42) || spineLen * 0.26));
}

/** Capsule radius for one bone on a body of the given torso radius. */
export const boneRadius = (bone, torsoR) => torsoR * (RADIUS_FRAC[bone] ?? 0.4);

/** The segments a reaching arm must not pass through: torso column, head, thighs, and the OTHER arm (the caller drops
 *  the chain's own bones). */
export const GUARD_SEGMENTS = [
  ['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'],
  ['hips', 'leftUpperLeg'], ['hips', 'rightUpperLeg'],
  ['leftUpperLeg', 'leftLowerLeg'], ['rightUpperLeg', 'rightLowerLeg'],
  ['leftUpperArm', 'leftLowerArm'], ['rightUpperArm', 'rightLowerArm'],
  ['leftLowerArm', 'leftHand'], ['rightLowerArm', 'rightHand'],
];

// ACROSS — how far an arm may swing TOWARD the body's midline (CONE's fifth number): the 85° cone that stops a shoulder
// folding back would also forbid crossing the chest. Read by the reach only, and only safe with its torso projection
// (shared/reach.js); the ragdoll keeps the plain cone.
